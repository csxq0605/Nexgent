"""Close an interrupted O-search intent from existing host evidence.

This command never runs or resumes an Episode. It marks the attempt terminal
and non-retryable so its development units cannot be silently reused.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from nexgent.tasks.evolution import EvolutionService
from nexgent.tasks.orchestration_search import OrchestrationSearchJournal
from nexgent.tasks.runtime import TaskService

from .search_v3 import _failed_qualification


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--search-id", required=True)
    parser.add_argument("--plan-id", required=True)
    parser.add_argument("--failure-type", default="QualificationInterrupted")
    args = parser.parse_args(argv)
    if (not args.failure_type.isidentifier()
            or len(args.failure_type) > 120):
        raise ValueError("Failure type must be a bounded identifier")

    tasks = TaskService(args.root.resolve())
    evolution = EvolutionService(tasks)
    failure = _failed_qualification(
        tasks, evolution, args.plan_id,
        RuntimeError("host-reconciled interruption")).failure
    failure["failure_type"] = args.failure_type
    result = OrchestrationSearchJournal(tasks.store).finalize_failed(
        args.search_id, failure)
    print(result["id"])
    print(result["status"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
