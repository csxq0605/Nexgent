"""Matched, actual-source improver evaluation with explicit missing evidence.

``generate(parent, context, label)`` must execute parent's ``improve`` source.
It returns complete candidate bundles, ``calls`` (durable model receipts),
``execution`` (the improve execution receipt), and optionally ``numerical_reports``
(each actual broker experiment, once). Exceptions may carry those same attributes.
``evaluate(bundle, split, seed)`` returns an independent science report. The caller
must keep transfer data private and persist returned artifacts before publication.

The measured quantity is best-of-k TASK output of a frozen improver, from a common
task start. Child non-task edits are recorded and projected out symmetrically.
This does not measure open-ended recursive learning, nor establish novel algorithms.
"""

from __future__ import annotations

from copy import deepcopy
import json
import math
from statistics import mean, stdev

from nexgent.kernel.programs import canonical, digest, splice, verify_bundle


class MetaEvaluationError(ValueError):
    """The experiment specification or a callback result is malformed."""


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def _error(exc):
    return {"type": type(exc).__name__, "message": str(exc)[:2000]}


def _summary(values):
    return {"n": len(values), "mean": mean(values) if values else None,
            "sample_std": stdev(values) if len(values) > 1 else None,
            "values": values}


def _origin(bundle):
    return {"id": bundle["id"], "source_digest": bundle["digest"],
            "component_digests": deepcopy(bundle["component_digests"])}


def _non_task_changes(candidate, parent):
    return [{"file": name, "original_digest": candidate["component_digests"].get(name),
             "frozen_digest": parent["component_digests"].get(name)}
            for name in sorted(set(candidate["files"]) | set(parent["files"]))
            if name != "task.py" and candidate["files"].get(name) != parent["files"].get(name)]


