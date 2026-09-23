"""Focused durable capability lease contracts for the task runtime."""

from dataclasses import replace
import threading

import pytest

from nexgent.kernel.store import BudgetExhausted
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.store import EpisodeStore, StateConflict
from nexgent.tasks.tools import ContractError, ToolRegistry, ToolSpec


def _tool(*, digest="a" * 64):
    return ToolSpec(
        "probe.multiply", {"type": "object"}, {"type": "object"},
        "local_compute", lambda arguments, context: arguments,
        provider_id="test.provider", provider_version="1", handler_digest=digest,
    )


def _episode(store, package, *, capabilities=None, parent=None):
    return store.create(
        {"objective": "Test an Episode scoped tool", "inputs": {},
         "capabilities": ["probe.multiply"] if capabilities is None else capabilities,
         "capability_mode": "leased", "budget": {}, "context": {}},
        package, parent_episode_id=parent,
    )


def _runtime_package(source=None):
    source = source or """def execute(payload, context):
    value = context.tool('probe.multiply', {'value': 3})
    artifact = context.publish(value, name='result')
    return {'deliverables': {'result': artifact['id']}}
"""
    return make_package(
        {"agent/main.py": source},
        {"entries": {"execute": "agent/main.py:execute"}},
    )


def _runtime_tool(calls, *, digest="a" * 64):
    def handler(arguments, context):
        calls.append((context.episode_id, arguments))
        return {"value": arguments.get("value", 0) * 2}

    return replace(_tool(digest=digest), handler=handler)


def test_lease_is_durable_local_and_does_not_rebind(tmp_path):
    store = EpisodeStore(tmp_path)
    package = make_package(
        {"agent/main.py": "def execute(payload, context):\n    return {}\n"},
        {"entries": {"execute": "agent/main.py:execute"}},
    )
    registry = ToolRegistry([_tool()])
    descriptor = registry.lease_descriptor("probe.multiply")
    first = _episode(store, package)
    sibling = _episode(store, package)
    child = _episode(store, package, capabilities=[], parent=first["id"])
    lease = store.mount_capability(first["id"], descriptor)
    assert lease["revision"] == 1
    assert registry.resolve_lease(lease).name == "probe.multiply"
    assert store.mount_capability(first["id"], descriptor) == lease
    assert store.capability_leases(sibling["id"], active_only=True) == []
    assert store.capability_leases(child["id"], active_only=True) == []
    assert EpisodeStore(tmp_path).capability_lease(first["id"], "probe.multiply") == lease
    with pytest.raises(PermissionError, match="rebind"):
        store.mount_capability(first["id"], ToolRegistry([_tool(digest="b" * 64)]).lease_descriptor(
            "probe.multiply"))
    with pytest.raises(ContractError, match="differs"):
        ToolRegistry([_tool(digest="b" * 64)]).resolve_lease(lease)
    released = store.release_capability(
        first["id"], "probe.multiply", expected_revision=lease["revision"])
    assert released["revision"] == 2
    assert store.capability_leases(first["id"], active_only=True) == []
    with pytest.raises(StateConflict, match="revision"):
        store.mount_capability(first["id"], descriptor, expected_revision=1)
    remounted = store.mount_capability(first["id"], descriptor, expected_revision=2)
    assert remounted["revision"] == 3
    assert [event["kind"] for event in store.events(first["id"])
            if event["kind"].startswith("capability_")] == [
                "capability_mounted", "capability_released", "capability_mounted"]


def test_lease_cannot_widen_frozen_ceiling_or_use_unversioned_handler(tmp_path):
    store = EpisodeStore(tmp_path)
    package = make_package(
        {"agent/main.py": "def execute(payload, context):\n    return {}\n"},
        {"entries": {"execute": "agent/main.py:execute"}},
    )
    episode = _episode(store, package, capabilities=[])
    descriptor = ToolRegistry([_tool()]).lease_descriptor("probe.multiply")
    with pytest.raises(PermissionError, match="ceiling"):
        store.mount_capability(episode["id"], descriptor)
    with pytest.raises(ContractError, match="provider"):
        ToolRegistry([replace(_tool(), provider_id="")]).lease_descriptor("probe.multiply")


def test_initial_lease_failure_rolls_back_episode_registration(tmp_path, monkeypatch):
    store = EpisodeStore(tmp_path)
    package = _runtime_package()
    descriptor = ToolRegistry([_tool()]).lease_descriptor("probe.multiply")
    original_event = EpisodeStore._event

    def fail_during_grant(db, episode_id, kind, data):
        if kind == "capability_mounted":
            raise RuntimeError("interrupted while registering the initial grant")
        return original_event(db, episode_id, kind, data)

    monkeypatch.setattr(EpisodeStore, "_event", staticmethod(fail_during_grant))
    with pytest.raises(RuntimeError, match="interrupted"):
        store.create(
            {"objective": "Atomically register an initial grant", "inputs": {},
             "capabilities": ["probe.multiply"], "capability_mode": "leased",
             "budget": {}, "context": {}}, package,
            initial_capability_descriptors=[descriptor],
        )
    assert store.list() == []
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM task_capability_leases").fetchone()[0] == 0


