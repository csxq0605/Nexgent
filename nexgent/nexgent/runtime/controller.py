"""Bounded, independently verified goal controller.

The controller deliberately separates execution from acceptance.  Executors
produce observations; only validators registered against the goal's explicit
acceptance criteria can produce a :class:`VerificationResult`.  Recovery is
also split into proposal and application so policy and approval checks happen
before any injected side-effect boundary is crossed.
"""

from __future__ import annotations

import inspect
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Awaitable, Callable, Mapping, Optional, Protocol

from .contracts import (
    AcceptanceCriterion,
    Diagnosis,
    FaultObservation,
    GoalSpec,
    RecoveryAction,
    RecoveryKind,
    RunStatus,
    VerificationCheck,
    VerificationDecision,
    VerificationResult,
    VerificationStatus,
)


class GoalControllerError(RuntimeError):
    """Base error for controller protocol and state violations."""


class InvalidGoalTransition(GoalControllerError):
    """Raised when code attempts a transition outside the declared machine."""


class GoalControllerState(str, Enum):
    SPECIFY = "specify"
    EXECUTE = "execute"
    VALIDATE = "validate"
    DETECT = "detect"
    ATTRIBUTE = "attribute"
    RECOVER = "recover"
    RERUN = "rerun"
    ACCEPT = "accept"
    ROLLBACK = "rollback"
    ESCALATE = "escalate"


_LEGAL_TRANSITIONS: Mapping[GoalControllerState, frozenset[GoalControllerState]] = {
    GoalControllerState.SPECIFY: frozenset(
        {GoalControllerState.EXECUTE, GoalControllerState.ESCALATE}
    ),
    GoalControllerState.EXECUTE: frozenset(
        {GoalControllerState.VALIDATE, GoalControllerState.ESCALATE}
    ),
    GoalControllerState.VALIDATE: frozenset(
        {
            GoalControllerState.ACCEPT,
            GoalControllerState.DETECT,
            GoalControllerState.ESCALATE,
        }
    ),
    GoalControllerState.DETECT: frozenset(
        {GoalControllerState.ATTRIBUTE, GoalControllerState.ESCALATE}
    ),
    GoalControllerState.ATTRIBUTE: frozenset(
        {GoalControllerState.RECOVER, GoalControllerState.ESCALATE}
    ),
    GoalControllerState.RECOVER: frozenset(
        {
            GoalControllerState.ROLLBACK,
            GoalControllerState.RERUN,
            GoalControllerState.ESCALATE,
        }
    ),
    GoalControllerState.ROLLBACK: frozenset(
        {GoalControllerState.RERUN, GoalControllerState.ESCALATE}
    ),
    GoalControllerState.RERUN: frozenset(
        {GoalControllerState.EXECUTE, GoalControllerState.ESCALATE}
    ),
    GoalControllerState.ACCEPT: frozenset(),
    GoalControllerState.ESCALATE: frozenset(),
}


@dataclass
class GoalStateMachine:
    """Small explicit state machine whose transition history is audit-friendly."""

    state: GoalControllerState = GoalControllerState.SPECIFY
    history: list[GoalControllerState] = field(
        default_factory=lambda: [GoalControllerState.SPECIFY]
    )

    def transition(self, target: GoalControllerState) -> None:
        if target not in _LEGAL_TRANSITIONS[self.state]:
            raise InvalidGoalTransition(
                f"illegal goal transition: {self.state.value} -> {target.value}"
            )
        self.state = target
        self.history.append(target)


@dataclass(frozen=True)
class ExecutionOutcome:
    """Opaque executor output plus explicit budget accounting.

    ``error`` is data for validators and detectors.  It is never interpreted by
    the controller as evidence of success or failure.
    """

    value: Any = None
    error: Optional[str] = None
    turns_used: int = 1


@dataclass(frozen=True)
class ControllerContext:
    goal: GoalSpec
    run_id: str
    attempt_number: int
    turns_used: int
    remaining_turns: int
    recovery_count: int
    previous_recovery: Optional[RecoveryAction] = None


