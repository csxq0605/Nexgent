"""Tests for display.py - Structured CLI display module.

No mocking — uses real function calls and monkeypatch for env/config overrides.
"""

import os
import sys
import json
import pytest
import nexgent.display
from nexgent.display import (
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
    _wrap_text,
    _visible_len,
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
    # Task 5: Structured CLI Interface
    print_user_input,
    print_model_output_start,
    print_model_output_end,
    print_code_block,
    print_tool_call_collapsible,
    StatusBar,
    get_status_bar,
    print_status_bar,
    BUBBLE_V,
    COLLAPSE_ICON,
    EXPAND_ICON,
    USER_ICON,
    ASSISTANT_ICON,
)


@pytest.fixture(autouse=True)
def _restore_use_color():
    """Restore USE_COLOR after each test."""
    original = nexgent.display.USE_COLOR
    yield
    nexgent.display.USE_COLOR = original


class TestSupportsColor:
    """Test _supports_color function."""

    def test_returns_false_when_no_color_env(self, monkeypatch):
        """Should return False when NO_COLOR is set."""
        monkeypatch.setenv("NO_COLOR", "1")
        assert _supports_color() is False

    def test_returns_false_when_term_dumb(self, monkeypatch):
        """Should return False when TERM=dumb."""
        monkeypatch.setenv("TERM", "dumb")
        assert _supports_color() is False

    def test_returns_false_when_not_tty(self, monkeypatch):
        """Should return False when stdout is not a tty."""
        # In pytest capsys / subprocess context, stdout is not a tty
        assert _supports_color() is False


class TestColorFunctions:
    """Test color helper functions."""

    def test_c_with_color_disabled(self):
        """_c should return plain text when USE_COLOR is False."""
        nexgent.display.USE_COLOR = False
        result = _c("\033[31m", "hello")
        assert result == "hello"

    def test_c_with_color_enabled(self):
        """_c should wrap text with color codes when USE_COLOR is True."""
        nexgent.display.USE_COLOR = True
        result = _c("\033[31m", "hello")
        assert result == "\033[31mhello\033[0m"

    def test_dim_returns_dim_text(self):
        """_dim should apply DIM formatting."""
        nexgent.display.USE_COLOR = False
        assert _dim("test") == "test"

    def test_bold_returns_bold_text(self):
        """_bold should apply BOLD formatting."""
        nexgent.display.USE_COLOR = False
        assert _bold("test") == "test"

    def test_green_returns_green_text(self):
        """_green should apply GREEN formatting."""
        nexgent.display.USE_COLOR = False
        assert _green("test") == "test"

    def test_yellow_returns_yellow_text(self):
        """_yellow should apply YELLOW formatting."""
        nexgent.display.USE_COLOR = False
        assert _yellow("test") == "test"

    def test_red_returns_red_text(self):
        """_red should apply RED formatting."""
        nexgent.display.USE_COLOR = False
        assert _red("test") == "test"

    def test_cyan_returns_cyan_text(self):
        """_cyan should apply CYAN formatting."""
        nexgent.display.USE_COLOR = False
        assert _cyan("test") == "test"

    def test_blue_returns_blue_text(self):
        """_blue should apply BLUE formatting."""
        nexgent.display.USE_COLOR = False
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
        """Should not print anything (step header is now a no-op)."""
        info = StepInfo(current=1, max_steps=10, model="test", effort="medium")
        print_step_header(info)
        captured = capsys.readouterr()
        assert captured.out == ""

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
        # Rich Table renders title across lines; check key content
        import re
        clean = re.sub(r'\x1b\[[0-9;]*m', '', captured.out)
        assert "Messages" in clean
        assert "10" in clean

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
        assert "Nexgent" in captured.out
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
        nexgent.display.USE_COLOR = False
        spinner = Spinner("Testing")
        spinner.start()
        spinner.stop()
        captured = capsys.readouterr()
        assert "Testing..." in captured.out


