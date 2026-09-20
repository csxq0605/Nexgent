from pathlib import Path
import json
import sys
import time

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexgent.tasks.evolution import EvolutionService, PromotionPolicy
from nexgent.kernel.programs import digest
from nexgent.tasks.evidence import build_recursive_improver_evidence
from nexgent.tasks.generation import GenerationService
from nexgent.tasks.guards import ImproverGuardService
from nexgent.tasks.guards import GUARD_CLAIM_LEASE_SECONDS
from nexgent.tasks.improvers import ImproverService
from nexgent.tasks.meta_evaluation import (
    MetaEvaluationPolicy,
    MetaEvaluationService,
    TaskMetaExecutor,
)
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ContractError, ToolRegistry


def behavior_source(version, score):
    return (
        "def execute(payload, context):\n"
        f"    artifact = context.publish({{'version': {version}, 'score': {score}}}, "
        "name='result')\n"
        "    return {'deliverables': {'result': artifact['id']}}\n"
    )


A0_SOURCE = behavior_source(0, 0.0)
D0_SOURCE = behavior_source(1, 0.4)
D1_SOURCE = behavior_source(2, 0.8)
D2_SOURCE = behavior_source(3, 0.9)


def improver_source(task_source, next_source=None):
    source = """def improve(payload, context):
    refs = payload['input_refs']
    if 'parent_components' in refs:
        components = context.read_artifact(refs['parent_components'])['content']
        feedback = context.read_artifact(refs['feedback_bundle'])['content']
        policy = context.read_artifact(refs['mutation_policy'])['content']
        component = next(item for item in components if item['path'] == 'behavior.py')
        if feedback['schema'] != 'nexgent.feedback-bundle.v1':
            raise ValueError('feedback contract mismatch')
        if component['path'] not in policy['mutable_paths']:
            raise ValueError('task mutation boundary mismatch')
        patch = {
            'schema': 'nexgent.behavior-patch.v1',
            'hypothesis': {
                'failure_mechanism': 'The task behavior has lower downstream utility.',
                'expected_behavior': 'The revised behavior increases downstream utility.',
                'applicability': 'Packages whose execute entry loads behavior.py.',
                'falsifier': 'The descendant does not improve on the frozen task suite.',
            },
            'operations': [{
                'op': 'replace', 'path': 'behavior.py',
                'old_digest': component['digest'], 'content': __TASK_SOURCE__,
            }],
            'activation_probe': {'kind': 'component_loaded', 'path': 'behavior.py'},
        }
        artifact = context.publish(patch, name='behavior_patch')
        return {'deliverables': {'behavior_patch': artifact['id']}}
    components = context.read_artifact(refs['self_components'])['content']
    feedback = context.read_artifact(refs['meta_feedback'])['content']
    policy = context.read_artifact(refs['mutation_policy'])['content']
    component = next(item for item in components if item['path'] == 'improver.py')
    if feedback['schema'] != 'nexgent.improver-meta-feedback.v1':
        raise ValueError('meta feedback contract mismatch')
    if component['path'] not in policy['mutable_paths']:
        raise ValueError('self mutation boundary mismatch')
    if __NEXT_SOURCE__ is None:
        raise ValueError('terminal fixture improver has no recursive child')
    patch = {
        'schema': 'nexgent.improver-patch.v1',
        'hypothesis': {
            'failure_mechanism': 'The active improver produces lower-utility descendants.',
            'expected_behavior': 'The child improver produces higher-utility descendants.',
            'applicability': 'The frozen task-agent mutation surface.',
            'falsifier': 'Paired descendant utility does not increase.',
        },
        'operations': [{
            'op': 'replace', 'path': 'improver.py',
            'old_digest': component['digest'], 'content': __NEXT_SOURCE__,
        }],
        'activation_probe': {'kind': 'improve_entry_loaded', 'path': 'improver.py'},
    }
    artifact = context.publish(patch, name='improver_patch')
    return {'deliverables': {'improver_patch': artifact['id']}}
"""
    return source.replace("__TASK_SOURCE__", repr(task_source)).replace(
        "__NEXT_SOURCE__", repr(next_source))


R2_SOURCE = improver_source(D2_SOURCE)
R1_SOURCE = improver_source(D1_SOURCE, R2_SOURCE)
R0_SOURCE = improver_source(D0_SOURCE, R1_SOURCE)


def task_package():
    return make_package(
        {"behavior.py": A0_SOURCE}, {"entries": {"execute": "behavior.py:execute"}},
        provenance={"fixture": "p4-task-a0"})


