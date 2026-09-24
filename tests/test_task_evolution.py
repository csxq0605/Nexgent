from copy import deepcopy

import pytest

from nexgent.kernel.programs import digest
from nexgent.tasks.evidence import build_rsi_mechanism_evidence
from nexgent.tasks.evolution import EvolutionService, PromotionPolicy, _loaded_evidence
from nexgent.tasks.adaptive_orchestration_seed import adaptive_orchestration_package
from nexgent.tasks.generation import GenerationService, PATCH_SCHEMA, PATCH_SCHEMA_V2
from nexgent.tasks.packages import PackageError, make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ContractError, ToolRegistry


def package(version, *, parent=None, fail=False, improve_revision=None):
    source = ("def execute(payload, context):\n    raise ValueError('candidate failed')\n"
              if fail else
              "def execute(payload, context):\n"
              f"    item = {{'version': {version!r}, 'score': {float(version)!r}}}\n"
              "    artifact = context.publish(item, name='result')\n"
              "    return {'deliverables': {'result': artifact['id']}}\n")
    files = {"main.py": source}
    entries = {"execute": "main.py:execute"}
    if improve_revision is not None:
        files["improve.py"] = (
            "def improve(payload, context):\n"
            f"    return {{'revision': {improve_revision!r}}}\n")
        entries["improve"] = "improve.py:improve"
    return make_package(files, {"entries": entries}, parent=parent,
                        provenance={"fixture": version})


def v2_package(version, *, parent=None):
    source = ("def execute(payload, context):\n"
              f"    item = {{'version': {version!r}, 'score': {float(version)!r}}}\n"
              "    artifact = context.publish(item, name='result')\n"
              "    return {'deliverables': {'result': artifact['id']}}\n")
    manifest = {
        "manifest_version": 2,
        "entries": {"execute": "main.py:execute"},
        "skills": {}, "roles": {}, "workflows": {},
        "components": {
            "task-orchestrator": {"class": "O", "kind": "entry", "ref": "execute"}},
        "orchestrator": "task-orchestrator",
    }
    return make_package({"main.py": source}, manifest, parent=parent,
                        provenance={"fixture": f"v2-{version}"})


def test_nondefault_strategy_requires_actual_activation_not_only_loaded_source():
    package = adaptive_orchestration_package()
    component_id = "ordinary-open-loop"
    path = "agent/main.py"
    target = {"component_id": component_id, "class": "O", "kind": "entry",
              "ref": "execute", "files": [path]}
    execution = {"package_digest": package["digest"],
                 "loaded_modules": [path], "kind": "controlled_code",
                 "entry": "execute"}

    assert _loaded_evidence(target, execution, package)["loaded"] is False
    execution["active_strategy"] = {
        "kind": "entry", "component_id": "self-orchestration-workflow",
        "package_digest": package["digest"], "source_path": path,
        "source_digest": package["component_digests"][path],
        "backend": "controlled_code",
    }
    assert _loaded_evidence(target, execution, package)["loaded"] is False
    execution["active_strategy"]["component_id"] = component_id
    assert _loaded_evidence(target, execution, package)["loaded"] is True


def test_revised_dag_strategy_uses_invocation_identity_not_bootstrap_ref():
    package = adaptive_orchestration_package()
    path = "workflows/main.json"
    target = {"component_id": "self-orchestration-workflow", "class": "O",
              "kind": "workflow", "ref": "main", "files": [path]}
    execution = {
        "package_digest": package["digest"], "loaded_modules": [path],
        "kind": "executable_plan", "workflow_ref": "generated://revision",
        "plan_ref": "plan://revision", "plan_revision": 1,
        "active_strategy": {
            "kind": "workflow", "component_id": target["component_id"],
            "package_digest": package["digest"], "source_path": path,
            "source_digest": package["component_digests"][path],
            "backend": "executable_plan",
            "invocation": {"workflow_ref": "generated://revision",
                           "plan_ref": "plan://revision", "plan_revision": 1},
        },
    }
    assert _loaded_evidence(target, execution, package)["loaded"] is True
    execution["active_strategy"]["invocation"]["workflow_ref"] = "generated://other"
    assert _loaded_evidence(target, execution, package)["loaded"] is False


class PairedBenchmark:
    id = "paired-contract"

    def __init__(self, *, score_available=True):
        self.version = 1
        self.score_available = score_available
        self.seen = []

    def snapshot(self):
        return {"id": self.id, "version": self.version, "evaluator_digest": "paired-v1"}

    def describe(self):
        return {"id": self.id, "kind": "deterministic-test"}

    def tasks(self, split="development", seed=0):
        return [{"id": f"{split}/{seed}/a", "objective": "return a scored result",
                 "inputs": {}, "deliverables": result_spec(), "capabilities": [],
                 "context": {"split": split}},
                {"id": f"{split}/{seed}/b", "objective": "return the same scored result",
                 "inputs": {}, "deliverables": result_spec(), "capabilities": [],
                 "context": {"split": split}}]

    def evaluate(self, task_ref, deliverables, execution_view):
        self.seen.append({"task": deepcopy(task_ref), "episode": execution_view["episode_id"]})
        score = deliverables["result"]["score"]
        if not self.score_available:
            return {"status": "unavailable", "score_available": False, "accepted": None}
        return {"status": "accepted", "score_available": True,
                "accepted": True, "score": score}


class DuplicateGuardBenchmark(PairedBenchmark):
    """A guard suite whose multiplicity cannot be represented by a set."""

    def tasks(self, split="development", seed=0):
        task = {"id": f"{split}/{seed}/duplicate", "objective": "return a scored result",
                "inputs": {}, "deliverables": result_spec(), "capabilities": [],
                "context": {"split": split}}
        return [deepcopy(task), deepcopy(task)]


class SingleTaskBenchmark(PairedBenchmark):
    def tasks(self, split="development", seed=0):
        return [super().tasks(split=split, seed=seed)[0]]


def result_spec():
    return [{"name": "result", "schema": {
        "type": "object", "required": ["version", "score"]}}]


def service(tmp_path):
    return TaskService(tmp_path, tools=ToolRegistry())


def feedback(tasks, parent, *, split="development"):
    return tasks.create("candidate feedback", package=parent, context={"split": split})["id"]


def propose(tasks, evolution, parent, child, *, hypothesis="improve paired score"):
    return evolution.propose("general", child, hypothesis=hypothesis,
                             feedback_episode_ids=[feedback(tasks, parent)])