class TestUnicodeFallback:
    """Test that display functions work correctly with ASCII fallbacks."""

    def test_safe_print_handles_unicode_error(self, capsys, monkeypatch):
        """_safe_print should fall back to ASCII when encoding fails."""
        from nexgent.display import _safe_print
        # _safe_print should not raise even with Unicode chars
        _safe_print("test message with unicode: ✓")
        captured = capsys.readouterr()
        assert "test message" in captured.out

    def test_print_thinking_indicator_no_unicode_error(self, capsys):
        """print_thinking_indicator should never raise UnicodeEncodeError."""
        # Should work regardless of _SUPPORTS_UNICODE state
        print_thinking_indicator()
        captured = capsys.readouterr()
        assert "Thinking" in captured.out

    def test_print_tool_call_start_no_unicode_error(self, capsys):
        """print_tool_call_start should never raise UnicodeEncodeError."""
        print_tool_call_start("test_tool", {"arg": "val"})
        captured = capsys.readouterr()
        assert "test_tool" in captured.out

    def test_print_tool_call_result_no_unicode_error(self, capsys):
        """print_tool_call_result should never raise UnicodeEncodeError."""
        print_tool_call_result("test_tool", True, 0.5)
        captured = capsys.readouterr()
        assert "test_tool" in captured.out

    def test_print_banner_no_unicode_error(self, capsys):
        """print_banner should never raise UnicodeEncodeError."""
        print_banner("1.0.0")
        captured = capsys.readouterr()
        assert "Nexgent" in captured.out

    def test_print_error_no_unicode_error(self, capsys):
        """print_error should never raise UnicodeEncodeError."""
        print_error("test error")
        captured = capsys.readouterr()
        assert "test error" in captured.out

    def test_print_warning_no_unicode_error(self, capsys):
        """print_warning should never raise UnicodeEncodeError."""
        print_warning("test warning")
        captured = capsys.readouterr()
        assert "test warning" in captured.out

    def test_print_success_no_unicode_error(self, capsys):
        """print_success should never raise UnicodeEncodeError."""
        print_success("test success")
        captured = capsys.readouterr()
        assert "test success" in captured.out

    def test_print_token_usage_no_unicode_error(self, capsys):
        """print_token_usage should never raise UnicodeEncodeError."""
        print_token_usage(50000, 200000)
        captured = capsys.readouterr()
        assert "Tokens:" in captured.out

    def test_unicode_constants_defined(self):
        """All Unicode/ASCII fallback constants should be defined."""
        from nexgent.display import (
            THINK_ICON, TOOL_ICON, CHECK_ICON, CROSS_ICON,
            WARN_ICON, INFO_ICON, DOT_ICON, ARROW_ICON,
            SPINNER_FRAMES, BOX_TL, BOX_TR, BOX_BL, BOX_BR,
            BOX_H, BOX_V, BAR_FILL, BAR_EMPTY, STEP_H,
        )
        # All should be non-empty strings or lists
        assert isinstance(THINK_ICON, str) and len(THINK_ICON) > 0
        assert isinstance(TOOL_ICON, str) and len(TOOL_ICON) > 0
        assert isinstance(CHECK_ICON, str) and len(CHECK_ICON) > 0
        assert isinstance(SPINNER_FRAMES, list) and len(SPINNER_FRAMES) > 0


# =========================================================================
# Task 5: Structured CLI Interface Tests
# =========================================================================

class TestVisibleLen:
    """Test _visible_len helper function."""

    def test_plain_text(self):
        """Plain text length equals len()."""
        assert _visible_len("hello") == 5

    def test_ansi_colored_text(self):
        """ANSI codes should not count toward visible length."""
        nexgent.display.USE_COLOR = True
        colored = _cyan("hello")
        assert _visible_len(colored) == 5

    def test_empty_string(self):
        """Empty string returns 0."""
        assert _visible_len("") == 0


