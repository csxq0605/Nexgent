"""Tests for individual tools (Ch3 patterns)."""

import pytest
import json
import os
import sys
import tempfile
import time
from unittest.mock import patch
from mimo_harness.tools import file_ops, shell, code_exec, math_tools, web_tools, interactive, monitor, doc_tools


class TestFileOps:
    def test_read_file(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        f = tmp_path / "test.txt"
        f.write_text("line1\nline2\nline3\n")
        result = json.loads(file_ops.read_file({"path": str(f)}))
        assert result["total_lines"] == 3
        assert "line1" in result["content"]

    def test_read_file_with_offset(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        f = tmp_path / "test.txt"
        f.write_text("line1\nline2\nline3\n")
        result = json.loads(file_ops.read_file({"path": str(f), "offset": 1, "limit": 2}))
        assert "line2" in result["content"]
        assert "line1" not in result["content"]

    def test_read_nonexistent(self):
        result = json.loads(file_ops.read_file({"path": "/nonexistent/file.txt"}))
        assert "error" in result

    def test_write_file(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        f = tmp_path / "output.txt"
        result = json.loads(file_ops.write_file({
            "path": str(f),
            "content": "hello world",
        }))
        assert result["status"] == "written"
        assert f.read_text() == "hello world"

    def test_write_file_path_validation(self):
        result = json.loads(file_ops.write_file({
            "path": "/etc/passwd",
            "content": "hack",
        }))
        assert "error" in result
        assert "outside" in result["error"]

    def test_edit_file(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        f = tmp_path / "edit.txt"
        f.write_text("hello world")
        # Must read the file first (read-before-edit check)
        file_ops.read_file({"path": str(f)})
        result = json.loads(file_ops.edit_file({
            "path": str(f),
            "old_text": "world",
            "new_text": "python",
        }))
        assert result["status"] == "edited"
        assert f.read_text() == "hello python"

    def test_edit_file_not_found_text(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        f = tmp_path / "edit.txt"
        f.write_text("hello world")
        # Must read the file first (read-before-edit check)
        file_ops.read_file({"path": str(f)})
        result = json.loads(file_ops.edit_file({
            "path": str(f),
            "old_text": "nonexistent",
            "new_text": "replacement",
        }))
        assert "error" in result

    def test_glob_files(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        (tmp_path / "a.py").touch()
        (tmp_path / "b.py").touch()
        (tmp_path / "c.txt").touch()
        result = json.loads(file_ops.glob_files({
            "pattern": str(tmp_path / "*.py"),
        }))
        assert result["total"] == 2

    def test_grep_files(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        f = tmp_path / "search.txt"
        f.write_text("hello world\nfoo bar\nhello again\n")
        # S10: default output_mode is "files_with_matches" — returns file count
        result = json.loads(file_ops.grep_files({
            "pattern": "hello",
            "path": str(tmp_path),
        }))
        assert result["total"] == 1  # 1 file matched
        assert len(result["files"]) == 1
        # S10: content mode returns match count
        result2 = json.loads(file_ops.grep_files({
            "pattern": "hello",
            "path": str(tmp_path),
            "output_mode": "content",
        }))
        assert result2["total"] == 2  # 2 matches

    def test_edit_file_replace_all(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        f = tmp_path / "replace_all.txt"
        f.write_text("hello world hello python hello")
        file_ops.read_file({"path": str(f)})
        result = json.loads(file_ops.edit_file({
            "path": str(f),
            "old_text": "hello",
            "new_text": "bye",
            "replace_all": True,
        }))
        assert result["status"] == "edited"
        assert result["replaced"] == 3
        assert f.read_text() == "bye world bye python bye"

    def test_edit_file_read_before_edit_required(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        monkeypatch.setattr(file_ops, "_read_files", set())
        f = tmp_path / "unread.txt"
        f.write_text("hello world")
        result = json.loads(file_ops.edit_file({
            "path": str(f),
            "old_text": "world",
            "new_text": "python",
        }))
        assert "error" in result
        assert "read" in result["error"].lower()

    def test_edit_file_uniqueness_check(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        f = tmp_path / "dup.txt"
        f.write_text("hello world hello python hello")
        file_ops.read_file({"path": str(f)})
        result = json.loads(file_ops.edit_file({
            "path": str(f),
            "old_text": "hello",
            "new_text": "bye",
        }))
        assert "error" in result
        assert "3 times" in result["error"]
        assert result["occurrences"] == 3

    def test_edit_file_empty_old_text_rejected(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        f = tmp_path / "empty.txt"
        f.write_text("hello world")
        file_ops.read_file({"path": str(f)})
        result = json.loads(file_ops.edit_file({
            "path": str(f),
            "old_text": "",
            "new_text": "injected",
        }))
        assert "error" in result
        assert "empty" in result["error"].lower()
        # File must not be modified
        assert f.read_text() == "hello world"

    def test_grep_with_context(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        f = tmp_path / "ctx.txt"
        f.write_text("line1\nline2\nline3 TARGET line4\nline5\nline6\n")
        # S10: context lines only available in "content" output mode
        result = json.loads(file_ops.grep_files({
            "pattern": "TARGET",
            "path": str(tmp_path),
            "context": 1,
            "output_mode": "content",
        }))
        assert result["total"] >= 1
        first = result["results"][0]
        assert "before_context" in first
        assert "after_context" in first
        assert len(first["before_context"]) >= 1
        assert len(first["after_context"]) >= 1

    def test_grep_multiline(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        f = tmp_path / "multi.txt"
        f.write_text("start\nfunction foo() {\n  return 42;\n}\nend\n")
        result = json.loads(file_ops.grep_files({
            "pattern": r"function foo\(\) \{\s*return \d+;\s*\}",
            "path": str(tmp_path),
            "multiline": True,
        }))
        assert result["total"] >= 1


class TestShell:
    def test_is_readonly(self):
        assert shell._is_readonly("ls -la")
        assert shell._is_readonly("git status")
        assert shell._is_readonly("cat file.txt")
        assert not shell._is_readonly("rm -rf /")
        assert not shell._is_readonly("npm install")

    def test_chaining_detection(self):
        # Semicolon: splitter handles — ls readonly but rm not
        assert not shell._is_readonly("ls; rm -rf /")
        # Pipe: both cat and grep are readonly → all() returns True
        assert shell._is_readonly("cat file | grep pattern")
        # Backtick: injection pattern blocked
        assert not shell._is_readonly("echo `whoami`")
        # Dollar-paren: injection pattern blocked
        assert not shell._is_readonly("echo $(whoami)")

    def test_run_command(self):
        result = json.loads(shell.run_command({"command": "echo hello"}))
        assert result["exit_code"] == 0
        assert "hello" in result["output"]

    def test_run_command_background(self):
        result = json.loads(shell.run_command({
            "command": "echo background_test",
            "run_in_background": True,
        }))
        assert "job_id" in result
        assert result["status"] == "started"
        assert len(result["job_id"]) > 0
        # Wait for the background job to complete
        time.sleep(1)
        job = shell._background_jobs.get(result["job_id"])
        assert job is not None
        assert job["status"] == "completed"
        assert "background_test" in job["output"]


class TestCodeExec:
    def test_execute_python(self):
        result = json.loads(code_exec.execute_python({
            "code": "print(2 + 2)",
        }))
        assert result["exit_code"] == 0
        assert "4" in result["output"]

    def test_execute_python_error(self):
        result = json.loads(code_exec.execute_python({
            "code": "1/0",
        }))
        assert result["exit_code"] != 0
        assert "ZeroDivisionError" in result["output"]

    def test_execute_python_timeout(self):
        result = json.loads(code_exec.execute_python({
            "code": "import time; time.sleep(100)",
            "timeout": 1,
        }))
        assert "timed out" in result.get("error", "").lower() or result.get("exit_code") != 0

    def test_execute_python_empty_code(self):
        result = json.loads(code_exec.execute_python({"code": ""}))
        assert result["exit_code"] == 0

    def test_execute_python_syntax_error(self):
        result = json.loads(code_exec.execute_python({
            "code": "def foo(\n    pass",
        }))
        assert result["exit_code"] != 0

    def test_execute_python_large_output_truncation(self):
        # Generate output > 5000 chars
        result = json.loads(code_exec.execute_python({
            "code": "print('x' * 10000)",
        }))
        output = result.get("output", "")
        # Output must be truncated — either marked or capped in length
        assert len(output) <= 5100, f"Output not truncated: {len(output)} chars"

    def test_execute_python_stderr_captured(self):
        result = json.loads(code_exec.execute_python({
            "code": "import sys; sys.stderr.write('warning\\n')",
        }))
        assert "warning" in result.get("output", "")

    def test_execute_python_returns_json(self):
        result = code_exec.execute_python({"code": "print('hi')"})
        parsed = json.loads(result)
        assert "exit_code" in parsed
        assert "output" in parsed


class TestMathTools:
    def test_basic_math(self):
        result = json.loads(math_tools.calculator({"expression": "2 + 3 * 4"}))
        assert result["result"] == 14

    def test_functions(self):
        result = json.loads(math_tools.calculator({"expression": "sqrt(144)"}))
        assert result["result"] == 12.0

    def test_unsafe_eval_blocked(self):
        result = json.loads(math_tools.calculator({"expression": "__import__('os').system('ls')"}))
        assert "error" in result

    def test_trig(self):
        import math
        result = json.loads(math_tools.calculator({"expression": "sin(pi/2)"}))
        assert abs(result["result"] - 1.0) < 0.0001


class TestWebTools:
    def test_validate_url_safe(self):
        assert web_tools._validate_url("https://example.com") is None
        assert web_tools._validate_url("http://example.com") is None

    def test_validate_url_blocks_private(self):
        assert web_tools._validate_url("http://127.0.0.1") is not None
        assert web_tools._validate_url("http://localhost") is not None
        assert web_tools._validate_url("http://10.0.0.1") is not None

    def test_validate_url_blocks_non_http(self):
        assert web_tools._validate_url("ftp://example.com") is not None
        assert web_tools._validate_url("file:///etc/passwd") is not None


class TestInteractive:
    def test_ask_user_question_single(self, monkeypatch):
        monkeypatch.setattr("builtins.input", lambda _: "2")
        result = json.loads(interactive.ask_user_question({
            "question": "Pick one",
            "options": [
                {"label": "A", "description": "First option"},
                {"label": "B", "description": "Second option"},
                {"label": "C", "description": "Third option"},
            ],
        }))
        assert "selected" in result
        assert result["selected"]["label"] == "B"

    def test_ask_user_question_multi_select(self, monkeypatch):
        monkeypatch.setattr("builtins.input", lambda _: "1,3")
        result = json.loads(interactive.ask_user_question({
            "question": "Pick multiple",
            "options": [
                {"label": "A", "description": "First"},
                {"label": "B", "description": "Second"},
                {"label": "C", "description": "Third"},
            ],
            "multi_select": True,
        }))
        assert "selected" in result
        assert len(result["selected"]) == 2
        assert result["selected"][0]["label"] == "A"
        assert result["selected"][1]["label"] == "C"

    def test_ask_user_question_no_options(self):
        result = json.loads(interactive.ask_user_question({
            "question": "Pick one",
            "options": [],
        }))
        assert "error" in result

    def test_ask_user_question_empty_input(self, monkeypatch):
        monkeypatch.setattr("builtins.input", lambda _: "")
        result = json.loads(interactive.ask_user_question({
            "question": "Pick one",
            "options": [{"label": "A"}],
        }))
        assert "error" in result
        assert "No selection" in result["error"]

    def test_ask_user_question_invalid_number(self, monkeypatch):
        monkeypatch.setattr("builtins.input", lambda _: "99")
        result = json.loads(interactive.ask_user_question({
            "question": "Pick one",
            "options": [{"label": "A"}, {"label": "B"}],
        }))
        assert "error" in result
        assert "Invalid option" in result["error"]

    def test_read_memory_topic(self, tmp_path, monkeypatch):
        """Test read_memory_topic tool handler."""
        monkeypatch.chdir(tmp_path)
        memory_dir = tmp_path / ".mimo" / "memory"
        memory_dir.mkdir(parents=True)
        topic_file = memory_dir / "test_topic.md"
        topic_file.write_text("---\nname: test_topic\ndescription: A test\n---\nTopic content here")

        result_str = interactive.read_memory_topic({"topic_name": "test_topic"})
        assert "Topic content" in result_str

    def test_read_memory_topic_not_found(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        result = json.loads(interactive.read_memory_topic({"topic_name": "nonexistent"}))
        assert "not found" in str(result).lower() or "error" in str(result).lower()

    def test_read_memory_topic_no_topic_name(self):
        result = json.loads(interactive.read_memory_topic({}))
        assert "error" in result

    def test_interactive_get_tools(self):
        tools = interactive.get_tools()
        assert len(tools) == 2
        names = {t.name for t in tools}
        assert "ask_user_question" in names
        assert "read_memory_topic" in names


class TestMonitor:
    def test_monitor_start_stop_list(self, monkeypatch):
        monkeypatch.setattr(monitor, "_monitors", {})
        command = f'{sys.executable} -c "import time; time.sleep(30)"'

        # Start a monitor
        result = json.loads(monitor.monitor_start({
            "command": command,
            "description": "Test monitor",
        }))
        assert "job_id" in result
        assert result["status"] == "running"
        job_id = result["job_id"]

        # Brief wait for thread initialization
        time.sleep(0.3)

        # List monitors
        list_result = json.loads(monitor.monitor_list({}))
        assert list_result["active_monitors"] >= 1
        assert any(m["job_id"] == job_id for m in list_result["monitors"])

        # Stop monitor
        stop_result = json.loads(monitor.monitor_stop({"job_id": job_id}))
        assert stop_result["status"] == "stopped"

        # Verify cleaned up
        list_result = json.loads(monitor.monitor_list({}))
        assert list_result["active_monitors"] == 0

    def test_monitor_stop_nonexistent(self, monkeypatch):
        monkeypatch.setattr(monitor, "_monitors", {})
        result = json.loads(monitor.monitor_stop({"job_id": "nonexistent"}))
        assert "error" in result
        assert "not found" in result["error"].lower()

    def test_monitor_start_no_command(self, monkeypatch):
        monkeypatch.setattr(monitor, "_monitors", {})
        result = json.loads(monitor.monitor_start({
            "command": "",
            "description": "Empty",
        }))
        assert "error" in result


class TestWebToolsDeep:
    """Tests for web_search and web_fetch with mocked HTTP layer."""

    def test_web_search_success(self):
        """Mock DuckDuckGo HTML response, verify results parsed correctly."""
        mock_html = """
        <html><body>
        <a class="result__a" href="https://example.com/result1">Test Title One</a>
        <a class="result__snippet">This is the first result snippet text.</a>
        <a class="result__a" href="https://example.com/result2">Test Title Two</a>
        <a class="result__snippet">This is the second result snippet text.</a>
        </body></html>
        """
        mock_resp = type("Response", (), {
            "text": mock_html,
            "status_code": 200,
            "raise_for_status": lambda self: None,
        })()
        with patch("requests.get", return_value=mock_resp):
            result = json.loads(web_tools.web_search({"query": "test query"}))
        assert result["query"] == "test query"
        assert result["count"] == 2
        assert result["results"][0]["title"] == "Test Title One"
        assert result["results"][0]["url"] == "https://example.com/result1"
        assert "first result snippet" in result["results"][0]["snippet"]
        assert result["results"][1]["title"] == "Test Title Two"

    def test_web_search_empty_query(self):
        """Empty query should still succeed (DuckDuckGo handles it)."""
        mock_resp = type("Response", (), {
            "text": "<html><body></body></html>",
            "status_code": 200,
            "raise_for_status": lambda self: None,
        })()
        with patch("requests.get", return_value=mock_resp):
            result = json.loads(web_tools.web_search({"query": ""}))
        assert result["query"] == ""
        assert result["count"] == 0

    def test_web_search_network_error(self):
        """Mock requests.get to raise, verify error handling."""
        import requests as req_lib
        with patch("requests.get", side_effect=req_lib.ConnectionError("Network unreachable")):
            result = json.loads(web_tools.web_search({"query": "test"}))
        assert "error" in result
        assert "Network unreachable" in result["error"]

    def test_web_search_empty_results(self):
        """Mock empty HTML, verify empty results list."""
        mock_resp = type("Response", (), {
            "text": "<html><body><p>No results here</p></body></html>",
            "status_code": 200,
            "raise_for_status": lambda self: None,
        })()
        with patch("requests.get", return_value=mock_resp):
            result = json.loads(web_tools.web_search({"query": "nonexistent"}))
        assert result["count"] == 0
        assert result["results"] == []

    def test_web_fetch_success(self, tmp_path, monkeypatch):
        """Mock HTTP response with HTML, verify content extraction."""
        monkeypatch.setattr(doc_tools, "_ALLOWED_WRITE_DIR", tmp_path)
        monkeypatch.chdir(tmp_path)
        mock_html = "<html><head><title>Test</title></head><body><p>Hello World</p><script>var x=1;</script></body></html>"
        mock_resp = type("Response", (), {
            "text": mock_html,
            "status_code": 200,
            "headers": {"content-type": "text/html"},
            "raise_for_status": lambda self: None,
            "close": lambda self: None,
            "iter_content": lambda self, chunk_size: [mock_html.encode("utf-8")],
        })()
        with patch("requests.get", return_value=mock_resp):
            result = json.loads(web_tools.web_fetch({"url": "https://example.com"}))
        assert result["url"] == "https://example.com"
        assert result["status"] == 200
        assert "Hello World" in result["content"]
        # Script tags should be stripped
        assert "var x=1" not in result["content"]

    def test_web_fetch_large_response(self, tmp_path, monkeypatch):
        """Mock response exceeding MAX_RESPONSE_BYTES, verify truncation."""
        monkeypatch.chdir(tmp_path)
        large_content = b"x" * (web_tools.MAX_RESPONSE_BYTES + 1000)

        def mock_iter(chunk_size):
            # Yield chunks that exceed MAX_RESPONSE_BYTES
            yield large_content

        mock_resp = type("Response", (), {
            "text": large_content.decode("utf-8", errors="replace"),
            "status_code": 200,
            "headers": {"content-type": "text/html"},
            "raise_for_status": lambda self: None,
            "close": lambda self: None,
            "iter_content": lambda self, chunk_size: mock_iter(chunk_size),
        })()
        with patch("requests.get", return_value=mock_resp):
            result = json.loads(web_tools.web_fetch({"url": "https://example.com"}))
        assert "truncated" in result["content"].lower() or "truncated" in result.get("content", "").lower() or len(result.get("content", "")) <= web_tools.MAX_RESPONSE_BYTES + 200

    def test_web_fetch_network_error(self, tmp_path, monkeypatch):
        """Mock requests.get to raise, verify error handling."""
        monkeypatch.chdir(tmp_path)
        # S14: clear cache to prevent stale cached results
        monkeypatch.setattr(web_tools, "_fetch_cache", {})
        import requests as req_lib
        with patch("requests.get", side_effect=req_lib.ConnectionError("Connection refused")):
            result = json.loads(web_tools.web_fetch({"url": "https://example.com"}))
        assert "error" in result
        assert "Connection refused" in result["error"]

    def test_web_fetch_non_html(self, tmp_path, monkeypatch):
        """Mock response with text/plain content type."""
        monkeypatch.chdir(tmp_path)
        text_content = "This is plain text content."
        mock_resp = type("Response", (), {
            "text": text_content,
            "status_code": 200,
            "headers": {"content-type": "text/plain"},
            "raise_for_status": lambda self: None,
            "close": lambda self: None,
            "iter_content": lambda self, chunk_size: [text_content.encode("utf-8")],
        })()
        with patch("requests.get", return_value=mock_resp):
            result = json.loads(web_tools.web_fetch({"url": "https://example.com/file.txt"}))
        assert result["url"] == "https://example.com/file.txt"
        assert "This is plain text content." in result["content"]

    def test_web_fetch_timeout(self, tmp_path, monkeypatch):
        """Mock requests.get to raise Timeout, verify error."""
        monkeypatch.chdir(tmp_path)
        # S14: clear cache to prevent stale cached results
        monkeypatch.setattr(web_tools, "_fetch_cache", {})
        import requests as req_lib
        with patch("requests.get", side_effect=req_lib.Timeout("Request timed out")):
            result = json.loads(web_tools.web_fetch({"url": "https://example.com"}))
        assert "error" in result
        assert "timed out" in result["error"].lower() or "timeout" in result["error"].lower()


class TestMonitorDeep:
    """Deeper tests for monitor process lifecycle."""

    def test_monitor_stream_reader(self, monkeypatch):
        """Start a monitor with python print, verify output is captured."""
        monkeypatch.setattr(monitor, "_monitors", {})
        # Use -u for unbuffered output on Windows
        command = f'{sys.executable} -u -c "print(\'hello\'); import time; time.sleep(10)"'
        result = json.loads(monitor.monitor_start({
            "command": command,
            "description": "Stream reader test",
        }))
        assert "job_id" in result
        job_id = result["job_id"]

        # Wait for output to be captured (longer wait for Windows)
        time.sleep(2.0)

        # Verify output was captured
        with monitor._monitors_lock:
            mon = monitor._monitors[job_id]
        lines = mon.get_lines(10)
        assert any("hello" in line for line in lines), f"Expected 'hello' in lines, got: {lines}"

        # Stop
        stop_result = json.loads(monitor.monitor_stop({"job_id": job_id}))
        assert stop_result["status"] == "stopped"
        assert stop_result["lines_captured"] >= 1

    def test_monitor_filter_pattern(self, monkeypatch):
        """Start monitor with filter_pattern, verify only matching lines captured."""
        monkeypatch.setattr(monitor, "_monitors", {})
        command = f'{sys.executable} -u -c "print(\'info line\'); print(\'error: something\'); print(\'info line2\'); print(\'error: another\')"'  # noqa: E501
        result = json.loads(monitor.monitor_start({
            "command": command,
            "description": "Filter test",
            "filter_pattern": "error",
        }))
        job_id = result["job_id"]

        # Wait for process to finish and output to be read
        time.sleep(1.5)

        with monitor._monitors_lock:
            mon = monitor._monitors[job_id]
        lines = mon.get_lines(10)
        # Only lines matching "error" should be captured
        for line in lines:
            assert "error" in line, f"Non-matching line captured: {line}"
        assert len(lines) >= 1

        # Cleanup
        monitor.monitor_stop({"job_id": job_id})

    def test_monitor_process_termination(self, monkeypatch):
        """Start monitor, stop it, verify process is killed."""
        monkeypatch.setattr(monitor, "_monitors", {})
        command = f'{sys.executable} -c "import time; time.sleep(30)"'
        result = json.loads(monitor.monitor_start({
            "command": command,
            "description": "Termination test",
        }))
        job_id = result["job_id"]
        time.sleep(0.5)

        # Get process handle
        with monitor._monitors_lock:
            mon = monitor._monitors[job_id]
        process = mon.process
        assert process is not None
        assert process.poll() is None  # Process is running

        # Stop
        stop_result = json.loads(monitor.monitor_stop({"job_id": job_id}))
        assert stop_result["status"] == "stopped"

        # Process should be terminated
        time.sleep(0.3)
        assert process.poll() is not None  # Process has exited

    def test_monitor_cleanup_on_error(self, monkeypatch):
        """Start monitor with invalid command, verify cleanup."""
        monkeypatch.setattr(monitor, "_monitors", {})
        result = json.loads(monitor.monitor_start({
            "command": "nonexistent_command_xyz_12345",
            "description": "Error test",
        }))
        # Should either succeed (process starts then fails) or return error
        if "job_id" in result:
            job_id = result["job_id"]
            time.sleep(1.0)
            # The monitor should have captured the error
            with monitor._monitors_lock:
                mon = monitor._monitors.get(job_id)
            if mon:
                assert "error" in mon.status or mon.status.startswith("exited")
                monitor.monitor_stop({"job_id": job_id})
        else:
            assert "error" in result

    def test_monitor_list_shows_details(self, monkeypatch):
        """Start monitor, verify list shows command/description/status."""
        monkeypatch.setattr(monitor, "_monitors", {})
        command = f'{sys.executable} -c "import time; time.sleep(30)"'
        start_result = json.loads(monitor.monitor_start({
            "command": command,
            "description": "Detail list test",
        }))
        job_id = start_result["job_id"]
        time.sleep(0.3)

        list_result = json.loads(monitor.monitor_list({}))
        assert list_result["active_monitors"] >= 1

        found = [m for m in list_result["monitors"] if m["job_id"] == job_id]
        assert len(found) == 1
        mon_info = found[0]
        assert mon_info["command"] == command
        assert mon_info["description"] == "Detail list test"
        assert mon_info["status"] == "running"

        # Cleanup
        monitor.monitor_stop({"job_id": job_id})


class TestDocToolsDeep:
    """Tests for create_doc and create_spreadsheet with various data types."""

    def test_create_doc_markdown(self, tmp_path, monkeypatch):
        """Create markdown doc, verify file content."""
        monkeypatch.setattr(doc_tools, "_ALLOWED_WRITE_DIR", tmp_path)
        result = json.loads(doc_tools.create_doc({
            "title": "Test Report",
            "content": "This is the body of the report.",
            "format": "markdown",
            "output_dir": str(tmp_path),
        }))
        assert result["status"] == "created"
        assert result["format"] == "markdown"

        path = result["path"]
        assert path.endswith(".md")
        content = open(path, encoding="utf-8").read()
        assert "# Test Report" in content
        assert "This is the body of the report." in content

    def test_create_doc_txt(self, tmp_path, monkeypatch):
        """Create txt doc, verify format."""
        monkeypatch.setattr(doc_tools, "_ALLOWED_WRITE_DIR", tmp_path)
        result = json.loads(doc_tools.create_doc({
            "title": "Notes",
            "content": "Some text content here.",
            "format": "txt",
            "output_dir": str(tmp_path),
        }))
        assert result["status"] == "created"
        assert result["format"] == "txt"

        path = result["path"]
        assert path.endswith(".txt")
        content = open(path, encoding="utf-8").read()
        assert "Notes" in content
        assert "=====" in content
        assert "Some text content here." in content

    def test_create_spreadsheet_dict_rows(self, tmp_path, monkeypatch):
        """Data with dict rows (headers from keys)."""
        monkeypatch.setattr(doc_tools, "_ALLOWED_WRITE_DIR", tmp_path)
        data = [
            {"name": "Alice", "age": "30", "city": "NYC"},
            {"name": "Bob", "age": "25", "city": "LA"},
        ]
        result = json.loads(doc_tools.create_spreadsheet({
            "title": "People",
            "data": data,
            "output_dir": str(tmp_path),
        }))
        assert result["status"] == "created"
        assert result["rows"] == 2

        path = result["path"]
        assert path.endswith(".csv")
        content = open(path, encoding="utf-8").read()
        assert "name" in content
        assert "Alice" in content
        assert "Bob" in content
        assert "NYC" in content

    def test_create_spreadsheet_list_rows(self, tmp_path, monkeypatch):
        """Data with list rows (first row = headers)."""
        monkeypatch.setattr(doc_tools, "_ALLOWED_WRITE_DIR", tmp_path)
        data = [
            ["Name", "Score"],
            ["Alice", "95"],
            ["Bob", "87"],
        ]
        result = json.loads(doc_tools.create_spreadsheet({
            "title": "Scores",
            "data": data,
            "output_dir": str(tmp_path),
        }))
        assert result["status"] == "created"
        assert result["rows"] == 3

        content = open(result["path"], encoding="utf-8").read()
        assert "Name" in content
        assert "Score" in content
        assert "Alice" in content
        assert "95" in content

    def test_create_spreadsheet_mixed_data(self, tmp_path, monkeypatch):
        """Data with int/float/str values."""
        monkeypatch.setattr(doc_tools, "_ALLOWED_WRITE_DIR", tmp_path)
        data = [
            ["Item", "Price", "Qty"],
            ["Widget", 1.5, 100],
            ["Gadget", 25.99, 5],
        ]
        result = json.loads(doc_tools.create_spreadsheet({
            "title": "Inventory",
            "data": data,
            "output_dir": str(tmp_path),
        }))
        assert result["status"] == "created"

        content = open(result["path"], encoding="utf-8").read()
        assert "Widget" in content
        assert "1.5" in content
        assert "25.99" in content
        assert "100" in content

    def test_create_doc_large_content(self, tmp_path, monkeypatch):
        """Create doc with 100KB content."""
        monkeypatch.setattr(doc_tools, "_ALLOWED_WRITE_DIR", tmp_path)
        large_content = "x" * 100_000
        result = json.loads(doc_tools.create_doc({
            "title": "Large Doc",
            "content": large_content,
            "format": "markdown",
            "output_dir": str(tmp_path),
        }))
        assert result["status"] == "created"

        path = result["path"]
        content = open(path, encoding="utf-8").read()
        assert "# Large Doc" in content
        assert len(content) >= 100_000

    def test_create_spreadsheet_special_chars(self, tmp_path, monkeypatch):
        """CSV with commas/quotes in data."""
        monkeypatch.setattr(doc_tools, "_ALLOWED_WRITE_DIR", tmp_path)
        data = [
            ["Name", "Description"],
            ["Item, Inc.", 'He said "hello"'],
            ["Other", "Normal text"],
        ]
        result = json.loads(doc_tools.create_spreadsheet({
            "title": "Specials",
            "data": data,
            "output_dir": str(tmp_path),
        }))
        assert result["status"] == "created"

        content = open(result["path"], encoding="utf-8").read()
        # csv module should properly quote fields with commas/quotes
        assert "Item" in content
        assert "Inc" in content
        assert "hello" in content


class TestShellDeep:
    """Deep coverage tests for shell.py."""

    def test_run_command_with_cwd(self, tmp_path):
        """Verify command runs and returns output with cwd info."""
        result = json.loads(shell.run_command({
            "command": f'{sys.executable} -c "import os; print(os.getcwd())"',
        }))
        assert result["exit_code"] == 0
        assert "output" in result
        # Output should contain a valid path
        assert len(result["output"].strip()) > 0

    def test_run_command_env_vars(self, monkeypatch):
        """Verify environment variables are passed to subprocess."""
        monkeypatch.setenv("MIMO_TEST_VAR", "hello_from_test")
        if sys.platform == "win32":
            result = json.loads(shell.run_command({
                "command": "echo %MIMO_TEST_VAR%",
            }))
        else:
            result = json.loads(shell.run_command({
                "command": "echo $MIMO_TEST_VAR",
            }))
        assert result["exit_code"] == 0
        assert "hello_from_test" in result["output"]

    def test_run_command_large_output(self):
        """Verify output >30000 chars is truncated."""
        result = json.loads(shell.run_command({
            "command": f'{sys.executable} -c "print(\'A\' * 50000)"',
        }))
        assert result["exit_code"] == 0
        assert "... [truncated]" in result["output"]
        # Total output should be around 30000 + truncation marker
        assert len(result["output"]) <= 31000

    def test_run_command_unicode_output(self):
        """Verify Unicode in command output is handled."""
        result = json.loads(shell.run_command({
            "command": f'{sys.executable} -c "print(\'Hello \\u4e16\\u754c \\u00e9\\u00e8\\u00ea\')"',
        }))
        assert result["exit_code"] == 0
        assert "Hello" in result["output"]

    def test_run_command_chaining_all_operators(self):
        """Verify all chaining operators are detected by _is_readonly."""
        # Semicolon: splitter handles — ls readonly but rm not
        assert not shell._is_readonly("ls; rm -rf /")
        # Pipe: splitter handles — both cat and grep are readonly
        assert shell._is_readonly("cat file | grep pattern")
        # Pipe with non-readonly: cat readonly but python not
        assert not shell._is_readonly("cat file | python -c 'x=1'")
        # Double ampersand: ls readonly but rm not
        assert not shell._is_readonly("ls && rm file")
        # Double pipe: both ls and echo are readonly
        assert shell._is_readonly("ls || echo failed")
        # Backtick: injection pattern blocked
        assert not shell._is_readonly("echo `whoami`")
        # Dollar-paren: injection pattern blocked
        assert not shell._is_readonly("echo $(whoami)")
        # Redirection: blocked by C1 fix
        assert not shell._is_readonly("echo hello > /tmp/out")

    def test_is_readonly_extended(self):
        """Test more readonly commands from READONLY_PREFIXES."""
        readonly_cmds = [
            "which python",
            "where python",
            "tree /f",
            "file test.txt",
            "du -sh .",
            "df -h",
            "python --version",
            "pip list",
            "node --version",
            "npm list",
            "uname -a",
            "hostname",
            "whoami",
            "date",
        ]
        for cmd in readonly_cmds:
            assert shell._is_readonly(cmd), f"{cmd!r} should be readonly"

    def test_is_readonly_negative_cases(self):
        """Commands that should NOT be readonly."""
        write_cmds = [
            "npm install express",
            "pip install requests",
            "rm file.txt",
            "git push origin main",
            "docker build .",
            "make install",
        ]
        for cmd in write_cmds:
            assert not shell._is_readonly(cmd), f"{cmd!r} should NOT be readonly"

    def test_background_job_output(self):
        """Start background job, wait, verify output is captured."""
        result = json.loads(shell.run_command({
            "command": f'{sys.executable} -c "import time; time.sleep(0.5); print(\'bg_done\')"',
            "run_in_background": True,
        }))
        assert result["status"] == "started"
        job_id = result["job_id"]
        # Wait for completion
        time.sleep(2)
        job = shell._background_jobs.get(job_id)
        assert job is not None
        assert job["status"] == "completed"
        assert "bg_done" in job["output"]
        assert job["exit_code"] == 0

    def test_background_job_max_limit(self, monkeypatch):
        """Verify MAX_BACKGROUND_JOBS cap."""
        # Pre-fill background jobs to the limit
        monkeypatch.setattr(shell, "_background_jobs", {})
        for i in range(shell.MAX_BACKGROUND_JOBS):
            shell._background_jobs[f"job-{i}"] = {
                "command": "sleep 100",
                "status": "running",
                "output": "",
                "exit_code": None,
            }
        result = json.loads(shell.run_command({
            "command": "echo should_fail",
            "run_in_background": True,
        }))
        assert "error" in result
        assert "Maximum background jobs" in result["error"]

    def test_run_command_timeout(self):
        """Verify command timeout is handled."""
        result = json.loads(shell.run_command({
            "command": f'{sys.executable} -c "import time; time.sleep(10)"',
            "timeout": 1,
        }))
        # Should either return a timeout error or a non-zero exit code
        if "error" in result:
            assert "timeout" in result["error"].lower() or "timed out" in result["error"].lower()
        else:
            assert result.get("exit_code") != 0

    def test_run_command_empty(self):
        """Verify empty command is handled."""
        result = json.loads(shell.run_command({"command": ""}))
        # Empty command should either succeed with exit code 0 or return an error
        if "error" in result:
            assert isinstance(result["error"], str)
        else:
            assert result["exit_code"] == 0

    def test_get_tools_returns_tooldef(self):
        """Verify get_tools returns proper ToolDef."""
        tools = shell.get_tools()
        assert len(tools) == 1
        tool = tools[0]
        assert tool.name == "run_command"
        assert tool.handler == shell.run_command
        assert "command" in tool.parameters["properties"]

    def test_background_job_error_handling(self):
        """Background job with failing command captures error."""
        result = json.loads(shell.run_command({
            "command": f'{sys.executable} -c "import sys; sys.exit(1)"',
            "run_in_background": True,
        }))
        assert result["status"] == "started"
        job_id = result["job_id"]
        time.sleep(2)
        job = shell._background_jobs.get(job_id)
        assert job is not None
        assert job["status"] == "completed"
        assert job["exit_code"] == 1

    def test_chaining_pattern_compiled(self):
        """Verify _CHAINING_PATTERN regex matches injection patterns."""
        # Backtick: command injection
        assert shell._CHAINING_PATTERN.search("`whoami`") is not None
        # Dollar-paren: command injection
        assert shell._CHAINING_PATTERN.search("$(whoami)") is not None
        # Redirection: prevents readonly bypass (C1 fix)
        assert shell._CHAINING_PATTERN.search(">") is not None
        # Safe command: no injection patterns
        assert shell._CHAINING_PATTERN.search("safe command") is None
        # Chaining operators (;, |, &&) are handled by splitter, not this pattern
        assert shell._CHAINING_PATTERN.search(";") is None
        assert shell._CHAINING_PATTERN.search("|") is None


class TestGrepOutputModes:
    """S10: Test grep output modes (files_with_matches, count) and parameters."""

    def test_grep_files_with_matches_mode(self, tmp_path, monkeypatch):
        """S10: output_mode='files_with_matches' returns file paths, not content."""
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        f1 = tmp_path / "a.txt"
        f1.write_text("hello world\nfoo bar\n")
        f2 = tmp_path / "b.txt"
        f2.write_text("hello again\nbaz qux\n")
        result = json.loads(file_ops.grep_files({
            "pattern": "hello",
            "path": str(tmp_path),
            "output_mode": "files_with_matches",
        }))
        assert "files" in result
        assert result["total"] == 2
        file_names = [os.path.basename(f) for f in result["files"]]
        assert "a.txt" in file_names
        assert "b.txt" in file_names

    def test_grep_count_mode(self, tmp_path, monkeypatch):
        """S10: output_mode='count' returns per-file match counts."""
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        f = tmp_path / "count.txt"
        f.write_text("hello\nhello\nhello\nworld\n")
        result = json.loads(file_ops.grep_files({
            "pattern": "hello",
            "path": str(tmp_path),
            "output_mode": "count",
        }))
        assert "counts" in result
        assert result["total_files"] >= 1
        # The file should have 3 matches
        count_values = list(result["counts"].values())
        assert any(c == 3 for c in count_values)

    def test_grep_head_limit(self, tmp_path, monkeypatch):
        """S10: head_limit=5 caps results to 5 entries."""
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        f = tmp_path / "many.txt"
        f.write_text("\n".join([f"line {i} target" for i in range(20)]) + "\n")
        result = json.loads(file_ops.grep_files({
            "pattern": "target",
            "path": str(tmp_path),
            "output_mode": "content",
            "head_limit": 5,
        }))
        assert len(result["results"]) == 5
        assert result["total"] == 20
        assert result["truncated"] is True

    def test_grep_offset(self, tmp_path, monkeypatch):
        """S10: offset=2 skips the first 2 results."""
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        f = tmp_path / "offset.txt"
        f.write_text("\n".join([f"line {i} target" for i in range(10)]) + "\n")
        result = json.loads(file_ops.grep_files({
            "pattern": "target",
            "path": str(tmp_path),
            "output_mode": "content",
            "offset": 2,
            "head_limit": 5,
        }))
        # Should skip first 2, return next 5
        assert len(result["results"]) == 5
        first_line = result["results"][0].get("line", 0)
        assert first_line == 3  # line 3 (0-indexed offset 2 means starting at line 3)

    def test_grep_case_insensitive(self, tmp_path, monkeypatch):
        """S10: -i=True enables case-insensitive matching."""
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        f = tmp_path / "case.txt"
        f.write_text("Hello World\nhello world\nHELLO WORLD\n")
        result = json.loads(file_ops.grep_files({
            "pattern": "hello",
            "path": str(tmp_path),
            "-i": True,
            "output_mode": "content",
        }))
        assert result["total"] == 3


class TestGlobGitignore:
    """S11: glob with respect_gitignore filtering."""

    def test_glob_respects_gitignore(self, tmp_path, monkeypatch):
        """S11: respect_gitignore=True filters out gitignored files."""
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        # Create .gitignore
        gitignore = tmp_path / ".gitignore"
        gitignore.write_text("*.log\ncache/\n")
        # Create files
        (tmp_path / "keep.py").touch()
        (tmp_path / "debug.log").touch()
        (tmp_path / "error.log").touch()
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        (cache_dir / "data.txt").touch()

        result = json.loads(file_ops.glob_files({
            "pattern": str(tmp_path / "**" / "*"),
            "respect_gitignore": True,
        }))
        match_names = [os.path.basename(m) for m in result["matches"]]
        assert "keep.py" in match_names
        assert "debug.log" not in match_names
        assert "error.log" not in match_names

    def test_glob_without_gitignore_shows_all(self, tmp_path, monkeypatch):
        """S11: respect_gitignore=False (default) shows all files."""
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        gitignore = tmp_path / ".gitignore"
        gitignore.write_text("*.log\n")
        (tmp_path / "keep.py").touch()
        (tmp_path / "debug.log").touch()

        result = json.loads(file_ops.glob_files({
            "pattern": str(tmp_path / "*"),
        }))
        match_names = [os.path.basename(m) for m in result["matches"]]
        assert "keep.py" in match_names
        assert "debug.log" in match_names

    def test_load_gitignore_patterns(self, tmp_path):
        """S11: _load_gitignore_patterns reads patterns from .gitignore."""
        gitignore = tmp_path / ".gitignore"
        gitignore.write_text("*.log\n# comment\ncache/\n\n*.tmp\n")
        patterns = file_ops._load_gitignore_patterns(str(tmp_path))
        assert "*.log" in patterns
        assert "cache/" in patterns
        assert "*.tmp" in patterns
        assert "# comment" not in patterns

    def test_matches_gitignore(self):
        """S11: _matches_gitignore matches paths against patterns."""
        patterns = ["*.log", "build/*.o"]
        assert file_ops._matches_gitignore("debug.log", patterns)
        assert file_ops._matches_gitignore("build/main.o", patterns)
        assert not file_ops._matches_gitignore("src/main.py", patterns)
        assert not file_ops._matches_gitignore("keep.py", patterns)


class TestWebFetchCache:
    """S14: web_fetch caching behavior."""

    def test_web_fetch_cache_hit(self, tmp_path, monkeypatch):
        """S14: Second call to same URL should use cache."""
        monkeypatch.chdir(tmp_path)
        from mimo_harness.tools import web_tools

        mock_html = "<html><body><p>Cached content</p></body></html>"
        call_count = [0]

        def mock_get(*args, **kwargs):
            call_count[0] += 1
            return type("Response", (), {
                "text": mock_html,
                "status_code": 200,
                "headers": {"content-type": "text/html"},
                "raise_for_status": lambda self: None,
                "close": lambda self: None,
                "iter_content": lambda self, chunk_size: [mock_html.encode("utf-8")],
            })()

        # Clear cache if it exists
        if hasattr(web_tools, '_fetch_cache'):
            web_tools._fetch_cache.clear()

        with patch("requests.get", side_effect=mock_get):
            result1 = json.loads(web_tools.web_fetch({"url": "https://example.com/cached"}))
            result2 = json.loads(web_tools.web_fetch({"url": "https://example.com/cached"}))

        assert "Cached content" in result1["content"]
        assert "Cached content" in result2["content"]
        # Second call should hit cache, not trigger another HTTP request
        assert call_count[0] == 1, f"Expected 1 HTTP call (cache hit), got {call_count[0]}"


class TestShellWrapperStripping:
    """S8: _strip_wrappers removes known wrapper prefixes."""

    def test_strip_timeout(self):
        """S8: 'timeout 30 git status' -> 'git status'."""
        assert shell._strip_wrappers("timeout 30 git status") == "git status"

    def test_strip_nice(self):
        """S8: 'nice -n 10 ls' -> 'ls'."""
        assert shell._strip_wrappers("nice -n 10 ls") == "ls"

    def test_strip_time(self):
        """S8: 'time ls -la' -> 'ls -la'."""
        assert shell._strip_wrappers("time ls -la") == "ls -la"

    def test_strip_nohup(self):
        """S8: 'nohup python server.py' -> 'python server.py'."""
        assert shell._strip_wrappers("nohup python server.py") == "python server.py"

    def test_strip_stdbuf(self):
        """S8: 'stdbuf -oL tail -f log' -> 'tail -f log'."""
        result = shell._strip_wrappers("stdbuf -oL tail -f log")
        assert result == "tail -f log"

    def test_no_wrapper_returns_unchanged(self):
        """S8: Plain command without wrapper returns unchanged."""
        assert shell._strip_wrappers("git status") == "git status"

    def test_readonly_after_stripping(self):
        """S8: _is_readonly returns True for wrapped readonly commands."""
        assert shell._is_readonly("timeout 30 git status")
        assert shell._is_readonly("nice -n 10 ls -la")


class TestShellReadonlyExtended:
    """S19: Extended readonly prefixes."""

    def test_grep_is_readonly(self):
        """S19: 'grep foo file.txt' is readonly."""
        assert shell._is_readonly("grep foo file.txt")

    def test_find_is_readonly(self):
        """S19: 'find . -name \"*.py\"' is readonly."""
        assert shell._is_readonly('find . -name "*.py"')

    def test_stat_is_readonly(self):
        """S19: 'stat file.txt' is readonly."""
        assert shell._is_readonly("stat file.txt")

    def test_env_is_readonly(self):
        """S19: 'env' is readonly."""
        assert shell._is_readonly("env")

    def test_printenv_is_readonly(self):
        """S19: 'printenv PATH' is readonly."""
        assert shell._is_readonly("printenv PATH")

    def test_realpath_is_readonly(self):
        """S19: 'realpath file.txt' is readonly."""
        assert shell._is_readonly("realpath file.txt")

    def test_basename_is_readonly(self):
        """S19: 'basename /path/to/file' is readonly."""
        assert shell._is_readonly("basename /path/to/file")

    def test_dirname_is_readonly(self):
        """S19: 'dirname /path/to/file' is readonly."""
        assert shell._is_readonly("dirname /path/to/file")

    def test_sort_is_readonly(self):
        """S19: 'sort file.txt' is readonly."""
        assert shell._is_readonly("sort file.txt")

    def test_uniq_is_readonly(self):
        """S19: 'uniq file.txt' is readonly."""
        assert shell._is_readonly("uniq file.txt")


class TestShellOutputSpillover:
    """S5: Large output saved to disk via _spill_output."""

    def test_spill_output_saves_to_file(self, tmp_path, monkeypatch):
        """S5: _spill_output saves oversized output to a file."""
        monkeypatch.chdir(tmp_path)
        large_output = "x" * 50000
        result = shell._spill_output(large_output)
        assert "[Full output saved to:" in result
        # Extract the file path from the result
        marker = "[Full output saved to: "
        start = result.index(marker) + len(marker)
        end = result.index("]", start)
        saved_path = result[start:end]
        assert os.path.exists(saved_path)
        with open(saved_path, encoding="utf-8") as f:
            content = f.read()
        assert len(content) == 50000

    def test_spill_output_contains_preview(self, tmp_path, monkeypatch):
        """S5: _spill_output returns a preview of the output."""
        monkeypatch.chdir(tmp_path)
        large_output = "A" * 10000 + "MIDDLE" + "B" * 10000
        result = shell._spill_output(large_output)
        assert "... [truncated] ..." in result
        # Should contain start and end of output
        assert "A" * 10 in result
        assert "B" * 10 in result


class TestSplitCompoundCommand:
    def test_simple_command(self):
        assert shell._split_compound_command("ls -la") == ["ls -la"]

    def test_semicolon_split(self):
        parts = shell._split_compound_command("ls; rm file")
        assert len(parts) == 2
        assert parts[0] == "ls"
        assert parts[1] == "rm file"

    def test_and_split(self):
        parts = shell._split_compound_command("echo a && echo b")
        assert len(parts) == 2

    def test_or_split(self):
        parts = shell._split_compound_command("cmd1 || cmd2")
        assert len(parts) == 2

    def test_pipe_split(self):
        parts = shell._split_compound_command("cat file | grep pattern")
        assert len(parts) == 2

    def test_single_quotes_preserve(self):
        parts = shell._split_compound_command("echo 'a && b'")
        assert len(parts) == 1
        assert "a && b" in parts[0]

    def test_double_quotes_preserve(self):
        parts = shell._split_compound_command('echo "a | b"')
        assert len(parts) == 1

    def test_empty_input(self):
        assert shell._split_compound_command("") == []

    def test_whitespace_only(self):
        assert shell._split_compound_command("   ") == []


class TestScrubEnv:
    def test_removes_api_key(self, monkeypatch):
        monkeypatch.setenv("MY_API_KEY", "secret")
        env = shell._scrub_env()
        assert "MY_API_KEY" not in env

    def test_removes_secret(self, monkeypatch):
        monkeypatch.setenv("APP_SECRET", "topsecret")
        env = shell._scrub_env()
        assert "APP_SECRET" not in env

    def test_removes_token(self, monkeypatch):
        monkeypatch.setenv("AUTH_TOKEN", "bearer_abc")
        env = shell._scrub_env()
        assert "AUTH_TOKEN" not in env

    def test_removes_password(self, monkeypatch):
        monkeypatch.setenv("DB_PASSWORD", "pass123")
        env = shell._scrub_env()
        assert "DB_PASSWORD" not in env

    def test_preserves_normal_vars(self, monkeypatch):
        monkeypatch.setenv("MIMO_SAFE_VAR", "safe_value")
        env = shell._scrub_env()
        assert env.get("MIMO_SAFE_VAR") == "safe_value"

    def test_case_insensitive(self, monkeypatch):
        monkeypatch.setenv("my_api_key_lower", "secret")
        env = shell._scrub_env()
        assert "my_api_key_lower" not in env

    def test_does_not_mutate_os_environ(self, monkeypatch):
        monkeypatch.setenv("TEST_SCRUB_KEY", "value")
        shell._scrub_env()
        assert os.environ.get("TEST_SCRUB_KEY") == "value"
