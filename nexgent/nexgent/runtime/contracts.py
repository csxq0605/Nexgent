"""Versioned contracts for reproducible long-running Coding Harness runs.

These models are the runtime truth shared by frontends, workflows, fault
campaigns, and reports.  They deliberately avoid provider-specific objects so a
run can be exported, inspected, and resumed without importing an LLM SDK.
"""

from __future__ import annotations

import dataclasses
import time
import types
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional, Union, get_args, get_origin, get_type_hints


SCHEMA_VERSION = "1.0"


class ContractValidationError(ValueError):
    """Raised when persisted Harness state violates its declared contract."""


class RunMode(str, Enum):
    INTERACTIVE = "interactive"
    CODING = "coding"
    RESEARCH = "research"
    FAULT_CAMPAIGN = "fault_campaign"


class RunStatus(str, Enum):
    CREATED = "created"
    RUNNING = "running"
    WAITING_APPROVAL = "waiting_approval"
    VERIFYING = "verifying"
    COMPLETED_UNVERIFIED = "completed_unverified"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    PAUSED = "paused"
    ABORTED = "aborted"


class AttemptStatus(str, Enum):
    CREATED = "created"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    PAUSED = "paused"
    ABORTED = "aborted"


class AttemptTrigger(str, Enum):
    INITIAL = "initial"
    RETRY = "retry"
    RECOVERY = "recovery"
    RESUME = "resume"


class EventKind(str, Enum):
    RUN = "run"
    ATTEMPT = "attempt"
    GOAL = "goal"
    DECISION = "decision"
    MODEL = "model"
    TOOL = "tool"
    WORKFLOW = "workflow"
    PROCESS = "process"
    SIMULATOR = "simulator"
    ARTIFACT = "artifact"
    CHECKPOINT = "checkpoint"
    FAULT = "fault"
    DIAGNOSIS = "diagnosis"
    RECOVERY = "recovery"
    VERIFICATION = "verification"
    APPROVAL = "approval"
    NOTICE = "notice"


class SourceType(str, Enum):
    RUNTIME = "runtime"
    AGENT = "agent"
    SUBAGENT = "subagent"
    WORKFLOW = "workflow"
    TOOL = "tool"
    PROCESS = "process"
    SIMULATOR = "simulator"
    VALIDATOR = "validator"
    USER = "user"
    SYSTEM = "system"


class WorkflowPrimitive(str, Enum):
    AGENT = "agent"
    TOOL = "tool"
    PROCESS = "process"
    SIMULATOR = "simulator"
    VALIDATOR = "validator"
    APPROVAL = "approval"


class WorkflowNodeStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class DependencyKind(str, Enum):
    CONTROL = "control"
    DATA = "data"
    ARTIFACT = "artifact"
    CAUSAL = "causal"
    COMMUNICATION = "communication"
    RESOURCE = "resource"
    RETRY = "retry"
    RECOVERY = "recovery"
    VERIFICATION = "verification"


class FaultCategory(str, Enum):
    MODEL = "model"
    SCHEMA = "schema"
    TOOL = "tool"
    CODE = "code"
    CONFIG = "config"
    DEPENDENCY = "dependency"
    TIMEOUT = "timeout"
    INFRASTRUCTURE = "infrastructure"
    SOLVER = "solver"
    NUMERICAL = "numerical"
    PHYSICAL = "physical"
    ARTIFACT = "artifact"
    UNKNOWN = "unknown"


class RecoveryKind(str, Enum):
    RETRY = "retry"
    ROLLBACK = "rollback"
    PATCH = "patch"
    PARAMETER_OVERRIDE = "parameter_override"
    TOOL_SUBSTITUTION = "tool_substitution"
    MODEL_SUBSTITUTION = "model_substitution"
    ESCALATE = "escalate"


class VerificationStatus(str, Enum):
    PASS = "pass"
    FAIL = "fail"
    INCONCLUSIVE = "inconclusive"


class VerificationDecision(str, Enum):
    ACCEPT = "accept"
    REJECT = "reject"
    ESCALATE = "escalate"


def new_id(prefix: str) -> str:
    """Return a sortable-enough opaque identifier with a human-readable type."""

    return f"{prefix}-{uuid.uuid4().hex}"


def now_ns() -> int:
    return time.time_ns()


