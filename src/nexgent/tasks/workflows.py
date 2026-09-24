"""Executable bounded workflows with separate control and artifact edges.

Every external operation passes through invoke(method, params, path). Parallel
work always settles before return, so host budget and receipts remain complete.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import re
import threading

from ..kernel.programs import canonical, digest
from .messages import (
    AgentMessageError, make_agent_message, message_schema_ref,
    validate_message_contract,
)
from .orchestration import (
    ArtifactBinding, ControlBinding, FailureAction, FailureRoute, JoinMode,
    JoinPolicy, LocalLimits, NodeStatus, PlanExecution, PlanNode, PlanRevision,
    PlanSpec, PortSpec,
)
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


def _node_parameters(node_id, nodes, artifacts, payload, receipts):
    """Deterministically materialize one admitted node's effective inputs."""
    node = nodes[node_id]
    params = _bind(node.get("params", {}), payload, receipts)
    params.update(_bind(node.get("bindings", {}), payload, receipts))
    for edge in artifacts[node_id]:
        source = receipts[edge["producer_node"]]
        if source["status"] == "skipped":
            raise WorkflowError("Artifact producer was skipped")
        content = _get(source["value"], edge["output_port"])
        if "message" in edge:
            content = make_agent_message(
                sender_node_id=edge["producer_node"],
                recipient_node_id=node_id,
                contract=edge["message"],
                payload=content,
            )
        _set(params, edge["input_port"], content)
    if "input_schema" in node:
        from .tools import validate
        validate(params, node["input_schema"], label=f"node {node_id} input")
    return params


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
        if "message" in edge:
            try:
                expected_schema = message_schema_ref(
                    validate_message_contract(edge["message"]))
            except AgentMessageError as exc:
                raise WorkflowError(str(exc)) from None
            if ("schema_ref" in edge
                    and edge["schema_ref"] != expected_schema):
                raise WorkflowError(
                    "Message edge schema_ref must match its message contract")
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


def _causal_node_error(nodes, receipts):
    """Prefer a failed operation over fallout from binding a skipped descendant."""
    failures = [
        (node_id, receipts[node_id].get("error"))
        for node_id in nodes
        if node_id in receipts and receipts[node_id]["status"] == "failed"
    ]
    if not failures:
        return None
    node_id, error = next(
        ((node_id, error) for node_id, error in failures
         if not (isinstance(error, str)
                 and "Binding refers to skipped node" in error)),
        failures[0],
    )
    return f"Node {node_id} failed: {str(error or 'unknown failure')[:1200]}"


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
                    params = _node_parameters(
                        node_id, nodes, artifacts, payload, receipts)
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
    causal_error = _causal_node_error(nodes, receipts)
    if output_error:
        result["output_error"] = output_error
    if causal_error or output_error:
        result["error"] = causal_error or output_error
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


