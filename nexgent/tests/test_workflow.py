"""Tests for Workflow engine — DSL, budget, pipeline, parallel, resume.

Uses mock SubAgent execution to avoid real API calls in unit tests.
"""

import os
import sys
import time
import asyncio
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from nexgent.workflow import (
    WorkflowStatus, AgentStatus,
    AgentRunResult, PhaseResult, Budget, BudgetExhausted,
    WorkflowRun, WorkflowContext, WorkflowRunner,
)


# ============================================================
# Budget Tests
# ============================================================

class TestBudget:
    def test_unlimited_budget(self):
        budget = Budget()
        assert budget.total is None
        assert budget.remaining() == float("inf")

    def test_limited_budget(self):
        budget = Budget(total=1000)
        assert budget.remaining() == 1000

    def test_budget_record(self):
        budget = Budget(total=1000)
        budget.record(300)
        assert budget.spent == 300
        assert budget.remaining() == 700

    def test_budget_exhausted(self):
        budget = Budget(total=100)
        with pytest.raises(BudgetExhausted):
            budget.record(150)

    def test_budget_exact_limit(self):
        budget = Budget(total=100)
        with pytest.raises(BudgetExhausted):
            budget.record(100)

    def test_budget_to_dict(self):
        budget = Budget(total=1000)
        budget.record(300)
        d = budget.to_dict()
        assert d["total"] == 1000
        assert d["spent"] == 300
        assert d["remaining"] == 700

    def test_unlimited_budget_to_dict(self):
        budget = Budget()
        d = budget.to_dict()
        assert d["total"] is None
        assert d["remaining"] == "unlimited"


# ============================================================
# AgentRunResult Tests
# ============================================================

class TestAgentRunResult:
    def test_default_status(self):
        result = AgentRunResult(
            agent_id="test-1",
            label="test",
            phase="default",
            prompt="do something",
        )
        assert result.status == AgentStatus.PENDING
        assert result.result is None
        assert result.error is None

    def test_to_dict(self):
        result = AgentRunResult(
            agent_id="test-1",
            label="test",
            phase="review",
            prompt="find bugs",
            status=AgentStatus.COMPLETED,
            token_usage=500,
            duration=2.5,
        )
        d = result.to_dict()
        assert d["agent_id"] == "test-1"
        assert d["status"] == "completed"
        assert d["token_usage"] == 500


# ============================================================
# PhaseResult Tests
# ============================================================

class TestPhaseResult:
    def test_phase_result(self):
        phase = PhaseResult(title="Review")
        assert phase.title == "Review"
        assert phase.agent_ids == []

    def test_phase_to_dict(self):
        phase = PhaseResult(title="Verify", agent_ids=["a1", "a2"])
        d = phase.to_dict()
        assert d["title"] == "Verify"
        assert d["agent_count"] == 2


# ============================================================
# WorkflowRun Tests
# ============================================================

class TestWorkflowRun:
    def test_initial_state(self):
        run = WorkflowRun(
            run_id="wf-test",
            script_path="test.py",
            script_source="pass",
        )
        assert run.status == WorkflowStatus.PENDING
        assert run.phases == []
        assert run.agents == {}
        assert run.budget.total is None

    def test_to_dict(self):
        run = WorkflowRun(
            run_id="wf-test",
            script_path="test.py",
            script_source="pass",
            started_at=time.time(),
        )
        d = run.to_dict()
        assert d["run_id"] == "wf-test"
        assert d["status"] == "pending"
        assert d["agent_count"] == 0


# ============================================================
# WorkflowContext Tests (mock runner)
# ============================================================

class MockWorkflowRunner:
    """Mock runner that returns predefined results instead of calling LLM."""

    def __init__(self, results=None):
        self.results = results or {}
        self._call_count = 0

    def _run_single_agent(self, prompt, tools=None, model=None):
        self._call_count += 1
        # Return predefined result or a default
        return self.results.get(prompt, f"Mock result for: {prompt[:50]}")


