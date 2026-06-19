"""Full-screen TUI interface using Textual.

Provides a fixed input area at the bottom with scrolling output above,
similar to Claude Code's interface. Uses alternate screen buffer.

Falls back to normal REPL when:
- stdin is not a TTY (piped input)
- Textual is not installed
"""

import io
import logging
import os
import queue
import sys
import threading
from contextlib import redirect_stdout
from threading import Event

_BTW_CMD = "/btw"
_MAX_QUEUE_SIZE = 50    # max queued commands during agent run

from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from rich import box

from textual.app import App, ComposeResult
from textual.widgets import RichLog, Input, Static
from textual.binding import Binding
from textual.suggester import Suggester

# ── Output queue: worker thread → main thread (non-blocking) ──
# Worker thread puts items here; main thread drains via timer.
# Items: ("stream", text), ("write", content), ("end_stream", None),
#        ("start_stream", None), ("done", None), ("permission", (desc, value))
_output_queue: queue.Queue = queue.Queue()


def _get_tui_app():
    """Get the current TUI app instance (set by MiMoTUI.on_mount)."""
    return getattr(_get_tui_app, '_instance', None)


def _set_tui_app(app):
    """Set the current TUI app instance."""
    _get_tui_app._instance = app


# Import shared command list
from .commands import SLASH_COMMANDS as _SHARED_COMMANDS, SUGGEST_COMMANDS


class CommandSuggester(Suggester):
    """Auto-suggest slash commands and @file references for the input widget."""

    COMMANDS = SUGGEST_COMMANDS

    async def get_suggestion(self, value: str) -> str | None:
        # Slash command suggestions
        if value.startswith("/"):
            for cmd in self.COMMANDS:
                if cmd.startswith(value) and cmd != value:
                    return cmd
            return None
        # @ file reference suggestions
        at_pos = value.rfind('@')
        if at_pos >= 0 and (at_pos == 0 or value[at_pos - 1] == ' '):
            prefix = value[at_pos + 1:]
            if ' ' not in prefix:
                from .file_references import scan_completions
                matches = scan_completions(prefix, os.getcwd(), limit=1)
                if matches:
                    return value[:at_pos + 1] + matches[0]
        return None