def _validate_revision_rules(workflow, nodes):
    """Validate the bounded trigger and source contract for plan revisions."""
    rules = workflow.get("revision_rules", [])
    if not isinstance(rules, list) or len(rules) > 16:
        raise WorkflowError("Workflow revision_rules must be a bounded list")
    rule_ids = set()
    for rule in rules:
        workflow_ref = rule.get("workflow_ref") if isinstance(rule, dict) else None
        proposal_path = rule.get("proposal_path") if isinstance(rule, dict) else None
        planner_role_ref = (
            rule.get("planner_role_ref") if isinstance(rule, dict) else None
        )
        planner_max_tokens = (
            rule.get("planner_max_tokens", 4000) if isinstance(rule, dict) else None
        )
        sources = sum(
            source is not None
            for source in (workflow_ref, proposal_path, planner_role_ref)
        )
        replacement_scope = (rule.get("replace_node_ids")
                             if isinstance(rule, dict) else None)
        if proposal_path is not None or planner_role_ref is not None:
            invalid_scope = (
                "replace_node_ids" in rule
                and (not isinstance(replacement_scope, list)
                     or not replacement_scope
                     or any(node_id not in nodes for node_id in replacement_scope))
            )
            compile_attempts = rule.get("max_compile_attempts", 1)
            invalid_compile_attempts = (
                type(compile_attempts) is not int
                or not 1 <= compile_attempts <= 4
            )
        else:
            invalid_scope = (
                not isinstance(replacement_scope, list)
                or not replacement_scope
                or any(node_id not in nodes for node_id in replacement_scope)
            )
            invalid_compile_attempts = (
                isinstance(rule, dict) and "max_compile_attempts" in rule
            )
        if (not isinstance(rule, dict)
                or not re.fullmatch(r"[a-z][a-z0-9_.-]{0,99}", str(rule.get("id", "")))
                or rule["id"] in rule_ids
                or rule.get("after_node") not in nodes
                or sources != 1
                or (workflow_ref is not None
                    and (not isinstance(workflow_ref, str) or not workflow_ref))
                or (proposal_path is not None
                    and (not isinstance(proposal_path, str)
                         or not proposal_path
                         or any(not part for part in proposal_path.split("."))))
                or (planner_role_ref is not None
                    and (not isinstance(planner_role_ref, str)
                         or not planner_role_ref.strip()
                         or len(planner_role_ref) > 200))
                or (isinstance(rule, dict)
                    and "planner_max_tokens" in rule
                    and (planner_role_ref is None
                         or type(planner_max_tokens) is not int
                         or not 1 <= planner_max_tokens <= 6000))
                or invalid_scope
                or invalid_compile_attempts):
            raise WorkflowError("Workflow revision rule is invalid")
        when = rule.get("when")
        if (not isinstance(when, dict) or not isinstance(when.get("path"), str)
                or "equals" not in when):
            raise WorkflowError("Workflow revision condition needs path and equals")
        rule_ids.add(rule["id"])
    return rules


def _validate_strategy_checkpoint_rules(workflow, nodes, dependencies):
    """Validate bounded, unambiguous cuts for cross-strategy handoff."""
    rules = workflow.get("strategy_checkpoint_rules", [])
    if not isinstance(rules, list) or len(rules) > 4:
        raise WorkflowError(
            "Workflow strategy_checkpoint_rules must be a bounded list")

    revision_rules = workflow.get("revision_rules", [])
    revision_ids = {
        rule.get("id") for rule in revision_rules if isinstance(rule, dict)
    }
    revision_nodes = {
        rule.get("after_node") for rule in revision_rules if isinstance(rule, dict)
    }

    # A trigger is a safe graph cut only when every path into work below it
    # passes through the trigger.  This also ensures none of that work can be
    # admitted in the same frontier as the trigger itself.
    all_nodes = set(nodes)
    dominators = {}
    unresolved = set(nodes)
    while unresolved:
        progressed = False
        for node_id in list(unresolved):
            parents = dependencies[node_id]
            if any(parent not in dominators for parent in parents):
                continue
            dominators[node_id] = ({node_id} if not parents else
                                   {node_id} | set.intersection(
                                       *(dominators[parent] for parent in parents)))
            unresolved.remove(node_id)
            progressed = True
        if not progressed:  # _validate has already rejected dependency cycles.
            raise WorkflowError("Workflow checkpoint dominance is unavailable")

    children = {node_id: set() for node_id in nodes}
    for child, parents in dependencies.items():
        for parent in parents:
            children[parent].add(child)

    rule_ids = set()
    for rule in rules:
        if not isinstance(rule, dict):
            raise WorkflowError("Workflow strategy checkpoint rule is invalid")
        rule_id = rule.get("id")
        after_node = rule.get("after_node")
        feedback_path = rule.get("feedback_path")
        path_parts = (feedback_path.split(".")
                      if isinstance(feedback_path, str) else ())
        if (set(rule) != {"id", "after_node", "feedback_path"}
                or not isinstance(rule_id, str)
                or not re.fullmatch(r"[a-z][a-z0-9_.-]{0,99}", rule_id)
                or rule_id in rule_ids
                or rule_id in revision_ids
                or not isinstance(after_node, str)
                or after_node not in all_nodes
                or after_node in revision_nodes
                or not isinstance(feedback_path, str)
                or not feedback_path
                or len(feedback_path) > 500
                or len(path_parts) > 32
                or any(not part or len(part) > 100 for part in path_parts)):
            raise WorkflowError("Workflow strategy checkpoint rule is invalid")

        descendants = set()
        frontier = list(children[after_node])
        while frontier:
            descendant = frontier.pop()
            if descendant in descendants:
                continue
            descendants.add(descendant)
            frontier.extend(children[descendant])
        if any(after_node not in dominators[node_id]
               for node_id in descendants):
            raise WorkflowError(
                "Workflow strategy checkpoint trigger must dominate its descendants")
        rule_ids.add(rule_id)
    return rules


