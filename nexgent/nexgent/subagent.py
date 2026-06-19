"""Sub-Agent system - lifecycle management, communication, and parallel execution.

Implements Claude Code Agent Team patterns:
- SubAgent lifecycle: create → run → communicate → complete → destroy
- Message passing between parent and child agents
- Parallel task execution with ThreadPoolExecutor
- Resource isolation and limits
- Result aggregation

Architecture:
  ParentAgent
      ├── SubAgent(task="research", ...)
      ├── SubAgent(task="write", ...)
      └── SubAgent(task="review", ...)

Each SubAgent:
  - Has its own session and message history
  - Can use a subset of tools (configurable)
  - Has its own token budget and step limits
  - Returns structured results to parent
"""

import os
import time
import uuid
import threading
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Optional, Any, Callable
from concurrent.futures import ThreadPoolExecutor, as_completed

from .logging_utils import TraceLogger


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DEFAULT_SUBAGENT_MAX_STEPS = 0       # 0 = unlimited (like NexgentAgent)
DEFAULT_SUBAGENT_MAX_DURATION = 0.0  # 0 = unlimited (like NexgentAgent)
DEFAULT_SUBAGENT_MAX_TOKENS = 0      # 0 = unlimited (like NexgentAgent)
MAX_CONCURRENT_SUBAGENTS = 5

# Warning thresholds (fraction of limit) — emit log but don't block
_RESOURCE_WARNING_RATIO = 0.80  # warn at 80% of any configured limit


# ---------------------------------------------------------------------------
# Resource Monitor — observe & warn, never hard-block
# ---------------------------------------------------------------------------
class ResourceMonitor:
    """Tracks SubAgent resource usage and emits warnings.

    Mirrors Claude Code's approach: monitor everything, warn when
    approaching thresholds, auto-compact when needed, but never
    hard-block execution.

    When limits are 0 (unlimited), monitoring still runs — it just
    never triggers warnings since there's no ceiling to approach.

    Thread-safe: all mutable state is protected by a lock.
    """

    def __init__(self, limits: "ResourceLimits", logger: TraceLogger = None):
        self.limits = limits
        self.logger = logger or TraceLogger()
        self._lock = threading.Lock()
        self._start_time = time.time()
        self._total_tokens = 0
        self._total_steps = 0
        self._subagent_count = 0
        self._warnings_issued: set[str] = set()  # dedup warnings
        self.on_warning: Optional[Callable[[str], None]] = None  # callback for TUI/REPL

    def record_subagent_finished(self, result: "SubAgentResult"):
        """Record metrics from a completed SubAgent."""
        with self._lock:
            self._total_tokens += result.token_usage
            self._total_steps += result.steps_taken
            self._subagent_count += 1
        self._check_and_warn()

    def record_tokens(self, tokens: int):
        """Record token usage (for live tracking within a run)."""
        with self._lock:
            self._total_tokens += tokens
        self._check_and_warn()

    def get_usage_report(self) -> dict:
        """Return current usage snapshot for logging/display."""
        with self._lock:
            elapsed = time.time() - self._start_time
            return {
                "total_tokens": self._total_tokens,
                "total_steps": self._total_steps,
                "subagent_count": self._subagent_count,
                "elapsed_seconds": round(elapsed, 1),
                "tokens_per_subagent": (
                    round(self._total_tokens / self._subagent_count)
                    if self._subagent_count > 0 else 0
                ),
            }

    def _check_and_warn(self):
        """Emit warnings when approaching configured limits (not unlimited)."""
        with self._lock:
            elapsed = time.time() - self._start_time
            warnings_to_emit: list[str] = []

            # Token warning
            if self.limits.max_total_tokens > 0:
                ratio = self._total_tokens / self.limits.max_total_tokens
                if ratio >= _RESOURCE_WARNING_RATIO and "tokens" not in self._warnings_issued:
                    self._warnings_issued.add("tokens")
                    warnings_to_emit.append(
                        f"[MONITOR] Token usage at {ratio:.0%} "
                        f"({self._total_tokens:,}/{self.limits.max_total_tokens:,})"
                    )

            # Time warning
            if self.limits.max_total_time > 0:
                ratio = elapsed / self.limits.max_total_time
                if ratio >= _RESOURCE_WARNING_RATIO and "time" not in self._warnings_issued:
                    self._warnings_issued.add("time")
                    warnings_to_emit.append(
                        f"[MONITOR] Time usage at {ratio:.0%} "
                        f"({elapsed:.0f}s/{self.limits.max_total_time:.0f}s)"
                    )

            # SubAgent count warning
            if self.limits.max_subagents > 0:
                ratio = self._subagent_count / self.limits.max_subagents
                if ratio >= _RESOURCE_WARNING_RATIO and "count" not in self._warnings_issued:
                    self._warnings_issued.add("count")
                    warnings_to_emit.append(
                        f"[MONITOR] SubAgent count at {ratio:.0%} "
                        f"({self._subagent_count}/{self.limits.max_subagents})"
                    )

        # Emit outside the lock to avoid holding it during I/O
        callback = self.on_warning  # snapshot to avoid TOCTOU
        for msg in warnings_to_emit:
            self.logger.warning(msg)
            if callback:
                callback(msg)


