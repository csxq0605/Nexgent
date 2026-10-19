"""Workflow engine — orchestrate many SubAgents from a script.

Implements Claude Code Dynamic Workflows patterns:
- Pipeline: each item passes through all stages independently, no barrier
- Parallel: barrier — all thunks run concurrently, await all before returning
- Phase: progress grouping for display
- Budget: hard token ceiling across all agents
- Resumability: completed agents return cached results on resume
- Quality patterns: adversarial verify, multi-perspective, loop-until-dry

Architecture:
  WorkflowRunner
      ├── run(script, args) → WorkflowRun
      ├── resume(run_id) → WorkflowRun
      ├── save(run_id, name)
      └── list_runs() → list[WorkflowRun]

  WorkflowContext (DSL injected into script)
      ├── agent(prompt, **opts) → str
      ├── pipeline(items, *stages) → list
      ├── parallel(thunks) → list
      ├── phase(title)
      └── log(message)
"""

import os
import time
import uuid
import json
import asyncio
import inspect
import threading
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional, Callable
from concurrent.futures import ThreadPoolExecutor, as_completed

from .logging_utils import TraceLogger


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DEFAULT_MAX_CONCURRENT_AGENTS = 10
DEFAULT_MAX_AGENTS_PER_RUN = 1000
BUDGET_SAFETY_MARGIN = 5000  # reserve tokens for overhead


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------
class WorkflowStatus(Enum):
    PENDING = "pending"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"


class AgentStatus(Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------
@dataclass
class AgentRunResult:
    """Result from a single agent execution within a workflow."""
    agent_id: str
    label: str
    phase: str
    prompt: str
    result: Optional[str] = None
    status: AgentStatus = AgentStatus.PENDING
    token_usage: int = 0
    duration: float = 0.0
    error: Optional[str] = None
    model: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "agent_id": self.agent_id,
            "label": self.label,
            "phase": self.phase,
            "prompt": self.prompt[:200],
            "status": self.status.value,
            "token_usage": self.token_usage,
            "duration": round(self.duration, 2),
            "error": self.error,
        }


@dataclass
class PhaseResult:
    """Result from a workflow phase."""
    title: str
    agent_ids: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "title": self.title,
            "agent_count": len(self.agent_ids),
        }


@dataclass
class Budget:
    """Token budget for a workflow run."""
    total: Optional[int] = None  # None = unlimited
    spent: int = 0

    def remaining(self) -> int:
        if self.total is None:
            return float("inf")
        return max(0, self.total - self.spent)

    def record(self, tokens: int):
        self.spent += tokens
        if self.total is not None and self.spent >= self.total:
            raise BudgetExhausted(
                f"Budget exhausted: {self.spent}/{self.total} tokens spent"
            )

    def to_dict(self) -> dict:
        return {
            "total": self.total,
            "spent": self.spent,
            "remaining": self.remaining() if self.total is not None else "unlimited",
        }


class BudgetExhausted(Exception):
    """Raised when the workflow's token budget is exhausted."""
    pass


@dataclass
class WorkflowRun:
    """Tracks a single workflow execution."""
    run_id: str
    script_path: str
    script_source: str
    status: WorkflowStatus = WorkflowStatus.PENDING
    phases: list[PhaseResult] = field(default_factory=list)
    agents: dict[str, AgentRunResult] = field(default_factory=dict)
    budget: Budget = field(default_factory=Budget)
    started_at: float = 0.0
    finished_at: float = 0.0
    error: Optional[str] = None
    result: Any = None
    args: Any = None

    # Cache for resumability: agent_id → result text
    _cached_results: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "run_id": self.run_id,
            "script_path": self.script_path,
            "status": self.status.value,
            "phases": [p.to_dict() for p in self.phases],
            "agent_count": len(self.agents),
            "completed_agents": sum(
                1 for a in self.agents.values()
                if a.status == AgentStatus.COMPLETED
            ),
            "budget": self.budget.to_dict(),
            "started_at": self.started_at,
            "duration": round(
                (self.finished_at or time.time()) - self.started_at, 2
            ) if self.started_at else 0,
            "error": self.error,
        }


