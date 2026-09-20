"""Focused contracts for the host-owned, domain-neutral memory lifecycle."""

from concurrent.futures import ThreadPoolExecutor
import json

import pytest

from nexgent.kernel.programs import digest
from nexgent.tasks.evolution import EvolutionService
from nexgent.tasks.memory import MemoryService
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ContractError, ToolRegistry


def package(parent=None, marker="base"):
    return make_package(
        {"agent.py": (
            "def execute(payload, context):\n"
            "    return {'deliverables': {}}\n"
            f"# {marker}\n")},
        {"entries": {"execute": "agent.py:execute"}}, parent=parent)


def resource(*lessons, writeback=False, maximum=5):
    return {
        "policy": {
            "retrieval": {"kind": "literal-any-term", "version": 1,
                          "max_results": maximum},
            "writeback": {"enabled": writeback,
                          "allowed_kinds": ["experience"] if writeback else []},
        },
        "data": {"items": [
            {"kind": "experience", "content": {"lesson": lesson},
             "applies_to": [], "counterexamples": [], "evidence_refs": []}
            for lesson in lessons
        ]},
    }


def select(memory, identity, *, channel=None, revision=None, verdict="accepted",
           secret="private-evaluator-answer"):
    snapshot = {"evaluator": "host-memory-check-v1", "secret": secret}
    plan = memory.plan_selection(
        identity, criteria={"minimum": 1, "hidden_task": "do-not-project"},
        evaluator_snapshot=snapshot, channel=channel, expected_revision=revision)
    decision = memory.assess(
        plan["id"], evaluator_snapshot=snapshot, verdict=verdict,
        reason="host-only measured result", evidence={"private_score": 0.91})
    return plan, decision


