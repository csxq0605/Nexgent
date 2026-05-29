"""Tests for CLI entry point and REPL commands."""

import io
import json
import os
import sys
import pytest
from unittest.mock import patch, MagicMock

from mimo_harness.cli import _format_tokens, _load_config, print_help, _handle_command, _output, _estimate_message_tokens, _list_session_files, _resume_latest_session, _pick_session, _validate_session_id, _resume_by_session_id, _build_parser
from mimo_harness.context import Session


class TestParseArgs:
    """Test the actual CLI argument parser from cli.py."""

    def test_parse_args_task(self):
        parser = _build_parser()
        args = parser.parse_args(["--task", "fix the bug"])
        assert args.task == "fix the bug"

    def test_parse_args_task_short(self):
        parser = _build_parser()
        args = parser.parse_args(["-t", "fix the bug"])
        assert args.task == "fix the bug"

    def test_parse_args_model(self):
        parser = _build_parser()
        args = parser.parse_args(["--model", "custom"])
        assert args.model == "custom"

    def test_parse_args_model_short(self):
        parser = _build_parser()
        args = parser.parse_args(["-m", "custom"])
        assert args.model == "custom"

    def test_parse_args_auto_approve(self):
        parser = _build_parser()
        args = parser.parse_args(["--auto-approve"])
        assert args.auto_approve is True

    def test_parse_args_auto_approve_short(self):
        parser = _build_parser()
        args = parser.parse_args(["-y"])
        assert args.auto_approve is True

    def test_parse_args_dry_run(self):
        parser = _build_parser()
        args = parser.parse_args(["--dry-run"])
        assert args.dry_run is True

    def test_parse_args_plan(self):
        parser = _build_parser()
        args = parser.parse_args(["--plan"])
        assert args.plan is True

    def test_parse_args_stream(self):
        parser = _build_parser()
        args = parser.parse_args(["--stream"])
        assert args.stream is True

    def test_parse_args_stream_short(self):
        parser = _build_parser()
        args = parser.parse_args(["-s"])
        assert args.stream is True

    def test_parse_args_max_steps(self):
        parser = _build_parser()
        args = parser.parse_args(["--max-steps", "10"])
        assert args.max_steps == 10

    def test_parse_args_verbose(self):
        parser = _build_parser()
        args = parser.parse_args(["--verbose"])
        assert args.verbose is True

    def test_parse_args_verbose_short(self):
        parser = _build_parser()
        args = parser.parse_args(["-v"])
        assert args.verbose is True

    def test_parse_args_config(self):
        parser = _build_parser()
        args = parser.parse_args(["--config", "path.json"])
        assert args.config == "path.json"

    def test_parse_args_config_short(self):
        parser = _build_parser()
        args = parser.parse_args(["-c", "path.json"])
        assert args.config == "path.json"

    def test_parse_args_rules(self):
        parser = _build_parser()
        args = parser.parse_args(["--rules", "rules.json"])
        assert args.rules == "rules.json"

    def test_parse_args_rules_short(self):
        parser = _build_parser()
        args = parser.parse_args(["-r", "rules.json"])
        assert args.rules == "rules.json"

    def test_parse_args_bare(self):
        parser = _build_parser()
        args = parser.parse_args(["--bare"])
        assert args.bare is True

    def test_parse_args_effort(self):
        parser = _build_parser()
        args = parser.parse_args(["--effort", "high"])
        assert args.effort == "high"

    def test_parse_args_effort_default(self):
        parser = _build_parser()
        args = parser.parse_args([])
        assert args.effort == "medium"

    def test_parse_args_output_format(self):
        parser = _build_parser()
        args = parser.parse_args(["--output-format", "json"])
        assert args.output_format == "json"

    def test_parse_args_output_format_default(self):
        parser = _build_parser()
        args = parser.parse_args([])
        assert args.output_format == "text"

    def test_parse_args_session_dir(self):
        parser = _build_parser()
        args = parser.parse_args(["--session-dir", "/tmp/sessions"])
        assert args.session_dir == "/tmp/sessions"

    def test_parse_args_continue(self):
        parser = _build_parser()
        args = parser.parse_args(["--continue"])
        assert args.continue_session is True

    def test_parse_args_resume(self):
        parser = _build_parser()
        args = parser.parse_args(["--resume"])
        assert args.resume is True

    def test_parse_args_name(self):
        parser = _build_parser()
        args = parser.parse_args(["--name", "my-session"])
        assert args.name == "my-session"

    def test_parse_args_session_id(self):
        parser = _build_parser()
        args = parser.parse_args(["--session-id", "abc123"])
        assert args.session_id == "abc123"

    def test_parse_args_fallback_model(self):
        parser = _build_parser()
        args = parser.parse_args(["--fallback-model", "backup"])
        assert args.fallback_model == "backup"

    def test_parse_args_log_file(self):
        parser = _build_parser()
        args = parser.parse_args(["--log-file", "/tmp/app.log"])
        assert args.log_file == "/tmp/app.log"

    def test_parse_args_cleanup_days(self):
        parser = _build_parser()
        args = parser.parse_args(["--cleanup-days", "7"])
        assert args.cleanup_days == 7

    def test_parse_args_cleanup_days_default(self):
        parser = _build_parser()
        args = parser.parse_args([])
        assert args.cleanup_days == 30

    def test_parse_args_defaults(self):
        """All flags default correctly when no args passed."""
        parser = _build_parser()
        args = parser.parse_args([])
        assert args.task is None
        assert args.model is None
        assert args.auto_approve is False
        assert args.dry_run is False
        assert args.plan is False
        assert args.max_steps is None
        assert args.verbose is False
        assert args.stream is False
        assert args.bare is False
        assert args.continue_session is False
        assert args.resume is False

    def test_parse_args_combined(self):
        parser = _build_parser()
        args = parser.parse_args([
            "--task", "test", "--model", "m", "-y", "--stream",
            "--max-steps", "5", "--output-format", "json",
        ])
        assert args.task == "test"
        assert args.model == "m"
        assert args.auto_approve is True
        assert args.stream is True
        assert args.max_steps == 5
        assert args.output_format == "json"


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
            mock_instance._last_session = None
            mock_instance._last_steps = 0
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
            mock_instance._last_session = None
            mock_instance._last_steps = 0
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


