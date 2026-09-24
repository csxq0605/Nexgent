from copy import deepcopy
import json

import pytest

from experiments.orchestration_qualification.search_v3 import (
    _qualification as run_qualification,
    _used_statistical_units)

from nexgent.kernel.programs import digest
from nexgent.kernel.store import BudgetExhausted
from nexgent.tasks.evolution import EvolutionService
from nexgent.tasks.generation import (
    GenerationService, _public_patch_error_code, _search_repair)
from nexgent.tasks.multirole_seed import multirole_package
from nexgent.tasks.orchestration_search import (
    BoundedOrchestrationSearch,
    DevelopmentQualificationError,
    OrchestrationSearchJournal,
    QUALIFICATION_SCHEMA,
    SEARCH_SCHEMA,
    assess_qualification,
    normalize_qualification,
    orchestration_delta,
    orchestration_projection,
    paired_episode_budget,
    public_generation_failure_codes,
    repair_brief,
    static_gateway_preflight,
)
from nexgent.tasks.orchestration_search_seed import (
    orchestration_search_improver_package)
from nexgent.tasks.package_runner import CapabilityAbort
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.self_orchestration_seed import self_orchestration_package
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

    with pytest.raises(ContractError, match="explicit development Episode budget"):
        paired_episode_budget(parent, child)


@pytest.mark.parametrize("kind", ["revision", "delegate", "parallel", "external_skill"])
def test_dynamic_graphs_use_one_explicit_runtime_cap_for_both_arms(kind):
    parent = multirole_package()
    files = deepcopy(parent["files"])
    manifest = deepcopy(parent["manifest"])
    workflow = json.loads(files["workflows/main.json"])
    proposer = next(node for node in workflow["nodes"]
                    if node["id"] == "proposer_a")
    if kind == "revision":
        workflow["revision_rules"] = [{
            "id": "replan",
            "after_node": "proposer_a",
            "when": {"path": "$status", "equals": "failed"},
            "planner_role_ref": "proposer_a",
            "planner_max_tokens": 1200,
            "replace_node_ids": ["proposer_b"],
            "max_compile_attempts": 2,
        }]
    elif kind == "delegate":
        proposer["method"] = "delegate"
    elif kind == "parallel":
        proposer.update(method="parallel", role_ref=None, component_ref=None,
                        params={"requests": []})
    else:
        files["skills/prepare.py"] += (
            "\ndef external_work(context):\n"
            "    return context.ask('proposer_a', 'bounded', max_tokens=1)\n")
        manifest["skills"]["prepare"].update(
            allowed_rpc_methods=["ask"], allowed_tools=[])
    files["workflows/main.json"] = json.dumps(workflow, sort_keys=True)
    child = make_package(files, manifest, parent=parent,
                         provenance={"fixture": f"dynamic-{kind}"})
    cap = {"max_model_calls": 8, "max_completion_tokens": 12000,
           "max_tool_calls": 0, "max_nodes": 40}

    estimate = paired_episode_budget(
        parent, child, development_episode_budget=cap)

    assert estimate["episode_budget"] == cap
    assert set(estimate["arms"]) == {"parent", "candidate"}


def test_dynamic_graph_explicit_budget_must_cover_static_paired_arm():
    parent = multirole_package()
    files = deepcopy(parent["files"])
    workflow = json.loads(files["workflows/main.json"])
    workflow["revision_rules"] = [{
        "id": "replan", "after_node": "proposer_a",
        "when": {"path": "$status", "equals": "failed"},
        "planner_role_ref": "proposer_a", "planner_max_tokens": 1600,
        "replace_node_ids": ["proposer_b"],
    }]
    files["workflows/main.json"] = json.dumps(workflow, sort_keys=True)
    child = make_package(files, deepcopy(parent["manifest"]), parent=parent,
                         provenance={"fixture": "dynamic-insufficient"})

    with pytest.raises(ContractError, match="insufficient"):
        paired_episode_budget(parent, child, development_episode_budget={
            "max_model_calls": 2, "max_completion_tokens": 3200,
            "max_tool_calls": 0, "max_nodes": 30,
        })


def test_self_orchestration_seed_is_admitted_under_explicit_runtime_cap():
    package = self_orchestration_package()
    cap = {"max_model_calls": 20, "max_completion_tokens": 80000,
           "max_tool_calls": 20, "max_nodes": 100}

    estimate = paired_episode_budget(
        package, package, development_episode_budget=cap)

    assert estimate == {
        "arms": {"parent": None, "candidate": None},
        "episode_budget": cap,
    }


