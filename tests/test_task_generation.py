from copy import deepcopy
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexgent.tasks.evolution import EvolutionService
from nexgent.tasks.evolution_view import public_evolution_event
from nexgent.tasks.generation import GenerationService, PATCH_SCHEMA, PATCH_SCHEMA_V2
from nexgent.tasks import improvers as improver_module
from nexgent.tasks.improvers import ImproverService
from nexgent.tasks.improver_seed import default_improver_package
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


def v2_target_package():
    return make_package(
        {"main.py": PARENT_SOURCE},
        {"manifest_version": 2, "entries": {"execute": "main.py:execute"},
         "skills": {}, "roles": {}, "workflows": {},
         "components": {
             "orchestrator": {"class": "O", "kind": "entry", "ref": "execute"}},
         "orchestrator": "orchestrator"},
        provenance={"fixture": "generation-target-v2"})


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


def v2_improver_package(patch):
    source = """def improve(payload, context):
    components = context.read_artifact(payload['input_refs']['parent_components'])['content']
    policy = context.read_artifact(payload['input_refs']['mutation_policy'])['content']
    context.read_artifact(payload['input_refs']['feedback_bundle'])
    if components[0]['component_id'] != 'orchestrator':
        raise ValueError('missing stable component identity')
    if policy['resolved_components']['orchestrator']['files'] != ['main.py']:
        raise ValueError('missing host resolution')
    artifact = context.publish(PATCH, name='behavior_patch')
    return {'deliverables': {'behavior_patch': artifact['id']}}
""".replace("PATCH", repr(patch))
    return make_package(
        {"improver.py": source},
        {"entries": {"execute": "improver.py:improve", "improve": "improver.py:improve"}},
        provenance={"fixture": "v2-component-improver"})


def policy(*paths):
    paths = list(paths or ("main.py",))
    return {"mutable_paths": paths, "component_classes": {path: "O" for path in paths},
            "allowed_operations": ["replace", "add", "remove"],
            "max_patch_bytes": 100000}


def v2_policy(*component_ids):
    return {"mutable_components": list(component_ids or ("orchestrator",)),
            "allowed_operations": ["replace"], "max_patch_bytes": 100000}


def v2_behavior_patch(parent, *, component_id="orchestrator", content=CHILD_SOURCE):
    return {"schema": PATCH_SCHEMA_V2,
            "hypothesis": {
                "component_id": component_id,
                "failure_mechanism": "The parent emits the old behavior.",
                "expected_behavior": "The target component emits the new behavior.",
                "applicability": "Tasks using the declared component.",
                "falsifier": "The target component is not loaded or stays unchanged.",
            },
            "operations": [{"op": "replace", "component_id": component_id,
                            "old_digest": parent["component_digests"]["main.py"],
                            "content": content}],
            "activation_probe": {"kind": "component_loaded",
                                 "component_id": component_id}}


def test_v2_mutation_policy_resolves_authoritative_component_identity():
    parent = v2_target_package()
    normalized = GenerationService._mutation_policy(v2_policy(), parent)
    assert normalized["targeting"] == "manifest_component_v2"
    assert normalized["resolved_components"]["orchestrator"] == {
        "component_id": "orchestrator", "class": "O", "kind": "entry",
        "ref": "execute", "files": ["main.py"]}
    with pytest.raises(ContractError, match="not legacy paths/classes"):
        GenerationService._mutation_policy(policy(), parent)
    with pytest.raises(ContractError, match="Unknown manifest component"):
        GenerationService._mutation_policy(v2_policy("absent"), parent)
    unsafe_operations = v2_policy()
    unsafe_operations["allowed_operations"] = ["replace", "remove"]
    with pytest.raises(ContractError, match="only replacement"):
        GenerationService._mutation_policy(unsafe_operations, parent)

    shared_manifest = deepcopy(parent["manifest"])
    shared_manifest["components"]["shared-resource"] = {
        "class": "O", "kind": "resource", "ref": "main.py"}
    shared = make_package(parent["files"], shared_manifest,
                          provenance={"fixture": "shared-component-file"})
    with pytest.raises(ContractError, match="shares its file"):
        GenerationService._mutation_policy(v2_policy(), shared)

    memory_manifest = deepcopy(parent["manifest"])
    memory_manifest["components"]["memory-policy"] = {
        "class": "M", "kind": "resource", "ref": "memory.txt"}
    memory_parent = make_package(
        {**parent["files"], "memory.txt": "frozen memory policy"}, memory_manifest,
        provenance={"fixture": "memory-component"})
    memory_policy = GenerationService._mutation_policy(
        v2_policy("memory-policy"), memory_parent)
    assert memory_policy["targeting"] == "manifest_memory_component_v2"
    assert memory_policy["resolved_components"]["memory-policy"] == {
        "component_id": "memory-policy", "class": "M", "kind": "resource",
        "ref": "memory.txt", "files": ["memory.txt"]}


