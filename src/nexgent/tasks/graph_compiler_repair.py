"""Bounded repair loop for model-proposed task-time graph revisions.

The loop owns deterministic compilation only.  The runtime supplies callbacks
for package/capability materialization and for durable model RPCs, keeping host
permissions and transport policy outside this module.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
import re

from .orchestration import NodeStatus, PlanExecution, PlanRevision
from .pending_graph_patch import (
    MAX_PENDING_GRAPH_PATCH_BYTES,
    PendingGraphPatch,
    apply_graph_ops,
    compile_pending_graph_patch,
)
from .tools import ContractError
from .workflows import WorkflowError, plan_from_workflow


GRAPH_REPAIR_REQUEST_SCHEMA = "nexgent.graph-compiler-repair-request.v1"
MAX_GRAPH_COMPILE_ATTEMPTS = 8
_RETRYABLE_COMPILER_ERRORS = (ContractError, WorkflowError, PermissionError)
_IDENTIFIER = re.compile(r"[a-z][a-z0-9_.-]{0,99}")


def _snapshot(value, label: str):
    try:
        payload = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    except (TypeError, ValueError, RecursionError) as exc:
        raise ContractError(f"{label} must be finite JSON: {exc}") from None
    if len(payload.encode("utf-8")) > MAX_PENDING_GRAPH_PATCH_BYTES:
        raise ContractError(f"{label} exceeds its text budget")
    return json.loads(payload)


@dataclass(frozen=True)
class GraphCompilerDiagnostic:
    attempt: int
    stage: str
    error_type: str
    message: str

    def __post_init__(self):
        if type(self.attempt) is not int or self.attempt < 1:
            raise ContractError("Graph compiler diagnostic attempt must be positive")
        if self.stage not in {"proposal", "materialize", "plan_revision"}:
            raise ContractError("Graph compiler diagnostic stage is invalid")
        for value, label, maximum in (
            (self.error_type, "error_type", 120),
            (self.message, "message", 800),
        ):
            if not isinstance(value, str) or not value.strip() or len(value) > maximum:
                raise ContractError(f"Graph compiler diagnostic {label} is invalid")

    def as_dict(self) -> dict:
        return {
            "attempt": self.attempt,
            "stage": self.stage,
            "error_type": self.error_type,
            "message": self.message,
        }


class GraphRepairExhausted(ContractError):
    """All configured compiler attempts failed with repairable diagnostics."""

    def __init__(self, diagnostics):
        values = tuple(diagnostics)
        if not values or any(not isinstance(item, GraphCompilerDiagnostic) for item in values):
            raise ContractError("Graph repair exhaustion requires compiler diagnostics")
        self.diagnostics = values
        super().__init__(
            f"Graph compiler repair exhausted after {len(values)} attempts: "
            f"{values[-1].message}"
        )

    def as_dict(self) -> dict:
        return {
            "status": "exhausted",
            "diagnostics": [item.as_dict() for item in self.diagnostics],
        }


@dataclass(frozen=True, init=False)
class GraphRepairResult:
    revision: PlanRevision
    attempt_count: int
    diagnostics: tuple[GraphCompilerDiagnostic, ...]
    _workflow_json: str = field(repr=False)
    _proposal_json: str = field(repr=False)

    def __init__(self, revision, attempt_count, diagnostics, revised_workflow,
                 accepted_proposal):
        if not isinstance(revision, PlanRevision):
            raise ContractError("Graph repair result requires a PlanRevision")
        if type(attempt_count) is not int or attempt_count < 1:
            raise ContractError("Graph repair result attempt_count must be positive")
        diagnostic_values = tuple(diagnostics)
        if any(not isinstance(item, GraphCompilerDiagnostic)
               for item in diagnostic_values):
            raise ContractError("Graph repair result diagnostics are invalid")
        workflow = _snapshot(revised_workflow, "Revised workflow")
        proposal = _snapshot(accepted_proposal, "Accepted graph proposal")
        if not isinstance(workflow, dict) or not isinstance(proposal, dict):
            raise ContractError("Graph repair result values must be objects")
        object.__setattr__(self, "revision", revision)
        object.__setattr__(self, "attempt_count", attempt_count)
        object.__setattr__(self, "diagnostics", diagnostic_values)
        object.__setattr__(self, "_workflow_json", json.dumps(
            workflow, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        object.__setattr__(self, "_proposal_json", json.dumps(
            proposal, ensure_ascii=False, sort_keys=True, separators=(",", ":")))

    @property
    def revised_workflow(self) -> dict:
        return json.loads(self._workflow_json)

    @property
    def accepted_proposal(self) -> dict:
        return json.loads(self._proposal_json)

    def as_dict(self) -> dict:
        return {
            "attempt_count": self.attempt_count,
            "diagnostics": [item.as_dict() for item in self.diagnostics],
            "accepted_proposal": self.accepted_proposal,
            "revised_workflow": self.revised_workflow,
            "revision": self.revision.as_dict(),
        }


def _candidate_workflow(base_workflow, proposal):
    has_full = "revised_workflow" in proposal
    has_ops = "operations" in proposal
    if has_full == has_ops:
        raise ContractError(
            "Graph proposal must contain exactly one of revised_workflow or operations"
        )
    if has_full:
        candidate = proposal["revised_workflow"]
        if not isinstance(candidate, dict):
            raise ContractError("Graph proposal revised_workflow must be an object")
        return _snapshot(candidate, "Proposed revised workflow")
    graph_ops = {
        key: proposal[key]
        for key in (
            "operations", "outputs", "revision_rules",
            "strategy_checkpoint_rules", "task_roles",
        )
        if key in proposal
    }
    return apply_graph_ops(base_workflow, graph_ops)


def _reject_new_checkpoint_on_admitted_work(
        execution, base_workflow, revised_workflow):
    """Keep carried rules stable while blocking new rules on admitted nodes."""
    base_rules = {
        rule.get("id"): rule
        for rule in base_workflow.get("strategy_checkpoint_rules", [])
        if isinstance(rule, dict) and isinstance(rule.get("id"), str)
    }
    existing_states = {
        node.node_id: node.status for node in execution.node_executions
    }
    revised_rules = revised_workflow.get("strategy_checkpoint_rules", [])
    if not isinstance(revised_rules, list):
        return
    for rule in revised_rules:
        if not isinstance(rule, dict):
            continue
        if base_rules.get(rule.get("id")) == rule:
            continue
        trigger_state = existing_states.get(rule.get("after_node"))
        if trigger_state is not None and trigger_state is not NodeStatus.PENDING:
            raise ContractError(
                "New strategy checkpoint rules cannot target work that is "
                "running or completed")


def _replacement_scope(proposal, fixed_scope):
    scope = fixed_scope if fixed_scope is not None else proposal.get("replaced_node_ids")
    if scope is None:
        raise ContractError("Graph proposal must provide replaced_node_ids")
    return scope


def _validate_fixed_configuration(execution, patch_id, replaced_node_ids, reason_ref):
    if not isinstance(patch_id, str) or _IDENTIFIER.fullmatch(patch_id) is None:
        raise ContractError("Graph compiler patch_id must be a bounded lowercase identifier")
    if (reason_ref is not None
            and (not isinstance(reason_ref, str)
                 or not reason_ref.strip()
                 or len(reason_ref) > 500)):
        raise ContractError("Graph compiler reason_ref must be a bounded reference")
    if replaced_node_ids is None:
        return None
    if not isinstance(replaced_node_ids, (tuple, list)):
        raise ContractError("Fixed graph replacement scope must be a sequence")
    scope = tuple(replaced_node_ids)
    if (not scope
            or any(not isinstance(node_id, str) for node_id in scope)
            or len(scope) != len(set(scope))):
        raise ContractError("Fixed graph replacement scope must contain unique node ids")
    states = {state.node_id: state for state in execution.node_executions}
    if any(node_id not in states for node_id in scope):
        raise ContractError("Fixed graph replacement scope references an unknown node")
    if any(states[node_id].status is not NodeStatus.PENDING for node_id in scope):
        raise ContractError("Fixed graph replacement scope may contain only pending nodes")
    return scope


def _diagnostic(attempt: int, stage: str, error: Exception):
    message = str(error).strip()[:800] or type(error).__name__
    return GraphCompilerDiagnostic(
        attempt=attempt,
        stage=stage,
        error_type=type(error).__name__,
        message=message,
    )


def compile_with_graph_repair(
    *,
    execution: PlanExecution,
    base_workflow,
    initial_proposal,
    patch_id: str,
    materialize_callback,
    repair_callback,
    replaced_node_ids=None,
    reason_ref: str | None = None,
    max_attempts: int = 3,
    repair_path: str = "graph_repair",
) -> GraphRepairResult:
    """Compile a graph proposal, requesting bounded repairs after expected errors.

    ``max_attempts`` includes the initial proposal.  ``repair_callback`` receives
    ``(request, path)`` and is invoked outside all exception handlers so provider,
    budget, cancellation, persistence, and infrastructure failures propagate.
    ``materialize_callback`` is a deterministic host validator and resolver; only
    its explicit contract, workflow, and permission errors are repairable.
    """
    if not isinstance(execution, PlanExecution):
        raise ContractError("Graph compiler repair requires a PlanExecution")
    if not callable(materialize_callback) or not callable(repair_callback):
        raise ContractError("Graph compiler repair callbacks must be callable")
    if (type(max_attempts) is not int
            or not 1 <= max_attempts <= MAX_GRAPH_COMPILE_ATTEMPTS):
        raise ContractError(
            f"Graph compiler max_attempts must be in 1..{MAX_GRAPH_COMPILE_ATTEMPTS}"
        )
    if (not isinstance(repair_path, str) or not repair_path.strip()
            or len(repair_path) > 300 or repair_path.endswith("/")):
        raise ContractError("Graph compiler repair_path must be bounded path text")
    replaced_node_ids = _validate_fixed_configuration(
        execution, patch_id, replaced_node_ids, reason_ref)
    base = _snapshot(base_workflow, "Base workflow")
    proposal = _snapshot(initial_proposal, "Initial graph proposal")
    if not isinstance(base, dict) or not isinstance(proposal, dict):
        raise ContractError("Graph compiler workflows and proposals must be objects")
    try:
        base_plan = plan_from_workflow(
            base, execution.plan.id, revision=execution.plan.revision)
    except WorkflowError as exc:
        raise ContractError(f"Base workflow is not compilable: {str(exc)[:800]}") from None
    if base_plan != execution.plan:
        raise ContractError("Base workflow does not match the execution's current plan")

    diagnostics = []
    for attempt in range(1, max_attempts + 1):
        try:
            candidate = _candidate_workflow(base, proposal)
        except _RETRYABLE_COMPILER_ERRORS as exc:
            failure = _diagnostic(attempt, "proposal", exc)
        else:
            try:
                materialized = materialize_callback(_snapshot(
                    candidate, "Candidate workflow"))
                materialized = _snapshot(materialized, "Materialized workflow")
                if not isinstance(materialized, dict):
                    raise ContractError("Materialized workflow must be an object")
            except _RETRYABLE_COMPILER_ERRORS as exc:
                failure = _diagnostic(attempt, "materialize", exc)
            else:
                try:
                    _reject_new_checkpoint_on_admitted_work(
                        execution, base, materialized)
                    patch = PendingGraphPatch(
                        id=patch_id,
                        base_plan_ref=proposal.get("base_plan_ref", execution.plan.ref),
                        replaced_node_ids=_replacement_scope(
                            proposal, replaced_node_ids),
                        revised_workflow=materialized,
                        reason_ref=reason_ref,
                    )
                    revision = compile_pending_graph_patch(execution, patch)
                except _RETRYABLE_COMPILER_ERRORS as exc:
                    failure = _diagnostic(attempt, "plan_revision", exc)
                else:
                    return GraphRepairResult(
                        revision=revision,
                        attempt_count=attempt,
                        diagnostics=diagnostics,
                        revised_workflow=materialized,
                        accepted_proposal=proposal,
                    )

        diagnostics.append(failure)
        if attempt == max_attempts:
            raise GraphRepairExhausted(diagnostics)
        request = {
            "schema": GRAPH_REPAIR_REQUEST_SCHEMA,
            "attempt": attempt + 1,
            "max_attempts": max_attempts,
            "remaining_attempts": max_attempts - attempt,
            "base_plan_ref": execution.plan.ref,
            "base_workflow": _snapshot(base, "Base workflow"),
            "failed_proposal": _snapshot(proposal, "Failed graph proposal"),
            "diagnostic": failure.as_dict(),
        }
        path = f"{repair_path}/attempts/{attempt + 1}"
        # Deliberately outside the compiler exception handlers.  Callers must
        # persist/authorize this RPC and its failures retain their true domain.
        proposal = repair_callback(request, path)
        proposal = _snapshot(proposal, "Repaired graph proposal")
        if not isinstance(proposal, dict):
            raise ContractError("Repair callback must return a graph proposal object")

    raise AssertionError("unreachable graph compiler repair state")
