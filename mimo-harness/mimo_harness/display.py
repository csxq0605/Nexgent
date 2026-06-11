"""Structured CLI display module for MiMo Harness.

Provides rich, structured output similar to Claude Code:
- Conversation bubbles (user vs model visual distinction)
- Step indicators
- Tool call visualization (structured, collapsible)
- Code block syntax highlighting
- Status bar with current state
- Streaming output formatting
- Status indicators
- Thinking/reasoning display

Uses `rich` library for professional terminal output with automatic
Unicode/ASCII fallback and cross-platform compatibility.
"""

import os
import sys
import time
import json
import re
import threading
from typing import Optional
from dataclasses import dataclass, field

# Rich imports — the core rendering engine
from rich.console import Console
from rich.text import Text
from rich.panel import Panel
from rich.table import Table
from rich.syntax import Syntax
from rich.markdown import Markdown
from rich.table import Table
from rich import box

# Optional syntax highlighting (graceful fallback if pygments not installed)
try:
    from pygments import highlight as _pygments_highlight
    from pygments.lexers import get_lexer_by_name, TextLexer
    from pygments.formatters import TerminalFormatter
    _HAS_PYGMENTS = True
except ImportError:
    _HAS_PYGMENTS = False


def _console_supports_unicode() -> bool:
    """Check if the console encoding supports Unicode characters.

    On Windows with GBK/cp936 encoding, many Unicode symbols (emoji, box-drawing)
    cause UnicodeEncodeError. This detects that and enables ASCII fallbacks.
    """
    try:
        encoding = sys.stdout.encoding or "utf-8"
        # Test a representative Unicode character
        "💭".encode(encoding)
        return True
    except (UnicodeEncodeError, LookupError):
        return False


# Detect Unicode support at module load time
_SUPPORTS_UNICODE = _console_supports_unicode()


# Unicode / ASCII fallback characters
if _SUPPORTS_UNICODE:
    THINK_ICON = "💭"
    TOOL_ICON = "⚡"
    CHECK_ICON = "✓"
    CROSS_ICON = "✗"
    WARN_ICON = "⚠"
    INFO_ICON = "ℹ"
    DOT_ICON = "•"
    ARROW_ICON = "→"
    SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    BOX_TL = "╭"
    BOX_TR = "╮"
    BOX_BL = "╰"
    BOX_BR = "╯"
    BOX_H = "─"
    BOX_V = "│"
    BAR_FILL = "█"
    BAR_EMPTY = "░"
    STEP_H = "━"
else:
    THINK_ICON = "*"
    TOOL_ICON = ">"
    CHECK_ICON = "[ok]"
    CROSS_ICON = "[x]"
    WARN_ICON = "[!]"
    INFO_ICON = "[i]"
    DOT_ICON = "-"
    ARROW_ICON = "->"
    SPINNER_FRAMES = ["|", "/", "-", "\\"]
    BOX_TL = "+"
    BOX_TR = "+"
    BOX_BL = "+"
    BOX_BR = "+"
    BOX_H = "-"
    BOX_V = "|"
    BAR_FILL = "#"
    BAR_EMPTY = "."
    STEP_H = "-"


def _get_terminal_width(default: int = 80) -> int:
    """Get terminal width, capped at 80 for consistent display."""
    try:
        return min(os.get_terminal_size().columns, 80)
    except (OSError, ValueError):
        return default


# Rich console — the single source of truth for all output
# force_terminal=True ensures colors even when stdout is piped (for testing)
# Width capped at 80 for consistent display across terminal sizes
_console = Console(highlight=False, force_terminal=True, width=_get_terminal_width())

# TUI output callbacks — set by tui.py when full-screen mode is active.
# When set, output functions route through these instead of to the console.
# This is necessary because agent.py uses direct imports (from .display import
# print_streaming_token) which create local references that bypass module-level
# attribute patching. These callbacks are checked INSIDE each function, so
# they work regardless of how the function was imported.
_tui_write = None  # Callable[[str], None] or None
_tui_stream_token = None  # Callable[[str], None] or None
_tui_stream_end = None  # Callable[[], None] or None
_tui_model_output_start = None  # Callable[[str], None] or None
_tui_model_output_end = None  # Callable[[], None] or None
_tui_tool_call_collapsible = None  # Callable[..., None] or None
_tui_tool_call_result = None  # Callable[..., None] or None
_tui_print = None  # Callable[..., None] or None


