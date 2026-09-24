from copy import deepcopy
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import experiments.p3_e1.pilot as pilot_module
from experiments.p3_e1.pilot import (
    P3E1QualificationBenchmark,
    parent_package as runner_parent_package,
)
from nexgent.kernel.programs import digest
from nexgent.tasks.cycles import RSICycleService
from nexgent.tasks.evidence import (
    build_p3_e1_evidence,
    export_p3_e1_evidence,
)
from nexgent.tasks.evolution import EvolutionService, PromotionPolicy
from nexgent.tasks.generation import GenerationService, PATCH_SCHEMA
from nexgent.tasks.improver_seed import default_improver_package
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ContractError, ToolRegistry
from nexgent.tasks.evolution import host_runtime_fingerprint


PARENT_SOURCE = """def execute(payload, context):
    artifact = context.publish({'version': 0, 'score': 0.0}, name='result')
    return {'deliverables': {'result': artifact['id']}}
"""

CHILD_SOURCE = """def execute(payload, context):
    artifact = context.publish({'version': 1, 'score': 1.0}, name='result')
    return {'deliverables': {'result': artifact['id']}}
"""

NO_OBSERVABLE_CHANGE_SOURCE = """# A loaded source change that preserves the result.
def execute(payload, context):
    artifact = context.publish({'version': 0, 'score': 0.0}, name='result')
    return {'deliverables': {'result': artifact['id']}}
"""

ZERO_GAIN_SOURCE = """def execute(payload, context):
    artifact = context.publish({'version': 1, 'score': 0.0}, name='result')
    return {'deliverables': {'result': artifact['id']}}
"""

PRIVATE_SENTINEL = "PRIVATE_P3_E1_EVALUATOR_CONTENT"
MODEL_OUTPUT_SENTINEL = "PRIVATE_MODEL_OUTPUT_TEXT"


def result_spec():
    return [{"name": "result", "schema": {
        "type": "object", "required": ["version", "score"]}}]


def parent_package():
    return make_package(
        {"behavior.py": PARENT_SOURCE},
        {"entries": {"execute": "behavior.py:execute"}},
        provenance={"fixture": "p3-e1-parent"},
    )


def behavior_patch(parent, child_source):
    return {
        "schema": PATCH_SCHEMA,
        "hypothesis": {
            "failure_mechanism": "The baseline emits the old generic result.",
            "expected_behavior": "The replacement emits the revised generic result.",
            "applicability": "Tasks loading behavior.py.",
            "falsifier": "The component is not loaded or observations stay unchanged.",
        },
        "operations": [{
            "op": "replace",
            "path": "behavior.py",
            "old_digest": parent["component_digests"]["behavior.py"],
            "content": child_source,
        }],
        "activation_probe": {"kind": "component_loaded", "path": "behavior.py"},
    }


def fixed_improver(parent, child_source, *, missing=False):
    if missing:
        source = """def improve(payload, context):
    context.ask('fixed_improver', 'one scripted receipt', {})
    return {'deliverables': {}}
"""
    else:
        source = """def improve(payload, context):
    context.ask('fixed_improver', 'one scripted receipt', {})
    context.read_artifact(payload['input_refs']['feedback_bundle'])
    context.read_artifact(payload['input_refs']['parent_components'])
    context.read_artifact(payload['input_refs']['mutation_policy'])
    artifact = context.publish(PATCH, name='behavior_patch')
    return {'deliverables': {'behavior_patch': artifact['id']}}
""".replace("PATCH", repr(behavior_patch(parent, child_source)))
    return make_package(
        {"improver.py": source},
        {"entries": {"execute": "improver.py:improve",
                     "improve": "improver.py:improve"}},
        provenance={"fixture": "p3-e1-fixed-improver"},
    )


class ReceivedGatewayFactory:
    def __init__(self, response, *, provider_revision=None):
        self.response = deepcopy(response)
        self.provider_revision = provider_revision
        self.calls = 0

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                owner.calls += 1
                call_id = f"p3-e1-model-{owner.calls}"
                started = {
                    "call_id": call_id,
                    "role": role,
                    "model": "SCRIPTED-P3-E1",
                    "provider_model": "scripted-provider-model",
                    "configured_provider_model": "scripted-provider-model",
                    "observed_provider_model": "scripted-provider-model",
                    "provider_revision": owner.provider_revision,
                    "profile_digest": digest("scripted-profile"),
                    "status": "started",
                    "started_at": float(owner.calls),
                    "request_digest": digest({
                        "role": role, "prompt": prompt, "payload": payload}),
                    "reserved_completion_tokens": max_tokens,
                    "max_tokens": max_tokens,
                }
                reserve(started)
                reserve({
                    **started,
                    "status": "received",
                    "billing_status": "usage_reported",
                    "finished_at": float(owner.calls) + 0.5,
                    "usage": {"prompt_tokens": 5, "completion_tokens": 7,
                              "total_tokens": 12},
                    "output_text": MODEL_OUTPUT_SENTINEL,
                    "output": deepcopy(owner.response),
                })
                return deepcopy(owner.response)

        return Gateway()


