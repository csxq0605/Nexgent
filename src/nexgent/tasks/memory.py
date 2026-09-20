"""Host-owned lifecycle for versioned AgentPackage memory resources.

Memory versions are immutable behavior resources.  Agents may produce evidence
or proposed content through ordinary Episodes, but only this trusted host
service assesses candidates and moves deployment channels.
"""

from __future__ import annotations

from copy import deepcopy
import json
import re
import time
import uuid

from ..kernel.programs import digest
from .packages import verify_package
from .tools import ContractError


SCHEMA = "nexgent.memory-version.v1"
STATUSES = frozenset({"candidate", "accepted", "rejected", "retired"})
MEMORY_KINDS = frozenset({"experience", "procedure", "factual_note", "preference"})


def _copy(value, label="Memory value"):
    try:
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":"), allow_nan=False)
        if len(encoded.encode("utf-8")) > 1_000_000:
            raise ContractError(f"{label} exceeds the 1 MB host limit")
        return json.loads(encoded)
    except (TypeError, ValueError, RecursionError) as exc:
        if isinstance(exc, ContractError):
            raise
        raise ContractError(f"{label} must be finite JSON: {str(exc)[:500]}") from None


def _identifier(value, label):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9_.-]{0,99}", value):
        raise ContractError(f"{label} must be a bounded lowercase identifier")
    return value


def _id(prefix):
    return prefix + "-" + uuid.uuid4().hex[:16]


def _normalize_resource(resource):
    resource = _copy(resource, "Memory resource")
    if not isinstance(resource, dict) or set(resource) != {"policy", "data"}:
        raise ContractError("Memory resource requires separate policy and data objects")
    policy, data = resource["policy"], resource["data"]
    if (not isinstance(policy, dict) or set(policy) != {"retrieval", "writeback"}
            or not isinstance(data, dict) or set(data) != {"items"}):
        raise ContractError("Memory policy and data have invalid fields")
    retrieval = policy["retrieval"]
    if (not isinstance(retrieval, dict)
            or set(retrieval) != {"kind", "version", "max_results"}
            or retrieval.get("kind") != "literal-any-term"
            or retrieval.get("version") != 1
            or type(retrieval.get("max_results")) is not int
            or not 0 <= retrieval["max_results"] <= 100):
        raise ContractError("Memory retrieval policy must be bounded literal-any-term v1")
    writeback = policy["writeback"]
    if (not isinstance(writeback, dict)
            or set(writeback) != {"enabled", "allowed_kinds"}
            or type(writeback.get("enabled")) is not bool
            or not isinstance(writeback.get("allowed_kinds"), list)
            or len(set(writeback["allowed_kinds"])) != len(writeback["allowed_kinds"])
            or any(kind not in MEMORY_KINDS for kind in writeback["allowed_kinds"])):
        raise ContractError("Memory writeback policy is invalid")
    if not writeback["enabled"] and writeback["allowed_kinds"]:
        raise ContractError("Disabled memory writeback cannot allow item kinds")
    raw_items = data["items"]
    if not isinstance(raw_items, list) or len(raw_items) > 1000:
        raise ContractError("Memory resource items must be a bounded list")
    items = []
    for index, raw in enumerate(raw_items):
        if not isinstance(raw, dict) or set(raw) - {
                "kind", "content", "applies_to", "counterexamples", "evidence_refs"}:
            raise ContractError("Memory items contain unsupported fields")
        kind = raw.get("kind")
        if kind not in MEMORY_KINDS or "content" not in raw:
            raise ContractError("Memory items require supported kind and content")
        applies_to = raw.get("applies_to", [])
        counterexamples = raw.get("counterexamples", [])
        evidence_refs = raw.get("evidence_refs", [])
        if (not isinstance(applies_to, list) or not isinstance(counterexamples, list)
                or not isinstance(evidence_refs, list)
                or any(not isinstance(ref, str) or not ref for ref in evidence_refs)):
            raise ContractError("Memory item scope and evidence fields must be lists")
        body = {"kind": kind, "content": raw["content"],
                "applies_to": applies_to, "counterexamples": counterexamples,
                "evidence_refs": evidence_refs}
        item_id = "memory-entry-" + digest({"index": index, "item": body})[:24]
        items.append({"id": item_id, "version": 1, **body})
    return {"policy": {"retrieval": retrieval, "writeback": writeback},
            "data": {"items": items}}