def _safe_print(*args, **kwargs):
    """Print with rich Console, falling back to print() on error.

    This is the primary output function. All display functions should use this.
    When TUI mode is active, output is routed to the TUI's RichLog.
    """
    # Route to TUI if active
    if _tui_write is not None:
        sep = kwargs.get('sep', ' ')
        end = kwargs.get('end', '\n')
        text = sep.join(str(a) for a in args)
        try:
            _tui_write(text + end)
        except Exception:
            pass
        return

    try:
        # Convert string args to rich Text to avoid markup interpretation
        text_args = []
        for a in args:
            if isinstance(a, str):
                text_args.append(a)
            else:
                text_args.append(a)
        _console.print(*text_args, **kwargs, highlight=False, soft_wrap=True)
    except Exception:
        # Ultimate fallback
        try:
            print(*args, **kwargs)
        except UnicodeEncodeError:
            safe_args = []
            for a in args:
                s = str(a)
                try:
                    s.encode(sys.stdout.encoding or "ascii")
                    safe_args.append(s)
                except (UnicodeEncodeError, LookupError):
                    safe_args.append(s.encode("ascii", errors="replace").decode("ascii"))
            print(*safe_args, **kwargs)


# ANSI color codes — kept for backward compatibility with code that imports them
class Colors:
    """ANSI escape codes for terminal colors. Kept for backward compat."""
    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    ITALIC = "\033[3m"

    BLACK = "\033[30m"
    RED = "\033[31m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    BLUE = "\033[34m"
    MAGENTA = "\033[35m"
    CYAN = "\033[36m"
    WHITE = "\033[37m"

    BRIGHT_RED = "\033[91m"
    BRIGHT_GREEN = "\033[92m"
    BRIGHT_YELLOW = "\033[93m"
    BRIGHT_BLUE = "\033[94m"
    BRIGHT_MAGENTA = "\033[95m"
    BRIGHT_CYAN = "\033[96m"

    BG_RED = "\033[41m"
    BG_GREEN = "\033[42m"
    BG_YELLOW = "\033[43m"
    BG_BLUE = "\033[44m"


def _supports_color() -> bool:
    """Check if terminal supports ANSI colors."""
    if os.environ.get("NO_COLOR"):
        return False
    if os.environ.get("TERM") == "dumb":
        return False
    return hasattr(sys.stdout, 'isatty') and sys.stdout.isatty()


# Global flag - will be set by CLI
USE_COLOR = _supports_color()


def _c(color: str, text: str) -> str:
    """Apply color to text if color is supported."""
    if not USE_COLOR:
        return text
    return f"{color}{text}{Colors.RESET}"


def _dim(text: str) -> str:
    return _c(Colors.DIM, text)


def _bold(text: str) -> str:
    return _c(Colors.BOLD, text)


def _green(text: str) -> str:
    return _c(Colors.GREEN, text)


def _yellow(text: str) -> str:
    return _c(Colors.YELLOW, text)


def _red(text: str) -> str:
    return _c(Colors.RED, text)


def _cyan(text: str) -> str:
    return _c(Colors.CYAN, text)


def _blue(text: str) -> str:
    return _c(Colors.BLUE, text)


# Spinner frames — defined above based on Unicode support


class Spinner:
    """Animated spinner using rich.status.Status."""

    def __init__(self, message: str = "Thinking"):
        self.message = message
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._frame = 0
        self._start_time = 0.0
        self._status = None

    def start(self):
        """Start the spinner animation."""
        if not USE_COLOR:
            print(f"  {self.message}...", flush=True)
            return

        self._stop_event.clear()
        self._start_time = time.time()
        self._thread = threading.Thread(target=self._animate, daemon=True)
        self._thread.start()

    def stop(self, final_message: Optional[str] = None):
        """Stop the spinner and optionally print a final message."""
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=0.2)

        if USE_COLOR:
            sys.stdout.write("\r\033[K")
            sys.stdout.flush()

        if final_message:
            print(final_message, flush=True)

    def update_message(self, message: str):
        """Update the spinner message."""
        self.message = message

    def _animate(self):
        """Run the spinner animation in a background thread."""
        while not self._stop_event.is_set():
            frame = SPINNER_FRAMES[self._frame % len(SPINNER_FRAMES)]
            elapsed = time.time() - self._start_time
            _safe_print(f"  [cyan]{frame}[/cyan] {self.message} [dim]({elapsed:.1f}s)[/dim]", end="\r", highlight=False)
            self._frame += 1
            self._stop_event.wait(0.08)


