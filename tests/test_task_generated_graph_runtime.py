"""A model-produced graph changes the live episode and survives a pause."""

import json

from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
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
           for role in ("architect", "alpha", "beta")},
    }
    manifest = {
        "manifest_version": 2,
        "entries": {"execute": "agent/main.py:execute"},
        "skills": {},
        "roles": {
            role: {"prompt_ref": f"prompts/{role}.md", "capabilities": ["ask"]}
            for role in ("architect", "alpha", "beta")
        },
        "workflows": {"main": {"ref": "workflows/main.json", "max_parallel": 2,
                               "input_schema": {"type": "object"},
                               "output_schema": {"type": "object"}}},
        "components": {
            "main-workflow": {"class": "O", "kind": "workflow", "ref": "main"},
            **{f"{role}-role": {"class": "S", "kind": "role", "ref": role}
               for role in ("architect", "alpha", "beta")},
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