@dataclass(frozen=True)
class GoalControllerResult:
    state: GoalControllerState
    run_status: RunStatus
    reason: str
    verification: Optional[VerificationResult]
    attempts: int
    turns_used: int
    recoveries: int
    state_history: tuple[GoalControllerState, ...]
    pending_recovery: Optional[RecoveryAction] = None


Validator = Callable[
    [ControllerContext, AcceptanceCriterion, ExecutionOutcome],
    VerificationCheck | Awaitable[VerificationCheck],
]


async def _resolve(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


class ValidatorRegistry:
    """Exact-name validator registry evaluated in GoalSpec criterion order."""

    def __init__(self) -> None:
        self._validators: dict[str, Validator] = {}

    def register(self, name: str, validator: Validator) -> None:
        if not name.strip():
            raise ValueError("validator name is required")
        if name in self._validators:
            raise ValueError(f"validator {name!r} is already registered")
        self._validators[name] = validator

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._validators))

    def require_goal_validators(self, goal: GoalSpec) -> None:
        missing = sorted(
            {criterion.validator for criterion in goal.criteria}
            - self._validators.keys()
        )
        if missing:
            raise GoalControllerError(f"missing validators: {', '.join(missing)}")

    async def evaluate(
        self,
        *,
        context: ControllerContext,
        outcome: ExecutionOutcome,
    ) -> VerificationResult:
        checks: list[VerificationCheck] = []
        for criterion in context.goal.criteria:
            validator = self._validators[criterion.validator]
            check = await _resolve(validator(context, criterion, outcome))
            if not isinstance(check, VerificationCheck):
                raise GoalControllerError(
                    f"validator {criterion.validator!r} must return VerificationCheck"
                )
            if check.validator != criterion.validator:
                raise GoalControllerError(
                    f"validator {criterion.validator!r} returned a check attributed "
                    f"to {check.validator!r}"
                )
            check.validate()
            checks.append(check)

        statuses = {check.status for check in checks}
        if statuses == {VerificationStatus.PASS}:
            decision = VerificationDecision.ACCEPT
        elif VerificationStatus.INCONCLUSIVE in statuses:
            decision = VerificationDecision.ESCALATE
        else:
            decision = VerificationDecision.REJECT

        result = VerificationResult(
            verification_id=(
                f"verification-{context.run_id}-attempt-{context.attempt_number}"
            ),
            run_id=context.run_id,
            checks=tuple(checks),
            decision=decision,
            recovery_id=(
                context.previous_recovery.recovery_id
                if context.previous_recovery is not None
                else None
            ),
        )
        result.validate()
        return result


class RecoveryHandler(Protocol):
    """Two-phase recovery boundary.

    ``propose`` must be side-effect free.  The controller invokes ``apply`` only
    after allow-list, budget, and approval checks succeed.
    """

    def propose(
        self, context: ControllerContext, diagnosis: Diagnosis
    ) -> RecoveryAction | Awaitable[RecoveryAction]: ...

    def apply(
        self, context: ControllerContext, action: RecoveryAction
    ) -> Any | Awaitable[Any]: ...


Executor = Callable[[ControllerContext], Any | Awaitable[Any]]
Detector = Callable[
    [ControllerContext, ExecutionOutcome, VerificationResult],
    FaultObservation | Awaitable[FaultObservation],
]
Attributor = Callable[
    [ControllerContext, FaultObservation], Diagnosis | Awaitable[Diagnosis]
]
ApprovalChecker = Callable[
    [ControllerContext, RecoveryAction], bool | Awaitable[bool]
]


