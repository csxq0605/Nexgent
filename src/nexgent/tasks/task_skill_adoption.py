"""Explicitly re-propose a task-time skill through the generation closure.

The scoped package is evidence, never the deployable candidate.  This bridge
extracts its single compiler-added skill, creates a deterministic improver that
emits a PackagePatch against the active parent, and delegates candidate
admission to :class:`GenerationService`.  Selection and promotion remain the
ordinary EvolutionService responsibilities.
"""

from __future__ import annotations

from copy import deepcopy
import json

from ..kernel.programs import digest
from .generation import GenerationService
from .package_patch_v3 import PACKAGE_PATCH_SCHEMA, apply_package_patch
from .packages import make_package, split_ref, verify_package
from .tools import ContractError


ADOPTION_SCHEMA = "nexgent.task-skill-adoption.v1"


def _workflow_tools(definition):
    names = set()
    for node in definition.get("nodes", []):
        if not isinstance(node, dict):
            continue
        if node.get("method") == "tool":
            name = node.get("params", {}).get("name")
            if isinstance(name, str):
                names.add(name)
        if node.get("method") == "loop" and isinstance(node.get("body"), dict):
            names.update(_workflow_tools(node["body"]))
    return names


def _hypothesis(value, component_id):
    fields = {"failure_mechanism", "expected_behavior", "applicability", "falsifier"}
    if (not isinstance(value, dict) or set(value) != fields
            or any(not isinstance(value[name], str) or not value[name].strip()
                   or len(value[name]) > 5000 for name in fields)):
        raise ContractError("Task-skill adoption hypothesis is invalid")
    return {**deepcopy(value), "component_ids": [component_id]}


