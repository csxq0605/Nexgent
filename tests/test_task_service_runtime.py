"""Deterministic runtime contracts for Episode-local model-context services."""

from copy import deepcopy
import threading

import pytest

from nexgent.kernel.programs import digest
from nexgent.kernel.store import BudgetExhausted
from nexgent.tasks.capability_authority import make_episode_authority
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.store import StateConflict
from nexgent.tasks.tools import ContractError, ToolRegistry


def _authority():
    return make_episode_authority(
        ["service_provider"],
        ["model_context"],
        max_definitions=6,
        max_invocations=12,
        version=2,
    )


def _package():
    return make_package(
        {"agent/main.py": "def execute(payload, context):\n    return {}\n"},
        {"entries": {"execute": "agent/main.py:execute"}},
    )


def _proposal(name="context.add_hint", hint="inspect evidence"):
    return {
        "name": name,
        "description": "Add one task-local hint to model-visible JSON.",
        "source": (
            "def provide(payload, context):\n"
            "    visible = payload['payload'].copy()\n"
            f"    visible['service_hint'] = '{hint}'\n"
            f"    return {{'payload': visible, 'annotations': {{'hint': '{hint}'}}}}\n"
        ),
    }


def _invalid_output_proposal():
    return {
        "name": "context.invalid_output",
        "description": "Return an invalid provider envelope for fail-closed testing.",
        "source": (
            "def provide(payload, context):\n"
            "    return {'payload': payload['payload']}\n"
        ),
    }


def _dropping_context_proposal():
    return {
        "name": "context.drops_evidence",
        "description": "Attempt to erase the original model evidence.",
        "source": (
            "def provide(payload, context):\n"
            "    return {'payload': {'criteria': '50ms'}, 'annotations': {}}\n"
        ),
    }


class CapturingGatewayFactory:
    def __init__(self):
        self.created = 0
        self.sends = []
        self.lock = threading.Lock()

    def __call__(self, reserve, stop_event):
        owner = self
        with self.lock:
            owner.created += 1

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                with owner.lock:
                    number = len(owner.sends) + 1
                    owner.sends.append({
                        "role": role,
                        "prompt": prompt,
                        "payload": deepcopy(payload),
                        "max_tokens": max_tokens,
                    })
                receipt = {
                    "call_id": "service-runtime-" + str(number),
                    "role": role,
                    "model": "DETERMINISTIC-SERVICE-GATEWAY",
                    "status": "started",
                    "reserved_completion_tokens": max_tokens,
                    "max_tokens": max_tokens,
                }
                reserve(receipt)
                result = {"observed_payload": deepcopy(payload)}
                reserve({
                    **receipt,
                    "status": "completed",
                    "billing_status": "usage_reported",
                    "usage": {
                        "prompt_tokens": 3,
                        "completion_tokens": 2,
                        "total_tokens": 5,
                    },
                })
                return result

        return Gateway()


def _invoke(service, episode_id, package, method, params, path):
    return service._invoke(
        episode_id,
        package,
        method,
        params,
        path,
        threading.Event(),
        lambda: None,
    )


def _create(service, package, *, authority=None):
    return service.create(
        "Exercise one Episode-local model-context provider",
        package=package,
        capabilities=[],
        capability_authority=authority,
    )


def _develop_and_activate(service, episode_id, package, proposal, *, revision=0):
    developed = _invoke(
        service,
        episode_id,
        package,
        "develop_service",
        {"proposal": proposal},
        "develop-" + proposal["name"],
    )
    activated = _invoke(
        service,
        episode_id,
        package,
        "activate_service",
        {"definition_id": developed["definition_id"],
         "expected_revision": revision},
        "activate-" + proposal["name"],
    )
    return developed, activated


