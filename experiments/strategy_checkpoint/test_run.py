from __future__ import annotations

from copy import deepcopy
import threading

import pytest

from experiments.strategy_checkpoint import run
from experiments.strategy_checkpoint.evaluator import evaluate


def test_package_freezes_exact_candidates_and_host_strategy_start():
    package = run.framework_package()
    candidates = run.strategy_candidate_set_from_manifest(package)

    assert [(item["component_id"], item["kind"], item["backend"])
            for item in candidates["candidates"]] == [
        (run.DAG_COMPONENT_ID, "workflow", "executable_plan"),
        (run.ENTRY_COMPONENT_ID, "entry", "controlled_code"),
    ]
    assert package["manifest"]["workflows"]["release_checkpoint"][
        "max_parallel"] == 4
    assert run.strategy_start() == {
        "schema": run.STRATEGY_START_SCHEMA,
        "policy_id": "d1c_experimental_intervention",
        "selected_component_id": run.DAG_COMPONENT_ID,
    }


def _validator_arguments(*, material, fault=None, draft=None):
    return {
        "base_policy": deepcopy(run.BASE_POLICY),
        "policy_update": run._policy_update(material),
        "service_reports": deepcopy(run.SERVICE_REPORTS),
        "draft": (run._expected_review(run.BASE_POLICY)
                  if draft is None else deepcopy(draft)),
        "fault": {"feedback_domain": fault},
    }


def test_host_validator_creates_protocol_feedback_only_for_verified_material_gap():
    result = run.validate_release_draft(
        _validator_arguments(material=True), context=None)

    assert result["base_passed"] is True
    assert result["updated_passed"] is False
    assert result["verdict"] == "material_protocol_gap"
    assert result["feedback"]["failure_domain"] == "protocol"
    assert result["feedback"]["changed_fields"] == [
        "revision", "service_pass_requires.coverage_at_least",
    ]
    assert result["base_policy_digest"] == run._sha_value(run.BASE_POLICY)
    assert result["updated_policy_digest"] == run._sha_value(run._policy_update(True))
    assert result["draft_digest"] == run._sha_value(
        run._expected_review(run.BASE_POLICY))
    normalization = result["normalization"]
    assert normalization["substantive_unchanged"] is True
    assert (normalization["substantive_before_digest"]
            == normalization["substantive_after_digest"])
    assert normalization["before_digest"] != normalization["after_digest"]
    assert normalization["changed_fields"] == [
        "policy_revision", "per_service.*.evidence_refs.0",
    ]


def test_host_validator_keeps_compatible_and_infrastructure_feedback_non_attributable():
    compatible = run.validate_release_draft(
        _validator_arguments(material=False), context=None)
    infrastructure = run.validate_release_draft(
        _validator_arguments(material=False, fault="infrastructure"), context=None)

    assert compatible["verdict"] == "compatible"
    assert "failure_domain" not in compatible["feedback"]
    assert infrastructure["verdict"] == "infrastructure"
    assert infrastructure["feedback"]["failure_domain"] == "infrastructure"


def test_host_validator_refuses_to_count_a_bad_base_draft_as_h1():
    bad = run._expected_review(run.BASE_POLICY)
    bad["per_service"][0]["passed"] = False
    result = run.validate_release_draft(
        _validator_arguments(material=True, draft=bad), context=None)

    assert result["verdict"] == "precondition_failure"
    assert result["base_passed"] is False
    assert "failure_domain" not in result["feedback"]


def test_route_blind_evaluator_boundary_passes_only_public_frozen_inputs():
    observed = {}

    def spy(condition_id, final_content, frozen_inputs):
        observed.update(condition_id=condition_id,
                        final_content=deepcopy(final_content),
                        frozen_inputs=deepcopy(frozen_inputs))
        return evaluate(condition_id, final_content, frozen_inputs)

    spec = run._condition_spec("D1C-SWITCH-PRIMARY")
    result = run._evaluate(
        spec["condition_id"], run._expected_review(run._policy_update(True)), spec,
        evaluator=spy)

    assert result["passed"] is True
    assert set(observed) == {"condition_id", "final_content", "frozen_inputs"}
    assert set(observed["frozen_inputs"]) == {
        "effective_policy", "service_reports", "evidence_refs",
    }
    encoded = run._canonical(observed["frozen_inputs"])
    for forbidden in (
            "strategy_start", "selector", "checkpoint", "backend",
            "component_id", "handoff", "route"):
        assert forbidden not in encoded.lower()


