"""Tests for the Textual TUI interface (nexgent/tui.py).

Tests the TUI components without launching a full-screen application.
Focuses on the CommandSuggester, history, and tab completion logic.
"""

import asyncio
import threading
from unittest.mock import MagicMock, patch

import pytest

from nexgent.tui import MiMoTUI
from nexgent.context import Session


# ── Helpers ────────────────────────────────────────────────────

def _make_tui_app(tmp_path):
    """Create a MiMoTUI instance with mocked dependencies (no Textual launch)."""
    harness = MagicMock()
    harness.model = "test-model"
    harness.perms.auto_approve = True
    harness.plan_mode = False
    harness.graceful_abort = MagicMock()
    harness.graceful_abort.is_requested.return_value = False

    # Real Session object — no mock
    session = Session(
        session_id="test-session-1234",
        messages=[],
        working_dir=str(tmp_path),
    )

    app = MiMoTUI(
        harness=harness,
        session=session,
        memory_store=MagicMock(),
        checkpoint_manager=MagicMock(),
        session_dir=str(tmp_path),
        config_watcher=MagicMock(),
        scheduler=None,
        scheduled_prompts=[],
        scheduled_lock=threading.Lock(),
    )

    # Mock query_one so widget access works without a mounted screen.
    mock_status = MagicMock()
    mock_streaming = MagicMock()
    mock_output = MagicMock()
    mock_input = MagicMock()

    def _query_one(selector, cls=None):
        widgets = {
            "#status-bar": mock_status,
            "#streaming": mock_streaming,
            "#output": mock_output,
            "#input-area": mock_input,
        }
        return widgets.get(selector, MagicMock())

    app.query_one = _query_one
    # Stash mocks so tests can inspect them
    app._mock_status_bar = mock_status
    app._mock_streaming = mock_streaming
    app._mock_output = mock_output
    app._mock_input = mock_input

    return app


# ── CommandSuggester ──────────────────────────────────────────

class TestCommandSuggester:
    """Test the slash command auto-completion suggester."""

    @pytest.fixture
    def suggester(self):
        from nexgent.tui import CommandSuggester
        return CommandSuggester()

    def test_no_suggestion_for_non_slash(self, suggester):
        result = asyncio.run(suggester.get_suggestion("hello"))
        assert result is None

    def test_single_match(self, suggester):
        result = asyncio.run(suggester.get_suggestion("/he"))
        assert result == "/help"

    def test_no_match(self, suggester):
        result = asyncio.run(suggester.get_suggestion("/zzzzz"))
        assert result is None

    def test_exact_match_no_suggestion(self, suggester):
        result = asyncio.run(suggester.get_suggestion("/help"))
        assert result is None

    def test_multiple_matches_returns_first(self, suggester):
        result = asyncio.run(suggester.get_suggestion("/ex"))
        assert result == "/exit"

    def test_partial_command(self, suggester):
        result = asyncio.run(suggester.get_suggestion("/qui"))
        assert result == "/quit"

    def test_single_char(self, suggester):
        result = asyncio.run(suggester.get_suggestion("/"))
        assert result is not None  # Should return first matching command

    def test_all_slash_commands_have_prefix(self, suggester):
        for cmd in suggester.COMMANDS:
            assert cmd.startswith("/"), f"Command {cmd} doesn't start with /"


# ── Stream Buffer ─────────────────────────────────────────────

class TestStreamBuffer:
    """Test the output queue mechanism."""

    def test_output_queue_exists(self):
        from nexgent.tui import _output_queue
        import queue
        assert isinstance(_output_queue, queue.Queue)

    def test_queue_put_get(self):
        from nexgent.tui import _output_queue
        # Drain any existing items
        while not _output_queue.empty():
            try:
                _output_queue.get_nowait()
            except Exception:
                break
        _output_queue.put(("stream", "test"))
        kind, data = _output_queue.get_nowait()
        assert kind == "stream"
        assert data == "test"


# ── Imports ───────────────────────────────────────────────────

class TestTUIImports:
    """Test that TUI module imports correctly."""

    def test_import_mimo_tui(self):
        from nexgent.tui import MiMoTUI
        assert MiMoTUI is not None

    def test_import_run_tui(self):
        from nexgent.tui import run_tui
        assert callable(run_tui)

    def test_import_output_queue(self):
        from nexgent.tui import _output_queue
        import queue
        assert isinstance(_output_queue, queue.Queue)

    def test_import_set_get_app(self):
        from nexgent.tui import _get_tui_app, _set_tui_app
        assert callable(_get_tui_app)
        assert callable(_set_tui_app)

    def test_default_tui_app_is_none(self):
        from nexgent.tui import _get_tui_app
        app = _get_tui_app()
        assert app is None