class QualificationBenchmark:
    id = "p3-e1-test-benchmark"

    def __init__(self, *, guard_score=None):
        self.guard_score = guard_score

    def snapshot(self):
        return {"id": self.id, "version": 1}

    def tasks(self, split="development", seed=0):
        identity = f"p3-e1/{split}/{seed}"
        unit = f"p3-e1-unit/{split}/{seed}"
        cluster = "p3-e1-test-cluster"
        return [{
            "id": identity,
            "statistical_unit_id": unit,
            "cluster_id": cluster,
            "objective": "Publish generic result version=1 and score=1.0",
            "inputs": {"qualification_case": {"split": split, "seed": seed}},
            "deliverables": result_spec(),
            "capabilities": [],
            "context": {"split": split, "split_role": split,
                        "task_identity": identity,
                        "statistical_unit_id": unit,
                        "cluster_id": cluster},
        }]

    def evaluate(self, task_ref, deliverables, execution_view):
        result = deliverables["result"]
        score = float(result["score"])
        if task_ref.get("context", {}).get("split") == "guard" \
                and self.guard_score is not None:
            score = self.guard_score
        return {
            "status": "accepted",
            "score_available": True,
            "score": score,
            "accepted": True,
            "private_evaluator_content": PRIVATE_SENTINEL,
        }


def benchmark_registration(benchmark, task_ref):
    return {"benchmark_id": benchmark.id, "task_ref": deepcopy(task_ref),
            "snapshot": deepcopy(benchmark.snapshot()),
            "host_runtime": host_runtime_fingerprint()}


def prepared(tmp_path, *, child_source=CHILD_SOURCE, missing=False,
             guard_score=None, min_quality_delta=0.5, improver=None):
    parent = parent_package()
    patch = behavior_patch(parent, child_source)
    gateway = ReceivedGatewayFactory(
        {"decision": "abstain"} if missing else patch)
    tasks = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    cycles = RSICycleService(tasks, evolution, generation)
    benchmark = QualificationBenchmark(guard_score=guard_score)
    evolution.register("general", parent)

    development = benchmark.tasks("development", seed=3)[0]
    feedback = tasks.create(
        development["objective"], deliverables=development["deliverables"],
        package_channel="general", context=development["context"],
        benchmark_registration=benchmark_registration(benchmark, development))
    feedback = tasks.run(feedback["id"])
    tasks.evaluate(feedback["id"], benchmark, development,
                   snapshot=benchmark.snapshot())

    cycle = cycles.create(
        channel="general",
        feedback_episode_ids=[feedback["id"]],
        improver_package=(default_improver_package()
                          if improver is None else improver),
        mutation_policy={
            "mutable_paths": ["behavior.py"],
            "component_classes": {"behavior.py": "O"},
            "allowed_operations": ["replace"],
            "max_patch_bytes": 100000,
        },
        expected_revision=0,
        selection_adapter=benchmark,
        guard_adapter=benchmark,
        selection_seed=7,
        guard_seed=11,
        generation_budget={
            "max_model_calls": 1,
            "max_completion_tokens": 6000,
            "max_tool_calls": 0,
            "max_nodes": 16,
        },
        policy=PromotionPolicy(
            min_quality_delta=min_quality_delta,
            monitor_min_score=0.0 if min_quality_delta == 0.0 else 0.5,
            monitor_min_success_rate=1.0,
        ),
    )
    terminal = cycles.run(cycle["id"], benchmark, benchmark)
    return {
        "tasks": tasks,
        "evolution": evolution,
        "generation": generation,
        "cycles": cycles,
        "benchmark": benchmark,
        "parent": parent,
        "feedback": feedback,
        "cycle": terminal,
        "gateway": gateway,
    }


