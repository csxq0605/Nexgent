"""Correctness gates for Nexgent's typed primitive DAG."""

import asyncio
from dataclasses import replace

import pytest

from nexgent.runtime.contracts import WorkflowNode, WorkflowPrimitive
from nexgent.runtime.graph import (
    GraphExecutionError,
    GraphValidationError,
    TypedDAGRunner,
    PersistentTypedDAGRunner,
    WorkflowGraph,
    artifact_equivalent,
)
from nexgent.runtime.recorder import RunRecorder
from nexgent.runtime.store import SQLiteRunStore


def _node(
    node_id,
    *,
    depends_on=(),
    required=(),
    properties=None,
    output_properties=None,
    bindings=None,
    external_inputs=(),
    effects=(),
    idempotent=True,
):
    return WorkflowNode(
        node_id=node_id,
        run_id="run-graph",
        workflow_id="workflow-graph",
        name=node_id,
        primitive=WorkflowPrimitive.TOOL,
        input_schema={
            "type": "object",
            "required": list(required),
            "properties": properties or {},
        },
        output_schema={
            "type": "object",
            "properties": output_properties or {},
        },
        depends_on=tuple(depends_on),
        effects=tuple(effects),
        idempotent=idempotent,
        metadata={
            "input_bindings": bindings or {},
            "external_inputs": list(external_inputs),
        },
    )


def _graph(*nodes):
    return WorkflowGraph(
        workflow_id="workflow-graph",
        run_id="run-graph",
        nodes=tuple(nodes),
        external_input_schema={
            "type": "object",
            "required": ["x"],
            "properties": {"x": {"type": "number"}},
        },
    )


def test_graph_rejects_cycle_and_missing_dependency():
    cyclic = _graph(
        _node("a", depends_on=("b",)),
        _node("b", depends_on=("a",)),
    )
    with pytest.raises(GraphValidationError, match="cycle"):
        cyclic.validate()

    missing = _graph(_node("a", depends_on=("absent",)))
    with pytest.raises(GraphValidationError, match="missing dependencies"):
        missing.validate()


def test_graph_rejects_unbound_and_incompatible_inputs():
    producer = _node(
        "producer", output_properties={"value": {"type": "string"}}
    )
    unbound = _node(
        "unbound",
        required=("value",),
        properties={"value": {"type": "number"}},
    )
    with pytest.raises(GraphValidationError, match="unbound inputs"):
        _graph(unbound).validate()

    consumer = _node(
        "consumer",
        depends_on=("producer",),
        required=("value",),
        properties={"value": {"type": "number"}},
        bindings={"value": {"node": "producer", "output": "value"}},
    )
    with pytest.raises(GraphValidationError, match="schema mismatch"):
        _graph(producer, consumer).validate()


def test_safe_batches_serialize_conflicting_effects():
    graph = _graph(
        _node("read-a"),
        _node("write-a", effects=("artifact:state",)),
        _node("write-b", effects=("artifact:state",)),
    )

    batches = graph.safe_batches()

    assert batches[0] == ("read-a", "write-a")
    assert batches[1] == ("write-b",)


def test_transitive_reduction_preserves_outputs_and_removes_redundant_edge():
    source = _node(
        "source",
        required=("x",),
        properties={"x": {"type": "number"}},
        output_properties={"value": {"type": "number"}},
        external_inputs=("x",),
    )
    middle = _node(
        "middle",
        depends_on=("source",),
        required=("value",),
        properties={"value": {"type": "number"}},
        output_properties={"doubled": {"type": "number"}},
        bindings={"value": {"node": "source", "output": "value"}},
    )
    terminal = _node(
        "terminal",
        depends_on=("source", "middle"),
        required=("doubled",),
        properties={"doubled": {"type": "number"}},
        output_properties={"answer": {"type": "number"}},
        bindings={"doubled": {"node": "middle", "output": "doubled"}},
    )
    graph = _graph(source, middle, terminal)
    reduced = graph.transitive_reduction()
    executors = {
        "source": lambda data: {"value": data["x"]},
        "middle": lambda data: {"doubled": data["value"] * 2},
        "terminal": lambda data: {"answer": data["doubled"] + 1},
    }

    baseline = asyncio.run(TypedDAGRunner(graph, executors).run({"x": 4}))
    optimized = asyncio.run(TypedDAGRunner(reduced, executors).run({"x": 4}))

    assert reduced.node_map()["terminal"].depends_on == ("middle",)
    assert artifact_equivalent(baseline.outputs, optimized.outputs)
    assert baseline.output_digest == optimized.output_digest