# ── Class Attributes ─────────────────────────────────────────

class TestTUIClass:
    """Test MiMoTUI class attributes without launching the app."""

    def test_has_command_list(self):
        from nexgent.tui import MiMoTUI
        assert hasattr(MiMoTUI, 'COMMANDS')
        assert len(MiMoTUI.COMMANDS) > 20
        assert "/help" in MiMoTUI.COMMANDS
        assert "/quit" in MiMoTUI.COMMANDS
        assert "/effort" in MiMoTUI.COMMANDS

    def test_has_bindings(self):
        from nexgent.tui import MiMoTUI
        binding_keys = [b.key for b in MiMoTUI.BINDINGS]
        assert "ctrl+c" in binding_keys
        assert "escape" in binding_keys
        assert "up" in binding_keys
        assert "down" in binding_keys
        assert "tab" in binding_keys

    def test_has_css(self):
        from nexgent.tui import MiMoTUI
        assert MiMoTUI.CSS is not None
        assert "#output" in MiMoTUI.CSS
        assert "#input-area" in MiMoTUI.CSS
        assert "#streaming" in MiMoTUI.CSS
        assert "#status-bar" in MiMoTUI.CSS

    def test_has_required_methods(self):
        from nexgent.tui import MiMoTUI
        expected_methods = [
            'compose', 'on_mount', 'on_unmount',
            'write_output', '_show_banner', '_update_status_bar',
            'on_input_submitted', 'on_input_changed',
            '_handle_command', '_run_agent',
            '_handle_during_agent',
            'action_abort', 'action_quit', 'action_force_kill',
            'action_history_up', 'action_history_down',
            'action_tab_complete',
            '_start_streaming_internal', '_end_streaming_internal',
            '_drain_output_queue',
        ]
        for method in expected_methods:
            assert hasattr(MiMoTUI, method), f"Missing method: {method}"


# ── /btw Registration ────────────────────────────────────────

class TestBTWRegistration:
    """Test that /btw is properly registered in command lists."""

    def test_btw_in_suggest_commands(self):
        from nexgent.commands import SUGGEST_COMMANDS
        assert "/btw" in SUGGEST_COMMANDS

    def test_btw_in_slash_commands(self):
        from nexgent.commands import SLASH_COMMANDS
        assert "/btw" in SLASH_COMMANDS

    def test_btw_suggestion(self):
        from nexgent.tui import CommandSuggester
        suggester = CommandSuggester()
        result = asyncio.run(suggester.get_suggestion("/bt"))
        assert result == "/btw"


# ── Session Thread Safety ─────────────────────────────────────

class TestSessionThreadSafety:
    """Test Session.add_message thread safety for /btw injection."""

    def test_session_add_message_basic(self):
        from nexgent.context import Session
        session = Session(session_id="test-btw", messages=[])
        session.add_message("user", "test btw message")
        msgs = session.get_messages()
        assert len(msgs) == 1
        assert msgs[0]["role"] == "user"
        assert msgs[0]["content"] == "test btw message"

    def test_session_add_message_concurrent(self):
        from nexgent.context import Session
        session = Session(session_id="test-concurrent", messages=[])
        errors = []

        def add_msg(i):
            try:
                session.add_message("user", f"message {i}")
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=add_msg, args=(i,)) for i in range(50)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert len(errors) == 0
        assert len(session.get_messages()) == 50


# ── /btw Parsing Logic ───────────────────────────────────────

class TestBTWParsing:
    """Test /btw command parsing logic."""

    def test_btw_strips_prefix(self):
        text = "/btw please use a different approach"
        from nexgent.tui import _BTW_CMD
        btw_msg = text[len(_BTW_CMD):].strip()
        assert btw_msg == "please use a different approach"

    def test_btw_exact_command_match(self):
        from nexgent.tui import _BTW_CMD
        def is_btw(text):
            return text == _BTW_CMD or text.startswith(_BTW_CMD + " ")

        assert is_btw("/btw hello")
        assert is_btw("/btw")
        assert not is_btw("/btwxyz")
        assert not is_btw("/btw2")
        assert not is_btw("/btwmsg something")

    def test_btw_empty_message_rejected(self):
        text = "/btw"
        from nexgent.tui import _BTW_CMD
        btw_msg = text[len(_BTW_CMD):].strip()
        assert btw_msg == ""

    def test_btw_whitespace_only_rejected(self):
        text = "/btw   "
        from nexgent.tui import _BTW_CMD
        btw_msg = text[len(_BTW_CMD):].strip()
        assert btw_msg == ""


