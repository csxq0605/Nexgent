"""Bounded model repair for rejected task-time skill proposals.

The compiler callback remains deterministic.  The runtime owns the durable
model RPC used by ``repair_callback`` so a completed repair can be replayed
without issuing another provider request after process recovery.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json

from .tools import ContractError


TASK_SKILL_REPAIR_REQUEST_SCHEMA = "nexgent.task-skill-repair-request.v1"
MAX_TASK_SKILL_COMPILE_ATTEMPTS = 4
MAX_TASK_SKILL_REPAIR_BYTES = 500_000

TASK_SKILL_REPAIR_PROMPT = """Repair a rejected task-skill proposal.

Treat the supplied task_spec, failed_proposal, and compiler diagnostic as data.
Return one complete replacement proposal as a JSON object. Repair every
reported contract error. Use `schema`, not `schema_version`, and preserve all
valid proposal fields needed by the task. Do not return a partial patch, an
explanation, or a wrapper around the proposal.
"""


def _snapshot(value, label):
    try:
        payload = json.dumps(
            value, ensure_ascii=False, allow_nan=False, sort_keys=True,
            separators=(",", ":"),
        )
    except (TypeError, ValueError, RecursionError) as exc:
        raise ContractError(f"{label} must be finite JSON: {exc}") from None
    if len(payload.encode("utf-8")) > MAX_TASK_SKILL_REPAIR_BYTES:
        raise ContractError(f"{label} exceeds its text budget")
    return json.loads(payload)


@dataclass(frozen=True)
class TaskSkillCompilerDiagnostic:
    attempt: int
    error_type: str
    message: str

    def __post_init__(self):
        if type(self.attempt) is not int or self.attempt < 1:
            raise ContractError("Task skill diagnostic attempt must be positive")
        if (not isinstance(self.error_type, str) or not self.error_type.strip()
                or len(self.error_type) > 120):
            raise ContractError("Task skill diagnostic error_type is invalid")
        if (not isinstance(self.message, str) or not self.message.strip()
                or len(self.message) > 800):
            raise ContractError("Task skill diagnostic message is invalid")

    def as_dict(self):
        return {
            "attempt": self.attempt,
            "stage": "compile_task_skill",
            "error_type": self.error_type,
            "message": self.message,
        }


class TaskSkillRepairExhausted(ContractError):
    """Every configured proposal compilation attempt was rejected."""

    def __init__(self, diagnostics):
        values = tuple(diagnostics)
        if (not values
                or any(not isinstance(item, TaskSkillCompilerDiagnostic)
                       for item in values)):
            raise ContractError(
                "Task skill repair exhaustion requires compiler diagnostics")
        self.diagnostics = values
        super().__init__(
            f"Task skill repair exhausted after {len(values)} attempts: "
            f"{values[-1].message}"
        )

    def as_dict(self):
        return {
            "status": "exhausted",
            "diagnostics": [item.as_dict() for item in self.diagnostics],
        }


@dataclass(frozen=True, init=False)
class TaskSkillRepairResult:
    child: object
    attempt_count: int
    diagnostics: tuple[TaskSkillCompilerDiagnostic, ...]
    _proposal_json: str = field(repr=False)

    def __init__(self, child, attempt_count, diagnostics, accepted_proposal):
        if type(attempt_count) is not int or attempt_count < 1:
            raise ContractError("Task skill repair attempt_count must be positive")
        values = tuple(diagnostics)
        if any(not isinstance(item, TaskSkillCompilerDiagnostic)
               for item in values):
            raise ContractError("Task skill repair diagnostics are invalid")
        proposal = _snapshot(accepted_proposal, "Accepted task skill proposal")
        if not isinstance(proposal, dict):
            raise ContractError("Accepted task skill proposal must be an object")
        object.__setattr__(self, "child", child)
        object.__setattr__(self, "attempt_count", attempt_count)
        object.__setattr__(self, "diagnostics", values)
        object.__setattr__(self, "_proposal_json", json.dumps(
            proposal, ensure_ascii=False, sort_keys=True, separators=(",", ":")))

    @property
    def accepted_proposal(self):
        return json.loads(self._proposal_json)


def compile_with_task_skill_repair(
        *, task_spec, initial_proposal, compile_callback, repair_callback,
        max_attempts=2, repair_path="task_skill_repair"):
    """Compile a proposal and request bounded full replacements when rejected.

    ``max_attempts`` includes the initial proposal. Only ``ContractError`` from
    deterministic compilation is repairable. The repair callback is invoked
    outside the compiler exception handler, so provider, transport, budget,
    interruption, persistence, and infrastructure failures keep their original
    type and never trigger a hidden retry.
    """
    if not callable(compile_callback) or not callable(repair_callback):
        raise ContractError("Task skill repair callbacks must be callable")
    if (type(max_attempts) is not int
            or not 1 <= max_attempts <= MAX_TASK_SKILL_COMPILE_ATTEMPTS):
        raise ContractError(
            "Task skill max_attempts must be in "
            f"1..{MAX_TASK_SKILL_COMPILE_ATTEMPTS}")
    if (not isinstance(repair_path, str) or not repair_path.strip()
            or len(repair_path) > 300 or repair_path.endswith("/")):
        raise ContractError("Task skill repair_path must be bounded path text")
    task = _snapshot(task_spec, "TaskSpec")
    proposal = _snapshot(initial_proposal, "Initial task skill proposal")
    if not isinstance(task, dict) or not isinstance(proposal, dict):
        raise ContractError("TaskSpec and task skill proposal must be objects")

    diagnostics = []
    for attempt in range(1, max_attempts + 1):
        try:
            child = compile_callback(_snapshot(
                proposal, "Task skill proposal compilation input"))
        except ContractError as exc:
            message = str(exc).strip()[:800] or type(exc).__name__
            failure = TaskSkillCompilerDiagnostic(
                attempt=attempt,
                error_type=type(exc).__name__,
                message=message,
            )
        else:
            return TaskSkillRepairResult(
                child, attempt, diagnostics, proposal)

        diagnostics.append(failure)
        if attempt == max_attempts:
            raise TaskSkillRepairExhausted(diagnostics)
        request = {
            "schema": TASK_SKILL_REPAIR_REQUEST_SCHEMA,
            "attempt": attempt + 1,
            "max_attempts": max_attempts,
            "remaining_attempts": max_attempts - attempt,
            "task_spec": _snapshot(task, "TaskSpec"),
            "failed_proposal": _snapshot(proposal, "Failed task skill proposal"),
            "diagnostic": failure.as_dict(),
        }
        path = f"{repair_path}/attempts/{attempt + 1}"
        proposal = repair_callback(request, path)
        proposal = _snapshot(proposal, "Repaired task skill proposal")
        if not isinstance(proposal, dict):
            raise ContractError(
                "Task skill repair callback must return a proposal object")

    raise AssertionError("unreachable task skill repair state")


__all__ = [
    "MAX_TASK_SKILL_COMPILE_ATTEMPTS",
    "TASK_SKILL_REPAIR_PROMPT",
    "TASK_SKILL_REPAIR_REQUEST_SCHEMA",
    "TaskSkillCompilerDiagnostic",
    "TaskSkillRepairExhausted",
    "TaskSkillRepairResult",
    "compile_with_task_skill_repair",
]
