from copy import deepcopy
import json

import pytest

from experiments.orchestration_qualification.search_v3 import (
    _used_statistical_units)

from nexgent.kernel.programs import digest
from nexgent.kernel.store import BudgetExhausted
from nexgent.tasks.evolution import EvolutionService
from nexgent.tasks.generation import GenerationService
from nexgent.tasks.multirole_seed import multirole_package
from nexgent.tasks.orchestration_search import (
    BoundedOrchestrationSearch,
    DevelopmentQualificationError,
    OrchestrationSearchJournal,
    QUALIFICATION_SCHEMA,
    assess_qualification,
    normalize_qualification,
    orchestration_delta,
    paired_episode_budget,
    repair_brief,
)
from nexgent.tasks.orchestration_search_seed import (
    orchestration_search_improver_package)
from nexgent.tasks.package_runner import CapabilityAbort
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ContractError, ToolRegistry


def _child(parent, *, prompt_only=False):
    files = deepcopy(parent["files"])
    manifest = deepcopy(parent["manifest"])
    if prompt_only:
        files["prompts/proposer_a.md"] += "\nCheck the response twice."
    else:
        workflow = json.loads(files["workflows/main.json"])
        proposer_b = next(node for node in workflow["nodes"]
                          if node["id"] == "proposer_b")
        proposer_b["role_ref"] = "proposer_a"
        proposer_b["component_ref"] = "proposer-a-role"
        files["workflows/main.json"] = json.dumps(
            workflow, ensure_ascii=False, sort_keys=True)
    return make_package(files, manifest, parent=parent,
                        provenance={"fixture": "orchestration-search-child"})


def _five_ask_child(parent):
    files = deepcopy(parent["files"])
    workflow = json.loads(files["workflows/main.json"])
    publish = workflow["nodes"].pop()
    workflow["nodes"].extend([
        {"id": "verify", "method": "ask", "role_ref": "adjudicator",
         "component_ref": "adjudicator-role", "params": {"max_tokens": 1600},
         "bindings": {"payload": {"task": {"$node": "prepare"}}}},
        {"id": "final", "method": "ask", "role_ref": "adjudicator",
         "component_ref": "adjudicator-role", "params": {"max_tokens": 1600},
         "bindings": {"payload": {
             "task": {"$node": "prepare"}, "draft": {"$node": "adjudicator"},
             "verification": {"$node": "verify"}}}},
    ])
    publish["bindings"]["payload"]["decision"] = {"$node": "final"}
    workflow["nodes"].append(publish)
    files["workflows/main.json"] = json.dumps(
        workflow, ensure_ascii=False, sort_keys=True)
    return make_package(files, deepcopy(parent["manifest"]), parent=parent,
                        provenance={"fixture": "five-ask-child"})


def _qualification(candidate_id, *, delta=0.0, loaded=True, private=False):
    row = {
        "statistical_unit_id": "public-suite/unit-1",
        "parent_status": "completed", "candidate_status": "completed",
        "parent_score_available": True, "candidate_score_available": True,
        "parent_score": 0.25, "candidate_score": 0.25 + delta,
        "activation_loaded": loaded, "artifact_contract_valid": True,
    }
    if private:
        row["evaluator_explanation"] = "must never cross the host boundary"
    return {
        "schema": QUALIFICATION_SCHEMA, "candidate_id": candidate_id,
        "tasks": [row],
        "usage": {"model_calls": 2, "completion_tokens": 20,
                  "tool_calls": 0, "nodes": 8, "usage_complete": True},
        "evidence_refs": {"plan_id": "plan-1", "trial_id": "trial-1"},
    }


def test_orchestration_delta_rejects_prompt_only_candidate_and_detects_role_graph_change():
    parent = multirole_package()

    prompt_only = orchestration_delta(parent, _child(parent, prompt_only=True))
    graph_change = orchestration_delta(parent, _child(parent))

    assert prompt_only["changed"] is False
    assert prompt_only["parent_projection_digest"] == prompt_only["candidate_projection_digest"]
    assert graph_change["changed"] is True
    assert graph_change["parent_projection_digest"] != graph_change["candidate_projection_digest"]


