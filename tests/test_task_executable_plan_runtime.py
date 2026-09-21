"""Vertical runtime coverage for manifest-v2 workflow orchestrators."""

from copy import deepcopy
import json
import threading

import pytest

from nexgent.tasks.orchestration import JoinMode
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ToolRegistry, ToolSpec
from nexgent.tasks.workflows import plan_from_workflow


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


def _v2_package(workflows, *, max_parallel=2):
    files = {
        "agent/main.py": (
            "def execute(payload, context):\n"
            "    raise RuntimeError('workflow orchestrator must bypass execute')\n"
        ),
        "prompts/alpha.md": "Produce the alpha branch.",
        "prompts/beta.md": "Produce the beta branch.",
        "prompts/formatter.md": "Format the supplied payload.",
    }
    registry = {}
    for name, workflow in workflows.items():
        path = f"workflows/{name}.json"
        files[path] = json.dumps(workflow)
        registry[name] = {
            "ref": path,
            "max_parallel": (
                max_parallel.get(name, 2)
                if isinstance(max_parallel, dict) else max_parallel
            ),
            "input_schema": {"type": "object"},
            "output_schema": {"type": "object"},
        }
    manifest = {
        "manifest_version": 2,
        "entries": {"execute": "agent/main.py:execute"},
        "skills": {
            "formatter": {
                "kind": "prompt_protocol",
                "ref": "prompts/formatter.md",
                "input_schema": {},
                "output_schema": {},
            },
        },
        "roles": {
            role: {"prompt_ref": f"prompts/{role}.md", "capabilities": ["ask"]}
            for role in ("alpha", "beta")
        },
        "workflows": registry,
        "components": {
            "main-orchestrator": {"class": "O", "kind": "workflow", "ref": "main"},
            "alpha-role": {"class": "S", "kind": "role", "ref": "alpha"},
            "beta-role": {"class": "S", "kind": "role", "ref": "beta"},
            "formatter-skill": {
                "class": "S", "kind": "skill", "ref": "formatter",
            },
        },
        "orchestrator": "main-orchestrator",
    }
    return make_package(files, manifest)


def test_plan_identity_preserves_explicit_join_admission_modes():
    def compiled(policy):
        workflow = {
            "nodes": [
                {"id": "left", "method": "tool"},
                {"id": "right", "method": "tool"},
                {"id": "join", "method": "join", "join_policy": policy},
            ],
            "control_edges": [
                {"from": "left", "to": "join"},
                {"from": "right", "to": "join"},
            ],
        }
        return plan_from_workflow(workflow, "join-plan")

    success = compiled("all_success")
    completed = compiled("all_completed")

    assert success.join_policies[0].mode is JoinMode.ALL_SUCCESS
    assert completed.join_policies[0].mode is JoinMode.ALL_COMPLETED
    assert success.as_dict()["join_policies"][0]["mode"] == "all_success"
    assert completed.as_dict()["join_policies"][0]["mode"] == "all_completed"
    assert success.ref != completed.ref


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
    assert service.store.rpc_find(
        episode["id"], "plan/nodes/alpha")["request"]["params"]["role"] == "alpha"
    assert join["control_dependencies"] == ["alpha", "beta"]
    assert {binding["producer_node_id"] for binding in join["artifact_bindings"]} == {
        "alpha", "beta"}
    assert checker_node["control_dependencies"] == ["join"]
    assert service.store.rpc_find(episode["id"], "plan/nodes/checker")["status"] == "completed"
    assert result["projection"] == "public"
    assert "plan_node_receipts" not in result
    assert "request" not in alpha and "plan_receipt" not in alpha
    private = service.get_private(episode["id"])
    assert private["plan_node_receipts"]["alpha"]["status"] == "completed"
    assert private["nodes"]["plan/nodes/alpha"]["request"]["prompt"] == (
        "Produce the alpha branch.")
    exported = json.loads(open(service.export(episode["id"]), encoding="utf-8").read())
    assert exported["projection"] == "public"
    assert "plan_node_receipts" not in exported
    assert "request" not in exported["nodes"]["plan/nodes/alpha"]


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


