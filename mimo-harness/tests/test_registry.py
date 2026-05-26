"""Tests for the tool registry (Ch3 patterns)."""

import pytest
import json
import os
import tempfile
from unittest.mock import patch, MagicMock
from mimo_harness.tools.registry import ToolDef, ToolRegistry
from mimo_harness.permissions import Permission, PermissionGate


class TestToolDef:
    def test_default_markers(self):
        t = ToolDef(name="test", description="test", parameters={}, handler=lambda x: x)
        assert t.permission == Permission.READ
        assert not t.is_read_only
        assert not t.is_destructive
        assert not t.is_concurrency_safe

    def test_custom_markers(self):
        t = ToolDef(
            name="read", description="read", parameters={},
            handler=lambda x: x, permission=Permission.READ,
            is_read_only=True, is_concurrency_safe=True,
        )
        assert t.is_read_only
        assert t.is_concurrency_safe


class TestToolRegistry:
    def test_register_and_get(self):
        reg = ToolRegistry()
        t = ToolDef(name="test", description="test", parameters={}, handler=lambda x: "ok")
        reg.register(t)
        assert reg.get("test") is t
        assert reg.get("nonexistent") is None

    def test_register_many(self):
        reg = ToolRegistry()
        tools = [
            ToolDef(name=f"t{i}", description=f"t{i}", parameters={}, handler=lambda x: x)
            for i in range(5)
        ]
        reg.register_many(tools)
        assert len(reg.list_names()) == 5

    def test_list_tools_schema(self):
        reg = ToolRegistry()
        reg.register(ToolDef(
            name="test", description="A test tool",
            parameters={"type": "object", "properties": {"x": {"type": "string"}}},
            handler=lambda x: x,
        ))
        schema = reg.list_tools()
        assert len(schema) == 1
        assert schema[0]["type"] == "function"
        assert schema[0]["function"]["name"] == "test"

    def test_list_read_only(self):
        reg = ToolRegistry()
        reg.register(ToolDef(
            name="read", description="r", parameters={},
            handler=lambda x: x, is_read_only=True,
        ))
        reg.register(ToolDef(
            name="write", description="w", parameters={},
            handler=lambda x: x, is_read_only=False,
        ))
        ro = reg.list_read_only()
        assert len(ro) == 1
        assert ro[0].name == "read"

    def test_list_concurrency_safe(self):
        reg = ToolRegistry()
        reg.register(ToolDef(
            name="safe", description="s", parameters={},
            handler=lambda x: x, is_concurrency_safe=True,
        ))
        reg.register(ToolDef(
            name="unsafe", description="u", parameters={},
            handler=lambda x: x, is_concurrency_safe=False,
        ))
        cs = reg.list_concurrency_safe()
        assert len(cs) == 1
        assert cs[0].name == "safe"

    def test_execute_unknown_tool(self):
        reg = ToolRegistry()
        perms = PermissionGate(auto_approve=True)
        result = json.loads(reg.execute("nonexistent", {}, perms))
        assert "error" in result
        assert "Unknown tool" in result["error"]

    def test_execute_valid_tool(self):
        reg = ToolRegistry()
        reg.register(ToolDef(
            name="echo", description="echo", parameters={},
            handler=lambda p: json.dumps({"echo": p.get("msg", "")}),
            permission=Permission.READ,
        ))
        perms = PermissionGate(auto_approve=True)
        result = json.loads(reg.execute("echo", {"msg": "hello"}, perms))
        assert result["echo"] == "hello"

    def test_execute_permission_denied(self):
        reg = ToolRegistry()
        reg.register(ToolDef(
            name="write", description="w", parameters={},
            handler=lambda p: "ok", permission=Permission.WRITE,
        ))
        perms = PermissionGate(plan_mode=True)
        result = json.loads(reg.execute("write", {}, perms))
        assert "error" in result
        assert "Permission denied" in result["error"]

    def test_execute_validation_error(self):
        reg = ToolRegistry()
        reg.register(ToolDef(
            name="strict", description="s",
            parameters={
                "type": "object",
                "properties": {"x": {"type": "string"}},
                "required": ["x"],
            },
            handler=lambda p: "ok",
            permission=Permission.READ,
        ))
        perms = PermissionGate(auto_approve=True)
        result = json.loads(reg.execute("strict", {}, perms))
        assert "error" in result
        assert "Missing required parameter" in result["error"]

    def test_result_truncation(self):
        reg = ToolRegistry()
        # Override spillover thresholds for testing
        reg.SPILL_THRESHOLD_CHARS = 50
        reg.MAX_RESULT_CHARS = 200
        reg.register(ToolDef(
            name="big", description="b", parameters={},
            handler=lambda p: "x" * 200,
            permission=Permission.READ,
        ))
        perms = PermissionGate(auto_approve=True)
        result = reg.execute("big", {}, perms)
        assert "truncated" in result or "saved to" in result
        assert len(result) < 200

    def test_handler_exception(self):
        reg = ToolRegistry()
        reg.register(ToolDef(
            name="fail", description="f", parameters={},
            handler=lambda p: 1 / 0,
            permission=Permission.READ,
        ))
        perms = PermissionGate(auto_approve=True)
        result = json.loads(reg.execute("fail", {}, perms))
        assert "error" in result
        assert "failed" in result["error"]


