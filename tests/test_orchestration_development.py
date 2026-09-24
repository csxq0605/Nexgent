import json
import sqlite3

import pytest

from nexgent.tasks.benchmarks import BenchmarkDescriptor
from nexgent.tasks.orchestration_development import (
    DevelopmentOrchestrationQualifier, public_task_fingerprint,
)
from nexgent.tasks.orchestration_search import DevelopmentQualificationError
from nexgent.tasks.tools import ContractError


CAP = {"max_model_calls": 2, "max_completion_tokens": 100,
       "max_tool_calls": 1, "max_nodes": 10}
REMAINING = {"model_calls": 4, "completion_tokens": 200,
             "tool_calls": 2, "nodes": 20}


class Adapter:
    id = "installed-development"
    descriptor = BenchmarkDescriptor(
        id=id, version="1", title="Installed development fixture",
        splits=("development",), default_split="development",
        allowed_suite_roles=("qualification",))

    def __init__(self, unit="unit-new"):
        self.unit = unit
        self.snapshot_value = {"dataset": "frozen-v1"}

    def describe(self):
        return {"id": self.id}

    def snapshot(self):
        return dict(self.snapshot_value)

    def tasks(self, split, seed, **options):
        assert split == "development"
        return [{"id": "task-1", "objective": "Solve the public task",
                 "statistical_unit_id": self.unit, "inputs": {},
                 "context": {}, "constraints": {}, "deliverables": [],
                 "capabilities": []}]

    def evaluate(self, task_ref, deliverables, execution_view):
        raise AssertionError("Fake Evolution owns evaluation")


class SeededAdapter(Adapter):
    def tasks(self, split, seed, **options):
        self.unit = f"unit-{seed}"
        return super().tasks(split, seed, **options)


class OrdinarySourceAdapter(Adapter):
    def tasks(self, split, seed, **options):
        value = 11 if seed == 11 else seed
        return [{"id": f"task-{seed}", "objective": "Inspect the case",
                 "statistical_unit_id": f"unit-{seed}",
                 "inputs": {"case": {"value": value}},
                 "deliverables": [{"name": "result", "schema": {
                     "type": "object"}}],
                 "constraints": {"mode": "strict"}, "context": {},
                 "capabilities": [],
                 "_evaluation": {"hidden_answer": f"secret-{seed}"}}]


class Store:
    def __init__(self, path):
        self.path = path
        self.states = []
        self.registrations = {}
        self.packages = {"parent": {"id": "parent"}, "child": {"id": "child"}}
        self.artifacts = {}

    def connect(self):
        return sqlite3.connect(self.path)

    def list(self):
        return list(self.states)

    def benchmark_registration(self, identity):
        return self.registrations.get(identity)

    def package(self, identity):
        return self.packages[identity]

    def read(self, ref, episode_id):
        return self.artifacts[ref]


class Tasks:
    def __init__(self, path):
        self.store = Store(path)
        self.private = {}

    def get_private(self, identity):
        return self.private[identity]


