from copy import deepcopy

import pytest

from nexgent.tasks.task_skill_repair import (
    TASK_SKILL_REPAIR_REQUEST_SCHEMA,
    TaskSkillRepairExhausted,
    compile_with_task_skill_repair,
)
from nexgent.tasks.tools import ContractError


TASK = {"objective": "Double the supplied value", "inputs": {"value": 21}}
INVALID = {"schema_version": "nexgent.task-skill-proposal.v1", "skill": {}}
VALID = {"schema": "nexgent.task-skill-proposal.v1", "skill": {"name": "double"}}


def _compile(proposal):
    if proposal != VALID:
        raise ContractError("Task skill proposal has an invalid envelope")
    return {"id": "task-child", "proposal": deepcopy(proposal)}


def test_invalid_proposal_returns_diagnostic_task_and_prior_proposal_for_repair():
    calls = []

    def repair(request, path):
        calls.append((deepcopy(request), path))
        request["task_spec"].clear()
        request["failed_proposal"].clear()
        return VALID

    result = compile_with_task_skill_repair(
        task_spec=TASK,
        initial_proposal=INVALID,
        compile_callback=_compile,
        repair_callback=repair,
        max_attempts=2,
    )

    assert result.child["id"] == "task-child"
    assert result.attempt_count == 2
    assert result.accepted_proposal == VALID
    assert calls[0][1] == "task_skill_repair/attempts/2"
    request = calls[0][0]
    assert request["schema"] == TASK_SKILL_REPAIR_REQUEST_SCHEMA
    assert request["task_spec"] == TASK
    assert request["failed_proposal"] == INVALID
    assert request["diagnostic"] == {
        "attempt": 1,
        "stage": "compile_task_skill",
        "error_type": "ContractError",
        "message": "Task skill proposal has an invalid envelope",
    }
    assert TASK == {"objective": "Double the supplied value",
                    "inputs": {"value": 21}}
    assert INVALID["schema_version"] == "nexgent.task-skill-proposal.v1"


def test_repair_exhaustion_is_bounded_and_reports_every_compiler_failure():
    paths = []

    with pytest.raises(TaskSkillRepairExhausted) as raised:
        compile_with_task_skill_repair(
            task_spec=TASK,
            initial_proposal=INVALID,
            compile_callback=_compile,
            repair_callback=lambda request, path: (
                paths.append(path) or deepcopy(INVALID)),
            max_attempts=3,
        )

    assert paths == [
        "task_skill_repair/attempts/2",
        "task_skill_repair/attempts/3",
    ]
    assert len(raised.value.diagnostics) == 3
    assert raised.value.as_dict()["status"] == "exhausted"


@pytest.mark.parametrize("failure", [
    TimeoutError("provider unavailable"),
    InterruptedError("task cancelled"),
    RuntimeError("persistence failure"),
])
def test_repair_callback_failures_propagate_without_another_attempt(failure):
    calls = []

    def repair(request, path):
        calls.append(path)
        raise failure

    with pytest.raises(type(failure)) as raised:
        compile_with_task_skill_repair(
            task_spec=TASK,
            initial_proposal=INVALID,
            compile_callback=_compile,
            repair_callback=repair,
            max_attempts=4,
        )

    assert raised.value is failure
    assert calls == ["task_skill_repair/attempts/2"]


def test_non_contract_compiler_failure_is_not_sent_to_model():
    failure = OSError("storage unavailable")
    calls = []

    with pytest.raises(OSError) as raised:
        compile_with_task_skill_repair(
            task_spec=TASK,
            initial_proposal=INVALID,
            compile_callback=lambda proposal: (_ for _ in ()).throw(failure),
            repair_callback=lambda request, path: calls.append(path),
        )

    assert raised.value is failure
    assert calls == []
