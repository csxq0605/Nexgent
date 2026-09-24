"""Actual task-worker contract tests with deterministic host doubles.

These execute controlled packages in real subprocesses. Gateways, tools and
benchmark fixtures are authored test doubles: no provider or external task runs.
"""

from copy import deepcopy
import json
from pathlib import Path
import sys
import threading

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexgent.kernel.programs import digest
from nexgent.models.gateway import ModelOutputFormatError, ModelTransportError
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService, ToolContext
from nexgent.tasks.tools import (
    ContractError, ToolRegistry, ToolSpec, artifact_ref_schema, validate_tool_input,
)


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


class FormatRepairGatewayFactory:
    """Provider double for the host's strict two-phase JSON repair."""

    def __init__(self, candidate, repaired=None, *, interrupt_after_admission=False,
                 complete_usage=True):
        self.candidate = deepcopy(candidate)
        self.repaired = deepcopy(candidate if repaired is None else repaired)
        self.interrupt_after_admission = interrupt_after_admission
        self.complete_usage = complete_usage
        self.calls = []
        self.admitted = []

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                number = len(owner.calls) + 1
                owner.calls.append({
                    "role": role, "prompt": prompt,
                    "payload": deepcopy(payload), "max_tokens": max_tokens,
                })
                receipt = {
                    "call_id": f"format-repair-model-{number}",
                    "role": role, "model": "FORMAT-REPAIR-DOUBLE",
                    "status": "started",
                    "reserved_completion_tokens": max_tokens,
                    "max_tokens": max_tokens,
                }
                reserve(receipt)
                owner.admitted.append(number)
                if number == 1 and owner.interrupt_after_admission:
                    raise KeyboardInterrupt("controlled interruption")
                usage = {
                    "prompt_tokens": 2, "completion_tokens": 3,
                    "total_tokens": 5,
                }
                if number == 1:
                    reserve({
                        **receipt, "status": "invalid",
                        "billing_status": ("usage_reported" if owner.complete_usage
                                           else "unknown"),
                        "usage": usage if owner.complete_usage else {},
                        "output_text": json.dumps(owner.candidate) + "\nparameter",
                        "format_error_code": "extra_data_after_complete_object",
                    })
                    raise ModelOutputFormatError(
                        "Provider must return one valid JSON object",
                        code="extra_data_after_complete_object",
                        candidate=owner.candidate)
                reserve({
                    **receipt, "status": "received",
                    "billing_status": "usage_reported", "usage": usage,
                    "output": deepcopy(owner.repaired),
                    "output_text": json.dumps(owner.repaired),
                })
                return deepcopy(owner.repaired)

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


def test_tool_work_receipt_uses_host_meter_and_ignores_output_claims(tmp_path):
    def handler(arguments, context):
        context.charge_work(3)
        context.charge_work(4)
        # A domain result cannot lower or replace the host-owned meter.
        return {"value": 7, "work_units": -999}

    tool = ToolSpec(
        "contract.metered", {"type": "object"}, {"type": "object"},
        "local_compute", handler, work_units_per_call=5)
    service = TaskService(tmp_path, tools=ToolRegistry([tool]))
    package = controlled_package("""def execute(payload, context):
    value = context.tool('contract.metered', {})
    artifact = context.publish(value, name='result')
    return {'deliverables': {'result': artifact['id']}}
""")
    state = service.create(
        "Meter trusted tool work", package=package, capabilities=[tool.name],
        deliverables=result_spec(), budget={
            "max_model_calls": 0, "max_completion_tokens": 0,
            "max_tool_calls": 1, "max_tool_work_units": 10, "max_nodes": 8,
        })
    result = service.run(state["id"])
    assert result["status"] == "completed", result.get("last_error")
    assert result["usage"]["reserved_tool_work_units"] == 5
    assert result["usage"]["tool_work_units"] == 7
    assert result["usage"]["charged_tool_work_units"] == 7
    assert result["usage"]["usage_complete"] is True
    receipt = [event["content"] for event in service.get_private(state["id"])["events"]
               if event["kind"] == "tool"][-1]
    assert receipt["work_accounting"] == {
        "schema": "nexgent.tool-work.v1", "reserved_work_units": 5,
        "measured_work_units": 7, "charged_work_units": 7,
        "usage_complete": True,
    }
    assert receipt["result"]["work_units"] == -999