class Evolution:
    def __init__(self, tasks, candidate, *, fail=False):
        self.tasks = tasks
        values = candidate if isinstance(candidate, list) else [candidate]
        self.candidate_values = {value["id"]: value for value in values}
        self.fail = fail
        self.plan_calls = []
        self.run_calls = 0

    def candidate(self, identity):
        return dict(self.candidate_values[identity])

    def plan_pair(self, candidate_id, adapter, *, split, split_role, seed,
                  budget, policy, capability_authority, **options):
        self.plan_calls.append({"split": split, "split_role": split_role,
                                "budget": dict(budget), "seed": seed})
        preview = adapter.tasks(split=split, seed=seed, **options)
        return {"id": "plan-1", "budget": dict(budget),
                "suite": {"snapshot": adapter.snapshot(), "tasks": preview,
                          "split": split, "split_role": split_role}}

    def run_pair(self, plan_id, adapter, *, stop_event=None):
        self.run_calls += 1
        suffix = str(self.run_calls)
        parent_id, child_id = "episode-parent-" + suffix, "episode-child-" + suffix
        usage = {"model_calls": 1, "charged_completion_tokens": 25,
                 "tool_calls": 0, "nodes": 3, "usage_complete": True}
        self.tasks.store.states.extend([
            {"id": parent_id, "status": "completed",
             "task": {"context": {"evolution_registration": {
                 "plan_id": plan_id, "split_role": "development"}}}},
            {"id": child_id, "status": "completed",
             "task": {"context": {"evolution_registration": {
                 "plan_id": plan_id, "split_role": "development"}}}},
        ])
        for identity in (parent_id, child_id):
            self.tasks.store.registrations[identity] = {
                "benchmark_id": Adapter.id,
                "task_ref": {"statistical_unit_id": adapter.unit}}
        self.tasks.private.update({
            parent_id: {"id": parent_id, "status": "completed",
                        "usage": usage, "outcome": {}},
            child_id: {"id": child_id, "status": "completed",
                       "usage": usage, "outcome": {
                           "delivery_status": "delivered",
                           "schema_validation": "passed"}},
        })
        if self.fail:
            self.tasks.store.states[-1]["status"] = "failed"
            self.tasks.private[child_id]["status"] = "failed"
            raise RuntimeError("private evaluator answer must not escape")
        evaluation = {"score_available": True, "score": 0.75,
                      "hidden_answer": "never project this"}
        return {"id": "trial-1", "plan_id": plan_id, "pairs": [{
            "parent": {"episode_id": parent_id, "usage": usage,
                       "evaluation": evaluation},
            "candidate": {"episode_id": child_id, "usage": usage,
                          "evaluation": evaluation,
                          "loaded_evidence": {"loaded": True,
                                              "private": "not public"}},
        }]}

    def inspect_run_claim(self, kind, plan_id):
        return {"status": "running", "record_id": None}


def candidate():
    return {"id": "candidate-1", "parent_package_id": "parent",
            "package_id": "child", "package_digest": "child-digest",
            "feedback_episode_ids": ["source-episode"]}


def qualifier(tmp_path, monkeypatch, *, adapter=None, fail=False):
    tasks = Tasks(tmp_path / "state.sqlite")
    value = candidate()
    evolution = Evolution(tasks, value, fail=fail)
    adapter = adapter or Adapter()
    monkeypatch.setattr(
        "nexgent.tasks.orchestration_development.paired_episode_budget",
        lambda parent, child, development_episode_budget=None: {
            "arms": {"parent": {}, "candidate": {}},
            "episode_budget": dict(CAP)})
    service = DevelopmentOrchestrationQualifier(
        tasks, evolution, adapter, snapshot=adapter.snapshot(), seed=7,
        source_statistical_units=["unit-source"],
        development_episode_budget=CAP)
    return service, tasks, evolution, value


def test_runs_one_equal_budget_pair_and_returns_only_strict_public_projection(
        tmp_path, monkeypatch):
    service, tasks, evolution, value = qualifier(tmp_path, monkeypatch)

    result = service(value, REMAINING)

    assert evolution.plan_calls == [{"split": "development",
                                     "split_role": "development",
                                     "budget": CAP, "seed": 7}]
    assert evolution.run_calls == 1
    assert set(result) == {"schema", "candidate_id", "tasks", "usage",
                           "evidence_refs"}
    assert set(result["tasks"][0]) == {
        "statistical_unit_id", "parent_status", "candidate_status",
        "parent_score_available", "candidate_score_available", "parent_score",
        "candidate_score", "activation_loaded", "artifact_contract_valid"}
    assert "hidden_answer" not in json.dumps(result)
    assert "private" not in json.dumps(result)
    assert result["usage"]["model_calls"] == 2
    assert service(value, REMAINING) == result
    assert evolution.run_calls == 1


@pytest.mark.parametrize("kind", ["source", "development", "selection", "guard"])
def test_rejects_source_and_prior_qualification_unit_reuse(
        tmp_path, monkeypatch, kind):
    service, tasks, evolution, value = qualifier(tmp_path, monkeypatch)
    identity = "source-episode" if kind == "source" else "prior-qualification"
    context = ({} if kind == "source" else {"evolution_registration": {
        "split_role": kind, "plan_id": "old-plan"}})
    tasks.store.states.append({"id": identity, "status": "completed",
                               "task": {"context": context}})
    tasks.store.registrations[identity] = {
        "benchmark_id": Adapter.id,
        "task_ref": {"statistical_unit_id": "unit-new"}}

    message = ("Host-bound source units" if kind == "source" else
               "No fresh development units")
    with pytest.raises(ContractError, match=message):
        service(value, REMAINING)
    assert evolution.plan_calls == []


