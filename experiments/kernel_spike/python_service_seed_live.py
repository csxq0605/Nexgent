"""One bounded MiMo trial of default-agent service development.

The ordinary TaskService seed, rather than a diagnostic package, selects the
service actions. This is a mechanism test on one task, not evidence of RSI gain.
"""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import threading

from nexgent.models.gateway import ModelGateway
from nexgent.tasks.capability_authority import make_episode_authority
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ToolRegistry

from python_live_route import (
    MODEL_SOURCE_ROOT, _failure_receipt, _leak_free, _live_transport,
    _load_live_profile, _safe_call_receipt,
)


BUDGET = {
    "max_model_calls": 8, "max_completion_tokens": 20000,
    "max_tool_calls": 8, "max_tool_work_units": 0, "max_nodes": 90,
}


def run():
    project_root = Path(tempfile.mkdtemp(
        prefix=".nexgent-service-seed-live-", dir=MODEL_SOURCE_ROOT.parent)).resolve()
    profile, profile_identity, profile_digest = _load_live_profile()

    def gateway_factory(reserve, stop_event):
        def audited_reserve(receipt):
            receipt = deepcopy(receipt)
            receipt["profile_identity"] = deepcopy(profile_identity)
            receipt["profile_digest"] = profile_digest
            reserve(receipt)

        gateway = ModelGateway(
            MODEL_SOURCE_ROOT, reserve=audited_reserve, stop_event=stop_event,
            timeout=90, transport=_live_transport, max_completion_tokens=3000)
        gateway.profiles = {profile.id: profile}
        gateway.defaults = {"main": profile.id, "subagent": profile.id}
        return gateway

    service = TaskService(project_root, tools=ToolRegistry(),
                          gateway_factory=gateway_factory)
    episode = service.create(
        "在本任务中开发并激活一个 model_context.v1 服务，让后续模型调用收到一致的比较准则。"
        "然后依据输入证据比较 A、B 两方案，要求延迟不超过 50ms；发布一个 result 工件，"
        "包含 choice、reason 和 service_evidence。只能据给定证据回答。",
        inputs={"options": {
            "A": {"latency_ms": 40, "monthly_cost": 2},
            "B": {"latency_ms": 70, "monthly_cost": 1},
            "latency_ceiling_ms": 50,
        }},
        deliverables=[{"name": "result", "schema": {
            "type": "object", "required": ["choice", "reason", "service_evidence"],
            "properties": {"choice": {"const": "A"},
                           "reason": {"type": "string"},
                           "service_evidence": {"type": "string"}},
            "additionalProperties": True,
        }}],
        capabilities=[],
        capability_authority=make_episode_authority(
            ["service_provider"], ["model_context"], version=2,
            max_definitions=2, max_invocations=8),
        budget=BUDGET, constraints={"wall_seconds": 480},
    )
    episode_id = episode["id"]
    service.run(episode_id, stop_event=threading.Event())
    state = service.get_private(episode_id)
    calls = state.get("calls", [])
    service_events = [
        {"kind": event["kind"], "content": {
            key: deepcopy(event["content"][key])
            for key in ("definition_id", "definition_digest", "service_interface",
                        "authority_digest", "binding", "input_digest",
                        "output_digest", "worker_instruction_limit",
                        "worker_execution")
            if key in event.get("content", {})}}
        for event in state.get("events", [])
        if event.get("kind", "").startswith("service_")
    ]
    report = {
        "schema": "nexgent.service-seed-live.v1",
        "passed": state["status"] == "completed" and any(
            event["kind"] == "service_applied" for event in service_events),
        "profile_identity": profile_identity,
        "profile_digest": profile_digest,
        "retry_policy": {"automatic_retries": 0, "attempts_per_ask": 1},
        "budget": BUDGET,
        "episode": {"id": episode_id, "status": state["status"],
                    "package_digest": state["package_digest"],
                    "output_refs": state.get("output_refs", {}),
                    "usage": state.get("usage", {}),
                    "last_error": state.get("last_error")},
        "model_receipts": [
            {**_safe_call_receipt(row), **{
                key: deepcopy(row[key])
                for key in ("service_provider", "effective_payload_digest")
                if key in row}}
            for row in calls],
        "service_events": service_events,
        "artifacts": [{key: deepcopy(row[key]) for key in
                       ("id", "name", "content", "node_id") if key in row}
                      for row in state.get("artifacts", [])],
        "failure": _failure_receipt(state, calls),
        "scratch_root": str(project_root),
        "interpretation": "One prompted service-development task; no spontaneous gap choice, cross-task adoption, or RSI gain.",
    }
    secret = profile.api_key
    serialized = json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2)
    report["leak_scan_passed"] = _leak_free(project_root, serialized, secret)
    if not report["leak_scan_passed"]:
        report = {"schema": "nexgent.service-seed-live.v1", "passed": False,
                  "leak_scan_passed": False}
    output = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if report.get("leak_scan_passed"):
        (project_root / "service-seed-live-summary.json").write_text(
            output, encoding="utf-8")
    print(output)
    return 0 if report.get("passed") else 1


if __name__ == "__main__":
    raise SystemExit(run())
