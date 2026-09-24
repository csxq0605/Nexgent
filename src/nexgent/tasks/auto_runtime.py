"""Project-owned composition for the ordinary task -> RSI lifecycle.

The core never chooses a benchmark or an improver for a user's task.  A
project config binds an ordinary package channel to an independent evaluator
and a versioned improver once; Main and CLI then run the same coordinator.
"""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path

from .feedback_trigger import AutoEvolutionService, _policy
from .evolution import EvolutionService
from .improver_seed import default_improver_package
from .improvers import ImproverService, active_improver_registration
from .tools import ContractError


CONFIG_FILE = "nexgent.auto-evolution.json"
CONFIG_SCHEMA = "nexgent.auto-evolution-config.v1"


def load_auto_evolution_config(project_root):
    """Read a bounded, public host policy; never read credentials from here."""
    path = Path(project_root).resolve() / CONFIG_FILE
    if not path.is_file():
        return None
    if path.stat().st_size > 65_536:
        raise ContractError("Auto-evolution config exceeds 65536 bytes")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ContractError("Auto-evolution config is not valid UTF-8 JSON") from exc
    required = {"schema", "channels", "improver_channel",
                "bootstrap_default_improver"}
    if (not isinstance(value, dict)
            or not required <= set(value)
            or set(value) - required - {"default_channel"}
            or value["schema"] != CONFIG_SCHEMA
            or type(value["bootstrap_default_improver"]) is not bool):
        raise ContractError("Auto-evolution config has an invalid schema")
    channel = value["improver_channel"]
    if not isinstance(channel, str) or not channel or len(channel) > 100:
        raise ContractError("Auto-evolution improver channel is invalid")
    policies = value["channels"]
    if (not isinstance(policies, dict) or not policies or len(policies) > 32
            or any(not isinstance(name, str) or not name or len(name) > 200
                   for name in policies)):
        raise ContractError("Auto-evolution channels are invalid")
    normalized = {
        name: {key: item for key, item in _policy(policy).items() if key != "schema"}
        for name, policy in policies.items()
    }
    for policy in normalized.values():
        declared = policy.get("improver")
        if declared is not None and declared["channel"] != channel:
            raise ContractError("Auto-evolution improver channel mismatch")
    default_channel = value.get("default_channel")
    if default_channel is not None and default_channel not in normalized:
        raise ContractError("Auto-evolution default channel is not configured")
    if default_channel is None and len(normalized) == 1:
        default_channel = next(iter(normalized))
    return {"improver_channel": channel,
            "bootstrap_default_improver": value["bootstrap_default_improver"],
            "channels": normalized, "default_channel": default_channel}


def configure_auto_evolution(task_service, *, project_root=None):
    """Attach durable terminal observation and return its background driver.

    Missing config leaves ordinary task execution unchanged.  A configured
    evaluator remains host-owned and may later report unavailable; the agent
    never receives private benchmark tasks or answers while proposing patches.
    """
    root = project_root if project_root is not None else task_service.project_root
    if (hasattr(task_service, "project_root")
            and Path(root).resolve() != Path(task_service.project_root).resolve()):
        raise ContractError("Auto-evolution policy must belong to the TaskService project")
    config = load_auto_evolution_config(root)
    if config is None:
        return None
    registry = task_service._benchmark_registry()
    for policy in config["channels"].values():
        registry.get(policy["evaluator_id"])
    evolution = EvolutionService(task_service)
    from .self_orchestration_seed import self_orchestration_package
    for task_channel in config["channels"]:
        try:
            evolution.active(task_channel)
        except KeyError:
            evolution.register(task_channel, self_orchestration_package())
    improvers = ImproverService(task_service)
    channel = config["improver_channel"]
    try:
        registration = active_improver_registration(task_service.store, channel)
    except KeyError:
        if not config["bootstrap_default_improver"]:
            raise ContractError("Configured improver channel is not registered") from None
        package = default_improver_package()
        improvers.register(
            channel, package,
            {"mutable_paths": ["improver.py"], "allowed_operations": ["replace"]},
        )
        registration = active_improver_registration(task_service.store, channel)
    policies = deepcopy(config["channels"])
    identity = {key: registration[key] for key in (
        "channel", "revision", "package_id", "package_digest")}
    for name, policy in policies.items():
        declared = policy.get("improver")
        if declared is not None and any(
                declared[key] != identity[key] for key in declared):
            raise ContractError(f"Auto-evolution improver revision mismatch: {name}")
        policy["improver"] = deepcopy(identity)
    trigger = AutoEvolutionService(task_service, policies=policies)
    trigger.default_channel = config["default_channel"]
    return trigger