def test_parallel_limit_admits_only_started_node_and_resume_runs_pending_peer(tmp_path):
    calls = []

    def branch(arguments, context):
        calls.append(arguments["id"])
        if arguments["id"] == "a":
            context.stop_event.set()
            return {"stopped": True}
        artifact = context.publish({"branch": "b"}, name="result")
        return {"artifact_id": artifact["id"]}

    tool = ToolSpec(
        "contract.branch", {"type": "object"}, {"type": "object"},
        "artifact_write", branch,
    )
    workflow = {
        "nodes": [{
            "id": node_id,
            "method": "tool",
            "params": {"name": tool.name, "arguments": {"id": node_id}},
        } for node_id in ("a", "b")],
        "outputs": {"deliverables": {"result": {"$node": "b.artifact_id"}}},
    }
    registry = ToolRegistry([tool])
    service = TaskService(tmp_path, tools=registry)
    episode = service.create(
        "Pause before the second ready branch is admitted",
        deliverables=RESULT_SPEC, capabilities=[tool.name],
        constraints={"allowed_effects": ["artifact_write"]},
        package=_v2_package({"main": workflow}, max_parallel=1),
    )

    first = service.run(episode["id"])

    assert first["status"] == "paused"
    assert first["nodes"]["plan/nodes/a"]["status"] == "completed"
    assert first["nodes"]["plan/nodes/b"]["status"] == "pending"
    assert service.store.rpc_find(episode["id"], "plan/nodes/b") is None
    assert calls == ["a"]

    resumed = TaskService(tmp_path, tools=registry).run(episode["id"])

    assert resumed["status"] == "completed", resumed.get("last_error")
    assert calls == ["a", "b"]
    assert service.store.rpc_find(
        episode["id"], "plan/nodes/a")["status"] == "completed"


def test_revision_uses_revised_workflow_parallelism_in_same_run(tmp_path):
    barrier = threading.Barrier(2)
    branches = []

    def checker(arguments, context):
        return {"passed": False}

    def branch(arguments, context):
        barrier.wait(timeout=5)
        branches.append(arguments["side"])
        artifact = context.publish({"side": arguments["side"]}, name=arguments["side"])
        return {"artifact_id": artifact["id"]}

    checker_tool = ToolSpec(
        "contract.parallel-check", {"type": "object"}, {"type": "object"},
        "read", checker,
    )
    branch_tool = ToolSpec(
        "contract.parallel-repair", {"type": "object"}, {"type": "object"},
        "artifact_write", branch,
    )

    def workflow(version, *, revision=False):
        value = {
            "nodes": [{
                "id": "checker", "method": "tool",
                "params": {"name": checker_tool.name, "arguments": {}},
            }] + [{
                "id": side, "method": "tool",
                "params": {"name": branch_tool.name, "arguments": {
                    "side": side, "version": version,
                }},
            } for side in ("left", "right")] + [{
                "id": "join", "method": "join",
                "bindings": {
                    "left": {"$node": "left.artifact_id"},
                    "right": {"$node": "right.artifact_id"},
                },
            }],
            "control_edges": [
                {"from": "checker", "to": side,
                 "condition": {"path": "passed", "equals": False}}
                for side in ("left", "right")
            ],
            "outputs": {"deliverables": {"result": {"$node": "join.left"}}},
        }
        if revision:
            value["revision_rules"] = [{
                "id": "parallel-repair", "after_node": "checker",
                "when": {"path": "passed", "equals": False},
                "workflow_ref": "revised",
                "replace_node_ids": ["left", "right", "join"],
            }]
        return value

    registry = ToolRegistry([checker_tool, branch_tool])
    package = _v2_package(
        {"main": workflow("initial", revision=True),
         "revised": workflow("revised")},
        max_parallel={"main": 1, "revised": 2},
    )
    service = TaskService(tmp_path, tools=registry)
    episode = service.create(
        "Use revised parallelism", deliverables=RESULT_SPEC,
        capabilities=[checker_tool.name, branch_tool.name], package=package,
        constraints={"allowed_effects": ["read", "artifact_write"]},
    )

    result = service.run(episode["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert result["plan_revision"] == 2
    assert sorted(branches) == ["left", "right"]


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


def test_resume_rejects_valid_but_substituted_input_artifact_evidence(tmp_path):
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
            "bindings": {"arguments": {
                "artifact_id": {"$input": "input_refs.source"},
            }},
        }],
        "outputs": {"deliverables": {"result": {"$node": "checkpoint.artifact_id"}}},
    }
    registry = ToolRegistry([tool])
    service = TaskService(tmp_path, tools=registry)
    episode = service.create(
        "Reject forged plan evidence", deliverables=RESULT_SPEC,
        inputs={"source": {"value": "A"}, "alternate": {"value": "B"}},
        capabilities=[tool.name], package=_v2_package({"main": workflow}),
        constraints={"allowed_effects": ["artifact_write"]},
    )

    paused = service.run(episode["id"])
    assert paused["status"] == "paused"
    assert len(calls) == 1
    raw = service.store.get(episode["id"])
    node_state = raw["plan_execution"]["node_executions"][0]
    assert node_state["input_artifact_refs"] == [raw["input_refs"]["source"]]
    node_state["input_artifact_refs"] = [raw["input_refs"]["alternate"]]
    service.store.save(raw)

    resumed = TaskService(tmp_path, tools=registry).run(episode["id"])

    assert resumed["status"] == "waiting_input"
    assert "input artifact evidence differs" in resumed["last_error"]
    assert len(calls) == 1


