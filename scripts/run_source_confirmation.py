"""One registered, independent numerical confirmation of frozen source exports.

Validate registration without any numerical evaluation:
  python scripts/run_source_confirmation.py --check-only
Later, after every arm is frozen, explicitly run with all exports:
  python scripts/run_source_confirmation.py exports/*.json --output-prefix results/confirmation
Resume only unadmitted measurements with the same exports and --resume.
This script never creates a controller or model gateway and never edits a study.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import glob
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import signal
import statistics
import sys
import threading
import time

from run_research_study import paired_bootstrap, paired_measurements


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
DEFAULT_PLAN = ROOT / "docs/research/confirmation-plan-20260916.json"
REGISTERED_PLAN_DIGEST = "a34e83877f9cc4de81f6003b40b6c4944e13c217b6ad7fb1af7442d4f1a2c0c7"
RESOURCE_STATUSES = {"timeout", "interrupted", "stopped", "budget_exhausted", "missing"}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def read_json(path):
    data = Path(path).read_bytes()
    def reject(value):
        raise ValueError("nonfinite JSON constant " + value)
    return json.loads(data.decode("utf-8-sig"), parse_constant=reject), hashlib.sha256(data).hexdigest()


def load_plan(path, expected_digest=REGISTERED_PLAN_DIGEST):
    plan, file_digest = read_json(path)
    computed = digest({key: value for key, value in plan.items() if key != "content_digest"})
    if plan.get("content_digest") != computed or computed != expected_digest:
        raise ValueError("confirmation registration hash does not match the expected registered digest")
    if plan.get("schema") != "nexgent-confirmation-plan-v1" or plan.get("model_calls_allowed") != 0:
        raise ValueError("unsupported confirmation plan")
    if not plan.get("seeds") or len(set(plan["seeds"])) != len(plan["seeds"]):
        raise ValueError("registered replication seeds must be nonempty and distinct")
    if datetime.fromisoformat(plan["registered_at"]) >= datetime.now(timezone.utc):
        raise ValueError("registration must predate confirmation execution")
    return plan, file_digest


def implementation_snapshot():
    source = ROOT / "src/nexgent"
    files = {str(path.relative_to(source)): path.read_text(encoding="utf-8") for folder in ("kernel", "science", "agents", "models", "evolution", "research") for path in sorted((source / folder).glob("*.py"))}
    versions = {package: importlib.metadata.version(package) for package in ("numpy", "scipy", "openai")}
    return {"files": files, "versions": versions, "digest": digest({"files": files, "versions": versions}), "python": sys.version, "executable": sys.executable}


def freeze_exports(paths, plan, implementation):
    """Validate and freeze ALL enrolled sources before constructing a benchmark."""
    from nexgent.kernel.programs import verify_bundle
    entries = []
    occupied = set()
    for path in paths:
        payload, sha = read_json(path)
        if payload.get("schema") != "nexgent-study-v1":
            raise ValueError(f"{path}: not a controller export")
        study = payload["study"]
        if study.get("kind") == "meta_evaluation" or study.get("status") != "completed":
            raise ValueError(f"{path}: all source studies must be completed before enrollment")
        if study.get("arm") not in plan["required_arms"] or type(study.get("seed")) is not int:
            raise ValueError(f"{path}: invalid study arm or evolution seed")
        key = (study["arm"], study["seed"])
        if key in occupied:
            raise ValueError("duplicate arm/evolution-seed exports cannot be selected after inspection")
        occupied.add(key)
        if study.get("implementation_digest") != implementation["digest"]:
            raise ValueError(f"{path}: frozen study implementation differs from this environment")
        bundles = {bundle["id"]: bundle for bundle in payload["bundles"]}
        initial, selected = bundles[study["initial_program"]], bundles[study["active_program"]]
        verify_bundle(initial); verify_bundle(selected)
        accepted = [row for row in study.get("evaluations", []) if row.get("accepted")]
        expected = accepted[-1]["candidate_id"] if accepted else initial["id"]
        if selected["id"] != expected:
            raise ValueError("active_program is not the last selection-promoted source")
        entries.append({"study_id": study["id"], "arm": study["arm"], "evolution_seed": study["seed"], "export_path": str(Path(path).resolve()), "export_sha256": sha, "initial": initial, "selected": selected, "study_protocol": study["protocol"], "study_budget": study["budget"], "study_question": study["question"], "max_generations": study["max_generations"], "evaluator_digest": study["evaluator_digest"], "implementation_digest": study["implementation_digest"], "model_configuration_digest": digest(study.get("model_configuration")), "source_study_usage": study.get("usage", {}), "selection_rule": "frozen export active_program; no confirmation selection"})
    if not entries:
        raise ValueError("all required source exports are needed")
    evolution_seeds = sorted({entry["evolution_seed"] for entry in entries})
    for seed in evolution_seeds:
        group = [entry for entry in entries if entry["evolution_seed"] == seed]
        if {entry["arm"] for entry in group} != set(plan["required_arms"]):
            raise ValueError(f"evolution seed {seed}: required arms are not all frozen")
        for field in ("study_protocol", "study_budget", "study_question", "max_generations", "evaluator_digest", "implementation_digest", "model_configuration_digest"):
            if len({canonical(entry[field]) for entry in group}) != 1:
                raise ValueError(f"evolution seed {seed}: unmatched {field}")
        if len({entry["initial"]["digest"] for entry in group}) != 1:
            raise ValueError("arms do not share the same initial source")
    return sorted(entries, key=lambda entry: (entry["evolution_seed"], plan["required_arms"].index(entry["arm"])))


def make_schedule(enrollment, plan):
    schedule = []
    for index, seed in enumerate(plan["seeds"]):
        ordered = enrollment if index % 2 == 0 else list(reversed(enrollment))
        for entry_index, entry in enumerate(ordered):
            for component in (("initial", "selected") if (index + entry_index) % 2 == 0 else ("selected", "initial")):
                identity = {"study_id": entry["study_id"], "component": component, "replication_seed": seed, "source_digest": entry[component]["digest"]}
                schedule.append({"id": digest(identity), **identity, "arm": entry["arm"], "evolution_seed": entry["evolution_seed"], "status": "planned", "measurement": None})
    return schedule


def valid_measurement(row):
    report = row.get("measurement")
    return row.get("status") == "measured" and isinstance(report, dict) and report.get("score_available", True) and report.get("status") not in RESOURCE_STATUSES and bool(report.get("tasks")) and all(task.get("score_available", True) and task.get("status") not in RESOURCE_STATUSES for task in report["tasks"])


def summary(receipt):
    plan = receipt["plan"]
    indexed = {(row["study_id"], row["component"], row["replication_seed"]): row for row in receipt["measurements"]}
    studies = []
    for entry in receipt["enrollment"]:
        pairs, missing = [], []
        for seed in plan["seeds"]:
            left, right = [indexed[(entry["study_id"], component, seed)] for component in ("initial", "selected")]
            if not valid_measurement(left) or not valid_measurement(right):
                missing.append({"replication_seed": seed, "initial_status": left["status"], "selected_status": right["status"]})
                continue
            pair = paired_measurements(left["measurement"], right["measurement"])
            pairs.append({"replication_seed": seed, **pair})
            if not pair["valid_pair"]:
                missing.append({"replication_seed": seed, "issues": pair["issues"]})
        groups = {group: statistics.fmean(task["delta"] for pair in pairs for task in pair["tasks"] if task["group"] == group) for group in {task["group"] for pair in pairs for task in pair["tasks"]} if group} if pairs and not missing else {}
        studies.append({"study_id": entry["study_id"], "arm": entry["arm"], "evolution_seed": entry["evolution_seed"], "initial_source": entry["initial"]["digest"], "selected_source": entry["selected"]["digest"], "pairs": pairs, "missing": missing, "mean_gain": statistics.fmean(pair["delta"] for pair in pairs) if pairs and not missing else None, "group_mean_gains": groups, "replication_seed_count": len(plan["seeds"]), "independent_evolution_seed_count": 1, "interval": None})
    comparisons = {}
    for control in ("task_only", "greedy"):
        per_evolution_seed, missing = [], []
        for evolution_seed in sorted({entry["evolution_seed"] for entry in receipt["enrollment"]}):
            arms = {entry["arm"]: entry for entry in receipt["enrollment"] if entry["evolution_seed"] == evolution_seed}
            pairs = []
            for replication_seed in plan["seeds"]:
                reference = indexed[(arms[control]["study_id"], "selected", replication_seed)]
                candidate = indexed[(arms["full"]["study_id"], "selected", replication_seed)]
                if not valid_measurement(reference) or not valid_measurement(candidate):
                    missing.append({"evolution_seed": evolution_seed, "replication_seed": replication_seed, "reason": "missing_measurement"})
                    continue
                pair = paired_measurements(reference["measurement"], candidate["measurement"])
                pairs.append({"replication_seed": replication_seed, **pair})
                if not pair["valid_pair"]:
                    missing.append({"evolution_seed": evolution_seed, "replication_seed": replication_seed, "reason": pair["issues"]})
            complete = len(pairs) == len(plan["seeds"]) and all(pair["valid_pair"] for pair in pairs)
            per_evolution_seed.append({"evolution_seed": evolution_seed, "pairs": pairs, "complete": complete, "mean_delta": statistics.fmean(pair["delta"] for pair in pairs) if complete else None})
        values = [row["mean_delta"] for row in per_evolution_seed if row["complete"]]
        stats = paired_bootstrap(values, repetitions=plan["bootstrap"]["repetitions"], seed=plan["bootstrap"]["seed"]) if not missing else {"n": len(values), "interval": None, "mean_observed_only": statistics.fmean(values) if values else None, "status": "missing_registered_pairs"}
        stats["resampling_unit"] = "independent evolution seed; average the registered transfer-replication seeds within each study first"
        comparisons["full_minus_" + control] = {"per_evolution_seed": per_evolution_seed, "statistics": stats, "missing": missing}
    reports = [row["measurement"] for row in receipt["measurements"] if isinstance(row.get("measurement"), dict)]
    return {"studies": studies, "comparisons": comparisons, "planned_measurements": len(receipt["measurements"]), "admitted_measurements": sum(row["status"] != "planned" for row in receipt["measurements"]), "terminal_measurements": sum(row["status"] in {"measured", "missing"} for row in receipt["measurements"]), "work_units_from_reports": sum(report.get("work_units", 0) for report in reports), "unknown_work_measurements": [row["id"] for row in receipt["measurements"] if row["status"] not in {"planned", "measured"} and not isinstance(row.get("measurement"), dict)], "model_calls": 0, "interpretation": "These three seeds are transfer replications conditional on frozen source. They are not three independent RSI evolutions. No confirmation score chooses a champion, changes the enrollment or enters a source-study ledger."}


def markdown(receipt):
    lines = ["# 源码 RSI 独立确认", "", f"计划：`{receipt['plan']['plan_id']}`；状态：{receipt['status']}。", "", f"Split：`{receipt['plan']['split']}`；复现 seeds：{receipt['plan']['seeds']}。", "", "这些是冻结程序的迁移复现种子，不是独立演化种子；确认结果没有用于选择或替换冠军。", "", "| Study | Arm | 演化 seed | 完整复现配对 | 均分增益 | 缺测 |", "| --- | --- | ---: | ---: | ---: | ---: |"]
    for row in receipt["summary"]["studies"]:
        lines.append(f"| {row['study_id']} | {row['arm']} | {row['evolution_seed']} | {len(row['pairs'])}/{len(receipt['plan']['seeds'])} | {row['mean_gain'] if row['mean_gain'] is not None else '缺失'} | {len(row['missing'])} |")
    lines += ["", "## 跨实验臂比较", ""]
    for name, comparison in receipt["summary"]["comparisons"].items():
        stat = comparison["statistics"]
        lines += [f"### {name}", "", f"独立演化 seed n={stat.get('n',0)}；均差={stat.get('mean',stat.get('mean_observed_only'))}；区间={stat.get('interval')}；状态={stat.get('status')}。", "", f"缺测：`{canonical(comparison['missing'])}`。", ""]
    lines += ["## 成本与完整性", "", f"计划 measurement {receipt['summary']['planned_measurements']}；已终结 {receipt['summary']['terminal_measurements']}；报告数值工作 {receipt['summary']['work_units_from_reports']}；模型调用 0。", "", "完整 JSON 保留每个计划测量、全部任务及分组误差、工作进程回执、源码/导出/运行环境摘要、失败和未知成本。", "", "中断或失败的已准入测量不会重试；恢复只执行尚未准入的测量。未完成测量不作为观察到的零分。", ""]
    return "\n".join(lines)


def save_receipt(path, receipt):
    receipt["summary"] = summary(receipt)
    receipt["content_digest"] = digest({key: value for key, value in receipt.items() if key != "content_digest"})
    temporary = Path(str(path) + ".tmp")
    temporary.write_text(json.dumps(receipt, ensure_ascii=False, allow_nan=False, indent=2), encoding="utf-8")
    temporary.replace(path)
    path.with_suffix(".md").write_text(markdown(receipt), encoding="utf-8")


@contextmanager
def execution_lock(path):
    with path.open("a+b") as handle:
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


def execute(paths, plan, plan_file_digest, output, resume=False):
    implementation = implementation_snapshot()
    enrollment = freeze_exports(paths, plan, implementation)
    manifest = {"plan_digest": plan["content_digest"], "enrollment": enrollment, "implementation_digest": implementation["digest"]}
    manifest_digest = digest(manifest)
    marker_root = ROOT / ".nexgent/confirmations"
    marker_root.mkdir(parents=True, exist_ok=True)
    marker = marker_root / (plan["plan_id"] + ".registration.json")
    output = Path(str(Path(output).resolve()) + ".json")
    output.parent.mkdir(parents=True, exist_ok=True)
    with execution_lock(marker.with_suffix(".lock")):
        if resume:
            used, _ = read_json(marker)
            receipt, _ = read_json(output)
            if used != {"manifest_digest": manifest_digest, "output": str(output)} or receipt.get("manifest_digest") != manifest_digest or receipt.get("content_digest") != digest({key: value for key, value in receipt.items() if key != "content_digest"}):
                raise ValueError("resume requires the identical frozen enrollment, environment and intact receipt")
            if receipt.get("script_sha256") != hashlib.sha256(Path(__file__).read_bytes()).hexdigest():
                raise ValueError("confirmation script changed; do not resume under different execution rules")
            if receipt["status"] == "completed":
                return receipt, output
            for row in receipt["measurements"]:
                if row["status"] == "admitted":
                    row.update(status="missing", failure_kind="interrupted", error="Previously admitted process had no committed result; it is not retried", completed_at=now())
        else:
            if marker.exists() or output.exists() or output.with_suffix(".md").exists():
                raise ValueError("registration/output already used; do not rerun confirmation or change enrollment")
            receipt = {"schema": "nexgent-source-confirmation-v1", "status": "registered", "created_at": now(), "plan": plan, "plan_file_sha256": plan_file_digest, "enrollment": enrollment, "manifest_digest": manifest_digest, "implementation": implementation, "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "measurements": make_schedule(enrollment, plan), "errors": [], "model_calls": 0}
            # Persist complete enrollment before constructing any scientific cases.
            save_receipt(output, receipt)
            with marker.open("x", encoding="utf-8") as handle:
                json.dump({"manifest_digest": manifest_digest, "output": str(output)}, handle, ensure_ascii=False)
        from nexgent.kernel.runner import ProgramRunner
        from nexgent.science import ResearchBenchmark
        benchmark = ResearchBenchmark()
        if any(entry["evaluator_digest"] != benchmark.evaluator_digest for entry in enrollment):
            raise ValueError("confirmation evaluator differs from the frozen study evaluator")
        bundles = {(entry["study_id"], component): entry[component] for entry in enrollment for component in ("initial", "selected")}
        user_stop = threading.Event()
        active_stop = [None]
        def stop(signum, frame):
            user_stop.set()
            if active_stop[0] is not None:
                active_stop[0].set()
        previous_handler = signal.signal(signal.SIGINT, stop)
        started = time.monotonic()
        receipt["status"] = "running"
        try:
            for row in receipt["measurements"]:
                if row["status"] != "planned" or user_stop.is_set():
                    continue
                if implementation_snapshot()["digest"] != implementation["digest"]:
                    raise ValueError("implementation changed during confirmation")
                row.update(status="admitted", admitted_at=now(), max_work_units=plan["max_work_units_per_measurement"])
                save_receipt(output, receipt)
                active_stop[0] = threading.Event()
                before = time.monotonic()
                try:
                    measured = benchmark.evaluate(bundles[(row["study_id"], row["component"])], plan["split"], row["replication_seed"], ProgramRunner(), stop_event=active_stop[0], max_work_units=plan["max_work_units_per_measurement"])
                    row.update(status="missing" if measured.get("score_available") is False or measured.get("status") in RESOURCE_STATUSES else "measured", measurement=measured, failure_kind=measured.get("failure_kind"))
                except Exception as exc:
                    row.update(status="missing", error=f"{type(exc).__name__}: {str(exc)[:1200]}", failure_kind="execution_unavailable")
                row.update(completed_at=now(), wall_seconds=time.monotonic() - before)
                save_receipt(output, receipt)
                print(canonical({key: row.get(key) for key in ("study_id", "arm", "component", "replication_seed", "status", "wall_seconds")}), flush=True)
            receipt["status"] = "paused" if user_stop.is_set() else "completed"
        except Exception as exc:
            receipt["status"] = "failed"
            receipt["errors"].append(f"{type(exc).__name__}: {str(exc)[:1200]}")
        finally:
            signal.signal(signal.SIGINT, previous_handler)
            receipt["updated_at"] = now()
            receipt["wall_seconds"] = receipt.get("wall_seconds", 0) + time.monotonic() - started
            save_receipt(output, receipt)
        return receipt, output


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("exports", nargs="*")
    parser.add_argument("--plan", type=Path, default=DEFAULT_PLAN)
    parser.add_argument("--plan-digest", default=REGISTERED_PLAN_DIGEST)
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--output-prefix")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    try:
        plan, plan_file_digest = load_plan(args.plan, args.plan_digest)
        paths = [path for pattern in args.exports for path in (sorted(glob.glob(pattern)) if glob.has_magic(pattern) else [pattern]) or [pattern]]
        if args.check_only:
            entries = freeze_exports(paths, plan, implementation_snapshot()) if paths else []
            print(canonical({"plan_id": plan["plan_id"], "plan_digest": plan["content_digest"], "status": "validated_without_execution", "source_exports_checked": len(entries), "confirmation_measurements_run": 0, "model_calls": 0}))
            return 0
        if not paths or not args.output_prefix:
            parser.error("execution requires all frozen exports and --output-prefix; use --check-only to inspect registration")
        receipt, output = execute(paths, plan, plan_file_digest, args.output_prefix, args.resume)
        print(canonical({"json": str(output), "markdown": str(output.with_suffix('.md')), "status": receipt["status"], "content_digest": receipt["content_digest"]}))
        return 0 if receipt["status"] == "completed" else 1
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    raise SystemExit(main())
