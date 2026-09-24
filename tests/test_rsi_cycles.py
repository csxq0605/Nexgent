from pathlib import Path
import json
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexgent.tasks.cycles import RSICycleService
from nexgent.tasks.evolution import EvolutionService, PromotionPolicy
from nexgent.tasks.generation import GenerationService, PATCH_SCHEMA
from nexgent.tasks.improvers import ImproverService
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ContractError, ToolRegistry


PARENT_SOURCE = """def execute(payload, context):
    artifact = context.publish({'score': 0.0}, name='result')
    return {'deliverables': {'result': artifact['id']}}
"""

CHILD_SOURCE = """def execute(payload, context):
    artifact = context.publish({'score': 1.0}, name='result')
    return {'deliverables': {'result': artifact['id']}}
"""


def parent_package():
    return make_package(
        {"behavior.py": PARENT_SOURCE},
        {"entries": {"execute": "behavior.py:execute"}},
        provenance={"fixture": "cycle-parent"})


def improver_package(parent):
    patch = {
        "schema": PATCH_SCHEMA,
        "hypothesis": {
            "failure_mechanism": "The baseline emits the lower score.",
            "expected_behavior": "The candidate emits the higher score.",
            "applicability": "Tasks using the generic result contract.",
            "falsifier": "The changed component is not loaded or does not improve score.",
        },
        "operations": [{
            "op": "replace", "path": "behavior.py",
            "old_digest": parent["component_digests"]["behavior.py"],
            "content": CHILD_SOURCE,
        }],
        "activation_probe": {"kind": "component_loaded", "path": "behavior.py"},
    }
    source = """def improve(payload, context):
    context.read_artifact(payload['input_refs']['feedback_bundle'])
    context.read_artifact(payload['input_refs']['parent_components'])
    context.read_artifact(payload['input_refs']['mutation_policy'])
    artifact = context.publish(PATCH, name='behavior_patch')
    return {'deliverables': {'behavior_patch': artifact['id']}}
""".replace("PATCH", repr(patch))
    return make_package(
        {"improver.py": source},
        {"entries": {"execute": "improver.py:improve", "improve": "improver.py:improve"}},
        provenance={"fixture": "cycle-improver"})


class GenericBenchmark:
    id = "generic-cycle-benchmark"

    def __init__(self, *, guard_score=1.0, snapshot_version=1):
        self.guard_score = guard_score
        self.snapshot_version = snapshot_version

    def snapshot(self):
        return {"id": self.id, "version": self.snapshot_version}

    def tasks(self, split="selection", seed=0):
        return [{
            "id": f"{split}/{seed}",
            "objective": "Produce a scored generic result",
            "inputs": {},
            "deliverables": [{"name": "result", "schema": {
                "type": "object", "required": ["score"]}}],
            "capabilities": [], "context": {"split": split},
        }]

    def evaluate(self, task_ref, deliverables, execution_view):
        score = (self.guard_score if task_ref["context"]["split"] == "guard"
                 else deliverables["result"]["score"])
        return {"status": "accepted" if score >= 0.5 else "rejected",
                "score_available": True, "score": score, "accepted": score >= 0.5}


def prepared(tmp_path, *, guard_score=1.0):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    cycles = RSICycleService(tasks, evolution, generation)
    parent = parent_package()
    improver = improver_package(parent)
    benchmark = GenericBenchmark(guard_score=guard_score)
    evolution.register("general", parent)
    feedback = tasks.create(
        "Observe the current generic behavior",
        deliverables=[{"name": "result", "schema": {
            "type": "object", "required": ["score"]}}],
        package_channel="general",
        context={"split": "development", "split_role": "development"})
    feedback = tasks.run(feedback["id"])
    cycle = cycles.create(
        channel="general", feedback_episode_ids=[feedback["id"]],
        improver_package=improver,
        mutation_policy={"mutable_paths": ["behavior.py"],
                         "component_classes": {"behavior.py": "O"},
                         "allowed_operations": ["replace"],
                         "max_patch_bytes": 100000},
        expected_revision=0, selection_adapter=benchmark, guard_adapter=benchmark,
        selection_seed=7, guard_seed=11,
        policy=PromotionPolicy(min_quality_delta=0.5, monitor_min_score=0.5))
    return tasks, evolution, generation, cycles, parent, benchmark, cycle


