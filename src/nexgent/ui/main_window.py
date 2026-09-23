"""Conversation-first Nexgent desktop surface.

The Main window is intentionally small.  It is the user-facing entry point for
the generic task runtime; the existing TaskWindow remains available as an
advanced execution and evidence console.
"""

from __future__ import annotations

import html
import json
from copy import deepcopy
from pathlib import Path

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QPlainTextEdit,
    QPushButton,
    QSplitter,
    QTabWidget,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
)

from ..tasks.self_orchestration_seed import self_orchestration_package
from .tasks_window import ACCEPTANCE, STATUS, TaskWorker, task_status


MAIN_STYLE = """
QWidget { font-family:'Microsoft YaHei UI',sans-serif; font-size:12px; color:#243c37; }
QMainWindow { background:#f3f6f1; }
QLabel#Brand { font-size:25px; font-weight:700; color:#214a39; }
QLabel#MainTitle { font-size:21px; font-weight:600; color:#1e4637; }
QLabel#Muted { color:#6c7c72; }
QLabel#Status { color:#286247; padding:5px 9px; background:#e5f1e5; border-radius:10px; }
QTextBrowser, QPlainTextEdit, QListWidget { background:white; border:1px solid #d7e1d4; border-radius:8px; }
QTextBrowser { padding:10px; }
QPlainTextEdit { padding:8px; }
QListWidget::item { padding:9px 8px; border-radius:6px; }
QListWidget::item:selected { background:#d9e9d7; color:#234b35; }
QPushButton { background:white; border:1px solid #c6d7c4; border-radius:6px; padding:8px 12px; }
QPushButton:hover { background:#edf5eb; }
QPushButton#Primary { background:#2c6349; color:white; border-color:#2c6349; }
QPushButton#Primary:hover { background:#24573f; }
QPushButton:disabled { color:#99a797; background:#edf1eb; }
QTabBar::tab { padding:9px 11px; color:#667b66; }
QTabBar::tab:selected { color:#234d37; border-bottom:2px solid #628d60; }
QTabWidget::pane { border:0; }
"""

MAIN_PACKAGE_CHANNEL = "nexgent-main"


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, default=lambda item: f"<{type(item).__name__}>")


def _brief(value, limit=180):
    if value is None:
        return "未记录"
    if isinstance(value, str):
        result = value
    else:
        result = json.dumps(value, ensure_ascii=False, default=str)
    result = " ".join(result.split())
    return result[:limit] + ("…" if len(result) > limit else "")


def _list_summary(value, empty):
    if not value:
        return empty
    if isinstance(value, dict):
        return "\n".join(f"• {key}: {_brief(item)}" for key, item in value.items())
    if isinstance(value, list):
        return "\n".join(f"• {_brief(item)}" for item in value)
    return _brief(value)


