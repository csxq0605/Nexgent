"""Structured CLI display module for MiMo Harness.

Provides rich, structured output similar to Claude Code:
- Step indicators
- Tool call visualization
- Streaming output formatting
- Status indicators
- Thinking/reasoning display
"""

import os
import sys
import time
import json
import threading
from typing import Optional
from dataclasses import dataclass


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


# Spinner frames for animation
SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]


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
    banner = f"""
{_cyan("╭────────────────────────────────────────────────╮")}
{_cyan("│")}  {_bold("MiMo Harness")} {_dim(f"v{version}")}                          {_cyan("│")}
{_cyan("│")}  {_dim("AI Agent powered by Xiaomi MiMo model")}       {_cyan("│")}
{_cyan("│")}  {_dim("Claude Code architecture patterns")}             {_cyan("│")}
{_cyan("╰────────────────────────────────────────────────╯")}"""
    print(banner)


def print_session_info(model: str, mode: str, api_key_set: bool):
    """Print session configuration info."""
    print()
    print(f"  {_dim("Model:")}    {model}")
    print(f"  {_dim("API Key:")}  {"*" * 12 if api_key_set else _red("NOT SET")}")
    print(f"  {_dim("Mode:")}     {mode}")
    print()


def print_step_header(step_info: StepInfo):
    """Print a step header indicating current progress."""
    step_str = f"Step {step_info.current}/{step_info.max_steps}"
    model_str = _dim(f"[{step_info.model}]") if step_info.model else ""
    effort_str = _dim(f"({step_info.effort})") if step_info.effort else ""

    print()
    print(f"  {_blue("━━")} {_bold(step_str)} {model_str} {effort_str} {_blue("━━")}")
    print()


def print_thinking_indicator():
    """Print a thinking indicator before model response."""
    print(f"  {_dim("💭 Thinking...")}", flush=True)


def print_tool_call_start(tool_name: str, args: dict, call_index: int = 0, total: int = 1):
    """Print tool call start information."""
    # Format arguments nicely
    args_str = _format_tool_args(tool_name, args)

    if total > 1:
        prefix = f"  {_yellow("⚡")} [{call_index + 1}/{total}]"
    else:
        prefix = f"  {_yellow("⚡")}"

    print(f"{prefix} {_bold(tool_name)}{args_str}", flush=True)


def print_tool_call_result(
    tool_name: str,
    success: bool,
    duration: float,
    result_preview: Optional[str] = None,
    error: Optional[str] = None,
):
    """Print tool call result."""
    if success:
        status = _green("✓")
        time_str = _dim(f"({duration:.1f}s)")
        print(f"  {status} {tool_name} {time_str}")

        if result_preview:
            # Show a preview of the result (truncated)
            preview = result_preview[:200].replace("\n", " ")
            if len(result_preview) > 200:
                preview += "..."
            print(f"    {_dim(preview)}")
    else:
        status = _red("✗")
        time_str = _dim(f"({duration:.1f}s)")
        print(f"  {status} {tool_name} {time_str}")
        if error:
            error_preview = error[:200].replace("\n", " ")
            print(f"    {_red(error_preview)}")


def print_streaming_token(token: str):
    """Print a single streaming token (called from streaming callback)."""
    sys.stdout.write(token)
    sys.stdout.flush()


def print_streaming_end():
    """Print newline after streaming completes."""
    print()


def print_error(message: str):
    """Print an error message."""
    print(f"\n  {_red("✗")} {_red(message)}\n")


def print_warning(message: str):
    """Print a warning message."""
    print(f"  {_yellow("⚠")} {message}")


def print_info(message: str):
    """Print an info message."""
    print(f"  {_dim("ℹ")} {message}")


