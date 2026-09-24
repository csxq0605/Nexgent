"""Default improver integration across public planning and patch generation."""

from copy import deepcopy
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexgent.models import ModelGateway
from nexgent.tasks.evolution import EvolutionService
from nexgent.tasks.feedback_trigger import AutoEvolutionService, DEVELOPMENT_PLAN_SCHEMA
from nexgent.tasks.generation import GenerationService
from nexgent.tasks.improver_seed import default_improver_package
from nexgent.tasks.improvers import ImproverService
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ToolRegistry


PRIVATE_TEXT = "PRIVATE-EVALUATOR-CONTEXT-MUST-STAY-HOST-SIDE"


def _parent():
    source = (
        "def execute(payload, context):\n"
        "    artifact = context.publish({'version': 0}, name='result')\n"
        "    context.feedback({'valid': False, 'failure_code': 'invalid_output', "
        f"'note': {PRIVATE_TEXT!r}}})\n"
        "    return {'deliverables': {'result': artifact['id']}}\n"
    )
    return make_package(
        {"main.py": source}, {"entries": {"execute": "main.py:execute"}},
        provenance={"fixture": "default-improver-planner-parent"},
    )


def _hypothesis():
    return {
        "failure_mechanism": "The public invalid_output signal identifies the active loop.",
        "expected_behavior": "The replacement emits the required public result shape.",
        "applicability": "Tasks executed by the same generic loop.",
        "falsifier": "Independent tasks remain invalid after the changed loop is loaded.",
    }


class _Transport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def __call__(self, profile, params):
        self.requests.append(deepcopy(params))
        response = self.responses.pop(0)
        return {
            "content": json.dumps(response),
            "finish_reason": "stop",
            "response_id": f"scripted-{len(self.requests)}",
            "observed_model": profile.model,
            "system_fingerprint": "test-revision",
            "usage": {"prompt_tokens": 20, "completion_tokens": 30,
                      "total_tokens": 50},
        }


def _setup(tmp_path, responses):
    (tmp_path / "models.json").write_text(json.dumps({
        "providers": {"test": {
            "base_url": "https://token-plan-cn.xiaomimimo.com/v1",
            "api_key": "unit-test-secret",
            "models": {"mimo-v2.5": {}},
        }},
        "defaults": {"main": "test/mimo-v2.5", "subagent": "test/mimo-v2.5"},
    }), encoding="utf-8")
    transport = _Transport(responses)

    def gateway(reserve, stop_event):
        return ModelGateway(
            tmp_path, reserve=reserve, stop_event=stop_event,
            transport=transport, max_completion_tokens=6000)

    tasks = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    evolution = EvolutionService(tasks)
    parent = _parent()
    evolution.register("general", parent)
    generation = GenerationService(tasks, evolution)
    improver = default_improver_package()
    ImproverService(tasks).register(
        "ordinary-improver", improver,
        {"mutable_paths": ["improver.py"],
         "allowed_operations": ["replace"]},
    )
    trigger = AutoEvolutionService(
        tasks,
        policies={"general": {
            "evaluator_id": "independent-evaluator",
            "candidate_types": ["orchestration", "no_change"],
            "budget": {"max_model_calls": 1, "max_completion_tokens": 6000,
                       "max_tool_calls": 0, "max_nodes": 8},
            "improver": {"channel": "ordinary-improver", "revision": 0},
        }},
        evolution_service=evolution, generation_service=generation,
        evaluator_available=lambda _identity: True,
    )
    episode = tasks.create(
        "Produce an ordinary public result", package_channel="general",
        context={"split": "development", "split_role": "development",
                 "private_evaluator_answer": PRIVATE_TEXT},
    )
    tasks.run(episode["id"])
    [captured] = trigger.drain()
    return tasks, evolution, trigger, parent, transport, captured


def _user_payload(request):
    return json.loads(request["messages"][1]["content"])


