"""Focused checks for the pre-selection adaptive orchestration seed."""

from copy import deepcopy
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexgent.tasks.adaptive_orchestration_seed import (
    MAIN_DAG_COMPONENT_ID,
    OPEN_LOOP_COMPONENT_ID,
    STRATEGY_CANDIDATE_SET_SCHEMA,
    STRATEGY_SELECTOR_COMPONENT_ID,
    STRATEGY_SELECTOR_PROMPT_PATH,
    adaptive_orchestration_package,
    strategy_candidate_bindings,
)
from nexgent.tasks.package_runner import run_package
from nexgent.tasks.packages import PackageError, make_package, verify_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.seed import default_package
from nexgent.tasks.self_orchestration_seed import self_orchestration_package


def test_adaptive_seed_binds_two_real_candidate_sources_without_enabling_selection():
    open_loop = default_package()
    main_dag = self_orchestration_package()
    package = adaptive_orchestration_package()

    verify_package(package)
    assert package["manifest"]["manifest_version"] == 2
    assert package["manifest"]["orchestrator"] == MAIN_DAG_COMPONENT_ID
    assert package["manifest"]["strategy_candidates"] == {
        "schema": STRATEGY_CANDIDATE_SET_SCHEMA,
        "component_ids": [OPEN_LOOP_COMPONENT_ID, MAIN_DAG_COMPONENT_ID],
        "selector_component_id": STRATEGY_SELECTOR_COMPONENT_ID,
    }

    bindings = {item["component_id"]: item
                for item in strategy_candidate_bindings(package)}
    assert bindings[OPEN_LOOP_COMPONENT_ID] == {
        "component_id": OPEN_LOOP_COMPONENT_ID,
        "kind": "entry",
        "ref": "execute",
        "source_path": "agent/main.py",
        "source_digest": open_loop["component_digests"]["agent/main.py"],
    }
    assert bindings[MAIN_DAG_COMPONENT_ID] == {
        "component_id": MAIN_DAG_COMPONENT_ID,
        "kind": "workflow",
        "ref": "main",
        "source_path": "workflows/main.json",
        "source_digest": main_dag["component_digests"]["workflows/main.json"],
    }
    assert package["files"]["agent/main.py"] == open_loop["files"]["agent/main.py"]
    assert package["files"]["workflows/main.json"] == main_dag["files"][
        "workflows/main.json"]
    assert package["files"]["agent/main.py"] != main_dag["files"]["agent/main.py"]
    for path, content in open_loop["files"].items():
        assert package["files"][path] == content
    for path, content in main_dag["files"].items():
        if path != "agent/main.py":
            assert package["files"][path] == content
    assert "StrategyDecision" in package["provenance"]["activation"]
    selector = package["manifest"]["components"][STRATEGY_SELECTOR_COMPONENT_ID]
    assert selector == {"class": "S", "kind": "role", "ref": "strategy_selector"}
    assert package["manifest"]["roles"]["strategy_selector"]["prompt_ref"] == (
        STRATEGY_SELECTOR_PROMPT_PATH)


def test_adaptive_seed_open_loop_entry_executes_under_controlled_runner_without_a_model():
    package = adaptive_orchestration_package()
    asks = []

    def handle(method, params):
        assert method == "ask"
        asks.append(params["role"])
        if params["role"] == "task_agent":
            return {"done": {"deliverables": {}, "summary": "pure runner probe",
                             "limitations": []}}
        assert params["role"] == "task_reviewer"
        return {"approved": True, "findings": [], "repairs": []}

    result = run_package(package, "execute", {
        "objective": "Exercise the real open-loop entry",
        "input_refs": {},
        "deliverables": [],
        "constraints": {},
        "context": {},
        "tools": [],
        "skills": {},
        "memory_snapshot": {},
    }, handle, timeout=20)

    assert result["value"] == {
        "deliverables": {}, "summary": "pure runner probe", "limitations": [],
    }
    assert asks == ["task_agent", "task_reviewer"]
    assert result["execution"]["entry"] == "execute"
    assert result["execution"]["loaded_modules"][:3] == [
        "agent/main.py", "prompts/task.md", "prompts/protocol.md"]
    assert "agent/protocol.py" in result["execution"]["loaded_modules"]


