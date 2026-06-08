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
import secrets
import platform
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Optional

from openai import OpenAI

from .config import MIMO_BASE_URL, MIMO_API_KEY, MIMO_MODEL, require_api_key
from .logging_utils import TraceLogger
from .permissions import Permission, PermissionGate, PermissionMode
from .context import Session, compact_context, load_memory, load_memory_for_compaction, estimate_tokens, load_topic_on_demand, COMPRESS_TRIGGER_TOKENS
from .tools.registry import ToolRegistry, ToolDef
from .tools import file_ops, shell, code_exec, web_tools, doc_tools, math_tools, interactive, monitor, notebook_tools, task_tools, plan_tools, lsp_tools, scheduler_tools, subagent_tools
from .tools.file_ops import FileOpsState, set_file_ops_state
from .security_pipeline import filter_tool_output, SAFETY_SYSTEM_PROMPT_ADDITION
from .hooks import HookRunner, HookEvent, HookResult
from .display import (
    print_step_header, print_tool_call_result,
    print_streaming_token, print_streaming_end, print_error,
    print_warning, print_info,
    print_thinking_indicator, StepInfo,
    print_model_output_start, print_model_output_end,
    print_tool_call_collapsible, get_status_bar,
)
from .input_utils import rich_input as _rich_input


# ---------------------------------------------------------------------------
# Simple attribute-bag for building synthetic streaming response objects
# (avoids using MagicMock in production code)
# ---------------------------------------------------------------------------
class _AttrBag:
    """Minimal attribute container for streaming response reconstruction."""

    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)


def _parse_tool_result(result: str) -> tuple[bool, str | None, str | None]:
    """Parse tool result for display purposes.

    Returns:
        (success, error_msg, preview) tuple
    """
    try:
        result_data = json.loads(result)
        success = "error" not in result_data
        error_msg = result_data.get("error") if not success else None
        preview = result[:200] if success else None
        return success, error_msg, preview
    except (json.JSONDecodeError, TypeError):
        return True, None, result[:200] if result else None


# ---------------------------------------------------------------------------
# Constants (Ch7: token budget thresholds)
# ---------------------------------------------------------------------------
MAX_CONSECUTIVE_FAILURES = 3
TOKEN_WARNING_THRESHOLD = 0.85  # 85% of context window — trigger auto-compact
DEFAULT_MAX_CONTEXT_TOKENS = 1_000_000  # 1M context window
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
    uuid_generator: Callable = field(default_factory=lambda: lambda: secrets.token_hex(4))
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


class GracefulAbort:
    """Cooperative abort signal for graceful interruption.

    Allows stopping the current agent loop iteration without
    exiting the entire program. The abort flag is checked at
    each step boundary.

    Usage:
        abort = GracefulAbort()
        # In signal handler or UI thread:
        abort.request()
        # In agent loop:
        if abort.is_requested():
            return "[ABORTED] ..."
        abort.reset()  # for next task
    """

    def __init__(self):
        self._event = threading.Event()

    def request(self):
        """Request an abort at the next step boundary."""
        self._event.set()

    def is_requested(self) -> bool:
        """Check if abort has been requested."""
        return self._event.is_set()

    def reset(self):
        """Clear the abort flag for a new task."""
        self._event.clear()


# ---------------------------------------------------------------------------
# Token budget tracker (Ch7: buffer zones)
# ---------------------------------------------------------------------------
class TokenBudget:
    """Tracks token usage against context window limits.

    Uses token_counter module for precise counting with tiktoken,
    falling back to heuristic estimation when tiktoken unavailable.
    """

    def __init__(self, max_tokens: int = DEFAULT_MAX_CONTEXT_TOKENS, model: str = "gpt-4"):
        self.max_tokens = max_tokens
        self.effective_max = max_tokens - RESERVED_OUTPUT_TOKENS
        self.estimated_tokens = 0
        self.model = model
        self._stats = None  # Lazy-initialized TokenStats

    def estimate_message_tokens(self, messages: list) -> int:
        """Estimate token count using token_counter module."""
        from .token_counter import count_messages_tokens
        return count_messages_tokens(messages, model=self.model)

    def update(self, messages: list):
        self.estimated_tokens = self.estimate_message_tokens(messages)

    def usage_ratio(self) -> float:
        return self.estimated_tokens / self.effective_max if self.effective_max > 0 else 0

    def is_warning(self) -> bool:
        return self.usage_ratio() >= TOKEN_WARNING_THRESHOLD

    def get_stats(self):
        """Get or create TokenStats for this session."""
        if self._stats is None:
            from .token_counter import TokenStats
            self._stats = TokenStats()
        return self._stats