def test_orchestration_delta_ignores_unreachable_registered_workflow():
    parent = multirole_package()
    files = deepcopy(parent["files"])
    manifest = deepcopy(parent["manifest"])
    files["workflows/orphan.json"] = files["workflows/main.json"]
    manifest["workflows"]["orphan"] = {
        "ref": "workflows/orphan.json", "max_parallel": 1,
        "input_schema": {"type": "object"}, "output_schema": {"type": "object"}}
    manifest["components"]["orphan-workflow"] = {
        "class": "O", "kind": "workflow", "ref": "orphan"}
    child = make_package(files, manifest, parent=parent,
                         provenance={"fixture": "unreachable-orchestration"})

    assert orchestration_delta(parent, child)["changed"] is False


def test_paired_budget_uses_more_expensive_reachable_workflow_for_both_arms():
    parent = multirole_package()
    child = _five_ask_child(parent)

    estimate = paired_episode_budget(parent, child)

    assert estimate["arms"]["parent"]["model_calls"] == 3
    assert estimate["arms"]["parent"]["completion_tokens"] == 4800
    assert estimate["arms"]["candidate"]["model_calls"] == 5
    assert estimate["arms"]["candidate"]["completion_tokens"] == 8000
    assert estimate["episode_budget"]["max_model_calls"] == 5
    assert estimate["episode_budget"]["max_completion_tokens"] == 8000


def test_paired_budget_fails_closed_for_dynamic_delegation():
    parent = multirole_package()
    files = deepcopy(parent["files"])
    workflow = json.loads(files["workflows/main.json"])
    proposer = next(node for node in workflow["nodes"] if node["id"] == "proposer_a")
    proposer["method"] = "delegate"
    files["workflows/main.json"] = json.dumps(workflow, sort_keys=True)
    child = make_package(files, deepcopy(parent["manifest"]), parent=parent,
                         provenance={"fixture": "dynamic-delegate"})

    with pytest.raises(ContractError, match="no package-static"):
        paired_episode_budget(parent, child)


def test_restarted_search_excludes_units_from_every_prior_benchmark_episode():
    class Store:
        def list(self):
            return [{"id": "development"}, {"id": "selection"}, {"id": "plain"}]

        def benchmark_registration(self, identity):
            return {
                "development": {"task_ref": {"statistical_unit_id": "unit-dev"}},
                "selection": {"task_ref": {"statistical_unit_id": "unit-selection"}},
                "plain": None,
            }[identity]

    class Tasks:
        store = Store()

    assert _used_statistical_units(Tasks()) == {"unit-dev", "unit-selection"}


def test_development_projection_rejects_private_evaluator_fields_and_builds_bounded_repair():
    with pytest.raises(ContractError, match="unknown task fields"):
        normalize_qualification("candidate-1", _qualification("candidate-1", private=True))

    projected = normalize_qualification(
        "candidate-1", _qualification("candidate-1", delta=-0.1, loaded=False))
    assessment = assess_qualification(projected, minimum_mean_delta=0.0)
    brief = repair_brief(1, assessment)

    assert assessment["eligible_for_selection"] is False
    assert assessment["failure_codes"] == [
        "development_quality_below_floor", "orchestration_not_loaded"]
    assert set(brief) == {"schema", "prior_attempt", "failure_codes",
                          "mean_quality_delta", "instruction"}
    assert "statistical_unit_id" not in json.dumps(brief)


