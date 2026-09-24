"""Feedback-bound generation of immutable package or memory candidates.

The improver is an ordinary, separately versioned AgentPackage.  It executes
through :class:`TaskService` and can only return a declarative package
BehaviorPatch or an independent MemoryComponentPatch.  The host owns feedback
boundaries, patch validation and candidate admission.  A failed generation is
durable evidence, never a candidate.
"""

from __future__ import annotations

from copy import deepcopy
import json
import re
import time
import uuid

from ..kernel.programs import digest
from .packages import make_package, safe_path, split_ref, verify_package
from .tools import ContractError


FEEDBACK_SCHEMA = "nexgent.feedback-bundle.v1"
PATCH_SCHEMA = "nexgent.behavior-patch.v1"
PATCH_SCHEMA_V2 = "nexgent.behavior-patch.v2"
PACKAGE_PATCH_SCHEMA = "nexgent.package-patch.v3"
MEMORY_PATCH_SCHEMA = "nexgent.memory-component-patch.v1"
LEGACY_PATCH_SCHEMA = PATCH_SCHEMA
GENERATION_SCHEMA = "nexgent.candidate-generation.v1"
_TERMINAL = frozenset({"completed", "failed"})
_MUTABLE_CLASSES = frozenset({"O", "M", "S"})
_FORBIDDEN_TOKENS = frozenset({
    "benchmark", "evaluator", "evaluation", "gate", "gating", "permission",
    "permissions", "manifest", "holdout", "secret", "hidden",
})
_PUBLIC_FEEDBACK_SIGNALS = ("valid", "passed", "approved", "success")
_PUBLIC_FEEDBACK_MAX_EVENTS = 32
_PUBLIC_FEEDBACK_MAX_BYTES = 16_384
_PUBLIC_FEEDBACK_MAX_ARTIFACT_REFS = 16
_PUBLIC_FEEDBACK_SECRET_TOKENS = frozenset({
    "auth", "authorization", "credential", "credentials", "evaluator",
    "hidden", "key", "password", "private", "prompt", "secret", "token",
})
_FAILURE_CODE = re.compile(r"[a-z][a-z0-9]*(?:_[a-z0-9]+)*")
_PUBLIC_FAILURE_CODES = frozenset({
    "artifact_invalid", "artifact_missing", "contract_violation",
    "dependency_failure", "execution_failed", "incomplete_output",
    "invalid_output", "missing_output", "model_failure", "permission_denied",
    "publication_failed", "resource_exhausted", "schema_mismatch", "timeout",
    "tool_failure", "unknown_failure", "unsupported_capability",
    "validation_failed",
})
_PUBLIC_WORKFLOW_IDENTIFIER = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,79}")
_PUBLIC_WORKFLOW_PATH_PART = re.compile(r"[A-Za-z0-9_-]{1,80}")
_PUBLIC_BINDING_FAILURE = re.compile(
    r"(?:^|:\s)Node (?P<consumer>[A-Za-z][A-Za-z0-9_-]{0,79}) failed: "
    r"WorkflowError: Binding path is unavailable: (?P<path>[A-Za-z0-9_.-]{1,320})$"
)
_PUBLIC_SCHEMA_TYPES = frozenset({
    "array", "boolean", "integer", "null", "number", "object", "string",
})


def _copy(value, label="Generation value"):
    try:
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":"), allow_nan=False)
        return json.loads(encoded)
    except (TypeError, ValueError, RecursionError) as exc:
        raise ContractError(f"{label} must be finite JSON: {str(exc)[:500]}") from None


def _id(prefix):
    return prefix + "-" + uuid.uuid4().hex[:16]


def _bounded_ids(values, label, limit=128):
    if (not isinstance(values, list) or not values or len(values) > limit
            or any(not isinstance(value, str) or not value for value in values)
            or len(set(values)) != len(values)):
        raise ContractError(f"{label} must be a nonempty unique list of at most {limit} identities")
    return list(values)


def _path_tokens(path):
    return {token for token in re.split(r"[^a-z0-9]+", path.casefold()) if token}


def _public_evaluation(evaluation):
    if not isinstance(evaluation, dict):
        return None
    # The report digest proves which immutable report was observed.  Only a
    # fixed, non-explanatory metric projection crosses into improver input;
    # private evaluator diagnostics, answers and snapshots never do.
    public = {key: deepcopy(evaluation[key]) for key in
              ("status", "score", "score_available", "accepted", "execution_status")
              if key in evaluation}
    return {"digest": digest(evaluation), "public_metrics": _copy(public, "Evaluation metrics")}


def _public_outcome(outcome):
    """Expose host-owned delivery states without evaluator text or artifacts."""
    if not isinstance(outcome, dict):
        return None
    public = {key: deepcopy(outcome[key]) for key in
              ("delivery_status", "acceptance_status", "schema_validation")
              if key in outcome}
    return {"digest": digest(outcome),
            "public_status": _copy(public, "Outcome status")}


def _artifact_ref(artifact):
    producer = artifact.get("producer") or {}
    return {
        "id": artifact.get("id"),
        "name": artifact.get("name"),
        "schema_ref": artifact.get("schema_ref"),
        "media_type": artifact.get("media_type"),
        "content_digest": artifact.get("content_digest"),
        "producer": {key: producer.get(key) for key in
                     ("episode_id", "node_id", "attempt_id", "package_digest")},
        "validation_digest": digest(artifact.get("validation") or {}),
    }


def _error_type(value):
    if not isinstance(value, str) or not value:
        return None
    name = value.split(":", 1)[0]
    return name if name.isidentifier() and len(name) <= 120 else "RuntimeError"


def _public_workflow_identifier(value):
    if (not isinstance(value, str)
            or _PUBLIC_WORKFLOW_IDENTIFIER.fullmatch(value) is None
            or _path_tokens(value) & _PUBLIC_FEEDBACK_SECRET_TOKENS):
        return None
    return value


def _public_workflow_path(value):
    if not isinstance(value, str) or not value or len(value) > 320:
        return None
    parts = value.split(".")
    if (any(_PUBLIC_WORKFLOW_PATH_PART.fullmatch(part) is None for part in parts)
            or _path_tokens(value) & _PUBLIC_FEEDBACK_SECRET_TOKENS):
        return None
    return value


def _public_output_schema(schema, depth=0):
    """Project structural JSON Schema fields without descriptions or values."""
    if depth > 8 or not isinstance(schema, dict) or len(schema) > 64:
        return None
    projected = {}
    declared = schema.get("type")
    if declared is not None:
        if isinstance(declared, str) and declared in _PUBLIC_SCHEMA_TYPES:
            projected["type"] = declared
        elif (isinstance(declared, list) and declared
              and len(declared) <= len(_PUBLIC_SCHEMA_TYPES)
              and all(isinstance(item, str) for item in declared)
              and len(set(declared)) == len(declared)
              and all(item in _PUBLIC_SCHEMA_TYPES for item in declared)):
            projected["type"] = list(declared)
        else:
            return None
    properties = schema.get("properties")
    if properties is not None:
        if not isinstance(properties, dict) or len(properties) > 64:
            return None
        public_properties = {}
        for name, child in properties.items():
            public_name = _public_workflow_identifier(name)
            public_child = _public_output_schema(child, depth + 1)
            if public_name is None or public_child is None:
                return None
            public_properties[public_name] = public_child
        projected["properties"] = public_properties
    required = schema.get("required")
    if required is not None:
        if (not isinstance(required, list) or len(required) > 64
                or any(not isinstance(name, str) for name in required)
                or len(set(required)) != len(required)):
            return None
        public_required = [_public_workflow_identifier(name) for name in required]
        if any(name is None for name in public_required):
            return None
        projected["required"] = public_required
    additional = schema.get("additionalProperties")
    if additional is not None:
        if type(additional) is bool:
            projected["additionalProperties"] = additional
        else:
            public_additional = _public_output_schema(additional, depth + 1)
            if public_additional is None:
                return None
            projected["additionalProperties"] = public_additional
    items = schema.get("items")
    if items is not None:
        if type(items) is bool:
            projected["items"] = items
        else:
            public_items = _public_output_schema(items, depth + 1)
            if public_items is None:
                return None
            projected["items"] = public_items
    return projected


