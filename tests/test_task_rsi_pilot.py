import json

from nexgent.kernel.programs import digest
from nexgent.tasks.evidence import (
    build_rsi_mechanism_evidence,
    export_rsi_mechanism_evidence,
)
from nexgent.tasks.evolution import EvolutionService, PromotionPolicy
from nexgent.tasks.generation import GenerationService, PATCH_SCHEMA
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ToolRegistry


PARENT_SOURCE = """def execute(payload, context):
    artifact = context.publish({'version': 0, 'score': 0.0}, name='result')
    return {'deliverables': {'result': artifact['id']}}
"""

CHILD_SOURCE = """def execute(payload, context):
    artifact = context.publish({'version': 1, 'score': 1.0}, name='result')
    return {'deliverables': {'result': artifact['id']}}
"""

PRIVATE_EVALUATOR_SENTINEL = "PRIVATE_GUARD_OR_SELECTION_CONTENT"


def target_parent():
    return make_package(
        {"behavior.py": PARENT_SOURCE},
        {"entries": {"execute": "behavior.py:execute"}},
        provenance={"fixture": "generic-rsi-parent"},
    )


def behavior_patch(parent):
    return {
        "schema": PATCH_SCHEMA,
        "hypothesis": {
            "failure_mechanism": "The active behavior returns the baseline score.",
            "expected_behavior": "The candidate returns the revised score.",
            "applicability": "Tasks whose execute entry loads behavior.py.",
            "falsifier": "The component is not loaded or paired score does not improve.",
        },
        "operations": [{
            "op": "replace",
            "path": "behavior.py",
            "old_digest": parent["component_digests"]["behavior.py"],
            "content": CHILD_SOURCE,
        }],
        "activation_probe": {"kind": "component_loaded", "path": "behavior.py"},
    }


def independent_improver(parent):
    source = """def improve(payload, context):
    feedback = context.read_artifact(payload['input_refs']['feedback_bundle'])['content']
    components = context.read_artifact(payload['input_refs']['parent_components'])['content']
    policy = context.read_artifact(payload['input_refs']['mutation_policy'])['content']
    if feedback['schema'] != 'nexgent.feedback-bundle.v1':
        raise ValueError('feedback contract mismatch')
    if components[0]['path'] not in policy['mutable_paths']:
        raise ValueError('mutation boundary mismatch')
    artifact = context.publish(PATCH, name='behavior_patch')
    return {'deliverables': {'behavior_patch': artifact['id']}}
""".replace("PATCH", repr(behavior_patch(parent)))
    return make_package(
        {"improver.py": source},
        {"entries": {"execute": "improver.py:improve", "improve": "improver.py:improve"}},
        provenance={"fixture": "independent-frozen-improver"},
    )


def result_spec():
    return [{"name": "result", "schema": {
        "type": "object", "required": ["version", "score"],
    }}]


class MechanismPilotBenchmark:
    id = "rsi-mechanism-pilot"

    def snapshot(self):
        return {"id": self.id, "evaluator_digest": "mechanism-pilot-evaluator-v1"}

    def describe(self):
        return {"id": self.id, "kind": "deterministic-mechanism-pilot"}

    def tasks(self, split="development", seed=0):
        count = 1 if split == "guard" else 2
        return [{
            "id": f"{split}/{seed}/{index}",
            "objective": "Produce the generic scored result",
            "inputs": {},
            "deliverables": result_spec(),
            "capabilities": [],
            "context": {"split": split},
        } for index in range(count)]

    def evaluate(self, task_ref, deliverables, execution_view):
        if task_ref.get("context", {}).get("split") == "guard":
            return {
                "status": "rejected", "score_available": True, "score": 0.0,
                "accepted": False, "private_evaluator_content": PRIVATE_EVALUATOR_SENTINEL,
            }
        return {
            "status": "accepted", "score_available": True,
            "score": deliverables["result"]["score"], "accepted": True,
            "private_evaluator_content": PRIVATE_EVALUATOR_SENTINEL,
        }