def test_search_journal_is_append_only_and_digest_chained(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    journal = OrchestrationSearchJournal(tasks.store)
    first = journal.append("search-1", "started", {
        "channel": "general", "feedback_bundle_id": "feedback-1", "budget": 2})
    assert journal.open_searches("general", "feedback-1") == ["search-1"]
    second = journal.append("search-1", "finished", {"status": "exhausted"})
    assert journal.open_searches("general", "feedback-1") == []

    assert first["sequence"] == 0
    assert second["previous_digest"] == first["record_digest"]
    assert [event["kind"] for event in journal.events("search-1")] == [
        "started", "finished"]

    with tasks.store.connect() as db:
        db.execute(
            "UPDATE task_orchestration_search_events SET data=? "
            "WHERE search_id=? AND sequence=0", ("{}", "search-1"))
    with pytest.raises(ContractError, match="chain is invalid"):
        journal.events("search-1")


def test_interrupted_search_can_only_be_closed_as_nonretryable_missing_evidence(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    evolution = EvolutionService(tasks)
    GenerationService(tasks, evolution)
    journal = OrchestrationSearchJournal(tasks.store)
    parent, child = multirole_package(), None
    child = _child(parent)
    improver = orchestration_search_improver_package(
        attempt_id="search-1/attempt-1")
    for package in (parent, child, improver):
        tasks.store.put_package(package)
    episodes = [tasks.create(
        "Frozen reconciliation fixture", package=package,
        deliverables=[{"name": "answer", "schema": {}}],
        context={"split": "development", "split_role": "development",
                 "evolution_registration": {"plan_id": "plan-1"}})
        for package in (parent, child)]
    generation = {
        "id": "generation-1", "status": "generated", "channel": "general",
        "feedback_bundle_id": "feedback-1",
        "parent_package_id": parent["id"],
        "parent_package_digest": parent["digest"],
        "candidate_id": "candidate-1", "candidate_package_id": child["id"],
        "candidate_package_digest": child["digest"],
        "improver_package_id": improver["id"],
        "usage": {"model_calls": 1, "charged_completion_tokens": 10,
                  "tool_calls": 0, "nodes": 2, "usage_complete": True},
    }
    plan = {
        "id": "plan-1", "candidate_id": "candidate-1", "channel": "general",
        "parent_package_id": parent["id"],
        "parent_package_digest": parent["digest"],
        "package_id": child["id"], "package_digest": child["digest"],
        "split_role": "development",
        "suite": {"split_role": "development"},
    }
    with tasks.store.connect() as db:
        db.execute("INSERT INTO task_candidate_generations VALUES(?,?,?)", (
            generation["id"], json.dumps(generation, sort_keys=True,
                                          separators=(",", ":")),
            digest(generation)))
        db.execute("INSERT INTO task_evolution_plans VALUES(?,?,?)", (
            plan["id"], json.dumps(plan, sort_keys=True, separators=(",", ":")),
            digest(plan)))
        forged = {**plan, "id": "plan-forged", "candidate_id": "candidate-other"}
        db.execute("INSERT INTO task_evolution_plans VALUES(?,?,?)", (
            forged["id"], json.dumps(forged, sort_keys=True, separators=(",", ":")),
            digest(forged)))
    journal.append("search-1", "started", {
        "channel": "general", "feedback_bundle_id": "feedback-1"})
    journal.append("search-1", "attempt_started", {
        "attempt": 1, "attempt_id": "search-1/attempt-1"})

    failure = {
        "failure_type": "BudgetExhausted",
        "evidence_refs": {"plan_id": "plan-1", "trial_id": None,
                          "episode_ids": [episode["id"] for episode in episodes]},
        "episode_statuses": {episode["id"]: episode["status"] for episode in episodes},
        "usage": {"model_calls": 0, "completion_tokens": 0,
                  "tool_calls": 0, "nodes": 0, "usage_complete": False},
    }
    forged_failure = deepcopy(failure)
    forged_failure["evidence_refs"]["plan_id"] = "plan-forged"
    with pytest.raises(ContractError, match="not bound"):
        journal.finalize_failed("search-1", forged_failure)

    result = journal.finalize_failed("search-1", failure)

    assert result["status"] == "failed"
    assert result["retry_safe"] is False
    assert journal.open_searches("general", "feedback-1") == []
    failed = next(event for event in result["events"]
                  if event["kind"] == "attempt_failed")
    assert failed["content"]["failure"]["generation_refs"] == {
        "generation_id": "generation-1", "candidate_id": "candidate-1"}
    assert failed["content"]["failure"]["usage"]["usage_complete"] is False
    assert failed["content"]["usage"] == {
        "model_calls": 1, "completion_tokens": 10, "tool_calls": 0, "nodes": 2}


def test_search_improver_freezes_repair_and_attempt_identity():
    repair = {"schema": "nexgent.orchestration-repair-brief.v1",
              "prior_attempt": 1,
              "failure_codes": ["no_executable_orchestration_delta"],
              "mean_quality_delta": None,
              "instruction": "Change the reachable execution graph."}
    package = orchestration_search_improver_package(
        repair, attempt_id="search-1/attempt-2")

    assert json.loads(package["files"]["repair_context.json"]) == repair
    assert package["provenance"]["search_attempt_id"] == "search-1/attempt-2"
    assert package["manifest"]["entries"]["improve"] == "improver.py:improve"


def test_host_interrupt_cannot_leave_workflow_episode_running(tmp_path):
    class InterruptGatewayFactory:
        def __call__(self, reserve, stop_event):
            class Gateway:
                def ask(self, role, prompt, payload=None, max_tokens=4000):
                    raise KeyboardInterrupt("controlled host stop")
            return Gateway()

    service = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=InterruptGatewayFactory())
    state = service.create(
        "Exercise interruption persistence", package=multirole_package(),
        deliverables=[{"name": "answer", "schema": {}}],
        budget={"max_model_calls": 3, "max_completion_tokens": 4800,
                "max_tool_calls": 0, "max_nodes": 30})

    with pytest.raises(KeyboardInterrupt, match="controlled host stop"):
        service.run(state["id"])

    current = service.get_private(state["id"])
    assert current["status"] == "paused"
    assert current["failure_domain"] == "infrastructure"
    assert current["last_error"] == "KeyboardInterrupt: controlled host stop"
    assert current["events"][-1]["kind"] == "episode_finished"
    assert current["events"][-1]["content"]["status"] == "paused"


def test_capability_budget_abort_cannot_leave_workflow_episode_running(tmp_path):
    class BudgetGatewayFactory:
        def __call__(self, reserve, stop_event):
            class Gateway:
                def ask(self, role, prompt, payload=None, max_tokens=4000):
                    raise CapabilityAbort(BudgetExhausted(
                        "Root Episode model-call budget exhausted"))
            return Gateway()

    service = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=BudgetGatewayFactory())
    state = service.create(
        "Exercise capability-abort persistence", package=multirole_package(),
        deliverables=[{"name": "answer", "schema": {}}],
        budget={"max_model_calls": 3, "max_completion_tokens": 4800,
                "max_tool_calls": 0, "max_nodes": 30})

    result = service.run(state["id"])

    assert result["status"] == "failed"
    assert result["failure_domain"] == "agent"
    assert result["last_error"] == (
        "BudgetExhausted: Root Episode model-call budget exhausted")
    assert result["events"][-1]["kind"] == "episode_finished"
    assert result["events"][-1]["content"]["status"] == "failed"