def test_leased_parent_cannot_delegate_inactive_or_legacy_tool_grants(tmp_path):
    service = TaskService(tmp_path, tools=ToolRegistry([_runtime_tool([])]))
    package = _runtime_package()
    parent = service.create(
        "Parent with a dormant tool", package=package,
        capabilities=["probe.multiply"], initially_active_capabilities=[],
    )
    with pytest.raises(PermissionError, match="active leases"):
        service.create(
            "Child cannot reactivate parent's dormant tool", package=package,
            capabilities=["probe.multiply"], parent_episode_id=parent["id"],
        )
    with pytest.raises(PermissionError, match="legacy tool grants"):
        service.store.create(
            {"objective": "Bypass via direct store", "inputs": {},
             "capabilities": ["probe.multiply"], "budget": {}, "context": {}},
            package, parent_episode_id=parent["id"],
        )
    lease = service.mount_capability(parent["id"], "probe.multiply")
    child = service.create(
        "Child receives an active subset", package=package,
        capabilities=["probe.multiply"], parent_episode_id=parent["id"],
    )
    assert child["task"]["capability_mode"] == "leased"
    assert service.active_capabilities(child["id"])[0]["descriptor"] == lease["descriptor"]
    dormant = service.create(
        "Child stores the inherited handler bound", package=package,
        capabilities=["probe.multiply"], initially_active_capabilities=[],
        parent_episode_id=parent["id"],
    )
    changed = TaskService(
        tmp_path, tools=ToolRegistry([_runtime_tool([], digest="b" * 64)]))
    with pytest.raises(PermissionError, match="Delegated handler"):
        changed.create(
            "Child cannot inherit a changed handler", package=package,
            capabilities=["probe.multiply"], parent_episode_id=parent["id"],
        )
    with pytest.raises(PermissionError, match="Delegated handler"):
        changed.mount_capability(dormant["id"], "probe.multiply")
    # Simulate a leased child persisted by the earlier schema, before bounds
    # were recorded. Upgrade must close this grant rather than reinterpret it.
    with service.store.connect() as db:
        db.execute("DELETE FROM task_delegated_capability_bounds WHERE episode=?",
                   (dormant["id"],))
    with pytest.raises(PermissionError, match="no frozen parent bound"):
        service.mount_capability(dormant["id"], "probe.multiply")


def test_mount_preflights_effect_and_remaining_tool_budget(tmp_path):
    service = TaskService(tmp_path, tools=ToolRegistry([_runtime_tool([])]))
    package = _runtime_package()
    restricted = service.create(
        "No local compute authority", package=package,
        capabilities=["probe.multiply"], initially_active_capabilities=[],
        constraints={"allowed_effects": ["read"]},
    )
    with pytest.raises(PermissionError, match="effect"):
        service.mount_capability(restricted["id"], "probe.multiply")
    exhausted = service.create(
        "No tool budget", package=package,
        capabilities=["probe.multiply"], initially_active_capabilities=[],
        budget={"max_tool_calls": 0},
    )
    with pytest.raises(BudgetExhausted, match="budget"):
        service.mount_capability(exhausted["id"], "probe.multiply")
    with pytest.raises(PermissionError, match="effect"):
        service.create(
            "Initial grant checks authority atomically", package=package,
            capabilities=["probe.multiply"],
            initially_active_capabilities=["probe.multiply"],
            constraints={"allowed_effects": ["read"]},
        )