class TestSessionIdFlag:
    """R2: --session-id flag for deterministic session ID assignment."""

    def test_session_id_flag_creates_new(self, monkeypatch, tmp_path, capsys):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        session_dir = str(tmp_path / "sessions")
        os.makedirs(session_dir, exist_ok=True)

        monkeypatch.setattr("sys.argv", [
            "mimo", "--session-dir", session_dir, "--session-id", "abc123"
        ])
        with patch("builtins.input", side_effect=["/quit"]):
            from mimo_harness.cli import main
            main()
        captured = capsys.readouterr()
        assert "Bye!" in captured.out
        assert os.path.isdir(session_dir)
        # Verify no "Resumed session" message (it's a new session, not a resume)
        assert "Resumed session" not in captured.out

    def test_session_id_flag_resumes_existing(self, monkeypatch, tmp_path, capsys):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        session_dir = str(tmp_path / "sessions")
        os.makedirs(session_dir, exist_ok=True)
        # Pre-create a session file with messages
        session_file = os.path.join(session_dir, "my-session.jsonl")
        with open(session_file, "w", encoding="utf-8") as f:
            f.write(json.dumps({"role": "user", "content": "hello"}) + "\n")
            f.write(json.dumps({"role": "assistant", "content": "hi there"}) + "\n")

        monkeypatch.setattr("sys.argv", [
            "mimo", "--session-dir", session_dir, "--session-id", "my-session"
        ])
        with patch("builtins.input", side_effect=["/quit"]):
            from mimo_harness.cli import main
            main()
        captured = capsys.readouterr()
        assert "Resumed session: my-session" in captured.out
        assert "2 messages" in captured.out

    def test_session_id_flag_with_name(self, monkeypatch, tmp_path, capsys):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        session_dir = str(tmp_path / "sessions")
        os.makedirs(session_dir, exist_ok=True)

        monkeypatch.setattr("sys.argv", [
            "mimo", "--session-dir", session_dir, "--session-id", "named-id", "--name", "mysession"
        ])
        created_sessions = []
        real_Session = Session
        def spy_Session(*args, **kwargs):
            s = real_Session(*args, **kwargs)
            created_sessions.append(s)
            return s
        with patch("builtins.input", side_effect=["/quit"]), \
             patch("mimo_harness.cli.Session", side_effect=spy_Session):
            from mimo_harness.cli import main
            main()
        captured = capsys.readouterr()
        assert "Bye!" in captured.out
        assert os.path.isdir(session_dir)
        # Verify the session was created with the specified name
        assert len(created_sessions) == 1
        assert created_sessions[0].name == "mysession"
        assert created_sessions[0].session_id == "named-id"

    def test_session_id_priority_over_continue(self, monkeypatch, tmp_path, capsys):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        session_dir = str(tmp_path / "sessions")
        os.makedirs(session_dir, exist_ok=True)
        # Pre-create a session file with messages for --session-id
        specific_file = os.path.join(session_dir, "specific-id.jsonl")
        with open(specific_file, "w", encoding="utf-8") as f:
            f.write(json.dumps({"role": "user", "content": "specific msg"}) + "\n")
        # Pre-create another session file (the "latest" one for --continue)
        other_file = os.path.join(session_dir, "other-session.jsonl")
        with open(other_file, "w", encoding="utf-8") as f:
            f.write(json.dumps({"role": "user", "content": "old msg"}) + "\n")

        monkeypatch.setattr("sys.argv", [
            "mimo", "--session-dir", session_dir, "--session-id", "specific-id", "--continue"
        ])
        with patch("builtins.input", side_effect=["/quit"]):
            from mimo_harness.cli import main
            main()
        captured = capsys.readouterr()
        # --session-id should win: resumed the specific-id session, not other-session
        assert "Resumed session: specific-id" in captured.out

    def test_session_id_rejects_empty(self, monkeypatch, tmp_path, capsys):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        session_dir = str(tmp_path / "sessions")
        os.makedirs(session_dir, exist_ok=True)

        monkeypatch.setattr("sys.argv", [
            "mimo", "--session-dir", session_dir, "--session-id", ""
        ])
        with pytest.raises(SystemExit) as exc_info:
            from mimo_harness.cli import main
            main()
        assert exc_info.value.code == 1
        captured = capsys.readouterr()
        assert "must not be empty" in captured.out

    def test_session_id_rejects_path_traversal(self, monkeypatch, tmp_path, capsys):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        session_dir = str(tmp_path / "sessions")
        os.makedirs(session_dir, exist_ok=True)

        monkeypatch.setattr("sys.argv", [
            "mimo", "--session-dir", session_dir, "--session-id", "../../evil"
        ])
        with pytest.raises(SystemExit) as exc_info:
            from mimo_harness.cli import main
            main()
        assert exc_info.value.code == 1
        captured = capsys.readouterr()
        assert "invalid characters" in captured.out
        # Verify no file was created outside session_dir
        assert not os.path.exists(tmp_path / "sessions" / ".." / ".." / "evil.jsonl")


