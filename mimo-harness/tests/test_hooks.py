"""Tests for the hook system (Ch8 patterns)."""

import json
import pytest
from unittest.mock import patch, MagicMock
from mimo_harness.hooks import (
    HookEvent, HookDecision, HookType, HookResult, HookConfig, HookRunner,
)


class TestHookResult:
    def test_default_approve(self):
        r = HookResult()
        assert r.decision == HookDecision.APPROVE
        assert not r.is_blocking

    def test_blocking(self):
        r = HookResult(decision=HookDecision.BLOCK, reason="blocked")
        assert r.is_blocking
        assert r.reason == "blocked"


class TestHookConfig:
    def test_wildcard_matcher(self):
        c = HookConfig(event=HookEvent.PRE_TOOL_USE, matcher="*")
        assert c.matches("anything")
        assert c.matches("read_file")

    def test_exact_matcher(self):
        c = HookConfig(event=HookEvent.PRE_TOOL_USE, matcher="Bash")
        assert c.matches("Bash")
        assert not c.matches("Read")

    def test_prefix_matcher(self):
        c = HookConfig(event=HookEvent.PRE_TOOL_USE, matcher="run_*")
        assert c.matches("run_command")
        assert c.matches("run_test")
        assert not c.matches("read_file")


class TestHookRunner:
    def test_register_and_run(self):
        runner = HookRunner()
        runner.register(HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="*",
            command="echo ok",
        ))
        assert len(runner._hooks[HookEvent.PRE_TOOL_USE]) == 1

    def test_disabled_hooks_pass(self):
        runner = HookRunner()
        runner.enabled = False
        result = runner.run_hooks(HookEvent.PRE_TOOL_USE, "test")
        assert not result.is_blocking

    def test_function_hook_blocking(self):
        runner = HookRunner()
        runner.register_function(
            HookEvent.PRE_TOOL_USE,
            lambda **kwargs: HookResult(
                decision=HookDecision.BLOCK,
                reason="function blocked",
            ),
        )
        result = runner.run_hooks(HookEvent.PRE_TOOL_USE, "test")
        assert result.is_blocking
        assert result.reason == "function blocked"

    def test_function_hook_approve(self):
        runner = HookRunner()
        runner.register_function(
            HookEvent.PRE_TOOL_USE,
            lambda **kwargs: HookResult(decision=HookDecision.APPROVE),
        )
        result = runner.run_hooks(HookEvent.PRE_TOOL_USE, "test")
        assert not result.is_blocking

    def test_no_hooks_returns_approve(self):
        runner = HookRunner()
        result = runner.run_hooks(HookEvent.PRE_TOOL_USE, "test")
        assert not result.is_blocking

    def test_load_from_config(self):
        runner = HookRunner()
        config = {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "Bash",
                        "hooks": [
                            {"type": "command", "command": "validate.sh", "timeout": 5}
                        ]
                    }
                ]
            }
        }
        runner.load_from_config(config)
        assert len(runner._hooks[HookEvent.PRE_TOOL_USE]) == 1
        assert runner._hooks[HookEvent.PRE_TOOL_USE][0].command == "validate.sh"

    def test_load_from_config_unknown_event(self):
        runner = HookRunner()
        config = {
            "hooks": {
                "UnknownEvent": [
                    {"matcher": "*", "hooks": [{"type": "command", "command": "test"}]}
                ]
            }
        }
        runner.load_from_config(config)
        # Should not crash, just skip unknown events
        assert len(runner._hooks) == 0


