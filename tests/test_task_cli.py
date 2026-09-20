"""Task-first CLI routing with service doubles; no model or tool execution."""

import json

import pytest

from nexgent import cli


class FakeTaskService:
    def __init__(self, root):
        self.root = root
        self.calls = []

    def create(self, objective, **kwargs):
        self.calls.append(("create", objective, kwargs))
        return {"id": "episode-1", "status": "ready", "usage": {}}

    def run(self, episode_id, **kwargs):
        self.calls.append(("run", episode_id, kwargs))
        return {"id": episode_id, "status": "completed", "output_refs": {"result": "artifact-1"},
                "outcome": {"delivery_status": "delivered"}, "usage": {"model_calls": 0},
                "last_error": None}

    def get(self, episode_id):
        self.calls.append(("get", episode_id))
        return {"id": episode_id, "status": "paused", "task": {"objective": "saved task"}}

    def list(self):
        self.calls.append(("list",))
        return [{"id": "episode-1", "status": "completed", "task": {"objective": "first"},
                 "outcome": {"acceptance_status": "not_evaluated"}}]

    def export(self, episode_id, destination=None):
        self.calls.append(("export", episode_id, destination))
        return str(destination or (self.root / "export.json"))

    def benchmark(self, benchmark_id, **kwargs):
        self.calls.append(("benchmark", benchmark_id, kwargs))
        return {"benchmark": {"id": benchmark_id}, "reports": [
            {"episode_id": "episode-bench", "evaluation": {"accepted": True, "score": 1.0}}]}


@pytest.fixture
def task_service(monkeypatch, tmp_path):
    fake = FakeTaskService(tmp_path)
    monkeypatch.setattr("nexgent.tasks.runtime.TaskService", lambda root: fake)
    return fake


def test_task_loads_json_files_and_forwards_explicit_runtime_options(task_service, tmp_path, capsys):
    inputs = tmp_path / "inputs.json"
    package = tmp_path / "package.json"
    inputs.write_text(json.dumps({"source": {"rows": [1, 2]}}), encoding="utf-8")
    package.write_text(json.dumps({"manifest": {"entries": {}}, "files": {}, "digest": "test"}), encoding="utf-8")

    code = cli.main(["--root", str(tmp_path), "task", "reconcile records",
                     "--input", str(inputs), "--package", str(package),
                     "--deliverables", '[{"name":"ledger","schema":{"type":"object"}}]',
                     "--constraints", '{"allowed_effects":["read"]}',
                     "--capability", "workbench.inspect_sources",
                     "--capability", "workbench.validate_delivery",
                     "--max-calls", "3", "--max-completion-tokens", "900",
                     "--max-tool-calls", "4", "--max-nodes", "12"])

    assert code == 0
    create = task_service.calls[0]
    assert create[0:2] == ("create", "reconcile records")
    assert create[2]["inputs"] == {"source": {"rows": [1, 2]}}
    assert create[2]["capabilities"] == ["workbench.inspect_sources", "workbench.validate_delivery"]
    assert create[2]["deliverables"] == [{"name": "ledger", "schema": {"type": "object"}}]
    assert create[2]["constraints"] == {"allowed_effects": ["read"]}
    assert create[2]["budget"] == {"max_model_calls": 3, "max_completion_tokens": 900,
                                    "max_tool_calls": 4, "max_nodes": 12}
    assert create[2]["package"]["digest"] == "test"
    assert task_service.calls[1][0:2] == ("run", "episode-1")
    assert json.loads(capsys.readouterr().out)["status"] == "completed"


def test_task_register_only_accepts_inline_json_without_running(task_service, tmp_path, capsys):
    code = cli.main(["--root", str(tmp_path), "task", "store this", "--input", '{"value": 7}',
                     "--register-only"])
    assert code == 0
    assert [call[0] for call in task_service.calls] == ["create"]
    assert task_service.calls[0][2]["inputs"] == {"value": 7}
    assert json.loads(capsys.readouterr().out)["status"] == "ready"


