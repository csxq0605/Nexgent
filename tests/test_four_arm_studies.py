from pathlib import Path
import sys

import pytest


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexgent.tasks.benchmarks import BenchmarkDescriptor
from nexgent.tasks.four_arm_studies import ARM_IDS, FourArmStudyService
from nexgent.tasks.memory import MemoryService
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ContractError, ToolRegistry


BUDGET = {
    "max_model_calls": 0,
    "max_completion_tokens": 0,
    "max_tool_calls": 0,
    "max_nodes": 4,
}


def package(name, score):
    source = (
        "def execute(payload, context):\n"
        f"    artifact = context.publish({{'score': {score!r}, 'arm': {name!r}}}, name='result')\n"
        "    return {'deliverables': {'result': artifact['id']}}\n"
    )
    return make_package(
        {"behavior.py": source},
        {"entries": {"execute": "behavior.py:execute"}},
        provenance={"fixture": name},
    )


class HoldoutBenchmark:
    id = "four-arm-holdout-fixture"
    descriptor = BenchmarkDescriptor(
        id=id, version="1", title="Four-arm holdout fixture",
        splits=("final_holdout",), default_split="final_holdout",
        modes=("fixed", "confirmatory"),
        allowed_suite_roles=("qualification",),
        evidence_scope="Deterministic framework contract fixture",
    )

    def snapshot(self):
        return {"id": self.id, "version": "1", "evaluator_digest": "fixture-v1"}

    def tasks(self, split="final_holdout", seed=0):
        return [{
            "id": f"{split}/{seed}",
            "objective": "Publish the package result",
            "statistical_unit_id": f"unit/{seed}",
            "cluster_id": f"cluster/{seed % 2}",
            "inputs": {"public_seed": seed},
            "deliverables": [{
                "name": "result",
                "schema": {
                    "type": "object", "required": ["score", "arm"],
                    "properties": {
                        "score": {"type": "number"},
                        "arm": {"type": "string"},
                    },
                },
            }],
            "capabilities": [],
            "context": {"split": split, "public_seed": seed},
        }]

    def evaluate(self, task_ref, deliverables, execution_view):
        score = float(deliverables["result"]["score"])
        return {"status": "accepted" if score >= 0.5 else "rejected",
                "score_available": True, "score": score,
                "accepted": score >= 0.5}


def accepted_memory(tasks, fixed, channel="confirmatory-memory"):
    memory = MemoryService(tasks)
    version = memory.admit(
        fixed,
        {
            "policy": {
                "retrieval": {"kind": "literal-any-term", "version": 1,
                              "max_results": 5},
                "writeback": {"enabled": False, "allowed_kinds": []},
            },
            "data": {"items": [{
                "kind": "experience",
                "content": {"lesson": "Use only public task evidence."},
                "applies_to": ["fixture"], "counterexamples": [],
                "evidence_refs": ["development-fixture"],
            }]},
        },
        provenance={"source": "development fixture"},
    )
    evaluator = {"id": "fixture-memory-evaluator-v1"}
    plan = memory.plan_selection(
        version["id"], criteria={"source_required": True},
        evaluator_snapshot=evaluator,
    )
    memory.assess(
        plan["id"], evaluator_snapshot=evaluator, verdict="accepted",
        reason="deterministic fixture acceptance", evidence={"checked": True},
    )
    return memory.register(channel, version["id"])


