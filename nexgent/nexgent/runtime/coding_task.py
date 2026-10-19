"""Provider-backed, independently checked loop for real coding tasks."""

from __future__ import annotations

import asyncio
import hashlib
import os
import shlex
import subprocess
import sys
import tempfile
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable, Optional

from .contracts import (
    AcceptanceCriterion,
    AttemptTrigger,
    BudgetPolicy,
    DependencyKind,
    Diagnosis,
    DiagnosisCandidate,
    EventKind,
    FaultCategory,
    FaultObservation,
    GoalSpec,
    RecoveryAction,
    RecoveryKind,
    RunMode,
    RunStatus,
    SourceType,
    VerificationCheck,
    VerificationStatus,
    new_id,
)
from .controller import (
    ControllerContext,
    ExecutionOutcome,
    GoalController,
    GoalControllerResult,
    ValidatorRegistry,
)
from .recorder import RunContext, RunRecorder
from .store import SQLiteRunStore
from ..tools.shell import _scrub_env
from .strategy import build_strategy_signature


_SOURCE_SUFFIXES = {
    ".c", ".cc", ".cfg", ".cpp", ".cu", ".go", ".h", ".hpp", ".ini",
    ".java", ".js", ".json", ".jsx", ".m", ".md", ".py", ".rs", ".sh",
    ".toml", ".ts", ".tsx", ".yaml", ".yml",
}
_SOURCE_NAMES = {"Dockerfile", "Makefile"}
_IGNORED_PARTS = {".git", ".nexgent", ".venv", "__pycache__", "node_modules"}


@dataclass(frozen=True)
class CodingTaskSummary:
    run_id: str
    status: RunStatus
    attempts: int
    recoveries: int
    changed_files: tuple[str, ...]
    verification_id: Optional[str]
    strategy_reused: bool
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "status": self.status.value,
            "attempts": self.attempts,
            "recoveries": self.recoveries,
            "changed_files": list(self.changed_files),
            "verification_id": self.verification_id,
            "strategy_reused": self.strategy_reused,
            "reason": self.reason,
        }


