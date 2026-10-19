#!/usr/bin/env python3
"""Offline, deterministic Nexgent Coding Harness demonstration.

This demo deliberately uses a scripted agent so it needs no Provider API key.
The production CodingTaskLoop, recorder, SQLite store, dependency trace,
recovery loop, portable export, and independent verifier are all real.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

from nexgent.runtime.coding_task import run_coding_task
from nexgent.runtime.store import SQLiteRunStore
from nexgent.runtime.verify import verify_export


SIMULATOR = '''\
import argparse
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    config = json.loads(Path("simulation_config.json").read_text())
    tolerance = config["tolerance"]
    converged = isinstance(tolerance, (int, float)) and 0 < tolerance <= 1e-4
    Path("simulation_result.json").write_text(
        json.dumps({"converged": converged, "tolerance": tolerance}, indent=2)
        + "\\n"
    )
    if args.verify and not converged:
        print(f"INVARIANT FAILED: tolerance must be in (0, 1e-4], got {tolerance}")
        return 2
    print(f"simulation converged with tolerance={tolerance}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
'''


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run an offline Nexgent failure-to-recovery demonstration."
    )
    parser.add_argument(
        "--workspace",
        type=Path,
        help="Use a new or empty directory instead of a generated temporary one.",
    )
    return parser.parse_args()


def _prepare_workspace(requested: Path | None) -> Path:
    if requested is None:
        return Path(tempfile.mkdtemp(prefix="nexgent-harness-demo-"))
    workspace = requested.expanduser().resolve()
    if workspace.exists() and any(workspace.iterdir()):
        raise SystemExit(f"refusing to overwrite non-empty workspace: {workspace}")
    workspace.mkdir(parents=True, exist_ok=True)
    return workspace


def main() -> int:
    args = _parse_args()
    workspace = _prepare_workspace(args.workspace)
    (workspace / "simulate.py").write_text(SIMULATOR, encoding="utf-8")
    (workspace / "simulation_config.json").write_text(
        json.dumps({"tolerance": None}, indent=2) + "\n", encoding="utf-8"
    )

    calls = 0

    def scripted_agent(prompt: str) -> str:
        """Make one faulty change, then repair it from the recovery prompt."""

        nonlocal calls
        calls += 1
        tolerance = 0.0 if calls == 1 else 1e-6
        (workspace / "simulation_config.json").write_text(
            json.dumps({"tolerance": tolerance}, indent=2) + "\n",
            encoding="utf-8",
        )
        action = "introduced the demonstrator fault" if calls == 1 else "repaired it"
        print(f"  agent attempt {calls}: {action}; tolerance={tolerance}")
        if calls > 1:
            print("  recovery prompt carries the failed acceptance evidence:")
            evidence = next(
                (
                    line
                    for line in reversed(prompt.splitlines())
                    if "INVARIANT FAILED" in line
                ),
                "<no failure evidence found>",
            )
            print("   ", evidence[:120])
        return action

    def show_progress(event: dict[str, object]) -> None:
        details = ", ".join(
            f"{key}={value}"
            for key, value in event.items()
            if key not in {"run_id", "stage"} and value is not None and value != ""
        )
        suffix = f" ({details})" if details else ""
        print(f"  harness: {event['stage']}{suffix}")

    print("Nexgent offline Harness demo")
    print(f"workspace: {workspace}")
    print("scripted agent: enabled (no Provider API key is used)")

    store = SQLiteRunStore(workspace / ".nexgent" / "runs")
    summary = run_coding_task(
        store,
        workspace,
        task="Repair the simulation tolerance until its invariant passes.",
        check_command="python simulate.py --verify",
        agent_executor=scripted_agent,
        max_attempts=2,
        check_timeout=30.0,
        progress_callback=show_progress,
    )

    export_dir = workspace / ".nexgent" / "exports"
    export_dir.mkdir(parents=True, exist_ok=True)
    export_path = export_dir / f"{summary.run_id}.jsonl"
    export_path.write_text(
        store.export_run_jsonl(summary.run_id), encoding="utf-8"
    )
    bundle = store.export_run(summary.run_id)
    integrity = verify_export(bundle, strict_lifecycles=True)

    print("\nresult")
    print(f"  run_id: {summary.run_id}")
    print(f"  status: {summary.status.value}")
    print(f"  attempts: {summary.attempts}")
    print(f"  recoveries: {summary.recoveries}")
    print(f"  changed_files: {', '.join(summary.changed_files)}")
    print(f"  trace_integrity: {'passed' if integrity.ok else 'failed'}")
    print(f"  export: {export_path}")
    print("\ninspect the run with:")
    print(f"  nexgent-verify-run --jsonl {export_path} --strict-lifecycles")

    return 0 if summary.status.value == "succeeded" and integrity.ok else 1


if __name__ == "__main__":
    sys.exit(main())