def generated_candidate(tasks, evolution, parent, target):
    """Create a candidate through the actual feedback-bound improver contract."""
    observed = tasks.create(
        "Observe the active parent", deliverables=result_spec(), package=parent,
        context={"split": "development", "split_role": "development"})
    observed = tasks.run(observed["id"])
    generation = GenerationService(tasks, evolution)
    bundle = generation.capture_feedback(
        "general", [observed["id"]], expected_revision=evolution.active("general")["revision"])
    patch = {
        "schema": PATCH_SCHEMA,
        "hypothesis": {
            "failure_mechanism": "The active package retains the old task behavior.",
            "expected_behavior": "The replacement component improves the paired score.",
            "applicability": "Tasks that execute main.py.",
            "falsifier": "The replacement is not loaded or does not improve the score.",
        },
        "operations": [{
            "op": "replace", "path": "main.py",
            "old_digest": parent["component_digests"]["main.py"],
            "content": target["files"]["main.py"],
        }],
        "activation_probe": {"kind": "component_loaded", "path": "main.py"},
    }
    improver_source = (
        "def improve(payload, context):\n"
        f"    artifact = context.publish({patch!r}, name='behavior_patch')\n"
        "    return {'deliverables': {'behavior_patch': artifact['id']}}\n")
    improver = make_package(
        {"improver.py": improver_source},
        {"entries": {"execute": "improver.py:improve", "improve": "improver.py:improve"}},
        provenance={"fixture": "evolution-generated-candidate"})
    result = generation.generate(
        "general", bundle["id"], improver,
        {"mutable_paths": ["main.py"], "component_classes": {"main.py": "O"},
         "allowed_operations": ["replace"], "max_patch_bytes": 100000},
        expected_revision=0)
    assert result["status"] == "generated"
    candidate = evolution.candidate(result["candidate_id"])
    return tasks.store.package(candidate["package_id"]), candidate


def generated_v2_candidate(tasks, evolution, parent, target):
    observed = tasks.create(
        "Observe the active v2 parent", deliverables=result_spec(), package=parent,
        context={"split": "development", "split_role": "development"})
    observed = tasks.run(observed["id"])
    feedback_adapter = SingleTaskBenchmark()
    feedback_task = feedback_adapter.tasks(split="development", seed=0)[0]
    tasks.evaluate(observed["id"], feedback_adapter, feedback_task,
                   snapshot=feedback_adapter.snapshot())
    generation = GenerationService(tasks, evolution)
    bundle = generation.capture_feedback("general", [observed["id"]], expected_revision=0)
    patch = {
        "schema": PATCH_SCHEMA_V2,
        "hypothesis": {
            "component_id": "task-orchestrator",
            "failure_mechanism": "The active component retains old behavior.",
            "expected_behavior": "The target component improves the paired score.",
            "applicability": "Tasks using the declared orchestrator.",
            "falsifier": "The component is not loaded or does not improve.",
        },
        "operations": [{
            "op": "replace", "component_id": "task-orchestrator",
            "old_digest": parent["component_digests"]["main.py"],
            "content": target["files"]["main.py"],
        }],
        "activation_probe": {
            "kind": "component_loaded", "component_id": "task-orchestrator"},
    }
    source = ("def improve(payload, context):\n"
              f"    artifact = context.publish({patch!r}, name='behavior_patch')\n"
              "    return {'deliverables': {'behavior_patch': artifact['id']}}\n")
    improver = make_package(
        {"improver.py": source},
        {"entries": {"execute": "improver.py:improve", "improve": "improver.py:improve"}},
        provenance={"fixture": "v2-evolution-improver"})
    result = generation.generate(
        "general", bundle["id"], improver,
        {"mutable_components": ["task-orchestrator"],
         "allowed_operations": ["replace"], "max_patch_bytes": 100000}, 0)
    assert result["status"] == "generated", result.get("reason")
    return evolution.candidate(result["candidate_id"]), generation, bundle, result


def prepare(tmp_path):
    tasks = service(tmp_path)
    evolution = EvolutionService(tasks)
    parent = package(0)
    evolution.register("general", parent)
    child, candidate = generated_candidate(tasks, evolution, parent, package(1, parent=parent))
    return tasks, evolution, parent, child, candidate


def promoted(tmp_path, *, adapter=None, policy=None):
    tasks, evolution, parent, child, candidate = prepare(tmp_path)
    adapter = PairedBenchmark() if adapter is None else adapter
    trial = evolution.evaluate_pair(
        candidate["id"], adapter, split="selection", split_role="selection", policy=policy)
    decision = evolution.assess(trial["id"])
    assert decision["eligible"] is True
    monitor_plan = evolution.plan_monitor(candidate["id"], adapter, split="guard", seed=31)
    active = evolution.promote(
        candidate["id"], decision["id"], monitor_plan_id=monitor_plan["id"])
    return tasks, evolution, parent, child, candidate, adapter, monitor_plan, active


def test_selection_trial_promotes_explicitly_and_channel_loads_new_package(tmp_path):
    tasks, evolution, parent, child, candidate = prepare(tmp_path)
    adapter = PairedBenchmark()
    monitor_plan = evolution.plan_monitor(candidate["id"], adapter, split="guard", seed=1)
    development = evolution.evaluate_pair(candidate["id"], adapter, split_role="development")
    development_decision = evolution.assess(development["id"])
    assert development_decision["eligible"] is False
    assert development_decision["gates"]["selection_role"] is False
    with pytest.raises(ContractError, match="eligible"):
        evolution.promote(candidate["id"], development_decision["id"],
                          monitor_plan_id=monitor_plan["id"])

    trial = evolution.evaluate_pair(candidate["id"], adapter, split="selection",
                                    split_role="selection")
    assert [row["arms"] for row in trial["arm_order"]] == [
        ["parent", "candidate"], ["candidate", "parent"]]
    decision = evolution.assess(trial["id"])
    assert decision["eligible"] is True
    assert all(row["score_delta"] == 1.0
               for row in decision["measurements"]["paired_task_deltas"])
    promoted = evolution.promote(candidate["id"], decision["id"],
                                 monitor_plan_id=monitor_plan["id"])
    assert promoted["package_id"] == child["id"]

    state = tasks.create("load the active package", package_channel="general")
    registration = state["task"]["context"]["package_channel_registration"]
    assert registration == {"channel": "general", "revision": promoted["revision"],
                            "package_id": child["id"], "package_digest": child["digest"]}
    completed = tasks.run(state["id"])
    delivered = tasks.store.read(completed["output_refs"]["result"], state["id"])["content"]
    assert delivered == {"version": 1, "score": 1.0}
    promotion_event = [event for event in evolution.events("general")
                       if event["kind"] == "package_promoted"][-1]
    assert promotion_event["content"]["policy"] == decision["policy"]
    assert promotion_event["content"]["monitoring_thresholds"] == {
        "min_score": 0.0, "min_success_rate": 1.0}