def _encode(value: Any) -> Any:
    if isinstance(value, Enum):
        return value.value
    if dataclasses.is_dataclass(value):
        return {field_.name: _encode(getattr(value, field_.name)) for field_ in dataclasses.fields(value)}
    if isinstance(value, tuple):
        return [_encode(item) for item in value]
    if isinstance(value, list):
        return [_encode(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _encode(item) for key, item in value.items()}
    return value


def _decode(annotation: Any, value: Any) -> Any:
    if value is None:
        return None
    origin = get_origin(annotation)
    args = get_args(annotation)
    if origin in (Union, types.UnionType):
        non_none = [item for item in args if item is not type(None)]
        if len(non_none) == 1:
            return _decode(non_none[0], value)
        return value
    if origin is list:
        inner = args[0] if args else Any
        return [_decode(inner, item) for item in value]
    if origin is tuple:
        inner = args[0] if args else Any
        return tuple(_decode(inner, item) for item in value)
    if origin is dict:
        value_type = args[1] if len(args) > 1 else Any
        return {str(key): _decode(value_type, item) for key, item in value.items()}
    if isinstance(annotation, type) and issubclass(annotation, Enum):
        return annotation(value)
    if isinstance(annotation, type) and dataclasses.is_dataclass(annotation):
        if hasattr(annotation, "from_dict"):
            return annotation.from_dict(value)
    return value


class Contract:
    """JSON round-trip and validation behavior shared by all contracts."""

    def to_dict(self) -> dict[str, Any]:
        self.validate()
        return _encode(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]):
        if not isinstance(data, dict):
            raise ContractValidationError(f"{cls.__name__} requires an object")
        hints = get_type_hints(cls)
        allowed = {field_.name for field_ in dataclasses.fields(cls)}
        unknown = set(data) - allowed
        if unknown:
            raise ContractValidationError(
                f"{cls.__name__} contains unknown fields: {sorted(unknown)}"
            )
        values = {
            key: _decode(hints.get(key, Any), value)
            for key, value in data.items()
        }
        instance = cls(**values)
        instance.validate()
        return instance

    def validate(self) -> None:
        schema_version = getattr(self, "schema_version", SCHEMA_VERSION)
        if schema_version != SCHEMA_VERSION:
            raise ContractValidationError(
                f"Unsupported schema version {schema_version!r}; expected {SCHEMA_VERSION!r}"
            )


