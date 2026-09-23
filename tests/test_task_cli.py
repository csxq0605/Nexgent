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


class FakeBenchmarkAdapter:
    id = "generic"

    def describe(self):
        return {"id": self.id, "title": "Generic test benchmark",
                "splits": ["development"]}

    def snapshot(self):
        return {"id": self.id, "version": 1}

    def tasks(self, split="development", seed=0):
        return [{"id": f"generic/{split}/{seed}", "objective": "test"}]

    def evaluate(self, task_ref, deliverables, execution_view):
        return {"status": "accepted", "score_available": True,
                "score": 1.0, "accepted": True}


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
                     "--capability-authority", '{"version":2}',
                     "--max-calls", "3", "--max-completion-tokens", "900",
                     "--max-tool-calls", "4", "--max-tool-work-units", "55",
                     "--max-nodes", "12"])

    assert code == 0
    create = task_service.calls[0]
    assert create[0:2] == ("create", "reconcile records")
    assert create[2]["inputs"] == {"source": {"rows": [1, 2]}}
    assert create[2]["capabilities"] == ["workbench.inspect_sources", "workbench.validate_delivery"]
    assert create[2]["capability_authority"] == {"version": 2}
    assert create[2]["deliverables"] == [{"name": "ledger", "schema": {"type": "object"}}]
    assert create[2]["constraints"] == {"allowed_effects": ["read"]}
    assert create[2]["budget"] == {"max_model_calls": 3, "max_completion_tokens": 900,
                                    "max_tool_calls": 4, "max_tool_work_units": 55,
                                    "max_nodes": 12}
    assert create[2]["package"]["digest"] == "test"
    assert task_service.calls[1][0:2] == ("run", "episode-1")
    assert json.loads(capsys.readouterr().out)["status"] == "completed"


def test_rsi_study_plan_forwards_role_and_projects_authority_fields(
        monkeypatch, task_service, tmp_path, capsys):
    calls = []

    class FakeStudies:
        def __init__(self, service, adapter):
            assert service is task_service
            assert adapter == "adapter"

        def create_plan(self, **kwargs):
            calls.append(kwargs)
            return {
                "schema": "nexgent.rsi-study-plan.v1",
                "id": "plan-1",
                "benchmark_id": "generic",
                "suite_role": "primary",
                "benchmark_descriptor_digest": "descriptor-digest",
                "adapter_fingerprint": "adapter-fingerprint",
                "execution_environment_digest": "environment-digest",
                "protocol_digest": "protocol-digest",
                "record_digest": "record-digest",
            }

    monkeypatch.setattr("nexgent.tasks.studies.RSIStudyService", FakeStudies)
    monkeypatch.setattr(cli, "_task_benchmark", lambda *_: "adapter")
    code = cli.main([
        "--root", str(tmp_path), "rsi-study-plan", "generic",
        "--baseline-package", '{"id":"baseline"}',
        "--candidate-package", '{"id":"candidate"}',
        "--seeds", "1", "2", "--provider", "none", "--model", "none",
        "--role", "primary", "--no-require-model-calls",
    ])

    assert code == 0
    assert calls[0]["role"] == "primary"
    output = json.loads(capsys.readouterr().out)
    assert output["suite_role"] == "primary"
    assert output["benchmark_descriptor_digest"] == "descriptor-digest"


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
                     "--max-tool-calls", "8", "--max-tool-work-units", "89",
                     "--capability-authority", '{"version":2}',
                     "--controlled-failure"])
    assert code == 0
    call = task_service.calls[0]
    assert call[0:2] == ("benchmark", "workbench")
    assert call[2]["split"] == "selection" and call[2]["seed"] == 19
    assert call[2]["budget"] == {"max_model_calls": 6, "max_tool_calls": 8,
                                 "max_tool_work_units": 89}
    assert call[2]["controlled_failure"] is True
    assert call[2]["capability_authority"] == {"version": 2}
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
    adapter = FakeBenchmarkAdapter()

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


