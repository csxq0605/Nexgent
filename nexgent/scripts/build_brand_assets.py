"""Render deterministic Nexgent SVG masters to packaged PNG assets."""

from pathlib import Path
import sys

from PyQt6.QtCore import QRectF, QSize
from PyQt6.QtGui import QColor, QGuiApplication, QImage, QPainter
from PyQt6.QtSvg import QSvgRenderer

ROOT = Path(__file__).resolve().parents[1]


def render(source: Path, destination: Path, size: tuple[int, int]):
    destination.parent.mkdir(parents=True, exist_ok=True)
    renderer = QSvgRenderer(str(source))
    if not renderer.isValid():
        raise RuntimeError(f"Invalid SVG: {source}")
    image = QImage(QSize(*size), QImage.Format.Format_ARGB32_Premultiplied)
    image.fill(QColor(0, 0, 0, 0))
    painter = QPainter(image)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    renderer.render(painter, QRectF(0, 0, size[0], size[1]))
    painter.end()
    if not image.save(str(destination), "PNG"):
        raise RuntimeError(f"Could not save {destination}")


def main():
    app = QGuiApplication.instance() or QGuiApplication(sys.argv[:1])
    brand = ROOT / "assets" / "brand"
    render(brand / "nexgent-mark.svg", brand / "nexgent-mark.png", (1024, 1024))
    render(brand / "nexgent-app-icon.svg", brand / "nexgent-app-icon.png", (1024, 1024))
    render(brand / "nexgent-app-icon.svg", ROOT / "nexgent" / "resources" / "icon.png", (1024, 1024))
    render(brand / "nexgent-title.svg", brand / "nexgent-title.png", (1400, 420))


if __name__ == "__main__":
    main()
