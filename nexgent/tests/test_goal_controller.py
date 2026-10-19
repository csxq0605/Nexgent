"""Tests for the bounded, independently verified goal controller."""

import asyncio

import pytest

from nexgent.runtime.contracts import (
    AcceptanceCriterion,
    BudgetPolicy,
    Diagnosis,
    DiagnosisCandidate,
    FaultCategory,
    FaultObservation,
    GoalSpec,
    RecoveryAction,
    RecoveryKind,
    RunStatus,
    VerificationCheck,
    VerificationDecision,
    VerificationStatus,
)
from nexgent.runtime.controller import (
    ExecutionOutcome,
    GoalController,
    GoalControllerState,
    GoalStateMachine,
    InvalidGoalTransition,
    ValidatorRegistry,
)


RUN_ID = "run-controller-test"


def _goal(
    *,
    max_attempts=3,
    max_recoveries=2,
    max_turns=8,
    max_duration=60.0,
    recovery_kinds=(RecoveryKind.PATCH, RecoveryKind.ROLLBACK),
):
    return GoalSpec(
        goal_id="goal-controller-test",
        objective="repair and independently verify the simulation",
        criteria=(
            AcceptanceCriterion(
                criterion_id="criterion-health",
                kind="scientific_invariant",
                description="the independent health invariant passes",
                validator="health",
            ),
        ),
        allowed_recovery_kinds=recovery_kinds,
        budget=BudgetPolicy(
            max_attempts=max_attempts,
            max_recoveries_per_fault=max_recoveries,
            max_turns=max_turns,
            max_duration_seconds=max_duration,
        ),
    )


def _registry(call_order=None):
    registry = ValidatorRegistry()

    def health(context, criterion, outcome):
        if call_order is not None:
            call_order.append(criterion.criterion_id)
        passed = outcome.error is None and outcome.value == "healthy"
        return VerificationCheck(
            check_id=f"check-{context.attempt_number}-{criterion.criterion_id}",
            kind=criterion.kind,
            validator=criterion.validator,
            status=(
                VerificationStatus.PASS if passed else VerificationStatus.FAIL
            ),
            expected="healthy",
            observed=outcome.value if outcome.error is None else outcome.error,
            evidence_refs=(f"artifact-attempt-{context.attempt_number}",)
            if passed
            else (),
        )

    registry.register("health", health)
    return registry


def _detector(context, outcome, verification):
    assert verification.decision is VerificationDecision.REJECT
    return FaultObservation(
        observation_id=f"observation-{context.attempt_number}",
        run_id=RUN_ID,
        category=FaultCategory.CODE,
        signal="health invariant failed",
        severity="high",
        symptom_event_ids=(f"event-{context.attempt_number}",),
        detector="test-detector",
        metadata={"fault_id": "persistent-health-fault"},
    )


def _attributor(context, observation):
    return Diagnosis(
        diagnosis_id=f"diagnosis-{context.attempt_number}",
        run_id=RUN_ID,
        observation_id=observation.observation_id,
        candidates=(
            DiagnosisCandidate(
                suspect_ref="source:solver.py:10",
                score=0.9,
                evidence_event_ids=(f"event-{context.attempt_number}",),
                rationale="the failing invariant depends on this branch",
            ),
        ),
        method="test-dependency-trace",
    )


class FakeRecoverer:
    def __init__(self, *, kind=RecoveryKind.PATCH, requires_approval=False):
        self.kind = kind
        self.requires_approval = requires_approval
        self.proposals = 0
        self.applied = []

    def propose(self, context, diagnosis):
        self.proposals += 1
        return RecoveryAction(
            recovery_id=f"recovery-{self.proposals}",
            run_id=RUN_ID,
            diagnosis_id=diagnosis.diagnosis_id,
            kind=self.kind,
            target_ref="source:solver.py:10",
            parameters={"patch": "bounded-test-patch"},
            expected_effects=("restore health invariant",),
            risk="high" if self.requires_approval else "low",
            requires_approval=self.requires_approval,
            idempotency_key=f"recovery-key-{self.proposals}",
        )

    def apply(self, context, action):
        self.applied.append(action.recovery_id)


def _controller(*, goal, executor, recoverer, registry=None, **kwargs):
    return GoalController(
        goal=goal,
        run_id=RUN_ID,
        executor=executor,
        detector=_detector,
        attributor=_attributor,
        recoverer=recoverer,
        validators=registry or _registry(),
        **kwargs,
    )


def test_error_text_containing_tests_pass_is_never_accepted():
    recoverer = FakeRecoverer()

    def executor(context):
        return ExecutionOutcome(
            error="RuntimeError: tests pass (this phrase is untrusted output)"
        )

    result = asyncio.run(
        _controller(
            goal=_goal(max_attempts=2, max_recoveries=1),
            executor=executor,
            recoverer=recoverer,
        ).run()
    )

    assert result.run_status is RunStatus.PAUSED
    assert result.state is GoalControllerState.ESCALATE
    assert result.verification.decision is VerificationDecision.REJECT
    assert result.attempts == 2
    assert GoalControllerState.ACCEPT not in result.state_history


