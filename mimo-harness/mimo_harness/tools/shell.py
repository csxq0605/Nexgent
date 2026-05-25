"""Shell execution tool - run commands with read-only auto-approval.

Ch3 markers:
- run_command: write (NOT read-only), NOT concurrency-safe
- Dynamic permission: readonly commands auto-detected
"""

import json
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

# Commands that are safe to auto-approve (read-only)
READONLY_PREFIXES = [
    "ls", "dir", "cat", "type", "head", "tail", "wc", "echo", "pwd",
    "git status", "git log", "git diff", "git show", "git branch", "git remote",
    "which", "where", "whereis", "tree", "file", "du", "df",
    "python --version", "pip list", "pip show", "node --version", "npm list",
    "uname", "hostname", "whoami", "date",
]

# Patterns that indicate command chaining / injection (Ch4: security)
_CHAINING_PATTERN = re.compile(r'[;|&`$]|\$\(')


def _is_readonly(command: str) -> bool:
    cmd = command.strip()
    # Ch4: reject any command containing chaining operators
    if _CHAINING_PATTERN.search(cmd):
        return False
    cmd_lower = cmd.lower()
    return any(cmd_lower.startswith(p) for p in READONLY_PREFIXES)


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
                if platform.system() == "Windows":
                    result = subprocess.run(
                        command, shell=True, capture_output=True, text=True,
                        timeout=timeout, encoding="utf-8", errors="replace"
                    )
                else:
                    result = subprocess.run(
                        command, shell=True, capture_output=True, text=True,
                        timeout=timeout
                    )
                output = (result.stdout + result.stderr).strip()
                if len(output) > 30000:
                    output = output[:30000] + "\n... [truncated]"
                with _background_jobs_lock:
                    _background_jobs[job_id]["output"] = output
                    _background_jobs[job_id]["exit_code"] = result.returncode
                    _background_jobs[job_id]["status"] = "completed"
            except subprocess.TimeoutExpired:
                with _background_jobs_lock:
                    _background_jobs[job_id]["status"] = "timeout"
                    _background_jobs[job_id]["output"] = f"Command timed out after {timeout}s"
            except Exception as e:
                with _background_jobs_lock:
                    _background_jobs[job_id]["status"] = "error"
                    _background_jobs[job_id]["output"] = str(e)
        thread = threading.Thread(target=_run_bg, daemon=True)
        thread.start()
        return json.dumps({
            "command": command,
            "job_id": job_id,
            "status": "started",
            "message": f"Command started in background with job_id: {job_id}",
        })

    try:
        if platform.system() == "Windows":
            result = subprocess.run(
                command, shell=True, capture_output=True, text=True,
                timeout=timeout, encoding="utf-8", errors="replace"
            )
        else:
            result = subprocess.run(
                command, shell=True, capture_output=True, text=True,
                timeout=timeout
            )
        output = (result.stdout + result.stderr).strip()
        if len(output) > 30000:
            output = output[:30000] + "\n... [truncated]"
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
    return [
        ToolDef(
            name="run_command",
            description="Execute a shell command. Read-only commands (ls, git status, etc.) are auto-approved. Write commands require confirmation.",
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
