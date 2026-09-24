"""Capability/transport tests use scripted replies, never claim scientific RSI gains."""

from copy import deepcopy
import io
import json
import math
from pathlib import Path
import subprocess
import sys
from threading import Event, Lock, Timer
import time
from types import SimpleNamespace

import pytest

from nexgent.agents import ImprovementBroker, seed_files
from nexgent.agents.seed import WORKFLOW_SOURCE, META_SOURCE
from nexgent.kernel.programs import make_bundle
from nexgent.kernel.runner import ProgramRunner
from nexgent.models import (
    ModelBudgetError, ModelConfigurationError, ModelError, ModelGateway,
    ModelOutputFormatError,
)
from nexgent.models.worker import request_params, error_payload
from nexgent.research import LiteratureSearch


def configured(tmp_path, key="unit-test-secret", host="https://token-plan-cn.xiaomimimo.com/v1", model="mimo-v2.5"):
    (tmp_path / "models.json").write_text(json.dumps({"providers": {
        "test": {"base_url": host, "api_key": key, "models": {model: {}}}},
        "defaults": {"main": "test/" + model, "subagent": "test/" + model}}), encoding="utf-8")
    return tmp_path


class Replies:
    def __init__(self, content=None, reason="stop", callback=None):
        self.content = content if content is not None else '{"finding":"test reply"}'
        self.reason, self.callback, self.requests = reason, callback, []

    def __call__(self, profile, params):
        self.requests.append(params)
        if self.callback:
            self.callback()
        return {"content": self.content, "finish_reason": self.reason, "response_id": "test-response",
                "usage": {"prompt_tokens": 30, "completion_tokens": 40, "total_tokens": 70,
                          "completion_tokens_details": {"reasoning_tokens": 0},
                          "prompt_tokens_details": {"cached_tokens": 12}}}


