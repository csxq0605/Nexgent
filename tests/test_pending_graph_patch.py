from copy import deepcopy

import pytest

from nexgent.tasks.orchestration import NodeStatus, PlanExecution
from nexgent.tasks.pending_graph_patch import (
    PendingGraphPatch,
    apply_graph_ops,
    compile_pending_graph_patch,
)
from nexgent.tasks.tools import ContractError
from nexgent.tasks.workflows import WorkflowError, plan_from_workflow


SCHEMA = "schema://work-item"


def _base_workflow():
    return {
        "nodes": [
            {"id": "seed", "method": "ask", "role_ref": "role://intake"},
            {"id": "explore", "method": "ask", "role_ref": "role://explorer"},
            {"id": "critique", "method": "ask", "role_ref": "role://critic"},
            {"id": "deliver", "method": "publish", "role_ref": "role://publisher"},
        ],
        "artifact_edges": [
            {
                "producer_node": "seed",
                "output_port": "payload",
                "consumer_node": "explore",
                "input_port": "seed",
                "schema_ref": SCHEMA,
            },
            {
                "producer_node": "explore",
                "output_port": "finding",
                "consumer_node": "critique",
                "input_port": "finding",
                "schema_ref": SCHEMA,
            },
            {
                "producer_node": "critique",
                "output_port": "review",
                "consumer_node": "deliver",
                "input_port": "review",
                "schema_ref": SCHEMA,
            },
        ],
    }


def _revised_workflow():
    return {
        "nodes": [
            {"id": "seed", "method": "ask", "role_ref": "role://intake"},
            {"id": "source_a", "method": "tool", "role_ref": "role://source-a"},
            {"id": "source_b", "method": "delegate", "role_ref": "role://source-b"},
            {"id": "compare", "method": "join", "role_ref": "role://comparison"},
            {"id": "deliver", "method": "publish", "role_ref": "role://publisher-v2"},
        ],
        "artifact_edges": [
            {
                "producer_node": "seed",
                "output_port": "payload",
                "consumer_node": "source_a",
                "input_port": "seed",
                "schema_ref": SCHEMA,
            },
            {
                "producer_node": "seed",
                "output_port": "payload",
                "consumer_node": "source_b",
                "input_port": "seed",
                "schema_ref": SCHEMA,
            },
            {
                "producer_node": "source_a",
                "output_port": "finding",
                "consumer_node": "compare",
                "input_port": "source_a",
                "schema_ref": SCHEMA,
            },
            {
                "producer_node": "source_b",
                "output_port": "finding",
                "consumer_node": "compare",
                "input_port": "source_b",
                "schema_ref": SCHEMA,
            },
            {
                "producer_node": "compare",
                "output_port": "review",
                "consumer_node": "deliver",
                "input_port": "review",
                "schema_ref": SCHEMA,
            },
        ],
    }


def _execution_with_completed_seed():
    execution = PlanExecution.create(
        "patch-execution", plan_from_workflow(_base_workflow(), "adaptive-plan")
    )
    execution = execution.transition_node(
        "seed", NodeStatus.RUNNING, attempt_ref="attempt://seed/1"
    )
    return execution.transition_node(
        "seed",
        NodeStatus.COMPLETED,
        output_artifact_refs=("artifact://seed/payload",),
    )


def _patch(execution, workflow=None, replaced=None):
    return PendingGraphPatch(
        id="replace-pending-graph",
        base_plan_ref=execution.plan.ref,
        replaced_node_ids=replaced or ("explore", "critique", "deliver"),
        revised_workflow=workflow or _revised_workflow(),
        reason_ref="feedback://change-strategy",
    )


def test_compiles_general_multi_node_and_edge_replacement_purely():
    execution = _execution_with_completed_seed()
    revision = compile_pending_graph_patch(execution, _patch(execution))

    assert revision.base_plan is execution.plan
    assert revision.revised_plan.revision == 2
    assert revision.replaced_node_ids == ("explore", "critique", "deliver")
    assert {node.id for node in revision.revised_plan.nodes} == {
        "seed", "source_a", "source_b", "compare", "deliver"
    }
    assert len(revision.revised_plan.artifact_bindings) == 5
    assert execution.plan.revision == 1
    assert execution.node("seed").status is NodeStatus.COMPLETED
    assert execution.revisions == ()


