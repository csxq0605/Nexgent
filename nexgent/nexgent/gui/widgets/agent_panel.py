"""Compact Agent conversation panel with GUI-native completion and history."""

from __future__ import annotations

import html
import json
import re
from pathlib import Path

from PyQt6.QtCore import QStringListModel, Qt, pyqtSignal
from PyQt6.QtGui import QTextCursor
from PyQt6.QtWidgets import (
    QComboBox,
    QCompleter,
    QFrame,
    QHBoxLayout,
    QLabel,
    QPlainTextEdit,
    QPushButton,
    QTextBrowser,
    QVBoxLayout,
)

from ...commands import SLASH_COMMANDS
from ...file_references import scan_completions


_AT_TOKEN_RE = re.compile(r"(?:^|\s)@([^\s@]*)$")
_BOX_ONLY_RE = re.compile(r"^[\s│┃╭╮╰╯─━┄┅┈┉┌┐└┘├┤┬┴┼]+$")


class Composer(QPlainTextEdit):
    """Multiline composer with slash/file completion and persistent history."""

    submitted = pyqtSignal(str)

    def __init__(self, project_root: Path | str | None = None, parent=None):
        super().__init__(parent)
        self.project_root = Path(project_root or ".").resolve()
        self.history_path = self.project_root / ".nexgent" / "input_history.json"
        self._history = self._load_history()
        self._history_index: int | None = None
        self._history_draft = ""
        self._completion_span: tuple[int, int, str] | None = None
        self._completion_model = QStringListModel(self)
        self.completer = QCompleter(self._completion_model, self)
        self.completer.setWidget(self)
        self.completer.setCompletionMode(QCompleter.CompletionMode.UnfilteredPopupCompletion)
        self.completer.setCaseSensitivity(Qt.CaseSensitivity.CaseInsensitive)
        self.completer.activated[str].connect(self._insert_completion)
        self.textChanged.connect(self._update_completions)
        self.cursorPositionChanged.connect(self._update_completions)

    @property
    def completion_candidates(self) -> list[str]:
        return self._completion_model.stringList()

    def _load_history(self) -> list[str]:
        try:
            payload = json.loads(self.history_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return []
        if not isinstance(payload, list):
            return []
        return [str(item) for item in payload if str(item).strip()][-100:]

    def _save_history(self) -> None:
        try:
            self.history_path.parent.mkdir(parents=True, exist_ok=True)
            self.history_path.write_text(
                json.dumps(self._history[-100:], ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        except OSError:
            pass

    def _remember(self, text: str) -> None:
        value = text.strip()
        if value and (not self._history or self._history[-1] != value):
            self._history.append(value)
            self._history = self._history[-100:]
            self._save_history()
        self._history_index = None
        self._history_draft = ""

    def submit_current(self) -> bool:
        text = self.toPlainText().strip()
        if not text:
            return False
        self._remember(text)
        self.completer.popup().hide()
        self.submitted.emit(text)
        self.clear()
        return True

    def _line_before_cursor(self) -> tuple[str, int]:
        cursor = self.textCursor()
        block = cursor.block()
        return block.text()[: cursor.positionInBlock()], block.position()

    def _completion_context(self) -> tuple[list[str], tuple[int, int, str] | None]:
        line, block_start = self._line_before_cursor()
        cursor_position = self.textCursor().position()
        if line.startswith("/"):
            query = line.lower()
            candidates = [
                command for command in SLASH_COMMANDS
                if command.lower().startswith(query)
            ]
            return candidates[:30], (block_start, cursor_position, "slash")

        match = _AT_TOKEN_RE.search(line)
        if match:
            prefix = match.group(1)
            candidates = scan_completions(prefix, str(self.project_root), limit=30)
            at_start = block_start + match.start(1) - 1
            return candidates, (at_start, cursor_position, "file")
        return [], None

    def _update_completions(self) -> None:
        candidates, span = self._completion_context()
        self._completion_span = span
        self._completion_model.setStringList(candidates)
        popup = self.completer.popup()
        if not candidates or span is None or not self.hasFocus():
            popup.hide()
            return
        popup.setCurrentIndex(self._completion_model.index(0, 0))
        rect = self.cursorRect()
        rect.setWidth(max(320, popup.sizeHintForColumn(0) + 36))
        self.completer.complete(rect)

    def _insert_completion(self, completion: str) -> None:
        if not completion or self._completion_span is None:
            return
        start, end, kind = self._completion_span
        cursor = self.textCursor()
        cursor.setPosition(start)
        cursor.setPosition(end, QTextCursor.MoveMode.KeepAnchor)
        cursor.insertText(completion if kind == "slash" else f"@{completion}")
        self.setTextCursor(cursor)
        self.completer.popup().hide()
        if kind == "file" and completion.endswith("/"):
            self._update_completions()

    def complete_current(self) -> bool:
        candidates = self.completion_candidates
        if not candidates:
            self._update_completions()
            candidates = self.completion_candidates
        if not candidates:
            return False
        popup = self.completer.popup()
        index = popup.currentIndex()
        completion = index.data() if index.isValid() else candidates[0]
        self._insert_completion(str(completion))
        return True

    def _move_popup_selection(self, delta: int) -> None:
        popup = self.completer.popup()
        count = self._completion_model.rowCount()
        if count <= 0:
            return
        current = popup.currentIndex().row()
        popup.setCurrentIndex(self._completion_model.index((current + delta) % count, 0))

    def _navigate_history(self, delta: int) -> bool:
        if not self._history:
            return False
        if self._history_index is None:
            if delta > 0:
                return False
            self._history_draft = self.toPlainText()
            self._history_index = len(self._history)
        new_index = self._history_index + delta
        new_index = max(0, min(len(self._history), new_index))
        self._history_index = new_index
        value = self._history_draft if new_index == len(self._history) else self._history[new_index]
        self.setPlainText(value)
        cursor = self.textCursor()
        cursor.movePosition(QTextCursor.MoveOperation.End)
        self.setTextCursor(cursor)
        return True

    def keyPressEvent(self, event):
        key = event.key()
        popup_visible = self.completer.popup().isVisible()
        if (
            popup_visible
            and self._history_index is not None
            and key in (Qt.Key.Key_Up, Qt.Key.Key_Down)
            and not event.modifiers()
            and self.document().blockCount() == 1
        ):
            self.completer.popup().hide()
            if self._navigate_history(-1 if key == Qt.Key.Key_Up else 1):
                return
        if popup_visible and key in (Qt.Key.Key_Up, Qt.Key.Key_Down):
            self._move_popup_selection(-1 if key == Qt.Key.Key_Up else 1)
            return
        if popup_visible and key in (
            Qt.Key.Key_Tab,
            Qt.Key.Key_Backtab,
            Qt.Key.Key_Return,
            Qt.Key.Key_Enter,
        ):
            self.complete_current()
            return
        if key == Qt.Key.Key_Escape and popup_visible:
            self.completer.popup().hide()
            return
        if key == Qt.Key.Key_Tab and self.complete_current():
            return
        if (
            key in (Qt.Key.Key_Up, Qt.Key.Key_Down)
            and not event.modifiers()
            and self.document().blockCount() == 1
            and self._navigate_history(-1 if key == Qt.Key.Key_Up else 1)
        ):
            return
        if (
            key in (Qt.Key.Key_Return, Qt.Key.Key_Enter)
            and not event.modifiers() & Qt.KeyboardModifier.ShiftModifier
        ):
            self.submit_current()
            return
        super().keyPressEvent(event)


class AgentPanel(QFrame):
    submitted = pyqtSignal(str)
    stop_requested = pyqtSignal()
    mode_changed = pyqtSignal(str)

    def __init__(self, model: str, project_root: Path | str | None = None, parent=None):
        super().__init__(parent)
        self.setObjectName("Panel")
        self.current_agent_id = "main"
        self._transcripts: dict[str, list[str]] = {"main": []}
        self._agent_statuses: dict[str, str] = {"main": "ready"}

        layout = QVBoxLayout(self)
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(8)
        header = QHBoxLayout()
        self.title = QLabel("MAIN")
        self.title.setObjectName("Section")
        self.status = QLabel("Ready")
        self.status.setObjectName("Muted")
        self.model = QComboBox()
        self.model.addItem(model)
        self.mode = QComboBox()
        self.mode.addItems(["default", "plan", "accept_edits", "auto", "dont_ask", "bypass"])
        self.mode.currentTextChanged.connect(self.mode_changed)
        header.addWidget(self.title)
        header.addWidget(self.status)
        header.addStretch()
        header.addWidget(self.model)
        header.addWidget(self.mode)
        layout.addLayout(header)

        self.messages = QTextBrowser()
        self.messages.setObjectName("Conversation")
        self.messages.setOpenExternalLinks(True)
        layout.addWidget(self.messages, 1)

        self.composer_host = QFrame()
        self.composer_host.setObjectName("Composer")
        composer_layout = QVBoxLayout(self.composer_host)
        composer_layout.setContentsMargins(8, 6, 8, 6)
        composer_layout.setSpacing(4)
        self.composer = Composer(project_root, self.composer_host)
        self.composer.setFrameShape(QFrame.Shape.NoFrame)
        self.composer.setPlaceholderText(
            "Ask Nexgent…  / commands · @ files · ↑↓ history · Shift+Enter newline"
        )
        self.composer.setMaximumHeight(96)
        self.composer.submitted.connect(self.submitted)
        composer_layout.addWidget(self.composer)
        actions = QHBoxLayout()
        actions.setContentsMargins(0, 0, 0, 0)
        self.hint = QLabel("Tab completes")
        self.hint.setObjectName("Muted")
        self.stop = QPushButton("Stop")
        self.stop.setObjectName("Danger")
        self.stop.setEnabled(False)
        self.stop.setVisible(False)
        self.stop.clicked.connect(self.stop_requested)
        self.send = QPushButton("Send")
        self.send.setObjectName("Primary")
        self.send.clicked.connect(self.composer.submit_current)
        actions.addWidget(self.hint)
        actions.addStretch()
        actions.addWidget(self.stop)
        actions.addWidget(self.send)
        composer_layout.addLayout(actions)
        layout.addWidget(self.composer_host)

    def ensure_agent(self, agent_id: str) -> None:
        self._transcripts.setdefault(agent_id, [])
        self._agent_statuses.setdefault(agent_id, "ready")

    def select_agent(self, agent_id: str) -> None:
        self.ensure_agent(agent_id)
        self.current_agent_id = agent_id
        self.title.setText("MAIN" if agent_id == "main" else agent_id.upper())
        self.status.setText(self._agent_statuses[agent_id].capitalize())
        self._render_current()

    def _render_current(self) -> None:
        self.messages.setHtml("<br>".join(self._transcripts[self.current_agent_id]))
        self.messages.ensureCursorVisible()

    def _append_html(self, fragment: str, agent_id: str) -> None:
        self.ensure_agent(agent_id)
        self._transcripts[agent_id].append(fragment)
        if agent_id == self.current_agent_id:
            cursor = self.messages.textCursor()
            cursor.movePosition(QTextCursor.MoveOperation.End)
            if self.messages.document().characterCount() > 1:
                cursor.insertBlock()
            cursor.insertHtml(fragment)
            self.messages.setTextCursor(cursor)
            self.messages.ensureCursorVisible()

    def add_message(self, role: str, text: str, agent_id: str = "main"):
        safe = html.escape(str(text)).replace("\n", "<br>")
        color = {
            "You": "#4B63FF",
            "Nexgent": "#171D3B",
            "System": "#6F7890",
            "Error": "#D92D20",
        }.get(role, "#273044")
        self._append_html(
            (
                '<p style="margin:8px 2px 12px 2px">'
                f'<b style="color:{color}">{html.escape(role)}</b><br>'
                f'<span style="white-space:pre-wrap">{safe}</span></p>'
            ),
            agent_id,
        )

    def append_activity(self, text: str, agent_id: str = "main"):
        lines = []
        for line in str(text).splitlines():
            clean = line.strip()
            if not clean or _BOX_ONLY_RE.fullmatch(clean):
                continue
            lines.append(clean)
        if not lines:
            return
        safe = html.escape("\n".join(lines)).replace("\n", "<br>")
        self._append_html(
            (
                '<p style="margin:3px 2px;color:#6F7890;font-size:11px">'
                f"{safe}</p>"
            ),
            agent_id,
        )

    def set_agent_status(self, agent_id: str, status: str) -> None:
        self.ensure_agent(agent_id)
        self._agent_statuses[agent_id] = status
        if agent_id == self.current_agent_id:
            self.status.setText(status.capitalize())

    def clear_conversation(self, agent_id: str = "main") -> None:
        self.ensure_agent(agent_id)
        self._transcripts[agent_id].clear()
        if agent_id == self.current_agent_id:
            self.messages.clear()

    def restore_submission(self, text: str) -> None:
        self.composer.setPlainText(text)
        cursor = self.composer.textCursor()
        cursor.movePosition(QTextCursor.MoveOperation.End)
        self.composer.setTextCursor(cursor)
        self.composer.setFocus()

    def set_busy(self, busy: bool):
        self.set_agent_status("main", "running" if busy else "ready")
        self.stop.setEnabled(busy)
        self.stop.setVisible(busy)
        # Keep the composer enabled so /btw and the next request can be prepared.
        self.composer.setEnabled(True)
        self.send.setEnabled(True)

    def clear_activity(self):
        """Compatibility hook: activity now lives in the unified transcript."""
