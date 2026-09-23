"""Task-authored skills compile into task-local immutable child packages."""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from nexgent.tasks.runtime import TaskService
from nexgent.tasks.self_orchestration_seed import self_orchestration_package
from nexgent.tasks.evolution import EvolutionService
from nexgent.tasks.packages import make_package
from nexgent.tasks.task_skill_compiler import (
    TASK_SKILL_PROPOSAL_SCHEMA,
    compile_task_skill_proposal,
)
from nexgent.tasks.tools import ContractError, ToolRegistry


def proposal(parent, source=None):
    return {
        "schema": TASK_SKILL_PROPOSAL_SCHEMA,
        "parent_package_digest": parent["digest"],
        "skill": {
            "name": "answer_task",
            "entrypoint": "solve",
            "source": source or (
                "def solve(payload, context):\n"
                "    return {'answer': 'compiled'}\n"
            ),
            "input_schema": {"type": "object"},
            "output_schema": {
                "type": "object",
                "required": ["answer"],
                "properties": {"answer": {"type": "string"}},
            },
        },
        "deliverable_name": "result",
        "hypothesis": {
            "failure_mechanism": "the parent lacks a task-specific transform",
            "expected_behavior": "the child executes the compiled transform",
            "applicability": "tasks requiring this JSON transform",
            "falsifier": "the skill is not loaded or returns invalid output",
        },
    }


def constraints(methods=None, tools=None):
    return {
        "allowed_rpc_methods": list(methods or []),
        "allowed_tools": list(tools or []),
        "max_patch_bytes": 300_000,
    }


def test_compiled_skill_is_executed_by_child_workflow(tmp_path):
    parent = self_orchestration_package()
    original = deepcopy(parent)
    service = TaskService(tmp_path, tools=ToolRegistry())
    creator = service.create(
        "Develop one task-local skill", package=parent,
        budget={"max_model_calls": 0, "max_tool_calls": 0, "max_nodes": 8})
    child = compile_task_skill_proposal(
        parent, proposal(parent), constraints(),
        provenance={"episode_id": creator["id"]})

    assert parent == original
    assert child["parent_id"] == parent["id"]
    assert child["provenance"]["origin"] == "task-time-skill-proposal"
    assert child["provenance"]["task_time_only"] is True
    assert child["provenance"]["promotion_authority"] is False
    skill = child["manifest"]["skills"]["answer_task"]
    assert skill["kind"] == "controlled_code"
    assert skill["allowed_rpc_methods"] == []
    assert skill["allowed_tools"] == []

    workflow_name = child["manifest"]["components"][
        child["manifest"]["orchestrator"]]["ref"]
    workflow_path = child["manifest"]["workflows"][workflow_name]["ref"]
    workflow = json.loads(child["files"][workflow_path])
    assert [node["method"] for node in workflow["nodes"]] == ["skill", "publish"]
    assert workflow["nodes"][0]["component_ref"] == "task-skill-answer_task"

    service.store.lease_task_package(child, creator["id"])
    episode = service.create(
        "Return one result",
        deliverables=[{
            "name": "result",
            "schema": {
                "type": "object",
                "required": ["answer"],
                "properties": {"answer": {"const": "compiled"}},
            },
        }],
        package=child,
        parent_episode_id=creator["id"],
        budget={"max_model_calls": 0, "max_tool_calls": 0, "max_nodes": 8},
    )
    result = service.run(episode["id"])
    assert result["status"] == "completed", result.get("last_error")
    assert service.store.read(result["output_refs"]["result"], episode["id"])[
        "content"] == {"answer": "compiled"}
    assert "skills/task_time/answer_task.py" in result["execution"]["loaded_modules"]


def test_task_authored_package_is_scoped_to_creator_tree_and_not_evolution(tmp_path):
    parent = self_orchestration_package()
    service = TaskService(tmp_path, tools=ToolRegistry())
    creator = service.create("Creator", package=parent)
    outsider = service.create("Independent task", package=parent)
    child = compile_task_skill_proposal(
        parent, proposal(parent), constraints(),
        provenance={"episode_id": creator["id"]})
    with pytest.raises(PermissionError, match="creator-tree lease"):
        service.store.put_package(child)
    service.store.lease_task_package(child, creator["id"])
    provenance_stripped = deepcopy(child)
    provenance_stripped["provenance"] = {"fixture": "stripped-task-scope"}
    with pytest.raises(PermissionError, match="delegated Episode"):
        service.create("Provenance collision reuse", package=provenance_stripped)

    with pytest.raises(PermissionError, match="delegated Episode"):
        service.create("Root reuse", package=child)
    with pytest.raises(PermissionError, match="outside its creator"):
        service.create(
            "Cross-tree reuse", package=child,
            parent_episode_id=outsider["id"])

    descendant = make_package(
        child["files"], child["manifest"], parent=child,
        provenance={"fixture": "task-skill-descendant"})
    service.store.put_package(descendant)
    with pytest.raises(PermissionError, match="delegated Episode"):
        service.create("Descendant reuse", package=descendant)

    evolution = EvolutionService(service)
    evolution.register("task-skill-scope", parent)
    with pytest.raises(ContractError, match="explicit adoption"):
        evolution.propose(
            "task-skill-scope", child, hypothesis="reuse compiled task skill",
            feedback_episode_ids=[creator["id"]])


