from pathlib import Path

from PyQt6.QtCore import pyqtSignal
from PyQt6.QtWidgets import (
    QDialog, QFileDialog, QHBoxLayout, QLabel, QLineEdit, QPushButton, QVBoxLayout,
)

from .icons import relay_icon
from ..branding import PRODUCT_NAME, TAGLINE


class ProjectDialog(QDialog):
    project_selected = pyqtSignal(str)

    def __init__(self, initial: Path | None = None, parent=None):
        super().__init__(parent)
        self._selected = None
        self.setWindowTitle(f"{PRODUCT_NAME} — Open workspace")
        self.setWindowIcon(relay_icon())
        self.setMinimumSize(620, 300)
        layout = QVBoxLayout(self)
        brand = QLabel(PRODUCT_NAME.upper())
        brand.setObjectName("Brand")
        layout.addWidget(brand)
        subtitle = QLabel(f"{TAGLINE}  Open a project to begin.")
        subtitle.setObjectName("Muted")
        layout.addWidget(subtitle)
        layout.addStretch()
        row = QHBoxLayout()
        self.path = QLineEdit(str((initial or Path.cwd()).resolve()))
        browse = QPushButton("Browse…")
        browse.clicked.connect(self._browse)
        row.addWidget(self.path, 1)
        row.addWidget(browse)
        layout.addLayout(row)
        open_button = QPushButton("Open Workspace")
        open_button.setObjectName("Primary")
        open_button.clicked.connect(self._accept_path)
        layout.addWidget(open_button)
        layout.addStretch()

    def _browse(self):
        path = QFileDialog.getExistingDirectory(self, "Open Nexgent workspace", self.path.text())
        if path:
            self.path.setText(path)

    def _accept_path(self):
        path = Path(self.path.text()).expanduser()
        if path.is_dir():
            self._selected = path.resolve()
            self.project_selected.emit(str(self._selected))
            self.accept()

    def selected_project(self):
        return self._selected
