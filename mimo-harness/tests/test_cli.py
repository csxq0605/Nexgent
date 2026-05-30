"""Tests for CLI entry point and REPL commands."""

import json
import os
import sys
import pytest

from mimo_harness.cli import _handle_command
from mimo_harness.context import Session


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
        # Simulate input() returning memory content then empty line
        _iter = iter(["This is important context", ""])
        monkeypatch.setattr("builtins.input", lambda _="": next(_iter))
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
        # Simulate input() returning empty line immediately
        monkeypatch.setattr("builtins.input", lambda _="": "")
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
        # Use real compact_context (requires API key for LLM compression)
        if not os.environ.get("MIMO_API_KEY") or os.environ.get("MIMO_API_KEY") == "test-key-for-testing":
            pytest.skip("Real MIMO_API_KEY not set for compact test")
        _handle_command(["/compact"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Compressing" in captured.out or "compacted" in captured.out.lower() or "compact" in captured.out.lower()

    def test_repl_init_command(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        monkeypatch.chdir(tmp_path)
        # Use real scan_project and generate_agents_md (filesystem operations)
        _handle_command(["/init"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "AGENTS.md" in captured.out
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
        monkeypatch.setattr("builtins.input", lambda _="": "n")
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

    def test_repl_abort_command(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        harness.graceful_abort.reset()
        _handle_command(["/abort"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Abort requested" in captured.out
        assert harness.graceful_abort.is_requested()

    def test_repl_help_command(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        _handle_command(["/help"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "/quit" in captured.out
        assert "/save" in captured.out
        assert "/memory" in captured.out

    def test_repl_context_command_with_messages(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        session.add_message("user", "hello world this is a test message")
        session.add_message("assistant", "response here")
        _handle_command(["/context"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Context breakdown" in captured.out
        assert "user" in captured.out
        assert "assistant" in captured.out
        assert "Total" in captured.out

    def test_repl_context_command_empty(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        _handle_command(["/context"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "No messages" in captured.out

    def test_repl_rewind_no_checkpoint(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        _handle_command(["/rewind"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "No checkpoint" in captured.out

    def test_repl_rewind_with_checkpoint(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        from mimo_harness.context import CheckpointManager
        memory_store = MemoryStore(str(tmp_path))
        cp_dir = str(tmp_path / "checkpoints")
        checkpoint_manager = CheckpointManager(cp_dir)
        # Create a test file and snapshot it
        test_file = tmp_path / "test.py"
        test_file.write_text("original")
        checkpoint_manager.snapshot(str(test_file))
        test_file.write_text("modified")
        _handle_command(["/rewind"], harness, session, memory_store, checkpoint_manager=checkpoint_manager)
        captured = capsys.readouterr()
        assert "Restored" in captured.out

    def test_repl_fork_command(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        session.auto_save_dir = str(tmp_path)
        session.add_message("user", "hello")
        old_id = session.session_id
        _handle_command(["/fork"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "forked" in captured.out
        assert session.session_id != old_id
        assert "fork-" in session.name

    def test_repl_stats_with_circuit_breaker_failures(self, monkeypatch, tmp_path, capsys):
        harness, session = _HarnessFixture.make(monkeypatch)
        from mimo_harness.memory import MemoryStore
        memory_store = MemoryStore(str(tmp_path))
        harness.circuit_breaker.consecutive_failures = 3
        _handle_command(["/stats"], harness, session, memory_store)
        captured = capsys.readouterr()
        assert "Circuit breaker failures: 3" in captured.out
        harness.circuit_breaker.consecutive_failures = 0


class TestMainFunctionPaths:
    """Test main() function with various argument combinations."""

    @pytest.fixture(autouse=True)
    def _require_api(self):
        """All main() tests require real API."""
        if not os.environ.get("MIMO_API_KEY") or os.environ.get("MIMO_API_KEY") == "test-key-for-testing":
            pytest.skip("Real MIMO_API_KEY not set")

    def test_main_single_task(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.argv", ["mimo", "--task", "Reply with the word hello."])
        from mimo_harness.cli import main
        main()
        captured = capsys.readouterr()
        assert len(captured.out.strip()) > 0

    def test_main_dry_run(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.argv", ["mimo", "--task", "test", "--dry-run"])
        from mimo_harness.cli import main
        main()
        captured = capsys.readouterr()
        # dry-run should print something (plan or acknowledgment)
        assert len(captured.out.strip()) > 0

    def test_main_plan_mode(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.argv", ["mimo", "--task", "Say hello", "--plan"])
        from mimo_harness.cli import main
        main()
        captured = capsys.readouterr()
        assert len(captured.out.strip()) > 0

    def test_main_stream_mode(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.argv", ["mimo", "--task", "Say hello", "--stream"])
        from mimo_harness.cli import main
        main()
        captured = capsys.readouterr()
        assert len(captured.out.strip()) > 0

    def test_main_repl_quit(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.argv", ["mimo"])
        monkeypatch.setattr("builtins.input", lambda _="": "/quit")
        from mimo_harness.cli import main
        main()
        captured = capsys.readouterr()
        assert "Bye!" in captured.out

    def test_main_repl_empty_then_quit(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.argv", ["mimo"])
        _iter = iter(["", "  ", "/quit"])
        monkeypatch.setattr("builtins.input", lambda _="": next(_iter))
        from mimo_harness.cli import main
        main()
        captured = capsys.readouterr()
        assert "Bye!" in captured.out

    def test_main_eof_exits(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.argv", ["mimo"])
        def _raise_eof(_=""): raise EOFError
        monkeypatch.setattr("builtins.input", _raise_eof)
        from mimo_harness.cli import main
        main()
        captured = capsys.readouterr()
        assert "Bye!" in captured.out