def print_success(message: str):
    """Print a success message."""
    print(f"  {_green("✓")} {message}")


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

    bar = "█" * min(filled, bar_len) + "░" * max(0, bar_len - filled)
    current_str = _format_tokens(current)
    max_str = _format_tokens(max_tokens)

    print(f"\n  {_dim("Tokens:")} {_c(bar_color, bar)} {current_str}/{max_str} {_dim(status)}")


def print_tool_list(tools: list):
    """Print available tools in a structured format."""
    print(f"\n  {_bold("Available Tools")}")
    print(f"  {_dim("─" * 40)}")
    for tool in tools:
        markers = []
        if tool.get("is_read_only"):
            markers.append(_dim("RO"))
        if tool.get("is_concurrency_safe"):
            markers.append(_dim("CS"))
        if tool.get("is_destructive"):
            markers.append(_red("DST"))
        marker_str = f" [{' '.join(markers)}]" if markers else ""
        print(f"  {_yellow("•")} {tool['name']}{marker_str}")
        if tool.get("description"):
            desc = tool["description"][:60]
            print(f"    {_dim(desc)}")
    print()


def print_context_breakdown(messages: list, max_display: int = 15):
    """Print context breakdown in a structured format."""
    print(f"\n  {_bold("Context Breakdown")} {_dim(f"({len(messages)} messages)")}")
    print(f"  {_dim("─" * 60)}")
    print(f"  {_dim(f"{'#':<4} {'Role':<12} {'Tokens':>8}  Content preview")}")
    print(f"  {_dim("─" * 60)}")

    for i, msg in enumerate(messages[:max_display]):
        role = msg.get("role", "?")
        content = msg.get("content", "")
        if not isinstance(content, str):
            content = str(content) if content else ""
        tokens = max(1, len(content) // 4)
        preview = content[:50].replace("\n", " ")
        print(f"  {i:<4} {role:<12} {_format_tokens(tokens):>8}  {_dim(preview)}")

    if len(messages) > max_display:
        print(f"  {_dim(f'... and {len(messages) - max_display} more messages')}")

    print(f"  {_dim("─" * 60)}")


def print_session_stats(stats: dict):
    """Print session statistics."""
    print(f"\n  {_bold("Session Statistics")}")
    print(f"  {_dim("─" * 30)}")
    for key, value in stats.items():
        print(f"  {_dim(f"{key}:")} {value}")
    print()


def _format_tool_args(tool_name: str, args: dict) -> str:
    """Format tool arguments for display."""
    if not args:
        return ""

    # Special formatting for common tools
    if tool_name in ("read_file", "write_file", "edit_file"):
        path = args.get("path") or args.get("file_path", "")
        if path:
            return f" {_dim('→')} {_cyan(path)}"

    if tool_name == "run_command":
        cmd = args.get("command", "")
        if cmd:
            # Truncate long commands
            if len(cmd) > 60:
                cmd = cmd[:57] + "..."
            return f" {_dim('→')} {_dim('$')} {cmd}"

    if tool_name == "search_files":
        pattern = args.get("pattern", "")
        if pattern:
            return f" {_dim('→')} {_cyan(pattern)}"

    if tool_name == "list_directory":
        path = args.get("path", ".")
        return f" {_dim('→')} {_cyan(path)}"

    # Generic format
    args_preview = json.dumps(args, ensure_ascii=False)
    if len(args_preview) > 80:
        args_preview = args_preview[:77] + "..."
    return f" {_dim('→')} {_dim(args_preview)}"


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

    print(f"\n  {_bold("Commands")}")
    print(f"  {_dim("─" * 50)}")
    for cmd, desc in commands:
        print(f"  {_yellow(cmd):<25} {_dim(desc)}")
    print()
    print(f"  {_dim("Prefix with ! to run shell commands (e.g. !ls -la)")}")
    print(f"  {_dim("Press Ctrl+C during execution to stop current task")}")
    print()


def create_spinner(message: str = "Thinking") -> Spinner:
    """Create and return a new spinner instance."""
    return Spinner(message)
