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

from nexgent.tasks.multirole_seed import multirole_package
from nexgent.tasks.package_patch_v3 import (
    PACKAGE_PATCH_SCHEMA, apply_package_patch,
)
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
    patch = {
        "schema": PACKAGE_PATCH_SCHEMA,
        "parent_package_digest": parent["digest"],
        "hypothesis": {"failure_mechanism": "second proposal repeats one error",
                       "expected_behavior": "a critic challenges it",
                       "applicability": "tasks with uncertain proposals",
                       "falsifier": "the critic is never exercised",
                       "component_ids": ["main-workflow", "proposer-a-role",
                                         "proposer-b-role", "critic-role"]},
        "activation_targets": ["main-workflow", "proposer-a-role",
                               "proposer-b-role", "critic-role"],
        "operations": [
            {"op": "replace", "component_id": "main-workflow",
             "old_digest": parent["component_digests"]["workflows/main.json"],
             "content": json.dumps(workflow, sort_keys=True)},
            {"op": "replace", "component_id": "proposer-a-role",
             "old_digest": parent["component_digests"]["prompts/proposer_a.md"],
             "content": "Make a proposal with evidence from public inputs."},
            {"op": "remove", "component_id": "proposer-b-role",
             "old_digest": parent["component_digests"]["prompts/proposer_b.md"]},
            {"op": "add", "component_id": "critic-role",
             "path": "prompts/critic.md",
             "content": "Critique the independent proposal from public inputs."},
        ],
        "child_manifest": manifest,
    }
    policy = {
        "mutable_components": ["main-workflow", "proposer-a-role",
                               "proposer-b-role"],
        "allow_add": True, "allow_remove": True,
        "max_patch_bytes": 300000,
        "capability_ceiling": ["ask"], "tool_ceiling": [],
        "max_parallel": 2,
    }
    return patch, policy


class Gateway:
    def __init__(self):
        self.roles = []
        self.lock = threading.Lock()

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
                if role == "adjudicator":
                    assert "proposal_b" in payload
                return {"deliverables": {"result": {"answer": "yes"}}}

        return Bound()


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