def run_reuse(prepared_state, *, wrong_binding=False, evaluate=True, task_ref=None):
    tasks = prepared_state["tasks"]
    benchmark = prepared_state["benchmark"]
    if task_ref is None:
        task_ref = benchmark.tasks("development", seed=97)[0]
        task_ref["id"] = "p3-e1/reuse/97"
        task_ref["statistical_unit_id"] = "p3-e1-unit/reuse/97"
        task_ref["inputs"] = {"qualification_case": {"split": "reuse", "seed": 97}}
        task_ref["context"]["task_identity"] = task_ref["id"]
        task_ref["context"]["statistical_unit_id"] = task_ref["statistical_unit_id"]
    if wrong_binding:
        state = tasks.create(
            task_ref["objective"], deliverables=task_ref["deliverables"],
            package=prepared_state["parent"], context=task_ref["context"],
            benchmark_registration=benchmark_registration(benchmark, task_ref))
    else:
        state = tasks.create(
            task_ref["objective"], deliverables=task_ref["deliverables"],
            package_channel="general", context=task_ref["context"],
            benchmark_registration=benchmark_registration(benchmark, task_ref))
    state = tasks.run(state["id"])
    if evaluate:
        tasks.evaluate(state["id"], benchmark, task_ref,
                       snapshot=benchmark.snapshot())
        state = tasks.get(state["id"])
    return state


def test_p3_e1_success_export_is_sanitized(tmp_path):
    state = prepared(tmp_path)
    assert state["cycle"]["status"] == "completed"
    assert state["gateway"].calls == 1
    reuse = run_reuse(state)

    evidence = build_p3_e1_evidence(
        state["cycles"], cycle_id=state["cycle"]["id"],
        reuse_episode_ids=[reuse["id"]])
    body = {key: value for key, value in evidence.items()
            if key != "integrity_digest"}
    assert evidence["schema"] == "nexgent.p3-e1-evidence.v1"
    assert evidence["integrity_digest"] == digest(body)
    assert evidence["claim_scope"] == {
        "single_persistent_behavior_instance": True,
        "cross_task_benefit_established": False,
        "statistical_rsi_benefit_established": False,
        "recursive_improver_benefit_established": False,
    }
    assert evidence["selection"]["eligible"] is True
    assert evidence["selection"]["activation_probe"] == {
        "kind": "component_loaded", "path": "behavior.py"}
    assert any(row["observable_change"]
               for row in evidence["selection"]["paired_tasks"])
    assert evidence["guard"]["degraded"] is False
    assert evidence["guard"]["rolled_back"] is False
    assert evidence["reuse"][0]["channel_revision"] == 1
    assert evidence["generation"]["model_receipt"]["status"] == "received"
    assert evidence["generation"]["model_receipt"]["identity_assurance"] == (
        "request_alias_time_window")
    assert evidence["selection"]["strict_gain"]["quality"] == 1.0

    serialized = json.dumps(evidence, ensure_ascii=False)
    assert PRIVATE_SENTINEL not in serialized
    assert MODEL_OUTPUT_SENTINEL not in serialized
    assert PARENT_SOURCE not in serialized
    assert CHILD_SOURCE not in serialized
    assert "feedback_bundle" not in evidence
    assert "private_evaluator_content" not in serialized

    destination = tmp_path / "exports" / "p3-e1.json"
    exported_path = export_p3_e1_evidence(
        destination, state["cycles"], cycle_id=state["cycle"]["id"],
        reuse_episode_ids=[reuse["id"]])
    assert exported_path == str(destination.resolve())
    assert json.loads(destination.read_text(encoding="utf-8")) == evidence


def test_p3_e1_rejects_generation_missing(tmp_path):
    state = prepared(tmp_path, missing=True)
    assert state["cycle"]["status"] == "generation_missing"
    with pytest.raises(ContractError, match="completed RSI cycle"):
        build_p3_e1_evidence(
            state["cycles"], cycle_id=state["cycle"]["id"],
            reuse_episode_ids=[state["feedback"]["id"]])


def test_p3_e1_rejects_loaded_candidate_without_observable_change(tmp_path):
    state = prepared(
        tmp_path, child_source=NO_OBSERVABLE_CHANGE_SOURCE,
        min_quality_delta=0.0)
    assert state["cycle"]["status"] == "completed"
    reuse = run_reuse(state)
    with pytest.raises(ContractError, match="no paired observable behavior change"):
        build_p3_e1_evidence(
            state["cycles"], cycle_id=state["cycle"]["id"],
            reuse_episode_ids=[reuse["id"]])