def test_cycle_closes_all_mandatory_stages_and_terminal_replay_is_idempotent(tmp_path):
    tasks, evolution, generation, cycles, parent, benchmark, cycle = prepared(tmp_path)

    completed = cycles.run(cycle["id"], benchmark, benchmark)

    assert completed["status"] == "completed"
    assert completed["result"]["outcome"] == "completed"
    assert completed["result"]["active_package_id"] != parent["id"]
    assert set(completed["refs"]) == {
        "feedback_bundle_id", "generation_id", "candidate_id",
        "selection_plan_id", "trial_id", "decision_id", "monitor_plan_id",
        "promoted_revision", "promoted_package_id", "monitor_run_id",
        "guard_episode_ids",
    }
    decision = evolution.decision(completed["refs"]["decision_id"])
    assert decision["eligible"] is True
    assert evolution.monitor_run(completed["refs"]["monitor_plan_id"])["id"] == (
        completed["refs"]["monitor_run_id"])

    event_count = len(cycles.events(cycle["id"]))
    replay = cycles.run(cycle["id"], benchmark, benchmark)
    assert replay == completed
    assert len(cycles.events(cycle["id"])) == event_count


def test_cycle_resumes_from_persisted_checkpoints_and_rolls_back_on_guard(tmp_path):
    tasks, evolution, generation, cycles, parent, benchmark, cycle = prepared(
        tmp_path, guard_score=0.0)

    first = cycles.run(cycle["id"], benchmark, benchmark, max_steps=3)
    assert first["status"] == "selection_planned"
    first_refs = dict(first["refs"])

    restored = RSICycleService(tasks, evolution, generation)
    second = restored.run(cycle["id"], benchmark, benchmark, max_steps=3)
    assert second["status"] == "guard_planned"
    assert all(second["refs"][key] == value for key, value in first_refs.items())

    terminal = restored.resume(cycle["id"], benchmark, benchmark)
    assert terminal["status"] == "rolled_back"
    assert terminal["result"]["degraded"] is True
    assert terminal["result"]["rolled_back"] is True
    assert terminal["result"]["active_package_id"] == parent["id"]
    assert evolution.active("general")["package_id"] == parent["id"]

    transitions = [event["content"] for event in restored.events(cycle["id"])
                   if event["kind"] == "cycle_transitioned"]
    assert [(row["from"], row["to"]) for row in transitions] == [
        ("registered", "feedback_captured"),
        ("feedback_captured", "generated"),
        ("generated", "selection_planned"),
        ("selection_planned", "selection_run"),
        ("selection_run", "selected"),
        ("selected", "guard_planned"),
        ("guard_planned", "promoted"),
        ("promoted", "guard_run"),
        ("guard_run", "rolled_back"),
    ]


def test_cycle_fails_closed_when_a_frozen_adapter_changes_and_can_resume(tmp_path):
    tasks, evolution, generation, cycles, parent, benchmark, cycle = prepared(tmp_path)
    changed = GenericBenchmark(snapshot_version=2)

    with pytest.raises(ContractError, match="changed from the frozen RSI cycle"):
        cycles.run(cycle["id"], changed, benchmark)

    paused = cycles.get(cycle["id"])
    assert paused["status"] == "registered"
    assert paused["runner"]["status"] == "paused"
    completed = cycles.resume(cycle["id"], benchmark, benchmark)
    assert completed["status"] == "completed"


def test_hard_interruption_without_a_pending_action_has_explicit_safe_recovery(tmp_path):
    tasks, evolution, generation, cycles, parent, benchmark, cycle = prepared(tmp_path)
    claimed, token = cycles._claim(cycle["id"])
    assert token and claimed["runner"]["status"] == "running"

    restored = RSICycleService(tasks, evolution, generation)
    with pytest.raises(ContractError, match="call recover"):
        restored.run(cycle["id"], benchmark, benchmark)
    recovered = restored.recover(cycle["id"])
    assert recovered["runner"]["status"] == "paused"
    assert restored.run(cycle["id"], benchmark, benchmark)["status"] == "completed"


def test_uncertain_external_commit_requires_reconciliation_and_public_view_is_safe(
        tmp_path, monkeypatch):
    tasks, evolution, generation, cycles, parent, benchmark, cycle = prepared(tmp_path)
    original = cycles._advance
    interrupted = {"done": False}

    def fail_after_external_commit(record, token, expected, status, refs=None, result=None):
        if expected == "registered" and not interrupted["done"]:
            interrupted["done"] = True
            raise RuntimeError("simulated process loss after external commit")
        return original(record, token, expected, status, refs, result)

    monkeypatch.setattr(cycles, "_advance", fail_after_external_commit)
    with pytest.raises(RuntimeError, match="simulated process loss"):
        cycles.run(cycle["id"], benchmark, benchmark)

    uncertain = cycles.get(cycle["id"])
    assert uncertain["status"] == "registered"
    assert uncertain["pending_action"]["name"] == "registered"
    with pytest.raises(ContractError, match="recover"):
        cycles.resume(cycle["id"], benchmark, benchmark)
    required = cycles.recover(cycle["id"])
    assert required["runner"]["status"] == "recovery_required"
    assert required["runner"]["error_type"] == "UncertainExternalCommit"

    public = cycles.public(cycle["id"])
    serialized = json.dumps(public, ensure_ascii=False)
    assert "snapshot" not in public["selection"]
    assert "mutation_policy" not in serialized
    assert PARENT_SOURCE not in serialized and CHILD_SOURCE not in serialized
    assert "simulated process loss" not in serialized