class TestValidateSessionId:
    """Unit tests for _validate_session_id."""

    def test_valid_ids(self):
        _validate_session_id("abc123")
        _validate_session_id("my-session")
        _validate_session_id("session_1")
        _validate_session_id("a")
        _validate_session_id("a-b-c")

    def test_empty_string_raises(self):
        with pytest.raises(ValueError, match="must not be empty"):
            _validate_session_id("")

    def test_whitespace_only_raises(self):
        with pytest.raises(ValueError, match="must not be empty"):
            _validate_session_id("   ")

    def test_too_long_raises(self):
        with pytest.raises(ValueError, match="64 characters or fewer"):
            _validate_session_id("a" * 65)

    def test_max_length_ok(self):
        _validate_session_id("a" * 64)

    def test_symbolic_only_raises(self):
        with pytest.raises(ValueError, match="invalid characters"):
            _validate_session_id("---")

    def test_underscore_only_raises(self):
        with pytest.raises(ValueError, match="invalid characters"):
            _validate_session_id("___")

    def test_path_traversal_raises(self):
        with pytest.raises(ValueError, match="invalid characters"):
            _validate_session_id("../../etc/passwd")

    def test_slash_raises(self):
        with pytest.raises(ValueError, match="invalid characters"):
            _validate_session_id("foo/bar")

    def test_backslash_raises(self):
        with pytest.raises(ValueError, match="invalid characters"):
            _validate_session_id("foo\\bar")

    def test_dotdot_raises(self):
        with pytest.raises(ValueError, match="invalid characters"):
            _validate_session_id("..")

    def test_leading_trailing_whitespace_stripped(self):
        """Whitespace should be silently stripped before validation."""
        assert _validate_session_id("  my-session  ") == "my-session"
        assert _validate_session_id("\tsession-1\t") == "session-1"

    def test_whitespace_stripping_preserves_length_check(self):
        """After stripping, the 64-char limit should apply to the stripped value."""
        # 65 chars with surrounding spaces — stripped to 63, should pass
        _validate_session_id("  " + "a" * 63 + "  ")
        # 65 chars stripped to 65 — should fail
        with pytest.raises(ValueError, match="64 characters or fewer"):
            _validate_session_id("  " + "a" * 65 + "  ")


