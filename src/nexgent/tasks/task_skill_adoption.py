"""Re-propose task-time O/S behavior through the generation closure.

Scoped packages and generated Episode graphs are evidence, never deployable
candidates.  This bridge freezes a creator Episode's authoritative final graph,
materializes its task roles as package role components, copies its durably
compiled task skills, and emits one PackagePatch against the active parent.
Candidate admission is delegated to :class:`GenerationService`; selection and
promotion remain ordinary EvolutionService responsibilities.
"""

from __future__ import annotations

from copy import deepcopy
import json

from ..kernel.programs import digest
from .dynamic_roles import materialize_task_roles, task_role_registry
from .generation import GenerationService
from .package_patch_v3 import PACKAGE_PATCH_SCHEMA, apply_package_patch
from .packages import make_package, split_ref, verify_package
from .tools import ContractError


ADOPTION_SCHEMA = "nexgent.task-os-adoption.v2"
LEGACY_ADOPTION_SCHEMA = "nexgent.task-skill-adoption.v1"


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
    component_ids = ([component_id] if isinstance(component_id, str)
                     else list(component_id))
    return {**deepcopy(value), "component_ids": component_ids}


def _canonical(value):
    return json.dumps(
        value, ensure_ascii=False, allow_nan=False,
        sort_keys=True, separators=(",", ":"),
    )


def _rewrite_graph(definition, role_mappings, skill_mappings):
    """Translate task-scoped identities without reconstructing graph behavior."""
    result = deepcopy(definition)
    result.pop("task_roles", None)

    def rewrite(graph):
        for node in graph.get("nodes", []):
            if not isinstance(node, dict):
                continue
            role_ref = node.get("role_ref")
            if role_ref in role_mappings:
                mapping = role_mappings[role_ref]
                node["role_ref"] = mapping["name"]
                node["component_ref"] = mapping["component_id"]
                params = node.get("params")
                if isinstance(params, dict) and params.get("role") == role_ref:
                    params["role"] = mapping["name"]
            if node.get("method") == "skill":
                params = node.get("params")
                name = params.get("name") if isinstance(params, dict) else None
                mapping = skill_mappings.get(name)
                if mapping is not None:
                    expected = mapping["source_component_id"]
                    if node.get("component_ref") != expected:
                        raise ContractError(
                            "Creator workflow task skill identity is inconsistent")
                    params["name"] = mapping["name"]
                    node["component_ref"] = mapping["component_id"]
            if node.get("method") == "loop" and isinstance(node.get("body"), dict):
                rewrite(node["body"])
        for rule in graph.get("revision_rules", []):
            if not isinstance(rule, dict):
                continue
            role_ref = rule.get("planner_role_ref")
            if role_ref in role_mappings:
                rule["planner_role_ref"] = role_mappings[role_ref]["name"]

    rewrite(result)
    return result


def _role_provenance(mapping):
    """Keep role lineage auditable without duplicating its prompt in metadata."""
    return {key: deepcopy(value) for key, value in mapping.items()
            if key != "prompt"}


