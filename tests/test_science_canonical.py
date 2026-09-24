"""Canonical scientific-discovery migration contracts and legacy goldens."""

from copy import deepcopy
import base64
import hashlib
import json
from pathlib import Path
import tomllib

import pytest

from nexgent.tasks.packages import make_package
from nexgent.tasks.benchmarks import BenchmarkRegistry
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ToolRegistry
from nexgent.tasks.tools import ContractError, validate_tool_input
from nexgent_scientific_discovery import ResearchBenchmark, ScientificDiscoveryBenchmark
from nexgent_scientific_discovery.canonical import (
    ScientificDiscoveryDomain, ScientificDiscoveryTaskBenchmark, reference_package,
)
from nexgent_scientific_discovery.canonical import adapter as canonical_module


class _ZeroRunner:
    def run(self, bundle, entry, argument, **kwargs):
        values = []
        for problem in argument["problems"]:
            model = {"terms": ["1"],
                     "coefficients": [[0.0] for _ in range(problem["dimension"])]}
            values.append({"ok": True, "submission": {"model": model}})
        return {"value": values, "execution": {"work_units": 0}}


ZERO_SOURCE = '''def execute(payload, context):
    problem = context.read_artifact(payload["input_refs"]["problem"])["content"]
    model = {"terms": ["1"], "coefficients": [[0.0] for i in range(problem["dimension"])]}
    context.tool("scientific_discovery.integrate", {"model": model, "initial": [0.0 for i in range(problem["dimension"])], "dt": problem["dt"], "steps": 1, "substeps": 2})
    result = context.publish({"model": model, "limitations": ["zero-field accounting control"]}, name="result")
    return {"deliverables": {"result": result["id"]}}
'''


CAPTURE_SOURCE = '''def collect_keys(value, output):
    if isinstance(value, dict):
        for key, child in value.items():
            output.append(key)
            collect_keys(child, output)
    elif isinstance(value, list):
        for child in value:
            collect_keys(child, output)

def execute(payload, context):
    keys = []
    collect_keys(payload, keys)
    problem = context.read_artifact(payload["input_refs"]["problem"])["content"]
    model = {"terms": ["1"], "coefficients": [[0.0] for i in range(problem["dimension"])]}
    result = context.publish({"model": model, "package_payload_keys": sorted(set(keys))}, name="result")
    return {"deliverables": {"result": result["id"]}}
'''


def _zero_package():
    return make_package({"main.py": ZERO_SOURCE},
                        {"entries": {"execute": "main.py:execute"}},
                        provenance={"origin": "science-canonical-test-control"})


def _capture_package():
    return make_package({"main.py": CAPTURE_SOURCE},
                        {"entries": {"execute": "main.py:execute"}},
                        provenance={"origin": "science-payload-capture-control"})


def _keys(value):
    if isinstance(value, dict):
        for key, child in value.items():
            yield key
            yield from _keys(child)
    elif isinstance(value, list):
        for child in value:
            yield from _keys(child)


def test_science_declares_separate_legacy_domain_and_canonical_entries():
    metadata = tomllib.loads(
        (Path(__file__).parents[1] / "benchmarks" / "scientific_discovery" /
         "pyproject.toml").read_text(encoding="utf-8"))
    points = metadata["project"]["entry-points"]
    assert points["nexgent.benchmarks"]["scientific_discovery"] == (
        "nexgent_scientific_discovery:ScientificDiscoveryBenchmark")
    assert points["nexgent.domains"]["scientific_discovery"] == (
        "nexgent_scientific_discovery.canonical:domain_pack")
    assert points["nexgent.task_benchmarks"]["scientific_discovery"] == (
        "nexgent_scientific_discovery.canonical:ScientificDiscoveryTaskBenchmark")
    # Canonical files live below a subdirectory and do not become legacy
    # snapshot members or legacy source-bundle recovery inputs.
    assert not any("canonical" in name
                   for name in ScientificDiscoveryBenchmark().snapshot()["files"])


