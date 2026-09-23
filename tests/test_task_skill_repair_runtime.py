"""Durable model repair of rejected develop_skill proposals."""

from copy import deepcopy

import pytest

from nexgent.tasks.runtime import TaskService
from nexgent.tasks.self_orchestration_seed import self_orchestration_package
from nexgent.tasks.task_skill_compiler import TASK_SKILL_PROPOSAL_SCHEMA


RESULT_SPEC = [{"name": "result", "schema": {
    "type": "object", "required": ["answer"],
    "properties": {"answer": {"const": 42}},
}}]


def _proposal(*, valid):
    proposal = {
        "skill": {
            "name": "constant_answer", "entrypoint": "solve",
            "source": (
                "def solve(payload, context):\n"
                "    return {'answer': 42}\n"
            ),
            "input_schema": {"type": "object"},
            "output_schema": {
                "type": "object", "required": ["answer"],
                "properties": {"answer": {"const": 42}},
            },
        },
        "deliverable_name": "result",
        "hypothesis": {
            "failure_mechanism": "the task needs a precise reusable transform",
            "expected_behavior": "the child returns the contracted answer",
            "applicability": "this task's contracted output",
            "falsifier": "the delegated child does not return 42",
        },
    }
    proposal["schema" if valid else "schema_version"] = TASK_SKILL_PROPOSAL_SCHEMA
    return proposal


def _graph(*, attempts=2):
    nodes = [
        {
            "id": "coder", "method": "ask", "role_ref": "generalist",
            "component_ref": "generalist-role",
            "params": {"max_tokens": 400, "prompt": "Return the proposal."},
            "bindings": {"payload": {"task": {"$input": ""}}},
        },
        {
            "id": "develop", "method": "develop_skill",
            "params": {
                "constraints": {
                    "allowed_rpc_methods": [], "allowed_tools": [],
                    "max_patch_bytes": 300000,
                },
                "repair": {
                    "role": "generalist", "max_attempts": attempts,
                    "max_tokens": 500,
                },
            },
            "bindings": {"proposal": {"$node": "coder"}},
        },
        {
            "id": "use_skill", "method": "delegate",
            "bindings": {
                "package_id": {"$node": "develop.package_id"},
                "task": {
                    "objective": {"$input": "objective"},
                    "deliverables": {"$input": "deliverables"},
                    "capabilities": {"$input": "capabilities"},
                },
            },
        },
    ]
    return {
        "replaced_node_ids": ["slot"],
        "operations": [
            {"op": "remove_node", "node_id": "slot"},
            *[{"op": "add_node", "node": node} for node in nodes],
            {"op": "add_control_edge", "edge": {
                "from": "architect", "to": "coder"}},
        ],
        "outputs": {"deliverables": {
            "result": {"$node": "use_skill.output_refs.result"}}},
        "revision_rules": [],
    }


class RepairGateway:
    def __init__(self, *, attempts=2, always_invalid=False,
                 repair_failure=None, interrupt_repair=False):
        self.attempts = attempts
        self.always_invalid = always_invalid
        self.repair_failure = repair_failure
        self.interrupt_repair = interrupt_repair
        self.calls = []

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                call = {"role": role, "prompt": prompt,
                        "payload": deepcopy(payload), "max_tokens": max_tokens}
                owner.calls.append(call)
                if (isinstance(payload, dict)
                        and payload.get("schema") ==
                        "nexgent.task-skill-repair-request.v1"
                        and owner.repair_failure is not None):
                    raise owner.repair_failure
                receipt = {
                    "call_id": f"task-skill-repair-{len(owner.calls)}",
                    "role": role, "model": "TASK-SKILL-REPAIR-TEST",
                    "status": "started", "reserved_completion_tokens": max_tokens,
                    "max_tokens": max_tokens,
                }
                reserve(receipt)
                reserve({
                    **receipt, "status": "completed",
                    "billing_status": "usage_reported",
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1,
                              "total_tokens": 2},
                })
                if (owner.interrupt_repair
                        and isinstance(payload, dict)
                        and payload.get("schema") ==
                        "nexgent.task-skill-repair-request.v1"):
                    raise KeyboardInterrupt("process stopped during repair RPC")
                if role == "architect":
                    return {"proposal": _graph(attempts=owner.attempts)}
                if (isinstance(payload, dict)
                        and payload.get("schema") ==
                        "nexgent.task-skill-repair-request.v1"):
                    return _proposal(valid=not owner.always_invalid)
                return _proposal(valid=False)

        return Gateway()


def _run(tmp_path, gateway, *, budget=None):
    service = TaskService(tmp_path, gateway_factory=gateway)
    episode = service.create(
        "Return the exact contracted answer",
        inputs={"value": 21}, deliverables=RESULT_SPEC,
        package=self_orchestration_package(),
        budget=budget or {
            "max_model_calls": 6, "max_completion_tokens": 12000,
            "max_tool_calls": 0, "max_nodes": 12,
        },
    )
    return service, episode, service.run(episode["id"])


