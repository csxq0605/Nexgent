"""CLI entry point - interactive REPL and single-shot modes.

Enhanced with:
- Plan mode (read-only operations)
- Hook loading from config
- Memory management commands
- Permission rules loading
"""

import argparse
import os
import json
from .agent import MiMoHarness
from .config import MIMO_API_KEY, MIMO_MODEL
from .permissions import PermissionRule


def print_banner():
    print("""
+------------------------------------------+
|          MiMo Harness v0.2.0             |
|  AI Agent powered by Xiaomi MiMo model  |
|  Claude Code architecture patterns       |
+------------------------------------------+
""")


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
  /memory        List stored memories
  /remember      Save current context as memory
  /hooks         List registered hooks
  /stats         Show session statistics
  /init          Scan project and generate AGENTS.md

Or just type a task to interact with the agent.
""")


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


def main():
    parser = argparse.ArgumentParser(
        description="MiMo Harness - AI Agent powered by Xiaomi MiMo model"
    )
    parser.add_argument("--task", "-t", help="Run a single task and exit")
    parser.add_argument("--model", "-m", default=None, help=f"Model name (default: {MIMO_MODEL})")
    parser.add_argument("--auto-approve", "-y", action="store_true", help="Auto-approve all write operations")
    parser.add_argument("--dry-run", action="store_true", help="Dry-run mode (show but don't execute)")
    parser.add_argument("--plan", action="store_true", help="Plan mode (read-only operations only)")
    parser.add_argument("--max-steps", type=int, default=20, help="Max agent steps (default: 20)")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output with trace logs")
    parser.add_argument("--log-file", help="Log file path")
    parser.add_argument("--config", "-c", help="Configuration file path")
    parser.add_argument("--rules", "-r", help="Permission rules file path")
    args = parser.parse_args()

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
        max_steps=args.max_steps if args.max_steps != 20 else config.get("max_steps", 20),
        verbose=args.verbose,
        log_file=args.log_file or config.get("log_file"),
        plan_mode=args.plan or config.get("plan_mode", False),
    )

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

    if args.task:
        result = harness.run(args.task)
        print(result)
        return

    # Interactive REPL mode
    print(f"Model: {harness.model}")
    if MIMO_API_KEY:
        print(f"API Key: {'*' * 8}...{MIMO_API_KEY[-4:]}")
    mode_str = 'plan' if args.plan else 'dry-run' if args.dry_run else 'auto-approve' if args.auto_approve else 'interactive'
    print(f"Mode: {mode_str}")
    print("Type /help for commands, or just start chatting.\n")

    from .context import Session
    from .memory import MemoryStore
    import secrets

    session = Session(
        session_id=secrets.token_hex(4),
    )
    memory_store = MemoryStore(".")

    while True:
        try:
            user_input = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nBye!")
            break

        if not user_input:
            continue

        # Handle commands
        if user_input.startswith("/"):
            parts = user_input.split()
            cmd = [parts[0].lower()] + parts[1:]
            if cmd[0] in ("/quit", "/exit", "/q"):
                print("Bye!")
                break
            elif cmd[0] == "/help":
                print_help()
            elif cmd[0] == "/clear":
                session.messages.clear()
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
                if harness.perms.mode.value == "plan":
                    from .permissions import PermissionMode
                    harness.perms.mode = PermissionMode.DEFAULT
                    print("Plan mode: OFF")
                else:
                    from .permissions import PermissionMode
                    harness.perms.mode = PermissionMode.PLAN
                    print("Plan mode: ON (read-only)")
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
                print(f"\nSession Statistics:")
                print(f"  Messages: {len(session.messages)}")
                print(f"  Compactions: {session.compaction_count}")
                print(f"  Approval log: {len(harness.perms.approval_log)} entries")
                if harness.circuit_breaker.consecutive_failures > 0:
                    print(f"  Circuit breaker failures: {harness.circuit_breaker.consecutive_failures}")
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
                        continue
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
            elif cmd[0] == "/save" and len(cmd) > 1:
                try:
                    session.save(cmd[1])
                    print(f"Session saved to {cmd[1]}")
                except Exception as e:
                    print(f"Error: {e}")
            elif cmd[0] == "/load" and len(cmd) > 1:
                try:
                    session = Session.load(cmd[1])
                    print(f"Session loaded from {cmd[1]}")
                except Exception as e:
                    print(f"Error: {e}")
            else:
                print(f"Unknown command: {cmd[0]}. Type /help for commands.")
            continue

        # Run agent
        harness.run(user_input, session)


if __name__ == "__main__":
    main()
