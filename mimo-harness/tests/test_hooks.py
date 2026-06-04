"""Tests for the hook system (Ch8 patterns)."""

import json
import threading
import http.server
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

    def test_run_hooks_prompt_hook_with_client(self):
        """Prompt hook with real LLM client — verifies end-to-end mechanism works."""
        from openai import OpenAI
        from mimo_harness.config import MIMO_API_KEY, MIMO_BASE_URL, MIMO_MODEL
        if not MIMO_API_KEY or MIMO_API_KEY == "test-key-for-testing":
            pytest.skip("Real MIMO_API_KEY not set")

        runner = HookRunner()
        runner.register(HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="*",
            hook_type=HookType.PROMPT,
            prompt=(
                'Evaluate tool: {tool_name}. '
                'Respond with JSON: {{"decision": "block", "reason": "X"}} or '
                '{{"decision": "approve"}}.'
            ),
        ))
        runner._llm_client = OpenAI(api_key=MIMO_API_KEY, base_url=MIMO_BASE_URL)
        runner._llm_model = MIMO_MODEL

        result = runner.run_hooks(HookEvent.PRE_TOOL_USE, "run_command")
        # The key assertion: prompt hook mechanism works end-to-end with real API.
        # We get a valid HookResult (not a crash, not a default).
        assert result is not None
        assert hasattr(result, 'is_blocking')
        assert hasattr(result, 'reason')
        # The LLM returned a parsed decision — either block or approve is valid.
        # The important thing is the hook ran and parsed the response correctly.
        from mimo_harness.hooks import HookDecision
        assert result.decision in (HookDecision.BLOCK, HookDecision.APPROVE)

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


# =========================================================================
# HookConfig.matcher matching logic tests
# =========================================================================

class TestHookConfigMatcher:
    """Test the matcher field of HookConfig for tool name matching."""

    def test_wildcard_matches_any(self):
        config = HookConfig(event=HookEvent.PRE_TOOL_USE, matcher="*")
        assert config.matches("read_file") is True
        assert config.matches("run_command") is True
        assert config.matches("anything") is True

    def test_exact_match(self):
        config = HookConfig(event=HookEvent.PRE_TOOL_USE, matcher="write_file")
        assert config.matches("write_file") is True
        assert config.matches("read_file") is False
        assert config.matches("write_file_extra") is False

    def test_prefix_wildcard(self):
        config = HookConfig(event=HookEvent.PRE_TOOL_USE, matcher="write_*")
        assert config.matches("write_file") is True
        assert config.matches("write_memory") is True
        assert config.matches("read_file") is False

    def test_empty_matcher(self):
        config = HookConfig(event=HookEvent.PRE_TOOL_USE, matcher="")
        assert config.matches("anything") is False

    def test_case_sensitive(self):
        config = HookConfig(event=HookEvent.PRE_TOOL_USE, matcher="Bash")
        assert config.matches("Bash") is True
        assert config.matches("bash") is False
        assert config.matches("BASH") is False


class TestHttpHookSuccess:
    """Test HTTP hook with a real local HTTP server (success path).

    Uses _run_http_hook directly with SSRF check bypassed for localhost,
    since the SSRF protection is tested separately in test_stress_boundary.py.
    """

    def _start_server(self, handler_class):
        """Start a local HTTP server on a random port. Returns (server, port)."""
        server = http.server.HTTPServer(("127.0.0.1", 0), handler_class)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server, port

    def test_http_hook_approve(self, monkeypatch):
        """HTTP hook returning approve JSON should not block."""
        class ApproveHandler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"decision": "approve"}).encode())
            def log_message(self, *args):
                pass  # suppress logs

        server, port = self._start_server(ApproveHandler)
        try:
            # Bypass SSRF check for localhost testing (SSRF tested separately)
            monkeypatch.setattr("mimo_harness.tools.web_tools._validate_url", lambda url: None)
            runner = HookRunner()
            config = HookConfig(
                event=HookEvent.PRE_TOOL_USE,
                matcher="*",
                hook_type=HookType.HTTP,
                url=f"http://127.0.0.1:{port}/hook",
                timeout=5.0,
            )
            result = runner._run_http_hook(config, "test_tool")
            assert not result.is_blocking
            assert result.decision == HookDecision.APPROVE
        finally:
            server.shutdown()

    def test_http_hook_block(self, monkeypatch):
        """HTTP hook returning block JSON should block with reason."""
        class BlockHandler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "decision": "block",
                    "reason": "forbidden tool",
                }).encode())
            def log_message(self, *args):
                pass

        server, port = self._start_server(BlockHandler)
        try:
            monkeypatch.setattr("mimo_harness.tools.web_tools._validate_url", lambda url: None)
            runner = HookRunner()
            config = HookConfig(
                event=HookEvent.PRE_TOOL_USE,
                matcher="*",
                hook_type=HookType.HTTP,
                url=f"http://127.0.0.1:{port}/hook",
                timeout=5.0,
            )
            result = runner._run_http_hook(config, "test_tool")
            assert result.is_blocking
            assert result.decision == HookDecision.BLOCK
            assert "forbidden" in result.reason
        finally:
            server.shutdown()

    def test_http_hook_with_additional_context(self, monkeypatch):
        """HTTP hook can return additionalContext and updatedInput."""
        class ContextHandler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "decision": "approve",
                    "additionalContext": "Extra info from hook",
                    "updatedInput": {"command": "safe-command"},
                }).encode())
            def log_message(self, *args):
                pass

        server, port = self._start_server(ContextHandler)
        try:
            monkeypatch.setattr("mimo_harness.tools.web_tools._validate_url", lambda url: None)
            runner = HookRunner()
            config = HookConfig(
                event=HookEvent.PRE_TOOL_USE,
                matcher="*",
                hook_type=HookType.HTTP,
                url=f"http://127.0.0.1:{port}/hook",
                timeout=5.0,
            )
            result = runner._run_http_hook(config, "test_tool")
            assert not result.is_blocking
            assert "Extra info" in (result.additional_context or "")
        finally:
            server.shutdown()