def test_project_adapter_has_explicit_splits_opaque_clusters_and_no_private_payload(tmp_path):
    adapter = ScientificDiscoveryTaskBenchmark.from_project(tmp_path)
    assert adapter.project_root == tmp_path.resolve()
    assert adapter.availability() == {"available": True}
    assert adapter.descriptor.modes == ("fixed",)
    assert adapter.descriptor.splits == ("development", "final_holdout")

    development = adapter.tasks("development", 7)
    holdout = adapter.tasks("final_holdout", 7)
    assert len(development) == 8 and len(holdout) == 12
    assert all(task["_benchmark_binding"]["native_split"] == "development"
               for task in development)
    assert all(task["_benchmark_binding"]["native_split"] == "confirmation"
               for task in holdout)
    assert not {"family", "parameters", "noise", "noise_std", "forecasts",
                "target", "targets", "truth"} & set(_keys(development + holdout))
    assert all(task["id"].startswith("scientific_discovery/")
               for task in development + holdout)
    assert len({task["statistical_unit_id"] for task in development}) == 8
    assert all(task["statistical_unit_id"].startswith(
        "scientific_discovery/statistical-unit/")
        and task["statistical_unit_id"].count("/") == 2
        for task in development)
    assert all(task["context"] == {
        "benchmark": "scientific_discovery", "split": "development",
        "split_role": "development",
        "memory_writeback": False,
    } for task in development)

    private = adapter._cases("development", 7)
    by_family = {}
    for task, case in zip(development, private):
        assert case["family"] not in task["cluster_id"]
        previous = by_family.setdefault(case["family"], task["cluster_id"])
        assert previous == task["cluster_id"]
    assert len(set(by_family.values())) == len(by_family)

    snapshot = adapter.snapshot()
    assert str(tmp_path.resolve()) not in json.dumps(snapshot)
    assert not {"observations", "forecasts", "target", "targets", "truth"} & set(
        _keys(snapshot))
    with pytest.raises(ValueError, match="registered"):
        adapter.tasks("my-development-copy", 7)


def test_canonical_registry_entry_is_project_aware(tmp_path):
    class Point:
        name = "scientific_discovery"

        @staticmethod
        def load():
            return ScientificDiscoveryTaskBenchmark

    registry = BenchmarkRegistry(tmp_path, points=[Point()])
    adapter = registry.get("scientific_discovery")
    assert adapter.project_root == tmp_path.resolve()
    assert registry.available()[0]["available"] is True


def test_evaluator_identity_excludes_reference_control_source(tmp_path, monkeypatch):
    adapter = ScientificDiscoveryTaskBenchmark.from_project(tmp_path)
    before = adapter.snapshot()["evaluator_digest"]
    monkeypatch.setattr(canonical_module, "REFERENCE_SOURCE", "def changed():\n    pass\n")
    assert adapter.snapshot()["evaluator_digest"] == before


def test_evaluator_identity_binds_report_canonicalizer(tmp_path, monkeypatch):
    adapter = ScientificDiscoveryTaskBenchmark.from_project(tmp_path)
    before = adapter.snapshot()["evaluator_digest"]

    def changed_canonicalizer(value):
        return {**value, "altered": True}

    monkeypatch.setattr(canonical_module, "_canonical", changed_canonicalizer)
    assert adapter.snapshot()["evaluator_digest"] != before


@pytest.mark.parametrize("name,value", [
    ("VERSION", "changed-version"),
    ("REPORT_SCHEMA", "changed-report-schema"),
    ("EVIDENCE_SCOPE", "changed evidence scope"),
    ("SPLIT_ALIASES", {"development": "changed", "final_holdout": "confirmation"}),
    ("CANONICAL_TOOL_API", "changed tool contract"),
    ("SCORE_MULTIPLIER", 11.0),
])
def test_evaluator_identity_binds_public_and_scoring_globals(
        tmp_path, monkeypatch, name, value):
    adapter = ScientificDiscoveryTaskBenchmark.from_project(tmp_path)
    before = adapter.snapshot()["evaluator_digest"]
    monkeypatch.setattr(canonical_module, name, value)
    assert adapter.snapshot()["evaluator_digest"] != before


