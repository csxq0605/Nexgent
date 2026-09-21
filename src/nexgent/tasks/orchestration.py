"""Immutable, domain-neutral contracts for executable task plans.

The runtime may grow several schedulers, but they should all agree on the
identity and revision rules expressed here.  In particular, a revision can
replace only a still-pending subgraph.  Work that is running or terminal keeps
the node definition, incoming dependencies, and execution receipt under which
it was admitted.
"""

from __future__ import annotations

from dataclasses import dataclass, fields, is_dataclass, replace
from enum import Enum
import hashlib
import json
import math
import re

from .tools import ContractError


EXECUTABLE_PLAN_SCHEMA = "nexgent.executable-plan.v1"
MAX_PLAN_NODES = 256
MAX_PLAN_REVISIONS = 32
_IDENTIFIER = re.compile(r"[a-z][a-z0-9_.-]{0,99}")


def _identifier(value: str, label: str) -> str:
    if not isinstance(value, str) or _IDENTIFIER.fullmatch(value) is None:
        raise ContractError(f"{label} must be a bounded lowercase identifier")
    return value


def _reference(value: str | None, label: str, *, optional: bool = False) -> str | None:
    if optional and value is None:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > 500:
        raise ContractError(f"{label} must be a nonempty bounded reference")
    return value


def _as_tuple(owner, name: str) -> tuple:
    value = getattr(owner, name)
    if not isinstance(value, (tuple, list)):
        raise ContractError(f"{name} must be a sequence")
    result = tuple(value)
    object.__setattr__(owner, name, result)
    return result


def _positive_integer(value, label: str, *, optional: bool = False):
    if optional and value is None:
        return
    if type(value) is not int or value < 1:
        raise ContractError(f"{label} must be a positive integer")


def _canonical(value):
    if isinstance(value, Enum):
        return value.value
    if is_dataclass(value):
        return {field.name: _canonical(getattr(value, field.name)) for field in fields(value)}
    if isinstance(value, tuple):
        return [_canonical(item) for item in value]
    return value