class MiMoTUI(App):
    """Full-screen TUI for Nexgent.

    Layout (top to bottom):
    - RichLog (#output): scrolling conversation history
    - Static (#streaming): current streaming text (hidden when idle)
    - Static (#status-bar): session/token info
    - Input (#input-area): user input, fixed at bottom

    Thread safety: all output from the agent worker thread goes through
    _output_queue (non-blocking put). A 50ms timer on the main thread
    drains the queue and updates widgets. This avoids call_from_thread
    deadlocks entirely.
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
        Binding("ctrl+k", "force_kill", "Force Kill", show=False, priority=True),
        Binding("escape", "interrupt", "Interrupt", show=False, priority=True),
        Binding("up", "history_up", "History Up", show=False),
        Binding("down", "history_down", "History Down", show=False),
        Binding("tab", "tab_complete", "Tab Complete", show=False, priority=True),
    ]

    # All slash commands for tab completion
    COMMANDS = _SHARED_COMMANDS

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
        # Command queue: typed during agent execution, auto-runs when agent finishes
        self._command_queue: list[str] = []
        # ResourceMonitor warnings pending display (thread-safe queue)
        self._monitor_warning_queue: queue.Queue[str] = queue.Queue()
        self._default_placeholder = "Type a message or /help..."
        # Input history
        self._history: list[str] = []
        self._history_idx = -1  # -1 = current (not browsing)
        self._saved_input = ""  # saved current input when browsing history
        # Tab completion state
        self._tab_matches: list[str] = []
        self._tab_idx = -1
        self._tab_prefix = ""
        # Permission request state (used when agent needs user approval)
        self._permission_event: Event | None = None
        self._permission_result: bool | None = None
        self._permission_mode = False  # True when waiting for Y/n
        # Worker thread tracking for force-kill
        self._worker_thread: threading.Thread | None = None
        # Generation counter to discard stale "done" signals from killed threads
        self._agent_generation = 0
        # Token estimate cache to avoid recomputing every 50ms
        self._token_cache: tuple[int, int] = (0, 0)  # (msg_count, token_estimate)
        # Flag set by _save_and_exit to stop drain loop from starting new agents
        self._exiting = False

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
        )

    def on_mount(self) -> None:
        _set_tui_app(self)
        self._show_banner()
        self._update_status_bar()
        self.query_one("#input-area", Input).focus()
        # Start output queue drain timer (50ms interval)
        self.set_interval(0.05, self._drain_output_queue)

    def on_unmount(self) -> None:
        _set_tui_app(None)

    # ── Output Queue Drain (main thread timer) ─────────────────

    def _drain_output_queue(self) -> None:
        """Drain items from _output_queue and update widgets.

        Called every 50ms by Textual timer on the main thread.
        This is the ONLY place widgets are touched from.
        """
        try:
            for _ in range(100):  # max 100 items per tick to avoid blocking UI
                kind, data = _output_queue.get_nowait()
                if kind == "stream":
                    # Append streaming tokens to the streaming widget
                    self._streaming_text += data
                    stream = self.query_one("#streaming", Static)
                    stream.update(self._streaming_text)
                elif kind == "write":
                    # Write completed content to RichLog
                    self._end_streaming_internal()
                    log = self.query_one("#output", RichLog)
                    log.write(data)
                    self._start_streaming_internal()
                elif kind == "start_stream":
                    self._start_streaming_internal()
                elif kind == "end_stream":
                    self._end_streaming_internal()
                elif kind == "done":
                    self._on_agent_done(data)
                elif kind == "permission":
                    desc, value = data
                    self._show_permission_prompt(desc, value)
        except queue.Empty:
            pass
        except Exception as exc:
            # Prevent drain timer from dying on unexpected errors.
            # If the timer stops, the TUI freezes permanently.
            logging.debug("TUI drain error (non-fatal): %s", exc, exc_info=True)
        # Display pending ResourceMonitor warnings (thread-safe)
        while True:
            try:
                msg = self._monitor_warning_queue.get_nowait()
                log = self.query_one("#output", RichLog)
                log.write(f"[yellow]{msg}[/yellow]")
            except queue.Empty:
                break
        # Update status bar in real-time during agent execution
        if self._agent_running:
            self._update_status_bar()

    # ── Streaming Support ──────────────────────────────────────

    def _start_streaming_internal(self) -> None:
        """Show the streaming widget for real-time token display (main thread only)."""
        self._streaming_text = ""
        stream = self.query_one("#streaming", Static)
        stream.add_class("visible")
        stream.update("")

    def _end_streaming_internal(self) -> None:
        """Move streaming content to RichLog and hide streaming widget (main thread only)."""
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
        or plain strings. Safe to call from any thread.
        """
        _output_queue.put(("write", content))

    # ── Banner & Status ─────────────────────────────────────────

    def _show_banner(self) -> None:
        log = self.query_one("#output", RichLog)
        banner = Panel(
            "[bold cyan]Nexgent v0.4.0[/]\n"
            "AI Agent Harness — model agnostic\n"
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
        from .config import MIMO_API_KEY
        table.add_row("Model", self.harness.model)
        table.add_row("API Key", "[green]SET[/green]" if MIMO_API_KEY else "[red]NOT SET[/red]")
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
        # Use cached token estimate if message count hasn't changed
        msgs = len(self.session.messages)
        cached_msgs, cached_tokens = self._token_cache
        if msgs == cached_msgs:
            tokens = cached_tokens
        else:
            tokens = estimate_tokens(self.session.messages)
            self._token_cache = (msgs, tokens)
        token_str = _format_tokens(tokens)
        max_str = _format_tokens(CONTEXT_WINDOW_TOKENS)
        queue_info = ""
        if self._command_queue:
            queue_info = (
                f"  [dim]|[/dim]  [yellow]Queued[/yellow] "
                f"{len(self._command_queue)}"
            )
        # SubAgent resource monitoring
        subagent_info = ""
        try:
            summary = self.harness.get_subagent_summary()
            if summary.get("total_subagents", 0) > 0:
                sa_tokens = _format_tokens(summary.get("total_tokens_used", 0))
                sa_count = summary["total_subagents"]
                sa_running = summary.get("running", 0)
                sa_elapsed = summary.get("elapsed_seconds", 0)
                parts = [f"SA:{sa_count}"]
                if sa_running > 0:
                    parts.append(f"[yellow]run:{sa_running}[/yellow]")
                parts.append(f"tok:{sa_tokens}")
                parts.append(f"{sa_elapsed:.0f}s")
                subagent_info = f"  [dim]|[/dim]  [dim]SubAgents[/dim] {' '.join(parts)}"
        except Exception:
            pass
        status = self.query_one("#status-bar", Static)
        status.update(
            f"  [dim]Session[/dim] {self.session.session_id[:8]}  "
            f"[dim]|[/dim]  [dim]Tokens[/dim] {token_str}/{max_str}  "
            f"[dim]|[/dim]  [dim]Msgs[/dim] {msgs}"
            f"{queue_info}{subagent_info}"
        )

    # ── Input Handling ──────────────────────────────────────────

    def on_key(self, event) -> None:
        """Handle key presses during permission mode (inline, not input box)."""
        if not self._permission_mode or self._permission_event is None:
            return
        key = event.key.lower()
        if key in ("y", "enter"):
            self._permission_result = True
            self._write_permission_response(True)
            self._permission_mode = False
            self._permission_event.set()
            event.stop()
        elif key == "n" or key == "escape":
            self._permission_result = False
            self._write_permission_response(False)
            self._permission_mode = False
            self._permission_event.set()
            event.stop()

    def _write_permission_response(self, approved: bool) -> None:
        """Show the user's Y/n response in the output area."""
        try:
            log = self.query_one("#output", RichLog)
            if approved:
                log.write("  [green bold]Y[/green bold] — Allowed")
            else:
                log.write("  [red bold]n[/red bold] — Denied")
        except Exception:
            # Fallback to queue if direct write fails
            if approved:
                _output_queue.put(("write", "  [green bold]Y[/green bold] — Allowed"))
            else:
                _output_queue.put(("write", "  [red bold]n[/red bold] — Denied"))

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
            # Check for scheduled prompts even when user provides no input
            with self.scheduled_lock:
                scheduled = self.scheduled_prompts.pop(0) if self.scheduled_prompts else None
            if scheduled:
                text = scheduled
                self.write_output("[dim]Executing scheduled prompt...[/dim]")
            else:
                return

        # ── Agent running: /btw injection or command queuing ──
        if self._agent_running:
            self._handle_during_agent(text)
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

        # Resolve @ file references (same as CLI path in cli.py:579-585)
        if not text.startswith("/"):
            from .file_references import FileReferenceResolver
            if FileReferenceResolver.has_references(text):
                resolved = FileReferenceResolver.resolve_and_format(text, os.getcwd())
                if resolved != text:
                    self.write_output("[dim]Resolving @ file references...[/dim]")
                    text = resolved

        if text.startswith("/"):
            self._handle_command(text)
        else:
            self._run_agent(text)

        self._update_status_bar()

    @staticmethod
    def _parse_btw(text: str) -> str | None:
        """Parse /btw command and return the message content.

        Returns the stripped message if text is a valid /btw command,
        None if it's not a /btw command, or "" if /btw has no content.
        """
        if text == _BTW_CMD:
            return ""  # /btw with no message
        if text.startswith(_BTW_CMD + " "):
            return text[len(_BTW_CMD):].strip()
        return None  # not a /btw command

    def _handle_during_agent(self, text: str) -> None:
        """Handle input submitted while agent is running.

        /btw <msg> — inject a user message into the running agent's context.
        Anything else — queue for execution after agent finishes.
        """
        # /btw: inject guidance into the running agent's context
        btw_msg = self._parse_btw(text)
        if btw_msg is not None:
            if not btw_msg:
                self.write_output("[yellow]Usage: /btw <your guidance message>[/yellow]")
                return
            # Thread-safe: Session.add_message uses a lock
            self.session.add_message("user", btw_msg)
            self.write_output(
                Panel(
                    btw_msg,
                    title="[green]> /btw (injected)[/green]",
                    border_style="green",
                    width=72,
                    padding=(0, 1),
                )
            )
            self._update_status_bar()
            return

        # Any other input: queue for later execution
        if len(self._command_queue) >= _MAX_QUEUE_SIZE:
            self.write_output(
                f"[yellow]Queue full ({_MAX_QUEUE_SIZE} items). Wait for agent to finish.[/yellow]"
            )
            return
        self._command_queue.append(text)
        queue_pos = len(self._command_queue)
        self.write_output(
            Panel(
                text,
                title=f"[yellow]> Queued #{queue_pos}[/yellow]",
                border_style="yellow",
                width=72,
                padding=(0, 1),
            )
        )
        self._update_status_bar()

    # ── Commands ────────────────────────────────────────────────

    def _handle_command(self, text: str) -> None:
        # /btw when agent is idle: add message to session context for next turn
        btw_msg = self._parse_btw(text)
        if btw_msg is not None:
            if btw_msg:
                self.session.add_message("user", btw_msg)
                self.write_output(
                    Panel(
                        btw_msg,
                        title="[green]> /btw (context)[/green]",
                        border_style="green",
                        width=72,
                        padding=(0, 1),
                    )
                )
            else:
                self.write_output("[yellow]Usage: /btw <message to add to context>[/yellow]")
            return

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
        except SystemExit as e:
            # In TUI mode, catch SystemExit from slash commands (e.g., /quit)
            # and handle gracefully. The actual exit is done by _save_and_exit().
            action = "continue" if e.code is None else "quit"

        output = buf.getvalue()
        if output.strip():
            self.write_output(output.rstrip())

        if action == "quit":
            self._save_and_exit()

    # ── Agent Execution ─────────────────────────────────────────

    def _format_tool_args(self, tool_name: str, args: dict) -> str:
        """Format tool arguments for TUI display (matches display.py logic)."""
        if not args:
            return ""
        if tool_name in ("read_file", "write_file", "edit_file"):
            path = args.get("path") or args.get("file_path", "")
            if path:
                return f" → {path}"
        if tool_name == "run_command":
            cmd = args.get("command", "")
            if cmd:
                return f" → ${cmd}" if len(cmd) <= 60 else f" → ${cmd[:57]}..."
        if tool_name == "search_files":
            pattern = args.get("pattern", "")
            if pattern:
                return f" → {pattern}"
        if tool_name == "list_directory":
            return f" → {args.get('path', '.')}"
        import json
        preview = json.dumps(args, ensure_ascii=False)
        if len(preview) > 80:
            preview = preview[:77] + "..."
        return f" → {preview}"

    def _run_agent(self, task: str) -> None:
        self._agent_running = True
        # Increment generation so stale "done" from killed threads are discarded
        self._agent_generation += 1
        current_gen = self._agent_generation
        # Drain any stale warnings from previous runs
        while not self._monitor_warning_queue.empty():
            try:
                self._monitor_warning_queue.get_nowait()
            except queue.Empty:
                break
        # Wire up ResourceMonitor warnings → TUI output (thread-safe queue)
        try:
            monitor = self.harness.subagent_manager.resource_monitor
            monitor.on_warning = lambda msg: self._monitor_warning_queue.put(msg)
        except Exception as exc:
            logging.debug("Could not wire ResourceMonitor callback: %s", exc)
        # Keep input enabled for /btw injection and command queuing
        self._set_input_placeholder(
            "Agent running — /btw to guide, or type to queue..."
        )

        # Start streaming via queue
        _output_queue.put(("start_stream", None))

        import nexgent.display as _display_mod
        import io

        # Save originals for restore
        orig_stdout = sys.stdout
        orig_stderr = sys.stderr
        orig_console_file = _display_mod._console.file

        # Install TUI override callbacks in display.py.
        # These are checked INSIDE each display function, so they work even
        # when agent.py holds direct references via `from .display import ...`
        _display_mod._tui_stream_token = lambda token: _output_queue.put(("stream", token))
        _display_mod._tui_stream_end = lambda: None  # no-op; _on_agent_done flushes
        _display_mod._tui_print = lambda *a, **kw: _output_queue.put(
            ("write", kw.get('sep', ' ').join(str(x) for x in a).rstrip('\n'))
        ) if a else None
        _display_mod._tui_model_output_start = lambda model: _output_queue.put(
            ("write", f"╭── {model} ──") if model else ("write", "╭── Assistant ──")
        )
        _display_mod._tui_model_output_end = lambda: _output_queue.put(("write", "╰──────"))
        def tui_tool_call_collapsible(name, args, call_index=0, total=1,
                                      collapsed=True, result_preview=None,
                                      success=None, duration=None):
            prefix = f"  ⚡ [{call_index + 1}/{total}]" if total > 1 else "  ⚡"
            _output_queue.put(("write", f"{prefix} {name}{self._format_tool_args(name, args)}"))
        _display_mod._tui_tool_call_collapsible = tui_tool_call_collapsible

        def tui_tool_call_result(name, success, duration, result_preview=None, error=None):
            icon = '✓' if success else '✗'
            _output_queue.put(("write", f"  {icon} {name} ({duration:.1f}s)"))
            if error:
                _output_queue.put(("write", f"    [red]{error[:200]}[/red]"))
            elif result_preview:
                _output_queue.put(("write", f"    [dim]{result_preview[:200]}[/dim]"))
        _display_mod._tui_tool_call_result = tui_tool_call_result

        # Suppress _console.print — it writes directly to its file object
        # (the original stdout fd), bypassing sys.stdout and all overrides.
        # Our override callbacks handle all output through the queue instead.
        _display_mod._console.file = io.StringIO()

        # Monkey-patch permission input to route through TUI
        import nexgent.permissions as _perm_mod
        orig_perm_request = _perm_mod._tui_permission_request
        _perm_mod._tui_permission_request = self._queue_permission_request

        self.run_worker(
            self._agent_worker(task, _display_mod,
                               _perm_mod, orig_perm_request,
                               orig_stdout, orig_stderr,
                               orig_console_file, current_gen),
            exclusive=True,
            thread=True,
        )

    def _agent_worker(self, task, display_mod,
                      perm_mod=None, orig_perm_request=None,
                      orig_stdout=None, orig_stderr=None,
                      orig_console_file=None, agent_gen=0):
        def worker():
            # Save thread reference for force-kill
            self._worker_thread = threading.current_thread()

            # Redirect sys.stdout/stderr as safety net
            class _StdoutProxy:
                """Redirect sys.stdout to the output queue."""
                def write(self, text):
                    if text:
                        _output_queue.put(("write", text.rstrip('\n')))
                def flush(self):
                    pass
                def isatty(self):
                    return False
                def fileno(self):
                    raise OSError("stdout is redirected in TUI mode")
                @property
                def buffer(self):
                    raise AttributeError("stdout buffer not available in TUI mode")
                @property
                def encoding(self):
                    return 'utf-8'
                @property
                def name(self):
                    return '<tui_proxy>'

            proxy = _StdoutProxy()
            sys.stdout = proxy
            sys.stderr = proxy

            # Replace builtins.print to route ALL print() calls to the TUI queue.
            # This is the most reliable interception point — it catches print()
            # from agent.py, permissions.py, display.py, and any other module,
            # regardless of how they import or reference print().
            import builtins
            orig_builtins_print = builtins.print
            self._orig_builtins_print = orig_builtins_print  # for force_kill cleanup

            def tui_print(*args, **kwargs):
                """Replacement for builtins.print — routes to TUI queue."""
                sep = kwargs.get('sep', ' ')
                end = kwargs.get('end', '\n')
                text = sep.join(str(a) for a in args)
                if not text and end == '\n':
                    return
                full = text + end
                # Streaming tokens use end="" — buffer in streaming widget
                if end == '':
                    _output_queue.put(("stream", full))
                else:
                    _output_queue.put(("write", full.rstrip('\n')))

            builtins.print = tui_print

            try:
                # harness.run() outputs through builtins.print (routed to queue)
                # and display.py override callbacks. Do NOT write result again here.
                self.harness.run(task, self.session)
            except Exception as e:
                _output_queue.put(("end_stream", None))
                _output_queue.put(("write", f"[red]Error: {e}[/red]"))
            finally:
                # Only clear callbacks if this is still the current agent generation.
                # A force-killed thread's finally block may run after a new agent
                # has already started and set its own callbacks.
                if agent_gen == self._agent_generation:
                    # Restore builtins.print
                    builtins.print = orig_builtins_print
                    # Restore stdout/stderr
                    sys.stdout = orig_stdout or sys.__stdout__
                    sys.stderr = orig_stderr or sys.__stderr__
                    # Restore _console.file (was set to StringIO to suppress direct writes)
                    display_mod._console.file = orig_console_file or sys.__stdout__
                    # Clear ALL display override callbacks
                    display_mod._tui_stream_token = None
                    display_mod._tui_stream_end = None
                    display_mod._tui_print = None
                    display_mod._tui_model_output_start = None
                    display_mod._tui_model_output_end = None
                    display_mod._tui_tool_call_collapsible = None
                    display_mod._tui_tool_call_result = None
                    # Restore permission callback
                    if perm_mod is not None:
                        perm_mod._tui_permission_request = orig_perm_request
                    self._worker_thread = None
                _output_queue.put(("done", agent_gen))
        return worker

    def _on_agent_done(self, generation: int = 0) -> None:
        """Called on main thread when agent finishes.

        Args:
            generation: The agent generation ID from the "done" signal.
                If it doesn't match the current generation, the signal is
                stale (from a force-killed thread) and is silently discarded.
        """
        # Discard stale "done" signals from force-killed threads
        if generation and generation != self._agent_generation:
            return
        self._end_streaming_internal()
        self._agent_running = False
        self._permission_mode = False
        # Re-enable input without resetting placeholder yet — drain may
        # start a new agent which sets its own running placeholder.
        try:
            inp = self.query_one("#input-area", Input)
            inp.disabled = False
            inp.focus()
        except Exception as exc:
            logging.debug("Failed to re-enable input: %s", exc)

        # Drain command queue: process slash commands until we find one
        # that starts an agent (non-slash), or the queue is empty.
        # Slash commands like /clear, /help don't start agents, so we
        # must keep draining until a runnable command is found.
        try:
            while self._command_queue and not self._exiting:
                next_cmd = self._command_queue.pop(0)
                remaining = len(self._command_queue)
                suffix = f" ({remaining} remaining in queue)" if remaining else ""
                self.write_output(
                    f"[dim]Executing queued command{suffix}: {next_cmd}[/dim]"
                )
                try:
                    if next_cmd.startswith("/"):
                        self._handle_command(next_cmd)
                    else:
                        self._run_agent(next_cmd)
                        break
                except Exception as e:
                    self.write_output(
                        f"[red]Error executing queued command: {e}[/red]"
                    )
                    # Non-slash command failed — stop drain, preserve remaining
                    # so user can fix the issue and retry.
                    if not next_cmd.startswith("/"):
                        break
                    # Slash command error — continue draining
        except Exception as e:
            # Catch-all: prevent drain timer from dying
            self.write_output(f"[red]Queue drain error: {e}[/red]")

        # Restore default placeholder only if no new agent was started
        if not self._agent_running:
            self._set_input_placeholder(self._default_placeholder)
        # Update after queue drain so status bar reflects final state
        self._update_status_bar()

    def _cleanup_interrupted_session(self) -> None:
        """Remove incomplete messages after force-kill.

        Removes trailing assistant messages with tool_calls that have no
        corresponding tool responses. This prevents the model from continuing
        the old interrupted task when a new user message arrives.
        """
        messages = self.session.messages
        # Collect tool_call_ids from assistant messages
        # Remove trailing assistant messages with orphaned tool_calls
        while messages:
            last = messages[-1]
            if last.get("role") == "assistant" and last.get("tool_calls"):
                # Has tool_calls — check if tool responses exist
                tc_ids = {tc["id"] for tc in last["tool_calls"]}
                response_ids = {
                    m.get("tool_call_id") for m in messages if m.get("role") == "tool"
                }
                if tc_ids - response_ids:
                    # Orphaned tool_calls — remove this message
                    messages.pop()
                    continue
            break
        # Save cleaned session
        try:
            self.session.save_meta_to_jsonl()
        except OSError:
            pass

    # ── Permission Request (queue-based, non-blocking) ──────────

    def _queue_permission_request(self, action_desc: str, permission_value: str) -> bool:
        """Show permission prompt via queue and wait for user Y/n input.

        Called from the agent worker thread. Puts prompt in queue (non-blocking),
        then blocks on Event until user responds in the TUI.
        """
        self._permission_event = Event()
        self._permission_result = None
        self._permission_mode = True

        # Show prompt and enable input via queue (non-blocking)
        _output_queue.put(("permission", (action_desc, permission_value)))

        # Block until user responds
        self._permission_event.wait()

        self._permission_mode = False
        return self._permission_result

    def _show_permission_prompt(self, action_desc: str, permission_value: str) -> None:
        """Display inline permission prompt in the output log (main thread only).

        Claude Code style: shows the tool call info and Y/n options inline
        in the output area. User presses Y or n directly (no input box).
        """
        prompt_text = Text()
        prompt_text.append(f"  {action_desc}\n", style="dim")
        prompt_text.append("  Allow? ", style="bold")
        prompt_text.append("Y", style="bold black on green")
        prompt_text.append(" / ", style="dim")
        prompt_text.append("n", style="bold black on red")
        prompt_text.append("  (press key)", style="dim")
        self.write_output(prompt_text)

    def _set_input_placeholder(self, text: str) -> None:
        """Update the input box placeholder text."""
        try:
            inp = self.query_one("#input-area", Input)
            inp.placeholder = text
        except Exception as exc:
            logging.debug("Failed to set input placeholder: %s", exc)

    def _disable_input(self) -> None:
        inp = self.query_one("#input-area", Input)
        inp.disabled = True

    def _enable_input(self) -> None:
        inp = self.query_one("#input-area", Input)
        inp.disabled = False
        inp.placeholder = self._default_placeholder
        inp.focus()

    # ── Actions ─────────────────────────────────────────────────

    def action_interrupt(self) -> None:
        """ESC: Interrupt current task or clear input.

        Behavior (matching Claude Code):
        - If agent is running: request graceful abort
        - If input has text: clear input draft and save to history
        - If input is empty: quit
        """
        if self._agent_running:
            # Agent is running - interrupt it
            self.harness.graceful_abort.request()
            # Clear any queued commands
            if self._command_queue:
                n = len(self._command_queue)
                self._command_queue.clear()
                self.write_output(
                    f"[yellow]Interrupted - cleared {n} queued command(s)[/yellow]"
                )
            else:
                self.write_output("[yellow]Interrupted - stopping current task...[/yellow]")
        else:
            # Agent is not running
            try:
                input_widget = self.query_one("#input-area", Input)
                if input_widget.value:
                    # Clear input draft and save to history
                    draft = input_widget.value
                    if draft not in self._history:
                        self._history.append(draft)
                    input_widget.value = ""
                    self.write_output("[dim]Input cleared (saved to history)[/dim]")
                # If input is empty, ESC is a no-op (don't quit)
            except Exception:
                # Fallback: ignore if input widget not found
                pass

    def action_abort(self) -> None:
        if self._agent_running:
            self.harness.graceful_abort.request()
            self.write_output("[yellow]Abort requested - stopping current task...[/yellow]")
        else:
            self._save_and_exit()

    def action_force_kill(self) -> None:
        """Ctrl+K: Force-kill the stuck agent thread.

        This is the nuclear option — kills the thread immediately,
        restores display state, and re-enables input.
        Only use when Ctrl+C (graceful abort) doesn't respond.
        """
        if not self._agent_running:
            return
        thread = self._worker_thread
        if thread and thread.is_alive():
            import ctypes
            self.write_output("[red bold]Force-killing agent thread...[/red bold]")
            try:
                ctypes.pythonapi.PyThreadState_SetAsyncExc(
                    ctypes.c_ulong(thread.ident),
                    ctypes.py_object(SystemExit),
                )
            except Exception:
                pass
        # Force-restore state even if thread doesn't die cleanly
        # Clear the output queue to avoid stale items
        self._command_queue.clear()
        while not _output_queue.empty():
            try:
                _output_queue.get_nowait()
            except queue.Empty:
                break
        # Clean up incomplete messages from session to prevent old task continuation
        self._cleanup_interrupted_session()
        self._on_agent_done()
        # Restore display override callbacks
        import builtins
        import nexgent.display as _display_mod
        import nexgent.permissions as _perm_mod
        if hasattr(self, '_orig_builtins_print'):
            builtins.print = self._orig_builtins_print
        _display_mod._tui_write = None
        _display_mod._tui_stream_token = None
        _display_mod._tui_stream_end = None
        _display_mod._tui_print = None
        _display_mod._tui_model_output_start = None
        _display_mod._tui_model_output_end = None
        _display_mod._tui_tool_call_collapsible = None
        _display_mod._tui_tool_call_result = None
        _display_mod._console.file = sys.__stdout__
        _perm_mod._tui_permission_request = None
        self.write_output("[yellow]Agent killed. Input re-enabled.[/yellow]")

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
        """Cycle through matching slash commands or @file references."""
        inp = self.query_one("#input-area", Input)
        value = inp.value

        if self._tab_matches and self._tab_prefix == value:
            # Cycle to next match
            self._tab_idx = (self._tab_idx + 1) % len(self._tab_matches)
            inp.value = self._tab_matches[self._tab_idx]
            inp.cursor_position = len(inp.value)
            return

        # Detect @ file reference trigger
        at_pos = value.rfind('@')
        if at_pos >= 0 and (at_pos == 0 or value[at_pos - 1] == ' '):
            prefix = value[at_pos + 1:]
            if ' ' not in prefix:
                from .file_references import scan_completions
                # Strip line number suffix
                search_prefix = prefix
                line_suffix = ''
                if ':' in prefix:
                    parts = prefix.rsplit(':', 1)
                    if parts[1].isdigit():
                        search_prefix = parts[0]
                        line_suffix = ':' + parts[1]
                matches = scan_completions(search_prefix, os.getcwd(), limit=15)
                if not matches:
                    return
                # Build full input values with each match
                base = value[:at_pos + 1]
                full_matches = [base + m + line_suffix for m in matches]

                if len(full_matches) == 1:
                    inp.value = full_matches[0] + " "
                    inp.cursor_position = len(inp.value)
                    self._tab_matches = []
                    self._tab_idx = -1
                else:
                    self._tab_matches = full_matches
                    self._tab_prefix = value
                    self._tab_idx = 0
                    inp.value = full_matches[0]
                    inp.cursor_position = len(inp.value)
                    self.write_output("  [dim]" + "  ".join(matches) + "[/dim]")
                return

        # Find slash command matches
        if not value.startswith("/"):
            return
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
        self._exiting = True
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
