"""Turn one used task-local capability into an independently selectable package candidate.

The creator's Definition remains origin-bound.  This bridge copies only its
verified pure source and declaration into an S component of a generated child
AgentPackage.  It never mounts that Definition in another Episode or promotes
the child without the existing paired evaluation and guard.
"""

from __future__ import annotations

from copy import deepcopy
import json

from ..kernel.programs import digest
from .capability_releases import build_capability_release
from .generation import GenerationService
from .package_patch_v3 import PACKAGE_PATCH_SCHEMA, apply_package_patch
from .packages import make_package
from .tools import ContractError


ADOPTION_SCHEMA = "nexgent.task-capability-adoption.v1"


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False,
                      sort_keys=True, separators=(",", ":"))


def _hypothesis(value, component_id):
    fields = {"failure_mechanism", "expected_behavior", "applicability", "falsifier"}
    if (not isinstance(value, dict) or set(value) != fields
            or any(not isinstance(value[key], str) or not value[key].strip()
                   or len(value[key]) > 5000 for key in fields)):
        raise ContractError("Task-capability adoption hypothesis is invalid")
    return {**deepcopy(value), "component_ids": [component_id]}


def _workflow_tools(workflow):
    result = set()
    for node in workflow.get("nodes", []):
        if not isinstance(node, dict):
            continue
        if node.get("method") == "tool":
            name = node.get("params", {}).get("name")
            if isinstance(name, str):
                result.add(name)
        if node.get("method") == "loop" and isinstance(node.get("body"), dict):
            result.update(_workflow_tools(node["body"]))
    return result


