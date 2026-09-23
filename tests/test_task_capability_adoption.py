"""Task-created tools and services must earn portable package reuse."""

from copy import deepcopy
import threading

import pytest

from nexgent.tasks.capability_authority import make_episode_authority
from nexgent.tasks.evolution import EvolutionService, PromotionPolicy
from nexgent.tasks.generation import GenerationService
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.self_orchestration_seed import self_orchestration_package
from nexgent.tasks.task_capability_adoption import TaskCapabilityAdoptionService
from nexgent.tasks.tools import ContractError, ToolRegistry


RESULT_SPEC = [{
    "name": "result",
    "schema": {
        "type": "object",
        "required": ["answer"],
        "properties": {"answer": {"type": "integer"}},
        "additionalProperties": False,
    },
}]

HYPOTHESIS = {
    "failure_mechanism": "the active package lacks a reusable bounded transform",
    "expected_behavior": "fresh tasks activate the adopted component and return 42",
    "applicability": "tasks that need the same pure capability contract",
    "falsifier": "selection or guard does not activate the component and improve quality",
}


def _tool_proposal():
    return {
        "name": "task.double",
        "description": "Double one integer with pure local computation.",
        "source": (
            "def execute(payload, context):\n"
            "    return {'answer': payload['value'] * 2}\n"
        ),
        "input_schema": {
            "type": "object", "required": ["value"],
            "properties": {"value": {"type": "integer"}},
            "additionalProperties": False,
        },
        "output_schema": deepcopy(RESULT_SPEC[0]["schema"]),
    }


def _service_proposal():
    return {
        "name": "context.answer_hint",
        "description": "Add one bounded reusable hint to model-visible context.",
        "source": (
            "def provide(payload, context):\n"
            "    visible = payload['payload'].copy()\n"
            "    visible['portable_answer_hint'] = 42\n"
            "    return {'payload': visible, 'annotations': "
            "{'source': 'context.answer_hint'}}\n"
        ),
    }


def _proposal(operations):
    return {"proposal": {
        "replaced_node_ids": ["slot"],
        "operations": [
            {"op": "remove_node", "node_id": "slot"},
            *operations,
        ],
        "outputs": {"deliverables": {"result": {"$node": "publish.id"}}},
        "revision_rules": [],
    }}


def _baseline_graph(answer=0):
    return _proposal([
        {"op": "add_node", "node": {
            "id": "publish", "method": "publish",
            "params": {"name": "result", "content": {"answer": answer}},
        }},
        {"op": "add_control_edge", "edge": {
            "from": "architect", "to": "publish",
        }},
    ])


def _creator_tool_graph(*, use=True):
    operations = [
        {"op": "add_node", "node": {
            "id": "develop", "method": "develop_tool",
            "params": {"proposal": _tool_proposal()},
        }},
    ]
    if use:
        operations.extend([
            {"op": "add_node", "node": {
                "id": "calculate", "method": "tool",
                "params": {"arguments": {"value": 21}},
                "bindings": {"name": {"$node": "develop.name"}},
            }},
            {"op": "add_node", "node": {
                "id": "publish", "method": "publish",
                "params": {"name": "result"},
                "bindings": {"content": {"$node": "calculate"}},
            }},
        ])
    else:
        operations.append({"op": "add_node", "node": {
            "id": "publish", "method": "publish",
            "params": {"name": "result", "content": {"answer": 0}},
        }})
    operations.append({"op": "add_control_edge", "edge": {
        "from": "architect", "to": "develop",
    }})
    if not use:
        operations.append({"op": "add_control_edge", "edge": {
            "from": "develop", "to": "publish",
        }})
    return _proposal(operations)


def _creator_service_graph():
    return _proposal([
        {"op": "add_node", "node": {
            "id": "develop", "method": "develop_service",
            "params": {"proposal": _service_proposal()},
        }},
        {"op": "add_node", "node": {
            "id": "activate", "method": "activate_service",
            "params": {"expected_revision": 0},
            "bindings": {"definition_id": {"$node": "develop.definition_id"}},
        }},
        {"op": "add_node", "node": {
            "id": "worker", "method": "ask", "role_ref": "generalist",
            "component_ref": "generalist-role",
            "params": {"max_tokens": 100, "prompt": "Return the supplied hint."},
            "bindings": {"payload": {"request": "return the hint"}},
        }},
        {"op": "add_node", "node": {
            "id": "publish", "method": "publish", "params": {"name": "result"},
            "bindings": {"content": {"$node": "worker"}},
        }},
        {"op": "add_control_edge", "edge": {
            "from": "architect", "to": "develop",
        }},
        {"op": "add_control_edge", "edge": {
            "from": "activate", "to": "worker",
        }},
    ])


