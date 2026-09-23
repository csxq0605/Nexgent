"""Pure manifest-v2 M component routing into the MemoryService lifecycle."""

from copy import deepcopy
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexgent.kernel.programs import digest
from nexgent.tasks.evolution import EvolutionService
from nexgent.tasks.generation import GenerationService, MEMORY_PATCH_SCHEMA
from nexgent.tasks.improver_seed import default_improver_package
from nexgent.tasks.memory import MemoryService
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ContractError, ToolRegistry


def resource(lesson):
    return {
        "policy": {
            "retrieval": {"kind": "literal-any-term", "version": 1,
                          "max_results": 5},
            "writeback": {"enabled": False, "allowed_kinds": []},
        },
        "data": {"items": [{
            "kind": "experience", "content": {"lesson": lesson},
            "applies_to": [], "counterexamples": [], "evidence_refs": [],
        }]},
    }


def target_package():
    initial = resource("root lesson")
    source = (
        "def execute(payload, context):\n"
        "    items = ([] if payload['context'].get('skip_memory') else "
        "context.memory_search('PRIVATE', 5))\n"
        "    artifact = context.publish({'ok': True, 'matches': len(items)}, name='result')\n"
        "    return {'deliverables': {'result': artifact['id']}}\n")
    return make_package(
        {"main.py": source,
         "memory.json": json.dumps(initial, sort_keys=True, separators=(",", ":"))},
        {"manifest_version": 2, "entries": {"execute": "main.py:execute"},
         "skills": {}, "roles": {}, "workflows": {},
         "components": {
             "orchestrator": {"class": "O", "kind": "entry", "ref": "execute"},
             "working-memory": {"class": "M", "kind": "resource",
                                "ref": "memory.json"}},
         "orchestrator": "orchestrator"},
        provenance={"fixture": "memory-generation-target"})


def accept(memory, identity, *, channel=None, revision=None):
    evaluator = {"id": "memory-evaluator", "revision": 1}
    plan = memory.plan_selection(
        identity, criteria={"minimum": 1}, evaluator_snapshot=evaluator,
        channel=channel, expected_revision=revision)
    decision = memory.assess(
        plan["id"], evaluator_snapshot=evaluator, verdict="accepted",
        reason="deterministic contract fixture", evidence={"score": 1})
    return plan, decision


class GeneratedMemoryEvaluator:
    id = "generated-memory-evaluator"

    def snapshot(self):
        return {"evaluator": self.id, "revision": 1}

    def evaluate(self, task_ref, deliverables, execution_view):
        result = deliverables.get("result") or {}
        accepted = result.get("ok") is True and result.get("matches") == 1
        return {"status": "accepted" if accepted else "rejected",
                "score_available": True, "score": 1.0 if accepted else 0.0,
                "accepted": accepted}


def generated_selection(memory, identity, *, channel, revision):
    adapter = GeneratedMemoryEvaluator()
    plan = memory.plan_selection(
        identity, criteria={"minimum": 1}, evaluator_snapshot=adapter.snapshot(),
        channel=channel, expected_revision=revision)
    task_ref = {
        "objective": "Run the frozen generated memory selection task",
        "deliverables": [{"name": "result", "schema": {
            "type": "object", "required": ["ok", "matches"]}}],
        "context": {"split": "development", "split_role": "development"},
    }
    receipt = memory.evaluate_generated_candidate(
        plan["id"], adapter=adapter, task_ref=task_ref)
    decision = memory.assess(
        plan["id"], evaluator_snapshot=adapter.snapshot(),
        verdict=receipt["verdict"], reason="host selection execution",
        evidence={"selection_execution_id": receipt["id"],
                  "selection_execution_digest": receipt["digest"]})
    return plan, receipt, decision


def memory_patch(parent_version):
    return {
        "schema": MEMORY_PATCH_SCHEMA,
        "hypothesis": {
            "component_id": "working-memory",
            "failure_mechanism": "The active memory omits the selected lesson.",
            "expected_behavior": "The selected memory snapshot contains the new lesson.",
            "applicability": "Episodes using the declared memory component.",
            "falsifier": "The frozen Episode snapshot does not name the promoted memory.",
        },
        "operations": [{
            "op": "replace", "component_id": "working-memory", "surface": "data",
            "old_digest": digest(parent_version["resource"]["data"]),
            "value": resource("PRIVATE_MEMORY_BODY_MARKER")["data"],
        }],
        "activation_probe": {
            "kind": "memory_snapshot_frozen", "component_id": "working-memory"},
    }


