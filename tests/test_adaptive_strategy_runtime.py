from copy import deepcopy

import pytest

from nexgent.tasks.adaptive_orchestration_seed import (
    MAIN_DAG_COMPONENT_ID,
    OPEN_LOOP_COMPONENT_ID,
    STRATEGY_SELECTOR_COMPONENT_ID,
    adaptive_orchestration_package,
)
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.packages import make_package
from nexgent.tasks.strategy_decisions import STRATEGY_START_SCHEMA
from nexgent.tasks.tools import ContractError, ToolRegistry


RESULT_SPEC = [{
    "name": "result",
    "schema": {"type": "object", "required": ["answer"]},
}]


class StrategyGateway:
    def __init__(self, selected, *, invalid=False, interrupt_selector=False):
        self.selected = selected
        self.invalid = invalid
        self.interrupt_selector = interrupt_selector
        self.calls = []

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                number = len(owner.calls) + 1
                owner.calls.append({
                    "role": role, "prompt": prompt,
                    "payload": deepcopy(payload),
                })
                receipt = {
                    "call_id": f"adaptive-selector-test-{number}",
                    "role": role,
                    "model": "ADAPTIVE-STRATEGY-TEST-DOUBLE",
                    "request_digest": f"request-{number}",
                    "status": "started",
                    "reserved_completion_tokens": max_tokens,
                    "max_tokens": max_tokens,
                }
                reserve(receipt)
                if role == "strategy_selector" and owner.interrupt_selector:
                    owner.interrupt_selector = False
                    raise KeyboardInterrupt("selector outcome is unknown")
                reserve({
                    **receipt,
                    "status": "completed",
                    "billing_status": "usage_reported",
                    "usage": {
                        "prompt_tokens": 3,
                        "completion_tokens": 5,
                        "total_tokens": 8,
                    },
                })
                if role == "strategy_selector":
                    return {
                        "selected_component_id": (
                            "not-a-candidate" if owner.invalid else owner.selected),
                        "basis": ["The frozen task shape matches this strategy."],
                        "stop_conditions": ["The result artifact is published."],
                        "estimated_cost": {"model_calls": 2, "nodes": 3},
                    }
                if role == "architect":
                    return {"proposal": {
                        "replaced_node_ids": ["slot"],
                        "operations": [
                            {"op": "remove_node", "node_id": "slot"},
                            {"op": "add_node", "node": {
                                "id": "worker", "method": "ask",
                                "role_ref": "generalist",
                                "component_ref": "generalist-role",
                                "params": {
                                    "max_tokens": 1200,
                                    "prompt": "Return the requested result as JSON.",
                                },
                                "bindings": {
                                    "payload": {"task": {"$input": ""}},
                                },
                            }},
                            {"op": "add_node", "node": {
                                "id": "publish", "method": "publish",
                                "params": {"name": "result"},
                                "bindings": {
                                    "content": {"$node": "worker"},
                                },
                            }},
                            {"op": "add_control_edge", "edge": {
                                "from": "architect", "to": "worker",
                            }},
                        ],
                        "outputs": {"deliverables": {
                            "result": {"$node": "publish.id"},
                        }},
                        "revision_rules": [],
                    }}
                if role == "generalist":
                    return {"answer": "dag-backend"}
                if role == "task_agent":
                    observations = [
                        item for item in payload["history"]
                        if item.get("kind") == "observation" and item.get("ok")
                    ]
                    if not observations:
                        return {"request": {
                            "method": "publish",
                            "params": {
                                "name": "result",
                                "content": {"answer": "open-loop-backend"},
                                "schema": RESULT_SPEC[0]["schema"],
                            },
                        }}
                    return {"done": {
                        "deliverables": {"result": observations[-1]["result"]["id"]},
                        "summary": "Ran the open loop.",
                        "limitations": [],
                    }}
                if role == "task_reviewer":
                    return {"approved": True, "findings": [], "repairs": []}
                raise AssertionError(role)

        return Gateway()


