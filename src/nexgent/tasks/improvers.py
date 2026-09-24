"""Recursive, feedback-bound evolution of independently versioned improvers.

Improver packages (``R``) have their own archive, channel and audit chain.  An
active R may execute its real ``improve`` entry to propose R's next immutable
version.  The trusted host owns feedback admission, mutation validation,
evaluation references and compare-and-swap deployment.

This control plane deliberately does not score improvers.  A separate meta
evaluator writes immutable ``task_improver_meta_evaluations`` records; only a
verified record from that table can authorize promotion here.
"""

from __future__ import annotations

import ast
from copy import deepcopy
import json
import re
import time
import uuid

from ..kernel.programs import digest
from .packages import CAPABILITIES, verify_package
from .patches import (
    IMPROVER_PATCH_SCHEMA,
    apply_improver_patch,
    improver_patch_schema,
    normalize_improver_policy,
)
from .tools import ContractError


META_FEEDBACK_SCHEMA = "nexgent.improver-meta-feedback.v1"
IMPROVER_GENERATION_SCHEMA = "nexgent.improver-generation.v1"
IMPROVER_CANDIDATE_SCHEMA = "nexgent.improver-candidate.v1"
IMPROVER_DECISION_SCHEMA = "nexgent.improver-decision.v1"
_GENERATION_EVIDENCE_STATUSES = frozenset(
    {"completed", "failed", "paused", "waiting_input"})


def _copy(value, label="Improver value"):
    try:
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":"), allow_nan=False)
        return json.loads(encoded)
    except (TypeError, ValueError, RecursionError) as exc:
        raise ContractError(f"{label} must be finite JSON: {str(exc)[:500]}") from None


def _id(prefix):
    return prefix + "-" + uuid.uuid4().hex[:16]


def _identifier(value, label):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9_.-]{0,99}", value):
        raise ContractError(f"{label} must be a bounded lowercase identifier")
    return value


def _ids(values, label, *, allow_empty=False):
    if (not isinstance(values, list) or (not allow_empty and not values)
            or len(values) > 128 or len(set(values)) != len(values)
            or any(not isinstance(value, str) or not value for value in values)):
        qualifier = "a unique bounded list" if allow_empty else "a nonempty unique bounded list"
        raise ContractError(f"{label} must be {qualifier}")
    return list(values)


def _capability_envelope(value):
    if value is None:
        value = {
            "builtin_methods": ["ask", "read_artifact", "publish"],
            "tools": [],
            "allowed_effects": [],
        }
    value = _copy(value, "Improver capability envelope")
    if not isinstance(value, dict) or set(value) != {
            "builtin_methods", "tools", "allowed_effects"}:
        raise ContractError("Improver capability envelope has unknown fields")
    builtins = value["builtin_methods"]
    if (not isinstance(builtins, list) or len(set(builtins)) != len(builtins)
            or any(item not in {"ask", "read_artifact", "publish"} for item in builtins)
            or not {"read_artifact", "publish"}.issubset(builtins)):
        raise ContractError("Improver builtin capability envelope is invalid")
    if value["tools"] != [] or value["allowed_effects"] != []:
        raise ContractError("Recursive improvers cannot receive tool or side-effect authority")
    return value


def _verify_capability_surface(package, envelope):
    """Reject package code that names an RPC outside the frozen envelope."""
    allowed = set(envelope["builtin_methods"])
    observed = set()
    for path, source in package["files"].items():
        if not path.endswith(".py"):
            continue
        try:
            tree = ast.parse(source, filename=path)
        except (SyntaxError, RecursionError) as exc:
            raise ContractError(f"Improver source is invalid: {str(exc)[:500]}") from None
        observed.update(node.attr for node in ast.walk(tree)
                        if isinstance(node, ast.Attribute) and node.attr in CAPABILITIES)
    excess = sorted(observed - allowed)
    if excess:
        raise ContractError(
            "Improver package exceeds the frozen builtin capability envelope: "
            + ", ".join(excess))
    return sorted(observed)


