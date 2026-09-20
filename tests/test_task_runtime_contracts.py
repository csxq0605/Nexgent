"""Actual task-worker contract tests with deterministic host doubles.

These execute controlled packages in real subprocesses. Gateways, tools and
benchmark fixtures are authored test doubles: no provider or external task runs.
"""

from copy import deepcopy
from pathlib import Path
import sys
import threading

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ContractError, ToolRegistry, ToolSpec


def controlled_package(source):
    return make_package({"main.py": source}, {"entries": {"execute": "main.py:execute"}})


def result_spec():
    return [{"name": "result", "schema": {"type": "object"}}]


class DeterministicGatewayFactory:
    """Fake gateway that exercises real atomic model admission and receipts."""

    def __init__(self):
        self.calls = []
        self.finished = threading.Event()
        self._lock = threading.Lock()

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                with owner._lock:
                    number = len(owner.calls) + 1
                    owner.calls.append({"role": role, "prompt": prompt, "payload": deepcopy(payload)})
                receipt = {"call_id": f"contract-model-{number}", "role": role,
                           "model": "DETERMINISTIC-CONTRACT-DOUBLE", "status": "started",
                           "reserved_completion_tokens": max_tokens, "max_tokens": max_tokens}
                reserve(receipt)
                reserve({**receipt, "status": "completed", "billing_status": "usage_reported",
                         "usage": {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5}})
                owner.finished.set()
                return {"value": 7, "evidence": "deterministic_contract_double"}

        return Gateway()


class PauseAfterKnownToolResult:
    """Inject cancellation after one known side effect, before worker receives it."""

    def __init__(self, wait_for=None):
        self.wait_for = wait_for
        self.calls = []
        self._lock = threading.Lock()

    def __call__(self, arguments, context):
        if self.wait_for is not None:
            assert self.wait_for.wait(8), "other deterministic branch did not reach model completion"
        with self._lock:
            self.calls.append(context.episode_id)
            first = len(self.calls) == 1
        if first:
            context.stop_event.set()
        return {"value": 11}


def pause_tool(handler):
    return ToolSpec("contract.pause", {"type": "object"}, {"type": "object"}, "read", handler)


@pytest.mark.parametrize("constraints,blocked", [({"allowed_effects": ["read"]}, True), ({}, False)])
def test_installed_tool_effect_restriction_is_enforced_only_when_explicit(tmp_path, constraints, blocked):
    calls = []

    def handler(arguments, context):
        calls.append(context.episode_id)
        return {"computed": True}

    tool = ToolSpec("contract.compute", {"type": "object"}, {"type": "object"}, "external_compute", handler)
    service = TaskService(tmp_path, tools=ToolRegistry([tool]))
    package = controlled_package("""def execute(payload, context):
    value = context.tool('contract.compute', {})
    artifact = context.publish(value, name='result')
    return {'deliverables': {'result': artifact['id']}}
""")
    state = service.create("Respect task effects", deliverables=result_spec(), package=package,
                           capabilities=[tool.name], constraints=constraints)
    result = service.run(state["id"])
    if blocked:
        assert result["status"] == "failed"
        assert calls == []
        assert result["usage"]["tool_calls"] == 0
        assert "effect" in result["last_error"].lower()
    else:
        assert result["status"] == "completed"
        assert len(calls) == 1


def test_task_registration_rejects_external_schema_refs_and_accepts_local_definitions(tmp_path):
    service = TaskService(tmp_path, tools=ToolRegistry())
    for keyword in ("$ref", "$dynamicRef"):
        schema = {"type": "object", "properties": {"value": {keyword: "https://example.invalid/private-schema"}}}
        with pytest.raises(ContractError, match="local|reference"):
            service.create("Reject remote contract", deliverables=[{"name": "result", "schema": schema}])
    local_schema = {"$defs": {"value": {"type": "integer"}},
                    "type": "object", "properties": {"value": {"$ref": "#/$defs/value"}}}
    state = service.create("Local schema is valid", deliverables=[{"name": "result", "schema": local_schema}])
    assert state["status"] == "ready"


