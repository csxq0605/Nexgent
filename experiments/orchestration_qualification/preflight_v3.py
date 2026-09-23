"""Run a generated candidate on fresh development tasks before selection.

This qualification script uses the framework's ordinary paired TaskService path.
It never makes a promotion decision and never reuses the generating feedback
task. A failed preflight is development evidence; the selection pool remains
unopened for candidates that fail basic execution or artifact contracts.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import time
import uuid

from nexgent.tasks.evolution import EvolutionService, PromotionPolicy
from nexgent.tasks.runtime import TaskService
from nexgent_bbh.task_benchmark import BigBenchHardTaskBenchmark


def _feedback_units(tasks, evolution, candidate):
    generation = evolution._verify_generated_candidate(candidate)
    from nexgent.tasks.generation import GenerationService

    bundle = GenerationService(tasks, evolution).feedback(generation["feedback_bundle_id"])
    identities = set()
    for episode in bundle["episode_refs"]:
        registration = tasks.store.benchmark_registration(episode["episode_id"])
        task_ref = (registration or {}).get("task_ref") or {}
        unit = task_ref.get("statistical_unit_id")
        if not isinstance(unit, str) or not unit:
            raise ValueError("Preflight requires benchmark-bound statistical units")
        identities.add(unit)
    return identities


def _disjoint_units(excluded, task_refs):
    units = [task.get("statistical_unit_id") for task in task_refs]
    if (any(not isinstance(unit, str) or not unit for unit in units)
            or len(set(units)) != len(units)):
        raise ValueError("Preflight tasks need unique statistical units")
    if excluded.intersection(units):
        raise ValueError("Preflight tasks overlap the candidate's feedback tasks")
    return units


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--candidate-id", required=True)
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args(argv)
    root = args.root.resolve()
    output = root / ".nexgent" / "exports" / "orchestration-qualification"
    output.mkdir(parents=True, exist_ok=True)
    path = output / f"preflight-v3-{time.time_ns()}-{uuid.uuid4().hex[:8]}.json"
    receipt = {"schema": "nexgent.package-patch-v3-development-preflight.v1",
               "status": "running", "candidate_id": args.candidate_id,
               "split": "development", "seed": args.seed,
               "started_at": time.time()}

    def save():
        path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2,
                                   allow_nan=False) + "\n", encoding="utf-8")

    save()
    try:
        tasks = TaskService(root)
        evolution = EvolutionService(tasks)
        candidate = evolution.candidate(args.candidate_id)
        if candidate.get("targeting") != "manifest_component_set_v3":
            raise ValueError("Preflight requires a generated PackagePatch v3 candidate")
        excluded = _feedback_units(tasks, evolution, candidate)
        adapter = BigBenchHardTaskBenchmark(data_path=args.data, samples_per_task=1)
        preview = adapter.tasks(split="development", seed=args.seed)
        task_units = _disjoint_units(excluded, preview)
        plan = evolution.plan_pair(
            args.candidate_id, adapter, split="development",
            split_role="development", seed=args.seed,
            budget={"max_model_calls": 3, "max_completion_tokens": 4800,
                    "max_tool_calls": 0, "max_nodes": 30},
            policy=PromotionPolicy())
        task_ids = [task["id"] for task in plan["suite"]["tasks"]]
        if [task["id"] for task in preview] != task_ids:
            raise ValueError("Preflight task selection changed during planning")
        receipt.update(plan_id=plan["id"], suite_digest=plan["suite_digest"],
                       task_ids=task_ids, statistical_units=task_units,
                       excluded_feedback_units=sorted(excluded),
                       candidate_package_digest=plan["package_digest"],
                       parent_package_digest=plan["parent_package_digest"])
        save()
        trial = evolution.run_pair(plan["id"], adapter)
        pairs = []
        for pair in trial["pairs"]:
            arms = {}
            for arm in ("parent", "candidate"):
                result = pair[arm]
                episode = tasks.get_private(result["episode_id"])
                error = episode.get("last_error")
                failed_nodes = []
                for node in (episode.get("nodes") or {}).values():
                    if node.get("status") != "failed":
                        continue
                    node_error = node.get("error") or ""
                    failed_nodes.append({
                        "id": node.get("id"), "method": node.get("method"),
                        "error_type": (node_error.split(":", 1)[0]
                                       if isinstance(node_error, str) else None),
                        "schema_type_mismatch": (
                            isinstance(node_error, str)
                            and "is not of type" in node_error),
                    })
                arms[arm] = {
                    "episode_id": result["episode_id"],
                    "status": episode["status"],
                    "failure_domain": episode.get("failure_domain"),
                    "error_type": (error.split(":", 1)[0] if isinstance(error, str)
                                   else None),
                    "failed_nodes": failed_nodes,
                    "score": result["evaluation"].get("score"),
                    "score_available": result["evaluation"].get("score_available"),
                    "failure_class": result.get("failure_class"),
                    "loaded": (result.get("loaded_evidence") or {}).get("loaded"),
                    "usage": result.get("usage"),
                    "model_calls": [{
                        "role": call.get("role"),
                        "configured_model": call.get("configured_provider_model"),
                        "observed_model": call.get("observed_provider_model"),
                        "provider_revision": call.get("provider_revision"),
                        "status": call.get("status"),
                    } for call in tasks.store.calls(result["episode_id"])],
                }
            pairs.append({"task_ref_digest": pair["task_ref_digest"], "arms": arms})
        receipt.update(status="completed", trial_id=trial["id"], pairs=pairs,
                       completed_at=time.time())
    except Exception as exc:
        receipt.update(status="error", error_type=type(exc).__name__,
                       completed_at=time.time())
        save()
        raise
    save()
    print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
