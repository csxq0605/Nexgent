from copy import deepcopy

import pytest

from nexgent.tasks.graph_compiler_repair import (
    GRAPH_REPAIR_REQUEST_SCHEMA,
    GraphRepairExhausted,
    compile_with_graph_repair,
)
from nexgent.tasks.orchestration import NodeStatus, PlanExecution
from nexgent.tasks.tools import ContractError
from nexgent.tasks.workflows import plan_from_workflow


def _workflow():
    return {
        "nodes": [
            {"id": "seed", "method": "ask", "role_ref": "role://seed"},
            {"id": "work", "method": "ask", "role_ref": "role://worker"},
        ],
        "artifact_edges": [{
            "producer_node": "seed",
            "output_port": "value",
            "consumer_node": "work",
            "input_port": "seed",
            "schema_ref": "schema://value",
        }],
        "outputs": {"result": {"$node": "work"}},
    }


def _execution():
    execution = PlanExecution.create(
        "repair-execution", plan_from_workflow(_workflow(), "repair-plan")
    )
    execution = execution.transition_node(
        "seed", NodeStatus.RUNNING, attempt_ref="attempt://seed/1"
    )
    return execution.transition_node("seed", NodeStatus.COMPLETED)


def _replace_work(role="role://worker-v2"):
    return {
        "operations": [{
            "op": "replace_node",
            "node_id": "work",
            "node": {"id": "work", "method": "ask", "role_ref": role},
        }],
    }


def _compile(initial, repair, *, materialize=lambda workflow: workflow,
             attempts=3, scope=("work",)):
    return compile_with_graph_repair(
        execution=_execution(),
        base_workflow=_workflow(),
        initial_proposal=initial,
        patch_id="repair-work",
        replaced_node_ids=scope,
        materialize_callback=materialize,
        repair_callback=repair,
        max_attempts=attempts,
    )


def test_invalid_initial_proposal_is_repaired_at_deterministic_rpc_path():
    initial = {"operations": [{"op": "remove_node", "node_id": "missing"}]}
    original = deepcopy(initial)
    calls = []

    def repair(request, path):
        calls.append((deepcopy(request), path))
        request["failed_proposal"].clear()
        return _replace_work()

    result = _compile(initial, repair)

    assert initial == original
    assert result.attempt_count == 2
    assert result.revision.replaced_node_ids == ("work",)
    assert result.diagnostics[0].stage == "proposal"
    assert calls[0][1] == "graph_repair/attempts/2"
    assert calls[0][0]["schema"] == GRAPH_REPAIR_REQUEST_SCHEMA
    assert calls[0][0]["remaining_attempts"] == 2
    assert calls[0][0]["base_workflow"] == _workflow()
    assert result.accepted_proposal == _replace_work()


def test_materialization_contract_and_permission_errors_are_repairable():
    calls = []

    def materialize(workflow):
        role = next(node for node in workflow["nodes"] if node["id"] == "work")["role_ref"]
        if role != "role://leased":
            raise PermissionError("role is outside the current capability lease")
        return workflow

    def repair(request, path):
        calls.append((request, path))
        return _replace_work("role://leased")

    result = _compile(_replace_work("role://unleased"), repair,
                      materialize=materialize)

    assert result.attempt_count == 2
    assert result.diagnostics[0].stage == "materialize"
    assert result.diagnostics[0].error_type == "PermissionError"
    assert calls[0][0]["diagnostic"]["stage"] == "materialize"


def test_plan_revision_scope_error_can_be_repaired():
    initial = {
        "operations": [{
            "op": "replace_node",
            "node_id": "seed",
            "node": {"id": "seed", "method": "ask", "role_ref": "role://changed"},
        }],
    }
    observed = []

    def repair(request, path):
        observed.append(request["diagnostic"])
        return _replace_work()

    result = _compile(initial, repair)

    assert result.diagnostics[0].stage == "plan_revision"
    assert "outside the pending subgraph" in result.diagnostics[0].message
    assert observed == [result.diagnostics[0].as_dict()]