def test_tool_work_budget_is_reserved_before_handler_and_meter_overrun_stops_work(tmp_path):
    calls = []

    def handler(arguments, context):
        calls.append("started")
        context.charge_work(6)
        calls.append("unreachable")
        return {"value": 1}

    tool = ToolSpec(
        "contract.expensive", {"type": "object"}, {"type": "object"},
        "external_compute", handler, work_units_per_call=5)
    package = controlled_package("""def execute(payload, context):
    value = context.tool('contract.expensive', {})
    artifact = context.publish(value, name='result')
    return {'deliverables': {'result': artifact['id']}}
""")
    blocked_service = TaskService(tmp_path / "blocked", tools=ToolRegistry([tool]))
    blocked = blocked_service.create(
        "Reject before handler", package=package, capabilities=[tool.name],
        deliverables=result_spec(), budget={
            "max_model_calls": 0, "max_completion_tokens": 0,
            "max_tool_calls": 1, "max_tool_work_units": 4, "max_nodes": 8,
        })
    blocked = blocked_service.run(blocked["id"])
    assert blocked["status"] == "failed" and calls == []
    assert blocked["usage"]["tool_calls"] == 0

    metered_service = TaskService(tmp_path / "metered", tools=ToolRegistry([tool]))
    metered = metered_service.create(
        "Stop at meter boundary", package=package, capabilities=[tool.name],
        deliverables=result_spec(), budget={
            "max_model_calls": 0, "max_completion_tokens": 0,
            "max_tool_calls": 1, "max_tool_work_units": 5, "max_nodes": 8,
        })
    metered = metered_service.run(metered["id"])
    assert metered["status"] == "failed"
    assert calls == ["started"]
    assert metered["usage"]["charged_tool_work_units"] == 5
    assert metered["usage"]["tool_work_units"] == 0
    assert metered["usage"]["usage_complete"] is True


def test_resumed_tool_rpc_reuses_one_work_receipt_without_free_or_duplicate_work(tmp_path):
    calls = []

    def handler(arguments, context):
        calls.append(context.episode_id)
        context.charge_work(5)
        context.stop_event.set()
        return {"value": 11}

    tool = ToolSpec(
        "contract.metered_pause", {"type": "object"}, {"type": "object"},
        "external_compute", handler, work_units_per_call=3)
    registry = ToolRegistry([tool])
    service = TaskService(tmp_path, tools=registry)
    package = controlled_package("""def execute(payload, context):
    value = context.tool('contract.metered_pause', {})
    artifact = context.publish(value, name='result')
    return {'deliverables': {'result': artifact['id']}}
""")
    state = service.create(
        "Resume paid tool work", package=package, capabilities=[tool.name],
        deliverables=result_spec(), budget={
            "max_model_calls": 0, "max_completion_tokens": 0,
            "max_tool_calls": 1, "max_tool_work_units": 5, "max_nodes": 8,
        })
    first = service.run(state["id"])
    assert first["status"] == "paused"
    assert first["usage"]["charged_tool_work_units"] == 5
    assert first["usage"]["usage_complete"] is True
    resumed = TaskService(tmp_path, tools=registry).run(state["id"])
    assert resumed["status"] == "completed", resumed.get("last_error")
    assert calls == [state["id"]]
    assert resumed["usage"]["tool_calls"] == 1
    assert resumed["usage"]["reserved_tool_work_units"] == 3
    assert resumed["usage"]["tool_work_units"] == 5
    assert resumed["usage"]["charged_tool_work_units"] == 5


