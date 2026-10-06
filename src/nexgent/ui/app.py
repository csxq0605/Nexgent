"""Desktop entry point for the conversation-first Nexgent workspace."""

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
    parser = argparse.ArgumentParser(description="Nexgent 通用任务智能体工作区")
    parser.add_argument("--project", type=Path, help="任务工作区目录")
    parser.add_argument("--model-root", type=Path, help="读取已有模型配置的目录")
    parser.add_argument('--kernel', choices=['dsh'], help='为新项目选择 DSH 原生代理循环')
    parser.add_argument("--task-console", action="store_true", help="打开高级任务与证据控制台")
    parser.add_argument("--organization-demo", action="store_true", help="打开可选的组织提案应用")
    parser.add_argument("--legacy-research", action="store_true", help="打开保留的 0.8 研究窗口")
    args = parser.parse_args(argv)
    if os.name == "nt":
        import ctypes
        ctypes.windll.kernel32.SetErrorMode(0x8003)
    from PyQt6.QtWidgets import QApplication
    app = QApplication.instance() or QApplication([sys.argv[0]])
    app.setApplicationName("Nexgent")
    app.setOrganizationName("Nexgent")
    if args.legacy_research:
        from .window import ResearchWindow
        window = ResearchWindow(project_root(args.project))
    elif args.task_console:
        from .tasks_window import TaskWindow
        window = TaskWindow(project_root(args.project))
    elif args.organization_demo:
        from .organization_window import OrganizationWindow
        from ..organization import OrganizationService
        root = project_root(args.project)
        window = OrganizationWindow(root, OrganizationService(root, model_root=args.model_root))
    else:
        from .main_window import MainWindow
        from ..application import Nexgent
        root = project_root(args.project)
        window = MainWindow(root, Nexgent(root, model_root=args.model_root, kernel=args.kernel))
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
