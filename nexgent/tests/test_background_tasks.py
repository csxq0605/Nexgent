"""Tests for the Background Tasks module."""

import os
import time
import pytest
from unittest.mock import patch, MagicMock

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from nexgent.background_tasks import (
    BackgroundTaskManager, BackgroundTask, TaskState, get_task_manager
)


class TestBackgroundTaskManager:
    """Test background task management."""

    def test_create_task(self):
        """Test creating a background task."""
        manager = BackgroundTaskManager()

        def dummy_task():
            return "done"

        task_id = manager.create_task("Test task", dummy_task)
        assert task_id is not None
        assert len(task_id) == 8

        # Wait for task to complete
        time.sleep(0.1)

        task = manager.get_task(task_id)
        assert task is not None
        assert task.description == "Test task"
        assert task.state == TaskState.COMPLETED
        assert task.output == "done"

    def test_create_task_with_error(self):
        """Test creating a task that fails."""
        manager = BackgroundTaskManager()

        def failing_task():
            raise ValueError("Test error")

        task_id = manager.create_task("Failing task", failing_task)

        # Wait for task to complete
        time.sleep(0.1)

        task = manager.get_task(task_id)
        assert task is not None
        assert task.state == TaskState.FAILED
        assert task.error == "Test error"

    def test_list_tasks(self):
        """Test listing tasks."""
        manager = BackgroundTaskManager()

        def dummy_task():
            return "done"

        manager.create_task("Task 1", dummy_task)
        manager.create_task("Task 2", dummy_task)

        # Wait for tasks to complete
        time.sleep(0.1)

        tasks = manager.list_tasks()
        assert len(tasks) == 2
        descriptions = [t['description'] for t in tasks]
        assert "Task 1" in descriptions
        assert "Task 2" in descriptions

    def test_cancel_task(self):
        """Test cancelling a task."""
        manager = BackgroundTaskManager()

        def long_task():
            time.sleep(10)
            return "done"

        task_id = manager.create_task("Long task", long_task)
        time.sleep(0.05)

        result = manager.cancel_task(task_id)
        assert result is True

        task = manager.get_task(task_id)
        assert task.state == TaskState.CANCELLED

    def test_cancel_nonexistent_task(self):
        """Test cancelling a non-existent task."""
        manager = BackgroundTaskManager()
        result = manager.cancel_task("nonexistent")
        assert result is False

    def test_get_task_output(self):
        """Test getting task output."""
        manager = BackgroundTaskManager()

        def dummy_task():
            return "output data"

        task_id = manager.create_task("Test task", dummy_task)
        time.sleep(0.1)

        output = manager.get_task_output(task_id)
        assert output == "output data"

    def test_cleanup_completed(self):
        """Test cleaning up completed tasks."""
        manager = BackgroundTaskManager()

        def dummy_task():
            return "done"

        manager.create_task("Task 1", dummy_task)
        manager.create_task("Task 2", dummy_task)

        time.sleep(0.1)

        assert len(manager.list_tasks()) == 2
        manager.cleanup_completed()
        assert len(manager.list_tasks()) == 0

    def test_get_duration(self):
        """Test task duration calculation."""
        manager = BackgroundTaskManager()

        def slow_task():
            time.sleep(0.1)
            return "done"

        task_id = manager.create_task("Slow task", slow_task)
        time.sleep(0.2)

        task = manager.get_task(task_id)
        duration = manager._get_duration(task)
        assert duration >= 0.1


class TestGetTaskManager:
    """Test global task manager singleton."""

    def test_singleton(self):
        """Test that get_task_manager returns the same instance."""
        manager1 = get_task_manager()
        manager2 = get_task_manager()
        assert manager1 is manager2


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
