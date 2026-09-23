"""Run one bounded, development-only task-time skill invention probe.

Read provider settings from an external project in memory. Never copy them into
the probe workspace or its output. This is not an independent quality study.
"""

from __future__ import annotations

import argparse
from dataclasses import replace
import json
from pathlib import Path
import tempfile

from nexgent.models import ModelGateway
from nexgent.models.config import load_profiles
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.self_orchestration_seed import self_orchestration_package


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-project", type=Path, required=True)
    parser.add_argument("--model", default="mimo-v2.6-flash")
    args = parser.parse_args()
    profiles, _ = load_profiles(args.model_project)
    selected = next((name for name in profiles if "mimo" in name.lower()), None)
    if selected is None:
        raise RuntimeError("No local MiMo profile")

    def gateway_factory(reserve, stop_event):
        gateway = ModelGateway(args.model_project, reserve=reserve,
                               stop_event=stop_event, max_completion_tokens=6000)
        gateway.profiles = {selected: replace(profiles[selected], model=args.model)}
        gateway.defaults = {"main": selected, "subagent": selected}
        return gateway

    project = Path(tempfile.mkdtemp(prefix="nexgent-skill-live-"))
    service = TaskService(project, gateway_factory=gateway_factory)
    episode = service.create(
        "Create a reusable task-time Python skill that sums a list of numbers "
        "from the supplied input artifact; execute the new skill in a delegated "
        "child task and return the sum. The concrete input is [11, 13, 18].",
        inputs={"numbers": [11, 13, 18]},
        deliverables=[{"name": "result", "schema": {
            "type": "object", "required": ["answer"],
            "properties": {"answer": {"type": "integer"}},
        }}],
        budget={"max_model_calls": 8, "max_completion_tokens": 32000},
        package=self_orchestration_package(),
    )
    result = service.run(episode["id"])
    report = {
        "project": str(project), "episode": episode["id"],
        "status": result["status"], "error": result.get("last_error"),
        "plan_revision": result.get("plan_revision"),
        "model_calls": result.get("usage", {}).get("model_calls"),
        "nodes": {key: value.get("status")
                  for key, value in result.get("nodes", {}).items()},
        "children": result.get("child_episode_ids", []),
        "output_refs": result.get("output_refs", {}),
    }
    print(json.dumps(report, ensure_ascii=False))
    ref = result.get("output_refs", {}).get("result")
    if ref:
        print(json.dumps({"result": service.store.read(
            ref, episode["id"])["content"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
