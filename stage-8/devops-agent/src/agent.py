"""
DevOps Agent - Stage 8 deliverable
A production-ready agent for system health checks, log analysis, and deployment management.
Uses Xiaomi MiMo API (OpenAI-compatible format).

Features:
- Structured logging with trace IDs
- Error retry with exponential backoff
- Timeout and cost limits
- Permission boundaries with human confirmation
- CLI deployment
"""

import os, sys, json, time, logging, hashlib
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent.parent))
from config import MIMO_BASE_URL, MIMO_API_KEY, MIMO_MODEL
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, Callable
from datetime import datetime
from openai import OpenAI


class TraceLogger:
    def __init__(self, log_file: str = "logs/agent.log"):
        os.makedirs(os.path.dirname(log_file), exist_ok=True)
        self.logger = logging.getLogger("devops-agent")
        self.logger.setLevel(logging.DEBUG)
        if not self.logger.handlers:
            fh = logging.FileHandler(log_file, encoding="utf-8")
            fh.setLevel(logging.DEBUG)
            fh.setFormatter(logging.Formatter("%(asctime)s | %(levelname)s | %(message)s"))
            self.logger.addHandler(fh)
            ch = logging.StreamHandler()
            ch.setLevel(logging.INFO)
            ch.setFormatter(logging.Formatter("%(message)s"))
            self.logger.addHandler(ch)
        self.session_id = hashlib.md5(str(time.time()).encode()).hexdigest()[:8]
        self.step = 0

    def trace(self, event: str, data: dict = None):
        self.step += 1
        msg = f"[TRACE] session={self.session_id} step={self.step} event={event}"
        if data:
            msg += f" data={json.dumps(data)}"
        self.logger.debug(msg)

    def info(self, msg: str):
        self.logger.info(msg)

    def error(self, msg: str, exc: Exception = None):
        self.logger.error(f"[ERROR] {msg}", exc_info=exc)


@dataclass
class CostTracker:
    max_tool_calls: int = 30
    max_duration_seconds: float = 300.0
    tool_calls: int = 0
    start_time: float = field(default_factory=time.time)

    def record_tool_call(self):
        self.tool_calls += 1

    def check_limits(self) -> Optional[str]:
        if self.tool_calls > self.max_tool_calls:
            return f"Tool call limit exceeded ({self.tool_calls}/{self.max_tool_calls})"
        if time.time() - self.start_time > self.max_duration_seconds:
            return f"Time limit exceeded"
        return None

    def summary(self) -> dict:
        return {"tool_calls": self.tool_calls, "duration_seconds": round(time.time() - self.start_time, 2)}


class Permission(Enum):
    READ = "read"
    WRITE = "write"
    EXECUTE = "execute"
    DEPLOY = "deploy"
    DELETE = "delete"


class PermissionGate:
    AUTO_APPROVE = {Permission.READ}
    BLOCK = {Permission.DELETE}

    def __init__(self, dry_run: bool = False):
        self.dry_run = dry_run
        self.approval_log: list[dict] = []

    def check(self, permission: Permission, action_desc: str) -> bool:
        if permission in self.BLOCK:
            self._log(permission, action_desc, "blocked")
            return False
        if permission in self.AUTO_APPROVE:
            self._log(permission, action_desc, "auto_approved")
            return True
        if self.dry_run:
            self._log(permission, action_desc, "dry_run_skip")
            return False
        print(f"\n  [CONFIRM] Agent wants to: {action_desc}")
        print(f"  Permission required: {permission.value}")
        try:
            response = input("  Allow? (y/n): ").strip().lower()
        except EOFError:
            self._log(permission, action_desc, "denied_no_input")
            return False
        approved = response in ("y", "yes")
        self._log(permission, action_desc, "approved" if approved else "denied")
        return approved

    def _log(self, perm: Permission, desc: str, result: str):
        self.approval_log.append({"timestamp": datetime.now().isoformat(), "permission": perm.value, "action": desc, "result": result})


def retry_with_backoff(fn: Callable, max_retries: int = 3, base_delay: float = 1.0):
    """Retry with exponential backoff. Only retries transient errors (429, 5xx, network)."""
    last_error = None
    for attempt in range(max_retries):
        try:
            return fn()
        except Exception as e:
            last_error = e
            # Check if error is retryable
            status = getattr(e, "status_code", None)
            if status and status not in (429, 500, 502, 503, 504):
                raise  # Non-transient HTTP error (4xx except 429)
            if attempt < max_retries - 1:
                time.sleep(base_delay * (2 ** attempt))
    raise last_error


