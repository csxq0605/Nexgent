"""Run a task-neutral development probe of model-authored AgentProgram graphs.

The case file contains a TaskSpec-shaped objective, inputs, and deliverables.
Provider settings stay in the external project and are never copied to output.
This script records topology and execution, not a benchmark quality score.
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-project", type=Path, required=True)
    parser.add_argument("--case", type=Path, required=True)
    parser.add_argument("--model", default="mimo-v2.6-flash")
    args = parser.parse_args()
    case = json.loads(args.case.read_text(encoding="utf-8"))
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

    project = Path(tempfile.mkdtemp(prefix="nexgent-program-live-"))
    service = TaskService(project, gateway_factory=gateway_factory)
    episode = service.create(
        case["objective"], inputs=case.get("inputs"),
        deliverables=case["deliverables"],
        capabilities=case.get("capabilities"),
        budget=case.get("budget", {
            "max_model_calls": 12, "max_completion_tokens": 48000,
        }),
        package=self_orchestration_package(),
    )
    state = service.run(episode["id"])
    private = service.get_private(episode["id"])
    graphs = []
    for ref, workflow in (private.get("plan_workflow_versions") or {}).items():
        graphs.append({
            "ref": ref,
            "nodes": [{"id": node["id"], "method": node["method"],
                       "role_ref": node.get("role_ref")}
                      for node in workflow.get("nodes", [])],
            "control_edges": workflow.get("control_edges", []),
            "artifact_edges": workflow.get("artifact_edges", []),
            "revision_rules": [rule.get("id")
                               for rule in workflow.get("revision_rules", [])],
        })
    report = {
        "project": str(project), "episode": episode["id"],
        "status": state["status"], "error": state.get("last_error"),
        "model_calls": state.get("usage", {}).get("model_calls"),
        "plan_revision": state.get("plan_revision"),
        "plan_revisions": state.get("plan_revisions", []),
        "graphs": graphs,
        "node_status": {name: node.get("status")
                        for name, node in state.get("nodes", {}).items()
                        if name.startswith("plan/nodes/")},
        "node_errors": {name: node.get("error")
                        for name, node in state.get("nodes", {}).items()
                        if name.startswith("plan/nodes/") and node.get("error")},
        "output_refs": state.get("output_refs", {}),
    }
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
