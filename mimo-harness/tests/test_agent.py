"""Tests for the agent loop (Ch2 patterns)."""

import pytest
import json
from unittest.mock import MagicMock, patch
from mimo_harness.agent import (
    MiMoHarness, retry_with_backoff,
)
from mimo_harness.context import Session
from mimo_harness.tools import file_ops


class TestRetryWithBackoff:
    def test_success_first_try(self):
        fn = MagicMock(return_value="ok")
        result = retry_with_backoff(fn, max_retries=3, base_delay=0.01)
        assert result == "ok"
        assert fn.call_count == 1

    def test_success_after_retries(self):
        fn = MagicMock(side_effect=[Exception("fail"), Exception("fail"), "ok"])
        # Need to make the exception have a status_code for retry
        err1 = Exception("fail")
        err1.status_code = 429
        err2 = Exception("fail")
        err2.status_code = 500
        fn = MagicMock(side_effect=[err1, err2, "ok"])
        result = retry_with_backoff(fn, max_retries=3, base_delay=0.01)
        assert result == "ok"

    def test_non_retryable_error(self):
        err = Exception("bad request")
        err.status_code = 400
        fn = MagicMock(side_effect=err)
        with pytest.raises(Exception, match="bad request"):
            retry_with_backoff(fn, max_retries=3, base_delay=0.01)


class TestRunWithToolCalls:
    """Test agent.run() with tool calls in the response."""

    def test_run_with_tool_calls(self, monkeypatch, tmp_path):
        """Mock LLM returns tool call, verify tool is dispatched and result fed back."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)

        harness = MiMoHarness(max_steps=3, auto_approve=True)

        # First response: tool call to calculator
        tc = MagicMock()
        tc.id = "tc_calc"
        tc.function = MagicMock()
        tc.function.name = "calculator"
        tc.function.arguments = json.dumps({"expression": "2 + 2"})

        resp1 = MagicMock()
        resp1.choices = [MagicMock()]
        resp1.choices[0].message.content = "Let me calculate that."
        resp1.choices[0].message.tool_calls = [tc]
        resp1.choices[0].message.model_dump.return_value = {
            "role": "assistant",
            "content": "Let me calculate that.",
            "tool_calls": [{"id": "tc_calc", "type": "function",
                           "function": {"name": "calculator",
                                       "arguments": json.dumps({"expression": "2 + 2"})}}],
        }

        # Second response: final answer
        resp2 = MagicMock()
        resp2.choices = [MagicMock()]
        resp2.choices[0].message.content = "2 + 2 = 4"
        resp2.choices[0].message.tool_calls = None

        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = [resp1, resp2]

        session = Session(session_id="test")
        with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
            result = harness.run("calculate 2+2", session)

        assert "2 + 2 = 4" in result
        # Session should contain tool result
        tool_msgs = [m for m in session.messages if m.get("role") == "tool"]
        assert len(tool_msgs) >= 1


class TestRunMaxStepsTermination:
    def test_run_max_steps_termination(self, monkeypatch):
        """Verify agent stops at max_steps."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        harness = MiMoHarness(max_steps=2)

        # Always return a tool call so the agent never completes normally
        tc = MagicMock()
        tc.id = "tc_loop"
        tc.function = MagicMock()
        tc.function.name = "calculator"
        tc.function.arguments = json.dumps({"expression": "1"})

        def make_tool_response():
            resp = MagicMock()
            resp.choices = [MagicMock()]
            resp.choices[0].message.content = ""
            resp.choices[0].message.tool_calls = [tc]
            resp.choices[0].message.model_dump.return_value = {
                "role": "assistant", "content": "",
                "tool_calls": [{"id": "tc_loop", "type": "function",
                               "function": {"name": "calculator",
                                           "arguments": json.dumps({"expression": "1"})}}],
            }
            return resp

        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = lambda **kwargs: make_tool_response()

        session = Session(session_id="test")
        with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
            result = harness.run("loop forever", session)

        assert "Max steps reached" in result