def improver_package(patch):
    source = (
        "def improve(payload, context):\n"
        "    components = context.read_artifact(\n"
        "        payload['input_refs']['parent_components'])['content']\n"
        "    policy = context.read_artifact(\n"
        "        payload['input_refs']['mutation_policy'])['content']\n"
        "    if components[0]['memory_registration'] != policy['memory_release']:\n"
        "        raise ValueError('memory release was not frozen')\n"
        f"    artifact = context.publish({patch!r}, name='memory_patch', "
        f"schema={MEMORY_PATCH_SCHEMA!r})\n"
        "    return {'deliverables': {'memory_patch': artifact['id']}}\n")
    return make_package(
        {"improver.py": source},
        {"entries": {"execute": "improver.py:improve",
                     "improve": "improver.py:improve"}},
        provenance={"fixture": "memory-component-improver"})


def prepared(tmp_path, gateway_factory=None):
    tasks = TaskService(tmp_path, tools=ToolRegistry(),
                        gateway_factory=gateway_factory)
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    memory = MemoryService(tasks)
    package = target_package()
    package_registration = evolution.register("agents", package)
    root = memory.admit(package, resource("root lesson"))
    accept(memory, root["id"])
    memory_registration = memory.register("working", root["id"])
    episode = tasks.create(
        "Collect development feedback", package=package,
        memory_channel="working", expected_memory_registration=memory_registration,
        context={"split": "development", "split_role": "development"})
    tasks.run(episode["id"])
    feedback = generation.capture_feedback("agents", [episode["id"]], expected_revision=0)
    return (tasks, evolution, generation, memory, package, package_registration,
            root, memory_registration, feedback)


class ReferenceMemoryGateway:
    def __init__(self, patch):
        self.patch = deepcopy(patch)
        self.calls = []

    def __call__(self, reserve, stop_event):
        owner = self

        class Bound:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                owner.calls.append({"role": role, "prompt": prompt,
                                    "payload": deepcopy(payload),
                                    "max_tokens": max_tokens})
                record = {"call_id": "memory-r0-1", "role": role,
                          "model": "MEMORY-R0-DOUBLE", "status": "started",
                          "reserved_completion_tokens": max_tokens}
                reserve(record)
                reserve({**record, "status": "completed",
                         "billing_status": "usage_reported",
                         "usage": {"prompt_tokens": 1, "completion_tokens": 1,
                                   "total_tokens": 2}})
                return deepcopy(owner.patch)

        return Bound()


def test_default_reference_improver_generates_pure_memory_patch(tmp_path):
    gateway = ReferenceMemoryGateway({})
    (_, evolution, generation, memory, package, package_registration,
     root, memory_registration, feedback) = prepared(tmp_path, gateway)
    gateway.patch = memory_patch(root)
    result = generation.generate(
        "agents", feedback["id"], default_improver_package(),
        {"mutable_components": ["working-memory"],
         "allowed_operations": ["replace"], "max_patch_bytes": 100000},
        package_registration["revision"], memory_channel="working",
        expected_memory_revision=memory_registration["revision"],
        budget={"max_model_calls": 1, "max_completion_tokens": 6000,
                "max_tool_calls": 0, "max_nodes": 12})

    assert result["status"] == "generated", result.get("reason")
    assert result["targeting"] == "manifest_memory_component_v2"
    assert result["patch_contract"] == MEMORY_PATCH_SCHEMA
    assert result["candidate_kind"] == "memory_version"
    assert result["candidate_id"] is None
    candidate = memory.version(result["memory_candidate_id"])
    assert candidate["resource"]["data"]["items"][0]["content"] == {
        "lesson": "PRIVATE_MEMORY_BODY_MARKER"}
    assert evolution.active("agents")["package_id"] == package["id"]
    assert gateway.calls[0]["role"] == "rsi_improver"
    assert gateway.calls[0]["max_tokens"] == 6000
    assert "manifest_memory_component_v2" in gateway.calls[0]["prompt"]
    assert "Parent memory bodies are intentionally unavailable" in gateway.calls[0]["prompt"]
    assert "memory_resource_digest" in gateway.calls[0]["payload"][
        "parent_components"][0]
    assert "content" not in gateway.calls[0]["payload"]["parent_components"][0]


