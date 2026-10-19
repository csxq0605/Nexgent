"""Durability, sequencing, and safety tests for SQLiteRunStore."""

from concurrent.futures import ThreadPoolExecutor
import json
import sqlite3

import pytest

from nexgent.runtime.contracts import (
    AcceptanceCriterion,
    AttemptStatus,
    AttemptTrigger,
    Diagnosis,
    DiagnosisCandidate,
    DependencyEdge,
    DependencyKind,
    EventKind,
    ExecutionEvent,
    ExperimentRun,
    FaultCategory,
    FaultObservation,
    FaultSpec,
    GoalSpec,
    RecoveryAction,
    RecoveryKind,
    RunAttempt,
    RunStatus,
    SourceType,
    VerificationCheck,
    VerificationDecision,
    VerificationResult,
    VerificationStatus,
    WorkflowNode,
    WorkflowPrimitive,
)
from nexgent.runtime.store import (
    LeaseConflictError,
    RunNotFoundError,
    SQLiteRunStore,
    StateConflictError,
)


def _run(tmp_path, run_id="run-1"):
    return ExperimentRun(
        run_id=run_id,
        objective="diagnose and verify",
        project_root=str(tmp_path),
    )


def _event(run_id, index):
    return ExecutionEvent(
        event_id=f"event-{index}",
        run_id=run_id,
        kind=EventKind.TOOL,
        source_type=SourceType.TOOL,
        source_id="pytest",
        payload={"index": index},
    )