def test_v2_generation_targets_component_id_and_records_resolved_identity(tmp_path):
    parent = v2_target_package()
    patch = v2_behavior_patch(parent)
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    evolution.register("general", parent)
    episode_id = feedback_episode(tasks, parent, evaluate=False)
    bundle = generation.capture_feedback("general", [episode_id], expected_revision=0)

    result = generation.generate(
        "general", bundle["id"], v2_improver_package(patch), v2_policy(), 0)

    assert result["status"] == "generated"
    assert result["patch_contract"] == PATCH_SCHEMA_V2
    assert result["targeting"] == "manifest_component_v2"
    assert result["legacy_path_patch"] is False
    assert result["component_id"] == "orchestrator"
    assert result["component_target"] == {
        "component_id": "orchestrator", "class": "O", "kind": "entry",
        "ref": "execute", "files": ["main.py"]}
    candidate = evolution.candidate(result["candidate_id"])
    assert candidate["component_id"] == "orchestrator"
    assert candidate["component_classes"] == {"orchestrator": "O"}
    assert candidate["activation_probe"] == {
        "kind": "component_loaded", "component_id": "orchestrator"}
    child = tasks.store.package(result["candidate_package_id"])
    assert child["manifest"] == parent["manifest"]
    assert child["files"]["main.py"] == CHILD_SOURCE


def test_v2_patch_cannot_cross_component_or_supply_a_path():
    parent = v2_target_package()
    normalized = GenerationService._mutation_policy(v2_policy(), parent)
    patch = v2_behavior_patch(parent, component_id="absent")
    with pytest.raises(ContractError, match="mutable component id"):
        GenerationService._apply_patch(
            parent, patch, normalized, "generation-test",
            {"id": "feedback-test", "digest": "f" * 64},
            {"id": "package-test", "digest": "i" * 64})
    forged = v2_behavior_patch(parent)
    forged["operations"][0]["path"] = "main.py"
    with pytest.raises(ContractError, match="fields do not match"):
        GenerationService._apply_patch(
            parent, forged, normalized, "generation-test",
            {"id": "feedback-test", "digest": "f" * 64},
            {"id": "package-test", "digest": "i" * 64})


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


class ImproverGatewayFactory:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                owner.calls.append({"role": role, "prompt": prompt,
                                    "payload": deepcopy(payload), "max_tokens": max_tokens})
                receipt = {"call_id": "reference-improver-1", "role": role,
                           "model": "SCRIPTED-IMPROVER", "status": "started",
                           "reserved_completion_tokens": max_tokens,
                           "max_tokens": max_tokens}
                reserve(receipt)
                reserve({**receipt, "status": "completed", "billing_status": "usage_reported",
                         "usage": {"prompt_tokens": 5, "completion_tokens": 7,
                                   "total_tokens": 12}})
                return deepcopy(owner.response)

        return Gateway()


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


def feedback_package(feedback_statements):
    source = """def execute(payload, context):
    artifact = context.publish({'version': 0}, name='result')
FEEDBACK
    return {'deliverables': {'result': artifact['id']}}
""".replace("FEEDBACK", "\n".join("    " + line for line in feedback_statements))
    return make_package(
        {"main.py": source}, {"entries": {"execute": "main.py:execute"}},
        provenance={"fixture": "task-authored-feedback"})