def test_pure_m_generation_routes_through_memory_release_and_episode_snapshot(tmp_path):
    (tasks, evolution, generation, memory, package, package_registration,
     root, memory_registration, feedback) = prepared(tmp_path)
    patch = memory_patch(root)

    result = generation.generate(
        "agents", feedback["id"], improver_package(patch),
        {"mutable_components": ["working-memory"],
         "allowed_operations": ["replace"], "max_patch_bytes": 100000},
        package_registration["revision"], memory_channel="working",
        expected_memory_revision=memory_registration["revision"])

    assert result["status"] == "generated"
    assert result["patch_contract"] == MEMORY_PATCH_SCHEMA
    assert result["targeting"] == "manifest_memory_component_v2"
    assert result["candidate_kind"] == "memory_version"
    assert result["candidate_id"] is None and result["candidate_package_id"] is None
    candidate = memory.version(result["memory_candidate_id"])
    assert candidate["parent_id"] == root["id"]
    assert candidate["package_id"] == package["id"]
    assert candidate["resource"]["policy"] == root["resource"]["policy"]
    assert candidate["resource"]["data"]["items"][0]["content"] == {
        "lesson": "PRIVATE_MEMORY_BODY_MARKER"}
    with tasks.store.connect() as db:
        assert db.execute(
            "SELECT COUNT(*) FROM task_memory_versions WHERE id=?",
            (candidate["id"],)).fetchone()[0] == 1
        assert db.execute(
            "SELECT COUNT(*) FROM task_candidate_generations WHERE id=?",
            (result["id"],)).fetchone()[0] == 1
    assert evolution.active("agents")["revision"] == 0
    assert evolution.active("agents")["package_id"] == package["id"]
    assert memory.active("working") == memory_registration
    assert tasks.store.package(package["id"])["files"] == package["files"]

    _, selection_receipt, _ = generated_selection(
        memory, candidate["id"], channel="working", revision=0)
    assert selection_receipt["memory_consumed"] is True
    selection_episode = tasks.get_private(selection_receipt["episode_id"])
    assert any(event["kind"] == "memory_consumed"
               and event["content"]["snapshot_id"] == selection_receipt["snapshot_id"]
               for event in selection_episode["events"])
    promoted = memory.promote(
        "working", candidate["id"], expected_revision=0,
        expected_memory_id=root["id"])
    frozen_package_registration = {key: package_registration[key] for key in (
        "channel", "revision", "package_id", "package_digest")}
    activated = tasks.create(
        "Observe promoted memory", package_channel="agents",
        expected_package_registration=frozen_package_registration,
        memory_channel="working", expected_memory_registration=promoted)
    snapshot = tasks.store.memory_snapshot(
        activated["memory_snapshot_id"], activated["id"])
    activated = tasks.run(activated["id"])
    assert snapshot["source"] == {key: promoted[key] for key in (
        "channel", "revision", "memory_id", "memory_digest",
        "package_id", "package_digest")}
    assert snapshot["items"][0]["content"] == {
        "lesson": "PRIVATE_MEMORY_BODY_MARKER"}
    consumed = [event for event in activated["events"]
                if event["kind"] == "memory_consumed"]
    assert len(consumed) == 1
    assert consumed[0]["content"]["snapshot_id"] == snapshot["id"]
    assert consumed[0]["content"]["item_ids"] == [snapshot["items"][0]["id"]]
    assert "PRIVATE_MEMORY_BODY_MARKER" not in json.dumps(
        tasks.get(result["episode_id"]), sort_keys=True)
    assert "PRIVATE_MEMORY_BODY_MARKER" not in json.dumps(
        memory.public_version(candidate["id"]), sort_keys=True)
    assert "PRIVATE_MEMORY_BODY_MARKER" not in json.dumps(
        tasks.get(activated["id"]), sort_keys=True)


def test_mixed_os_and_m_policy_is_rejected_as_one_patch(tmp_path):
    tasks, _, generation, _, package, *_ = prepared(tmp_path)
    episode_count = len(tasks.store.list())
    with pytest.raises(ContractError, match="O/S and M"):
        generation._mutation_policy(
            {"mutable_components": ["orchestrator", "working-memory"],
             "allowed_operations": ["replace"]}, package)
    assert len(tasks.store.list()) == episode_count