def test_projection_materializes_task_roles_and_planner_without_prompt_text():
    parent = multirole_package()
    files = deepcopy(parent["files"])
    workflow = json.loads(files["workflows/main.json"])
    workflow["task_roles"] = {
        "specialist": {"identity": "Task specialist",
                       "prompt": "PRIVATE SPECIALIST INSTRUCTION",
                       "capabilities": ["ask"]},
        "planner": {"identity": "Task planner",
                    "prompt": "PRIVATE PLANNER INSTRUCTION",
                    "capabilities": ["ask"]},
    }
    proposer = next(node for node in workflow["nodes"]
                    if node["id"] == "proposer_a")
    proposer["role_ref"] = "task:specialist"
    proposer.pop("component_ref")
    workflow["revision_rules"] = [{
        "id": "replan", "after_node": "proposer_a",
        "when": {"path": "$status", "equals": "failed"},
        "planner_role_ref": "task:planner",
        "replace_node_ids": ["proposer_b"],
    }]
    files["workflows/main.json"] = json.dumps(workflow, sort_keys=True)
    child = make_package(files, deepcopy(parent["manifest"]), parent=parent,
                         provenance={"fixture": "task-role-projection"})

    projected = orchestration_projection(child)
    encoded = json.dumps(projected, sort_keys=True)
    role_refs = [ref for ref in projected["used_roles"]
                 if ref.startswith("task-role://")]
    graph = projected["workflows"]["main-workflow"]["graph"]

    assert len(role_refs) == 2
    assert all(projected["used_roles"][ref]["content_digest"]
               for ref in role_refs)
    assert graph["revision_rules"][0]["planner_role_ref"] in role_refs
    assert "PRIVATE SPECIALIST INSTRUCTION" not in encoded
    assert "PRIVATE PLANNER INSTRUCTION" not in encoded


def test_search_v3_dynamic_qualification_requires_and_freezes_common_cap():
    parent = multirole_package()
    files = deepcopy(parent["files"])
    workflow = json.loads(files["workflows/main.json"])
    next(node for node in workflow["nodes"]
         if node["id"] == "proposer_a")["method"] = "delegate"
    files["workflows/main.json"] = json.dumps(workflow, sort_keys=True)
    child = make_package(files, deepcopy(parent["manifest"]), parent=parent,
                         provenance={"fixture": "qualification-dynamic"})
    task_ref = {"id": "task-1", "objective": "fixture",
                "statistical_unit_id": "unit-1"}
    candidate = {"id": "candidate-1", "parent_package_id": parent["id"],
                 "package_id": child["id"]}
    cap = {"max_model_calls": 4, "max_completion_tokens": 8000,
           "max_tool_calls": 0, "max_nodes": 40}

    class Store:
        def package(self, identity):
            return {parent["id"]: parent, child["id"]: child}[identity]

    class Tasks:
        store = Store()

        @staticmethod
        def get_private(identity):
            return {"id": identity, "status": "completed",
                    "outcome": {"delivery_status": "delivered",
                                "schema_validation": "passed"}}

    class Adapter:
        @staticmethod
        def tasks(**kwargs):
            return [deepcopy(task_ref)]

    class Evolution:
        def __init__(self):
            self.budgets = []

        def plan_pair(self, *args, budget, **kwargs):
            self.budgets.append(deepcopy(budget))
            return {"id": "plan-1", "suite": {"tasks": [deepcopy(task_ref)]}}

        @staticmethod
        def run_pair(identity, adapter):
            usage = {"model_calls": 1, "charged_completion_tokens": 10,
                     "tool_calls": 0, "nodes": 3, "usage_complete": True}
            evaluation = {"score_available": True, "score": 1.0}
            return {"id": "trial-1", "pairs": [{
                "parent": {"episode_id": "parent-episode", "usage": usage,
                           "evaluation": evaluation},
                "candidate": {"episode_id": "candidate-episode", "usage": usage,
                              "evaluation": evaluation,
                              "loaded_evidence": {"loaded": True}},
            }]}

    evolution = Evolution()
    full_remaining = {"model_calls": 8, "completion_tokens": 16000,
                      "tool_calls": 0, "nodes": 80}

    with pytest.raises(DevelopmentQualificationError) as omitted:
        run_qualification(
            Tasks(), evolution, Adapter(), candidate, seed=1, excluded=set(),
            remaining_budget=full_remaining)
    assert omitted.value.failure["failure_type"] == "ContractError"
    assert evolution.budgets == []

    with pytest.raises(DevelopmentQualificationError) as insufficient:
        run_qualification(
            Tasks(), evolution, Adapter(), candidate, seed=1, excluded=set(),
            remaining_budget={**full_remaining, "model_calls": 7},
            development_episode_budget=cap)
    assert insufficient.value.failure["failure_type"] == "InsufficientSearchBudget"
    assert evolution.budgets == []

    result = run_qualification(
        Tasks(), evolution, Adapter(), candidate, seed=1, excluded=set(),
        remaining_budget=full_remaining, development_episode_budget=cap)

    assert evolution.budgets == [cap]
    assert result["candidate_id"] == candidate["id"]
    assert result["usage"]["model_calls"] == 2


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


