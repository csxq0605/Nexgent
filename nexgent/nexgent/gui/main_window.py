"""Compact AutoReport-style Nexgent workspace."""

from __future__ import annotations

import os
import re
import shlex
from pathlib import Path

from PyQt6.QtCore import QSettings, Qt
from PyQt6.QtGui import QAction
from PyQt6.QtWidgets import (
    QFrame, QFileDialog, QHBoxLayout, QLabel, QListWidget, QMainWindow,
    QMessageBox, QSplitter, QStatusBar, QTabWidget, QVBoxLayout, QWidget,
    QInputDialog,
)

from ..context import CheckpointManager, Session
from ..branding import PRODUCT_NAME, TAGLINE
from ..models import get_model_registry
from ..runtime.events import RuntimeEventKind
from .config_dialog import ConfigDialog
from .icons import load_app_icon
from .runtime_bridge import RuntimeBridge
from .theme import theme_stylesheet
from .widgets.agent_panel import AgentPanel
from .widgets.file_tree import ProjectFileTree
from .widgets.harness_runs import (
    HarnessResumeDialog,
    HarnessRunDialog,
    HarnessRunsPanel,
)
from .widgets.preview import PreviewPane

ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


class MainWindow(QMainWindow):
    def __init__(self, runtime, parent=None):
        super().__init__(parent)
        self.runtime = runtime
        self.project_root = runtime.project_root
        self._native_input_labels: dict[str, list[str]] = {}
        self.bridge = RuntimeBridge(runtime, self)
        self.settings = QSettings("Nexgent", "Desktop")
        self.setWindowTitle(f"{PRODUCT_NAME} — {self.project_root.name}")
        self.setWindowIcon(load_app_icon())
        self.setMinimumSize(1100, 720)
        self.resize(1480, 900)
        self.setStyleSheet(theme_stylesheet())
        self._build_menu()
        self._build_ui()
        self._connect_runtime()
        self._refresh_sessions()
        self._refresh_harness_runs()
        self._agent_items = {"main": self.agent_list.item(0)}
        geometry = self.settings.value("geometry")
        if geometry:
            self.restoreGeometry(geometry)

    def _build_menu(self):
        file_menu = self.menuBar().addMenu("File")
        config = QAction("Model & Provider Settings…", self)
        config.triggered.connect(self._open_config)
        file_menu.addAction(config)
        file_menu.addSeparator()
        quit_action = QAction("Close", self)
        quit_action.setShortcut("Ctrl+W")
        quit_action.triggered.connect(self.close)
        file_menu.addAction(quit_action)
        view = self.menuBar().addMenu("View")
        toggle_sidebar = QAction("Toggle Navigator", self)
        toggle_sidebar.setShortcut("Ctrl+Shift+B")
        toggle_sidebar.triggered.connect(
            lambda: self.navigator.setVisible(not self.navigator.isVisible())
        )
        view.addAction(toggle_sidebar)
        toggle_preview = QAction("Toggle Preview", self)
        toggle_preview.setShortcut("Ctrl+Shift+P")
        toggle_preview.triggered.connect(
            lambda: self.preview_panel.setVisible(not self.preview_panel.isVisible())
        )
        view.addAction(toggle_preview)
        help_menu = self.menuBar().addMenu("Help")
        command_help = QAction("Nexgent Commands", self)
        command_help.triggered.connect(lambda: self.bridge.submit("/help"))
        help_menu.addAction(command_help)

    def _panel_header(self, title, subtitle=""):
        host = QWidget()
        row = QHBoxLayout(host)
        row.setContentsMargins(8, 6, 8, 6)
        label = QLabel(title)
        label.setObjectName("Section")
        row.addWidget(label)
        if subtitle:
            detail = QLabel(subtitle)
            detail.setObjectName("Muted")
            row.addWidget(detail)
        row.addStretch()
        return host

    def _build_ui(self):
        root = QWidget()
        outer = QVBoxLayout(root)
        outer.setContentsMargins(8, 8, 8, 8)
        top = QHBoxLayout()
        logo = QLabel()
        logo.setPixmap(load_app_icon().pixmap(24, 24))
        brand = QLabel(PRODUCT_NAME.upper())
        brand.setObjectName("Brand")
        tagline = QLabel(TAGLINE)
        tagline.setObjectName("Muted")
        workspace = QLabel(f"Workspace · {self.project_root.name}")
        workspace.setObjectName("Muted")
        top.addWidget(logo)
        top.addWidget(brand)
        top.addWidget(tagline)
        top.addStretch()
        top.addWidget(workspace)
        outer.addLayout(top)

        columns = QSplitter(Qt.Orientation.Horizontal)

        self.navigator = QFrame()
        self.navigator.setObjectName("Panel")
        left_layout = QVBoxLayout(self.navigator)
        left_layout.setContentsMargins(6, 6, 6, 6)
        self.navigation_tabs = QTabWidget()

        files_page = QWidget()
        files_layout = QVBoxLayout(files_page)
        files_layout.setContentsMargins(2, 4, 2, 2)
        self.file_tree = ProjectFileTree(self.project_root)
        files_layout.addWidget(self.file_tree)
        self.navigation_tabs.addTab(files_page, "Files")

        sessions_page = QWidget()
        sessions_layout = QVBoxLayout(sessions_page)
        sessions_layout.setContentsMargins(2, 4, 2, 2)
        self.sessions = QListWidget()
        self.sessions.setToolTip("Double-click a session to resume it")
        sessions_layout.addWidget(self.sessions)
        self.navigation_tabs.addTab(sessions_page, "Sessions")

        self.harness_runs = HarnessRunsPanel()
        self.harness_runs.new_requested.connect(self._new_harness_run)
        self.harness_runs.details_requested.connect(self._show_harness_run_details)
        self.harness_runs.resume_requested.connect(self._resume_harness_run)
        self.harness_runs.export_requested.connect(self._export_harness_run)
        self.harness_runs.refresh_requested.connect(self._refresh_harness_runs)
        self.navigation_tabs.addTab(self.harness_runs, "Runs")

        agents_page = QWidget()
        agents_layout = QVBoxLayout(agents_page)
        agents_layout.setContentsMargins(2, 4, 2, 2)
        self.agent_list = QListWidget()
        main_item = self._new_agent_item("main", "ready")
        self.agent_list.addItem(main_item)
        self.agent_list.setCurrentItem(main_item)
        agents_layout.addWidget(self.agent_list)
        self.navigation_tabs.addTab(agents_page, "Agents")
        left_layout.addWidget(self.navigation_tabs)

        self.preview_panel = QFrame()
        self.preview_panel.setObjectName("Panel")
        center_layout = QVBoxLayout(self.preview_panel)
        center_layout.setContentsMargins(6, 6, 6, 6)
        center_layout.addWidget(self._panel_header("PREVIEW"))
        self.preview = PreviewPane()
        center_layout.addWidget(self.preview, 1)

        self.agent = AgentPanel(self.runtime.harness.model, self.project_root)
        registry = get_model_registry()
        registry.load()
        for profile in registry.list_profiles():
            if profile.model_name != self.runtime.harness.model:
                self.agent.model.addItem(profile.full_id)

        columns.addWidget(self.navigator)
        columns.addWidget(self.preview_panel)
        columns.addWidget(self.agent)
        columns.setSizes([300, 500, 680])
        columns.setStretchFactor(1, 2)
        columns.setStretchFactor(2, 3)
        outer.addWidget(columns, 1)
        self.setCentralWidget(root)
        status = QStatusBar()
        self.status_model = QLabel(self.runtime.harness.model)
        self.status_session = QLabel(f"Session {self.runtime.session.session_id}")
        status.addPermanentWidget(self.status_session)
        status.addPermanentWidget(self.status_model)
        self.setStatusBar(status)

        self.file_tree.file_selected.connect(self.preview.open_file)
        self.sessions.itemDoubleClicked.connect(self._resume_session)
        self.agent_list.currentItemChanged.connect(self._agent_selected)
        self.agent.submitted.connect(self._submit)
        self.agent.stop_requested.connect(self.bridge.abort)
        self.agent.mode_changed.connect(self._change_mode)
        self.agent.model.currentTextChanged.connect(self._change_model)

    @staticmethod
    def _new_agent_item(agent_id: str, status: str):
        from PyQt6.QtWidgets import QListWidgetItem

        label = "Main" if agent_id == "main" else agent_id
        item = QListWidgetItem(f"{label}  ·  {status.capitalize()}")
        item.setData(Qt.ItemDataRole.UserRole, agent_id)
        return item

    def _ensure_agent_item(self, agent_id: str, status: str = "ready"):
        item = self._agent_items.get(agent_id)
        if item is None:
            item = self._new_agent_item(agent_id, status)
            self._agent_items[agent_id] = item
            self.agent_list.addItem(item)
        label = "Main" if agent_id == "main" else agent_id
        item.setText(f"{label}  ·  {status.capitalize()}")
        self.agent.ensure_agent(agent_id)
        return item

    def _agent_selected(self, current, _previous):
        if current is None:
            return
        agent_id = str(current.data(Qt.ItemDataRole.UserRole) or "main")
        self.agent.select_agent(agent_id)

    def _connect_runtime(self):
        self.bridge.run_started.connect(self._run_started)
        self.bridge.run_finished.connect(self._run_finished)
        self.bridge.run_failed.connect(self._run_failed)
        self.bridge.busy_changed.connect(self.agent.set_busy)
        self.bridge.event_received.connect(self._runtime_event)
        self.bridge.interaction_requested.connect(self._resolve_interaction)
        self.bridge.input_queued.connect(self._input_queued)
        self.bridge.guidance_injected.connect(self._guidance_injected)
        self.bridge.input_rejected.connect(self._input_rejected)
        self.bridge.queue_cleared.connect(self._queue_cleared)
        self.bridge.input_finished.connect(self._input_finished)
        self.bridge.exit_requested.connect(self.close)

    def _run_started(self, text):
        self._active_input = text
        self._ensure_agent_item("main", "running")
        self.agent.select_agent("main")
        labels = self._native_input_labels.get(text, [])
        display_text = labels.pop(0) if labels else text
        if not labels:
            self._native_input_labels.pop(text, None)
        self.agent.add_message("You", display_text, "main")

    def _runtime_event(self, event):
        if event.kind == RuntimeEventKind.MESSAGE_DELTA:
            text = ANSI_RE.sub("", str(event.payload.get("text", "")))
            self.agent.append_activity(text, "main")
        elif event.kind == RuntimeEventKind.SUBAGENT_CHANGED:
            self._handle_subagent_event(event)
        elif (
            event.kind == RuntimeEventKind.WORKFLOW_CHANGED
            and event.payload.get("harness")
        ):
            label = "Harness"
            stage = str(event.payload.get("stage") or "workflow")
            source = str(event.payload.get("source") or "runtime")
            detail = f"{label} · {stage} · {source}"
            status = event.payload.get("status")
            signal = event.payload.get("signal")
            suspect = event.payload.get("suspect_ref")
            if status:
                detail += f" · {status}"
            if signal:
                detail += f" — {signal}"
            if suspect:
                detail += f" — suspect {suspect}"
            self.agent.append_activity(detail, "main")
            self.statusBar().showMessage(f"{label}: {stage}")
        elif (
            event.kind == RuntimeEventKind.RUN_FINISHED
            and event.payload.get("harness")
        ):
            label = "Harness"
            status = str(event.payload.get("status") or "finished")
            attempts = int(event.payload.get("attempts") or 0)
            recoveries = int(event.payload.get("recoveries") or 0)
            reason = str(event.payload.get("result") or "").strip()
            message = (
                f"{label} run {status}: attempts={attempts}, "
                f"recoveries={recoveries}."
            )
            if reason:
                message += f"\n{reason}"
            self.agent.add_message("Nexgent", message, "main")
            self._refresh_harness_runs()
        elif event.kind in {
            RuntimeEventKind.TOOL_STARTED,
            RuntimeEventKind.TOOL_FINISHED,
            RuntimeEventKind.TOOL_FAILED,
            RuntimeEventKind.NOTICE,
            RuntimeEventKind.WARNING,
        }:
            message = event.payload.get("message") or event.payload.get("tool") or event.kind.value
            message = " ".join(str(message).split())
            if len(message) > 160:
                message = f"{message[:157]}…"
            agent_id = (
                event.source.removeprefix("subagent:")
                if event.source.startswith("subagent:")
                else "main"
            )
            tool = str(event.payload.get("tool") or "").strip()
            marker = {
                RuntimeEventKind.TOOL_STARTED: "▸",
                RuntimeEventKind.TOOL_FINISHED: "✓",
                RuntimeEventKind.TOOL_FAILED: "✕",
            }.get(event.kind, "•")
            detail = f"{marker} {tool}" if tool else f"{marker} {message}"
            if tool and event.kind != RuntimeEventKind.TOOL_STARTED and message != tool:
                detail += f" — {message}"
            self.agent.append_activity(detail, agent_id)

    def _handle_subagent_event(self, event):
        payload = dict(event.payload)
        agent_id = str(payload.get("subagent_id") or event.source.removeprefix("subagent:"))
        state = str(payload.get("state") or "running")
        self._ensure_agent_item(agent_id, state)
        self.agent.set_agent_status(agent_id, state)
        task = str(payload.get("description") or payload.get("task") or "").strip()
        if state == "created" and task:
            self.agent.add_message("System", f"Assigned task\n{task}", agent_id)
        elif state == "running":
            self.agent.append_activity("Working…", agent_id)
        elif state == "completed":
            result = str(payload.get("result") or "").strip()
            if result:
                self.agent.add_message("Nexgent", result, agent_id)
        elif state in {"failed", "cancelled"}:
            error = str(payload.get("error") or state).strip()
            self.agent.add_message("Error", error, agent_id)

    def _submit(self, text):
        if self.bridge.submit(text):
            self.statusBar().showMessage("Running…")
        else:
            self.agent.restore_submission(text)

    def _submit_native_command(self, command: str, display_text: str) -> None:
        labels = self._native_input_labels.setdefault(command, [])
        labels.append(display_text)
        if self.bridge.submit(command):
            self.statusBar().showMessage("Running…")
            return
        labels.pop()
        if not labels:
            self._native_input_labels.pop(command, None)

    def _input_queued(self, text, position):
        labels = self._native_input_labels.get(text, [])
        display_text = labels[-1] if labels else text
        self.agent.add_message(
            "System", f"Queued #{position}: {display_text}", "main"
        )
        self.statusBar().showMessage(f"Queued #{position}", 2500)

    def _guidance_injected(self, text):
        self.agent.add_message("System", f"Guidance injected: {text}", "main")
        self.statusBar().showMessage("Guidance injected", 2500)

    def _input_rejected(self, _text, reason):
        self.agent.add_message("System", reason, "main")
        self.statusBar().showMessage(reason, 4000)

    def _queue_cleared(self, count):
        self._native_input_labels.clear()
        self.agent.add_message(
            "System", f"Stopped current run and cleared {count} queued input(s).", "main"
        )
        self.statusBar().showMessage(f"Cleared {count} queued input(s)", 4000)

    def _input_finished(self, text, _result):
        parts = text.strip().split(maxsplit=1)
        command = parts[0].lower() if parts else ""
        if command == "/clear":
            self.agent.clear_conversation("main")
            self.agent.add_message("System", "Session cleared.", "main")
        if command in {"/load", "/fork"}:
            self.status_session.setText(f"Session {self.runtime.session.session_id}")
            self._refresh_sessions()
        if command == "/model":
            self.status_model.setText(self.runtime.harness.model)
        if command == "/harness":
            self._refresh_harness_runs()

    def _run_finished(self, result):
        active_input = getattr(self, "_active_input", "")
        if result and not active_input.lstrip().startswith("/"):
            self.agent.add_message("Nexgent", ANSI_RE.sub("", result), "main")
        self._ensure_agent_item("main", "ready")
        self.statusBar().showMessage("Ready", 2500)
        self._refresh_sessions()
        self._refresh_harness_runs()

    def _run_failed(self, error):
        self.agent.add_message("Error", error, "main")
        self._ensure_agent_item("main", "failed")
        self.statusBar().showMessage("Run failed", 5000)
        self._refresh_sessions()
        self._refresh_harness_runs()

    def _resolve_interaction(self, request):
        if request.kind.value == "user_input":
            if request.metadata.get("options"):
                options = request.metadata["options"]
                labels = [item.get("label", f"Option {index + 1}") for index, item in enumerate(options)]
                if request.metadata.get("multi_select"):
                    options_text = "\n".join(
                        (
                            f"{index + 1}. {label}"
                            + (
                                f" — {options[index].get('description', '')}"
                                if options[index].get("description")
                                else ""
                            )
                        )
                        for index, label in enumerate(labels)
                    )
                    text, accepted = QInputDialog.getText(
                        self,
                        "Nexgent question",
                        (
                            f"{request.prompt}\n\n{options_text}\n\n"
                            "Enter comma-separated option numbers:"
                        ),
                    )
                    if accepted:
                        try:
                            indices = [int(value.strip()) - 1 for value in text.split(",")]
                        except ValueError:
                            indices = []
                        request.resolve(bool(indices), indices)
                    else:
                        request.resolve(False)
                else:
                    item, accepted = QInputDialog.getItem(
                        self, "Nexgent question", request.prompt, labels, 0, False
                    )
                    request.resolve(accepted, labels.index(item) if accepted else None)
                return
            text, accepted = QInputDialog.getMultiLineText(
                self,
                "Nexgent input",
                request.prompt,
                "",
            )
            request.resolve(accepted, text)
            return
        permission = request.metadata.get("permission", "permission")
        choice = QMessageBox.question(
            self,
            f"Allow {permission}?",
            request.prompt,
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        request.resolve(choice == QMessageBox.StandardButton.Yes)

    def _change_mode(self, mode):
        self.runtime.harness.perms.set_permission_mode(mode)
        self.runtime.harness.plan_mode = mode == "plan"
        self.statusBar().showMessage(f"Mode: {mode}", 2000)

    def _change_model(self, model):
        if model and model != self.runtime.harness.model:
            self._submit(f"/model set {model}")
        self.status_model.setText(model)

    def _refresh_sessions(self):
        self.sessions.clear()
        files = sorted(self.runtime.session_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
        for path in files[:50]:
            self.sessions.addItem(path.stem)

    def _refresh_harness_runs(self):
        store = getattr(self.runtime, "run_store", None)
        if store is None:
            self.harness_runs.set_runs(())
            return
        try:
            runs = [
                run
                for run in store.list_runs()
                if getattr(run.mode, "value", run.mode) == "coding"
            ]
        except Exception as exc:
            self.statusBar().showMessage(f"Cannot load Runs: {exc}", 4000)
            return
        self.harness_runs.set_runs(runs)

    def _new_harness_run(self):
        request = HarnessRunDialog.get_request(self)
        if request is None:
            return
        command = (
            f"/harness run --check {shlex.quote(request.check_command)} "
            f"--task {shlex.quote(request.task)} "
            f"--attempts {request.attempts} --timeout {request.timeout_seconds}"
        )
        self.navigation_tabs.setCurrentWidget(self.harness_runs)
        self._submit_native_command(
            command,
            f"Start verified Run\nTask: {request.task}\n"
            f"Acceptance: {request.check_command}",
        )

    def _resume_harness_run(self, run_id: str):
        request = HarnessResumeDialog.get_request(self)
        if request is None:
            return
        self._submit_native_command(
            f"/harness resume {shlex.quote(run_id)} "
            f"--attempts {request.attempts} --timeout {request.timeout_seconds}",
            f"Resume verified Run\nRun ID: {run_id}",
        )

    def _export_harness_run(self, run_id: str):
        default = self.project_root / ".nexgent" / "exports" / f"{run_id}.jsonl"
        destination, _selected_filter = QFileDialog.getSaveFileName(
            self,
            "Export verified Run evidence",
            str(default),
            "JSON Lines (*.jsonl);;All files (*)",
        )
        if not destination:
            return
        self._submit_native_command(
            f"/harness export {shlex.quote(run_id)} "
            f"--output {shlex.quote(destination)}",
            f"Export Run evidence\nRun ID: {run_id}\nDestination: {destination}",
        )

    def _show_harness_run_details(self, run_id: str):
        store = getattr(self.runtime, "run_store", None)
        if store is None:
            return
        try:
            bundle = store.export_run(run_id)
        except Exception as exc:
            QMessageBox.warning(self, "Cannot inspect Run", str(exc))
            return
        run = bundle["run"]
        verification = bundle["verifications"][-1] if bundle["verifications"] else None
        changed_files = sorted(
            {
                str(event["payload"]["path"])
                for event in bundle["events"]
                if event.get("payload", {}).get("stage") == "workspace-change"
                and event.get("payload", {}).get("path")
            }
        )
        lines = [
            "Harness Run",
            "===========",
            f"Run ID: {run_id}",
            f"Status: {run['status']}",
            f"Objective: {run['objective']}",
            f"Attempts: {len(bundle['attempts'])}",
            f"Fault observations: {len(bundle['faults'])}",
            f"Diagnoses: {len(bundle['diagnoses'])}",
            f"Recoveries: {len(bundle['recoveries'])}",
            f"Verification: {(verification or {}).get('decision', 'not available')}",
            "",
            "Changed files:",
            *(f"- {path}" for path in changed_files),
        ]
        if run.get("termination_reason"):
            lines.extend(("", f"Termination: {run['termination_reason']}"))
        self.preview.text.setPlainText("\n".join(lines))
        self.preview.setCurrentWidget(self.preview.text)
        self.preview_panel.setVisible(True)
        self.statusBar().showMessage(f"Inspecting {run_id}", 3000)

    def _resume_session(self, item):
        path = self.runtime.session_dir / f"{item.text()}.jsonl"
        try:
            loaded = Session.from_jsonl(str(path)).session
        except (OSError, ValueError) as exc:
            QMessageBox.warning(self, "Cannot resume session", str(exc))
            return
        loaded.auto_save_dir = str(self.runtime.session_dir)
        self.runtime.session = loaded
        self.runtime.commands.session = loaded
        self.runtime.checkpoint_manager = CheckpointManager(loaded.session_id)
        self.runtime.commands.checkpoint_manager = self.runtime.checkpoint_manager
        self.runtime.harness._checkpoint_manager = self.runtime.checkpoint_manager
        self.status_session.setText(f"Session {loaded.session_id}")
        self.agent.add_message(
            "System", f"Resumed {loaded.session_id} ({len(loaded.messages)} messages)", "main"
        )

    def _open_config(self):
        dialog = ConfigDialog(self.project_root, self)
        dialog.configuration_saved.connect(self._configuration_saved)
        dialog.exec()

    def _configuration_saved(self):
        registry = get_model_registry()
        registry.reload(str(self.project_root / "models.json"))
        profile = registry.get_profile(self.runtime.harness.model)
        if profile is None:
            profile = registry.get_default("main")
            self.runtime.harness.model = profile.model_name
        self.agent.model.blockSignals(True)
        self.agent.model.clear()
        for item in registry.list_profiles():
            self.agent.model.addItem(item.full_id)
        self.agent.model.setCurrentText(profile.full_id)
        self.agent.model.blockSignals(False)
        self.status_model.setText(profile.full_id)
        self.statusBar().showMessage("Configuration applied", 3000)

    def closeEvent(self, event):
        self.settings.setValue("geometry", self.saveGeometry())
        self.runtime.interaction_broker.set_handler(None)
        self.bridge.close(timeout=5.0)
        event.accept()
