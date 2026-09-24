"""Create a compact, read-only scientific evidence release from a frozen batch.

This performs no scientific evaluation, controller writes, or model calls.
Provider request/response bodies and configuration plaintext are excluded.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path


def canonical(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def read(path):
    data = Path(path).read_bytes()
    return json.loads(data.decode("utf-8-sig")), hashlib.sha256(data).hexdigest()


def project(value, names):
    return {name: value[name] for name in names if name in value}


def measurement(value):
    if not isinstance(value, dict):
        return None
    out = project(value, ("bundle_id", "measurement_key", "score", "score_available", "failure_kind", "status", "missing_task_ids", "split", "seed", "suite_digest", "evaluator_digest", "groups", "work_units", "work_units_status", "dataset_generation_work_units", "scoring_work_units", "domain", "evidence_scope"))
    out["tasks"] = []
    for task in value.get("tasks", []):
        clean = project(task, ("task_id", "family", "group", "score", "score_available", "nrmse", "stable", "status", "failure_kind", "equation", "experiment_claims_verified", "complexity", "forecast_nrmse", "scoring_work_units", "error"))
        if isinstance(task.get("submission"), dict):
            clean["submitted_model"] = task["submission"].get("model")
            clean["submission_sha256"] = digest(task["submission"])
        out["tasks"].append(clean)
    execution = value.get("execution")
    if isinstance(execution, dict):
        out["execution"] = project(execution, ("bundle_id", "entry", "source_digest", "elapsed_seconds", "rpc_count", "work_units", "instructions", "failure_kind"))
        out["execution"]["science_receipt_count"] = len(execution.get("science_receipts", []))
        out["execution"]["science_receipts_sha256"] = digest(execution.get("science_receipts", []))
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--exports", type=Path, required=True)
    parser.add_argument("--confirmation", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest, manifest_sha = read(args.manifest)
    confirmation, confirmation_sha = read(args.confirmation)
    if manifest.get("content_digest") != digest({k: v for k, v in manifest.items() if k != "content_digest"}):
        raise ValueError("invalid registered manifest digest")
    if confirmation.get("content_digest") != digest({k: v for k, v in confirmation.items() if k != "content_digest"}):
        raise ValueError("invalid confirmation receipt digest")
    if confirmation.get("status") != "completed":
        raise ValueError("publish only after confirmation reaches terminal completion; missing measurements remain included")
    enrolled = {entry["study_id"]: entry for entry in confirmation["enrollment"]}
    studies, bundles, components = [], {}, {}
    registered = manifest["studies"]
    for registration in registered:
        identity = registration.get("study_id", registration.get("id"))
        payload, export_sha = read(args.exports / (identity + ".json"))
        study = payload["study"]
        if payload.get("schema") != "nexgent-study-v1" or study["id"] != identity:
            raise ValueError("export identity/schema mismatch")
        if identity not in enrolled or enrolled[identity]["export_sha256"] != export_sha:
            raise ValueError("release export differs from the one-time confirmation enrollment")
        clean = project(study, ("id", "arm", "seed", "status", "generation", "max_generations", "question", "created", "updated", "initial_program", "active_program", "research_program", "budget", "protocol", "implementation_digest", "evaluator_digest", "usage"))
        clean["export_sha256"] = export_sha
        clean["model_configuration_sha256"] = digest(study.get("model_configuration"))
        clean["calls"] = [project(call, ("call_id", "role", "status", "billing_status", "request_digest", "started_at", "finished_at", "elapsed_seconds", "finish_reason", "max_completion_tokens", "reserved_completion_tokens", "usage")) for call in study.get("calls", [])]
        clean["token_totals"] = {name: sum(call.get("usage", {}).get(name, 0) or 0 for call in study.get("calls", []) if isinstance(call.get("usage"), dict)) for name in ("prompt_tokens", "completion_tokens", "total_tokens")}
        clean["selection_candidates"] = []
        for candidate in study.get("evaluations", []):
            row = {k: v for k, v in candidate.items() if k != "measurement"}
            row["measurement"] = measurement(candidate.get("measurement"))
            clean["selection_candidates"].append(row)
        clean["baseline"] = {split: measurement(value) for split, value in study.get("baseline", {}).items()}
        clean["conclusion"] = {k: v for k, v in study.get("conclusion", {}).items() if k not in ("final_transfer", "meta_evaluation")}
        clean["final_transfer"] = []
        for result in study.get("conclusion", {}).get("final_transfer", []):
            clean["final_transfer"].append({**{k: v for k, v in result.items() if k not in ("initial", "selected")}, "initial": measurement(result.get("initial")), "selected": measurement(result.get("selected"))})
        clean["offspring_executions"], clean["source_checks"], clean["cost_events"] = [], [], []
        for event in study.get("events", []):
            content = event.get("content", {})
            if event["kind"] == "offspring_generated":
                clean["offspring_executions"].append({**project(content, ("artifact", "candidate_ids", "label", "parent_id")), "execution": project(content.get("execution", {}), ("bundle_id", "entry", "source_digest", "elapsed_seconds", "instructions", "rpc_count", "work_units"))})
            if event["kind"] in ("measurement", "measurement_reused", "measurement_started"):
                clean["cost_events"].append({"kind": event["kind"], "sequence": event["sequence"], **project(content, ("artifact", "bundle_id", "key", "additional_work_units", "logical_work_units", "same_study", "seed", "split", "max_work_units"))})
            if event["kind"] == "agent_log" and content.get("claimed_kind") == "research_result":
                for check in content.get("content", {}).get("source_checks", []):
                    details = check.get("check", {})
                    clean["source_checks"].append({"event_sequence": event["sequence"], "source_bundle": content.get("source_bundle"), "stage": check.get("stage"), "issues": details.get("issues", []), "changed_files": [item["file"] for item in details.get("changed_files", [])], "verification_scope": details.get("verification_scope")})
        clean["ledger_final_event_digest"] = study.get("events", [{}])[-1].get("digest")
        studies.append(clean)
        for bundle in payload["bundles"]:
            row = project(bundle, ("id", "digest", "component_digests", "parent_id", "generation", "rationale"))
            row["component_text_sha256"] = {}
            for name, source in bundle["files"].items():
                sha = hashlib.sha256(source.encode()).hexdigest()
                components[sha] = source
                row["component_text_sha256"][name] = sha
            if bundle["id"] in bundles and bundles[bundle["id"]] != row:
                # Equal code can occur with different provenance/generation. Preserve code,
                # and list its study occurrence without inventing a single ancestry.
                if bundles[bundle["id"]]["component_text_sha256"] != row["component_text_sha256"]:
                    raise ValueError("bundle ID collision")
            else:
                bundles[bundle["id"]] = row
    if set(enrolled) != {study["id"] for study in studies}:
        raise ValueError("confirmation enrollment differs from all registered studies")
    compact_confirmation = project(confirmation, ("schema", "status", "created_at", "updated_at", "wall_seconds", "plan", "plan_file_sha256", "manifest_digest", "script_sha256", "errors", "model_calls", "content_digest"))
    source_summary = confirmation["summary"]
    compact_summary = {k: v for k, v in source_summary.items() if k not in ("studies", "comparisons")}
    compact_summary["studies"] = [{**{k: v for k, v in row.items() if k != "pairs"}, "pairs": [{k: v for k, v in pair.items() if k != "tasks"} for pair in row["pairs"]]} for row in source_summary["studies"]]
    compact_summary["comparisons"] = {name: {**{k: v for k, v in comparison.items() if k != "per_evolution_seed"}, "per_evolution_seed": [{**{k: v for k, v in row.items() if k != "pairs"}, "pairs": [{k: v for k, v in pair.items() if k != "tasks"} for pair in row["pairs"]]} for row in comparison["per_evolution_seed"]]} for name, comparison in source_summary["comparisons"].items()}
    compact_confirmation["summary"] = compact_summary
    compact_confirmation["original_file_sha256"] = confirmation_sha
    compact_confirmation["measurements"] = [{**{k: v for k, v in row.items() if k != "measurement"}, "measurement": measurement(row.get("measurement"))} for row in confirmation["measurements"]]
    compact_confirmation["implementation"] = {"digest": confirmation["implementation"]["digest"], "versions": confirmation["implementation"]["versions"], "python": confirmation["implementation"]["python"], "file_text_sha256": {name: hashlib.sha256(text.encode()).hexdigest() for name, text in confirmation["implementation"]["files"].items()}}
    output = {"schema": "nexgent-source-batch-release-v1", "created_at": datetime.now(timezone.utc).isoformat(), "manifest": manifest, "manifest_file_sha256": manifest_sha, "studies": sorted(studies, key=lambda row: (row["seed"], row["arm"])), "bundles": list(bundles.values()), "source_components_by_sha256": components, "confirmation": compact_confirmation, "omissions": ["Provider request/response bodies and configuration plaintext", "Absolute local execution paths and process identifiers", "Full experiment prose, submission trace, and repeated science receipts (digests preserved)", "Full implementation source is in the frozen repository revision; per-file hashes are preserved"], "interpretation": {"independent_evolution_seeds": sorted({study["seed"] for study in studies}), "confirmation_replication_seeds": confirmation["plan"]["seeds"], "confirmation_used_for_selection": False, "confirmation_model_calls": 0, "meta_productivity_evidence": "Absent in this registered batch: both full arms changed task.py only; no evolved executable improver was exercised."}}
    output["content_digest"] = digest(output)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, allow_nan=False, indent=1), encoding="utf-8")
    print(canonical({"output": str(args.output), "bytes": args.output.stat().st_size, "studies": len(studies), "bundles": len(bundles), "unique_source_components": len(components), "measurements": len(compact_confirmation["measurements"]), "content_digest": output["content_digest"]}))


if __name__ == "__main__":
    main()