class CodingTaskLoop:
    """Run an Agent task until an explicit command accepts it or budget expires."""

    def __init__(
        self,
        recorder: RunRecorder,
        task: str,
        check_command: str,
        agent_executor: Callable[[str], str],
        *,
        max_attempts: int = 3,
        check_timeout: float = 120.0,
        progress_callback: Optional[Callable[[dict[str, Any]], None]] = None,
        context_callback: Optional[Callable[[Optional[RunContext]], None]] = None,
        resume_run_id: Optional[str] = None,
    ) -> None:
        if not task.strip():
            raise ValueError("coding task is required")
        if not check_command.strip():
            raise ValueError("acceptance command is required")
        if max_attempts < 1:
            raise ValueError("max_attempts must be positive")
        if check_timeout <= 0:
            raise ValueError("check_timeout must be positive")
        self.recorder = recorder
        self.store = recorder.store
        self.project_root = recorder.project_root
        self.task = task.strip()
        self.check_command = check_command.strip()
        self.agent_executor = agent_executor
        self.max_attempts = max_attempts
        self.check_timeout = check_timeout
        self.progress_callback = progress_callback
        self.context_callback = context_callback
        self.resume_run_id = resume_run_id
        self.context: Optional[RunContext] = None
        self.next_prompt = self.task
        self.last_validator_event_id: Optional[str] = None
        self.last_process_event_id: Optional[str] = None
        self.last_diagnosis: Optional[Diagnosis] = None
        self.last_observation: Optional[FaultObservation] = None
        self.last_recovery: Optional[RecoveryAction] = None
        self.last_check_output = ""
        self.changed_files: set[str] = set()
        self.strategy_reused = False
        self.selected_strategy_id: Optional[str] = None
        self._resumed_context_pending = False

    def _publish(self, stage: str, **payload: Any) -> None:
        if self.progress_callback and self.context:
            self.progress_callback(
                {"run_id": self.context.run_id, "stage": stage, **payload}
            )

    def _set_context(self, context: Optional[RunContext]) -> None:
        self.context = context
        if self.context_callback:
            self.context_callback(context)

    def _goal(self) -> GoalSpec:
        return GoalSpec(
            goal_id=new_id("goal"),
            objective=self.task,
            criteria=(
                AcceptanceCriterion(
                    criterion_id="user-acceptance-command",
                    kind="command",
                    description=f"{self.check_command!r} exits with code zero",
                    validator="coding-task-command-validator",
                ),
            ),
            required_evidence=("workspace_postimage", "acceptance_output"),
            allowed_recovery_kinds=(
                RecoveryKind.PATCH,
                RecoveryKind.RETRY,
                RecoveryKind.ROLLBACK,
                RecoveryKind.ESCALATE,
            ),
            budget=BudgetPolicy(
                max_turns=self.max_attempts,
                max_attempts=self.max_attempts,
                max_recoveries_per_fault=max(1, self.max_attempts - 1),
                max_duration_seconds=(self.check_timeout + 300.0) * self.max_attempts,
            ),
        )

    def _workspace_snapshot(self) -> dict[str, bytes]:
        snapshot: dict[str, bytes] = {}
        captured = 0
        for directory, names, files in os.walk(self.project_root, followlinks=False):
            names[:] = sorted(name for name in names if name not in _IGNORED_PARTS)
            for name in sorted(files):
                if captured >= 10_000:
                    return snapshot
                path = Path(directory) / name
                try:
                    relative = path.relative_to(self.project_root)
                    if name == ".env" or name.startswith(".env."):
                        continue
                    if path.suffix.lower() not in _SOURCE_SUFFIXES and name not in _SOURCE_NAMES:
                        continue
                    if not path.is_file() or path.stat().st_size > 1_000_000:
                        continue
                    snapshot[str(relative)] = path.read_bytes()
                    captured += 1
                except OSError:
                    continue
        return snapshot

    def _record_changes(
        self,
        before: dict[str, bytes],
        after: dict[str, bytes],
        attempt_number: int,
    ) -> list[str]:
        assert self.context is not None
        event_ids = []
        for path in sorted(set(before) | set(after)):
            if before.get(path) == after.get(path):
                continue
            self.changed_files.add(path)
            before_digest = (
                hashlib.sha256(before[path]).hexdigest() if path in before else None
            )
            after_digest = (
                hashlib.sha256(after[path]).hexdigest() if path in after else None
            )
            event = self.recorder.record(
                self.context,
                EventKind.ARTIFACT,
                SourceType.RUNTIME,
                "coding-task-workspace-observer",
                payload={
                    "stage": "workspace-change",
                    "path": path,
                    "before_sha256": before_digest,
                    "after_sha256": after_digest,
                    "deleted": path not in after,
                    "attempt": attempt_number,
                },
            )
            preimage_id = None
            if path in before:
                preimage = self.recorder.record_artifact(
                    self.context,
                    before[path],
                    role="workspace_preimage",
                    producer_event_id=event.event_id,
                    metadata={"path": path, "attempt": attempt_number},
                )
                preimage_id = preimage.artifact_id
            if path in after:
                postimage = self.recorder.record_artifact(
                    self.context,
                    after[path],
                    role="workspace_postimage",
                    producer_event_id=event.event_id,
                    source_artifact_ids=((preimage_id,) if preimage_id else ()),
                    metadata={"path": path, "attempt": attempt_number},
                )
                self.recorder.link(
                    self.context,
                    event.event_id,
                    postimage.artifact_id,
                    DependencyKind.ARTIFACT,
                    evidence_event_id=event.event_id,
                )
            event_ids.append(event.event_id)
            self._publish("workspace-change", path=path, attempt=attempt_number)
        return event_ids

    def _command_argv(self) -> list[str]:
        argv = shlex.split(self.check_command)
        if not argv:
            raise ValueError("acceptance command is empty")
        if argv[0] in {"python", "python3"}:
            argv[0] = sys.executable
        return argv

    def _strategy_signature(self) -> str:
        path = ""
        if self.last_diagnosis:
            candidate = self.last_diagnosis.candidates[0].suspect_ref
            event = next(
                (
                    item for item in self.store.list_events(self.context.run_id)
                    if item.event_id == candidate
                ),
                None,
            )
            if event:
                path = str(event.payload.get("path") or "")
        category = (
            self.last_observation.category
            if self.last_observation
            else FaultCategory.UNKNOWN
        )
        signal = (
            self.last_observation.signal
            if self.last_observation
            else self.last_check_output
        )
        return build_strategy_signature(
            category=category,
            signal=signal,
            target_path=path,
            validator=self.check_command,
        )

    def _execute(self, controller_context: ControllerContext) -> ExecutionOutcome:
        assert self.context is not None
        if self._resumed_context_pending:
            self._resumed_context_pending = False
        elif controller_context.attempt_number > 1:
            self._set_context(
                self.recorder.next_attempt(
                    self.context,
                    trigger=AttemptTrigger.RECOVERY,
                )
            )
        before = self._workspace_snapshot()
        agent_result = self.agent_executor(self.next_prompt) or ""
        after = self._workspace_snapshot()
        mutation_ids = self._record_changes(
            before, after, controller_context.attempt_number
        )
        timed_out = False
        try:
            with tempfile.TemporaryDirectory(prefix="nexgent-check-pycache-") as cache:
                environment = _scrub_env()
                environment["PYTHONPYCACHEPREFIX"] = cache
                completed = subprocess.run(
                    self._command_argv(),
                    cwd=self.project_root,
                    env=environment,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=self.check_timeout,
                    check=False,
                )
            exit_code = completed.returncode
            output = (completed.stdout + completed.stderr).decode("utf-8", "replace")
        except subprocess.TimeoutExpired as exc:
            timed_out = True
            exit_code = None
            stdout = exc.stdout if isinstance(exc.stdout, bytes) else b""
            stderr = exc.stderr if isinstance(exc.stderr, bytes) else b""
            output = (stdout + stderr).decode("utf-8", "replace")
            output += f"\nTIMEOUT after {self.check_timeout:.1f} seconds"
        self.last_check_output = output[-8000:]
        process_event = self.recorder.record(
            self.context,
            EventKind.PROCESS,
            SourceType.PROCESS,
            "coding-task-acceptance-command",
            payload={
                "stage": "acceptance-command",
                "command": self.check_command,
                "status": "passed" if exit_code == 0 and not timed_out else "failed",
                "exit_code": exit_code,
                "timed_out": timed_out,
                "output": self.last_check_output,
                "attempt": controller_context.attempt_number,
            },
        )
        for mutation_id in mutation_ids:
            self.recorder.link(
                self.context,
                mutation_id,
                process_event.event_id,
                DependencyKind.DATA,
                evidence_event_id=process_event.event_id,
            )
        artifact = self.recorder.record_artifact(
            self.context,
            output.encode("utf-8"),
            role="acceptance_output",
            media_type="text/plain",
            producer_event_id=process_event.event_id,
            metadata={"attempt": controller_context.attempt_number},
        )
        self.last_process_event_id = process_event.event_id
        passed = exit_code == 0 and not timed_out
        self._publish(
            "acceptance-command",
            status="passed" if passed else "failed",
            attempt=controller_context.attempt_number,
        )
        return ExecutionOutcome(
            value={
                "ok": passed,
                "agent_result": agent_result,
                "process_event_id": process_event.event_id,
                "output_artifact_id": artifact.artifact_id,
            },
            error=None if passed else self.last_check_output,
        )

    def _validator(
        self,
        controller_context: ControllerContext,
        criterion: AcceptanceCriterion,
        outcome: ExecutionOutcome,
    ) -> VerificationCheck:
        assert self.context is not None
        value = outcome.value if isinstance(outcome.value, dict) else {}
        passed = bool(value.get("ok")) and outcome.error is None
        event = self.recorder.record(
            self.context,
            EventKind.VERIFICATION,
            SourceType.VALIDATOR,
            "coding-task-command-validator",
            payload={
                "stage": "verify",
                "status": "passed" if passed else "failed",
                "attempt": controller_context.attempt_number,
            },
        )
        process_event_id = value.get("process_event_id")
        if isinstance(process_event_id, str):
            self.recorder.link(
                self.context,
                process_event_id,
                event.event_id,
                DependencyKind.VERIFICATION,
                evidence_event_id=event.event_id,
            )
        self.last_validator_event_id = event.event_id
        return VerificationCheck(
            check_id=f"coding-task-check-{controller_context.attempt_number}",
            kind="command",
            validator="coding-task-command-validator",
            status=VerificationStatus.PASS if passed else VerificationStatus.FAIL,
            expected={"exit_code": 0},
            observed={"passed": passed},
            evidence_refs=tuple(
                ref
                for ref in (value.get("output_artifact_id"), event.event_id)
                if isinstance(ref, str)
            ),
            message="acceptance command passed" if passed else "acceptance command failed",
        )

    def _detector(self, _context, outcome, verification) -> FaultObservation:
        assert self.context is not None and self.last_validator_event_id is not None
        self.store.record_verification(verification)
        observation = FaultObservation(
            observation_id=new_id("observation"),
            run_id=self.context.run_id,
            category=(
                FaultCategory.TIMEOUT
                if "TIMEOUT" in self.last_check_output
                else FaultCategory.CODE
            ),
            signal=str(outcome.error or "acceptance command failed"),
            severity="high",
            symptom_event_ids=(self.last_validator_event_id,),
            detector="coding-task-command-detector",
        )
        self.store.record_fault(observation)
        self.last_observation = observation
        event = self.recorder.record(
            self.context,
            EventKind.FAULT,
            SourceType.RUNTIME,
            "coding-task-command-detector",
            payload={
                "stage": "detect",
                "observation_id": observation.observation_id,
                "category": observation.category.value,
            },
        )
        self.recorder.link(
            self.context,
            self.last_validator_event_id,
            event.event_id,
            DependencyKind.CAUSAL,
            evidence_event_id=event.event_id,
        )
        self._publish("detect", signal=observation.signal[-500:])
        return observation

    def _attributor(self, _context, observation: FaultObservation) -> Diagnosis:
        assert self.context is not None
        events = {
            event.event_id: event for event in self.store.list_events(self.context.run_id)
        }
        paths = self.store.list_ancestor_paths(
            self.context.run_id, observation.symptom_event_ids[0]
        )
        suspects: list[tuple[str, tuple[str, ...]]] = []
        for path in paths:
            for event_id in reversed(path):
                event = events.get(event_id)
                if event and event.payload.get("stage") == "workspace-change":
                    suspects.append((event_id, tuple(path)))
                    break
        if not suspects:
            suspects = [(observation.symptom_event_ids[0], observation.symptom_event_ids)]
        unique = []
        seen = set()
        for suspect in reversed(suspects):
            if suspect[0] not in seen:
                unique.append(suspect)
                seen.add(suspect[0])
        candidates = tuple(
            DiagnosisCandidate(
                suspect_ref=suspect_ref,
                score=max(0.1, 1.0 - index * 0.1),
                evidence_event_ids=(suspect_ref, observation.symptom_event_ids[0]),
                causal_path=path,
                rationale="changed file is an upstream dependency of the failed acceptance command",
            )
            for index, (suspect_ref, path) in enumerate(unique)
        )
        diagnosis = Diagnosis(
            diagnosis_id=new_id("diagnosis"),
            run_id=self.context.run_id,
            observation_id=observation.observation_id,
            candidates=candidates,
            next_check=f"repair the ranked changes and rerun {self.check_command!r}",
            method="coding-task-dependency-graph",
        )
        self.store.record_diagnosis(diagnosis)
        event = self.recorder.record(
            self.context,
            EventKind.DIAGNOSIS,
            SourceType.RUNTIME,
            "coding-task-dependency-attributor",
            payload={
                "stage": "diagnose",
                "diagnosis_id": diagnosis.diagnosis_id,
                "candidate_refs": [item.suspect_ref for item in candidates],
                "next_check": diagnosis.next_check,
            },
        )
        self.last_diagnosis = diagnosis
        self._publish("diagnose", suspect_ref=candidates[0].suspect_ref)
        return diagnosis

    def propose(self, _context, diagnosis: Diagnosis) -> RecoveryAction:
        assert self.context is not None
        signature = self._strategy_signature()
        strategy = self.store.select_recovery_strategy(signature)
        # These fields summarize the whole Run.  A later recovery proposal may
        # have a different signature; it must not erase an earlier, real reuse
        # or prevent that reused strategy from being down-ranked if the Run
        # eventually fails.
        if strategy is not None:
            self.strategy_reused = True
            self.selected_strategy_id = strategy.strategy_id
        action = RecoveryAction(
            recovery_id=new_id("recovery"),
            run_id=self.context.run_id,
            diagnosis_id=diagnosis.diagnosis_id,
            kind=strategy.recovery_kind if strategy else RecoveryKind.PATCH,
            target_ref=diagnosis.candidates[0].suspect_ref,
            parameters={
                "strategy_id": strategy.strategy_id if strategy else None,
                "next_check": diagnosis.next_check,
            },
            expected_effects=("agent repairs ranked candidate and acceptance command passes",),
            risk="permission-gated",
            requires_approval=False,
            idempotency_key=f"{self.context.run_id}:{diagnosis.diagnosis_id}:repair",
        )
        self.store.record_recovery(action)
        self.last_recovery = action
        return action

    def apply(self, _context, action: RecoveryAction) -> None:
        assert self.context is not None and self.last_diagnosis is not None
        event = next(
            (
                item
                for item in self.store.list_events(self.context.run_id)
                if item.event_id == action.target_ref
            ),
            None,
        )
        path = event.payload.get("path") if event else None
        self.next_prompt = (
            f"Continue the original task: {self.task}\n\n"
            f"Independent acceptance failed on the previous attempt. "
            f"The dependency trace ranks {path or action.target_ref} as the first "
            f"candidate. Inspect the evidence, make the smallest permission-gated "
            f"repair, and run relevant tests.\n\nAcceptance output:\n"
            f"{self.last_check_output[-4000:]}"
        )
        recovery_event = self.recorder.record(
            self.context,
            EventKind.RECOVERY,
            SourceType.RUNTIME,
            "coding-task-recovery-planner",
            payload={
                "stage": "recover",
                "status": "guidance-prepared",
                "target_ref": action.target_ref,
                "path": path,
            },
        )
        self.recorder.link(
            self.context,
            action.target_ref,
            recovery_event.event_id,
            DependencyKind.RECOVERY,
            evidence_event_id=recovery_event.event_id,
        )
        self._publish("recover", status="guidance-prepared", path=path)

    async def run(self) -> CodingTaskSummary:
        initial_attempts = 0
        if self.resume_run_id:
            existing = self.store.get_run(self.resume_run_id)
            if existing.mode is not RunMode.CODING:
                raise ValueError("only Coding Harness runs can be resumed here")
            if Path(existing.project_root).resolve() != self.project_root:
                raise ValueError("resumed run belongs to a different project root")
            goal = self.store.get_goal_for_run(existing.run_id)
            goal_events = [
                event
                for event in self.store.list_events(existing.run_id)
                if event.payload.get("stage") == "goal"
            ]
            stored_check = (
                str(goal_events[0].payload.get("acceptance_command") or "")
                if goal_events
                else ""
            )
            if goal.objective != self.task or stored_check != self.check_command:
                raise ValueError("resume task does not match the durable Harness goal")
            extended = self.store.extend_run_budget(
                existing.run_id,
                additional_attempts=self.max_attempts,
                additional_duration_seconds=(
                    (self.check_timeout + 300.0) * self.max_attempts
                ),
            )
            goal = replace(goal, budget=extended.budget)
            self.store.upsert_goal(goal, run_id=existing.run_id)
            self.changed_files.update(
                str(event.payload["path"])
                for event in self.store.list_events(existing.run_id)
                if event.payload.get("stage") == "workspace-change"
                and event.payload.get("path")
            )
            previous_checks = [
                event
                for event in self.store.list_events(existing.run_id)
                if event.payload.get("stage") == "acceptance-command"
            ]
            if previous_checks:
                self.last_check_output = str(
                    previous_checks[-1].payload.get("output") or ""
                )
            self.next_prompt = (
                f"Resume the interrupted Harness task: {self.task}\n\n"
                "Reinspect the current workspace and durable failure evidence before "
                "making the next smallest permission-gated change.\n\n"
                f"Previous acceptance output:\n{self.last_check_output[-4000:]}"
            )
            self._set_context(self.recorder.resume_run(existing.run_id))
            self._resumed_context_pending = True
            resumed = self.store.get_run(existing.run_id)
            initial_attempts = resumed.current_attempt - 1
        else:
            goal = self._goal()
            self._set_context(
                self.recorder.start_run(
                    goal.objective,
                    mode=RunMode.CODING,
                    goal_id=goal.goal_id,
                    budget=goal.budget,
                )
            )
        assert self.context is not None
        self.store.upsert_goal(goal, run_id=self.context.run_id)
        if not self.resume_run_id:
            self.recorder.record(
                self.context,
                EventKind.GOAL,
                SourceType.RUNTIME,
                "coding-task-goal",
                payload={
                    "stage": "goal",
                    "objective": goal.objective,
                    "acceptance_command": self.check_command,
                },
            )
        validators = ValidatorRegistry()
        validators.register("coding-task-command-validator", self._validator)
        controller = GoalController(
            goal=goal,
            run_id=self.context.run_id,
            executor=self._execute,
            detector=self._detector,
            attributor=self._attributor,
            recoverer=self,
            validators=validators,
            approval_checker=lambda _context, _action: True,
            initial_attempts=initial_attempts,
            initial_turns=initial_attempts,
        )
        try:
            result: GoalControllerResult = await controller.run()
            if result.run_status is RunStatus.SUCCEEDED and result.verification:
                self.recorder.finish_verified(self.context, result.verification)
                if self.last_recovery:
                    self.store.promote_recovery_strategy(
                        self._strategy_signature(),
                        self.last_recovery,
                        result.verification,
                    )
            else:
                self.recorder.pause(self.context, result.reason)
                if self.selected_strategy_id:
                    self.store.record_recovery_strategy_failure(
                        self.selected_strategy_id,
                        self.context.run_id,
                    )
            status = self.store.get_run(self.context.run_id).status
            durable_recoveries = len(
                self.store.export_run(self.context.run_id)["recoveries"]
            )
            return CodingTaskSummary(
                run_id=self.context.run_id,
                status=status,
                attempts=result.attempts,
                recoveries=durable_recoveries,
                changed_files=tuple(sorted(self.changed_files)),
                verification_id=(
                    result.verification.verification_id if result.verification else None
                ),
                strategy_reused=self.strategy_reused,
                reason=result.reason,
            )
        finally:
            self._set_context(None)


def run_coding_task(
    store: SQLiteRunStore,
    project_root,
    task: str,
    check_command: str,
    agent_executor: Callable[[str], str],
    *,
    max_attempts: int = 3,
    check_timeout: float = 120.0,
    progress_callback: Optional[Callable[[dict[str, Any]], None]] = None,
    context_callback: Optional[Callable[[Optional[RunContext]], None]] = None,
    resume_run_id: Optional[str] = None,
) -> CodingTaskSummary:
    loop = CodingTaskLoop(
        RunRecorder(store, project_root),
        task,
        check_command,
        agent_executor,
        max_attempts=max_attempts,
        check_timeout=check_timeout,
        progress_callback=progress_callback,
        context_callback=context_callback,
        resume_run_id=resume_run_id,
    )
    return asyncio.run(loop.run())