def test_gateway_reserves_before_transport_and_persists_actual_usage(tmp_path):
    replies, records = Replies(), []
    def reserve(receipt):
        if receipt["status"] == "started":
            assert replies.requests == []
        records.append(receipt)
        (tmp_path / "receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
    gateway = ModelGateway(configured(tmp_path), reserve=reserve, transport=replies)
    assert gateway.ask("a_source_defined_role", "Return findings", {}, max_tokens=3000) == {"finding": "test reply"}
    final = json.loads((tmp_path / "receipt.json").read_text(encoding="utf-8"))
    assert [r["status"] for r in records] == ["started", "received"]
    assert records[0]["call_id"] == final["call_id"]
    assert final["usage"]["total_tokens"] == 70 and final["reserved_completion_tokens"] == 3000
    assert final["finish_reason"] == "stop" and final["billing_status"] == "usage_reported"
    assert final["request_options"]["extra_body"] == {"thinking": {"type": "disabled"}}
    assert gateway.timeout == final["request_wall_timeout_seconds"] == 180
    assert "unit-test-secret" not in json.dumps(records)


def test_missing_auth_and_budget_rejection_do_not_send_requests(tmp_path):
    replies, receipts = Replies(), []
    gateway = ModelGateway(configured(tmp_path, key=""), reserve=receipts.append, transport=replies)
    with pytest.raises(ModelConfigurationError, match="Missing API key"):
        gateway.ask("reviewer", "Review", {})
    assert not receipts and not replies.requests
    denial = RuntimeError("Reservation budget exhausted")
    def refuse(receipt):
        raise denial
    gateway = ModelGateway(configured(tmp_path), reserve=refuse, transport=replies)
    with pytest.raises(RuntimeError) as caught:
        gateway.ask("reviewer", "Review", {})
    assert caught.value is denial and not replies.requests


def test_dotenv_reference_is_resolved_without_global_environment_mutation(tmp_path, monkeypatch):
    monkeypatch.delenv("NEXGENT_TEST_CREDENTIAL", raising=False)
    (tmp_path / ".env").write_text('NEXGENT_TEST_CREDENTIAL="dotenv-test-secret"\n', encoding="utf-8")
    gateway = ModelGateway(configured(tmp_path, key="${NEXGENT_TEST_CREDENTIAL}"), reserve=lambda r: None, transport=Replies())
    assert gateway.preflight()["configured"]
    import os
    assert "NEXGENT_TEST_CREDENTIAL" not in os.environ


@pytest.mark.parametrize("content", ['{"partial":', 'null', '{"value":NaN}', '{"v":1,"v":2}'])
def test_invalid_model_json_is_recorded_without_retry(tmp_path, content):
    replies, receipts = Replies(content), []
    gateway = ModelGateway(configured(tmp_path), reserve=receipts.append, transport=replies)
    with pytest.raises(ModelError):
        gateway.ask("analyst", "Analyze", {})
    assert len(replies.requests) == 1
    assert receipts[-1]["status"] == "invalid" and receipts[-1]["usage"]["total_tokens"] == 70


def test_complete_object_with_trailing_text_is_typed_but_still_rejected(tmp_path):
    replies, receipts = Replies('{"finding":"kept"}\nparameter'), []
    gateway = ModelGateway(
        configured(tmp_path), reserve=receipts.append, transport=replies)

    with pytest.raises(ModelOutputFormatError) as caught:
        gateway.ask("analyst", "Analyze", {})

    assert caught.value.code == "extra_data_after_complete_object"
    assert caught.value.candidate == {"finding": "kept"}
    assert len(replies.requests) == 1
    assert receipts[-1]["status"] == "invalid"
    assert receipts[-1]["format_error_code"] == (
        "extra_data_after_complete_object")


def test_length_and_stop_after_billable_response_keep_usage(tmp_path):
    replies, receipts = Replies('{"unfinished":', reason="length"), []
    gateway = ModelGateway(configured(tmp_path), reserve=receipts.append, transport=replies)
    with pytest.raises(ModelBudgetError, match="finish_reason=length"):
        gateway.ask("author", "Write", {}, max_tokens=5000)
    assert receipts[-1]["status"] == "token_budget_exhausted"
    assert receipts[-1]["usage"]["completion_tokens"] == 40
    stop = Event()
    gateway = ModelGateway(tmp_path, reserve=receipts.append, transport=Replies(callback=stop.set), stop_event=stop)
    with pytest.raises(InterruptedError):
        gateway.ask("author", "Write", {})
    assert receipts[-1]["status"] == "interrupted" and receipts[-1]["usage"]["total_tokens"] == 70


@pytest.mark.parametrize("host,model", [
    ("https://api.openai.com/v1", "mimo-v2.5"),
    ("https://api.xiaomimimo.com.evil.test/v1", "mimo-v2.5"),
    ("https://api.xiaomimimo.com/v1", "another-model"),
])
def test_provider_specific_options_do_not_pollute_other_models(host, model):
    assert "extra_body" not in request_params(host, model, [], 1000)


def test_mimo_26_flash_uses_verified_non_thinking_json_budget():
    params = request_params("https://api.xiaomimimo.com/v1",
                            "mimo-v2.6-flash", [], 6000)
    assert params["extra_body"] == {"thinking": {"type": "disabled"}}


@pytest.mark.parametrize("stop_requested", [False, True])
def test_actual_provider_worker_process_is_stopped_with_bounded_wait(tmp_path, monkeypatch, stop_requested):
    popen, children = subprocess.Popen, []
    def launch(command, **kwargs):
        assert command[-2:] == ["-m", "nexgent.models.worker"]
        assert "unit-test-secret" not in " ".join(command)
        child = popen([sys.executable, "-c", "import sys,time; sys.stdin.read(); time.sleep(30)"], **kwargs)
        children.append(child)
        return child
    monkeypatch.setattr("nexgent.models.gateway.subprocess.Popen", launch)
    stop, receipts = Event(), []
    gateway = ModelGateway(configured(tmp_path), reserve=receipts.append, stop_event=stop,
                           timeout=180 if stop_requested else .25)
    timer = Timer(.15, stop.set) if stop_requested else None
    if timer:
        timer.start()
    started = time.monotonic()
    try:
        with pytest.raises(InterruptedError if stop_requested else ModelError):
            gateway.ask("writer", "Write", {})
    finally:
        if timer:
            timer.cancel()
    assert time.monotonic() - started < 4
    assert len(children) == 1 and children[0].poll() is not None
    assert receipts[-1]["billing_status"] == "unknown" and receipts[-1]["usage"] == {}
    if not stop_requested:
        assert receipts[-1]["transport_diagnostics"]["cause_types"] == ["WorkerWallTimeout"]


@pytest.mark.parametrize("timeout", [True, 0, -1, 180.001, float("nan"), float("inf")])
def test_model_wall_timeout_has_explicit_180_second_upper_bound(tmp_path, timeout):
    with pytest.raises(ValueError, match="180"):
        ModelGateway(tmp_path, reserve=lambda receipt: None, timeout=timeout)


def test_worker_receives_180_second_bound_and_disables_sdk_retries(monkeypatch, capsys):
    from nexgent.models import worker
    parameters = []
    class Client:
        def __init__(self, **kwargs):
            parameters.append(kwargs)
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))
        def create(self, **kwargs):
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{"ok":true}'), finish_reason="stop")],
                                   usage={"total_tokens": 1}, id="test",
                                   model="mimo-v2.5-202609", system_fingerprint="revision-42")
        def close(self):
            pass
    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=Client))
    params = request_params("https://api.xiaomimimo.com/v1", "mimo-v2.5", [], 6000)
    request = {"api_key": "worker-secret", "base_url": "https://api.xiaomimimo.com/v1", "timeout": 180, "request_params": params}
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(request)))
    assert worker.main() == 0
    assert parameters[0]["timeout"] == 180 and parameters[0]["max_retries"] == 0
    output = capsys.readouterr().out
    payload = json.loads(output)
    assert payload["content"] == '{"ok":true}' and "worker-secret" not in output
    assert payload["observed_model"] == "mimo-v2.5-202609"
    assert payload["system_fingerprint"] == "revision-42"


def test_transport_diagnostics_include_cause_phase_and_never_exception_text():
    class APIConnectionError(Exception):
        pass
    class ConnectError(Exception):
        pass
    outer = APIConnectionError("Authorization: Bearer never-emit-key")
    middle = ConnectError("https://provider.test/?api_key=never-emit-key")
    outer.__cause__ = middle
    payload = error_payload(outer, "request")
    encoded = json.dumps(payload)
    assert payload["diagnostics"]["cause_types"] == ["APIConnectionError", "ConnectError"]
    assert payload["diagnostics"]["connection_phase"] == "connect"
    assert "never-emit-key" not in encoded and "https://" not in encoded and "Authorization" not in encoded