def test_offline_batch_exercises_all_frozen_conditions():
    result = run.offline_preflight()

    assert result["passed"] is True, result["checks"]
    assert result["external_model_called"] is False
    assert [row["condition"] for row in result["rows"]] == list(run.CONDITION_ORDER)
    assert all(row["quality"] for row in result["rows"])
    by_condition = {row["condition"]: row for row in result["rows"]}
    assert by_condition["D1C-SWITCH-PRIMARY"]["checkpoint_action"] == "switch"
    assert by_condition["D1C-SWITCH-RECOVERY"]["checkpoint_action"] == "switch"
    assert by_condition["D1C-NO-GAP"]["selector_receipt"] == 0
    assert by_condition["D1C-INFRA-CONTROL"]["selector_receipt"] == 0


class InvalidSelectorGateway(run.OfflineGatewayFactory):
    def __call__(self, reserve, stop_event):
        base = super().__call__(reserve, stop_event)
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                if role not in {"checkpoint_selector", "strategy_selector"}:
                    return base.ask(role, prompt, payload, max_tokens)
                number = len(owner.calls) + 1
                owner.calls.append({"role": role, "payload": deepcopy(payload)})
                receipt = {
                    "call_id": f"invalid-selector-{number}", "role": role,
                    "model": "D1C-OFFLINE-GATEWAY-DOUBLE", "status": "started",
                    "request_digest": run._sha_value(payload),
                    "reserved_completion_tokens": max_tokens,
                    "max_completion_tokens": max_tokens,
                }
                reserve(receipt)
                invalid = {"target_component_id": "unknown-entry", "reason": "invalid"}
                reserve({**receipt, "status": "completed",
                         "billing_status": "usage_reported",
                         "usage": {"prompt_tokens": 1, "completion_tokens": 1,
                                   "total_tokens": 2}})
                return invalid

        return Gateway()


def test_invalid_selector_has_no_fallback(tmp_path):
    gateway = InvalidSelectorGateway()
    service = run._service(tmp_path, gateway)
    spec = run._condition_spec("D1C-SWITCH-PRIMARY")
    episode = run._create_episode(service, run.framework_package(), spec)

    state = service.run(episode["id"], stop_event=threading.Event())

    assert state["status"] == "failed"
    assert "unknown component" in state["last_error"]
    assert "release_review.json" not in state["output_refs"]
    assert not [event for event in state["events"]
                if event["kind"] == "strategy_entered"
                and event["content"]["component_id"] == run.ENTRY_COMPONENT_ID]
    evidence = run._episode_evidence(
        service, spec["condition_id"], episode["id"], spec)
    selector_receipts = [row for row in evidence["model_receipts"]
                         if row["role"] == "checkpoint_selector"]
    assert len(selector_receipts) == 1
    assert selector_receipts[0]["status"] == "completed"
    assert len(evidence["selector_rpc_journals"]) == 1
    assert evidence["selector_rpc_journals"][0]["result"] == {
        "target_component_id": "unknown-entry", "reason": "invalid",
    }


def test_recovery_preserves_checkpoint_handoff_budget_and_deadline(tmp_path):
    gateway = run.OfflineGatewayFactory()
    package = run.framework_package()
    service = run._service(tmp_path, gateway)
    spec = run._condition_spec("D1C-SWITCH-RECOVERY")
    episode = run._create_episode(service, package, spec)

    service, final, recovery = run._run_recovery(
        tmp_path, gateway, episode["id"])

    assert final["status"] == "completed", final.get("last_error")
    assert recovery["passed"] is True, recovery["checks"]
    assert recovery["before"]["selector_call_ids"] == recovery["after"][
        "selector_call_ids"]
    evidence = run._episode_evidence(
        service, spec["condition_id"], episode["id"], spec, recovery=recovery)
    assert evidence["quality"]["passed"] is True
    assert evidence["old_pending_publisher_ran"] is False
    assert len(evidence["handoff_read_events"]) == 2


