"""Pure contracts for task-time execution-strategy selection.

This module does not run a selector or an execution backend.  It projects a
host-verified AgentPackage into a bounded candidate set and turns the model's
minimal choice into a host-attributed decision.  Runtime admission, durable
storage, budget enforcement, and recovery remain TaskService responsibilities.
"""

from __future__ import annotations

from copy import deepcopy
import json

from ..kernel.programs import digest
from .packages import split_ref, verify_package
from .tools import ContractError


CANDIDATE_SET_SCHEMA = "nexgent.strategy-candidate-set.v1"
STRATEGY_DECISION_SCHEMA = "nexgent.strategy-decision.v1"

_MODEL_DECISION_FIELDS = frozenset({
    "selected_component_id", "basis", "stop_conditions", "estimated_cost",
})
_CANDIDATE_FIELDS = frozenset({
    "component_id", "component_digest", "kind", "ref", "shape", "backend",
    "package_id", "package_digest", "source_kind", "source_path",
    "source_digest",
})
_CANDIDATE_SET_FIELDS = frozenset({
    "schema", "package_id", "package_digest", "candidates",
    "candidate_set_digest",
})
ESTIMATED_COST_FIELDS = frozenset({
    "model_calls", "completion_tokens", "tool_calls", "tool_work_units",
    "nodes",
})

_MAX_CANDIDATES = 64
_MAX_LIST_ITEMS = 16
_MAX_TEXT = 2000
_MAX_COST = 1_000_000_000_000


def _finite_json(value, label):
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError, RecursionError) as exc:
        raise ContractError(f"{label} must be finite JSON") from exc


def _candidate_body(package, component_id):
    manifest = package["manifest"]
    component = manifest["components"].get(component_id)
    if not isinstance(component, dict):
        raise ContractError(f"Unknown strategy component: {component_id!r}")
    if component.get("class") != "O":
        raise ContractError(
            f"Strategy candidate is not an O component: {component_id!r}")

    kind, ref = component.get("kind"), component.get("ref")
    if kind == "entry":
        if ref != "execute":
            raise ContractError(
                "Task-time open-loop candidates must use the execute entry")
        source_path, _ = split_ref(manifest["entries"][ref], package["files"])
        shape, backend, source_kind = (
            "open_loop", "controlled_code", "python_source")
    elif kind == "workflow":
        workflow = manifest["workflows"].get(ref)
        if not isinstance(workflow, dict):
            raise ContractError(
                f"Strategy workflow is not registered: {component_id!r}")
        source_path = workflow["ref"]
        shape, backend, source_kind = (
            "dag", "executable_plan", "workflow_graph")
    else:
        raise ContractError(
            f"Strategy candidate must be an O entry or workflow: {component_id!r}")

    return {
        "component_id": component_id,
        "component_digest": digest(component),
        "kind": kind,
        "ref": ref,
        "shape": shape,
        "backend": backend,
        "package_id": package["id"],
        "package_digest": package["digest"],
        "source_kind": source_kind,
        "source_path": source_path,
        "source_digest": package["component_digests"][source_path],
    }


def build_strategy_candidate_set(package, component_ids):
    """Project frozen O component identities into backend-ready candidates.

    The caller supplies the complete candidate identity list.  Ordering is
    canonicalized, while duplicates are rejected rather than silently folded.
    Every package and file identity in the result is derived by the host from
    the verified immutable AgentPackage.
    """
    verify_package(package)
    if package["manifest"].get("manifest_version", 1) != 2:
        raise ContractError("Strategy candidates require an AgentPackage v2 manifest")
    if (not isinstance(component_ids, (list, tuple)) or not component_ids
            or len(component_ids) > _MAX_CANDIDATES
            or any(not isinstance(identity, str) or not identity
                   for identity in component_ids)):
        raise ContractError(
            "Strategy component ids must be a nonempty bounded list of text identities")
    if len(set(component_ids)) != len(component_ids):
        raise ContractError("Strategy component ids must be unique")

    candidates = [
        _candidate_body(package, component_id)
        for component_id in sorted(component_ids)
    ]
    body = {
        "schema": CANDIDATE_SET_SCHEMA,
        "package_id": package["id"],
        "package_digest": package["digest"],
        "candidates": candidates,
    }
    return {**body, "candidate_set_digest": digest(body)}