def bootstrap(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    memory = MemoryService(tasks)
    pkg = package()
    root = memory.admit(pkg, resource("root trusted lesson"),
                        provenance={"private_task": "bootstrap hidden"})
    select(memory, root["id"])
    active = memory.register("general", root["id"])
    return tasks, memory, pkg, root, active


def test_candidate_claims_do_not_seed_later_episodes(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    pkg = package()
    producer = tasks.create("produce candidate", package=pkg,
                            context={"memory_namespace": "shared"})
    item = tasks.store.remember(producer["id"], {"lesson": "unreviewed claim"})
    assert tasks.store.search(producer["id"], "unreviewed") == [item]

    later = tasks.create("later task", package=pkg,
                         context={"memory_namespace": "shared"})
    snapshot = tasks.store.memory_snapshot(later["memory_snapshot_id"], later["id"])
    assert snapshot["items"] == []
    assert tasks.store.search(later["id"], "unreviewed") == []


def test_accepted_memory_cannot_bypass_its_release_through_legacy_snapshot(tmp_path):
    tasks, _, pkg, _, _ = bootstrap(tmp_path)
    later = tasks.create("legacy path", package=pkg)
    snapshot = tasks.store.memory_snapshot(later["memory_snapshot_id"], later["id"])
    assert snapshot["items"] == []
    assert snapshot.get("source") is None


def test_frozen_episode_snapshot_survives_promotion_and_rollback(tmp_path):
    tasks, memory, pkg, root, active = bootstrap(tmp_path)
    before = tasks.create("before promotion", package=pkg, memory_channel="general",
                          expected_memory_registration=active)
    before_snapshot = tasks.store.memory_snapshot(
        before["memory_snapshot_id"], before["id"])

    child = memory.admit(pkg, resource("child selected lesson"), parent_id=root["id"])
    select(memory, child["id"], channel="general", revision=0)
    promoted = memory.promote("general", child["id"], expected_revision=0,
                              expected_memory_id=root["id"])
    after = tasks.create("after promotion", package=pkg, memory_channel="general",
                         expected_memory_registration=promoted)
    after_snapshot = tasks.store.memory_snapshot(after["memory_snapshot_id"], after["id"])

    assert before_snapshot["source"]["memory_id"] == root["id"]
    assert before_snapshot["items"][0]["content"]["lesson"] == "root trusted lesson"
    assert after_snapshot["source"]["memory_id"] == child["id"]
    assert after_snapshot["items"][0]["content"]["lesson"] == "child selected lesson"
    assert memory.version(root["id"])["status"] == "accepted"
    assert memory.version(child["id"])["status"] == "accepted"
    with pytest.raises(ContractError, match="rollback target"):
        memory.retire(root["id"], reason="would break the deployment edge")

    rolled_back = memory.rollback(
        "general", reason="guard regression", expected_revision=1,
        expected_memory_id=child["id"])
    restored = tasks.create("after rollback", package=pkg, memory_channel="general",
                            expected_memory_registration=rolled_back)
    restored_snapshot = tasks.store.memory_snapshot(
        restored["memory_snapshot_id"], restored["id"])
    assert restored_snapshot["source"]["memory_id"] == root["id"]
    assert tasks.store.memory_snapshot(
        before["memory_snapshot_id"], before["id"])["digest"] == before_snapshot["digest"]


def test_selection_and_promotion_fail_closed_under_release_race(tmp_path):
    _, memory, pkg, root, _ = bootstrap(tmp_path)
    children = [memory.admit(pkg, resource(f"candidate {index}"), parent_id=root["id"])
                for index in range(2)]
    for child in children:
        select(memory, child["id"], channel="general", revision=0)

    def promote(child):
        try:
            return memory.promote("general", child["id"], expected_revision=0)["memory_id"]
        except ContractError:
            return None

    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(promote, children))
    assert sum(result is not None for result in results) == 1
    assert memory.active("general")["revision"] == 1
    loser = next(child for child in children if child["id"] != memory.active("general")["memory_id"])
    assert memory.version(loser["id"])["status"] == "accepted"
    assert memory.retire(loser["id"], reason="lost frozen selection")["status"] == "retired"
    with pytest.raises(ContractError, match="active.*retired"):
        memory.retire(memory.active("general")["memory_id"], reason="unsafe")


def test_selection_freezes_evaluator_and_release_before_acceptance(tmp_path):
    _, memory, pkg, root, _ = bootstrap(tmp_path)
    evaluator = {"id": "private-check", "revision": 1}
    stale = memory.admit(pkg, resource("stale candidate"), parent_id=root["id"])
    stale_plan = memory.plan_selection(
        stale["id"], criteria={"minimum": 1}, evaluator_snapshot=evaluator,
        channel="general", expected_revision=0)
    with pytest.raises(ContractError, match="different selection plan"):
        memory.plan_selection(
            stale["id"], criteria={"minimum": 2}, evaluator_snapshot=evaluator,
            channel="general", expected_revision=0)
    with pytest.raises(ContractError, match="evaluator changed"):
        memory.assess(
            stale_plan["id"], evaluator_snapshot={"id": "private-check", "revision": 2},
            verdict="accepted", reason="changed evaluator")
    assert memory.version(stale["id"])["status"] == "candidate"

    winner = memory.admit(pkg, resource("winner"), parent_id=root["id"])
    select(memory, winner["id"], channel="general", revision=0)
    memory.promote("general", winner["id"], expected_revision=0)
    with pytest.raises(ContractError, match="release changed"):
        memory.assess(
            stale_plan["id"], evaluator_snapshot=evaluator,
            verdict="accepted", reason="stale release")
    assert memory.version(stale["id"])["status"] == "candidate"


def test_rejected_revision_is_filterable_and_cannot_release(tmp_path):
    _, memory, pkg, root, _ = bootstrap(tmp_path)
    rejected = memory.admit(pkg, resource("bad claim"), parent_id=root["id"])
    select(memory, rejected["id"], channel="general", revision=0, verdict="rejected")
    assert [row["id"] for row in memory.list_versions(status="rejected")] == [rejected["id"]]
    with pytest.raises(ContractError, match="accepted"):
        memory.promote("general", rejected["id"], expected_revision=0)


def test_public_projection_withholds_memory_and_host_evaluator_content(tmp_path):
    _, memory, pkg, root, _ = bootstrap(tmp_path)
    child = memory.admit(
        pkg, resource("secret task answer marker"), parent_id=root["id"],
        provenance={"hidden_evaluator": "implementation source"})
    select(memory, child["id"], channel="general", revision=0,
           secret="private answer key marker")
    public = memory.public_version(child["id"])
    encoded = json.dumps(public, sort_keys=True)
    for marker in ("secret task answer", "implementation source", "private answer key",
                   "hidden_task", "private_score", "host-only measured"):
        assert marker not in encoded
    assert public["parent_id"] == root["id"] and public["item_count"] == 1
    assert public["decision"]["verdict"] == "accepted"
    assert "resource" not in public and "provenance" not in public

    memory.promote("general", child["id"], expected_revision=0)
    memory.rollback(
        "general", reason="private rollback diagnosis", expected_revision=1,
        expected_memory_id=child["id"])
    public_channel = json.dumps(memory.public_channel("general"), sort_keys=True)
    for marker in ("secret task answer", "implementation source", "private answer key",
                   "hidden_task", "private_score", "host-only measured",
                   "private rollback diagnosis"):
        assert marker not in public_channel


def test_package_binding_and_corrupt_memory_fail_before_episode_creation(tmp_path):
    tasks, memory, pkg, root, active = bootstrap(tmp_path)
    other = package(marker="other")
    count = len(tasks.store.list())
    with pytest.raises(ContractError, match="different AgentPackage"):
        tasks.create("wrong package", package=other, memory_channel="general")
    assert len(tasks.store.list()) == count

    with tasks.store.connect() as db:
        row = db.execute("SELECT data FROM task_memory_versions WHERE id=?",
                         (root["id"],)).fetchone()
        tampered = json.loads(row[0])
        tampered["resource"]["data"]["items"][0]["content"] = {"leak": "changed"}
        db.execute("UPDATE task_memory_versions SET data=?,record_digest=? WHERE id=?",
                   (json.dumps(tampered, sort_keys=True, separators=(",", ":")),
                    digest(tampered), root["id"]))
    with pytest.raises(ContractError, match="integrity"):
        tasks.create("corrupt memory", package=pkg, memory_channel="general")
    assert len(tasks.store.list()) == count


def test_episode_transaction_rechecks_loaded_memory_record(tmp_path, monkeypatch):
    import nexgent.tasks.memory as memory_module

    tasks, memory, pkg, root, memory_registration = bootstrap(tmp_path)
    count = len(tasks.store.list())
    original = memory_module.memory_version

    def load_then_tamper(store, identity):
        loaded = original(store, identity)
        with store.connect() as db:
            row = db.execute(
                "SELECT data FROM task_memory_versions WHERE id=?", (identity,)).fetchone()
            tampered = json.loads(row[0])
            tampered["provenance"] = {"changed_after_resolution": True}
            db.execute(
                "UPDATE task_memory_versions SET data=?,record_digest=? WHERE id=?",
                (json.dumps(tampered, sort_keys=True, separators=(",", ":")),
                 digest(tampered), identity))
        return loaded

    monkeypatch.setattr(memory_module, "memory_version", load_then_tamper)
    with pytest.raises(PermissionError, match="does not match its registration"):
        tasks.create(
            "tampered after resolution", package=pkg, memory_channel="general",
            expected_memory_registration=memory_registration)
    assert len(tasks.store.list()) == count


def test_expected_memory_registration_pins_resolved_release_during_drift(
        tmp_path, monkeypatch):
    import nexgent.tasks.memory as memory_module

    tasks, memory, pkg, root, active = bootstrap(tmp_path)
    child = memory.admit(pkg, resource("new active memory"), parent_id=root["id"])
    select(memory, child["id"], channel="general", revision=0)
    original = memory_module.active_memory_registration
    drifted = {"done": False}

    def resolve_then_drift(store, channel):
        registration = original(store, channel)
        if not drifted["done"]:
            drifted["done"] = True
            memory.promote(
                channel, child["id"], expected_revision=active["revision"],
                expected_memory_id=active["memory_id"])
        return registration

    monkeypatch.setattr(memory_module, "active_memory_registration", resolve_then_drift)
    episode = tasks.create(
        "pin resolved memory", package=pkg, memory_channel="general",
        expected_memory_registration=active)
    registration = tasks.store.memory_registration(episode["id"])
    snapshot = tasks.store.memory_snapshot(
        episode["memory_snapshot_id"], episode["id"])
    assert registration == active
    assert snapshot["source"]["memory_id"] == root["id"]
    assert memory.active("general")["memory_id"] == child["id"]


def test_package_and_memory_channels_fail_closed_when_heads_do_not_match(tmp_path):
    tasks, memory, pkg, root, _ = bootstrap(tmp_path)
    evolution = EvolutionService(tasks)
    evolution.register("agents", pkg)
    child_package = package(parent=pkg, marker="package-bound memory")
    child_memory = memory.admit(
        child_package, resource("memory for child package"), parent_id=root["id"])
    select(memory, child_memory["id"], channel="general", revision=0)
    memory.promote("general", child_memory["id"], expected_revision=0)
    count = len(tasks.store.list())
    with pytest.raises(ContractError, match="different AgentPackage"):
        tasks.create(
            "mixed deployment", package_channel="agents", memory_channel="general")
    assert len(tasks.store.list()) == count


def test_delegated_episode_inherits_memory_and_cannot_switch_release(tmp_path):
    tasks, memory, pkg, root, _ = bootstrap(tmp_path)
    parent = tasks.create("parent", package=pkg, memory_channel="general")

    other_root = memory.admit(pkg, resource("other release"))
    select(memory, other_root["id"])
    memory.register("other", other_root["id"])
    with pytest.raises(PermissionError, match="cannot change.*memory"):
        tasks.create(
            "bad child", package=pkg, parent_episode_id=parent["id"],
            memory_channel="other")

    child = tasks.create("good child", package=pkg, parent_episode_id=parent["id"])
    parent_source = tasks.store.memory_snapshot(
        parent["memory_snapshot_id"], parent["id"])["source"]
    child_source = tasks.store.memory_snapshot(
        child["memory_snapshot_id"], child["id"])["source"]
    assert child_source == parent_source
    assert child_source["memory_id"] == root["id"]


def test_oversized_snapshot_failure_leaves_no_episode_or_registration(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    memory = MemoryService(tasks)
    pkg = package()
    oversized = memory.admit(pkg, resource(*(["x" * 800] * 1000)))
    select(memory, oversized["id"])
    active = memory.register("oversized", oversized["id"])
    with tasks.store.connect() as db:
        before = tuple(db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                       for table in ("task_episodes", "task_memory_registrations",
                                     "task_snapshots"))
    with pytest.raises(ValueError, match="1 MB"):
        tasks.create(
            "too much frozen memory", package=pkg, memory_channel="oversized",
            expected_memory_registration=active)
    with tasks.store.connect() as db:
        after = tuple(db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                      for table in ("task_episodes", "task_memory_registrations",
                                    "task_snapshots"))
    assert after == before


def test_policy_and_data_are_distinct_and_writeback_is_enforced(tmp_path):
    tasks, memory, pkg, root, _ = bootstrap(tmp_path)
    changed_policy = resource("root trusted lesson", writeback=True)
    child = memory.admit(pkg, changed_policy, parent_id=root["id"])
    assert child["resource"]["data"] == root["resource"]["data"]
    assert child["resource"]["policy"] != root["resource"]["policy"]
    assert child["digest"] != root["digest"]

    no_write_package = make_package(
        {"agent.py": (
            "def execute(payload, context):\n"
            "    context.remember({'claim': 'must stay candidate'})\n"
            "    return {'deliverables': {}}\n")},
        {"entries": {"execute": "agent.py:execute"}})
    no_write = memory.admit(no_write_package, resource("read only"))
    select(memory, no_write["id"])
    memory.register("read-only", no_write["id"])
    episode = tasks.create("respect frozen policy", package=no_write_package,
                           memory_channel="read-only")
    result = tasks.run(episode["id"])
    assert result["status"] == "failed"
    assert "does not allow" in result["last_error"]


@pytest.mark.parametrize("limit", [-1, 101, "5", True, None])
def test_memory_search_limit_fails_closed(tmp_path, limit):
    pkg = make_package(
        {"agent.py": (
            "def execute(payload, context):\n"
            f"    context.memory_search('', {limit!r})\n"
            "    return {'deliverables': {}}\n")},
        {"entries": {"execute": "agent.py:execute"}})
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    episode = tasks.create("invalid memory limit", package=pkg)
    result = tasks.run(episode["id"])
    assert result["status"] == "failed"
    assert "limit between 0 and 100" in result["last_error"]