def test_project_release_key_is_persistent_private_and_project_specific(tmp_path):
    first_root, second_root = tmp_path / "first", tmp_path / "second"
    first_root.mkdir()
    second_root.mkdir()
    first = ScientificDiscoveryTaskBenchmark.from_project(first_root)
    first_tasks = first.tasks("development", 4)
    first_snapshot = first.snapshot()
    key_path = first_root / canonical_module.RELEASE_KEY_RELATIVE_PATH
    key = key_path.read_bytes()
    assert len(key) == 32
    assert first_snapshot["release_key_digest"] == hashlib.sha256(key).hexdigest()
    assert first_snapshot["release_key_id"].endswith(
        first_snapshot["release_key_digest"][:16])

    restarted = ScientificDiscoveryTaskBenchmark.from_project(first_root)
    assert restarted.tasks("development", 4) == first_tasks
    assert restarted.snapshot() == first_snapshot

    second = ScientificDiscoveryTaskBenchmark.from_project(second_root)
    assert second.snapshot()["release_key_digest"] != first_snapshot["release_key_digest"]
    assert second.tasks("development", 4) != first_tasks

    serialized = json.dumps({
        "tasks": first_tasks,
        "snapshot": first_snapshot,
        "report": first.evaluate(first_tasks[0], {"result": {
            "model": {"terms": ["1"], "coefficients": [[0.0]]},
        }}, {}),
    }, sort_keys=True)
    assert key.hex() not in serialized
    assert base64.b64encode(key).decode("ascii") not in serialized
    assert str(key_path) not in serialized


def test_public_seed_enumeration_cannot_recover_keyed_release(tmp_path):
    adapter = ScientificDiscoveryTaskBenchmark.from_project(tmp_path)
    public_seed = 7
    task = adapter.tasks("development", public_seed)[0]
    released_id = task["inputs"]["problem"]["task_id"]
    enumerated = set()
    legacy = ResearchBenchmark()
    for candidate_seed in range(64):
        for problem in legacy.problems("development", candidate_seed):
            enumerated.add(adapter._public_problem({"problem": problem})["task_id"])
    assert released_id not in enumerated
    assert adapter._legacy_seed("development", public_seed) not in range(64)


@pytest.mark.parametrize("canonical_split,native_split", [
    ("development", "development"),
    ("final_holdout", "confirmation"),
])
def test_canonical_zero_control_matches_legacy_hidden_scoring_golden(
        canonical_split, native_split, tmp_path):
    seed = 19
    adapter = ScientificDiscoveryTaskBenchmark.from_project(tmp_path)
    tasks = adapter.tasks(canonical_split, seed)
    legacy = ResearchBenchmark()
    private_seed = adapter._legacy_seed(native_split, seed)
    legacy_problems = legacy.problems(native_split, private_seed)
    for task, legacy_problem in zip(tasks, legacy_problems):
        canonical_problem = deepcopy(task["inputs"]["problem"])
        canonical_id = canonical_problem.pop("task_id")
        legacy_id = legacy_problem.pop("task_id")
        canonical_tool_api = canonical_problem.pop("tool_api")
        legacy_problem.pop("tool_api")
        assert canonical_problem == legacy_problem
        assert canonical_id != legacy_id
        assert "context.tool('scientific_discovery.<method>'" in canonical_tool_api

    legacy_report = legacy.evaluate({}, native_split, private_seed, _ZeroRunner())
    canonical_reports = []
    for task in tasks:
        dimension = task["inputs"]["problem"]["dimension"]
        result = {"model": {"terms": ["1"],
                            "coefficients": [[0.0] for _ in range(dimension)]}}
        canonical_reports.append(adapter.evaluate(task, {"result": result}, {}))
    assert [row["score"] for row in canonical_reports] == [
        row["score"] for row in legacy_report["tasks"]]
    assert [row["nrmse"] for row in canonical_reports] == [
        row["nrmse"] for row in legacy_report["tasks"]]
    assert all(row["score_available"] and row["stable"]
               for row in canonical_reports)
    assert not {"observations", "forecasts", "target", "targets", "truth"} & set(
        _keys(canonical_reports))


