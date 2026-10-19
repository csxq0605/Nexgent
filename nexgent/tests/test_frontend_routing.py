import subprocess
import sys

from nexgent.cli import _build_parser
from nexgent.runtime.store import SQLiteRunStore


def test_tui_flag_is_available_and_opt_in():
    parser = _build_parser()
    assert parser.parse_args([]).tui is False
    assert parser.parse_args(["--tui"]).tui is True


def test_cli_module_does_not_eagerly_import_qt():
    code = "import sys; import nexgent.cli; print('PyQt6.QtWidgets' in sys.modules)"
    completed = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert completed.stdout.strip() == "False"


def test_single_task_cli_crosses_durable_runtime_boundary(tmp_path):
    session_dir = tmp_path / "sessions"
    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            "from nexgent.cli import main; main()",
            "--task",
            "offline traced task",
            "--dry-run",
            "--bare",
            "--output-format",
            "json",
            "--session-dir",
            str(session_dir),
        ],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=True,
    )

    store = SQLiteRunStore(tmp_path / ".nexgent" / "runs")
    durable_runs = store.list_runs()
    run = durable_runs[0]

    assert completed.returncode == 0
    assert len(durable_runs) == 1
    assert run.status.value == "completed_unverified"
    assert [event.sequence for event in store.list_events(run.run_id)] == [1, 2]
    assert store.list_resumable_runs() == []
