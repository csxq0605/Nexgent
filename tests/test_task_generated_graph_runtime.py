"""A model-produced graph changes the live episode and survives a pause."""

import json

from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ToolRegistry, ToolSpec
from nexgent.tasks.workflows import plan_from_workflow


def _package():
    seed = {
        "nodes": [
            {"id": "architect", "method": "ask", "role_ref": "architect",
             "component_ref": "architect-role",
             "params": {"max_tokens": 3000},
             "bindings": {"payload": {"task": {"$input": ""}}}},
            {"id": "slot", "method": "join"},
        ],
        "control_edges": [{"from": "architect", "to": "slot"}],
        "revision_rules": [{
            "id": "architect-graph", "after_node": "architect",
            "when": {"path": "$status", "equals": "completed"},
            "proposal_path": "proposal", "max_compile_attempts": 2,
        }],
        "outputs": {"deliverables": {"result": {"$node": "slot.id"}}},
    }
    files = {
        "agent/main.py": "def execute(payload, context):\n    raise RuntimeError('workflow only')\n",
        "workflows/main.json": json.dumps(seed),
        **{f"prompts/{role}.md": f"You are {role}."
           for role in ("architect", "alpha", "beta", "checker", "stale", "repair")},
    }
    manifest = {
        "manifest_version": 2,
        "entries": {"execute": "agent/main.py:execute"},
        "skills": {},
        "roles": {
            role: {"prompt_ref": f"prompts/{role}.md", "capabilities": ["ask"]}
            for role in ("architect", "alpha", "beta", "checker", "stale", "repair")
        },
        "workflows": {"main": {"ref": "workflows/main.json", "max_parallel": 2,
                               "input_schema": {"type": "object"},
                               "output_schema": {"type": "object"}}},
        "components": {
            "main-workflow": {"class": "O", "kind": "workflow", "ref": "main"},
            **{f"{role}-role": {"class": "S", "kind": "role", "ref": role}
               for role in ("architect", "alpha", "beta", "checker", "stale", "repair")},
        },
        "orchestrator": "main-workflow",
    }
    return make_package(files, manifest)


def _proposed_graph():
    return {
        "nodes": [
            {"id": "architect", "method": "ask", "role_ref": "architect",
             "component_ref": "architect-role", "params": {"max_tokens": 3000},
             "bindings": {"payload": {"task": {"$input": ""}}}},
            *[{"id": role, "method": "ask", "role_ref": role,
               "component_ref": f"{role}-role", "params": {"max_tokens": 100},
               "bindings": {"payload": {"task": {"$input": ""}}}}
              for role in ("alpha", "beta")],
            {"id": "join", "method": "join", "bindings": {
                "alpha": {"$node": "alpha.text"},
                "beta": {"$node": "beta.text"},
            }},
            {"id": "publish", "method": "publish", "params": {"name": "result"},
             "bindings": {"content": {"$node": "join"}}},
        ],
        "control_edges": [
            {"from": "architect", "to": "alpha"},
            {"from": "architect", "to": "beta"},
        ],
        "outputs": {"deliverables": {"result": {"$node": "publish.id"}}},
    }


def _proposed_operations():
    graph = _proposed_graph()
    return {
        "operations": [
            {"op": "remove_node", "node_id": "slot"},
            *[{"op": "add_node", "node": node}
              for node in graph["nodes"] if node["id"] != "architect"],
            *[{"op": "add_control_edge", "edge": edge}
              for edge in graph["control_edges"]],
        ],
        "outputs": graph["outputs"],
        "revision_rules": [],
    }


