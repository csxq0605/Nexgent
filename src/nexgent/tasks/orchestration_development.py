"""Production development-only qualification for orchestration search.

The host supplies an installed benchmark adapter and its frozen snapshot.  One
call spends a paired parent/candidate run on fresh development units and
returns only the bounded public projection accepted by
``normalize_qualification``.  A durable intent is written before planning so a
crash or provider failure cannot be silently retried with the same candidate,
benchmark snapshot, seed, task sample, and Episode budget.
Known host-classified candidate execution errors are reduced to fixed codes;
raw Episode errors and evaluator-private data never enter repair input.
"""

from __future__ import annotations

from copy import deepcopy
import json
import re
import time

from ..kernel.programs import digest
from .benchmarks import (
    descriptor_of, validate_adapter, validate_snapshot, validate_tasks,
)
from .evolution import PromotionPolicy
from .orchestration_search import (
    DevelopmentQualificationError, QUALIFICATION_SCHEMA,
    normalize_qualification, paired_episode_budget,
)
from .package_runner import CapabilityAbort
from .tools import ContractError


_TERMINAL = frozenset({"completed", "failed"})
_USAGE_KEYS = ("model_calls", "completion_tokens", "tool_calls", "nodes")
_JOURNAL_SCHEMA = "nexgent.orchestration-development-run.v1"


def _candidate_failure_code(episode):
    """Project only known host error classes, never node text or task data."""
    if episode.get("status") != "failed":
        return None
    error = episode.get("last_error")
    if not isinstance(error, str):
        return None
    domain = episode.get("failure_domain")
    if (domain == "protocol" and error.startswith(
            "ContractError: Workflow ask node has unsupported gateway arguments: ")):
        return "candidate_workflow_gateway_invalid"
    if (domain == "protocol"
            and re.match(
                r"^ContractError: [A-Za-z][A-Za-z0-9_. /-]{0,100}: "
                r"Additional properties are not allowed\b", error)):
        return "candidate_artifact_schema_invalid"
    if (domain == "agent"
            and error in {
                "ModelError: Provider must return one valid JSON object",
                "ModelError: Provider must return a JSON object",
            }):
        return "candidate_model_output_invalid"
    return None


def _copy(value, label):
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":"), allow_nan=False))
    except (TypeError, ValueError, RecursionError) as exc:
        raise ContractError(f"{label} must be finite JSON") from exc


def _statistical_units(task_refs, label):
    units = []
    for task_ref in task_refs:
        unit = task_ref.get("statistical_unit_id") if isinstance(task_ref, dict) else None
        if not isinstance(unit, str) or not unit:
            raise ContractError(f"{label} require nonempty statistical unit ids")
        units.append(unit)
    if len(set(units)) != len(units):
        raise ContractError(f"{label} require unique statistical units")
    return units


def _sum_usage(total, value):
    total["model_calls"] += value.get("model_calls", 0)
    total["completion_tokens"] += value.get(
        "charged_completion_tokens", value.get("completion_tokens", 0))
    total["tool_calls"] += value.get(
        "charged_tool_calls", value.get("tool_calls", 0))
    total["nodes"] += value.get("nodes", 0)


def _task_fingerprint_payload(task_ref, *, inputs=None):
    if not isinstance(task_ref, dict):
        raise ContractError("Task fingerprint source must be an object")
    objective = task_ref.get("objective")
    if not isinstance(objective, str) or not objective:
        raise ContractError("Task fingerprint requires an objective")
    value = {
        "objective": objective,
        "inputs": task_ref.get("inputs", {}) if inputs is None else inputs,
        "deliverables": task_ref.get(
            "deliverables", [{"name": "result", "schema": {}}]),
        "constraints": task_ref.get("constraints", {}),
    }
    return _copy(value, "Public task fingerprint payload")


def public_task_fingerprint(task_ref):
    """Digest public task content without reading evaluator-private fields."""
    return digest(_task_fingerprint_payload(task_ref))


def _private_source_fingerprint(tasks, episode_id):
    if not isinstance(episode_id, str) or not episode_id:
        raise ContractError("Source Episode identity must be nonempty")
    state = tasks.get_private(episode_id)
    task = state.get("task") or {}
    refs = state.get("input_refs") or {}
    if not isinstance(refs, dict) or set(refs) != set(task.get("inputs") or {}):
        raise ContractError("Source Episode input artifacts are incomplete")
    inputs = {
        name: tasks.store.read(ref, episode_id)["content"]
        for name, ref in sorted(refs.items())
    }
    return digest(_task_fingerprint_payload(task, inputs=inputs))


