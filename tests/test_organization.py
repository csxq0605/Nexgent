from copy import deepcopy
import uuid

from nexgent.organization import OrganizationService, INITIAL_ORGANIZATION


class Model:
    reject = False
    fail_improver = False

    def __init__(self, root, *, reserve, **kwargs):
        self.reserve = reserve

    def ask(self, role, prompt, payload, **kwargs):
        receipt = {"call_id": uuid.uuid4().hex, "status": "started", "usage": {}}
        self.reserve(deepcopy(receipt))
        try:
            if "acceptance rubric" in prompt:
                return {"criteria": "Correct answer"}
            if "Assign the task" in prompt:
                return {"assignments": [{"member": m["name"], "task": "Solve"} for m in payload["organization"]["members"]]}
            if "Perform your assigned" in prompt:
                return {"answer": "member work"}
            if "Read the shared findings" in prompt:
                assert len(payload["shared_findings"]) > 1
                return {"answer": "checked colleague findings"}
            if "Synthesize" in prompt:
                return {"answer": "candidate" if len(payload["organization"]["members"]) == 1 else "parent"}
            if "Independently evaluate" in prompt:
                if payload.get('verification_required') and not payload.get('verification_results'):
                    computation = next(t for e in payload['execution_evidence'] for t in e['tool_results']
                                       if 'result' in t and (t['tool'] in {'run_python', 'query_csv'} or t['tool'].startswith('skill_')))
                    if computation['tool'].startswith('skill_'):
                        return {'tool': 'run_python', 'arguments': {'code': 'return {"sum": sum(payload), "squares": sum(n * n for n in payload)}',
                                                                   'payload': payload['task']['inputs']['numbers']}}
                    return {'tool': computation['tool'], 'arguments': computation['arguments']}
                bad = self.reject and payload["answer"] == "candidate"
                return {"score": 2 if bad else 9, "accepted": not bad, "feedback": "incorrect" if bad else "correct", "checks": [{"requirement": "Correct answer", "passed": not bad}], "organization_reusable": True, "organization_feedback": "General roles"}
            if role == "improver":
                if self.fail_improver:
                    raise RuntimeError("improver unavailable")
                return {"organization": {"members": [INITIAL_ORGANIZATION["members"][0]], "instructions": "Check the answer before delivery."}, "reason": "Remove redundant work"}
            raise AssertionError(prompt)
        finally:
            receipt.update(status="completed", usage={"total_tokens": 100})
            self.reserve(receipt)


def test_task_collaboration_adoption_and_new_service_inheritance(tmp_path):
    service = OrganizationService(tmp_path, gateway_factory=Model)
    result = service.run("first task")
    assert result["status"] == "completed"
    assert result["evolution"]["status"] == "adopted"
    assert result["revision"] == 0
    assert result["delivered_revision"] == 1
    assert result["answer"] == result["result"]["answer"]
    assert len(next(e for e in result["events"] if e["stage"] == "collaborated")["findings"]) == 2
    reconstructed = OrganizationService(tmp_path, gateway_factory=Model)
    later = reconstructed.run("second task", conversation_id=result["conversation_id"])
    assert later["revision"] == 1
    assert len(later["organization"]["members"]) == 1
    assert later["context"] == [{"user": "first task", "answer": "candidate"}]
    assert later["evolution"]["status"] == "unchanged"
    assert later["usage"]["model_calls"] == 6


def test_regression_reuses_scope_review_of_unchanged_candidate(tmp_path):
    class ReviewOnce(Model):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if 'Independently evaluate' in prompt and 'proposed_organization' not in payload:
                result.pop('organization_reusable')
                result.pop('organization_feedback')
            return result

    service = OrganizationService(tmp_path, gateway_factory=ReviewOnce)
    service.store.save({'id': 'earlier', 'created': 0, 'conversation_id': 'other', 'objective': 'different task',
                        'inputs': {}, 'context': [], 'answer': 'accepted answer', 'assessment': {'accepted': True},
                        'rubric': {'criteria': 'Correct answer'}, 'evolution': {'status': 'abstained'}})
    run = service.run('new task')
    assert run['evolution']['status'] == 'adopted'
    assert run['evolution']['assessment']['organization_reusable']
    assert 'organization_reusable' not in run['evolution']['regression']['candidate']
    assert run['evolution']['regression']['passed']


def test_failed_candidate_cannot_change_active_organization(tmp_path):
    class Reject(Model):
        reject = True
    service = OrganizationService(tmp_path, gateway_factory=Reject)
    result = service.run("task")
    assert result["evolution"]["status"] == "rejected"
    assert result["answer"] == "parent"
    assert service.store.active() == (0, INITIAL_ORGANIZATION)


def test_improvement_failure_preserves_delivery(tmp_path):
    class Fail(Model):
        fail_improver = True
    result = OrganizationService(tmp_path, gateway_factory=Fail).run("task")
    assert result["status"] == "completed"
    assert result["answer"] == "parent"
    assert result["evolution"]["status"] == "failed"