def test_rsi_generate_uses_builtin_reference_improver_when_unspecified(
        monkeypatch, task_service, tmp_path, capsys):
    calls = []

    class FakeEvolution:
        def __init__(self, service):
            assert service is task_service

    class FakeGeneration:
        def __init__(self, service, evolution):
            assert service is task_service and isinstance(evolution, FakeEvolution)

        def generate(self, channel, feedback_id, improver, mutation, expected_revision, **kwargs):
            calls.append((channel, feedback_id, improver, mutation, expected_revision, kwargs))
            return {"id": "generation-builtin", "status": "missing"}

    monkeypatch.setattr("nexgent.tasks.evolution.EvolutionService", FakeEvolution)
    monkeypatch.setattr("nexgent.tasks.generation.GenerationService", FakeGeneration)
    code = cli.main([
        "--root", str(tmp_path), "rsi-generate", "stable", "feedback-1",
        "--mutation-policy", '{"mutable_paths":["main.py"],"component_classes":{"main.py":"O"}}',
        "--expected-revision", "0", "--max-calls", "1",
    ])

    assert code == 0
    improver = calls[0][2]
    assert improver["provenance"] == {
        "origin": "nexgent.default-task-improver", "role": "R0"}
    assert improver["manifest"]["entries"]["improve"] == "improver.py:improve"
    assert calls[0][5]["improver_channel"] is None
    assert calls[0][5]["expected_improver_revision"] is None
    assert calls[0][5]["budget"] == {"max_model_calls": 1}
    assert json.loads(capsys.readouterr().out)["status"] == "missing"


def test_rsi_cycle_commands_freeze_inputs_run_resume_and_emit_only_public_state(
        monkeypatch, task_service, tmp_path, capsys):
    calls = []
    adapter = FakeBenchmarkAdapter()
    records = {}

    class FakeEvolution:
        def __init__(self, service):
            assert service is task_service

    class FakeGeneration:
        def __init__(self, service, evolution):
            assert service is task_service and isinstance(evolution, FakeEvolution)

    class FakeCycles:
        def __init__(self, service, evolution, generation):
            assert service is task_service
            assert isinstance(evolution, FakeEvolution)
            assert isinstance(generation, FakeGeneration)

        def create(self, **kwargs):
            if kwargs.get("improver_channel"):
                identity = "rsi-cycle-channel"
            elif kwargs["improver_package"].get("id") == "R-explicit":
                identity = "rsi-cycle-explicit"
            else:
                identity = "rsi-cycle-1"
            calls.append(("create", kwargs))
            records[identity] = {
                "id": identity, "status": "registered",
                "selection": {"benchmark_id": "generic"},
                "guard": {"benchmark_id": "generic"},
                "mutation_policy": {"private": "must not print"}}
            return records[identity]

        def run(self, identity, selection, guard, **kwargs):
            calls.append(("run", identity, selection, guard, kwargs))
            records[identity]["status"] = "completed"
            return records[identity]

        def resume(self, identity, selection, guard, **kwargs):
            calls.append(("resume", identity, selection, guard, kwargs))
            records[identity]["status"] = "completed"
            return records[identity]

        def get(self, identity):
            calls.append(("get", identity))
            return records[identity]

        def recover(self, identity, **kwargs):
            calls.append(("recover", identity, kwargs))
            if not kwargs.get("confirm_no_external_commit"):
                records[identity]["status"] = "registered"
                records[identity]["runner_status"] = "recovery_required"
            return records[identity]

        def public(self, identity):
            calls.append(("public", identity))
            return {"schema": "nexgent.rsi-cycle.v1", "id": identity,
                    "status": records[identity]["status"],
                    "selection": {"benchmark_id": "generic", "snapshot_digest": "s"},
                    "guard": {"benchmark_id": "generic", "snapshot_digest": "g"},
                    "refs": {}, "runner": {
                        "status": records[identity].get("runner_status", "completed")}}

    monkeypatch.setattr("nexgent.tasks.evolution.EvolutionService", FakeEvolution)
    monkeypatch.setattr("nexgent.tasks.generation.GenerationService", FakeGeneration)
    monkeypatch.setattr("nexgent.tasks.cycles.RSICycleService", FakeCycles)
    monkeypatch.setattr("nexgent.tasks.tools.task_benchmarks", lambda: {"generic": adapter})

    start = [
        "--root", str(tmp_path), "rsi-cycle-start", "stable", "generic",
        "episode-a", "episode-b", "--expected-revision", "4",
        "--mutation-policy", '{"mutable_paths":["main.py"],"component_classes":{"main.py":"O"}}',
        "--selection-seed", "17", "--guard-seed", "23",
        "--generation-budget", '{"max_model_calls":1}',
        "--selection-budget", '{"max_nodes":8}',
        "--guard-budget", '{"max_tool_calls":3}',
        "--policy", '{"min_quality_delta":0.2}',
    ]
    assert cli.main(start) == 0
    output = json.loads(capsys.readouterr().out)
    assert output["status"] == "completed"
    assert "mutation_policy" not in output
    created = calls[0][1]
    assert created["channel"] == "stable"
    assert created["feedback_episode_ids"] == ["episode-a", "episode-b"]
    assert created["selection_adapter"] is adapter and created["guard_adapter"] is adapter
    assert created["selection_seed"] == 17 and created["guard_seed"] == 23
    assert created["generation_budget"] == {"max_model_calls": 1}
    assert created["selection_budget"] == {"max_nodes": 8}
    assert created["guard_budget"] == {"max_tool_calls": 3}
    assert created["policy"].min_quality_delta == 0.2
    assert created["improver_package"]["provenance"] == {
        "origin": "nexgent.default-task-improver", "role": "R0"}
    assert created["improver_channel"] is None
    assert created["expected_improver_revision"] is None
    assert calls[1][0:4] == ("run", "rsi-cycle-1", adapter, adapter)

    assert cli.main([
        "--root", str(tmp_path), "rsi-cycle-start", "stable", "generic", "episode-c",
        "--expected-revision", "4", "--mutation-policy", '{}',
        "--improver-package", '{"id":"R-explicit"}', "--register-only"]) == 0
    assert json.loads(capsys.readouterr().out)["status"] == "registered"
    assert records["rsi-cycle-explicit"]["status"] == "registered"

    assert cli.main([
        "--root", str(tmp_path), "rsi-cycle-start", "stable", "generic", "episode-d",
        "--expected-revision", "4", "--mutation-policy", '{}',
        "--improver-channel", "recursive", "--expected-improver-revision", "6",
        "--register-only"]) == 0
    assert json.loads(capsys.readouterr().out)["status"] == "registered"
    channel_create = [call for call in calls if call[0] == "create"
                      and call[1].get("improver_channel") == "recursive"][-1][1]
    assert channel_create["improver_package"] is None
    assert channel_create["expected_improver_revision"] == 6

    assert cli.main(["--root", str(tmp_path), "rsi-cycle-resume", "rsi-cycle-1"]) == 0
    assert json.loads(capsys.readouterr().out)["status"] == "completed"
    assert any(call[0:4] == ("resume", "rsi-cycle-1", adapter, adapter) for call in calls)

    assert cli.main(["--root", str(tmp_path), "rsi-cycle-show", "rsi-cycle-1"]) == 0
    shown = json.loads(capsys.readouterr().out)
    assert "mutation_policy" not in shown
    assert cli.main([
        "--root", str(tmp_path), "rsi-cycle-recover", "rsi-cycle-1",
        "--confirm-no-external-commit"]) == 0
    recovered = json.loads(capsys.readouterr().out)
    assert recovered["id"] == "rsi-cycle-1"
    assert ("recover", "rsi-cycle-1", {"confirm_no_external_commit": True}) in calls
    assert cli.main([
        "--root", str(tmp_path), "rsi-cycle-recover", "rsi-cycle-1"]) == 1
    unresolved = json.loads(capsys.readouterr().out)
    assert unresolved["runner"]["status"] == "recovery_required"