def test_terminal_failure_domain_separates_agent_protocol_and_host_failures(tmp_path):
    class FailureAdapter:
        id = "failure-contract"

        def snapshot(self):
            return {"id": self.id, "version": 1}

        def evaluate(self, task_ref, deliverables, execution_view):
            raise AssertionError("A failed Episode must not call the benchmark evaluator")

    adapter = FailureAdapter()
    failing_tool = ToolSpec(
        "contract.host_failure", {"type": "object"}, {"type": "object"}, "read",
        lambda arguments, context: (_ for _ in ()).throw(RuntimeError("host tool unavailable")),
    )
    registry = ToolRegistry([failing_tool])
    host_service = TaskService(tmp_path / "host", tools=registry)
    host_package = controlled_package("""def execute(payload, context):
    context.tool('contract.host_failure', {})
    return {'deliverables': {}}
""")
    host = host_service.create(
        "host failure", package=host_package, capabilities=[failing_tool.name],
        deliverables=result_spec(),
    )
    host_result = host_service.run(host["id"])
    assert host_result["status"] == "failed"
    assert host_result["failure_domain"] == "infrastructure"
    host_evaluation = host_service.evaluate(host["id"], adapter, {"id": "host"})["evaluation"]
    assert host_evaluation["score_available"] is False
    assert host_evaluation["accepted"] is None

    class TransportFactory:
        def __call__(self, reserve, stop_event):
            class Gateway:
                def ask(self, **params):
                    raise ModelTransportError(
                        "provider connection failed", {"connection_phase": "connect"})
            return Gateway()

    model_service = TaskService(
        tmp_path / "model", tools=ToolRegistry(), gateway_factory=TransportFactory())
    model_package = controlled_package("""def execute(payload, context):
    context.ask('worker', 'attempt', max_tokens=8)
    return {'deliverables': {}}
""")
    model = model_service.create("model failure", package=model_package, deliverables=result_spec())
    model_result = model_service.run(model["id"])
    assert model_result["status"] == "failed"
    assert model_result["failure_domain"] == "infrastructure"
    model_evaluation = model_service.evaluate(
        model["id"], adapter, {"id": "transport"})["evaluation"]
    assert model_evaluation["score_available"] is False
    assert model_evaluation["accepted"] is None

    agent_service = TaskService(tmp_path / "agent", tools=ToolRegistry())
    agent_package = controlled_package("""def execute(payload, context):
    raise RuntimeError('agent implementation failed')
""")
    agent = agent_service.create("agent failure", package=agent_package, deliverables=result_spec())
    agent_result = agent_service.run(agent["id"])
    assert agent_result["status"] == "failed"
    assert agent_result["failure_domain"] == "agent"
    agent_evaluation = agent_service.evaluate(
        agent["id"], adapter, {"id": "agent"})["evaluation"]
    assert (agent_evaluation["status"], agent_evaluation["score"],
            agent_evaluation["accepted"]) == ("observed_failure", 0.0, False)

    class BudgetFactory:
        def __call__(self, reserve, stop_event):
            class Gateway:
                def ask(self, **params):
                    reserve({"call_id": "budget-call", "status": "reserved",
                             "model": "test/model", "role": params["role"],
                             "request_digest": "budget-request",
                             "reserved_completion_tokens": params["max_tokens"]})
            return Gateway()

    budget_service = TaskService(
        tmp_path / "budget", tools=ToolRegistry(), gateway_factory=BudgetFactory())
    budget_package = controlled_package("""def execute(payload, context):
    context.ask('worker', 'exhaust the frozen zero-call budget', max_tokens=8)
    return {'deliverables': {}}
""")
    budget = budget_service.create(
        "budget failure", package=budget_package, deliverables=result_spec(),
        budget={"max_model_calls": 0})
    budget_result = budget_service.run(budget["id"])
    assert budget_result["status"] == "failed"
    assert budget_result["failure_domain"] == "agent"
    budget_evaluation = budget_service.evaluate(
        budget["id"], adapter, {"id": "budget"})["evaluation"]
    assert (budget_evaluation["status"], budget_evaluation["score"],
            budget_evaluation["accepted"]) == ("observed_failure", 0.0, False)

    protocol_package = controlled_package("""def execute(payload, context):
    return {'unexpected': True}
""")
    protocol = agent_service.create(
        "protocol failure", package=protocol_package, deliverables=result_spec())
    protocol_result = agent_service.run(protocol["id"])
    assert protocol_result["status"] == "failed"
    assert protocol_result["failure_domain"] == "protocol"
    protocol_evaluation = agent_service.evaluate(
        protocol["id"], adapter, {"id": "protocol"})["evaluation"]
    assert (protocol_evaluation["status"], protocol_evaluation["score"],
            protocol_evaluation["accepted"]) == ("observed_failure", 0.0, False)


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


