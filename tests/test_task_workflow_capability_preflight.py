"""Graph compilation rejects malformed host-capability arguments before execution."""

from copy import deepcopy

import pytest

from nexgent.tasks.graph_compiler_repair import compile_with_graph_repair
from nexgent.tasks.orchestration import NodeStatus, PlanExecution
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.self_orchestration_seed import self_orchestration_package
from nexgent.tasks.tools import ContractError, ToolRegistry, ToolSpec
from nexgent.tasks.workflows import plan_from_workflow


def _tool_registry():
    return ToolRegistry([ToolSpec(
        name="test.echo",
        input_schema={"type": "object"},
        output_schema={"type": "object"},
        effect_class="local_compute",
        handler=lambda arguments, context: arguments,
    )])


def _materialize(service, node, *, artifact_edges=(), capability_lease=()):
    workflow = {
        "nodes": [deepcopy(node)],
        "artifact_edges": list(deepcopy(artifact_edges)),
        "outputs": {},
    }
    return service._materialize_workflow(
        self_orchestration_package(),
        "generated",
        list(capability_lease),
        proposed_workflow=workflow,
    )


def test_read_artifact_task_alias_is_rejected_at_compile_time(tmp_path):
    """Regression for episode-363450c3f7064bf5's execution-time KeyError."""
    service = TaskService(tmp_path, tools=ToolRegistry())
    with pytest.raises(ContractError) as rejected:
        _materialize(service, {
            "id": "load_source",
            "method": "read_artifact",
            "params": {"task": {"$input": "input_refs.source"}},
        })

    message = str(rejected.value)
    assert "read_artifact" in message
    assert "unsupported top-level arguments: task" in message
    assert "missing required arguments: artifact_id" in message
    assert len(message) <= 800


def test_graph_repair_receives_read_artifact_contract_error_before_execution(tmp_path):
    package = self_orchestration_package()
    service = TaskService(tmp_path, tools=ToolRegistry())
    base = service._materialize_workflow(package, "main", [])
    execution = PlanExecution.create(
        "capability-preflight",
        plan_from_workflow(base, "self-orchestration-workflow"),
    )
    execution = execution.transition_node(
        "architect", NodeStatus.RUNNING, attempt_ref="attempt://architect/1")
    execution = execution.transition_node("architect", NodeStatus.COMPLETED)
    invalid = {"operations": [{
        "op": "replace_node",
        "node_id": "slot",
        "node": {
            "id": "slot", "method": "read_artifact",
            "params": {"task": {"$input": "input_refs.source"}},
        },
    }]}
    repairs = []

    def repair(request, path):
        repairs.append((request, path))
        return {"operations": [{
            "op": "replace_node",
            "node_id": "slot",
            "node": {
                "id": "slot", "method": "read_artifact",
                "bindings": {"artifact_id": {"$input": "input_refs.source"}},
            },
        }]}

    result = compile_with_graph_repair(
        execution=execution,
        base_workflow=base,
        initial_proposal=invalid,
        patch_id="capability-arguments",
        replaced_node_ids=["slot"],
        materialize_callback=lambda workflow: service._materialize_workflow(
            package, "generated", [], proposed_workflow=workflow),
        repair_callback=repair,
        max_attempts=2,
    )

    assert result.attempt_count == 2
    assert result.diagnostics[0].stage == "materialize"
    assert result.diagnostics[0].error_type == "ContractError"
    assert "artifact_id" in result.diagnostics[0].message
    assert repairs[0][1] == "graph_repair/attempts/2"
    assert result.revised_workflow["nodes"][1]["bindings"] == {
        "artifact_id": {"$input": "input_refs.source"},
    }


def test_delegate_object_shaped_deliverables_are_rejected_at_compile_time(tmp_path):
    """Regression for episode-fe1154b1bbec4d4e's failed delegate admission."""
    service = TaskService(tmp_path, tools=ToolRegistry())
    with pytest.raises(ContractError, match="deliverables.*nonempty bounded list"):
        _materialize(service, {
            "id": "run_skill",
            "method": "delegate",
            "bindings": {"task": {
                "objective": {"$input": "objective"},
                "deliverables": {
                    "result": {"schema": {"type": "object"}},
                },
                "input_refs": {"value": {"$input": "input_refs.value"}},
            }},
        })


def test_graph_repair_receives_delegate_task_shape_error_before_child_creation(tmp_path):
    package = self_orchestration_package()
    service = TaskService(tmp_path, tools=ToolRegistry())
    base = service._materialize_workflow(package, "main", [])
    execution = PlanExecution.create(
        "delegate-preflight",
        plan_from_workflow(base, "self-orchestration-workflow"),
    )
    execution = execution.transition_node(
        "architect", NodeStatus.RUNNING, attempt_ref="attempt://architect/1")
    execution = execution.transition_node("architect", NodeStatus.COMPLETED)
    invalid_task = {
        "objective": {"$input": "objective"},
        "deliverables": {"result": {"schema": {"type": "object"}}},
    }
    repaired_task = {
        "objective": {"$input": "objective"},
        "deliverables": [{"name": "result", "schema": {"type": "object"}}],
    }
    requests = []

    def proposal(task):
        return {"operations": [{
            "op": "replace_node", "node_id": "slot",
            "node": {"id": "slot", "method": "delegate",
                     "bindings": {"task": task}},
        }]}

    def repair(request, path):
        requests.append((request, path))
        return proposal(repaired_task)

    result = compile_with_graph_repair(
        execution=execution,
        base_workflow=base,
        initial_proposal=proposal(invalid_task),
        patch_id="delegate-task-shape",
        replaced_node_ids=["slot"],
        materialize_callback=lambda workflow: service._materialize_workflow(
            package, "generated", [], proposed_workflow=workflow),
        repair_callback=repair,
        max_attempts=2,
    )

    assert result.attempt_count == 2
    assert result.diagnostics[0].stage == "materialize"
    assert result.diagnostics[0].error_type == "ContractError"
    assert "deliverables" in result.diagnostics[0].message
    assert requests[0][1] == "graph_repair/attempts/2"
    assert result.revised_workflow["nodes"][1]["bindings"]["task"] == repaired_task


