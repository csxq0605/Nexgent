"""Project one completed DeepSeek Harness spike into a diagnostic Episode.

This is deliberately an evidence-import experiment.  The completed Nexgent
Episode validates and projects already-persisted DSH receipts; it does not
claim that Nexgent admitted, metered, or could recover the original DSH run.

Run after ``dsh_driver.ts`` succeeds::

    python experiments/kernel_spike/dsh_projection.py RECEIPT_DIR \
        --project-root PROJECT_DIR

"""

from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import inspect
import json
import math
from pathlib import Path
import sys


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
if str(REPOSITORY_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT / "src"))

from nexgent.tasks.benchmarks import BenchmarkDescriptor  # noqa: E402
from nexgent.tasks.packages import make_package  # noqa: E402
from nexgent.tasks.runtime import TaskService  # noqa: E402
from nexgent.tasks.tools import ContractError, ToolRegistry  # noqa: E402


EXPECTED_UPSTREAM = "46a7f68b0922371ce7144b668b90e377d8e799f4"
TOOL = "spike.multiply"
PROJECTION_SCHEMA = "nexgent.dsh-diagnostic-projection.v1"
EVIDENCE_SCHEMA = "nexgent.dsh-external-evidence.v1"
BENCHMARK_ID = "dsh-a2-diagnostic-projection"
MAX_RECEIPT_BYTES = 16 * 1024 * 1024


BRIDGE_SOURCE = r'''def execute(payload, context):
    source = context.read_artifact(payload["input_refs"]["validated_receipts"])
    bundle = source["content"]
    if bundle.get("schema") != "nexgent.dsh-diagnostic-projection.v1":
        raise ValueError("unsupported DSH projection schema")
    if bundle.get("host_validation", {}).get("passed") is not True:
        raise ValueError("DSH receipts were not host-validated")
    if bundle.get("answer") != 42:
        raise ValueError("projected answer is not 42")

    identity = bundle.get("identity", {})
    session = bundle.get("session", {})
    if identity.get("backend") != "deepseek-harness":
        raise ValueError("unexpected external backend")
    if identity.get("upstream_commit") != "46a7f68b0922371ce7144b668b90e377d8e799f4":
        raise ValueError("unexpected DSH source revision")
    if not identity.get("session_id") or session.get("header", {}).get("id") != identity.get("session_id"):
        raise ValueError("session identity is not bound to the persisted header")

    events = session.get("events", [])
    if not events or session.get("event_count") != len(events):
        raise ValueError("persisted event count differs")
    first = events[0].get("seq")
    for index, event in enumerate(events):
        if event.get("seq") != first + index:
            raise ValueError("persisted session events are not contiguous")
    cut = session.get("event_cut", {})
    if cut.get("first_seq") != first or cut.get("last_seq") != events[-1].get("seq"):
        raise ValueError("persisted session event cut differs")

    observations = bundle.get("observations", {})
    if observations.get("successful_tool_calls") != 1:
        raise ValueError("successful multiply observation is missing")
    if observations.get("failed_post_unload_calls") != 1:
        raise ValueError("post-unload failure observation is missing")
    if observations.get("sibling_scope_hidden") is not True:
        raise ValueError("sibling isolation observation is missing")
    if observations.get("tool_hidden_after_unload") is not True:
        raise ValueError("tool unload observation is missing")
    if observations.get("fixed_adapter_requests") != 3:
        raise ValueError("fixed-adapter request observation is missing")

    boundary = bundle.get("claim_boundary", {})
    expected_false = (
        "dsh_execution_admitted_by_nexgent",
        "dsh_execution_budget_metered_by_nexgent",
        "dsh_execution_recoverable_by_nexgent",
    )
    for name in expected_false:
        if boundary.get(name) is not False:
            raise ValueError("external execution claim boundary is invalid")
    if boundary.get("projection_episode_only") is not True:
        raise ValueError("projection Episode boundary is missing")

    result = context.publish({"answer": 42}, name="result")
    evidence = context.publish({
        "schema": "nexgent.dsh-external-evidence.v1",
        "projection_kind": "external_diagnostic_evidence_only",
        "validated": True,
        "source_backend": identity["backend"],
        "source_revision": identity["upstream_commit"],
        "dsh_session_id": identity["session_id"],
        "sibling_session_id": identity["sibling_session_id"],
        "source_artifact": {
            "id": source["id"],
            "content_digest": source["content_digest"],
        },
        "source_digests": bundle["source_digests"],
        "event_cut": cut,
        "observations": observations,
        "claim_boundary": boundary,
    }, name="external_evidence")
    return {
        "deliverables": {
            "result": result["id"],
            "external_evidence": evidence["id"],
        },
        "summary": "Checked and projected persisted DSH receipt consistency.",
        "limitations": [
            "The original DSH execution was not admitted or metered by Nexgent.",
            "Only this diagnostic projection Episode is Nexgent-completed.",
        ],
    }
'''