def test_worker_connection_failure_diagnostics_survive_gateway_receipt(tmp_path, monkeypatch):
    from nexgent.models.gateway import ModelTransportError
    payload = {"error_type": "APIConnectionError", "diagnostics": {
        "cause_types": ["APIConnectionError", "ReadTimeout"], "stage": "request", "connection_phase": "response_read",
        "http_status": None, "errno": None, "secret_header": "must-not-appear"}}
    popen = subprocess.Popen
    def launch(command, **kwargs):
        script = "import sys; sys.stdin.read(); print(" + repr(json.dumps(payload)) + "); sys.exit(1)"
        return popen([sys.executable, "-c", script], **kwargs)
    monkeypatch.setattr("nexgent.models.gateway.subprocess.Popen", launch)
    records = []
    gateway = ModelGateway(configured(tmp_path), reserve=records.append)
    with pytest.raises(ModelTransportError, match="response_read"):
        gateway.ask("writer", "Return JSON", {})
    assert records[-1]["transport_diagnostics"]["cause_types"] == ["APIConnectionError", "ReadTimeout"]
    assert records[-1]["billing_status"] == "unknown"
    assert "must-not-appear" not in json.dumps(records)


def test_broker_records_agent_logs_without_allowing_host_event_forgery():
    events = []
    broker = ImprovementBroker(None, parent_files={}, experiment=None,
        event=lambda kind, content: events.append((kind, content)), source_bundle="agent-source")
    broker.handle("log", {"kind": "promotion", "content": {"verified": True}})
    assert [kind for kind, content in events] == ["capability", "agent_log", "capability"]
    log = events[1][1]
    assert log["claimed_kind"] == "promotion" and log["source"] == "agent"
    assert log["source_bundle"] == "agent-source"


def test_broker_experiment_inherits_files_and_never_returns_non_development():
    captured = []
    def experiment(files, label):
        captured.append((files, label))
        return {"split": "development", "score": .2}
    broker = ImprovementBroker(None, parent_files={"task.py": "old", "meta.py": "kept"}, experiment=experiment)
    assert broker.handle("experiment", {"files": {"task.py": "new"}, "label": "hypothesis"})["score"] == .2
    assert captured[0][0] == {"task.py": "new", "meta.py": "kept"}
    broker.experiment = lambda files, label: {"split": "audit", "score": .9}
    with pytest.raises(ValueError, match="development-only"):
        broker.handle("experiment", {"files": {}, "label": "rejected"})


def test_parallel_budget_admission_is_serial_and_all_started_calls_finish(tmp_path):
    calls, records, lock = [], {}, Lock()
    denied = RuntimeError("Only two calls authorized")
    def reserve(receipt):
        if receipt["status"] == "started":
            if len(records) >= 2:
                raise denied
            records[receipt["call_id"]] = receipt
        else:
            records[receipt["call_id"]] = receipt
    def transport(profile, params):
        with lock:
            calls.append(params)
        return Replies()(profile, params)
    gateway = ModelGateway(configured(tmp_path), reserve=reserve, transport=transport)
    broker = ImprovementBroker(gateway, parent_files={}, experiment=None)
    requests = [{"role": "role-" + str(i), "prompt": "Return JSON", "payload": {}} for i in range(3)]
    with pytest.raises(RuntimeError) as error:
        broker.handle("parallel", {"requests": requests})
    assert error.value is denied and len(calls) == 2
    assert len(records) == 2 and all(record["status"] == "received" for record in records.values())


def test_primary_literature_records_exact_evidence_level_and_retrieval_failure():
    atom = b'''<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2603.19461v1</id>
    <title>A primary study</title><summary>Observed algorithm.</summary><author><name>A. Author</name></author>
    <published>2026-03-20</published></entry></feed>'''
    urls = []
    def fetch(url):
        urls.append(url)
        return atom if "/api/query?" in url else b"<html><script>ignore-me</script><p>Method and results text</p></html>"
    search = LiteratureSearch(fetch=fetch)
    result = search.search('symbolic systems &"http://untrusted.test"')
    assert len(urls) == 2 and urls[0].startswith("https://export.arxiv.org/api/query?")
    paper = result["papers"][0]
    assert paper["url"] == "https://arxiv.org/abs/2603.19461v1"
    assert paper["full_text_excerpt"] == "Method and results text"
    assert paper["evidence_level"] == "primary_full_text_excerpt" and not paper["full_text_read"]
    assert search.search(result["query"])["cache_hit"] and len(urls) == 2
    def fail(url):
        raise TimeoutError("network")
    failed = LiteratureSearch(fetch=fail).search("dynamics")
    assert failed["status"] == "failed" and failed["papers"] == []


def test_source_defined_workflow_executes_and_successor_changes_orchestration():
    task = {"task.py": "def solve(problem, tools):\n    return {}\n"}
    original = make_bundle(seed_files(task))
    events, calls = [], []
    class Gateway:
        def ask(self, **params):
            calls.append(params)
            if params["role"] == "main":
                return {"candidates": [{"files": {"task.py": "def solve(problem, tools):\n    return {'changed': True}\n"},
                         "rationale": "protocol check only", "hypothesis": "source execution observation",
                         "code_evidence": [{"file": "task.py", "new_code": "return {'changed': True}",
                                            "mechanism": "Scripted source protocol change"}]}], "research": {}}
            return {"finding": "scripted protocol observation"}
    broker = ImprovementBroker(Gateway(), parent_files=original["files"],
        experiment=lambda files, label: {"split": "development", "status": "ok", "score": .1},
        search=lambda query: {"status": "no_results", "papers": []},
        event=lambda kind, content: events.append((kind, content)))
    context = {"parent": original, "roles": json.loads(original["files"]["roles.json"]),
               "editable_components": ["task.py"]}
    runner = ProgramRunner()
    first = runner.run(original, "improve", context, handler=broker.handle, timeout=15)
    assert len(calls) == 3 and first["value"]["research"]["development_experiments"]
    assert all(call["payload"]["editable_components"] == ["task.py"] for call in calls)
    assert calls[-1]["max_tokens"] == 6000
    assert first["execution"]["source_digest"] == original["digest"]
    replacement = 'def improve(context, broker):\n    answer = broker.ask("new_specialist", "Run a different research program", {})\n    return {"candidates": [], "research": answer}\n'
    successor = make_bundle({"meta.py": replacement}, parent=original)
    calls.clear()
    second = runner.run(successor, "improve", context, handler=broker.handle, timeout=15)
    assert [call["role"] for call in calls] == ["new_specialist"]
    assert second["execution"]["source_digest"] == successor["digest"] != original["digest"]
    assert second["value"]["research"] == {"finding": "scripted protocol observation"}


