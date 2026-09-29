"""Main conversation and organization view using the same service as `run`."""
import html
from pathlib import Path
import threading

from PyQt6.QtCore import QThread, pyqtSignal
from PyQt6.QtWidgets import (QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
                            QTextBrowser, QPlainTextEdit, QPushButton, QLabel)

from ..organization import OrganizationService
from .main_window import MAIN_STYLE


EVOLUTION_LABELS = {
    "not_started": "等待任务反馈", "proposing": "正在比较改进方案", "adopted": "已采纳，后续任务将使用",
    "rejected": "未通过，保留当前组织", "unchanged": "无需修改", "abstained": "暂不修改",
    "failed": "改进未完成，保留任务成果", "stale": "已有较新版本，未覆盖", "interrupted": "已停止改进",
}


class OrganizationWorker(QThread):
    updated = pyqtSignal(dict)
    result = pyqtSignal(dict)
    failed = pyqtSignal(str)

    def __init__(self, service, objective, conversation_id, parent=None):
        super().__init__(parent)
        self.service, self.objective = service, objective
        self.conversation_id = conversation_id
        self.stop = threading.Event()

    def run(self):
        try:
            self.result.emit(self.service.run(self.objective, conversation_id=self.conversation_id,
                                             stop_event=self.stop, on_update=self.updated.emit))
        except Exception as exc:
            self.failed.emit(type(exc).__name__ + ": " + str(exc)[:500])


class OrganizationWindow(QMainWindow):
    def __init__(self, project_root, service=None):
        super().__init__()
        self.service = service or OrganizationService(project_root)
        self.worker = None
        self.conversation_id = None
        self._closing = False
        self.setWindowTitle("Nexgent · Main")
        self.resize(1200, 800)
        self.setStyleSheet(MAIN_STYLE)
        container = QWidget()
        self.setCentralWidget(container)
        layout = QVBoxLayout(container)
        self.status = QLabel("Main · 任务、协作与改进")
        layout.addWidget(self.status)
        body = QHBoxLayout()
        self.messages = QTextBrowser()
        self.messages.setOpenExternalLinks(True)
        self.info = QPlainTextEdit()
        self.info.setReadOnly(True)
        body.addWidget(self.messages, 3)
        body.addWidget(self.info, 2)
        layout.addLayout(body, 1)
        self.composer = QPlainTextEdit()
        self.composer.setMaximumHeight(120)
        self.composer.setPlaceholderText("描述任务并提供材料；Nexgent 会分工、汇总、评价，并尝试改进后续任务的组织方式。")
        layout.addWidget(self.composer)
        buttons = QHBoxLayout()
        self.send = QPushButton("发送并执行")
        self.send.clicked.connect(self.submit)
        self.stop = QPushButton("停止")
        self.stop.clicked.connect(self.cancel)
        self.new = QPushButton("新对话")
        self.new.clicked.connect(self.new_conversation)
        for button in (self.send, self.stop, self.new):
            buttons.addWidget(button)
        layout.addLayout(buttons)
        history = self.service.store.list()
        if history:
            self.conversation_id = history[0]["conversation_id"]
            for run in reversed(history):
                if run["conversation_id"] == self.conversation_id:
                    self.append("你", run["objective"])
                    if run.get("answer"):
                        self.append("Nexgent", run["answer"])
        self.show_organization()

    def append(self, who, text):
        self.messages.append("<b>" + html.escape(who) + "</b><p>" + html.escape(text).replace("\n", "<br>") + "</p>")

    def show_organization(self):
        revision, organization = self.service.store.active()
        self.info.setPlainText(f"当前组织版本：{revision}\n\n成员\n" +
                               "\n".join(f"• {m['name']}：{m['role']}" for m in organization["members"]) +
                               "\n\n工作方式\n" + organization["instructions"])

    def new_conversation(self):
        if self.worker:
            return
        self.conversation_id = None
        self.messages.clear()
        self.show_organization()

    def submit(self):
        objective = self.composer.toPlainText().strip()
        if not objective or self.worker:
            return
        self.append("你", objective)
        self.composer.clear()
        self.send.setEnabled(False)
        self.new.setEnabled(False)
        self.worker = OrganizationWorker(self.service, objective, self.conversation_id, self)
        self.worker.updated.connect(self.progress)
        self.worker.result.connect(self.completed)
        self.worker.failed.connect(lambda error: self.append("运行失败", error))
        self.worker.finished.connect(self.finished)
        self.worker.start()

    def progress(self, run):
        self.conversation_id = run["conversation_id"]
        stage = run["events"][-1]["stage"]
        labels = {"started": "开始任务", "assigned": "分派工作", "shared": "成员交换发现并修正", "collaborated": "汇总成员发现",
                  "tool_executed": "成员执行工具", "tools_completed": "工具执行与成果生成完成", "evaluated": "独立评价完成", "proposed": "提出组织改进", "gate": "改进评价完成", "finished": "本轮结束"}
        self.status.setText(labels.get(stage, stage))
        lines = [f"使用组织版本：{run['revision']}", "", "成员"]
        lines.extend(f"• {m['name']}：{m['role']}" for m in run["organization"]["members"])
        lines.extend(["", "运行进展"])
        lines.extend("• " + labels.get(e["stage"], e["stage"]) for e in run["events"][-6:])
        if run.get("assessment"):
            assessment = run["assessment"]
            lines.extend(["", f"独立评价：{assessment['score']}/10", assessment["feedback"]])
        evolution = run["evolution"]
        lines.extend(["", "组织改进：" + EVOLUTION_LABELS.get(evolution["status"], evolution["status"])])
        if evolution.get("candidate"):
            lines.append("候选成员：" + "、".join(m["name"] for m in evolution["candidate"]["members"]))
        if evolution.get("reason"):
            lines.append(evolution["reason"])
        if evolution.get("revision"):
            lines.append(f"已保存组织版本：{evolution['revision']}")
        self.info.setPlainText("\n".join(lines))

    def completed(self, run):
        if run.get("answer"):
            self.append("Nexgent", run["answer"])
        for artifact in run.get("result", {}).get("artifacts", []):
            path = Path(artifact["path"])
            self.messages.append('<p>成果：<a href="' + html.escape(path.as_uri(), quote=True) + '">' + html.escape(path.name) + '</a></p>')
        assessment = run.get("assessment", {})
        self.append("评价", assessment.get("feedback", run.get("error", run["status"])))
        delivery = {"completed": "任务已交付", "needs_revision": "结果仍需修改", "failed": "任务未完成", "interrupted": "任务已停止"}
        self.status.setText(delivery.get(run["status"], run["status"]) + " · " +
                            EVOLUTION_LABELS.get(run["evolution"]["status"], run["evolution"]["status"]))
        self.info.appendPlainText(f"\n总用量：{run['usage']['model_calls']} 次模型调用，{run['usage']['total_tokens']} tokens")
        if run.get("error"):
            self.info.appendPlainText("\n" + run["error"])

    def finished(self):
        self.worker.deleteLater()
        self.worker = None
        self.send.setEnabled(True)
        self.new.setEnabled(True)
        if self._closing:
            self.close()

    def cancel(self):
        if self.worker:
            self.worker.stop.set()

    def closeEvent(self, event):
        if self.worker:
            self._closing = True
            self.cancel()
            event.ignore()
        else:
            event.accept()