def test_default_execute_plans_no_change_from_public_feedback_with_mimo_gateway(tmp_path):
    plan = {
        "schema": DEVELOPMENT_PLAN_SCHEMA,
        "candidate_type": "no_change", "source_ref": None,
        "hypothesis": None,
        "reason": "Public evidence does not isolate a reusable repair.",
    }
    tasks, evolution, trigger, parent, transport, captured = _setup(
        tmp_path, [plan])

    [work] = trigger.drain_development()

    assert work["id"] == captured["id"]
    assert work["status"] == "no_change"
    assert evolution.active("general")["package_id"] == parent["id"]
    assert len(transport.requests) == 1
    request = transport.requests[0]
    assert request["extra_body"] == {"thinking": {"type": "disabled"}}
    assert request["max_completion_tokens"] == 3000
    payload = _user_payload(request)
    assert PRIVATE_TEXT not in json.dumps(payload)
    assert payload["feedback_bundle"]["schema"] == "nexgent.feedback-bundle.v1"
    assert any(option["candidate_type"] == "no_change"
               for option in payload["candidate_options"])
    development = tasks.get_private(work["development_episode"]["id"])
    assert development["execution"]["entry"] == "execute"


def test_default_execute_selects_exact_option_then_improve_generates_patch(tmp_path):
    parent = _parent()
    hypothesis = _hypothesis()
    plan = {
        "schema": DEVELOPMENT_PLAN_SCHEMA,
        "candidate_type": "orchestration", "source_ref": "package_patch",
        "hypothesis": hypothesis,
        "reason": "The public failure code supports one bounded loop repair.",
    }
    replacement = parent["files"]["main.py"].replace("'version': 0", "'version': 1")
    patch = {
        "schema": "nexgent.behavior-patch.v1",
        "hypothesis": hypothesis,
        "operations": [{
            "op": "replace", "path": "main.py",
            "old_digest": parent["component_digests"]["main.py"],
            "content": replacement,
        }],
        "activation_probe": {"kind": "component_loaded", "path": "main.py"},
    }
    _, evolution, trigger, active_parent, transport, _ = _setup(
        tmp_path, [plan, patch])

    [work] = trigger.drain_development()

    assert work["status"] == "candidate_ready"
    assert len(transport.requests) == 2
    planning_payload = _user_payload(transport.requests[0])
    selected = {"candidate_type": plan["candidate_type"],
                "source_ref": plan["source_ref"]}
    assert selected in [
        {"candidate_type": option["candidate_type"],
         "source_ref": option["source_ref"]}
        for option in planning_payload["candidate_options"]
    ]
    assert "candidate_options" not in _user_payload(transport.requests[1])
    candidate = evolution.candidate(work["candidate"]["candidate_id"])
    assert candidate["parent_package_id"] == active_parent["id"]
    assert candidate["origin"] == "generated"
    assert evolution.active("general")["package_id"] == active_parent["id"]


def test_default_execute_rejects_a_model_invented_candidate_option(tmp_path):
    plan = {
        "schema": DEVELOPMENT_PLAN_SCHEMA,
        "candidate_type": "tool", "source_ref": "invented-definition",
        "hypothesis": _hypothesis(),
        "reason": "This receipt was not supplied by the host.",
    }
    _, evolution, trigger, parent, transport, _ = _setup(tmp_path, [plan])

    [work] = trigger.drain_development()

    assert work["status"] == "rejected"
    assert work["reason"] == "development_episode_incomplete"
    assert len(transport.requests) == 1
    assert evolution.active("general")["package_id"] == parent["id"]


def test_default_improver_registers_distinct_planning_and_generation_entries():
    package = default_improver_package()

    assert package["manifest"]["entries"] == {
        "execute": "improver.py:execute",
        "improve": "improver.py:improve",
    }
    assert "prompts/develop.md" in package["files"]
    assert "prompts/improve.md" in package["files"]