class _Evolution:
    def __init__(self, parent, candidates):
        self.parent = parent
        self.candidates = candidates

    def active(self, channel):
        return {"revision": 0, "package_id": self.parent["id"],
                "package_digest": self.parent["digest"], "package": self.parent}

    def candidate(self, identity):
        return deepcopy(self.candidates[identity])

    def _verify_generated_candidate(self, candidate):
        return {"candidate_id": candidate["id"]}


class _Generation:
    def __init__(self, records):
        self.records = records

    def feedback(self, identity):
        return {"id": identity, "channel": "general", "channel_revision": 0,
                "parent_package_digest": next(iter(self.records.values()))[
                    "parent_package_digest"]}

    def generation(self, identity):
        return deepcopy(self.records[identity])


def _generation(identity, parent, child, candidate_id):
    return {
        "id": identity, "status": "generated", "channel": "general",
        "channel_revision": 0, "feedback_bundle_id": "feedback-1",
        "parent_package_digest": parent["digest"],
        "candidate_id": candidate_id, "candidate_package_id": child["id"],
        "candidate_package_digest": child["digest"],
        "usage": {"model_calls": 1, "charged_completion_tokens": 10,
                  "tool_calls": 0, "nodes": 4},
    }


def _candidate(identity, parent, child):
    return {"id": identity, "targeting": "manifest_component_set_v3",
            "parent_package_id": parent["id"],
            "parent_package_digest": parent["digest"],
            "package_id": child["id"], "package_digest": child["digest"],
            "origin": "generated"}


