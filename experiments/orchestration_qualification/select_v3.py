"""Independently compare a generated v3 candidate on the BBH selection pool."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import time
import uuid

from nexgent.tasks.evolution import EvolutionService, PromotionPolicy
from nexgent.tasks.runtime import TaskService
from nexgent_bbh.task_benchmark import BigBenchHardTaskBenchmark


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--candidate-id", required=True)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args(argv)
    root = args.root.resolve()
    output = root / ".nexgent" / "exports" / "orchestration-qualification"
    output.mkdir(parents=True, exist_ok=True)
    path = output / f"select-v3-{time.time_ns()}-{uuid.uuid4().hex[:8]}.json"
    receipt = {"schema": "nexgent.package-patch-v3-selection.v1",
               "status": "running", "candidate_id": args.candidate_id,
               "split": "selection", "seed": args.seed,
               "started_at": time.time()}

    def save():
        path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2,
                                   allow_nan=False) + "\n", encoding="utf-8")

    save()
    try:
        tasks = TaskService(root)
        evolution = EvolutionService(tasks)
        adapter = BigBenchHardTaskBenchmark(data_path=args.data, samples_per_task=1)
        policy = PromotionPolicy()
        plan = evolution.plan_pair(
            args.candidate_id, adapter, split="selection", split_role="selection",
            seed=args.seed,
            budget={"max_model_calls": 3, "max_completion_tokens": 4800,
                    "max_tool_calls": 0, "max_nodes": 30}, policy=policy)
        receipt.update(plan_id=plan["id"], suite_digest=plan["suite_digest"],
                       candidate_package_digest=plan["package_digest"],
                       parent_package_digest=plan["parent_package_digest"],
                       policy_digest=plan["policy_digest"],
                       task_ids=[task["id"] for task in plan["suite"]["tasks"]])
        save()
        trial = evolution.run_pair(plan["id"], adapter)
        decision = evolution.assess(trial["id"])
        receipt.update(
            status="completed", trial_id=trial["id"], decision_id=decision["id"],
            eligible=decision["eligible"], gates=decision["gates"],
            measurements=decision["measurements"],
            pairs=[{
                "task_ref_digest": pair["task_ref_digest"],
                "arm_order": pair["arm_order"],
                "arms": {arm: {
                    "episode_id": pair[arm]["episode_id"],
                    "score": pair[arm]["evaluation"].get("score"),
                    "accepted": pair[arm]["evaluation"].get("accepted"),
                    "usage": pair[arm].get("usage"),
                    "loaded": (pair[arm].get("loaded_evidence") or {}).get("loaded"),
                    "model_calls": [{
                        "role": call.get("role"),
                        "configured_model": call.get("configured_provider_model"),
                        "observed_model": call.get("observed_provider_model"),
                        "provider_revision": call.get("provider_revision"),
                        "status": call.get("status"),
                    } for call in tasks.store.calls(pair[arm]["episode_id"])],
                } for arm in ("parent", "candidate")},
            } for pair in trial["pairs"]], completed_at=time.time())
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