def test_qualification_rejects_unbounded_candidate_failure_detail():
    value = _qualification("candidate-1")
    value["tasks"][0]["candidate_status"] = "failed"
    value["tasks"][0]["candidate_failure_code"] = "raw private evaluator answer"
    with pytest.raises(ContractError, match="failure code"):
        normalize_qualification("candidate-1", value)


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


def test_generation_validator_codes_reach_repair_without_raw_error_text():
    missing_ids = (
        "PackageError: RuntimeError: ContractError: "
        "behavior_patch/hypothesis: 'component_ids' is a required property")
    assert _public_patch_error_code(missing_ids) == (
        "missing_hypothesis_component_ids")
    assert _public_patch_error_code(missing_ids + " SECRET") is None
    assert _public_patch_error_code(
        "ContractError: PackagePatch replacement must not include path") == (
            "replacement_forbids_path")
    assert _public_patch_error_code(
        "ContractError: PackagePatch replacement must not include path SECRET") \
        is None

    record = {"status": "missing", "reason_type": "PackageError",
              "reason": missing_ids + " raw private payload",
              "public_patch_error_code": "missing_hypothesis_component_ids"}
    codes = ["generation_PackageError", *public_generation_failure_codes(record)]
    brief = repair_brief(1, {"failure_codes": codes,
                             "mean_quality_delta": None})
    _, accepted, _ = _search_repair(
        "orchestration-search-test/attempt-2", brief)
    assert accepted["failure_codes"] == codes
    assert "raw private payload" not in json.dumps(accepted)


def test_missing_generation_persists_code_but_public_event_omits_reason(tmp_path):
    tasks = TaskService(tmp_path)
    evolution = EvolutionService(tasks)
    evolution.register("general", multirole_package())
    generation = GenerationService(tasks, evolution)
    reason = (
        "PackageError: RuntimeError: ContractError: "
        "behavior_patch/hypothesis: 'component_ids' is a required property")

    record = generation._missing({
        "id": "generation-validation-fixture", "channel": "general",
        "feedback_bundle_id": "feedback-validation-fixture",
    }, reason)

    stored = generation.generation(record["id"])
    assert stored["public_patch_error_code"] == (
        "missing_hypothesis_component_ids")
    event = evolution.events("general")[-1]
    assert event["kind"] == "candidate_generation_missing"
    assert "reason" not in event["content"]
    assert reason not in json.dumps(event)


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