def test_cli_default_preflight_never_requires_a_model_project(monkeypatch):
    observed = {}

    def fake_preflight(args):
        observed["live"] = args.live
        observed["model_project"] = args.model_project
        return {"preflight": {"passed": True}, "manifest": {}}

    monkeypatch.setattr(run, "preflight", fake_preflight)

    assert run.main([]) == 0
    assert observed == {"live": False, "model_project": None}


def test_live_requires_explicit_model_project():
    with pytest.raises(SystemExit, match="--live requires --model-project"):
        run.main(["--live"])


def test_batch_capacity_is_strict_at_every_hard_cap():
    below = {key: value - 1 for key, value in run.BATCH_CAPS.items()}
    assert run._batch_has_capacity(below) is True
    assert run._batch_within_caps(below) is True
    for key, limit in run.BATCH_CAPS.items():
        at_cap = deepcopy(below)
        at_cap[key] = limit
        assert run._batch_has_capacity(at_cap) is False
        assert run._batch_within_caps(at_cap) is True


def test_identity_drift_stops_remaining_rows_without_more_provider_calls(tmp_path):
    gateway = run.OfflineGatewayFactory()

    def identity_checker(condition_id):
        return [] if condition_id == "D1C-SWITCH-PRIMARY" else ["evaluator"]

    rows = run.run_batch(
        tmp_path, gateway, identity_checker=identity_checker)

    assert len(rows) == 4
    assert rows[0]["status"] == "completed"
    assert len(gateway.calls) == 4
    assert all(row["status"] == "not_started" for row in rows[1:])
    assert all(row["failure"]["class"] == "identity_drift" for row in rows[1:])
    assert all(row["model_receipts"] == [] for row in rows[1:])


@pytest.mark.parametrize("mode", ["failed", "unknown"])
def test_raw_model_receipt_survives_failed_and_unknown_calls(tmp_path, mode):
    class ReceiptGatewayFactory:
        def __call__(self, reserve, stop_event):
            del stop_event

            class Gateway:
                def ask(self, role, prompt, payload=None, max_tokens=4000):
                    receipt = {
                        "call_id": f"receipt-{mode}", "role": role,
                        "model": "D1C-OFFLINE-FAILURE-DOUBLE", "status": "started",
                        "request_digest": run._sha_value({"prompt": prompt,
                                                          "payload": payload}),
                        "reserved_completion_tokens": max_tokens,
                    }
                    reserve(receipt)
                    if mode == "unknown":
                        raise KeyboardInterrupt("remote outcome intentionally unknown")
                    reserve({
                        **receipt, "status": "failed", "error_type": "ModelTransportError",
                        "transport_diagnostics": {"connection_phase": "unknown"},
                    })
                    raise RuntimeError("offline transport failure")

            return Gateway()

    service = run._service(tmp_path / mode, ReceiptGatewayFactory())
    spec = run._condition_spec("D1C-SWITCH-PRIMARY")
    episode = run._create_episode(service, run.framework_package(), spec)
    if mode == "unknown":
        with pytest.raises(KeyboardInterrupt, match="outcome intentionally unknown"):
            service.run(episode["id"], stop_event=threading.Event())
    else:
        service.run(episode["id"], stop_event=threading.Event())

    evidence = run._episode_evidence(
        service, spec["condition_id"], episode["id"], spec)

    assert len(evidence["model_receipts"]) == 1
    assert evidence["model_receipts"][0]["call_id"] == f"receipt-{mode}"
    assert evidence["model_receipts"][0]["status"] == mode.replace("unknown", "started")
    assert evidence["failure"]["remote_outcome_unknown"] is True