def test_v2_component_identity_and_loaded_evidence_reach_guard_and_promotion(tmp_path):
    tasks = service(tmp_path)
    evolution = EvolutionService(tasks)
    parent = v2_package(0)
    evolution.register("general", parent)
    target = v2_package(1, parent=parent)
    candidate, generation, bundle, generated = generated_v2_candidate(
        tasks, evolution, parent, target)
    adapter = SingleTaskBenchmark()

    trial = evolution.evaluate_pair(
        candidate["id"], adapter, split="selection", split_role="selection",
        policy=PromotionPolicy(monitor_min_score=2.0))
    candidate_run = trial["pairs"][0]["candidate"]
    candidate_package = tasks.store.package(candidate["package_id"])
    active_strategy = candidate_run["execution"]["active_strategy"]
    assert active_strategy["component_id"] == "task-orchestrator"
    assert active_strategy["kind"] == "entry"
    assert active_strategy["backend"] == "controlled_code"
    assert active_strategy["source_digest"] == candidate_package[
        "component_digests"]["main.py"]
    assert candidate_run["loaded_evidence"] == {
        "component_id": "task-orchestrator", "class": "O", "kind": "entry",
        "ref": "execute", "expected_files": ["main.py"],
        "expected_file_digests": {
            "main.py": candidate_package["component_digests"]["main.py"]},
        "loaded_files": ["main.py"], "loaded_modules": ["main.py"],
        "loaded_file_digests": {
            "main.py": candidate_package["component_digests"]["main.py"]},
        "loaded_modules_digest": digest(["main.py"]),
        "expected_package_digest": candidate_package["digest"],
        "loaded_package_digest": candidate_package["digest"], "loaded": True}
    decision = evolution.assess(trial["id"])
    assert decision["eligible"] is True
    assert decision["component_id"] == "task-orchestrator"
    assert decision["loaded_evidence"][0]["loaded"] is True
    assert decision["loaded_evidence"][0]["loaded_file_digests"] == {
        "main.py": candidate_package["component_digests"]["main.py"]}

    monitor_plan = evolution.plan_monitor(
        candidate["id"], adapter, split="guard", seed=9)
    active = evolution.promote(
        candidate["id"], decision["id"], monitor_plan_id=monitor_plan["id"])
    assert active["promotion"]["component_id"] == "task-orchestrator"
    assert active["promotion"]["selection_loaded_evidence"] == decision["loaded_evidence"]
    promotion_event = [event for event in evolution.events("general")
                       if event["kind"] == "package_promoted"][-1]
    assert promotion_event["content"]["component_id"] == "task-orchestrator"
    assert promotion_event["content"]["selection_loaded_evidence"] == decision["loaded_evidence"]
    promoted_episode = tasks.create(
        "Load the promoted component", package_channel="general")
    promoted_episode = tasks.run(promoted_episode["id"])

    monitor_run = evolution.run_monitor(
        "general", adapter, expected_revision=active["revision"],
        expected_package_id=active["package_id"],
        expected_monitor_plan_id=monitor_plan["id"])
    assert monitor_run["component_id"] == "task-orchestrator"
    assert monitor_run["reports"][0]["loaded_evidence"]["loaded"] is True
    assert monitor_run["reports"][0]["loaded_evidence"]["expected_file_digests"] == {
        "main.py": candidate_package["component_digests"]["main.py"]}
    monitored = evolution.monitor(
        "general", monitor_run["episode_ids"], rollback_on_regression=True,
        expected_revision=active["revision"], expected_package_id=active["package_id"],
        expected_monitor_plan_id=monitor_plan["id"])
    assert monitored["degraded"] is True and monitored["rolled_back"] is True
    rollback_episode = tasks.create(
        "Load the restored parent", package_channel="general")
    rollback_episode = tasks.run(rollback_episode["id"])

    evidence = build_rsi_mechanism_evidence(
        tasks, evolution, generation, channel="general",
        feedback_bundle_id=bundle["id"], generation_id=generated["id"],
        selection_plan_id=trial["plan_id"], trial_id=trial["id"],
        decision_id=decision["id"], monitor_plan_id=monitor_plan["id"],
        promoted_episode_id=promoted_episode["id"],
        guard_episode_ids=monitor_run["episode_ids"],
        rollback_episode_id=rollback_episode["id"])
    assert evidence["generation"]["component_id"] == "task-orchestrator"
    assert evidence["selection"]["loaded_evidence"][0]["loaded"] is True
    assert evidence["deployment"]["loaded_evidence"]["loaded"] is True
    assert evidence["deployment"]["loaded_evidence"]["loaded_file_digests"] == {
        "main.py": candidate_package["component_digests"]["main.py"]}
    assert evidence["monitoring"]["guard_episodes"][0]["loaded_evidence"]["loaded"] is True


def test_v2_candidate_cannot_redirect_stable_component_ref_through_manifest(tmp_path):
    tasks = service(tmp_path)
    evolution = EvolutionService(tasks)
    parent = v2_package(0)
    evolution.register("general", parent)
    redirected_manifest = deepcopy(parent["manifest"])
    redirected_manifest["entries"]["execute"] = "other.py:execute"
    child = make_package(
        {**parent["files"], "other.py": package(1)["files"]["main.py"]},
        redirected_manifest, parent=parent, provenance={"fixture": "redirect"})

    with pytest.raises(ContractError, match="frozen parent manifest"):
        evolution.propose(
            "general", child,
            hypothesis={"component_id": "task-orchestrator", "claim": "redirect"},
            feedback_episode_ids=[feedback(tasks, parent)],
            activation_probe={"kind": "component_loaded",
                              "component_id": "task-orchestrator"})


