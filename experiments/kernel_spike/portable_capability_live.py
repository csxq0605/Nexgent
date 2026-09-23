"""One preregistered MiMo probe of task-authored tool adoption and reuse.

The arithmetic task family is a test fixture, not Nexgent product logic.
One creator attempt, one paired selection, one guard, and one fresh OS-process
reuse are allowed.  No prompt repair or rerun is performed by this script.
"""

from __future__ import annotations

from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

from nexgent.models.gateway import ModelGateway
from nexgent.tasks.capability_authority import make_episode_authority
from nexgent.tasks.evolution import EvolutionService, PromotionPolicy
from nexgent.tasks.generation import GenerationService
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.task_capability_adoption import TaskCapabilityAdoptionService
from nexgent.tasks.tools import ToolRegistry

from python_live_route import (
    MODEL_SOURCE_ROOT, _failure_receipt, _leak_free, _live_transport,
    _load_live_profile, _safe_call_receipt,
)


CHANNEL = "portable-multiplication-live-v1"
RESULT_SPEC = [{"name": "result", "schema": {
    "type": "object", "required": ["answer"],
    "properties": {"answer": {"type": "integer"}},
    "additionalProperties": False,
}}]
NUMBERS = {
    "creator": (6, 7),
    "selection": (123456789, 987654321),
    "guard": (98765431, 123457),
    "reuse": (1234567, 8901234),
}
CREATOR_BUDGET = {
    "max_model_calls": 1, "max_completion_tokens": 1800,
    "max_tool_calls": 1, "max_tool_work_units": 200000,
    "max_nodes": 16,
}
PAIR_BUDGET = {
    "max_model_calls": 1, "max_completion_tokens": 1800,
    "max_tool_calls": 1, "max_tool_work_units": 200000,
    "max_nodes": 16,
}
SOURCE = '''def execute(payload, context):
    a = payload['context']['a']
    b = payload['context']['b']
    available = context.capability_inventory()['tools']
    portable = [item for item in available if item.get('source') == 'agent_package']
    if portable:
        value = context.tool(portable[0]['name'], {'a': a, 'b': b})
    elif payload['context'].get('phase') == 'creator':
        proposed = context.ask(
            'tool_builder',
            'Return exactly one JSON object with proposal. The proposal has exactly '
            'name, description, source, input_schema, output_schema. Create a reusable '
            'pure Python integer-multiplication tool, not a constant answer. Source '
            'must define def execute(payload, context): and return {"answer": a*b} '
            'for arbitrary integer a,b from payload. Use no imports, files, network, '
            'context calls, or markdown. Input schema requires integer a,b; output '
            'schema requires integer answer. Choose a fresh descriptive tool name.',
            {'a': a, 'b': b, 'available_tools': available}, max_tokens=1400)
        developed = context.develop_tool(proposed['proposal'])
        value = context.tool(developed['name'], {'a': a, 'b': b})
    else:
        value = context.ask(
            'solver', 'Return exactly one JSON object with integer answer equal '
            'to a multiplied by b. Do not include explanation or markdown.',
            {'a': a, 'b': b}, max_tokens=400)
    artifact = context.publish({'answer': value['answer']}, name='result')
    return {'deliverables': {'result': artifact['id']}}
'''


def _package():
    return make_package(
        {"agent/main.py": SOURCE},
        {"manifest_version": 2,
         "entries": {"execute": "agent/main.py:execute"},
         "skills": {}, "roles": {}, "workflows": {},
         "components": {"main-entry": {
             "class": "O", "kind": "entry", "ref": "execute"}},
         "orchestrator": "main-entry"},
    )


def _gateway_factory(profile, profile_identity, profile_digest):
    def factory(reserve, stop_event):
        def audited(receipt):
            record = deepcopy(receipt)
            record["profile_identity"] = deepcopy(profile_identity)
            record["profile_digest"] = profile_digest
            reserve(record)
        gateway = ModelGateway(
            MODEL_SOURCE_ROOT, reserve=audited, stop_event=stop_event,
            timeout=90, transport=_live_transport, max_completion_tokens=1400)
        gateway.profiles = {profile.id: profile}
        gateway.defaults = {role: profile.id for role in (
            "main", "subagent", "tool_builder", "solver")}
        return gateway
    return factory