def test_full_revised_workflow_api_succeeds_without_repair_rpc():
    candidate = _workflow()
    candidate["nodes"][1]["role_ref"] = "role://worker-v3"

    result = _compile(
        {"revised_workflow": candidate},
        lambda request, path: pytest.fail("valid proposal must not request repair"),
    )

    assert result.attempt_count == 1
    assert result.diagnostics == ()
    assert result.revised_workflow["nodes"][1]["role_ref"] == "role://worker-v3"


def test_dynamic_replacement_scope_may_be_repaired_with_the_proposal():
    initial = {**_replace_work(), "replaced_node_ids": ["seed"]}

    def repair(request, path):
        return {**_replace_work(), "replaced_node_ids": ["work"]}

    result = _compile(initial, repair, scope=None)

    assert result.attempt_count == 2
    assert result.revision.replaced_node_ids == ("work",)


def test_repair_exhaustion_reports_every_attempt_and_honors_total_bound():
    paths = []

    def repair(request, path):
        paths.append(path)
        return {"operations": [{"op": "remove_node", "node_id": "missing"}]}

    with pytest.raises(GraphRepairExhausted) as raised:
        _compile(
            {"operations": [{"op": "remove_node", "node_id": "missing"}]},
            repair,
            attempts=3,
        )

    assert paths == ["graph_repair/attempts/2", "graph_repair/attempts/3"]
    assert len(raised.value.diagnostics) == 3
    assert raised.value.as_dict()["status"] == "exhausted"


def test_repair_callback_failures_propagate_without_reclassification():
    failure = TimeoutError("provider unavailable")

    def repair(request, path):
        raise failure

    with pytest.raises(TimeoutError) as raised:
        _compile(
            {"operations": [{"op": "remove_node", "node_id": "missing"}]},
            repair,
        )
    assert raised.value is failure


def test_materialization_infrastructure_interruptions_are_not_repaired():
    calls = []

    def materialize(workflow):
        raise InterruptedError("task cancelled")

    with pytest.raises(InterruptedError, match="cancelled"):
        _compile(_replace_work(), lambda request, path: calls.append(path),
                 materialize=materialize)
    assert calls == []


@pytest.mark.parametrize("attempts", [0, 9, True])
def test_compile_attempt_bound_is_strict(attempts):
    with pytest.raises(ContractError, match="max_attempts"):
        _compile(_replace_work(), lambda request, path: None, attempts=attempts)


def test_fixed_rule_configuration_errors_do_not_consume_repair_calls():
    calls = []
    with pytest.raises(ContractError, match="patch_id"):
        compile_with_graph_repair(
            execution=_execution(),
            base_workflow=_workflow(),
            initial_proposal=_replace_work(),
            patch_id="INVALID",
            replaced_node_ids=("work",),
            materialize_callback=lambda workflow: workflow,
            repair_callback=lambda request, path: calls.append(path),
        )
    with pytest.raises(ContractError, match="only pending"):
        compile_with_graph_repair(
            execution=_execution(),
            base_workflow=_workflow(),
            initial_proposal=_replace_work(),
            patch_id="valid-id",
            replaced_node_ids=("seed",),
            materialize_callback=lambda workflow: workflow,
            repair_callback=lambda request, path: calls.append(path),
        )
    assert calls == []


def test_invalid_or_mismatched_base_is_configuration_failure_not_model_feedback():
    calls = []
    mismatched = _workflow()
    mismatched["nodes"][0]["role_ref"] = "role://different"

    with pytest.raises(ContractError, match="does not match"):
        compile_with_graph_repair(
            execution=_execution(),
            base_workflow=mismatched,
            initial_proposal=_replace_work(),
            patch_id="valid-id",
            replaced_node_ids=("work",),
            materialize_callback=lambda workflow: workflow,
            repair_callback=lambda request, path: calls.append(path),
        )
    assert calls == []
