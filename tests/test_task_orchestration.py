from dataclasses import FrozenInstanceError

import pytest

from nexgent.tasks.orchestration import (
    ArtifactBinding,
    ControlBinding,
    FailureAction,
    FailureRoute,
    JoinMode,
    JoinPolicy,
    LocalLimits,
    NodeStatus,
    PlanExecution,
    PlanNode,
    PlanRevision,
    PlanSpec,
    PortSpec,
)
from nexgent.tasks.tools import ContractError


SCHEMA = "schema://draft-v1"


def _node(node_id, *, operator=None, inputs=(), outputs=(), attempts=1, iterations=None):
    return PlanNode(
        id=node_id,
        operator_ref=operator or f"operator://{node_id}/v1",
        role_ref=f"role://{node_id}/v1",
        component_ref=f"component://{node_id}/sha256:abc",
        input_ports=tuple(PortSpec(name=name, schema_ref=SCHEMA) for name in inputs),
        output_ports=tuple(PortSpec(name=name, schema_ref=SCHEMA) for name in outputs),
        local_limits=LocalLimits(max_attempts=attempts, max_iterations=iterations),
    )


def _base_plan():
    return PlanSpec(
        id="delivery-plan",
        nodes=(
            _node("draft", outputs=("draft",)),
            _node("review", inputs=("draft",), outputs=("review",), attempts=2),
            _node("deliver", inputs=("review",)),
            _node("repair", inputs=("draft",)),
        ),
        control_bindings=(
            ControlBinding("draft", "review"),
            ControlBinding("review", "deliver", "condition://accepted"),
        ),
        artifact_bindings=(
            ArtifactBinding("draft", "draft", "review", "draft", SCHEMA),
            ArtifactBinding("review", "review", "deliver", "review", SCHEMA),
        ),
        join_policies=(JoinPolicy("deliver", JoinMode.ALL),),
        failure_routes=(
            FailureRoute("review", FailureAction.RETRY, failure_kinds=("transient",)),
            FailureRoute(
                "review", FailureAction.ROUTE, target_node_id="repair",
                failure_kinds=("invalid",),
            ),
        ),
    )


def test_plan_contract_is_immutable_typed_and_content_addressed():
    plan = _base_plan()

    assert plan.schema == "nexgent.executable-plan.v1"
    assert plan.ref.startswith("plan-")
    assert plan.nodes[0].operator_ref == "operator://draft/v1"
    assert plan.nodes[0].role_ref == "role://draft/v1"
    assert plan.nodes[0].component_ref == "component://draft/sha256:abc"
    assert plan.artifact_bindings[0].schema_ref == SCHEMA
    with pytest.raises(FrozenInstanceError):
        plan.revision = 2

    with pytest.raises(ContractError, match="schema"):
        PlanSpec(
            id="bad-binding",
            nodes=(_node("a", outputs=("value",)), _node("b", inputs=("value",))),
            artifact_bindings=(
                ArtifactBinding("a", "value", "b", "value", "schema://other"),
            ),
        )


def test_control_cycles_and_retry_routes_require_local_limits():
    with pytest.raises(ContractError, match="max_iterations"):
        PlanSpec(
            id="unbounded-loop",
            nodes=(_node("a"), _node("b")),
            control_bindings=(ControlBinding("a", "b"), ControlBinding("b", "a")),
        )

    bounded = PlanSpec(
        id="bounded-loop",
        nodes=(_node("a", iterations=3), _node("b", iterations=3)),
        control_bindings=(ControlBinding("a", "b"), ControlBinding("b", "a")),
    )
    assert bounded.nodes[0].local_limits.max_iterations == 3

    with pytest.raises(ContractError, match="max_attempts"):
        PlanSpec(
            id="invalid-retry",
            nodes=(_node("a"),),
            failure_routes=(FailureRoute("a", FailureAction.RETRY),),
        )