@pytest.mark.parametrize("command, extra, expected", [
    ("task-resume", ["episode-2"], "run"),
    ("task-show", ["episode-2"], "get"),
    ("task-list", [], "list"),
    ("task-export", ["episode-2"], "export"),
])
def test_persisted_task_commands_route_to_task_service(task_service, tmp_path, capsys,
                                                        command, extra, expected):
    code = cli.main(["--root", str(tmp_path), command, *extra])
    assert code == (1 if command == "task-show" and False else 0)
    assert task_service.calls[0][0] == expected
    assert capsys.readouterr().out.strip()


def test_task_benchmark_forwards_split_seed_budget_and_recovery_option(task_service, tmp_path, capsys):
    code = cli.main(["--root", str(tmp_path), "task-benchmark", "workbench",
                     "--split", "selection", "--seed", "19", "--max-calls", "6",
                     "--max-tool-calls", "8", "--controlled-failure"])
    assert code == 0
    call = task_service.calls[0]
    assert call[0:2] == ("benchmark", "workbench")
    assert call[2]["split"] == "selection" and call[2]["seed"] == 19
    assert call[2]["budget"] == {"max_model_calls": 6, "max_tool_calls": 8}
    assert call[2]["controlled_failure"] is True
    assert call[2]["package_channel"] is None
    assert json.loads(capsys.readouterr().out)["reports"][0]["evaluation"]["accepted"] is True


@pytest.mark.parametrize("command", ["task", "task-benchmark"])
def test_task_execution_can_resolve_an_explicit_package_channel(task_service, tmp_path, capsys,
                                                                 command):
    arguments = ([command, "use the promoted package"] if command == "task" else
                 [command, "workbench"])
    code = cli.main(["--root", str(tmp_path), *arguments, "--package-channel", "stable"])
    assert code == 0
    call = task_service.calls[0]
    assert call[-1]["package_channel"] == "stable"
    assert call[-1]["package"] is None
    capsys.readouterr()


@pytest.mark.parametrize("command", ["task", "task-benchmark"])
def test_explicit_package_and_channel_fail_closed_before_service_call(task_service, tmp_path, command):
    package = tmp_path / "package.json"
    package.write_text("{}", encoding="utf-8")
    arguments = ([command, "ambiguous package"] if command == "task" else
                 [command, "workbench"])
    with pytest.raises(SystemExit):
        cli.main(["--root", str(tmp_path), *arguments,
                  "--package", str(package), "--package-channel", "stable"])
    assert task_service.calls == []


def test_rsi_status_and_events_expose_public_control_plane_projection(monkeypatch, task_service,
                                                                      tmp_path, capsys):
    class FakeEvolution:
        def __init__(self, service):
            assert service is task_service

        def active(self, channel):
            return {"channel": channel, "package_id": "package-active", "package_digest": "d1",
                    "revision": 3, "promotion": {"decision_id": "decision-1"},
                    "updated_at": 1.0, "package": {"files": {"secret.py": "hidden"}}}

        def events(self, channel):
            return [{"channel": channel, "sequence": 1, "kind": "paired_trial_recorded",
                     "created": 1.0, "content": {"trial_id": "trial-1",
                                                  "candidate_id": "candidate-1",
                                                  "hidden_evaluator": "private rubric"},
                     "previous": "genesis", "digest": "event-digest"}]

    monkeypatch.setattr("nexgent.tasks.evolution.EvolutionService", FakeEvolution)
    assert cli.main(["--root", str(tmp_path), "rsi-status", "stable"]) == 0
    status = json.loads(capsys.readouterr().out)
    assert status["revision"] == 3 and "package" not in status
    assert cli.main(["--root", str(tmp_path), "rsi-events", "stable", "--limit", "10"]) == 0
    events = json.loads(capsys.readouterr().out)["events"]
    assert events[0]["content"]["trial_id"] == "trial-1"
    assert "hidden_evaluator" not in events[0]["content"]


