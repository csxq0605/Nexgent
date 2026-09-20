from copy import deepcopy
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexgent.tasks.evolution import EvolutionService
from nexgent.tasks.generation import GenerationService, PATCH_SCHEMA
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ContractError, ToolRegistry


PARENT_SOURCE = """def execute(payload, context):
    artifact = context.publish({'version': 0}, name='result')
    return {'deliverables': {'result': artifact['id']}}
"""

CHILD_SOURCE = """def execute(payload, context):
    artifact = context.publish({'version': 1}, name='result')
    return {'deliverables': {'result': artifact['id']}}
"""


def target_package(version=0, parent=None):
    source = PARENT_SOURCE if version == 0 else CHILD_SOURCE
    return make_package(
        {"main.py": source}, {"entries": {"execute": "main.py:execute"}},
        parent=parent, provenance={"fixture": "generation-target", "version": version})


def improver_package(patch=None, *, mode="patch"):
    if mode == "raise":
        source = "def improve(payload, context):\n    raise ValueError('controlled improver failure')\n"
    elif mode == "missing":
        source = """def improve(payload, context):
    context.read_artifact(payload['input_refs']['feedback_bundle'])
    return {'deliverables': {}}
"""
    else:
        source = """def improve(payload, context):
    feedback = context.read_artifact(payload['input_refs']['feedback_bundle'])['content']
    components = context.read_artifact(payload['input_refs']['parent_components'])['content']
    policy = context.read_artifact(payload['input_refs']['mutation_policy'])['content']
    if feedback['schema'] != 'nexgent.feedback-bundle.v1':
        raise ValueError('wrong feedback contract')
    if not components or components[0]['path'] not in policy['mutable_paths']:
        raise ValueError('missing parent identity')
    artifact = context.publish(PATCH, name='behavior_patch')
    return {'deliverables': {'behavior_patch': artifact['id']}}
""".replace("PATCH", repr(patch))
    return make_package(
        {"improver.py": source},
        {"entries": {"execute": "improver.py:improve", "improve": "improver.py:improve"}},
        provenance={"fixture": "independent-improver", "mode": mode})


def policy(*paths):
    paths = list(paths or ("main.py",))
    return {"mutable_paths": paths, "component_classes": {path: "O" for path in paths},
            "allowed_operations": ["replace", "add", "remove"],
            "max_patch_bytes": 100000}


def behavior_patch(parent, *, op="replace", path="main.py", content=CHILD_SOURCE,
                   old_digest=None):
    operation = {"op": op, "path": path}
    if op in {"replace", "remove"}:
        operation["old_digest"] = (parent["component_digests"].get(path)
                                   if old_digest is None else old_digest)
    if op in {"replace", "add"}:
        operation["content"] = content
    return {"schema": PATCH_SCHEMA,
            "hypothesis": {
                "failure_mechanism": "The parent emits the old behavior.",
                "expected_behavior": "The changed component emits the new behavior.",
                "applicability": "Tasks using the execute entry.",
                "falsifier": "The changed component is not loaded or the output stays unchanged.",
            },
            "operations": [operation],
            "activation_probe": {"kind": "component_loaded", "path": path}}


class PublicEvaluation:
    def snapshot(self):
        return {"evaluator_digest": "frozen-test-evaluator"}

    def evaluate(self, task_ref, deliverables, execution_view):
        return {"status": "accepted", "score_available": True, "score": 0.25,
                "accepted": True, "private_hidden_answer": "DO_NOT_EXPOSE_ME"}


