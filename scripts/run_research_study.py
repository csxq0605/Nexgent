"""Reproducible fixed scientific controls and seed-paired study summaries.

This script never calls a language model. Controller-driven arms can use the
same measurement schema after their export adapter is explicitly defined.
Run with the repository's virtual environment, for example:
  .venv/Scripts/python.exe scripts/run_research_study.py baseline --seeds 0 1 2
  .venv/Scripts/python.exe scripts/run_research_study.py summarize receipt.json
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
import platform
import random
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
SCHEMA = "nexgent.research-study.v1"


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def save_receipt(path, receipt):
    payload = {key: value for key, value in receipt.items() if key != "content_digest"}
    receipt["content_digest"] = digest(payload)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(receipt, ensure_ascii=False, allow_nan=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _quantile(sorted_values, probability):
    position = (len(sorted_values) - 1) * probability
    lower = int(position)
    upper = min(lower + 1, len(sorted_values) - 1)
    return sorted_values[lower] * (upper - position) + sorted_values[upper] * (position - lower) if lower != upper else sorted_values[lower]


def paired_bootstrap(differences, *, repetitions=10_000, seed=713, confidence=0.95):
    """Resample independent complete seeds, never trajectory time points."""
    if not differences:
        return {"n": 0, "mean": None, "interval": None, "status": "no_complete_pairs"}
    result = {"n": len(differences), "mean": statistics.fmean(differences), "minimum": min(differences), "maximum": max(differences), "confidence": confidence, "repetitions": repetitions, "bootstrap_seed": seed, "resampling_unit": "paired independent study seed", "method": "percentile bootstrap of paired seed means"}
    if len(differences) < 2:
        return {**result, "interval": None, "status": "insufficient_independent_seeds"}
    rng = random.Random(seed)
    samples = sorted(statistics.fmean(rng.choices(differences, k=len(differences))) for _ in range(repetitions))
    tail = (1 - confidence) / 2
    return {**result, "interval": [_quantile(samples, tail), _quantile(samples, 1 - tail)], "status": "exploratory_small_sample" if len(differences) < 10 else "estimated", "limitation": "Percentile intervals are exploratory; a small number of seeds does not establish calibrated coverage, and repeated method selection invalidates confirmatory interpretation."}


def paired_measurements(reference, candidate):
    issues = []
    if reference.get("suite_digest") != candidate.get("suite_digest"):
        issues.append("different_suite_digest")
    if reference.get("evaluator_digest") != candidate.get("evaluator_digest"):
        issues.append("different_evaluator_digest")
    reference_tasks = {row["task_id"]: row for row in reference.get("tasks", [])}
    candidate_tasks = {row["task_id"]: row for row in candidate.get("tasks", [])}
    if not reference_tasks or set(reference_tasks) != set(candidate_tasks):
        issues.append("missing_or_unpaired_tasks")
    if len(reference_tasks) != len(reference.get("tasks", [])) or len(candidate_tasks) != len(candidate.get("tasks", [])):
        issues.append("duplicate_task_ids")
    for label, measurement, rows in (("reference", reference, reference_tasks), ("candidate", candidate, candidate_tasks)):
        if rows and not math.isclose(measurement["score"], statistics.fmean(row["score"] for row in rows.values()), rel_tol=1e-10, abs_tol=1e-12):
            issues.append(label + "_aggregate_disagrees_with_tasks")
    pairs = []
    for task_id in sorted(set(reference_tasks) & set(candidate_tasks)):
        left, right = reference_tasks[task_id], candidate_tasks[task_id]
        if left.get("group") != right.get("group") or left.get("family") != right.get("family"):
            issues.append("task_metadata_mismatch:" + task_id)
        pairs.append({"task_id": task_id, "family": left.get("family"), "group": left.get("group"), "reference_score": left["score"], "candidate_score": right["score"], "delta": right["score"] - left["score"], "reference_nrmse": left["nrmse"], "candidate_nrmse": right["nrmse"], "reference_status": left["status"], "candidate_status": right["status"]})
    left_work, right_work = reference.get("work_units", 0), candidate.get("work_units", 0)
    return {"valid_pair": not issues, "issues": issues, "delta": candidate["score"] - reference["score"], "worst_task_delta": min((row["delta"] for row in pairs), default=None), "reference_score": reference["score"], "candidate_score": candidate["score"], "reference_work_units": left_work, "candidate_work_units": right_work, "work_ratio": right_work / left_work if left_work else None, "reference_failures": sum(row["status"] != "ok" for row in reference_tasks.values()), "candidate_failures": sum(row["status"] != "ok" for row in candidate_tasks.values()), "tasks": pairs}


def summarize(receipt, *, reference_arm="seed", bootstrap_repetitions=10_000, bootstrap_seed=713):
    seeds = receipt["protocol"]["seeds"]
    arms = receipt["protocol"]["arms"]
    if reference_arm not in arms:
        raise ValueError("reference arm is not present in the registered protocol")
    indexed = {}
    for row in receipt["measurements"]:
        key = (row["arm"], row["seed"])
        if key in indexed:
            raise ValueError("duplicate arm/seed measurements cannot be silently selected")
        if row["arm"] not in arms or row["seed"] not in seeds:
            raise ValueError("measurement is outside the registered arms or seeds")
        indexed[key] = row
    output = {"reference_arm": reference_arm, "registered_seeds": seeds, "completed_measurements": len(indexed), "expected_measurements": len(seeds) * len(arms), "comparisons": {}}
    for arm in arms:
        if arm == reference_arm:
            continue
        pairs, missing = [], []
        for seed in seeds:
            left, right = indexed.get((reference_arm, seed)), indexed.get((arm, seed))
            if left is None or right is None:
                missing.append(seed)
                continue
            pairs.append({"seed": seed, **paired_measurements(left["measurement"], right["measurement"])})
        invalid = [row["seed"] for row in pairs if not row["valid_pair"]]
        group_results = {}
        if not missing and not invalid:
            for group in sorted({task["group"] for row in pairs for task in row["tasks"] if task["group"]}):
                values = [statistics.fmean(task["delta"] for task in row["tasks"] if task["group"] == group) for row in pairs]
                group_results[group] = paired_bootstrap(values, repetitions=bootstrap_repetitions, seed=bootstrap_seed)
        output["comparisons"][arm] = {"pairs": pairs, "missing_seeds": missing, "invalid_pair_seeds": invalid, "score_gain": paired_bootstrap([row["delta"] for row in pairs], repetitions=bootstrap_repetitions, seed=bootstrap_seed) if not missing and not invalid else {"interval": None, "status": "incomplete_or_invalid_registered_pairs", "n": len(pairs)}, "groups": group_results, "interpretation": "Signed failures remain in paired scores. No claim of RSI effectiveness follows from fixed controls. Work units measure numerical work; model, wall-clock and instruction costs require their own receipts."}
    return output


def _provenance():
    files = [Path(__file__), *sorted((ROOT / "src" / "nexgent" / "science").glob("*.py"))]
    files += [ROOT / "src" / "nexgent" / "kernel" / name for name in ("programs.py", "runner.py", "worker.py")]
    sources = {str(path.relative_to(ROOT)).replace("\\", "/"): path.read_text(encoding="utf-8") for path in files}
    return {"python": sys.version, "executable": sys.executable, "platform": platform.platform(), "dependencies": {name: importlib.metadata.version(name) for name in ("numpy", "scipy")}, "sources": sources, "sources_digest": digest(sources)}


def baseline(args):
    from nexgent.kernel.programs import make_bundle
    from nexgent.kernel.runner import ProgramRunner
    from nexgent.science import ResearchBenchmark, seed_task_files, strong_baseline_files

    if len(set(args.seeds)) != len(args.seeds):
        raise ValueError("all registered seeds must be distinct")
    benchmark = ResearchBenchmark()
    created = utc_now()
    output = Path(args.output).resolve() if args.output else ROOT / ".nexgent" / "research-studies" / ("fixed-baselines-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".json")
    if output.exists():
        raise ValueError("refusing to overwrite an existing study receipt")
    output.parent.mkdir(parents=True, exist_ok=True)
    noop = "def improve(context, broker):\n    return {'candidates': []}\n"
    bundles = {name: make_bundle({**factory(), "meta.py": noop}, rationale="Frozen numerical control; no model calls or self-improvement") for name, factory in (("seed", seed_task_files), ("strong", strong_baseline_files))}
    protocol = {"kind": "fixed_numerical_controls", "registered_at": created, "seeds": args.seeds, "arms": ["seed", "strong"], "split": args.split, "max_work_units_per_measurement": args.max_work_units, "bootstrap_repetitions": args.bootstrap_repetitions, "bootstrap_seed": args.bootstrap_seed, "primary_statistic": "mean of strong-minus-seed mean-score differences across registered independent seeds", "interval_unit": "independent paired seed", "failure_handling": "retain failed tasks with evaluator score zero; no seed or task deletion; suppress intervals for missing or unpaired measurements", "run_order": [{"seed": seed, "arms": ["seed", "strong"] if index % 2 == 0 else ["strong", "seed"]} for index, seed in enumerate(args.seeds)], "selection_status": "development diagnostic, not confirmatory RSI evidence", "model_calls_authorized": False}
    receipt = {"schema": SCHEMA, "study_id": "fixed-" + digest(protocol)[:20], "status": "running", "created_at": created, "protocol": protocol, "protocol_digest": digest(protocol), "provenance": _provenance(), "evaluator_digest": benchmark.evaluator_digest, "bundles": bundles, "measurements": [], "errors": []}
    save_receipt(output, receipt)
    print(f"Registered protocol and output: {output}", flush=True)
    started = time.monotonic()
    try:
        for step in protocol["run_order"]:
            for arm in step["arms"]:
                before = time.monotonic()
                measurement = benchmark.evaluate(bundles[arm], args.split, step["seed"], ProgramRunner(), max_work_units=args.max_work_units)
                receipt["measurements"].append({"arm": arm, "seed": step["seed"], "completed_at": utc_now(), "wall_seconds": time.monotonic() - before, "measurement": measurement})
                receipt["summary"] = summarize(receipt, bootstrap_repetitions=args.bootstrap_repetitions, bootstrap_seed=args.bootstrap_seed)
                save_receipt(output, receipt)
                print(canonical({"arm": arm, "seed": step["seed"], "score": measurement["score"], "status": measurement["status"], "work_units": measurement["work_units"]}), flush=True)
        receipt["status"] = "completed"
    except KeyboardInterrupt:
        receipt["status"] = "interrupted"
    except Exception as exc:
        receipt["status"] = "failed"
        receipt["errors"].append(f"{type(exc).__name__}: {str(exc)[:1000]}")
    finally:
        receipt["completed_at"] = utc_now()
        receipt["wall_seconds"] = time.monotonic() - started
        receipt["summary"] = summarize(receipt, bootstrap_repetitions=args.bootstrap_repetitions, bootstrap_seed=args.bootstrap_seed)
        save_receipt(output, receipt)
    print(json.dumps({"output": str(output), "status": receipt["status"], "summary": receipt["summary"]}, ensure_ascii=False, allow_nan=False), flush=True)
    return 0 if receipt["status"] == "completed" else 1


def load_receipt(path):
    receipt = json.loads(Path(path).read_text(encoding="utf-8"))
    if receipt.get("schema") != SCHEMA:
        raise ValueError("unsupported export schema; a controller adapter must explicitly map paired measurements before summarization")
    if receipt.get("content_digest") != digest({key: value for key, value in receipt.items() if key != "content_digest"}):
        raise ValueError("study content digest does not match")
    if receipt.get("protocol_digest") != digest(receipt["protocol"]):
        raise ValueError("registered protocol digest does not match")
    return receipt


def summarize_command(args):
    receipt = load_receipt(args.input)
    summary = summarize(receipt, reference_arm=args.reference_arm, bootstrap_repetitions=args.bootstrap_repetitions, bootstrap_seed=args.bootstrap_seed)
    output = {"source_study_id": receipt["study_id"], "source_content_digest": receipt["content_digest"], "summary": summary}
    if args.output:
        path = Path(args.output)
        if path.exists():
            raise ValueError("refusing to overwrite a summary")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(output, ensure_ascii=False, allow_nan=False, indent=2), encoding="utf-8")
    print(json.dumps(output, ensure_ascii=False, allow_nan=False), flush=True)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    fixed = commands.add_parser("baseline", help="Run both frozen source controls without model calls")
    fixed.add_argument("--seeds", nargs="+", type=int, default=[0, 1, 2])
    fixed.add_argument("--split", default="development")
    fixed.add_argument("--max-work-units", type=int, default=20_000_000)
    fixed.add_argument("--output")
    fixed.set_defaults(function=baseline)
    summary = commands.add_parser("summarize", help="Recompute paired statistics from a verified study receipt")
    summary.add_argument("input")
    summary.add_argument("--reference-arm", default="seed")
    summary.add_argument("--output")
    summary.set_defaults(function=summarize_command)
    for command in (fixed, summary):
        command.add_argument("--bootstrap-repetitions", type=int, default=10_000)
        command.add_argument("--bootstrap-seed", type=int, default=713)
    args = parser.parse_args()
    if not 100 <= args.bootstrap_repetitions <= 1_000_000:
        parser.error("bootstrap repetitions must be between 100 and 1,000,000")
    if hasattr(args, "max_work_units") and args.max_work_units <= 0:
        parser.error("max work units must be positive")
    try:
        return args.function(args)
    except (ValueError, OSError, KeyError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    raise SystemExit(main())