def captured(tmp_path, *, evaluate=True):
    tasks, evolution, generation, parent = prepared(tmp_path)
    episode_id = feedback_episode(tasks, parent, evaluate=evaluate)
    bundle = generation.capture_feedback("general", [episode_id], expected_revision=0)
    return tasks, evolution, generation, parent, episode_id, bundle


def channel_captured(tmp_path):
    parent = target_package()
    gateway = ImproverGatewayFactory(behavior_patch(parent))
    tasks = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    evolution.register("general", parent)
    episode_id = feedback_episode(tasks, parent, evaluate=False)
    bundle = generation.capture_feedback("general", [episode_id], expected_revision=0)
    improver = default_improver_package()
    ImproverService(tasks).register(
        "recursive", improver,
        {"mutable_paths": ["improver.py"], "allowed_operations": ["replace"]})
    return tasks, generation, bundle, gateway


def generation_with_channel(generation, bundle):
    return generation.generate(
        "general", bundle["id"], None, policy(), 0,
        improver_channel="recursive", expected_improver_revision=0,
        budget={"max_model_calls": 1, "max_completion_tokens": 6000,
                "max_tool_calls": 0, "max_nodes": 8})


def test_feedback_bundle_is_immutable_bounded_and_excludes_hidden_evaluator_content(tmp_path):
    tasks, evolution, generation, parent, episode_id, bundle = captured(tmp_path)
    serialized = json.dumps(bundle, ensure_ascii=False)
    assert bundle["parent_package_id"] == parent["id"]
    assert bundle["episode_refs"][0]["status"] == "completed"
    assert bundle["episode_refs"][0]["evaluation"]["public_metrics"] == {
        "status": "accepted", "score_available": True, "score": 0.25,
        "accepted": True, "execution_status": "completed"}
    assert bundle["episode_refs"][0]["outcome"]["public_status"] == {
        "delivery_status": "delivered", "acceptance_status": "passed",
        "schema_validation": "passed"}
    assert "DO_NOT_EXPOSE_ME" not in serialized
    assert all("content" not in item for item in bundle["episode_refs"][0]["artifacts"])
    assert all(set(item) == {"sequence", "kind", "digest"}
               for item in bundle["episode_refs"][0]["events"])
    trace = bundle["episode_refs"][0]["execution_trace"]
    assert trace["failure_domain"] is None
    assert trace["nodes"]
    assert all(not ({"request", "result", "arguments", "prompt", "payload"} & set(node))
               for node in trace["nodes"])
    assert generation.feedback(bundle["id"])["record_digest"] == bundle["record_digest"]


def test_feedback_bundle_projects_only_bounded_task_authored_public_signals(tmp_path):
    secret = "PRIVATE_PROMPT_CREDENTIAL_MUST_NOT_CROSS_THE_BOUNDARY"
    parent = feedback_package([
        "context.feedback({'valid': False, 'passed': True, "
        "'failure_code': 'schema_mismatch', "
        "'artifact_refs': [artifact['id'], 'artifact-not-local', 7], "
        f"'summary': {secret!r}, 'prompt': {secret!r}, "
        f"'credentials': {{'token': {secret!r}}}, "
        f"'evaluator_private': {secret!r}}})",
        "context.feedback({'valid': 'yes', 'failure_code': 'api_key_leaked', "
        f"'private': {secret!r}}})",
        "context.feedback({'failure_code': 'confidentialprojectcodename'})",
    ])
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    evolution.register("general", parent)
    episode_id = feedback_episode(tasks, parent, evaluate=False)

    bundle = generation.capture_feedback("general", [episode_id], expected_revision=0)

    episode = bundle["episode_refs"][0]
    claims = episode["public_feedback"]
    feedback_digests = [event["digest"] for event in episode["events"]
                        if event["kind"] == "feedback"]
    assert [claim["event_digest"] for claim in claims] == feedback_digests
    assert all(claim["source"] == "task_agent" for claim in claims)
    assert claims[0]["claim_status"] == "unverified"
    assert claims[0]["signals"] == {"valid": False, "passed": True}
    assert claims[0]["failure_code"] == "schema_mismatch"
    assert len(claims[0]["artifact_refs"]) == 1
    assert claims[0]["artifact_refs"][0] == episode["artifacts"][0]["id"]
    assert claims[1]["signals"] == {}
    assert "failure_code" not in claims[1]
    assert claims[2]["signals"] == {}
    assert "failure_code" not in claims[2]
    serialized = json.dumps(bundle, ensure_ascii=False)
    assert secret not in serialized
    assert "artifact-not-local" not in serialized
    assert "api_key_leaked" not in serialized
    assert "confidentialprojectcodename" not in serialized


