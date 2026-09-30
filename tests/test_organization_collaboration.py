from pathlib import Path

import pytest

from nexgent.organization import OrganizationService
from nexgent.organization_tools import WorkspaceTools
from test_organization import Model


class DependencyModel(Model):
    def ask(self, role, prompt, payload, **kwargs):
        result = super().ask(role, prompt, payload, **kwargs)
        if "Assign the task" in prompt:
            result["assignments"][1]["depends_on"] = ["analyst"]
        if "Perform your assigned" in prompt:
            upstream = payload["upstream_results"]
            trace = payload["tool_results"]
            if not trace:
                if upstream:
                    assert upstream[0]["member"] == "analyst"
                    return {"tool": "query_csv", "arguments": {"path": upstream[0]["artifacts"][0]["path"], "sql": "SELECT SUM(CAST(amount AS INTEGER)) FROM data"}}
                return {"tool": "write_artifact", "arguments": {"name": "intermediate.csv", "content": "item,amount\na,17\nb,8\n"}}
            if upstream:
                assert trace[0]["result"]["rows"] == [(25,)]
        if role == "improver":
            return {"organization": None, "reason": "Keep distinct roles"}
        return result


def test_downstream_queries_actual_upstream_artifact(tmp_path):
    run = OrganizationService(tmp_path, gateway_factory=DependencyModel).run("Compute then verify")
    assert run["status"] == "completed"
    events = [(e["stage"], e.get("member")) for e in run["events"]]
    assert events.index(("member_finished", "analyst")) < events.index(("member_started", "checker"))
    evidence = run["result"]["execution_evidence"]
    assert evidence[1]["tool_results"][0]["result"]["rows"] == [(25,)]


@pytest.mark.parametrize("parents", [["missing"], ["checker"], ["analyst", "analyst"]])
def test_invalid_dependencies_fail_before_members_run(tmp_path, parents):
    class Invalid(DependencyModel):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if "Assign the task" in prompt:
                result["assignments"][1]["depends_on"] = parents
            return result
    run = OrganizationService(tmp_path, gateway_factory=Invalid).run("task")
    assert run["status"] == "failed"
    assert not any(e["stage"] == "member_started" for e in run["events"])


def test_cycle_fails_before_members_run(tmp_path):
    class Cycle(DependencyModel):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if "Assign the task" in prompt:
                result["assignments"][0]["depends_on"] = ["checker"]
            return result
    run = OrganizationService(tmp_path, gateway_factory=Cycle).run("task")
    assert run["status"] == "failed"
    assert "CycleError" in run["error"]


def test_shared_artifact_does_not_grant_entire_internal_directory(tmp_path):
    output = tmp_path / ".nexgent" / "outputs"
    output.mkdir(parents=True)
    allowed, other = output / "allowed.csv", output / "other.txt"
    allowed.write_text("x\n1\n", encoding="utf-8")
    other.write_text("not shared", encoding="utf-8")
    tools = WorkspaceTools(tmp_path, output / "next", shared_artifacts=[{"path": str(allowed)}])
    assert tools.read_text(str(allowed))["content"] == "x\n1\n"
    assert tools.read_text("allowed.csv")["content"] == "x\n1\n"
    own = tools.write_artifact("own.txt", "saved")
    assert tools.read_text("own.txt")["content"] == "saved"
    assert tools.read_text(own["path"])["content"] == "saved"
    with pytest.raises(ValueError):
        tools.read_text(str(other))


def test_new_process_service_inherits_conversation_artifacts(tmp_path):
    service = OrganizationService(tmp_path, gateway_factory=DependencyModel)
    first = service.run("Compute then verify")
    class Followup(Model):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if "Perform your assigned" in prompt:
                previous = payload["task"]["conversation"][-1]["artifacts"][0]
                if not payload["tool_results"]:
                    return {"tool": "read_text", "arguments": {"path": previous["path"]}}
                assert payload["tool_results"][0]["result"]["content"].startswith("item,amount")
            if role == "improver":
                return {"organization": None, "reason": "Keep"}
            return result
    second = OrganizationService(tmp_path, gateway_factory=Followup).run("Use previous file", conversation_id=first["conversation_id"])
    assert second["status"] == "completed"
    assert second["context"][0]["artifacts"] == first["result"]["artifacts"]