def _portable_tool_graph(component_ref):
    return _proposal([
        {"op": "add_node", "node": {
            "id": "calculate", "method": "tool",
            "component_ref": component_ref,
            "params": {"name": "task.double", "arguments": {"value": 21}},
        }},
        {"op": "add_node", "node": {
            "id": "publish", "method": "publish", "params": {"name": "result"},
            "bindings": {"content": {"$node": "calculate"}},
        }},
        {"op": "add_control_edge", "edge": {
            "from": "architect", "to": "calculate",
        }},
    ])


class AdoptionGateway:
    """Deterministic model boundary; package contents still run in the real worker."""

    def __init__(self):
        self.calls = []
        self.lock = threading.Lock()

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                with owner.lock:
                    number = len(owner.calls) + 1
                    owner.calls.append({
                        "role": role, "prompt": prompt,
                        "payload": deepcopy(payload),
                    })
                receipt = {
                    "call_id": f"task-capability-adoption-{number}",
                    "role": role, "model": "TASK-CAPABILITY-ADOPTION-DOUBLE",
                    "status": "started", "max_tokens": max_tokens,
                    "reserved_completion_tokens": max_tokens,
                }
                reserve(receipt)
                if role == "generalist":
                    result = {"answer": payload["portable_answer_hint"]}
                else:
                    objective = payload["task"]["objective"]
                    if objective.startswith("Create and use one task-local tool"):
                        result = _creator_tool_graph(use=True)
                    elif objective.startswith("Create but do not use one task-local tool"):
                        result = _creator_tool_graph(use=False)
                    elif objective.startswith("Create and use one task-local service"):
                        result = _creator_service_graph()
                    else:
                        package_tools = [
                            tool for tool in payload["task"].get("tools", [])
                            if tool.get("name") == "task.double"
                            and tool.get("source") == "agent_package"
                        ]
                        if package_tools:
                            result = _portable_tool_graph(
                                package_tools[0]["component_ref"])
                        elif payload.get("portable_answer_hint") == 42:
                            result = _baseline_graph(answer=42)
                        else:
                            result = _baseline_graph(answer=0)
                reserve({
                    **receipt, "status": "completed",
                    "billing_status": "usage_reported",
                    "usage": {"prompt_tokens": 3, "completion_tokens": 4,
                              "total_tokens": 7},
                })
                return deepcopy(result)

        return Gateway()


class PortableCapabilityBenchmark:
    id = "portable-task-capability"

    def snapshot(self):
        return {"id": self.id, "evaluator_digest": "portable-capability-v1"}

    def describe(self):
        return {"id": self.id, "kind": "host-private-deterministic"}

    def tasks(self, split="development", seed=0):
        return [{
            "id": f"{split}/{seed}/portable",
            "objective": f"Solve a fresh {split} task using reusable capabilities",
            "inputs": {}, "deliverables": deepcopy(RESULT_SPEC),
            "capabilities": [], "context": {"split": split},
        }]

    def evaluate(self, task_ref, deliverables, execution_view):
        accepted = deliverables["result"]["answer"] == 42
        return {"status": "accepted", "score_available": True,
                "accepted": accepted, "score": 1.0 if accepted else 0.0}


def _system(tmp_path):
    gateway = AdoptionGateway()
    tasks = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    adoption = TaskCapabilityAdoptionService(tasks, evolution, generation)
    parent = self_orchestration_package()
    evolution.register("portable", parent)
    return gateway, tasks, evolution, generation, adoption, parent


def _creator(tasks, kind, *, use=True):
    if kind == "tool":
        objective = ("Create and use one task-local tool from development feedback"
                     if use else
                     "Create but do not use one task-local tool from development feedback")
        authority = make_episode_authority(
            ["tool"], ["local_compute"], max_definitions=2, max_invocations=3)
    else:
        objective = "Create and use one task-local service from development feedback"
        authority = make_episode_authority(
            ["service_provider"], ["model_context"],
            max_definitions=2, max_invocations=4, version=2)
    episode = tasks.create(
        objective, deliverables=deepcopy(RESULT_SPEC), package_channel="portable",
        context={"split": "development", "split_role": "development"},
        capability_authority=authority,
        budget={"max_model_calls": 4, "max_completion_tokens": 8000,
                "max_nodes": 20, "max_tool_calls": 4},
    )
    completed = tasks.run(episode["id"])
    assert completed["status"] == "completed", completed.get("last_error")
    if kind == "tool":
        return completed, tasks.store.tool_instances(
            episode["id"], active_only=False)[0]["definition_id"]
    return completed, tasks.store.service_instance(episode["id"])["definition_id"]


