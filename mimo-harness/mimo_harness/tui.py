"""Full-screen TUI interface using Textual.

Provides a fixed input area at the bottom with scrolling output above,
similar to Claude Code's interface. Uses alternate screen buffer.

Falls back to normal REPL when:
- stdin is not a TTY (piped input)
- Textual is not installed
"""

import io
import sys
import threading
from contextlib import redirect_stdout

from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from rich import box

from textual.app import App, ComposeResult
from textual.widgets import RichLog, Input, Static
from textual.binding import Binding
from textual.suggester import Suggester

# Streaming token buffer — written by agent, flushed to TUI periodically
_stream_buffer: list[str] = []
_stream_buffer_lock = threading.Lock()


def _get_tui_app():
    """Get the current TUI app instance (set by MiMoTUI.on_mount)."""
    return getattr(_get_tui_app, '_instance', None)


def _set_tui_app(app):
    """Set the current TUI app instance."""
    _get_tui_app._instance = app


def flush_stream_buffer():
    """Flush accumulated streaming tokens to the TUI streaming widget.

    Thread-safe — can be called from the agent worker thread.
    """
    app = _get_tui_app()
    if not app:
        return
    with _stream_buffer_lock:
        if not _stream_buffer:
            return
        text = ''.join(_stream_buffer)
        _stream_buffer.clear()
    try:
        app.call_from_thread(app._append_streaming, text)
    except Exception:
        pass


class CommandSuggester(Suggester):
    """Auto-suggest slash commands for the input widget."""

    COMMANDS = [
        "/help", "/quit", "/exit", "/clear", "/tools", "/stats",
        "/tokens", "/compact", "/context", "/memory", "/remember",
        "/hooks", "/dry-run", "/auto", "/plan", "/abort", "/effort",
        "/mode", "/save", "/load", "/fork", "/rewind", "/init",
        "/subagents", "/subagent", "/parallel", "/pipeline",
    ]

    async def get_suggestion(self, value: str) -> str | None:
        if not value.startswith("/"):
            return None
        for cmd in self.COMMANDS:
            if cmd.startswith(value) and cmd != value:
                return cmd  # Return full text, not suffix
        return None