def test_develop_activate_restart_transform_and_identity_receipt(tmp_path):
    package = _package()
    initial_gateway = CapturingGatewayFactory()
    service = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=initial_gateway
    )
    episode = _create(service, package, authority=_authority())
    developed, activated = _develop_and_activate(
        service, episode["id"], package, _proposal()
    )
    assert activated == {
        "definition_id": developed["definition_id"],
        "instance_revision": 1,
        "status": "active",
    }
    # An activation that committed before its enclosing RPC completed can be
    # safely re-entered with the original compare-and-swap revision.
    assert service.store.activate_service_provider(
        episode["id"], developed["definition_id"], expected_revision=0
    )["revision"] == 1

    inventory = _invoke(
        service, episode["id"], package, "capability_inventory", {}, "inventory"
    )
    provider = inventory["services"]["model_context.v1"]
    assert provider["status"] == "active"
    assert provider["revision"] == 1
    assert provider["definition_id"] == developed["definition_id"]

    # A fresh service object must load the Definition, package, and active slot
    # from the durable Episode rather than relying on an in-memory registration.
    gateway = CapturingGatewayFactory()
    restarted = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway
    )
    answer = _invoke(
        restarted,
        episode["id"],
        package,
        "ask",
        {
            "role": "solver",
            "prompt": "Keep this prompt byte-for-byte unchanged.",
            "payload": {"question": "what next?"},
            "max_tokens": 40,
        },
        "ask-after-restart",
    )

    expected_payload = {
        "question": "what next?",
        "service_hint": "inspect evidence",
    }
    assert answer == {"observed_payload": expected_payload}
    assert gateway.sends == [{
        "role": "solver",
        "prompt": "Keep this prompt byte-for-byte unchanged.",
        "payload": expected_payload,
        "max_tokens": 40,
    }]
    definition = restarted.store.service_definition(developed["definition_id"])
    binding = {
        "definition_id": definition["id"],
        "definition_digest": definition["digest"],
        "instance_revision": 1,
        "authority_digest": _authority()["digest"],
    }
    receipt = restarted.store.calls(episode["id"])[-1]
    assert receipt["service_provider"] == binding
    assert receipt["effective_payload_digest"] == digest(expected_payload)

    applied = [
        event["content"] for event in restarted.store.events(episode["id"])
        if event["kind"] == "service_applied"
    ][-1]
    assert applied["binding"] == binding
    assert applied["annotations"] == {"hint": "inspect evidence"}
    assert applied["package_id"] == definition["package_id"]
    assert applied["package_digest"] == definition["package_digest"]
    assert applied["entry_digest"] == definition["entry_digest"]
    assert applied["worker_execution"]["rpc_count"] == 0
    assert applied["worker_execution"]["instructions"] <= applied[
        "worker_instruction_limit"
    ]


def test_release_then_explicit_replacement_changes_only_later_asks(tmp_path):
    package = _package()
    gateway = CapturingGatewayFactory()
    service = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway
    )
    episode = _create(service, package, authority=_authority())
    first, first_active = _develop_and_activate(
        service, episode["id"], package,
        _proposal("context.first", "first"),
    )
    assert first_active["instance_revision"] == 1
    assert _invoke(
        service, episode["id"], package, "ask",
        {"role": "solver", "prompt": "p", "payload": {"n": 1},
         "max_tokens": 20},
        "ask-first",
    )["observed_payload"]["service_hint"] == "first"

    released = _invoke(
        service, episode["id"], package, "release_service",
        {"expected_revision": 1}, "release-first",
    )
    assert released == {
        "definition_id": first["definition_id"],
        "instance_revision": 2,
        "status": "released",
    }
    raw = _invoke(
        service, episode["id"], package, "ask",
        {"role": "solver", "prompt": "p", "payload": {"n": 2},
         "max_tokens": 20},
        "ask-released",
    )
    assert raw["observed_payload"] == {"n": 2}

    second = _invoke(
        service, episode["id"], package, "develop_service",
        {"proposal": _proposal("context.second", "second")},
        "develop-second",
    )
    with pytest.raises(StateConflict, match="revision"):
        _invoke(
            service, episode["id"], package, "activate_service",
            {"definition_id": second["definition_id"], "expected_revision": 1},
            "activate-second-stale",
        )
    second_active = _invoke(
        service, episode["id"], package, "activate_service",
        {"definition_id": second["definition_id"], "expected_revision": 2},
        "activate-second",
    )
    assert second_active["instance_revision"] == 3
    assert _invoke(
        service, episode["id"], package, "ask",
        {"role": "solver", "prompt": "p", "payload": {"n": 3},
         "max_tokens": 20},
        "ask-second",
    )["observed_payload"]["service_hint"] == "second"

    calls = service.store.calls(episode["id"])
    assert "service_provider" in calls[0]
    assert "service_provider" not in calls[1]
    assert calls[2]["service_provider"]["definition_id"] == second[
        "definition_id"
    ]


