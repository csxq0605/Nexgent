"""Tests for display.py - Structured CLI display module."""

import os
import sys
import pytest
from unittest.mock import patch, MagicMock
from mimo_harness.display import (
    _supports_color,
    _c,
    _dim,
    _bold,
    _green,
    _yellow,
    _red,
    _cyan,
    _blue,
    _format_tokens,
    _format_tool_args,
    StepInfo,
    print_step_header,
    print_thinking_indicator,
    print_tool_call_start,
    print_tool_call_result,
    print_streaming_token,
    print_streaming_end,
    print_error,
    print_warning,
    print_info,
    print_success,
    print_token_usage,
    print_tool_list,
    print_context_breakdown,
    print_session_stats,
    print_help,
    print_banner,
    print_session_info,
    Spinner,
    USE_COLOR,
)


class TestSupportsColor:
    """Test _supports_color function."""

    def test_returns_false_when_no_color_env(self):
        """Should return False when NO_COLOR is set."""
        with patch.dict(os.environ, {"NO_COLOR": "1"}):
            assert _supports_color() is False

    def test_returns_false_when_term_dumb(self):
        """Should return False when TERM=dumb."""
        with patch.dict(os.environ, {"TERM": "dumb"}):
            assert _supports_color() is False

    def test_returns_false_when_not_tty(self):
        """Should return False when stdout is not a tty."""
        with patch("sys.stdout") as mock_stdout:
            mock_stdout.isatty.return_value = False
            # Need to re-evaluate _supports_color with mocked stdout
            import importlib
            import mimo_harness.display
            with patch.object(mimo_harness.display, "sys") as mock_sys:
                mock_sys.stdout = mock_stdout
                mock_sys.platform = "linux"
                assert _supports_color() is False


class TestColorFunctions:
    """Test color helper functions."""

    def test_c_with_color_disabled(self):
        """_c should return plain text when USE_COLOR is False."""
        with patch("mimo_harness.display.USE_COLOR", False):
            result = _c("\033[31m", "hello")
            assert result == "hello"

    def test_c_with_color_enabled(self):
        """_c should wrap text with color codes when USE_COLOR is True."""
        with patch("mimo_harness.display.USE_COLOR", True):
            result = _c("\033[31m", "hello")
            assert result == "\033[31mhello\033[0m"

    def test_dim_returns_dim_text(self):
        """_dim should apply DIM formatting."""
        with patch("mimo_harness.display.USE_COLOR", False):
            assert _dim("test") == "test"

    def test_bold_returns_bold_text(self):
        """_bold should apply BOLD formatting."""
        with patch("mimo_harness.display.USE_COLOR", False):
            assert _bold("test") == "test"

    def test_green_returns_green_text(self):
        """_green should apply GREEN formatting."""
        with patch("mimo_harness.display.USE_COLOR", False):
            assert _green("test") == "test"

    def test_yellow_returns_yellow_text(self):
        """_yellow should apply YELLOW formatting."""
        with patch("mimo_harness.display.USE_COLOR", False):
            assert _yellow("test") == "test"

    def test_red_returns_red_text(self):
        """_red should apply RED formatting."""
        with patch("mimo_harness.display.USE_COLOR", False):
            assert _red("test") == "test"

    def test_cyan_returns_cyan_text(self):
        """_cyan should apply CYAN formatting."""
        with patch("mimo_harness.display.USE_COLOR", False):
            assert _cyan("test") == "test"

    def test_blue_returns_blue_text(self):
        """_blue should apply BLUE formatting."""
        with patch("mimo_harness.display.USE_COLOR", False):
            assert _blue("test") == "test"


class TestFormatTokens:
    """Test _format_tokens function."""

    def test_small_numbers(self):
        """Should return string for numbers < 1000."""
        assert _format_tokens(0) == "0"
        assert _format_tokens(1) == "1"
        assert _format_tokens(999) == "999"

    def test_thousands(self):
        """Should format thousands with K suffix."""
        assert _format_tokens(1000) == "1.0K"
        assert _format_tokens(1500) == "1.5K"
        assert _format_tokens(10000) == "10.0K"
        assert _format_tokens(100000) == "100.0K"


class TestFormatToolArgs:
    """Test _format_tool_args function."""

    def test_empty_args(self):
        """Should return empty string for empty args."""
        assert _format_tool_args("any_tool", {}) == ""

    def test_read_file_path(self):
        """Should format read_file with path."""
        result = _format_tool_args("read_file", {"path": "/test/file.py"})
        assert "/test/file.py" in result

    def test_write_file_path(self):
        """Should format write_file with path."""
        result = _format_tool_args("write_file", {"path": "/test/file.py"})
        assert "/test/file.py" in result

    def test_run_command(self):
        """Should format run_command with command."""
        result = _format_tool_args("run_command", {"command": "ls -la"})
        assert "ls -la" in result

    def test_run_command_long(self):
        """Should truncate long commands."""
        long_cmd = "a" * 100
        result = _format_tool_args("run_command", {"command": long_cmd})
        assert "..." in result

    def test_search_files_pattern(self):
        """Should format search_files with pattern."""
        result = _format_tool_args("search_files", {"pattern": "*.py"})
        assert "*.py" in result

    def test_list_directory(self):
        """Should format list_directory with path."""
        result = _format_tool_args("list_directory", {"path": "/test"})
        assert "/test" in result

    def test_generic_tool(self):
        """Should format generic tool with JSON preview."""
        result = _format_tool_args("unknown_tool", {"key": "value"})
        assert "key" in result