def plan_from_workflow(workflow, plan_id, *, revision=1):
    """Compile a validated workflow resource into the v1 executable-plan contract."""
    try:
        nodes, dependencies, controls, artifacts = _validate(workflow)
        input_ports = {node_id: {} for node_id in nodes}
        output_ports = {node_id: {} for node_id in nodes}
        artifact_bindings = []
        for consumer, edges in artifacts.items():
            for edge in edges:
                schema_ref = (message_schema_ref(edge["message"])
                              if "message" in edge
                              else edge.get("schema_ref", "schema://json"))
                producer = edge["producer_node"]
                output = edge["output_port"]
                input_ = edge["input_port"]
                if (output in output_ports[producer]
                        and output_ports[producer][output] != schema_ref):
                    raise WorkflowError("One workflow output port has conflicting schemas")
                if input_ in input_ports[consumer] and input_ports[consumer][input_] != schema_ref:
                    raise WorkflowError("One workflow input port has conflicting schemas")
                output_ports[producer][output] = schema_ref
                input_ports[consumer][input_] = schema_ref
                artifact_bindings.append(ArtifactBinding(
                    producer_node_id=producer,
                    output_port=output,
                    consumer_node_id=consumer,
                    input_port=input_,
                    schema_ref=schema_ref,
                ))

        plan_nodes = []
        for node_id, node in nodes.items():
            limits = deepcopy(node.get("local_limits", {}))
            if not isinstance(limits, dict):
                raise WorkflowError("Node local_limits must be an object")
            if "max_iterations" in node:
                limits["max_iterations"] = node["max_iterations"]
            plan_nodes.append(PlanNode(
                id=node_id,
                operator_ref=(
                    "operator://" + node["method"] + "/" + digest(node)
                ),
                role_ref=node.get("role_ref"),
                component_ref=node.get("component_ref"),
                input_ports=tuple(
                    PortSpec(name=name, schema_ref=schema)
                    for name, schema in sorted(input_ports[node_id].items())
                ),
                output_ports=tuple(
                    PortSpec(name=name, schema_ref=schema)
                    for name, schema in sorted(output_ports[node_id].items())
                ),
                local_limits=LocalLimits(**limits),
            ))

        control_bindings = [ControlBinding(
            source_node_id=edge["from"],
            target_node_id=target,
            condition_ref=(None if edge.get("condition") is None else
                           "condition://" + digest(edge["condition"])),
        ) for target, edges in controls.items() for edge in edges]
        represented = {(binding.source_node_id, binding.target_node_id)
                       for binding in control_bindings}
        represented.update(
            (binding.producer_node_id, binding.consumer_node_id)
            for binding in artifact_bindings)
        for target, sources in dependencies.items():
            for source in sorted(sources):
                if (source, target) not in represented:
                    control_bindings.append(ControlBinding(
                        source_node_id=source,
                        target_node_id=target,
                        condition_ref="binding://implicit",
                    ))
        join_policies = []
        for node_id, node in nodes.items():
            if (dependencies[node_id] or "join_policy" in node
                    or "join_policy" in workflow):
                policy = node.get("join_policy", workflow.get("join_policy", "all_success"))
                join_policies.append(JoinPolicy(
                    node_id=node_id,
                    mode={
                        "all_success": JoinMode.ALL_SUCCESS,
                        "all_completed": JoinMode.ALL_COMPLETED,
                        "any_success": JoinMode.ANY_SUCCESS,
                    }[policy],
                ))

        failure_routes = []
        for route in workflow.get("failure_routes", []):
            if not isinstance(route, dict):
                raise WorkflowError("Failure routes must be objects")
            failure_routes.append(FailureRoute(
                source_node_id=route.get("from"),
                action=FailureAction(route.get("action")),
                target_node_id=route.get("to"),
                failure_kinds=tuple(route.get("failure_kinds", ["*"])),
            ))

        _validate_revision_rules(workflow, nodes)
        _validate_strategy_checkpoint_rules(workflow, nodes, dependencies)

        return PlanSpec(
            id=plan_id,
            revision=revision,
            nodes=tuple(plan_nodes),
            control_bindings=tuple(control_bindings),
            artifact_bindings=tuple(artifact_bindings),
            join_policies=tuple(join_policies),
            failure_routes=tuple(failure_routes),
        )
    except WorkflowError:
        raise
    except Exception as exc:
        raise WorkflowError(f"Workflow cannot form an executable plan: {str(exc)[:800]}") from None