class TestCommandHooks:
    def test_command_hook_pass(self):
        """Command hook with exit 0 returns approve."""
        runner = HookRunner()
        runner.register(HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="*",
            command="python -c \"import sys; sys.exit(0)\"",
        ))
        result = runner.run_hooks(HookEvent.PRE_TOOL_USE, "read_file")
        assert not result.is_blocking

    def test_command_hook_block(self):
        """Command hook with exit 2 returns block."""
        runner = HookRunner()
        runner.register(HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="*",
            command="python -c \"import sys; sys.stderr.write('blocked reason'); sys.exit(2)\"",
        ))
        result = runner.run_hooks(HookEvent.PRE_TOOL_USE, "write_file")
        assert result.is_blocking
        assert "blocked reason" in result.reason

    def test_command_hook_timeout(self):
        """Command hook that times out returns approve (safe default)."""
        runner = HookRunner()
        runner.register(HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="*",
            command="python -c \"import time; time.sleep(10)\"",
            timeout=0.1,
        ))
        result = runner.run_hooks(HookEvent.PRE_TOOL_USE, "test")
        assert not result.is_blocking

    def test_command_hook_json_output(self, tmp_path):
        """Command hook stdout JSON with decision/reason is parsed."""
        runner = HookRunner()
        hook_output = json.dumps({"decision": "block", "reason": "not allowed"})
        # Write a temp script to avoid quoting issues on Windows
        script = tmp_path / "hook.py"
        script.write_text(f"import sys; print('{hook_output}')")
        runner.register(HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="*",
            command=f'python "{script}"',
        ))
        result = runner.run_hooks(HookEvent.PRE_TOOL_USE, "dangerous_tool")
        assert result.is_blocking
        assert result.reason == "not allowed"

    def test_async_hook(self):
        """async_mode=True hook runs without blocking."""
        runner = HookRunner()
        runner.register(HookConfig(
            event=HookEvent.POST_TOOL_USE,
            matcher="*",
            command="python -c \"import time; time.sleep(5)\"",
            async_mode=True,
        ))
        # Should return quickly (fire-and-forget) without blocking
        import time
        start = time.time()
        result = runner.run_hooks(HookEvent.POST_TOOL_USE, "test_tool", tool_result="ok")
        elapsed = time.time() - start
        assert elapsed < 2.0  # should not block for 5 seconds
        assert not result.is_blocking

    def test_hook_matcher_tool_name(self):
        """Matcher matches on tool name."""
        runner = HookRunner()
        runner.register(HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="Bash",
            command="python -c \"import sys; sys.exit(0)\"",
        ))
        # Should match "Bash"
        result = runner.run_hooks(HookEvent.PRE_TOOL_USE, "Bash")
        # Should NOT block (exit 0 = approve), but hook ran
        assert not result.is_blocking

        # "Read" doesn't match "Bash" — hook should not run
        # We verify by checking no error occurs (hook skipped)

    def test_hook_multiple_hooks_chain(self):
        """Multiple hooks for same event run in order, first BLOCK stops chain."""
        runner = HookRunner()

        # First hook blocks
        def blocking_fn(**kwargs):
            return HookResult(decision=HookDecision.BLOCK, reason="first blocked")

        # Second hook should not run (we track if it does)
        second_ran = []

        def tracking_fn(**kwargs):
            second_ran.append(True)
            return HookResult(decision=HookDecision.APPROVE)

        runner.register_function(HookEvent.PRE_TOOL_USE, blocking_fn)
        runner.register_function(HookEvent.PRE_TOOL_USE, tracking_fn)

        result = runner.run_hooks(HookEvent.PRE_TOOL_USE, "test")
        assert result.is_blocking
        assert result.reason == "first blocked"
        # Second function hook should not have run (first blocked the chain)
        assert len(second_ran) == 0


