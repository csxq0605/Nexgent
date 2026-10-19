"""Typed workflow DAG validation, safe staging, and deterministic execution.

This is the correctness-first graph layer inspired by Ayo's primitive-level
orchestration.  It does not implement inference-engine scheduling.  The graph
must validate and optimized execution must remain output-equivalent before any
performance claim is made.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
from dataclasses import dataclass, field, replace
from typing import Any, Awaitable, Callable, Mapping, Optional

from .contracts import (
    EventKind,
    ExecutionEvent,
    SourceType,
    WorkflowNode,
    WorkflowNodeResult,
    WorkflowNodeStatus,
    new_id,
    now_ns,
)
from .store import SQLiteRunStore


class GraphValidationError(ValueError):
    """Raised when a graph cannot be executed without ambiguous semantics."""


class GraphExecutionError(RuntimeError):
    """Raised when a primitive violates its declared runtime contract."""


def _digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        ).encode("utf-8")
    ).hexdigest()


def _matches_type(value: Any, expected: str) -> bool:
    checks = {
        "object": lambda item: isinstance(item, dict),
        "array": lambda item: isinstance(item, (list, tuple)),
        "string": lambda item: isinstance(item, str),
        "number": lambda item: isinstance(item, (int, float)) and not isinstance(item, bool),
        "integer": lambda item: isinstance(item, int) and not isinstance(item, bool),
        "boolean": lambda item: isinstance(item, bool),
        "null": lambda item: item is None,
    }
    checker = checks.get(expected)
    return True if checker is None else checker(value)


def validate_value(schema: Mapping[str, Any], value: Any, *, label: str) -> None:
    """Validate the small JSON-Schema subset used by workflow primitives."""

    if not schema:
        return
    expected_type = schema.get("type")
    if isinstance(expected_type, str) and not _matches_type(value, expected_type):
        raise GraphExecutionError(
            f"{label} expected {expected_type}, received {type(value).__name__}"
        )
    if expected_type == "object" and isinstance(value, dict):
        required = tuple(schema.get("required") or ())
        missing = [name for name in required if name not in value]
        if missing:
            raise GraphExecutionError(f"{label} is missing required fields: {missing}")
        properties = schema.get("properties") or {}
        for name, property_schema in properties.items():
            if name in value and isinstance(property_schema, dict):
                validate_value(property_schema, value[name], label=f"{label}.{name}")


def _declared_property_type(schema: Mapping[str, Any], name: str) -> Optional[str]:
    properties = schema.get("properties") or {}
    property_schema = properties.get(name) if isinstance(properties, dict) else None
    if isinstance(property_schema, dict) and isinstance(property_schema.get("type"), str):
        return property_schema["type"]
    return None


@dataclass(frozen=True)
class WorkflowGraph:
    workflow_id: str
    run_id: str
    nodes: tuple[WorkflowNode, ...]
    external_input_schema: dict[str, Any] = field(default_factory=dict)
    schema_version: str = "1.0"

    def node_map(self) -> dict[str, WorkflowNode]:
        return {node.node_id: node for node in self.nodes}

    def validate(self) -> None:
        if self.schema_version != "1.0":
            raise GraphValidationError("unsupported workflow graph schema")
        if not self.workflow_id.strip() or not self.run_id.strip():
            raise GraphValidationError("workflow_id and run_id are required")
        if not self.nodes:
            raise GraphValidationError("workflow graph needs at least one node")
        nodes = self.node_map()
        if len(nodes) != len(self.nodes):
            raise GraphValidationError("workflow node ids must be unique")
        for node in self.nodes:
            node.validate()
            if node.run_id != self.run_id or node.workflow_id != self.workflow_id:
                raise GraphValidationError(
                    f"node {node.node_id} belongs to another run or workflow"
                )
            missing = sorted(set(node.depends_on) - nodes.keys())
            if missing:
                raise GraphValidationError(
                    f"node {node.node_id} has missing dependencies: {missing}"
                )
            self._validate_bindings(node, nodes)
        self.topological_order()

    def _validate_bindings(
        self, node: WorkflowNode, nodes: Mapping[str, WorkflowNode]
    ) -> None:
        bindings = node.metadata.get("input_bindings") or {}
        if not isinstance(bindings, dict):
            raise GraphValidationError(
                f"node {node.node_id} input_bindings must be an object"
            )
        required = set(node.input_schema.get("required") or ())
        external = set(node.metadata.get("external_inputs") or ())
        missing_required = required - bindings.keys() - external
        if missing_required:
            raise GraphValidationError(
                f"node {node.node_id} has unbound inputs: {sorted(missing_required)}"
            )
        for input_name, binding in bindings.items():
            if not isinstance(binding, dict):
                raise GraphValidationError(
                    f"node {node.node_id} binding {input_name} must be an object"
                )
            producer_id = binding.get("node")
            output_name = binding.get("output")
            if producer_id not in nodes or producer_id not in node.depends_on:
                raise GraphValidationError(
                    f"node {node.node_id} binding {input_name} references a non-dependency"
                )
            if not isinstance(output_name, str) or not output_name:
                raise GraphValidationError(
                    f"node {node.node_id} binding {input_name} needs an output field"
                )
            expected = _declared_property_type(node.input_schema, input_name)
            produced = _declared_property_type(nodes[producer_id].output_schema, output_name)
            if expected and produced and expected != produced:
                raise GraphValidationError(
                    f"schema mismatch for {node.node_id}.{input_name}: "
                    f"expected {expected}, producer declares {produced}"
                )

    def topological_order(self) -> tuple[str, ...]:
        nodes = self.node_map()
        remaining = {node_id: set(node.depends_on) for node_id, node in nodes.items()}
        order = []
        while remaining:
            ready = sorted(node_id for node_id, deps in remaining.items() if not deps)
            if not ready:
                raise GraphValidationError(
                    f"workflow contains a dependency cycle among {sorted(remaining)}"
                )
            order.extend(ready)
            for node_id in ready:
                remaining.pop(node_id)
            for deps in remaining.values():
                deps.difference_update(ready)
        return tuple(order)

    def safe_batches(self) -> tuple[tuple[str, ...], ...]:
        """Return deterministic parallel batches with no declared effect collision."""

        self.validate()
        nodes = self.node_map()
        completed: set[str] = set()
        batches: list[tuple[str, ...]] = []
        while len(completed) < len(nodes):
            ready = sorted(
                node_id
                for node_id, node in nodes.items()
                if node_id not in completed and set(node.depends_on) <= completed
            )
            if not ready:
                raise GraphValidationError("workflow cannot make progress")
            selected = []
            occupied_effects: set[str] = set()
            for node_id in ready:
                effects = set(nodes[node_id].effects)
                if effects & occupied_effects:
                    continue
                selected.append(node_id)
                occupied_effects.update(effects)
            if not selected:
                selected = [ready[0]]
            batch = tuple(selected)
            batches.append(batch)
            completed.update(batch)
        return tuple(batches)

    def transitive_reduction(self) -> "WorkflowGraph":
        """Remove redundant direct dependencies while preserving reachability."""

        self.validate()
        nodes = self.node_map()

        def reachable(start: str, target: str, *, omit: tuple[str, str]) -> bool:
            children: dict[str, set[str]] = {node_id: set() for node_id in nodes}
            for candidate in nodes.values():
                for dependency in candidate.depends_on:
                    if (dependency, candidate.node_id) != omit:
                        children[dependency].add(candidate.node_id)
            frontier = [start]
            seen = {start}
            while frontier:
                current = frontier.pop()
                if current == target:
                    return True
                for child in children[current]:
                    if child not in seen:
                        seen.add(child)
                        frontier.append(child)
            return False

        reduced = []
        for node in self.nodes:
            kept = tuple(
                dependency
                for dependency in node.depends_on
                if not reachable(
                    dependency,
                    node.node_id,
                    omit=(dependency, node.node_id),
                )
            )
            reduced.append(replace(node, depends_on=kept))
        graph = replace(self, nodes=tuple(reduced))
        graph.validate()
        return graph


PrimitiveExecutor = Callable[
    [dict[str, Any]], Any | Awaitable[Any]
]
GraphEventCallback = Callable[[dict[str, Any]], None]


@dataclass(frozen=True)
class GraphRunResult:
    outputs: dict[str, Any]
    batches: tuple[tuple[str, ...], ...]
    cache_hits: tuple[str, ...]
    output_digest: str


class TypedDAGRunner:
    """Execute validated primitives with effect-safe parallelism and exact caching."""

    def __init__(
        self,
        graph: WorkflowGraph,
        executors: Mapping[str, PrimitiveExecutor],
        *,
        cache: Optional[dict[str, Any]] = None,
        event_callback: Optional[GraphEventCallback] = None,
    ) -> None:
        graph.validate()
        missing = sorted(set(graph.node_map()) - executors.keys())
        if missing:
            raise GraphValidationError(f"missing primitive executors: {missing}")
        self.graph = graph
        self.executors = dict(executors)
        self.cache = cache if cache is not None else {}
        self.event_callback = event_callback

    def _inputs(
        self,
        node: WorkflowNode,
        external_inputs: Mapping[str, Any],
        outputs: Mapping[str, Any],
    ) -> dict[str, Any]:
        result = {
            name: external_inputs[name]
            for name in node.metadata.get("external_inputs") or ()
            if name in external_inputs
        }
        for name, binding in (node.metadata.get("input_bindings") or {}).items():
            producer = outputs[binding["node"]]
            if not isinstance(producer, dict) or binding["output"] not in producer:
                raise GraphExecutionError(
                    f"producer {binding['node']} did not emit {binding['output']}"
                )
            result[name] = producer[binding["output"]]
        validate_value(node.input_schema, result, label=f"{node.node_id}.input")
        return result

    def _cache_key(self, node: WorkflowNode, inputs: Mapping[str, Any]) -> str:
        return _digest(
            {
                "node_id": node.node_id,
                "inputs": inputs,
                "metadata": node.metadata,
                "output_schema": node.output_schema,
            }
        )

    async def _execute_node(
        self,
        node: WorkflowNode,
        inputs: dict[str, Any],
    ) -> tuple[Any, bool]:
        cache_key = self._cache_key(node, inputs)
        if node.idempotent and cache_key in self.cache:
            return self.cache[cache_key], True
        if self.event_callback:
            self.event_callback({"phase": "started", "node_id": node.node_id})
        value = self.executors[node.node_id](inputs)
        if inspect.isawaitable(value):
            value = await value
        validate_value(node.output_schema, value, label=f"{node.node_id}.output")
        if node.idempotent:
            self.cache[cache_key] = value
        if self.event_callback:
            self.event_callback(
                {"phase": "finished", "node_id": node.node_id, "output_digest": _digest(value)}
            )
        return value, False

    async def run(self, external_inputs: Optional[Mapping[str, Any]] = None) -> GraphRunResult:
        external = dict(external_inputs or {})
        validate_value(
            self.graph.external_input_schema,
            external,
            label=f"{self.graph.workflow_id}.external_input",
        )
        outputs: dict[str, Any] = {}
        cache_hits = []
        batches = self.graph.safe_batches()
        nodes = self.graph.node_map()
        for batch in batches:
            prepared = [
                (node_id, self._inputs(nodes[node_id], external, outputs))
                for node_id in batch
            ]
            resolved = await asyncio.gather(
                *(
                    self._execute_node(nodes[node_id], inputs)
                    for node_id, inputs in prepared
                )
            )
            for (node_id, _), (value, cache_hit) in zip(prepared, resolved):
                outputs[node_id] = value
                if cache_hit:
                    cache_hits.append(node_id)
        terminal_ids = set(nodes)
        for node in nodes.values():
            terminal_ids.difference_update(node.depends_on)
        terminal_outputs = {node_id: outputs[node_id] for node_id in sorted(terminal_ids)}
        return GraphRunResult(
            outputs=outputs,
            batches=batches,
            cache_hits=tuple(cache_hits),
            output_digest=_digest(terminal_outputs),
        )


class PersistentTypedDAGRunner(TypedDAGRunner):
    """Typed DAG execution whose node truth survives process restarts.

    Node definitions and results are written to ``SQLiteRunStore``.  A node is
    reused only when both its stored status is succeeded and its current input
    digest matches, so resume cannot silently consume stale upstream output.
    """

    def __init__(
        self,
        graph: WorkflowGraph,
        executors: Mapping[str, PrimitiveExecutor],
        store: SQLiteRunStore,
        *,
        event_callback: Optional[GraphEventCallback] = None,
    ) -> None:
        super().__init__(graph, executors, event_callback=event_callback)
        self.store = store
        existing = {
            node.node_id
            for node in store.list_workflow_nodes(
                graph.run_id, workflow_id=graph.workflow_id
            )
        }
        for node in graph.nodes:
            if node.node_id not in existing:
                store.put_workflow_node(node)

    def _event(self, node: WorkflowNode, phase: str, **payload: Any) -> None:
        self.store.append_event(
            ExecutionEvent(
                event_id=new_id("event"),
                run_id=self.graph.run_id,
                kind=EventKind.WORKFLOW,
                source_type=SourceType.WORKFLOW,
                source_id=self.graph.workflow_id,
                workflow_node_id=node.node_id,
                payload={"phase": phase, **payload},
            )
        )

    async def _execute_node(
        self,
        node: WorkflowNode,
        inputs: dict[str, Any],
    ) -> tuple[Any, bool]:
        input_digest = _digest(inputs)
        previous = self.store.get_workflow_node_result(
            self.graph.run_id, self.graph.workflow_id, node.node_id
        )
        if (
            node.idempotent
            and previous is not None
            and previous.status is WorkflowNodeStatus.SUCCEEDED
            and previous.input_digest == input_digest
        ):
            self._event(node, "cache_hit", input_digest=input_digest)
            return previous.output, True

        attempt_count = (previous.attempt_count if previous else 0) + 1
        started_at = now_ns()
        self.store.put_workflow_node_result(
            WorkflowNodeResult(
                node_id=node.node_id,
                run_id=self.graph.run_id,
                workflow_id=self.graph.workflow_id,
                status=WorkflowNodeStatus.RUNNING,
                input_digest=input_digest,
                attempt_count=attempt_count,
                started_at_ns=started_at,
            )
        )
        self._event(node, "started", input_digest=input_digest, attempt=attempt_count)
        if self.event_callback:
            self.event_callback({"phase": "started", "node_id": node.node_id})
        try:
            value = self.executors[node.node_id](inputs)
            if inspect.isawaitable(value):
                value = await value
            validate_value(node.output_schema, value, label=f"{node.node_id}.output")
        except Exception as exc:
            self.store.put_workflow_node_result(
                WorkflowNodeResult(
                    node_id=node.node_id,
                    run_id=self.graph.run_id,
                    workflow_id=self.graph.workflow_id,
                    status=WorkflowNodeStatus.FAILED,
                    input_digest=input_digest,
                    attempt_count=attempt_count,
                    started_at_ns=started_at,
                    finished_at_ns=now_ns(),
                    error=f"{type(exc).__name__}: {exc}",
                )
            )
            self._event(node, "failed", error=f"{type(exc).__name__}: {exc}")
            raise

        output_digest = _digest(value)
        self.store.put_workflow_node_result(
            WorkflowNodeResult(
                node_id=node.node_id,
                run_id=self.graph.run_id,
                workflow_id=self.graph.workflow_id,
                status=WorkflowNodeStatus.SUCCEEDED,
                input_digest=input_digest,
                output_digest=output_digest,
                output=value,
                attempt_count=attempt_count,
                started_at_ns=started_at,
                finished_at_ns=now_ns(),
            )
        )
        self._event(node, "finished", output_digest=output_digest)
        if self.event_callback:
            self.event_callback(
                {"phase": "finished", "node_id": node.node_id, "output_digest": output_digest}
            )
        return value, False


def artifact_equivalent(left: Any, right: Any, *, tolerance: float = 0.0) -> bool:
    """Compare nested declared artifacts without hiding numerical regressions."""

    if isinstance(left, bool) or isinstance(right, bool):
        return left is right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return math_isclose(float(left), float(right), tolerance)
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(
            artifact_equivalent(left[key], right[key], tolerance=tolerance)
            for key in left
        )
    if isinstance(left, (list, tuple)) and isinstance(right, (list, tuple)):
        return len(left) == len(right) and all(
            artifact_equivalent(a, b, tolerance=tolerance)
            for a, b in zip(left, right)
        )
    return left == right


def math_isclose(left: float, right: float, tolerance: float) -> bool:
    if tolerance < 0:
        raise ValueError("tolerance cannot be negative")
    return abs(left - right) <= tolerance