def test_v1_candidate_cannot_upgrade_manifest_through_propose(tmp_path):
    tasks = service(tmp_path)
    evolution = EvolutionService(tasks)
    parent = package(0)
    evolution.register("general", parent)
    upgraded = v2_package(1, parent=parent)

    with pytest.raises(ContractError, match="frozen parent manifest"):
        evolution.propose(
            "general", upgraded, hypothesis="upgrade manifest version",
            feedback_episode_ids=[feedback(tasks, parent)])


def test_expected_package_registration_pins_the_resolved_deployment_during_drift(
        tmp_path, monkeypatch):
    import nexgent.tasks.evolution as evolution_module

    tasks, evolution, parent, child, candidate, adapter, monitor_plan, active = promoted(tmp_path)
    expected = {key: active[key] for key in (
        "channel", "revision", "package_id", "package_digest")}
    original = evolution_module.active_package_registration
    drifted = {"done": False}

    def resolve_then_drift(store, channel):
        registration = original(store, channel)
        if not drifted["done"]:
            drifted["done"] = True
            evolution.rollback(
                channel, reason="concurrent test drift",
                expected_revision=active["revision"],
                expected_package_id=active["package_id"],
                expected_monitor_plan_id=monitor_plan["id"])
        return registration

    monkeypatch.setattr(evolution_module, "active_package_registration", resolve_then_drift)
    state = tasks.create(
        "pin the resolved deployment", package_channel="general",
        expected_package_registration=expected)

    assert state["package_id"] == child["id"]
    assert state["task"]["context"]["package_channel_registration"] == expected
    assert evolution.active("general")["package_id"] == parent["id"]


def test_expected_package_registration_rejects_stale_or_nonchannel_use(tmp_path):
    tasks = service(tmp_path)
    parent = package(0)
    evolution = EvolutionService(tasks)
    active = evolution.register("general", parent)
    expected = {key: active[key] for key in (
        "channel", "revision", "package_id", "package_digest")}
    stale = {**expected, "revision": expected["revision"] + 1}

    with pytest.raises(ContractError, match="differs from the expected deployment"):
        tasks.create("stale", package_channel="general",
                     expected_package_registration=stale)
    with pytest.raises(ContractError, match="requires a package channel"):
        tasks.create("not a channel", package=parent,
                     expected_package_registration=expected)


def test_run_monitor_never_loads_a_drifted_channel_package(tmp_path, monkeypatch):
    tasks, evolution, parent, child, candidate, adapter, monitor_plan, active = promoted(tmp_path)
    original_create = tasks.create
    drifted = {"done": False}

    def drift_before_channel_resolution(*args, **kwargs):
        if not drifted["done"]:
            drifted["done"] = True
            evolution.rollback(
                "general", reason="race before guard Episode creation",
                expected_revision=active["revision"],
                expected_package_id=active["package_id"],
                expected_monitor_plan_id=monitor_plan["id"])
        return original_create(*args, **kwargs)

    monkeypatch.setattr(tasks, "create", drift_before_channel_resolution)
    before = len(tasks.list())
    with pytest.raises(ContractError, match="expected deployment"):
        evolution.run_monitor(
            "general", adapter, expected_revision=active["revision"],
            expected_package_id=active["package_id"],
            expected_monitor_plan_id=monitor_plan["id"])

    assert len(tasks.list()) == before
    assert evolution.active("general")["package_id"] == parent["id"]
    claim = evolution.inspect_run_claim("monitor", monitor_plan["id"])
    assert claim["status"] == "running"
    evolution.recover_run_claim(
        "monitor", monitor_plan["id"], confirm_no_external_commit=True)


def test_monitor_cas_refuses_to_rollback_a_newer_deployment(tmp_path, monkeypatch):
    tasks, evolution, parent, child, candidate, adapter, monitor_plan, active = promoted(tmp_path)
    adapter.score_available = False
    monitoring = evolution.run_monitor(
        "general", adapter, expected_revision=active["revision"],
        expected_package_id=active["package_id"],
        expected_monitor_plan_id=monitor_plan["id"])
    original_event = evolution._event
    drifted = {"done": False}

    def drift_after_measurement(channel, kind, content):
        event = original_event(channel, kind, content)
        if kind == "deployment_monitored" and not drifted["done"]:
            drifted["done"] = True
            evolution.rollback(
                channel, reason="concurrent rollback wins",
                expected_revision=active["revision"],
                expected_package_id=active["package_id"],
                expected_monitor_plan_id=monitor_plan["id"])
        return event

    monkeypatch.setattr(evolution, "_event", drift_after_measurement)
    with pytest.raises(ContractError, match="expected binding"):
        evolution.monitor(
            "general", monitoring["episode_ids"],
            expected_revision=active["revision"],
            expected_package_id=active["package_id"],
            expected_monitor_plan_id=monitor_plan["id"])

    # The concurrent rollback happened once; monitor did not apply a second
    # rollback to the already-restored parent deployment.
    restored = evolution.active("general")
    assert restored["package_id"] == parent["id"]
    assert restored["revision"] == active["revision"] + 1


def test_candidate_requires_lineage_hypothesis_feedback_and_component_delta(tmp_path):
    tasks = service(tmp_path)
    evolution = EvolutionService(tasks)
    parent, other = package(0), package(2)
    evolution.register("general", parent)
    evidence = feedback(tasks, parent)
    with pytest.raises(PackageError, match="descend"):
        evolution.propose("general", package(1, parent=other), hypothesis="test",
                          feedback_episode_ids=[evidence])
    with pytest.raises(ContractError, match="hypothesis"):
        evolution.propose("general", package(1, parent=parent), hypothesis="",
                          feedback_episode_ids=[evidence])
    with pytest.raises(ContractError, match="not local"):
        evolution.propose("general", package(1, parent=parent), hypothesis="test",
                          feedback_episode_ids=["episode-0000000000000000"])
    candidate = evolution.propose("general", package(1, parent=parent), hypothesis="test",
                                  feedback_episode_ids=[evidence])
    assert candidate["component_delta"] == {"added": [], "removed": [], "changed": ["main.py"],
                                            "manifest_changed": False}
    assert candidate["evidence_digest"]