# ---------------------------------------------------------------------------
# WorkflowContext — DSL for workflow scripts
# ---------------------------------------------------------------------------
class WorkflowContext:
    """Execution context injected into workflow scripts as ``ctx``.

    Provides DSL functions: agent(), pipeline(), parallel(), phase(), log().
    """

    def __init__(
        self,
        runner: "WorkflowRunner",
        run: WorkflowRun,
        loop: asyncio.AbstractEventLoop,
    ):
        self._runner = runner
        self._run = run
        self._loop = loop
        self._current_phase = ""
        self._agent_counter = 0
        self._progress_callbacks: list[Callable] = []

    @property
    def budget(self) -> Budget:
        return self._run.budget

    def on_progress(self, callback: Callable):
        """Register a progress callback: callback(message: str)."""
        self._progress_callbacks.append(callback)

    def log(self, message: str):
        """Emit a progress message."""
        for cb in self._progress_callbacks:
            try:
                cb(message)
            except Exception:
                pass

    def phase(self, title: str):
        """Start a new phase. Subsequent agent() calls are grouped under it."""
        self._current_phase = title
        phase_result = PhaseResult(title=title)
        self._run.phases.append(phase_result)
        self.log(f"▸ Phase: {title}")

    async def agent(
        self,
        prompt: str,
        *,
        label: str = None,
        phase: str = None,
        model: str = None,
        tools: list[str] = None,
    ) -> Optional[str]:
        """Spawn a sub-agent and return its final text result.

        Args:
            prompt: The task for the agent.
            label: Human-readable label for progress display.
            phase: Phase name (defaults to current phase).
            model: Model override (optional).
            tools: Allowed tools (optional).

        Returns:
            The agent's final text, or None if it failed/skipped.
        """
        self._agent_counter += 1
        if self._agent_counter > DEFAULT_MAX_AGENTS_PER_RUN:
            self.log(f"⚠ Agent limit reached ({DEFAULT_MAX_AGENTS_PER_RUN}), skipping")
            return None

        agent_id = f"agent-{self._agent_counter:04d}"
        agent_label = label or f"agent-{self._agent_counter}"
        agent_phase = phase or self._current_phase or "default"

        # Ensure phase exists
        if not self._run.phases or self._run.phases[-1].title != agent_phase:
            self._run.phases.append(PhaseResult(title=agent_phase))
        self._run.phases[-1].agent_ids.append(agent_id)

        # Check cache (for resume)
        if agent_id in self._run._cached_results:
            self.log(f"  ↩ {agent_label} (cached)")
            return self._run._cached_results[agent_id]

        # Check budget
        if self._run.budget.total is not None and self._run.budget.remaining() <= BUDGET_SAFETY_MARGIN:
            self.log(f"  ⚠ Budget near limit, skipping {agent_label}")
            result_record = AgentRunResult(
                agent_id=agent_id,
                label=agent_label,
                phase=agent_phase,
                prompt=prompt,
                status=AgentStatus.SKIPPED,
            )
            self._run.agents[agent_id] = result_record
            return None

        # Create result record
        result_record = AgentRunResult(
            agent_id=agent_id,
            label=agent_label,
            phase=agent_phase,
            prompt=prompt,
            status=AgentStatus.RUNNING,
            model=model,
        )
        self._run.agents[agent_id] = result_record

        self.log(f"  ▸ {agent_label}")
        start_time = time.time()

        try:
            # Run agent in thread pool via SubAgentManager
            result_text = await self._loop.run_in_executor(
                None,
                self._runner._run_single_agent,
                prompt,
                tools,
                model,
            )

            duration = time.time() - start_time
            result_record.result = result_text
            result_record.status = AgentStatus.COMPLETED
            result_record.duration = duration

            # Estimate token usage (rough: 4 chars ≈ 1 token)
            est_tokens = len(result_text or "") // 4
            result_record.token_usage = est_tokens
            self._run.budget.record(est_tokens)

            # Cache for resume
            self._run._cached_results[agent_id] = result_text

            self.log(f"  ✓ {agent_label} ({duration:.1f}s)")
            return result_text

        except BudgetExhausted:
            result_record.status = AgentStatus.SKIPPED
            result_record.duration = time.time() - start_time
            self.log(f"  ⚠ {agent_label} skipped (budget exhausted)")
            raise

        except Exception as e:
            duration = time.time() - start_time
            result_record.status = AgentStatus.FAILED
            result_record.duration = duration
            result_record.error = str(e)
            self.log(f"  ✗ {agent_label} failed: {e}")
            return None

    async def pipeline(
        self,
        items: list,
        *stages: Callable,
    ) -> list:
        """Pipeline: each item passes through all stages independently.

        No barrier between stages — item A can be in stage 3 while
        item B is still in stage 1.

        Args:
            items: List of items to process.
            *stages: Stage functions, each taking (prev_result, original_item, index).

        Returns:
            List of final results, one per item. Failed items are None.
        """
        if not items or not stages:
            return []

        async def _run_item(idx: int, item: Any) -> Any:
            current = item
            for stage_fn in stages:
                try:
                    if asyncio.iscoroutinefunction(stage_fn):
                        current = await stage_fn(current, item, idx)
                    else:
                        result = await self._loop.run_in_executor(
                            None, stage_fn, current, item, idx
                        )
                        current = await result if inspect.isawaitable(result) else result
                except Exception as e:
                    self.log(f"  ✗ pipeline item {idx} failed: {e}")
                    return None
            return current

        # Run all items concurrently
        tasks = [_run_item(i, item) for i, item in enumerate(items)]
        return await asyncio.gather(*tasks, return_exceptions=False)

    async def parallel(
        self,
        thunks: list,
    ) -> list:
        """Parallel barrier: all thunks run concurrently, await all.

        Args:
            thunks: List of no-arg callables (lambdas) that return awaitables.

        Returns:
            List of results in the same order. Failed thunks are None.
        """
        if not thunks:
            return []

        async def _safe_call(idx: int, thunk) -> Any:
            try:
                if asyncio.iscoroutinefunction(thunk):
                    return await thunk()
                else:
                    # It might return a coroutine
                    result = thunk()
                    if asyncio.iscoroutine(result):
                        return await result
                    return result
            except Exception as e:
                self.log(f"  ✗ parallel[{idx}] failed: {e}")
                return None

        tasks = [_safe_call(i, t) for i, t in enumerate(thunks)]
        return await asyncio.gather(*tasks, return_exceptions=False)