def test_recursive_improver_cycle_cli_freezes_spec_and_returns_public_projection(
        monkeypatch, task_service, tmp_path, capsys):
    calls = []
    adapter = FakeBenchmarkAdapter()
    task_service.store = object()
    task_package = {"id": "A0", "digest": "a" * 64}
    feedback = {"id": "feedback-1", "record_digest": "f" * 64}

    class FakeEvolution:
        def __init__(self, service):
            assert service is task_service

        def active(self, channel):
            assert channel == "agent"
            return {"revision": 3, "package": task_package}

    class FakeGeneration:
        def __init__(self, service, evolution):
            assert service is task_service and isinstance(evolution, FakeEvolution)

        def feedback(self, identity):
            assert identity == "feedback-1"
            return feedback

    class FakeImprovers:
        def __init__(self, service):
            assert service is task_service
            self.store = service.store

    class FakeExecutor:
        def __init__(self, service, generation, frozen_adapter):
            assert service is task_service and isinstance(generation, FakeGeneration)
            assert frozen_adapter is adapter

        def generate_offspring(self, request):
            return request

        def evaluate_descendant(self, request):
            return request

    class FakeMeta:
        def __init__(self, store, generate, evaluate):
            assert store is task_service.store and callable(generate) and callable(evaluate)

    class FakeGuards:
        def __init__(self, improvers, generate, evaluate):
            assert isinstance(improvers, FakeImprovers)

    class FakeCycles:
        def __init__(self, improvers, meta, guards):
            assert isinstance(improvers, FakeImprovers)

        def start(self, **kwargs):
            calls.append(("start", kwargs))
            return {"id": "recursive-cycle-1"}

        def resume(self, identity, **kwargs):
            calls.append(("resume", identity, kwargs))

        def show(self, identity):
            calls.append(("show", identity))
            return {"schema": "nexgent.recursive-improver-cycle.v1",
                    "id": identity, "status": "completed", "refs": {}}

    monkeypatch.setattr("nexgent.tasks.evolution.EvolutionService", FakeEvolution)
    monkeypatch.setattr("nexgent.tasks.generation.GenerationService", FakeGeneration)
    monkeypatch.setattr("nexgent.tasks.improvers.ImproverService", FakeImprovers)
    monkeypatch.setattr("nexgent.tasks.meta_evaluation.TaskMetaExecutor", FakeExecutor)
    monkeypatch.setattr("nexgent.tasks.meta_evaluation.MetaEvaluationService", FakeMeta)
    monkeypatch.setattr("nexgent.tasks.guards.ImproverGuardService", FakeGuards)
    monkeypatch.setattr(
        "nexgent.tasks.recursive_cycles.RecursiveImproverCycleService", FakeCycles)
    monkeypatch.setattr("nexgent.tasks.tools.task_benchmarks", lambda: {"generic": adapter})
    spec = {
        "channel": "recursive", "expected_revision": 2,
        "generation_ids": ["generation-1"], "decision_ids": [],
        "task_channel": "agent", "task_channel_revision": 3,
        "task_feedback_bundle_id": "feedback-1",
        "task_mutation_policy": {"mutable_components": ["orchestrator"]},
        "provider": "provider", "model": "model",
        "development_tasks": [{"id": "development-1"}],
        "selection_tasks": [{"id": "selection-1"}],
        "evaluator": {"id": "evaluator-1"},
        "meta_budget": {"max_nodes": 20},
        "guard_budget": {"max_nodes": 10},
        "guard_tasks": [{"id": "guard-1"}],
        "guard_min_mean_utility": 0.5,
    }
    code = cli.main([
        "--root", str(tmp_path), "rsi-improver-cycle-start", "generic",
        "--spec", json.dumps(spec),
    ])

    assert code == 0
    output = json.loads(capsys.readouterr().out)
    assert output == {"schema": "nexgent.recursive-improver-cycle.v1",
                      "id": "recursive-cycle-1", "status": "completed", "refs": {}}
    started = calls[0][1]
    assert started["task_agent"] is task_package
    assert started["task_feedback_bundle"] is feedback
    assert "task_feedback_bundle_id" not in started
    assert calls[1][0:2] == ("resume", "recursive-cycle-1")