def _binding_refs(value, depth=0):
    if depth > 16:
        return None
    refs = []
    if isinstance(value, dict):
        if set(value) == {"$node"} and isinstance(value["$node"], str):
            refs.append(value["$node"])
        else:
            for child in value.values():
                child_refs = _binding_refs(child, depth + 1)
                if child_refs is None:
                    return None
                refs.extend(child_refs)
    elif isinstance(value, list):
        for child in value:
            child_refs = _binding_refs(child, depth + 1)
            if child_refs is None:
                return None
            refs.extend(child_refs)
    return refs if len(refs) <= 512 else None


def _public_workflow_diagnostic(episode):
    """Return a repairable graph error without crossing the task-data boundary."""
    error = episode.get("last_error")
    if not isinstance(error, str) or "Binding path is unavailable" not in error:
        return None
    fallback = {"code": "workflow_binding_path_unavailable"}
    match = _PUBLIC_BINDING_FAILURE.search(error)
    if match is None:
        return fallback
    consumer = _public_workflow_identifier(match.group("consumer"))
    requested_path = _public_workflow_path(match.group("path"))
    workflow = episode.get("plan_workflow_snapshot")
    nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
    if (consumer is None or requested_path is None or not isinstance(nodes, list)
            or not 1 <= len(nodes) <= 256):
        return fallback
    by_id = {}
    for node in nodes:
        node_id = (_public_workflow_identifier(node.get("id"))
                   if isinstance(node, dict) else None)
        if node_id is None or node_id in by_id:
            return fallback
        by_id[node_id] = node
    consumer_node = by_id.get(consumer)
    if consumer_node is None:
        return fallback
    matches = []
    refs = _binding_refs({
            "params": consumer_node.get("params", {}),
            "bindings": consumer_node.get("bindings", {}),
    })
    if refs is None:
        return fallback
    for ref in refs:
        producer, separator, path = ref.partition(".")
        if separator and path == requested_path:
            matches.append(producer)
    if len(matches) != 1:
        return fallback
    producer = _public_workflow_identifier(matches[0])
    producer_node = by_id.get(producer)
    if producer is None or producer_node is None:
        return fallback
    output_schema = _public_output_schema(producer_node.get("output_schema", {}))
    if output_schema is None:
        return fallback
    diagnostic = {
        "code": fallback["code"],
        "consumer": consumer,
        "producer": producer,
        "requested_path": requested_path,
        "output_schema": output_schema,
    }
    try:
        if len(json.dumps(diagnostic, separators=(",", ":"))) > 8192:
            return fallback
    except (TypeError, ValueError, RecursionError):
        return fallback
    return diagnostic


def _public_execution_trace(episode):
    """Expose failure shape and action flow without arguments, outputs, or prompts."""
    nodes = sorted((episode.get("nodes") or {}).values(),
                   key=lambda node: (node.get("started_at", 0), node.get("id", "")))
    rows = []
    for node in nodes[-128:]:
        request = node.get("request") or {}
        row = {"id": node.get("id"), "method": node.get("method"),
               "status": node.get("status"),
               "error_type": _error_type(node.get("error"))}
        if node.get("method") == "ask" and isinstance(request.get("role"), str):
            row["role_digest"] = digest(request["role"])
        if node.get("method") in {"tool", "skill"} and isinstance(request.get("name"), str):
            row["capability_digest"] = digest(request["name"])
        result = node.get("result")
        if isinstance(result, dict):
            signals = {key: result[key] for key in ("valid", "passed", "approved", "success")
                       if type(result.get(key)) is bool}
            if signals:
                row["public_signals"] = signals
        rows.append(row)
    counts = {}
    for row in rows:
        key = (row.get("method") or "unknown") + ":" + (row.get("status") or "unknown")
        counts[key] = counts.get(key, 0) + 1
    trace = {
        "failure_domain": episode.get("failure_domain"),
        "last_error_type": _error_type(episode.get("last_error")),
        "node_counts": counts,
        "nodes": rows,
        "truncated_nodes": max(0, len(nodes) - len(rows)),
    }
    diagnostic = _public_workflow_diagnostic(episode)
    if diagnostic is not None:
        trace["workflow_diagnostic"] = diagnostic
    return trace


def _checked_event_chain(episode_id, events):
    """Validate the durable journal before projecting task-authored content."""
    previous = "genesis"
    checked = []
    for sequence, event in enumerate(events, 1):
        if not isinstance(event, dict):
            raise ContractError("Feedback Episode event journal integrity changed")
        record = {
            "episode_id": event.get("episode_id"),
            "sequence": event.get("sequence"),
            "kind": event.get("kind"),
            "created": event.get("created"),
            "content": event.get("content"),
            "previous": event.get("previous"),
        }
        try:
            valid_digest = digest(record) == event.get("digest")
        except (TypeError, ValueError, RecursionError):
            valid_digest = False
        if (record["episode_id"] != episode_id or record["sequence"] != sequence
                or record["previous"] != previous or not valid_digest):
            raise ContractError("Feedback Episode event journal integrity changed")
        checked.append(event)
        previous = event["digest"]
    return checked


def _safe_failure_code(value):
    if (not isinstance(value, str) or len(value) > 64
            or _FAILURE_CODE.fullmatch(value) is None
            or _path_tokens(value) & _PUBLIC_FEEDBACK_SECRET_TOKENS
            or value not in _PUBLIC_FAILURE_CODES):
        return None
    return value


def _public_feedback(episode_id, events, artifacts):
    """Project fixed low-risk fields from untrusted task-agent feedback claims."""
    feedback_events = [event for event in events if event.get("kind") == "feedback"]
    if len(feedback_events) > _PUBLIC_FEEDBACK_MAX_EVENTS:
        raise ContractError("Feedback Episode contains too many public feedback claims")
    local_artifacts = {
        artifact.get("id"): artifact for artifact in artifacts
        if isinstance(artifact, dict)
        and (artifact.get("producer") or {}).get("episode_id") == episode_id
    }
    projected = []
    for event in feedback_events:
        record = event.get("content")
        if (not isinstance(record, dict) or record.get("source") != "agent_review"
                or record.get("validity") != "claimed"):
            continue
        content = record.get("content")
        if not isinstance(content, dict):
            continue
        try:
            encoded = json.dumps(content, ensure_ascii=False, sort_keys=True,
                                 separators=(",", ":"), allow_nan=False).encode("utf-8")
        except (TypeError, ValueError, RecursionError):
            continue
        if len(encoded) > _PUBLIC_FEEDBACK_MAX_BYTES:
            raise ContractError("Public feedback claim exceeds the capture bound")

        claim = {
            "event_digest": event["digest"],
            "source": "task_agent",
            "claim_status": "unverified",
            "signals": {key: content[key] for key in _PUBLIC_FEEDBACK_SIGNALS
                        if type(content.get(key)) is bool},
        }
        failure_code = _safe_failure_code(content.get("failure_code"))
        if failure_code is not None:
            claim["failure_code"] = failure_code

        requested_refs = content.get("artifact_refs")
        if isinstance(requested_refs, list):
            if len(requested_refs) > _PUBLIC_FEEDBACK_MAX_ARTIFACT_REFS:
                raise ContractError("Public feedback artifact references exceed the capture bound")
            seen = set()
            resolved = []
            for identity in requested_refs:
                if (not isinstance(identity, str) or identity in seen
                        or identity not in local_artifacts):
                    continue
                seen.add(identity)
                resolved.append(identity)
            if resolved:
                claim["artifact_refs"] = resolved
        projected.append(claim)
    return projected


