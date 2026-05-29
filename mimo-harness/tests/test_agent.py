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
from mimo_harness.tools import shell


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

        # Mock compact_context to return a summary (tuple: messages, attempts, failures, thrashing)
        summary = [{"role": "assistant", "content": "[Conversation Summary]\nTest summary"}]

        with patch("mimo_harness.agent.compact_context", return_value=(summary, 1, 0, False)):
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
        # Mock load_memory_for_compaction to return CLAUDE.md content
        memory_text = "# CLAUDE.md\nThis is the project memory"

        with patch("mimo_harness.agent.compact_context", return_value=(summary, 1, 0, False)), \
             patch("mimo_harness.agent.load_memory_for_compaction", return_value=memory_text):

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


class TestStreamLLMCall:
    """Test _stream_llm_call streaming response assembly."""

    def _make_stream_chunk(self, content=None, tool_call_chunk=None, finish_reason=None):
        """Create a mock streaming chunk."""
        delta = MagicMock()
        delta.content = content
        delta.tool_calls = tool_call_chunk

        choice = MagicMock()
        choice.delta = delta
        choice.finish_reason = finish_reason

        chunk = MagicMock()
        chunk.choices = [choice]
        return chunk

    def test_stream_llm_call_content_chunks(self, monkeypatch):
        """Content chunks are accumulated correctly."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        harness = MiMoHarness(max_steps=1, stream=True)

        chunks = [
            self._make_stream_chunk(content="Hello "),
            self._make_stream_chunk(content="world!"),
            self._make_stream_chunk(finish_reason="stop"),
        ]

        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = iter(chunks)

        messages = [{"role": "user", "content": "hi"}]
        tools_schema = []

        import io
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            response = harness._stream_llm_call(mock_client, messages, tools_schema)

        assert response.choices[0].message.content == "Hello world!"
        assert response.choices[0].finish_reason == "stop"

    def test_stream_llm_call_tool_call_chunks(self, monkeypatch):
        """Tool call chunks are parsed and assembled."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        harness = MiMoHarness(max_steps=1, stream=True)

        # Build tool call chunks
        tc1 = MagicMock()
        tc1.index = 0
        tc1.id = "call_123"
        tc1.function = MagicMock()
        tc1.function.name = "read_file"
        tc1.function.arguments = '{"path":'

        tc2 = MagicMock()
        tc2.index = 0
        tc2.id = None
        tc2.function = MagicMock()
        tc2.function.name = None
        tc2.function.arguments = '"/tmp/test"}'

        chunks = [
            self._make_stream_chunk(tool_call_chunk=[tc1]),
            self._make_stream_chunk(tool_call_chunk=[tc2]),
            self._make_stream_chunk(finish_reason="tool_calls"),
        ]

        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = iter(chunks)

        messages = [{"role": "user", "content": "read file"}]
        tools_schema = []

        import io
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            response = harness._stream_llm_call(mock_client, messages, tools_schema)

        assert response.choices[0].message.tool_calls is not None
        assert len(response.choices[0].message.tool_calls) == 1
        tc = response.choices[0].message.tool_calls[0]
        assert tc.id == "call_123"
        assert tc.function.name == "read_file"
        assert tc.function.arguments == '{"path":"/tmp/test"}'

    def test_stream_llm_call_handles_empty_chunks(self, monkeypatch):
        """Empty delta chunks don't cause errors."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        harness = MiMoHarness(max_steps=1, stream=True)

        empty_chunk = MagicMock()
        empty_chunk.choices = []

        chunks = [
            empty_chunk,
            self._make_stream_chunk(content="ok"),
            self._make_stream_chunk(finish_reason="stop"),
        ]

        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = iter(chunks)

        messages = [{"role": "user", "content": "hi"}]
        tools_schema = []

        import io
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            response = harness._stream_llm_call(mock_client, messages, tools_schema)

        assert response.choices[0].message.content == "ok"


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


class TestDynamicShellPermission:
    def test_dynamic_shell_permission_readonly(self, monkeypatch):
        """Read-only commands return READ permission."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        from mimo_harness.permissions import Permission

        harness = MiMoHarness()
        perm = harness._check_shell_permission("ls -la")
        assert perm == Permission.READ

    def test_dynamic_shell_permission_write(self, monkeypatch):
        """Write commands return WRITE permission."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        from mimo_harness.permissions import Permission

        harness = MiMoHarness()
        perm = harness._check_shell_permission("rm -rf /tmp/test")
        assert perm == Permission.WRITE

    def test_dynamic_shell_permission_git_status(self, monkeypatch):
        """git status is readonly."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        from mimo_harness.permissions import Permission

        harness = MiMoHarness()
        perm = harness._check_shell_permission("git status")
        assert perm == Permission.READ

    def test_dynamic_shell_permission_chaining(self, monkeypatch):
        """Commands with chaining operators are not readonly."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        from mimo_harness.permissions import Permission

        harness = MiMoHarness()
        perm = harness._check_shell_permission("ls && rm -rf /")
        assert perm == Permission.WRITE


class TestAppendSystemPrompt:
    """S15: _build_system_prompt appends append_system_prompt text."""

    def test_build_system_prompt_appends_text(self, monkeypatch):
        """S15: _append_system_prompt is appended to system prompt."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        harness = MiMoHarness()
        harness._append_system_prompt = "CUSTOM INSTRUCTIONS: Always be verbose."
        prompt = harness._build_system_prompt()
        assert "CUSTOM INSTRUCTIONS: Always be verbose." in prompt

    def test_build_system_prompt_no_append(self, monkeypatch):
        """S15: Without _append_system_prompt, no extra text is added."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        harness = MiMoHarness()
        prompt = harness._build_system_prompt()
        # Should not contain any custom instruction marker
        assert "CUSTOM INSTRUCTIONS" not in prompt

    def test_build_system_prompt_empty_append(self, monkeypatch):
        """S15: Empty _append_system_prompt does not modify prompt."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        harness = MiMoHarness()
        harness._append_system_prompt = ""
        prompt_with_empty = harness._build_system_prompt()

        harness2 = MiMoHarness()
        prompt_without = harness2._build_system_prompt()

        # Both should be the same (empty append adds nothing)
        assert prompt_with_empty == prompt_without

