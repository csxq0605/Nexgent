"""Sub-agent tool — allows the LLM to delegate tasks to sub-agents.

This module exposes a ``subagent_run`` tool that the LLM can call via
tool_calls to spawn an isolated sub-agent for a specific task.  The
sub-agent runs synchronously and returns its result to the parent.

The tool uses a closure over the harness instance so the handler can
call ``harness.run_subagent()`` without changing the registry's
handler signature.
"""

import json
from .registry import ToolDef
from ..permissions import Permission


def _make_run_handler(harness):
    """Create a handler closure that captures the harness instance."""

    def _run_subagent(params: dict) -> str:
        from ..subagent import SubAgentConfig, SubAgentState

        task = params.get("task")
        if not task:
            return json.dumps({"error": "task is required"})
        description = params.get("description", "")
        allowed_tools = params.get("allowed_tools")
        effort = params.get("effort", "medium")

        config = SubAgentConfig(
            task=task,
            description=description,
            allowed_tools=allowed_tools,
            effort=effort,
        )

        try:
            result = harness.subagent_manager.run_single(config)
        except Exception as e:
            return json.dumps({
                "error": f"Sub-agent execution failed: {e}",
            })

        output = {
            "subagent_id": result.subagent_id,
            "state": result.state.value,
            "steps_taken": result.steps_taken,
            "duration_seconds": round(result.duration_seconds, 2),
            "token_usage": result.token_usage,
        }

        if result.state == SubAgentState.COMPLETED:
            output["result"] = result.result
        else:
            output["error"] = result.error

        return json.dumps(output, ensure_ascii=False)

    return _run_subagent


def get_tools(harness) -> list[ToolDef]:
    """Return sub-agent tools.  Called with the harness instance so
    the handler can close over it."""
    return [
        ToolDef(
            name="subagent_run",
            description=(
                "Spawn a sub-agent to handle a specific task in isolation. "
                "The sub-agent has its own session and runs autonomously until "
                "the task is complete.  Use this to delegate independent "
                "subtasks — for example, researching a topic, analyzing a file, "
                "or running a series of commands — while you continue with "
                "other work.  The sub-agent's final output is returned to you."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": (
                            "A clear, self-contained description of what the "
                            "sub-agent should accomplish.  Include all necessary "
                            "context — the sub-agent cannot see your conversation."
                        ),
                    },
                    "description": {
                        "type": "string",
                        "description": (
                            "A short human-readable label for this sub-agent "
                            "(e.g. 'read auth module', 'run tests')."
                        ),
                    },
                    "allowed_tools": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "Optional list of tool names the sub-agent may use. "
                            "Omit to allow all tools."
                        ),
                    },
                    "effort": {
                        "type": "string",
                        "enum": ["low", "medium", "high"],
                        "description": "Reasoning effort level (default: medium).",
                    },
                },
                "required": ["task"],
            },
            handler=_make_run_handler(harness),
            permission=Permission.WRITE,
            is_read_only=False,
            is_concurrency_safe=False,
        ),
    ]
