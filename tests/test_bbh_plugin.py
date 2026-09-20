"""BBH adapter checks use authored fixtures and simulated downloads, never models."""

from copy import deepcopy
import hashlib
import io
import json
from pathlib import Path
import threading
import tomllib

import pytest

from nexgent.kernel.programs import make_bundle
from nexgent.kernel.runner import ProgramRunner
from nexgent_bbh import (
    BigBenchHardBenchmark, BigBenchHardTaskBenchmark, reference_package,
)
from nexgent_bbh import data


def bundle(benchmark):
    return make_bundle({**benchmark.initial_files(), "meta.py": "def improve(context, broker): return {'candidates': []}\n"})


class CapturingRunner:
    def __init__(self, error=None, answer="wrong", instructions=123):
        self.arguments = []; self.error = error; self.answer = answer; self.instructions = instructions

    def run(self, program, entry, argument, **kwargs):
        self.arguments.append(deepcopy(argument))
        if self.error: raise self.error
        return {"value": [{"ok": True, "submission": {"answer": self.answer, "instructions": 0}} for _ in argument["problems"]],
                "execution": {"bundle_id": program["id"], "source_digest": program["digest"], "entry": entry,
                              "instructions": self.instructions, "work_units": 999999}}


def test_plugin_requires_explicit_official_data_and_never_silently_uses_fixtures(monkeypatch):
    monkeypatch.delenv("NEXGENT_BBH_DATA", raising=False)
    with pytest.raises(data.DatasetError, match="NEXGENT_BBH_DATA"):
        BigBenchHardBenchmark()
    b = BigBenchHardBenchmark(fixture=True)
    assert "TEST FIXTURE" in b.spec.title
    assert b.snapshot()["data"]["mode"] == "synthetic_test_fixture"
    assert b.spec.toolbox_factory is None and b.spec.work_unit == "source_instruction_events"


def test_public_inputs_and_feedback_do_not_expose_targets():
    b = BigBenchHardBenchmark(fixture=True); runner = CapturingRunner()
    report = b.evaluate(bundle(b), "development", 0, runner)
    assert len(runner.arguments) == 1
    for problem in runner.arguments[0]["problems"]:
        assert set(problem) == {"task_id", "category", "input", "requirements"}
    assert all("target" not in row for row in report["tasks"])
    assert report["work_units"] == 123
    assert report["work_unit"] == "source_instruction_events"
    assert report["score"] == 0 and report["score_available"] and report["status"] == "ok"


def test_fixed_pools_are_disjoint_even_across_different_seeds():
    from nexgent_bbh.benchmark import PARTITIONS
    b = BigBenchHardBenchmark(fixture=True, samples_per_task=100)
    pools = [{p["input"] for p in b.problems(split, index)} for index, split in enumerate(PARTITIONS)]
    for index, current in enumerate(pools):
        assert current
        assert all(current.isdisjoint(other) for other in pools[index + 1:])
    assert b.problems("development", 7) == b.problems("development", 7)
    with pytest.raises(ValueError): b.problems("unregistered", 0)


def test_data_scope_and_sample_count_are_part_of_evaluator_identity():
    a = BigBenchHardBenchmark(fixture=True, samples_per_task=2)
    b = BigBenchHardBenchmark(fixture=True, samples_per_task=3)
    assert a.evaluator_digest != b.evaluator_digest
    assert a.evaluator_digest == BigBenchHardBenchmark(fixture=True, samples_per_task=2).evaluator_digest
    report = a.evaluate(bundle(a), "development", 3, CapturingRunner())
    assert report["suite_digest"] != a.evaluate(bundle(a), "selection", 3, CapturingRunner())["suite_digest"]


def test_framework_final_transfer_is_an_alias_not_an_additional_data_partition():
    b = BigBenchHardBenchmark(fixture=True)
    legacy = b.evaluate(bundle(b), "transfer", 17, CapturingRunner())
    framework = b.evaluate(bundle(b), "final_transfer", 17, CapturingRunner())
    assert framework["split"] == "final_transfer" and legacy["split"] == "transfer"
    assert framework["native_split"] == legacy["native_split"] == "transfer"
    assert framework["tasks"] == legacy["tasks"]
    assert framework["suite_digest"] == legacy["suite_digest"]
    assert b.snapshot()["data"]["split_aliases"] == {"final_transfer": "transfer"}
    assert "final_transfer" not in b.snapshot()["data"]["partitions_percent"]