def _canonical(value):
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        allow_nan=False,
    )


def _digest_bytes(value):
    return hashlib.sha256(value).hexdigest()


def _digest_json(value):
    return _digest_bytes(_canonical(value).encode("utf-8"))


def _require(condition, message):
    if not condition:
        raise ContractError(message)


def _read_receipt(path):
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise ContractError(f"Receipt is unavailable: {path.name}") from exc
    _require(path.is_file(), f"Receipt is not a regular file: {path.name}")
    _require(0 < size <= MAX_RECEIPT_BYTES,
             f"Receipt size is invalid: {path.name}")
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise ContractError(f"Receipt is not readable UTF-8: {path.name}") from exc


def _parse_jsonl(text, label):
    rows = []
    for line_number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except (ValueError, RecursionError) as exc:
            raise ContractError(
                f"{label} line {line_number} is not valid JSON") from exc
        _require(isinstance(row, dict),
                 f"{label} line {line_number} must be a JSON object")
        rows.append(row)
    _require(rows, f"{label} is empty")
    return rows


def _tool_names(header_event):
    header = header_event.get("data", {}).get("header", {})
    tools = header.get("tools", []) if isinstance(header, dict) else []
    if not isinstance(tools, list):
        return []
    return [tool.get("name") for tool in tools if isinstance(tool, dict)
            and isinstance(tool.get("name"), str)]


def _message_text(message):
    if not isinstance(message, dict) or not isinstance(message.get("content"), list):
        return ""
    return "".join(
        block.get("text", "") for block in message["content"]
        if isinstance(block, dict) and block.get("type") == "text"
        and isinstance(block.get("text"), str)
    )


