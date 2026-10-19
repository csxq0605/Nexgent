"""Tests for the subagent_run tool."""

import json
import pytest
from unittest.mock import MagicMock, patch

from nexgent.tools.subagent_tools import get_tools, _make_run_handler
from nexgent.tools.registry import ToolDef
from nexgent.permissions import Permission


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_harness():
    """A mock harness with a mock subagent_manager."""
    harness = MagicMock()
    harness.subagent_manager = MagicMock()
    return harness


# ---------------------------------------------------------------------------
# get_tools
# ---------------------------------------------------------------------------

class TestGetTools:
    def test_returns_single_tool(self, mock_harness):
        tools = get_tools(mock_harness)
        assert len(tools) == 1
        assert isinstance(tools[0], ToolDef)

    def test_tool_name(self, mock_harness):
        tools = get_tools(mock_harness)
        assert tools[0].name == "subagent_run"

    def test_permission_is_write(self, mock_harness):
        tools = get_tools(mock_harness)
        assert tools[0].permission == Permission.WRITE

    def test_not_read_only(self, mock_harness):
        tools = get_tools(mock_harness)
        assert tools[0].is_read_only is False

    def test_not_concurrency_safe(self, mock_harness):
        tools = get_tools(mock_harness)
        assert tools[0].is_concurrency_safe is False

    def test_required_params(self, mock_harness):
        tools = get_tools(mock_harness)
        required = tools[0].parameters.get("required", [])
        assert "task" in required

    def test_task_property_type(self, mock_harness):
        tools = get_tools(mock_harness)
        props = tools[0].parameters["properties"]
        assert props["task"]["type"] == "string"

    def test_effort_enum(self, mock_harness):
        tools = get_tools(mock_harness)
        props = tools[0].parameters["properties"]
        assert props["effort"]["enum"] == ["low", "medium", "high"]


# ---------------------------------------------------------------------------
# Handler — success
# ---------------------------------------------------------------------------

class TestHandlerSuccess:
    def _make_result(self, **overrides):
        """Build a mock SubAgentResult."""
        from nexgent.subagent import SubAgentState
        defaults = {
            "subagent_id": "abc12345",
            "task": "do something",
            "state": SubAgentState.COMPLETED,
            "result": "done",
            "error": None,
            "steps_taken": 3,
            "duration_seconds": 5.123,
            "token_usage": 1500,
            "metadata": {},
        }
        defaults.update(overrides)
        result = MagicMock()
        for k, v in defaults.items():
            setattr(result, k, v)
        return result

    def test_returns_json_with_result(self, mock_harness):
        from nexgent.subagent import SubAgentState
        mock_harness.subagent_manager.run_single.return_value = self._make_result()

        handler = _make_run_handler(mock_harness)
        raw = handler({"task": "do something"})
        data = json.loads(raw)

        assert data["subagent_id"] == "abc12345"
        assert data["state"] == "completed"
        assert data["result"] == "done"
        assert data["steps_taken"] == 3
        assert data["duration_seconds"] == 5.12
        assert data["token_usage"] == 1500

    def test_passes_config_to_manager(self, mock_harness):
        mock_harness.subagent_manager.run_single.return_value = self._make_result()

        handler = _make_run_handler(mock_harness)
        handler({
            "task": "analyze code",
            "description": "code analysis",
            "allowed_tools": ["read_file", "glob_files"],
            "effort": "high",
        })

        call_args = mock_harness.subagent_manager.run_single.call_args
        config = call_args[0][0]
        assert config.task == "analyze code"
        assert config.description == "code analysis"
        assert config.allowed_tools == ["read_file", "glob_files"]
        assert config.effort == "high"


# ---------------------------------------------------------------------------
# Handler — failure
# ---------------------------------------------------------------------------

class TestHandlerFailure:
    def test_failed_state_returns_error(self, mock_harness):
        from nexgent.subagent import SubAgentState
        result = MagicMock()
        result.subagent_id = "fail123"
        result.state = SubAgentState.FAILED
        result.result = None
        result.error = "LLM returned 400"
        result.steps_taken = 1
        result.duration_seconds = 2.0
        result.token_usage = 100
        mock_harness.subagent_manager.run_single.return_value = result

        handler = _make_run_handler(mock_harness)
        data = json.loads(handler({"task": "fail task"}))

        assert data["state"] == "failed"
        assert data["error"] == "LLM returned 400"
        assert "result" not in data

    def test_exception_returns_error_json(self, mock_harness):
        mock_harness.subagent_manager.run_single.side_effect = RuntimeError("boom")

        handler = _make_run_handler(mock_harness)
        data = json.loads(handler({"task": "crash"}))

        assert "error" in data
        assert "boom" in data["error"]


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

class TestDefaults:
    def test_default_effort_medium(self, mock_harness):
        from nexgent.subagent import SubAgentState
        result = MagicMock()
        result.subagent_id = "x"
        result.state = SubAgentState.COMPLETED
        result.result = "ok"
        result.error = None
        result.steps_taken = 1
        result.duration_seconds = 1.0
        result.token_usage = 100
        mock_harness.subagent_manager.run_single.return_value = result

        handler = _make_run_handler(mock_harness)
        handler({"task": "simple task"})

        config = mock_harness.subagent_manager.run_single.call_args[0][0]
        assert config.effort == "medium"

    def test_default_allowed_tools_none(self, mock_harness):
        from nexgent.subagent import SubAgentState
        result = MagicMock()
        result.subagent_id = "x"
        result.state = SubAgentState.COMPLETED
        result.result = "ok"
        result.error = None
        result.steps_taken = 1
        result.duration_seconds = 1.0
        result.token_usage = 100
        mock_harness.subagent_manager.run_single.return_value = result

        handler = _make_run_handler(mock_harness)
        handler({"task": "simple task"})

        config = mock_harness.subagent_manager.run_single.call_args[0][0]
        assert config.allowed_tools is None