def _component_descriptor(package, component_id):
    """Resolve one v2 component through the frozen manifest registry."""
    manifest = package["manifest"]
    if manifest.get("manifest_version", 1) != 2:
        raise ContractError("Stable component targets require manifest v2")
    component = manifest.get("components", {}).get(component_id)
    if not isinstance(component, dict):
        raise ContractError(f"Unknown manifest component id: {component_id!r}")
    component_class, kind, ref = (component.get("class"), component.get("kind"),
                                  component.get("ref"))
    try:
        if kind == "entry":
            paths = [split_ref(manifest["entries"][ref], package["files"])[0]]
        elif kind == "skill":
            skill = manifest.get("skills", {})[ref]
            paths = [split_ref(skill["ref"], package["files"])[0]
                     if skill["kind"] == "controlled_code" else skill["ref"]]
        elif kind == "workflow":
            paths = [manifest["workflows"][ref]["ref"]]
        elif kind == "role":
            prompt_ref = manifest["roles"][ref].get("prompt_ref")
            paths = [] if prompt_ref is None else [prompt_ref]
        elif kind == "tool":
            paths = [split_ref(manifest.get("tools", {})[ref]["ref"],
                               package["files"])[0]]
        elif kind == "service_provider":
            paths = [split_ref(manifest.get("services", {})[ref]["ref"],
                               package["files"])[0]]
        elif kind == "resource":
            paths = [ref]
        else:
            raise KeyError(kind)
    except (KeyError, TypeError, ValueError) as exc:
        raise ContractError(
            f"Manifest component {component_id!r} cannot resolve its frozen reference") from None
    for path in paths:
        try:
            safe_path(path)
        except Exception as exc:
            raise ContractError(str(exc)) from None
        if path not in package["files"]:
            raise ContractError(
                f"Manifest component {component_id!r} resolves outside the package")
    return {"component_id": component_id, "class": component_class,
            "kind": kind, "ref": ref, "files": paths}


def _component_registry_snapshot(package):
    manifest = package["manifest"]
    if manifest.get("manifest_version", 1) != 2:
        return None
    components = {
        component_id: _component_descriptor(package, component_id)
        for component_id in sorted(manifest["components"])
    }
    return {"manifest_version": 2, "manifest_digest": digest(manifest),
            "components": components}


def _patch_schema(schema=PATCH_SCHEMA, *, memory_targeted=False):
    if schema == PACKAGE_PATCH_SCHEMA:
        hypothesis_keys = ["failure_mechanism", "expected_behavior",
                           "applicability", "falsifier"]
        return {
            "type": "object", "additionalProperties": False,
            "required": ["schema", "parent_package_digest", "hypothesis",
                         "operations", "child_manifest", "activation_targets"],
            "properties": {
                "schema": {"const": PACKAGE_PATCH_SCHEMA},
                "parent_package_digest": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
                "hypothesis": {"type": "object", "additionalProperties": False,
                               "required": hypothesis_keys + ["component_ids"],
                               "properties": {
                                   **{key: {"type": "string", "minLength": 1,
                                            "maxLength": 5000} for key in hypothesis_keys},
                                   "component_ids": {"type": "array", "minItems": 1,
                                                     "maxItems": 64,
                                                     "items": {"type": "string"}}}},
                "operations": {"type": "array", "minItems": 1, "maxItems": 64,
                               "items": {"type": "object"}},
                "child_manifest": {"type": "object"},
                "activation_targets": {"type": "array", "minItems": 1,
                                       "maxItems": 64,
                                       "items": {"type": "string"}},
            }}
    component_targeted = schema == PATCH_SCHEMA_V2 or memory_targeted
    if memory_targeted:
        operation = {
            "type": "object",
            "required": ["op", "component_id", "surface", "old_digest", "value"],
            "properties": {
                "op": {"const": "replace"},
                "component_id": {"type": "string", "minLength": 1, "maxLength": 100},
                "surface": {"enum": ["policy", "data"]},
                "old_digest": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
                "value": {"type": "object"},
            },
            "additionalProperties": False,
        }
    else:
        operation = {
            "type": "object",
            "required": (["op", "component_id"] if component_targeted else ["op", "path"]),
            "properties": {
                "op": {"enum": ["replace", "add", "remove"]},
                "old_digest": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
                "content": {"type": "string", "maxLength": 100000},
            },
            "additionalProperties": False,
        }
        operation["properties"]["component_id" if component_targeted else "path"] = {
            "type": "string", "minLength": 1, "maxLength": 100 if component_targeted else 240}
    hypothesis_keys = ["failure_mechanism", "expected_behavior", "applicability", "falsifier"]
    hypothesis_properties = {
        key: {"type": "string", "minLength": 1, "maxLength": 5000}
        for key in hypothesis_keys}
    if component_targeted:
        hypothesis_keys.append("component_id")
        hypothesis_properties["component_id"] = {
            "type": "string", "minLength": 1, "maxLength": 100}
    probe_properties = {"kind": {"const": (
        "memory_snapshot_frozen" if memory_targeted else "component_loaded")}}
    probe_properties["component_id" if component_targeted else "path"] = {
        "type": "string", "minLength": 1,
        "maxLength": 100 if component_targeted else 240}
    return {
        "type": "object",
        "required": ["schema", "hypothesis", "operations", "activation_probe"],
        "properties": {
            "schema": {"const": schema},
            "hypothesis": {
                "type": "object",
                "required": hypothesis_keys,
                "properties": hypothesis_properties,
                "additionalProperties": False,
            },
            "operations": {"type": "array", "minItems": 1, "maxItems": 128,
                           "items": operation},
            "activation_probe": {
                "type": "object",
                "required": ["kind", "component_id" if component_targeted else "path"],
                "properties": probe_properties,
                "additionalProperties": False,
            },
        },
        "additionalProperties": False,
    }


