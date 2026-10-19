"""Nexgent - a traceable, self-diagnosing Coding Harness.

The current package provides a model-agnostic Harness foundation while the
long-running execution layer adds typed run state, dependency tracing,
controlled fault recovery, and independently verified reruns. Existing building blocks:
- Ch2: Dependency injection, circuit breaker, state machine
- Ch3: Fail-closed tool defaults, concurrency markers, input validation
- Ch4: 4-stage permission pipeline, rule-based matching
- Ch6: Typed memory system, MEMORY.md index
- Ch7: Progressive context compression, token budget
- Ch8: Hook system with lifecycle events
- SubAgent: Multi-agent coordination with lifecycle management
"""

__version__ = "0.5.0"

from .agent import NexgentAgent, AgentDeps, CircuitBreaker, TokenBudget
from .permissions import PermissionGate, Permission, PermissionMode, PermissionRule
from .context import Session, compact_context, load_memory
from .hooks import HookRunner, HookConfig, HookEvent, HookResult, HookDecision
from .memory import MemoryStore, MemoryType, MemoryEntry
from .logging_utils import TraceLogger
from .security_pipeline import (
    SafetyDecision, ClassificationResult, ReviewResult, FilteredOutput,
    sanitize_output, detect_sensitive_disclosure, detect_prompt_injection,
    classify_action, classify_action_regex, classify_action_model,
    review_action, filter_tool_output, SAFETY_SYSTEM_PROMPT_ADDITION,
)
from .subagent import (
    SubAgent, SubAgentManager, SubAgentConfig, SubAgentResult,
    SubAgentState, SubAgentPriority, MessageChannel, ResourceLimits,
    ResourceMonitor, create_subagent, run_parallel_tasks, run_pipeline_tasks,
)

__all__ = [
    "NexgentAgent",
    "AgentDeps",
    "CircuitBreaker",
    "TokenBudget",
    "PermissionGate",
    "Permission",
    "PermissionMode",
    "PermissionRule",
    "Session",
    "compact_context",
    "load_memory",
    "HookRunner",
    "HookConfig",
    "HookEvent",
    "HookResult",
    "HookDecision",
    "MemoryStore",
    "MemoryType",
    "MemoryEntry",
    "TraceLogger",
    "SafetyDecision",
    "ClassificationResult",
    "ReviewResult",
    "FilteredOutput",
    "sanitize_output",
    "detect_sensitive_disclosure",
    "detect_prompt_injection",
    "classify_action",
    "classify_action_regex",
    "classify_action_model",
    "review_action",
    "filter_tool_output",
    # SubAgent system
    "SubAgent",
    "SubAgentManager",
    "SubAgentConfig",
    "SubAgentResult",
    "SubAgentState",
    "SubAgentPriority",
    "MessageChannel",
    "ResourceLimits",
    "ResourceMonitor",
    "create_subagent",
    "run_parallel_tasks",
    "run_pipeline_tasks",
]