def source_design(answer, include_unchanged=False, anchor=None):
    files = {"task.py": f"def solve(problem, tools):\n    return {{'answer': {answer}}}\n"}
    if include_unchanged:
        files["meta.py"] = seed_files({"task.py": "def solve(problem, tools):\n    return {'answer': 0}\n"})["meta.py"]
    return {"candidates": [{"files": files, "rationale": "Scripted protocol experiment only",
             "hypothesis": "The executed source returns the selected fixture value",
             "code_evidence": [{"file": "task.py", "new_code": anchor or f"return {{'answer': {answer}}}",
                                "mechanism": "Explicit changed source anchor"}]}], "research": {}}


def run_repair_fixture(designs, experiment_reports=None, budget=None):
    """Run actual improve source and, by default, actual candidate solve processes."""
    original = make_bundle(seed_files({"task.py": "def solve(problem, tools):\n    return {'answer': 0}\n"}))
    calls, experiments, events = [], [], []
    pending = list(designs)
    runner = ProgramRunner()
    class Gateway:
        def ask(self, **params):
            calls.append(deepcopy(params))
            if params["role"] == "main":
                assert pending, "The seed made an unauthorized extra design/repair call"
                return pending.pop(0)
            return {"observations": ["Scripted fixture; no scientific claim"]}
    def experiment(files, label):
        result = runner.run(make_bundle(files), "solve_batch", {"problems": [{}]}, timeout=10)
        measured = {"split": "development", "status": "ok", "score_available": True,
                    "score": result["value"][0]["submission"]["answer"] / 10,
                    "work_units": 10, "tasks": [{"status": "ok"}], "execution": result["execution"]}
        if experiment_reports is not None:
            measured.update(experiment_reports[len(experiments)])
        experiments.append({"files": files, "label": label, "report": measured})
        return measured
    broker = ImprovementBroker(Gateway(), parent_files=original["files"], experiment=experiment,
        search=lambda query: {"status": "no_results", "papers": []},
        event=lambda kind, content: events.append((kind, content)))
    context = {"parent": original, "roles": json.loads(original["files"]["roles.json"]),
               "editable_components": ["task.py"],
               "development": {"status": "ok", "score": .4, "work_units": 10},
               "budget": budget if budget is not None else {"remaining_calls": 4, "remaining_completion_tokens": 16400,
                                                          "max_work_units_per_evaluation": 20000000}}
    result = runner.run(original, "improve", context, handler=broker.handle, timeout=20)
    return result["value"], calls, experiments, original, events


@pytest.mark.parametrize("failure", [
    {"status": "budget_exhausted", "score_available": False, "score": None, "work_units": 20000000},
    {"status": "ok", "tasks": [{"status": "ok"}, {"status": "budget_exhausted"}]},
    {"status": "partial_failure", "tasks": [{"status": "failed", "error": "NumericalFailure"}]},
    {"status": "ok", "score": .4, "work_units": 15},
    {"status": "ok", "score": .9, "error": "Inconsistent report: measurement was incomplete"},
])
def test_seed_repairs_from_actual_status_task_failures_and_cost_once(failure):
    value, calls, experiments, original, events = run_repair_fixture(
        [source_design(5), source_design(8)], [failure, {}])
    assert len(calls) == 4 and sum(call["max_tokens"] for call in calls) == 16400
    assert len(experiments) == 2
    assert experiments[0]["report"]["execution"]["source_digest"] != experiments[1]["report"]["execution"]["source_digest"]
    repair = calls[-1]["payload"]
    assert repair["phase"] == "targeted_source_repair"
    assert repair["actual_development_report"] == experiments[0]["report"]
    assert repair["parent"]["files"] == original["files"]
    assert repair["budget"]["remaining_calls"] == 1 and repair["budget"]["remaining_completion_tokens"] == 6000
    assert value["candidates"][0]["files"] == source_design(8)["candidates"][0]["files"]
    assert value["research"]["repair"]["status"] == "evaluated"
    assert value["research"]["selected_development"]["score"] == .8


def test_seed_noop_claim_triggers_real_change_and_omits_unchanged_files():
    value, calls, experiments, original, events = run_repair_fixture(
        [source_design(0, include_unchanged=True), source_design(7, include_unchanged=True)])
    assert len(calls) == 4 and len(experiments) == 1
    check = value["research"]["source_checks"][0]["check"]
    assert check["changed_files"] == []
    assert any("no_source_changes" in issue for issue in check["issues"])
    assert "meta.py" in check["unchanged_files_omitted"]
    assert set(value["candidates"][0]["files"]) == {"task.py"}
    assert value["research"]["selected_development"]["score"] == .7
    assert "semantic" in check["verification_scope"]