def improver_package():
    return make_package(
        {"improver.py": R0_SOURCE},
        {"entries": {"execute": "improver.py:improve", "improve": "improver.py:improve"}},
        provenance={"fixture": "p4-improver-r0"})


TASK_POLICY = {
    "mutable_paths": ["behavior.py"],
    "component_classes": {"behavior.py": "O"},
    "allowed_operations": ["replace"], "max_patch_bytes": 100000,
}
IMPROVER_POLICY = {
    "mutable_paths": ["improver.py"], "allowed_operations": ["replace"],
    "max_patch_bytes": 300000, "max_outer_model_calls": 0,
    "max_outer_completion_tokens": 0, "max_outer_tool_calls": 0,
    "max_outer_nodes": 20,
}
META_BUDGET = {
    "max_model_calls": 0, "max_completion_tokens": 0,
    "max_tool_calls": 0, "max_nodes": 40,
}


def result_spec():
    return [{"name": "result", "schema": {
        "type": "object", "required": ["version", "score"],
    }}]


class RecursivePilotBenchmark:
    id = "recursive-improver-pilot"

    def snapshot(self):
        return {"id": self.id, "evaluator_digest": "recursive-pilot-v1"}

    def tasks(self, split="development", seed=0):
        count = 2 if split == "selection" else 1
        return [{
            "id": f"{split}/{seed}/{index}",
            "objective": "Produce a scored generic task result",
            "inputs": {}, "deliverables": result_spec(), "capabilities": [],
            "context": {"split": split, "seed": seed, "index": index},
        } for index in range(count)]

    def evaluate(self, task_ref, deliverables, execution_view):
        score = float(deliverables["result"]["score"])
        return {"status": "accepted" if score >= 0.1 else "rejected",
                "score_available": True, "score": score,
                "accepted": score >= 0.1,
                "private_canary": "MUST_NOT_ENTER_IMPROVER_INPUT"}


def p3_decision(evolution, candidate_id, benchmark, seed):
    plan = evolution.plan_pair(
        candidate_id, benchmark, split="selection", split_role="selection", seed=seed,
        policy=PromotionPolicy(min_quality_delta=0.1, min_success_rate=1.0,
                               max_cost_ratio=1.0, max_regressions=0))
    trial = evolution.run_pair(plan["id"], benchmark)
    decision = evolution.assess(trial["id"])
    assert decision["eligible"] is True
    return decision


