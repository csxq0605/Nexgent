"""Atomic O/S package patches must remain executable and bounded."""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import sys
import threading

import pytest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from nexgent.tasks.multirole_seed import PUBLISH_SOURCE, multirole_package
from nexgent.tasks.evolution import EvolutionService, PromotionPolicy, _loaded_evidence
from nexgent.tasks.generation import GenerationService
from nexgent.tasks.improver_seed import default_improver_package
from nexgent.tasks.package_patch_v3 import (
    PACKAGE_PATCH_SCHEMA, PACKAGE_PATCH_SWITCH_SCHEMA, apply_package_patch,
)
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ContractError, ToolRegistry, ToolSpec


def _proposal(parent):
    manifest = deepcopy(parent["manifest"])
    manifest["roles"].pop("proposer_b")
    manifest["components"].pop("proposer-b-role")
    manifest["roles"]["critic"] = {
        "prompt_ref": "prompts/critic.md", "capabilities": ["ask"]}
    manifest["components"]["critic-role"] = {
        "class": "S", "kind": "role", "ref": "critic"}
    workflow = json.loads(parent["files"]["workflows/main.json"])
    workflow["nodes"] = [node for node in workflow["nodes"]
                         if node["id"] != "proposer_b"]
    workflow["nodes"].insert(2, {
        "id": "critic", "method": "ask", "role_ref": "critic",
        "component_ref": "critic-role", "params": {"max_tokens": 1600},
        "bindings": {"payload": {"task": {"$node": "prepare"}}},
    })
    adjudicator = next(node for node in workflow["nodes"]
                       if node["id"] == "adjudicator")
    adjudicator["bindings"]["payload"]["proposal_b"] = {"$node": "critic"}
    publish_source = parent["files"]["skills/publish.py"].replace(
        '    required = [item["name"] for item in task["deliverables"]]',
        '    if set(decision) == {"result"} and isinstance(decision["result"], dict) '
        'and "deliverables" in decision["result"]:\n'
        '        decision = decision["result"]\n'
        '    required = [item["name"] for item in task["deliverables"]]')
    patch = {
        "schema": PACKAGE_PATCH_SCHEMA,
        "parent_package_digest": parent["digest"],
        "hypothesis": {"failure_mechanism": "second proposal repeats one error",
                       "expected_behavior": "a critic challenges it",
                       "applicability": "tasks with uncertain proposals",
                       "falsifier": "the critic is never exercised",
                       "component_ids": ["main-workflow", "publish-skill",
                                         "proposer-a-role", "proposer-b-role", "critic-role"]},
        "activation_targets": ["main-workflow", "proposer-a-role",
                               "proposer-b-role", "critic-role", "publish-skill"],
        "operations": [
            {"op": "replace", "component_id": "main-workflow",
             "old_digest": parent["component_digests"]["workflows/main.json"],
             "content": json.dumps(workflow, sort_keys=True)},
            {"op": "replace", "component_id": "proposer-a-role",
             "old_digest": parent["component_digests"]["prompts/proposer_a.md"],
             "content": "Make a proposal with evidence from public inputs."},
            {"op": "replace", "component_id": "publish-skill",
             "old_digest": parent["component_digests"]["skills/publish.py"],
             "content": publish_source},
            {"op": "remove", "component_id": "proposer-b-role",
             "old_digest": parent["component_digests"]["prompts/proposer_b.md"]},
            {"op": "add", "component_id": "critic-role",
             "path": "prompts/critic.md",
             "content": "Critique the independent proposal from public inputs."},
        ],
        "child_manifest": manifest,
    }
    policy = {
        "mutable_components": ["main-workflow", "publish-skill",
                               "proposer-a-role", "proposer-b-role"],
        "allow_add": True, "allow_remove": True,
        "max_patch_bytes": 300000,
        "capability_ceiling": ["ask"], "tool_ceiling": [],
        "max_parallel": 2,
    }
    return patch, policy