# ============================================================================
# R2: Round 2 — disk spillover (_spill_to_disk), MAX_RESULT_CHARS hard cap,
#     fallback truncation on disk write failure
# ============================================================================


class TestSpillToDisk:
    """R2: _spill_to_disk saves large results to .mimo/outputs/."""

    def test_spill_saves_to_file(self, tmp_path, monkeypatch):
        """_spill_to_disk creates a file in the spill directory."""
        monkeypatch.chdir(tmp_path)
        reg = ToolRegistry()
        reg.SPILL_DIR = str(tmp_path / ".mimo" / "outputs")
        large_result = "x" * 50000
        result = reg._spill_to_disk(large_result, "test_tool")
        # Should contain preview and file path
        assert "output truncated" in result
        assert "saved to" in result
        # Extract file path from result
        import re
        match = re.search(r"saved to (.+?)]", result)
        assert match is not None
        file_path = match.group(1)
        assert os.path.exists(file_path)
        with open(file_path, encoding="utf-8") as f:
            assert f.read() == large_result

    def test_spill_returns_preview(self, tmp_path, monkeypatch):
        """_spill_to_disk returns the first SPILL_THRESHOLD_CHARS as preview."""
        monkeypatch.chdir(tmp_path)
        reg = ToolRegistry()
        reg.SPILL_DIR = str(tmp_path / ".mimo" / "outputs")
        reg.SPILL_THRESHOLD_CHARS = 100
        large_result = "A" * 50000
        result = reg._spill_to_disk(large_result, "test_tool")
        # Preview should contain the first SPILL_THRESHOLD_CHARS characters
        assert "A" * 50 in result

    def test_spill_creates_directory(self, tmp_path, monkeypatch):
        """_spill_to_disk creates the spill directory if it doesn't exist."""
        monkeypatch.chdir(tmp_path)
        reg = ToolRegistry()
        spill_dir = str(tmp_path / "custom_spill")
        reg.SPILL_DIR = spill_dir
        assert not os.path.exists(spill_dir)
        reg._spill_to_disk("x" * 50000, "test_tool")
        assert os.path.isdir(spill_dir)

    def test_spill_unique_file_ids(self, tmp_path, monkeypatch):
        """Each spill creates a unique file."""
        monkeypatch.chdir(tmp_path)
        reg = ToolRegistry()
        reg.SPILL_DIR = str(tmp_path / ".mimo" / "outputs")
        result1 = reg._spill_to_disk("data1" * 10000, "tool1")
        result2 = reg._spill_to_disk("data2" * 10000, "tool2")
        # Both should reference different files
        import re
        match1 = re.search(r"saved to (.+?)]", result1)
        match2 = re.search(r"saved to (.+?)]", result2)
        assert match1.group(1) != match2.group(1)


class TestSpillFallbackTruncation:
    """R2: Fallback truncation when disk write fails."""

    def test_fallback_truncation_on_write_failure(self, tmp_path, monkeypatch):
        """When disk write fails, result is truncated to MAX_RESULT_CHARS."""
        monkeypatch.chdir(tmp_path)
        reg = ToolRegistry()
        reg.SPILL_DIR = str(tmp_path / ".mimo" / "outputs")
        reg.MAX_RESULT_CHARS = 200
        reg.SPILL_THRESHOLD_CHARS = 100

        # Mock builtins.open to fail on the spill file write
        real_open = open

        def failing_open(path, *args, **kwargs):
            if isinstance(path, str) and ".mimo" in path and "outputs" in path and args and args[0] == "w":
                raise IOError("Disk full")
            return real_open(path, *args, **kwargs)

        monkeypatch.setattr("builtins.open", failing_open)
        large_result = "y" * 50000
        result = reg._spill_to_disk(large_result, "test_tool")
        assert "truncated" in result
        assert "disk spill failed" in result


