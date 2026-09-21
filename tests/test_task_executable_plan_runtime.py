"""Vertical runtime coverage for manifest-v2 workflow orchestrators."""

from copy import deepcopy
import json
import threading

import pytest

from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ToolRegistry, ToolSpec


RESULT_SPEC = [{"name": "result", "schema": {"type": "object"}}]
TEXT_SCHEMA = "schema://text-v1"


class ParallelRoleGateway:
    def __init__(self):
        self.calls = []
        self.barrier = threading.Barrier(2)
        self.lock = threading.Lock()

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                with owner.lock:
                    owner.calls.append(role)
                    call_id = f"plan-role-{len(owner.calls)}"
                receipt = {
                    "call_id": call_id,
                    "role": role,
                    "model": "DETERMINISTIC-PLAN-DOUBLE",
                    "status": "started",
                    "reserved_completion_tokens": max_tokens,
                    "max_tokens": max_tokens,
                }
                reserve(receipt)
                owner.barrier.wait(timeout=5)
                reserve({
                    **receipt,
                    "status": "completed",
                    "billing_status": "usage_reported",
                    "usage": {
                        "prompt_tokens": 1,
                        "completion_tokens": 1,
                        "total_tokens": 2,
                    },
                })
                return {"text": role.upper()}

        return Gateway()


def _role_nodes():
    return [
        {
            "id": role,
            "method": "ask",
            "role_ref": role,
            "component_ref": f"{role}-role",
            "params": {"payload": {"branch": role}, "max_tokens": 20},
        }
        for role in ("alpha", "beta")
    ]


def _join_node():
    return {
        "id": "join",
        "method": "join",
        "join_policy": "all_success",
    }


def _role_edges():
    return [
        {
            "producer_node": role,
            "output_port": "text",
            "consumer_node": "join",
            "input_port": role,
            "schema_ref": TEXT_SCHEMA,
        }
        for role in ("alpha", "beta")
    ]


def _v2_package(workflows):
    files = {
        "agent/main.py": (
            "def execute(payload, context):\n"
            "    raise RuntimeError('workflow orchestrator must bypass execute')\n"
        ),
        "prompts/alpha.md": "Produce the alpha branch.",
        "prompts/beta.md": "Produce the beta branch.",
    }
    registry = {}
    for name, workflow in workflows.items():
        path = f"workflows/{name}.json"
        files[path] = json.dumps(workflow)
        registry[name] = {
            "ref": path,
            "max_parallel": 2,
            "input_schema": {"type": "object"},
            "output_schema": {"type": "object"},
        }
    manifest = {
        "manifest_version": 2,
        "entries": {"execute": "agent/main.py:execute"},
        "skills": {},
        "roles": {
            role: {"prompt_ref": f"prompts/{role}.md", "capabilities": ["ask"]}
            for role in ("alpha", "beta")
        },
        "workflows": registry,
        "components": {
            "main-orchestrator": {"class": "O", "kind": "workflow", "ref": "main"},
            "alpha-role": {"class": "S", "kind": "role", "ref": "alpha"},
            "beta-role": {"class": "S", "kind": "role", "ref": "beta"},
        },
        "orchestrator": "main-orchestrator",
    }
    return make_package(files, manifest)


