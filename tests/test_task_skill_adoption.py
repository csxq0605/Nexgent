"""Task skills enter cross-task evolution only through GenerationService."""

from __future__ import annotations

import json
from pathlib import Path
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from nexgent.tasks.evolution import EvolutionService
from nexgent.tasks.generation import GenerationService
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.task_skill_adoption import TaskSkillAdoptionService
from nexgent.tasks.task_skill_compiler import (
    TASK_SKILL_PROPOSAL_SCHEMA,
    compile_task_skill_proposal,
)
from nexgent.tasks.tools import ContractError, ToolRegistry


def _parent_package():
    workflow = {
        "nodes": [
            {
                "id": "develop", "method": "develop_skill",
                "params": {
                    "proposal": _proposal(),
                    "constraints": {"allowed_rpc_methods": ["read_artifact"],
                                    "allowed_tools": [],
                                    "max_patch_bytes": 300_000},
                },
            },
            {
                "id": "publish", "method": "publish",
                "params": {"name": "result"},
                "bindings": {"content": {"$node": "develop"}},
            },
        ],
        "outputs": {"deliverables": {"result": {"$node": "publish.id"}}},
        "control_edges": [], "revision_rules": [],
    }
    return make_package(
        {
            "agent.py": (
                "def execute(payload, context):\n"
                "    raise RuntimeError('registered workflow must execute')\n"
            ),
            "workflow.json": json.dumps(workflow, sort_keys=True),
        },
        {
            "manifest_version": 2,
            "entries": {"execute": "agent.py:execute"},
            "skills": {}, "roles": {},
            "workflows": {"main": {
                "ref": "workflow.json", "max_parallel": 1,
                "input_schema": {"type": "object"},
                "output_schema": {"type": "object"},
            }},
            "components": {"planner": {
                "class": "O", "kind": "workflow", "ref": "main",
            }},
            "orchestrator": "planner",
        },
        provenance={"fixture": "task-skill-adoption-parent"},
    )


def _proposal(parent=None):
    value = {
        "schema": TASK_SKILL_PROPOSAL_SCHEMA,
        "skill": {
            "name": "candidate_transform", "entrypoint": "solve",
            "source": (
                "def solve(payload, context):\n"
                "    item = context.read_artifact(payload['input_refs']['value'])\n"
                "    return {'answer': item['content'] * 2}\n"
            ),
            "input_schema": {"type": "object"},
            "output_schema": {"type": "object", "required": ["answer"],
                              "properties": {"answer": {"type": "integer"}}},
        },
        "deliverable_name": "result",
        "hypothesis": {
            "failure_mechanism": "the active planner lacks the candidate transform",
            "expected_behavior": "the adopted skill is available to fresh plans",
            "applicability": "fresh tasks that need the same bounded transform",
            "falsifier": "fresh selection does not load the skill or improve outcomes",
        },
    }
    if parent is not None:
        value["parent_package_digest"] = parent["digest"]
    return value


def test_adoption_uses_generation_closure_and_preserves_active_planner(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    parent = _parent_package()
    evolution.register("skills", parent)

    creator = tasks.create(
        "Observe one development task", package_channel="skills",
        deliverables=[{"name": "result", "schema": {"type": "object"}}],
        context={"split": "development", "split_role": "development"},
    )
    creator = tasks.run(creator["id"])
    assert creator["status"] == "completed"
    compiled_events = [event for event in tasks.store.events(creator["id"])
                       if event["kind"] == "task_skill_compiled"]
    assert len(compiled_events) == 1
    scoped = tasks.store.package(compiled_events[0]["content"]["package_id"])
    assert compiled_events[0]["content"]["package_digest"] == scoped["digest"]
    feedback = generation.capture_feedback(
        "skills", [creator["id"]], expected_revision=0)

    manual_proposal = _proposal(parent)
    manual_proposal["skill"]["name"] = "manually_leased_transform"
    manually_leased = compile_task_skill_proposal(
        parent, manual_proposal,
        {"allowed_rpc_methods": ["read_artifact"], "allowed_tools": [],
         "max_patch_bytes": 300_000},
        provenance={"episode_id": creator["id"], "node_id": "manual"},
    )
    tasks.store.lease_task_package(manually_leased, creator["id"])
    with pytest.raises(ContractError, match="durable runtime compilation event"):
        TaskSkillAdoptionService(tasks, evolution, generation).adopt(
            "skills", manually_leased["id"], creator["id"], feedback["id"], 0,
            manual_proposal["hypothesis"],
            budget={"max_model_calls": 0, "max_tool_calls": 0,
                    "max_nodes": 12},
        )

    with pytest.raises(ContractError, match="explicit adoption"):
        evolution.propose(
            "skills", scoped, hypothesis="same-task success",
            feedback_episode_ids=[creator["id"]])

    adopted = TaskSkillAdoptionService(
        tasks, evolution, generation).adopt(
            "skills", scoped["id"], creator["id"], feedback["id"], 0,
            _proposal(parent)["hypothesis"],
            budget={"max_model_calls": 0, "max_tool_calls": 0,
                    "max_nodes": 12},
        )

    generated = adopted["generation"]
    assert generated["status"] == "generated", generated.get("reason")
    candidate = evolution.candidate(generated["candidate_id"])
    package = tasks.store.package(candidate["package_id"])
    adoption = adopted["adoption"]
    assert package["parent_id"] == parent["id"]
    assert tasks.store.is_task_scoped_package(package) is False
    assert package["files"]["workflow.json"] == parent["files"]["workflow.json"]
    assert package["manifest"]["orchestrator"] == parent["manifest"]["orchestrator"]
    assert package["manifest"]["components"][adoption["adopted_component_id"]] == {
        "class": "S", "kind": "skill", "ref": adoption["adopted_skill_name"],
    }
    assert package["manifest"]["skills"][
        adoption["adopted_skill_name"]]["allowed_rpc_methods"] == ["read_artifact"]
    assert package["files"][adoption["adopted_path"]] == (
        scoped["files"]["skills/task_time/candidate_transform.py"])
    closure = evolution._verify_generated_candidate(candidate)
    assert closure["id"] == generated["id"]
    assert evolution.active("skills")["package_id"] == parent["id"]
