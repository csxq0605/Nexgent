"""Deterministic checks for the domain-neutral default task package."""

from copy import deepcopy
import json
from pathlib import Path
import sys
import threading

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.seed import default_package
from nexgent.tasks.tools import ToolRegistry, ToolSpec, artifact_ref_schema


class ScriptedGatewayFactory:
    """A receipt-producing model double whose policy returns JSON decisions."""

    def __init__(self, policy, reviewer_policy=None, recovery_policy=None):
        self.policy = policy
        self.reviewer_policy = reviewer_policy or (
            lambda payload: {"approved": True, "findings": [], "repairs": []}
        )
        self.recovery_policy = recovery_policy or (
            lambda payload: {"diagnosis": "Inspect the failed observation.",
                             "repairs": [], "next_action": "Choose a corrective action."}
        )
        self.calls = []
        self.lock = threading.Lock()

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                with owner.lock:
                    number = len(owner.calls) + 1
                    call = {"role": role, "prompt": prompt, "payload": deepcopy(payload)}
                    owner.calls.append(call)
                receipt = {"call_id": "seed-model-" + str(number), "role": role,
                           "model": "SCRIPTED-SEED-DOUBLE", "status": "started",
                           "reserved_completion_tokens": max_tokens, "max_tokens": max_tokens}
                reserve(receipt)
                policy_number = len([call for call in owner.calls if call["role"] != "recover"])
                if role == "task_reviewer":
                    result = owner.reviewer_policy(deepcopy(payload))
                elif role == "recover":
                    result = owner.recovery_policy(deepcopy(payload))
                else:
                    result = owner.policy(policy_number, deepcopy(payload))
                reserve({**receipt, "status": "completed", "billing_status": "usage_reported",
                         "usage": {"prompt_tokens": 5, "completion_tokens": 7, "total_tokens": 12}})
                return result

        return Gateway()


def result_spec():
    return [{"name": "result", "schema": {"type": "object", "required": ["answer"]}}]


def published_id(payload):
    observations = [item for item in payload["history"]
                    if item.get("kind") == "observation" and item.get("ok")]
    return observations[-1]["result"]["id"]


def test_default_package_identity_includes_prompts_and_has_no_improve_entry():
    package = default_package()
    changed_files = deepcopy(package["files"])
    changed_files["prompts/task.md"] += "\nA material prompt revision."
    changed = make_package(changed_files, package["manifest"])

    assert changed["digest"] != package["digest"]
    assert package == default_package()
    assert package["manifest"]["entries"] == {"execute": "agent/main.py:execute"}
    assert set(package["manifest"]["skills"]) == {"analyze", "review", "synthesize", "recover"}
    assert all(skill["kind"] == "prompt_protocol"
               for skill in package["manifest"]["skills"].values())
    assert {"agent/main.py", "agent/actions.py", "agent/protocol.py",
            "prompts/task.md", "prompts/review.md",
            "prompts/delivery_review.md"}.issubset(package["files"])