@pytest.mark.parametrize("arguments", [
    ["--improver-channel", "recursive"],
    ["--expected-improver-revision", "2"],
    ["--improver-package", '{"id":"R"}', "--improver-channel", "recursive",
     "--expected-improver-revision", "2"],
])
def test_rsi_cycle_cli_rejects_ambiguous_or_unpaired_improver_channel(
        task_service, tmp_path, arguments):
    with pytest.raises(SystemExit):
        cli.main([
            "--root", str(tmp_path), "rsi-cycle-start", "stable", "generic", "episode-a",
            "--expected-revision", "0", "--mutation-policy", '{}', *arguments])


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
    with pytest.raises(SystemExit):
        cli.main(["--root", str(tmp_path), "rsi-generate", "stable", "feedback-1",
                  "--improver-package", "builtin:reference-os-v1",
                  "--improver-channel", "recursive",
                  "--mutation-policy", '{}', "--expected-revision", "0"])
    with pytest.raises(SystemExit):
        cli.main(["--root", str(tmp_path), "rsi-generate", "stable", "feedback-1",
                  "--improver-channel", "recursive",
                  "--mutation-policy", '{}', "--expected-revision", "0"])
    with pytest.raises(SystemExit):
        cli.main(["--root", str(tmp_path), "rsi-generate", "stable", "feedback-1",
                  "--expected-improver-revision", "0",
                  "--mutation-policy", '{}', "--expected-revision", "0"])


def test_gui_defaults_to_task_workspace_and_forwards_legacy_switch(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr("nexgent.ui.app.main", lambda argv: calls.append(argv) or 0)
    assert cli.main(["--root", str(tmp_path), "gui"]) == 0
    assert calls[-1] == ["--project", str(tmp_path)]
    assert cli.main(["--root", str(tmp_path), "gui", "--legacy-research"]) == 0
    assert calls[-1] == ["--project", str(tmp_path), "--legacy-research"]
