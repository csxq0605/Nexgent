"""CLI entry point - interactive REPL and single-shot modes.

Enhanced with:
- Plan mode (read-only operations)
- Hook loading from config
- Memory management commands
- Permission rules loading
- Pipe input (stdin)
- Output formats (text, json, stream-json)
- Bare mode (no memory)
- !command prefix for shell execution
- /context command for token breakdown
- Effort levels (low, medium, high)
- Structured CLI display (Claude Code style)
"""

import argparse
import os
import re
import sys
import threading
import json
import subprocess
import time
from .agent import MiMoHarness
from .config import MIMO_API_KEY, MIMO_MODEL
from .permissions import PermissionRule
from .context import Session, CheckpointManager, estimate_tokens, compact_context, cleanup_old_sessions, cleanup_old_spill_files, CONTEXT_WINDOW_TOKENS, LoadResult, _CORRUPT_THRESHOLD
from .memory import MemoryStore
from .display import (
    print_banner as display_banner, print_session_info, print_help as display_help,
    print_error, print_warning, print_info, print_success,
    print_token_usage, print_context_breakdown, print_session_stats,
    print_tool_list, USE_COLOR, _format_tokens, _dim, _bold, _yellow, _green, _red, _cyan,
    _safe_print, print_user_input, get_status_bar,
    BUBBLE_H, BULLET_ICON, ARROW_ICON, CHECK_ICON, CROSS_ICON,
)


def _estimate_message_tokens(msg: dict) -> int:
    """Estimate token count for a single message (~4 chars per token)."""
    content = msg.get("content", "")
    if not isinstance(content, str):
        content = str(content) if content else ""
    # Include tool_calls if present
    tool_calls = msg.get("tool_calls")
    if tool_calls:
        content += json.dumps(tool_calls, ensure_ascii=False)
    return max(1, len(content) // 4)


def _output(text: str, output_format: str = "text", session=None, steps: int = 0, duration: float = 0.0):
    """Print output in the requested format."""
    if output_format == "json":
        result_obj = {
            "type": "result",
            "content": text,
            "session_id": session.session_id if session else "",
            "steps": steps,
            "duration": round(duration, 2),
        }
        print(json.dumps(result_obj, ensure_ascii=False))
    elif output_format == "stream-json":
        # For stream-json, the final result is also a JSONL line
        result_obj = {
            "type": "result",
            "content": text,
            "session_id": session.session_id if session else "",
            "steps": steps,
            "duration": round(duration, 2),
        }
        print(json.dumps(result_obj, ensure_ascii=False))
    else:
        print(text)


def _load_config(config_path: str) -> dict:
    """Load configuration from JSON file."""
    if not os.path.exists(config_path):
        return {}
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"Warning: Failed to load config from {config_path}: {e}")
        return {}


class ConfigWatcher:
    """Watch config file for changes and reload on modification.

    Claude Code watches settings files and reloads them on change.
    This implements the same pattern for .mimo/config.json.
    """

    def __init__(self, config_path: str):
        self.config_path = config_path
        self._last_mtime = 0.0
        self._last_config = {}
        if os.path.exists(config_path):
            self._last_mtime = os.path.getmtime(config_path)

    def check_for_changes(self) -> tuple[bool, dict]:
        """Check if config file has changed since last check.

        Returns:
            (changed, new_config) tuple
        """
        if not os.path.exists(self.config_path):
            return False, {}

        current_mtime = os.path.getmtime(self.config_path)
        if current_mtime <= self._last_mtime:
            return False, self._last_config

        try:
            new_config = _load_config(self.config_path)
            self._last_mtime = current_mtime
            self._last_config = new_config
            return True, new_config
        except Exception:
            return False, self._last_config


def _list_session_files(session_dir: str) -> list:
    """List .jsonl session files sorted by modification time (newest first)."""
    import glob
    files = glob.glob(os.path.join(session_dir, "*.jsonl"))
    files.sort(key=os.path.getmtime, reverse=True)
    return files