def test_imported_candidate_can_be_evaluated_but_never_promoted(tmp_path):
    tasks = service(tmp_path)
    evolution = EvolutionService(tasks)
    parent = package(0)
    child = package(1, parent=parent)
    evolution.register("general", parent)
    candidate = propose(tasks, evolution, parent, child)
    assert candidate["origin"] == "imported"
    adapter = PairedBenchmark()
    trial = evolution.evaluate_pair(
        candidate["id"], adapter, split="selection", split_role="selection")
    decision = evolution.assess(trial["id"])
    assert decision["eligible"] is True
    monitor_plan = evolution.plan_monitor(candidate["id"], adapter, split="guard")

    with pytest.raises(ContractError, match="generated|generation|imported"):
        evolution.promote(
            candidate["id"], decision["id"], monitor_plan_id=monitor_plan["id"])
    assert evolution.active("general")["package_id"] == parent["id"]


def test_promotion_requires_a_pre_registered_monitor_plan(tmp_path):
    tasks, evolution, parent, child, candidate = prepare(tmp_path)
    adapter = PairedBenchmark()
    trial = evolution.evaluate_pair(
        candidate["id"], adapter, split="selection", split_role="selection")
    decision = evolution.assess(trial["id"])
    assert decision["eligible"] is True

    with pytest.raises(ContractError, match="[Mm]onitor"):
        evolution.promote(candidate["id"], decision["id"])
    assert evolution.active("general")["package_id"] == parent["id"]


def test_candidate_cannot_change_improve_boundary_or_use_holdout_feedback(tmp_path):
    tasks = service(tmp_path)
    evolution = EvolutionService(tasks)
    parent = package(0, improve_revision="frozen")
    evolution.register("general", parent)
    normal = feedback(tasks, parent)
    changed = package(1, parent=parent, improve_revision="changed")
    with pytest.raises(ContractError, match="improve entry file"):
        evolution.propose("general", changed, hypothesis="modify improver",
                          feedback_episode_ids=[normal])
    removed = package(1, parent=parent)
    with pytest.raises(ContractError, match="improve entry"):
        evolution.propose("general", removed, hypothesis="remove improver",
                          feedback_episode_ids=[normal])
    holdout = feedback(tasks, parent, split="final_holdout")
    valid = package(1, parent=parent, improve_revision="frozen")
    with pytest.raises(ContractError, match="holdout"):
        evolution.propose("general", valid, hypothesis="leak holdout",
                          feedback_episode_ids=[holdout])


@pytest.mark.parametrize("failure", ["score", "usage"])
def test_assessment_fails_closed_on_missing_measurement(tmp_path, monkeypatch, failure):
    tasks, evolution, parent, child, candidate = prepare(tmp_path)
    adapter = PairedBenchmark(score_available=failure != "score")
    if failure == "usage":
        original = tasks.store.usage

        def incomplete(identity):
            value = original(identity)
            value["usage_complete"] = False
            value["usage_missing_call_ids"] = ["call-missing"]
            return value

        monkeypatch.setattr(tasks.store, "usage", incomplete)
    trial = evolution.evaluate_pair(candidate["id"], adapter, split="selection",
                                    split_role="selection",
                                    policy=PromotionPolicy(max_cost_ratio=10.0))
    decision = evolution.assess(trial["id"])
    assert decision["eligible"] is False
    assert decision["gates"]["measurement_complete"] is False
    reasons = decision["measurements"]["failure_reasons"]
    expected = "score_unavailable" if failure == "score" else "usage_incomplete"
    assert reasons and any(expected in item for item in reasons)
    assert len(decision["measurements"]["paired_task_deltas"]) == 2


def test_attributable_parent_failure_is_observed_zero_in_paired_selection(tmp_path):
    tasks = service(tmp_path)
    evolution = EvolutionService(tasks)
    parent = package(0, fail=True)
    evolution.register("general", parent)
    _, candidate = generated_candidate(
        tasks, evolution, parent, package(1, parent=parent))

    trial = evolution.evaluate_pair(
        candidate["id"], PairedBenchmark(), split="selection",
        split_role="selection", policy=PromotionPolicy(max_cost_ratio=10.0))
    decision = evolution.assess(trial["id"])

    assert decision["gates"]["measurement_complete"] is True
    rows = decision["measurements"]["paired_task_deltas"]
    assert [(row["parent"]["score"], row["parent"]["accepted"],
             row["parent"]["failure_class"], row["score_delta"])
            for row in rows] == [
                (0.0, False, "observed_system_failure", 1.0),
                (0.0, False, "observed_system_failure", 1.0),
            ]


def test_failed_candidate_and_holdout_trial_cannot_be_promoted(tmp_path):
    tasks = service(tmp_path)
    evolution = EvolutionService(tasks)
    parent = package(0)
    evolution.register("general", parent)
    failed, candidate = generated_candidate(
        tasks, evolution, parent, package(1, parent=parent, fail=True))
    monitor_plan = evolution.plan_monitor(candidate["id"], PairedBenchmark(), split="guard")
    with pytest.raises(ContractError, match="holdout"):
        evolution.evaluate_pair(candidate["id"], PairedBenchmark(), split="final_holdout",
                                split_role="holdout")
    trial = evolution.evaluate_pair(candidate["id"], PairedBenchmark(), split="selection",
                                    split_role="selection",
                                    policy=PromotionPolicy(max_cost_ratio=10.0))
    decision = evolution.assess(trial["id"])
    assert decision["eligible"] is False
    assert decision["gates"]["candidate_completed"] is False
    with pytest.raises(ContractError, match="eligible"):
        evolution.promote(candidate["id"], decision["id"],
                          monitor_plan_id=monitor_plan["id"])


def test_real_evaluator_bound_monitoring_rolls_back_and_rejects_forgery(tmp_path):
    tasks, evolution, parent, child, candidate = prepare(tmp_path)
    adapter = PairedBenchmark()
    policy = PromotionPolicy(monitor_min_score=2.0, monitor_min_success_rate=1.0)
    trial = evolution.evaluate_pair(candidate["id"], adapter, split="selection",
                                    split_role="selection", policy=policy)
    decision = evolution.assess(trial["id"])
    monitor_plan = evolution.plan_monitor(candidate["id"], adapter, split="guard", seed=9)
    evolution.promote(candidate["id"], decision["id"], monitor_plan_id=monitor_plan["id"])
    with pytest.raises(ContractError, match="identities"):
        evolution.monitor("general", [{"accepted": False, "score": 0.0}])

    monitoring = evolution.run_monitor("general", adapter)
    monitored = evolution.monitor("general", monitoring["episode_ids"])
    assert monitored["degraded"] is True and monitored["rolled_back"] is True
    assert monitored["active"]["package_id"] == parent["id"]
    assert tasks.create("use rollback", package_channel="general")["package_id"] == parent["id"]