def test_rsi_mutation_commands_form_scriptable_control_plane(monkeypatch, task_service,
                                                              tmp_path, capsys):
    calls = []
    adapter = object()

    class FakeEvolution:
        def __init__(self, service):
            assert service is task_service

        @staticmethod
        def _active(channel="stable", revision=1):
            return {"channel": channel, "package_id": "package-active",
                    "package_digest": "digest-active", "revision": revision,
                    "promotion": None, "updated_at": 1.0,
                    "package": {"files": {"private.py": "source"}}}

        def register(self, channel, package):
            calls.append(("register", channel, package))
            return self._active(channel, 0)

        def plan_pair(self, candidate_id, benchmark, **kwargs):
            calls.append(("plan_pair", candidate_id, benchmark, kwargs))
            return {"id": "plan-1", "candidate_id": candidate_id,
                    "suite": {"hidden_evaluator": "do not print"}}

        def run_pair(self, plan_id, benchmark, **kwargs):
            calls.append(("run_pair", plan_id, benchmark, kwargs))
            return {"id": "trial-1", "plan_id": plan_id}

        def assess(self, trial_id):
            calls.append(("assess", trial_id))
            return {"id": "decision-1", "trial_id": trial_id, "eligible": True}

        def plan_monitor(self, candidate_id, benchmark, **kwargs):
            calls.append(("plan_monitor", candidate_id, benchmark, kwargs))
            return {"id": "monitor-plan-1", "candidate_id": candidate_id}

        def promote(self, candidate_id, decision_id, **kwargs):
            calls.append(("promote", candidate_id, decision_id, kwargs))
            return self._active(revision=2)

        def run_monitor(self, channel, benchmark, **kwargs):
            calls.append(("run_monitor", channel, benchmark, kwargs))
            return {"monitor_plan_id": "monitor-plan-1", "episode_ids": ["episode-guard"],
                    "reports": [{"hidden_evaluator": "do not print"}]}

        def monitor(self, channel, episode_ids, **kwargs):
            calls.append(("monitor", channel, episode_ids, kwargs))
            return {"degraded": False, "rolled_back": False,
                    "active": self._active(channel, 2), "metrics": {"score": 1.0}}

        def rollback(self, channel, **kwargs):
            calls.append(("rollback", channel, kwargs))
            return self._active(channel, 3)

    class FakeGeneration:
        def __init__(self, service, evolution):
            assert service is task_service and isinstance(evolution, FakeEvolution)

        def capture_feedback(self, channel, episode_ids, expected_revision):
            calls.append(("feedback", channel, episode_ids, expected_revision))
            return {"id": "feedback-1", "channel": channel}

        def generate(self, channel, feedback_id, improver, mutation, expected_revision, **kwargs):
            calls.append(("generate", channel, feedback_id, improver, mutation,
                          expected_revision, kwargs))
            return {"id": "generation-1", "candidate_id": "candidate-1",
                    "status": "generated"}

    monkeypatch.setattr("nexgent.tasks.evolution.EvolutionService", FakeEvolution)
    monkeypatch.setattr("nexgent.tasks.generation.GenerationService", FakeGeneration)
    monkeypatch.setattr("nexgent.tasks.tools.task_benchmarks", lambda: {"generic": adapter})

    package_file = tmp_path / "package.json"
    package_file.write_text(json.dumps({"id": "package-0"}), encoding="utf-8")
    commands = [
        ["rsi-register", "stable", "--package", str(package_file)],
        ["rsi-feedback", "stable", "episode-a", "episode-b", "--expected-revision", "0"],
        ["rsi-generate", "stable", "feedback-1", "--improver-package", '{"id":"improver"}',
         "--mutation-policy", '{"mutable_paths":["main.py"]}', "--expected-revision", "0",
         "--max-calls", "2", "--max-nodes", "8"],
        ["rsi-plan", "candidate-1", "generic", "--split", "selection-a", "--seed", "17",
         "--policy", '{"min_quality_delta":0.2,"max_cost_ratio":2.0}', "--max-calls", "4"],
        ["rsi-run-plan", "plan-1", "generic"],
        ["rsi-assess", "trial-1"],
        ["rsi-plan-monitor", "candidate-1", "generic", "--split", "guard-a", "--seed", "23",
         "--max-tool-calls", "9"],
        ["rsi-promote", "candidate-1", "decision-1", "monitor-plan-1"],
        ["rsi-run-monitor", "stable", "generic"],
        ["rsi-monitor", "stable", "episode-guard", "--no-rollback"],
        ["rsi-rollback", "stable", "manual regression review"],
    ]
    outputs = []
    for arguments in commands:
        assert cli.main(["--root", str(tmp_path), *arguments]) == 0
        outputs.append(json.loads(capsys.readouterr().out))

    assert calls[0] == ("register", "stable", {"id": "package-0"})
    assert calls[1] == ("feedback", "stable", ["episode-a", "episode-b"], 0)
    assert calls[2][0:6] == ("generate", "stable", "feedback-1", {"id": "improver"},
                              {"mutable_paths": ["main.py"]}, 0)
    assert calls[2][6]["budget"] == {"max_model_calls": 2, "max_nodes": 8}
    assert calls[3][0:3] == ("plan_pair", "candidate-1", adapter)
    assert calls[3][3]["split"] == "selection-a"
    assert calls[3][3]["split_role"] == "selection"
    assert calls[3][3]["seed"] == 17
    assert calls[3][3]["budget"] == {"max_model_calls": 4}
    assert calls[3][3]["policy"].min_quality_delta == 0.2
    assert calls[3][3]["policy"].max_cost_ratio == 2.0
    assert calls[4][0:3] == ("run_pair", "plan-1", adapter)
    assert calls[5] == ("assess", "trial-1")
    assert calls[6][0:3] == ("plan_monitor", "candidate-1", adapter)
    assert calls[6][3]["split"] == "guard-a" and calls[6][3]["seed"] == 23
    assert calls[6][3]["budget"] == {"max_tool_calls": 9}
    assert calls[7] == ("promote", "candidate-1", "decision-1",
                        {"monitor_plan_id": "monitor-plan-1"})
    assert calls[8][0:3] == ("run_monitor", "stable", adapter)
    assert calls[9] == ("monitor", "stable", ["episode-guard"],
                        {"rollback_on_regression": False})
    assert calls[10] == ("rollback", "stable", {"reason": "manual regression review"})
    assert "package" not in outputs[0] and "package" not in outputs[7]
    assert "package" not in outputs[9]["active"] and "package" not in outputs[10]
    assert "suite" not in outputs[3] and "reports" not in outputs[8]


def test_rsi_command_errors_use_parser_failure(monkeypatch, task_service, tmp_path):
    monkeypatch.setattr("nexgent.tasks.tools.task_benchmarks", lambda: {})

    class FakeEvolution:
        def __init__(self, service):
            assert service is task_service

        def plan_pair(self, *args, **kwargs):
            raise AssertionError("missing benchmark should fail before service dispatch")

    monkeypatch.setattr("nexgent.tasks.evolution.EvolutionService", FakeEvolution)
    with pytest.raises(SystemExit):
        cli.main(["--root", str(tmp_path), "rsi-plan", "candidate-1", "missing"])
    with pytest.raises(SystemExit):
        cli.main(["--root", str(tmp_path), "rsi-register", "stable",
                  "--package", "[]"])


def test_gui_defaults_to_task_workspace_and_forwards_legacy_switch(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr("nexgent.ui.app.main", lambda argv: calls.append(argv) or 0)
    assert cli.main(["--root", str(tmp_path), "gui"]) == 0
    assert calls[-1] == ["--project", str(tmp_path)]
    assert cli.main(["--root", str(tmp_path), "gui", "--legacy-research"]) == 0
    assert calls[-1] == ["--project", str(tmp_path), "--legacy-research"]