def _load_session_safe(path: str, session_name: str):
    """Load a session file with corruption handling.

    Returns (session, None) on success, (None, error_msg) on failure.
    Handles partial corruption (skipped lines) and total corruption (ValueError).
    """
    try:
        result = Session.from_jsonl(path)
        session, skipped = result.session, result.skipped
        if skipped > 0:
            total = len(session.messages) + skipped
            pct = skipped / total if total else 0
            if pct > _CORRUPT_THRESHOLD:
                _handle_corrupt_file(path, session_name, f"{skipped}/{total} invalid lines ({pct:.0%} corrupt)")
                return None, f"Session {session_name} too corrupt ({pct:.0%})"
            print(f"Warning: {skipped} invalid line(s) skipped in session {session_name}")
        return session, None
    except ValueError as e:
        _handle_corrupt_file(path, session_name, str(e))
        return None, f"Session {session_name} corrupt: {e}"
    except OSError as e:
        return None, f"Error reading session {session_name}: {e}"


def _handle_corrupt_file(path: str, session_name: str, reason: str):
    """Attempt to rename or remove a corrupt session file."""
    print(f"Warning: session {session_name} is corrupt ({reason})")
    backup = path + ".corrupt"
    try:
        os.replace(path, backup)
        print(f"Renamed to {session_name}.jsonl.corrupt")
    except OSError:
        try:
            os.remove(path)
            print(f"Removed corrupt session file {session_name}.jsonl")
        except OSError:
            print(f"Warning: corrupt session {session_name} could not be renamed or removed. "
                  f"Manually delete '{path}' to resolve.")


def _resume_latest_session(session_dir: str):
    """Find and load the most recent session from session dir."""
    files = _list_session_files(session_dir)
    if not files:
        print("No sessions found to resume.")
        return None
    latest = files[0]
    session_name = os.path.splitext(os.path.basename(latest))[0]
    session, err = _load_session_safe(latest, session_name)
    if err:
        print(err)
    return session


def _pick_session(session_dir: str):
    """List sessions and let user pick one to resume."""
    files = _list_session_files(session_dir)
    if not files:
        print("No sessions found.")
        return None
    print("\nAvailable sessions:")
    for i, f in enumerate(files[:10]):  # Show last 10
        mtime = os.path.getmtime(f)
        import datetime
        dt = datetime.datetime.fromtimestamp(mtime)
        name = os.path.splitext(os.path.basename(f))[0]
        # Count non-empty lines as approximate message count
        try:
            with open(f, "r", encoding="utf-8") as fh:
                msg_count = sum(1 for line in fh if line.strip())
        except Exception:
            msg_count = "?"
        print(f"  [{i+1}] {name} (~{msg_count} msgs, {dt.strftime('%Y-%m-%d %H:%M')})")
    print()
    try:
        choice = input("Pick a session number (or Enter to cancel): ").strip()
        if not choice:
            return None
        idx = int(choice) - 1
        if 0 <= idx < min(10, len(files)):
            session_name = os.path.splitext(os.path.basename(files[idx]))[0]
            session, err = _load_session_safe(files[idx], session_name)
            if err:
                print(err)
            return session
        else:
            print("Invalid selection.")
            return None
    except (ValueError, EOFError, KeyboardInterrupt):
        return None


def _validate_session_id(session_id: str) -> str:
    """Validate session_id is safe for use as a filename component.

    Returns the stripped session_id. Raises ValueError if not valid.
    """
    session_id = session_id.strip()
    if not session_id:
        raise ValueError("Session ID must not be empty")
    if len(session_id) > 64:
        raise ValueError("Session ID must be 64 characters or fewer")
    if not re.fullmatch(r'(?=.*[a-zA-Z0-9])[a-zA-Z0-9_-]+', session_id):
        raise ValueError(
            f"Session ID {session_id!r} contains invalid characters. "
            "Only alphanumeric, hyphens, and underscores are allowed, and must contain at least one alphanumeric character."
        )
    return session_id


def _resume_by_session_id(session_dir: str, session_id: str):
    """Try to resume a session by its ID. Returns Session if file exists, None otherwise."""
    path = os.path.join(session_dir, f"{session_id}.jsonl")
    if not os.path.isfile(path):
        return None
    session, err = _load_session_safe(path, session_id)
    if err:
        print(err)
    return session