def validate_strategy_candidate_set(candidate_set):
    """Return an isolated, integrity-checked candidate-set projection."""
    candidate_set = _finite_json(candidate_set, "Strategy candidate set")
    if (not isinstance(candidate_set, dict)
            or set(candidate_set) != _CANDIDATE_SET_FIELDS
            or candidate_set.get("schema") != CANDIDATE_SET_SCHEMA
            or not isinstance(candidate_set.get("package_id"), str)
            or not candidate_set["package_id"]
            or not isinstance(candidate_set.get("package_digest"), str)
            or len(candidate_set["package_digest"]) != 64):
        raise ContractError("Strategy candidate set envelope is invalid")

    candidates = candidate_set.get("candidates")
    if (not isinstance(candidates, list) or not candidates
            or len(candidates) > _MAX_CANDIDATES):
        raise ContractError("Strategy candidate set must contain bounded candidates")
    identities = []
    for candidate in candidates:
        if (not isinstance(candidate, dict)
                or set(candidate) != _CANDIDATE_FIELDS
                or candidate.get("kind") not in {"entry", "workflow"}
                or candidate.get("shape") not in {"open_loop", "dag"}
                or candidate.get("backend") not in {
                    "controlled_code", "executable_plan"}
                or candidate.get("source_kind") not in {
                    "python_source", "workflow_graph"}
                or any(not isinstance(candidate.get(field), str)
                       or not candidate[field]
                       for field in _CANDIDATE_FIELDS)
                or candidate["package_id"] != candidate_set["package_id"]
                or candidate["package_digest"] != candidate_set["package_digest"]
                or len(candidate["component_digest"]) != 64
                or len(candidate["source_digest"]) != 64):
            raise ContractError("Strategy candidate identity is invalid")
        if candidate["kind"] == "entry" and (
                candidate["ref"] != "execute"
                or candidate["shape"] != "open_loop"
                or candidate["backend"] != "controlled_code"
                or candidate["source_kind"] != "python_source"):
            raise ContractError("Entry strategy candidate projection is inconsistent")
        if candidate["kind"] == "workflow" and (
                candidate["shape"] != "dag"
                or candidate["backend"] != "executable_plan"
                or candidate["source_kind"] != "workflow_graph"):
            raise ContractError("Workflow strategy candidate projection is inconsistent")
        identities.append(candidate["component_id"])
    if len(set(identities)) != len(identities) or identities != sorted(identities):
        raise ContractError("Strategy candidates must be unique and canonical")

    body = {key: deepcopy(candidate_set[key])
            for key in _CANDIDATE_SET_FIELDS - {"candidate_set_digest"}}
    if candidate_set["candidate_set_digest"] != digest(body):
        raise ContractError("Strategy candidate set identity changed")
    return candidate_set


def _bounded_text_list(value, label):
    if (not isinstance(value, list) or not value
            or len(value) > _MAX_LIST_ITEMS
            or any(not isinstance(item, str) or not item.strip()
                   or len(item) > _MAX_TEXT for item in value)):
        raise ContractError(
            f"{label} must be a nonempty bounded list of nonempty text")
    normalized = [item.strip() for item in value]
    if len(set(normalized)) != len(normalized):
        raise ContractError(f"{label} entries must be unique")
    return normalized


def _estimated_cost(value):
    # This is a model-authored diagnostic estimate, never an authority grant.
    # The host may accept an explicit abstention or a partial estimate for the
    # dimensions the selector can reasonably predict.
    if value is None:
        return None
    if (not isinstance(value, dict) or not value
            or not set(value) <= ESTIMATED_COST_FIELDS):
        raise ContractError(
            "Strategy estimated_cost must be null or use known host cost fields")
    result = {}
    for key in sorted(value):
        item = value[key]
        if type(item) is not int or not 0 <= item <= _MAX_COST:
            raise ContractError(
                f"Strategy estimated_cost.{key} must be a bounded nonnegative integer")
        result[key] = item
    return result


def parse_strategy_decision(model_output, candidate_set):
    """Validate a minimal model choice and attach only host-derived identity.

    Extra fields are rejected so a model cannot submit package, component,
    source, backend, schema, or decision identities that look host-authored.
    """
    candidates = validate_strategy_candidate_set(candidate_set)
    output = _finite_json(model_output, "Strategy decision output")
    if not isinstance(output, dict) or set(output) != _MODEL_DECISION_FIELDS:
        raise ContractError(
            "Strategy decision output has unknown or missing fields")
    selected = output.get("selected_component_id")
    if not isinstance(selected, str) or not selected:
        raise ContractError("Strategy decision must select one component identity")
    candidate_by_id = {
        candidate["component_id"]: candidate
        for candidate in candidates["candidates"]
    }
    if selected not in candidate_by_id:
        raise ContractError("Strategy decision selected an unknown component")

    body = {
        "schema": STRATEGY_DECISION_SCHEMA,
        "candidate_set_digest": candidates["candidate_set_digest"],
        "package_id": candidates["package_id"],
        "package_digest": candidates["package_digest"],
        "selected_component_id": selected,
        "selected_candidate": deepcopy(candidate_by_id[selected]),
        "basis": _bounded_text_list(output["basis"], "Strategy decision basis"),
        "stop_conditions": _bounded_text_list(
            output["stop_conditions"], "Strategy decision stop_conditions"),
        "estimated_cost": _estimated_cost(output["estimated_cost"]),
    }
    return {**body, "decision_digest": digest(body)}
