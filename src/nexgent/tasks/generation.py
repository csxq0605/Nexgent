"""Feedback-bound generation of immutable AgentPackage candidates.

The improver is an ordinary, separately versioned AgentPackage.  It executes
through :class:`TaskService` and can only return a declarative BehaviorPatch.
The host owns feedback boundaries, patch validation, package construction, and
candidate admission.  A failed generation is durable evidence, never a
candidate.
"""

from __future__ import annotations

from copy import deepcopy
import json
import re
import time
import uuid

from ..kernel.programs import digest
from .packages import make_package, safe_path, verify_package
from .tools import ContractError


FEEDBACK_SCHEMA = "nexgent.feedback-bundle.v1"
PATCH_SCHEMA = "nexgent.behavior-patch.v1"
GENERATION_SCHEMA = "nexgent.candidate-generation.v1"
_TERMINAL = frozenset({"completed", "failed"})
_MUTABLE_CLASSES = frozenset({"O", "M", "S"})
_FORBIDDEN_TOKENS = frozenset({
    "benchmark", "evaluator", "evaluation", "gate", "gating", "permission",
    "permissions", "manifest", "holdout", "secret", "hidden",
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
    return {
        "failure_domain": episode.get("failure_domain"),
        "last_error_type": _error_type(episode.get("last_error")),
        "node_counts": counts,
        "nodes": rows,
        "truncated_nodes": max(0, len(nodes) - len(rows)),
    }


def _patch_schema():
    operation = {
        "type": "object",
        "required": ["op", "path"],
        "properties": {
            "op": {"enum": ["replace", "add", "remove"]},
            "path": {"type": "string", "minLength": 1, "maxLength": 240},
            "old_digest": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
            "content": {"type": "string", "maxLength": 100000},
        },
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "required": ["schema", "hypothesis", "operations", "activation_probe"],
        "properties": {
            "schema": {"const": PATCH_SCHEMA},
            "hypothesis": {
                "type": "object",
                "required": ["failure_mechanism", "expected_behavior", "applicability", "falsifier"],
                "properties": {key: {"type": "string", "minLength": 1, "maxLength": 5000}
                               for key in ("failure_mechanism", "expected_behavior",
                                           "applicability", "falsifier")},
                "additionalProperties": False,
            },
            "operations": {"type": "array", "minItems": 1, "maxItems": 128,
                           "items": operation},
            "activation_probe": {
                "type": "object", "required": ["kind", "path"],
                "properties": {"kind": {"const": "component_loaded"},
                               "path": {"type": "string", "minLength": 1, "maxLength": 240}},
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
                episode = self.tasks.get(identity)
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
            events = episode["events"]
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
                "execution_trace": _public_execution_trace(episode),
                "usage": {"digest": digest(usage), "summary": {
                    key: usage.get(key) for key in
                    ("model_calls", "charged_completion_tokens", "completion_tokens",
                     "tool_calls", "nodes", "usage_complete")}},
                "events": [{"sequence": event["sequence"], "kind": event["kind"],
                            "digest": event["digest"]} for event in events],
                "artifacts": [_artifact_ref(artifact) for artifact in artifacts],
                "outcome_digest": digest(episode.get("outcome")),
            })

        body = {"schema": FEEDBACK_SCHEMA, "channel": channel,
                "channel_revision": active["revision"],
                "parent_package_id": active["package_id"],
                "parent_package_digest": active["package_digest"],
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
        allowed = policy.get("allowed_operations", ["replace", "add", "remove"])
        if (not isinstance(allowed, list) or not allowed or len(set(allowed)) != len(allowed)
                or any(item not in {"replace", "add", "remove"} for item in allowed)):
            raise ContractError("Mutation policy has unsupported operations")
        max_bytes = policy.get("max_patch_bytes", 300000)
        if type(max_bytes) is not int or not 1 <= max_bytes <= 500000:
            raise ContractError("Mutation policy patch budget is invalid")
        return {"mutable_paths": paths, "component_classes": classes,
                "allowed_operations": allowed, "max_patch_bytes": max_bytes}

    @staticmethod
    def _apply_patch(parent, patch, policy, generation_id, feedback, improver):
        patch = _copy(patch, "BehaviorPatch")
        if (not isinstance(patch, dict)
                or set(patch) != {"schema", "hypothesis", "operations", "activation_probe"}
                or patch.get("schema") != PATCH_SCHEMA
                or not isinstance(patch.get("hypothesis"), dict)
                or set(patch["hypothesis"]) != {"failure_mechanism", "expected_behavior",
                                                "applicability", "falsifier"}
                or any(not isinstance(value, str) or not value.strip() or len(value) > 5000
                       for value in patch["hypothesis"].values())
                or not isinstance(patch.get("operations"), list)
                or not 1 <= len(patch["operations"]) <= 128):
            raise ContractError("Improver output is not a strict BehaviorPatch")
        probe = patch.get("activation_probe")
        if (not isinstance(probe, dict) or set(probe) != {"kind", "path"}
                or probe.get("kind") != "component_loaded"
                or probe.get("path") not in policy["mutable_paths"]):
            raise ContractError("BehaviorPatch activation probe must name a mutable component")
        encoded = json.dumps(patch, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        if len(encoded.encode("utf-8")) > policy["max_patch_bytes"]:
            raise ContractError("BehaviorPatch exceeds its byte budget")
        files, seen = deepcopy(parent["files"]), set()
        for operation in patch["operations"]:
            if not isinstance(operation, dict):
                raise ContractError("BehaviorPatch operations must be objects")
            op, path = operation.get("op"), operation.get("path")
            if op not in policy["allowed_operations"] or path not in policy["mutable_paths"]:
                raise ContractError("BehaviorPatch operation is outside the mutation policy")
            if path in seen:
                raise ContractError("BehaviorPatch cannot modify one path twice")
            seen.add(path)
            expected_keys = ({"op", "path", "content"} if op == "add" else
                             {"op", "path", "old_digest", "content"} if op == "replace" else
                             {"op", "path", "old_digest"})
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
            return make_package(files, deepcopy(parent["manifest"]), parent=parent,
                                provenance=provenance), patch
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
                  "candidate_package_id": None, "completed_at": time.time()}
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
                 expected_improver_revision=None, budget=None, stop_event=None):
        """Execute ``improve`` and admit its valid child, or persist missing evidence."""
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
            "mutation_policy": policy, "mutation_policy_digest": digest(policy),
            "created_at": time.time(),
        }
        components = [{"path": path, "class": policy["component_classes"][path],
                       "digest": active["package"]["component_digests"].get(path),
                       "content": active["package"]["files"].get(path),
                       "exists": path in active["package"]["files"]}
                      for path in policy["mutable_paths"]]
        inputs = {"feedback_bundle": {key: deepcopy(value) for key, value in feedback.items()
                                      if key != "record_digest"},
                  "parent_components": components,
                  "mutation_policy": policy}
        episode = None
        try:
            episode_context = {"split": "development", "split_role": "development",
                               "rsi_role": "candidate_generation", "channel": channel,
                               "channel_revision": active["revision"],
                               "feedback_bundle_id": feedback["id"]}
            episode = self.tasks.create(
                "Generate one feedback-bound BehaviorPatch for the active AgentPackage",
                inputs=inputs,
                deliverables=[{"name": "behavior_patch", "schema": _patch_schema()}],
                budget=budget, capabilities=[], package=improver_package,
                context=episode_context,
                constraints={"allowed_effects": [], "wall_seconds": 1200}, entry="improve",
                improver_channel_registration=improver_registration)
            episode = self.tasks.run(episode["id"], stop_event=stop_event)
        except Exception as exc:
            if episode is not None:
                episode = self.tasks.get(episode["id"])
            return self._missing(base, f"{type(exc).__name__}: {str(exc)}", episode=episode)
        if episode["status"] != "completed":
            return self._missing(base, episode.get("last_error") or
                                 f"Improver Episode ended {episode['status']}", episode=episode)
        if episode.get("usage", {}).get("usage_complete") is not True:
            return self._missing(base, "Improver Episode usage receipt is incomplete", episode=episode)
        try:
            if set(episode["output_refs"]) != {"behavior_patch"}:
                raise ContractError("Improver did not publish exactly one BehaviorPatch deliverable")
            artifact = self.store.read(episode["output_refs"]["behavior_patch"], episode["id"])
            if artifact["producer"].get("package_digest") != improver_package["digest"]:
                raise ContractError("BehaviorPatch producer does not match the improver package")
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
            child, patch = self._apply_patch(active["package"], artifact["content"], policy,
                                             generation_id, feedback, improver_package)
            patch_digest = digest(patch)
            current = self.evolution.active(channel)
            if (current["revision"] != active["revision"]
                    or current["package_digest"] != active["package_digest"]):
                return self._missing(base, "Active parent changed during candidate generation",
                                     episode=episode, patch_digest=patch_digest)
            candidate = self.evolution.propose(
                channel, child, hypothesis=patch["hypothesis"],
                feedback_episode_ids=[item["episode_id"] for item in feedback["episode_refs"]],
                activation_probe=patch["activation_probe"],
                component_classes=policy["component_classes"], origin="generated")
        except Exception as exc:
            return self._missing(base, f"{type(exc).__name__}: {str(exc)}", episode=episode,
                                 patch_digest=(digest(artifact["content"])
                                               if 'artifact' in locals() else None))

        record = {**base, "status": "generated", "reason": None,
                  "episode_id": episode["id"], "episode_status": episode["status"],
                  "usage": deepcopy(episode["usage"]), "execution": deepcopy(episode["execution"]),
                  "patch_digest": patch_digest, "candidate_id": candidate["id"],
                  "candidate_package_id": child["id"], "candidate_package_digest": child["digest"],
                  "completed_at": time.time()}
        result = self._insert("task_candidate_generations", record)
        self.evolution._event(channel, "candidate_generated", {
            "generation_id": generation_id, "feedback_bundle_id": feedback["id"],
            "improver_episode_id": episode["id"], "improver_package_id": improver_package["id"],
            "improver_registration": improver_registration,
            "improver_closure_digest": closure_digest, "patch_digest": patch_digest,
            "candidate_id": candidate["id"], "candidate_package_id": child["id"],
            "record_digest": result["record_digest"],
        })
        return result