def _build_parser():
    """Build the argument parser. Extracted for testability."""
    parser = argparse.ArgumentParser(
        description="MiMo Harness - AI Agent powered by Xiaomi MiMo model"
    )
    parser.add_argument("--task", "-t", help="Run a single task and exit")
    parser.add_argument("--model", "-m", default=None, help=f"Model name (default: {MIMO_MODEL})")
    parser.add_argument("--auto-approve", "-y", action="store_true", help="Auto-approve all write operations")
    parser.add_argument("--dry-run", action="store_true", help="Dry-run mode (show but don't execute)")
    parser.add_argument("--plan", action="store_true", help="Plan mode (read-only operations only)")
    parser.add_argument("--max-steps", type=int, default=None, help="Max agent steps (default: 20)")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output with trace logs")
    parser.add_argument("--log-file", help="Log file path")
    parser.add_argument("--config", "-c", help="Configuration file path")
    parser.add_argument("--rules", "-r", help="Permission rules file path")
    parser.add_argument("--no-stream", action="store_true", help="Disable streaming output (streaming is now default)")
    parser.add_argument("--append-system-prompt", help="Additional text to append to the system prompt")
    parser.add_argument("--fallback-model", help="Fallback model to use if primary model fails with 429/503")
    parser.add_argument("--output-format", choices=["text", "json", "stream-json"], default="text", help="Output format (default: text)")
    parser.add_argument("--bare", action="store_true", help="Bare mode: skip memory loading, use minimal system prompt")
    parser.add_argument("--effort", choices=["low", "medium", "high"], default=None, help="Effort level: low, medium (default), high")
    parser.add_argument("--session-dir", default=None, help="Directory for auto-saving sessions (default: ~/.mimo/sessions/)")
    parser.add_argument("--continue", dest="continue_session", action="store_true", help="Resume the most recent session from session dir")
    parser.add_argument("--resume", action="store_true", help="List sessions and let user pick one to resume")
    parser.add_argument("--name", default=None, help="Name for the current session")
    parser.add_argument("--session-id", default=None, help="Specify a session ID to resume or create")
    parser.add_argument("--cleanup-days", type=int, default=30, help="Delete sessions older than N days (default: 30)")
    return parser