class _DagGatewayFactory:
    def __init__(self):
        self.roles = []

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                owner.roles.append(role)
                receipt = {
                    "call_id": f"adaptive-dag-{len(owner.roles)}",
                    "role": role,
                    "model": "ADAPTIVE-DAG-TEST-DOUBLE",
                    "status": "started",
                    "reserved_completion_tokens": max_tokens,
                    "max_tokens": max_tokens,
                }
                reserve(receipt)
                reserve({
                    **receipt,
                    "status": "completed",
                    "billing_status": "usage_reported",
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1,
                              "total_tokens": 2},
                })
                if role == "strategy_selector":
                    return {
                        "selected_component_id": MAIN_DAG_COMPONENT_ID,
                        "basis": ["The task benefits from an explicit graph."],
                        "stop_conditions": ["The requested result is published."],
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
                                "params": {"max_tokens": 1200,
                                           "prompt": "Return JSON."},
                                "bindings": {"payload": {"task": {"$input": ""}}},
                            }},
                            {"op": "add_node", "node": {
                                "id": "publish", "method": "publish",
                                "params": {"name": "result"},
                                "bindings": {"content": {"$node": "worker"}},
                            }},
                            {"op": "add_control_edge",
                             "edge": {"from": "architect", "to": "worker"}},
                        ],
                        "outputs": {"deliverables": {
                            "result": {"$node": "publish.id"}}},
                        "revision_rules": [],
                    }}
                return {"answer": "dag-ran"}

        return Gateway()