@pytest.mark.parametrize(("task", "message"), [
    ({"deliverables": [{"name": "result"}]}, "objective"),
    ({"objective": "inspect"}, "deliverables"),
    ({"objective": "inspect", "deliverables": [{}], "input_refs": []},
     "input_refs"),
    ({"objective": "inspect", "deliverables": [{}], "capabilities": {}},
     "capabilities"),
])
def test_delegate_literal_task_requires_basic_child_task_shape(tmp_path, task, message):
    service = TaskService(tmp_path, tools=ToolRegistry())
    with pytest.raises(ContractError, match=message):
        _materialize(service, {
            "id": "delegate",
            "method": "delegate",
            "params": {"task": task},
        })


def test_delegate_task_allows_whole_and_nested_dynamic_bindings(tmp_path):
    service = TaskService(tmp_path, tools=ToolRegistry())
    workflow = {
        "nodes": [
            {"id": "source", "method": "join", "params": {
                "deliverables": [{"name": "result", "schema": {}}],
                "capability": "test.dynamic",
            }},
            {"id": "whole", "method": "delegate", "bindings": {
                "task": {"$node": "source"},
            }},
            {"id": "nested", "method": "delegate", "bindings": {"task": {
                "objective": {"$input": "objective"},
                "deliverables": {"$node": "source.deliverables"},
                "input_refs": {"value": {"$input": "input_refs.value"}},
                "capabilities": [{"$node": "source.capability"}],
            }}},
        ],
        "outputs": {},
    }

    materialized = service._materialize_workflow(
        self_orchestration_package(), "generated", [], proposed_workflow=workflow)
    assert [node["id"] for node in materialized["nodes"]] == [
        "source", "whole", "nested",
    ]


@pytest.mark.parametrize(("method", "params", "missing", "unsupported"), [
    ("publish", {"payload": {"answer": 1}}, "content", "payload"),
    ("delegate", {"objective": "inspect"}, "task", "objective"),
    ("develop_skill", {"constraints": {}, "skill": {}}, "proposal", "skill"),
    ("tool", {"tool_name": "test.echo"}, "name", "tool_name"),
])
def test_capability_preflight_reports_missing_and_unknown_top_level_arguments(
        tmp_path, method, params, missing, unsupported):
    service = TaskService(tmp_path, tools=_tool_registry())
    with pytest.raises(ContractError) as rejected:
        _materialize(
            service,
            {"id": "invalid", "method": method, "params": params},
            capability_lease=["test.echo"],
        )

    message = str(rejected.value)
    assert f"Workflow {method} node 'invalid'" in message
    assert f"unsupported top-level arguments: {unsupported}" in message
    assert f"missing required arguments: {missing}" in message
    assert len(message) <= 800


def test_dynamic_bindings_and_artifact_ports_satisfy_capability_contracts(tmp_path):
    service = TaskService(tmp_path, tools=_tool_registry())
    workflow = {
        "nodes": [
            {"id": "source", "method": "join", "params": {
                "content": {"answer": 1},
                "task": {"objective": "inspect", "deliverables": []},
                "proposal": {"schema": "dynamic"},
                "arguments": {"value": 1},
            }},
            {"id": "read", "method": "read_artifact", "bindings": {
                "artifact_id": {"$input": "input_refs.source"},
            }},
            {"id": "publish", "method": "publish", "params": {
                "name": "result",
            }},
            {"id": "delegate", "method": "delegate", "bindings": {
                "task": {"$node": "source.task"},
                "package_id": {"$input": "package_id"},
            }},
            {"id": "develop", "method": "develop_skill", "params": {
                "constraints": {"allowed_rpc_methods": [], "allowed_tools": []},
            }, "bindings": {
                "proposal": {"$node": "source.proposal"},
            }},
            {"id": "tool", "method": "tool", "params": {
                "name": "test.echo",
            }},
        ],
        "artifact_edges": [
            {"producer_node": "source", "output_port": "content",
             "consumer_node": "publish", "input_port": "content"},
            {"producer_node": "source", "output_port": "arguments.value",
             "consumer_node": "tool", "input_port": "arguments.value"},
        ],
        "outputs": {},
    }

    materialized = service._materialize_workflow(
        self_orchestration_package(),
        "generated",
        ["test.echo"],
        proposed_workflow=workflow,
    )
    assert [node["method"] for node in materialized["nodes"]] == [
        "join", "read_artifact", "publish", "delegate", "develop_skill", "tool",
    ]


def test_capability_error_remains_bounded_for_many_long_unknown_fields(tmp_path):
    service = TaskService(tmp_path, tools=ToolRegistry())
    params = {f"unknown_{index}_" + "x" * 1000: index for index in range(20)}
    with pytest.raises(ContractError) as rejected:
        _materialize(service, {
            "id": "publish",
            "method": "publish",
            "params": params,
        })

    assert "... (14 more)" in str(rejected.value)
    assert len(str(rejected.value)) <= 800