def _compact(parent, patch):
    proposal = deepcopy(patch)
    child = proposal.pop("child_manifest")
    proposal["schema"] = "nexgent.package-patch-proposal.v1"
    registries = ("entries", "roles", "workflows", "skills", "components")
    proposal["manifest_delta"] = {
        "set": {name: {identity: value for identity, value in child[name].items()
                        if parent["manifest"][name].get(identity) != value}
                for name in registries},
        "remove": {name: sorted(set(parent["manifest"][name]) - set(child[name]))
                   for name in registries},
    }
    return proposal


class Gateway:
    def __init__(self, patch=None):
        self.roles = []
        self.lock = threading.Lock()
        self.patch = patch

    def __call__(self, reserve, stop_event):
        owner = self

        class Bound:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                with owner.lock:
                    owner.roles.append(role)
                    identity = f"v3-{len(owner.roles)}"
                record = {"call_id": identity, "role": role, "model": "V3-DOUBLE",
                          "status": "started", "reserved_completion_tokens": max_tokens}
                reserve(record)
                reserve({**record, "status": "completed",
                         "billing_status": "usage_reported",
                         "usage": {"prompt_tokens": 1, "completion_tokens": 1,
                                   "total_tokens": 2}})
                if role == "rsi_improver":
                    return deepcopy(owner.patch)
                if role == "adjudicator":
                    assert "proposal_b" in payload
                return {"deliverables": {"result": {"answer": "yes"}}}

        return Bound()


def _candidate_with_observed_publisher_edit(parent):
    old = '''        if set(decision) == {name} and (
                not expected_object or isinstance(decision[name], dict)):
            contents = {name: decision[name]}
        else:
            contents = {name: decision}
'''
    new = '''        if name in decision:
            contents = {name: decision[name]}
        elif not expected_object or set(decision) - {"rationale"}:
            contents = {name: decision}
        else:
            stripped = {k: v for k, v in decision.items() if k != "rationale"}
            contents = {name: stripped if stripped else decision}
'''
    assert old in PUBLISH_SOURCE
    files = deepcopy(parent["files"])
    files["skills/publish.py"] = PUBLISH_SOURCE.replace(old, new)
    return make_package(files, deepcopy(parent["manifest"]),
                        provenance={"fixture": "observed-r0-publisher-edit"})


class FixedDecisionGateway:
    def __init__(self, decision):
        self.decision = deepcopy(decision)
        self.calls = 0

    def __call__(self, reserve, stop_event):
        owner = self

        class Bound:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                owner.calls += 1
                record = {"call_id": f"fixed-{owner.calls}", "role": role,
                          "model": "FIXED-DECISION", "status": "started",
                          "reserved_completion_tokens": max_tokens}
                reserve(record)
                reserve({**record, "status": "completed",
                         "billing_status": "usage_reported",
                         "usage": {"prompt_tokens": 1, "completion_tokens": 1,
                                   "total_tokens": 2}})
                if role == "adjudicator":
                    return deepcopy(owner.decision)
                return {"proposal": role}

        return Bound()


def _run_fixed_decision(root, package, decision):
    gateway = FixedDecisionGateway(decision)
    tasks = TaskService(root, tools=ToolRegistry(), gateway_factory=gateway)
    episode = tasks.create(
        "Publish one schema-bound result",
        deliverables=[{"name": "result", "schema": {
            "type": "object", "additionalProperties": False,
            "required": ["result"],
            "properties": {"result": {"type": "string"}}}}],
        package=package,
        budget={"max_model_calls": 3, "max_completion_tokens": 4800,
                "max_tool_calls": 0, "max_nodes": 30})
    return tasks, tasks.run(episode["id"])