def test_seed_repeated_noop_is_rejected_without_fake_experiment_or_extra_call():
    value, calls, experiments, original, events = run_repair_fixture([source_design(0), source_design(0)])
    assert len(calls) == 4 and experiments == [] and value["candidates"] == []
    assert value["research"]["repair"]["status"] == "invalid_repair"
    assert value["research"]["selected_development"] == {}


def test_seed_repeating_failed_candidate_is_not_counted_as_a_repair():
    value, calls, experiments, original, events = run_repair_fixture(
        [source_design(3), source_design(3)])
    assert len(calls) == 4 and len(experiments) == 1
    assert value["research"]["repair"]["status"] == "repair_noop"
    assert value["research"]["selected_development"]["score"] == .3


def test_seed_false_code_anchor_is_feedback_and_corrected_before_experiment():
    value, calls, experiments, original, events = run_repair_fixture(
        [source_design(6, anchor="return {'algorithm': 'never implemented'}"), source_design(6)])
    assert len(calls) == 4 and len(experiments) == 1
    assert value["research"]["source_checks"][0]["check"]["anchors"][0]["lexically_valid"] is False
    assert value["research"]["source_checks"][1]["check"]["anchors"][0]["lexically_valid"] is True
    assert value["research"]["selected_development"]["score"] == .6


def test_seed_preserves_better_measured_candidate_when_repair_regresses():
    value, calls, experiments, original, events = run_repair_fixture(
        [source_design(5), source_design(4)], [{"work_units": 19000000}, {}])
    assert len(experiments) == 2 and len(calls) == 4
    assert value["candidates"][0]["files"] == source_design(5)["candidates"][0]["files"]
    assert value["research"]["selected_development"]["score"] == .5


@pytest.mark.parametrize("budget,expected_calls", [
    ({"remaining_calls": 3, "remaining_completion_tokens": 16400}, 3),
    ({"remaining_calls": 4, "remaining_completion_tokens": 10400}, 3),
    ({"remaining_calls": 2, "remaining_completion_tokens": 16400}, 0),
    ({"remaining_calls": 4, "remaining_completion_tokens": 10399}, 0),
])
def test_seed_respects_initial_and_reserved_repair_budget(budget, expected_calls):
    value, calls, experiments, original, events = run_repair_fixture([source_design(2)], budget=budget)
    assert len(calls) == expected_calls
    assert value["research"]["repair"]["status"] == (
        "insufficient_reserved_budget" if expected_calls else "insufficient_initial_budget")
    assert value["research"]["budget_plan"]["repair_reserved"] is False


def test_seed_parent_selector_can_explore_unexpanded_missing_score_program():
    original = make_bundle(seed_files({"task.py": "def solve(problem, tools):\n    return {}\n"}))
    result = ProgramRunner().run(original, "select_parent", [
        {"id": "measured-expanded", "score": .8, "children": 4},
        {"id": "unexpanded-missing", "score": None, "score_available": False, "children": 0}], timeout=10)
    assert result["value"] == "unexpanded-missing"
    assert result["execution"]["source_digest"] == original["digest"]


def seed_namespace():
    """Execute the actual editable source with a scripted capability surface."""
    namespace = {"math": math}
    exec(WORKFLOW_SOURCE, namespace)
    exec(META_SOURCE, namespace)
    return namespace


def meta_design(role="changed_writer"):
    source = ('def improve(context, broker):\n'
              f'    return broker.ask("{role}", "Generate one task source candidate", '
              '{"parent": context["parent"], "domain": context.get("domain", {})}, max_tokens=6000)\n')
    return {"candidates": [{"files": {"meta.py": source}, "rationale": "Fixture changes the actual model delegation",
        "hypothesis": "A distinct role actually generates the task offspring",
        "code_evidence": [{"file": "meta.py", "new_code": f'broker.ask("{role}"',
                           "mechanism": "Actual changed source-defined dispatch"}]}], "research": {"falsification": "No changed dispatch in execution"}}


def probe_report(gain=.1, status="completed", reason=None):
    report = {"schema": "nexgent-improver-probe-v1", "probe_id": "fixture-probe", "split": "development",
        "status": status, "arms": [{"arm": name, "status": "complete", "development_gain": value, "attempts": [
            {"execution": {"source_digest": name, "entry": "improve"}}]} for name, value in [("initial", .2), ("evolved", .2 + (gain or 0))]],
        "aggregate": {"paired_development_gain": gain}, "costs": {"model_calls": 4}}
    if reason:
        report["reason"] = reason
    return report


