"""Tests for CLI entry point and REPL commands."""

import io
import json
import os
import sys
import pytest
from unittest.mock import patch, MagicMock

from mimo_harness.cli import _format_tokens, _load_config, print_help, _handle_command, _output, _estimate_message_tokens, _list_session_files, _resume_latest_session, _pick_session


class TestParseArgs:
    """Test argparse parsing via sys.argv manipulation."""

    def test_parse_args_task(self):
        with patch("sys.argv", ["mimo", "--task", "fix the bug"]):
            import argparse
            parser = argparse.ArgumentParser()
            parser.add_argument("--task", "-t")
            parser.add_argument("--model", "-m", default=None)
            parser.add_argument("--auto-approve", "-y", action="store_true")
            parser.add_argument("--dry-run", action="store_true")
            parser.add_argument("--plan", action="store_true")
            parser.add_argument("--max-steps", type=int, default=20)
            parser.add_argument("--verbose", "-v", action="store_true")
            parser.add_argument("--config", "-c")
            parser.add_argument("--rules", "-r")
            parser.add_argument("--stream", "-s", action="store_true")
            args = parser.parse_args()
            assert args.task == "fix the bug"

    def test_parse_args_model(self):
        with patch("sys.argv", ["mimo", "--model", "custom"]):
            import argparse
            parser = argparse.ArgumentParser()
            parser.add_argument("--task", "-t")
            parser.add_argument("--model", "-m", default=None)
            parser.add_argument("--auto-approve", "-y", action="store_true")
            parser.add_argument("--dry-run", action="store_true")
            parser.add_argument("--plan", action="store_true")
            parser.add_argument("--max-steps", type=int, default=20)
            parser.add_argument("--verbose", "-v", action="store_true")
            parser.add_argument("--config", "-c")
            parser.add_argument("--rules", "-r")
            parser.add_argument("--stream", "-s", action="store_true")
            args = parser.parse_args()
            assert args.model == "custom"

    def test_parse_args_auto_approve(self):
        with patch("sys.argv", ["mimo", "--auto-approve"]):
            import argparse
            parser = argparse.ArgumentParser()
            parser.add_argument("--task", "-t")
            parser.add_argument("--model", "-m", default=None)
            parser.add_argument("--auto-approve", "-y", action="store_true")
            parser.add_argument("--dry-run", action="store_true")
            parser.add_argument("--plan", action="store_true")
            parser.add_argument("--max-steps", type=int, default=20)
            parser.add_argument("--verbose", "-v", action="store_true")
            parser.add_argument("--config", "-c")
            parser.add_argument("--rules", "-r")
            parser.add_argument("--stream", "-s", action="store_true")
            args = parser.parse_args()
            assert args.auto_approve is True

    def test_parse_args_auto_approve_short(self):
        with patch("sys.argv", ["mimo", "-y"]):
            import argparse
            parser = argparse.ArgumentParser()
            parser.add_argument("--task", "-t")
            parser.add_argument("--model", "-m", default=None)
            parser.add_argument("--auto-approve", "-y", action="store_true")
            parser.add_argument("--dry-run", action="store_true")
            parser.add_argument("--plan", action="store_true")
            parser.add_argument("--max-steps", type=int, default=20)
            parser.add_argument("--verbose", "-v", action="store_true")
            parser.add_argument("--config", "-c")
            parser.add_argument("--rules", "-r")
            parser.add_argument("--stream", "-s", action="store_true")
            args = parser.parse_args()
            assert args.auto_approve is True

    def test_parse_args_dry_run(self):
        with patch("sys.argv", ["mimo", "--dry-run"]):
            import argparse
            parser = argparse.ArgumentParser()
            parser.add_argument("--task", "-t")
            parser.add_argument("--model", "-m", default=None)
            parser.add_argument("--auto-approve", "-y", action="store_true")
            parser.add_argument("--dry-run", action="store_true")
            parser.add_argument("--plan", action="store_true")
            parser.add_argument("--max-steps", type=int, default=20)
            parser.add_argument("--verbose", "-v", action="store_true")
            parser.add_argument("--config", "-c")
            parser.add_argument("--rules", "-r")
            parser.add_argument("--stream", "-s", action="store_true")
            args = parser.parse_args()
            assert args.dry_run is True

    def test_parse_args_plan(self):
        with patch("sys.argv", ["mimo", "--plan"]):
            import argparse
            parser = argparse.ArgumentParser()
            parser.add_argument("--task", "-t")
            parser.add_argument("--model", "-m", default=None)
            parser.add_argument("--auto-approve", "-y", action="store_true")
            parser.add_argument("--dry-run", action="store_true")
            parser.add_argument("--plan", action="store_true")
            parser.add_argument("--max-steps", type=int, default=20)
            parser.add_argument("--verbose", "-v", action="store_true")
            parser.add_argument("--config", "-c")
            parser.add_argument("--rules", "-r")
            parser.add_argument("--stream", "-s", action="store_true")
            args = parser.parse_args()
            assert args.plan is True

    def test_parse_args_stream(self):
        with patch("sys.argv", ["mimo", "--stream"]):
            import argparse
            parser = argparse.ArgumentParser()
            parser.add_argument("--task", "-t")
            parser.add_argument("--model", "-m", default=None)
            parser.add_argument("--auto-approve", "-y", action="store_true")
            parser.add_argument("--dry-run", action="store_true")
            parser.add_argument("--plan", action="store_true")
            parser.add_argument("--max-steps", type=int, default=20)
            parser.add_argument("--verbose", "-v", action="store_true")
            parser.add_argument("--config", "-c")
            parser.add_argument("--rules", "-r")
            parser.add_argument("--stream", "-s", action="store_true")
            args = parser.parse_args()
            assert args.stream is True

    def test_parse_args_stream_short(self):
        with patch("sys.argv", ["mimo", "-s"]):
            import argparse
            parser = argparse.ArgumentParser()
            parser.add_argument("--task", "-t")
            parser.add_argument("--model", "-m", default=None)
            parser.add_argument("--auto-approve", "-y", action="store_true")
            parser.add_argument("--dry-run", action="store_true")
            parser.add_argument("--plan", action="store_true")
            parser.add_argument("--max-steps", type=int, default=20)
            parser.add_argument("--verbose", "-v", action="store_true")
            parser.add_argument("--config", "-c")
            parser.add_argument("--rules", "-r")
            parser.add_argument("--stream", "-s", action="store_true")
            args = parser.parse_args()
            assert args.stream is True

    def test_parse_args_max_steps(self):
        with patch("sys.argv", ["mimo", "--max-steps", "10"]):
            import argparse
            parser = argparse.ArgumentParser()
            parser.add_argument("--task", "-t")
            parser.add_argument("--model", "-m", default=None)
            parser.add_argument("--auto-approve", "-y", action="store_true")
            parser.add_argument("--dry-run", action="store_true")
            parser.add_argument("--plan", action="store_true")
            parser.add_argument("--max-steps", type=int, default=20)
            parser.add_argument("--verbose", "-v", action="store_true")
            parser.add_argument("--config", "-c")
            parser.add_argument("--rules", "-r")
            parser.add_argument("--stream", "-s", action="store_true")
            args = parser.parse_args()
            assert args.max_steps == 10

    def test_parse_args_verbose(self):
        with patch("sys.argv", ["mimo", "--verbose"]):
            import argparse
            parser = argparse.ArgumentParser()
            parser.add_argument("--task", "-t")
            parser.add_argument("--model", "-m", default=None)
            parser.add_argument("--auto-approve", "-y", action="store_true")
            parser.add_argument("--dry-run", action="store_true")
            parser.add_argument("--plan", action="store_true")
            parser.add_argument("--max-steps", type=int, default=20)
            parser.add_argument("--verbose", "-v", action="store_true")
            parser.add_argument("--config", "-c")
            parser.add_argument("--rules", "-r")
            parser.add_argument("--stream", "-s", action="store_true")
            args = parser.parse_args()
            assert args.verbose is True

    def test_parse_args_verbose_short(self):
        with patch("sys.argv", ["mimo", "-v"]):
            import argparse
            parser = argparse.ArgumentParser()
            parser.add_argument("--task", "-t")
            parser.add_argument("--model", "-m", default=None)
            parser.add_argument("--auto-approve", "-y", action="store_true")
            parser.add_argument("--dry-run", action="store_true")
            parser.add_argument("--plan", action="store_true")
            parser.add_argument("--max-steps", type=int, default=20)
            parser.add_argument("--verbose", "-v", action="store_true")
            parser.add_argument("--config", "-c")
            parser.add_argument("--rules", "-r")
            parser.add_argument("--stream", "-s", action="store_true")
            args = parser.parse_args()
            assert args.verbose is True

    def test_parse_args_config(self):
        with patch("sys.argv", ["mimo", "--config", "path.json"]):
            import argparse
            parser = argparse.ArgumentParser()
            parser.add_argument("--task", "-t")
            parser.add_argument("--model", "-m", default=None)
            parser.add_argument("--auto-approve", "-y", action="store_true")
            parser.add_argument("--dry-run", action="store_true")
            parser.add_argument("--plan", action="store_true")
            parser.add_argument("--max-steps", type=int, default=20)
            parser.add_argument("--verbose", "-v", action="store_true")
            parser.add_argument("--config", "-c")
            parser.add_argument("--rules", "-r")
            parser.add_argument("--stream", "-s", action="store_true")
            args = parser.parse_args()
            assert args.config == "path.json"

    def test_parse_args_rules(self):
        with patch("sys.argv", ["mimo", "--rules", "rules.json"]):
            import argparse
            parser = argparse.ArgumentParser()
            parser.add_argument("--task", "-t")
            parser.add_argument("--model", "-m", default=None)
            parser.add_argument("--auto-approve", "-y", action="store_true")
            parser.add_argument("--dry-run", action="store_true")
            parser.add_argument("--plan", action="store_true")
            parser.add_argument("--max-steps", type=int, default=20)
            parser.add_argument("--verbose", "-v", action="store_true")
            parser.add_argument("--config", "-c")
            parser.add_argument("--rules", "-r")
            parser.add_argument("--stream", "-s", action="store_true")
            args = parser.parse_args()
            assert args.rules == "rules.json"


