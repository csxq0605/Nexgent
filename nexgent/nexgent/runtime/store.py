"""Crash-resilient SQLite store for Coding Harness run truth."""

from __future__ import annotations

import dataclasses
import hashlib
import json
import os
import sqlite3
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Iterable, Optional, TypeVar

from .contracts import (
    SCHEMA_VERSION,
    AcceptanceCriterion,
    ArtifactRecord,
    AttemptStatus,
    Contract,
    DependencyEdge,
    Diagnosis,
    ExecutionEvent,
    ExperimentRun,
    FaultObservation,
    FaultSpec,
    GoalSpec,
    RecoveryAction,
    RecoveryStrategy,
    RunAttempt,
    RunStatus,
    VerificationResult,
    WorkflowNode,
    WorkflowNodeResult,
    WorkflowNodeStatus,
    new_id,
    now_ns,
)


class RunStoreError(RuntimeError):
    """Base error for durable run-state failures."""


class RunNotFoundError(RunStoreError):
    pass


class StateConflictError(RunStoreError):
    pass


class LeaseConflictError(RunStoreError):
    pass


TContract = TypeVar("TContract", bound=Contract)


_SECRET_KEYS = {
    "api_key",
    "apikey",
    "authorization",
    "cookie",
    "password",
    "secret",
    "access_token",
    "refresh_token",
    "bearer_token",
}


_RUN_TRANSITIONS = {
    RunStatus.CREATED: {RunStatus.RUNNING, RunStatus.ABORTED},
    RunStatus.RUNNING: {
        RunStatus.WAITING_APPROVAL,
        RunStatus.VERIFYING,
        RunStatus.COMPLETED_UNVERIFIED,
        RunStatus.FAILED,
        RunStatus.PAUSED,
        RunStatus.ABORTED,
    },
    RunStatus.WAITING_APPROVAL: {
        RunStatus.RUNNING,
        RunStatus.PAUSED,
        RunStatus.ABORTED,
    },
    RunStatus.VERIFYING: {
        RunStatus.SUCCEEDED,
        RunStatus.RUNNING,
        RunStatus.WAITING_APPROVAL,
        RunStatus.FAILED,
        RunStatus.ABORTED,
    },
    RunStatus.PAUSED: {RunStatus.RUNNING, RunStatus.FAILED, RunStatus.ABORTED},
    RunStatus.COMPLETED_UNVERIFIED: set(),
    RunStatus.SUCCEEDED: set(),
    RunStatus.FAILED: set(),
    RunStatus.ABORTED: set(),
}


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        redacted = {}
        for key, item in value.items():
            normalized = str(key).lower().replace("-", "_")
            if normalized in _SECRET_KEYS or normalized.endswith("_api_key"):
                redacted[str(key)] = "[REDACTED]"
            else:
                redacted[str(key)] = _redact(item)
        return redacted
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


