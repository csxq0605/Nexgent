from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexgent.kernel.programs import digest
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.studies import RSIStudyService, StudyPolicy, TaskStudyExecutor
from nexgent.tasks.tools import ContractError, ToolRegistry, ToolSpec


BUDGET = {
    "max_model_calls": 0, "max_completion_tokens": 0,
    "max_tool_calls": 0, "max_nodes": 4,
}


def package(score):
    source = (
        "def execute(payload, context):\n"
        f"    artifact = context.publish({{'score': {score}}}, name='result')\n"
        "    return {'deliverables': {'result': artifact['id']}}\n"
    )
    return make_package(
        {"behavior.py": source}, {"entries": {"execute": "behavior.py:execute"}},
        provenance={"fixture": f"study-{score}"})


def leak_probe_package():
    source = (
        "def execute(payload, context):\n"
        "    leaked = 'MUST_NOT_ENTER_STUDY_EPISODE' in str(payload)\n"
        "    artifact = context.publish({'score': -1.0 if leaked else 0.8}, name='result')\n"
        "    return {'deliverables': {'result': artifact['id']}}\n"
    )
    return make_package(
        {"behavior.py": source}, {"entries": {"execute": "behavior.py:execute"}},
        provenance={"fixture": "study-leak-probe"})


def failing_package():
    return make_package(
        {"behavior.py": "def execute(payload, context):\n    raise ValueError('observed failure')\n"},
        {"entries": {"execute": "behavior.py:execute"}},
        provenance={"fixture": "study-observed-failure"})


class HoldoutBenchmark:
    id = "holdout-pilot"

    def snapshot(self):
        return {"id": self.id, "version": "1", "evaluator_digest": "holdout-v1",
                "private_canary": "MUST_NOT_ENTER_STUDY_EPISODE"}

    def tasks(self, split="final_holdout", seed=0):
        assert split == "final_holdout"
        return [{
            "id": f"{split}/{seed}", "objective": "Return the package score",
            "statistical_unit_id": f"unit/{seed}", "cluster_id": f"origin/{seed}",
            "inputs": {"seed": seed},
            "deliverables": [{"name": "result", "schema": {
                "type": "object", "required": ["score"],
                "properties": {"score": {"type": "number"}},
            }}],
            "capabilities": [], "context": {"split": split, "seed": seed},
        }]

    def evaluate(self, task_ref, deliverables, execution_view):
        score = float(deliverables["result"]["score"])
        return {"status": "accepted" if score >= 0.5 else "rejected",
                "score_available": True, "score": score,
                "accepted": score >= 0.5,
                "private_answer": "MUST_NOT_ENTER_STUDY_PLAN"}