class GraphGatewayFactory:
    def __init__(self, base_ref, *, stop_architect, use_operations=False,
                 bad_first_proposal=False):
        self.base_ref = base_ref
        self.stop_architect = stop_architect
        self.use_operations = use_operations
        self.bad_first_proposal = bad_first_proposal
        self.calls = []

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                owner.calls.append(role)
                receipt = {"call_id": f"graph-{len(owner.calls)}", "role": role,
                           "model": "GRAPH-TEST-DOUBLE", "status": "started",
                           "reserved_completion_tokens": max_tokens,
                           "max_tokens": max_tokens}
                reserve(receipt)
                reserve({**receipt, "status": "completed",
                         "billing_status": "usage_reported",
                         "usage": {"prompt_tokens": 1, "completion_tokens": 1,
                                   "total_tokens": 2}})
                if role == "architect":
                    if owner.stop_architect:
                        stop_event.set()
                    if owner.bad_first_proposal and "compiler_feedback" not in (payload or {}):
                        return {"proposal": {
                            "base_plan_ref": owner.base_ref,
                            "replaced_node_ids": ["slot"],
                            "operations": [
                                {"op": "remove_node", "node_id": "slot"},
                                {"op": "add_node", "node": {
                                    "id": "broken", "operator": "ask"}},
                            ],
                        }}
                    proposal = {
                        "base_plan_ref": owner.base_ref,
                        "replaced_node_ids": ["slot"],
                    }
                    proposal.update(_proposed_operations() if owner.use_operations
                                    else {"revised_workflow": _proposed_graph()})
                    return {"proposal": proposal}
                return {"text": role.upper()}

        return Gateway()


def test_registered_package_role_can_serve_as_revision_planner(tmp_path):
    package = _package()
    workflow = {
        "nodes": [
            {"id": "checkpoint", "method": "join"},
            {"id": "slot", "method": "join"},
        ],
        "control_edges": [{"from": "checkpoint", "to": "slot"}],
        "revision_rules": [{
            "id": "package-planner",
            "after_node": "checkpoint",
            "when": {"path": "$status", "equals": "completed"},
            "planner_role_ref": "architect",
            "replace_node_ids": ["slot"],
        }],
    }

    materialized = TaskService(tmp_path)._materialize_workflow(
        package, "generated", [], proposed_workflow=workflow)

    assert materialized["revision_rules"][0]["planner_role_ref"] == "architect"
    plan_from_workflow(materialized, "package-planner-plan")


def test_architect_creates_parallel_roles_and_resume_preserves_completed_call(tmp_path):
    package = _package()
    service = TaskService(tmp_path)
    base = service._materialize_workflow(package, "main", [])
    base_ref = plan_from_workflow(base, "main-workflow").ref
    gateway = GraphGatewayFactory(base_ref, stop_architect=True)
    service = TaskService(tmp_path, gateway_factory=gateway)
    episode = service.create(
        "Design your team", deliverables=[{"name": "result", "schema": {
            "type": "object", "required": ["alpha", "beta"]}}],
        package=package,
    )

    paused = service.run(episode["id"])
    assert paused["status"] == "paused"
    assert paused["plan_revision"] == 2
    assert paused["nodes"]["plan/nodes/architect"]["status"] == "completed"
    assert paused["nodes"]["plan/nodes/alpha"]["status"] == "pending"
    assert paused["plan_workflow_ref"].startswith("generated://")
    assert "plan_workflow_snapshot" not in paused

    resumed = TaskService(tmp_path, gateway_factory=gateway).run(episode["id"])
    assert resumed["status"] == "completed", resumed.get("last_error")
    assert gateway.calls.count("architect") == 1
    assert sorted(gateway.calls) == ["alpha", "architect", "beta"]
    content = service.store.read(resumed["output_refs"]["result"], episode["id"])
    assert content["content"] == {"alpha": "ALPHA", "beta": "BETA"}
    assert len(resumed["plan_history_refs"]) == 2


def test_architect_graph_operations_change_the_live_execution(tmp_path):
    package = _package()
    service = TaskService(tmp_path)
    base = service._materialize_workflow(package, "main", [])
    gateway = GraphGatewayFactory(
        plan_from_workflow(base, "main-workflow").ref,
        stop_architect=False, use_operations=True)
    service = TaskService(tmp_path, gateway_factory=gateway)
    episode = service.create(
        "Build a team for this task", deliverables=[{"name": "result", "schema": {
            "type": "object", "required": ["alpha", "beta"]}}],
        package=package)

    result = service.run(episode["id"])
    assert result["status"] == "completed", result.get("last_error")
    assert result["plan_revision"] == 2
    assert sorted(gateway.calls) == ["alpha", "architect", "beta"]
    assert service.store.read(result["output_refs"]["result"], episode["id"])[
        "content"] == {"alpha": "ALPHA", "beta": "BETA"}


