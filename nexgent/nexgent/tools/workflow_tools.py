"""Workflow tools — allows the LLM to run and manage workflow scripts.

This module exposes tools for running, listing, and saving workflows.
Workflows orchestrate multiple sub-agents from a script.

Tools:
  - workflow_run: Execute a workflow script
  - workflow_list: List workflow runs
  - workflow_status: Get status of a specific run
  - workflow_save: Save a workflow as a reusable command
  - workflow_resume: Resume a paused/failed workflow
"""

import json
import os
from .registry import ToolDef
from ..permissions import Permission


def _make_run_handler(harness):
    """Create handler for workflow_run tool."""

    def _run_workflow(params: dict) -> str:
        runner = harness.workflow_runner
        script = params.get("script", "")
        script_path = params.get("script_path", "")
        args = params.get("args")
        budget = params.get("budget")

        # Load script from file if script_path is provided
        if script_path and not script:
            if not os.path.exists(script_path):
                return json.dumps({"error": f"Script file not found: {script_path}"})
            with open(script_path, "r", encoding="utf-8") as f:
                script = f.read()

        if not script:
            return json.dumps({"error": "No script provided (use 'script' or 'script_path')"})

        # Collect progress messages
        progress_log = []

        def on_progress(msg):
            progress_log.append(msg)

        try:
            run = runner.run(
                script_source=script,
                script_path=script_path or "<inline>",
                args=args,
                budget_total=budget,
                progress_callback=on_progress,
            )
        except Exception as e:
            return json.dumps({"error": f"Workflow execution failed: {e}"})

        return json.dumps({
            "run_id": run.run_id,
            "status": run.status.value,
            "phases": [p.to_dict() for p in run.phases],
            "agent_count": len(run.agents),
            "completed": sum(
                1 for a in run.agents.values()
                if a.status.value == "completed"
            ),
            "budget": run.budget.to_dict(),
            "duration": round(
                (run.finished_at or 0) - run.started_at, 2
            ) if run.started_at else 0,
            "result": run.result,
            "error": run.error,
            "progress": progress_log[-20:],  # last 20 messages
        }, ensure_ascii=False, default=str)

    return _run_workflow


def _make_list_handler(harness):
    """Create handler for workflow_list tool."""

    def _list_workflows(params: dict) -> str:
        runner = harness.workflow_runner
        runs = runner.list_runs()
        return json.dumps([r.to_dict() for r in runs], ensure_ascii=False, default=str)

    return _list_workflows


def _make_status_handler(harness):
    """Create handler for workflow_status tool."""

    def _workflow_status(params: dict) -> str:
        runner = harness.workflow_runner
        run_id = params.get("run_id")
        if not run_id:
            return json.dumps({"error": "run_id is required"})
        run = runner.get_run(run_id)
        if not run:
            return json.dumps({"error": f"Workflow run {run_id} not found"})

        agents_detail = []
        for a in run.agents.values():
            agents_detail.append({
                "agent_id": a.agent_id,
                "label": a.label,
                "phase": a.phase,
                "status": a.status.value,
                "token_usage": a.token_usage,
                "duration": round(a.duration, 2),
                "error": a.error,
            })

        return json.dumps({
            "run_id": run.run_id,
            "status": run.status.value,
            "phases": [p.to_dict() for p in run.phases],
            "agents": agents_detail,
            "budget": run.budget.to_dict(),
            "duration": round(
                (run.finished_at or 0) - run.started_at, 2
            ) if run.started_at else 0,
            "error": run.error,
        }, ensure_ascii=False, default=str)

    return _workflow_status


def _make_save_handler(harness):
    """Create handler for workflow_save tool."""

    def _save_workflow(params: dict) -> str:
        runner = harness.workflow_runner
        run_id = params.get("run_id")
        name = params.get("name")
        if not run_id or not name:
            return json.dumps({"error": "run_id and name are required"})
        save_dir = params.get("save_dir")

        try:
            filepath = runner.save_workflow(run_id, name, save_dir)
            return json.dumps({"saved_to": filepath, "name": name})
        except Exception as e:
            return json.dumps({"error": str(e)})

    return _save_workflow