def test_p3_e1_rejects_guard_rollback(tmp_path):
    state = prepared(tmp_path, guard_score=0.0)
    assert state["cycle"]["status"] == "rolled_back"
    with pytest.raises(ContractError, match="completed RSI cycle"):
        build_p3_e1_evidence(
            state["cycles"], cycle_id=state["cycle"]["id"],
            reuse_episode_ids=[state["feedback"]["id"]])


def test_p3_e1_rejects_reuse_with_wrong_package_binding(tmp_path):
    state = prepared(tmp_path)
    reuse = run_reuse(state, wrong_binding=True)
    with pytest.raises(ContractError, match="requested package channel"):
        build_p3_e1_evidence(
            state["cycles"], cycle_id=state["cycle"]["id"],
            reuse_episode_ids=[reuse["id"]])


def test_p3_e1_rejects_reuse_without_public_evaluation(tmp_path):
    state = prepared(tmp_path)
    reuse = run_reuse(state, evaluate=False)
    with pytest.raises(ContractError, match="evaluation is outside its frozen benchmark"):
        build_p3_e1_evidence(
            state["cycles"], cycle_id=state["cycle"]["id"],
            reuse_episode_ids=[reuse["id"]])


def test_p3_e1_rejects_reuse_of_selection_task_identity(tmp_path):
    state = prepared(tmp_path)
    old_task = state["benchmark"].tasks("selection", seed=7)[0]
    old_task["id"] = "p3-e1/renamed-selection-clone/700"
    old_task["statistical_unit_id"] = "p3-e1-unit/renamed-clone/700"
    old_task["context"]["task_identity"] = old_task["id"]
    old_task["context"]["statistical_unit_id"] = old_task["statistical_unit_id"]
    reuse = run_reuse(state, task_ref=old_task)
    with pytest.raises(ContractError, match="duplicates qualification task content"):
        build_p3_e1_evidence(
            state["cycles"], cycle_id=state["cycle"]["id"],
            reuse_episode_ids=[reuse["id"]])


def test_p3_e1_rejects_unrelated_call_with_hardcoded_patch(tmp_path):
    parent = parent_package()
    state = prepared(
        tmp_path, improver=fixed_improver(parent, CHILD_SOURCE))
    assert state["cycle"]["status"] == "completed"
    reuse = run_reuse(state)
    with pytest.raises(ContractError, match="reference-os-v1"):
        build_p3_e1_evidence(
            state["cycles"], cycle_id=state["cycle"]["id"],
            reuse_episode_ids=[reuse["id"]])


def test_p3_e1_rejects_strict_zero_gain(tmp_path):
    state = prepared(
        tmp_path, child_source=ZERO_GAIN_SOURCE, min_quality_delta=0.0)
    assert state["cycle"]["status"] == "completed"
    reuse = run_reuse(state)
    with pytest.raises(ContractError, match="no strict measured gain"):
        build_p3_e1_evidence(
            state["cycles"], cycle_id=state["cycle"]["id"],
            reuse_episode_ids=[reuse["id"]])


def test_p3_e1_rejects_reuse_from_arbitrary_evaluator(tmp_path):
    state = prepared(tmp_path)
    benchmark = state["benchmark"]
    task_ref = benchmark.tasks("development", seed=98)[0]
    task_ref["id"] = "p3-e1/reuse/98"
    task_ref["statistical_unit_id"] = "p3-e1-unit/reuse/98"
    task_ref["context"].update(
        task_identity=task_ref["id"],
        statistical_unit_id=task_ref["statistical_unit_id"])

    class ArbitraryEvaluator(QualificationBenchmark):
        id = "arbitrary-evaluator"

        def snapshot(self):
            return {"id": self.id, "version": 999}

    arbitrary = ArbitraryEvaluator()
    episode = state["tasks"].create(
        task_ref["objective"], deliverables=task_ref["deliverables"],
        package_channel="general", context=task_ref["context"],
        benchmark_registration=benchmark_registration(arbitrary, task_ref))
    episode = state["tasks"].run(episode["id"])
    state["tasks"].evaluate(
        episode["id"], arbitrary, task_ref, snapshot=arbitrary.snapshot())
    with pytest.raises(ContractError, match="frozen P3 E1 benchmark binding"):
        build_p3_e1_evidence(
            state["cycles"], cycle_id=state["cycle"]["id"],
            reuse_episode_ids=[episode["id"]])