class GoalController:
    """Execute a goal until independently accepted or safely paused.

    The controller owns no provider, process, filesystem, or simulator effect.
    All such boundaries are injected, which keeps the state machine replayable
    and permits fault-campaign tests without touching external systems.
    """

    def __init__(
        self,
        *,
        goal: GoalSpec,
        run_id: str,
        executor: Executor,
        detector: Detector,
        attributor: Attributor,
        recoverer: RecoveryHandler,
        validators: ValidatorRegistry,
        approval_checker: Optional[ApprovalChecker] = None,
        monotonic: Callable[[], float] = time.monotonic,
        initial_attempts: int = 0,
        initial_turns: int = 0,
    ) -> None:
        if not run_id.strip():
            raise ValueError("run_id is required")
        if initial_attempts < 0 or initial_turns < 0:
            raise ValueError("initial controller counters cannot be negative")
        self.goal = goal
        self.run_id = run_id
        self.executor = executor
        self.detector = detector
        self.attributor = attributor
        self.recoverer = recoverer
        self.validators = validators
        self.approval_checker = approval_checker
        self.monotonic = monotonic

        self.machine = GoalStateMachine()
        self._started_at: Optional[float] = None
        self._attempts = initial_attempts
        self._turns_used = initial_turns
        self._recoveries_by_fault: dict[str, int] = {}
        self._last_outcome: Optional[ExecutionOutcome] = None
        self._last_verification: Optional[VerificationResult] = None
        self._last_recovery: Optional[RecoveryAction] = None
        self._pending_recovery: Optional[RecoveryAction] = None
        self._pending_diagnosis: Optional[Diagnosis] = None
        self._pending_fault_key: Optional[str] = None

    async def run(self) -> GoalControllerResult:
        if self.machine.state is not GoalControllerState.SPECIFY:
            raise GoalControllerError("run() may only be called from specify state")
        self._started_at = self.monotonic()
        try:
            self.goal.validate()
            self.validators.require_goal_validators(self.goal)
        except Exception as exc:
            return self._escalate(f"invalid goal specification: {exc}")
        self.machine.transition(GoalControllerState.EXECUTE)
        return await self._drive()

    async def resume(
        self, *, approved_recovery_ids: tuple[str, ...] = ()
    ) -> GoalControllerResult:
        """Resume a recovery paused at its approval boundary."""

        if (
            self.machine.state is not GoalControllerState.RECOVER
            or self._pending_recovery is None
            or self._pending_diagnosis is None
            or self._pending_fault_key is None
        ):
            raise GoalControllerError("there is no pending recovery to resume")
        if self._duration_exceeded():
            return self._escalate("maximum duration exceeded while awaiting approval")
        action = self._pending_recovery
        if action.recovery_id not in approved_recovery_ids:
            return self._result(
                RunStatus.WAITING_APPROVAL,
                f"approval required for recovery {action.recovery_id}",
            )
        await self._apply_recovery(
            self._pending_diagnosis, action, self._pending_fault_key
        )
        if self.machine.state is GoalControllerState.ESCALATE:
            return self._result(RunStatus.PAUSED, "recovery application failed")
        return await self._drive()

    def _context(self) -> ControllerContext:
        return ControllerContext(
            goal=self.goal,
            run_id=self.run_id,
            attempt_number=self._attempts,
            turns_used=self._turns_used,
            remaining_turns=max(0, self.goal.budget.max_turns - self._turns_used),
            recovery_count=sum(self._recoveries_by_fault.values()),
            previous_recovery=self._last_recovery,
        )

    def _duration_exceeded(self) -> bool:
        return (
            self._started_at is not None
            and self.monotonic() - self._started_at
            >= self.goal.budget.max_duration_seconds
        )

    def _budget_guard(self, operation: str) -> Optional[GoalControllerResult]:
        if self._duration_exceeded():
            return self._escalate(
                f"maximum duration exceeded before {operation}"
            )
        return None

    async def _drive(self) -> GoalControllerResult:
        while True:
            if self.machine.state is GoalControllerState.EXECUTE:
                stopped = self._budget_guard("execute")
                if stopped is not None:
                    return stopped
                if self._attempts >= self.goal.budget.max_attempts:
                    return self._escalate("maximum attempts exhausted")
                if self._turns_used >= self.goal.budget.max_turns:
                    return self._escalate("maximum turns exhausted")
                self._attempts += 1
                context = self._context()
                try:
                    raw_outcome = await _resolve(self.executor(context))
                    if isinstance(raw_outcome, ExecutionOutcome):
                        outcome = raw_outcome
                    else:
                        outcome = ExecutionOutcome(value=raw_outcome)
                except Exception as exc:
                    outcome = ExecutionOutcome(
                        error=f"{type(exc).__name__}: {exc}", turns_used=1
                    )
                if outcome.turns_used < 1:
                    return self._escalate("executor reported an invalid turn count")
                self._turns_used += outcome.turns_used
                self._last_outcome = outcome
                if self._turns_used > self.goal.budget.max_turns:
                    return self._escalate("maximum turns exceeded by executor")
                stopped = self._budget_guard("validation")
                if stopped is not None:
                    return stopped
                self.machine.transition(GoalControllerState.VALIDATE)

            elif self.machine.state is GoalControllerState.VALIDATE:
                assert self._last_outcome is not None
                try:
                    verification = await self.validators.evaluate(
                        context=self._context(), outcome=self._last_outcome
                    )
                except Exception as exc:
                    return self._escalate(f"independent validation failed: {exc}")
                self._last_verification = verification
                stopped = self._budget_guard("post-validation decision")
                if stopped is not None:
                    return stopped
                if verification.decision is VerificationDecision.ACCEPT:
                    self.machine.transition(GoalControllerState.ACCEPT)
                    return self._result(
                        RunStatus.SUCCEEDED,
                        "every independent acceptance criterion passed",
                    )
                if verification.decision is VerificationDecision.ESCALATE:
                    return self._escalate("verification was inconclusive")
                self.machine.transition(GoalControllerState.DETECT)

            elif self.machine.state is GoalControllerState.DETECT:
                assert self._last_outcome is not None
                assert self._last_verification is not None
                stopped = self._budget_guard("fault detection")
                if stopped is not None:
                    return stopped
                try:
                    observation = await _resolve(
                        self.detector(
                            self._context(),
                            self._last_outcome,
                            self._last_verification,
                        )
                    )
                    if not isinstance(observation, FaultObservation):
                        raise GoalControllerError(
                            "detector must return FaultObservation"
                        )
                    observation.validate()
                    if observation.run_id != self.run_id:
                        raise GoalControllerError("detector returned another run's fault")
                except Exception as exc:
                    return self._escalate(f"fault detection failed: {exc}")
                self._current_observation = observation
                self.machine.transition(GoalControllerState.ATTRIBUTE)

            elif self.machine.state is GoalControllerState.ATTRIBUTE:
                stopped = self._budget_guard("fault attribution")
                if stopped is not None:
                    return stopped
                try:
                    diagnosis = await _resolve(
                        self.attributor(self._context(), self._current_observation)
                    )
                    if not isinstance(diagnosis, Diagnosis):
                        raise GoalControllerError("attributor must return Diagnosis")
                    diagnosis.validate()
                    if diagnosis.run_id != self.run_id:
                        raise GoalControllerError(
                            "attributor returned another run's diagnosis"
                        )
                    if diagnosis.observation_id != self._current_observation.observation_id:
                        raise GoalControllerError(
                            "diagnosis does not reference the detected observation"
                        )
                except Exception as exc:
                    return self._escalate(f"fault attribution failed: {exc}")
                self._current_diagnosis = diagnosis
                self.machine.transition(GoalControllerState.RECOVER)

            elif self.machine.state is GoalControllerState.RECOVER:
                stopped = self._budget_guard("recovery planning")
                if stopped is not None:
                    return stopped
                fault_key = self._fault_key(self._current_observation)
                if (
                    self._recoveries_by_fault.get(fault_key, 0)
                    >= self.goal.budget.max_recoveries_per_fault
                ):
                    return self._escalate(
                        f"maximum recoveries exhausted for fault {fault_key}"
                    )
                try:
                    action = await _resolve(
                        self.recoverer.propose(
                            self._context(), self._current_diagnosis
                        )
                    )
                    if not isinstance(action, RecoveryAction):
                        raise GoalControllerError(
                            "recoverer.propose must return RecoveryAction"
                        )
                    action.validate()
                    if action.run_id != self.run_id:
                        raise GoalControllerError(
                            "recoverer proposed an action for another run"
                        )
                    if action.diagnosis_id != self._current_diagnosis.diagnosis_id:
                        raise GoalControllerError(
                            "recovery does not reference the active diagnosis"
                        )
                except Exception as exc:
                    return self._escalate(f"recovery planning failed: {exc}")

                if action.kind is RecoveryKind.ESCALATE:
                    return self._escalate("recoverer requested escalation")
                if action.kind not in self.goal.allowed_recovery_kinds:
                    return self._escalate(
                        f"recovery kind {action.kind.value} is not allowed by the goal"
                    )

                if action.requires_approval:
                    approved = False
                    if self.approval_checker is not None:
                        try:
                            approved = bool(
                                await _resolve(
                                    self.approval_checker(self._context(), action)
                                )
                            )
                        except Exception as exc:
                            return self._escalate(
                                f"approval check failed: {exc}"
                            )
                    if not approved:
                        self._pending_recovery = action
                        self._pending_diagnosis = self._current_diagnosis
                        self._pending_fault_key = fault_key
                        return self._result(
                            RunStatus.WAITING_APPROVAL,
                            f"approval required for recovery {action.recovery_id}",
                        )

                await self._apply_recovery(
                    self._current_diagnosis, action, fault_key
                )
                if self.machine.state is GoalControllerState.ESCALATE:
                    return self._result(RunStatus.PAUSED, "recovery application failed")

            elif self.machine.state is GoalControllerState.RERUN:
                self.machine.transition(GoalControllerState.EXECUTE)

            else:
                raise GoalControllerError(
                    f"controller cannot drive terminal state {self.machine.state.value}"
                )

    async def _apply_recovery(
        self, diagnosis: Diagnosis, action: RecoveryAction, fault_key: str
    ) -> None:
        stopped = self._budget_guard("recovery application")
        if stopped is not None:
            return
        try:
            await _resolve(self.recoverer.apply(self._context(), action))
        except Exception as exc:
            self._escalate(f"recovery application failed: {exc}")
            return

        self._recoveries_by_fault[fault_key] = (
            self._recoveries_by_fault.get(fault_key, 0) + 1
        )
        self._last_recovery = action
        self._pending_recovery = None
        self._pending_diagnosis = None
        self._pending_fault_key = None
        if action.kind is RecoveryKind.ROLLBACK:
            self.machine.transition(GoalControllerState.ROLLBACK)
            self.machine.transition(GoalControllerState.RERUN)
        else:
            self.machine.transition(GoalControllerState.RERUN)

    @staticmethod
    def _fault_key(observation: FaultObservation) -> str:
        declared = observation.metadata.get("fault_id")
        if isinstance(declared, str) and declared.strip():
            return declared
        return f"{observation.category.value}:{observation.signal}"

    def _escalate(self, reason: str) -> GoalControllerResult:
        if self.machine.state is not GoalControllerState.ESCALATE:
            self.machine.transition(GoalControllerState.ESCALATE)
        return self._result(RunStatus.PAUSED, reason)

    def _result(self, status: RunStatus, reason: str) -> GoalControllerResult:
        return GoalControllerResult(
            state=self.machine.state,
            run_status=status,
            reason=reason,
            verification=self._last_verification,
            attempts=self._attempts,
            turns_used=self._turns_used,
            recoveries=sum(self._recoveries_by_fault.values()),
            state_history=tuple(self.machine.history),
            pending_recovery=self._pending_recovery,
        )
