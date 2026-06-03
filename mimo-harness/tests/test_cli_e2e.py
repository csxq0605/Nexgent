"""End-to-end tests for CLI entry point.

Tests the CLI with real subprocess calls to verify:
- --help flag works
- --version flag works (if implemented)
- Single-shot mode with --task
- Output format options
"""

import os
import sys
import subprocess
import pytest


def _get_python_path():
    """Get the Python executable path."""
    return sys.executable


def _run_cli(*args, timeout=120):
    """Run the CLI with given arguments."""
    cmd = [_get_python_path(), "-m", "mimo_harness.cli"] + list(args)
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=os.path.join(os.path.dirname(__file__), ".."),
    )
    return result


class TestCLIHelp:
    """Test CLI help output."""

    def test_help_flag(self):
        """--help should show usage information."""
        result = _run_cli("--help")
        assert result.returncode == 0
        assert "Usage" in result.stdout or "usage" in result.stdout
        assert "--task" in result.stdout
        assert "--model" in result.stdout

    def test_help_short_flag(self):
        """-h should show usage information."""
        result = _run_cli("-h")
        assert result.returncode == 0
        assert "Usage" in result.stdout or "usage" in result.stdout


class TestCLIOutputFormat:
    """Test CLI output format options."""

    def test_json_output_format(self):
        """--output-format json should produce valid JSON."""
        # Skip if no API key
        api_key = os.environ.get("MIMO_API_KEY", "")
        if not api_key or api_key == "test-key-for-testing":
            pytest.skip("Real MIMO_API_KEY not set")

        result = _run_cli(
            "--task", "What is 2 + 2? Reply with just the number.",
            "--output-format", "json",
            "--max-steps", "5",
            "--bare",
        )
        assert result.returncode == 0
        # Should be valid JSON
        import json
        data = json.loads(result.stdout)
        assert "content" in data
        assert "session_id" in data

    def test_stream_json_output_format(self):
        """--output-format stream-json should produce JSONL."""
        # Skip if no API key
        api_key = os.environ.get("MIMO_API_KEY", "")
        if not api_key or api_key == "test-key-for-testing":
            pytest.skip("Real MIMO_API_KEY not set")

        result = _run_cli(
            "--task", "What is 2 + 2? Reply with just the number.",
            "--output-format", "stream-json",
            "--max-steps", "5",
            "--bare",
        )
        assert result.returncode == 0
        # Should be valid JSONL (one JSON per line)
        import json
        lines = [line for line in result.stdout.strip().split("\n") if line.strip()]
        assert len(lines) > 0
        for line in lines:
            data = json.loads(line)
            assert "type" in data


class TestCLIDryRun:
    """Test CLI dry-run mode."""

    def test_dry_run_mode(self):
        """--dry-run should block all tool execution including reads."""
        # Skip if no API key
        api_key = os.environ.get("MIMO_API_KEY", "")
        if not api_key or api_key == "test-key-for-testing":
            pytest.skip("Real MIMO_API_KEY not set")

        result = _run_cli(
            "--task", "Read the file README.md",
            "--dry-run",
            "--max-steps", "5",
            "--bare",
        )
        assert result.returncode == 0
        # Dry-run blocks all tools — file content should NOT appear
        # The agent should see permission denied errors
        stdout_lower = result.stdout.lower()
        assert "dry-run" in stdout_lower or "permission denied" in stdout_lower


class TestCLIPlanMode:
    """Test CLI plan mode."""

    def test_plan_mode(self):
        """--plan should enable read-only mode."""
        # Skip if no API key
        api_key = os.environ.get("MIMO_API_KEY", "")
        if not api_key or api_key == "test-key-for-testing":
            pytest.skip("Real MIMO_API_KEY not set")

        result = _run_cli(
            "--task", "What is 2 + 2?",
            "--plan",
            "--max-steps", "5",
            "--bare",
        )
        assert result.returncode == 0


