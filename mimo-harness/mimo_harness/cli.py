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
"""

import argparse
import os
import re
import sys
import json
import subprocess
import time
from .agent import MiMoHarness
from .config import MIMO_API_KEY, MIMO_MODEL
from .permissions import PermissionRule
from .context import Session, CheckpointManager, estimate_tokens, compact_context, cleanup_old_sessions, cleanup_old_spill_files, CONTEXT_WINDOW_TOKENS, LoadResult, _CORRUPT_THRESHOLD
from .memory import MemoryStore


def print_banner():
    print("""
+------------------------------------------+
|          MiMo Harness v0.2.0             |
|  AI Agent powered by Xiaomi MiMo model  |
|  Claude Code architecture patterns       |
+------------------------------------------+
""")


def _format_tokens(tokens: int) -> str:
    """Format token count for display (e.g. 45231 → '45K')."""
    if tokens >= 1000:
        return f"{tokens / 1000:.1f}K"
    return str(tokens)


def print_help():
    print("""
Commands:
  /help          Show this help
  /quit, /exit   Exit
  /clear         Clear conversation history
  /save <path>   Save session to file
  /load <path>   Load session from file
  /tools         List available tools
  /dry-run       Toggle dry-run mode
  /auto          Toggle auto-approve mode
  /plan          Toggle plan mode (read-only)
  /abort         Stop current task (graceful interrupt)
  /memory        List stored memories
  /remember      Save current context as memory
  /hooks         List registered hooks
  /stats         Show session statistics
  /tokens        Show current token usage
  /compact       Manually compress conversation context
  /context       Show per-message token breakdown
  /init          Scan project and generate AGENTS.md
  /rewind        Restore files from the last checkpoint
  /fork          Fork session into a new session (copy history)

