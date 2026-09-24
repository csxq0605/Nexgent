"""Try reference R0 on one prior development Episode with PackagePatch v3.

This is a generation qualification only. A candidate is not an improvement
until independent paired selection and guard evaluation prove it.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import time
import uuid

from nexgent.tasks.evolution import EvolutionService
from nexgent.tasks.generation import GenerationService, PACKAGE_PATCH_SCHEMA
from nexgent.tasks.improver_seed import default_improver_package
from nexgent.tasks.multirole_seed import multirole_package
from nexgent.tasks.runtime import TaskService


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--feedback-episode", required=True)
    args = parser.parse_args(argv)
    root = args.root.resolve()
    output = root / ".nexgent" / "exports" / "orchestration-qualification"
    output.mkdir(parents=True, exist_ok=True)
    path = output / f"improve-v3-{time.time_ns()}-{uuid.uuid4().hex[:8]}.json"
    receipt = {"schema": "nexgent.package-patch-v3-qualification.v1",
               "status": "running", "feedback_episode_id": args.feedback_episode,
               "patch_contract": PACKAGE_PATCH_SCHEMA, "started_at": time.time()}

    def save():
        path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2,
                                   allow_nan=False) + "\n", encoding="utf-8")

    save()
    try:
        tasks = TaskService(root)
        evolution = EvolutionService(tasks)
        parent = multirole_package()
        channel = "orchestration-v3-qualification"
        try:
            active = evolution.active(channel)
        except KeyError:
            active = evolution.register(channel, parent)
        if active["package_digest"] != parent["digest"]:
            raise ValueError("Qualification channel has another active package")
        generation = GenerationService(tasks, evolution)
        bundle = generation.capture_feedback(
            channel, [args.feedback_episode], active["revision"])
        receipt.update(feedback_bundle_id=bundle["id"],
                       feedback_digest=bundle["digest"],
                       parent_package_digest=parent["digest"])
        save()
        policy = {"patch_contract": PACKAGE_PATCH_SCHEMA,
                  "mutable_components": list(parent["manifest"]["components"]),
                  "allow_add": True, "allow_remove": True,
                  "max_patch_bytes": 300000,
                  "capability_ceiling": ["ask"], "tool_ceiling": [],
                  "max_parallel": 2}
        result = generation.generate(
            channel, bundle["id"], default_improver_package(), policy,
            active["revision"],
            budget={"max_model_calls": 1, "max_completion_tokens": 6000,
                    "max_tool_calls": 0, "max_nodes": 12})
        receipt.update(
            status=result["status"], generation_id=result["id"],
            improver_episode_id=result.get("episode_id"),
            candidate_id=result.get("candidate_id"),
            candidate_package_id=result.get("candidate_package_id"),
            reason_type=result.get("reason_type"),
            reason=(result.get("reason") or "")[:500],
            usage=result.get("usage"), completed_at=time.time())
        if result.get("episode_id"):
            calls = tasks.store.calls(result["episode_id"])
            receipt["model_calls"] = [{
                "role": call.get("role"),
                "configured_model": call.get("configured_provider_model"),
                "observed_model": call.get("observed_provider_model"),
                "provider_revision": call.get("provider_revision"),
                "status": call.get("status"),
            } for call in calls]
    except Exception as exc:
        receipt.update(status="error", error_type=type(exc).__name__,
                       completed_at=time.time())
        save()
        raise
    save()
    print(path)
    return 0 if receipt["status"] == "generated" else 1


if __name__ == "__main__":
    raise SystemExit(main())
