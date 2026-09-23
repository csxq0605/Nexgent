"""Ordinary task execution over immutable packages and capability-scoped episodes."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import inspect
from pathlib import Path
import re
import threading
import time

from jsonschema import Draft202012Validator

from ..kernel.programs import digest
from ..kernel.store import BudgetExhausted
from ..models.gateway import ModelError, ModelGateway, ModelTransportError
from .benchmarks import (
    BenchmarkRegistry, describe_adapter, host_runtime_fingerprint,
    validate_report, validate_snapshot, validate_tasks,
)
from .outcomes import classify_benchmark_outcome
from .package_runner import CapabilityAbort, run_package
from .packages import CAPABILITIES, PackageError, verify_package
from .store import EpisodeStore, RecoveryRequired, StateConflict
from .tools import ContractError, ToolRegistry, task_benchmarks, validate


_EFFECT_CLASSES = frozenset({"read", "artifact_write", "local_compute", "external_compute"})
_DELEGATED_PUBLIC_CONTEXT_FIELDS = frozenset({
    "memory_namespace", "split", "split_role", "memory_writeback", "rsi_role",
})


class _CompositePending(Exception):
    """A composite RPC has durable children but is not itself terminal yet."""


class _CompositePaused(_CompositePending, InterruptedError):
    pass


class _CompositeRecovery(_CompositePending, RecoveryRequired):
    pass


def _check_local_schema(schema, *, label):
    """Validate schema syntax while refusing resolver-controlled references."""
    if not isinstance(schema, (dict, bool)):
        raise ContractError(f"{label}: schema must be a JSON Schema object or boolean")

    def visit(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key in {"$ref", "$dynamicRef"} and (
                        not isinstance(child, str) or not child.startswith("#")):
                    raise ContractError(f"{label}: schemas may only reference local definitions")
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(schema)
    try:
        Draft202012Validator.check_schema(schema)
    except Exception as exc:
        raise ContractError(f"{label}: invalid JSON Schema: {str(exc)[:800]}") from None


def _json_copy(value, *, label):
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError, RecursionError) as exc:
        raise ContractError(f"{label} must be finite JSON: {str(exc)[:800]}") from None


def _delegated_public_context(context):
    """Project only explicitly public policy fields into a delegated TaskSpec."""
    if not isinstance(context, dict):
        return {}
    return {key: deepcopy(context[key])
            for key in _DELEGATED_PUBLIC_CONTEXT_FIELDS if key in context}


def _available_skill_inventory(package):
    """Project registered S skills into the task planner's bounded inventory."""
    manifest = package["manifest"]
    skills = manifest.get("skills", {})
    components = manifest.get("components", {})
    inventory = []
    for component_id, component in sorted(components.items()):
        if (not isinstance(component, dict)
                or component.get("class") != "S"
                or component.get("kind") != "skill"):
            continue
        name = component.get("ref")
        skill = skills.get(name)
        if not isinstance(skill, dict):
            continue
        inventory.append({
            "name": name,
            "component_ref": component_id,
            "kind": skill.get("kind"),
            "input_schema": deepcopy(skill.get("input_schema", {})),
            "output_schema": deepcopy(skill.get("output_schema", {})),
        })
    return inventory


def _capability_failure_domain(method, exc):
    """Classify a failed host RPC without treating unknown host faults as agent faults."""
    cause = exc.cause if isinstance(exc, CapabilityAbort) else exc
    if isinstance(cause, (RecoveryRequired, ModelTransportError, OSError, TimeoutError,
                          StateConflict)):
        return "infrastructure"
    if isinstance(cause, ModelError):
        # A received but unparsable model reply is an observed agent output
        # failure. Transport/configuration failures remain infrastructure.
        return "agent"
    if isinstance(cause, BudgetExhausted):
        return "agent"
    if isinstance(cause, (ContractError, PermissionError, KeyError, TypeError, ValueError)):
        return "protocol"
    if method in {"ask", "tool"}:
        return "infrastructure"
    return "infrastructure"


def _terminal_failure_domain(exc, observed_domains):
    """Return a fail-closed terminal domain for one unsuccessful Episode."""
    if "infrastructure" in observed_domains:
        return "infrastructure"
    if "protocol" in observed_domains:
        return "protocol"
    if "agent" in observed_domains:
        return "agent"
    if isinstance(exc, PackageError):
        return "agent"
    if isinstance(exc, (ContractError, PermissionError, KeyError, TypeError, ValueError)):
        return "protocol"
    return "infrastructure"


class ToolContext:
    """Narrow host interface passed to an installed, trusted tool handler."""

    def __init__(self, service, episode_id, node_id, stop_event):
        self.service, self.episode_id, self.node_id = service, episode_id, node_id
        self.stop_event = stop_event
        self.task = deepcopy(service.store.get(episode_id)["task"])
        self.idempotency_key = episode_id + "/" + node_id
        self._input_refs = set()

    def check_stop(self):
        if self.stop_event.is_set():
            raise InterruptedError("Task tool was stopped")

    def read_artifact(self, ref):
        self.check_stop()
        value = self.service.store.read(ref, self.episode_id)
        self._input_refs.add(value["id"])
        self.service.store.event(self.episode_id, "artifact_read", {"node_id": self.node_id, "artifact_id": ref})
        return value

    def publish(self, content, name=None, schema="application/json"):
        self.check_stop()
        return self.service._publish(self.episode_id, self.node_id, content, name, schema,
                                     input_refs=sorted(self._input_refs))

    def once(self, key):
        return self.service.store.once(self.episode_id, key)

    def charge_work(self, units):
        """Durably append host-metered numerical work for this tool call."""
        self.check_stop()
        return self.service.store.add_tool_work(
            self.episode_id, self.node_id, units)

    def workspace(self, namespace):
        """Return a durable, root-episode-scoped directory for a trusted tool.

        Tool handlers are host code rather than package code.  The namespace
        contract keeps their durable files under one framework-owned root and
        prevents a plugin from turning a task argument into a filesystem path.
        Parent and delegated episodes deliberately share the same directory so
        retries and recovery can address the same external work receipts.
        """
        if (not isinstance(namespace, str)
                or not re.fullmatch(r"[a-z][a-z0-9_.-]{0,63}", namespace)):
            raise ContractError("Tool workspace namespace must be a bounded lowercase identifier")
        project_root = self.service.project_root.resolve()
        base = (project_root / ".nexgent" / "tool-workspaces").resolve()
        try:
            base.relative_to(project_root)
        except ValueError:
            raise ContractError("Tool workspace root resolved outside the project") from None
        base.mkdir(parents=True, exist_ok=True)
        root_id = self.service.store.get(self.episode_id)["root_episode_id"]
        target = (base / namespace / root_id).resolve()
        try:
            target.relative_to(base)
        except ValueError:
            raise ContractError("Tool workspace resolved outside the managed root") from None
        target.mkdir(parents=True, exist_ok=True)
        self.service.store.event(
            self.episode_id,
            "tool_workspace_opened",
            {"node_id": self.node_id, "namespace": namespace, "root_episode_id": root_id},
        )
        return target