# ---------------------------------------------------------------------------
# SubAgent States
# ---------------------------------------------------------------------------
class SubAgentState(Enum):
    """Lifecycle states for a SubAgent."""
    CREATED = "created"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class SubAgentPriority(Enum):
    """Priority levels for subagent task scheduling."""
    LOW = 0
    NORMAL = 1
    HIGH = 2
    CRITICAL = 3


# ---------------------------------------------------------------------------
# SubAgent Result
# ---------------------------------------------------------------------------
@dataclass
class SubAgentResult:
    """Structured result from a SubAgent execution."""
    subagent_id: str
    task: str
    state: SubAgentState
    result: Optional[str] = None
    error: Optional[str] = None
    steps_taken: int = 0
    duration_seconds: float = 0.0
    token_usage: int = 0
    metadata: dict = field(default_factory=dict)

    @property
    def success(self) -> bool:
        return self.state == SubAgentState.COMPLETED

    def to_dict(self) -> dict:
        return {
            "subagent_id": self.subagent_id,
            "task": self.task,
            "state": self.state.value,
            "result": self.result,
            "error": self.error,
            "steps_taken": self.steps_taken,
            "duration_seconds": round(self.duration_seconds, 2),
            "token_usage": self.token_usage,
            "metadata": self.metadata,
        }


# ---------------------------------------------------------------------------
# SubAgent Configuration
# ---------------------------------------------------------------------------
@dataclass
class SubAgentConfig:
    """Configuration for a SubAgent instance.

    Attributes:
        task: The task description for the SubAgent to execute
        description: Human-readable description of the task
        max_steps: Maximum number of steps the SubAgent can take
        max_duration: Maximum duration in seconds
        max_tokens: Maximum token usage
        priority: Priority level for scheduling
        allowed_tools: List of allowed tool names (None = all tools)
        isolated: If True, create a new isolated session; if False, share parent's session
        auto_approve: Auto-approve tool calls without user confirmation
        effort: Effort level (low/medium/high)
        metadata: Additional metadata to attach to the result
    """
    task: str
    description: str = ""
    max_steps: int = DEFAULT_SUBAGENT_MAX_STEPS
    max_duration: float = DEFAULT_SUBAGENT_MAX_DURATION
    max_tokens: int = DEFAULT_SUBAGENT_MAX_TOKENS
    priority: SubAgentPriority = SubAgentPriority.NORMAL
    allowed_tools: Optional[list[str]] = None  # None = all tools
    isolated: bool = True  # If True, create new session; if False, share parent's session
    auto_approve: bool = False
    effort: str = "medium"
    metadata: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Message Channel (for parent-child communication)
