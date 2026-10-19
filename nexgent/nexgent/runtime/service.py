"""Project-scoped Nexgent runtime used by every interactive frontend."""

from __future__ import annotations

import contextlib
import io
import os
import secrets
import subprocess
from pathlib import Path
from typing import Any, Callable, Optional

from .events import RuntimeEventKind, RuntimeEventSink, emit_event
from .interactions import InteractionBroker


class _EventWriter(io.TextIOBase):
    def __init__(self, sink: Optional[RuntimeEventSink]) -> None:
        self.sink = sink
        self.parts = []

    def write(self, text: str) -> int:
        if text:
            self.parts.append(text)
            emit_event(
                self.sink,
                RuntimeEventKind.MESSAGE_DELTA,
                source="console",
                payload={"text": text},
            )
        return len(text)

    def getvalue(self) -> str:
        return "".join(self.parts)


class NexgentRuntime:
    """Own one harness, session, project, and frontend interaction channel."""

    def __init__(
        self,
        project_root: os.PathLike[str] | str,
        *,
        harness: Any = None,
        session: Any = None,
        event_sink: Optional[RuntimeEventSink] = None,
        interaction_broker: Optional[InteractionBroker] = None,
        agent_options: Optional[dict] = None,
        run_store: Any = None,
        record_runs: bool = True,
        session_dir: os.PathLike[str] | str | None = None,
    ) -> None:
        from ..agent import NexgentAgent
        from ..command_service import CommandService
        from ..context import CheckpointManager, Session
        from ..memory import MemoryStore
        from ..models import get_model_registry

        self.project_root = Path(project_root).expanduser().resolve()
        inherited_session_dir = getattr(session, "auto_save_dir", None)
        self.session_dir = Path(
            session_dir
            or inherited_session_dir
            or self.project_root / ".nexgent" / "sessions"
        ).expanduser().resolve()
        self.session_dir.mkdir(parents=True, exist_ok=True)
        self.event_sink = event_sink
        self.interaction_broker = interaction_broker or InteractionBroker()
        self.record_runs = record_runs
        registry = get_model_registry()
        project_models = self.project_root / "models.json"
        registry.reload(str(project_models) if project_models.exists() else None)
        options = dict(agent_options or {})
        if harness is None and "model" not in options:
            options["model"] = registry.get_default("main").model_name
        self.harness = harness or NexgentAgent(**options)
        if self.record_runs:
            from .recorder import RunRecorder
            from .store import SQLiteRunStore
            self.run_store = run_store or SQLiteRunStore(
                self.project_root / ".nexgent" / "runs"
            )
            self.run_recorder = RunRecorder(self.run_store, self.project_root)
        else:
            self.run_store = run_store
            self.run_recorder = None
        self._active_run_context = None
        self.last_command_action = "continue"
        self.harness._runtime_event_callback = self._on_harness_event
        self.harness._runtime_event_callback_required = self.record_runs
        self.harness._subagent_event_callback = self._on_subagent_event
        self.harness._subagent_session_dir = str(self.session_dir / "agents")
        existing_subagent_manager = getattr(self.harness, "_subagent_manager", None)
        if existing_subagent_manager is not None:
            existing_subagent_manager.event_callback = self._on_subagent_event
            existing_subagent_manager.session_dir = self.harness._subagent_session_dir
        self.session = session or Session(
            secrets.token_hex(4),
            auto_save_dir=str(self.session_dir),
            working_dir=str(self.project_root),
        )
        self.session.auto_save_dir = str(self.session_dir)
        self.checkpoint_manager = CheckpointManager(self.session.session_id)
        self.harness._checkpoint_manager = self.checkpoint_manager
        if hasattr(self.harness.perms, "set_interaction_broker"):
            self.harness.perms.set_interaction_broker(self.interaction_broker)
        self.harness.interaction_broker = self.interaction_broker
        self.memory_store = MemoryStore(str(self.project_root))
        self.commands = CommandService(
            self.harness,
            self.session,
            self.memory_store,
            self.checkpoint_manager,
            str(self.session_dir),
        )

    def set_event_sink(self, sink: Optional[RuntimeEventSink]) -> None:
        self.event_sink = sink

    def _emit(self, kind: RuntimeEventKind, **payload: Any) -> None:
        emit_event(self.event_sink, kind, source="runtime", payload=payload)

    def _on_subagent_event(self, payload: dict[str, Any]) -> None:
        subagent_id = str(payload.get("subagent_id") or "unknown")
        event_kind = payload.get("event_kind")
        if self.run_recorder is not None and self._active_run_context is not None:
            from .contracts import SourceType
            self.run_recorder.record_runtime_event(
                self._active_run_context,
                str(event_kind or "subagent_changed"),
                payload,
                source_id=f"subagent:{subagent_id}",
                source_type=SourceType.SUBAGENT,
            )
        if event_kind:
            event_payload = {
                key: value
                for key, value in payload.items()
                if key not in {"event_kind", "subagent_id", "state", "task", "description"}
            }
            emit_event(
                self.event_sink,
                RuntimeEventKind(str(event_kind)),
                source=f"subagent:{subagent_id}",
                payload=event_payload,
            )
            return
        emit_event(
            self.event_sink,
            RuntimeEventKind.SUBAGENT_CHANGED,
            source=f"subagent:{subagent_id}",
            payload=payload,
        )

    def _on_harness_event(self, kind: str, payload: dict[str, Any]) -> None:
        if self.run_recorder is not None and self._active_run_context is not None:
            self.run_recorder.record_runtime_event(
                self._active_run_context,
                kind,
                payload,
                source_id="main",
            )
        emit_event(
            self.event_sink,
            RuntimeEventKind(kind),
            source="main",
            payload=payload,
        )

    def inject_guidance(self, text: str) -> None:
        """Inject user guidance into the active session without starting a new run."""
        value = text.strip()
        if not value:
            return
        self.session.add_message("user", value, injected=True)
        self._emit(RuntimeEventKind.NOTICE, message=f"Guidance injected: {value}")

    def _start_tracked_run(self, objective: str):
        if self.run_recorder is None:
            return None
        if self._active_run_context is not None:
            raise RuntimeError("a tracked run is already active in this runtime")
        registry = getattr(self.harness, "registry", None)
        tool_catalog = []
        if registry is not None and hasattr(registry, "list_all"):
            tool_catalog = [
                {
                    "name": tool.name,
                    "parameters": getattr(tool, "parameters", {}),
                    "permission": str(getattr(tool, "permission", "unknown")),
                }
                for tool in registry.list_all()
            ]
        context = self.run_recorder.start_run(
            objective,
            session_id=self.session.session_id,
            model_profile=getattr(self.harness, "model", None),
            tool_catalog=tool_catalog,
        )
        self._active_run_context = context
        return context

    def _execute_tracked(self, objective: str, operation: Callable[[], str]) -> str:
        """Execute one frontend action inside the durable Harness envelope."""

        run_context = self._start_tracked_run(objective)
        self._emit(
            RuntimeEventKind.RUN_STARTED,
            text=objective,
            durable_run_id=run_context.run_id if run_context else None,
        )
        try:
            result = operation() or ""
            if self.run_recorder is not None and run_context is not None:
                self.run_recorder.finish_unverified(run_context, result)
            self._emit(
                RuntimeEventKind.RUN_FINISHED,
                result=result,
                session_id=self.session.session_id,
                messages=len(self.session.messages),
                durable_run_id=run_context.run_id if run_context else None,
                verification="not_run",
            )
            return result
        except Exception as exc:
            if self.run_recorder is not None and run_context is not None:
                try:
                    self.run_recorder.fail(run_context, exc)
                except Exception as record_exc:
                    raise RuntimeError(
                        f"run failed and durable failure recording also failed: {record_exc}"
                    ) from exc
            self._emit(RuntimeEventKind.ERROR, message=str(exc), exception=type(exc).__name__)
            raise
        finally:
            self._active_run_context = None

    def run_agent_task(self, task: str) -> str:
        """Run a prompt without capturing console output, for CLI and TUI use."""

        value = task.strip()
        if not value:
            return ""

        from ..skills import SkillSubstitutor
        from ..tools.interactive import set_interaction_broker

        set_interaction_broker(self.interaction_broker)
        SkillSubstitutor.set_interaction_broker(self.interaction_broker)

        def run_agent() -> str:
            previous = Path.cwd()
            try:
                os.chdir(self.project_root)
                return self.harness.run(task, self.session)
            finally:
                os.chdir(previous)

        try:
            return self._execute_tracked(value, run_agent)
        finally:
            set_interaction_broker(None)
            SkillSubstitutor.set_interaction_broker(None)

    def handle_input(self, text: str) -> str:
        value = text.strip()
        if not value:
            return ""
        if value == "/harness" or value.startswith("/harness "):
            return self._handle_harness_command(value)
        if value.startswith("/goal run "):
            return self._handle_harness_command(
                "/harness run " + value[len("/goal run "):]
            )
        self.last_command_action = "continue"
        writer = _EventWriter(self.event_sink)
        from ..tools.interactive import set_interaction_broker
        from ..skills import SkillSubstitutor
        set_interaction_broker(self.interaction_broker)
        SkillSubstitutor.set_interaction_broker(self.interaction_broker)

        def dispatch() -> str:
            with contextlib.redirect_stdout(writer), contextlib.redirect_stderr(writer):
                if value.startswith("/"):
                    return self._handle_interactive_command(value)
                if value.startswith("!"):
                    return self._run_shell(value[1:])

                from ..file_references import FileReferenceResolver

                prompt = FileReferenceResolver.resolve_and_format(value, str(self.project_root))
                previous = Path.cwd()
                try:
                    os.chdir(self.project_root)
                    return self.harness.run(prompt, self.session)
                finally:
                    os.chdir(previous)

        try:
            result = self._execute_tracked(value, dispatch)
            return result or writer.getvalue()
        finally:
            set_interaction_broker(None)
            SkillSubstitutor.set_interaction_broker(None)

    def _handle_harness_command(self, value: str) -> str:
        """Run a real coding task against an explicit independent check."""

        import json
        import shlex

        from ..skills import SkillSubstitutor
        from ..tools.interactive import set_interaction_broker
        from .coding_task import run_coding_task

        parts = shlex.split(value)
        if self.run_store is None:
            raise RuntimeError("verified harness runs require durable run recording")

        def option(name: str, default: Optional[str] = None) -> Optional[str]:
            if name not in parts:
                return default
            index = parts.index(name)
            if index + 1 >= len(parts):
                raise ValueError(f"{name} requires a value")
            return parts[index + 1]

        if len(parts) == 1 or parts[1] in {"help", "--help", "-h"}:
            return (
                "Verified Coding Harness commands:\n"
                "  /harness run --check \"python -m pytest -q\" "
                "--task \"Fix the failing tests\"\n"
                "  /harness list\n"
                "  /harness status <run-id>\n"
                "  /harness resume <run-id> [--attempts 3] [--timeout 120]\n"
                "  /harness export <run-id> [--output path.jsonl]\n"
                "The Agent keeps its normal permission gates; only the explicit "
                "acceptance command can accept the run."
            )

        command = parts[1]
        if command == "list":
            runs = [
                run.to_dict()
                for run in self.run_store.list_runs()
                if run.mode.value == "coding"
            ]
            return json.dumps(runs, ensure_ascii=False, indent=2, sort_keys=True)
        if command == "status":
            if len(parts) != 3:
                raise ValueError("/harness status requires one run id")
            bundle = self.run_store.export_run(parts[2])
            payload = {
                "run": bundle["run"],
                "attempts": len(bundle["attempts"]),
                "events": len(bundle["events"]),
                "faults": len(bundle["faults"]),
                "diagnoses": len(bundle["diagnoses"]),
                "recoveries": len(bundle["recoveries"]),
                "verifications": len(bundle["verifications"]),
            }
            return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
        if command == "export":
            if len(parts) < 3:
                raise ValueError("/harness export requires a run id")
            run_id = parts[2]
            destination = Path(
                option(
                    "--output",
                    str(self.project_root / ".nexgent" / "exports" / f"{run_id}.jsonl"),
                )
            ).expanduser().resolve()
            from ..permissions import Permission

            if not self.harness.perms.check(
                Permission.WRITE,
                f"harness_export({destination})",
                {"path": str(destination)},
            ):
                raise PermissionError("Harness export blocked by permission system")
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(
                self.run_store.export_run_jsonl(run_id), encoding="utf-8"
            )
            return json.dumps(
                {"run_id": run_id, "export_path": str(destination)},
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
        if command not in {"run", "resume"}:
            raise ValueError(f"unknown harness command: {parts[1]}")

        resume_run_id = None
        if command == "resume":
            if len(parts) < 3:
                raise ValueError("/harness resume requires a run id")
            resume_run_id = parts[2]
            run = self.run_store.get_run(resume_run_id)
            if run.mode.value != "coding":
                raise ValueError("only Coding Harness runs can be resumed")
            goal_events = [
                event
                for event in self.run_store.list_events(resume_run_id)
                if event.payload.get("stage") == "goal"
            ]
            if not goal_events:
                raise RuntimeError("durable Harness goal event is missing")
            task = run.objective
            check_command = str(
                goal_events[0].payload.get("acceptance_command") or ""
            )
        else:
            task = option("--task")
            check_command = option("--check")
            if not task or not check_command:
                raise ValueError(
                    "/harness run requires quoted --task and --check values"
                )
        max_attempts = int(option("--attempts", "3"))
        timeout = float(option("--timeout", "120"))
        if self._active_run_context is not None:
            raise RuntimeError("a tracked run is already active in this runtime")

        def publish_progress(payload: dict[str, Any]) -> None:
            self._emit(
                RuntimeEventKind.WORKFLOW_CHANGED,
                harness=True,
                **payload,
            )

        def execute_agent(prompt: str) -> str:
            previous = Path.cwd()
            try:
                os.chdir(self.project_root)
                return self.harness.run(prompt, self.session)
            finally:
                os.chdir(previous)

        self._emit(
            RuntimeEventKind.RUN_STARTED,
            text=task,
            harness=True,
            acceptance_command=check_command,
            resumed_run_id=resume_run_id,
        )
        set_interaction_broker(self.interaction_broker)
        SkillSubstitutor.set_interaction_broker(self.interaction_broker)
        try:
            from ..permissions import Permission
            from ..tools.shell import _is_readonly

            permission = (
                Permission.READ if _is_readonly(check_command) else Permission.WRITE
            )
            if not self.harness.perms.check(
                permission,
                f"harness_acceptance({check_command[:100]})",
                {"command": check_command},
            ):
                raise PermissionError("acceptance command blocked by permission system")
            summary = run_coding_task(
                self.run_store,
                self.project_root,
                task,
                check_command,
                execute_agent,
                max_attempts=max_attempts,
                check_timeout=timeout,
                progress_callback=publish_progress,
                context_callback=lambda context: setattr(
                    self, "_active_run_context", context
                ),
                resume_run_id=resume_run_id,
            )
        finally:
            self._active_run_context = None
            set_interaction_broker(None)
            SkillSubstitutor.set_interaction_broker(None)
        payload = summary.to_dict()
        self._emit(
            RuntimeEventKind.RUN_FINISHED,
            result=summary.reason,
            harness=True,
            harness_run_id=summary.run_id,
            status=summary.status.value,
            attempts=summary.attempts,
            recoveries=summary.recoveries,
            changed_files=list(summary.changed_files),
            strategy_reused=summary.strategy_reused,
        )
        return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)

    def _handle_interactive_command(self, value: str) -> str:
        """Resolve commands whose CLI implementation reads from stdin."""
        import shlex
        from .interactions import InteractionKind, InteractionRequest

        parts = shlex.split(value)
        if parts and parts[0].lower() == "/remember":
            response = self.interaction_broker.request(InteractionRequest(
                InteractionKind.USER_INPUT,
                "Save project memory",
                {"multiline": True, "placeholder": "Context Nexgent should remember"},
            ))
            if not response.accepted or not str(response.value or "").strip():
                return "Memory creation cancelled."
            from ..memory import MemoryType
            name = f"session-{self.session.session_id[:8]}"
            self.memory_store.save_memory(
                name=name,
                memory_type=MemoryType.PROJECT,
                description=f"Memory from session {self.session.session_id[:8]}",
                content=str(response.value).strip(),
            )
            return f"Memory saved: {name}"

        if parts and parts[0].lower() == "/init" and (self.project_root / "AGENTS.md").exists():
            response = self.interaction_broker.request(InteractionRequest(
                InteractionKind.PERMISSION,
                "AGENTS.md already exists. Overwrite it?",
                {"permission": "write", "path": str(self.project_root / "AGENTS.md")},
            ))
            if not response.accepted:
                return "Project initialization skipped."
            from ..project_scanner import generate_agents_md, scan_project
            result = scan_project(str(self.project_root))
            destination = self.project_root / "AGENTS.md"
            destination.write_text(generate_agents_md(result), encoding="utf-8")
            return f"AGENTS.md generated at {destination}"

        if len(parts) >= 4 and parts[:2] == ["/agents", "create"]:
            name = parts[2]
            description = " ".join(parts[3:])
            response = self.interaction_broker.request(InteractionRequest(
                InteractionKind.USER_INPUT,
                f"System prompt for Agent '{name}'",
                {"multiline": True, "placeholder": f"You are {name}."},
            ))
            if not response.accepted:
                return "Agent creation cancelled."
            from ..agents import AgentManager
            manager = getattr(self.harness, "_agent_manager", None) or AgentManager(str(self.project_root))
            self.harness._agent_manager = manager
            prompt = str(response.value or "").strip() or f"You are {name}."
            path = manager.create_agent(name, description, prompt)
            return f"Agent '{name}' created at {path}"

        command_result = self.commands.execute(value)
        self.last_command_action = command_result.action
        self.session = command_result.session
        self.commands.session = self.session
        return command_result.output

    def _run_shell(self, command: str) -> str:
        from ..permissions import Permission
        from ..tools.shell import _is_readonly, _scrub_env

        permission = Permission.READ if _is_readonly(command) else Permission.WRITE
        if not self.harness.perms.check(
            permission, f"run_command({command[:100]})", {"command": command}
        ):
            return "[blocked by permission system]"
        completed = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=120,
            cwd=self.project_root,
            env=_scrub_env(),
        )
        return (completed.stdout or "") + (completed.stderr or "")

    def abort(self) -> None:
        self.harness.graceful_abort.request()
        manager = getattr(self.harness, "_subagent_manager", None)
        if manager is not None:
            manager.cancel_all()
        self._emit(RuntimeEventKind.RUN_ABORTED)

    def close(self) -> None:
        try:
            self.session.save_meta_to_jsonl()
        except OSError:
            pass
        self.interaction_broker.set_handler(None)
        try:
            from ..tools.interactive import set_interaction_broker
            set_interaction_broker(None)
            from ..skills import SkillSubstitutor
            SkillSubstitutor.set_interaction_broker(None)
        except Exception:
            pass
        try:
            from ..tools.scheduler_tools import get_scheduler
            scheduler = get_scheduler()
            if scheduler:
                scheduler.stop()
        except Exception:
            pass
