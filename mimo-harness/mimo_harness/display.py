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
"""

import os
import sys
import time
import json
import re
import threading
import locale
from typing import Optional
from dataclasses import dataclass, field

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
        encoding = sys.stdout.encoding or locale.getpreferredencoding()
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


def _safe_print(*args, **kwargs):
    """Print with UnicodeEncodeError fallback to ASCII-safe output."""
    try:
        print(*args, **kwargs)
    except UnicodeEncodeError:
        # Replace problematic characters and retry
        safe_args = []
        for a in args:
            s = str(a)
            try:
                s.encode(sys.stdout.encoding or "ascii")
                safe_args.append(s)
            except (UnicodeEncodeError, LookupError):
                safe_args.append(s.encode("ascii", errors="replace").decode("ascii"))
        print(*safe_args, **kwargs)


# ANSI color codes
class Colors:
    """ANSI escape codes for terminal colors."""
    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    ITALIC = "\033[3m"

    # Foreground
    BLACK = "\033[30m"
    RED = "\033[31m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    BLUE = "\033[34m"
    MAGENTA = "\033[35m"
    CYAN = "\033[36m"
    WHITE = "\033[37m"

    # Bright foreground
    BRIGHT_RED = "\033[91m"
    BRIGHT_GREEN = "\033[92m"
    BRIGHT_YELLOW = "\033[93m"
    BRIGHT_BLUE = "\033[94m"
    BRIGHT_MAGENTA = "\033[95m"
    BRIGHT_CYAN = "\033[96m"

    # Background
    BG_RED = "\033[41m"
    BG_GREEN = "\033[42m"
    BG_YELLOW = "\033[43m"
    BG_BLUE = "\033[44m"


def _supports_color() -> bool:
    """Check if terminal supports ANSI colors."""
    # Respect NO_COLOR standard (https://no-color.org/)
    if os.environ.get("NO_COLOR"):
        return False
    # Respect TERM=dumb
    if os.environ.get("TERM") == "dumb":
        return False
    # Windows Terminal and modern cmd.exe support ANSI
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
    """Animated spinner for indicating ongoing operations."""

    def __init__(self, message: str = "Thinking"):
        self.message = message
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._frame = 0
        self._start_time = 0.0

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
            # Clear the spinner line
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
            sys.stdout.write(f"\r  {_cyan(frame)} {self.message} {_dim(f'({elapsed:.1f}s)')}")
            sys.stdout.flush()
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
    """Print the application banner with structured formatting."""
    h = BOX_H * 48
    banner = f"""
{_cyan(f"{BOX_TL}{h}{BOX_TR}")}
{_cyan(BOX_V)}  {_bold("MiMo Harness")} {_dim(f"v{version}")}                          {_cyan(BOX_V)}
{_cyan(BOX_V)}  {_dim("AI Agent powered by Xiaomi MiMo model")}       {_cyan(BOX_V)}
{_cyan(BOX_V)}  {_dim("Claude Code architecture patterns")}             {_cyan(BOX_V)}
{_cyan(f"{BOX_BL}{h}{BOX_BR}")}"""
    _safe_print(banner)


def print_session_info(model: str, mode: str, api_key_set: bool):
    """Print session configuration info."""
    print()
    _safe_print(f"  {_dim('Model:')}    {model}")
    _safe_print(f"  {_dim('API Key:')}  {'*' * 12 if api_key_set else _red('NOT SET')}")
    _safe_print(f"  {_dim('Mode:')}     {mode}")
    print()


def print_step_header(step_info: StepInfo):
    """Print a step header indicating current progress."""
    step_str = f"Step {step_info.current}/{step_info.max_steps}"
    model_str = _dim(f"[{step_info.model}]") if step_info.model else ""
    effort_str = _dim(f"({step_info.effort})") if step_info.effort else ""
    h = STEP_H * 2

    print()
    print(f"  {_blue(h)} {_bold(step_str)} {model_str} {effort_str} {_blue(h)}")
    print()


def print_thinking_indicator():
    """Print a thinking indicator before model response."""
    _safe_print(f"  {_dim(f'{THINK_ICON} Thinking...')}", flush=True)


def print_tool_call_start(tool_name: str, args: dict, call_index: int = 0, total: int = 1):
    """Print tool call start information."""
    # Format arguments nicely
    args_str = _format_tool_args(tool_name, args)

    if total > 1:
        prefix = f"  {_yellow(TOOL_ICON)} [{call_index + 1}/{total}]"
    else:
        prefix = f"  {_yellow(TOOL_ICON)}"

    _safe_print(f"{prefix} {_bold(tool_name)}{args_str}", flush=True)


def print_tool_call_result(
    tool_name: str,
    success: bool,
    duration: float,
    result_preview: Optional[str] = None,
    error: Optional[str] = None,
):
    """Print tool call result."""
    if success:
        status = _green(CHECK_ICON)
        time_str = _dim(f"({duration:.1f}s)")
        _safe_print(f"  {status} {tool_name} {time_str}")

        if result_preview:
            # Show a preview of the result (truncated)
            preview = result_preview[:200].replace("\n", " ")
            if len(result_preview) > 200:
                preview += "..."
            _safe_print(f"    {_dim(preview)}")
    else:
        status = _red(CROSS_ICON)
        time_str = _dim(f"({duration:.1f}s)")
        _safe_print(f"  {status} {tool_name} {time_str}")
        if error:
            error_preview = error[:200].replace("\n", " ")
            _safe_print(f"    {_red(error_preview)}")


def print_streaming_token(token: str):
    """Print a single streaming token (called from streaming callback)."""
    _safe_print(token, end="", flush=True)


def print_streaming_end():
    """Print newline after streaming completes."""
    print()


def print_error(message: str):
    """Print an error message."""
    _safe_print(f"\n  {_red(CROSS_ICON)} {_red(message)}\n")


def print_warning(message: str):
    """Print a warning message."""
    _safe_print(f"  {_yellow(WARN_ICON)} {message}")


def print_info(message: str):
    """Print an info message."""
    _safe_print(f"  {_dim(INFO_ICON)} {message}")


def print_success(message: str):
    """Print a success message."""
    _safe_print(f"  {_green(CHECK_ICON)} {message}")


def print_token_usage(current: int, max_tokens: int):
    """Print token usage with a progress bar."""
    pct = current / max_tokens if max_tokens > 0 else 0
    bar_len = 30
    filled = int(bar_len * pct)

    if pct >= 0.95:
        bar_color = Colors.RED
        status = "BLOCKED"
    elif pct >= 0.85:
        bar_color = Colors.YELLOW
        status = "WARNING"
    else:
        bar_color = Colors.GREEN
        status = "OK"

    bar = BAR_FILL * min(filled, bar_len) + BAR_EMPTY * max(0, bar_len - filled)
    current_str = _format_tokens(current)
    max_str = _format_tokens(max_tokens)

    _safe_print(f"\n  {_dim('Tokens:')} {_c(bar_color, bar)} {current_str}/{max_str} {_dim(status)}")


def print_tool_list(tools: list):
    """Print available tools in a structured format."""
    _safe_print(f"\n  {_bold('Available Tools')}")
    _safe_print(f"  {_dim(BOX_H * 40)}")
    for tool in tools:
        markers = []
        if tool.get("is_read_only"):
            markers.append(_dim("RO"))
        if tool.get("is_concurrency_safe"):
            markers.append(_dim("CS"))
        if tool.get("is_destructive"):
            markers.append(_red("DST"))
        marker_str = f" [{' '.join(markers)}]" if markers else ""
        _safe_print(f"  {_yellow(DOT_ICON)} {tool['name']}{marker_str}")
        if tool.get("description"):
            desc = tool["description"][:60]
            _safe_print(f"    {_dim(desc)}")
    print()


def print_context_breakdown(messages: list, max_display: int = 15):
    """Print context breakdown in a structured format."""
    sep = BOX_H * 60
    _safe_print(f"\n  {_bold('Context Breakdown')} {_dim(f'({len(messages)} messages)')}")
    _safe_print(f"  {_dim(sep)}")
    header = f"{'#':<4} {'Role':<12} {'Tokens':>8}  Content preview"
    _safe_print(f"  {_dim(header)}")
    _safe_print(f"  {_dim(sep)}")

    for i, msg in enumerate(messages[:max_display]):
        role = msg.get("role", "?")
        content = msg.get("content", "")
        if not isinstance(content, str):
            content = str(content) if content else ""
        tokens = max(1, len(content) // 4)
        preview = content[:50].replace("\n", " ")
        _safe_print(f"  {i:<4} {role:<12} {_format_tokens(tokens):>8}  {_dim(preview)}")

    if len(messages) > max_display:
        _safe_print(f"  {_dim(f'... and {len(messages) - max_display} more messages')}")

    _safe_print(f"  {_dim(sep)}")


def print_session_stats(stats: dict):
    """Print session statistics."""
    _safe_print(f"\n  {_bold('Session Statistics')}")
    _safe_print(f"  {_dim(BOX_H * 30)}")
    for key, value in stats.items():
        _safe_print(f"  {_dim(f'{key}:')} {value}")
    print()


def _format_tool_args(tool_name: str, args: dict) -> str:
    """Format tool arguments for display."""
    if not args:
        return ""

    # Special formatting for common tools
    if tool_name in ("read_file", "write_file", "edit_file"):
        path = args.get("path") or args.get("file_path", "")
        if path:
            return f" {_dim(ARROW_ICON)} {_cyan(path)}"

    if tool_name == "run_command":
        cmd = args.get("command", "")
        if cmd:
            # Truncate long commands
            if len(cmd) > 60:
                cmd = cmd[:57] + "..."
            return f" {_dim(ARROW_ICON)} {_dim('$')} {cmd}"

    if tool_name == "search_files":
        pattern = args.get("pattern", "")
        if pattern:
            return f" {_dim(ARROW_ICON)} {_cyan(pattern)}"

    if tool_name == "list_directory":
        path = args.get("path", ".")
        return f" {_dim(ARROW_ICON)} {_cyan(path)}"

    # Generic format
    args_preview = json.dumps(args, ensure_ascii=False)
    if len(args_preview) > 80:
        args_preview = args_preview[:77] + "..."
    return f" {_dim(ARROW_ICON)} {_dim(args_preview)}"


def _format_tokens(tokens: int) -> str:
    """Format token count for display."""
    if tokens >= 1000:
        return f"{tokens / 1000:.1f}K"
    return str(tokens)


def print_help():
    """Print help in structured format."""
    commands = [
        ("/help", "Show this help"),
        ("/quit, /exit", "Exit"),
        ("/clear", "Clear conversation history"),
        ("/save <path>", "Save session to file"),
        ("/load <path>", "Load session from file"),
        ("/tools", "List available tools"),
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
    ]

    _safe_print(f"\n  {_bold('Commands')}")
    _safe_print(f"  {_dim(BOX_H * 50)}")
    for cmd, desc in commands:
        _safe_print(f"  {_yellow(cmd):<25} {_dim(desc)}")
    print()
    _safe_print(f"  {_dim('Prefix with ! to run shell commands (e.g. !ls -la)')}")
    _safe_print(f"  {_dim('Press Ctrl+C during execution to stop current task')}")
    print()


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
        # Simple word-wrap
        current = ""
        for word in paragraph.split(" "):
            if not current:
                current = word
            elif len(current) + 1 + len(word) <= width:
                current += " " + word
            else:
                # Hard-break current if it exceeds width
                while len(current) > width:
                    lines.append(current[:width])
                    current = current[width:]
                lines.append(current)
                current = word
        if current:
            # Hard-break remaining text if it exceeds width
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
    """Print user input in a conversation bubble for visual distinction.

    Uses a right-aligned or labeled bubble to differentiate from model output.
    """
    label = _cyan(f" {USER_ICON} You ")
    lines = _wrap_text(user_text, width - 4)

    label_vis_len = _visible_len(label)
    remaining = max(0, width - 2 - label_vis_len)
    _safe_print(f"  {label}{_dim(BUBBLE_H * remaining)}")
    for line in lines:
        padded = f" {line}{' ' * max(0, width - 3 - len(line))}"
        _safe_print(f"  {_cyan(BUBBLE_V)}{_dim(padded[:width-2])}{_cyan(BUBBLE_V)}")
    _safe_print(f"  {_cyan(BUBBLE_BL)}{_cyan(BUBBLE_H * (width - 2))}{_cyan(BUBBLE_BR)}")
    print()


_OUTPUT_BOX_WIDTH = 56


def print_model_output_start(model: str = ""):
    """Print the start of a model output container.

    Call this before streaming/displaying model response.
    """
    label = f" {ASSISTANT_ICON} Assistant "
    if model:
        label = f" {ASSISTANT_ICON} {model} "
    label_vis = _visible_len(label)
    dash_count = max(0, _OUTPUT_BOX_WIDTH - label_vis)
    _safe_print(f"  {_blue(label)}{_dim(BUBBLE_H * dash_count)}")
    _safe_print(f"  {_blue(BUBBLE_V)}")


def print_model_output_end():
    """Print the end of a model output container.

    Call this after model response is complete.
    """
    _safe_print(f"  {_blue(BUBBLE_V)}")
    _safe_print(f"  {_blue(BUBBLE_BL)}{_blue(BUBBLE_H * (_OUTPUT_BOX_WIDTH - 2))}{_blue(BUBBLE_BR)}")
    print()


def print_code_block(code: str, language: str = ""):
    """Print a code block with optional syntax highlighting.

    If pygments is available and language is specified, applies syntax highlighting.
    Otherwise, uses a simple bordered display with dim styling.
    """
    lang_label = f" [{language}]" if language else ""
    border_h = CODE_BORDER_H * 42

    # Header
    _safe_print(f"    {_dim(f'{CODE_BORDER}{border_h}{lang_label}')}")

    # Apply syntax highlighting if available
    if _HAS_PYGMENTS and language:
        try:
            lexer = get_lexer_by_name(language)
            highlighted = _pygments_highlight(code, lexer, TerminalFormatter())
            for line in highlighted.rstrip("\n").split("\n"):
                _safe_print(f"    {_dim(CODE_BORDER_V)} {line}")
        except Exception:
            # Fallback to plain display
            for line in code.rstrip("\n").split("\n"):
                _safe_print(f"    {_dim(CODE_BORDER_V)} {_dim(line)}")
    else:
        # Plain display with dim styling
        for line in code.rstrip("\n").split("\n"):
            _safe_print(f"    {_dim(CODE_BORDER_V)} {_dim(line)}")

    # Footer
    _safe_print(f"    {_dim(f'{CODE_BORDER_BOT}{border_h}')}")


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
    """Print a tool call with collapsible details.

    Shows tool name and summary on first line. When collapsed, details are hidden.
    When expanded, shows full args and result.
    """
    # Format arguments for summary
    args_str = _format_tool_args(tool_name, args)
    icon = COLLAPSE_ICON if collapsed else EXPAND_ICON

    if total > 1:
        prefix = f"  {_yellow(TOOL_ICON)} [{call_index + 1}/{total}]"
    else:
        prefix = f"  {_yellow(TOOL_ICON)}"

    # Status indicator
    status_str = ""
    if success is not None:
        if success:
            status_str = f" {_green(CHECK_ICON)}"
        else:
            status_str = f" {_red(CROSS_ICON)}"
    if duration is not None:
        status_str += _dim(f" ({duration:.1f}s)")

    # Main line: tool name + args summary + status
    _safe_print(f"{prefix} {_dim(icon)} {_bold(tool_name)}{args_str}{status_str}", flush=True)

    # Expanded details
    if not collapsed:
        # Show full args
        if args:
            args_json = json.dumps(args, ensure_ascii=False, indent=2)
            for line in args_json.split("\n"):
                _safe_print(f"      {_dim(line)}")

        # Show result preview
        if result_preview:
            preview_lines = result_preview[:500].split("\n")
            _safe_print(f"    {_dim('─' * 36)}")
            for line in preview_lines[:10]:
                _safe_print(f"      {_dim(line)}")
            if len(result_preview) > 500:
                _safe_print(f"      {_dim('...')}")


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