def test_task_context_cannot_forge_improver_channel_registration(tmp_path):
    service = TaskService(tmp_path, tools=ToolRegistry())
    package = controlled_package("""def execute(payload, context):
    return {'deliverables': {}}
""")

    with pytest.raises(ContractError, match="host-owned"):
        service.create(
            "Reject caller-owned improver deployment identity", package=package,
            context={"improver_channel_registration": {
                "channel": "recursive", "revision": 0,
                "package_id": package["id"], "package_digest": package["digest"],
            }})


def test_tool_artifact_reference_contract_rejects_placeholders_before_handler(tmp_path):
    calls = []

    def handler(arguments, context):
        calls.append(deepcopy(arguments))
        return {"value": context.read_artifact(arguments["source_ref"])["content"]}

    tool = ToolSpec(
        "contract.artifact", {
            "type": "object", "required": ["source_ref"],
            "properties": {"source_ref": artifact_ref_schema()},
            "additionalProperties": False,
        }, {"type": "object"}, "read", handler)
    service = TaskService(tmp_path, tools=ToolRegistry([tool]))
    invalid_package = controlled_package("""def execute(payload, context):
    context.tool('contract.artifact', {'source_ref': 'pending'})
    return {'deliverables': {}}
""")
    invalid = service.create(
        "Reject placeholder artifact identities", package=invalid_package,
        deliverables=result_spec(), capabilities=[tool.name])
    failed = service.run(invalid["id"])

    assert failed["status"] == "failed"
    assert failed["failure_domain"] == "protocol"
    assert "actual artifact ID returned by the host" in failed["last_error"]
    assert failed["usage"]["tool_calls"] == 0
    assert calls == []

    valid_package = controlled_package("""def execute(payload, context):
    value = context.tool('contract.artifact', {'source_ref': payload['input_refs']['source']})
    artifact = context.publish(value, name='result')
    return {'deliverables': {'result': artifact['id']}}
""")
    valid = service.create(
        "Accept host artifact identities", inputs={"source": {"answer": 9}},
        package=valid_package, deliverables=result_spec(), capabilities=[tool.name])
    completed = service.run(valid["id"])
    assert completed["status"] == "completed", completed.get("last_error")
    assert len(calls) == 1 and calls[0]["source_ref"].startswith("artifact-")


def test_tool_registration_rejects_invalid_or_output_artifact_reference_annotations():
    for invalid_units in (-1, 1.5, float("nan")):
        with pytest.raises(ContractError, match="work-unit reservation"):
            ToolRegistry([ToolSpec(
                "contract.invalid-work", {"type": "object"}, {"type": "object"},
                "read", lambda arguments, context: {},
                work_units_per_call=invalid_units)])
    invalid = ToolSpec(
        "contract.invalid-artifact-marker", {
            "type": "object", "properties": {
                "source_ref": {"type": "string", "x-nexgent-artifact-ref": False}}},
        {"type": "object"}, "read", lambda arguments, context: {})
    with pytest.raises(ContractError, match="Artifact-reference annotations"):
        ToolRegistry([invalid])
    output_marker = ToolSpec(
        "contract.output-artifact-marker", {"type": "object"},
        {"type": "string", "x-nexgent-artifact-ref": True}, "read",
        lambda arguments, context: "artifact-0000000000000000")
    with pytest.raises(ContractError, match="only valid in tool inputs"):
        ToolRegistry([output_marker])


def test_artifact_reference_keyword_is_only_interpreted_at_schema_positions():
    ordinary_data = [
        {"type": "object", "properties": {
            "x-nexgent-artifact-ref": {"type": "boolean"}}},
        {"const": {"x-nexgent-artifact-ref": "ordinary data"}},
        {"examples": [{"x-nexgent-artifact-ref": "ordinary data"}]},
    ]
    for index, schema in enumerate(ordinary_data):
        ToolRegistry([ToolSpec(
            f"contract.ordinary-marker-name-{index}", schema,
            {"type": "object"}, "read", lambda arguments, context: {})])

    remote_ref = {"type": "object", "properties": {
        "source": {"$ref": "https://example.invalid/schema"}}}
    with pytest.raises(ContractError, match="local definitions"):
        ToolRegistry([ToolSpec(
            "contract.remote-ref", remote_ref, {"type": "object"}, "read",
            lambda arguments, context: {})])

    for unsupported in (
        {"dependencies": {"source": artifact_ref_schema()}},
        {"contentSchema": artifact_ref_schema()},
    ):
        with pytest.raises(ContractError, match="not supported"):
            ToolRegistry([ToolSpec(
                "contract.unsupported-artifact-position", unsupported,
                {"type": "object"}, "read", lambda arguments, context: {})])