class ImproverService:
    """Version, execute and deploy recursive improver AgentPackages."""

    def __init__(self, task_service):
        self.tasks = task_service
        self.store = task_service.store
        with self.store.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS task_improver_archive(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_improver_feedback(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_improver_generations(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_improver_generation_claims(
                    invocation_digest TEXT PRIMARY KEY,
                    cycle_id TEXT NOT NULL, action_id TEXT NOT NULL UNIQUE,
                    data TEXT NOT NULL, token_digest TEXT NOT NULL,
                    status TEXT NOT NULL, generation_id TEXT UNIQUE,
                    terminal_record_digest TEXT, updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS task_improver_candidates(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_improver_decisions(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_improver_channels(
                    name TEXT PRIMARY KEY, package_id TEXT NOT NULL,
                    revision INTEGER NOT NULL, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_improver_events(
                    channel TEXT NOT NULL, sequence INTEGER NOT NULL, kind TEXT NOT NULL,
                    created REAL NOT NULL, data TEXT NOT NULL, previous TEXT NOT NULL,
                    digest TEXT NOT NULL, PRIMARY KEY(channel,sequence));
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
                raise ContractError("Cannot overwrite an immutable improver record")
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
        value = json.loads(row[0])
        if digest(value) != row[1]:
            raise ContractError("Improver record digest mismatch")
        value["record_digest"] = row[1]
        return value

    def _external(self, table, identity):
        """Read a digest-protected record owned by another trusted service."""
        if not re.fullmatch(r"[a-z_][a-z0-9_]*", table):
            raise ContractError("External evidence table is invalid")
        with self.store.connect() as db:
            exists = db.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
            if not exists:
                raise ContractError(f"Required host evidence table is unavailable: {table}")
            row = db.execute(f"SELECT data,digest FROM {table} WHERE id=?", (identity,)).fetchone()
        if not row:
            raise ContractError(f"Required host evidence is unavailable: {identity}")
        value = json.loads(row[0])
        if digest(value) != row[1]:
            raise ContractError("External host evidence digest mismatch")
        value["record_digest"] = row[1]
        return value

    def _append_event(self, db, channel, kind, content):
        content = _copy(content, "Improver event")
        row = db.execute(
            "SELECT sequence,digest FROM task_improver_events WHERE channel=? "
            "ORDER BY sequence DESC LIMIT 1", (channel,)).fetchone()
        sequence, previous = (row[0] + 1, row[1]) if row else (1, "genesis")
        record = {"channel": channel, "sequence": sequence, "kind": kind,
                  "created": time.time(), "content": content, "previous": previous}
        record["digest"] = digest(record)
        db.execute("INSERT INTO task_improver_events VALUES(?,?,?,?,?,?,?)",
                   (channel, sequence, kind, record["created"], self._encode(content),
                    previous, record["digest"]))
        return record

    def _event(self, channel, kind, content):
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            return self._append_event(db, channel, kind, content)

    def events(self, channel):
        channel = _identifier(channel, "Improver channel")
        with self.store.connect() as db:
            rows = db.execute(
                "SELECT sequence,kind,created,data,previous,digest FROM task_improver_events "
                "WHERE channel=? ORDER BY sequence", (channel,)).fetchall()
        result, previous = [], "genesis"
        for sequence, kind, created, data, stored_previous, record_digest in rows:
            record = {"channel": channel, "sequence": sequence, "kind": kind,
                      "created": created, "content": json.loads(data),
                      "previous": stored_previous}
            if stored_previous != previous or digest(record) != record_digest:
                raise ContractError("Improver event chain is invalid")
            record["digest"] = record_digest
            result.append(record)
            previous = record_digest
        return result

    def register(self, channel, package, mutation_policy, *, capability_envelope=None):
        """Register immutable R0 and freeze its recursive mutation envelope."""
        channel = _identifier(channel, "Improver channel")
        verify_package(package)
        if package["generation"] != 0:
            raise ContractError("A new improver channel must start from R0")
        policy = normalize_improver_policy(package, mutation_policy)
        envelope = _capability_envelope(capability_envelope)
        observed_capabilities = _verify_capability_surface(package, envelope)
        self.store.put_package(package)
        version = {
            "id": package["id"], "schema": "nexgent.improver-version.v1",
            "channel": channel, "package_id": package["id"],
            "package_digest": package["digest"], "parent_package_id": None,
            "generation": 0, "origin": "registered",
            "improve_entry": package["manifest"]["entries"]["improve"],
            "component_digests": deepcopy(package["component_digests"]),
            "mutation_policy": policy, "mutation_policy_digest": digest(policy),
            "capability_envelope": envelope,
            "capability_envelope_digest": digest(envelope), "created_at": time.time(),
            "observed_builtin_capabilities": observed_capabilities,
        }
        archived = self._insert("task_improver_archive", version)
        state = {
            "channel": channel, "package_id": package["id"],
            "package_digest": package["digest"], "revision": 0,
            "mutation_policy_digest": version["mutation_policy_digest"],
            "capability_envelope_digest": version["capability_envelope_digest"],
            "promotion": None, "deployment_stack": [], "updated_at": time.time(),
        }
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM task_improver_channels WHERE name=?", (channel,)).fetchone():
                raise ContractError(f"Improver channel already exists: {channel}")
            db.execute("INSERT INTO task_improver_channels VALUES(?,?,?,?)",
                       (channel, package["id"], 0, self._encode(state)))
            self._append_event(db, channel, "improver_channel_registered", {
                "package_id": package["id"], "package_digest": package["digest"],
                "version_record_digest": archived["record_digest"],
                "mutation_policy_digest": version["mutation_policy_digest"],
                "capability_envelope_digest": version["capability_envelope_digest"],
            })
        return self.active(channel)

    def version(self, package_id):
        return self._get("task_improver_archive", package_id)

    def active(self, channel):
        channel = _identifier(channel, "Improver channel")
        with self.store.connect() as db:
            row = db.execute(
                "SELECT package_id,revision,data FROM task_improver_channels WHERE name=?",
                (channel,)).fetchone()
        if not row:
            raise KeyError(channel)
        state = json.loads(row[2])
        if state.get("package_id") != row[0] or state.get("revision") != row[1]:
            raise ContractError("Improver channel projection mismatch")
        package, version = self.store.package(row[0]), self.version(row[0])
        if (package["digest"] != state.get("package_digest")
                or version["package_digest"] != package["digest"]
                or version["mutation_policy_digest"] != state["mutation_policy_digest"]
                or version["capability_envelope_digest"] != state["capability_envelope_digest"]):
            raise ContractError("Improver channel identity or frozen envelope mismatch")
        state.update(package=package, version=version)
        return state

    @staticmethod
    def _public_generation(record):
        usage = record.get("usage") if isinstance(record.get("usage"), dict) else {}
        return {
            "id": record["id"], "record_digest": record["record_digest"],
            "status": record.get("status"), "reason": str(record.get("reason") or "")[:1500],
            "feedback_bundle_id": record.get("feedback_bundle_id"),
            "candidate_id": record.get("candidate_id"),
            "candidate_package_id": record.get("candidate_package_id"),
            "improver_package_id": record.get("improver_package_id"),
            "improver_package_digest": record.get("improver_package_digest"),
            "usage": {key: usage.get(key) for key in
                      ("model_calls", "charged_completion_tokens", "completion_tokens",
                       "tool_calls", "reserved_tool_work_units", "tool_work_units",
                       "charged_tool_work_units", "nodes", "usage_complete")},
        }

    @staticmethod
    def _public_decision(record):
        measurements = record.get("measurements") if isinstance(record.get("measurements"), dict) else {}
        candidate = measurements.get("candidate") if isinstance(measurements.get("candidate"), dict) else {}
        parent = measurements.get("parent") if isinstance(measurements.get("parent"), dict) else {}
        return {
            "id": record["id"], "record_digest": record["record_digest"],
            "candidate_id": record.get("candidate_id"), "eligible": record.get("eligible"),
            "gates": _copy(record.get("gates") or {}, "Public decision gates"),
            "measurements": {
                "parent": {key: parent.get(key) for key in
                           ("quality", "success_rate", "cost", "usage_complete")},
                "candidate": {key: candidate.get(key) for key in
                              ("quality", "success_rate", "cost", "usage_complete")},
                "regressions": measurements.get("regressions"),
                "failure_reasons": _copy(measurements.get("failure_reasons") or [],
                                         "Decision failure reasons"),
            },
        }

    def capture_feedback(self, channel, generation_ids, decision_ids, expected_revision):
        """Build meta feedback only from actual P3 generation/evaluation records."""
        generation_ids = _ids(generation_ids, "Task-agent generations")
        decision_ids = _ids(decision_ids, "Task-agent decisions", allow_empty=True)
        active = self.active(channel)
        if type(expected_revision) is not int or expected_revision != active["revision"]:
            raise ContractError("Improver feedback expected revision is stale")
        generations, generated_candidates = [], set()
        for identity in generation_ids:
            record = self._external("task_candidate_generations", identity)
            if record.get("status") not in {"generated", "missing"}:
                raise ContractError("Meta feedback requires terminal candidate-generation evidence")
            if (record.get("improver_package_id") != active["package_id"]
                    or record.get("improver_package_digest") != active["package_digest"]):
                raise ContractError("Task-agent generation was not produced by active R")
            episode_id = record.get("episode_id")
            if not isinstance(episode_id, str):
                raise ContractError("Task-agent generation lacks a real improver Episode")
            try:
                episode = self.tasks.get_private(episode_id)
            except KeyError:
                raise ContractError("Task-agent generation Episode is not local") from None
            if episode["status"] not in _GENERATION_EVIDENCE_STATUSES:
                raise ContractError("Task-agent generation Episode has no durable outcome")
            execution = episode.get("execution") or {}
            if (record.get("status") == "generated"
                    and (episode.get("usage", {}).get("usage_complete") is not True
                         or execution.get("entry") != "improve"
                         or execution.get("package_digest") != active["package_digest"])):
                raise ContractError("Generated task-agent candidate lacks complete active-R execution evidence")
            if record.get("status") == "generated":
                generated_candidates.add(record.get("candidate_id"))
            generations.append(self._public_generation(record))
        decisions, decided_candidates = [], set()
        for identity in decision_ids:
            record = self._external("task_evolution_decisions", identity)
            if type(record.get("eligible")) is not bool:
                raise ContractError("Task-agent decision has no boolean eligibility result")
            candidate_id = record.get("candidate_id")
            if candidate_id not in generated_candidates:
                raise ContractError("Task-agent decision does not evaluate a referenced generation")
            decided_candidates.add(candidate_id)
            decisions.append(self._public_decision(record))
        if generated_candidates != decided_candidates:
            raise ContractError("Every generated task-agent candidate needs an independent decision")
        body = {
            "schema": META_FEEDBACK_SCHEMA, "channel": channel,
            "channel_revision": active["revision"],
            "parent_improver_id": active["package_id"],
            "parent_improver_digest": active["package_digest"],
            "task_generations": generations, "task_decisions": decisions,
        }
        record = {"id": _id("meta-feedback"), **body, "digest": digest(body),
                  "created_at": time.time()}
        result = self._insert("task_improver_feedback", record)
        self._event(channel, "improver_feedback_captured", {
            "feedback_id": record["id"], "feedback_digest": record["digest"],
            "generation_ids": generation_ids, "decision_ids": decision_ids,
            "record_digest": result["record_digest"],
        })
        return result

    def feedback(self, feedback_id):
        return self._get("task_improver_feedback", feedback_id)

    def _generation_missing(self, base, reason, episode=None, patch_digest=None):
        record = {
            **base, "status": "missing", "reason": str(reason)[:1500],
            "episode_id": episode.get("id") if episode else None,
            "episode_status": episode.get("status") if episode else None,
            "usage": deepcopy(episode.get("usage")) if episode else None,
            "execution": deepcopy(episode.get("execution")) if episode else None,
            "patch_digest": patch_digest, "candidate_id": None,
            "candidate_package_id": None, "completed_at": time.time(),
        }
        return self._store_generation_terminal(
            record, "improver_generation_missing", {
            "generation_id": base["id"], "feedback_id": base["feedback_id"],
            "episode_id": record["episode_id"], "reason": record["reason"],
        })

    @staticmethod
    def _budget(version, requested):
        policy = version["mutation_policy"]
        ceiling = {
            "max_model_calls": policy["max_outer_model_calls"],
            "max_completion_tokens": policy["max_outer_completion_tokens"],
            "max_tool_calls": policy["max_outer_tool_calls"],
            "max_nodes": policy["max_outer_nodes"],
        }
        if requested is None:
            return ceiling
        requested = _copy(requested, "Improver generation budget")
        if not isinstance(requested, dict) or set(requested) - set(ceiling):
            raise ContractError("Improver generation budget contains unsupported fields")
        result = dict(ceiling)
        for key, value in requested.items():
            if type(value) is not int or value < 0 or value > ceiling[key]:
                raise ContractError("Improver generation budget exceeds the frozen outer budget")
            result[key] = value
        return result

    @staticmethod
    def _invocation(value):
        if value is None:
            return None
        value = _copy(value, "Improver generation invocation")
        expected = {"schema", "cycle_id", "action_id", "nonce",
                    "started_at", "intent_digest"}
        if (not isinstance(value, dict) or set(value) != expected
                or value.get("schema") != "nexgent.recursive-cycle-invocation.v1"
                or any(not isinstance(value.get(key), str) or not value[key]
                       for key in ("cycle_id", "action_id", "nonce", "intent_digest"))
                or type(value.get("started_at")) not in {int, float}
                or value["started_at"] <= 0):
            raise ContractError("Improver generation invocation is invalid")
        return value

    @staticmethod
    def _claim_token(value):
        if not isinstance(value, str) or not value:
            raise ContractError("Improver generation claim token is invalid")
        return value

    def reserve_generation_invocation(self, db, invocation, claim_token):
        """Reserve one cycle invocation inside the caller's open transaction."""
        invocation = self._invocation(invocation)
        claim_token = self._claim_token(claim_token)
        invocation_digest = digest(invocation)
        try:
            db.execute(
                "INSERT INTO task_improver_generation_claims VALUES(?,?,?,?,?,?,?,?,?)", (
                    invocation_digest, invocation["cycle_id"], invocation["action_id"],
                    self._encode(invocation), digest(claim_token), "reserved",
                    None, None, time.time()))
        except Exception as exc:
            raise ContractError(
                "Recursive generation invocation is already reserved") from exc
        return invocation_digest

    def _consume_generation_invocation(
            self, invocation, claim_token, generation_id):
        if invocation is None:
            if claim_token is not None:
                raise ContractError("A generation claim token requires an invocation")
            return None
        claim_token = self._claim_token(claim_token)
        invocation_digest = digest(invocation)
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT data,token_digest,status,generation_id,terminal_record_digest "
                "FROM task_improver_generation_claims WHERE invocation_digest=?",
                (invocation_digest,)).fetchone()
            if (row is None or json.loads(row[0]) != invocation
                    or row[1] != digest(claim_token)):
                raise ContractError(
                    "Recursive generation invocation has no matching reserved claim")
            if row[2] == "completed" and row[3] and row[4]:
                return row[3]
            if row[2] != "reserved" or row[3] is not None or row[4] is not None:
                raise ContractError("Recursive generation invocation is already running")
            updated = db.execute(
                "UPDATE task_improver_generation_claims SET status='running',"
                "generation_id=?,updated=? WHERE invocation_digest=? "
                "AND status='reserved' AND generation_id IS NULL",
                (generation_id, time.time(), invocation_digest)).rowcount
            if updated != 1:
                raise ContractError("Recursive generation invocation claim was lost")
        return None

    def generation_for_invocation(self, invocation):
        invocation = self._invocation(invocation)
        invocation_digest = digest(invocation)
        with self.store.connect() as db:
            row = db.execute(
                "SELECT data,status,generation_id,terminal_record_digest "
                "FROM task_improver_generation_claims WHERE invocation_digest=?",
                (invocation_digest,)).fetchone()
        if row is None:
            return None
        if json.loads(row[0]) != invocation:
            raise ContractError("Recursive generation invocation claim changed")
        if row[1] != "completed":
            return None
        if not row[2] or not row[3]:
            raise ContractError("Completed generation invocation claim is incomplete")
        generation = self.generation(row[2])
        if (generation["record_digest"] != row[3]
                or generation.get("invocation") != invocation
                or generation.get("invocation_digest") != invocation_digest):
            raise ContractError("Generation invocation claim terminal evidence changed")
        return generation

    def discard_generation_invocation(self, invocation, claim_token):
        invocation = self._invocation(invocation)
        claim_token = self._claim_token(claim_token)
        invocation_digest = digest(invocation)
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            deleted = db.execute(
                "DELETE FROM task_improver_generation_claims "
                "WHERE invocation_digest=? AND token_digest=? "
                "AND status IN ('reserved','running') AND terminal_record_digest IS NULL",
                (invocation_digest, digest(claim_token))).rowcount
            if deleted != 1:
                raise ContractError(
                    "Recursive generation invocation cannot be discarded")

    def _store_generation_terminal(self, record, event_kind, event_content):
        encoded, record_digest = self._encode(record), digest(record)
        invocation = record.get("invocation")
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = db.execute(
                "SELECT data,digest FROM task_improver_generations WHERE id=?",
                (record["id"],)).fetchone()
            if previous and previous != (encoded, record_digest):
                raise ContractError("Cannot overwrite an immutable improver record")
            db.execute(
                "INSERT OR IGNORE INTO task_improver_generations VALUES(?,?,?)",
                (record["id"], encoded, record_digest))
            if invocation is not None:
                updated = db.execute(
                    "UPDATE task_improver_generation_claims "
                    "SET status='completed',terminal_record_digest=?,updated=? "
                    "WHERE invocation_digest=? AND status='running' AND generation_id=?",
                    (record_digest, time.time(), digest(invocation), record["id"])).rowcount
                if updated != 1:
                    raise ContractError(
                        "Recursive generation terminal record lost its invocation claim")
            self._append_event(
                db, record["channel"], event_kind,
                {**event_content, "record_digest": record_digest})
        return {**deepcopy(record), "record_digest": record_digest}

    def generate(self, channel, feedback_id, expected_revision, *, budget=None,
                 stop_event=None, invocation=None, invocation_claim_token=None,
                 admission_check=None):
        """Actually run active R on its own source and admit a valid R child."""
        if admission_check is not None and not callable(admission_check):
            raise TypeError("admission_check must be callable")
        active, feedback = self.active(channel), self.feedback(feedback_id)
        if (feedback["channel"] != channel
                or type(expected_revision) is not int
                or expected_revision != active["revision"]
                or feedback["channel_revision"] != active["revision"]
                or feedback["parent_improver_id"] != active["package_id"]
                or feedback["parent_improver_digest"] != active["package_digest"]):
            raise ContractError("Improver generation feedback or expected revision is stale")
        parent, version = active["package"], active["version"]
        policy = version["mutation_policy"]
        envelope = version["capability_envelope"]
        execution_budget = self._budget(version, budget)
        invocation = self._invocation(invocation)
        generation_id = _id("improver-generation")
        completed_generation_id = self._consume_generation_invocation(
            invocation, invocation_claim_token, generation_id)
        if completed_generation_id is not None:
            return self.generation(completed_generation_id)
        base = {
            "schema": IMPROVER_GENERATION_SCHEMA, "id": generation_id,
            "channel": channel, "channel_revision": active["revision"],
            "parent_improver_id": parent["id"],
            "parent_improver_digest": parent["digest"],
            "feedback_id": feedback["id"], "feedback_digest": feedback["digest"],
            "improve_entry": parent["manifest"]["entries"]["improve"],
            "mutation_policy_digest": version["mutation_policy_digest"],
            "capability_envelope_digest": version["capability_envelope_digest"],
            "outer_budget": execution_budget,
            "outer_budget_digest": digest(execution_budget), "created_at": time.time(),
            "invocation": invocation,
            "invocation_digest": digest(invocation) if invocation is not None else None,
        }
        components = [{
            "path": path, "digest": parent["component_digests"].get(path),
            "content": parent["files"].get(path), "exists": path in parent["files"],
        } for path in policy["mutable_paths"]]
        visible_feedback = {key: deepcopy(value) for key, value in feedback.items()
                            if key != "record_digest"}
        inputs = {"meta_feedback": visible_feedback, "self_components": components,
                  "mutation_policy": deepcopy(policy)}
        def admit(boundary):
            if admission_check is not None:
                admission_check({
                    "kind": "generate_recursive_improver_candidate",
                    "boundary": boundary,
                    "channel": channel,
                    "expected_revision": expected_revision,
                })

        episode = None
        admit("recursive_generation_create")
        try:
            episode = self.tasks.create(
                "Generate one evidence-bound patch for the active improver itself",
                inputs=inputs,
                deliverables=[{"name": "improver_patch", "schema": improver_patch_schema()}],
                budget=execution_budget, capabilities=list(envelope["tools"]), package=parent,
                context={"split": "development", "split_role": "development",
                         "rsi_role": "recursive_improver_generation", "channel": channel,
                         "channel_revision": active["revision"], "feedback_id": feedback["id"],
                         "recursive_cycle_invocation_digest": base["invocation_digest"]},
                constraints={"allowed_effects": list(envelope["allowed_effects"]),
                             "wall_seconds": 1200}, entry="improve")
        except Exception as exc:
            if episode is not None:
                episode = self.tasks.get_private(episode["id"])
            return self._generation_missing(base, f"{type(exc).__name__}: {exc}", episode)
        admit("recursive_generation_run")
        try:
            episode = self.tasks.run(episode["id"], stop_event=stop_event)
        except Exception as exc:
            if episode is not None:
                episode = self.tasks.get_private(episode["id"])
            return self._generation_missing(base, f"{type(exc).__name__}: {exc}", episode)
        if episode["status"] != "completed":
            return self._generation_missing(
                base, episode.get("last_error") or f"Improver Episode ended {episode['status']}", episode)
        if episode.get("usage", {}).get("usage_complete") is not True:
            return self._generation_missing(base, "Improver Episode usage is incomplete", episode)
        try:
            if set(episode.get("output_refs") or {}) != {"improver_patch"}:
                raise ContractError("Improver did not publish exactly one ImproverPatch")
            artifact = self.store.read(episode["output_refs"]["improver_patch"], episode["id"])
            execution = episode.get("execution") or {}
            entry_path = parent["manifest"]["entries"]["improve"].split(":", 1)[0]
            if (artifact.get("producer", {}).get("package_digest") != parent["digest"]
                    or execution.get("entry") != "improve"
                    or execution.get("package_digest") != parent["digest"]
                    or entry_path not in (execution.get("loaded_modules") or [])):
                raise ContractError("Recursive generation lacks an actual active-R execution receipt")
            provenance = {
                "origin": "recursive-generated", "generation_id": generation_id,
                "meta_feedback_id": feedback["id"], "meta_feedback_digest": feedback["digest"],
                "parent_improver_id": parent["id"],
                "improver_patch_digest": digest(artifact["content"]),
            }
            child, patch, normalized = apply_improver_patch(
                parent, artifact["content"], policy, provenance=provenance)
            if normalized != policy:
                raise ContractError("Improver mutation policy changed during generation")
            observed_capabilities = _verify_capability_surface(child, envelope)
            patch_digest = digest(patch)
            current = self.active(channel)
            if (current["revision"] != active["revision"]
                    or current["package_digest"] != active["package_digest"]):
                return self._generation_missing(
                    base, "Active R changed during recursive generation", episode, patch_digest)
            self.store.put_package(child)
            candidate_id = _id("improver-candidate")
            delta = {
                "added": sorted(set(child["files"]) - set(parent["files"])),
                "removed": sorted(set(parent["files"]) - set(child["files"])),
                "changed": sorted(path for path in set(parent["files"]) & set(child["files"])
                                  if parent["component_digests"][path]
                                  != child["component_digests"][path]),
            }
            candidate_record = {
                "schema": IMPROVER_CANDIDATE_SCHEMA, "id": candidate_id,
                "channel": channel, "channel_revision": active["revision"],
                "parent_improver_id": parent["id"],
                "parent_improver_digest": parent["digest"],
                "package_id": child["id"], "package_digest": child["digest"],
                "generation": child["generation"], "generation_id": generation_id,
                "feedback_id": feedback["id"], "feedback_digest": feedback["digest"],
                "hypothesis": deepcopy(patch["hypothesis"]),
                "activation_probe": deepcopy(patch["activation_probe"]),
                "component_delta": delta, "patch_digest": patch_digest,
                "mutation_policy_digest": version["mutation_policy_digest"],
                "capability_envelope_digest": version["capability_envelope_digest"],
                "created_at": time.time(),
            }
            candidate = self._insert("task_improver_candidates", candidate_record)
            version_record = {
                "id": child["id"], "schema": "nexgent.improver-version.v1",
                "channel": channel, "package_id": child["id"],
                "package_digest": child["digest"], "parent_package_id": parent["id"],
                "generation": child["generation"], "origin": "recursive-generated",
                "generation_id": generation_id, "candidate_id": candidate_id,
                "improve_entry": child["manifest"]["entries"]["improve"],
                "component_digests": deepcopy(child["component_digests"]),
                "mutation_policy": deepcopy(policy),
                "mutation_policy_digest": version["mutation_policy_digest"],
                "capability_envelope": deepcopy(envelope),
                "capability_envelope_digest": version["capability_envelope_digest"],
                "observed_builtin_capabilities": observed_capabilities,
                "created_at": time.time(),
            }
            archived = self._insert("task_improver_archive", version_record)
        except Exception as exc:
            return self._generation_missing(
                base, f"{type(exc).__name__}: {exc}", episode,
                digest(artifact["content"]) if "artifact" in locals() else None)
        record = {
            **base, "status": "generated", "reason": None,
            "episode_id": episode["id"], "episode_status": episode["status"],
            "usage": deepcopy(episode["usage"]), "execution": deepcopy(episode["execution"]),
            "patch_schema": IMPROVER_PATCH_SCHEMA, "patch_digest": patch_digest,
            "candidate_id": candidate_id, "candidate_record_digest": candidate["record_digest"],
            "candidate_package_id": child["id"],
            "candidate_package_digest": child["digest"],
            "version_record_digest": archived["record_digest"], "completed_at": time.time(),
        }
        return self._store_generation_terminal(
            record, "improver_candidate_generated", {
            "generation_id": generation_id, "feedback_id": feedback["id"],
            "episode_id": episode["id"], "parent_improver_id": parent["id"],
            "candidate_id": candidate_id, "candidate_package_id": child["id"],
            "patch_digest": patch_digest,
        })

    def generation(self, generation_id):
        return self._get("task_improver_generations", generation_id)

    def generate_candidate(self, channel, feedback_id, expected_revision, *,
                           budget=None, stop_event=None, invocation=None,
                           invocation_claim_token=None, admission_check=None):
        """Named P4 API alias for :meth:`generate`."""
        return self.generate(channel, feedback_id, expected_revision,
                             budget=budget, stop_event=stop_event,
                             invocation=invocation,
                             invocation_claim_token=invocation_claim_token,
                             admission_check=admission_check)

    def candidate(self, candidate_id):
        return self._get("task_improver_candidates", candidate_id)

    @staticmethod
    def _binding(record, *names):
        binding = record.get("binding") if isinstance(record.get("binding"), dict) else {}
        for name in names:
            if name in record:
                return record[name]
            if name in binding:
                return binding[name]
        return None

    def record_decision(self, candidate_id, meta_evaluation_id):
        """Bind an external, immutable meta evaluation to an R candidate."""
        candidate = self.candidate(candidate_id)
        self._verify_generation(candidate)
        evaluation = self._external("task_improver_meta_evaluations", meta_evaluation_id)
        if evaluation.get("schema") != "nexgent.improver-meta-evaluation.v1":
            raise ContractError("Meta evaluation schema is not supported")
        expected = {
            "candidate_id": candidate_id,
            "channel": candidate["channel"],
            "parent_id": candidate["parent_improver_id"],
            "parent_digest": candidate["parent_improver_digest"],
            "child_id": candidate["package_id"],
            "child_digest": candidate["package_digest"],
            "revision": candidate["channel_revision"],
        }
        observed = {
            "candidate_id": self._binding(evaluation, "candidate_id", "improver_candidate_id"),
            "channel": self._binding(evaluation, "channel"),
            "parent_id": self._binding(evaluation, "parent_improver_id", "parent_package_id"),
            "parent_digest": self._binding(
                evaluation, "parent_improver_digest", "parent_package_digest"),
            "child_id": self._binding(
                evaluation, "candidate_improver_id", "candidate_package_id", "package_id"),
            "child_digest": self._binding(
                evaluation, "candidate_improver_digest", "candidate_package_digest", "package_digest"),
            "revision": self._binding(evaluation, "channel_revision"),
        }
        if observed != expected:
            raise ContractError("Meta evaluation does not bind the exact improver candidate")
        eligible = evaluation.get("eligible")
        if type(eligible) is not bool:
            raise ContractError("Meta evaluation must provide host-computed boolean eligibility")
        gates = evaluation.get("gates")
        if (evaluation.get("measurement_complete") is not True
                or not isinstance(gates, dict)
                or set(gates) != {"measurement_complete", "utility_delta",
                                  "success_rate", "cost", "regressions"}
                or any(type(value) is not bool for value in gates.values())
                or eligible != all(gates.values())):
            raise ContractError("Meta evaluation eligibility is not backed by complete host gates")
        with self.store.connect() as db:
            rows = db.execute("SELECT data,digest FROM task_improver_decisions").fetchall()
        for data, record_digest in rows:
            prior = json.loads(data)
            if (prior.get("candidate_id") == candidate_id
                    and prior.get("meta_evaluation_id") == meta_evaluation_id):
                if digest(prior) != record_digest:
                    raise ContractError("Improver decision digest mismatch")
                prior["record_digest"] = record_digest
                return prior
        record = {
            "schema": IMPROVER_DECISION_SCHEMA, "id": _id("improver-decision"),
            "candidate_id": candidate_id, "channel": candidate["channel"],
            "channel_revision": candidate["channel_revision"],
            "parent_improver_id": candidate["parent_improver_id"],
            "parent_improver_digest": candidate["parent_improver_digest"],
            "candidate_improver_id": candidate["package_id"],
            "candidate_improver_digest": candidate["package_digest"],
            "meta_evaluation_id": meta_evaluation_id,
            "meta_evaluation_digest": evaluation["record_digest"],
            "eligible": eligible, "created_at": time.time(),
        }
        result = self._insert("task_improver_decisions", record)
        self._event(candidate["channel"], "improver_promotion_assessed", {
            "candidate_id": candidate_id, "decision_id": record["id"],
            "meta_evaluation_id": meta_evaluation_id, "eligible": eligible,
            "record_digest": result["record_digest"],
        })
        return result

    def decision(self, decision_id):
        return self._get("task_improver_decisions", decision_id)

    def _verify_generation(self, candidate):
        generation = self.generation(candidate["generation_id"])
        if (generation.get("status") != "generated"
                or generation.get("channel") != candidate["channel"]
                or generation.get("channel_revision") != candidate["channel_revision"]
                or generation.get("candidate_id") != candidate["id"]
                or generation.get("candidate_record_digest") != candidate["record_digest"]
                or generation.get("candidate_package_id") != candidate["package_id"]
                or generation.get("candidate_package_digest") != candidate["package_digest"]
                or generation.get("parent_improver_id") != candidate["parent_improver_id"]
                or generation.get("parent_improver_digest") != candidate["parent_improver_digest"]
                or generation.get("feedback_id") != candidate["feedback_id"]
                or generation.get("feedback_digest") != candidate["feedback_digest"]
                or generation.get("patch_schema") != IMPROVER_PATCH_SCHEMA
                or generation.get("patch_digest") != candidate["patch_digest"]
                or generation.get("usage", {}).get("usage_complete") is not True
                or generation.get("execution", {}).get("entry") != "improve"
                or generation.get("execution", {}).get("package_digest")
                   != candidate["parent_improver_digest"]):
            raise ContractError("Improver candidate generation closure is incomplete")
        child = self.store.package(candidate["package_id"])
        parent = self.store.package(candidate["parent_improver_id"])
        verify_package(child, parent)
        version = self.version(child["id"])
        episode = self.tasks.get_private(generation["episode_id"])
        if (child.get("provenance", {}).get("generation_id") != generation["id"]
                or version.get("generation_id") != generation["id"]
                or version.get("candidate_id") != candidate["id"]
                or version.get("package_digest") != child["digest"]
                or version.get("parent_package_id") != parent["id"]
                or generation.get("version_record_digest") != version["record_digest"]
                or episode.get("package_digest") != parent["digest"]
                or generation.get("execution") != episode.get("execution")
                or generation.get("usage") != episode.get("usage")):
            raise ContractError("Improver candidate archive or Episode closure is incomplete")
        return generation

    def _verify_guard_plan(self, candidate, guard_plan_id):
        plan = self._external("task_improver_guard_plans", guard_plan_id)
        expected = {
            "schema": "nexgent.improver-guard-plan.v1",
            "status": "ready", "candidate_id": candidate["id"],
            "channel": candidate["channel"],
            "pre_promotion_revision": candidate["channel_revision"],
            "expected_deployed_revision": candidate["channel_revision"] + 1,
            "parent_improver_id": candidate["parent_improver_id"],
            "parent_improver_digest": candidate["parent_improver_digest"],
            "candidate_improver_id": candidate["package_id"],
            "candidate_improver_digest": candidate["package_digest"],
        }
        if any(plan.get(key) != value for key, value in expected.items()):
            raise ContractError("Guard plan does not bind the exact improver candidate")
        with self.store.connect() as db:
            claim = db.execute(
                "SELECT status FROM task_improver_guard_claims WHERE plan_id=?",
                (guard_plan_id,)).fetchone()
        if claim is not None:
            raise ContractError("Guard plan was already consumed before promotion")
        return plan

    def _verify_active_guard_completion(self, active):
        """Do not stack another deployment above an unresolved guard."""
        promotion = active.get("promotion")
        if promotion is None:
            return
        guard_plan_id = promotion.get("guard_plan_id")
        if not isinstance(guard_plan_id, str) or not guard_plan_id:
            raise ContractError("Active improver deployment has no bound guard")
        plan = self._external("task_improver_guard_plans", guard_plan_id)
        if (plan.get("schema") != "nexgent.improver-guard-plan.v1"
                or plan.get("status") != "ready"
                or plan.get("record_digest") != promotion.get("guard_plan_digest")
                or plan.get("candidate_id") != promotion.get("candidate_id")
                or plan.get("channel") != active["channel"]
                or plan.get("candidate_improver_id") != active["package_id"]
                or plan.get("candidate_improver_digest") != active["package_digest"]):
            raise ContractError("Active improver guard plan closure is invalid")
        with self.store.connect() as db:
            claim = db.execute(
                "SELECT status,action_id FROM task_improver_guard_claims WHERE plan_id=?",
                (guard_plan_id,)).fetchone()
        if not claim or claim[0] != "completed" or not claim[1]:
            raise ContractError("Active improver guard must complete before another promotion")
        action = self._external("task_improver_guard_actions", claim[1])
        run_id = action.get("run_id")
        if not isinstance(run_id, str) or not run_id:
            raise ContractError("Active improver guard action lacks a run")
        run = self._external("task_improver_guard_runs", run_id)
        guarded_revision = action.get("active_revision_after")
        if (action.get("plan_id") != guard_plan_id
                or run.get("plan_id") != guard_plan_id
                or run.get("plan_digest") != plan["record_digest"]
                or action.get("run_digest") != run["record_digest"]
                or run.get("passed") is not True
                or run.get("degraded") is not False
                or action.get("degraded") is not False
                or action.get("rolled_back") is not False
                or type(guarded_revision) is not int
                or guarded_revision > active["revision"]
                or action.get("active_package_id_after") != active["package_id"]
                or action.get("active_package_digest_after") != active["package_digest"]):
            raise ContractError("Active improver guard did not authorize another promotion")

    def promote(self, candidate_id, decision_id, expected_revision, *, guard_plan_id=None):
        """CAS-deploy an independently evaluated R candidate with a frozen guard."""
        candidate, decision = self.candidate(candidate_id), self.decision(decision_id)
        if (decision["candidate_id"] != candidate_id or decision["eligible"] is not True
                or decision["channel_revision"] != candidate["channel_revision"]):
            raise ContractError("Improver candidate lacks an eligible bound meta decision")
        self._verify_generation(candidate)
        guard_plan = self._verify_guard_plan(candidate, guard_plan_id)
        active = self.active(candidate["channel"])
        self._verify_active_guard_completion(active)
        if (type(expected_revision) is not int or expected_revision != active["revision"]
                or active["revision"] != candidate["channel_revision"]
                or active["package_id"] != candidate["parent_improver_id"]
                or active["package_digest"] != candidate["parent_improver_digest"]):
            raise ContractError("Improver promotion compare-and-swap parent is stale")
        child = self.store.package(candidate["package_id"])
        verify_package(child, active["package"])
        child_version = self.version(child["id"])
        if (child_version["mutation_policy_digest"] != active["mutation_policy_digest"]
                or child_version["capability_envelope_digest"]
                   != active["capability_envelope_digest"]):
            raise ContractError("Improver candidate changed its frozen host envelope")
        stack = deepcopy(active.get("deployment_stack") or [])
        if len(stack) >= 256:
            raise ContractError("Improver deployment stack reached its host bound")
        stack.append({
            "package_id": active["package_id"], "package_digest": active["package_digest"],
            "promotion": deepcopy(active.get("promotion")),
        })
        promotion = {
            "candidate_id": candidate_id, "decision_id": decision_id,
            "meta_evaluation_id": decision["meta_evaluation_id"],
            "decision_record_digest": decision["record_digest"],
            "previous_package_id": active["package_id"],
            "guard_plan_id": guard_plan_id,
            "guard_plan_digest": guard_plan["record_digest"],
        }
        state = {
            "channel": candidate["channel"], "package_id": child["id"],
            "package_digest": child["digest"], "revision": active["revision"] + 1,
            "mutation_policy_digest": active["mutation_policy_digest"],
            "capability_envelope_digest": active["capability_envelope_digest"],
            "promotion": promotion, "deployment_stack": stack, "updated_at": time.time(),
        }
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            changed = db.execute(
                "UPDATE task_improver_channels SET package_id=?,revision=?,data=? "
                "WHERE name=? AND package_id=? AND revision=?",
                (child["id"], state["revision"], self._encode(state), candidate["channel"],
                 active["package_id"], active["revision"])).rowcount
            if changed != 1:
                raise ContractError("Improver channel changed during promotion")
            self._append_event(db, candidate["channel"], "improver_promoted", {
                "candidate_id": candidate_id, "decision_id": decision_id,
                "guard_plan_id": guard_plan_id,
                "from_package_id": active["package_id"], "to_package_id": child["id"],
                "revision": state["revision"],
            })
        return self.active(candidate["channel"])

    def rollback(self, channel, expected_revision, *, reason, evidence=None):
        """CAS-move the R channel one deployment edge back without deleting evidence."""
        active = self.active(channel)
        if type(expected_revision) is not int or expected_revision != active["revision"]:
            raise ContractError("Improver rollback compare-and-swap revision is stale")
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 5000:
            raise ContractError("Improver rollback requires a bounded reason")
        evidence = _copy({} if evidence is None else evidence, "Improver rollback evidence")
        if not isinstance(evidence, dict) or len(self._encode(evidence)) > 100000:
            raise ContractError("Improver rollback evidence must be a bounded object")
        stack = deepcopy(active.get("deployment_stack") or [])
        if not stack:
            raise ContractError("Improver channel has no deployment edge to roll back")
        target = stack.pop()
        package = self.store.package(target["package_id"])
        if package["digest"] != target["package_digest"]:
            raise ContractError("Improver rollback target digest mismatch")
        state = {
            "channel": active["channel"], "package_id": package["id"],
            "package_digest": package["digest"], "revision": active["revision"] + 1,
            "mutation_policy_digest": active["mutation_policy_digest"],
            "capability_envelope_digest": active["capability_envelope_digest"],
            "promotion": deepcopy(target.get("promotion")), "deployment_stack": stack,
            "updated_at": time.time(),
        }
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            changed = db.execute(
                "UPDATE task_improver_channels SET package_id=?,revision=?,data=? "
                "WHERE name=? AND package_id=? AND revision=?",
                (package["id"], state["revision"], self._encode(state), active["channel"],
                 active["package_id"], active["revision"])).rowcount
            if changed != 1:
                raise ContractError("Improver channel changed during rollback")
            self._append_event(db, active["channel"], "improver_rolled_back", {
                "from_package_id": active["package_id"], "to_package_id": package["id"],
                "reason": reason.strip(), "evidence": evidence,
                "revision": state["revision"],
            })
        return self.active(active["channel"])


def active_improver_registration(store, channel):
    """Resolve the active R pointer for later candidate-generation work."""
    channel = _identifier(channel, "Improver channel")
    with store.connect() as db:
        row = db.execute(
            "SELECT package_id,revision,data FROM task_improver_channels WHERE name=?",
            (channel,)).fetchone()
    if not row:
        raise KeyError(channel)
    state = json.loads(row[2])
    if state.get("package_id") != row[0] or state.get("revision") != row[1]:
        raise ContractError("Improver channel projection mismatch")
    package = store.package(row[0])
    if package["digest"] != state.get("package_digest"):
        raise ContractError("Active improver package digest mismatch")
    with store.connect() as connection:
        archive = connection.execute(
            "SELECT data,digest FROM task_improver_archive WHERE id=?", (row[0],)).fetchone()
    if archive is None:
        raise ContractError("Active improver version is missing from the archive")
    version = json.loads(archive[0])
    if (digest(version) != archive[1]
            or version.get("id") != row[0]
            or version.get("package_id") != row[0]
            or version.get("channel") != channel
            or version.get("package_digest") != package["digest"]
            or version.get("mutation_policy_digest") != state.get("mutation_policy_digest")
            or version.get("capability_envelope_digest")
               != state.get("capability_envelope_digest")):
        raise ContractError("Active improver archive or frozen envelope mismatch")
    return {
        "channel": channel, "revision": row[1], "package_id": row[0],
        "package_digest": package["digest"], "package": package,
        "mutation_policy_digest": state.get("mutation_policy_digest"),
        "capability_envelope_digest": state.get("capability_envelope_digest"),
    }


def active_improver_package(store, channel):
    return active_improver_registration(store, channel)["package"]


def public_improver_state(state):
    """Project a deployed-R state without package source or private evidence."""
    version = state.get("version") if isinstance(state.get("version"), dict) else {}
    promotion = state.get("promotion") if isinstance(state.get("promotion"), dict) else None
    return {
        "channel": state.get("channel"), "revision": state.get("revision"),
        "package_id": state.get("package_id"),
        "package_digest": state.get("package_digest"),
        "generation": version.get("generation"), "origin": version.get("origin"),
        "mutation_policy_digest": state.get("mutation_policy_digest"),
        "capability_envelope_digest": state.get("capability_envelope_digest"),
        "deployment_depth": len(state.get("deployment_stack") or []),
        "promotion": ({key: promotion.get(key) for key in
                       ("candidate_id", "decision_id", "meta_evaluation_id",
                        "guard_plan_id", "guard_plan_digest", "previous_package_id")}
                      if promotion else None),
        "updated_at": state.get("updated_at"),
    }


def public_improver_event(event):
    """Return fixed audit identities while excluding package and evaluator bodies."""
    content = event.get("content") if isinstance(event.get("content"), dict) else {}
    allowed = {
        "package_id", "package_digest", "candidate_id", "candidate_package_id",
        "generation_id", "feedback_id", "decision_id", "meta_evaluation_id",
        "guard_plan_id", "guard_run_id", "guard_action_id", "from_package_id",
        "to_package_id", "revision", "expected_deployed_revision",
        "active_revision_after", "eligible", "degraded", "rolled_back", "reason",
        "record_digest", "patch_digest", "protocol_digest",
    }
    return {
        "channel": event.get("channel"), "sequence": event.get("sequence"),
        "kind": event.get("kind"), "created": event.get("created"),
        "content": {key: deepcopy(content[key]) for key in sorted(allowed & set(content))},
        "previous": event.get("previous"), "digest": event.get("digest"),
    }
