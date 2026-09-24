"""Focused offline tests for the D1-B live probe harness."""

from argparse import Namespace
import json

import pytest

from . import run


def _positive_incident():
    return {
        "incident_id": "INC-204", "status": "monitoring",
        "impact": {"degraded": ["read_latency"], "unaffected": ["write_path"]},
        "timeline": [{"at": row["at"], "code": row["code"]}
                     for row in run.INCIDENT_INPUT["observations"]],
        "cause": "unknown",
        "correlation_under_investigation": "cache_configuration_rollout",
        "action": run.INCIDENT_INPUT["requested_action"],
        "next_update": "10:30 UTC",
        "brief": ("Read p95 latency rose above 2 seconds while the write path remained "
                  "within SLO. Read latency returned to its normal range; the cause is "
                  "unknown and cache_configuration_rollout remains under investigation."),
    }


def _positive_release():
    expected = run._release_expected({
        "release_policy.json": run.RELEASE_POLICY, **run.SERVICE_REPORTS})
    return {
        "per_service": [{
            "service": name, "checks": values[0], "passed": values[1],
            "blockers": values[2],
            "evidence_refs": ["release_policy.json", f"{name}_report.json"],
        } for name, values in expected.items()],
        "overall": "hold", "blocking_services": ["borealis", "cygnus"],
        "summary": "Hold: borealis is blocked by open_sev2 and cygnus by rollback_minutes.",
    }


def _model_project(tmp_path, secret="credential-value-must-not-leak"):
    (tmp_path / "models.json").write_text(json.dumps({
        "providers": {"mimo": {
            "api_key": "${NEXGENT_API_KEY}",
            "base_url": run.EXPECTED_ENDPOINT,
            "models": ["mimo-v2.5"],
        }},
        "defaults": {"main": "mimo/mimo-v2.5", "subagent": "mimo/mimo-v2.5"},
    }), encoding="utf-8")
    (tmp_path / ".env").write_text(
        f"NEXGENT_API_KEY={secret}\n", encoding="utf-8")
    return secret


def test_independent_evaluators_accept_frozen_answers_and_reject_critical_errors():
    incident_inputs = {"incident_notes.json": run.INCIDENT_INPUT}
    positive_incident = _positive_incident()
    assert run.evaluate_task("TASK-OL-01", incident_inputs, positive_incident)["passed"]
    bad_incident = {**positive_incident, "brief": (
        "Read latency degraded, writes were unaffected, and service recovered; "
        "cache_configuration_rollout was the confirmed root cause.")}
    incident_result = run.evaluate_task("TASK-OL-01", incident_inputs, bad_incident)
    assert not incident_result["passed"]
    assert not next(item for item in incident_result["items"]
                    if item["id"] == "OL-6")["passed"]

    release_inputs = {"release_policy.json": run.RELEASE_POLICY, **run.SERVICE_REPORTS}
    positive_release = _positive_release()
    assert run.evaluate_task("TASK-DAG-01", release_inputs, positive_release)["passed"]
    bad_release = {**positive_release, "overall": "approve"}
    release_result = run.evaluate_task("TASK-DAG-01", release_inputs, bad_release)
    assert not release_result["passed"]
    assert not next(item for item in release_result["items"]
                    if item["id"] == "DAG-5")["passed"]


def test_model_override_is_in_memory_and_identity_redacts_secret(tmp_path):
    secret = _model_project(tmp_path)
    profile, identity, profile_digest = run._load_profile(
        tmp_path, run.EXPECTED_MODEL)

    assert profile.model == run.EXPECTED_MODEL
    assert profile.api_key == secret
    serialized = json.dumps({"identity": identity, "digest": profile_digest})
    assert secret not in serialized
    assert identity["credential_ref"] == run.CREDENTIAL_REF
    assert identity["credential_source_profile_id"] == "mimo/mimo-v2.5"
    with pytest.raises(run.ModelConfigurationError):
        run._load_profile(tmp_path, "mimo-v2.5")


def test_preflight_never_calls_external_model(tmp_path, monkeypatch):
    _model_project(tmp_path)
    called = []

    def forbidden_request(*args, **kwargs):
        called.append((args, kwargs))
        raise AssertionError("external model call")

    monkeypatch.setattr(run.ModelGateway, "_request", forbidden_request)
    monkeypatch.setattr(run, "_deadline_runtime_preflight", lambda: {
        "passed": True, "checks": {}, "external_model_called": False})
    report = run.preflight(Namespace(
        model_project=tmp_path, model=run.EXPECTED_MODEL, run_root=None))

    assert report["passed"]
    assert report["external_model_called"] is False
    assert called == []
    assert "credential-value-must-not-leak" not in json.dumps(report)


def test_live_refuses_before_setup_when_deadline_integration_is_missing(
        tmp_path, monkeypatch):
    touched = []
    monkeypatch.setattr(run, "_deadline_runtime_preflight", lambda: {
        "passed": False, "checks": {"deadline": False},
        "external_model_called": False})
    monkeypatch.setattr(run, "_prepare_run_root", lambda value: touched.append(value))

    with pytest.raises(RuntimeError, match="wall-deadline integration"):
        run.live(Namespace(run_root=tmp_path))
    assert touched == []


def test_deadline_runtime_probe_is_local_and_integrated():
    result = run._deadline_runtime_preflight()
    assert result["external_model_called"] is False
    assert result["passed"], result["checks"]