class TestWrapText:
    """Test _wrap_text helper function."""

    def test_empty_text(self):
        """Empty text returns single empty line."""
        assert _wrap_text("") == [""]

    def test_short_text_no_wrapping(self):
        """Text shorter than width is not wrapped."""
        result = _wrap_text("hello world", width=80)
        assert result == ["hello world"]

    def test_long_text_wraps(self):
        """Text longer than width is wrapped."""
        long_text = "word " * 30  # 150 chars
        result = _wrap_text(long_text, width=40)
        for line in result:
            assert len(line) <= 40  # hard-break guarantee: no line exceeds width
        assert len(result) > 1

    def test_preserves_newlines(self):
        """Existing newlines are preserved."""
        result = _wrap_text("line1\nline2\nline3", width=80)
        assert result == ["line1", "line2", "line3"]

    def test_empty_lines_preserved(self):
        """Empty lines from double newlines are preserved."""
        result = _wrap_text("line1\n\nline3", width=80)
        assert result == ["line1", "", "line3"]

    def test_long_word_hard_breaks(self):
        """Words longer than width are hard-broken."""
        long_word = "a" * 100
        result = _wrap_text(long_word, width=30)
        assert len(result) >= 3
        for line in result:
            assert len(line) <= 30

    def test_long_word_mixed_with_short(self):
        """Long words among short words are hard-broken."""
        result = _wrap_text("hello " + "x" * 50 + " world", width=20)
        for line in result:
            assert len(line) <= 20


class TestPrintUserInput:
    """Test print_user_input conversation bubble."""

    def test_basic_output(self, capsys):
        """Should print user input in a bubble."""
        print_user_input("hello world")
        captured = capsys.readouterr()
        assert "hello world" in captured.out
        assert USER_ICON in captured.out or ">" in captured.out  # Unicode or ASCII
        assert "You" in captured.out

    def test_multiline_input(self, capsys):
        """Should handle multiline input."""
        print_user_input("line1\nline2\nline3")
        captured = capsys.readouterr()
        assert "line1" in captured.out
        assert "line2" in captured.out
        assert "line3" in captured.out

    def test_long_input_wraps(self, capsys):
        """Should wrap long input."""
        long_text = "word " * 50
        print_user_input(long_text, width=40)
        captured = capsys.readouterr()
        assert "word" in captured.out

    def test_empty_input(self, capsys):
        """Should handle empty input."""
        print_user_input("")
        captured = capsys.readouterr()
        assert "You" in captured.out

    def test_no_unicode_error(self, capsys):
        """Should never raise UnicodeEncodeError."""
        print_user_input("test with special chars: ✓✗⚡")
        captured = capsys.readouterr()
        assert "test" in captured.out


class TestPrintModelOutput:
    """Test print_model_output_start and print_model_output_end."""

    def test_start_with_model(self, capsys):
        """Should print model output start with model name."""
        print_model_output_start("test-model")
        captured = capsys.readouterr()
        assert "test-model" in captured.out
        assert ASSISTANT_ICON in captured.out or "*" in captured.out

    def test_start_without_model(self, capsys):
        """Should print model output start without model name."""
        print_model_output_start()
        captured = capsys.readouterr()
        assert "Assistant" in captured.out

    def test_end(self, capsys):
        """Should print model output end."""
        print_model_output_end()
        captured = capsys.readouterr()
        assert captured.out  # Should have output

    def test_start_end_pair(self, capsys):
        """Start and end should produce a complete container."""
        print_model_output_start("model")
        print("  response text")
        print_model_output_end()
        captured = capsys.readouterr()
        assert "model" in captured.out
        assert "response text" in captured.out

    def test_border_width_consistent(self, capsys):
        """Top and bottom borders should have consistent visible width."""
        from nexgent.display import _visible_len, _OUTPUT_BOX_WIDTH
        print_model_output_start("test-model")
        print_model_output_end()
        captured = capsys.readouterr()
        lines = [l for l in captured.out.split("\n") if l.strip()]
        # Bottom border is last non-empty line; includes 2-space indent
        bot_vis = _visible_len(lines[-1])
        assert bot_vis == _OUTPUT_BOX_WIDTH + 2, f"Bottom ({bot_vis}) != {_OUTPUT_BOX_WIDTH + 2}"


