"""One bounded MiMo probe of model-authored, Episode-local tool development.

The task starts with no tool names. The model writes the tool source and schema;
Nexgent compiles, mounts, rediscovers and invokes the resulting Definition.
This diagnostic is not an RSI benefit or cross-task adoption experiment.
"""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import threading

from nexgent.models.gateway import ModelGateway
from nexgent.tasks.capability_authority import make_episode_authority
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ToolRegistry

from python_live_route import (
    MODEL_SOURCE_ROOT, _failure_receipt, _leak_free, _live_transport,
    _load_live_profile, _safe_call_receipt,
)


BUDGET = {
    "max_model_calls": 2, "max_completion_tokens": 1400,
    "max_tool_calls": 1, "max_tool_work_units": 0, "max_nodes": 12,
}

SOURCE = '''def execute(payload, context):
    before = context.capability_inventory()
    decision = context.ask(
        "tool_builder",
        "Return one JSON object with exactly proposal and arguments. You are "
        "writing a new task-local Python tool for the objective. proposal must "
        "have exactly name, description, source, input_schema, output_schema. "
        "source must define exactly def execute(payload, context): and return "
        "a JSON object. Do not use context, imports, files, network, markdown, "
        "or preinstalled tools. Choose a fresh tool name. The arguments object "
        "must match input_schema and achieve the objective when the tool runs.",
        {"objective": payload["objective"], "current_tools": before["tools"]},
        max_tokens=1000,
    )
    developed = context.develop_tool(decision["proposal"])
    after = context.capability_inventory()
    names = [item["name"] for item in after["tools"]]
    if developed["name"] not in names:
        raise ValueError("New task-local tool is absent from active inventory")
    value = context.tool(developed["name"], decision["arguments"])
    final = context.ask(
        "answer_writer",
        "Return exactly one JSON object with the single integer field answer. "
        "Use the completed tool result; do not invent a different value.",
        {"objective": payload["objective"], "tool_result": value},
        max_tokens=300,
    )
    artifact = context.publish({"answer": final["answer"], "tool_result": value,
                                "developed": developed}, name="result")
    return {"deliverables": {"result": artifact["id"]}}
'''


def run():
    project_root = Path(tempfile.mkdtemp(
        prefix=".nexgent-dynamic-live-", dir=MODEL_SOURCE_ROOT.parent)).resolve()
    profile, profile_identity, profile_digest = _load_live_profile()

    def gateway_factory(reserve, stop_event):
        def audited_reserve(receipt):
            receipt = deepcopy(receipt)
            receipt["profile_identity"] = deepcopy(profile_identity)
            receipt["profile_digest"] = profile_digest
            reserve(receipt)

        gateway = ModelGateway(
            MODEL_SOURCE_ROOT, reserve=audited_reserve, stop_event=stop_event,
            timeout=90, transport=_live_transport, max_completion_tokens=1000)
        gateway.profiles = {profile.id: profile}
        gateway.defaults = {"main": profile.id, "subagent": profile.id,
                            "tool_builder": profile.id, "answer_writer": profile.id}
        return gateway

    package = make_package({"agent/main.py": SOURCE},
                           {"entries": {"execute": "agent/main.py:execute"}})
    service = TaskService(project_root, tools=ToolRegistry(),
                          gateway_factory=gateway_factory)
    episode = service.create(
        "Develop a reusable task-local tool to multiply 6 by 7, call it, and deliver the integer answer.",
        package=package, capabilities=[],
        capability_authority=make_episode_authority(
            ["tool"], ["local_compute"], max_definitions=1, max_invocations=1),
        budget=BUDGET, constraints={"allowed_effects": ["local_compute"],
                                    "wall_seconds": 240},
        deliverables=[{"name": "result", "schema": {
            "type": "object", "properties": {"answer": {"const": 42}},
            "required": ["answer"], "additionalProperties": True}}],
    )
    episode_id = episode["id"]
    service.run(episode_id, stop_event=threading.Event())
    state = service.get_private(episode_id)
    calls = state.get("calls", [])
    definitions = []
    for instance in service.store.tool_instances(episode_id):
        definition = service.store.tool_definition(instance["definition_id"])
        definitions.append({"definition": definition, "instance": instance,
                            "source": service.store.package(
                                definition["package_id"])["files"]["tool.py"]})
    report = {
        "schema": "nexgent.dynamic-tool-live.v1",
        "passed": state["status"] == "completed",
        "profile_identity": profile_identity,
        "profile_digest": profile_digest,
        "retry_policy": {"automatic_retries": 0, "attempts_per_ask": 1},
        "budget": BUDGET,
        "episode": {"id": episode_id, "status": state["status"],
                    "package_digest": state["package_digest"],
                    "output_refs": state.get("output_refs", {}),
                    "usage": state.get("usage", {}),
                    "last_error": state.get("last_error")},
        "model_receipts": [_safe_call_receipt(row) for row in calls],
        "definitions": definitions,
        "tool_receipts": [row["content"] for row in state.get("events", [])
                          if row["kind"] == "tool"],
        "artifacts": [{key: deepcopy(row[key]) for key in
                       ("id", "name", "content", "node_id") if key in row}
                      for row in state.get("artifacts", [])],
        "failure": _failure_receipt(state, calls),
        "scratch_root": str(project_root),
        "interpretation": "Task-local tool development only; no service plugin, adoption, or RSI gain.",
    }
    secret = profile.api_key
    serialized = json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2)
    report["leak_scan_passed"] = _leak_free(project_root, serialized, secret)
    if not report["leak_scan_passed"]:
        report = {"schema": "nexgent.dynamic-tool-live.v1", "passed": False,
                  "leak_scan_passed": False}
    output = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if report.get("leak_scan_passed"):
        (project_root / "dynamic-tool-live-summary.json").write_text(
            output, encoding="utf-8")
    print(output)
    return 0 if report.get("passed") else 1


if __name__ == "__main__":
    raise SystemExit(run())
