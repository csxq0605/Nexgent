from nexgent.organization import OrganizationService
from test_organization import Model


class RevisionModel(Model):
    repair_score = 10
    fail_repair = False

    def ask(self, role, prompt, payload, **kwargs):
        result = super().ask(role, prompt, payload, **kwargs)
        if "Synthesize" in prompt:
            if "revision" in payload["task"]:
                assert payload["task"]["revision"]["feedback"] == "Missing total"
                if self.fail_repair:
                    raise RuntimeError("repair unavailable")
                return {"answer": "repaired"}
            return {"answer": "draft"}
        if "Independently evaluate" in prompt:
            assert "revision" not in payload["task"]
            if payload["answer"] == "repaired":
                assert payload["prior_attempt"]["assessment"]["feedback"] == "Missing total"
                assert "execution_evidence" in payload["prior_attempt"]
            score = self.repair_score if payload["answer"] == "repaired" else 5
            return {"score": score, "accepted": score == 10, "feedback": "Correct" if score == 10 else "Missing total"}
        if role == "improver":
            assert len(payload["attempts"]) == 2
            return {"organization": None, "reason": "Keep organization"}
        return result


def test_feedback_repairs_then_independently_verifies(tmp_path):
    run = OrganizationService(tmp_path, gateway_factory=RevisionModel).run("task")
    assert run["status"] == "completed"
    assert run["answer"] == "repaired"
    assert len(run["result"]["attempts"]) == 2
    assert run["result"]["model_calls"] == 14
    assert run["revision"] == run["delivered_revision"] == 0


def test_worse_revision_preserves_better_draft(tmp_path):
    class Worse(RevisionModel):
        repair_score = 2
    run = OrganizationService(tmp_path, gateway_factory=Worse).run("task")
    assert run["answer"] == "draft"
    assert run["status"] == "needs_revision"
    assert len(run["result"]["attempts"]) == 2


def test_failed_revision_preserves_draft_and_counts_spend(tmp_path):
    class Fails(RevisionModel):
        fail_repair = True
    run = OrganizationService(tmp_path, gateway_factory=Fails).run("task")
    assert run["answer"] == "draft"
    assert run["status"] == "needs_revision"
    assert run["result"]["model_calls"] == 13
    assert not run["result"]["tokens_complete"]
    assert "error" in run["result"]["attempts"][1]


def test_revision_delivers_new_artifact_and_preserves_draft(tmp_path):
    from pathlib import Path
    class Files(RevisionModel):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if "Perform your assigned" in prompt and not payload["tool_results"]:
                content = "total 205" if "revision" in payload["task"] else "draft without total"
                return {"tool": "write_artifact", "arguments": {"name": "report.md", "content": content}}
            return result
    run = OrganizationService(tmp_path, gateway_factory=Files).run("Save report")
    first, second = run["result"]["attempts"]
    draft = first["result"]["artifacts"][0]
    final = run["result"]["artifacts"][0]
    assert draft["path"] != final["path"]
    assert Path(draft["path"]).read_text() == "draft without total"
    assert Path(final["path"]).read_text() == "total 205"
    assert second["assessment"]["accepted"]


def test_exhausted_tools_still_reach_evaluation(tmp_path):
    class Repeated(Model):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if "Perform your assigned" in prompt:
                return {"tool": "list_files", "arguments": {}}
            if "Independently evaluate" in prompt:
                assert len(payload["execution_evidence"][0]["tool_results"]) == 8
            if role == "improver":
                return {"organization": None, "reason": "Keep"}
            return result
    run = OrganizationService(tmp_path, gateway_factory=Repeated).run("List files")
    assert run["status"] == "completed"
    assert "assessment" in run
