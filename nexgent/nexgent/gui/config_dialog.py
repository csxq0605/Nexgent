"""Project model/provider configuration editor."""

import json
from pathlib import Path

from PyQt6.QtCore import pyqtSignal
from PyQt6.QtWidgets import (
    QDialog, QDialogButtonBox, QFormLayout, QLabel, QLineEdit, QMessageBox,
    QVBoxLayout,
)


class ConfigDialog(QDialog):
    configuration_saved = pyqtSignal()

    def __init__(self, project_root: Path, parent=None):
        super().__init__(parent)
        self.project_root = project_root
        self.path = project_root / "models.json"
        self.setWindowTitle("Nexgent Configuration")
        self.setMinimumWidth(540)
        layout = QVBoxLayout(self)
        hint = QLabel("Provider credentials are stored in this project's models.json.")
        hint.setObjectName("Muted")
        layout.addWidget(hint)
        form = QFormLayout()
        self.provider = QLineEdit("openai")
        self.base_url = QLineEdit("https://api.openai.com/v1")
        self.api_key = QLineEdit()
        self.api_key.setEchoMode(QLineEdit.EchoMode.Password)
        self.model = QLineEdit("gpt-4o")
        form.addRow("Provider", self.provider)
        form.addRow("Base URL", self.base_url)
        form.addRow("API key", self.api_key)
        form.addRow("Model", self.model)
        layout.addLayout(form)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.save)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)
        self._load()

    def _load(self):
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            default = data.get("defaults", {}).get("main", "")
            provider, model = default.split("/", 1) if "/" in default else ("openai", default)
            config = data.get("providers", {}).get(provider, {})
            self.provider.setText(provider)
            self.base_url.setText(config.get("base_url", ""))
            self.api_key.setText(config.get("api_key", ""))
            self.model.setText(model)
        except (OSError, ValueError, json.JSONDecodeError):
            pass

    def save(self):
        provider = self.provider.text().strip()
        model = self.model.text().strip()
        if not all((provider, model, self.base_url.text().strip())):
            QMessageBox.warning(self, "Incomplete configuration", "Provider, Base URL, and Model are required.")
            return
        data = {
            "providers": {
                provider: {
                    "base_url": self.base_url.text().strip(),
                    "api_key": self.api_key.text().strip(),
                    "models": {model: {"description": model, "tags": ["default"]}},
                }
            },
            "defaults": {"main": f"{provider}/{model}", "subagent": f"{provider}/{model}", "fast": f"{provider}/{model}"},
        }
        try:
            self.path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except OSError as exc:
            QMessageBox.critical(self, "Save failed", str(exc))
            return
        self.configuration_saved.emit()
        self.accept()
