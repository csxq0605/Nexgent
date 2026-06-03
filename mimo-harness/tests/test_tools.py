"""Tests for individual tools (Ch3 patterns)."""

import pytest
import json
import os
import sys
import time
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
    def test_run_command(self):
        result = json.loads(shell.run_command({"command": "echo hello"}))
        assert result["exit_code"] == 0
        assert "hello" in result["output"]


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
    """Tests for web_search and web_fetch with real HTTP requests."""

    def test_web_search_success(self):
        """Real search request, verify results structure."""
        result = json.loads(web_tools.web_search({"query": "Python programming language"}))
        assert "query" in result
        assert result["query"] == "Python programming language"
        # Either results or error (network may be unavailable)
        if "error" in result:
            assert isinstance(result["error"], str)
        else:
            assert isinstance(result["results"], list)
            assert result["count"] >= 0
            if result["count"] > 0:
                assert "title" in result["results"][0]
                assert "url" in result["results"][0]

    def test_web_search_empty_query(self):
        """Empty query should return valid structure."""
        result = json.loads(web_tools.web_search({"query": ""}))
        assert "query" in result
        assert result["query"] == ""
        # Either results or error
        assert "results" in result or "error" in result

    def test_web_fetch_success(self, tmp_path, monkeypatch):
        """Real HTTP request to example.com, verify content extraction."""
        monkeypatch.setattr(doc_tools, "_ALLOWED_WRITE_DIR", tmp_path)
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr(web_tools, "_fetch_cache", {})
        result = json.loads(web_tools.web_fetch({"url": "http://example.com"}))
        assert "url" in result
        assert result["url"] == "http://example.com"
        assert result["status"] == 200
        assert len(result["content"]) > 0

    def test_web_fetch_caching(self, tmp_path, monkeypatch):
        """Second fetch of same URL should return cached result."""
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr(web_tools, "_fetch_cache", {})
        result1 = json.loads(web_tools.web_fetch({"url": "http://example.com"}))
        assert "content" in result1
        result2 = json.loads(web_tools.web_fetch({"url": "http://example.com"}))
        assert result1["content"] == result2["content"]

    def test_web_fetch_network_error(self, tmp_path, monkeypatch):
        """Connection to refused port, verify error handling."""
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr(web_tools, "_fetch_cache", {})
        # Use a URL that will fail DNS resolution or connection refused
        result = json.loads(web_tools.web_fetch({"url": "http://192.0.2.1:1/nonexistent"}))
        assert "error" in result

    def test_web_fetch_url_validation_blocks_private(self, tmp_path, monkeypatch):
        """SSRF protection blocks private IPs."""
        monkeypatch.chdir(tmp_path)
        result = json.loads(web_tools.web_fetch({"url": "http://127.0.0.1/admin"}))
        assert "error" in result
        assert "private" in result["error"].lower() or "loopback" in result["error"].lower() or "restricted" in result["error"].lower() or "blocked" in result["error"].lower()

    def test_web_fetch_url_validation_blocks_localhost(self, tmp_path, monkeypatch):
        """SSRF protection blocks localhost."""
        monkeypatch.chdir(tmp_path)
        result = json.loads(web_tools.web_fetch({"url": "http://localhost/admin"}))
        assert "error" in result

    def test_web_fetch_url_validation_blocks_file_scheme(self, tmp_path, monkeypatch):
        """SSRF protection blocks file:// scheme."""
        monkeypatch.chdir(tmp_path)
        result = json.loads(web_tools.web_fetch({"url": "file:///etc/passwd"}))
        assert "error" in result
        assert "scheme" in result["error"].lower() or "not allowed" in result["error"].lower()


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


class TestScrubEnv:
    """Tests for _scrub_env credential scrubbing."""

    def test_removes_api_key(self, monkeypatch):
        monkeypatch.setenv("MY_API_KEY", "secret123")
        env = shell._scrub_env()
        assert "MY_API_KEY" not in env

    def test_removes_secret(self, monkeypatch):
        monkeypatch.setenv("APP_SECRET", "value")
        env = shell._scrub_env()
        assert "APP_SECRET" not in env

    def test_removes_token(self, monkeypatch):
        monkeypatch.setenv("AUTH_TOKEN", "tok123")
        env = shell._scrub_env()
        assert "AUTH_TOKEN" not in env

    def test_removes_password(self, monkeypatch):
        monkeypatch.setenv("DB_PASSWORD", "pass")
        env = shell._scrub_env()
        assert "DB_PASSWORD" not in env

    def test_removes_credential(self, monkeypatch):
        monkeypatch.setenv("AWS_CREDENTIAL", "val")
        env = shell._scrub_env()
        assert "AWS_CREDENTIAL" not in env

    def test_removes_database_url(self, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", "postgres://admin:pass@db")
        env = shell._scrub_env()
        assert "DATABASE_URL" not in env

    def test_preserves_safe_keys(self, monkeypatch):
        monkeypatch.setenv("PATH", "/usr/bin")
        monkeypatch.setenv("HOME", "/home/user")
        monkeypatch.setenv("LANG", "en_US.UTF-8")
        env = shell._scrub_env()
        assert "PATH" in env
        assert "HOME" in env
        assert "LANG" in env

    def test_preserves_partial_match(self, monkeypatch):
        """Keys containing pattern substring but not as word boundary should still be removed."""
        monkeypatch.setenv("MY_API_KEY_ID", "val")
        env = shell._scrub_env()
        # API_KEY pattern matches, so it should be removed
        assert "MY_API_KEY_ID" not in env


class TestSplitCompoundCommand:
    """Tests for _split_compound_command."""

    def test_double_ampersand(self):
        assert shell._split_compound_command("ls -la && echo done") == ["ls -la", "echo done"]

    def test_double_pipe(self):
        assert shell._split_compound_command("ls || echo fail") == ["ls", "echo fail"]

    def test_semicolon(self):
        assert shell._split_compound_command("cat file; rm -rf /") == ["cat file", "rm -rf /"]

    def test_pipe(self):
        assert shell._split_compound_command("ls | head -5") == ["ls", "head -5"]

    def test_single_command(self):
        assert shell._split_compound_command("ls -la") == ["ls -la"]

    def test_empty_command(self):
        assert shell._split_compound_command("") == []

    def test_respects_single_quotes(self):
        """Operators inside single quotes should not split."""
        result = shell._split_compound_command("echo 'a && b'")
        assert result == ["echo 'a && b'"]

    def test_respects_double_quotes(self):
        """Operators inside double quotes should not split."""
        result = shell._split_compound_command('echo "a && b"')
        assert result == ['echo "a && b"']

    def test_newline_separator(self):
        result = shell._split_compound_command("ls\necho done")
        assert result == ["ls", "echo done"]

    def test_multiple_operators(self):
        result = shell._split_compound_command("a && b || c ; d | e")
        assert result == ["a", "b", "c", "d", "e"]
