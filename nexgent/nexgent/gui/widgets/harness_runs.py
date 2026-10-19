"""GUI-native controls for durable Coding Harness runs."""

from __future__ import annotations

from dataclasses import dataclass

from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtWidgets import (
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPlainTextEdit,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)


@dataclass(frozen=True)
class HarnessRunRequest:
    task: str
    check_command: str
    attempts: int
    timeout_seconds: int


class HarnessRunDialog(QDialog):
    """Collect a verified task without exposing slash-command syntax."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("New verified Harness run")
        self.setMinimumWidth(620)
        layout = QVBoxLayout(self)
        intro = QLabel(
            "Describe the repair goal and the independent command that proves it is complete."
        )
        intro.setWordWrap(True)
        intro.setObjectName("Muted")
        layout.addWidget(intro)

        form = QFormLayout()
        self.task = QPlainTextEdit()
        self.task.setPlaceholderText(
            "Example: Find and repair the numerical instability in the simulator."
        )
        self.task.setMaximumHeight(110)
        self.check = QLineEdit()
        self.check.setPlaceholderText("python simulate.py --verify")
        self.attempts = QSpinBox()
        self.attempts.setRange(1, 20)
        self.attempts.setValue(3)
        self.timeout = QSpinBox()
        self.timeout.setRange(1, 86_400)
        self.timeout.setValue(120)
        self.timeout.setSuffix(" seconds")
        form.addRow("Task", self.task)
        form.addRow("Acceptance command", self.check)
        form.addRow("Maximum attempts", self.attempts)
        form.addRow("Check timeout", self.timeout)
        layout.addLayout(form)

        self.buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Cancel
            | QDialogButtonBox.StandardButton.Ok
        )
        self.buttons.button(QDialogButtonBox.StandardButton.Ok).setText("Start Run")
        self.buttons.accepted.connect(self.accept)
        self.buttons.rejected.connect(self.reject)
        layout.addWidget(self.buttons)
        self.task.textChanged.connect(self._update_accept_enabled)
        self.check.textChanged.connect(self._update_accept_enabled)
        self._update_accept_enabled()

    def _update_accept_enabled(self) -> None:
        enabled = bool(self.task.toPlainText().strip() and self.check.text().strip())
        self.buttons.button(QDialogButtonBox.StandardButton.Ok).setEnabled(enabled)

    def request(self) -> HarnessRunRequest:
        return HarnessRunRequest(
            task=self.task.toPlainText().strip(),
            check_command=self.check.text().strip(),
            attempts=self.attempts.value(),
            timeout_seconds=self.timeout.value(),
        )

    @classmethod
    def get_request(cls, parent=None) -> HarnessRunRequest | None:
        dialog = cls(parent)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return None
        return dialog.request()


@dataclass(frozen=True)
class HarnessResumeRequest:
    attempts: int
    timeout_seconds: int


class HarnessResumeDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Resume Harness run")
        layout = QFormLayout(self)
        self.attempts = QSpinBox()
        self.attempts.setRange(1, 20)
        self.attempts.setValue(3)
        self.timeout = QSpinBox()
        self.timeout.setRange(1, 86_400)
        self.timeout.setValue(120)
        self.timeout.setSuffix(" seconds")
        layout.addRow("Additional attempts", self.attempts)
        layout.addRow("Check timeout", self.timeout)
        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Cancel
            | QDialogButtonBox.StandardButton.Ok
        )
        buttons.button(QDialogButtonBox.StandardButton.Ok).setText("Resume")
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addRow(buttons)

    def request(self) -> HarnessResumeRequest:
        return HarnessResumeRequest(self.attempts.value(), self.timeout.value())

    @classmethod
    def get_request(cls, parent=None) -> HarnessResumeRequest | None:
        dialog = cls(parent)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return None
        return dialog.request()


class HarnessRunsPanel(QWidget):
    """List and operate durable runs through buttons and dialogs."""

    new_requested = pyqtSignal()
    details_requested = pyqtSignal(str)
    resume_requested = pyqtSignal(str)
    export_requested = pyqtSignal(str)
    refresh_requested = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(2, 4, 2, 2)
        intro = QLabel(
            "Verified coding and simulation runs. Success requires the acceptance command to pass."
        )
        intro.setWordWrap(True)
        intro.setObjectName("Muted")
        layout.addWidget(intro)

        self.new_run = QPushButton("New Run")
        self.new_run.setObjectName("Primary")
        self.new_run.clicked.connect(self.new_requested)
        layout.addWidget(self.new_run)

        self.runs = QListWidget()
        self.runs.setAlternatingRowColors(True)
        self.runs.setWordWrap(True)
        self.runs.setHorizontalScrollBarPolicy(
            Qt.ScrollBarPolicy.ScrollBarAlwaysOff
        )
        self.runs.setToolTip("Select a run to inspect, resume, or export it")
        self.runs.itemDoubleClicked.connect(
            lambda _item: self._emit_selected(self.details_requested)
        )
        self.runs.itemSelectionChanged.connect(self._update_actions)
        layout.addWidget(self.runs, 1)

        primary_actions = QHBoxLayout()
        self.details = QPushButton("Details")
        self.resume = QPushButton("Resume")
        self.details.clicked.connect(
            lambda: self._emit_selected(self.details_requested)
        )
        self.resume.clicked.connect(
            lambda: self._emit_selected(self.resume_requested)
        )
        primary_actions.addWidget(self.details)
        primary_actions.addWidget(self.resume)
        layout.addLayout(primary_actions)

        secondary_actions = QHBoxLayout()
        self.export = QPushButton("Export")
        self.refresh = QPushButton("Refresh")
        self.export.clicked.connect(
            lambda: self._emit_selected(self.export_requested)
        )
        self.refresh.clicked.connect(self.refresh_requested)
        secondary_actions.addWidget(self.export)
        secondary_actions.addWidget(self.refresh)
        layout.addLayout(secondary_actions)
        self._update_actions()

    def selected_run_id(self) -> str | None:
        item = self.runs.currentItem()
        if item is None:
            return None
        return str(item.data(Qt.ItemDataRole.UserRole) or "") or None

    def _emit_selected(self, signal) -> None:
        run_id = self.selected_run_id()
        if run_id:
            signal.emit(run_id)

    def _update_actions(self) -> None:
        item = self.runs.currentItem()
        selected = item is not None
        status = str(item.data(Qt.ItemDataRole.UserRole + 1) or "") if item else ""
        self.details.setEnabled(selected)
        self.export.setEnabled(selected)
        self.resume.setEnabled(selected and status in {"paused", "waiting_approval"})

    def set_runs(self, runs) -> None:
        selected_id = self.selected_run_id()
        self.runs.clear()
        selected_item = None
        for run in reversed(list(runs)):
            objective = " ".join(str(run.objective).split())
            if len(objective) > 48:
                objective = f"{objective[:45]}…"
            item = QListWidgetItem(f"{run.status.value.upper()}\n{objective}")
            item.setData(Qt.ItemDataRole.UserRole, run.run_id)
            item.setData(Qt.ItemDataRole.UserRole + 1, run.status.value)
            item.setToolTip(f"{run.run_id}\n{run.objective}")
            self.runs.addItem(item)
            if run.run_id == selected_id:
                selected_item = item
        if selected_item is not None:
            self.runs.setCurrentItem(selected_item)
        elif self.runs.count():
            self.runs.setCurrentRow(0)
        self._update_actions()
