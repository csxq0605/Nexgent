"""Actual invocation, branching, failure joins, bounded loops and cancellation."""

from copy import deepcopy
import threading

import pytest

from nexgent.tasks.workflows import WorkflowError, run_workflow


def test_control_and_artifact_dependencies_are_separate():
    workflow = {"nodes": [
        {"id": "check", "method": "tool", "params": {"name": "check"}},
        {"id": "draft", "method": "tool", "bindings": {"text": {"$input": "text"}}},
        {"id": "finish", "method": "tool"}],
        "control_edges": [{"from": "check", "to": "finish", "condition": {"path": "passed", "equals": True}}],
        "artifact_edges": [{"producer_node": "draft", "output_port": "text", "consumer_node": "finish", "input_port": "arguments.text"}],
        "outputs": {"result": {"$node": "finish.output.text"}}}
    calls = {}

    def invoke(method, params, path):
        calls[path] = params
        if path == "nodes/check":
            return {"passed": True, "private_check_data": "not an input"}
        if path == "nodes/draft":
            return {"text": params["text"].upper()}
        return params["arguments"]

    result = run_workflow(workflow, {"text": "hello"}, invoke)
    assert result["status"] == "completed"
    assert result["outputs"] == {"result": "HELLO"}
    assert calls["nodes/finish"] == {"arguments": {"text": "HELLO"}}


@pytest.mark.parametrize("passed", [True, False])
def test_conditional_repair_and_first_success_output(passed):
    workflow = {"nodes": [
        {"id": "check", "method": "tool"},
        {"id": "accept", "method": "tool", "bindings": {"draft": {"$node": "check.draft"}}},
        {"id": "repair", "method": "tool", "bindings": {"draft": {"$node": "check.output.draft"}}}],
        "control_edges": [
            {"from": "check", "to": "accept", "condition": {"path": "passed", "equals": True}},
            {"from": "check", "to": "repair", "condition": {"path": "passed", "equals": False}}],
        "outputs": {"answer": {"$first_success": ["accept.answer", "repair.answer"]}}}
    calls = []

    def invoke(method, params, path):
        calls.append(path)
        return {"passed": passed, "draft": "draft"} if path == "nodes/check" else {"answer": "accepted" if path == "nodes/accept" else "repaired"}

    result = run_workflow(workflow, {}, invoke)
    assert result["status"] == "completed"
    assert result["outputs"]["answer"] == ("accepted" if passed else "repaired")
    assert len(calls) == 2
    assert result["nodes"]["repair" if passed else "accept"]["status"] == "skipped"


def test_failed_node_routes_to_recovery_using_error_receipt():
    workflow = {"nodes": [
        {"id": "attempt", "method": "tool"},
        {"id": "repair", "method": "tool", "bindings": {"cause": {"$node": "attempt.error_type"}}}],
        "control_edges": [{"from": "attempt", "to": "repair", "condition": {"path": "$status", "equals": "failed"}}],
        "outputs": {"answer": {"$first_success": ["attempt.answer", "repair.answer"]}}}

    def invoke(method, params, path):
        if path == "nodes/attempt":
            raise RuntimeError("controlled failure")
        assert params["cause"] == "RuntimeError"
        return {"answer": "recovered"}

    result = run_workflow(workflow, {}, invoke)
    assert result["status"] == "completed"
    assert result["nodes"]["attempt"]["status"] == "failed"
    assert result["outputs"] == {"answer": "recovered"}


@pytest.mark.parametrize("join_policy, expected", [("all_success", "failed"), ("all_completed", "completed"), ("any_success", "completed")])
def test_parallel_partial_failure_and_join_policies(join_policy, expected):
    workflow = {"nodes": [{"id": "a", "method": "tool"}, {"id": "b", "method": "tool"},
                          {"id": "join", "method": "join", "join_policy": join_policy,
                           "bindings": {"a": {"$node": "a"}, "b": {"$node": "b"}}}],
                "control_edges": [{"from": "a", "to": "join"}, {"from": "b", "to": "join"}],
                "outputs": {"chosen": {"$first_success": ["a.answer", "b.answer"]}}}
    barrier = threading.Barrier(2)
    finished = []
    lock = threading.Lock()

    def invoke(method, params, path):
        barrier.wait(timeout=5)
        with lock:
            finished.append(path)
        if path == "nodes/a":
            raise ValueError("one branch failed")
        return {"answer": 42}

    result = run_workflow(workflow, {}, invoke, max_parallel=2)
    assert result["status"] == expected
    assert set(finished) == {"nodes/a", "nodes/b"}
    assert result["outputs"] == {"chosen": 42}
    assert result["nodes"]["join"]["status"] == ("skipped" if join_policy == "all_success" else "completed")
    if expected == "completed":
        assert result["nodes"]["join"]["value"]["a"]["error_type"] == "ValueError"


def loop_workflow(max_iterations=3, until=3):
    return {"nodes": [{"id": "iterate", "method": "loop", "max_iterations": max_iterations,
                        "until": {"path": "count", "equals": until},
                        "body": {"nodes": [{"id": "increment", "method": "tool", "bindings": {"count": {"$input": "count"}}}],
                                 "outputs": {"count": {"$node": "increment.count"}}}}],
            "outputs": {"count": {"$node": "iterate.outputs.count"}}}