def _run(tmp_path, selected):
    gateway = StrategyGateway(selected)
    service = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    episode = service.create(
        "Choose the real execution backend and return a result",
        deliverables=RESULT_SPEC,
        package=adaptive_orchestration_package(),
        context={"evaluation_private": "must not reach selector"},
    )
    return service, gateway, episode, service.run(episode["id"])


@pytest.mark.parametrize("selected,backend,answer,roles", [
    (OPEN_LOOP_COMPONENT_ID, "controlled_code", "open-loop-backend",
     ["strategy_selector", "task_agent", "task_agent", "task_reviewer"]),
    (MAIN_DAG_COMPONENT_ID, "executable_plan", "dag-backend",
     ["strategy_selector", "architect", "generalist"]),
])
def test_model_decision_dispatches_the_selected_real_backend(
        tmp_path, selected, backend, answer, roles):
    service, gateway, episode, result = _run(tmp_path, selected)

    assert result["status"] == "completed", result.get("last_error")
    assert result["execution"]["kind"] == backend
    active = result["execution"]["active_strategy"]
    assert active["component_id"] == selected
    assert active["backend"] == backend
    artifact = service.store.read(result["output_refs"]["result"], episode["id"])
    assert artifact["content"] == {"answer": answer}
    assert [call["role"] for call in gateway.calls] == roles

    decisions = [event["content"] for event in result["events"]
                 if event["kind"] == "strategy_decision"]
    assert len(decisions) == 1
    decision = decisions[0]
    assert decision["candidate_set_digest"] == (
        result["task"]["strategy_candidate_set"]["candidate_set_digest"])
    assert decision["selected_candidate"]["component_id"] == selected
    assert decision["selector_component"]["component_id"] == (
        STRATEGY_SELECTOR_COMPONENT_ID)
    assert decision["selector_component"]["source_digest"]
    assert decision["selector_rpc_receipt"]["call_path"] == "strategy/selector"
    assert decision["selector_rpc_receipt"]["status"] == "completed"
    assert decision["model_receipt"]["role"] == "strategy_selector"
    assert decision["model_receipt"]["status"] == "completed"
    assert decision["budget_receipt"]["usage_before"]["model_calls"] == 0
    assert decision["budget_receipt"]["usage_after"]["model_calls"] == 1
    assert decision["budget_receipt"]["remaining_after"]["model_calls"] == 19
    assert active["decision_id"] == decision["decision_id"]
    assert active["decision_digest"] == decision["decision_digest"]
    assert active["candidate_set_digest"] == decision["candidate_set_digest"]
    selector_payload = gateway.calls[0]["payload"]
    assert set(selector_payload["task"]) == {
        "objective", "input_refs", "deliverables", "constraints",
        "capabilities", "available_capabilities",
    }
    assert "evaluation_private" not in repr(selector_payload)


def test_invalid_model_selection_fails_without_backend_fallback(tmp_path):
    package = adaptive_orchestration_package()
    gateway = StrategyGateway(OPEN_LOOP_COMPONENT_ID, invalid=True)
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    episode = service.create(
        "Reject an unknown strategy", deliverables=RESULT_SPEC, package=package)

    first = service.run(episode["id"])
    second = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway).run(episode["id"])

    assert first["status"] == second["status"] == "failed"
    assert "unknown component" in second["last_error"]
    assert [call["role"] for call in gateway.calls] == ["strategy_selector"]
    assert not [event for event in second["events"]
                if event["kind"] in {"strategy_decision", "strategy_entered"}]


def test_create_rejects_non_role_selector_component(tmp_path):
    package = adaptive_orchestration_package()
    manifest = deepcopy(package["manifest"])
    manifest["strategy_candidates"]["selector_component_id"] = (
        MAIN_DAG_COMPONENT_ID)
    invalid = make_package(package["files"], manifest)

    with pytest.raises(ContractError, match="selector"):
        TaskService(tmp_path, tools=ToolRegistry()).create(
            "Reject a selector without a package prompt role", package=invalid)


