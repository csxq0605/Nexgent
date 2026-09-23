"""Integration contracts for Episode-authorized task-time tool development."""

from copy import deepcopy
import json
import threading

import pytest

from nexgent.kernel.store import BudgetExhausted
from nexgent.tasks.capability_authority import make_episode_authority
from nexgent.tasks.capability_definitions import (
    DefinitionError,
    build_tool_definition,
)
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.store import StateConflict


def _authority(*, max_definitions=4, max_invocations=8):
    return make_episode_authority(
        ["tool"],
        ["local_compute"],
        max_definitions=max_definitions,
        max_invocations=max_invocations,
    )


def _proposal(name="episode.square", *, multiplier=2):
    return {
        "name": name,
        "description": "Multiply an integer using a task-authored pure tool.",
        "source": (
            "def execute(payload, context):\n"
            f"    return {{'value': payload['value'] * {multiplier}}}\n"
        ),
        "input_schema": {
            "type": "object",
            "properties": {"value": {"type": "integer"}},
            "required": ["value"],
            "additionalProperties": False,
        },
        "output_schema": {
            "type": "object",
            "properties": {"value": {"type": "integer"}},
            "required": ["value"],
            "additionalProperties": False,
        },
    }


def _passive_package():
    return make_package(
        {"agent/main.py": "def execute(payload, context):\n    return {}\n"},
        {"entries": {"execute": "agent/main.py:execute"}},
    )


def _develop_and_use_package():
    source = """def execute(payload, context):
    before = context.capability_inventory()
    developed = context.develop_tool({
        'name': 'episode.square',
        'description': 'Square one integer in a task-created tool.',
        'source': "def execute(payload, context):\\n    return {'value': payload['value'] * payload['value']}\\n",
        'input_schema': {
            'type': 'object',
            'properties': {'value': {'type': 'integer'}},
            'required': ['value'],
            'additionalProperties': False,
        },
        'output_schema': {
            'type': 'object',
            'properties': {'value': {'type': 'integer'}},
            'required': ['value'],
            'additionalProperties': False,
        },
    })
    after = context.capability_inventory()
    value = context.tool('episode.square', {'value': 7})
    artifact = context.publish({
        'before': before,
        'developed': developed,
        'after': after,
        'value': value,
    }, name='result')
    return {'deliverables': {'result': artifact['id']}}
"""
    return make_package(
        {"agent/main.py": source},
        {"entries": {"execute": "agent/main.py:execute"}},
    )


def _invoke(service, episode_id, package, method, params, path):
    return service._invoke(
        episode_id,
        package,
        method,
        params,
        path,
        threading.Event(),
        lambda: None,
    )


def test_task_develops_fresh_name_reinventories_calls_and_releases(tmp_path):
    package = _develop_and_use_package()
    service = TaskService(tmp_path)
    episode = service.create(
        "Develop and use a missing task-specific capability",
        package=package,
        capabilities=[],
        capability_authority=_authority(),
        deliverables=[{"name": "result", "schema": {"type": "object"}}],
    )

    completed = service.run(episode["id"])

    assert completed["status"] == "completed", completed.get("last_error")
    artifact = service.store.read(completed["output_refs"]["result"], episode["id"])
    content = artifact["content"]
    assert content["before"] == {"tools": []}
    assert content["value"] == {"value": 49}
    assert content["developed"]["name"] == "episode.square"
    assert [item["name"] for item in content["after"]["tools"]] == [
        "episode.square"
    ]

    instance = service.store.tool_instance(episode["id"], "episode.square")
    assert instance["status"] == "active"
    assert instance["definition_id"] == content["developed"]["definition_id"]
    receipts = [
        event["content"]
        for event in service.store.events(episode["id"])
        if event["kind"] == "tool"
    ]
    assert receipts[-1]["dynamic_capability"] == {
        "name": "episode.square",
        "definition_id": instance["definition_id"],
        "definition_digest": instance["definition_digest"],
        "instance_revision": instance["revision"],
        "authority_digest": instance["authority_digest"],
    }
    assert receipts[-1]["execution"]["rpc_count"] == 0

    released = service.store.release_tool_instance(
        episode["id"], "episode.square", expected_revision=instance["revision"]
    )
    assert released["status"] == "released"
    assert _invoke(
        service, episode["id"], package, "capability_inventory", {}, "after-release"
    ) == {"tools": []}
    with pytest.raises(PermissionError, match="not active"):
        _invoke(
            service,
            episode["id"],
            package,
            "tool",
            {"name": "episode.square", "arguments": {"value": 3}},
            "released-call",
        )


