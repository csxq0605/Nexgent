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
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Optional

from openai import OpenAI

from .config import MIMO_BASE_URL, MIMO_API_KEY, MIMO_MODEL, require_api_key
from .logging_utils import TraceLogger
from .permissions import Permission, PermissionGate, PermissionMode
from .context import Session, compact_context, load_memory, load_memory_for_compaction, estimate_tokens, load_topic_on_demand
from .tools.registry import ToolRegistry, ToolDef
from .tools import file_ops, shell, code_exec, web_tools, doc_tools, math_tools, interactive, monitor, notebook_tools, task_tools, plan_tools, lsp_tools, scheduler_tools
from .security_pipeline import classify_action, filter_tool_output, SafetyDecision, SAFETY_SYSTEM_PROMPT_ADDITION
from .hooks import HookRunner, HookEvent, HookResult


# ---------------------------------------------------------------------------
# Simple attribute-bag for building synthetic streaming response objects
# (avoids using MagicMock in production code)
# ---------------------------------------------------------------------------
class _AttrBag:
    """Minimal attribute container for streaming response reconstruction."""

    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)


# ---------------------------------------------------------------------------
# Constants (Ch7: token budget thresholds)
# ---------------------------------------------------------------------------
MAX_CONSECUTIVE_FAILURES = 3
TOKEN_WARNING_THRESHOLD = 0.85  # 85% of context window
TOKEN_BLOCK_THRESHOLD = 0.95    # 95% → block new requests
DEFAULT_MAX_CONTEXT_TOKENS = 200_000  # 200K context window (Claude Code standard)
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
        self._abort_requested = False

    def request(self):
        """Request an abort at the next step boundary."""
        self._abort_requested = True

    def is_requested(self) -> bool:
        """Check if abort has been requested."""
        return self._abort_requested

    def reset(self):
        """Clear the abort flag for a new task."""
        self._abort_requested = False


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
        """Estimate token count using weighted heuristic from context module."""
        from .context import estimate_tokens
        return estimate_tokens(messages)

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
- Python: {python_version}