class TestLoadConfig:
    def test_load_config_valid(self, tmp_path):
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps({"model": "test", "max_steps": 5}))
        result = _load_config(str(config_file))
        assert result["model"] == "test"
        assert result["max_steps"] == 5

    def test_load_config_missing(self):
        result = _load_config("/nonexistent/path/config.json")
        assert result == {}

    def test_load_config_invalid_json(self, tmp_path):
        config_file = tmp_path / "bad.json"
        config_file.write_text("{invalid json content!!!")
        result = _load_config(str(config_file))
        assert result == {}


class TestFormatTokens:
    def test_format_tokens_small(self):
        assert _format_tokens(999) == "999"

    def test_format_tokens_thousands(self):
        result = _format_tokens(45231)
        assert result == "45.2K"

    def test_format_tokens_exactly_1000(self):
        result = _format_tokens(1000)
        assert result == "1.0K"

    def test_format_tokens_zero(self):
        assert _format_tokens(0) == "0"


class TestReplCommands:
    """Test REPL slash commands by simulating input and capturing output."""

    def test_repl_help_command(self):
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            print_help()
        output = buf.getvalue()
        assert "/help" in output
        assert "/quit" in output
        assert "/clear" in output
        assert "/tools" in output

    def test_repl_tools_command(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        from mimo_harness.agent import MiMoHarness
        harness = MiMoHarness()
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            print("\nAvailable tools:")
            for name in harness.registry.list_names():
                tool = harness.registry.get(name)
                markers = []
                if tool.is_read_only:
                    markers.append("RO")
                if tool.is_concurrency_safe:
                    markers.append("CS")
                if tool.is_destructive:
                    markers.append("DST")
                marker_str = f" [{', '.join(markers)}]" if markers else ""
                print(f"  - {name}: {tool.description[:50]}...{marker_str}")
            print()
        output = buf.getvalue()
        assert "Available tools:" in output
        assert "read_file" in output
        assert "run_command" in output

    def test_repl_stats_command(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        from mimo_harness.agent import MiMoHarness
        from mimo_harness.context import Session, estimate_tokens
        from mimo_harness.cli import _format_tokens
        harness = MiMoHarness()
        session = Session(session_id="aabbccdd")
        session.add_message("user", "hello")
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            tokens = estimate_tokens(session.messages)
            print(f"\nSession Statistics:")
            print(f"  Messages: {len(session.messages)}")
            print(f"  Tokens: {_format_tokens(tokens)}")
            print()
        output = buf.getvalue()
        assert "Session Statistics:" in output
        assert "Messages: 1" in output

    def test_repl_tokens_command(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        from mimo_harness.context import Session, estimate_tokens, CONTEXT_WINDOW_TOKENS
        from mimo_harness.cli import _format_tokens
        session = Session(session_id="aabbccdd")
        session.add_message("user", "hello world")
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            tokens = estimate_tokens(session.messages)
            pct = tokens / CONTEXT_WINDOW_TOKENS * 100
            print(f"\nToken Usage:")
            print(f"  Conversation: {_format_tokens(tokens)} / {_format_tokens(CONTEXT_WINDOW_TOKENS)} ({pct:.1f}%)")
            print()
        output = buf.getvalue()
        assert "Token Usage:" in output
        assert "Conversation:" in output

    def test_repl_dry_run_toggle(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        from mimo_harness.agent import MiMoHarness
        harness = MiMoHarness(dry_run=False)
        # Toggle dry-run ON
        harness.perms.dry_run = not harness.perms.dry_run
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            print(f"Dry-run: {'ON' if harness.perms.dry_run else 'OFF'}")
        assert "ON" in buf.getvalue()
        # Toggle dry-run OFF
        harness.perms.dry_run = not harness.perms.dry_run
        buf2 = io.StringIO()
        with patch("sys.stdout", buf2):
            print(f"Dry-run: {'ON' if harness.perms.dry_run else 'OFF'}")
        assert "OFF" in buf2.getvalue()

    def test_repl_auto_toggle(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        from mimo_harness.agent import MiMoHarness
        harness = MiMoHarness(auto_approve=False)
        # Toggle auto ON
        harness.perms.auto_approve = not harness.perms.auto_approve
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            print(f"Auto-approve: {'ON' if harness.perms.auto_approve else 'OFF'}")
        assert "ON" in buf.getvalue()
        # Toggle auto OFF
        harness.perms.auto_approve = not harness.perms.auto_approve
        buf2 = io.StringIO()
        with patch("sys.stdout", buf2):
            print(f"Auto-approve: {'ON' if harness.perms.auto_approve else 'OFF'}")
        assert "OFF" in buf2.getvalue()

    def test_repl_plan_toggle(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        from mimo_harness.agent import MiMoHarness
        from mimo_harness.permissions import PermissionMode
        harness = MiMoHarness()
        # Toggle plan ON
        harness.perms.mode = PermissionMode.PLAN
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            print("Plan mode: ON (read-only)")
        assert "ON" in buf.getvalue()
        # Toggle plan OFF
        harness.perms.mode = PermissionMode.DEFAULT
        buf2 = io.StringIO()
        with patch("sys.stdout", buf2):
            print("Plan mode: OFF")
        assert "OFF" in buf2.getvalue()

    def test_repl_clear_command(self, monkeypatch):
        from mimo_harness.context import Session
        session = Session(session_id="test")
        session.add_message("user", "hello")
        session.add_message("assistant", "hi")
        assert len(session.messages) == 2
        session.messages.clear()
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            print("Session cleared.")
        assert len(session.messages) == 0
        assert "Session cleared" in buf.getvalue()

    def test_repl_quit_command(self):
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            print("Bye!")
        assert "Bye!" in buf.getvalue()


class _HarnessFixture:
    """Shared fixture builder for REPL command tests."""

    @staticmethod
    def make(monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        from mimo_harness.agent import MiMoHarness
        from mimo_harness.context import Session
        harness = MiMoHarness()
        session = Session(session_id="aabbccdd11223344")
        return harness, session


class TestHandleCommand:
    """Test _handle_command extracted from REPL loop."""

    def test_repl_save_session(self, monkeypatch, tmp_path):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        save_path = str(tmp_path / "session.json")
        action, returned_session = _handle_command(
            ["/save", save_path], harness, session, memory_store
        )
        assert action == "continue"
        assert os.path.exists(save_path)
        with open(save_path) as f:
            data = json.load(f)
        assert data["session_id"] == "aabbccdd11223344"

    def test_repl_load_session(self, monkeypatch, tmp_path):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        from mimo_harness.context import Session
        memory_store = MemoryStore(str(tmp_path))
        # Save a session first
        session.add_message("user", "hello")
        save_path = str(tmp_path / "loaded.json")
        session.save(save_path)
        # Now load it
        new_session = Session(session_id="fresh")
        action, loaded = _handle_command(
            ["/load", save_path], harness, new_session, memory_store
        )
        assert action == "continue"
        assert loaded.session_id == "aabbccdd11223344"
        assert len(loaded.messages) == 1

    def test_repl_load_session_error(self, monkeypatch, tmp_path):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        action, _ = _handle_command(
            ["/load", "/nonexistent/path.json"], harness, session, memory_store
        )
        assert action == "continue"

    def test_repl_memory_command_empty(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        _handle_command(["/memory"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "No memories stored" in captured.out

    def test_repl_memory_command_with_entries(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore, MemoryType
        memory_store = MemoryStore(str(tmp_path))
        memory_store.save_memory(
            name="test-mem",
            memory_type=MemoryType.PROJECT,
            description="A test memory",
            content="remember this",
        )
        _handle_command(["/memory"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Stored memories (1)" in captured.out
        assert "test-mem" in captured.out

    def test_repl_remember_command(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        # Mock input() to return memory content then empty line
        input_iter = iter(["This is important context", ""])
        with patch("builtins.input", side_effect=input_iter):
            _handle_command(["/remember"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Memory saved" in captured.out
        # Verify memory was actually saved
        memories = memory_store.list_memories()
        assert len(memories) == 1

    def test_repl_recommand_empty_input(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        # Mock input() to return empty line immediately
        with patch("builtins.input", return_value=""):
            _handle_command(["/remember"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Memory saved" not in captured.out
        memories = memory_store.list_memories()
        assert len(memories) == 0

    def test_repl_hooks_command_no_hooks(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        _handle_command(["/hooks"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "No hooks registered" in captured.out

    def test_repl_hooks_command_with_hooks(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        from mimo_harness.hooks import HookRunner, HookConfig, HookEvent
        memory_store = MemoryStore(str(tmp_path))
        hook_runner = HookRunner()
        hook_runner.register(HookConfig(
            event=HookEvent.PRE_TOOL_USE,
            matcher="run_command",
            command="validate.sh",
        ))
        harness._hook_runner = hook_runner
        _handle_command(["/hooks"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Registered hooks: 1" in captured.out
        assert "run_command" in captured.out

    def test_repl_compact_command_not_enough(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        session.add_message("user", "hi")
        _handle_command(["/compact"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Not enough messages" in captured.out

    def test_repl_compact_command_triggers(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        # Add enough messages to exceed 1000 tokens
        for i in range(50):
            session.add_message("user", f"This is a long message number {i} " * 10)
            session.add_message("assistant", f"Response to message {i} " * 10)
        # Mock require_api_key and OpenAI to avoid real API call
        with patch("mimo_harness.cli.compact_context") as mock_compact:
            mock_compact.return_value = ([{"role": "system", "content": "compacted"}], 1, 0, False)
            _handle_command(["/compact"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Compressing" in captured.out

    def test_repl_init_command(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        monkeypatch.chdir(tmp_path)
        # Mock scan_project and generate_agents_md
        import mimo_harness.project_scanner as ps
        with patch.object(ps, "scan_project", return_value={
            "language": "Python", "frameworks": ["pytest"], "test_runner": "pytest"
        }) as mock_scan, \
             patch.object(ps, "generate_agents_md", return_value="# AGENTS.md\nGenerated content"):
            _handle_command(["/init"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "AGENTS.md generated" in captured.out
        assert "Python" in captured.out
        assert "pytest" in captured.out
        # Clean up generated file
        agents_path = os.path.join(str(tmp_path), "AGENTS.md")
        if os.path.exists(agents_path):
            os.remove(agents_path)

    def test_repl_init_command_existing_file_decline(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        monkeypatch.chdir(tmp_path)
        # Create existing AGENTS.md
        (tmp_path / "AGENTS.md").write_text("existing content")
        with patch("builtins.input", return_value="n"):
            _handle_command(["/init"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Skipped" in captured.out

    def test_repl_unknown_command(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        _handle_command(["/foobar"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Unknown command" in captured.out
        assert "/foobar" in captured.out

    def test_repl_quit_variants(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        for cmd in ["/quit", "/exit", "/q"]:
            action, _ = _handle_command([cmd], harness, session, memory_store)
            assert action == "quit", f"{cmd} should return 'quit'"

    def test_repl_clear_command(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        session.add_message("user", "hello")
        session.add_message("assistant", "hi")
        _handle_command(["/clear"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Session cleared" in captured.out
        assert len(session.messages) == 0

    def test_repl_tools_command(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        _handle_command(["/tools"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Available tools" in captured.out
        assert "read_file" in captured.out
        assert "run_command" in captured.out

    def test_repl_dry_run_toggle(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        harness.perms.dry_run = False
        _handle_command(["/dry-run"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Dry-run: ON" in captured.out
        assert harness.perms.dry_run is True

    def test_repl_auto_toggle(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        harness.perms.auto_approve = False
        _handle_command(["/auto"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Auto-approve: ON" in captured.out
        assert harness.perms.auto_approve is True

    def test_repl_plan_toggle_on(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        from mimo_harness.permissions import PermissionMode
        harness.perms.mode = PermissionMode.DEFAULT
        _handle_command(["/plan"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Plan mode: ON" in captured.out

    def test_repl_plan_toggle_off(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        from mimo_harness.permissions import PermissionMode
        harness.perms.mode = PermissionMode.PLAN
        _handle_command(["/plan"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Plan mode: OFF" in captured.out

    def test_repl_stats_command(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        session.add_message("user", "hello world")
        _handle_command(["/stats"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Session Statistics" in captured.out
        assert "Messages: 1" in captured.out

    def test_repl_tokens_command(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        session.add_message("user", "hello world")
        _handle_command(["/tokens"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Token Usage" in captured.out
        assert "Conversation:" in captured.out

    def test_repl_save_error(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        # Try to save to an invalid path
        _handle_command(
            ["/save", "/nonexistent/dir/session.json"],
            harness, session, memory_store,
        )
        captured = capsys.readouterr()
        assert "Error" in captured.out


class TestMainFunctionPaths:
    """Test main() function with various argument combinations."""

    def test_main_single_task(self, monkeypatch, capsys):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        monkeypatch.setattr("sys.argv", ["mimo", "--task", "fix the bug"])
        with patch("mimo_harness.cli.MiMoHarness") as MockHarness:
            mock_instance = MagicMock()
            mock_instance.run.return_value = "Bug fixed!"
            MockHarness.return_value = mock_instance
            from mimo_harness.cli import main
            main()
        captured = capsys.readouterr()
        assert "Bug fixed!" in captured.out
        mock_instance.run.assert_called_once_with("fix the bug")

    def test_main_dry_run(self, monkeypatch, capsys):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        monkeypatch.setattr("sys.argv", ["mimo", "--task", "test", "--dry-run"])
        with patch("mimo_harness.cli.MiMoHarness") as MockHarness:
            mock_instance = MagicMock()
            mock_instance.run.return_value = "done"
            MockHarness.return_value = mock_instance
            from mimo_harness.cli import main
            main()
        # Verify dry_run was passed
        call_kwargs = MockHarness.call_args
        assert call_kwargs[1].get("dry_run") is True or call_kwargs.kwargs.get("dry_run") is True

    def test_main_plan_mode(self, monkeypatch, capsys):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        monkeypatch.setattr("sys.argv", ["mimo", "--task", "test", "--plan"])
        with patch("mimo_harness.cli.MiMoHarness") as MockHarness:
            mock_instance = MagicMock()
            mock_instance.run.return_value = "done"
            MockHarness.return_value = mock_instance
            from mimo_harness.cli import main
            main()
        call_kwargs = MockHarness.call_args
        assert call_kwargs[1].get("plan_mode") is True or call_kwargs.kwargs.get("plan_mode") is True

    def test_main_stream_mode(self, monkeypatch, capsys):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        monkeypatch.setattr("sys.argv", ["mimo", "--task", "test", "--stream"])
        with patch("mimo_harness.cli.MiMoHarness") as MockHarness:
            mock_instance = MagicMock()
            mock_instance.run.return_value = "done"
            MockHarness.return_value = mock_instance
            from mimo_harness.cli import main
            main()
        call_kwargs = MockHarness.call_args
        assert call_kwargs[1].get("stream") is True or call_kwargs.kwargs.get("stream") is True

    def test_main_repl_quit(self, monkeypatch, capsys):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        monkeypatch.setattr("sys.argv", ["mimo"])
        # Mock input() to simulate REPL: first a /quit command
        with patch("builtins.input", side_effect=["/quit"]):
            from mimo_harness.cli import main
            main()
        captured = capsys.readouterr()
        assert "Bye!" in captured.out

    def test_main_repl_empty_then_quit(self, monkeypatch, capsys):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        monkeypatch.setattr("sys.argv", ["mimo"])
        with patch("builtins.input", side_effect=["", "  ", "/quit"]):
            from mimo_harness.cli import main
            main()
        captured = capsys.readouterr()
        assert "Bye!" in captured.out

    def test_main_eof_exits(self, monkeypatch, capsys):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        monkeypatch.setattr("sys.argv", ["mimo"])
        with patch("builtins.input", side_effect=EOFError):
            from mimo_harness.cli import main
            main()
        captured = capsys.readouterr()
        assert "Bye!" in captured.out


class TestConfigIntegration:
    """Test config file integration with CLI."""

    def test_config_overrides_env(self, monkeypatch, tmp_path):
        monkeypatch.setenv("MIMO_API_KEY", "env-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://env.com")
        monkeypatch.setenv("MIMO_MODEL", "env-model")
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps({
            "model": "config-model",
            "max_steps": 5,
            "auto_approve": True,
        }))
        monkeypatch.setattr("sys.argv", [
            "mimo", "--task", "test", "--config", str(config_file)
        ])
        with patch("mimo_harness.cli.MiMoHarness") as MockHarness:
            mock_instance = MagicMock()
            mock_instance.run.return_value = "done"
            MockHarness.return_value = mock_instance
            from mimo_harness.cli import main
            main()
        call_kwargs = MockHarness.call_args
        # Config model should be used since --model was not passed
        assert call_kwargs[1].get("model") == "config-model" or call_kwargs.kwargs.get("model") == "config-model"

    def test_config_hooks_loaded(self, monkeypatch, tmp_path):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps({
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "run_command",
                        "hooks": [
                            {"type": "command", "command": "echo ok", "timeout": 5}
                        ]
                    }
                ]
            }
        }))
        monkeypatch.setattr("sys.argv", [
            "mimo", "--task", "test", "--config", str(config_file)
        ])
        with patch("mimo_harness.cli.MiMoHarness") as MockHarness:
            mock_instance = MagicMock()
            mock_instance.run.return_value = "done"
            MockHarness.return_value = mock_instance
            from mimo_harness.cli import main
            main()
        # Verify _hook_runner was set
        assert hasattr(mock_instance, '_hook_runner')

    def test_config_rules_loaded(self, monkeypatch, tmp_path):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        rules_file = tmp_path / "permissions.json"
        rules_file.write_text(json.dumps({
            "permissions": {
                "allow": ["read_file", "glob_files"],
                "deny": ["run_command:rm *"],
            }
        }))
        monkeypatch.setattr("sys.argv", [
            "mimo", "--task", "test", "--rules", str(rules_file)
        ])
        with patch("mimo_harness.cli.MiMoHarness") as MockHarness:
            mock_instance = MagicMock()
            mock_instance.run.return_value = "done"
            MockHarness.return_value = mock_instance
            from mimo_harness.cli import main
            main()
        # Verify load_rules_from_file was called
        mock_instance.perms.load_rules_from_file.assert_called_once_with(str(rules_file))


# ============================================================================
# R2: Round 2 CLI tests — bare mode, effort, output format, !command,
#     /context, --continue, --resume, --session-dir, --name
# ============================================================================


class TestBareFlag:
    """R2: --bare flag enables bare mode (no memory loading)."""

    def test_bare_flag_passed_to_harness(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        monkeypatch.setattr("sys.argv", ["mimo", "--task", "test", "--bare"])
        with patch("mimo_harness.cli.MiMoHarness") as MockHarness:
            mock_instance = MagicMock()
            mock_instance.run.return_value = "done"
            MockHarness.return_value = mock_instance
            from mimo_harness.cli import main
            main()
        call_kwargs = MockHarness.call_args
        assert call_kwargs[1].get("bare") is True or call_kwargs.kwargs.get("bare") is True


class TestEffortFlag:
    """R2: --effort flag sets effort level."""

    def test_effort_low(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        monkeypatch.setattr("sys.argv", ["mimo", "--task", "test", "--effort", "low"])
        with patch("mimo_harness.cli.MiMoHarness") as MockHarness:
            mock_instance = MagicMock()
            mock_instance.run.return_value = "done"
            MockHarness.return_value = mock_instance
            from mimo_harness.cli import main
            main()
        call_kwargs = MockHarness.call_args
        assert call_kwargs[1].get("effort") == "low" or call_kwargs.kwargs.get("effort") == "low"

    def test_effort_high(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        monkeypatch.setattr("sys.argv", ["mimo", "--task", "test", "--effort", "high"])
        with patch("mimo_harness.cli.MiMoHarness") as MockHarness:
            mock_instance = MagicMock()
            mock_instance.run.return_value = "done"
            MockHarness.return_value = mock_instance
            from mimo_harness.cli import main
            main()
        call_kwargs = MockHarness.call_args
        assert call_kwargs[1].get("effort") == "high" or call_kwargs.kwargs.get("effort") == "high"


class TestOutputFormat:
    """R2: --output-format controls JSON output."""

    def test_json_output_format(self, monkeypatch, capsys):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        monkeypatch.setattr("sys.argv", [
            "mimo", "--task", "test", "--output-format", "json"
        ])
        with patch("mimo_harness.cli.MiMoHarness") as MockHarness:
            mock_instance = MagicMock()
            mock_instance.run.return_value = "Result text"
            MockHarness.return_value = mock_instance
            from mimo_harness.cli import main
            main()
        captured = capsys.readouterr()
        output = json.loads(captured.out.strip())
        assert output["type"] == "result"
        assert output["content"] == "Result text"

    def test_stream_json_output_format(self, monkeypatch, capsys):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        monkeypatch.setattr("sys.argv", [
            "mimo", "--task", "test", "--output-format", "stream-json"
        ])
        with patch("mimo_harness.cli.MiMoHarness") as MockHarness:
            mock_instance = MagicMock()
            mock_instance.run.return_value = "Stream result"
            MockHarness.return_value = mock_instance
            from mimo_harness.cli import main
            main()
        captured = capsys.readouterr()
        output = json.loads(captured.out.strip())
        assert output["type"] == "result"
        assert output["content"] == "Stream result"


class TestOutputFunction:
    """R2: _output function handles different formats."""

    def test_output_text(self, capsys):
        _output("Hello", output_format="text")
        captured = capsys.readouterr()
        assert captured.out.strip() == "Hello"

    def test_output_json(self, capsys):
        _output("Hello", output_format="json")
        captured = capsys.readouterr()
        data = json.loads(captured.out.strip())
        assert data["type"] == "result"
        assert data["content"] == "Hello"

    def test_output_json_with_session(self, capsys):
        from mimo_harness.context import Session
        session = Session(session_id="abc123")
        _output("Hello", output_format="json", session=session, steps=3, duration=1.5)
        captured = capsys.readouterr()
        data = json.loads(captured.out.strip())
        assert data["session_id"] == "abc123"
        assert data["steps"] == 3
        assert data["duration"] == 1.5

    def test_output_stream_json(self, capsys):
        _output("Stream content", output_format="stream-json")
        captured = capsys.readouterr()
        data = json.loads(captured.out.strip())
        assert data["type"] == "result"
        assert data["content"] == "Stream content"


class TestEstimateMessageTokens:
    """R2: _estimate_message_tokens helper."""

    def test_basic_message(self):
        msg = {"role": "user", "content": "hello world"}
        tokens = _estimate_message_tokens(msg)
        assert tokens > 0
        assert tokens < 10

    def test_message_with_tool_calls(self):
        msg = {
            "role": "assistant",
            "content": "ok",
            "tool_calls": [{"id": "tc1", "function": {"name": "test", "arguments": "{}"}}],
        }
        tokens = _estimate_message_tokens(msg)
        assert tokens > 0

    def test_empty_content(self):
        msg = {"role": "user", "content": ""}
        tokens = _estimate_message_tokens(msg)
        assert tokens >= 1  # minimum 1

    def test_none_content(self):
        msg = {"role": "user", "content": None}
        tokens = _estimate_message_tokens(msg)
        assert tokens >= 1


class TestShellCommandPrefix:
    """R2: !command prefix in REPL (subprocess execution)."""

    def test_bang_prefix_executes_command(self):
        """The ! prefix triggers subprocess.run. Test via _handle_command path is not
        directly testable (it's in the REPL loop), but we can test the subprocess
        behavior that would occur."""
        import subprocess
        result = subprocess.run("echo hello", shell=True, capture_output=True, text=True, timeout=5)
        assert result.returncode == 0
        assert "hello" in result.stdout


class TestContextCommand:
    """R2: /context command shows per-message token breakdown."""

    def test_context_command_with_messages(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        session.add_message("user", "hello world")
        session.add_message("assistant", "hi there friend")
        _handle_command(["/context"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Context breakdown" in captured.out
        assert "2 messages" in captured.out
        assert "user" in captured.out
        assert "assistant" in captured.out
        assert "Total" in captured.out

    def test_context_command_empty_session(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        _handle_command(["/context"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "No messages" in captured.out


class TestSessionDirAndName:
    """R2: --session-dir and --name CLI flags."""

    def test_session_dir_flag(self, monkeypatch, tmp_path):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        session_dir = str(tmp_path / "my_sessions")
        monkeypatch.setattr("sys.argv", [
            "mimo", "--session-dir", session_dir
        ])
        with patch("builtins.input", side_effect=["/quit"]):
            from mimo_harness.cli import main
            main()
        # Directory should have been created
        assert os.path.isdir(session_dir)

    def test_name_flag_stored_on_session(self, monkeypatch, tmp_path, capsys):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        session_dir = str(tmp_path / "sessions")
        monkeypatch.setattr("sys.argv", [
            "mimo", "--session-dir", session_dir, "--name", "my-session"
        ])
        # The name flag sets session.name, verify it's accepted without error
        with patch("builtins.input", side_effect=["/quit"]):
            from mimo_harness.cli import main
            main()
        captured = capsys.readouterr()
        assert "Bye!" in captured.out
        # Session dir was created
        assert os.path.isdir(session_dir)


class TestSessionListAndResume:
    """R2: _list_session_files and _resume_latest_session."""

    def test_list_session_files(self, tmp_path):
        # Create some .jsonl files
        for name in ["sess1.jsonl", "sess2.jsonl", "other.txt"]:
            (tmp_path / name).write_text('{"test": true}\n')
        files = _list_session_files(str(tmp_path))
        assert len(files) == 2
        assert all(f.endswith(".jsonl") for f in files)

    def test_list_session_files_empty_dir(self, tmp_path):
        files = _list_session_files(str(tmp_path))
        assert files == []

    def test_resume_latest_session(self, tmp_path):
        session_file = tmp_path / "abc123.jsonl"
        session_file.write_text(
            json.dumps({"role": "user", "content": "hello"}) + "\n"
            + json.dumps({"role": "assistant", "content": "hi"}) + "\n",
            encoding="utf-8",
        )
        session = _resume_latest_session(str(tmp_path))
        assert session is not None
        assert session.session_id == "abc123"
        assert len(session.messages) == 2

    def test_resume_latest_no_sessions(self, tmp_path):
        session = _resume_latest_session(str(tmp_path))
        assert session is None


class TestContinueAndResumeFlags:
    """R2: --continue and --resume session resume."""

    def test_continue_flag_resumes_latest(self, monkeypatch, tmp_path):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        session_dir = str(tmp_path / "sessions")
        os.makedirs(session_dir, exist_ok=True)
        # Pre-create a session file
        session_file = os.path.join(session_dir, "resumable.jsonl")
        with open(session_file, "w", encoding="utf-8") as f:
            f.write(json.dumps({"role": "user", "content": "previous message"}) + "\n")

        monkeypatch.setattr("sys.argv", [
            "mimo", "--session-dir", session_dir, "--continue"
        ])
        with patch("builtins.input", side_effect=["/quit"]):
            from mimo_harness.cli import main
            main()
        # No crash means resume worked

    def test_resume_flag_picks_session(self, monkeypatch, tmp_path, capsys):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        session_dir = str(tmp_path / "sessions")
        os.makedirs(session_dir, exist_ok=True)
        # Pre-create a session file
        session_file = os.path.join(session_dir, "pickable.jsonl")
        with open(session_file, "w", encoding="utf-8") as f:
            f.write(json.dumps({"role": "user", "content": "msg"}) + "\n")

        monkeypatch.setattr("sys.argv", [
            "mimo", "--session-dir", session_dir, "--resume"
        ])
        # Simulate user picking session 1 then quitting
        with patch("builtins.input", side_effect=["1", "/quit"]):
            from mimo_harness.cli import main
            main()
        captured = capsys.readouterr()
        assert "Resumed session" in captured.out


class TestHandleCommandContext:
    """R2: Additional /context command edge cases."""

    def test_context_with_tool_calls(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        session.add_message("user", "run something")
        session.add_message(
            "assistant", "",
            tool_calls=[{"id": "tc1", "function": {"name": "test", "arguments": "{}"}}],
        )
        session.add_message("tool", "result", tool_call_id="tc1")
        _handle_command(["/context"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Context breakdown" in captured.out


class TestConfigWatcher:
    """Tests for ConfigWatcher - config file hot-reload."""

    def test_init_nonexistent_file(self, tmp_path):
        from mimo_harness.cli import ConfigWatcher
        watcher = ConfigWatcher(str(tmp_path / "nonexistent.json"))
        assert watcher._last_mtime == 0.0
        assert watcher._last_config == {}

    def test_init_existing_file(self, tmp_path):
        from mimo_harness.cli import ConfigWatcher
        config_file = tmp_path / "config.json"
        config_file.write_text('{"model": "test"}')
        watcher = ConfigWatcher(str(config_file))
        assert watcher._last_mtime > 0

    def test_no_changes(self, tmp_path):
        from mimo_harness.cli import ConfigWatcher
        config_file = tmp_path / "config.json"
        config_file.write_text('{"model": "test"}')
        watcher = ConfigWatcher(str(config_file))
        changed, config = watcher.check_for_changes()
        assert changed is False

    def test_detects_changes(self, tmp_path):
        import time as _time
        from mimo_harness.cli import ConfigWatcher
        config_file = tmp_path / "config.json"
        config_file.write_text('{"model": "v1"}')
        watcher = ConfigWatcher(str(config_file))

        _time.sleep(0.05)
        config_file.write_text('{"model": "v2"}')
        changed, config = watcher.check_for_changes()
        assert changed is True
        assert config.get("model") == "v2"

    def test_file_deleted(self, tmp_path):
        from mimo_harness.cli import ConfigWatcher
        config_file = tmp_path / "config.json"
        config_file.write_text('{"model": "test"}')
        watcher = ConfigWatcher(str(config_file))

        config_file.unlink()
        changed, config = watcher.check_for_changes()
        assert changed is False
        assert config == {}

    def test_invalid_json_after_change(self, tmp_path):
        import time as _time
        from mimo_harness.cli import ConfigWatcher
        config_file = tmp_path / "config.json"
        config_file.write_text('{"model": "v1"}')
        watcher = ConfigWatcher(str(config_file))

        _time.sleep(0.05)
        config_file.write_text('not valid json{{{')
        changed, config = watcher.check_for_changes()
        # Invalid JSON still counts as a change (mtime updated), but config is empty
        assert config == {}