def test_transition_map_rejects_terminal_shortcuts(tmp_path):
    tasks, evolution, generation, cycles, parent, benchmark, cycle = prepared(tmp_path)
    claimed, token = cycles._claim(cycle["id"])

    with pytest.raises(ContractError, match="skip a mandatory stage"):
        cycles._advance(
            claimed, token, "registered", "completed",
            result={"outcome": "forged"})

    assert cycles.get(cycle["id"])["status"] == "registered"
    cycles.recover(cycle["id"])


def test_completed_paired_claim_is_linked_after_checkpoint_loss_without_replay(
        tmp_path, monkeypatch):
    tasks, evolution, generation, cycles, parent, benchmark, cycle = prepared(tmp_path)
    planned = cycles.run(cycle["id"], benchmark, benchmark, max_steps=3)
    assert planned["status"] == "selection_planned"
    before = len(tasks.list())
    original = cycles._advance
    interrupted = {"done": False}

    def lose_checkpoint(record, token, expected, status, refs=None, result=None):
        if expected == "selection_planned" and not interrupted["done"]:
            interrupted["done"] = True
            raise RuntimeError("lost paired-run checkpoint")
        return original(record, token, expected, status, refs, result)

    monkeypatch.setattr(cycles, "_advance", lose_checkpoint)
    with pytest.raises(RuntimeError, match="lost paired-run checkpoint"):
        cycles.run(cycle["id"], benchmark, benchmark)
    after_run = len(tasks.list())
    assert after_run == before + 2
    claim = evolution.inspect_run_claim("paired", planned["refs"]["selection_plan_id"])
    assert claim["status"] == "completed" and claim["record_id"]

    recovered = cycles.recover(cycle["id"])
    assert recovered["pending_action"] is None
    monkeypatch.setattr(cycles, "_advance", original)
    completed = cycles.resume(cycle["id"], benchmark, benchmark)
    assert completed["status"] == "completed"
    assert completed["refs"]["trial_id"] == claim["record_id"]
    # Resume linked the completed immutable trial; it did not rerun paired arms.
    selection_episode_ids = {
        row[side]["episode_id"]
        for row in evolution.trial(claim["record_id"])["pairs"]
        for side in ("parent", "candidate")}
    assert len(selection_episode_ids) == 2
    assert selection_episode_ids <= {row["id"] for row in tasks.list()}


def test_running_paired_claim_requires_explicit_no_commit_recovery(
        tmp_path, monkeypatch):
    tasks, evolution, generation, cycles, parent, benchmark, cycle = prepared(tmp_path)
    planned = cycles.run(cycle["id"], benchmark, benchmark, max_steps=3)
    plan_id = planned["refs"]["selection_plan_id"]
    original = evolution.run_pair

    def interrupt_after_claim(identity, adapter, *, stop_event=None):
        assert identity == plan_id
        evolution._claim_run("paired", identity)
        raise RuntimeError("simulated loss with running claim")

    monkeypatch.setattr(evolution, "run_pair", interrupt_after_claim)
    with pytest.raises(RuntimeError, match="running claim"):
        cycles.run(cycle["id"], benchmark, benchmark)
    assert evolution.inspect_run_claim("paired", plan_id)["status"] == "running"

    required = cycles.recover(cycle["id"])
    assert required["runner"]["status"] == "recovery_required"
    assert evolution.inspect_run_claim("paired", plan_id)["status"] == "running"
    recovered = cycles.recover(cycle["id"], confirm_no_external_commit=True)
    assert recovered["pending_action"] is None
    assert evolution.inspect_run_claim("paired", plan_id) is None

    monkeypatch.setattr(evolution, "run_pair", original)
    assert cycles.resume(cycle["id"], benchmark, benchmark)["status"] == "completed"


def test_cycle_refuses_guard_execution_after_promoted_deployment_drifts(tmp_path):
    tasks, evolution, generation, cycles, parent, benchmark, cycle = prepared(tmp_path)
    promoted = cycles.run(cycle["id"], benchmark, benchmark, max_steps=7)
    assert promoted["status"] == "promoted"
    before = len(tasks.list())

    evolution.rollback(
        "general", reason="test concurrent deployment change",
        expected_revision=promoted["refs"]["promoted_revision"],
        expected_package_id=promoted["refs"]["promoted_package_id"],
        expected_monitor_plan_id=promoted["refs"]["monitor_plan_id"])
    with pytest.raises(ContractError, match="expected binding"):
        cycles.resume(cycle["id"], benchmark, benchmark)

    assert len(tasks.list()) == before
    assert evolution.active("general")["package_id"] == parent["id"]


