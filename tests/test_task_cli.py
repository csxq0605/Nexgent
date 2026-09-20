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
    assert json.loads(capsys.readouterr().out)["reports"][0]["evaluation"]["accepted"] is True


def test_gui_defaults_to_task_workspace_and_forwards_legacy_switch(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr("nexgent.ui.app.main", lambda argv: calls.append(argv) or 0)
    assert cli.main(["--root", str(tmp_path), "gui"]) == 0
    assert calls[-1] == ["--project", str(tmp_path)]
    assert cli.main(["--root", str(tmp_path), "gui", "--legacy-research"]) == 0
    assert calls[-1] == ["--project", str(tmp_path), "--legacy-research"]
