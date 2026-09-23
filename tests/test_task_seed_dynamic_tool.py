"""Default task-agent integration for Episode-scoped tool development."""

from copy import deepcopy
import json
import threading

from nexgent.tasks.capability_authority import make_episode_authority
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.seed import default_package
from nexgent.tasks.tools import ToolRegistry


class DynamicToolGateway:
    def __init__(self, policy):
        self.policy = policy
        self.calls = []
        self.task_decisions = 0
        self.lock = threading.Lock()

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                with owner.lock:
                    number = len(owner.calls) + 1
                    if role == "task_agent":
                        owner.task_decisions += 1
                        decision = owner.task_decisions
                    else:
                        decision = None
                    owner.calls.append({
                        "role": role,
                        "prompt": prompt,
                        "payload": deepcopy(payload),
                    })
                receipt = {
                    "call_id": "dynamic-seed-" + str(number),
                    "role": role,
                    "model": "DETERMINISTIC-DYNAMIC-SEED",
                    "status": "started",
                    "reserved_completion_tokens": max_tokens,
                    "max_tokens": max_tokens,
                }
                reserve(receipt)
                if role == "task_reviewer":
                    result = {"approved": True, "findings": [], "repairs": []}
                elif role == "recover":
                    result = {
                        "diagnosis": "Use the supported action protocol.",
                        "repairs": [],
                        "next_action": "Choose one supported action.",
                    }
                else:
                    result = owner.policy(decision, deepcopy(payload), prompt)
                reserve({
                    **receipt,
                    "status": "completed",
                    "billing_status": "usage_reported",
                    "usage": {
                        "prompt_tokens": 5,
                        "completion_tokens": 7,
                        "total_tokens": 12,
                    },
                })
                return result

        return Gateway()


def _result_spec():
    return [{
        "name": "result",
        "schema": {
            "type": "object",
            "properties": {"answer": {"type": "integer"}},
            "required": ["answer"],
            "additionalProperties": False,
        },
    }]


def _published_id(payload):
    observations = [
        item for item in payload["history"]
        if item.get("kind") == "observation" and item.get("ok")
    ]
    return observations[-1]["result"]["id"]


def _proposal():
    return {
        "name": "task.square",
        "description": "Square an integer for this task.",
        "source": (
            "def execute(payload, context):\n"
            "    return {'answer': payload['value'] * payload['value']}\n"
        ),
        "input_schema": {
            "type": "object",
            "properties": {"value": {"type": "integer"}},
            "required": ["value"],
            "additionalProperties": False,
        },
        "output_schema": {
            "type": "object",
            "properties": {"answer": {"type": "integer"}},
            "required": ["answer"],
            "additionalProperties": False,
        },
    }


def test_default_agent_develops_reinventories_uses_and_delivers_tool(tmp_path):
    proposal = _proposal()

    def policy(decision, payload, prompt):
        if decision == 1:
            development = payload["task"]["capability_development"]
            assert development["enabled"] is True
            assert development["allowed_kinds"] == ["tool"]
            assert development["allowed_effects"] == ["local_compute"]
            assert development["actions"] == [
                "develop_tool", "capability_inventory"
            ]
            encoded = json.dumps(payload["task"], sort_keys=True)
            assert "credential_handles" not in encoded
            assert "digest" not in development
            assert payload["task"]["tools"] == []
            assert "Task-time capability development is enabled" in prompt
            return {
                "request": {
                    "method": "develop_tool",
                    "params": {"proposal": proposal},
                }
            }
        if decision == 2:
            tools = payload["task"]["tools"]
            assert [tool["name"] for tool in tools] == ["task.square"]
            assert tools[0]["input_schema"] == proposal["input_schema"]
            observation = payload["history"][-1]
            assert observation["ok"] is True
            assert observation["request"]["method"] == "develop_tool"
            projected = observation["request"]["params"]["proposal"]
            assert "source" not in projected
            assert projected["source_omitted"] is True
            assert observation["result"]["name"] == "task.square"
            return {
                "request": {
                    "method": "tool",
                    "params": {"name": "task.square", "arguments": {"value": 9}},
                }
            }
        if decision == 3:
            assert payload["history"][-1]["result"] == {"answer": 81}
            return {
                "request": {
                    "method": "publish",
                    "params": {"name": "result", "content": {"answer": 81}},
                }
            }
        return {
            "done": {
                "deliverables": {"result": _published_id(payload)},
                "summary": "Developed and executed a task-local computation.",
                "limitations": [],
            }
        }

    gateway = DynamicToolGateway(policy)
    service = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway
    )
    authority = make_episode_authority(
        ["tool"], ["local_compute"], max_definitions=2, max_invocations=2
    )
    episode = service.create(
        "Compute a checked square without a preinstalled operation",
        deliverables=_result_spec(),
        capability_authority=authority,
    )
    completed = service.run(episode["id"])

    assert completed["status"] == "completed", completed.get("last_error")
    assert service.store.read(
        completed["output_refs"]["result"], episode["id"]
    )["content"] == {"answer": 81}
    assert service.store.tool_instances(episode["id"], active_only=True)[0][
        "name"
    ] == "task.square"
    receipts = [
        event["content"] for event in service.store.events(episode["id"])
        if event["kind"] == "tool"
    ]
    assert receipts[-1]["name"] == "task.square"
    assert receipts[-1]["status"] == "completed"
    assert receipts[-1]["dynamic_capability"]["authority_digest"] == authority["digest"]


def test_default_agent_keeps_development_hidden_without_authority(tmp_path):
    package = default_package()
    assert package == default_package()

    def policy(decision, payload, prompt):
        assert "capability_development" not in payload["task"]
        assert "Task-time capability development is enabled" not in prompt
        if decision == 1:
            return {
                "request": {
                    "method": "publish",
                    "params": {"name": "result", "content": {"answer": 4}},
                }
            }
        return {
            "done": {
                "deliverables": {"result": _published_id(payload)},
                "summary": "Used the legacy default action path.",
                "limitations": [],
            }
        }

    gateway = DynamicToolGateway(policy)
    service = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway
    )
    episode = service.create(
        "Preserve ordinary default task behavior",
        deliverables=_result_spec(),
    )
    assert episode["package_digest"] == package["digest"]

    completed = service.run(episode["id"])

    assert completed["status"] == "completed", completed.get("last_error")
    assert "prompts/capability_development.md" not in completed["execution"][
        "loaded_modules"
    ]