def test_domain_tools_meter_actual_chunks_and_root_budget_fails_closed(tmp_path):
    adapter = ScientificDiscoveryTaskBenchmark.from_project(tmp_path)
    task = adapter.tasks("development", 3)[0]
    registry = ToolRegistry(ScientificDiscoveryDomain().tools())
    assert all(tool.work_units_per_call == 1
               for tool in ScientificDiscoveryDomain().tools())

    blocked_service = TaskService(tmp_path / "blocked", tools=registry)
    blocked = blocked_service.create(
        task["objective"], task["inputs"], task["deliverables"], {
            "max_model_calls": 0, "max_completion_tokens": 0,
            "max_tool_calls": 1, "max_tool_work_units": 0, "max_nodes": 8,
        }, task["capabilities"], _zero_package(), task["context"],
        constraints=task["constraints"])
    blocked = blocked_service.run(blocked["id"])
    assert blocked["status"] == "failed"
    assert blocked["usage"]["tool_calls"] == 0
    missing = blocked_service.evaluate(blocked["id"], adapter, task)["evaluation"]
    assert missing["score_available"] is True
    assert missing["score"] == 0.0 and missing["accepted"] is False

    service = TaskService(tmp_path / "metered", tools=registry)
    episode = service.create(
        task["objective"], task["inputs"], task["deliverables"], {
            "max_model_calls": 0, "max_completion_tokens": 0,
            "max_tool_calls": 1, "max_tool_work_units": 8, "max_nodes": 8,
        }, task["capabilities"], _zero_package(), task["context"],
        constraints=task["constraints"])
    state = service.run(episode["id"])
    assert state["status"] == "completed", state.get("last_error")
    assert state["usage"]["reserved_tool_work_units"] == 1
    assert state["usage"]["tool_work_units"] == 8
    assert state["usage"]["charged_tool_work_units"] == 8
    assert state["usage"]["usage_complete"] is True
    report = service.evaluate(state["id"], adapter, task)["evaluation"]
    assert report["score_available"] is True and report["accepted"] is True


def test_tool_schemas_are_bounded_and_large_input_is_charged_before_compute():
    tools = {tool.name: tool for tool in ScientificDiscoveryDomain().tools()}
    fit_schema = tools["scientific_discovery.fit_model"].input_schema
    assert fit_schema["properties"]["dt"] == {
        "type": "number", "exclusiveMinimum": 0, "maximum": 1}
    assert fit_schema["properties"]["window"] == {
        "type": "integer", "minimum": 0, "maximum": 101}
    feature_schema = tools["scientific_discovery.feature_matrix"].input_schema
    assert feature_schema["properties"]["times"]["maxItems"] == 4000
    integrate_output = tools["scientific_discovery.integrate"].output_schema
    assert integrate_output["maxItems"] == 2001
    assert tools["scientific_discovery.validate"].output_schema[
        "additionalProperties"] is False
    with pytest.raises(ContractError):
        validate_tool_input({
            "observations": [[[1.0]] * 9], "dt": 0,
            "terms": ["x0"], "window": 9, "degree": 3,
            "ridge": 1e-6, "threshold": 0.01, "weak_window": 0,
        }, fit_schema, artifact_resolver=lambda ref: None, label="fit")

    class Context:
        def __init__(self):
            self.charges = []

        def charge_work(self, units):
            self.charges.append(units)

    context = Context()
    result = canonical_module.smooth(
        {"states": [[float(index)] for index in range(300)],
         "window": 0, "degree": 3}, context)
    assert len(result) == 300
    assert context.charges == [302, 300]


def test_frozen_binding_never_enters_recursive_package_payload(tmp_path):
    adapter = ScientificDiscoveryTaskBenchmark.from_project(tmp_path)
    task = adapter.tasks("development", 23)[0]
    service = TaskService(
        tmp_path / "capture", tools=ToolRegistry(ScientificDiscoveryDomain().tools()))
    registration = {
        "benchmark_id": adapter.id,
        "task_ref": deepcopy(task),
        "snapshot": adapter.snapshot(),
    }
    episode = service.create(
        task["objective"], task["inputs"], task["deliverables"], {
            "max_model_calls": 0, "max_completion_tokens": 0,
            "max_tool_calls": 0, "max_tool_work_units": 0, "max_nodes": 8,
        }, task["capabilities"], _capture_package(), task["context"],
        constraints=task["constraints"], benchmark_registration=registration)
    state = service.run(episode["id"])
    assert state["status"] == "completed", state.get("last_error")
    assert "_benchmark_binding" not in state["task"]
    captured = service.store.read(state["output_refs"]["result"], state["id"])["content"]
    forbidden = {
        "_benchmark_binding", "native_split", "seed", "case_index",
        "suite_digest", "statistical_unit_id", "cluster_id",
    }
    assert forbidden.isdisjoint(captured["package_payload_keys"])
    evaluation = service.evaluate(
        state["id"], adapter, task, snapshot=registration["snapshot"])["evaluation"]
    assert evaluation["score_available"] is True
    assert {"seed", "case_index", "native_split"}.isdisjoint(_keys(evaluation))

    key = (tmp_path / canonical_module.RELEASE_KEY_RELATIVE_PATH).read_bytes()
    evidence = json.dumps({
        "task": task,
        "state_task": state["task"],
        "events": state["events"],
        "registration": service.store.benchmark_registration(state["id"]),
        "evaluation": evaluation,
    }, sort_keys=True)
    assert key.hex() not in evidence
    assert base64.b64encode(key).decode("ascii") not in evidence