def test_multiple_m_and_non_resource_m_are_rejected_before_generation(tmp_path):
    package = target_package()
    multiple_manifest = deepcopy(package["manifest"])
    multiple_manifest["components"]["archive-memory"] = {
        "class": "M", "kind": "resource", "ref": "archive.json"}
    multiple = make_package(
        {**package["files"], "archive.json": json.dumps(resource("archive"))},
        multiple_manifest, provenance={"fixture": "multiple-memory-components"})
    with pytest.raises(ContractError, match="exactly one M component"):
        GenerationService._mutation_policy(
            {"mutable_components": ["working-memory", "archive-memory"],
             "allowed_operations": ["replace"]}, multiple)

    role_manifest = deepcopy(package["manifest"])
    role_manifest["roles"]["memory-role"] = {
        "prompt_ref": "memory-prompt.txt", "capabilities": []}
    role_manifest["components"]["memory-role-component"] = {
        "class": "M", "kind": "role", "ref": "memory-role"}
    non_resource = make_package(
        {**package["files"], "memory-prompt.txt": "bounded memory prompt"},
        role_manifest, provenance={"fixture": "non-resource-memory-component"})
    with pytest.raises(ContractError, match="manifest resource"):
        GenerationService._mutation_policy(
            {"mutable_components": ["memory-role-component"],
             "allowed_operations": ["replace"]}, non_resource)


def test_generated_memory_candidate_without_generation_record_cannot_select(tmp_path):
    (_, _, _, memory, package, _, root,
     memory_registration, _) = prepared(tmp_path)
    orphan = memory.admit(
        package, resource("orphan generated lesson"), parent_id=root["id"],
        provenance={
            "origin": "generated_memory_component",
            "generation_id": "generation-orphan",
            "feedback_bundle_id": "feedback-orphan",
        })
    with pytest.raises(ContractError, match="no generation closure"):
        memory.plan_selection(
            orphan["id"], criteria={"minimum": 1},
            evaluator_snapshot={"id": "memory-evaluator", "revision": 1},
            channel="working", expected_revision=memory_registration["revision"])
    assert memory.version(orphan["id"])["status"] == "candidate"


def test_invalid_memory_patch_is_missing_and_admits_no_memory_candidate(tmp_path):
    (_, _, generation, memory, _, package_registration, root,
     memory_registration, feedback) = prepared(tmp_path)
    patch = memory_patch(root)
    patch["operations"][0]["old_digest"] = "0" * 64

    result = generation.generate(
        "agents", feedback["id"], improver_package(patch),
        {"mutable_components": ["working-memory"],
         "allowed_operations": ["replace"]},
        package_registration["revision"], memory_channel="working",
        expected_memory_revision=memory_registration["revision"])

    assert result["status"] == "missing"
    assert "old digest" in result["reason"].casefold()
    assert result["memory_candidate_id"] is None
    assert memory.list_versions(parent_id=root["id"]) == []


def test_package_channel_drift_blocks_generated_memory_promotion(tmp_path):
    (tasks, _, generation, memory, _, package_registration, root,
     memory_registration, feedback) = prepared(tmp_path)
    result = generation.generate(
        "agents", feedback["id"], improver_package(memory_patch(root)),
        {"mutable_components": ["working-memory"],
         "allowed_operations": ["replace"]},
        package_registration["revision"], memory_channel="working",
        expected_memory_revision=memory_registration["revision"])
    candidate_id = result["memory_candidate_id"]
    generated_selection(memory, candidate_id, channel="working", revision=0)

    with tasks.store.connect() as db:
        row = db.execute(
            "SELECT data FROM task_package_channels WHERE name='agents'").fetchone()
        drifted = json.loads(row[0])
        drifted["revision"] = 1
        db.execute(
            "UPDATE task_package_channels SET revision=?,data=? WHERE name='agents'",
            (1, json.dumps(drifted, sort_keys=True, separators=(",", ":"))))
    with pytest.raises(ContractError, match="package release changed"):
        memory.promote(
            "working", candidate_id, expected_revision=0,
            expected_memory_id=root["id"])
    assert memory.active("working")["memory_id"] == root["id"]