# ---------------------------------------------------------------------------
class MessageChannel:
    """Thread-safe message channel between parent and SubAgent.

    Supports:
    - send/receive with blocking
    - message history
    - broadcast to all children
    - configurable max size to prevent memory leaks
    """

    def __init__(self, channel_id: str = None, max_size: int = 1000):
        self.channel_id = channel_id or str(uuid.uuid4())[:8]
        self._messages: list[dict] = []
        self._max_size = max_size
        self._lock = threading.Lock()
        self._condition = threading.Condition(self._lock)

    def send(self, sender: str, content: str, msg_type: str = "message"):
        """Send a message to the channel.

        Raises:
            RuntimeError: If channel is full
        """
        with self._condition:
            if len(self._messages) >= self._max_size:
                raise RuntimeError(f"MessageChannel full ({self._max_size} messages)")
            msg = {
                "id": str(uuid.uuid4())[:8],
                "sender": sender,
                "content": content,
                "type": msg_type,
                "timestamp": time.time(),
            }
            self._messages.append(msg)
            self._condition.notify()
        return msg

    def receive(self, timeout: float = None) -> Optional[dict]:
        """Receive the next message (blocking)."""
        with self._condition:
            if not self._messages:
                self._condition.wait(timeout=timeout)
            if self._messages:
                return self._messages.pop(0)
        return None

    def peek(self) -> Optional[dict]:
        """Peek at the next message without removing it."""
        with self._condition:
            return self._messages[0] if self._messages else None

    def get_history(self) -> list[dict]:
        """Get all messages in the channel."""
        with self._condition:
            return list(self._messages)

    def clear(self):
        """Clear all messages."""
        with self._condition:
            self._messages.clear()