def test_publisher_counterfactual_separates_shared_shape_failure_from_edit(tmp_path):
    parent = multirole_package()
    candidate = _candidate_with_observed_publisher_edit(parent)

    # This is the shape observed in both rejected candidate selection Episodes.
    # It bypasses the edited fallback, so both package versions reject the same
    # scalar value for an object-schema deliverable.
    observed = {"deliverables": {"result": "scalar"}}
    _, parent_observed = _run_fixed_decision(tmp_path / "parent-observed", parent,
                                             observed)
    _, candidate_observed = _run_fixed_decision(
        tmp_path / "candidate-observed", candidate, observed)
    assert parent_observed["status"] == "failed"
    assert candidate_observed["status"] == "failed"
    assert "is not of type 'object'" in parent_observed["nodes"][
        "plan/nodes/publish"]["error"]
    assert "is not of type 'object'" in candidate_observed["nodes"][
        "plan/nodes/publish"]["error"]

    # The edit does have a latent effect for a different top-level shape: the
    # parent preserves the object, while the candidate unwraps it to a scalar.
    top_level = {"result": "scalar"}
    parent_tasks, parent_top = _run_fixed_decision(
        tmp_path / "parent-top", parent, top_level)
    _, candidate_top = _run_fixed_decision(
        tmp_path / "candidate-top", candidate, top_level)
    assert parent_top["status"] == "completed"
    assert parent_tasks.store.read(
        parent_top["output_refs"]["result"], parent_top["id"])["content"] == top_level
    assert candidate_top["status"] == "failed"


def test_atomic_add_replace_remove_component_set_executes(tmp_path):
    parent = multirole_package()
    patch, policy = _proposal(parent)
    child = apply_package_patch(parent, patch, policy,
                                provenance={"origin": "generated-test"})
    assert child["parent_id"] == parent["id"]
    assert child["manifest"]["components"]["critic-role"]["class"] == "S"
    assert "prompts/critic.md" in child["files"]
    assert "prompts/proposer_b.md" not in child["files"]

    gateway = Gateway()
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    service.store.put_package(parent)
    episode = service.create(
        "Answer a public question", inputs={"question": {"text": "2+2=4?"}},
        deliverables=[{"name": "result", "schema": {"type": "object",
                       "required": ["answer"], "properties": {
                           "answer": {"type": "string"}}}}],
        package=child,
        budget={"max_model_calls": 3, "max_completion_tokens": 4800,
                "max_tool_calls": 0, "max_nodes": 30},
    )
    result = service.run(episode["id"])
    assert result["status"] == "completed", result.get("last_error")
    assert set(gateway.roles) == {"proposer_a", "critic", "adjudicator"}
    assert result["usage"]["model_calls"] == 3


