"""Host contract tests; no providers, solvers, or formal experiments."""

import json
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy

import pytest

from nexgent.kernel.store import BudgetExhausted, Store
from nexgent.tasks.packages import make_package
from nexgent.tasks.store import EpisodeStore, RecoveryRequired, StateConflict


@pytest.fixture
def package():
    return make_package({"agent.py": "def execute(task, ctx):\n    return task\n"},
                        {"entries": {"execute": "agent.py:execute"}})


@pytest.fixture
def store(tmp_path):
    return EpisodeStore(tmp_path)


def task(**changes):
    spec = {"objective": "Deliver an answer", "inputs": {"document": {"facts": [1, 2]}},
            "capabilities": ["ask", "tool", "delegate", "publish", "memory_search", "remember"],
            "budget": {"max_model_calls": 2, "max_completion_tokens": 1000, "max_tool_calls": 2, "max_nodes": 3},
            "context": {"memory_namespace": "study-a", "split": "development"}}
    spec.update(changes)
    return spec


def receipt(identity, status="started", **changes):
    result = {"call_id": identity, "status": status, "reserved_completion_tokens": 500,
              "model": "contract-stub", "role": "worker", "request_digest": identity, "usage": {}}
    result.update(changes)
    return result


def test_task_tables_preserve_research_records(tmp_path, package):
    legacy = Store(tmp_path)
    old = {"id": "study-0123456789abcdef", "budget": {}, "phase": "archived"}
    legacy.save(old)
    legacy.event(old["id"], "historical", {"kept": True})
    before = legacy.events(old["id"])
    new = EpisodeStore(tmp_path)
    episode = new.create(task(), package)
    state = new.get(episode["id"])
    state["status"] = "completed"
    new.save(state)
    assert new.path == legacy.path
    assert legacy.get(old["id"]) == old
    assert legacy.events(old["id"]) == before
    assert legacy.calls(old["id"]) == []


def test_projection_is_optimistic_and_identity_is_frozen(store, package):
    episode = store.create(task(), package)
    updated = deepcopy(episode)
    updated["status"] = "running"
    saved = store.save(updated)
    assert saved["revision"] == 1
    assert updated["revision"] == 0
    with pytest.raises(StateConflict):
        store.save(episode)
    for key, replacement in [("task", {"objective": "changed"}), ("budget", {}), ("package_digest", "forged"),
                             ("capabilities", ["shell"]), ("root_episode_id", "other")]:
        state = store.get(episode["id"])
        state[key] = replacement
        with pytest.raises(PermissionError, match="Immutable"):
            store.save(state)
    state = store.get(episode["id"])
    state["notes"] = "x" * 1_000_001
    with pytest.raises(ValueError, match="1 MB"):
        store.save(state)
    assert store.get(episode["id"])["revision"] == 1


def test_child_cannot_widen_access_or_reset_account(store, package):
    parent = store.create(task(), package)
    child = store.create(task(budget={"max_model_calls": 9999}, capabilities=["ask"]), package, parent["id"])
    assert child["root_episode_id"] == parent["id"]
    assert child["budget"] == parent["budget"]
    with pytest.raises(PermissionError, match="capabilities"):
        store.create(task(capabilities=["shell"]), package, parent["id"])
    with pytest.raises(PermissionError, match="memory boundary"):
        store.create(task(context={"split": "train"}), package, parent["id"])
    store.reserve_model(child["id"], receipt("first"))
    store.reserve_model(parent["id"], receipt("second"))
    with pytest.raises(BudgetExhausted):
        store.reserve_model(child["id"], receipt("third"))
    assert store.usage(child["id"])["model_calls"] == 2


def test_model_concurrent_admission_cannot_overspend(store, package):
    parent = store.create(task(), package)
    child = store.create(task(), package, parent["id"])

    def admit(index):
        try:
            store.reserve_model([parent["id"], child["id"]][index % 2], receipt(f"call-{index}"))
            return True
        except BudgetExhausted:
            return False

    with ThreadPoolExecutor(max_workers=8) as workers:
        admitted = list(workers.map(admit, range(24)))
    assert sum(admitted) == 2
    usage = store.usage(parent["id"])
    assert usage["reserved_completion_tokens"] == 1000
    assert usage["completion_tokens"] is None
    assert len(usage["usage_missing_call_ids"]) == 2


def test_unknown_costs_never_refunded_and_legacy_receipt_shape(store, package):
    episode = store.create(task(), package)
    store.reserve_model(episode["id"], receipt("first"))
    store.reserve_model(episode["id"], receipt("first", "failed", reserved_completion_tokens=1,
                                               usage={"prompt_tokens": 7}))
    usage = store.usage(episode["id"])
    assert usage["reserved_completion_tokens"] == 500
    assert usage["completion_tokens"] is None
    assert usage["usage_complete"] is False
    store.reserve_model(episode["id"], receipt("second"))
    with pytest.raises(BudgetExhausted):
        store.reserve_model(episode["id"], receipt("third"))
    with pytest.raises(ValueError, match="earlier state"):
        store.reserve_model(episode["id"], receipt("first"))
    with pytest.raises(ValueError, match="identity"):
        store.reserve_model(episode["id"], receipt("second", model="changed"))
    with pytest.raises(ValueError, match="reserve budget"):
        store.reserve_model(episode["id"], receipt("not-started", "received"))


