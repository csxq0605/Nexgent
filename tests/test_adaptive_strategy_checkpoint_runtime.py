import json
from copy import deepcopy

import pytest

from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.strategy_decisions import CANDIDATE_SET_SCHEMA
from nexgent.tasks.tools import ToolRegistry


RESULT_SPEC = [{
    "name": "result",
    "schema": {"type": "object", "required": ["answer"]},
}]


def checkpoint_package(failure_domain="agent"):
    workflow = {
        "nodes": [
            {
                "id": "inspect",
                "method": "join",
                "params": {"feedback": {
                    "failure_domain": failure_domain,
                    "finding": "The DAG needs an adaptive recovery.",
                }},
            },
            {
                "id": "finish",
                "method": "publish",
                "params": {
                    "name": "result",
                    "schema": RESULT_SPEC[0]["schema"],
                    "content": {"answer": "dag"},
                },
            },
        ],
        "control_edges": [{"from": "inspect", "to": "finish"}],
        "outputs": {"deliverables": {"result": {"$node": "finish.id"}}},
        "strategy_checkpoint_rules": [{
            "id": "inspect-feedback",
            "after_node": "inspect",
            "feedback_path": "feedback",
        }],
    }
    source = """
def execute(task, context):
    handoff = context.read_artifact(task['strategy_handoff_ref'])
    result = context.publish({
        'answer': 'switched',
        'episode_id': handoff['content']['episode_id'],
        'failure_domain': handoff['content']['trigger']['failure_domain'],
    }, name='result', schema={'type': 'object', 'required': ['answer']})
    return {
        'deliverables': {'result': result['id']},
        'summary': 'continued from the durable strategy handoff',
        'limitations': [],
    }
"""
    return make_package({
        "agent.py": source,
        "workflows/main.json": json.dumps(workflow),
        "prompts/selector.md": "Select only from the frozen candidates.",
    }, {
        "manifest_version": 2,
        "entries": {"execute": "agent.py:execute"},
        "skills": {},
        "roles": {"strategy_selector": {
            "prompt_ref": "prompts/selector.md",
            "capabilities": ["ask"],
        }},
        "workflows": {"main": {
            "ref": "workflows/main.json", "max_parallel": 1,
        }},
        "components": {
            "dag-main": {"class": "O", "kind": "workflow", "ref": "main"},
            "open-loop": {"class": "O", "kind": "entry", "ref": "execute"},
            "selector-role": {
                "class": "S", "kind": "role", "ref": "strategy_selector",
            },
        },
        "orchestrator": "dag-main",
        "strategy_candidates": {
            "schema": CANDIDATE_SET_SCHEMA,
            "component_ids": ["dag-main", "open-loop"],
            "selector_component_id": "selector-role",
        },
    })


def two_checkpoint_package():
    package = checkpoint_package()
    files = deepcopy(package["files"])
    manifest = deepcopy(package["manifest"])
    workflow = json.loads(files["workflows/main.json"])
    workflow["nodes"].insert(1, {
        "id": "inspect-again",
        "method": "join",
        "params": {"feedback": {
            "failure_domain": "agent",
            "finding": "The second checkpoint needs the open loop.",
        }},
    })
    workflow["control_edges"] = [
        {"from": "inspect", "to": "inspect-again"},
        {"from": "inspect-again", "to": "finish"},
    ]
    workflow["strategy_checkpoint_rules"] = [
        {
            "id": "inspect-feedback",
            "after_node": "inspect",
            "feedback_path": "feedback",
        },
        {
            "id": "inspect-again-feedback",
            "after_node": "inspect-again",
            "feedback_path": "feedback",
        },
    ]
    files["workflows/main.json"] = json.dumps(workflow)
    return make_package(files, manifest)


class CheckpointGateway:
    def __init__(self, checkpoint_target="open-loop"):
        self.checkpoint_targets = (
            list(checkpoint_target) if isinstance(checkpoint_target, list)
            else [checkpoint_target])
        self.checkpoint_index = 0
        self.calls = []

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                number = len(owner.calls) + 1
                owner.calls.append(deepcopy(payload))
                receipt = {
                    "call_id": f"checkpoint-gateway-{number}",
                    "role": role,
                    "model": "CHECKPOINT-TEST-DOUBLE",
                    "request_digest": f"checkpoint-request-{number}",
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
                        "prompt_tokens": 2,
                        "completion_tokens": 3,
                        "total_tokens": 5,
                    },
                })
                if payload["schema"] == "nexgent.strategy-selection-request.v1":
                    return {
                        "selected_component_id": "dag-main",
                        "basis": ["Use the checkpoint-enabled DAG first."],
                        "stop_conditions": ["A result is published."],
                        "estimated_cost": {"model_calls": 2, "nodes": 4},
                    }
                assert payload["schema"] == "nexgent.strategy-checkpoint-selection.v1"
                target = owner.checkpoint_targets[min(
                    owner.checkpoint_index, len(owner.checkpoint_targets) - 1)]
                owner.checkpoint_index += 1
                return {
                    "target_component_id": target,
                    "reason": ("Continue the DAG." if target is None
                               else "The attributable feedback needs the open loop."),
                }

        return Gateway()


