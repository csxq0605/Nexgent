"""Transactional task ledger, isolated from the legacy research projections.

The host owns admission and visibility.  Descendants share their root's account;
an interrupted external request remains charged and cannot silently be replayed.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path

from ..kernel.store import BudgetExhausted


MAX_JSON_BYTES = 1_000_000
DEFAULT_BUDGET = {"max_model_calls": 20, "max_completion_tokens": 80000,
                  "max_tool_calls": 20, "max_tool_work_units": 0,
                  "max_nodes": 100}


class RecoveryRequired(RuntimeError):
    """An admitted request has no durable outcome; repeating it is unsafe."""


class StateConflict(RuntimeError):
    """A projection was saved against an obsolete revision."""


def _json(value):
    value = json.dumps(value, ensure_ascii=False, sort_keys=True,
                       separators=(",", ":"), allow_nan=False)
    if len(value.encode("utf-8")) > MAX_JSON_BYTES:
        raise ValueError("Task JSON exceeds the 1 MB host limit")
    return value


def _digest(value):
    return hashlib.sha256(_json(value).encode("utf-8")).hexdigest()


def _id(prefix):
    return prefix + "-" + uuid.uuid4().hex[:16]


class EpisodeStore:
    @staticmethod
    def _check_capability_admission(db, episode, descriptor):
        """Reject unusable grants before they enter the visible inventory."""
        effect = descriptor.get("effect_class")
        units = descriptor.get("work_units_per_call")
        if (effect not in {"read", "artifact_write", "local_compute", "external_compute"}
                or type(units) is not int or units < 0):
            raise ValueError("Capability effect or work reservation is invalid")
        allowed = episode["task"].get("constraints", {}).get("allowed_effects")
        if allowed is not None and effect not in allowed:
            raise PermissionError("Capability effect exceeds the Episode authority")
        root_id = episode["root_episode_id"]
        root = episode if root_id == episode["id"] else EpisodeStore._get(db, root_id)
        rows = db.execute(
            "SELECT data FROM task_resources WHERE root_id=? AND kind='tool'",
            (root_id,)).fetchall()
        if len(rows) >= root["budget"]["max_tool_calls"]:
            raise BudgetExhausted("Root Episode tool-call budget exhausted")
        charged = 0
        for row in rows:
            accounting = json.loads(row[0]).get("data", {}).get("work_accounting", {})
            charged += accounting.get("charged_work_units",
                                      accounting.get("reserved_work_units", 0))
        if charged + units > root["budget"].get("max_tool_work_units", 0):
            raise BudgetExhausted("Root Episode tool-work budget exhausted")

    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "research.sqlite3"
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS task_episodes(
                    id TEXT PRIMARY KEY, root_id TEXT NOT NULL, updated REAL, state TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_packages(
                    id TEXT PRIMARY KEY, digest TEXT NOT NULL, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_skill_package_leases(
                    package_id TEXT NOT NULL, root_id TEXT NOT NULL,
                    creator_episode TEXT NOT NULL, created REAL NOT NULL,
                    PRIMARY KEY(package_id,root_id));
                CREATE TABLE IF NOT EXISTS task_capability_leases(
                    episode TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL,
                    PRIMARY KEY(episode,name));
                CREATE TABLE IF NOT EXISTS task_delegated_capability_bounds(
                    episode TEXT NOT NULL, name TEXT NOT NULL, descriptor TEXT NOT NULL,
                    PRIMARY KEY(episode,name));
                CREATE TABLE IF NOT EXISTS task_capability_definitions(
                    id TEXT PRIMARY KEY, digest TEXT NOT NULL,
                    origin_episode TEXT NOT NULL, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_capability_instances(
                    episode TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL,
                    PRIMARY KEY(episode,name));
                CREATE TABLE IF NOT EXISTS task_events(
                    episode TEXT, sequence INTEGER, kind TEXT, created REAL,
                    data TEXT, previous TEXT, digest TEXT,
                    PRIMARY KEY(episode,sequence));
                CREATE TABLE IF NOT EXISTS task_calls(
                    id TEXT PRIMARY KEY, root_id TEXT NOT NULL, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_resources(
                    episode TEXT, identity TEXT, root_id TEXT, kind TEXT, data TEXT,
                    PRIMARY KEY(episode,kind,identity));
                CREATE TABLE IF NOT EXISTS task_artifacts(
                    id TEXT PRIMARY KEY, episode TEXT, root_id TEXT, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_memory(
                    id TEXT PRIMARY KEY, namespace TEXT, split TEXT, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_retrievals(
                    id TEXT PRIMARY KEY, episode TEXT, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_snapshots(
                    id TEXT PRIMARY KEY, episode TEXT, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_benchmark_registrations(
                    episode TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_memory_registrations(
                    episode TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_rpc(
                    episode TEXT, call_path TEXT, data TEXT NOT NULL,
                    PRIMARY KEY(episode,call_path));
                CREATE TABLE IF NOT EXISTS task_once(
                    root_id TEXT, identity TEXT, episode TEXT, created REAL,
                    PRIMARY KEY(root_id,identity));
                CREATE INDEX IF NOT EXISTS task_calls_root ON task_calls(root_id);
                CREATE INDEX IF NOT EXISTS task_resources_root ON task_resources(root_id,kind);
                CREATE INDEX IF NOT EXISTS task_memory_scope ON task_memory(namespace,split);
            """)

    def connect(self):
        return sqlite3.connect(self.path, timeout=30)

    @staticmethod
    def _get(db, episode_id):
        row = db.execute("SELECT state FROM task_episodes WHERE id=?", (episode_id,)).fetchone()
        if row is None:
            raise KeyError(episode_id)
        return json.loads(row[0])

    def create(self, task, package, parent_episode_id=None, *, benchmark_registration=None,
               memory_registration=None, memory_version=None,
               _allow_candidate_memory=False, initial_capability_descriptors=()):
        task = deepcopy(task)
        from .capability_authority import (require_delegated_authority,
                                            validate_episode_authority)
        authority = task.get("capability_authority")
        if authority is not None:
            authority = validate_episode_authority(authority)
            task["capability_authority"] = authority
        initial_capability_descriptors = deepcopy(initial_capability_descriptors)
        if not isinstance(initial_capability_descriptors, (list, tuple)):
            raise ValueError("Initial capability descriptors must be a sequence")
        if initial_capability_descriptors and task.get("capability_mode") != "leased":
            raise PermissionError("Initial capability leases require leased mode")
        initial_names = []
        for descriptor in initial_capability_descriptors:
            if (not isinstance(descriptor, dict)
                    or not isinstance(descriptor.get("name"), str)
                    or descriptor.get("digest") != _digest(
                        {key: value for key, value in descriptor.items() if key != "digest"})):
                raise ValueError("Initial capability descriptor identity is invalid")
            initial_names.append(descriptor["name"])
        if len(set(initial_names)) != len(initial_names):
            raise ValueError("Initial capability names must be unique")
        benchmark_registration = (None if benchmark_registration is None
                                  else deepcopy(benchmark_registration))
        memory_registration = (None if memory_registration is None
                               else deepcopy(memory_registration))
        memory_version = None if memory_version is None else deepcopy(memory_version)
        if (_allow_candidate_memory
                and (not isinstance(memory_registration, dict)
                     or memory_registration.get("channel") != "candidate-selection"
                     or not isinstance(task.get("context", {}).get(
                         "memory_candidate_evaluation"), dict))):
            raise PermissionError("Candidate memory snapshots are host-private")
        if not isinstance(task, dict) or not isinstance(task.get("objective"), str) or not task["objective"].strip():
            raise ValueError("A task requires a nonempty objective")
        if not isinstance(task.get("inputs", {}), dict):
            raise ValueError("Task inputs must be a port map")
        capabilities = task.get("capabilities", [])
        if not isinstance(capabilities, list) or any(not isinstance(c, str) for c in capabilities):
            raise ValueError("Capabilities must be a list of names")
        if not set(initial_names) <= set(capabilities):
            raise PermissionError("Initial leases exceed the Episode capability ceiling")
        limits = {**DEFAULT_BUDGET, **task.get("budget", {})}
        for name in DEFAULT_BUDGET:
            if type(limits[name]) is not int or limits[name] < 0:
                raise ValueError("Budget limits must be nonnegative integers")
        task_scoped_package = self.is_task_scoped_package(package)
        self.authorize_task_package_use(package, parent_episode_id)
        if not task_scoped_package:
            self.put_package(package)
        now, episode_id = time.time(), _id("episode")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            root_id = episode_id
            inherited_descriptors = {}
            if parent_episode_id:
                parent = self._get(db, parent_episode_id)
                parent_authority = parent["task"].get("capability_authority")
                if authority is not None:
                    if parent_authority is None:
                        raise PermissionError("Delegation cannot add capability authority")
                    require_delegated_authority(parent_authority, authority)
                if not set(capabilities) <= set(parent["capabilities"]):
                    raise PermissionError("A delegated task cannot widen parent capabilities")
                if parent["task"].get("capability_mode") == "leased":
                    if task.get("capability_mode") != "leased":
                        raise PermissionError("A leased parent cannot delegate legacy tool grants")
                    active_rows = db.execute(
                        "SELECT data FROM task_capability_leases WHERE episode=?",
                        (parent_episode_id,)).fetchall()
                    active_leases = [json.loads(row[0]) for row in active_rows]
                    inherited_descriptors = {
                        lease["name"]: lease["descriptor"] for lease in active_leases
                        if lease["status"] == "active"
                    }
                    if not set(capabilities) <= set(inherited_descriptors):
                        raise PermissionError("Delegation exceeds the parent's active leases")
                    if any(descriptor != inherited_descriptors[descriptor["name"]]
                           for descriptor in initial_capability_descriptors):
                        raise PermissionError("Delegated handler differs from the parent lease")
                root_id = parent["root_episode_id"]
                limits = self._get(db, root_id)["budget"]
                # Evaluation and memory boundaries are inherited, never delegated away.
                parent_context = parent["task"].get("context", {})
                context = task.setdefault("context", {})
                for key in ("memory_namespace", "split"):
                    inherited = parent_context.get(key, "default" if key == "memory_namespace" else "development")
                    if key in context and context[key] != inherited:
                        raise PermissionError("A child task cannot change its memory boundary")
                    context[key] = inherited
                parent_memory = db.execute(
                    "SELECT data FROM task_memory_registrations WHERE episode=?",
                    (parent_episode_id,)).fetchone()
                parent_registration = json.loads(parent_memory[0]) if parent_memory else None
                if memory_registration is not None and memory_registration != parent_registration:
                    raise PermissionError("A child task cannot change its frozen memory version")
                memory_registration = parent_registration
            if memory_registration is not None:
                if (memory_registration.get("package_id") != package["id"]
                        or memory_registration.get("package_digest") != package["digest"]):
                    raise PermissionError("Frozen memory belongs to a different AgentPackage")
                try:
                    memory_row = db.execute(
                        "SELECT status,data,record_digest FROM task_memory_versions WHERE id=?",
                        (memory_registration.get("memory_id"),)).fetchone()
                except sqlite3.OperationalError as exc:
                    raise PermissionError("Frozen memory registry is unavailable") from exc
                stored_memory = json.loads(memory_row[1]) if memory_row else None
                provided_memory = deepcopy(memory_version) if isinstance(memory_version, dict) else None
                if provided_memory is not None:
                    provided_memory.pop("status", None)
                    provided_memory.pop("record_digest", None)
                # A resolved registration is the Episode's linearization point.
                # Like package-channel resolution, a later channel move does not
                # rewrite that in-flight choice. Retired versions remain valid for
                # already resolved or delegated Episodes, but cannot be resolved
                # anew by active_memory_registration().
                allowed_statuses = ({"accepted", "retired", "candidate"}
                                    if _allow_candidate_memory
                                    else {"accepted", "retired"})
                if (not isinstance(memory_version, dict)
                        or memory_row is None
                        or memory_row[0] not in allowed_statuses
                        or _digest(stored_memory) != memory_row[2]
                        or stored_memory != provided_memory
                        or memory_version.get("id") != memory_registration.get("memory_id")
                        or memory_version.get("digest") != memory_registration.get("memory_digest")
                        or memory_version.get("package_id") != package["id"]
                        or memory_version.get("package_digest") != package["digest"]
                        or memory_version.get("status") not in allowed_statuses):
                    raise PermissionError("Frozen memory version does not match its registration")
            elif memory_version is not None:
                raise PermissionError("A memory version requires a frozen registration")
            task.setdefault("inputs", {})
            task.setdefault("context", {})
            task.setdefault("entry", "execute")
            task["budget"] = deepcopy(limits)
            task["capabilities"] = deepcopy(capabilities)
            episode = {"id": episode_id, "task": task, "package_id": package["id"],
                       "package_digest": package["digest"], "parent_episode_id": parent_episode_id,
                       "root_episode_id": root_id, "status": "ready", "revision": 0,
                       "plan": None, "current_plan_ref": None, "plan_history_refs": [],
                       "plan_revision": 0, "plan_revisions": [], "plan_execution": None,
                       "plan_workflow_ref": None, "plan_workflow_snapshot": None,
                       "plan_workflow_versions": {},
                       "plan_node_receipts": {},
                       "nodes": {}, "input_refs": {}, "output_refs": {},
                       "child_episode_ids": [], "memory_snapshot_id": None, "outcome": None,
                       "budget": deepcopy(limits), "capabilities": deepcopy(capabilities),
                       "created_at": now, "updated_at": now}
            memory_snapshot = None
            if memory_registration is not None:
                namespace, split = self._scope(episode)
                resource = memory_version.get("resource", {})
                policy = resource.get("policy", {})
                data = resource.get("data", {})
                if (set(policy) != {"retrieval", "writeback"}
                        or set(data) != {"items"} or not isinstance(data["items"], list)):
                    raise ValueError("Frozen memory resource shape is invalid")
                items = []
                for entry in data["items"]:
                    item = deepcopy(entry)
                    item.update({"status": "accepted", "namespace": namespace, "split": split})
                    items.append(item)
                memory_snapshot = {
                    "id": _id("snapshot"), "episode_id": episode_id,
                    "item_version_refs": [{"id": item["id"], "version": item["version"]}
                                          for item in items],
                    "items": items, "retrieval_refs": [], "query": "",
                    "namespace": namespace, "split": split,
                    "retrieval_policy_digest": _digest(policy["retrieval"]),
                    "memory_policy": deepcopy(policy),
                    "source": {key: deepcopy(memory_registration[key]) for key in (
                        "channel", "revision", "memory_id", "memory_digest",
                        "package_id", "package_digest")},
                    "created_at": now,
                }
                memory_snapshot["digest"] = _digest(memory_snapshot)
                # Serialize before inserting the Episode.  Contract/size failures
                # therefore leave no partial identity even inside this transaction.
                _json(memory_snapshot)
                episode["memory_snapshot_id"] = memory_snapshot["id"]
            db.execute("INSERT INTO task_episodes VALUES(?,?,?,?)", (episode_id, root_id, now, _json(episode)))
            if benchmark_registration is not None:
                encoded = _json(benchmark_registration)
                db.execute("INSERT INTO task_benchmark_registrations VALUES(?,?,?)",
                           (episode_id, encoded, _digest(benchmark_registration)))
            if memory_registration is not None:
                encoded = _json(memory_registration)
                db.execute("INSERT INTO task_memory_registrations VALUES(?,?,?)",
                           (episode_id, encoded, _digest(memory_registration)))
            self._event(db, episode_id, "task_registered", {"task": task, "package_digest": package["digest"]})
            for name in capabilities:
                if name in inherited_descriptors:
                    db.execute(
                        "INSERT INTO task_delegated_capability_bounds VALUES(?,?,?)",
                        (episode_id, name, _json(inherited_descriptors[name])))
            for descriptor in initial_capability_descriptors:
                self._check_capability_admission(db, episode, descriptor)
                record = {"episode_id": episode_id, "name": descriptor["name"],
                          "status": "active", "revision": 1,
                          "descriptor": descriptor, "created_at": now, "updated_at": now}
                db.execute("INSERT INTO task_capability_leases VALUES(?,?,?)",
                           (episode_id, descriptor["name"], _json(record)))
                self._event(db, episode_id, "capability_mounted",
                            {"name": descriptor["name"], "revision": 1,
                             "descriptor_digest": descriptor["digest"]})
            if memory_registration is not None:
                self._event(db, episode_id, "memory_version_frozen", {
                    "channel": memory_registration["channel"],
                    "revision": memory_registration["revision"],
                    "memory_id": memory_registration["memory_id"],
                    "memory_digest": memory_registration["memory_digest"],
                })
                db.execute("INSERT INTO task_snapshots VALUES(?,?,?)",
                           (memory_snapshot["id"], episode_id, _json(memory_snapshot)))
                self._event(db, episode_id, "memory_snapshot", {
                    "id": memory_snapshot["id"], "digest": memory_snapshot["digest"],
                    "item_version_refs": memory_snapshot["item_version_refs"],
                    "retrieval_policy_digest": memory_snapshot["retrieval_policy_digest"],
                    "source": memory_snapshot["source"],
                })
        return episode

    def benchmark_registration(self, episode_id):
        with self.connect() as db:
            self._get(db, episode_id)
            row = db.execute(
                "SELECT data,digest FROM task_benchmark_registrations WHERE episode=?",
                (episode_id,)).fetchone()
        if row is None:
            return None
        value = json.loads(row[0])
        if _digest(value) != row[1]:
            raise ValueError("Benchmark registration digest mismatch")
        return value

    def memory_registration(self, episode_id):
        """Return the host-private memory identity frozen for an Episode."""
        with self.connect() as db:
            self._get(db, episode_id)
            row = db.execute(
                "SELECT data,digest FROM task_memory_registrations WHERE episode=?",
                (episode_id,)).fetchone()
        if row is None:
            return None
        value = json.loads(row[0])
        if _digest(value) != row[1]:
            raise ValueError("Memory registration digest mismatch")
        return value

    def get(self, episode_id):
        with self.connect() as db:
            return self._get(db, episode_id)

    def list(self):
        with self.connect() as db:
            return [json.loads(r[0]) for r in db.execute("SELECT state FROM task_episodes ORDER BY updated DESC,id")]

    def save(self, state):
        state = deepcopy(state)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            old = self._get(db, state["id"])
            for key in ("task", "package_id", "package_digest", "parent_episode_id", "root_episode_id",
                        "budget", "capabilities", "created_at"):
                if state.get(key) != old.get(key):
                    raise PermissionError(f"Immutable Episode identity field: {key}")
            if state.get("revision") != old["revision"]:
                raise StateConflict("Episode projection has a newer revision")
            state["revision"] += 1
            state["updated_at"] = time.time()
            db.execute("UPDATE task_episodes SET updated=?,state=? WHERE id=?",
                       (state["updated_at"], _json(state), state["id"]))
        return state

    @staticmethod
    def _put_package_row(db, package):
        previous = db.execute(
            "SELECT data FROM task_packages WHERE id=?", (package["id"],)).fetchone()
        if previous and previous[0] != _json(package):
            stored = json.loads(previous[0])
            # Package identity covers executable content and lineage, while
            # generation provenance lives in immutable candidate/generation
            # records.  Re-running an improver may therefore rediscover the
            # same content-addressed child with a different generation id.
            comparable = lambda value: {key: item for key, item in value.items()
                                        if key != "provenance"}
            if comparable(stored) != comparable(package):
                raise ValueError("Cannot overwrite an immutable AgentPackage")
        if package.get("parent_id"):
            parent = db.execute(
                "SELECT data FROM task_packages WHERE id=?",
                (package["parent_id"],)).fetchone()
            if not parent:
                raise ValueError("Package parent must be stored first")
            if package["generation"] != json.loads(parent[0])["generation"] + 1:
                raise ValueError("Package generation does not follow its parent")
        db.execute("INSERT OR IGNORE INTO task_packages VALUES(?,?,?)",
                   (package["id"], package["digest"], _json(package)))

    def put_package(self, package):
        from .packages import verify_package
        verify_package(package)
        if package.get("provenance", {}).get("task_time_only") is True:
            raise PermissionError(
                "Task-authored packages must be persisted with a creator-tree lease")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self._put_package_row(db, package)
        return deepcopy(package)

    def lease_task_package(self, package, creator_episode):
        """Persist a task-authored package and bind it to its creator's tree."""
        from .packages import verify_package
        verify_package(package)
        provenance = package.get("provenance", {})
        if (provenance.get("task_time_only") is not True
                or provenance.get("promotion_authority") is not False
                or provenance.get("episode_id") != creator_episode):
            raise PermissionError("Task-authored package provenance is invalid")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            creator = self._get(db, creator_episode)
            self._put_package_row(db, package)
            db.execute(
                "INSERT OR IGNORE INTO task_skill_package_leases VALUES(?,?,?,?)",
                (package["id"], creator["root_episode_id"], creator_episode, time.time()))
        return deepcopy(package)

    def is_task_scoped_package(self, package):
        if not isinstance(package, dict) or not isinstance(package.get("id"), str):
            return False
        current = package
        seen = set()
        with self.connect() as db:
            while isinstance(current, dict) and current.get("id") not in seen:
                package_id = current.get("id")
                if not isinstance(package_id, str):
                    return False
                seen.add(package_id)
                stored_row = db.execute(
                    "SELECT data FROM task_packages WHERE id=?", (package_id,)).fetchone()
                stored = json.loads(stored_row[0]) if stored_row else None
                if (current.get("provenance", {}).get("task_time_only") is True
                        or isinstance(stored, dict)
                        and stored.get("provenance", {}).get("task_time_only") is True
                        or db.execute(
                            "SELECT 1 FROM task_skill_package_leases "
                            "WHERE package_id=? LIMIT 1", (package_id,)).fetchone()):
                    return True
                parent_id = current.get("parent_id")
                if parent_id is None:
                    return False
                parent_row = db.execute(
                    "SELECT data FROM task_packages WHERE id=?", (parent_id,)).fetchone()
                if parent_row is None:
                    return False
                current = json.loads(parent_row[0])
        return False

    def authorize_task_package_use(self, package, parent_episode_id):
        """Reject task-authored packages outside a leased Episode tree."""
        if not self.is_task_scoped_package(package):
            return
        if not isinstance(parent_episode_id, str) or not parent_episode_id:
            raise PermissionError(
                "Task-authored packages require a delegated Episode in their creator tree")
        with self.connect() as db:
            parent = self._get(db, parent_episode_id)
            allowed = db.execute(
                "SELECT 1 FROM task_skill_package_leases WHERE package_id=? AND root_id=?",
                (package["id"], parent["root_episode_id"])).fetchone()
        if allowed is None:
            raise PermissionError(
                "Task-authored package is outside its creator Episode tree")

    def package(self, package_id):
        from .packages import verify_package
        with self.connect() as db:
            row = db.execute("SELECT data FROM task_packages WHERE id=?", (package_id,)).fetchone()
        if not row:
            raise KeyError(package_id)
        package = json.loads(row[0])
        verify_package(package)
        return package

    def stage_tool_definition(self, episode_id, definition, package):
        """Bind an immutable task-authored bundle to its creator Episode."""
        from .capability_authority import require_definition_authorized
        from .capability_definitions import verify_tool_definition
        definition = deepcopy(verify_tool_definition(definition, package))
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            episode = self._get(db, episode_id)
            if episode["status"] in {"completed", "cancelled", "failed"}:
                raise PermissionError("Terminal Episode cannot stage a tool")
            authority = episode["task"].get("capability_authority")
            if authority is None or definition["origin_episode_id"] != episode_id:
                raise PermissionError("Tool development requires creator Episode authority")
            require_definition_authorized(
                authority, definition["kind"], definition["effect_class"],
                definition["declared_operations"], definition["credential_handles"])
            if definition["runtime"] != authority["runtime"]:
                raise PermissionError("Tool runtime exceeds Episode authority")
            allowed = episode["task"].get("constraints", {}).get("allowed_effects")
            if allowed is not None and definition["effect_class"] not in allowed:
                raise PermissionError("Tool effect exceeds Episode constraints")
            existing = db.execute(
                "SELECT data FROM task_capability_definitions WHERE id=?",
                (definition["id"],)).fetchone()
            if existing:
                if json.loads(existing[0]) != definition:
                    raise ValueError("Cannot overwrite an immutable CapabilityDefinition")
                return definition
            count = db.execute(
                "SELECT COUNT(*) FROM task_capability_definitions WHERE origin_episode=?",
                (episode_id,)).fetchone()[0]
            if count >= authority["max_definitions"]:
                raise BudgetExhausted("Episode tool-definition limit exhausted")
            if definition["name"] in episode["capabilities"]:
                raise PermissionError("Task-authored tool cannot shadow an installed grant")
            self._put_package_row(db, package)
            db.execute("INSERT OR IGNORE INTO task_skill_package_leases VALUES(?,?,?,?)",
                       (package["id"], episode["root_episode_id"], episode_id, time.time()))
            db.execute("INSERT INTO task_capability_definitions VALUES(?,?,?,?)",
                       (definition["id"], definition["digest"], episode_id,
                        _json(definition)))
            self._event(db, episode_id, "capability_definition_staged", {
                "definition_id": definition["id"], "definition_digest": definition["digest"],
                "package_id": package["id"], "package_digest": package["digest"],
                "authority_digest": authority["digest"], "name": definition["name"],
            })
        return definition

    def tool_definition(self, definition_id):
        from .capability_definitions import verify_tool_definition
        with self.connect() as db:
            row = db.execute(
                "SELECT digest,origin_episode,data FROM task_capability_definitions WHERE id=?",
                (definition_id,)).fetchone()
        if row is None:
            raise KeyError(definition_id)
        definition = json.loads(row[2])
        if (definition.get("id") != definition_id
                or definition.get("digest") != row[0]
                or definition.get("origin_episode_id") != row[1]):
            raise ValueError("Stored CapabilityDefinition table identity mismatch")
        verify_tool_definition(definition, self.package(definition["package_id"]))
        return definition

    def tool_instance(self, episode_id, name):
        with self.connect() as db:
            self._get(db, episode_id)
            row = db.execute(
                "SELECT data FROM task_capability_instances WHERE episode=? AND name=?",
                (episode_id, name)).fetchone()
            return self._checked_tool_instance(db, episode_id, name, row[0]) if row else None

    @staticmethod
    def _checked_tool_instance(db, episode_id, name, encoded):
        instance = json.loads(encoded)
        fields = {"schema", "episode_id", "name", "definition_id",
                  "definition_digest", "authority_digest", "status", "revision",
                  "created_at", "updated_at", "record_digest"}
        if (set(instance) != fields or instance["schema"] != "nexgent.capability-instance.v1"
                or instance["episode_id"] != episode_id or instance["name"] != name
                or instance["status"] not in {"active", "released"}
                or type(instance["revision"]) is not int or instance["revision"] < 1
                or instance["record_digest"] != _digest({
                    key: value for key, value in instance.items() if key != "record_digest"})):
            raise ValueError("Stored CapabilityInstance identity is invalid")
        latest = None
        previous, expected_sequence = "genesis", 1
        for sequence, kind, created, data, stored_previous, stored_digest in db.execute(
                "SELECT sequence,kind,created,data,previous,digest FROM task_events "
                "WHERE episode=? ORDER BY sequence", (episode_id,)):
            event = json.loads(data)
            envelope = {"episode_id": episode_id, "sequence": sequence,
                        "kind": kind, "created": created, "content": event,
                        "previous": stored_previous}
            if (sequence != expected_sequence or stored_previous != previous
                    or _digest(envelope) != stored_digest):
                raise ValueError("Episode event chain is invalid")
            expected_sequence += 1
            previous = stored_digest
            if kind in {"capability_instance_mounted", "capability_instance_released"}:
                if event.get("name") == name:
                    latest = (kind, event)
        if latest is None:
            raise ValueError("CapabilityInstance has no lifecycle event")
        kind, event = latest
        if (event.get("revision") != instance["revision"]
                or event.get("record_digest") != instance["record_digest"]
                or (kind == "capability_instance_mounted")
                != (instance["status"] == "active")):
            raise ValueError("CapabilityInstance differs from its lifecycle event")
        return instance

    def tool_instances(self, episode_id, *, active_only=False):
        with self.connect() as db:
            self._get(db, episode_id)
            rows = db.execute(
                "SELECT name,data FROM task_capability_instances WHERE episode=? ORDER BY name",
                (episode_id,)).fetchall()
            instances = [self._checked_tool_instance(db, episode_id, row[0], row[1])
                         for row in rows]
        return [item for item in instances if item["status"] == "active"] if active_only else instances

    def mount_tool_definition(self, episode_id, definition_id, *, expected_revision=None):
        """Activate one previously staged definition at a serial Episode point."""
        from .capability_authority import require_definition_authorized
        definition = self.tool_definition(definition_id)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            episode = self._get(db, episode_id)
            if episode["status"] in {"completed", "cancelled", "failed"}:
                raise PermissionError("Terminal Episode cannot mount a tool")
            authority = episode["task"].get("capability_authority")
            if authority is None or definition["origin_episode_id"] != episode_id:
                raise PermissionError("Tool instance is outside its creator Episode")
            require_definition_authorized(
                authority, definition["kind"], definition["effect_class"],
                definition["declared_operations"], definition["credential_handles"])
            if definition["runtime"] != authority["runtime"]:
                raise PermissionError("Tool runtime exceeds Episode authority")
            if definition["name"] in episode["capabilities"]:
                raise PermissionError("Task-authored tool cannot shadow an installed grant")
            row = db.execute(
                "SELECT data FROM task_capability_instances WHERE episode=? AND name=?",
                (episode_id, definition["name"])).fetchone()
            previous = (self._checked_tool_instance(db, episode_id, definition["name"], row[0])
                        if row else None)
            current_revision = previous["revision"] if previous else 0
            if expected_revision is not None and expected_revision != current_revision:
                raise StateConflict("Tool instance revision changed")
            if previous and previous["status"] == "active":
                if previous["definition_id"] == definition_id:
                    return previous
                raise StateConflict("An active tool name must be released before replacement")
            now = time.time()
            instance = {
                "schema": "nexgent.capability-instance.v1", "episode_id": episode_id,
                "name": definition["name"], "definition_id": definition_id,
                "definition_digest": definition["digest"], "authority_digest": authority["digest"],
                "status": "active", "revision": current_revision + 1,
                "created_at": previous["created_at"] if previous else now,
                "updated_at": now,
            }
            instance["record_digest"] = _digest(instance)
            db.execute("INSERT OR REPLACE INTO task_capability_instances VALUES(?,?,?)",
                       (episode_id, definition["name"], _json(instance)))
            self._event(db, episode_id, "capability_instance_mounted", {
                "name": definition["name"], "definition_id": definition_id,
                "definition_digest": definition["digest"],
                "authority_digest": authority["digest"], "revision": instance["revision"],
                "record_digest": instance["record_digest"],
            })
        return instance

    def release_tool_instance(self, episode_id, name, *, expected_revision):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self._get(db, episode_id)
            row = db.execute(
                "SELECT data FROM task_capability_instances WHERE episode=? AND name=?",
                (episode_id, name)).fetchone()
            if row is None:
                raise KeyError(name)
            instance = self._checked_tool_instance(db, episode_id, name, row[0])
            if instance["revision"] != expected_revision:
                raise StateConflict("Tool instance revision changed")
            if instance["status"] != "active":
                return instance
            instance.update(status="released", revision=instance["revision"] + 1,
                            updated_at=time.time())
            instance["record_digest"] = _digest({
                key: value for key, value in instance.items() if key != "record_digest"})
            db.execute("UPDATE task_capability_instances SET data=? WHERE episode=? AND name=?",
                       (_json(instance), episode_id, name))
            self._event(db, episode_id, "capability_instance_released", {
                "name": name, "definition_id": instance["definition_id"],
                "revision": instance["revision"], "record_digest": instance["record_digest"],
            })
        return instance

    @staticmethod
    def _event(db, episode_id, kind, data):
        EpisodeStore._get(db, episode_id)
        row = db.execute("SELECT sequence,digest FROM task_events WHERE episode=? ORDER BY sequence DESC LIMIT 1",
                         (episode_id,)).fetchone()
        sequence, previous = (row[0] + 1, row[1]) if row else (1, "genesis")
        created = time.time()
        record = {"episode_id": episode_id, "sequence": sequence, "kind": kind, "created": created,
                  "content": deepcopy(data), "previous": previous}
        record["digest"] = _digest(record)
        db.execute("INSERT INTO task_events VALUES(?,?,?,?,?,?,?)",
                   (episode_id, sequence, kind, created, _json(data), previous, record["digest"]))
        return record

    def event(self, episode_id, kind, data):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            return self._event(db, episode_id, kind, data)

    def capability_lease(self, episode_id, name):
        with self.connect() as db:
            self._get(db, episode_id)
            row = db.execute(
                "SELECT data FROM task_capability_leases WHERE episode=? AND name=?",
                (episode_id, name)).fetchone()
        return json.loads(row[0]) if row else None

    def capability_leases(self, episode_id, *, active_only=False):
        with self.connect() as db:
            self._get(db, episode_id)
            rows = db.execute(
                "SELECT data FROM task_capability_leases WHERE episode=? ORDER BY name",
                (episode_id,)).fetchall()
        leases = [json.loads(row[0]) for row in rows]
        return [row for row in leases if row["status"] == "active"] if active_only else leases

    def mount_capability(self, episode_id, descriptor, *, expected_revision=None):
        """Atomically grant a frozen host tool inside an immutable Episode ceiling."""
        if (not isinstance(descriptor, dict) or not isinstance(descriptor.get("name"), str)
                or not descriptor["name"] or descriptor.get("digest") != _digest(
                    {key: value for key, value in descriptor.items() if key != "digest"})):
            raise ValueError("Capability descriptor identity is invalid")
        name = descriptor["name"]
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            state = self._get(db, episode_id)
            if state["task"].get("capability_mode") != "leased":
                raise PermissionError("Episode does not use capability leases")
            if state["status"] not in {"ready", "paused", "waiting_input"}:
                raise PermissionError("Capability leases change only while an Episode is stopped")
            if name not in state["capabilities"]:
                raise PermissionError("Capability is outside the Episode's frozen ceiling")
            bound = db.execute(
                "SELECT descriptor FROM task_delegated_capability_bounds "
                "WHERE episode=? AND name=?", (episode_id, name)).fetchone()
            if (bound is None and state["parent_episode_id"] is not None
                    and self._get(db, state["parent_episode_id"])["task"].get(
                        "capability_mode") == "leased"):
                raise PermissionError("Delegated capability has no frozen parent bound")
            if bound is not None and json.loads(bound[0]) != descriptor:
                raise PermissionError("Delegated handler differs from the parent lease")
            row = db.execute(
                "SELECT data FROM task_capability_leases WHERE episode=? AND name=?",
                (episode_id, name)).fetchone()
            previous = json.loads(row[0]) if row else None
            if previous is not None:
                if previous["descriptor"] != descriptor:
                    raise PermissionError("Cannot rebind a frozen capability lease")
                if previous["status"] == "active":
                    if expected_revision is not None and expected_revision != previous["revision"]:
                        raise StateConflict("Capability lease revision changed")
                    return previous
                if expected_revision != previous["revision"]:
                    raise StateConflict("Capability lease revision changed")
            elif expected_revision is not None:
                raise StateConflict("Capability lease does not have the expected revision")
            self._check_capability_admission(db, state, descriptor)
            now = time.time()
            record = {"episode_id": episode_id, "name": name, "status": "active",
                      "revision": previous["revision"] + 1 if previous else 1,
                      "descriptor": deepcopy(descriptor),
                      "created_at": previous["created_at"] if previous else now,
                      "updated_at": now}
            db.execute("INSERT OR REPLACE INTO task_capability_leases VALUES(?,?,?)",
                       (episode_id, name, _json(record)))
            self._event(db, episode_id, "capability_mounted",
                        {"name": name, "revision": record["revision"],
                         "descriptor_digest": descriptor["digest"]})
            return record

    def release_capability(self, episode_id, name, *, expected_revision):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            state = self._get(db, episode_id)
            if state["status"] not in {"ready", "paused", "waiting_input", "completed", "failed", "cancelled"}:
                raise PermissionError("Capability release requires a stopped Episode")
            row = db.execute(
                "SELECT data FROM task_capability_leases WHERE episode=? AND name=?",
                (episode_id, name)).fetchone()
            if row is None:
                raise KeyError(name)
            record = json.loads(row[0])
            if record["revision"] != expected_revision:
                raise StateConflict("Capability lease revision changed")
            if record["status"] == "released":
                return record
            record.update(status="released", revision=record["revision"] + 1,
                          updated_at=time.time())
            db.execute("UPDATE task_capability_leases SET data=? WHERE episode=? AND name=?",
                       (_json(record), episode_id, name))
            self._event(db, episode_id, "capability_released",
                        {"name": name, "revision": record["revision"],
                         "descriptor_digest": record["descriptor"]["digest"]})
            return record

    def events(self, episode_id):
        with self.connect() as db:
            self._get(db, episode_id)
            return [{"episode_id": episode_id, "sequence": r[0], "kind": r[1], "created": r[2],
                     "content": json.loads(r[3]), "previous": r[4], "digest": r[5]} for r in db.execute(
                "SELECT sequence,kind,created,data,previous,digest FROM task_events WHERE episode=? ORDER BY sequence",
                (episode_id,))]

    @contextmanager
    def lock(self, episode_id):
        if not re.fullmatch(r"episode-[a-f0-9]{16}", episode_id):
            raise ValueError("Invalid Episode identity")
        self.get(episode_id)
        with (self.root / (episode_id + ".lock")).open("a+b") as handle:
            handle.seek(0, 2)
            if not handle.tell():
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                yield
            finally:
                handle.seek(0)
                if os.name == "nt":
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def reserve_model(self, root_episode_id, receipt):
        receipt = deepcopy(receipt)
        usage = receipt.get("usage", {})
        if not isinstance(usage, dict):
            raise ValueError("Model usage must be a reported usage map")
        for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
            if key in usage and (type(usage[key]) is not int or usage[key] < 0):
                raise ValueError("Reported token usage must be nonnegative integers")
        call_id = receipt.get("call_id", receipt.get("id"))
        if not isinstance(call_id, str) or not call_id:
            raise ValueError("Missing model request identity")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            account = self._get(db, root_episode_id)
            root_id = account["root_episode_id"]
            account = self._get(db, root_id)
            row = db.execute("SELECT root_id,data FROM task_calls WHERE id=?", (call_id,)).fetchone()
            if row:
                if row[0] != root_id:
                    raise PermissionError("Model request belongs to a different budget account")
                old = json.loads(row[1])
                for key in ("request_digest", "model", "role"):
                    if key in old and key in receipt and receipt[key] != old[key]:
                        raise ValueError("Model receipt changes request identity")
                if old["status"] not in {"started", "reserved"} and receipt.get("status") != old["status"]:
                    raise ValueError("A terminal model receipt cannot return to an earlier state")
                for key, value in (old.get("usage") or {}).items():
                    if key in {"prompt_tokens", "completion_tokens", "total_tokens"} and usage.get(key, value) < value:
                        raise ValueError("Reported model usage cannot be refunded")
                merged = {**old, **receipt}
                merged["usage"] = {**(old.get("usage") or {}), **usage}
                merged["reserved_completion_tokens"] = old["reserved_completion_tokens"]
                db.execute("UPDATE task_calls SET data=? WHERE id=?", (_json(merged), call_id))
            else:
                if receipt.get("status") not in {"started", "reserved"}:
                    raise ValueError("A model request must reserve budget before its outcome")
                reserve = receipt.get("reserved_completion_tokens", receipt.get("max_tokens", receipt.get("max_completion_tokens")))
                if type(reserve) is not int or reserve <= 0:
                    raise ValueError("Missing positive completion token reservation")
                calls = [json.loads(r[0]) for r in db.execute("SELECT data FROM task_calls WHERE root_id=?", (root_id,))]
                if len(calls) >= account["budget"]["max_model_calls"]:
                    raise BudgetExhausted("Root Episode model-call budget exhausted")
                consumed = sum(max(c["reserved_completion_tokens"], (c.get("usage") or {}).get("completion_tokens", 0)) for c in calls)
                if consumed + reserve > account["budget"]["max_completion_tokens"]:
                    raise BudgetExhausted("Root Episode completion-token budget exhausted")
                receipt["call_id"] = call_id
                receipt["reserved_completion_tokens"] = reserve
                receipt.setdefault("usage", {})
                receipt.setdefault("billing_status", "unknown")
                db.execute("INSERT INTO task_calls VALUES(?,?,?)", (call_id, root_id, _json(receipt)))
            self._event(db, root_episode_id, "model", receipt)
        return self.calls(root_id)

    def calls(self, root_id):
        with self.connect() as db:
            root_id = self._get(db, root_id)["root_episode_id"]
            return [json.loads(r[0]) for r in db.execute("SELECT data FROM task_calls WHERE root_id=? ORDER BY rowid", (root_id,))]

    def _reserve_resource(self, episode_id, identity, kind, data):
        if not isinstance(identity, str) or not identity:
            raise ValueError("Resource reservation requires a stable identity")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            episode = self._get(db, episode_id)
            root_id = episode["root_episode_id"]
            root = self._get(db, root_id)
            old = db.execute("SELECT data FROM task_resources WHERE episode=? AND kind=? AND identity=?",
                             (episode_id, kind, identity)).fetchone()
            if old:
                if json.loads(old[0])["data"] != data:
                    raise ValueError("Resource reservation changes request identity")
                return json.loads(old[0])
            count = db.execute("SELECT COUNT(*) FROM task_resources WHERE root_id=? AND kind=?", (root_id, kind)).fetchone()[0]
            if count >= root["budget"]["max_tool_calls" if kind == "tool" else "max_nodes"]:
                raise BudgetExhausted(f"Root Episode {kind} budget exhausted")
            if kind == "tool":
                dynamic = data.get("dynamic_capability")
                if dynamic is not None:
                    if (not isinstance(dynamic, dict)
                            or set(dynamic) != {"name", "definition_id", "definition_digest",
                                                "instance_revision", "authority_digest"}):
                        raise ValueError("Dynamic tool reservation identity is invalid")
                    authority = episode["task"].get("capability_authority")
                    row = db.execute(
                        "SELECT data FROM task_capability_instances WHERE episode=? AND name=?",
                        (episode_id, dynamic["name"])).fetchone()
                    instance = (self._checked_tool_instance(
                        db, episode_id, dynamic["name"], row[0]) if row else None)
                    if (authority is None or instance is None
                            or instance["status"] != "active"
                            or instance["definition_id"] != dynamic["definition_id"]
                            or instance["definition_digest"] != dynamic["definition_digest"]
                            or instance["revision"] != dynamic["instance_revision"]
                            or instance["authority_digest"] != authority["digest"]
                            or dynamic["authority_digest"] != authority["digest"]):
                        raise PermissionError("Dynamic tool instance or authority changed")
                    count_dynamic = 0
                    for stored, in db.execute(
                            "SELECT data FROM task_resources WHERE episode=? AND kind='tool'",
                            (episode_id,)):
                        if json.loads(stored).get("data", {}).get("dynamic_capability"):
                            count_dynamic += 1
                    if count_dynamic >= authority["max_invocations"]:
                        raise BudgetExhausted("Episode dynamic-tool invocation limit exhausted")
                accounting = data.get("work_accounting")
                if (not isinstance(accounting, dict)
                        or accounting.get("schema") != "nexgent.tool-work.v1"
                        or set(accounting) != {"schema", "reserved_work_units"}
                        or type(accounting.get("reserved_work_units")) is not int
                        or accounting["reserved_work_units"] < 0):
                    raise ValueError("Tool work reservation is invalid")
                charged = 0
                for stored, in db.execute(
                        "SELECT data FROM task_resources WHERE root_id=? AND kind='tool'",
                        (root_id,)):
                    prior = json.loads(stored).get("data", {}).get("work_accounting", {})
                    charged += prior.get("charged_work_units",
                                         prior.get("reserved_work_units", 0))
                if (charged + accounting["reserved_work_units"]
                        > root["budget"].get("max_tool_work_units", 0)):
                    raise BudgetExhausted("Root Episode tool-work budget exhausted")
            record = {"episode_id": episode_id, "root_episode_id": root_id, "id": identity,
                      "kind": kind, "status": "reserved", "created_at": time.time(), "data": deepcopy(data)}
            db.execute("INSERT INTO task_resources VALUES(?,?,?,?,?)",
                       (episode_id, identity, root_id, kind, _json(record)))
            self._event(db, episode_id, kind + "_admitted", record)
            return record

    def reserve_tool(self, episode_id, call_id, data=None, *, reserved_work_units=0):
        if type(reserved_work_units) is not int or reserved_work_units < 0:
            raise ValueError("Tool work reservation must be a nonnegative integer")
        data = deepcopy(data or {})
        if "work_accounting" in data:
            raise ValueError("Tool work accounting is host-owned")
        data["work_accounting"] = {
            "schema": "nexgent.tool-work.v1",
            "reserved_work_units": reserved_work_units,
        }
        return self._reserve_resource(episode_id, call_id, "tool", data)

    def add_tool_work(self, episode_id, call_id, units):
        """Durably charge positive work while a trusted tool is executing."""
        if type(units) is not int or units <= 0:
            raise ValueError("Tool work increments must be positive integers")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            episode = self._get(db, episode_id)
            row = db.execute(
                "SELECT data FROM task_resources WHERE episode=? AND kind='tool' AND identity=?",
                (episode_id, call_id)).fetchone()
            if not row:
                raise KeyError(call_id)
            record = json.loads(row[0])
            if record.get("status") != "reserved":
                raise ValueError("Terminal tool work cannot be changed")
            accounting = record.get("data", {}).get("work_accounting")
            if (not isinstance(accounting, dict)
                    or accounting.get("schema") != "nexgent.tool-work.v1"):
                raise ValueError("Tool work reservation is unavailable")
            previous = accounting.get("measured_work_units", 0)
            if type(previous) is not int or previous < 0:
                raise ValueError("Stored tool work is invalid")
            proposed = previous + units
            root_id = episode["root_episode_id"]
            root = self._get(db, root_id)
            other = 0
            for stored_identity, stored in db.execute(
                    "SELECT identity,data FROM task_resources WHERE root_id=? AND kind='tool'",
                    (root_id,)):
                if stored_identity == call_id and json.loads(stored).get("episode_id") == episode_id:
                    continue
                prior = json.loads(stored).get("data", {}).get("work_accounting", {})
                other += prior.get("charged_work_units",
                                   prior.get("reserved_work_units", 0))
            charged = max(accounting["reserved_work_units"], proposed)
            if other + charged > root["budget"].get("max_tool_work_units", 0):
                raise BudgetExhausted("Root Episode tool-work budget exhausted")
            accounting["measured_work_units"] = proposed
            accounting["charged_work_units"] = charged
            record["data"]["work_accounting"] = accounting
            db.execute(
                "UPDATE task_resources SET data=? WHERE episode=? AND kind='tool' AND identity=?",
                (_json(record), episode_id, call_id))
            self._event(db, episode_id, "tool_work_charged", {
                "call_id": call_id, "increment": units,
                "measured_work_units": proposed, "charged_work_units": charged,
            })
        return deepcopy(accounting)

    def settle_tool(self, episode_id, call_id, *, status):
        """Finalize one tool meter; an absent settlement remains fail-closed."""
        if status not in {"completed", "failed"}:
            raise ValueError("Tool settlement status is invalid")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self._get(db, episode_id)
            row = db.execute(
                "SELECT data FROM task_resources WHERE episode=? AND kind='tool' AND identity=?",
                (episode_id, call_id)).fetchone()
            if not row:
                raise KeyError(call_id)
            record = json.loads(row[0])
            accounting = record.get("data", {}).get("work_accounting")
            if (not isinstance(accounting, dict)
                    or accounting.get("schema") != "nexgent.tool-work.v1"):
                raise ValueError("Tool work reservation is unavailable")
            if record.get("status") in {"completed", "failed"}:
                if record["status"] != status:
                    raise ValueError("Terminal tool settlement cannot change status")
                return deepcopy(accounting)
            if record.get("status") != "reserved":
                raise ValueError("Tool reservation status is invalid")
            measured = accounting.get("measured_work_units", 0)
            accounting.update(
                measured_work_units=measured,
                charged_work_units=max(accounting["reserved_work_units"], measured),
                usage_complete=True,
            )
            record["status"] = status
            record["finished_at"] = time.time()
            record["data"]["work_accounting"] = accounting
            db.execute(
                "UPDATE task_resources SET data=? WHERE episode=? AND kind='tool' AND identity=?",
                (_json(record), episode_id, call_id))
            self._event(db, episode_id, "tool_work_settled", {
                "call_id": call_id, "status": status,
                "reserved_work_units": accounting["reserved_work_units"],
                "measured_work_units": measured,
                "charged_work_units": accounting["charged_work_units"],
            })
        return deepcopy(accounting)

    def reserve_node(self, episode_id, node_id, data=None):
        return self._reserve_resource(episode_id, node_id, "node", data or {})

    def usage(self, root_id):
        calls = self.calls(root_id)
        root_id = self.get(root_id)["root_episode_id"]
        with self.connect() as db:
            resources = dict(db.execute("SELECT kind,COUNT(*) FROM task_resources WHERE root_id=? GROUP BY kind", (root_id,)))
            tool_resources = [json.loads(row[0]) for row in db.execute(
                "SELECT data FROM task_resources WHERE root_id=? AND kind='tool' ORDER BY rowid",
                (root_id,))]
        missing = [c["call_id"] for c in calls if any(name not in (c.get("usage") or {})
                   for name in ("prompt_tokens", "completion_tokens", "total_tokens"))]
        tool_missing = []
        reserved_tool_work = charged_tool_work = measured_tool_work = 0
        for resource in tool_resources:
            accounting = resource.get("data", {}).get("work_accounting")
            if not isinstance(accounting, dict):
                # Historical receipts predate work metering and are an explicit
                # zero baseline rather than fabricated numerical work.
                continue
            reserved = accounting.get("reserved_work_units")
            measured = accounting.get("measured_work_units")
            if (type(reserved) is not int or reserved < 0
                    or measured is not None and (type(measured) is not int or measured < 0)):
                tool_missing.append(f"{resource['episode_id']}/{resource['id']}")
                continue
            reserved_tool_work += reserved
            charged_tool_work += accounting.get("charged_work_units", reserved)
            if accounting.get("usage_complete") is True and measured is not None:
                measured_tool_work += measured
            else:
                tool_missing.append(f"{resource['episode_id']}/{resource['id']}")
        known = {name: sum((c.get("usage") or {}).get(name, 0) for c in calls)
                 for name in ("prompt_tokens", "completion_tokens", "total_tokens")}
        return {"model_calls": len(calls), "reserved_completion_tokens": sum(c["reserved_completion_tokens"] for c in calls),
                "charged_completion_tokens": sum(max(c["reserved_completion_tokens"], (c.get("usage") or {}).get("completion_tokens", 0)) for c in calls),
                "completion_tokens": None if missing else known["completion_tokens"], "known_usage": known,
                "usage_missing_call_ids": missing,
                "tool_usage_missing_call_ids": tool_missing,
                "reserved_tool_work_units": reserved_tool_work,
                "charged_tool_work_units": charged_tool_work,
                "tool_work_units": None if tool_missing else measured_tool_work,
                "usage_complete": not missing and not tool_missing,
                "billing_unknown_call_ids": [c["call_id"] for c in calls if c.get("billing_status") != "usage_reported"],
                "tool_calls": resources.get("tool", 0), "nodes": resources.get("node", 0)}

    def once(self, episode_id, key):
        """Atomically consume a root-scoped tool marker, including after restart.

        The caller supplies its tool namespace in the key (for example,
        ``workbench.fail_once:join``); descendants share the same namespace.
        """
        if not isinstance(key, str) or not key or len(key) > 1000:
            raise ValueError("Once keys require nonempty text within 1000 characters")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            root_id = self._get(db, episode_id)["root_episode_id"]
            if db.execute("SELECT 1 FROM task_once WHERE root_id=? AND identity=?", (root_id, key)).fetchone():
                return False
            if db.execute("SELECT COUNT(*) FROM task_once WHERE root_id=?", (root_id,)).fetchone()[0] >= 1000:
                raise BudgetExhausted("Root Episode once-marker limit exhausted")
            db.execute("INSERT INTO task_once VALUES(?,?,?,?)", (root_id, key, episode_id, time.time()))
            return True

    @staticmethod
    def _scope(episode, namespace=None, split=None):
        context = episode["task"].get("context", {})
        actual_namespace = context.get("memory_namespace", "default")
        actual_split = context.get("split", "development")
        if namespace is not None and namespace != actual_namespace:
            raise PermissionError("Memory namespace is fixed by the task context")
        if split is not None and split != actual_split:
            raise PermissionError("Memory split is fixed by the task context")
        return actual_namespace, actual_split

    def publish(self, episode_id, content, schema_ref="json", media_type="application/json", *,
                node_id=None, attempt_id=None, package_digest=None, input_refs=None, scope="episode", name=None,
                validation=None):
        if scope not in {"episode", "tree", "root", "public"}:
            raise ValueError("Unsupported artifact visibility scope")
        episode = self.get(episode_id)
        package_digest = package_digest or episode["package_digest"]
        if package_digest != episode["package_digest"]:
            raise PermissionError("Artifact producer package differs from its Episode")
        refs = list(input_refs or [])
        for ref in refs:
            self.read(ref, episode_id)
        namespace, split = self._scope(episode)
        binary = isinstance(content, bytes)
        stored = base64.b64encode(content).decode("ascii") if binary else deepcopy(content)
        validation = deepcopy(validation or {"schema_status": "unchecked"})
        if (not isinstance(validation, dict)
                or validation.get("schema_status") not in {"unchecked", "passed", "failed"}):
            raise ValueError("Artifact validation requires an explicit schema status")
        artifact = {"id": _id("artifact"), "schema_ref": schema_ref, "media_type": media_type,
                    "content": stored, "encoding": "base64" if binary else "json",
                    "content_digest": hashlib.sha256(content).hexdigest() if binary else _digest(content),
                    "producer": {"episode_id": episode_id, "node_id": node_id, "attempt_id": attempt_id,
                                 "package_digest": package_digest}, "input_artifact_refs": refs,
                    "created_at": time.time(), "visibility_scope": "tree" if scope == "root" else scope,
                    "namespace": namespace, "split": split, "name": name,
                    "validation": validation}
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("INSERT INTO task_artifacts VALUES(?,?,?,?)",
                       (artifact["id"], episode_id, episode["root_episode_id"], _json(artifact)))
            self._event(db, episode_id, "artifact_published", {k: v for k, v in artifact.items() if k != "content"})
        return self.read(artifact["id"], episode_id)

    def read(self, ref, episode_id, schema_ref=None):
        identity = ref["id"] if isinstance(ref, dict) else ref
        with self.connect() as db:
            episode = self._get(db, episode_id)
            row = db.execute("SELECT episode,root_id,data FROM task_artifacts WHERE id=?", (identity,)).fetchone()
        if not row:
            raise KeyError(identity)
        artifact = json.loads(row[2])
        namespace, split = self._scope(episode)
        if (artifact["namespace"], artifact["split"]) != (namespace, split):
            raise PermissionError("Artifact crosses a task information boundary")
        scope = artifact["visibility_scope"]
        if scope == "episode" and row[0] != episode_id:
            raise PermissionError("Artifact belongs to a different Episode")
        if scope == "tree" and row[1] != episode["root_episode_id"]:
            raise PermissionError("Artifact belongs to a different Episode tree")
        if schema_ref is not None and schema_ref != artifact["schema_ref"]:
            raise ValueError("Artifact type does not match the requested input port")
        if artifact["encoding"] == "base64":
            artifact["content"] = base64.b64decode(artifact["content"], validate=True)
            actual = hashlib.sha256(artifact["content"]).hexdigest()
        else:
            actual = _digest(artifact["content"])
        if actual != artifact["content_digest"]:
            raise ValueError("Artifact content integrity mismatch")
        return artifact

    def artifacts(self, episode_id):
        self.get(episode_id)
        with self.connect() as db:
            identities = [r[0] for r in db.execute("SELECT id FROM task_artifacts WHERE episode=? ORDER BY rowid", (episode_id,))]
        return [self.read(identity, episode_id) for identity in identities]

    def remember(self, episode_id, content, *, namespace=None, split=None, kind="experience", evidence_refs=None, status="candidate"):
        episode = self.get(episode_id)
        namespace, split = self._scope(episode, namespace, split)
        if split == "final_holdout":
            raise PermissionError("Final holdout Episodes cannot write back memory")
        if status != "candidate":
            raise PermissionError("Task-generated memories are candidate claims")
        if kind not in {"experience", "procedure", "factual_note", "preference"}:
            raise ValueError("Unknown memory kind")
        refs = list(evidence_refs or [])
        for ref in refs:
            self.read(ref, episode_id)
        item = {"id": _id("memory"), "version": 1, "kind": kind, "content": deepcopy(content),
                "evidence_refs": refs, "source_episode_refs": [episode_id], "status": status,
                "namespace": namespace, "split": split, "created_at": time.time()}
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("INSERT INTO task_memory VALUES(?,?,?,?)", (item["id"], namespace, split, _json(item)))
            self._event(db, episode_id, "memory_remembered", {"id": item["id"], "version": 1, "status": status})
        return item

    def search(self, episode_id, query="", *, namespace=None, split=None, limit=10):
        if not isinstance(query, str) or type(limit) is not int or not 0 <= limit <= 100:
            raise ValueError("Memory query requires text and a limit between 0 and 100")
        episode = self.get(episode_id)
        namespace, split = self._scope(episode, namespace, split)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = [json.loads(r[0]) for r in db.execute("SELECT data FROM task_memory WHERE namespace=? AND split=? ORDER BY rowid DESC",
                                                       (namespace, split))]
            terms = query.casefold().split()
            # Unreviewed claims remain visible to their producing Episode for
            # explicit snapshot/audit work, but never seed a later Episode.
            items = [r for r in rows if (r["status"] == "accepted"
                     or (r["status"] == "candidate" and episode_id in r["source_episode_refs"])) and
                     all(term in _json(r["content"]).casefold() for term in terms)][:limit]
            trace = {"id": _id("retrieval"), "episode_id": episode_id, "query": query,
                     "namespace": namespace, "split": split, "limit": limit, "created_at": time.time(),
                     "item_version_refs": [{"id": r["id"], "version": r["version"]} for r in items],
                     "retrieval_policy_digest": _digest({"kind": "literal-all-terms", "version": 1})}
            db.execute("INSERT INTO task_retrievals VALUES(?,?,?)", (trace["id"], episode_id, _json(trace)))
            self._event(db, episode_id, "memory_retrieved", trace)
        return items

    def retrievals(self, episode_id):
        self.get(episode_id)
        with self.connect() as db:
            return [json.loads(r[0]) for r in db.execute("SELECT data FROM task_retrievals WHERE episode=? ORDER BY rowid", (episode_id,))]

    def snapshot(self, episode_id, items=None, *, query="", namespace=None, split=None):
        episode = self.get(episode_id)
        namespace, split = self._scope(episode, namespace, split)
        if items is None:
            items = self.search(episode_id, query, namespace=namespace, split=split)
        selected = [{"id": i["id"], "version": i["version"]} for i in items]
        traces = self.retrievals(episode_id)
        available = {(r["id"], r["version"]) for trace in traces for r in trace["item_version_refs"]}
        if any((r["id"], r["version"]) not in available for r in selected):
            raise PermissionError("A snapshot can only include actually retrieved memory versions")
        for item in items:
            if (item["namespace"], item["split"]) != (namespace, split):
                raise PermissionError("Snapshot memory crosses task information boundaries")
        # Freeze the stored versions, never trust a caller's replacement content
        # merely because its item identity appeared in a retrieval trace.
        frozen = []
        with self.connect() as db:
            for item in items:
                row = db.execute("SELECT data FROM task_memory WHERE id=?", (item["id"],)).fetchone()
                if not row or _json(item) != row[0]:
                    raise ValueError("Snapshot item content does not match its immutable stored version")
                frozen.append(json.loads(row[0]))
        snapshot = {"id": _id("snapshot"), "episode_id": episode_id, "item_version_refs": selected,
                    "items": frozen,
                    "retrieval_refs": [t["id"] for t in traces], "query": query, "namespace": namespace,
                    "split": split, "retrieval_policy_digest": _digest({"kind": "literal-all-terms", "version": 1}),
                    "created_at": time.time()}
        snapshot["digest"] = _digest(snapshot)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("INSERT INTO task_snapshots VALUES(?,?,?)", (snapshot["id"], episode_id, _json(snapshot)))
            self._event(db, episode_id, "memory_snapshot", snapshot)
        return snapshot

    def memory_snapshot(self, snapshot_id, episode_id):
        with self.connect() as db:
            self._get(db, episode_id)
            row = db.execute("SELECT episode,data FROM task_snapshots WHERE id=?", (snapshot_id,)).fetchone()
        if not row:
            raise KeyError(snapshot_id)
        if row[0] != episode_id:
            raise PermissionError("Memory snapshot belongs to a different Episode")
        snapshot = json.loads(row[1])
        expected = snapshot.pop("digest", None)
        if expected != _digest(snapshot):
            raise ValueError("Memory snapshot integrity mismatch")
        snapshot["digest"] = expected
        return snapshot

    def rpc_find(self, episode_id, call_path, request=None):
        with self.connect() as db:
            self._get(db, episode_id)
            row = db.execute("SELECT data FROM task_rpc WHERE episode=? AND call_path=?", (episode_id, call_path)).fetchone()
        if not row:
            return None
        record = json.loads(row[0])
        if request is not None and record["request_digest"] != _digest(request):
            raise ValueError("Replay key reused with a different request digest")
        return record

    def rpc_under(self, episode_id, call_path_prefix):
        """Return host RPC records below one composite call path."""
        if (not isinstance(call_path_prefix, str) or not call_path_prefix
                or len(call_path_prefix) > 1000):
            raise ValueError("RPC call_path prefix must be nonempty bounded text")
        with self.connect() as db:
            self._get(db, episode_id)
            rows = db.execute(
                "SELECT call_path,data FROM task_rpc WHERE episode=? ORDER BY call_path",
                (episode_id,),
            ).fetchall()
        return [json.loads(data) for call_path, data in rows
                if call_path.startswith(call_path_prefix)]

    def rpc_start(self, episode_id, call_path, request):
        if not isinstance(call_path, str) or not call_path or len(call_path) > 1000:
            raise ValueError("RPC call_path must be nonempty text within 1000 characters")
        request_digest = _digest(request)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self._get(db, episode_id)
            row = db.execute("SELECT data FROM task_rpc WHERE episode=? AND call_path=?", (episode_id, call_path)).fetchone()
            if row:
                record = json.loads(row[0])
                if record["request_digest"] != request_digest:
                    raise ValueError("Replay key reused with a different request digest")
                if record["status"] == "started":
                    raise RecoveryRequired("RPC was started without a durable outcome; automatic repetition refused")
                return record
            record = {"episode_id": episode_id, "call_path": call_path, "request_digest": request_digest,
                      "request": deepcopy(request), "status": "started", "started_at": time.time(),
                      "result": None, "error": None}
            db.execute("INSERT INTO task_rpc VALUES(?,?,?)", (episode_id, call_path, _json(record)))
            self._event(db, episode_id, "rpc_started", {"call_path": call_path, "request_digest": request_digest})
            return record

    def rpc_finish(self, episode_id, call_path, *, result=None, error=None):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self._get(db, episode_id)
            row = db.execute("SELECT data FROM task_rpc WHERE episode=? AND call_path=?", (episode_id, call_path)).fetchone()
            if not row:
                raise ValueError("RPC outcome has no admitted request")
            record = json.loads(row[0])
            if record["status"] != "started":
                if record["result"] != result or record["error"] != error:
                    raise ValueError("Cannot overwrite a terminal RPC outcome")
                return record
            record.update(status="failed" if error is not None else "completed", result=deepcopy(result),
                          error=deepcopy(error), finished_at=time.time())
            db.execute("UPDATE task_rpc SET data=? WHERE episode=? AND call_path=?", (_json(record), episode_id, call_path))
            self._event(db, episode_id, "rpc_finished", {"call_path": call_path, "status": record["status"]})
            return record