class NoModelGateway:
    """A test-only gate that makes any accidental model request fail visibly."""
    def __init__(self, *args, **kwargs): pass
    def preflight(self): pass
    def ask(self, *args, **kwargs):
        raise AssertionError("This controller integration must not call a model")


def test_fixed_benchmark_public_controller_default_split_executes_actual_bbh_source(tmp_path):
    from nexgent.evolution.controller import StudyController
    b = BigBenchHardBenchmark(fixture=True, samples_per_task=2)
    c = StudyController(tmp_path, benchmark=b, gateway_factory=NoModelGateway)
    result = c.evaluate_benchmark(benchmark_id=b.spec.id, seeds=(101, 202))
    assert result["status"] == "completed", result.get("last_error")
    assert result["registration"]["split"] == "final_transfer"
    summary = result["benchmark_evaluation"]["summary"]
    assert summary["measured"] == 2 and summary["missing"] == 0
    assert summary["mean_score"] == 1.0
    assert result["usage"]["model_calls"] == 0
    for row in result["benchmark_evaluation"]["results"]:
        report = row["report"]
        assert report["split"] == "final_transfer" and report["native_split"] == "transfer"
        assert report["execution"]["entry"] == "solve_batch"
        assert report["work_units"] == report["execution"]["instructions"] > 0
    assert c.run(result["id"])["benchmark_evaluation"] == result["benchmark_evaluation"]


def test_full_controller_loop_passes_bbh_contract_and_finishes_final_transfer(tmp_path):
    from nexgent.evolution.controller import StudyController
    b = BigBenchHardBenchmark(fixture=True, samples_per_task=2)
    c = StudyController(tmp_path, benchmark=b, gateway_factory=NoModelGateway)
    # This explicit fixture only checks executable workflow plumbing, not RSI efficacy.
    meta = '''def improve(context, broker):
    return {"candidates": [{"files": {"task.py": context["parent"]["files"]["task.py"] + "\\n# Controller fixture revision\\n"},
            "rationale": "Exercise source evaluation through the public controller",
            "hypothesis": "A comment-only revision preserves exact answers"}],
            "research": {"observed_task_contract": context["task_contract"], "observed_domain": context["domain"]["id"]}}
def select_parent(archive):
    return archive[-1]["id"]
'''
    root = make_bundle({**b.initial_files(), "meta.py": meta})
    c.store.put_bundle(root)
    registered = c.create("Explicit BBH controller integration fixture", generations=1,
                          starting_program=root["id"], benchmark_id=b.spec.id)
    result = c.run(registered["id"])
    assert result["status"] == "completed", result.get("last_error")
    assert result["usage"]["model_calls"] == 0
    assert result["generation"] == 1 and len(result["evaluations"]) == 1
    assert result["evaluations"][0]["measurement"]["score"] == 1.0
    research = result["research"]["experiments"][0]["research"]
    assert research["observed_task_contract"] == b.spec.task_contract
    assert research["observed_domain"] == "bbh"
    assert len(result["conclusion"]["final_transfer"]) == 3
    assert result["conclusion"]["missing_transfer_seeds"] == []
    for pair in result["conclusion"]["final_transfer"]:
        assert pair["status"] == "evaluated" and pair["delta"] == 0.0
        for role in ("initial", "selected"):
            assert pair[role]["split"] == "final_transfer"
            assert pair[role]["score_available"] and pair[role]["score"] == 1.0


@pytest.mark.parametrize("exception,kind", [(TimeoutError("deadline"), "timeout"),
    (InterruptedError("stop"), "interrupted"), (MemoryError("limit"), "budget_exhausted")])
def test_resource_failures_are_missing_and_cost_is_not_fabricated(exception, kind):
    b = BigBenchHardBenchmark(fixture=True)
    report = b.evaluate(bundle(b), "development", 0, CapturingRunner(error=exception), max_work_units=1000)
    assert report["status"] == kind and not report["score_available"]
    assert all(not row["score_available"] for row in report["tasks"])
    assert report["execution"] == {}
    assert report["cost_status"] == "reserved_cap_actual_cost_unavailable"