def test_artifact_reference_keyword_follows_json_schema_applicator_semantics():
    seen = []
    resolver = lambda ref: seen.append(ref)
    first = "artifact-1111111111111111"
    second = "artifact-2222222222222222"

    local_ref = {
        "$defs": {"artifact": artifact_ref_schema()},
        "type": "object", "required": ["source"],
        "properties": {"source": {"$ref": "#/$defs/artifact"}},
    }
    validate_tool_input({"source": first}, local_ref, artifact_resolver=resolver)
    assert seen == [first]

    seen.clear()
    alternative = {"type": "object", "properties": {
        "value": {"anyOf": [{"type": "integer"}, artifact_ref_schema()]}}}
    validate_tool_input({"value": 7}, alternative, artifact_resolver=resolver)
    assert seen == []

    pattern = {"type": "object", "patternProperties": {
        "^input_": artifact_ref_schema()}}
    with pytest.raises(ContractError, match="actual artifact ID"):
        validate_tool_input(
            {"input_one": "pending"}, pattern, artifact_resolver=resolver)

    seen.clear()
    array = {"type": "array", "prefixItems": [artifact_ref_schema()],
             "items": artifact_ref_schema()}
    validate_tool_input([first, second], array, artifact_resolver=resolver)
    assert seen == [first, second]


def test_tool_workspace_is_bounded_and_shared_by_the_root_episode(tmp_path):
    service = TaskService(tmp_path, tools=ToolRegistry())
    parent = service.create("parent")
    child = service.create("child", parent_episode_id=parent["id"])
    parent_context = ToolContext(service, parent["id"], "rpc.1", threading.Event())
    child_context = ToolContext(service, child["id"], "rpc.1.1", threading.Event())

    parent_workspace = parent_context.workspace("openfoam")
    assert parent_workspace == child_context.workspace("openfoam")
    assert parent_workspace == (tmp_path.resolve() / ".nexgent" / "tool-workspaces"
                                / "openfoam" / parent["id"])
    assert parent_workspace.is_dir()
    events = service.store.events(child["id"])
    assert events[-1]["kind"] == "tool_workspace_opened"
    assert events[-1]["content"]["root_episode_id"] == parent["id"]

    for invalid in ("../escape", "OpenFOAM", "", "a" * 65, "space here"):
        with pytest.raises(ContractError, match="workspace namespace"):
            parent_context.workspace(invalid)


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
    assert result["failure_domain"] == "infrastructure"
    assert gateway.calls == []
    assert service.store.rpc_find(state["id"], "rpc.1", request)["status"] == "started"
    assert "Unfinished" in result["last_error"] or "Recovery" in result["last_error"]