def test_dynamic_tool_is_durable_after_restart_but_episode_local(tmp_path):
    package = _passive_package()
    service = TaskService(tmp_path)
    owner = service.create(
        "Own a task-authored tool",
        package=package,
        capabilities=[],
        capability_authority=_authority(),
    )
    sibling = service.create(
        "Remain isolated from another Episode's task-authored tool",
        package=package,
        capabilities=[],
        capability_authority=_authority(),
    )
    definition, bundle = build_tool_definition(_proposal(), owner["id"])
    service.store.stage_tool_definition(owner["id"], definition, bundle)
    mounted = service.store.mount_tool_definition(owner["id"], definition["id"])

    restarted = TaskService(tmp_path)
    assert restarted.store.tool_instance(owner["id"], definition["name"]) == mounted
    assert [
        item["name"]
        for item in _invoke(
            restarted, owner["id"], package, "capability_inventory", {}, "inventory"
        )["tools"]
    ] == [definition["name"]]
    assert _invoke(
        restarted,
        owner["id"],
        package,
        "tool",
        {"name": definition["name"], "arguments": {"value": 6}},
        "durable-call",
    ) == {"value": 12}

    assert restarted.store.tool_instances(sibling["id"], active_only=True) == []
    assert _invoke(
        restarted, sibling["id"], package, "capability_inventory", {}, "sibling-inventory"
    ) == {"tools": []}
    with pytest.raises(PermissionError, match="creator Episode"):
        restarted.store.mount_tool_definition(sibling["id"], definition["id"])
    with pytest.raises(PermissionError, match="not granted"):
        _invoke(
            restarted,
            sibling["id"],
            package,
            "tool",
            {"name": definition["name"], "arguments": {"value": 6}},
            "sibling-call",
        )


def test_identical_tool_source_has_distinct_origin_bound_packages(tmp_path):
    service = TaskService(tmp_path)
    package = _passive_package()
    first = service.create("First tool creator", package=package,
                           capabilities=[], capability_authority=_authority())
    second = service.create("Second tool creator", package=package,
                            capabilities=[], capability_authority=_authority())
    first_definition, first_bundle = build_tool_definition(
        _proposal(), first["id"])
    second_definition, second_bundle = build_tool_definition(
        _proposal(), second["id"])
    assert first_bundle["id"] != second_bundle["id"]
    service.store.stage_tool_definition(first["id"], first_definition, first_bundle)
    service.store.stage_tool_definition(second["id"], second_definition, second_bundle)
    service.store.mount_tool_definition(first["id"], first_definition["id"])
    service.store.mount_tool_definition(second["id"], second_definition["id"])
    assert service.store.tool_definition(first_definition["id"])["origin_episode_id"] == first["id"]
    assert service.store.tool_definition(second_definition["id"])["origin_episode_id"] == second["id"]


def test_definition_and_invocation_budgets_are_independent_and_durable(tmp_path):
    package = _passive_package()
    service = TaskService(tmp_path)
    episode = service.create(
        "Bound task-time development and use",
        package=package,
        capabilities=[],
        capability_authority=_authority(max_definitions=1, max_invocations=1),
    )
    first, first_bundle = build_tool_definition(_proposal("episode.double"), episode["id"])
    second, second_bundle = build_tool_definition(
        _proposal("episode.triple", multiplier=3), episode["id"]
    )
    service.store.stage_tool_definition(episode["id"], first, first_bundle)
    service.store.mount_tool_definition(episode["id"], first["id"])

    with pytest.raises(BudgetExhausted, match="definition"):
        service.store.stage_tool_definition(episode["id"], second, second_bundle)

    assert _invoke(
        service,
        episode["id"],
        package,
        "tool",
        {"name": first["name"], "arguments": {"value": 5}},
        "call-1",
    ) == {"value": 10}
    with pytest.raises(BudgetExhausted, match="invocation"):
        _invoke(
            service,
            episode["id"],
            package,
            "tool",
            {"name": first["name"], "arguments": {"value": 8}},
            "call-2",
        )

    restarted = TaskService(tmp_path)
    with pytest.raises(BudgetExhausted, match="invocation"):
        _invoke(
            restarted,
            episode["id"],
            package,
            "tool",
            {"name": first["name"], "arguments": {"value": 9}},
            "call-after-restart",
        )