def setup_service(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    fixed = package("fixed", 0.4)
    single = package("single", 0.3)
    evolved = package("evolved", 0.8)
    release = accepted_memory(tasks, fixed)
    service = FourArmStudyService(tasks, HoldoutBenchmark())
    return tasks, service, fixed, single, evolved, release


def create_plan(service, fixed, single, evolved, seeds=(11, 12)):
    return service.create_plan(
        fixed_package=fixed, single_package=single,
        evolved_package=evolved,
        memory_channel="confirmatory-memory",
        split="final_holdout", seeds=list(seeds), episode_budget=BUDGET,
        provider="none", model="none", require_model_calls=False,
    )


def test_four_arm_service_runs_real_taskservice_quartets_with_frozen_memory(tmp_path):
    tasks, service, fixed, single, evolved, release = setup_service(tmp_path)
    plan = create_plan(service, fixed, single, evolved)

    run = service.run(plan["id"])

    assert run["status"] == "completed"
    assert run["measurement_complete"] is True
    assert len(run["quartets"]) == 2
    assert all(quartet["status"] == "measured" for quartet in run["quartets"])
    assert len(run["cells"]) == 8
    assert set(cell["arm"] for cell in run["cells"]) == set(ARM_IDS)
    assert plan["arms"]["F"]["package_digest"] == plan["arms"]["M"]["package_digest"]
    assert plan["arms"]["M"]["memory_release"] == {
        key: release[key] for key in (
            "channel", "revision", "memory_id", "memory_digest",
            "package_id", "package_digest")
    }
    assert plan["arms"]["F"]["memory_release"] is None
    assert plan["arms"]["S"]["memory_release"] is None
    assert plan["arms"]["E"]["memory_release"] is None

    for row_index in range(2):
        members = [cell for cell in run["cells"] if cell["row_index"] == row_index]
        assert len(members) == 4
        assert len({cell["task_digest"] for cell in members}) == 1
        assert sorted(cell["position"] for cell in members) == [0, 1, 2, 3]

    for cell in run["cells"]:
        state = tasks.get_private(cell["episode_id"])
        snapshot = tasks.store.memory_snapshot(
            state["memory_snapshot_id"], state["id"])
        registration = tasks.store.memory_registration(state["id"])
        if cell["arm"] == "M":
            frozen = plan["arms"]["M"]["memory_release"]
            assert {key: registration[key] for key in frozen} == frozen
            assert snapshot["source"] == frozen
            assert len(snapshot["items"]) == 1
        else:
            assert registration is None
            assert snapshot["items"] == []

    episode_count = len(tasks.list())
    assert service.run(plan["id"])["id"] == run["id"]
    assert len(tasks.list()) == episode_count


def test_quartet_holdout_reservation_is_atomic_and_shared_with_existing_claims(tmp_path):
    tasks, service, fixed, single, evolved, _ = setup_service(tmp_path)
    first = create_plan(service, fixed, single, evolved, seeds=(31,))

    with pytest.raises(ContractError, match="already reserved"):
        create_plan(service, fixed, single, evolved, seeds=(31,))

    with tasks.store.connect() as db:
        plans = db.execute("SELECT id FROM task_four_arm_study_plans").fetchall()
        claims = db.execute(
            "SELECT plan_id FROM task_rsi_holdout_claims").fetchall()
    assert plans == [(first["id"],)]
    assert claims == [(first["id"],)]


def test_memory_release_disappearance_fails_closed_for_whole_quartet(tmp_path):
    tasks, service, fixed, single, evolved, _ = setup_service(tmp_path)
    plan = create_plan(service, fixed, single, evolved, seeds=(41,))
    with tasks.store.connect() as db:
        db.execute("DELETE FROM task_memory_channels WHERE name=?",
                   ("confirmatory-memory",))

    run = service.run(plan["id"])

    statuses = {cell["arm"]: cell for cell in run["cells"]}
    assert statuses["M"]["status"] == "missing"
    assert statuses["M"]["failure_class"] == "infrastructure_missing"
    assert statuses["M"]["reason"] == "prepare:ContractError"
    assert "confirmatory-memory" not in statuses["M"]["reason"]
    assert all(statuses[arm]["status"] == "measured" for arm in ("F", "S", "E"))
    assert run["quartets"] == [{
        "row_index": 0, "statistical_unit_id": "unit/41",
        "cluster_id": "cluster/1",
        "arm_statuses": {"F": "measured", "S": "measured",
                         "M": "missing", "E": "measured"},
        "status": "missing",
    }]
    assert run["measurement_complete"] is False


def test_interrupted_preparation_recovers_the_exact_persisted_episode(tmp_path):
    tasks, service, fixed, single, evolved, _ = setup_service(tmp_path)
    plan = create_plan(service, fixed, single, evolved, seeds=(47,))
    scheduled = plan["schedule"][0]
    owner, prior = service._claim(plan["id"])
    assert prior is None
    cell, created = service._reserve_cell(plan, scheduled, owner)
    assert created is True
    episode_id = service._prepare(plan, cell)
    # Simulate process loss after TaskService committed the Episode but before
    # the study cell advanced from preparing to ready.
    with tasks.store.connect() as db:
        db.execute("UPDATE task_four_arm_study_claims SET updated=0 WHERE plan_id=?",
                   (plan["id"],))

    recovery = service.recover(plan["id"], lease_seconds=1)
    assert recovery == {"plan_id": plan["id"], "status": "paused",
                        "recovered_cells": 1, "failed_closed_cells": 0}

    run = service.run(plan["id"])

    recovered = next(item for item in run["cells"] if item["id"] == cell["id"])
    assert recovered["episode_id"] == episode_id
    assert recovered["status"] == "measured"
    matching = [state for state in tasks.store.list()
                if state["task"]["context"].get("study_cell_id") == cell["id"]]
    assert [state["id"] for state in matching] == [episode_id]


def test_recovery_fails_closed_in_flight_episode_and_respects_live_lease(tmp_path):
    tasks, service, fixed, single, evolved, _ = setup_service(tmp_path)
    plan = create_plan(service, fixed, single, evolved, seeds=(49,))
    scheduled = plan["schedule"][0]
    owner, _ = service._claim(plan["id"])
    cell, _ = service._reserve_cell(plan, scheduled, owner)
    episode_id = service._prepare(plan, cell)
    service._advance(plan, scheduled, owner, "preparing",
                     {"status": "ready", "episode_id": episode_id})

    with pytest.raises(ContractError, match="lease has not expired"):
        service.recover(plan["id"])

    state = tasks.store.get(episode_id)
    state["status"] = "running"
    tasks.store.save(state)
    with tasks.store.connect() as db:
        db.execute("UPDATE task_four_arm_study_claims SET updated=0 WHERE plan_id=?",
                   (plan["id"],))

    recovery = service.recover(plan["id"], lease_seconds=1)
    assert recovery["failed_closed_cells"] == 1
    run = service.run(plan["id"])
    recovered = next(item for item in run["cells"] if item["id"] == cell["id"])
    assert recovered["status"] == "missing"
    assert recovered["episode_id"] == episode_id
    assert recovered["reason"] == "recovery:in_flight_side_effect_uncertain"
    assert run["measurement_complete"] is False


def test_four_arm_plan_rejects_memory_bound_to_another_package(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    fixed = package("fixed", 0.4)
    single = package("single", 0.3)
    evolved = package("evolved", 0.8)
    other = package("other", 0.2)
    accepted_memory(tasks, other)
    service = FourArmStudyService(tasks, HoldoutBenchmark())

    with pytest.raises(ContractError, match="another package"):
        create_plan(service, fixed, single, evolved, seeds=(51,))