def main():
    parser = _build_parser()
    args = parser.parse_args()

    if args.output_format == "text":
        display_banner()

    # Load configuration
    config = {}
    if args.config:
        config = _load_config(args.config)
    elif os.path.exists(".mimo/config.json"):
        config = _load_config(".mimo/config.json")

    # Streaming is now default ON, use --no-stream to disable
    # Priority: --no-stream flag > config file > default (True)
    if args.no_stream:
        stream_enabled = False
    else:
        stream_enabled = config.get("stream", True)

    harness = MiMoHarness(
        model=args.model or config.get("model"),
        auto_approve=args.auto_approve or config.get("auto_approve", False),
        dry_run=args.dry_run or config.get("dry_run", False),
        max_steps=args.max_steps if args.max_steps is not None else config.get("max_steps", 20),
        verbose=args.verbose,
        log_file=args.log_file or config.get("log_file"),
        plan_mode=args.plan or config.get("plan_mode", False),
        stream=stream_enabled,
        fallback_model=args.fallback_model or config.get("fallback_model"),
        bare=args.bare or config.get("bare", False),
        effort=args.effort or config.get("effort", "medium"),
    )

    # Append extra system prompt text if provided (S15)
    append_prompt = args.append_system_prompt or config.get("append_system_prompt", "")
    if append_prompt:
        harness._append_system_prompt = append_prompt

    # Load permission rules
    rules_path = args.rules or config.get("rules_file")
    if rules_path:
        harness.perms.load_rules_from_file(rules_path)
    elif os.path.exists(".mimo/permissions.json"):
        harness.perms.load_rules_from_file(".mimo/permissions.json")

    # Load hooks from config
    if "hooks" in config:
        from .hooks import HookRunner
        harness._hook_runner = HookRunner()
        harness._hook_runner.load_from_config(config)

    # C1: Read stdin if piped
    stdin_content = ""
    try:
        if not sys.stdin.isatty():
            # D4: Limit stdin to 1MB to prevent OOM on large pipe input
            stdin_content = sys.stdin.read(1_000_000)
    except (OSError, EOFError):
        pass

    # A4+X1: Session directory setup
    session_dir = args.session_dir or os.path.join(os.path.expanduser("~"), ".mimo", "sessions")
    os.makedirs(session_dir, exist_ok=True)

    # Claude Code pattern: auto-cleanup old sessions (default 30 days)
    cleanup_days = getattr(args, "cleanup_days", 30)
    cleaned = cleanup_old_sessions(session_dir, max_age_days=cleanup_days)
    if cleaned > 0:
        print(f"Cleaned up {cleaned} session(s) older than {cleanup_days} days")

    # Cleanup old tool output spill files (default 7 days)
    spill_cleaned = cleanup_old_spill_files(max_age_days=7)
    if spill_cleaned > 0:
        print(f"Cleaned up {spill_cleaned} old output file(s)")

    # A3+C2: Session resume logic (priority: --session-id > --continue > --resume > new)
    import secrets
    session = None
    if args.session_id is not None:
        try:
            args.session_id = _validate_session_id(args.session_id)
        except ValueError as e:
            print(f"Error: {e}")
            sys.exit(1)
        session = _resume_by_session_id(session_dir, args.session_id)
        if session is None:
            session = Session(
                session_id=args.session_id,
                auto_save_dir=session_dir,
                name=args.name or "",
            )
        else:
            session.auto_save_dir = session_dir
            if args.name:
                session.name = args.name
            print(f"Resumed session: {session.session_id} ({len(session.messages)} messages)")
    elif args.continue_session:
        session = _resume_latest_session(session_dir)
    elif args.resume:
        session = _pick_session(session_dir)

    if session is None:
        session = Session(
            session_id=secrets.token_hex(4),
            auto_save_dir=session_dir,
            name=args.name or "",
        )
    elif not args.session_id:
        session.auto_save_dir = session_dir
        if args.name:
            session.name = args.name

    # Build task from stdin and/or --task
    task = None
    if stdin_content and args.task:
        task = f"{stdin_content}\n\n{args.task}"
    elif stdin_content:
        task = stdin_content
    elif args.task:
        task = args.task

    if task:
        start_time = time.time()
        result = harness.run(task, session=session)
        duration = time.time() - start_time
        # Retrieve session info for structured output
        last_session = getattr(harness, '_last_session', None) or session
        last_steps = getattr(harness, '_last_steps', 0)
        # Save session metadata after task completes
        if last_session and last_session.auto_save_dir:
            last_session.save_meta_to_jsonl()
        _output(result, args.output_format, session=last_session, steps=last_steps, duration=duration)
        return

    # Interactive REPL mode - use structured display
    mode_str = 'plan' if args.plan else 'dry-run' if args.dry_run else 'auto-approve' if args.auto_approve else 'interactive'
    if args.output_format == "text":
        print_session_info(harness.model, mode_str, bool(MIMO_API_KEY))
        print_info("Type /help for commands, or just start chatting.")
        print()

    memory_store = MemoryStore(".")
    checkpoint_manager = CheckpointManager(session.session_id)
    harness._checkpoint_manager = checkpoint_manager

    # Config hot-reload watcher
    config_path = args.config or ".mimo/config.json"
    config_watcher = ConfigWatcher(config_path)

    # Initialize scheduler for session-scoped cron jobs
    from .tools.scheduler_tools import Scheduler, set_scheduler
    _scheduled_prompts = []
    _scheduled_lock = threading.Lock()
    _MAX_SCHEDULED_PROMPTS = 10
    def _on_scheduled_prompt(prompt):
        with _scheduled_lock:
            if len(_scheduled_prompts) >= _MAX_SCHEDULED_PROMPTS:
                _scheduled_prompts.pop(0)  # Drop oldest to prevent unbounded growth
            _scheduled_prompts.append(prompt)
        print(f"\n[Scheduled] {prompt[:60]}...")
    scheduler = Scheduler(callback=_on_scheduled_prompt)
    set_scheduler(scheduler)
    scheduler.start_background_checker(interval=30.0)

    while True:
        # Show token count in prompt with structured format
        tokens = estimate_tokens(session.messages)
        token_str = _format_tokens(tokens)
        max_str = _format_tokens(CONTEXT_WINDOW_TOKENS)
        try:
            # Use colored prompt for better visibility
            prompt = f"\n{_cyan('You')} {_dim(f'[{token_str}/{max_str}]')}: "
            user_input = input(prompt).strip()
        except (EOFError, KeyboardInterrupt):
            try:
                session.save_meta_to_jsonl()
            except OSError:
                pass
            scheduler.stop()
            print_info("Bye!")
            break

        if not user_input:
            # Check for scheduled prompts even when user provides no input
            with _scheduled_lock:
                scheduled = _scheduled_prompts.pop(0) if _scheduled_prompts else None
            if scheduled:
                print_info(f"Executing scheduled prompt...")
                user_input = scheduled
            else:
                continue

        # Check for config hot-reload
        config_changed, new_config = config_watcher.check_for_changes()
        if config_changed:
            # Reload hooks from new config
            if "hooks" in new_config:
                from .hooks import HookRunner
                harness._hook_runner = HookRunner()
                harness._hook_runner.load_from_config(new_config)
            # Reload permission rules
            rules_path = new_config.get("rules_file")
            if rules_path:
                harness.perms.rules.clear()
                harness.perms.load_rules_from_file(rules_path)
            print_info("Config reloaded")

        # Handle commands
        if user_input.startswith("/"):
            parts = user_input.split()
            cmd = [parts[0].lower()] + parts[1:]
            action, session = _handle_command(cmd, harness, session, memory_store, checkpoint_manager, session_dir)
            if action == "quit":
                break
            continue

        # C7: !command prefix — execute shell command directly
        if user_input.startswith("!"):
            shell_cmd = user_input[1:]
            # Route through permission system for logging and protection
            from .permissions import Permission
            from .tools.shell import _scrub_env, _is_readonly
            # Auto-approve readonly commands (consistent with run_command tool)
            perm = Permission.READ if _is_readonly(shell_cmd) else Permission.WRITE
            action_desc = f"run_command({shell_cmd[:100]})"
            if not harness.perms.check(perm, action_desc, params={"command": shell_cmd}):
                print_error("[blocked by permission system]")
                continue
            print(f"  {_dim('$')} {shell_cmd}")
            try:
                scrubbed_env = _scrub_env()
                result = subprocess.run(
                    shell_cmd, shell=True, capture_output=True, text=True,
                    timeout=30, env=scrubbed_env
                )
                if result.stdout:
                    print(result.stdout, end="")
                if result.stderr:
                    print(result.stderr, end="")
                if result.returncode != 0 and not result.stdout and not result.stderr:
                    print_warning(f"[exit code: {result.returncode}]")
            except subprocess.TimeoutExpired:
                print_error("[command timed out after 30s]")
            except Exception as e:
                print_error(f"[error: {e}]")
            continue

        # Run agent with graceful interrupt support
        try:
            # Show user input in a conversation bubble for visual distinction
            if args.output_format == "text":
                print_user_input(user_input)
            # Update status bar to executing
            get_status_bar().set_thinking(harness.model)
            # Streaming is now the default - tokens are printed directly by the agent
            harness.run(user_input, session)
            # Status bar set to idle after agent completes
            get_status_bar().set_idle()
        except KeyboardInterrupt:
            # Graceful abort: stop current task but don't exit REPL
            harness.graceful_abort.request()
            get_status_bar().set_idle()
            print_warning("\nInterrupted — stopping current task...")
            # The agent loop will check the abort flag at the next step boundary