def test_generated_assessment_requires_host_execution_and_real_consumption(tmp_path):
    (_, _, generation, memory, _, package_registration, root,
     memory_registration, feedback) = prepared(tmp_path)
    result = generation.generate(
        "agents", feedback["id"], improver_package(memory_patch(root)),
        {"mutable_components": ["working-memory"],
         "allowed_operations": ["replace"]},
        package_registration["revision"], memory_channel="working",
        expected_memory_revision=memory_registration["revision"])
    candidate_id = result["memory_candidate_id"]
    adapter = GeneratedMemoryEvaluator()
    plan = memory.plan_selection(
        candidate_id, criteria={"minimum": 1}, evaluator_snapshot=adapter.snapshot(),
        channel="working", expected_revision=0)
    with pytest.raises(ContractError, match="selection execution receipt"):
        memory.assess(
            plan["id"], evaluator_snapshot=adapter.snapshot(), verdict="accepted",
            reason="forged caller verdict", evidence={"score": 1})

    task_ref = {
        "objective": "Run without consuming candidate memory",
        "deliverables": [{"name": "result", "schema": {
            "type": "object", "required": ["ok", "matches"]}}],
        "context": {"split": "development", "split_role": "development",
                    "skip_memory": True},
    }
    receipt = memory.evaluate_generated_candidate(
        plan["id"], adapter=adapter, task_ref=task_ref)
    assert receipt["memory_consumed"] is False
    assert receipt["verdict"] == "rejected"
    evidence = {"selection_execution_id": receipt["id"],
                "selection_execution_digest": receipt["digest"]}
    with pytest.raises(ContractError, match="must match"):
        memory.assess(
            plan["id"], evaluator_snapshot=adapter.snapshot(), verdict="accepted",
            reason="cannot accept unconsumed memory", evidence=evidence)
    decision = memory.assess(
        plan["id"], evaluator_snapshot=adapter.snapshot(), verdict="rejected",
        reason="candidate memory was not consumed", evidence=evidence)
    assert decision["verdict"] == "rejected"


def test_public_redaction_follows_memory_patch_output_ref_and_closure_checks_name(tmp_path):
    (tasks, _, generation, memory, _, package_registration, root,
     memory_registration, feedback) = prepared(tmp_path)
    result = generation.generate(
        "agents", feedback["id"], improver_package(memory_patch(root)),
        {"mutable_components": ["working-memory"],
         "allowed_operations": ["replace"]},
        package_registration["revision"], memory_channel="working",
        expected_memory_revision=memory_registration["revision"])
    episode = tasks.get_private(result["episode_id"])
    artifact_id = episode["output_refs"]["memory_patch"]
    with tasks.store.connect() as db:
        row = db.execute(
            "SELECT data FROM task_artifacts WHERE id=?", (artifact_id,)).fetchone()
        artifact = json.loads(row[0])
        artifact["name"] = "innocent"
        db.execute("UPDATE task_artifacts SET data=? WHERE id=?", (
            json.dumps(artifact, sort_keys=True, separators=(",", ":")), artifact_id))
    public = tasks.get(result["episode_id"])
    assert "PRIVATE_MEMORY_BODY_MARKER" not in json.dumps(public, sort_keys=True)
    candidate_id = result["memory_candidate_id"]
    with pytest.raises(ContractError, match="execution closure is invalid"):
        memory.plan_selection(
            candidate_id, criteria={"minimum": 1},
            evaluator_snapshot=GeneratedMemoryEvaluator().snapshot(),
            channel="working", expected_revision=0)


def test_generation_receipt_digest_binding_rejects_self_consistent_tamper(tmp_path):
    (tasks, _, generation, memory, _, package_registration, root,
     memory_registration, feedback) = prepared(tmp_path)
    result = generation.generate(
        "agents", feedback["id"], improver_package(memory_patch(root)),
        {"mutable_components": ["working-memory"],
         "allowed_operations": ["replace"]},
        package_registration["revision"], memory_channel="working",
        expected_memory_revision=memory_registration["revision"])
    with tasks.store.connect() as db:
        row = db.execute(
            "SELECT data FROM task_candidate_generations WHERE id=?",
            (result["id"],)).fetchone()
        tampered = json.loads(row[0])
        tampered["self_consistent_tamper"] = True
        db.execute(
            "UPDATE task_candidate_generations SET data=?,digest=? WHERE id=?",
            (json.dumps(tampered, sort_keys=True, separators=(",", ":")),
             digest(tampered), result["id"]))
    with pytest.raises(ContractError, match="closure is incomplete"):
        memory.plan_selection(
            result["memory_candidate_id"], criteria={"minimum": 1},
            evaluator_snapshot=GeneratedMemoryEvaluator().snapshot(),
            channel="working", expected_revision=0)