def run_meta_fixture(designs, report=None, budget=None, overrides=None):
    original = make_bundle(seed_files({"task.py": "def solve(problem, tools):\n    return {'answer': 0}\n"}))
    context = {"parent": original, "roles": json.loads(original["files"]["roles.json"]),
        "domain": {"id": "fixture_domain", "title": "Fixture contract"}, "task_contract": {"score_direction": "maximize"},
        "tool_api": "Fixture task capability contract", "runtime_contract": "Fixture source protocol",
        "literature": [{"url": "https://example.test/registered-prior", "evidence_level": "fixture"}],
        "capabilities": {"probe_improver": True}, "editable_components": ["task.py", "meta.py", "workflow.py", "roles.json"],
        "development": {"status": "ok", "score": .4, "score_available": True},
        "failures": [{"kind": "measured_counterexample", "candidate_id": original["id"], "decision": {"delta": 0}}],
        "budget": budget if budget is not None else {"remaining_calls": 18, "remaining_completion_tokens": 90000}}
    context.update(overrides or {})
    calls, probes, experiments, logs = [], [], [], []
    pending = list(designs)
    class Broker:
        def ask(self, role, prompt, payload, max_tokens=6000):
            calls.append({"role": role, "prompt": prompt, "payload": deepcopy(payload), "max_tokens": max_tokens})
            if role == "main":
                assert pending, "Unexpected extra paid design/repair attempt"
                response = pending.pop(0)
                if isinstance(response, Exception):
                    raise response
                return response
            return {"observations": ["Fixture evidence only"]}
        def parallel(self, requests):
            return [self.ask(**request) for request in requests]
        def search(self, query):
            return {"status": "no_results", "query": query, "papers": []}
        def experiment(self, files, label):
            experiments.append((deepcopy(files), label))
            return {"status": "ok", "split": "development", "score": .9, "score_available": True}
        def probe_improver(self, files, label):
            probes.append((deepcopy(files), label))
            if isinstance(report, Exception):
                raise report
            return deepcopy(report if report is not None else probe_report())
        def log(self, kind, content):
            logs.append((kind, deepcopy(content)))
    result = seed_namespace()["improve"](context, Broker())
    return result, calls, probes, experiments, context, logs


def test_seed_requires_registered_task_seed_and_contains_no_domain_algorithm():
    with pytest.raises(ValueError, match="registered domain"):
        seed_files()
    source = Path(__import__("nexgent.agents.seed", fromlist=["seed_files"]).__file__).read_text(encoding="utf-8")
    for forbidden in ["from ..science", "SINDy", "dynamics", "8 development", "12 transfer", "numerical_budget"]:
        assert forbidden not in source


@pytest.mark.parametrize("domain", [
    {"id": "sequence_ordering", "title": "Ordering", "description": "Recover a valid sequence", "research_context": "Partial orders"},
    {"id": "text_rewriting", "title": "Text", "description": "Revise a document", "research_context": "Edit constraints"},
])
def test_same_seed_passes_registered_domain_contract_and_priors_to_task_research(domain):
    contract, tools = {"entry": "solve", "output": "adapter-defined"}, "tools supplied by this adapter"
    result, calls, probes, experiments, context, logs = run_meta_fixture([source_design(7)], overrides={
        "domain": domain, "task_contract": contract, "tool_api": tools,
        "capabilities": {"probe_improver": False}, "editable_components": ["task.py"]})
    assert len(calls) == 3 and len(experiments) == 1 and probes == []
    for call in calls:
        assert call["payload"]["domain"] == domain and call["payload"]["task_contract"] == contract
        assert call["payload"]["tool_api"] == tools
        assert call["payload"]["literature"]["registered"] == context["literature"]
    assert set(result["candidates"][0]["files"]) == {"task.py"}


def test_comment_audit_preserves_strings_and_indentation_while_rejecting_cosmetic_revision():
    audit = seed_namespace()["source_without_comments"]
    source = "def f():\n    # old explanation\n    return '#literal'\n"
    assert audit(source) == audit(source.replace("old explanation", "claimed novel mechanism"))
    assert audit(source) == audit(source.replace("    # old explanation\n", ""))
    assert audit(source) != audit(source.replace("#literal", "#different literal"))
    assert audit('value = """a\n\n# literal\nb"""\n') != audit('value = """a\n# literal\nb"""\n')
    assert audit("if True:\n    a = 1\n    b = 2\n") != audit("if True:\n    a = 1\nb = 2\n")


def test_comment_only_task_repair_keeps_prior_measurement_and_avoids_another_experiment():
    repeated = source_design(3)
    repeated["candidates"][0]["files"]["task.py"] = "# This fixes the algorithm (unsupported claim)\n" + repeated["candidates"][0]["files"]["task.py"]
    value, calls, experiments, original, events = run_repair_fixture([source_design(3), repeated])
    assert len(calls) == 4 and len(experiments) == 1
    assert value["research"]["repair"]["status"] == "repair_noop"
    assert value["research"]["revisions"][0]["difference_from_tested"]["comments_only_or_identical"]


def test_meta_trigger_requires_capability_and_source_linked_or_registered_public_evidence():
    trigger = seed_namespace()["meta_research_trigger"]
    context = {"capabilities": {"probe_improver": True}, "editable_components": ["meta.py"],
               "parent": {"id": "current"}, "failures": [{"kind": "counterexample", "candidate_id": "unrelated"}]}
    assert trigger(context) == []
    context["prior_research"] = {"study_id": "public-prior", "scope": "development_and_selection_only", "artifact": "evidence"}
    assert trigger(context)[0]["kind"] == "registered_prior_research_problem"
    context["capabilities"]["probe_improver"] = False
    assert trigger(context) == []
    context["capabilities"]["probe_improver"] = True
    context["editable_components"] = ["task.py"]
    assert trigger(context) == []


def test_meta_trigger_accepts_explicit_null_prior_from_new_study_context():
    trigger = seed_namespace()["meta_research_trigger"]
    context = {"capabilities": {"probe_improver": True}, "editable_components": ["meta.py"],
               "parent": {"id": "current"}, "prior_research": None, "failures": []}
    assert trigger(context) == []
    context["failures"] = [{"kind": "counterexample", "candidate_id": "current"}]
    assert trigger(context)[0]["kind"] == "source_linked_failure"


