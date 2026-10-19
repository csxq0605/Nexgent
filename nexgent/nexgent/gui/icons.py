"""Small dependency-free vector icon helpers."""

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QColor, QIcon, QPainter, QPainterPath, QPixmap


def relay_icon(size: int = 64) -> QIcon:
    pixmap = QPixmap(size, size)
    pixmap.fill(Qt.GlobalColor.transparent)
    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    path = QPainterPath()
    path.moveTo(size * .16, size * .24)
    path.lineTo(size * .48, size * .24)
    path.lineTo(size * .70, size * .50)
    path.lineTo(size * .48, size * .76)
    path.lineTo(size * .16, size * .76)
    path.lineTo(size * .39, size * .50)
    path.closeSubpath()
    painter.fillPath(path, QColor("#4B63FF"))
    path2 = QPainterPath()
    path2.moveTo(size * .47, size * .24)
    path2.lineTo(size * .70, size * .24)
    path2.lineTo(size * .90, size * .50)
    path2.lineTo(size * .70, size * .76)
    path2.lineTo(size * .47, size * .76)
    path2.lineTo(size * .68, size * .50)
    path2.closeSubpath()
    painter.fillPath(path2, QColor("#8D43FF"))
    painter.setBrush(QColor("#22D3EE"))
    painter.setPen(Qt.PenStyle.NoPen)
    painter.drawEllipse(int(size * .43), int(size * .43), int(size * .14), int(size * .14))
    painter.end()
    return QIcon(pixmap)


def load_app_icon() -> QIcon:
    from ..branding import APP_ICON_PATH
    resource = APP_ICON_PATH
    return QIcon(str(resource)) if resource.exists() else relay_icon()