class MultiplicationBenchmark:
    id = "portable-multiplication-v1"

    def snapshot(self):
        return {"id": self.id, "evaluator_digest": "exact-product-v1"}

    def describe(self):
        return {"id": self.id, "kind": "private-exact-integer"}

    def tasks(self, split="selection", seed=0):
        a, b = NUMBERS["selection" if split == "selection" else "guard"]
        return [{"id": f"{split}/{seed}/product", "objective": "Multiply two integers exactly",
                 "inputs": {}, "deliverables": deepcopy(RESULT_SPEC),
                 "capabilities": [], "context": {"split": split, "a": a, "b": b}}]

    def evaluate(self, task_ref, deliverables, execution_view):
        context = task_ref["context"]
        passed = deliverables["result"]["answer"] == context["a"] * context["b"]
        return {"status": "accepted", "score_available": True,
                "accepted": passed, "score": 1.0 if passed else 0.0}


def _episode_summary(tasks, episode_id):
    episode = tasks.get_private(episode_id)
    result_ref = episode.get("output_refs", {}).get("result")
    result = (tasks.store.read(result_ref, episode_id)["content"]
              if result_ref else None)
    return {
        "id": episode_id, "status": episode["status"],
        "result": result, "usage": episode.get("usage"),
        "activated_components": episode.get("execution", {}).get(
            "activated_components", []),
        "model_receipts": [_safe_call_receipt(row)
                           for row in episode.get("calls", [])],
        "failure": _failure_receipt(episode, episode.get("calls", [])),
    }


def _reuse_in_separate_process(root):
    service = TaskService(root, tools=ToolRegistry())
    a, b = NUMBERS["reuse"]
    episode = service.create(
        "Multiply two new integers using the active package",
        package_channel=CHANNEL, deliverables=deepcopy(RESULT_SPEC),
        context={"split": "reuse", "a": a, "b": b},
        budget=PAIR_BUDGET)
    service.run(episode["id"])
    result = _episode_summary(service, episode["id"])
    result["expected_answer"] = a * b
    print(json.dumps(result, ensure_ascii=False))
    return 0 if (result["status"] == "completed"
                 and result["result"] == {"answer": a * b}
                 and result["activated_components"]) else 1