def test_experiment_runner_fixture_exports_with_fake_reference_model(tmp_path):
    """Exercise the real pilot fixture shape without making an external call."""
    parent = runner_parent_package()
    gateway = ReceivedGatewayFactory(behavior_patch(parent, CHILD_SOURCE))
    tasks = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    cycles = RSICycleService(tasks, evolution, generation)
    benchmark = P3E1QualificationBenchmark()
    evolution.register("pilot-smoke", parent)

    for split, seed in (("development", 3), ("selection", 17), ("guard", 23)):
        row = benchmark.task(split, seed)
        assert row["context"]["task_identity"] == row["id"]
        assert row["context"]["statistical_unit_id"] == row["statistical_unit_id"]
    reuse_task = benchmark.reuse_task()
    assert reuse_task["context"]["task_identity"] == reuse_task["id"]

    development = benchmark.task("development", 3)
    feedback = tasks.create(
        development["objective"], development["inputs"],
        development["deliverables"], capabilities=development["capabilities"],
        context=development["context"], package_channel="pilot-smoke",
        benchmark_registration=benchmark_registration(benchmark, development))
    feedback = tasks.run(feedback["id"])
    tasks.evaluate(feedback["id"], benchmark, development,
                   snapshot=benchmark.snapshot())

    cycle = cycles.create(
        channel="pilot-smoke", feedback_episode_ids=[feedback["id"]],
        improver_package=default_improver_package(),
        mutation_policy={
            "mutable_paths": ["behavior.py"],
            "component_classes": {"behavior.py": "O"},
            "allowed_operations": ["replace"],
            "max_patch_bytes": 100000,
        },
        expected_revision=0, selection_adapter=benchmark, guard_adapter=benchmark,
        selection_seed=17, guard_seed=23,
        generation_budget={
            "max_model_calls": 1, "max_completion_tokens": 6000,
            "max_tool_calls": 0, "max_nodes": 16,
        },
        policy=PromotionPolicy(
            min_quality_delta=0.5, monitor_min_score=1.0,
            monitor_min_success_rate=1.0),
    )
    cycle = cycles.run(cycle["id"], benchmark, benchmark)
    assert cycle["status"] == "completed"

    active = evolution.active("pilot-smoke")
    registration = {key: active[key] for key in (
        "channel", "revision", "package_id", "package_digest")}
    reuse = tasks.create(
        reuse_task["objective"], reuse_task["inputs"], reuse_task["deliverables"],
        capabilities=reuse_task["capabilities"], context=reuse_task["context"],
        package_channel="pilot-smoke", expected_package_registration=registration,
        benchmark_registration=benchmark_registration(benchmark, reuse_task))
    reuse = tasks.run(reuse["id"])
    tasks.evaluate(reuse["id"], benchmark, reuse_task, snapshot=benchmark.snapshot())

    destination = tmp_path / "pilot-smoke-evidence.json"
    export_p3_e1_evidence(
        destination, cycles, cycle_id=cycle["id"],
        reuse_episode_ids=[reuse["id"]])
    evidence = json.loads(destination.read_text(encoding="utf-8"))
    assert evidence["schema"] == "nexgent.p3-e1-evidence.v1"
    assert evidence["reuse"][0]["public_evaluation"]["accepted"] is True
    assert gateway.calls == 1


def test_runner_attempts_never_overwrite_prior_receipts(tmp_path, monkeypatch):
    parent = runner_parent_package()
    gateway = ReceivedGatewayFactory(behavior_patch(parent, CHILD_SOURCE))
    real_task_service = TaskService
    monkeypatch.setattr(
        pilot_module, "TaskService",
        lambda root: real_task_service(
            root, tools=ToolRegistry(), gateway_factory=gateway))
    output = tmp_path / "exports"

    first = pilot_module.run_pilot(tmp_path, output)
    assert first["status"] == "completed"
    first_path = Path(first["receipt_path"])
    first_bytes = first_path.read_bytes()

    second = pilot_module.run_pilot(tmp_path, output)
    second_path = Path(second["receipt_path"])
    assert first["attempt_id"] != second["attempt_id"]
    assert first_path != second_path and first_path.read_bytes() == first_bytes
    assert second_path.is_file()
    index = [json.loads(line) for line in
             (output / "attempts.jsonl").read_text(encoding="utf-8").splitlines()]
    assert [row["attempt_id"] for row in index] == [
        first["attempt_id"], second["attempt_id"]]
