"""Redacted read models for framework memory lifecycle state."""

from __future__ import annotations

from copy import deepcopy


_EVENT_FIELDS = {
    "memory_channel_registered": (
        "memory_id", "memory_digest", "package_id", "package_digest"),
    "memory_promoted": (
        "from_memory_id", "to_memory_id", "from_memory_digest", "to_memory_digest",
        "package_id", "package_digest", "decision_digest", "selection_plan_digest"),
    "memory_rolled_back": (
        "from_memory_id", "to_memory_id", "from_memory_digest", "to_memory_digest",
        "reason_digest"),
}


def public_memory_version(version, decision=None, retirement=None):
    """Expose identity and lineage while withholding entries and host evidence."""
    result = {key: deepcopy(version.get(key)) for key in (
        "schema", "id", "digest", "parent_id", "generation", "status",
        "package_id", "package_digest", "created_at", "record_digest")}
    result["item_count"] = len(
        version.get("resource", {}).get("data", {}).get("items", []))
    if decision is not None:
        result["decision"] = {
            "id": decision.get("id"), "verdict": decision.get("verdict"),
            "digest": decision.get("digest"), "created_at": decision.get("created_at")}
    if retirement is not None:
        result["retirement"] = {
            "id": retirement.get("id"), "digest": retirement.get("digest"),
            "created_at": retirement.get("created_at")}
    return result


def public_memory_event(event):
    kind = event.get("kind")
    content = event.get("content") if isinstance(event.get("content"), dict) else {}
    return {
        "channel": event.get("channel"), "sequence": event.get("sequence"),
        "kind": kind, "created": event.get("created"),
        "content": {key: deepcopy(content.get(key)) for key in _EVENT_FIELDS.get(kind, ())
                    if key in content},
        "previous": event.get("previous"), "digest": event.get("digest"),
    }


def public_memory_channel_view(active, events, *, limit=50):
    if type(limit) is not int or not 1 <= limit <= 1000:
        raise ValueError("Memory event limit must be between 1 and 1000")
    return {
        "active": {key: deepcopy(active.get(key)) for key in (
            "channel", "memory_id", "memory_digest", "package_id",
            "package_digest", "revision", "updated_at")},
        "events": [public_memory_event(event) for event in list(events)[-limit:]],
    }