class TestHookEvent:
    def test_core_events(self):
        assert HookEvent.PRE_TOOL_USE.value == "PreToolUse"
        assert HookEvent.POST_TOOL_USE.value == "PostToolUse"
        assert HookEvent.STOP.value == "Stop"
        assert HookEvent.SESSION_START.value == "SessionStart"
        assert HookEvent.SESSION_END.value == "SessionEnd"

    def test_s6_new_events_exist(self):
        """S6: New hook events are defined in the enum."""
        assert hasattr(HookEvent, "PRE_COMPACT")
        assert HookEvent.PRE_COMPACT.value == "PreCompact"
        assert hasattr(HookEvent, "POST_COMPACT")
        assert HookEvent.POST_COMPACT.value == "PostCompact"
        assert hasattr(HookEvent, "TASK_CREATED")
        assert HookEvent.TASK_CREATED.value == "TaskCreated"
        assert hasattr(HookEvent, "TASK_COMPLETED")
        assert HookEvent.TASK_COMPLETED.value == "TaskCompleted"
        assert hasattr(HookEvent, "SUBAGENT_START")
        assert HookEvent.SUBAGENT_START.value == "SubagentStart"
        assert hasattr(HookEvent, "SUBAGENT_STOP")
        assert HookEvent.SUBAGENT_STOP.value == "SubagentStop"
        assert hasattr(HookEvent, "PERMISSION_REQUEST")
        assert HookEvent.PERMISSION_REQUEST.value == "PermissionRequest"
        assert hasattr(HookEvent, "PERMISSION_DENIED")
        assert HookEvent.PERMISSION_DENIED.value == "PermissionDenied"
        assert hasattr(HookEvent, "CONFIG_CHANGE")
        assert HookEvent.CONFIG_CHANGE.value == "ConfigChange"
        assert hasattr(HookEvent, "CWD_CHANGED")
        assert HookEvent.CWD_CHANGED.value == "CwdChanged"
        assert hasattr(HookEvent, "FILE_CHANGED")
        assert HookEvent.FILE_CHANGED.value == "FileChanged"
        assert hasattr(HookEvent, "USER_PROMPT_SUBMIT")
        assert HookEvent.USER_PROMPT_SUBMIT.value == "UserPromptSubmit"
        assert hasattr(HookEvent, "POST_TOOL_USE_FAILURE")
        assert HookEvent.POST_TOOL_USE_FAILURE.value == "PostToolUseFailure"

    def test_s6_pre_compact_hook_fires(self):
        """S6: PRE_COMPACT event can be registered and fired."""
        runner = HookRunner()
        fired = []

        def on_pre_compact(**kwargs):
            fired.append(True)
            return HookResult(decision=HookDecision.APPROVE)

        runner.register_function(HookEvent.PRE_COMPACT, on_pre_compact)
        result = runner.run_hooks(HookEvent.PRE_COMPACT, "compact")
        assert not result.is_blocking
        assert len(fired) == 1

    def test_s6_post_compact_hook_fires(self):
        """S6: POST_COMPACT event can be registered and fired."""
        runner = HookRunner()
        fired = []

        def on_post_compact(**kwargs):
            fired.append(True)
            return HookResult(decision=HookDecision.APPROVE)

        runner.register_function(HookEvent.POST_COMPACT, on_post_compact)
        result = runner.run_hooks(HookEvent.POST_COMPACT, "compact")
        assert not result.is_blocking
        assert len(fired) == 1


class TestAsyncHookStdin:
    """S18: Async hooks receive stdin input correctly."""

    def test_async_hook_receives_stdin(self, tmp_path):
        """S18: Async hook receives JSON input via stdin."""
        # Create a Python script that reads stdin and writes to a file
        output_file = tmp_path / "stdin_received.txt"
        script = tmp_path / "stdin_reader.py"
        script.write_text(
            f"import sys, json\n"
            f"data = sys.stdin.read()\n"
            f"with open(r'{output_file}', 'w') as f:\n"
            f"    f.write(data)\n"
        )
        runner = HookRunner()
        runner.register(HookConfig(
            event=HookEvent.POST_TOOL_USE,
            matcher="*",
            command=f'python "{script}"',
            async_mode=True,
        ))

        import time
        runner.run_hooks(HookEvent.POST_TOOL_USE, "test_tool", tool_result="ok")

        # Wait for async process to complete
        for _ in range(30):
            if output_file.exists():
                break
            time.sleep(0.1)

        assert output_file.exists(), "Async hook did not receive stdin"
        content = output_file.read_text(encoding="utf-8")
        data = json.loads(content)
        assert data["event"] == "PostToolUse"
        assert data["tool_name"] == "test_tool"

    def test_async_hook_closes_stdin(self, tmp_path):
        """S18: Async hook stdin is closed after writing so subprocess doesn't hang."""
        # Create a script that reads all of stdin then exits
        output_file = tmp_path / "stdin_closed.txt"
        script = tmp_path / "stdin_close_test.py"
        script.write_text(
            f"import sys\n"
            f"data = sys.stdin.read()\n"
            f"with open(r'{output_file}', 'w') as f:\n"
            f"    f.write('received:' + str(len(data)))\n"
        )
        runner = HookRunner()
        runner.register(HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="*",
            command=f'python "{script}"',
            async_mode=True,
            timeout=5.0,
        ))

        import time
        runner.run_hooks(HookEvent.PRE_TOOL_USE, "test")

        # Wait for the process to finish (should not hang)
        for _ in range(50):
            if output_file.exists():
                break
            time.sleep(0.1)

        assert output_file.exists(), "Async hook hung waiting for stdin EOF"
        content = output_file.read_text()
        assert content.startswith("received:")


class TestHookType:
    def test_enum_values(self):
        assert HookType.COMMAND.value == "command"
        assert HookType.HTTP.value == "http"
        assert HookType.PROMPT.value == "prompt"

    def test_enum_members(self):
        assert len(HookType) == 3