def validate_receipts(receipt_dir):
    """Validate one driver receipt directory and return a JSON-bound bundle."""
    receipt_dir = Path(receipt_dir).resolve()
    _require(receipt_dir.is_dir(), "Receipt directory does not exist")
    summary_text = _read_receipt(receipt_dir / "summary.json")
    session_text = _read_receipt(receipt_dir / "session.jsonl")
    side_text = _read_receipt(receipt_dir / "plugin-receipts.jsonl")
    sibling_text = _read_receipt(receipt_dir / "sibling-session.jsonl")
    try:
        summary = json.loads(summary_text)
    except (ValueError, RecursionError) as exc:
        raise ContractError("summary.json is not valid JSON") from exc
    _require(isinstance(summary, dict), "summary.json must contain an object")
    session_rows = _parse_jsonl(session_text, "session.jsonl")
    side_rows = _parse_jsonl(side_text, "plugin-receipts.jsonl")
    sibling_rows = _parse_jsonl(sibling_text, "sibling-session.jsonl")

    _require(summary.get("passed") is True, "DSH driver did not report success")
    _require(summary.get("backend") == "deepseek-harness",
             "Unexpected DSH backend identity")
    _require(summary.get("upstreamCommit") == EXPECTED_UPSTREAM,
             "DSH source revision differs from the pinned spike")
    _require(summary.get("profile") == "headless", "Unexpected DSH profile")
    _require(summary.get("model") == "spike-mock/fixed",
             "Unexpected fixed-model identity")
    _require(summary.get("final") == '{"answer":42}',
             "Driver final delivery differs from the A2 task")
    session_id = summary.get("taskSessionId")
    sibling_id = summary.get("siblingSessionId")
    _require(isinstance(session_id, str) and session_id,
             "Driver summary has no task session identity")
    _require(isinstance(sibling_id, str) and sibling_id and sibling_id != session_id,
             "Driver summary has no distinct sibling session identity")
    plugin_digest = summary.get("pluginSha256")
    _require(isinstance(plugin_digest, str) and len(plugin_digest) == 64
             and all(character in "0123456789abcdef" for character in plugin_digest),
             "Driver plugin digest is invalid")
    assertions = summary.get("assertions")
    expected_assertions = {
        "agentScopedToolRegistered", "hiddenFromSiblingScope", "firstCallReturned42",
        "unloadedBeforeSecondRequest", "postUnloadCallFailed",
        "materializedSessionJsonlCopied",
    }
    _require(isinstance(assertions, dict)
             and all(assertions.get(name) is True for name in expected_assertions),
             "Driver lifecycle assertions are incomplete")
    _require(assertions.get("fixedAdapterRequestsObserved") == 3,
             "Driver did not observe exactly three fixed-adapter requests")
    receipt_digests = summary.get("receiptSha256")
    _require(isinstance(receipt_digests, dict),
             "Driver summary has no receipt digest map")
    for name, text in (
            ("session.jsonl", session_text),
            ("sibling-session.jsonl", sibling_text),
            ("plugin-receipts.jsonl", side_text)):
        _require(receipt_digests.get(name) == _digest_bytes(text.encode("utf-8")),
                 f"Driver receipt digest differs for {name}")
    for name in ("patchSha256", "builtEntrypointSha256", "lockfileSha256"):
        value = summary.get(name)
        _require(isinstance(value, str) and len(value) == 64
                 and all(character in "0123456789abcdef" for character in value),
                 f"Driver source identity is invalid: {name}")

    header = session_rows[0]
    events = session_rows[1:]
    _require(header.get("type") == "session", "Persisted session header is missing")
    _require(header.get("id") == session_id,
             "Persisted session header differs from the streamed identity")
    _require(type(header.get("version")) is int and header["version"] >= 1,
             "Persisted session format version is invalid")
    _require(type(header.get("createdAt")) in {int, float}
             and math.isfinite(header["createdAt"]) and header["createdAt"] >= 0,
             "Persisted session creation time is invalid")
    _require(type(header.get("isSeeded")) is bool,
             "Persisted session seed marker is invalid")
    _require(type(header.get("delegationDepth")) is int
             and header["delegationDepth"] >= 0,
             "Persisted session delegation depth is invalid")
    sibling_header = sibling_rows[0]
    sibling_events = sibling_rows[1:]
    _require(sibling_header.get("type") == "session"
             and sibling_header.get("id") == sibling_id,
             "Persisted sibling session identity differs")
    _require(all(event.get("seq") == index for index, event in enumerate(sibling_events)),
             "Persisted sibling session sequence is not contiguous")
    _require(not any(event.get("type") in {"tool/call", "tool/result"}
                     for event in sibling_events),
             "Persisted sibling session contains a multiply execution")
    _require(events, "Persisted session has no events")
    first_seq = events[0].get("seq")
    _require(type(first_seq) is int and first_seq >= 0,
             "Persisted session has no valid first sequence")
    for index, event in enumerate(events):
        _require(event.get("seq") == first_seq + index,
                 "Persisted session sequence is not contiguous")
        _require(isinstance(event.get("type"), str) and event["type"],
                 "Persisted session event type is invalid")
        event_time = event.get("time")
        _require(type(event_time) in {int, float} and math.isfinite(event_time)
                 and event_time >= 0,
                 "Persisted session event time is invalid")
        _require(isinstance(event.get("data"), dict),
                 "Persisted session event data is invalid")

    headers = [row for row in events if row["type"] == "request/header"]
    calls = [row for row in events if row["type"] == "tool/call"]
    results = [row for row in events if row["type"] == "tool/result"]
    assistants = [row for row in events if row["type"] == "assistant/message"]
    _require(len(headers) >= 2, "Persisted request headers do not show unload")
    _require(_tool_names(headers[0]) == [TOOL],
             "Initial request did not expose exactly the multiply tool")
    _require(all(TOOL not in _tool_names(row) for row in headers[1:]),
             "Multiply remained visible in a later request header")
    _require(len(calls) == 2 and all(row["data"].get("name") == TOOL for row in calls),
             "Persisted log must contain success and post-unload multiply calls")
    _require(calls[0]["data"].get("arguments") == '{"left":6,"right":7}',
             "Persisted multiply arguments differ from the A2 task")
    call_ids = [row["data"].get("callId") for row in calls]
    _require(all(isinstance(call_id, str) and call_id for call_id in call_ids)
             and len(set(call_ids)) == 2,
             "Persisted tool call identities are invalid")
    _require(len(results) == 2, "Persisted tool results are incomplete")
    result_messages = [row["data"].get("message") for row in results]
    _require([message.get("toolCallId") for message in result_messages
              if isinstance(message, dict)] == call_ids,
             "Persisted tool calls and results are not paired")
    _require(result_messages[0].get("isError") is not True
             and _message_text(result_messages[0]) == '{"value":42}',
             "Persisted multiply success is missing")
    _require(result_messages[1].get("isError") is True
             and f'unknown tool "{TOOL}"' in _message_text(result_messages[1]),
             "Persisted post-unload failure is missing")
    _require(assistants, "Persisted assistant delivery is missing")
    final_text = _message_text(assistants[-1]["data"].get("message"))
    try:
        final_value = json.loads(final_text)
    except (ValueError, RecursionError) as exc:
        raise ContractError("Persisted assistant delivery is not JSON") from exc
    _require(final_value == {"answer": 42},
             "Persisted assistant delivery differs from the A2 result")
    _require(any(row["type"] == "turn/end" for row in events),
             "Persisted session has no terminal turn event")

    installed = [row for row in side_rows if row.get("type") == "tool_installed"]
    unloaded = [row for row in side_rows if row.get("type") == "tool_unloaded"]
    probes = [row for row in side_rows if row.get("type") == "scope_probe"]
    model_requests = [row for row in side_rows if row.get("type") == "model_request"]
    _require(len(installed) == 1 and installed[0].get("sessionId") == session_id
             and installed[0].get("tool") == TOOL
             and installed[0].get("schemas") == [TOOL],
             "Task-scope install receipt is invalid")
    _require(len(unloaded) == 1 and unloaded[0].get("sessionId") == session_id
             and unloaded[0].get("tool") == TOOL
             and unloaded[0].get("visibleAfter") is False,
             "Task-scope unload receipt is invalid")
    _require(len(probes) == 1 and probes[0].get("sessionId") == sibling_id
             and probes[0].get("isError") is True
             and TOOL not in probes[0].get("schemas", []),
             "Sibling-scope probe receipt is invalid")
    _require(len(model_requests) == 3
             and all(row.get("sessionId") == session_id for row in model_requests),
             "Fixed-model request receipts are incomplete")
    _require(model_requests[0].get("tools") == [TOOL]
             and all(TOOL not in row.get("tools", []) for row in model_requests[1:]),
             "Fixed-model receipts do not show the schema change")
    _require(all(type(row.get("at")) in {int, float}
                 and math.isfinite(row["at"]) for row in side_rows),
             "Side receipt timestamps are invalid")

    observations = {
        "successful_tool_calls": 1,
        "failed_post_unload_calls": 1,
        "sibling_scope_hidden": True,
        "tool_hidden_after_unload": True,
        "fixed_adapter_requests": 3,
    }
    claim_boundary = {
        "projection_episode_only": True,
        "dsh_execution_admitted_by_nexgent": False,
        "dsh_execution_budget_metered_by_nexgent": False,
        "dsh_execution_recoverable_by_nexgent": False,
    }
    bundle = {
        "schema": PROJECTION_SCHEMA,
        "answer": 42,
        "identity": {
            "backend": summary["backend"],
            "upstream_commit": summary["upstreamCommit"],
            "profile": summary["profile"],
            "model": summary["model"],
            "session_id": session_id,
            "sibling_session_id": sibling_id,
            "plugin_sha256": plugin_digest,
            "patch_sha256": summary["patchSha256"],
            "built_entrypoint_sha256": summary["builtEntrypointSha256"],
            "lockfile_sha256": summary["lockfileSha256"],
        },
        "session": {
            "header": deepcopy(header),
            "events": deepcopy(events),
            "event_count": len(events),
            "event_cut": {"first_seq": first_seq, "last_seq": events[-1]["seq"]},
        },
        "side_receipts": deepcopy(side_rows),
        "sibling_session": {
            "header": deepcopy(sibling_header),
            "events": deepcopy(sibling_events),
        },
        "source_digests": {
            "summary_sha256": _digest_bytes(summary_text.encode("utf-8")),
            "session_jsonl_sha256": _digest_bytes(session_text.encode("utf-8")),
            "plugin_receipts_sha256": _digest_bytes(side_text.encode("utf-8")),
            "sibling_session_jsonl_sha256": _digest_bytes(sibling_text.encode("utf-8")),
            "plugin_sha256": plugin_digest,
            "patch_sha256": summary["patchSha256"],
            "built_entrypoint_sha256": summary["builtEntrypointSha256"],
            "lockfile_sha256": summary["lockfileSha256"],
        },
        "observations": observations,
        "claim_boundary": claim_boundary,
        "host_validation": {
            "passed": True,
            "validator": "experiments/kernel_spike/dsh_projection.py",
            "checks_digest": _digest_json({
                "upstream": EXPECTED_UPSTREAM,
                "tool": TOOL,
                "answer": 42,
                "event_count": len(events),
                "observations": observations,
                "claim_boundary": claim_boundary,
            }),
        },
    }
    # Force a final finite-JSON copy before it enters EpisodeStore.
    return json.loads(_canonical(bundle))


