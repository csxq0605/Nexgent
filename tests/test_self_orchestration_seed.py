import json

from nexgent.tasks.packages import verify_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.self_orchestration_seed import self_orchestration_package
from nexgent.tasks.workflows import plan_from_workflow


def test_self_orchestration_seed_compiles_without_a_fixed_team_topology():
    package = self_orchestration_package()

    verify_package(package)
    workflow = json.loads(package["files"]["workflows/main.json"])
    plan = plan_from_workflow(workflow, package["manifest"]["orchestrator"])

    assert [node.id for node in plan.nodes] == ["architect", "slot"]
    assert workflow["control_edges"] == [{"from": "architect", "to": "slot"}]
    assert workflow["revision_rules"] == [{
        "id": "architect-graph",
        "after_node": "architect",
        "when": {"path": "$status", "equals": "completed"},
        "proposal_path": "proposal",
        "max_compile_attempts": 3,
    }]
    assert len(package["manifest"]["roles"]) > 3
    assert package["provenance"]["activation"] == "opt-in"

    prompt = package["files"]["prompts/architect.md"]
    assert '"replaced_node_ids":["slot"]' in prompt
    assert '"op":"remove_node","node_id":"slot"' in prompt
    assert "available_roles" in prompt
    assert "revision_rules" in prompt
    assert all(term not in prompt.casefold()
               for term in ("benchmark", "openfoam", "scientific discovery"))


class _SelfOrchestrationGatewayFactory:
    def __init__(self):
        self.roles = []

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                owner.roles.append(role)
                receipt = {
                    "call_id": f"self-graph-{len(owner.roles)}",
                    "role": role,
                    "model": "SELF-GRAPH-TEST-DOUBLE",
                    "status": "started",
                    "reserved_completion_tokens": max_tokens,
                    "max_tokens": max_tokens,
                }
                reserve(receipt)
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
                if role == "architect":
                    return {"proposal": {
                        "replaced_node_ids": ["slot"],
                        "operations": [
                            {"op": "remove_node", "node_id": "slot"},
                            {"op": "add_node", "node": {
                                "id": "worker",
                                "method": "ask",
                                "role_ref": "generalist",
                                "component_ref": "generalist-role",
                                "params": {
                                    "max_tokens": 1200,
                                    "prompt": "Return the requested result as JSON.",
                                },
                                "bindings": {
                                    "payload": {"task": {"$input": ""}},
                                },
                            }},
                            {"op": "add_node", "node": {
                                "id": "publish",
                                "method": "publish",
                                "params": {"name": "result"},
                                "bindings": {
                                    "content": {"$node": "worker"},
                                },
                            }},
                            {"op": "add_control_edge", "edge": {
                                "from": "architect", "to": "worker",
                            }},
                        ],
                        "outputs": {
                            "deliverables": {
                                "result": {"$node": "publish.id"},
                            },
                        },
                        "revision_rules": [],
                    }}
                return {"answer": "done"}

        return Gateway()


def test_self_orchestration_seed_executes_a_model_authored_graph(tmp_path):
    gateway = _SelfOrchestrationGatewayFactory()
    service = TaskService(tmp_path, gateway_factory=gateway)
    episode = service.create(
        "Return a small structured result",
        deliverables=[{
            "name": "result",
            "schema": {"type": "object", "required": ["answer"]},
        }],
        package=self_orchestration_package(),
    )

    result = service.run(episode["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert result["plan_revision"] == 2
    assert gateway.roles == ["architect", "generalist"]
    artifact = service.store.read(result["output_refs"]["result"], episode["id"])
    assert artifact["content"] == {"answer": "done"}
