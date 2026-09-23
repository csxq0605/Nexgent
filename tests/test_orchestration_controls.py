"""The four-arm preflight equalizes task information and Episode ceilings."""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import sys
import threading

import pytest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from experiments.orchestration_controls.harness import (
    ARM_IDS,
    FourArmControlHarness,
    memory_ready_multirole_package,
)
from nexgent.tasks.benchmarks import BenchmarkDescriptor
from nexgent.tasks.memory import MemoryService
from nexgent.tasks.multirole_seed import single_role_equal_calls_package
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ContractError, ToolRegistry


BUDGET = {
    "max_model_calls": 3,
    "max_completion_tokens": 4800,
    "max_tool_calls": 0,
    "max_tool_work_units": 0,
    "max_nodes": 30,
}


class QualificationBenchmark:
    id = "four-arm-fixture"
    descriptor = BenchmarkDescriptor(
        id=id, version="1", title="Four-arm qualification fixture",
        splits=("selection", "final_holdout"), default_split="selection",
        modes=("fixed", "confirmatory"),
        allowed_suite_roles=("qualification",),
        evidence_scope="Deterministic runtime qualification only")

    def describe(self):
        return {"id": self.id}

    def snapshot(self):
        return {"id": self.id, "evaluator_digest": "fixture-v1"}

    def tasks(self, split="selection", seed=0):
        return [{
            "id": f"{self.id}/{split}/{seed}",
            "objective": "Answer the public arithmetic question.",
            "inputs": {"question": {"text": "Is 2 + 2 equal to 4?"}},
            "deliverables": [{"name": "result", "schema": {
                "type": "object", "required": ["answer"],
                "properties": {"answer": {"type": "string"}},
                "additionalProperties": False}}],
            "capabilities": [],
            "context": {"split": split, "seed": seed},
        }]

    def evaluate(self, task_ref, deliverables, execution_view):
        accepted = deliverables["result"] == {"answer": "yes"}
        return {"status": "accepted" if accepted else "rejected",
                "score_available": True, "score": float(accepted),
                "accepted": accepted}


class GatewayDouble:
    def __init__(self, final_status="received"):
        self.lock = threading.Lock()
        self.calls = []
        self.final_status = final_status

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                with owner.lock:
                    owner.calls.append((role, deepcopy(payload)))
                    call_id = f"control-model-{len(owner.calls)}"
                receipt = {
                    "call_id": call_id, "role": role,
                    "model": "DETERMINISTIC-CONTROL-DOUBLE", "status": "started",
                    "reserved_completion_tokens": max_tokens,
                    "max_tokens": max_tokens,
                }
                reserve(receipt)
                reserve({**receipt, "status": owner.final_status,
                         "billing_status": "usage_reported",
                         "usage": {"prompt_tokens": 2, "completion_tokens": 2,
                                   "total_tokens": 4}})
                return {"deliverables": {"result": {"answer": "yes"}}}

        return Gateway()


def accepted_memory(tasks, package):
    service = MemoryService(tasks)
    resource = {
        "policy": {
            "retrieval": {"kind": "literal-any-term", "version": 1,
                          "max_results": 5},
            "writeback": {"enabled": False, "allowed_kinds": []},
        },
        "data": {"items": [{
            "kind": "experience",
            "content": {"lesson": "Check arithmetic directly."},
            "applies_to": ["public arithmetic"],
            "counterexamples": [],
            "evidence_refs": ["development-episode-fixture"],
        }]},
    }
    version = service.admit(
        package, resource,
        provenance={"source": "development fixture; not holdout"})
    evaluator = {"id": "memory-fixture-v1"}
    plan = service.plan_selection(
        version["id"], criteria={"requires_source": True},
        evaluator_snapshot=evaluator)
    service.assess(
        plan["id"], evaluator_snapshot=evaluator, verdict="accepted",
        reason="fixture source is explicit", evidence={"checked": True})
    return service.register("four-arm-memory", version["id"])


def evolved_child(parent):
    files = deepcopy(parent["files"])
    files["prompts/adjudicator.md"] += " Verify the arithmetic one final time."
    return make_package(files, deepcopy(parent["manifest"]), parent=parent,
                        provenance={"source": "deterministic O/S fixture"})