class TestMaxResultCharsHardCap:
    """R2: Hard cap at MAX_RESULT_CHARS in execute()."""

    def test_hard_cap_truncates_before_spill(self):
        """Results exceeding MAX_RESULT_CHARS are truncated before spilling."""
        reg = ToolRegistry()
        reg.MAX_RESULT_CHARS = 500
        reg.SPILL_THRESHOLD_CHARS = 10000  # High threshold so no spill
        reg.register(ToolDef(
            name="huge", description="h", parameters={},
            handler=lambda p: "Z" * 2000,
            permission=Permission.READ,
        ))
        perms = PermissionGate(auto_approve=True)
        result = reg.execute("huge", {}, perms)
        # Result should be truncated to MAX_RESULT_CHARS (500)
        assert len(result) <= 500

    def test_result_below_max_not_truncated(self):
        """Results below MAX_RESULT_CHARS are not truncated."""
        reg = ToolRegistry()
        reg.MAX_RESULT_CHARS = 100000
        reg.SPILL_THRESHOLD_CHARS = 100000
        reg.register(ToolDef(
            name="small", description="s", parameters={},
            handler=lambda p: "small result",
            permission=Permission.READ,
        ))
        perms = PermissionGate(auto_approve=True)
        result = reg.execute("small", {}, perms)
        assert result == "small result"

    def test_result_between_spill_and_max_spills_to_disk(self, tmp_path, monkeypatch):
        """Results between SPILL and MAX trigger disk spillover."""
        monkeypatch.chdir(tmp_path)
        reg = ToolRegistry()
        reg.SPILL_THRESHOLD_CHARS = 100
        reg.MAX_RESULT_CHARS = 10000
        reg.SPILL_DIR = str(tmp_path / ".mimo" / "outputs")
        reg.register(ToolDef(
            name="medium", description="m", parameters={},
            handler=lambda p: "M" * 500,
            permission=Permission.READ,
        ))
        perms = PermissionGate(auto_approve=True)
        result = reg.execute("medium", {}, perms)
        assert "output truncated" in result
        assert "saved to" in result


class TestSpillIntegration:
    """R2: Integration test for spillover through execute()."""

    def test_execute_with_spillover(self, tmp_path, monkeypatch):
        """Full pipeline: handler produces large result, execute spills to disk."""
        monkeypatch.chdir(tmp_path)
        reg = ToolRegistry()
        reg.SPILL_THRESHOLD_CHARS = 50
        reg.MAX_RESULT_CHARS = 200
        reg.SPILL_DIR = str(tmp_path / ".mimo" / "outputs")
        reg.register(ToolDef(
            name="big_result", description="b", parameters={},
            handler=lambda p: "B" * 300,
            permission=Permission.READ,
        ))
        perms = PermissionGate(auto_approve=True)
        result = reg.execute("big_result", {}, perms)
        # Should be capped at MAX (200), then since 200 > SPILL (50), it spills
        assert "output truncated" in result or "saved to" in result

    def test_spill_file_contains_full_result(self, tmp_path, monkeypatch):
        """The spilled file contains the full (pre-truncation) result."""
        monkeypatch.chdir(tmp_path)
        reg = ToolRegistry()
        reg.SPILL_THRESHOLD_CHARS = 50
        reg.MAX_RESULT_CHARS = 10000
        spill_dir = str(tmp_path / ".mimo" / "outputs")
        reg.SPILL_DIR = spill_dir
        content = "C" * 200
        reg.register(ToolDef(
            name="file_check", description="f", parameters={},
            handler=lambda p: content,
            permission=Permission.READ,
        ))
        perms = PermissionGate(auto_approve=True)
        result = reg.execute("file_check", {}, perms)
        # Find the saved file
        import re
        match = re.search(r"saved to (.+?)]", result)
        assert match is not None
        file_path = match.group(1)
        with open(file_path, encoding="utf-8") as f:
            saved = f.read()
        assert saved == content


class TestSpillThresholdConstants:
    """R2: Verify spillover threshold constants are sensible."""

    def test_spill_threshold_less_than_max(self):
        assert ToolRegistry.SPILL_THRESHOLD_CHARS < ToolRegistry.MAX_RESULT_CHARS

    def test_spill_threshold_tokens_to_chars(self):
        """SPILL_THRESHOLD_CHARS = SPILL_THRESHOLD_TOKENS * 4."""
        assert ToolRegistry.SPILL_THRESHOLD_CHARS == ToolRegistry.SPILL_THRESHOLD_TOKENS * 4

    def test_max_result_tokens_to_chars(self):
        """MAX_RESULT_CHARS = MAX_RESULT_TOKENS * 4."""
        assert ToolRegistry.MAX_RESULT_CHARS == ToolRegistry.MAX_RESULT_TOKENS * 4

    def test_default_spill_dir(self):
        # SPILL_DIR reads from MIMO_SPILL_DIR env var, falls back to .mimo/outputs
        import os
        expected = os.environ.get("MIMO_SPILL_DIR", ".mimo/outputs")
        assert ToolRegistry.SPILL_DIR == expected
