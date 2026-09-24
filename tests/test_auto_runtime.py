"""The ordinary entrypoint uses one project policy for autonomous RSI."""

import json

import pytest

from nexgent.tasks.auto_runtime import (
    CONFIG_FILE, CONFIG_SCHEMA, advance_auto_evolution,
    configure_auto_evolution, load_auto_evolution_config,
)
from nexgent.tasks.improvers import active_improver_registration
from nexgent.tasks.evolution import EvolutionService
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.self_orchestration_seed import self_orchestration_package
from nexgent.tasks.tools import ContractError


def _write_config(root, *, evaluator="workbench", channel="test-tasks"):
    value = {
        "schema": CONFIG_SCHEMA,
        "improver_channel": "test-improver",
        "bootstrap_default_improver": True,
        "channels": {channel: {
            "evaluator_id": evaluator,
            "candidate_types": ["orchestration", "tool", "service_provider", "no_change"],
            "budget": {"max_model_calls": 3, "max_completion_tokens": 3000,
                       "max_nodes": 8},
            "promotion_policy": {"min_quality_delta": 0},
        }},
    }
    (root / CONFIG_FILE).write_text(json.dumps(value), encoding="utf-8")


def test_unconfigured_project_has_no_automatic_model_work(tmp_path):
    tasks = TaskService(tmp_path)
    assert load_auto_evolution_config(tmp_path) is None
    assert configure_auto_evolution(tasks) is None
    assert advance_auto_evolution(None) == {
        "configured": False, "rounds": 0, "work": []}


def test_auto_advance_command_needs_no_work_ids(tmp_path, capsys):
    from nexgent import cli

    assert cli.main(["--root", str(tmp_path), "rsi-auto-advance"]) == 0
    assert json.loads(capsys.readouterr().out) == {
        "configured": False, "rounds": 0, "work": []}


def test_project_bootstraps_one_improver_and_attaches_trigger(tmp_path):
    _write_config(tmp_path)
    tasks = TaskService(tmp_path)
    trigger = configure_auto_evolution(tasks)
    identity = active_improver_registration(tasks.store, "test-improver")
    assert trigger.policies["test-tasks"]["improver"] == {
        key: identity[key] for key in (
            "channel", "revision", "package_id", "package_digest")}
    assert tasks._feedback_trigger is trigger

    restarted = TaskService(tmp_path)
    again = configure_auto_evolution(restarted)
    assert again.policies["test-tasks"]["improver"] == trigger.policies[
        "test-tasks"]["improver"]


def test_bad_or_stale_project_policy_fails_before_running_task(tmp_path):
    _write_config(tmp_path)
    path = tmp_path / CONFIG_FILE
    value = json.loads(path.read_text(encoding="utf-8"))
    value["channels"]["test-tasks"]["improver"] = {
        "channel": "test-improver", "revision": 99}
    path.write_text(json.dumps(value), encoding="utf-8")
    with pytest.raises(ContractError, match="revision mismatch"):
        configure_auto_evolution(TaskService(tmp_path))


def test_config_rejects_unknown_fields_and_mismatched_improver(tmp_path):
    _write_config(tmp_path)
    path = tmp_path / CONFIG_FILE
    value = json.loads(path.read_text(encoding="utf-8"))
    value["secret"] = "not a policy field"
    path.write_text(json.dumps(value), encoding="utf-8")
    with pytest.raises(ContractError, match="invalid schema"):
        load_auto_evolution_config(tmp_path)


def test_ordinary_cli_registers_on_configured_channel_without_manual_rsi_ids(
        tmp_path, capsys):
    from nexgent import cli

    _write_config(tmp_path)
    assert cli.main(["--root", str(tmp_path), "task", "Build a useful result",
                     "--register-only"]) == 0
    capsys.readouterr()
    [episode] = TaskService(tmp_path).list()
    assert episode["task"]["context"]["split_role"] == "development"
    assert episode["task"]["context"]["split"] == "development"
    assert episode["task"]["context"]["package_channel_registration"]["channel"] == (
        "test-tasks")
    assert episode["status"] == "ready"