def test_v2_workflow_orchestrator_persists_parallel_roles_join_and_checker(tmp_path):
    checked = []

    def checker(arguments, context):
        checked.append(deepcopy(arguments))
        artifact = context.publish({"joined": arguments["joined"]}, name="result")
        return {"passed": True, "artifact_id": artifact["id"]}

    tool = ToolSpec(
        "contract.check", {"type": "object"}, {"type": "object"}, "read", checker)
    workflow = {
        "nodes": _role_nodes() + [_join_node(), {
            "id": "checker",
            "method": "tool",
            "params": {"name": "contract.check"},
            "bindings": {"arguments": {"joined": {"$node": "join"}}},
        }],
        "artifact_edges": _role_edges(),
        "outputs": {
            "deliverables": {"result": {"$node": "checker.artifact_id"}},
            "summary": "Parallel roles joined and checked.",
        },
    }
    gateway = ParallelRoleGateway()
    service = TaskService(
        tmp_path, tools=ToolRegistry([tool]), gateway_factory=gateway)
    episode = service.create(
        "Run the v2 plan", deliverables=RESULT_SPEC,
        capabilities=[tool.name], package=_v2_package({"main": workflow}),
    )

    result = service.run(episode["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert sorted(gateway.calls) == ["alpha", "beta"]
    assert checked == [{"joined": {"alpha": "ALPHA", "beta": "BETA"}}]
    assert result["current_plan_ref"] == result["plan_history_refs"][-1]
    assert result["plan_revision"] == 1
    assert result["plan_execution"]["plan"]["schema"] == "nexgent.executable-plan.v1"
    alpha = result["nodes"]["plan/nodes/alpha"]
    join = result["nodes"]["plan/nodes/join"]
    checker_node = result["nodes"]["plan/nodes/checker"]
    assert (alpha["role_ref"], alpha["component_ref"]) == ("alpha", "alpha-role")
    assert alpha["operator_ref"].startswith("operator://ask/")
    assert join["control_dependencies"] == ["alpha", "beta"]
    assert {binding["producer_node_id"] for binding in join["artifact_bindings"]} == {
        "alpha", "beta"}
    assert checker_node["control_dependencies"] == ["join"]
    assert service.store.rpc_find(episode["id"], "plan/nodes/checker")["status"] == "completed"


def test_checker_feedback_revises_pending_repair_and_resume_does_not_replay(tmp_path):
    checker_calls = []
    repair_calls = []

    def checker(arguments, context):
        checker_calls.append(deepcopy(arguments))
        context.stop_event.set()
        return {"passed": False, "feedback": "use the revised repair"}

    def repair(arguments, context):
        repair_calls.append(arguments["version"])
        artifact = context.publish({
            "version": arguments["version"],
            "joined": arguments["joined"],
        }, name="result")
        return {"artifact_id": artifact["id"]}

    checker_tool = ToolSpec(
        "contract.feedback", {"type": "object"}, {"type": "object"}, "read", checker)
    repair_tool = ToolSpec(
        "contract.repair", {"type": "object"}, {"type": "object"}, "artifact_write", repair)

    def workflow(version, *, revision=False):
        value = {
            "nodes": _role_nodes() + [_join_node(), {
                "id": "checker",
                "method": "tool",
                "params": {"name": "contract.feedback"},
                "bindings": {"arguments": {"joined": {"$node": "join"}}},
            }, {
                "id": "repair",
                "method": "tool",
                "params": {
                    "name": "contract.repair",
                    "arguments": {"version": version},
                },
                "bindings": {"arguments": {
                    "version": version,
                    "joined": {"$node": "join"},
                }},
            }, {
                "id": "deliver",
                "method": "join",
                "bindings": {"deliverables": {
                    "result": {"$node": "repair.artifact_id"},
                }},
            }],
            "artifact_edges": _role_edges(),
            "control_edges": [
                {"from": "checker", "to": "repair",
                 "condition": {"path": "passed", "equals": False}},
                {"from": "repair", "to": "deliver"},
            ],
            "outputs": {"deliverables": {"$node": "deliver.deliverables"}},
        }
        if revision:
            value["revision_rules"] = [{
                "id": "repair-from-feedback",
                "after_node": "checker",
                "when": {"path": "passed", "equals": False},
                "workflow_ref": "revised",
                "replace_node_ids": ["repair", "deliver"],
                "reason_ref": "feedback://checker/rejected",
            }]
        return value

    gateway = ParallelRoleGateway()
    registry = ToolRegistry([checker_tool, repair_tool])
    package = _v2_package({
        "main": workflow("initial", revision=True),
        "revised": workflow("revised"),
    })
    service = TaskService(tmp_path, tools=registry, gateway_factory=gateway)
    episode = service.create(
        "Revise the pending repair", deliverables=RESULT_SPEC,
        capabilities=[checker_tool.name, repair_tool.name], package=package,
        constraints={"allowed_effects": ["read", "artifact_write"]},
    )

    first = service.run(episode["id"])

    assert first["status"] == "paused"
    assert first["plan_revision"] == 2
    assert len(first["plan_history_refs"]) == 2
    assert first["plan_revisions"][0]["replaced_node_ids"] == ["repair", "deliver"]
    assert first["nodes"]["plan/nodes/alpha"]["status"] == "completed"
    assert first["nodes"]["plan/nodes/checker"]["status"] == "completed"
    assert first["nodes"]["plan/nodes/repair"]["status"] == "pending"
    assert repair_calls == []

    resumed = TaskService(
        tmp_path, tools=registry, gateway_factory=gateway).run(episode["id"])

    assert resumed["status"] == "completed", resumed.get("last_error")
    assert sorted(gateway.calls) == ["alpha", "beta"]
    assert len(checker_calls) == 1
    assert repair_calls == ["revised"]
    delivered = service.store.read(resumed["output_refs"]["result"], episode["id"])
    assert delivered["content"]["version"] == "revised"
    started = [event["content"]["call_path"] for event in resumed["events"]
               if event["kind"] == "rpc_started"]
    assert started.count("plan/nodes/alpha") == 1
    assert started.count("plan/nodes/beta") == 1
    assert started.count("plan/nodes/checker") == 1


def test_manifest_v1_runtime_remains_on_controlled_entry_path(tmp_path):
    package = make_package({"main.py": """def execute(payload, context):
    artifact = context.publish({'legacy': True}, name='result')
    return {'deliverables': {'result': artifact['id']}}
"""}, {"entries": {"execute": "main.py:execute"}})
    service = TaskService(tmp_path, tools=ToolRegistry())
    episode = service.create(
        "Keep v1 compatible", deliverables=RESULT_SPEC, package=package)

    result = service.run(episode["id"])

    assert result["status"] == "completed"
    assert result["current_plan_ref"] is None
    assert result["plan_execution"] is None
    assert result["execution"]["entry"] == "execute"


def test_resume_rejects_plan_artifact_evidence_absent_from_host_ledger(tmp_path):
    calls = []

    def checkpoint(arguments, context):
        calls.append(deepcopy(arguments))
        artifact = context.publish({"durable": True}, name="result")
        context.stop_event.set()
        return {"artifact_id": artifact["id"]}

    tool = ToolSpec(
        "contract.checkpoint", {"type": "object"}, {"type": "object"},
        "artifact_write", checkpoint,
    )
    workflow = {
        "nodes": [{
            "id": "checkpoint",
            "method": "tool",
            "params": {"name": tool.name, "arguments": {}},
        }],
        "outputs": {"deliverables": {"result": {"$node": "checkpoint.artifact_id"}}},
    }
    registry = ToolRegistry([tool])
    service = TaskService(tmp_path, tools=registry)
    episode = service.create(
        "Reject forged plan evidence", deliverables=RESULT_SPEC,
        capabilities=[tool.name], package=_v2_package({"main": workflow}),
        constraints={"allowed_effects": ["artifact_write"]},
    )

    paused = service.run(episode["id"])
    assert paused["status"] == "paused"
    assert len(calls) == 1
    raw = service.store.get(episode["id"])
    node_state = raw["plan_execution"]["node_executions"][0]
    node_state["output_artifact_refs"] = ["artifact-missing-from-ledger"]
    service.store.save(raw)

    resumed = TaskService(tmp_path, tools=registry).run(episode["id"])

    assert resumed["status"] == "waiting_input"
    assert "invalid artifact evidence" in resumed["last_error"]
    assert len(calls) == 1


@pytest.mark.parametrize(("violation", "message"), [
    ("component", "component"),
    ("role", "role"),
    ("lease", "capability lease"),
])
def test_v2_plan_refs_and_tool_operator_must_resolve_to_manifest_and_lease(
        tmp_path, violation, message):
    calls = []

    def handler(arguments, context):
        calls.append(arguments)
        return {}

    tool = ToolSpec(
        "contract.unleased", {"type": "object"}, {"type": "object"}, "read", handler)
    node = {
        "id": "attempt",
        "method": "tool",
        "params": {"name": tool.name, "arguments": {}},
    }
    capabilities = [] if violation == "lease" else [tool.name]
    if violation == "component":
        node["component_ref"] = "missing-component"
    if violation == "role":
        node.update(method="ask", role_ref="missing-role", params={"prompt": "unused"})
    workflow = {"nodes": [node], "outputs": {}}
    service = TaskService(
        tmp_path, tools=ToolRegistry([tool]), gateway_factory=ParallelRoleGateway())
    episode = service.create(
        "Reject unresolved plan references", deliverables=RESULT_SPEC,
        capabilities=capabilities,
        package=_v2_package({"main": workflow}),
    )

    result = service.run(episode["id"])

    assert result["status"] == "failed"
    assert calls == []
    assert result["usage"]["nodes"] == 0
    assert message in result["last_error"].lower()