def test_resume_recomputes_join_and_rejects_modified_local_receipt(tmp_path):
    def action(arguments, context):
        if arguments["kind"] == "produce":
            return {"answer": 7}
        artifact = context.publish({"joined": arguments["joined"]}, name="result")
        context.stop_event.set()
        return {"artifact_id": artifact["id"]}

    tool = ToolSpec(
        "contract.join-ledger", {"type": "object"}, {"type": "object"},
        "artifact_write", action,
    )
    workflow = {
        "nodes": [{
            "id": "produce", "method": "tool",
            "params": {"name": tool.name, "arguments": {"kind": "produce"}},
        }, {
            "id": "join", "method": "join",
            "bindings": {"answer": {"$node": "produce.answer"}},
        }, {
            "id": "checkpoint", "method": "tool",
            "params": {"name": tool.name},
            "bindings": {"arguments": {
                "kind": "checkpoint", "joined": {"$node": "join"},
            }},
        }],
        "outputs": {"deliverables": {
            "result": {"$node": "checkpoint.artifact_id"},
        }},
    }
    registry = ToolRegistry([tool])
    service = TaskService(tmp_path, tools=registry)
    episode = service.create(
        "Verify the local join receipt", deliverables=RESULT_SPEC,
        capabilities=[tool.name], package=_v2_package({"main": workflow}),
        constraints={"allowed_effects": ["artifact_write"]},
    )

    first = service.run(episode["id"])
    assert first["status"] == "paused"
    raw = service.store.get(episode["id"])
    raw["plan_node_receipts"]["join"]["value"]["answer"] = 999
    service.store.save(raw)

    resumed = TaskService(tmp_path, tools=registry).run(episode["id"])

    assert resumed["status"] == "waiting_input"
    assert "host journal" in resumed["last_error"] or "rpc journal" in resumed["last_error"].lower()


def test_malformed_join_dependency_resumes_as_durable_failure_not_internal_error(tmp_path):
    tool = ToolSpec(
        "contract.empty", {"type": "object"}, {"type": "object"}, "read",
        lambda arguments, context: {},
    )
    workflow = {
        "nodes": [{
            "id": "produce", "method": "tool",
            "params": {"name": tool.name, "arguments": {}},
        }, {
            "id": "join", "method": "join",
            "bindings": {"missing": {"$node": "produce.absent"}},
        }],
    }
    registry = ToolRegistry([tool])
    service = TaskService(tmp_path, tools=registry)
    episode = service.create(
        "Persist a malformed dependency failure", deliverables=RESULT_SPEC,
        capabilities=[tool.name], package=_v2_package({"main": workflow}),
    )

    failed = service.run(episode["id"])
    assert failed["status"] == "failed"
    raw = service.store.get(episode["id"])
    assert raw["plan_node_receipts"]["join"]["status"] == "failed"
    raw["status"] = "paused"
    service.store.save(raw)

    resumed = TaskService(tmp_path, tools=registry).run(episode["id"])

    assert resumed["status"] == "failed"
    assert "UnboundLocalError" not in resumed["last_error"]


