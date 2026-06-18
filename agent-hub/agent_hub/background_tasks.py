"""Background Tasks system - run tasks in the background.

Implements Claude Code-style background tasks:
- Run tasks in background with unique IDs
- Track task status and output
- /tasks command for management
- Automatic cleanup on exit
"""

import os
import time
import uuid
import threading
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, Dict, List, Any, Callable
from pathlib import Path


class TaskState(Enum):
    """Background task state."""
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class BackgroundTask:
    """Represents a background task."""
    task_id: str
    description: str
    state: TaskState = TaskState.PENDING
    output: str = ""
    error: Optional[str] = None
    start_time: float = 0.0
    end_time: float = 0.0
    thread: Optional[threading.Thread] = None
    cancel_event: threading.Event = field(default_factory=threading.Event)


class BackgroundTaskManager:
    """Manage background tasks."""

    def __init__(self):
        self.tasks: Dict[str, BackgroundTask] = {}
        self._lock = threading.Lock()

    def create_task(self, description: str, func: Callable, *args, **kwargs) -> str:
        """Create and start a background task."""
        task_id = str(uuid.uuid4())[:8]
        task = BackgroundTask(
            task_id=task_id,
            description=description,
        )

        with self._lock:
            self.tasks[task_id] = task

        # Start task in background thread
        def run_task():
            with self._lock:
                task.state = TaskState.RUNNING
            task.start_time = time.time()
            try:
                # Check cancellation before starting
                if task.cancel_event.is_set():
                    with self._lock:
                        task.state = TaskState.CANCELLED
                    return
                result = func(*args, **kwargs)
                # Check cancellation after completion — cancel wins over completed
                if task.cancel_event.is_set():
                    with self._lock:
                        task.state = TaskState.CANCELLED
                else:
                    with self._lock:
                        task.output = str(result) if result is not None else ""
                        task.state = TaskState.COMPLETED
            except Exception as e:
                if task.cancel_event.is_set():
                    with self._lock:
                        task.state = TaskState.CANCELLED
                else:
                    with self._lock:
                        task.error = str(e)
                        task.state = TaskState.FAILED
            finally:
                task.end_time = time.time()

        thread = threading.Thread(target=run_task, daemon=True)
        task.thread = thread
        thread.start()

        return task_id

    def get_task(self, task_id: str) -> Optional[BackgroundTask]:
        """Get a task by ID."""
        with self._lock:
            return self.tasks.get(task_id)

    def list_tasks(self) -> List[Dict[str, Any]]:
        """List all tasks."""
        with self._lock:
            return [
                {
                    'id': task.task_id,
                    'description': task.description,
                    'state': task.state.value,
                    'duration': self._get_duration(task),
                }
                for task in self.tasks.values()
            ]

    def cancel_task(self, task_id: str) -> bool:
        """Cancel a running task."""
        with self._lock:
            task = self.tasks.get(task_id)
            if not task or task.state not in (TaskState.PENDING, TaskState.RUNNING):
                return False

            task.cancel_event.set()
            task.state = TaskState.CANCELLED
            task.end_time = time.time()
            return True

    def get_task_output(self, task_id: str) -> Optional[str]:
        """Get task output."""
        with self._lock:
            task = self.tasks.get(task_id)
            if not task:
                return None
            return task.output

    def wait_for_task(self, task_id: str, timeout: float = None) -> bool:
        """Wait for a task to complete."""
        task = self.get_task(task_id)
        if not task:
            return False
        if task.thread:
            task.thread.join(timeout=timeout)
            return task.state in (TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELLED)
        return False

    def cleanup_completed(self):
        """Remove completed tasks."""
        with self._lock:
            completed = [
                task_id for task_id, task in self.tasks.items()
                if task.state in (TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELLED)
            ]
            for task_id in completed:
                del self.tasks[task_id]

    def _get_duration(self, task: BackgroundTask) -> float:
        """Get task duration in seconds."""
        if task.start_time == 0:
            return 0
        end = task.end_time if task.end_time > 0 else time.time()
        return end - task.start_time


# Global task manager instance
_task_manager = None
_task_manager_lock = threading.Lock()


def get_task_manager() -> BackgroundTaskManager:
    """Get the global task manager instance (thread-safe double-checked locking)."""
    global _task_manager
    if _task_manager is None:
        with _task_manager_lock:
            if _task_manager is None:
                _task_manager = BackgroundTaskManager()
    return _task_manager
