"""Release source/offspring evidence without provider bodies or credentials.

Example (read-only; no controller, model gateway, or evaluation is invoked):
  python scripts/build_framework_evidence.py --root . --study study-... \
      --meta study-... --baseline docs/research/build-validation-....json \
      --output docs/research/framework-evidence.json

Study/meta arguments accept ledger IDs or controller-export JSON paths. Ledger
artifacts supplement referenced source and reports omitted from older exports.
Running, ready, and paused studies are refused. Failed terminal studies remain.
Use --self-test before data are complete; it never releases a real study.
"""
from __future__ import annotations

import argparse
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ID = re.compile(r"agent-[a-f0-9]{20}\Z")
STUDY_ID = re.compile(r"study-[a-f0-9]{16}\Z")
SECRET_KEY = re.compile(r"(?:^|_)(?:api_?key|password|secret|access_token|auth_token|authorization|credential)(?:$|_)", re.I)
TOKEN = re.compile(r"\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b")
LOCAL_PATH = re.compile(r"(?<![\w])(?:[A-Za-z]:[\\/][^\s\"'<>]+|\\\\[A-Za-z0-9._-]+[\\/][A-Za-z0-9._-][^\s\"'<>]*)|(?<![:\w])/(?:home|Users|tmp|var|mnt|workspace|workspaces|opt|private)(?:/[^\s\"'<>]*)?")
BLOCKED = {"model_configuration", "profiles", "providers", "base_url", "endpoint", "api_url", "headers", "api_key", "apikey", "token", "password", "secret", "authorization", "request", "response", "request_options", "messages", "prompt", "input", "output", "input_text", "output_text", "request_body", "response_body", "request_payload", "response_payload", "executable", "cwd", "project_root", "export_path", "artifact_path", "local_path"}
CALL_FIELDS = {"call_id", "role", "model", "status", "billing_status", "request_digest", "started_at", "finished_at", "elapsed_seconds", "finish_reason", "max_tokens", "max_completion_tokens", "reserved_completion_tokens", "usage", "error_type", "request_wall_timeout_seconds", "input_characters"}
ARTIFACT_EVENTS = {"offspring_generated", "improver_probe", "measurement"}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def strings(value):
    """Inspect decoded strings; JSON-escaped `if q:\\n` is not a drive path."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, child in value.items():
            yield str(key)
            yield from strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from strings(child)


def read_json(path):
    data = Path(path).read_bytes()
    def reject(value):
        raise ValueError("Nonfinite JSON is not releasable")
    return json.loads(data.decode("utf-8-sig"), parse_constant=reject), hashlib.sha256(data).hexdigest()


def sensitive_values(root):
    """Inspect local settings solely to reject literal credential/endpoint bytes."""
    env, values = {}, set()
    dotenv = root / ".env"
    if dotenv.is_file():
        for line in dotenv.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.removeprefix("export ").split("=", 1)
            env[key.strip()] = value.strip().strip("\"'")
    env.update(os.environ)
    for key, value in env.items():
        if (SECRET_KEY.search(key) or key.endswith("BASE_URL")) and isinstance(value, str) and len(value) >= 8:
            values.add(value)
    def visit(data):
        if isinstance(data, dict):
            for key, value in data.items():
                if isinstance(value, str) and (SECRET_KEY.search(key) or key.lower() in {"base_url", "endpoint", "api_url"}):
                    if value.startswith("${") and value.endswith("}"):
                        value = env.get(value[2:-1], "")
                    if len(value) >= 8:
                        values.add(value)
                visit(value)
        elif isinstance(data, list):
            for value in data:
                visit(value)
    for path in (root / "models.json", root / ".nexgent/models.json"):
        if path.is_file():
            visit(read_json(path)[0])
    return values


class Ledger:
    """Read-only snapshot; fetch only IDs referenced by the supplied studies."""
    def __init__(self, root):
        path = root / ".nexgent/research/research.sqlite3"
        self.db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True) if path.is_file() else None
        if self.db:
            self.db.execute("BEGIN")

    def close(self):
        if self.db:
            self.db.close()

    def value(self, table, key, column="data"):
        if not self.db:
            return None
        if (table, column) not in {("bundles", "data"), ("artifacts", "content"), ("studies", "state")}:
            raise ValueError("Unsupported ledger lookup")
        row = self.db.execute(f"SELECT {column} FROM {table} WHERE id=?", (key,)).fetchone()
        if not row:
            return None
        if table == "artifacts":
            raw = row[0].encode() if isinstance(row[0], str) else row[0]
            if hashlib.sha256(raw).hexdigest() != key:
                raise ValueError("Referenced immutable artifact failed its content hash")
        try:
            return json.loads(row[0])
        except (UnicodeError, ValueError, TypeError):
            raise ValueError("Referenced JSON ledger artifact is not readable") from None

    def study(self, identity):
        state = self.value("studies", identity, "state")
        if state is None:
            raise ValueError("Requested study is unavailable in the read-only ledger")
        state["calls"] = [json.loads(row[0]) for row in self.db.execute("SELECT data FROM calls WHERE study=? ORDER BY rowid", (identity,))]
        state["events"] = [{"sequence": row[0], "kind": row[1], "created": row[2], "content": json.loads(row[3]), "previous": row[4], "digest": row[5]} for row in self.db.execute("SELECT sequence,kind,created,data,previous,digest FROM events WHERE study=? ORDER BY sequence", (identity,))]
        return {"schema": "nexgent-study-v1", "study": state, "bundles": [], "improver_probes": []}


class Serializer:
    def __init__(self, ledger=None, sensitive=()):
        self.ledger = ledger
        self.sensitive = sorted(set(sensitive), key=len, reverse=True)
        self.bundles, self.components, self.calls, self.artifacts = {}, {}, {}, {}
        self.source_submissions = {}
        self.referenced_sources, self.redactions, self.missing_artifacts = set(), Counter(), set()

    def text(self, value):
        for secret in self.sensitive:
            if secret in value:
                value = value.replace(secret, "[redacted-sensitive-value]")
                self.redactions["sensitive_value"] += 1
        value, count = TOKEN.subn("[redacted-credential-pattern]", value)
        self.redactions["credential_pattern"] += count
        value, count = LOCAL_PATH.subn("[redacted-local-path]", value)
        self.redactions["local_path"] += count
        if SOURCE_ID.fullmatch(value):
            self.referenced_sources.add(value)
        return value

    def bundle(self, value, scope):
        files = value["files"]
        if not isinstance(files, dict) or not files or not all(isinstance(k, str) and isinstance(v, str) for k, v in files.items()):
            raise ValueError("Malformed source bundle")
        calculated = digest(files)
        identity = "agent-" + digest({"source": calculated, "parent": value.get("parent_id")})[:20]
        if value.get("digest") != calculated or value.get("id") != identity or value.get("component_digests") != {name: digest(source) for name, source in files.items()}:
            raise ValueError("Source bundle identity failed verification")
        if identity in self.bundles:
            if scope not in self.bundles[identity]["observed_in"]:
                self.bundles[identity]["observed_in"].append(scope)
            return {"bundle_ref": identity, "source_digest": calculated}
        references = {}
        for name, source in files.items():
            # Redacting executable source would silently change its identity.
            # Refuse a release if exact source contains credentials/local paths.
            if self.text(source) != source or name not in {"task.py", "meta.py", "workflow.py", "roles.json"}:
                raise ValueError("Retained source contains sensitive material; review locally before release")
            sha = hashlib.sha256(source.encode()).hexdigest()
            self.components[sha] = source
            references[name] = sha
        self.bundles[identity] = {"id": identity, "digest": calculated, "parent_id": value.get("parent_id"), "generation": value.get("generation"), "component_digests": value["component_digests"], "component_text_sha256": references, "observed_in": [scope]}
        if value.get("parent_id"):
            self.referenced_sources.add(value["parent_id"])
        self.bundles[identity]["rationale"] = self.clean(value.get("rationale", ""), scope)
        self.bundles[identity]["provenance"] = self.clean(value.get("provenance", {}), scope)
        return {"bundle_ref": identity, "source_digest": calculated}

    def call(self, value, scope, owner=None):
        identity = value.get("call_id")
        if not isinstance(identity, str) or not identity:
            raise ValueError("Model receipt has no stable call identity")
        safe = {key: self.clean(value[key], scope) for key in CALL_FIELDS if key in value}
        row = self.calls.setdefault(identity, {"call_id": identity, "ledger_study_id": None, "references": [], "receipt": safe, "receipt_variants_sha256": []})
        if scope not in row["references"]:
            row["references"].append(scope)
        sha = digest(safe)
        if sha not in row["receipt_variants_sha256"]:
            row["receipt_variants_sha256"].append(sha)
        if owner:
            if row["ledger_study_id"] not in (None, owner):
                raise ValueError("One model call is claimed by two study ledgers")
            row["ledger_study_id"] = owner
            row["receipt"] = safe
        elif row["ledger_study_id"] is None:
            terminal = {"received", "failed", "invalid", "token_budget_exhausted", "interrupted", "cancelled"}
            if safe.get("status") in terminal or row["receipt"].get("status") not in terminal:
                row["receipt"] = safe
        reserve = max(row.get("reserved_completion_tokens", 0), value.get("reserved_completion_tokens", value.get("max_tokens", 0)) or 0)
        row["reserved_completion_tokens"] = reserve
        return {"call_ref": identity}

    def submitted_files(self, files, scope):
        """Retain source submitted for testing, without claiming it was valid."""
        identity = digest(files)
        if identity not in self.source_submissions:
            references = {}
            for name, source in files.items():
                if self.text(source) != source or self.text(name) != name:
                    raise ValueError("Submitted source contains sensitive material; review locally before release")
                sha = hashlib.sha256(source.encode()).hexdigest()
                self.components[sha] = source
                references[name] = sha
            self.source_submissions[identity] = {
                "files_digest": identity, "component_digests": {name: digest(source) for name, source in files.items()},
                "component_text_sha256": references, "observed_in": [],
                "scope": "Exact submitted file replacements; this record alone does not establish valid source, an accepted candidate, or a successful execution.",
            }
        if scope not in self.source_submissions[identity]["observed_in"]:
            self.source_submissions[identity]["observed_in"].append(scope)
        return {"source_submission_ref": identity}

    def load_artifact(self, identity, scope):
        if not isinstance(identity, str) or not re.fullmatch(r"[a-f0-9]{64}", identity):
            raise ValueError("Referenced experiment artifact has an invalid identity")
        if identity in self.artifacts:
            return
        artifact = self.ledger.value("artifacts", identity, "content") if self.ledger else None
        if artifact is None:
            self.missing_artifacts.add(identity)
        else:
            self.artifacts[identity] = None
            self.artifacts[identity] = self.clean(artifact, scope + "/artifact/" + identity)

    def clean(self, value, scope):
        if isinstance(value, dict):
            if {"id", "digest", "files", "component_digests"} <= value.keys() and SOURCE_ID.fullmatch(str(value["id"])):
                return self.bundle(value, scope)
            if "call_id" in value and any(key in value for key in ("usage", "reserved_completion_tokens", "billing_status", "request_digest")):
                return self.call(value, scope)
            out, omitted = {}, {}
            for key, child in value.items():
                key_text = str(key)
                if key_text == "files" and isinstance(child, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in child.items()):
                    out[key_text] = self.submitted_files(child, scope)
                    continue
                if key_text.lower() in BLOCKED or SECRET_KEY.search(key_text):
                    omitted[key_text] = digest(child)
                    self.redactions["excluded_field"] += 1
                    if key_text.lower() == "model_configuration":
                        out["model_configuration_digest"] = digest(child)
                    continue
                if key_text.lower() in {"path", "url"} and isinstance(child, str) and child.startswith("/"):
                    out[key_text] = "[redacted-local-path]"
                    continue
                out[self.text(key_text)] = self.clean(child, scope)
                if key_text == "proposal_artifact":
                    self.load_artifact(child, scope + "/invalid_proposal")
            if omitted:
                out["excluded_field_digests"] = omitted
            return out
        if isinstance(value, list):
            return [self.clean(child, scope) for child in value]
        if isinstance(value, str):
            return self.text(value)
        return value

    def event(self, event, scope):
        row = {key: event[key] for key in ("sequence", "kind", "created", "previous", "digest") if key in event}
        content = event.get("content", {})
        if event["kind"] in {"model", "capability", "agent_log"}:
            keep = {key: content[key] for key in ("id", "call_id", "claimed_kind", "source_bundle", "method", "status", "error_type", "elapsed_seconds", "depends_on", "input_artifact_ids", "output_artifact_ids") if key in content}
            row["content"] = self.clean(keep, scope)
            row["original_content_digest"] = digest(content)
            row["body_omitted"] = True
            # These are local source experiments, not model API bodies. Invalid
            # source can fail before a bundle or measurement is ever recorded.
            if event["kind"] == "capability" and content.get("method") in {"experiment", "probe_improver"}:
                request = content.get("request", {})
                if isinstance(request, dict):
                    selected = {key: request[key] for key in ("files", "label") if key in request}
                    row["content"]["source_experiment_submission"] = self.clean(selected, scope + "/" + str(content.get("id", "experiment")))
                if "result" in content:
                    row["content"]["source_experiment_result"] = self.clean(content["result"], scope)
        else:
            row["content"] = self.clean(content, scope)
        if event["kind"] in ARTIFACT_EVENTS and content.get("artifact"):
            self.load_artifact(content["artifact"], scope + "/" + event["kind"])
        return row

    def finish_sources(self):
        visited = set()
        while self.referenced_sources - self.bundles.keys() - visited:
            for identity in sorted(self.referenced_sources - self.bundles.keys() - visited):
                visited.add(identity)
                value = self.ledger.value("bundles", identity) if self.ledger else None
                if value:
                    self.bundle(value, "referenced_source")
        missing = sorted(self.referenced_sources - self.bundles.keys())
        if missing:
            raise ValueError("Referenced source bundles are missing; provide the matching --root ledger (count=" + str(len(missing)) + ")")
        for bundle in self.bundles.values():
            parent = bundle.get("parent_id")
            if parent and bundle.get("generation") != self.bundles[parent].get("generation", 0) + 1:
                raise ValueError("Source generations do not follow the recorded parent chain")


def verify_events(study_id, events):
    previous, last_sequence = "genesis", -1
    for event in events:
        expected = digest({"study": study_id, "kind": event["kind"], "time": event["created"], "content": event["content"], "previous": previous})
        if event.get("previous") != previous or event.get("digest") != expected or event["sequence"] <= last_sequence:
            raise ValueError("Original study event chain failed verification")
        previous, last_sequence = expected, event["sequence"]


def model_costs(calls):
    rows = list(calls.values())
    totals, missing = {}, {}
    for field in ("prompt_tokens", "completion_tokens", "total_tokens"):
        totals[field] = 0
        missing[field] = []
        for row in rows:
            value = (row["receipt"].get("usage") or {}).get(field)
            if type(value) in (int, float) and math.isfinite(value) and value >= 0:
                totals[field] += value
            else:
                missing[field].append(row["call_id"])
    return {"unique_model_calls": len(rows), "reserved_completion_tokens": sum(row["reserved_completion_tokens"] for row in rows), "known_usage": totals, "usage_missing_call_ids_by_field": missing,
            "status_counts": dict(Counter(row["receipt"].get("status", "unknown") for row in rows)),
            "unassigned_call_ids": [row["call_id"] for row in rows if row["ledger_study_id"] is None],
            "accounting": "Calls deduplicated by call_id. Probe calls already belong to their source-study ledger; embedded meta reports do not add a second charge. Monetary cost is unavailable."}


def domain_work_accounting(studies, artifacts):
    """Explain existing cost receipts without reclassifying their measurements."""
    reports, artifact_refs = {}, {}
    def collect(value, artifact_id=None):
        if isinstance(value, dict):
            key = value.get("measurement_key")
            if isinstance(key, str) and isinstance(value.get("execution"), dict):
                old = reports.get(key, {})
                old_label = old.get("execution", {}).get("work_units_status", old.get("work_units_status"))
                new_label = value["execution"].get("work_units_status", value.get("work_units_status"))
                if key not in reports or new_label is not None or old_label is None:
                    reports[key] = value
                if artifact_id:
                    artifact_refs.setdefault(key, set()).add(artifact_id)
            for child in value.values():
                collect(child, artifact_id)
        elif isinstance(value, list):
            for child in value:
                collect(child, artifact_id)
    collect(studies)
    for identity, artifact in artifacts.items():
        collect(artifact, identity)
    rows = {}
    for study in studies:
        admitted = study.get("admitted_measurements", {})
        keys = set(admitted)
        keys.update(event.get("content", {}).get("key") for event in study.get("events", []) if event.get("kind") in {"measurement", "measurement_reused"})
        bounds = []
        for key in sorted(keys - {None}):
            report = reports.get(key, {})
            execution = report.get("execution", {})
            status = execution.get("work_units_status", report.get("work_units_status"))
            if status != "reserved_upper_bound_actual_usage_unavailable":
                continue
            charge = admitted.get(key, {})
            bounds.append({
                "measurement_key": key, "artifact_refs": sorted(artifact_refs.get(key, set())),
                "bundle_id": report.get("bundle_id", execution.get("bundle_id")),
                "measurement_status": report.get("status"), "failure_kind": report.get("failure_kind"),
                "work_units_status": status, "reported_measurement_work_units": report.get("work_units"),
                "reported_source_execution_work_units": execution.get("work_units"),
                "ledger_logical_charge": charge.get("work_units"),
                "ledger_physical_charge": charge.get("physical_work_units"), "reused": charge.get("reused"),
            })
        known_charges = [row["ledger_physical_charge"] for row in bounds if type(row["ledger_physical_charge"]) in (int, float)]
        rows[study["id"]] = {
            "benchmark": study.get("benchmark", study.get("benchmark_id")),
            "evaluation_count": study.get("evaluation_count"),
            "logical_work_units": study.get("numeric_work_units"),
            "physical_work_units": study.get("physical_numeric_work_units"),
            "reported_physical_work_units": study.get("physical_numeric_work_units"),
            "reported_physical_interpretation": "Ledger charges for uncached measurements. These may include reserved upper bounds when execution receipts are unavailable; this counter is not uniformly measured operations.",
            "upper_bound_measurement_ids": [row["measurement_key"] for row in bounds],
            "upper_bound_measurements": bounds,
            "upper_bound_known_ledger_physical_charge": sum(known_charges),
            "upper_bound_unknown_charge_measurement_ids": [row["measurement_key"] for row in bounds if type(row["ledger_physical_charge"]) not in (int, float)],
            "measurement_ids_without_execution_receipt_in_release": sorted(key for key in keys - {None} if key not in reports),
        }
    return {"by_study": rows, "accounting": "Recorded study-level charges, not a sum of nested reports. Existing work_units and scientific results are unchanged. Explicit conservative-upper-bound receipts are listed by measurement identity; their actual operations remain unavailable. Different benchmark work units are not added together. Missing counters remain null."}


def build(payloads, *, ledger=None, sensitive=(), baselines=()):
    serializer = Serializer(ledger, sensitive)
    studies, inputs = [], []
    identities = set()
    # Register authoritative ledger receipts first so embedded copies cannot
    # replace terminal usage or assign meta-study cost to the originating study.
    for payload, provenance, category in payloads:
        state = payload.get("study", {})
        if payload.get("schema") != "nexgent-study-v1" or not STUDY_ID.fullmatch(state.get("id", "")):
            raise ValueError("Use a controller study export or a valid study ID")
        if state["status"] not in {"completed", "failed"}:
            raise ValueError("Refusing a nonterminal study; no partial result artifact was written")
        if state.get("kind") == "benchmark_evaluation":
            raise ValueError("Fixed benchmark validation belongs in --baseline, not the RSI study list")
        if category == "meta" and state.get("kind") != "meta_evaluation":
            raise ValueError("--meta requires an independent meta-study ledger")
        if state["id"] in identities:
            raise ValueError("Duplicate study input")
        identities.add(state["id"])
        verify_events(state["id"], state.get("events", []))
        for call in state.get("calls", []):
            if call.get("status") in {"started", "reserved", "running"} and state["status"] == "completed":
                raise ValueError("A completed study still has an unterminated model request")
            serializer.call(call, state["id"] + "/ledger", owner=state["id"])
    for payload, provenance, category in payloads:
        state = payload["study"]
        scope = state["id"]
        for bundle in payload.get("bundles", []):
            serializer.bundle(bundle, scope)
        clean = serializer.clean({key: value for key, value in state.items() if key not in {"events", "calls"}}, scope)
        clean["calls"] = [{"call_ref": call["call_id"]} for call in state.get("calls", [])]
        clean["events"] = [serializer.event(event, scope) for event in state.get("events", [])]
        clean["improver_probes"] = serializer.clean(payload.get("improver_probes", []), scope + "/probes")
        implementation = payload.get("implementation")
        if implementation is None and ledger and state.get("implementation_artifact"):
            implementation = ledger.value("artifacts", state["implementation_artifact"], "content")
        if implementation is not None:
            clean["implementation_snapshot_digest"] = digest(implementation)
            clean["implementation_files"] = {name: hashlib.sha256(source.encode()).hexdigest() for name, source in implementation.get("files", {}).items()}
            clean["implementation_versions"] = serializer.clean(implementation.get("versions", {}), scope)
            benchmark_snapshot = implementation.get("benchmark", {}).get("snapshot", {})
            clean["benchmark_snapshot_digest"] = digest(benchmark_snapshot)
        clean["release_category"] = category
        studies.append(clean)
        inputs.append({"study_id": scope, "category": category, **serializer.clean(provenance, scope)})
    serializer.finish_sources()
    if serializer.missing_artifacts:
        raise ValueError("Referenced experiment artifacts are missing; supply the matching read-only --root ledger")
    expected_meta = {identity for study in studies for identity in study.get("conclusion", {}).get("meta_evaluations", {})}
    expected_meta |= {study.get("conclusion", {}).get("meta_study_id") for study in studies}
    if expected_meta - identities - {None}:
        raise ValueError("Origin study links conditional meta studies not supplied through --meta")
    per_study = {identity: model_costs({key: row for key, row in serializer.calls.items() if row["ledger_study_id"] == identity}) for identity in sorted(identities)}
    output = {
        "schema": "nexgent-framework-evidence-v1", "serializer_revision": 2, "created_at": datetime.now(timezone.utc).isoformat(),
        "scope": "Recorded source execution, development probes, conditional independent meta evaluation, and observed failures; no universal or statistically established RSI claim is inferred.",
        "inputs": inputs, "studies": studies,
        "source_bundles": sorted(serializer.bundles.values(), key=lambda row: (row.get("generation", 0), row["id"])),
        "source_components_by_sha256": serializer.components, "experiment_artifacts": serializer.artifacts,
        "source_submissions_by_digest": serializer.source_submissions,
        "model_calls_by_id": serializer.calls, "model_costs": {"all_supplied_studies": model_costs(serializer.calls), "by_study": per_study},
        "domain_work_accounting": domain_work_accounting(studies, serializer.artifacts),
        "fixed_baseline_validations": [],
        "integrity": {"source_identities_verified": True, "original_event_chains_verified_before_redaction": True, "original_event_digests_retained": True, "event_bodies_redacted": True, "missing_referenced_sources": [], "missing_experiment_artifacts": [],
                      "redaction_counts": dict(serializer.redactions), "literal_sensitive_value_matches_in_release": 0,
                      "limits": ["Original event hashes reference private full ledger bodies; redacted events alone do not verify that original chain", "Core/plugin implementation is identified by snapshots and file hashes; executable agent source is preserved exactly", "A failed study remains a failed observation; missing scores and unknown usage are not zero-filled", "Only supplied studies and their referenced immutable artifacts are included"]},
    }
    # Baselines have their own validation purpose and costs. Never merge their
    # calls with evolutionary or independent meta-study totals.
    for value, provenance in baselines:
        if value.get("schema") == "nexgent-study-v1":
            value = value["study"]
        if value.get("kind") not in {"benchmark_evaluation", None} and value.get("schema") != "nexgent-build-validation-v1":
            raise ValueError("Unsupported fixed-baseline receipt")
        safe_fields = {key: item for key, item in value.items() if key in {"schema", "study_id", "id", "kind", "status", "benchmark_id", "seeds", "split", "score", "groups", "tasks", "source", "source_process", "source_tool_receipts", "usage", "work_accounting", "algorithm_task_failures", "task_count", "missing_seeds", "unknown_work_seeds", "implementation_digest", "evaluator_digest", "registration_digest", "full_export_sha256", "benchmark_evaluation", "conclusion", "summary", "native_split", "previous_failed_study_preserved", "model_calls", "model_tokens", "rsi_effect", "purpose", "recorded_at"}}
        if "content_digest" in value:
            safe_fields["original_receipt_content_digest"] = value["content_digest"]
        baseline_serializer = Serializer(sensitive=sensitive)
        receipt = baseline_serializer.clean(safe_fields, "fixed_baseline")
        output["fixed_baseline_validations"].append({"receipt": receipt, "input": baseline_serializer.clean(provenance, "fixed_baseline"), "included_in_research_model_totals": False,
                                                   "model_calls_by_id": baseline_serializer.calls,
                                                   "source_bundles": list(baseline_serializer.bundles.values()),
                                                   "source_components_by_sha256": baseline_serializer.components,
                                                   "source_submissions_by_digest": baseline_serializer.source_submissions})
    serialized = canonical(output)
    if any(secret in serialized for secret in sensitive) or any(TOKEN.search(text) or LOCAL_PATH.search(text) or any(secret in text for secret in sensitive) for text in strings(output)):
        raise ValueError("Final sensitive-byte/path scan failed; no output was written")
    output["content_digest"] = digest(output)
    return output


def self_test():
    files = {"task.py": "def solve(problem, tools):\n    return {'answer': 1}\n", "meta.py": "def improve(context, broker):\n    return {'candidates': []}\n"}
    source = digest(files)
    bundle = {"id": "agent-" + digest({"source": source, "parent": None})[:20], "digest": source, "parent_id": None, "generation": 0, "files": files, "component_digests": {name: digest(text) for name, text in files.items()}}
    secret = "fixture-private-value-0123456789"
    call = {"call_id": "fixture-call", "status": "received", "reserved_completion_tokens": 20, "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}, "output_text": secret, "request": {"api_key": secret}}
    probe = {"schema": "nexgent-improver-probe-v1", "status": "incomplete", "artifacts": {bundle["id"]: bundle}, "costs": {"calls": [call]}, "failures": [{"message": "fixture C:\\private\\data.json " + secret}], "aggregate": {"paired_development_gain": None}, "evaluations": {"fixture": {"status": "missing", "score": None}}}
    payload = {"schema": "nexgent-study-v1", "study": {"id": "study-" + "1" * 16, "status": "completed", "initial_program": bundle["id"], "active_program": bundle["id"], "research_program": bundle["id"], "calls": [call], "events": [], "model_configuration": {"profiles": {"x": {"base_url": "https://endpoint.invalid/v1"}}}}, "bundles": [bundle], "improver_probes": [probe]}
    result = build([(payload, {"source": "fixture"}, "source")], sensitive=[secret, "https://endpoint.invalid/v1"])
    assert result["model_costs"]["all_supplied_studies"]["unique_model_calls"] == 1
    assert result["model_costs"]["all_supplied_studies"]["known_usage"]["total_tokens"] == 5
    assert result["studies"][0]["improver_probes"][0]["aggregate"]["paired_development_gain"] is None
    assert secret not in canonical(result) and "endpoint.invalid" not in canonical(result) and "private\\\\data" not in canonical(result)
    assert len(result["source_bundles"]) == 1 and len(result["source_components_by_sha256"]) == 2
    # Preserve a generated descendant even when it never entered the archive.
    # A failed independent meta experiment keeps its missing effect and is
    # charged only through its own call ledger, although the origin embeds it.
    child_files = {**files, "task.py": "def solve(problem, tools):\n    q = problem\n    if q:\n        return {'answer': 2}\n"}
    child_sha = digest(child_files)
    child = {"id": "agent-" + digest({"source": child_sha, "parent": bundle["id"]})[:20], "digest": child_sha, "parent_id": bundle["id"], "generation": 1, "files": child_files, "component_digests": {name: digest(text) for name, text in child_files.items()}}
    meta_call = {"call_id": "fixture-meta-call", "status": "failed", "error_type": "FixtureTransportError", "reserved_completion_tokens": 30, "usage": {}}
    meta_id = "study-" + "2" * 16
    meta = {"schema": "nexgent-study-v1", "study": {"id": meta_id, "kind": "meta_evaluation", "status": "failed", "calls": [meta_call], "events": [], "meta_evaluation": {"status": "incomplete", "aggregate": {"gain": None}, "artifacts": {child["id"]: child}, "costs": {"calls": [meta_call]}}}, "bundles": [bundle]}
    origin = deepcopy(payload)
    origin["study"]["conclusion"] = {"meta_study_id": meta_id, "meta_evaluation": meta["study"]["meta_evaluation"]}
    fixed = {"kind": "benchmark_evaluation", "status": "completed", "summary": {"mean_score": 1}, "benchmark_evaluation": {"calls": [{**call, "call_id": "fixed-call"}]}, "usage": {"model_calls": 1}}
    expanded = build([(origin, {}, "source"), (meta, {}, "meta")], sensitive=[secret], baselines=[(fixed, {})])
    assert len(expanded["source_bundles"]) == 2
    assert child_files["task.py"] in expanded["source_components_by_sha256"].values()
    assert expanded["model_costs"]["all_supplied_studies"]["unique_model_calls"] == 2
    assert expanded["model_costs"]["all_supplied_studies"]["known_usage"]["total_tokens"] == 5
    assert expanded["model_costs"]["by_study"][meta_id]["unique_model_calls"] == 1
    assert expanded["model_costs"]["all_supplied_studies"]["usage_missing_call_ids_by_field"]["total_tokens"] == ["fixture-meta-call"]
    assert expanded["studies"][1]["status"] == "failed" and expanded["studies"][1]["meta_evaluation"]["aggregate"]["gain"] is None
    assert expanded["fixed_baseline_validations"][0]["included_in_research_model_totals"] is False
    assert "fixed-call" in expanded["fixed_baseline_validations"][0]["model_calls_by_id"]
    assert "fixed-call" not in expanded["model_calls_by_id"]
    assert not LOCAL_PATH.search("def f():\n    if q:\n        return 1")
    assert not LOCAL_PATH.search(r'{"prompt": "two\\nnewlines"}')
    assert LOCAL_PATH.search(r"\\server\share\private.txt") and LOCAL_PATH.search("/home/private/file")
    # A rejected proposal and an unsuccessful development submission are real
    # source evidence even when neither was admitted into the bundle table.
    invalid_files = {"task.py": "def solve(:\n    return 0\n"}
    proposal = {"files": invalid_files, "hypothesis": "fixture invalid candidate", "rationale": "retain rejected code"}
    proposal_id = digest(proposal)
    offspring = {"candidates": [], "failures": [{"type": "invalid_source", "error": "SyntaxError", "proposal_artifact": proposal_id}]}
    offspring_id = digest(offspring)
    records = {proposal_id: proposal, offspring_id: offspring}
    class FixtureLedger:
        def value(self, table, key, column="data"):
            return records.get(key) if table == "artifacts" else None
    attempted = deepcopy(payload)
    previous = "genesis"
    event_content = [
        ("capability", {"id": "fixture-rpc", "method": "experiment", "source_bundle": bundle["id"], "status": "failed", "error_type": "ValueError", "request": {"files": invalid_files, "label": "invalid development trial"}}),
        ("offspring_generated", {"artifact": offspring_id, "candidate_ids": []}),
    ]
    for sequence, (kind, content) in enumerate(event_content, 1):
        sha = digest({"study": attempted["study"]["id"], "kind": kind, "time": sequence, "content": content, "previous": previous})
        attempted["study"]["events"].append({"sequence": sequence, "kind": kind, "created": sequence, "content": content, "previous": previous, "digest": sha})
        previous = sha
    retained = build([(attempted, {}, "source")], ledger=FixtureLedger(), sensitive=[secret])
    assert len(retained["source_bundles"]) == 1
    assert len(retained["source_submissions_by_digest"]) == 1
    assert invalid_files["task.py"] in retained["source_components_by_sha256"].values()
    assert proposal_id in retained["experiment_artifacts"]
    assert retained["studies"][0]["events"][0]["content"]["status"] == "failed"
    assert retained["studies"][0]["events"][0]["content"]["source_experiment_submission"]["files"]["source_submission_ref"] == digest(invalid_files)
    upper_report = {"measurement_key": "fixture-reserved", "bundle_id": bundle["id"], "status": "partial_failure", "score": 0,
                    "work_units": 20000000, "execution": {"work_units": 17000000, "work_units_status": "reserved_upper_bound_actual_usage_unavailable"}}
    upper_state = {"id": payload["study"]["id"], "numeric_work_units": 20000000, "physical_numeric_work_units": 20000000,
                   "admitted_measurements": {"fixture-reserved": {"work_units": 20000000, "physical_work_units": 20000000, "reused": False}}}
    # A compact repeated report must not erase the full receipt's upper-bound marker.
    compact = {**upper_report, "execution": {"work_units": 17000000}}
    accounting = domain_work_accounting([upper_state], {"upper-artifact": upper_report, "compact-artifact": compact})["by_study"][upper_state["id"]]
    assert accounting["reported_physical_work_units"] == 20000000
    assert accounting["upper_bound_measurement_ids"] == ["fixture-reserved"]
    assert accounting["upper_bound_known_ledger_physical_charge"] == 20000000
    assert accounting["upper_bound_measurements"][0]["reported_source_execution_work_units"] == 17000000
    assert accounting["upper_bound_measurements"][0]["work_units_status"] == "reserved_upper_bound_actual_usage_unavailable"
    assert upper_report["score"] == 0 and upper_report["work_units"] == 20000000
    for change in ("running", "paused", "ready"):
        changed = deepcopy(payload); changed["study"]["status"] = change
        try:
            build([(changed, {}, "source")])
        except ValueError:
            pass
        else:
            raise AssertionError("Nonterminal input was accepted")
    broken = deepcopy(payload); broken["bundles"][0]["digest"] = "wrong"
    invalid_chain = deepcopy(payload)
    invalid_chain["study"]["events"] = [{"sequence": 1, "kind": "fixture", "created": 1, "content": {}, "previous": "genesis", "digest": "wrong"}]
    for bad in (broken, invalid_chain):
        try:
            build([(bad, {}, "source")])
        except ValueError:
            pass
        else:
            raise AssertionError("Tampered source or event chain was accepted")
    private_files = {**files, "task.py": "# " + secret + "\n" + files["task.py"]}
    private_digest = digest(private_files)
    private_bundle = {**bundle, "id": "agent-" + digest({"source": private_digest, "parent": None})[:20], "digest": private_digest, "files": private_files, "component_digests": {name: digest(text) for name, text in private_files.items()}}
    try:
        Serializer(sensitive=[secret]).bundle(private_bundle, "fixture")
    except ValueError:
        pass
    else:
        raise AssertionError("Sensitive exact source was silently altered or published")
    print(canonical({"status": "serializer_self_test_passed", "real_studies_read": 0, "model_calls": 0, "result_artifacts_written": 0}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--study", nargs="+", default=[])
    parser.add_argument("--meta", nargs="*", default=[])
    parser.add_argument("--baseline", nargs="*", default=[])
    parser.add_argument("--output", type=Path)
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    if not args.study or (not args.output and not args.check_only):
        parser.error("Supply --study and --output, or use --check-only/--self-test")
    ledger = Ledger(args.root.resolve())
    try:
        inputs = []
        for category, values in (("source", args.study), ("meta", args.meta)):
            for value in values:
                if STUDY_ID.fullmatch(value):
                    payload = ledger.study(value)
                    provenance = {"source": "read_only_ledger", "input_snapshot_digest": digest(payload)}
                else:
                    path = Path(value)
                    payload, sha = read_json(path)
                    provenance = {"source": "controller_export", "filename": path.name, "file_sha256": sha}
                inputs.append((payload, provenance, category))
        baselines = []
        for value in args.baseline:
            payload, sha = read_json(value)
            baselines.append((payload, {"filename": Path(value).name, "file_sha256": sha}))
        output = build(inputs, ledger=ledger, sensitive=sensitive_values(args.root.resolve()), baselines=baselines)
        if not args.check_only:
            if args.output.exists():
                raise ValueError("Refusing to overwrite an existing evidence release")
            args.output.parent.mkdir(parents=True, exist_ok=True)
            with args.output.open("x", encoding="utf-8") as handle:
                handle.write(json.dumps(output, ensure_ascii=False, allow_nan=False, indent=1))
        print(canonical({"status": "validated_without_publication" if args.check_only else "evidence_written", "studies": len(output["studies"]), "source_bundles": len(output["source_bundles"]), "calls": output["model_costs"]["all_supplied_studies"]["unique_model_calls"], "content_digest": output["content_digest"], "bytes": len(canonical(output).encode()), "new_model_calls": 0}))
        return 0
    except (ValueError, OSError, KeyError, TypeError, sqlite3.Error) as exc:
        # Never echo source/secret-bearing malformed values in diagnostics.
        message = Serializer(sensitive=sensitive_values(args.root.resolve())).text(str(exc))
        parser.error(message)
    finally:
        ledger.close()


if __name__ == "__main__":
    raise SystemExit(main())
