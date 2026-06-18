"""Shell execution tool - run commands with read-only auto-approval.

Ch3 markers:
- run_command: write (NOT read-only), NOT concurrency-safe
- Dynamic permission: readonly commands auto-detected
"""

import json
import os
import re
import subprocess
import platform
import threading
import uuid
from .registry import ToolDef
from ..permissions import Permission

# Background job tracking
_background_jobs: dict[str, dict] = {}
_background_jobs_lock = threading.Lock()
MAX_BACKGROUND_JOBS = 20
_MAX_COMPLETED_JOBS = 50  # cap completed jobs to prevent memory leak


def _cleanup_completed_jobs():
    """Remove oldest completed/errored jobs when exceeding cap."""
    completed = [
        (jid, j) for jid, j in _background_jobs.items()
        if j["status"] != "running"
    ]
    if len(completed) > _MAX_COMPLETED_JOBS:
        # Remove oldest completed jobs (insertion order in Python 3.7+)
        to_remove = [jid for jid, _ in completed[:len(completed) - _MAX_COMPLETED_JOBS]]
        for jid in to_remove:
            del _background_jobs[jid]

# S5+S20: Configurable output length limit via env var
try:
    MAX_OUTPUT_LENGTH = int(os.environ.get("MIMO_MAX_OUTPUT_LENGTH", "50000"))
except (ValueError, TypeError):
    MAX_OUTPUT_LENGTH = 50000

# S19: Commands that are safe to auto-approve (read-only) — extended
READONLY_PREFIXES = [
    "ls", "dir", "cat", "type", "head", "tail", "wc", "echo", "pwd",
    "git status", "git log", "git diff", "git show", "git branch", "git remote",
    "which", "where", "whereis", "tree", "file", "du", "df",
    "python --version", "pip list", "pip show", "node --version", "npm list",
    "uname", "hostname", "whoami", "date",
    # S19: extended readonly prefixes
    "grep", "stat", "printenv", "realpath", "readlink",
    "basename", "dirname", "sort", "uniq", "cut", "tr",
]

# S8: Wrapper prefixes that should be stripped before readonly detection
_WRAPPER_PREFIXES = ["timeout", "time", "nice", "nohup", "stdbuf"]

# Patterns that indicate command injection (Ch4: security) - backticks and $()
# C1/C3: also reject shell redirections (>, >>, <, <<, <<<) to prevent readonly-bypass attacks
_CHAINING_PATTERN = re.compile(r'[`><]|\$\(|<<')

# S3: Credential patterns to scrub from environment (M6: extended)
_CREDENTIAL_PATTERNS = [
    "API_KEY", "SECRET", "TOKEN", "PASSWORD", "CREDENTIAL", "AUTH",
    "PRIVATE_KEY", "PASSPHRASE", "SIGNING_KEY", "ENCRYPTION_KEY",
    "DATABASE_URL", "CONNECTION_STRING", "DSN",
]


def _split_compound_command(command: str) -> list[str]:
    """S2: Split a compound command on &&, ||, ;, |, |& while respecting quotes."""
    parts = []
    current = []
    i = 0
    in_single = False
    in_double = False
    while i < len(command):
        ch = command[i]
        # Track quote state
        if ch == "'" and not in_double:
            in_single = not in_single
            current.append(ch)
            i += 1
        elif ch == '"' and not in_single:
            in_double = not in_double
            current.append(ch)
            i += 1
        elif ch == '\\' and in_double:
            # H1: handle backslash escapes inside double quotes
            current.append(ch)
            i += 1
            if i < len(command):
                current.append(command[i])
                i += 1
        elif in_single or in_double:
            current.append(ch)
            i += 1
        else:
            # Check for splitting operators (longest first)
            if command[i:i+2] == "&&":
                parts.append("".join(current).strip())
                current = []
                i += 2
            elif command[i:i+2] == "||":
                parts.append("".join(current).strip())
                current = []
                i += 2
            elif command[i:i+2] == "|&":
                parts.append("".join(current).strip())
                current = []
                i += 2
            elif ch == ";":
                parts.append("".join(current).strip())
                current = []
                i += 1
            elif ch == "|":
                parts.append("".join(current).strip())
                current = []
                i += 1
            elif ch == "\n":
                # Newline acts as command separator (like ;)
                parts.append("".join(current).strip())
                current = []
                i += 1
            else:
                current.append(ch)
                i += 1
    remainder = "".join(current).strip()
    if remainder:
        parts.append(remainder)
    return [p for p in parts if p]


