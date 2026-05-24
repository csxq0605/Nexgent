"""Tests for the agent loop (Ch2 patterns)."""

import pytest
import json
from unittest.mock import MagicMock, patch
from mimo_harness.agent import (
    MiMoHarness, AgentDeps, CircuitBreaker, TokenBudget,
    TerminationReason, retry_with_backoff,
)
from mimo_harness.context import Session


class TestCircuitBreaker:
    def test_initial_state(self):
        cb = CircuitBreaker(threshold=3)
        assert not cb.is_open
        assert cb.consecutive_failures == 0

    def test_success_resets_counter(self):
        cb = CircuitBreaker(threshold=3)
        cb.record_failure()
        cb.record_failure()
        cb.record_success()
        assert cb.consecutive_failures == 0
        assert not cb.is_open

    def test_opens_after_threshold(self):
        cb = CircuitBreaker(threshold=3)
        cb.record_failure()
        cb.record_failure()
        cb.record_failure()
        assert cb.is_open
        assert cb.check()

    def test_reset(self):
        cb = CircuitBreaker(threshold=3)
        cb.record_failure()
        cb.record_failure()
        cb.record_failure()
        assert cb.is_open
        cb.reset()
        assert not cb.is_open
        assert cb.consecutive_failures == 0


class TestTokenBudget:
    def test_initial_state(self):
        tb = TokenBudget(max_tokens=100000)
        assert tb.effective_max == 100000 - 4096
        assert tb.estimated_tokens == 0

    def test_usage_ratio(self):
        tb = TokenBudget(max_tokens=100000)
        tb.estimated_tokens = 50000
        ratio = tb.usage_ratio()
        assert 0.5 < ratio < 0.6  # ~52%

    def test_warning_threshold(self):
        tb = TokenBudget(max_tokens=100000)
        tb.estimated_tokens = 85000
        assert tb.is_warning()

    def test_not_warning_below_threshold(self):
        tb = TokenBudget(max_tokens=100000)
        tb.estimated_tokens = 50000
        assert not tb.is_warning()

    def test_blocked_threshold(self):
        tb = TokenBudget(max_tokens=100000)
        tb.estimated_tokens = 96000
        assert tb.is_blocked()

    def test_estimate_messages(self):
        tb = TokenBudget()
        messages = [
            {"role": "user", "content": "hello " * 100},
            {"role": "assistant", "content": "world " * 100},
        ]
        estimate = tb.estimate_message_tokens(messages)
        assert estimate > 0


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


class TestAgentDeps:
    def test_default_deps(self):
        deps = AgentDeps()
        assert deps.max_retries == 3
        assert deps.base_retry_delay == 1.0
        assert len(deps.uuid_generator) == 8

    def test_custom_deps(self):
        deps = AgentDeps(max_retries=5, base_retry_delay=0.5)
        assert deps.max_retries == 5
        assert deps.base_retry_delay == 0.5


class TestMiMoHarnessInit:
    def test_default_init(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        harness = MiMoHarness()
        assert harness.model == "test-model"
        assert harness.max_steps == 20
        assert harness.max_duration == 300.0
        assert isinstance(harness.circuit_breaker, CircuitBreaker)
        assert isinstance(harness.token_budget, TokenBudget)

    def test_custom_init(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        harness = MiMoHarness(
            model="custom-model",
            max_steps=10,
            plan_mode=True,
        )
        assert harness.model == "custom-model"
        assert harness.max_steps == 10
        assert harness.perms.mode.value == "plan"

    def test_tools_registered(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        harness = MiMoHarness()
        tool_names = harness.registry.list_names()
        assert "read_file" in tool_names
        assert "write_file" in tool_names
        assert "run_command" in tool_names
        assert "execute_python" in tool_names
        assert "web_search" in tool_names
        assert "calculator" in tool_names
        assert "create_doc" in tool_names


class TestTerminationReason:
    def test_all_reasons_defined(self):
        assert TerminationReason.COMPLETED.value == "completed"
        assert TerminationReason.MAX_STEPS.value == "max_steps"
        assert TerminationReason.MAX_DURATION.value == "max_duration"
        assert TerminationReason.MODEL_ERROR.value == "model_error"
        assert TerminationReason.CIRCUIT_BREAKER.value == "circuit_breaker"
        assert TerminationReason.TOKEN_LIMIT.value == "token_limit"
        assert TerminationReason.USER_ABORT.value == "user_abort"


class TestCompressionIntegration:
    """Test that agent.run() correctly updates session after compression."""

    def test_session_updated_after_compression(self, monkeypatch):
        """After compression, session.messages should contain the summary."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        from mimo_harness.context import Session, COMPRESS_TRIGGER_TOKENS

        harness = MiMoHarness(max_steps=1)

        # Create a session with enough messages to trigger compression
        session = Session(session_id="test")
        big = "x" * 8000
        for i in range(100):
            session.add_message("user", f"q{i} {big}")
            session.add_message("assistant", f"a{i} {big}")

        # Mock compact_context to return a summary
        summary = [{"role": "assistant", "content": "[Conversation Summary]\nTest summary"}]

        with patch("mimo_harness.agent.compact_context", return_value=summary):
            # Mock the LLM response
            mock_response = MagicMock()
            mock_response.choices = [MagicMock()]
            mock_response.choices[0].message.content = "Done"
            mock_response.choices[0].message.tool_calls = None

            mock_client = MagicMock()
            mock_client.chat.completions.create.return_value = mock_response

            with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
                harness.run("test task", session)

        # Session should contain: summary + re-added user task + final assistant response
        assert len(session.messages) == 3
        assert session.messages[0]["content"] == "[Conversation Summary]\nTest summary"
        assert session.messages[1]["role"] == "user"
        assert session.messages[1]["content"] == "test task"
        assert session.messages[2]["role"] == "assistant"
        assert session.messages[2]["content"] == "Done"
        assert session.compaction_count == 1

    def test_no_compression_when_below_threshold(self, monkeypatch):
        """Session should not be updated when no compression happens."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        harness = MiMoHarness(max_steps=1)

        # Small session, won't trigger compression
        session = Session(session_id="test")
        session.add_message("user", "hello")

        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "Hi there"
        mock_response.choices[0].message.tool_calls = None

        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = mock_response

        with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
            harness.run("hello", session)

        # No compression, messages should be: user("hello") + user(task) + assistant("Hi there")
        assert session.compaction_count == 0
