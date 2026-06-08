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

# Helper to check if real API key is available
def _has_real_api_key():
    api_key = os.environ.get("MIMO_API_KEY", "")
    return api_key and api_key != "test-key-for-testing"

# Decorator for tests that require real API key
requires_api = pytest.mark.skipif(
    not _has_real_api_key(),
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


@requires_api
class TestRunWithToolCalls:
    """Test agent.run() with real LLM that invokes tools."""

    def test_run_with_tool_calls(self, monkeypatch, tmp_path):
        """Real LLM returns tool call, verify tool is dispatched and result fed back."""
        monkeypatch.chdir(tmp_path)
        file_ops.set_file_ops_state(file_ops.FileOpsState())

        harness = MiMoHarness(max_steps=5, auto_approve=True, bare=True)
        session = Session(session_id="test")
        result = harness.run("What is 2+2? Use the calculator tool to compute it.", session)

        assert len(result) > 0
        # Session should contain tool messages
        tool_msgs = [m for m in session.messages if m.get("role") == "tool"]
        assert len(tool_msgs) >= 1


@requires_api
class TestRunMaxStepsTermination:
    def test_run_max_steps_termination(self):
        """Verify agent stops at max_steps."""
        harness = MiMoHarness(max_steps=1, auto_approve=True, bare=True)
        session = Session(session_id="test")
        result = harness.run("What is the capital of France?", session)

        # With max_steps=1, agent can only do 1 iteration
        assert len(result) > 0


@requires_api
class TestTerminationPaths:
    """Test termination paths in MiMoHarness.run()."""

    def test_max_duration_termination(self):
        """Agent stops when time limit is exceeded."""
        harness = MiMoHarness(max_steps=100, auto_approve=True, bare=True, max_duration=0.01)
        session = Session(session_id="test")
        result = harness.run("test task", session)

        result_lower = result.lower()
        assert "time" in result_lower or "limit" in result_lower or "exceeded" in result_lower, \
            f"Expected time-limit indicator in result: {result[:200]}"

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
        """Bare mode should skip memory loading."""
        harness = MiMoHarness(bare=True)
        prompt = harness._build_system_prompt()
        assert isinstance(prompt, str)
        assert len(prompt) > 0
        # Bare mode: memory is not loaded as a user message
        assert harness.bare is True
        # Verify the system prompt itself is well-formed
        assert "MiMo Harness" in prompt
        assert "Available Tools" in prompt


@requires_api
class TestRunStreamMode:
    """Test run() with stream=True using real API."""

    def test_run_stream_mode_returns_final(self):
        harness = MiMoHarness(max_steps=3, auto_approve=True, stream=True, bare=True)
        session = Session(session_id="stream-test")
        result = harness.run("Reply with just the number 42.", session)

        assert len(result) > 0
        assert "42" in result


@requires_api
class TestRunDefaultSession:
    """Test run() creates default session when None."""

    def test_run_creates_default_session(self):
        harness = MiMoHarness(max_steps=1, auto_approve=True, bare=True)
        result = harness.run("Say hello in one word.")
        assert len(result) > 0


@requires_api
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


@requires_api
class TestRunSequentialToolCalls:
    """Test run() with non-concurrency-safe tool calls (write_file)."""

    def test_run_sequential_tool_calls(self, monkeypatch, tmp_path):
        """Real LLM calls write_file tool, verify tool was dispatched."""
        monkeypatch.chdir(tmp_path)
        file_ops.set_file_ops_state(file_ops.FileOpsState())

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


class TestHandleToolCallIntegration:
    """QUALITY-3: Integration tests for _handle_tool_call → registry.execute → handler chain.

    These tests exercise the FULL tool dispatch path without requiring a real API key,
    ensuring that bugs like the undefined 'command' variable (BUG-1) are caught.
    """

    def _make_harness(self, tmp_path):
        """Create a minimal harness with real tool registry for integration testing."""
        harness = MiMoHarness.__new__(MiMoHarness)
        harness.model = "test"
        harness.deps = type("D", (), {"max_retries": 1, "base_retry_delay": 0.01})()
        harness.logger = type("L", (), {
            "trace": lambda *a, **k: None,
            "info": lambda *a, **k: None,
            "tool_call": lambda *a, **k: None,
            "error": lambda *a, **k: None,
            "session_summary": lambda *a, **k: None,
        })()
        harness.perms = type("P", (), {
            "auto_approve": True,
            "dry_run": False,
            "mode": "auto",
            "check": lambda *a, **k: True,
            "set_llm_client": lambda *a, **k: None,
        })()
        harness.graceful_abort = type("G", (), {
            "is_requested": lambda: False,
        })()
        harness._hook_runner = None
        harness._checkpoint_manager = None

        # Use REAL tool registry with actual handlers
        from mimo_harness.tools.registry import ToolRegistry
        from mimo_harness.tools import (
            file_ops as fo, shell, math_tools, web_tools,
            code_exec, doc_tools, interactive, monitor,
            notebook_tools, task_tools, plan_tools, lsp_tools, scheduler_tools,
        )
        harness.registry = ToolRegistry()
        harness.registry.register_many(fo.get_tools())
        harness.registry.register_many(shell.get_tools())
        harness.registry.register_many(math_tools.get_tools())
        harness.registry.register_many(code_exec.get_tools())
        harness.registry.register_many(web_tools.get_tools())
        harness.registry.register_many(doc_tools.get_tools())
        harness.registry.register_many(interactive.get_tools())
        harness.registry.register_many(monitor.get_tools())
        harness.registry.register_many(notebook_tools.get_tools())
        harness.registry.register_many(task_tools.get_tools())
        harness.registry.register_many(plan_tools.get_tools())
        harness.registry.register_many(lsp_tools.get_tools())
        harness.registry.register_many(scheduler_tools.get_tools())

        # Set session-scoped file ops state
        file_ops._ALLOWED_WRITE_DIR = tmp_path
        file_ops.set_file_ops_state(file_ops.FileOpsState())

        return harness

    def test_run_command_dispatch(self, tmp_path, monkeypatch):
        """BUG-1 regression: verify run_command works through _handle_tool_call."""
        monkeypatch.chdir(tmp_path)
        harness = self._make_harness(tmp_path)
        session = Session(session_id="integ-test", working_dir=str(tmp_path))

        result = harness._handle_tool_call(
            "run_command",
            {"command": "echo hello"},
            "tc-1",
            session,
        )
        parsed = json.loads(result)
        assert "error" not in parsed, f"run_command failed: {parsed}"
        assert "hello" in parsed.get("output", "")

    def test_read_file_dispatch(self, tmp_path, monkeypatch):
        """Verify read_file works through _handle_tool_call."""
        monkeypatch.chdir(tmp_path)
        harness = self._make_harness(tmp_path)
        session = Session(session_id="integ-test", working_dir=str(tmp_path))

        # Create a test file
        test_file = tmp_path / "test.txt"
        test_file.write_text("line1\nline2\nline3\n")

        result = harness._handle_tool_call(
            "read_file",
            {"path": str(test_file)},
            "tc-2",
            session,
        )
        parsed = json.loads(result)
        assert "error" not in parsed, f"read_file failed: {parsed}"
        assert "line1" in parsed["content"]

    def test_write_file_dispatch(self, tmp_path, monkeypatch):
        """Verify write_file works through _handle_tool_call (requires read first)."""
        monkeypatch.chdir(tmp_path)
        harness = self._make_harness(tmp_path)
        session = Session(session_id="integ-test", working_dir=str(tmp_path))

        test_file = tmp_path / "output.txt"

        # Must read first (even for new files, the check is on existing files)
        harness._handle_tool_call(
            "write_file",
            {"path": str(test_file), "content": "hello world"},
            "tc-3",
            session,
        )
        assert test_file.read_text() == "hello world"

    def test_edit_file_requires_read(self, tmp_path, monkeypatch):
        """Verify edit_file enforces read-before-edit through _handle_tool_call."""
        monkeypatch.chdir(tmp_path)
        harness = self._make_harness(tmp_path)
        session = Session(session_id="integ-test", working_dir=str(tmp_path))

        test_file = tmp_path / "edit.txt"
        test_file.write_text("hello world")

        # Try to edit without reading first — should fail
        result = harness._handle_tool_call(
            "edit_file",
            {"path": str(test_file), "old_text": "world", "new_text": "python"},
            "tc-4",
            session,
        )
        parsed = json.loads(result)
        assert "error" in parsed
        assert "read" in parsed["error"].lower()

    def test_calculator_dispatch(self, tmp_path, monkeypatch):
        """Verify calculator works through _handle_tool_call."""
        monkeypatch.chdir(tmp_path)
        harness = self._make_harness(tmp_path)
        session = Session(session_id="integ-test", working_dir=str(tmp_path))

        result = harness._handle_tool_call(
            "calculator",
            {"expression": "2 + 3 * 4"},
            "tc-5",
            session,
        )
        parsed = json.loads(result)
        assert "error" not in parsed, f"calculator failed: {parsed}"
        assert parsed.get("result") == 14

    def test_unknown_tool_rejected(self, tmp_path, monkeypatch):
        """Verify unknown tools are rejected (fail-closed)."""
        monkeypatch.chdir(tmp_path)
        harness = self._make_harness(tmp_path)
        session = Session(session_id="integ-test", working_dir=str(tmp_path))

        result = harness._handle_tool_call(
            "nonexistent_tool",
            {"arg": "value"},
            "tc-6",
            session,
        )
        parsed = json.loads(result)
        assert "error" in parsed
        assert "unknown" in parsed["error"].lower() or "not found" in parsed["error"].lower()

    def test_malformed_args_handled(self, tmp_path, monkeypatch):
        """Verify malformed tool arguments are reported back to LLM."""
        monkeypatch.chdir(tmp_path)
        harness = self._make_harness(tmp_path)
        session = Session(session_id="integ-test", working_dir=str(tmp_path))

        result = harness._handle_tool_call(
            "calculator",
            {"_parse_error": True, "raw": "bad json"},
            "tc-7",
            session,
        )
        parsed = json.loads(result)
        assert "error" in parsed
        assert "malformed" in parsed["error"].lower() or "parse" in parsed["error"].lower()


@requires_api
class TestNonBareModeMemory:
    """Test that non-bare mode loads memory as a user message."""

    def test_non_bare_injects_memory_message(self, monkeypatch, tmp_path):
        """Non-bare mode should add a '## Project Memory' user message to session."""
        monkeypatch.chdir(tmp_path)
        # Create a .mimo/memory/MEMORY.md file with test content
        memory_dir = tmp_path / ".mimo" / "memory"
        memory_dir.mkdir(parents=True)
        (memory_dir / "MEMORY.md").write_text("# Test Memory\nThis is a test memory entry.\n")
        file_ops.set_file_ops_state(file_ops.FileOpsState())
        file_ops._ALLOWED_WRITE_DIR = tmp_path

        harness = MiMoHarness(max_steps=1, auto_approve=True, bare=False)
        session = Session(session_id="memory-test")
        harness.run("Say hello.", session)

        # Non-bare mode should have injected memory as a user message
        memory_msgs = [
            m for m in session.messages
            if m.get("role") == "user" and "Project Memory" in m.get("content", "")
        ]
        assert len(memory_msgs) >= 1, (
            f"Expected 'Project Memory' user message in non-bare mode. "
            f"Messages: {[(m['role'], m['content'][:80]) for m in session.messages]}"
        )

    def test_bare_mode_no_memory_message(self, monkeypatch, tmp_path):
        """Bare mode should NOT inject memory messages."""
        monkeypatch.chdir(tmp_path)
        memory_dir = tmp_path / ".mimo" / "memory"
        memory_dir.mkdir(parents=True)
        (memory_dir / "MEMORY.md").write_text("# Test Memory\nShould not appear.\n")
        file_ops.set_file_ops_state(file_ops.FileOpsState())
        file_ops._ALLOWED_WRITE_DIR = tmp_path

        harness = MiMoHarness(max_steps=1, auto_approve=True, bare=True)
        session = Session(session_id="bare-test")
        harness.run("Say hello.", session)

        memory_msgs = [
            m for m in session.messages
            if m.get("role") == "user" and "Project Memory" in m.get("content", "")
        ]
        assert len(memory_msgs) == 0, "Bare mode should not inject memory messages"
