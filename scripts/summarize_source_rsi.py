"""Read-only, failure-preserving reports for controller exports.

Example: .venv/Scripts/python.exe scripts/summarize_source_rsi.py exports/*.json
         --output-prefix .nexgent/reports/source-rsi --expected-seeds 0 1 2
Only exported evidence is read. No controller, model gateway or evaluator runs.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import glob
import json
import math
from pathlib import Path
import statistics

from run_research_study import paired_bootstrap, paired_measurements


ARMS = ("full", "task_only", "greedy")


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def read_json(path):
    data = Path(path).read_bytes()
    def reject(value):
        raise ValueError("nonfinite JSON constant " + value)
    return json.loads(data.decode("utf-8-sig"), parse_constant=reject), hashlib.sha256(data).hexdigest()


def checked_measurement(value):
    if not isinstance(value, dict) or not number(value.get("score")):
        raise ValueError("measurement has no finite score")
    if value.get("status") in {"timeout", "interrupted", "stopped", "budget_exhausted", "missing"} or value.get("score_available") is False:
        raise ValueError("resource-limited measurement is missing, not an observed zero")
    tasks = value.get("tasks")
    if not isinstance(tasks, list):
        raise ValueError("measurement has no task list")
    for row in tasks:
        if not isinstance(row, dict) or not isinstance(row.get("task_id"), str) or not number(row.get("score")) or not number(row.get("nrmse")) or not isinstance(row.get("status"), str):
            raise ValueError("malformed task measurement")
        if row.get("status") in {"timeout", "interrupted", "stopped", "budget_exhausted", "missing"} or row.get("score_available") is False:
            raise ValueError("resource-limited task is missing")
    return value


def cost_summary(study):
    calls = study.get("calls", [])
    by_id, anonymous, duplicates = {}, [], []
    for receipt in calls if isinstance(calls, list) else []:
        if not isinstance(receipt, dict) or not isinstance(receipt.get("call_id"), str):
            anonymous.append(receipt)
            continue
        key = receipt["call_id"]
        if key in by_id:
            duplicates.append(key)
            # Exported calls should be terminal unique records; preserve ambiguity.
            continue
        by_id[key] = receipt
    known = {key: 0 for key in ("prompt_tokens", "completion_tokens", "total_tokens")}
    missing_usage, missing_reservations = [], []
    reservations = 0
    for identity, call in by_id.items():
        usage = call.get("usage", {})
        for field in known:
            if isinstance(usage, dict) and number(usage.get(field)) and usage[field] >= 0:
                known[field] += usage[field]
        if not isinstance(usage, dict) or not number(usage.get("total_tokens")):
            missing_usage.append(identity)
        reservation = call.get("reserved_completion_tokens", call.get("max_completion_tokens", call.get("max_tokens")))
        if number(reservation) and reservation >= 0:
            reservations += reservation
        else:
            missing_reservations.append(identity)
    usage = study.get("usage", {})
    events = study.get("events", [])
    measured = [event.get("content", {}) for event in events if isinstance(event, dict) and event.get("kind") == "measurement"]
    reused = [event.get("content", {}) for event in events if isinstance(event, dict) and event.get("kind") == "measurement_reused"]
    reported_work = usage.get("numeric_work_units", study.get("numeric_work_units"))
    event_work = [row.get("evidence", {}).get("work_units") for row in measured]
    return {"model_calls_with_identity": len(by_id), "call_statuses": dict(Counter(call.get("status", "unknown") for call in by_id.values())), "model_ids": sorted({str(call.get("model", "unknown")) for call in by_id.values()}), "received_call_fraction": sum(call.get("status") == "received" for call in by_id.values()) / len(by_id) if by_id else None, "reported_usage_known": known, "usage_missing_call_ids": missing_usage, "reserved_completion_tokens_known": reservations, "reservation_missing_call_ids": missing_reservations, "duplicate_call_ids": duplicates, "anonymous_calls": anonymous, "reported_evaluation_count": usage.get("evaluations", study.get("evaluation_count")), "reported_numeric_work_units": reported_work if number(reported_work) else None, "reported_physical_numeric_work_units": usage.get("physical_numeric_work_units", study.get("physical_numeric_work_units")), "measurement_event_work_units_known": sum(value for value in event_work if number(value)), "measurement_events_missing_work": sum(not number(value) for value in event_work), "measurement_reuse_events": reused, "cache_fairness_warning": any("logical_work_units" not in row for row in reused), "cached_logical_work_units_known": sum(row["logical_work_units"] for row in reused if number(row.get("logical_work_units"))), "source_call_receipts": list(by_id.values()), "billing": "Monetary cost is unavailable unless explicitly provided by a billing source; reported tokens and reservations are distinct.", "accounting": "Use each study's logical/physical ledger once; do not add nested receipts. Meta-study cost is separate. Older cache events without logical charges may make study totals order-dependent."}


def validity_summary(study):
    failures = study.get("research", {}).get("failures", [])
    evaluations = study.get("evaluations", [])
    events = study.get("events", [])
    generated = [event.get("content", {}) for event in events if event.get("kind") == "offspring_generated"]
    ids = {identity for row in generated for identity in row.get("candidate_ids", [])}
    invalid = [row for row in failures if row.get("type") == "invalid_source" or row.get("kind") == "invalid_source"]
    valid_count = len(ids)
    numerical = sum(row.get("measurement", {}).get("status") == "ok" for row in evaluations)
    return {"source_candidates_generated": valid_count, "invalid_source_proposals": len(invalid), "source_validity_fraction": valid_count / (valid_count + len(invalid)) if valid_count + len(invalid) else None, "candidate_evaluations": len(evaluations), "numerically_valid_evaluations": numerical, "numerical_validity_fraction": numerical / len(evaluations) if evaluations else None, "promotions": sum(bool(row.get("accepted")) for row in evaluations), "generation_executions": len(generated), "failures": failures, "denominator_scope": "Source validity counts returned proposals inspected by the host. Provider/source failures before a candidate return remain separate failures, not missing successful proposals."}


def load_study(path):
    row = {"path": str(Path(path).resolve()), "input_status": "invalid", "issues": [], "final_rows": [], "meta_entries": []}
    try:
        payload, row["file_sha256"] = read_json(path)
        if not isinstance(payload, dict) or payload.get("schema") != "nexgent-study-v1" or not isinstance(payload.get("study"), dict):
            raise ValueError("expected controller export schema nexgent-study-v1")
        study = payload["study"]
        required = ("id", "arm", "seed", "status", "budget", "protocol", "initial_program", "active_program")
        if any(key not in study for key in required):
            raise ValueError("export is missing a required study field")
        if study["arm"] not in ARMS or type(study["seed"]) is not int:
            raise ValueError("invalid arm or study seed")
        row.update(input_status="loaded", study_id=study["id"], arm=study["arm"], seed=study["seed"], status=study["status"], question=study.get("question"), generation=study.get("generation"), max_generations=study.get("max_generations"), budget=study["budget"], protocol=study["protocol"], evaluator_digest=study.get("evaluator_digest"), initial_program=study["initial_program"], active_program=study["active_program"], research_program=study.get("research_program"), last_error=study.get("last_error"), conclusion=study.get("conclusion", {}), costs=cost_summary(study), validity=validity_summary(study))
        row.update(kind=study.get("kind", "source_rsi"), implementation_digest=study.get("implementation_digest"), model_configuration=study.get("model_configuration"))
        bundles = {bundle["id"]: bundle for bundle in payload.get("bundles", [])}
        row["bundle_digests"] = {identity: bundle.get("digest") for identity, bundle in bundles.items()}
        for identity, bundle in bundles.items():
            if digest(bundle["files"]) != bundle.get("digest"):
                row["issues"].append("source_digest_mismatch:" + identity)
        if study["initial_program"] not in bundles or study["active_program"] not in bundles:
            row["issues"].append("missing_initial_or_selected_source_bundle")
        if study["status"] != "completed":
            row["issues"].append("study_not_completed")
        seen = set()
        for final in study.get("conclusion", {}).get("final_transfer", []):
            record = {"seed": final.get("seed"), "valid": False, "issues": []}
            try:
                if type(final.get("seed")) is not int or final["seed"] in seen:
                    raise ValueError("duplicate or invalid final seed")
                seen.add(final["seed"])
                initial, selected = checked_measurement(final.get("initial")), checked_measurement(final.get("selected"))
                record.update(initial=initial, selected=selected, paired=paired_measurements(initial, selected))
                if any(m.get("split") != "final_transfer" or m.get("seed") != final["seed"] for m in (initial, selected)):
                    raise ValueError("final transfer split or seed does not match")
                if not record["paired"]["valid_pair"]:
                    raise ValueError(";".join(record["paired"]["issues"]))
                record["valid"] = True
            except (ValueError, KeyError, TypeError) as exc:
                record["issues"].append(str(exc))
            row["final_rows"].append(record)
        expected = {study["seed"] + offset for offset in (101, 202, 303)} if row["kind"] != "meta_evaluation" else set()
        row["expected_final_seeds"] = sorted(expected)
        row["missing_final_seeds"] = sorted(expected - seen)
        if seen - expected:
            row["issues"].append("unexpected_final_seed_schedule")
        if row["missing_final_seeds"]:
            row["issues"].append("missing_final_transfer")
        if any(not item["valid"] for item in row["final_rows"]):
            row["issues"].append("invalid_final_transfer_pair")
        for field in ("meta_evaluation", "meta_evaluations"):
            value = study.get(field)
            if value is not None:
                row["meta_entries"].extend(value if isinstance(value, list) else [value])
        embedded_meta = study.get("conclusion", {}).get("meta_evaluation")
        if embedded_meta is not None:
            row["meta_entries"].append(embedded_meta)
        row["meta_study_id"] = study.get("conclusion", {}).get("meta_study_id")
        row["event_types"] = dict(Counter(event.get("kind", "unknown") for event in study.get("events", [])))
        row["evidence_limitations"] = ["Export content has a report-time file digest, not a historical signature or attestation.", "A changed meta/workflow source is not evidence that a changed improver produced useful descendants; inspect execution lineage and the separate meta assay.", "Repeated selection-batch feedback is adaptive development evidence; final transfer is the relevant frozen-program comparison."]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        row["issues"].append(f"{type(exc).__name__}: {exc}")
    return row


def compare_studies(candidate, reference):
    issues = []
    for key in ("seed", "question", "budget", "protocol", "evaluator_digest", "max_generations", "implementation_digest", "model_configuration"):
        if candidate.get(key) != reference.get(key):
            issues.append("different_" + key)
    left_initial = reference.get("bundle_digests", {}).get(reference.get("initial_program"))
    right_initial = candidate.get("bundle_digests", {}).get(candidate.get("initial_program"))
    if not left_initial or left_initial != right_initial:
        issues.append("different_or_missing_initial_source")
    if candidate.get("issues") or reference.get("issues"):
        issues.append("study_has_missing_or_invalid_evidence")
    if not candidate.get("implementation_digest") or not reference.get("implementation_digest"):
        issues.append("missing_frozen_implementation_identity")
    left = {row["seed"]: row for row in reference.get("final_rows", []) if row["valid"]}
    right = {row["seed"]: row for row in candidate.get("final_rows", []) if row["valid"]}
    if not left or set(left) != set(right):
        issues.append("unpaired_final_seeds")
    cases = []
    for seed in sorted(set(left) & set(right)):
        pair = paired_measurements(left[seed]["selected"], right[seed]["selected"])
        if not pair["valid_pair"]:
            issues.extend(pair["issues"])
        for task in pair["tasks"]:
            cases.append({"transfer_seed": seed, **task})
    delta = statistics.fmean(row["delta"] for row in cases) if cases else None
    groups = {group: statistics.fmean(row["delta"] for row in cases if row["group"] == group) for group in {row["group"] for row in cases} if group}
    return {"study_seed": candidate["seed"], "candidate_id": candidate["study_id"], "reference_id": reference["study_id"], "valid": not issues, "issues": issues, "mean_delta": delta, "groups": groups, "cases": cases, "costs": {"candidate": candidate["costs"], "reference": reference["costs"]}}


def aggregate_differences(values, missing, repetitions, seed, unit):
    if missing:
        return {"n": len(values), "mean_observed_only": statistics.fmean(values) if values else None, "interval": None, "status": "missing_registered_pairs_no_interval", "missing": missing, "resampling_unit": unit}
    result = paired_bootstrap(values, repetitions=repetitions, seed=seed)
    result["resampling_unit"] = unit
    return result


def meta_summary(value, source):
    result = {"source": source, "status": "missing_or_invalid", "issues": [], "interval": None}
    if isinstance(value, dict) and "report" in value and isinstance(value["report"], dict):
        value = value["report"]
    if not isinstance(value, dict) or value.get("protocol", {}).get("name") != "frozen_improver_task_output_at_k":
        result["issues"].append("No recognized actual-offspring evaluation report; source-change flags or placeholder prose are not meta evidence")
        result["provided_value"] = value
        return result
    pairs = value.get("per_seed_pairs", [])
    if not isinstance(pairs, list) or any(not isinstance(row, dict) for row in pairs):
        result["issues"].append("Malformed meta per-seed measurements")
        return result
    missing = [row.get("seed") for row in pairs if row.get("status") != "complete" or not number(row.get("difference"))]
    requested = value.get("protocol", {}).get("seeds", [])
    absent = sorted(set(requested) - {row.get("seed") for row in pairs})
    missing += absent
    if len({row.get("seed") for row in pairs}) != len(pairs):
        missing.append("duplicate_meta_seed")
    evidence_missing = value.get("evidence", {}).get("missing", [])
    if evidence_missing:
        missing.append("missing_execution_or_cost_evidence")
    values = [row["difference"] for row in pairs if row.get("status") == "complete" and number(row.get("difference"))]
    result.update(status="complete" if not missing and values else "incomplete", meta_study_id=value.get("meta_study_id"), ledger_usage=value.get("ledger_usage"), registered_generation_budget=value.get("registered_generation_budget"), protocol=value["protocol"], origins=value.get("origins"), per_seed_pairs=pairs, arms=value.get("arms", []), failures=value.get("failures", []), costs=value.get("costs", {}), evidence=value.get("evidence", {}), cross_attribution=value.get("cross_attribution"), statistics=aggregate_differences(values, missing, 10_000, 713, "meta task-instance seed conditional on these frozen programs; not independent evolution seeds"), interpretation="Actual frozen-improver offspring productivity is separate from final task quality. Its meta-study ledger is not added to or double-counted with source-study usage. Equal offspring k does not establish equal model or numerical budget. Resource failures and unavailable usage remain explicit.")
    return result


def confirmation_summary(path):
    result = {"path": str(Path(path).resolve()), "status": "invalid", "issues": []}
    try:
        value, result["file_sha256"] = read_json(path)
        if value.get("schema") != "nexgent-source-confirmation-v1":
            raise ValueError("unknown independent confirmation schema")
        if value.get("content_digest") != digest({key: item for key, item in value.items() if key != "content_digest"}):
            raise ValueError("confirmation receipt digest mismatch")
        plan = value["plan"]
        if plan.get("content_digest") != digest({key: item for key, item in plan.items() if key != "content_digest"}):
            raise ValueError("embedded confirmation registration digest mismatch")
        result.update(status=value["status"], plan_id=plan["plan_id"], plan_digest=plan["content_digest"], split=plan["split"], transfer_replication_seeds=plan["seeds"], evolution_seeds=sorted({entry["evolution_seed"] for entry in value["enrollment"]}), summary=value["summary"], manifest_digest=value["manifest_digest"], errors=value.get("errors", []), measurement_statuses=[{key: row.get(key) for key in ("id", "study_id", "arm", "component", "evolution_seed", "replication_seed", "status", "failure_kind", "error", "wall_seconds")} for row in value["measurements"]], model_calls=value.get("model_calls"), interpretation="The registered seeds are independent transfer-replication batches conditional on frozen programs. They are not independent evolution seeds; n=1 evolution has no RSI-effect confidence interval. Confirmation scores do not choose champions or feed source-study context.")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        result["issues"].append(f"{type(exc).__name__}: {exc}")
    return result


def build_report(paths, *, expected_arms=ARMS, expected_seeds=None, meta_paths=(), confirmation_paths=(), repetitions=10_000, bootstrap_seed=713):
    studies = [load_study(path) for path in paths]
    loaded = [row for row in studies if row["input_status"] == "loaded" and row["kind"] != "meta_evaluation"]
    seeds = list(expected_seeds) if expected_seeds is not None else sorted({row["seed"] for row in loaded})
    cells = {(arm, seed): [row for row in loaded if row["arm"] == arm and row["seed"] == seed] for arm in expected_arms for seed in seeds}
    coverage = [{"arm": arm, "seed": seed, "study_ids": [row["study_id"] for row in entries], "status": "missing" if not entries else "duplicate" if len(entries) > 1 else entries[0]["status"]} for (arm, seed), entries in cells.items()]
    comparisons = {}
    for reference in ("task_only", "greedy"):
        if "full" not in expected_arms or reference not in expected_arms:
            continue
        pairs = []
        missing = [{"input": row["path"], "reason": "unreadable_input_cannot_assign_study_seed"} for row in studies if row["input_status"] != "loaded"]
        for seed in seeds:
            full, control = cells[("full", seed)], cells[(reference, seed)]
            if len(full) != 1 or len(control) != 1:
                missing.append({"seed": seed, "reason": "missing_or_duplicate_study"})
                continue
            pair = compare_studies(full[0], control[0]); pairs.append(pair)
            if not pair["valid"]:
                missing.append({"seed": seed, "reason": pair["issues"]})
        values = [row["mean_delta"] for row in pairs if row["valid"] and number(row["mean_delta"])]
        comparisons["full_minus_" + reference] = {"pairs": pairs, "statistics": aggregate_differences(values, missing, repetitions, bootstrap_seed, "independent study/evolution seed; transfer cases are nested within each study"), "missing_or_invalid": missing, "groups": {group: aggregate_differences([row["groups"][group] for row in pairs if row["valid"] and group in row["groups"]], missing, repetitions, bootstrap_seed, "independent study/evolution seed") for group in ("in_family", "different_family")}, "interpretation": "task_only freezes non-task source files; shared workflow/task helpers can confound a pure improver-only causal contrast. greedy changes archive exploration. Report these implemented file/control-flow ablations precisely."}
    meta = []
    for study in [row for row in studies if row["input_status"] == "loaded"]:
        for index, value in enumerate(study["meta_entries"]):
            meta.append(meta_summary(value, study["study_id"] + "/embedded/" + str(index)))
        if not study["meta_entries"]:
            meta.append({"source": study["study_id"], "status": "not_provided", "interval": None, "issues": ["No final actual-offspring assay supplied for this study"]})
    for path in meta_paths:
        try:
            value, sha = read_json(path)
            meta.append({**meta_summary(value, str(Path(path).resolve())), "file_sha256": sha})
        except (OSError, ValueError, TypeError) as exc:
            meta.append({"source": str(path), "status": "invalid", "issues": [str(exc)], "interval": None})
    meta_identities = {}
    for row in meta:
        identity = row.get("meta_study_id")
        if identity:
            if identity in meta_identities:
                row["duplicate_of"] = meta_identities[identity]
                row["count_as_independent_evidence"] = False
            else:
                meta_identities[identity] = row["source"]
                row["count_as_independent_evidence"] = True
    return {"schema": "nexgent-source-rsi-summary-v1", "created_at": datetime.now(timezone.utc).isoformat(), "expected_arms": list(expected_arms), "expected_seeds": seeds, "seed_registration": "explicit command-line expected seeds" if expected_seeds is not None else "inferred from supplied exports; completely absent seeds cannot be detected", "studies": studies, "coverage": coverage, "comparisons": comparisons, "final_meta_evaluations": meta, "independent_confirmations": [confirmation_summary(path) for path in confirmation_paths], "limits": ["All input files, failed studies and missing arm/seed combinations remain listed. No best-run selection is performed.", "No confidence interval for fewer than two independent study seeds; three transfer batches from one study do not create three independent RSI runs.", "Missing required pairs suppress the pooled interval. Observed incomplete-case means are diagnostic only.", "Model reservations, reported usage and monetary billing differ; missing token usage is not zero.", "Source self-modification, executed inheritance, predictive gain and actual improver productivity are distinct claims.", "This command reads exports only; it makes no model calls and runs no numerical experiments."]}


def fmt(value):
    if value is None:
        return "缺失"
    return f"{value:.6f}" if isinstance(value, float) else str(value)


def md_cell(value):
    return fmt(value).replace("|", "\\|").replace("\n", " ")


def markdown(report):
    lines = ["# Nexgent 源码 RSI 研究汇总", "", f"生成时间：{report['created_at']}", "", "本报告仅汇总传入的真实导出；固定科学任务效果与实际改进器后代生产能力分开报告。", "", "## 研究覆盖与失败", "", "| Arm | 研究 seed | Study | 状态 |", "| --- | ---: | --- | --- |"]
    for row in report["coverage"]:
        lines.append(f"| {row['arm']} | {row['seed']} | {', '.join(row['study_ids']) or '未提供'} | {row['status']} |")
    for row in report["studies"]:
        if row["input_status"] != "loaded":
            lines += ["", f"无法读取：`{row['path']}`；{'；'.join(row['issues'])}"]
    lines += ["", "## 每项研究的冻结冠军与初始程序", "", "| Study | 状态 | 完整 transfer 批次 | 配对均差 | 数值失败任务 |", "| --- | --- | ---: | ---: | ---: |"]
    for row in report["studies"]:
        if row["input_status"] != "loaded" or row["kind"] == "meta_evaluation":
            continue
        valid_rows = [item for item in row["final_rows"] if item["valid"]]
        score = statistics.fmean(item["paired"]["delta"] for item in valid_rows) if valid_rows and not row["missing_final_seeds"] and len(valid_rows) == len(row["final_rows"]) else None
        failed = sum(item["paired"]["candidate_failures"] for item in valid_rows)
        lines.append(f"| {row['study_id']} | {row['status']} | {len(valid_rows)}/{len(row['expected_final_seeds'])} | {fmt(score)} | {failed} |")
    lines += ["", "## 同 seed 的最终任务对照", "", "统计单位是独立研究 seed；一个研究内的三个 transfer seed 与轨迹点不会被当作独立 RSI 重复。", ""]
    for name, comparison in report["comparisons"].items():
        stats = comparison["statistics"]
        lines += [f"### {name}", "", f"完整配对 n={stats.get('n', 0)}；均差={fmt(stats.get('mean', stats.get('mean_observed_only')))}；区间={fmt(stats.get('interval'))}；状态={stats.get('status')}。", "", "| 研究 seed | 均差 | 配对有效 | 问题 |", "| ---: | ---: | --- | --- |"]
        for pair in comparison["pairs"]:
            lines.append(f"| {pair['study_seed']} | {fmt(pair['mean_delta'])} | {pair['valid']} | {md_cell('; '.join(pair['issues']))} |")
        if comparison["missing_or_invalid"]:
            lines += ["", "缺失/无效配对：`" + canonical(comparison["missing_or_invalid"]) + "`。"]
        lines += ["", comparison["interpretation"], ""]
    lines += ["## 模型、数值工作与有效率", "", "| Study | 模型调用 | received 比例 | 已报告 tokens | 用量缺失调用 | 数值工作账本 | 源码有效率 | 数值有效率 |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for row in report["studies"]:
        if row["input_status"] != "loaded":
            continue
        cost, valid = row["costs"], row["validity"]
        lines.append("| " + " | ".join(md_cell(value) for value in (row["study_id"], cost["model_calls_with_identity"], cost["received_call_fraction"], cost["reported_usage_known"]["total_tokens"], len(cost["usage_missing_call_ids"]), cost["reported_numeric_work_units"], valid["source_validity_fraction"], valid["numerical_validity_fraction"])) + " |")
        if row["issues"] or row.get("last_error"):
            lines += ["", f"{row['study_id']}：{md_cell('; '.join(row['issues']))}；{md_cell(row.get('last_error'))}。", ""]
        if cost["cache_fairness_warning"]:
            lines += ["", f"{row['study_id']} 有 {len(cost['measurement_reuse_events'])} 次缓存复用；比较总成本和评估额度前需核对注册版本的缓存计费规则。", ""]
    lines += ["", "## 最终实际元能力评价", ""]
    for meta in report["final_meta_evaluations"]:
        lines += [f"### {md_cell(meta['source'])}", "", f"状态：{meta['status']}。", ""]
        if "statistics" in meta:
            stats = meta["statistics"]
            lines += [f"实际后代生产力配对均差：{fmt(stats.get('mean', stats.get('mean_observed_only')))}；n={stats.get('n', 0)}；区间={fmt(stats.get('interval'))}。", "", meta["interpretation"], "", f"保留失败记录：{len(meta['failures'])}；缺失证据：`{canonical(meta.get('evidence', {}).get('missing', []))}`。", ""]
            if meta.get("duplicate_of"):
                lines += [f"这是 `{meta['duplicate_of']}` 的重复嵌入，不能再计为独立证据或重复累计费用。", ""]
        elif meta.get("issues"):
            lines += ["；".join(meta["issues"]), ""]
    lines += ["## 独立预注册确认", ""]
    if not report.get("independent_confirmations"):
        lines += ["未传入独立确认报告；源研究内的 final_transfer 不替代新封存批次。", ""]
    for confirmed in report.get("independent_confirmations", []):
        lines += [f"### {md_cell(confirmed.get('plan_id', confirmed['path']))}", "", f"状态：{confirmed['status']}。", ""]
        if confirmed.get("issues"):
            lines += ["；".join(confirmed["issues"]), ""]
            continue
        lines += [f"迁移复现 seeds：{confirmed['transfer_replication_seeds']}；独立演化 seeds：{confirmed['evolution_seeds']}。", "", confirmed["interpretation"], ""]
        for name, comparison in confirmed["summary"]["comparisons"].items():
            stat = comparison["statistics"]
            lines += [f"{name}：演化 seed n={stat.get('n',0)}；均差={stat.get('mean',stat.get('mean_observed_only'))}；区间={stat.get('interval')}；状态={stat.get('status')}。", ""]
    lines += ["## 解释边界", ""] + ["- " + limit for limit in report["limits"]]
    lines += ["", "JSON 报告保存逐 transfer seed / task_id 的配对误差、全部研究问题/失败/成本与输入文件摘要；Markdown 为阅读摘要。", ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("exports", nargs="+")
    parser.add_argument("--output-prefix", required=True)
    parser.add_argument("--expected-arms", nargs="+", choices=ARMS, default=list(ARMS))
    parser.add_argument("--expected-seeds", nargs="+", type=int)
    parser.add_argument("--meta-report", nargs="*", default=[])
    parser.add_argument("--confirmation", nargs="*", default=[], help="Independent registered confirmation receipts; transfer seeds are not evolution seeds")
    parser.add_argument("--bootstrap-repetitions", type=int, default=10_000)
    parser.add_argument("--bootstrap-seed", type=int, default=713)
    args = parser.parse_args()
    if not 100 <= args.bootstrap_repetitions <= 1_000_000:
        parser.error("bootstrap repetitions must be in 100..1,000,000")
    if len(set(args.expected_arms)) != len(args.expected_arms) or args.expected_seeds and len(set(args.expected_seeds)) != len(args.expected_seeds):
        parser.error("expected arms and seeds must be unique")
    prefix = Path(args.output_prefix).resolve()
    json_path, md_path = Path(str(prefix) + ".json"), Path(str(prefix) + ".md")
    if json_path.exists() or md_path.exists():
        parser.error("refusing to overwrite an existing report")
    paths = [path for pattern in args.exports for path in (sorted(glob.glob(pattern)) if glob.has_magic(pattern) else [pattern]) or [pattern]]
    meta_paths = [path for pattern in args.meta_report for path in (sorted(glob.glob(pattern)) if glob.has_magic(pattern) else [pattern]) or [pattern]]
    confirmation_paths = [path for pattern in args.confirmation for path in (sorted(glob.glob(pattern)) if glob.has_magic(pattern) else [pattern]) or [pattern]]
    report = build_report(paths, expected_arms=args.expected_arms, expected_seeds=args.expected_seeds, meta_paths=meta_paths, confirmation_paths=confirmation_paths, repetitions=args.bootstrap_repetitions, bootstrap_seed=args.bootstrap_seed)
    report["content_digest"] = digest(report)
    prefix.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2), encoding="utf-8")
    md_path.write_text(markdown(report), encoding="utf-8")
    print(json.dumps({"json": str(json_path), "markdown": str(md_path), "input_files": len(paths), "loaded": sum(row["input_status"] == "loaded" for row in report["studies"]), "content_digest": report["content_digest"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
