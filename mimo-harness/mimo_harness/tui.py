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
    """Flush accumulated streaming tokens to TUI output.

    Called by the agent's display functions periodically.
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
        app.call_from_thread(app.write_output, text, end="")
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
                return cmd[len(value):]
        return None


class MiMoTUI(App):
    """Full-screen TUI for MiMo Harness.

    Layout:
    - Output area (RichLog): scrolling conversation history
    - Input area: fixed at bottom, single-line with command auto-complete
    """

    CSS = """
    Screen {
        layout: vertical;
    }
    #output {
        height: 1fr;
        padding: 0 1;
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

    def compose(self) -> ComposeResult:
        yield RichLog(
            id="output",
            markup=True,
            wrap=True,
            auto_scroll=True,
            highlight=False,
        )
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

    # ── Output API ──────────────────────────────────────────────

    def write_output(self, content, end="\n") -> None:
        """Write content to the output log.

        Accepts Rich renderables (Panel, Table, Text, Syntax)
        or plain strings. Thread-safe via call_from_thread.
        """
        log = self.query_one("#output", RichLog)
        if isinstance(content, str):
            log.write(content, end=end)
        else:
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
        self.write_output("[dim]Type /help for commands, or just start chatting.[/dim]")
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
            f"[dim]│[/dim]  [dim]Tokens[/dim] {token_str}/{max_str}  "
            f"[dim]│[/dim]  [dim]Msgs[/dim] {msgs}"
        )

    # ── Input Handling ──────────────────────────────────────────

    def on_input_submitted(self, event: Input.Submitted) -> None:
        text = event.value.strip()
        event.input.clear()
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
            title="[cyan]❯ You[/cyan]",
            border_style="cyan",
            width=min(76, 72),
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

        # Capture output from the command handler
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

        from .display import _safe_print as _orig_safe_print, print_streaming_token as _orig_print_token
        import mimo_harness.display as _display_mod

        # Save originals
        orig_safe_print = _display_mod._safe_print
        orig_print_token = _display_mod.print_streaming_token

        def tui_safe_print(*args, **kwargs):
            sep = kwargs.get('sep', ' ')
            end = kwargs.get('end', '\n')
            text = sep.join(str(a) for a in args)
            if text:
                try:
                    self.call_from_thread(self.write_output, text)
                except Exception:
                    pass

        def tui_print_streaming_token(token: str, **kwargs):
            with _stream_buffer_lock:
                _stream_buffer.append(token)
                if len(_stream_buffer) >= 20:
                    flush_stream_buffer()

        # Monkey-patch display functions
        _display_mod._safe_print = tui_safe_print
        _display_mod.print_streaming_token = tui_print_streaming_token

        self.run_worker(
            self._agent_worker(task, _display_mod, orig_safe_print, orig_print_token),
            exclusive=True,
            thread=True,
        )

    def _agent_worker(self, task, display_mod, orig_safe_print, orig_print_token):
        def worker():
            try:
                # Use thread-safe output capture
                result = self.harness.run(task, self.session)
                flush_stream_buffer()
                if result:
                    self.call_from_thread(self.write_output, result)
            except Exception as e:
                self.call_from_thread(self.write_output, f"[red]Error: {e}[/red]")
            finally:
                # Restore display functions
                display_mod._safe_print = orig_safe_print
                display_mod.print_streaming_token = orig_print_token
                self.call_from_thread(self._on_agent_done)
        return worker

    def _on_agent_done(self) -> None:
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
            self.write_output("[yellow]Abort requested — stopping current task...[/yellow]")
        else:
            self._save_and_exit()

    def action_quit(self) -> None:
        self._save_and_exit()

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