@pytest.mark.parametrize("feedback_statements,reason", [
    (["context.feedback({'note': " + repr("x" * 16_385) + "})"], "capture bound"),
    (["context.feedback({'valid': True})"] * 33, "too many"),
])
def test_feedback_projection_rejects_oversized_or_excessive_claims(
        tmp_path, feedback_statements, reason):
    parent = feedback_package(feedback_statements)
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    evolution.register("general", parent)
    episode_id = feedback_episode(tasks, parent, evaluate=False)

    with pytest.raises(ContractError, match=reason):
        generation.capture_feedback("general", [episode_id], expected_revision=0)


def test_feedback_projection_rejects_tampered_event_before_reading_claim(tmp_path):
    parent = feedback_package(["context.feedback({'valid': True})"])
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    evolution.register("general", parent)
    episode_id = feedback_episode(tasks, parent, evaluate=False)
    with tasks.store.connect() as db:
        row = db.execute(
            "SELECT data FROM task_events WHERE episode=? AND kind='feedback'",
            (episode_id,)).fetchone()
        content = json.loads(row[0])
        content["content"] = {"valid": False, "secret": "TAMPERED_PRIVATE_VALUE"}
        db.execute(
            "UPDATE task_events SET data=? WHERE episode=? AND kind='feedback'",
            (json.dumps(content), episode_id))

    with pytest.raises(ContractError, match="journal integrity"):
        generation.capture_feedback("general", [episode_id], expected_revision=0)


def test_reference_improver_prompt_separates_quality_from_protocol_failure():
    prompt = default_improver_package()["files"]["prompts/improve.md"]
    assert "schema_validation=passed" in prompt
    assert "did not fail publication" in prompt
    assert "Digests prove identity only" in prompt
    assert "object-schema deliverable remains the complete object" in prompt
    assert "abstain instead of selecting one speculatively" in prompt


def test_feedback_execution_trace_hashes_package_controlled_role_names(tmp_path):
    secret = "PRIVATE_ROLE_ENCODES_TASK_CONTENT"
    source = """def execute(payload, context):
    context.ask('PRIVATE_ROLE_ENCODES_TASK_CONTENT', 'fixed prompt', {})
    artifact = context.publish({'version': 0}, name='result')
    return {'deliverables': {'result': artifact['id']}}
"""
    parent = make_package(
        {"main.py": source}, {"entries": {"execute": "main.py:execute"}},
        provenance={"fixture": "adversarial-role"})
    gateway = ImproverGatewayFactory({"ok": True})
    tasks = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    evolution.register("general", parent)
    episode_id = feedback_episode(tasks, parent, evaluate=False)

    bundle = generation.capture_feedback("general", [episode_id], expected_revision=0)
    serialized = json.dumps(bundle, ensure_ascii=False)
    ask_nodes = [node for node in bundle["episode_refs"][0]["execution_trace"]["nodes"]
                 if node["method"] == "ask"]
    assert secret not in serialized
    assert len(ask_nodes) == 1 and "role_digest" in ask_nodes[0]
    assert "role" not in ask_nodes[0]


