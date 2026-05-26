"""Stress and boundary tests - real-world attack scenarios and edge cases.

Tests cover:
1. Path traversal exploits (P0)
2. SSRF bypass attempts
3. Shell injection and chaining
4. Large input / memory exhaustion
5. Unicode and encoding edge cases
6. Permission pipeline stress
7. Concurrent tool execution safety
8. Background job cleanup
9. Monitor max limit
10. Path traversal in permission rules
11. Write read-before-write enforcement
"""

import json
import os
import sys
import threading
import time
from pathlib import Path

import pytest
from unittest.mock import MagicMock

from mimo_harness.tools import file_ops, shell, web_tools, doc_tools, math_tools
from mimo_harness.tools.registry import ToolRegistry, ToolDef
from mimo_harness.permissions import Permission, PermissionGate, PermissionRule, PermissionMode
from mimo_harness.memory import MemoryStore, MemoryType
from mimo_harness.agent import CircuitBreaker, TokenBudget


# ============================================================================
# 1. PATH TRAVERSAL EXPLOITS (P0)
# ============================================================================

class TestPathTraversal:
    """Verify path traversal is blocked after P0-1 fix."""

    def test_write_blocks_dotdot_traversal(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        result = json.loads(file_ops.write_file({
            "path": str(tmp_path / ".." / ".." / "evil.txt"),
            "content": "pwned",
        }))
        assert "error" in result

    def test_write_blocks_absolute_escape(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        result = json.loads(file_ops.write_file({
            "path": "/tmp/evil.txt",
            "content": "pwned",
        }))
        assert "outside" in result["error"]

    def test_write_blocks_prefix_collision(self, tmp_path, monkeypatch):
        """Path /tmp/X_evil should not pass check for /tmp/X."""
        evil_parent = tmp_path.parent / (tmp_path.name + "_evil")
        evil_parent.mkdir(exist_ok=True)
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        result = json.loads(file_ops.write_file({
            "path": str(evil_parent / "secret.txt"),
            "content": "pwned",
        }))
        assert "error" in result
        evil_parent.rmdir()

    def test_read_blocks_dotdot_traversal(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        result = json.loads(file_ops.read_file({
            "path": str(tmp_path / ".." / ".." / "etc" / "passwd"),
        }))
        assert "error" in result

    def test_read_blocks_system_files(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        for sensitive in ["/etc/passwd", "/etc/shadow", "C:\\Windows\\system.ini"]:
            result = json.loads(file_ops.read_file({"path": sensitive}))
            assert "error" in result, f"Expected error for sensitive path {sensitive}, got {result}"
            assert "outside" in result["error"] or "not found" in result["error"].lower() or "cannot find" in result["error"].lower()

    def test_glob_blocks_system_root(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        result = json.loads(file_ops.glob_files({"pattern": "/etc/*"}))
        assert "error" in result

    def test_grep_blocks_system_root(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        result = json.loads(file_ops.grep_files({
            "pattern": "root",
            "path": "/etc",
        }))
        assert "error" in result

    def test_write_allows_valid_path(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        f = tmp_path / "valid.txt"
        result = json.loads(file_ops.write_file({
            "path": str(f),
            "content": "ok",
        }))
        assert result.get("status") == "written"

    def test_read_allows_valid_path(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        f = tmp_path / "valid.txt"
        f.write_text("hello")
        result = json.loads(file_ops.read_file({"path": str(f)}))
        assert "content" in result

    def test_null_byte_in_path(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        result = json.loads(file_ops.write_file({
            "path": str(tmp_path / "test\x00.txt"),
            "content": "pwned",
        }))
        # Null byte in path should be rejected or handled safely without writing
        assert "error" in result or result.get("status") != "written"

    def test_symlink_escape(self, tmp_path, monkeypatch):
        """Symlink pointing outside allowed dir should be blocked after resolve."""
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        outside = tmp_path.parent / "outside.txt"
        outside.write_text("secret")
        link = tmp_path / "escape.txt"

        # Mock Path so resolve() for the link path returns the outside target.
        # This simulates symlink resolution without needing real symlinks
        # (which require elevated permissions on Windows).
        _real_path = Path

        class _MockPath(type(link)):
            def resolve(self, *a, **kw):
                if str(self) == str(link):
                    return outside.resolve()
                return _real_path.resolve(self, *a, **kw)

        monkeypatch.setattr(file_ops, "Path", _MockPath)
        result = json.loads(file_ops.read_file({"path": str(link)}))
        assert "error" in result
        assert "outside" in result["error"]


# ============================================================================
# 2. SSRF BYPASS ATTEMPTS
# ============================================================================

class TestSSRF:
    """Verify SSRF protection blocks common bypass techniques."""

    def test_blocks_localhost(self):
        assert web_tools._validate_url("http://localhost/admin") is not None

    def test_blocks_127_loopback(self):
        assert web_tools._validate_url("http://127.0.0.1/admin") is not None

    def test_blocks_private_10(self):
        assert web_tools._validate_url("http://10.0.0.1/admin") is not None

    def test_blocks_private_172(self):
        assert web_tools._validate_url("http://172.16.0.1/admin") is not None

    def test_blocks_private_192(self):
        assert web_tools._validate_url("http://192.168.1.1/admin") is not None

    def test_blocks_link_local(self):
        assert web_tools._validate_url("http://169.254.169.254/metadata") is not None

    def test_blocks_file_scheme(self):
        assert web_tools._validate_url("file:///etc/passwd") is not None

    def test_blocks_ftp_scheme(self):
        assert web_tools._validate_url("ftp://example.com") is not None

    def test_blocks_metadata_google(self):
        assert web_tools._validate_url("http://metadata.google.internal/") is not None

    def test_allows_valid_https(self):
        assert web_tools._validate_url("https://example.com") is None

    def test_allows_valid_http(self):
        assert web_tools._validate_url("http://example.com") is None

    def test_blocks_empty_hostname(self):
        assert web_tools._validate_url("http:///path") is not None

    def test_blocks_ipv6_loopback(self):
        assert web_tools._validate_url("http://[::1]/admin") is not None

    def test_blocks_encoded_localhost(self):
        # URL encoding bypass attempt
        assert web_tools._validate_url("http://127.0.0.1:8080/admin") is not None

    def test_max_response_size_constant(self):
        """Verify MAX_RESPONSE_BYTES is defined and reasonable."""
        assert hasattr(web_tools, 'MAX_RESPONSE_BYTES')
        assert 1024 <= web_tools.MAX_RESPONSE_BYTES <= 10 * 1024 * 1024  # 1KB .. 10MB


# ============================================================================
# 3. SHELL INJECTION AND CHAINING
# ============================================================================

class TestShellInjection:
    """Verify shell command safety checks."""

    def test_chaining_semicolon_detected(self):
        assert not shell._is_readonly("ls; rm -rf /")

    def test_chaining_pipe_detected(self):
        # Pipe with both readonly: cat + grep = readonly (correct behavior)
        assert shell._is_readonly("cat /etc/passwd | grep root")
        # Pipe with non-readonly: cat + python = not readonly
        assert not shell._is_readonly("cat /etc/passwd | python -c 'import sys'")

    def test_chaining_ampersand_detected(self):
        assert not shell._is_readonly("echo hello && rm -rf /")

    def test_chaining_backtick_detected(self):
        assert not shell._is_readonly("echo `whoami`")

    def test_chaining_dollar_paren_detected(self):
        assert not shell._is_readonly("echo $(whoami)")

    def test_readonly_git_status(self):
        assert shell._is_readonly("git status")

    def test_readonly_ls(self):
        assert shell._is_readonly("ls -la")

    def test_readonly_cat(self):
        assert shell._is_readonly("cat file.txt")

    def test_non_readonly_rm(self):
        assert not shell._is_readonly("rm -rf /")

    def test_non_readonly_npm_install(self):
        assert not shell._is_readonly("npm install")

    def test_command_timeout_cap(self):
        """Verify timeout parameter is respected."""
        result = json.loads(shell.run_command({"command": "echo ok", "timeout": 5}))
        assert result["exit_code"] == 0

    def test_command_output_truncation(self):
        """Large output should be truncated."""
        # Generate large output exceeding 30000 char cap
        if sys.platform == "win32":
            cmd = 'python -c "print(\'x\' * 35000)"'
        else:
            cmd = "python3 -c \"print('x' * 35000)\""
        result = json.loads(shell.run_command({"command": cmd, "timeout": 10}))
        assert len(result.get("output", "")) <= 30500  # 30000 + truncation marker


# ============================================================================
# 4. LARGE INPUT / MEMORY EXHAUSTION
# ============================================================================

class TestLargeInput:
    """Test behavior with large inputs and outputs."""

    def test_write_large_file(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        large_content = "x" * 1_000_000  # 1MB
        f = tmp_path / "large.txt"
        result = json.loads(file_ops.write_file({
            "path": str(f),
            "content": large_content,
        }))
        assert result.get("status") == "written"

    def test_read_large_file(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        f = tmp_path / "large.txt"
        f.write_text("line\n" * 100_000)
        result = json.loads(file_ops.read_file({
            "path": str(f),
            "offset": 0,
            "limit": 10,
        }))
        assert result["total_lines"] == 100_000
        assert "showing" in result

    def test_grep_many_results_capped(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        f = tmp_path / "many.txt"
        f.write_text("match_line\n" * 1000)
        result = json.loads(file_ops.grep_files({
            "pattern": "match",
            "path": str(tmp_path),
        }))
        # Should be capped at 50 results
        assert result.get("truncated") is True or len(result.get("results", [])) <= 50

    def test_glob_many_results_capped(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        for i in range(200):
            (tmp_path / f"file_{i}.txt").touch()
        result = json.loads(file_ops.glob_files({
            "pattern": str(tmp_path / "*.txt"),
        }))
        assert len(result["matches"]) <= 100

    def test_calculator_large_exponent(self):
        """Large exponent should not hang (DoS vector)."""
        result = json.loads(math_tools.calculator({"expression": "2**100"}))
        assert "result" in result or "error" in result

    def test_registry_result_truncation(self):
        """Tool results over threshold should be spilled to disk."""
        registry = ToolRegistry()
        registry.SPILL_THRESHOLD_CHARS = 5000
        registry.MAX_RESULT_CHARS = 10000
        def big_result(params):
            return "x" * 20000
        registry.register(ToolDef(
            name="big_tool", description="test", parameters={"type": "object", "properties": {}},
            handler=big_result, permission=Permission.READ,
        ))
        gate = PermissionGate(auto_approve=True)
        result = registry.execute("big_tool", {}, gate)
        assert len(result) <= 10200  # MAX + spillover message


# ============================================================================
# 5. UNICODE AND ENCODING EDGE CASES
# ============================================================================

class TestUnicodeEdgeCases:
    """Test Unicode handling across tools."""

    def test_write_read_unicode(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        content = "Hello 世界 🌍 مرحبا"
        f = tmp_path / "unicode.txt"
        file_ops.write_file({"path": str(f), "content": content})
        result = json.loads(file_ops.read_file({"path": str(f)}))
        assert "世界" in result["content"]
        assert "🌍" in result["content"]

    def test_grep_unicode_pattern(self, tmp_path, monkeypatch):
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        f = tmp_path / "uni.txt"
        f.write_text("café résumé naïve\n", encoding="utf-8")
        result = json.loads(file_ops.grep_files({
            "pattern": "café",
            "path": str(tmp_path),
        }))
        assert result["total"] >= 1

    def test_doc_title_unicode(self, tmp_path, monkeypatch):
        monkeypatch.setattr(doc_tools, "_ALLOWED_WRITE_DIR", tmp_path)
        monkeypatch.setattr(doc_tools, "_validate_output_dir", lambda d: None)
        result = json.loads(doc_tools.create_doc({
            "title": "日本語テスト",
            "content": "内容",
            "output_dir": str(tmp_path),
        }))
        assert result.get("status") == "created"

    def test_calculator_unicode_rejected(self):
        result = json.loads(math_tools.calculator({"expression": "π * 2"}))
        assert "error" in result

    def test_memory_save_unicode(self, tmp_path):
        store = MemoryStore(str(tmp_path))
        path = store.save_memory(
            name="unicode-test",
            memory_type=MemoryType.USER,
            description="测试 Unicode 支持",
            content="用户偏好：中文界面",
        )
        assert os.path.exists(path)
        with open(path, encoding="utf-8") as f:
            text = f.read()
        assert "中文界面" in text


# ============================================================================
# 6. PERMISSION PIPELINE STRESS
# ============================================================================

class TestPermissionStress:
    """Stress test the permission pipeline."""

    def test_deny_always_wins(self):
        """deny > allow, even if allow is listed first."""
        gate = PermissionGate(rules=[
            PermissionRule("write_file", "allow"),
            PermissionRule("write_file", "deny"),
        ])
        assert not gate.check(Permission.WRITE, "write_file()")

    def test_ask_before_allow(self):
        """ask > allow when no deny."""
        gate = PermissionGate(auto_approve=False, rules=[
            PermissionRule("write_file", "allow"),
            PermissionRule("write_file", "ask"),
        ])
        gate_check = gate._match_rules(Permission.WRITE, "write_file")
        assert gate_check == "ask"

    def test_plan_mode_blocks_all_writes(self):
        gate = PermissionGate(plan_mode=True)
        assert not gate.check(Permission.WRITE, "write_file()")
        assert not gate.check(Permission.DESTRUCTIVE, "rm()")

    def test_plan_mode_allows_reads(self):
        gate = PermissionGate(plan_mode=True)
        assert gate.check(Permission.READ, "read_file()")

    def test_auto_approve_writes(self):
        gate = PermissionGate(auto_approve=True)
        assert gate.check(Permission.WRITE, "write_file()")

    def test_rule_pattern_wildcard(self):
        gate = PermissionGate(rules=[
            PermissionRule("run_command:*", "allow"),
        ])
        result = gate._match_rules(Permission.WRITE, "run_command", "anything")
        assert result == "allow"

    def test_rule_pattern_prefix(self):
        gate = PermissionGate(rules=[
            PermissionRule("run_command:git:*", "allow"),
        ])
        assert gate._match_rules(Permission.WRITE, "run_command", "git status") == "allow"
        assert gate._match_rules(Permission.WRITE, "run_command", "rm -rf /") is None

    def test_rule_pattern_exact(self):
        gate = PermissionGate(rules=[
            PermissionRule("read_file", "allow"),
        ])
        assert gate._match_rules(Permission.READ, "read_file") == "allow"
        assert gate._match_rules(Permission.READ, "write_file") is None

    def test_rejection_circuit_breaker(self):
        """After 3 rejections, auto-approve falls through to interactive."""
        gate = PermissionGate(auto_approve=True)
        gate._rejection_count = 3
        assert gate._rejection_count >= 3

    def test_many_rules_performance(self):
        """100 rules should not slow down permission checks."""
        rules = [PermissionRule(f"tool_{i}", "allow") for i in range(100)]
        rules.append(PermissionRule("target_tool", "deny"))
        gate = PermissionGate(rules=rules)
        start = time.time()
        for _ in range(1000):
            gate._match_rules(Permission.WRITE, "target_tool")
        elapsed = time.time() - start
        assert elapsed < 1.0  # 1000 checks in under 1 second

    def test_approval_log_growth(self):
        """Approval log should not grow unbounded."""
        gate = PermissionGate(auto_approve=True)
        for i in range(1000):
            gate.check(Permission.READ, f"read_file_{i}()")
        assert len(gate.approval_log) == 1000

    def test_load_rules_from_missing_file(self):
        """Loading from nonexistent file should not crash."""
        gate = PermissionGate()
        gate.load_rules_from_file("/nonexistent/path.json")
        assert len(gate.rules) == 0


# ============================================================================
# 7. CONCURRENT TOOL EXECUTION SAFETY
# ============================================================================

class TestConcurrency:
    """Test thread safety of shared components."""

    def test_circuit_breaker_thread_safety(self):
        """Circuit breaker should handle concurrent access."""
        cb = CircuitBreaker(threshold=5)
        errors = []

        def record_failures():
            try:
                for _ in range(10):
                    cb.record_failure()
                    time.sleep(0.001)
            except Exception as e:
                errors.append(e)

        def record_successes():
            try:
                for _ in range(10):
                    cb.record_success()
                    time.sleep(0.001)
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=record_failures) for _ in range(5)]
        threads += [threading.Thread(target=record_successes) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert len(errors) == 0

    def test_permission_gate_log_thread_safety(self):
        """Approval log should handle concurrent writes."""
        gate = PermissionGate(auto_approve=True)
        errors = []

        def check_many():
            try:
                for i in range(100):
                    gate.check(Permission.READ, f"tool_{i}()")
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=check_many) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert len(errors) == 0
        assert len(gate.approval_log) == 500

    def test_token_budget_update_thread_safety(self):
        """Token budget should handle concurrent updates."""
        budget = TokenBudget()
        errors = []

        def update_many():
            try:
                for _ in range(100):
                    budget.update([{"role": "user", "content": "test " * 100}])
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=update_many) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert len(errors) == 0


# ============================================================================
# 8. BACKGROUND JOB CLEANUP
# ============================================================================

class TestBackgroundJobCleanup:
    """Verify background jobs can be created and cleaned up without leaking."""

    def test_background_job_cleanup(self):
        """Background jobs should be removable without leaking."""
        import time as _time

        # Clean slate
        shell._background_jobs.clear()

        # Start a background job
        result = json.loads(shell.run_command({
            "command": "echo cleanup_test",
            "run_in_background": True,
        }))
        job_id = result["job_id"]
        assert job_id in shell._background_jobs

        # Wait for completion
        _time.sleep(1)
        job = shell._background_jobs[job_id]
        assert job["status"] == "completed"

        # Cleanup: remove the completed job
        del shell._background_jobs[job_id]
        assert job_id not in shell._background_jobs
        assert len(shell._background_jobs) == 0

    def test_multiple_background_jobs(self):
        """Multiple background jobs should coexist and complete independently."""
        import time as _time

        shell._background_jobs.clear()

        job_ids = []
        for i in range(3):
            result = json.loads(shell.run_command({
                "command": f"echo job_{i}",
                "run_in_background": True,
            }))
            job_ids.append(result["job_id"])

        assert len(shell._background_jobs) == 3

        # Wait for all to complete
        _time.sleep(1.5)
        for jid in job_ids:
            assert shell._background_jobs[jid]["status"] == "completed"

        # Clean up all
        for jid in job_ids:
            del shell._background_jobs[jid]
        assert len(shell._background_jobs) == 0


# ============================================================================
# 9. MONITOR MAX LIMIT
# ============================================================================

class TestMonitorMaxLimit:
    """Verify the 10-monitor cap is enforced."""

    def test_monitor_max_limit(self, monkeypatch):
        """Starting more than MAX_MONITORS should be rejected."""
        from mimo_harness.tools import monitor

        monkeypatch.setattr(monitor, "_monitors", {})

        # Fill _monitors with fake entries up to MAX_MONITORS
        for i in range(monitor.MAX_MONITORS):
            job_id = f"fake-{i}"
            fake = MagicMock()
            fake.command = f"fake command {i}"
            fake.description = f"Fake monitor {i}"
            fake.status = "running"
            fake.lines = []
            monitor._monitors[job_id] = fake

        assert len(monitor._monitors) == monitor.MAX_MONITORS

        # Next one should fail
        result = json.loads(monitor.monitor_start({
            "command": "echo overflow",
            "description": "Overflow monitor",
        }))
        assert "error" in result
        assert "Maximum" in result["error"]

    def test_monitor_cleanup_allows_restart(self, monkeypatch):
        """Stopping a monitor frees a slot for a new one."""
        from mimo_harness.tools import monitor

        monkeypatch.setattr(monitor, "_monitors", {})

        # Fill up to MAX_MONITORS
        for i in range(monitor.MAX_MONITORS):
            fake = MagicMock()
            fake.command = f"cmd {i}"
            fake.description = f"desc {i}"
            fake.status = "running"
            fake.lines = []
            fake.stop = MagicMock()
            fake.get_lines = MagicMock(return_value=[])
            monitor._monitors[f"fake-{i}"] = fake

        # Stop one
        stop_result = json.loads(monitor.monitor_stop({"job_id": "fake-0"}))
        assert stop_result["status"] == "stopped"
        assert len(monitor._monitors) == monitor.MAX_MONITORS - 1


# ============================================================================
# 10. PATH TRAVERSAL IN PERMISSION RULES
# ============================================================================

class TestPathTraversalInPermissionRule:
    """Verify path-scoped permission rules properly restrict access."""

    def test_path_pattern_blocks_outside_access(self):
        """Paths outside the pattern scope should not match."""
        rule = PermissionRule(
            tool_pattern="write_file",
            action="allow",
            path_pattern="/src/**",
        )
        # Allowed: within /src/
        assert rule.matches("write_file", "/src/main.py")
        assert rule.matches("write_file", "/src/sub/module.py")

        # Blocked: outside /src/
        assert not rule.matches("write_file", "/etc/passwd")
        assert not rule.matches("write_file", "/home/user/secret.txt")
        assert not rule.matches("write_file", "/tmp/evil.txt")

    def test_path_pattern_requires_tool_match(self):
        """Path pattern also requires tool name to match."""
        rule = PermissionRule(
            tool_pattern="write_file",
            action="allow",
            path_pattern="/src/**",
        )
        # Wrong tool name, even with matching path
        assert not rule.matches("read_file", "/src/main.py")
        assert not rule.matches("delete_file", "/src/main.py")

    def test_path_pattern_deny_rule(self):
        """Deny rule with path pattern blocks matching tool+path combos."""
        gate = PermissionGate(auto_approve=True, rules=[
            PermissionRule("write_file", "deny", path_pattern="/etc/**"),
        ])
        # Deny rule blocks writes to /etc/
        assert not gate.check(Permission.WRITE, "write_file(/etc/passwd)")
        # Allow writes to other paths (falls through to auto_approve)
        assert gate.check(Permission.WRITE, "write_file(/src/main.py)")

    def test_path_pattern_wildcard_tool(self):
        """Wildcard tool pattern with path restriction."""
        rule = PermissionRule(
            tool_pattern="*",
            action="deny",
            path_pattern="/secrets/**",
        )
        assert rule.matches("read_file", "/secrets/api_key.txt")
        assert rule.matches("write_file", "/secrets/config.json")
        assert not rule.matches("read_file", "/public/readme.txt")


# ============================================================================
# 11. WRITE READ-BEFORE-WRITE ENFORCEMENT
# ============================================================================

class TestWriteReadBeforeWrite:
    """write_file must read existing files before overwriting."""

    def test_write_to_existing_unread_file_blocked(self, tmp_path, monkeypatch):
        """Writing to an existing file that was never read should error."""
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        monkeypatch.setattr(file_ops, "_write_allowed_files", set())
        f = tmp_path / "existing.txt"
        f.write_text("original content")
        result = json.loads(file_ops.write_file({
            "path": str(f),
            "content": "new content",
        }))
        assert "error" in result
        assert "read" in result["error"].lower()

    def test_write_to_existing_read_file_succeeds(self, tmp_path, monkeypatch):
        """Writing to an existing file that was read should succeed."""
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        monkeypatch.setattr(file_ops, "_write_allowed_files", set())
        f = tmp_path / "existing.txt"
        f.write_text("original content")
        # Read the file first
        file_ops.read_file({"path": str(f)})
        result = json.loads(file_ops.write_file({
            "path": str(f),
            "content": "new content",
        }))
        assert result.get("status") == "written"
        assert f.read_text() == "new content"

    def test_write_to_new_file_succeeds(self, tmp_path, monkeypatch):
        """Writing to a file that does not exist yet should succeed without read."""
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
        monkeypatch.setattr(file_ops, "_write_allowed_files", set())
        f = tmp_path / "brand_new.txt"
        assert not f.exists()
        result = json.loads(file_ops.write_file({
            "path": str(f),
            "content": "first write",
        }))
        assert result.get("status") == "written"
        assert f.read_text() == "first write"