# ---------------------------------------------------------------------------
# Retry with exponential backoff (Ch2: error recovery)
# ---------------------------------------------------------------------------
def retry_with_backoff(fn, max_retries: int = 3, base_delay: float = 1.0):
    last_error = None
    last_traceback = None
    # L10: Also retry on common network errors (no status_code attribute)
    _NETWORK_ERRORS = (ConnectionError, TimeoutError, ConnectionResetError, BrokenPipeError, ConnectionAbortedError)
    for attempt in range(max_retries):
        try:
            return fn()
        except Exception as e:
            last_error = e
            last_traceback = e.__traceback__
            status = getattr(e, "status_code", None)
            if status and status not in (429, 500, 502, 503, 504):
                raise
            # Retry on HTTP status errors OR network errors
            is_retryable = (status in (429, 500, 502, 503, 504)) or isinstance(e, _NETWORK_ERRORS)
            if not is_retryable:
                raise
            if attempt < max_retries - 1:
                time.sleep(base_delay * (2 ** attempt))
    raise last_error.with_traceback(last_traceback)


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

{safety_rules}

## Environment
- Working directory: {cwd}
- Platform: {platform}
- Shell: {shell_type}
- Python: {python_version}

{platform_guidance}

## Available Tools
{tools_desc}"""

    # Effort level → LLM parameter mapping
    # No max_completion_tokens cap — let the model generate as many tokens as
    # the task requires.  Artificial caps cause truncation on reasoning models
    # whose thinking tokens eat into the budget.
    EFFORT_PARAMS = {
        "low": {"temperature": 0.3},
        "medium": {"temperature": 0.7},
        "high": {"temperature": 0.9},
    }

    def __init__(
        self,
        model: str = None,
        auto_approve: bool = False,
        dry_run: bool = False,
        max_steps: int = 0,
        max_duration: float = 0.0,
        verbose: bool = False,
        log_file: str = None,
        deps: AgentDeps = None,
        plan_mode: bool = False,
        stream: bool = False,
        fallback_model: str = None,
        bare: bool = False,
        effort: str = "medium",
    ):
        self.model = model or MIMO_MODEL
        self.fallback_model = fallback_model
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
        self.token_budget = TokenBudget(model=self.model)
        self.graceful_abort = GracefulAbort()
        self.stream = stream
        self.bare = bare
        self.effort = effort
        self._system_prompt_cache: Optional[str] = None
        # A8: Thrashing protection counters
        self._compaction_attempts = 0
        self._compaction_failures = 0
        self._thrashing_detected = False
        self._thrash_warned = False
        # SubAgent management (lazy-initialized)
        self._subagent_manager = None
        self._register_tools()

    def _register_tools(self):
        all_tools = (
            file_ops.get_tools()
            + shell.get_tools()
            + code_exec.get_tools()
            + web_tools.get_tools()
            + doc_tools.get_tools()
            + math_tools.get_tools()
            + interactive.get_tools()
            + monitor.get_tools()
            + notebook_tools.get_tools()
            + task_tools.get_tools()
            + plan_tools.get_tools()
            + lsp_tools.get_tools()
            + scheduler_tools.get_tools()
            + subagent_tools.get_tools(self)
        )
        self.registry.register_many(all_tools)

    def _build_system_prompt(self) -> str:
        """Build and cache system prompt (Ch6: prompt stability for cache hits).

        Memory is NOT included in the system prompt. It's injected as a
        separate user message for better prompt caching (stable system
        prompt prefix, variable memory in conversation).
        """
        if self._system_prompt_cache is not None:
            return self._system_prompt_cache

        tools_desc = "\n".join(
            f"- **{t.name}**: {t.description}" for t in self.registry.list_all()
        )

        if platform.system() == "Windows":
            shell_type = "cmd.exe (Windows Command Prompt)"
            platform_guidance = """## Windows Command Guidance
