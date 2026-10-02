"""Conversation-first Nexgent desktop surface.

The Main window is intentionally small.  It is the user-facing entry point for
the generic task runtime; the existing TaskWindow remains available as an
advanced execution and evidence console.
"""

from __future__ import annotations

import html
import json
import threading
import uuid
from copy import deepcopy
from pathlib import Path

from PyQt6.QtCore import Qt, QThread, QTimer, pyqtSignal
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

from ..application import Nexgent, framework_package, MAIN_PACKAGE_CHANNEL, MAIN_CAPABILITY_AUTHORITY
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

class AutoEvolutionWorker(QThread):
    result = pyqtSignal(dict)
    failed = pyqtSignal(str)

    def __init__(self, trigger, parent=None):
        super().__init__(parent)
        self.trigger = trigger
        self.stop_event = threading.Event()

    def run(self):
        from ..tasks.auto_runtime import advance_auto_evolution

        try:
            self.result.emit(advance_auto_evolution(
                self.trigger, stop_event=self.stop_event))
        except Exception as exc:
            self.failed.emit(type(exc).__name__)


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


def _capability_evidence(state):
    """Summarize verified identities without showing source or model payloads."""
    authority = (state.get("task") or {}).get("capability_authority")
    rows = []
    if isinstance(authority, dict):
        rows.append("任务能力授权：" + ", ".join(authority.get("allowed_kinds", [])))
        rows.append("授权摘要：" + str(authority.get("digest", "未记录"))[:16])
    labels = {
        "capability_definition_staged": "工具定义已暂存",
        "capability_instance_mounted": "工具已激活",
        "capability_instance_released": "工具已释放",
        "service_definition_staged": "服务定义已暂存",
        "service_provider_activated": "服务已激活",
        "service_provider_released": "服务已释放",
        "service_applied": "服务已应用于模型调用",
    }
    for event in (state.get("events") or [])[-80:]:
        if not isinstance(event, dict) or event.get("kind") not in labels:
            continue
        content = event.get("content") or {}
        if not isinstance(content, dict):
            continue
        binding = content.get("binding") or {}
        identity = (content.get("definition_id")
                    or binding.get("definition_id")
                    or content.get("name") or "")
        rows.append("• " + labels[event["kind"]] +
                    (" · " + str(identity)[:52] if identity else ""))
    return rows


