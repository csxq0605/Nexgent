"""A domain-neutral, four-arm qualification harness over real TaskService Episodes.

This module intentionally does not extend ``RSIStudyService``.  That service
owns paired confirmatory final-holdout studies and forbids memory injection.
The harness below is a smaller preflight for checking that four treatments can
run against identical public task payloads and hard limits before an external,
pre-registered causal study exists.
"""

from __future__ import annotations

from copy import deepcopy
import json
import math
from pathlib import Path
import time
import uuid

from nexgent.kernel.programs import digest
from nexgent.tasks.benchmarks import (
    descriptor_of,
    host_runtime_fingerprint,
    validate_adapter,
    validate_snapshot,
    validate_tasks,
)
from nexgent.tasks.multirole_seed import multirole_package
from nexgent.tasks.packages import (
    make_package,
    manifest_component_classes,
    verify_package,
)
from nexgent.tasks.tools import ContractError


PLAN_SCHEMA = "nexgent.orchestration-control-plan.v1"
RUN_SCHEMA = "nexgent.orchestration-control-run.v1"
ARM_IDS = ("fixed_multi", "single_equal_budget", "memory_only", "evolved")
LIMIT_KEYS = (
    "max_model_calls",
    "max_completion_tokens",
    "max_tool_calls",
    "max_tool_work_units",
    "max_nodes",
)
USAGE_KEYS = (
    "model_calls",
    "charged_completion_tokens",
    "tool_calls",
    "charged_tool_work_units",
    "nodes",
)


MEMORY_PREPARE_SOURCE = '''def prepare(payload, context):
    inputs = {}
    for name, artifact_id in sorted(payload.get("input_refs", {}).items()):
        artifact = context.read_artifact(artifact_id)
        inputs[name] = artifact["content"]
    memory = context.memory_search("", 5)
    return {
        "objective": payload.get("objective", ""),
        "inputs": inputs,
        "deliverables": payload.get("deliverables", []),
        "constraints": payload.get("constraints", {}),
        "memory": memory,
    }
'''


def _copy(value, label):
    try:
        return json.loads(json.dumps(
            value, ensure_ascii=False, sort_keys=True,
            separators=(",", ":"), allow_nan=False))
    except (TypeError, ValueError, RecursionError) as exc:
        raise ContractError(f"{label} must be finite JSON: {str(exc)[:500]}") from None


def _id(prefix):
    return prefix + "-" + uuid.uuid4().hex[:16]


def _budget(value):
    value = _copy(value, "Control episode budget")
    if not isinstance(value, dict):
        raise ContractError("Control budget must be an object")
    value.setdefault("max_tool_work_units", 0)
    if set(value) != set(LIMIT_KEYS):
        raise ContractError("Control budget must freeze every supported hard limit")
    if any(type(value[key]) is not int or value[key] < 0 for key in LIMIT_KEYS):
        raise ContractError("Control hard limits must be nonnegative integers")
    return {key: value[key] for key in LIMIT_KEYS}


def _memory_registration(value, package, label):
    value = _copy(value, label)
    keys = {
        "channel", "revision", "memory_id", "memory_digest",
        "package_id", "package_digest",
    }
    if (not isinstance(value, dict)
            or frozenset(value) not in {frozenset(keys), frozenset(keys | {"updated_at"})}
            or not isinstance(value.get("channel"), str)
            or type(value.get("revision")) is not int
            or value.get("package_id") != package["id"]
            or value.get("package_digest") != package["digest"]):
        raise ContractError(f"{label} does not bind the arm AgentPackage")
    return {key: value[key] for key in sorted(keys)}


def _changed_package_surfaces(parent, child):
    """Infer O/S file and registry changes from two validated v2 packages."""
    parent_classes = manifest_component_classes(parent)
    child_classes = manifest_component_classes(child)
    if parent_classes is None or child_classes is None:
        raise ContractError("Four-arm O/S controls require manifest v2 packages")
    changed = set()
    paths = set(parent["files"]) | set(child["files"])
    for path in paths:
        if parent["files"].get(path) != child["files"].get(path):
            changed.update(value for value in (
                parent_classes.get(path), child_classes.get(path)) if value is not None)
    parent_manifest, child_manifest = parent["manifest"], child["manifest"]
    for component_id in set(parent_manifest["components"]) | set(
            child_manifest["components"]):
        before = parent_manifest["components"].get(component_id)
        after = child_manifest["components"].get(component_id)
        if before != after:
            changed.update(value.get("class") for value in (before, after)
                           if isinstance(value, dict))
    registries = {"roles": "role", "workflows": "workflow", "skills": "skill"}
    for registry, kind in registries.items():
        before_registry = parent_manifest.get(registry, {})
        after_registry = child_manifest.get(registry, {})
        for ref in set(before_registry) | set(after_registry):
            if before_registry.get(ref) == after_registry.get(ref):
                continue
            for manifest in (parent_manifest, child_manifest):
                changed.update(component.get("class")
                               for component in manifest["components"].values()
                               if component.get("kind") == kind
                               and component.get("ref") == ref)
    return changed