def _load_version(store, identity):
    with store.connect() as db:
        try:
            row = db.execute(
                "SELECT status,data,record_digest FROM task_memory_versions WHERE id=?",
                (identity,)).fetchone()
        except Exception as exc:
            raise ContractError("Memory registry is not initialized") from exc
    if row is None:
        raise KeyError(identity)
    record = json.loads(row[1])
    identity_payload = {"package_id": record.get("package_id"),
                        "package_digest": record.get("package_digest"),
                        "parent_id": record.get("parent_id"),
                        "generation": record.get("generation"),
                        "resource": record.get("resource")}
    version_digest = digest(identity_payload)
    if (record.get("id") != identity or digest(record) != row[2]
            or record.get("digest") != version_digest
            or identity != "memory-version-" + version_digest[:24]
            or row[0] not in STATUSES):
        raise ContractError("Memory version record integrity mismatch")
    try:
        package = store.package(record["package_id"])
    except (KeyError, ValueError) as exc:
        raise ContractError("Memory version AgentPackage binding is unavailable") from exc
    if package["digest"] != record["package_digest"]:
        raise ContractError("Memory version AgentPackage binding mismatch")
    record["status"] = row[0]
    record["record_digest"] = row[2]
    return record


class MemoryService:
    """Admit, assess, select and deploy immutable memory behavior versions."""

    def __init__(self, task_service):
        self.tasks = task_service
        self.store = task_service.store
        with self.store.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS task_memory_versions(
                    id TEXT PRIMARY KEY, parent_id TEXT, generation INTEGER NOT NULL,
                    status TEXT NOT NULL, package_id TEXT NOT NULL,
                    package_digest TEXT NOT NULL, data TEXT NOT NULL,
                    record_digest TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS task_memory_decisions(
                    id TEXT PRIMARY KEY, memory_id TEXT UNIQUE NOT NULL,
                    data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_memory_selection_plans(
                    id TEXT PRIMARY KEY, memory_id TEXT UNIQUE NOT NULL,
                    data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_memory_retirements(
                    id TEXT PRIMARY KEY, memory_id TEXT UNIQUE NOT NULL,
                    data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_memory_channels(
                    name TEXT PRIMARY KEY, memory_id TEXT NOT NULL,
                    revision INTEGER NOT NULL, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_memory_events(
                    channel TEXT, sequence INTEGER, kind TEXT, created REAL,
                    data TEXT, previous TEXT, digest TEXT,
                    PRIMARY KEY(channel,sequence));
            """)

    @staticmethod
    def _encode(value):
        return json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(",", ":"), allow_nan=False)

    @staticmethod
    def _append_event(db, channel, kind, content):
        row = db.execute(
            "SELECT sequence,digest FROM task_memory_events WHERE channel=? "
            "ORDER BY sequence DESC LIMIT 1", (channel,)).fetchone()
        sequence, previous = (row[0] + 1, row[1]) if row else (1, "genesis")
        created = time.time()
        event = {"channel": channel, "sequence": sequence, "kind": kind,
                 "created": created, "content": deepcopy(content), "previous": previous}
        event["digest"] = digest(event)
        db.execute("INSERT INTO task_memory_events VALUES(?,?,?,?,?,?,?)",
                   (channel, sequence, kind, created,
                    MemoryService._encode(content), previous, event["digest"]))
        return event

    def admit(self, package, resource, *, parent_id=None, provenance=None):
        """Archive a candidate; admission never certifies or deploys it."""
        verify_package(package)
        self.store.put_package(package)
        normalized = _normalize_resource(resource)
        provenance = _copy({} if provenance is None else provenance, "Memory provenance")
        parent = None
        if parent_id is not None:
            parent = self.version(parent_id)
            if parent["status"] == "rejected":
                raise ContractError("Rejected memory cannot be a lineage parent")
            if (package["id"] != parent["package_id"]
                    and package.get("parent_id") != parent["package_id"]):
                raise ContractError("Memory lineage must stay on the same or direct child AgentPackage")
        generation = 0 if parent is None else parent["generation"] + 1
        identity_payload = {"package_id": package["id"], "package_digest": package["digest"],
                            "parent_id": parent_id, "generation": generation,
                            "resource": normalized}
        version_digest = digest(identity_payload)
        identity = "memory-version-" + version_digest[:24]
        now = time.time()
        record = {"schema": SCHEMA, "id": identity, "digest": version_digest,
                  "parent_id": parent_id, "generation": generation,
                  "package_id": package["id"], "package_digest": package["digest"],
                  "resource": normalized, "provenance": provenance, "created_at": now}
        encoded, record_digest = self._encode(record), digest(record)
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute(
                "SELECT data,record_digest FROM task_memory_versions WHERE id=?",
                (identity,)).fetchone()
            if old:
                if old != (encoded, record_digest):
                    # Same behavior identity cannot silently acquire new private provenance.
                    raise ContractError("Cannot overwrite an immutable memory version")
                return self.version(identity)
            db.execute("INSERT INTO task_memory_versions VALUES(?,?,?,?,?,?,?,?,?,?)",
                       (identity, parent_id, generation, "candidate", package["id"],
                        package["digest"], encoded, record_digest, now, now))
        return self.version(identity)

    def version(self, identity):
        return _load_version(self.store, identity)

    def list_versions(self, *, status=None, package_id=None, parent_id=None):
        if status is not None and status not in STATUSES:
            raise ContractError("Unknown memory lifecycle status")
        clauses, values = [], []
        for column, value in (("status", status), ("package_id", package_id),
                              ("parent_id", parent_id)):
            if value is not None:
                clauses.append(column + "=?")
                values.append(value)
        query = "SELECT id FROM task_memory_versions"
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY created,id"
        with self.store.connect() as db:
            identities = [row[0] for row in db.execute(query, values)]
        return [self.version(identity) for identity in identities]

    def plan_selection(self, identity, *, criteria, evaluator_snapshot,
                       channel=None, expected_revision=None):
        """Freeze host selection inputs and the intended release edge."""
        version = self.version(identity)
        if version["status"] != "candidate":
            raise ContractError("Only candidate memory can enter selection")
        criteria = _copy(criteria, "Memory selection criteria")
        evaluator_snapshot = _copy(evaluator_snapshot, "Memory evaluator snapshot")
        if not isinstance(criteria, dict) or not isinstance(evaluator_snapshot, dict):
            raise ContractError("Memory selection criteria and evaluator snapshot must be objects")
        release = None
        if version["parent_id"] is None:
            if channel is not None or expected_revision is not None:
                raise ContractError("Root memory selection has no existing release edge")
        else:
            if channel is None or type(expected_revision) is not int or expected_revision < 0:
                raise ContractError("Child memory selection must freeze a release revision")
            active = self.active(channel)
            if (active["revision"] != expected_revision
                    or active["memory_id"] != version["parent_id"]):
                raise ContractError("Memory selection parent is not the expected active release")
            release = {key: deepcopy(active[key]) for key in (
                "channel", "revision", "memory_id", "memory_digest",
                "package_id", "package_digest")}
        now = time.time()
        plan = {"id": _id("memory-selection"), "memory_id": identity,
                "memory_digest": version["digest"], "parent_id": version["parent_id"],
                "package_id": version["package_id"],
                "package_digest": version["package_digest"],
                "criteria": criteria, "evaluator_snapshot": evaluator_snapshot,
                "evaluator_snapshot_digest": digest(evaluator_snapshot),
                "release": release, "created_at": now}
        encoded, plan_digest = self._encode(plan), digest(plan)
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            status_row = db.execute(
                "SELECT status FROM task_memory_versions WHERE id=?", (identity,)).fetchone()
            if status_row is None or status_row[0] != "candidate":
                raise ContractError("Memory candidate changed while selection was planned")
            if release is not None:
                channel_row = db.execute(
                    "SELECT memory_id,revision,data FROM task_memory_channels WHERE name=?",
                    (release["channel"],)).fetchone()
                if (channel_row is None or channel_row[0] != release["memory_id"]
                        or channel_row[1] != release["revision"]
                        or any(json.loads(channel_row[2]).get(key) != release[key]
                               for key in release)):
                    raise ContractError("Memory release changed while selection was planned")
            old = db.execute(
                "SELECT data,digest FROM task_memory_selection_plans WHERE memory_id=?",
                (identity,)).fetchone()
            if old:
                existing = json.loads(old[0])
                if digest(existing) != old[1]:
                    raise ContractError("Memory selection plan digest mismatch")
                comparable_keys = (
                    "memory_id", "memory_digest", "parent_id", "package_id",
                    "package_digest", "criteria", "evaluator_snapshot",
                    "evaluator_snapshot_digest", "release")
                if any(existing.get(key) != plan.get(key) for key in comparable_keys):
                    raise ContractError(
                        "Memory candidate already has a different selection plan")
                return {**existing, "digest": old[1]}
            db.execute("INSERT INTO task_memory_selection_plans VALUES(?,?,?,?)",
                       (plan["id"], identity, encoded, plan_digest))
        return {**plan, "digest": plan_digest}

    def selection_plan(self, plan_id):
        with self.store.connect() as db:
            row = db.execute(
                "SELECT data,digest FROM task_memory_selection_plans WHERE id=?",
                (plan_id,)).fetchone()
        if row is None:
            raise KeyError(plan_id)
        plan = json.loads(row[0])
        if digest(plan) != row[1]:
            raise ContractError("Memory selection plan digest mismatch")
        return {**plan, "digest": row[1]}

    def assess(self, plan_id, *, evaluator_snapshot, verdict, reason, evidence=None):
        """Record one host decision against a frozen selection plan."""
        if verdict not in {"accepted", "rejected"}:
            raise ContractError("Memory assessment verdict must be accepted or rejected")
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 10000:
            raise ContractError("Memory assessment requires a bounded nonempty reason")
        plan = self.selection_plan(plan_id)
        evaluator_snapshot = _copy(evaluator_snapshot, "Memory evaluator snapshot")
        if digest(evaluator_snapshot) != plan["evaluator_snapshot_digest"]:
            raise ContractError("Memory evaluator changed after selection was frozen")
        if plan["release"] is not None:
            active = self.active(plan["release"]["channel"])
            if any(active[key] != plan["release"][key] for key in plan["release"]):
                raise ContractError("Memory release changed during selection")
        identity = plan["memory_id"]
        evidence = _copy({} if evidence is None else evidence, "Memory assessment evidence")
        now = time.time()
        decision = {"id": _id("memory-decision"), "memory_id": identity,
                    "plan_id": plan_id, "plan_digest": plan["digest"],
                    "verdict": verdict, "reason": reason, "evidence": evidence,
                    "created_at": now}
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT status FROM task_memory_versions WHERE id=?",
                             (identity,)).fetchone()
            if row is None:
                raise KeyError(identity)
            old = db.execute(
                "SELECT data,digest FROM task_memory_decisions WHERE memory_id=?",
                (identity,)).fetchone()
            if old:
                existing = json.loads(old[0])
                comparable = {key: existing[key] for key in (
                    "memory_id", "plan_id", "plan_digest", "verdict", "reason", "evidence")}
                requested = {key: decision[key] for key in (
                    "memory_id", "plan_id", "plan_digest", "verdict", "reason", "evidence")}
                if comparable != requested or digest(existing) != old[1]:
                    raise ContractError("Memory candidate already has a different host decision")
                return {**existing, "digest": old[1]}
            if row[0] != "candidate":
                raise ContractError("Only candidate memory can be assessed")
            if plan["release"] is not None:
                release = plan["release"]
                channel_row = db.execute(
                    "SELECT memory_id,revision,data FROM task_memory_channels WHERE name=?",
                    (release["channel"],)).fetchone()
                if (channel_row is None or channel_row[0] != release["memory_id"]
                        or channel_row[1] != release["revision"]
                        or any(json.loads(channel_row[2]).get(key) != release[key]
                               for key in release)):
                    raise ContractError("Memory release changed during host assessment")
            encoded, decision_digest = self._encode(decision), digest(decision)
            db.execute("INSERT INTO task_memory_decisions VALUES(?,?,?,?)",
                       (decision["id"], identity, encoded, decision_digest))
            changed = db.execute(
                "UPDATE task_memory_versions SET status=?,updated=? WHERE id=? AND status='candidate'",
                (verdict, now, identity)).rowcount
            if changed != 1:
                raise ContractError("Memory candidate changed during host assessment")
        return {**decision, "digest": decision_digest}

    def decision(self, identity):
        with self.store.connect() as db:
            row = db.execute(
                "SELECT data,digest FROM task_memory_decisions WHERE memory_id=?",
                (identity,)).fetchone()
        if row is None:
            return None
        record = json.loads(row[0])
        if digest(record) != row[1]:
            raise ContractError("Memory assessment record digest mismatch")
        return {**record, "digest": row[1]}

    def register(self, channel, identity):
        """Create a deployment channel from an already accepted root version."""
        channel = _identifier(channel, "Memory channel")
        version = self.version(identity)
        if version["status"] != "accepted" or version["parent_id"] is not None:
            raise ContractError("Memory channel bootstrap requires an accepted root version")
        decision = self.decision(identity)
        if decision is None or self.selection_plan(decision["plan_id"])["release"] is not None:
            raise ContractError("Memory channel bootstrap requires a frozen root selection")
        state = {"channel": channel, "memory_id": identity,
                 "memory_digest": version["digest"], "package_id": version["package_id"],
                 "package_digest": version["package_digest"], "revision": 0,
                 "updated_at": time.time()}
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            status_row = db.execute(
                "SELECT status FROM task_memory_versions WHERE id=?", (identity,)).fetchone()
            if status_row is None or status_row[0] != "accepted":
                raise ContractError("Root memory changed before channel registration")
            if db.execute("SELECT 1 FROM task_memory_channels WHERE name=?", (channel,)).fetchone():
                raise ContractError("Memory channel already exists")
            if db.execute("SELECT 1 FROM task_memory_channels WHERE memory_id=?", (identity,)).fetchone():
                raise ContractError("Memory version is already active on another channel")
            db.execute("INSERT INTO task_memory_channels VALUES(?,?,?,?)",
                       (channel, identity, 0, self._encode(state)))
            self._append_event(db, channel, "memory_channel_registered", {
                "memory_id": identity, "memory_digest": version["digest"],
                "package_id": version["package_id"], "package_digest": version["package_digest"]})
        return self.active(channel)

    def active(self, channel):
        return active_memory_registration(self.store, channel)

    def events(self, channel):
        channel = _identifier(channel, "Memory channel")
        with self.store.connect() as db:
            rows = db.execute(
                "SELECT sequence,kind,created,data,previous,digest FROM task_memory_events "
                "WHERE channel=? ORDER BY sequence", (channel,)).fetchall()
        events = []
        previous = "genesis"
        for sequence, kind, created, data, stored_previous, event_digest in rows:
            event = {"channel": channel, "sequence": sequence, "kind": kind,
                     "created": created, "content": json.loads(data),
                     "previous": stored_previous}
            if stored_previous != previous or digest(event) != event_digest:
                raise ContractError("Memory event chain integrity mismatch")
            event["digest"] = event_digest
            events.append(event)
            previous = event_digest
        return events

    def promote(self, channel, identity, *, expected_revision, expected_memory_id=None):
        """CAS-deploy an accepted direct child without rewriting revision status."""
        if type(expected_revision) is not int or expected_revision < 0:
            raise ContractError("Memory promotion requires an expected channel revision")
        active = self.active(channel)
        if active["revision"] != expected_revision:
            raise ContractError("Active memory changed before promotion")
        if expected_memory_id is not None and active["memory_id"] != expected_memory_id:
            raise ContractError("Active memory differs from the expected parent")
        target = self.version(identity)
        if target["status"] != "accepted" or target["parent_id"] != active["memory_id"]:
            raise ContractError("Promotion requires an accepted direct memory child")
        decision = self.decision(identity)
        if decision is None:
            raise ContractError("Promotion requires a frozen host selection decision")
        plan = self.selection_plan(decision["plan_id"])
        expected_release = plan.get("release")
        if (decision["verdict"] != "accepted" or expected_release is None
                or any(active[key] != expected_release[key] for key in expected_release)):
            raise ContractError("Promotion does not match its frozen selection release")
        state = {"channel": channel, "memory_id": identity,
                 "memory_digest": target["digest"], "package_id": target["package_id"],
                 "package_digest": target["package_digest"],
                 "revision": expected_revision + 1, "updated_at": time.time()}
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT status FROM task_memory_versions WHERE id=?",
                             (identity,)).fetchone()
            if not row or row[0] != "accepted":
                raise ContractError("Memory candidate changed before promotion")
            if db.execute("SELECT 1 FROM task_memory_channels WHERE memory_id=? AND name<>?",
                          (identity, channel)).fetchone():
                raise ContractError("Memory version is active on another channel")
            changed = db.execute(
                "UPDATE task_memory_channels SET memory_id=?,revision=?,data=? "
                "WHERE name=? AND memory_id=? AND revision=?",
                (identity, state["revision"], self._encode(state), channel,
                 active["memory_id"], expected_revision)).rowcount
            if changed != 1:
                raise ContractError("Active memory changed during promotion")
            self._append_event(db, channel, "memory_promoted", {
                "from_memory_id": active["memory_id"], "to_memory_id": identity,
                "from_memory_digest": active["memory_digest"],
                "to_memory_digest": target["digest"],
                "package_id": target["package_id"],
                "package_digest": target["package_digest"],
                "decision_digest": decision["digest"], "selection_plan_digest": plan["digest"]})
        return self.active(channel)

    def rollback(self, channel, *, reason, expected_revision, expected_memory_id=None):
        """CAS-return along the exact prior deployment edge."""
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 10000:
            raise ContractError("Memory rollback requires a bounded nonempty reason")
        if type(expected_revision) is not int or expected_revision < 0:
            raise ContractError("Memory rollback requires an expected channel revision")
        active = self.active(channel)
        if active["revision"] != expected_revision:
            raise ContractError("Active memory changed before rollback")
        if expected_memory_id is not None and active["memory_id"] != expected_memory_id:
            raise ContractError("Active memory differs from the expected rollback source")
        promotions = [event for event in self.events(channel)
                      if event["kind"] == "memory_promoted"
                      and event["content"].get("to_memory_id") == active["memory_id"]]
        if not promotions:
            raise ContractError("Active memory has no prior deployment edge")
        target_id = promotions[-1]["content"]["from_memory_id"]
        target = self.version(target_id)
        if target["status"] != "accepted":
            raise ContractError("Rollback target is no longer an accepted revision")
        state = {"channel": channel, "memory_id": target_id,
                 "memory_digest": target["digest"], "package_id": target["package_id"],
                 "package_digest": target["package_digest"],
                 "revision": expected_revision + 1, "updated_at": time.time()}
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            target_status = db.execute(
                "SELECT status FROM task_memory_versions WHERE id=?", (target_id,)).fetchone()
            if target_status is None or target_status[0] != "accepted":
                raise ContractError("Rollback target changed before channel update")
            changed = db.execute(
                "UPDATE task_memory_channels SET memory_id=?,revision=?,data=? "
                "WHERE name=? AND memory_id=? AND revision=?",
                (target_id, state["revision"], self._encode(state), channel,
                 active["memory_id"], expected_revision)).rowcount
            if changed != 1:
                raise ContractError("Active memory changed during rollback")
            self._append_event(db, channel, "memory_rolled_back", {
                "from_memory_id": active["memory_id"], "to_memory_id": target_id,
                "from_memory_digest": active["memory_digest"],
                "to_memory_digest": target["digest"], "reason_digest": digest(reason)})
        return self.active(channel)

    def retire(self, identity, *, reason):
        """Retire an accepted revision only when no release points at it."""
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 10000:
            raise ContractError("Memory retirement requires a bounded nonempty reason")
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM task_memory_channels WHERE memory_id=?",
                          (identity,)).fetchone():
                raise ContractError("An active memory release cannot be retired")
            # Keep the exact predecessor needed by rollback available while its
            # deployed successor is active. Otherwise retirement could make a
            # pre-registered guard detect regression but leave no valid edge to
            # return along.
            for channel, active_id in db.execute(
                    "SELECT name,memory_id FROM task_memory_channels").fetchall():
                rows = db.execute(
                    "SELECT data FROM task_memory_events WHERE channel=? "
                    "AND kind='memory_promoted' ORDER BY sequence DESC",
                    (channel,)).fetchall()
                predecessor = next((json.loads(row[0]).get("from_memory_id")
                                    for row in rows
                                    if json.loads(row[0]).get("to_memory_id") == active_id), None)
                if predecessor == identity:
                    raise ContractError(
                        "A memory rollback target cannot be retired while its successor is active")
            changed = db.execute(
                "UPDATE task_memory_versions SET status='retired',updated=? "
                "WHERE id=? AND status='accepted'", (time.time(), identity)).rowcount
            if changed != 1:
                raise ContractError("Only an inactive accepted memory revision can be retired")
            retirement = {"id": _id("memory-retirement"), "memory_id": identity,
                          "reason": reason, "created_at": time.time()}
            retirement_digest = digest(retirement)
            db.execute("INSERT INTO task_memory_retirements VALUES(?,?,?,?)",
                       (retirement["id"], identity, self._encode(retirement),
                        retirement_digest))
        return self.version(identity)

    def retirement(self, identity):
        with self.store.connect() as db:
            row = db.execute(
                "SELECT data,digest FROM task_memory_retirements WHERE memory_id=?",
                (identity,)).fetchone()
        if row is None:
            return None
        record = json.loads(row[0])
        if digest(record) != row[1]:
            raise ContractError("Memory retirement record digest mismatch")
        return {**record, "digest": row[1]}

    def public_version(self, identity):
        from .memory_view import public_memory_version
        return public_memory_version(
            self.version(identity), self.decision(identity), self.retirement(identity))

    def public_channel(self, channel, *, limit=50):
        from .memory_view import public_memory_channel_view
        return public_memory_channel_view(self.active(channel), self.events(channel), limit=limit)


def active_memory_registration(store, channel):
    """Resolve and verify an active memory identity without exposing its content."""
    channel = _identifier(channel, "Memory channel")
    with store.connect() as db:
        try:
            row = db.execute(
                "SELECT memory_id,revision,data FROM task_memory_channels WHERE name=?",
                (channel,)).fetchone()
        except Exception as exc:
            raise ContractError("Memory channel registry is not initialized") from exc
    if row is None:
        raise ContractError(f"Unknown memory channel: {channel}")
    state = json.loads(row[2])
    version = _load_version(store, row[0])
    if (state.get("channel") != channel or state.get("memory_id") != row[0]
            or state.get("revision") != row[1]
            or state.get("memory_digest") != version["digest"]
            or state.get("package_id") != version["package_id"]
            or state.get("package_digest") != version["package_digest"]
            or version["status"] != "accepted"):
        raise ContractError("Active memory registry projection mismatch")
    return deepcopy(state)


def memory_version(store, identity):
    """Load a verified private version for Episode snapshotting."""
    return _load_version(store, identity)