def test_seed_inspects_input_then_calls_tool_reads_publishes_and_finishes(tmp_path):
    tool_calls = []

    def double(arguments, context):
        tool_calls.append(deepcopy(arguments))
        return {"answer": arguments["value"] * 2}

    tool = ToolSpec("test.double",
                    {"type": "object", "required": ["value"],
                     "properties": {"value": {"type": "integer"}}},
                    {"type": "object", "required": ["answer"]}, "local_compute", double,
                    description="Double a supplied integer")

    def policy(number, payload):
        if number == 1:
            task = payload["task"]
            assert task["objective"] == "Produce a checked doubled value"
            assert task["inspected_inputs"][0]["artifact"]["content"] == {"value": 6}
            assert task["tools"][0]["name"] == "test.double"
            assert task["tools"][0]["input_schema"]["required"] == ["value"]
            assert set(task["skills"]) == {"analyze", "review", "synthesize", "recover"}
            return {"request": {"method": "tool",
                                "params": {"name": "test.double", "arguments": {"value": 6}}},
                    "plan": {"steps": ["compute", "verify", "publish"]}}
        if number == 2:
            assert payload["history"][-1]["result"] == {"answer": 12}
            input_id = payload["task"]["input_refs"]["source"]
            return {"request": {"method": "read_artifact", "params": {"artifact_id": input_id}}}
        if number == 3:
            source = payload["history"][-1]["result"]
            assert source["content"] == {"value": 6}
            return {"request": {"method": "publish",
                                "params": {"name": "result", "content": {"answer": 12},
                                           "schema": {"type": "object", "required": ["answer"]}}}}
        return {"done": {"deliverables": {"result": published_id(payload)},
                         "summary": "Used the installed operation and verified its input.",
                         "limitations": []}}

    gateway = ScriptedGatewayFactory(policy)
    service = TaskService(tmp_path, tools=ToolRegistry([tool]), gateway_factory=gateway)
    state = service.create("Produce a checked doubled value", inputs={"source": {"value": 6}},
                           deliverables=result_spec(), capabilities=[tool.name])
    result = service.run(state["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert service.store.read(result["output_refs"]["result"], state["id"])["content"] == {"answer": 12}
    assert tool_calls == [{"value": 6}]
    assert len(gateway.calls) == 5
    assert gateway.calls[-1]["role"] == "task_reviewer"
    review_payload = gateway.calls[-1]["payload"]
    assert review_payload["objective"] == "Produce a checked doubled value"
    assert review_payload["contract"]["deliverables"] == result_spec()
    assert review_payload["candidate"]["artifacts"]["result"]["content"] == {"answer": 12}
    assert result["plan"] == {"steps": ["compute", "verify", "publish"]}
    assert result["execution"]["loaded_modules"] == [
        "agent/main.py", "prompts/task.md", "prompts/protocol.md",
        "prompts/delivery_review.md", "agent/protocol.py", "agent/actions.py"]
    refs = [call["ref"] for call in result["execution"]["local_calls"]
            if call["ref"].startswith("agent/")]
    assert refs.count("agent/protocol.py:validate_decision") == 4
    assert refs.count("agent/actions.py:dispatch") == 4


def test_seed_observes_tool_failure_and_repairs_on_next_decision(tmp_path):
    attempts = []

    def flaky(arguments, context):
        attempts.append(deepcopy(arguments))
        if len(attempts) == 1:
            raise RuntimeError("controlled first failure")
        return {"answer": 9}

    tool = ToolSpec("test.flaky", {"type": "object"}, {"type": "object"}, "read", flaky)

    def policy(number, payload):
        if number == 1:
            return {"request": {"method": "tool", "params": {"name": "test.flaky", "arguments": {"try": 1}}}}
        if number == 2:
            analysis = payload["history"][-1]
            assert analysis["kind"] == "recovery_analysis"
            failed = analysis["trigger"]
            assert failed["ok"] is False and "controlled first failure" in failed["error"]
            return {"request": {"method": "tool", "params": {"name": "test.flaky", "arguments": {"try": 2}}}}
        if number == 3:
            assert payload["history"][-1]["result"] == {"answer": 9}
            return {"request": {"method": "publish",
                                "params": {"name": "result", "content": {"answer": 9}}}}
        return {"done": {"deliverables": {"result": published_id(payload)}, "summary": "repaired", "limitations": []}}

    gateway = ScriptedGatewayFactory(policy)
    service = TaskService(tmp_path, tools=ToolRegistry([tool]), gateway_factory=gateway)
    state = service.create("Recover from a failed operation", deliverables=result_spec(), capabilities=[tool.name])
    result = service.run(state["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert attempts == [{"try": 1}, {"try": 2}]
    assert "recover" in [call["role"] for call in gateway.calls]
    tool_events = [event["content"] for event in result["events"] if event["kind"] == "tool"]
    assert [event["status"] for event in tool_events] == ["failed", "completed"]


def test_seed_accepts_text_plan_without_discarding_valid_action(tmp_path):
    def policy(number, payload):
        if number == 1:
            return {"request": {"method": "publish", "params": {
                "name": "result", "content": {"answer": 5}}},
                "plan": "Publish the checked answer."}
        return {"done": {"deliverables": {"result": published_id(payload)},
                         "summary": "published", "limitations": []}}

    gateway = ScriptedGatewayFactory(policy)
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    state = service.create("Accept a concise text plan", deliverables=result_spec())
    result = service.run(state["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert result["plan"] == {"summary": "Publish the checked answer."}
    assert len(gateway.calls) == 3


def test_seed_blocks_repeated_successful_request_and_uses_recovery_skill(tmp_path):
    calls = []

    def inspect(arguments, context):
        calls.append(deepcopy(arguments))
        return {"value": 11}

    tool = ToolSpec("test.inspect", {"type": "object"}, {"type": "object"},
                    "read", inspect)

    def policy(number, payload):
        if number in {1, 2}:
            return {"request": {"method": "tool", "params": {
                "name": tool.name, "arguments": {"item": "same"}}}}
        if number == 3:
            blocked = payload["history"][-1]
            assert blocked["kind"] == "repetition_blocked"
            assert blocked["recovery_analysis"]["next_action"].startswith("Publish")
            return {"request": {"method": "publish", "params": {
                "name": "result", "content": {"answer": 11}}}}
        return {"done": {"deliverables": {"result": published_id(payload)},
                         "summary": "used prior evidence", "limitations": []}}

    def recover(payload):
        assert payload["trigger"]["kind"] == "repeated_successful_action"
        return {"diagnosis": "The inspection already succeeded.",
                "repairs": [], "next_action": "Publish the observed value."}

    gateway = ScriptedGatewayFactory(policy, recovery_policy=recover)
    service = TaskService(tmp_path, tools=ToolRegistry([tool]), gateway_factory=gateway)
    state = service.create("Do not repeat completed work", deliverables=result_spec(),
                           capabilities=[tool.name])
    result = service.run(state["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert calls == [{"item": "same"}]
    assert [call["role"] for call in gateway.calls] == [
        "task_agent", "task_agent", "recover", "task_agent", "task_agent", "task_reviewer"
    ]


def test_seed_sends_public_failure_feedback_to_recovery_skill(tmp_path):
    def validate(arguments, context):
        return {"valid": False, "errors": ["replace unsupported claim"]}

    tool = ToolSpec("test.validate", {"type": "object"}, {"type": "object"},
                    "read", validate)

    def policy(number, payload):
        if number == 1:
            return {"request": {"method": "tool", "params": {
                "name": tool.name, "arguments": {}}}}
        if number == 2:
            analysis = payload["history"][-1]
            assert analysis["kind"] == "recovery_analysis"
            assert analysis["analysis"]["repairs"] == ["Replace the unsupported claim."]
            return {"request": {"method": "publish", "params": {
                "name": "result", "content": {"answer": 13}}}}
        return {"done": {"deliverables": {"result": published_id(payload)},
                         "summary": "repaired from public feedback", "limitations": []}}

    def recover(payload):
        assert payload["trigger"]["result"]["errors"] == ["replace unsupported claim"]
        return {"diagnosis": "Public validation rejected the content.",
                "repairs": ["Replace the unsupported claim."],
                "next_action": "Publish corrected content."}

    gateway = ScriptedGatewayFactory(policy, recovery_policy=recover)
    service = TaskService(tmp_path, tools=ToolRegistry([tool]), gateway_factory=gateway)
    state = service.create("Repair public validation findings", deliverables=result_spec(),
                           capabilities=[tool.name])
    result = service.run(state["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert [call["role"] for call in gateway.calls] == [
        "task_agent", "recover", "task_agent", "task_agent", "task_reviewer"
    ]


def test_seed_decision_loop_is_bounded(tmp_path):
    gateway = ScriptedGatewayFactory(lambda number, payload: {"invalid": number})
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    state = service.create("Never provide a valid decision", deliverables=result_spec())
    result = service.run(state["id"])

    assert result["status"] == "failed"
    assert "20-decision limit" in result["last_error"]
    assert len(gateway.calls) == 20
    assert result["usage"]["model_calls"] == 20


def test_seed_rejects_invalid_action_and_exposes_error_for_repair(tmp_path):
    def policy(number, payload):
        if number == 1:
            return {"request": {"method": "shell", "params": {"command": "ignored"}}}
        if number == 2:
            analysis = payload["history"][-1]
            assert analysis["kind"] == "recovery_analysis"
            failed = analysis["trigger"]
            assert failed["kind"] == "observation" and failed["ok"] is False
            assert "Unsupported action method" in failed["error"]
            return {"request": {"method": "publish", "params": {"name": "result", "content": {"answer": 3}}}}
        return {"done": {"deliverables": {"result": published_id(payload)}, "summary": "repaired action", "limitations": []}}

    gateway = ScriptedGatewayFactory(policy)
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    state = service.create("Repair an invalid action", deliverables=result_spec())
    result = service.run(state["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert len(gateway.calls) == 5


def test_seed_independent_review_rejects_candidate_and_returns_repairs_to_main_loop(tmp_path):
    reviews = []

    def policy(number, payload):
        if number == 1:
            return {"request": {"method": "publish", "params": {
                "name": "result", "content": {"answer": 2}}}}
        if number == 2:
            return {"done": {"deliverables": {"result": published_id(payload)},
                             "summary": "The answer is correct.", "limitations": []}}
        if number == 4:
            feedback = payload["history"][-1]
            assert feedback["kind"] == "delivery_review"
            assert feedback["approved"] is False
            assert feedback["findings"] == ["The answer should be 4, not 2."]
            assert feedback["repairs"] == ["Publish a corrected result with answer 4."]
            return {"request": {"method": "publish", "params": {
                "name": "result", "content": {"answer": 4}}}}
        return {"done": {"deliverables": {"result": published_id(payload)},
                         "summary": "Corrected after independent review.", "limitations": []}}

    def reviewer(payload):
        reviews.append(deepcopy(payload))
        answer = payload["candidate"]["artifacts"]["result"]["content"]["answer"]
        if answer != 4:
            return {"approved": False,
                    "findings": ["The answer should be 4, not 2."],
                    "repairs": ["Publish a corrected result with answer 4."]}
        return {"approved": True, "findings": [], "repairs": []}

    gateway = ScriptedGatewayFactory(policy, reviewer_policy=reviewer)
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    state = service.create("Return the value four", deliverables=result_spec())
    result = service.run(state["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert service.store.read(result["output_refs"]["result"], state["id"])["content"] == {"answer": 4}
    assert len(reviews) == 2
    assert reviews[0]["objective"] == "Return the value four"
    assert reviews[0]["contract"]["deliverables"] == result_spec()
    assert any(item["kind"] == "observation" for item in reviews[0]["history"])


def test_seed_blocks_done_after_failed_action_until_successful_correction(tmp_path):
    def broken(arguments, context):
        raise RuntimeError("verification action failed")

    tool = ToolSpec("test.broken", {"type": "object"}, {"type": "object"}, "read", broken)

    def policy(number, payload):
        if number == 1:
            return {"request": {"method": "tool", "params": {
                "name": "test.broken", "arguments": {}}}}
        if number == 2:
            analysis = payload["history"][-1]
            assert analysis["kind"] == "recovery_analysis"
            assert analysis["trigger"]["ok"] is False
            return {"done": {"deliverables": {},
                             "summary": "Incorrectly claiming the failed check passed.",
                             "limitations": []}}
        if number == 3:
            blocked = payload["history"][-1]
            assert blocked["kind"] == "completion_error"
            assert "most recent action failed" in blocked["error"]
            return {"request": {"method": "publish", "params": {
                "name": "result", "content": {"answer": 7}}}}
        return {"done": {"deliverables": {"result": published_id(payload)},
                         "summary": "Performed a successful corrective action.",
                         "limitations": ["The optional broken check remains unavailable."]}}

    gateway = ScriptedGatewayFactory(policy)
    service = TaskService(tmp_path, tools=ToolRegistry([tool]), gateway_factory=gateway)
    state = service.create("Do not claim a failed check passed", deliverables=result_spec(),
                           capabilities=[tool.name])
    result = service.run(state["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert [call["role"] for call in gateway.calls] == [
        "task_agent", "recover", "task_agent", "task_agent", "task_agent", "task_reviewer"
    ]


def test_seed_does_not_swallow_delivery_reviewer_provider_failure(tmp_path):
    class ReviewerFailingGatewayFactory:
        def __init__(self):
            self.calls = []

        def __call__(self, reserve, stop_event):
            owner = self

            class Gateway:
                def ask(self, role, prompt, payload=None, max_tokens=4000):
                    owner.calls.append(role)
                    if role == "task_agent" and len(owner.calls) == 1:
                        return {"request": {"method": "publish", "params": {
                            "name": "result", "content": {"answer": 1}}}}
                    if role == "task_agent":
                        return {"done": {"deliverables": {"result": published_id(payload)},
                                         "summary": "candidate", "limitations": []}}
                    raise RuntimeError("controlled reviewer provider outage")

            return Gateway()

    gateway = ReviewerFailingGatewayFactory()
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    state = service.create("Surface reviewer provider failures", deliverables=result_spec())
    result = service.run(state["id"])

    assert result["status"] == "failed"
    assert "controlled reviewer provider outage" in result["last_error"]
    assert gateway.calls == ["task_agent", "task_agent", "task_reviewer"]


def test_seed_repairs_unknown_artifact_reference_without_poisoning_next_decision(tmp_path):
    def policy(number, payload):
        if number == 1:
            return {"request": {"method": "read_artifact",
                                "params": {"artifact_id": "artifact-ledger-temp"}}}
        if number == 2:
            analysis = payload["history"][-1]
            assert analysis["kind"] == "recovery_analysis"
            failed = analysis["trigger"]
            assert failed["kind"] == "observation" and failed["ok"] is False
            assert "artifact-ledger-temp" in failed["error"]
            return {"request": {"method": "publish",
                                "params": {"name": "result", "content": {"answer": 3}}}}
        return {"done": {"deliverables": {"result": published_id(payload)},
                         "summary": "replaced an invalid artifact reference", "limitations": []}}

    gateway = ScriptedGatewayFactory(policy)
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    state = service.create("Repair an invalid artifact reference", deliverables=result_spec())
    result = service.run(state["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert len(gateway.calls) == 5
    assert result["nodes"]["rpc.2"]["status"] == "failed"


def test_seed_repairs_tool_schema_arguments_containing_artifact_like_label(tmp_path):
    calls = []

    def handler(arguments, context):
        calls.append(deepcopy(arguments))
        return {"answer": arguments["value"]}

    tool = ToolSpec("test.integer", {
        "type": "object", "required": ["value"],
        "properties": {"value": {"type": "integer"}},
    }, {"type": "object"}, "local_compute", handler)

    def policy(number, payload):
        if number == 1:
            return {"request": {"method": "tool", "params": {
                "name": tool.name, "arguments": {"value": "artifact-ledger-temp"}}}}
        if number == 2:
            analysis = payload["history"][-1]
            assert analysis["kind"] == "recovery_analysis"
            failed = analysis["trigger"]
            assert failed["ok"] is False and "integer" in failed["error"]
            return {"request": {"method": "tool", "params": {
                "name": tool.name, "arguments": {"value": 4}}}}
        if number == 3:
            return {"request": {"method": "publish", "params": {
                "name": "result", "content": payload["history"][-1]["result"]}}}
        return {"done": {"deliverables": {"result": published_id(payload)},
                         "summary": "repaired invalid tool arguments", "limitations": []}}

    gateway = ScriptedGatewayFactory(policy)
    service = TaskService(tmp_path, tools=ToolRegistry([tool]), gateway_factory=gateway)
    state = service.create("Repair invalid tool arguments", deliverables=result_spec(),
                           capabilities=[tool.name])
    result = service.run(state["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert calls == [{"value": 4}]
    assert len(gateway.calls) == 6


def test_seed_sees_artifact_reference_contract_and_recovers_from_placeholder(tmp_path):
    handler_calls = []

    def handler(arguments, context):
        handler_calls.append(deepcopy(arguments))
        return {"valid": True}

    tool = ToolSpec("test.validate-artifact", {
        "type": "object", "required": ["result_ref"],
        "properties": {"result_ref": artifact_ref_schema()},
        "additionalProperties": False,
    }, {"type": "object"}, "read", handler)

    def policy(number, payload):
        artifact_ids = [item["result"]["id"] for item in payload.get("history", [])
                        if item.get("kind") == "observation" and item.get("ok")
                        and isinstance(item.get("result"), dict)
                        and isinstance(item["result"].get("id"), str)]
        if number == 1:
            marker = payload["task"]["tools"][0]["input_schema"]["properties"]["result_ref"]
            assert marker["x-nexgent-artifact-ref"] is True
            return {"request": {"method": "tool", "params": {
                "name": tool.name, "arguments": {"result_ref": "pending"}}}}
        if number == 2:
            feedback = payload["history"][-1]
            assert feedback["kind"] == "recovery_analysis"
            assert "publish" in feedback["analysis"]["next_action"].lower()
            return {"request": {"method": "publish", "params": {
                "name": "result", "content": {"answer": 12}}}}
        if number == 3:
            artifact_id = artifact_ids[-1]
            return {"request": {"method": "tool", "params": {
                "name": tool.name, "arguments": {"result_ref": artifact_id}}}}
        return {"done": {"deliverables": {"result": artifact_ids[-1]},
                         "summary": "published before using an artifact reference",
                         "limitations": []}}

    def recover(payload):
        assert "actual artifact ID returned by the host" in payload["trigger"]["error"]
        return {"diagnosis": "A placeholder was used where the tool requires an artifact.",
                "repairs": ["Publish the missing deliverable."],
                "next_action": "Publish the result and retain its returned artifact ID."}

    gateway = ScriptedGatewayFactory(policy, recovery_policy=recover)
    service = TaskService(tmp_path, tools=ToolRegistry([tool]), gateway_factory=gateway)
    state = service.create("Use actual artifacts", deliverables=result_spec(),
                           capabilities=[tool.name])
    result = service.run(state["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert len(handler_calls) == 1
    assert handler_calls[0]["result_ref"].startswith("artifact-")
    assert result["usage"]["tool_calls"] == 1


def test_seed_does_not_swallow_provider_failure_inside_prompt_skill(tmp_path):
    class SkillFailingGatewayFactory:
        def __init__(self):
            self.calls = []

        def __call__(self, reserve, stop_event):
            owner = self

            class Gateway:
                def ask(self, role, prompt, payload=None, max_tokens=4000):
                    owner.calls.append(role)
                    if role == "task_agent":
                        return {"request": {"method": "skill", "params": {
                            "name": "analyze", "payload": {"subject": "evidence"}}}}
                    raise RuntimeError("controlled skill provider outage")

            return Gateway()

    gateway = SkillFailingGatewayFactory()
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    state = service.create("Do not hide nested provider failures", deliverables=result_spec())
    result = service.run(state["id"])

    assert result["status"] == "failed"
    assert "controlled skill provider outage" in result["last_error"]
    assert gateway.calls == ["task_agent", "analyze"]


def test_seed_does_not_retry_after_root_node_budget_is_exhausted(tmp_path):
    gateway = ScriptedGatewayFactory(lambda number, payload: {
        "request": {"method": "publish", "params": {
            "name": "result", "content": {"answer": number}}}})
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    state = service.create("Respect the root node budget", deliverables=result_spec(),
                           budget={"max_model_calls": 5, "max_completion_tokens": 15000,
                                   "max_tool_calls": 1, "max_nodes": 1})
    result = service.run(state["id"])

    assert result["status"] == "failed"
    assert "node budget exhausted" in result["last_error"]
    assert len(gateway.calls) == 1


def test_seed_does_not_retry_a_failed_main_model_call(tmp_path):
    class FailingGatewayFactory:
        def __init__(self):
            self.calls = 0

        def __call__(self, reserve, stop_event):
            owner = self

            class Gateway:
                def ask(self, role, prompt, payload=None, max_tokens=4000):
                    owner.calls += 1
                    raise RuntimeError("controlled model outage")

            return Gateway()

    gateway = FailingGatewayFactory()
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    state = service.create("Do not hide model failures", deliverables=result_spec())
    result = service.run(state["id"])

    assert result["status"] == "failed"
    assert "controlled model outage" in result["last_error"]
    assert gateway.calls == 1


def test_seed_task_projection_keeps_small_fourteen_row_input_complete(tmp_path):
    rows = [{"source": "row-" + str(index), "amount": index}
            for index in range(14)]

    def policy(number, payload):
        if number == 1:
            inspected = payload["task"]["inspected_inputs"][0]["artifact"]["content"]
            assert inspected["rows"] == rows
            assert payload["task"]["deliverables"] == result_spec()
            assert "Decision protocol:" in gateway.calls[-1]["prompt"]
            assert all("output_schema" not in tool for tool in payload["task"]["tools"])
            return {"request": {"method": "publish", "params": {
                "name": "result", "content": {"answer": 14}}}}
        return {"done": {"deliverables": {"result": published_id(payload)},
                         "summary": "all rows remained visible", "limitations": []}}

    gateway = ScriptedGatewayFactory(policy)
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    state = service.create("Count every supplied row", inputs={"table": {"rows": rows}},
                           deliverables=result_spec())
    result = service.run(state["id"])

    assert result["status"] == "completed", result.get("last_error")


def test_seed_bounds_large_artifact_history_across_multiple_recoveries(tmp_path):
    large_text = "evidence-line-" * 9000
    recovery_triggers = []

    def policy(number, payload):
        if number == 1:
            artifact = payload["task"]["inspected_inputs"][0]["artifact"]
            assert artifact["id"].startswith("artifact-")
            assert len(artifact["content_digest"]) == 64
            assert "truncated" in artifact["content"]["blob"]
            return {"request": {"method": "read_artifact", "params": {
                "artifact_id": artifact["id"]}}}
        if number in {2, 3, 4, 5}:
            if number > 2:
                feedback = payload["history"][-1]
                assert feedback["kind"] == "recovery_analysis"
                assert "Unsupported action method" in feedback["trigger"]["error"]
                assert "analysis" in feedback
            return {"request": {"method": "unsupported-" + str(number),
                                "params": {"attempt": number}}}
        if number == 6:
            return {"request": {"method": "publish", "params": {
                "name": "result", "content": {"answer": 7}}}}
        return {"done": {"deliverables": {"result": published_id(payload)},
                         "summary": "recovered after bounded failures", "limitations": []}}

    def recover(payload):
        recovery_triggers.append(deepcopy(payload["trigger"]))
        assert payload["trigger"]["kind"] == "observation"
        assert "Unsupported action method" in payload["trigger"]["error"]
        return {"diagnosis": "The action method is outside the protocol.",
                "repairs": ["Use a supported action method."],
                "next_action": "Choose a supported action."}

    gateway = ScriptedGatewayFactory(policy, recovery_policy=recover)
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    state = service.create("Recover without duplicating a large input",
                           inputs={"source": {"blob": large_text}},
                           deliverables=result_spec())
    result = service.run(state["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert len(recovery_triggers) == 4
    encoded_calls = [len(json.dumps({
        "role": call["role"], "prompt": call["prompt"],
        "payload": call["payload"]}, ensure_ascii=False).encode("utf-8"))
        for call in gateway.calls]
    assert max(encoded_calls) < 100_000
    projected_reads = [call["payload"]["history"][-1]
                       for call in gateway.calls
                       if call["role"] == "task_agent"
                       and call["payload"]["history"]
                       and call["payload"]["history"][-1].get("kind") == "observation"
                       and call["payload"]["history"][-1].get("ok")]
    assert projected_reads
    first_read = projected_reads[0]["result"]
    assert first_read["id"].startswith("artifact-")
    assert len(first_read["content_digest"]) == 64
    assert "truncated" in first_read["content"]["blob"]