class TestRunCircuitBreakerTermination:
    def test_run_circuit_breaker_termination(self, monkeypatch):
        """Verify agent stops when circuit breaker opens."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        harness = MiMoHarness(max_steps=20)

        # Always raise an exception to trigger circuit breaker
        mock_client = MagicMock()
        err = Exception("API failure")
        err.status_code = 500
        mock_client.chat.completions.create.side_effect = err

        session = Session(session_id="test")
        with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
            result = harness.run("fail task", session)

        assert "Circuit breaker" in result or "circuit breaker" in result.lower()


class TestTerminationPaths:
    """Test the 4 previously untested termination paths in MiMoHarness.run()."""

    def test_max_duration_termination(self, monkeypatch):
        """Agent stops when time limit is exceeded."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        # max_duration=0 means the time check triggers immediately
        harness = MiMoHarness(max_steps=100, max_duration=0.0)

        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = MagicMock(
            choices=[MagicMock(message=MagicMock(content="hi", tool_calls=None))]
        )

        session = Session(session_id="test")
        with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
            result = harness.run("test task", session)

        assert "LIMIT" in result or "Time limit" in result

    def test_user_abort_termination(self, monkeypatch):
        """Agent stops when graceful abort is requested."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        harness = MiMoHarness(max_steps=10)
        # Pre-request abort before run
        harness.graceful_abort.request()

        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = MagicMock(
            choices=[MagicMock(message=MagicMock(content="hi", tool_calls=None))]
        )

        session = Session(session_id="test")
        with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
            result = harness.run("test task", session)

        assert "ABORTED" in result or "Stopped by user" in result

    def test_model_error_termination(self, monkeypatch):
        """Agent stops when LLM call raises non-retryable error repeatedly."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        harness = MiMoHarness(max_steps=10)

        call_count = 0
        def failing_create(**kwargs):
            nonlocal call_count
            call_count += 1
            raise ValueError("Non-retryable model error")

        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = failing_create

        session = Session(session_id="test")
        with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
            result = harness.run("test task", session)

        # After enough failures, circuit breaker should open
        assert "ERROR" in result or "Circuit breaker" in result or "failures" in result
        assert call_count >= 1

    def test_token_limit_termination(self, monkeypatch):
        """Agent stops when token budget is exceeded."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        harness = MiMoHarness(max_steps=10)
        # Force token budget to be blocked
        harness.token_budget.effective_max = 1
        harness.token_budget.estimated_tokens = 999999

        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = MagicMock(
            choices=[MagicMock(message=MagicMock(content="hi", tool_calls=None))]
        )

        session = Session(session_id="test")
        with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
            result = harness.run("test task", session)

        assert "Token budget" in result or "TOKEN_LIMIT" in result or "ERROR" in result

    def test_retry_exhaustion(self, monkeypatch):
        """retry_with_backoff raises after max retries exhausted."""
        from mimo_harness.agent import retry_with_backoff

        call_count = 0
        def always_fail():
            nonlocal call_count
            call_count += 1
            err = Exception("Rate limited")
            err.status_code = 429
            raise err

        import pytest
        with pytest.raises(Exception, match="Rate limited"):
            retry_with_backoff(always_fail, max_retries=2, base_delay=0.001)

        assert call_count >= 2  # At least initial + retries

    def test_retry_503(self, monkeypatch):
        """retry_with_backoff retries on 503 errors."""
        from mimo_harness.agent import retry_with_backoff

        call_count = 0
        def fail_then_succeed():
            nonlocal call_count
            call_count += 1
            if call_count < 2:
                err = Exception("Service unavailable")
                err.status_code = 503
                raise err
            return "success"

        result = retry_with_backoff(fail_then_succeed, max_retries=3, base_delay=0.001)
        assert result == "success"
        assert call_count == 2


class TestBareMode:
    """Test bare mode skips memory loading."""

    def test_bare_mode_system_prompt(self, monkeypatch):
        """Bare mode should produce a minimal system prompt without memory."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        harness = MiMoHarness(bare=True)
        prompt = harness._build_system_prompt()
        # Bare mode should not load CLAUDE.md or MEMORY.md content
        assert isinstance(prompt, str)
        assert len(prompt) > 0