class TestStepInfo:
    """Test StepInfo dataclass."""

    def test_creation(self):
        """Should create StepInfo with required fields."""
        info = StepInfo(current=1, max_steps=10)
        assert info.current == 1
        assert info.max_steps == 10
        assert info.model == ""
        assert info.effort == "medium"

    def test_with_all_fields(self):
        """Should create StepInfo with all fields."""
        info = StepInfo(current=5, max_steps=20, model="test-model", effort="high")
        assert info.model == "test-model"
        assert info.effort == "high"


class TestPrintFunctions:
    """Test print functions (smoke tests)."""

    def test_print_step_header(self, capsys):
        """Should print step header."""
        info = StepInfo(current=1, max_steps=10, model="test", effort="medium")
        print_step_header(info)
        captured = capsys.readouterr()
        assert "Step 1/10" in captured.out

    def test_print_thinking_indicator(self, capsys):
        """Should print thinking indicator."""
        print_thinking_indicator()
        captured = capsys.readouterr()
        assert "Thinking" in captured.out

    def test_print_tool_call_start(self, capsys):
        """Should print tool call start."""
        print_tool_call_start("read_file", {"path": "/test"}, 0, 1)
        captured = capsys.readouterr()
        assert "read_file" in captured.out

    def test_print_tool_call_result_success(self, capsys):
        """Should print successful tool call result."""
        print_tool_call_result("read_file", True, 1.5)
        captured = capsys.readouterr()
        assert "read_file" in captured.out
        assert "1.5s" in captured.out

    def test_print_tool_call_result_failure(self, capsys):
        """Should print failed tool call result."""
        print_tool_call_result("read_file", False, 0.1, error="File not found")
        captured = capsys.readouterr()
        assert "read_file" in captured.out
        assert "File not found" in captured.out

    def test_print_error(self, capsys):
        """Should print error message."""
        print_error("Something went wrong")
        captured = capsys.readouterr()
        assert "Something went wrong" in captured.out

    def test_print_warning(self, capsys):
        """Should print warning message."""
        print_warning("Be careful")
        captured = capsys.readouterr()
        assert "Be careful" in captured.out

    def test_print_info(self, capsys):
        """Should print info message."""
        print_info("FYI")
        captured = capsys.readouterr()
        assert "FYI" in captured.out

    def test_print_success(self, capsys):
        """Should print success message."""
        print_success("Done!")
        captured = capsys.readouterr()
        assert "Done!" in captured.out

    def test_print_token_usage(self, capsys):
        """Should print token usage with progress bar."""
        print_token_usage(50000, 200000)
        captured = capsys.readouterr()
        assert "Tokens:" in captured.out

    def test_print_tool_list(self, capsys):
        """Should print tool list."""
        tools = [
            {"name": "read_file", "description": "Read a file", "is_read_only": True},
            {"name": "write_file", "description": "Write a file"},
        ]
        print_tool_list(tools)
        captured = capsys.readouterr()
        assert "read_file" in captured.out
        assert "write_file" in captured.out

    def test_print_context_breakdown(self, capsys):
        """Should print context breakdown."""
        messages = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
        ]
        print_context_breakdown(messages)
        captured = capsys.readouterr()
        assert "Context Breakdown" in captured.out
        assert "user" in captured.out

    def test_print_session_stats(self, capsys):
        """Should print session stats."""
        stats = {"Messages": 10, "Tokens": "5K"}
        print_session_stats(stats)
        captured = capsys.readouterr()
        assert "Session Statistics" in captured.out
        assert "Messages" in captured.out

    def test_print_help(self, capsys):
        """Should print help."""
        print_help()
        captured = capsys.readouterr()
        assert "/help" in captured.out
        assert "/quit" in captured.out

    def test_print_banner(self, capsys):
        """Should print banner."""
        print_banner("1.0.0")
        captured = capsys.readouterr()
        assert "MiMo Harness" in captured.out
        assert "1.0.0" in captured.out

    def test_print_session_info(self, capsys):
        """Should print session info."""
        print_session_info("test-model", "interactive", True)
        captured = capsys.readouterr()
        assert "test-model" in captured.out
        assert "interactive" in captured.out


class TestSpinner:
    """Test Spinner class."""

    def test_creation(self):
        """Should create spinner with default message."""
        spinner = Spinner()
        assert spinner.message == "Thinking"

    def test_creation_with_message(self):
        """Should create spinner with custom message."""
        spinner = Spinner("Loading")
        assert spinner.message == "Loading"

    def test_update_message(self):
        """Should update spinner message."""
        spinner = Spinner()
        spinner.update_message("Working")
        assert spinner.message == "Working"

    def test_start_stop_without_color(self, capsys):
        """Should print message directly when color is disabled."""
        with patch("mimo_harness.display.USE_COLOR", False):
            spinner = Spinner("Testing")
            spinner.start()
            spinner.stop()
            captured = capsys.readouterr()
            assert "Testing..." in captured.out