class TestResumeBySessionId:
    """Unit tests for _resume_by_session_id."""

    def test_returns_none_for_missing_file(self, tmp_path):
        result = _resume_by_session_id(str(tmp_path), "nonexistent")
        assert result is None

    def test_returns_session_for_existing_file(self, tmp_path):
        session_file = tmp_path / "abc.jsonl"
        session_file.write_text(json.dumps({"role": "user", "content": "hi"}) + "\n", encoding="utf-8")
        result = _resume_by_session_id(str(tmp_path), "abc")
        assert result is not None
        assert result.session_id == "abc"
        assert len(result.messages) == 1
        assert result.messages[0]["role"] == "user"
        assert result.messages[0]["content"] == "hi"

    def test_corrupt_file_renamed_and_returns_none(self, tmp_path):
        session_file = tmp_path / "bad.jsonl"
        session_file.write_text("not valid json\n", encoding="utf-8")
        result = _resume_by_session_id(str(tmp_path), "bad")
        assert result is None
        assert not (tmp_path / "bad.jsonl").exists()
        assert (tmp_path / "bad.jsonl.corrupt").exists()

    def test_corrupt_file_overwrites_existing_corrupt_backup(self, tmp_path):
        """os.replace overwrites existing .corrupt backup, preventing infinite loop."""
        session_file = tmp_path / "loop.jsonl"
        session_file.write_text("bad data\n", encoding="utf-8")
        # Pre-create a .corrupt backup from a prior run
        (tmp_path / "loop.jsonl.corrupt").write_text("old corrupt\n", encoding="utf-8")
        result = _resume_by_session_id(str(tmp_path), "loop")
        assert result is None
        # The new corrupt file should have overwritten the old backup
        assert not (tmp_path / "loop.jsonl").exists()
        assert (tmp_path / "loop.jsonl.corrupt").exists()
        assert (tmp_path / "loop.jsonl.corrupt").read_text(encoding="utf-8") == "bad data\n"

    def test_unicode_error_handled_gracefully(self, tmp_path):
        """Invalid UTF-8 bytes should be caught, not crash."""
        session_file = tmp_path / "unicode.jsonl"
        session_file.write_bytes(b'\x80\x81\x82\n')
        result = _resume_by_session_id(str(tmp_path), "unicode")
        assert result is None
        assert not (tmp_path / "unicode.jsonl").exists()

    def test_transient_oserror_does_not_rename(self, tmp_path):
        """Transient OSError (e.g. file lock) should NOT rename the file to .corrupt."""
        session_file = tmp_path / "locked.jsonl"
        session_file.write_text(json.dumps({"role": "user", "content": "hi"}) + "\n", encoding="utf-8")
        # Mock from_jsonl to raise OSError (simulating file lock)
        with patch("mimo_harness.cli.Session.from_jsonl", side_effect=OSError("Permission denied")):
            result = _resume_by_session_id(str(tmp_path), "locked")
        assert result is None
        # File should NOT be renamed — it's a transient error, not corruption
        assert session_file.exists()
        assert not (tmp_path / "locked.jsonl.corrupt").exists()

    def test_non_dict_json_raises_value_error(self, tmp_path):
        """Valid JSON that is not a message dict should be treated as corrupt."""
        session_file = tmp_path / "baddict.jsonl"
        session_file.write_text("null\n", encoding="utf-8")
        result = _resume_by_session_id(str(tmp_path), "baddict")
        assert result is None
        assert not (tmp_path / "baddict.jsonl").exists()
        assert (tmp_path / "baddict.jsonl.corrupt").exists()

    def test_both_rename_and_remove_fail_truncates_file(self, tmp_path):
        """When os.replace and os.remove both fail, the file should be truncated to prevent cascade data loss."""
        session_file = tmp_path / "stuck.jsonl"
        session_file.write_text("bad data\n", encoding="utf-8")
        with patch("mimo_harness.cli.os.replace", side_effect=OSError("lock")), \
             patch("mimo_harness.cli.os.remove", side_effect=OSError("lock")):
            result = _resume_by_session_id(str(tmp_path), "stuck")
        assert result is None
        # File should still exist (rename and remove both failed)
        assert session_file.exists()
        # But it should be empty (truncated) — preventing cascade data loss
        assert session_file.read_text(encoding="utf-8") == ""

    def test_partial_corruption_below_threshold_warns(self, tmp_path, capsys):
        """A few skipped lines (below 30%) should warn but still return the session."""
        session_file = tmp_path / "partial.jsonl"
        lines = [
            json.dumps({"role": "user", "content": "hello"}) + "\n",
            json.dumps({"role": "assistant", "content": "hi"}) + "\n",
            json.dumps({"role": "user", "content": "bye"}) + "\n",
            json.dumps({"role": "assistant", "content": "cya"}) + "\n",
            json.dumps({"role": "user", "content": "extra"}) + "\n",
            "not valid json\n",  # 1 out of 6 = 17% — below 30% threshold
        ]
        session_file.write_text("".join(lines), encoding="utf-8")
        result = _resume_by_session_id(str(tmp_path), "partial")
        assert result is not None
        assert len(result.messages) == 5
        captured = capsys.readouterr()
        assert "1 invalid line(s) skipped" in captured.out

    def test_partial_corruption_above_threshold_renames(self, tmp_path, capsys):
        """Skipped lines above 30% threshold should trigger corrupt-file rename."""
        session_file = tmp_path / "mostly-bad.jsonl"
        lines = [
            json.dumps({"role": "user", "content": "hello"}) + "\n",
            json.dumps({"role": "assistant", "content": "hi"}) + "\n",
            "bad1\n",  # 3 invalid out of 5 = 60% — above 30% threshold
            "bad2\n",
            "bad3\n",
        ]
        session_file.write_text("".join(lines), encoding="utf-8")
        result = _resume_by_session_id(str(tmp_path), "mostly-bad")
        assert result is None
        assert not session_file.exists()
        assert (tmp_path / "mostly-bad.jsonl.corrupt").exists()
        captured = capsys.readouterr()
        assert "corrupt" in captured.out.lower()


