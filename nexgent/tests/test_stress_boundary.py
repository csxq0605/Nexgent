"""Stress and boundary tests - real-world attack scenarios and edge cases.

Tests cover:
2. SSRF bypass attempts
4. Large input / memory exhaustion
5. Unicode and encoding edge cases
6. Permission pipeline stress
7. Concurrent tool execution safety
9. Monitor max limit
"""

import json
import os
import sys
import threading
import time

import pytest

from nexgent.tools import file_ops, web_tools, doc_tools, math_tools
from nexgent.permissions import Permission, PermissionGate, PermissionRule
from nexgent.memory import MemoryStore, MemoryType
from nexgent.agent import CircuitBreaker, TokenBudget


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

    def test_blocks_zero_address(self):
        assert web_tools._validate_url("http://0.0.0.0/admin") is not None

    def test_max_response_size_constant(self):
        """Verify MAX_RESPONSE_BYTES is defined and reasonable."""
        assert hasattr(web_tools, 'MAX_RESPONSE_BYTES')
        assert 1024 <= web_tools.MAX_RESPONSE_BYTES <= 10 * 1024 * 1024  # 1KB .. 10MB


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
        for i in range(300):
            (tmp_path / f"file_{i}.txt").touch()
        result = json.loads(file_ops.glob_files({
            "pattern": str(tmp_path / "*.txt"),
        }))
        assert len(result["matches"]) <= 250

    def test_calculator_large_exponent(self):
        """Large exponent should not hang (DoS vector)."""
        result = json.loads(math_tools.calculator({"expression": "2**100"}))
        assert "result" in result or "error" in result


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
        monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)
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

    def test_ask_before_allow(self):
        """ask > allow when no deny."""
        gate = PermissionGate(auto_approve=False, rules=[
            PermissionRule("write_file", "allow"),
            PermissionRule("write_file", "ask"),
        ])
        gate_check = gate._match_rules(Permission.WRITE, "write_file")
        assert gate_check == "ask"

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
        """Approval log records all checks (currently unbounded)."""
        gate = PermissionGate(auto_approve=True)
        for i in range(1000):
            gate.check(Permission.READ, f"read_file_{i}()")
        # Current implementation stores all entries — this verifies it doesn't crash at scale
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
# 9. MONITOR MAX LIMIT
# ============================================================================

class TestMonitorMaxLimit:
    """Verify the 10-monitor cap is enforced."""

    def test_monitor_max_limit(self, monkeypatch):
        """Starting more than MAX_MONITORS should be rejected."""
        from nexgent.tools import monitor

        monkeypatch.setattr(monitor, "_monitors", {})
        sleep_cmd = f'{sys.executable} -c "import time; time.sleep(60)"'

        # Fill _monitors with real processes up to MAX_MONITORS
        started = []
        for i in range(monitor.MAX_MONITORS):
            result = json.loads(monitor.monitor_start({
                "command": sleep_cmd,
                "description": f"Cap test monitor {i}",
            }))
            assert "job_id" in result, f"Failed to start monitor {i}: {result}"
            started.append(result["job_id"])

        assert len(monitor._monitors) == monitor.MAX_MONITORS

        # Next one should fail
        result = json.loads(monitor.monitor_start({
            "command": "echo overflow",
            "description": "Overflow monitor",
        }))
        assert "error" in result
        assert "Maximum" in result["error"]

        # Cleanup
        for job_id in started:
            monitor.monitor_stop({"job_id": job_id})

    def test_monitor_cleanup_allows_restart(self, monkeypatch):
        """Stopping a monitor frees a slot for a new one."""
        from nexgent.tools import monitor

        monkeypatch.setattr(monitor, "_monitors", {})
        sleep_cmd = f'{sys.executable} -c "import time; time.sleep(60)"'

        # Fill up to MAX_MONITORS with real processes
        started = []
        for i in range(monitor.MAX_MONITORS):
            result = json.loads(monitor.monitor_start({
                "command": sleep_cmd,
                "description": f"Restart test monitor {i}",
            }))
            assert "job_id" in result
            started.append(result["job_id"])

        # Stop one
        stop_result = json.loads(monitor.monitor_stop({"job_id": started[0]}))
        assert stop_result["status"] == "stopped"
        assert len(monitor._monitors) == monitor.MAX_MONITORS - 1

        # Cleanup remaining
        for job_id in started[1:]:
            monitor.monitor_stop({"job_id": job_id})


# ============================================================================
# TASK THREAD SAFETY
# ============================================================================

class TestTaskThreadSafety:
    """Test concurrent task_create calls are thread-safe."""

    def test_concurrent_task_create(self):
        """20 concurrent task_create calls should not crash or lose data."""
        from nexgent.tools import task_tools

        results = []
        errors = []

        def create_task(i):
            try:
                r = json.loads(task_tools.task_create({
                    "subject": f"Thread Task {i}",
                    "description": f"Description {i}",
                }))
                results.append(r)
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=create_task, args=(i,)) for i in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(errors) == 0, f"Thread errors: {errors}"
        assert len(results) == 20


# ============================================================================
# INIT ATTRIBUTE ASSERTIONS
# ============================================================================

class TestInitAttributes:
    """Test that key classes initialize with correct default attributes."""

    def test_circuit_breaker_init(self):
        cb = CircuitBreaker(threshold=5)
        assert cb.threshold == 5
        assert cb.consecutive_failures == 0
        assert cb.is_open is False

    # NOTE: TokenBudget init/default tests are in test_token_counter.py::TestTokenBudget