def test_bounded_search_skips_s_only_attempt_then_qualifies_real_o_delta(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    parent = multirole_package()
    s_child, o_child = _child(parent, prompt_only=True), _child(parent)
    for package in (parent, s_child, o_child):
        tasks.store.put_package(package)
    candidates = {
        "candidate-s": _candidate("candidate-s", parent, s_child),
        "candidate-o": _candidate("candidate-o", parent, o_child),
    }
    records = {
        "generation-s": _generation("generation-s", parent, s_child, "candidate-s"),
        "generation-o": _generation("generation-o", parent, o_child, "candidate-o"),
    }
    evolution = _Evolution(parent, candidates)
    generation = _Generation(records)
    service = BoundedOrchestrationSearch(tasks, evolution, generation)
    generation_order = iter([records["generation-s"], records["generation-o"]])
    repairs, qualified = [], []

    def generate(attempt, attempt_id, repair, remaining):
        repairs.append(deepcopy(repair))
        assert attempt_id.endswith(f"attempt-{attempt}")
        return deepcopy(next(generation_order))

    def qualify(candidate, remaining):
        qualified.append(candidate["id"])
        return _qualification(candidate["id"], delta=0.25)

    result = service.run(
        "general", "feedback-1", 0,
        {"max_attempts": 2, "target_qualified": 1,
         "minimum_mean_delta": 0.0, "max_model_calls": 6,
         "max_completion_tokens": 100, "max_tool_calls": 0, "max_nodes": 30},
        generate=generate, qualify=qualify)

    assert result["status"] == "qualified"
    assert result["qualified_candidate_ids"] == ["candidate-o"]
    assert qualified == ["candidate-o"]
    assert repairs[0] is None
    assert repairs[1]["failure_codes"] == ["no_executable_orchestration_delta"]
    assert result["selection_opened"] is False
    attempt_events = [event for event in result["events"]
                      if event["kind"] == "attempt_finished"]
    assert attempt_events[0]["content"]["assessment"]["claim_limit"] == (
        "S-only changes are not O search.")
    assert len([event for event in result["events"]
                if event["kind"] == "attempt_started"]) == 2


def test_qualification_exception_is_terminal_journalled_and_never_retried(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    parent, child = multirole_package(), None
    child = _child(parent)
    for package in (parent, child):
        tasks.store.put_package(package)
    candidate = _candidate("candidate-o", parent, child)
    record = _generation("generation-o", parent, child, "candidate-o")
    service = BoundedOrchestrationSearch(
        tasks, _Evolution(parent, {"candidate-o": candidate}),
        _Generation({"generation-o": record}))
    calls = []

    def generate(attempt, attempt_id, repair, remaining):
        return deepcopy(record)

    def qualify(candidate, remaining):
        calls.append(candidate["id"])
        raise DevelopmentQualificationError({
            "failure_type": "BudgetExhausted",
            "evidence_refs": {"plan_id": "plan-1", "trial_id": None,
                              "episode_ids": ["episode-parent", "episode-candidate"]},
            "episode_statuses": {"episode-parent": "completed",
                                 "episode-candidate": "running"},
            "usage": {"model_calls": 3, "completion_tokens": 30,
                      "tool_calls": 0, "nodes": 7, "usage_complete": False},
        })

    result = service.run(
        "general", "feedback-1", 0,
        {"max_attempts": 3, "target_qualified": 1,
         "minimum_mean_delta": 0.0, "max_model_calls": 10,
         "max_completion_tokens": 100, "max_tool_calls": 0, "max_nodes": 30},
        generate=generate, qualify=qualify)

    assert result["status"] == "failed"
    assert result["retry_safe"] is False
    assert result["selection_opened"] is False
    assert calls == ["candidate-o"]
    failed = next(event for event in result["events"]
                  if event["kind"] == "attempt_failed")
    assert failed["content"]["failure"]["failure_type"] == "BudgetExhausted"
    assert failed["content"]["failure"]["evidence_refs"]["plan_id"] == "plan-1"
    assert failed["content"]["failure"]["usage"]["usage_complete"] is False
    assert service.journal.open_searches("general", "feedback-1") == []