def test_resume_rejects_modified_loop_history_and_keeps_it_host_private(tmp_path):
    def increment(arguments, context):
        return {"count": arguments["count"] + 1}

    def checkpoint(arguments, context):
        artifact = context.publish({"count": arguments["count"]}, name="result")
        context.stop_event.set()
        return {"artifact_id": artifact["id"]}

    increment_tool = ToolSpec(
        "contract.increment", {"type": "object"}, {"type": "object"},
        "local_compute", increment,
    )
    checkpoint_tool = ToolSpec(
        "contract.loop-checkpoint", {"type": "object"}, {"type": "object"},
        "artifact_write", checkpoint,
    )
    workflow = {
        "nodes": [{
            "id": "iterate", "method": "loop", "max_iterations": 2,
            "until": {"path": "count", "equals": 2},
            "params": {"payload": {"count": 0}},
            "body": {
                "nodes": [{
                    "id": "increment", "method": "tool",
                    "params": {"name": increment_tool.name},
                    "bindings": {"arguments": {
                        "count": {"$input": "count"},
                    }},
                }],
                "outputs": {"count": {"$node": "increment.count"}},
            },
        }, {
            "id": "checkpoint", "method": "tool",
            "params": {"name": checkpoint_tool.name},
            "bindings": {"arguments": {
                "count": {"$node": "iterate.outputs.count"},
            }},
        }],
        "outputs": {"deliverables": {
            "result": {"$node": "checkpoint.artifact_id"},
        }},
    }
    registry = ToolRegistry([increment_tool, checkpoint_tool])
    service = TaskService(tmp_path, tools=registry)
    episode = service.create(
        "Verify loop journals", deliverables=RESULT_SPEC,
        capabilities=[increment_tool.name, checkpoint_tool.name],
        constraints={"allowed_effects": ["local_compute", "artifact_write"]},
        package=_v2_package({"main": workflow}),
    )

    first = service.run(episode["id"])
    assert first["status"] == "paused", first.get("last_error")
    assert "result" not in first["nodes"]["plan/nodes/iterate"]
    private = service.get_private(episode["id"])
    assert private["plan_node_receipts"]["iterate"]["value"]["iterations"] == 2
    raw = service.store.get(episode["id"])
    raw["plan_node_receipts"]["iterate"]["value"]["history"][0][
        "nodes"]["increment"]["value"]["count"] = 99
    service.store.save(raw)

    resumed = TaskService(tmp_path, tools=registry).run(episode["id"])

    assert resumed["status"] == "waiting_input"
    assert "host journal" in resumed["last_error"] or "rpc journal" in resumed["last_error"].lower()


@pytest.mark.parametrize(("violation", "message"), [
    ("component", "component"),
    ("role", "role"),
    ("ask_refs", "explicit role_ref and component_ref"),
    ("ask_component", "matching role component_ref"),
    ("ask_conflict", "conflicts with its frozen role_ref"),
    ("ask_binding", "derived from role_ref"),
    ("skill_component", "matching skill component_ref"),
    ("retry", "does not support retry"),
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
    if violation == "ask_refs":
        node.update(method="ask", params={"prompt": "unused"})
    if violation == "ask_component":
        node.update(method="ask", role_ref="alpha", params={"prompt": "unused"})
    if violation == "ask_conflict":
        node.update(
            method="ask", role_ref="alpha", component_ref="alpha-role",
            params={"role": "beta", "prompt": "unused"},
        )
    if violation == "ask_binding":
        node.update(
            method="ask", role_ref="alpha", component_ref="alpha-role",
            params={"prompt": "unused"}, bindings={"role": "beta"},
        )
    if violation == "skill_component":
        node.update(method="skill", params={"name": "formatter", "payload": {}})
    workflow = {"nodes": [node], "outputs": {}}
    if violation == "retry":
        node["local_limits"] = {"max_attempts": 2}
        workflow["failure_routes"] = [{
            "from": "attempt", "action": "retry", "failure_kinds": ["*"],
        }]
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