def test_completed_selector_rpc_rebuilds_decision_without_model_replay(tmp_path):
    package = adaptive_orchestration_package()
    gateway = StrategyGateway(MAIN_DAG_COMPONENT_ID)
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    episode = service.create(
        "Recover after selector completion", deliverables=RESULT_SPEC,
        package=package)
    original_event = service.store.event
    failed = {"value": False}

    def fail_before_decision_commit(identity, kind, data):
        if kind == "strategy_decision" and not failed["value"]:
            failed["value"] = True
            raise RuntimeError("fault before strategy decision commit")
        return original_event(identity, kind, data)

    service.store.event = fail_before_decision_commit
    first = service.run(episode["id"])
    resumed = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway).run(episode["id"])

    assert first["status"] == "failed"
    assert resumed["status"] == "completed", resumed.get("last_error")
    assert [call["role"] for call in gateway.calls].count("strategy_selector") == 1
    assert len([event for event in resumed["events"]
                if event["kind"] == "strategy_decision"]) == 1
    started = [event["content"]["call_path"] for event in resumed["events"]
               if event["kind"] == "rpc_started"]
    assert started.count("strategy/selector") == 1


def test_started_selector_with_unknown_result_waits_without_resending(tmp_path):
    package = adaptive_orchestration_package()
    gateway = StrategyGateway(
        OPEN_LOOP_COMPONENT_ID, interrupt_selector=True)
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    episode = service.create(
        "Do not replay an uncertain selector", deliverables=RESULT_SPEC,
        package=package)

    with pytest.raises(KeyboardInterrupt, match="unknown"):
        service.run(episode["id"])
    resumed = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway).run(episode["id"])

    assert resumed["status"] == "waiting_input"
    assert "automatic repetition refused" in resumed["last_error"]
    assert [call["role"] for call in gateway.calls] == ["strategy_selector"]
    assert not [event for event in resumed["events"]
                if event["kind"] in {"strategy_decision", "strategy_entered"}]