def test_patch_snapshots_workflow_and_compilation_is_deterministic():
    execution = _execution_with_completed_seed()
    candidate = _revised_workflow()
    patch = _patch(execution, candidate)
    candidate["nodes"].clear()
    exposed = patch.revised_workflow
    exposed["artifact_edges"].clear()

    first = compile_pending_graph_patch(execution, patch)
    second = compile_pending_graph_patch(execution, patch)

    assert first == second
    assert first.ref == second.ref
    assert len(first.revised_plan.nodes) == 5
    assert len(first.revised_plan.artifact_bindings) == 5


def test_rejects_stale_patch_before_compiling_candidate():
    execution = _execution_with_completed_seed()
    patch = PendingGraphPatch(
        id="stale-patch",
        base_plan_ref="plan-" + "0" * 64,
        replaced_node_ids=("explore",),
        revised_workflow={"nodes": []},
    )

    with pytest.raises(ContractError, match="stale"):
        compile_pending_graph_patch(execution, patch)


def test_rejects_completed_replacement_scope():
    execution = _execution_with_completed_seed()

    with pytest.raises(ContractError, match="only pending"):
        compile_pending_graph_patch(
            execution,
            _patch(execution, replaced=("seed", "explore", "critique", "deliver")),
        )


def test_rejects_changes_to_a_node_outside_the_pending_scope():
    execution = _execution_with_completed_seed()
    candidate = _revised_workflow()
    candidate["nodes"][0]["role_ref"] = "role://rewritten-intake"

    with pytest.raises(ContractError, match="node outside"):
        compile_pending_graph_patch(execution, _patch(execution, candidate))


def test_rejects_disconnected_additions():
    execution = _execution_with_completed_seed()
    candidate = deepcopy(_revised_workflow())
    candidate["nodes"].append({"id": "orphan", "method": "ask"})

    with pytest.raises(ContractError, match="connect to the replaced"):
        compile_pending_graph_patch(execution, _patch(execution, candidate))


def test_workflow_validation_rejects_invalid_candidate_edges():
    execution = _execution_with_completed_seed()
    candidate = _revised_workflow()
    candidate["artifact_edges"][0]["producer_node"] = "missing"

    with pytest.raises(WorkflowError, match="valid producers"):
        compile_pending_graph_patch(execution, _patch(execution, candidate))


def test_patch_contract_rejects_duplicates_and_non_finite_workflows():
    execution = _execution_with_completed_seed()
    with pytest.raises(ContractError, match="unique bounded"):
        PendingGraphPatch(
            "duplicate-scope",
            execution.plan.ref,
            ("explore", "explore"),
            _revised_workflow(),
        )
    with pytest.raises(ContractError, match="finite JSON"):
        PendingGraphPatch(
            "non-finite",
            execution.plan.ref,
            ("explore",),
            {"nodes": [], "value": float("nan")},
        )


def test_graph_ops_apply_general_node_and_edge_changes_without_mutating_inputs():
    base = _base_workflow()
    base["control_edges"] = [{"from": "explore", "to": "deliver"}]
    original = deepcopy(base)
    proposal = {
        "operations": [
            {"op": "remove_node", "node_id": "explore"},
            {"op": "remove_node", "node_id": "critique"},
            {"op": "replace_node", "node_id": "deliver", "node": {
                "id": "deliver", "method": "publish", "role_ref": "role://new-output",
            }},
            {"op": "add_node", "node": {
                "id": "source_a", "method": "tool", "role_ref": "role://arbitrary-a",
            }},
            {"op": "add_node", "node": {
                "id": "source_b", "method": "delegate", "role_ref": "role://arbitrary-b",
            }},
            {"op": "add_node", "node": {
                "id": "compare", "method": "join", "role_ref": "role://arbitrary-join",
            }},
            {"op": "add_control_edge", "edge": {
                "from": "source_a", "to": "compare",
            }},
            *(
                {"op": "add_artifact_edge", "edge": edge}
                for edge in _revised_workflow()["artifact_edges"]
            ),
        ],
        "outputs": {"result": {"$node": "deliver"}},
        "revision_rules": [{
            "id": "compare-proposal",
            "after_node": "compare",
            "when": {"path": "revise", "equals": True},
            "proposal_path": "proposal",
            "replace_node_ids": ["deliver"],
        }],
    }
    original_proposal = deepcopy(proposal)

    revised = apply_graph_ops(base, proposal)

    assert base == original
    assert proposal == original_proposal
    assert {node["id"] for node in revised["nodes"]} == {
        "seed", "source_a", "source_b", "compare", "deliver",
    }
    assert len(revised["artifact_edges"]) == 5
    assert revised["control_edges"] == [{"from": "source_a", "to": "compare"}]
    assert revised["outputs"] == {"result": {"$node": "deliver"}}
    assert revised["revision_rules"][0]["after_node"] == "compare"


