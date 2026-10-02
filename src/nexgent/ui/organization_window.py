"""Main conversation and organization view using the same service as `run`."""
import html
from pathlib import Path
import threading

from PyQt6.QtCore import QThread, pyqtSignal
from PyQt6.QtGui import QTextCursor
from PyQt6.QtWidgets import (QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QComboBox,
                            QTextBrowser, QPlainTextEdit, QPushButton, QLabel, QFileDialog)

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

    def __init__(self, service, objective, conversation_id, parent=None, *, resume_id=None, learn_id=None, inputs=None):
        super().__init__(parent)
        self.service, self.objective = service, objective
        self.conversation_id = conversation_id
        self.resume_id = resume_id
        self.learn_id = learn_id
        self.inputs = inputs
        self.stop = threading.Event()

    def run(self):
        try:
            if self.learn_id:
                result = self.service.learn(self.learn_id, stop_event=self.stop, on_update=self.updated.emit)
            elif self.resume_id:
                result = self.service.resume(self.resume_id, stop_event=self.stop, on_update=self.updated.emit)
            else:
                result = self.service.run(self.objective, conversation_id=self.conversation_id,
                                          inputs=self.inputs,
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
        self.pending_attachments = []
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
        self.history_box = QComboBox()
        self.history_box.setToolTip("打开已保存的对话，查看成果与反馈，继续执行任务。")
        self.history_box.currentIndexChanged.connect(self.select_conversation)
        layout.addWidget(self.history_box)
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
        attachments = QHBoxLayout()
        self.attach_button = QPushButton('添加文件')
        self.attach_button.clicked.connect(self.choose_files)
        self.clear_attachments_button = QPushButton('清空附件')
        self.clear_attachments_button.clicked.connect(self.clear_attachments)
        self.attachment_label = QLabel('可添加 Excel、CSV 或文本材料')
        attachments.addWidget(self.attach_button)
        attachments.addWidget(self.clear_attachments_button)
        attachments.addWidget(self.attachment_label, 1)
        layout.addLayout(attachments)
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
        self.learn_button = QPushButton("按反馈改进组织")
        self.learn_button.setToolTip("保存输入框中的反馈，并按原任务要求重新运行、比较组织候选；通过门控才应用于后续任务。")
        self.learn_button.clicked.connect(self.learn_task)
        self.learn_button.setEnabled(False)
        for button in (self.send, self.feedback_button, self.learn_button, self.resume_button, self.stop, self.new):
            buttons.addWidget(button)
        layout.addLayout(buttons)
        self.show_organization()
        history = self.refresh_history()
        if history:
            self.history_box.setCurrentIndex(1)

    def refresh_history(self):
        history = self.service.store.list()
        self.history_box.blockSignals(True)
        self.history_box.clear()
        self.history_box.addItem("新对话", None)
        seen = set()
        for run in history:
            cid = run["conversation_id"]
            if cid not in seen:
                self.history_box.addItem(self.task_label(run)[:80].replace('\n', ' '), cid)
                seen.add(cid)
        self.history_box.setCurrentIndex(max(0, self.history_box.findData(self.conversation_id)))
        self.history_box.blockSignals(False)
        return history

    def select_conversation(self, index):
        if self.worker:
            return
        cid = self.history_box.itemData(index)
        if cid is None:
            self.new_conversation()
            return
        history = [r for r in self.service.store.list() if r["conversation_id"] == cid]
        if not history:
            return
        self.conversation_id = cid
        self.messages.clear()
        self.composer.clear()
        self.clear_attachments()
        self._shown_delivery = None
        self._feedback_run_id = None
        latest = history[0]
        self._recover_run_id = latest['id'] if latest['status'] in {'failed', 'interrupted'} and not latest.get('assessment') else None
        for run in reversed(history):
            self.append("你", self.task_label(run))
            if run.get('inputs', {}).get('attachments'):
                self.append('附件', '、'.join(a['name'] for a in run['inputs']['attachments']))
            if run.get("answer"):
                self.append("Nexgent", run["answer"])
                self.append_artifacts(run)
                if run["status"] != "running":
                    self._feedback_run_id = run["id"]
                for item in reversed(self.service.store.feedback(run["id"])):
                    self.append("你的反馈", item["text"])
            elif run.get('error'):
                self.append("任务未完成", run['error'])
        self._shown_delivery = (latest.get("answer"), tuple(a["path"] for a in latest.get("result", {}).get("artifacts", []))) if latest.get("answer") else None
        self.show_organization()
        if latest.get('events'):
            self.progress(latest)
        if latest.get('usage'):
            note = " tokens" if latest['usage'].get('tokens_complete') else " 已知 tokens（部分用量未返回）"
            self.info.appendPlainText(f"\n总用量：{latest['usage']['model_calls']} 次模型调用，{latest['usage']['total_tokens']}" + note)
        delivery = {"completed": "任务已交付", "needs_revision": "结果仍需修改", "failed": "任务未完成", "interrupted": "任务已停止", "running": "运行尚未结束"}
        self.status.setText("已打开保存的对话 · " + delivery.get(latest['status'], latest['status']) + " · " +
                            EVOLUTION_LABELS.get(latest['evolution']['status'], latest['evolution']['status']))
        self.feedback_button.setEnabled(self._feedback_run_id is not None)
        self.learn_button.setEnabled(self._feedback_run_id is not None)
        self.resume_button.setEnabled(self._recover_run_id is not None)

    @staticmethod
    def task_label(run):
        return ("按反馈改进组织：" if run.get('learning_source_id') else '') + run['objective']

    def append(self, who, text):
        self.messages.append("<b>" + html.escape(who) + "</b><p>" + html.escape(text).replace("\n", "<br>") + "</p>")
        self.messages.moveCursor(QTextCursor.MoveOperation.End)
        self.messages.ensureCursorVisible()

    def show_organization(self):
        revision, organization = self.service.store.active()
        self.info.setPlainText(f"当前组织版本：{revision}\n\n成员\n" +
                               "\n".join(f"• {m['name']}：{m['role']}" for m in organization["members"]) +
                               "\n\n工作方式\n" + organization["instructions"])
        if organization.get('skills'):
            self.info.appendPlainText("\n已保存能力\n" + '\n'.join('• skill_' + s['name'] + '：' + s['description'] for s in organization['skills']))

    def new_conversation(self):
        if self.worker:
            return
        self.conversation_id = None
        self.clear_attachments()
        self._feedback_run_id = None
        self._recover_run_id = None
        self.resume_button.setEnabled(False)
        self.feedback_button.setEnabled(False)
        self.learn_button.setEnabled(False)
        self.messages.clear()
        self.history_box.blockSignals(True)
        self.history_box.setCurrentIndex(0)
        self.history_box.blockSignals(False)
        self._shown_delivery = None
        self.status.setText("Main · 任务、协作与改进")
        self.show_organization()

    def choose_files(self):
        if self.worker:
            return
        paths, _ = QFileDialog.getOpenFileNames(self, '选择任务材料', '', '任务材料 (*.xlsx *.csv *.txt *.md *.json)')
        if not paths:
            return
        try:
            if len(self.pending_attachments) + len(paths) > 8:
                raise ValueError('每个任务最多添加 8 个附件')
            self.pending_attachments.extend(self.service.attach_files(paths))
            self.attachment_label.setText('、'.join(a['name'] for a in self.pending_attachments))
        except (ValueError, OSError) as exc:
            self.append('附件未添加', str(exc))

    def clear_attachments(self):
        if self.worker:
            return
        self.pending_attachments = []
        self.attachment_label.setText('可添加 Excel、CSV 或文本材料')

    def submit(self):
        objective = self.composer.toPlainText().strip()
        if not objective or self.worker:
            return
        self._shown_delivery = None
        self.append("你", objective)
        inputs = {'attachments': self.pending_attachments[:]} if self.pending_attachments else None
        if self.pending_attachments:
            self.append('附件', '、'.join(a['name'] for a in self.pending_attachments))
        self.clear_attachments()
        self.composer.clear()
        self._recover_run_id = None
        self.start_worker(objective, inputs=inputs)

    def resume_task(self):
        if self.worker or not self._recover_run_id:
            return
        self._shown_delivery = None
        self.append("Nexgent", "恢复未完成任务，继续使用已完成的成员成果。")
        self.start_worker("", resume_id=self._recover_run_id)

    def learn_task(self):
        if self.worker or not self._feedback_run_id:
            return
        source_id = self._feedback_run_id
        if self.composer.toPlainText().strip() and not self.submit_feedback():
            return
        self._shown_delivery = None
        self.append("Nexgent", "根据保存的反馈重跑原任务，比较组织与策略修改；通过门控后用于后续任务。")
        self.start_worker("", learn_id=source_id)

    def start_worker(self, objective, *, resume_id=None, learn_id=None, inputs=None):
        self.send.setEnabled(False)
        self.new.setEnabled(False)
        self.feedback_button.setEnabled(False)
        self.learn_button.setEnabled(False)
        self.resume_button.setEnabled(False)
        self.history_box.setEnabled(False)
        self.attach_button.setEnabled(False)
        self.clear_attachments_button.setEnabled(False)
        self.worker = OrganizationWorker(self.service, objective, self.conversation_id, self, resume_id=resume_id, learn_id=learn_id, inputs=inputs)
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
        return True

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
        labels['evaluation_tool_executed'] = '评价器独立核算'
        labels.update(follow_up_requested='成员请求后续分工', follow_up_blocked='后续工作尚未解决')
        self.status.setText(("任务已交付 · " if self._shown_delivery else "") + labels.get(stage, stage))
        delivery_assignments = run.get("result", {}).get("assignments")
        assigned = next((e for e in reversed(run["events"]) if e["stage"] == "assigned"
                         and (delivery_assignments is None or e["assignments"] == delivery_assignments)), None)
        delivered_members = run.get("result", {}).get("organization", {}).get("members")
        members = delivered_members or (assigned.get("members", run["organization"]["members"]) if assigned else run["organization"]["members"])
        lines = [f"使用组织版本：{run.get('delivered_revision', run['revision'])}", "", "本轮成员"]
        if run.get('learning_source_id'):
            lines.insert(1, '参考已保存任务：' + run['learning_source_id'])
        lines.extend(f"• {m['name']}：{m['role']}" for m in members)
        skills = run.get('result', {}).get('organization', run['organization']).get('skills', [])
        if skills:
            lines.extend(['', '本轮可用能力', *('• skill_' + s['name'] + '：' + s['description'] for s in skills)])
        persistent = run["evolution"].get("candidate", run["organization"]) if run['evolution']['status'] == 'adopted' else run["organization"]
        defaults = {m["name"] for m in persistent["members"]}
        recruits = [m["name"] for m in members if m["name"] not in defaults]
        if recruits:
            lines.append("临时加入：" + "、".join(recruits))
        assignments = delivery_assignments if delivery_assignments is not None else assigned["assignments"] if assigned else []
        if assignments:
            lines.extend(["", "本轮分工"])
            for a in assignments:
                dependency = "（等待 " + "、".join(a["depends_on"]) + "）" if a.get("depends_on") else ""
                phase = f"（追加第{a['round']}轮）" if a.get('round') else ''
                lines.append(f"• {a['member']}{phase}{dependency}：{a['task']}")
        lines.extend(["", "运行进展"])
        for e in run["events"][-6:]:
            detail = " · " + e["member"] if e.get("member") else ""
            if e.get("tool"):
                detail += " · " + str(e["tool"])
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
        if evolution.get("candidate_result"):
            parent = run.get("parent_result", run["result"])
            candidate = evolution["candidate_result"]
            lines.append(f"当前任务比较：{parent['model_calls']} → {candidate['model_calls']} 次工作调用，{parent['total_tokens']} → {candidate['total_tokens']} tokens")
        regression = evolution.get("regression")
        if regression and regression.get("work"):
            before, after = regression["work"]["parent"], regression["work"]["candidate"]
            lines.append(f"历史任务比较：{before['model_calls']} → {after['model_calls']} 次工作调用，{before['total_tokens']} → {after['total_tokens']} tokens")
        if evolution.get("gate_feedback"):
            lines.append("门控结论：" + evolution["gate_feedback"])
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
        self.attach_button.setEnabled(True)
        self.clear_attachments_button.setEnabled(True)
        self.new.setEnabled(True)
        self.feedback_button.setEnabled(self._feedback_run_id is not None)
        self.learn_button.setEnabled(self._feedback_run_id is not None)
        self.resume_button.setEnabled(self._recover_run_id is not None)
        self.refresh_history()
        self.history_box.setEnabled(True)
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
