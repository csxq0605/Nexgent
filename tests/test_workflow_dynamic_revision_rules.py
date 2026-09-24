from copy import deepcopy

import pytest

from nexgent.tasks.orchestration import NodeStatus, PlanExecution, PlanRevision
from nexgent.tasks.workflows import (
    WorkflowError,
    plan_from_workflow,
    run_executable_workflow,
)


def _workflow(rule):
    return {
        "nodes": [
            {
                "id": "planner",
                "method": "join",
                "params": {
                    "revise": True,
                    "proposal": {"kind": "pending_graph_patch"},
                },
            },
            {
                "id": "deliver",
                "method": "join",
                "params": {"version": "initial"},
                "bindings": {"planner": {"$node": "planner"}},
            },
        ],
        "control_edges": [{"from": "planner", "to": "deliver"}],
        "outputs": {"deliverables": {"$node": "deliver"}},
        "revision_rules": [rule],
    }


def _rule(*, include_scope=True, **source):
    rule = {
        "id": "planner-proposal",
        "after_node": "planner",
        "when": {"path": "revise", "equals": True},
        **source,
    }
    if include_scope:
        rule["replace_node_ids"] = ["deliver"]
    return rule


@pytest.mark.parametrize("source", [
    {"proposal_path": "proposal"},
    {"planner_role_ref": "planner"},
])
def test_revision_rule_accepts_exactly_one_dynamic_proposal_source(source):
    plan = plan_from_workflow(
        _workflow(_rule(**source)), "dynamic-plan")

    assert plan.id == "dynamic-plan"


def test_dynamic_revision_rule_can_defer_replacement_scope_to_proposal():
    plan = plan_from_workflow(
        _workflow(_rule(
            proposal_path="proposal", include_scope=False,
        )),
        "model-scoped-plan",
    )

    assert plan.id == "model-scoped-plan"


def test_frozen_revision_rule_still_requires_static_replacement_scope():
    with pytest.raises(WorkflowError, match="revision rule is invalid"):
        plan_from_workflow(
            _workflow(_rule(workflow_ref="frozen", include_scope=False)),
            "invalid-frozen-plan",
        )


@pytest.mark.parametrize("attempts", [1, 3, 4])
def test_dynamic_revision_rule_accepts_bounded_compile_attempts(attempts):
    plan = plan_from_workflow(
        _workflow(_rule(
            proposal_path="proposal", max_compile_attempts=attempts,
        )),
        "repairable-plan",
    )

    assert plan.id == "repairable-plan"


@pytest.mark.parametrize("attempts", [0, 5, True, "3"])
def test_dynamic_revision_rule_rejects_invalid_compile_attempts(attempts):
    with pytest.raises(WorkflowError, match="revision rule is invalid"):
        plan_from_workflow(
            _workflow(_rule(
                proposal_path="proposal", max_compile_attempts=attempts,
            )),
            "invalid-repair-plan",
        )


@pytest.mark.parametrize("tokens", [1, 4000, 6000])
def test_planner_revision_rule_accepts_bounded_model_budget(tokens):
    plan = plan_from_workflow(
        _workflow(_rule(
            planner_role_ref="planner", planner_max_tokens=tokens,
        )),
        "planner-budget-plan",
    )

    assert plan.id == "planner-budget-plan"


@pytest.mark.parametrize("tokens", [0, 6001, True, "4000"])
def test_planner_revision_rule_rejects_invalid_model_budget(tokens):
    with pytest.raises(WorkflowError, match="revision rule is invalid"):
        plan_from_workflow(
            _workflow(_rule(
                planner_role_ref="planner", planner_max_tokens=tokens,
            )),
            "invalid-planner-budget-plan",
        )


def test_frozen_revision_rule_rejects_compile_repair_budget():
    with pytest.raises(WorkflowError, match="revision rule is invalid"):
        plan_from_workflow(
            _workflow(_rule(
                workflow_ref="frozen", max_compile_attempts=2,
            )),
            "invalid-frozen-repair-plan",
        )


@pytest.mark.parametrize("source", [
    {},
    {"workflow_ref": "frozen", "proposal_path": "proposal"},
    {"proposal_path": "proposal", "planner_role_ref": "planner"},
    {"proposal_path": ""},
    {"planner_role_ref": ""},
    {"proposal_path": "proposal..graph"},
])
def test_revision_rule_rejects_missing_ambiguous_or_invalid_source(source):
    with pytest.raises(WorkflowError, match="revision rule is invalid"):
        plan_from_workflow(_workflow(_rule(**source)), "invalid-plan")