def test_sequential_candidates_advance_to_fresh_development_seed(
        tmp_path, monkeypatch):
    adapter = SeededAdapter()
    service, tasks, evolution, first = qualifier(
        tmp_path, monkeypatch, adapter=adapter)
    second = {**candidate(), "id": "candidate-2",
              "package_digest": "child-digest-2"}
    evolution.candidate_values[second["id"]] = second

    first_result = service(first, REMAINING)
    second_result = service(second, REMAINING)

    assert [call["seed"] for call in evolution.plan_calls] == [7, 8]
    assert first_result["tasks"][0]["statistical_unit_id"] == "unit-7"
    assert second_result["tasks"][0]["statistical_unit_id"] == "unit-8"


def test_ordinary_source_fingerprint_skips_exact_development_task(
        tmp_path, monkeypatch):
    tasks = Tasks(tmp_path / "ordinary.sqlite")
    value = candidate()
    source_task = {
        "objective": "Inspect the case", "inputs": {"case": {"value": 11}},
        "deliverables": [{"name": "result", "schema": {"type": "object"}}],
        "constraints": {"mode": "strict"}}
    tasks.private["source-episode"] = {
        "id": "source-episode", "task": source_task,
        "input_refs": {"case": "artifact-case"}}
    tasks.store.states.append({
        "id": "source-episode", "status": "completed",
        "task": {"context": {}}})
    tasks.store.artifacts["artifact-case"] = {
        "id": "artifact-case", "content": {"value": 11}}
    evolution = Evolution(tasks, value)
    adapter = OrdinarySourceAdapter()
    monkeypatch.setattr(
        "nexgent.tasks.orchestration_development.paired_episode_budget",
        lambda parent, child, development_episode_budget=None: {
            "arms": {"parent": {}, "candidate": {}},
            "episode_budget": dict(CAP)})
    service = DevelopmentOrchestrationQualifier(
        tasks, evolution, adapter, snapshot=adapter.snapshot(), seed=11,
        source_episode_id="source-episode",
        source_statistical_units=["ordinary:source-episode"],
        development_episode_budget=CAP)

    result = service(value, REMAINING)

    assert evolution.plan_calls[0]["seed"] == 12
    assert result["tasks"][0]["statistical_unit_id"] == "unit-12"
    with tasks.store.connect() as db:
        encoded = db.execute(
            "SELECT data FROM task_orchestration_development_runs").fetchone()[0]
    assert "hidden_answer" not in encoded
    assert "Inspect the case" not in encoded
    assert "artifact-case" not in encoded


def test_public_task_fingerprint_does_not_depend_on_private_evaluation():
    task = OrdinarySourceAdapter().tasks("development", 11)[0]
    changed = {**task, "_evaluation": {"hidden_answer": "different-secret"}}

    assert public_task_fingerprint(task) == public_task_fingerprint(changed)


def test_failed_call_is_sanitized_persisted_and_never_retried(
        tmp_path, monkeypatch):
    service, tasks, evolution, value = qualifier(
        tmp_path, monkeypatch, fail=True)

    with pytest.raises(DevelopmentQualificationError) as first:
        service(value, REMAINING)
    with pytest.raises(DevelopmentQualificationError) as second:
        service(value, REMAINING)

    assert evolution.run_calls == 1
    assert first.value.failure == second.value.failure
    assert first.value.failure["failure_type"] == "RuntimeError"
    assert first.value.failure["retry_safe"] is False
    assert "private evaluator answer" not in json.dumps(first.value.failure)
    with tasks.store.connect() as db:
        encoded, stored_digest = db.execute(
            "SELECT data,digest FROM task_orchestration_development_runs"
        ).fetchone()
    record = json.loads(encoded)
    assert record["status"] == "failed"
    assert record["failure"] == first.value.failure
    assert stored_digest


def test_fails_closed_when_host_bound_snapshot_changes(tmp_path, monkeypatch):
    adapter = Adapter()
    service, _, evolution, value = qualifier(
        tmp_path, monkeypatch, adapter=adapter)
    adapter.snapshot_value = {"dataset": "changed"}

    with pytest.raises(ContractError, match="snapshot changed"):
        service(value, REMAINING)
    assert evolution.plan_calls == []