def test_reported_token_overrun_is_charged_and_cannot_decrease(store, package):
    episode = store.create(task(), package)
    store.reserve_model(episode["id"], receipt("first"))
    complete = receipt("first", "received", usage={"prompt_tokens": 50, "completion_tokens": 700, "total_tokens": 750},
                       billing_status="usage_reported")
    store.reserve_model(episode["id"], complete)
    usage = store.usage(episode["id"])
    assert usage["charged_completion_tokens"] == 700
    assert usage["completion_tokens"] == 700
    assert usage["usage_complete"]
    with pytest.raises(BudgetExhausted):
        store.reserve_model(episode["id"], receipt("second"))
    with pytest.raises(ValueError, match="refunded"):
        store.reserve_model(episode["id"], receipt("first", "received", usage={"completion_tokens": 2}))


@pytest.mark.parametrize("kind,maximum", [("tool", 2), ("node", 3)])
def test_node_and_tool_concurrent_admission_share_root(store, package, kind, maximum):
    root = store.create(task(), package)
    child = store.create(task(), package, root["id"])
    reserve = getattr(store, "reserve_" + kind)

    def admit(index):
        try:
            reserve([root["id"], child["id"]][index % 2], str(index))
            return True
        except BudgetExhausted:
            return False

    with ThreadPoolExecutor(max_workers=8) as workers:
        assert sum(workers.map(admit, range(16))) == maximum
    assert store.usage(root["id"])["tool_calls" if kind == "tool" else "nodes"] == maximum
    assert store.get(root["id"])["revision"] == 0


def test_rpc_unknown_outcome_requires_reconciliation_and_failure_replays(store, package):
    episode = store.create(task(), package)
    request = {"tool": "local", "args": {"port": "input"}}
    original = store.rpc_start(episode["id"], "entry/0/tool", request)
    restarted = EpisodeStore(store.root)
    assert restarted.rpc_find(episode["id"], "entry/0/tool", request) == original
    with pytest.raises(RecoveryRequired):
        restarted.rpc_start(episode["id"], "entry/0/tool", request)
    with pytest.raises(ValueError, match="digest"):
        restarted.rpc_find(episode["id"], "entry/0/tool", {"tool": "changed"})
    terminal = restarted.rpc_finish(episode["id"], "entry/0/tool", error={"type": "ToolFailure", "message": "failed"})
    assert terminal["status"] == "failed"
    assert restarted.rpc_start(episode["id"], "entry/0/tool", request) == terminal
    with pytest.raises(ValueError, match="terminal"):
        restarted.rpc_finish(episode["id"], "entry/0/tool", result={"success": True})
    assert store.get(episode["id"])["revision"] == 0


def test_rpc_concurrent_start_admits_only_one(store, package):
    episode = store.create(task(), package)

    def begin(_):
        try:
            store.rpc_start(episode["id"], "same-path", {"work": 1})
            return True
        except RecoveryRequired:
            return False

    with ThreadPoolExecutor(max_workers=8) as workers:
        assert sum(workers.map(begin, range(16))) == 1
    finished = store.rpc_finish(episode["id"], "same-path", result={"work": "done"})
    assert store.rpc_start(episode["id"], "same-path", {"work": 1}) == finished


def test_artifact_provenance_type_scope_and_integrity(store, package):
    root = store.create(task(), package)
    child = store.create(task(), package, root["id"])
    outsider = store.create(task(), package)
    artifact = store.publish(root["id"], {"facts": [1, 2]}, "evidence.v1", node_id="collect", attempt_id="collect/0",
                             scope="tree", validation={"schema_status": "passed", "checker_ref": "contract-checker"})
    assert artifact["validation"] == {"schema_status": "passed", "checker_ref": "contract-checker"}
    assert store.read(artifact["id"], child["id"], "evidence.v1")["content"] == {"facts": [1, 2]}
    assert artifact["producer"] == {"episode_id": root["id"], "node_id": "collect", "attempt_id": "collect/0", "package_digest": package["digest"]}
    output = store.publish(child["id"], "answer", "text.v1", input_refs=[artifact["id"]], scope="tree")
    assert store.read(output, root["id"])["input_artifact_refs"] == [artifact["id"]]
    with pytest.raises(PermissionError, match="tree"):
        store.read(artifact, outsider["id"])
    private = store.publish(root["id"], "private")
    with pytest.raises(PermissionError, match="different Episode"):
        store.read(private, child["id"])
    with pytest.raises(ValueError, match="type"):
        store.read(artifact, root["id"], "wrong.type")
    with pytest.raises(PermissionError, match="package"):
        store.publish(root["id"], "forged", package_digest="different")
    with pytest.raises(PermissionError):
        store.publish(outsider["id"], "forged dependency", input_refs=[artifact["id"]])
    assert len(store.artifacts(root["id"])) == 2
    with store.connect() as db:
        tampered = deepcopy(artifact)
        tampered["content"] = {"facts": [999]}
        db.execute("UPDATE task_artifacts SET data=? WHERE id=?", (json.dumps(tampered), artifact["id"]))
    with pytest.raises(ValueError, match="integrity"):
        store.read(artifact, root["id"])