class _Recorder:
    def __init__(self, evaluate):
        self.evaluate_callback = evaluate
        self.artifacts = {}
        self.evaluations = {}
        self.cache = {}
        self.failures = []
        self.receipts = []
        self.generation_costs = []
        self.missing_evidence = []
        self.generation_executions = []

    def artifact(self, bundle):
        verify_bundle(bundle)
        self.artifacts.setdefault(bundle["id"], deepcopy(bundle))
        return bundle

    def failure(self, stage, label, error):
        item = {"stage": stage, "label": label, "error": error}
        self.failures.append(item)
        return item

    def evaluation(self, bundle, split, seed, label):
        key = (bundle["digest"], split, seed)
        if key in self.cache:
            record = self.evaluations[self.cache[key]]
            record["references"].append({"label": label, "bundle_id": bundle["id"]})
            return record
        identifier = "evaluation-" + digest(key)[:20]
        record = {"id": identifier, "bundle_id": bundle["id"],
                  "source_digest": bundle["digest"], "split": split, "seed": seed,
                  "status": "missing", "score": None,
                  "references": [{"label": label, "bundle_id": bundle["id"]}]}
        self.cache[key] = identifier
        self.evaluations[identifier] = record
        try:
            report = self.evaluate_callback(deepcopy(bundle), split, seed)
            canonical(report)
            if not isinstance(report, dict):
                raise MetaEvaluationError("Evaluation report must be an object")
            record["report"] = deepcopy(report)
            if report.get("split") != split or report.get("seed", seed) != seed:
                raise MetaEvaluationError("Evaluation split/seed does not match the request")
            tasks = report.get("tasks", [])
            resource_statuses = {"budget_exhausted", "interrupted", "stopped", "timeout", "missing"}
            if report.get("status") in resource_statuses or any(
                isinstance(row, dict) and row.get("status") in resource_statuses for row in tasks
            ):
                raise MetaEvaluationError("Resource-limited evaluation is missing, not a zero score")
            if not _number(report.get("score")):
                raise MetaEvaluationError("Evaluation score must be finite")
            execution = report.get("execution", {})
            if execution.get("source_digest") not in (None, bundle["digest"]):
                raise MetaEvaluationError("Evaluation execution source identity mismatch")
            if not execution.get("source_digest"):
                self.missing_evidence.append({"kind": "solve_execution", "label": label})
            record.update(status="evaluated", score=float(report["score"]))
        except Exception as exc:
            record["failure"] = self.failure("evaluation", label, _error(exc))
            if "report" not in record:
                execution = getattr(exc, "execution", None)
                if isinstance(execution, dict):
                    record["failure_execution"] = deepcopy(execution)
        return record

    def generation_evidence(self, result, parent, label):
        calls = result.get("calls")
        if isinstance(calls, list):
            self.receipts.extend({"label": label, "receipt": deepcopy(call)} for call in calls)
        else:
            self.missing_evidence.append({"kind": "model_call_receipts", "label": label})
        execution = result.get("execution")
        if isinstance(execution, dict):
            self.generation_executions.append({"label": label, "execution": deepcopy(execution)})
            if execution.get("source_digest") not in (None, parent["digest"]) or execution.get("bundle_id") not in (None, parent["id"]):
                raise MetaEvaluationError("Improver execution source identity mismatch")
            if execution.get("entry") not in (None, "improve"):
                raise MetaEvaluationError("Generation must execute the improve entry")
        if not isinstance(execution, dict) or not all(
            execution.get(name) == expected for name, expected in (
                ("source_digest", parent["digest"]), ("bundle_id", parent["id"]), ("entry", "improve"))
        ):
            self.missing_evidence.append({"kind": "improve_execution", "label": label})
        numerical_reports = result.get("numerical_reports")
        if isinstance(numerical_reports, list):
            for index, report in enumerate(numerical_reports):
                self.generation_costs.append({"label": label, "index": index, "report": deepcopy(report)})
        else:
            self.missing_evidence.append({"kind": "generation_numerical_costs", "label": label})

    def costs(self):
        by_id, anonymous = {}, []
        for row in self.receipts:
            receipt = row["receipt"]
            if not isinstance(receipt, dict) or not isinstance(receipt.get("call_id"), str):
                anonymous.append(row)
                continue
            key = receipt["call_id"]
            previous = by_id.get(key, {})
            combined = {**previous, **deepcopy(receipt)}
            # A later partial terminal snapshot must not erase a known reservation.
            combined["reserved_completion_tokens"] = max(
                [value for source in (previous, receipt) for name in
                 ("reserved_completion_tokens", "max_completion_tokens", "max_tokens")
                 if _number(value := source.get(name)) and value >= 0] or [0])
            if not combined.get("usage") and previous.get("usage"):
                combined["usage"] = previous["usage"]
            by_id[key] = combined
        known_usage = {name: 0 for name in ("prompt_tokens", "completion_tokens", "total_tokens")}
        missing_usage = []
        for call_id, receipt in by_id.items():
            usage = receipt.get("usage", {})
            for name in known_usage:
                value = usage.get(name) if isinstance(usage, dict) else None
                if _number(value) and value >= 0:
                    known_usage[name] += value
            if not isinstance(usage, dict) or not _number(usage.get("total_tokens")):
                missing_usage.append(call_id)
        numerical_known, numerical_missing = 0, []
        measurement_values, reused_measurements, unkeyed_measurements = {}, [], []
        inconsistent_measurements = []
        def account_measurement(report, label, fallback=None):
            nonlocal numerical_known
            report = report if isinstance(report, dict) else {}
            value = report.get("work_units", fallback)
            key = report.get("measurement_key")
            if isinstance(key, str) and key:
                if key in measurement_values:
                    reused_measurements.append({"measurement_key": key, "label": label})
                    if measurement_values[key] != value:
                        inconsistent_measurements.append({"measurement_key": key, "label": label,
                                                          "first_work_units": measurement_values[key], "other_work_units": value})
                    return
                measurement_values[key] = value
            else:
                # Without a host identity, equal values/sources do not prove reuse.
                unkeyed_measurements.append(label)
            if _number(value) and value >= 0:
                numerical_known += value
            else:
                numerical_missing.append(label)
        for row in self.evaluations.values():
            account_measurement(row.get("report"), row["id"], row.get("failure_execution", {}).get("work_units"))
        for row in self.generation_costs:
            account_measurement(row["report"], row["label"] + "/experiment/" + str(row["index"]))
        generation_work = sum(row["execution"].get("work_units", 0)
                              for row in self.generation_executions
                              if _number(row["execution"].get("work_units", 0)))
        return {"model_calls_with_identity": len(by_id), "model_receipts": self.receipts,
                "calls": list(by_id.values()), "receipts_without_identity": anonymous,
                "reserved_completion_tokens": sum(row["reserved_completion_tokens"] for row in by_id.values()),
                "known_usage": known_usage, "usage_missing_call_ids": missing_usage,
                "billing_unknown_call_ids": [key for key, row in by_id.items() if row.get("billing_status") == "unknown"],
                "numerical_work_units_known": numerical_known,
                "generation_local_work_units_known": generation_work,
                "numerical_costs_missing": numerical_missing,
                "deduplicated_measurement_keys": list(measurement_values),
                "reused_measurements": reused_measurements,
                "numerical_reports_without_identity": unkeyed_measurements,
                "inconsistent_measurement_costs": inconsistent_measurements,
                "generation_experiments": self.generation_costs,
                "generation_executions": self.generation_executions,
                "accounting_scope": "Known reported work only, deduplicated across evaluation and broker experiments by host measurement_key. Without a key, reuse is unknown and each report is retained. Cross-study cache reuse means this is not necessarily newly executed physical work; use the host ledger for physical/logical costs. Nested tool receipts are not added. Missing usage is not zero. Reservations are retained."}