def test_generated_component_set_has_real_selection_activation(tmp_path):
    parent = multirole_package()
    patch, policy = _proposal(parent)
    gateway = Gateway(_compact(parent, patch))
    tasks = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    evolution = EvolutionService(tasks)
    evolution.register("general", parent)
    deliverables = [{"name": "result", "schema": {"type": "object",
                    "required": ["answer"], "properties": {
                        "answer": {"type": "string"}}}}]
    observed = tasks.create(
        "Answer a public question", inputs={"question": {"text": "yes?"}},
        deliverables=deliverables, package=parent,
        context={"split": "development", "split_role": "development"},
        budget={"max_model_calls": 3, "max_completion_tokens": 4800,
                "max_tool_calls": 0, "max_nodes": 30})
    assert tasks.run(observed["id"])["status"] == "completed"
    generation = GenerationService(tasks, evolution)
    bundle = generation.capture_feedback("general", [observed["id"]], 0)
    generated = generation.generate(
        "general", bundle["id"], default_improver_package(),
        {"patch_contract": PACKAGE_PATCH_SCHEMA, **policy}, 0,
        budget={"max_model_calls": 1, "max_completion_tokens": 6000,
                "max_tool_calls": 0, "max_nodes": 12})
    assert generated["status"] == "generated", generated.get("reason")
    candidate = evolution.candidate(generated["candidate_id"])
    assert candidate["targeting"] == "manifest_component_set_v3"
    assert candidate["component_target"]["component_ids"] == patch["activation_targets"]

    class YesBenchmark:
        id = "component-set-selection"

        def snapshot(self):
            return {"id": self.id, "version": 1, "evaluator_digest": "yes-v1"}

        def tasks(self, split="selection", seed=0):
            return [{"id": "selection/yes", "objective": "Answer a public question",
                     "inputs": {"question": {"text": "yes?"}},
                     "deliverables": deliverables, "capabilities": [],
                     "context": {"split": split, "split_role": split}}]

        def evaluate(self, task_ref, outputs, execution_view):
            return {"status": "accepted", "accepted": True,
                    "score_available": True,
                    "score": 1.0 if outputs["result"]["answer"] == "yes" else 0.0}

    adapter = YesBenchmark()
    plan = evolution.plan_pair(
        candidate["id"], adapter, split="selection", split_role="selection",
        budget={"max_model_calls": 3, "max_completion_tokens": 4800,
                "max_tool_calls": 0, "max_nodes": 30},
        policy=PromotionPolicy(max_cost_ratio=2))
    trial = evolution.run_pair(plan["id"], adapter)
    evidence = trial["pairs"][0]["candidate"]["loaded_evidence"]
    assert evidence["loaded"] is True
    assert {row["component_id"] for row in evidence["members"]} == set(
        patch["activation_targets"])
    assert next(row for row in evidence["members"]
                if row["operation"] == "remove")["absent"] is True
    decision = evolution.assess(trial["id"])
    assert decision["gates"]["behavior_activated"] is True
    assert decision["eligible"] is True
    guard_plan = evolution.plan_monitor(
        candidate["id"], adapter, split="guard",
        budget={"max_model_calls": 3, "max_completion_tokens": 4800,
                "max_tool_calls": 0, "max_nodes": 30})
    active = evolution.promote(candidate["id"], decision["id"],
                               monitor_plan_id=guard_plan["id"])
    assert active["package_id"] == candidate["package_id"]
    guard = evolution.run_monitor(
        "general", adapter, expected_revision=active["revision"],
        expected_package_id=active["package_id"],
        expected_monitor_plan_id=guard_plan["id"])
    assert guard["reports"][0]["loaded_evidence"]["loaded"] is True
    monitored = evolution.monitor(
        "general", guard["episode_ids"], expected_revision=active["revision"],
        expected_package_id=active["package_id"],
        expected_monitor_plan_id=guard_plan["id"])
    assert monitored["degraded"] is False


@pytest.mark.parametrize("damage", ["forged_digest", "missing_add", "hidden_path",
                                   "capability_escalation", "dangling_role",
                                   "missing_activation", "undeclared_registry",
                                   "memory_mixing", "improver_entry"])
def test_atomic_patch_rejects_partial_or_unauthorized_changes(damage):
    parent = multirole_package()
    patch, policy = _proposal(parent)
    if damage == "forged_digest":
        patch["operations"][0]["old_digest"] = "0" * 64
    elif damage == "missing_add":
        patch["operations"].pop()
    elif damage == "hidden_path":
        patch["child_manifest"]["roles"]["critic"]["prompt_ref"] = (
            "prompts/hidden-critic.md")
        patch["operations"][-1]["path"] = "prompts/hidden-critic.md"
    elif damage == "capability_escalation":
        patch["child_manifest"]["roles"]["critic"]["capabilities"] = ["ask", "tool"]
    elif damage == "missing_activation":
        patch["activation_targets"].remove("critic-role")
    elif damage == "undeclared_registry":
        patch["child_manifest"]["roles"]["adjudicator"]["capabilities"] = []
    elif damage == "memory_mixing":
        patch["child_manifest"]["components"]["critic-role"]["class"] = "M"
    elif damage == "improver_entry":
        patch["child_manifest"]["entries"]["improve"] = "agent/main.py:execute"
    else:
        patch["child_manifest"]["roles"].pop("critic")
    with pytest.raises(ContractError):
        apply_package_patch(parent, patch, policy, provenance={"origin": "test"})


def _strategy_source(kind, revision):
    if kind == "entry":
        return (
            "def execute(payload, context):\n"
            f"    result = context.tool('switch.publish', {{'answer': 'entry-{revision}'}})\n"
            "    return {'deliverables': {'result': result['artifact_id']}}\n")
    workflow = {
        "nodes": [{"id": "publish", "method": "tool",
                   "params": {"name": "switch.publish",
                              "arguments": {"answer": f"workflow-{revision}"}}}],
        "outputs": {"deliverables": {"result": {"$node": "publish.artifact_id"}},
                    "summary": f"workflow-{revision}"},
    }
    return json.dumps(workflow, sort_keys=True)