def _scrub_env() -> dict:
    """S3: Copy os.environ and remove keys matching credential patterns."""
    env = dict(os.environ)
    keys_to_remove = []
    for key in env:
        key_upper = key.upper()
        for pattern in _CREDENTIAL_PATTERNS:
            if pattern in key_upper:
                keys_to_remove.append(key)
                break
    for key in keys_to_remove:
        del env[key]
    return env


def _strip_wrappers(command: str) -> str:
    """S8: Remove known process wrapper prefixes and their arguments."""
    cmd = command.strip()
    changed = True
    depth = 0
    MAX_DEPTH = 5  # H4: prevent runaway loops
    while changed and depth < MAX_DEPTH:
        changed = False
        depth += 1
        for prefix in _WRAPPER_PREFIXES:
            if cmd.lower().startswith(prefix + " "):
                # Remove the wrapper name, then skip its arguments
                rest = cmd[len(prefix):].lstrip()
                # Skip numeric/flag arguments that belong to the wrapper
                parts = rest.split(None, 1)
                if len(parts) == 2:
                    arg, remainder = parts
                    # Skip numeric args (e.g. timeout 30) or flag args (e.g. nice -n 10)
                    if arg.lstrip("-").isdigit() or arg.startswith("-"):
                        # For flags like "-n 10", consume the next token too
                        if arg == "-n" and remainder:
                            sub_parts = remainder.split(None, 1)
                            if len(sub_parts) == 2 and sub_parts[0].lstrip("-").isdigit():
                                cmd = sub_parts[1]
                                changed = True
                                continue
                        cmd = remainder
                        changed = True
                        continue
                # No more arguments or just the wrapper command
                if len(parts) == 1:
                    cmd = parts[0]
                    changed = True
                    continue
                cmd = rest
                changed = True
    return cmd


def _is_readonly(command: str) -> bool:
    cmd = command.strip()
    # Ch4: reject any command containing backticks or $() (injection)
    if _CHAINING_PATTERN.search(cmd):
        return False
    # S2: split compound commands and check that ALL subcommands are readonly
    subcommands = _split_compound_command(cmd)
    if len(subcommands) > 1:
        return all(_is_readonly_single(sub) for sub in subcommands)
    # Single command — delegate to _is_readonly_single for find/awk handling
    return _is_readonly_single(cmd)


def _is_readonly_single(command: str) -> bool:
    """S2: Check if a single (non-compound) command is readonly."""
    cmd = command.strip()
    # S8: strip wrapper prefixes before checking readonly
    cmd = _strip_wrappers(cmd)
    cmd_lower = cmd.lower()
    # find with -exec/-ok/-delete is not readonly (can run arbitrary/delete commands)
    # Use lookbehind to require dash not preceded by word char (prevents matching
    # inside filenames like "my-delete-file" while still catching "find . -delete")
    if cmd_lower.startswith("find ") and re.search(r'(?<![a-zA-Z0-9_])-exec\b|(?<![a-zA-Z0-9_])-execdir\b|(?<![a-zA-Z0-9_])-ok\b|(?<![a-zA-Z0-9_])-okdir\b|(?<![a-zA-Z0-9_])-delete\b', cmd_lower):
        return False
    # awk with system()/getline from pipe is not readonly
    if cmd_lower.startswith("awk ") and re.search(r'\bsystem\s*\(', cmd_lower):
        return False
    # Special-case: allow find and awk as readonly when safe
    if cmd_lower.startswith("find ") or cmd_lower.startswith("awk "):
        return True
    return any(cmd_lower.startswith(p) for p in READONLY_PREFIXES)


def _spill_output(output: str) -> str:
    """S5+S20: Save oversized output to disk, return a preview with file path."""
    try:
        outputs_dir = os.environ.get("MIMO_SPILL_DIR", os.path.join(".mimo", "outputs"))
        os.makedirs(outputs_dir, exist_ok=True)
        fname = f"{uuid.uuid4().hex}.txt"
        fpath = os.path.join(outputs_dir, fname)
        with open(fpath, "w", encoding="utf-8") as f:
            f.write(output)
        preview = output[:1000] + "\n... [truncated] ...\n" + output[-1000:]
        return preview + f"\n\n[Full output saved to: {os.path.abspath(fpath)}]"
    except Exception:
        # Fallback to simple truncation if file write fails
        return output[:MAX_OUTPUT_LENGTH] + "\n... [truncated]"