def _result_schema():
    return {
        "type": "object", "additionalProperties": False,
        "required": ["answer"],
        "properties": {"answer": {"const": 42}},
    }


def _evidence_schema():
    digest_schema = {"type": "string", "pattern": "^[0-9a-f]{64}$"}
    return {
        "type": "object", "additionalProperties": False,
        "required": [
            "schema", "projection_kind", "validated", "source_backend",
            "source_revision", "dsh_session_id", "sibling_session_id",
            "source_artifact", "source_digests", "event_cut", "observations",
            "claim_boundary",
        ],
        "properties": {
            "schema": {"const": EVIDENCE_SCHEMA},
            "projection_kind": {"const": "external_diagnostic_evidence_only"},
            "validated": {"const": True},
            "source_backend": {"const": "deepseek-harness"},
            "source_revision": {"const": EXPECTED_UPSTREAM},
            "dsh_session_id": {"type": "string", "minLength": 1},
            "sibling_session_id": {"type": "string", "minLength": 1},
            "source_artifact": {
                "type": "object", "additionalProperties": False,
                "required": ["id", "content_digest"],
                "properties": {
                    "id": {"type": "string", "pattern": "^artifact-[0-9a-f]{16}$"},
                    "content_digest": digest_schema,
                },
            },
            "source_digests": {
                "type": "object", "additionalProperties": False,
                "required": ["summary_sha256", "session_jsonl_sha256",
                             "plugin_receipts_sha256", "sibling_session_jsonl_sha256",
                             "plugin_sha256", "patch_sha256",
                             "built_entrypoint_sha256", "lockfile_sha256"],
                "properties": {
                    "summary_sha256": digest_schema,
                    "session_jsonl_sha256": digest_schema,
                    "plugin_receipts_sha256": digest_schema,
                    "sibling_session_jsonl_sha256": digest_schema,
                    "plugin_sha256": digest_schema,
                    "patch_sha256": digest_schema,
                    "built_entrypoint_sha256": digest_schema,
                    "lockfile_sha256": digest_schema,
                },
            },
            "event_cut": {
                "type": "object", "additionalProperties": False,
                "required": ["first_seq", "last_seq"],
                "properties": {
                    "first_seq": {"type": "integer", "minimum": 0},
                    "last_seq": {"type": "integer", "minimum": 0},
                },
            },
            "observations": {"type": "object"},
            "claim_boundary": {"type": "object"},
        },
    }