class TestWorkflowContext:
    def _make_ctx(self, budget_total=None, results=None):
        runner = MockWorkflowRunner(results)
        run = WorkflowRun(
            run_id="wf-test",
            script_path="test.py",
            script_source="pass",
            budget=Budget(total=budget_total),
        )
        loop = asyncio.new_event_loop()
        ctx = WorkflowContext(runner=runner, run=run, loop=loop)
        return ctx, run, loop

    def test_phase_sets_current_phase(self):
        ctx, run, loop = self._make_ctx()
        ctx.phase("Review")
        assert ctx._current_phase == "Review"
        assert len(run.phases) == 1
        assert run.phases[0].title == "Review"
        loop.close()

    def test_log_calls_callbacks(self):
        ctx, run, loop = self._make_ctx()
        messages = []
        ctx.on_progress(lambda msg: messages.append(msg))
        ctx.log("hello")
        assert messages == ["hello"]
        loop.close()

    def test_agent_returns_result(self):
        ctx, run, loop = self._make_ctx(results={"find bugs": "Found 3 bugs"})
        try:
            result = loop.run_until_complete(ctx.agent("find bugs", label="bug-finder"))
            assert result == "Found 3 bugs"
            assert len(run.agents) == 1
            assert list(run.agents.values())[0].status == AgentStatus.COMPLETED
        finally:
            loop.close()

    def test_agent_uses_cache(self):
        ctx, run, loop = self._make_ctx()
        try:
            # Pre-populate cache
            run._cached_results["agent-0001"] = "cached result"
            result = loop.run_until_complete(ctx.agent("any prompt"))
            assert result == "cached result"
        finally:
            loop.close()

    def test_agent_budget_skipped(self):
        ctx, run, loop = self._make_ctx(budget_total=10)
        try:
            # Budget is very small (below safety margin), agent should be skipped
            result = loop.run_until_complete(ctx.agent("x" * 100000))
            assert result is None
            # Agent should be marked as SKIPPED
            agent = list(run.agents.values())[0]
            assert agent.status == AgentStatus.SKIPPED
        finally:
            loop.close()

    def test_budget_record_raises_on_exceed(self):
        """BudgetExhausted is raised when record() exceeds the total."""
        budget = Budget(total=100)
        with pytest.raises(BudgetExhausted):
            budget.record(150)

    def test_agent_limit(self):
        ctx, run, loop = self._make_ctx()
        try:
            ctx._agent_counter = 1000  # at limit
            result = loop.run_until_complete(ctx.agent("should be skipped"))
            assert result is None
        finally:
            loop.close()

    def test_parallel(self):
        ctx, run, loop = self._make_ctx()
        try:
            async def task_a():
                return "A"

            async def task_b():
                return "B"

            results = loop.run_until_complete(ctx.parallel([task_a, task_b]))
            assert results == ["A", "B"]
        finally:
            loop.close()

    def test_parallel_with_failure(self):
        ctx, run, loop = self._make_ctx()
        try:
            async def task_ok():
                return "ok"

            async def task_fail():
                raise ValueError("boom")

            results = loop.run_until_complete(ctx.parallel([task_ok, task_fail]))
            assert results[0] == "ok"
            assert results[1] is None  # failed → None
        finally:
            loop.close()

    def test_parallel_empty(self):
        ctx, run, loop = self._make_ctx()
        try:
            results = loop.run_until_complete(ctx.parallel([]))
            assert results == []
        finally:
            loop.close()

    def test_pipeline(self):
        ctx, run, loop = self._make_ctx()
        try:
            def stage1(prev, item, idx):
                return f"{item}-s1"

            def stage2(prev, item, idx):
                return f"{prev}-s2"

            results = loop.run_until_complete(ctx.pipeline(["a", "b"], stage1, stage2))
            assert results == ["a-s1-s2", "b-s1-s2"]
        finally:
            loop.close()

    def test_pipeline_with_failure(self):
        ctx, run, loop = self._make_ctx()
        try:
            def stage_ok(prev, item, idx):
                return f"{item}-ok"

            def stage_fail(prev, item, idx):
                if item == "b":
                    raise ValueError("fail on b")
                return f"{prev}-more"

            results = loop.run_until_complete(ctx.pipeline(["a", "b"], stage_ok, stage_fail))
            assert results[0] == "a-ok-more"
            assert results[1] is None  # failed
        finally:
            loop.close()

    def test_pipeline_awaits_coroutine_returned_by_sync_wrapper(self):
        ctx, run, loop = self._make_ctx()
        try:
            async def async_stage(item):
                return f"{item}-async"

            def wrapper(prev, item, idx):
                return async_stage(prev)

            results = loop.run_until_complete(ctx.pipeline(["a", "b"], wrapper))
            assert results == ["a-async", "b-async"]
        finally:
            loop.close()

    def test_pipeline_empty(self):
        ctx, run, loop = self._make_ctx()
        try:
            results = loop.run_until_complete(ctx.pipeline([], lambda p, i, x: i))
            assert results == []
        finally:
            loop.close()


# ============================================================
# WorkflowRunner Tests (mock harness)
# ============================================================

class MockHarness:
    """Mock NexgentAgent for testing WorkflowRunner."""
    def __init__(self):
        self.effort = "medium"