@pytest.mark.parametrize("kind", ["tool", "service_provider"])
def test_task_capability_passes_selection_guard_and_fresh_episode_reuse(tmp_path, kind):
    gateway, tasks, evolution, generation, adoption, parent = _system(tmp_path)
    creator, definition_id = _creator(tasks, kind)
    feedback = generation.capture_feedback(
        "portable", [creator["id"]], expected_revision=0)
    adopted = adoption.adopt(
        "portable", definition_id, creator["id"], feedback["id"], 0,
        deepcopy(HYPOTHESIS),
        budget={"max_model_calls": 0, "max_tool_calls": 0, "max_nodes": 12},
    )
    generated = adopted["generation"]
    assert generated["status"] == "generated", generated.get("reason")
    candidate = evolution.candidate(generated["candidate_id"])
    component_id = adopted["adoption"]["component_id"]
    source_path = adopted["adoption"]["source_path"]
    child = tasks.store.package(candidate["package_id"])
    assert child["manifest"]["components"][component_id]["class"] == "S"
    assert source_path in child["files"]
    assert child["files"][source_path] not in parent["files"].values()

    benchmark = PortableCapabilityBenchmark()
    policy = PromotionPolicy(
        min_quality_delta=0.5, max_cost_ratio=20.0,
        monitor_min_score=0.5, monitor_min_success_rate=1.0,
    )
    selection = evolution.plan_pair(
        candidate["id"], benchmark, split="selection",
        split_role="selection", seed=17, policy=policy,
        budget={"max_model_calls": 4, "max_completion_tokens": 12000,
                "max_nodes": 20, "max_tool_calls": 4,
                "max_tool_work_units": 200000})
    trial = evolution.run_pair(selection["id"], benchmark)
    decision = evolution.assess(trial["id"])
    assert decision["gates"]["behavior_activated"] is True
    assert decision["eligible"] is True, (
        decision["gates"], decision["measurements"])
    assert decision["gates"]["behavior_activated"] is True
    assert decision["measurements"]["parent"]["quality"] == 0.0
    assert decision["measurements"]["candidate"]["quality"] == 1.0
    assert all(row["loaded"] is True for row in decision["loaded_evidence"])

    monitor_plan = evolution.plan_monitor(
        candidate["id"], benchmark, split="guard", seed=23,
        budget={"max_model_calls": 4, "max_completion_tokens": 12000,
                "max_nodes": 20, "max_tool_calls": 4,
                "max_tool_work_units": 200000})
    promoted = evolution.promote(
        candidate["id"], decision["id"], monitor_plan_id=monitor_plan["id"])
    assert promoted["revision"] == 1
    guard = evolution.run_monitor("portable", benchmark)
    monitored = evolution.monitor("portable", guard["episode_ids"])
    assert monitored["degraded"] is False
    assert monitored["rolled_back"] is False

    restarted = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    reuse = restarted.create(
        "Solve an independent ordinary task through the promoted channel",
        deliverables=deepcopy(RESULT_SPEC), package_channel="portable",
        budget={"max_model_calls": 2, "max_completion_tokens": 6000,
                "max_nodes": 12, "max_tool_calls": 2,
                "max_tool_work_units": 200000},
    )
    reuse = restarted.run(reuse["id"])
    assert reuse["status"] == "completed", reuse.get("last_error")
    assert reuse["package_id"] == candidate["package_id"]
    assert restarted.store.read(reuse["output_refs"]["result"], reuse["id"])[
        "content"] == {"answer": 42}
    assert source_path in reuse["execution"]["loaded_modules"]
    assert {row["component_id"] for row in reuse["execution"][
        "activated_components"]} == {component_id}


def test_adoption_rejects_a_definition_that_was_never_successfully_used(tmp_path):
    gateway, tasks, evolution, generation, adoption, parent = _system(tmp_path)
    creator, definition_id = _creator(tasks, "tool", use=False)
    feedback = generation.capture_feedback(
        "portable", [creator["id"]], expected_revision=0)

    with pytest.raises(ContractError, match="lacks successful use"):
        adoption.adopt(
            "portable", definition_id, creator["id"], feedback["id"], 0,
            deepcopy(HYPOTHESIS))


def test_adoption_rejects_stale_revision_before_candidate_generation(tmp_path):
    gateway, tasks, evolution, generation, adoption, parent = _system(tmp_path)
    creator, definition_id = _creator(tasks, "tool")
    feedback = generation.capture_feedback(
        "portable", [creator["id"]], expected_revision=0)

    with pytest.raises(ContractError, match="stale"):
        adoption.adopt(
            "portable", definition_id, creator["id"], feedback["id"], 1,
            deepcopy(HYPOTHESIS))


def test_completed_service_use_accepts_real_gateway_received_receipt(tmp_path):
    gateway, tasks, evolution, generation, adoption, parent = _system(tmp_path)
    creator, definition_id = _creator(tasks, "service_provider")
    definition = tasks.store.service_definition(definition_id)
    assert TaskCapabilityAdoptionService._used(creator, definition)
    received = deepcopy(creator)
    for call in received["calls"]:
        if call.get("service_provider", {}).get("definition_id") == definition_id:
            call["status"] = "received"
    assert TaskCapabilityAdoptionService._used(received, definition)
    for call in received["calls"]:
        if call.get("service_provider", {}).get("definition_id") == definition_id:
            call["status"] = "started"
    assert not TaskCapabilityAdoptionService._used(received, definition)
