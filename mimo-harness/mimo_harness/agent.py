"""Core Agent - observe-think-act loop with Claude Code architecture patterns.

Implements:
- Dependency injection for testability (Ch2 QueryDeps pattern)
- Circuit breaker for cascading failure prevention (Ch7)
- State machine with continue/terminal paths (Ch2)
- Token budget tracking and warnings (Ch7)
- System prompt caching for efficiency (Ch6)
"""

import os
import json
import time
import hashlib
import platform
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Optional

from openai import OpenAI

from .config import MIMO_BASE_URL, MIMO_API_KEY, MIMO_MODEL, require_api_key
from .logging_utils import TraceLogger
from .permissions import Permission, PermissionGate
from .context import Session, compact_context, load_memory
from .tools.registry import ToolRegistry, ToolDef
from .tools import file_ops, shell, code_exec, web_tools, doc_tools, math_tools


# ---------------------------------------------------------------------------
# Constants (Ch7: token budget thresholds)
# ---------------------------------------------------------------------------
MAX_CONSECUTIVE_FAILURES = 3
TOKEN_WARNING_THRESHOLD = 0.85  # 85% of context window
TOKEN_BLOCK_THRESHOLD = 0.95    # 95% → block new requests
DEFAULT_MAX_CONTEXT_TOKENS = 128000  # MiMo context window estimate
RESERVED_OUTPUT_TOKENS = 4096


# ---------------------------------------------------------------------------
# Enums for loop termination reasons (Ch2: ten termination reasons)
# ---------------------------------------------------------------------------
class TerminationReason(Enum):
    COMPLETED = "completed"
    MAX_STEPS = "max_steps"
    MAX_DURATION = "max_duration"
    MODEL_ERROR = "model_error"
    CIRCUIT_BREAKER = "circuit_breaker"
    TOKEN_LIMIT = "token_limit"
    USER_ABORT = "user_abort"


# ---------------------------------------------------------------------------
# Dependency injection (Ch2: QueryDeps pattern)
# ---------------------------------------------------------------------------
@dataclass
class AgentDeps:
    """Injected dependencies for testability and environment abstraction."""
    llm_client_factory: Callable = field(default_factory=lambda: OpenAI)
    uuid_generator: Callable = field(default_factory=lambda: hashlib.md5(
        str(time.time()).encode()
    ).hexdigest()[:8])
    max_retries: int = 3
    base_retry_delay: float = 1.0


# ---------------------------------------------------------------------------
# Circuit breaker (Ch7: prevent cascading compression failures)
# ---------------------------------------------------------------------------
class CircuitBreaker:
    """Prevents cascading failures by stopping after N consecutive errors."""

    def __init__(self, threshold: int = MAX_CONSECUTIVE_FAILURES):
        self.threshold = threshold
        self.consecutive_failures = 0
        self.is_open = False

    def record_success(self):
        self.consecutive_failures = 0
        self.is_open = False

    def record_failure(self):
        self.consecutive_failures += 1
        if self.consecutive_failures >= self.threshold:
            self.is_open = True

    def check(self) -> bool:
        """Returns True if circuit is open (should stop)."""
        return self.is_open

    def reset(self):
        self.consecutive_failures = 0
        self.is_open = False


# ---------------------------------------------------------------------------
# Token budget tracker (Ch7: buffer zones)
# ---------------------------------------------------------------------------
class TokenBudget:
    """Tracks token usage against context window limits."""

    def __init__(self, max_tokens: int = DEFAULT_MAX_CONTEXT_TOKENS):
        self.max_tokens = max_tokens
        self.effective_max = max_tokens - RESERVED_OUTPUT_TOKENS
        self.estimated_tokens = 0

    def estimate_message_tokens(self, messages: list) -> int:
        """Rough estimate: ~4 chars per token for mixed content."""
        total_chars = sum(
            len(json.dumps(m, ensure_ascii=False)) if isinstance(m, dict)
            else len(str(m))
            for m in messages
        )
        return total_chars // 4

    def update(self, messages: list):
        self.estimated_tokens = self.estimate_message_tokens(messages)

    def usage_ratio(self) -> float:
        return self.estimated_tokens / self.effective_max if self.effective_max > 0 else 0

    def is_warning(self) -> bool:
        return self.usage_ratio() >= TOKEN_WARNING_THRESHOLD

    def is_blocked(self) -> bool:
        return self.usage_ratio() >= TOKEN_BLOCK_THRESHOLD