class TaskService:
    def __init__(self, project_root, *, tools=None, gateway_factory=None):
        self.project_root = Path(project_root).resolve()
        self.store = EpisodeStore(self.project_root / ".nexgent")
        self.tools = tools if tools is not None else ToolRegistry.discover()
        self.gateway_factory = gateway_factory
        self._projection_lock = threading.RLock()
        self._parallel_context = threading.local()

    def _benchmark_registry(self):
        """Use project-aware discovery while preserving injected no-arg test facades."""
        try:
            inspect.signature(task_benchmarks).bind(self.project_root)
        except (TypeError, ValueError):
            adapters = task_benchmarks()
        else:
            adapters = task_benchmarks(self.project_root)
        return BenchmarkRegistry.from_mapping(adapters, project_root=self.project_root)

    def _change(self, identity, update):
        with self._projection_lock:
            state = self.store.get(identity)
            update(state)
            return self.store.save(state)

    def create(self, objective, inputs=None, deliverables=None, budget=None, capabilities=None,
               package=None, context=None, *, constraints=None, entry="execute", parent_episode_id=None,
               package_channel=None, benchmark_registration=None,
               expected_package_registration=None, improver_channel_registration=None,
               memory_channel=None, expected_memory_registration=None,
               _memory_candidate=None, _memory_candidate_token=None,
               initially_active_capabilities=None, capability_authority=None):
        if not isinstance(objective, str) or not objective.strip() or len(objective) > 20000:
            raise ContractError("Task objective must be nonempty and at most 20000 characters")
        explicit_package = package is not None
        if package is not None and package_channel is not None:
            raise ContractError("Specify either a package or a package channel")
        package_registration = None
        if package_channel is not None:
            from .evolution import active_package_registration
            package_registration = active_package_registration(self.store, package_channel)
            if expected_package_registration is not None:
                expected_package_registration = _json_copy(
                    expected_package_registration, label="Expected package registration")
                expected_keys = {"channel", "revision", "package_id", "package_digest"}
                if (not isinstance(expected_package_registration, dict)
                        or set(expected_package_registration) != expected_keys
                        or any(package_registration[key] != expected_package_registration[key]
                               for key in expected_keys)):
                    raise ContractError(
                        "Active package registration differs from the expected deployment")
            package = package_registration["package"]
        elif package is None:
            if expected_package_registration is not None:
                raise ContractError(
                    "Expected package registration requires a package channel")
            from .seed import default_package
            package = default_package()
        elif expected_package_registration is not None:
            raise ContractError("Expected package registration requires a package channel")
        verify_package(package)
        memory_registration = None
        frozen_memory_version = None
        if _memory_candidate is not None:
            from .memory import _CANDIDATE_EVALUATION_TOKEN
            if _memory_candidate_token is not _CANDIDATE_EVALUATION_TOKEN:
                raise PermissionError("Candidate memory snapshots are host-private")
            if (memory_channel is not None or expected_memory_registration is not None
                    or parent_episode_id is not None or not isinstance(_memory_candidate, dict)
                    or set(_memory_candidate) != {"registration", "version"}):
                raise ContractError("Candidate memory evaluation inputs are invalid")
            memory_registration = _json_copy(
                _memory_candidate["registration"], label="Candidate memory registration")
            frozen_memory_version = _json_copy(
                _memory_candidate["version"], label="Candidate memory version")
            registration_keys = {"channel", "revision", "memory_id", "memory_digest",
                                 "package_id", "package_digest"}
            if (set(memory_registration) != registration_keys
                    or frozen_memory_version.get("status") != "candidate"
                    or memory_registration["memory_id"] != frozen_memory_version.get("id")
                    or memory_registration["memory_digest"] != frozen_memory_version.get("digest")
                    or memory_registration["package_id"] != package["id"]
                    or memory_registration["package_digest"] != package["digest"]
                    or frozen_memory_version.get("package_id") != package["id"]
                    or frozen_memory_version.get("package_digest") != package["digest"]):
                raise ContractError("Candidate memory snapshot identity is invalid")
        elif memory_channel is not None:
            from .memory import active_memory_registration
            memory_registration = active_memory_registration(self.store, memory_channel)
            if (memory_registration["package_id"] != package["id"]
                    or memory_registration["package_digest"] != package["digest"]):
                raise ContractError("Active memory belongs to a different AgentPackage")
            if expected_memory_registration is not None:
                expected_memory_registration = _json_copy(
                    expected_memory_registration, label="Expected memory registration")
                expected_keys = {"channel", "revision", "memory_id", "memory_digest",
                                 "package_id", "package_digest"}
                if (not isinstance(expected_memory_registration, dict)
                        or frozenset(expected_memory_registration) not in {
                            frozenset(expected_keys), frozenset(expected_keys | {"updated_at"})}
                        or any(memory_registration[key] != expected_memory_registration[key]
                               for key in expected_keys)):
                    raise ContractError(
                        "Active memory registration differs from the expected deployment")
        elif expected_memory_registration is not None:
            raise ContractError("Expected memory registration requires a memory channel")
        if memory_registration is None and parent_episode_id is not None:
            memory_registration = self.store.memory_registration(parent_episode_id)
        if memory_registration is not None and frozen_memory_version is None:
            from .memory import memory_version
            # Fully verify and JSON-bound the resource before EpisodeStore starts
            # its atomic registration/snapshot transaction.
            frozen_memory_version = memory_version(
                self.store, memory_registration["memory_id"])
            _json_copy(frozen_memory_version, label="Frozen memory version")
        if capabilities is None:
            capabilities = []
        if (not isinstance(capabilities, list) or len(capabilities) > 256
                or any(not isinstance(name, str) or not name or len(name) > 120 for name in capabilities)
                or len(set(capabilities)) != len(capabilities)):
            raise ContractError("Capabilities must be a bounded list of unique nonempty names")
        capabilities = list(capabilities)
        for name in capabilities:
            self.tools.get(name)
        if (parent_episode_id is not None
                and self.store.get(parent_episode_id)["task"].get("capability_mode") == "leased"
                and initially_active_capabilities is None):
            # A leased parent cannot create a legacy child that bypasses its
            # active grants. The store separately checks the active subset in
            # the child registration transaction.
            initially_active_capabilities = list(capabilities)
        lease_mode = initially_active_capabilities is not None
        if lease_mode:
            # Transitional A3 path for preinstalled tools only: capabilities
            # remains a frozen name ceiling and cannot admit a model-created
            # tool whose name was unknown when this Episode was created.
            if (not isinstance(initially_active_capabilities, list)
                    or len(initially_active_capabilities) > 256
                    or any(not isinstance(name, str) or not name or len(name) > 120
                           for name in initially_active_capabilities)
                    or len(set(initially_active_capabilities))
                    != len(initially_active_capabilities)):
                raise ContractError(
                    "Initially active capabilities must be a bounded list of unique nonempty names")
            if not set(initially_active_capabilities) <= set(capabilities):
                raise PermissionError(
                    "Initially active capabilities exceed the Episode's frozen ceiling")
            initial_descriptors = [
                self.tools.lease_descriptor(name)
                for name in initially_active_capabilities
            ]
        else:
            initial_descriptors = []
        inputs = {} if inputs is None else _json_copy(inputs, label="Task inputs")
        context = {} if context is None else _json_copy(context, label="Task context")
        benchmark_registration = (None if benchmark_registration is None else
                                  _json_copy(benchmark_registration,
                                             label="Benchmark registration"))
        constraints = {} if constraints is None else _json_copy(constraints, label="Task constraints")
        budget = {} if budget is None else _json_copy(budget, label="Task budget")
        if (not isinstance(inputs, dict) or not isinstance(context, dict)
                or not isinstance(constraints, dict) or not isinstance(budget, dict)):
            raise ContractError("Task inputs, context, constraints and budget must be JSON objects")
        if "benchmark_registration" in context or "benchmark_registration_digest" in context:
            raise ContractError("Benchmark registration context is host-owned")
        if "improver_channel_registration" in context:
            raise ContractError("Improver channel registration context is host-owned")
        if (_memory_candidate is None and "memory_candidate_evaluation" in context):
            raise ContractError("Memory candidate evaluation context is host-owned")
        if ("memory_channel_registration" in context
                or "memory_registration_digest" in context):
            raise ContractError("Memory channel registration context is host-owned")
        if benchmark_registration is not None:
            if not isinstance(benchmark_registration, dict):
                raise ContractError("Benchmark registration must be a JSON object")
            current_host_runtime = host_runtime_fingerprint()
            frozen_host_runtime = benchmark_registration.get("host_runtime")
            if (frozen_host_runtime is not None
                    and frozen_host_runtime != current_host_runtime):
                raise ContractError(
                    "Benchmark registration host runtime differs from the current host")
            # The host owns this field.  Directly injected legacy callers may
            # omit it, but cannot choose or suppress the value persisted for a
            # newly created Episode.
            benchmark_registration["host_runtime"] = current_host_runtime
        if package_registration is not None:
            if "package_channel_registration" in context:
                raise ContractError("Package channel registration context is host-owned")
            context["package_channel_registration"] = {
                "channel": package_registration["channel"],
                "revision": package_registration["revision"],
                "package_id": package_registration["package_id"],
                "package_digest": package_registration["package_digest"],
            }
        if improver_channel_registration is not None:
            if not explicit_package or package_channel is not None:
                raise ContractError(
                    "Improver channel registration requires an explicit package")
            improver_channel_registration = _json_copy(
                improver_channel_registration, label="Improver channel registration")
            registration_keys = {"channel", "revision", "package_id", "package_digest"}
            if (not isinstance(improver_channel_registration, dict)
                    or set(improver_channel_registration) != registration_keys):
                raise ContractError(
                    "Improver channel registration must contain the frozen identity")
            from .improvers import active_improver_registration
            active_improver = active_improver_registration(
                self.store, improver_channel_registration["channel"])
            if (any(active_improver[key] != improver_channel_registration[key]
                    for key in registration_keys)
                    or package["id"] != improver_channel_registration["package_id"]
                    or package["digest"] != improver_channel_registration["package_digest"]):
                raise ContractError(
                    "Active improver registration differs from the expected deployment")
            context["improver_channel_registration"] = improver_channel_registration
        allowed_effects = constraints.get("allowed_effects")
        if ("allowed_effects" in constraints and
                (not isinstance(allowed_effects, list)
                 or any(effect not in _EFFECT_CLASSES for effect in allowed_effects)
                 or len(set(allowed_effects)) != len(allowed_effects))):
            raise ContractError("allowed_effects must be a unique list of supported effect classes")
        deliverables = deepcopy(deliverables if deliverables is not None else [{"name": "result", "schema": {}}])
        if not isinstance(deliverables, list) or not deliverables or len(deliverables) > 256:
            raise ContractError("Deliverables must be a nonempty bounded list")
        if any(not isinstance(item, dict) for item in deliverables):
            raise ContractError("Each deliverable must be a JSON object")
        deliverables = _json_copy(deliverables, label="Deliverables")
        names = [item.get("name") for item in deliverables]
        if (len(set(names)) != len(names)
                or any(not isinstance(name, str) or not name or len(name) > 120 for name in names)):
            raise ContractError("Deliverable names must be unique nonempty text")
        for item in deliverables:
            _check_local_schema(item.get("schema", {}), label=f"Deliverable {item['name']}")
        task = {"schema_version": 1, "objective": objective, "inputs": inputs,
                "deliverables": deliverables, "budget": budget, "capabilities": capabilities,
                "context": context, "constraints": constraints, "entry": entry,
                "tools": self.tools.describe(
                    initially_active_capabilities if lease_mode else capabilities)}
        if capability_authority is not None:
            from .capability_authority import validate_episode_authority
            task["capability_authority"] = validate_episode_authority(capability_authority)
        if lease_mode:
            task["capability_mode"] = "leased"
        episode = self.store.create(
            task, package, parent_episode_id,
            benchmark_registration=benchmark_registration,
            memory_registration=memory_registration,
            memory_version=frozen_memory_version,
            _allow_candidate_memory=_memory_candidate is not None,
            initial_capability_descriptors=initial_descriptors)
        refs = {}
        for name, value in task["inputs"].items():
            artifact = self.store.publish(episode["id"], value, name=name, scope="tree", node_id="input")
            refs[name] = artifact["id"]
        if episode["memory_snapshot_id"] is None:
            snapshot = self.store.snapshot(episode["id"], query="")
            snapshot_id = snapshot["id"]
        else:
            snapshot_id = episode["memory_snapshot_id"]
        return self._change(episode["id"], lambda s: s.update(
            input_refs=refs, memory_snapshot_id=snapshot_id))

    def mount_capability(self, identity, name, *, expected_revision=None):
        """Mount one installed tool into a stopped lease-mode Episode."""
        with self.store.lock(identity):
            descriptor = self.tools.lease_descriptor(name)
            return self.store.mount_capability(
                identity, descriptor, expected_revision=expected_revision)

    def release_capability(self, identity, name, *, expected_revision):
        """Release one tool from a stopped lease-mode Episode."""
        with self.store.lock(identity):
            return self.store.release_capability(
                identity, name, expected_revision=expected_revision)

    def active_capabilities(self, identity):
        """Return active durable leases after checking installed implementations."""
        with self.store.lock(identity):
            leases = self.store.capability_leases(identity, active_only=True)
            for lease in leases:
                self.tools.resolve_lease(lease)
            return leases

    def _dynamic_inventory(self, identity):
        result = []
        authority = self.store.get(identity)["task"].get("capability_authority")
        for instance in self.store.tool_instances(identity, active_only=True):
            definition = self.store.tool_definition(instance["definition_id"])
            if (authority is None or instance["authority_digest"] != authority["digest"]
                    or instance["definition_digest"] != definition["digest"]
                    or instance["name"] != definition["name"]):
                raise ContractError("Active tool instance has changed definition")
            result.append({
                "name": definition["name"], "description": definition["description"],
                "input_schema": deepcopy(definition["input_schema"]),
                "output_schema": deepcopy(definition["output_schema"]),
                "effect_class": definition["effect_class"], "work_units_per_call": 0,
                "definition_id": definition["id"], "definition_digest": definition["digest"],
                "instance_revision": instance["revision"],
            })
        return result

    def _service_inventory(self, identity):
        from .capability_authority import require_definition_authorized
        authority = self.store.get(identity)["task"].get("capability_authority")
        if authority is None:
            return None
        try:
            require_definition_authorized(authority, "service_provider", "model_context", [], [])
        except (PermissionError, ContractError):
            return None
        instance = self.store.service_instance(identity)
        if instance is None:
            return {"model_context.v1": {"status": "empty", "revision": 0}}
        definition = self.store.service_definition(instance["definition_id"])
        if (instance["definition_digest"] != definition["digest"]
                or instance["authority_digest"] != authority["digest"]
                or definition["origin_episode_id"] != identity):
            raise ContractError("Service provider identity or authority changed")
        return {"model_context.v1": {
            "status": instance["status"], "revision": instance["revision"],
            "definition_id": definition["id"], "definition_digest": definition["digest"],
            "name": definition["name"], "description": definition["description"],
        }}

    def list(self):
        return [self.get(state["id"]) for state in self.store.list() if not state["parent_episode_id"]]

    def _get_private_projection(self, identity):
        state = self.store.get(identity)
        state.update(usage=self.store.usage(state["root_episode_id"]), calls=self.store.calls(state["root_episode_id"]),
                     events=self.store.events(identity), artifacts=self.store.artifacts(identity),
                     children=[s for s in self.store.list() if s["parent_episode_id"] == identity],
                     memory_retrievals=self.store.retrievals(identity))
        return state

    def get_private(self, identity):
        """Return the host-only recovery projection, including durable receipts."""
        return self._get_private_projection(identity)

    @staticmethod
    def _public_projection(state):
        """Remove recovery-only requests and receipts from user-facing state."""
        state = deepcopy(state)
        state.pop("plan_node_receipts", None)
        state.pop("plan_workflow_snapshot", None)
        state.pop("plan_workflow_versions", None)
        context = state.get("task", {}).get("context", {})
        if context.get("rsi_role") == "candidate_generation":
            memory_patch_ref = state.get("output_refs", {}).get("memory_patch")
            for artifact in state.get("artifacts", []):
                if (isinstance(artifact, dict)
                        and artifact.get("id") == memory_patch_ref):
                    artifact.pop("content", None)
        for node in state.get("nodes", {}).values():
            if isinstance(node, dict):
                for key in ("request", "plan_receipt", "result"):
                    node.pop(key, None)
        for child in state.get("children", []):
            if isinstance(child, dict):
                child.pop("plan_node_receipts", None)
                child.pop("plan_workflow_snapshot", None)
                child.pop("plan_workflow_versions", None)
                for node in child.get("nodes", {}).values():
                    if isinstance(node, dict):
                        for key in ("request", "plan_receipt", "result"):
                            node.pop(key, None)
        for event in state.get("events", []):
            if isinstance(event, dict):
                content = event.get("content")
                if isinstance(content, dict):
                    for key in ("prompt", "messages", "request", "input"):
                        content.pop(key, None)
                if event.get("kind") == "tool" and isinstance(content, dict):
                    content.pop("arguments", None)
                    content.pop("result", None)
        for call in state.get("calls", []):
            if isinstance(call, dict):
                for key in ("prompt", "messages", "request", "input"):
                    call.pop(key, None)
        state["projection"] = "public"
        return state

    def get(self, identity):
        return self._public_projection(self._get_private_projection(identity))

    @staticmethod
    def _workflow_orchestrator(package, entry):
        manifest = package["manifest"]
        if manifest.get("manifest_version", 1) != 2 or entry != "execute":
            return None
        component_id = manifest["orchestrator"]
        component = manifest["components"][component_id]
        if component["kind"] != "workflow":
            return None
        return component_id, component["ref"]

    def _materialize_workflow(self, package, workflow_ref, capability_lease,
                              *, proposed_workflow=None,
                              capability_authority=None):
        """Resolve a frozen or proposed graph against the same manifest and lease."""
        manifest = package["manifest"]
        registered = manifest["workflows"].get(workflow_ref)
        if proposed_workflow is None:
            if not isinstance(registered, dict):
                raise ContractError(f"Workflow is not registered: {workflow_ref}")
            try:
                workflow = json.loads(package["files"][registered["ref"]])
            except (KeyError, TypeError, ValueError):
                raise ContractError(f"Registered workflow cannot be loaded: {workflow_ref}") from None
        else:
            workflow = _json_copy(proposed_workflow, label="Proposed workflow")
            if len(json.dumps(workflow, ensure_ascii=False)) > 240000:
                raise ContractError("Proposed workflow exceeds the task-time graph size limit")
        if not isinstance(workflow, dict):
            raise ContractError("Workflow must contain an object")
        workflow = deepcopy(workflow)
        if registered is not None:
            workflow.setdefault("input_schema", deepcopy(registered.get("input_schema", {})))
            workflow.setdefault("output_schema", deepcopy(registered.get("output_schema", {})))
        from .dynamic_roles import materialize_task_roles
        workflow = materialize_task_roles(workflow)
        from .workflows import _validate
        _validate(workflow)
        roles = manifest["roles"]
        components = manifest["components"]
        task_roles = workflow.get("task_roles", {})
        def authorize_nodes(definition, *, inside_loop=False):
            definition_nodes, definition_dependencies, _, _ = _validate(definition)
            lifecycle_methods = {
                "develop_tool", "release_tool", "develop_service",
                "activate_service", "release_service",
            }
            lifecycle_nodes = [
                node_id for node_id, node in definition_nodes.items()
                if node["method"] in lifecycle_methods
            ]
            if inside_loop and lifecycle_nodes:
                raise ContractError(
                    "Workflow capability lifecycle nodes cannot repeat inside a loop")
            ancestors = {}
            def node_ancestors(node_id):
                if node_id not in ancestors:
                    result = set(definition_dependencies[node_id])
                    for dependency in tuple(result):
                        result.update(node_ancestors(dependency))
                    ancestors[node_id] = result
                return ancestors[node_id]
            for index, node_id in enumerate(lifecycle_nodes):
                for other in lifecycle_nodes[index + 1:]:
                    if (node_id not in node_ancestors(other)
                            and other not in node_ancestors(node_id)):
                        raise ContractError(
                            "Workflow capability lifecycle nodes must be totally ordered")
            ask_fields = {"role", "prompt", "payload", "max_tokens"}
            capability_arguments = {
                "read_artifact": ({"artifact_id"}, {"artifact_id"}),
                "publish": ({"content", "name", "schema", "input_refs"}, {"content"}),
                "delegate": ({"task", "package_id"}, {"task"}),
                "develop_skill": (
                    {"proposal", "constraints", "mode", "repair"},
                    {"proposal", "constraints"},
                ),
                "tool": ({"name", "arguments"}, {"name"}),
                "develop_tool": ({"proposal"}, {"proposal"}),
                "develop_service": ({"proposal"}, {"proposal"}),
                "activate_service": (
                    {"definition_id", "expected_revision"},
                    {"definition_id", "expected_revision"},
                ),
                "release_service": (
                    {"expected_revision"}, {"expected_revision"}),
                "capability_inventory": (set(), set()),
            }
            def authority_grants(kind, effect):
                if capability_authority is None:
                    return False
                from .capability_authority import require_definition_authorized
                try:
                    require_definition_authorized(
                        capability_authority, kind, effect, [], [])
                except (ContractError, PermissionError):
                    return False
                return True
            def bounded_fields(fields):
                names = sorted(fields)
                rendered = ", ".join(name[:48] for name in names[:6])
                if len(names) > 6:
                    rendered += f", ... ({len(names) - 6} more)"
                return rendered
            def binding_reference(value):
                return (isinstance(value, dict) and len(value) == 1
                        and next(iter(value)) in {"$input", "$node", "$first_success"})
            def validate_delegate_task(node, params, input_ports):
                bindings = node.get("bindings", {})
                if "task" in bindings:
                    task = bindings["task"]
                elif "task" in params:
                    task = params["task"]
                elif any(port.startswith("task.") for port in input_ports):
                    task = {}
                else:
                    task = None
                if "task" in input_ports or binding_reference(task):
                    return
                if not isinstance(task, dict):
                    raise ContractError(
                        f"Workflow delegate node {node.get('id')!r} task must be an object "
                        "or a dynamic binding")
                dynamic_fields = {
                    port.split(".", 1)[1]
                    for port in input_ports
                    if port.startswith("task.") and port.count(".") == 1
                }
                objective = task.get("objective")
                if ("objective" not in dynamic_fields
                        and not binding_reference(objective)
                        and (not isinstance(objective, str) or not objective.strip()
                             or len(objective) > 20000)):
                    raise ContractError(
                        f"Workflow delegate node {node.get('id')!r} task requires a "
                        "nonempty bounded objective")
                deliverables = task.get("deliverables")
                if ("deliverables" not in dynamic_fields
                        and not binding_reference(deliverables)
                        and (not isinstance(deliverables, list) or not deliverables
                             or len(deliverables) > 256
                             or any(not isinstance(item, dict)
                                    and not binding_reference(item)
                                    for item in deliverables))):
                    raise ContractError(
                        f"Workflow delegate node {node.get('id')!r} task deliverables "
                        "must be a nonempty bounded list of objects")
                input_refs = task.get("input_refs")
                if ("input_refs" in task and "input_refs" not in dynamic_fields
                        and not binding_reference(input_refs)
                        and (not isinstance(input_refs, dict)
                             or any(not isinstance(ref, str)
                                    and not binding_reference(ref)
                                    for ref in input_refs.values()))):
                    raise ContractError(
                        f"Workflow delegate node {node.get('id')!r} task input_refs "
                        "must map names to artifact identities")
                capabilities = task.get("capabilities")
                if ("capabilities" in task and "capabilities" not in dynamic_fields
                        and not binding_reference(capabilities)
                        and (not isinstance(capabilities, list)
                             or len(capabilities) > 256
                             or any(not isinstance(name, str)
                                    and not binding_reference(name)
                                    for name in capabilities))):
                    raise ContractError(
                        f"Workflow delegate node {node.get('id')!r} task capabilities "
                        "must be a bounded list of names")
            role_artifact_targets = {
                edge.get("consumer_node") for edge in definition.get("artifact_edges", [])
                if isinstance(edge, dict) and edge.get("input_port") == "role"
            }
            artifact_fields = {}
            artifact_ports = {}
            for edge in definition.get("artifact_edges", []):
                if isinstance(edge, dict) and isinstance(edge.get("input_port"), str):
                    artifact_fields.setdefault(edge.get("consumer_node"), set()).add(
                        edge["input_port"].split(".", 1)[0])
                    artifact_ports.setdefault(edge.get("consumer_node"), set()).add(
                        edge["input_port"])
            for node in definition.get("nodes", []):
                if not isinstance(node, dict):
                    raise ContractError("Workflow nodes must be objects")
                method = node.get("method")
                if method not in CAPABILITIES | {"join", "loop"}:
                    raise ContractError("Workflow operator is not registered by the host")
                role_ref = node.get("role_ref")
                component_ref = node.get("component_ref")
                task_role = task_roles.get(role_ref)
                component = None
                if component_ref is not None:
                    if (isinstance(task_role, dict)
                            and component_ref == task_role.get("component_ref")):
                        component = {"kind": "role", "ref": role_ref}
                    else:
                        component = components.get(component_ref)
                    if not isinstance(component, dict):
                        raise ContractError(
                            f"Workflow component is not registered: {component_ref}")
                if role_ref is not None:
                    role = task_role if isinstance(task_role, dict) else roles.get(role_ref)
                    if not isinstance(role, dict):
                        raise ContractError(f"Workflow role is not registered: {role_ref}")
                    if method in CAPABILITIES and method not in role.get("capabilities", []):
                        raise PermissionError(
                            f"Role {role_ref!r} is not leased capability {method!r}")
                    if (component is None
                            or (component.get("kind"), component.get("ref"))
                            != ("role", role_ref)):
                        raise ContractError(
                            "Workflow role_ref requires an explicit matching role component_ref")
                params = node.get("params", {})
                provided_fields = (
                    set(params)
                    | set(node.get("bindings", {}))
                    | artifact_fields.get(node.get("id"), set())
                )
                if method in capability_arguments:
                    allowed_fields, required_fields = capability_arguments[method]
                    unsupported = provided_fields - allowed_fields
                    missing = required_fields - provided_fields
                    if unsupported or missing:
                        problems = []
                        if unsupported:
                            problems.append(
                                "unsupported top-level arguments: "
                                + bounded_fields(unsupported))
                        if missing:
                            problems.append(
                                "missing required arguments: "
                                + bounded_fields(missing))
                        raise ContractError(
                            f"Workflow {method} node {node.get('id')!r} has invalid "
                            "capability arguments (" + "; ".join(problems) + ")")
                if method in {"activate_service", "release_service"}:
                    bindings = node.get("bindings", {})
                    for field in ("definition_id", "expected_revision"):
                        if field in bindings and not binding_reference(bindings[field]):
                            raise ContractError(
                                f"Workflow {method} {field} binding must use "
                                "{'$node': 'node.field'} or {'$input': 'path'}")
                    revision = params.get("expected_revision")
                    if ("expected_revision" in params
                            and (type(revision) is not int or revision < 0)):
                        raise ContractError(
                            f"Workflow {method} expected_revision must be a "
                            "nonnegative integer or a binding")
                    definition_id = params.get("definition_id")
                    if ("definition_id" in params and
                            (not isinstance(definition_id, str)
                             or definition_id.startswith(("$node.", "$input.")))):
                        raise ContractError(
                            "Workflow activate_service definition_id must be "
                            "a literal identifier or a binding")
                if method == "delegate":
                    validate_delegate_task(
                        node, params, artifact_ports.get(node.get("id"), set()))
                if method == "ask":
                    if role_ref is None or component_ref is None:
                        raise ContractError(
                            "Workflow ask nodes require explicit role_ref and component_ref")
                    provided_ask_fields = (
                        set(node.get("params", {}))
                        | set(node.get("bindings", {}))
                        | artifact_fields.get(node.get("id"), set())
                    )
                    unsupported = provided_ask_fields - ask_fields
                    if unsupported:
                        raise ContractError(
                            "Workflow ask node has unsupported gateway arguments: "
                            + ", ".join(sorted(unsupported)))
                    if ("role" in node.get("bindings", {})
                            or node.get("id") in role_artifact_targets):
                        raise ContractError(
                            "Workflow ask role is derived from role_ref and cannot be bound")
                    if "role" in params and params["role"] != role_ref:
                        raise ContractError(
                            "Workflow ask params.role conflicts with its frozen role_ref")
                    params["role"] = role_ref
                    prompt_ref = role.get("prompt_ref")
                    if task_role is not None:
                        params.setdefault("prompt", task_role["prompt"])
                    elif prompt_ref is not None:
                        params.setdefault("prompt", package["files"][prompt_ref])
                    if "payload" not in provided_ask_fields:
                        raise ContractError(
                            "Workflow ask node must provide the model payload argument")
                if method == "tool":
                    tool_name = params.get("name") if isinstance(params, dict) else None
                    dynamic_name = (
                        "name" in node.get("bindings", {})
                        or "name" in artifact_fields.get(node.get("id"), set())
                    )
                    if dynamic_name:
                        if not authority_grants("tool", "local_compute"):
                            raise PermissionError(
                                "Workflow tool name binding requires tool-development authority")
                    elif not isinstance(tool_name, str) or tool_name not in capability_lease:
                        raise PermissionError(
                            "Workflow tool operator must resolve to the Episode capability lease")
                    else:
                        self.tools.get(tool_name)
                if method == "develop_tool" and not authority_grants(
                        "tool", "local_compute"):
                    raise PermissionError(
                        "Workflow tool development requires tool-development authority")
                if method in {"develop_service", "activate_service", "release_service"} \
                        and not authority_grants("service_provider", "model_context"):
                    raise PermissionError(
                        "Workflow service lifecycle requires model-context service authority")
                if method == "skill":
                    skill_name = params.get("name") if isinstance(params, dict) else None
                    if not isinstance(skill_name, str) or skill_name not in manifest.get("skills", {}):
                        raise ContractError("Workflow skill operator must resolve to a frozen skill")
                    if (role_ref is not None or component is None
                            or (component.get("kind"), component.get("ref"))
                            != ("skill", skill_name)):
                        raise ContractError(
                            "Workflow skill nodes require an explicit matching skill component_ref")
                if (method in {"join", "loop"} and (role_ref is not None or component_ref is not None)):
                    raise ContractError("Local workflow nodes cannot declare role_ref or component_ref")
                if (method not in {"ask", "skill", "join", "loop"}
                        and role_ref is None and component_ref is not None):
                    raise ContractError(
                        f"Workflow {method} nodes cannot declare component_ref without role_ref")
                if method == "loop":
                    if not isinstance(node.get("body"), dict):
                        raise ContractError("Loop body must be a workflow")
                    authorize_nodes(node["body"], inside_loop=True)
        authorize_nodes(workflow)
        for rule in workflow.get("revision_rules", []):
            if (not isinstance(rule, dict)
                    or ("workflow_ref" in rule and
                        rule["workflow_ref"] not in manifest["workflows"])):
                raise ContractError("Workflow revision references an unknown frozen workflow")
            planner_role_ref = rule.get("planner_role_ref")
            if planner_role_ref is not None:
                task_role = task_roles.get(planner_role_ref)
                role = task_role if isinstance(task_role, dict) else roles.get(planner_role_ref)
                if not isinstance(role, dict):
                    raise ContractError(
                        f"Workflow revision planner role is not registered: {planner_role_ref}"
                    )
                if "ask" not in role.get("capabilities", []):
                    raise PermissionError(
                        f"Workflow revision planner role {planner_role_ref!r} is not leased "
                        "capability 'ask'"
                    )
                if task_role is None:
                    role_components = [
                        component for component in components.values()
                        if (component.get("kind"), component.get("ref"))
                        == ("role", planner_role_ref)
                    ]
                    if len(role_components) != 1:
                        raise ContractError(
                            "Workflow revision planner role must have one registered role component"
                        )
                    prompt_ref = role.get("prompt_ref")
                    if not isinstance(prompt_ref, str) or prompt_ref not in package["files"]:
                        raise ContractError(
                            "Workflow revision planner role requires a frozen prompt resource"
                        )
        def has_retry(definition):
            return (any(route.get("action") == "retry"
                        for route in definition.get("failure_routes", [])
                        if isinstance(route, dict))
                    or any(node.get("method") == "loop"
                           and isinstance(node.get("body"), dict)
                           and has_retry(node["body"])
                           for node in definition.get("nodes", [])
                           if isinstance(node, dict)))

        if has_retry(workflow):
            raise ContractError(
                "ExecutablePlan v1 runtime does not support RETRY failure routes")
        return workflow

    def _persist_plan(self, identity, execution, receipts, workflow_ref,
                      workflow_snapshot=None):
        """Save the plan projection; RPC and artifact ledgers remain authoritative."""
        from .orchestration import NodeStatus

        if workflow_snapshot is not None and workflow_ref != "generated://" + digest(workflow_snapshot):
            raise RecoveryRequired("Generated workflow identity differs from its content")

        previous = self.store.get(identity)
        previous_ref = previous.get("current_plan_ref")
        node_by_id = {node.id: node for node in execution.plan.nodes}
        states = {state.node_id: state for state in execution.node_executions}
        control_dependencies = {node_id: set() for node_id in node_by_id}
        artifact_bindings = {node_id: [] for node_id in node_by_id}
        for binding in execution.plan.control_bindings:
            control_dependencies[binding.target_node_id].add(binding.source_node_id)
        for binding in execution.plan.artifact_bindings:
            control_dependencies[binding.consumer_node_id].add(binding.producer_node_id)
            artifact_bindings[binding.consumer_node_id].append({
                "producer_node_id": binding.producer_node_id,
                "output_port": binding.output_port,
                "input_port": binding.input_port,
                "schema_ref": binding.schema_ref,
            })
        history = ([execution.revisions[0].base_plan.ref]
                   + [revision.revised_plan.ref for revision in execution.revisions]
                   if execution.revisions else [execution.plan.ref])

        def update(state):
            state["current_plan_ref"] = execution.plan.ref
            state["plan_history_refs"] = history
            state["plan_revision"] = execution.plan.revision
            state["plan_revisions"] = [{
                "id": revision.id,
                "ref": revision.ref,
                "base_plan_ref": revision.base_plan.ref,
                "revised_plan_ref": revision.revised_plan.ref,
                "replaced_node_ids": list(revision.replaced_node_ids),
                "reason_ref": revision.reason_ref,
            } for revision in execution.revisions]
            state["plan_execution"] = execution.as_dict()
            state["plan_workflow_ref"] = workflow_ref
            state["plan_workflow_snapshot"] = deepcopy(workflow_snapshot)
            if workflow_snapshot is not None:
                versions = state.setdefault("plan_workflow_versions", {})
                if workflow_ref in versions and versions[workflow_ref] != workflow_snapshot:
                    raise RecoveryRequired("Generated workflow version changed after publication")
                versions[workflow_ref] = deepcopy(workflow_snapshot)
            state["plan_node_receipts"] = deepcopy(receipts)
            state["plan"] = execution.plan.as_dict()
            active_paths = set()
            for node_id, node in node_by_id.items():
                path = f"plan/nodes/{node_id}"
                active_paths.add(path)
                current = deepcopy(state["nodes"].get(path) or {})
                node_state = states[node_id]
                current.update({
                    "id": path,
                    "plan_node_id": node_id,
                    "plan_ref": execution.plan.ref,
                    "node_spec_ref": node.ref,
                    "operator_ref": node.operator_ref,
                    "role_ref": node.role_ref,
                    "component_ref": node.component_ref,
                    "control_dependencies": sorted(control_dependencies[node_id]),
                    "artifact_bindings": sorted(
                        artifact_bindings[node_id],
                        key=lambda value: (value["input_port"], value["producer_node_id"]),
                    ),
                    "local_limits": {
                        "max_attempts": node.local_limits.max_attempts,
                        "max_iterations": node.local_limits.max_iterations,
                        "timeout_seconds": node.local_limits.timeout_seconds,
                        "max_model_calls": node.local_limits.max_model_calls,
                        "max_tool_calls": node.local_limits.max_tool_calls,
                        "max_child_episodes": node.local_limits.max_child_episodes,
                        "max_work_units": node.local_limits.max_work_units,
                    },
                    "status": node_state.status.value,
                    "attempt_count": node_state.attempt_count,
                    "iteration_count": node_state.iteration_count,
                    "input_refs": list(node_state.input_artifact_refs),
                    "output_refs": list(node_state.output_artifact_refs),
                })
                if node_id in receipts:
                    current["plan_receipt"] = deepcopy(receipts[node_id])
                    if node_state.status is NodeStatus.COMPLETED:
                        current["result"] = deepcopy(receipts[node_id].get("value"))
                state["nodes"][path] = current
            for path, node in state["nodes"].items():
                if path.startswith("plan/nodes/") and path not in active_paths:
                    node["status"] = "superseded"

        self._change(identity, update)
        if previous_ref != execution.plan.ref:
            kind = "plan_committed" if previous_ref is None else "plan_revised"
            self.store.event(identity, kind, {
                "plan_ref": execution.plan.ref,
                "revision": execution.plan.revision,
                "workflow_ref": workflow_ref,
                "previous_plan_ref": previous_ref,
            })

    def _verify_nested_loop_journals(
            self, identity, package, workflow, result, prefix):
        """Bind a persisted loop history to every nested external RPC outcome."""
        from .workflows import _validate

        try:
            nodes, _, _, _ = _validate(workflow)
            nested_receipts = result["nodes"]
        except (KeyError, TypeError, ValueError) as exc:
            raise RecoveryRequired("Persisted loop history is malformed") from exc
        if not isinstance(nested_receipts, dict) or set(nested_receipts) != set(nodes):
            raise RecoveryRequired("Persisted loop history has inconsistent nodes")
        for node_id, node in nodes.items():
            receipt = nested_receipts[node_id]
            if not isinstance(receipt, dict) or receipt.get("status") not in {
                    "completed", "failed", "skipped"}:
                raise RecoveryRequired("Persisted loop node receipt is malformed")
            if receipt["status"] == "skipped" or node["method"] == "join":
                continue
            path = f"{prefix}nodes/{node_id}"
            if node["method"] == "loop":
                value = receipt.get("value")
                history = value.get("history") if isinstance(value, dict) else None
                iterations = value.get("iterations") if isinstance(value, dict) else None
                if (type(iterations) is not int or iterations < 0
                        or not isinstance(history, list) or len(history) != iterations
                        or iterations > node["max_iterations"]):
                    raise RecoveryRequired("Persisted nested loop iteration evidence is invalid")
                for index, iteration in enumerate(history):
                    self._verify_nested_loop_journals(
                        identity, package, node["body"], iteration,
                        f"{path}/iterations/{index}/",
                    )
                continue
            journal = self.store.rpc_find(identity, path)
            request = journal.get("request") if isinstance(journal, dict) else None
            if (not isinstance(request, dict)
                    or request.get("method") != node["method"]
                    or request.get("package_digest") != package["digest"]
                    or not isinstance(request.get("params"), dict)):
                raise RecoveryRequired(
                    f"Nested loop node {node_id} is missing its RPC request")
            try:
                self.store.rpc_find(identity, path, request)
            except (KeyError, TypeError, ValueError) as exc:
                raise RecoveryRequired(
                    f"Nested loop node {node_id} RPC request identity is invalid") from exc
            if journal.get("status") == "completed":
                if (receipt.get("status") != "completed"
                        or receipt.get("value") != journal.get("result")):
                    raise RecoveryRequired(
                        f"Nested loop node {node_id} differs from its RPC outcome")
            elif (journal.get("status") != "failed"
                  or receipt.get("status") != "failed"):
                raise RecoveryRequired(
                    f"Nested loop node {node_id} differs from its RPC status")

    def _run_workflow_orchestrator(
            self, identity, package, component_id, initial_workflow_ref,
            payload, stop_event, notify):
        from .orchestration import (
            NodeStatus, PlanExecution, PlanRevision, plan_execution_from_dict,
        )
        from .workflows import (
            _failed, _node_parameters, _validate, plan_from_workflow,
            run_executable_workflow,
        )

        state = self.store.get(identity)
        workflow_ref = [state.get("plan_workflow_ref") or initial_workflow_ref]
        loaded_workflow_refs = (
            {workflow_ref[0]} if workflow_ref[0] in package["manifest"]["workflows"]
            else set())
        workflow_snapshot = [state.get("plan_workflow_snapshot")]
        workflow_versions = state.get("plan_workflow_versions") or {}
        if (not isinstance(workflow_versions, dict)
                or any(not isinstance(candidate, dict)
                       or ref != "generated://" + digest(candidate)
                       for ref, candidate in workflow_versions.items())):
            raise RecoveryRequired("Generated workflow version archive is invalid")
        if workflow_ref[0].startswith("generated://"):
            if (not isinstance(workflow_snapshot[0], dict)
                    or workflow_ref[0] != "generated://" + digest(workflow_snapshot[0])
                    or workflow_versions.get(workflow_ref[0]) != workflow_snapshot[0]):
                raise RecoveryRequired("Generated workflow snapshot is missing or changed")
        elif workflow_snapshot[0] is not None:
            raise RecoveryRequired("Frozen workflow has an unexpected generated snapshot")
        workflow = self._materialize_workflow(
            package, workflow_ref[0], state["capabilities"],
            proposed_workflow=workflow_snapshot[0],
            capability_authority=state["task"].get("capability_authority"))
        workflow_current = [workflow]
        if state.get("plan_execution") is None:
            plan = plan_from_workflow(workflow, component_id)
            execution = PlanExecution.create(identity, plan)
            receipts = {}
        else:
            execution = plan_execution_from_dict(state["plan_execution"])
            expected = plan_from_workflow(
                workflow, component_id, revision=execution.plan.revision)
            if expected != execution.plan:
                raise RecoveryRequired(
                    "Persisted plan differs from its frozen workflow resource")
            receipts = deepcopy(state.get("plan_node_receipts") or {})
            methods = {node["id"]: node["method"] for node in workflow["nodes"]}
            plan_nodes = {node.id: node for node in execution.plan.nodes}
            workflow_nodes, _, _, workflow_artifacts = _validate(workflow)
            resumable_local_nodes = set()
            for node_state in execution.node_executions:
                for artifact_ref in (
                        *node_state.input_artifact_refs,
                        *node_state.output_artifact_refs):
                    try:
                        self.store.read(artifact_ref, identity)
                    except (KeyError, PermissionError, ValueError) as exc:
                        raise RecoveryRequired(
                            f"Plan node {node_state.node_id} references invalid artifact evidence"
                        ) from exc
                if node_state.status is NodeStatus.RUNNING:
                    node_id = node_state.node_id
                    path = f"plan/nodes/{node_id}"
                    method = methods[node_id]
                    if (method not in {"loop", "develop_skill"}
                            or node_id in receipts
                            or node_state.iteration_count != 0):
                        raise RecoveryRequired(
                            f"Plan node {node_id} was admitted without a durable outcome")
                    try:
                        resumed_params = _node_parameters(
                            node_id, workflow_nodes, workflow_artifacts,
                            payload, receipts,
                        )
                    except Exception as exc:
                        raise RecoveryRequired(
                            f"Running plan node {node_id} inputs cannot be reconstructed"
                        ) from exc
                    if (tuple(self._references(identity, resumed_params))
                            != node_state.input_artifact_refs):
                        raise RecoveryRequired(
                            f"Running plan node {node_id} input evidence differs from its dependencies")
                    if method == "loop":
                        if self.store.rpc_find(identity, path) is not None:
                            raise RecoveryRequired(
                                f"Running loop node {node_id} has an unexpected parent RPC")
                        for journal in self.store.rpc_under(
                                identity, f"{path}/iterations/"):
                            request = journal.get("request")
                            if (journal.get("status") not in {"completed", "failed"}
                                    or not isinstance(request, dict)
                                    or set(request) != {"method", "params", "package_digest"}
                                    or request.get("method") not in CAPABILITIES
                                    or not isinstance(request.get("params"), dict)
                                    or request.get("package_digest") != package["digest"]):
                                raise RecoveryRequired(
                                    f"Running loop node {node_id} has an unfinished nested RPC")
                            try:
                                self.store.rpc_find(
                                    identity, journal["call_path"], request)
                            except (KeyError, TypeError, ValueError) as exc:
                                raise RecoveryRequired(
                                    f"Running loop node {node_id} nested RPC identity is invalid"
                                ) from exc
                    else:
                        parent_request = {
                            "method": method,
                            "params": resumed_params,
                            "package_digest": package["digest"],
                        }
                        try:
                            journal = self.store.rpc_find(
                                identity, path, parent_request)
                        except (KeyError, TypeError, ValueError) as exc:
                            raise RecoveryRequired(
                                f"Running develop_skill node {node_id} RPC identity is invalid"
                            ) from exc
                        if journal is None or journal.get("status") != "started":
                            raise RecoveryRequired(
                                f"Running develop_skill node {node_id} has no resumable parent RPC")
                    resumable_local_nodes.add(node_id)
                    continue
                if not node_state.status.terminal:
                    continue
                receipt = receipts.get(node_state.node_id)
                if not isinstance(receipt, dict):
                    raise RecoveryRequired("Terminal plan node is missing its host receipt")
                if node_state.status in {NodeStatus.SKIPPED, NodeStatus.CANCELLED}:
                    continue
                if (tuple(self._references(identity, receipt.get("value")))
                        != node_state.output_artifact_refs):
                    raise RecoveryRequired(
                        f"Plan node {node_state.node_id} artifact evidence differs from the ledger")
                path = f"plan/nodes/{node_state.node_id}"
                journal = self.store.rpc_find(identity, path)
                expected_status = ("completed" if node_state.status is NodeStatus.COMPLETED
                                   else "failed")
                request = journal.get("request") if isinstance(journal, dict) else None
                expected_method = methods[node_state.node_id]
                local_method = expected_method in {"join", "loop"}
                if local_method:
                    outcome_matches = (
                        isinstance(journal, dict)
                        and journal.get("status") == "completed"
                        and journal.get("result") == receipt
                    )
                else:
                    outcome_matches = (
                        isinstance(journal, dict)
                        and journal.get("status") == expected_status
                        and (expected_status != "completed"
                             or journal.get("result") == receipt.get("value"))
                    )
                if (not outcome_matches
                        or not isinstance(request, dict)
                        or set(request) != {"method", "params", "package_digest"}
                        or request["method"] != expected_method
                        or not isinstance(request["params"], dict)
                        or request["package_digest"] != package["digest"]
                        or not plan_nodes[node_state.node_id].operator_ref.startswith(
                            f"operator://{expected_method}/")):
                    raise RecoveryRequired(
                        f"Plan node {node_state.node_id} receipt differs from the RPC journal")
                try:
                    self.store.rpc_find(identity, path, request)
                except (KeyError, TypeError, ValueError) as exc:
                    raise RecoveryRequired(
                        f"Plan node {node_state.node_id} RPC request identity is invalid") from exc
                if (tuple(self._references(identity, request["params"]))
                        != node_state.input_artifact_refs):
                    raise RecoveryRequired(
                        f"Plan node {node_state.node_id} input artifact evidence differs from the RPC journal")
                if expected_method == "join":
                    params = None
                    try:
                        params = _node_parameters(
                            node_state.node_id, workflow_nodes, workflow_artifacts,
                            payload, receipts,
                        )
                        if "output_schema" in workflow_nodes[node_state.node_id]:
                            validate(
                                params, workflow_nodes[node_state.node_id]["output_schema"],
                                label=f"node {node_state.node_id} output",
                            )
                        expected_receipt = {"status": "completed", "value": params}
                    except Exception as exc:
                        expected_receipt = _failed(exc)
                    expected_params = (
                        {"host_preflight": True} if params is None else params)
                    if (receipt != expected_receipt
                            or request["params"] != expected_params):
                        raise RecoveryRequired(
                            f"Join node {node_state.node_id} differs from its dependencies")
                elif expected_method == "loop":
                    try:
                        loop_params = _node_parameters(
                            node_state.node_id, workflow_nodes, workflow_artifacts,
                            payload, receipts,
                        )
                    except Exception as exc:
                        expected_receipt = _failed(exc)
                        if (request["params"] == {"host_preflight": True}
                                and receipt == expected_receipt
                                and node_state.iteration_count == 0):
                            continue
                        raise RecoveryRequired(
                            f"Loop node {node_state.node_id} inputs cannot be reconstructed"
                        ) from exc
                    if request["params"] != loop_params:
                        raise RecoveryRequired(
                            f"Loop node {node_state.node_id} differs from its dependencies")
                    value = receipt.get("value")
                    history = value.get("history") if isinstance(value, dict) else None
                    iterations = value.get("iterations") if isinstance(value, dict) else None
                    if (type(iterations) is not int or iterations < 0
                            or not isinstance(history, list) or len(history) != iterations
                            or iterations != node_state.iteration_count
                            or iterations > workflow_nodes[node_state.node_id]["max_iterations"]):
                        raise RecoveryRequired(
                            f"Loop node {node_state.node_id} iteration evidence is invalid")
                    for index, iteration in enumerate(history):
                        self._verify_nested_loop_journals(
                            identity, package,
                            workflow_nodes[node_state.node_id]["body"], iteration,
                            f"{path}/iterations/{index}/",
                        )

        if state.get("plan_execution") is None:
            resumable_local_nodes = set()

        def persist(current, current_receipts):
            self._persist_plan(
                identity, current, current_receipts, workflow_ref[0],
                workflow_snapshot[0])
            notify()

        def resolve_revision(rule, current, trigger_receipt):
            if "proposal_path" in rule or "planner_role_ref" in rule:
                from .graph_compiler_repair import (
                    GraphRepairExhausted, compile_with_graph_repair,
                )
                from .workflows import _get

                planner_role_ref = rule.get("planner_role_ref")
                planner_max_tokens = rule.get("planner_max_tokens", 4000)
                checkpoint_payload = None
                if planner_role_ref is not None:
                    task_role = workflow_current[0].get("task_roles", {}).get(
                        planner_role_ref)
                    role = (task_role if isinstance(task_role, dict)
                            else package["manifest"]["roles"].get(planner_role_ref))
                    if not isinstance(role, dict):
                        raise ContractError(
                            f"Workflow revision planner role is not registered: "
                            f"{planner_role_ref}"
                        )
                    prompt = (role.get("prompt") if isinstance(task_role, dict)
                              else package["files"].get(role.get("prompt_ref")))
                    if not isinstance(prompt, str) or not prompt:
                        raise ContractError(
                            "Workflow revision planner role has no frozen prompt"
                        )
                    checkpoint_payload = {
                        "schema": "nexgent.plan-revision-checkpoint.v1",
                        "task": deepcopy(payload),
                        "rule_id": rule["id"],
                        "base_plan_ref": current.plan.ref,
                        "current_workflow": deepcopy(workflow_current[0]),
                        "trigger_node": rule["after_node"],
                        "trigger_receipt": deepcopy(trigger_receipt),
                    }
                    reply = self._dispatch(
                        identity, package, "ask", {
                            "role": planner_role_ref,
                            "prompt": prompt,
                            "payload": checkpoint_payload,
                            "max_tokens": planner_max_tokens,
                        },
                        f"plan/revision-checkpoints/{current.plan.revision}/{rule['id']}",
                        stop_event, notify, admitted=True,
                    )
                    proposal = _get(reply, "proposal")
                else:
                    proposal = _get(trigger_receipt["value"], rule["proposal_path"])
                if not isinstance(proposal, dict):
                    raise ContractError("Graph proposal must be a JSON object")
                def repair(request, repair_path):
                    if planner_role_ref is None:
                        source = next(node for node in workflow_current[0]["nodes"]
                                      if node["id"] == rule["after_node"])
                        if source["method"] != "ask" or not source.get("role_ref"):
                            raise ContractError(
                                "Graph compiler repair needs a model role at the checkpoint")
                        repair_role = source["role_ref"]
                        repair_prompt = source["params"]["prompt"]
                        repair_payload = {"task": payload, "compiler_feedback": request}
                        response_path = rule["proposal_path"]
                        repair_max_tokens = source["params"].get("max_tokens", 4000)
                    else:
                        repair_role = planner_role_ref
                        repair_prompt = prompt
                        repair_payload = {
                            **checkpoint_payload,
                            "compiler_feedback": request,
                        }
                        response_path = "proposal"
                        repair_max_tokens = planner_max_tokens
                    self.store.event(identity, "graph_compiler_rejected", {
                        "plan_ref": current.plan.ref,
                        "rule_id": rule["id"],
                        "diagnostic": request["diagnostic"],
                    })
                    reply = self._dispatch(
                        identity, package, "ask", {
                            "role": repair_role,
                            "prompt": repair_prompt + "\nThe previous graph did not compile. "
                                      "Use compiler_feedback to return a complete corrected JSON "
                                      "proposal in the same envelope. Do not repeat the invalid graph.",
                            "payload": repair_payload,
                            "max_tokens": repair_max_tokens,
                        },
                        f"plan/{repair_path}", stop_event, notify, admitted=True,
                    )
                    return _get(reply, response_path)

                try:
                    compiled = compile_with_graph_repair(
                        execution=current,
                        base_workflow=workflow_current[0],
                        initial_proposal=proposal,
                        patch_id=rule["id"],
                        replaced_node_ids=rule.get("replace_node_ids"),
                        reason_ref=rule.get("reason_ref"),
                        max_attempts=rule.get("max_compile_attempts", 1),
                        repair_path=f"graph-repair/{current.plan.revision}/{rule['id']}",
                        materialize_callback=lambda candidate: self._materialize_workflow(
                            package, "generated", state["capabilities"],
                            proposed_workflow=candidate,
                            capability_authority=state["task"].get(
                                "capability_authority")),
                        repair_callback=repair,
                    )
                except GraphRepairExhausted as exc:
                    self.store.event(identity, "graph_compiler_rejected", {
                        "plan_ref": current.plan.ref,
                        "rule_id": rule["id"],
                        "diagnostic": exc.diagnostics[-1].as_dict(),
                    })
                    raise
                revised_workflow, revision = compiled.revised_workflow, compiled.revision
                target_ref = "generated://" + digest(revised_workflow)
                workflow_ref[0] = target_ref
                workflow_snapshot[0] = revised_workflow
                workflow_current[0] = revised_workflow
                return revised_workflow, revision
            target_ref = rule["workflow_ref"]
            revised_workflow = self._materialize_workflow(
                package, target_ref, state["capabilities"],
                capability_authority=state["task"].get("capability_authority"))
            revised_plan = plan_from_workflow(
                revised_workflow, component_id, revision=current.plan.revision + 1)
            revision = PlanRevision(
                id=rule["id"],
                base_plan=current.plan,
                revised_plan=revised_plan,
                replaced_node_ids=tuple(rule["replace_node_ids"]),
                reason_ref=rule.get("reason_ref"),
            )
            workflow_ref[0] = target_ref
            workflow_snapshot[0] = None
            workflow_current[0] = revised_workflow
            loaded_workflow_refs.add(target_ref)
            return revised_workflow, revision

        def invoke(method, params, path):
            result = self._dispatch(
                identity, package, method, params, path, stop_event, notify,
                admitted=True)
            journal = self.store.rpc_find(identity, path)
            if (journal is None or journal["status"] != "completed"
                    or journal["result"] != result):
                raise RecoveryRequired("Plan node result is not durable in the RPC journal")
            return deepcopy(journal["result"])

        def record_local_receipt(method, params, path, receipt):
            request = {
                "method": method,
                "params": deepcopy(params),
                "package_digest": package["digest"],
            }
            journal = self.store.rpc_find(identity, path, request)
            if journal is None:
                self.store.rpc_start(identity, path, request)
                journal = self.store.rpc_finish(identity, path, result=receipt)
            if (journal.get("status") != "completed"
                    or journal.get("result") != receipt):
                raise RecoveryRequired(
                    f"Local plan node {path} differs from its host journal")

        result = run_executable_workflow(
            workflow,
            payload,
            invoke,
            execution=execution,
            persist=persist,
            resolve_revision=resolve_revision,
            receipt_evidence=lambda _kind, value: self._references(identity, value),
            record_local_receipt=record_local_receipt,
            initial_receipts=receipts,
            resumable_local_nodes=resumable_local_nodes,
            stop_event=stop_event,
            max_parallel=lambda: package["manifest"]["workflows"].get(
                workflow_ref[0],
                package["manifest"]["workflows"][initial_workflow_ref]
            ).get("max_parallel", 4),
        )
        if result["status"] != "completed":
            raise ContractError(result.get("error") or "Executable plan did not complete")
        plan_history = set(self.store.get(identity).get("plan_history_refs") or [])
        for event in self.store.events(identity):
            content = event.get("content") or {}
            if (event.get("kind") in {"plan_committed", "plan_revised"}
                    and content.get("plan_ref") in plan_history
                    and content.get("workflow_ref") in package["manifest"]["workflows"]):
                loaded_workflow_refs.add(content["workflow_ref"])
        loaded_files = {
            package["manifest"]["workflows"][ref]["ref"]
            for ref in loaded_workflow_refs
        }
        for journal in self.store.rpc_under(identity, "plan/nodes/"):
            request = journal.get("request") or {}
            if (journal.get("status") != "completed"
                    or request.get("package_digest") != package["digest"]):
                continue
            params = request.get("params") or {}
            if request.get("method") == "ask":
                role = package["manifest"]["roles"].get(params.get("role"))
                if isinstance(role, dict) and role.get("prompt_ref"):
                    loaded_files.add(role["prompt_ref"])
            elif request.get("method") == "skill":
                skill = package["manifest"].get("skills", {}).get(params.get("name"))
                if isinstance(skill, dict):
                    ref = skill["ref"]
                    loaded_files.add(ref.split(":", 1)[0]
                                     if skill["kind"] == "controlled_code" else ref)
        return {
            "value": result["outputs"],
            "execution": {
                "kind": "executable_plan",
                "package_digest": package["digest"],
                "loaded_modules": sorted(loaded_files),
                "plan_ref": result["plan_execution"].plan.ref,
                "plan_revision": result["plan_execution"].plan.revision,
                "workflow_ref": workflow_ref[0],
            },
        }

    def run(self, identity, on_update=None, stop_event=None):
        stop_event = stop_event if stop_event is not None else threading.Event()
        with self.store.lock(identity):
            state = self.store.get(identity)
            if state["status"] == "completed":
                return self.get(identity)
            if state["status"] == "cancelled":
                raise ContractError("A cancelled task needs a new task identity")
            benchmark_registration = self.store.benchmark_registration(identity)
            if (benchmark_registration is not None
                    and benchmark_registration.get("host_runtime")
                    != host_runtime_fingerprint()):
                raise ContractError(
                    "Benchmark host runtime changed before Episode execution or resume")
            package = self.store.package(state["package_id"])
            active_leases = None
            if state["task"].get("capability_mode") == "leased":
                active_leases = self.store.capability_leases(identity, active_only=True)
                # Resolve every active descriptor before execution begins. A
                # restarted host with a missing or changed provider therefore
                # leaves the stopped Episode untouched and fails closed.
                for lease in active_leases:
                    self.tools.resolve_lease(lease)
            improver_registration = state["task"].get("context", {}).get(
                "improver_channel_registration")
            if improver_registration is not None:
                registration_keys = {"channel", "revision", "package_id", "package_digest"}
                if (not isinstance(improver_registration, dict)
                        or set(improver_registration) != registration_keys):
                    raise ContractError("Improver channel registration is invalid")
                from .improvers import active_improver_registration
                active_improver = active_improver_registration(
                    self.store, improver_registration["channel"])
                if (any(active_improver[key] != improver_registration[key]
                        for key in registration_keys)
                        or package["id"] != improver_registration["package_id"]
                        or package["digest"] != improver_registration["package_digest"]):
                    raise ContractError(
                        "Active improver registration differs from the Episode package")
            self._change(identity, lambda s: s.update(
                status="running", last_error=None, failure_domain=None,
                evaluation=None))
            self.store.event(identity, "episode_started", {"package_digest": package["digest"], "resume": bool(state["nodes"])})

            def notify():
                if on_update:
                    on_update(self.get(identity))

            payload = deepcopy(state["task"])
            payload.pop("inputs", None)
            if active_leases is not None:
                # Preserve the legacy public tool-description shape while
                # deriving the inventory from current leases.
                payload["tools"] = self.tools.describe(
                    [lease["name"] for lease in active_leases])
            if state["task"].get("capability_authority") is not None:
                payload["tools"] = payload["tools"] + self._dynamic_inventory(identity)
                services = self._service_inventory(identity)
                if services is not None:
                    payload["services"] = services
                    # Binding paths are dot-separated, so the dotted service
                    # interface key needs a separate path-safe projection.
                    payload["model_context_service"] = deepcopy(
                        services["model_context.v1"])
            from .self_orchestration_seed import available_operators_for_authority
            payload["available_operators"] = available_operators_for_authority(
                state["task"].get("capability_authority"))
            payload.update(episode_id=identity, input_refs=state["input_refs"],
                           memory_snapshot=self.store.memory_snapshot(state["memory_snapshot_id"], identity),
                           skills=deepcopy(package["manifest"].get("skills", {})),
                           available_skills=_available_skill_inventory(package))
            counter = [0]
            recovery_errors = []
            failure_domains = []

            def handle(method, params):
                counter[0] += 1
                try:
                    return self._dispatch(identity, package, method, params, f"rpc.{counter[0]}", stop_event, notify)
                except RecoveryRequired as exc:
                    # The subprocess protocol wraps handler exceptions. Keep a
                    # host-side signal so an uncertain admitted call cannot be
                    # misclassified as an ordinary package failure.
                    recovery_errors.append(str(exc))
                    failure_domains.append("infrastructure")
                    raise CapabilityAbort(exc) from exc
                except InterruptedError as exc:
                    failure_domains.append("infrastructure")
                    raise CapabilityAbort(exc) from exc
                except (BudgetExhausted, StateConflict) as exc:
                    failure_domains.append(_capability_failure_domain(method, exc))
                    raise CapabilityAbort(exc) from exc
                except CapabilityAbort as exc:
                    failure_domains.append(_capability_failure_domain(method, exc))
                    raise
                except Exception as exc:
                    failure_domains.append(_capability_failure_domain(method, exc))
                    raise

            notify()
            try:
                workflow_orchestrator = self._workflow_orchestrator(
                    package, state["task"]["entry"])
                if workflow_orchestrator is None:
                    execution = run_package(
                        package, state["task"]["entry"], payload, handle,
                        stop_event=stop_event,
                        timeout=state["task"].get("constraints", {}).get(
                            "wall_seconds", 1200),
                        max_rpc=512, max_instructions=5_000_000,
                    )
                else:
                    execution = self._run_workflow_orchestrator(
                        identity, package, workflow_orchestrator[0],
                        workflow_orchestrator[1], payload, stop_event, notify)
                self._complete(identity, execution)
            except InterruptedError as exc:
                self._change(identity, lambda s: s.update(
                    status="paused", last_error=str(exc), failure_domain="infrastructure"))
            except RecoveryRequired as exc:
                self._change(identity, lambda s: s.update(
                    status="waiting_input", last_error=str(exc), failure_domain="infrastructure"))
            except CapabilityAbort as exc:
                # Direct workflow nodes invoke host capabilities without the
                # controlled-code subprocess. Preserve their uncatchable
                # control signal at the host boundary instead of leaving the
                # Episode running after a budget or provider failure.
                cause = exc.cause
                if isinstance(cause, InterruptedError) or stop_event.is_set():
                    status, domain = "paused", "infrastructure"
                elif isinstance(cause, RecoveryRequired):
                    status, domain = "waiting_input", "infrastructure"
                else:
                    status = "failed"
                    domain = _capability_failure_domain("ask", exc)
                self._change(identity, lambda s: s.update(
                    status=status,
                    last_error=f"{type(cause).__name__}: {str(cause)[:1200]}",
                    failure_domain=domain))
            except CapabilityAbort as abort:
                cause = abort.cause
                if isinstance(cause, RecoveryRequired):
                    status, domain = "waiting_input", "infrastructure"
                elif isinstance(cause, InterruptedError):
                    status, domain = "paused", "infrastructure"
                else:
                    status = "failed"
                    domain = _capability_failure_domain("workflow", cause)
                self._change(identity, lambda s: s.update(
                    status=status,
                    last_error=f"{type(cause).__name__}: {str(cause)[:1200]}",
                    failure_domain=domain))
            except Exception as exc:
                if recovery_errors:
                    self._change(identity, lambda s: s.update(
                        status="waiting_input", last_error=recovery_errors[-1],
                        failure_domain="infrastructure"))
                else:
                    failure_domain = _terminal_failure_domain(exc, failure_domains)
                    self._change(identity, lambda s: s.update(status="paused" if stop_event.is_set() else "failed",
                        last_error=f"{type(exc).__name__}: {str(exc)[:1200]}",
                        failure_domain=failure_domain))
            except (KeyboardInterrupt, SystemExit) as exc:
                # Host interruption (notably KeyboardInterrupt) still runs the
                # finally block. Persist a non-running terminal projection
                # before propagating it so paired trials cannot leave an
                # Episode looking active after the process has stopped.
                self._change(identity, lambda s: s.update(
                    status="paused",
                    last_error=f"{type(exc).__name__}: {str(exc)[:1200]}",
                    failure_domain="infrastructure"))
                raise
            finally:
                self.store.event(identity, "episode_finished", {"status": self.store.get(identity)["status"]})
                notify()
            return self.get(identity)

    def _complete(self, identity, execution):
        value = execution["value"]
        if not isinstance(value, dict) or not isinstance(value.get("deliverables"), dict):
            raise ContractError("Task entry must return deliverables as a name-to-artifact-reference map")
        state = self.store.get(identity)
        refs = value["deliverables"]
        required = state["task"]["deliverables"]
        for spec in required:
            if spec["name"] not in refs:
                raise ContractError(f"Required deliverable missing: {spec['name']}")
            artifact = self.store.read(refs[spec["name"]], identity)
            validate(artifact["content"], spec.get("schema", {}), label=spec["name"])
        for ref in refs.values():
            self.store.read(ref, identity)
        outcome = {"delivery_status": "delivered", "acceptance_status": "not_evaluated",
                   "limitations": value.get("limitations", []), "summary": value.get("summary", ""),
                   "schema_validation": "passed"}
        self._change(identity, lambda s: s.update(status="completed", output_refs=refs, outcome=outcome,
                                                   execution=execution["execution"], evaluation=None,
                                                   failure_domain=None))

    def _publish(self, identity, path, content, name, schema, input_refs=None):
        state = self.store.get(identity)
        specs = {spec["name"]: spec for spec in state["task"].get("deliverables", [])}
        schema_checked = False
        if name in specs:
            validate(content, specs[name].get("schema", {}), label=name)
            schema_checked = True
        if not isinstance(schema, (dict, str)):
            raise ContractError("Artifact schema must be a registered name or local JSON schema")
        if isinstance(schema, dict):
            validate(content, schema, label=name or "artifact")
            schema_checked = True
        if input_refs is None:
            input_refs = []
        if (not isinstance(input_refs, list) or len(input_refs) > 1000
                or any(not isinstance(ref, str) for ref in input_refs)):
            raise ContractError("Artifact input_refs must be a bounded list of artifact identities")
        explicit_refs = {self.store.read(ref, identity)["id"] for ref in input_refs}
        refs = sorted(explicit_refs | set(self._references(identity, content)))
        return self.store.publish(identity, content, schema_ref=schema, name=name, node_id=path, attempt_id=path,
                                  package_digest=state["package_digest"], input_refs=refs, scope="tree",
                                  validation={"schema_status": "passed",
                                              "checker_ref": "host-jsonschema-2020-12"}
                                  if schema_checked else None)

    def _references(self, identity, value):
        result = set()
        def visit(item):
            if isinstance(item, dict):
                for child in item.values(): visit(child)
            elif isinstance(item, list):
                for child in item: visit(child)
            elif isinstance(item, str) and item.startswith("artifact-"):
                try:
                    artifact = self.store.read(item, identity)
                except (KeyError, PermissionError):
                    # This traversal supplies best-effort lineage metadata for
                    # arbitrary JSON. Artifact-like labels in prompts, errors,
                    # tool arguments, or content are not explicit references.
                    # read_artifact and publish(input_refs=...) remain strict.
                    return
                result.add(artifact["id"])
        visit(value)
        return sorted(result)

    def _dispatch(
            self, identity, package, method, params, path, stop_event, notify,
            *, admitted=False):
        if stop_event.is_set() and not admitted:
            raise InterruptedError("Task execution stopped before admission")
        if not isinstance(params, dict):
            raise ContractError("Capability arguments must be a JSON object")
        request = {"method": method, "params": params, "package_digest": package["digest"]}
        existing = self.store.rpc_find(identity, path, request)
        if existing:
            if existing["status"] == "completed":
                return existing["result"]
            if existing["status"] == "failed":
                raise RuntimeError(existing["error"])
            if method not in {"delegate", "parallel", "develop_skill", "develop_tool",
                              "release_tool", "develop_service", "activate_service",
                              "release_service"}:
                raise RecoveryRequired(f"Unfinished capability {path}; automatic repetition refused")
            node = deepcopy(self.store.get(identity)["nodes"].get(path) or {})
            if not node or node.get("method") != method:
                raise RecoveryRequired(f"Unfinished composite {path} has no resumable projection")
            node.update(status="running", resumed_at=time.time())
            self._change(identity, lambda s: s["nodes"].update({path: deepcopy(node)}))
        else:
            refs = self._references(identity, params)
            self.store.reserve_node(identity, path, {"method": method})
            self.store.rpc_start(identity, path, request)
            node = deepcopy(self.store.get(identity)["nodes"].get(path) or {})
            node.update({"id": path, "method": method, "status": "running", "input_refs": refs,
                         "package_digest": package["digest"], "started_at": time.time(),
                         "request": deepcopy(params)})
            self._change(identity, lambda s: s["nodes"].update({path: deepcopy(node)}))
        notify()
        try:
            result = self._invoke(identity, package, method, params, path, stop_event, notify)
            # Persist even when cancellation arrives after a side effect finishes.
            self.store.rpc_finish(identity, path, result=result)
            node = deepcopy(self.store.get(identity)["nodes"].get(path, node))
            node.update(status="completed", finished_at=time.time(), result=deepcopy(result))
            self._change(identity, lambda s: s["nodes"].update({path: node}))
            return result
        except CapabilityAbort as abort:
            cause = abort.cause
            error = f"{type(cause).__name__}: {str(cause)[:1200]}"
            self.store.rpc_finish(identity, path, error=error)
            node = deepcopy(self.store.get(identity)["nodes"].get(path, node))
            node.update(status="waiting_input" if isinstance(cause, RecoveryRequired)
                        else "paused" if isinstance(cause, InterruptedError) else "failed",
                        finished_at=time.time(), error=error)
            self._change(identity, lambda s: s["nodes"].update({path: node}))
            raise
        except _CompositePending as exc:
            node = deepcopy(self.store.get(identity)["nodes"].get(path, node))
            node.update(status="waiting_input" if isinstance(exc, RecoveryRequired) else "paused",
                        interrupted_at=time.time(), error=str(exc)[:1200])
            self._change(identity, lambda s: s["nodes"].update({path: node}))
            # Leave the composite journal started. Its completed descendants
            # are replayable, and the composite itself can safely be re-entered.
            raise
        except Exception as exc:
            error = f"{type(exc).__name__}: {str(exc)[:1200]}"
            self.store.rpc_finish(identity, path, error=error)
            node = deepcopy(self.store.get(identity)["nodes"].get(path, node))
            node.update(status="failed", finished_at=time.time(), error=error)
            self._change(identity, lambda s: s["nodes"].update({path: node}))
            raise
        finally:
            notify()

    def _ask(self, identity, path, params, stop_event, notify):
        state = self.store.get(identity)
        params = deepcopy(params)
        service_binding = None
        instance = self.store.service_instance(identity)
        if instance is not None and instance["status"] == "active":
            from .capability_authority import require_definition_authorized
            from .service_definitions import (
                MODEL_CONTEXT_INPUT_SCHEMA, MODEL_CONTEXT_OUTPUT_SCHEMA,
            )
            definition = self.store.service_definition(instance["definition_id"])
            authority = state["task"].get("capability_authority")
            if (authority is None or instance["authority_digest"] != authority["digest"]
                    or instance["definition_digest"] != definition["digest"]
                    or definition["origin_episode_id"] != identity):
                raise PermissionError("Active service provider identity or authority changed")
            require_definition_authorized(
                authority, definition["kind"], definition["effect_class"],
                definition["declared_operations"], definition["credential_handles"])
            service_binding = {
                "definition_id": definition["id"],
                "definition_digest": definition["digest"],
                "instance_revision": instance["revision"],
                "authority_digest": authority["digest"],
            }
            request = {"schema": "nexgent.model-context-request.v1",
                       "role": params["role"], "node_id": path,
                       "payload": params.get("payload")}
            validate(request, MODEL_CONTEXT_INPUT_SCHEMA,
                     label="model-context service input", allow_artifact_refs=False)
            self.store.reserve_service_application(identity, path, service_binding)
            started = time.monotonic()
            try:
                instruction_limit = 200_000
                execution = run_package(
                    self.store.package(definition["package_id"]), "execute", request,
                    handle=None, stop_event=stop_event, timeout=120, max_rpc=0,
                    max_instructions=instruction_limit)
                output = execution["value"]
                validate(output, MODEL_CONTEXT_OUTPUT_SCHEMA,
                         label="model-context service output", allow_artifact_refs=False)
                transformed = _json_copy(output["payload"], label="Model-context payload")
                original = request["payload"]
                if type(original) is dict:
                    if type(transformed) is not dict or any(
                            key not in transformed or transformed[key] != value
                            for key, value in original.items()):
                        raise ContractError(
                            "Model-context service must preserve existing payload fields")
                if len(json.dumps(output, ensure_ascii=False, allow_nan=False)) > 240000:
                    raise ContractError("Model-context service output exceeds model input limit")
                self.store.event(identity, "service_applied", {
                    "node_id": path, "binding": service_binding,
                    "package_id": definition["package_id"],
                    "package_digest": definition["package_digest"],
                    "entry_digest": definition["entry_digest"],
                    "input_digest": digest(request),
                    "output_digest": digest(output),
                    "annotations": output["annotations"],
                    "worker_instruction_limit": instruction_limit,
                    "worker_execution": execution["execution"],
                    "elapsed_seconds": time.monotonic() - started,
                })
                params["payload"] = transformed
            except BaseException as exc:
                self.store.event(identity, "service_application_failed", {
                    "node_id": path, "binding": service_binding,
                    "error": f"{type(exc).__name__}: {str(exc)[:1000]}",
                })
                raise
        def reserve(receipt):
            receipt.update(episode_id=identity, node_id=path, package_digest=state["package_digest"])
            if service_binding is not None:
                receipt["service_provider"] = deepcopy(service_binding)
                receipt["effective_payload_digest"] = digest(params["payload"])
            self.store.reserve_model(state["root_episode_id"], receipt)
            notify()
        gateway = (self.gateway_factory(reserve, stop_event) if self.gateway_factory else
                   ModelGateway(self.project_root, reserve=reserve, stop_event=stop_event, max_completion_tokens=6000))
        try:
            return gateway.ask(**params)
        except CapabilityAbort:
            raise
        except Exception as exc:
            # A provider/configuration failure remains fatal even when the call
            # originated inside a skill or workflow action. Asking the model to
            # repair its own unavailable provider would hide the real failure.
            raise CapabilityAbort(exc) from exc

    def _invoke_dynamic_tool(self, identity, name, arguments, path, stop_event):
        from .tools import validate_tool_input
        instance = self.store.tool_instance(identity, name)
        if instance is None or instance["status"] != "active":
            raise PermissionError(f"Task-authored tool is not active: {name}")
        definition = self.store.tool_definition(instance["definition_id"])
        state = self.store.get(identity)
        authority = state["task"].get("capability_authority")
        if (authority is None or instance["authority_digest"] != authority["digest"]
                or instance["definition_digest"] != definition["digest"]
                or definition["name"] != name):
            raise PermissionError("Task-authored tool identity or authority changed")
        from .capability_authority import require_definition_authorized
        require_definition_authorized(
            authority, definition["kind"], definition["effect_class"],
            definition["declared_operations"], definition["credential_handles"])
        validate_tool_input(arguments, definition["input_schema"],
                            artifact_resolver=lambda ref: self.store.read(ref, identity),
                            label=name + " input")
        binding = {
            "name": name, "definition_id": definition["id"],
            "definition_digest": definition["digest"],
            "instance_revision": instance["revision"],
            "authority_digest": authority["digest"],
        }
        self.store.reserve_tool(identity, path,
                                {"name": name, "arguments": deepcopy(arguments),
                                 "dynamic_capability": binding}, reserved_work_units=0)
        receipt = {
            "call_id": identity + "/" + path, "episode_id": identity,
            "name": name, "arguments": deepcopy(arguments),
            "dynamic_capability": binding, "package_id": definition["package_id"],
            "package_digest": definition["package_digest"],
            "entry_digest": definition["entry_digest"],
            "status": "started", "started_at": time.time(),
        }
        started = time.monotonic()
        result, failure = None, None
        try:
            instruction_limit = 200_000
            execution = run_package(
                self.store.package(definition["package_id"]), "execute", arguments,
                handle=None, stop_event=stop_event, timeout=120, max_rpc=0,
                max_instructions=instruction_limit)
            result = execution["value"]
            validate(result, definition["output_schema"], label=name + " output",
                     allow_artifact_refs=False)
            receipt.update(status="completed", result=deepcopy(result),
                           execution=execution["execution"],
                           worker_instruction_limit=instruction_limit,
                           worker_instructions=execution["execution"]["instructions"])
        except BaseException as exc:
            failure = exc
            receipt.update(status="failed", error=f"{type(exc).__name__}: {str(exc)[:1000]}")
        finally:
            accounting = self.store.settle_tool(
                identity, path, status="completed" if failure is None else "failed")
            receipt["work_accounting"] = accounting
            receipt.update(finished_at=time.time(), elapsed_seconds=time.monotonic() - started)
            self.store.event(identity, "tool", receipt)
        if failure is not None:
            raise failure
        return result

    def _invoke(self, identity, package, method, params, path, stop_event, notify):
        if method == "ask":
            return self._ask(identity, path, params, stop_event, notify)
        if method == "capability_inventory":
            if params:
                raise ContractError("Capability inventory accepts no arguments")
            state = self.store.get(identity)
            if state["task"].get("capability_mode") == "leased":
                leases = self.store.capability_leases(identity, active_only=True)
                for lease in leases:
                    self.tools.resolve_lease(lease)
                installed = self.tools.describe([item["name"] for item in leases])
            else:
                installed = self.tools.describe(state["capabilities"])
            result = {"tools": installed + self._dynamic_inventory(identity)}
            services = self._service_inventory(identity)
            if services is not None:
                result["services"] = services
            return result
        if method == "develop_service":
            if getattr(self._parallel_context, "active", False):
                raise PermissionError("Service development requires a serial Episode point")
            if set(params) != {"proposal"}:
                raise ContractError("Service development requires one proposal")
            from .service_definitions import build_service_definition
            definition, bundle = build_service_definition(params["proposal"], identity)
            self.store.stage_service_definition(identity, definition, bundle)
            return {"definition_id": definition["id"],
                    "definition_digest": definition["digest"],
                    "name": definition["name"],
                    "service_interface": definition["service_interface"]}
        if method == "activate_service":
            if getattr(self._parallel_context, "active", False):
                raise PermissionError("Service activation requires a serial Episode point")
            if (set(params) != {"definition_id", "expected_revision"}
                    or not isinstance(params["definition_id"], str)
                    or type(params["expected_revision"]) is not int):
                raise ContractError("Service activation requires definition and exact revision")
            instance = self.store.activate_service_provider(
                identity, params["definition_id"],
                expected_revision=params["expected_revision"])
            return {"definition_id": instance["definition_id"],
                    "instance_revision": instance["revision"],
                    "status": instance["status"]}
        if method == "release_service":
            if getattr(self._parallel_context, "active", False):
                raise PermissionError("Service release requires a serial Episode point")
            if set(params) != {"expected_revision"} or type(params["expected_revision"]) is not int:
                raise ContractError("Service release requires an exact revision")
            instance = self.store.release_service_provider(
                identity, expected_revision=params["expected_revision"])
            return {"definition_id": instance["definition_id"],
                    "instance_revision": instance["revision"],
                    "status": instance["status"]}
        if method == "develop_tool":
            if getattr(self._parallel_context, "active", False):
                raise PermissionError("Tool development requires a serial Episode point")
            if set(params) != {"proposal"}:
                raise ContractError("Tool development requires one proposal")
            state = self.store.get(identity)
            if state["task"].get("capability_authority") is None:
                raise PermissionError("Episode has no tool-development authority")
            from .capability_definitions import build_tool_definition
            definition, bundle = build_tool_definition(params["proposal"], identity)
            self.store.stage_tool_definition(identity, definition, bundle)
            instance = self.store.mount_tool_definition(identity, definition["id"])
            return {"definition_id": definition["id"],
                    "definition_digest": definition["digest"],
                    "name": definition["name"], "instance_revision": instance["revision"],
                    "authority_digest": instance["authority_digest"]}
        if method == "release_tool":
            if getattr(self._parallel_context, "active", False):
                raise PermissionError("Tool release requires a serial Episode point")
            if (set(params) != {"name", "expected_revision"}
                    or not isinstance(params["name"], str)
                    or type(params["expected_revision"]) is not int):
                raise ContractError("Tool release requires name and exact revision")
            instance = self.store.release_tool_instance(
                identity, params["name"], expected_revision=params["expected_revision"])
            return {"name": params["name"], "instance_revision": instance["revision"],
                    "status": instance["status"],
                    "definition_id": instance["definition_id"]}
        if method == "read_artifact":
            artifact = self.store.read(params["artifact_id"], identity)
            self.store.event(identity, "artifact_read", {"node_id": path, "artifact_id": artifact["id"]})
            return artifact
        if method == "publish":
            return self._publish(identity, path, params["content"], params.get("name"),
                                 params.get("schema", "application/json"), params.get("input_refs"))
        if method == "tool":
            name, arguments = params["name"], params.get("arguments") or {}
            state = self.store.get(identity)
            dynamic = self.store.tool_instance(identity, name)
            if dynamic is not None:
                return self._invoke_dynamic_tool(identity, name, arguments, path, stop_event)
            if name not in state["capabilities"]:
                raise PermissionError(f"Task has not granted capability: {name}")
            lease = None
            if state["task"].get("capability_mode") == "leased":
                lease = self.store.capability_lease(identity, name)
                if lease is None or lease.get("status") != "active":
                    raise PermissionError(f"Task capability lease is not active: {name}")
                tool = self.tools.resolve_lease(lease)
            else:
                tool = self.tools.get(name)
            constraints = state["task"].get("constraints", {})
            if ("allowed_effects" in constraints
                    and tool.effect_class not in constraints["allowed_effects"]):
                raise PermissionError(
                    f"Tool effect {tool.effect_class!r} is not allowed by this task")
            from .tools import validate_tool_input
            validate_tool_input(
                arguments, tool.input_schema,
                artifact_resolver=lambda ref: self.store.read(ref, identity),
                label=name + " input")
            admission = {"name": name, "arguments": arguments}
            if lease is not None:
                admission.update(
                    capability_lease_revision=lease["revision"],
                    capability_descriptor_digest=lease["descriptor"]["digest"],
                    handler_digest=lease["descriptor"]["handler_digest"],
                )
            self.store.reserve_tool(
                identity, path, admission,
                reserved_work_units=tool.work_units_per_call)
            receipt = {"call_id": identity + "/" + path, "episode_id": identity, "name": name,
                       "arguments": deepcopy(arguments), "status": "started", "started_at": time.time(),
                       "work_reservation": {"schema": "nexgent.tool-work.v1",
                                            "reserved_work_units": tool.work_units_per_call}}
            if lease is not None:
                receipt.update(capability_descriptor=deepcopy(lease["descriptor"]),
                               capability_lease_revision=lease["revision"])
            started = time.monotonic()
            result, failure = None, None
            try:
                result = tool.handler(arguments, ToolContext(self, identity, path, stop_event))
                validate(result, tool.output_schema, label=name + " output",
                         allow_artifact_refs=False)
                receipt.update(status="completed", result=deepcopy(result))
            except BaseException as exc:
                failure = exc
                receipt.update(status="failed", error=f"{type(exc).__name__}: {str(exc)[:1000]}")
            finally:
                accounting = self.store.settle_tool(
                    identity, path, status="completed" if failure is None else "failed")
                receipt["work_accounting"] = accounting
                receipt.update(finished_at=time.time(), elapsed_seconds=time.monotonic() - started)
                self.store.event(identity, "tool", receipt)
            if failure is not None:
                raise failure
            return result
        if method == "parallel":
            requests = params["requests"]
            if not isinstance(requests, list) or not 1 <= len(requests) <= 4:
                raise ContractError("A parallel batch requires one to four requests")
            def call(index, request):
                self._parallel_context.active = True
                try:
                    result = self._dispatch(identity, package, request["method"], request.get("params", {}),
                                            f"{path}.{index}", stop_event, notify)
                    return {"ok": True, "value": result}, None
                except RecoveryRequired as exc:
                    return None, exc
                except Exception as exc:
                    return {"ok": False, "error": f"{type(exc).__name__}: {str(exc)[:1000]}"}, exc
                finally:
                    self._parallel_context.active = False
            # Always join every admitted branch before returning partial failures.
            with ThreadPoolExecutor(max_workers=len(requests)) as pool:
                futures = [pool.submit(call, index, request) for index, request in enumerate(requests)]
                joined = [future.result() for future in futures]
            recoveries = [exc for _, exc in joined if isinstance(exc, RecoveryRequired)]
            if recoveries:
                raise _CompositeRecovery(str(recoveries[0]))
            if stop_event.is_set():
                raise _CompositePaused("Parallel batch was interrupted after its admitted branches settled")
            return [result for result, _ in joined]
        if method == "skill":
            name = params["name"]
            skill = package["manifest"].get("skills", {}).get(name)
            if not isinstance(skill, dict):
                raise ContractError(f"Skill is not registered: {name}")
            payload = params.get("payload") or {}
            validate(payload, skill.get("input_schema", {}), label=name + " input")
            kind = skill.get("kind")
            if kind == "prompt_protocol":
                prompt = package["files"][skill["ref"]]
                result = self._ask(identity, path, {"role": name, "prompt": prompt, "payload": payload,
                    "max_tokens": skill.get("max_tokens", 3000)}, stop_event, notify)
            elif kind == "workflow":
                from .workflows import run_workflow
                workflow = json.loads(package["files"][skill["ref"]])
                result = run_workflow(workflow, payload,
                    lambda m, p, child_path: self._dispatch(identity, package, m, p, path + "/" + child_path, stop_event, notify),
                    stop_event=stop_event)
            elif kind == "controlled_code":
                counter = [0]
                allowed_methods = skill.get("allowed_rpc_methods")
                allowed_tools = skill.get("allowed_tools")
                def handle(m, p):
                    if allowed_methods is not None and m not in allowed_methods:
                        raise PermissionError(
                            f"Skill {name!r} is not allowed to call RPC method {m!r}")
                    if (m == "tool" and allowed_tools is not None
                            and p.get("name") not in allowed_tools):
                        raise PermissionError(
                            f"Skill {name!r} is not allowed to call tool {p.get('name')!r}")
                    counter[0] += 1
                    return self._dispatch(identity, package, m, p, f"{path}/skill.{counter[0]}", stop_event, notify)
                execution = run_package(package, "skill:" + name, payload, handle, stop_event=stop_event, timeout=300)
                result = execution["value"]
                self.store.event(identity, "skill_execution", execution["execution"])
            else:
                raise ContractError("Unsupported skill implementation kind")
            validate(result, skill.get("output_schema", {}), label=name + " output")
            return result
        if method == "develop_skill":
            from .task_skill_compiler import (
                compile_task_skill_planner_proposal,
                compile_task_skill_proposal,
            )
            from .task_skill_repair import (
                MAX_TASK_SKILL_COMPILE_ATTEMPTS,
                TASK_SKILL_REPAIR_PROMPT,
                compile_with_task_skill_repair,
            )

            state = self.store.get(identity)
            constraints = params.get("constraints")
            if not isinstance(constraints, dict):
                raise ContractError("develop_skill requires explicit task skill constraints")
            requested_tools = constraints.get("allowed_tools")
            requested_methods = constraints.get("allowed_rpc_methods")
            if (not isinstance(requested_tools, list)
                    or any(not isinstance(name, str) for name in requested_tools)
                    or not set(requested_tools) <= set(state["capabilities"])):
                raise PermissionError("Task-authored skill tools exceed the Episode lease")
            host_methods = CAPABILITIES - {
                "parallel", "skill", "delegate", "develop_skill"}
            policy_methods = state["task"].get("constraints", {}).get(
                "allowed_skill_rpc_methods", sorted(host_methods))
            if (not isinstance(policy_methods, list)
                    or any(not isinstance(name, str) for name in policy_methods)
                    or not set(policy_methods) <= host_methods
                    or not isinstance(requested_methods, list)
                    or any(not isinstance(name, str) for name in requested_methods)
                    or not set(requested_methods) <= set(policy_methods)):
                raise PermissionError("Task-authored skill RPC methods exceed the host policy")
            proposal = deepcopy(params.get("proposal"))
            mode = params.get("mode", "direct")
            if mode not in {"direct", "planner_preserving"}:
                raise ContractError("develop_skill mode is unsupported")
            compiler = (compile_task_skill_planner_proposal
                        if mode == "planner_preserving"
                        else compile_task_skill_proposal)
            repair = params.get("repair")
            if repair is None:
                max_attempts = 1
                repair_role = None
                repair_tokens = None
            else:
                if (not isinstance(repair, dict)
                        or set(repair) != {"role", "max_attempts", "max_tokens"}
                        or not isinstance(repair.get("role"), str)
                        or type(repair.get("max_attempts")) is not int
                        or not 2 <= repair["max_attempts"] <= MAX_TASK_SKILL_COMPILE_ATTEMPTS
                        or type(repair.get("max_tokens")) is not int
                        or not 1 <= repair["max_tokens"] <= 6000):
                    raise ContractError("develop_skill repair configuration is invalid")
                repair_role = package["manifest"].get("roles", {}).get(repair["role"])
                if (not isinstance(repair_role, dict)
                        or "ask" not in repair_role.get("capabilities", [])):
                    raise PermissionError(
                        "develop_skill repair role is not an ask-capable package role")
                repair_role = repair["role"]
                max_attempts = repair["max_attempts"]
                repair_tokens = repair["max_tokens"]

            def compile_proposal(candidate):
                bound = deepcopy(candidate)
                if isinstance(bound, dict):
                    bound.setdefault("parent_package_digest", package["digest"])
                return compiler(
                    package, bound, constraints,
                    provenance={"episode_id": identity, "node_id": path},
                )

            def repair_proposal(request, repair_path):
                return self._dispatch(
                    identity, package, "ask", {
                        "role": repair_role,
                        "prompt": TASK_SKILL_REPAIR_PROMPT,
                        "payload": request,
                        "max_tokens": repair_tokens,
                    }, f"{path}/repair/{repair_path}", stop_event, notify)

            task_spec = deepcopy(state["task"])
            task_spec.pop("inputs", None)
            task_spec.update(
                episode_id=identity,
                input_refs=deepcopy(state["input_refs"]),
                memory_snapshot=self.store.memory_snapshot(
                    state["memory_snapshot_id"], identity),
                skills=deepcopy(package["manifest"].get("skills", {})),
                available_skills=_available_skill_inventory(package),
            )
            compiled = compile_with_task_skill_repair(
                task_spec=task_spec,
                initial_proposal=proposal,
                compile_callback=compile_proposal,
                repair_callback=repair_proposal,
                max_attempts=max_attempts,
                repair_path="compiler",
            )
            child = compiled.child
            accepted = deepcopy(compiled.accepted_proposal)
            accepted.setdefault("parent_package_digest", package["digest"])
            self.store.lease_task_package(child, identity)
            skill_name = accepted["skill"]["name"]
            self.store.event(identity, "task_skill_compiled", {
                "node_id": path,
                "package_id": child["id"],
                "package_digest": child["digest"],
                "skill_name": skill_name,
                "mode": mode,
                "proposal_digest": digest(accepted),
                "compile_attempts": compiled.attempt_count,
                "compiler_diagnostics": [
                    item.as_dict() for item in compiled.diagnostics],
            })
            return {"package_id": child["id"],
                    "package_digest": child["digest"],
                    "skill_name": skill_name,
                    "mode": mode}
        if method == "delegate":
            state = self.store.get(identity)
            depth, cursor = 0, state
            while cursor["parent_episode_id"]:
                depth += 1
                cursor = self.store.get(cursor["parent_episode_id"])
            if depth >= 2:
                raise ContractError("Delegation depth exceeds the host limit of two")
            projected = state["nodes"].get(path, {})
            child_id = projected.get("child_episode_id")
            if child_id:
                child = self.store.get(child_id)
                if child["parent_episode_id"] != identity:
                    raise RecoveryRequired("Recorded delegated child does not belong to its parent")
            else:
                task = deepcopy(params["task"])
                target = package if params.get("package_id") is None else self.store.package(params["package_id"])
                # Sharing an artifact does not transfer authority: all refs are checked
                # before their content is copied into the narrowed child TaskSpec.
                inputs = deepcopy(task.get("inputs", {}))
                for name, ref in task.get("input_refs", {}).items():
                    inputs[name] = self.store.read(ref, identity)["content"]
                parent_capabilities = state["capabilities"]
                if state["task"].get("capability_mode") == "leased":
                    parent_capabilities = [lease["name"] for lease in
                                           self.store.capability_leases(identity, active_only=True)]
                child = self.create(task["objective"], inputs, task.get("deliverables"),
                    capabilities=task.get("capabilities", parent_capabilities), package=target,
                    context=_delegated_public_context(state["task"].get("context")),
                    constraints=state["task"].get("constraints"),
                    parent_episode_id=identity,
                    capability_authority=task.get(
                        "capability_authority",
                        state["task"].get("capability_authority")))
                child_id = child["id"]

                def link_child(parent):
                    current = deepcopy(parent["nodes"][path])
                    if current.get("child_episode_id") not in {None, child_id}:
                        raise RecoveryRequired("Delegation journal points at conflicting children")
                    current["child_episode_id"] = child_id
                    parent["nodes"][path] = current
                    if child_id not in parent["child_episode_ids"]:
                        parent["child_episode_ids"].append(child_id)

                self._change(identity, link_child)
            child_result = self.run(child_id, lambda _: notify(), stop_event)
            if child_result["status"] == "waiting_input":
                raise _CompositeRecovery(
                    f"Delegated child {child_id} requires recovery: {child_result.get('last_error') or 'unknown outcome'}")
            if child_result["status"] in {"ready", "running", "paused"}:
                raise _CompositePaused(f"Delegated child {child_id} is {child_result['status']}")
            return {"episode_id": child_id, "status": child_result["status"], "output_refs": child_result["output_refs"],
                    "outcome": child_result["outcome"], "error": child_result.get("last_error")}
        if method == "memory_search":
            state = self.store.get(identity)
            # An episode reads its frozen initial memory snapshot. Later writes
            # become available to a subsequent episode, not retroactively here.
            snapshot = self.store.memory_snapshot(state["memory_snapshot_id"], identity)
            query = params.get("query", "")
            requested_limit = params.get("limit", 5)
            if (not isinstance(query, str) or type(requested_limit) is not int
                    or not 0 <= requested_limit <= 100):
                raise ContractError(
                    "Memory search requires text and a limit between 0 and 100")
            words = query.lower().split()
            items = snapshot.get("items", [])
            selected = [item for item in items if not words or any(w in json.dumps(item, ensure_ascii=False).lower() for w in words)]
            policy_limit = snapshot.get("memory_policy", {}).get(
                "retrieval", {}).get("max_results", 100)
            effective_limit = min(requested_limit, policy_limit)
            self.store.event(identity, "memory_consumed", {"node_id": path, "snapshot_id": snapshot["id"],
                "query": query, "item_ids": [item["id"] for item in selected[:effective_limit]]})
            return selected[:effective_limit]
        if method == "remember":
            state = self.store.get(identity)
            if state["task"].get("context", {}).get("memory_writeback") is False:
                raise PermissionError("Memory writeback is disabled for this evaluation Episode")
            kind = params.get("kind", "experience")
            snapshot = self.store.memory_snapshot(state["memory_snapshot_id"], identity)
            writeback = snapshot.get("memory_policy", {}).get("writeback")
            if writeback is not None and (not writeback.get("enabled")
                    or kind not in writeback.get("allowed_kinds", [])):
                raise PermissionError("Frozen memory policy does not allow this writeback")
            return self.store.remember(identity, params["content"], kind=kind,
                                       evidence_refs=params.get("evidence") or [])
        if method == "plan":
            plan = params["plan"]
            if not isinstance(plan, dict) or len(json.dumps(plan)) > 50000:
                raise ContractError("Plan revision must be a bounded JSON object")
            self.store.event(identity, "plan_committed", {"node_id": path, "plan": plan})
            self._change(identity, lambda s: s.update(plan=deepcopy(plan)))
            return {"recorded": True, "plan_digest": digest(plan)}
        if method == "feedback":
            record = {"subject": path, "source": "agent_review", "validity": "claimed", "content": params["content"]}
            self.store.event(identity, "feedback", record)
            return record
        raise ContractError(f"Unknown task capability: {method}")

    def benchmark(self, benchmark_id, *, split="development", seed=0, budget=None, package=None,
                  package_channel=None, memory_channel=None, expected_memory_registration=None,
                  capability_authority=None, stop_event=None, **options):
        if package is not None and package_channel is not None:
            raise ContractError("Specify either a package or a package channel")
        registry = self._benchmark_registry()
        adapter = registry.get(benchmark_id)
        adapters = registry.adapters()
        snapshot = validate_snapshot(adapter.snapshot())
        reports = []
        for task_ref in validate_tasks(adapter.tasks(split=split, seed=seed, **options)):
            context = deepcopy(task_ref.get("context") or {})
            if not isinstance(context, dict):
                raise ContractError("Benchmark task context must be a JSON object")
            registration = {"benchmark_id": benchmark_id,
                            "task_ref": deepcopy(task_ref),
                            "snapshot": deepcopy(snapshot),
                            "host_runtime": host_runtime_fingerprint()}
            state = self.create(task_ref["objective"], task_ref.get("inputs"), task_ref.get("deliverables"), budget,
                task_ref.get("capabilities"), package, context, constraints=task_ref.get("constraints"),
                package_channel=package_channel, benchmark_registration=registration,
                memory_channel=memory_channel,
                expected_memory_registration=expected_memory_registration,
                capability_authority=capability_authority)
            self.run(state["id"], stop_event=stop_event)
            reports.append(self._evaluate_registered(state["id"], adapters))
            if stop_event is not None and stop_event.is_set():
                break
        return {"benchmark": describe_adapter(adapter), "snapshot": snapshot,
                "reports": reports}

    def _save_evaluation(self, identity, report, snapshot):
        self.store.event(identity, "benchmark_evaluated", {"report": report, "snapshot": snapshot})

        def update(state):
            state["evaluation"] = deepcopy(report)
            if state.get("outcome"):
                accepted = report.get("accepted")
                state["outcome"]["acceptance_status"] = (
                    "passed" if accepted is True else "failed" if accepted is False else "not_evaluated")

        self._change(identity, update)
        return {"episode_id": identity, "evaluation": deepcopy(report), "usage": self.store.usage(identity)}

    def evaluate(self, identity, adapter, task_ref, *, snapshot=None):
        state = self.store.get(identity)
        snapshot = validate_snapshot(adapter.snapshot() if snapshot is None else snapshot)
        task_ref = _json_copy(task_ref, label="Benchmark task")
        registration = self.store.benchmark_registration(identity)
        if registration is not None:
            if (not isinstance(registration, dict)
                    or getattr(adapter, "id", None) != registration.get("benchmark_id")
                    or digest(snapshot) != digest(registration.get("snapshot"))
                    or registration.get("host_runtime") != host_runtime_fingerprint()
                    or digest(task_ref) != digest(registration.get("task_ref"))):
                raise ContractError("Evaluation does not match the frozen benchmark registration")
            # Registered benchmark evidence is single-assignment.  A resumed
            # Episode explicitly clears its stale evaluation before it can be
            # evaluated again, so callers cannot rerun an evaluator until a
            # favorable score appears or overwrite a guard result.
            if isinstance(state.get("evaluation"), dict):
                return {"episode_id": identity, "evaluation": deepcopy(state["evaluation"]),
                        "usage": self.store.usage(identity)}
        if state["status"] != "completed":
            report = classify_benchmark_outcome(state)["evaluation"]
            return self._save_evaluation(identity, report, snapshot)
        descendants = [s for s in self.store.list() if s["root_episode_id"] == state["root_episode_id"]]
        tool_calls = [event["content"] for s in descendants for event in self.store.events(s["id"]) if event["kind"] == "tool"]
        delivered = {name: self.store.read(ref, identity)["content"] for name, ref in state["output_refs"].items()}
        try:
            report = adapter.evaluate(task_ref, delivered,
                {"inputs": state["task"]["inputs"], "tool_calls": tool_calls,
                 "usage": self.store.usage(identity), "episode_id": identity,
                 "status": state["status"]})
            report = validate_report(report)
        except Exception:
            # Evaluator code is host-owned measurement infrastructure.  Its
            # failure is missing evidence, never an observed agent score.  Do
            # not persist exception text because registrations and reports can
            # reach public CLI/export surfaces.
            report = {"status": "evaluator_unavailable", "score_available": False,
                      "accepted": None, "execution_status": state["status"]}
        report = classify_benchmark_outcome(state, report)["evaluation"]
        return self._save_evaluation(identity, report, snapshot)

    def evaluate_registered(self, identity):
        registry = self._benchmark_registry()
        return self._evaluate_registered(identity, registry.adapters())

    def _evaluate_registered(self, identity, adapters):
        state = self.store.get(identity)
        registration = self.store.benchmark_registration(identity)
        if not isinstance(registration, dict):
            raise ContractError("Task has no frozen benchmark registration")
        benchmark_id = registration.get("benchmark_id")
        if benchmark_id not in adapters:
            raise ContractError(f"Registered task benchmark is not installed: {benchmark_id}")
        adapter = adapters[benchmark_id]
        current = validate_snapshot(adapter.snapshot())
        frozen = registration.get("snapshot")
        if not isinstance(current, dict) or not isinstance(frozen, dict) or digest(current) != digest(frozen):
            raise ContractError("Benchmark evaluator snapshot changed from the frozen registration")
        task_ref = registration.get("task_ref")
        if not isinstance(task_ref, dict):
            raise ContractError("Frozen benchmark task reference is invalid")
        return self.evaluate(identity, adapter, deepcopy(task_ref), snapshot=deepcopy(frozen))

    def export(self, identity, destination=None):
        destination = Path(destination) if destination else self.project_root / ".nexgent" / "exports" / (identity + ".json")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(self.get(identity), ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
        return str(destination.resolve())