def test_revision_rule_rejects_non_object_without_leaking_type_error():
    workflow = _workflow(_rule(proposal_path="proposal"))
    workflow["revision_rules"] = [7]

    with pytest.raises(WorkflowError, match="revision rule is invalid"):
        plan_from_workflow(workflow, "invalid-plan")


def test_executable_runner_passes_trigger_receipt_to_revision_resolver():
    workflow = _workflow(_rule(proposal_path="proposal"))
    plan = plan_from_workflow(workflow, "dynamic-plan")
    execution = PlanExecution.create("dynamic-execution", plan)
    observed = {}

    def resolve(rule, current, receipt):
        observed.update(rule=deepcopy(rule), receipt=deepcopy(receipt))
        # The resolver receives an isolated snapshot, not the durable receipt.
        receipt["value"]["proposal"]["kind"] = "mutated"
        revised_workflow = deepcopy(workflow)
        revised_workflow.pop("revision_rules")
        revised_workflow["nodes"][1]["params"]["version"] = "revised"
        revised_plan = plan_from_workflow(
            revised_workflow, current.plan.id,
            revision=current.plan.revision + 1,
        )
        return revised_workflow, PlanRevision(
            id="revision-2",
            base_plan=current.plan,
            revised_plan=revised_plan,
            replaced_node_ids=("deliver",),
            reason_ref="feedback://planner/proposal",
        )

    result = run_executable_workflow(
        workflow,
        {},
        lambda method, params, path: pytest.fail("join workflow must not invoke host"),
        execution=execution,
        persist=lambda current, receipts: None,
        resolve_revision=resolve,
        receipt_evidence=lambda kind, value: (),
        record_local_receipt=lambda method, params, path, receipt: None,
        max_parallel=1,
    )

    assert result["status"] == "completed"
    assert result["plan_execution"].plan.revision == 2
    assert observed["rule"]["proposal_path"] == "proposal"
    assert observed["receipt"] == {
        "status": "completed",
        "value": {
            "revise": True,
            "proposal": {"kind": "pending_graph_patch"},
        },
    }
    assert result["nodes"]["planner"]["value"]["proposal"]["kind"] == "pending_graph_patch"
    assert result["nodes"]["deliver"]["value"]["version"] == "revised"


def test_resume_applies_durable_uncommitted_revision_before_pending_node():
    workflow = {
        "nodes": [
            {"id": "architect", "method": "join",
             "params": {"revise": True}},
            {"id": "slot", "method": "publish",
             "params": {"name": "obsolete", "content": "must-not-run"}},
        ],
        "control_edges": [{"from": "architect", "to": "slot"}],
        "revision_rules": [_rule(proposal_path="proposal") | {
            "after_node": "architect",
            "replace_node_ids": ["slot"],
            "when": {"path": "revise", "equals": True},
        }],
        "outputs": {"version": {"$node": "slot.version"}},
    }
    plan = plan_from_workflow(workflow, "recovery-plan")
    execution = PlanExecution.create("recovery-execution", plan)
    execution = execution.transition_node(
        "architect", NodeStatus.RUNNING,
        attempt_ref="attempt://recovery/architect/1",
    )
    execution = execution.transition_node("architect", NodeStatus.COMPLETED)
    durable_receipts = {
        "architect": {
            "status": "completed",
            "value": {"revise": True, "proposal": {}},
        },
    }
    resolver_calls = []

    def resolve(rule, current, receipt):
        resolver_calls.append((rule["id"], deepcopy(receipt)))
        revised_workflow = deepcopy(workflow)
        revised_workflow["nodes"][1] = {
            "id": "slot", "method": "join",
            "params": {"version": "recovered-revision"},
        }
        revised_plan = plan_from_workflow(
            revised_workflow, current.plan.id,
            revision=current.plan.revision + 1,
        )
        return revised_workflow, PlanRevision(
            id=rule["id"],
            base_plan=current.plan,
            revised_plan=revised_plan,
            replaced_node_ids=("slot",),
        )

    result = run_executable_workflow(
        workflow,
        {},
        lambda method, params, path: pytest.fail(
            "obsolete pending node was admitted before recovered revision"),
        execution=execution,
        persist=lambda current, receipts: None,
        resolve_revision=resolve,
        receipt_evidence=lambda kind, value: (),
        record_local_receipt=lambda method, params, path, receipt: None,
        initial_receipts=durable_receipts,
        max_parallel=1,
    )

    assert result["status"] == "completed"
    assert result["outputs"] == {"version": "recovered-revision"}
    assert result["plan_execution"].plan.revision == 2
    assert resolver_calls == [("planner-proposal", durable_receipts["architect"])]