def test_accepts_only_after_all_registered_validators_pass():
    order = []
    registry = _registry(order)
    recoverer = FakeRecoverer()

    result = asyncio.run(
        _controller(
            goal=_goal(),
            executor=lambda context: "healthy",
            recoverer=recoverer,
            registry=registry,
        ).run()
    )

    assert result.run_status is RunStatus.SUCCEEDED
    assert result.state is GoalControllerState.ACCEPT
    assert result.verification.decision is VerificationDecision.ACCEPT
    assert all(
        check.status is VerificationStatus.PASS
        for check in result.verification.checks
    )
    assert order == ["criterion-health"]
    assert recoverer.proposals == 0


def test_rejected_attempt_triggers_bounded_recovery_and_live_rerun():
    executions = []
    recoverer = FakeRecoverer()

    def executor(context):
        executions.append((context.attempt_number, tuple(recoverer.applied)))
        return "healthy" if recoverer.applied else "broken"

    result = asyncio.run(
        _controller(
            goal=_goal(), executor=executor, recoverer=recoverer
        ).run()
    )

    assert result.run_status is RunStatus.SUCCEEDED
    assert result.attempts == 2
    assert result.recoveries == 1
    assert executions == [(1, ()), (2, ("recovery-1",))]
    assert result.state_history == (
        GoalControllerState.SPECIFY,
        GoalControllerState.EXECUTE,
        GoalControllerState.VALIDATE,
        GoalControllerState.DETECT,
        GoalControllerState.ATTRIBUTE,
        GoalControllerState.RECOVER,
        GoalControllerState.RERUN,
        GoalControllerState.EXECUTE,
        GoalControllerState.VALIDATE,
        GoalControllerState.ACCEPT,
    )


def test_recovery_limit_escalates_to_paused_instead_of_success():
    recoverer = FakeRecoverer()
    result = asyncio.run(
        _controller(
            goal=_goal(max_attempts=3, max_recoveries=1),
            executor=lambda context: "still broken",
            recoverer=recoverer,
        ).run()
    )

    assert result.run_status is RunStatus.PAUSED
    assert result.state is GoalControllerState.ESCALATE
    assert "maximum recoveries exhausted" in result.reason
    assert result.attempts == 2
    assert result.recoveries == 1
    assert recoverer.applied == ["recovery-1"]


def test_illegal_state_transition_is_rejected():
    machine = GoalStateMachine()

    with pytest.raises(InvalidGoalTransition, match="specify -> accept"):
        machine.transition(GoalControllerState.ACCEPT)

    assert machine.state is GoalControllerState.SPECIFY
    assert machine.history == [GoalControllerState.SPECIFY]


def test_unapproved_high_risk_recovery_pauses_before_apply():
    recoverer = FakeRecoverer(requires_approval=True)
    controller = _controller(
        goal=_goal(),
        executor=lambda context: "healthy" if recoverer.applied else "broken",
        recoverer=recoverer,
    )

    waiting = asyncio.run(controller.run())

    assert waiting.run_status is RunStatus.WAITING_APPROVAL
    assert waiting.state is GoalControllerState.RECOVER
    assert waiting.pending_recovery.risk == "high"
    assert recoverer.applied == []

    still_waiting = asyncio.run(controller.resume())
    assert still_waiting.run_status is RunStatus.WAITING_APPROVAL
    assert recoverer.applied == []

    accepted = asyncio.run(
        controller.resume(
            approved_recovery_ids=(waiting.pending_recovery.recovery_id,)
        )
    )
    assert accepted.run_status is RunStatus.SUCCEEDED
    assert recoverer.applied == ["recovery-1"]


def test_disallowed_recovery_kind_escalates_without_applying():
    recoverer = FakeRecoverer(kind=RecoveryKind.MODEL_SUBSTITUTION)
    result = asyncio.run(
        _controller(
            goal=_goal(recovery_kinds=(RecoveryKind.PATCH,)),
            executor=lambda context: "broken",
            recoverer=recoverer,
        ).run()
    )

    assert result.run_status is RunStatus.PAUSED
    assert "not allowed" in result.reason
    assert recoverer.applied == []


def test_turn_budget_overrun_escalates_without_validation_or_success():
    registry = _registry()
    recoverer = FakeRecoverer()
    result = asyncio.run(
        _controller(
            goal=_goal(max_turns=1),
            executor=lambda context: ExecutionOutcome(
                value="healthy", turns_used=2
            ),
            recoverer=recoverer,
            registry=registry,
        ).run()
    )

    assert result.run_status is RunStatus.PAUSED
    assert result.state is GoalControllerState.ESCALATE
    assert result.verification is None
    assert "maximum turns exceeded" in result.reason


def test_rollback_recovery_uses_explicit_rollback_state_before_rerun():
    recoverer = FakeRecoverer(kind=RecoveryKind.ROLLBACK)
    result = asyncio.run(
        _controller(
            goal=_goal(),
            executor=lambda context: "healthy" if recoverer.applied else "broken",
            recoverer=recoverer,
        ).run()
    )

    assert result.run_status is RunStatus.SUCCEEDED
    rollback_index = result.state_history.index(GoalControllerState.ROLLBACK)
    assert result.state_history[rollback_index + 1] is GoalControllerState.RERUN
