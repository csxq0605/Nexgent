"""Executable bounded workflows with separate control and artifact edges.

Every external operation passes through invoke(method, params, path). Parallel
work always settles before return, so host budget and receipts remain complete.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import re
import threading

from ..kernel.programs import canonical
from .packages import CAPABILITIES


class WorkflowError(ValueError):
    pass


class LoopLimitExceeded(WorkflowError):
    pass


def _get(value, path):
    if not isinstance(path, str):
        raise WorkflowError("Binding paths must be text")
    if not path:
        return deepcopy(value)
    for part in path.split("."):
        if isinstance(value, dict) and part in value:
            value = value[part]
        elif isinstance(value, list) and part.isdecimal() and int(part) < len(value):
            value = value[int(part)]
        else:
            raise WorkflowError(f"Binding path is unavailable: {path}")
    return deepcopy(value)


def _node_ref(ref, ids):
    if not isinstance(ref, str):
        raise WorkflowError("Node bindings must be text references")
    node, separator, path = ref.partition(".")
    if node not in ids:
        raise WorkflowError(f"Binding refers to unknown node: {node}")
    # 'output' denotes the node's returned JSON, not a synthetic artifact.
    if path == "output":
        path = ""
    elif path.startswith("output."):
        path = path[7:]
    return node, path


def _references(value, ids):
    refs = set()
    if isinstance(value, dict):
        markers = set(value) & {"$input", "$node", "$first_success"}
        if markers:
            if len(value) != 1:
                raise WorkflowError("A binding must contain exactly one reference marker")
            marker = next(iter(markers))
            content = value[marker]
            if marker == "$input":
                if not isinstance(content, str):
                    raise WorkflowError("Input binding path must be text")
            elif marker == "$node":
                refs.add(_node_ref(content, ids)[0])
            else:
                if not isinstance(content, list) or not content or len(content) > 256:
                    raise WorkflowError("First-success binding needs a bounded nonempty reference list")
                refs.update(_node_ref(ref, ids)[0] for ref in content)
        else:
            for item in value.values():
                refs.update(_references(item, ids))
    elif isinstance(value, list):
        for item in value:
            refs.update(_references(item, ids))
    return refs


def _bind(value, payload, receipts):
    if isinstance(value, dict):
        if "$input" in value:
            return _get(payload, value["$input"])
        if "$node" in value:
            node, path = _node_ref(value["$node"], receipts)
            if receipts[node]["status"] == "skipped":
                raise WorkflowError(f"Binding refers to skipped node: {node}")
            return _get(receipts[node]["value"], path)
        if "$first_success" in value:
            for ref in value["$first_success"]:
                node, path = _node_ref(ref, receipts)
                if receipts[node]["status"] == "completed":
                    try:
                        return _get(receipts[node]["value"], path)
                    except WorkflowError:
                        continue
            raise WorkflowError("First-success binding has no successful available producer")
        return {key: _bind(item, payload, receipts) for key, item in value.items()}
    if isinstance(value, list):
        return [_bind(item, payload, receipts) for item in value]
    return deepcopy(value)


def _set(value, path, content):
    if not isinstance(path, str) or not path or any(not part for part in path.split(".")):
        raise WorkflowError("Artifact input ports must be nonempty dotted paths")
    parts = path.split(".")
    for part in parts[:-1]:
        child = value.setdefault(part, {})
        if not isinstance(child, dict):
            raise WorkflowError(f"Artifact input port conflicts with existing value: {path}")
        value = child
    value[parts[-1]] = content


def _validate(workflow, depth=0):
    if depth > 16 or not isinstance(workflow, dict):
        raise WorkflowError("Workflow nesting exceeds its limit or is not an object")
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list) or not nodes or len(nodes) > 256:
        raise WorkflowError("A workflow needs 1 to 256 nodes")
    by_id = {}
    for node in nodes:
        if not isinstance(node, dict) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,79}", str(node.get("id", ""))):
            raise WorkflowError("Workflow nodes need bounded safe identifiers")
        if node["id"] in by_id:
            raise WorkflowError("Duplicate workflow node identifier")
        if not isinstance(node.get("method"), str) or node["method"] not in CAPABILITIES | {"loop", "join"}:
            raise WorkflowError("Workflow node requests an unregistered capability")
        if not isinstance(node.get("params", {}), dict) or not isinstance(node.get("bindings", {}), dict):
            raise WorkflowError("Node params and bindings must be objects")
        policy = node.get("join_policy", workflow.get("join_policy", "all_success"))
        if not isinstance(policy, str) or policy not in {"all_success", "all_completed", "any_success"}:
            raise WorkflowError("Unknown workflow join policy")
        if node["method"] == "loop":
            bound = node.get("max_iterations")
            until = node.get("until")
            if type(bound) is not int or not 1 <= bound <= 1000:
                raise WorkflowError("Loop nodes need max_iterations in [1,1000]")
            if until is not None and (not isinstance(until, dict) or not isinstance(until.get("path"), str) or "equals" not in until):
                raise WorkflowError("Loop until conditions need path and equals")
            _validate(node.get("body"), depth + 1)
        by_id[node["id"]] = node
    controls = workflow.get("control_edges", [])
    artifacts = workflow.get("artifact_edges", [])
    if not isinstance(controls, list) or not isinstance(artifacts, list) or len(controls) + len(artifacts) > 2048:
        raise WorkflowError("Workflow edge lists exceed their limit")
    incoming_control = {node: [] for node in by_id}
    incoming_artifact = {node: [] for node in by_id}
    dependencies = {node: _references({"params": item.get("params", {}), "bindings": item.get("bindings", {})}, by_id)
                    for node, item in by_id.items()}
    for edge in controls:
        if (not isinstance(edge, dict) or not isinstance(edge.get("from"), str)
                or not isinstance(edge.get("to"), str) or edge["from"] not in by_id or edge["to"] not in by_id):
            raise WorkflowError("Control edge refers to an unknown node")
        condition = edge.get("condition")
        if condition is not None and (not isinstance(condition, dict) or not isinstance(condition.get("path"), str) or "equals" not in condition):
            raise WorkflowError("Control conditions need path and equals")
        incoming_control[edge["to"]].append(edge)
        dependencies[edge["to"]].add(edge["from"])
    for edge in artifacts:
        if (not isinstance(edge, dict) or not isinstance(edge.get("producer_node"), str)
                or not isinstance(edge.get("consumer_node"), str)
                or edge["producer_node"] not in by_id or edge["consumer_node"] not in by_id
                or not isinstance(edge.get("output_port"), str) or not isinstance(edge.get("input_port"), str)):
            raise WorkflowError("Artifact edge needs valid producers, consumers and port paths")
        if not edge["input_port"] or any(not part for part in edge["input_port"].split(".")):
            raise WorkflowError("Artifact input ports must be nonempty dotted paths")
        incoming_artifact[edge["consumer_node"]].append(edge)
        dependencies[edge["consumer_node"]].add(edge["producer_node"])
    outputs = workflow.get("outputs", {})
    if not isinstance(outputs, dict):
        raise WorkflowError("Workflow outputs must be a binding object")
    _references(outputs, by_id)
    remaining = {node: set(deps) for node, deps in dependencies.items()}
    while remaining:
        ready = {node for node, deps in remaining.items() if not deps}
        if not ready:
            raise WorkflowError("Raw workflow cycles are forbidden; use a bounded loop node")
        remaining = {node: deps - ready for node, deps in remaining.items() if node not in ready}
    return by_id, dependencies, incoming_control, incoming_artifact


def _admitted(node, dependencies, controls, receipts, policy):
    active_controls = []
    condition_success = set()
    for edge in controls:
        receipt = receipts[edge["from"]]
        if receipt["status"] == "skipped":
            matched = False
        elif edge.get("condition") is None:
            matched = True
        else:
            condition = edge["condition"]
            actual = receipt["status"] if condition["path"] == "$status" else _get(receipt["value"], condition["path"])
            matched = actual == condition["equals"]
            if matched:
                condition_success.add(edge["from"])
        active_controls.append(matched)
    if controls and (not any(active_controls) if policy == "any_success" else not all(active_controls)):
        return False
    if not dependencies:
        return True
    good = [receipts[dep]["status"] == "completed" or dep in condition_success for dep in dependencies]
    if policy == "any_success":
        return any(good)
    if policy == "all_completed":
        return all(receipts[dep]["status"] != "skipped" for dep in dependencies)
    return all(good)


def _failed(exc):
    message = f"{type(exc).__name__}: {str(exc)[:1200]}"
    return {"status": "failed", "value": {"error": message, "error_type": type(exc).__name__}, "error": message}


def _run(workflow, payload, invoke, stop_event, max_parallel, prefix, limiter):
    nodes, dependencies, controls, artifacts = _validate(workflow)
    if "input_schema" in workflow:
        from .tools import validate
        validate(payload, workflow["input_schema"], label="workflow input")
    receipts = {}
    pending = set(nodes)

    def check_stop():
        if stop_event.is_set():
            raise InterruptedError("Workflow execution stopped")

    def execute(node_id, params):
        check_stop()
        node = nodes[node_id]
        path = f"{prefix}nodes/{node_id}"
        try:
            if node["method"] == "join":
                value = params
            elif node["method"] == "loop":
                state = params.get("payload", payload)
                history = []
                for iteration in range(node["max_iterations"]):
                    check_stop()
                    result = _run(node["body"], state, invoke, stop_event, max_parallel,
                                  f"{path}/iterations/{iteration}/", limiter)
                    history.append(result)
                    state = result["outputs"]
                    if result["status"] != "completed":
                        return {"status": "failed", "value": {"iterations": len(history), "outputs": state, "history": history},
                                "error": "Loop body failed"}
                    condition = node.get("until")
                    if condition is not None and _get(state, condition["path"]) == condition["equals"]:
                        break
                else:
                    if node.get("until") is not None:
                        failed = _failed(LoopLimitExceeded("Loop condition did not pass within max_iterations"))
                        failed["value"].update(iterations=len(history), outputs=state, history=history)
                        return failed
                value = {"iterations": len(history), "outputs": state, "history": history}
            else:
                while not limiter.acquire(timeout=0.05):
                    check_stop()
                try:
                    check_stop()
                    value = invoke(node["method"], params, path)
                finally:
                    limiter.release()
            canonical(value)
            if "output_schema" in node:
                from .tools import validate
                validate(value, node["output_schema"], label=f"node {node_id} output")
            return {"status": "completed", "value": value}
        except InterruptedError:
            raise
        except Exception as exc:
            return _failed(exc)

    with ThreadPoolExecutor(max_workers=max_parallel, thread_name_prefix="nexgent-workflow") as executor:
        while pending:
            check_stop()
            ready = [node for node in nodes if node in pending and dependencies[node].issubset(receipts)]
            if not ready:
                raise WorkflowError("Workflow has no ready node")
            futures = {}
            for node_id in ready:
                check_stop()
                node = nodes[node_id]
                policy = node.get("join_policy", workflow.get("join_policy", "all_success"))
                if not _admitted(node_id, dependencies[node_id], controls[node_id], receipts, policy):
                    receipts[node_id] = {"status": "skipped", "value": None}
                    pending.remove(node_id)
                    continue
                try:
                    params = _bind(node.get("params", {}), payload, receipts)
                    params.update(_bind(node.get("bindings", {}), payload, receipts))
                    for edge in artifacts[node_id]:
                        source = receipts[edge["producer_node"]]
                        if source["status"] == "skipped":
                            raise WorkflowError("Artifact producer was skipped")
                        _set(params, edge["input_port"], _get(source["value"], edge["output_port"]))
                    if "input_schema" in node:
                        from .tools import validate
                        validate(params, node["input_schema"], label=f"node {node_id} input")
                except Exception as exc:
                    receipts[node_id] = _failed(exc)
                    pending.remove(node_id)
                    continue
                futures[node_id] = executor.submit(execute, node_id, params)
            # Every admitted call settles, including failures or cancellation.
            interruption = None
            for node_id, future in futures.items():
                try:
                    receipts[node_id] = future.result()
                except InterruptedError as exc:
                    stop_event.set()
                    interruption = exc
                pending.remove(node_id)
            if interruption is not None:
                raise interruption
            check_stop()
    outgoing = {dep for deps in dependencies.values() for dep in deps}
    terminals = [receipt for node, receipt in receipts.items() if node not in outgoing and receipt["status"] != "skipped"]
    status = "completed" if terminals and all(item["status"] == "completed" for item in terminals) else "failed"
    try:
        outputs = _bind(workflow.get("outputs", {}), payload, receipts)
        if "output_schema" in workflow:
            from .tools import validate
            validate(outputs, workflow["output_schema"], label="workflow output")
        output_error = None
    except Exception as exc:
        status, outputs, output_error = "failed", {}, f"{type(exc).__name__}: {str(exc)[:1200]}"
    result = {"status": status, "outputs": outputs, "nodes": receipts}
    if output_error:
        result["error"] = output_error
    return result


def run_workflow(workflow, payload, invoke, *, stop_event=None, max_parallel=4):
    """Run a workflow; invalid graphs raise and node failures remain receipts.

Input/output paths use dotted dict keys or list indices. '$status' conditions
read the producer receipt status; other conditions read its returned JSON.
First-success outputs select a completed branch with an available value. Loop
state is the previous body's outputs; until conditions read that output object.
All synchronous invoke calls must observe the shared stop_event to cancel
promptly. Already admitted work is joined even for any_success and cancellation.
    """
    if type(max_parallel) is not int or not 1 <= max_parallel <= 32:
        raise ValueError("max_parallel must be in [1,32]")
    if not callable(invoke):
        raise ValueError("Workflow invoke must be callable")
    try:
        if len(canonical({"workflow": workflow, "input": payload}).encode("utf-8")) > 1_500_000:
            raise WorkflowError("Workflow input exceeds its text budget")
    except (TypeError, ValueError, RecursionError) as exc:
        if isinstance(exc, WorkflowError):
            raise
        raise WorkflowError(f"Workflow input must be finite JSON: {exc}") from None
    stop_event = threading.Event() if stop_event is None else stop_event
    return _run(deepcopy(workflow), deepcopy(payload), invoke, stop_event, max_parallel, "",
                threading.BoundedSemaphore(max_parallel))