def test_monitor_rejects_episode_outside_current_channel_deployment(tmp_path):
    tasks, evolution, parent, child, candidate = prepare(tmp_path)
    adapter = PairedBenchmark()
    trial = evolution.evaluate_pair(candidate["id"], adapter, split="selection",
                                    split_role="selection")
    decision = evolution.assess(trial["id"])
    monitor_plan = evolution.plan_monitor(candidate["id"], adapter, split="guard", seed=4)
    evolution.promote(candidate["id"], decision["id"], monitor_plan_id=monitor_plan["id"])
    monitoring = evolution.run_monitor("general", adapter)
    unrelated = tasks.create("unrelated", package=child)
    forged = [unrelated["id"], *monitoring["episode_ids"][1:]]
    with pytest.raises(ContractError, match="complete guard run|active channel deployment"):
        evolution.monitor("general", forged)


def test_monitor_missing_measurement_fails_closed_without_zero_imputation(tmp_path):
    tasks, evolution, parent, child, candidate = prepare(tmp_path)
    adapter = PairedBenchmark()
    trial = evolution.evaluate_pair(candidate["id"], adapter, split="selection",
                                    split_role="selection")
    decision = evolution.assess(trial["id"])
    missing_adapter = PairedBenchmark(score_available=False)
    monitor_plan = evolution.plan_monitor(candidate["id"], missing_adapter, split="guard", seed=3)
    evolution.promote(candidate["id"], decision["id"], monitor_plan_id=monitor_plan["id"])
    monitoring = evolution.run_monitor("general", missing_adapter)
    monitored = evolution.monitor("general", monitoring["episode_ids"])
    assert monitored["degraded"] is True and monitored["rolled_back"] is True
    assert monitored["metrics"]["measurement_complete"] is False
    assert monitored["metrics"]["score"] is None
    assert monitored["metrics"]["success_rate"] is None


def test_attributable_guard_failure_is_measured_zero_and_rolls_back(tmp_path):
    tasks = service(tmp_path)
    evolution = EvolutionService(tasks)
    parent = package(0)
    evolution.register("general", parent)
    target = make_package({"main.py": (
        "def execute(payload, context):\n"
        "    if payload.get('context', {}).get('split') == 'guard':\n"
        "        raise RuntimeError('guard-observed agent failure')\n"
        "    item = {'version': 1, 'score': 1.0}\n"
        "    artifact = context.publish(item, name='result')\n"
        "    return {'deliverables': {'result': artifact['id']}}\n")},
        {"entries": {"execute": "main.py:execute"}}, parent=parent,
        provenance={"fixture": "guard-observed-failure"})
    child, candidate = generated_candidate(tasks, evolution, parent, target)
    adapter = PairedBenchmark()
    policy = PromotionPolicy(
        max_cost_ratio=10.0, monitor_min_score=0.5, monitor_min_success_rate=1.0)
    trial = evolution.evaluate_pair(
        candidate["id"], adapter, split="selection", split_role="selection",
        policy=policy)
    decision = evolution.assess(trial["id"])
    assert decision["eligible"] is True
    monitor_plan = evolution.plan_monitor(candidate["id"], adapter, split="guard", seed=17)
    evolution.promote(candidate["id"], decision["id"], monitor_plan_id=monitor_plan["id"])

    monitoring = evolution.run_monitor("general", adapter)
    assert all(report["evaluation"]["status"] == "observed_failure"
               and report["evaluation"]["score"] == 0.0
               for report in monitoring["reports"])
    monitored = evolution.monitor("general", monitoring["episode_ids"])
    assert monitored["metrics"]["measurement_complete"] is True
    assert monitored["metrics"]["score"] == 0.0
    assert monitored["metrics"]["success_rate"] == 0.0
    assert monitored["degraded"] is True and monitored["rolled_back"] is True
    assert monitored["active"]["package_id"] == parent["id"]


def test_guard_evaluator_failure_is_missing_and_rolls_back(tmp_path):
    tasks, evolution, parent, child, candidate, adapter, monitor_plan, active = promoted(
        tmp_path)

    def unavailable_evaluator(*args):
        raise RuntimeError("private evaluator dependency failed")

    adapter.evaluate = unavailable_evaluator
    monitoring = evolution.run_monitor("general", adapter)
    assert all(report["evaluation"]["status"] == "evaluator_unavailable"
               and report["evaluation"]["score_available"] is False
               for report in monitoring["reports"])
    monitored = evolution.monitor("general", monitoring["episode_ids"])
    assert monitored["metrics"]["measurement_complete"] is False
    assert monitored["degraded"] is True and monitored["rolled_back"] is True
    assert monitored["active"]["package_id"] == parent["id"]


def test_paired_plan_is_single_consumption_and_replay_does_not_create_episodes(tmp_path):
    tasks, evolution, parent, child, candidate = prepare(tmp_path)
    adapter = PairedBenchmark()
    plan = evolution.plan_pair(
        candidate["id"], adapter, split="selection", split_role="selection")
    before = len(tasks.list())
    first = evolution.run_pair(plan["id"], adapter)
    after_first = len(tasks.list())
    assert after_first == before + 2 * len(plan["suite"]["tasks"])
    claim = evolution.inspect_run_claim("paired", plan["id"])
    assert claim["status"] == "completed" and claim["record_id"] == first["id"]
    assert evolution.recover_run_claim(
        "paired", plan["id"], confirm_no_external_commit=True) == claim

    second = evolution.run_pair(plan["id"], adapter)
    assert second["id"] == first["id"]
    assert second["record_digest"] == first["record_digest"]
    assert len(tasks.list()) == after_first