class MainWindow(QMainWindow):
    """Main conversation surface backed by the generic ``TaskService``."""

    def __init__(self, project_root, service=None):
        super().__init__()
        self.project_root = Path(project_root).resolve()
        if service is None:
            service = Nexgent(self.project_root)
        self.service = service
        self.conversation_id = uuid.uuid4().hex
        self.attachments = []
        self._auto_evolution = None
        from ..tasks.runtime import TaskService
        if isinstance(service, Nexgent):
            self._auto_evolution = service.auto_evolution
        elif isinstance(service, TaskService):
            from ..tasks.auto_runtime import configure_auto_evolution
            self._auto_evolution = configure_auto_evolution(
                service, project_root=self.project_root)
        self.selected_id: str | None = None
        self.worker: TaskWorker | None = None
        self._recovery_worker: AutoEvolutionWorker | None = None
        self._selected_state: dict | None = None
        self._console = None
        self._event_counts: dict[str, int] = {}
        self._shown_outputs = set()
        self._close_when_finished = False
        self.setWindowTitle("Nexgent · Main")
        self.resize(1440, 900)
        self.setStyleSheet(MAIN_STYLE)
        self._build()
        self.refresh_tasks()
        self._welcome()
        if (self._auto_evolution is not None
                and (self.service.store.terminal_episode_ids(limit=1)
                     or self.service.store.feedback_triggers(limit=1))):
            QTimer.singleShot(0, self._start_recovery)

    def _start_recovery(self):
        if self._recovery_worker is not None or self._auto_evolution is None:
            return
        self._recovery_worker = AutoEvolutionWorker(self._auto_evolution, self)
        self._recovery_worker.result.connect(self._auto_result)
        self._recovery_worker.failed.connect(self._auto_error)
        self._recovery_worker.finished.connect(self._recovery_finished)
        self._recovery_worker.start()

    def _recovery_finished(self):
        worker = self._recovery_worker
        self._recovery_worker = None
        if worker is not None:
            worker.deleteLater()
        if self._close_when_finished and self.worker is None:
            self.close()

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
        self.attach_button = QPushButton("添加文件")
        self.attach_button.clicked.connect(self.attach_inputs)
        self.feedback_button = QPushButton("保存反馈")
        self.feedback_button.clicked.connect(self.save_feedback)
        self.learn_button = QPushButton("根据反馈再执行")
        self.learn_button.clicked.connect(self.learn_selected)
        controls.addWidget(self.attach_button)
        controls.addWidget(self.send_button)
        controls.addWidget(self.stop_button)
        controls.addWidget(self.feedback_button)
        controls.addWidget(self.learn_button)
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
        delivered = bool((self._selected_state or {}).get('output_refs'))
        self.attach_button.setEnabled(not busy and hasattr(self.service, 'attach_files'))
        self.feedback_button.setEnabled(not busy and delivered and hasattr(self.service, 'feedback'))
        self.learn_button.setEnabled(not busy and delivered and hasattr(self.service, 'learn'))

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
        self.conversation_id = uuid.uuid4().hex
        self.attachments = []
        self.attach_button.setText('添加文件')
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
                objective, inputs={'attachments': deepcopy(self.attachments)} if self.attachments else {},
                context={"conversation_id": self.conversation_id, "split": "development",
                                    "split_role": "development"},
                capability_authority=deepcopy(MAIN_CAPABILITY_AUTHORITY),
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

    def attach_inputs(self):
        paths, _ = QFileDialog.getOpenFileNames(self, '选择任务输入', str(self.project_root),
                                               '任务文件 (*.xlsx *.csv *.txt *.md *.json)')
        if paths:
            try:
                self.attachments = self.service.attach_files(paths)
                self.attach_button.setText(f'已添加 {len(self.attachments)} 个文件')
            except Exception as exc:
                self._error(str(exc))

    def save_feedback(self):
        text = self.composer.toPlainText().strip()
        if not text or not self.selected_id:
            self._error('请在消息框填写对当前交付的反馈。')
            return
        try:
            self.service.feedback(self.selected_id, text)
            self.composer.clear()
            self._append('user', '反馈：' + text)
        except Exception as exc:
            self._error(str(exc))

    def learn_selected(self):
        if not self.selected_id or self.worker is not None:
            return
        try:
            text = self.composer.toPlainText().strip()
            if text:
                self.service.feedback(self.selected_id, text)
                self.composer.clear()
            state = self.service.learn(self.selected_id)
            self.selected_id = state['id']
            self._append('main', '使用已保存反馈和当前框架版本重新执行。')
            self._start(state['id'])
        except Exception as exc:
            self._error(str(exc))

    def _package_selection(self):
        """Resolve the project's promoted Main package before admitting a task."""
        if isinstance(self.service, Nexgent):
            return self.service.package_selection()
        from ..tasks.runtime import TaskService

        if not isinstance(self.service, TaskService):
            return {"package": framework_package()}
        from ..tasks.evolution import EvolutionService

        from ..tasks.auto_runtime import single_auto_channel

        channel = single_auto_channel(self._auto_evolution)
        if self._auto_evolution is not None and channel is None:
            raise ValueError("请为 Main 配置自动改进的 default_channel")
        channel = channel or MAIN_PACKAGE_CHANNEL
        evolution = EvolutionService(self.service)
        try:
            evolution.active(channel)
        except KeyError:
            evolution.register(channel, framework_package())
        return {"package_channel": channel}

    def show_task(self, episode_id, *, preserve_conversation=False):
        try:
            state = self.service.get(episode_id)
        except Exception as exc:
            self._error(f"读取任务失败：{exc}")
            return
        self.selected_id = episode_id
        self._render(state)
        if not preserve_conversation:
            self.conversation_id = state.get('task', {}).get('context', {}).get('conversation_id', uuid.uuid4().hex)
            objective = (state.get("task") or {}).get("objective", episode_id)
            self.messages.clear()
            self._append("user", objective, color="#214a39")
            status = task_status(state)
            self._append("main", f"已保存的任务。状态：{status}")
            outcome = state.get("outcome") or {}
            if outcome:
                artifacts = [a for a in state.get('artifacts', [])
                             if a.get('id') in state.get('output_refs', {}).values() and 'content' in a]
                if artifacts:
                    for artifact in artifacts:
                        self._append('main', artifact['content'] if isinstance(artifact['content'], str) else _json(artifact['content']))
                else:
                    summary = outcome.get('summary') or outcome.get('delivery_status') or '已记录'
                    self._append('main', '交付摘要：' + _brief(summary, 320))
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
        if self._auto_evolution is not None and not isinstance(self.service, Nexgent):
            from ..tasks.auto_runtime import advance_auto_evolution
            self.worker.after_run = lambda: advance_auto_evolution(
                self._auto_evolution, source_episode_id=episode_id,
                stop_event=self.worker.stop_event)
        self.worker.updated.connect(self._update)
        self.worker.result.connect(self._task_result)
        self.worker.failed.connect(self._worker_error)
        self.worker.evolution.connect(self._auto_result)
        self.worker.evolution_failed.connect(self._auto_error)
        self.worker.finished.connect(self._finished)
        self.status_label.setText("执行中")
        self._buttons()
        self.worker.start()

    def _task_result(self, state):
        self._update(state)
        if isinstance(self.service, Nexgent):
            self._auto_result(state.get('auto_evolution') or {})
            return
        if self._auto_evolution is not None and state.get("status") in {
                "completed", "failed", "cancelled"}:
            self.status_label.setText("任务已结束；正在检查改进证据")

    def _auto_result(self, result):
        if result.get('rounds') == 0:
            return
        work = [row for row in result.get("work") or [] if row.get("channel")]
        if not work:
            return
        labels = {
            'completed': '修改已通过验证并发布，后续任务会使用新版本',
            'no_change': '本轮没有新修改',
            'rejected': '候选未通过验证，保留当前版本',
            'rolled_back': '后续检查未通过，已恢复前一版本',
            'deferred': '本轮暂未发布修改',
        }
        summary = '；'.join(dict.fromkeys(
            labels.get(row['status'], '正在验证候选修改') for row in work))
        self._append("system", "自动改进：" + summary, color="#6c7c72")

    def _auto_error(self, error_type):
        self._append("system", "自动改进中断；持久工作可恢复。" + error_type,
                     color="#98421c")

    def _update(self, state):
        if state.get("id") != self.selected_id:
            return
        self._render(state)
        if state.get('status') == 'completed':
            for artifact in state.get('artifacts', []):
                key = state['id'], artifact.get('id')
                if (artifact.get('id') in state.get('output_refs', {}).values()
                        and 'content' in artifact and key not in self._shown_outputs):
                    self._shown_outputs.add(key)
                    self._append('main', artifact['content'] if isinstance(artifact['content'], str) else _json(artifact['content']))
        events = state.get("events") or []
        previous = self._event_counts.get(state["id"], 0)
        for event in events[previous:]:
            if isinstance(event, dict):
                kind = event.get("kind", "event")
                content = event.get("content") or {}
                if kind in {'episode_started', 'episode_finished', 'delivery_evaluation_started', 'benchmark_evaluated', 'tool'}:
                    label = {'episode_started': '开始执行', 'episode_finished': '执行已结束',
                             'delivery_evaluation_started': '正在独立评价', 'benchmark_evaluated': '独立评价已完成',
                             'tool': '执行工具'}[kind]
                    self._append('system', label + (' · ' + str(content['name']) if content.get('name') else ''), color='#6c7c72')
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
        if self._close_when_finished and self._recovery_worker is None:
            self.close()

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
            f"模型调用收据：{len(calls)}",
            f"事件：{len(events)}",
            f"工件：{len(state.get('artifacts') or [])}", "",
            "能力与版本", "\n".join(_capability_evidence(state)) or "尚无能力变更", "",
            "持续改进：" + ('已连接项目改进策略' if self._auto_evolution is not None else '尚未配置跨任务改进策略'), "",
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
        if self._recovery_worker is not None:
            self._recovery_worker.stop_event.set()
            if not self._recovery_worker.wait(5000):
                self._close_when_finished = True
                self.statusBar().showMessage("正在等待当前模型或评价步骤结束后关闭")
                event.ignore()
                return
            self._recovery_worker = None
        if self.worker is not None:
            self.worker.stop_event.set()
            if not self.worker.wait(5000):
                self._close_when_finished = True
                self.statusBar().showMessage("正在等待当前模型或评价步骤结束后关闭")
                event.ignore()
                return
            self.worker = None
        event.accept()