class TestPrintCodeBlock:
    """Test print_code_block with syntax highlighting."""

    def test_basic_code_block(self, capsys):
        """Should print code block with border."""
        print_code_block("print('hello')")
        captured = capsys.readouterr()
        assert "print('hello')" in captured.out

    def test_code_block_with_language(self, capsys):
        """Should print code block with language label."""
        print_code_block("def foo(): pass", language="python")
        captured = capsys.readouterr()
        # Rich Panel renders title with ANSI codes, strip them for comparison
        import re
        clean = re.sub(r'\x1b\[[0-9;]*m', '', captured.out)
        assert "python" in clean
        # Pygments inserts ANSI codes between tokens, so check parts separately
        assert "def" in captured.out
        assert "foo" in captured.out

    def test_multiline_code(self, capsys):
        """Should handle multiline code."""
        code = "line1\nline2\nline3"
        print_code_block(code)
        captured = capsys.readouterr()
        assert "line1" in captured.out
        assert "line2" in captured.out
        assert "line3" in captured.out

    def test_empty_code(self, capsys):
        """Should handle empty code."""
        print_code_block("")
        captured = capsys.readouterr()
        assert captured.out  # Should still print borders

    def test_unknown_language_fallback(self, capsys):
        """Should fall back to plain display for unknown language."""
        print_code_block("some code", language="not_a_real_lang_xyz")
        captured = capsys.readouterr()
        assert "some code" in captured.out


class TestPrintToolCallCollapsible:
    """Test print_tool_call_collapsible."""

    def test_collapsed_basic(self, capsys):
        """Should print collapsed tool call."""
        print_tool_call_collapsible("read_file", {"path": "/test"}, 0, 1, collapsed=True)
        captured = capsys.readouterr()
        assert "read_file" in captured.out
        assert "/test" in captured.out
        # Collapsed icon should be present
        assert COLLAPSE_ICON in captured.out or "[+]" in captured.out

    def test_expanded_basic(self, capsys):
        """Should print expanded tool call with details."""
        print_tool_call_collapsible("read_file", {"path": "/test"}, 0, 1, collapsed=False)
        captured = capsys.readouterr()
        assert "read_file" in captured.out
        assert "/test" in captured.out
        # Expanded icon should be present
        assert EXPAND_ICON in captured.out or "[-]" in captured.out

    def test_with_result_success(self, capsys):
        """Should show success status."""
        print_tool_call_collapsible(
            "read_file", {"path": "/test"}, 0, 1,
            collapsed=True, success=True, duration=1.5
        )
        captured = capsys.readouterr()
        assert "read_file" in captured.out
        assert "1.5s" in captured.out

    def test_with_result_failure(self, capsys):
        """Should show failure status."""
        print_tool_call_collapsible(
            "read_file", {"path": "/test"}, 0, 1,
            collapsed=True, success=False, duration=0.1
        )
        captured = capsys.readouterr()
        assert "read_file" in captured.out

    def test_multiple_calls_indexed(self, capsys):
        """Should show index when total > 1."""
        print_tool_call_collapsible("tool1", {}, 0, 3, collapsed=True)
        print_tool_call_collapsible("tool2", {}, 1, 3, collapsed=True)
        captured = capsys.readouterr()
        assert "[1/3]" in captured.out
        assert "[2/3]" in captured.out

    def test_expanded_shows_full_args(self, capsys):
        """Expanded view should show full args JSON."""
        args = {"path": "/test/file.py", "content": "hello"}
        print_tool_call_collapsible("write_file", args, 0, 1, collapsed=False)
        captured = capsys.readouterr()
        assert "path" in captured.out
        assert "/test/file.py" in captured.out

    def test_expanded_shows_result_preview(self, capsys):
        """Expanded view should show result preview."""
        print_tool_call_collapsible(
            "read_file", {"path": "/test"}, 0, 1,
            collapsed=False, result_preview="file content here"
        )
        captured = capsys.readouterr()
        assert "file content here" in captured.out

    def test_no_unicode_error(self, capsys):
        """Should never raise UnicodeEncodeError."""
        print_tool_call_collapsible("tool", {"key": "✓✗⚡"}, 0, 1, collapsed=True)
        captured = capsys.readouterr()
        assert "tool" in captured.out


