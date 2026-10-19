"""Plan mode tools - EnterPlanMode/ExitPlanMode workflow.

Implements Claude Code's plan mode workflow:
- EnterPlanMode: Switch to read-only exploration mode
- ExitPlanMode: Present a structured plan for user approval, then resume execution

The agent can autonomously decide when to enter/exit plan mode,
enabling a natural "explore → plan → approve → execute" workflow.
"""

import json
from .registry import ToolDef
from ..permissions import Permission, PermissionMode


def enter_plan_mode(params: dict) -> str:
    """Switch to plan mode (read-only exploration).

    In plan mode, the agent can only use read-only tools:
    - Read, Glob, Grep for file exploration
    - Read-only Bash commands (ls, cat, git log, etc.)
    - WebSearch, WebFetch for research

    The agent cannot:
    - Edit or write files
    - Run write-capable shell commands
    - Make any modifications

    Args:
        params: dict with optional key:
            - reason (str): Why entering plan mode (shown to user)

    Returns:
        Confirmation message.
    """
    reason = params.get("reason", "Exploring codebase and designing approach")
    return json.dumps({
        "status": "plan_mode_entered",
        "message": f"[PLAN MODE] Entered plan mode: {reason}",
        "capabilities": [
            "Read files, search code, explore structure",
            "Run read-only shell commands",
            "Research via web search",
        ],
        "restrictions": [
            "Cannot edit or write files",
            "Cannot run write shell commands",
            "Cannot make modifications",
        ],
        "next_step": "When ready, call exit_plan_mode with your structured plan for user approval.",
    })


def exit_plan_mode(params: dict) -> str:
    """Present a structured plan for user approval and exit plan mode.

    The plan should include:
    - Summary of the problem/goal
    - Proposed approach with specific steps
    - Files that will be modified
    - Risk assessment

    After user approval, the agent resumes with full tool access.

    Args:
        params: dict with keys:
            - plan (str): The structured plan text for user review
            - summary (str): One-line summary of the plan

    Returns:
        JSON with plan details and decision="pending". The agent loop
        is responsible for prompting the user and handling approval.
    """
    plan = params.get("plan", "")
    summary = params.get("summary", "")

    if not plan:
        return json.dumps({"error": "No plan provided. Include your plan in the 'plan' parameter."})

    return json.dumps({
        "decision": "pending",
        "plan": plan,
        "summary": summary,
        "message": "[PLAN READY] Plan submitted for user approval.",
    })


def get_tools() -> list[ToolDef]:
    return [
        ToolDef(
            name="enter_plan_mode",
            description=(
                "Switch to plan mode for read-only codebase exploration and approach design. "
                "In plan mode, you can only read files, search code, and run read-only commands. "
                "Use this before making significant changes to understand the codebase first."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "reason": {
                        "type": "string",
                        "description": "Why you are entering plan mode (e.g. 'exploring auth system before refactoring')",
                    },
                },
                "required": [],
            },
            handler=enter_plan_mode,
            permission=Permission.READ,
            is_read_only=True,
            is_concurrency_safe=False,
        ),
        ToolDef(
            name="exit_plan_mode",
            description=(
                "Present a structured plan for user approval and exit plan mode. "
                "Include: problem summary, proposed steps, files to modify, and risks. "
                "After approval, you resume with full read/write tool access."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "plan": {
                        "type": "string",
                        "description": "The full structured plan for user review (markdown format)",
                    },
                    "summary": {
                        "type": "string",
                        "description": "One-line summary of what the plan achieves",
                    },
                },
                "required": ["plan"],
            },
            handler=exit_plan_mode,
            permission=Permission.READ,
            is_read_only=True,
            is_concurrency_safe=False,
        ),
    ]