# ---------------------------------------------------------------------------
# SubAgent
# ---------------------------------------------------------------------------
class SubAgent:
    """A sub-agent that runs a specific task in isolation.

    Lifecycle:
    1. CREATED: SubAgent is initialized
    2. RUNNING: SubAgent is executing its task
    3. COMPLETED/FAILED/CANCELLED: Terminal states

    Each SubAgent has:
    - Its own session (isolated from parent)
    - Its own token budget
    - A message channel for parent communication
    - Configurable tool access
    """

    def __init__(
        self,
        config: SubAgentConfig,
        parent_harness: Any = None,
        logger: TraceLogger = None,
    ):
        self.config = config
        self.subagent_id = str(uuid.uuid4())[:8]
        self.parent_harness = parent_harness
        self.logger = logger or TraceLogger()

        # Communication channel
        self.channel = MessageChannel(channel_id=self.subagent_id)

        # Thread-safe state/result storage
        self._state_lock = threading.Lock()
        self._state = SubAgentState.CREATED
        self.result: Optional[SubAgentResult] = None

        # Thread control
        self._thread: Optional[threading.Thread] = None
        self._cancel_event = threading.Event()

    @property
    def state(self):
        with self._state_lock:
            return self._state

    @state.setter
    def state(self, value):
        with self._state_lock:
            self._state = value

    # Thread-safe import cache
    _import_lock = threading.Lock()
    _imports_cached = False
    _NexgentAgent = None
    _AgentDeps = None
    _Session = None

    def run(self) -> SubAgentResult:
        """Execute the SubAgent's task synchronously.

        Returns a SubAgentResult with the task outcome.
        """
        self.state = SubAgentState.RUNNING
        start_time = time.time()

        self.logger.trace("subagent_start", {
            "subagent_id": self.subagent_id,
            "task": self.config.task,
        })

        try:
            # Import here to avoid circular imports (cached after first import, thread-safe)
            if not SubAgent._imports_cached:
                with SubAgent._import_lock:
                    if not SubAgent._imports_cached:
                        from .agent import NexgentAgent, AgentDeps
                        from .context import Session
                        from .tools.file_ops import FileOpsState, set_file_ops_state
                        SubAgent._NexgentAgent = NexgentAgent
                        SubAgent._AgentDeps = AgentDeps
                        SubAgent._Session = Session
                        SubAgent._imports_cached = True

            NexgentAgent = SubAgent._NexgentAgent
            AgentDeps = SubAgent._AgentDeps
            Session = SubAgent._Session

            # Create a child harness with limited capabilities
            child_harness = NexgentAgent(
                model=self.parent_harness.model if self.parent_harness else None,
                auto_approve=self.config.auto_approve,
                dry_run=self.parent_harness.perms.dry_run if self.parent_harness else False,
                max_steps=self.config.max_steps,
                max_duration=self.config.max_duration,
                verbose=False,
                deps=self.parent_harness.deps if self.parent_harness else AgentDeps(),
                plan_mode=False,
                stream=False,
                bare=True,  # Skip memory loading for subagents
                effort=self.config.effort,
                max_tokens=self.config.max_tokens,
            )

            # Inherit parent's hook runner so security/logging hooks apply
            if self.parent_harness and hasattr(self.parent_harness, '_hook_runner'):
                child_harness._hook_runner = self.parent_harness._hook_runner

            # Save parent's FileOpsState so we can restore it after the child runs.
            # child_harness.run() will create its own isolated FileOpsState.
            try:
                from .tools.file_ops import FileOpsState, get_file_ops_state, set_file_ops_state
                _parent_file_ops_state = get_file_ops_state()
            except ImportError:
                _parent_file_ops_state = None

            # Filter tools if allowed_tools is specified
            if self.config.allowed_tools is not None:
                self._filter_tools(child_harness, self.config.allowed_tools)

            # Create session (isolated or shared based on config)
            if self.config.isolated:
                session = Session(
                    session_id=f"sub-{self.subagent_id}",
                    working_dir=os.getcwd(),
                )
            else:
                # Use parent's session if available
                session = getattr(self.parent_harness, '_last_session', None)
                if session is None:
                    session = Session(
                        session_id=f"sub-{self.subagent_id}",
                        working_dir=os.getcwd(),
                    )

            # Check for cancellation before running
            if self._cancel_event.is_set():
                self.result = SubAgentResult(
                    subagent_id=self.subagent_id,
                    task=self.config.task,
                    state=SubAgentState.CANCELLED,
                    error="Cancelled before execution",
                    duration_seconds=time.time() - start_time,
                    metadata=self.config.metadata,
                )
                self.state = SubAgentState.CANCELLED
                return self.result

            # Run the task, then restore parent's FileOpsState
            try:
                result_text = child_harness.run(self.config.task, session)
            finally:
                if _parent_file_ops_state is not None:
                    set_file_ops_state(_parent_file_ops_state)

            # Determine success based on result
            is_success = (
                result_text is not None
                and not result_text.startswith("[ERROR]")
                and not result_text.startswith("[ABORTED]")
                and not result_text.startswith("[LIMIT]")
            )

            self.result = SubAgentResult(
                subagent_id=self.subagent_id,
                task=self.config.task,
                state=SubAgentState.COMPLETED if is_success else SubAgentState.FAILED,
                result=result_text,
                error=result_text if not is_success else None,
                steps_taken=getattr(child_harness, '_last_steps', 0),
                duration_seconds=time.time() - start_time,
                token_usage=child_harness.token_budget.estimated_tokens,
                metadata=self.config.metadata,
            )

            self.state = self.result.state

            # Check if cancellation was requested during execution
            if self._cancel_event.is_set():
                self.result.state = SubAgentState.CANCELLED
                self.state = SubAgentState.CANCELLED

        except BaseException as e:
            self.result = SubAgentResult(
                subagent_id=self.subagent_id,
                task=self.config.task,
                state=SubAgentState.CANCELLED if isinstance(e, (KeyboardInterrupt, SystemExit)) else SubAgentState.FAILED,
                error=str(e),
                duration_seconds=time.time() - start_time,
                metadata=self.config.metadata,
            )
            self.state = self.result.state
            if self.result.state == SubAgentState.FAILED:
                self.logger.error(f"SubAgent {self.subagent_id} failed: {e}")

        self.logger.trace("subagent_complete", {
            "subagent_id": self.subagent_id,
            "state": self.state.value,
            "duration": self.result.duration_seconds,
        })

        return self.result

    def run_async(self) -> threading.Thread:
        """Execute the SubAgent's task asynchronously.

        Returns the thread object for monitoring.
        """
        self._thread = threading.Thread(
            target=self.run,
            name=f"subagent-{self.subagent_id}",
            daemon=True,
        )
        self._thread.start()
        return self._thread

    def cancel(self):
        """Request cancellation of the SubAgent."""
        self._cancel_event.set()
        # Note: state transition to CANCELLED happens in run() when it checks _cancel_event.
        # Direct state mutation here is intentionally omitted to avoid race conditions
        # with the run() method which may be executing on another thread.

    def is_running(self) -> bool:
        """Check if the SubAgent is currently running."""
        return self.state == SubAgentState.RUNNING

    def is_terminal(self) -> bool:
        """Check if the SubAgent is in a terminal state."""
        return self.state in (
            SubAgentState.COMPLETED,
            SubAgentState.FAILED,
            SubAgentState.CANCELLED,
        )

    def wait(self, timeout: float = None) -> Optional[SubAgentResult]:
        """Wait for the SubAgent to complete and return its result.

        Args:
            timeout: Maximum time to wait in seconds (None = wait forever)

        Returns:
            SubAgentResult if completed, None if timed out
        """
        if self._thread:
            self._thread.join(timeout=timeout)
            if self._thread.is_alive():
                # Timed out - return current result (may be None)
                return self.result
        return self.result

    def send_message(self, content: str, msg_type: str = "message"):
        """Send a message to the parent via the channel."""
        return self.channel.send(f"subagent-{self.subagent_id}", content, msg_type)

    def receive_message(self, timeout: float = None) -> Optional[dict]:
        """Receive a message from the parent."""
        return self.channel.receive(timeout=timeout)

    def _filter_tools(self, harness: Any, allowed_tools: list[str]):
        """Filter the tool registry to only include allowed tools."""
        from .tools.registry import ToolRegistry

        filtered_registry = ToolRegistry()
        for tool_name in allowed_tools:
            tool_def = harness.registry.get(tool_name)
            if not tool_def:
                self.logger.warning("Tool '%s' not found in registry, skipping", tool_name)
                continue
            filtered_registry.register(tool_def)
        harness.registry = filtered_registry