def test_deterministic_p3_rsi_mechanism_pilot_and_sanitized_evidence(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    benchmark = MechanismPilotBenchmark()
    parent = target_parent()
    improver = independent_improver(parent)
    evolution.register("general", parent)

    # A terminal development Episode from the active channel is the only
    # candidate-generation feedback source.
    feedback_episode = tasks.create(
        "Observe current generic behavior",
        deliverables=result_spec(),
        package_channel="general",
        context={"split": "development", "split_role": "development"},
    )
    feedback_episode = tasks.run(feedback_episode["id"])
    tasks.evaluate(
        feedback_episode["id"], benchmark,
        {"id": "development-feedback", "context": {"split": "development"}},
        snapshot=benchmark.snapshot(),
    )
    feedback = generation.capture_feedback(
        "general", [feedback_episode["id"]], expected_revision=0,
    )

    generated = generation.generate(
        "general", feedback["id"], improver,
        {"mutable_paths": ["behavior.py"],
         "component_classes": {"behavior.py": "O"},
         "allowed_operations": ["replace"], "max_patch_bytes": 100000},
        expected_revision=0,
    )
    assert generated["status"] == "generated"
    candidate = evolution.candidate(generated["candidate_id"])
    child = tasks.store.package(candidate["package_id"])

    policy = PromotionPolicy(
        min_quality_delta=0.5,
        monitor_min_score=0.5,
        monitor_min_success_rate=1.0,
    )
    selection_plan = evolution.plan_pair(
        candidate["id"], benchmark, split="selection", split_role="selection",
        seed=17, policy=policy,
    )
    selection_trial = evolution.run_pair(selection_plan["id"], benchmark)
    decision = evolution.assess(selection_trial["id"])
    assert decision["eligible"] is True
    assert decision["gates"]["behavior_activated"] is True

    # The guard suite is frozen before deployment authority changes.
    monitor_plan = evolution.plan_monitor(candidate["id"], benchmark, split="guard", seed=23)
    promoted = evolution.promote(
        candidate["id"], decision["id"], monitor_plan_id=monitor_plan["id"],
    )
    assert promoted["package_id"] == child["id"]

    post_promotion = tasks.create(
        "Run ordinary work through the promoted channel",
        deliverables=result_spec(), package_channel="general",
    )
    post_promotion = tasks.run(post_promotion["id"])
    assert post_promotion["package_id"] == child["id"]

    guard = evolution.run_monitor("general", benchmark)
    monitored = evolution.monitor("general", guard["episode_ids"])
    assert monitored["degraded"] is True and monitored["rolled_back"] is True
    assert monitored["active"]["package_id"] == parent["id"]

    post_rollback = tasks.create(
        "Run ordinary work after automatic rollback",
        deliverables=result_spec(), package_channel="general",
    )
    post_rollback = tasks.run(post_rollback["id"])
    assert post_rollback["package_id"] == parent["id"]

    arguments = dict(
        channel="general",
        feedback_bundle_id=feedback["id"],
        generation_id=generated["id"],
        selection_plan_id=selection_plan["id"],
        trial_id=selection_trial["id"],
        decision_id=decision["id"],
        monitor_plan_id=monitor_plan["id"],
        promoted_episode_id=post_promotion["id"],
        guard_episode_ids=guard["episode_ids"],
        rollback_episode_id=post_rollback["id"],
    )
    evidence = build_rsi_mechanism_evidence(
        tasks, evolution, generation, **arguments,
    )
    body = {key: value for key, value in evidence.items() if key != "integrity_digest"}
    assert evidence["integrity_digest"] == digest(body)
    assert evidence["claim_scope"] == {
        "mechanism_closed_loop": True,
        "statistical_rsi_benefit_established": False,
        "claim": "deterministic_mechanism_closure_only",
    }
    assert evidence["packages"]["parent"]["id"] == parent["id"]
    assert evidence["packages"]["candidate"]["id"] == child["id"]
    assert evidence["packages"]["improver"]["id"] == improver["id"]
    assert evidence["generation"]["behavior_patch_digest"] == generated["patch_digest"]
    assert evidence["selection"]["gates"]["behavior_activated"] is True
    assert evidence["selection"]["eligible"] is True
    assert evidence["monitoring"]["rollback_observed"] is True
    assert evidence["rollback"]["active_parent_id"] == parent["id"]
    assert all(row["usage"]["usage_complete"] is True
               for row in evidence["selection"]["paired_runs"]
               for row in (row["parent"], row["candidate"]))

    serialized = json.dumps(evidence, ensure_ascii=False)
    assert PRIVATE_EVALUATOR_SENTINEL not in serialized
    assert PARENT_SOURCE not in serialized and CHILD_SOURCE not in serialized
    assert "files" not in evidence["packages"] and "manifest" not in evidence["packages"]

    destination = tmp_path / "exports" / "rsi-mechanism-pilot.json"
    path = export_rsi_mechanism_evidence(
        destination, tasks, evolution, generation, **arguments,
    )
    exported = json.loads(destination.read_text(encoding="utf-8"))
    assert path == str(destination.resolve())
    assert exported == evidence
