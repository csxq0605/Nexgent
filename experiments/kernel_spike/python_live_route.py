"""One bounded live-model probe through the existing Nexgent Python task API.

The credential stays in memory.  The emitted receipt contains only its fixed
environment-variable reference and a boolean leak scan result.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import inspect
import json
from pathlib import Path
import tempfile
import threading
from urllib.parse import urlsplit

from nexgent.models.config import ModelConfigurationError, Profile
from nexgent.models.gateway import (
    ModelBudgetError,
    ModelError,
    ModelGateway,
    ModelTransportError,
)
from nexgent.models.worker import response_payload
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ToolRegistry, ToolSpec


MODEL_SOURCE_ROOT = Path(r"E:\PKU\program\2026\Aug\te\NExgent")
MODEL = "mimo-v2.6-flash"
PROVIDER = "mimo"
CREDENTIAL_REF = "NEXGENT_API_KEY"
TOOL = "spike.multiply"
BUDGET = {
    "max_model_calls": 2,
    "max_completion_tokens": 512,
    "max_tool_calls": 1,
    "max_tool_work_units": 0,
    "max_nodes": 8,
}

SOURCE = r'''def execute(payload, context):
    decision = context.ask(
        "tool_selector",
        "Choose exactly one authorized tool to compute 6 times 7. Return only "
        "{\"tool\":\"spike.multiply\",\"arguments\":{\"left\":6,\"right\":7}}.",
        {"authorized_tools": payload["tools"], "objective": "Compute 6 times 7"},
        max_tokens=128,
    )
    if decision["tool"] != "spike.multiply":
        raise ValueError("Model selected a tool outside the expected live-route contract")
    value = context.tool(decision["tool"], decision["arguments"])
    answer = context.ask(
        "answer_writer",
        "Use the supplied completed tool result. Return exactly one JSON object "
        "with the single integer field answer and no other fields.",
        {"objective": "Deliver the answer for 6 times 7", "tool_result": value},
        max_tokens=384,
    )
    if answer.get("answer") != value["value"]:
        raise ValueError("Model answer does not match the completed tool result")
    artifact = context.publish(answer, name="result")
    return {"deliverables": {"result": artifact["id"]}}
'''


def multiply(arguments, context):
    return {"value": arguments["left"] * arguments["right"]}


HANDLER_DIGEST = hashlib.sha256(inspect.getsource(multiply).encode("utf-8")).hexdigest()


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False)


def _sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _dotenv_value(path, name):
    for raw in Path(path).read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.removeprefix("export ").split("=", 1)
        if key.strip() != name:
            continue
        value = value.strip()
        if len(value) > 1 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        return value
    return ""


def _normalized_mimo_url(raw):
    parsed = urlsplit(raw.strip())
    if (parsed.scheme.lower() != "https"
            or parsed.hostname != "token-plan-cn.xiaomimimo.com"
            or parsed.username is not None or parsed.password is not None
            or parsed.query or parsed.fragment
            or parsed.path.rstrip("/") != "/v1"
            or parsed.port not in (None, 443)):
        raise ModelConfigurationError("MiMo base URL does not match the bounded live-route endpoint")
    return "https://token-plan-cn.xiaomimimo.com/v1"


def _load_live_profile():
    models_path = MODEL_SOURCE_ROOT / "models.json"
    env_path = MODEL_SOURCE_ROOT / ".env"
    data = json.loads(models_path.read_text(encoding="utf-8-sig"))
    settings = data["providers"][PROVIDER]
    reference = settings.get("api_key")
    if reference not in {"${NEXGENT_API_KEY}", "$NEXGENT_API_KEY"}:
        raise ModelConfigurationError("MiMo credential is not bound to NEXGENT_API_KEY")
    api_key = _dotenv_value(env_path, CREDENTIAL_REF)
    if not api_key:
        raise ModelConfigurationError("NEXGENT_API_KEY is not configured")
    base_url = _normalized_mimo_url(settings["base_url"])
    identity = {
        "provider": PROVIDER,
        "base_url": base_url,
        "model": MODEL,
        "credential_ref": CREDENTIAL_REF,
        "models_json_sha256": _sha256(models_path),
    }
    digest = hashlib.sha256(_canonical(identity).encode("utf-8")).hexdigest()
    return Profile(f"{PROVIDER}/{MODEL}", MODEL, base_url, api_key), identity, digest


def _transport_diagnostics(exc):
    causes, seen, current = [], set(), exc
    status, error_number = None, None
    while current is not None and id(current) not in seen and len(causes) < 8:
        seen.add(id(current))
        name = type(current).__name__
        causes.append(name[:80] if name.isidentifier() else "Exception")
        candidate = getattr(current, "status_code", None)
        if type(candidate) is int and 100 <= candidate <= 599:
            status = candidate
        candidate = getattr(current, "errno", None)
        if type(candidate) is int and -100000 <= candidate <= 100000:
            error_number = candidate
        current = current.__cause__ or current.__context__
    phase = "unknown"
    for names, candidate in (
        ({"gaierror"}, "dns_resolution"),
        ({"SSLError", "SSLCertVerificationError"}, "tls_handshake"),
        ({"ProxyError"}, "proxy_connection"),
        ({"ConnectTimeout", "ConnectError", "ConnectionRefusedError"}, "connect"),
        ({"ReadTimeout", "ReadError", "RemoteProtocolError"}, "response_read"),
        ({"WriteTimeout", "WriteError"}, "request_write"),
        ({"PoolTimeout"}, "connection_pool"),
    ):
        if names.intersection(causes):
            phase = candidate
            break
    if phase == "unknown" and status is not None:
        phase = "http_response"
    return {"cause_types": causes, "stage": "request", "connection_phase": phase,
            "http_status": status, "errno": error_number}


def _live_transport(profile, params):
    """One provider attempt with SDK retries explicitly disabled."""
    client = None
    try:
        from openai import OpenAI
        client = OpenAI(api_key=profile.api_key, base_url=profile.base_url,
                        timeout=90, max_retries=0)
        return response_payload(client.chat.completions.create(**deepcopy(params)))
    except Exception as exc:
        raise ModelTransportError(
            "Live provider request failed; no retry was attempted",
            _transport_diagnostics(exc),
        ) from None
    finally:
        if client is not None:
            client.close()


def _tool_spec(*, leased=False):
    integer = {"type": "integer"}
    fields = {}
    if leased:
        fields = {
            "provider_id": "nexgent.kernel-spike",
            "provider_version": "1",
            "handler_digest": HANDLER_DIGEST,
        }
    return ToolSpec(
        TOOL,
        {"type": "object", "properties": {"left": integer, "right": integer},
         "required": ["left", "right"], "additionalProperties": False},
        {"type": "object", "properties": {"value": integer},
         "required": ["value"], "additionalProperties": False},
        "local_compute", multiply, description="Multiply two integers", **fields,
    )


def _package():
    return make_package({"agent/main.py": SOURCE},
                        {"entries": {"execute": "agent/main.py:execute"}})


def _safe_call_receipt(row):
    fields = (
        "call_id", "role", "model", "provider_model",
        "configured_provider_model", "observed_provider_model",
        "provider_revision", "profile_digest", "profile_identity", "status",
        "finish_reason", "billing_status", "max_completion_tokens",
        "reserved_completion_tokens", "usage", "error_type",
        "transport_diagnostics",
    )
    return {key: deepcopy(row[key]) for key in fields if key in row}


def _failure_receipt(state, calls, stage="episode_run"):
    if state.get("status") == "completed":
        return None
    last = calls[-1] if calls else {}
    error_type = last.get("error_type")
    diagnostics = last.get("transport_diagnostics") or {}
    if error_type == "ModelTransportError":
        category = "provider_transport"
        failure_stage = diagnostics.get("stage") or stage
        remote_unknown = diagnostics.get("connection_phase") in {
            "request_write", "response_read", "http_response", "unknown"}
    elif error_type in {"ModelError", "ModelBudgetError"}:
        category = "provider_response" if error_type == "ModelError" else "budget"
        failure_stage, remote_unknown = stage, False
    elif not calls:
        category, failure_stage, remote_unknown = "configuration_or_admission", stage, False
    else:
        category, failure_stage, remote_unknown = "task_protocol", stage, False
    return {"stage": failure_stage, "class": category,
            "remote_outcome_unknown": bool(remote_unknown),
            "episode_failure_domain": state.get("failure_domain")}


def _leak_free(root, report_text, secret):
    needle = secret.encode("utf-8")
    if not needle or secret in report_text:
        return False
    for path in Path(root).rglob("*"):
        if path.is_file() and needle in path.read_bytes():
            return False
    return True


def _active_inventory(service, episode_id):
    return [
        {
            "name": lease["name"],
            "revision": lease["revision"],
            "descriptor_digest": lease["descriptor"]["digest"],
        }
        for lease in service.active_capabilities(episode_id)
    ]


def run(*, leased=False):
    scratch_parent = MODEL_SOURCE_ROOT.parent
    project_root = Path(tempfile.mkdtemp(
        prefix=".nexgent-python-live-", dir=scratch_parent)).resolve()
    profile = None
    profile_identity = None
    profile_digest = None
    service = None
    episode_id = None
    failure = None
    lease_receipt = {
        "mode": "leased",
        "mount_revision": None,
        "release_revision": None,
        "descriptor_digest": None,
        "active_inventory": {},
        "provenance": (
            "The model did not develop or install the tool. The host mounted the "
            "prewritten installed tool into the Episode."
        ),
    } if leased else None
    try:
        profile, profile_identity, profile_digest = _load_live_profile()

        def gateway_factory(reserve, stop_event):
            def audited_reserve(receipt):
                receipt = deepcopy(receipt)
                receipt["profile_identity"] = deepcopy(profile_identity)
                receipt["profile_digest"] = profile_digest
                receipt["credential_configured"] = True
                reserve(receipt)

            gateway = ModelGateway(
                MODEL_SOURCE_ROOT,
                reserve=audited_reserve,
                stop_event=stop_event,
                timeout=90,
                transport=_live_transport,
                max_completion_tokens=384,
            )
            gateway.profiles = {profile.id: profile}
            gateway.defaults = {
                "main": profile.id,
                "subagent": profile.id,
                "tool_selector": profile.id,
                "answer_writer": profile.id,
            }
            return gateway

        spec = _tool_spec(leased=leased)
        package = _package()
        service = TaskService(
            project_root, tools=ToolRegistry([spec]),
            gateway_factory=gateway_factory)
        create_fields = {"initially_active_capabilities": []} if leased else {}
        state = service.create(
            "Compute 6 × 7 with the authorized multiply tool and deliver the model's JSON answer.",
            deliverables=[{"name": "result", "schema": {
                "type": "object", "properties": {"answer": {"const": 42}},
                "required": ["answer"], "additionalProperties": False}}],
            budget=BUDGET,
            capabilities=[TOOL],
            package=package,
            constraints={"allowed_effects": ["local_compute"], "wall_seconds": 240},
            **create_fields,
        )
        episode_id = state["id"]
        mounted_lease = None
        if leased:
            lease_receipt["active_inventory"]["after_creation"] = _active_inventory(
                service, episode_id)
            mounted_lease = service.mount_capability(episode_id, TOOL)
            lease_receipt["mount_revision"] = mounted_lease["revision"]
            lease_receipt["descriptor_digest"] = mounted_lease["descriptor"]["digest"]
            lease_receipt["active_inventory"]["after_mount"] = _active_inventory(
                service, episode_id)
        service.run(episode_id, stop_event=threading.Event())
        if leased:
            lease_receipt["active_inventory"]["after_completion"] = _active_inventory(
                service, episode_id)
            released_lease = service.release_capability(
                episode_id, TOOL, expected_revision=mounted_lease["revision"])
            lease_receipt["release_revision"] = released_lease["revision"]
            lease_receipt["active_inventory"]["after_release"] = _active_inventory(
                service, episode_id)
        private = service.get_private(episode_id)
        calls = private.get("calls", [])
        safe_calls = [_safe_call_receipt(row) for row in calls]
        tool_events = [deepcopy(row["content"]) for row in private.get("events", [])
                       if row.get("kind") == "tool"]
        artifacts = [{key: deepcopy(row[key]) for key in
                      ("id", "name", "schema", "content", "node_id") if key in row}
                     for row in private.get("artifacts", [])]
        failure = _failure_receipt(private, calls)
        observed = [{"configured": row.get("configured_provider_model"),
                     "observed": row.get("observed_provider_model"),
                     "revision": row.get("provider_revision")}
                    for row in safe_calls]
        report = {
            "schema": "nexgent.python-live-route.v1",
            "passed": private.get("status") == "completed",
            "backend": "nexgent-python-live",
            "profile_identity": profile_identity,
            "profile_digest": profile_digest,
            "credential_configured": True,
            "observed_model_identity": observed,
            "retry_policy": {"automatic_retries": 0, "attempts_per_ask": 1},
            "budget": deepcopy(BUDGET),
            "episode": {
                "id": episode_id,
                "status": private.get("status"),
                "package_digest": private.get("package_digest"),
                "output_refs": deepcopy(private.get("output_refs", {})),
                "usage": deepcopy(private.get("usage", {})),
            },
            "model_receipts": safe_calls,
            "tool_receipts": tool_events,
            "artifacts": artifacts,
            "handler_digest": HANDLER_DIGEST,
            "failure": failure,
            "api_boundary": (
                "The current Python task API exchanges JSON through two ask calls; "
                "it does not expose provider-native tool calling. The model selects a "
                "host-authorized tool in call one, the host executes it, and call two "
                "writes the answer from the completed result."
            ),
            "scratch_root": str(project_root),
            "leak_scan_passed": True,
        }
    except (ModelConfigurationError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        failure = {"stage": "configuration", "class": "configuration",
                   "remote_outcome_unknown": False}
        report = {
            "schema": "nexgent.python-live-route.v1", "passed": False,
            "profile_identity": profile_identity, "profile_digest": profile_digest,
            "credential_configured": bool(profile is not None),
            "episode": {"id": episode_id}, "failure": failure,
            "scratch_root": str(project_root), "leak_scan_passed": True,
        }
    except (ModelTransportError, ModelError, ModelBudgetError):
        report = {
            "schema": "nexgent.python-live-route.v1", "passed": False,
            "profile_identity": profile_identity, "profile_digest": profile_digest,
            "credential_configured": bool(profile is not None),
            "episode": {"id": episode_id},
            "failure": {"stage": "provider_probe", "class": "provider_failure",
                        "remote_outcome_unknown": True},
            "scratch_root": str(project_root), "leak_scan_passed": True,
        }
    except Exception:
        report = {
            "schema": "nexgent.python-live-route.v1", "passed": False,
            "profile_identity": profile_identity, "profile_digest": profile_digest,
            "credential_configured": bool(profile is not None),
            "episode": {"id": episode_id},
            "failure": {"stage": "host", "class": "unexpected_host_failure",
                        "remote_outcome_unknown": False},
            "scratch_root": str(project_root), "leak_scan_passed": True,
        }

    if lease_receipt is not None:
        report["capability_lease"] = deepcopy(lease_receipt)

    secret = profile.api_key if profile is not None else _dotenv_value(
        MODEL_SOURCE_ROOT / ".env", CREDENTIAL_REF)
    serialized = json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2)
    passed = _leak_free(project_root, serialized, secret)
    report["leak_scan_passed"] = passed
    summary_path = project_root / "python-live-summary.json"
    if passed:
        summary_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                                encoding="utf-8")
        passed = _leak_free(project_root, summary_path.read_text(encoding="utf-8"), secret)
        report["leak_scan_passed"] = passed
    if not passed:
        report = {"schema": "nexgent.python-live-route.v1", "passed": False,
                  "leak_scan_passed": False}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report.get("passed") else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--leased", action="store_true",
        help="Mount the preinstalled multiply tool through an Episode capability lease.",
    )
    return run(leased=parser.parse_args(argv).leased)


if __name__ == "__main__":
    raise SystemExit(main())