def test_builtin_reference_improver_executes_one_model_call_and_admits_os_patch(tmp_path):
    parent = target_package()
    patch = behavior_patch(parent)
    gateway = ImproverGatewayFactory(patch)
    tasks = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    evolution.register("general", parent)
    episode_id = feedback_episode(tasks, parent, evaluate=False)
    bundle = generation.capture_feedback("general", [episode_id], expected_revision=0)

    improver = default_improver_package()
    result = generation.generate(
        "general", bundle["id"], improver, policy(), 0,
        budget={"max_model_calls": 1, "max_completion_tokens": 6000,
                "max_tool_calls": 0, "max_nodes": 8})

    assert result["status"] == "generated"
    assert result["patch_contract"] == PATCH_SCHEMA
    assert result["targeting"] == "legacy_path_v1"
    assert result["legacy_path_patch"] is True
    assert result["improver_package_id"] == improver["id"]
    assert result["usage"]["model_calls"] == 1
    assert result["usage"]["usage_complete"] is True
    assert result["execution"]["entry"] == "improve"
    assert len(gateway.calls) == 1
    assert gateway.calls[0]["role"] == "rsi_improver"
    assert gateway.calls[0]["payload"]["feedback_bundle"]["id"] == bundle["id"]
    assert gateway.calls[0]["payload"]["parent_components"][0]["path"] == "main.py"
    child = tasks.store.package(result["candidate_package_id"])
    assert child["files"]["main.py"] == CHILD_SOURCE


def test_builtin_reference_improver_emits_manifest_component_v2_patch(tmp_path):
    parent = v2_target_package()
    gateway = ImproverGatewayFactory(v2_behavior_patch(parent))
    tasks = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    evolution.register("general", parent)
    episode_id = feedback_episode(tasks, parent, evaluate=False)
    bundle = generation.capture_feedback("general", [episode_id], expected_revision=0)

    improver = default_improver_package()
    result = generation.generate(
        "general", bundle["id"], improver, v2_policy(), 0,
        budget={"max_model_calls": 1, "max_completion_tokens": 6000,
                "max_tool_calls": 0, "max_nodes": 8})

    assert result["status"] == "generated", result.get("reason")
    assert result["patch_contract"] == PATCH_SCHEMA_V2
    assert result["targeting"] == "manifest_component_v2"
    assert result["component_id"] == "orchestrator"
    assert result["component_target"] == {
        "component_id": "orchestrator", "class": "O", "kind": "entry",
        "ref": "execute", "files": ["main.py"]}
    assert len(gateway.calls) == 1
    model_input = gateway.calls[0]["payload"]
    assert model_input["mutation_policy"]["targeting"] == "manifest_component_v2"
    assert model_input["parent_components"][0]["component_id"] == "orchestrator"
    assert model_input["parent_components"][0]["digest"] == \
        parent["component_digests"]["main.py"]
    child = tasks.store.package(result["candidate_package_id"])
    assert child["manifest"] == parent["manifest"]
    assert child["files"]["main.py"] == CHILD_SOURCE


@pytest.mark.parametrize("injected_field,injected_value", [
    ("path", "main.py"),
    ("class", "O"),
])
def test_builtin_reference_improver_rejects_v2_path_or_class_injection(
        tmp_path, injected_field, injected_value):
    parent = v2_target_package()
    patch = v2_behavior_patch(parent)
    patch["operations"][0][injected_field] = injected_value
    gateway = ImproverGatewayFactory(patch)
    tasks = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    evolution.register("general", parent)
    episode_id = feedback_episode(tasks, parent, evaluate=False)
    bundle = generation.capture_feedback("general", [episode_id], expected_revision=0)

    result = generation.generate(
        "general", bundle["id"], default_improver_package(), v2_policy(), 0,
        budget={"max_model_calls": 1, "max_completion_tokens": 6000,
                "max_tool_calls": 0, "max_nodes": 8})

    assert result["status"] == "missing"
    assert "operation fields" in result["reason"].casefold()
    assert result["candidate_id"] is None and result["candidate_package_id"] is None
    assert not [event for event in evolution.events("general")
                if event["kind"] == "candidate_admitted"]