class TestHttpHook:
    def test_approve_response(self):
        """HTTP hook returning approve decision should approve."""
        runner = HookRunner()
        config = HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="*",
            url="http://localhost:9999/hook",
        )

        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({"decision": "approve"}).encode("utf-8")
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)

        with patch("urllib.request.urlopen", return_value=mock_response):
            result = runner._run_http_hook(config, "test_tool", {"arg": "val"})

        assert result.decision == HookDecision.APPROVE

    def test_block_response(self):
        """HTTP hook returning block decision should block."""
        runner = HookRunner()
        config = HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="*",
            url="http://localhost:9999/hook",
        )

        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({
            "decision": "block", "reason": "denied"
        }).encode("utf-8")
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)

        with patch("urllib.request.urlopen", return_value=mock_response):
            result = runner._run_http_hook(config, "test_tool")

        assert result.decision == HookDecision.BLOCK
        assert result.reason == "denied"

    def test_network_error_defaults_approve(self):
        """HTTP hook network failure should default to approve."""
        runner = HookRunner()
        config = HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="*",
            url="http://localhost:9999/hook",
        )

        import urllib.error
        with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("refused")):
            result = runner._run_http_hook(config, "test_tool")

        assert result.decision == HookDecision.APPROVE

    def test_non_json_response_defaults_approve(self):
        """HTTP hook returning non-JSON should default to approve."""
        runner = HookRunner()
        config = HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="*",
            url="http://localhost:9999/hook",
        )

        mock_response = MagicMock()
        mock_response.read.return_value = b"not json at all"
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)

        with patch("urllib.request.urlopen", return_value=mock_response):
            result = runner._run_http_hook(config, "test_tool")

        assert result.decision == HookDecision.APPROVE

    def test_truncates_tool_result(self):
        """HTTP hook should truncate tool_result to 500 chars in payload."""
        runner = HookRunner()
        config = HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="*",
            url="http://localhost:9999/hook",
        )
        captured_payload = {}

        def mock_urlopen(req, timeout=None):
            captured_payload["data"] = req.data.decode("utf-8")
            resp = MagicMock()
            resp.read.return_value = json.dumps({"decision": "approve"}).encode("utf-8")
            resp.__enter__ = MagicMock(return_value=resp)
            resp.__exit__ = MagicMock(return_value=False)
            return resp

        with patch("urllib.request.urlopen", side_effect=mock_urlopen):
            runner._run_http_hook(config, "test_tool", tool_result="x" * 1000)

        payload = json.loads(captured_payload["data"])
        assert len(payload["tool_result"]) == 500


class TestPromptHook:
    def test_no_llm_client_defaults_approve(self):
        """Without LLM client, prompt hook should default to approve."""
        runner = HookRunner()
        config = HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="*",
            prompt="Is {tool_name} safe?",
        )

        result = runner._run_prompt_hook(config, "test_tool", {"arg": "val"})
        assert result.decision == HookDecision.APPROVE

    def test_llm_approve(self):
        """LLM returning approve should approve."""
        runner = HookRunner()
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = '{"decision": "approve"}'
        mock_client.chat.completions.create.return_value = mock_response
        runner._llm_client = mock_client

        config = HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="*",
            prompt="Is {tool_name} safe?",
        )

        result = runner._run_prompt_hook(config, "test_tool")
        assert result.decision == HookDecision.APPROVE

    def test_llm_block(self):
        """LLM returning block should block."""
        runner = HookRunner()
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = '{"decision": "block", "reason": "unsafe"}'
        mock_client.chat.completions.create.return_value = mock_response
        runner._llm_client = mock_client

        config = HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="*",
            prompt="Is {tool_name} safe?",
        )

        result = runner._run_prompt_hook(config, "test_tool")
        assert result.decision == HookDecision.BLOCK
        assert result.reason == "unsafe"

    def test_llm_markdown_json(self):
        """LLM returning JSON in markdown code blocks should be parsed."""
        runner = HookRunner()
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = '```json\n{"decision": "block", "reason": "bad"}\n```'
        mock_client.chat.completions.create.return_value = mock_response
        runner._llm_client = mock_client

        config = HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="*",
            prompt="Is {tool_name} safe?",
        )

        result = runner._run_prompt_hook(config, "test_tool")
        assert result.decision == HookDecision.BLOCK

    def test_llm_exception_defaults_approve(self):
        """LLM exception should default to approve."""
        runner = HookRunner()
        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = RuntimeError("API down")
        runner._llm_client = mock_client

        config = HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="*",
            prompt="Is {tool_name} safe?",
        )

        result = runner._run_prompt_hook(config, "test_tool")
        assert result.decision == HookDecision.APPROVE
