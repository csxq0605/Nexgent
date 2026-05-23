"""CLI entry point - interactive REPL and single-shot modes."""

import sys
import argparse
import hashlib
import time
from .agent import MiMoHarness
from .config import MIMO_API_KEY, MIMO_MODEL

# Fix Windows console encoding for Unicode output
if sys.stdout.encoding and sys.stdout.encoding.lower().replace("-", "") != "utf8":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def print_banner():
    print("""
╔══════════════════════════════════════════╗
║          MiMo Harness v0.1.0            ║
║  AI Agent powered by Xiaomi MiMo model  ║
╚══════════════════════════════════════════╝
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

Or just type a task to interact with the agent.
""")

def main():
    parser = argparse.ArgumentParser(
        description="MiMo Harness - AI Agent powered by Xiaomi MiMo model"
    )
    parser.add_argument("--task", "-t", help="Run a single task and exit")
    parser.add_argument("--model", "-m", default=None, help=f"Model name (default: {MIMO_MODEL})")
    parser.add_argument("--auto-approve", "-y", action="store_true", help="Auto-approve all write operations")
    parser.add_argument("--dry-run", action="store_true", help="Dry-run mode (show but don't execute)")
    parser.add_argument("--max-steps", type=int, default=20, help="Max agent steps (default: 20)")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output with trace logs")
    parser.add_argument("--log-file", help="Log file path")
    args = parser.parse_args()

    print_banner()

    harness = MiMoHarness(
        model=args.model,
        auto_approve=args.auto_approve,
        dry_run=args.dry_run,
        max_steps=args.max_steps,
        verbose=args.verbose,
        log_file=args.log_file,
    )

    if args.task:
        result = harness.run(args.task)
        print(result)
        return

    # Interactive REPL mode
    print(f"Model: {harness.model}")
    print(f"API Key: {MIMO_API_KEY[:12]}...")
    print(f"Mode: {'dry-run' if args.dry_run else 'auto-approve' if args.auto_approve else 'interactive'}")
    print("Type /help for commands, or just start chatting.\n")

    from .context import Session
    session = Session(
        session_id=hashlib.md5(str(time.time()).encode()).hexdigest()[:8],
    )

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
            cmd = user_input.lower().split()
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
                    print(f"  - {name}: {tool.description[:60]}...")
                print()
            elif cmd[0] == "/dry-run":
                harness.perms.dry_run = not harness.perms.dry_run
                print(f"Dry-run: {'ON' if harness.perms.dry_run else 'OFF'}")
            elif cmd[0] == "/auto":
                harness.perms.auto_approve = not harness.perms.auto_approve
                print(f"Auto-approve: {'ON' if harness.perms.auto_approve else 'OFF'}")
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

        # Run agent (result is printed by the logger during run())
        harness.run(user_input, session)

if __name__ == "__main__":
    main()