def test_meta_protocol_rejects_untrusted_receipt_callbacks(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    with pytest.raises(TypeError, match="trusted TaskMetaExecutor"):
        MetaEvaluationService(tasks.store, lambda request: request, lambda request: request)


def test_active_guard_requires_immutable_plan_closure(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    improvers = ImproverService(tasks)
    benchmark = RecursivePilotBenchmark()
    executor = TaskMetaExecutor(tasks, generation, benchmark)
    ImproverGuardService(
        improvers, executor.generate_offspring, executor.evaluate_descendant)
    improvers.register("recursive", improver_package(), IMPROVER_POLICY)
    active = improvers.active("recursive")
    active["promotion"] = {
        "candidate_id": "forged-candidate",
        "guard_plan_id": "missing-plan",
        "guard_plan_digest": "missing-digest",
    }
    with pytest.raises(ContractError, match="Required host evidence"):
        improvers._verify_active_guard_completion(active)


def test_recursive_improver_closes_meta_evolution_channel_and_guard_loop(tmp_path):
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
    a0, r0 = task_package(), improver_package()
    evolution.register("agent", a0)
    improvers.register("recursive", r0, IMPROVER_POLICY)

    feedback_episode = tasks.create(
        "Observe the common A0 starting behavior", deliverables=result_spec(),
        package_channel="agent",
        context={"split": "development", "split_role": "development"})
    feedback_episode = tasks.run(feedback_episode["id"])
    tasks.evaluate(
        feedback_episode["id"], benchmark,
        benchmark.tasks("development", seed=1)[0], snapshot=benchmark.snapshot())
    feedback = generation.capture_feedback(
        "agent", [feedback_episode["id"]], expected_revision=0)

    # R0 first produces a real task-agent descendant; its paired P3 decision is
    # the feedback that R0 may use to change itself.
    g0 = generation.generate(
        "agent", feedback["id"], None, TASK_POLICY, 0,
        improver_channel="recursive", expected_improver_revision=0)
    assert g0["status"] == "generated"
    assert g0["improver_registration"]["package_id"] == r0["id"]
    d0_decision = p3_decision(evolution, g0["candidate_id"], benchmark, 2)
    r0_feedback = improvers.capture_feedback(
        "recursive", [g0["id"]], [d0_decision["id"]], expected_revision=0)
    r1_generation = improvers.generate_candidate(
        "recursive", r0_feedback["id"], expected_revision=0)
    assert r1_generation["status"] == "generated"
    r1_candidate = improvers.candidate(r1_generation["candidate_id"])
    r1 = tasks.store.package(r1_candidate["package_id"])
    assert r1["parent_id"] == r0["id"] and r1["files"]["improver.py"] == R1_SOURCE
    assert r1_generation["execution"]["package_digest"] == r0["digest"]

    evaluator = {"benchmark_id": benchmark.id, "snapshot": benchmark.snapshot()}
    plan = meta.create_plan(
        candidate_id=r1_candidate["id"], channel="recursive", channel_revision=0,
        task_agent=a0, feedback_bundle=feedback,
        task_channel="agent", task_channel_revision=0,
        task_mutation_policy=TASK_POLICY,
        improvers={"R0": {"id": r0["id"], "digest": r0["digest"]},
                   "R1": {"id": r1["id"], "digest": r1["digest"]}},
        provider="none", model="none", outer_budget=META_BUDGET,
        memory={"kind": "empty"},
        development_tasks=benchmark.tasks("development", seed=3),
        selection_tasks=benchmark.tasks("selection", seed=4), evaluator=evaluator,
        policy=MetaEvaluationPolicy(min_utility_delta=0.3, min_success_rate=1.0,
                                    max_cost_ratio=1.0, max_regressions=0))
    # Public attributes cannot replace the host executor selected at service
    # construction time; dispatch uses the exact trusted class methods.
    meta.generate_offspring = lambda request: {"status": "forged"}
    meta.evaluate_descendant = lambda request: {"status": "forged"}
    trial = meta.run(plan["id"])
    assessment = meta.assess(trial["id"])
    assert trial["measurement_complete"] is True, trial["failures"]
    assert assessment["eligible"] is True
    assert assessment["measurements"]["parent"]["quality"] == 0.4
    assert assessment["measurements"]["candidate"]["quality"] == 0.8
    assert assessment["measurements"]["utility_delta"] == 0.4
    assert {row["arm"] for row in trial["selection_rows"]} == {"R0", "R1"}
    assert trial["usage"]["usage_complete"] is True
    episode_count = len(tasks.list())
    assert meta.run(plan["id"])["id"] == trial["id"]
    assert len(tasks.list()) == episode_count

    decision = improvers.record_decision(r1_candidate["id"], assessment["id"])
    with pytest.raises(ContractError, match="guard|evidence"):
        improvers.promote(r1_candidate["id"], decision["id"], expected_revision=0)
    guard_plan = guards.create_plan(
        candidate_id=r1_candidate["id"], task_agent=a0, feedback_bundle=feedback,
        task_channel="agent", task_channel_revision=0,
        task_mutation_policy=TASK_POLICY, provider="none", model="none",
        outer_budget={**META_BUDGET, "max_nodes": 20}, memory={"kind": "empty"},
        guard_tasks=benchmark.tasks("guard", seed=5), evaluator=evaluator,
        min_mean_utility=0.9, min_success_rate=1.0)
    with pytest.raises(ContractError, match="exact deployed improver"):
        guards.run(guard_plan["id"])
    promoted = improvers.promote(
        r1_candidate["id"], decision["id"], expected_revision=0,
        guard_plan_id=guard_plan["id"])
    assert promoted["revision"] == 1 and promoted["package_id"] == r1["id"]
    with pytest.raises(ContractError, match="guard must complete"):
        improvers._verify_active_guard_completion(promoted)

    # A stale observation cannot take over a claim that the live executor has
    # refreshed.  The decisive lease check happens again inside BEGIN IMMEDIATE.
    guards._claim(guard_plan["id"])
    observed_stale = time.time() - GUARD_CLAIM_LEASE_SECONDS - 1
    with pytest.raises(ContractError, match="lease was refreshed"):
        guards._recover_stale_claim(guard_plan, observed_stale)
    with tasks.store.connect() as db:
        db.execute("DELETE FROM task_improver_guard_claims WHERE plan_id=?",
                   (guard_plan["id"],))

    # A later ordinary generation resolves R1 through the independent R
    # channel.  No caller-supplied R1 package can satisfy this assertion.
    post_promotion = generation.generate(
        "agent", feedback["id"], None, TASK_POLICY, 0,
        improver_channel="recursive", expected_improver_revision=1)
    assert post_promotion["status"] == "generated"
    assert post_promotion["improver_registration"] == {
        "channel": "recursive", "revision": 1,
        "package_id": r1["id"], "package_digest": r1["digest"]}
    assert tasks.get(post_promotion["episode_id"])["execution"]["package_digest"] == r1["digest"]

    # The deployed R1 now performs the same real self-update mechanism and
    # archives R2 without deploying it.
    d1_decision = p3_decision(
        evolution, post_promotion["candidate_id"], benchmark, 6)
    r1_feedback = improvers.capture_feedback(
        "recursive", [post_promotion["id"]], [d1_decision["id"]],
        expected_revision=1)
    r2_generation = improvers.generate_candidate(
        "recursive", r1_feedback["id"], expected_revision=1)
    assert r2_generation["status"] == "generated"
    r2 = tasks.store.package(r2_generation["candidate_package_id"])
    assert r2["parent_id"] == r1["id"] and r2["files"]["improver.py"] == R2_SOURCE
    r2_episode = tasks.get(r2_generation["episode_id"])
    assert r2_generation["execution"]["entry"] == "improve"
    assert r2_generation["execution"]["package_digest"] == r1["digest"]
    assert r2_episode["package_digest"] == r1["digest"]
    assert "improver.py" in r2_episode["execution"]["loaded_modules"]
    assert improvers.active("recursive")["package_id"] == r1["id"]

    # The pre-registered guard runs R1 through the channel, evaluates its real
    # descendant (0.8), and rolls back because the frozen threshold is 0.9.
    guards.generate_offspring = lambda request: {"status": "forged"}
    guards.evaluate_descendant = lambda request: {"status": "forged"}
    action = guards.run(guard_plan["id"])
    assert action["degraded"] is True and action["rolled_back"] is True
    assert action["active_revision_after"] == 2
    assert action["active_package_id_after"] == r0["id"]
    guard_run = guards.run_record(action["run_id"])
    assert guard_run["measurement_complete"] is True
    assert guard_run["mean_utility"] == 0.8
    assert guard_run["generation"]["improver_registration"]["package_id"] == r1["id"]
    guard_episode_count = len(tasks.list())
    assert guards.run(guard_plan["id"])["id"] == action["id"]
    assert len(tasks.list()) == guard_episode_count

    # A recovery probe executes after rollback and proves the channel loads R0,
    # rather than merely observing that the pointer changed.
    recovery = generation.generate(
        "agent", feedback["id"], None, TASK_POLICY, 0,
        improver_channel="recursive", expected_improver_revision=2)
    assert recovery["status"] == "generated"
    assert recovery["improver_registration"]["package_id"] == r0["id"]
    assert tasks.get(recovery["episode_id"])["execution"]["package_digest"] == r0["digest"]
    assert tasks.store.package(recovery["candidate_package_id"])["files"]["behavior.py"] == D0_SOURCE

    evidence = build_recursive_improver_evidence(
        tasks, generation, improvers, meta, guards, channel="recursive",
        improver_feedback_id=r0_feedback["id"],
        improver_generation_id=r1_generation["id"], meta_plan_id=plan["id"],
        meta_trial_id=trial["id"], meta_evaluation_id=assessment["id"],
        improver_decision_id=decision["id"], guard_plan_id=guard_plan["id"],
        guard_action_id=action["id"],
        post_promotion_generation_id=post_promotion["id"],
        next_improver_generation_id=r2_generation["id"],
        recovery_generation_id=recovery["id"])
    body = {key: value for key, value in evidence.items() if key != "integrity_digest"}
    assert evidence["integrity_digest"] == digest(body)
    assert evidence["claim_scope"] == {
        "recursive_mechanism_closed_loop": True,
        "real_model_recursive_benefit_established": False,
        "statistical_rsi_benefit_established": False,
        "claim": "deterministic_recursive_mechanism_only",
    }
    serialized = json.dumps(evidence, ensure_ascii=False)
    assert R0_SOURCE not in serialized and R1_SOURCE not in serialized
    assert "MUST_NOT_ENTER_IMPROVER_INPUT" not in serialized

    before = len(tasks.list())
    with pytest.raises(ContractError, match="either an improver package or an improver channel"):
        generation.generate(
            "agent", feedback["id"], r0, TASK_POLICY, 0,
            improver_channel="recursive", expected_improver_revision=2)
    assert len(tasks.list()) == before
    with pytest.raises(ContractError, match="stale"):
        generation.generate(
            "agent", feedback["id"], None, TASK_POLICY, 0,
            improver_channel="recursive", expected_improver_revision=1)