def _fingerprint(value):
    if not isinstance(value, str) or len(value) != 64:
        raise ContractError("Source task fingerprint must be a SHA-256 digest")
    try:
        int(value, 16)
    except ValueError:
        raise ContractError("Source task fingerprint must be a SHA-256 digest") from None
    return value.lower()


class DevelopmentOrchestrationQualifier:
    """Callable development qualifier for ``BoundedOrchestrationSearch``.

    ``adapter`` must expose an explicit ``BenchmarkDescriptor`` (the same
    contract enforced for installed entry points).  ``snapshot`` is captured
    by the host while binding the adapter and is rechecked before sampling,
    planning, and execution.  Candidate failures are deliberately projected
    only as status, score availability, activation, and artifact validity;
    host-private evaluator output and raw exception text never enter repair.
    """

    def __init__(self, tasks, evolution, adapter, *, snapshot, seed,
                 source_statistical_units=None, source_episode_id=None,
                 source_task_fingerprint=None, development_episode_budget=None, options=None,
                 capability_authority=None, stop_event=None, max_seed_scan=128):
        self.tasks = tasks
        self.evolution = evolution
        self.adapter = validate_adapter(adapter, require_descriptor=True)
        self.descriptor = descriptor_of(adapter, require_explicit=True)
        if "development" not in self.descriptor.splits:
            raise ContractError("Qualification benchmark has no development split")
        if "qualification" not in self.descriptor.allowed_suite_roles:
            raise ContractError("Benchmark does not allow qualification use")
        self.snapshot = validate_snapshot(snapshot)
        if digest(validate_snapshot(adapter.snapshot())) != digest(self.snapshot):
            raise ContractError("Host-bound benchmark snapshot differs from the adapter")
        if type(seed) is not int:
            raise ContractError("Development qualification seed must be an integer")
        if type(max_seed_scan) is not int or not 1 <= max_seed_scan <= 10000:
            raise ContractError("Development qualification seed scan is invalid")
        self.first_seed = seed
        self.max_seed_scan = max_seed_scan
        source_statistical_units = (() if source_statistical_units is None
                                    else source_statistical_units)
        if (not isinstance(source_statistical_units, (list, tuple, set))
                or len(source_statistical_units) > 1024
                or any(not isinstance(unit, str) or not unit or len(unit) > 500
                       for unit in source_statistical_units)
                or len(set(source_statistical_units)) != len(source_statistical_units)):
            raise ContractError(
                "Host must bind unique source statistical units for qualification")
        self.source_statistical_units = tuple(sorted(source_statistical_units))
        self.source_episode_id = source_episode_id
        derived_fingerprint = (None if source_episode_id is None else
                               _private_source_fingerprint(tasks, source_episode_id))
        supplied_fingerprint = (None if source_task_fingerprint is None else
                                _fingerprint(source_task_fingerprint))
        if (derived_fingerprint is not None and supplied_fingerprint is not None
                and derived_fingerprint != supplied_fingerprint):
            raise ContractError("Source Episode differs from its public task fingerprint")
        self.source_task_fingerprint = derived_fingerprint or supplied_fingerprint
        if (not self.source_statistical_units
                and self.source_task_fingerprint is None):
            raise ContractError(
                "Qualification requires source units or a public task fingerprint")
        if (any(unit.startswith("ordinary:")
                for unit in self.source_statistical_units)
                and self.source_task_fingerprint is None):
            raise ContractError(
                "Synthetic ordinary source units require a task fingerprint")
        self.episode_budget = (None if development_episode_budget is None else
                               _copy(development_episode_budget,
                                     "Development Episode budget"))
        self.options = _copy({} if options is None else options,
                             "Development qualification options")
        if not isinstance(self.options, dict):
            raise ContractError("Development qualification options must be an object")
        if set(self.options).intersection({
                "split", "split_role", "seed", "budget", "policy",
                "capability_authority"}):
            raise ContractError("Development options cannot override host-owned fields")
        self.capability_authority = deepcopy(capability_authority)
        self.stop_event = stop_event
        with self.tasks.store.connect() as db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS task_orchestration_development_runs(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL)
            """)

    def _check_snapshot(self):
        if digest(validate_snapshot(self.adapter.snapshot())) != digest(self.snapshot):
            raise ContractError("Qualification benchmark snapshot changed after host binding")

    def _source_and_prior_units(self, candidate):
        source_ids = set(candidate.get("feedback_episode_ids") or [])
        if self.source_episode_id is not None:
            if self.source_episode_id not in source_ids:
                raise ContractError(
                    "Source Episode is not candidate feedback evidence")
            source_ids.add(self.source_episode_id)
        excluded = set(self.source_statistical_units)
        registered_source_units = set()
        for state in self.tasks.store.list():
            identity = state.get("id")
            registration = self.tasks.store.benchmark_registration(identity)
            if not isinstance(registration, dict):
                continue
            if registration.get("benchmark_id") != self.descriptor.id:
                continue
            evolution_registration = ((state.get("task") or {}).get("context") or {}).get(
                "evolution_registration") or {}
            is_source = identity in source_ids
            role = evolution_registration.get("split_role")
            is_prior_evolution_unit = role in {"development", "selection", "guard"}
            if not (is_source or is_prior_evolution_unit):
                continue
            task_ref = registration.get("task_ref")
            units = _statistical_units(
                [task_ref], "Source and prior qualification Episodes")
            excluded.update(units)
            if is_source:
                registered_source_units.update(units)
        if not registered_source_units.issubset(self.source_statistical_units):
            raise ContractError(
                "Host-bound source units omit registered feedback units")
        return excluded

    @staticmethod
    def _remaining_budget(value):
        value = _copy(value, "Remaining search budget")
        if (not isinstance(value, dict) or set(value) != set(_USAGE_KEYS)
                or any(type(value[key]) is not int or value[key] < 0
                       for key in _USAGE_KEYS)):
            raise ContractError("Remaining search budget is invalid")
        return value

    def _read_record(self, run_id):
        with self.tasks.store.connect() as db:
            row = db.execute(
                "SELECT data,digest FROM task_orchestration_development_runs WHERE id=?",
                (run_id,)).fetchone()
        if row is None:
            return None
        record = json.loads(row[0])
        if digest(record) != row[1] or record.get("id") != run_id:
            raise ContractError("Development qualification journal is invalid")
        return record

    def _prior_candidate_record(self, candidate, episode_budget):
        """Find an earlier identical candidate intent before sampling a new seed."""
        with self.tasks.store.connect() as db:
            rows = db.execute(
                "SELECT id,data,digest FROM task_orchestration_development_runs"
            ).fetchall()
        matches, same_candidate = [], []
        expected = {
            "candidate_id": candidate["id"],
            "candidate_package_digest": candidate["package_digest"],
            "benchmark_id": self.descriptor.id,
            "snapshot_digest": digest(self.snapshot),
            "options_digest": digest(self.options),
            "source_statistical_units": list(self.source_statistical_units),
            "source_task_fingerprint": self.source_task_fingerprint,
            "episode_budget": episode_budget,
        }
        for run_id, encoded, stored_digest in rows:
            record = json.loads(encoded)
            if (record.get("id") != run_id or digest(record) != stored_digest
                    or record.get("schema") != _JOURNAL_SCHEMA):
                raise ContractError("Development qualification journal is invalid")
            identity = record.get("identity") or {}
            if (identity.get("candidate_id") == candidate["id"]
                    and identity.get("candidate_package_digest")
                    == candidate["package_digest"]
                    and identity.get("benchmark_id") == self.descriptor.id
                    and identity.get("snapshot_digest") == digest(self.snapshot)):
                same_candidate.append(record)
            if all(identity.get(key) == value for key, value in expected.items()):
                matches.append(record)
        if len(matches) > 1:
            raise ContractError("Candidate has multiple development qualification intents")
        if same_candidate and not matches:
            raise ContractError(
                "Candidate qualification binding changed after a durable intent")
        return matches[0] if matches else None

    def _resolve_existing(self, record, candidate):
        if record.get("status") == "completed":
            return normalize_qualification(candidate["id"], record.get("result"))
        failure = record.get("failure")
        if not isinstance(failure, dict):
            failure = self._failure(
                record.get("plan_id"),
                ContractError("Development qualification was interrupted"))
            record = self._update(record, status="failed", failure=failure)
        raise DevelopmentQualificationError(record["failure"])

    def _begin(self, identity):
        run_id = "development-qualification-" + digest(identity)[:24]
        now = time.time()
        record = {"schema": _JOURNAL_SCHEMA, "id": run_id, "status": "running",
                  "identity": identity, "plan_id": None, "result": None,
                  "failure": None, "created_at": now, "updated_at": now}
        encoded = json.dumps(record, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":"), allow_nan=False)
        with self.tasks.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT data,digest FROM task_orchestration_development_runs WHERE id=?",
                (run_id,)).fetchone()
            if row is None:
                db.execute(
                    "INSERT INTO task_orchestration_development_runs VALUES(?,?,?)",
                    (run_id, encoded, digest(record)))
                return record, True
        existing = self._read_record(run_id)
        if existing.get("identity") != identity:
            raise ContractError("Development qualification identity collision")
        return existing, False

    def _update(self, record, *, status=None, plan_id=None, result=None, failure=None):
        previous = deepcopy(record)
        if status is not None:
            record["status"] = status
        if plan_id is not None:
            record["plan_id"] = plan_id
        if result is not None:
            record["result"] = _copy(result, "Development qualification result")
        if failure is not None:
            record["failure"] = _copy(failure, "Development qualification failure")
        record["updated_at"] = time.time()
        encoded = json.dumps(record, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":"), allow_nan=False)
        with self.tasks.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            changed = db.execute(
                "UPDATE task_orchestration_development_runs SET data=?,digest=? "
                "WHERE id=? AND digest=?",
                (encoded, digest(record), record["id"], digest(previous))).rowcount
        if changed != 1:
            raise ContractError("Development qualification journal changed concurrently")
        return record

    def _failure(self, plan_id, exc):
        cause = exc.cause if isinstance(exc, CapabilityAbort) else exc
        episodes, statuses = [], {}
        usage = {key: 0 for key in _USAGE_KEYS}
        usage["usage_complete"] = True
        if plan_id is not None:
            for state in self.tasks.store.list():
                registration = ((state.get("task") or {}).get("context") or {}).get(
                    "evolution_registration") or {}
                if registration.get("plan_id") != plan_id:
                    continue
                current = self.tasks.get_private(state["id"])
                episodes.append(current["id"])
                statuses[current["id"]] = current["status"]
                observed = current.get("usage") or {}
                _sum_usage(usage, observed)
                if (observed.get("usage_complete") is not True
                        or current.get("status") not in _TERMINAL):
                    usage["usage_complete"] = False
        trial_id = None
        if plan_id is not None:
            try:
                claim = self.evolution.inspect_run_claim("paired", plan_id)
                if claim and claim.get("status") == "completed":
                    trial_id = claim.get("record_id")
            except Exception:
                pass
        return {
            "failure_type": type(cause).__name__,
            "evidence_refs": {"plan_id": plan_id, "trial_id": trial_id,
                              "episode_ids": sorted(episodes)},
            "episode_statuses": statuses,
            "usage": usage,
            "retry_safe": False,
        }

    def _project(self, candidate, trial, units):
        if (trial.get("candidate_id", candidate["id"]) != candidate["id"]
                or not isinstance(trial.get("id"), str)
                or not isinstance(trial.get("plan_id"), str)
                or not isinstance(trial.get("pairs"), list)
                or len(trial["pairs"]) != len(units)):
            raise ContractError("Development trial differs from the frozen paired plan")
        rows = []
        usage = {key: 0 for key in _USAGE_KEYS}
        usage["usage_complete"] = True
        for pair, unit in zip(trial["pairs"], units):
            parent = pair["parent"]
            child = pair["candidate"]
            parent_episode = self.tasks.get_private(parent["episode_id"])
            child_episode = self.tasks.get_private(child["episode_id"])
            if any(episode.get("failure_domain") == "infrastructure"
                   for episode in (parent_episode, child_episode)):
                raise ContractError(
                    "Infrastructure failure invalidated paired development evidence")
            for run in (parent, child):
                observed = run.get("usage") or {}
                _sum_usage(usage, observed)
                if observed.get("usage_complete") is not True:
                    usage["usage_complete"] = False
            outcome = child_episode.get("outcome") or {}
            row = {
                "statistical_unit_id": unit,
                "parent_status": parent_episode["status"],
                "candidate_status": child_episode["status"],
                "parent_score_available": parent["evaluation"].get(
                    "score_available") is True,
                "candidate_score_available": child["evaluation"].get(
                    "score_available") is True,
                "parent_score": parent["evaluation"].get("score"),
                "candidate_score": child["evaluation"].get("score"),
                "activation_loaded": (child.get("loaded_evidence") or {}).get(
                    "loaded") is True,
                "artifact_contract_valid": (
                    child_episode["status"] == "completed"
                    and outcome.get("delivery_status") == "delivered"
                    and outcome.get("schema_validation") == "passed"),
            }
            failure_code = _candidate_failure_code(child_episode)
            if failure_code is not None:
                row["candidate_failure_code"] = failure_code
            rows.append(row)
        value = {
            "schema": QUALIFICATION_SCHEMA,
            "candidate_id": candidate["id"],
            "tasks": rows,
            "usage": usage,
            "evidence_refs": {"plan_id": trial["plan_id"],
                              "trial_id": trial["id"]},
        }
        return normalize_qualification(candidate["id"], value)

    def __call__(self, candidate, remaining_budget):
        remaining = self._remaining_budget(remaining_budget)
        if not isinstance(candidate, dict) or not isinstance(candidate.get("id"), str):
            raise ContractError("Development qualification candidate is invalid")
        stored = self.evolution.candidate(candidate["id"])
        if stored != candidate:
            raise ContractError("Development qualification candidate is not immutable")
        self._check_snapshot()

        parent = self.tasks.store.package(candidate["parent_package_id"])
        child = self.tasks.store.package(candidate["package_id"])
        estimate = paired_episode_budget(
            parent, child, development_episode_budget=self.episode_budget)
        cap = estimate["episode_budget"]
        prior = self._prior_candidate_record(candidate, cap)
        if prior is not None:
            return self._resolve_existing(prior, candidate)

        excluded = self._source_and_prior_units(candidate)
        preview = units = selected_seed = None
        for offset in range(self.max_seed_scan):
            seed = self.first_seed + offset
            proposed = validate_tasks(self.adapter.tasks(
                split="development", seed=seed, **deepcopy(self.options)))
            proposed_units = _statistical_units(
                proposed, "Development qualification tasks")
            duplicates_source = (
                self.source_task_fingerprint is not None
                and any(public_task_fingerprint(task_ref)
                        == self.source_task_fingerprint
                        for task_ref in proposed))
            if excluded.isdisjoint(proposed_units) and not duplicates_source:
                preview, units, selected_seed = proposed, proposed_units, seed
                break
        if preview is None:
            raise ContractError(
                "No fresh development units were found in the bounded seed scan")
        required = {
            "model_calls": cap["max_model_calls"] * 2 * len(preview),
            "completion_tokens": cap["max_completion_tokens"] * 2 * len(preview),
            "tool_calls": cap["max_tool_calls"] * 2 * len(preview),
            "nodes": cap["max_nodes"] * 2 * len(preview),
        }
        if any(remaining[key] < required[key] for key in _USAGE_KEYS):
            raise DevelopmentQualificationError({
                "failure_type": "InsufficientSearchBudget",
                "evidence_refs": {"plan_id": None, "trial_id": None,
                                  "episode_ids": []},
                "episode_statuses": {}, "required_budget": required,
                "usage": {**{key: 0 for key in _USAGE_KEYS},
                          "usage_complete": True},
                "retry_safe": False,
            })

        identity = {
            "candidate_id": candidate["id"],
            "candidate_package_digest": candidate["package_digest"],
            "benchmark_id": self.descriptor.id,
            "snapshot_digest": digest(self.snapshot),
            "split": "development", "seed": selected_seed,
            "options_digest": digest(self.options),
            "task_refs_digest": digest(preview),
            "statistical_units": units,
            "source_statistical_units": list(self.source_statistical_units),
            "source_task_fingerprint": self.source_task_fingerprint,
            "episode_budget": cap,
        }
        record, created = self._begin(identity)
        if not created:
            return self._resolve_existing(record, candidate)

        plan_id = None
        try:
            self._check_snapshot()
            plan = self.evolution.plan_pair(
                candidate["id"], self.adapter, split="development",
                split_role="development", seed=selected_seed, budget=cap,
                policy=PromotionPolicy(),
                capability_authority=deepcopy(self.capability_authority),
                **deepcopy(self.options))
            plan_id = plan["id"]
            record = self._update(record, plan_id=plan_id)
            if (plan["suite"].get("snapshot") != self.snapshot
                    or plan["suite"].get("tasks") != preview
                    or plan["suite"].get("split") != "development"
                    or plan["suite"].get("split_role") != "development"
                    or plan.get("budget") != cap):
                raise ContractError("Frozen development plan differs from host preflight")
            self._check_snapshot()
            trial = self.evolution.run_pair(
                plan_id, self.adapter, stop_event=self.stop_event)
            self._check_snapshot()
            result = self._project(candidate, trial, units)
            self._update(record, status="completed", result=result)
            return result
        except (Exception, CapabilityAbort) as exc:
            failure = self._failure(plan_id, exc)
            try:
                self._update(record, status="failed", failure=failure)
            except ContractError:
                # The original durable intent/plan still prevents replay.  Do
                # not hide the execution failure behind a journal race.
                pass
            raise DevelopmentQualificationError(failure) from None


__all__ = ["DevelopmentOrchestrationQualifier", "public_task_fingerprint"]