def create_tools(logger: TraceLogger, perms: PermissionGate) -> tuple:
    def check_system_health(params: dict) -> str:
        import platform
        return json.dumps({"hostname": platform.node(), "platform": platform.platform(), "python": platform.python_version(), "cpu_count": os.cpu_count(), "cwd": os.getcwd()})

    def read_log_file(params: dict) -> str:
        path = params.get("path", "")
        if not perms.check(Permission.READ, f"Read log file: {path}"):
            return json.dumps({"error": "Permission denied"})
        # Path traversal protection: restrict to CWD and subdirectories
        try:
            resolved = Path(path).resolve()
            cwd = Path.cwd().resolve()
            if not resolved.is_relative_to(cwd):
                return json.dumps({"error": "Access denied: path must be within current working directory"})
        except Exception:
            return json.dumps({"error": "Invalid path"})
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()[-100:]
            return json.dumps({"lines": len(lines), "content": "".join(lines)[:3000]})
        except Exception as e:
            return json.dumps({"error": str(e)})

    def list_services(params: dict) -> str:
        import subprocess, platform
        try:
            if platform.system() == "Windows":
                cmd = ["powershell", "-Command", "Get-Process | Select-Object -First 20 Name,CPU"]
            else:
                cmd = ["ps", "aux", "--sort=-%cpu"]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            return json.dumps({"output": result.stdout[:2000]})
        except Exception as e:
            return json.dumps({"error": str(e)})

    def deploy_service(params: dict) -> str:
        service = params.get("service", "")
        if not perms.check(Permission.DEPLOY, f"Deploy service: {service}"):
            return json.dumps({"error": "Deployment denied"})
        return json.dumps({"status": "deployed", "service": service, "timestamp": datetime.now().isoformat()})

    tools = [
        {"type": "function", "function": {"name": "check_system_health", "description": "Check system health: hostname, platform, CPU.", "parameters": {"type": "object", "properties": {}, "required": []}}},
        {"type": "function", "function": {"name": "read_log_file", "description": "Read the last 100 lines of a log file.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
        {"type": "function", "function": {"name": "list_services", "description": "List running system services/processes.", "parameters": {"type": "object", "properties": {}, "required": []}}},
        {"type": "function", "function": {"name": "deploy_service", "description": "Deploy a service (requires confirmation).", "parameters": {"type": "object", "properties": {"service": {"type": "string"}}, "required": ["service"]}}},
    ]
    handlers = {"check_system_health": check_system_health, "read_log_file": read_log_file, "list_services": list_services, "deploy_service": deploy_service}
    return tools, handlers


class DevOpsAgent:
    SYSTEM_PROMPT = "You are MiMo, a DevOps assistant developed by Xiaomi. Help with system health checks, log analysis, and service management. Always explain what you're doing. Ask for confirmation before write/deploy operations."

    def __init__(self, dry_run: bool = False):
        self.logger = TraceLogger()
        self.cost = CostTracker()
        self.perms = PermissionGate(dry_run=dry_run)
        self.tools, self.handlers = create_tools(self.logger, self.perms)

    def run(self, task: str, max_steps: int = 10) -> str:
        client = OpenAI(api_key=MIMO_API_KEY, base_url=MIMO_BASE_URL)
        self.logger.info(f"\n{'='*60}\nTask: {task}\nSession: {self.logger.session_id}\n{'='*60}")
        messages = [
            {"role": "system", "content": self.SYSTEM_PROMPT},
            {"role": "user", "content": task}
        ]

        for step in range(max_steps):
            limit_error = self.cost.check_limits()
            if limit_error:
                return f"[LIMIT] {limit_error}"

            self.logger.trace("llm_call_start", {"step": step + 1})

            try:
                response = retry_with_backoff(
                    lambda: client.chat.completions.create(
                        model=MIMO_MODEL,
                        messages=messages,
                        tools=self.tools,
                        tool_choice="auto",
                        max_completion_tokens=1024,
                        temperature=0.7,
                        top_p=0.9
                    )
                )
            except Exception as e:
                self.logger.error(f"LLM call failed: {e}")
                return f"[ERROR] LLM call failed: {e}"

            choice = response.choices[0]
            message = choice.message

            if not message.tool_calls:
                final = message.content or "[No response]"
                self.logger.info(f"\nAgent: {final}")
                self.logger.trace("session_complete", self.cost.summary())
                return final

            msg_dump = message.model_dump()
            if msg_dump.get("content") is None:
                msg_dump["content"] = ""
            messages.append(msg_dump)
            for tc in message.tool_calls:
                func_name = tc.function.name
                func_args = json.loads(tc.function.arguments)
                self.logger.trace("tool_call", {"name": func_name, "input": func_args})
                self.cost.record_tool_call()

                handler = self.handlers.get(func_name)
                if handler:
                    try:
                        result = handler(func_args)
                    except Exception as e:
                        result = json.dumps({"error": str(e)})
                        self.logger.error(f"Tool {func_name} failed", e)
                else:
                    result = json.dumps({"error": f"Unknown tool: {func_name}"})

                messages.append({"role": "tool", "tool_call_id": tc.id, "content": result})

        return "[ERROR] Max steps reached."


def main():
    import argparse
    parser = argparse.ArgumentParser(description="DevOps Agent (MiMo)")
    parser.add_argument("--task", "-t", help="Task description")
    parser.add_argument("--dry-run", action="store_true", help="Dry run mode")
    args = parser.parse_args()

    agent = DevOpsAgent(dry_run=args.dry_run)

    if args.task:
        print(agent.run(args.task))
    else:
        print("=== DevOps Agent (MiMo) ===")
        print(f"API Key: ***configured***")
        print("Type a task (or 'quit' to exit):\n")
        while True:
            task = input("Task: ").strip()
            if task.lower() in ("quit", "exit", "q"):
                break
            if not task:
                continue
            agent.run(task)


if __name__ == "__main__":
    main()