def test_idempotent_cache_hits_only_for_exact_inputs():
    source = _node(
        "source",
        required=("x",),
        properties={"x": {"type": "number"}},
        output_properties={"value": {"type": "number"}},
        external_inputs=("x",),
    )
    calls = []

    def execute(data):
        calls.append(data["x"])
        return {"value": data["x"]}

    cache = {}
    runner = TypedDAGRunner(_graph(source), {"source": execute}, cache=cache)

    first = asyncio.run(runner.run({"x": 2}))
    second = asyncio.run(runner.run({"x": 2}))
    changed = asyncio.run(runner.run({"x": 3}))

    assert first.cache_hits == ()
    assert second.cache_hits == ("source",)
    assert changed.cache_hits == ()
    assert calls == [2, 3]


def test_parallel_batch_and_output_schema_violation_are_observable():
    async def execute(data):
        await asyncio.sleep(0)
        return {"value": data["x"]}

    left = _node(
        "left",
        required=("x",),
        properties={"x": {"type": "number"}},
        output_properties={"value": {"type": "number"}},
        external_inputs=("x",),
    )
    right = replace(left, node_id="right", name="right")
    events = []
    result = asyncio.run(
        TypedDAGRunner(
            _graph(left, right),
            {"left": execute, "right": execute},
            event_callback=events.append,
        ).run({"x": 5})
    )
    assert result.batches == (("left", "right"),)
    assert {event["node_id"] for event in events} == {"left", "right"}

    bad = _node(
        "bad",
        output_properties={"value": {"type": "number"}},
        idempotent=False,
    )
    with pytest.raises(GraphExecutionError, match="expected number"):
        asyncio.run(TypedDAGRunner(_graph(bad), {"bad": lambda _: {"value": "no"}}).run({"x": 1}))


def test_persistent_graph_resumes_in_fresh_runner_and_invalidates_changed_input(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    context = RunRecorder(store, tmp_path).start_run("persistent typed workflow")
    source = replace(
        _node(
            "source",
            required=("x",),
            properties={"x": {"type": "number"}},
            output_properties={"value": {"type": "number"}},
            external_inputs=("x",),
        ),
        run_id=context.run_id,
        workflow_id="durable-workflow",
    )
    sink = replace(
        _node(
            "sink",
            depends_on=("source",),
            required=("value",),
            properties={"value": {"type": "number"}},
            output_properties={"answer": {"type": "number"}},
            bindings={"value": {"node": "source", "output": "value"}},
        ),
        run_id=context.run_id,
        workflow_id="durable-workflow",
    )
    graph = WorkflowGraph(
        workflow_id="durable-workflow",
        run_id=context.run_id,
        nodes=(source, sink),
        external_input_schema=_graph(source).external_input_schema,
    )
    calls = []
    executors = {
        "source": lambda data: calls.append(("source", data["x"])) or {"value": data["x"]},
        "sink": lambda data: calls.append(("sink", data["value"])) or {"answer": data["value"] + 1},
    }

    first = asyncio.run(PersistentTypedDAGRunner(graph, executors, store).run({"x": 2}))
    resumed = asyncio.run(PersistentTypedDAGRunner(graph, executors, store).run({"x": 2}))
    changed = asyncio.run(PersistentTypedDAGRunner(graph, executors, store).run({"x": 3}))

    assert first.cache_hits == ()
    assert resumed.cache_hits == ("source", "sink")
    assert changed.cache_hits == ()
    assert calls == [("source", 2), ("sink", 2), ("source", 3), ("sink", 3)]
    results = store.list_workflow_node_results(
        context.run_id, workflow_id="durable-workflow"
    )
    assert {result.status.value for result in results} == {"succeeded"}
    assert {result.attempt_count for result in results} == {2}