def test_adaptive_seed_preserves_the_legacy_main_dag_execution_path(tmp_path):
    gateway = _DagGatewayFactory()
    service = TaskService(tmp_path, gateway_factory=gateway)
    episode = service.create(
        "Run the legacy Main DAG",
        deliverables=[{"name": "result",
                       "schema": {"type": "object", "required": ["answer"]}}],
        package=adaptive_orchestration_package(),
    )

    result = service.run(episode["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert result["execution"]["kind"] == "executable_plan"
    assert result["execution"]["active_strategy"]["component_id"] == (
        MAIN_DAG_COMPONENT_ID)
    assert gateway.roles == ["strategy_selector", "architect", "generalist"]
    artifact = service.store.read(result["output_refs"]["result"], episode["id"])
    assert artifact["content"] == {"answer": "dag-ran"}


class _CheckpointGatewayFactory:
    def __init__(self):
        self.calls = []

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                owner.calls.append({"role": role, "payload": deepcopy(payload)})
                number = len(owner.calls)
                receipt = {
                    "call_id": f"adaptive-checkpoint-{number}",
                    "role": role,
                    "model": "ADAPTIVE-CHECKPOINT-TEST-DOUBLE",
                    "status": "started",
                    "reserved_completion_tokens": max_tokens,
                    "max_tokens": max_tokens,
                }
                reserve(receipt)
                reserve({
                    **receipt,
                    "status": "completed",
                    "billing_status": "usage_reported",
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1,
                              "total_tokens": 2},
                })
                if role == "strategy_selector":
                    if payload["schema"] == "nexgent.strategy-selection-request.v1":
                        return {
                            "selected_component_id": MAIN_DAG_COMPONENT_ID,
                            "basis": ["Start with the bounded graph."],
                            "stop_conditions": ["The task completes."],
                            "estimated_cost": {"model_calls": 4, "nodes": 3},
                        }
                    return {
                        "target_component_id": OPEN_LOOP_COMPONENT_ID,
                        "reason": "The diagnostic calls for iterative recovery.",
                    }
                if role == "architect":
                    return {"proposal": {
                        "replaced_node_ids": ["slot"],
                        "operations": [
                            {"op": "remove_node", "node_id": "slot"},
                            {"op": "add_node", "node": {
                                "id": "inspect", "method": "join",
                                "params": {"feedback": {
                                    "failure_domain": "agent",
                                    "finding": "Continue with adaptive correction.",
                                }},
                            }},
                            {"op": "add_node", "node": {
                                "id": "finish", "method": "publish",
                                "params": {
                                    "name": "result",
                                    "content": {"answer": "dag fallback"},
                                },
                            }},
                            {"op": "add_control_edge", "edge": {
                                "from": "architect", "to": "inspect",
                            }},
                            {"op": "add_control_edge", "edge": {
                                "from": "inspect", "to": "finish",
                            }},
                        ],
                        "outputs": {"deliverables": {
                            "result": {"$node": "finish.id"},
                        }},
                        "revision_rules": [],
                        "strategy_checkpoint_rules": [{
                            "id": "inspect-feedback",
                            "after_node": "inspect",
                            "feedback_path": "feedback",
                        }],
                    }}
                if role == "task_agent":
                    assert payload["task"]["strategy_handoff"]["artifact"][
                        "content"]["trigger"]["failure_domain"] == "agent"
                    task_agent_calls = [
                        call for call in owner.calls if call["role"] == "task_agent"
                    ]
                    if len(task_agent_calls) == 1:
                        return {"request": {
                            "method": "publish",
                            "params": {
                                "name": "result",
                                "content": {"answer": "open-loop recovery"},
                            },
                        }}
                    observations = [
                        item for item in payload["history"]
                        if item.get("kind") == "observation" and item.get("ok")
                    ]
                    return {"done": {
                        "deliverables": {
                            "result": observations[-1]["result"]["id"],
                        },
                        "summary": "continued from the durable handoff",
                        "limitations": [],
                    }}
                assert role == "task_reviewer"
                return {"approved": True, "findings": [], "repairs": []}

        return Gateway()


def test_adaptive_seed_model_graph_can_checkpoint_into_real_open_loop(tmp_path):
    gateway = _CheckpointGatewayFactory()
    service = TaskService(tmp_path, gateway_factory=gateway)
    episode = service.create(
        "Switch from a generated graph when its diagnostic warrants recovery",
        deliverables=[{
            "name": "result",
            "schema": {"type": "object", "required": ["answer"]},
        }],
        package=adaptive_orchestration_package(),
    )

    result = service.run(episode["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert result["strategy_checkpoint"]["resolution"][
        "selected_component_id"] == OPEN_LOOP_COMPONENT_ID
    artifact = service.store.read(result["output_refs"]["result"], episode["id"])
    assert artifact["content"] == {"answer": "open-loop recovery"}
    assert [call["role"] for call in gateway.calls] == [
        "strategy_selector", "architect", "strategy_selector",
        "task_agent", "task_agent", "task_reviewer",
    ]


def test_adaptive_seed_rejects_resource_and_component_collisions():
    open_loop = default_package()
    conflicting_files = deepcopy(open_loop["files"])
    conflicting_files["prompts/architect.md"] = "unrelated replacement"
    conflicting_open_loop = make_package(conflicting_files, open_loop["manifest"])
    with pytest.raises(PackageError, match="conflicting package file"):
        adaptive_orchestration_package(open_loop_package=conflicting_open_loop)

    main_dag = self_orchestration_package()
    conflicting_dag_files = deepcopy(main_dag["files"])
    conflicting_dag_files["resources/conflict.txt"] = "occupied component identity"
    conflicting_manifest = deepcopy(main_dag["manifest"])
    conflicting_manifest["components"][OPEN_LOOP_COMPONENT_ID] = {
        "class": "S", "kind": "resource", "ref": "resources/conflict.txt",
    }
    conflicting_main_dag = make_package(conflicting_dag_files, conflicting_manifest)
    with pytest.raises(PackageError, match="conflicting component id"):
        adaptive_orchestration_package(main_dag_package=conflicting_main_dag)


def test_candidate_metadata_tampering_fails_closed():
    package = adaptive_orchestration_package()
    manifest = deepcopy(package["manifest"])
    manifest["strategy_candidates"]["component_ids"] = [
        "missing-component", MAIN_DAG_COMPONENT_ID]
    tampered = make_package(package["files"], manifest)

    with pytest.raises(PackageError, match="Strategy candidate"):
        strategy_candidate_bindings(tampered)
