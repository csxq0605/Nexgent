from pathlib import Path

from PyQt6.QtGui import QFontDatabase, QPixmap
from PyQt6.QtWidgets import QLabel, QStackedWidget, QTextBrowser


class PreviewPane(QStackedWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.text = QTextBrowser()
        self.text.setOpenExternalLinks(True)
        mono = QFontDatabase.systemFont(QFontDatabase.SystemFont.FixedFont)
        self.text.setFont(mono)
        self.image = QLabel("Select a file to preview")
        self.image.setScaledContents(False)
        self.image.setStyleSheet("color: #6F7890; qproperty-alignment: AlignCenter;")
        self.addWidget(self.text)
        self.addWidget(self.image)
        self.setCurrentWidget(self.image)

    def open_file(self, filename: str):
        path = Path(filename)
        if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp"}:
            self.image.setPixmap(QPixmap(str(path)))
            self.setCurrentWidget(self.image)
            return
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            content = f"Cannot preview {path.name}\n\n{exc}"
        if path.suffix.lower() in {".md", ".markdown"}:
            self.text.setMarkdown(content)
        else:
            self.text.setPlainText(content)
        self.setCurrentWidget(self.text)