def test_static_ask_preflight_repairs_before_spending_paired_calls(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    parent = multirole_package()
    valid = _child(parent)
    files = deepcopy(valid["files"])
    graph = json.loads(files["workflows/main.json"])
    ask = next(node for node in graph["nodes"] if node["method"] == "ask")
    ask["bindings"]["prior_findings"] = {"$input": "task"}
    files["workflows/main.json"] = json.dumps(graph, sort_keys=True)
    invalid = make_package(files, deepcopy(valid["manifest"]), parent=parent,
                           provenance={"fixture": "invalid-ask-arguments"})
    assert static_gateway_preflight(invalid) == [
        "ask_unsupported_gateway_arguments"]
    for package in (parent, invalid, valid):
        tasks.store.put_package(package)
    candidates = {
        "candidate-invalid": _candidate("candidate-invalid", parent, invalid),
        "candidate-valid": _candidate("candidate-valid", parent, valid),
    }
    records = {
        "generation-invalid": _generation(
            "generation-invalid", parent, invalid, "candidate-invalid"),
        "generation-valid": _generation(
            "generation-valid", parent, valid, "candidate-valid"),
    }
    service = BoundedOrchestrationSearch(
        tasks, _Evolution(parent, candidates), _Generation(records))
    order = iter(records.values())
    repairs, qualified = [], []

    def generate(_attempt, _attempt_id, repair, _remaining):
        repairs.append(deepcopy(repair))
        return deepcopy(next(order))

    def qualify(candidate, _remaining):
        qualified.append(candidate["id"])
        return _qualification(candidate["id"], delta=0.25)

    result = service.run(
        "general", "feedback-1", 0,
        {"max_attempts": 2, "target_qualified": 1,
         "minimum_mean_delta": 0.0, "max_model_calls": 6,
         "max_completion_tokens": 100, "max_tool_calls": 0,
         "max_nodes": 30},
        generate=generate, qualify=qualify)

    assert result["status"] == "qualified"
    assert qualified == ["candidate-valid"]
    assert repairs[1]["failure_codes"] == [
        "ask_unsupported_gateway_arguments"]
    first = next(event for event in result["events"]
                 if event["kind"] == "attempt_finished")
    assert "qualification" not in first["content"]


def test_caller_owned_finished_search_replays_without_spending(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    parent = multirole_package()
    child = _child(parent)
    for package in (parent, child):
        tasks.store.put_package(package)
    candidate = _candidate("candidate-o", parent, child)
    record = _generation("generation-o", parent, child, candidate["id"])
    service = BoundedOrchestrationSearch(
        tasks, _Evolution(parent, {candidate["id"]: candidate}),
        _Generation({record["id"]: record}))
    policy = {"max_attempts": 1, "target_qualified": 1,
              "minimum_mean_delta": 0.0, "max_model_calls": 6,
              "max_completion_tokens": 100, "max_tool_calls": 0,
              "max_nodes": 30}
    search_id = "orchestration-search-feedback-work-1"

    first = service.run(
        "general", "feedback-1", 0, policy, search_id=search_id,
        generate=lambda *_: deepcopy(record),
        qualify=lambda item, _: _qualification(item["id"], delta=0.25))

    def repeated(*_args, **_kwargs):
        pytest.fail("finished caller-owned search spent work again")

    replay = service.run(
        "general", "feedback-1", 0, policy, search_id=search_id,
        generate=repeated, qualify=repeated)

    assert replay == first
    assert replay["id"] == search_id


def test_caller_owned_search_id_is_bound_to_frozen_inputs(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    parent = multirole_package()
    child = _child(parent)
    for package in (parent, child):
        tasks.store.put_package(package)
    candidate = _candidate("candidate-o", parent, child)
    record = _generation("generation-o", parent, child, candidate["id"])
    service = BoundedOrchestrationSearch(
        tasks, _Evolution(parent, {candidate["id"]: candidate}),
        _Generation({record["id"]: record}))
    policy = {"max_attempts": 1, "target_qualified": 1,
              "minimum_mean_delta": 0.0, "max_model_calls": 6,
              "max_completion_tokens": 100, "max_tool_calls": 0,
              "max_nodes": 30}
    search_id = "orchestration-search-feedback-work-1"
    service.run(
        "general", "feedback-1", 0, policy, search_id=search_id,
        generate=lambda *_: deepcopy(record),
        qualify=lambda item, _: _qualification(item["id"], delta=0.25))
    changed = {**policy, "minimum_mean_delta": 0.1}

    with pytest.raises(ContractError, match="different frozen inputs"):
        service.run(
            "general", "feedback-1", 0, changed, search_id=search_id,
            generate=lambda *_: pytest.fail("mismatched search generated"),
            qualify=lambda *_: pytest.fail("mismatched search qualified"))


def test_caller_owned_open_search_fails_closed_without_spending(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    parent = multirole_package()
    tasks.store.put_package(parent)
    service = BoundedOrchestrationSearch(
        tasks, _Evolution(parent, {}), _Generation({
            "placeholder": {
                "parent_package_digest": parent["digest"],
            },
        }))
    policy = {"max_attempts": 1, "target_qualified": 1,
              "minimum_mean_delta": 0.0, "max_model_calls": 6,
              "max_completion_tokens": 100, "max_tool_calls": 0,
              "max_nodes": 30}
    search_id = "orchestration-search-feedback-work-1"
    service.journal.append(search_id, "started", {
        "schema": SEARCH_SCHEMA, "channel": "general", "channel_revision": 0,
        "feedback_bundle_id": "feedback-1",
        "parent_package_digest": parent["digest"], "policy": policy,
    })
    service.journal.append(search_id, "attempt_started", {
        "attempt": 1, "attempt_id": search_id + "/attempt-1",
    })

    with pytest.raises(ContractError, match="unfinished"):
        service.run(
            "general", "feedback-1", 0, policy, search_id=search_id,
            generate=lambda *_: pytest.fail("open search generated again"),
            qualify=lambda *_: pytest.fail("open search qualified again"))


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