def test_four_arm_preflight_uses_real_episodes_and_records_limits(tmp_path):
    adapter = QualificationBenchmark()
    gateway = GatewayDouble()
    tasks = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    fixed = memory_ready_multirole_package()
    memory = accepted_memory(tasks, fixed)
    harness = FourArmControlHarness(tasks, adapter)
    plan = harness.create_plan(
        fixed_package=fixed,
        single_package=single_role_equal_calls_package(),
        memory_registration=memory,
        evolved_package=evolved_child(fixed),
        evolved_surfaces=("S",), split="selection", seeds=(3, 7),
        episode_budget=BUDGET)

    run = harness.run(plan)

    assert run["status"] == "completed"
    assert run["valid_execution_preflight"] is True
    assert run["causal_effect_estimate"] is None
    assert run["claim_ceiling"] == "qualification_only_noncausal"
    assert len(run["cells"]) == 2 * len(ARM_IDS)
    assert {cell["arm"] for cell in run["cells"]} == set(ARM_IDS)
    assert all(cell["budget"] == BUDGET for cell in run["cells"])
    assert all(cell["usage"]["model_calls"] == 3 for cell in run["cells"])
    assert all(cell["received_model_call_count"] == 3 for cell in run["cells"])
    assert all(cell["model_call_statuses"] == ["received"] * 3
               for cell in run["cells"])
    assert all(cell["provider_reported_tokens"] == {
        "prompt_tokens": 6, "completion_tokens": 6, "total_tokens": 12}
        for cell in run["cells"])
    assert all(cell["accepted"] is True for cell in run["cells"])
    assert all(cell["memory_consumed"] for cell in run["cells"]
               if cell["arm"] == "memory_only")
    assert all(cell["memory_source"] is None for cell in run["cells"]
               if cell["arm"] in {"fixed_multi", "single_equal_budget", "evolved"})
    assert plan["arms"]["fixed_multi"]["package_digest"] == (
        plan["arms"]["memory_only"]["package_digest"])
    for row_index in range(2):
        assert len({cell["task_digest"] for cell in run["cells"]
                    if cell["row_index"] == row_index}) == 1
    assert all(len(set(cell["model_roles"])) >= 2 for cell in run["cells"]
               if cell["arm"] != "single_equal_budget")
    assert all(set(cell["model_roles"]) == {"solver"} for cell in run["cells"]
               if cell["arm"] == "single_equal_budget")


def test_noncanonical_terminal_receipts_cannot_pass_model_preflight(tmp_path):
    adapter = QualificationBenchmark()
    tasks = TaskService(
        tmp_path, tools=ToolRegistry(),
        gateway_factory=GatewayDouble(final_status="completed"))
    fixed = memory_ready_multirole_package()
    harness = FourArmControlHarness(tasks, adapter)
    plan = harness.create_plan(
        fixed_package=fixed,
        single_package=single_role_equal_calls_package(),
        memory_registration=accepted_memory(tasks, fixed),
        evolved_package=evolved_child(fixed), evolved_surfaces=("S",),
        split="selection", seeds=(5,), episode_budget=BUDGET)

    run = harness.run(plan)

    assert run["status"] == "completed"
    assert run["control_checks"]["successful_model_receipts"] is False
    assert run["control_checks"]["observed_role_structure"] is False
    assert run["valid_execution_preflight"] is False
    assert all(cell["received_model_call_count"] == 0 for cell in run["cells"])
    assert all(cell["usage"]["model_calls"] == 3 for cell in run["cells"])


def test_four_arm_preflight_rejects_confirmatory_and_mislabeled_surfaces(tmp_path):
    adapter = QualificationBenchmark()
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    fixed = memory_ready_multirole_package()
    memory = accepted_memory(tasks, fixed)
    harness = FourArmControlHarness(tasks, adapter)
    common = dict(
        fixed_package=fixed,
        single_package=single_role_equal_calls_package(),
        memory_registration=memory,
        evolved_package=evolved_child(fixed),
        episode_budget=BUDGET)

    with pytest.raises(ContractError, match="cannot consume final_holdout"):
        harness.create_plan(
            **common, evolved_surfaces=("S",), split="final_holdout", seeds=(1,))
    with pytest.raises(ContractError, match="surfaces must match"):
        harness.create_plan(
            **common, evolved_surfaces=("M",), split="selection", seeds=(1,))
