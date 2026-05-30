"""Tests for the agent loop (Ch2 patterns).

Uses real LLM API calls — no mocking.
"""

import os
import pytest
import json
from mimo_harness.agent import (
    MiMoHarness, retry_with_backoff,
)
from mimo_harness.context import Session
from mimo_harness.tools import file_ops

# All tests in this file require a real API key
pytestmark = pytest.mark.skipif(
    not os.environ.get("MIMO_API_KEY") or os.environ.get("MIMO_API_KEY") == "test-key-for-testing",
    reason="Real MIMO_API_KEY not set — agent tests skipped",
)


class TestRetryWithBackoff:
    """Test retry logic with real functions (no LLM needed)."""

    def test_success_first_try(self):
        call_count = [0]
        def fn():
            call_count[0] += 1
            return "ok"
        result = retry_with_backoff(fn, max_retries=3, base_delay=0.01)
        assert result == "ok"
        assert call_count[0] == 1

    def test_success_after_retries(self):
        call_count = [0]
        def fn():
            call_count[0] += 1
            if call_count[0] < 3:
                err = Exception("fail")
                err.status_code = 429 if call_count[0] == 1 else 500
                raise err
            return "ok"
        result = retry_with_backoff(fn, max_retries=3, base_delay=0.01)
        assert result == "ok"

    def test_non_retryable_error(self):
        def fn():
            err = Exception("bad request")
            err.status_code = 400
            raise err
        with pytest.raises(Exception, match="bad request"):
            retry_with_backoff(fn, max_retries=3, base_delay=0.01)

    def test_retry_exhaustion(self):
        call_count = [0]
        def always_fail():
            call_count[0] += 1
            err = Exception("Rate limited")
            err.status_code = 429
            raise err
        with pytest.raises(Exception, match="Rate limited"):
            retry_with_backoff(always_fail, max_retries=2, base_delay=0.001)
        assert call_count[0] >= 2

    def test_retry_503(self):
        call_count = [0]
        def fail_then_succeed():
            call_count[0] += 1
            if call_count[0] < 2:
                err = Exception("Service unavailable")
                err.status_code = 503
                raise err
            return "success"
        result = retry_with_backoff(fail_then_succeed, max_retries=3, base_delay=0.001)
        assert result == "success"
        assert call_count[0] == 2


class TestRunWithToolCalls:
    """Test agent.run() with real LLM that invokes tools."""

    def test_run_with_tool_calls(self, monkeypatch, tmp_path):
        """Real LLM returns tool call, verify tool is dispatched and result fed back."""
        monkeypatch.chdir(tmp_path)
        file_ops._read_files.clear()
        file_ops._write_allowed_files.clear()

        harness = MiMoHarness(max_steps=5, auto_approve=True, bare=True)
        session = Session(session_id="test")
        result = harness.run("What is 2+2? Use the calculator tool to compute it.", session)

        assert len(result) > 0
        # Session should contain tool messages
        tool_msgs = [m for m in session.messages if m.get("role") == "tool"]
        assert len(tool_msgs) >= 1


class TestRunMaxStepsTermination:
    def test_run_max_steps_termination(self):
        """Verify agent stops at max_steps."""
        harness = MiMoHarness(max_steps=1, auto_approve=True, bare=True)
        session = Session(session_id="test")
        result = harness.run("What is the capital of France?", session)

        # With max_steps=1, agent can only do 1 iteration
        assert len(result) > 0


class TestTerminationPaths:
    """Test termination paths in MiMoHarness.run()."""

    def test_max_duration_termination(self):
        """Agent stops when time limit is exceeded."""
        harness = MiMoHarness(max_steps=100, auto_approve=True, bare=True, max_duration=0.0)
        session = Session(session_id="test")
        result = harness.run("test task", session)

        assert "LIMIT" in result or "Time limit" in result or "duration" in result.lower()

    def test_user_abort_termination(self):
        """Agent stops when graceful abort is requested."""
        harness = MiMoHarness(max_steps=10, auto_approve=True, bare=True)
        harness.graceful_abort.request()

        session = Session(session_id="test")
        result = harness.run("test task", session)

        assert "ABORTED" in result or "Stopped by user" in result or "abort" in result.lower()

    def test_token_limit_termination(self):
        """Agent stops when token budget is exceeded."""
        harness = MiMoHarness(max_steps=10, auto_approve=True, bare=True)
        # Force token budget to be blocked
        harness.token_budget.effective_max = 1
        harness.token_budget.estimated_tokens = 999999

        session = Session(session_id="test")
        result = harness.run("test task", session)

        assert "Token budget" in result or "TOKEN_LIMIT" in result or "ERROR" in result


class TestBareMode:
    """Test bare mode skips memory loading."""

    def test_bare_mode_system_prompt(self):
        """Bare mode should produce a minimal system prompt without memory."""
        harness = MiMoHarness(bare=True)
        prompt = harness._build_system_prompt()
        assert isinstance(prompt, str)
        assert len(prompt) > 0


class TestRunStreamMode:
    """Test run() with stream=True using real API."""

    def test_run_stream_mode_returns_final(self):
        harness = MiMoHarness(max_steps=3, auto_approve=True, stream=True, bare=True)
        session = Session(session_id="stream-test")
        result = harness.run("Reply with just the number 42.", session)

        assert len(result) > 0
        assert "42" in result


class TestRunDefaultSession:
    """Test run() creates default session when None."""

    def test_run_creates_default_session(self):
        harness = MiMoHarness(max_steps=1, auto_approve=True, bare=True)
        result = harness.run("Say hello in one word.")
        assert len(result) > 0


class TestRunStopHook:
    """Test run() fires STOP hook on completion."""

    def test_run_fires_stop_hook(self):
        from mimo_harness.hooks import HookRunner, HookEvent, HookConfig, HookDecision, HookResult
        harness = MiMoHarness(max_steps=3, auto_approve=True, bare=True)

        # Track hook calls
        hook_calls = []
        original_run_hooks = HookRunner.run_hooks

        def tracking_run_hooks(self_hook, event, *args, **kwargs):
            hook_calls.append(event)
            return original_run_hooks(self_hook, event, *args, **kwargs)

        harness._hook_runner = HookRunner()
        # Monkey-patch the run_hooks method to track calls
        import types
        harness._hook_runner.run_hooks = types.MethodType(tracking_run_hooks, harness._hook_runner)

        session = Session(session_id="hook-test")
        result = harness.run("Say done.", session)

        assert len(result) > 0
        # Verify STOP hook was fired
        assert HookEvent.STOP in hook_calls


class TestRunSequentialToolCalls:
    """Test run() with non-concurrency-safe tool calls (write_file)."""

    def test_run_sequential_tool_calls(self, monkeypatch, tmp_path):
        """Real LLM calls write_file tool, verify tool was dispatched."""
        monkeypatch.chdir(tmp_path)
        file_ops._read_files.clear()
        file_ops._write_allowed_files.clear()

        harness = MiMoHarness(max_steps=5, auto_approve=True, bare=True)
        session = Session(session_id="seq-test")
        result = harness.run(
            f"Use the write_file tool to create a file at '{tmp_path / 'test.txt'}' with content 'hello world'.",
            session,
        )

        assert len(result) > 0
        # Verify the agent used write_file tool (check session messages)
        tool_msgs = [m for m in session.messages if m.get("role") == "tool"]
        assert len(tool_msgs) >= 1