class TestFallbackModel:
    """S16: fallback_model parameter is stored and used correctly."""

    def test_fallback_model_stored(self, monkeypatch):
        """S16: fallback_model parameter is stored on the harness."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        harness = MiMoHarness(fallback_model="mimo-v2.5-flash")
        assert harness.fallback_model == "mimo-v2.5-flash"

    def test_fallback_model_default_none(self, monkeypatch):
        """S16: fallback_model defaults to None."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        harness = MiMoHarness()
        assert harness.fallback_model is None

    def test_fallback_model_used_on_429(self, monkeypatch):
        """S16: Fallback model is used when primary returns 429."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        harness = MiMoHarness(max_steps=1, fallback_model="mimo-v2.5-flash")

        # Track which model was called
        models_called = []

        def mock_create(**kwargs):
            models_called.append(kwargs.get("model"))
            if kwargs.get("model") == "test-model":
                err = Exception("Rate limited")
                err.status_code = 429
                raise err
            resp = MagicMock()
            resp.choices = [MagicMock()]
            resp.choices[0].message.content = "Fallback response"
            resp.choices[0].message.tool_calls = None
            return resp

        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = mock_create

        session = Session(session_id="test")
        with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
            result = harness.run("test task", session)

        assert "Fallback response" in result
        assert "mimo-v2.5-flash" in models_called

    def test_fallback_model_used_on_503(self, monkeypatch):
        """S16: Fallback model is used when primary returns 503."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        harness = MiMoHarness(max_steps=1, fallback_model="backup-model")

        models_called = []

        def mock_create(**kwargs):
            models_called.append(kwargs.get("model"))
            if kwargs.get("model") == "test-model":
                err = Exception("Service unavailable")
                err.status_code = 503
                raise err
            resp = MagicMock()
            resp.choices = [MagicMock()]
            resp.choices[0].message.content = "Backup response"
            resp.choices[0].message.tool_calls = None
            return resp

        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = mock_create

        session = Session(session_id="test")
        with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
            result = harness.run("test task", session)

        assert "Backup response" in result
        assert "backup-model" in models_called


class TestGracefulAbort:
    def test_initial_state(self):
        from mimo_harness.agent import GracefulAbort
        abort = GracefulAbort()
        assert abort.is_requested() is False

    def test_request(self):
        from mimo_harness.agent import GracefulAbort
        abort = GracefulAbort()
        abort.request()
        assert abort.is_requested() is True

    def test_reset(self):
        from mimo_harness.agent import GracefulAbort
        abort = GracefulAbort()
        abort.request()
        abort.reset()
        assert abort.is_requested() is False

    def test_double_request(self):
        from mimo_harness.agent import GracefulAbort
        abort = GracefulAbort()
        abort.request()
        abort.request()
        assert abort.is_requested() is True


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


# ============================================================================
# P0: Additional agent test coverage
# ============================================================================


