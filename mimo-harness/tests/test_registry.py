"""Tests for the tool registry (Ch3 patterns)."""

import pytest
import json
from mimo_harness.tools.registry import ToolDef, ToolRegistry
from mimo_harness.permissions import Permission, PermissionGate


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