def _switch_package(active_kind):
    manifest = {
        "manifest_version": 2,
        "entries": {"execute": "agent/main.py:execute"},
        "roles": {}, "skills": {},
        "workflows": {"main": {"ref": "workflows/main.json", "max_parallel": 1,
                                 "input_schema": {"type": "object"},
                                 "output_schema": {"type": "object"}}},
        "components": {
            "entry-strategy": {"class": "O", "kind": "entry", "ref": "execute"},
            "workflow-strategy": {"class": "O", "kind": "workflow", "ref": "main"},
        },
        "orchestrator": f"{active_kind}-strategy",
    }
    return make_package({"agent/main.py": _strategy_source("entry", "parent"),
                         "workflows/main.json": _strategy_source("workflow", "parent")},
                        manifest, provenance={"fixture": "switch-parent"})


def _switch_patch(parent, target_kind):
    manifest = deepcopy(parent["manifest"])
    manifest["orchestrator"] = f"{target_kind}-strategy"
    patch = {
        "schema": PACKAGE_PATCH_SWITCH_SCHEMA,
        "parent_package_digest": parent["digest"],
        "hypothesis": {
            "failure_mechanism": "the old backend is unsuitable",
            "expected_behavior": "the other backend publishes the result",
            "applicability": "tasks admitted to the frozen switch fixture",
            "falsifier": "the selected backend or source identity is not executed",
            "component_ids": ["entry-strategy", "workflow-strategy"],
        },
        "operations": [
            {"op": "replace", "component_id": "entry-strategy",
             "old_digest": parent["component_digests"]["agent/main.py"],
             "content": _strategy_source("entry", "candidate")},
            {"op": "replace", "component_id": "workflow-strategy",
             "old_digest": parent["component_digests"]["workflows/main.json"],
             "content": _strategy_source("workflow", "candidate")},
        ],
        "child_manifest": manifest,
        "activation_targets": [f"{target_kind}-strategy"],
    }
    policy = {
        "mutable_components": ["entry-strategy", "workflow-strategy"],
        "allow_add": False, "allow_remove": False, "max_patch_bytes": 100000,
        "capability_ceiling": [], "tool_ceiling": ["switch.publish"],
        "max_parallel": 1,
    }
    return patch, policy