# ── Queue Logic ──────────────────────────────────────────────

class TestQueueLogic:
    """Test command queue data structure and drain behavior."""

    def test_queue_fifo_order(self):
        cmd_queue = []
        cmd_queue.append("first task")
        cmd_queue.append("second task")
        cmd_queue.append("third task")
        results = []
        while cmd_queue:
            results.append(cmd_queue.pop(0))
        assert results == ["first task", "second task", "third task"]
        assert len(cmd_queue) == 0

    def test_drain_skips_slash_commands_until_agent_task(self):
        cmd_queue = ["/clear", "/compact", "do real work", "another task"]
        processed = []
        agent_started = None

        while cmd_queue:
            cmd = cmd_queue.pop(0)
            if cmd.startswith("/"):
                processed.append(("slash", cmd))
            else:
                agent_started = cmd
                break

        assert processed == [("slash", "/clear"), ("slash", "/compact")]
        assert agent_started == "do real work"
        assert cmd_queue == ["another task"]

    def test_drain_all_slash_commands_exhausts_queue(self):
        cmd_queue = ["/clear", "/compact", "/help"]
        processed = []

        while cmd_queue:
            cmd = cmd_queue.pop(0)
            if cmd.startswith("/"):
                processed.append(cmd)
            else:
                break

        assert processed == ["/clear", "/compact", "/help"]
        assert len(cmd_queue) == 0

    def test_queued_btw_is_valid_command(self):
        from nexgent.tui import _BTW_CMD
        queued = "/btw change approach to iterative"
        assert queued.startswith(_BTW_CMD + " ")
        btw_msg = queued[len(_BTW_CMD):].strip()
        assert btw_msg == "change approach to iterative"

    def test_empty_string_not_queued(self):
        cmd_queue = []
        text = ""
        if text:
            cmd_queue.append(text)
        assert len(cmd_queue) == 0

    def test_queue_preserves_whitespace_content(self):
        cmd_queue = []
        cmd_queue.append("  hello   world  ")
        assert cmd_queue[0] == "  hello   world  "


# ── Behavioral Tests ─────────────────────────────────────────