class TestStatusBar:
    """Test StatusBar class."""

    def test_initial_state_is_idle(self):
        """Status bar should start in idle state."""
        bar = StatusBar()
        assert "Idle" in bar.render()

    def test_set_thinking(self):
        """Should set thinking state."""
        bar = StatusBar()
        bar.set_thinking("test-model")
        rendered = bar.render()
        assert "Thinking" in rendered
        assert "test-model" in rendered

    def test_set_thinking_no_model(self):
        """Should set thinking state without model."""
        bar = StatusBar()
        bar.set_thinking()
        assert "Thinking" in bar.render()

    def test_set_executing(self):
        """Should set executing state."""
        bar = StatusBar()
        bar.set_executing("read_file")
        rendered = bar.render()
        assert "Executing" in rendered
        assert "read_file" in rendered

    def test_set_idle(self):
        """Should return to idle state."""
        bar = StatusBar()
        bar.set_thinking()
        bar.set_idle()
        assert "Idle" in bar.render()

    def test_set_error(self):
        """Should set error state."""
        bar = StatusBar()
        bar.set_error("something failed")
        rendered = bar.render()
        assert "Error" in rendered
        assert "something failed" in rendered

    def test_print_status(self, capsys):
        """Should print status bar."""
        bar = StatusBar()
        bar.set_thinking("model")
        bar.print_status()
        captured = capsys.readouterr()
        assert "Thinking" in captured.out

    def test_thread_safety(self):
        """Status bar should be thread-safe."""
        import threading
        bar = StatusBar()
        errors = []

        def update_bar():
            try:
                for _ in range(100):
                    bar.set_thinking("model")
                    bar.set_executing("tool")
                    bar.set_idle()
                    rendered = bar.render()
                    assert isinstance(rendered, str)
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=update_bar) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert not errors, f"Thread errors: {errors}"

    def test_get_status_bar_returns_singleton(self):
        """get_status_bar should return the module-level instance."""
        bar1 = get_status_bar()
        bar2 = get_status_bar()
        assert bar1 is bar2

    def test_print_status_bar_function(self, capsys):
        """print_status_bar should print current status."""
        bar = get_status_bar()
        bar.set_idle()
        print_status_bar()
        captured = capsys.readouterr()
        assert "Idle" in captured.out


class TestTask5UnicodeConstants:
    """Test Task 5 Unicode/ASCII fallback constants are all defined."""

    def test_all_task5_constants_defined(self):
        """All Task 5 constants should be non-empty strings."""
        constants = [BUBBLE_V, COLLAPSE_ICON, EXPAND_ICON, USER_ICON, ASSISTANT_ICON]
        for c in constants:
            assert isinstance(c, str) and len(c) > 0


class TestTask5NoUnicodeError:
    """Test all Task 5 display functions handle Unicode safely."""

    def test_all_task5_functions_handle_unicode(self, capsys):
        """All Task 5 functions should handle Unicode without error."""
        unicode_text = "测试中文 ✓✗⚡ emoji 🎉"
        # print_user_input
        print_user_input(unicode_text)
        # print_model_output_start/end
        print_model_output_start(unicode_text)
        print_model_output_end()
        # print_code_block
        print_code_block(f"x = '{unicode_text}'", language="python")
        # print_tool_call_collapsible
        print_tool_call_collapsible(unicode_text, {"参数": unicode_text}, 0, 1)
        # StatusBar
        bar = StatusBar()
        bar.set_error(unicode_text)
        rendered = bar.render()
        assert isinstance(rendered, str)
        # All should produce output without error
        captured = capsys.readouterr()
        assert captured.out