class GenerationService:
    """Capture development feedback and execute a frozen candidate improver."""

    def __init__(self, task_service, evolution_service):
        if evolution_service.tasks is not task_service:
            raise ValueError("Generation and evolution services must share one TaskService")
        self.tasks = task_service
        self.evolution = evolution_service
        self.store = task_service.store
        with self.store.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS task_feedback_bundles(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_candidate_generations(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
            """)

    @staticmethod
    def _encode(value):
        return json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(",", ":"), allow_nan=False)

    def _insert(self, table, record):
        encoded, record_digest = self._encode(record), digest(record)
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = db.execute(
                f"SELECT data,digest FROM {table} WHERE id=?", (record["id"],)).fetchone()
            if previous and previous != (encoded, record_digest):
                raise ContractError("Cannot overwrite an immutable generation record")
            db.execute(f"INSERT OR IGNORE INTO {table} VALUES(?,?,?)",
                       (record["id"], encoded, record_digest))
        result = deepcopy(record)
        result["record_digest"] = record_digest
        return result

    def _get(self, table, identity):
        with self.store.connect() as db:
            row = db.execute(f"SELECT data,digest FROM {table} WHERE id=?", (identity,)).fetchone()
        if not row:
            raise KeyError(identity)
        record = json.loads(row[0])
        if digest(record) != row[1]:
            raise ContractError("Generation record digest mismatch")
        record["record_digest"] = row[1]
        return record

    def feedback(self, bundle_id):
        return self._get("task_feedback_bundles", bundle_id)

    def generation(self, generation_id):
        return self._get("task_candidate_generations", generation_id)

    def _development_boundary(self, episode):
        context = episode["task"].get("context") or {}
        registration = self.store.benchmark_registration(episode["id"]) or {}
        task_ref = registration.get("task_ref") or {}
        registered_context = task_ref.get("context") or {}
        observed = []
        for source in (context, registered_context):
            for key in ("split", "split_role"):
                value = source.get(key)
                if value is not None:
                    observed.append(value)
        if not observed or any(value != "development" for value in observed):
            raise ContractError("Feedback Episodes must be explicitly development-only")

    def capture_feedback(self, channel, episode_ids, expected_revision):
        """Freeze bounded digest references from terminal development Episodes."""
        episode_ids = _bounded_ids(episode_ids, "Feedback Episodes")
        active = self.evolution.active(channel)
        if type(expected_revision) is not int or expected_revision != active["revision"]:
            raise ContractError("Feedback capture expected revision is stale")

        episode_refs = []
        for identity in episode_ids:
            try:
                episode = self.tasks.get_private(identity)
            except KeyError:
                raise ContractError(f"Feedback Episode is not local: {identity}") from None
            if episode["status"] not in _TERMINAL:
                raise ContractError("Feedback Episodes must be terminal")
            self._development_boundary(episode)
            if (episode["package_id"] != active["package_id"]
                    or episode["package_digest"] != active["package_digest"]):
                raise ContractError("Feedback Episode does not use the current active parent")

            snapshot = self.store.memory_snapshot(episode["memory_snapshot_id"], identity)
            usage = episode["usage"]
            events = _checked_event_chain(identity, episode["events"])
            artifacts = episode["artifacts"]
            if len(events) > 512 or len(artifacts) > 256:
                raise ContractError("Feedback Episode evidence exceeds the capture bound")
            task = episode["task"]
            # Context can contain a hidden evaluator snapshot/task row, so its
            # contents stay host-side; only its digest is made visible.
            public_task = {
                "objective": task["objective"][:20000],
                "deliverables_digest": digest(task.get("deliverables") or []),
                "constraints_digest": digest(task.get("constraints") or {}),
                "context_digest": digest(task.get("context") or {}),
            }
            episode_refs.append({
                "episode_id": identity,
                "status": episode["status"],
                "package_id": episode["package_id"],
                "package_digest": episode["package_digest"],
                "task": {"digest": digest(task), "public": public_task},
                "memory": {"snapshot_id": snapshot["id"], "digest": snapshot["digest"],
                           "item_version_refs": deepcopy(snapshot.get("item_version_refs") or [])[:128]},
                "evaluation": _public_evaluation(episode.get("evaluation")),
                "outcome": _public_outcome(episode.get("outcome")),
                "execution_trace": _public_execution_trace(episode),
                "usage": {"digest": digest(usage), "summary": {
                    key: usage.get(key) for key in
                    ("model_calls", "charged_completion_tokens", "completion_tokens",
                     "tool_calls", "reserved_tool_work_units", "tool_work_units",
                     "charged_tool_work_units", "nodes", "usage_complete")}},
                "events": [{"sequence": event["sequence"], "kind": event["kind"],
                            "digest": event["digest"]} for event in events],
                "public_feedback": _public_feedback(identity, events, artifacts),
                "artifacts": [_artifact_ref(artifact) for artifact in artifacts],
                "outcome_digest": digest(episode.get("outcome")),
            })

        body = {"schema": FEEDBACK_SCHEMA, "channel": channel,
                "channel_revision": active["revision"],
                "parent_package_id": active["package_id"],
                "parent_package_digest": active["package_digest"],
                "parent_component_registry": _component_registry_snapshot(active["package"]),
                "episode_refs": episode_refs}
        record = {"id": _id("feedback"), **body, "digest": digest(body),
                  "created_at": time.time()}
        result = self._insert("task_feedback_bundles", record)
        self.evolution._event(channel, "feedback_captured", {
            "feedback_bundle_id": record["id"], "feedback_digest": record["digest"],
            "episode_ids": episode_ids, "parent_package_id": active["package_id"],
            "channel_revision": active["revision"], "record_digest": result["record_digest"],
        })
        return result

    @staticmethod
    def _mutation_policy(policy, parent):
        policy = _copy(policy, "Mutation policy")
        if not isinstance(policy, dict):
            raise ContractError("Mutation policy must be an object")
        if policy.get("patch_contract") == PACKAGE_PATCH_SCHEMA:
            if parent["manifest"].get("manifest_version") != 2:
                raise ContractError("PackagePatch v3 requires a manifest-v2 parent")
            builder = {key: value for key, value in policy.items()
                       if key != "patch_contract"}
            if set(builder) != {"mutable_components", "allow_add", "allow_remove",
                                "max_patch_bytes", "capability_ceiling",
                                "tool_ceiling", "max_parallel"}:
                raise ContractError("PackagePatch v3 mutation policy is incomplete")
            if (not isinstance(builder["mutable_components"], list)
                    or not builder["mutable_components"]
                    or any(not isinstance(identity, str)
                           for identity in builder["mutable_components"])
                    or len(set(builder["mutable_components"])) != len(builder["mutable_components"])
                    or any(identity not in parent["manifest"]["components"]
                           for identity in builder["mutable_components"])):
                raise ContractError("PackagePatch v3 mutable component set is invalid")
            registry = _component_registry_snapshot(parent)
            improve = parent["manifest"]["entries"].get("improve")
            improve_path = improve.split(":", 1)[0] if improve else None
            for identity in builder["mutable_components"]:
                descriptor = registry["components"][identity]
                if (descriptor["class"] not in {"O", "S"}
                        or len(descriptor["files"]) != 1
                        or descriptor["files"][0] == improve_path
                        or _path_tokens(descriptor["files"][0]) & _FORBIDDEN_TOKENS):
                    raise ContractError("PackagePatch v3 includes an unsafe mutable component")
            return {"targeting": "manifest_component_set_v3",
                    "package_patch_policy": builder,
                    "manifest_digest": registry["manifest_digest"]}
        manifest_v2 = parent["manifest"].get("manifest_version", 1) == 2
        default_operations = ["replace"] if manifest_v2 else ["replace", "add", "remove"]
        allowed = policy.get("allowed_operations", default_operations)
        if (not isinstance(allowed, list) or not allowed or len(set(allowed)) != len(allowed)
                or any(item not in {"replace", "add", "remove"} for item in allowed)):
            raise ContractError("Mutation policy has unsupported operations")
        max_bytes = policy.get("max_patch_bytes", 300000)
        if type(max_bytes) is not int or not 1 <= max_bytes <= 500000:
            raise ContractError("Mutation policy patch budget is invalid")

        if manifest_v2:
            if "mutable_paths" in policy or "component_classes" in policy:
                raise ContractError(
                    "Manifest v2 mutation policy must use stable component ids, not legacy paths/classes")
            if allowed != ["replace"]:
                raise ContractError(
                    "Stable manifest components currently permit only replacement")
            supplied = [key for key in ("mutable_components", "mutable_component_ids")
                        if key in policy]
            if len(supplied) != 1:
                raise ContractError(
                    "Manifest v2 mutation policy needs mutable_components")
            component_ids = policy[supplied[0]]
            if (not isinstance(component_ids, list) or not component_ids
                    or len(component_ids) > 128 or len(set(component_ids)) != len(component_ids)
                    or any(not isinstance(value, str) or not value for value in component_ids)):
                raise ContractError(
                    "Mutable components must be a nonempty unique list of stable ids")
            improve_ref = parent["manifest"]["entries"].get("improve")
            improve_path = improve_ref.split(":", 1)[0] if improve_ref else None
            registry = _component_registry_snapshot(parent)["components"]
            descriptors = {}
            for component_id in component_ids:
                descriptor = registry.get(component_id)
                if descriptor is None:
                    raise ContractError(f"Unknown manifest component id: {component_id!r}")
                descriptors[component_id] = descriptor
            classes = {descriptor["class"] for descriptor in descriptors.values()}
            if "M" in classes and classes != {"M"}:
                raise ContractError(
                    "O/S and M component updates cannot share one patch before compound release")
            memory_targeted = classes == {"M"}
            if memory_targeted and len(component_ids) != 1:
                raise ContractError("Memory evolution permits exactly one M component")
            resolved = {}
            for component_id in component_ids:
                descriptor = descriptors[component_id]
                if memory_targeted and descriptor["kind"] != "resource":
                    raise ContractError("M evolution requires a manifest resource component")
                if not memory_targeted and descriptor["class"] not in {"O", "S"}:
                    raise ContractError("Unsupported manifest component class")
                if len(descriptor["files"]) != 1:
                    raise ContractError(
                        "Mutable manifest components must resolve to exactly one declared file")
                path = descriptor["files"][0]
                owners = [identity for identity, value in registry.items()
                          if path in value["files"]]
                if owners != [component_id]:
                    raise ContractError(
                        f"Manifest component {component_id!r} shares its file with another component")
                if path == improve_path:
                    raise ContractError("The active package improve component is frozen")
                if _path_tokens(path) & _FORBIDDEN_TOKENS:
                    raise ContractError(
                        "Mutation policy cannot expose evaluator, gate, permission, manifest, or hidden paths")
                resolved[component_id] = descriptor
            return {
                "targeting": ("manifest_memory_component_v2" if memory_targeted
                              else "manifest_component_v2"),
                "mutable_components": list(component_ids),
                "resolved_components": resolved,
                "manifest_digest": digest(parent["manifest"]),
                "component_declaration_digests": {
                    component_id: parent["component_digests"][descriptor["files"][0]]
                    for component_id, descriptor in resolved.items()},
                "allowed_operations": allowed,
                "max_patch_bytes": max_bytes,
            }

        # Manifest v1 and path patches remain a deliberately marked legacy
        # compatibility contract. Their classes cannot become v2 authority.
        paths = policy.get("mutable_paths")
        classes = policy.get("component_classes")
        if (not isinstance(paths, list) or not paths or len(paths) > 128
                or len(set(paths)) != len(paths) or not isinstance(classes, dict)
                or set(classes) != set(paths)):
            raise ContractError("Mutation policy needs exact mutable path classifications")
        improve_ref = parent["manifest"]["entries"].get("improve")
        improve_path = improve_ref.split(":", 1)[0] if improve_ref else None
        for path in paths:
            try:
                safe_path(path)
            except Exception as exc:
                raise ContractError(str(exc)) from None
            if classes[path] not in _MUTABLE_CLASSES:
                raise ContractError("Mutable components must be classified as O, M, or S")
            if path == improve_path:
                raise ContractError("The active package improve component is frozen")
            if _path_tokens(path) & _FORBIDDEN_TOKENS:
                raise ContractError("Mutation policy cannot expose evaluator, gate, permission, manifest, or hidden paths")
        return {"targeting": "legacy_path_v1", "legacy": True,
                "mutable_paths": paths, "component_classes": classes,
                "allowed_operations": allowed, "max_patch_bytes": max_bytes}

    @staticmethod
    def _apply_patch(parent, patch, policy, generation_id, feedback, improver,
                     *, memory_parent=None):
        patch = _copy(patch, "BehaviorPatch")
        if policy.get("targeting") == "manifest_component_set_v3":
            from .package_patch_v3 import apply_package_patch
            if policy.get("manifest_digest") != digest(parent["manifest"]):
                raise ContractError("PackagePatch v3 parent manifest changed")
            provenance = {
                "origin": "generated", "generation_id": generation_id,
                "feedback_bundle_id": feedback["id"],
                "feedback_digest": feedback["digest"],
                "improver_package_id": improver["id"],
                "improver_package_digest": improver["digest"],
                "behavior_patch_digest": digest(patch),
            }
            child = apply_package_patch(parent, patch,
                                        policy["package_patch_policy"],
                                        provenance=provenance)
            return child, patch
        component_targeted = policy.get("targeting") in {
            "manifest_component_v2", "manifest_memory_component_v2"}
        memory_targeted = policy.get("targeting") == "manifest_memory_component_v2"
        if component_targeted:
            registry = _component_registry_snapshot(parent)
            if (policy.get("manifest_digest") != registry["manifest_digest"]
                    or any(policy.get("resolved_components", {}).get(component_id)
                           != registry["components"].get(component_id)
                           for component_id in policy.get("mutable_components", []))
                    or any(policy.get("component_declaration_digests", {}).get(component_id)
                           != parent["component_digests"].get(
                               registry["components"][component_id]["files"][0])
                           for component_id in policy.get("mutable_components", []))):
                raise ContractError(
                    "BehaviorPatch component policy differs from the frozen parent manifest")
        expected_schema = (MEMORY_PATCH_SCHEMA if memory_targeted else
                           PATCH_SCHEMA_V2 if component_targeted else PATCH_SCHEMA)
        hypothesis_fields = {"failure_mechanism", "expected_behavior",
                             "applicability", "falsifier"}
        if component_targeted:
            hypothesis_fields.add("component_id")
        if (not isinstance(patch, dict)
                or set(patch) != {"schema", "hypothesis", "operations", "activation_probe"}
                or patch.get("schema") != expected_schema
                or not isinstance(patch.get("hypothesis"), dict)
                or set(patch["hypothesis"]) != hypothesis_fields
                or any(not isinstance(value, str) or not value.strip() or len(value) > 5000
                       for value in patch["hypothesis"].values())
                or not isinstance(patch.get("operations"), list)
                or not 1 <= len(patch["operations"]) <= 128):
            raise ContractError("Improver output is not a strict BehaviorPatch")
        probe = patch.get("activation_probe")
        if component_targeted:
            component_id = probe.get("component_id") if isinstance(probe, dict) else None
            if (not isinstance(probe, dict) or set(probe) != {"kind", "component_id"}
                    or probe.get("kind") != (
                        "memory_snapshot_frozen" if memory_targeted else "component_loaded")
                    or component_id not in policy["mutable_components"]
                    or patch["hypothesis"].get("component_id") != component_id):
                raise ContractError(
                    "BehaviorPatch v2 hypothesis and activation probe must name one mutable component id")
        else:
            component_id = None
            if (not isinstance(probe, dict) or set(probe) != {"kind", "path"}
                    or probe.get("kind") != "component_loaded"
                    or probe.get("path") not in policy["mutable_paths"]):
                raise ContractError("Legacy BehaviorPatch activation probe must name a mutable path")
        encoded = json.dumps(patch, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        if len(encoded.encode("utf-8")) > policy["max_patch_bytes"]:
            raise ContractError("BehaviorPatch exceeds its byte budget")
        if memory_targeted:
            if (not isinstance(memory_parent, dict)
                    or set(memory_parent) != {"policy", "data"}):
                raise ContractError("Memory patch requires the frozen active memory resource")
            if len(patch["operations"]) != 1:
                raise ContractError("Memory patch requires exactly one replacement")
            operation = patch["operations"][0]
            expected_keys = {"op", "component_id", "surface", "old_digest", "value"}
            if (not isinstance(operation, dict) or set(operation) != expected_keys
                    or operation.get("op") != "replace"
                    or operation.get("component_id") != component_id):
                raise ContractError("Memory patch operation fields do not match one replacement")
            surface = operation.get("surface")
            if surface not in {"policy", "data"}:
                raise ContractError("Memory patch surface must be policy or data")
            if operation["old_digest"] != digest(memory_parent[surface]):
                raise ContractError("Memory patch old digest does not match the active memory surface")
            value = operation["value"]
            if not isinstance(value, dict) or digest(value) == digest(memory_parent[surface]):
                raise ContractError("Memory patch replacement must be a changed object")
            resource = deepcopy(memory_parent)
            resource[surface] = deepcopy(value)
            return resource, patch
        files, seen = deepcopy(parent["files"]), set()
        for operation in patch["operations"]:
            if not isinstance(operation, dict):
                raise ContractError("BehaviorPatch operations must be objects")
            op = operation.get("op")
            if component_targeted:
                operation_component_id = operation.get("component_id")
                if (op not in policy["allowed_operations"]
                        or operation_component_id not in policy["mutable_components"]
                        or operation_component_id != component_id):
                    raise ContractError(
                        "BehaviorPatch operation crosses its declared manifest component")
                descriptor = policy["resolved_components"][operation_component_id]
                path = descriptor["files"][0]
                target_field = "component_id"
            else:
                path = operation.get("path")
                if op not in policy["allowed_operations"] or path not in policy["mutable_paths"]:
                    raise ContractError("BehaviorPatch operation is outside the mutation policy")
                target_field = "path"
            if path in seen:
                raise ContractError("BehaviorPatch cannot modify one path twice")
            seen.add(path)
            expected_keys = ({"op", target_field, "content"} if op == "add" else
                             {"op", target_field, "old_digest", "content"}
                             if op == "replace" else
                             {"op", target_field, "old_digest"})
            if set(operation) != expected_keys:
                raise ContractError("BehaviorPatch operation fields do not match its operation")
            if op in {"replace", "remove"}:
                if path not in files or operation["old_digest"] != parent["component_digests"].get(path):
                    raise ContractError("BehaviorPatch old digest does not match the active parent")
            if op == "add":
                if path in files:
                    raise ContractError("BehaviorPatch add target already exists")
                content = operation["content"]
                if not isinstance(content, str):
                    raise ContractError("BehaviorPatch content must be text")
                files[path] = content
            elif op == "replace":
                content = operation["content"]
                if not isinstance(content, str) or digest(content) == parent["component_digests"][path]:
                    raise ContractError("BehaviorPatch replacement must change the component")
                files[path] = content
            else:
                del files[path]
        provenance = {
            "origin": "generated", "generation_id": generation_id,
            "feedback_bundle_id": feedback["id"], "feedback_digest": feedback["digest"],
            "improver_package_id": improver["id"], "improver_package_digest": improver["digest"],
            "behavior_patch_digest": digest(patch),
        }
        try:
            child = make_package(files, deepcopy(parent["manifest"]), parent=parent,
                                 provenance=provenance)
            if child["manifest"] != parent["manifest"]:
                raise ContractError("BehaviorPatch changed the frozen parent manifest")
            return child, patch
        except Exception as exc:
            raise ContractError(f"BehaviorPatch cannot form a valid child package: {str(exc)[:500]}") from None

    def _missing(self, base, reason, *, episode=None, patch_digest=None):
        reason = str(reason)[:1500]
        record = {**base, "status": "missing", "reason": reason,
                  "reason_type": _error_type(reason), "reason_digest": digest(reason),
                  "episode_id": episode["id"] if episode else None,
                  "episode_status": episode.get("status") if episode else None,
                  "usage": deepcopy(episode.get("usage")) if episode else None,
                   "execution": deepcopy(episode.get("execution")) if episode else None,
                   "patch_digest": patch_digest, "candidate_id": None,
                   "candidate_package_id": None, "memory_candidate_id": None,
                   "memory_candidate_digest": None, "completed_at": time.time()}
        result = self._insert("task_candidate_generations", record)
        self.evolution._event(base["channel"], "candidate_generation_missing", {
            "generation_id": base["id"], "feedback_bundle_id": base["feedback_bundle_id"],
            "episode_id": record["episode_id"], "reason_type": record["reason_type"],
            "reason_digest": record["reason_digest"],
            "record_digest": result["record_digest"],
        })
        return result

    def generate(self, channel, feedback_bundle_id, improver_package, mutation_policy,
                 expected_revision, *, improver_channel=None,
                 expected_improver_revision=None, budget=None, stop_event=None,
                 admission_check=None, memory_channel=None,
                 expected_memory_revision=None):
        """Execute ``improve`` and admit its valid child, or persist missing evidence."""
        if admission_check is not None and not callable(admission_check):
            raise TypeError("admission_check must be callable")
        feedback = self.feedback(feedback_bundle_id)
        active = self.evolution.active(channel)
        if feedback["channel"] != channel:
            raise ContractError("Feedback bundle belongs to another channel")
        if (type(expected_revision) is not int or expected_revision != active["revision"]
                or feedback["channel_revision"] != active["revision"]
                or feedback["parent_package_id"] != active["package_id"]
                or feedback["parent_package_digest"] != active["package_digest"]):
            raise ContractError("Candidate generation expected revision or parent is stale")
        if improver_channel is not None:
            if improver_package is not None:
                raise ContractError("Specify either an improver package or an improver channel")
            from .improvers import active_improver_registration
            registration = active_improver_registration(self.store, improver_channel)
            if (type(expected_improver_revision) is not int
                    or expected_improver_revision != registration["revision"]):
                raise ContractError("Improver channel expected revision is stale")
            improver_package = registration["package"]
            improver_registration = {
                "channel": registration["channel"],
                "revision": registration["revision"],
                "package_id": registration["package_id"],
                "package_digest": registration["package_digest"],
            }
        else:
            if expected_improver_revision is not None:
                raise ContractError("An improver revision requires an improver channel")
            improver_registration = None
        if improver_package is None:
            raise ContractError("Candidate generation requires an improver package or channel")
        verify_package(improver_package)
        if "improve" not in improver_package["manifest"]["entries"]:
            raise ContractError("Improver AgentPackage must register the improve entry")
        if improver_package["id"] == active["package_id"]:
            raise ContractError("Improver AgentPackage must be independently versioned")
        policy = self._mutation_policy(mutation_policy, active["package"])
        memory_targeted = policy["targeting"] == "manifest_memory_component_v2"
        memory_service = None
        memory_registration = None
        memory_parent = None
        if memory_targeted:
            if (memory_channel is None or type(expected_memory_revision) is not int
                    or expected_memory_revision < 0):
                raise ContractError(
                    "Memory generation requires a memory channel and expected revision")
            from .memory import MemoryService
            memory_service = MemoryService(self.tasks)
            resolved_memory = memory_service.active(memory_channel)
            if resolved_memory["revision"] != expected_memory_revision:
                raise ContractError("Memory generation expected revision is stale")
            if (resolved_memory["package_id"] != active["package_id"]
                    or resolved_memory["package_digest"] != active["package_digest"]):
                raise ContractError(
                    "Active memory belongs to a different task package release")
            memory_registration = {key: deepcopy(resolved_memory[key]) for key in (
                "channel", "revision", "memory_id", "memory_digest",
                "package_id", "package_digest")}
            memory_parent = memory_service.version(memory_registration["memory_id"])
            policy = {**policy,
                      "memory_release": deepcopy(memory_registration),
                      "memory_resource_digest": digest(memory_parent["resource"]),
                      "memory_surface_digests": {
                          surface: digest(memory_parent["resource"][surface])
                          for surface in ("policy", "data")}}
        elif memory_channel is not None or expected_memory_revision is not None:
            raise ContractError("Memory release arguments require a pure M component policy")
        registry = _component_registry_snapshot(active["package"])
        if feedback.get("parent_component_registry") != registry:
            raise ContractError("Feedback component registry does not match the frozen parent")
        patch_schema = (PACKAGE_PATCH_SCHEMA if policy["targeting"] == "manifest_component_set_v3"
                        else MEMORY_PATCH_SCHEMA if memory_targeted
                        else PATCH_SCHEMA_V2 if policy["targeting"] == "manifest_component_v2"
                        else PATCH_SCHEMA)
        deliverable_name = "memory_patch" if memory_targeted else "behavior_patch"
        improver_entry = improver_package["manifest"]["entries"]["improve"]
        # The complete immutable package is the conservative execution closure:
        # controlled code may load source modules or read packaged resources.
        # The runtime receipt below additionally proves which entry/modules ran.
        closure = deepcopy(improver_package["component_digests"])
        closure_digest = digest({"entry": improver_entry, "components": closure})
        generation_id = _id("generation")
        base = {
            "schema": GENERATION_SCHEMA, "id": generation_id, "channel": channel,
            "channel_revision": active["revision"],
            "parent_package_id": active["package_id"],
            "parent_package_digest": active["package_digest"],
            "feedback_bundle_id": feedback["id"], "feedback_digest": feedback["digest"],
            "improver_package_id": improver_package["id"],
            "improver_package_digest": improver_package["digest"],
            "improver_registration": improver_registration,
            "improver_entry": improver_entry,
            "improver_closure": closure,
            "improver_closure_digest": closure_digest,
            "patch_contract": patch_schema,
            "targeting": policy["targeting"],
            "legacy_path_patch": policy["targeting"] == "legacy_path_v1",
            "memory_parent_registration": deepcopy(memory_registration),
            "mutation_policy": policy, "mutation_policy_digest": digest(policy),
            "created_at": time.time(),
        }
        if policy["targeting"] == "manifest_component_set_v3":
            components = []
            for component_id in policy["package_patch_policy"]["mutable_components"]:
                descriptor = deepcopy(registry["components"][component_id])
                path = descriptor["files"][0]
                components.append({**descriptor, "path": path,
                                   "digest": active["package"]["component_digests"][path],
                                   "content": active["package"]["files"][path],
                                   "exists": True})
        elif policy["targeting"] in {"manifest_component_v2", "manifest_memory_component_v2"}:
            components = []
            for component_id in policy["mutable_components"]:
                descriptor = deepcopy(policy["resolved_components"][component_id])
                path = descriptor["files"][0]
                if memory_targeted:
                    components.append({
                        **descriptor, "path": path,
                        "declaration_digest": active["package"]["component_digests"][path],
                        "memory_registration": deepcopy(memory_registration),
                        "memory_resource_digest": digest(memory_parent["resource"]),
                        "surface_digests": deepcopy(policy["memory_surface_digests"]),
                        "surface_shape": {
                            "policy_fields": sorted(memory_parent["resource"]["policy"]),
                            "data_fields": sorted(memory_parent["resource"]["data"]),
                            "item_count": len(memory_parent["resource"]["data"]["items"]),
                        },
                        "exists": True})
                else:
                    components.append({**descriptor, "path": path,
                                       "digest": active["package"]["component_digests"][path],
                                       "content": active["package"]["files"][path],
                                       "exists": True})
        else:
            components = [{"path": path, "class": policy["component_classes"][path],
                           "digest": active["package"]["component_digests"].get(path),
                           "content": active["package"]["files"].get(path),
                           "exists": path in active["package"]["files"],
                           "legacy": True}
                          for path in policy["mutable_paths"]]
        feedback_input = {key: deepcopy(value) for key, value in feedback.items()
                          if key != "record_digest"}
        if policy["targeting"] in {"manifest_component_v2", "manifest_memory_component_v2",
                                   "manifest_component_set_v3"}:
            mutable_component_ids = (policy["package_patch_policy"]["mutable_components"]
                                     if policy["targeting"] == "manifest_component_set_v3"
                                     else policy["mutable_components"])
            feedback_input["parent_component_registry"] = {
                "manifest_version": 2,
                "manifest_digest": registry["manifest_digest"],
                "components": {
                    component_id: deepcopy(registry["components"][component_id])
                    for component_id in mutable_component_ids}}
        inputs = {"feedback_bundle": feedback_input,
                  "parent_components": components,
                  "mutation_policy": policy}
        if policy["targeting"] == "manifest_component_set_v3":
            inputs["parent_manifest"] = deepcopy(active["package"]["manifest"])
            inputs["parent_package_digest"] = active["package"]["digest"]
        def admit(boundary):
            if admission_check is not None:
                admission_check({
                    "kind": "generate_task_agent_candidate",
                    "boundary": boundary,
                    "channel": channel,
                    "expected_revision": expected_revision,
                })

        episode = None
        admit("generation_create")
        try:
            episode_context = {"split": "development", "split_role": "development",
                               "rsi_role": "candidate_generation", "channel": channel,
                               "channel_revision": active["revision"],
                               "feedback_bundle_id": feedback["id"]}
            if memory_targeted:
                episode_context["target_memory_registration"] = deepcopy(memory_registration)
            episode = self.tasks.create(
                ("Generate one feedback-bound MemoryComponentPatch for the active memory release"
                 if memory_targeted else
                 "Generate one feedback-bound BehaviorPatch for the active AgentPackage"),
                inputs=inputs,
                deliverables=[{"name": deliverable_name, "schema": _patch_schema(
                    patch_schema, memory_targeted=memory_targeted)}],
                budget=budget, capabilities=[], package=improver_package,
                context=episode_context,
                constraints={"allowed_effects": [], "wall_seconds": 1200}, entry="improve",
                improver_channel_registration=improver_registration)
        except Exception as exc:
            if episode is not None:
                episode = self.tasks.get_private(episode["id"])
            return self._missing(base, f"{type(exc).__name__}: {str(exc)}", episode=episode)
        admit("generation_run")
        try:
            episode = self.tasks.run(episode["id"], stop_event=stop_event)
        except Exception as exc:
            if episode is not None:
                episode = self.tasks.get_private(episode["id"])
            return self._missing(base, f"{type(exc).__name__}: {str(exc)}", episode=episode)
        if episode["status"] != "completed":
            return self._missing(base, episode.get("last_error") or
                                 f"Improver Episode ended {episode['status']}", episode=episode)
        if episode.get("usage", {}).get("usage_complete") is not True:
            return self._missing(base, "Improver Episode usage receipt is incomplete", episode=episode)
        try:
            if set(episode["output_refs"]) != {deliverable_name}:
                raise ContractError(
                    f"Improver did not publish exactly one {deliverable_name} deliverable")
            artifact = self.store.read(episode["output_refs"][deliverable_name], episode["id"])
            if artifact["producer"].get("package_digest") != improver_package["digest"]:
                raise ContractError("BehaviorPatch producer does not match the improver package")
            if memory_targeted and (
                    artifact.get("name") != "memory_patch"
                    or artifact.get("schema_ref") != MEMORY_PATCH_SCHEMA
                    or artifact.get("validation", {}).get("schema_status") != "passed"):
                raise ContractError(
                    "MemoryComponentPatch artifact identity or validation is invalid")
            execution = episode.get("execution") or {}
            if (execution.get("entry") != "improve"
                    or execution.get("package_digest") != improver_package["digest"]):
                raise ContractError("Candidate generation lacks an actual improve entry receipt")
            if improver_registration is not None:
                from .improvers import active_improver_registration
                current_improver = active_improver_registration(
                    self.store, improver_registration["channel"])
                if any(current_improver[key] != improver_registration[key]
                       for key in ("revision", "package_id", "package_digest")):
                    raise ContractError("Active improver changed during candidate generation")
                if (episode.get("task", {}).get("context", {}).get(
                        "improver_channel_registration") != improver_registration):
                    raise ContractError("Improver channel registration is missing from the Episode")
            loaded = execution.get("loaded_modules") or []
            entry_path = improver_entry.split(":", 1)[0]
            if entry_path not in loaded:
                raise ContractError("Improver execution closure is missing")
            candidate_value, patch = self._apply_patch(
                active["package"], artifact["content"], policy,
                generation_id, feedback, improver_package,
                memory_parent=(memory_parent["resource"] if memory_targeted else None))
            patch_digest = digest(patch)
            if policy["targeting"] in {"manifest_component_v2",
                                        "manifest_memory_component_v2"}:
                component_id = patch["activation_probe"]["component_id"]
                component_target = deepcopy(policy["resolved_components"][component_id])
            else:
                component_id = None
                component_target = None
            current = self.evolution.active(channel)
            if (current["revision"] != active["revision"]
                    or current["package_digest"] != active["package_digest"]):
                return self._missing(base, "Active parent changed during candidate generation",
                                     episode=episode, patch_digest=patch_digest)
            if memory_targeted:
                current_memory = memory_service.active(memory_registration["channel"])
                if any(current_memory[key] != memory_registration[key]
                       for key in memory_registration):
                    return self._missing(
                        base, "Active memory changed during candidate generation",
                        episode=episode, patch_digest=patch_digest)
                declaration_digest = policy[
                    "component_declaration_digests"][component_id]
                component_contract_digest = digest({
                    "manifest_digest": policy["manifest_digest"],
                    "component_target": component_target,
                    "component_declaration_digest": declaration_digest,
                    "patch_contract": patch_schema,
                })
                change_scope = {
                    "component_id": component_id,
                    "surface": patch["operations"][0]["surface"],
                }
                provenance = {
                    "origin": "generated_memory_component",
                    "generation_id": generation_id,
                    "feedback_bundle_id": feedback["id"],
                    "feedback_digest": feedback["digest"],
                    "improver_package_id": improver_package["id"],
                    "improver_package_digest": improver_package["digest"],
                    "memory_patch_digest": patch_digest,
                    "task_package_registration": {
                        "channel": channel, "revision": active["revision"],
                        "package_id": active["package_id"],
                        "package_digest": active["package_digest"]},
                    "memory_parent_registration": deepcopy(memory_registration),
                    "component_id": component_id,
                    "component_target": deepcopy(component_target),
                    "manifest_digest": policy["manifest_digest"],
                    "component_declaration_digest": declaration_digest,
                    "component_contract_digest": component_contract_digest,
                    "change_scope": deepcopy(change_scope),
                }
                memory_record = {
                    **base, "status": "generated", "reason": None,
                    "episode_id": episode["id"], "episode_status": episode["status"],
                    "usage": deepcopy(episode["usage"]),
                    "execution": deepcopy(episode["execution"]),
                    "patch_digest": patch_digest, "component_id": component_id,
                    "component_target": component_target,
                    "manifest_digest": policy["manifest_digest"],
                    "component_declaration_digest": declaration_digest,
                    "component_contract_digest": component_contract_digest,
                    "change_scope": deepcopy(change_scope),
                    "candidate_kind": "memory_version", "candidate_id": None,
                    "candidate_package_id": None, "candidate_package_digest": None,
                    "completed_at": time.time(),
                }
                memory_candidate, result = memory_service.admit_generated(
                    active["package"], candidate_value,
                    parent_id=memory_registration["memory_id"], provenance=provenance,
                    generation_record=memory_record)
                child = None
                candidate = None
            else:
                child = candidate_value
                activation_probe = (
                    {"kind": "component_set_loaded",
                     "component_ids": patch["activation_targets"]}
                    if policy["targeting"] == "manifest_component_set_v3"
                    else patch["activation_probe"])
                candidate = self.evolution.propose(
                    channel, child, hypothesis=patch["hypothesis"],
                    feedback_episode_ids=[item["episode_id"] for item in feedback["episode_refs"]],
                    activation_probe=activation_probe,
                    component_classes=(None if component_id is not None
                                       or policy["targeting"] == "manifest_component_set_v3"
                                       else policy["component_classes"]),
                    component_target=component_target, origin="generated",
                    package_patch=(patch if policy["targeting"] == "manifest_component_set_v3"
                                   else None),
                    mutation_policy=(policy["package_patch_policy"]
                                     if policy["targeting"] == "manifest_component_set_v3"
                                     else None))
                component_target = deepcopy(candidate.get("component_target"))
        except Exception as exc:
            return self._missing(base, f"{type(exc).__name__}: {str(exc)}", episode=episode,
                                 patch_digest=(digest(artifact["content"])
                                               if 'artifact' in locals() else None))

        if memory_targeted:
            self.evolution._event(channel, "memory_candidate_generated", {
                "generation_id": generation_id, "feedback_bundle_id": feedback["id"],
                "improver_episode_id": episode["id"],
                "improver_package_id": improver_package["id"],
                "improver_registration": improver_registration,
                "improver_closure_digest": closure_digest, "patch_digest": patch_digest,
                "component_id": component_id, "component_target": component_target,
                "memory_parent_registration": memory_registration,
                "memory_candidate_id": memory_candidate["id"],
                "memory_candidate_digest": memory_candidate["digest"],
                "record_digest": result["record_digest"],
            })
            return result

        record = {**base, "status": "generated", "reason": None,
                  "episode_id": episode["id"], "episode_status": episode["status"],
                  "usage": deepcopy(episode["usage"]), "execution": deepcopy(episode["execution"]),
                  "patch_digest": patch_digest, "component_id": component_id,
                  "component_target": component_target,
                  "component_declaration_digest": (
                      policy.get("component_declaration_digests", {}).get(component_id)),
                  "candidate_kind": "agent_package",
                  "candidate_id": candidate["id"],
                  "candidate_package_id": child["id"],
                  "candidate_package_digest": child["digest"],
                  "memory_candidate_id": None, "memory_candidate_digest": None,
                  "completed_at": time.time()}
        result = self._insert("task_candidate_generations", record)
        self.evolution._event(channel, "candidate_generated", {
            "generation_id": generation_id, "feedback_bundle_id": feedback["id"],
            "improver_episode_id": episode["id"], "improver_package_id": improver_package["id"],
            "improver_registration": improver_registration,
            "improver_closure_digest": closure_digest, "patch_digest": patch_digest,
            "component_id": component_id, "component_target": component_target,
            "candidate_id": candidate["id"], "candidate_package_id": child["id"],
            "memory_candidate_id": None, "memory_candidate_digest": None,
            "record_digest": result["record_digest"],
        })
        return result
