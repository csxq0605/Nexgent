"""Capture a sanitized, repeatable Nexgent desktop screenshot."""

import os
from pathlib import Path
import sys
import tempfile

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from PyQt6.QtCore import QTimer

from nexgent.gui.app import create_application
from nexgent.gui.main_window import MainWindow
from nexgent.runtime.service import NexgentRuntime
from nexgent.runtime.contracts import RunMode
from nexgent.runtime.recorder import RunRecorder
from nexgent.runtime.store import SQLiteRunStore
from nexgent.context import Session


def main():
    app = create_application(["nexgent-screenshot"])
    screenshot_directory = tempfile.TemporaryDirectory(
        prefix="nexgent-gui-screenshot-"
    )
    screenshot_store = SQLiteRunStore(Path(screenshot_directory.name) / "runs")
    runtime = NexgentRuntime(
        ROOT / "demo-project",
        session=Session("demo-session"),
        agent_options={"model": "mimo-v2.5-pro", "auto_approve": True},
        run_store=screenshot_store,
    )
    recorder = RunRecorder(runtime.run_store, ROOT / "demo-project")
    run_context = recorder.start_run(
        "Repair the unstable simulation and verify its invariant",
        mode=RunMode.CODING,
    )
    recorder.pause(run_context, "Waiting for the next verified recovery attempt")
    window = MainWindow(runtime)
    window.resize(1480, 900)
    window.agent.add_message(
        "You", "Repair the unstable simulation and verify its invariant."
    )
    window.agent.add_message(
        "Nexgent",
        "The acceptance check failed. I traced the affected simulation inputs and "
        "paused the run before the next verified recovery attempt.",
    )
    window.agent.append_activity(
        "→ Run simulation acceptance check\n"
        "→ Attribute failure to timestep configuration\n"
        "• Recovery evidence saved\n"
        "• Run paused\n"
    )
    window.navigation_tabs.setCurrentWidget(window.harness_runs)
    window._show_harness_run_details(run_context.run_id)
    window.sessions.clear()
    window.sessions.addItem("demo-session")
    window.show()
    app.processEvents()

    destination = ROOT / "assets" / "screenshots" / "main-window.png"
    destination.parent.mkdir(parents=True, exist_ok=True)

    def capture():
        window.repaint()
        app.processEvents()
        window.grab().save(str(destination), "PNG")
        runtime.session.auto_save_dir = None
        window.close()
        screenshot_directory.cleanup()
        app.quit()

    QTimer.singleShot(1500, capture)
    app.exec()


if __name__ == "__main__":
    main()
