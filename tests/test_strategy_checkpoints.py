from copy import deepcopy
import json

import pytest

from nexgent.kernel.programs import digest
from nexgent.tasks.packages import make_package
from nexgent.tasks.strategy_checkpoints import (
    MAX_STRATEGY_SWITCHES,
    STRATEGY_CHECKPOINT_SCHEMA,
    build_strategy_checkpoint,
    validate_strategy_checkpoint,
)
from nexgent.tasks.strategy_decisions import build_strategy_candidate_set
from nexgent.tasks.tools import ContractError


def _package():
    files = {
        "agent/main.py": (
            "def execute(payload, context):\n"
            "    return {'deliverables': {}}\n"
        ),
        "workflows/main.json": json.dumps({
            "nodes": [{"id": "gather", "method": "join"}],
            "outputs": {"deliverables": {}},
        }),
    }
    manifest = {
        "manifest_version": 2,
        "entries": {"execute": "agent/main.py:execute"},
        "skills": {},
        "roles": {},
        "workflows": {
            "main": {"ref": "workflows/main.json", "max_parallel": 2},
        },
        "components": {
            "dag-main": {"class": "O", "kind": "workflow", "ref": "main"},
            "open-loop": {"class": "O", "kind": "entry", "ref": "execute"},
        },
        "orchestrator": "dag-main",
    }
    return make_package(files, manifest, provenance={"fixture": "checkpoint"})


def _candidates():
    return build_strategy_candidate_set(
        _package(), ["dag-main", "open-loop"])


def _budget(model_calls=3):
    return {
        "model_calls": model_calls,
        "completion_tokens": 1200,
        "tool_calls": 2,
        "tool_work_units": 7,
        "nodes": 4,
    }


def _arguments(target="open-loop"):
    handoff_ref = "artifact://episode-1/handoff"
    return {
        "episode_id": "episode-1",
        "root_episode_id": "episode-root",
        "candidate_set": _candidates(),
        "decision_digest": digest({"startup": "decision"}),
        "source_segment_id": "strategy-segment-1",
        "source_component_id": "dag-main",
        "trigger": {
            "node_id": "inspect-evidence",
            "receipt_digest": digest({"receipt": "durable"}),
            "receipt_status": "completed",
            "failure_domain": "agent",
        },
        "plan": {
            "ref": "plan-" + "1" * 64,
            "revision": 2,
            "completed_artifact_refs": ["artifact://episode-1/raw-evidence"],
            "pending_node_ids": ["publish", "synthesize"],
        },
        "root_budget": {
            "usage": _budget(),
            "remaining": _budget(model_calls=17),
        },
        "handoff_artifact": {
            "ref": handoff_ref,
            "digest": digest({"handoff": "content"}),
        },
        "model_suggestion": {
            "target_component_id": target,
            "reason": "The DAG exposed an evidence gap that needs an open loop.",
        },
    }


def _reseal(checkpoint):
    body = {key: deepcopy(value) for key, value in checkpoint.items()
            if key != "checkpoint_digest"}
    checkpoint["checkpoint_digest"] = digest(body)
    return checkpoint


def test_builds_host_bound_dag_to_open_loop_checkpoint():
    args = _arguments()
    checkpoint = build_strategy_checkpoint(**args)

    assert MAX_STRATEGY_SWITCHES == 1
    assert checkpoint["schema"] == STRATEGY_CHECKPOINT_SCHEMA
    assert checkpoint["episode_id"] == "episode-1"
    assert checkpoint["root_episode_id"] == "episode-root"
    assert checkpoint["package_digest"] == args["candidate_set"]["package_digest"]
    assert checkpoint["candidate_set_digest"] == (
        args["candidate_set"]["candidate_set_digest"])
    assert checkpoint["decision_digest"] == args["decision_digest"]
    assert checkpoint["source_segment"] == {
        "segment_id": "strategy-segment-1",
        "component_id": "dag-main",
        "component_digest": args["candidate_set"]["candidates"][0][
            "component_digest"],
        "backend": "executable_plan",
        "source_digest": args["candidate_set"]["candidates"][0][
            "source_digest"],
    }
    assert checkpoint["trigger"]["receipt_status"] == "completed"
    assert checkpoint["plan"]["completed_artifact_refs"] == sorted(
        args["plan"]["completed_artifact_refs"])
    assert checkpoint["plan"]["pending_node_ids"] == ["publish", "synthesize"]
    assert checkpoint["root_budget"] == args["root_budget"]
    assert checkpoint["handoff_artifact"] == args["handoff_artifact"]
    assert checkpoint["resolution"] == {
        "action": "switch",
        "selected_component_id": "open-loop",
        "component_digest": args["candidate_set"]["candidates"][1][
            "component_digest"],
        "backend": "controlled_code",
        "source_digest": args["candidate_set"]["candidates"][1][
            "source_digest"],
        "reason": "The DAG exposed an evidence gap that needs an open loop.",
    }
    assert validate_strategy_checkpoint(
        checkpoint, args["candidate_set"]) == checkpoint