def test_stop_before_execution_does_not_start_a_worker():
    b = BigBenchHardBenchmark(fixture=True); runner = CapturingRunner(); stop = threading.Event(); stop.set()
    result = b.evaluate(bundle(b), "development", 0, runner, stop_event=stop)
    assert runner.arguments == [] and result["status"] == "interrupted"


def test_registered_instruction_budget_is_checked_against_the_host_receipt():
    b = BigBenchHardBenchmark(fixture=True)
    report = b.evaluate(bundle(b), "development", 0, CapturingRunner(instructions=200), max_work_units=100)
    assert report["work_units"] == 200
    assert report["status"] == "budget_exhausted" and not report["score_available"]


def test_strong_algorithmic_control_executes_with_the_general_kernel():
    b = BigBenchHardBenchmark(fixture=True)
    report = b.evaluate(bundle(b), "development", 1, ProgramRunner())
    assert report["score"] == 1.0 and report["score_available"]
    assert report["execution"]["source_digest"] == bundle(b)["digest"]
    assert report["work_units"] == report["execution"]["instructions"] > 0


def test_boolean_parser_handles_precedence_negation_and_short_circuit_consumption():
    b = BigBenchHardBenchmark(fixture=True)
    questions = ["False and True or True is", "True or False and False is", "not not ( not False ) is",
                 "not ( True or False ) and True is", "( True or False ) and not False is"]
    result = ProgramRunner().run(bundle(b), "solve_batch", {"problems": [
        {"input": value, "category": "boolean_expressions"} for value in questions]})
    assert [entry["submission"]["answer"] for entry in result["value"]] == ["True", "True", "True", "False", "True"]


def test_download_verifies_all_hashes_before_writing_and_preserves_license(tmp_path, monkeypatch):
    contents = {"LICENSE": b"test license", "words.json": b'{"canary":"test only","examples":[]}'}
    monkeypatch.setattr(data, "FILES", {name: hashlib.sha256(raw).hexdigest() for name, raw in contents.items()})
    urls = []
    def opener(url, timeout):
        urls.append(url); return io.BytesIO(contents[url.rsplit("/", 1)[-1]])
    output = data.download(tmp_path / "dataset", opener=opener)
    assert (output / "LICENSE").read_bytes() == b"test license"
    assert (output / "words.json").read_bytes() == contents["words.json"]
    assert all(data.COMMIT in url for url in urls)
    assert json.loads((output / "manifest.json").read_text())["sha256"] == data.FILES
    assert data.download(output, opener=lambda *a, **k: pytest.fail("matching data must not redownload")) == output


def test_download_integrity_failure_leaves_no_dataset(tmp_path):
    output = tmp_path / "bad"
    with pytest.raises(data.DatasetError, match="SHA256"):
        data.download(output, opener=lambda *args, **kwargs: io.BytesIO(b"unexpected body"))
    assert not output.exists()


def test_official_loader_checks_manifest_before_trusting_examples(tmp_path):
    (tmp_path / "manifest.json").write_text(json.dumps({**data.source_manifest(), "commit": "forged"}))
    with pytest.raises(data.DatasetError, match="manifest"):
        data.load(tmp_path)


def test_project_factory_defaults_to_workspace_data_and_respects_explicit_override(tmp_path, monkeypatch):
    class RecordingBenchmark(BigBenchHardBenchmark):
        def __init__(self, *, data_path): self.path = data_path
    monkeypatch.delenv("NEXGENT_BBH_DATA", raising=False)
    assert RecordingBenchmark.from_project(tmp_path).path == tmp_path / ".nexgent" / "benchmarks" / "bbh"
    monkeypatch.setenv("NEXGENT_BBH_DATA", str(tmp_path / "override"))
    assert str(RecordingBenchmark.from_project(tmp_path).path) == str(tmp_path / "override")


