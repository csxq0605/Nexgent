"""Run the preregistered D1-B MiMo strategy-selection mechanism probe.

The default action is a read-only preflight.  A live batch requires the
explicit ``--live`` flag.  Provider credentials are loaded from the supplied
model project and are never copied into the run directory or evidence JSON.
See CONTRACT.md in this directory for the frozen tasks and interpretation.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import inspect
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import threading
import time
from urllib.parse import urlsplit

from nexgent.kernel.programs import digest
from nexgent.models import ModelGateway
from nexgent.models.config import ModelConfigurationError, Profile, load_profiles
from nexgent.models.gateway import ModelTransportError
from nexgent.models.worker import response_payload
from nexgent.tasks.adaptive_orchestration_seed import (
    MAIN_DAG_COMPONENT_ID,
    OPEN_LOOP_COMPONENT_ID,
    adaptive_orchestration_package,
)
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.packages import make_package
from nexgent.tasks.strategy_decisions import (
    strategy_candidate_set_from_manifest,
    strategy_selector_component,
)
from nexgent.tasks.tools import ToolRegistry


SCHEMA = "nexgent.d1b-strategy-selection-evidence.v1"
MANIFEST_SCHEMA = "nexgent.d1b-run-manifest.v1"
EXPECTED_MODEL = "mimo-v2.6-flash"
EXPECTED_ENDPOINT = "https://token-plan-cn.xiaomimimo.com/v1"
CREDENTIAL_REF = "NEXGENT_API_KEY"
ENTRY = "execute"
BUDGET = {
    "max_model_calls": 8,
    "max_completion_tokens": 28_000,
    "max_tool_calls": 0,
    "max_tool_work_units": 0,
    "max_nodes": 100,
}
CONSTRAINTS = {"wall_seconds": 180, "allowed_effects": []}
RETRY_POLICY = {"sdk_automatic_retries": 0, "provider_attempts_per_call": 1}

INCIDENT_INPUT = {
    "incident_id": "INC-204",
    "audience": "internal_service_owners",
    "observations": [
        {"at": "09:10 UTC", "code": "read_p95_breached",
         "fact": "Read p95 latency rose above 2 seconds."},
        {"at": "09:14 UTC", "code": "writes_within_slo",
         "fact": "The write path remained within SLO."},
        {"at": "09:18 UTC", "code": "cache_pool_rolled_back",
         "fact": "The cache-pool configuration was rolled back."},
        {"at": "09:24 UTC", "code": "read_p95_normal",
         "fact": "Read p95 latency returned to its normal range."},
    ],
    "cause": "unknown",
    "correlation_under_investigation": "cache_configuration_rollout",
    "requested_action": {
        "do_not": "retry_completed_writes",
        "report": "request_ids_for_reads_over_2_seconds",
    },
    "next_update": "10:30 UTC",
}

RELEASE_POLICY = {
    "service_pass_requires": {
        "tests_passed": True,
        "coverage_at_least": 80,
        "open_sev1": 0,
        "open_sev2": 0,
        "rollback_minutes_at_most": 15,
        "evidence_age_hours_at_most": 24,
    },
    "overall_rule": "approve_only_if_every_service_passes",
}
SERVICE_REPORTS = {
    "atlas_report.json": {
        "service": "atlas", "tests_passed": True, "coverage": 91,
        "open_sev1": 0, "open_sev2": 0, "rollback_minutes": 12,
        "evidence_age_hours": 3,
    },
    "borealis_report.json": {
        "service": "borealis", "tests_passed": True, "coverage": 88,
        "open_sev1": 0, "open_sev2": 1, "rollback_minutes": 9,
        "evidence_age_hours": 2,
    },
    "cygnus_report.json": {
        "service": "cygnus", "tests_passed": True, "coverage": 82,
        "open_sev1": 0, "open_sev2": 0, "rollback_minutes": 18,
        "evidence_age_hours": 6,
    },
}

OL_PROMPT = (
    "根据事件记录为内部服务负责人生成一份简短状态通报。严格区分观测事实、未知原因和正在调查的相关性；"
    "不要补充未给出的影响、原因或恢复保证。按给定 schema 返回一个 JSON 对象，"
    "`brief` 应能脱离原始记录独立阅读。"
)
DAG_PROMPT = (
    "使用发布政策逐项审查三份服务报告，再给出整个发布的结论。每个服务都要列出六项检查结果、"
    "是否通过和仅由输入支持的 blockers；blockers 使用未通过检查的字段名。总体结论必须严格应用 "
    "overall rule。按给定 schema 返回一个 JSON 对象，并让 evidence_refs 指向实际使用的输入工件名。"
)

INCIDENT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["incident_id", "status", "impact", "timeline", "cause",
                 "correlation_under_investigation", "action", "next_update", "brief"],
    "properties": {
        "incident_id": {"type": "string"},
        "status": {"enum": ["investigating", "monitoring", "resolved"]},
        "impact": {
            "type": "object", "additionalProperties": False,
            "required": ["degraded", "unaffected"],
            "properties": {
                "degraded": {"type": "array", "items": {"type": "string"}},
                "unaffected": {"type": "array", "items": {"type": "string"}},
            },
        },
        "timeline": {
            "type": "array", "items": {
                "type": "object", "additionalProperties": False,
                "required": ["at", "code"],
                "properties": {"at": {"type": "string"}, "code": {"type": "string"}},
            },
        },
        "cause": {"type": "string"},
        "correlation_under_investigation": {"type": "string"},
        "action": {
            "type": "object", "additionalProperties": False,
            "required": ["do_not", "report"],
            "properties": {"do_not": {"type": "string"}, "report": {"type": "string"}},
        },
        "next_update": {"type": "string"},
        "brief": {"type": "string"},
    },
}

CHECK_NAMES = ["tests_passed", "coverage", "open_sev1", "open_sev2",
               "rollback_minutes", "evidence_age_hours"]
RELEASE_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["per_service", "overall", "blocking_services", "summary"],
    "properties": {
        "per_service": {
            "type": "array", "items": {
                "type": "object", "additionalProperties": False,
                "required": ["service", "checks", "passed", "blockers", "evidence_refs"],
                "properties": {
                    "service": {"type": "string"},
                    "checks": {
                        "type": "object", "additionalProperties": False,
                        "required": CHECK_NAMES,
                        "properties": {name: {"enum": ["pass", "fail"]}
                                       for name in CHECK_NAMES},
                    },
                    "passed": {"type": "boolean"},
                    "blockers": {"type": "array", "items": {"type": "string"}},
                    "evidence_refs": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
        "overall": {"enum": ["approve", "hold"]},
        "blocking_services": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
}


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False)


def _sha_value(value):
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _sha_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _utc_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _task_specs():
    return {
        "TASK-OL-01": {
            "objective": OL_PROMPT,
            "inputs": {"incident_notes.json": deepcopy(INCIDENT_INPUT)},
            "deliverables": [{"name": "incident_update.json", "schema": INCIDENT_SCHEMA}],
            "expected_component": OPEN_LOOP_COMPONENT_ID,
        },
        "TASK-DAG-01": {
            "objective": DAG_PROMPT,
            "inputs": {"release_policy.json": deepcopy(RELEASE_POLICY), **deepcopy(SERVICE_REPORTS)},
            "deliverables": [{"name": "release_review.json", "schema": RELEASE_SCHEMA}],
            "expected_component": MAIN_DAG_COMPONENT_ID,
        },
    }


def _check(item_id, label, passed, critical=True, points=1):
    return {"id": item_id, "label": label, "passed": bool(passed),
            "critical": critical, "points": points if passed else 0,
            "points_possible": points}


def _score_incident(inputs, output):
    """Task-only deterministic scorer; it receives no strategy/runtime data."""
    data = inputs["incident_notes.json"]
    result = output if isinstance(output, dict) else {}
    brief = result.get("brief", "")
    text = brief.strip().lower() if isinstance(brief, str) else ""
    timeline = [{"at": row["at"], "code": row["code"]}
                for row in data["observations"]]
    cause_claim = bool(re.search(
        r"cache_configuration_rollout.{0,24}(?:is|was|caused|cause|root cause|confirmed|是|导致|根因|已确认)",
        text)) or bool(re.search(
            r"(?:cause|root cause|原因|根因)\s*(?:is|was|:|是|为)\s*cache_configuration_rollout",
            text))
    read_fact = (("read" in text and ("latency" in text or "p95" in text)
                  and any(word in text for word in ("degrad", "above", "rose", "影响", "升高", "超过"))))
    write_fact = (("write" in text or "写" in text)
                  and any(word in text for word in ("unaffected", "within slo", "未受影响", "正常")))
    normalized_fact = any(word in text for word in (
        "returned to its normal range", "back to normal", "normalized", "恢复正常", "回归正常"))
    forbidden = (
        bool(re.search(r"(?<!not )\bresolved\b|已解决|事故结束", text))
        or any(word in text for word in (
            "data loss", "数据丢失", "users affected", "用户受影响", "region", "地域", "地区"))
        or cause_claim
    )
    items = [
        _check("OL-1", "incident id", result.get("incident_id") == "INC-204", False),
        _check("OL-2", "monitoring status", result.get("status") == "monitoring", False),
        _check("OL-3", "impact sets", result.get("impact") == {
            "degraded": ["read_latency"], "unaffected": ["write_path"]}, False),
        _check("OL-4", "complete ordered timeline", result.get("timeline") == timeline, True),
        _check("OL-5", "unknown cause", result.get("cause") == "unknown", False),
        _check("OL-6", "correlation is not promoted to cause",
               result.get("correlation_under_investigation") ==
               "cache_configuration_rollout" and not cause_claim, True),
        _check("OL-7", "requested action", result.get("action") == data["requested_action"], False),
        _check("OL-8", "next update", result.get("next_update") == "10:30 UTC", False),
        _check("OL-9", "brief contains all three operational facts",
               read_fact and write_fact and normalized_fact, False),
        _check("OL-10", "brief contains no unsupported resolution, impact, or cause", not forbidden, True),
    ]
    score = sum(item["points"] for item in items)
    critical_passed = all(item["passed"] for item in items if item["critical"])
    return {"task_id": "TASK-OL-01", "items": items, "score": score,
            "score_possible": 10, "threshold": 9, "critical_passed": critical_passed,
            "passed": score >= 9 and critical_passed}


def _release_expected(inputs=None):
    inputs = ({"release_policy.json": RELEASE_POLICY, **SERVICE_REPORTS}
              if inputs is None else inputs)
    limits = inputs["release_policy.json"]["service_pass_requires"]
    expected = {}
    for name in ("atlas", "borealis", "cygnus"):
        report = inputs[f"{name}_report.json"]
        checks = {
            "tests_passed": report["tests_passed"] is limits["tests_passed"],
            "coverage": report["coverage"] >= limits["coverage_at_least"],
            "open_sev1": report["open_sev1"] == limits["open_sev1"],
            "open_sev2": report["open_sev2"] == limits["open_sev2"],
            "rollback_minutes": report["rollback_minutes"] <= limits["rollback_minutes_at_most"],
            "evidence_age_hours": report["evidence_age_hours"] <= limits["evidence_age_hours_at_most"],
        }
        blockers = [field for field in CHECK_NAMES if not checks[field]]
        expected[name] = ({field: "pass" if value else "fail"
                           for field, value in checks.items()}, not blockers, blockers)
    return expected


def _score_release(inputs, output):
    """Task-only deterministic scorer; it receives no strategy/runtime data."""
    result = output if isinstance(output, dict) else {}
    rows = result.get("per_service") if isinstance(result.get("per_service"), list) else []
    by_service = {row.get("service"): row for row in rows if isinstance(row, dict)}
    expected = _release_expected(inputs)
    service_items = []
    for service, (checks, passed, blockers) in expected.items():
        row = by_service.get(service, {})
        service_items.append(_check(
            f"DAG-{len(service_items) + 1}", f"{service} decision",
            row.get("checks") == checks and row.get("passed") is passed
            and row.get("blockers") == blockers, True, 2))
    refs_ok = all(set(by_service.get(name, {}).get("evidence_refs", [])) == {
        "release_policy.json", f"{name}_report.json"} for name in expected)
    summary = result.get("summary", "")
    summary_text = summary.strip().lower() if isinstance(summary, str) else ""
    summary_ok = ("borealis" in summary_text and "cygnus" in summary_text
                  and ("hold" in summary_text or "暂缓" in summary_text or "阻止" in summary_text)
                  and not re.search(r"atlas.{0,24}(?:block|fail|阻止|失败)", summary_text)
                  and not any(word in summary_text for word in (
                      "customer", "用户", "region", "地区", "data loss", "数据丢失")))
    service_set_ok = len(rows) == 3 and set(by_service) == set(expected)
    consistent = (result.get("overall") == "hold"
                  and set(result.get("blocking_services", [])) == {"borealis", "cygnus"}
                  and all(by_service[name].get("passed") is expected[name][1]
                          for name in expected if name in by_service))
    items = [
        *service_items,
        _check("DAG-4", "per-service evidence references", refs_ok, True),
        _check("DAG-5", "overall hold", result.get("overall") == "hold", True),
        _check("DAG-6", "blocking service set",
               set(result.get("blocking_services", [])) == {"borealis", "cygnus"}, True),
        _check("DAG-7", "summary is supported and does not block atlas", summary_ok, True),
        _check("DAG-8", "service records complete and unique", service_set_ok, True),
        _check("DAG-9", "overall is consistent with service decisions", consistent, True),
    ]
    score = sum(item["points"] for item in items)
    return {"task_id": "TASK-DAG-01", "items": items, "score": score,
            "score_possible": 12, "threshold": 12,
            "critical_passed": all(item["passed"] for item in items),
            "passed": score == 12 and all(item["passed"] for item in items)}


def evaluate_task(task_id, frozen_inputs, deliverable):
    """Independent evaluator boundary: task, inputs, and output only."""
    if task_id == "TASK-OL-01":
        return _score_incident(deepcopy(frozen_inputs), deepcopy(deliverable))
    if task_id == "TASK-DAG-01":
        return _score_release(deepcopy(frozen_inputs), deepcopy(deliverable))
    raise ValueError("Unknown preregistered task")


def _models_path(root):
    paths = [root / "models.json", root / ".nexgent" / "models.json"]
    return next((path for path in paths if path.is_file()), None)


def _normalized_endpoint(value):
    parsed = urlsplit(value.strip())
    if (parsed.scheme.lower() != "https"
            or parsed.hostname != "token-plan-cn.xiaomimimo.com"
            or parsed.username is not None or parsed.password is not None
            or parsed.query or parsed.fragment or parsed.port not in (None, 443)
            or parsed.path.rstrip("/") != "/v1"):
        raise ModelConfigurationError("MiMo endpoint differs from the preregistered endpoint")
    return EXPECTED_ENDPOINT


def _load_profile(model_project, model):
    model_project = model_project.resolve()
    if model != EXPECTED_MODEL:
        raise ModelConfigurationError(
            f"The preregistered model is exactly {EXPECTED_MODEL}")
    models_path = _models_path(model_project)
    if models_path is None:
        raise ModelConfigurationError("The live probe requires a versioned models.json")
    raw = json.loads(models_path.read_text(encoding="utf-8-sig"))
    provider = raw.get("providers", {}).get("mimo")
    if not isinstance(provider, dict):
        raise ModelConfigurationError("models.json has no mimo provider")
    if provider.get("api_key") not in {"${NEXGENT_API_KEY}", "$NEXGENT_API_KEY"}:
        raise ModelConfigurationError("MiMo credential must reference NEXGENT_API_KEY")
    endpoint = _normalized_endpoint(provider.get("base_url", ""))
    profiles, _ = load_profiles(model_project)
    # The authorized provider configuration may enumerate an older model.  The
    # live probe overrides only the model name in memory while preserving the
    # provider endpoint and credential handle.  Nothing is written back to the
    # model project.
    sources = [profile for profile in profiles.values()
               if profile.id.startswith("mimo/")
               and _normalized_endpoint(profile.base_url) == endpoint]
    if not sources:
        raise ModelConfigurationError("No configured MiMo provider profile")
    source = sources[0]
    if not source.api_key or source.api_key.startswith("$"):
        raise ModelConfigurationError("NEXGENT_API_KEY is not configured")
    if any(candidate.api_key != source.api_key for candidate in sources):
        raise ModelConfigurationError("MiMo profiles disagree on credential identity")
    profile = Profile(f"mimo/{model}", model, endpoint, source.api_key)
    identity = {
        "provider": "mimo", "base_url": endpoint, "configured_model": model,
        "profile_id": profile.id, "credential_ref": CREDENTIAL_REF,
        "credential_source_profile_id": source.id,
        "models_json_sha256": _sha_file(models_path),
    }
    return profile, identity, _sha_value(identity)


def _git_identity(repo_root):
    def run(*args):
        return subprocess.run(["git", *args], cwd=repo_root, check=True,
                              capture_output=True, text=True, encoding="utf-8").stdout.rstrip()
    commit = run("rev-parse", "HEAD")
    status = run("status", "--porcelain=v1", "--untracked-files=all")
    source_hashes = {}
    for path in sorted((repo_root / "src" / "nexgent").rglob("*.py")):
        source_hashes[path.relative_to(repo_root).as_posix()] = _sha_file(path)
    source_hashes["experiments/strategy_selection/run.py"] = _sha_file(Path(__file__))
    return {"commit": commit, "dirty": bool(status),
            "dirty_paths": [line[3:].replace("\\", "/") for line in status.splitlines()],
            "executed_source_sha256": source_hashes}


def _manifest(repo_root, package, profile_identity, profile_digest):
    tasks = _task_specs()
    candidates = strategy_candidate_set_from_manifest(package)
    selector = strategy_selector_component(package)
    task_identities = {}
    for task_id, spec in tasks.items():
        task_identities[task_id] = {
            "canonical_task_sha256": _sha_value({
                key: spec[key] for key in ("objective", "inputs", "deliverables")}),
            "prompt_sha256": _sha_value(spec["objective"]),
            "inputs_sha256": _sha_value(spec["inputs"]),
            "deliverable_schema_sha256": _sha_value(spec["deliverables"]),
        }
    evaluator_source = "\n".join(inspect.getsource(item) for item in (
        _check, _score_incident, _release_expected, _score_release, evaluate_task))
    evaluator_identity = {
        "source_sha256": hashlib.sha256(evaluator_source.encode("utf-8")).hexdigest(),
        "check_names": CHECK_NAMES, "ol_threshold": 9, "dag_threshold": 12,
        "ol_critical": ["OL-4", "OL-6", "OL-10"], "dag_all_critical": True,
    }
    body = {
        "schema": MANIFEST_SCHEMA, "contract_revision": "2026-09-24/D1-B.1",
        "created_at": _utc_now(), "git": _git_identity(repo_root),
        "package": {
            "id": package["id"], "digest": package["digest"],
            "entry": ENTRY, "entry_ref": package["manifest"]["entries"][ENTRY],
            "candidate_set": candidates,
            "selector": selector,
            "selector_prompt_sha256": _sha_value(package["files"][selector["source_path"]]),
        },
        "model_profile": profile_identity, "profile_digest": profile_digest,
        "retry_policy": RETRY_POLICY, "budget_per_episode": BUDGET,
        "constraints_per_episode": CONSTRAINTS,
        "authority": {"capabilities": [], "capability_authority": None,
                      "digest": _sha_value({"capabilities": [], "capability_authority": None})},
        "tasks": task_identities,
        "evaluator_digest": _sha_value(evaluator_identity),
        "evaluator_identity": evaluator_identity,
        "episode_order": ["D1B-OL-PRIMARY", "D1B-DAG-PRIMARY",
                          "D1B-OL-RECOVERY", "D1B-SELECTOR-UNKNOWN"],
        "batch_caps": {"episodes": 4, "started_model_calls": 32,
                       "completion_token_reservations": 112_000},
    }
    return {**body, "manifest_digest": _sha_value(body)}


def _safe_call(row):
    keys = ("call_id", "episode_id", "node_id", "role", "model", "provider_model",
            "configured_provider_model", "observed_provider_model", "provider_revision",
            "profile_digest", "profile_identity", "status", "finish_reason",
            "billing_status", "started_at", "finished_at", "max_completion_tokens",
            "reserved_completion_tokens", "usage", "request_digest", "response_id",
            "error_type", "transport_diagnostics")
    result = {key: deepcopy(row[key]) for key in keys if key in row}
    result["attempt_count"] = 1
    if "output" in row:
        result["response_digest"] = _sha_value(row["output"])
    return result


def _safe_events(events):
    keep_content = {"strategy_decision", "strategy_entered", "rpc_started", "rpc_finished"}
    result = []
    for event in events:
        row = {key: deepcopy(event.get(key)) for key in (
            "episode_id", "sequence", "kind", "created", "previous", "digest")}
        row["content_digest"] = _sha_value(event.get("content"))
        if event.get("kind") in keep_content:
            row["content"] = deepcopy(event.get("content"))
        result.append(row)
    return result


def _failure_receipt(state, calls, selected, *, expected_unknown, unknown_ok):
    if state.get("status") == "completed":
        return None
    last = calls[-1] if calls else {}
    diagnostics = last.get("transport_diagnostics") or {}
    if expected_unknown and unknown_ok:
        failure_class, remote_unknown = "remote_outcome_unknown", True
    elif last.get("error_type") == "ModelTransportError":
        failure_class = "provider_transport"
        local_import_failure = "ModuleNotFoundError" in diagnostics.get(
            "cause_types", [])
        remote_unknown = (not local_import_failure
                          and diagnostics.get("connection_phase") in {
                              "request_write", "response_read",
                              "http_response", "unknown"})
    elif last.get("error_type") in {"ModelConfigurationError", "ModelBudgetError"}:
        failure_class, remote_unknown = "configuration_or_budget", False
    elif not calls:
        failure_class, remote_unknown = "configuration_or_admission", False
    else:
        failure_class, remote_unknown = state.get("failure_domain") or "task_protocol", False
    return {
        "stage": "selector" if selected is None else "backend",
        "class": failure_class, "remote_outcome_unknown": remote_unknown,
        "last_persisted_event": (state.get("events") or [{}])[-1].get("digest"),
    }


def _snapshot(service, episode_id, label):
    state = service.get_private(episode_id)
    calls = state.get("calls", [])
    decisions = [event["content"] for event in state.get("events", [])
                 if event.get("kind") == "strategy_decision"]
    return {
        "label": label, "captured_at": _utc_now(), "status": state.get("status"),
        "deadline": deepcopy(service.store.start_deadline(episode_id)),
        "selector_call_ids": [row.get("call_id") for row in calls
                              if row.get("role") == "strategy_selector"],
        "backend_completed_call_ids": [row.get("call_id") for row in calls
                                       if row.get("role") != "strategy_selector"
                                       and row.get("status") not in {"started", "reserved"}],
        "decision_digests": [row.get("decision_digest") for row in decisions],
        "output_refs": deepcopy(state.get("output_refs", {})),
        "artifact_ids": [row.get("id") for row in state.get("artifacts", [])],
        "usage": deepcopy(state.get("usage", {})),
        "rpc_started_count": sum(event.get("kind") == "rpc_started"
                                 for event in state.get("events", [])),
    }


class _InjectedCrash(RuntimeError):
    pass


class _SelectorOutcomeUnknown(KeyboardInterrupt):
    pass


def _transport_diagnostics(exc):
    causes, seen, current = [], set(), exc
    status, number = None, None
    while current is not None and id(current) not in seen and len(causes) < 8:
        seen.add(id(current)); causes.append(type(current).__name__[:80])
        value = getattr(current, "status_code", None)
        if type(value) is int and 100 <= value <= 599:
            status = value
        value = getattr(current, "errno", None)
        if type(value) is int and -100000 <= value <= 100000:
            number = value
        current = current.__cause__ or current.__context__
    return {"cause_types": causes, "stage": "request", "connection_phase": "unknown",
            "http_status": status, "errno": number}


def _one_attempt_transport(profile, params, *, discard_completed_response=False):
    client = None
    try:
        from openai import OpenAI
        client = OpenAI(api_key=profile.api_key, base_url=profile.base_url,
                        timeout=90, max_retries=0)
        response = response_payload(client.chat.completions.create(**deepcopy(params)))
        if discard_completed_response:
            raise _SelectorOutcomeUnknown("selector provider outcome intentionally left unknown")
        return response
    except _SelectorOutcomeUnknown:
        raise
    except Exception as exc:
        raise ModelTransportError(
            "Live provider request failed; no retry was attempted",
            _transport_diagnostics(exc)) from None
    finally:
        if client is not None:
            client.close()


def _gateway_factory(model_project, profile, profile_identity, profile_digest, controller):
    def factory(reserve, stop_event):
        def audited_reserve(receipt):
            enriched = deepcopy(receipt)
            enriched["profile_identity"] = deepcopy(profile_identity)
            enriched["profile_digest"] = profile_digest
            reserve(enriched)
            observed = enriched.get("observed_provider_model")
            if observed is not None and observed != EXPECTED_MODEL:
                raise ModelConfigurationError("Observed provider model differs from the preregistration")

        unknown = controller.get("selector_unknown", False)
        transport = (lambda selected, params: _one_attempt_transport(
            selected, params, discard_completed_response=True)) if unknown else (
                lambda selected, params: _one_attempt_transport(selected, params))
        gateway = ModelGateway(
            model_project, reserve=audited_reserve, stop_event=stop_event,
            timeout=90, transport=transport, max_completion_tokens=6000)
        gateway.profiles = {profile.id: profile}
        gateway.defaults = {role: profile.id for role in (
            "main", "subagent", "strategy_selector", "task_agent", "task_reviewer",
            "architect", "generalist", "reviewer")}
        return gateway
    return factory


def _service(run_root, factory):
    return TaskService(run_root, tools=ToolRegistry(), gateway_factory=factory)


def _run_recovery(run_root, factory, episode_id):
    snapshots = []
    service = _service(run_root, factory)
    original_event = service.store.event
    tripped = {"value": False}

    def crash_before_decision(identity, kind, data):
        if identity == episode_id and kind == "strategy_decision" and not tripped["value"]:
            tripped["value"] = True
            raise _InjectedCrash("fault after selector completion before decision commit")
        return original_event(identity, kind, data)

    service.store.event = crash_before_decision
    service.run(episode_id, stop_event=threading.Event())
    snapshots.append(_snapshot(service, episode_id, "selector-complete-before-decision"))

    service = _service(run_root, factory)
    original_event = service.store.event
    tripped = {"value": False}

    def crash_before_backend(identity, kind, data):
        if identity == episode_id and kind == "strategy_entered" and not tripped["value"]:
            tripped["value"] = True
            raise _InjectedCrash("fault after decision commit before backend entry")
        return original_event(identity, kind, data)

    service.store.event = crash_before_backend
    service.run(episode_id, stop_event=threading.Event())
    snapshots.append(_snapshot(service, episode_id, "decision-complete-before-backend"))

    service = _service(run_root, factory)
    original_finish = service.store.rpc_finish
    tripped = {"value": False}

    def crash_after_backend_receipt(identity, call_path, *, result=None, error=None):
        receipt = original_finish(identity, call_path, result=result, error=error)
        if (identity == episode_id and call_path != "strategy/selector"
                and result is not None and not tripped["value"]):
            tripped["value"] = True
            raise _InjectedCrash("fault after backend RPC outcome before projection advance")
        return receipt

    service.store.rpc_finish = crash_after_backend_receipt
    service.run(episode_id, stop_event=threading.Event())
    snapshots.append(_snapshot(service, episode_id, "backend-receipt-before-advance"))

    service = _service(run_root, factory)
    service.run(episode_id, stop_event=threading.Event())
    snapshots.append(_snapshot(service, episode_id, "recovered-complete"))
    selector_ids = [tuple(row["selector_call_ids"]) for row in snapshots]
    deadlines = [row["deadline"]["deadline_at"] for row in snapshots]
    decisions = [tuple(row["decision_digests"]) for row in snapshots[1:]]
    backend_before = tuple(snapshots[2]["backend_completed_call_ids"])
    backend_after = tuple(snapshots[3]["backend_completed_call_ids"][:len(backend_before)])
    checks = {
        "selector_not_replayed": len(set(selector_ids)) == 1 and len(selector_ids[0]) == 1,
        "decision_identity_stable": len(set(decisions)) == 1 and len(decisions[0]) == 1,
        "completed_backend_calls_not_replayed": bool(backend_before)
        and backend_before == backend_after,
        "selector_usage_not_recharged_on_decision_recovery": (
            snapshots[0]["usage"] == snapshots[1]["usage"]),
        "persisted_artifacts_not_replaced": (
            set(snapshots[2]["artifact_ids"]) <= set(snapshots[3]["artifact_ids"])),
        "deadline_not_reset": len(set(deadlines)) == 1,
        "final_status_completed": snapshots[-1]["status"] == "completed",
    }
    return service, snapshots, {**checks, "passed": all(checks.values())}


def _episode_evidence(service, label, task_id, episode_id, task_spec, evaluator_digest,
                      recovery=None, expected_unknown=False):
    state = service.get_private(episode_id)
    calls = [_safe_call(row) for row in state.get("calls", [])]
    decisions = [event["content"] for event in state.get("events", [])
                 if event.get("kind") == "strategy_decision"]
    output_ref = state.get("output_refs", {}).get(task_spec["deliverables"][0]["name"])
    artifact = service.store.read(output_ref, episode_id) if output_ref else None
    quality = (evaluate_task(task_id, task_spec["inputs"], artifact["content"])
               if artifact is not None else {"task_id": task_id, "passed": False,
                                             "status": "deliverable_missing"})
    active = (state.get("execution") or {}).get("active_strategy")
    selected = decisions[0].get("selected_component_id") if len(decisions) == 1 else None
    model_identity_ok = all(
        row.get("configured_provider_model") == EXPECTED_MODEL
        and (row.get("observed_provider_model") in {None, EXPECTED_MODEL}) for row in calls)
    unknown_ok = (state.get("status") == "waiting_input" and len(calls) == 1
                  and calls[0].get("role") == "strategy_selector"
                  and calls[0].get("status") in {"started", "reserved"}
                  and not decisions and active is None) if expected_unknown else None
    artifacts = [{
        "id": row.get("id"), "name": row.get("name"),
        "content_digest": row.get("content_digest"), "node_id": row.get("node_id"),
        "schema_ref_digest": _sha_value(row.get("schema_ref")),
    } for row in state.get("artifacts", [])]
    nodes = [{
        "id": node_id, "method": row.get("method"), "status": row.get("status"),
        "result_digest": _sha_value(row.get("result")) if "result" in row else None,
        "error_class": (str(row.get("error", "")).split(":", 1)[0] or None),
    } for node_id, row in sorted(state.get("nodes", {}).items())]
    deadline = service.store.start_deadline(episode_id)
    usage = deepcopy(state.get("usage", {}))
    limits = deepcopy(state.get("budget"))
    remaining = {
        "model_calls": max(0, limits["max_model_calls"] - usage["model_calls"]),
        "completion_tokens": max(
            0, limits["max_completion_tokens"] - usage["charged_completion_tokens"]),
        "tool_calls": max(0, limits["max_tool_calls"] - usage["tool_calls"]),
        "tool_work_units": max(
            0, limits["max_tool_work_units"] - usage["charged_tool_work_units"]),
        "nodes": max(0, limits["max_nodes"] - usage["nodes"]),
    }
    entered = [event["content"] for event in state.get("events", [])
               if event.get("kind") == "strategy_entered"]
    activation_verified = bool(
        isinstance(active, dict) and len(decisions) == 1 and entered
        and active.get("decision_digest") == decisions[0].get("decision_digest")
        and active.get("component_id") == selected
        and active.get("backend") == decisions[0].get("selected_candidate", {}).get("backend"))
    failure = _failure_receipt(
        state, calls, selected, expected_unknown=expected_unknown, unknown_ok=unknown_ok)
    if failure is not None:
        failure["resumed"] = bool(recovery)
    return {
        "attempt": label, "task_id": task_id, "episode_id": episode_id,
        "created_at": state.get("created_at"), "completed_at": state.get("updated_at"),
        "status": state.get("status"), "package_digest": state.get("package_digest"),
        "task_digest": _sha_value({key: task_spec[key]
                                   for key in ("objective", "inputs", "deliverables")}),
        "identity_digests": {
            "prompt": _sha_value(task_spec["objective"]),
            "inputs": _sha_value(task_spec["inputs"]),
            "schema": _sha_value(task_spec["deliverables"]),
            "evaluator": evaluator_digest,
        },
        "budget": limits, "usage": usage,
        "budget_receipts": {"initial_limits": limits, "final_usage": usage,
                            "final_remaining": remaining},
        "deadline": deadline, "model_identity_ok": model_identity_ok,
        "model_receipts": calls, "strategy_decisions": decisions,
        "strategy_entered": entered, "active_strategy": deepcopy(active),
        "activation_verified": activation_verified, "node_receipts": nodes,
        "artifact_receipts": artifacts, "output_artifact_digest": (
            artifact.get("content_digest") if artifact else None),
        "event_ledger": _safe_events(state.get("events", [])),
        "quality": quality, "recovery": recovery,
        "expected_selector_unknown": expected_unknown,
        "selector_unknown_check": unknown_ok,
        "failure": failure,
    }


def _write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2,
                               sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")


def _prepare_run_root(value):
    if value is None:
        return Path(tempfile.mkdtemp(prefix="nexgent-d1b-strategy-")).resolve()
    root = value.resolve()
    if root.exists() and any(root.iterdir()):
        raise FileExistsError("--run-root must be absent or empty; evidence is append-only")
    root.mkdir(parents=True, exist_ok=True)
    return root


def _leak_free(root, serialized, secret):
    if not secret or secret in serialized:
        return False
    needle = secret.encode("utf-8")
    for path in root.rglob("*"):
        if path.is_file() and needle in path.read_bytes():
            return False
    return True


def _deadline_runtime_preflight():
    """Exercise one absolute deadline and restart without any provider I/O."""
    source = '''def execute(payload, context):
    context.ask("deadline_probe", "Return an empty JSON object.", {"step": 1}, max_tokens=1)
    context.ask("deadline_probe", "Return an empty JSON object.", {"step": 2}, max_tokens=1)
    return {"deliverables": {}}
'''
    package = make_package(
        {"agent/main.py": source},
        {"entries": {"execute": "agent/main.py:execute"}},
    )
    gateway_calls = []

    def factory(reserve, stop_event):
        del stop_event

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                del prompt, payload
                call_id = f"deadline-preflight-call-{len(gateway_calls) + 1}"
                receipt = {
                    "call_id": call_id, "role": role, "model": "LOCAL-DEADLINE-DOUBLE",
                    "status": "started", "request_digest": _sha_value({"role": role}),
                    "reserved_completion_tokens": max_tokens,
                }
                reserve(receipt)
                gateway_calls.append(call_id)
                if len(gateway_calls) == 2:
                    time.sleep(0.90)
                reserve({**receipt, "status": "completed", "billing_status": "usage_reported",
                         "usage": {"prompt_tokens": 0, "completion_tokens": 0,
                                   "total_tokens": 0}})
                return {}

        return Gateway()

    with tempfile.TemporaryDirectory(
            prefix="nexgent-d1b-deadline-preflight-",
            ignore_cleanup_errors=True) as root:
        service = TaskService(Path(root), tools=ToolRegistry(), gateway_factory=factory)
        episode = service.create(
            "Local deadline integration probe", package=package,
            capabilities=[], budget={"max_model_calls": 2,
                                     "max_completion_tokens": 2,
                                     "max_tool_calls": 0,
                                     "max_tool_work_units": 0,
                                     "max_nodes": 3},
            constraints={"wall_seconds": 0.75, "allowed_effects": []})
        first = service.run(episode["id"], stop_event=threading.Event())
        first_deadline = service.store.start_deadline(episode["id"])
        gateway_calls_after_first = list(gateway_calls)
        durable_calls_after_first = service.store.calls(episode["id"])
        resumed_service = TaskService(
            Path(root), tools=ToolRegistry(), gateway_factory=factory)
        resumed_at = time.monotonic()
        second = resumed_service.run(episode["id"], stop_event=threading.Event())
        resume_elapsed = time.monotonic() - resumed_at
        second_deadline = resumed_service.store.start_deadline(episode["id"])
        calls = resumed_service.store.calls(episode["id"])
    checks = {
        "first_run_expired": first.get("status") == "failed",
        "resume_refused_after_original_deadline": second.get("status") == "failed",
        "deadline_identity_stable": first_deadline == second_deadline,
        "resume_did_not_replay_completed_call": (
            gateway_calls == gateway_calls_after_first
            and [row["call_id"] for row in calls]
            == [row["call_id"] for row in durable_calls_after_first]),
        "resume_failed_without_new_wall_window": resume_elapsed < 0.15,
    }
    return {"passed": all(checks.values()), "checks": checks,
            "observed": {"gateway_call_count": len(gateway_calls),
                         "durable_call_count": len(calls),
                         "first_status": first.get("status"),
                         "resumed_status": second.get("status")},
            "external_model_called": False}


def preflight(args):
    repo_root = Path(__file__).resolve().parents[2]
    profile, profile_identity, profile_digest = _load_profile(
        args.model_project, args.model)
    package = adaptive_orchestration_package()
    manifest = _manifest(repo_root, package, profile_identity, profile_digest)
    candidates = manifest["package"]["candidate_set"]["candidates"]
    expected_candidates = {
        OPEN_LOOP_COMPONENT_ID: ("open_loop", "controlled_code"),
        MAIN_DAG_COMPONENT_ID: ("dag", "executable_plan"),
    }
    candidate_ok = ({row["component_id"]: (row["shape"], row["backend"])
                     for row in candidates} == expected_candidates)
    workflow = package["manifest"]["workflows"][
        package["manifest"]["components"][MAIN_DAG_COMPONENT_ID]["ref"]]
    deadline_probe = _deadline_runtime_preflight()
    checks = {
        "package_verified": bool(package.get("digest")),
        "candidate_set_exact": candidate_ok,
        "same_public_entry": package["manifest"]["entries"].get(ENTRY) == "agent/main.py:execute",
        "dag_max_parallel_bounded": workflow.get("max_parallel", 0) <= 8,
        "model_profile_exact": profile.model == EXPECTED_MODEL,
        "endpoint_exact": profile_identity["base_url"] == EXPECTED_ENDPOINT,
        "credential_reference_exact": profile_identity["credential_ref"] == CREDENTIAL_REF,
        "budget_exact": BUDGET == {"max_model_calls": 8, "max_completion_tokens": 28_000,
                                   "max_tool_calls": 0, "max_tool_work_units": 0,
                                   "max_nodes": 100},
        "wall_clock_bound_exact": CONSTRAINTS["wall_seconds"] == 180,
        "evaluator_self_check": (
            _score_release({"release_policy.json": RELEASE_POLICY, **SERVICE_REPORTS}, {
                "per_service": [{"service": name, "checks": values[0],
                                 "passed": values[1], "blockers": values[2],
                                 "evidence_refs": ["release_policy.json", f"{name}_report.json"]}
                                for name, values in _release_expected().items()],
                "overall": "hold", "blocking_services": ["borealis", "cygnus"],
                "summary": "Hold: borealis is blocked by open_sev2 and cygnus by rollback_minutes."
            })["passed"]),
    }
    checks["deadline_runtime_integrated"] = deadline_probe["passed"]
    report = {
        "schema": SCHEMA, "mode": "preflight", "created_at": _utc_now(),
        "external_model_called": False, "checks": checks,
        "passed": all(checks.values()), "manifest": manifest,
        "deadline_probe": deadline_probe,
        "live_command_requires_explicit_flag": "--live",
    }
    if args.run_root is not None:
        root = _prepare_run_root(args.run_root)
        serialized = json.dumps(report, ensure_ascii=False, sort_keys=True)
        report["leak_scan_passed"] = _leak_free(root, serialized, profile.api_key)
        _write_json(root / "preflight.json", report)
        report["preflight_path"] = str((root / "preflight.json").resolve())
    return report


def live(args):
    deadline_probe = _deadline_runtime_preflight()
    if not deadline_probe["passed"]:
        raise RuntimeError(
            "Live probe refused: durable wall-deadline integration preflight failed")
    repo_root = Path(__file__).resolve().parents[2]
    run_root = _prepare_run_root(args.run_root)
    profile, profile_identity, profile_digest = _load_profile(
        args.model_project, args.model)
    package = adaptive_orchestration_package()  # one object reused by all four Episodes
    manifest = _manifest(repo_root, package, profile_identity, profile_digest)
    manifest_path = run_root / "run_manifest.json"
    _write_json(manifest_path, manifest)
    try:
        os.chmod(manifest_path, stat.S_IREAD)
    except OSError:
        pass

    controller = {"selector_unknown": False}
    factory = _gateway_factory(
        args.model_project, profile, profile_identity, profile_digest, controller)
    service = _service(run_root, factory)
    tasks = _task_specs()
    definitions = [
        ("D1B-OL-PRIMARY", "TASK-OL-01"),
        ("D1B-DAG-PRIMARY", "TASK-DAG-01"),
        ("D1B-OL-RECOVERY", "TASK-OL-01"),
        ("D1B-SELECTOR-UNKNOWN", "TASK-OL-01"),
    ]
    episodes = {}
    for label, task_id in definitions:
        spec = tasks[task_id]
        episodes[label] = service.create(
            spec["objective"], inputs=deepcopy(spec["inputs"]),
            deliverables=deepcopy(spec["deliverables"]), capabilities=[],
            capability_authority=None, budget=deepcopy(BUDGET),
            constraints=deepcopy(CONSTRAINTS), package=package, entry=ENTRY)["id"]

    for label in ("D1B-OL-PRIMARY", "D1B-DAG-PRIMARY"):
        service.run(episodes[label], stop_event=threading.Event())

    recovery_service, snapshots, recovery_checks = _run_recovery(
        run_root, factory, episodes["D1B-OL-RECOVERY"])
    service = recovery_service

    controller["selector_unknown"] = True
    unknown_service = _service(run_root, factory)
    try:
        unknown_service.run(episodes["D1B-SELECTOR-UNKNOWN"],
                            stop_event=threading.Event())
    except _SelectorOutcomeUnknown:
        pass
    controller["selector_unknown"] = False
    unknown_service = _service(run_root, factory)
    unknown_service.run(episodes["D1B-SELECTOR-UNKNOWN"],
                        stop_event=threading.Event())

    evaluator_digest = manifest["evaluator_digest"]
    evidence = []
    for label, task_id in definitions:
        current_service = unknown_service if label == "D1B-SELECTOR-UNKNOWN" else _service(
            run_root, factory)
        evidence.append(_episode_evidence(
            current_service, label, task_id, episodes[label], tasks[task_id],
            evaluator_digest,
            recovery={"snapshots": snapshots, "checks": recovery_checks}
            if label == "D1B-OL-RECOVERY" else None,
            expected_unknown=label == "D1B-SELECTOR-UNKNOWN"))

    by_label = {row["attempt"]: row for row in evidence}
    primary = [by_label["D1B-OL-PRIMARY"], by_label["D1B-DAG-PRIMARY"]]
    h1 = all(row["strategy_decisions"] and
             row["strategy_decisions"][0]["selected_component_id"] ==
             tasks[row["task_id"]]["expected_component"] for row in primary)
    h2 = all(row["activation_verified"] for row in primary)
    h3 = recovery_checks["passed"] and bool(
        by_label["D1B-SELECTOR-UNKNOWN"]["selector_unknown_check"])
    h4 = all(row["quality"]["passed"] for row in primary)
    total_calls = sum(row["usage"]["model_calls"] for row in evidence)
    total_reservations = sum(row["usage"]["reserved_completion_tokens"] for row in evidence)
    caps_ok = len(evidence) == 4 and total_calls <= 32 and total_reservations <= 112_000
    report = {
        "schema": SCHEMA, "mode": "live", "attempt_id": args.attempt_id,
        "created_at": _utc_now(), "run_manifest_digest": manifest["manifest_digest"],
        "episodes": evidence,
        "hypotheses": {"H1": h1, "H2": h2, "H3": h3, "H4": h4},
        "batch_usage": {"episodes": len(evidence), "model_calls": total_calls,
                        "completion_token_reservations": total_reservations,
                        "within_caps": caps_ok},
        "supported": h1 and h2 and h3 and h4 and caps_ok,
        "interpretation": "D1-B mechanism sample only; no fixed-strategy effect or RSI claim.",
    }
    rows = [{
        "attempt": row["attempt"], "task_digest": row["task_digest"],
        "selector_receipt": (row["model_receipts"][0].get("call_id")
                             if row["model_receipts"] else None),
        "decision": (row["strategy_decisions"][0].get("decision_digest")
                     if row["strategy_decisions"] else None),
        "selected_component": (row["strategy_decisions"][0].get("selected_component_id")
                               if row["strategy_decisions"] else None),
        "actual_backend": (row["active_strategy"] or {}).get("backend"),
        "activation_verified": row["activation_verified"],
        "model_calls": row["usage"]["model_calls"],
        "tokens": row["usage"].get("completion_tokens"),
        "nodes": row["usage"]["nodes"],
        "artifact_digest": row["output_artifact_digest"],
        "quality": row["quality"].get("passed"),
        "recovery": ((row["recovery"] or {}).get("checks", {}).get("passed")
                     if row["recovery"] is not None else row["selector_unknown_check"]),
        "failure_class": (row["failure"] or {}).get("class"),
    } for row in evidence]
    serialized = json.dumps(report, ensure_ascii=False, sort_keys=True, allow_nan=False)
    report["leak_scan_passed"] = _leak_free(run_root, serialized, profile.api_key)
    if not report["leak_scan_passed"]:
        raise RuntimeError("Credential leak scan failed; evidence was not written")
    _write_json(run_root / "evidence.json", report)
    (run_root / "results.jsonl").write_text(
        "".join(_canonical(row) + "\n" for row in rows), encoding="utf-8")
    if not _leak_free(run_root, _canonical(report), profile.api_key):
        raise RuntimeError("Credential leak scan failed after evidence write")
    return {"schema": SCHEMA, "mode": "live", "supported": report["supported"],
            "hypotheses": report["hypotheses"], "run_root": str(run_root),
            "evidence_path": str((run_root / "evidence.json").resolve()),
            "leak_scan_passed": True}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-project", type=Path, required=True,
                        help="Project containing models.json and NEXGENT_API_KEY binding")
    parser.add_argument("--model", default=EXPECTED_MODEL,
                        help=f"Frozen provider model (must be {EXPECTED_MODEL})")
    parser.add_argument("--run-root", type=Path,
                        help="Absent or empty append-only evidence directory")
    parser.add_argument("--attempt-id", default="D1B-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--preflight-only", action="store_true",
                      help="Validate configuration and frozen identities without a provider request")
    mode.add_argument("--live", action="store_true",
                      help="Run the four preregistered Episodes against MiMo")
    args = parser.parse_args(argv)
    if not args.live:
        args.preflight_only = True
    result = live(args) if args.live else preflight(args)
    display = result if args.live else {
        "schema": result["schema"], "mode": result["mode"],
        "passed": result["passed"], "external_model_called": False,
        "checks": result["checks"],
        "manifest_digest": result["manifest"]["manifest_digest"],
        **({"preflight_path": result["preflight_path"]}
           if "preflight_path" in result else {}),
    }
    print(json.dumps(display, ensure_ascii=False, sort_keys=True, allow_nan=False))
    return 0 if result.get("passed", result.get("supported", False)) else 1


if __name__ == "__main__":
    raise SystemExit(main())
