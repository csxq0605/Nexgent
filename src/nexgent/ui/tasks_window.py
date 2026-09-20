"""Task-first desktop: goals, actual execution, delivery, and bounded recovery."""

from __future__ import annotations

import json
import threading
from copy import deepcopy
from pathlib import Path

from PyQt6.QtCore import Qt, QThread, pyqtSignal
from PyQt6.QtWidgets import (
    QAbstractItemView, QFileDialog, QFormLayout, QHBoxLayout, QHeaderView, QLabel,
    QLineEdit, QListWidget, QListWidgetItem, QMainWindow, QPlainTextEdit, QPushButton,
    QSpinBox, QSplitter, QTableWidget, QTableWidgetItem, QTabWidget,
    QVBoxLayout, QWidget,
)


STATUS = {"ready": "待执行", "running": "执行中", "waiting_input": "等待补充资料",
          "paused": "已暂停", "completed": "执行完成", "failed": "执行失败",
          "cancelled": "已取消", "planned": "待执行", "admitted": "已准入",
          "started": "调用中", "received": "已返回", "reserved": "已预留",
          "skipped": "未执行", "blocked": "等待依赖"}
ACCEPTANCE = {"passed": "验收通过", "failed": "验收未通过", "not_tested": "未验收",
              "untested": "未验收", "not_measured": "未验收", "unavailable": "验收缺测",
              "missing": "验收缺测", "not_applicable": "无需独立验收"}

TASK_STYLE = """
QWidget {font-family:'Microsoft YaHei UI',sans-serif;font-size:12px;color:#243c37;}
QMainWindow {background:#f3f6f1;}
QLabel#Brand {font-size:26px;font-weight:700;color:#214a39;}
QLabel#Heading {font-size:22px;font-weight:600;}
QLabel#Error {color:#98421c;background:#fff0e6;border-radius:6px;padding:8px;}
QPlainTextEdit,QListWidget,QTableWidget {background:white;border:1px solid #d7e1d4;border-radius:7px;}
QListWidget::item {padding:10px;}
QListWidget::item:selected {background:#d9e9d7;color:#234b35;}
QPushButton {background:white;border:1px solid #c6d7c4;border-radius:6px;padding:8px 12px;}
QPushButton#Primary {background:#2c6349;color:white;}
QPushButton:disabled {color:#99a797;background:#edf1eb;}
QSpinBox {background:white;padding:5px;border:1px solid #cbd9c7;border-radius:5px;}
QTabBar::tab {padding:10px;color:#667b66;}
QTabBar::tab:selected {color:#234d37;border-bottom:2px solid #628d60;}
QTabWidget::pane {border:0;}
QHeaderView::section {background:#eaf0e6;border:0;padding:7px;}
"""


def json_text(value):
    return json.dumps(value, ensure_ascii=False, indent=2, default=lambda v: f"<{type(v).__name__}>")


def task_status(state):
    status = STATUS.get(state.get("status"), state.get("status", "未记录"))
    if state.get("status") == "completed":
        acceptance = (state.get("outcome") or {}).get("acceptance_status", "not_tested")
        status += " · " + ACCEPTANCE.get(acceptance, str(acceptance))
    return status


class TaskWorker(QThread):
    updated = pyqtSignal(dict)
    result = pyqtSignal(dict)
    failed = pyqtSignal(str)

    def __init__(self, service, episode_id, parent=None):
        super().__init__(parent)
        self.service, self.episode_id = service, episode_id
        self.stop_event = threading.Event()

    def run(self):
        try:
            state = self.service.run(self.episode_id, on_update=lambda s: self.updated.emit(deepcopy(s)),
                                     stop_event=self.stop_event)
            self.result.emit(deepcopy(state))
        except Exception as exc:
            # Persisted service state remains the authority after failure.
            try:
                self.result.emit(deepcopy(self.service.get(self.episode_id)))
            except Exception:
                pass
            self.failed.emit(f"{type(exc).__name__}: {exc}")