def run_command(params: dict) -> str:
    command = params.get("command", "")
    timeout = params.get("timeout", 120)
    run_in_background = params.get("run_in_background", False)

    if run_in_background:
        with _background_jobs_lock:
            # Cap background jobs to prevent resource exhaustion
            running = sum(1 for j in _background_jobs.values() if j["status"] == "running")
            if running >= MAX_BACKGROUND_JOBS:
                return json.dumps({
                    "error": f"Maximum background jobs ({MAX_BACKGROUND_JOBS}) reached. Wait for existing jobs to complete.",
                    "running_jobs": running,
                })
            job_id = str(uuid.uuid4())[:8]
            _background_jobs[job_id] = {
                "command": command,
                "status": "running",
                "output": "",
                "exit_code": None,
            }
        def _run_bg():
            try:
                scrubbed_env = _scrub_env()
                result = subprocess.run(
                    command, shell=True, capture_output=True, text=True,
                    timeout=timeout, encoding="utf-8", errors="replace",
                    env=scrubbed_env
                )
                output = (result.stdout + result.stderr).strip()
                if len(output) > MAX_OUTPUT_LENGTH:
                    output = _spill_output(output)
                with _background_jobs_lock:
                    _background_jobs[job_id]["output"] = output
                    _background_jobs[job_id]["exit_code"] = result.returncode
                    _background_jobs[job_id]["status"] = "completed"
                    _cleanup_completed_jobs()
            except subprocess.TimeoutExpired:
                with _background_jobs_lock:
                    _background_jobs[job_id]["status"] = "timeout"
                    _background_jobs[job_id]["output"] = f"Command timed out after {timeout}s"
                    _cleanup_completed_jobs()
            except Exception as e:
                with _background_jobs_lock:
                    _background_jobs[job_id]["status"] = "error"
                    _background_jobs[job_id]["output"] = str(e)
                    _cleanup_completed_jobs()
        thread = threading.Thread(target=_run_bg, daemon=True)
        thread.start()
        return json.dumps({
            "command": command,
            "job_id": job_id,
            "status": "started",
            "message": f"Command started in background with job_id: {job_id}",
        })

    try:
        scrubbed_env = _scrub_env()
        result = subprocess.run(
            command, shell=True, capture_output=True, text=True,
            timeout=timeout, encoding="utf-8", errors="replace",
            env=scrubbed_env
        )
        output = (result.stdout + result.stderr).strip()
        if len(output) > MAX_OUTPUT_LENGTH:
            output = _spill_output(output)
        return json.dumps({
            "command": command,
            "exit_code": result.returncode,
            "output": output,
        })
    except subprocess.TimeoutExpired:
        return json.dumps({"command": command, "error": f"Command timed out after {timeout}s"})
    except Exception as e:
        return json.dumps({"command": command, "error": str(e)})


def get_tools() -> list[ToolDef]:
    if platform.system() == "Windows":
        shell_desc = (
            "Execute a shell command via cmd.exe on Windows. "
            "Read-only commands (dir, git status, echo, etc.) are auto-approved. "
            "Write commands require confirmation. "
            "Note: Use Windows-native commands (dir, type, copy, mkdir, rmdir). "
            "Unix commands like 'mkdir -p' will be auto-translated where possible."
        )
    else:
        shell_desc = (
            "Execute a shell command. "
            "Read-only commands (ls, git status, etc.) are auto-approved. "
            "Write commands require confirmation."
        )
    return [
        ToolDef(
            name="run_command",
            description=shell_desc,
            parameters={
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Shell command to execute"},
                    "timeout": {"type": "integer", "description": "Timeout in seconds (default 120)"},
                    "run_in_background": {"type": "boolean", "description": "Run command in background and return immediately with a job ID (default false)"},
                },
                "required": ["command"]
            },
            handler=run_command,
            permission=Permission.READ,  # dynamically checked
            is_read_only=False,  # conservatively false (Ch3: fail-closed)
            is_concurrency_safe=False,  # shell commands may have side effects
        ),
    ]