# ---------------------------------------------------------------------------
# Retry with exponential backoff (Ch2: error recovery)
# ---------------------------------------------------------------------------
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


# ---------------------------------------------------------------------------
# Main Agent Harness
# ---------------------------------------------------------------------------
class MiMoHarness:
    """Production-grade agent harness following Claude Code architecture.

    Key patterns from the book:
    - Ch2: while(true) loop with state machine, dependency injection
    - Ch3: fail-closed tool defaults, input validation
    - Ch4: 4-stage permission pipeline
    - Ch7: progressive context compression, circuit breaker, token budget
    """

    SYSTEM_PROMPT_TEMPLATE = """You are MiMo Harness, a capable AI assistant powered by Xiaomi MiMo model.
You help users with coding, file operations, web research, document creation, and system tasks.

## Rules
- Use absolute file paths
- Explain what you're about to do before using tools
- Be concise but thorough
- If a task is ambiguous, ask for clarification
- When writing code, verify it works by running it
- If a tool call fails, analyze the error and try a different approach

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
        deps: AgentDeps = None,
        plan_mode: bool = False,
    ):
        self.model = model or MIMO_MODEL
        self.max_steps = max_steps
        self.max_duration = max_duration
        self.deps = deps or AgentDeps()
        self.logger = TraceLogger(log_file=log_file, verbose=verbose)
        self.perms = PermissionGate(
            auto_approve=auto_approve,
            dry_run=dry_run,
            plan_mode=plan_mode,
        )
        self.registry = ToolRegistry()
        self.circuit_breaker = CircuitBreaker()
        self.token_budget = TokenBudget()
        self._system_prompt_cache: Optional[str] = None
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
        """Build and cache system prompt (Ch6: prompt stability for cache hits)."""
        if self._system_prompt_cache is not None:
            return self._system_prompt_cache

        tools_desc = "\n".join(
            f"- **{t.name}**: {t.description}" for t in self.registry.list_all()
        )
        memory = load_memory(".")
        self._system_prompt_cache = self.SYSTEM_PROMPT_TEMPLATE.format(
            cwd=os.getcwd(),
            platform=f"{platform.system()} {platform.release()}",
            python_version=platform.python_version(),
            tools_desc=tools_desc,
            memory=f"\n## Project Memory\n{memory}" if memory else "",
        )
        return self._system_prompt_cache

    def _check_shell_permission(self, command: str) -> Permission:
        """Dynamic permission check for shell commands."""
        if shell._is_readonly(command):
            return Permission.READ
        return Permission.WRITE

    def _handle_tool_call(
        self, func_name: str, func_args: dict, tc_id: str, session: Session
    ) -> str:
        """Execute a single tool call with permission checks.

        Returns the tool result string.
        """
        self.logger.trace("tool_call", {"name": func_name, "args": func_args})

        # Dynamic permission for shell commands (Ch4: context-aware checks)
        if func_name == "run_command":
            cmd = func_args.get("command", "")
            perm = self._check_shell_permission(cmd)
            tool_def = self.registry.get(func_name)
            if tool_def:
                original_perm = tool_def.permission
                tool_def.permission = perm
                try:
                    result = self.registry.execute(func_name, func_args, self.perms)
                finally:
                    tool_def.permission = original_perm
            else:
                result = json.dumps({"error": "Tool not found"})
        else:
            result = self.registry.execute(func_name, func_args, self.perms)

        self.logger.tool_call(func_name, func_args, result)
        return result

    def run(self, task: str, session: Session = None) -> str:
        """Execute the agent loop (Ch2: while(true) with state machine).

        Termination reasons (Ch2: ten reasons):
        - COMPLETED: model responded without tool calls
        - MAX_STEPS: step limit reached
        - MAX_DURATION: time limit exceeded
        - MODEL_ERROR: API call failed after retries
        - CIRCUIT_BREAKER: consecutive failures exceeded threshold
        - TOKEN_LIMIT: context window exceeded
        """
        if session is None:
            session = Session(
                session_id=self.deps.uuid_generator,
                working_dir=os.getcwd(),
            )

        api_key = require_api_key()
        client = self.deps.llm_client_factory(
            api_key=api_key, base_url=MIMO_BASE_URL
        )
        session.add_message("user", task)

        self.logger.info(f"\n{'='*60}")
        self.logger.info(f"Task: {task}")
        self.logger.info(f"Session: {self.logger.session_id}")
        self.logger.info(f"{'='*60}")

        start_time = time.time()
        tools_schema = self.registry.list_tools()
        system_msg = {"role": "system", "content": self._build_system_prompt()}

        # Reset circuit breaker for new task
        self.circuit_breaker.reset()

        for step in range(self.max_steps):
            # Termination check: time limit
            if time.time() - start_time > self.max_duration:
                self.logger.info(f"[LIMIT] Time limit exceeded ({self.max_duration}s)")
                return "[LIMIT] Time limit exceeded"

            # Termination check: circuit breaker (Ch7)
            if self.circuit_breaker.check():
                self.logger.error(
                    f"[CIRCUIT_BREAKER] {self.circuit_breaker.consecutive_failures} "
                    f"consecutive failures. Stopping."
                )
                return "[ERROR] Circuit breaker open — too many consecutive failures"

            # Build messages with context compaction
            compacted = compact_context(
                session.get_messages(), client=client, model=self.model
            )
            messages = [system_msg] + compacted

            # Token budget check (Ch7)
            self.token_budget.update(messages)
            if self.token_budget.is_blocked():
                self.logger.error("[TOKEN_LIMIT] Context window exceeded")
                return "[ERROR] Token budget exceeded — context too long"

            if self.token_budget.is_warning():
                self.logger.info(
                    f"[TOKEN_WARNING] Usage at "
                    f"{self.token_budget.usage_ratio():.0%}"
                )

            self.logger.trace(
                "llm_call_start",
                {"step": step + 1, "model": self.model},
            )

            # API call with retry (Ch2: error recovery)
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
                    ),
                    max_retries=self.deps.max_retries,
                    base_delay=self.deps.base_retry_delay,
                )
                self.circuit_breaker.record_success()
            except Exception as e:
                self.circuit_breaker.record_failure()
                self.logger.error(f"LLM call failed: {e}")
                if self.circuit_breaker.check():
                    return f"[ERROR] Circuit breaker open after repeated failures: {e}"
                continue  # Retry in next loop iteration

            choice = response.choices[0]
            message = choice.message

            # Termination: no tool calls → final response (Ch2: normal completion)
            if not message.tool_calls:
                final = message.content or "[No response]"
                session.add_message("assistant", final)
                self.logger.info(f"\nAgent: {final}")
                self.logger.session_summary({
                    "steps": step + 1,
                    "duration": round(time.time() - start_time, 2),
                    "reason": TerminationReason.COMPLETED.value,
                    "token_usage": round(self.token_budget.usage_ratio(), 2),
                })
                return final

            # Process tool calls (Ch3: tool dispatch with fail-closed defaults)
            msg_dict = message.model_dump()
            if msg_dict.get("content") is None:
                msg_dict["content"] = ""
            session.messages.append(msg_dict)

            for tc in message.tool_calls:
                func_name = tc.function.name
                try:
                    func_args = json.loads(tc.function.arguments)
                except json.JSONDecodeError:
                    func_args = {}

                result = self._handle_tool_call(
                    func_name, func_args, tc.id, session
                )
                session.add_message("tool", result, tool_call_id=tc.id)

        # Termination: max steps reached
        self.logger.session_summary({
            "steps": self.max_steps,
            "duration": round(time.time() - start_time, 2),
            "reason": TerminationReason.MAX_STEPS.value,
        })
        return "[ERROR] Max steps reached."