def test_null_target_records_explicit_continue_on_source_strategy():
    args = _arguments(target=None)
    args["model_suggestion"]["reason"] = "The durable output is sufficient."
    checkpoint = build_strategy_checkpoint(**args)

    assert checkpoint["resolution"]["action"] == "continue"
    assert checkpoint["resolution"]["selected_component_id"] == "dag-main"
    assert checkpoint["resolution"]["backend"] == "executable_plan"
    assert validate_strategy_checkpoint(checkpoint, args["candidate_set"])


@pytest.mark.parametrize("failure_domain", [
    "infrastructure", "provider", "unknown", None,
])
def test_rejects_non_attributable_trigger_domains(failure_domain):
    args = _arguments()
    args["trigger"]["failure_domain"] = failure_domain

    with pytest.raises(ContractError, match="attributable"):
        build_strategy_checkpoint(**args)


@pytest.mark.parametrize("status", ["started", "unknown", None])
def test_requires_a_completed_durable_trigger_receipt(status):
    args = _arguments()
    args["trigger"]["receipt_status"] = status

    with pytest.raises(ContractError, match="must be completed"):
        build_strategy_checkpoint(**args)


@pytest.mark.parametrize("spoof", [
    {"backend": "controlled_code"},
    {"source_digest": "0" * 64},
    {"permissions": ["filesystem.write"]},
    {"candidate_set_digest": "0" * 64},
])
def test_model_cannot_submit_host_identity_or_permission_fields(spoof):
    args = _arguments()
    args["model_suggestion"].update(spoof)

    with pytest.raises(ContractError, match="only target_component_id and reason"):
        build_strategy_checkpoint(**args)


def test_rejects_unknown_target_and_same_component_as_a_switch():
    with pytest.raises(ContractError, match="unknown component"):
        build_strategy_checkpoint(**_arguments(target="fabricated"))

    with pytest.raises(ContractError, match="null target"):
        build_strategy_checkpoint(**_arguments(target="dag-main"))


def test_v1_rejects_non_dag_source_and_non_entry_switch_target():
    args = _arguments(target=None)
    args["source_component_id"] = "open-loop"
    with pytest.raises(ContractError, match="source must be a DAG"):
        build_strategy_checkpoint(**args)

    package = _package()
    manifest = deepcopy(package["manifest"])
    manifest["workflows"]["second"] = {
        "ref": "workflows/second.json", "max_parallel": 1}
    manifest["components"]["dag-second"] = {
        "class": "O", "kind": "workflow", "ref": "second"}
    files = {
        **package["files"],
        "workflows/second.json": json.dumps({
            "nodes": [{"id": "done", "method": "join"}],
            "outputs": {"deliverables": {}},
        }),
    }
    package = make_package(files, manifest)
    args = _arguments(target="dag-second")
    args["candidate_set"] = build_strategy_candidate_set(
        package, ["dag-main", "dag-second", "open-loop"])
    with pytest.raises(ContractError, match="open-loop entry"):
        build_strategy_checkpoint(**args)


def test_handoff_is_new_host_artifact_and_trigger_cannot_remain_pending():
    args = _arguments()
    args["plan"]["completed_artifact_refs"] = []
    assert build_strategy_checkpoint(**args)["plan"]["completed_artifact_refs"] == []

    args = _arguments()
    args["plan"]["pending_node_ids"].append("inspect-evidence")
    with pytest.raises(ContractError, match="cannot remain pending"):
        build_strategy_checkpoint(**args)


@pytest.mark.parametrize("mutation, message", [
    (lambda value: value["source_segment"].update(backend="controlled_code"),
     "source identity changed"),
    (lambda value: value["resolution"].update(source_digest="0" * 64),
     "resolution identity changed"),
    (lambda value: value["trigger"].update(failure_domain="infrastructure"),
     "not attributable"),
    (lambda value: value["plan"]["pending_node_ids"].reverse(),
     "not canonical"),
])
def test_validation_rejects_resealed_fabricated_host_facts(mutation, message):
    args = _arguments()
    checkpoint = build_strategy_checkpoint(**args)
    changed = deepcopy(checkpoint)
    mutation(changed)
    _reseal(changed)

    with pytest.raises(ContractError, match=message):
        validate_strategy_checkpoint(changed, args["candidate_set"])


def test_validation_rejects_digest_tampering_and_a_different_candidate_set():
    args = _arguments()
    checkpoint = build_strategy_checkpoint(**args)
    changed = deepcopy(checkpoint)
    changed["plan"]["revision"] = 3
    with pytest.raises(ContractError, match="identity changed"):
        validate_strategy_checkpoint(changed, args["candidate_set"])

    other = deepcopy(args["candidate_set"])
    other["package_digest"] = "0" * 64
    body = {key: other[key] for key in (
        "schema", "package_id", "package_digest", "candidates")}
    other["candidate_set_digest"] = digest(body)
    with pytest.raises(ContractError):
        validate_strategy_checkpoint(checkpoint, other)


@pytest.mark.parametrize("field, value", [
    ("usage", {"model_calls": 1}),
    ("remaining", {
        "model_calls": True, "completion_tokens": 1, "tool_calls": 1,
        "tool_work_units": 1, "nodes": 1,
    }),
])
def test_root_budget_requires_exact_nonnegative_integer_dimensions(field, value):
    args = _arguments()
    args["root_budget"][field] = value

    with pytest.raises(ContractError, match="root budget fields|nonnegative integer"):
        build_strategy_checkpoint(**args)
