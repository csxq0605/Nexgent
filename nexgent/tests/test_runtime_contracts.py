"""Contract tests for scientific run truth."""

import pytest

from nexgent.runtime.contracts import (
    AcceptanceCriterion,
    ContractValidationError,
    Diagnosis,
    DiagnosisCandidate,
    ExperimentRun,
    GoalSpec,
    RecoveryKind,
    VerificationCheck,
    VerificationDecision,
    VerificationResult,
    VerificationStatus,
    WorkflowNode,
    WorkflowPrimitive,
)


def test_experiment_run_round_trip_preserves_budget_and_enums(tmp_path):
    run = ExperimentRun(
        run_id="run-1",
        objective="reproduce the simulation",
        project_root=str(tmp_path),
        model_profile="test/model",
        tags={"protocol": "golden"},
    )

    restored = ExperimentRun.from_dict(run.to_dict())

    assert restored == run
    assert restored.budget.max_attempts == 3
    assert restored.status.value == "created"


def test_unknown_contract_field_is_rejected(tmp_path):
    data = ExperimentRun(
        run_id="run-1", objective="x", project_root=str(tmp_path)
    ).to_dict()
    data["unexpected"] = True

    with pytest.raises(ContractValidationError, match="unknown fields"):
        ExperimentRun.from_dict(data)


def test_workflow_node_round_trip_declares_effects_and_validators():
    node = WorkflowNode(
        node_id="node-1",
        run_id="run-1",
        workflow_id="workflow-1",
        name="solve",
        primitive=WorkflowPrimitive.SIMULATOR,
        input_schema={"type": "object", "required": ["mesh"]},
        output_schema={"type": "object", "required": ["residual"]},
        depends_on=("node-prepare",),
        effects=("process", "artifact_write"),
        validators=("residual_check",),
        idempotent=True,
        max_retries=2,
    )

    assert WorkflowNode.from_dict(node.to_dict()) == node


def test_workflow_node_rejects_self_dependency():
    with pytest.raises(ContractValidationError, match="depend on itself"):
        WorkflowNode(
            node_id="node-1",
            run_id="run-1",
            workflow_id="workflow-1",
            name="bad",
            primitive=WorkflowPrimitive.TOOL,
            depends_on=("node-1",),
        ).validate()


def test_goal_requires_executable_acceptance_criterion():
    criterion = AcceptanceCriterion(
        criterion_id="criterion-tests",
        kind="command",
        description="tests pass",
        validator="command_exit_code",
        parameters={"command": "pytest"},
    )
    goal = GoalSpec(
        goal_id="goal-1",
        objective="repair the failure",
        criteria=(criterion,),
        allowed_recovery_kinds=(RecoveryKind.PATCH, RecoveryKind.ROLLBACK),
    )

    assert GoalSpec.from_dict(goal.to_dict()) == goal


def test_goal_without_criteria_is_rejected():
    with pytest.raises(ContractValidationError, match="at least one"):
        GoalSpec(goal_id="goal-1", objective="x", criteria=()).validate()


def test_diagnosis_candidates_must_be_ranked_and_evidence_backed():
    high = DiagnosisCandidate(
        suspect_ref="event-1", score=0.9, evidence_event_ids=("event-3",)
    )
    low = DiagnosisCandidate(
        suspect_ref="event-2", score=0.4, evidence_event_ids=("event-4",)
    )

    with pytest.raises(ContractValidationError, match="score-ranked"):
        Diagnosis(
            diagnosis_id="diagnosis-1",
            run_id="run-1",
            observation_id="observation-1",
            candidates=(low, high),
        ).validate()


def test_accept_decision_requires_every_check_to_pass():
    failed = VerificationCheck(
        check_id="check-1",
        kind="scientific_invariant",
        validator="mass_conservation",
        status=VerificationStatus.FAIL,
        expected=1.0,
        observed=0.7,
        evidence_refs=("artifact-log",),
    )

    with pytest.raises(ContractValidationError, match="every verification check"):
        VerificationResult(
            verification_id="verification-1",
            run_id="run-1",
            checks=(failed,),
            decision=VerificationDecision.ACCEPT,
        ).validate()


def test_passing_check_requires_evidence():
    with pytest.raises(ContractValidationError, match="needs evidence"):
        VerificationCheck(
            check_id="check-1",
            kind="command",
            validator="exit_code",
            status=VerificationStatus.PASS,
        ).validate()
