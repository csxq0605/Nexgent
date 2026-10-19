import subprocess
import sys
from pathlib import Path


def test_offline_harness_demo_completes_and_exports_verified_trace(tmp_path):
    package_root = Path(__file__).resolve().parents[1]
    workspace = tmp_path / "demo-workspace"
    completed = subprocess.run(
        [
            sys.executable,
            str(package_root / "examples" / "harness_fault_recovery_demo.py"),
            "--workspace",
            str(workspace),
        ],
        cwd=package_root,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=60,
        check=False,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "status: succeeded" in completed.stdout
    assert "attempts: 2" in completed.stdout
    assert "recoveries: 1" in completed.stdout
    assert "trace_integrity: passed" in completed.stdout
    assert len(list((workspace / ".nexgent" / "exports").glob("*.jsonl"))) == 1
