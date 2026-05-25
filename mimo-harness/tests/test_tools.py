"""Tests for individual tools (Ch3 patterns)."""

import pytest
import json
import os
import sys
import tempfile
import time
from mimo_harness.tools import file_ops, shell, code_exec, math_tools, web_tools, interactive, monitor


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
        result = json.loads(file_ops.grep_files({
            "pattern": "hello",
            "path": str(tmp_path),
        }))
        assert result["total"] == 2

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
        result = json.loads(file_ops.grep_files({
            "pattern": "TARGET",
            "path": str(tmp_path),
            "context": 1,
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
        assert not shell._is_readonly("ls; rm -rf /")
        assert not shell._is_readonly("cat file | grep pattern")
        assert not shell._is_readonly("echo `whoami`")
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