@pytest.mark.parametrize(("parent_kind", "target_kind"), [
    ("workflow", "entry"), ("entry", "workflow"),
])
def test_v4_cross_backend_switch_activates_only_the_executed_strategy(
        tmp_path, parent_kind, target_kind):
    def publish(arguments, context):
        artifact = context.publish({"answer": arguments["answer"]}, name="result")
        return {"artifact_id": artifact["id"]}

    tool = ToolSpec("switch.publish", {"type": "object"}, {"type": "object"},
                    "artifact_write", publish)
    tasks = TaskService(tmp_path, tools=ToolRegistry([tool]))
    evolution = EvolutionService(tasks)
    parent = _switch_package(parent_kind)
    evolution.register("switch", parent)
    deliverables = [{"name": "result", "schema": {
        "type": "object", "required": ["answer"],
        "properties": {"answer": {"type": "string"}}}}]
    budget = {"max_model_calls": 0, "max_completion_tokens": 100,
              "max_tool_calls": 2, "max_nodes": 10}
    observed = tasks.create(
        "Exercise the original backend", deliverables=deliverables,
        capabilities=[tool.name], package=parent,
        context={"split": "development", "split_role": "development"},
        constraints={"allowed_effects": ["artifact_write"]}, budget=budget)
    assert tasks.run(observed["id"])["status"] == "completed"

    patch, policy = _switch_patch(parent, target_kind)
    child = apply_package_patch(parent, patch, policy,
                                provenance={"origin": "switch-test"})
    candidate = evolution.propose(
        "switch", child, hypothesis=patch["hypothesis"],
        feedback_episode_ids=[observed["id"]],
        activation_probe={"kind": "component_set_loaded",
                          "component_ids": patch["activation_targets"]},
        origin="imported", package_patch=patch, mutation_policy=policy)
    assert candidate["targeting"] == "manifest_component_set_v4"

    class SwitchBenchmark:
        id = "backend-switch"

        def snapshot(self):
            return {"id": self.id, "version": 1,
                    "evaluator_digest": "backend-switch-v1"}

        def tasks(self, split="selection", seed=0):
            return [{"id": "selection/switch", "objective": "Run the selected backend",
                     "inputs": {}, "deliverables": deliverables,
                     "capabilities": [tool.name],
                     "constraints": {"allowed_effects": ["artifact_write"]},
                     "context": {"split": split, "split_role": split}}]

        def evaluate(self, task_ref, outputs, execution_view):
            return {"status": "accepted", "accepted": True,
                    "score_available": True, "score": 1.0}

    plan = evolution.plan_pair(
        candidate["id"], SwitchBenchmark(), split="selection",
        split_role="selection", budget=budget,
        policy=PromotionPolicy(max_cost_ratio=2))
    trial = evolution.run_pair(plan["id"], SwitchBenchmark())
    candidate_run = trial["pairs"][0]["candidate"]
    evidence = candidate_run["loaded_evidence"]
    execution = candidate_run["execution"]
    expected_component = f"{target_kind}-strategy"
    old_path = ("workflows/main.json" if parent_kind == "workflow"
                else "agent/main.py")
    assert evidence["loaded"] is True
    assert evidence["component_ids"] == [expected_component]
    assert set(evidence["changed_component_ids"]) == {
        "entry-strategy", "workflow-strategy"}
    assert [row["component_id"] for row in evidence["members"]] == [
        expected_component]
    assert old_path not in execution["loaded_modules"]
    assert execution["active_strategy"]["component_id"] == expected_component
    assert execution["active_strategy"]["kind"] == target_kind
    assert execution["active_strategy"]["source_digest"] == child[
        "component_digests"][execution["active_strategy"]["source_path"]]
    entered = [event for event in tasks.get(candidate_run["episode_id"])["events"]
               if event["kind"] == "strategy_entered"]
    assert entered[-1]["content"]["backend"] == execution["kind"]

    tampered = deepcopy(execution)
    tampered["active_strategy"]["source_digest"] = "0" * 64
    assert _loaded_evidence(
        candidate["component_target"], tampered, child)["loaded"] is False
    tampered = deepcopy(execution)
    tampered["kind"] = ("executable_plan" if target_kind == "entry"
                        else "controlled_code")
    assert _loaded_evidence(
        candidate["component_target"], tampered, child)["loaded"] is False


def test_v4_switch_rejects_empty_activation_and_v3_keeps_legacy_equality():
    parent = _switch_package("workflow")
    patch, policy = _switch_patch(parent, "entry")
    patch["activation_targets"] = []
    with pytest.raises(ContractError, match="v4"):
        apply_package_patch(parent, patch, policy, provenance={"origin": "test"})
    patch, policy = _switch_patch(parent, "entry")
    patch["schema"] = PACKAGE_PATCH_SCHEMA
    with pytest.raises(ContractError, match="v3 activation"):
        apply_package_patch(parent, patch, policy, provenance={"origin": "test"})


def test_v4_switch_rejects_a_changed_component_omitted_from_activation():
    parent = _switch_package("workflow")
    patch, policy = _switch_patch(parent, "entry")
    patch["child_manifest"]["components"]["dormant-support"] = {
        "class": "S", "kind": "resource", "ref": "support/dormant.txt"}
    patch["operations"].append({
        "op": "add", "component_id": "dormant-support",
        "path": "support/dormant.txt", "content": "unexercised change"})
    patch["hypothesis"]["component_ids"].append("dormant-support")
    policy["allow_add"] = True

    with pytest.raises(ContractError, match="activate every changed component"):
        apply_package_patch(parent, patch, policy, provenance={"origin": "test"})
