from copy import deepcopy

import pytest

from nexgent.tasks.orchestration import NodeStatus, PlanExecution
from nexgent.tasks.workflows import (
    WorkflowError,
    plan_from_workflow,
    run_executable_workflow,
)


def _rule(**updates):
    return {
        "id": "inspect-feedback",
        "after_node": "inspect",
        "feedback_path": "feedback",
        **updates,
    }


def _workflow(*, rules=None):
    return {
        "nodes": [
            {
                "id": "inspect",
                "method": "join",
                "params": {"feedback": {"gap": True}},
            },
            {
                "id": "finish",
                "method": "join",
                "bindings": {"inspection": {"$node": "inspect"}},
            },
        ],
        "control_edges": [{"from": "inspect", "to": "finish"}],
        "outputs": {"result": {"$node": "finish"}},
        "strategy_checkpoint_rules": (
            [_rule()] if rules is None else rules
        ),
    }


def _run(workflow, resolver, *, execution=None, initial_receipts=None,
         invoke=None, persist=None):
    plan = plan_from_workflow(workflow, "checkpoint-plan")
    execution = execution or PlanExecution.create("checkpoint-execution", plan)
    return run_executable_workflow(
        workflow,
        {},
        invoke or (lambda method, params, path: pytest.fail(
            "join workflow must not call the host")),
        execution=execution,
        persist=persist or (lambda current, receipts: None),
        resolve_revision=lambda rule, current, receipt: pytest.fail(
            "workflow has no revision trigger"),
        resolve_strategy_checkpoint=resolver,
        receipt_evidence=lambda kind, value: (),
        record_local_receipt=lambda method, params, path, receipt: None,
        initial_receipts=initial_receipts,
        max_parallel=1,
    )


def test_checkpoint_rule_accepts_exact_bounded_contract():
    plan = plan_from_workflow(_workflow(), "valid-checkpoint-plan")

    assert plan.id == "valid-checkpoint-plan"


@pytest.mark.parametrize("rules", [
    [_rule(extra=True)],
    [7],
    [_rule(id=[])],
    [_rule(after_node=[])],
    [_rule(feedback_path=7)],
    [_rule(feedback_path="")],
    [_rule(feedback_path="x" * 501)],
    [_rule(after_node="missing")],
    [_rule(), _rule()],
    [_rule(id=f"rule-{index}") for index in range(5)],
])
def test_checkpoint_rule_rejects_invalid_shape_bounds_and_identity(rules):
    with pytest.raises(WorkflowError, match="strategy checkpoint rule|bounded list"):
        plan_from_workflow(_workflow(rules=rules), "invalid-checkpoint-plan")


def test_checkpoint_trigger_cannot_overlap_revision_trigger():
    workflow = _workflow()
    workflow["revision_rules"] = [{
        "id": "revise-finish",
        "after_node": "inspect",
        "when": {"path": "feedback.gap", "equals": True},
        "workflow_ref": "revised",
        "replace_node_ids": ["finish"],
    }]

    with pytest.raises(WorkflowError, match="strategy checkpoint rule"):
        plan_from_workflow(workflow, "overlapping-trigger-plan")


def test_checkpoint_trigger_must_dominate_every_descendant():
    workflow = {
        "nodes": [
            {"id": "root", "method": "join"},
            {"id": "inspect", "method": "join",
             "params": {"feedback": {"gap": True}}},
            {"id": "alternate", "method": "join"},
            {"id": "finish", "method": "join"},
        ],
        "control_edges": [
            {"from": "root", "to": "inspect"},
            {"from": "root", "to": "alternate"},
            {"from": "inspect", "to": "finish"},
            {"from": "alternate", "to": "finish"},
        ],
        "strategy_checkpoint_rules": [_rule()],
    }

    with pytest.raises(WorkflowError, match="must dominate"):
        plan_from_workflow(workflow, "unsafe-cut-plan")