def memory_ready_multirole_package():
    """Return the fixed multi-role baseline with one bounded memory read.

    The F and M arms must use this exact same package digest.  F receives the
    ordinary empty Episode snapshot; M receives a host-frozen accepted release.
    This makes memory availability the only package-level difference.
    """
    base = multirole_package()
    files = deepcopy(base["files"])
    files["skills/prepare.py"] = MEMORY_PREPARE_SOURCE
    return make_package(files, deepcopy(base["manifest"]), provenance={
        "origin": "nexgent.four-arm-memory-ready-fixed-baseline",
        "scope": "domain-neutral noncausal control qualification",
    })


class FourArmControlHarness:
    """Freeze and execute four descriptive controls through TaskService."""

    def __init__(self, task_service, adapter, *, record_dir=None):
        validate_adapter(adapter, require_descriptor=False)
        self.tasks = task_service
        self.adapter = adapter
        self.snapshot = validate_snapshot(adapter.snapshot())
        self.record_dir = Path(record_dir or (
            self.tasks.project_root / ".nexgent" / "exports" /
            "orchestration-controls")).resolve()

    def _path(self, kind, identity):
        return self.record_dir / f"{kind}-{identity}.json"

    @staticmethod
    def _write(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(
            json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
            encoding="utf-8")
        temporary.replace(path)

    @staticmethod
    def _read(path):
        return json.loads(path.read_text(encoding="utf-8"))

    def create_plan(self, *, fixed_package, single_package,
                    memory_registration, evolved_package=None,
                    evolved_memory_registration=None,
                    evolved_surfaces=("O", "S"), split="selection", seeds=(0,),
                    episode_budget=None):
        """Freeze four arms without consuming a confirmatory final holdout."""
        descriptor = descriptor_of(self.adapter, require_explicit=False)
        if split == "final_holdout":
            raise ContractError(
                "The noncausal control harness cannot consume final_holdout tasks")
        if split not in descriptor.splits:
            raise ContractError("Control split is not declared by the benchmark")
        seeds = list(seeds)
        if (not seeds or len(seeds) > 1000 or len(set(seeds)) != len(seeds)
                or any(type(seed) is not int for seed in seeds)):
            raise ContractError("Control seeds must be a bounded unique integer list")
        budget = _budget(episode_budget or {
            "max_model_calls": 3,
            "max_completion_tokens": 4800,
            "max_tool_calls": 0,
            "max_tool_work_units": 0,
            "max_nodes": 30,
        })
        fixed_package = _copy(fixed_package, "Fixed package")
        single_package = _copy(single_package, "Single-role package")
        evolved_package = _copy(
            fixed_package if evolved_package is None else evolved_package,
            "Evolved package")
        for package in (fixed_package, single_package, evolved_package):
            verify_package(package)
            self.tasks.store.put_package(package)
        if fixed_package["digest"] == single_package["digest"]:
            raise ContractError("Fixed and single-role packages must be distinct")

        memory_registration = _memory_registration(
            memory_registration, fixed_package, "Memory-only registration")
        evolved_memory = None
        if evolved_memory_registration is not None:
            evolved_memory = _memory_registration(
                evolved_memory_registration, evolved_package,
                "Evolved memory registration")
        surfaces = list(evolved_surfaces)
        if (not surfaces or set(surfaces) - {"O", "S", "M"}
                or len(set(surfaces)) != len(surfaces)):
            raise ContractError("Evolved surfaces must be a unique nonempty O/S/M subset")
        package_changed = evolved_package["digest"] != fixed_package["digest"]
        memory_changed = evolved_memory is not None
        package_surfaces = (_changed_package_surfaces(fixed_package, evolved_package)
                            if package_changed else set())
        if "M" in package_surfaces:
            raise ContractError("M changes must use a MemoryService release")
        if package_changed and evolved_package.get("parent_id") != fixed_package["id"]:
            raise ContractError("Evolved O/S package must be a direct child of fixed O/S")
        if package_surfaces != set(surfaces) & {"O", "S"}:
            raise ContractError("Evolved O/S surfaces must match a changed package")
        if memory_changed != ("M" in surfaces):
            raise ContractError("Evolved M surface must match a frozen memory release")
        if not package_changed and not memory_changed:
            raise ContractError("Evolved arm must contain an available O/S or M treatment")
        if (evolved_memory is not None
                and evolved_memory["memory_digest"] == memory_registration["memory_digest"]):
            raise ContractError("Evolved memory must differ from the memory-only treatment")

        arms = {
            "fixed_multi": {
                "package_id": fixed_package["id"],
                "package_digest": fixed_package["digest"],
                "memory_registration": None,
                "treatment": {"O_S": "fixed", "M": "empty"},
            },
            "single_equal_budget": {
                "package_id": single_package["id"],
                "package_digest": single_package["digest"],
                "memory_registration": None,
                "treatment": {"O_S": "single_role", "M": "empty"},
            },
            "memory_only": {
                "package_id": fixed_package["id"],
                "package_digest": fixed_package["digest"],
                "memory_registration": memory_registration,
                "treatment": {"O_S": "fixed", "M": "accepted_release"},
            },
            "evolved": {
                "package_id": evolved_package["id"],
                "package_digest": evolved_package["digest"],
                "memory_registration": evolved_memory,
                "treatment": {"surfaces": surfaces},
            },
        }
        if arms["fixed_multi"]["package_digest"] != arms["memory_only"]["package_digest"]:
            raise ContractError("F and M must freeze the identical O/S package")

        rows = []
        for seed in seeds:
            for task_index, task in enumerate(validate_tasks(
                    self.adapter.tasks(split=split, seed=seed))):
                task = _copy(task, "Control task")
                context = task.get("context") or {}
                if (not isinstance(context, dict)
                        or context.get("split", split) != split
                        or any(key in context for key in (
                            "benchmark_registration", "memory_channel_registration",
                            "memory_registration_digest", "control_arm"))):
                    raise ContractError("Control task context crosses a host boundary")
                rows.append({
                    "row_index": len(rows), "seed": seed,
                    "task_index": task_index, "task": task,
                    "task_digest": digest(task),
                })
        if not rows:
            raise ContractError("Control benchmark returned no tasks")
        if len({row["task_digest"] for row in rows}) != len(rows):
            raise ContractError("Control task payloads must be unique")

        plan_id = _id("orchestration-control-plan")
        schedule = []
        for row in rows:
            order = sorted(ARM_IDS, key=lambda arm: digest({
                "plan_id": plan_id, "row_index": row["row_index"], "arm": arm}))
            schedule.extend({"row_index": row["row_index"], "arm": arm}
                            for arm in order)
        protocol = {
            "benchmark_id": self.adapter.id,
            "benchmark_snapshot": deepcopy(self.snapshot),
            "benchmark_snapshot_digest": digest(self.snapshot),
            "split": split,
            "seeds": seeds,
            "rows": rows,
            "arms": arms,
            "episode_budget": budget,
            "budget_scope": {
                "equalized": "per-task Episode hard limits only",
                "usage": (
                    "host-charged counters and provider-reported prompt/completion "
                    "tokens are reported separately; either may differ by arm"),
                "excluded": [
                    "candidate generation and rejected candidates",
                    "development feedback collection",
                    "memory admission, selection, and promotion",
                    "selection, guard, and rollback outside this run",
                ],
            },
            "schedule": schedule,
            "information_policy": {
                "public_task_payload": "byte-identical within each four-arm row",
                "memory": (
                    "host-frozen treatment state; F/S are empty, M is accepted, "
                    "E follows its registered surfaces"),
                "memory_writeback": False,
                "evaluator_access": "host-only",
            },
            "claim_ceiling": "qualification_only_noncausal",
            "causal_effect_estimate_available": False,
            "limitations": [
                "No randomized assignment of independent evolution histories.",
                "No cluster-level power analysis or multiplicity correction.",
                "A memory treatment intentionally changes internal prior state.",
                "Public or narrow benchmarks such as BBH are qualification only.",
            ],
        }
        plan = {
            "schema": PLAN_SCHEMA,
            "id": plan_id,
            "status": "registered",
            "created_at": time.time(),
            **protocol,
            "protocol_digest": digest(protocol),
        }
        self._write(self._path("plan", plan_id), plan)
        return deepcopy(plan)

    def _verify_plan(self, plan):
        plan = _copy(plan, "Control plan")
        if plan.get("schema") != PLAN_SCHEMA or plan.get("status") != "registered":
            raise ContractError("Control plan schema or status is invalid")
        protocol = {key: deepcopy(value) for key, value in plan.items()
                    if key not in {"schema", "id", "status", "created_at",
                                   "protocol_digest"}}
        if digest(protocol) != plan.get("protocol_digest"):
            raise ContractError("Control plan protocol digest mismatch")
        stored = self._read(self._path("plan", plan["id"]))
        if stored != plan:
            raise ContractError("Control plan differs from its immutable record")
        if (plan["benchmark_id"] != self.adapter.id
                or validate_snapshot(self.adapter.snapshot()) != plan["benchmark_snapshot"]):
            raise ContractError("Control benchmark changed after registration")
        return plan

    def _prepare_episode(self, plan, scheduled):
        row = plan["rows"][scheduled["row_index"]]
        arm = plan["arms"][scheduled["arm"]]
        package = self.tasks.store.package(arm["package_id"])
        if package["digest"] != arm["package_digest"]:
            raise ContractError("Control arm package changed after registration")
        task = deepcopy(row["task"])
        if digest(task) != row["task_digest"]:
            raise ContractError("Control task changed after registration")
        context = deepcopy(task.get("context") or {})
        context["memory_writeback"] = False
        registration = {
            "benchmark_id": plan["benchmark_id"],
            "task_ref": deepcopy(task),
            "snapshot": deepcopy(plan["benchmark_snapshot"]),
            "host_runtime": host_runtime_fingerprint(),
        }
        memory = arm["memory_registration"]
        return self.tasks.create(
            task["objective"], task.get("inputs"), task.get("deliverables"),
            deepcopy(plan["episode_budget"]), task.get("capabilities"), package,
            context, constraints=task.get("constraints"),
            entry=task.get("entry", "execute"),
            benchmark_registration=registration,
            memory_channel=memory["channel"] if memory else None,
            expected_memory_registration=deepcopy(memory) if memory else None,
        )

    def run(self, plan, *, stop_event=None):
        """Run or resume a plan; never calculate a causal effect estimate."""
        plan = self._verify_plan(plan)
        run_path = self._path("run", plan["id"])
        if run_path.exists():
            run = self._read(run_path)
            if (run.get("schema") != RUN_SCHEMA
                    or run.get("plan_id") != plan["id"]
                    or run.get("protocol_digest") != plan["protocol_digest"]):
                raise ContractError("Control run record does not match its plan")
            if run.get("status") == "completed":
                return run
        else:
            run = {
                "schema": RUN_SCHEMA,
                "id": _id("orchestration-control-run"),
                "plan_id": plan["id"],
                "protocol_digest": plan["protocol_digest"],
                "status": "running", "cells": [],
                "started_at": time.time(),
                "claim_ceiling": plan["claim_ceiling"],
                "causal_effect_estimate": None,
            }
            self._write(run_path, run)

        completed = {(cell["row_index"], cell["arm"]): cell
                     for cell in run["cells"] if cell.get("status") == "completed"}
        for scheduled in plan["schedule"]:
            key = (scheduled["row_index"], scheduled["arm"])
            if key in completed:
                continue
            if stop_event is not None and stop_event.is_set():
                run["status"] = "paused"
                self._write(run_path, run)
                return deepcopy(run)
            existing = next((cell for cell in run["cells"]
                             if (cell["row_index"], cell["arm"]) == key), None)
            try:
                if existing is None:
                    episode = self._prepare_episode(plan, scheduled)
                    existing = {
                        **scheduled, "status": "prepared",
                        "episode_id": episode["id"],
                        "task_digest": plan["rows"][scheduled["row_index"]]["task_digest"],
                        "budget": deepcopy(plan["episode_budget"]),
                    }
                    run["cells"].append(existing)
                    self._write(run_path, run)
                episode_id = existing["episode_id"]
                terminal = self.tasks.run(episode_id, stop_event=stop_event)
                if terminal["status"] in {"ready", "running", "paused"}:
                    run["status"] = "paused"
                    self._write(run_path, run)
                    return deepcopy(run)
                row = plan["rows"][scheduled["row_index"]]
                evaluated = self.tasks.evaluate(
                    episode_id, self.adapter, deepcopy(row["task"]),
                    snapshot=deepcopy(plan["benchmark_snapshot"]))
                state = self.tasks.get_private(episode_id)
                snapshot = self.tasks.store.memory_snapshot(
                    state["memory_snapshot_id"], episode_id)
                consumed = [event for event in state["events"]
                            if event["kind"] == "memory_consumed"]
                nonempty_consumption = any(
                    event["content"].get("item_ids") for event in consumed)
                calls = self.tasks.store.calls(episode_id)
                # ModelGateway's successful terminal state is ``received``.
                # Other terminal states describe failures, and ``started`` /
                # ``reserved`` are incomplete admissions.  Do not infer real
                # role execution from the aggregate call reservation count.
                received_calls = [call for call in calls
                                  if call.get("status") == "received"]
                reported_tokens = {
                    key: [((call.get("usage") or {}).get(key))
                          for call in received_calls]
                    for key in ("prompt_tokens", "completion_tokens", "total_tokens")}
                report = evaluated["evaluation"]
                existing.update({
                    "status": "completed",
                    "episode_status": state["status"],
                    "score_available": report.get("score_available") is True,
                    "score": report.get("score"),
                    "accepted": report.get("accepted"),
                    "evaluation_digest": digest(report),
                    "usage": {key: state["usage"].get(key) for key in USAGE_KEYS},
                    "usage_complete": state["usage"].get("usage_complete") is True,
                    "package_digest": state["execution"]["package_digest"],
                    "memory_snapshot_digest": snapshot["digest"],
                    "memory_source": deepcopy(snapshot.get("source")),
                    "memory_consumed": nonempty_consumption,
                    "model_call_statuses": [call.get("status") for call in calls],
                    "received_model_call_count": len(received_calls),
                    "model_roles": [call.get("role") for call in received_calls],
                    "provider_reported_tokens": {
                        key: (sum(values) if values and all(
                            type(value) is int and value >= 0 for value in values)
                              else None)
                        for key, values in reported_tokens.items()},
                })
                self._write(run_path, run)
            except Exception as exc:
                run["status"] = "error"
                run["error"] = {"type": type(exc).__name__, "message": str(exc)[:500]}
                self._write(run_path, run)
                raise

        by_arm = {arm: [cell for cell in run["cells"] if cell["arm"] == arm]
                  for arm in ARM_IDS}
        descriptive = {}
        for arm, cells in by_arm.items():
            scores = [cell["score"] for cell in cells
                      if cell["score_available"] and type(cell["score"]) in {int, float}
                      and math.isfinite(cell["score"])]
            descriptive[arm] = {
                "cell_count": len(cells),
                "measured_count": len(scores),
                "mean_score": sum(scores) / len(scores) if scores else None,
                "host_charged_usage": {key: sum(
                    (cell["usage"].get(key) or 0) for cell in cells)
                    for key in USAGE_KEYS},
                "provider_reported_tokens": {
                    key: (sum(values) if len(values) == len(cells) else None)
                    for key in ("prompt_tokens", "completion_tokens", "total_tokens")
                    for values in [[cell["provider_reported_tokens"].get(key)
                                    for cell in cells
                                    if cell["provider_reported_tokens"].get(key) is not None]]
                },
            }
        memory_cells = by_arm["memory_only"]
        run.update({
            "status": "completed",
            "completed_at": time.time(),
            "descriptive_summary": descriptive,
            "control_checks": {
                "same_task_episode_hard_limits": all(
                    cell["budget"] == plan["episode_budget"] for cell in run["cells"]),
                "same_public_task_within_row": all(
                    len({cell["task_digest"] for cell in run["cells"]
                         if cell["row_index"] == row["row_index"]}) == 1
                    for row in plan["rows"]),
                "fixed_O_S_in_memory_arm": (
                    plan["arms"]["fixed_multi"]["package_digest"] ==
                    plan["arms"]["memory_only"]["package_digest"]),
                "memory_treatment_consumed": bool(memory_cells) and all(
                    cell["memory_consumed"] for cell in memory_cells),
                "complete_usage": all(cell["usage_complete"] for cell in run["cells"]),
                "successful_model_receipts": all(
                    cell["usage"].get("model_calls", 0) > 0
                    and cell["received_model_call_count"] ==
                    cell["usage"].get("model_calls")
                    and all(isinstance(role, str) and role
                            for role in cell["model_roles"])
                    for cell in run["cells"]),
                "observed_role_structure": all(
                    (len(set(cell["model_roles"])) == 1
                     if cell["arm"] == "single_equal_budget"
                     else len(set(cell["model_roles"])) >= 2)
                    for cell in run["cells"]),
            },
            "causal_effect_estimate": None,
            "interpretation": (
                "Descriptive execution qualification only. Arm means are not causal "
                "effects and cannot establish orchestration or RSI benefit."),
        })
        run["valid_execution_preflight"] = all(run["control_checks"].values())
        self._write(run_path, run)
        return deepcopy(run)