def test_meta_research_probes_actual_proposed_source_once_and_records_provisional_evidence():
    result, calls, probes, experiments, context, logs = run_meta_fixture([meta_design()])
    assert len(calls) == 3 and len(probes) == 1 and experiments == []
    assert probes[0][0] == meta_design()["candidates"][0]["files"]
    assert all(call["payload"]["editable_components"] == ["meta.py"] for call in calls)
    assert result["candidates"][0]["evidence_status"] == "development_supported"
    assert result["candidates"][0]["probe_id"] == "fixture-probe"
    assert result["research"]["probes"][0] == probe_report()
    assert "transfer" in result["research"]["probe_interpretation"]["scope"]


def test_meta_negative_actual_probe_informs_single_unverified_source_repair():
    actual = probe_report(gain=-.15)
    result, calls, probes, experiments, context, logs = run_meta_fixture([meta_design(), meta_design("revised_writer")], report=actual)
    assert len(calls) == 4 and sum(call["max_tokens"] for call in calls) == 16400 and len(probes) == 1
    assert calls[-1]["payload"]["actual_probe"] == actual
    assert calls[-1]["payload"]["previous_candidate"]["files"] == probes[0][0]
    selected = result["candidates"][0]
    assert selected["files"] == meta_design("revised_writer")["candidates"][0]["files"]
    assert selected["evidence_status"] == "unverified" and selected["needs_probe"]
    assert selected["based_on_probe_id"] == "fixture-probe" and "probe_id" not in selected
    assert result["research"]["repair"]["status"] == "unverified_revision_after_probe"


def test_meta_comments_only_repair_preserves_negative_evidence_without_false_retest():
    revision = meta_design()
    revision["candidates"][0]["files"]["meta.py"] = "# Claimed new mechanism\n" + revision["candidates"][0]["files"]["meta.py"]
    result, calls, probes, experiments, context, logs = run_meta_fixture([meta_design(), revision], report=probe_report(gain=0))
    assert len(probes) == 1 and len(calls) == 4
    assert result["candidates"][0]["evidence_status"] == "unproven"
    assert result["candidates"][0]["files"] == meta_design()["candidates"][0]["files"]
    assert result["research"]["repair"]["status"] == "invalid_or_noop_repair"


@pytest.mark.parametrize("report", [
    {"schema": "nexgent-improver-probe-v1", "status": "incomplete", "reason": "insufficient_budget", "arms": [], "aggregate": {}},
    {"schema": "nexgent-improver-probe-v1", "status": "skipped_identical_improver", "arms": [], "aggregate": {}},
])
def test_meta_probe_skip_has_no_invented_gain_or_followup_model_retry(report):
    result, calls, probes, experiments, context, logs = run_meta_fixture([meta_design()], report=report)
    assert len(calls) == 3 and len(probes) == 1
    assert result["candidates"][0]["evidence_status"] == "unproven"
    assert result["research"]["probes"][0]["aggregate"] == {}


def test_meta_negative_probe_without_repair_reservation_returns_unproven_research_branch():
    result, calls, probes, experiments, context, logs = run_meta_fixture([meta_design()], report=probe_report(gain=-.1),
        budget={"remaining_calls": 15, "remaining_completion_tokens": 70400})
    assert len(calls) == 3 and len(probes) == 1
    assert result["candidates"][0]["evidence_status"] == "unproven"
    assert not result["research"]["budget_plan"]["repair_reserved"]


def test_meta_insufficient_whole_pair_budget_falls_back_before_design_or_probe():
    result, calls, probes, experiments, context, logs = run_meta_fixture([source_design(7)],
        budget={"remaining_calls": 14, "remaining_completion_tokens": 70400})
    assert len(calls) == 3 and not probes and len(experiments) == 1
    assert result["research"]["meta_research_skipped"]["status"] == "insufficient_budget_for_paired_probe"


def test_meta_invalid_design_may_use_one_repair_before_probe_but_never_another_after():
    result, calls, probes, experiments, context, logs = run_meta_fixture([source_design(7), meta_design()], report=probe_report(gain=-.1))
    assert len(calls) == 4 and len(probes) == 1
    assert calls[-1]["payload"]["phase"] == "meta_source_repair_before_probe"
    assert result["research"]["repair"]["status"] == "used_before_probe"
    assert result["candidates"][0]["evidence_status"] == "unproven"


def test_meta_probe_transport_failure_is_missing_not_a_measured_zero_or_retry():
    result, calls, probes, experiments, context, logs = run_meta_fixture([meta_design()], report=RuntimeError("worker stopped"),
        budget={"remaining_calls": 15, "remaining_completion_tokens": 70400})
    assert len(probes) == 1 and len(calls) == 3
    assert result["research"]["probes"][0]["status"] == "incomplete"
    assert result["research"]["probes"][0]["aggregate"] == {}
    assert result["candidates"][0]["evidence_status"] == "unproven"