class TestTUIBehavior:
    """Behavioral tests using actual MiMoTUI instances (no source inspection)."""

    def test_command_queue_initialized_empty(self, tmp_path):
        app = _make_tui_app(tmp_path)
        assert app._command_queue == []

    def test_btw_during_agent_injects_message(self, tmp_path):
        """/btw while agent runs injects message into session."""
        app = _make_tui_app(tmp_path)
        app._agent_running = True
        app._handle_during_agent("/btw use iterative approach")
        assert len(app.session.messages) == 1
        assert app.session.messages[0] == {"role": "user", "content": "use iterative approach"}

    def test_btw_during_agent_empty_rejected(self, tmp_path):
        """/btw with no message does not add to session."""
        app = _make_tui_app(tmp_path)
        app._agent_running = True
        app._handle_during_agent("/btw")
        assert len(app.session.messages) == 0

    def test_btw_during_agent_whitespace_rejected(self, tmp_path):
        """/btw with only spaces does not add to session."""
        app = _make_tui_app(tmp_path)
        app._agent_running = True
        app._handle_during_agent("/btw   ")
        assert len(app.session.messages) == 0

    def test_non_btw_during_agent_queues(self, tmp_path):
        """Non-/btw input during agent run gets queued."""
        app = _make_tui_app(tmp_path)
        app._agent_running = True
        app._handle_during_agent("do something else")
        assert app._command_queue == ["do something else"]

    def test_multiple_inputs_queued_in_order(self, tmp_path):
        """Multiple inputs during agent run are queued FIFO."""
        app = _make_tui_app(tmp_path)
        app._agent_running = True
        app._handle_during_agent("first")
        app._handle_during_agent("second")
        app._handle_during_agent("third")
        assert app._command_queue == ["first", "second", "third"]

    def test_btw_during_agent_does_not_queue(self, tmp_path):
        """/btw injects into session, does not add to queue."""
        app = _make_tui_app(tmp_path)
        app._agent_running = True
        app._handle_during_agent("/btw some guidance")
        assert app._command_queue == []

    def test_on_agent_done_drains_slash_commands(self, tmp_path):
        """_on_agent_done processes queued /btw commands via _handle_command."""
        app = _make_tui_app(tmp_path)
        app._agent_running = True
        app._command_queue = ["/btw context msg"]
        app._on_agent_done()
        assert app._command_queue == []
        assert len(app.session.messages) == 1
        assert app.session.messages[0] == {"role": "user", "content": "context msg"}

    def test_on_agent_done_starts_agent_for_non_slash(self, tmp_path):
        """_on_agent_done starts agent for first non-slash queued command."""
        app = _make_tui_app(tmp_path)
        app._agent_running = True
        app._command_queue = ["real task"]
        with patch.object(app, '_run_agent') as mock_run:
            app._on_agent_done()
        mock_run.assert_called_once_with("real task")

    def test_on_agent_done_stops_at_first_non_slash(self, tmp_path):
        """_on_agent_done breaks after starting agent, leaving rest in queue."""
        app = _make_tui_app(tmp_path)
        app._agent_running = True
        app._command_queue = ["task1", "task2"]
        with patch.object(app, '_run_agent') as mock_run:
            app._on_agent_done()
        mock_run.assert_called_once_with("task1")
        assert app._command_queue == ["task2"]

    def test_on_agent_done_empty_queue(self, tmp_path):
        """_on_agent_done with empty queue does nothing harmful."""
        app = _make_tui_app(tmp_path)
        app._agent_running = True
        app._command_queue = []
        app._on_agent_done()
        assert app._command_queue == []
        assert app._agent_running is False

    def test_on_agent_done_restores_placeholder_when_idle(self, tmp_path):
        """_on_agent_done restores default placeholder when no new agent starts."""
        app = _make_tui_app(tmp_path)
        app._agent_running = True
        app._command_queue = []
        with patch.object(app, '_set_input_placeholder') as mock_ph:
            app._on_agent_done()
        mock_ph.assert_called_with(app._default_placeholder)

    def test_on_agent_done_does_not_reset_placeholder_when_agent_started(self, tmp_path):
        """_on_agent_done does not reset placeholder if drain started a new agent."""
        app = _make_tui_app(tmp_path)
        app._agent_running = True
        app._command_queue = ["real task"]

        def fake_run_agent(task):
            app._agent_running = True  # simulate _run_agent setting this

        with patch.object(app, '_run_agent', side_effect=fake_run_agent):
            with patch.object(app, '_set_input_placeholder') as mock_ph:
                app._on_agent_done()
        # _set_input_placeholder should NOT be called with default,
        # because _agent_running is True
        mock_ph.assert_not_called()

    def test_interrupt_clears_queue(self, tmp_path):
        """action_interrupt clears the command queue."""
        app = _make_tui_app(tmp_path)
        app._agent_running = True
        app._command_queue = ["task1", "task2"]
        app.action_interrupt()
        assert app._command_queue == []

    def test_interrupt_requests_abort(self, tmp_path):
        """action_interrupt calls harness.graceful_abort.request()."""
        app = _make_tui_app(tmp_path)
        app._agent_running = True
        app._command_queue = []
        app.action_interrupt()
        app.harness.graceful_abort.request.assert_called_once()

    def test_btw_idle_adds_to_context(self, tmp_path):
        """/btw when agent idle adds message to session context."""
        app = _make_tui_app(tmp_path)
        app._agent_running = False
        app._handle_command("/btw prepare for next task")
        assert len(app.session.messages) == 1
        assert app.session.messages[0] == {"role": "user", "content": "prepare for next task"}

    def test_btw_idle_empty_shows_usage(self, tmp_path):
        """/btw with no message when idle shows usage hint."""
        app = _make_tui_app(tmp_path)
        app._agent_running = False
        with patch.object(app, 'write_output') as mock_out:
            app._handle_command("/btw")
        mock_out.assert_called()
        call_args = str(mock_out.call_args)
        assert "Usage" in call_args

    def test_run_agent_sets_running_state(self, tmp_path):
        """_run_agent sets _agent_running to True."""
        app = _make_tui_app(tmp_path)
        with patch.object(app, 'run_worker'):
            app._run_agent("test task")
        assert app._agent_running is True

    def test_run_agent_sets_running_placeholder(self, tmp_path):
        """_run_agent updates placeholder to running state message."""
        app = _make_tui_app(tmp_path)
        with patch.object(app, 'run_worker'):
            app._run_agent("test task")
        assert "/btw" in app._mock_input.placeholder

    def test_enable_input_restores_default_placeholder(self, tmp_path):
        """_enable_input restores default placeholder and enables input."""
        app = _make_tui_app(tmp_path)
        app._mock_input.disabled = True
        app._enable_input()
        assert app._mock_input.placeholder == app._default_placeholder
        assert app._mock_input.disabled is False

    def test_handle_during_agent_non_btw_shows_queued_panel(self, tmp_path):
        """Queued non-/btw input is displayed with a 'Queued' panel."""
        app = _make_tui_app(tmp_path)
        app._agent_running = True
        with patch.object(app, 'write_output') as mock_out:
            app._handle_during_agent("some task")
        # Should have written a Panel with "Queued" in the title
        panel = mock_out.call_args[0][0]
        assert "Queued" in panel.title

    def test_handle_during_agent_btw_shows_injected_panel(self, tmp_path):
        """/btw input is displayed with an 'injected' panel."""
        app = _make_tui_app(tmp_path)
        app._agent_running = True
        with patch.object(app, 'write_output') as mock_out:
            app._handle_during_agent("/btw some guidance")
        panel = mock_out.call_args[0][0]
        assert "injected" in panel.title

    def test_drain_handles_slash_command_error(self, tmp_path):
        """Queue drain continues after a slash command raises an error."""
        app = _make_tui_app(tmp_path)
        app._agent_running = True
        app._command_queue = ["/bad_cmd", "real task"]

        call_count = [0]
        original_handle = app._handle_command

        def patched_handle(text):
            call_count[0] += 1
            if text == "/bad_cmd":
                raise ValueError("bad command")
            return original_handle(text)

        with patch.object(app, '_handle_command', side_effect=patched_handle):
            with patch.object(app, '_run_agent') as mock_run:
                app._on_agent_done()
        # Should have tried /bad_cmd, then moved to "real task"
        assert call_count[0] == 1
        mock_run.assert_called_once_with("real task")

    def test_btw_with_multiple_spaces_parses_correctly(self, tmp_path):
        """/btw followed by multiple spaces then content works correctly."""
        app = _make_tui_app(tmp_path)
        app._agent_running = True
        app._handle_during_agent("/btw   hello world  ")
        assert len(app.session.messages) == 1
        assert app.session.messages[0] == {"role": "user", "content": "hello world"}

    def test_queue_size_limit_enforced(self, tmp_path):
        """Queue rejects new items when at max capacity."""
        from nexgent.tui import _MAX_QUEUE_SIZE
        app = _make_tui_app(tmp_path)
        app._agent_running = True
        app._command_queue = ["x"] * _MAX_QUEUE_SIZE
        with patch.object(app, 'write_output') as mock_out:
            app._handle_during_agent("one more")
        assert len(app._command_queue) == _MAX_QUEUE_SIZE
        call_args = str(mock_out.call_args)
        assert "Queue full" in call_args

    def test_parse_btw_returns_none_for_non_btw(self):
        """_parse_btw returns None for non-/btw commands."""
        assert MiMoTUI._parse_btw("hello") is None
        assert MiMoTUI._parse_btw("/help") is None
        assert MiMoTUI._parse_btw("/clear") is None

    def test_parse_btw_returns_empty_for_bare_btw(self):
        """_parse_btw returns empty string for bare /btw."""
        assert MiMoTUI._parse_btw("/btw") == ""

    def test_parse_btw_returns_content(self):
        """_parse_btw returns stripped content for /btw with message."""
        assert MiMoTUI._parse_btw("/btw hello") == "hello"
        assert MiMoTUI._parse_btw("/btw   spaced   ") == "spaced"

    def test_on_agent_done_run_agent_exception_preserves_queue(self, tmp_path):
        """If _run_agent raises during drain, remaining queue items are preserved."""
        app = _make_tui_app(tmp_path)
        app._agent_running = True
        app._command_queue = ["task1", "task2"]

        def failing_run_agent(task):
            raise RuntimeError("agent failed")

        with patch.object(app, '_run_agent', side_effect=failing_run_agent):
            with patch.object(app, 'write_output') as mock_out:
                app._on_agent_done()
        # task1 failed, task2 should remain in queue
        assert app._command_queue == ["task2"]
        # Error message should be displayed
        error_calls = [str(c) for c in mock_out.call_args_list]
        assert any("Error" in c for c in error_calls)