def _required(name: str, value: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ContractValidationError(f"{name} is required")


@dataclass(frozen=True)
class BudgetPolicy(Contract):
    max_turns: int = 8
    max_attempts: int = 3
    max_recoveries_per_fault: int = 2
    max_duration_seconds: float = 1800.0
    max_tokens: int = 0
    max_cost: float = 0.0
    schema_version: str = SCHEMA_VERSION

    def validate(self) -> None:
        super().validate()
        for name in ("max_turns", "max_attempts", "max_recoveries_per_fault"):
            if getattr(self, name) < 1:
                raise ContractValidationError(f"{name} must be at least 1")
        if self.max_duration_seconds <= 0:
            raise ContractValidationError("max_duration_seconds must be positive")
        if self.max_tokens < 0 or self.max_cost < 0:
            raise ContractValidationError("token and cost budgets cannot be negative")


@dataclass(frozen=True)
class ExperimentRun(Contract):
    run_id: str
    objective: str
    project_root: str
    session_id: Optional[str] = None
    goal_id: Optional[str] = None
    workflow_run_id: Optional[str] = None
    parent_run_id: Optional[str] = None
    branch_from_event_id: Optional[str] = None
    mode: RunMode = RunMode.RESEARCH
    status: RunStatus = RunStatus.CREATED
    code_revision: Optional[str] = None
    dirty_tree_digest: Optional[str] = None
    environment_digest: Optional[str] = None
    model_profile: Optional[str] = None
    prompt_digest: Optional[str] = None
    tool_catalog_digest: Optional[str] = None
    seed: Optional[int] = None
    budget: BudgetPolicy = field(default_factory=BudgetPolicy)
    current_attempt: int = 0
    termination_reason: Optional[str] = None
    tags: dict[str, str] = field(default_factory=dict)
    created_at_ns: int = field(default_factory=now_ns)
    updated_at_ns: int = field(default_factory=now_ns)
    schema_version: str = SCHEMA_VERSION

    def validate(self) -> None:
        super().validate()
        _required("run_id", self.run_id)
        _required("objective", self.objective)
        _required("project_root", self.project_root)
        if self.current_attempt < 0:
            raise ContractValidationError("current_attempt cannot be negative")
        self.budget.validate()


@dataclass(frozen=True)
class RunAttempt(Contract):
    attempt_id: str
    run_id: str
    trigger: AttemptTrigger
    status: AttemptStatus = AttemptStatus.CREATED
    parent_attempt_id: Optional[str] = None
    checkpoint_id: Optional[str] = None
    started_at_ns: int = field(default_factory=now_ns)
    finished_at_ns: Optional[int] = None
    termination_reason: Optional[str] = None
    schema_version: str = SCHEMA_VERSION

    def validate(self) -> None:
        super().validate()
        _required("attempt_id", self.attempt_id)
        _required("run_id", self.run_id)


@dataclass(frozen=True)
class ExecutionEvent(Contract):
    event_id: str
    run_id: str
    kind: EventKind
    source_type: SourceType
    source_id: str
    attempt_id: Optional[str] = None
    sequence: int = 0
    timestamp_ns: int = field(default_factory=now_ns)
    span_id: Optional[str] = None
    parent_span_id: Optional[str] = None
    causation_event_id: Optional[str] = None
    workflow_node_id: Optional[str] = None
    tool_call_id: Optional[str] = None
    payload: dict[str, Any] = field(default_factory=dict)
    payload_schema_version: str = SCHEMA_VERSION
    schema_version: str = SCHEMA_VERSION

    def validate(self) -> None:
        super().validate()
        _required("event_id", self.event_id)
        _required("run_id", self.run_id)
        _required("source_id", self.source_id)
        if self.sequence < 0:
            raise ContractValidationError("sequence cannot be negative")
        if self.payload_schema_version != SCHEMA_VERSION:
            raise ContractValidationError("unsupported payload schema version")


@dataclass(frozen=True)
class WorkflowNode(Contract):
    node_id: str
    run_id: str
    workflow_id: str
    name: str
    primitive: WorkflowPrimitive
    input_schema: dict[str, Any] = field(default_factory=dict)
    output_schema: dict[str, Any] = field(default_factory=dict)
    input_refs: tuple[str, ...] = ()
    depends_on: tuple[str, ...] = ()
    effects: tuple[str, ...] = ()
    resources: dict[str, Any] = field(default_factory=dict)
    validators: tuple[str, ...] = ()
    idempotent: bool = False
    max_retries: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)
    schema_version: str = SCHEMA_VERSION

    def validate(self) -> None:
        super().validate()
        for name in ("node_id", "run_id", "workflow_id", "name"):
            _required(name, getattr(self, name))
        if self.node_id in self.depends_on:
            raise ContractValidationError("workflow node cannot depend on itself")
        if self.max_retries < 0:
            raise ContractValidationError("max_retries cannot be negative")


@dataclass(frozen=True)
class WorkflowNodeResult(Contract):
    """Durable result for one typed primitive.

    The input digest prevents an old successful node from being reused after
    its bound inputs change.  Outputs remain JSON-compatible so a fresh process
    can resume without importing the original executor implementation.
    """

    node_id: str
    run_id: str
    workflow_id: str
    status: WorkflowNodeStatus
    input_digest: str
    output_digest: Optional[str] = None
    output: Any = None
    attempt_count: int = 0
    started_at_ns: Optional[int] = None
    finished_at_ns: Optional[int] = None
    error: Optional[str] = None
    schema_version: str = SCHEMA_VERSION

    def validate(self) -> None:
        super().validate()
        for name in ("node_id", "run_id", "workflow_id", "input_digest"):
            _required(name, getattr(self, name))
        if self.attempt_count < 0:
            raise ContractValidationError("attempt_count cannot be negative")
        if self.status is WorkflowNodeStatus.SUCCEEDED and not self.output_digest:
            raise ContractValidationError("succeeded workflow node needs output_digest")
        if self.status is WorkflowNodeStatus.FAILED and not self.error:
            raise ContractValidationError("failed workflow node needs an error")


