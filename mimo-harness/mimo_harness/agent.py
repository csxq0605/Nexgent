"""Core Agent - the observe-think-act loop with tool dispatch."""

import os
import json
import time
import hashlib
from openai import OpenAI

from .config import MIMO_BASE_URL, MIMO_API_KEY, MIMO_MODEL
from .logging_utils import TraceLogger
from .permissions import Permission, PermissionGate
from .context import Session, compact_context, load_memory
from .tools.registry import ToolRegistry, ToolDef
from .tools import file_ops, shell, code_exec, web_tools, doc_tools, math_tools


def retry_with_backoff(fn, max_retries: int = 3, base_delay: float = 1.0):
    last_error = None
    for attempt in range(max_retries):
        try:
            return fn()
        except Exception as e:
            last_error = e
            status = getattr(e, "status_code", None)
            if status and status not in (429, 500, 502, 503, 504):
                raise
            if attempt < max_retries - 1:
                time.sleep(base_delay * (2 ** attempt))
    raise last_error


class MiMoHarness:
    SYSTEM_PROMPT_TEMPLATE = """You are MiMo Harness, a capable AI assistant powered by Xiaomi MiMo model.
You help users with coding, file operations, web research, document creation, and system tasks.

## Rules
- Use absolute file paths
- Explain what you're about to do before using tools
- Be concise but thorough
- If a task is ambiguous, ask for clarification
- When writing code, verify it works by running it

## Environment
- Working directory: {cwd}
- Platform: {platform}
- Python: {python_version}

## Available Tools
{tools_desc}

{memory}"""

    def __init__(
        self,
        model: str = None,
        auto_approve: bool = False,
        dry_run: bool = False,
        max_steps: int = 20,
        max_duration: float = 300.0,
        verbose: bool = False,
        log_file: str = None,
    ):
        self.model = model or MIMO_MODEL
        self.max_steps = max_steps
        self.max_duration = max_duration
        self.logger = TraceLogger(log_file=log_file, verbose=verbose)
        self.perms = PermissionGate(auto_approve=auto_approve, dry_run=dry_run)
        self.registry = ToolRegistry()
        self._register_tools()

    def _register_tools(self):
        all_tools = (
            file_ops.get_tools()
            + shell.get_tools()
            + code_exec.get_tools()
            + web_tools.get_tools()
            + doc_tools.get_tools()
            + math_tools.get_tools()
        )
        self.registry.register_many(all_tools)

    def _build_system_prompt(self) -> str:
        import platform
        tools_desc = "\n".join(
            f"- **{t.name}**: {t.description}" for t in self.registry.list_all()
        )
        memory = load_memory(".")
        return self.SYSTEM_PROMPT_TEMPLATE.format(
            cwd=os.getcwd(),
            platform=f"{platform.system()} {platform.release()}",
            python_version=platform.python_version(),
            tools_desc=tools_desc,
            memory=f"\n## Project Memory\n{memory}" if memory else "",
        )

    def _check_shell_permission(self, command: str) -> Permission:
        """Dynamically determine shell command permission."""
        if shell._is_readonly(command):
            return Permission.READ
        return Permission.WRITE

    def run(self, task: str, session: Session = None) -> str:
        if session is None:
            session = Session(
                session_id=hashlib.md5(str(time.time()).encode()).hexdigest()[:8],
                working_dir=os.getcwd(),
            )

        client = OpenAI(api_key=MIMO_API_KEY, base_url=MIMO_BASE_URL)
        session.add_message("user", task)

        self.logger.info(f"\n{'='*60}")
        self.logger.info(f"Task: {task}")
        self.logger.info(f"Session: {self.logger.session_id}")
        self.logger.info(f"{'='*60}")

        start_time = time.time()
        tools_schema = self.registry.list_tools()
        system_msg = {"role": "system", "content": self._build_system_prompt()}

        for step in range(self.max_steps):
            # Check time limit
            if time.time() - start_time > self.max_duration:
                return "[LIMIT] Time limit exceeded"

            # Build messages
            messages = [system_msg] + compact_context(session.get_messages())

            self.logger.trace("llm_call_start", {"step": step + 1, "model": self.model})

            try:
                response = retry_with_backoff(
                    lambda: client.chat.completions.create(
                        model=self.model,
                        messages=messages,
                        tools=tools_schema,
                        tool_choice="auto",
                        max_completion_tokens=2048,
                        temperature=0.7,
                        top_p=0.9,
                    )
                )
            except Exception as e:
                self.logger.error(f"LLM call failed: {e}")
                return f"[ERROR] LLM call failed: {e}"

            choice = response.choices[0]
            message = choice.message

            # No tool calls -> final response
            if not message.tool_calls:
                final = message.content or "[No response]"
                session.add_message("assistant", final)
                self.logger.info(f"\nAgent: {final}")
                self.logger.session_summary({
                    "steps": step + 1,
                    "duration": round(time.time() - start_time, 2),
                })
                return final

            # Process tool calls - store raw message dict (MiMo API requires content as string)
            msg_dict = message.model_dump()
            if msg_dict.get("content") is None:
                msg_dict["content"] = ""
            session.messages.append(msg_dict)  # add directly, not through add_message
            for tc in message.tool_calls:
                func_name = tc.function.name
                try:
                    func_args = json.loads(tc.function.arguments)
                except json.JSONDecodeError:
                    func_args = {}

                self.logger.trace("tool_call", {"name": func_name, "args": func_args})

                # Special handling for shell commands - dynamic permission
                if func_name == "run_command":
                    cmd = func_args.get("command", "")
                    perm = self._check_shell_permission(cmd)
                    tool_def = self.registry.get(func_name)
                    if tool_def:
                        original_perm = tool_def.permission
                        tool_def.permission = perm
                        result = self.registry.execute(func_name, func_args, self.perms)
                        tool_def.permission = original_perm
                    else:
                        result = json.dumps({"error": "Tool not found"})
                else:
                    result = self.registry.execute(func_name, func_args, self.perms)

                self.logger.tool_call(func_name, func_args, result)
                session.add_message("tool", result, tool_call_id=tc.id)

        return "[ERROR] Max steps reached."
