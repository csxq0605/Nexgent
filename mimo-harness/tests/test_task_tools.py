"""Tests for task tools - CRUD operations, thread safety, status transitions."""

import json
import pytest
from mimo_harness.tools.task_tools import (
    task_create, task_get, task_list,
    task_update, task_delete, get_tools, _task_store,
)


class TestTaskToolFunctions:
    """Test the tool handler functions (task_create, task_get, etc.)."""

    def _reset_store(self):
        """Reset the global task store for test isolation."""
        _task_store._tasks.clear()
        _task_store._next_id = 1

    def setup_method(self):
        self._reset_store()

    def teardown_method(self):
        self._reset_store()

    def test_task_create(self):
        result = json.loads(task_create({"subject": "New task", "description": "Details"}))
        assert "id" in result
        assert result["subject"] == "New task"
        assert result["status"] == "pending"

    def test_task_create_with_active_form(self):
        result = json.loads(task_create({
            "subject": "Build feature",
            "activeForm": "Building the feature",
        }))
        assert result["subject"] == "Build feature"

    def test_task_get_existing(self):
        created = json.loads(task_create({"subject": "Get me"}))
        result = json.loads(task_get({"taskId": created["id"]}))
        assert result["subject"] == "Get me"
        assert result["status"] == "pending"
        assert "description" in result
        assert "blocks" in result
        assert "blockedBy" in result

    def test_task_get_nonexistent(self):
        result = json.loads(task_get({"taskId": "999"}))
        assert "error" in result

    def test_task_list_empty(self):
        result = json.loads(task_list({}))
        assert result == {"tasks": []}

    def test_task_list_with_tasks(self):
        task_create({"subject": "Task A"})
        task_create({"subject": "Task B"})
        result = json.loads(task_list({}))
        assert len(result["tasks"]) == 2
        subjects = [t["subject"] for t in result["tasks"]]
        assert "Task A" in subjects
        assert "Task B" in subjects

    def test_task_list_excludes_deleted(self):
        t1 = json.loads(task_create({"subject": "Keep"}))
        t2 = json.loads(task_create({"subject": "Remove"}))
        task_delete({"taskId": t2["id"]})
        result = json.loads(task_list({}))
        assert len(result["tasks"]) == 1
        assert result["tasks"][0]["subject"] == "Keep"

    def test_task_update_status(self):
        created = json.loads(task_create({"subject": "Update me"}))
        result = json.loads(task_update({
            "taskId": created["id"],
            "status": "completed",
        }))
        assert result["status"] == "completed"

    def test_task_update_subject(self):
        created = json.loads(task_create({"subject": "Old subject"}))
        result = json.loads(task_update({
            "taskId": created["id"],
            "subject": "New subject",
        }))
        assert result["id"] == created["id"]
        # Verify via get
        get_result = json.loads(task_get({"taskId": created["id"]}))
        assert get_result["subject"] == "New subject"

    def test_task_update_nonexistent(self):
        result = json.loads(task_update({"taskId": "999", "status": "completed"}))
        assert "error" in result

    def test_task_delete_existing(self):
        created = json.loads(task_create({"subject": "Delete me"}))
        result = json.loads(task_delete({"taskId": created["id"]}))
        assert result["status"] == "deleted"

    def test_task_delete_nonexistent(self):
        result = json.loads(task_delete({"taskId": "999"}))
        assert "error" in result


class TestTaskToolsGetTools:
    """Test get_tools() returns proper ToolDefs."""

    def test_returns_five_tools(self):
        tools = get_tools()
        assert len(tools) == 5

    def test_tool_names(self):
        tools = get_tools()
        names = [t.name for t in tools]
        assert "task_create" in names
        assert "task_get" in names
        assert "task_list" in names
        assert "task_update" in names
        assert "task_delete" in names

    def test_all_handlers_assigned(self):
        tools = get_tools()
        for tool in tools:
            assert tool.handler is not None
            assert callable(tool.handler)

    def test_task_get_is_concurrency_safe(self):
        tools = get_tools()
        task_get_tool = next(t for t in tools if t.name == "task_get")
        assert task_get_tool.is_concurrency_safe is True

    def test_task_list_is_concurrency_safe(self):
        tools = get_tools()
        task_list_tool = next(t for t in tools if t.name == "task_list")
        assert task_list_tool.is_concurrency_safe is True


class TestTaskUpdateOwner:
    """Test task_update owner field handling."""

    def _reset_store(self):
        _task_store._tasks.clear()
        _task_store._next_id = 1

    def setup_method(self):
        self._reset_store()

    def teardown_method(self):
        self._reset_store()

    def test_update_owner(self):
        """task_update sets owner field on a task."""
        created = json.loads(task_create({"subject": "Owned task"}))
        result = json.loads(task_update({
            "taskId": created["id"],
            "owner": "agent-1",
        }))
        assert result["id"] == created["id"]
        # Verify via task_get — owner is not in task_get output, so use task_list
        listed = json.loads(task_list({}))
        task = next(t for t in listed["tasks"] if t["id"] == created["id"])
        assert task["owner"] == "agent-1"

    def test_update_owner_empty_string(self):
        """task_update can clear owner by setting empty string."""
        created = json.loads(task_create({"subject": "Task"}))
        task_update({"taskId": created["id"], "owner": "agent-1"})
        task_update({"taskId": created["id"], "owner": ""})
        listed = json.loads(task_list({}))
        task = next(t for t in listed["tasks"] if t["id"] == created["id"])
        assert task["owner"] == ""

    def test_update_owner_and_status_simultaneously(self):
        """task_update can set owner and status in one call."""
        created = json.loads(task_create({"subject": "Multi update"}))
        result = json.loads(task_update({
            "taskId": created["id"],
            "owner": "agent-2",
            "status": "in_progress",
        }))
        assert result["status"] == "in_progress"
        listed = json.loads(task_list({}))
        task = next(t for t in listed["tasks"] if t["id"] == created["id"])
        assert task["owner"] == "agent-2"

    def test_task_get_returns_blocks_and_blockedby(self):
        """task_get includes blocks and blockedBy fields (even if empty)."""
        created = json.loads(task_create({"subject": "Deps task"}))
        result = json.loads(task_get({"taskId": created["id"]}))
        assert "blocks" in result
        assert "blockedBy" in result
        assert result["blocks"] == []
        assert result["blockedBy"] == []

    def test_task_list_returns_blockedby(self):
        """task_list includes blockedBy field for each task."""
        created = json.loads(task_create({"subject": "Listed task"}))
        result = json.loads(task_list({}))
        task = next(t for t in result["tasks"] if t["id"] == created["id"])
        assert "blockedBy" in task
