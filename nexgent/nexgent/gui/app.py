"""QApplication lifecycle and desktop entry point."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PyQt6.QtCore import QTimer
from PyQt6.QtWidgets import QApplication

from ..runtime.service import NexgentRuntime
from .icons import load_app_icon
from .main_window import MainWindow
from .project_dialog import ProjectDialog
from .theme import theme_stylesheet


def create_application(argv=None):
    app = QApplication.instance() or QApplication(argv or sys.argv)
    app.setApplicationName("Nexgent")
    app.setOrganizationName("Nexgent")
    app.setWindowIcon(load_app_icon())
    app.setStyleSheet(theme_stylesheet())
    return app


def launch_gui(
    project_root=None,
    *,
    runtime=None,
    show_project_dialog=False,
    quit_after_ms=None,
    persist_session=True,
):
    app = create_application()
    root = Path(project_root or Path.cwd()).expanduser().resolve()
    if show_project_dialog:
        dialog = ProjectDialog(root)
        if dialog.exec() != dialog.DialogCode.Accepted:
            return 0
        root = dialog.selected_project()
    runtime = runtime or NexgentRuntime(root)
    window = MainWindow(runtime)
    window.show()
    # Keep a reference for test harnesses and embedded launchers.
    app._nexgent_window = window
    if quit_after_ms is not None:
        def close_smoke_window():
            if not persist_session:
                runtime.session.auto_save_dir = None
            window.close()
            app.quit()
        QTimer.singleShot(quit_after_ms, close_smoke_window)
    return app.exec()


def _build_parser():
    parser = argparse.ArgumentParser(description="Nexgent native desktop application")
    parser.add_argument("--project", help="Open this workspace without the project chooser")
    parser.add_argument(
        "--smoke-test",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    return parser


def main(argv=None):
    args = _build_parser().parse_args(argv)
    return launch_gui(
        args.project,
        show_project_dialog=not bool(args.project),
        quit_after_ms=300 if args.smoke_test else None,
        persist_session=not args.smoke_test,
    )


if __name__ == "__main__":
    raise SystemExit(main())
