"""Tests for plan_tools.py - EnterPlanMode/ExitPlanMode workflow."""

import json

from mimo_harness.tools import plan_tools
from mimo_harness.tools.plan_tools import enter_plan_mode, exit_plan_mode, get_tools
from mimo_harness.tools.registry import ToolDef
from mimo_harness.permissions import Permission


class TestEnterPlanMode:
    def test_basic_enter(self):
        result = json.loads(enter_plan_mode({}))
        assert result["status"] == "plan_mode_entered"
        assert "PLAN MODE" in result["message"]
        assert len(result["capabilities"]) > 0
        assert len(result["restrictions"]) > 0
        assert "exit_plan_mode" in result["next_step"]

    def test_enter_with_reason(self):
        result = json.loads(enter_plan_mode({"reason": "Refactoring auth system"}))
        assert "Refactoring auth system" in result["message"]

    def test_enter_default_reason(self):
        result = json.loads(enter_plan_mode({}))
        assert "Exploring codebase" in result["message"]

    def test_enter_read_only_capabilities(self):
        result = json.loads(enter_plan_mode({}))
        caps_text = " ".join(result["capabilities"])
        assert "Read" in caps_text or "read" in caps_text
        restrictions_text = " ".join(result["restrictions"])
        assert "Cannot" in restrictions_text


class TestExitPlanMode:
    def test_returns_pending(self):
        result = json.loads(exit_plan_mode({"plan": "Step 1: do X\nStep 2: do Y"}))
        assert result["decision"] == "pending"
        assert result["plan"] == "Step 1: do X\nStep 2: do Y"
        assert "PLAN READY" in result["message"]

    def test_no_plan_returns_error(self):
        result = json.loads(exit_plan_mode({}))
        assert "error" in result
        assert "No plan provided" in result["error"]

    def test_empty_plan_returns_error(self):
        result = json.loads(exit_plan_mode({"plan": ""}))
        assert "error" in result

    def test_with_summary(self):
        result = json.loads(exit_plan_mode({
            "plan": "Detailed plan here",
            "summary": "Refactor auth module",
        }))
        assert result["decision"] == "pending"
        assert result["summary"] == "Refactor auth module"


class TestHandlePlanApproval:
    """Test _handle_plan_approval (user interaction in agent loop)."""

    def _make_harness(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        from mimo_harness.agent import MiMoHarness
        return MiMoHarness(auto_approve=False)

    def test_approve(self, monkeypatch):
        harness = self._make_harness(monkeypatch)
        monkeypatch.setattr("builtins.input", lambda _="": "1")
        result = json.loads(harness._handle_plan_approval({"plan": "do X", "summary": "X"}))
        assert result["decision"] == "approved"

    def test_reject(self, monkeypatch):
        harness = self._make_harness(monkeypatch)
        monkeypatch.setattr("builtins.input", lambda _="": "2")
        result = json.loads(harness._handle_plan_approval({"plan": "do X"}))
        assert result["decision"] == "rejected"

    def test_modify(self, monkeypatch):
        harness = self._make_harness(monkeypatch)
        _iter = iter(["3", "Add error handling"])
        monkeypatch.setattr("builtins.input", lambda _="": next(_iter))
        result = json.loads(harness._handle_plan_approval({"plan": "do X"}))
        assert result["decision"] == "modify"
        assert result["feedback"] == "Add error handling"

    def test_auto_approve(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key")
        monkeypatch.setenv("MIMO_BASE_URL", "http://test.com")
        monkeypatch.setenv("MIMO_MODEL", "test-model")
        from mimo_harness.agent import MiMoHarness
        harness = MiMoHarness(auto_approve=True)
        result = json.loads(harness._handle_plan_approval({"plan": "do X"}))
        assert result["decision"] == "approved"

    def test_eof_on_choice(self, monkeypatch):
        harness = self._make_harness(monkeypatch)
        def _raise_eof(_=""): raise EOFError
        monkeypatch.setattr("builtins.input", _raise_eof)
        result = json.loads(harness._handle_plan_approval({"plan": "do X"}))
        assert result["decision"] == "rejected"

    def test_modify_eof_on_feedback(self, monkeypatch):
        harness = self._make_harness(monkeypatch)
        _count = [0]
        def _input(_=""):
            _count[0] += 1
            if _count[0] == 1:
                return "3"
            raise EOFError
        monkeypatch.setattr("builtins.input", _input)
        result = json.loads(harness._handle_plan_approval({"plan": "do X"}))
        assert result["decision"] == "modify"
        assert result["feedback"] == ""

    def test_reject_with_feedback(self, monkeypatch):
        harness = self._make_harness(monkeypatch)
        _iter = iter(["2", "Needs more detail"])
        monkeypatch.setattr("builtins.input", lambda _="": next(_iter))
        result = json.loads(harness._handle_plan_approval({"plan": "do X"}))
        assert result["decision"] == "rejected"
        assert result["feedback"] == "Needs more detail"


class TestPlanToolsGetTools:
    def test_returns_two_tools(self):
        tools = get_tools()
        assert len(tools) == 2

    def test_tool_names(self):
        tools = get_tools()
        names = {t.name for t in tools}
        assert names == {"enter_plan_mode", "exit_plan_mode"}

    def test_all_tooldefs(self):
        for tool in get_tools():
            assert isinstance(tool, ToolDef)
            assert tool.handler is not None
            assert tool.permission == Permission.READ
            assert tool.is_read_only is True
            assert tool.is_concurrency_safe is False

    def test_exit_plan_mode_requires_plan(self):
        tools = get_tools()
        exit_tool = next(t for t in tools if t.name == "exit_plan_mode")
        assert "plan" in exit_tool.parameters["required"]
