"""Domain-neutral pure-M qualification pilot contracts."""

from copy import deepcopy
import itertools
import json
from pathlib import Path
import sys
import threading

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from experiments.memory_qualification.pilot import (
    freeze_tasks,
    memory_ready_package,
    root_memory_resource,
    run_pilot,
)
from nexgent.tasks.tools import ContractError


class PublicAdapter:
    id = "public-memory-qualification"

    def snapshot(self):
        return {"id": self.id, "version": 1, "evaluator_digest": "public-fixture-v1"}

    def tasks(self, split="development", seed=0):
        return [{
            "id": f"{split}/{seed}/{index}",
            "statistical_unit_id": f"unit/{split}/{seed}/{index}",
            "objective": "Return the public fixture answer",
            "inputs": {"problem": {"instruction": "Return ok"}},
            "deliverables": [{"name": "answer", "schema": {
                "type": "object", "required": ["answer"],
                "properties": {"answer": {"type": "string"}},
            }}],
            "constraints": {"allowed_effects": ["artifact_write"]},
            "capabilities": [],
            "context": {"split": split, "seed": seed, "memory_writeback": False},
        } for index in range(2)]

    def evaluate(self, task_ref, deliverables, execution_view):
        answer = deliverables.get("answer")
        accepted = isinstance(answer, dict) and answer.get("answer") == "ok"
        return {"status": "accepted" if accepted else "rejected",
                "score_available": True, "score": float(accepted),
                "accepted": accepted}


class FixtureGateway:
    def __init__(self):
        self.calls = []
        self._ids = itertools.count(1)
        self._lock = threading.Lock()

    def __call__(self, reserve, stop_event):
        owner = self

        class Bound:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                with owner._lock:
                    number = next(owner._ids)
                    owner.calls.append({"role": role, "payload": deepcopy(payload)})
                record = {
                    "call_id": f"fixture-{number}", "role": role,
                    "model": "mimo-v2.6-flash-fixture", "status": "started",
                    "reserved_completion_tokens": max_tokens,
                }
                reserve(record)
                reserve({**record, "status": "completed",
                         "billing_status": "usage_reported",
                         "usage": {"prompt_tokens": 10, "completion_tokens": 10,
                                   "total_tokens": 20}})
                if role == "rsi_improver":
                    policy = payload["mutation_policy"]
                    return {
                        "schema": "nexgent.memory-component-patch.v1",
                        "hypothesis": {
                            "component_id": "working-memory",
                            "failure_mechanism": "No reusable public procedure is available.",
                            "expected_behavior": "A later task can retrieve one procedure.",
                            "applicability": "Tasks using the declared M resource.",
                            "falsifier": "The selected snapshot does not consume the item.",
                        },
                        "operations": [{
                            "op": "replace", "component_id": "working-memory",
                            "surface": "data",
                            "old_digest": policy["memory_surface_digests"]["data"],
                            "value": {"items": [{
                                "kind": "procedure",
                                "content": {"note": "PRIVATE_MEMORY_CANDIDATE_BODY"},
                                "applies_to": ["public tasks"],
                                "counterexamples": [],
                                "evidence_refs": [payload["feedback_bundle"]["id"]],
                            }]},
                        }],
                        "activation_probe": {
                            "kind": "memory_snapshot_frozen",
                            "component_id": "working-memory"},
                    }
                return {"deliverables": {"answer": {"answer": "ok"}},
                        "rationale": "public fixture"}

        return Bound()


def test_memory_ready_parent_has_empty_m_resource_and_real_retrieval():
    package = memory_ready_package()
    descriptor = package["manifest"]["components"]["working-memory"]
    assert descriptor == {"class": "M", "kind": "resource",
                          "ref": "memory/root.json"}
    assert json.loads(package["files"]["memory/root.json"]) == root_memory_resource()
    assert 'context.memory_search("", 20)' in package["files"]["skills/prepare.py"]


def test_task_units_are_frozen_and_pairwise_disjoint_before_generation():
    frozen = freeze_tasks(
        PublicAdapter(), feedback_seed=0, selection_seed=0, reuse_seed=1)
    units = [task["statistical_unit_id"] for task in frozen.values()]
    assert len(set(units)) == 3

    class Overlapping(PublicAdapter):
        def tasks(self, split="development", seed=0):
            rows = super().tasks(split, seed)
            for row in rows:
                row["statistical_unit_id"] = "same-unit"
            return rows

    with pytest.raises(ContractError, match="unused statistical unit"):
        freeze_tasks(Overlapping(), feedback_seed=0, selection_seed=0, reuse_seed=1)


def test_fixture_closes_generated_m_selection_promotion_and_frozen_reuse(tmp_path):
    gateway = FixtureGateway()
    receipt_path = tmp_path / "receipt.json"
    receipt = run_pilot(
        tmp_path, PublicAdapter(), gateway_factory=gateway,
        feedback_seed=0, selection_seed=0, reuse_seed=1,
        receipt_path=receipt_path)

    assert receipt["status"] == "completed"
    assert receipt["claim"] == "mechanism_qualification_only"
    assert receipt["generation"]["status"] == "generated"
    assert receipt["selection"]["memory_consumed"] is True
    assert receipt["selection"]["verdict"] == "accepted"
    assert receipt["promotion"]["revision"] == 1
    assert receipt["reuse"]["promoted_memory_frozen"] is True
    assert receipt["reuse"]["candidate_memory_consumed"] is True
    assert len({row["statistical_unit_id"]
                for row in receipt["frozen_tasks"].values()}) == 3
    encoded = receipt_path.read_text(encoding="utf-8")
    assert "PRIVATE_MEMORY_CANDIDATE_BODY" not in encoded
    assert "instruction" not in encoded
    assert sum(call["role"] == "rsi_improver" for call in gateway.calls) == 1

    spent_calls = len(gateway.calls)
    with pytest.raises(ContractError, match="already spent"):
        run_pilot(
            tmp_path, PublicAdapter(), gateway_factory=gateway,
            feedback_seed=0, selection_seed=0, reuse_seed=1,
            receipt_path=tmp_path / "duplicate.json")
    assert len(gateway.calls) == spent_calls