@dataclass
class StepInfo:
    """Information about an agent step."""
    current: int
    max_steps: int
    model: str = ""
    effort: str = "medium"


def print_banner(version: str = "0.3.0"):
    """Print the application banner with rich Panel."""
    content = (
        f"[bold]MiMo Harness[/bold] [dim]v{version}[/dim]\n"
        f"[dim]AI Agent powered by Xiaomi MiMo model[/dim]\n"
        f"[dim]Claude Code architecture patterns[/dim]"
    )
    panel = Panel(
        content,
        border_style="cyan",
        width=52,
        padding=(0, 1),
    )
    _console.print(panel)


def print_session_info(model: str, mode: str, api_key_set: bool):
    """Print session configuration info."""
    _console.print()
    _console.print(f"  [dim]Model:[/dim]    {model}")
    _console.print(f"  [dim]API Key:[/dim]  {'*' * 12 if api_key_set else '[red]NOT SET[/red]'}")
    _console.print(f"  [dim]Mode:[/dim]     {mode}")
    _console.print()


def print_step_header(step_info: StepInfo):
    """Print a minimal step indicator (no step counter — Claude Code style)."""
    pass


def print_thinking_indicator():
    """Print a thinking indicator before model response."""
    if _tui_print is not None:
        _tui_print(f"  {THINK_ICON} Thinking...")
        return
    _console.print(f"  [dim]{THINK_ICON} Thinking...[/dim]", highlight=False)


def print_tool_call_start(tool_name: str, args: dict, call_index: int = 0, total: int = 1):
    """Print tool call start information."""
    args_str = _format_tool_args(tool_name, args)

    if total > 1:
        prefix = f"  [yellow]{TOOL_ICON}[/yellow] [{call_index + 1}/{total}]"
    else:
        prefix = f"  [yellow]{TOOL_ICON}[/yellow]"

    _console.print(f"{prefix} [bold]{tool_name}[/bold]{args_str}", highlight=False)


def print_tool_call_result(
    tool_name: str,
    success: bool,
    duration: float,
    result_preview: Optional[str] = None,
    error: Optional[str] = None,
):
    """Print tool call result."""
    if _tui_tool_call_result is not None:
        _tui_tool_call_result(tool_name, success, duration, result_preview, error)
        return
    if success:
        status = f"[green]{CHECK_ICON}[/green]"
        time_str = f"[dim]({duration:.1f}s)[/dim]"
        _console.print(f"  {status} {tool_name} {time_str}", highlight=False)

        if result_preview:
            preview = result_preview[:200].replace("\n", " ")
            if len(result_preview) > 200:
                preview += "..."
            _console.print(f"    [dim]{preview}[/dim]", highlight=False)
    else:
        status = f"[red]{CROSS_ICON}[/red]"
        time_str = f"[dim]({duration:.1f}s)[/dim]"
        _console.print(f"  {status} {tool_name} {time_str}", highlight=False)
        if error:
            error_preview = error[:200].replace("\n", " ")
            _console.print(f"    [red]{error_preview}[/red]", highlight=False)


def print_streaming_token(token: str):
    """Print a single streaming token (called from streaming callback)."""
    if _tui_stream_token is not None:
        _tui_stream_token(token)
        return
    _console.print(token, end="", highlight=False)


def print_streaming_end():
    """Print newline after streaming completes."""
    if _tui_stream_end is not None:
        _tui_stream_end()
        return
    _console.print()


def print_error(message: str):
    """Print an error message."""
    if _tui_print is not None:
        _tui_print(f"\n  {CROSS_ICON} {message}\n")
        return
    _console.print(f"\n  [red]{CROSS_ICON}[/red] [red]{message}[/red]\n", highlight=False)


def print_warning(message: str):
    """Print a warning message."""
    if _tui_print is not None:
        _tui_print(f"  {WARN_ICON} {message}")
        return
    _console.print(f"  [yellow]{WARN_ICON}[/yellow] {message}", highlight=False)