def test_task_service_denies_inactive_lease_before_reservation_then_mounts_locally(tmp_path):
    calls = []
    registry = ToolRegistry([_runtime_tool(calls)])
    service = TaskService(tmp_path, tools=registry)
    package = _runtime_package()
    first = service.create(
        "Lease a preinstalled tool", package=package,
        deliverables=[{"name": "result", "schema": {"type": "object"}}],
        capabilities=["probe.multiply"], initially_active_capabilities=[],
    )
    sibling = service.create(
        "Keep sibling grants isolated", package=package,
        capabilities=["probe.multiply"], initially_active_capabilities=[],
    )

    assert first["task"]["capability_mode"] == "leased"
    assert first["task"]["tools"] == []
    with pytest.raises(PermissionError, match="not active"):
        service._invoke(
            first["id"], package, "tool",
            {"name": "probe.multiply", "arguments": {"value": 2}},
            "inactive", threading.Event(), lambda: None,
        )
    assert calls == []
    assert service.store.usage(first["id"])["tool_calls"] == 0

    lease = service.mount_capability(first["id"], "probe.multiply")
    assert lease["revision"] == 1
    assert service.active_capabilities(first["id"]) == [lease]
    assert service.active_capabilities(sibling["id"]) == []
    with pytest.raises(PermissionError, match="not active"):
        service._invoke(
            sibling["id"], package, "tool",
            {"name": "probe.multiply", "arguments": {"value": 2}},
            "sibling", threading.Event(), lambda: None,
        )

    completed = service.run(first["id"])
    assert completed["status"] == "completed", completed.get("last_error")
    receipt = [event["content"] for event in service.get_private(first["id"])["events"]
               if event["kind"] == "tool"][-1]
    assert receipt["capability_descriptor"] == lease["descriptor"]
    assert receipt["capability_lease_revision"] == lease["revision"]
    admission = [event["content"]["data"]
                 for event in service.store.events(first["id"])
                 if event["kind"] == "tool_admitted"][-1]
    assert admission["capability_lease_revision"] == lease["revision"]
    assert admission["capability_descriptor_digest"] == lease["descriptor"]["digest"]
    assert admission["handler_digest"] == lease["descriptor"]["handler_digest"]
    released = service.release_capability(
        first["id"], "probe.multiply", expected_revision=lease["revision"])
    assert released["status"] == "released"
    assert service.active_capabilities(first["id"]) == []


def test_run_payload_lists_only_active_leased_tools_and_legacy_mode_is_unchanged(tmp_path):
    calls = []
    tool = _runtime_tool(calls)
    registry = ToolRegistry([tool])
    package = _runtime_package("""def execute(payload, context):
    artifact = context.publish({'tools': [item['name'] for item in payload['tools']]}, name='result')
    return {'deliverables': {'result': artifact['id']}}
""")
    service = TaskService(tmp_path, tools=registry)
    leased = service.create(
        "Expose only live leases", package=package,
        deliverables=[{"name": "result", "schema": {"type": "object"}}],
        capabilities=[tool.name], initially_active_capabilities=[],
    )
    result = service.run(leased["id"])
    artifact = service.store.read(result["output_refs"]["result"], leased["id"])
    assert artifact["content"] == {"tools": []}

    active = service.create(
        "Expose the live lease", package=package,
        deliverables=[{"name": "result", "schema": {"type": "object"}}],
        capabilities=[tool.name], initially_active_capabilities=[tool.name],
    )
    active_result = service.run(active["id"])
    active_artifact = service.store.read(
        active_result["output_refs"]["result"], active["id"])
    assert active_artifact["content"] == {"tools": [tool.name]}

    legacy = service.create(
        "Preserve static capabilities", package=_runtime_package(),
        deliverables=[{"name": "result", "schema": {"type": "object"}}],
        capabilities=[tool.name],
    )
    assert "capability_mode" not in legacy["task"]
    assert service.run(legacy["id"])["status"] == "completed"


def test_release_restart_and_provider_drift_fail_closed_but_completed_rpc_replays(tmp_path):
    calls = []
    registry = ToolRegistry([_runtime_tool(calls)])
    service = TaskService(tmp_path, tools=registry)
    package = _runtime_package()
    episode = service.create(
        "Replay a durable completed call", package=package,
        capabilities=["probe.multiply"], initially_active_capabilities=["probe.multiply"],
    )
    params = {"name": "probe.multiply", "arguments": {"value": 4}}
    first = service._dispatch(
        episode["id"], package, "tool", params, "rpc.replay",
        threading.Event(), lambda: None,
    )
    lease = service.active_capabilities(episode["id"])[0]
    service.release_capability(
        episode["id"], "probe.multiply", expected_revision=lease["revision"])

    restarted = TaskService(tmp_path, tools=registry)
    assert restarted._dispatch(
        episode["id"], package, "tool", params, "rpc.replay",
        threading.Event(), lambda: None,
    ) == first
    assert len(calls) == 1
    with pytest.raises(PermissionError, match="not active"):
        restarted._dispatch(
            episode["id"], package, "tool", params, "rpc.after-release",
            threading.Event(), lambda: None,
        )
    assert len(calls) == 1

    drifted = service.create(
        "Reject a changed provider on restart", package=package,
        capabilities=["probe.multiply"], initially_active_capabilities=["probe.multiply"],
    )
    changed = TaskService(
        tmp_path, tools=ToolRegistry([_runtime_tool([], digest="b" * 64)]))
    with pytest.raises(ContractError, match="differs"):
        changed.run(drifted["id"])
    assert changed.store.get(drifted["id"])["status"] == "ready"