def test_cycle_freezes_and_executes_a_recursive_improver_channel(tmp_path):
    tasks, evolution, generation, cycles, parent, benchmark, _ = prepared(tmp_path)
    improver = improver_package(parent)
    ImproverService(tasks).register(
        "recursive", improver, {"mutable_paths": ["improver.py"]})
    feedback = tasks.create(
        "Observe the active package for channel-driven improvement",
        deliverables=[{"name": "result", "schema": {
            "type": "object", "required": ["score"]}}],
        package_channel="general",
        context={"split": "development", "split_role": "development"})
    feedback = tasks.run(feedback["id"])

    cycle = cycles.create(
        channel="general", feedback_episode_ids=[feedback["id"]],
        improver_channel="recursive", expected_improver_revision=0,
        mutation_policy={"mutable_paths": ["behavior.py"],
                         "component_classes": {"behavior.py": "O"},
                         "allowed_operations": ["replace"],
                         "max_patch_bytes": 100000},
        expected_revision=0, selection_adapter=benchmark, guard_adapter=benchmark,
        policy=PromotionPolicy(min_quality_delta=0.5, monitor_min_score=0.5))

    assert cycle["improver_registration"] == {
        "channel": "recursive", "revision": 0,
        "package_id": improver["id"], "package_digest": improver["digest"]}
    public = cycles.public(cycle["id"])
    assert public["improver"] == {
        "source": "channel", "channel": "recursive", "revision": 0,
        "package_id": improver["id"], "package_digest": improver["digest"]}
    assert "files" not in json.dumps(public, ensure_ascii=False)

    completed = cycles.run(cycle["id"], benchmark, benchmark)
    assert completed["status"] == "completed"
    generated = generation.generation(completed["refs"]["generation_id"])
    assert generated["improver_registration"] == cycle["improver_registration"]


def test_cycle_improver_channel_drift_fails_closed_before_generation(
        tmp_path, monkeypatch):
    tasks, evolution, generation, cycles, parent, benchmark, _ = prepared(tmp_path)
    improver = improver_package(parent)
    ImproverService(tasks).register(
        "recursive", improver, {"mutable_paths": ["improver.py"]})
    feedback = tasks.create(
        "Observe behavior before improver drift",
        deliverables=[{"name": "result", "schema": {
            "type": "object", "required": ["score"]}}],
        package_channel="general",
        context={"split": "development", "split_role": "development"})
    feedback = tasks.run(feedback["id"])
    cycle = cycles.create(
        channel="general", feedback_episode_ids=[feedback["id"]],
        improver_channel="recursive", expected_improver_revision=0,
        mutation_policy={"mutable_paths": ["behavior.py"],
                         "component_classes": {"behavior.py": "O"}},
        expected_revision=0, selection_adapter=benchmark, guard_adapter=benchmark)
    captured = cycles.run(cycle["id"], benchmark, benchmark, max_steps=1)
    assert captured["status"] == "feedback_captured"
    before = len(tasks.list())

    def drifted_registration(store, channel):
        return {"channel": channel, "revision": 1,
                "package_id": improver["id"], "package_digest": improver["digest"],
                "package": improver}

    monkeypatch.setattr(
        "nexgent.tasks.improvers.active_improver_registration", drifted_registration)
    with pytest.raises(ContractError, match="Improver channel expected revision is stale"):
        cycles.resume(cycle["id"], benchmark, benchmark)
    assert len(tasks.list()) == before
    paused = cycles.get(cycle["id"])
    assert paused["status"] == "feedback_captured"
    assert paused["pending_action"]["name"] == "feedback_captured"


@pytest.mark.parametrize("kwargs,match", [
    ({}, "requires an improver package or improver channel"),
    ({"improver_package": {"id": "invalid"}, "improver_channel": "recursive",
      "expected_improver_revision": 0}, "either"),
    ({"improver_channel": "recursive"}, "expected improver revision"),
    ({"improver_package": {"id": "invalid"}, "expected_improver_revision": 0},
     "requires an improver channel"),
])
def test_cycle_improver_source_contract_is_exclusive(tmp_path, kwargs, match):
    tasks, evolution, generation, cycles, parent, benchmark, cycle = prepared(tmp_path)
    base = dict(
        channel="general", feedback_episode_ids=cycle["feedback_episode_ids"],
        mutation_policy={"mutable_paths": ["behavior.py"],
                         "component_classes": {"behavior.py": "O"}},
        expected_revision=0, selection_adapter=benchmark, guard_adapter=benchmark)
    with pytest.raises(ContractError, match=match):
        cycles.create(**base, **kwargs)