def _handle_command(cmd, harness, session, memory_store, checkpoint_manager=None, session_dir=None):
    """Handle a single REPL command.

    Returns (action, session) where action is 'quit' or 'continue'.
    The session may be replaced by /load.
    """
    if cmd[0] in ("/quit", "/exit", "/q"):
        try:
            session.save_meta_to_jsonl()
        except OSError:
            pass
        from .tools.scheduler_tools import get_scheduler
        sched = get_scheduler()
        if sched:
            sched.stop()
        print_info("Bye!")
        return "quit", session
    elif cmd[0] == "/help":
        display_help()
    elif cmd[0] == "/clear":
        session.messages.clear()
        # Also truncate the JSONL file so cleared state persists
        if session.auto_save_dir:
            jsonl_path = os.path.join(session.auto_save_dir, f"{session.session_id}.jsonl")
            try:
                with open(jsonl_path, "w", encoding="utf-8"):
                    pass
            except OSError:
                pass
        print_success("Session cleared.")
    elif cmd[0] == "/tools":
        tools_info = []
        for name in harness.registry.list_names():
            tool = harness.registry.get(name)
            tools_info.append({
                "name": name,
                "description": tool.description,
                "is_read_only": tool.is_read_only,
                "is_concurrency_safe": tool.is_concurrency_safe,
                "is_destructive": tool.is_destructive,
            })
        print_tool_list(tools_info)
    elif cmd[0] == "/dry-run":
        harness.perms.dry_run = not harness.perms.dry_run
        status = "ON" if harness.perms.dry_run else "OFF"
        print_info(f"Dry-run: {status}")
    elif cmd[0] == "/auto":
        harness.perms.auto_approve = not harness.perms.auto_approve
        status = "ON" if harness.perms.auto_approve else "OFF"
        print_info(f"Auto-approve: {status}")
    elif cmd[0] == "/plan":
        from .permissions import PermissionMode
        if harness.perms.mode.value == "plan":
            harness.perms.mode = PermissionMode.DEFAULT
            print_info("Plan mode: OFF")
        else:
            harness.perms.mode = PermissionMode.PLAN
            print_info("Plan mode: ON (read-only)")
    elif cmd[0] == "/abort":
        harness.graceful_abort.request()
        print_warning("Abort requested — current task will stop at next step boundary.")
    elif cmd[0] == "/memory":
        memories = memory_store.list_memories()
        if memories:
            print(f"\n  {_bold(f'Stored memories ({len(memories)})')}")
            for m in memories:
                _safe_print(f"  {_yellow(BULLET_ICON)} [{m.memory_type.value}] {m.name}: {_dim(m.description[:60])}")
        else:
            print_info("No memories stored.")
        print()
    elif cmd[0] == "/remember":
        print_info("Enter memory content (empty line to finish):")
        lines = []
        while True:
            try:
                line = input()
                if not line:
                    break
                lines.append(line)
            except (EOFError, KeyboardInterrupt):
                break
        if lines:
            content = "\n".join(lines)
            memory_store.save_memory(
                name=f"session-{session.session_id[:8]}",
                memory_type=__import__('mimo_harness.memory', fromlist=['MemoryType']).MemoryType.PROJECT,
                description=f"Memory from session {session.session_id[:8]}",
                content=content,
            )
            print_success("Memory saved.")
    elif cmd[0] == "/hooks":
        hook_runner = getattr(harness, '_hook_runner', None)
        if hook_runner:
            total = sum(len(v) for v in hook_runner._hooks.values())
            print(f"\n  {_bold(f'Registered hooks: {total}')}")
            for event, hooks in hook_runner._hooks.items():
                for h in hooks:
                    _safe_print(f"  {_yellow(BULLET_ICON)} [{event.value}] {h.matcher} {ARROW_ICON} {_dim(h.command[:50])}")
        else:
            print_info("No hooks registered.")
        print()
    elif cmd[0] == "/stats":
        tokens = estimate_tokens(session.messages)
        stats_dict = {
            "Messages": len(session.messages),
            "Tokens": f"{_format_tokens(tokens)} / {_format_tokens(CONTEXT_WINDOW_TOKENS)}",
            "Compactions": session.compaction_count,
            "Approval log": f"{len(harness.perms.approval_log)} entries",
        }
        if harness.circuit_breaker.consecutive_failures > 0:
            stats_dict["Circuit breaker failures"] = harness.circuit_breaker.consecutive_failures
        print_session_stats(stats_dict)
        # Show token stats
        token_stats = harness.token_budget.get_stats()
        token_stats.total_tokens = tokens
        token_stats.message_count = len(session.messages)
        token_stats.compression_count = session.compaction_count
        print(token_stats.format_report())
        print()
    elif cmd[0] == "/tokens":
        tokens = estimate_tokens(session.messages)
        print_token_usage(tokens, CONTEXT_WINDOW_TOKENS)
        print(f"  {_dim('Messages:')} {len(session.messages)}")
        print(f"  {_dim('Compactions:')} {session.compaction_count}")
        # Show token stats if available
        stats = harness.token_budget.get_stats()
        if stats.message_count > 0:
            print(f"\n  {_bold('Token Statistics')}")
            print(stats.format_report())
        print()
    elif cmd[0] == "/compact":
        tokens_before = estimate_tokens(session.messages)
        if tokens_before < 1000:
            print_info("Not enough messages to compress.")
        else:
            print_info(f"Compressing... ({_format_tokens(tokens_before)} tokens)")
            from .config import MIMO_BASE_URL, require_api_key
            try:
                api_key = require_api_key()
                from openai import OpenAI
                client = OpenAI(api_key=api_key, base_url=MIMO_BASE_URL)
                compacted, _, _, _, _ = compact_context(
                    session.messages,
                    client=client,
                    model=harness.model,
                    estimated_tokens=tokens_before,
                )
                session.messages = compacted
                session.compaction_count += 1
                tokens_after = estimate_tokens(session.messages)
                print_success(f"Done: {_format_tokens(tokens_before)} {ARROW_ICON} {_format_tokens(tokens_after)} tokens")
            except Exception as e:
                # Fallback: no LLM, just truncation
                compacted, _, _, _, _ = compact_context(
                    session.messages,
                    estimated_tokens=tokens_before,
                )
                session.messages = compacted
                session.compaction_count += 1
                tokens_after = estimate_tokens(session.messages)
                print_success(f"Done (truncation): {_format_tokens(tokens_before)} {ARROW_ICON} {_format_tokens(tokens_after)} tokens")
        print()
    elif cmd[0] == "/context":
        # C9: Per-message token breakdown
        if not session.messages:
            print_info("No messages in session.")
        else:
            print_context_breakdown(session.messages)
            print()
    elif cmd[0] == "/init":
        from .project_scanner import scan_project, generate_agents_md
        agents_md_path = os.path.join(os.getcwd(), "AGENTS.md")
        if os.path.exists(agents_md_path):
            confirm = input(
                f"  {_yellow('AGENTS.md already exists. Overwrite? [y/N] ')}"
            ).strip().lower()
            if confirm not in ("y", "yes"):
                print_info("Skipped.")
                return "continue", session
        print_info("Scanning project...")
        result = scan_project(".")
        content = generate_agents_md(result)
        with open(agents_md_path, "w", encoding="utf-8") as f:
            f.write(content)
        print_success(f"AGENTS.md generated at {agents_md_path}")
        print(f"  {_dim('Language:')} {result.get('language', 'unknown')}")
        if result.get("frameworks"):
            print(f"  {_dim('Frameworks:')} {', '.join(result['frameworks'])}")
        if result.get("test_runner"):
            print(f"  {_dim('Test runner:')} {result['test_runner']}")
        print()
    elif cmd[0] == "/rewind":
        if checkpoint_manager:
            restored = checkpoint_manager.restore_last()
            if restored:
                print_success(f"Restored {len(restored)} file(s):")
                for p in restored:
                    _safe_print(f"  {_dim(BULLET_ICON)} {p}")
            else:
                print_info("No checkpoint to restore.")
        else:
            print_warning("No checkpoint manager available.")
        print()
    elif cmd[0] == "/fork":
        import secrets
        new_id = secrets.token_hex(4)
        old_id = session.session_id
        session.session_id = new_id
        session.name = f"fork-{old_id[:8]}"
        # Write all existing messages to the new session's JSONL
        if session.auto_save_dir:
            new_path = os.path.join(session.auto_save_dir, f"{new_id}.jsonl")
            try:
                with open(new_path, "w", encoding="utf-8") as f:
                    for msg in session.messages:
                        f.write(json.dumps(msg, ensure_ascii=False) + "\n")
            except OSError as e:
                print_warning(f"Could not write fork session file: {e}")
        # Update checkpoint_manager to new session
        if checkpoint_manager:
            checkpoint_manager.checkpoint_dir = os.path.join(".mimo", "checkpoints", new_id)
            checkpoint_manager._seq = 0
            checkpoint_manager._batch_dir = None
        print_success(f"Session forked: {old_id} {ARROW_ICON} {new_id}")
    elif cmd[0] == "/subagents":
        # List active SubAgents
        summary = harness.get_subagent_summary()
        print(f"\n  {_bold('SubAgent Summary')}")
        _safe_print(f"  {_dim(BUBBLE_H * 30)}")
        print(f"  {_dim('Total:')} {summary.get('total_subagents', 0)}")
        print(f"  {_dim('Running:')} {summary.get('running', 0)}")
        print(f"  {_dim('Completed:')} {summary.get('completed', 0)}")
        print(f"  {_dim('Failed:')} {summary.get('failed', 0)}")
        if summary.get('total_tokens_used', 0) > 0:
            print(f"  {_dim('Tokens used:')} {_format_tokens(summary['total_tokens_used'])}")
        if summary.get('total_time_elapsed', 0) > 0:
            print(f"  {_dim('Time elapsed:')} {summary['total_time_elapsed']:.1f}s")
        print()
    elif cmd[0] == "/subagent" and len(cmd) > 1:
        # Run a single task as a SubAgent
        task = " ".join(cmd[1:])
        print_info(f"Running SubAgent: {task[:60]}...")
        try:
            from .subagent import SubAgentConfig
            config = SubAgentConfig(task=task, effort=harness.effort)
            result = harness.subagent_manager.run_single(config)
            print(f"\n  {_bold('SubAgent Result')}")
            print(f"  {_dim('Status:')} {result.state.value}")
            print(f"  {_dim('Steps:')} {result.steps_taken}")
            print(f"  {_dim('Duration:')} {result.duration_seconds:.1f}s")
            if result.result:
                print(f"\n{result.result}")
            elif result.error:
                print_error(f"Error: {result.error}")
        except Exception as e:
            print_error(str(e))
        print()
    elif cmd[0] == "/parallel" and len(cmd) > 1:
        # Run tasks in parallel
        tasks_str = " ".join(cmd[1:])
        tasks = [t.strip() for t in tasks_str.split("|") if t.strip()]
        if len(tasks) < 2:
            print_warning("Usage: /parallel <task1> | <task2> | ...")
            print_info("Separate tasks with | (pipe)")
        else:
            print_info(f"Running {len(tasks)} tasks in parallel...")
            for i, task in enumerate(tasks, 1):
                print(f"  {_dim(f'[{i}]')} {task[:50]}...")
            try:
                results = harness.run_parallel_subagents(tasks, effort=harness.effort)
                print(f"\n  {_bold('Results')}")
                _safe_print(f"  {_dim(BUBBLE_H * 40)}")
                for i, result in enumerate(results, 1):
                    status = _green(CHECK_ICON) if result.success else _red(CROSS_ICON)
                    print(f"  [{i}] {status} {result.state.value} ({result.duration_seconds:.1f}s)")
                    if result.result:
                        preview = result.result[:100].replace("\n", " ")
                        print(f"      {_dim(preview)}...")
                # Show summary
                summary = harness.subagent_manager.aggregate_results(results)
                print(f"\n  {_bold('Summary:')} {summary['successful']}/{summary['total']} succeeded")
            except Exception as e:
                print_error(str(e))
        print()
    elif cmd[0] == "/pipeline" and len(cmd) > 1:
        # Run tasks in pipeline
        tasks_str = " ".join(cmd[1:])
        tasks = [t.strip() for t in tasks_str.split("|") if t.strip()]
        if len(tasks) < 2:
            print_warning("Usage: /pipeline <task1> | <task2> | ...")
            print_info("Separate tasks with | (pipe)")
        else:
            print_info(f"Running {len(tasks)} tasks in pipeline...")
            for i, task in enumerate(tasks, 1):
                print(f"  {_dim(f'Stage {i}:')} {task[:50]}...")
            try:
                stages = [{"task": task} for task in tasks]
                results = harness.run_pipeline_subagents(stages)
                print(f"\n  {_bold('Results')}")
                _safe_print(f"  {_dim(BUBBLE_H * 40)}")
                for i, result in enumerate(results, 1):
                    status = _green(CHECK_ICON) if result.success else _red(CROSS_ICON)
                    print(f"  Stage {i}: {status} {result.state.value} ({result.duration_seconds:.1f}s)")
                    if result.result:
                        preview = result.result[:100].replace("\n", " ")
                        print(f"           {_dim(preview)}...")
                # Show summary
                summary = harness.subagent_manager.aggregate_results(results)
                print(f"\n  {_bold('Summary:')} {summary['successful']}/{summary['total']} stages succeeded")
            except Exception as e:
                print_error(str(e))
        print()
    elif cmd[0] == "/save" and len(cmd) > 1:
        try:
            session.save(cmd[1])
            print_success(f"Session saved to {cmd[1]}")
        except Exception as e:
            print_error(str(e))
    elif cmd[0] == "/load" and len(cmd) > 1:
        try:
            # Save current session metadata before replacing
            try:
                session.save_meta_to_jsonl()
            except OSError:
                pass
            session = Session.load(cmd[1])
            if session_dir:
                session.auto_save_dir = session_dir
            # Update checkpoint_manager to loaded session
            if checkpoint_manager:
                checkpoint_manager.checkpoint_dir = os.path.join(".mimo", "checkpoints", session.session_id)
                checkpoint_manager._seq = 0
                checkpoint_manager._batch_dir = None
            print_success(f"Session loaded from {cmd[1]}")
        except Exception as e:
            print_error(str(e))
    else:
        print_warning(f"Unknown command: {cmd[0]}. Type /help for commands.")
    return "continue", session


if __name__ == "__main__":
    main()