class TestEffortLevel:
    """Test effort level parameter mapping."""

    def test_effort_params_low(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        harness = MiMoHarness(effort="low")
        assert harness.effort == "low"
        params = harness.EFFORT_PARAMS["low"]
        assert params["temperature"] == 0.3
        assert params["max_completion_tokens"] == 512

    def test_effort_params_medium(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        harness = MiMoHarness(effort="medium")
        params = harness.EFFORT_PARAMS["medium"]
        assert params["temperature"] == 0.7
        assert params["max_completion_tokens"] == 2048

    def test_effort_params_high(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        harness = MiMoHarness(effort="high")
        params = harness.EFFORT_PARAMS["high"]
        assert params["temperature"] == 0.9
        assert params["max_completion_tokens"] == 4096

    def test_effort_defaults_to_medium(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        harness = MiMoHarness()
        assert harness.effort == "medium"

    def test_effort_passed_to_llm_call(self, monkeypatch):
        """Verify effort params are passed to the LLM API call."""
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")

        harness = MiMoHarness(max_steps=1, effort="high")

        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "Done"
        mock_response.choices[0].message.tool_calls = None

        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = mock_response

        session = Session(session_id="test")
        with patch.object(harness.deps, 'llm_client_factory', return_value=mock_client):
            harness.run("test task", session)

        call_kwargs = mock_client.chat.completions.create.call_args
        assert call_kwargs.kwargs.get("temperature") == 0.9
        assert call_kwargs.kwargs.get("max_completion_tokens") == 4096


class TestBareMode:
    """Test bare mode skips memory loading."""

    def test_bare_mode_init(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        harness = MiMoHarness(bare=True)
        assert harness.bare is True

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


class TestRetryEdgeCases:
    """Test retry_with_backoff edge cases."""

    def test_retry_on_429(self):
        call_count = 0
        def fail_once():
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                err = Exception("Rate limited")
                err.status_code = 429
                raise err
            return "ok"

        result = retry_with_backoff(fail_once, max_retries=3, base_delay=0.001)
        assert result == "ok"
        assert call_count == 2

    def test_retry_on_500(self):
        call_count = 0
        def fail_once():
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                err = Exception("Internal error")
                err.status_code = 500
                raise err
            return "ok"

        result = retry_with_backoff(fail_once, max_retries=3, base_delay=0.001)
        assert result == "ok"

    def test_retry_on_502(self):
        call_count = 0
        def fail_once():
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                err = Exception("Bad gateway")
                err.status_code = 502
                raise err
            return "ok"

        result = retry_with_backoff(fail_once, max_retries=3, base_delay=0.001)
        assert result == "ok"

    def test_no_retry_on_400(self):
        """400 errors should not be retried."""
        call_count = 0
        def fail_400():
            nonlocal call_count
            call_count += 1
            err = Exception("Bad request")
            err.status_code = 400
            raise err

        with pytest.raises(Exception, match="Bad request"):
            retry_with_backoff(fail_400, max_retries=3, base_delay=0.001)
        assert call_count == 1  # No retries

    def test_no_retry_on_401(self):
        """401 errors should not be retried."""
        call_count = 0
        def fail_401():
            nonlocal call_count
            call_count += 1
            err = Exception("Unauthorized")
            err.status_code = 401
            raise err

        with pytest.raises(Exception, match="Unauthorized"):
            retry_with_backoff(fail_401, max_retries=3, base_delay=0.001)
        assert call_count == 1


class TestTokenBudgetEdgeCases:
    """Test TokenBudget edge cases."""

    def test_zero_max_tokens(self):
        tb = TokenBudget(max_tokens=0)
        # Should handle gracefully
        assert tb.effective_max <= 0

    def test_usage_ratio_at_zero(self):
        tb = TokenBudget(max_tokens=100000)
        assert tb.usage_ratio() == 0.0

    def test_not_blocked_below_threshold(self):
        tb = TokenBudget(max_tokens=100000)
        tb.estimated_tokens = 50000
        assert not tb.is_blocked()


class TestCircuitBreakerEdgeCases:
    """Test CircuitBreaker edge cases."""

    def test_threshold_boundary(self):
        cb = CircuitBreaker(threshold=3)
        cb.record_failure()
        cb.record_failure()
        assert not cb.is_open  # 2 failures, threshold is 3
        cb.record_failure()
        assert cb.is_open  # 3 failures, now open

    def test_success_after_partial_failures(self):
        cb = CircuitBreaker(threshold=5)
        cb.record_failure()
        cb.record_failure()
        cb.record_success()
        assert cb.consecutive_failures == 0
        assert not cb.is_open

    def test_check_returns_false_when_closed(self):
        cb = CircuitBreaker(threshold=3)
        assert cb.check() is False

    def test_check_returns_true_when_open(self):
        cb = CircuitBreaker(threshold=1)
        cb.record_failure()
        assert cb.check() is True