def test_compiler_feedback_reasks_architect_and_runs_corrected_graph(tmp_path):
    package = _package()
    service = TaskService(tmp_path)
    base = service._materialize_workflow(package, "main", [])
    gateway = GraphGatewayFactory(
        plan_from_workflow(base, "main-workflow").ref,
        stop_architect=False, use_operations=True, bad_first_proposal=True)
    service = TaskService(tmp_path, gateway_factory=gateway)
    episode = service.create(
        "Repair an invalid graph", deliverables=[{"name": "result", "schema": {
            "type": "object", "required": ["alpha", "beta"]}}],
        package=package)

    result = service.run(episode["id"])
    assert result["status"] == "completed", result.get("last_error")
    assert result["plan_revision"] == 2
    assert gateway.calls.count("architect") == 2
    assert len(result["calls"]) == 4
    assert any(event["kind"] == "graph_compiler_rejected"
               for event in result["events"])
    assert service.store.rpc_find(
        episode["id"],
        "plan/graph-repair/1/architect-graph/attempts/2") is not None


def test_checker_result_triggers_second_generated_revision_before_pending_work(tmp_path):
    """Execution feedback rewrites only pending work in a generated task graph."""

    repaired_graph = {
        "operations": [
            {"op": "remove_node", "node_id": "stale_worker"},
            {"op": "add_node", "node": {
                "id": "repaired_worker", "method": "ask", "role_ref": "repair",
                "component_ref": "repair-role",
                "params": {"max_tokens": 100, "prompt": "Apply the checker feedback."},
                "bindings": {"payload": {"feedback": {"$node": "checker.feedback"}}},
            }},
            {"op": "replace_node", "node_id": "publish", "node": {
                "id": "publish", "method": "publish", "params": {"name": "result"},
                "bindings": {"content": {"$node": "repaired_worker"}},
            }},
            {"op": "add_control_edge", "edge": {
                "from": "checker", "to": "repaired_worker",
            }},
        ],
        "outputs": {"deliverables": {"result": {"$node": "publish.id"}}},
        "revision_rules": [],
    }
    first_graph = {
        "replaced_node_ids": ["slot"],
        "operations": [
            {"op": "remove_node", "node_id": "slot"},
            {"op": "add_node", "node": {
                "id": "checker", "method": "ask", "role_ref": "checker",
                "component_ref": "checker-role",
                "params": {"max_tokens": 100, "prompt": "Check the initial approach."},
                "bindings": {"payload": {"task": {"$input": ""}}},
            }},
            {"op": "add_node", "node": {
                "id": "stale_worker", "method": "ask", "role_ref": "stale",
                "component_ref": "stale-role",
                "params": {"max_tokens": 100, "prompt": "Use the stale approach."},
                "bindings": {"payload": {"task": {"$input": ""}}},
            }},
            {"op": "add_node", "node": {
                "id": "publish", "method": "publish", "params": {"name": "result"},
                "bindings": {"content": {"$node": "stale_worker"}},
            }},
            {"op": "add_control_edge", "edge": {"from": "architect", "to": "checker"}},
            {"op": "add_control_edge", "edge": {"from": "checker", "to": "stale_worker"}},
        ],
        "outputs": {"deliverables": {"result": {"$node": "publish.id"}}},
        "revision_rules": [{
            "id": "checker-rewrite",
            "after_node": "checker",
            "when": {"path": "needs_revision", "equals": True},
            "proposal_path": "proposal",
            "replace_node_ids": ["stale_worker", "publish"],
            "max_compile_attempts": 1,
            "reason_ref": "feedback://checker/capability-gap",
        }],
    }

    class FeedbackGatewayFactory:
        def __init__(self):
            self.calls = []

        def __call__(self, reserve, stop_event):
            owner = self

            class Gateway:
                def ask(self, role, prompt, payload=None, max_tokens=4000):
                    owner.calls.append(role)
                    receipt = {
                        "call_id": f"feedback-{len(owner.calls)}", "role": role,
                        "model": "FEEDBACK-GRAPH-TEST-DOUBLE", "status": "started",
                        "reserved_completion_tokens": max_tokens, "max_tokens": max_tokens,
                    }
                    reserve(receipt)
                    reserve({**receipt, "status": "completed",
                             "billing_status": "usage_reported",
                             "usage": {"prompt_tokens": 1, "completion_tokens": 1,
                                       "total_tokens": 2}})
                    if role == "architect":
                        return {"proposal": first_graph}
                    if role == "checker":
                        return {
                            "needs_revision": True,
                            "feedback": "The initial approach lacks the required capability.",
                            "proposal": repaired_graph,
                        }
                    if role == "repair":
                        return {"answer": "repaired from checker feedback"}
                    return {"answer": "stale result"}

            return Gateway()

    package = _package()
    gateway = FeedbackGatewayFactory()
    service = TaskService(tmp_path, gateway_factory=gateway)
    episode = service.create(
        "Adapt after checking the initial approach",
        deliverables=[{"name": "result", "schema": {
            "type": "object", "required": ["answer"],
            "properties": {"answer": {"const": "repaired from checker feedback"}},
        }}],
        package=package,
    )

    result = service.run(episode["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert result["plan_revision"] == 3
    assert len(result["plan_history_refs"]) == 3
    assert [item["id"] for item in result["plan_revisions"]] == [
        "architect-graph", "checker-rewrite",
    ]
    assert result["plan_revisions"][1]["replaced_node_ids"] == [
        "stale_worker", "publish",
    ]
    assert gateway.calls == ["architect", "checker", "repair"]
    assert "stale" not in gateway.calls
    delivered = service.store.read(result["output_refs"]["result"], episode["id"])
    assert delivered["content"] == {"answer": "repaired from checker feedback"}


def test_failed_node_invokes_task_created_planner_and_resume_does_not_repeat_it(tmp_path):
    """A durable failure can ask a task-authored role to replace pending work."""

    planner_prompt = (
        "Use the supplied checkpoint receipt to revise only pending work. "
        "Return a JSON object containing proposal."
    )
    workflow = {
        "task_roles": {
            "replanner": {
                "identity": "Failure-aware replanner",
                "prompt": planner_prompt,
                "capabilities": ["ask"],
            },
        },
        "nodes": [
            {"id": "attempt", "method": "tool",
             "params": {"name": "checkpoint.fail", "arguments": {}}},
            {"id": "stale_worker", "method": "ask", "role_ref": "stale",
             "component_ref": "stale-role", "params": {"max_tokens": 100},
             "bindings": {"payload": {"task": {"$input": ""}}}},
            {"id": "publish", "method": "publish", "params": {"name": "result"},
             "bindings": {"content": {"$node": "stale_worker"}}},
        ],
        "control_edges": [{"from": "attempt", "to": "stale_worker"}],
        "revision_rules": [{
            "id": "failure-replan",
            "after_node": "attempt",
            "when": {"path": "$status", "equals": "failed"},
            "planner_role_ref": "task:replanner",
            "planner_max_tokens": 5000,
            "replace_node_ids": ["stale_worker", "publish"],
            "max_compile_attempts": 1,
        }],
        "outputs": {"deliverables": {"result": {"$node": "publish.id"}}},
    }
    files = {
        "agent/main.py": "def execute(payload, context):\n    raise RuntimeError('workflow only')\n",
        "workflows/main.json": json.dumps(workflow),
        "prompts/stale.md": "Use the stale approach.",
        "prompts/repair.md": "Repair the task from the supplied failure evidence.",
    }
    manifest = {
        "manifest_version": 2,
        "entries": {"execute": "agent/main.py:execute"},
        "skills": {},
        "roles": {
            "stale": {"prompt_ref": "prompts/stale.md", "capabilities": ["ask"]},
            "repair": {"prompt_ref": "prompts/repair.md", "capabilities": ["ask"]},
        },
        "workflows": {"main": {
            "ref": "workflows/main.json", "max_parallel": 1,
            "input_schema": {"type": "object"},
            "output_schema": {"type": "object"},
        }},
        "components": {
            "main-workflow": {"class": "O", "kind": "workflow", "ref": "main"},
            "stale-role": {"class": "S", "kind": "role", "ref": "stale"},
            "repair-role": {"class": "S", "kind": "role", "ref": "repair"},
        },
        "orchestrator": "main-workflow",
    }
    package = make_package(files, manifest)
    repaired_graph = {
        "operations": [
            {"op": "remove_node", "node_id": "stale_worker"},
            {"op": "add_node", "node": {
                "id": "repaired_worker", "method": "ask", "role_ref": "repair",
                "component_ref": "repair-role", "params": {"max_tokens": 100},
                "bindings": {"payload": {"failure": {"$node": "attempt"}}},
            }},
            {"op": "replace_node", "node_id": "publish", "node": {
                "id": "publish", "method": "publish", "params": {"name": "result"},
                "bindings": {"content": {"$node": "repaired_worker"}},
            }},
            {"op": "add_control_edge", "edge": {
                "from": "attempt", "to": "repaired_worker",
                "condition": {"path": "$status", "equals": "failed"},
            }},
        ],
        "outputs": {"deliverables": {"result": {"$node": "publish.id"}}},
        "revision_rules": [],
    }

    class FailurePlannerGatewayFactory:
        def __init__(self):
            self.calls = []
            self.stop_after_planner = True

        def __call__(self, reserve, stop_event):
            owner = self

            class Gateway:
                def ask(self, role, prompt, payload=None, max_tokens=4000):
                    owner.calls.append({
                        "role": role, "prompt": prompt, "payload": payload,
                        "max_tokens": max_tokens,
                    })
                    receipt = {
                        "call_id": f"failure-planner-{len(owner.calls)}", "role": role,
                        "model": "FAILURE-PLANNER-TEST-DOUBLE", "status": "started",
                        "reserved_completion_tokens": max_tokens, "max_tokens": max_tokens,
                    }
                    reserve(receipt)
                    reserve({**receipt, "status": "completed",
                             "billing_status": "usage_reported",
                             "usage": {"prompt_tokens": 1, "completion_tokens": 1,
                                       "total_tokens": 2}})
                    if role.startswith("task-role://replanner/"):
                        assert prompt == planner_prompt
                        assert payload["schema"] == "nexgent.plan-revision-checkpoint.v1"
                        assert payload["trigger_node"] == "attempt"
                        assert payload["trigger_receipt"]["status"] == "failed"
                        assert payload["trigger_receipt"]["value"]["error_type"] == "RuntimeError"
                        assert "controlled checkpoint failure" in (
                            payload["trigger_receipt"]["value"]["error"])
                        assert payload["base_plan_ref"].startswith("plan-")
                        assert max_tokens == 5000
                        if owner.stop_after_planner:
                            owner.stop_after_planner = False
                            stop_event.set()
                        return {"proposal": repaired_graph}
                    assert role == "repair"
                    assert payload["failure"]["error_type"] == "RuntimeError"
                    return {"answer": "repaired after durable failure"}

            return Gateway()

    tool_calls = []

    def fail(arguments, context):
        tool_calls.append(arguments)
        raise RuntimeError("controlled checkpoint failure")

    tool = ToolSpec(
        "checkpoint.fail", {"type": "object"}, {"type": "object"},
        "local_compute", fail,
    )
    gateway = FailurePlannerGatewayFactory()
    service = TaskService(
        tmp_path, tools=ToolRegistry([tool]), gateway_factory=gateway)
    episode = service.create(
        "Recover by revising the remaining task graph",
        deliverables=[{"name": "result", "schema": {
            "type": "object",
            "properties": {"answer": {"const": "repaired after durable failure"}},
            "required": ["answer"],
        }}],
        capabilities=[tool.name], package=package,
        constraints={"allowed_effects": ["local_compute"]},
    )

    paused = service.run(episode["id"])

    assert paused["status"] == "paused"
    assert paused["plan_revision"] == 2
    assert paused["nodes"]["plan/nodes/attempt"]["status"] == "failed"
    assert service.store.rpc_find(
        episode["id"], "plan/revision-checkpoints/1/failure-replan"
    )["status"] == "completed"

    result = TaskService(
        tmp_path, tools=ToolRegistry([tool]), gateway_factory=gateway,
    ).run(episode["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert result["plan_revision"] == 2
    assert len(tool_calls) == 1
    assert len([call for call in gateway.calls
                if call["role"].startswith("task-role://replanner/")]) == 1
    assert [call["role"] for call in gateway.calls if call["role"] == "stale"] == []
    assert gateway.calls[-1]["role"] == "repair"
    assert result["nodes"]["plan/nodes/attempt"]["status"] == "failed"
    delivered = service.store.read(result["output_refs"]["result"], episode["id"])
    assert delivered["content"] == {"answer": "repaired after durable failure"}