def test_previous_task_regression_rejects_candidate(tmp_path):
    service = OrganizationService(tmp_path, gateway_factory=Model)
    prior = {"id": "previous", "created": 1, "objective": "previous task", "inputs": {}, "context": [],
             "assessment": {"accepted": True}, "rubric": {"criteria": "correct"}}
    service.store.save(prior)

    class Regression(Model):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if (role == "evaluator" and "answer" in payload and payload["task"]["objective"] == "previous task"
                    and payload["answer"] == "candidate"):
                return {"score": 0, "accepted": False, "feedback": "regressed", "checks": [{"requirement": "Correct answer", "passed": False}], "organization_reusable": True, "organization_feedback": "General roles"}
            return result

    result = OrganizationService(tmp_path, gateway_factory=Regression).run("new task")
    assert result["evolution"]["status"] == "rejected"
    assert not result["evolution"]["regression"]["passed"]
    assert service.store.active()[0] == 0


def test_stop_never_adopts(tmp_path):
    import threading
    stop = threading.Event()
    stop.set()
    service = OrganizationService(tmp_path, gateway_factory=Model)
    result = service.run("task", stop_event=stop)
    assert result["status"] == "interrupted"
    assert service.store.active()[0] == 0


def test_main_window_runs_same_service(qtbot, tmp_path):
    from nexgent.ui.organization_window import OrganizationWindow
    service = OrganizationService(tmp_path, gateway_factory=Model)
    window = OrganizationWindow(tmp_path, service)
    qtbot.addWidget(window)
    window.composer.setPlainText("ordinary task")
    window.submit()
    qtbot.waitUntil(lambda: window.worker is None, timeout=10000)
    assert "candidate" in window.messages.toPlainText()
    assert service.store.active()[0] == 1
    conversation = window.conversation_id
    window.composer.setPlainText("follow-up")
    window.submit()
    qtbot.waitUntil(lambda: window.worker is None, timeout=10000)
    assert service.store.list()[0]["revision"] == 1
    assert window.conversation_id == conversation


def test_concurrent_stale_task_cannot_overwrite_adoption(tmp_path):
    service = OrganizationService(tmp_path, gateway_factory=Model)
    result = service.run("task")
    stale = deepcopy(result)
    stale["id"] = "stale-run"
    service.store.adopt(0, INITIAL_ORGANIZATION, stale)
    assert stale["evolution"]["status"] == "stale"
    assert service.store.active()[0] == 1


def test_missing_usage_prevents_adoption(tmp_path):
    class NoUsage(Model):
        def __init__(self, root, *, reserve, **kwargs):
            def omit(receipt):
                receipt["usage"] = {}
                reserve(receipt)
            super().__init__(root, reserve=omit, **kwargs)
    service = OrganizationService(tmp_path, gateway_factory=NoUsage)
    result = service.run("task")
    assert result["evolution"]["status"] == "rejected"
    assert service.store.active()[0] == 0


def test_structured_member_findings_are_preserved(tmp_path):
    class Structured(Model):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if "Perform your assigned" in prompt:
                return {"answer": {"total": 236, "remaining": 14}}
            if "Read the shared findings" in prompt:
                assert all('"total": 236' in item["answer"] for item in payload["shared_findings"])
            return result
    result = OrganizationService(tmp_path, gateway_factory=Structured).run("task")
    assert result["status"] == "completed"
    assert result["evolution"]["status"] == "adopted"


def test_optional_demo_cli_routes_to_organization_service(tmp_path, monkeypatch, capsys):
    import json
    from nexgent.cli import main
    service = OrganizationService(tmp_path, gateway_factory=Model)
    monkeypatch.setattr("nexgent.organization.OrganizationService", lambda root, **kwargs: service)
    assert main(["--root", str(tmp_path), "run", "task", "--organization-demo", "--input", '{"facts": "supplied"}']) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["inputs"] == {"facts": "supplied"}
    assert result["evolution"]["status"] == "adopted"


def test_quality_repair_can_recruit_a_member(tmp_path):
    class Recruit(Model):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if role == "improver":
                team = deepcopy(INITIAL_ORGANIZATION)
                team["members"].append({"name": "specialist", "role": "Resolve domain-specific ambiguities."})
                return {"organization": team, "reason": "Add missing expertise"}
            if "Synthesize" in prompt:
                return {"answer": "fixed" if len(payload["organization"]["members"]) == 3 else "wrong"}
            if "Independently evaluate" in prompt:
                fixed = payload["answer"] == "fixed"
                return {"score": 9 if fixed else 4, "accepted": fixed, "feedback": "checked", "checks": [{"requirement": "Correct answer", "passed": fixed}], "organization_reusable": True, "organization_feedback": "General roles"}
            return result
    result = OrganizationService(tmp_path, gateway_factory=Recruit).run("task needs expertise")
    assert result["evolution"]["status"] == "adopted"
    assert len(result["evolution"]["candidate"]["members"]) == 3


def test_repeated_prompt_does_not_replace_distinct_regression_task(tmp_path):
    service = OrganizationService(tmp_path, gateway_factory=Model)
    for identity, objective, created in (("older", "different task", 1), ("duplicate", "current task", 2)):
        service.store.save({"id": identity, "created": created, "objective": objective, "inputs": {},
                            "context": [], "assessment": {"accepted": True}, "rubric": {"criteria": "correct"},
                            "evolution": {"status": "rejected", "gate_feedback": "No actual improvement"}})

    class Feedback(Model):
        def ask(self, role, prompt, payload, **kwargs):
            if role == "improver":
                assert payload["prior_feedback"][0]["reason"] == "No actual improvement"
            return super().ask(role, prompt, payload, **kwargs)
    result = OrganizationService(tmp_path, gateway_factory=Feedback).run("current task")
    assert result["evolution"]["regression"]["task_id"] == "older"
    assert result["evolution"]["status"] == "adopted"
