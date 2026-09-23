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
from nexgent.tasks.evolution import EvolutionService, PromotionPolicy
from nexgent.tasks.generation import GenerationService
from nexgent.tasks.improver_seed import default_improver_package
from nexgent.tasks.package_patch_v3 import (
    PACKAGE_PATCH_SCHEMA, apply_package_patch,
)
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ContractError, ToolRegistry


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