def test_provider_failure_happens_before_gateway_creation_or_send(tmp_path):
    package = _package()
    gateway = CapturingGatewayFactory()
    service = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway
    )
    episode = _create(service, package, authority=_authority())
    _develop_and_activate(
        service, episode["id"], package, _invalid_output_proposal()
    )

    with pytest.raises(ContractError, match="service output"):
        _invoke(
            service, episode["id"], package, "ask",
            {"role": "solver", "prompt": "must not send",
             "payload": {"secret": "local-only"}, "max_tokens": 20},
            "ask-invalid-provider",
        )

    assert gateway.created == 0
    assert gateway.sends == []
    assert service.store.calls(episode["id"]) == []
    failures = [
        event["content"] for event in service.store.events(episode["id"])
        if event["kind"] == "service_application_failed"
    ]
    assert len(failures) == 1
    assert failures[0]["node_id"] == "ask-invalid-provider"


def test_provider_cannot_erase_original_model_evidence(tmp_path):
    package = _package()
    gateway = CapturingGatewayFactory()
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    episode = _create(service, package, authority=_authority())
    _develop_and_activate(service, episode["id"], package,
                          _dropping_context_proposal())
    with pytest.raises(ContractError, match="preserve existing payload"):
        _invoke(service, episode["id"], package, "ask", {
            "role": "solver", "prompt": "compare", "payload": {"options": {"A": 40}},
            "max_tokens": 20}, "ask-erasing-evidence")
    assert gateway.created == 0
    assert service.store.calls(episode["id"]) == []
    assert any(event["kind"] == "service_application_failed"
               for event in service.store.events(episode["id"]))


def test_service_development_requires_explicit_v2_authority(tmp_path):
    package = _package()
    service = TaskService(tmp_path, tools=ToolRegistry())
    no_authority = _create(service, package)
    with pytest.raises(PermissionError, match="authority"):
        _invoke(
            service, no_authority["id"], package, "develop_service",
            {"proposal": _proposal()}, "develop-without-authority",
        )

    tool_only = _create(
        service,
        package,
        authority=make_episode_authority(["tool"], ["local_compute"]),
    )
    with pytest.raises(ContractError, match="kind"):
        _invoke(
            service, tool_only["id"], package, "develop_service",
            {"proposal": _proposal()}, "develop-with-tool-authority",
        )

    with service.store.connect() as db:
        assert db.execute(
            "SELECT COUNT(*) FROM task_capability_definitions"
        ).fetchone()[0] == 0


def test_service_execution_shares_root_capability_call_budget(tmp_path):
    package = _package()
    gateway = CapturingGatewayFactory()
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    episode = service.create(
        "Bound model-context execution under the root capability budget",
        package=package, capabilities=[], capability_authority=_authority(),
        budget={"max_tool_calls": 1},
    )
    _develop_and_activate(service, episode["id"], package, _proposal())
    ask = {"role": "solver", "prompt": "p", "payload": {"n": 1},
           "max_tokens": 20}
    _invoke(service, episode["id"], package, "ask", ask, "first-ask")
    with pytest.raises(BudgetExhausted, match="capability-call"):
        _invoke(service, episode["id"], package, "ask", ask, "second-ask")
    child = service.create(
        "Check that delegation does not reset the root service budget",
        package=package, capabilities=[], capability_authority=_authority(),
        parent_episode_id=episode["id"],
    )
    _develop_and_activate(service, child["id"], package, _proposal())
    with pytest.raises(BudgetExhausted, match="capability-call"):
        _invoke(service, child["id"], package, "ask", ask, "child-ask")
    assert len(gateway.sends) == 1
    assert len(service.store.calls(episode["id"])) == 1


def test_sibling_cannot_activate_foreign_service_definition(tmp_path):
    package = _package()
    service = TaskService(tmp_path, tools=ToolRegistry())
    owner = _create(service, package, authority=_authority())
    sibling = _create(service, package, authority=_authority())
    developed = _invoke(
        service, owner["id"], package, "develop_service",
        {"proposal": _proposal()}, "develop-owner-service",
    )
    with pytest.raises(PermissionError, match="creator Episode"):
        _invoke(
            service, sibling["id"], package, "activate_service",
            {"definition_id": developed["definition_id"], "expected_revision": 0},
            "activate-foreign-service",
        )
    assert service.store.service_instance(sibling["id"]) is None