class MainWindow(QMainWindow):
    """Main conversation surface backed by the generic ``TaskService``."""

    def __init__(self, project_root, service=None):
        super().__init__()
        self.project_root = Path(project_root).resolve()
        if service is None:
            from ..tasks.runtime import TaskService

            service = TaskService(self.project_root)
        self.service = service
        self.selected_id: str | None = None
        self.worker: TaskWorker | None = None
        self._selected_state: dict | None = None
        self._console = None
        self._event_counts: dict[str, int] = {}
        self.setWindowTitle("Nexgent · Main")
        self.resize(1440, 900)
        self.setStyleSheet(MAIN_STYLE)
        self._build()
        self.refresh_tasks()
        self._welcome()

    @staticmethod
    def _reader():
        widget = QPlainTextEdit()
        widget.setReadOnly(True)
        return widget

    def _build(self):
        splitter = QSplitter(Qt.Orientation.Horizontal)
        self.setCentralWidget(splitter)

        sidebar = QWidget()
        side = QVBoxLayout(sidebar)
        side.setContentsMargins(16, 18, 12, 16)
        brand = QLabel("Nexgent")
        brand.setObjectName("Brand")
        side.addWidget(brand)
        tagline = QLabel("Main · 通用任务智能体")
        tagline.setObjectName("Muted")
        side.addWidget(tagline)
        side.addSpacing(12)
        new_button = QPushButton("＋  新对话")
        new_button.setObjectName("Primary")
        new_button.clicked.connect(self.new_conversation)
        side.addWidget(new_button)
        side.addWidget(QLabel("最近任务"))
        self.task_list = QListWidget()
        self.task_list.setObjectName("TaskHistory")
        self.task_list.currentItemChanged.connect(self._selection_changed)
        side.addWidget(self.task_list, 1)
        project_label = QLabel(f"项目\n{self.project_root}")
        project_label.setObjectName("Muted")
        project_label.setWordWrap(True)
        side.addWidget(project_label)
        splitter.addWidget(sidebar)

        center = QWidget()
        main = QVBoxLayout(center)
        main.setContentsMargins(24, 20, 24, 18)
        header = QHBoxLayout()
        title = QLabel("Main")
        title.setObjectName("MainTitle")
        header.addWidget(title)
        self.status_label = QLabel("准备好开始")
        self.status_label.setObjectName("Status")
        header.addWidget(self.status_label)
        header.addStretch()
        main.addLayout(header)
        intro = QLabel("告诉 Nexgent 你要完成什么；它会在后台组织智能体、工具、验证和交付。")
        intro.setObjectName("Muted")
        main.addWidget(intro)
        self.messages = QTextBrowser()
        self.messages.setOpenExternalLinks(False)
        main.addWidget(self.messages, 1)
        composer_label = QLabel("给 Main 的消息")
        composer_label.setObjectName("Muted")
        main.addWidget(composer_label)
        self.composer = QPlainTextEdit()
        self.composer.setPlaceholderText("例如：比较这两份设计，给出有证据的建议；或运行一个 benchmark 任务。")
        self.composer.setMaximumHeight(105)
        self.composer.installEventFilter(self)
        main.addWidget(self.composer)
        controls = QHBoxLayout()
        self.send_button = QPushButton("发送并执行")
        self.send_button.setObjectName("Primary")
        self.send_button.clicked.connect(self.send_message)
        self.stop_button = QPushButton("停止并保存")
        self.stop_button.clicked.connect(self.stop_running)
        self.advanced_button = QPushButton("打开高级控制台")
        self.advanced_button.clicked.connect(self.open_advanced)
        self.export_button = QPushButton("导出成果")
        self.export_button.clicked.connect(self.export_selected)
        controls.addWidget(self.send_button)
        controls.addWidget(self.stop_button)
        controls.addStretch()
        controls.addWidget(self.advanced_button)
        controls.addWidget(self.export_button)
        main.addLayout(controls)
        self.error_label = QLabel()
        self.error_label.setStyleSheet("color:#98421c;background:#fff0e6;padding:7px;border-radius:6px;")
        self.error_label.setWordWrap(True)
        self.error_label.hide()
        main.addWidget(self.error_label)
        splitter.addWidget(center)

        inspector = QTabWidget()
        self.run_view = self._reader()
        self.delivery_view = self._reader()
        self.evidence_view = self._reader()
        inspector.addTab(self.run_view, "运行")
        inspector.addTab(self.delivery_view, "成果")
        inspector.addTab(self.evidence_view, "证据")
        splitter.addWidget(inspector)
        splitter.setSizes([240, 760, 360])
        self._buttons()

    def eventFilter(self, watched, event):
        if watched is self.composer and event.type() == event.Type.KeyPress:
            if event.key() in {Qt.Key.Key_Return, Qt.Key.Key_Enter} and event.modifiers() & Qt.KeyboardModifier.ControlModifier:
                self.send_message()
                return True
        return super().eventFilter(watched, event)

    def _welcome(self):
        self.messages.setHtml(
            "<div style='margin:28px 10px'>"
            "<h2>今天要处理什么？</h2>"
            "<p>自然语言是入口。Nexgent 会创建一个可恢复的 Episode，按需调用智能体和工具，并把成果、证据与限制留在项目中。</p>"
            "<p style='color:#6c7c72'>资源预算、交付合同和 RSI 版本在高级控制台中可见；普通任务不需要先填写它们。</p>"
            "</div>"
        )

    def _append(self, role: str, content: str, *, color: str = "#243c37"):
        label = {"user": "你", "main": "Nexgent · Main", "system": "运行记录"}.get(role, role)
        safe = html.escape(str(content)).replace("\n", "<br>")
        self.messages.append(
            f"<p style='margin:12px 8px;color:{color}'><b>{html.escape(label)}</b><br>{safe}</p>"
        )
        scrollbar = self.messages.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())

    def _error(self, message=None):
        self.error_label.setText(str(message or ""))
        self.error_label.setVisible(bool(message))

    def _buttons(self):
        busy = self.worker is not None
        self.send_button.setEnabled(not busy)
        self.stop_button.setEnabled(busy and not self.worker.stop_event.is_set() if busy else False)
        self.export_button.setEnabled(bool(self.selected_id))

    def refresh_tasks(self):
        try:
            states = self.service.list()
            selected = self.selected_id
            self.task_list.blockSignals(True)
            try:
                self.task_list.clear()
                current = None
                for state in states:
                    identity = state.get("id")
                    if not isinstance(identity, str):
                        continue
                    objective = (state.get("task") or {}).get("objective", identity)
                    item = QListWidgetItem(f"{str(objective)[:54]}\n{task_status(state)}")
                    item.setData(Qt.ItemDataRole.UserRole, identity)
                    self.task_list.addItem(item)
                    if identity == selected:
                        current = item
                if current is not None:
                    self.task_list.setCurrentItem(current)
            finally:
                self.task_list.blockSignals(False)
            if selected:
                self.show_task(selected, preserve_conversation=True)
        except Exception as exc:
            self._error(f"读取任务失败：{exc}")
        self._buttons()

    def _selection_changed(self, current, previous=None):
        if current is not None:
            self.show_task(current.data(Qt.ItemDataRole.UserRole))

    def new_conversation(self):
        self.selected_id = None
        self._selected_state = None
        self.task_list.clearSelection()
        self.status_label.setText("准备好开始")
        self._welcome()
        self.run_view.clear()
        self.delivery_view.clear()
        self.evidence_view.clear()
        self._error(None)
        self.composer.clear()
        self.composer.setFocus()
        self._buttons()

    def send_message(self):
        if self.worker is not None:
            self._error("当前 Episode 正在执行；请等待完成，或先停止并保存。")
            return
        objective = self.composer.toPlainText().strip()
        if not objective:
            self._error("请先告诉 Nexgent 要完成什么。")
            return
        try:
            state = self.service.create(
                objective, context={"split_role": "development"},
                **self._package_selection())
        except Exception as exc:
            self._error(f"创建 Episode 失败：{exc}")
            return
        self._error(None)
        self.composer.clear()
        self.selected_id = state["id"]
        self._event_counts[state["id"]] = 0
        self._append("user", objective, color="#214a39")
        self._append("main", "目标已接收。我会组织执行、检查中间结果，并在交付时报告证据和限制。")
        self.refresh_tasks()
        self._start(state["id"])

    def _package_selection(self):
        """Resolve the project's promoted Main package before admitting a task."""
        from ..tasks.runtime import TaskService

        if not isinstance(self.service, TaskService):
            return {"package": self_orchestration_package()}
        from ..tasks.evolution import EvolutionService

        evolution = EvolutionService(self.service)
        try:
            evolution.active(MAIN_PACKAGE_CHANNEL)
        except KeyError:
            evolution.register(MAIN_PACKAGE_CHANNEL, self_orchestration_package())
        return {"package_channel": MAIN_PACKAGE_CHANNEL}

    def show_task(self, episode_id, *, preserve_conversation=False):
        try:
            state = self.service.get(episode_id)
        except Exception as exc:
            self._error(f"读取任务失败：{exc}")
            return
        self.selected_id = episode_id
        self._render(state)
        if not preserve_conversation:
            objective = (state.get("task") or {}).get("objective", episode_id)
            self.messages.clear()
            self._append("user", objective, color="#214a39")
            status = task_status(state)
            self._append("main", f"这是该 Episode 的当前记录。状态：{status}")
            outcome = state.get("outcome") or {}
            if outcome:
                summary = outcome.get("summary") or outcome.get("delivery_status") or "已记录"
                self._append("main", "交付摘要：" + _brief(summary, 320))
        self._buttons()

    def _start(self, episode_id):
        try:
            state = self.service.get(episode_id)
        except Exception as exc:
            self._error(f"读取 Episode 失败：{exc}")
            return
        if state.get("status") not in {"ready", "paused", "failed", "waiting_input"}:
            self._render(state)
            return
        self.worker = TaskWorker(self.service, episode_id, self)
        self.worker.updated.connect(self._update)
        self.worker.result.connect(self._update)
        self.worker.failed.connect(self._worker_error)
        self.worker.finished.connect(self._finished)
        self.status_label.setText("执行中")
        self._buttons()
        self.worker.start()

    def _update(self, state):
        if state.get("id") != self.selected_id:
            return
        self._render(state)
        events = state.get("events") or []
        previous = self._event_counts.get(state["id"], 0)
        for event in events[previous:]:
            if isinstance(event, dict):
                kind = event.get("kind", "event")
                content = event.get("content") or {}
                self._append("system", f"{kind} · {_json(content) if content else '已记录'}", color="#6c7c72")
        self._event_counts[state["id"]] = len(events)

    def _worker_error(self, message):
        self._error(f"执行失败：{message}")
        self._append("main", f"执行遇到错误；已保留持久状态。{message}", color="#98421c")

    def _finished(self):
        worker = self.worker
        self.worker = None
        if worker is not None:
            worker.deleteLater()
        try:
            if self.selected_id:
                state = self.service.get(self.selected_id)
                self._render(state)
                self._append("main", f"Episode 已停止或完成：{task_status(state)}")
        except Exception as exc:
            self._error(f"读取最终状态失败：{exc}")
        self.refresh_tasks()
        self._buttons()

    def stop_running(self):
        if self.worker is not None:
            self.worker.stop_event.set()
            self.status_label.setText("正在停止并保存")
            self._buttons()

    def _render(self, state):
        self._selected_state = deepcopy(state)
        status = task_status(state)
        self.status_label.setText(status)
        nodes = state.get("nodes") or {}
        node_rows = []
        superseded = 0
        if isinstance(nodes, dict):
            for identity, node in nodes.items():
                if isinstance(node, dict):
                    if node.get("status") == "superseded":
                        superseded += 1
                        continue
                    node_status = STATUS.get(node.get("status"), node.get("status", "待执行"))
                    operator = node.get("operator", node.get("kind", node.get("method", "步骤")))
                    name = str(identity).rsplit("/", 1)[-1].replace("_", " ")
                    node_rows.append(f"• {node_status} · {name}（{operator}）")
        usage = state.get("usage") or {}
        usage_rows = []
        for key, label in (("model_calls", "模型调用"), ("tool_calls", "工具调用"),
                           ("nodes", "节点"), ("charged_completion_tokens", "预留输出 tokens")):
            if key in usage:
                usage_rows.append(f"{label}：{usage[key]}")
        run_text = [f"状态：{status}", f"Episode：{state.get('id', '未记录')}", "",
                    "执行步骤", "\n".join(node_rows) if node_rows else "尚无执行步骤"]
        if superseded:
            run_text.append(f"另有 {superseded} 条已替代的内部步骤，详见高级控制台。")
        if usage_rows:
            run_text.extend(["", "资源用量", "\n".join(usage_rows)])
        if state.get("last_error"):
            run_text.extend(["", "最近错误", _brief(state["last_error"], 400)])
        self.run_view.setPlainText("\n".join(run_text))
        outcome = state.get("outcome") or {}
        acceptance = outcome.get("acceptance_status", "not_tested")
        self.delivery_view.setPlainText("\n".join([
            f"交付：{outcome.get('delivery_status', '未记录')}",
            f"验收：{ACCEPTANCE.get(acceptance, acceptance)}", "",
            "摘要", _brief(outcome.get("summary")), "",
            "输出", _list_summary(state.get("output_refs"), "暂无输出引用"), "",
            "工件", _list_summary(state.get("artifacts"), "暂无交付工件"), "",
            "限制", _list_summary(outcome.get("limitations"), "未记录限制"),
        ]))
        calls = state.get("calls") or []
        events = state.get("events") or []
        event_names = [str(event.get("kind", "事件")) for event in events[-8:]
                       if isinstance(event, dict)]
        self.evidence_view.setPlainText("\n".join([
            "证据概览",
            f"模型/工具调用收据：{len(calls)}",
            f"事件：{len(events)}",
            f"工件：{len(state.get('artifacts') or [])}", "",
            "最近事件", "\n".join(f"• {name}" for name in event_names) if event_names else "暂无事件", "",
            "完整收据和原始字段请在高级控制台查看，或导出该 Episode。",
        ]))
        self._buttons()

    def open_advanced(self):
        from .tasks_window import TaskWindow

        self._console = TaskWindow(self.project_root, service=self.service)
        if self.selected_id:
            self._console.show_task(self.selected_id)
        self._console.show()
        self._console.raise_()
        self._console.activateWindow()

    def export_selected(self):
        if not self.selected_id:
            return
        destination, _ = QFileDialog.getSaveFileName(
            self, "导出任务交付与记录", str(self.project_root / f"{self.selected_id}.json"), "JSON (*.json)")
        if not destination:
            return
        try:
            path = self.service.export(self.selected_id, destination=destination)
            self.statusBar().showMessage(f"已导出：{path}")
        except Exception as exc:
            self._error(f"导出失败：{exc}")

    def closeEvent(self, event):
        if self.worker is not None:
            self.worker.stop_event.set()
            self.worker.wait(5000)
            self.worker = None
        event.accept()
