"""Desktop entry point for the task-first NExgent workspace."""

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
    parser = argparse.ArgumentParser(description="NExgent 通用任务智能体工作区")
    parser.add_argument("--project", type=Path, help="任务工作区目录")
    parser.add_argument("--legacy-research", action="store_true", help="打开保留的 0.8 研究窗口")
    args = parser.parse_args(argv)
    if os.name == "nt":
        import ctypes
        ctypes.windll.kernel32.SetErrorMode(0x8003)
    from PyQt6.QtWidgets import QApplication
    app = QApplication.instance() or QApplication([sys.argv[0]])
    app.setApplicationName("NExgent Task Workspace")
    app.setOrganizationName("NExgent")
    if args.legacy_research:
        from .window import ResearchWindow
        window = ResearchWindow(project_root(args.project))
    else:
        from .tasks_window import TaskWindow
        window = TaskWindow(project_root(args.project))
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