def single_auto_channel(trigger):
    """Return the project's explicit or unambiguous ordinary default."""
    if trigger is None:
        return None
    return trigger.default_channel


def advance_auto_evolution(trigger, *, source_episode_id=None, rounds=16,
                           limit=4, stop_event=None):
    """Drive one configured ordinary-task queue to a bounded fixed point.

    Each coordinator transition is durable.  Restarting this function resumes
    unfinished work rather than asking the model to repeat a completed step.
    """
    if trigger is None:
        return {"configured": False, "rounds": 0, "work": []}
    if (type(rounds) is not int or not 1 <= rounds <= 64
            or type(limit) is not int or not 1 <= limit <= 32):
        raise ValueError("Auto-evolution bounds are invalid")
    active = [
        "observed", "feedback_capture_started", "feedback_captured",
        "development_planned", "development_run", "candidate_generation_started",
        "candidate_ready", "selection_plan_started", "selection_planned",
        "selection_run", "paired_assessed", "guard_plan_started",
        "guard_planned", "promoted", "guard_run", "guard_assessed",
    ]
    focused = set()
    if source_episode_id is not None:
        source = trigger.observe_terminal(source_episode_id)
        if source is not None:
            focused.add(source["id"])
    # The terminal hook is best-effort. A bounded restart scan discovers a
    # terminal Episode whose hook was interrupted before it wrote the outbox.
    cursor = None
    while True:
        if stop_event is not None and stop_event.is_set():
            break
        scanned = trigger.scan(after_id=cursor, limit=256, drain=False)
        focused.update(row["id"] for row in scanned["observed"]
                       if source_episode_id is None
                       or row["source_episode_id"] == source_episode_id)
        cursor = scanned["next_cursor"]
        if cursor is None:
            break
    count = 0
    for _ in range(rounds):
        if stop_event is not None and stop_event.is_set():
            break
        pending = trigger.store.feedback_triggers(statuses=active, limit=limit)
        if not pending:
            break
        before = [(row["id"], row["revision"]) for row in pending]
        progressed = trigger.advance(limit=limit, stop_event=stop_event)
        for group in progressed.values():
            focused.update(row["id"] for row in group
                           if source_episode_id is None
                           or row["source_episode_id"] == source_episode_id)
        count += 1
        after = [trigger.store.feedback_trigger(identity) for identity, _ in before]
        if before == [(row["id"], row["revision"]) for row in after]:
            break
    rows = [trigger.store.feedback_trigger(identity) for identity in sorted(focused)]
    active_channels = {}
    for row in rows:
        channel = row["channel_id"]
        if channel is not None and channel not in active_channels:
            active_channels[channel] = EvolutionService(trigger.tasks).active(channel)[
                "revision"]
    return {
        "configured": True,
        "rounds": count,
        "work": [
            {"id": row["id"], "channel": row["channel_id"],
             "status": row["status"], "reason": row.get("reason")}
            for row in rows
        ],
        "active_revisions": active_channels,
        "source_pending": (any(row["status"] in active for row in rows)
                           if source_episode_id is not None else None),
        "global_pending": bool(trigger.store.feedback_triggers(
            statuses=active, limit=1)),
    }