## Available Tools
{tools_desc}"""

    # Effort level → LLM parameter mapping
    EFFORT_PARAMS = {
        "low": {"temperature": 0.3, "max_completion_tokens": 512},
        "medium": {"temperature": 0.7, "max_completion_tokens": 2048},
        "high": {"temperature": 0.9, "max_completion_tokens": 4096},
    }

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
        self.token_budget = TokenBudget()
        self.graceful_abort = GracefulAbort()
        self.stream = stream
        self.bare = bare
        self.effort = effort
        self._system_prompt_cache: Optional[str] = None
        # A8: Thrashing protection counters
        self._compaction_attempts = 0
        self._compaction_failures = 0
        self._thrashing_detected = False
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

        self._system_prompt_cache = self.SYSTEM_PROMPT_TEMPLATE.format(
            cwd=os.getcwd(),
            platform=f"{platform.system()} {platform.release()}",
            python_version=platform.python_version(),
            tools_desc=tools_desc,
            safety_rules=SAFETY_SYSTEM_PROMPT_ADDITION,
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

        # --- Security Pipeline: Action Classification (Transcript Classifier) ---
        command = func_args.get("command", "")
        # Use model-based classifier when available (Claude Code's auto mode approach)
        llm_client = getattr(self, "_llm_client", None)
        classification = classify_action(
            tool_name=func_name,
            tool_args=func_args,
            command=command,
            working_dir=os.getcwd(),
            client=llm_client if self.perms.auto_approve else None,
            model=self.model,
            conversation_context=session.get_messages() if session else None,
        )
        if classification.decision == SafetyDecision.HARD_DENY:
            self.logger.trace("security_hard_deny", {
                "tool": func_name, "reason": classification.reason,
            })
            return json.dumps({
                "error": f"[SECURITY] Blocked: {classification.reason}",
                "decision": "hard_deny",
            })

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
            perm = self._check_shell_permission(command)
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
                tool_result=result[:500],
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
                if parsed.get("decision") == "approved":
                    self.perms.mode = PermissionMode.DEFAULT
                    self.logger.info("[PLAN MODE] Approved — switched to default mode")
                # If rejected/modify, stay in plan mode
            except (json.JSONDecodeError, AttributeError):
                pass

        return result

    def _stream_llm_call(self, client, messages: list, tools_schema: list):
        """Execute LLM call with streaming, printing tokens as they arrive.

        Returns a response object compatible with the non-streaming path.
        """
        import sys

        effort_params = self.EFFORT_PARAMS.get(self.effort, self.EFFORT_PARAMS["medium"])

        def _do_stream():
            return client.chat.completions.create(
                model=self.model,
                messages=messages,
                tools=tools_schema,
                tool_choice="auto",
                max_completion_tokens=effort_params["max_completion_tokens"],
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
        tool_calls_data = {}
        finish_reason = None

        for chunk in response_stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            finish_reason = chunk.choices[0].finish_reason or finish_reason

            if delta.content:
                full_content += delta.content
                print(delta.content, end="", flush=True)

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
            print()  # newline after streaming

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

        def _model_dump():
            return {
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

        synthetic_message = _AttrBag(
            content=full_content or None,
            tool_calls=tool_calls_list if tool_calls_list else None,
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
                session_id=self.deps.uuid_generator,
                working_dir=os.getcwd(),
            )

        api_key = require_api_key()
        client = self.deps.llm_client_factory(
            api_key=api_key, base_url=MIMO_BASE_URL
        )
        self._llm_client = client  # Store for security pipeline model classifier

        # Inject memory as a user message (Claude Code pattern: memory is
        # context, not enforcement. Injected as user message after system
        # prompt for better prompt caching — stable system prefix, variable
        # memory in conversation.)
        if not self.bare:
            memory_content = load_memory(os.getcwd())
            if memory_content:
                session.add_message("user", f"## Project Memory\n{memory_content}")

        session.add_message("user", task)

        self.logger.info(f"\n{'='*60}")
        self.logger.info(f"Task: {task}")
        self.logger.info(f"Session: {self.logger.session_id}")
        self.logger.info(f"{'='*60}")

        start_time = time.time()
        tools_schema = self.registry.list_tools()
        system_msg = {"role": "system", "content": self._build_system_prompt()}
        effort_params = self.EFFORT_PARAMS.get(self.effort, self.EFFORT_PARAMS["medium"])

        # Reset circuit breaker for new task
        self.circuit_breaker.reset()
        # Reset thrashing warning flag for new task
        self._thrash_warned = False
        # L1: Reset thrashing counters for new task
        self._compaction_attempts = 0
        self._compaction_failures = 0

        for step in range(self.max_steps):
            # Termination check: graceful abort (Esc / Ctrl+C during execution)
            if self.graceful_abort.is_requested():
                self.logger.info("[ABORT] Graceful abort requested by user")
                self.graceful_abort.reset()
                self._last_session = session
                return "[ABORTED] Stopped by user request."

            # Termination check: time limit
            if time.time() - start_time > self.max_duration:
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

            # A8: Skip auto-compaction if thrashing detected
            if self._thrashing_detected:
                if not self._thrash_warned:
                    self.logger.info("[THRASHING] Compaction thrashing detected — auto-compaction disabled")
                    self._thrash_warned = True
            else:
                # Build messages with context compaction (token-based)
                conv_tokens = estimate_tokens(session.get_messages())
                compacted, self._compaction_attempts, self._compaction_failures, thrashing = compact_context(
                    session.get_messages(),
                    client=client,
                    model=self.model,
                    estimated_tokens=conv_tokens,
                    compaction_attempts=self._compaction_attempts,
                    compaction_failures=self._compaction_failures,
                )
                if thrashing:
                    self._thrashing_detected = True
                    self.logger.info("[THRASHING] Compaction not reducing size — thrashing detected")
                # If compression happened, update session messages so next
                # iteration uses the compressed context
                if len(compacted) < len(session.get_messages()):
                    pre_count = len(session.get_messages())
                    session.messages = compacted
                    session.compaction_count += 1
                    # Claude Code pattern: re-read memory/instructions from
                    # disk after compaction (not from stale extracted messages)
                    memory_content = load_memory_for_compaction()
                    if memory_content:
                        session.add_message("user", f"## Project Memory\n{memory_content}")
                    # Re-add the current user task — it was compressed away
                    session.add_message("user", task)
                    self.logger.info(
                        f"[COMPACT] {pre_count} msgs → "
                        f"{len(session.get_messages())} msgs, "
                        f"~{estimate_tokens(session.get_messages())} tokens"
                    )
            messages = [system_msg] + session.get_messages()

            # Token budget check (Ch7)
            self.token_budget.update(messages)
            if self.token_budget.is_blocked():
                self.logger.error("[TOKEN_LIMIT] Context window exceeded")
                self._last_session = session
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
                if self.stream:
                    response = self._stream_llm_call(
                        client, messages, tools_schema
                    )
                else:
                    response = retry_with_backoff(
                        lambda: client.chat.completions.create(
                            model=self.model,
                            messages=messages,
                            tools=tools_schema,
                            tool_choice="auto",
                            max_completion_tokens=effort_params["max_completion_tokens"],
                            temperature=effort_params["temperature"],
                            top_p=0.9,
                        ),
                        max_retries=self.deps.max_retries,
                        base_delay=self.deps.base_retry_delay,
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
                                max_completion_tokens=effort_params["max_completion_tokens"],
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
                        if self.circuit_breaker.check():
                            return f"[ERROR] Circuit breaker open after repeated failures: {fallback_err}"
                        continue
                else:
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
                if not self.stream:
                    self.logger.info(f"\nAgent: {final}")
                # Ch8: Fire Stop hook
                hook_runner = getattr(self, '_hook_runner', None)
                if hook_runner:
                    hook_runner.run_hooks(HookEvent.STOP, tool_result=final[:500])
                self.logger.session_summary({
                    "steps": step + 1,
                    "duration": round(time.time() - start_time, 2),
                    "reason": TerminationReason.COMPLETED.value,
                    "token_usage": round(self.token_budget.usage_ratio(), 2),
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
            session.add_message(msg_dict["role"], msg_dict["content"],
                              tool_calls=msg_dict.get("tool_calls"))

            # Group tool calls into concurrency-safe and sequential
            safe_calls = []
            sequential_calls = []
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

            # Execute concurrency-safe tools in parallel
            if safe_calls:
                with ThreadPoolExecutor(max_workers=min(len(safe_calls), 4)) as executor:
                    future_to_tc = {
                        executor.submit(
                            self._handle_tool_call, fn, fa, tc.id, session
                        ): tc
                        for tc, fn, fa in safe_calls
                    }
                    for future in as_completed(future_to_tc):
                        tc = future_to_tc[future]
                        try:
                            result = future.result()
                        except Exception as e:
                            result = json.dumps({"error": str(e)})
                        session.add_message("tool", result, tool_call_id=tc.id)

            # X2: Batch related edit/write operations together
            edit_calls = [(tc, fn, fa) for tc, fn, fa in sequential_calls if fn in ("edit_file", "write_file")]
            other_calls = [(tc, fn, fa) for tc, fn, fa in sequential_calls if fn not in ("edit_file", "write_file")]

            # Execute other sequential tools first
            for tc, func_name, func_args in other_calls:
                try:
                    result = self._handle_tool_call(
                        func_name, func_args, tc.id, session
                    )
                except Exception as e:
                    result = json.dumps({"error": str(e)})
                session.add_message("tool", result, tool_call_id=tc.id)

            # Execute edit/write tools as a batch if checkpoint manager available
            if edit_calls:
                checkpoint_mgr = getattr(self, "_checkpoint_manager", None)
                if checkpoint_mgr and len(edit_calls) > 1:
                    checkpoint_mgr.begin_batch()
                for tc, func_name, func_args in edit_calls:
                    try:
                        result = self._handle_tool_call(
                            func_name, func_args, tc.id, session
                        )
                    except Exception as e:
                        result = json.dumps({"error": str(e)})
                    session.add_message("tool", result, tool_call_id=tc.id)
                if checkpoint_mgr and len(edit_calls) > 1:
                    checkpoint_mgr.end_batch()

        # Termination: max steps reached
        self.logger.session_summary({
            "steps": self.max_steps,
            "duration": round(time.time() - start_time, 2),
            "reason": TerminationReason.MAX_STEPS.value,
        })
        self._last_session = session
        self._last_steps = self.max_steps
        return "[ERROR] Max steps reached."
