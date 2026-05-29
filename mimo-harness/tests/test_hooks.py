"""Tests for the hook system (Ch8 patterns)."""

import pytest
from mimo_harness.hooks import (
    HookEvent, HookDecision, HookConfig, HookRunner, HookResult, HookType,
)


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

    def test_load_from_config_http_type(self):
        """load_from_config correctly registers HTTP-type hooks."""
        runner = HookRunner()
        config = {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "write_file",
                        "hooks": [
                            {"type": "http", "url": "http://localhost:9000/check", "timeout": 5.0}
                        ]
                    }
                ]
            }
        }
        runner.load_from_config(config)
        assert len(runner._hooks[HookEvent.PRE_TOOL_USE]) == 1
        hook = runner._hooks[HookEvent.PRE_TOOL_USE][0]
        assert hook.url == "http://localhost:9000/check"
        assert hook.timeout == 5.0

    def test_load_from_config_prompt_type(self):
        """load_from_config correctly registers prompt-type hooks."""
        runner = HookRunner()
        config = {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "*",
                        "hooks": [
                            {"type": "prompt", "prompt": "Is this safe: {tool_name}?"}
                        ]
                    }
                ]
            }
        }
        runner.load_from_config(config)
        assert len(runner._hooks[HookEvent.PRE_TOOL_USE]) == 1
        hook = runner._hooks[HookEvent.PRE_TOOL_USE][0]
        assert hook.prompt == "Is this safe: {tool_name}?"

    def test_run_hooks_command_hook_approve(self, tmp_path):
        """Command hook with exit code 0 returns approve."""
        runner = HookRunner()
        # Use a command that exits with code 0
        runner.register(HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="*",
            command="python -c \"import sys; sys.exit(0)\"",
        ))
        result = runner.run_hooks(HookEvent.PRE_TOOL_USE, "test_tool")
        assert not result.is_blocking

    def test_run_hooks_command_hook_block(self, tmp_path):
        """Command hook with exit code 2 returns block."""
        runner = HookRunner()
        runner.register(HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="*",
            command="python -c \"import sys; sys.exit(2)\"",
        ))
        result = runner.run_hooks(HookEvent.PRE_TOOL_USE, "test_tool")
        assert result.is_blocking

    def test_run_hooks_prompt_hook_no_client(self):
        """Prompt hook with no LLM client defaults to approve."""
        runner = HookRunner()
        runner.register(HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="*",
            hook_type=HookType.PROMPT,
            prompt="Is {tool_name} safe?",
        ))
        # No _llm_client set, should default to approve
        result = runner.run_hooks(HookEvent.PRE_TOOL_USE, "test_tool")
        assert not result.is_blocking

    def test_run_hooks_prompt_hook_with_client_block(self):
        """Prompt hook with LLM client that blocks."""
        from unittest.mock import MagicMock
        runner = HookRunner()
        runner.register(HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="*",
            hook_type=HookType.PROMPT,
            prompt="Is {tool_name} safe?",
        ))
        # Mock LLM client that returns "block"
        mock_client = MagicMock()
        mock_resp = MagicMock()
        mock_resp.choices = [MagicMock()]
        mock_resp.choices[0].message.content = '{"decision": "block", "reason": "unsafe"}'
        mock_client.chat.completions.create.return_value = mock_resp
        runner._llm_client = mock_client

        result = runner.run_hooks(HookEvent.PRE_TOOL_USE, "dangerous_tool")
        assert result.is_blocking
        assert "unsafe" in result.reason

    def test_run_hooks_http_hook_failure_non_blocking(self):
        """HTTP hook that fails returns approve (non-blocking)."""
        runner = HookRunner()
        runner.register(HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="*",
            hook_type=HookType.HTTP,
            url="http://localhost:1/nonexistent",
            timeout=0.1,
        ))
        # Should not crash, just return approve
        result = runner.run_hooks(HookEvent.PRE_TOOL_USE, "test_tool")
        assert not result.is_blocking