@dataclass(frozen=True)
class DependencyEdge(Contract):
    edge_id: str
    run_id: str
    from_ref: str
    to_ref: str
    kind: DependencyKind
    evidence_event_id: Optional[str] = None
    confidence: float = 1.0
    inferred: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)
    schema_version: str = SCHEMA_VERSION

    def validate(self) -> None:
        super().validate()
        for name in ("edge_id", "run_id", "from_ref", "to_ref"):
            _required(name, getattr(self, name))
        if self.from_ref == self.to_ref:
            raise ContractValidationError("dependency edge cannot be self-referential")
        if not 0.0 <= self.confidence <= 1.0:
            raise ContractValidationError("confidence must be in [0, 1]")


@dataclass(frozen=True)
class ArtifactRecord(Contract):
    artifact_id: str
    run_id: str
    sha256: str
    size_bytes: int
    role: str
    path_or_uri: str
    media_type: str = "application/octet-stream"
    producer_event_id: Optional[str] = None
    source_artifact_ids: tuple[str, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at_ns: int = field(default_factory=now_ns)
    schema_version: str = SCHEMA_VERSION

    def validate(self) -> None:
        super().validate()
        for name in ("artifact_id", "run_id", "sha256", "role", "path_or_uri"):
            _required(name, getattr(self, name))
        if len(self.sha256) != 64 or any(ch not in "0123456789abcdef" for ch in self.sha256.lower()):
            raise ContractValidationError("sha256 must be a 64-character hexadecimal digest")
        if self.size_bytes < 0:
            raise ContractValidationError("size_bytes cannot be negative")


@dataclass(frozen=True)
class AcceptanceCriterion(Contract):
    criterion_id: str
    kind: str
    description: str
    validator: str
    parameters: dict[str, Any] = field(default_factory=dict)
    required: bool = True
    schema_version: str = SCHEMA_VERSION

    def validate(self) -> None:
        super().validate()
        for name in ("criterion_id", "kind", "description", "validator"):
            _required(name, getattr(self, name))


@dataclass(frozen=True)
class GoalSpec(Contract):
    goal_id: str
    objective: str
    criteria: tuple[AcceptanceCriterion, ...]
    required_evidence: tuple[str, ...] = ()
    allowed_recovery_kinds: tuple[RecoveryKind, ...] = (
        RecoveryKind.RETRY,
        RecoveryKind.ROLLBACK,
        RecoveryKind.PATCH,
        RecoveryKind.ESCALATE,
    )
    budget: BudgetPolicy = field(default_factory=BudgetPolicy)
    schema_version: str = SCHEMA_VERSION

    def validate(self) -> None:
        super().validate()
        _required("goal_id", self.goal_id)
        _required("objective", self.objective)
        if not self.criteria:
            raise ContractValidationError("a goal needs at least one acceptance criterion")
        for criterion in self.criteria:
            criterion.validate()
        self.budget.validate()


@dataclass(frozen=True)
class FaultSpec(Contract):
    fault_id: str
    run_id: str
    category: FaultCategory
    target_ref: str
    trigger: dict[str, Any]
    ground_truth: dict[str, Any]
    reversible: bool = True
    visible_to_diagnoser: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)
    schema_version: str = SCHEMA_VERSION

    def validate(self) -> None:
        super().validate()
        for name in ("fault_id", "run_id", "target_ref"):
            _required(name, getattr(self, name))
        if not self.ground_truth:
            raise ContractValidationError("fault ground truth is required")


@dataclass(frozen=True)
class FaultObservation(Contract):
    observation_id: str
    run_id: str
    category: FaultCategory
    signal: str
    severity: str
    symptom_event_ids: tuple[str, ...]
    detector: str
    evidence_artifact_ids: tuple[str, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)
    schema_version: str = SCHEMA_VERSION

    def validate(self) -> None:
        super().validate()
        for name in ("observation_id", "run_id", "signal", "severity", "detector"):
            _required(name, getattr(self, name))
        if not self.symptom_event_ids:
            raise ContractValidationError("an observation needs at least one symptom event")


@dataclass(frozen=True)
class DiagnosisCandidate(Contract):
    suspect_ref: str
    score: float
    evidence_event_ids: tuple[str, ...]
    counter_evidence_event_ids: tuple[str, ...] = ()
    causal_path: tuple[str, ...] = ()
    rationale: str = ""
    schema_version: str = SCHEMA_VERSION

    def validate(self) -> None:
        super().validate()
        _required("suspect_ref", self.suspect_ref)
        if not 0.0 <= self.score <= 1.0:
            raise ContractValidationError("diagnosis score must be in [0, 1]")
        if not self.evidence_event_ids:
            raise ContractValidationError("a diagnosis candidate needs evidence")