class TestRunStreamMode:
    """Test run() with stream=True (root function branch)."""

    def test_run_stream_mode_returns_final(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        harness = MiMoHarness(max_steps=3, auto_approve=True, stream=True)

        # Mock _stream_llm_call to return a synthetic response
        from mimo_harness.agent import _AttrBag
        synthetic_msg = _AttrBag(
            content="Streamed response",
            tool_calls=None,
            model_dump=lambda: {"role": "assistant", "content": "Streamed response", "tool_calls": None},
        )
        synthetic_choice = _AttrBag(message=synthetic_msg, finish_reason="stop")
        synthetic_response = _AttrBag(choices=[synthetic_choice])

        with patch.object(harness, '_stream_llm_call', return_value=synthetic_response):
            session = Session(session_id="stream-test")
            result = harness.run("test streaming", session)

        assert result == "Streamed response"


class TestRunFallbackModel:
    """Test run() with fallback_model on 429/503 (root function branch)."""

    def test_run_fallback_model_on_429(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        harness = MiMoHarness(max_steps=3, auto_approve=True, fallback_model="fallback-model")

        # Primary model always fails with 429, fallback succeeds
        err_429 = Exception("Rate limited")
        err_429.status_code = 429

        resp_ok = MagicMock()
        resp_ok.choices = [MagicMock()]
        resp_ok.choices[0].message.content = "Fallback answer"
        resp_ok.choices[0].message.tool_calls = None

        models_used = []

        def mock_create(**kwargs):
            models_used.append(kwargs.get("model"))
            if kwargs.get("model") == "test-model":
                raise err_429
            return resp_ok

        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = mock_create

        session = Session(session_id="fallback-test")
        with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
            result = harness.run("test fallback", session)

        assert "Fallback answer" in result
        assert "fallback-model" in models_used


class TestRunDefaultSession:
    """Test run() creates default session when None (root function branch)."""

    def test_run_creates_default_session(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        harness = MiMoHarness(max_steps=1, auto_approve=True)

        resp = MagicMock()
        resp.choices = [MagicMock()]
        resp.choices[0].message.content = "done"
        resp.choices[0].message.tool_calls = None

        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = resp

        with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
            result = harness.run("test default session")

        assert result == "done"


class TestRunToolCallJsonParseError:
    """Test run() handles malformed tool call arguments (root function branch)."""

    def test_run_malformed_tool_arguments(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        harness = MiMoHarness(max_steps=3, auto_approve=True)

        # First response: tool call with invalid JSON arguments
        tc = MagicMock()
        tc.id = "tc_bad"
        tc.function = MagicMock()
        tc.function.name = "calculator"
        tc.function.arguments = "not valid json {{{"

        resp1 = MagicMock()
        resp1.choices = [MagicMock()]
        resp1.choices[0].message.content = ""
        resp1.choices[0].message.tool_calls = [tc]
        resp1.choices[0].message.model_dump.return_value = {
            "role": "assistant", "content": "",
            "tool_calls": [{"id": "tc_bad", "type": "function",
                           "function": {"name": "calculator", "arguments": "not valid json {{{"}}],
        }

        resp2 = MagicMock()
        resp2.choices = [MagicMock()]
        resp2.choices[0].message.content = "handled"
        resp2.choices[0].message.tool_calls = None

        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = [resp1, resp2]

        session = Session(session_id="parse-err")
        with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
            result = harness.run("test malformed args", session)

        assert "handled" in result
        # Should have a tool message with parse error
        tool_msgs = [m for m in session.messages if m.get("role") == "tool"]
        assert len(tool_msgs) >= 1
        assert "parse_error" in tool_msgs[0].get("content", "") or "error" in tool_msgs[0].get("content", "").lower()


class TestRunStopHook:
    """Test run() fires STOP hook on completion (root function branch)."""

    def test_run_fires_stop_hook(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        harness = MiMoHarness(max_steps=3, auto_approve=True)

        resp = MagicMock()
        resp.choices = [MagicMock()]
        resp.choices[0].message.content = "task done"
        resp.choices[0].message.tool_calls = None

        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = resp

        # Attach a mock hook runner
        mock_hook_runner = MagicMock()
        harness._hook_runner = mock_hook_runner

        session = Session(session_id="hook-test")
        with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
            result = harness.run("test stop hook", session)

        assert result == "task done"
        # Verify STOP hook was fired
        mock_hook_runner.run_hooks.assert_called()
        call_args = mock_hook_runner.run_hooks.call_args
        from mimo_harness.hooks import HookEvent
        assert call_args[0][0] == HookEvent.STOP


class TestRunSequentialToolCalls:
    """Test run() with non-concurrency-safe tool calls (root function branch)."""

    def test_run_sequential_tool_calls(self, monkeypatch, tmp_path):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        from mimo_harness.tools import file_ops
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)

        harness = MiMoHarness(max_steps=3, auto_approve=True)

        # write_file is not concurrency-safe
        tc = MagicMock()
        tc.id = "tc_write"
        tc.function = MagicMock()
        tc.function.name = "write_file"
        tc.function.arguments = json.dumps({"path": str(tmp_path / "test.txt"), "content": "hello"})

        resp1 = MagicMock()
        resp1.choices = [MagicMock()]
        resp1.choices[0].message.content = ""
        resp1.choices[0].message.tool_calls = [tc]
        resp1.choices[0].message.model_dump.return_value = {
            "role": "assistant", "content": "",
            "tool_calls": [{"id": "tc_write", "type": "function",
                           "function": {"name": "write_file",
                                       "arguments": json.dumps({"path": str(tmp_path / "test.txt"), "content": "hello"})}}],
        }

        resp2 = MagicMock()
        resp2.choices = [MagicMock()]
        resp2.choices[0].message.content = "Written!"
        resp2.choices[0].message.tool_calls = None

        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = [resp1, resp2]

        session = Session(session_id="seq-test")
        with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
            result = harness.run("write a file", session)

        assert "Written!" in result
        tool_msgs = [m for m in session.messages if m.get("role") == "tool"]
        assert len(tool_msgs) >= 1