def _arm(recorder, name, improver, task_start, seed, k, generate):
    parent = recorder.artifact(splice(task_start, improver))
    baseline = recorder.evaluation(parent, "development", seed, f"{seed}/{name}/baseline")
    arm = {"arm": name, "seed": seed, "improver_origin": _origin(improver),
           "task_origin": _origin(task_start), "parent": _origin(parent),
           "baseline_development": baseline["id"], "attempts": [], "offspring_slots_used": 0,
           "generation_calls": 0, "status": "complete", "improvement_at_k": None}
    eligible = [(parent, baseline)] if baseline["status"] == "evaluated" else []
    if not eligible:
        arm["status"] = "incomplete"
    while eligible and arm["offspring_slots_used"] < k:
        label = f"{seed}/{name}/generate/{arm['generation_calls'] + 1}"
        context = {"parent": deepcopy(parent), "development": deepcopy(baseline["report"]),
                   "seed": seed, "attempt": arm["generation_calls"] + 1,
                   "offspring_budget_remaining": k - arm["offspring_slots_used"],
                   "tested_improver_id": improver["id"],
                   "frozen_component_digests": {key: value for key, value in parent["component_digests"].items() if key != "task.py"},
                   "evaluation_protocol": "Generate task improvements from this common start. Meta/workflow/role edits may be returned; they are recorded and frozen to parent versions for this comparison."}
        if "roles.json" in parent["files"]:
            context["roles"] = json.loads(parent["files"]["roles.json"])
        attempt = {"label": label, "parent_id": parent["id"], "candidates": [], "discarded_excess_candidates": []}
        arm["attempts"].append(attempt)
        arm["generation_calls"] += 1
        evidence_recorded = False
        try:
            result = generate(deepcopy(parent), deepcopy(context), label)
            if isinstance(result, dict):
                evidence_recorded = True
                recorder.generation_evidence(result, parent, label)
            canonical(result)
            if not isinstance(result, dict) or not isinstance(result.get("candidates"), list):
                raise MetaEvaluationError("generate must return an object with candidates list")
            if result.get("status") in {"failed", "budget_exhausted", "stopped", "interrupted", "timeout"}:
                raise MetaEvaluationError("Generation reported failure: " + str(result["status"]))
            attempt["execution"] = deepcopy(result.get("execution"))
            attempt["research"] = deepcopy(result.get("research", {}))
            candidates = result["candidates"]
            if not candidates:
                arm["offspring_slots_used"] += 1
                attempt["status"] = "no_candidates"
            for index, candidate in enumerate(candidates):
                if arm["offspring_slots_used"] >= k:
                    attempt["discarded_excess_candidates"].append(
                        {"index": index, "original_id": candidate.get("id") if isinstance(candidate, dict) else None,
                         "reason": "offspring_budget_exhausted"})
                    continue
                arm["offspring_slots_used"] += 1
                candidate_row = {"index": index, "status": "invalid"}
                attempt["candidates"].append(candidate_row)
                try:
                    recorder.artifact(candidate)
                    projected = recorder.artifact(splice(candidate, parent))
                    candidate_row.update(original_id=candidate["id"], original_source_digest=candidate["digest"],
                        projected_id=projected["id"], projected_source_digest=projected["digest"],
                        generating_parent_id=parent["id"],
                        discarded_non_task_changes=_non_task_changes(candidate, parent))
                    measured = recorder.evaluation(projected, "development", seed, label + f"/candidate/{index}")
                    candidate_row.update(status=measured["status"], development_evaluation=measured["id"])
                    if measured["status"] == "evaluated":
                        eligible.append((projected, measured))
                    else:
                        arm["status"] = "incomplete"
                except Exception as exc:
                    candidate_row["failure"] = recorder.failure("candidate", label + f"/{index}", _error(exc))
            attempt.setdefault("status", "completed")
        except Exception as exc:
            if not evidence_recorded:
                carried = {key: getattr(exc, key) for key in ("calls", "execution", "numerical_reports") if hasattr(exc, key)}
                try:
                    recorder.generation_evidence(carried, parent, label)
                except Exception as receipt_error:
                    recorder.failure("generation_evidence", label, _error(receipt_error))
            attempt.update(status="failed", failure=recorder.failure("generation", label, _error(exc)))
            arm["status"] = "incomplete"
            # Do not retry transport, budget, interrupted, or failed source calls.
            break
    if eligible:
        selected, selected_development = max(eligible, key=lambda pair: pair[1]["score"])
        arm.update(selected_id=selected["id"], selected_development=selected_development["id"],
                   development_gain=selected_development["score"] - baseline["score"])
        # Transfer runs only after development selection. Its result never enters generation.
        baseline_transfer = recorder.evaluation(parent, "meta_transfer", seed, f"{seed}/{name}/baseline_transfer")
        selected_transfer = recorder.evaluation(selected, "meta_transfer", seed, f"{seed}/{name}/selected_transfer")
        arm.update(baseline_transfer=baseline_transfer["id"], selected_transfer=selected_transfer["id"])
        if baseline_transfer["status"] == selected_transfer["status"] == "evaluated":
            diagnostic_gain = selected_transfer["score"] - baseline_transfer["score"]
            arm["observed_transfer_gain"] = diagnostic_gain
            if arm["status"] == "complete":
                arm["improvement_at_k"] = diagnostic_gain
        else:
            arm["status"] = "incomplete"
    return arm