class TestCLIErrorHandling:
    """Test CLI error handling."""

    def test_invalid_model(self):
        """Invalid model should fail gracefully."""
        # Skip if no API key
        api_key = os.environ.get("MIMO_API_KEY", "")
        if not api_key or api_key == "test-key-for-testing":
            pytest.skip("Real MIMO_API_KEY not set")

        result = _run_cli(
            "--task", "Hello",
            "--model", "nonexistent-model-12345",
            "--max-steps", "1",
            "--bare",
        )
        # Should fail but not crash
        assert result.returncode != 0 or "error" in result.stderr.lower() or "error" in result.stdout.lower()


class TestCLIBareMode:
    """Test CLI bare mode."""

    def test_bare_mode(self):
        """--bare should skip memory loading."""
        # Skip if no API key
        api_key = os.environ.get("MIMO_API_KEY", "")
        if not api_key or api_key == "test-key-for-testing":
            pytest.skip("Real MIMO_API_KEY not set")

        result = _run_cli(
            "--task", "What is 2 + 2? Reply with just the number.",
            "--bare",
            "--max-steps", "5",
        )
        assert result.returncode == 0
        assert "4" in result.stdout


class TestCLIEffortLevels:
    """Test CLI effort levels."""

    def test_low_effort(self):
        """--effort low should work."""
        # Skip if no API key
        api_key = os.environ.get("MIMO_API_KEY", "")
        if not api_key or api_key == "test-key-for-testing":
            pytest.skip("Real MIMO_API_KEY not set")

        result = _run_cli(
            "--task", "What is 2 + 2?",
            "--effort", "low",
            "--max-steps", "5",
            "--bare",
        )
        assert result.returncode == 0

    def test_high_effort(self):
        """--effort high should work."""
        # Skip if no API key
        api_key = os.environ.get("MIMO_API_KEY", "")
        if not api_key or api_key == "test-key-for-testing":
            pytest.skip("Real MIMO_API_KEY not set")

        result = _run_cli(
            "--task", "What is 2 + 2?",
            "--effort", "high",
            "--max-steps", "5",
            "--bare",
        )
        assert result.returncode == 0


class TestMainFunctionPaths:
    """Test main() function with various argument combinations (in-process)."""

    @pytest.fixture(autouse=True)
    def _require_api(self):
        """All main() tests require real API."""
        if not os.environ.get("MIMO_API_KEY") or os.environ.get("MIMO_API_KEY") == "test-key-for-testing":
            pytest.skip("Real MIMO_API_KEY not set")

    def test_main_single_task(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.argv", ["mimo", "--task", "Reply with the word hello."])
        from mimo_harness.cli import main
        main()
        captured = capsys.readouterr()
        assert len(captured.out.strip()) > 0

    def test_main_dry_run(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.argv", ["mimo", "--task", "test", "--dry-run"])
        from mimo_harness.cli import main
        main()
        captured = capsys.readouterr()
        # dry-run should print something (plan or acknowledgment)
        assert len(captured.out.strip()) > 0

    def test_main_plan_mode(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.argv", ["mimo", "--task", "Say hello", "--plan"])
        from mimo_harness.cli import main
        main()
        captured = capsys.readouterr()
        assert len(captured.out.strip()) > 0

    def test_main_stream_mode(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.argv", ["mimo", "--task", "Say hello", "--stream"])
        from mimo_harness.cli import main
        main()
        captured = capsys.readouterr()
        assert len(captured.out.strip()) > 0

    def test_main_repl_quit(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.argv", ["mimo"])
        monkeypatch.setattr("builtins.input", lambda _="": "/quit")
        from mimo_harness.cli import main
        main()
        captured = capsys.readouterr()
        assert "Bye!" in captured.out

    def test_main_repl_empty_then_quit(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.argv", ["mimo"])
        _iter = iter(["", "  ", "/quit"])
        monkeypatch.setattr("builtins.input", lambda _="": next(_iter))
        from mimo_harness.cli import main
        main()
        captured = capsys.readouterr()
        assert "Bye!" in captured.out

    def test_main_eof_exits(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.argv", ["mimo"])
        def _raise_eof(_=""): raise EOFError
        monkeypatch.setattr("builtins.input", _raise_eof)
        from mimo_harness.cli import main
        main()
        captured = capsys.readouterr()
        assert "Bye!" in captured.out
