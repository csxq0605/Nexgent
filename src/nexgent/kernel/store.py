"""One transactional ledger for research, source, calls, measurements and evidence."""

from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from .programs import canonical, digest, verify_bundle


class BudgetExhausted(RuntimeError):
    pass


class Store:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "research.sqlite3"
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS studies(id TEXT PRIMARY KEY, updated REAL, state TEXT);
                CREATE TABLE IF NOT EXISTS bundles(id TEXT PRIMARY KEY, digest TEXT, data TEXT);
                CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    study TEXT, kind TEXT, created REAL, data TEXT, previous TEXT, digest TEXT);
                CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, study TEXT, data TEXT);
                CREATE TABLE IF NOT EXISTS measurements(key TEXT PRIMARY KEY, data TEXT);
                CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, media_type TEXT, content BLOB);
            """)

    def connect(self):
        return sqlite3.connect(self.path, timeout=30)

    def save(self, state):
        with self.connect() as db:
            db.execute("INSERT INTO studies VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,state=excluded.state",
                       (state["id"], time.time(), canonical(state)))

    def get(self, study_id):
        with self.connect() as db:
            row = db.execute("SELECT state FROM studies WHERE id=?", (study_id,)).fetchone()
        if not row:
            raise KeyError(study_id)
        return json.loads(row[0])

    def list(self):
        with self.connect() as db:
            return [json.loads(row[0]) for row in db.execute("SELECT state FROM studies ORDER BY updated DESC")]

    def put_bundle(self, bundle):
        verify_bundle(bundle)
        with self.connect() as db:
            if bundle.get("parent_id"):
                parent = db.execute("SELECT data FROM bundles WHERE id=?", (bundle["parent_id"],)).fetchone()
                if not parent:
                    raise ValueError("Source parent must be stored before its descendant")
                if bundle["generation"] != json.loads(parent[0])["generation"] + 1:
                    raise ValueError("Source generation does not follow its parent")
            row = db.execute("SELECT data FROM bundles WHERE id=?", (bundle["id"],)).fetchone()
            if row and json.loads(row[0])["files"] != bundle["files"]:
                raise ValueError("Cannot overwrite immutable source")
            db.execute("INSERT OR IGNORE INTO bundles VALUES(?,?,?)", (bundle["id"], bundle["digest"], canonical(bundle)))

    def bundle(self, bundle_id):
        with self.connect() as db:
            row = db.execute("SELECT data FROM bundles WHERE id=?", (bundle_id,)).fetchone()
        if not row:
            raise KeyError(bundle_id)
        bundle = json.loads(row[0]); verify_bundle(bundle)
        return bundle

    def event(self, study_id, kind, content):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT digest FROM events WHERE study=? ORDER BY sequence DESC LIMIT 1", (study_id,)).fetchone()
            previous = row[0] if row else "genesis"
            created = time.time()
            identity = digest({"study": study_id, "kind": kind, "time": created, "content": content, "previous": previous})
            cursor = db.execute("INSERT INTO events(study,kind,created,data,previous,digest) VALUES(?,?,?,?,?,?)",
                                (study_id, kind, created, canonical(content), previous, identity))
            return {"sequence": cursor.lastrowid, "kind": kind, "created": created,
                    "content": content, "previous": previous, "digest": identity}

    def events(self, study_id):
        with self.connect() as db:
            return [{"sequence": r[0], "kind": r[1], "created": r[2], "content": json.loads(r[3]),
                     "previous": r[4], "digest": r[5]} for r in db.execute(
                         "SELECT sequence,kind,created,data,previous,digest FROM events WHERE study=? ORDER BY sequence", (study_id,))]

    def reserve(self, study_id, receipt):
        call_id = receipt.get("call_id", receipt.get("id"))
        if not call_id:
            raise ValueError("Missing model request identity")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            found = db.execute("SELECT data FROM calls WHERE id=? AND study=?", (call_id, study_id)).fetchone()
            if not found:
                if receipt["status"] not in {"started", "reserved"}:
                    raise ValueError("A model request must reserve its budget first")
                state = json.loads(db.execute("SELECT state FROM studies WHERE id=?", (study_id,)).fetchone()[0])
                calls = [json.loads(r[0]) for r in db.execute("SELECT data FROM calls WHERE study=?", (study_id,))]
                if len(calls) >= state["budget"]["max_model_calls"]:
                    raise BudgetExhausted("The study's model-call budget is exhausted")
                used = sum(r.get("reserved_completion_tokens", r.get("max_tokens", 0)) for r in calls)
                reserve = receipt.get("reserved_completion_tokens", receipt.get("max_tokens", 0))
                if type(reserve) is not int or reserve <= 0:
                    raise ValueError("Missing declared completion token reservation")
                if used + reserve > state["budget"]["max_completion_tokens"]:
                    raise BudgetExhausted("The study's reserved completion-token budget is exhausted")
                db.execute("INSERT INTO calls VALUES(?,?,?)", (call_id, study_id, canonical(receipt)))
            else:
                previous = json.loads(found[0])
                merged = {**previous, **receipt}
                # A terminal receipt cannot lower the original reservation.
                merged["reserved_completion_tokens"] = previous.get("reserved_completion_tokens", previous.get("max_tokens", 0))
                db.execute("UPDATE calls SET data=? WHERE id=?", (canonical(merged), call_id))
        self.event(study_id, "model", receipt)

    def calls(self, study_id):
        with self.connect() as db:
            return [json.loads(r[0]) for r in db.execute("SELECT data FROM calls WHERE study=? ORDER BY rowid", (study_id,))]

    def measurement(self, key, value=None):
        with self.connect() as db:
            if value is not None:
                db.execute("INSERT OR IGNORE INTO measurements VALUES(?,?)", (key, canonical(value)))
            row = db.execute("SELECT data FROM measurements WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def artifact(self, content, media_type="application/json"):
        if isinstance(content, str):
            content = content.encode()
        identity = __import__("hashlib").sha256(content).hexdigest()
        with self.connect() as db:
            db.execute("INSERT OR IGNORE INTO artifacts VALUES(?,?,?)", (identity, media_type, content))
        return identity

    @contextmanager
    def lock(self, study_id):
        if not re.fullmatch(r"study-[a-f0-9]{16}", study_id):
            raise ValueError("Invalid study identity")
        with (self.root / f"{study_id}.lock").open("a+b") as handle:
            handle.seek(0, 2)
            if not handle.tell():
                handle.write(b"0"); handle.flush()
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
