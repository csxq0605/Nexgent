"""A read-oriented research space over the StudyController public contract."""

from __future__ import annotations

from copy import deepcopy
import difflib
import html
import json
import math
from pathlib import Path
import threading

from PyQt6.QtCore import Qt, QThread, QTimer, pyqtSignal
from PyQt6.QtGui import QDesktopServices
from PyQt6.QtWidgets import (
    QAbstractItemView, QComboBox, QDialog, QDialogButtonBox, QFileDialog,
    QFrame, QGridLayout, QHBoxLayout, QHeaderView, QLabel, QListWidget,
    QListWidgetItem, QMainWindow, QPlainTextEdit, QPushButton, QSpinBox,
    QSplitter, QTableWidget, QTableWidgetItem, QTabWidget, QTextBrowser,
    QTreeWidget, QTreeWidgetItem, QVBoxLayout, QWidget,
)


STATUS = {"created": "待开始", "ready": "待开始", "running": "研究中", "paused": "已暂停",
          "completed": "已完成", "failed": "运行失败", "interrupted": "已中断",
          "promoted": "已晋升", "rejected": "未晋升", "eligible": "待选择",
          "received": "已返回", "started": "进行中", "reserved": "已预留",
          "invalid": "输出无效", "token_budget_exhausted": "Token 额度耗尽", "research archive": "保留为探索分支"}
ARMS = {"full": "完整 RSI", "task_only": "固定改进器对照", "greedy": "仅冠军分支对照"}
EVENT_NAMES = {"registration": "研究登记", "measurement_started": "数值评价开始", "measurement": "数值评价完成",
    "measurement_reused": "复用已有数值证据", "capability": "科研能力调用", "agent_log": "智能体研究笔记",
    "offspring_generated": "产生源码后代", "candidate_evaluated": "候选独立评价", "model": "模型请求",
    "study_completed": "研究流程完成", "stopped": "研究已停止", "failure": "执行失败",
    "meta_registration": "登记元能力对照", "meta_evaluation_completed": "元能力对照完成"}

STYLE = """
QWidget { font-family: 'Microsoft YaHei UI', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif;
          font-size: 12px; color: #243638; }
QMainWindow, QWidget#Canvas { background: #f4f6f2; }
QFrame#Sidebar { background: #173732; border: 0; }
QFrame#Sidebar QLabel { color: #d5e3da; }
QLabel#Brand { color: #f5f8eb; font-size: 26px; font-weight: 800; }
QLabel#Eyebrow { font-size: 11px; color: #657e6e; font-weight: 700; }
QLabel#Heading { font-size: 27px; font-weight: 700; color: #173732; }
QLabel#Subheading { color: #6b7c72; }
QLabel#Section { font-size: 15px; font-weight: 700; color: #23453b; }
QLabel#Muted { color: #6a7c70; }
QLabel#Error { background: #fff0e6; color: #8c421e; border: 1px solid #efceb7;
               border-radius: 8px; padding: 10px; }
QLabel#Notice { color: #28614e; background: #e4eee2; border-radius: 8px; padding: 8px; }
QFrame#Card { background: #ffffff; border: 1px solid #dfe6db; border-radius: 10px; }
QLabel#CardValue { font-size: 25px; font-weight: 750; color: #173e32; }
QLabel#CardCaption { font-size: 11px; color: #6a7c70; }
QPlainTextEdit, QTextBrowser, QListWidget, QTreeWidget, QTableWidget {
    background: #ffffff; border: 1px solid #dfe6db; border-radius: 7px;
    selection-background-color: #d8ead8; selection-color: #163c2f; padding: 5px; }
QPlainTextEdit#Question { font-size: 14px; padding: 9px; }
QPlainTextEdit#SourceCode { font-family: 'Cascadia Code', Consolas, monospace; font-size: 12px; }
QListWidget#History { background: #173732; border: 0; color: #dae7dc; padding: 0; }
QListWidget#History::item { padding: 12px 8px; border-bottom: 1px solid #2b4941; }
QListWidget#History::item:selected { background: #345c49; color: #ffffff; border-radius: 7px; }
QListWidget::item { padding: 8px 5px; }
QPushButton { background: #ffffff; border: 1px solid #cbd8c9; border-radius: 7px;
              padding: 8px 14px; font-weight: 600; }
QPushButton:hover { background: #e9f1e5; border-color: #91b191; }
QPushButton:disabled { color: #9aa79b; background: #eef2eb; border-color: #e0e6dc; }
QPushButton#Primary { background: #285943; border-color: #285943; color: #ffffff; }
QPushButton#Primary:hover { background: #37704f; }
QPushButton#Primary:disabled { background: #a1b3a1; border-color: #a1b3a1; }
QPushButton#SidebarButton { background: #284b3e; color: #e6f0e1; border-color: #496756; }
QSpinBox, QComboBox { background: #ffffff; padding: 6px; border: 1px solid #cdd9c9; border-radius: 6px; }
QTabWidget::pane { border: 0; background: transparent; }
QTabBar::tab { padding: 11px 15px; background: transparent; color: #687b6d;
              border-bottom: 2px solid transparent; font-weight: 600; }
QTabBar::tab:selected { color: #214e38; border-bottom-color: #4f8653; }
QHeaderView::section { background: #edf2e9; color: #516e56; border: 0; padding: 8px; }
QTableWidget { gridline-color: #edf1e9; }
QSplitter::handle { background: #e1e9dc; margin: 4px; }
"""


def text(value):
    if value is None:
        return "未记录"
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def number(value, digits=3, signed=False):
    if type(value) not in (int, float) or not math.isfinite(value):
        return "—"
    return f"{value:+.{digits}f}" if signed else f"{value:,.{digits}f}"


def esc(value):
    return html.escape(text(value))


def json_text(value):
    def redact(item):
        if isinstance(item, dict):
            return {key: ("[已隐藏]" if str(key).lower() in {"api_key", "authorization", "access_token", "password"}
                          else redact(child)) for key, child in item.items()}
        if isinstance(item, list):
            return [redact(child) for child in item]
        return item
    result = json.dumps(redact(value), ensure_ascii=False, indent=2, default=str)
    return result if len(result) <= 600000 else result[:600000] + "\n\n[窗口显示已截断；完整记录请导出]"


