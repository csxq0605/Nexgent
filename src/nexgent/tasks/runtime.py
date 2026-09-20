"""Ordinary task execution over immutable packages and capability-scoped episodes."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
from pathlib import Path
import re
import threading
import time

from jsonschema import Draft202012Validator

from ..kernel.programs import digest
from ..kernel.store import BudgetExhausted
from ..models.gateway import ModelGateway
from .package_runner import CapabilityAbort, run_package
from .packages import verify_package
from .store import EpisodeStore, RecoveryRequired, StateConflict
from .tools import ContractError, ToolRegistry, task_benchmarks, validate


_EFFECT_CLASSES = frozenset({"read", "artifact_write", "local_compute", "external_compute"})


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

    def _change(self, identity, update):
        with self._projection_lock:
            state = self.store.get(identity)
            update(state)
            return self.store.save(state)

    def create(self, objective, inputs=None, deliverables=None, budget=None, capabilities=None,
               package=None, context=None, *, constraints=None, entry="execute", parent_episode_id=None,
               package_channel=None):
        if not isinstance(objective, str) or not objective.strip() or len(objective) > 20000:
            raise ContractError("Task objective must be nonempty and at most 20000 characters")
        if package is not None and package_channel is not None:
            raise ContractError("Specify either a package or a package channel")
        package_registration = None
        if package_channel is not None:
            from .evolution import active_package_registration
            package_registration = active_package_registration(self.store, package_channel)
            package = package_registration["package"]
        elif package is None:
            from .seed import default_package
            package = default_package()
        verify_package(package)
        if capabilities is None:
            capabilities = []
        if (not isinstance(capabilities, list) or len(capabilities) > 256
                or any(not isinstance(name, str) or not name or len(name) > 120 for name in capabilities)
                or len(set(capabilities)) != len(capabilities)):
            raise ContractError("Capabilities must be a bounded list of unique nonempty names")
        capabilities = list(capabilities)
        for name in capabilities:
            self.tools.get(name)
        inputs = {} if inputs is None else _json_copy(inputs, label="Task inputs")
        context = {} if context is None else _json_copy(context, label="Task context")
        constraints = {} if constraints is None else _json_copy(constraints, label="Task constraints")
        budget = {} if budget is None else _json_copy(budget, label="Task budget")
        if (not isinstance(inputs, dict) or not isinstance(context, dict)
                or not isinstance(constraints, dict) or not isinstance(budget, dict)):
            raise ContractError("Task inputs, context, constraints and budget must be JSON objects")
        if package_registration is not None:
            if "package_channel_registration" in context:
                raise ContractError("Package channel registration context is host-owned")
            context["package_channel_registration"] = {
                "channel": package_registration["channel"],
                "revision": package_registration["revision"],
                "package_id": package_registration["package_id"],
                "package_digest": package_registration["package_digest"],
            }
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
                "tools": self.tools.describe(capabilities)}
        episode = self.store.create(task, package, parent_episode_id)
        refs = {}
        for name, value in task["inputs"].items():
            artifact = self.store.publish(episode["id"], value, name=name, scope="tree", node_id="input")
            refs[name] = artifact["id"]
        snapshot = self.store.snapshot(episode["id"], query="")
        return self._change(episode["id"], lambda s: s.update(input_refs=refs, memory_snapshot_id=snapshot["id"]))

    def list(self):
        return [self.get(state["id"]) for state in self.store.list() if not state["parent_episode_id"]]

    def get(self, identity):
        state = self.store.get(identity)
        state.update(usage=self.store.usage(state["root_episode_id"]), calls=self.store.calls(state["root_episode_id"]),
                     events=self.store.events(identity), artifacts=self.store.artifacts(identity),
                     children=[s for s in self.store.list() if s["parent_episode_id"] == identity],
                     memory_retrievals=self.store.retrievals(identity))
        return state

    def run(self, identity, on_update=None, stop_event=None):
        stop_event = stop_event if stop_event is not None else threading.Event()
        with self.store.lock(identity):
            state = self.store.get(identity)
            if state["status"] == "completed":
                return self.get(identity)
            if state["status"] == "cancelled":
                raise ContractError("A cancelled task needs a new task identity")
            package = self.store.package(state["package_id"])
            self._change(identity, lambda s: s.update(status="running", last_error=None))
            self.store.event(identity, "episode_started", {"package_digest": package["digest"], "resume": bool(state["nodes"])})

            def notify():
                if on_update:
                    on_update(self.get(identity))

            payload = deepcopy(state["task"])
            payload.pop("inputs", None)
            payload.update(episode_id=identity, input_refs=state["input_refs"],
                           memory_snapshot=self.store.memory_snapshot(state["memory_snapshot_id"], identity),
                           skills=deepcopy(package["manifest"].get("skills", {})))
            counter = [0]
            recovery_errors = []

            def handle(method, params):
                counter[0] += 1
                try:
                    return self._dispatch(identity, package, method, params, f"rpc.{counter[0]}", stop_event, notify)
                except RecoveryRequired as exc:
                    # The subprocess protocol wraps handler exceptions. Keep a
                    # host-side signal so an uncertain admitted call cannot be
                    # misclassified as an ordinary package failure.
                    recovery_errors.append(str(exc))
                    raise CapabilityAbort(exc) from exc
                except InterruptedError as exc:
                    raise CapabilityAbort(exc) from exc
                except (BudgetExhausted, StateConflict) as exc:
                    raise CapabilityAbort(exc) from exc

            notify()
            try:
                execution = run_package(package, state["task"]["entry"], payload, handle,
                                        stop_event=stop_event, timeout=state["task"].get("constraints", {}).get("wall_seconds", 1200),
                                        max_rpc=512, max_instructions=5_000_000)
                self._complete(identity, execution)
            except InterruptedError as exc:
                self._change(identity, lambda s: s.update(status="paused", last_error=str(exc)))
            except RecoveryRequired as exc:
                self._change(identity, lambda s: s.update(status="waiting_input", last_error=str(exc)))
            except Exception as exc:
                if recovery_errors:
                    self._change(identity, lambda s: s.update(status="waiting_input", last_error=recovery_errors[-1]))
                else:
                    self._change(identity, lambda s: s.update(status="paused" if stop_event.is_set() else "failed",
                        last_error=f"{type(exc).__name__}: {str(exc)[:1200]}"))
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
                                                   execution=execution["execution"], evaluation=None))

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

    def _dispatch(self, identity, package, method, params, path, stop_event, notify):
        if stop_event.is_set():
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
            if method not in {"delegate", "parallel"}:
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
            node = {"id": path, "method": method, "status": "running", "input_refs": refs,
                    "package_digest": package["digest"], "started_at": time.time(), "request": deepcopy(params)}
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
        def reserve(receipt):
            receipt.update(episode_id=identity, node_id=path, package_digest=state["package_digest"])
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

    def _invoke(self, identity, package, method, params, path, stop_event, notify):
        if method == "ask":
            return self._ask(identity, path, params, stop_event, notify)
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
            if name not in state["capabilities"]:
                raise PermissionError(f"Task has not granted capability: {name}")
            tool = self.tools.get(name)
            constraints = state["task"].get("constraints", {})
            if ("allowed_effects" in constraints
                    and tool.effect_class not in constraints["allowed_effects"]):
                raise PermissionError(
                    f"Tool effect {tool.effect_class!r} is not allowed by this task")
            validate(arguments, tool.input_schema, label=name + " input")
            self.store.reserve_tool(identity, path, {"name": name, "arguments": arguments})
            receipt = {"call_id": identity + "/" + path, "episode_id": identity, "name": name,
                       "arguments": deepcopy(arguments), "status": "started", "started_at": time.time()}
            started = time.monotonic()
            try:
                result = tool.handler(arguments, ToolContext(self, identity, path, stop_event))
                validate(result, tool.output_schema, label=name + " output")
                receipt.update(status="completed", result=deepcopy(result))
                return result
            except Exception as exc:
                receipt.update(status="failed", error=f"{type(exc).__name__}: {str(exc)[:1000]}")
                raise
            finally:
                receipt.update(finished_at=time.time(), elapsed_seconds=time.monotonic() - started)
                self.store.event(identity, "tool", receipt)
        if method == "parallel":
            requests = params["requests"]
            if not isinstance(requests, list) or not 1 <= len(requests) <= 4:
                raise ContractError("A parallel batch requires one to four requests")
            def call(index, request):
                try:
                    result = self._dispatch(identity, package, request["method"], request.get("params", {}),
                                            f"{path}.{index}", stop_event, notify)
                    return {"ok": True, "value": result}, None
                except RecoveryRequired as exc:
                    return None, exc
                except Exception as exc:
                    return {"ok": False, "error": f"{type(exc).__name__}: {str(exc)[:1000]}"}, exc
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
                def handle(m, p):
                    counter[0] += 1
                    return self._dispatch(identity, package, m, p, f"{path}/skill.{counter[0]}", stop_event, notify)
                execution = run_package(package, "skill:" + name, payload, handle, stop_event=stop_event, timeout=300)
                result = execution["value"]
                self.store.event(identity, "skill_execution", execution["execution"])
            else:
                raise ContractError("Unsupported skill implementation kind")
            validate(result, skill.get("output_schema", {}), label=name + " output")
            return result
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
                child = self.create(task["objective"], inputs, task.get("deliverables"),
                    capabilities=task.get("capabilities", state["capabilities"]), package=target,
                    context=state["task"].get("context"), constraints=state["task"].get("constraints"),
                    parent_episode_id=identity)
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
            words = query.lower().split()
            items = snapshot.get("items", [])
            selected = [item for item in items if not words or any(w in json.dumps(item, ensure_ascii=False).lower() for w in words)]
            self.store.event(identity, "memory_consumed", {"node_id": path, "snapshot_id": snapshot["id"],
                "query": query, "item_ids": [item["id"] for item in selected[:params.get("limit", 5)]]})
            return selected[:params.get("limit", 5)]
        if method == "remember":
            state = self.store.get(identity)
            if state["task"].get("context", {}).get("memory_writeback") is False:
                raise PermissionError("Memory writeback is disabled for this evaluation Episode")
            return self.store.remember(identity, params["content"], kind=params.get("kind", "experience"),
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
                  package_channel=None, stop_event=None, **options):
        if package is not None and package_channel is not None:
            raise ContractError("Specify either a package or a package channel")
        adapters = task_benchmarks()
        if benchmark_id not in adapters:
            raise ContractError(f"Task benchmark is not installed: {benchmark_id}")
        adapter = adapters[benchmark_id]
        snapshot = _json_copy(adapter.snapshot(), label="Benchmark snapshot")
        if not isinstance(snapshot, dict):
            raise ContractError("Benchmark snapshot must be a JSON object")
        reports = []
        for task in adapter.tasks(split=split, seed=seed, **options):
            task_ref = _json_copy(task, label="Benchmark task")
            if not isinstance(task_ref, dict):
                raise ContractError("Benchmark tasks must be JSON objects")
            context = deepcopy(task_ref.get("context") or {})
            if not isinstance(context, dict):
                raise ContractError("Benchmark task context must be a JSON object")
            context["benchmark_registration"] = {"benchmark_id": benchmark_id,
                                                   "task_ref": deepcopy(task_ref),
                                                   "snapshot": deepcopy(snapshot)}
            state = self.create(task_ref["objective"], task_ref.get("inputs"), task_ref.get("deliverables"), budget,
                task_ref.get("capabilities"), package, context, constraints=task_ref.get("constraints"),
                package_channel=package_channel)
            self.run(state["id"], stop_event=stop_event)
            reports.append(self._evaluate_registered(state["id"], adapters))
            if stop_event is not None and stop_event.is_set():
                break
        return {"benchmark": adapter.describe(), "snapshot": snapshot, "reports": reports}

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
        snapshot = _json_copy(adapter.snapshot() if snapshot is None else snapshot, label="Benchmark snapshot")
        task_ref = _json_copy(task_ref, label="Benchmark task")
        registration = state["task"].get("context", {}).get("benchmark_registration")
        if registration is not None:
            if (not isinstance(registration, dict)
                    or getattr(adapter, "id", None) != registration.get("benchmark_id")
                    or digest(snapshot) != digest(registration.get("snapshot"))
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
            report = {"status": "unavailable", "score_available": False, "accepted": None,
                      "execution_status": state["status"]}
            return self._save_evaluation(identity, report, snapshot)
        descendants = [s for s in self.store.list() if s["root_episode_id"] == state["root_episode_id"]]
        tool_calls = [event["content"] for s in descendants for event in self.store.events(s["id"]) if event["kind"] == "tool"]
        delivered = {name: self.store.read(ref, identity)["content"] for name, ref in state["output_refs"].items()}
        report = adapter.evaluate(task_ref, delivered,
            {"inputs": state["task"]["inputs"], "tool_calls": tool_calls, "usage": self.store.usage(identity),
             "episode_id": identity, "status": state["status"]})
        report = _json_copy(report, label="Benchmark evaluation")
        if not isinstance(report, dict):
            raise ContractError("Benchmark evaluation must be a JSON object")
        report.setdefault("execution_status", state["status"])
        return self._save_evaluation(identity, report, snapshot)

    def evaluate_registered(self, identity):
        return self._evaluate_registered(identity, task_benchmarks())

    def _evaluate_registered(self, identity, adapters):
        state = self.store.get(identity)
        registration = state["task"].get("context", {}).get("benchmark_registration")
        if not isinstance(registration, dict):
            raise ContractError("Task has no frozen benchmark registration")
        benchmark_id = registration.get("benchmark_id")
        if benchmark_id not in adapters:
            raise ContractError(f"Registered task benchmark is not installed: {benchmark_id}")
        adapter = adapters[benchmark_id]
        current = _json_copy(adapter.snapshot(), label="Benchmark snapshot")
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
