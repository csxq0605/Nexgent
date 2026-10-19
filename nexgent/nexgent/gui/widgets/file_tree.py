from pathlib import Path

from PyQt6.QtCore import pyqtSignal
from PyQt6.QtGui import QFileSystemModel
from PyQt6.QtWidgets import QTreeView


class ProjectFileTree(QTreeView):
    file_selected = pyqtSignal(str)

    def __init__(self, root: Path, parent=None):
        super().__init__(parent)
        self.root = root.resolve()
        self.model = QFileSystemModel(self)
        self.model.setRootPath(str(self.root))
        self.setModel(self.model)
        self.setRootIndex(self.model.index(str(self.root)))
        self.setHeaderHidden(True)
        self.setAnimated(True)
        for column in range(1, 4):
            self.hideColumn(column)
        self.doubleClicked.connect(self._open)

    def _open(self, index):
        path = Path(self.model.filePath(index))
        if path.is_file():
            self.file_selected.emit(str(path))