def bridge_package():
    return make_package(
        {"agent/main.py": BRIDGE_SOURCE},
        {"entries": {"execute": "agent/main.py:execute"}},
        provenance={
            "origin": "nexgent.kernel-spike.dsh-diagnostic-projection",
            "trust": "static-host-authored-bridge",
        },
    )


class ProjectionBenchmark:
    """Local host adapter for the diagnostic projection, not a benchmark suite."""

    id = BENCHMARK_ID
    descriptor = BenchmarkDescriptor(
        id=BENCHMARK_ID,
        version="1",
        title="DSH A2 diagnostic evidence projection",
        splits=("development",),
        default_split="development",
        modes=("fixed",),
        allowed_suite_roles=("demo_only",),
        evidence_scope="Persisted DSH receipt internal consistency only",
    )

    def describe(self):
        return self.descriptor.as_dict()

    def snapshot(self):
        source_identity = {
            "validator_sha256": _digest_bytes(
                inspect.getsource(validate_receipts).encode("utf-8")),
            "bridge_sha256": _digest_bytes(BRIDGE_SOURCE.encode("utf-8")),
            "adapter_sha256": _digest_bytes(
                inspect.getsource(type(self)).encode("utf-8")),
        }
        return {
            "id": self.id,
            "schema": "nexgent.dsh-diagnostic-projection-benchmark.v1",
            "source_identity": source_identity,
            "criteria_digest": _digest_json({
                "answer": 42,
                "projection_kind": "external_diagnostic_evidence_only",
                "nexgent_projection_model_calls": 0,
                "nexgent_projection_tool_calls": 0,
                "source_identity": source_identity,
            }),
        }

    def tasks(self, split="development", seed=0, **options):
        if split != "development" or type(seed) is not int or options:
            raise ContractError("Projection benchmark only exposes its fixed development task")
        return [projection_task_ref()]

    def evaluate(self, task_ref, deliverables, execution_view):
        result = deliverables.get("result")
        evidence = deliverables.get("external_evidence")
        usage = execution_view.get("usage", {})
        boundary = evidence.get("claim_boundary", {}) if isinstance(evidence, dict) else {}
        accepted = (
            task_ref.get("id") == "dsh-a2/projection/6x7"
            and result == {"answer": 42}
            and isinstance(evidence, dict)
            and evidence.get("schema") == EVIDENCE_SCHEMA
            and evidence.get("validated") is True
            and evidence.get("projection_kind") == "external_diagnostic_evidence_only"
            and execution_view.get("status") == "completed"
            and usage.get("model_calls") == 0
            and usage.get("tool_calls") == 0
            and boundary.get("projection_episode_only") is True
            and boundary.get("dsh_execution_admitted_by_nexgent") is False
            and boundary.get("dsh_execution_budget_metered_by_nexgent") is False
            and boundary.get("dsh_execution_recoverable_by_nexgent") is False
        )
        return {
            "status": "accepted" if accepted else "rejected",
            "score_available": True,
            "score": 1.0 if accepted else 0.0,
            "accepted": accepted,
            "scope": "receipt_internal_consistency_only",
        }


