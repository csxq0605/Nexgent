"""A canonical benchmark must actually execute and evaluate model roles."""

from __future__ import annotations

from pathlib import Path
import sys
import threading

import pytest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from nexgent.tasks.benchmarks import BenchmarkDescriptor
from nexgent.tasks.evolution import _loaded_evidence, _manifest_component
from nexgent.tasks.multirole_seed import (
    multirole_package, single_role_equal_calls_package,
)
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ToolRegistry


class PublicTask:
    id = "multirole-fixture"
    descriptor = BenchmarkDescriptor(
        id=id, version="1", title="Multi-role execution fixture",
        splits=("development",), default_split="development",
        required_capabilities=(), evidence_scope="Runtime integration only")

    def describe(self):
        return {"id": self.id, "data_origin": "authored_fixture"}

    def snapshot(self):
        return {"id": self.id, "evaluator_digest": "multirole-fixture-v1"}

    def tasks(self, split="development", seed=0):
        return [{
            "id": f"{self.id}/{split}/{seed}",
            "objective": "Answer the public question.",
            "inputs": {"question": {"text": "Is 2 + 2 equal to 4?"}},
            "deliverables": [{"name": "result", "schema": {
                "type": "object", "required": ["answer"],
                "properties": {"answer": {"type": "string"}},
                "additionalProperties": False}}],
            "capabilities": [], "context": {"split": split, "seed": seed},
        }]

    def evaluate(self, task_ref, deliverables, execution_view):
        accepted = deliverables["result"] == {"answer": "yes"}
        return {"status": "accepted" if accepted else "rejected",
                "score_available": True, "score": float(accepted),
                "accepted": accepted}


class ThreeRoleGateway:
    def __init__(self, decision):
        self.calls = []
        self.lock = threading.Lock()
        self.decision = decision

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                with owner.lock:
                    owner.calls.append((role, payload))
                    call_id = f"model-{len(owner.calls)}"
                receipt = {"call_id": call_id, "role": role,
                           "model": "DETERMINISTIC-MULTIROLE-DOUBLE",
                           "status": "started",
                           "reserved_completion_tokens": max_tokens,
                           "max_tokens": max_tokens}
                reserve(receipt)
                reserve({**receipt, "status": "completed",
                         "billing_status": "usage_reported",
                         "usage": {"prompt_tokens": 2,
                                   "completion_tokens": 2,
                                   "total_tokens": 4}})
                if role == "adjudicator":
                    assert payload["task"]["inputs"]["question"]["text"] == (
                        "Is 2 + 2 equal to 4?")
                    assert "deliverables" in payload["proposal_a"]
                    assert "deliverables" in payload["proposal_b"]
                    return owner.decision
                return {"deliverables": {"result": {"answer": "yes"}}}

        return Gateway()


@pytest.mark.parametrize("decision", [
    {"deliverables": {"result": {"answer": "yes"}}},
    {"result": {"answer": "yes"}},
    {"answer": "yes"},
])
def test_canonical_benchmark_runs_three_model_roles_and_independent_evaluation(
        tmp_path, monkeypatch, decision):
    adapter = PublicTask()
    monkeypatch.setattr("nexgent.tasks.runtime.task_benchmarks",
                        lambda: {adapter.id: adapter})
    gateway = ThreeRoleGateway(decision)
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)

    run = service.benchmark(adapter.id, package=multirole_package())
    report = run["reports"][0]
    episode = service.get_private(report["episode_id"])

    assert report["evaluation"]["accepted"] is True
    assert episode["status"] == "completed"
    assert episode["usage"]["model_calls"] == 3
    assert episode["execution"]["package_digest"] == (
        service.store.package(episode["package_id"])["digest"])
    assert set(episode["execution"]["loaded_modules"]) >= {
        "workflows/main.json", "prompts/proposer_a.md",
        "prompts/proposer_b.md", "prompts/adjudicator.md",
        "skills/prepare.py", "skills/publish.py"}
    package = service.store.package(episode["package_id"])
    for component_id in ("main-workflow", "proposer-a-role", "publish-skill"):
        evidence = _loaded_evidence(
            _manifest_component(package, component_id),
            episode["execution"], package)
        assert evidence["loaded"] is True
    assert {role for role, _ in gateway.calls} == {
        "proposer_a", "proposer_b", "adjudicator"}
    assert episode["nodes"]["plan/nodes/adjudicator"]["role_ref"] == "adjudicator"
    assert service.store.read(episode["output_refs"]["result"], episode["id"])[
        "content"] == {"answer": "yes"}


def test_equal_call_single_role_control_uses_one_role_three_times(
        tmp_path, monkeypatch):
    adapter = PublicTask()
    monkeypatch.setattr("nexgent.tasks.runtime.task_benchmarks",
                        lambda: {adapter.id: adapter})
    gateway = ThreeRoleGateway({"deliverables": {"result": {"answer": "yes"}}})
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)

    run = service.benchmark(
        adapter.id, package=single_role_equal_calls_package(),
        budget={"max_model_calls": 3, "max_completion_tokens": 4800,
                "max_tool_calls": 0, "max_nodes": 30})
    report = run["reports"][0]
    episode = service.get_private(report["episode_id"])

    assert report["evaluation"]["accepted"] is True
    assert episode["usage"]["model_calls"] == 3
    assert [role for role, _ in gateway.calls] == ["solver"] * 3
    assert "previous_draft" in gateway.calls[1][1]
    assert "review" in gateway.calls[2][1]