def test_run_survives_fresh_store_instance(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    store.create_run(_run(tmp_path))

    reopened = SQLiteRunStore(tmp_path / "runs")

    assert reopened.get_run("run-1").objective == "diagnose and verify"


def test_v1_store_migrates_to_current_workflow_and_strategy_schema(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    with sqlite3.connect(store.db_path) as connection:
        connection.execute("DROP TABLE workflow_nodes")
        connection.execute("DELETE FROM schema_migrations WHERE version >= 2")

    reopened = SQLiteRunStore(tmp_path / "runs")
    with sqlite3.connect(reopened.db_path) as connection:
        versions = [
            row[0]
            for row in connection.execute(
                "SELECT version FROM schema_migrations ORDER BY version"
            )
        ]
        table = connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_nodes'"
        ).fetchone()
        strategy_table = connection.execute(
            """SELECT name FROM sqlite_master
               WHERE type = 'table' AND name = 'recovery_strategies'"""
        ).fetchone()

    assert versions == [1, 2, 3, 4, 5]
    assert table == ("workflow_nodes",)
    assert strategy_table == ("recovery_strategies",)


def test_run_transition_is_compare_and_set(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    store.create_run(_run(tmp_path))

    running = store.transition_run("run-1", RunStatus.CREATED, RunStatus.RUNNING)

    assert running.status is RunStatus.RUNNING
    with pytest.raises(StateConflictError, match="expected created"):
        store.transition_run("run-1", RunStatus.CREATED, RunStatus.RUNNING)


def test_invalid_terminal_transition_is_rejected(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    store.create_run(_run(tmp_path))

    with pytest.raises(StateConflictError, match="invalid run transition"):
        store.transition_run("run-1", RunStatus.CREATED, RunStatus.SUCCEEDED)


def test_attempt_budget_is_durable(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    store.create_run(_run(tmp_path))
    store.transition_run("run-1", RunStatus.CREATED, RunStatus.RUNNING)

    for index in range(3):
        attempt = RunAttempt(
            attempt_id=f"attempt-{index}",
            run_id="run-1",
            trigger=AttemptTrigger.INITIAL if index == 0 else AttemptTrigger.RETRY,
            status=AttemptStatus.RUNNING,
        )
        store.begin_attempt(attempt)

    with pytest.raises(StateConflictError, match="budget exhausted"):
        store.begin_attempt(
            RunAttempt(
                attempt_id="attempt-4",
                run_id="run-1",
                trigger=AttemptTrigger.RETRY,
                status=AttemptStatus.RUNNING,
            )
        )


def test_concurrent_events_receive_unique_contiguous_sequences(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    store.create_run(_run(tmp_path))

    with ThreadPoolExecutor(max_workers=8) as executor:
        stored = list(executor.map(lambda index: store.append_event(_event("run-1", index)), range(40)))

    assert sorted(event.sequence for event in stored) == list(range(1, 41))
    assert [event.sequence for event in store.list_events("run-1")] == list(range(1, 41))


def test_event_payload_is_redacted_without_corrupting_budget_metrics(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    store.create_run(_run(tmp_path))
    event = ExecutionEvent(
        event_id="event-secret",
        run_id="run-1",
        kind=EventKind.MODEL,
        source_type=SourceType.AGENT,
        source_id="main",
        payload={"api_key": "do-not-store", "max_tokens": 1200},
    )

    store.append_event(event)
    restored = store.list_events("run-1")[0]

    assert restored.payload["api_key"] == "[REDACTED]"
    assert restored.payload["max_tokens"] == 1200


def test_dependency_and_artifact_are_persisted(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    store.create_run(_run(tmp_path))
    first = store.append_event(_event("run-1", 1))
    second = store.append_event(_event("run-1", 2))
    edge = DependencyEdge(
        edge_id="edge-1",
        run_id="run-1",
        from_ref=first.event_id,
        to_ref=second.event_id,
        kind=DependencyKind.CAUSAL,
        evidence_event_id=second.event_id,
    )
    store.link_dependency(edge)
    artifact = store.put_artifact(
        "run-1",
        b"simulation output",
        role="simulation_result",
        media_type="text/plain",
        producer_event_id=second.event_id,
    )

    assert store.list_dependencies("run-1") == [edge]
    assert store.get_artifact(artifact.artifact_id).sha256 == artifact.sha256
    assert (tmp_path / "runs" / "artifacts" / artifact.sha256).read_bytes() == b"simulation output"


def test_typed_workflow_nodes_are_persisted_and_filterable(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    store.create_run(_run(tmp_path))
    node = WorkflowNode(
        node_id="node-simulate",
        run_id="run-1",
        workflow_id="workflow-1",
        name="simulate",
        primitive=WorkflowPrimitive.SIMULATOR,
        output_schema={"type": "object", "required": ["residual"]},
        effects=("process", "artifact_write"),
        validators=("residual_check",),
        max_retries=1,
    )

    store.put_workflow_node(node)

    assert store.list_workflow_nodes("run-1") == [node]
    assert store.list_workflow_nodes("run-1", workflow_id="workflow-1") == [node]
    assert store.list_workflow_nodes("run-1", workflow_id="other") == []


def test_workflow_node_ids_are_scoped_by_run_and_workflow(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    store.create_run(_run(tmp_path, "run-1"))
    store.create_run(_run(tmp_path, "run-2"))

    first = WorkflowNode(
        node_id="shared-node",
        run_id="run-1",
        workflow_id="workflow-1",
        name="simulate",
        primitive=WorkflowPrimitive.SIMULATOR,
    )
    second = WorkflowNode(
        node_id="shared-node",
        run_id="run-2",
        workflow_id="workflow-1",
        name="simulate",
        primitive=WorkflowPrimitive.SIMULATOR,
    )

    store.put_workflow_node(first)
    store.put_workflow_node(second)

    assert store.list_workflow_nodes("run-1") == [first]
    assert store.list_workflow_nodes("run-2") == [second]


def test_strategy_promotion_requires_high_risk_approval_and_rejects_regression(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    store.create_run(_run(tmp_path))
    store.transition_run("run-1", RunStatus.CREATED, RunStatus.RUNNING)
    evidence = store.append_event(_event("run-1", 1))
    recovery = RecoveryAction(
        recovery_id="recovery-high-risk",
        run_id="run-1",
        diagnosis_id="diagnosis-1",
        kind=RecoveryKind.PATCH,
        target_ref=evidence.event_id,
        parameters={"operation": "publish"},
        expected_effects=("publish repaired artifact",),
        risk="high",
        requires_approval=True,
    )
    store.record_recovery(recovery)
    verification = VerificationResult(
        verification_id="verification-high-risk",
        run_id="run-1",
        recovery_id=recovery.recovery_id,
        checks=(
            VerificationCheck(
                check_id="regression",
                kind="command",
                validator="pytest",
                status=VerificationStatus.PASS,
                evidence_refs=(evidence.event_id,),
            ),
        ),
        decision=VerificationDecision.ACCEPT,
    )
    store.record_verification(verification)
    store.transition_run("run-1", RunStatus.RUNNING, RunStatus.VERIFYING)
    store.transition_run("run-1", RunStatus.VERIFYING, RunStatus.SUCCEEDED)

    with pytest.raises(StateConflictError, match="durable approval"):
        store.promote_recovery_strategy("high-risk", recovery, verification)

    store.append_event(
        ExecutionEvent(
            event_id="approval-1",
            run_id="run-1",
            kind=EventKind.APPROVAL,
            source_type=SourceType.USER,
            source_id="permission-gate",
            payload={
                "recovery_id": recovery.recovery_id,
                "decision": "approved",
            },
        )
    )
    assert store.promote_recovery_strategy(
        "high-risk", recovery, verification
    ).success_count == 1

    regressed = VerificationResult(
        verification_id="verification-regressed",
        run_id="run-1",
        recovery_id=recovery.recovery_id,
        baseline_run_id="baseline-1",
        comparable_to_baseline=True,
        differences=("regression: numerical tolerance widened",),
        checks=verification.checks,
        decision=VerificationDecision.ACCEPT,
    )
    with pytest.raises(StateConflictError, match="baseline regression"):
        store.promote_recovery_strategy("regressed", recovery, regressed)


def test_dependency_graph_queries_are_stable_and_cycle_safe(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    store.create_run(_run(tmp_path))
    for edge_id, source, target in (
        ("edge-z", "root", "right"),
        ("edge-b", "left", "target"),
        ("edge-a", "root", "left"),
        ("edge-y", "right", "target"),
        ("edge-cycle", "target", "right"),
    ):
        store.link_dependency(
            DependencyEdge(
                edge_id=edge_id,
                run_id="run-1",
                from_ref=source,
                to_ref=target,
                kind=DependencyKind.CAUSAL,
            )
        )

    assert [
        edge.edge_id for edge in store.list_dependency_edges("run-1")
    ] == ["edge-b", "edge-y", "edge-a", "edge-z", "edge-cycle"]
    assert store.dependency_adjacency("run-1") == {
        "left": ("target",),
        "right": ("target",),
        "root": ("left", "right"),
        "target": ("right",),
    }
    assert store.list_ancestor_paths("run-1", "target") == [
        ("root", "left", "target"),
        ("root", "right", "target"),
    ]
    assert store.list_ancestor_paths(
        "run-1", "target", ancestor_ref="left"
    ) == [("left", "target")]


def test_dependency_queries_and_links_reject_missing_or_cross_run_refs(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    store.create_run(_run(tmp_path, "run-1"))
    store.create_run(_run(tmp_path, "run-2"))
    first = store.append_event(_event("run-1", "first"))
    other = store.append_event(_event("run-2", "other"))

    with pytest.raises(StateConflictError, match="another run"):
        store.link_dependency(
            DependencyEdge(
                edge_id="cross-run-edge",
                run_id="run-1",
                from_ref=first.event_id,
                to_ref=other.event_id,
                kind=DependencyKind.CAUSAL,
                evidence_event_id=first.event_id,
            )
        )
    with pytest.raises(StateConflictError, match="another run"):
        store.list_ancestor_paths("run-1", other.event_id)
    with pytest.raises(RunNotFoundError, match="missing-ref"):
        store.list_ancestor_paths("run-1", "missing-ref")
    with pytest.raises(RunNotFoundError, match="missing-run"):
        store.list_dependency_edges("missing-run")

    assert store.list_dependency_edges("run-1") == []


def test_export_run_is_complete_deterministic_redacted_and_blob_free(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    store.create_run(_run(tmp_path))
    store.transition_run("run-1", RunStatus.CREATED, RunStatus.RUNNING)
    attempt = RunAttempt(
        attempt_id="attempt-1",
        run_id="run-1",
        trigger=AttemptTrigger.INITIAL,
        status=AttemptStatus.RUNNING,
        started_at_ns=100,
    )
    store.begin_attempt(attempt)
    first = store.append_event(
        ExecutionEvent(
            event_id="event-z",
            run_id="run-1",
            attempt_id=attempt.attempt_id,
            kind=EventKind.MODEL,
            source_type=SourceType.AGENT,
            source_id="main",
            payload={"authorization": "secret-event", "result": "candidate"},
            timestamp_ns=110,
        )
    )
    second = store.append_event(
        ExecutionEvent(
            event_id="event-a",
            run_id="run-1",
            attempt_id=attempt.attempt_id,
            kind=EventKind.SIMULATOR,
            source_type=SourceType.SIMULATOR,
            source_id="solver",
            timestamp_ns=120,
        )
    )
    workflow_node = WorkflowNode(
        node_id="node-1",
        run_id="run-1",
        workflow_id="workflow-1",
        name="run solver",
        primitive=WorkflowPrimitive.SIMULATOR,
        output_schema={"type": "object"},
        effects=("process",),
    )
    store.put_workflow_node(workflow_node)
    store.link_dependency(
        DependencyEdge(
            edge_id="edge-1",
            run_id="run-1",
            from_ref=first.event_id,
            to_ref=second.event_id,
            kind=DependencyKind.DATA,
            evidence_event_id=second.event_id,
        )
    )
    artifact_blob = b"BLOB-MUST-NOT-APPEAR-IN-EXPORT"
    artifact = store.put_artifact(
        "run-1",
        artifact_blob,
        role="simulation_result",
        producer_event_id=second.event_id,
        metadata={"api_key": "secret-artifact", "mesh": "coarse"},
    )
    goal = GoalSpec(
        goal_id="goal-1",
        objective="produce a verified simulation",
        criteria=(
            AcceptanceCriterion(
                criterion_id="criterion-1",
                kind="artifact",
                description="simulation artifact exists",
                validator="pytest",
                parameters={"password": "secret-goal"},
            ),
        ),
    )
    store.upsert_goal(goal, run_id="run-1")
    fault = FaultSpec(
        fault_id="fault-1",
        run_id="run-1",
        category=FaultCategory.CONFIG,
        target_ref=second.event_id,
        trigger={"when": "always"},
        ground_truth={"password": "secret-fault", "cause": "bad tolerance"},
    )
    observation = FaultObservation(
        observation_id="observation-1",
        run_id="run-1",
        category=FaultCategory.NUMERICAL,
        signal="residual diverged",
        severity="high",
        symptom_event_ids=(second.event_id,),
        detector="residual-check",
    )
    store.record_fault(fault)
    store.record_fault(observation)
    diagnosis = Diagnosis(
        diagnosis_id="diagnosis-1",
        run_id="run-1",
        observation_id=observation.observation_id,
        candidates=(
            DiagnosisCandidate(
                suspect_ref=second.event_id,
                score=0.9,
                evidence_event_ids=(second.event_id,),
            ),
        ),
    )
    store.record_diagnosis(diagnosis)
    recovery = RecoveryAction(
        recovery_id="recovery-1",
        run_id="run-1",
        diagnosis_id=diagnosis.diagnosis_id,
        kind=RecoveryKind.PATCH,
        target_ref=second.event_id,
        parameters={"access_token": "secret-recovery"},
        expected_effects=("residual converges",),
        idempotency_key="repair-tolerance",
    )
    store.record_recovery(recovery)
    verification = VerificationResult(
        verification_id="verification-1",
        run_id="run-1",
        recovery_id=recovery.recovery_id,
        checks=(
            VerificationCheck(
                check_id="check-1",
                kind="residual",
                validator="residual-check",
                status=VerificationStatus.PASS,
                observed={"refresh_token": "secret-verification", "value": 0.0},
                evidence_refs=(artifact.artifact_id,),
            ),
        ),
        decision=VerificationDecision.ACCEPT,
    )
    store.record_verification(verification)

    exported = store.export_run("run-1")

    assert exported == store.export_run("run-1")
    assert set(exported) == {
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
    assert [item["attempt_id"] for item in exported["attempts"]] == ["attempt-1"]
    assert [item["event_id"] for item in exported["events"]] == [
        "event-z",
        "event-a",
    ]
    assert [item["edge_id"] for item in exported["dependency_edges"]] == [
        "edge-1"
    ]
    assert [item["node_id"] for item in exported["workflow_nodes"]] == ["node-1"]
    assert [item["record_type"] for item in exported["faults"]] == [
        "FaultSpec",
        "FaultObservation",
    ]
    assert exported["artifacts"] == [
        {
            key: value
            for key, value in {
                **store.get_artifact(artifact.artifact_id).to_dict(),
                "content_address": f"sha256:{artifact.sha256}",
            }.items()
            if key != "path_or_uri"
        }
    ]
    serialized = json.dumps(exported, sort_keys=True)
    for secret in (
        "secret-event",
        "secret-artifact",
        "secret-goal",
        "secret-fault",
        "secret-recovery",
        "secret-verification",
    ):
        assert secret not in serialized
    assert artifact_blob.decode() not in serialized
    assert str(tmp_path / "runs" / "artifacts") not in serialized


def test_export_run_is_cross_run_isolated(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    for run_id in ("run-1", "run-2"):
        store.create_run(_run(tmp_path, run_id))
        store.append_event(_event(run_id, run_id))

    first_export = json.dumps(store.export_run("run-1"), sort_keys=True)

    assert "event-run-1" in first_export
    assert "event-run-2" not in first_export
    with pytest.raises(RunNotFoundError, match="missing-run"):
        store.export_run("missing-run")


def test_jsonl_export_is_deterministic_and_record_typed(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    store.create_run(_run(tmp_path))
    store.append_event(_event("run-1", 1))

    first = store.export_run_jsonl("run-1")
    second = store.export_run_jsonl("run-1")
    rows = [json.loads(line) for line in first.splitlines()]

    assert first == second
    assert [row["record_type"] for row in rows] == ["run", "events"]
    assert all(row["export_schema_version"] == "1.0" for row in rows)


def test_lease_prevents_two_runtimes_from_owning_same_run(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    store.create_run(_run(tmp_path))
    store.acquire_lease("run-1", "worker-a", ttl_seconds=10)

    with pytest.raises(LeaseConflictError, match="worker-a"):
        store.acquire_lease("run-1", "worker-b", ttl_seconds=10)

    store.heartbeat("run-1", "worker-a", ttl_seconds=10)
    store.release_lease("run-1", "worker-a")
    store.acquire_lease("run-1", "worker-b", ttl_seconds=10)