class TaskSkillAdoptionService:
    """Bridge a leased task skill into the existing generated-candidate path."""

    def __init__(self, task_service, evolution_service, generation_service=None):
        self.tasks = task_service
        self.store = task_service.store
        self.evolution = evolution_service
        self.generation = (generation_service if generation_service is not None
                           else GenerationService(task_service, evolution_service))

    def _source(self, active, source_package_id, creator_episode_id, feedback):
        try:
            source = self.store.package(source_package_id)
            creator = self.store.get(creator_episode_id)
        except KeyError as exc:
            raise ContractError("Task-skill adoption source is not local") from exc
        verify_package(source, active["package"])
        if (source["parent_id"] != active["package_id"]
                or source.get("provenance", {}).get("task_time_only") is not True
                or not self.store.is_task_scoped_package(source)):
            raise ContractError("Task-skill adoption source is not a scoped active-parent child")
        with self.store.connect() as db:
            lease = db.execute(
                "SELECT root_id,creator_episode FROM task_skill_package_leases "
                "WHERE package_id=? AND root_id=? AND creator_episode=?",
                (source["id"], creator["root_episode_id"], creator_episode_id),
            ).fetchone()
        if lease is None:
            raise ContractError("Task-skill adoption source lacks its creator-tree lease")
        feedback_episode_ids = {
            item.get("episode_id") for item in feedback.get("episode_refs", [])
            if isinstance(item, dict)
        }
        if creator_episode_id not in feedback_episode_ids:
            raise ContractError(
                "Task-skill adoption feedback must include the creator Episode")

        parent_manifest = active["package"]["manifest"]
        source_manifest = source["manifest"]
        added_skills = sorted(set(source_manifest["skills"]) - set(parent_manifest["skills"]))
        added_components = sorted(
            set(source_manifest["components"]) - set(parent_manifest["components"]))
        if len(added_skills) != 1 or len(added_components) != 1:
            raise ContractError("Task-skill adoption requires exactly one added skill component")
        source_name, source_component_id = added_skills[0], added_components[0]
        component = source_manifest["components"][source_component_id]
        skill = source_manifest["skills"][source_name]
        if (component != {"class": "S", "kind": "skill", "ref": source_name}
                or skill.get("kind") != "controlled_code"):
            raise ContractError("Task-skill adoption source has an invalid skill component")
        path, entrypoint = split_ref(skill.get("ref"), source["files"])
        if path in active["package"]["files"]:
            raise ContractError("Task-skill adoption source does not own a new skill file")
        compiled_events = [
            event for event in self.store.events(creator_episode_id)
            if event.get("kind") == "task_skill_compiled"
            and event.get("content", {}).get("package_id") == source["id"]
            and event.get("content", {}).get("package_digest") == source["digest"]
            and event.get("content", {}).get("skill_name") == source_name
            and event.get("content", {}).get("proposal_digest")
            == source.get("provenance", {}).get("task_skill_proposal_digest")
        ]
        if len(compiled_events) != 1:
            raise ContractError(
                "Task-skill adoption source lacks its durable runtime compilation event")
        return source, source_name, skill, path, entrypoint

    def adopt(self, channel, source_package_id, creator_episode_id,
              feedback_bundle_id, expected_revision, hypothesis, *, budget=None,
              stop_event=None, admission_check=None):
        """Generate, but do not select or promote, an adopted O/S candidate."""
        active = self.evolution.active(channel)
        feedback = self.generation.feedback(feedback_bundle_id)
        if (feedback.get("channel") != channel
                or feedback.get("channel_revision") != expected_revision
                or feedback.get("parent_package_id") != active["package_id"]
                or feedback.get("parent_package_digest") != active["package_digest"]
                or active["revision"] != expected_revision):
            raise ContractError("Task-skill adoption feedback or active parent is stale")
        source, source_name, source_skill, source_path, entrypoint = self._source(
            active, source_package_id, creator_episode_id, feedback)

        seed = {
            "source_package_id": source["id"],
            "source_package_digest": source["digest"],
            "source_skill_name": source_name,
            "source_skill_digest": digest({
                "declaration": source_skill,
                "content": source["files"][source_path],
            }),
            "creator_episode_id": creator_episode_id,
            "feedback_bundle_id": feedback["id"],
            "feedback_digest": feedback["digest"],
            "channel": channel,
            "channel_revision": expected_revision,
            "parent_package_id": active["package_id"],
            "parent_package_digest": active["package_digest"],
        }
        seed_digest = digest(seed)
        suffix = seed_digest[:16]
        adopted_name = "adopted_" + suffix
        component_id = "adopted-task-skill-" + suffix
        adopted_path = "skills/adopted/" + suffix + ".py"
        adopted_skill = {
            **deepcopy(source_skill),
            "ref": f"{adopted_path}:{entrypoint}",
        }
        child_manifest = deepcopy(active["package"]["manifest"])
        child_manifest["skills"][adopted_name] = adopted_skill
        child_manifest["components"][component_id] = {
            "class": "S", "kind": "skill", "ref": adopted_name,
        }
        patch = {
            "schema": PACKAGE_PATCH_SCHEMA,
            "parent_package_digest": active["package_digest"],
            "hypothesis": _hypothesis(hypothesis, component_id),
            "operations": [{
                "op": "add", "component_id": component_id,
                "path": adopted_path, "content": source["files"][source_path],
            }],
            "child_manifest": child_manifest,
            "activation_targets": [component_id],
        }

        manifest = active["package"]["manifest"]
        role_methods = sorted({
            method for role in manifest["roles"].values()
            for method in role.get("capabilities", [])
        })
        tools = set(adopted_skill.get("allowed_tools", []))
        max_parallel = 1
        for registration in manifest["workflows"].values():
            max_parallel = max(max_parallel, registration.get("max_parallel", 4))
            tools.update(_workflow_tools(json.loads(
                active["package"]["files"][registration["ref"]])))
        patch_policy = {
            "mutable_components": [manifest["orchestrator"]],
            "allow_add": True,
            "allow_remove": False,
            "max_patch_bytes": 500_000,
            "capability_ceiling": role_methods,
            "tool_ceiling": sorted(tools),
            "max_parallel": max_parallel,
        }
        # Validate the exact patch before creating executable adoption authority.
        apply_package_patch(
            active["package"], patch, patch_policy,
            provenance={"origin": "task-skill-adoption-preview",
                        "adoption_seed_digest": seed_digest})

        adoption = {
            "schema": ADOPTION_SCHEMA,
            **seed,
            "seed_digest": seed_digest,
            "adopted_skill_name": adopted_name,
            "adopted_component_id": component_id,
            "adopted_path": adopted_path,
            "patch_digest": digest(patch),
        }
        canonical_patch = json.loads(json.dumps(
            patch, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        improver_source = (
            "PATCH = " + repr(canonical_patch) + "\n"
            "def execute(payload, context):\n"
            "    return {'deliverables': {}}\n"
            "def improve(payload, context):\n"
            "    artifact = context.publish(PATCH, schema='" + PACKAGE_PATCH_SCHEMA
            + "', name='behavior_patch')\n"
            "    return {'deliverables': {'behavior_patch': artifact['id']}}\n"
        )
        try:
            improver = make_package(
                {"adoption_improver.py": improver_source},
                {"entries": {
                    "execute": "adoption_improver.py:execute",
                    "improve": "adoption_improver.py:improve",
                }, "skills": {}},
                provenance={"origin": "task-skill-adoption-improver",
                            "adoption": adoption},
            )
        except Exception as exc:
            raise ContractError(
                f"Task-skill adoption improver cannot be formed: {str(exc)[:500]}") from None

        mutation_policy = {"patch_contract": PACKAGE_PATCH_SCHEMA, **patch_policy}
        generated = self.generation.generate(
            channel, feedback_bundle_id, improver, mutation_policy,
            expected_revision, budget=budget, stop_event=stop_event,
            admission_check=admission_check,
        )
        return {
            "adoption": adoption,
            "improver_package_id": improver["id"],
            "improver_package_digest": improver["digest"],
            "generation": generated,
        }


__all__ = ["ADOPTION_SCHEMA", "TaskSkillAdoptionService"]
