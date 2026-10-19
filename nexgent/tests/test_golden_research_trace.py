from nexgent.runtime.contracts import (
    AcceptanceCriterion,
    DependencyKind,
    Diagnosis,
    DiagnosisCandidate,
    EventKind,
    FaultCategory,
    FaultObservation,
    FaultSpec,
    GoalSpec,
    RecoveryAction,
    RecoveryKind,
    SourceType,
    VerificationCheck,
    VerificationDecision,
    VerificationResult,
    VerificationStatus,
    WorkflowNode,
    WorkflowPrimitive,
)
from nexgent.runtime.recorder import RunRecorder
from nexgent.runtime.store import SQLiteRunStore
from nexgent.runtime.verify import verify_export


def test_comprehensive_golden_trace_covers_every_cross_layer_event(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    recorder = RunRecorder(store, tmp_path)
    context = recorder.start_run("comprehensive golden Harness trace")
    workflow_node = WorkflowNode(
        node_id="node-simulator",
        run_id=context.run_id,
        workflow_id="workflow-golden",
        name="run deterministic simulator",
        primitive=WorkflowPrimitive.SIMULATOR,
        input_schema={"type": "object", "required": ["parameter"]},
        output_schema={"type": "object", "required": ["residual"]},
        effects=("process", "artifact_write"),
        validators=("residual_check", "invariant_check"),
        idempotent=True,
        max_retries=1,
    )
    store.put_workflow_node(workflow_node)
    goal = GoalSpec(
        goal_id="goal-golden",
        objective="produce verified simulator evidence",
        criteria=(
            AcceptanceCriterion(
                criterion_id="criterion-invariant",
                kind="scientific_invariant",
                description="residual and invariant checks pass",
                validator="golden_validator",
            ),
        ),
    )
    store.upsert_goal(goal, run_id=context.run_id)

    recorded = []

    def append(kind, source_type, source_id, payload):
        event = recorder.record(
            context,
            kind,
            source_type,
            source_id,
            payload=payload,
            causation_event_id=(recorded[-1].event_id if recorded else None),
            workflow_node_id=workflow_node.node_id,
        )
        if recorded:
            recorder.link(
                context,
                recorded[-1].event_id,
                event.event_id,
                DependencyKind.CAUSAL,
                evidence_event_id=event.event_id,
            )
        recorded.append(event)
        return event

    append(EventKind.ATTEMPT, SourceType.RUNTIME, "runtime", {"phase": "initial"})
    append(EventKind.GOAL, SourceType.RUNTIME, "goal-controller", {"goal_id": goal.goal_id})
    append(EventKind.DECISION, SourceType.AGENT, "planner", {"decision": "execute"})
    append(EventKind.MODEL, SourceType.AGENT, "planner", {"model": "deterministic-fake"})
    append(EventKind.TOOL, SourceType.TOOL, "write_config", {"effect": "artifact_write"})
    append(EventKind.WORKFLOW, SourceType.WORKFLOW, "workflow-golden", {"node": workflow_node.node_id})
    append(EventKind.PROCESS, SourceType.PROCESS, "solver-process", {"exit_code": 0})
    simulator_event = append(
        EventKind.SIMULATOR,
        SourceType.SIMULATOR,
        "golden-simulator",
        {"residual": 0.0, "converged": True},
    )
    artifact_event = append(
        EventKind.ARTIFACT,
        SourceType.RUNTIME,
        "artifact-store",
        {"role": "simulation_result"},
    )
    artifact = recorder.record_artifact(
        context,
        b'{"residual":0.0,"invariant":true}',
        role="simulation_result",
        media_type="application/json",
        producer_event_id=artifact_event.event_id,
        metadata={"units": "dimensionless"},
    )
    recorder.link(
        context,
        artifact_event.event_id,
        artifact.artifact_id,
        DependencyKind.ARTIFACT,
        evidence_event_id=artifact_event.event_id,
    )
    append(EventKind.CHECKPOINT, SourceType.RUNTIME, "checkpoint", {"checkpoint_id": "cp-1"})
    fault_event = append(
        EventKind.FAULT,
        SourceType.SYSTEM,
        "fault-injector",
        {"fault_id": "fault-golden", "injected": True},
    )
    fault = FaultSpec(
        fault_id="fault-golden",
        run_id=context.run_id,
        category=FaultCategory.CONFIG,
        target_ref=simulator_event.event_id,
        trigger={"attempt": 1},
        ground_truth={"cause": "invalid tolerance"},
    )
    observation = FaultObservation(
        observation_id="observation-golden",
        run_id=context.run_id,
        category=FaultCategory.CONFIG,
        signal="tolerance rejected",
        severity="high",
        symptom_event_ids=(fault_event.event_id,),
        detector="config-validator",
    )
    store.record_fault(fault)
    store.record_fault(observation)
    diagnosis_event = append(
        EventKind.DIAGNOSIS,
        SourceType.AGENT,
        "attributor",
        {"observation_id": observation.observation_id},
    )
    diagnosis = Diagnosis(
        diagnosis_id="diagnosis-golden",
        run_id=context.run_id,
        observation_id=observation.observation_id,
        candidates=(
            DiagnosisCandidate(
                suspect_ref=simulator_event.event_id,
                score=1.0,
                evidence_event_ids=(diagnosis_event.event_id,),
                causal_path=(fault_event.event_id, diagnosis_event.event_id),
            ),
        ),
    )
    store.record_diagnosis(diagnosis)
    recovery_event = append(
        EventKind.RECOVERY,
        SourceType.AGENT,
        "recovery-planner",
        {"action": "parameter_override"},
    )
    recovery = RecoveryAction(
        recovery_id="recovery-golden",
        run_id=context.run_id,
        diagnosis_id=diagnosis.diagnosis_id,
        kind=RecoveryKind.PARAMETER_OVERRIDE,
        target_ref=simulator_event.event_id,
        parameters={"tolerance": 1e-8},
        expected_effects=("configuration accepted",),
        requires_approval=False,
        idempotency_key="golden-tolerance",
    )
    store.record_recovery(recovery)
    append(EventKind.APPROVAL, SourceType.USER, "operator", {"decision": "not_required"})
    append(EventKind.NOTICE, SourceType.SYSTEM, "monitor", {"message": "rerun stable"})
    verification = VerificationResult(
        verification_id="verification-golden",
        run_id=context.run_id,
        recovery_id=recovery.recovery_id,
        checks=(
            VerificationCheck(
                check_id="check-golden",
                kind="scientific_invariant",
                validator="golden-validator",
                status=VerificationStatus.PASS,
                expected=True,
                observed=True,
                evidence_refs=(artifact.artifact_id,),
            ),
        ),
        decision=VerificationDecision.ACCEPT,
    )
    recorder.finish_verified(context, verification)

    exported = store.export_run(context.run_id)
    report = verify_export(
        exported,
        required_event_kinds=tuple(kind.value for kind in EventKind),
        strict_lifecycles=True,
    )

    assert {event["kind"] for event in exported["events"]} == {
        kind.value for kind in EventKind
    }
    assert report.ok, report.errors
    assert report.counts["workflow_nodes"] == 1
    assert report.counts["artifacts"] == 1
    assert report.counts["faults"] == 2