def _make_resume_handler(harness):
    """Create handler for workflow_resume tool."""

    def _resume_workflow(params: dict) -> str:
        runner = harness.workflow_runner
        run_id = params.get("run_id")
        if not run_id:
            return json.dumps({"error": "run_id is required"})
        progress_log = []

        def on_progress(msg):
            progress_log.append(msg)

        try:
            run = runner.resume(run_id, progress_callback=on_progress)
        except Exception as e:
            return json.dumps({"error": str(e)})

        return json.dumps({
            "run_id": run.run_id,
            "status": run.status.value,
            "agent_count": len(run.agents),
            "completed": sum(
                1 for a in run.agents.values()
                if a.status.value == "completed"
            ),
            "duration": round(
                (run.finished_at or 0) - run.started_at, 2
            ) if run.started_at else 0,
            "result": run.result,
            "error": run.error,
            "progress": progress_log[-20:],
        }, ensure_ascii=False, default=str)

    return _resume_workflow


def get_tools(harness) -> list[ToolDef]:
    """Return workflow tools. Called with the harness instance."""
    return [
        ToolDef(
            name="workflow_run",
            description=(
                "Execute a workflow script that orchestrates multiple sub-agents. "
                "The script uses 'ctx' (WorkflowContext) with DSL functions: "
                "ctx.agent(prompt, label=) to spawn agents, "
                "ctx.parallel([thunks]) for concurrent execution, "
                "ctx.pipeline(items, *stages) for staged processing, "
                "ctx.phase(title) for progress grouping, "
                "ctx.log(msg) for progress messages. "
                "The script can define async def main(ctx, args) for the entry point."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "script": {
                        "type": "string",
                        "description": "Python workflow script source code.",
                    },
                    "script_path": {
                        "type": "string",
                        "description": "Path to a .py workflow script file (alternative to 'script').",
                    },
                    "args": {
                        "description": "Arguments passed to the script as 'args' global.",
                    },
                    "budget": {
                        "type": "integer",
                        "description": "Token budget limit for the entire workflow (optional).",
                    },
                },
            },
            handler=_make_run_handler(harness),
            permission=Permission.WRITE,
            is_read_only=False,
            is_concurrency_safe=False,
        ),
        ToolDef(
            name="workflow_list",
            description="List all workflow runs with their status and progress.",
            parameters={"type": "object", "properties": {}},
            handler=_make_list_handler(harness),
            permission=Permission.READ,
            is_read_only=True,
            is_concurrency_safe=True,
        ),
        ToolDef(
            name="workflow_status",
            description="Get detailed status of a specific workflow run, including all agents.",
            parameters={
                "type": "object",
                "properties": {
                    "run_id": {
                        "type": "string",
                        "description": "The workflow run ID.",
                    },
                },
                "required": ["run_id"],
            },
            handler=_make_status_handler(harness),
            permission=Permission.READ,
            is_read_only=True,
            is_concurrency_safe=True,
        ),
        ToolDef(
            name="workflow_save",
            description="Save a workflow script as a reusable command file.",
            parameters={
                "type": "object",
                "properties": {
                    "run_id": {
                        "type": "string",
                        "description": "The workflow run ID to save.",
                    },
                    "name": {
                        "type": "string",
                        "description": "Command name (used as filename).",
                    },
                    "save_dir": {
                        "type": "string",
                        "description": "Directory to save to (default: .claude/workflows/).",
                    },
                },
                "required": ["run_id", "name"],
            },
            handler=_make_save_handler(harness),
            permission=Permission.WRITE,
            is_read_only=False,
            is_concurrency_safe=False,
        ),
        ToolDef(
            name="workflow_resume",
            description="Resume a paused or failed workflow. Completed agents return cached results.",
            parameters={
                "type": "object",
                "properties": {
                    "run_id": {
                        "type": "string",
                        "description": "The workflow run ID to resume.",
                    },
                },
                "required": ["run_id"],
            },
            handler=_make_resume_handler(harness),
            permission=Permission.WRITE,
            is_read_only=False,
            is_concurrency_safe=False,
        ),
    ]