def _cross(recorder, initial, evolved, seeds):
    rows = []
    for seed in seeds:
        cells = {}
        for task_name, task in (("initial", initial), ("evolved", evolved)):
            for meta_name, meta in (("initial", initial), ("evolved", evolved)):
                bundle = recorder.artifact(splice(task, meta))
                cell = {"task_origin_id": task["id"], "meta_origin_id": meta["id"], "bundle_id": bundle["id"]}
                for split in ("development", "meta_transfer"):
                    row = recorder.evaluation(bundle, split, seed, f"{seed}/cross/{task_name}/{meta_name}/{split}")
                    cell[split] = {"evaluation_id": row["id"], "score": row["score"], "status": row["status"]}
                cells[f"task_{task_name}__meta_{meta_name}"] = cell
        contrasts = {}
        for split in ("development", "meta_transfer"):
            values = {key: cell[split]["score"] for key, cell in cells.items()}
            if all(value is not None for value in values.values()):
                a, b = values["task_initial__meta_initial"], values["task_evolved__meta_initial"]
                c, d = values["task_initial__meta_evolved"], values["task_evolved__meta_evolved"]
                contrasts[split] = {"task_effect_initial_meta": b - a, "task_effect_evolved_meta": d - c,
                                    "non_task_effect_initial_task": c - a, "non_task_effect_evolved_task": d - b,
                                    "interaction": d - c - b + a}
            else:
                contrasts[split] = None
        rows.append({"seed": seed, "cells": cells, "contrasts": contrasts})
    return {"kind": "direct_task_by_non_task_source_swap", "rows": rows,
            "interpretation": "These direct solve evaluations diagnose task/non-task coupling. They do not call improve and are not meta-productivity evidence. The paired actual offspring experiment supplies that evidence.",
            "shared_namespace_limitation": "workflow.py, task.py and meta.py execute in one namespace; task functions may depend on workflow helpers or be overwritten by meta source. Swaps may be incompatible. Effects belong to these whole source modules, not isolated abstract algorithms."}


