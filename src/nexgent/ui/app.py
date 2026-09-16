"""Desktop entry point for a general RSI study workspace."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys


def project_root(explicit=None):
    candidate = explicit or os.environ.get("NEXGENT_PROJECT_ROOT")
    if candidate:
        return Path(candidate).expanduser().resolve()
    for start in (Path.cwd(), Path(__file__).resolve().parent):
        for path in (start, *start.parents):
            if (path / "pyproject.toml").is_file():
                return path.resolve()
    return Path.cwd().resolve()


def main(argv=None):
    parser = argparse.ArgumentParser(description="NExgent RSI 实验空间")
    parser.add_argument("--project", type=Path, help="研究工作区目录")
    args = parser.parse_args(argv)
    if os.name == "nt":
        import ctypes
        ctypes.windll.kernel32.SetErrorMode(0x8003)
    from PyQt6.QtWidgets import QApplication
    from .window import ResearchWindow
    app = QApplication.instance() or QApplication([sys.argv[0]])
    app.setApplicationName("NExgent Research")
    app.setOrganizationName("NExgent")
    window = ResearchWindow(project_root(args.project))
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