# ---------------------------------------------------------------------------
# Resource Limits
# ---------------------------------------------------------------------------
@dataclass
class ResourceLimits:
    """Resource limits for SubAgent execution."""
    max_total_tokens: int = 0        # 0 = unlimited
    max_total_time: float = 0.0      # 0 = unlimited
    max_subagents: int = 0           # 0 = unlimited
    max_concurrent: int = MAX_CONCURRENT_SUBAGENTS

    def check_token_limit(self, current_usage: int) -> bool:
        """Check if token usage is within limits (0 = unlimited)."""
        return self.max_total_tokens == 0 or current_usage < self.max_total_tokens

    def check_time_limit(self, elapsed: float) -> bool:
        """Check if time elapsed is within limits (0 = unlimited)."""
        return self.max_total_time == 0 or elapsed < self.max_total_time

    def check_subagent_limit(self, count: int) -> bool:
        """Check if subagent count is within limits (0 = unlimited)."""
        return self.max_subagents == 0 or count < self.max_subagents


# ---------------------------------------------------------------------------
# SubAgentManager
# ---------------------------------------------------------------------------
class SubAgentManager:
    """Manages multiple SubAgents with scheduling and result aggregation.

    Features:
    - Create and track multiple SubAgents
    - Parallel execution with configurable concurrency
    - Priority-based scheduling
    - Result aggregation
    - Resource limits (total tokens, total time)
    - Advanced scheduling strategies
    """

    def __init__(
        self,
        parent_harness: Any = None,
        max_concurrent: int = MAX_CONCURRENT_SUBAGENTS,
        logger: TraceLogger = None,
        resource_limits: ResourceLimits = None,
    ):
        self.parent_harness = parent_harness
        self.max_concurrent = max_concurrent
        self.logger = logger or TraceLogger()
        self.resource_limits = resource_limits or ResourceLimits(max_concurrent=max_concurrent)

        # SubAgent tracking
        self._subagents: dict[str, SubAgent] = {}
        self._results: dict[str, SubAgentResult] = {}
        self._lock = threading.Lock()

        # Resource tracking
        self._total_tokens_used = 0
        self._total_time_elapsed = 0.0
        self._start_time = time.time()

        # Resource monitor — observe & warn, never hard-block
        self.resource_monitor = ResourceMonitor(self.resource_limits, self.logger)

        # Broadcast channel for parent to all children
        self.broadcast_channel = MessageChannel(channel_id="broadcast")

    def _check_resource_limits(self) -> Optional[str]:
        """Check if hard resource limits are exceeded (acquires lock)."""
        with self._lock:
            return self._check_resource_limits_locked()

    def _check_resource_limits_locked(self) -> Optional[str]:
        """Check if hard resource limits are exceeded (caller must hold self._lock)."""
        elapsed = time.time() - self._start_time
        # Count active (non-terminal) subagents for limit check
        subagent_count = sum(1 for sa in self._subagents.values() if not sa.is_terminal())
        token_usage = self._total_tokens_used

        if not self.resource_limits.check_time_limit(elapsed):
            msg = f"Time limit exceeded ({elapsed:.1f}s >= {self.resource_limits.max_total_time}s)"
            self.logger.warning(f"[LIMIT] {msg}")
            return msg
        if not self.resource_limits.check_token_limit(token_usage):
            msg = f"Token limit exceeded ({token_usage} >= {self.resource_limits.max_total_tokens})"
            self.logger.warning(f"[LIMIT] {msg}")
            return msg
        if not self.resource_limits.check_subagent_limit(subagent_count):
            msg = f"SubAgent limit exceeded ({subagent_count} >= {self.resource_limits.max_subagents})"
            self.logger.warning(f"[LIMIT] {msg}")
            return msg
        return None

    def create_subagent(self, config: SubAgentConfig) -> SubAgent:
        """Create a new SubAgent.

        Raises:
            RuntimeError: If resource limits are exceeded
        """
        subagent = SubAgent(
            config=config,
            parent_harness=self.parent_harness,
            logger=self.logger,
        )

        # Atomic: check limits + register under single lock (prevents TOCTOU)
        with self._lock:
            limit_error = self._check_resource_limits_locked()
            if limit_error:
                raise RuntimeError(f"Cannot create SubAgent: {limit_error}")
            self._subagents[subagent.subagent_id] = subagent

        self.logger.trace("subagent_created", {
            "subagent_id": subagent.subagent_id,
            "task": config.task,
        })

        return subagent

    def run_single(self, config: SubAgentConfig) -> SubAgentResult:
        """Create and run a single SubAgent synchronously."""
        subagent = self.create_subagent(config)
        result = subagent.run()

        with self._lock:
            self._results[subagent.subagent_id] = result
            self._total_tokens_used += result.token_usage
            self._total_time_elapsed += result.duration_seconds

        # Feed monitor — triggers warnings at 80% of configured limits
        self.resource_monitor.record_subagent_finished(result)

        return result

    def run_parallel(self, configs: list[SubAgentConfig]) -> list[SubAgentResult]:
        """Run multiple SubAgents in parallel.

        Args:
            configs: List of SubAgentConfig for each SubAgent

        Returns:
            List of SubAgentResult in the same order as configs
        """
        # Create all subagents; on failure, clean up already-created ones
        subagents = []
        try:
            for config in configs:
                subagents.append(self.create_subagent(config))
        except Exception:
            # Clean up already-created subagents to avoid leaking CREATED state
            for sa in subagents:
                with self._lock:
                    self._subagents.pop(sa.subagent_id, None)
            raise

        # Sort by priority (higher priority first), preserving original indices
        indexed_subagents = list(enumerate(subagents))
        indexed_subagents.sort(key=lambda x: x[1].config.priority.value, reverse=True)

        self.logger.info(f"Running {len(subagents)} SubAgents in parallel (max_concurrent={self.max_concurrent})")

        results = [None] * len(subagents)

        with ThreadPoolExecutor(max_workers=self.max_concurrent) as executor:
            # Submit all tasks, mapping future to original index
            future_to_orig_idx = {}
            for orig_idx, subagent in indexed_subagents:
                future = executor.submit(subagent.run)
                future_to_orig_idx[future] = orig_idx

            # Collect results as they complete
            for future in as_completed(future_to_orig_idx):
                orig_idx = future_to_orig_idx[future]
                try:
                    result = future.result()
                    results[orig_idx] = result

                    with self._lock:
                        self._results[subagents[orig_idx].subagent_id] = result
                        self._total_tokens_used += result.token_usage
                        self._total_time_elapsed += result.duration_seconds

                    # Feed monitor — triggers warnings at 80% of configured limits
                    self.resource_monitor.record_subagent_finished(result)

                    self.logger.trace("subagent_result", {
                        "subagent_id": subagents[orig_idx].subagent_id,
                        "state": result.state.value,
                    })

                except BaseException as e:
                    # Create error result with exception type
                    # Use BaseException to catch CancelledError (which inherits from BaseException, not Exception)
                    error_result = SubAgentResult(
                        subagent_id=subagents[orig_idx].subagent_id,
                        task=subagents[orig_idx].config.task,
                        state=SubAgentState.FAILED,
                        error=f"{type(e).__name__}: {e}",
                    )
                    results[orig_idx] = error_result

                    with self._lock:
                        self._results[subagents[orig_idx].subagent_id] = error_result

                    # Feed monitor on failure too — count matters for warnings
                    self.resource_monitor.record_subagent_finished(error_result)

                    self.logger.error(f"SubAgent {subagents[orig_idx].subagent_id} failed: {e}")

        return results

    def run_pipeline(self, configs: list[SubAgentConfig]) -> list[SubAgentResult]:
        """Run SubAgents in pipeline mode (sequential, each gets previous results).

        Args:
            configs: List of SubAgentConfig for each stage

        Returns:
            List of SubAgentResult for each stage
        """
        results = []
        previous_context = ""
        _MAX_CONTEXT_CHARS = 50000  # Limit accumulated context to prevent token overflow

        for idx, config in enumerate(configs):
            # Add previous results to the task context (monitor warns on size)
            if previous_context:
                # Truncate context if it exceeds limit
                ctx = previous_context
                if len(ctx) > _MAX_CONTEXT_CHARS:
                    ctx = ctx[-_MAX_CONTEXT_CHARS:]
                    ctx = f"... (truncated)\n{ctx}"
                enhanced_task = f"{config.task}\n\n## Previous Stage Results\n{ctx}"
                enhanced_config = replace(config, task=enhanced_task)
            else:
                enhanced_config = config

            stage_label = config.description or config.task[:50] or "(unnamed)"
            self.logger.info(f"Pipeline stage {idx + 1}/{len(configs)}: {stage_label}")

            try:
                result = self.run_single(enhanced_config)
            except Exception as e:
                # Resource limit or other creation failure — treat as stage failure
                result = SubAgentResult(
                    subagent_id=f"error-{idx}",
                    task=config.task,
                    state=SubAgentState.FAILED,
                    error=f"{type(e).__name__}: {e}",
                )
            results.append(result)

            # Update context for next stage
            if result.success and result.result:
                previous_context = result.result
            else:
                self.logger.warning(f"Pipeline stage {idx + 1} failed: {result.error}")
                # Mark remaining stages as skipped (stale context is misleading)
                for remaining_idx in range(idx + 1, len(configs)):
                    results.append(SubAgentResult(
                        subagent_id=f"skipped-{remaining_idx}",
                        task=configs[remaining_idx].task,
                        state=SubAgentState.FAILED,
                        error=f"Skipped — stage {idx + 1} failed",
                    ))
                break

        return results

    def get_subagent(self, subagent_id: str) -> Optional[SubAgent]:
        """Get a SubAgent by ID."""
        with self._lock:
            return self._subagents.get(subagent_id)

    def get_result(self, subagent_id: str) -> Optional[SubAgentResult]:
        """Get a SubAgent's result by ID."""
        with self._lock:
            return self._results.get(subagent_id)

    def get_all_results(self) -> list[SubAgentResult]:
        """Get all SubAgent results."""
        with self._lock:
            return list(self._results.values())

    def get_running_count(self) -> int:
        """Get the number of currently running SubAgents."""
        with self._lock:
            return sum(1 for sa in self._subagents.values() if sa.is_running())

    def cancel_all(self):
        """Cancel all running SubAgents."""
        with self._lock:
            for subagent in self._subagents.values():
                if subagent.is_running():
                    subagent.cancel()

    def get_resource_summary(self) -> dict:
        """Get a summary of resource usage including monitor data."""
        with self._lock:
            base = {
                "total_subagents": len(self._subagents),
                "running": sum(1 for sa in self._subagents.values() if sa.is_running()),
                "completed": sum(1 for r in self._results.values() if r.success),
                "failed": sum(1 for r in self._results.values() if not r.success),
                "total_tokens_used": self._total_tokens_used,
                "total_time_elapsed": round(self._total_time_elapsed, 2),
            }
        # Merge monitor report (includes tokens_per_subagent, etc.)
        base.update(self.resource_monitor.get_usage_report())
        return base

    def aggregate_results(self, results: list[SubAgentResult]) -> dict:
        """Aggregate multiple SubAgent results into a summary.

        Args:
            results: List of SubAgentResult to aggregate

        Returns:
            Aggregated summary dictionary
        """
        successful = [r for r in results if r.success]
        failed = [r for r in results if not r.success]

        # Calculate statistics
        total_tokens = sum(r.token_usage for r in results)
        total_duration = sum(r.duration_seconds for r in results)
        avg_duration = total_duration / len(results) if results else 0
        max_duration = max((r.duration_seconds for r in results), default=0)
        min_duration = min((r.duration_seconds for r in results), default=0)

        return {
            "total": len(results),
            "successful": len(successful),
            "failed": len(failed),
            "success_rate": len(successful) / len(results) if results else 0,
            "total_tokens": total_tokens,
            "avg_tokens": total_tokens / len(results) if results else 0,
            "total_duration": round(total_duration, 2),
            "avg_duration": round(avg_duration, 2),
            "max_duration": round(max_duration, 2),
            "min_duration": round(min_duration, 2),
            "results": [r.to_dict() for r in results],
            "combined_output": "\n\n---\n\n".join(
                f"## Task: {r.task}\n\n{r.result}"
                for r in successful
                if r.result
            ),
            "errors": [
                {"subagent_id": r.subagent_id, "task": r.task, "error": r.error}
                for r in failed
                if r.error
            ],
        }

    def get_performance_stats(self) -> dict:
        """Get performance statistics for all SubAgents.

        Returns:
            Performance statistics dictionary
        """
        with self._lock:
            results = list(self._results.values())
            total_tokens = self._total_tokens_used
            total_time = self._total_time_elapsed
            start_time = self._start_time

        if not results:
            return {"message": "No SubAgent results available"}

        successful = [r for r in results if r.success]
        failed = [r for r in results if not r.success]

        # Calculate percentiles
        durations = sorted(r.duration_seconds for r in results)
        tokens = sorted(r.token_usage for r in results)

        def percentile(data, p):
            if not data:
                return 0
            k = (len(data) - 1) * p / 100
            f = int(k)
            c = f + 1
            if c >= len(data):
                return data[f]
            return data[f] + (k - f) * (data[c] - data[f])

        return {
            "total_subagents": len(results),
            "success_rate": len(successful) / len(results) * 100,
            "duration_stats": {
                "min": round(min(durations), 2) if durations else 0,
                "max": round(max(durations), 2) if durations else 0,
                "avg": round(sum(durations) / len(durations), 2) if durations else 0,
                "p50": round(percentile(durations, 50), 2),
                "p90": round(percentile(durations, 90), 2),
                "p99": round(percentile(durations, 99), 2),
            },
            "token_stats": {
                "min": min(tokens) if tokens else 0,
                "max": max(tokens) if tokens else 0,
                "avg": round(sum(tokens) / len(tokens)) if tokens else 0,
                "p50": round(percentile(tokens, 50)),
                "p90": round(percentile(tokens, 90)),
                "p99": round(percentile(tokens, 99)),
            },
            "resource_usage": {
                "total_tokens": total_tokens,
                "total_time": round(total_time, 2),
                "elapsed_since_start": round(time.time() - start_time, 2),
            },
        }


