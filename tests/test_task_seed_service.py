"""Default task-agent integration for Episode-local model-context services."""

from copy import deepcopy
import json
import threading

from nexgent.tasks.capability_authority import make_episode_authority
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ToolRegistry


class ServiceSeedGateway:
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
                    "call_id": "service-seed-" + str(number),
                    "role": role,
                    "model": "DETERMINISTIC-SERVICE-SEED",
                    "status": "started",
                    "reserved_completion_tokens": max_tokens,
                    "max_tokens": max_tokens,
                }
                reserve(receipt)
                if role == "task_reviewer":
                    assert payload["provider_guidance"] == "check transformed context"
                    result = {"approved": True, "findings": [], "repairs": []}
                elif role == "recover":
                    result = {
                        "diagnosis": "Use the supported service lifecycle.",
                        "repairs": [],
                        "next_action": "Choose one supported serial action.",
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
            "properties": {"answer": {"type": "string"}},
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
        "name": "context.task_guidance",
        "description": "Add one checkable hint to model-visible task context.",
        "source": (
            "def provide(payload, context):\n"
            "    visible = payload['payload'].copy()\n"
            "    visible['provider_guidance'] = 'check transformed context'\n"
            "    return {'payload': visible, 'annotations': "
            "{'provider': 'context.task_guidance'}}\n"
        ),
    }


def test_default_agent_develops_activates_and_uses_model_context_service(tmp_path):
    proposal = _proposal()

    def policy(decision, payload, prompt):
        if decision == 1:
            development = payload["task"]["capability_development"]
            assert development["enabled"] is True
            assert development["allowed_kinds"] == ["service_provider"]
            assert development["allowed_effects"] == ["model_context"]
            assert development["actions"] == [
                "develop_service", "activate_service", "release_service",
                "capability_inventory",
            ]
            assert payload["task"]["services"] == {
                "model_context.v1": {"status": "empty", "revision": 0}
            }
            assert payload["task"]["tools"] == []
            assert "Task-time service development is enabled" in prompt
            assert "create one missing pure local-compute tool" not in prompt
            example = next(
                line for line in prompt.splitlines()
                if line.startswith(
                    '{"request": {"method": "develop_service"'
                )
            )
            assert json.loads(example)["request"]["method"] == "develop_service"
            assert "provider_guidance" not in payload
            encoded = json.dumps(payload["task"], sort_keys=True)
            assert "credential_handles" not in encoded
            assert "digest" not in development
            return {
                "request": {
                    "method": "develop_service",
                    "params": {"proposal": proposal},
                }
            }

        if decision == 2:
            assert "provider_guidance" not in payload
            observation = payload["history"][-1]
            assert observation["ok"] is True
            assert observation["request"]["method"] == "develop_service"
            projected = observation["request"]["params"]["proposal"]
            assert projected == {
                "name": proposal["name"],
                "description": proposal["description"],
                "source_omitted": True,
            }
            definition_id = observation["result"]["definition_id"]
            return {
                "request": {
                    "method": "activate_service",
                    "params": {
                        "definition_id": definition_id,
                        "expected_revision": 0,
                    },
                }
            }

        if decision == 3:
            assert payload["provider_guidance"] == "check transformed context"
            provider = payload["task"]["services"]["model_context.v1"]
            assert provider["status"] == "active"
            assert provider["revision"] == 1
            activation = payload["history"][-1]
            assert activation["request"]["method"] == "activate_service"
            assert activation["result"]["status"] == "active"
            return {
                "request": {
                    "method": "publish",
                    "params": {
                        "name": "result",
                        "content": {"answer": "context transformed"},
                    },
                }
            }

        assert payload["provider_guidance"] == "check transformed context"
        return {
            "done": {
                "deliverables": {"result": _published_id(payload)},
                "summary": "Developed and activated a task-local context provider.",
                "limitations": [],
            }
        }

    gateway = ServiceSeedGateway(policy)
    service = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway
    )
    authority = make_episode_authority(
        ["service_provider"], ["model_context"],
        max_definitions=2, max_invocations=8, version=2,
    )
    episode = service.create(
        "Improve model context within this task, then deliver evidence",
        deliverables=_result_spec(),
        capability_authority=authority,
    )

    completed = service.run(episode["id"])

    assert completed["status"] == "completed", completed.get("last_error")
    artifact = service.store.read(
        completed["output_refs"]["result"], episode["id"]
    )
    assert artifact["content"] == {"answer": "context transformed"}
    instance = service.store.service_instance(episode["id"])
    assert instance["status"] == "active"
    assert instance["revision"] == 1
    assert [call["role"] for call in gateway.calls] == [
        "task_agent", "task_agent", "task_agent", "task_agent",
        "task_reviewer",
    ]
    assert "provider_guidance" not in gateway.calls[0]["payload"]
    assert "provider_guidance" not in gateway.calls[1]["payload"]
    assert all(
        call["payload"].get("provider_guidance") == "check transformed context"
        for call in gateway.calls[2:]
    )
    applied = [
        event for event in service.store.events(episode["id"])
        if event["kind"] == "service_applied"
    ]
    assert len(applied) == 3
    serviced_calls = [
        call for call in service.store.calls(episode["id"])
        if call.get("service_provider")
    ]
    assert len(serviced_calls) == 3
    assert all(
        call["service_provider"]["authority_digest"] == authority["digest"]
        for call in serviced_calls
    )