def make_service(tmp_path, gateway, *, failure_domain="agent"):
    service = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    episode = service.create(
        "Switch strategy after attributable feedback",
        deliverables=RESULT_SPEC,
        package=checkpoint_package(failure_domain),
    )
    return service, episode


def test_completed_feedback_switches_to_entry_in_the_same_episode(tmp_path):
    gateway = CheckpointGateway()
    service, episode = make_service(tmp_path, gateway)

    result = service.run(episode["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert result["id"] == episode["id"]
    assert result["root_episode_id"] == episode["root_episode_id"]
    checkpoint = result["strategy_checkpoint"]
    assert checkpoint["resolution"]["selected_component_id"] == "open-loop"
    assert checkpoint["plan"]["pending_node_ids"] == ["finish"]
    handoff = service.store.read(
        checkpoint["handoff_artifact"]["ref"], episode["id"])
    assert handoff["content"]["trigger"]["failure_domain"] == "agent"
    delivered = service.store.read(result["output_refs"]["result"], episode["id"])
    assert delivered["content"] == {
        "answer": "switched",
        "episode_id": episode["id"],
        "failure_domain": "agent",
    }
    assert service.store.rpc_find(episode["id"], "plan/nodes/finish") is None
    switched_paths = [
        event["content"]["call_path"] for event in result["events"]
        if (event["kind"] == "rpc_started"
            and event["content"]["call_path"].startswith(
                "strategy/segments/2/rpc."))
    ]
    assert switched_paths == [
        "strategy/segments/2/rpc.1",
        "strategy/segments/2/rpc.2",
        "strategy/segments/2/rpc.3",
    ]
    assert [call["schema"] for call in gateway.calls] == [
        "nexgent.strategy-selection-request.v1",
        "nexgent.strategy-checkpoint-selection.v1",
    ]


def test_checkpoint_continue_is_durable_and_finishes_the_dag(tmp_path):
    gateway = CheckpointGateway(checkpoint_target=None)
    service, episode = make_service(tmp_path, gateway)

    result = service.run(episode["id"])

    assert result["status"] == "completed", result.get("last_error")
    delivered = service.store.read(result["output_refs"]["result"], episode["id"])
    assert delivered["content"] == {"answer": "dag"}
    assert "strategy_checkpoint" not in result
    continued = [event for event in result["events"]
                 if event["kind"] == "strategy_checkpoint_continued"]
    assert len(continued) == 1
    assert result["usage"]["model_calls"] == 2


def test_two_rules_use_distinct_selector_slots_before_continue_then_switch(tmp_path):
    gateway = CheckpointGateway([None, "open-loop"])
    service = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    episode = service.create(
        "Continue once, then switch at the second durable checkpoint",
        deliverables=RESULT_SPEC,
        package=two_checkpoint_package(),
    )

    result = service.run(episode["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert result["strategy_checkpoint"]["trigger"]["node_id"] == "inspect-again"
    segment_paths = [
        event["content"]["call_path"] for event in result["events"]
        if (event["kind"] == "rpc_started"
            and event["content"]["call_path"].startswith(
                "strategy/segments/2/rpc."))
    ]
    assert segment_paths == [
        "strategy/segments/2/rpc.1",
        "strategy/segments/2/rpc.2",
        "strategy/segments/2/rpc.3",
        "strategy/segments/2/rpc.4",
    ]
    assert service.store.rpc_find(episode["id"], "plan/nodes/finish") is None


@pytest.mark.parametrize("failure_domain", ["infrastructure", "unknown"])
def test_non_attributable_feedback_never_calls_checkpoint_selector(
        tmp_path, failure_domain):
    gateway = CheckpointGateway()
    service, episode = make_service(
        tmp_path, gateway, failure_domain=failure_domain)

    result = service.run(episode["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert [call["schema"] for call in gateway.calls] == [
        "nexgent.strategy-selection-request.v1"]
    assert not [event for event in result["events"]
                if event["kind"].startswith("strategy_checkpoint")]


def test_committed_checkpoint_recovery_routes_directly_without_double_charge(
        tmp_path):
    gateway = CheckpointGateway()
    service, episode = make_service(tmp_path, gateway)
    original_commit = service.store.commit_strategy_checkpoint
    interrupted = {"value": False}

    def interrupt_after_commit(*args, **kwargs):
        result = original_commit(*args, **kwargs)
        if not interrupted["value"]:
            interrupted["value"] = True
            raise RuntimeError("process stopped after checkpoint commit")
        return result

    service.store.commit_strategy_checkpoint = interrupt_after_commit
    first = service.run(episode["id"])
    resumed = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway).run(episode["id"])

    assert first["status"] == "failed"
    assert resumed["status"] == "completed", resumed.get("last_error")
    assert resumed["usage"]["model_calls"] == 2
    assert [call["schema"] for call in gateway.calls].count(
        "nexgent.strategy-checkpoint-selection.v1") == 1
    assert service.store.rpc_find(episode["id"], "plan/nodes/finish") is None
    assert len([event for event in resumed["events"]
                if event["kind"] == "strategy_checkpoint"]) == 1
