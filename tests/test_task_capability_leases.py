"""Focused durable capability lease contracts for the task runtime."""

from dataclasses import replace

import pytest

from nexgent.tasks.packages import make_package
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
    child = _episode(store, package, parent=first["id"])
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