@dataclass(frozen=True)
class Diagnosis(Contract):
    diagnosis_id: str
    run_id: str
    observation_id: str
    candidates: tuple[DiagnosisCandidate, ...]
    next_check: Optional[str] = None
    method: str = "dependency"
    created_at_ns: int = field(default_factory=now_ns)
    schema_version: str = SCHEMA_VERSION

    def validate(self) -> None:
        super().validate()
        for name in ("diagnosis_id", "run_id", "observation_id", "method"):
            _required(name, getattr(self, name))
        if not self.candidates:
            raise ContractValidationError("a diagnosis needs at least one candidate")
        for candidate in self.candidates:
            candidate.validate()
        scores = [candidate.score for candidate in self.candidates]
        if scores != sorted(scores, reverse=True):
            raise ContractValidationError("diagnosis candidates must be score-ranked")


@dataclass(frozen=True)
class RecoveryAction(Contract):
    recovery_id: str
    run_id: str
    diagnosis_id: str
    kind: RecoveryKind
    target_ref: str
    parameters: dict[str, Any]
    checkpoint_id: Optional[str] = None
    expected_effects: tuple[str, ...] = ()
    risk: str = "unknown"
    requires_approval: bool = True
    idempotency_key: Optional[str] = None
    created_at_ns: int = field(default_factory=now_ns)
    schema_version: str = SCHEMA_VERSION

    def validate(self) -> None:
        super().validate()
        for name in ("recovery_id", "run_id", "diagnosis_id", "target_ref", "risk"):
            _required(name, getattr(self, name))
        if self.kind is not RecoveryKind.ESCALATE and not self.expected_effects:
            raise ContractValidationError("non-escalation recovery needs expected effects")


@dataclass(frozen=True)
class RecoveryStrategy(Contract):
    """Cross-run recovery knowledge promoted only from accepted evidence."""

    strategy_id: str
    signature: str
    recovery_kind: RecoveryKind
    source_run_id: str
    source_recovery_id: str
    source_verification_id: str
    success_count: int = 1
    failure_count: int = 0
    consecutive_failures: int = 0
    disabled: bool = False
    last_failure_run_id: Optional[str] = None
    promoted_at_ns: int = field(default_factory=now_ns)
    schema_version: str = SCHEMA_VERSION

    def validate(self) -> None:
        super().validate()
        for name in (
            "strategy_id",
            "signature",
            "source_run_id",
            "source_recovery_id",
            "source_verification_id",
        ):
            _required(name, getattr(self, name))
        if self.success_count < 1:
            raise ContractValidationError("a promoted strategy needs a success")
        if self.failure_count < 0:
            raise ContractValidationError("strategy failure_count cannot be negative")
        if self.consecutive_failures < 0:
            raise ContractValidationError("consecutive_failures cannot be negative")


@dataclass(frozen=True)
class VerificationCheck(Contract):
    check_id: str
    kind: str
    validator: str
    status: VerificationStatus
    expected: Any = None
    observed: Any = None
    tolerance: Optional[float] = None
    evidence_refs: tuple[str, ...] = ()
    message: str = ""
    schema_version: str = SCHEMA_VERSION

    def validate(self) -> None:
        super().validate()
        for name in ("check_id", "kind", "validator"):
            _required(name, getattr(self, name))
        if self.status is VerificationStatus.PASS and not self.evidence_refs:
            raise ContractValidationError("a passing check needs evidence")


@dataclass(frozen=True)
class VerificationResult(Contract):
    verification_id: str
    run_id: str
    checks: tuple[VerificationCheck, ...]
    decision: VerificationDecision
    recovery_id: Optional[str] = None
    baseline_run_id: Optional[str] = None
    comparable_to_baseline: bool = False
    differences: tuple[str, ...] = ()
    created_at_ns: int = field(default_factory=now_ns)
    schema_version: str = SCHEMA_VERSION

    def validate(self) -> None:
        super().validate()
        for name in ("verification_id", "run_id"):
            _required(name, getattr(self, name))
        if not self.checks:
            raise ContractValidationError("verification needs at least one check")
        for check in self.checks:
            check.validate()
        statuses = {check.status for check in self.checks}
        if self.decision is VerificationDecision.ACCEPT and statuses != {VerificationStatus.PASS}:
            raise ContractValidationError("accept requires every verification check to pass")