def test_monitor_plan_is_single_consumption_and_replay_never_creates_episodes(tmp_path):
    tasks, evolution, parent, child, candidate, adapter, monitor_plan, active = promoted(tmp_path)
    before = len(tasks.list())
    first = evolution.run_monitor("general", adapter)
    after_first = len(tasks.list())
    assert after_first == before + len(monitor_plan["suite"]["tasks"])
    claim = evolution.inspect_run_claim("monitor", monitor_plan["id"])
    assert claim["status"] == "completed" and claim["record_id"] == first["id"]
    assert evolution.recover_run_claim(
        "monitor", monitor_plan["id"], confirm_no_external_commit=True) == claim

    try:
        second = evolution.run_monitor("general", adapter)
    except ContractError as exc:
        assert "already" in str(exc).casefold() or "repeat" in str(exc).casefold()
    else:
        assert second["episode_ids"] == first["episode_ids"]
        if "id" in first or "id" in second:
            assert second["id"] == first["id"]
            assert second["record_digest"] == first["record_digest"]
    assert len(tasks.list()) == after_first


def test_paired_record_survives_interruption_before_claim_finalize_without_replay(
        tmp_path, monkeypatch):
    tasks, evolution, parent, child, candidate = prepare(tmp_path)
    adapter = PairedBenchmark()
    plan = evolution.plan_pair(
        candidate["id"], adapter, split="selection", split_role="selection")
    original_finish = evolution._finish_run

    def interrupt_finalize(kind, plan_id, record_id):
        assert (kind, plan_id) == ("paired", plan["id"])
        raise RuntimeError("lost after durable paired record")

    monkeypatch.setattr(evolution, "_finish_run", interrupt_finalize)
    before = len(tasks.list())
    with pytest.raises(RuntimeError, match="durable paired record"):
        evolution.run_pair(plan["id"], adapter)
    after = len(tasks.list())
    assert after == before + 2 * len(plan["suite"]["tasks"])
    claim = evolution.inspect_run_claim("paired", plan["id"])
    assert claim["status"] == "running" and claim["record_id"] is None
    assert claim["durable_record_id"] is not None
    assert not [event for event in evolution.events("general")
                if event["kind"] == "paired_trial_recorded"
                and event["content"].get("plan_id") == plan["id"]]

    recovered = evolution.recover_run_claim("paired", plan["id"])
    assert recovered["status"] == "completed"
    assert recovered["record_id"] == claim["durable_record_id"]
    events = [event for event in evolution.events("general")
              if event["kind"] == "paired_trial_recorded"
              and event["content"].get("plan_id") == plan["id"]]
    assert len(events) == 1

    monkeypatch.setattr(evolution, "_finish_run", original_finish)
    replay = evolution.run_pair(plan["id"], adapter)
    assert replay["id"] == recovered["record_id"]
    assert len(tasks.list()) == after
    assert len(evolution._durable_run_records("paired", plan["id"])) == 1


def test_monitor_record_survives_interruption_before_claim_finalize_without_replay(
        tmp_path, monkeypatch):
    tasks, evolution, parent, child, candidate, adapter, monitor_plan, active = promoted(tmp_path)
    original_finish = evolution._finish_run

    def interrupt_finalize(kind, plan_id, record_id):
        assert (kind, plan_id) == ("monitor", monitor_plan["id"])
        raise RuntimeError("lost after durable monitor record")

    monkeypatch.setattr(evolution, "_finish_run", interrupt_finalize)
    before = len(tasks.list())
    with pytest.raises(RuntimeError, match="durable monitor record"):
        evolution.run_monitor(
            "general", adapter, expected_revision=active["revision"],
            expected_package_id=active["package_id"],
            expected_monitor_plan_id=monitor_plan["id"])
    after = len(tasks.list())
    assert after == before + len(monitor_plan["suite"]["tasks"])
    claim = evolution.inspect_run_claim("monitor", monitor_plan["id"])
    assert claim["status"] == "running" and claim["record_id"] is None
    assert claim["durable_record_id"] is not None
    assert not [event for event in evolution.events("general")
                if event["kind"] == "monitoring_run_recorded"
                and event["content"].get("monitor_plan_id") == monitor_plan["id"]]

    recovered = evolution.recover_run_claim("monitor", monitor_plan["id"])
    assert recovered["status"] == "completed"
    assert recovered["record_id"] == claim["durable_record_id"]
    events = [event for event in evolution.events("general")
              if event["kind"] == "monitoring_run_recorded"
              and event["content"].get("monitor_plan_id") == monitor_plan["id"]]
    assert len(events) == 1

    monkeypatch.setattr(evolution, "_finish_run", original_finish)
    replay = evolution.run_monitor(
        "general", adapter, expected_revision=active["revision"],
        expected_package_id=active["package_id"],
        expected_monitor_plan_id=monitor_plan["id"])
    assert replay["id"] == recovered["record_id"]
    assert len(tasks.list()) == after
    assert len(evolution._durable_run_records("monitor", monitor_plan["id"])) == 1


def test_guard_requires_complete_task_multiset_and_fails_closed_on_subset(tmp_path):
    adapter = DuplicateGuardBenchmark()
    tasks, evolution, parent, child, candidate, adapter, monitor_plan, active = promoted(
        tmp_path, adapter=adapter)
    assert len({digest(task) for task in monitor_plan["suite"]["tasks"]}) == 1
    monitoring = evolution.run_monitor("general", adapter)
    assert len(monitoring["episode_ids"]) == 2

    monitored = evolution.monitor("general", monitoring["episode_ids"][:1])
    assert monitored["degraded"] is True
    assert monitored["rolled_back"] is True
    assert monitored["metrics"]["measurement_complete"] is False
    assert monitored["metrics"]["score"] is None
    assert monitored["metrics"]["planned_count"] == 2
    assert len(monitored["metrics"]["missing_task_digests"]) == 1
    assert monitored["active"]["package_id"] == parent["id"]


def test_guard_usage_must_be_complete_or_monitoring_fails_closed(tmp_path, monkeypatch):
    tasks, evolution, parent, child, candidate, adapter, monitor_plan, active = promoted(tmp_path)
    monitoring = evolution.run_monitor("general", adapter)
    incomplete_id = monitoring["episode_ids"][0]
    original = tasks.store.usage

    def incomplete(identity):
        value = original(identity)
        if identity == incomplete_id:
            value["usage_complete"] = False
            value["usage_missing_call_ids"] = ["call-missing"]
        return value

    monkeypatch.setattr(tasks.store, "usage", incomplete)
    monitored = evolution.monitor("general", monitoring["episode_ids"])
    assert monitored["degraded"] is True
    assert monitored["rolled_back"] is True
    assert monitored["metrics"]["measurement_complete"] is False
    assert monitored["metrics"]["score"] is None
    assert monitored["active"]["package_id"] == parent["id"]