@pytest.mark.parametrize(("source", "compile_constraints", "declared_methods",
                          "declared_tools", "message"), [
    (
        "def solve(payload, context):\n"
        "    return context.ask('worker', 'solve', payload)\n",
        constraints(["ask"]), [], [], "RPC method 'ask'",
    ),
    (
        "def solve(payload, context):\n"
        "    return context.tool('calculator', {'expression': '2+2'})\n",
        constraints(["tool"], ["calculator"]), ["tool"], ["other"],
        "tool 'calculator'",
    ),
])
def test_controlled_skill_runtime_enforces_declared_ceilings(
        tmp_path, source, compile_constraints, declared_methods,
        declared_tools, message):
    parent = self_orchestration_package()
    service = TaskService(tmp_path, tools=ToolRegistry())
    creator = service.create("Creator", package=parent)
    compiled = compile_task_skill_proposal(
        parent, proposal(parent, source), compile_constraints,
        provenance={"episode_id": creator["id"]})
    manifest = deepcopy(compiled["manifest"])
    declaration = manifest["skills"]["answer_task"]
    declaration["allowed_rpc_methods"] = declared_methods
    declaration["allowed_tools"] = declared_tools
    restricted = make_package(
        compiled["files"], manifest, parent=parent,
        provenance=compiled["provenance"])
    service.store.lease_task_package(restricted, creator["id"])
    episode = service.create(
        "Reject undeclared skill authority", package=restricted,
        parent_episode_id=creator["id"],
        deliverables=[{"name": "result", "schema": {}}])

    result = service.run(episode["id"])

    assert result["status"] == "failed"
    assert message in json.dumps(result, sort_keys=True)


def test_compiler_enforces_rpc_and_literal_tool_ceilings():
    parent = self_orchestration_package()
    tool_source = (
        "def solve(payload, context):\n"
        "    return context.tool('calculator', {'expression': '2+2'})\n"
    )
    with pytest.raises(ContractError, match="outside allowed_tools"):
        compile_task_skill_proposal(
            parent, proposal(parent, tool_source),
            constraints(["tool"], ["other_tool"]))

    child = compile_task_skill_proposal(
        parent, proposal(parent, tool_source),
        constraints(["tool"], ["calculator"]))
    declaration = child["manifest"]["skills"]["answer_task"]
    assert declaration["allowed_rpc_methods"] == ["tool"]
    assert declaration["allowed_tools"] == ["calculator"]
    assert child["provenance"]["observed_rpc_methods"] == ["tool"]
    assert child["provenance"]["observed_tools"] == ["calculator"]


def test_compiler_rejects_context_alias_and_indirect_capabilities():
    parent = self_orchestration_package()
    alias_source = (
        "def solve(payload, context):\n"
        "    agent = context\n"
        "    return agent.ask('worker', 'solve', payload)\n"
    )
    with pytest.raises(ContractError, match="cannot be aliased"):
        compile_task_skill_proposal(
            parent, proposal(parent, alias_source), constraints(["ask"]))

    indirect_source = (
        "def solve(payload, context):\n"
        "    return context.parallel([])\n"
    )
    with pytest.raises(ContractError, match="not directly auditable"):
        compile_task_skill_proposal(
            parent, proposal(parent, indirect_source), constraints())


def test_compiler_requires_a_workflow_orchestrator():
    parent = self_orchestration_package()
    manifest = deepcopy(parent["manifest"])
    manifest["orchestrator"] = "execute-entry"
    manifest["components"]["execute-entry"] = {
        "class": "O", "kind": "entry", "ref": "execute",
    }
    entry_parent = make_package(parent["files"], manifest,
                                provenance={"fixture": "entry-orchestrator"})
    task_proposal = proposal(entry_parent)
    with pytest.raises(ContractError, match="workflow orchestrator"):
        compile_task_skill_proposal(entry_parent, task_proposal, constraints())