def test_unknown_started_model_rpc_requires_user_recovery_without_repeating_model(tmp_path):
    gateway = DeterministicGatewayFactory()
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    package = controlled_package("""def execute(payload, context):
    value = context.ask('contract', 'fixed', max_tokens=8)
    artifact = context.publish(value, name='result')
    return {'deliverables': {'result': artifact['id']}}
""")
    state = service.create("Unknown model outcome", package=package, deliverables=result_spec())
    params = {"role": "contract", "prompt": "fixed", "payload": None, "max_tokens": 8}
    request = {"method": "ask", "params": params, "package_digest": package["digest"]}
    service.store.rpc_start(state["id"], "rpc.1", request)
    result = service.run(state["id"])
    assert result["status"] == "waiting_input"
    assert gateway.calls == []
    assert service.store.rpc_find(state["id"], "rpc.1", request)["status"] == "started"
    assert "Unfinished" in result["last_error"] or "Recovery" in result["last_error"]


def test_delegated_interruption_resumes_same_child_and_preserves_paid_model_result(tmp_path):
    gateway = DeterministicGatewayFactory()
    pause = PauseAfterKnownToolResult()
    registry = ToolRegistry([pause_tool(pause)])
    service = TaskService(tmp_path, tools=registry, gateway_factory=gateway)
    package = controlled_package("""def execute(payload, context):
    if payload['objective'] == 'controlled child':
        answer = context.ask('child', 'fixed child check', max_tokens=8)
        checked = context.tool('contract.pause', {})
        artifact = context.publish({'answer': answer, 'checked': checked}, name='result')
        return {'deliverables': {'result': artifact['id']}}
    child = context.delegate({'objective': 'controlled child', 'deliverables': [{'name': 'result', 'schema': {'type': 'object'}}]})
    if child['status'] != 'completed':
        raise RuntimeError('nonterminal child must not be a completed delegate result')
    return {'deliverables': {'result': child['output_refs']['result']}}
""")
    state = service.create("controlled parent", package=package, deliverables=result_spec(),
                           capabilities=["contract.pause"],
                           budget={"max_model_calls": 1, "max_completion_tokens": 8,
                                   "max_tool_calls": 1, "max_nodes": 16})
    first = service.run(state["id"])
    assert first["status"] == "paused"
    assert len(first["children"]) == 1
    child_id = first["children"][0]["id"]
    request = {"method": "delegate", "params": first["nodes"]["rpc.1"]["request"],
               "package_digest": package["digest"]}
    assert service.store.rpc_find(state["id"], "rpc.1", request)["status"] == "started"
    # Recreate the host as well as the subprocess; resume uses the durable journal.
    resumed_service = TaskService(tmp_path, tools=registry, gateway_factory=gateway)
    resumed = resumed_service.run(state["id"])
    assert resumed["status"] == "completed", resumed.get("last_error")
    assert [child["id"] for child in resumed["children"]] == [child_id]
    assert len(gateway.calls) == 1 and pause.calls == [child_id]
    assert resumed["usage"]["model_calls"] == 1 and resumed["usage"]["tool_calls"] == 1
    assert resumed["usage"]["known_usage"]["completion_tokens"] == 3
    assert resumed_service.store.read(resumed["output_refs"]["result"], state["id"])["content"]["checked"] == {"value": 11}


def test_parallel_interruption_resumes_child_rpc_journal_without_repeating_paid_branch(tmp_path):
    gateway = DeterministicGatewayFactory()
    pause = PauseAfterKnownToolResult(gateway.finished)
    registry = ToolRegistry([pause_tool(pause)])
    service = TaskService(tmp_path, tools=registry, gateway_factory=gateway)
    package = controlled_package("""def execute(payload, context):
    joined = context.parallel([
        {'method': 'ask', 'params': {'role': 'worker', 'prompt': 'fixed parallel check', 'payload': None, 'max_tokens': 8}},
        {'method': 'tool', 'params': {'name': 'contract.pause', 'arguments': {}}}])
    if not all(item['ok'] for item in joined):
        raise RuntimeError('unfinished branches must remain resumable')
    artifact = context.publish({'branches': joined}, name='result')
    return {'deliverables': {'result': artifact['id']}}
""")
    state = service.create("controlled parallel task", package=package, deliverables=result_spec(),
                           capabilities=["contract.pause"],
                           budget={"max_model_calls": 1, "max_completion_tokens": 8,
                                   "max_tool_calls": 1, "max_nodes": 16})
    first = service.run(state["id"])
    assert first["status"] == "paused"
    request = {"method": "parallel", "params": first["nodes"]["rpc.1"]["request"],
               "package_digest": package["digest"]}
    assert service.store.rpc_find(state["id"], "rpc.1", request)["status"] == "started"
    assert first["nodes"]["rpc.1.0"]["status"] == "completed"
    assert first["nodes"]["rpc.1.1"]["status"] == "completed"
    resumed = TaskService(tmp_path, tools=registry, gateway_factory=gateway).run(state["id"])
    assert resumed["status"] == "completed", resumed.get("last_error")
    assert len(gateway.calls) == 1 and pause.calls == [state["id"]]
    assert resumed["usage"]["model_calls"] == 1 and resumed["usage"]["tool_calls"] == 1