def print_info(message: str):
    """Print an info message."""
    if _tui_print is not None:
        _tui_print(f"  {INFO_ICON} {message}")
        return
    _console.print(f"  [dim]{INFO_ICON}[/dim] {message}", highlight=False)


def print_success(message: str):
    """Print a success message."""
    _console.print(f"  [green]{CHECK_ICON}[/green] {message}", highlight=False)


def print_token_usage(current: int, max_tokens: int):
    """Print token usage with a progress bar."""
    pct = current / max_tokens if max_tokens > 0 else 0
    bar_len = 30
    filled = int(bar_len * pct)

    if pct >= 0.95:
        bar_color = "red"
        status = "BLOCKED"
    elif pct >= 0.85:
        bar_color = "yellow"
        status = "WARNING"
    else:
        bar_color = "green"
        status = "OK"

    bar = BAR_FILL * min(filled, bar_len) + BAR_EMPTY * max(0, bar_len - filled)
    current_str = _format_tokens(current)
    max_str = _format_tokens(max_tokens)

    _console.print(f"\n  [dim]Tokens:[/dim] [{bar_color}]{bar}[/{bar_color}] {current_str}/{max_str} [dim]{status}[/dim]", highlight=False)


def print_tool_list(tools: list):
    """Print available tools in a structured table."""
    table = Table(title="Available Tools", box=box.SIMPLE, show_header=True, header_style="bold")
    table.add_column("Tool", style="yellow", no_wrap=True)
    table.add_column("Markers", style="dim", width=10)
    table.add_column("Description", style="dim", max_width=50)

    for tool in tools:
        markers = []
        if tool.get("is_read_only"):
            markers.append("[dim]RO[/dim]")
        if tool.get("is_concurrency_safe"):
            markers.append("[dim]CS[/dim]")
        if tool.get("is_destructive"):
            markers.append("[red]DST[/red]")
        marker_str = " ".join(markers)
        desc = (tool.get("description") or "")[:60]
        table.add_row(tool["name"], marker_str, desc)

    _console.print()
    _console.print(table)
    _console.print()