def test_loop_has_finite_state_and_unique_rpc_paths():
    paths = []

    def invoke(method, params, path):
        paths.append(path)
        return {"count": params["count"] + 1}

    result = run_workflow(loop_workflow(), {"count": 0}, invoke)
    assert result["status"] == "completed"
    assert result["outputs"] == {"count": 3}
    assert result["nodes"]["iterate"]["value"]["iterations"] == 3
    assert paths == [f"nodes/iterate/iterations/{i}/nodes/increment" for i in range(3)]


def test_loop_limit_is_failure_instead_of_silent_success():
    result = run_workflow(loop_workflow(2, 9), {"count": 0}, lambda m, p, path: {"count": p["count"] + 1})
    assert result["status"] == "failed"
    value = result["nodes"]["iterate"]["value"]
    assert value["error_type"] == "LoopLimitExceeded"
    assert value["iterations"] == 2
    assert result["outputs"] == {"count": 2}


def test_loop_without_until_executes_declared_finite_iterations():
    workflow = loop_workflow(2)
    del workflow["nodes"][0]["until"]
    result = run_workflow(workflow, {"count": 0}, lambda m, p, path: {"count": p["count"] + 1})
    assert result["status"] == "completed"
    assert result["outputs"] == {"count": 2}


@pytest.mark.parametrize("mutation", ["cycle", "unknown_node", "unknown_edge", "infinite_loop", "mixed_binding", "bad_port"])
def test_invalid_graphs_and_references(mutation):
    workflow = {"nodes": [{"id": "a", "method": "tool"}, {"id": "b", "method": "tool"}], "outputs": {}}
    if mutation == "cycle":
        workflow["control_edges"] = [{"from": "a", "to": "b"}, {"from": "b", "to": "a"}]
    elif mutation == "unknown_node":
        workflow["outputs"] = {"value": {"$node": "missing.result"}}
    elif mutation == "unknown_edge":
        workflow["artifact_edges"] = [{"producer_node": "a", "output_port": "x", "consumer_node": "missing", "input_port": "x"}]
    elif mutation == "infinite_loop":
        workflow = loop_workflow()
        workflow["nodes"][0]["max_iterations"] = 0
    elif mutation == "mixed_binding":
        workflow["nodes"][0]["params"] = {"x": {"$input": "x", "literal": 1}}
    else:
        workflow["artifact_edges"] = [{"producer_node": "a", "output_port": None, "consumer_node": "b", "input_port": "x"}]
    calls = []
    with pytest.raises(WorkflowError):
        run_workflow(workflow, {}, lambda *args: calls.append(args))
    assert calls == []


def test_missing_binding_path_is_node_failure_and_never_invoked():
    workflow = {"nodes": [{"id": "a", "method": "tool", "bindings": {"value": {"$input": "missing"}}}]}
    calls = []
    result = run_workflow(workflow, {}, lambda *args: calls.append(args))
    assert result["status"] == "failed"
    assert result["nodes"]["a"]["value"]["error_type"] == "WorkflowError"
    assert calls == []


def test_cancel_joins_all_admitted_parallel_calls():
    workflow = {"nodes": [{"id": "a", "method": "tool"}, {"id": "b", "method": "tool"}]}
    stop = threading.Event()
    barrier = threading.Barrier(3)
    settled = []

    def invoke(method, params, path):
        barrier.wait(timeout=5)
        assert stop.wait(5)
        settled.append(path)
        raise InterruptedError("stopped")

    def cancel():
        barrier.wait(timeout=5)
        stop.set()

    cancellation = threading.Thread(target=cancel)
    cancellation.start()
    try:
        with pytest.raises(InterruptedError):
            run_workflow(workflow, {}, invoke, stop_event=stop, max_parallel=2)
    finally:
        cancellation.join()
    assert set(settled) == {"nodes/a", "nodes/b"}
    assert not any(thread.name.startswith("nexgent-workflow") for thread in threading.enumerate())


def test_pre_cancelled_workflow_does_not_invoke():
    stop = threading.Event()
    stop.set()
    calls = []
    with pytest.raises(InterruptedError):
        run_workflow({"nodes": [{"id": "a", "method": "tool"}]}, {}, lambda *args: calls.append(args), stop_event=stop)
    assert calls == []


def test_schema_validation_checks_real_values():
    workflow = {"nodes": [{"id": "a", "method": "tool", "output_schema": {"type": "object", "required": ["answer"]}}],
                "outputs": {"answer": {"$node": "a.answer"}}, "input_schema": {"type": "object"}}
    result = run_workflow(workflow, {}, lambda *args: {"incorrect": True})
    assert result["status"] == "failed"
    assert result["nodes"]["a"]["value"]["error_type"] == "ContractError"
    with pytest.raises(ValueError):
        run_workflow(workflow, [], lambda *args: {"answer": 1})


def test_nested_loops_share_root_concurrency_limit():
    body = {"nodes": [{"id": "a", "method": "tool"}, {"id": "b", "method": "tool"}]}
    workflow = {"nodes": [{"id": name, "method": "loop", "max_iterations": 1, "body": deepcopy(body)} for name in ["one", "two"]]}
    lock = threading.Lock()
    active = [0]
    peak = [0]
    total = [0]

    def invoke(method, params, path):
        with lock:
            active[0] += 1
            peak[0] = max(peak[0], active[0])
            total[0] += 1
        threading.Event().wait(0.02)
        with lock:
            active[0] -= 1
        return {}

    result = run_workflow(workflow, {}, invoke, max_parallel=2)
    assert result["status"] == "completed"
    assert peak[0] <= 2
    assert total[0] == 4