def prepared(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    parent = target_package()
    evolution.register("general", parent)
    return tasks, evolution, generation, parent


def feedback_episode(tasks, parent, *, split="development", split_role="development",
                     run=True, evaluate=False):
    context = {"split": split, "split_role": split_role}
    state = tasks.create(
        "Observe public task behavior", deliverables=[{"name": "result", "schema": {
            "type": "object", "required": ["version"]}}], package=parent, context=context)
    if run:
        state = tasks.run(state["id"])
    if evaluate:
        tasks.evaluate(state["id"], PublicEvaluation(),
                       {"id": "development-row", "context": context},
                       snapshot=PublicEvaluation().snapshot())
    return state["id"]


def captured(tmp_path, *, evaluate=True):
    tasks, evolution, generation, parent = prepared(tmp_path)
    episode_id = feedback_episode(tasks, parent, evaluate=evaluate)
    bundle = generation.capture_feedback("general", [episode_id], expected_revision=0)
    return tasks, evolution, generation, parent, episode_id, bundle


def test_feedback_bundle_is_immutable_bounded_and_excludes_hidden_evaluator_content(tmp_path):
    tasks, evolution, generation, parent, episode_id, bundle = captured(tmp_path)
    serialized = json.dumps(bundle, ensure_ascii=False)
    assert bundle["parent_package_id"] == parent["id"]
    assert bundle["episode_refs"][0]["status"] == "completed"
    assert bundle["episode_refs"][0]["evaluation"]["public_metrics"] == {
        "status": "accepted", "score_available": True, "score": 0.25,
        "accepted": True, "execution_status": "completed"}
    assert "DO_NOT_EXPOSE_ME" not in serialized
    assert all("content" not in item for item in bundle["episode_refs"][0]["artifacts"])
    assert all(set(item) == {"sequence", "kind", "digest"}
               for item in bundle["episode_refs"][0]["events"])
    assert generation.feedback(bundle["id"])["record_digest"] == bundle["record_digest"]


@pytest.mark.parametrize("case", ["ready", "selection", "monitoring", "holdout", "wrong_package"])
def test_feedback_capture_rejects_nonterminal_nondevelopment_and_wrong_parent(tmp_path, case):
    tasks, evolution, generation, parent = prepared(tmp_path)
    if case == "ready":
        episode_id = feedback_episode(tasks, parent, run=False)
    elif case == "selection":
        episode_id = feedback_episode(tasks, parent, split="selection", split_role="selection")
    elif case == "monitoring":
        episode_id = feedback_episode(tasks, parent, split="guard", split_role="monitoring")
    elif case == "holdout":
        episode_id = feedback_episode(tasks, parent, split="final_holdout", split_role="holdout")
    else:
        episode_id = feedback_episode(tasks, target_package(version=1))
    with pytest.raises(ContractError, match="terminal|development|active parent"):
        generation.capture_feedback("general", [episode_id], expected_revision=0)


def test_generated_candidate_executes_actual_improve_entry_and_records_receipts(tmp_path):
    tasks, evolution, generation, parent, episode_id, bundle = captured(tmp_path)
    improver = improver_package(behavior_patch(parent))
    result = generation.generate("general", bundle["id"], improver, policy(), 0)

    assert result["status"] == "generated"
    assert result["improver_package_id"] == improver["id"]
    assert result["execution"]["entry"] == "improve"
    assert result["execution"]["package_digest"] == improver["digest"]
    assert result["improver_closure"] == {
        "improver.py": improver["component_digests"]["improver.py"]}
    assert result["improver_closure_digest"]
    assert result["usage"]["model_calls"] == 0
    assert result["usage"]["nodes"] == 4  # three reads and the patch publication

    candidate = evolution.candidate(result["candidate_id"])
    assert candidate["origin"] == "generated"
    assert candidate["activation_probe"] == {"kind": "component_loaded", "path": "main.py"}
    assert candidate["component_classes"]["main.py"] == "O"
    child = tasks.store.package(candidate["package_id"])
    assert child["parent_id"] == parent["id"] and child["files"]["main.py"] == CHILD_SOURCE
    assert child["provenance"] == {
        "origin": "generated", "generation_id": result["id"],
        "feedback_bundle_id": bundle["id"], "feedback_digest": bundle["digest"],
        "improver_package_id": improver["id"], "improver_package_digest": improver["digest"],
        "behavior_patch_digest": result["patch_digest"]}
    receipt = tasks.get(result["episode_id"])
    assert receipt["status"] == "completed" and receipt["task"]["entry"] == "improve"
    assert receipt["task"]["context"]["feedback_bundle_id"] == bundle["id"]
    assert any(event["kind"] == "candidate_generated" for event in evolution.events("general"))


@pytest.mark.parametrize("bad_patch,mutable_paths,reason", [
    (lambda parent: behavior_patch(parent, old_digest="0" * 64), ("main.py",), "old digest"),
    (lambda parent: behavior_patch(parent, content=PARENT_SOURCE), ("main.py",), "must change"),
    (lambda parent: behavior_patch(parent, op="add", path="main.py", content="x = 1\n"),
     ("main.py",), "already exists"),
    (lambda parent: behavior_patch(parent, op="remove", path="absent.py", old_digest="0" * 64),
     ("absent.py",), "old digest"),
    (lambda parent: {"schema": PATCH_SCHEMA, "hypothesis": {
        "failure_mechanism": "old", "expected_behavior": "new",
        "applicability": "task", "falsifier": "unchanged"}, "operations": [
        {"op": "replace", "path": "main.py", "old_digest": parent["component_digests"]["main.py"],
         "content": CHILD_SOURCE, "manifest": {"entries": {}}}],
         "activation_probe": {"kind": "component_loaded", "path": "main.py"}},
     ("main.py",), "additional properties"),
])
def test_invalid_behavior_patch_is_missing_and_never_admitted(tmp_path, bad_patch, mutable_paths, reason):
    tasks, evolution, generation, parent, episode_id, bundle = captured(tmp_path, evaluate=False)
    before = [event for event in evolution.events("general") if event["kind"] == "candidate_admitted"]
    result = generation.generate("general", bundle["id"], improver_package(bad_patch(parent)),
                                 policy(*mutable_paths), 0)
    after = [event for event in evolution.events("general") if event["kind"] == "candidate_admitted"]
    assert result["status"] == "missing" and reason.casefold() in result["reason"].casefold()
    assert result["candidate_id"] is None and result["candidate_package_id"] is None
    assert after == before
    assert generation.generation(result["id"])["record_digest"] == result["record_digest"]


@pytest.mark.parametrize("mode,budget", [
    ("raise", None),
    ("missing", None),
    ("patch", {"max_model_calls": 0, "max_completion_tokens": 0,
               "max_tool_calls": 0, "max_nodes": 0}),
])
def test_failure_budget_and_missing_output_persist_missing_without_admission(tmp_path, mode, budget):
    tasks, evolution, generation, parent, episode_id, bundle = captured(tmp_path, evaluate=False)
    patch = behavior_patch(parent)
    result = generation.generate("general", bundle["id"], improver_package(patch, mode=mode),
                                 policy(), 0, budget=budget)
    assert result["status"] == "missing"
    assert result["episode_id"].startswith("episode-")
    assert result["episode_status"] in {"failed", "paused", "waiting_input"}
    assert result["candidate_id"] is None
    assert not [event for event in evolution.events("general")
                if event["kind"] == "candidate_admitted"]


def test_mutation_policy_freezes_improver_and_forbids_control_plane_paths(tmp_path):
    tasks, evolution, generation, parent, episode_id, bundle = captured(tmp_path, evaluate=False)
    for path in ("evaluator.py", "hidden/answers.py", "permissions.json", "gate.py"):
        with pytest.raises(ContractError, match="evaluator|gate|permission|hidden"):
            generation.generate("general", bundle["id"], improver_package(behavior_patch(parent)),
                                policy(path), 0)


def test_stale_feedback_revision_cannot_generate_against_a_new_parent(tmp_path):
    tasks, evolution, generation, parent, episode_id, bundle = captured(tmp_path, evaluate=False)
    with pytest.raises(ContractError, match="stale"):
        generation.capture_feedback("general", [episode_id], expected_revision=1)
    # A stale caller is rejected before any improver Episode or generation row is created.
    with pytest.raises(ContractError, match="stale"):
        generation.generate("general", bundle["id"], improver_package(behavior_patch(parent)),
                            policy(), 1)