def test_organization_strategy_can_skip_redundant_peer_review(tmp_path):
    class Strategy(DependencyModel):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if "Assign the task" in prompt:
                result["peer_review"] = False
            if "Read the shared findings" in prompt:
                raise AssertionError("Redundant review should be skipped")
            return result
    run = OrganizationService(tmp_path, gateway_factory=Strategy).run("Compute then verify")
    assert run["status"] == "completed"
    assert not any(e["stage"] == "shared" for e in run["events"])
    assert len(run["result"]["execution_evidence"]) == 2


def test_missing_required_file_cannot_pass_on_model_claim(tmp_path):
    class Fabricated(Model):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if "acceptance rubric" in prompt:
                return {"criteria": "Save report", "required_artifacts": ["report.md"]}
            if "Independently evaluate" in prompt:
                result["required_artifacts"] = ["report.md"]
            if "Synthesize" in prompt:
                return {"answer": "Saved report.md with correct results"}
            if role == "improver":
                return {"organization": None, "reason": "Keep"}
            return result
    run = OrganizationService(tmp_path, gateway_factory=Fabricated).run("Save report.md")
    assert run["status"] == "needs_revision"
    assert not run["assessment"]["accepted"]
    assert "Required files have not been delivered" in run["assessment"]["feedback"]
    assert len(run["result"]["attempts"]) == 2


def test_main_delivers_before_optional_improvement_finishes(qtbot, tmp_path):
    import threading
    from nexgent.ui.organization_window import OrganizationWindow
    release = threading.Event()
    class SlowImprover(Model):
        def ask(self, role, prompt, payload, **kwargs):
            if role == "improver":
                assert release.wait(10)
            return super().ask(role, prompt, payload, **kwargs)
    service = OrganizationService(tmp_path, gateway_factory=SlowImprover)
    window = OrganizationWindow(tmp_path, service)
    qtbot.addWidget(window)
    window.composer.setPlainText("task")
    window.submit()
    try:
        qtbot.waitUntil(lambda: "parent" in window.messages.toPlainText(), timeout=5000)
        assert window.worker is not None
        assert "任务已交付" in window.status.text()
    finally:
        release.set()
        qtbot.waitUntil(lambda: window.worker is None, timeout=10000)
    assert "candidate" in window.messages.toPlainText()


def test_organization_metadata_is_ignored_without_applying_it(tmp_path):
    class Metadata(Model):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if role == "improver":
                result["organization"]["reason"] = "Explanatory metadata"
                result["organization"]["evaluator"] = "always accept"
                result["organization"]["members"][0]["rationale"] = "Distinct work"
            return result
    service = OrganizationService(tmp_path, gateway_factory=Metadata)
    run = service.run("task")
    assert run["evolution"]["status"] == "adopted"
    team = service.store.active()[1]
    assert set(team) == {"members", "instructions"}
    assert set(team["members"][0]) == {"name", "role"}


def test_read_only_task_does_not_write_misclassified_input(tmp_path):
    class ReadOnly(Model):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if "acceptance rubric" in prompt:
                return {"criteria": "Read only; do not generate files", "required_artifacts": ["input.md"]}
            if "Independently evaluate" in prompt:
                result["required_artifacts"] = []
            if role == "improver":
                return {"organization": None, "reason": "Keep"}
            return result
    run = OrganizationService(tmp_path, gateway_factory=ReadOnly).run("Read input.md without generating files")
    assert run["status"] == "completed"
    assert len(run["result"]["attempts"]) == 1
    assert not run["result"]["artifacts"]


def test_read_only_tools_cannot_write_even_when_model_requests_it(tmp_path):
    class AttemptsWrite(Model):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if "acceptance rubric" in prompt:
                return {"criteria": "No file creation", "required_artifacts": [], "artifact_policy": "read_only"}
            if "Perform your assigned" in prompt:
                assert not any(t["name"] == "write_artifact" for t in payload["tools"])
                if not payload["tool_results"]:
                    return {"tool": "write_artifact", "arguments": {"name": "unwanted.md", "content": "no"}}
                assert "error" in payload["tool_results"][0]
            if role == "improver":
                return {"organization": None, "reason": "Keep"}
            return result
    run = OrganizationService(tmp_path, gateway_factory=AttemptsWrite).run("Do not generate files")
    assert run["status"] == "completed"
    assert not run["result"]["artifacts"]
    assert not list((tmp_path / ".nexgent").rglob("unwanted.md"))