def test_confirmatory_study_runs_real_paired_holdout_episodes(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    studies = RSIStudyService(tasks, HoldoutBenchmark())
    baseline, candidate = package(0.2), package(0.8)
    plan = studies.create_plan(
        arms={"fixed": baseline, "rsi": candidate},
        baseline_arm="fixed", candidate_arm="rsi", split="final_holdout",
        seeds=[11, 12, 13, 14, 15, 16], episode_budget=BUDGET,
        provider="none", model="none", require_model_calls=False,
        policy=StudyPolicy(min_quality_delta=0.05, min_success_delta=0.5,
                           max_work_proxy_ratio=1.0, max_regressions=0,
                           min_complete_pairs=6))
    run = studies.run(plan["id"])
    report = studies.assess(run["id"])

    assert run["measurement_complete"] is True
    assert len(run["cells"]) == 12
    assert report["complete_pair_count"] == 6
    assert report["metrics"]["mean_quality_delta"] == pytest.approx(0.6)
    assert report["metrics"]["mean_success_delta"] == 1.0
    assert report["metrics"]["regressions"] == 0
    assert report["engineering_acceptance"] is True
    assert report["statistical_support"] is True
    assert report["version_scope"] == "none"
    assert report["claim_scope"] == "benchmark_local_deterministic_superiority_supported"
    assert report["independent_cluster_count"] == 6
    assert report["metrics"]["quality_interval"] == pytest.approx([0.6, 0.6])
    assert report["metrics"]["paired_sign_flip_p"] == pytest.approx(0.03125)

    for cell in run["cells"]:
        episode = tasks.get(cell["episode_id"])
        assert episode["package_digest"] == cell["package_digest"]
        assert episode["task"]["context"]["split_role"] == "final_holdout"
        assert episode["task"]["context"]["memory_writeback"] is False
        assert "MUST_NOT_ENTER_STUDY_EPISODE" not in str(episode["task"])
        assert "benchmark_registration" not in episode["task"]["context"]
        registration = tasks.store.benchmark_registration(episode["id"])
        assert registration["snapshot"]["private_canary"] == "MUST_NOT_ENTER_STUDY_EPISODE"
        snapshot = tasks.store.memory_snapshot(
            episode["memory_snapshot_id"], episode["id"])
        assert snapshot["items"] == []
        assert any(event["kind"] == "benchmark_evaluated"
                   for event in episode["events"])

    episode_count = len(tasks.list())
    assert studies.run(plan["id"])["id"] == run["id"]
    assert studies.assess(run["id"])["id"] == report["id"]
    assert len(tasks.list()) == episode_count


def test_confirmatory_study_rejects_non_holdout_and_identical_arms(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    studies = RSIStudyService(tasks, HoldoutBenchmark())
    first, second = package(0.2), package(0.8)
    kwargs = dict(
        arms={"fixed": first, "rsi": second}, baseline_arm="fixed",
        candidate_arm="rsi", seeds=[1, 2], episode_budget=BUDGET,
        provider="none", model="none", require_model_calls=False,
        policy=StudyPolicy(min_complete_pairs=2))
    with pytest.raises(ContractError, match="final_holdout"):
        studies.create_plan(split="selection", **kwargs)
    with pytest.raises(ContractError, match="distinct"):
        studies.create_plan(
            split="final_holdout", **{**kwargs, "arms": {"fixed": first, "rsi": first}})


def test_study_plan_binds_benchmark_and_package_digests(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    studies = RSIStudyService(tasks, HoldoutBenchmark())
    baseline, candidate = package(0.1), package(0.9)
    plan = studies.create_plan(
        arms={"a": baseline, "b": candidate}, baseline_arm="a",
        candidate_arm="b", split="final_holdout", seeds=[1, 2],
        episode_budget=BUDGET, provider="none", model="none",
        require_model_calls=False, policy=StudyPolicy(min_complete_pairs=2))
    protocol = {key: plan[key] for key in (
        "benchmark_id", "benchmark_snapshot", "split", "seeds", "tasks", "arms",
        "baseline_arm", "candidate_arm", "episode_budget", "provider", "model",
            "resolved_model", "model_profile_digest", "require_model_calls", "policy",
            "expected_observed_model", "expected_provider_revision",
            "outcome_policy",
            "adapter_fingerprint", "execution_environment", "execution_environment_digest",
        "model_version_binding", "statistics")}
    assert plan["protocol_digest"] == digest(protocol)
    assert plan["arms"]["a"]["package_digest"] == baseline["digest"]
    assert plan["arms"]["b"]["package_digest"] == candidate["digest"]


def test_private_snapshot_is_not_visible_to_malicious_arm(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    studies = RSIStudyService(tasks, HoldoutBenchmark())
    plan = studies.create_plan(
        arms={"fixed": package(0.2), "probe": leak_probe_package()},
        baseline_arm="fixed", candidate_arm="probe", split="final_holdout",
        seeds=[1, 2], episode_budget=BUDGET, provider="none", model="none",
        require_model_calls=False, policy=StudyPolicy(min_complete_pairs=2))
    run = studies.run(plan["id"])
    probe = [cell for cell in run["cells"] if cell["arm"] == "probe"]
    assert [cell["score"] for cell in probe] == [0.8, 0.8]
    assert all("MUST_NOT_ENTER_STUDY_EPISODE" not in str(
        tasks.get(cell["episode_id"])["task"]) for cell in probe)


def test_study_rejects_evaluator_replacement_after_registration(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    studies = RSIStudyService(tasks, HoldoutBenchmark())
    plan = studies.create_plan(
        arms={"a": package(0.2), "b": package(0.8)}, baseline_arm="a",
        candidate_arm="b", split="final_holdout", seeds=[1, 2],
        episode_budget=BUDGET, provider="none", model="none",
        require_model_calls=False, policy=StudyPolicy(min_complete_pairs=2))
    studies._executor = TaskStudyExecutor(tasks, HoldoutBenchmark())
    with pytest.raises(ContractError, match="authority changed"):
        studies.run(plan["id"])
    assert tasks.list() == []


def test_study_cell_binding_and_runner_claim_are_fail_closed(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    studies = RSIStudyService(tasks, HoldoutBenchmark())
    plan = studies.create_plan(
        arms={"a": package(0.2), "b": package(0.8)}, baseline_arm="a",
        candidate_arm="b", split="final_holdout", seeds=[1, 2],
        episode_budget=BUDGET, provider="none", model="none",
        require_model_calls=False, policy=StudyPolicy(min_complete_pairs=2))
    owner, prior = studies._claim(plan["id"])
    assert prior is None
    with pytest.raises(ContractError, match="already running"):
        studies.run(plan["id"])
    scheduled = plan["schedule"][0]
    cell, created = studies._reserve_cell(plan, scheduled, owner)
    assert created is True
    cell["package_digest"] = "0" * 64
    with tasks.store.connect() as db:
        db.execute("UPDATE task_rsi_study_cells SET data=? WHERE id=?",
                   (studies._encode(cell), cell["id"]))
    studies._pause(plan["id"], owner)
    with pytest.raises(ContractError, match="differs from its frozen plan"):
        studies.run(plan["id"])
    assert tasks.list() == []


def test_holdout_units_cannot_be_registered_twice(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    studies = RSIStudyService(tasks, HoldoutBenchmark())
    common = dict(baseline_arm="a", candidate_arm="b", split="final_holdout",
                  seeds=[1, 2], episode_budget=BUDGET, provider="none", model="none",
                  require_model_calls=False, policy=StudyPolicy(min_complete_pairs=2))
    studies.create_plan(arms={"a": package(0.1), "b": package(0.8)}, **common)
    with pytest.raises(ContractError, match="already registered"):
        studies.create_plan(arms={"a": package(0.2), "b": package(0.9)}, **common)


class DuplicateTaskBenchmark(HoldoutBenchmark):
    id = "duplicate-holdout"

    def tasks(self, split="final_holdout", seed=0):
        task = super().tasks(split=split, seed=0)[0]
        task["context"]["seed"] = 0
        task["inputs"]["seed"] = 0
        return [task]


def test_duplicate_task_digests_cannot_create_fake_sample_size(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    studies = RSIStudyService(tasks, DuplicateTaskBenchmark())
    with pytest.raises(ContractError, match="payloads must be unique"):
        studies.create_plan(
            arms={"a": package(0.2), "b": package(0.8)}, baseline_arm="a",
            candidate_arm="b", split="final_holdout", seeds=[1, 2],
            episode_budget=BUDGET, provider="none", model="none",
            require_model_calls=False, policy=StudyPolicy(min_complete_pairs=2))


class SharedClusterBenchmark(HoldoutBenchmark):
    id = "shared-cluster-holdout"

    def tasks(self, split="final_holdout", seed=0):
        task = super().tasks(split=split, seed=seed)[0]
        task["cluster_id"] = "same-origin"
        return [task]


def test_seed_variants_cannot_fake_independent_cluster_count(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    studies = RSIStudyService(tasks, SharedClusterBenchmark())
    with pytest.raises(ContractError, match="independent clusters"):
        studies.create_plan(
            arms={"a": package(0.2), "b": package(0.8)}, baseline_arm="a",
            candidate_arm="b", split="final_holdout", seeds=[1, 2, 3, 4, 5, 6],
            episode_budget=BUDGET, provider="none", model="none",
            require_model_calls=False, policy=StudyPolicy(min_complete_pairs=2))


def test_study_policy_separates_superiority_and_noninferiority():
    with pytest.raises(ContractError, match="Superiority margins"):
        StudyPolicy(min_quality_delta=-0.1).normalized()
    assert StudyPolicy(estimand="noninferiority", min_quality_delta=-0.1,
                       min_success_delta=-0.1).normalized()["estimand"] == "noninferiority"


def test_mutating_adapter_state_after_registration_fails_closed(tmp_path):
    class StatefulBenchmark(HoldoutBenchmark):
        id = "stateful-holdout"

        def __init__(self):
            self.threshold = 0.5

        def evaluate(self, task_ref, deliverables, execution_view):
            score = float(deliverables["result"]["score"])
            return {"status": "accepted" if score >= self.threshold else "rejected",
                    "score_available": True, "score": score,
                    "accepted": score >= self.threshold}

    adapter = StatefulBenchmark()
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    studies = RSIStudyService(tasks, adapter)
    plan = studies.create_plan(
        arms={"a": package(0.2), "b": package(0.8)}, baseline_arm="a",
        candidate_arm="b", split="final_holdout", seeds=[1, 2],
        episode_budget=BUDGET, provider="none", model="none",
        require_model_calls=False, policy=StudyPolicy(min_complete_pairs=2))
    adapter.threshold = 0.9
    # The study owns a deep-frozen evaluator copy; caller mutation cannot alter it.
    assert studies.run(plan["id"])["measurement_complete"] is True
    studies._executor.adapter.threshold = 0.1
    with pytest.raises(ContractError, match="evaluator changed"):
        studies._trusted_executor(plan)


def test_agent_execution_failure_is_observed_zero_not_missing(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    studies = RSIStudyService(tasks, HoldoutBenchmark())
    plan = studies.create_plan(
        arms={"failed": failing_package(), "candidate": package(0.8)},
        baseline_arm="failed", candidate_arm="candidate", split="final_holdout",
        seeds=[1, 2], episode_budget=BUDGET, provider="none", model="none",
        require_model_calls=False, policy=StudyPolicy(min_complete_pairs=2))
    run = studies.run(plan["id"])
    failures = [cell for cell in run["cells"] if cell["arm"] == "failed"]
    assert [(cell["status"], cell["score"], cell["accepted"], cell["failure_class"])
            for cell in failures] == [
                ("measured", 0.0, False, "observed_system_failure"),
                ("measured", 0.0, False, "observed_system_failure")]
    report = studies.assess(run["id"])
    assert report["missing"] == []
    assert report["complete_pair_count"] == 2


def test_infrastructure_failure_stays_missing_and_is_not_aggregated(tmp_path):
    tool = ToolSpec(
        "study.infrastructure", {"type": "object"}, {"type": "object"}, "read",
        lambda arguments, context: (_ for _ in ()).throw(
            RuntimeError("host infrastructure unavailable")))
    tasks = TaskService(tmp_path, tools=ToolRegistry([tool]))

    class InfrastructureBenchmark(HoldoutBenchmark):
        id = "infrastructure-holdout"

        def tasks(self, split="final_holdout", seed=0):
            rows = super().tasks(split=split, seed=seed)
            rows[0]["capabilities"] = [tool.name]
            return rows

    infrastructure_package = make_package(
        {"behavior.py": (
            "def execute(payload, context):\n"
            "    context.tool('study.infrastructure', {})\n"
            "    return {'deliverables': {}}\n")},
        {"entries": {"execute": "behavior.py:execute"}},
        provenance={"fixture": "study-infrastructure-failure"})
    studies = RSIStudyService(tasks, InfrastructureBenchmark())
    budget = {**BUDGET, "max_tool_calls": 1}
    plan = studies.create_plan(
        arms={"missing": infrastructure_package, "candidate": package(0.8)},
        baseline_arm="missing", candidate_arm="candidate", split="final_holdout",
        seeds=[1, 2], episode_budget=budget, provider="none", model="none",
        require_model_calls=False, policy=StudyPolicy(min_complete_pairs=2))

    run = studies.run(plan["id"])
    missing = [cell for cell in run["cells"] if cell["arm"] == "missing"]
    assert [(cell["status"], cell["score"], cell["accepted"], cell["failure_class"])
            for cell in missing] == [
                ("missing", None, None, "infrastructure_missing"),
                ("missing", None, None, "infrastructure_missing"),
            ]
    report = studies.assess(run["id"])
    assert report["complete_pair_count"] == 0
    assert len(report["missing"]) == 2
    assert report["metrics"]["mean_quality_delta"] is None
    assert report["gates"]["complete_pairs"] is False
