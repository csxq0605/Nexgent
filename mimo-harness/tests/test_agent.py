"""Tests for the agent loop (Ch2 patterns)."""

import pytest
import json
import threading
from unittest.mock import MagicMock, patch
from mimo_harness.agent import (
    MiMoHarness, AgentDeps, CircuitBreaker, TokenBudget,
    TerminationReason, retry_with_backoff,
)
from mimo_harness.context import Session
from mimo_harness.tools import file_ops


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


class TestParallelToolDispatch:
    """Test that concurrency-safe tools dispatch via ThreadPoolExecutor."""

    def test_parallel_tool_dispatch(self, monkeypatch, tmp_path):
        """Concurrency-safe tools (read_file) run in parallel via ThreadPoolExecutor."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)

        harness = MiMoHarness(max_steps=1, auto_approve=True)

        # Create test files
        for i in range(3):
            (tmp_path / f"f{i}.txt").write_text(f"content {i}")

        # Track thread IDs for each tool call
        call_thread_ids = []
        orig_handle = harness._handle_tool_call

        def tracking_handle(func_name, func_args, tc_id, session):
            call_thread_ids.append(threading.current_thread().ident)
            return orig_handle(func_name, func_args, tc_id, session)

        monkeypatch.setattr(harness, "_handle_tool_call", tracking_handle)

        # Build mock tool calls for read_file (concurrency-safe)
        tool_calls = []
        for i in range(3):
            tc = MagicMock()
            tc.id = f"tc_{i}"
            tc.function = MagicMock()
            tc.function.name = "read_file"
            tc.function.arguments = json.dumps({"path": str(tmp_path / f"f{i}.txt")})
            tool_calls.append(tc)

        resp1 = MagicMock()
        resp1.choices = [MagicMock()]
        resp1.choices[0].message.content = ""
        resp1.choices[0].message.tool_calls = tool_calls
        resp1.choices[0].message.model_dump.return_value = {
            "role": "assistant", "content": "",
            "tool_calls": [
                {"id": f"tc_{i}", "type": "function",
                 "function": {"name": "read_file",
                              "arguments": json.dumps({"path": str(tmp_path / f"f{i}.txt")})}}
                for i in range(3)
            ],
        }

        resp2 = MagicMock()
        resp2.choices = [MagicMock()]
        resp2.choices[0].message.content = "All files read."
        resp2.choices[0].message.tool_calls = None

        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = [resp1, resp2]

        session = Session(session_id="test")
        with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
            result = harness.run("read all files", session)

        # All 3 tool results captured in session
        tool_msgs = [m for m in session.messages if m.get("role") == "tool"]
        assert len(tool_msgs) == 3

        # Tools ran from non-main threads (ThreadPoolExecutor worker threads)
        main_thread_id = threading.main_thread().ident
        assert any(tid != main_thread_id for tid in call_thread_ids)

    def test_sequential_tool_dispatch(self, monkeypatch, tmp_path):
        """Non-concurrency-safe tools (write_file) run sequentially."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)

        harness = MiMoHarness(max_steps=1, auto_approve=True)

        # Track execution order and threads
        execution_order = []
        call_thread_ids = []
        orig_handle = harness._handle_tool_call

        def tracking_handle(func_name, func_args, tc_id, session):
            execution_order.append(func_name)
            call_thread_ids.append(threading.current_thread().ident)
            return orig_handle(func_name, func_args, tc_id, session)

        monkeypatch.setattr(harness, "_handle_tool_call", tracking_handle)

        # write_file is NOT concurrency-safe
        tool_calls = []
        for i in range(3):
            tc = MagicMock()
            tc.id = f"tc_{i}"
            tc.function = MagicMock()
            tc.function.name = "write_file"
            tc.function.arguments = json.dumps({
                "path": str(tmp_path / f"out{i}.txt"),
                "content": f"data {i}",
            })
            tool_calls.append(tc)

        resp1 = MagicMock()
        resp1.choices = [MagicMock()]
        resp1.choices[0].message.content = ""
        resp1.choices[0].message.tool_calls = tool_calls
        resp1.choices[0].message.model_dump.return_value = {
            "role": "assistant", "content": "",
            "tool_calls": [
                {"id": f"tc_{i}", "type": "function",
                 "function": {"name": "write_file",
                              "arguments": json.dumps({
                                  "path": str(tmp_path / f"out{i}.txt"),
                                  "content": f"data {i}",
                              })}}
                for i in range(3)
            ],
        }

        resp2 = MagicMock()
        resp2.choices = [MagicMock()]
        resp2.choices[0].message.content = "Files written."
        resp2.choices[0].message.tool_calls = None

        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = [resp1, resp2]

        session = Session(session_id="test")
        with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
            result = harness.run("write all files", session)

        # All 3 tools executed sequentially
        assert len(execution_order) == 3
        assert all(name == "write_file" for name in execution_order)
        # All ran on the main thread (no ThreadPoolExecutor for non-safe tools)
        main_thread_id = threading.main_thread().ident
        assert all(tid == main_thread_id for tid in call_thread_ids)
        # Files were created
        for i in range(3):
            assert (tmp_path / f"out{i}.txt").read_text() == f"data {i}"