def test_packages_without_strategy_candidates_keep_the_legacy_path(tmp_path):
    from nexgent.tasks.seed import default_package

    gateway = StrategyGateway(OPEN_LOOP_COMPONENT_ID)
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    episode = service.create(
        "Run the legacy package", deliverables=RESULT_SPEC,
        package=default_package())
    result = service.run(episode["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert [call["role"] for call in gateway.calls] == [
        "task_agent", "task_agent", "task_reviewer"]
    assert "strategy_candidate_set" not in result["task"]
    assert not [event for event in result["events"]
                if event["kind"] == "strategy_decision"]


def test_host_strategy_start_freezes_dag_and_skips_startup_selector(tmp_path):
    package = adaptive_orchestration_package()
    gateway = StrategyGateway(OPEN_LOOP_COMPONENT_ID)
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    episode = service.create(
        "Start the preregistered DAG without asking the startup selector",
        deliverables=RESULT_SPEC,
        package=package,
        strategy_start={
            "schema": STRATEGY_START_SCHEMA,
            "policy_id": "test_host_policy",
            "selected_component_id": MAIN_DAG_COMPONENT_ID,
        },
    )

    frozen = episode["task"]["strategy_start"]
    assert frozen["selection_source"] == "host_policy"
    assert frozen["package_id"] == package["id"]
    assert frozen["package_digest"] == package["digest"]
    assert frozen["selected_candidate"]["component_id"] == MAIN_DAG_COMPONENT_ID
    assert frozen["selected_candidate"]["source_digest"]

    result = service.run(episode["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert [call["role"] for call in gateway.calls] == ["architect", "generalist"]
    decision = next(event["content"] for event in result["events"]
                    if event["kind"] == "strategy_decision")
    assert decision["selection_source"] == "host_policy"
    assert decision["strategy_start"] == frozen
    assert decision["selected_component_id"] == MAIN_DAG_COMPONENT_ID
    assert "model_receipt" not in decision
    assert "selector_rpc_receipt" not in decision
    assert decision["budget_receipt"]["usage_before"] == (
        decision["budget_receipt"]["usage_after"])
    assert not [event for event in result["events"]
                if (event["kind"] == "rpc_started"
                    and event["content"]["call_path"] == "strategy/selector")]
    assert result["execution"]["active_strategy"]["decision_digest"] == (
        decision["decision_digest"])


def test_host_strategy_start_recovers_decision_without_selector_request(tmp_path):
    package = adaptive_orchestration_package()
    gateway = StrategyGateway(OPEN_LOOP_COMPONENT_ID)
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    episode = service.create(
        "Recover a frozen host start",
        deliverables=RESULT_SPEC,
        package=package,
        strategy_start={
            "schema": STRATEGY_START_SCHEMA,
            "policy_id": "test_host_policy",
            "selected_component_id": MAIN_DAG_COMPONENT_ID,
        },
    )
    original_event = service.store.event
    failed = {"value": False}

    def fail_before_decision_commit(identity, kind, data):
        if kind == "strategy_decision" and not failed["value"]:
            failed["value"] = True
            raise RuntimeError("fault before host strategy decision commit")
        return original_event(identity, kind, data)

    service.store.event = fail_before_decision_commit
    first = service.run(episode["id"])
    resumed = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway).run(episode["id"])

    assert first["status"] == "failed"
    assert resumed["status"] == "completed", resumed.get("last_error")
    assert [call["role"] for call in gateway.calls] == ["architect", "generalist"]
    assert len([event for event in resumed["events"]
                if event["kind"] == "strategy_decision"]) == 1
    assert not [event for event in resumed["events"]
                if (event["kind"] == "rpc_started"
                    and event["content"]["call_path"] == "strategy/selector")]


def test_host_strategy_start_rejects_a_model_sourced_recovery_record(tmp_path):
    package = adaptive_orchestration_package()
    gateway = StrategyGateway(MAIN_DAG_COMPONENT_ID)
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    episode = service.create(
        "Refuse recovery from the wrong startup authority",
        package=package,
        strategy_start={
            "schema": STRATEGY_START_SCHEMA,
            "policy_id": "test_host_policy",
            "selected_component_id": MAIN_DAG_COMPONENT_ID,
        },
    )
    service.store.event(episode["id"], "strategy_decision", {
        "schema": "nexgent.strategy-decision.v1",
        "selected_component_id": MAIN_DAG_COMPONENT_ID,
    })

    result = service.run(episode["id"])

    assert result["status"] == "waiting_input"
    assert "source differs from the frozen start policy" in result["last_error"]
    assert gateway.calls == []


def test_child_host_strategy_start_receipt_uses_root_budget(tmp_path):
    package = adaptive_orchestration_package()
    gateway = StrategyGateway(MAIN_DAG_COMPONENT_ID)
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    parent = service.create(
        "Own the task tree budget",
        package=package,
        budget={"max_model_calls": 7},
    )
    child = service.create(
        "Use the root budget for a host-selected child",
        package=package,
        parent_episode_id=parent["id"],
        strategy_start={
            "schema": STRATEGY_START_SCHEMA,
            "policy_id": "test_host_policy",
            "selected_component_id": MAIN_DAG_COMPONENT_ID,
        },
    )

    result = service.run(child["id"])

    assert result["status"] == "completed", result.get("last_error")
    decision = next(event["content"] for event in result["events"]
                    if event["kind"] == "strategy_decision")
    assert decision["budget_receipt"]["limits"]["max_model_calls"] == 7
    assert decision["budget_receipt"]["remaining_before"]["model_calls"] == 7


def test_host_strategy_start_rejects_non_candidate_and_nonadaptive_package(tmp_path):
    service = TaskService(tmp_path, tools=ToolRegistry())
    option = {
        "schema": STRATEGY_START_SCHEMA,
        "policy_id": "test_host_policy",
        "selected_component_id": "not-a-candidate",
    }
    with pytest.raises(ContractError, match="unknown component"):
        service.create(
            "Reject a host choice outside the candidate set",
            package=adaptive_orchestration_package(),
            strategy_start=option,
        )

    from nexgent.tasks.seed import default_package
    option["selected_component_id"] = OPEN_LOOP_COMPONENT_ID
    with pytest.raises(ContractError, match="adaptive candidates"):
        service.create(
            "Reject a host start without adaptive candidates",
            package=default_package(),
            strategy_start=option,
        )