# ---------------------------------------------------------------------------
# WorkflowRunner — executes workflow scripts
# ---------------------------------------------------------------------------
class WorkflowRunner:
    """Executes workflow scripts and manages their lifecycle.

    Args:
        parent_harness: The NexgentAgent instance for spawning sub-agents.
        max_concurrent: Max concurrent agents per workflow.
    """

    def __init__(
        self,
        parent_harness: Any,
        max_concurrent: int = DEFAULT_MAX_CONCURRENT_AGENTS,
        logger: TraceLogger = None,
    ):
        self.parent_harness = parent_harness
        self.max_concurrent = max_concurrent
        self.logger = logger or TraceLogger()

        self._runs: dict[str, WorkflowRun] = {}
        self._lock = threading.Lock()

    def _run_single_agent(
        self,
        prompt: str,
        tools: Optional[list[str]] = None,
        model: Optional[str] = None,
    ) -> str:
        """Run a single agent synchronously (called from thread pool)."""
        from .subagent import SubAgentConfig, SubAgentManager

        config = SubAgentConfig(
            task=prompt,
            description="workflow-agent",
            allowed_tools=tools,
            model=model,
            auto_approve=True,
            isolated=True,
        )

        manager = SubAgentManager(
            parent_harness=self.parent_harness,
            max_concurrent=1,
            logger=self.logger,
            event_callback=getattr(
                self.parent_harness, "_subagent_event_callback", None
            ),
            session_dir=getattr(self.parent_harness, "_subagent_session_dir", None),
        )

        result = manager.run_single(config)

        if result.success:
            return result.result or ""
        else:
            raise RuntimeError(f"Agent failed: {result.error}")

    def run(
        self,
        script_source: str,
        *,
        script_path: str = "<inline>",
        args: Any = None,
        budget_total: Optional[int] = None,
        progress_callback: Callable[[str], None] = None,
    ) -> WorkflowRun:
        """Execute a workflow script synchronously.

        Args:
            script_source: Python source code of the workflow script.
            script_path: Path for display (doesn't need to exist).
            args: Arguments passed to the script as ``args`` global.
            budget_total: Token budget limit (None = unlimited).
            progress_callback: Called with progress messages.

        Returns:
            WorkflowRun with results.
        """
        run_id = f"wf-{uuid.uuid4().hex[:8]}"
        run = WorkflowRun(
            run_id=run_id,
            script_path=script_path,
            script_source=script_source,
            budget=Budget(total=budget_total),
            args=args,
        )

        with self._lock:
            self._runs[run_id] = run

        run.status = WorkflowStatus.RUNNING
        run.started_at = time.time()

        try:
            self._execute_script(run, progress_callback)
            run.status = WorkflowStatus.COMPLETED
        except BudgetExhausted:
            run.status = WorkflowStatus.PAUSED
            run.error = "budget_exhausted"
            self.logger.info(f"Workflow {run_id} paused (budget exhausted)")
        except Exception as e:
            run.status = WorkflowStatus.FAILED
            run.error = str(e)
            self.logger.error(f"Workflow {run_id} failed: {e}")
        finally:
            run.finished_at = time.time()

        return run

    def _execute_script(
        self,
        run: WorkflowRun,
        progress_callback: Optional[Callable],
    ):
        """Execute the workflow script in an async event loop."""
        loop = asyncio.new_event_loop()
        try:
            ctx = WorkflowContext(
                runner=self,
                run=run,
                loop=loop,
            )
            if progress_callback:
                ctx.on_progress(progress_callback)

            # Prepare script globals
            script_globals = {
                "__builtins__": __builtins__,
                "ctx": ctx,
                "args": run.args,
                "agent": ctx.agent,
                "pipeline": ctx.pipeline,
                "parallel": ctx.parallel,
                "phase": ctx.phase,
                "log": ctx.log,
                "asyncio": asyncio,
            }

            # Execute the script
            exec(run.script_source, script_globals)

            # If the script defines a main() function, call it
            main_fn = script_globals.get("main")
            if main_fn and callable(main_fn):
                if asyncio.iscoroutinefunction(main_fn):
                    result = loop.run_until_complete(main_fn(ctx, run.args))
                else:
                    result = main_fn(ctx, run.args)
                run.result = result

        finally:
            loop.close()

    def resume(
        self,
        run_id: str,
        progress_callback: Callable[[str], None] = None,
    ) -> WorkflowRun:
        """Resume a paused or failed workflow from cached results.

        Completed agents return their cached results immediately;
        only failed/skipped agents are re-run.
        """
        with self._lock:
            run = self._runs.get(run_id)
        if not run:
            raise ValueError(f"Workflow run {run_id} not found")

        # Reset failed/skipped agents so they re-run
        for agent in run.agents.values():
            if agent.status in (AgentStatus.FAILED, AgentStatus.SKIPPED):
                agent.status = AgentStatus.PENDING
                agent.result = None
                agent.error = None

        run.status = WorkflowStatus.RUNNING
        run.started_at = time.time()
        run.error = None

        try:
            self._execute_script(run, progress_callback)
            run.status = WorkflowStatus.COMPLETED
        except BudgetExhausted:
            run.status = WorkflowStatus.PAUSED
            run.error = "budget_exhausted"
        except Exception as e:
            run.status = WorkflowStatus.FAILED
            run.error = str(e)
        finally:
            run.finished_at = time.time()

        return run

    def get_run(self, run_id: str) -> Optional[WorkflowRun]:
        """Get a workflow run by ID."""
        with self._lock:
            return self._runs.get(run_id)

    def list_runs(self) -> list[WorkflowRun]:
        """List all workflow runs."""
        with self._lock:
            return list(self._runs.values())

    def save_workflow(self, run_id: str, name: str, save_dir: str = None):
        """Save a workflow script as a reusable command file.

        Args:
            run_id: The run ID to save.
            name: Command name (used as filename).
            save_dir: Directory to save to. Defaults to .claude/workflows/.
        """
        with self._lock:
            run = self._runs.get(run_id)
        if not run:
            raise ValueError(f"Workflow run {run_id} not found")

        if save_dir is None:
            save_dir = os.path.join(".claude", "workflows")

        os.makedirs(save_dir, exist_ok=True)
        filepath = os.path.join(save_dir, f"{name}.py")

        with open(filepath, "w", encoding="utf-8") as f:
            f.write(run.script_source)

        self.logger.info(f"Workflow saved to {filepath}")
        return filepath

    def run_typed(
        self,
        graph,
        executors: dict[str, Callable],
        store,
        *,
        external_inputs: Optional[dict[str, Any]] = None,
        progress_callback: Optional[Callable[[dict[str, Any]], None]] = None,
    ):
        """Run or resume a durable typed workflow through the shared engine.

        This is the migration boundary for the legacy Python DSL: callers that
        need crash-safe execution declare ``WorkflowNode`` contracts and use
        this method.  Re-instantiating ``WorkflowRunner`` with the same graph
        and store resumes successful idempotent primitives from SQLite.
        """

        from .runtime.graph import PersistentTypedDAGRunner

        runner = PersistentTypedDAGRunner(
            graph,
            executors,
            store,
            event_callback=progress_callback,
        )
        return asyncio.run(runner.run(external_inputs or {}))