class TestStreamingMode:
    """Test streaming response parameter propagation."""

    def test_streaming_mode_uses_stream_method(self, monkeypatch):
        """When stream=True, agent dispatches via _stream_llm_call."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        harness = MiMoHarness(max_steps=1, stream=True)
        assert harness.stream is True

        stream_called = []

        def mock_stream(client, messages, tools_schema):
            stream_called.append(True)
            resp = MagicMock()
            resp.choices = [MagicMock()]
            resp.choices[0].message.content = "Streamed response"
            resp.choices[0].message.tool_calls = None
            return resp

        monkeypatch.setattr(harness, "_stream_llm_call", mock_stream)

        mock_client = MagicMock()

        session = Session(session_id="test")
        with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
            result = harness.run("test task", session)

        assert len(stream_called) == 1
        assert result == "Streamed response"

    def test_non_streaming_uses_regular_call(self, monkeypatch):
        """When stream=False (default), agent uses regular LLM call."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        harness = MiMoHarness(max_steps=1, stream=False)
        assert harness.stream is False

        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "Regular response"
        mock_response.choices[0].message.tool_calls = None

        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = mock_response

        session = Session(session_id="test")
        with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
            result = harness.run("test task", session)

        assert result == "Regular response"
        mock_client.chat.completions.create.assert_called_once()


class TestClaudeMdSurvivesCompact:
    """Test that memory is re-loaded after context compression."""

    def test_claude_md_survives_compact(self, monkeypatch):
        """After compaction, memory (CLAUDE.md, MEMORY.md) is re-loaded into session."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        harness = MiMoHarness(max_steps=1)
        session = Session(session_id="test")

        # Fill session to trigger compression
        big = "x" * 8000
        for i in range(100):
            session.add_message("user", f"q{i} {big}")
            session.add_message("assistant", f"a{i} {big}")

        # Mock compact_context to return a summary (triggers compression path)
        summary = [{"role": "assistant", "content": "[Conversation Summary]"}]
        # Mock load_memory to return CLAUDE.md content
        memory_text = "# CLAUDE.md\nThis is the project memory"

        with patch("mimo_harness.agent.compact_context", return_value=summary), \
             patch("mimo_harness.agent.load_memory", return_value=memory_text):

            mock_response = MagicMock()
            mock_response.choices = [MagicMock()]
            mock_response.choices[0].message.content = "Done"
            mock_response.choices[0].message.tool_calls = None

            mock_client = MagicMock()
            mock_client.chat.completions.create.return_value = mock_response

            with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
                harness.run("test task", session)

        # Memory was re-loaded and inserted into session
        assert any(
            "This is the project memory" in m.get("content", "")
            for m in session.messages
        )
        assert session.compaction_count == 1

    def test_claude_md_not_reloaded_without_compaction(self, monkeypatch):
        """Memory is not re-loaded when no compaction occurs."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        harness = MiMoHarness(max_steps=1)
        session = Session(session_id="test")
        session.add_message("user", "hello")

        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "Hi there"
        mock_response.choices[0].message.tool_calls = None

        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = mock_response

        load_memory_calls = []
        original_load_memory = __import__(
            "mimo_harness.context", fromlist=["load_memory"]
        ).load_memory

        def tracking_load_memory(*args, **kwargs):
            load_memory_calls.append(True)
            return original_load_memory(*args, **kwargs)

        with patch("mimo_harness.agent.load_memory", side_effect=tracking_load_memory):
            with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
                harness.run("hello", session)

        # No compaction happened, load_memory was only called during system prompt build
        # (not for re-loading after compression)
        assert session.compaction_count == 0