def test_remove_node_atomically_removes_incident_control_and_artifact_edges():
    base = _base_workflow()
    base["control_edges"] = [
        {"from": "seed", "to": "explore"},
        {"from": "explore", "to": "critique"},
    ]

    revised = apply_graph_ops(base, {
        "operations": [{"op": "remove_node", "node_id": "explore"}],
    })

    assert {node["id"] for node in revised["nodes"]} == {"seed", "critique", "deliver"}
    assert revised["control_edges"] == []
    assert all(
        "explore" not in (edge["producer_node"], edge["consumer_node"])
        for edge in revised["artifact_edges"]
    )
    assert len(base["artifact_edges"]) == 3
    assert len(base["control_edges"]) == 2


def test_graph_ops_remove_and_add_edges_by_exact_value():
    base = _base_workflow()
    old_control = {"from": "seed", "to": "explore"}
    old_artifact = deepcopy(base["artifact_edges"][1])
    base["control_edges"] = [old_control]

    revised = apply_graph_ops(base, {"operations": [
        {"op": "remove_control_edge", "edge": old_control},
        {"op": "add_control_edge", "edge": {"from": "seed", "to": "critique"}},
        {"op": "remove_artifact_edge", "edge": old_artifact},
        {"op": "add_artifact_edge", "edge": {
            **old_artifact,
            "producer_node": "seed",
            "output_port": "payload",
        }},
    ]})

    assert revised["control_edges"] == [{"from": "seed", "to": "critique"}]
    assert old_artifact not in revised["artifact_edges"]


@pytest.mark.parametrize("operation, message", [
    ({"op": "add_node", "node": {"id": "seed", "method": "ask"}}, "already exists"),
    ({"op": "remove_node", "node_id": "missing"}, "exactly one"),
    ({"op": "replace_node", "node_id": "explore",
      "node": {"id": "renamed", "method": "ask"}}, "preserve"),
    ({"op": "remove_control_edge", "edge": {"from": "seed", "to": "missing"}},
     "exactly one"),
    ({"op": "invent_node", "node": {"id": "x", "method": "ask"}}, "unsupported"),
])
def test_graph_ops_reject_invalid_operations(operation, message):
    with pytest.raises(ContractError, match=message):
        apply_graph_ops(_base_workflow(), {"operations": [operation]})


def test_graph_ops_reject_duplicate_operations_and_invalid_final_graph():
    duplicate = {"op": "add_node", "node": {"id": "extra", "method": "ask"}}
    with pytest.raises(ContractError, match="duplicate node"):
        apply_graph_ops(_base_workflow(), {"operations": [duplicate, duplicate]})

    with pytest.raises(WorkflowError, match="valid producers"):
        apply_graph_ops(_base_workflow(), {"operations": [{
            "op": "add_artifact_edge",
            "edge": {
                "producer_node": "missing",
                "output_port": "x",
                "consumer_node": "deliver",
                "input_port": "x",
            },
        }]})


def test_graph_ops_validate_outputs_and_revision_rules():
    with pytest.raises(WorkflowError, match="unknown node"):
        apply_graph_ops(_base_workflow(), {
            "operations": [],
            "outputs": {"value": {"$node": "missing"}},
        })
    with pytest.raises(WorkflowError, match="revision rule"):
        apply_graph_ops(_base_workflow(), {
            "operations": [],
            "revision_rules": [{"id": "invalid"}],
        })