def test_public_artifact_still_preserves_namespace_and_split(store, package):
    episode = store.create(task(), package)
    public = store.publish(episode["id"], b"binary-evidence", media_type="application/octet-stream", scope="public")
    other = store.create(task(context={"memory_namespace": "study-b", "split": "development"}), package)
    holdout = store.create(task(context={"memory_namespace": "study-a", "split": "final_holdout"}), package)
    assert store.read(public, episode["id"])["content"] == b"binary-evidence"
    for target in (other, holdout):
        with pytest.raises(PermissionError, match="information boundary"):
            store.read(public, target["id"])


def test_memory_namespace_split_and_holdout_cannot_be_overridden(store, package):
    first = store.create(task(), package)
    same = store.create(task(), package)
    other = store.create(task(context={"memory_namespace": "other", "split": "development"}), package)
    holdout = store.create(task(context={"memory_namespace": "study-a", "split": "final_holdout"}), package)
    item = store.remember(first["id"], {"lesson": "Check input binding before retry"})
    assert item["status"] == "candidate"
    assert store.search(same["id"], "input") == [item]
    assert store.search(other["id"]) == []
    assert store.search(holdout["id"]) == []
    with pytest.raises(PermissionError, match="namespace"):
        store.search(other["id"], namespace="study-a")
    with pytest.raises(PermissionError, match="split"):
        store.search(holdout["id"], split="development")
    with pytest.raises(PermissionError, match="holdout"):
        store.remember(holdout["id"], "leak")
    with pytest.raises(PermissionError):
        store.remember(holdout["id"], "leak", split="development")
    with pytest.raises(PermissionError, match="candidate"):
        store.remember(first["id"], "self-certified", status="accepted")


def test_snapshot_records_actual_retrieval_and_rejects_unread_items(store, package):
    episode = store.create(task(), package)
    item = store.remember(episode["id"], "input binding")
    with pytest.raises(PermissionError, match="actually retrieved"):
        store.snapshot(episode["id"], [item])
    snapshot = store.snapshot(episode["id"], query="binding")
    assert snapshot["item_version_refs"] == [{"id": item["id"], "version": 1}]
    assert snapshot["items"] == [item]
    traces = store.retrievals(episode["id"])
    assert traces[-1]["query"] == "binding"
    assert snapshot["retrieval_refs"] == [traces[-1]["id"]]
    assert store.memory_snapshot(snapshot["id"], episode["id"]) == snapshot
    other = store.create(task(), package)
    with pytest.raises(PermissionError, match="different Episode"):
        store.memory_snapshot(snapshot["id"], other["id"])
    forged = deepcopy(item)
    forged["content"] = "replacement text"
    with pytest.raises(ValueError, match="immutable stored version"):
        store.snapshot(episode["id"], [forged])
    with store.connect() as db:
        corrupted = deepcopy(snapshot)
        corrupted["items"][0]["content"] = "corrupted"
        db.execute("UPDATE task_snapshots SET data=? WHERE id=?", (json.dumps(corrupted), snapshot["id"]))
    with pytest.raises(ValueError, match="integrity"):
        store.memory_snapshot(snapshot["id"], episode["id"])
    assert store.get(episode["id"])["revision"] == 0


def test_once_is_atomic_durable_and_shared_by_children(store, package):
    root = store.create(task(), package)
    child = store.create(task(), package, root["id"])
    with ThreadPoolExecutor(max_workers=8) as workers:
        assert sum(workers.map(lambda index: store.once([root["id"], child["id"]][index % 2], "workbench.fail_once:join"), range(16))) == 1
    assert not EpisodeStore(store.root).once(child["id"], "workbench.fail_once:join")
    other = store.create(task(), package)
    assert store.once(other["id"], "workbench.fail_once:join")


def test_event_sequence_chain_and_lock_identity(store, package):
    episode = store.create(task(), package)
    with ThreadPoolExecutor(max_workers=8) as workers:
        list(workers.map(lambda index: store.event(episode["id"], "concurrent", {"index": index}), range(16)))
    events = store.events(episode["id"])
    assert [e["sequence"] for e in events] == list(range(1, 18))
    assert all(right["previous"] == left["digest"] for left, right in zip(events, events[1:]))
    with store.lock(episode["id"]):
        with pytest.raises(OSError):
            with store.lock(episode["id"]):
                pass
    with pytest.raises(ValueError, match="identity"):
        with store.lock("../../outside"):
            pass