def print_context_breakdown(messages: list, max_display: int = 15):
    """Print context breakdown in a structured table."""
    table = Table(
        title=f"Context Breakdown ({len(messages)} messages)",
        box=box.SIMPLE,
        show_header=True,
        header_style="bold",
    )
    table.add_column("#", style="dim", width=4)
    table.add_column("Role", style="cyan", width=12)
    table.add_column("Tokens", justify="right", width=8)
    table.add_column("Content preview", style="dim", max_width=45)

    for i, msg in enumerate(messages[:max_display]):
        role = msg.get("role", "?")
        content = msg.get("content", "")
        if not isinstance(content, str):
            content = str(content) if content else ""
        tokens = max(1, len(content) // 4)
        preview = content[:50].replace("\n", " ")
        table.add_row(str(i), role, _format_tokens(tokens), preview)

    if len(messages) > max_display:
        table.add_row("", "", "", f"[dim]... and {len(messages) - max_display} more messages[/dim]")

    _console.print()
    _console.print(table)
    _console.print()


def print_session_stats(stats: dict):
    """Print session statistics."""
    table = Table(title="Session Statistics", box=box.SIMPLE, show_header=False)
    table.add_column("Key", style="dim")
    table.add_column("Value")
    for key, value in stats.items():
        table.add_row(key, str(value))
    _console.print()
    _console.print(table)
    _console.print()


def _format_tool_args(tool_name: str, args: dict) -> str:
    """Format tool arguments for display."""
    if not args:
        return ""

    if tool_name in ("read_file", "write_file", "edit_file"):
        path = args.get("path") or args.get("file_path", "")
        if path:
            return f" [dim]{ARROW_ICON}[/dim] [cyan]{path}[/cyan]"

    if tool_name == "run_command":
        cmd = args.get("command", "")
        if cmd:
            if len(cmd) > 60:
                cmd = cmd[:57] + "..."
            return f" [dim]{ARROW_ICON}[/dim] [dim]$[/dim] {cmd}"

    if tool_name == "search_files":
        pattern = args.get("pattern", "")
        if pattern:
            return f" [dim]{ARROW_ICON}[/dim] [cyan]{pattern}[/cyan]"

    if tool_name == "list_directory":
        path = args.get("path", ".")
        return f" [dim]{ARROW_ICON}[/dim] [cyan]{path}[/cyan]"

    args_preview = json.dumps(args, ensure_ascii=False)
    if len(args_preview) > 80:
        args_preview = args_preview[:77] + "..."
    return f" [dim]{ARROW_ICON}[/dim] [dim]{args_preview}[/dim]"


def _format_tokens(tokens: int) -> str:
    """Format token count for display."""
    if tokens >= 1000:
        return f"{tokens / 1000:.1f}K"
    return str(tokens)


def print_help():
    """Print help in a structured table."""
    commands = [
        ("/help", "Show this help"),
        ("/quit, /exit", "Exit"),
        ("/clear", "Clear conversation history"),
        ("/save <path>", "Save session to file"),
        ("/load <path>", "Load session from file"),
        ("/tools", "List available tools"),
        ("/effort <level>", "Set effort: low/medium/high"),
        ("/mode <mode>", "Set mode: default/plan"),
        ("/dry-run", "Toggle dry-run mode"),
        ("/auto", "Toggle auto-approve mode"),
        ("/plan", "Toggle plan mode (read-only)"),
        ("/abort", "Stop current task"),
        ("/memory", "List stored memories"),
        ("/remember", "Save current context as memory"),
        ("/hooks", "List registered hooks"),
        ("/stats", "Show session statistics"),
        ("/tokens", "Show current token usage"),
        ("/compact", "Manually compress context"),
        ("/context", "Show per-message token breakdown"),
        ("/init", "Scan project and generate AGENTS.md"),
        ("/rewind", "Restore files from last checkpoint"),
        ("/fork", "Fork session into a new session"),
        ("/subagents", "List active SubAgents"),
        ("/subagent <task>", "Run task as SubAgent"),
        ("/parallel <t1> | <t2>", "Run tasks in parallel"),
        ("/pipeline <t1> | <t2>", "Run tasks in pipeline"),
        ("/agents", "List available agents"),
        ("/agents create <name>", "Create new agent"),
        ("/agents show <name>", "Show agent details"),
        ("/agents delete <name>", "Delete agent"),
        ("/tasks", "List background tasks"),
        ("/tasks show <id>", "Show task details"),
        ("/tasks cancel <id>", "Cancel background task"),
        ("/goal", "Show current goal"),
        ("/goal <condition>", "Set goal condition"),
        ("/goal clear", "Clear current goal"),
        ("/skills", "List available skills"),
        ("/skills install <url>", "Install skill from GitHub"),
        ("/<skill-name>", "Invoke a skill"),
        ("/mcp", "Show MCP server status"),
        ("/mcp install <pkg>", "Install MCP server (GitHub/npm)"),
        ("/mcp connect <name>", "Connect to MCP server"),
        ("/mcp disconnect <name>", "Disconnect from MCP server"),
        ("/mcp refresh", "Refresh MCP configurations"),
    ]

    table = Table(title="Commands", box=box.SIMPLE, show_header=True, header_style="bold")
    table.add_column("Command", style="yellow", no_wrap=True)
    table.add_column("Description", style="dim")

    for cmd, desc in commands:
        table.add_row(cmd, desc)

    _console.print()
    _console.print(table)
    _console.print()
    _console.print("  [dim]Prefix with ! to run shell commands (e.g. !ls -la)[/dim]")
    _console.print("  [dim]Press Ctrl+C during execution to stop current task[/dim]")
    _console.print()


def create_spinner(message: str = "Thinking") -> Spinner:
    """Create and return a new spinner instance."""
    return Spinner(message)


# ---------------------------------------------------------------------------
# Task 5: Structured CLI Interface Enhancements
# ---------------------------------------------------------------------------

# Conversation bubble characters
if _SUPPORTS_UNICODE:
    BUBBLE_TL = "╭"
    BUBBLE_TR = "╮"
    BUBBLE_BL = "╰"
    BUBBLE_BR = "╯"
    BUBBLE_H = "─"
    BUBBLE_V = "│"
    COLLAPSE_ICON = "▸"
    EXPAND_ICON = "▾"
    USER_ICON = "❯"
    ASSISTANT_ICON = "◈"
    BULLET_ICON = DOT_ICON
    CODE_BORDER = "┌"
    CODE_BORDER_BOT = "└"
    CODE_BORDER_H = "─"
    CODE_BORDER_V = "│"
    STATUS_IDLE = "○"
    STATUS_THINKING = "◉"
    STATUS_EXECUTING = "●"
    STATUS_ERROR = "✖"
else:
    BUBBLE_TL = "+"
    BUBBLE_TR = "+"
    BUBBLE_BL = "+"
    BUBBLE_BR = "+"
    BUBBLE_H = "-"
    BUBBLE_V = "|"
    COLLAPSE_ICON = "[+]"
    EXPAND_ICON = "[-]"
    USER_ICON = ">"
    ASSISTANT_ICON = "*"
    BULLET_ICON = DOT_ICON
    CODE_BORDER = "+"
    CODE_BORDER_BOT = "+"
    CODE_BORDER_H = "-"
    CODE_BORDER_V = "|"
    STATUS_IDLE = "o"
    STATUS_THINKING = "*"
    STATUS_EXECUTING = "#"
    STATUS_ERROR = "x"


def _wrap_text(text: str, width: int = 76) -> list[str]:
    """Wrap text to specified width, preserving existing newlines.

    Returns list of lines.
    """
    lines = []
    for paragraph in text.split("\n"):
        if not paragraph:
            lines.append("")
            continue
        current = ""
        for word in paragraph.split(" "):
            if not current:
                current = word
            elif len(current) + 1 + len(word) <= width:
                current += " " + word
            else:
                while len(current) > width:
                    lines.append(current[:width])
                    current = current[width:]
                lines.append(current)
                current = word
        if current:
            while len(current) > width:
                lines.append(current[:width])
                current = current[width:]
            if current:
                lines.append(current)
    return lines


def _visible_len(text: str) -> int:
    """Calculate visible length of text, ignoring ANSI escape sequences."""
    return len(re.sub(r'\033\[[0-9;]*m', '', text))


def print_user_input(user_text: str, width: int = 76):
    """Print user input in a rich Panel for visual distinction."""
    panel = Panel(
        user_text,
        title=f"[cyan]{USER_ICON} You[/cyan]",
        border_style="cyan",
        width=min(width, 80),
        padding=(0, 1),
    )
    _console.print(panel)


_OUTPUT_BOX_WIDTH = min(_get_terminal_width() - 4, 72)


def print_model_output_start(model: str = ""):
    """Print the start of a model output container."""
    if _tui_model_output_start is not None:
        _tui_model_output_start(model)
        return
    title = f"{ASSISTANT_ICON} {model}" if model else f"{ASSISTANT_ICON} Assistant"
    title_len = len(title) + 2  # spaces around title
    # Top border: left corner + dashes + title + dashes + right corner
    left_dashes = BUBBLE_H * 2
    right_dashes = BUBBLE_H * max(0, _OUTPUT_BOX_WIDTH - 2 - title_len - 2)
    _console.print(f"  [blue]{BUBBLE_TL}{left_dashes} {title} {right_dashes}{BUBBLE_TR}[/blue]", highlight=False)
    _console.print(f"  [blue]{BUBBLE_V}[/blue]")


def print_model_output_end():
    """Print the end of a model output container."""
    if _tui_model_output_end is not None:
        _tui_model_output_end()
        return
    _console.print(f"  [blue]{BUBBLE_V}[/blue]")
    _console.print(f"  [blue]{BUBBLE_BL}{BUBBLE_H * (_OUTPUT_BOX_WIDTH - 2)}{BUBBLE_BR}[/blue]")
    _console.print()


def print_code_block(code: str, language: str = ""):
    """Print a code block with syntax highlighting via rich."""
    if language:
        try:
            syntax = Syntax(code, language, theme="monokai", line_numbers=False, word_wrap=True)
            _console.print(Panel(syntax, title=language, border_style="dim", padding=(0, 1)))
            return
        except Exception:
            pass

    # Fallback: plain bordered display
    lang_label = f" [{language}]" if language else ""
    border_h = CODE_BORDER_H * 42
    _console.print(f"    [dim]{CODE_BORDER}{border_h}{lang_label}[/dim]", highlight=False)
    for line in code.rstrip("\n").split("\n"):
        _console.print(f"    [dim]{CODE_BORDER_V}[/dim] [dim]{line}[/dim]", highlight=False)
    _console.print(f"    [dim]{CODE_BORDER_BOT}{border_h}[/dim]", highlight=False)


def print_tool_call_collapsible(
    tool_name: str,
    args: dict,
    call_index: int = 0,
    total: int = 1,
    collapsed: bool = True,
    result_preview: Optional[str] = None,
    success: Optional[bool] = None,
    duration: Optional[float] = None,
):
    """Print a tool call with collapsible details."""
    if _tui_tool_call_collapsible is not None:
        _tui_tool_call_collapsible(tool_name, args, call_index, total, collapsed, result_preview, success, duration)
        return
    args_str = _format_tool_args(tool_name, args)
    icon = COLLAPSE_ICON if collapsed else EXPAND_ICON

    if total > 1:
        prefix = f"  [yellow]{TOOL_ICON}[/yellow] [{call_index + 1}/{total}]"
    else:
        prefix = f"  [yellow]{TOOL_ICON}[/yellow]"

    status_str = ""
    if success is not None:
        if success:
            status_str = f" [green]{CHECK_ICON}[/green]"
        else:
            status_str = f" [red]{CROSS_ICON}[/red]"
    if duration is not None:
        status_str += f"[dim] ({duration:.1f}s)[/dim]"

    _console.print(f"{prefix} [dim]{icon}[/dim] [bold]{tool_name}[/bold]{args_str}{status_str}", highlight=False)

    if not collapsed:
        if args:
            args_json = json.dumps(args, ensure_ascii=False, indent=2)
            for line in args_json.split("\n"):
                _console.print(f"      [dim]{line}[/dim]", highlight=False)

        if result_preview:
            preview_lines = result_preview[:500].split("\n")
            _console.print(f"    [dim]{'─' * 36}[/dim]", highlight=False)
            for line in preview_lines[:10]:
                _console.print(f"      [dim]{line}[/dim]", highlight=False)
            if len(result_preview) > 500:
                _console.print(f"      [dim]...[/dim]", highlight=False)


# ---------------------------------------------------------------------------
# Status Bar
# ---------------------------------------------------------------------------

class StatusBar:
    """Persistent status bar showing current agent state.

    Displays: idle / thinking / executing / error states with visual indicators.
    Thread-safe for updates from agent loop.
    """

    def __init__(self):
        self._state = "idle"
        self._detail = ""
        self._lock = threading.Lock()

    def set_thinking(self, model: str = ""):
        """Set status to 'thinking' (model is processing)."""
        with self._lock:
            self._state = "thinking"
            self._detail = model

    def set_executing(self, tool_name: str = ""):
        """Set status to 'executing' (tool is running)."""
        with self._lock:
            self._state = "executing"
            self._detail = tool_name

    def set_idle(self):
        """Set status to 'idle' (waiting for user input)."""
        with self._lock:
            self._state = "idle"
            self._detail = ""

    def set_error(self, message: str = ""):
        """Set status to 'error'."""
        with self._lock:
            self._state = "error"
            self._detail = message

    def render(self) -> str:
        """Render the status bar as a string."""
        with self._lock:
            state = self._state
            detail = self._detail

        if state == "thinking":
            icon = _cyan(STATUS_THINKING)
            label = _cyan("Thinking")
            if detail:
                label += _dim(f" [{detail}]")
        elif state == "executing":
            icon = _yellow(STATUS_EXECUTING)
            label = _yellow("Executing")
            if detail:
                label += _dim(f" [{detail}]")
        elif state == "error":
            icon = _red(STATUS_ERROR)
            label = _red("Error")
            if detail:
                label += _dim(f" {detail[:40]}")
        else:
            icon = _dim(STATUS_IDLE)
            label = _dim("Idle")

        return f"  {icon} {label}"

    def print_status(self):
        """Print the current status bar."""
        _safe_print(self.render())


# Module-level status bar instance
_status_bar = StatusBar()


def get_status_bar() -> StatusBar:
    """Get the module-level status bar instance."""
    return _status_bar


def print_status_bar():
    """Print the current status bar state."""
    _status_bar.print_status()
