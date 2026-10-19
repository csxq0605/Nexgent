"""Independent integrity verification for exported Nexgent Harness runs."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .contracts import (
    Diagnosis,
    DependencyEdge,
    DependencyKind,
    ExecutionEvent,
    ExperimentRun,
    FaultObservation,
    FaultSpec,
    GoalSpec,
    RecoveryAction,
    RunAttempt,
    RunStatus,
    SCHEMA_VERSION,
    VerificationDecision,
    VerificationResult,
    WorkflowNode,
)
from .store import SQLiteRunStore


_REQUIRED_EXPORT_KEYS = {
    "export_schema_version",
    "run",
    "attempts",
    "events",
    "dependency_edges",
    "workflow_nodes",
    "artifacts",
    "goals",
    "faults",
    "diagnoses",
    "recoveries",
    "verifications",
}
_SECRET_KEYS = {
    "api_key",
    "apikey",
    "authorization",
    "password",
    "secret",
    "token",
    "access_token",
    "refresh_token",
    "private_key",
}


@dataclass(frozen=True)
class TraceVerificationReport:
    run_id: str | None
    errors: tuple[str, ...]
    warnings: tuple[str, ...]
    counts: dict[str, int]

    @property
    def ok(self) -> bool:
        return not self.errors

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "run_id": self.run_id,
            "errors": list(self.errors),
            "warnings": list(self.warnings),
            "counts": dict(sorted(self.counts.items())),
            "verifier_schema_version": SCHEMA_VERSION,
        }


def load_export_jsonl(
    text: str,
    *,
    allow_corrupt_tail: bool = False,
) -> tuple[dict[str, Any], bool]:
    """Reconstruct an export bundle and optionally drop one malformed tail row."""

    lines = [line for line in text.splitlines() if line.strip()]
    bundle: dict[str, Any] = {
        "export_schema_version": SCHEMA_VERSION,
        "run": None,
        **{
            section: []
            for section in _REQUIRED_EXPORT_KEYS
            if section not in {"export_schema_version", "run"}
        },
    }
    dropped_tail = False
    for index, line in enumerate(lines):
        try:
            wrapper = json.loads(line)
        except json.JSONDecodeError as exc:
            if allow_corrupt_tail and index == len(lines) - 1:
                dropped_tail = True
                break
            raise ValueError(f"invalid JSONL record at line {index + 1}") from exc
        if wrapper.get("export_schema_version") != SCHEMA_VERSION:
            raise ValueError(f"unsupported JSONL schema at line {index + 1}")
        record_type = wrapper.get("record_type")
        if record_type == "run":
            if bundle["run"] is not None:
                raise ValueError("JSONL export contains more than one run record")
            bundle["run"] = wrapper.get("record")
        elif record_type in bundle and isinstance(bundle[record_type], list):
            bundle[record_type].append(wrapper.get("record"))
        else:
            raise ValueError(f"unknown JSONL record type at line {index + 1}")
    if bundle["run"] is None:
        raise ValueError("JSONL export has no run record")
    return bundle, dropped_tail


def _unredacted_secret_paths(value: Any, path: str = "$.") -> list[str]:
    paths: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            normalized = str(key).lower().replace("-", "_")
            child_path = f"{path}{key}"
            if (
                normalized in _SECRET_KEYS or normalized.endswith("_api_key")
            ) and item != "[REDACTED]":
                paths.append(child_path)
            paths.extend(_unredacted_secret_paths(item, child_path + "."))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            paths.extend(_unredacted_secret_paths(item, f"{path}[{index}]."))
    return paths


def verify_export(
    bundle: dict[str, Any],
    *,
    required_event_kinds: Iterable[str] = (),
    required_runtime_kinds: Iterable[str] = (),
    strict_lifecycles: bool = False,
) -> TraceVerificationReport:
    """Validate one portable evidence bundle without trusting its source store."""

    errors: list[str] = []
    warnings: list[str] = []
    counts: dict[str, int] = {}
    run_id: str | None = None

    if not isinstance(bundle, dict):
        return TraceVerificationReport(None, ("export must be a JSON object",), (), {})
    missing_keys = sorted(_REQUIRED_EXPORT_KEYS - set(bundle))
    unknown_keys = sorted(set(bundle) - _REQUIRED_EXPORT_KEYS)
    if missing_keys:
        errors.append(f"missing export sections: {missing_keys}")
    if unknown_keys:
        errors.append(f"unknown export sections: {unknown_keys}")
    if bundle.get("export_schema_version") != SCHEMA_VERSION:
        errors.append("unsupported export schema version")
    if missing_keys:
        return TraceVerificationReport(None, tuple(errors), tuple(warnings), counts)

    try:
        run = ExperimentRun.from_dict(bundle["run"])
        run_id = run.run_id
    except Exception as exc:
        return TraceVerificationReport(
            None,
            tuple(errors + [f"invalid run contract: {exc}"]),
            tuple(warnings),
            counts,
        )

    decoded: dict[str, list[Any]] = {}
    contracts = {
        "attempts": RunAttempt,
        "events": ExecutionEvent,
        "dependency_edges": DependencyEdge,
        "workflow_nodes": WorkflowNode,
        "goals": GoalSpec,
        "diagnoses": Diagnosis,
        "recoveries": RecoveryAction,
        "verifications": VerificationResult,
    }
    for section, contract in contracts.items():
        records = bundle.get(section)
        if not isinstance(records, list):
            errors.append(f"{section} must be a list")
            decoded[section] = []
            continue
        counts[section] = len(records)
        decoded[section] = []
        for index, record in enumerate(records):
            try:
                decoded[section].append(contract.from_dict(record))
            except Exception as exc:
                errors.append(f"invalid {section}[{index}]: {exc}")

    faults = bundle.get("faults")
    decoded_faults: list[Any] = []
    if not isinstance(faults, list):
        errors.append("faults must be a list")
        faults = []
    counts["faults"] = len(faults)
    for index, wrapper in enumerate(faults):
        try:
            record_type = wrapper["record_type"]
            contract = {
                "FaultSpec": FaultSpec,
                "FaultObservation": FaultObservation,
            }[record_type]
            decoded_faults.append(contract.from_dict(wrapper["record"]))
        except Exception as exc:
            errors.append(f"invalid faults[{index}]: {exc}")

    artifacts = bundle.get("artifacts")
    if not isinstance(artifacts, list):
        errors.append("artifacts must be a list")
        artifacts = []
    counts["artifacts"] = len(artifacts)
    artifact_ids: set[str] = set()
    portable_artifacts: list[dict[str, Any]] = []
    for index, artifact in enumerate(artifacts):
        if not isinstance(artifact, dict):
            errors.append(f"artifacts[{index}] must be an object")
            continue
        portable_artifacts.append(artifact)
        artifact_id = artifact.get("artifact_id")
        digest = artifact.get("sha256")
        if not isinstance(artifact_id, str) or not artifact_id:
            errors.append(f"artifacts[{index}] has no artifact_id")
        else:
            artifact_ids.add(artifact_id)
        if (
            not isinstance(digest, str)
            or len(digest) != 64
            or any(character not in "0123456789abcdef" for character in digest.lower())
        ):
            errors.append(f"artifacts[{index}] has invalid sha256")
        if artifact.get("content_address") != f"sha256:{digest}":
            errors.append(f"artifacts[{index}] content address does not match sha256")
        if "path_or_uri" in artifact or "path" in artifact or "blob" in artifact:
            errors.append(f"artifacts[{index}] exposes non-portable content")
        if artifact.get("run_id") != run_id:
            errors.append(f"artifacts[{index}] belongs to another run")

    for path in _unredacted_secret_paths(bundle):
        errors.append(f"unredacted secret field at {path}")

    attempts: list[RunAttempt] = decoded["attempts"]
    events: list[ExecutionEvent] = decoded["events"]
    edges: list[DependencyEdge] = decoded["dependency_edges"]
    workflow_nodes: list[WorkflowNode] = decoded["workflow_nodes"]
    goals: list[GoalSpec] = decoded["goals"]
    diagnoses: list[Diagnosis] = decoded["diagnoses"]
    recoveries: list[RecoveryAction] = decoded["recoveries"]
    verifications: list[VerificationResult] = decoded["verifications"]
    all_run_records = [
        *attempts,
        *events,
        *edges,
        *workflow_nodes,
        *decoded_faults,
        *diagnoses,
        *recoveries,
        *verifications,
    ]
    for record in all_run_records:
        if getattr(record, "run_id", run_id) != run_id:
            errors.append(f"{type(record).__name__} belongs to another run")

    attempt_ids = {attempt.attempt_id for attempt in attempts}
    if run.current_attempt != len(attempts):
        errors.append(
            f"run current_attempt={run.current_attempt} but export has {len(attempts)} attempts"
        )
    sequences = [event.sequence for event in events]
    if sequences != list(range(1, len(events) + 1)):
        errors.append("event sequences are not contiguous and ordered from 1")
    event_by_id = {event.event_id: event for event in events}
    if len(event_by_id) != len(events):
        errors.append("event ids are not unique")
    span_ids = {event.span_id for event in events if event.span_id}
    for event in events:
        if event.attempt_id is not None and event.attempt_id not in attempt_ids:
            errors.append(f"event {event.event_id} refers to a missing attempt")
        if event.causation_event_id is not None:
            cause = event_by_id.get(event.causation_event_id)
            if cause is None:
                errors.append(f"event {event.event_id} has a missing cause")
            elif cause.sequence >= event.sequence:
                errors.append(f"event {event.event_id} cause is not earlier in the trace")
        if event.parent_span_id is not None and event.parent_span_id not in span_ids:
            errors.append(f"event {event.event_id} has a missing parent span")

    for artifact in portable_artifacts:
        producer_event_id = artifact.get("producer_event_id")
        if producer_event_id is not None and producer_event_id not in event_by_id:
            errors.append(
                f"artifact {artifact.get('artifact_id')} has a missing producer event"
            )
        for source_artifact_id in artifact.get("source_artifact_ids", []):
            if source_artifact_id not in artifact_ids:
                errors.append(
                    f"artifact {artifact.get('artifact_id')} has a missing source artifact"
                )

    known_refs = set(event_by_id) | artifact_ids
    known_refs.update(node.node_id for node in workflow_nodes)
    known_refs.update(goal.goal_id for goal in goals)
    known_refs.update(fault.fault_id if isinstance(fault, FaultSpec) else fault.observation_id for fault in decoded_faults)
    known_refs.update(diagnosis.diagnosis_id for diagnosis in diagnoses)
    known_refs.update(recovery.recovery_id for recovery in recoveries)
    known_refs.update(verification.verification_id for verification in verifications)
    workflow_node_ids = {node.node_id for node in workflow_nodes}
    for node in workflow_nodes:
        for dependency in node.depends_on:
            if dependency not in workflow_node_ids:
                errors.append(f"workflow node {node.node_id} has a missing dependency")
    observation_ids = {
        fault.observation_id
        for fault in decoded_faults
        if isinstance(fault, FaultObservation)
    }
    diagnosis_ids = {diagnosis.diagnosis_id for diagnosis in diagnoses}
    recovery_ids = {recovery.recovery_id for recovery in recoveries}
    for fault in decoded_faults:
        if isinstance(fault, FaultObservation):
            for event_id in fault.symptom_event_ids:
                if event_id not in event_by_id:
                    errors.append(
                        f"fault observation {fault.observation_id} has a missing symptom event"
                    )
    for diagnosis in diagnoses:
        if diagnosis.observation_id not in observation_ids:
            errors.append(f"diagnosis {diagnosis.diagnosis_id} has a missing observation")
        for candidate in diagnosis.candidates:
            for event_id in (
                *candidate.evidence_event_ids,
                *candidate.counter_evidence_event_ids,
            ):
                if event_id not in event_by_id:
                    errors.append(
                        f"diagnosis {diagnosis.diagnosis_id} has a missing evidence event"
                    )
    for recovery in recoveries:
        if recovery.diagnosis_id not in diagnosis_ids:
            errors.append(f"recovery {recovery.recovery_id} has a missing diagnosis")
    for verification in verifications:
        if verification.recovery_id and verification.recovery_id not in recovery_ids:
            errors.append(
                f"verification {verification.verification_id} has a missing recovery"
            )
        for check in verification.checks:
            for reference in check.evidence_refs:
                if reference not in known_refs:
                    errors.append(
                        f"verification {verification.verification_id} has missing evidence"
                    )
    for edge in edges:
        if edge.evidence_event_id and edge.evidence_event_id not in event_by_id:
            errors.append(f"edge {edge.edge_id} has missing evidence event")
        if edge.kind is DependencyKind.CAUSAL:
            for reference in (edge.from_ref, edge.to_ref):
                if reference not in known_refs:
                    errors.append(f"causal edge {edge.edge_id} has unknown reference {reference}")

    runtime_kinds = {
        event.payload.get("runtime_kind")
        for event in events
        if isinstance(event.payload.get("runtime_kind"), str)
    }
    event_kinds = {event.kind.value for event in events}
    for required in sorted(set(required_event_kinds)):
        if required not in event_kinds:
            errors.append(f"required event kind is missing: {required}")
    for required in sorted(set(required_runtime_kinds)):
        if required not in runtime_kinds:
            errors.append(f"required runtime event is missing: {required}")

    started_tools: dict[str, str] = {}
    started_models: set[int] = set()
    completed_models: set[int] = set()
    for event in events:
        runtime_kind = event.payload.get("runtime_kind")
        if runtime_kind == "message_started" and isinstance(event.payload.get("step"), int):
            started_models.add(event.payload["step"])
        elif runtime_kind == "message_finished" and isinstance(event.payload.get("step"), int):
            completed_models.add(event.payload["step"])
        elif runtime_kind == "tool_started" and event.tool_call_id:
            if event.tool_call_id in started_tools:
                errors.append(f"duplicate tool start for {event.tool_call_id}")
            started_tools[event.tool_call_id] = event.event_id
        elif runtime_kind in {"tool_finished", "tool_failed"} and event.tool_call_id:
            if event.tool_call_id not in started_tools:
                errors.append(f"tool terminal event without start for {event.tool_call_id}")
            else:
                started_tools.pop(event.tool_call_id)
    lifecycle_gaps = []
    if started_tools:
        lifecycle_gaps.append(f"unfinished tools: {sorted(started_tools)}")
    unfinished_models = sorted(started_models - completed_models)
    if unfinished_models:
        lifecycle_gaps.append(f"unfinished model steps: {unfinished_models}")
    if strict_lifecycles:
        errors.extend(lifecycle_gaps)
    else:
        warnings.extend(lifecycle_gaps)

    if run.status is RunStatus.SUCCEEDED:
        if not verifications or verifications[-1].decision is not VerificationDecision.ACCEPT:
            errors.append("succeeded run has no accepting verification")
    if run.status is RunStatus.COMPLETED_UNVERIFIED and verifications:
        warnings.append("unverified run contains verification records")

    counts["event_kinds"] = len(event_kinds)
    counts["runtime_event_kinds"] = len(runtime_kinds)
    return TraceVerificationReport(
        run_id,
        tuple(sorted(set(errors))),
        tuple(sorted(set(warnings))),
        counts,
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Verify a durable Nexgent Harness run independently"
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--store", help="Directory containing runs.sqlite3")
    source.add_argument("--jsonl", help="Portable JSONL evidence export")
    parser.add_argument("--run-id", help="Required with --store")
    parser.add_argument("--require-event-kind", action="append", default=[])
    parser.add_argument("--require-runtime-event", action="append", default=[])
    parser.add_argument("--strict-lifecycles", action="store_true")
    parser.add_argument("--allow-corrupt-tail", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    dropped_tail = False
    if args.store:
        if not args.run_id:
            raise SystemExit("--run-id is required with --store")
        store = SQLiteRunStore(Path(args.store))
        bundle = store.export_run(args.run_id)
    else:
        bundle, dropped_tail = load_export_jsonl(
            Path(args.jsonl).read_text(encoding="utf-8"),
            allow_corrupt_tail=args.allow_corrupt_tail,
        )
    report = verify_export(
        bundle,
        required_event_kinds=args.require_event_kind,
        required_runtime_kinds=args.require_runtime_event,
        strict_lifecycles=args.strict_lifecycles,
    )
    if dropped_tail:
        report = TraceVerificationReport(
            report.run_id,
            report.errors,
            tuple(sorted({*report.warnings, "dropped one corrupt JSONL tail record"})),
            report.counts,
        )
    print(json.dumps(report.to_dict(), ensure_ascii=False, sort_keys=True))
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