def test_canonical_descriptor_snapshot_aliases_and_public_tasks_do_not_expose_answers():
    b = BigBenchHardTaskBenchmark(fixture=True, samples_per_task=3)
    assert b.descriptor.id == "bbh"
    assert b.descriptor.default_split == "development"
    assert b.descriptor.modes == ("fixed", "confirmatory")
    assert set(b.descriptor.splits) == {
        "development", "selection", "transfer", "meta_transfer", "confirmation",
        "final_transfer", "final_holdout",
    }
    transfer = b.tasks("transfer", 17)
    alias = b.tasks("final_transfer", 17)
    assert [row["id"] for row in transfer] == [row["id"] for row in alias]
    assert {row["context"]["suite_digest"] for row in transfer + alias} == {
        transfer[0]["context"]["suite_digest"]}
    holdout = b.tasks("final_holdout", 17)
    confirmation = b.tasks("confirmation", 17)
    assert [row["id"] for row in holdout] == [row["id"] for row in confirmation]
    public = json.dumps({"snapshot": b.snapshot(), "tasks": transfer + holdout}, sort_keys=True)
    assert '"target"' not in public
    assert '"answer": "True"' not in public and '"answer": "False"' not in public
    compatibility = b.describe()["legacy_compatibility"]
    assert compatibility["legacy_entry_group"] == "nexgent.benchmarks"
    assert compatibility["canonical_entry_group"] == "nexgent.task_benchmarks"
    assert "must not be interpreted" in compatibility["record_boundary"]


def test_canonical_project_factory_availability_and_installed_entry_are_project_aware(
        tmp_path, monkeypatch):
    monkeypatch.delenv("NEXGENT_BBH_DATA", raising=False)
    adapter = BigBenchHardTaskBenchmark.from_project(tmp_path)
    assert adapter.data_path == (tmp_path / ".nexgent" / "benchmarks" / "bbh").resolve()
    assert adapter.availability()["available"] is False
    # Discovery can still validate the answer-free snapshot before data exists.
    assert adapter.snapshot()["manifest"]["data"]["mode"] == "official_pinned_subset"
    metadata = tomllib.loads(
        (Path(__file__).parents[1] / "benchmarks" / "bbh" / "pyproject.toml")
        .read_text(encoding="utf-8"))
    assert metadata["project"]["entry-points"]["nexgent.task_benchmarks"]["bbh"] == (
        "nexgent_bbh:BigBenchHardTaskBenchmark")


def test_canonical_sample_count_fails_closed_when_any_selected_pool_is_too_small(
        monkeypatch):
    oversized = BigBenchHardTaskBenchmark(fixture=True, samples_per_task=5)
    description = oversized.describe()
    assert "task_count_per_seed" not in description
    assert description["requested_samples_per_family"] == 5
    assert oversized.availability()["available"] is False
    with pytest.raises(data.DatasetError, match="exactly 5 samples.*confirmation=4"):
        oversized.tasks("final_holdout", 0)

    exact = BigBenchHardTaskBenchmark(fixture=True, samples_per_task=4)
    assert exact.availability() == {"available": True}
    legacy = exact._legacy()
    original = legacy._cases
    monkeypatch.setattr(legacy, "_cases", lambda split, seed: original(split, seed)[:-1])
    with pytest.raises(data.DatasetError, match="exact registered family multiset"):
        exact.tasks("confirmation", 0)


def test_canonical_fixture_is_exactly_score_and_group_equivalent_to_legacy_fixture():
    seed = 23
    legacy = BigBenchHardBenchmark(fixture=True, samples_per_task=4)
    cases = legacy._cases("development", seed)
    answers = {}
    for index, case in enumerate(cases):
        # Exercise both accepted and rejected rows in each family.
        answers[case["task_id"]] = case["target"] if index % 3 else "definitely-wrong"

    class GoldenRunner:
        def run(self, program, entry, argument, **kwargs):
            return {
                "value": [{"ok": True, "submission": {
                    "answer": answers[problem["task_id"]]}}
                    for problem in argument["problems"]],
                "execution": {"instructions": 777, "entry": entry},
            }

    legacy_report = legacy.evaluate(bundle(legacy), "development", seed, GoldenRunner())
    canonical = BigBenchHardTaskBenchmark(fixture=True, samples_per_task=4)
    canonical_reports = []
    for task in canonical.tasks("development", seed):
        public_id = task["inputs"]["problem"]["task_id"]
        canonical_reports.append(canonical.evaluate(
            task, {"answer": {"answer": answers[public_id]}},
            {"usage": {"model_calls": 0, "usage_complete": True}}))
    aggregate = canonical.aggregate(canonical_reports)
    assert aggregate["score"] == legacy_report["score"]
    assert aggregate["score_available"] == legacy_report["score_available"]
    assert aggregate["groups"] == legacy_report["groups"]
    assert all("target" not in row for row in canonical_reports)
    assert all("source_instruction_events" in row["cost_semantics"]["legacy_comparison"]
               for row in canonical_reports)