def run():
    root = Path(tempfile.mkdtemp(
        prefix=".nexgent-portable-live-", dir=MODEL_SOURCE_ROOT.parent)).resolve()
    profile, identity, profile_digest = _load_live_profile()
    tasks = TaskService(root, tools=ToolRegistry(), gateway_factory=(
        _gateway_factory(profile, identity, profile_digest)))
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    adoption = TaskCapabilityAdoptionService(tasks, evolution, generation)
    evolution.register(CHANNEL, _package())
    report = {
        "schema": "nexgent.portable-capability-live.v1",
        "profile_identity": identity, "profile_digest": profile_digest,
        "retry_policy": {"automatic_retries": 0, "attempts_per_ask": 1},
        "budgets": {"creator": CREATOR_BUDGET, "paired": PAIR_BUDGET},
        "task_family": "exact integer multiplication",
        "numbers": NUMBERS, "scratch_root": str(root),
        "stages": {}, "passed": False,
    }
    try:
        a, b = NUMBERS["creator"]
        creator = tasks.create(
            "Create and use one reusable multiplication tool",
            package_channel=CHANNEL,
            context={"phase": "creator", "split": "development",
                     "split_role": "development", "a": a, "b": b},
            deliverables=deepcopy(RESULT_SPEC),
            capability_authority=make_episode_authority(
                ["tool"], ["local_compute"], max_definitions=1,
                max_invocations=1),
            budget=CREATOR_BUDGET,
            constraints={"allowed_effects": ["local_compute"],
                         "wall_seconds": 240})
        tasks.run(creator["id"], stop_event=threading.Event())
        report["stages"]["creator"] = _episode_summary(tasks, creator["id"])
        if report["stages"]["creator"]["status"] != "completed":
            raise RuntimeError("creator did not complete")
        instances = tasks.store.tool_instances(creator["id"])
        if len(instances) != 1:
            raise RuntimeError("creator did not make exactly one tool")
        definition = tasks.store.tool_definition(instances[0]["definition_id"])
        report["source"] = {"definition_id": definition["id"],
                            "definition_digest": definition["digest"],
                            "name": definition["name"]}
        feedback = generation.capture_feedback(CHANNEL, [creator["id"]], 0)
        adopted = adoption.adopt(
            CHANNEL, definition["id"], creator["id"], feedback["id"], 0,
            {"failure_mechanism": "fresh tasks lack a reusable exact arithmetic tool",
             "expected_behavior": "candidate uses the portable tool on unseen operands",
             "applicability": "integer products with the same two-input contract",
             "falsifier": "the candidate fails activation or exact held-out evaluation"},
            budget={"max_model_calls": 0, "max_tool_calls": 0,
                    "max_nodes": 12})
        generated = adopted["generation"]
        report["stages"]["generation"] = {
            "status": generated["status"], "reason": generated.get("reason"),
            "candidate_id": generated.get("candidate_id"),
            "component_id": adopted["adoption"]["component_id"]}
        if generated["status"] != "generated":
            raise RuntimeError("candidate was not generated")
        candidate_id = generated["candidate_id"]
        benchmark = MultiplicationBenchmark()
        policy = PromotionPolicy(
            min_quality_delta=0.5, max_cost_ratio=20.0,
            monitor_min_score=1.0, monitor_min_success_rate=1.0)
        pair = evolution.plan_pair(
            candidate_id, benchmark, split="selection",
            split_role="selection", seed=17, policy=policy,
            budget=PAIR_BUDGET)
        trial = evolution.run_pair(pair["id"], benchmark)
        decision = evolution.assess(trial["id"])
        report["stages"]["selection"] = {
            "decision_id": decision["id"], "eligible": decision["eligible"],
            "gates": decision["gates"], "measurements": decision["measurements"],
            "arms": [{arm: _episode_summary(tasks, item[arm]["episode_id"])
                      for arm in ("parent", "candidate")}
                     for item in trial["pairs"]],
        }
        if not decision["eligible"]:
            raise RuntimeError("independent selection rejected the candidate")
        monitor_plan = evolution.plan_monitor(
            candidate_id, benchmark, split="guard", seed=23,
            budget=PAIR_BUDGET)
        promoted = evolution.promote(
            candidate_id, decision["id"], monitor_plan_id=monitor_plan["id"])
        report["stages"]["promotion"] = {
            "revision": promoted["revision"], "package_id": promoted["package_id"]}
        guard = evolution.run_monitor(CHANNEL, benchmark)
        monitored = evolution.monitor(CHANNEL, guard["episode_ids"])
        report["stages"]["guard"] = {
            "degraded": monitored["degraded"],
            "rolled_back": monitored["rolled_back"],
            "episodes": [_episode_summary(tasks, identity)
                         for identity in guard["episode_ids"]]}
        if monitored["degraded"] or monitored["rolled_back"]:
            raise RuntimeError("guard rolled back the candidate")
        command = [sys.executable, str(Path(__file__).resolve()),
                   "--reuse", str(root)]
        process = subprocess.run(
            command, check=False, capture_output=True, text=True,
            timeout=180, env=os.environ.copy())
        report["stages"]["reuse_process"] = {
            "exit_code": process.returncode,
            "result": json.loads(process.stdout) if process.stdout.strip() else None,
            "stderr_type": "present" if process.stderr.strip() else None}
        if process.returncode != 0:
            raise RuntimeError("fresh process did not reuse the promoted tool")
        report["passed"] = True
    except Exception as exc:
        report["failure"] = {"type": type(exc).__name__,
                             "message": str(exc)[:1000]}
    serialized = json.dumps(report, ensure_ascii=False, sort_keys=True)
    report["leak_scan_passed"] = _leak_free(root, serialized, profile.api_key)
    if not report["leak_scan_passed"]:
        report = {"schema": "nexgent.portable-capability-live.v1",
                  "passed": False, "leak_scan_passed": False}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report.get("passed") else 1


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--reuse":
        raise SystemExit(_reuse_in_separate_process(Path(sys.argv[2])))
    raise SystemExit(run())