def test_final_holdout_context_uses_isolated_initial_memory_scope(tmp_path):
    adapter = ScientificDiscoveryTaskBenchmark.from_project(tmp_path)
    service = TaskService(
        tmp_path / "memory", tools=ToolRegistry(ScientificDiscoveryDomain().tools()))
    development_task = adapter.tasks("development", 2)[0]
    development = service.create(
        development_task["objective"], development_task["inputs"],
        development_task["deliverables"], package=_zero_package(),
        capabilities=development_task["capabilities"],
        context=development_task["context"], constraints=development_task["constraints"])
    remembered = service.store.remember(
        development["id"], {"secret": "development-only"})
    assert remembered["split"] == "development"

    final_task = adapter.tasks("final_holdout", 2)[0]
    final = service.create(
        final_task["objective"], final_task["inputs"], final_task["deliverables"],
        package=_zero_package(), capabilities=final_task["capabilities"],
        context=final_task["context"], constraints=final_task["constraints"])
    snapshot = service.store.memory_snapshot(
        final["memory_snapshot_id"], final["id"])
    assert final["task"]["context"]["split"] == "final_holdout"
    assert final["task"]["context"]["split_role"] == "final_holdout"
    assert snapshot["split"] == "final_holdout"
    assert snapshot["items"] == []


def test_invalid_model_is_observed_zero_without_legacy_missing_sentinel(tmp_path):
    adapter = ScientificDiscoveryTaskBenchmark.from_project(tmp_path)
    task = adapter.tasks("development", 5)[0]
    result = {"model": {"terms": ["x0"], "coefficients": [[float("nan")]]}}
    report = adapter.evaluate(task, {"result": result}, {})
    assert report["status"] == "rejected"
    assert report["score_available"] is True
    assert report["score"] == 0.0 and report["accepted"] is False
    json.dumps(report, allow_nan=False)


def test_reference_package_is_deterministic_model_free_control():
    first, second = reference_package(), reference_package()
    assert first == second
    assert first["manifest"]["entries"] == {"execute": "main.py:execute"}
    assert "context.tool(\"scientific_discovery.fit_model\"" in first["files"]["main.py"]
    assert "context.tool(\"scientific_discovery.validate\"" in first["files"]["main.py"]
    assert first["provenance"]["origin"] == (
        "nexgent-scientific-discovery.reference-control")


def test_reference_package_runs_one_real_taskservice_episode(tmp_path):
    adapter = ScientificDiscoveryTaskBenchmark.from_project(tmp_path)
    task = adapter.tasks("development", 0)[0]
    service = TaskService(
        tmp_path / "reference", tools=ToolRegistry(ScientificDiscoveryDomain().tools()))
    episode = service.create(
        task["objective"], task["inputs"], task["deliverables"], {
            "max_model_calls": 0, "max_completion_tokens": 0,
            "max_tool_calls": 3, "max_tool_work_units": 1_000_000,
            "max_nodes": 16,
        }, task["capabilities"], reference_package(), task["context"],
        constraints=task["constraints"])
    state = service.run(episode["id"])
    assert state["status"] == "completed", state.get("last_error")
    assert state["usage"]["model_calls"] == 0
    assert state["usage"]["tool_calls"] == 3
    assert state["usage"]["charged_tool_work_units"] > 0
    assert state["usage"]["usage_complete"] is True
    receipts = [event["content"] for event in state["events"]
                if event["kind"] == "tool"]
    assert [receipt["name"] for receipt in receipts] == [
        "scientific_discovery.fit_model",
        "scientific_discovery.validate",
        "scientific_discovery.fit_model",
    ]
    assert all(receipt["status"] == "completed"
               and receipt["work_accounting"]["charged_work_units"] > 0
               for receipt in receipts)
    result = service.store.read(
        state["output_refs"]["result"], state["id"])["content"]
    assert set(result["model"]) == {"terms", "coefficients"}
    report = service.evaluate(state["id"], adapter, task)["evaluation"]
    assert report["score_available"] is True
    assert report["accepted"] is True and report["score"] > 0