def projection_task_ref():
    return {
        "id": "dsh-a2/projection/6x7",
        "statistical_unit_id": "dsh-a2/projection/6x7/diagnostic",
        "cluster_id": "dsh-a2-external-evidence",
        "objective": "Validate and project persisted DSH A2 receipts.",
        "inputs": {},
        "deliverables": [
            {"name": "result", "schema": _result_schema()},
            {"name": "external_evidence", "schema": _evidence_schema()},
        ],
        "capabilities": [],
        "constraints": {"allowed_effects": []},
        "context": {
            "split": "development",
            "split_role": "development",
            "projection_kind": "external_diagnostic_evidence_only",
        },
    }


def project(receipt_dir, project_root):
    bundle = validate_receipts(receipt_dir)
    adapter = ProjectionBenchmark()
    task_ref = projection_task_ref()
    snapshot = adapter.snapshot()
    registration = {
        "benchmark_id": adapter.id,
        "snapshot": snapshot,
        "task_ref": task_ref,
    }
    service = TaskService(Path(project_root), tools=ToolRegistry())
    episode = service.create(
        task_ref["objective"],
        inputs={"validated_receipts": bundle},
        deliverables=task_ref["deliverables"],
        budget={
            "max_model_calls": 0,
            "max_completion_tokens": 0,
            "max_tool_calls": 0,
            "max_tool_work_units": 0,
            "max_nodes": 16,
        },
        capabilities=[],
        constraints=task_ref["constraints"],
        context=task_ref["context"],
        package=bridge_package(),
        benchmark_registration=registration,
    )
    service.store.event(episode["id"], "external_evidence_attached", {
        "schema": PROJECTION_SCHEMA,
        "session_id": bundle["identity"]["session_id"],
        "source_digests": bundle["source_digests"],
        "input_artifact_ref": episode["input_refs"]["validated_receipts"],
        "claim_boundary": bundle["claim_boundary"],
    })
    completed = service.run(episode["id"])
    _require(completed["status"] == "completed",
             "Diagnostic projection Episode did not complete")
    evaluated = service.evaluate(
        episode["id"], adapter, task_ref, snapshot=snapshot)
    report = evaluated["evaluation"]
    _require(report.get("accepted") is True,
             "Diagnostic projection benchmark rejected the Episode")
    state = service.get_private(episode["id"])
    evidence = service.store.read(
        state["output_refs"]["external_evidence"], episode["id"])
    return {
        "schema": "nexgent.dsh-diagnostic-projection-result.v1",
        "episode_id": episode["id"],
        "episode_status": state["status"],
        "projection_kind": "external_diagnostic_evidence_only",
        "projection_claim": (
            "Nexgent completed and evaluated an internal-consistency projection "
            "of persisted external DSH receipts."
        ),
        "does_not_claim": [
            "The original DSH execution was admitted by Nexgent.",
            "The original DSH model or tool calls were budget-metered by Nexgent.",
            "The original DSH execution is recoverable through TaskService.",
        ],
        "dsh_session_id": bundle["identity"]["session_id"],
        "package_digest": state["package_digest"],
        "benchmark_snapshot": snapshot,
        "evaluation": report,
        "projection_usage": state["usage"],
        "external_execution_usage": {
            "status": "unknown",
            "reason": (
                "The receipts do not establish complete external model, token, "
                "tool, or work-unit accounting."
            ),
            "model_calls": None,
            "completion_tokens": None,
            "tool_calls": None,
            "tool_work_units": None,
        },
        "output_refs": deepcopy(state["output_refs"]),
        "external_evidence_digest": evidence["content_digest"],
        "project_root": str(Path(project_root).resolve()),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("receipt_dir", type=Path,
                        help="Successful dsh_driver.ts receipt directory")
    parser.add_argument("--project-root", type=Path,
                        help="Nexgent project root for the projection Episode")
    args = parser.parse_args(argv)
    project_root = args.project_root or args.receipt_dir / "nexgent-projection"
    result = project(args.receipt_dir, project_root)
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