class StudyWorker(QThread):
    snapshot = pyqtSignal(object)
    result = pyqtSignal(object)
    error = pyqtSignal(str)

    def __init__(self, controller, study_id, parent=None):
        super().__init__(parent)
        self.controller, self.study_id = controller, study_id
        self.stop_event = threading.Event()

    def run(self):
        try:
            result = self.controller.run(self.study_id, progress=lambda state: self.snapshot.emit(deepcopy(state)),
                                         stop_event=self.stop_event)
            self.result.emit(deepcopy(result))
        except Exception as exc:
            self.error.emit(f"{type(exc).__name__}: {exc}")


class MetricCard(QFrame):
    def __init__(self, caption, value="—", hint=""):
        super().__init__()
        self.setObjectName("Card")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 12, 16, 12)
        self.caption = QLabel(caption); self.caption.setObjectName("CardCaption")
        self.value = QLabel(value); self.value.setObjectName("CardValue")
        self.hint = QLabel(hint); self.hint.setObjectName("CardCaption")
        self.hint.setWordWrap(True)
        for widget in (self.caption, self.value, self.hint):
            layout.addWidget(widget)


class ResearchWindow(QMainWindow):
    def __init__(self, project_root, controller=None):
        super().__init__()
        self.project_root = Path(project_root).expanduser().resolve()
        if controller is None:
            from ..evolution.controller import StudyController
            controller = StudyController(self.project_root)
        self.controller = controller
        self.selected_id = None
        self.running_id = None
        self.snapshot = None
        self._worker = None
        self._closing = False
        self._states = {}
        self._lineage = {}
        self._programs = {}
        self._load_error = None
        self._continuation_id = None
        self.setWindowTitle("NExgent · 科研信息空间")
        self.resize(1480, 980)
        self.setMinimumSize(1140, 780)
        self.setStyleSheet(STYLE)
        self._build()
        self._live_timer = QTimer(self)
        self._live_timer.setInterval(2000)
        self._live_timer.timeout.connect(self._refresh_live_snapshots)
        self.refresh_history()
        self.refresh_configuration()
        if self.history.count(): self.history.setCurrentRow(0)
        self._actions()

    def _build(self):
        canvas = QWidget(); canvas.setObjectName("Canvas")
        self.setCentralWidget(canvas)
        outer = QHBoxLayout(canvas); outer.setContentsMargins(0, 0, 0, 0); outer.setSpacing(0)
        sidebar = QFrame(); sidebar.setObjectName("Sidebar"); sidebar.setFixedWidth(260)
        side = QVBoxLayout(sidebar); side.setContentsMargins(18, 25, 18, 20); side.setSpacing(12)
        brand = QLabel("NEXGENT"); brand.setObjectName("Brand"); side.addWidget(brand)
        side.addWidget(QLabel("科研智能体 · 源码自改进"))
        side.addSpacing(15)
        new = QPushButton("＋  新的研究目标"); new.setObjectName("SidebarButton")
        new.clicked.connect(self.new_study); side.addWidget(new)
        side.addWidget(QLabel("研究记录"))
        self.history = QListWidget(); self.history.setObjectName("History")
        self.history.setWordWrap(True); self.history.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.history.currentItemChanged.connect(self._history_selected); side.addWidget(self.history, 1)
        self.running_note = QLabel("本窗口尚未启动研究"); self.running_note.setWordWrap(True); side.addWidget(self.running_note)
        refresh = QPushButton("刷新研究记录"); refresh.setObjectName("SidebarButton")
        refresh.clicked.connect(self.refresh_history); side.addWidget(refresh)
        self.configuration = QLabel(); self.configuration.setWordWrap(True); side.addWidget(self.configuration)
        config = QPushButton("检查模型配置"); config.setObjectName("SidebarButton")
        config.clicked.connect(self.refresh_configuration); side.addWidget(config)
        workspace = QLabel(str(self.project_root)); workspace.setWordWrap(True); workspace.setToolTip(str(self.project_root))
        side.addWidget(workspace)
        outer.addWidget(sidebar)
        main = QWidget(); layout = QVBoxLayout(main); layout.setContentsMargins(26, 20, 26, 18); layout.setSpacing(12)
        eyebrow = QLabel("SCIENTIFIC RESEARCH / 源码演化"); eyebrow.setObjectName("Eyebrow"); layout.addWidget(eyebrow)
        self.heading = QLabel("研究信息空间"); self.heading.setObjectName("Heading"); layout.addWidget(self.heading)
        self.subtitle = QLabel("设定研究目标与资源，查看可追溯的实验、证据和程序谱系。"); self.subtitle.setObjectName("Subheading")
        self.subtitle.setWordWrap(True); layout.addWidget(self.subtitle)
        self.composer = QWidget(); compose = QVBoxLayout(self.composer); compose.setContentsMargins(0, 0, 0, 0)
        self.question = QPlainTextEdit(); self.question.setObjectName("Question"); self.question.setFixedHeight(78)
        self.question.setPlaceholderText("希望研究什么？例如：从含噪时间序列中发现可迁移的动力学方程，并改进研究程序。")
        self.question.textChanged.connect(self._actions); compose.addWidget(self.question)
        controls = QHBoxLayout()
        self.arm = QComboBox()
        for key, label in ARMS.items(): self.arm.addItem(label, key)
        self.generations = QSpinBox(); self.generations.setRange(1, 20); self.generations.setValue(3)
        self.max_calls = QSpinBox(); self.max_calls.setRange(1, 500); self.max_calls.setValue(36)
        self.max_tokens = QSpinBox(); self.max_tokens.setRange(1000, 5000000); self.max_tokens.setSingleStep(12000); self.max_tokens.setValue(144000)
        self.max_tokens.setGroupSeparatorShown(True)
        controls.addWidget(self.arm, 1)
        for label, widget in (("轮数", self.generations), ("调用上限", self.max_calls), ("输出 Token", self.max_tokens)):
            controls.addWidget(QLabel(label)); controls.addWidget(widget)
        self.start_button = QPushButton("开始研究"); self.start_button.setObjectName("Primary"); self.start_button.clicked.connect(self.start_study)
        controls.addWidget(self.start_button); compose.addLayout(controls); layout.addWidget(self.composer)
        commands = QHBoxLayout()
        self.state_label = QLabel("等待研究目标"); self.state_label.setObjectName("Muted"); commands.addWidget(self.state_label, 1)
        self.stop_button = QPushButton("停止并保存"); self.stop_button.clicked.connect(self.stop_study); commands.addWidget(self.stop_button)
        self.resume_button = QPushButton("恢复所选研究"); self.resume_button.clicked.connect(self.resume_study); commands.addWidget(self.resume_button)
        self.continue_button = QPushButton("继续自改进"); self.continue_button.clicked.connect(self.continue_study); commands.addWidget(self.continue_button)
        self.export_button = QPushButton("导出所选研究"); self.export_button.clicked.connect(self.export_study); commands.addWidget(self.export_button)
        evidence = QPushButton("记录详情"); evidence.clicked.connect(lambda: self.show_json("研究记录", self.snapshot)); commands.addWidget(evidence)
        layout.addLayout(commands)
        self.error_label = QLabel(); self.error_label.setObjectName("Error"); self.error_label.setWordWrap(True); self.error_label.hide(); layout.addWidget(self.error_label)
        self.notice = QLabel(); self.notice.setObjectName("Notice"); self.notice.setWordWrap(True); self.notice.hide(); layout.addWidget(self.notice)
        self.tabs = QTabWidget(); layout.addWidget(self.tabs, 1)
        self._build_progress()
        self._build_research()
        self._build_experiments()
        self._build_lineage()
        self._build_conclusion()
        outer.addWidget(main, 1)

    @staticmethod
    def _title(value):
        label = QLabel(value); label.setObjectName("Section"); return label

    @staticmethod
    def _browser():
        browser = QTextBrowser(); browser.setOpenExternalLinks(False)
        browser.anchorClicked.connect(lambda url: QDesktopServices.openUrl(url) if url.scheme() in {"https", "http"} else None)
        return browser

    @staticmethod
    def _table(headers):
        table = QTableWidget(0, len(headers)); table.setHorizontalHeaderLabels(headers)
        table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        table.verticalHeader().hide(); table.setAlternatingRowColors(True)
        table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.ResizeToContents)
        table.horizontalHeader().setSectionResizeMode(len(headers) - 1, QHeaderView.ResizeMode.Stretch)
        return table

    def _build_progress(self):
        page = QWidget(); layout = QVBoxLayout(page); layout.setContentsMargins(0, 12, 0, 0)
        cards = QHBoxLayout()
        self.program_card = MetricCard("当前任务冠军", hint="可执行的科学程序")
        self.round_card = MetricCard("研究轮次", hint="已执行 / 总上限")
        self.calls_card = MetricCard("模型调用", hint="已预留 / 调用上限")
        self.tokens_card = MetricCard("实际模型用量", hint="服务端报告的总 Token")
        for card in (self.program_card, self.round_card, self.calls_card, self.tokens_card): cards.addWidget(card, 1)
        layout.addLayout(cards)
        self.overview = self._browser(); self.overview.setMaximumHeight(145); layout.addWidget(self.overview)
        split = QSplitter(Qt.Orientation.Vertical)
        activity = QWidget(); activity_layout = QVBoxLayout(activity); activity_layout.setContentsMargins(0, 0, 0, 0)
        activity_layout.addWidget(self._title("研究过程"))
        self.events = self._table(["事件", "来源 / 阶段", "内容"]); activity_layout.addWidget(self.events)
        self.events.cellDoubleClicked.connect(lambda row, col: self._table_detail(self.events, row, "事件证据"))
        split.addWidget(activity)
        calls = QWidget(); calls_layout = QVBoxLayout(calls); calls_layout.setContentsMargins(0, 8, 0, 0)
        calls_layout.addWidget(self._title("实际模型请求与消耗"))
        self.calls = self._table(["角色", "模型", "状态", "实际 Token", "输出上限"]); calls_layout.addWidget(self.calls)
        self.calls.cellDoubleClicked.connect(lambda row, col: self._table_detail(self.calls, row, "模型请求收据"))
        split.addWidget(calls); split.setSizes([280, 190]); layout.addWidget(split, 1)
        self.tabs.addTab(page, "研究进展")

    def _build_research(self):
        page = QWidget(); layout = QHBoxLayout(page); layout.setContentsMargins(0, 12, 0, 0)
        split = QSplitter()
        self.sources_list, self.sources_detail = self._research_column(split, "实际资料与阅读证据")
        self.hypotheses_list, self.hypotheses_detail = self._research_column(split, "假说与可反驳预测")
        self.sources_list.currentItemChanged.connect(lambda item, old: self._source_detail(item))
        self.hypotheses_list.currentItemChanged.connect(lambda item, old: self._record_detail(item, self.hypotheses_detail))
        layout.addWidget(split); self.tabs.addTab(page, "资料与假说")

    def _research_column(self, splitter, title):
        page = QWidget(); layout = QVBoxLayout(page); layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self._title(title)); listing = QListWidget(); layout.addWidget(listing, 1)
        listing.setWordWrap(True); listing.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        listing.itemDoubleClicked.connect(lambda item: self.show_json(title, item.data(Qt.ItemDataRole.UserRole)))
        detail = self._browser(); layout.addWidget(detail, 2); splitter.addWidget(page)
        return listing, detail

    def _build_experiments(self):
        page = QWidget(); layout = QVBoxLayout(page); layout.setContentsMargins(0, 12, 0, 0)
        layout.addWidget(self._title("候选程序的独立评价"))
        self.evaluations = self._table(["轮次", "候选", "任务得分", "变化", "决定", "依据"])
        self.evaluations.cellDoubleClicked.connect(lambda row, col: self._table_detail(self.evaluations, row, "独立评价"))
        layout.addWidget(self.evaluations, 2)
        split = QSplitter()
        self.experiments_list, self.experiments_detail = self._research_column(split, "实际实验")
        self.failures_list, self.failures_detail = self._research_column(split, "失败与反例")
        self.experiments_list.currentItemChanged.connect(lambda item, old: self._record_detail(item, self.experiments_detail))
        self.failures_list.currentItemChanged.connect(lambda item, old: self._record_detail(item, self.failures_detail))
        layout.addWidget(split, 3); self.tabs.addTab(page, "实验与反例")

    def _build_lineage(self):
        page = QWidget(); layout = QVBoxLayout(page); layout.setContentsMargins(0, 12, 0, 0)
        self.lineage_summary = QLabel("尚未生成可执行源码版本。"); self.lineage_summary.setWordWrap(True); layout.addWidget(self.lineage_summary)
        split = QSplitter()
        self.lineage = QTreeWidget(); self.lineage.setHeaderLabels(["源码版本", "当前角色"])
        self.lineage.header().setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        self.lineage.currentItemChanged.connect(self._source_selected); split.addWidget(self.lineage)
        right = QWidget(); right_layout = QVBoxLayout(right); right_layout.setContentsMargins(8, 0, 0, 0)
        self.source_identity = QLabel(); self.source_identity.setWordWrap(True); self.source_identity.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        right_layout.addWidget(self.source_identity)
        row = QHBoxLayout(); self.source_file = QComboBox(); self.source_file.currentTextChanged.connect(self._show_source)
        self.source_diff = QPushButton("与父版本比较"); self.source_diff.setCheckable(True); self.source_diff.toggled.connect(self._show_source)
        row.addWidget(self.source_file, 1); row.addWidget(self.source_diff); right_layout.addLayout(row)
        self.source_code = QPlainTextEdit(); self.source_code.setReadOnly(True); self.source_code.setObjectName("SourceCode"); right_layout.addWidget(self.source_code, 1)
        self.source_code.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        split.addWidget(right); split.setSizes([340, 660]); layout.addWidget(split, 1)
        self.tabs.addTab(page, "源码谱系")

    def _build_conclusion(self):
        page = QWidget(); layout = QVBoxLayout(page); layout.setContentsMargins(0, 12, 0, 0)
        self.conclusion = self._browser(); layout.addWidget(self.conclusion, 2)
        layout.addWidget(self._title("知识与研究结论的记录"))
        self.knowledge = self._browser(); layout.addWidget(self.knowledge, 1)
        self.tabs.addTab(page, "结论与知识")

    def refresh_configuration(self):
        try:
            from ..models.config import load_profiles
            profiles, defaults = load_profiles(self.project_root)
            profile = profiles.get(defaults.get("main"))
            if not profile or not profile.api_key or not profile.base_url or not profile.model:
                self.configuration.setText("模型未配置完整\n请在本项目 models.json 或 .env 中设置模型与凭据。")
            else:
                self.configuration.setText(f"已配置模型\n{profile.id}\n尚未验证服务端连接")
        except Exception as exc:
            self.configuration.setText(f"配置读取失败\n{type(exc).__name__}: {exc}")

    def refresh_history(self):
        try:
            states = self.controller.list_studies()
        except Exception as exc:
            self._error(f"研究记录读取失败：{type(exc).__name__}: {exc}"); return
        for state in states:
            if isinstance(state, dict) and state.get("id"):
                self._states[state["id"]] = deepcopy(state)
        self._rebuild_history()
        if self.selected_id and self.selected_id in self._states:
            self.select_study(self.selected_id)

    def _rebuild_history(self):
        self.history.blockSignals(True); self.history.clear()
        for identity, state in sorted(self._states.items(), key=lambda pair: str(pair[1].get("updated", pair[1].get("created", ""))), reverse=True):
            title = str(state.get("question", "未命名研究"))
            item = QListWidgetItem(title[:46] + ("…" if len(title) > 46 else "") + "\n" + STATUS.get(state.get("status"), str(state.get("status", ""))))
            item.setData(Qt.ItemDataRole.UserRole, identity); item.setToolTip(title + "\n" + identity); self.history.addItem(item)
            if identity == self.selected_id: self.history.setCurrentItem(item)
        self.history.blockSignals(False)

    def _history_selected(self, item, previous):
        if item: self.select_study(item.data(Qt.ItemDataRole.UserRole))

    def select_study(self, study_id):
        try:
            state = self.controller.get(study_id)
        except Exception as exc:
            self._error(f"研究载入失败：{type(exc).__name__}: {exc}"); return
        if self.selected_id != study_id: self._continuation_id = None
        self.selected_id = study_id
        self._states[study_id] = deepcopy(state)
        self._rebuild_history(); self._render(state); self._actions()

    def new_study(self):
        self.selected_id = None; self.snapshot = None; self._continuation_id = None
        self.history.clearSelection(); self.question.clear(); self.question.setFocus()
        self._render({}); self._actions()

    def _actions(self):
        if not hasattr(self, "start_button"): return
        busy = self._worker is not None
        self.start_button.setEnabled(not busy and bool(self.question.toPlainText().strip()))
        self.start_button.setText("启动后续研究" if self._continuation_id else "开始研究")
        self.question.setEnabled(not busy)
        self.question.setReadOnly(bool(self._continuation_id))
        for widget in (self.arm, self.generations, self.max_calls, self.max_tokens): widget.setEnabled(not busy)
        self.arm.setEnabled(not busy and not self._continuation_id)
        self.stop_button.setEnabled(busy and not self._worker.stop_event.is_set())
        resumable = (self.snapshot and self.snapshot.get("kind") != "meta_evaluation" and
                     self.snapshot.get("status") in {"created", "ready", "paused", "failed", "interrupted", "running"})
        self.resume_button.setEnabled(not busy and bool(resumable))
        continuable = (self.snapshot and self.snapshot.get("status") == "completed" and self.snapshot.get("kind") != "meta_evaluation")
        self.continue_button.setEnabled(not busy and bool(continuable) and hasattr(self.controller, "continue_research"))
        self.export_button.setEnabled(bool(self.selected_id))
        if hasattr(self, "_live_timer"):
            needs_updates = not self._closing and (busy or (self.snapshot and self.snapshot.get("status") == "running"))
            if needs_updates and not self._live_timer.isActive(): self._live_timer.start()
            elif not needs_updates: self._live_timer.stop()

    def start_study(self):
        if self._worker is not None or not self.question.toPlainText().strip(): return
        try:
            budget = {"max_model_calls": self.max_calls.value(), "max_completion_tokens": self.max_tokens.value()}
            if self._continuation_id:
                if self._continuation_id != self.selected_id: return
                state = self.controller.continue_research(self._continuation_id, generations=self.generations.value(), budget=budget)
            else:
                state = self.controller.create(self.question.toPlainText().strip(), generations=self.generations.value(),
                                               arm=self.arm.currentData(), budget=budget)
        except Exception as exc:
            self._error(f"研究创建失败：{type(exc).__name__}: {exc}"); return
        self._continuation_id = None
        self.selected_id = state["id"]; self._states[state["id"]] = deepcopy(state)
        self._rebuild_history(); self._render(state); self._launch(state["id"])

    def resume_study(self):
        if self.selected_id and self._worker is None and self.resume_button.isEnabled(): self._launch(self.selected_id)

    def continue_study(self):
        if (self._worker is not None or not self.snapshot or self.snapshot.get("status") != "completed"
                or self.snapshot.get("kind") == "meta_evaluation"): return
        self._continuation_id = self.selected_id
        self.question.setPlainText(str(self.snapshot.get("question", "")))
        index = self.arm.findData(self.snapshot.get("arm"))
        if index >= 0: self.arm.setCurrentIndex(index)
        self.composer.show()
        self.notice.setText("从所选研究已保存的探索源码继续。设置新研究的轮数与资源预算，然后启动。")
        self.notice.show(); self._actions()

    def _launch(self, study_id):
        self.error_label.hide(); self.notice.hide(); self.running_id = study_id
        self.running_note.setText("正在运行\n" + study_id)
        worker = StudyWorker(self.controller, study_id, self); self._worker = worker
        worker.snapshot.connect(self._progress); worker.result.connect(self._progress)
        worker.error.connect(self._worker_error); worker.finished.connect(self._worker_finished)
        self._actions(); worker.start()

    def stop_study(self):
        if self._worker:
            self._worker.stop_event.set(); self.running_note.setText("正在停止并保存\n" + str(self.running_id)); self._actions()

    def _progress(self, state):
        if not isinstance(state, dict) or not state.get("id"): return
        identity = state["id"]
        previous = self._states.get(identity, {})
        if self._revision(state) < self._revision(previous): return
        self._states[identity] = deepcopy(state); self._rebuild_history()
        if identity == self.selected_id: self._render(state)

    def _refresh_live_snapshots(self):
        """Read receipts while a request is in flight; never start/resume work."""
        targets = {self.running_id} if self._worker is not None and self.running_id else set()
        if self.selected_id and self.snapshot and self.snapshot.get("status") == "running":
            targets.add(self.selected_id)
        for identity in targets:
            try:
                self._progress(self.controller.get(identity))
            except Exception as exc:
                self._error(f"研究进度读取失败（{identity}）：{type(exc).__name__}: {exc}")
        self._actions()

    @staticmethod
    def _revision(state):
        updated = state.get("updated", state.get("created", 0))
        if type(updated) not in (int, float): updated = 0
        sequences = [event.get("sequence", 0) for event in state.get("events", []) if isinstance(event, dict)]
        return updated, max((v for v in sequences if isinstance(v, int)), default=0)

    def _worker_error(self, message):
        identity = self.running_id
        try:
            if identity: self._progress(self.controller.get(identity))
        except Exception:
            pass
        self._error(f"研究 {identity} 运行失败：{message}")

    def _worker_finished(self):
        worker = self._worker; self._worker = None; self.running_id = None
        self.running_note.setText("本窗口当前没有运行中的研究")
        if worker: worker.deleteLater()
        self._actions()
        if self._closing: QTimer.singleShot(0, self.close)

    def _error(self, message):
        self.error_label.setText(message); self.error_label.show(); self.notice.hide()

    def export_study(self, destination=None):
        if not self.selected_id: return
        if destination is False: destination = None  # QPushButton.clicked supplies bool.
        if destination is None:
            destination, _ = QFileDialog.getSaveFileName(self, f"导出研究 {self.selected_id}",
                str(self.project_root / f"{self.selected_id}.json"), "研究记录 (*.json);;所有文件 (*)")
            if not destination: return
        identity = self.selected_id
        try:
            path = self.controller.export(identity, destination=destination)
        except Exception as exc:
            self._error(f"研究 {identity} 导出失败：{type(exc).__name__}: {exc}"); return
        self.notice.setText(f"已导出研究 {identity}：{path}"); self.notice.show(); return path

    def show_json(self, title, value):
        if value is None: return
        dialog = QDialog(self); dialog.setWindowTitle(title); dialog.resize(900, 680)
        layout = QVBoxLayout(dialog); content = QPlainTextEdit(json_text(value)); content.setReadOnly(True); layout.addWidget(content)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close); buttons.rejected.connect(dialog.reject); layout.addWidget(buttons)
        dialog.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose); dialog.show()

    def _table_detail(self, table, row, title):
        item = table.item(row, 0)
        if item: self.show_json(title, item.data(Qt.ItemDataRole.UserRole))

    def _fill_table(self, table, rows):
        table.setRowCount(len(rows))
        for row, (values, payload) in enumerate(rows):
            for col, value in enumerate(values):
                item = QTableWidgetItem(text(value)); item.setToolTip(text(value)); item.setData(Qt.ItemDataRole.UserRole, deepcopy(payload))
                table.setItem(row, col, item)

    def _fill_list(self, listing, values, empty):
        listing.clear()
        for record in values if isinstance(values, list) else []:
            title = self._record_title(record)
            item = QListWidgetItem(" ".join(text(title).split())[:180]); item.setData(Qt.ItemDataRole.UserRole, deepcopy(record)); listing.addItem(item)
        if listing.count(): listing.setCurrentRow(0)
        else:
            item = QListWidgetItem(empty); item.setFlags(Qt.ItemFlag.NoItemFlags); listing.addItem(item)

    def _render(self, state):
        self._load_error = None
        self.snapshot = deepcopy(state) if state else None
        self.composer.setVisible(not bool(state) or self._continuation_id == state.get("id"))
        self.heading.setText("新的研究目标" if not state else "研究信息空间")
        self.subtitle.setText(str(state.get("question") or "设定研究目标与资源，查看可追溯的实验、证据和程序谱系。"))
        self.state_label.setText("等待研究目标" if not state else f"{state['id']} · {STATUS.get(state.get('status'), state.get('status', ''))} · {state.get('stage', '')}")
        if self._worker is None:
            self.running_note.setText("所选记录为研究中\n本窗口仅查看，可刷新记录" if state.get("status") == "running" else "本窗口当前没有运行中的研究")
        active = self._program(state.get("active_program"), state)
        self.program_card.value.setText(f"第 {active['generation']} 代" if 'generation' in active else "—")
        self.program_card.value.setToolTip(str(active.get("id", "")))
        self.round_card.value.setText(f"{state.get('generation', 0)} / {state.get('max_generations', '—')}" if state else "—")
        calls = state.get("calls") or []
        budget = state.get("budget") or {}; usage = state.get("usage") or {}
        used_calls = usage.get("model_calls", usage.get("calls", len(calls)))
        self.calls_card.value.setText(f"{used_calls} / {budget.get('max_model_calls', '—')}" if state else "—")
        token_usage = [r.get("usage") or {} for r in calls if isinstance(r, dict)]
        totals = [u.get("total_tokens") for u in token_usage if type(u.get("total_tokens")) in (int, float)]
        total = usage.get("reported_total_tokens", sum(totals) if totals else None)
        self.tokens_card.value.setText(number(total, 0))
        unknown = usage.get("unknown_usage_calls", sum(not value for value in token_usage))
        self.tokens_card.hint.setText(f"{unknown} 次请求尚无用量报告" if unknown else "服务端报告的总 Token")
        reserved = usage.get("reserved_completion_tokens")
        self.calls_card.hint.setText(f"输出 Token 预留 {number(reserved, 0)} / {number(budget.get('max_completion_tokens'), 0)}" if state else "已预留 / 调用上限")
        conclusion = state.get("conclusion") or {}
        summary = self._conclusion_summary(conclusion)
        mode = ARMS.get(state.get("arm"), state.get("arm", "未选择"))
        self.overview.setHtml(f"<h3>{esc(mode)}</h3><p>{esc(summary)}</p>")
        events = state.get("events") or []
        self._fill_table(self.events, [(self._event_summary(record), record) for record in events[-150:] if isinstance(record, dict)])
        self._fill_table(self.calls, [([r.get("role", "—"), r.get("model", "—"), STATUS.get(r.get("status"), r.get("status", "—")),
            number((r.get("usage") or {}).get("total_tokens"), 0), r.get("max_completion_tokens", r.get("max_tokens", "—"))], r) for r in calls if isinstance(r, dict)])
        research = state.get("research") or {}
        literature = self._research_records(research.get("literature"))
        sources = []
        for record in literature:
            if isinstance(record, dict) and isinstance(record.get("papers"), list): sources.extend(record["papers"] or [record])
            else: sources.append(record)
        for browser in (self.sources_detail, self.hypotheses_detail, self.experiments_detail, self.failures_detail): browser.clear()
        self._fill_list(self.sources_list, sources, "尚未产生检索与阅读证据")
        self._fill_list(self.hypotheses_list, self._research_records(research.get("hypotheses")), "尚未提出可检查的假说")
        self._fill_list(self.experiments_list, self._research_records(research.get("experiments")), "尚未记录实际实验")
        self._fill_list(self.failures_list, self._research_records(research.get("failures")), "尚未记录失败或反例")
        self._fill_table(self.evaluations, [([r.get("generation", "—"), str(r.get("candidate_id", "—"))[-12:],
            "缺测" if r.get("score") is None else number(r.get("score")), number(r.get("delta"), signed=True), STATUS.get(r.get("decision"), r.get("decision", "—")), r.get("reason", "")], r)
            for r in state.get("evaluations", []) if isinstance(r, dict)])
        self._render_lineage(state)
        self._render_conclusion(conclusion, research)
        error = state.get("last_error", state.get("error"))
        if error: self._error("研究保留的错误：" + text(error))
        elif not self._load_error: self.error_label.hide()
        self._actions()

    @staticmethod
    def _research_records(values):
        records = []
        for value in values if isinstance(values, list) else []:
            if isinstance(value, dict) and "content" in value and "generation" in value:
                contents = value["content"] if isinstance(value["content"], list) else [value["content"]]
                for content in contents:
                    records.append({"generation": value["generation"], **content} if isinstance(content, dict)
                                   else {"generation": value["generation"], "text": content})
            else: records.append(value)
        return records

    @staticmethod
    def _event_summary(record):
        kind = record.get("kind", record.get("stage", "事件"))
        content = record.get("content", record.get("data", {}))
        if not isinstance(content, dict): return [EVENT_NAMES.get(kind, kind), "", text(content)[:200]]
        method = content.get("method", "")
        phase = STATUS.get(content.get("status"), content.get("status", ""))
        if kind == "capability":
            request = content.get("request") or {}
            label = request.get("role", request.get("label", request.get("query", method)))
            inputs, outputs = content.get("input_artifact_ids", []), content.get("output_artifact_ids", [])
            message = f"{label} · {len(inputs)} 个输入工件，{len(outputs)} 个输出工件"
        elif kind == "registration": message = "已固定研究目标、对照模式和资源预算。"
        elif kind == "candidate_evaluated": message = f"得分 {number(content.get('score'))}，变化 {number(content.get('delta'), signed=True)} · {content.get('reason', '')}"
        elif kind == "measurement":
            evidence = content.get("evidence") or {}
            message = f"{evidence.get('split', content.get('split', '数值实验'))} · 得分 {number(evidence.get('score'))} · {len(evidence.get('tasks', []))} 项任务"
        elif kind == "model": message = f"{content.get('role', '')} · {content.get('model', '')} · {STATUS.get(content.get('status'), content.get('status', ''))}"
        elif kind == "agent_log": message = text(content.get("content", ""))[:200]
        elif kind == "study_completed": message = ResearchWindow._conclusion_summary(content)
        else: message = text(content.get("message", content.get("reason", content.get("error", content.get("label", content.get("split", "已记录证据，双击查看详情"))))))[:200]
        return [EVENT_NAMES.get(kind, kind), " · ".join(v for v in (method, phase) if v), message]

    def _program(self, reference, state=None):
        if isinstance(reference, dict): return reference
        if not isinstance(reference, str): return {}
        if reference in self._programs: return self._programs[reference]
        getter = getattr(self.controller, "get_program", None)
        if getter is not None:
            try:
                result = getter(reference)
                self._programs[reference] = deepcopy(result); return result
            except Exception as exc:
                self._load_error = f"源码版本载入失败：{type(exc).__name__}: {exc}"
                self._error(self._load_error)
        return next((item for item in (state or {}).get("archive", []) if item.get("id") == reference), {"id": reference})

    def _source_detail(self, item):
        record = item.data(Qt.ItemDataRole.UserRole) if item else None
        if not isinstance(record, dict):
            self.sources_detail.setPlainText(text(record) if record is not None else ""); return
        title = esc(record.get("title", record.get("query", "资料记录")))
        level_name = record.get("evidence_level", "阅读范围未记录")
        level = esc({"metadata_and_abstract": "仅元数据与摘要", "primary_full_text_excerpt": "已获取一手原文节选"}.get(level_name, level_name))
        content = esc(record.get("full_text_excerpt", record.get("abstract", record.get("limitation", "尚无文本证据"))))
        if record.get("status") == "failed":
            level = "检索失败 · " + esc(record.get("error_type", "原因未记录"))
            content = "一手来源检索失败，未提供替代或虚构引用。"
        url = record.get("url", record.get("request_url", ""))
        label = "打开原始来源" if record.get("url") else "查看检索请求"
        link = f'<p><a href="{html.escape(str(url), quote=True)}">{label}</a></p>' if str(url).startswith(("https://", "http://")) else ""
        self.sources_detail.setHtml(f"<h3>{title}</h3><p>{level}</p>{link}<p>{content}</p>")

    def _record_detail(self, item, browser):
        record = item.data(Qt.ItemDataRole.UserRole) if item else None
        if record is None: browser.clear(); return
        if not isinstance(record, dict): browser.setPlainText(text(record)); return
        pieces = [f"<h3>{esc(self._record_title(record))}</h3>"]
        labels = {"claim": "论断", "hypothesis": "假说", "prediction": "可反驳预测", "mechanisms": "机制分析",
            "observations": "观察证据", "limits": "限制", "limitations": "局限", "code_failures": "程序问题",
            "scientific_failures": "科学问题", "recommended_changes": "建议改变", "reason": "依据", "error": "失败原因",
            "summary": "研究摘要", "text": "记录", "score": "任务得分", "nrmse": "归一化误差", "status": "状态"}
        for key, label in labels.items():
            if key not in record: continue
            value = record[key]
            pieces.append(f"<h4>{label}</h4>")
            if isinstance(value, list): pieces.append("<ul>" + "".join(f"<li>{esc(v)}</li>" for v in value) + "</ul>")
            else: pieces.append(f"<p>{esc(STATUS.get(value, value) if isinstance(value, str) else value)}</p>")
        execution = record.get("execution")
        if isinstance(execution, dict):
            pieces.append(f"<h4>实际执行</h4><p>用时 {number(execution.get('elapsed_seconds'), 1)} 秒；数值工作量 {number(execution.get('work_units'), 0)}。</p>")
        decision = record.get("decision")
        if isinstance(decision, dict):
            pieces.append(f"<h4>独立决定</h4><p>{esc(decision.get('reason', ''))}</p><p>得分变化 {number(decision.get('delta'), signed=True)}；计算量比 {number(decision.get('cost_ratio'))}。</p>")
        measurement = record.get("measurement")
        if isinstance(measurement, dict):
            pieces.append(f"<h4>数值证据</h4><p>任务得分 {number(measurement.get('score'))}；{len(measurement.get('tasks', []))} 项任务。</p>")
            for task in measurement.get("tasks", [])[:12]:
                pieces.append(f"<p>{esc(task.get('task_id', '任务'))}　{number(task.get('score'))}　{esc(task.get('error', ''))}</p>")
        if record.get("candidate_ids"):
            pieces.append(f"<h4>源码后代</h4><p>实际生成 {len(record['candidate_ids'])} 个候选，详情与父子关系见源码谱系。</p>")
        if len(pieces) == 1:
            for key, value in record.items():
                if key not in {"generation", "id", "candidate_id", "source", "kind"}:
                    pieces.append(f"<p><b>{esc(key.replace('_', ' '))}</b>　{esc(value)}</p>")
        pieces.append("<p><small>双击上方条目可查看完整证据记录。</small></p>")
        browser.setHtml("".join(pieces))

    @staticmethod
    def _record_title(record):
        if not isinstance(record, dict): return text(record)
        title = next((record.get(key) for key in ("title", "hypothesis", "claim", "label", "summary", "error", "task_id", "text") if record.get(key)), None)
        if title: return text(title)
        prefix = f"第 {record['generation']} 轮 · " if "generation" in record else ""
        if record.get("query"):
            return prefix + ("检索失败 · " if record.get("status") == "failed" else "检索记录 · ") + text(record["query"])
        if record.get("candidate_ids") is not None: return prefix + f"实际生成 {len(record['candidate_ids'])} 个源码候选"
        if record.get("kind") == "scientific_counterexample":
            return prefix + "科学反例 · 得分变化 " + number((record.get("decision") or {}).get("delta"), signed=True)
        if any(key in record for key in ("observations", "mechanisms", "code_failures", "limits")):
            return prefix + "研究分析与可反驳判断"
        return prefix + "研究证据记录"

    def _render_lineage(self, state):
        self.lineage.blockSignals(True); self.lineage.clear(); self._lineage = {}
        for record in state.get("archive", []):
            if isinstance(record, dict):
                program = record.get("program", record)
                if isinstance(program, dict) and program.get("id"): self._lineage[program["id"]] = program
        active = self._program(state.get("active_program"), state)
        research = self._program(state.get("research_program"), state)
        for program in (active, research):
            if program.get("id"): self._lineage[program["id"]] = program
        nodes = {}
        for identity, program in self._lineage.items():
            roles = [label for value, label in ((active, "任务冠军"), (research, "探索父代")) if value.get("id") == identity]
            item = QTreeWidgetItem([f"第 {program.get('generation', 0)} 代 · {identity[-8:]}", " / ".join(roles)])
            item.setData(0, Qt.ItemDataRole.UserRole, identity); item.setToolTip(0, identity); nodes[identity] = item
        for identity, item in nodes.items():
            parent = self._lineage[identity].get("parent_id")
            visited = {identity}; ancestor = parent; cycle = False
            while ancestor in self._lineage:
                if ancestor in visited: cycle = True; break
                visited.add(ancestor); ancestor = self._lineage[ancestor].get("parent_id")
            if parent in nodes and not cycle: nodes[parent].addChild(item)
            else: self.lineage.addTopLevelItem(item)
        self.lineage.expandAll(); self.lineage.blockSignals(False)
        self.lineage_summary.setText(f"{len(nodes)} 个已存储源码版本。父子连接来自版本记录；任务冠军与探索父代分别标记。" if nodes else "尚未生成可执行源码版本。")
        selected = nodes.get(active.get("id")) or next(iter(nodes.values()), None)
        if selected: self.lineage.setCurrentItem(selected)
        else: self.source_identity.clear(); self.source_file.clear(); self.source_code.clear()

    def _source_selected(self, item, previous):
        program = self._lineage.get(item.data(0, Qt.ItemDataRole.UserRole), {}) if item else {}
        if program and not program.get("files"):
            program = {**program, **self._program(program["id"], self.snapshot)}
            self._lineage[program["id"]] = program
        self.source_identity.setText(f"{program.get('id', '')}\n{program.get('digest', '')}")
        self.source_file.blockSignals(True); self.source_file.clear(); self.source_file.addItems(sorted(program.get("files", {})))
        index = self.source_file.findText("task.py")
        if index >= 0: self.source_file.setCurrentIndex(index)
        self.source_file.blockSignals(False); self._show_source()

    def _show_source(self, *args):
        item = self.lineage.currentItem()
        if item is None: return
        program = self._lineage.get(item.data(0, Qt.ItemDataRole.UserRole), {})
        filename = self.source_file.currentText(); content = program.get("files", {}).get(filename, "")
        parent = self._lineage.get(program.get("parent_id"))
        if parent and not parent.get("files"):
            parent = {**parent, **self._program(parent["id"], self.snapshot)}
            self._lineage[parent["id"]] = parent
        self.source_diff.setEnabled(parent is not None)
        if self.source_diff.isChecked() and parent is not None:
            previous = parent.get("files", {}).get(filename, "")
            content = "\n".join(difflib.unified_diff(previous.splitlines(), content.splitlines(), fromfile="父版本/" + filename,
                tofile="当前版本/" + filename, lineterm="")) or "此文件与父版本一致。"
        self.source_code.setPlainText(content)

    def _render_conclusion(self, conclusion, research):
        if not conclusion:
            self.conclusion.setHtml("<h2>结论仍待证据</h2><p>研究过程、程序改进与科学发现分别评价。完成运行后，会保留支持、反驳和未能确认的结果。</p>")
        elif isinstance(conclusion, dict):
            pieces = [f"<h2>研究结论</h2><p>{esc(self._conclusion_summary(conclusion))}</p>"]
            for key, label in (("scientific_status", "科学结论"), ("rsi_status", "源码 RSI 结论")):
                if key in conclusion: pieces.append(f"<p><b>{label}</b>　{esc(conclusion[key])}</p>")
            limitations = conclusion.get("limitations", [])
            if limitations: pieces.append("<h3>局限与未确认部分</h3><ul>" + "".join(f"<li>{esc(v)}</li>" for v in limitations) + "</ul>")
            if "source_self_modification" in conclusion:
                pieces.append(f"<p><b>后代源码评价</b>　{'已记录' if conclusion['source_self_modification'] else '尚无记录'}</p>")
            if "executable_meta_changed" in conclusion:
                pieces.append(f"<p><b>改进器与编排源码</b>　{'存在修改' if conclusion['executable_meta_changed'] else '未记录修改'}</p>")
            if "inherited_improver_executed" in conclusion:
                pieces.append(f"<p><b>继承执行</b>　{len(conclusion['inherited_improver_executed'])} 个改过的后代改进器被继续执行</p>")
            transfer = conclusion.get("final_transfer", [])
            if transfer:
                pieces.append("<h3>未见任务的独立评价</h3><table cellpadding='7'><tr><th>种子</th><th>初始程序</th><th>所选程序</th><th>得分变化</th></tr>")
                for row in transfer:
                    pieces.append(f"<tr><td>{esc(row.get('seed'))}</td><td>{number((row.get('initial') or {}).get('score'))}</td><td>{number((row.get('selected') or {}).get('score'))}</td><td>{number(row.get('delta'), signed=True)}</td></tr>")
                pieces.append("</table>")
            if conclusion.get("meta_productivity") and not conclusion.get("meta_evaluation"):
                pieces.append("<h3>元能力</h3><p>仍需独立运行父、子改进器的实际后代对照；源码变化本身不证明元能力提高。</p>")
            if conclusion.get("meta_evaluation"):
                meta = conclusion["meta_evaluation"]
                pieces.append("<h3>实际后代对照</h3><pre style='white-space: pre-wrap'>" + esc(meta.get("aggregate", meta)) + "</pre>")
            if conclusion.get("domain"):
                pieces.append("<p><b>研究背景</b>　合成动力学数据；结果衡量方程恢复和智能体软件能力。</p>")
            pieces.append("<p>完整协议、数值记录和来源可通过上方“记录详情”或导出查看。</p>")
            self.conclusion.setHtml("".join(pieces))
        else: self.conclusion.setPlainText(text(conclusion))
        knowledge = research.get("knowledge", research.get("conclusions"))
        if knowledge:
            pieces = []
            for item in self._research_records(knowledge):
                if not isinstance(item, dict): pieces.append(f"<p>{esc(item)}</p>"); continue
                title = item.get("claim", item.get("hypothesis", item.get("title", "实验产生的知识记录")))
                decision = item.get("decision", {})
                reason = decision.get("reason", "") if isinstance(decision, dict) else text(decision)
                pieces.append(f"<h3>{esc(title or '实验产生的知识记录')}</h3><p>{esc(reason or item.get('status', '证据状态见关联实验'))}</p>")
                reference = item.get("measurement_key", item.get("source", ""))
                if reference: pieces.append(f"<p><small>证据：{esc(reference)}</small></p>")
            self.knowledge.setHtml("".join(pieces))
        else: self.knowledge.setPlainText("尚未记录独立的知识条目。请以实验与结论中的具体证据为准。")

    @staticmethod
    def _conclusion_summary(conclusion):
        if not conclusion: return "研究尚未形成最终结论。实验、失败和源码版本会保留为证据。"
        if not isinstance(conclusion, dict): return text(conclusion)
        if conclusion.get("summary"): return text(conclusion["summary"])
        if conclusion.get("protocol_completed"):
            score = number(conclusion.get("mean_transfer_delta"), signed=True)
            return f"研究流程已完成。未见任务的平均得分变化：{score}。源码自修改、科学效果与元能力分别查看对应证据。"
        return "已记录部分研究结论；请查看具体证据与尚未确认的部分。"

    def closeEvent(self, event):
        self._closing = True
        self._live_timer.stop()
        if self._worker is not None:
            self.stop_study(); event.ignore()
        else: event.accept()
