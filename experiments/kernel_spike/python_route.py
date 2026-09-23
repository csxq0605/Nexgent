"""Disposable Stage A Python route spike; deliberately not a production plugin API.

Run with this checkout's ``src`` on PYTHONPATH. It uses a hand-written trusted
handler and a model-interface double. The immutable Episode task blocks a
task-time grant, which is an observed result, not something this spike bypasses.
"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import inspect
import json
from pathlib import Path
import tempfile
import threading

from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ContractError, ToolRegistry, ToolSpec


SOURCE = """def execute(payload, context):
    decision = context.ask('calculator', 'Choose a tool for 6 times 7.',
                           {'tools': payload['tools']}, max_tokens=64)
    result = context.tool(decision['tool'], decision['arguments'])
    artifact = context.publish({'answer': result['value']}, name='result')
    return {'deliverables': {'result': artifact['id']}}
"""
def multiply(arguments, context):
    return {"value": arguments["left"] * arguments["right"]}


HANDLER_DIGEST = hashlib.sha256(inspect.getsource(multiply).encode()).hexdigest()


def tool_spec():
    integer = {"type": "integer"}
    return ToolSpec(
        "spike.multiply",
        {"type": "object", "properties": {"left": integer, "right": integer},
         "required": ["left", "right"], "additionalProperties": False},
        {"type": "object", "properties": {"value": integer},
         "required": ["value"], "additionalProperties": False},
        "local_compute", multiply, description="Multiply two integers",
    )


class FixedModelInterface:
    """Same decision envelope used by the second backend; no external model call."""

    def __init__(self):
        self.requests = []

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                assert any(tool["name"] == "spike.multiply" for tool in payload["tools"])
                owner.requests.append({"role": role, "prompt": prompt,
                                       "payload": deepcopy(payload), "max_tokens": max_tokens})
                receipt = {"call_id": f"kernel-spike-{len(owner.requests)}", "role": role,
                           "model": "fixed-model-interface", "status": "started",
                           "reserved_completion_tokens": max_tokens, "max_tokens": max_tokens}
                reserve(receipt)
                reserve({**receipt, "status": "completed", "billing_status": "usage_reported",
                         "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
                return {"tool": "spike.multiply", "arguments": {"left": 6, "right": 7}}

        return Gateway()


def package():
    return make_package({"agent/main.py": SOURCE},
                        {"entries": {"execute": "agent/main.py:execute"}})


def run(project_root):
    """Exercise the available path and report the common-contract blockers."""
    root = Path(project_root)
    model = FixedModelInterface()
    spec = tool_spec()
    registry = ToolRegistry([spec])
    service = TaskService(root, tools=registry, gateway_factory=model)
    deliverables = [{"name": "result", "schema": {
        "type": "object", "properties": {"answer": {"const": 42}},
        "required": ["answer"], "additionalProperties": False}}]
    candidate = package()
    empty = service.create("Compute 6 × 7", deliverables=deliverables,
                           capabilities=[], package=candidate)
    assert service.store.get(empty["id"])["task"]["tools"] == []
    try:
        service._change(empty["id"], lambda current: current["capabilities"].append(spec.name))
    except PermissionError as exc:
        task_time_mount = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    else:
        raise AssertionError("Task-time capability mutation unexpectedly succeeded")

    # Existing Python path can execute the same model/tool flow if the tool
    # was registered and granted before Episode creation.
    state = service.create("Compute 6 × 7", deliverables=deliverables,
                           capabilities=[spec.name], package=candidate)
    identity = state["id"]
    second = service.create("Separate scope", deliverables=deliverables,
                            capabilities=[], package=candidate)
    assert spec.name not in service.store.get(second["id"])["capabilities"]

    result = service.run(identity)
    assert result["status"] == "completed", result.get("last_error")
    content = service.store.read(result["output_refs"]["result"], identity)["content"]
    assert content == {"answer": 42}

    # Baseline ToolRegistry has no public unregister. This process-wide
    # removal proves it is not a task-scoped lifecycle implementation.
    registry._tools.pop(spec.name)  # No public unregister API in the baseline.
    blocked = []
    for target in (identity, second["id"]):
        try:
            service._invoke(target, candidate, "tool", {"name": spec.name,
                "arguments": {"left": 6, "right": 7}}, "spike/blocked",
                threading.Event(), lambda: None)
        except (PermissionError, ContractError) as exc:
            blocked.append({"episode": target, "reason": type(exc).__name__})
    assert len(blocked) == 2
    events = service.store.events(identity)
    tool_events = [item for item in events if item["kind"] == "tool"]
    assert len(tool_events) == 1 and tool_events[0]["content"]["status"] == "completed"
    assert len(model.requests) == 1
    return {
        "backend": "nexgent-python-3919a0d-spike",
        "model": "fixed-model-interface", "episode_id": identity,
        "other_episode_id": second["id"], "package_digest": candidate["digest"],
        "handler_digest": HANDLER_DIGEST, "answer": content["answer"],
        "task_time_mount": task_time_mount, "initial_tool_scope_empty": True,
        "model_calls": result["usage"]["model_calls"],
        "tool_calls": result["usage"]["tool_calls"],
        "tool_event": tool_events[0]["content"], "blocked_after_unmount": blocked,
        "private_adapter_used": ["TaskService._change", "ToolRegistry._tools", "TaskService._invoke"],
        "limitations": ["trusted in-process handler", "no real model call",
                        "grant must predate Episode", "unload is process-wide",
                        "no durable handler reload after process restart",
                        "no transactional public mount/unmount API"],
    }


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="nexgent-kernel-spike-",
                                     ignore_cleanup_errors=True) as directory:
        print(json.dumps(run(directory), ensure_ascii=False, indent=2))