def test_invalid_schema_version_is_repaired_then_child_executes(tmp_path):
    gateway = RepairGateway()
    service, episode, result = _run(tmp_path, gateway)

    assert result["status"] == "completed", result.get("last_error")
    assert [call["role"] for call in gateway.calls] == [
        "architect", "generalist", "generalist"]
    coder_task = gateway.calls[1]["payload"]["task"]
    repair = gateway.calls[2]["payload"]
    assert repair["task_spec"] == coder_task
    assert repair["failed_proposal"] == _proposal(valid=False)
    assert repair["diagnostic"]["message"] == (
        "Task skill proposal has an invalid envelope")
    assert service.store.rpc_find(
        episode["id"],
        "plan/nodes/develop/repair/compiler/attempts/2",
    )["status"] == "completed"
    assert result["usage"]["model_calls"] == 3
    assert len(result["child_episode_ids"]) == 1
    assert service.store.read(result["output_refs"]["result"], episode["id"])[
        "content"] == {"answer": 42}
    [event] = [event for event in result["events"]
               if event["kind"] == "task_skill_compiled"]
    assert event["content"]["compile_attempts"] == 2
    assert event["content"]["compiler_diagnostics"][0]["attempt"] == 1
    child_package = service.store.package(event["content"]["package_id"])
    assert event["content"]["proposal_digest"] == child_package[
        "provenance"]["task_skill_proposal_digest"]


def test_invalid_repairs_exhaust_configured_attempts_without_child(tmp_path):
    gateway = RepairGateway(attempts=3, always_invalid=True)
    service, episode, result = _run(tmp_path, gateway)

    assert result["status"] == "failed"
    assert [call["role"] for call in gateway.calls] == [
        "architect", "generalist", "generalist", "generalist"]
    assert "repair exhausted after 3 attempts" in result[
        "nodes"]["plan/nodes/develop"]["error"]
    assert "Node develop failed:" in result["last_error"]
    assert "repair exhausted after 3 attempts" in result["last_error"]
    assert result["child_episode_ids"] == []
    assert result["usage"]["model_calls"] == 4
    for attempt in (2, 3):
        assert service.store.rpc_find(
            episode["id"],
            f"plan/nodes/develop/repair/compiler/attempts/{attempt}",
        )["status"] == "completed"


def test_repair_provider_failure_is_not_retried_or_reclassified(tmp_path):
    gateway = RepairGateway(
        attempts=4, repair_failure=TimeoutError("provider unavailable"))
    _, _, result = _run(tmp_path, gateway)

    assert result["status"] == "failed"
    assert len(gateway.calls) == 3
    assert "TimeoutError: provider unavailable" in result["last_error"]


def test_repair_budget_exhaustion_does_not_issue_a_second_repair(tmp_path):
    gateway = RepairGateway(attempts=4)
    _, _, result = _run(tmp_path, gateway, budget={
        "max_model_calls": 2, "max_completion_tokens": 6000,
        "max_tool_calls": 0, "max_nodes": 12,
    })

    assert result["status"] == "failed"
    assert len(gateway.calls) == 3
    assert result["usage"]["model_calls"] == 2
    assert "model-call budget exhausted" in result["last_error"]


def test_completed_nested_repair_replays_once_after_outer_process_crash(
        tmp_path, monkeypatch):
    from nexgent.tasks import task_skill_compiler

    gateway = RepairGateway()
    service = TaskService(tmp_path, gateway_factory=gateway)
    episode = service.create(
        "Return the exact contracted answer", inputs={"value": 21},
        deliverables=RESULT_SPEC, package=self_orchestration_package(),
        budget={"max_model_calls": 6, "max_completion_tokens": 12000,
                "max_tool_calls": 0, "max_nodes": 12},
    )
    original = task_skill_compiler.compile_task_skill_proposal
    interrupted = {"done": False}

    def compile_then_stop(parent, proposal, constraints, *, provenance=None):
        child = original(
            parent, proposal, constraints, provenance=provenance)
        if not interrupted["done"]:
            interrupted["done"] = True
            raise KeyboardInterrupt("process stopped after repaired compilation")
        return child

    monkeypatch.setattr(
        task_skill_compiler, "compile_task_skill_proposal", compile_then_stop)

    with pytest.raises(KeyboardInterrupt, match="after repaired compilation"):
        service.run(episode["id"])

    repair_path = "plan/nodes/develop/repair/compiler/attempts/2"
    assert service.store.rpc_find(episode["id"], repair_path)[
        "status"] == "completed"
    assert service.store.rpc_find(episode["id"], "plan/nodes/develop")[
        "status"] == "started"
    assert len(gateway.calls) == 3

    resumed = TaskService(tmp_path, gateway_factory=gateway).run(episode["id"])

    assert resumed["status"] == "completed", resumed.get("last_error")
    assert len(gateway.calls) == 3
    assert resumed["usage"]["model_calls"] == 3
    assert service.store.rpc_find(episode["id"], repair_path)[
        "status"] == "completed"


def test_unknown_started_nested_repair_refuses_provider_repeat_on_resume(tmp_path):
    gateway = RepairGateway(interrupt_repair=True)
    service = TaskService(tmp_path, gateway_factory=gateway)
    episode = service.create(
        "Return the exact contracted answer", inputs={"value": 21},
        deliverables=RESULT_SPEC, package=self_orchestration_package(),
        budget={"max_model_calls": 6, "max_completion_tokens": 12000,
                "max_tool_calls": 0, "max_nodes": 12},
    )

    with pytest.raises(KeyboardInterrupt, match="during repair RPC"):
        service.run(episode["id"])

    repair_path = "plan/nodes/develop/repair/compiler/attempts/2"
    assert service.store.rpc_find(episode["id"], repair_path)[
        "status"] == "started"
    assert len(gateway.calls) == 3

    resumed = TaskService(tmp_path, gateway_factory=gateway).run(episode["id"])

    assert resumed["status"] == "failed"
    assert len(gateway.calls) == 3
    assert resumed["usage"]["model_calls"] == 3
    assert "automatic repetition refused" in resumed["last_error"]
    assert service.store.rpc_find(episode["id"], repair_path)[
        "status"] == "started"