class TaskSkillAdoptionService:
    """Bridge leased task O/S behavior into the generated-candidate path."""

    def __init__(self, task_service, evolution_service, generation_service=None):
        self.tasks = task_service
        self.store = task_service.store
        self.evolution = evolution_service
        self.generation = (generation_service if generation_service is not None
                           else GenerationService(task_service, evolution_service))

    def _source(self, active, source_package_id, creator, compiled_event):
        try:
            source = self.store.package(source_package_id)
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
                (source["id"], creator["root_episode_id"], creator["id"]),
            ).fetchone()
        if lease is None:
            raise ContractError("Task-skill adoption source lacks its creator-tree lease")
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
        content = compiled_event.get("content", {})
        if (compiled_event.get("kind") != "task_skill_compiled"
                or content.get("package_id") != source["id"]
                or content.get("package_digest") != source["digest"]
                or content.get("skill_name") != source_name
                or content.get("proposal_digest")
                != source.get("provenance", {}).get("task_skill_proposal_digest")):
            raise ContractError(
                "Task-skill adoption source lacks its durable runtime compilation event")
        return {
            "package": source,
            "source_name": source_name,
            "source_component_id": source_component_id,
            "skill": skill,
            "path": path,
            "entrypoint": entrypoint,
        }

    def _sources(self, active, source_package_id, creator):
        compiled_events = [
            event for event in self.store.events(creator["id"])
            if event.get("kind") == "task_skill_compiled"
        ]
        events_by_package = {}
        for event in compiled_events:
            package_id = event.get("content", {}).get("package_id")
            if not isinstance(package_id, str) or package_id in events_by_package:
                raise ContractError(
                    "Task-skill adoption compilation events are ambiguous")
            events_by_package[package_id] = event
        if source_package_id is not None and source_package_id not in events_by_package:
            raise ContractError(
                "Task-skill adoption source lacks its durable runtime compilation event")
        sources = [
            self._source(active, package_id, creator, event)
            for package_id, event in sorted(events_by_package.items())
        ]
        names = [item["source_name"] for item in sources]
        if len(names) != len(set(names)):
            raise ContractError("Task-skill adoption source skill names are ambiguous")
        return sources

    @staticmethod
    def _creator_workflow(creator):
        workflow_ref = creator.get("plan_workflow_ref")
        workflow = creator.get("plan_workflow_snapshot")
        versions = creator.get("plan_workflow_versions")
        if not (isinstance(workflow_ref, str)
                and workflow_ref.startswith("generated://")):
            return None
        if (not isinstance(workflow, dict)
                or workflow_ref != "generated://" + digest(workflow)
                or not isinstance(versions, dict)
                or versions.get(workflow_ref) != workflow):
            raise ContractError(
                "Task-skill adoption creator final workflow archive is invalid")
        materialized = materialize_task_roles(workflow)
        if materialized != workflow:
            raise ContractError(
                "Task-skill adoption creator workflow is not durably materialized")
        return deepcopy(workflow)

    def adopt(self, channel, source_package_id, creator_episode_id,
              feedback_bundle_id, expected_revision, hypothesis, *, budget=None,
              stop_event=None, admission_check=None):
        """Adopt compiled skills while retaining the active package workflow."""
        return self._adopt(
            channel, source_package_id, creator_episode_id,
            feedback_bundle_id, expected_revision, hypothesis,
            include_creator_workflow=False, budget=budget,
            stop_event=stop_event, admission_check=admission_check,
        )

    def adopt_episode(self, channel, source_package_id, creator_episode_id,
                      feedback_bundle_id, expected_revision, hypothesis, *, budget=None,
                      stop_event=None, admission_check=None):
        """Adopt the exact final generated workflow, task roles, and skills.

        This only generates an independently selectable candidate.  It grants
        no deployment authority and performs no selection or promotion.
        """
        return self._adopt(
            channel, source_package_id, creator_episode_id,
            feedback_bundle_id, expected_revision, hypothesis,
            include_creator_workflow=True, budget=budget,
            stop_event=stop_event, admission_check=admission_check,
        )

    def _adopt(self, channel, source_package_id, creator_episode_id,
               feedback_bundle_id, expected_revision, hypothesis, *,
               include_creator_workflow, budget=None, stop_event=None,
               admission_check=None):
        """Generate, but do not select or promote, an adopted O/S candidate."""
        active = self.evolution.active(channel)
        feedback = self.generation.feedback(feedback_bundle_id)
        if (feedback.get("channel") != channel
                or feedback.get("channel_revision") != expected_revision
                or feedback.get("parent_package_id") != active["package_id"]
                or feedback.get("parent_package_digest") != active["package_digest"]
                or active["revision"] != expected_revision):
            raise ContractError("Task-skill adoption feedback or active parent is stale")
        try:
            creator = self.store.get(creator_episode_id)
        except KeyError as exc:
            raise ContractError("Task-skill adoption creator is not local") from exc
        feedback_episode_ids = {
            item.get("episode_id") for item in feedback.get("episode_refs", [])
            if isinstance(item, dict)
        }
        if creator_episode_id not in feedback_episode_ids:
            raise ContractError(
                "Task-skill adoption feedback must include the creator Episode")
        if creator.get("package_id") != active["package_id"]:
            raise ContractError(
                "Task-skill adoption creator does not use the active parent")
        sources = self._sources(active, source_package_id, creator)
        creator_workflow = (self._creator_workflow(creator)
                            if include_creator_workflow else None)
        if source_package_id is None and not include_creator_workflow:
            raise ContractError("Task-skill adoption requires a source package")
        if creator_workflow is None and not sources:
            raise ContractError("Task O/S adoption has no generated workflow or skill")

        source_records = []
        skill_mappings = {}
        for item in sources:
            source = item["package"]
            source_skill = item["skill"]
            skill_digest = digest({
                "declaration": source_skill,
                "content": source["files"][item["path"]],
            })
            suffix = skill_digest[:16]
            mapping = {
                "source_package_id": source["id"],
                "source_package_digest": source["digest"],
                "source_name": item["source_name"],
                "source_component_id": item["source_component_id"],
                "source_skill_digest": skill_digest,
                "name": "adopted_" + suffix,
                "component_id": "adopted-task-skill-" + suffix,
                "path": "skills/adopted/" + suffix + ".py",
                "entrypoint": item["entrypoint"],
            }
            source_records.append(mapping)
            skill_mappings[item["source_name"]] = mapping

        role_mappings = {}
        if creator_workflow is not None:
            for role_ref, role in sorted(task_role_registry(creator_workflow).items()):
                suffix = role["digest"][:16]
                role_mappings[role_ref] = {
                    "source_role_ref": role_ref,
                    "source_component_ref": role["component_ref"],
                    "source_role_digest": role["digest"],
                    "alias": role["alias"],
                    "identity": role["identity"],
                    "name": "adopted_role_" + suffix,
                    "component_id": "adopted-task-role-" + suffix,
                    "path": "prompts/adopted/" + suffix + ".md",
                    "prompt": role["prompt"],
                }

        anchor = (next(item for item in source_records
                       if item["source_package_id"] == source_package_id)
                  if source_package_id is not None else None)
        seed = {
            "source_package_id": source_package_id,
            "source_package_digest": (
                anchor["source_package_digest"] if anchor is not None else None),
            "source_skill_name": anchor["source_name"] if anchor is not None else None,
            "source_skill_digest": (
                anchor["source_skill_digest"] if anchor is not None else None),
            "source_skills": source_records,
            "adoption_scope": ("episode_os" if include_creator_workflow
                               else "compiled_skills"),
            "creator_episode_id": creator_episode_id,
            "creator_root_episode_id": creator["root_episode_id"],
            "creator_workflow_ref": creator.get("plan_workflow_ref"),
            "creator_workflow_digest": (
                digest(creator_workflow) if creator_workflow is not None else None),
            "creator_capability_lease_digest": digest(
                sorted(creator.get("capabilities") or [])),
            "creator_roles": [
                _role_provenance(role_mappings[key])
                for key in sorted(role_mappings)
            ],
            "feedback_bundle_id": feedback["id"],
            "feedback_digest": feedback["digest"],
            "channel": channel,
            "channel_revision": expected_revision,
            "parent_package_id": active["package_id"],
            "parent_package_digest": active["package_digest"],
        }
        seed_digest = digest(seed)
        child_manifest = deepcopy(active["package"]["manifest"])
        operations = []
        component_ids = []

        for item, mapping in zip(sources, source_records):
            if (mapping["name"] in child_manifest["skills"]
                    or mapping["component_id"] in child_manifest["components"]
                    or mapping["path"] in active["package"]["files"]):
                raise ContractError("Task-skill adoption identity collides with the parent")
            child_manifest["skills"][mapping["name"]] = {
                **deepcopy(item["skill"]),
                "ref": f'{mapping["path"]}:{mapping["entrypoint"]}',
            }
            child_manifest["components"][mapping["component_id"]] = {
                "class": "S", "kind": "skill", "ref": mapping["name"],
            }
            operations.append({
                "op": "add", "component_id": mapping["component_id"],
                "path": mapping["path"],
                "content": item["package"]["files"][item["path"]],
            })
            component_ids.append(mapping["component_id"])

        for role_ref in sorted(role_mappings):
            mapping = role_mappings[role_ref]
            if (mapping["name"] in child_manifest["roles"]
                    or mapping["component_id"] in child_manifest["components"]
                    or mapping["path"] in active["package"]["files"]):
                raise ContractError("Task-role adoption identity collides with the parent")
            child_manifest["roles"][mapping["name"]] = {
                "prompt_ref": mapping["path"], "capabilities": ["ask"],
            }
            child_manifest["components"][mapping["component_id"]] = {
                "class": "S", "kind": "role", "ref": mapping["name"],
            }
            operations.append({
                "op": "add", "component_id": mapping["component_id"],
                "path": mapping["path"], "content": mapping["prompt"],
            })
            component_ids.append(mapping["component_id"])

        adopted_workflow = None
        if creator_workflow is not None:
            adopted_workflow = _rewrite_graph(
                creator_workflow, role_mappings, skill_mappings)
            orchestrator_id = child_manifest["orchestrator"]
            orchestrator = child_manifest["components"].get(orchestrator_id)
            if (not isinstance(orchestrator, dict)
                    or orchestrator.get("kind") != "workflow"):
                raise ContractError(
                    "Task-skill adoption active orchestrator is not a workflow")
            registration = child_manifest["workflows"].get(orchestrator["ref"])
            if not isinstance(registration, dict):
                raise ContractError(
                    "Task-skill adoption active workflow registration is absent")
            workflow_path = registration["ref"]
            operations.insert(0, {
                "op": "replace", "component_id": orchestrator_id,
                "old_digest": active["package"]["component_digests"][workflow_path],
                "content": _canonical(adopted_workflow),
            })
            component_ids.insert(0, orchestrator_id)

        if len(operations) > 64:
            raise ContractError("Task O/S adoption exceeds the PackagePatch component bound")
        patch = {
            "schema": PACKAGE_PATCH_SCHEMA,
            "parent_package_digest": active["package_digest"],
            "hypothesis": _hypothesis(hypothesis, component_ids),
            "operations": operations,
            "child_manifest": child_manifest,
            "activation_targets": component_ids,
        }

        manifest = active["package"]["manifest"]
        tools = {
            tool for item in sources for tool in item["skill"].get("allowed_tools", [])
        }
        max_parallel = 1
        for workflow_name, registration in child_manifest["workflows"].items():
            max_parallel = max(max_parallel, registration.get("max_parallel", 4))
            definition = (adopted_workflow
                          if (adopted_workflow is not None
                              and workflow_name == child_manifest["components"][
                                  child_manifest["orchestrator"]]["ref"])
                          else json.loads(active["package"]["files"][registration["ref"]]))
            tools.update(_workflow_tools(json.loads(
                _canonical(definition))))
        patch_policy = {
            "mutable_components": [manifest["orchestrator"]],
            "allow_add": True,
            "allow_remove": False,
            "max_patch_bytes": 1_000_000,
            "capability_ceiling": sorted({
                method for role in child_manifest["roles"].values()
                for method in role.get("capabilities", [])
            }),
            "tool_ceiling": sorted(tools),
            "max_parallel": max_parallel,
        }
        # Validate the exact patch before creating executable adoption authority.
        preview = apply_package_patch(
            active["package"], patch, patch_policy,
            provenance={"origin": "task-skill-adoption-preview",
                        "adoption_seed_digest": seed_digest})
        if adopted_workflow is not None:
            from .workflows import plan_from_workflow

            workflow_name = child_manifest["components"][
                child_manifest["orchestrator"]]["ref"]
            admitted = self.tasks._materialize_workflow(
                preview, workflow_name, list(creator.get("capabilities") or []))
            if admitted != adopted_workflow:
                raise ContractError(
                    "Task O/S adoption workflow changes during fresh admission")
            admitted_plan = plan_from_workflow(
                admitted, "task-os-adoption-" + seed_digest[:16])
            admission_digest = digest(admitted_plan.as_dict())
        else:
            admission_digest = None

        adoption = {
            "schema": (ADOPTION_SCHEMA if include_creator_workflow
                       else LEGACY_ADOPTION_SCHEMA),
            **seed,
            "seed_digest": seed_digest,
            # Retain the original single-skill fields for callers while the
            # structured lists carry complete O/S provenance.
            "adopted_skill_name": (
                source_records[0]["name"] if source_records else None),
            "adopted_component_id": (
                source_records[0]["component_id"] if source_records else None),
            "adopted_path": source_records[0]["path"] if source_records else None,
            "adopted_skills": source_records,
            "adopted_roles": [
                _role_provenance(role_mappings[key])
                for key in sorted(role_mappings)
            ],
            "adopted_workflow_digest": (
                digest(adopted_workflow) if adopted_workflow is not None else None),
            "admitted_plan_digest": admission_digest,
            "component_ids": component_ids,
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


__all__ = [
    "ADOPTION_SCHEMA", "LEGACY_ADOPTION_SCHEMA", "TaskSkillAdoptionService",
]