- Use Windows-native commands: `dir` (not `ls`), `type` (not `cat`), `copy` (not `cp`)
- `mkdir` creates parent directories by default (no `-p` flag needed)
- Use `rmdir /s /q <dir>` for recursive directory delete, `del /f /q <file>` for files
- Use `xcopy` or `copy` for file copying
- Some Unix commands are auto-translated, but prefer native Windows commands"""
        else:
            shell_type = "sh (Unix shell)"
            platform_guidance = ""

        self._system_prompt_cache = self.SYSTEM_PROMPT_TEMPLATE.format(
            cwd=os.getcwd(),
            platform=f"{platform.system()} {platform.release()}",
            shell_type=shell_type,
            python_version=platform.python_version(),
            tools_desc=tools_desc,
            safety_rules=SAFETY_SYSTEM_PROMPT_ADDITION,
            platform_guidance=platform_guidance,
        )

        # S15: Append extra system prompt text if configured
        append_prompt = getattr(self, "_append_system_prompt", "")
        if append_prompt:
            self._system_prompt_cache += f"\n\n{append_prompt}"
        return self._system_prompt_cache

    def _check_shell_permission(self, command: str) -> Permission:
        """Dynamic permission check for shell commands."""
        if shell._is_readonly(command):
            return Permission.READ
        return Permission.WRITE

    def _handle_tool_call(
        self, func_name: str, func_args: dict, tc_id: str, session: Session
    ) -> str:
        """Execute a single tool call with permission checks and security pipeline.

        Returns the tool result string.
        """
        self.logger.trace("tool_call", {"name": func_name, "args": func_args})

        # Report malformed arguments back to LLM instead of executing with empty dict
        if func_args.get("_parse_error"):
            return json.dumps({
                "error": f"Malformed tool arguments: {func_args.get('raw', '')}",
                "hint": "Please retry with valid JSON arguments.",
            })

        # --- PreToolUse Hooks (Ch8: intercept before execution) ---
        hook_runner = getattr(self, '_hook_runner', None)
        if hook_runner:
            pre_result = hook_runner.run_hooks(
                HookEvent.PRE_TOOL_USE,
                tool_name=func_name,
                tool_input=func_args,
            )
            if pre_result.is_blocking:
                self.logger.trace("hook_blocked", {
                    "tool": func_name, "reason": pre_result.reason,
                })
                return json.dumps({
                    "error": f"[HOOK BLOCKED] {pre_result.reason}",
                    "decision": "blocked_by_hook",
                })
            # Apply updated input if hook modified it
            if pre_result.updated_input:
                func_args = pre_result.updated_input

        # Security Pipeline: handled by PermissionGate in registry.execute()
        # (classify_action + review_action are called inside PermissionGate.check())

        # S12: Snapshot files before edit/write operations
        checkpoint_mgr = getattr(self, "_checkpoint_manager", None)
        if checkpoint_mgr and func_name in ("edit_file", "write_file"):
            file_path = func_args.get("path") or func_args.get("file_path", "")
            if file_path and os.path.exists(file_path):
                try:
                    checkpoint_mgr.snapshot(file_path)
                except Exception as e:
                    self.logger.trace("checkpoint_snapshot_failed", {"error": str(e)})

        # Dynamic permission for shell commands (Ch4: context-aware checks)
        if func_name == "run_command":
            perm = self._check_shell_permission(func_args.get("command", ""))
            tool_def = self.registry.get(func_name)
            if tool_def:
                # Use per-call permission override instead of mutating shared tool_def
                try:
                    result = self.registry.execute(
                        func_name, func_args, self.perms, permission_override=perm
                    )
                except KeyboardInterrupt:
                    self.graceful_abort.request()
                    return json.dumps({"error": "[INTERRUPTED] Tool execution cancelled by user"})
            else:
                result = json.dumps({"error": "Tool not found"})
        else:
            try:
                result = self.registry.execute(func_name, func_args, self.perms)
            except KeyboardInterrupt:
                self.graceful_abort.request()
                return json.dumps({"error": "[INTERRUPTED] Tool execution cancelled by user"})

        # --- Security Pipeline: Output Filtering (Input Probe) ---
        filtered = filter_tool_output(result)
        if filtered.was_sanitized:
            self.logger.trace("security_sanitized", {"tool": func_name})
        if filtered.injection_detected:
            self.logger.trace("security_injection_detected", {"tool": func_name})
        result = filtered.text

        self.logger.tool_call(func_name, func_args, result)

        # --- PostToolUse Hooks (Ch8: intercept after execution) ---
        if hook_runner:
            post_result = hook_runner.run_hooks(
                HookEvent.POST_TOOL_USE,
                tool_name=func_name,
                tool_input=func_args,
                tool_result=result[:2000],
            )
            # PostToolUse hooks can inject additional context but cannot block
            if post_result.additional_context:
                result = result + f"\n[Hook context: {post_result.additional_context}]"

        # Plan mode workflow: auto-switch permission mode based on tool calls
        if func_name == "enter_plan_mode":
            self.perms.mode = PermissionMode.PLAN
            self.logger.info("[PLAN MODE] Switched to read-only plan mode")
        elif func_name == "exit_plan_mode":
            try:
                parsed = json.loads(result)
                if parsed.get("decision") == "pending":
                    result = self._handle_plan_approval(parsed)
                    parsed = json.loads(result)
                if parsed.get("decision") == "approved":
                    self.perms.mode = PermissionMode.DEFAULT
                    self.logger.info("[PLAN MODE] Approved — switched to default mode")
                # If rejected/modify, stay in plan mode
            except (json.JSONDecodeError, AttributeError):
                pass

        return result

    def _handle_plan_approval(self, parsed: dict) -> str:
        """Prompt user for plan approval (called from agent loop, not tool handler)."""
        if self.perms.auto_approve:
            return json.dumps({
                "decision": "approved",
                "message": "[PLAN APPROVED] Auto-approved. Proceeding with implementation.",
                "action": "exit_plan_mode",
            })

        summary = parsed.get("summary", "")
        plan = parsed.get("plan", "")
        print(f"\n{'='*60}")
        print("  PLAN READY FOR REVIEW")
        print(f"{'='*60}")
        if summary:
            print(f"\n  Summary: {summary}")
        print(f"\n{plan}")
        print(f"\n{'='*60}")
        print("\nOptions:")
        print("  1. Approve — exit plan mode and proceed with implementation")
        print("  2. Reject — stay in plan mode, provide feedback")
        print("  3. Modify — request changes to the plan")

        try:
            choice = _rich_input("\nYour choice (1/2/3): ").strip()
        except (EOFError, KeyboardInterrupt):
            return json.dumps({"decision": "rejected", "reason": "User cancelled"})

        if choice == "1":
            return json.dumps({
                "decision": "approved",
                "message": "[PLAN APPROVED] Exiting plan mode. Proceeding with implementation.",
                "action": "exit_plan_mode",
            })
        elif choice == "3":
            try:
                feedback = _rich_input("What changes would you like? ").strip()
            except (EOFError, KeyboardInterrupt):
                feedback = ""
            return json.dumps({
                "decision": "modify",
                "feedback": feedback,
                "message": "[PLAN MODIFICATION REQUESTED] Please revise the plan based on feedback.",
            })
        else:
            try:
                feedback = _rich_input("Feedback (optional): ").strip()
            except (EOFError, KeyboardInterrupt):
                feedback = ""
            return json.dumps({
                "decision": "rejected",
                "feedback": feedback,
                "message": "[PLAN REJECTED] Staying in plan mode. Revise based on feedback.",
            })

    def _call_llm(self, client, messages: list, tools_schema: list, temperature: float = 0.7):
        """Execute a non-streaming LLM call.

        This is a patchable wrapper around client.chat.completions.create()
        so tests can replace it without touching the real API.
        """
        return retry_with_backoff(
            lambda: client.chat.completions.create(
                model=self.model,
                messages=messages,
                tools=tools_schema,
                tool_choice="auto",
                temperature=temperature,
                top_p=0.9,
            ),
            max_retries=self.deps.max_retries,
            base_delay=self.deps.base_retry_delay,
        )

    def _stream_llm_call(self, client, messages: list, tools_schema: list):
        """Execute LLM call with streaming, printing tokens as they arrive.

        Returns a response object compatible with the non-streaming path.
        Includes real-time token counting via StreamingTokenCounter.
        """
        import sys
        from .token_counter import StreamingTokenCounter

        effort_params = self.EFFORT_PARAMS.get(self.effort, self.EFFORT_PARAMS["medium"])

        # Initialize streaming token counter
        stream_counter = StreamingTokenCounter(model=self.model)

        def _do_stream():
            return client.chat.completions.create(
                model=self.model,
                messages=messages,
                tools=tools_schema,
                tool_choice="auto",
                temperature=effort_params["temperature"],
                top_p=0.9,
                stream=True,
            )

        response_stream = retry_with_backoff(
            _do_stream,
            max_retries=self.deps.max_retries,
            base_delay=self.deps.base_retry_delay,
        )

        full_content = ""
        full_reasoning_content = ""
        tool_calls_data = {}
        finish_reason = None
        is_first_token = True

        for chunk in response_stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            finish_reason = chunk.choices[0].finish_reason or finish_reason

            if delta is None:
                continue

            # Capture reasoning_content from streaming chunks.
            # MiMo API requires this to be passed back in subsequent
            # requests when tool_calls are present.
            if hasattr(delta, 'reasoning_content') and delta.reasoning_content:
                full_reasoning_content += delta.reasoning_content

            if delta.content:
                if is_first_token:
                    # First token received - print newline to separate from thinking indicator
                    print()  # Move past the "Thinking..." line
                    is_first_token = False
                full_content += delta.content
                # Track streaming tokens
                stream_counter.add_text(delta.content)
                print_streaming_token(delta.content)

            if delta.tool_calls:
                for tc_chunk in delta.tool_calls:
                    idx = tc_chunk.index
                    if idx not in tool_calls_data:
                        tool_calls_data[idx] = {
                            "id": "",
                            "name": "",
                            "arguments": "",
                        }
                    if tc_chunk.id:
                        tool_calls_data[idx]["id"] = tc_chunk.id
                    if tc_chunk.function:
                        if tc_chunk.function.name:
                            tool_calls_data[idx]["name"] = tc_chunk.function.name
                        if tc_chunk.function.arguments:
                            tool_calls_data[idx]["arguments"] += tc_chunk.function.arguments

        if full_content or tool_calls_data:
            print_streaming_end()

        # Log streaming token stats
        self.logger.trace("stream_tokens", {
            "output_tokens": stream_counter.total_tokens,
            "output_chars": stream_counter.total_chars,
        })

        # Update stats if available
        stats = self.token_budget.get_stats()
        stats.output_tokens += stream_counter.total_tokens

        # Build synthetic response object for compatibility (using _AttrBag,
        # not MagicMock — production code must not depend on unittest.mock)
        tool_calls_list = []
        for idx in sorted(tool_calls_data.keys()):
            tc_data = tool_calls_data[idx]
            tc_obj = _AttrBag(
                id=tc_data["id"],
                function=_AttrBag(
                    name=tc_data["name"],
                    arguments=tc_data["arguments"],
                ),
            )
            tool_calls_list.append(tc_obj)

        # snapshot tool_calls_data for the lambda closure
        tc_snapshot = list(tool_calls_data.values())
        # snapshot reasoning_content for the lambda closure
        reasoning_snapshot = full_reasoning_content

        def _model_dump():
            result = {
                "role": "assistant",
                "content": full_content or "",
                "tool_calls": [
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": {
                            "name": tc["name"],
                            "arguments": tc["arguments"],
                        },
                    }
                    for tc in tc_snapshot
                ] if tc_snapshot else None,
            }
            # MiMo API requires reasoning_content to be passed back
            if reasoning_snapshot:
                result["reasoning_content"] = reasoning_snapshot
            return result

        synthetic_message = _AttrBag(
            content=full_content or None,
            tool_calls=tool_calls_list if tool_calls_list else None,
            reasoning_content=full_reasoning_content or None,
            model_dump=_model_dump,
        )

        synthetic_choice = _AttrBag(
            message=synthetic_message,
            finish_reason=finish_reason,
        )

        synthetic_response = _AttrBag(choices=[synthetic_choice])

        return synthetic_response

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
                session_id=self.deps.uuid_generator(),
                working_dir=os.getcwd(),
            )

        # DESIGN-3: Set session-scoped file operation state so each
        # session/SubAgent has isolated read/write tracking
        self._file_ops_state = FileOpsState()
        set_file_ops_state(self._file_ops_state)

        api_key = require_api_key()
        client = self.deps.llm_client_factory(
            api_key=api_key, base_url=MIMO_BASE_URL
        )
        self._llm_client = client  # Store for security pipeline model classifier
        # Set LLM client on permission gate for model-driven classification
        self.perms.set_llm_client(client, self.model)

        # Inject LLM client into hook runner for prompt-type hooks
        hook_runner = getattr(self, '_hook_runner', None)
        if hook_runner:
            hook_runner._llm_client = client

        # Inject memory as a user message (Claude Code pattern: memory is
        # context, not enforcement. Injected as user message after system
        # prompt for better prompt caching — stable system prefix, variable
        # memory in conversation.)
        if not self.bare:
            memory_content = load_memory(os.getcwd())
            if memory_content:
                session.add_message("user", f"## Project Memory\n{memory_content}")

        session.add_message("user", task)

        self.logger.trace("task_start", {"task": task[:200], "session": self.logger.session_id})

        start_time = time.time()
        tools_schema = self.registry.list_tools()
        # Reset system prompt cache so CWD/tools changes are reflected
        self._system_prompt_cache = None
        system_msg = {"role": "system", "content": self._build_system_prompt()}
        effort_params = self.EFFORT_PARAMS.get(self.effort, self.EFFORT_PARAMS["medium"])

        # Reset circuit breaker for new task
        self.circuit_breaker.reset()
        # Reset thrashing warning flag for new task
        self._thrash_warned = False
        # L1: Reset thrashing counters for new task
        self._compaction_attempts = 0
        self._compaction_failures = 0

        step = 0
        while True:
            step += 1

            # Termination check: graceful abort (Esc / Ctrl+C during execution)
            if self.graceful_abort.is_requested():
                self.logger.info("[ABORT] Graceful abort requested by user")
                self.graceful_abort.reset()
                self._last_session = session
                return "[ABORTED] Stopped by user request."

            # Termination check: time limit
            if self.max_duration > 0 and time.time() - start_time > self.max_duration:
                self.logger.info(f"[LIMIT] Time limit exceeded ({self.max_duration}s)")
                self._last_session = session
                return "[LIMIT] Time limit exceeded"

            # Termination check: circuit breaker (Ch7)
            if self.circuit_breaker.check():
                self.logger.error(
                    f"[CIRCUIT_BREAKER] {self.circuit_breaker.consecutive_failures} "
                    f"consecutive failures. Stopping."
                )
                self._last_session = session
                return "[ERROR] Circuit breaker open — too many consecutive failures"

            # Termination check: max_steps (only if explicitly set, 0 = unlimited)
            if self.max_steps > 0 and step > self.max_steps:
                self.logger.info(f"[LIMIT] Max steps exceeded ({self.max_steps})")
                self._last_session = session
                return "[LIMIT] Max steps exceeded"

            # Auto-compact when context gets large (no blocking — always proceed)
            conv_tokens = estimate_tokens(session.get_messages())
            if conv_tokens >= COMPRESS_TRIGGER_TOKENS and not self._thrashing_detected:
                pct = conv_tokens / self.token_budget.effective_max
                self.logger.info(f"[COMPACT] Context at {pct:.0%}, compressing...")
                print_warning(f"Context at {pct:.0%} — auto-compacting...")
                compacted, self._compaction_attempts, self._compaction_failures, thrashing, did_compress = compact_context(
                    session.get_messages(),
                    client=client,
                    model=self.model,
                    estimated_tokens=conv_tokens,
                    compaction_attempts=self._compaction_attempts,
                    compaction_failures=self._compaction_failures,
                )
                if thrashing:
                    self._thrashing_detected = True
                    self.logger.info("[THRASHING] Compaction not reducing size — disabled")
                if did_compress:
                    session.messages = compacted
                    session.compaction_count += 1
                    memory_content = load_memory_for_compaction()
                    if memory_content:
                        session.add_message("user", f"## Project Memory\n{memory_content}")
                    session.add_message("user", task)
                    new_tokens = estimate_tokens(session.get_messages())
                    self.logger.info(f"[COMPACT] Done → ~{new_tokens} tokens")
                    print_info(f"Compacted to {new_tokens / self.token_budget.effective_max:.0%}")

            messages = [system_msg] + session.get_messages()
            self.token_budget.update(messages)

            self.logger.trace(
                "llm_call_start",
                {"step": step + 1, "model": self.model},
            )

            # Display step header and thinking indicator
            step_info = StepInfo(
                current=step + 1,
                max_steps=self.max_steps,
                model=self.model,
                effort=self.effort,
            )
            print_step_header(step_info)
            print_thinking_indicator()
            # Update status bar
            status_bar = get_status_bar()
            status_bar.set_thinking(self.model)

            # API call with retry (Ch2: error recovery)
            try:
                if self.stream:
                    response = self._stream_llm_call(
                        client, messages, tools_schema
                    )
                else:
                    response = self._call_llm(
                        client, messages, tools_schema,
                        temperature=effort_params["temperature"],
                    )
                self.circuit_breaker.record_success()
            except Exception as e:
                # S16: Fallback model on 429/503 errors
                status = getattr(e, "status_code", None)
                if self.fallback_model and status in (429, 503):
                    self.logger.info(
                        f"Primary model failed ({status}), trying fallback: {self.fallback_model}"
                    )
                    try:
                        response = retry_with_backoff(
                            lambda: client.chat.completions.create(
                                model=self.fallback_model,
                                messages=messages,
                                tools=tools_schema,
                                tool_choice="auto",
                                temperature=effort_params["temperature"],
                                top_p=0.9,
                                            ),
                            max_retries=self.deps.max_retries,
                            base_delay=self.deps.base_retry_delay,
                        )
                        self.circuit_breaker.record_success()
                    except Exception as fallback_err:
                        self.circuit_breaker.record_failure()
                        self.logger.error(f"Fallback model also failed: {fallback_err}")
                        status_bar.set_error(str(fallback_err)[:60])
                        if self.circuit_breaker.check():
                            return f"[ERROR] Circuit breaker open after repeated failures: {fallback_err}"
                        continue
                else:
                    self.circuit_breaker.record_failure()
                    self.logger.error(f"LLM call failed: {e}")
                    status_bar.set_error(str(e)[:60])
                    if self.circuit_breaker.check():
                        return f"[ERROR] Circuit breaker open after repeated failures: {e}"
                    continue  # Retry in next loop iteration

            choice = response.choices[0]
            message = choice.message

            # Termination: no tool calls → final response (Ch2: normal completion)
            if not message.tool_calls:
                final = message.content or "[No response]"
                session.add_message("assistant", final)
                if not self.stream:
                    # Display the response in model output container
                    print()
                    print_model_output_start(self.model)
                    print(final)
                    print_model_output_end()
                # Set status bar to idle after completion
                get_status_bar().set_idle()
                # Ch8: Fire Stop hook
                hook_runner = getattr(self, '_hook_runner', None)
                if hook_runner:
                    hook_runner.run_hooks(HookEvent.STOP, tool_result=final[:2000])
                # Update token stats
                stats = self.token_budget.get_stats()
                stats.total_tokens = self.token_budget.estimated_tokens
                self.logger.session_summary({
                    "steps": step + 1,
                    "duration": round(time.time() - start_time, 2),
                    "reason": TerminationReason.COMPLETED.value,
                    "token_usage": round(self.token_budget.usage_ratio(), 2),
                    "token_stats": stats.to_dict(),
                })
                self._last_session = session
                self._last_steps = step + 1
                return final

            # Process tool calls (Ch3: tool dispatch with fail-closed defaults)
            try:
                msg_dict = message.model_dump()
            except Exception:
                self.logger.error("[MODEL_ERROR] Failed to serialize response")
                self.circuit_breaker.record_failure()
                continue
            if msg_dict.get("content") is None:
                msg_dict["content"] = ""

            # Validate and sanitize tool calls before adding to session.
            # Malformed (truncated) tool arguments cause 400 errors on
            # subsequent API calls because the invalid JSON is embedded in
            # the conversation history sent back to the model.
            if msg_dict.get("tool_calls"):
                for tc_dict in msg_dict["tool_calls"]:
                    func = tc_dict.get("function", {})
                    args_str = func.get("arguments", "{}")
                    try:
                        json.loads(args_str)
                    except (json.JSONDecodeError, TypeError):
                        # Replace malformed arguments with valid JSON so
                        # the session history remains well-formed.
                        func["arguments"] = json.dumps({
                            "error": "Malformed tool arguments (truncated output)",
                            "hint": "Please retry with shorter content.",
                        })
                        self.logger.trace("sanitized_malformed_tool_args", {
                            "tool": func.get("name", "unknown"),
                        })

            # MiMo API requires reasoning_content to be passed back in
            # subsequent requests when tool_calls are present.  Missing it
            # causes a 400 error.  See:
            # https://platform.xiaomimimo.com/docs/zh-CN/usage-guide/passing-back-reasoning_content
            extra_kwargs = {}
            if msg_dict.get("reasoning_content"):
                extra_kwargs["reasoning_content"] = msg_dict["reasoning_content"]
            session.add_message(msg_dict["role"], msg_dict["content"],
                              tool_calls=msg_dict.get("tool_calls"),
                              **extra_kwargs)

            # Update token stats for assistant message
            stats = self.token_budget.get_stats()
            stats.input_tokens += self.token_budget.estimated_tokens
            stats.message_count += 1
            if message.tool_calls:
                stats.tool_call_count += len(message.tool_calls)

            # Group tool calls into concurrency-safe and sequential
            # Also collect parsed args for display (avoid double parsing)
            safe_calls = []
            sequential_calls = []
            all_calls_parsed = []  # (func_name, func_args) for display
            total_tool_calls = len(message.tool_calls)
            for tc in message.tool_calls:
                func_name = tc.function.name
                try:
                    func_args = json.loads(tc.function.arguments)
                except json.JSONDecodeError:
                    func_args = {"_parse_error": True, "raw": tc.function.arguments}
                tool_def = self.registry.get(func_name)
                if tool_def and tool_def.is_concurrency_safe:
                    safe_calls.append((tc, func_name, func_args))
                else:
                    sequential_calls.append((tc, func_name, func_args))
                # Store for display (use clean args without _parse_error)
                display_args = {k: v for k, v in func_args.items() if k != "_parse_error"}
                all_calls_parsed.append((func_name, display_args))

            # Display all tool calls before execution (collapsible format)
            print()
            status_bar = get_status_bar()
            for i, (func_name, func_args) in enumerate(all_calls_parsed):
                print_tool_call_collapsible(
                    func_name, func_args, i, total_tool_calls, collapsed=True
                )
                status_bar.set_executing(func_name)

            # Execute concurrency-safe tools in parallel (preserving order)
            if safe_calls:
                with ThreadPoolExecutor(max_workers=min(len(safe_calls), 8)) as executor:
                    # Submit in original order
                    futures = [
                        executor.submit(self._handle_tool_call, fn, fa, tc.id, session)
                        for tc, fn, fa in safe_calls
                    ]
                    # Collect results in submission order (not completion order)
                    for (tc, func_name, _), future in zip(safe_calls, futures):
                        tool_start = time.time()
                        try:
                            result = future.result()
                            duration = time.time() - tool_start
                            success, error_msg, preview = _parse_tool_result(result)
                            print_tool_call_result(func_name, success, duration, preview, error_msg)
                        except Exception as e:
                            duration = time.time() - tool_start
                            result = json.dumps({"error": str(e)})
                            print_tool_call_result(func_name, False, duration, error=str(e))
                        session.add_message("tool", result, tool_call_id=tc.id)
                # Update status bar after parallel execution
                status_bar.set_thinking(self.model)

            # X2: Batch related edit/write operations together
            edit_calls = [(tc, fn, fa) for tc, fn, fa in sequential_calls if fn in ("edit_file", "write_file")]
            other_calls = [(tc, fn, fa) for tc, fn, fa in sequential_calls if fn not in ("edit_file", "write_file")]

            # Execute other sequential tools first
            for tc, func_name, func_args in other_calls:
                status_bar.set_executing(func_name)
                tool_start = time.time()
                try:
                    result = self._handle_tool_call(
                        func_name, func_args, tc.id, session
                    )
                    duration = time.time() - tool_start
                    success, error_msg, preview = _parse_tool_result(result)
                    print_tool_call_result(func_name, success, duration, preview, error_msg)
                except Exception as e:
                    duration = time.time() - tool_start
                    result = json.dumps({"error": str(e)})
                    print_tool_call_result(func_name, False, duration, error=str(e))
                session.add_message("tool", result, tool_call_id=tc.id)

            # Execute edit/write tools as a batch if checkpoint manager available
            if edit_calls:
                checkpoint_mgr = getattr(self, "_checkpoint_manager", None)
                if checkpoint_mgr and len(edit_calls) > 1:
                    checkpoint_mgr.begin_batch()
                for tc, func_name, func_args in edit_calls:
                    status_bar.set_executing(func_name)
                    tool_start = time.time()
                    try:
                        result = self._handle_tool_call(
                            func_name, func_args, tc.id, session
                        )
                        duration = time.time() - tool_start
                        success, error_msg, preview = _parse_tool_result(result)
                        print_tool_call_result(func_name, success, duration, preview, error_msg)
                    except Exception as e:
                        duration = time.time() - tool_start
                        result = json.dumps({"error": str(e)})
                        print_tool_call_result(func_name, False, duration, error=str(e))
                    session.add_message("tool", result, tool_call_id=tc.id)
                if checkpoint_mgr and len(edit_calls) > 1:
                    checkpoint_mgr.end_batch()
                # Update status bar after all tools executed
                status_bar.set_thinking(self.model)

    # -----------------------------------------------------------------------
    # SubAgent Management
    # -----------------------------------------------------------------------
    @property
    def subagent_manager(self):
        """Lazy-initialized SubAgentManager."""
        if self._subagent_manager is None:
            from .subagent import SubAgentManager
            self._subagent_manager = SubAgentManager(
                parent_harness=self,
                logger=self.logger,
            )
        return self._subagent_manager

    def create_subagent(
        self,
        task: str,
        description: str = "",
        max_steps: int = 0,
        allowed_tools: list[str] = None,
        effort: str = "medium",
    ):
        """Create a SubAgent for parallel task execution.

        Args:
            task: The task for the SubAgent to execute
            description: Human-readable description of the task
            max_steps: Maximum steps for the SubAgent
            allowed_tools: List of allowed tool names (None = all tools)
            effort: Effort level (low/medium/high)

        Returns:
            SubAgent instance
        """
        from .subagent import SubAgentConfig

        config = SubAgentConfig(
            task=task,
            description=description,
            max_steps=max_steps,
            allowed_tools=allowed_tools,
            effort=effort,
        )
        return self.subagent_manager.create_subagent(config)

    def run_subagent(self, task: str, **kwargs):
        """Create and run a single SubAgent synchronously.

        Args:
            task: The task for the SubAgent to execute
            **kwargs: Additional SubAgentConfig options

        Returns:
            SubAgentResult
        """
        from .subagent import SubAgentConfig

        config = SubAgentConfig(task=task, **kwargs)
        return self.subagent_manager.run_single(config)

    def run_parallel_subagents(self, tasks: list[str], **kwargs):
        """Run multiple tasks in parallel using SubAgents.

        Args:
            tasks: List of task descriptions
            **kwargs: Additional SubAgentConfig options

        Returns:
            List of SubAgentResult
        """
        from .subagent import SubAgentConfig

        configs = [SubAgentConfig(task=task, **kwargs) for task in tasks]
        return self.subagent_manager.run_parallel(configs)

    def run_pipeline_subagents(self, stages: list[dict]):
        """Run tasks in pipeline mode (sequential with context passing).

        Args:
            stages: List of dicts with 'task' and optional 'description', 'allowed_tools'

        Returns:
            List of SubAgentResult
        """
        from .subagent import SubAgentConfig

        configs = [
            SubAgentConfig(
                task=stage["task"],
                description=stage.get("description", ""),
                allowed_tools=stage.get("allowed_tools"),
            )
            for stage in stages
        ]
        return self.subagent_manager.run_pipeline(configs)

    def get_subagent_summary(self) -> dict:
        """Get a summary of all SubAgent activity."""
        if self._subagent_manager is None:
            return {"total_subagents": 0, "running": 0, "completed": 0, "failed": 0}
        return self.subagent_manager.get_resource_summary()