class TaskCapabilityAdoptionService:
    """Produce a generated candidate from a proven task-local tool or service."""

    def __init__(self, task_service, evolution_service, generation_service=None):
        self.tasks = task_service
        self.store = task_service.store
        self.evolution = evolution_service
        self.generation = (generation_service if generation_service is not None
                           else GenerationService(task_service, evolution_service))

    @staticmethod
    def _used(creator, definition):
        binding = {"definition_id": definition["id"],
                   "definition_digest": definition["digest"]}
        events = creator.get("events") or []
        if definition["kind"] == "tool":
            return any(
                event.get("kind") == "tool"
                and event.get("content", {}).get("status") == "completed"
                and all(event.get("content", {}).get("dynamic_capability", {}).get(key)
                        == value for key, value in binding.items())
                for event in events)
        applied_nodes = {
            event.get("content", {}).get("node_id")
            for event in events
            if event.get("kind") == "service_applied"
            and all(event.get("content", {}).get("binding", {}).get(key) == value
                    for key, value in binding.items())
        }
        return any(
            call.get("status") in {"completed", "received"}
            and call.get("episode_id") == creator["id"]
            and call.get("node_id") in applied_nodes
            and all(call.get("service_provider", {}).get(key) == value
                    for key, value in binding.items())
            for call in creator.get("calls") or [])

    def adopt(self, channel, definition_id, creator_episode_id,
              feedback_bundle_id, expected_revision, hypothesis, *, budget=None,
              stop_event=None, admission_check=None):
        """Create, but never promote, one generated package capability candidate."""
        active = self.evolution.active(channel)
        feedback = self.generation.feedback(feedback_bundle_id)
        if (active["revision"] != expected_revision
                or feedback.get("channel") != channel
                or feedback.get("channel_revision") != expected_revision
                or feedback.get("parent_package_id") != active["package_id"]
                or feedback.get("parent_package_digest") != active["package_digest"]):
            raise ContractError("Task-capability feedback or active parent is stale")
        try:
            creator = self.tasks.get_private(creator_episode_id)
        except KeyError as exc:
            raise ContractError("Task-capability creator Episode is not local") from exc
        if (creator.get("package_id") != active["package_id"]
                or creator_episode_id not in {
                    ref.get("episode_id") for ref in feedback.get("episode_refs", [])
                    if isinstance(ref, dict)}):
            raise ContractError("Task-capability feedback must include its active creator")

        if isinstance(definition_id, str) and definition_id.startswith("definition-"):
            loader = self.store.tool_definition
        elif (isinstance(definition_id, str)
              and definition_id.startswith("service-definition-")):
            loader = self.store.service_definition
        else:
            raise ContractError("Task-capability Definition identity is unsupported")
        try:
            definition = loader(definition_id)
        except KeyError as exc:
            raise ContractError("Task-capability Definition is not local") from exc
        if definition["origin_episode_id"] != creator_episode_id:
            raise ContractError("Task-capability Definition belongs to another Episode")
        if not self._used(creator, definition):
            raise ContractError("Task-capability Definition lacks successful use")
        release = build_capability_release(
            definition, self.store.package(definition["package_id"]))

        parent = active["package"]
        manifest = deepcopy(parent["manifest"])
        suffix = release["digest"][:20]
        component_id = "adopted-capability-" + suffix
        path = "capabilities/adopted/" + suffix + ".py"
        name = release["name"]
        if component_id in manifest["components"] or path in parent["files"]:
            raise ContractError("Task-capability component collides with the active parent")
        if release["kind"] == "tool":
            if (name in manifest.get("tools", {})
                    or name in {tool["name"] for tool in self.tasks.tools.describe()}):
                raise ContractError("Task-capability tool name collides with an active tool")
            manifest.setdefault("tools", {})[name] = {
                "description": release["description"], "ref": path + ":execute",
                "input_schema": deepcopy(release["input_schema"]),
                "output_schema": deepcopy(release["output_schema"]),
                "effect_class": "local_compute", "runtime": release["runtime"],
                "work_units_per_call": 0,
            }
            kind, ref = "tool", name
        else:
            slot = release["interface"]["slot"]
            if slot in manifest.get("services", {}):
                raise ContractError("Task-capability service slot is already occupied")
            manifest.setdefault("services", {})[slot] = {
                "name": name, "description": release["description"],
                "ref": path + ":provide", "service_interface": slot,
                "input_schema": deepcopy(release["input_schema"]),
                "output_schema": deepcopy(release["output_schema"]),
                "effect_class": "model_context", "runtime": release["runtime"],
            }
            kind, ref = "service_provider", slot
        manifest["components"][component_id] = {
            "class": "S", "kind": kind, "ref": ref}
        patch = {
            "schema": PACKAGE_PATCH_SCHEMA,
            "parent_package_digest": active["package_digest"],
            "hypothesis": _hypothesis(hypothesis, component_id),
            "operations": [{"op": "add", "component_id": component_id,
                            "path": path, "content": release["source"]}],
            "child_manifest": manifest,
            "activation_targets": [component_id],
        }
        tool_names = set(manifest.get("tools", {}))
        for registration in manifest["workflows"].values():
            workflow_path = registration["ref"]
            tool_names.update(_workflow_tools(json.loads(parent["files"][workflow_path])))
        policy = {
            "mutable_components": [manifest["orchestrator"]],
            "allow_add": True, "allow_remove": False,
            "max_patch_bytes": 1_000_000,
            "capability_ceiling": sorted({
                method for role in manifest["roles"].values()
                for method in role.get("capabilities", [])}),
            "tool_ceiling": sorted(tool_names),
            "max_parallel": max((item.get("max_parallel", 4)
                                 for item in manifest["workflows"].values()),
                                default=1),
        }
        adoption = {
            "schema": ADOPTION_SCHEMA,
            "release_id": release["id"], "release_digest": release["digest"],
            "source_definition_id": definition["id"],
            "source_definition_digest": definition["digest"],
            "creator_episode_id": creator_episode_id,
            "feedback_bundle_id": feedback_bundle_id,
            "feedback_digest": feedback["digest"],
            "channel": channel, "channel_revision": expected_revision,
            "parent_package_id": active["package_id"],
            "parent_package_digest": active["package_digest"],
            "component_id": component_id, "component_kind": kind,
            "source_path": path, "patch_digest": digest(patch),
        }
        # A preview checks the same immutable patch and host policy before the
        # improver receives any generation authority.
        apply_package_patch(parent, patch, policy, provenance={
            "origin": "task-capability-adoption-preview",
            "adoption_digest": digest(adoption),
        })
        canonical_patch = json.loads(_canonical(patch))
        improver_source = (
            "PATCH = " + repr(canonical_patch) + "\n"
            "def execute(payload, context):\n"
            "    return {'deliverables': {}}\n"
            "def improve(payload, context):\n"
            "    artifact = context.publish(PATCH, schema='" + PACKAGE_PATCH_SCHEMA
            + "', name='behavior_patch')\n"
            "    return {'deliverables': {'behavior_patch': artifact['id']}}\n"
        )
        improver = make_package(
            {"adoption_improver.py": improver_source},
            {"entries": {"execute": "adoption_improver.py:execute",
                         "improve": "adoption_improver.py:improve"}, "skills": {}},
            provenance={"origin": "task-capability-adoption-improver",
                        "adoption": adoption, "release": release},
        )
        generated = self.generation.generate(
            channel, feedback_bundle_id, improver,
            {"patch_contract": PACKAGE_PATCH_SCHEMA, **policy},
            expected_revision, budget=budget, stop_event=stop_event,
            admission_check=admission_check)
        return {
            "adoption": adoption,
            "improver_package_id": improver["id"],
            "improver_package_digest": improver["digest"],
            "generation": generated,
        }


__all__ = ["ADOPTION_SCHEMA", "TaskCapabilityAdoptionService"]
