import json

from nexgent.runtime.coding_task import run_coding_task
from nexgent.runtime.store import SQLiteRunStore


def _write_fixture(project):
    (project / "test_app.py").write_text(
        "import unittest\n"
        "import app\n\n"
        "class Tests(unittest.TestCase):\n"
        "    def test_value(self):\n"
        "        self.assertEqual(app.value(), 2)\n",
        encoding="utf-8",
    )


def test_real_coding_task_repairs_until_independent_command_accepts(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    _write_fixture(project)
    prompts = []

    def agent(prompt):
        prompts.append(prompt)
        value = 1 if len(prompts) == 1 else 2
        (project / "app.py").write_text(
            f"def value():\n    return {value}\n", encoding="utf-8"
        )
        return "implemented"

    store = SQLiteRunStore(tmp_path / "runs")
    summary = run_coding_task(
        store,
        project,
        "make the acceptance test pass",
        "python -m unittest discover -s . -q",
        agent,
        max_attempts=2,
        check_timeout=5,
    )

    assert summary.status.value == "succeeded"
    assert summary.attempts == 2
    assert summary.recoveries == 1
    assert summary.changed_files == ("app.py",)
    assert "Independent acceptance failed" in prompts[1]
    export = store.export_run(summary.run_id)
    assert [
        event["payload"]["status"]
        for event in export["events"]
        if event["payload"].get("stage") == "acceptance-command"
    ] == ["failed", "passed"]
    assert export["diagnoses"][0]["method"] == "coding-task-dependency-graph"
    assert store.list_recovery_strategies()[0].success_count == 1


def test_coding_task_pauses_instead_of_claiming_success_when_budget_expires(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    _write_fixture(project)

    def agent(_prompt):
        (project / "app.py").write_text(
            "def value():\n    return 0\n", encoding="utf-8"
        )
        return "incorrect"

    store = SQLiteRunStore(tmp_path / "runs")
    summary = run_coding_task(
        store,
        project,
        "make the acceptance test pass",
        "python -m unittest discover -s . -q",
        agent,
        max_attempts=1,
        check_timeout=5,
    )

    assert summary.status.value == "paused"
    assert summary.verification_id is not None
    assert store.list_recovery_strategies() == []
    assert json.loads(json.dumps(summary.to_dict()))["status"] == "paused"


def test_paused_coding_task_resumes_same_run_and_evidence_chain(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    _write_fixture(project)
    store = SQLiteRunStore(tmp_path / "runs")

    def failing_agent(_prompt):
        (project / "app.py").write_text(
            "def value():\n    return 0\n", encoding="utf-8"
        )
        return "not fixed"

    first = run_coding_task(
        store,
        project,
        "make the acceptance test pass",
        "python -m unittest discover -s . -q",
        failing_agent,
        max_attempts=1,
        check_timeout=5,
    )
    assert first.status.value == "paused"

    prompts = []

    def repairing_agent(prompt):
        prompts.append(prompt)
        (project / "app.py").write_text(
            "def value():\n    return 2\n", encoding="utf-8"
        )
        return "fixed"

    resumed = run_coding_task(
        store,
        project,
        "make the acceptance test pass",
        "python -m unittest discover -s . -q",
        repairing_agent,
        max_attempts=1,
        check_timeout=5,
        resume_run_id=first.run_id,
    )

    assert resumed.run_id == first.run_id
    assert resumed.status.value == "succeeded"
    assert resumed.attempts == 2
    assert "Resume the interrupted Harness task" in prompts[0]
    export = store.export_run(first.run_id)
    assert [attempt["trigger"] for attempt in export["attempts"]] == [
        "initial",
        "resume",
    ]
    assert len(export["goals"]) == 1


def test_reused_strategy_is_downranked_after_real_harness_failure(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    _write_fixture(project)
    store = SQLiteRunStore(tmp_path / "runs")
    calls = 0

    def successful_agent(_prompt):
        nonlocal calls
        calls += 1
        value = 1 if calls == 1 else 2
        (project / "app.py").write_text(
            f"def value():\n    return {value}\n", encoding="utf-8"
        )
        return "attempted"

    promoted = run_coding_task(
        store,
        project,
        "make the acceptance test pass",
        "python -m unittest discover -s . -q",
        successful_agent,
        max_attempts=2,
        check_timeout=5,
    )
    assert promoted.status.value == "succeeded"
    strategy = store.list_recovery_strategies()[0]

    failing_calls = 0

    def failing_agent(_prompt):
        nonlocal failing_calls
        failing_calls += 1
        (project / "app.py").write_text(
            "def value():\n    return 1\n", encoding="utf-8"
        )
        if failing_calls > 1:
            # Force the later proposal onto a different feature signature.  A
            # Run-level reuse result must remain true and retain the strategy
            # selected on the first recovery.
            (project / "diagnostic.yaml").write_text(
                "second_failure: true\n", encoding="utf-8"
            )
        return "still wrong"

    failed = run_coding_task(
        store,
        project,
        "make the acceptance test pass",
        "python -m unittest discover -s . -q",
        failing_agent,
        max_attempts=2,
        check_timeout=5,
    )

    assert failed.status.value == "paused"
    assert failed.strategy_reused is True
    updated = next(
        item for item in store.list_recovery_strategies()
        if item.strategy_id == strategy.strategy_id
    )
    assert updated.failure_count == 1
    assert updated.last_failure_run_id == failed.run_id
