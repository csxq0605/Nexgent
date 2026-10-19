"""Structured recording bridge between the Harness and durable run store."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional

from .contracts import (
    ArtifactRecord,
    AttemptStatus,
    AttemptTrigger,
    BudgetPolicy,
    Diagnosis,
    DiagnosisCandidate,
    DependencyEdge,
    DependencyKind,
    EventKind,
    ExecutionEvent,
    ExperimentRun,
    FaultCategory,
    FaultObservation,
    RunAttempt,
    RunMode,
    RunStatus,
    SourceType,
    VerificationDecision,
    VerificationResult,
    new_id,
)
from .store import SQLiteRunStore


@dataclass(frozen=True)
class RunContext:
    run_id: str
    attempt_id: str
    root_span_id: str
    lease_holder: Optional[str] = None


def _digest(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _git_output(project_root: Path, *args: str) -> bytes:
    try:
        completed = subprocess.run(
            ["git", *args],
            cwd=project_root,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
        return completed.stdout
    except (OSError, subprocess.SubprocessError):
        return b""


def capture_source_state(project_root: Path) -> tuple[Optional[str], str]:
    revision = _git_output(project_root, "rev-parse", "HEAD").decode("utf-8", "replace").strip()
    status = _git_output(project_root, "status", "--porcelain=v1", "-z")
    diff = _git_output(project_root, "diff", "--binary", "HEAD")
    dirty_digest = hashlib.sha256(status + b"\0" + diff).hexdigest()
    return revision or None, dirty_digest


def capture_environment_digest() -> str:
    environment = {
        "python": sys.version,
        "implementation": platform.python_implementation(),
        "platform": platform.platform(),
        "executable": sys.executable,
    }
    return _digest(environment)


_RUNTIME_EVENT_MAP = {
    "tool_started": EventKind.TOOL,
    "tool_finished": EventKind.TOOL,
    "tool_failed": EventKind.TOOL,
    "workflow_changed": EventKind.WORKFLOW,
    "goal_changed": EventKind.GOAL,
    "subagent_changed": EventKind.DECISION,
    "permission_requested": EventKind.APPROVAL,
    "permission_resolved": EventKind.APPROVAL,
    "message_started": EventKind.MODEL,
    "message_finished": EventKind.MODEL,
    "warning": EventKind.NOTICE,
    "error": EventKind.NOTICE,
}

_WORKSPACE_WRITE_TOOLS = frozenset({"edit_file", "write_file"})
_SNAPSHOT_SUFFIXES = frozenset(
    {
        ".c",
        ".cc",
        ".cfg",
        ".cpp",
        ".cu",
        ".go",
        ".h",
        ".hpp",
        ".ini",
        ".java",
        ".js",
        ".json",
        ".jsx",
        ".m",
        ".md",
        ".py",
        ".rs",
        ".sh",
        ".toml",
        ".ts",
        ".tsx",
        ".yaml",
        ".yml",
    }
)
_SNAPSHOT_NAMES = frozenset({"Dockerfile", "Makefile"})
_MAX_SNAPSHOT_BYTES = 1_000_000


class RunRecorder:
    """Append-only recorder with explicit context and evidence boundaries."""

    def __init__(self, store: SQLiteRunStore, project_root: os.PathLike[str] | str):
        self.store = store
        self.project_root = Path(project_root).expanduser().resolve()
        self._correlation_lock = threading.RLock()
        self._model_starts: dict[tuple[str, int], ExecutionEvent] = {}
        self._last_model_event: dict[str, ExecutionEvent] = {}
        self._tool_starts: dict[tuple[str, str], ExecutionEvent] = {}
        self._tool_preimages: dict[
            tuple[str, str], tuple[Path, Optional[str], Optional[str]]
        ] = {}
        self._pending_workspace_mutations: dict[str, list[str]] = {}

    def _snapshot_path(self, payload: dict[str, Any]) -> Optional[Path]:
        arguments = payload.get("arguments")
        if not isinstance(arguments, dict):
            return None
        raw_path = arguments.get("path") or arguments.get("file_path")
        if not isinstance(raw_path, str) or not raw_path.strip():
            return None
        candidate = Path(raw_path).expanduser()
        if not candidate.is_absolute():
            candidate = self.project_root / candidate
        try:
            resolved = candidate.resolve(strict=False)
            relative = resolved.relative_to(self.project_root)
        except (OSError, ValueError):
            return None
        if any(part in {".git", ".nexgent"} for part in relative.parts):
            return None
        if resolved.name == ".env" or resolved.name.startswith(".env."):
            return None
        if resolved.suffix.lower() not in _SNAPSHOT_SUFFIXES and resolved.name not in _SNAPSHOT_NAMES:
            return None
        return resolved

    @staticmethod
    def _read_snapshot(path: Path) -> Optional[bytes]:
        try:
            if not path.is_file() or path.stat().st_size > _MAX_SNAPSHOT_BYTES:
                return None
            return path.read_bytes()
        except OSError:
            return None

    def _capture_tool_preimage(
        self,
        context: RunContext,
        event: ExecutionEvent,
    ) -> None:
        if event.payload.get("tool") not in _WORKSPACE_WRITE_TOOLS or not event.tool_call_id:
            return
        path = self._snapshot_path(event.payload)
        if path is None:
            return
        data = self._read_snapshot(path)
        artifact_id = None
        digest = None
        if data is not None:
            artifact = self.record_artifact(
                context,
                data,
                role="workspace_preimage",
                media_type="application/octet-stream",
                producer_event_id=event.event_id,
                metadata={"path": str(path.relative_to(self.project_root))},
            )
            artifact_id = artifact.artifact_id
            digest = artifact.sha256
        self._tool_preimages[(context.run_id, event.tool_call_id)] = (
            path,
            artifact_id,
            digest,
        )

    def _capture_tool_postimage(
        self,
        context: RunContext,
        event: ExecutionEvent,
    ) -> None:
        if not event.tool_call_id:
            return
        state = self._tool_preimages.pop((context.run_id, event.tool_call_id), None)
        if state is None:
            return
        path, preimage_id, before_digest = state
        data = self._read_snapshot(path)
        after_digest = hashlib.sha256(data).hexdigest() if data is not None else None
        if after_digest == before_digest:
            return
        relative_path = str(path.relative_to(self.project_root))
        mutation_event = self.record(
            context,
            EventKind.ARTIFACT,
            SourceType.TOOL,
            "workspace-observer",
            payload={
                "stage": "workspace-change",
                "path": relative_path,
                "before_sha256": before_digest,
                "after_sha256": after_digest,
                "deleted": data is None,
                "tool_call_id": event.tool_call_id,
            },
            causation_event_id=event.event_id,
            tool_call_id=event.tool_call_id,
        )
        self.link(
            context,
            event.event_id,
            mutation_event.event_id,
            DependencyKind.ARTIFACT,
            evidence_event_id=mutation_event.event_id,
        )
        if data is not None:
            artifact = self.record_artifact(
                context,
                data,
                role="workspace_postimage",
                media_type="application/octet-stream",
                producer_event_id=mutation_event.event_id,
                source_artifact_ids=((preimage_id,) if preimage_id else ()),
                metadata={"path": relative_path},
            )
            self.link(
                context,
                mutation_event.event_id,
                artifact.artifact_id,
                DependencyKind.ARTIFACT,
                evidence_event_id=mutation_event.event_id,
            )
        self._pending_workspace_mutations.setdefault(context.run_id, []).append(
            mutation_event.event_id
        )

    def _record_command_process(
        self,
        context: RunContext,
        runtime_kind: str,
        event: ExecutionEvent,
        start: ExecutionEvent,
    ) -> None:
        if start.payload.get("tool") != "run_command":
            return
        arguments = start.payload.get("arguments")
        command = arguments.get("command", "") if isinstance(arguments, dict) else ""
        failed = runtime_kind == "tool_failed"
        process_event = self.record(
            context,
            EventKind.PROCESS,
            SourceType.PROCESS,
            "run_command",
            payload={
                "stage": "command-process",
                "command": command,
                "status": "failed" if failed else "passed",
                "duration_seconds": event.payload.get("duration_seconds"),
                "message": event.payload.get("message", ""),
                "tool_call_id": event.tool_call_id,
            },
            causation_event_id=event.event_id,
            tool_call_id=event.tool_call_id,
        )
        self.link(
            context,
            event.event_id,
            process_event.event_id,
            DependencyKind.CAUSAL,
            evidence_event_id=process_event.event_id,
        )
        mutations = self._pending_workspace_mutations.pop(context.run_id, [])
        for mutation_event_id in mutations:
            self.link(
                context,
                mutation_event_id,
                process_event.event_id,
                DependencyKind.DATA,
                evidence_event_id=process_event.event_id,
                inferred=True,
                metadata={"reason": "workspace change preceded command validation"},
            )
        if failed:
            self._record_command_diagnosis(context, process_event, mutations)

    def _record_command_diagnosis(
        self,
        context: RunContext,
        process_event: ExecutionEvent,
        mutations: list[str],
    ) -> None:
        signal = str(process_event.payload.get("message") or "command failed")
        category = (
            FaultCategory.TIMEOUT
            if "timeout" in signal.lower()
            else FaultCategory.CODE if mutations else FaultCategory.TOOL
        )
        observation = FaultObservation(
            observation_id=new_id("observation"),
            run_id=context.run_id,
            category=category,
            signal=signal,
            severity="high",
            symptom_event_ids=(process_event.event_id,),
            detector="command-exit-detector",
        )
        self.store.record_fault(observation)
        fault_event = self.record(
            context,
            EventKind.FAULT,
            SourceType.RUNTIME,
            "command-exit-detector",
            payload={
                "stage": "detect",
                "observation_id": observation.observation_id,
                "category": category.value,
                "signal": signal,
            },
            causation_event_id=process_event.event_id,
        )
        self.link(
            context,
            process_event.event_id,
            fault_event.event_id,
            DependencyKind.CAUSAL,
            evidence_event_id=fault_event.event_id,
        )
        suspect_refs = list(reversed(mutations)) or [process_event.event_id]
        candidates = tuple(
            DiagnosisCandidate(
                suspect_ref=suspect_ref,
                score=max(0.1, 1.0 - (index * 0.1)) if mutations else 0.25,
                evidence_event_ids=(suspect_ref, process_event.event_id),
                causal_path=(suspect_ref, process_event.event_id),
                rationale=(
                    "workspace mutation precedes and feeds the failed command"
                    if mutations
                    else "no recorded workspace mutation explains the command failure"
                ),
            )
            for index, suspect_ref in enumerate(suspect_refs)
        )
        diagnosis = Diagnosis(
            diagnosis_id=new_id("diagnosis"),
            run_id=context.run_id,
            observation_id=observation.observation_id,
            candidates=candidates,
            next_check=(
                "inspect the ranked workspace changes, rerun the smallest failing "
                "test, then execute the complete acceptance suite"
            ),
            method="workspace-command-dependency",
        )
        self.store.record_diagnosis(diagnosis)
        diagnosis_event = self.record(
            context,
            EventKind.DIAGNOSIS,
            SourceType.RUNTIME,
            "workspace-command-attributor",
            payload={
                "stage": "diagnose",
                "diagnosis_id": diagnosis.diagnosis_id,
                "candidate_refs": list(suspect_refs),
                "next_check": diagnosis.next_check,
            },
            causation_event_id=fault_event.event_id,
        )
        self.link(
            context,
            fault_event.event_id,
            diagnosis_event.event_id,
            DependencyKind.CAUSAL,
            evidence_event_id=diagnosis_event.event_id,
        )

    def start_run(
        self,
        objective: str,
        *,
        mode: RunMode = RunMode.INTERACTIVE,
        session_id: Optional[str] = None,
        model_profile: Optional[str] = None,
        prompt_digest: Optional[str] = None,
        tool_catalog: Optional[Iterable[dict[str, Any]]] = None,
        seed: Optional[int] = None,
        parent_run_id: Optional[str] = None,
        branch_from_event_id: Optional[str] = None,
        goal_id: Optional[str] = None,
        budget: Optional[BudgetPolicy] = None,
    ) -> RunContext:
        revision, dirty_digest = capture_source_state(self.project_root)
        run = ExperimentRun(
            run_id=new_id("run"),
            objective=objective,
            project_root=str(self.project_root),
            session_id=session_id,
            goal_id=goal_id,
            parent_run_id=parent_run_id,
            branch_from_event_id=branch_from_event_id,
            mode=mode,
            code_revision=revision,
            dirty_tree_digest=dirty_digest,
            environment_digest=capture_environment_digest(),
            model_profile=model_profile,
            prompt_digest=prompt_digest,
            tool_catalog_digest=_digest(list(tool_catalog or ())),
            seed=seed,
            budget=budget or BudgetPolicy(),
        )
        self.store.create_run(run)
        self.store.transition_run(run.run_id, RunStatus.CREATED, RunStatus.RUNNING)
        attempt = RunAttempt(
            attempt_id=new_id("attempt"),
            run_id=run.run_id,
            trigger=AttemptTrigger.INITIAL,
            status=AttemptStatus.RUNNING,
        )
        self.store.begin_attempt(attempt)
        context = RunContext(
            run_id=run.run_id,
            attempt_id=attempt.attempt_id,
            root_span_id=new_id("span"),
        )
        self.record(
            context,
            EventKind.RUN,
            SourceType.RUNTIME,
            "runtime",
            payload={"phase": "started", "mode": mode.value},
            span_id=context.root_span_id,
        )
        return context

    def next_attempt(
        self,
        context: RunContext,
        *,
        trigger: AttemptTrigger = AttemptTrigger.RECOVERY,
        termination_reason: str = "verification_rejected",
    ) -> RunContext:
        """Close the current logical attempt and begin a correlated rerun.

        This is intentionally separate from :meth:`resume_run`: a live recovery
        rerun is not a process-resume and must never be labelled as one.
        """

        events = self.store.list_events(context.run_id)
        previous_event_id = events[-1].event_id if events else None
        self.store.update_attempt_status(
            context.attempt_id,
            AttemptStatus.RUNNING,
            AttemptStatus.FAILED,
            termination_reason=termination_reason,
        )
        attempt = RunAttempt(
            attempt_id=new_id("attempt"),
            run_id=context.run_id,
            trigger=trigger,
            status=AttemptStatus.RUNNING,
            parent_attempt_id=context.attempt_id,
        )
        self.store.begin_attempt(attempt)
        next_context = RunContext(
            run_id=context.run_id,
            attempt_id=attempt.attempt_id,
            root_span_id=context.root_span_id,
            lease_holder=context.lease_holder,
        )
        event = self.record(
            next_context,
            EventKind.ATTEMPT,
            SourceType.RUNTIME,
            "goal-controller",
            payload={
                "phase": "rerun",
                "trigger": trigger.value,
                "previous_attempt_id": context.attempt_id,
            },
            causation_event_id=previous_event_id,
        )
        if previous_event_id is not None:
            self.link(
                next_context,
                previous_event_id,
                event.event_id,
                DependencyKind.RECOVERY,
                evidence_event_id=event.event_id,
                metadata={"trigger": trigger.value},
            )
        return next_context

    def resume_run(
        self,
        run_id: str,
        *,
        lease_holder: Optional[str] = None,
        lease_ttl_seconds: float = 30.0,
    ) -> RunContext:
        """Continue a paused or interrupted run from a fresh recorder instance."""

        holder = lease_holder or new_id("runtime")
        self.store.acquire_lease(run_id, holder, ttl_seconds=lease_ttl_seconds)
        try:
            run = self.store.get_run(run_id)
            if run.status not in {
                RunStatus.RUNNING,
                RunStatus.PAUSED,
                RunStatus.WAITING_APPROVAL,
            }:
                raise ValueError(
                    f"run {run_id} cannot resume from status {run.status.value}"
                )
            if run.current_attempt >= run.budget.max_attempts:
                raise ValueError(f"run {run_id} attempt budget is exhausted")
            if run.status in {RunStatus.PAUSED, RunStatus.WAITING_APPROVAL}:
                self.store.transition_run(run_id, run.status, RunStatus.RUNNING)

            attempts = self.store.list_attempts(run_id)
            previous_attempt = attempts[-1] if attempts else None
            for attempt in reversed(attempts):
                if attempt.status is AttemptStatus.RUNNING:
                    self.store.update_attempt_status(
                        attempt.attempt_id,
                        AttemptStatus.RUNNING,
                        AttemptStatus.ABORTED,
                        termination_reason="interrupted_before_resume",
                    )
                    previous_attempt = attempt
                    break

            resumed_attempt = RunAttempt(
                attempt_id=new_id("attempt"),
                run_id=run_id,
                trigger=AttemptTrigger.RESUME,
                status=AttemptStatus.RUNNING,
                parent_attempt_id=(
                    previous_attempt.attempt_id if previous_attempt is not None else None
                ),
            )
            self.store.begin_attempt(resumed_attempt)
            events = self.store.list_events(run_id)
            root_span_id = next(
                (event.span_id for event in events if event.span_id),
                new_id("span"),
            )
            context = RunContext(
                run_id=run_id,
                attempt_id=resumed_attempt.attempt_id,
                root_span_id=root_span_id,
                lease_holder=holder,
            )
            self._rebuild_correlation(context, events)
            resume_event = self.record(
                context,
                EventKind.ATTEMPT,
                SourceType.RUNTIME,
                "runtime",
                payload={
                    "phase": "resumed",
                    "previous_attempt_id": (
                        previous_attempt.attempt_id
                        if previous_attempt is not None
                        else None
                    ),
                },
                span_id=new_id("span"),
                causation_event_id=(events[-1].event_id if events else None),
            )
            if events:
                self.link(
                    context,
                    events[-1].event_id,
                    resume_event.event_id,
                    DependencyKind.RETRY,
                    evidence_event_id=resume_event.event_id,
                    metadata={"trigger": AttemptTrigger.RESUME.value},
                )
            return context
        except Exception:
            self.store.release_lease(run_id, holder)
            raise

    def _rebuild_correlation(
        self,
        context: RunContext,
        events: Iterable[ExecutionEvent],
    ) -> None:
        """Reconstruct open spans/tool calls without replaying any side effect."""

        with self._correlation_lock:
            for event in events:
                runtime_kind = event.payload.get("runtime_kind")
                step = event.payload.get("step")
                if runtime_kind == "message_started" and isinstance(step, int):
                    self._model_starts[(context.run_id, step)] = event
                elif runtime_kind == "message_finished":
                    self._last_model_event[context.run_id] = event
                    if isinstance(step, int):
                        self._model_starts.pop((context.run_id, step), None)
                elif runtime_kind == "tool_started" and event.tool_call_id:
                    self._tool_starts[(context.run_id, event.tool_call_id)] = event
                elif runtime_kind in {"tool_finished", "tool_failed"} and event.tool_call_id:
                    self._tool_starts.pop((context.run_id, event.tool_call_id), None)

    def _release_lease(self, context: RunContext) -> None:
        if context.lease_holder is not None:
            self.store.release_lease(context.run_id, context.lease_holder)

    def record(
        self,
        context: RunContext,
        kind: EventKind,
        source_type: SourceType,
        source_id: str,
        *,
        payload: Optional[dict[str, Any]] = None,
        span_id: Optional[str] = None,
        parent_span_id: Optional[str] = None,
        causation_event_id: Optional[str] = None,
        workflow_node_id: Optional[str] = None,
        tool_call_id: Optional[str] = None,
    ) -> ExecutionEvent:
        return self.store.append_event(
            ExecutionEvent(
                event_id=new_id("event"),
                run_id=context.run_id,
                attempt_id=context.attempt_id,
                kind=kind,
                source_type=source_type,
                source_id=source_id,
                span_id=span_id or new_id("span"),
                parent_span_id=parent_span_id or context.root_span_id,
                causation_event_id=causation_event_id,
                workflow_node_id=workflow_node_id,
                tool_call_id=tool_call_id,
                payload=dict(payload or {}),
            )
        )

    def record_runtime_event(
        self,
        context: RunContext,
        runtime_kind: str,
        payload: dict[str, Any],
        *,
        source_id: str = "main",
        source_type: Optional[SourceType] = None,
    ) -> ExecutionEvent:
        event_kind = _RUNTIME_EVENT_MAP.get(runtime_kind, EventKind.NOTICE)
        resolved_source_type = source_type or (
            SourceType.TOOL if runtime_kind.startswith("tool_") else SourceType.AGENT
        )
        step = payload.get("step")
        tool_call_id = payload.get("tool_call_id")

        with self._correlation_lock:
            span_id = None
            parent_span_id = None
            causation_event_id = None

            if runtime_kind == "message_finished" and isinstance(step, int):
                start = self._model_starts.get((context.run_id, step))
                if start is not None:
                    span_id = start.span_id
                    parent_span_id = start.parent_span_id
                    causation_event_id = start.event_id
            elif runtime_kind == "tool_started":
                model_event = self._last_model_event.get(context.run_id)
                if model_event is not None:
                    parent_span_id = model_event.span_id
                    causation_event_id = model_event.event_id
            elif runtime_kind in {"tool_finished", "tool_failed"} and tool_call_id:
                start = self._tool_starts.get((context.run_id, str(tool_call_id)))
                if start is not None:
                    span_id = start.span_id
                    parent_span_id = start.parent_span_id
                    causation_event_id = start.event_id

            event = self.record(
                context,
                event_kind,
                resolved_source_type,
                source_id,
                payload={"runtime_kind": runtime_kind, **payload},
                span_id=span_id,
                parent_span_id=parent_span_id,
                causation_event_id=causation_event_id,
                tool_call_id=tool_call_id,
            )
            if causation_event_id is not None:
                self.link(
                    context,
                    causation_event_id,
                    event.event_id,
                    DependencyKind.CAUSAL,
                    evidence_event_id=event.event_id,
                    metadata={"runtime_kind": runtime_kind},
                )

            if runtime_kind == "message_started" and isinstance(step, int):
                self._model_starts[(context.run_id, step)] = event
            elif runtime_kind == "message_finished":
                self._last_model_event[context.run_id] = event
                if isinstance(step, int):
                    self._model_starts.pop((context.run_id, step), None)
            elif runtime_kind == "tool_started" and tool_call_id:
                self._tool_starts[(context.run_id, str(tool_call_id))] = event
                self._capture_tool_preimage(context, event)
            elif runtime_kind in {"tool_finished", "tool_failed"} and tool_call_id:
                start = self._tool_starts.get((context.run_id, str(tool_call_id)))
                if start is not None:
                    self._capture_tool_postimage(context, event)
                    self._record_command_process(context, runtime_kind, event, start)
                self._tool_starts.pop((context.run_id, str(tool_call_id)), None)
            return event

    def _release_context(self, context: RunContext) -> None:
        with self._correlation_lock:
            self._last_model_event.pop(context.run_id, None)
            for key in list(self._model_starts):
                if key[0] == context.run_id:
                    self._model_starts.pop(key, None)
            for key in list(self._tool_starts):
                if key[0] == context.run_id:
                    self._tool_starts.pop(key, None)
            for key in list(self._tool_preimages):
                if key[0] == context.run_id:
                    self._tool_preimages.pop(key, None)
            self._pending_workspace_mutations.pop(context.run_id, None)

    def link(
        self,
        context: RunContext,
        from_ref: str,
        to_ref: str,
        kind: DependencyKind,
        *,
        evidence_event_id: Optional[str] = None,
        confidence: float = 1.0,
        inferred: bool = False,
        metadata: Optional[dict[str, Any]] = None,
    ) -> DependencyEdge:
        return self.store.link_dependency(
            DependencyEdge(
                edge_id=new_id("edge"),
                run_id=context.run_id,
                from_ref=from_ref,
                to_ref=to_ref,
                kind=kind,
                evidence_event_id=evidence_event_id,
                confidence=confidence,
                inferred=inferred,
                metadata=dict(metadata or {}),
            )
        )

    def record_artifact(
        self,
        context: RunContext,
        data: bytes,
        *,
        role: str,
        media_type: str = "application/octet-stream",
        producer_event_id: Optional[str] = None,
        source_artifact_ids: Iterable[str] = (),
        metadata: Optional[dict[str, Any]] = None,
    ) -> ArtifactRecord:
        return self.store.put_artifact(
            context.run_id,
            data,
            role=role,
            media_type=media_type,
            producer_event_id=producer_event_id,
            source_artifact_ids=source_artifact_ids,
            metadata=metadata,
        )

    def finish_unverified(self, context: RunContext, result: str) -> ExperimentRun:
        self.record(
            context,
            EventKind.RUN,
            SourceType.RUNTIME,
            "runtime",
            payload={"phase": "completed", "verified": False, "result_length": len(result)},
            span_id=context.root_span_id,
        )
        self.store.update_attempt_status(
            context.attempt_id,
            AttemptStatus.RUNNING,
            AttemptStatus.SUCCEEDED,
            termination_reason="agent_completed_unverified",
        )
        completed = self.store.transition_run(
            context.run_id,
            RunStatus.RUNNING,
            RunStatus.COMPLETED_UNVERIFIED,
            termination_reason="agent_completed_unverified",
        )
        self._release_context(context)
        self._release_lease(context)
        return completed

    def finish_verified(
        self,
        context: RunContext,
        verification: VerificationResult,
    ) -> ExperimentRun:
        if verification.run_id != context.run_id:
            raise ValueError("verification belongs to a different run")
        self.store.transition_run(context.run_id, RunStatus.RUNNING, RunStatus.VERIFYING)
        self.store.record_verification(verification)
        self.record(
            context,
            EventKind.VERIFICATION,
            SourceType.VALIDATOR,
            "validator-registry",
            payload={
                "verification_id": verification.verification_id,
                "decision": verification.decision.value,
            },
        )
        if verification.decision is VerificationDecision.ACCEPT:
            attempt_status = AttemptStatus.SUCCEEDED
            run_status = RunStatus.SUCCEEDED
        else:
            attempt_status = AttemptStatus.FAILED
            run_status = RunStatus.FAILED
        self.store.update_attempt_status(
            context.attempt_id,
            AttemptStatus.RUNNING,
            attempt_status,
            termination_reason=f"verification_{verification.decision.value}",
        )
        completed = self.store.transition_run(
            context.run_id,
            RunStatus.VERIFYING,
            run_status,
            termination_reason=f"verification_{verification.decision.value}",
        )
        self._release_context(context)
        self._release_lease(context)
        return completed

    def pause(
        self,
        context: RunContext,
        reason: str,
        *,
        waiting_approval: bool = False,
    ) -> ExperimentRun:
        """Persist a controller stop that remains resumable and non-successful."""

        target = (
            RunStatus.WAITING_APPROVAL
            if waiting_approval
            else RunStatus.PAUSED
        )
        self.record(
            context,
            EventKind.RUN,
            SourceType.RUNTIME,
            "goal-controller",
            payload={"phase": target.value, "reason": reason},
            span_id=context.root_span_id,
        )
        self.store.update_attempt_status(
            context.attempt_id,
            AttemptStatus.RUNNING,
            AttemptStatus.PAUSED,
            termination_reason=reason,
        )
        paused = self.store.transition_run(
            context.run_id,
            RunStatus.RUNNING,
            target,
            termination_reason=reason,
        )
        self._release_context(context)
        self._release_lease(context)
        return paused

    def fail(self, context: RunContext, error: BaseException) -> ExperimentRun:
        self.record(
            context,
            EventKind.RUN,
            SourceType.RUNTIME,
            "runtime",
            payload={
                "phase": "failed",
                "exception": type(error).__name__,
                "message": str(error),
            },
            span_id=context.root_span_id,
        )
        self.store.update_attempt_status(
            context.attempt_id,
            AttemptStatus.RUNNING,
            AttemptStatus.FAILED,
            termination_reason=type(error).__name__,
        )
        failed = self.store.transition_run(
            context.run_id,
            RunStatus.RUNNING,
            RunStatus.FAILED,
            termination_reason=type(error).__name__,
        )
        self._release_context(context)
        self._release_lease(context)
        return failed