def _payload(contract: Contract) -> str:
    return json.dumps(
        _redact(contract.to_dict()),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


class SQLiteRunStore:
    """Persist run state, events, edges, and artifacts in one project store.

    Each public operation opens its own connection.  SQLite WAL plus immediate
    transactions provide deterministic event sequencing across Agent tool-worker
    threads and allow a fresh process to resume from the same state.
    """

    def __init__(self, root: os.PathLike[str] | str):
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.db_path = self.root / "runs.sqlite3"
        self.artifact_dir = self.root / "artifacts"
        self.artifact_dir.mkdir(parents=True, exist_ok=True)
        self._migration_lock = threading.Lock()
        self._migrate()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=30.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 30000")
        return connection

    def _migrate(self) -> None:
        with self._migration_lock:
            connection = self._connect()
            try:
                connection.execute("PRAGMA journal_mode = WAL")
                connection.execute("PRAGMA synchronous = FULL")
                connection.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS schema_migrations (
                        version INTEGER PRIMARY KEY,
                        applied_at_ns INTEGER NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS experiment_runs (
                        run_id TEXT PRIMARY KEY,
                        status TEXT NOT NULL,
                        payload TEXT NOT NULL,
                        created_at_ns INTEGER NOT NULL,
                        updated_at_ns INTEGER NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS run_attempts (
                        attempt_id TEXT PRIMARY KEY,
                        run_id TEXT NOT NULL REFERENCES experiment_runs(run_id),
                        status TEXT NOT NULL,
                        payload TEXT NOT NULL,
                        created_at_ns INTEGER NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS event_counters (
                        run_id TEXT PRIMARY KEY REFERENCES experiment_runs(run_id),
                        next_sequence INTEGER NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS execution_events (
                        event_id TEXT PRIMARY KEY,
                        run_id TEXT NOT NULL REFERENCES experiment_runs(run_id),
                        attempt_id TEXT REFERENCES run_attempts(attempt_id),
                        sequence INTEGER NOT NULL,
                        kind TEXT NOT NULL,
                        timestamp_ns INTEGER NOT NULL,
                        payload TEXT NOT NULL,
                        UNIQUE(run_id, sequence)
                    );
                    CREATE TABLE IF NOT EXISTS dependency_edges (
                        edge_id TEXT PRIMARY KEY,
                        run_id TEXT NOT NULL REFERENCES experiment_runs(run_id),
                        from_ref TEXT NOT NULL,
                        to_ref TEXT NOT NULL,
                        kind TEXT NOT NULL,
                        payload TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS artifacts (
                        artifact_id TEXT PRIMARY KEY,
                        run_id TEXT NOT NULL REFERENCES experiment_runs(run_id),
                        sha256 TEXT NOT NULL,
                        path TEXT NOT NULL,
                        payload TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS goals (
                        goal_id TEXT PRIMARY KEY,
                        run_id TEXT REFERENCES experiment_runs(run_id),
                        payload TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS faults (
                        fault_id TEXT PRIMARY KEY,
                        run_id TEXT NOT NULL REFERENCES experiment_runs(run_id),
                        record_type TEXT NOT NULL,
                        payload TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS diagnoses (
                        diagnosis_id TEXT PRIMARY KEY,
                        run_id TEXT NOT NULL REFERENCES experiment_runs(run_id),
                        payload TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS recovery_actions (
                        recovery_id TEXT PRIMARY KEY,
                        run_id TEXT NOT NULL REFERENCES experiment_runs(run_id),
                        idempotency_key TEXT,
                        payload TEXT NOT NULL,
                        UNIQUE(run_id, idempotency_key)
                    );
                    CREATE TABLE IF NOT EXISTS verifications (
                        verification_id TEXT PRIMARY KEY,
                        run_id TEXT NOT NULL REFERENCES experiment_runs(run_id),
                        decision TEXT NOT NULL,
                        payload TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS leases (
                        run_id TEXT PRIMARY KEY REFERENCES experiment_runs(run_id),
                        holder TEXT NOT NULL,
                        expires_at_ns INTEGER NOT NULL,
                        heartbeat_at_ns INTEGER NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_events_run_sequence
                        ON execution_events(run_id, sequence);
                    CREATE INDEX IF NOT EXISTS idx_edges_run_target
                        ON dependency_edges(run_id, to_ref);
                    CREATE INDEX IF NOT EXISTS idx_runs_status
                        ON experiment_runs(status);
                    """
                )
                connection.execute(
                    "INSERT OR IGNORE INTO schema_migrations(version, applied_at_ns) VALUES(1, ?)",
                    (now_ns(),),
                )
                connection.execute(
                    """CREATE TABLE IF NOT EXISTS workflow_nodes (
                           node_id TEXT PRIMARY KEY,
                           run_id TEXT NOT NULL REFERENCES experiment_runs(run_id),
                           workflow_id TEXT NOT NULL,
                           payload TEXT NOT NULL
                       )"""
                )
                connection.execute(
                    """CREATE INDEX IF NOT EXISTS idx_workflow_nodes_run_workflow
                       ON workflow_nodes(run_id, workflow_id, node_id)"""
                )
                connection.execute(
                    "INSERT OR IGNORE INTO schema_migrations(version, applied_at_ns) VALUES(2, ?)",
                    (now_ns(),),
                )
                connection.execute(
                    """CREATE TABLE IF NOT EXISTS recovery_strategies (
                           strategy_id TEXT PRIMARY KEY,
                           signature TEXT NOT NULL,
                           recovery_kind TEXT NOT NULL,
                           payload TEXT NOT NULL,
                           UNIQUE(signature, recovery_kind)
                       )"""
                )
                connection.execute(
                    """CREATE INDEX IF NOT EXISTS idx_recovery_strategies_signature
                       ON recovery_strategies(signature)"""
                )
                connection.execute(
                    "INSERT OR IGNORE INTO schema_migrations(version, applied_at_ns) VALUES(3, ?)",
                    (now_ns(),),
                )
                connection.execute(
                    """CREATE TABLE IF NOT EXISTS workflow_node_results (
                           run_id TEXT NOT NULL REFERENCES experiment_runs(run_id),
                           workflow_id TEXT NOT NULL,
                           node_id TEXT NOT NULL,
                           status TEXT NOT NULL,
                           payload TEXT NOT NULL,
                           PRIMARY KEY(run_id, workflow_id, node_id)
                       )"""
                )
                connection.execute(
                    """CREATE INDEX IF NOT EXISTS idx_workflow_results_status
                       ON workflow_node_results(run_id, workflow_id, status, node_id)"""
                )
                connection.execute(
                    "INSERT OR IGNORE INTO schema_migrations(version, applied_at_ns) VALUES(4, ?)",
                    (now_ns(),),
                )
                migrated_v5 = connection.execute(
                    "SELECT 1 FROM schema_migrations WHERE version = 5"
                ).fetchone()
                if migrated_v5 is None:
                    connection.commit()
                    connection.execute("BEGIN IMMEDIATE")
                    try:
                        connection.execute(
                            "ALTER TABLE workflow_nodes RENAME TO workflow_nodes_v4"
                        )
                        connection.execute(
                            """CREATE TABLE workflow_nodes (
                                   node_id TEXT NOT NULL,
                                   run_id TEXT NOT NULL REFERENCES experiment_runs(run_id),
                                   workflow_id TEXT NOT NULL,
                                   payload TEXT NOT NULL,
                                   PRIMARY KEY(run_id, workflow_id, node_id)
                               )"""
                        )
                        connection.execute(
                            """INSERT INTO workflow_nodes
                                   (node_id, run_id, workflow_id, payload)
                               SELECT node_id, run_id, workflow_id, payload
                               FROM workflow_nodes_v4"""
                        )
                        connection.execute("DROP TABLE workflow_nodes_v4")
                        connection.execute(
                            """CREATE INDEX idx_workflow_nodes_run_workflow
                               ON workflow_nodes(run_id, workflow_id, node_id)"""
                        )
                        connection.execute(
                            """INSERT INTO schema_migrations(version, applied_at_ns)
                               VALUES(5, ?)""",
                            (now_ns(),),
                        )
                    except Exception:
                        connection.rollback()
                        raise
                    else:
                        connection.commit()
                connection.commit()
            finally:
                connection.close()

    def create_run(self, run: ExperimentRun) -> ExperimentRun:
        run.validate()
        connection = self._connect()
        try:
            with connection:
                connection.execute(
                    """INSERT INTO experiment_runs
                       (run_id, status, payload, created_at_ns, updated_at_ns)
                       VALUES (?, ?, ?, ?, ?)""",
                    (
                        run.run_id,
                        run.status.value,
                        _payload(run),
                        run.created_at_ns,
                        run.updated_at_ns,
                    ),
                )
                connection.execute(
                    "INSERT INTO event_counters(run_id, next_sequence) VALUES (?, 1)",
                    (run.run_id,),
                )
            return run
        except sqlite3.IntegrityError as exc:
            raise StateConflictError(f"run {run.run_id!r} already exists") from exc
        finally:
            connection.close()

    def get_run(self, run_id: str) -> ExperimentRun:
        connection = self._connect()
        try:
            row = connection.execute(
                "SELECT payload FROM experiment_runs WHERE run_id = ?", (run_id,)
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            raise RunNotFoundError(run_id)
        return ExperimentRun.from_dict(json.loads(row["payload"]))

    def list_runs(self, statuses: Iterable[RunStatus] | None = None) -> list[ExperimentRun]:
        """List durable runs in creation order, optionally filtered by status."""

        connection = self._connect()
        try:
            status_values = tuple(status.value for status in (statuses or ()))
            if status_values:
                placeholders = ",".join("?" for _ in status_values)
                rows = connection.execute(
                    f"""SELECT payload FROM experiment_runs
                        WHERE status IN ({placeholders})
                        ORDER BY created_at_ns, run_id""",
                    status_values,
                ).fetchall()
            else:
                rows = connection.execute(
                    """SELECT payload FROM experiment_runs
                       ORDER BY created_at_ns, run_id"""
                ).fetchall()
        finally:
            connection.close()
        return [ExperimentRun.from_dict(json.loads(row["payload"])) for row in rows]

    def extend_run_budget(
        self,
        run_id: str,
        *,
        additional_attempts: int,
        additional_duration_seconds: float,
    ) -> ExperimentRun:
        """Extend a resumable run without changing its identity or evidence chain."""

        if additional_attempts < 1:
            raise ValueError("additional_attempts must be positive")
        if additional_duration_seconds <= 0:
            raise ValueError("additional_duration_seconds must be positive")
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT status, payload FROM experiment_runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if row is None:
                raise RunNotFoundError(run_id)
            current = ExperimentRun.from_dict(json.loads(row["payload"]))
            if current.status not in {
                RunStatus.RUNNING,
                RunStatus.PAUSED,
                RunStatus.WAITING_APPROVAL,
            }:
                raise StateConflictError(
                    f"run {run_id} cannot extend from {current.status.value}"
                )
            budget = dataclasses.replace(
                current.budget,
                max_turns=current.budget.max_turns + additional_attempts,
                max_attempts=current.budget.max_attempts + additional_attempts,
                max_recoveries_per_fault=(
                    current.budget.max_recoveries_per_fault + additional_attempts
                ),
                max_duration_seconds=(
                    current.budget.max_duration_seconds + additional_duration_seconds
                ),
            )
            updated = dataclasses.replace(
                current,
                budget=budget,
                updated_at_ns=now_ns(),
            )
            updated.validate()
            cursor = connection.execute(
                """UPDATE experiment_runs SET payload = ?, updated_at_ns = ?
                   WHERE run_id = ? AND status = ?""",
                (_payload(updated), updated.updated_at_ns, run_id, row["status"]),
            )
            if cursor.rowcount != 1:
                raise StateConflictError(f"concurrent budget update for run {run_id}")
            connection.commit()
            return updated
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def transition_run(
        self,
        run_id: str,
        expected_status: RunStatus,
        new_status: RunStatus,
        *,
        termination_reason: Optional[str] = None,
    ) -> ExperimentRun:
        if new_status not in _RUN_TRANSITIONS[expected_status]:
            raise StateConflictError(
                f"invalid run transition {expected_status.value} -> {new_status.value}"
            )
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT status, payload FROM experiment_runs WHERE run_id = ?", (run_id,)
            ).fetchone()
            if row is None:
                raise RunNotFoundError(run_id)
            if row["status"] != expected_status.value:
                raise StateConflictError(
                    f"run {run_id} is {row['status']}, expected {expected_status.value}"
                )
            current = ExperimentRun.from_dict(json.loads(row["payload"]))
            updated = dataclasses.replace(
                current,
                status=new_status,
                termination_reason=termination_reason,
                updated_at_ns=now_ns(),
            )
            cursor = connection.execute(
                """UPDATE experiment_runs SET status = ?, payload = ?, updated_at_ns = ?
                   WHERE run_id = ? AND status = ?""",
                (
                    new_status.value,
                    _payload(updated),
                    updated.updated_at_ns,
                    run_id,
                    expected_status.value,
                ),
            )
            if cursor.rowcount != 1:
                raise StateConflictError(f"concurrent transition for run {run_id}")
            connection.commit()
            return updated
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def begin_attempt(self, attempt: RunAttempt) -> RunAttempt:
        attempt.validate()
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT payload FROM experiment_runs WHERE run_id = ?", (attempt.run_id,)
            ).fetchone()
            if row is None:
                raise RunNotFoundError(attempt.run_id)
            run = ExperimentRun.from_dict(json.loads(row["payload"]))
            if run.status is not RunStatus.RUNNING:
                raise StateConflictError("attempts can start only for a running run")
            if run.current_attempt >= run.budget.max_attempts:
                raise StateConflictError("run attempt budget exhausted")
            connection.execute(
                """INSERT INTO run_attempts
                   (attempt_id, run_id, status, payload, created_at_ns)
                   VALUES (?, ?, ?, ?, ?)""",
                (
                    attempt.attempt_id,
                    attempt.run_id,
                    attempt.status.value,
                    _payload(attempt),
                    attempt.started_at_ns,
                ),
            )
            updated = dataclasses.replace(
                run,
                current_attempt=run.current_attempt + 1,
                updated_at_ns=now_ns(),
            )
            connection.execute(
                "UPDATE experiment_runs SET payload = ?, updated_at_ns = ? WHERE run_id = ?",
                (_payload(updated), updated.updated_at_ns, run.run_id),
            )
            connection.commit()
            return attempt
        except sqlite3.IntegrityError as exc:
            connection.rollback()
            raise StateConflictError(f"attempt {attempt.attempt_id!r} already exists") from exc
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def update_attempt_status(
        self,
        attempt_id: str,
        expected_status: AttemptStatus,
        new_status: AttemptStatus,
        *,
        termination_reason: Optional[str] = None,
    ) -> RunAttempt:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT status, payload FROM run_attempts WHERE attempt_id = ?",
                (attempt_id,),
            ).fetchone()
            if row is None:
                raise RunNotFoundError(attempt_id)
            if row["status"] != expected_status.value:
                raise StateConflictError(
                    f"attempt {attempt_id} is {row['status']}, expected {expected_status.value}"
                )
            attempt = RunAttempt.from_dict(json.loads(row["payload"]))
            updated = dataclasses.replace(
                attempt,
                status=new_status,
                finished_at_ns=now_ns() if new_status in {
                    AttemptStatus.SUCCEEDED,
                    AttemptStatus.FAILED,
                    AttemptStatus.ABORTED,
                } else None,
                termination_reason=termination_reason,
            )
            connection.execute(
                "UPDATE run_attempts SET status = ?, payload = ? WHERE attempt_id = ?",
                (new_status.value, _payload(updated), attempt_id),
            )
            connection.commit()
            return updated
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def list_attempts(self, run_id: str) -> list[RunAttempt]:
        """Return the run's attempts in durable creation order."""

        connection = self._connect()
        try:
            if connection.execute(
                "SELECT 1 FROM experiment_runs WHERE run_id = ?", (run_id,)
            ).fetchone() is None:
                raise RunNotFoundError(run_id)
            rows = connection.execute(
                """SELECT payload FROM run_attempts WHERE run_id = ?
                   ORDER BY created_at_ns, attempt_id""",
                (run_id,),
            ).fetchall()
        finally:
            connection.close()
        return [RunAttempt.from_dict(json.loads(row["payload"])) for row in rows]

    def append_event(self, event: ExecutionEvent) -> ExecutionEvent:
        event.validate()
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            counter = connection.execute(
                "SELECT next_sequence FROM event_counters WHERE run_id = ?",
                (event.run_id,),
            ).fetchone()
            if counter is None:
                raise RunNotFoundError(event.run_id)
            sequence = event.sequence or int(counter["next_sequence"])
            if event.sequence and event.sequence < int(counter["next_sequence"]):
                raise StateConflictError("event sequence has already been allocated")
            stored = dataclasses.replace(event, sequence=sequence)
            connection.execute(
                """INSERT INTO execution_events
                   (event_id, run_id, attempt_id, sequence, kind, timestamp_ns, payload)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    stored.event_id,
                    stored.run_id,
                    stored.attempt_id,
                    stored.sequence,
                    stored.kind.value,
                    stored.timestamp_ns,
                    _payload(stored),
                ),
            )
            connection.execute(
                "UPDATE event_counters SET next_sequence = ? WHERE run_id = ?",
                (sequence + 1, stored.run_id),
            )
            connection.commit()
            return stored
        except sqlite3.IntegrityError as exc:
            connection.rollback()
            raise StateConflictError(f"duplicate event or sequence for {event.event_id}") from exc
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def list_events(self, run_id: str) -> list[ExecutionEvent]:
        connection = self._connect()
        try:
            rows = connection.execute(
                "SELECT payload FROM execution_events WHERE run_id = ? ORDER BY sequence",
                (run_id,),
            ).fetchall()
        finally:
            connection.close()
        return [ExecutionEvent.from_dict(json.loads(row["payload"])) for row in rows]

    def link_dependency(self, edge: DependencyEdge) -> DependencyEdge:
        edge.validate()
        connection = self._connect()
        try:
            with connection:
                if connection.execute(
                    "SELECT 1 FROM experiment_runs WHERE run_id = ?", (edge.run_id,)
                ).fetchone() is None:
                    raise RunNotFoundError(edge.run_id)
                for reference in (edge.from_ref, edge.to_ref):
                    owners = self._reference_run_ids(connection, reference)
                    if owners - {edge.run_id}:
                        raise StateConflictError(
                            f"reference {reference!r} belongs to another run"
                        )
                if edge.evidence_event_id is not None:
                    evidence = connection.execute(
                        "SELECT run_id FROM execution_events WHERE event_id = ?",
                        (edge.evidence_event_id,),
                    ).fetchone()
                    if evidence is None:
                        raise RunNotFoundError(edge.evidence_event_id)
                    if evidence["run_id"] != edge.run_id:
                        raise StateConflictError(
                            f"evidence event {edge.evidence_event_id!r} "
                            "belongs to another run"
                        )
                connection.execute(
                    """INSERT INTO dependency_edges
                       (edge_id, run_id, from_ref, to_ref, kind, payload)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (
                        edge.edge_id,
                        edge.run_id,
                        edge.from_ref,
                        edge.to_ref,
                        edge.kind.value,
                        _payload(edge),
                    ),
                )
            return edge
        except sqlite3.IntegrityError as exc:
            raise StateConflictError(f"dependency edge {edge.edge_id!r} already exists") from exc
        finally:
            connection.close()

    def put_workflow_node(self, node: WorkflowNode) -> WorkflowNode:
        """Persist one immutable node definition for a run's typed workflow."""

        node.validate()
        connection = self._connect()
        try:
            with connection:
                connection.execute(
                    """INSERT INTO workflow_nodes
                       (node_id, run_id, workflow_id, payload)
                       VALUES (?, ?, ?, ?)""",
                    (node.node_id, node.run_id, node.workflow_id, _payload(node)),
                )
            return node
        except sqlite3.IntegrityError as exc:
            if connection.execute(
                "SELECT 1 FROM experiment_runs WHERE run_id = ?", (node.run_id,)
            ).fetchone() is None:
                raise RunNotFoundError(node.run_id) from exc
            raise StateConflictError(
                f"workflow node {node.node_id!r} already exists"
            ) from exc
        finally:
            connection.close()

    def list_workflow_nodes(
        self,
        run_id: str,
        *,
        workflow_id: Optional[str] = None,
    ) -> list[WorkflowNode]:
        connection = self._connect()
        try:
            if connection.execute(
                "SELECT 1 FROM experiment_runs WHERE run_id = ?", (run_id,)
            ).fetchone() is None:
                raise RunNotFoundError(run_id)
            if workflow_id is None:
                rows = connection.execute(
                    """SELECT payload FROM workflow_nodes WHERE run_id = ?
                       ORDER BY workflow_id, node_id""",
                    (run_id,),
                ).fetchall()
            else:
                rows = connection.execute(
                    """SELECT payload FROM workflow_nodes
                       WHERE run_id = ? AND workflow_id = ? ORDER BY node_id""",
                    (run_id, workflow_id),
                ).fetchall()
        finally:
            connection.close()
        return [WorkflowNode.from_dict(json.loads(row["payload"])) for row in rows]

    def put_workflow_node_result(self, result: WorkflowNodeResult) -> WorkflowNodeResult:
        """Insert or replace the durable state of one workflow primitive."""

        result.validate()
        node = next(
            (
                item
                for item in self.list_workflow_nodes(
                    result.run_id, workflow_id=result.workflow_id
                )
                if item.node_id == result.node_id
            ),
            None,
        )
        if node is None:
            raise RunNotFoundError(result.node_id)
        connection = self._connect()
        try:
            with connection:
                connection.execute(
                    """INSERT INTO workflow_node_results
                       (run_id, workflow_id, node_id, status, payload)
                       VALUES (?, ?, ?, ?, ?)
                       ON CONFLICT(run_id, workflow_id, node_id) DO UPDATE SET
                           status = excluded.status,
                           payload = excluded.payload""",
                    (
                        result.run_id,
                        result.workflow_id,
                        result.node_id,
                        result.status.value,
                        _payload(result),
                    ),
                )
            return result
        finally:
            connection.close()

    def get_workflow_node_result(
        self, run_id: str, workflow_id: str, node_id: str
    ) -> Optional[WorkflowNodeResult]:
        connection = self._connect()
        try:
            row = connection.execute(
                """SELECT payload FROM workflow_node_results
                   WHERE run_id = ? AND workflow_id = ? AND node_id = ?""",
                (run_id, workflow_id, node_id),
            ).fetchone()
        finally:
            connection.close()
        return (
            WorkflowNodeResult.from_dict(json.loads(row["payload"]))
            if row is not None
            else None
        )

    def list_workflow_node_results(
        self, run_id: str, *, workflow_id: Optional[str] = None
    ) -> list[WorkflowNodeResult]:
        connection = self._connect()
        try:
            if workflow_id is None:
                rows = connection.execute(
                    """SELECT payload FROM workflow_node_results
                       WHERE run_id = ? ORDER BY workflow_id, node_id""",
                    (run_id,),
                ).fetchall()
            else:
                rows = connection.execute(
                    """SELECT payload FROM workflow_node_results
                       WHERE run_id = ? AND workflow_id = ? ORDER BY node_id""",
                    (run_id, workflow_id),
                ).fetchall()
        finally:
            connection.close()
        return [WorkflowNodeResult.from_dict(json.loads(row["payload"])) for row in rows]

    def list_dependency_edges(self, run_id: str) -> list[DependencyEdge]:
        """Return every dependency edge owned by ``run_id`` in stable order."""

        connection = self._connect()
        try:
            if connection.execute(
                "SELECT 1 FROM experiment_runs WHERE run_id = ?", (run_id,)
            ).fetchone() is None:
                raise RunNotFoundError(run_id)
            rows = connection.execute(
                """SELECT payload FROM dependency_edges WHERE run_id = ?
                   ORDER BY from_ref, to_ref, kind, edge_id""",
                (run_id,),
            ).fetchall()
        finally:
            connection.close()
        return [DependencyEdge.from_dict(json.loads(row["payload"])) for row in rows]

    def list_dependencies(self, run_id: str) -> list[DependencyEdge]:
        """Backward-compatible name for :meth:`list_dependency_edges`."""

        return self.list_dependency_edges(run_id)

    def dependency_adjacency(self, run_id: str) -> dict[str, tuple[str, ...]]:
        """Return the run-local outgoing adjacency map in deterministic order.

        Nodes with only incoming edges are included with an empty neighbor tuple.
        Parallel typed edges are collapsed because this view describes reachability;
        callers needing edge kinds or evidence should use ``list_dependency_edges``.
        """

        edges = self.list_dependency_edges(run_id)
        nodes = {edge.from_ref for edge in edges} | {edge.to_ref for edge in edges}
        outgoing: dict[str, set[str]] = {node: set() for node in nodes}
        for edge in edges:
            outgoing[edge.from_ref].add(edge.to_ref)
        return {
            node: tuple(sorted(outgoing[node]))
            for node in sorted(nodes)
        }

    def list_ancestor_paths(
        self,
        run_id: str,
        target_ref: str,
        *,
        ancestor_ref: Optional[str] = None,
    ) -> list[tuple[str, ...]]:
        """Return deterministic simple paths from ancestors to ``target_ref``.

        With ``ancestor_ref`` omitted, paths start at every reachable graph root.
        With it supplied, only paths beginning at that reference are returned.
        Cycles are bounded by simple-path traversal and can never recurse forever.
        Unknown references fail with ``RunNotFoundError``; references known only to
        another run fail with ``StateConflictError`` instead of leaking its graph.
        """

        edges = self.list_dependency_edges(run_id)
        graph_refs = {edge.from_ref for edge in edges} | {
            edge.to_ref for edge in edges
        }
        self._require_run_reference(run_id, target_ref, graph_refs)
        if ancestor_ref is not None:
            self._require_run_reference(run_id, ancestor_ref, graph_refs)

        parents: dict[str, set[str]] = {}
        for edge in edges:
            parents.setdefault(edge.to_ref, set()).add(edge.from_ref)

        paths: list[tuple[str, ...]] = []

        def visit(node: str, reverse_path: tuple[str, ...]) -> None:
            if ancestor_ref is not None and node == ancestor_ref:
                paths.append(tuple(reversed(reverse_path)))
                return
            candidates = sorted(parents.get(node, ()))
            if ancestor_ref is None and not candidates:
                paths.append(tuple(reversed(reverse_path)))
                return
            for parent in candidates:
                if parent not in reverse_path:
                    visit(parent, reverse_path + (parent,))

        visit(target_ref, (target_ref,))
        return sorted(set(paths))

    def put_artifact(
        self,
        run_id: str,
        data: bytes,
        *,
        role: str,
        media_type: str = "application/octet-stream",
        producer_event_id: Optional[str] = None,
        source_artifact_ids: Iterable[str] = (),
        metadata: Optional[dict[str, Any]] = None,
    ) -> ArtifactRecord:
        digest = hashlib.sha256(data).hexdigest()
        artifact_path = self.artifact_dir / digest
        if not artifact_path.exists():
            descriptor, temporary_path = tempfile.mkstemp(
                prefix=f".{digest}.", dir=self.artifact_dir
            )
            try:
                with os.fdopen(descriptor, "wb") as handle:
                    handle.write(data)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary_path, artifact_path)
            finally:
                if os.path.exists(temporary_path):
                    os.unlink(temporary_path)
        record = ArtifactRecord(
            artifact_id=new_id("artifact"),
            run_id=run_id,
            sha256=digest,
            size_bytes=len(data),
            role=role,
            path_or_uri=str(artifact_path),
            media_type=media_type,
            producer_event_id=producer_event_id,
            source_artifact_ids=tuple(source_artifact_ids),
            metadata=dict(metadata or {}),
        )
        connection = self._connect()
        try:
            with connection:
                connection.execute(
                    """INSERT INTO artifacts
                       (artifact_id, run_id, sha256, path, payload)
                       VALUES (?, ?, ?, ?, ?)""",
                    (
                        record.artifact_id,
                        run_id,
                        digest,
                        str(artifact_path),
                        _payload(record),
                    ),
                )
            return record
        except sqlite3.IntegrityError as exc:
            raise RunNotFoundError(run_id) from exc
        finally:
            connection.close()

    def get_artifact(self, artifact_id: str) -> ArtifactRecord:
        return self._get_contract("artifacts", "artifact_id", artifact_id, ArtifactRecord)

    def upsert_goal(self, goal: GoalSpec, *, run_id: Optional[str] = None) -> GoalSpec:
        goal.validate()
        connection = self._connect()
        try:
            with connection:
                connection.execute(
                    """INSERT INTO goals(goal_id, run_id, payload) VALUES (?, ?, ?)
                       ON CONFLICT(goal_id) DO UPDATE SET run_id=excluded.run_id,
                       payload=excluded.payload""",
                    (goal.goal_id, run_id, _payload(goal)),
                )
            return goal
        finally:
            connection.close()

    def get_goal_for_run(self, run_id: str) -> GoalSpec:
        """Return the single durable goal attached to a Harness run."""

        connection = self._connect()
        try:
            rows = connection.execute(
                "SELECT payload FROM goals WHERE run_id = ? ORDER BY goal_id",
                (run_id,),
            ).fetchall()
        finally:
            connection.close()
        if not rows:
            raise RunNotFoundError(f"goal for {run_id}")
        if len(rows) != 1:
            raise StateConflictError(f"run {run_id} has multiple goals")
        return GoalSpec.from_dict(json.loads(rows[0]["payload"]))

    def record_fault(self, fault: FaultSpec | FaultObservation) -> FaultSpec | FaultObservation:
        fault.validate()
        fault_id = fault.fault_id if isinstance(fault, FaultSpec) else fault.observation_id
        connection = self._connect()
        try:
            with connection:
                connection.execute(
                    "INSERT INTO faults(fault_id, run_id, record_type, payload) VALUES (?, ?, ?, ?)",
                    (fault_id, fault.run_id, type(fault).__name__, _payload(fault)),
                )
            return fault
        except sqlite3.IntegrityError as exc:
            raise StateConflictError(f"fault record {fault_id!r} already exists") from exc
        finally:
            connection.close()

    def record_diagnosis(self, diagnosis: Diagnosis) -> Diagnosis:
        return self._insert_contract(
            "diagnoses", "diagnosis_id", diagnosis.diagnosis_id,
            diagnosis.run_id, diagnosis
        )

    def record_recovery(self, recovery: RecoveryAction) -> RecoveryAction:
        recovery.validate()
        connection = self._connect()
        try:
            with connection:
                connection.execute(
                    """INSERT INTO recovery_actions
                       (recovery_id, run_id, idempotency_key, payload)
                       VALUES (?, ?, ?, ?)""",
                    (
                        recovery.recovery_id,
                        recovery.run_id,
                        recovery.idempotency_key,
                        _payload(recovery),
                    ),
                )
            return recovery
        except sqlite3.IntegrityError as exc:
            raise StateConflictError(
                "duplicate recovery id or idempotency key"
            ) from exc
        finally:
            connection.close()

    def promote_recovery_strategy(
        self,
        signature: str,
        recovery: RecoveryAction,
        verification: VerificationResult,
    ) -> RecoveryStrategy:
        """Promote evidence-backed recovery knowledge across runs.

        Callers cannot promote a model assertion or an unverified attempt: the
        referenced recovery and accepted verification must already be durable,
        correlated, and belong to a run whose terminal status is ``succeeded``.
        """

        normalized = signature.strip()
        if not normalized:
            raise ValueError("strategy signature is required")
        recovery.validate()
        verification.validate()
        if verification.decision.value != "accept":
            raise StateConflictError(
                "only accepted verification can promote a strategy"
            )
        if verification.comparable_to_baseline and any(
            str(difference).lower().startswith("regression:")
            for difference in verification.differences
        ):
            raise StateConflictError(
                "verification contains a baseline regression"
            )
        if recovery.run_id != verification.run_id:
            raise StateConflictError(
                "recovery and verification belong to different runs"
            )
        if verification.recovery_id != recovery.recovery_id:
            raise StateConflictError("verification does not attest this recovery")
        if self.get_run(recovery.run_id).status is not RunStatus.SUCCEEDED:
            raise StateConflictError("strategy source run is not succeeded")
        stored_recovery = self._get_contract(
            "recovery_actions",
            "recovery_id",
            recovery.recovery_id,
            RecoveryAction,
        )
        stored_verification = self._get_contract(
            "verifications",
            "verification_id",
            verification.verification_id,
            VerificationResult,
        )
        if stored_recovery.run_id != recovery.run_id:
            raise StateConflictError("stored recovery correlation is invalid")
        if stored_recovery.to_dict() != recovery.to_dict():
            raise StateConflictError("recovery differs from durable evidence")
        if stored_verification.to_dict() != verification.to_dict():
            raise StateConflictError("verification differs from durable evidence")
        if stored_verification.recovery_id != recovery.recovery_id:
            raise StateConflictError("stored verification correlation is invalid")
        if (
            stored_recovery.requires_approval
            and stored_recovery.risk.lower() not in {"low", "none"}
        ):
            approvals = [
                event
                for event in self.list_events(recovery.run_id)
                if event.kind.value == "approval"
                and event.payload.get("recovery_id") == recovery.recovery_id
                and event.payload.get("decision") == "approved"
            ]
            if not approvals:
                raise StateConflictError(
                    "non-low-risk strategy needs a durable approval event"
                )

        connection = self._connect()
        try:
            with connection:
                row = connection.execute(
                    """SELECT payload FROM recovery_strategies
                       WHERE signature = ? AND recovery_kind = ?""",
                    (normalized, recovery.kind.value),
                ).fetchone()
                if row is None:
                    strategy = RecoveryStrategy(
                        strategy_id=new_id("strategy"),
                        signature=normalized,
                        recovery_kind=recovery.kind,
                        source_run_id=recovery.run_id,
                        source_recovery_id=recovery.recovery_id,
                        source_verification_id=verification.verification_id,
                    )
                    strategy.validate()
                    connection.execute(
                        """INSERT INTO recovery_strategies
                           (strategy_id, signature, recovery_kind, payload)
                           VALUES (?, ?, ?, ?)""",
                        (
                            strategy.strategy_id,
                            strategy.signature,
                            strategy.recovery_kind.value,
                            _payload(strategy),
                        ),
                    )
                else:
                    previous = RecoveryStrategy.from_dict(json.loads(row["payload"]))
                    strategy = dataclasses.replace(
                        previous,
                        source_run_id=recovery.run_id,
                        source_recovery_id=recovery.recovery_id,
                        source_verification_id=verification.verification_id,
                        success_count=previous.success_count + 1,
                        consecutive_failures=0,
                        disabled=False,
                        last_failure_run_id=None,
                        promoted_at_ns=now_ns(),
                    )
                    strategy.validate()
                    connection.execute(
                        """UPDATE recovery_strategies SET payload = ?
                           WHERE strategy_id = ?""",
                        (_payload(strategy), strategy.strategy_id),
                    )
                return strategy
        finally:
            connection.close()

    def list_recovery_strategies(
        self,
        signature: Optional[str] = None,
    ) -> list[RecoveryStrategy]:
        connection = self._connect()
        try:
            if signature is None:
                rows = connection.execute(
                    "SELECT payload FROM recovery_strategies"
                ).fetchall()
            else:
                rows = connection.execute(
                    """SELECT payload FROM recovery_strategies
                       WHERE signature = ?""",
                    (signature.strip(),),
                ).fetchall()
            strategies = [
                RecoveryStrategy.from_dict(json.loads(row["payload"])) for row in rows
            ]
            return sorted(
                strategies,
                key=lambda item: (
                    -(
                        item.success_count
                        / (item.success_count + item.failure_count)
                    ),
                    -item.success_count,
                    item.failure_count,
                    item.strategy_id,
                ),
            )
        finally:
            connection.close()

    def select_recovery_strategy(
        self,
        signature: str,
    ) -> Optional[RecoveryStrategy]:
        strategies = [
            strategy
            for strategy in self.list_recovery_strategies(signature)
            if not strategy.disabled
        ]
        return strategies[0] if strategies else None

    def record_recovery_strategy_failure(
        self,
        strategy_id: str,
        run_id: str,
        *,
        disable_after: int = 2,
    ) -> RecoveryStrategy:
        """Down-rank and eventually disable a strategy after verified failure."""

        if disable_after < 1:
            raise ValueError("disable_after must be positive")
        run = self.get_run(run_id)
        if run.status not in {RunStatus.FAILED, RunStatus.PAUSED, RunStatus.ABORTED}:
            raise StateConflictError("strategy failure needs a non-success terminal run")
        connection = self._connect()
        try:
            with connection:
                row = connection.execute(
                    "SELECT payload FROM recovery_strategies WHERE strategy_id = ?",
                    (strategy_id,),
                ).fetchone()
                if row is None:
                    raise RunNotFoundError(strategy_id)
                previous = RecoveryStrategy.from_dict(json.loads(row["payload"]))
                failures = previous.consecutive_failures + 1
                updated = dataclasses.replace(
                    previous,
                    failure_count=previous.failure_count + 1,
                    consecutive_failures=failures,
                    disabled=failures >= disable_after,
                    last_failure_run_id=run_id,
                )
                updated.validate()
                connection.execute(
                    "UPDATE recovery_strategies SET payload = ? WHERE strategy_id = ?",
                    (_payload(updated), strategy_id),
                )
                return updated
        finally:
            connection.close()

    def record_verification(self, verification: VerificationResult) -> VerificationResult:
        verification.validate()
        connection = self._connect()
        try:
            with connection:
                connection.execute(
                    """INSERT INTO verifications
                       (verification_id, run_id, decision, payload)
                       VALUES (?, ?, ?, ?)""",
                    (
                        verification.verification_id,
                        verification.run_id,
                        verification.decision.value,
                        _payload(verification),
                    ),
                )
            return verification
        except sqlite3.IntegrityError as exc:
            raise StateConflictError(
                f"verification {verification.verification_id!r} already exists"
            ) from exc
        finally:
            connection.close()

    def acquire_lease(self, run_id: str, holder: str, ttl_seconds: float = 30.0) -> None:
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be positive")
        current = now_ns()
        expires = current + int(ttl_seconds * 1_000_000_000)
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT holder, expires_at_ns FROM leases WHERE run_id = ?", (run_id,)
            ).fetchone()
            if row and row["holder"] != holder and row["expires_at_ns"] > current:
                raise LeaseConflictError(
                    f"run {run_id} is leased by {row['holder']}"
                )
            connection.execute(
                """INSERT INTO leases(run_id, holder, expires_at_ns, heartbeat_at_ns)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(run_id) DO UPDATE SET holder=excluded.holder,
                   expires_at_ns=excluded.expires_at_ns,
                   heartbeat_at_ns=excluded.heartbeat_at_ns""",
                (run_id, holder, expires, current),
            )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def heartbeat(self, run_id: str, holder: str, ttl_seconds: float = 30.0) -> None:
        current = now_ns()
        expires = current + int(ttl_seconds * 1_000_000_000)
        connection = self._connect()
        try:
            with connection:
                cursor = connection.execute(
                    """UPDATE leases SET expires_at_ns = ?, heartbeat_at_ns = ?
                       WHERE run_id = ? AND holder = ? AND expires_at_ns > ?""",
                    (expires, current, run_id, holder, current),
                )
                if cursor.rowcount != 1:
                    raise LeaseConflictError("lease is missing, expired, or owned elsewhere")
        finally:
            connection.close()

    def release_lease(self, run_id: str, holder: str) -> None:
        connection = self._connect()
        try:
            with connection:
                connection.execute(
                    "DELETE FROM leases WHERE run_id = ? AND holder = ?",
                    (run_id, holder),
                )
        finally:
            connection.close()

    def list_resumable_runs(self) -> list[ExperimentRun]:
        statuses = (
            RunStatus.RUNNING.value,
            RunStatus.WAITING_APPROVAL.value,
            RunStatus.PAUSED.value,
        )
        connection = self._connect()
        try:
            rows = connection.execute(
                """SELECT payload FROM experiment_runs
                   WHERE status IN (?, ?, ?) ORDER BY updated_at_ns""",
                statuses,
            ).fetchall()
        finally:
            connection.close()
        return [ExperimentRun.from_dict(json.loads(row["payload"])) for row in rows]

    def export_run(self, run_id: str) -> dict[str, Any]:
        """Return a complete, portable, deterministic, redacted evidence bundle.

        The bundle deliberately contains artifact metadata and content digests but
        neither artifact bytes nor machine-local artifact paths.  A single SQLite
        read transaction provides a coherent snapshot while a run is still active.
        """

        connection = self._connect()
        try:
            connection.execute("BEGIN")
            run_row = connection.execute(
                "SELECT payload FROM experiment_runs WHERE run_id = ?", (run_id,)
            ).fetchone()
            if run_row is None:
                raise RunNotFoundError(run_id)

            def payloads(query: str) -> list[dict[str, Any]]:
                return [
                    json.loads(row["payload"])
                    for row in connection.execute(query, (run_id,)).fetchall()
                ]

            attempts = payloads(
                """SELECT payload FROM run_attempts WHERE run_id = ?
                   ORDER BY created_at_ns, attempt_id"""
            )
            events = payloads(
                """SELECT payload FROM execution_events WHERE run_id = ?
                   ORDER BY sequence, event_id"""
            )
            edges = payloads(
                """SELECT payload FROM dependency_edges WHERE run_id = ?
                   ORDER BY from_ref, to_ref, kind, edge_id"""
            )
            workflow_nodes = payloads(
                """SELECT payload FROM workflow_nodes WHERE run_id = ?
                   ORDER BY workflow_id, node_id"""
            )
            artifact_records = payloads(
                """SELECT payload FROM artifacts WHERE run_id = ?
                   ORDER BY artifact_id"""
            )
            artifacts = []
            for record in artifact_records:
                portable = dict(record)
                portable.pop("path_or_uri", None)
                portable["content_address"] = f"sha256:{portable['sha256']}"
                artifacts.append(portable)
            goals = payloads(
                "SELECT payload FROM goals WHERE run_id = ? ORDER BY goal_id"
            )
            faults = [
                {
                    "record_type": row["record_type"],
                    "record": json.loads(row["payload"]),
                }
                for row in connection.execute(
                    """SELECT record_type, payload FROM faults WHERE run_id = ?
                       ORDER BY fault_id""",
                    (run_id,),
                ).fetchall()
            ]
            diagnoses = payloads(
                """SELECT payload FROM diagnoses WHERE run_id = ?
                   ORDER BY diagnosis_id"""
            )
            recoveries = payloads(
                """SELECT payload FROM recovery_actions WHERE run_id = ?
                   ORDER BY recovery_id"""
            )
            verifications = payloads(
                """SELECT payload FROM verifications WHERE run_id = ?
                   ORDER BY verification_id"""
            )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

        return _redact(
            {
                "export_schema_version": SCHEMA_VERSION,
                "run": json.loads(run_row["payload"]),
                "attempts": attempts,
                "events": events,
                "dependency_edges": edges,
                "workflow_nodes": workflow_nodes,
                "artifacts": artifacts,
                "goals": goals,
                "faults": faults,
                "diagnoses": diagnoses,
                "recoveries": recoveries,
                "verifications": verifications,
            }
        )

    def export_run_jsonl(self, run_id: str) -> str:
        """Serialize the portable evidence bundle as deterministic JSON Lines."""

        bundle = self.export_run(run_id)
        records = [
            {
                "export_schema_version": bundle["export_schema_version"],
                "record_type": "run",
                "record": bundle["run"],
            }
        ]
        for section in (
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
        ):
            for record in bundle[section]:
                records.append(
                    {
                        "export_schema_version": bundle["export_schema_version"],
                        "record_type": section,
                        "record": record,
                    }
                )
        return "".join(
            json.dumps(
                record,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n"
            for record in records
        )

    def _require_run_reference(
        self,
        run_id: str,
        reference: str,
        graph_refs: set[str],
    ) -> None:
        if reference in graph_refs:
            return
        connection = self._connect()
        try:
            owners = self._reference_run_ids(connection, reference)
        finally:
            connection.close()
        if owners - {run_id}:
            raise StateConflictError(
                f"reference {reference!r} belongs to another run"
            )
        if not owners:
            raise RunNotFoundError(reference)

    @staticmethod
    def _reference_run_ids(
        connection: sqlite3.Connection,
        reference: str,
    ) -> set[str]:
        """Resolve typed records and existing graph nodes to their owning runs."""

        lookups = (
            ("experiment_runs", "run_id"),
            ("run_attempts", "attempt_id"),
            ("execution_events", "event_id"),
            ("artifacts", "artifact_id"),
            ("goals", "goal_id"),
            ("faults", "fault_id"),
            ("diagnoses", "diagnosis_id"),
            ("recovery_actions", "recovery_id"),
            ("verifications", "verification_id"),
            ("workflow_nodes", "node_id"),
        )
        owners: set[str] = set()
        for table, id_column in lookups:
            rows = connection.execute(
                f"SELECT run_id FROM {table} WHERE {id_column} = ?",
                (reference,),
            ).fetchall()
            owners.update(row["run_id"] for row in rows if row["run_id"] is not None)
        graph_rows = connection.execute(
            """SELECT run_id FROM dependency_edges
               WHERE from_ref = ? OR to_ref = ?""",
            (reference, reference),
        ).fetchall()
        owners.update(row["run_id"] for row in graph_rows)
        return owners

    def _insert_contract(
        self,
        table: str,
        id_column: str,
        contract_id: str,
        run_id: str,
        contract: TContract,
    ) -> TContract:
        contract.validate()
        connection = self._connect()
        try:
            with connection:
                connection.execute(
                    f"INSERT INTO {table}({id_column}, run_id, payload) VALUES (?, ?, ?)",
                    (contract_id, run_id, _payload(contract)),
                )
            return contract
        except sqlite3.IntegrityError as exc:
            raise StateConflictError(f"{table} record {contract_id!r} already exists") from exc
        finally:
            connection.close()

    def _get_contract(
        self,
        table: str,
        id_column: str,
        contract_id: str,
        contract_type: type[TContract],
    ) -> TContract:
        connection = self._connect()
        try:
            row = connection.execute(
                f"SELECT payload FROM {table} WHERE {id_column} = ?", (contract_id,)
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            raise RunNotFoundError(contract_id)
        return contract_type.from_dict(json.loads(row["payload"]))