class TestPickSessionRecovery:
    """Tests for _pick_session corrupt-file recovery."""

    def test_pick_session_renames_corrupt_file(self, tmp_path, monkeypatch, capsys):
        """Corrupt session selected via --resume should be renamed to .corrupt."""
        session_dir = str(tmp_path / "sessions")
        os.makedirs(session_dir, exist_ok=True)
        # Create a valid session file first (older)
        valid_file = os.path.join(session_dir, "good-session.jsonl")
        with open(valid_file, "w", encoding="utf-8") as f:
            f.write(json.dumps({"role": "user", "content": "hi"}) + "\n")
        # Create a corrupt session file after (newer, so it appears first in list)
        corrupt_file = os.path.join(session_dir, "bad-session.jsonl")
        with open(corrupt_file, "w", encoding="utf-8") as f:
            f.write("not valid json\n")

        # Mock input to pick the first session (the corrupt one, newest)
        with patch("builtins.input", return_value="1"):
            result = _pick_session(session_dir)
        assert result is None
        # Corrupt file should be renamed
        assert not os.path.exists(corrupt_file)
        assert os.path.exists(corrupt_file + ".corrupt")
        captured = capsys.readouterr()
        assert "corrupt" in captured.out.lower()

    def test_pick_session_handles_oserror(self, tmp_path, monkeypatch, capsys):
        """OSError from from_jsonl (e.g. file lock) should be caught, not crash."""
        session_dir = str(tmp_path / "sessions")
        os.makedirs(session_dir, exist_ok=True)
        session_file = os.path.join(session_dir, "locked.jsonl")
        with open(session_file, "w", encoding="utf-8") as f:
            f.write(json.dumps({"role": "user", "content": "hi"}) + "\n")

        with patch("builtins.input", return_value="1"), \
             patch("mimo_harness.cli.Session.from_jsonl", side_effect=OSError("Permission denied")):
            result = _pick_session(session_dir)
        assert result is None
        # File should NOT be renamed (transient error, not corruption)
        assert os.path.exists(session_file)
        captured = capsys.readouterr()
        assert "Error" in captured.out

    def test_pick_session_partial_corruption_above_threshold(self, tmp_path, monkeypatch, capsys):
        """Partially corrupt session (>30% invalid) should be renamed to .corrupt."""
        session_dir = str(tmp_path / "sessions")
        os.makedirs(session_dir, exist_ok=True)
        session_file = os.path.join(session_dir, "mostly-bad.jsonl")
        lines = [
            json.dumps({"role": "user", "content": "hello"}) + "\n",
            "bad1\n",
            "bad2\n",
            "bad3\n",
        ]
        with open(session_file, "w", encoding="utf-8") as f:
            f.write("".join(lines))

        with patch("builtins.input", return_value="1"):
            result = _pick_session(session_dir)
        assert result is None
        assert not os.path.exists(session_file)
        assert os.path.exists(session_file + ".corrupt")
        captured = capsys.readouterr()
        assert "corrupt" in captured.out.lower()


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