def test_forged_definition_and_instance_identity_fail_before_execution(tmp_path):
    package = _passive_package()
    service = TaskService(tmp_path)
    episode = service.create(
        "Reject forged task-time capabilities",
        package=package,
        capabilities=[],
        capability_authority=_authority(),
    )
    definition, bundle = build_tool_definition(_proposal(), episode["id"])

    forged_definition = deepcopy(definition)
    forged_definition["package_digest"] = "0" * 64
    with pytest.raises(DefinitionError):
        service.store.stage_tool_definition(episode["id"], forged_definition, bundle)
    assert service.store.tool_instances(episode["id"]) == []

    service.store.stage_tool_definition(episode["id"], definition, bundle)
    mounted = service.store.mount_tool_definition(episode["id"], definition["id"])
    forged_instance = deepcopy(mounted)
    forged_instance["authority_digest"] = "0" * 64
    with service.store.connect() as db:
        db.execute(
            "UPDATE task_capability_instances SET data=? WHERE episode=? AND name=?",
            (
                json.dumps(forged_instance, sort_keys=True, separators=(",", ":")),
                episode["id"],
                definition["name"],
            ),
        )

    with pytest.raises(ValueError, match="CapabilityInstance"):
        _invoke(
            service,
            episode["id"],
            package,
            "tool",
            {"name": definition["name"], "arguments": {"value": 2}},
            "forged-call",
        )
    assert service.store.usage(episode["id"])["tool_calls"] == 0


def test_mount_idempotence_still_checks_stale_revision(tmp_path):
    service = TaskService(tmp_path)
    episode = service.create("Check mount revisions", package=_passive_package(),
                             capabilities=[], capability_authority=_authority())
    definition, bundle = build_tool_definition(_proposal(), episode["id"])
    service.store.stage_tool_definition(episode["id"], definition, bundle)
    first = service.store.mount_tool_definition(
        episode["id"], definition["id"], expected_revision=0)
    with pytest.raises(StateConflict, match="revision"):
        service.store.mount_tool_definition(
            episode["id"], definition["id"], expected_revision=0)
    released = service.store.release_tool_instance(
        episode["id"], definition["name"], expected_revision=first["revision"])
    remounted = service.store.mount_tool_definition(
        episode["id"], definition["id"], expected_revision=released["revision"])
    assert remounted["revision"] > first["revision"]
    with pytest.raises(StateConflict, match="revision"):
        service.store.mount_tool_definition(
            episode["id"], definition["id"], expected_revision=first["revision"])


def test_definition_row_columns_and_host_schema_are_checked(tmp_path):
    service = TaskService(tmp_path)
    episode = service.create("Check definition identity", package=_passive_package(),
                             capabilities=[], capability_authority=_authority())
    unsafe = _proposal()
    unsafe["input_schema"]["properties"]["value"] = {
        "type": "string", "pattern": "^(a+)+$"}
    with pytest.raises(DefinitionError, match="unsupported"):
        build_tool_definition(unsafe, episode["id"])
    definition, bundle = build_tool_definition(_proposal(), episode["id"])
    service.store.stage_tool_definition(episode["id"], definition, bundle)
    with service.store.connect() as db:
        db.execute("UPDATE task_capability_definitions SET origin_episode=? WHERE id=?",
                   ("episode-forged", definition["id"]))
    with pytest.raises(ValueError, match="table identity"):
        service.store.tool_definition(definition["id"])


def test_instance_lifecycle_event_digest_is_a_checked_anchor(tmp_path):
    service = TaskService(tmp_path)
    episode = service.create("Check instance event chain", package=_passive_package(),
                             capabilities=[], capability_authority=_authority())
    definition, bundle = build_tool_definition(_proposal(), episode["id"])
    service.store.stage_tool_definition(episode["id"], definition, bundle)
    service.store.mount_tool_definition(episode["id"], definition["id"])
    with service.store.connect() as db:
        row = db.execute(
            "SELECT sequence,data FROM task_events WHERE episode=? "
            "AND kind='capability_instance_mounted' ORDER BY sequence DESC LIMIT 1",
            (episode["id"],)).fetchone()
        event = json.loads(row[1])
        event["revision"] += 1
        db.execute("UPDATE task_events SET data=? WHERE episode=? AND sequence=?",
                   (json.dumps(event), episode["id"], row[0]))
    with pytest.raises(ValueError, match="event chain"):
        service.store.tool_instance(episode["id"], definition["name"])