def test_real_source_outer_probe_runs_two_actual_improvers_and_inherits_changed_dispatch():
    """Local source processes and real measurements; model replies alone are scripted."""
    from nexgent.evolution.meta_evaluation import evaluate_improver_probe
    original = make_bundle(seed_files({"task.py": "def solve(problem, tools):\n    return {'answer': 0}\n"}))
    runner = ProgramRunner()
    outer_calls, inner_calls, probe_records, inner_executions = [], [], [], []
    class OuterGateway:
        def ask(self, **request):
            outer_calls.append(deepcopy(request))
            return meta_design() if request["role"] == "main" else {"observations": ["Fixture dispatch hypothesis"]}
    def evaluate(bundle, split, seed):
        assert split == "development", "The meta probe must not request held-out data"
        response = runner.run(bundle, "solve_batch", {"problems": [{}]}, timeout=10)
        return {"split": split, "status": "ok", "score_available": True,
                "score": response["value"][0]["submission"]["answer"] / 10,
                "work_units": 0, "execution": response["execution"]}
    def generate(bundle, context, label):
        before = len(inner_calls)
        receipts, reports = [], []
        class InnerGateway:
            def ask(self, **request):
                inner_calls.append(deepcopy(request))
                receipts.append({"call_id": "scripted-" + str(len(inner_calls)), "status": "received",
                    "reserved_completion_tokens": request.get("max_tokens", 6000),
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
                if request["role"] == "changed_writer":
                    return source_design(8)
                if request["role"] == "main":
                    return source_design(6)
                return {"observations": ["Scripted ordinary task research"]}
        def experiment(files, label):
            report = evaluate(make_bundle(files), "development", context["seed"])
            reports.append(report)
            return report
        context.update(capabilities={"probe_improver": False}, editable_components=["task.py"],
            domain={"id": "literal_fixture"}, task_contract={"score_direction": "maximize"},
            budget={"remaining_calls": 6, "remaining_completion_tokens": 30000})
        broker = ImprovementBroker(InnerGateway(), parent_files=bundle["files"], experiment=experiment,
            search=lambda query: {"status": "no_results", "papers": []})
        response = runner.run(bundle, "improve", context, handler=broker.handle, timeout=15)
        inner_executions.append({"source": bundle, "execution": response["execution"],
                                 "roles": [row["role"] for row in inner_calls[before:]]})
        return {"candidates": [make_bundle(row["files"], parent=bundle) for row in response["value"]["candidates"]],
                "execution": response["execution"], "research": response["value"].get("research", {}),
                "calls": receipts, "numerical_reports": reports}
    def probe(files, label):
        assert not probe_records, "The outer source must never perform a second probe"
        candidate = make_bundle(files, parent=original)
        report = evaluate_improver_probe(original, candidate, original, seed=12, generate=generate, evaluate=evaluate)
        report["probe_id"] = "actual-local-source-probe"
        probe_records.append(deepcopy(report))
        return report
    broker = ImprovementBroker(OuterGateway(), parent_files=original["files"], experiment=None,
        search=lambda query: {"status": "no_results", "papers": []}, probe_improver=probe)
    context = {"parent": original, "roles": json.loads(original["files"]["roles.json"]),
        "domain": {"id": "literal_fixture"}, "capabilities": {"probe_improver": True},
        "editable_components": ["task.py", "meta.py", "workflow.py", "roles.json"],
        "failures": [{"kind": "measured_counterexample", "candidate_id": original["id"]}],
        "budget": {"remaining_calls": 18, "remaining_completion_tokens": 90000}}
    outer = runner.run(original, "improve", context, handler=broker.handle, timeout=40)
    assert len(probe_records) == 1 and len(outer_calls) == 3
    actual = probe_records[0]
    assert actual["status"] == "completed" and actual["aggregate"]["paired_development_gain"] == pytest.approx(.2)
    assert len(inner_executions) == 2
    assert set(inner_executions[0]["roles"][:2]) == {"mechanism_researcher", "experimental_critic"}
    assert inner_executions[0]["roles"][-1] == "main"
    assert inner_executions[1]["roles"] == ["changed_writer"]
    assert all(row["execution"]["source_digest"] == row["source"]["digest"] for row in inner_executions)
    assert inner_executions[0]["execution"]["source_digest"] != inner_executions[1]["execution"]["source_digest"]
    assert outer["execution"]["source_digest"] == original["digest"]
    candidate = outer["value"]["candidates"][0]
    assert candidate["evidence_status"] == "development_supported"
    assert outer["value"]["research"]["probes"][0]["probe_id"] == "actual-local-source-probe"
    # Freeze and inherit the actual proposed M; its next execution uses its own changed dispatch.
    successor = make_bundle(candidate["files"], parent=original)
    inherited = generate(successor, {"parent": successor, "seed": 12, "development": {"status": "ok", "score": 0}}, "next-generation")
    assert inherited["execution"]["source_digest"] == successor["digest"]
    assert inner_executions[-1]["roles"] == ["changed_writer"]


def test_failed_post_probe_model_repair_retains_actual_negative_probe_and_candidate():
    result, calls, probes, experiments, context, logs = run_meta_fixture(
        [meta_design(), RuntimeError("model transport failed")], report=probe_report(gain=-.1))
    assert len(calls) == 4 and len(probes) == 1
    assert result["research"]["repair"]["status"] == "model_repair_failed"
    assert result["research"]["probes"][0]["aggregate"]["paired_development_gain"] == -.1
    assert result["candidates"][0]["evidence_status"] == "unproven"


@pytest.mark.parametrize("mutation", ["missing_source_receipt", "missing_cost_receipt", "incomplete_arm"])
def test_positive_probe_number_cannot_promote_missing_actual_evidence(mutation):
    report = probe_report(gain=.1)
    if mutation == "missing_source_receipt":
        report["arms"][0]["attempts"][0]["execution"] = None
    elif mutation == "missing_cost_receipt":
        report["evidence"] = {"missing": [{"kind": "model_calls"}]}
    else:
        report["arms"][1]["status"] = "incomplete"
    result, calls, probes, experiments, context, logs = run_meta_fixture([meta_design()], report=report,
        budget={"remaining_calls": 15, "remaining_completion_tokens": 70400})
    assert result["candidates"][0]["evidence_status"] == "unproven"