def test_continue_is_resolved_after_durable_trigger_before_next_frontier():
    workflow = _workflow()
    events = []

    def persist(current, receipts):
        events.append((
            "persist",
            current.node("inspect").status,
            tuple(sorted(receipts)),
        ))

    def resolve(rule, current, receipt, feedback):
        events.append((
            "resolve",
            current.node("inspect").status,
            tuple(sorted(receipt)),
            deepcopy(feedback),
        ))
        assert current.node("finish").status is NodeStatus.PENDING
        return {"action": "continue"}

    result = _run(workflow, resolve, persist=persist)

    assert result["status"] == "completed"
    assert [event[0] for event in events].count("resolve") == 1
    resolve_index = next(
        index for index, event in enumerate(events) if event[0] == "resolve")
    assert events[resolve_index] == (
        "resolve", NodeStatus.COMPLETED,
        ("status", "value"), {"gap": True},
    )
    assert any(
        event[0] == "persist"
        and event[1] is NodeStatus.COMPLETED
        and event[2] == ("inspect",)
        for event in events[:resolve_index]
    )


def test_switch_returns_checkpoint_without_admitting_pending_nodes():
    workflow = _workflow()
    observed = {}

    def resolve(rule, current, receipt, feedback):
        observed.update(
            rule=deepcopy(rule),
            execution=current,
            receipt=deepcopy(receipt),
            feedback=deepcopy(feedback),
        )
        return {
            "action": "switch",
            "checkpoint": {"checkpoint_digest": "checkpoint-1"},
        }

    result = _run(workflow, resolve)

    assert result["status"] == "checkpointed"
    assert result["outputs"] == {}
    assert result["nodes"] == {
        "inspect": {
            "status": "completed",
            "value": {"feedback": {"gap": True}},
        },
    }
    assert result["plan_execution"] == observed["execution"]
    assert result["plan_execution"].node("inspect").status is NodeStatus.COMPLETED
    assert result["plan_execution"].node("finish").status is NodeStatus.PENDING
    assert observed["feedback"] == {"gap": True}
    assert result["strategy_checkpoint"] == {
        "rule_id": "inspect-feedback",
        "after_node": "inspect",
        "feedback_path": "feedback",
        "checkpoint": {"checkpoint_digest": "checkpoint-1"},
    }


def test_resume_resolves_durable_trigger_before_pending_admission():
    workflow = _workflow()
    plan = plan_from_workflow(workflow, "checkpoint-plan")
    execution = PlanExecution.create("checkpoint-execution", plan)
    execution = execution.transition_node(
        "inspect", NodeStatus.RUNNING,
        attempt_ref="attempt://checkpoint/inspect/1",
    )
    execution = execution.transition_node("inspect", NodeStatus.COMPLETED)
    receipt = {
        "status": "completed",
        "value": {"feedback": {"gap": "durable"}},
    }
    calls = []

    result = _run(
        workflow,
        lambda rule, current, trigger, feedback: (
            calls.append((deepcopy(trigger), deepcopy(feedback)))
            or {"action": "switch", "checkpoint": {"id": "resume"}}
        ),
        execution=execution,
        initial_receipts={"inspect": receipt},
    )

    assert result["status"] == "checkpointed"
    assert calls == [(receipt, {"gap": "durable"})]
    assert result["plan_execution"].node("finish").status is NodeStatus.PENDING


@pytest.mark.parametrize("receipt_status", ["failed", "unknown"])
def test_failed_or_unknown_receipt_never_triggers_checkpoint(receipt_status):
    workflow = _workflow()
    plan = plan_from_workflow(workflow, "checkpoint-plan")
    execution = PlanExecution.create("checkpoint-execution", plan)
    execution = execution.transition_node(
        "inspect", NodeStatus.RUNNING,
        attempt_ref="attempt://checkpoint/inspect/1",
    )
    terminal_status = (
        NodeStatus.FAILED if receipt_status == "failed" else NodeStatus.COMPLETED
    )
    transition_kwargs = (
        {"failure_ref": "failure://checkpoint/inspect"}
        if terminal_status is NodeStatus.FAILED else {}
    )
    execution = execution.transition_node(
        "inspect", terminal_status, **transition_kwargs)
    receipt = {
        "status": receipt_status,
        "value": {"feedback": {"gap": True}},
        **({"error": "provider unavailable"} if receipt_status == "failed" else {}),
    }

    result = _run(
        workflow,
        lambda *args: pytest.fail(
            "failed or unknown receipt became a strategy checkpoint"),
        execution=execution,
        initial_receipts={"inspect": receipt},
    )

    assert result["status"] == "failed"
    assert "strategy_checkpoint" not in result


def test_checkpoint_resolver_failure_is_not_converted_to_checkpoint():
    def unavailable(*args):
        raise RuntimeError("checkpoint provider unavailable")

    with pytest.raises(RuntimeError, match="checkpoint provider unavailable"):
        _run(_workflow(), unavailable)