class TaskWindow(QMainWindow):
    def __init__(self, project_root, service=None, evolution=None):
        super().__init__()
        self.project_root = Path(project_root).resolve()
        if service is None:
            from ..tasks.runtime import TaskService
            service = TaskService(self.project_root)
        self.service = service
        if evolution is None and hasattr(service, "store"):
            from ..tasks.evolution import EvolutionService
            evolution = EvolutionService(service)
        self.evolution = evolution
        self.improvers = None
        if hasattr(service, "store"):
            from ..tasks.improvers import ImproverService
            self.improvers = ImproverService(service)
        self.selected_id = None
        self.running_id = None
        self.worker = None
        self._close_requested = False
        self._selected_state = None
        self.setWindowTitle("NExgent · 任务空间")
        self.resize(1320, 880)
        self.setStyleSheet(TASK_STYLE)
        self._build()
        self.refresh_tasks()

    def _build(self):
        splitter = QSplitter(Qt.Orientation.Horizontal)
        self.setCentralWidget(splitter)
        sidebar = QWidget()
        left = QVBoxLayout(sidebar)
        left.setContentsMargins(18, 20, 18, 18)
        brand = QLabel("NExgent")
        brand.setObjectName("Brand")
        left.addWidget(brand)
        left.addWidget(QLabel("目标、资料与交付"))
        left.addSpacing(12)
        self.objective = QPlainTextEdit()
        self.objective.setPlaceholderText("描述需要完成的任务，以及成果应满足的要求")
        self.objective.setMaximumHeight(115)
        left.addWidget(QLabel("任务目标"))
        left.addWidget(self.objective)
        self.inputs = QPlainTextEdit()
        self.inputs.setPlaceholderText('可选 JSON 资料，例如 {"document": "原始资料"}')
        self.inputs.setMaximumHeight(120)
        left.addWidget(QLabel("输入资料"))
        left.addWidget(self.inputs)
        self.contract = QPlainTextEdit()
        self.contract.setPlaceholderText(
            '可选 JSON 交付合同，例如 {"deliverables":[{"name":"report","schema":{"type":"object"}}],"constraints":{}}')
        self.contract.setMaximumHeight(90)
        left.addWidget(QLabel("交付合同"))
        left.addWidget(self.contract)
        limits = QFormLayout()
        self.max_calls = self._spin(20, 0, 10000)
        self.max_tokens = self._spin(80000, 0, 100000000)
        self.max_tools = self._spin(20, 0, 10000)
        self.max_nodes = self._spin(100, 0, 100000)
        for label, widget in [("模型调用上限", self.max_calls), ("预留输出 Token", self.max_tokens),
                              ("工具调用上限", self.max_tools), ("执行节点上限", self.max_nodes)]:
            limits.addRow(label, widget)
        left.addLayout(limits)
        self.create_button = QPushButton("登记任务")
        self.create_button.setObjectName("Primary")
        self.create_button.clicked.connect(self.create_task)
        left.addWidget(self.create_button)
        left.addSpacing(10)
        row = QHBoxLayout()
        row.addWidget(QLabel("任务历史"))
        self.refresh_button = QPushButton("刷新")
        self.refresh_button.clicked.connect(self.refresh_tasks)
        row.addWidget(self.refresh_button)
        left.addLayout(row)
        self.task_list = QListWidget()
        self.task_list.currentItemChanged.connect(self._selection_changed)
        left.addWidget(self.task_list, 1)
        splitter.addWidget(sidebar)

        workspace = QWidget()
        main = QVBoxLayout(workspace)
        main.setContentsMargins(24, 22, 24, 18)
        self.heading = QLabel("提交目标，查看真实成果")
        self.heading.setObjectName("Heading")
        self.heading.setWordWrap(True)
        main.addWidget(self.heading)
        self.status_label = QLabel("尚未选择任务")
        main.addWidget(self.status_label)
        self.activity_label = QLabel("没有正在执行的任务")
        main.addWidget(self.activity_label)
        controls = QHBoxLayout()
        self.run_button = QPushButton("执行 / 恢复")
        self.run_button.setObjectName("Primary")
        self.stop_button = QPushButton("停止并保存")
        self.export_button = QPushButton("导出交付与记录")
        self.run_button.clicked.connect(self.run_selected)
        self.stop_button.clicked.connect(self.stop_running)
        self.export_button.clicked.connect(self.export_selected)
        controls.addWidget(self.run_button)
        controls.addWidget(self.stop_button)
        controls.addStretch()
        controls.addWidget(self.export_button)
        main.addLayout(controls)
        self.error_label = QLabel()
        self.error_label.setObjectName("Error")
        self.error_label.setWordWrap(True)
        self.error_label.hide()
        main.addWidget(self.error_label)
        self.tabs = QTabWidget()
        self.delivery = self._reader()
        self.tabs.addTab(self.delivery, "成果与验收")
        self.node_table = QTableWidget(0, 7)
        self.node_table.setHorizontalHeaderLabels(["节点", "状态", "操作", "控制依赖", "工件绑定", "尝试", "失败"])
        self.node_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.node_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.ResizeToContents)
        self.node_table.horizontalHeader().setStretchLastSection(True)
        self.tabs.addTab(self.node_table, "执行与依赖")
        self.evidence = self._reader()
        self.tabs.addTab(self.evidence, "调用与工件")
        self.memory = self._reader()
        self.tabs.addTab(self.memory, "记忆与版本")
        self.events = self._reader()
        self.tabs.addTab(self.events, "活动记录")
        rsi_panel = QWidget()
        rsi_layout = QVBoxLayout(rsi_panel)
        rsi_controls = QHBoxLayout()
        rsi_controls.addWidget(QLabel("AgentPackage 通道"))
        self.rsi_channel = QLineEdit("general")
        self.rsi_channel.setPlaceholderText("例如 general")
        self.rsi_refresh_button = QPushButton("刷新版本状态")
        self.rsi_refresh_button.clicked.connect(self.refresh_rsi)
        rsi_controls.addWidget(self.rsi_channel, 1)
        rsi_controls.addWidget(QLabel("改进器通道"))
        self.improver_channel = QLineEdit("recursive")
        self.improver_channel.setPlaceholderText("例如 recursive")
        rsi_controls.addWidget(self.improver_channel, 1)
        rsi_controls.addWidget(self.rsi_refresh_button)
        rsi_layout.addLayout(rsi_controls)
        rsi_layout.addWidget(QLabel("任务智能体与递归改进器使用独立通道；仅显示版本、决策、守卫和审计摘要。"))
        self.rsi_view = self._reader()
        rsi_layout.addWidget(self.rsi_view, 1)
        self.tabs.addTab(rsi_panel, "RSI 与版本")
        tools_panel = QWidget()
        tools_layout = QVBoxLayout(tools_panel)
        tools_layout.addWidget(QLabel("为新任务勾选允许使用的已安装工具。"))
        self.tool_permissions = QListWidget()
        self.tool_permissions.setMaximumHeight(180)
        tools_layout.addWidget(self.tool_permissions)
        self.tools = self._reader()
        tools_layout.addWidget(self.tools, 1)
        self.tabs.addTab(tools_panel, "工具与授权")
        main.addWidget(self.tabs, 1)
        splitter.addWidget(workspace)
        splitter.setSizes([340, 980])
        try:
            registry = getattr(self.service, "tools", None)
            tools = registry.describe() if registry is not None else []
            if isinstance(tools, list):
                for tool in tools:
                    if not isinstance(tool, dict) or not isinstance(tool.get("name"), str):
                        continue
                    item = QListWidgetItem(tool["name"] + " · " + str(tool.get("effect_class", tool.get("effect", "未记录"))))
                    item.setData(Qt.ItemDataRole.UserRole, tool["name"])
                    item.setFlags(item.flags() | Qt.ItemFlag.ItemIsUserCheckable)
                    item.setCheckState(Qt.CheckState.Unchecked)
                    self.tool_permissions.addItem(item)
            domains = getattr(self.service, "domains", None)
            domains = domains.describe() if hasattr(domains, "describe") else domains
            self.tools.setPlainText("可用能力由任务授权与预算限制。\n\n" + json_text({"tools": tools, "domains": domains}))
        except Exception as exc:
            self.tools.setPlainText(f"读取工具信息失败：{exc}")
        self._buttons()

    @staticmethod
    def _spin(value, minimum, maximum):
        widget = QSpinBox()
        widget.setRange(minimum, maximum)
        widget.setValue(value)
        return widget

    @staticmethod
    def _reader():
        widget = QPlainTextEdit()
        widget.setReadOnly(True)
        return widget

    def _error(self, message=None):
        self.error_label.setText(str(message or ""))
        self.error_label.setVisible(bool(message))

    def _buttons(self):
        state = self._selected_state or {}
        busy = self.worker is not None
        self.run_button.setEnabled(bool(self.selected_id) and not busy and
                                   state.get("status") in {"ready", "paused", "failed", "waiting_input"})
        self.stop_button.setEnabled(busy and not self.worker.stop_event.is_set())
        self.export_button.setEnabled(bool(self.selected_id))
        self.create_button.setEnabled(not self._close_requested)

    def refresh_tasks(self):
        try:
            states = self.service.list()
            selected = self.selected_id
            self.task_list.blockSignals(True)
            try:
                self.task_list.clear()
                current = None
                for state in states:
                    objective = state.get("task", {}).get("objective", state["id"])
                    item = QListWidgetItem(f"{objective[:70]}\n{task_status(state)}")
                    item.setData(Qt.ItemDataRole.UserRole, state["id"])
                    self.task_list.addItem(item)
                    if state["id"] == selected:
                        current = item
                if current is not None:
                    self.task_list.setCurrentItem(current)
            finally:
                self.task_list.blockSignals(False)
            if selected:
                self.show_task(selected)
        except Exception as exc:
            self._error(f"读取任务失败：{exc}")
        self.refresh_rsi()

    def refresh_rsi(self):
        """Refresh bounded task-agent and recursive-improver projections."""
        if self.evolution is None:
            self.rsi_view.setPlainText("当前任务服务未提供 AgentPackage 演化控制面。")
            return
        channel = self.rsi_channel.text().strip()
        improver_channel = self.improver_channel.text().strip()
        if not channel or not improver_channel:
            self.rsi_view.setPlainText("请输入任务智能体通道和改进器通道名称。")
            return
        try:
            from ..tasks.evolution_view import public_channel_view
            from ..tasks.improvers import public_improver_event, public_improver_state
            try:
                task_view = public_channel_view(
                    self.evolution.active(channel), self.evolution.events(channel), limit=50)
            except KeyError:
                task_view = {"channel": channel, "status": "unregistered"}
            try:
                if self.improvers is None:
                    raise KeyError(improver_channel)
                improver_view = {
                    "state": public_improver_state(self.improvers.active(improver_channel)),
                    "events": [public_improver_event(event) for event in
                               self.improvers.events(improver_channel)[-50:]],
                }
            except KeyError:
                improver_view = {"channel": improver_channel, "status": "unregistered"}
            view = {"task_agent": task_view, "recursive_improver": improver_view,
                    "claim_scope": "mechanism evidence; model and statistical effects separate"}
            self.rsi_view.setPlainText(json_text(view))
        except Exception as exc:
            self.rsi_view.setPlainText(f"读取 RSI 版本状态失败：{exc}")

    def _selection_changed(self, current, previous=None):
        if current is not None:
            self.show_task(current.data(Qt.ItemDataRole.UserRole))

    def show_task(self, episode_id):
        try:
            state = self.service.get(episode_id)
            self.selected_id = episode_id
            self._render(state)
        except Exception as exc:
            self._error(f"读取任务失败：{exc}")

    def create_task(self):
        try:
            objective = self.objective.toPlainText().strip()
            if not objective:
                raise ValueError("请填写任务目标")
            raw = self.inputs.toPlainText().strip()
            if len(raw.encode("utf-8")) > 1_000_000:
                raise ValueError("输入资料超过 1 MB")
            inputs = json.loads(raw) if raw else {}
            if not isinstance(inputs, dict):
                raise ValueError("输入资料必须是 JSON 对象，字段名对应输入资料")
            raw_contract = self.contract.toPlainText().strip()
            contract = json.loads(raw_contract) if raw_contract else {}
            if not isinstance(contract, dict) or set(contract) - {"deliverables", "constraints"}:
                raise ValueError("交付合同只能包含 deliverables 和 constraints")
            deliverables = contract.get("deliverables")
            constraints = contract.get("constraints")
            if deliverables is not None and not isinstance(deliverables, list):
                raise ValueError("deliverables 必须是 JSON 数组")
            if constraints is not None and not isinstance(constraints, dict):
                raise ValueError("constraints 必须是 JSON 对象")
            budget = {"max_model_calls": self.max_calls.value(), "max_completion_tokens": self.max_tokens.value(),
                      "max_tool_calls": self.max_tools.value(), "max_nodes": self.max_nodes.value()}
            capabilities = [self.tool_permissions.item(i).data(Qt.ItemDataRole.UserRole)
                            for i in range(self.tool_permissions.count())
                            if self.tool_permissions.item(i).checkState() == Qt.CheckState.Checked]
            state = self.service.create(objective, inputs=inputs, deliverables=deliverables,
                                        constraints=constraints, budget=budget, capabilities=capabilities)
            self.selected_id = state["id"]
            self.refresh_tasks()
            self._error(None)
        except Exception as exc:
            self._error(f"登记任务失败：{exc}")

    def run_selected(self):
        if self.worker is not None or not self.selected_id:
            return
        try:
            state = self.service.get(self.selected_id)
        except Exception as exc:
            self._error(f"读取任务失败：{exc}")
            return
        if state.get("status") not in {"ready", "paused", "failed", "waiting_input"}:
            return
        self._error(None)
        self.running_id = self.selected_id
        self.worker = TaskWorker(self.service, self.running_id, self)
        self.worker.updated.connect(self._update)
        self.worker.result.connect(self._update)
        self.worker.failed.connect(self._worker_error)
        self.worker.finished.connect(self._finished)
        self.activity_label.setText(f"正在执行：{state.get('task', {}).get('objective', self.running_id)}")
        self._buttons()
        self.worker.start()

    def _update(self, state):
        if state.get("id") == self.selected_id:
            self._render(state)
        if state.get("id") == self.running_id:
            self.activity_label.setText(f"当前执行任务：{task_status(state)}")

    def _worker_error(self, message):
        if self.selected_id == self.running_id:
            self._error(f"执行失败：{message}")
        self.activity_label.setText(f"执行任务发生错误：{message}")

    def _finished(self):
        worker = self.worker
        self.worker = None
        self.running_id = None
        if worker is not None:
            worker.deleteLater()
        self.activity_label.setText("没有正在执行的任务")
        self.refresh_tasks()
        self._buttons()
        if self._close_requested:
            self.close()

    def stop_running(self):
        if self.worker is not None:
            self.worker.stop_event.set()
            self.activity_label.setText("正在停止；等待已准入调用收尾并保存")
            self._buttons()

    def export_selected(self):
        if not self.selected_id:
            return
        destination, _ = QFileDialog.getSaveFileName(self, "导出任务交付与记录",
            str(self.project_root / (self.selected_id + ".json")), "JSON (*.json)")
        if not destination:
            return
        try:
            path = self.service.export(self.selected_id, destination=destination)
            self.statusBar().showMessage(f"已导出：{path}")
        except Exception as exc:
            self._error(f"导出失败：{exc}")

    def _render(self, state):
        self._selected_state = deepcopy(state)
        self.heading.setText(state.get("task", {}).get("objective", state["id"]))
        self.status_label.setText(task_status(state))
        self._error(state.get("last_error"))
        outcome = state.get("outcome") or {}
        delivery_status = outcome.get("delivery_status", "未记录")
        acceptance = outcome.get("acceptance_status", "not_tested")
        limitations = outcome.get("limitations", [])
        usage = state.get("usage") or {}
        missing = usage.get("usage_missing_call_ids", [])
        parts = [f"交付状态：{delivery_status}", f"验收状态：{ACCEPTANCE.get(acceptance, acceptance)}",
                 f"模型调用：{usage.get('model_calls', '未记录')}；工具调用：{usage.get('tool_calls', '未记录')}；节点：{usage.get('nodes', '未记录')}",
                 f"输出 Token 预留：{usage.get('reserved_completion_tokens', '未记录')}；用量缺失请求：{len(missing)}",
                 "\n局限：\n" + json_text(limitations), "\n输出引用：\n" + json_text(state.get("output_refs", {}))]
        artifacts = state.get("artifacts", [])
        refs = state.get("output_refs", {})
        output_ids = {ref.get("id") if isinstance(ref, dict) else ref for ref in refs.values()} if isinstance(refs, dict) else set(refs)
        delivered = [a for a in artifacts if a.get("id") in output_ids]
        if delivered:
            parts.append("\n交付内容：\n" + json_text(delivered))
        self.delivery.setPlainText("\n".join(parts))
        nodes = state.get("nodes", {})
        rows = list(nodes.items()) if isinstance(nodes, dict) else [(n.get("id", str(i)), n) for i, n in enumerate(nodes)]
        self.node_table.setRowCount(len(rows))
        for index, (identity, node) in enumerate(rows):
            operation = node.get("operator", node.get("kind", node.get("method", node.get("op", "未记录"))))
            control = node.get("control_dependencies", node.get("depends_on", node.get("dependencies", [])))
            bindings = node.get("bindings", node.get("inputs", node.get("input_refs", {})))
            values = [identity, STATUS.get(node.get("status"), node.get("status", "未记录")), operation,
                      json_text(control), json_text(bindings), node.get("attempt_id", node.get("attempt", node.get("id", "未记录"))),
                      node.get("error", node.get("last_error", ""))]
            for column, value in enumerate(values):
                self.node_table.setItem(index, column, QTableWidgetItem(value if isinstance(value, str) else json_text(value)))
        self.evidence.setPlainText(json_text({"inputs": state.get("input_refs", {}), "artifacts": artifacts,
                                             "usage": usage, "calls": state.get("calls", []),
                                             "children": state.get("children", state.get("child_episode_ids", [])),
                                             "execution": state.get("execution")}))
        retrieval_events = [e for e in state.get("events", []) if e.get("kind", "").startswith("memory_")]
        self.memory.setPlainText("检索条目保留来源与 candidate / accepted 状态。\n\n" + json_text(
            {"package_id": state.get("package_id"), "package_digest": state.get("package_digest"),
             "memory_snapshot_id": state.get("memory_snapshot_id"), "memory_snapshot": state.get("memory_snapshot"),
             "retrievals": state.get("retrievals", retrieval_events)}))
        self.events.setPlainText(json_text(state.get("events", [])))
        self._buttons()

    def closeEvent(self, event):
        if self.worker is not None:
            self._close_requested = True
            self.stop_running()
            self.create_button.setEnabled(False)
            event.ignore()
        else:
            event.accept()