def test_revision_can_replace_only_pending_subgraph_and_preserves_completed_receipt():
    execution = PlanExecution.create("execution-one", _base_plan())
    execution = execution.transition_node(
        "draft", NodeStatus.RUNNING,
        attempt_ref="attempt://draft/1",
        input_artifact_refs=("artifact://task-input",),
    )
    execution = execution.transition_node(
        "draft", NodeStatus.COMPLETED,
        output_artifact_refs=("artifact://draft/v1",),
    )
    completed = execution.node("draft")

    revised_plan = PlanSpec(
        id=execution.plan.id,
        revision=2,
        nodes=(
            execution.plan.nodes[0],
            _node("check", inputs=("draft",), outputs=("review",)),
            execution.plan.nodes[2],
            execution.plan.nodes[3],
        ),
        control_bindings=(
            ControlBinding("draft", "check"),
            ControlBinding("check", "deliver", "condition://accepted"),
        ),
        artifact_bindings=(
            ArtifactBinding("draft", "draft", "check", "draft", SCHEMA),
            ArtifactBinding("check", "review", "deliver", "review", SCHEMA),
        ),
        join_policies=execution.plan.join_policies,
        failure_routes=(),
    )
    revision = PlanRevision(
        id="replace-review",
        base_plan=execution.plan,
        revised_plan=revised_plan,
        replaced_node_ids=("review", "deliver"),
        reason_ref="feedback://review-contract-failed",
    )

    revised = execution.apply_revision(revision)

    assert revised.node("draft") == completed
    assert revised.node("check").status is NodeStatus.PENDING
    assert "review" not in {state.node_id for state in revised.node_executions}
    assert revised.revisions == (revision,)


def test_revision_rejects_completed_nodes_and_changes_to_their_admission_contract():
    execution = PlanExecution.create("execution-two", _base_plan())
    execution = execution.transition_node(
        "draft", NodeStatus.RUNNING, attempt_ref="attempt://draft/1"
    )
    execution = execution.transition_node("draft", NodeStatus.COMPLETED)

    changed_draft = _node("draft", operator="operator://draft/v2", outputs=("draft",))
    tampered = PlanSpec(
        id=execution.plan.id,
        revision=2,
        nodes=(changed_draft,) + execution.plan.nodes[1:],
        control_bindings=execution.plan.control_bindings,
        artifact_bindings=execution.plan.artifact_bindings,
        join_policies=execution.plan.join_policies,
        failure_routes=execution.plan.failure_routes,
    )
    revision = PlanRevision(
        id="rewrite-draft",
        base_plan=execution.plan,
        revised_plan=tampered,
        replaced_node_ids=("draft",),
    )
    with pytest.raises(ContractError, match="only pending"):
        execution.apply_revision(revision)

    changed_admission = PlanSpec(
        id=execution.plan.id,
        revision=2,
        nodes=execution.plan.nodes,
        control_bindings=execution.plan.control_bindings
        + (ControlBinding("repair", "draft", "condition://replay"),),
        artifact_bindings=execution.plan.artifact_bindings,
        join_policies=execution.plan.join_policies,
        failure_routes=execution.plan.failure_routes,
    )
    revision = PlanRevision(
        id="change-completed-input",
        base_plan=execution.plan,
        revised_plan=changed_admission,
        replaced_node_ids=("review",),
    )
    with pytest.raises(ContractError, match="control bindings outside"):
        execution.apply_revision(revision)
    assert changed_draft.operator_ref.endswith("/v2")


def test_terminal_node_cannot_be_replayed_or_have_receipts_rewritten():
    execution = PlanExecution.create("execution-three", _base_plan())
    execution = execution.transition_node(
        "draft", NodeStatus.RUNNING,
        attempt_ref="attempt://draft/1",
        input_artifact_refs=("artifact://task-input",),
    )
    execution = execution.transition_node(
        "draft", NodeStatus.COMPLETED,
        output_artifact_refs=("artifact://draft/v1",),
    )

    with pytest.raises(ContractError, match="cannot be replayed"):
        execution.transition_node(
            "draft", NodeStatus.RUNNING,
            attempt_ref="attempt://draft/2",
        )

    running = PlanExecution.create("execution-four", _base_plan()).transition_node(
        "draft", NodeStatus.RUNNING,
        attempt_ref="attempt://draft/1",
        input_artifact_refs=("artifact://task-input",),
    )
    with pytest.raises(ContractError, match="inputs are immutable"):
        running.transition_node(
            "draft", NodeStatus.COMPLETED,
            input_artifact_refs=("artifact://different-input",),
        )