def _content_ref(value) -> str:
    payload = json.dumps(
        _canonical(value), ensure_ascii=False, allow_nan=False,
        sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")
    return "plan-" + hashlib.sha256(payload).hexdigest()


class NodeStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"
    CANCELLED = "cancelled"

    @property
    def terminal(self) -> bool:
        return self in {
            NodeStatus.COMPLETED,
            NodeStatus.FAILED,
            NodeStatus.SKIPPED,
            NodeStatus.CANCELLED,
        }


class JoinMode(str, Enum):
    # Legacy generic modes remain readable for persisted v1 contracts. New
    # workflow compilation uses the explicit success/completion vocabulary so
    # admission semantics participate in plan identity.
    ALL = "all"
    ANY = "any"
    ALL_SUCCESS = "all_success"
    ALL_COMPLETED = "all_completed"
    ANY_SUCCESS = "any_success"
    QUORUM = "quorum"


class FailureAction(str, Enum):
    ROUTE = "route"
    RETRY = "retry"
    CONTINUE = "continue"
    FAIL_PLAN = "fail_plan"
    PARTIAL_DELIVERY = "partial_delivery"


@dataclass(frozen=True)
class LocalLimits:
    """Host-enforceable limits local to one node.

    Root episode budgets remain authoritative.  These limits can only narrow
    them and make bounded retries, loops, delegation, and external work
    explicit in the plan.
    """

    max_attempts: int = 1
    max_iterations: int | None = None
    timeout_seconds: float | None = None
    max_model_calls: int | None = None
    max_tool_calls: int | None = None
    max_child_episodes: int | None = None
    max_work_units: int | None = None

    def __post_init__(self):
        _positive_integer(self.max_attempts, "max_attempts")
        for name in (
            "max_iterations", "max_model_calls", "max_tool_calls",
            "max_child_episodes", "max_work_units",
        ):
            _positive_integer(getattr(self, name), name, optional=True)
        if (self.timeout_seconds is not None
                and (type(self.timeout_seconds) not in {int, float}
                     or not math.isfinite(self.timeout_seconds)
                     or self.timeout_seconds <= 0)):
            raise ContractError("timeout_seconds must be a positive finite number")


@dataclass(frozen=True)
class PortSpec:
    name: str
    schema_ref: str

    def __post_init__(self):
        _identifier(self.name, "Port name")
        _reference(self.schema_ref, "Port schema_ref")


@dataclass(frozen=True)
class PlanNode:
    id: str
    operator_ref: str
    role_ref: str | None = None
    component_ref: str | None = None
    input_ports: tuple[PortSpec, ...] = ()
    output_ports: tuple[PortSpec, ...] = ()
    local_limits: LocalLimits = LocalLimits()

    def __post_init__(self):
        _identifier(self.id, "Node id")
        _reference(self.operator_ref, "Node operator_ref")
        _reference(self.role_ref, "Node role_ref", optional=True)
        _reference(self.component_ref, "Node component_ref", optional=True)
        if not isinstance(self.local_limits, LocalLimits):
            raise ContractError("Node local_limits must be LocalLimits")
        for name in ("input_ports", "output_ports"):
            ports = _as_tuple(self, name)
            if any(not isinstance(port, PortSpec) for port in ports):
                raise ContractError(f"Node {name} must contain PortSpec values")
            names = [port.name for port in ports]
            if len(names) != len(set(names)):
                raise ContractError(f"Node {name} must have unique names")

    @property
    def ref(self) -> str:
        return "node-" + _content_ref(self).removeprefix("plan-")


@dataclass(frozen=True)
class ControlBinding:
    source_node_id: str
    target_node_id: str
    condition_ref: str | None = None

    def __post_init__(self):
        _identifier(self.source_node_id, "Control source node id")
        _identifier(self.target_node_id, "Control target node id")
        _reference(self.condition_ref, "Control condition_ref", optional=True)


@dataclass(frozen=True)
class ArtifactBinding:
    producer_node_id: str
    output_port: str
    consumer_node_id: str
    input_port: str
    schema_ref: str

    def __post_init__(self):
        _identifier(self.producer_node_id, "Artifact producer node id")
        _identifier(self.output_port, "Artifact output port")
        _identifier(self.consumer_node_id, "Artifact consumer node id")
        _identifier(self.input_port, "Artifact input port")
        _reference(self.schema_ref, "Artifact schema_ref")


@dataclass(frozen=True)
class JoinPolicy:
    node_id: str
    mode: JoinMode = JoinMode.ALL
    quorum: int | None = None

    def __post_init__(self):
        _identifier(self.node_id, "Join node id")
        if not isinstance(self.mode, JoinMode):
            raise ContractError("Join mode must be JoinMode")
        if self.mode is JoinMode.QUORUM:
            _positive_integer(self.quorum, "Join quorum")
        elif self.quorum is not None:
            raise ContractError("Join quorum is only valid for quorum mode")


@dataclass(frozen=True)
class FailureRoute:
    source_node_id: str
    action: FailureAction
    target_node_id: str | None = None
    failure_kinds: tuple[str, ...] = ("*",)

    def __post_init__(self):
        _identifier(self.source_node_id, "Failure source node id")
        if not isinstance(self.action, FailureAction):
            raise ContractError("Failure action must be FailureAction")
        if self.action is FailureAction.ROUTE:
            _identifier(self.target_node_id, "Failure target node id")
        elif self.target_node_id is not None:
            raise ContractError("Failure target is only valid for route actions")
        kinds = _as_tuple(self, "failure_kinds")
        if (not kinds
                or any(not isinstance(kind, str) or not kind.strip() or len(kind) > 120
                       for kind in kinds)
                or len(kinds) != len(set(kinds))):
            raise ContractError("Failure kinds must be unique bounded names")


def _cyclic_nodes(nodes: set[str], edges: tuple[ControlBinding, ...]) -> set[str]:
    """Return nodes in a control-cycle using Tarjan's SCC algorithm."""
    graph = {node: [] for node in nodes}
    for edge in edges:
        graph[edge.source_node_id].append(edge.target_node_id)
    index = 0
    indices: dict[str, int] = {}
    lowlinks: dict[str, int] = {}
    stack: list[str] = []
    on_stack: set[str] = set()
    cyclic: set[str] = set()

    def visit(node: str):
        nonlocal index
        indices[node] = lowlinks[node] = index
        index += 1
        stack.append(node)
        on_stack.add(node)
        for target in graph[node]:
            if target not in indices:
                visit(target)
                lowlinks[node] = min(lowlinks[node], lowlinks[target])
            elif target in on_stack:
                lowlinks[node] = min(lowlinks[node], indices[target])
        if lowlinks[node] != indices[node]:
            return
        component = []
        while True:
            member = stack.pop()
            on_stack.remove(member)
            component.append(member)
            if member == node:
                break
        if len(component) > 1 or node in graph[node]:
            cyclic.update(component)

    for node in sorted(nodes):
        if node not in indices:
            visit(node)
    return cyclic


@dataclass(frozen=True)
class PlanSpec:
    """One immutable executable-plan revision."""

    id: str
    nodes: tuple[PlanNode, ...]
    revision: int = 1
    control_bindings: tuple[ControlBinding, ...] = ()
    artifact_bindings: tuple[ArtifactBinding, ...] = ()
    join_policies: tuple[JoinPolicy, ...] = ()
    failure_routes: tuple[FailureRoute, ...] = ()
    schema: str = EXECUTABLE_PLAN_SCHEMA

    def __post_init__(self):
        _identifier(self.id, "Plan id")
        _positive_integer(self.revision, "Plan revision")
        if self.revision > MAX_PLAN_REVISIONS + 1:
            raise ContractError("Executable plan exceeds its revision limit")
        if self.schema != EXECUTABLE_PLAN_SCHEMA:
            raise ContractError("Unsupported executable-plan schema")
        for name, value_type in (
            ("nodes", PlanNode),
            ("control_bindings", ControlBinding),
            ("artifact_bindings", ArtifactBinding),
            ("join_policies", JoinPolicy),
            ("failure_routes", FailureRoute),
        ):
            values = _as_tuple(self, name)
            if any(not isinstance(value, value_type) for value in values):
                raise ContractError(f"Plan {name} contains an invalid value")
            if len(values) != len(set(values)):
                raise ContractError(f"Plan {name} must not contain duplicates")
        if not 1 <= len(self.nodes) <= MAX_PLAN_NODES:
            raise ContractError(f"Executable plan must contain 1 to {MAX_PLAN_NODES} nodes")
        node_by_id = {node.id: node for node in self.nodes}
        if len(node_by_id) != len(self.nodes):
            raise ContractError("Plan node ids must be unique")

        for edge in self.control_bindings:
            if edge.source_node_id not in node_by_id or edge.target_node_id not in node_by_id:
                raise ContractError("Control binding references an unknown node")
        consumers = set()
        for edge in self.artifact_bindings:
            producer = node_by_id.get(edge.producer_node_id)
            consumer = node_by_id.get(edge.consumer_node_id)
            if producer is None or consumer is None:
                raise ContractError("Artifact binding references an unknown node")
            output = {port.name: port for port in producer.output_ports}.get(edge.output_port)
            input_ = {port.name: port for port in consumer.input_ports}.get(edge.input_port)
            if output is None or input_ is None:
                raise ContractError("Artifact binding references an undeclared port")
            if output.schema_ref != edge.schema_ref or input_.schema_ref != edge.schema_ref:
                raise ContractError("Artifact binding schema does not match both ports")
            consumer_port = (edge.consumer_node_id, edge.input_port)
            if consumer_port in consumers:
                raise ContractError("An input port may have only one artifact producer")
            consumers.add(consumer_port)

        incoming = {node_id: 0 for node_id in node_by_id}
        for edge in self.control_bindings:
            incoming[edge.target_node_id] += 1
        joins = set()
        for policy in self.join_policies:
            if policy.node_id not in node_by_id or policy.node_id in joins:
                raise ContractError("Join policies must reference unique known nodes")
            if policy.mode is JoinMode.QUORUM and policy.quorum > incoming[policy.node_id]:
                raise ContractError("Join quorum exceeds the node's incoming control bindings")
            joins.add(policy.node_id)

        route_kinds: dict[str, set[str]] = {}
        for route in self.failure_routes:
            node = node_by_id.get(route.source_node_id)
            if node is None or (route.target_node_id is not None
                                and route.target_node_id not in node_by_id):
                raise ContractError("Failure route references an unknown node")
            if route.action is FailureAction.RETRY and node.local_limits.max_attempts < 2:
                raise ContractError("Retry failure route requires max_attempts of at least two")
            seen = route_kinds.setdefault(route.source_node_id, set())
            if "*" in seen or "*" in route.failure_kinds and seen or seen.intersection(route.failure_kinds):
                raise ContractError("Failure routes for a node must not overlap")
            seen.update(route.failure_kinds)

        for node_id in _cyclic_nodes(set(node_by_id), self.control_bindings):
            if node_by_id[node_id].local_limits.max_iterations is None:
                raise ContractError("Every node in a control cycle must declare max_iterations")

    @property
    def ref(self) -> str:
        return _content_ref(self)

    def as_dict(self) -> dict:
        return _canonical(self)


# Public vocabulary for callers that prefer the contract's product name.
ExecutablePlan = PlanSpec


@dataclass(frozen=True)
class PlanRevision:
    """A proposed replacement of an explicitly named pending subgraph."""

    id: str
    base_plan: PlanSpec
    revised_plan: PlanSpec
    replaced_node_ids: tuple[str, ...]
    reason_ref: str | None = None

    def __post_init__(self):
        _identifier(self.id, "Plan revision id")
        if not isinstance(self.base_plan, PlanSpec) or not isinstance(self.revised_plan, PlanSpec):
            raise ContractError("Plan revision requires base and revised PlanSpec values")
        if (self.revised_plan.id != self.base_plan.id
                or self.revised_plan.revision != self.base_plan.revision + 1):
            raise ContractError("Revised plan must increment the same plan by one revision")
        node_ids = _as_tuple(self, "replaced_node_ids")
        if (not node_ids or any(not isinstance(node_id, str) for node_id in node_ids)
                or len(node_ids) != len(set(node_ids))):
            raise ContractError("Plan revision must name unique replaced nodes")
        base_ids = {node.id for node in self.base_plan.nodes}
        if any(node_id not in base_ids for node_id in node_ids):
            raise ContractError("Replaced nodes must exist in the base plan")
        _reference(self.reason_ref, "Plan revision reason_ref", optional=True)
        if self.base_plan == replace(
                self.revised_plan, revision=self.base_plan.revision):
            raise ContractError("Plan revision must change the plan")

    @property
    def ref(self) -> str:
        return "revision-" + _content_ref(self).removeprefix("plan-")

    def as_dict(self) -> dict:
        return _canonical(self)


@dataclass(frozen=True)
class NodeExecution:
    node_id: str
    node_spec_ref: str
    status: NodeStatus = NodeStatus.PENDING
    attempt_refs: tuple[str, ...] = ()
    attempt_count: int = 0
    iteration_count: int = 0
    input_artifact_refs: tuple[str, ...] = ()
    output_artifact_refs: tuple[str, ...] = ()
    failure_ref: str | None = None

    def __post_init__(self):
        _identifier(self.node_id, "Node execution id")
        _reference(self.node_spec_ref, "Node execution spec ref")
        if not isinstance(self.status, NodeStatus):
            raise ContractError("Node execution status must be NodeStatus")
        for name in ("attempt_refs", "input_artifact_refs", "output_artifact_refs"):
            values = _as_tuple(self, name)
            if (any(not isinstance(value, str) or not value.strip() or len(value) > 500
                    for value in values)
                    or len(values) != len(set(values))):
                raise ContractError(f"Node execution {name} must contain unique references")
        _reference(self.failure_ref, "Node execution failure_ref", optional=True)
        if (type(self.attempt_count) is not int or self.attempt_count < 0
                or self.attempt_count != len(self.attempt_refs)):
            raise ContractError("Node attempt_count must equal its immutable attempt receipts")
        if type(self.iteration_count) is not int or self.iteration_count < 0:
            raise ContractError("Node iteration_count must be a nonnegative integer")
        if self.status is NodeStatus.PENDING and (
                self.attempt_refs or self.input_artifact_refs
                or self.output_artifact_refs or self.failure_ref is not None):
            raise ContractError("Pending node cannot carry execution evidence")
        if self.status is NodeStatus.RUNNING and not self.attempt_refs:
            raise ContractError("Running node must have an attempt reference")
        if self.status is NodeStatus.COMPLETED and not self.attempt_refs:
            raise ContractError("Completed node must have an attempt reference")
        if self.status is NodeStatus.FAILED and (
                not self.attempt_refs or self.failure_ref is None):
            raise ContractError("Failed node must have attempt and failure references")
        if self.status is NodeStatus.SKIPPED and (
                self.attempt_refs or self.input_artifact_refs or self.output_artifact_refs):
            raise ContractError("Skipped node cannot carry attempt or artifact references")


def _outside(values, mutable_ids: set[str], owner_field: str) -> frozenset:
    return frozenset(
        value for value in values if getattr(value, owner_field) not in mutable_ids
    )


def validate_revision(execution: "PlanExecution", revision: PlanRevision) -> None:
    """Reject revisions that reach outside their pending replacement subgraph."""
    if not isinstance(execution, PlanExecution) or not isinstance(revision, PlanRevision):
        raise ContractError("Revision validation requires PlanExecution and PlanRevision")
    if execution.plan != revision.base_plan:
        raise ContractError("Revision base plan is not the execution's current plan")
    states = {state.node_id: state for state in execution.node_executions}
    scope = set(revision.replaced_node_ids)
    for node_id in scope:
        if states[node_id].status is not NodeStatus.PENDING:
            raise ContractError("Plan revision may replace only pending nodes")

    base_nodes = {node.id: node for node in revision.base_plan.nodes}
    revised_nodes = {node.id: node for node in revision.revised_plan.nodes}
    for node_id, node in base_nodes.items():
        if node_id not in scope and revised_nodes.get(node_id) != node:
            raise ContractError("Plan revision changed a node outside the pending subgraph")
    added = set(revised_nodes) - set(base_nodes)
    mutable_targets = scope | added

    # New nodes must attach to the boundary occupied by the replaced pending
    # subgraph.  Merely naming an unrelated pending node cannot authorize an
    # arbitrary disconnected branch elsewhere in the plan.
    old_boundary = set()
    for binding in revision.base_plan.control_bindings:
        if binding.target_node_id in scope and binding.source_node_id not in scope:
            old_boundary.add(binding.source_node_id)
        if binding.source_node_id in scope and binding.target_node_id not in scope:
            old_boundary.add(binding.target_node_id)
    for binding in revision.base_plan.artifact_bindings:
        if binding.consumer_node_id in scope and binding.producer_node_id not in scope:
            old_boundary.add(binding.producer_node_id)
        if binding.producer_node_id in scope and binding.consumer_node_id not in scope:
            old_boundary.add(binding.consumer_node_id)
    for route in revision.base_plan.failure_routes:
        if route.source_node_id in scope and route.target_node_id not in scope:
            if route.target_node_id is not None:
                old_boundary.add(route.target_node_id)

    adjacency = {node_id: set() for node_id in set(revised_nodes) | old_boundary}
    for binding in revision.revised_plan.control_bindings:
        adjacency[binding.source_node_id].add(binding.target_node_id)
        adjacency[binding.target_node_id].add(binding.source_node_id)
    for binding in revision.revised_plan.artifact_bindings:
        adjacency[binding.producer_node_id].add(binding.consumer_node_id)
        adjacency[binding.consumer_node_id].add(binding.producer_node_id)
    for route in revision.revised_plan.failure_routes:
        if route.target_node_id is not None:
            adjacency[route.source_node_id].add(route.target_node_id)
            adjacency[route.target_node_id].add(route.source_node_id)
    anchors = (scope & set(revised_nodes)) | old_boundary
    if not anchors and scope == set(base_nodes) and added:
        anchors.add(sorted(added)[0])
    reachable = set(anchors)
    stack = list(anchors)
    while stack:
        node_id = stack.pop()
        for neighbour in adjacency.get(node_id, ()):
            if neighbour not in reachable:
                reachable.add(neighbour)
                stack.append(neighbour)
    if added - reachable:
        raise ContractError("Added plan nodes must connect to the replaced subgraph boundary")

    # A control or artifact binding is owned by its consumer.  This permits a
    # new pending branch to consume an already completed artifact without
    # rewriting the completed producer's inputs or execution identity.
    if (_outside(revision.base_plan.control_bindings, mutable_targets, "target_node_id")
            != _outside(revision.revised_plan.control_bindings, mutable_targets,
                        "target_node_id")):
        raise ContractError("Plan revision changed control bindings outside the pending subgraph")
    if (_outside(revision.base_plan.artifact_bindings, mutable_targets, "consumer_node_id")
            != _outside(revision.revised_plan.artifact_bindings, mutable_targets,
                        "consumer_node_id")):
        raise ContractError("Plan revision changed artifact bindings outside the pending subgraph")
    if (_outside(revision.base_plan.join_policies, mutable_targets, "node_id")
            != _outside(revision.revised_plan.join_policies, mutable_targets, "node_id")):
        raise ContractError("Plan revision changed join policy outside the pending subgraph")

    # A failure route is chosen when its source fails, so it belongs to the
    # source node rather than the destination node.
    if (_outside(revision.base_plan.failure_routes, mutable_targets, "source_node_id")
            != _outside(revision.revised_plan.failure_routes, mutable_targets,
                        "source_node_id")):
        raise ContractError("Plan revision changed failure route outside the pending subgraph")
    if any(route.source_node_id in mutable_targets
           and route.target_node_id is not None
           and route.target_node_id not in mutable_targets
           for route in revision.revised_plan.failure_routes):
        raise ContractError("Revised failure routes must stay inside the pending subgraph")


@dataclass(frozen=True)
class PlanExecution:
    """Immutable execution projection for one current plan revision."""

    id: str
    plan: PlanSpec
    node_executions: tuple[NodeExecution, ...]
    revisions: tuple[PlanRevision, ...] = ()

    def __post_init__(self):
        _identifier(self.id, "Plan execution id")
        if not isinstance(self.plan, PlanSpec):
            raise ContractError("Plan execution requires a PlanSpec")
        states = _as_tuple(self, "node_executions")
        history = _as_tuple(self, "revisions")
        if (any(not isinstance(state, NodeExecution) for state in states)
                or any(not isinstance(revision, PlanRevision) for revision in history)):
            raise ContractError("Plan execution contains an invalid state or revision")
        state_by_id = {state.node_id: state for state in states}
        node_by_id = {node.id: node for node in self.plan.nodes}
        if len(state_by_id) != len(states) or set(state_by_id) != set(node_by_id):
            raise ContractError("Plan execution must contain exactly one state per current node")
        for node_id, state in state_by_id.items():
            if state.node_spec_ref != node_by_id[node_id].ref:
                raise ContractError("Node execution does not match its immutable node spec")
            limits = node_by_id[node_id].local_limits
            if state.attempt_count > limits.max_attempts:
                raise ContractError("Node execution exceeds its local attempt limit")
            if (state.iteration_count
                    and (limits.max_iterations is None
                         or state.iteration_count > limits.max_iterations)):
                raise ContractError("Node execution exceeds its local iteration limit")
        if len(history) > MAX_PLAN_REVISIONS:
            raise ContractError("Plan execution exceeds its revision limit")
        if len(history) != self.plan.revision - 1:
            raise ContractError("Plan execution must retain its complete revision history")
        for previous, current in zip(history, history[1:]):
            if previous.revised_plan != current.base_plan:
                raise ContractError("Plan revision history is not contiguous")
        if history and history[-1].revised_plan != self.plan:
            raise ContractError("Plan revision history does not end at the current plan")

    @classmethod
    def create(cls, execution_id: str, plan: PlanSpec) -> "PlanExecution":
        return cls(
            id=execution_id,
            plan=plan,
            node_executions=tuple(
                NodeExecution(node_id=node.id, node_spec_ref=node.ref) for node in plan.nodes
            ),
        )

    def node(self, node_id: str) -> NodeExecution:
        _identifier(node_id, "Node id")
        for state in self.node_executions:
            if state.node_id == node_id:
                return state
        raise ContractError("Plan execution has no such node")

    def transition_node(
        self,
        node_id: str,
        status: NodeStatus,
        *,
        attempt_ref: str | None = None,
        input_artifact_refs: tuple[str, ...] = (),
        output_artifact_refs: tuple[str, ...] = (),
        failure_ref: str | None = None,
        iteration_count: int | None = None,
    ) -> "PlanExecution":
        """Record one legal node transition without mutating prior evidence."""
        current = self.node(node_id)
        if current.status.terminal:
            raise ContractError("Terminal node cannot be replayed or changed")
        if not isinstance(status, NodeStatus):
            raise ContractError("Node transition status must be NodeStatus")
        if current.status is NodeStatus.PENDING:
            if status is NodeStatus.RUNNING:
                _reference(attempt_ref, "Node attempt_ref")
                updated = NodeExecution(
                    node_id=node_id,
                    node_spec_ref=current.node_spec_ref,
                    status=status,
                    attempt_refs=(attempt_ref,),
                    attempt_count=1,
                    input_artifact_refs=tuple(input_artifact_refs),
                )
            elif status in {NodeStatus.SKIPPED, NodeStatus.CANCELLED}:
                if (attempt_ref is not None or input_artifact_refs
                        or output_artifact_refs or failure_ref is not None):
                    raise ContractError("Unstarted terminal node cannot carry execution evidence")
                updated = replace(current, status=status)
            else:
                raise ContractError("Pending node must start before it can finish")
        elif current.status is NodeStatus.RUNNING:
            if attempt_ref is not None or input_artifact_refs:
                raise ContractError("Running node attempt and inputs are immutable")
            iterations = current.iteration_count if iteration_count is None else iteration_count
            if status is NodeStatus.COMPLETED:
                if failure_ref is not None:
                    raise ContractError("Completed node cannot carry a failure reference")
                updated = replace(
                    current, status=status,
                    iteration_count=iterations,
                    output_artifact_refs=tuple(output_artifact_refs),
                )
            elif status is NodeStatus.FAILED:
                _reference(failure_ref, "Node failure_ref")
                if output_artifact_refs:
                    raise ContractError("Failed node cannot publish successful outputs")
                updated = replace(current, status=status, failure_ref=failure_ref,
                                  iteration_count=iterations)
            elif status is NodeStatus.CANCELLED:
                if output_artifact_refs:
                    raise ContractError("Cancelled node cannot publish successful outputs")
                updated = replace(current, status=status, failure_ref=failure_ref,
                                  iteration_count=iterations)
            else:
                raise ContractError("Running node may only complete, fail, or cancel")
        else:  # Defensive: all enum states are covered above.
            raise ContractError("Unsupported node transition")
        return replace(
            self,
            node_executions=tuple(
                updated if state.node_id == node_id else state
                for state in self.node_executions
            ),
        )

    def apply_revision(self, revision: PlanRevision) -> "PlanExecution":
        if len(self.revisions) >= MAX_PLAN_REVISIONS:
            raise ContractError("Plan execution exceeds its revision limit")
        validate_revision(self, revision)
        old_states = {state.node_id: state for state in self.node_executions}
        scope = set(revision.replaced_node_ids)
        states = []
        for node in revision.revised_plan.nodes:
            if node.id in old_states and node.id not in scope:
                states.append(old_states[node.id])
            else:
                states.append(NodeExecution(node_id=node.id, node_spec_ref=node.ref))
        return PlanExecution(
            id=self.id,
            plan=revision.revised_plan,
            node_executions=tuple(states),
            revisions=self.revisions + (revision,),
        )

    def as_dict(self) -> dict:
        return _canonical(self)


def plan_spec_from_dict(value: dict) -> PlanSpec:
    """Rebuild and revalidate a persisted PlanSpec projection."""
    try:
        nodes = []
        for node in value["nodes"]:
            limits = LocalLimits(**node.get("local_limits", {}))
            nodes.append(PlanNode(
                id=node["id"],
                operator_ref=node["operator_ref"],
                role_ref=node.get("role_ref"),
                component_ref=node.get("component_ref"),
                input_ports=tuple(PortSpec(**port) for port in node.get("input_ports", [])),
                output_ports=tuple(PortSpec(**port) for port in node.get("output_ports", [])),
                local_limits=limits,
            ))
        return PlanSpec(
            id=value["id"],
            nodes=tuple(nodes),
            revision=value.get("revision", 1),
            control_bindings=tuple(
                ControlBinding(**binding) for binding in value.get("control_bindings", [])),
            artifact_bindings=tuple(
                ArtifactBinding(**binding) for binding in value.get("artifact_bindings", [])),
            join_policies=tuple(JoinPolicy(
                node_id=policy["node_id"], mode=JoinMode(policy.get("mode", "all")),
                quorum=policy.get("quorum"),
            ) for policy in value.get("join_policies", [])),
            failure_routes=tuple(FailureRoute(
                source_node_id=route["source_node_id"],
                action=FailureAction(route["action"]),
                target_node_id=route.get("target_node_id"),
                failure_kinds=tuple(route.get("failure_kinds", ["*"])),
            ) for route in value.get("failure_routes", [])),
            schema=value.get("schema", EXECUTABLE_PLAN_SCHEMA),
        )
    except ContractError:
        raise
    except (KeyError, TypeError, ValueError) as exc:
        raise ContractError(f"Invalid persisted PlanSpec: {str(exc)[:500]}") from None


def plan_revision_from_dict(value: dict) -> PlanRevision:
    try:
        return PlanRevision(
            id=value["id"],
            base_plan=plan_spec_from_dict(value["base_plan"]),
            revised_plan=plan_spec_from_dict(value["revised_plan"]),
            replaced_node_ids=tuple(value["replaced_node_ids"]),
            reason_ref=value.get("reason_ref"),
        )
    except ContractError:
        raise
    except (KeyError, TypeError, ValueError) as exc:
        raise ContractError(f"Invalid persisted PlanRevision: {str(exc)[:500]}") from None


def plan_execution_from_dict(value: dict) -> PlanExecution:
    """Rebuild a durable execution while checking node and revision identity."""
    try:
        return PlanExecution(
            id=value["id"],
            plan=plan_spec_from_dict(value["plan"]),
            node_executions=tuple(NodeExecution(
                node_id=state["node_id"],
                node_spec_ref=state["node_spec_ref"],
                status=NodeStatus(state.get("status", "pending")),
                attempt_refs=tuple(state.get("attempt_refs", [])),
                attempt_count=state.get("attempt_count", len(state.get("attempt_refs", []))),
                iteration_count=state.get("iteration_count", 0),
                input_artifact_refs=tuple(state.get("input_artifact_refs", [])),
                output_artifact_refs=tuple(state.get("output_artifact_refs", [])),
                failure_ref=state.get("failure_ref"),
            ) for state in value["node_executions"]),
            revisions=tuple(
                plan_revision_from_dict(revision) for revision in value.get("revisions", [])),
        )
    except ContractError:
        raise
    except (KeyError, TypeError, ValueError) as exc:
        raise ContractError(f"Invalid persisted PlanExecution: {str(exc)[:500]}") from None


__all__ = [
    "EXECUTABLE_PLAN_SCHEMA",
    "MAX_PLAN_NODES",
    "MAX_PLAN_REVISIONS",
    "ArtifactBinding",
    "ControlBinding",
    "ExecutablePlan",
    "FailureAction",
    "FailureRoute",
    "JoinMode",
    "JoinPolicy",
    "LocalLimits",
    "NodeExecution",
    "NodeStatus",
    "PlanExecution",
    "PlanNode",
    "PlanRevision",
    "PlanSpec",
    "PortSpec",
    "plan_execution_from_dict",
    "plan_revision_from_dict",
    "plan_spec_from_dict",
    "validate_revision",
]