def test_main_uses_the_same_configured_channel(qtbot, tmp_path):
    from nexgent.ui.main_window import MainWindow

    _write_config(tmp_path)
    window = MainWindow(tmp_path)
    qtbot.addWidget(window)
    assert window._auto_evolution is not None
    assert window._package_selection() == {"package_channel": "test-tasks"}


def test_startup_rejects_unavailable_evaluator_and_cross_project_policy(tmp_path):
    _write_config(tmp_path, evaluator="not-installed")
    with pytest.raises(ContractError, match="not installed"):
        configure_auto_evolution(TaskService(tmp_path))
    other = tmp_path / "other"
    other.mkdir()
    with pytest.raises(ContractError, match="must belong"):
        configure_auto_evolution(TaskService(other), project_root=tmp_path)


def test_multi_channel_without_default_needs_explicit_cli_routing(tmp_path):
    from nexgent import cli

    _write_config(tmp_path)
    path = tmp_path / CONFIG_FILE
    config = json.loads(path.read_text(encoding="utf-8"))
    config["channels"]["another-task-kind"] = dict(config["channels"]["test-tasks"])
    path.write_text(json.dumps(config), encoding="utf-8")
    with pytest.raises(SystemExit):
        cli.main(["--root", str(tmp_path), "task", "Do a task", "--register-only"])
    assert TaskService(tmp_path).list() == []
    with pytest.raises(SystemExit):
        cli.main(["--root", str(tmp_path), "task", "Do a task",
                  "--package-channel", "unconfigured", "--register-only"])
    assert TaskService(tmp_path).list() == []


def test_restart_scan_discovers_terminal_episode_when_hook_did_not_run(tmp_path):
    _write_config(tmp_path)
    first = TaskService(tmp_path)
    EvolutionService(first).register("test-tasks", self_orchestration_package())
    episode = first.create(
        "A task whose terminal hook was not yet installed",
        package_channel="test-tasks",
        context={"split": "development", "split_role": "development"},
        budget={"max_model_calls": 0})
    final = first.run(episode["id"])
    assert final["status"] == "failed"
    assert first.store.feedback_triggers(limit=10) == []

    restarted = TaskService(tmp_path)
    trigger = configure_auto_evolution(restarted)
    trigger.advance = lambda *, limit, stop_event=None: {
        "feedback": [], "development": [], "evolution": []}
    result = advance_auto_evolution(trigger, rounds=1)
    assert any(row["status"] == "observed" for row in result["work"])


def test_main_startup_recovers_a_missed_terminal_hook(qtbot, tmp_path):
    from nexgent.ui.main_window import MainWindow

    _write_config(tmp_path)
    first = TaskService(tmp_path)
    EvolutionService(first).register("test-tasks", self_orchestration_package())
    episode = first.create(
        "A missed terminal hook", package_channel="test-tasks",
        context={"split": "development", "split_role": "development"},
        budget={"max_model_calls": 0})
    assert first.run(episode["id"])["status"] == "failed"

    window = MainWindow(tmp_path)
    qtbot.addWidget(window)
    qtbot.waitUntil(
        lambda: any(row["source_episode_id"] == episode["id"]
                    for row in window.service.store.feedback_triggers(limit=10)),
        timeout=5000)
    window.close()


def test_restart_scan_reaches_beyond_four_pages():
    rows = [
        {"id": f"work-{index:04d}", "source_episode_id": f"episode-{index:04d}",
         "channel_id": None, "status": "deferred", "reason": "unconfigured"}
        for index in range(1025)
    ]
    by_id = {row["id"]: row for row in rows}
    scans = []

    class Store:
        def feedback_triggers(self, *, statuses=None, limit=4):
            return []

        def feedback_trigger(self, identity):
            return by_id[identity]

    class Trigger:
        store = Store()

        def scan(self, *, after_id=None, limit=256, drain=False):
            start = int(after_id.removeprefix("episode-")) + 1 if after_id else 0
            page = rows[start:start + limit]
            scans.append(start)
            return {"observed": page,
                    "next_cursor": (page[-1]["source_episode_id"]
                                    if len(page) == limit else None)}

    result = advance_auto_evolution(Trigger(), rounds=1)
    assert scans == [0, 256, 512, 768, 1024]
    assert len(result["work"]) == 1025
    assert result["global_pending"] is False
