"""One bounded real-model trial through Main's versioned graph package.

This is a task-time orchestration mechanism probe, not a cross-task RSI study.
The UI is not automated here; the exact package channel and Episode authority
used by Main are resolved through TaskService and EvolutionService.
"""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import threading

from nexgent.models.gateway import ModelGateway
from nexgent.tasks.evolution import EvolutionService
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.self_orchestration_seed import self_orchestration_package
from nexgent.tasks.tools import ToolRegistry
from nexgent.ui.main_window import MAIN_CAPABILITY_AUTHORITY, MAIN_PACKAGE_CHANNEL

from python_live_route import (
    MODEL_SOURCE_ROOT, _failure_receipt, _leak_free, _live_transport,
    _load_live_profile, _safe_call_receipt,
)


BUDGET = {
    "max_model_calls": 8, "max_completion_tokens": 28000,
    "max_tool_calls": 8, "max_tool_work_units": 0, "max_nodes": 100,
}

OPTIONS = {
    "A": {"latency_ms": 40, "monthly_cost": 2},
    "B": {"latency_ms": 70, "monthly_cost": 1},
    "latency_ceiling_ms": 50,
}


def _independent_quality_check(state):
    """Score the held-out task facts, not the Episode's schema validator."""
    output_ref = state.get("output_refs", {}).get("result")
    result = next((item.get("content") for item in state.get("artifacts", [])
                   if item.get("id") == output_ref), None)
    eligible = [(name, facts["monthly_cost"])
                for name, facts in OPTIONS.items() if isinstance(facts, dict)
                and facts["latency_ms"] <= OPTIONS["latency_ceiling_ms"]]
    expected = min(eligible, key=lambda pair: pair[1])[0] if eligible else None
    reason = result.get("reason", "") if isinstance(result, dict) else ""
    verdict = state.get("nodes", {}).get("plan/nodes/verify", {}).get("result")
    verified = isinstance(verdict, dict) and verdict.get("valid") is True
    factual = all(str(number) in reason for number in (40, 50, 70))
    return {"expected_choice": expected, "observed_choice": (
        result.get("choice") if isinstance(result, dict) else None),
        "verifier_accepted": verified, "factual_reason": factual,
        "passed": (isinstance(result, dict) and result.get("choice") == expected
                   and verified and factual)}


def run():
    project_root = Path(tempfile.mkdtemp(
        prefix=".nexgent-main-graph-live-", dir=MODEL_SOURCE_ROOT.parent)).resolve()
    profile, profile_identity, profile_digest = _load_live_profile()

    def gateway_factory(reserve, stop_event):
        def audited_reserve(receipt):
            receipt = deepcopy(receipt)
            receipt["profile_identity"] = deepcopy(profile_identity)
            receipt["profile_digest"] = profile_digest
            reserve(receipt)

        gateway = ModelGateway(
            MODEL_SOURCE_ROOT, reserve=audited_reserve, stop_event=stop_event,
            timeout=90, transport=_live_transport, max_completion_tokens=5000)
        gateway.profiles = {profile.id: profile}
        gateway.defaults = {"main": profile.id, "subagent": profile.id}
        return gateway

    service = TaskService(project_root, tools=ToolRegistry(),
                          gateway_factory=gateway_factory)
    EvolutionService(service).register(
        MAIN_PACKAGE_CHANNEL, self_orchestration_package())
    episode = service.create(
        "请在本任务的执行图中设计一个 model_context.v1 服务，激活后让后续模型节点按统一准则比较选项。"
        "给定延迟上限 50ms，从输入 A、B 中选择合格且成本最低者，发布 result，"
        "包含 choice 与 reason。图要把服务开发、激活、回答和发布串成真实依赖。",
        inputs={"options": OPTIONS},
        deliverables=[{"name": "result", "schema": {
            "type": "object", "required": ["choice", "reason"],
            "properties": {"choice": {"enum": ["A", "B"]},
                           "reason": {"type": "string"}},
            "additionalProperties": True,
        }}],
        capabilities=[], package_channel=MAIN_PACKAGE_CHANNEL,
        capability_authority=deepcopy(MAIN_CAPABILITY_AUTHORITY),
        context={"split_role": "development"},
        budget=BUDGET, constraints={"wall_seconds": 600},
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
    quality = _independent_quality_check(state)
    report = {
        "schema": "nexgent.main-graph-service-live.v1",
        "passed": state["status"] == "completed" and quality["passed"]
                  and any(event["kind"] == "service_applied"
                          for event in service_events),
        "quality_check": quality,
        "profile_identity": profile_identity,
        "profile_digest": profile_digest,
        "retry_policy": {"automatic_retries": 0, "attempts_per_ask": 1},
        "budget": BUDGET,
        "episode": {"id": episode_id, "status": state["status"],
                    "package_digest": state["package_digest"],
                    "plan_revision": state.get("plan_revision"),
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
        "interpretation": "One graph-seed task prompted to develop a service; no spontaneous gap choice, cross-task adoption, or RSI gain.",
    }
    secret = profile.api_key
    serialized = json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2)
    report["leak_scan_passed"] = _leak_free(project_root, serialized, secret)
    if not report["leak_scan_passed"]:
        report = {"schema": "nexgent.main-graph-service-live.v1",
                  "passed": False, "leak_scan_passed": False}
    output = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if report.get("leak_scan_passed"):
        (project_root / "main-graph-service-live-summary.json").write_text(
            output, encoding="utf-8")
    print(output)
    return 0 if report.get("passed") else 1


if __name__ == "__main__":
    raise SystemExit(run())