def test_guard_evaluation_is_single_assignment_and_cannot_be_rewritten(tmp_path):
    tasks, evolution, parent, child, candidate = prepare(tmp_path)
    selection = PairedBenchmark()
    trial = evolution.evaluate_pair(
        candidate["id"], selection, split="selection", split_role="selection")
    decision = evolution.assess(trial["id"])
    guard = PairedBenchmark(score_available=False)
    monitor_plan = evolution.plan_monitor(candidate["id"], guard, split="guard", seed=44)
    evolution.promote(candidate["id"], decision["id"], monitor_plan_id=monitor_plan["id"])
    monitoring = evolution.run_monitor("general", guard)
    identity = monitoring["episode_ids"][0]
    original = tasks.get(identity)["evaluation"]
    calls_before = len(guard.seen)

    with pytest.raises(ContractError, match="frozen benchmark registration"):
        tasks.evaluate(identity, guard, {"objective": "forged favorable task"},
                       snapshot=guard.snapshot())

    guard.score_available = True
    replay = tasks.evaluate(
        identity, guard, monitor_plan["suite"]["tasks"][0],
        snapshot=monitor_plan["suite"]["snapshot"])
    assert replay["evaluation"] == original
    assert tasks.get(identity)["evaluation"] == original
    assert len(guard.seen) == calls_before

    monitored = evolution.monitor("general", monitoring["episode_ids"])
    assert monitored["degraded"] is True and monitored["rolled_back"] is True
    assert monitored["active"]["package_id"] == parent["id"]


def test_frozen_snapshot_change_aborts_paired_trial(tmp_path):
    tasks, evolution, parent, child, candidate = prepare(tmp_path)
    adapter = PairedBenchmark()
    original = adapter.evaluate

    def mutating_evaluate(*args):
        result = original(*args)
        adapter.version += 1
        return result

    adapter.evaluate = mutating_evaluate
    with pytest.raises(ContractError, match="changed"):
        evolution.evaluate_pair(candidate["id"], adapter, split_role="selection")


def test_benchmark_channel_selection_is_explicit_and_propagated(tmp_path, monkeypatch):
    import nexgent.tasks.runtime as runtime

    tasks = service(tmp_path)
    parent = package(0)
    EvolutionService(tasks).register("general", parent)
    with pytest.raises(ContractError, match="either"):
        tasks.create("ambiguous", package=parent, package_channel="general")
    with pytest.raises(ContractError, match="either"):
        tasks.benchmark("unused", package=parent, package_channel="general")
    adapter = PairedBenchmark()
    monkeypatch.setattr(runtime, "task_benchmarks", lambda: {adapter.id: adapter})
    report = tasks.benchmark(adapter.id, package_channel="general")
    for result in report["reports"]:
        state = tasks.store.get(result["episode_id"])
        registration = state["task"]["context"]["package_channel_registration"]
        assert registration["channel"] == "general"
        assert registration["package_id"] == parent["id"]


def test_trial_plan_freezes_policy_before_any_arm_and_decision_is_idempotent(tmp_path):
    tasks, evolution, parent, child, candidate = prepare(tmp_path)
    adapter = PairedBenchmark()
    policy = PromotionPolicy(min_quality_delta=0.5, max_cost_ratio=2.0)
    episode_count = len(tasks.list())
    plan = evolution.plan_pair(candidate["id"], adapter, split="selection",
                               split_role="selection", policy=policy)
    assert len(tasks.list()) == episode_count
    assert plan["policy"] == {
        "min_quality_delta": 0.5, "min_success_rate": 1.0,
        "max_cost_ratio": 2.0, "max_absolute_cost_when_parent_zero": 0.0,
        "max_regressions": 0, "monitor_min_score": 0.0,
        "monitor_min_success_rate": 1.0,
    }
    assert plan["arm_schedule"] == [
        {"task_ref_digest": digest(task),
         "arms": ["parent", "candidate"] if index % 2 == 0
         else ["candidate", "parent"]}
        for index, task in enumerate(plan["suite"]["tasks"])
    ]
    assert plan["environment_digest"] == digest(plan["environment"])
    assert plan["environment"]["schema"] == "nexgent.task-execution-environment.v1"
    assert plan["environment"]["task_service_source_digest"]
    assert plan["environment"]["model_receipts"] == "recorded-per-episode-not-gated"
    assert "model_configuration" in plan["environment"]
    trial = evolution.run_pair(plan["id"], adapter)
    assert trial["plan_id"] == plan["id"]
    assert trial["policy_digest"] == plan["policy_digest"]
    first = evolution.assess(trial["id"])
    second = evolution.assess(trial["id"])
    assert first["id"] == second["id"]


def test_paired_arms_share_frozen_memory_seed_and_host_owned_split_role(tmp_path):
    tasks, evolution, parent, child, candidate = prepare(tmp_path)
    seed_episode = tasks.create("seed selection memory", package=parent,
                                context={"split": "selection"})
    tasks.store.remember(seed_episode["id"], {"lesson": "same initial evidence"})
    adapter = PairedBenchmark()
    trial = evolution.evaluate_pair(candidate["id"], adapter, split="selection",
                                    split_role="selection")
    for pair in trial["pairs"]:
        parent_state = tasks.store.get(pair["parent"]["episode_id"])
        candidate_state = tasks.store.get(pair["candidate"]["episode_id"])
        parent_snapshot = tasks.store.memory_snapshot(
            parent_state["memory_snapshot_id"], parent_state["id"])
        candidate_snapshot = tasks.store.memory_snapshot(
            candidate_state["memory_snapshot_id"], candidate_state["id"])
        parent_refs = parent_snapshot["item_version_refs"]
        candidate_refs = candidate_snapshot["item_version_refs"]
        assert parent_refs == candidate_refs
        assert pair["memory_seed_digest"]
        for state in (parent_state, candidate_state):
            registration = state["task"]["context"]["evolution_registration"]
            assert registration["split_role"] == "selection"
            assert state["task"]["context"]["memory_writeback"] is False


def test_p3_cost_uses_authoritative_charged_tool_work():
    assert EvolutionService._cost({
        "model_calls": 0, "charged_completion_tokens": 0,
        "tool_calls": 1, "charged_tool_work_units": 17, "nodes": 0,
        # A lower measured value cannot reduce charged cost.
        "tool_work_units": 2,
    }) == 18