class MiMoTUI(App):
    """Full-screen TUI for MiMo Harness.

    Layout (top to bottom):
    - RichLog (#output): scrolling conversation history
    - Static (#streaming): current streaming text (hidden when idle)
    - Static (#status-bar): session/token info
    - Input (#input-area): user input, fixed at bottom
    """

    CSS = """
    Screen {
        layout: vertical;
    }
    #output {
        height: 1fr;
        padding: 0 1;
    }
    #streaming {
        height: auto;
        min-height: 0;
        padding: 0 1;
        display: none;
    }
    #streaming.visible {
        display: block;
    }
    #status-bar {
        height: 1;
        padding: 0 1;
    }
    #input-area {
        dock: bottom;
        height: 3;
        padding: 0 1;
        border: tall $accent;
    }
    """

    BINDINGS = [
        Binding("ctrl+c", "abort", "Abort", show=False, priority=True),
        Binding("escape", "quit", "Quit", show=False),
        Binding("up", "history_up", "History Up", show=False),
        Binding("down", "history_down", "History Down", show=False),
        Binding("tab", "tab_complete", "Tab Complete", show=False),
    ]

    # All slash commands for tab completion
    COMMANDS = [
        "/help", "/quit", "/exit", "/clear", "/tools", "/stats",
        "/tokens", "/compact", "/context", "/memory", "/remember",
        "/hooks", "/dry-run", "/auto", "/plan", "/abort", "/effort",
        "/mode", "/save", "/load", "/fork", "/rewind", "/init",
        "/subagents", "/subagent", "/parallel", "/pipeline",
    ]

    def __init__(self, harness, session, memory_store, checkpoint_manager,
                 session_dir, config_watcher, scheduler, scheduled_prompts,
                 scheduled_lock, **kwargs):
        super().__init__(**kwargs)
        self.harness = harness
        self.session = session
        self.memory_store = memory_store
        self.checkpoint_manager = checkpoint_manager
        self.session_dir = session_dir
        self.config_watcher = config_watcher
        self.scheduler = scheduler
        self.scheduled_prompts = scheduled_prompts
        self.scheduled_lock = scheduled_lock
        self._agent_running = False
        self._streaming_text = ""  # accumulated streaming text
        # Input history
        self._history: list[str] = []
        self._history_idx = -1  # -1 = current (not browsing)
        self._saved_input = ""  # saved current input when browsing history
        # Tab completion state
        self._tab_matches: list[str] = []
        self._tab_idx = -1
        self._tab_prefix = ""

    def compose(self) -> ComposeResult:
        yield RichLog(
            id="output",
            markup=True,
            wrap=True,
            auto_scroll=True,
            highlight=False,
        )
        yield Static("", id="streaming")
        yield Static("", id="status-bar")
        yield Input(
            placeholder="Type a message or /help...",
            id="input-area",
            suggester=CommandSuggester(),
        )

    def on_mount(self) -> None:
        _set_tui_app(self)
        self._show_banner()
        self._update_status_bar()
        self.query_one("#input-area", Input).focus()

    def on_unmount(self) -> None:
        _set_tui_app(None)

    # ── Streaming Support ──────────────────────────────────────

    def _start_streaming(self) -> None:
        """Show the streaming widget for real-time token display."""
        self._streaming_text = ""
        stream = self.query_one("#streaming", Static)
        stream.add_class("visible")
        stream.update("")

    def _append_streaming(self, text: str) -> None:
        """Append tokens to the streaming widget (called from worker thread)."""
        self._streaming_text += text
        stream = self.query_one("#streaming", Static)
        stream.update(self._streaming_text)

    def _end_streaming(self) -> None:
        """Move streaming content to RichLog and hide streaming widget."""
        stream = self.query_one("#streaming", Static)
        stream.remove_class("visible")
        if self._streaming_text.strip():
            log = self.query_one("#output", RichLog)
            log.write(self._streaming_text)
        self._streaming_text = ""

    # ── Output API ──────────────────────────────────────────────

    def write_output(self, content) -> None:
        """Write content to the output log.

        Accepts Rich renderables (Panel, Table, Text, Syntax)
        or plain strings.
        """
        log = self.query_one("#output", RichLog)
        log.write(content)

    # ── Banner & Status ─────────────────────────────────────────

    def _show_banner(self) -> None:
        log = self.query_one("#output", RichLog)
        banner = Panel(
            "[bold cyan]MiMo Harness v0.3.0[/]\n"
            "AI Agent powered by Xiaomi MiMo model\n"
            "Claude Code architecture patterns",
            border_style="cyan",
            width=56,
            padding=(0, 1),
        )
        log.write(banner)
        log.write("")

        # Session info table
        table = Table(show_header=False, box=None, padding=(0, 2))
        table.add_column(style="dim", width=10)
        table.add_column()
        table.add_row("Model", self.harness.model)
        api_key = getattr(self.harness, '_api_key', '') or ''
        table.add_row("API Key", "*" * 12 if api_key else "[red]NOT SET[/red]")
        mode = 'plan' if getattr(self.harness, 'plan_mode', False) else \
               'auto-approve' if self.harness.perms.auto_approve else 'interactive'
        table.add_row("Mode", mode)
        table.add_row("Session", self.session.session_id)
        log.write(table)
        log.write("")
        log.write("[dim]Type /help for commands, or just start chatting.[/dim]")
        log.write("")

    def _update_status_bar(self) -> None:
        from .context import estimate_tokens, CONTEXT_WINDOW_TOKENS
        from .display import _format_tokens
        tokens = estimate_tokens(self.session.messages)
        token_str = _format_tokens(tokens)
        max_str = _format_tokens(CONTEXT_WINDOW_TOKENS)
        msgs = len(self.session.messages)
        status = self.query_one("#status-bar", Static)
        status.update(
            f"  [dim]Session[/dim] {self.session.session_id[:8]}  "
            f"[dim]|[/dim]  [dim]Tokens[/dim] {token_str}/{max_str}  "
            f"[dim]|[/dim]  [dim]Msgs[/dim] {msgs}"
        )

    # ── Input Handling ──────────────────────────────────────────

    def on_input_changed(self, event: Input.Changed) -> None:
        """Reset tab completion state when user types."""
        self._tab_matches = []
        self._tab_idx = -1

    def on_input_submitted(self, event: Input.Submitted) -> None:
        text = event.value.strip()
        event.input.clear()
        # Save to history
        if text:
            self._history.append(text)
        self._history_idx = -1
        self._saved_input = ""
        self._tab_matches = []
        self._tab_idx = -1
        if not text:
            # Check scheduled prompts
            with self.scheduled_lock:
                scheduled = self.scheduled_prompts.pop(0) if self.scheduled_prompts else None
            if scheduled:
                text = scheduled
                self.write_output("[dim]Executing scheduled prompt...[/dim]")
            else:
                return

        # Config hot-reload
        config_changed, new_config = self.config_watcher.check_for_changes()
        if config_changed:
            if "hooks" in new_config:
                from .hooks import HookRunner
                self.harness._hook_runner = HookRunner()
                self.harness._hook_runner.load_from_config(new_config)
            rules_path = new_config.get("rules_file")
            if rules_path:
                self.harness.perms.rules.clear()
                self.harness.perms.load_rules_from_file(rules_path)
            self.write_output("[dim]Config reloaded[/dim]")

        # Show user input
        self.write_output(Panel(
            text,
            title="[cyan]> You[/cyan]",
            border_style="cyan",
            width=72,
            padding=(0, 1),
        ))

        if text.startswith("/"):
            self._handle_command(text)
        else:
            self._run_agent(text)

        self._update_status_bar()

    # ── Commands ────────────────────────────────────────────────

    def _handle_command(self, text: str) -> None:
        from .cli import _handle_command
        parts = text.split()
        cmd = [parts[0].lower()] + parts[1:]

        # Capture stdout output from the command handler
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                action, new_session = _handle_command(
                    cmd, self.harness, self.session, self.memory_store,
                    self.checkpoint_manager, self.session_dir,
                )
            self.session = new_session
        except SystemExit:
            action = "continue"

        output = buf.getvalue()
        if output.strip():
            self.write_output(output.rstrip())

        if action == "quit":
            self._save_and_exit()

    # ── Agent Execution ─────────────────────────────────────────

    def _run_agent(self, task: str) -> None:
        self._agent_running = True
        self._disable_input()
        self._start_streaming()

        import mimo_harness.display as _display_mod

        # Save originals for restore
        orig_console_print = _display_mod._console.print
        orig_safe_print = _display_mod._safe_print
        orig_print_token = _display_mod.print_streaming_token

        def tui_console_print(*args, **kwargs):
            """Intercept _console.print — route ALL display output to TUI."""
            end = kwargs.get('end', '\n')
            sep = kwargs.get('sep', ' ')
            text = sep.join(str(a) for a in args)
            if not text and end == '\n':
                return
            full = text + end
            # Streaming tokens use end="" — buffer them
            if end == '':
                with _stream_buffer_lock:
                    _stream_buffer.append(full)
                    if len(_stream_buffer) >= 20:
                        flush_stream_buffer()
            else:
                # Non-streaming: flush pending stream, then write
                flush_stream_buffer()
                try:
                    self.call_from_thread(self._end_streaming)
                    self.call_from_thread(self.write_output, full.rstrip('\n'))
                    self.call_from_thread(self._start_streaming)
                except Exception:
                    pass

        def tui_safe_print(*args, **kwargs):
            """Route _safe_print calls to TUI output."""
            sep = kwargs.get('sep', ' ')
            end = kwargs.get('end', '\n')
            text = sep.join(str(a) for a in args)
            full = text + end
            if text:
                flush_stream_buffer()
                try:
                    self.call_from_thread(self._end_streaming)
                    self.call_from_thread(self.write_output, full.rstrip('\n'))
                    self.call_from_thread(self._start_streaming)
                except Exception:
                    pass

        def tui_print_streaming_token(token: str, **kwargs):
            """Buffer streaming tokens for periodic flush."""
            with _stream_buffer_lock:
                _stream_buffer.append(token)
                if len(_stream_buffer) >= 20:
                    flush_stream_buffer()

        # Monkey-patch ALL output paths
        _display_mod._console.print = tui_console_print
        _display_mod._safe_print = tui_safe_print
        _display_mod.print_streaming_token = tui_print_streaming_token

        self.run_worker(
            self._agent_worker(task, _display_mod, orig_console_print,
                               orig_safe_print, orig_print_token),
            exclusive=True,
            thread=True,
        )

    def _agent_worker(self, task, display_mod, orig_console_print,
                      orig_safe_print, orig_print_token):
        def worker():
            try:
                result = self.harness.run(task, self.session)
                # Flush remaining streaming tokens
                flush_stream_buffer()
                if result:
                    self.call_from_thread(self._end_streaming)
                    self.call_from_thread(self.write_output, result)
            except Exception as e:
                self.call_from_thread(self._end_streaming)
                self.call_from_thread(self.write_output, f"[red]Error: {e}[/red]")
            finally:
                # Restore ALL display functions
                display_mod._console.print = orig_console_print
                display_mod._safe_print = orig_safe_print
                display_mod.print_streaming_token = orig_print_token
                self.call_from_thread(self._on_agent_done)
        return worker

    def _on_agent_done(self) -> None:
        self._end_streaming()
        self._agent_running = False
        self._enable_input()
        self._update_status_bar()

    def _disable_input(self) -> None:
        inp = self.query_one("#input-area", Input)
        inp.disabled = True

    def _enable_input(self) -> None:
        inp = self.query_one("#input-area", Input)
        inp.disabled = False
        inp.focus()

    # ── Actions ─────────────────────────────────────────────────

    def action_abort(self) -> None:
        if self._agent_running:
            self.harness.graceful_abort.request()
            self.write_output("[yellow]Abort requested - stopping current task...[/yellow]")
        else:
            self._save_and_exit()

    def action_quit(self) -> None:
        self._save_and_exit()

    # ── History Navigation ──────────────────────────────────────

    def action_history_up(self) -> None:
        """Show previous input from history."""
        inp = self.query_one("#input-area", Input)
        if not self._history:
            return
        if self._history_idx == -1:
            # Save current input before browsing
            self._saved_input = inp.value
            self._history_idx = len(self._history) - 1
        elif self._history_idx > 0:
            self._history_idx -= 1
        else:
            return  # Already at the oldest
        inp.value = self._history[self._history_idx]
        # Move cursor to end
        inp.cursor_position = len(inp.value)

    def action_history_down(self) -> None:
        """Show next input from history."""
        inp = self.query_one("#input-area", Input)
        if self._history_idx == -1:
            return  # Not browsing
        if self._history_idx < len(self._history) - 1:
            self._history_idx += 1
            inp.value = self._history[self._history_idx]
        else:
            # Restore saved input
            self._history_idx = -1
            inp.value = self._saved_input
        inp.cursor_position = len(inp.value)

    # ── Tab Completion ──────────────────────────────────────────

    def action_tab_complete(self) -> None:
        """Cycle through matching slash commands."""
        inp = self.query_one("#input-area", Input)
        value = inp.value

        # Only complete slash commands
        if not value.startswith("/"):
            return

        # If we're already cycling with the same prefix, show next match
        if self._tab_matches and self._tab_prefix == value:
            self._tab_idx = (self._tab_idx + 1) % len(self._tab_matches)
            inp.value = self._tab_matches[self._tab_idx]
            inp.cursor_position = len(inp.value)
            return

        # Find all matching commands
        matches = [cmd for cmd in self.COMMANDS if cmd.startswith(value)]
        if not matches:
            return

        if len(matches) == 1:
            # Single match — complete it
            inp.value = matches[0] + " "
            inp.cursor_position = len(inp.value)
            self._tab_matches = []
            self._tab_idx = -1
        else:
            # Multiple matches — show them and start cycling
            self._tab_matches = matches
            self._tab_prefix = value
            self._tab_idx = 0
            inp.value = matches[0]
            inp.cursor_position = len(inp.value)
            # Show all matches in output
            self.write_output("  [dim]" + "  ".join(matches) + "[/dim]")

    def _save_and_exit(self) -> None:
        try:
            self.session.save_meta_to_jsonl()
        except OSError:
            pass
        if self.scheduler:
            self.scheduler.stop()
        self.write_output(
            f"  [dim]Session:[/dim]  {self.session.session_id} "
            f"({len(self.session.messages)} messages)"
        )
        self.write_output("[dim]Bye![/dim]")
        self.exit()


def run_tui(harness, session, memory_store, checkpoint_manager,
            session_dir, config_watcher, scheduler, scheduled_prompts,
            scheduled_lock) -> None:
    """Launch the Textual TUI application."""
    app = MiMoTUI(
        harness=harness,
        session=session,
        memory_store=memory_store,
        checkpoint_manager=checkpoint_manager,
        session_dir=session_dir,
        config_watcher=config_watcher,
        scheduler=scheduler,
        scheduled_prompts=scheduled_prompts,
        scheduled_lock=scheduled_lock,
    )
    app.run()
