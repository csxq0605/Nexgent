from copy import deepcopy
import json

import pytest

from nexgent.kernel.programs import digest
from nexgent.tasks.packages import make_package
from nexgent.tasks.strategy_decisions import (
    CANDIDATE_SET_SCHEMA,
    STRATEGY_DECISION_SCHEMA,
    build_strategy_candidate_set,
    parse_strategy_decision,
    validate_strategy_candidate_set,
)
from nexgent.tasks.tools import ContractError


def _package():
    files = {
        "agent/main.py": (
            "def execute(payload, context):\n"
            "    return {'deliverables': {}}\n"
        ),
        "workflows/main.json": json.dumps({
            "nodes": [{"id": "done", "method": "join"}],
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
    return make_package(files, manifest, provenance={"fixture": "strategies"})


def _model_output(selected="open-loop"):
    return {
        "selected_component_id": selected,
        "basis": ["The next action depends on tool feedback."],
        "stop_conditions": ["All requested artifacts are published."],
        "estimated_cost": {
            "model_calls": 3,
            "completion_tokens": 1200,
            "tool_calls": 2,
            "tool_work_units": 0,
            "nodes": 8,
        },
    }


def test_projects_verified_entry_and_workflow_with_host_identity():
    package = _package()
    result = build_strategy_candidate_set(
        package, ["open-loop", "dag-main"])

    assert result["schema"] == CANDIDATE_SET_SCHEMA
    assert result["package_id"] == package["id"]
    assert result["package_digest"] == package["digest"]
    assert [row["component_id"] for row in result["candidates"]] == [
        "dag-main", "open-loop"]
    dag, loop = result["candidates"]
    assert (dag["shape"], dag["backend"], dag["source_kind"],
            dag["source_path"], dag["source_digest"]) == (
        "dag", "executable_plan", "workflow_graph", "workflows/main.json",
        package["component_digests"]["workflows/main.json"])
    assert (loop["shape"], loop["backend"], loop["source_kind"],
            loop["source_path"], loop["source_digest"]) == (
        "open_loop", "controlled_code", "python_source", "agent/main.py",
        package["component_digests"]["agent/main.py"])
    assert result["candidate_set_digest"] == digest({
        key: result[key] for key in (
            "schema", "package_id", "package_digest", "candidates")
    })


@pytest.mark.parametrize("component_ids", [
    [],
    ["dag-main", "dag-main"],
    ["missing"],
    [""],
    "dag-main",
])
def test_candidate_projection_rejects_empty_duplicate_unknown_or_invalid_sets(
        component_ids):
    with pytest.raises(ContractError):
        build_strategy_candidate_set(_package(), component_ids)


def test_candidate_projection_rejects_v1_non_o_and_non_execute_entry():
    v1 = make_package(
        {"main.py": "def execute(payload, context):\n    return payload\n"},
        {"entries": {"execute": "main.py:execute"}},
    )
    with pytest.raises(ContractError, match="v2"):
        build_strategy_candidate_set(v1, ["anything"])

    package = _package()
    changed = deepcopy(package["manifest"])
    changed["entries"]["improve"] = "agent/main.py:execute"
    changed["components"]["improver-entry"] = {
        "class": "O", "kind": "entry", "ref": "improve"}
    changed_files = {
        **package["files"], "resources/memory.json": "{}",
    }
    changed["components"]["memory"] = {
        "class": "M", "kind": "resource", "ref": "resources/memory.json"}
    changed_package = make_package(changed_files, changed)
    with pytest.raises(ContractError, match="execute entry"):
        build_strategy_candidate_set(changed_package, ["improver-entry"])
    with pytest.raises(ContractError, match="not an O component"):
        build_strategy_candidate_set(changed_package, ["memory"])


def test_parses_minimal_choice_and_attaches_host_derived_candidate():
    package = _package()
    candidates = build_strategy_candidate_set(
        package, ["dag-main", "open-loop"])
    result = parse_strategy_decision(_model_output(), candidates)

    assert result["schema"] == STRATEGY_DECISION_SCHEMA
    assert result["candidate_set_digest"] == candidates["candidate_set_digest"]
    assert result["package_digest"] == package["digest"]
    assert result["selected_component_id"] == "open-loop"
    assert result["selected_candidate"] == candidates["candidates"][1]
    body = {key: value for key, value in result.items()
            if key != "decision_digest"}
    assert result["decision_digest"] == digest(body)


@pytest.mark.parametrize("estimated", [
    None,
    {"model_calls": 2},
    {"completion_tokens": 800, "tool_calls": 1},
])
def test_cost_estimate_may_abstain_or_report_known_sparse_dimensions(estimated):
    output = _model_output()
    output["estimated_cost"] = estimated
    result = parse_strategy_decision(
        output, build_strategy_candidate_set(
            _package(), ["dag-main", "open-loop"]))

    expected = (estimated if estimated is None else
                {key: estimated[key] for key in sorted(estimated)})
    assert result["estimated_cost"] == expected


@pytest.mark.parametrize("spoof", [
    {"package_digest": "0" * 64},
    {"candidate_set_digest": "0" * 64},
    {"selected_candidate": {}},
    {"schema": STRATEGY_DECISION_SCHEMA},
    {"backend": "executable_plan"},
])
def test_model_cannot_submit_host_identity_fields(spoof):
    output = {**_model_output(), **spoof}
    with pytest.raises(ContractError, match="unknown or missing"):
        parse_strategy_decision(
            output, build_strategy_candidate_set(
                _package(), ["dag-main", "open-loop"]))


def test_rejects_unknown_selection_and_invalid_basis_or_stop_conditions():
    candidates = build_strategy_candidate_set(
        _package(), ["dag-main", "open-loop"])
    with pytest.raises(ContractError, match="unknown component"):
        parse_strategy_decision(_model_output("unknown"), candidates)

    for field, value in [
            ("basis", []),
            ("basis", ["same", "same"]),
            ("basis", [""]),
            ("stop_conditions", "done"),
            ("stop_conditions", [7])]:
        output = _model_output()
        output[field] = value
        with pytest.raises(ContractError):
            parse_strategy_decision(output, candidates)


@pytest.mark.parametrize("cost", [
    {},
    {"model_calls": 1, "completion_tokens": 1, "tool_calls": 1,
     "tool_work_units": 0, "nodes": 1, "dollars": 1},
    {"model_calls": True, "completion_tokens": 1, "tool_calls": 1,
     "tool_work_units": 0, "nodes": 1},
    {"model_calls": -1, "completion_tokens": 1, "tool_calls": 1,
     "tool_work_units": 0, "nodes": 1},
    {"model_calls": 1.5, "completion_tokens": 1, "tool_calls": 1,
     "tool_work_units": 0, "nodes": 1},
    {"model_calls": 1, "completion_tokens": 1_000_000_000_001,
     "tool_calls": 1, "tool_work_units": 0, "nodes": 1},
])
def test_rejects_invalid_estimated_cost(cost):
    output = _model_output()
    output["estimated_cost"] = cost
    with pytest.raises(ContractError, match="estimated_cost"):
        parse_strategy_decision(
            output, build_strategy_candidate_set(
                _package(), ["dag-main", "open-loop"]))


def test_rejects_changed_or_structurally_inconsistent_candidate_set():
    candidates = build_strategy_candidate_set(
        _package(), ["dag-main", "open-loop"])
    changed = deepcopy(candidates)
    changed["candidates"][0]["source_digest"] = "0" * 64
    with pytest.raises(ContractError, match="identity changed"):
        validate_strategy_candidate_set(changed)

    inconsistent = deepcopy(candidates)
    inconsistent["candidates"][0]["backend"] = "controlled_code"
    body = {key: inconsistent[key] for key in (
        "schema", "package_id", "package_digest", "candidates")}
    inconsistent["candidate_set_digest"] = digest(body)
    with pytest.raises(ContractError, match="Workflow strategy"):
        parse_strategy_decision(_model_output(), inconsistent)


def test_rejects_nonfinite_model_output():
    output = _model_output()
    output["estimated_cost"]["completion_tokens"] = float("nan")
    with pytest.raises(ContractError, match="finite JSON"):
        parse_strategy_decision(
            output, build_strategy_candidate_set(
                _package(), ["dag-main", "open-loop"]))