def evaluate_improvers(initial, evolved, task_start, seeds=(101, 202, 303), k=1,
                       generate=None, evaluate=None):
    """Return a strict-JSON report; callbacks own execution, privacy and budgets.

    k bounds offspring slots and generation invocations separately, not model calls
    inside arbitrary improver code. The host gateway must enforce a matched model
    budget per arm. A returned batch consumes slots in order; excess is not scored.
    Missing resource-limited results are excluded from aggregates, never zero-filled.
    """
    if type(k) is not int or k < 1:
        raise MetaEvaluationError("k must be a positive integer")
    seeds = list(seeds)
    if not seeds or any(type(seed) is not int for seed in seeds) or len(set(seeds)) != len(seeds):
        raise MetaEvaluationError("seeds must be distinct integers")
    if not callable(generate) or not callable(evaluate):
        raise MetaEvaluationError("Actual generate and evaluate callbacks are required")
    recorder = _Recorder(evaluate)
    initial, evolved, task_start = [recorder.artifact(deepcopy(item)) for item in (initial, evolved, task_start)]
    arms, pairs = [], []
    for index, seed in enumerate(seeds):
        # Alternate order to reduce systematic first/last budget or service effects.
        order = [("initial", initial), ("evolved", evolved)]
        if index % 2:
            order.reverse()
        current = {}
        for name, improver in order:
            current[name] = _arm(recorder, name, improver, task_start, seed, k, generate)
            arms.append(current[name])
        first, second = current["initial"]["improvement_at_k"], current["evolved"]["improvement_at_k"]
        pairs.append({"seed": seed, "initial_improvement_at_k": first,
                      "evolved_improvement_at_k": second,
                      "difference": second - first if first is not None and second is not None else None,
                      "status": "complete" if first is not None and second is not None else "incomplete"})
    cross = _cross(recorder, initial, evolved, seeds)
    complete = [row for row in pairs if row["status"] == "complete"]
    costs = recorder.costs()
    evidence = {"level": "matched_actual_source_offspring_comparison" if not recorder.missing_evidence else "comparison_with_missing_execution_or_cost_evidence",
                "complete_pairs": len(complete), "requested_pairs": len(seeds),
                "missing": recorder.missing_evidence,
                "limits": ["A small comparison supports only these programs, task distribution, seeds and budgets; it does not establish universal RSI, significance, or algorithmic novelty.",
                           "Frozen improvers generate task outputs; this protocol does not update the tested improver or measure an unbounded recursive sequence.",
                           "Equal offspring k does not equal model-token or wall-clock cost. Compare receipts and enforce per-arm host budgets before causal performance claims.",
                           "Callbacks are trusted host adapters; execution receipts identify the program but do not attest an external container or reproduce model sampling.",
                           "No automatic transport retries. Budget, interruption and missing evaluations remain missing; complete-pair means can be affected by nonrandom missingness."]}
    report = {"schema_version": 1, "protocol": {"name": "frozen_improver_task_output_at_k", "k": k, "seeds": seeds,
                "generation": "Each arm repeatedly executes the same common-start parent; at most k calls and k offspring slots. No child meta code is adopted.",
                "selection": "Maximum development score including the unchanged start; ties keep the earlier candidate, starting with the baseline.",
                "transfer_split": "meta_transfer", "projection": "splice(candidate, frozen_parent)",
                "arm_order": "Alternating initial/evolved by seed index"},
              "origins": {"initial": _origin(initial), "evolved": _origin(evolved), "task_start": _origin(task_start)},
              "arms": arms, "per_seed_pairs": pairs,
              "aggregate": {"initial_improvement_at_k": _summary([row["initial_improvement_at_k"] for row in complete]),
                            "evolved_improvement_at_k": _summary([row["evolved_improvement_at_k"] for row in complete]),
                            "paired_difference": _summary([row["difference"] for row in complete]),
                            "incomplete_seeds": [row["seed"] for row in pairs if row["status"] != "complete"]},
              "cross_attribution": cross, "artifacts": recorder.artifacts, "evaluations": recorder.evaluations,
              "costs": costs, "failures": recorder.failures, "evidence": evidence}
    canonical(report)
    return report
