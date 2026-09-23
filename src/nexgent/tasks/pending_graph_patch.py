"""Pure compilation of pending-subgraph workflow replacements.

``PendingGraphPatch`` carries a complete candidate workflow and binds it to the
exact executable plan it was designed for.  Compilation produces a validated
``PlanRevision``; applying that revision remains an explicit runtime action.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
import json
import re

from .orchestration import PlanExecution, PlanRevision, validate_revision
from .tools import ContractError
from .workflows import plan_from_workflow


MAX_PENDING_GRAPH_PATCH_BYTES = 1_500_000
_IDENTIFIER = re.compile(r"[a-z][a-z0-9_.-]{0,99}")
_PLAN_REF = re.compile(r"plan-[0-9a-f]{64}")
_GRAPH_OPERATION_NAMES = frozenset({
    "add_node", "remove_node", "replace_node",
    "add_control_edge", "remove_control_edge",
    "add_artifact_edge", "remove_artifact_edge",
})


@dataclass(frozen=True, init=False)
class PendingGraphPatch:
    """A finite, immutable request to replace one or more pending plan nodes.

    The workflow is stored as canonical JSON.  This both snapshots caller-owned
    data and makes repeated compilation independent of later mutations.
    """

    id: str
    base_plan_ref: str
    replaced_node_ids: tuple[str, ...]
    reason_ref: str | None = None
    _revised_workflow_json: str = field(repr=False)

    def __init__(
        self,
        id: str,
        base_plan_ref: str,
        replaced_node_ids,
        revised_workflow,
        reason_ref: str | None = None,
    ):
        if not isinstance(id, str) or _IDENTIFIER.fullmatch(id) is None:
            raise ContractError("Pending graph patch id must be a bounded lowercase identifier")
        if not isinstance(base_plan_ref, str) or _PLAN_REF.fullmatch(base_plan_ref) is None:
            raise ContractError("Pending graph patch base_plan_ref must be a plan reference")
        if not isinstance(replaced_node_ids, (tuple, list)):
            raise ContractError("Pending graph patch replaced_node_ids must be a sequence")
        node_ids = tuple(replaced_node_ids)
        if (not node_ids
                or any(not isinstance(node_id, str)
                       or _IDENTIFIER.fullmatch(node_id) is None
                       for node_id in node_ids)
                or len(node_ids) != len(set(node_ids))):
            raise ContractError(
                "Pending graph patch must name unique bounded replacement node ids"
            )
        if (reason_ref is not None
                and (not isinstance(reason_ref, str)
                     or not reason_ref.strip()
                     or len(reason_ref) > 500)):
            raise ContractError("Pending graph patch reason_ref must be a bounded reference")
        if not isinstance(revised_workflow, dict):
            raise ContractError("Pending graph patch revised_workflow must be an object")
        try:
            workflow_json = json.dumps(
                revised_workflow,
                ensure_ascii=False,
                allow_nan=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        except (TypeError, ValueError, RecursionError) as exc:
            raise ContractError(
                f"Pending graph patch revised_workflow must be finite JSON: {exc}"
            ) from None
        if len(workflow_json.encode("utf-8")) > MAX_PENDING_GRAPH_PATCH_BYTES:
            raise ContractError("Pending graph patch revised_workflow exceeds its text budget")

        object.__setattr__(self, "id", id)
        object.__setattr__(self, "base_plan_ref", base_plan_ref)
        object.__setattr__(self, "replaced_node_ids", node_ids)
        object.__setattr__(self, "reason_ref", reason_ref)
        object.__setattr__(self, "_revised_workflow_json", workflow_json)

    @property
    def revised_workflow(self) -> dict:
        """Return a fresh JSON object so the patch cannot be mutated by callers."""
        return json.loads(self._revised_workflow_json)

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "base_plan_ref": self.base_plan_ref,
            "replaced_node_ids": list(self.replaced_node_ids),
            "revised_workflow": self.revised_workflow,
            "reason_ref": self.reason_ref,
        }


def _json_snapshot(value, label: str):
    try:
        payload = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        if len(payload.encode("utf-8")) > MAX_PENDING_GRAPH_PATCH_BYTES:
            raise ContractError(f"{label} exceeds its text budget")
        return json.loads(payload)
    except ContractError:
        raise
    except (TypeError, ValueError, RecursionError) as exc:
        raise ContractError(f"{label} must be finite JSON: {exc}") from None


def _exact_fields(operation: dict, fields: set[str]) -> None:
    if set(operation) != fields:
        raise ContractError(
            f"Graph operation {operation.get('op')!r} must contain exactly "
            + ", ".join(sorted(fields))
        )


def _node_id(node, label: str) -> str:
    if not isinstance(node, dict) or not isinstance(node.get("id"), str):
        raise ContractError(f"{label} must contain a node object with an id")
    return node["id"]


def apply_graph_ops(base_workflow, proposal) -> dict:
    """Apply bounded graph operations and return an independently validated workflow.

    Operations are evaluated in list order.  Removing a node atomically removes
    its incident control and artifact edges; references in outputs, failure
    routes, bindings, and revision rules remain explicit and must be replaced by
    the proposal or final workflow validation rejects them.
    """
    base = _json_snapshot(base_workflow, "Base workflow")
    changes = _json_snapshot(proposal, "Graph proposal")
    if not isinstance(base, dict):
        raise ContractError("Base workflow must be an object")
    if not isinstance(changes, dict):
        raise ContractError("Graph proposal must be an object")
    allowed_fields = {"operations", "outputs", "revision_rules", "task_roles"}
    if set(changes) - allowed_fields or "operations" not in changes:
        raise ContractError(
            "Graph proposal must contain operations and only optional outputs "
            "or revision_rules/task_roles"
        )
    operations = changes["operations"]
    if not isinstance(operations, list) or len(operations) > 4096:
        raise ContractError("Graph proposal operations must be a bounded list")
    if not operations and not ({"outputs", "revision_rules"} & set(changes)):
        raise ContractError("Graph proposal must request at least one change")

    # Reject an invalid starting point rather than accidentally normalizing it
    # through a sequence of otherwise valid edits.
    plan_from_workflow(base, "graph-ops-base")
    revised = deepcopy(base)
    node_touches: set[str] = set()
    edge_touches: set[tuple[str, str]] = set()

    for operation in operations:
        if not isinstance(operation, dict) or operation.get("op") not in _GRAPH_OPERATION_NAMES:
            raise ContractError("Graph proposal contains an unsupported operation")
        op = operation["op"]

        if op in {"add_node", "replace_node"}:
            expected = {"op", "node"} if op == "add_node" else {"op", "node_id", "node"}
            _exact_fields(operation, expected)
            node_id = _node_id(operation["node"], op)
            if op == "replace_node" and operation["node_id"] != node_id:
                raise ContractError("replace_node must preserve the selected node id")
        elif op == "remove_node":
            _exact_fields(operation, {"op", "node_id"})
            node_id = operation["node_id"]
            if not isinstance(node_id, str):
                raise ContractError("remove_node node_id must be text")
        else:
            _exact_fields(operation, {"op", "edge"})
            if not isinstance(operation["edge"], dict):
                raise ContractError(f"{op} edge must be an object")

        if op.endswith("_node"):
            if node_id in node_touches:
                raise ContractError("Graph proposal contains duplicate node operations")
            node_touches.add(node_id)
            positions = [
                index for index, node in enumerate(revised["nodes"])
                if node.get("id") == node_id
            ]
            if op == "add_node":
                if positions:
                    raise ContractError("add_node id already exists")
                revised["nodes"].append(deepcopy(operation["node"]))
            elif len(positions) != 1:
                raise ContractError(f"{op} must select exactly one existing node")
            elif op == "replace_node":
                revised["nodes"][positions[0]] = deepcopy(operation["node"])
            else:
                revised["nodes"].pop(positions[0])
                revised["control_edges"] = [
                    edge for edge in revised.get("control_edges", [])
                    if edge.get("from") != node_id and edge.get("to") != node_id
                ]
                revised["artifact_edges"] = [
                    edge for edge in revised.get("artifact_edges", [])
                    if (edge.get("producer_node") != node_id
                        and edge.get("consumer_node") != node_id)
                ]
            continue

        edge_kind = "control_edges" if "control_edge" in op else "artifact_edges"
        edge = deepcopy(operation["edge"])
        edge_key = (edge_kind, json.dumps(
            edge, ensure_ascii=False, allow_nan=False,
            sort_keys=True, separators=(",", ":"),
        ))
        if edge_key in edge_touches:
            raise ContractError("Graph proposal contains duplicate edge operations")
        edge_touches.add(edge_key)
        edges = revised.setdefault(edge_kind, [])
        matches = [index for index, candidate in enumerate(edges) if candidate == edge]
        if op.startswith("add_"):
            if matches:
                raise ContractError(f"{op} edge already exists")
            edges.append(edge)
        elif len(matches) != 1:
            raise ContractError(f"{op} must select exactly one existing edge")
        else:
            edges.pop(matches[0])

    if "outputs" in changes:
        revised["outputs"] = deepcopy(changes["outputs"])
    if "revision_rules" in changes:
        revised["revision_rules"] = deepcopy(changes["revision_rules"])
    if "task_roles" in changes:
        additions = changes["task_roles"]
        if not isinstance(additions, dict):
            raise ContractError("Graph proposal task_roles must be an object")
        existing = revised.get("task_roles", {})
        if not isinstance(existing, dict):
            raise ContractError("Base workflow task_roles must be an object")
        collisions = set(existing).intersection(additions)
        if collisions:
            raise ContractError(
                "Graph proposal cannot redefine existing task role identities")
        revised["task_roles"] = {**deepcopy(existing), **deepcopy(additions)}
    if revised == base:
        raise ContractError("Graph proposal must change the workflow")

    plan_from_workflow(revised, "graph-ops-result")
    return revised


def compile_pending_graph_patch(
    execution: PlanExecution,
    patch: PendingGraphPatch,
) -> PlanRevision:
    """Compile and validate ``patch`` without changing ``execution``."""
    if not isinstance(execution, PlanExecution) or not isinstance(patch, PendingGraphPatch):
        raise ContractError(
            "Pending graph patch compilation requires PlanExecution and PendingGraphPatch"
        )
    if patch.base_plan_ref != execution.plan.ref:
        raise ContractError("Pending graph patch is stale for the execution's current plan")

    revised_plan = plan_from_workflow(
        patch.revised_workflow,
        execution.plan.id,
        revision=execution.plan.revision + 1,
    )
    revision = PlanRevision(
        id=patch.id,
        base_plan=execution.plan,
        revised_plan=revised_plan,
        replaced_node_ids=patch.replaced_node_ids,
        reason_ref=patch.reason_ref,
    )
    validate_revision(execution, revision)
    return revision