def test_trailing_text_json_gets_one_durable_semantics_preserving_repair(tmp_path):
    gateway = FormatRepairGatewayFactory({"value": 7})
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    package = controlled_package("""def execute(payload, context):
    value = context.ask('worker', 'return an object', max_tokens=8)
    artifact = context.publish(value, name='result')
    return {'deliverables': {'result': artifact['id']}}
""")
    state = service.create(
        "Repair a transport envelope", package=package, deliverables=result_spec(),
        budget={"max_model_calls": 2, "max_completion_tokens": 16,
                "max_tool_calls": 0, "max_nodes": 8})

    result = service.run(state["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert result["usage"]["model_calls"] == 2
    assert service.store.read(
        result["output_refs"]["result"], state["id"])["content"] == {"value": 7}
    assert len(gateway.calls) == 2
    assert gateway.calls[1]["payload"] == {
        "schema": "nexgent.json-format-repair.v1",
        "candidate": {"value": 7},
    }
    phases = service.store.rpc_under(state["id"], "rpc.1/model.")
    assert [(item["call_path"], item["status"]) for item in phases] == [
        ("rpc.1/model.json-repair", "completed"),
        ("rpc.1/model.primary", "failed"),
    ]


def test_json_format_repair_cannot_change_object_content(tmp_path):
    gateway = FormatRepairGatewayFactory({"value": 7}, {"value": 8})
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    package = controlled_package("""def execute(payload, context):
    value = context.ask('worker', 'return an object', max_tokens=8)
    artifact = context.publish(value, name='result')
    return {'deliverables': {'result': artifact['id']}}
""")
    state = service.create(
        "Reject semantic repair changes", package=package,
        deliverables=result_spec(),
        budget={"max_model_calls": 2, "max_completion_tokens": 16,
                "max_tool_calls": 0, "max_nodes": 8})

    result = service.run(state["id"])

    assert result["status"] == "failed"
    assert result["failure_domain"] == "agent"
    assert "changed object content" in result["last_error"]
    assert len(gateway.calls) == 2


def test_unmetered_primary_format_failure_does_not_start_repair(tmp_path):
    gateway = FormatRepairGatewayFactory({"value": 7}, complete_usage=False)
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    package = controlled_package("""def execute(payload, context):
    value = context.ask('worker', 'return an object', max_tokens=8)
    artifact = context.publish(value, name='result')
    return {'deliverables': {'result': artifact['id']}}
""")
    state = service.create(
        "Do not repair an unmetered response", package=package,
        deliverables=result_spec(),
        budget={"max_model_calls": 2, "max_completion_tokens": 16,
                "max_tool_calls": 0, "max_nodes": 8})

    result = service.run(state["id"])

    assert result["status"] == "waiting_input"
    assert result["failure_domain"] == "infrastructure"
    assert "completely metered" in result["last_error"]
    assert len(gateway.calls) == 1
    assert result["usage"]["usage_complete"] is False


def test_json_format_repair_uses_existing_root_model_budget(tmp_path):
    gateway = FormatRepairGatewayFactory({"value": 7})
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    package = controlled_package("""def execute(payload, context):
    value = context.ask('worker', 'return an object', max_tokens=8)
    artifact = context.publish(value, name='result')
    return {'deliverables': {'result': artifact['id']}}
""")
    state = service.create(
        "Bound JSON repair by the root budget", package=package,
        deliverables=result_spec(),
        budget={"max_model_calls": 1, "max_completion_tokens": 8,
                "max_tool_calls": 0, "max_nodes": 8})

    result = service.run(state["id"])

    assert result["status"] == "failed"
    assert result["failure_domain"] == "agent"
    assert "model-call budget exhausted" in result["last_error"]
    assert len(gateway.calls) == 2
    assert gateway.admitted == [1]
    assert result["usage"]["model_calls"] == 1


def test_unknown_json_repair_phase_is_never_replayed(tmp_path):
    gateway = FormatRepairGatewayFactory(
        {"value": 7}, interrupt_after_admission=True)
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    package = controlled_package("""def execute(payload, context):
    value = context.ask('worker', 'return an object', max_tokens=8)
    artifact = context.publish(value, name='result')
    return {'deliverables': {'result': artifact['id']}}
""")
    state = service.create(
        "Do not replay an unknown provider call", package=package,
        deliverables=result_spec(),
        budget={"max_model_calls": 2, "max_completion_tokens": 16,
                "max_tool_calls": 0, "max_nodes": 8})

    with pytest.raises(KeyboardInterrupt, match="controlled interruption"):
        service.run(state["id"])
    assert len(gateway.calls) == 1

    resumed = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway).run(state["id"])

    assert resumed["status"] == "waiting_input"
    assert resumed["failure_domain"] == "infrastructure"
    assert len(gateway.calls) == 1
    assert service.store.rpc_find(
        state["id"], "rpc.1/model.primary")["status"] == "started"


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
    assert first["failure_domain"] == "infrastructure"
    assert len(first["children"]) == 1
    child_id = first["children"][0]["id"]
    private = service.get_private(state["id"])
    request = {"method": "delegate", "params": private["nodes"]["rpc.1"]["request"],
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
    private = service.get_private(state["id"])
    request = {"method": "parallel", "params": private["nodes"]["rpc.1"]["request"],
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


def test_private_benchmark_registration_has_no_package_visible_enumeration_or_digest(tmp_path):
    service = TaskService(tmp_path, tools=ToolRegistry())
    package = controlled_package("""def execute(payload, context):
    artifact = context.publish({'context': payload['context']}, name='result')
    return {'deliverables': {'result': artifact['id']}}
""")
    candidates = [
        {"benchmark_id": "tiny", "task_ref": {"id": index}, "snapshot": {"version": 1}}
        for index in range(8)
    ]
    registration = candidates[3]
    state = service.create(
        "private registration", package=package, deliverables=result_spec(),
        context={"memory_namespace": "study", "split": "final_holdout"},
        benchmark_registration=registration,
    )
    result = service.run(state["id"])
    visible = service.store.read(result["output_refs"]["result"], state["id"])["content"]["context"]
    encoded = json.dumps(visible, sort_keys=True)
    assert visible == {"memory_namespace": "study", "split": "final_holdout"}
    assert "benchmark_registration" not in encoded
    assert all(digest(candidate) not in encoded for candidate in candidates)
    stored_registration = service.store.benchmark_registration(state["id"])
    assert {key: stored_registration[key] for key in registration} == registration
    assert stored_registration["host_runtime"]["schema"] == (
        "nexgent.task-benchmark-host-runtime.v1")


def test_final_holdout_delegate_inherits_only_public_context_whitelist(tmp_path):
    service = TaskService(tmp_path, tools=ToolRegistry())
    package = controlled_package("""def execute(payload, context):
    if payload['objective'] == 'inspect delegated context':
        artifact = context.publish({'context': payload['context']}, name='result')
        return {'deliverables': {'result': artifact['id']}}
    child = context.delegate({
        'objective': 'inspect delegated context',
        'context': {
            'benchmark_registration_digest': 'guessed-low-entropy-marker',
            'study_cell_id': 'package-controlled-cell'
        },
        'deliverables': [{'name': 'result', 'schema': {'type': 'object'}}]
    })
    return {'deliverables': {'result': child['output_refs']['result']}}
""")
    registration = {
        "benchmark_id": "private-benchmark",
        "task_ref": {"id": "private-task"},
        "snapshot": {"version": 1},
    }
    parent_context = {
        "memory_namespace": "confirmatory-study",
        "split": "final_holdout",
        "split_role": "final_holdout",
        "memory_writeback": False,
        "rsi_role": "confirmatory_holdout",
        "study_plan_id": "private-plan-id",
        "study_cell_id": "private-cell-id",
        "provider_requirement": "private-provider",
        "model_requirement": "private-model",
        "monitoring_registration": {"private": True},
    }
    parent = service.create(
        "delegate final holdout", package=package, deliverables=result_spec(),
        context=parent_context, benchmark_registration=registration,
    )
    result = service.run(parent["id"])
    assert result["status"] == "completed", result.get("last_error")
    assert len(result["children"]) == 1
    child = service.get(result["children"][0]["id"])
    expected = {
        "memory_namespace": "confirmatory-study",
        "split": "final_holdout",
        "split_role": "final_holdout",
        "memory_writeback": False,
        "rsi_role": "confirmatory_holdout",
    }
    assert child["task"]["context"] == expected
    assert service.store.benchmark_registration(child["id"]) is None
    delivered = service.store.read(result["output_refs"]["result"], parent["id"])["content"]
    assert delivered["context"] == expected
    assert not ({"study_plan_id", "study_cell_id", "provider_requirement",
                 "model_requirement", "monitoring_registration",
                 "benchmark_registration_digest"} & set(delivered["context"]))


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
    registration = service.store.benchmark_registration(identity)
    assert {key: registration[key] for key in ("benchmark_id", "task_ref", "snapshot")} == {
        "benchmark_id": adapter.id,
        "task_ref": adapter.tasks()[0], "snapshot": adapter.snapshot()}
    assert registration["host_runtime"]["schema"] == "nexgent.task-benchmark-host-runtime.v1"
    assert "benchmark_registration" not in state["task"]["context"]
    assert "benchmark_registration_digest" not in state["task"]["context"]
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