# ---------------------------------------------------------------------------
# Convenience Functions
# ---------------------------------------------------------------------------
def create_subagent(
    task: str,
    description: str = "",
    max_steps: int = DEFAULT_SUBAGENT_MAX_STEPS,
    allowed_tools: list[str] = None,
    effort: str = "medium",
) -> SubAgentConfig:
    """Create a SubAgentConfig with common defaults."""
    return SubAgentConfig(
        task=task,
        description=description,
        max_steps=max_steps,
        allowed_tools=allowed_tools,
        effort=effort,
    )


def run_parallel_tasks(
    tasks: list[str],
    parent_harness: Any = None,
    max_concurrent: int = MAX_CONCURRENT_SUBAGENTS,
) -> list[SubAgentResult]:
    """Run multiple tasks in parallel using SubAgents.

    Args:
        tasks: List of task descriptions
        parent_harness: Parent NexgentAgent instance
        max_concurrent: Maximum concurrent SubAgents

    Returns:
        List of SubAgentResult
    """
    manager = SubAgentManager(
        parent_harness=parent_harness,
        max_concurrent=max_concurrent,
    )
    configs = [SubAgentConfig(task=task) for task in tasks]
    return manager.run_parallel(configs)


def run_pipeline_tasks(
    stages: list[dict],
    parent_harness: Any = None,
) -> list[SubAgentResult]:
    """Run tasks in pipeline mode (sequential with context passing).

    Args:
        stages: List of dicts with 'task' and optional 'description', 'allowed_tools'
        parent_harness: Parent NexgentAgent instance

    Returns:
        List of SubAgentResult
    """
    manager = SubAgentManager(parent_harness=parent_harness)
    configs = [
        SubAgentConfig(
            task=stage["task"],
            description=stage.get("description", ""),
            allowed_tools=stage.get("allowed_tools"),
        )
        for stage in stages
    ]
    return manager.run_pipeline(configs)
