"""Run the four-arm orchestration qualification harness on pinned BBH data."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from nexgent.tasks.memory import MemoryService
from nexgent.tasks.multirole_seed import single_role_equal_calls_package
from nexgent.tasks.runtime import TaskService
from nexgent_bbh.task_benchmark import BigBenchHardTaskBenchmark

from .harness import FourArmControlHarness, memory_ready_multirole_package


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--evolved-package", type=Path, required=True)
    parser.add_argument("--memory-channel", required=True)
    parser.add_argument("--evolved-memory-channel")
    parser.add_argument("--evolved-surface", action="append",
                        choices=("O", "S", "M"), required=True)
    parser.add_argument("--split", default="selection")
    parser.add_argument("--seed", action="append", type=int, required=True)
    args = parser.parse_args(argv)

    service = TaskService(args.root.resolve())
    memory = MemoryService(service)
    fixed = memory_ready_multirole_package()
    evolved = json.loads(args.evolved_package.read_text(encoding="utf-8"))
    adapter = BigBenchHardTaskBenchmark(
        data_path=args.data.resolve(), samples_per_task=1)
    harness = FourArmControlHarness(service, adapter)
    plan = harness.create_plan(
        fixed_package=fixed,
        single_package=single_role_equal_calls_package(),
        memory_registration=memory.active(args.memory_channel),
        evolved_package=evolved,
        evolved_memory_registration=(
            memory.active(args.evolved_memory_channel)
            if args.evolved_memory_channel else None),
        evolved_surfaces=args.evolved_surface,
        split=args.split,
        seeds=args.seed,
        episode_budget={
            "max_model_calls": 3,
            "max_completion_tokens": 4800,
            "max_tool_calls": 0,
            "max_tool_work_units": 0,
            "max_nodes": 30,
        },
    )
    run = harness.run(plan)
    print(json.dumps({
        "plan_id": plan["id"],
        "run_id": run["id"],
        "status": run["status"],
        "valid_execution_preflight": run["valid_execution_preflight"],
        "claim_ceiling": run["claim_ceiling"],
        "descriptive_summary": run["descriptive_summary"],
    }, ensure_ascii=False, indent=2))
    return 0 if run["valid_execution_preflight"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