def test_improver_channel_drift_before_episode_create_runs_nothing(
        tmp_path, monkeypatch):
    tasks, generation, bundle, gateway = channel_captured(tmp_path)
    real_registration = improver_module.active_improver_registration
    calls = 0

    def drift_after_initial_resolution(store, channel):
        nonlocal calls
        calls += 1
        registration = real_registration(store, channel)
        if calls >= 2:
            registration = {**registration, "revision": registration["revision"] + 1}
        return registration

    monkeypatch.setattr(
        improver_module, "active_improver_registration", drift_after_initial_resolution)
    episode_ids = {state["id"] for state in tasks.store.list()}

    result = generation_with_channel(generation, bundle)

    assert result["status"] == "missing"
    assert result["episode_id"] is None
    assert {state["id"] for state in tasks.store.list()} == episode_ids
    assert gateway.calls == []


def test_improver_channel_drift_before_episode_run_never_starts_package(
        tmp_path, monkeypatch):
    tasks, generation, bundle, gateway = channel_captured(tmp_path)
    real_registration = improver_module.active_improver_registration
    calls = 0

    def drift_at_dispatch(store, channel):
        nonlocal calls
        calls += 1
        registration = real_registration(store, channel)
        if calls >= 3:
            registration = {**registration, "revision": registration["revision"] + 1}
        return registration

    monkeypatch.setattr(improver_module, "active_improver_registration", drift_at_dispatch)
    episode_ids = {state["id"] for state in tasks.store.list()}

    result = generation_with_channel(generation, bundle)

    assert result["status"] == "missing"
    assert result["episode_id"] not in episode_ids
    assert result["episode_status"] == "ready"
    episode = tasks.get(result["episode_id"])
    assert episode["status"] == "ready"
    assert not [event for event in episode["events"]
                if event["kind"] == "episode_started"]
    assert gateway.calls == []


@pytest.mark.parametrize("response,component_class,expected_calls", [
    ({"decision": "abstain", "reason": "insufficient evidence"}, "O", 1),
    ({"unused": True}, "M", 0),
])
def test_builtin_reference_improver_abstains_and_refuses_memory_mutation(
        tmp_path, response, component_class, expected_calls):
    parent = target_package()
    gateway = ImproverGatewayFactory(response)
    tasks = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    evolution.register("general", parent)
    episode_id = feedback_episode(tasks, parent, evaluate=False)
    bundle = generation.capture_feedback("general", [episode_id], expected_revision=0)
    mutation = {"mutable_paths": ["main.py"],
                "component_classes": {"main.py": component_class},
                "allowed_operations": ["replace"], "max_patch_bytes": 30000}

    result = generation.generate(
        "general", bundle["id"], default_improver_package(), mutation, 0,
        budget={"max_model_calls": 1, "max_completion_tokens": 6000,
                "max_tool_calls": 0, "max_nodes": 8})

    assert result["status"] == "missing"
    assert result["candidate_id"] is None
    assert len(gateway.calls) == expected_calls
    assert not [event for event in evolution.events("general")
                if event["kind"] == "candidate_admitted"]


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
    assert candidate["targeting"] == "legacy_path_v1"
    assert candidate["legacy_path_patch"] is True
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


def test_missing_generation_keeps_private_reason_internal_and_redacts_public_event(tmp_path):
    secret = "PRIVATE_FEEDBACK_MUST_NOT_REACH_PUBLIC_SURFACES"
    tasks, evolution, generation, parent, episode_id, bundle = captured(
        tmp_path, evaluate=False)
    source = "def improve(payload, context):\n    raise ValueError('" + secret + "')\n"
    improver = make_package(
        {"improver.py": source},
        {"entries": {"execute": "improver.py:improve", "improve": "improver.py:improve"}},
        provenance={"fixture": "adversarial-error"})

    result = generation.generate("general", bundle["id"], improver, policy(), 0)
    event = [event for event in evolution.events("general")
             if event["kind"] == "candidate_generation_missing"][-1]
    public = public_evolution_event(event)

    assert secret in result["reason"]  # retained only in the host-owned immutable record
    assert result["reason_type"] == "PackageError"
    assert result["reason_digest"]
    assert secret not in json.dumps(event, ensure_ascii=False)
    assert secret not in json.dumps(public, ensure_ascii=False)
    assert set(public["content"]) >= {"reason_type", "reason_digest"}


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