class TestWorkflowRunner:
    def test_run_simple_script(self):
        runner = WorkflowRunner(parent_harness=MockHarness())

        script = """
def main(ctx, args):
    log("hello from workflow")
    return {"status": "done"}
"""
        run = runner.run(script_source=script, script_path="test.py")
        assert run.status == WorkflowStatus.COMPLETED
        assert run.result == {"status": "done"}

    def test_run_script_with_args(self):
        runner = WorkflowRunner(parent_harness=MockHarness())

        script = """
def main(ctx, args):
    return {"input": args}
"""
        run = runner.run(
            script_source=script,
            script_path="test.py",
            args={"key": "value"},
        )
        assert run.result == {"input": {"key": "value"}}

    def test_run_script_syntax_error(self):
        runner = WorkflowRunner(parent_harness=MockHarness())

        script = "def broken("
        run = runner.run(script_source=script, script_path="bad.py")
        assert run.status == WorkflowStatus.FAILED
        assert run.error is not None

    def test_list_runs(self):
        runner = WorkflowRunner(parent_harness=MockHarness())
        assert runner.list_runs() == []

        runner.run(script_source="pass", script_path="a.py")
        runner.run(script_source="pass", script_path="b.py")

        runs = runner.list_runs()
        assert len(runs) == 2

    def test_get_run(self):
        runner = WorkflowRunner(parent_harness=MockHarness())
        run = runner.run(script_source="pass", script_path="test.py")
        found = runner.get_run(run.run_id)
        assert found is run

    def test_get_run_not_found(self):
        runner = WorkflowRunner(parent_harness=MockHarness())
        assert runner.get_run("nonexistent") is None

    def test_save_workflow(self, tmp_path):
        runner = WorkflowRunner(parent_harness=MockHarness())
        script = "def main(ctx, args):\n    return 42\n"
        run = runner.run(script_source=script, script_path="test.py")

        save_dir = str(tmp_path / "workflows")
        filepath = runner.save_workflow(run.run_id, "my-workflow", save_dir)

        assert os.path.exists(filepath)
        with open(filepath, "r") as f:
            assert f.read() == script

    def test_save_workflow_not_found(self):
        runner = WorkflowRunner(parent_harness=MockHarness())
        with pytest.raises(ValueError, match="not found"):
            runner.save_workflow("nonexistent", "name")

    def test_budget_tracking(self):
        runner = WorkflowRunner(parent_harness=MockHarness())
        run = runner.run(
            script_source="pass",
            script_path="test.py",
            budget_total=10000,
        )
        assert run.budget.total == 10000
        assert run.budget.spent >= 0

    def test_budget_exhaustion_pauses_instead_of_claiming_completion(self):
        runner = WorkflowRunner(parent_harness=MockHarness())
        script = """
def main(ctx, args):
    ctx.budget.record(1)
"""
        run = runner.run(script_source=script, budget_total=1)
        assert run.status == WorkflowStatus.PAUSED
        assert run.error == "budget_exhausted"

    def test_model_override_reaches_subagent_config(self, monkeypatch):
        from nexgent.subagent import SubAgentManager, SubAgentResult, SubAgentState

        captured = {}

        def fake_run_single(self, config):
            captured["model"] = config.model
            return SubAgentResult(
                subagent_id="child-1",
                task=config.task,
                state=SubAgentState.COMPLETED,
                result="ok",
            )

        monkeypatch.setattr(SubAgentManager, "run_single", fake_run_single)
        runner = WorkflowRunner(parent_harness=MockHarness())
        assert runner._run_single_agent("task", model="research-model") == "ok"
        assert captured["model"] == "research-model"

    def test_resume_not_found(self):
        runner = WorkflowRunner(parent_harness=MockHarness())
        with pytest.raises(ValueError, match="not found"):
            runner.resume("nonexistent")


# ============================================================
# Integration: Workflow with phase() grouping
# ============================================================

class TestWorkflowPhases:
    def test_phases_in_script(self):
        runner = WorkflowRunner(parent_harness=MockHarness())

        script = """
def main(ctx, args):
    ctx.phase("Phase 1")
    ctx.log("doing phase 1")
    ctx.phase("Phase 2")
    ctx.log("doing phase 2")
    return "done"
"""
        run = runner.run(script_source=script, script_path="test.py")
        assert run.status == WorkflowStatus.COMPLETED
        assert len(run.phases) == 2
        assert run.phases[0].title == "Phase 1"
        assert run.phases[1].title == "Phase 2"


# ============================================================
# WorkflowRun.to_dict comprehensive
# ============================================================

class TestWorkflowRunDict:
    def test_full_to_dict(self):
        run = WorkflowRun(
            run_id="wf-abc",
            script_path="review.py",
            script_source="...",
            status=WorkflowStatus.COMPLETED,
            phases=[PhaseResult(title="Review", agent_ids=["a1", "a2"])],
            agents={
                "a1": AgentRunResult(
                    agent_id="a1", label="review", phase="Review",
                    prompt="find bugs", status=AgentStatus.COMPLETED,
                    token_usage=100, duration=1.5,
                ),
            },
            budget=Budget(total=5000, spent=100),
            started_at=1000.0,
            finished_at=1005.0,
        )
        d = run.to_dict()
        assert d["run_id"] == "wf-abc"
        assert d["status"] == "completed"
        assert d["agent_count"] == 1
        assert d["completed_agents"] == 1
        assert d["phases"][0]["title"] == "Review"
