"""Shell execution tool - run commands with read-only auto-approval."""

import json
import re
import subprocess
import platform
from .registry import ToolDef
from ..permissions import Permission

# Commands that are safe to auto-approve (read-only)
READONLY_PREFIXES = [
    "ls", "dir", "cat", "type", "head", "tail", "wc", "echo", "pwd",
    "git status", "git log", "git diff", "git show", "git branch", "git remote",
    "which", "where", "whereis", "tree", "file", "du", "df",
    "python --version", "pip list", "pip show", "node --version", "npm list",
    "uname", "hostname", "whoami", "date",
]

# Patterns that indicate command chaining / injection
_CHAINING_PATTERN = re.compile(r'[;|&`$]|\$\(')


def _is_readonly(command: str) -> bool:
    cmd = command.strip()
    # Reject any command containing chaining operators
    if _CHAINING_PATTERN.search(cmd):
        return False
    cmd_lower = cmd.lower()
    return any(cmd_lower.startswith(p) for p in READONLY_PREFIXES)


def run_command(params: dict) -> str:
    command = params.get("command", "")
    timeout = params.get("timeout", 30)
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
        if len(output) > 8000:
            output = output[:8000] + "\n... [truncated]"
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
                    "timeout": {"type": "integer", "description": "Timeout in seconds (default 30)"},
                },
                "required": ["command"]
            },
            handler=run_command,
            permission=Permission.READ,  # dynamically checked
        ),
    ]