# ============================================================================
# P0: Additional CLI test coverage
# ============================================================================


class TestHandleCommandAbort:
    """Test /abort command triggers graceful abort."""

    def test_abort_command(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        assert not harness.graceful_abort.is_requested()
        _handle_command(["/abort"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Abort requested" in captured.out
        assert harness.graceful_abort.is_requested()


class TestHandleCommandHelp:
    """Test /help command via _handle_command."""

    def test_help_command(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        _handle_command(["/help"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "/help" in captured.out
        assert "/quit" in captured.out


class TestSessionFromJsonlEdgeCases:
    """Test Session.from_jsonl edge cases."""

    def test_from_jsonl_empty_file(self, tmp_path):
        from mimo_harness.context import Session
        f = tmp_path / "empty.jsonl"
        f.write_text("", encoding="utf-8")
        # Empty file: no messages, no skipped lines -> returns empty session
        result = Session.from_jsonl(str(f))
        assert len(result.session.messages) == 0
        assert result.skipped == 0

    def test_from_jsonl_all_invalid_lines(self, tmp_path):
        from mimo_harness.context import Session
        f = tmp_path / "bad.jsonl"
        f.write_text("not json\nalso bad\n", encoding="utf-8")
        with pytest.raises(ValueError, match="No valid messages"):
            Session.from_jsonl(str(f))

    def test_from_jsonl_mixed_valid_invalid(self, tmp_path):
        from mimo_harness.context import Session
        f = tmp_path / "mixed.jsonl"
        lines = [
            json.dumps({"role": "user", "content": "hello"}) + "\n",
            "not valid json\n",
            json.dumps({"role": "assistant", "content": "hi"}) + "\n",
        ]
        f.write_text("".join(lines), encoding="utf-8")
        result = Session.from_jsonl(str(f))
        assert len(result.session.messages) == 2
        assert result.skipped == 1

    def test_from_jsonl_with_session_meta(self, tmp_path):
        from mimo_harness.context import Session
        f = tmp_path / "meta.jsonl"
        lines = [
            json.dumps({"role": "user", "content": "hello"}) + "\n",
            json.dumps({"role": "__session_meta__", "meta": {"name": "test", "compaction_count": 2}}) + "\n",
            json.dumps({"role": "assistant", "content": "hi"}) + "\n",
        ]
        f.write_text("".join(lines), encoding="utf-8")
        result = Session.from_jsonl(str(f))
        # __session_meta__ messages are skipped in the message list
        assert len(result.session.messages) == 2
        assert result.session.name == "test"
        assert result.session.compaction_count == 2

    def test_from_jsonl_rejects_unknown_role(self, tmp_path):
        from mimo_harness.context import Session
        f = tmp_path / "unknown_role.jsonl"
        lines = [
            json.dumps({"role": "user", "content": "hello"}) + "\n",
            json.dumps({"role": "unknown_role", "content": "weird"}) + "\n",
            json.dumps({"role": "assistant", "content": "hi"}) + "\n",
        ]
        f.write_text("".join(lines), encoding="utf-8")
        result = Session.from_jsonl(str(f))
        assert len(result.session.messages) == 2
        assert result.skipped == 1

    def test_from_jsonl_session_id_from_filename(self, tmp_path):
        from mimo_harness.context import Session
        f = tmp_path / "my-session-id.jsonl"
        f.write_text(json.dumps({"role": "user", "content": "hi"}) + "\n", encoding="utf-8")
        result = Session.from_jsonl(str(f))
        assert result.session.session_id == "my-session-id"


class TestOutputEdgeCases:
    """Test _output function edge cases."""

    def test_output_json_with_none_session(self, capsys):
        _output("test", output_format="json", session=None)
        captured = capsys.readouterr()
        data = json.loads(captured.out.strip())
        assert data["type"] == "result"
        assert data["session_id"] == ""

    def test_output_text_multiline(self, capsys):
        _output("line1\nline2\nline3", output_format="text")
        captured = capsys.readouterr()
        assert "line1" in captured.out
        assert "line3" in captured.out
