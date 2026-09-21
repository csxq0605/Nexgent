from pathlib import Path
import json
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexgent.tasks.evolution import EvolutionService
from nexgent.tasks.generation import GenerationService
from nexgent.tasks.guards import ImproverGuardService
from nexgent.tasks.improvers import ImproverService
from nexgent.tasks.meta_evaluation import (
    AdmissionConflict,
    MetaEvaluationPolicy,
    MetaEvaluationService,
    TaskMetaExecutor,
)
from nexgent.tasks.recursive_cycles import (
    RecursiveImproverCycleService,
    public_recursive_cycle,
)
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ContractError, ToolRegistry

from test_recursive_improver_pilot import (
    IMPROVER_POLICY,
    META_BUDGET,
    R0_SOURCE,
    R1_SOURCE,
    TASK_POLICY,
    RecursivePilotBenchmark,
    improver_package,
    p3_decision,
    result_spec,
    task_package,
)


def prepared_cycle(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    improvers = ImproverService(tasks)
    benchmark = RecursivePilotBenchmark()
    executor = TaskMetaExecutor(tasks, generation, benchmark)
    meta = MetaEvaluationService(
        tasks.store, executor.generate_offspring, executor.evaluate_descendant)
    guards = ImproverGuardService(
        improvers, executor.generate_offspring, executor.evaluate_descendant)
    cycles = RecursiveImproverCycleService(improvers, meta, guards)
    a0, r0 = task_package(), improver_package()
    evolution.register("agent", a0)
    improvers.register("recursive", r0, IMPROVER_POLICY)

    episode = tasks.create(
        "Observe the common A0 starting behavior", deliverables=result_spec(),
        package_channel="agent",
        context={"split": "development", "split_role": "development"})
    episode = tasks.run(episode["id"])
    tasks.evaluate(
        episode["id"], benchmark,
        benchmark.tasks("development", seed=1)[0], snapshot=benchmark.snapshot())
    task_feedback = generation.capture_feedback(
        "agent", [episode["id"]], expected_revision=0)
    task_generation = generation.generate(
        "agent", task_feedback["id"], None, TASK_POLICY, 0,
        improver_channel="recursive", expected_improver_revision=0)
    task_decision = p3_decision(
        evolution, task_generation["candidate_id"], benchmark, 2)
    evaluator = {"benchmark_id": benchmark.id, "snapshot": benchmark.snapshot()}
    cycle = cycles.start(
        channel="recursive", expected_revision=0,
        generation_ids=[task_generation["id"]],
        decision_ids=[task_decision["id"]],
        task_agent=a0, task_feedback_bundle=task_feedback,
        task_channel="agent", task_channel_revision=0,
        task_mutation_policy=TASK_POLICY,
        provider="none", model="none",
        development_tasks=benchmark.tasks("development", seed=3),
        selection_tasks=benchmark.tasks("selection", seed=4),
        evaluator=evaluator, meta_budget=META_BUDGET,
        meta_policy=MetaEvaluationPolicy(
            min_utility_delta=0.3, min_success_rate=1.0,
            max_cost_ratio=1.0, max_regressions=0),
        guard_budget={**META_BUDGET, "max_nodes": 20},
        guard_tasks=benchmark.tasks("guard", seed=5),
        guard_min_mean_utility=0.9, guard_min_success_rate=1.0)
    return tasks, evolution, improvers, meta, guards, cycles, cycle, r0


def drift_task_channel(tasks):
    with tasks.store.connect() as db:
        row = db.execute(
            "SELECT revision,data FROM task_package_channels WHERE name='agent'").fetchone()
        state = json.loads(row[1])
        state["revision"] = row[0] + 1
        db.execute(
            "UPDATE task_package_channels SET revision=?,data=? WHERE name='agent'",
            (state["revision"], json.dumps(
                state, ensure_ascii=False, sort_keys=True,
                separators=(",", ":"), allow_nan=False)))


def test_recursive_cycle_resumes_all_stages_and_guard_rolls_back(
        tmp_path, monkeypatch):
    tasks, evolution, improvers, meta, guards, cycles, cycle, r0 = prepared_cycle(tmp_path)

    first = cycles.resume(cycle["id"], max_steps=3)
    assert first["status"] == "meta_planned"
    assert set(first["refs"]) == {
        "improver_feedback_id", "improver_generation_id", "candidate_id",
        "r1_package_id", "r1_package_digest", "meta_plan_id",
    }

    restored = RecursiveImproverCycleService(improvers, meta, guards)
    promoted = restored.resume(cycle["id"], max_steps=5)
    assert promoted["status"] == "promoted"

    original_release = restored._release
    lost_release = {"done": False}

    def lose_terminal_release(cycle_id, token, error=None):
        current = restored.get(cycle_id)
        if (current["status"] in {"completed", "rolled_back"}
                and error is None and not lost_release["done"]):
            lost_release["done"] = True
            raise RuntimeError("lost terminal runner release")
        return original_release(cycle_id, token, error)

    monkeypatch.setattr(restored, "_release", lose_terminal_release)
    with pytest.raises(RuntimeError, match="lost terminal runner release"):
        restored.resume(cycle["id"])
    stuck = restored.get(cycle["id"])
    assert stuck["status"] == "rolled_back"
    assert stuck["runner"]["status"] == "completed"
    assert stuck["runner"]["token"] is None

    monkeypatch.setattr(restored, "_release", original_release)
    terminal = restored.recover(cycle["id"])
    assert terminal["status"] == "rolled_back"
    assert terminal["runner"]["status"] == "completed"
    interrupted_again = json.loads(json.dumps(terminal))
    interrupted_again.pop("record_digest")
    interrupted_again["runner"] = {
        "status": "running", "token": "orphaned-terminal-token",
        "updated_at": terminal["updated_at"], "last_error": None,
        "error_type": None,
    }
    restored._replace(
        terminal, interrupted_again, "test_terminal_interruption", {})
    terminal = restored.resume(cycle["id"])
    assert terminal["runner"]["status"] == "completed"
    assert terminal["result"]["degraded"] is True
    assert terminal["result"]["rolled_back"] is True
    assert terminal["result"]["active_package_id"] == r0["id"]
    assert improvers.active("recursive")["revision"] == 2
    assert improvers.active("recursive")["package_id"] == r0["id"]
    assert meta.trial(terminal["refs"]["meta_trial_id"])["measurement_complete"] is True
    guard_action = guards.action(terminal["refs"]["guard_action_id"])
    assert guard_action["rolled_back"] is True

    event_count = len(restored.events(cycle["id"]))
    assert restored.resume(cycle["id"]) == terminal
    assert len(restored.events(cycle["id"])) == event_count

    public = restored.show(cycle["id"])
    serialized = json.dumps(public, ensure_ascii=False)
    assert public["status"] == "rolled_back"
    assert public["workload"]["development_task_count"] == 1
    assert public["workload"]["selection_task_count"] == 2
    assert "development_tasks" not in serialized
    assert "selection_tasks" not in serialized
    assert '"meta_policy":' not in serialized
    assert '"task_mutation_policy":' not in serialized
    assert R0_SOURCE not in serialized and R1_SOURCE not in serialized
    assert "MUST_NOT_ENTER_IMPROVER_INPUT" not in serialized
    injected = public_recursive_cycle({
        **terminal,
        "refs": {**terminal["refs"], "future_private_ref": "secret-ref"},
        "result": {**terminal["result"], "future_private_result": "secret-result"},
    })
    assert "secret-ref" not in json.dumps(injected)
    assert "secret-result" not in json.dumps(injected)
    nested = public_recursive_cycle({
        **terminal,
        "refs": {**terminal["refs"], "candidate_id": {"source": "secret-source"}},
        "result": {**terminal["result"], "outcome": {"evaluator": "secret-evaluator"}},
    })
    assert "secret-source" not in json.dumps(nested)
    assert "secret-evaluator" not in json.dumps(nested)
    assert "candidate_id" not in nested["refs"]
    assert "outcome" not in nested["result"]


def test_recursive_cycle_reconciles_completed_meta_run_without_episode_replay(
        tmp_path, monkeypatch):
    tasks, evolution, improvers, meta, guards, cycles, cycle, r0 = prepared_cycle(tmp_path)
    planned = cycles.resume(cycle["id"], max_steps=3)
    assert planned["status"] == "meta_planned"
    original = cycles._advance
    lost = {"done": False}

    def lose_checkpoint(cycle_id, token, expected, status, *, refs=None, result=None):
        if expected == "meta_planned" and not lost["done"]:
            lost["done"] = True
            raise RuntimeError("lost meta checkpoint")
        return original(cycle_id, token, expected, status, refs=refs, result=result)

    monkeypatch.setattr(cycles, "_advance", lose_checkpoint)
    with pytest.raises(RuntimeError, match="lost meta checkpoint"):
        cycles.resume(cycle["id"])
    episode_count = len(tasks.list())
    with pytest.raises(ContractError, match="recover"):
        cycles.resume(cycle["id"])

    claim = None
    with tasks.store.connect() as db:
        claim = db.execute(
            "SELECT status,trial_id FROM task_improver_meta_run_claims WHERE plan_id=?",
            (planned["refs"]["meta_plan_id"],)).fetchone()
    assert claim[0] == "completed" and claim[1]
    recovered = cycles.recover(cycle["id"])
    assert recovered["status"] == "meta_run"
    assert recovered["refs"]["meta_trial_id"] == claim[1]
    assert len(tasks.list()) == episode_count

    monkeypatch.setattr(cycles, "_advance", original)
    terminal = cycles.resume(cycle["id"])
    assert terminal["refs"]["meta_trial_id"] == claim[1]
    assert terminal["status"] == "rolled_back"


def test_recursive_cycle_reconciles_terminal_self_generation_without_replay(
        tmp_path, monkeypatch):
    tasks, evolution, improvers, meta, guards, cycles, cycle, r0 = prepared_cycle(tmp_path)
    captured = cycles.resume(cycle["id"], max_steps=1)
    assert captured["status"] == "feedback_captured"
    original = cycles._advance
    lost = {"done": False}

    def lose_checkpoint(cycle_id, token, expected, status, *, refs=None, result=None):
        if expected == "feedback_captured" and not lost["done"]:
            lost["done"] = True
            raise RuntimeError("lost generation checkpoint")
        return original(cycle_id, token, expected, status, refs=refs, result=result)

    monkeypatch.setattr(cycles, "_advance", lose_checkpoint)
    with pytest.raises(RuntimeError, match="lost generation checkpoint"):
        cycles.resume(cycle["id"])
    episode_count = len(tasks.list())
    pending = cycles.get(cycle["id"])["pending_action"]
    generations = cycles._table_records("task_improver_generations")
    assert len(generations) == 1 and generations[0]["status"] == "generated"
    assert generations[0]["invocation"] == {
        "schema": "nexgent.recursive-cycle-invocation.v1",
        "cycle_id": cycle["id"], "action_id": pending["action_id"],
        "nonce": pending["nonce"], "started_at": pending["started_at"],
        "intent_digest": pending["intent_digest"],
    }

    recovered = cycles.recover(cycle["id"])
    assert recovered["status"] == "generated"
    assert recovered["refs"]["improver_generation_id"] == generations[0]["id"]
    assert len(tasks.list()) == episode_count

    monkeypatch.setattr(cycles, "_advance", original)
    planned = cycles.resume(cycle["id"], max_steps=1)
    assert planned["status"] == "meta_planned"
    assert planned["refs"]["improver_generation_id"] == generations[0]["id"]
    assert len([item for item in cycles._table_records("task_improver_generations")
                if item["feedback_id"] == captured["refs"]["improver_feedback_id"]]) == 1


def test_recovery_does_not_claim_foreign_generation_with_same_feedback(tmp_path):
    tasks, evolution, improvers, meta, guards, cycles, cycle, r0 = prepared_cycle(tmp_path)
    captured = cycles.resume(cycle["id"], max_steps=1)
    foreign = improvers.generate_candidate(
        "recursive", captured["refs"]["improver_feedback_id"], 0,
        budget={"max_nodes": 19})
    assert foreign["status"] == "generated"
    assert foreign["invocation"] is None
    assert foreign["outer_budget"] != cycle["workload"]["self_generation_budget"]

    claimed, token = cycles._claim(cycle["id"])
    cycles._begin_action(cycle["id"], token)
    cycles._release(cycle["id"], token, error=RuntimeError("simulated loss"))
    recovered = cycles.recover(cycle["id"])
    assert recovered["status"] == "feedback_captured"
    assert recovered["runner"]["status"] == "recovery_required"
    assert "improver_generation_id" not in recovered["refs"]


def test_reserved_invocation_rejects_copied_call_and_replays_terminal_result(tmp_path):
    tasks, evolution, improvers, meta, guards, cycles, cycle, r0 = prepared_cycle(tmp_path)
    captured = cycles.resume(cycle["id"], max_steps=1)
    claimed, token = cycles._claim(cycle["id"])
    action = cycles._begin_action(cycle["id"], token)
    invocation = cycles._generation_invocation(action)
    before = len(tasks.list())

    with pytest.raises(ContractError, match="claim token"):
        improvers.generate_candidate(
            "recursive", captured["refs"]["improver_feedback_id"], 0,
            budget=cycle["workload"]["self_generation_budget"],
            invocation=invocation)
    assert len(tasks.list()) == before

    claim_token = action["pending_action"]["generation_claim_token"]
    first = improvers.generate_candidate(
        "recursive", captured["refs"]["improver_feedback_id"], 0,
        budget=cycle["workload"]["self_generation_budget"],
        invocation=invocation, invocation_claim_token=claim_token)
    after_first = len(tasks.list())
    replay = improvers.generate_candidate(
        "recursive", captured["refs"]["improver_feedback_id"], 0,
        budget=cycle["workload"]["self_generation_budget"],
        invocation=invocation, invocation_claim_token=claim_token)
    assert replay == first
    assert len(tasks.list()) == after_first

    cycles._release(cycle["id"], token, error=RuntimeError("simulated loss"))
    recovered = cycles.recover(cycle["id"])
    assert recovered["status"] == "generated"
    assert recovered["refs"]["improver_generation_id"] == first["id"]


def test_meta_admission_conflict_between_create_and_run_is_not_measurement(
        tmp_path, monkeypatch):
    tasks, evolution, improvers, meta, guards, cycles, cycle, r0 = prepared_cycle(tmp_path)
    planned = cycles.resume(cycle["id"], max_steps=3)
    before = len(tasks.list())
    original_create = tasks.create
    target = {"id": None}

    def create_then_drift(*args, **kwargs):
        state = original_create(*args, **kwargs)
        if (target["id"] is None
                and (kwargs.get("context") or {}).get("rsi_role")
                == "improver_descendant_evaluation"):
            target["id"] = state["id"]
            drift_task_channel(tasks)
        return state

    monkeypatch.setattr(tasks, "create", create_then_drift)
    with pytest.raises(AdmissionConflict, match="A0 changed"):
        cycles.resume(cycle["id"], max_steps=1)

    interrupted = cycles.get(cycle["id"])
    assert interrupted["status"] == "meta_planned"
    assert interrupted["pending_action"]["stage"] == "meta_planned"
    assert interrupted["runner"]["status"] == "paused"
    created = tasks.get_private(target["id"])
    assert created["status"] != "completed"
    assert created.get("evaluation") is None
    with tasks.store.connect() as db:
        assert db.execute(
            "SELECT COUNT(*) FROM task_improver_meta_trials WHERE "
            "json_extract(data,'$.plan_id')=?",
            (planned["refs"]["meta_plan_id"],)).fetchone()[0] == 0
    # Two valid generation Episodes and one valid evaluation create occurred;
    # the invalid run/evaluate boundaries did not execute.
    assert len(tasks.list()) == before + 3
