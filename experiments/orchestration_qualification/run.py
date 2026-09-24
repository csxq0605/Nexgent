"""Run one canonical BBH development task through a three-role workflow."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import time
import uuid

from nexgent.tasks.benchmarks import host_runtime_fingerprint
from nexgent.tasks.multirole_seed import (
    multirole_package, single_role_equal_calls_package,
)
from nexgent.tasks.runtime import TaskService
from nexgent_bbh.task_benchmark import BigBenchHardTaskBenchmark


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True,
                        help="Writable project with local provider configuration")
    parser.add_argument("--data", type=Path, required=True,
                        help="Pinned BBH data directory")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--case-index", type=int, default=0)
    parser.add_argument("--arm", choices=("fixed_multi", "single_equal_calls"),
                        default="fixed_multi")
    args = parser.parse_args(argv)
    root = args.root.resolve()
    adapter = BigBenchHardTaskBenchmark(data_path=args.data, samples_per_task=1)
    tasks = adapter.tasks(split="development", seed=args.seed)
    if not 0 <= args.case_index < len(tasks):
        parser.error(f"case-index must be in 0..{len(tasks) - 1}")
    task = tasks[args.case_index]
    package = (multirole_package() if args.arm == "fixed_multi"
               else single_role_equal_calls_package())
    output = root / ".nexgent" / "exports" / "orchestration-qualification"
    output.mkdir(parents=True, exist_ok=True)
    receipt_path = output / f"attempt-{time.time_ns()}-{uuid.uuid4().hex[:8]}.json"
    receipt = {
        "schema": "nexgent.orchestration-qualification.v1",
        "status": "running", "benchmark_id": adapter.id,
        "split": "development", "seed": args.seed,
        "case_index": args.case_index, "arm": args.arm,
        "package_id": package["id"], "package_digest": package["digest"],
        "task_id": task["id"], "started_at": time.time(),
        "claim_limit": "One BBH development case checks model-driven orchestration only; it is not RSI evidence.",
    }

    def save():
        receipt_path.write_text(
            json.dumps(receipt, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
            encoding="utf-8")

    save()
    try:
        service = TaskService(root)
        snapshot = adapter.snapshot()
        registration = {
            "benchmark_id": adapter.id, "task_ref": task,
            "snapshot": snapshot, "host_runtime": host_runtime_fingerprint(),
        }
        state = service.create(
            task["objective"], task.get("inputs"), task.get("deliverables"),
            {"max_model_calls": 3, "max_completion_tokens": 4800,
             "max_tool_calls": 0, "max_nodes": 30},
            task.get("capabilities"), package, task.get("context"),
            constraints=task.get("constraints"),
            benchmark_registration=registration,
        )
        receipt["episode_id"] = state["id"]
        save()
        terminal = service.run(state["id"])
        report = service.evaluate(state["id"], adapter, task, snapshot=snapshot)
        model_calls = service.store.calls(state["id"])
        receipt.update(
            status="completed" if terminal["status"] == "completed" else "failed",
            episode_status=terminal["status"],
            failure_domain=terminal.get("failure_domain"),
            last_error_type=((terminal.get("last_error") or "").split(":", 1)[0] or None),
            usage=report["usage"], evaluation=report["evaluation"],
            model_calls=[{
                "role": call.get("role"),
                "configured_model": call.get("configured_provider_model"),
                "observed_model": call.get("observed_provider_model"),
                "provider_revision": call.get("provider_revision"),
                "status": call.get("status"),
            } for call in model_calls],
            role_nodes={node_id: node.get("role_ref")
                        for node_id, node in terminal.get("nodes", {}).items()
                        if node.get("role_ref")},
            completed_at=time.time(),
        )
    except Exception as exc:
        receipt.update(status="error", error_type=type(exc).__name__,
                       completed_at=time.time())
        save()
        raise
    save()
    print(receipt_path)
    return 0 if receipt["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