@pytest.mark.parametrize("mutation", [
    "missing", "duplicate", "extra", "missing_schema_field", "forged_task_ref",
    "forged_task_id", "forged_family", "forged_score", "nonfinite_score",
    "fractional_score", "accepted_mismatch", "forged_native_split", "forged_seed",
    "forged_suite", "forged_manifest", "forged_evaluator", "forged_report_identity",
])
def test_canonical_aggregate_rejects_incomplete_malformed_or_forged_reports(mutation):
    adapter = BigBenchHardTaskBenchmark(fixture=True, samples_per_task=2)
    tasks = adapter.tasks("final_transfer", 47)
    private = {case["task_id"]: case for case in adapter._legacy()._cases("transfer", 47)}
    reports = [adapter.evaluate(
        task,
        {"answer": {"answer": private[task["inputs"]["problem"]["task_id"]]["target"]}},
        {"usage": {"model_calls": 0, "usage_complete": True}})
        for task in tasks]
    assert adapter.aggregate(reports)["score"] == 1.0

    forged = deepcopy(reports)
    if mutation == "missing":
        forged.pop()
    elif mutation == "duplicate":
        forged[-1] = deepcopy(forged[0])
    elif mutation == "extra":
        forged.append(deepcopy(forged[0]))
    elif mutation == "missing_schema_field":
        forged[0].pop("group")
    elif mutation == "forged_task_ref":
        forged[0]["task_ref"] += "-forged"
    elif mutation == "forged_task_id":
        forged[0]["task_id"] += "-forged"
    elif mutation == "forged_family":
        forged[0]["family"] = "word_sorting" if forged[0]["family"] == "boolean_expressions" else "boolean_expressions"
    elif mutation == "forged_score":
        forged[0].update(score=0.0, accepted=False, status="rejected",
                         reasons=["exact_answer_mismatch"])
    elif mutation == "nonfinite_score":
        forged[0]["score"] = float("nan")
    elif mutation == "fractional_score":
        forged[0].update(score=0.5, accepted=False, status="rejected",
                         reasons=["exact_answer_mismatch"])
    elif mutation == "accepted_mismatch":
        forged[0]["accepted"] = False
    elif mutation == "forged_native_split":
        forged[0]["native_split"] = "selection"
    elif mutation == "forged_seed":
        forged[0]["seed"] = 48
    elif mutation == "forged_suite":
        forged[0]["suite_digest"] = "0" * 64
    elif mutation == "forged_manifest":
        forged[0]["manifest_digest"] = "0" * 64
    elif mutation == "forged_evaluator":
        forged[0]["evaluator_digest"] = "0" * 64
    elif mutation == "forged_report_identity":
        forged[0]["report_identity"] = "0" * 64
    with pytest.raises(ValueError):
        adapter.aggregate(forged)


def test_canonical_reference_package_runs_through_task_service_without_models(
        tmp_path, monkeypatch):
    from nexgent.tasks.runtime import TaskService
    from nexgent.tasks.tools import ToolRegistry

    adapter = BigBenchHardTaskBenchmark(fixture=True, samples_per_task=2)
    monkeypatch.setattr(
        "nexgent.tasks.runtime.task_benchmarks",
        lambda project_root=None: {adapter.id: adapter})
    service = TaskService(tmp_path, tools=ToolRegistry())
    result = service.benchmark(
        adapter.id, split="final_transfer", seed=31, package=reference_package())
    assert len(result["reports"]) == 4
    assert all(row["evaluation"]["accepted"] is True for row in result["reports"])
    assert all(row["evaluation"]["score"] == 1.0 for row in result["reports"])
    assert all(row["usage"]["model_calls"] == 0 for row in result["reports"])
    assert {row["evaluation"]["native_split"] for row in result["reports"]} == {"transfer"}
    assert '"target"' not in json.dumps(result, sort_keys=True)
