"""Main conversation and organization view using the same service as `run`."""
import html
from pathlib import Path
import threading

from PyQt6.QtCore import QThread, pyqtSignal
from PyQt6.QtGui import QTextCursor
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

    def __init__(self, service, objective, conversation_id, parent=None, *, resume_id=None):
        super().__init__(parent)
        self.service, self.objective = service, objective
        self.conversation_id = conversation_id
        self.resume_id = resume_id
        self.stop = threading.Event()

    def run(self):
        try:
            if self.resume_id:
                result = self.service.resume(self.resume_id, stop_event=self.stop, on_update=self.updated.emit)
            else:
                result = self.service.run(self.objective, conversation_id=self.conversation_id,
                                          stop_event=self.stop, on_update=self.updated.emit)
            self.result.emit(result)
        except Exception as exc:
            self.failed.emit(type(exc).__name__ + ": " + str(exc)[:500])


class OrganizationWindow(QMainWindow):
    def __init__(self, project_root, service=None):
        super().__init__()
        self.service = service or OrganizationService(project_root)
        self.worker = None
        self.conversation_id = None
        self._closing = False
        self._shown_delivery = None
        self._feedback_run_id = None
        self._recover_run_id = None
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
        self.feedback_button = QPushButton("提交本轮反馈")
        self.feedback_button.setToolTip("在输入框写下对已交付结果的反馈；保存后会用于后续任务与组织改进。")
        self.feedback_button.clicked.connect(self.submit_feedback)
        self.feedback_button.setEnabled(False)
        self.resume_button = QPushButton("恢复未完成任务")
        self.resume_button.clicked.connect(self.resume_task)
        self.resume_button.setEnabled(False)
        for button in (self.send, self.feedback_button, self.resume_button, self.stop, self.new):
            buttons.addWidget(button)
        layout.addLayout(buttons)
        history = self.service.store.list()
        if history:
            feedback = self.service.store.feedback()
            self.conversation_id = history[0]["conversation_id"]
            for run in reversed(history):
                if run["conversation_id"] == self.conversation_id:
                    self.append("你", run["objective"])
                    if run.get("answer"):
                        self.append("Nexgent", run["answer"])
                        self.append_artifacts(run)
                        if run["status"] != "running":
                            self._feedback_run_id = run["id"]
                        for item in reversed(feedback):
                            if item["run_id"] == run["id"]:
                                self.append("你的反馈", item["text"])
            self.feedback_button.setEnabled(self._feedback_run_id is not None)
            if history[0]['status'] in {'failed', 'interrupted'} and not history[0].get('assessment'):
                self._recover_run_id = history[0]['id']
                self.resume_button.setEnabled(True)
        self.show_organization()

    def append(self, who, text):
        self.messages.append("<b>" + html.escape(who) + "</b><p>" + html.escape(text).replace("\n", "<br>") + "</p>")
        self.messages.moveCursor(QTextCursor.MoveOperation.End)
        self.messages.ensureCursorVisible()

    def show_organization(self):
        revision, organization = self.service.store.active()
        self.info.setPlainText(f"当前组织版本：{revision}\n\n成员\n" +
                               "\n".join(f"• {m['name']}：{m['role']}" for m in organization["members"]) +
                               "\n\n工作方式\n" + organization["instructions"])

    def new_conversation(self):
        if self.worker:
            return
        self.conversation_id = None
        self._feedback_run_id = None
        self._recover_run_id = None
        self.resume_button.setEnabled(False)
        self.feedback_button.setEnabled(False)
        self.messages.clear()
        self.show_organization()

    def submit(self):
        objective = self.composer.toPlainText().strip()
        if not objective or self.worker:
            return
        self._shown_delivery = None
        self.append("你", objective)
        self.composer.clear()
        self._recover_run_id = None
        self.start_worker(objective)

    def resume_task(self):
        if self.worker or not self._recover_run_id:
            return
        self._shown_delivery = None
        self.append("Nexgent", "恢复未完成任务，继续使用已完成的成员成果。")
        self.start_worker("", resume_id=self._recover_run_id)

    def start_worker(self, objective, *, resume_id=None):
        self.send.setEnabled(False)
        self.new.setEnabled(False)
        self.feedback_button.setEnabled(False)
        self.resume_button.setEnabled(False)
        self.worker = OrganizationWorker(self.service, objective, self.conversation_id, self, resume_id=resume_id)
        self.worker.updated.connect(self.progress)
        self.worker.result.connect(self.completed)
        self.worker.failed.connect(lambda error: self.append("运行失败", error))
        self.worker.finished.connect(self.finished)
        self.worker.start()

    def submit_feedback(self):
        text = self.composer.toPlainText().strip()
        if not text or (self.worker and not self._shown_delivery) or not self._feedback_run_id:
            return
        try:
            self.service.feedback(self._feedback_run_id, text)
        except ValueError as exc:
            self.append("反馈未保存", str(exc))
            return
        self.composer.clear()
        self.append("你的反馈", text)
        self.append("Nexgent", "反馈已保存，将用于后续任务与组织改进；组织修改仍需通过实际试跑和门控。")

    def progress(self, run):
        self.conversation_id = run["conversation_id"]
        stage = run["events"][-1]["stage"]
        if stage == "evaluated" and run.get("assessment", {}).get("accepted"):
            self.show_delivery(run)
        if run["status"] == "completed" and run.get("assessment", {}).get("accepted"):
            self._feedback_run_id = run["id"]
            self.feedback_button.setEnabled(True)
        labels = {"started": "开始任务", "member_started": "成员开始工作", "member_finished": "成员交付成果", "assigned": "分派工作", "shared": "成员交换发现并修正", "collaborated": "汇总成员发现",
                  "tool_executed": "成员执行工具", "tools_completed": "工具执行与成果生成完成", "revising": "根据评价修订成果", "revised": "修订成果复验完成", "revision_failed": "修订未完成，保留已有成果", "evaluated": "独立评价完成", "proposed": "提出组织改进", "gate": "改进评价完成", "finished": "本轮结束"}
        labels.update(member_reused="复用已完成成员成果", peer_review_failed="互评格式失败，保留成员成果")
        self.status.setText(("任务已交付 · " if self._shown_delivery else "") + labels.get(stage, stage))
        delivery_assignments = run.get("result", {}).get("assignments")
        assigned = next((e for e in reversed(run["events"]) if e["stage"] == "assigned"
                         and (delivery_assignments is None or e["assignments"] == delivery_assignments)), None)
        members = assigned.get("members", run["organization"]["members"]) if assigned else run["organization"]["members"]
        lines = [f"使用组织版本：{run['revision']}", "", "本轮成员"]
        lines.extend(f"• {m['name']}：{m['role']}" for m in members)
        if assigned and assigned.get("recruits"):
            lines.append("临时加入：" + "、".join(m["name"] for m in assigned["recruits"]))
        if assigned:
            lines.extend(["", "本轮分工"])
            for a in assigned["assignments"]:
                dependency = "（等待 " + "、".join(a["depends_on"]) + "）" if a.get("depends_on") else ""
                lines.append(f"• {a['member']}{dependency}：{a['task']}")
        lines.extend(["", "运行进展"])
        for e in run["events"][-6:]:
            detail = " · " + e["member"] if e.get("member") else ""
            if e.get("tool"):
                detail += " · " + e["tool"]
            lines.append("• " + labels.get(e["stage"], e["stage"]) + detail)
        repair = next((e for e in reversed(run["events"]) if e["stage"] == "revising"), None)
        if repair:
            lines.extend(["", "修订依据：" + repair["assessment"]["feedback"]])
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

    def append_artifacts(self, run):
        for artifact in run.get("result", {}).get("artifacts", []):
            path = Path(artifact["path"])
            self.messages.append('<p>成果：<a href="' + html.escape(path.as_uri(), quote=True) + '">' + html.escape(path.name) + '</a></p>')
            self.messages.moveCursor(QTextCursor.MoveOperation.End)
            self.messages.ensureCursorVisible()

    def show_delivery(self, run):
        signature = (run.get("answer"), tuple(a["path"] for a in run.get("result", {}).get("artifacts", [])))
        if run.get("answer") and signature != self._shown_delivery:
            self.append("Nexgent" if self._shown_delivery is None else "Nexgent · 更新交付", run["answer"])
            self.append_artifacts(run)
            self._shown_delivery = signature

    def completed(self, run):
        self._recover_run_id = run['id'] if run['status'] in {'failed', 'interrupted'} and not run.get('assessment') else None
        if run.get("answer"):
            self._feedback_run_id = run["id"]
        self.show_delivery(run)
        assessment = run.get("assessment", {})
        self.append("评价", assessment.get("feedback", run.get("error", run["status"])))
        delivery = {"completed": "任务已交付", "needs_revision": "结果仍需修改", "failed": "任务未完成", "interrupted": "任务已停止"}
        self.status.setText(delivery.get(run["status"], run["status"]) + " · " +
                            EVOLUTION_LABELS.get(run["evolution"]["status"], run["evolution"]["status"]))
        token_note = " tokens" if run['usage'].get('tokens_complete') else " 已知 tokens（部分用量未返回）"
        self.info.appendPlainText(f"\n总用量：{run['usage']['model_calls']} 次模型调用，{run['usage']['total_tokens']}" + token_note)
        if run.get("error"):
            self.info.appendPlainText("\n" + run["error"])

    def finished(self):
        self.worker.deleteLater()
        self.worker = None
        self.send.setEnabled(True)
        self.new.setEnabled(True)
        self.feedback_button.setEnabled(self._feedback_run_id is not None)
        self.resume_button.setEnabled(self._recover_run_id is not None)
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