def _revision_matches(rule, receipt):
    condition = rule["when"]
    actual = (receipt["status"] if condition["path"] == "$status"
              else _get(receipt["value"], condition["path"]))
    return actual == condition["equals"]


def run_executable_workflow(
    workflow,
    payload,
    invoke,
    *,
    execution,
    persist,
    resolve_revision,
    resolve_strategy_checkpoint=None,
    receipt_evidence,
    record_local_receipt,
    initial_receipts=None,
    resumable_local_nodes=(),
    stop_event=None,
    max_parallel=4,
):
    """Execute and durably project a first-class PlanExecution.

    External nodes still enter the ordinary host ``invoke`` path.  The caller
    supplies receipts reconstructed from the RPC journal on resume; package
    output is never accepted as a substitute for that host ledger.

    ``resolve_strategy_checkpoint(rule, execution, receipt, feedback)`` may
    return ``{"action": "continue"}`` or a switch tagged with an opaque,
    finite-JSON ``checkpoint``.  A switch stops before the next frontier and
    leaves all pending node state untouched.
    """
    if not isinstance(execution, PlanExecution):
        raise ValueError("Executable workflow requires PlanExecution")
    if (not callable(invoke) or not callable(persist) or not callable(resolve_revision)
            or not callable(receipt_evidence) or not callable(record_local_receipt)):
        raise ValueError("Executable workflow callbacks must be callable")
    if (resolve_strategy_checkpoint is not None
            and not callable(resolve_strategy_checkpoint)):
        raise ValueError("Strategy checkpoint resolver must be callable")
    if not callable(max_parallel) and (
            type(max_parallel) is not int or not 1 <= max_parallel <= 32):
        raise ValueError("max_parallel must be in [1,32]")
    stop_event = threading.Event() if stop_event is None else stop_event
    active = deepcopy(workflow)
    payload = deepcopy(payload)
    receipts = deepcopy(initial_receipts or {})
    resumable_local_nodes = set(resumable_local_nodes)
    execution_lock = threading.RLock()
    evaluated_checkpoint_rules = set()

    def parallelism():
        value = max_parallel() if callable(max_parallel) else max_parallel
        if type(value) is not int or not 1 <= value <= 32:
            raise ValueError("max_parallel must be in [1,32]")
        return value

    def check_stop():
        if stop_event.is_set():
            raise InterruptedError("Workflow execution stopped")

    def apply_first_matching_revision(node_ids):
        """Apply one durable trigger that has not entered revision history."""
        nonlocal active, execution, receipts
        applied_rule_ids = {revision.id for revision in execution.revisions}
        for node_id in node_ids:
            receipt = receipts.get(node_id)
            if receipt is None:
                continue
            for rule in active.get("revision_rules", []):
                if (rule["id"] in applied_rule_ids
                        or rule["after_node"] != node_id
                        or not _revision_matches(rule, receipt)):
                    continue
                revised_workflow, revision = resolve_revision(
                    rule, execution, deepcopy(receipt))
                if not isinstance(revision, PlanRevision):
                    raise WorkflowError("Revision resolver did not return PlanRevision")
                execution = execution.apply_revision(revision)
                active = deepcopy(revised_workflow)
                current = {state.node_id: state for state in execution.node_executions}
                receipts = {
                    key: value for key, value in receipts.items()
                    if key in current and current[key].status.terminal
                }
                persist(execution, receipts)
                return True
        return False

    def resolve_first_strategy_checkpoint(node_ids):
        """Resolve one durable completed trigger before admitting more work."""
        if resolve_strategy_checkpoint is None:
            return None
        for node_id in node_ids:
            receipt = receipts.get(node_id)
            if receipt is None or receipt.get("status") != "completed":
                continue
            for rule in active.get("strategy_checkpoint_rules", []):
                if (rule["id"] in evaluated_checkpoint_rules
                        or rule["after_node"] != node_id):
                    continue
                feedback = _get(receipt["value"], rule["feedback_path"])
                resolution = resolve_strategy_checkpoint(
                    deepcopy(rule), execution, deepcopy(receipt),
                    deepcopy(feedback),
                )
                try:
                    canonical(resolution)
                except (TypeError, ValueError, RecursionError) as exc:
                    raise WorkflowError(
                        f"Strategy checkpoint resolver returned invalid JSON: {exc}"
                    ) from None
                if not isinstance(resolution, dict):
                    raise WorkflowError(
                        "Strategy checkpoint resolver returned an invalid result")
                action = resolution.get("action")
                if (action == "continue" and set(resolution) == {"action"}):
                    evaluated_checkpoint_rules.add(rule["id"])
                    continue
                if (action == "switch"
                        and set(resolution) == {"action", "checkpoint"}):
                    evaluated_checkpoint_rules.add(rule["id"])
                    return {
                        "rule_id": rule["id"],
                        "after_node": rule["after_node"],
                        "feedback_path": rule["feedback_path"],
                        "checkpoint": deepcopy(resolution["checkpoint"]),
                    }
                raise WorkflowError(
                    "Strategy checkpoint resolver returned an invalid result")
        return None

    def checkpointed_result(checkpoint):
        return {
            "status": "checkpointed",
            "outputs": {},
            "nodes": deepcopy(receipts),
            "plan_execution": execution,
            "strategy_checkpoint": checkpoint,
        }

    def admit(node_id, attempt_ref, input_refs):
        nonlocal execution
        with execution_lock:
            check_stop()
            current = execution.node(node_id)
            if node_id in resumable_local_nodes:
                if (current.status is not NodeStatus.RUNNING
                        or current.attempt_refs[-1] != attempt_ref
                        or current.input_artifact_refs != input_refs):
                    raise WorkflowError(
                        "Resumable local node differs from its admitted attempt")
                resumable_local_nodes.remove(node_id)
            else:
                execution = execution.transition_node(
                    node_id, NodeStatus.RUNNING, attempt_ref=attempt_ref,
                    input_artifact_refs=input_refs,
                )
            persist(execution, receipts)

    def execute(node_id, params, nodes, attempt_ref, input_refs):
        check_stop()
        node = nodes[node_id]
        path = f"plan/nodes/{node_id}"
        try:
            if node["method"] == "join":
                admit(node_id, attempt_ref, input_refs)
                value = params
            elif node["method"] == "loop":
                admit(node_id, attempt_ref, input_refs)
                state = params.get("payload", payload)
                history = []
                for iteration in range(node["max_iterations"]):
                    check_stop()
                    result = _run(
                        node["body"], state, invoke, stop_event, active_parallelism,
                        f"{path}/iterations/{iteration}/", limiter,
                    )
                    history.append(result)
                    state = result["outputs"]
                    if result["status"] != "completed":
                        return {"status": "failed", "value": {
                            "iterations": len(history), "outputs": state, "history": history,
                        }, "error": "Loop body failed"}
                    condition = node.get("until")
                    if condition is not None and _get(state, condition["path"]) == condition["equals"]:
                        break
                else:
                    if node.get("until") is not None:
                        failed = _failed(LoopLimitExceeded(
                            "Loop condition did not pass within max_iterations"))
                        failed["value"].update(
                            iterations=len(history), outputs=state, history=history)
                        return failed
                value = {"iterations": len(history), "outputs": state, "history": history}
            else:
                while not limiter.acquire(timeout=0.05):
                    check_stop()
                try:
                    check_stop()
                    admit(node_id, attempt_ref, input_refs)
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

    while True:
        active_parallelism = parallelism()
        limiter = threading.BoundedSemaphore(active_parallelism)
        nodes, dependencies, controls, artifacts = _validate(active)
        # Validate revision sources even when this runner is used directly,
        # rather than through the manifest compiler's plan_from_workflow path.
        _validate_revision_rules(active, nodes)
        _validate_strategy_checkpoint_rules(active, nodes, dependencies)
        current_ids = set(nodes)
        if current_ids != {node.id for node in execution.plan.nodes}:
            raise WorkflowError("Current workflow nodes differ from the persisted plan")
        state_by_id = {state.node_id: state for state in execution.node_executions}
        unknown_resumable = resumable_local_nodes - set(state_by_id)
        if unknown_resumable:
            raise WorkflowError("Resumable local node is absent from the current plan")
        pending = {node_id for node_id, state in state_by_id.items()
                   if (state.status is NodeStatus.PENDING
                       or node_id in resumable_local_nodes)}
        for node_id, state in state_by_id.items():
            if (state.status is NodeStatus.RUNNING
                    and (node_id not in resumable_local_nodes
                         or nodes[node_id]["method"] not in {
                             "loop", "develop_skill"})):
                raise WorkflowError("Running plan node requires host recovery")
            if state.status.terminal and node_id not in receipts:
                raise WorkflowError("Terminal plan node is missing its host receipt")
        persist(execution, receipts)

        # A process may stop after durably recording the trigger receipt but
        # before committing its PlanRevision. Recover that boundary before any
        # pending node from the obsolete graph can be admitted.
        durable_triggers = [
            node_id for node_id in nodes
            if node_id in receipts and state_by_id[node_id].status.terminal
        ]
        checkpoint = resolve_first_strategy_checkpoint(durable_triggers)
        if checkpoint is not None:
            return checkpointed_result(checkpoint)
        if apply_first_matching_revision(durable_triggers):
            continue

        revised = False
        while pending:
            check_stop()
            ready = [node_id for node_id in nodes
                     if node_id in pending and dependencies[node_id].issubset(receipts)]
            if not ready:
                raise WorkflowError("Executable plan has no ready node")
            admitted = {}
            finished_now = []
            for node_id in ready:
                node = nodes[node_id]
                policy = node.get("join_policy", active.get("join_policy", "all_success"))
                if not _admitted(node_id, dependencies[node_id], controls[node_id], receipts, policy):
                    receipts[node_id] = {"status": "skipped", "value": None}
                    execution = execution.transition_node(node_id, NodeStatus.SKIPPED)
                    pending.remove(node_id)
                    finished_now.append(node_id)
                    continue
                state = execution.node(node_id)
                attempt_ref = (state.attempt_refs[-1]
                               if node_id in resumable_local_nodes
                               else f"attempt://{execution.id}/{execution.plan.revision}/{node_id}/1")
                try:
                    params = _node_parameters(
                        node_id, nodes, artifacts, payload, receipts)
                    input_refs = tuple(receipt_evidence("input", params))
                except Exception as exc:
                    execution = execution.transition_node(
                        node_id, NodeStatus.RUNNING, attempt_ref=attempt_ref)
                    receipts[node_id] = _failed(exc)
                    if node["method"] in {"join", "loop"}:
                        record_local_receipt(
                            node["method"], {"host_preflight": True},
                            f"plan/nodes/{node_id}", receipts[node_id],
                        )
                    execution = execution.transition_node(
                        node_id, NodeStatus.FAILED,
                        failure_ref=f"failure://{execution.id}/{node_id}",
                    )
                    pending.remove(node_id)
                    finished_now.append(node_id)
                    continue
                admitted[node_id] = (params, attempt_ref, input_refs)
            persist(execution, receipts)

            interruption = None
            with ThreadPoolExecutor(
                    max_workers=active_parallelism,
                    thread_name_prefix="nexgent-plan") as executor:
                futures = {node_id: executor.submit(
                    execute, node_id, params, nodes, attempt_ref, input_refs)
                           for node_id, (params, attempt_ref, input_refs) in admitted.items()}
                for node_id, future in futures.items():
                    try:
                        receipt = future.result()
                        with execution_lock:
                            node = nodes[node_id]
                            if node["method"] in {"join", "loop"}:
                                record_local_receipt(
                                    node["method"], admitted[node_id][0],
                                    f"plan/nodes/{node_id}", receipt,
                                )
                            receipts[node_id] = receipt
                            iterations = (receipt["value"].get("iterations", 0)
                                          if node["method"] == "loop"
                                          and isinstance(receipt.get("value"), dict) else 0)
                            if receipt["status"] == "completed":
                                execution = execution.transition_node(
                                    node_id, NodeStatus.COMPLETED,
                                    output_artifact_refs=tuple(
                                        receipt_evidence("output", receipt["value"])),
                                    iteration_count=iterations,
                                )
                            else:
                                execution = execution.transition_node(
                                    node_id, NodeStatus.FAILED,
                                    failure_ref=f"failure://{execution.id}/{node_id}",
                                    iteration_count=iterations,
                                )
                            pending.remove(node_id)
                            finished_now.append(node_id)
                            persist(execution, receipts)
                    except InterruptedError as exc:
                        stop_event.set()
                        interruption = exc
            persist(execution, receipts)

            checkpoint = (
                None if interruption is not None
                else resolve_first_strategy_checkpoint(finished_now)
            )
            if checkpoint is not None:
                return checkpointed_result(checkpoint)
            revised = apply_first_matching_revision(finished_now)
            if interruption is not None:
                raise interruption
            check_stop()
            if revised:
                break

        if revised:
            continue
        outgoing = {dependency for values in dependencies.values() for dependency in values}
        terminals = [receipt for node_id, receipt in receipts.items()
                     if node_id not in outgoing and receipt["status"] != "skipped"]
        status = ("completed" if terminals
                  and all(receipt["status"] == "completed" for receipt in terminals)
                  else "failed")
        try:
            outputs = _bind(active.get("outputs", {}), payload, receipts)
            if "output_schema" in active:
                from .tools import validate
                validate(outputs, active["output_schema"], label="workflow output")
            output_error = None
        except Exception as exc:
            status, outputs = "failed", {}
            output_error = f"{type(exc).__name__}: {str(exc)[:1200]}"
        result = {"status": status, "outputs": outputs, "nodes": receipts,
                  "plan_execution": execution}
        causal_error = _causal_node_error(nodes, receipts)
        if output_error:
            result["output_error"] = output_error
        if causal_error or output_error:
            result["error"] = causal_error or output_error
        return result
