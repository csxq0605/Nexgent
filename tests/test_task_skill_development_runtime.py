"""A task-time agent invents a skill and uses it through a child Episode."""

from nexgent.tasks.runtime import TaskService
from nexgent.tasks.self_orchestration_seed import self_orchestration_package
from nexgent.tasks.task_skill_compiler import TASK_SKILL_PROPOSAL_SCHEMA


RESULT_SPEC = [{"name": "result", "schema": {
    "type": "object", "required": ["answer"],
    "properties": {"answer": {"type": "integer"}},
}}]


def _invented_skill():
    return {
        "schema": TASK_SKILL_PROPOSAL_SCHEMA,
        "skill": {
            "name": "double_value", "entrypoint": "solve",
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
            "failure_mechanism": "the current team lacks a reusable transform",
            "expected_behavior": "a compiled skill doubles the supplied value",
            "applicability": "tasks needing this numeric transform",
            "falsifier": "the delegated child fails or returns a wrong value",
        },
    }


def _graph():
    nodes = [
        {"id": "coder", "method": "ask", "role_ref": "generalist",
         "component_ref": "generalist-role", "params": {"max_tokens": 800},
         "bindings": {"payload": {"task": {"$input": ""}}}},
        {"id": "develop", "method": "develop_skill", "params": {
            "constraints": {"allowed_rpc_methods": ["read_artifact"], "allowed_tools": [],
                            "max_patch_bytes": 300000}},
         "bindings": {"proposal": {"$node": "coder"}}},
        {"id": "use_skill", "method": "delegate", "bindings": {
            "package_id": {"$node": "develop.package_id"},
            "task": {
                "objective": {"$input": "objective"},
                "input_refs": {"$input": "input_refs"},
                "deliverables": {"$input": "deliverables"},
                "capabilities": {"$input": "capabilities"},
            },
        }},
    ]
    return {
        "replaced_node_ids": ["slot"],
        "operations": [
            {"op": "remove_node", "node_id": "slot"},
            *[{"op": "add_node", "node": node} for node in nodes],
            {"op": "add_control_edge", "edge": {"from": "architect", "to": "coder"}},
        ],
        "outputs": {"deliverables": {
            "result": {"$node": "use_skill.output_refs.result"}}},
        "revision_rules": [],
    }


class DevelopmentGateway:
    def __init__(self, parent):
        self.parent = parent
        self.roles = []

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                owner.roles.append(role)
                receipt = {"call_id": f"develop-{len(owner.roles)}",
                           "role": role, "model": "DETERMINISTIC-DEVELOPMENT",
                           "status": "started", "max_tokens": max_tokens,
                           "reserved_completion_tokens": max_tokens}
                reserve(receipt)
                reserve({**receipt, "status": "completed",
                         "billing_status": "usage_reported",
                         "usage": {"prompt_tokens": 1, "completion_tokens": 1,
                                   "total_tokens": 2}})
                if role == "architect":
                    return {"proposal": _graph()}
                return _invented_skill()

        return Gateway()


def test_agent_invents_compiles_and_uses_skill_during_its_task(tmp_path):
    parent = self_orchestration_package()
    gateway = DevelopmentGateway(parent)
    service = TaskService(tmp_path, gateway_factory=gateway)
    episode = service.create(
        "Double the supplied number", inputs={"value": 21},
        deliverables=RESULT_SPEC, package=parent,
        budget={"max_model_calls": 6, "max_completion_tokens": 24000},
    )

    result = service.run(episode["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert gateway.roles == ["architect", "generalist"]
    assert result["plan_revision"] == 2
    assert result["nodes"]["plan/nodes/develop"]["status"] == "completed"
    assert result["nodes"]["plan/nodes/use_skill"]["status"] == "completed"
    assert len(result["child_episode_ids"]) == 1
    child = service.get(result["child_episode_ids"][0])
    assert child["status"] == "completed"
    assert "skills/task_time/double_value.py" in child["execution"]["loaded_modules"]
    assert service.store.read(result["output_refs"]["result"], episode["id"])[
        "content"] == {"answer": 42}
    assert any(event["kind"] == "task_skill_compiled" for event in result["events"])