Or just type a task to interact with the agent.
Prefix with ! to run a shell command directly (e.g. !ls -la).
Press Ctrl+C during execution to stop the current task (doesn't exit).
""")


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


def _resume_latest_session(session_dir: str):
    """Find and load the most recent session from session dir."""
    files = _list_session_files(session_dir)
    if not files:
        print("No sessions found to resume.")
        return None
    latest = files[0]
    session_id = os.path.splitext(os.path.basename(latest))[0]
    try:
        result = Session.from_jsonl(latest)
        session, skipped = result.session, result.skipped
        if skipped > 0:
            total = len(session.messages) + skipped
            pct = skipped / total if total else 0
            if pct > _CORRUPT_THRESHOLD:
                print(f"Warning: session {session_id} has {skipped}/{total} invalid lines ({pct:.0%} corrupt)")
                backup = latest + ".corrupt"
                try:
                    os.replace(latest, backup)
                    print(f"Renamed to {session_id}.jsonl.corrupt")
                except OSError:
                    try:
                        os.remove(latest)
                        print(f"Removed corrupt session file {session_id}.jsonl")
                    except OSError:
                        print(f"Warning: corrupt session {session_id} could not be removed")
                return None
            else:
                print(f"Warning: {skipped} invalid line(s) skipped in session {session_id}")
        return session
    except ValueError as e:
        # Corrupt data — rename to .corrupt so --continue doesn't loop
        backup = latest + ".corrupt"
        try:
            os.replace(latest, backup)
            print(f"Warning: session {session_id} was corrupt ({e}), renamed to .corrupt")
        except OSError:
            try:
                os.remove(latest)
                print(f"Removed corrupt session file {session_id}.jsonl")
            except OSError:
                print(f"Warning: corrupt session {session_id} could not be removed")
        return None
    except OSError as e:
        print(f"Error loading session: {e}")
        return None


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
        if 0 <= idx < len(files):
            session_name = os.path.splitext(os.path.basename(files[idx]))[0]
            try:
                result = Session.from_jsonl(files[idx])
                session, skipped = result.session, result.skipped
                if skipped > 0:
                    total = len(session.messages) + skipped
                    pct = skipped / total if total else 0
                    if pct > _CORRUPT_THRESHOLD:
                        print(f"Warning: session {session_name} has {skipped}/{total} invalid lines ({pct:.0%} corrupt)")
                        backup = files[idx] + ".corrupt"
                        try:
                            os.replace(files[idx], backup)
                            print(f"Renamed to {session_name}.jsonl.corrupt")
                        except OSError:
                            try:
                                os.remove(files[idx])
                                print(f"Removed corrupt session file {session_name}.jsonl")
                            except OSError:
                                print(f"Warning: corrupt session {session_name} could not be removed")
                        return None
                    else:
                        print(f"Warning: {skipped} invalid line(s) skipped in session {session_name}")
                return session
            except ValueError as e:
                # Totally corrupt — no valid messages at all
                backup = files[idx] + ".corrupt"
                print(f"Warning: session {session_name} was corrupt ({e})")
                try:
                    os.replace(files[idx], backup)
                    print(f"Renamed to {session_name}.jsonl.corrupt")
                except OSError:
                    try:
                        os.remove(files[idx])
                        print(f"Removed corrupt session file {session_name}.jsonl")
                    except OSError:
                        print(f"Warning: corrupt session {session_name} could not be removed")
                return None
            except OSError as e:
                print(f"Error reading session {session_name}: {e}")
                return None
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
    try:
        result = Session.from_jsonl(path)
        session, skipped = result.session, result.skipped
        if skipped > 0:
            total = len(session.messages) + skipped
            pct = skipped / total if total else 0
            if pct > _CORRUPT_THRESHOLD:
                print(f"Warning: session {session_id} has {skipped}/{total} invalid lines ({pct:.0%} corrupt)")
                backup = path + ".corrupt"
                try:
                    os.replace(path, backup)
                    print(f"Renamed to {session_id}.jsonl.corrupt")
                except OSError:
                    try:
                        os.remove(path)
                        print(f"Removed corrupt file {session_id}.jsonl")
                    except OSError:
                        print(f"Warning: corrupt file {session_id}.jsonl could not be removed, truncating instead")
                        try:
                            with open(path, "w", encoding="utf-8"):
                                pass
                        except OSError:
                            print(f"Warning: could not truncate {session_id}.jsonl either")
                return None
            else:
                print(f"Warning: {skipped} invalid line(s) skipped in session {session_id}")
        return session
    except ValueError as e:
        # Corrupt data: json.JSONDecodeError, UnicodeDecodeError, or invalid message format
        backup = path + ".corrupt"
        try:
            os.replace(path, backup)
            print(f"Warning: session file {session_id}.jsonl was corrupt ({e}), renamed to {os.path.basename(backup)}")
        except OSError as rename_err:
            # os.replace failed (e.g. file lock) — try os.remove as fallback to break the loop
            print(f"Error: session {session_id} was corrupt and could not be backed up: {rename_err}")
            try:
                os.remove(path)
                print(f"Removed corrupt file {session_id}.jsonl to prevent repeated failures.")
            except OSError:
                # Both rename and remove failed — truncate the file so auto_save
                # doesn't append valid messages after corrupt data, which would
                # cause them to be lost on the next load.
                print(f"Warning: corrupt file {session_id}.jsonl could not be removed, truncating instead")
                try:
                    with open(path, "w", encoding="utf-8"):
                        pass
                except OSError:
                    print(f"Warning: could not truncate {session_id}.jsonl either")
        return None
    except OSError as e:
        # Transient I/O error (file lock, permission) — do NOT rename, just report
        print(f"Error reading session {session_id}.jsonl: {e}")
        return None


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
    parser.add_argument("--stream", "-s", action="store_true", help="Stream LLM responses token-by-token")
    parser.add_argument("--append-system-prompt", help="Additional text to append to the system prompt")
    parser.add_argument("--fallback-model", help="Fallback model to use if primary model fails with 429/503")
    parser.add_argument("--output-format", choices=["text", "json", "stream-json"], default="text", help="Output format (default: text)")
    parser.add_argument("--bare", action="store_true", help="Bare mode: skip memory loading, use minimal system prompt")
    parser.add_argument("--effort", choices=["low", "medium", "high"], default="medium", help="Effort level: low, medium (default), high")
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
        print_banner()

    # Load configuration
    config = {}
    if args.config:
        config = _load_config(args.config)
    elif os.path.exists(".mimo/config.json"):
        config = _load_config(".mimo/config.json")

    harness = MiMoHarness(
        model=args.model or config.get("model"),
        auto_approve=args.auto_approve or config.get("auto_approve", False),
        dry_run=args.dry_run or config.get("dry_run", False),
        max_steps=args.max_steps if args.max_steps is not None else config.get("max_steps", 20),
        verbose=args.verbose,
        log_file=args.log_file or config.get("log_file"),
        plan_mode=args.plan or config.get("plan_mode", False),
        stream=args.stream or config.get("stream", False),
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
        result = harness.run(task)
        duration = time.time() - start_time
        # Retrieve session info for structured output
        last_session = getattr(harness, '_last_session', None)
        last_steps = getattr(harness, '_last_steps', 0)
        _output(result, args.output_format, session=last_session, steps=last_steps, duration=duration)
        return

    # Interactive REPL mode
    print(f"Model: {harness.model}")
    if MIMO_API_KEY:
        print(f"API Key: {'*' * 12}")
    mode_str = 'plan' if args.plan else 'dry-run' if args.dry_run else 'auto-approve' if args.auto_approve else 'interactive'
    print(f"Mode: {mode_str}")
    print("Type /help for commands, or just start chatting.\n")

    import secrets

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
        print(f"Resumed session: {session.session_id} ({len(session.messages)} messages)")

    memory_store = MemoryStore(".")
    checkpoint_manager = CheckpointManager(session.session_id)
    harness._checkpoint_manager = checkpoint_manager

    # Config hot-reload watcher
    config_path = args.config or ".mimo/config.json"
    config_watcher = ConfigWatcher(config_path)

    # Initialize scheduler for session-scoped cron jobs
    from .tools.scheduler_tools import Scheduler, set_scheduler
    _scheduled_prompts = []
    def _on_scheduled_prompt(prompt):
        _scheduled_prompts.append(prompt)
        print(f"\n[Scheduled] {prompt[:60]}...")
    scheduler = Scheduler(callback=_on_scheduled_prompt)
    set_scheduler(scheduler)
    scheduler.start_background_checker(interval=30.0)

    while True:
        # Show token count in prompt
        tokens = estimate_tokens(session.messages)
        token_str = _format_tokens(tokens)
        max_str = _format_tokens(CONTEXT_WINDOW_TOKENS)
        try:
            user_input = input(f"You [{token_str}/{max_str}]: ").strip()
        except (EOFError, KeyboardInterrupt):
            try:
                session.save_meta_to_jsonl()
            except OSError:
                pass
            scheduler.stop()
            print("\nBye!")
            break

        if not user_input:
            # Check for scheduled prompts even when user provides no input
            if _scheduled_prompts:
                scheduled = _scheduled_prompts.pop(0)
                print(f"[Executing scheduled prompt]")
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
            print("[Config reloaded]")

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
                print("[blocked by permission system]")
                continue
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
                    print(f"[exit code: {result.returncode}]")
            except subprocess.TimeoutExpired:
                print("[command timed out after 30s]")
            except Exception as e:
                print(f"[error: {e}]")
            continue

        # Run agent with graceful interrupt support
        try:
            if harness.stream:
                # When streaming, tokens are printed directly by the agent
                harness.run(user_input, session)
            else:
                harness.run(user_input, session)
        except KeyboardInterrupt:
            # Graceful abort: stop current task but don't exit REPL
            harness.graceful_abort.request()
            print("\n[Interrupted — stopping current task...]")
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
        print("Bye!")
        return "quit", session
    elif cmd[0] == "/help":
        print_help()
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
        print("Session cleared.")
    elif cmd[0] == "/tools":
        print("\nAvailable tools:")
        for name in harness.registry.list_names():
            tool = harness.registry.get(name)
            markers = []
            if tool.is_read_only:
                markers.append("RO")
            if tool.is_concurrency_safe:
                markers.append("CS")
            if tool.is_destructive:
                markers.append("DST")
            marker_str = f" [{', '.join(markers)}]" if markers else ""
            print(f"  - {name}: {tool.description[:50]}...{marker_str}")
        print()
    elif cmd[0] == "/dry-run":
        harness.perms.dry_run = not harness.perms.dry_run
        print(f"Dry-run: {'ON' if harness.perms.dry_run else 'OFF'}")
    elif cmd[0] == "/auto":
        harness.perms.auto_approve = not harness.perms.auto_approve
        print(f"Auto-approve: {'ON' if harness.perms.auto_approve else 'OFF'}")
    elif cmd[0] == "/plan":
        from .permissions import PermissionMode
        if harness.perms.mode.value == "plan":
            harness.perms.mode = PermissionMode.DEFAULT
            print("Plan mode: OFF")
        else:
            harness.perms.mode = PermissionMode.PLAN
            print("Plan mode: ON (read-only)")
    elif cmd[0] == "/abort":
        harness.graceful_abort.request()
        print("Abort requested — current task will stop at next step boundary.")
    elif cmd[0] == "/memory":
        memories = memory_store.list_memories()
        if memories:
            print(f"\nStored memories ({len(memories)}):")
            for m in memories:
                print(f"  [{m.memory_type.value}] {m.name}: {m.description[:60]}")
        else:
            print("No memories stored.")
        print()
    elif cmd[0] == "/remember":
        print("Enter memory content (empty line to finish):")
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
            print("Memory saved.")
    elif cmd[0] == "/hooks":
        hook_runner = getattr(harness, '_hook_runner', None)
        if hook_runner:
            total = sum(len(v) for v in hook_runner._hooks.values())
            print(f"\nRegistered hooks: {total}")
            for event, hooks in hook_runner._hooks.items():
                for h in hooks:
                    print(f"  [{event.value}] {h.matcher} -> {h.command[:50]}")
        else:
            print("No hooks registered.")
        print()
    elif cmd[0] == "/stats":
        tokens = estimate_tokens(session.messages)
        print(f"\nSession Statistics:")
        print(f"  Messages: {len(session.messages)}")
        print(f"  Tokens: {_format_tokens(tokens)} / {_format_tokens(CONTEXT_WINDOW_TOKENS)}")
        print(f"  Compactions: {session.compaction_count}")
        print(f"  Approval log: {len(harness.perms.approval_log)} entries")
        if harness.circuit_breaker.consecutive_failures > 0:
            print(f"  Circuit breaker failures: {harness.circuit_breaker.consecutive_failures}")
        print()
    elif cmd[0] == "/tokens":
        tokens = estimate_tokens(session.messages)
        pct = tokens / CONTEXT_WINDOW_TOKENS * 100
        print(f"\nToken Usage:")
        print(f"  Conversation: {_format_tokens(tokens)} / {_format_tokens(CONTEXT_WINDOW_TOKENS)} ({pct:.1f}%)")
        print(f"  Messages: {len(session.messages)}")
        print(f"  Compactions: {session.compaction_count}")
        # Progress bar
        bar_len = 40
        filled = int(bar_len * tokens / CONTEXT_WINDOW_TOKENS)
        bar = '#' * min(filled, bar_len) + '-' * max(0, bar_len - filled)
        print(f"  [{bar}] {pct:.1f}%")
        print()
    elif cmd[0] == "/compact":
        tokens_before = estimate_tokens(session.messages)
        if tokens_before < 1000:
            print("Not enough messages to compress.")
        else:
            print(f"Compressing... ({_format_tokens(tokens_before)} tokens)")
            from .config import MIMO_BASE_URL, require_api_key
            try:
                api_key = require_api_key()
                from openai import OpenAI
                client = OpenAI(api_key=api_key, base_url=MIMO_BASE_URL)
                compacted, _, _, _ = compact_context(
                    session.messages,
                    client=client,
                    model=harness.model,
                    estimated_tokens=tokens_before,
                )
                session.messages = compacted
                session.compaction_count += 1
                tokens_after = estimate_tokens(session.messages)
                print(f"Done: {_format_tokens(tokens_before)} -> {_format_tokens(tokens_after)} tokens")
            except Exception as e:
                # Fallback: no LLM, just truncation
                compacted, _, _, _ = compact_context(
                    session.messages,
                    estimated_tokens=tokens_before,
                )
                session.messages = compacted
                session.compaction_count += 1
                tokens_after = estimate_tokens(session.messages)
                print(f"Done (truncation): {_format_tokens(tokens_before)} -> {_format_tokens(tokens_after)} tokens")
        print()
    elif cmd[0] == "/context":
        # C9: Per-message token breakdown
        if not session.messages:
            print("No messages in session.")
        else:
            print(f"\nContext breakdown ({len(session.messages)} messages):")
            print(f"{'#':<4} {'Role':<12} {'Tokens':>8}  Content preview")
            print("-" * 70)
            total_tokens = 0
            msg_tokens = []
            for i, msg in enumerate(session.messages):
                role = msg.get("role", "?")
                tokens = _estimate_message_tokens(msg)
                total_tokens += tokens
                content = msg.get("content", "")
                if not isinstance(content, str):
                    content = str(content) if content else ""
                preview = content[:50].replace("\n", " ")
                msg_tokens.append((i, role, tokens, preview))
            # Sort by token count descending to highlight heavy messages
            sorted_by_tokens = sorted(msg_tokens, key=lambda x: x[2], reverse=True)
            for i, role, tokens, preview in msg_tokens:
                marker = " <<" if tokens == sorted_by_tokens[0][2] and tokens > 100 else ""
                print(f"{i:<4} {role:<12} {_format_tokens(tokens):>8}  {preview}{marker}")
            print("-" * 70)
            print(f"{'Total':<16} {_format_tokens(total_tokens):>8}")
            # Highlight top consumers
            if sorted_by_tokens and sorted_by_tokens[0][2] > 100:
                top = sorted_by_tokens[0]
                print(f"\nLargest: msg #{top[0]} ({top[1]}) — {_format_tokens(top[2])} tokens")
            print()
    elif cmd[0] == "/init":
        from .project_scanner import scan_project, generate_agents_md
        agents_md_path = os.path.join(os.getcwd(), "AGENTS.md")
        if os.path.exists(agents_md_path):
            confirm = input(
                "AGENTS.md already exists. Overwrite? [y/N] "
            ).strip().lower()
            if confirm not in ("y", "yes"):
                print("Skipped.")
                return "continue", session
        print("Scanning project...")
        result = scan_project(".")
        content = generate_agents_md(result)
        with open(agents_md_path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"AGENTS.md generated at {agents_md_path}")
        print(f"  Language: {result.get('language', 'unknown')}")
        if result.get("frameworks"):
            print(f"  Frameworks: {', '.join(result['frameworks'])}")
        if result.get("test_runner"):
            print(f"  Test runner: {result['test_runner']}")
        print()
    elif cmd[0] == "/rewind":
        if checkpoint_manager:
            restored = checkpoint_manager.restore_last()
            if restored:
                print(f"Restored {len(restored)} file(s):")
                for p in restored:
                    print(f"  {p}")
            else:
                print("No checkpoint to restore.")
        else:
            print("No checkpoint manager available.")
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
                print(f"Warning: could not write fork session file: {e}")
        # Update checkpoint_manager to new session
        if checkpoint_manager:
            checkpoint_manager.checkpoint_dir = os.path.join(".mimo", "checkpoints", new_id)
            checkpoint_manager._seq = 0
            checkpoint_manager._batch_dir = None
        print(f"Session forked: {old_id} → {new_id}")
    elif cmd[0] == "/save" and len(cmd) > 1:
        try:
            session.save(cmd[1])
            print(f"Session saved to {cmd[1]}")
        except Exception as e:
            print(f"Error: {e}")
    elif cmd[0] == "/load" and len(cmd) > 1:
        try:
            # Save current session metadata before replacing
            try:
                session.save_meta_to_jsonl()
            except OSError:
                pass
            session = Session.load(cmd[1])
            session.auto_save_dir = session_dir
            # Update checkpoint_manager to loaded session
            if checkpoint_manager:
                checkpoint_manager.checkpoint_dir = os.path.join(".mimo", "checkpoints", session.session_id)
                checkpoint_manager._seq = 0
                checkpoint_manager._batch_dir = None
            print(f"Session loaded from {cmd[1]}")
        except Exception as e:
            print(f"Error: {e}")
    else:
        print(f"Unknown command: {cmd[0]}. Type /help for commands.")
    return "continue", session


if __name__ == "__main__":
    main()