class ContractBenchmark:
    """Host-only evaluator double counts actual evaluator invocations."""

    id = "contract-benchmark"

    def __init__(self):
        self.evaluations = []
        self.version = 1

    def describe(self):
        return {"id": self.id, "data_origin": "deterministic_contract_double"}

    def snapshot(self):
        return {"id": self.id, "version": self.version, "evaluator_digest": "contract-fixed-v1"}

    def tasks(self, split="development", seed=0):
        return [{"id": f"contract/{split}/{seed}", "objective": "controlled benchmark task",
                 "inputs": {"source": {"record_id": "row-1", "value": 11}},
                 "deliverables": result_spec(), "capabilities": ["contract.pause"],
                 "constraints": {"allowed_effects": ["read"]},
                 "context": {"benchmark": self.id, "split": split}}]

    def evaluate(self, task_ref, deliverables, execution_view):
        self.evaluations.append({"task_ref": deepcopy(task_ref), "deliverables": deepcopy(deliverables),
                                 "execution_view": deepcopy(execution_view)})
        assert execution_view["status"] == "completed"
        return {"status": "accepted", "score": 1.0, "score_available": True, "accepted": True}


def registered_benchmark_run(tmp_path, monkeypatch):
    import nexgent.tasks.runtime as runtime

    adapter = ContractBenchmark()
    monkeypatch.setattr(runtime, "task_benchmarks", lambda: {adapter.id: adapter})
    pause = PauseAfterKnownToolResult()
    registry = ToolRegistry([pause_tool(pause)])
    service = TaskService(tmp_path, tools=registry)
    package = controlled_package("""def execute(payload, context):
    value = context.tool('contract.pause', {})
    artifact = context.publish(value, name='result')
    return {'deliverables': {'result': artifact['id']}}
""")
    report = service.benchmark(adapter.id, package=package)
    identity = report["reports"][0]["episode_id"]
    return service, adapter, identity, registry


def test_incomplete_benchmark_is_unavailable_without_calling_evaluator(tmp_path, monkeypatch):
    service, adapter, identity, registry = registered_benchmark_run(tmp_path, monkeypatch)
    state = service.get(identity)
    report = state["evaluation"]
    assert state["status"] == "paused"
    assert report["status"] == "unavailable"
    assert report["score_available"] is False and report["accepted"] is None
    assert report["execution_status"] == "paused"
    assert adapter.evaluations == []


def test_benchmark_registration_is_frozen_and_resume_invalidates_then_explicitly_reevaluates(tmp_path, monkeypatch):
    service, adapter, identity, registry = registered_benchmark_run(tmp_path, monkeypatch)
    state = service.get(identity)
    registration = state["task"]["context"]["benchmark_registration"]
    assert registration == {"benchmark_id": adapter.id,
                            "task_ref": adapter.tasks()[0], "snapshot": adapter.snapshot()}
    resumed_service = TaskService(tmp_path, tools=registry)
    resumed = resumed_service.run(identity)
    assert resumed["status"] == "completed"
    assert resumed.get("evaluation") is None
    assert resumed["outcome"]["acceptance_status"] == "not_evaluated"
    report = resumed_service.evaluate_registered(identity)
    assert report["evaluation"]["accepted"] is True
    assert len(adapter.evaluations) == 1
    assert adapter.evaluations[0]["task_ref"] == registration["task_ref"]
    assert resumed_service.get(identity)["outcome"]["acceptance_status"] == "passed"


def test_registered_benchmark_refuses_changed_evaluator_snapshot(tmp_path, monkeypatch):
    service, adapter, identity, registry = registered_benchmark_run(tmp_path, monkeypatch)
    assert service.run(identity)["status"] == "completed"
    adapter.version += 1
    with pytest.raises(ContractError, match="snapshot|changed|frozen|identity"):
        service.evaluate_registered(identity)
    assert adapter.evaluations == []
