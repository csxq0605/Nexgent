import json
import time
import threading
from dataclasses import dataclass, field
from typing import Optional
from .registry import ToolDef
from ..permissions import Permission


@dataclass
class Task:
    id: str
    subject: str
    description: str = ""
    status: str = "pending"  # pending, in_progress, completed, deleted
    active_form: str = ""
    owner: str = ""
    created_at: float = field(default_factory=time.time)
    metadata: dict = field(default_factory=dict)
    blocks: list = field(default_factory=list)
    blocked_by: list = field(default_factory=list)


class TaskStore:
    def __init__(self):
        self._tasks: dict[str, Task] = {}
        self._next_id = 1
        self._lock = threading.Lock()

    def create(self, subject, description="", active_form="", metadata=None) -> Task:
        with self._lock:
            task = Task(
                id=str(self._next_id),
                subject=subject,
                description=description,
                active_form=active_form,
                metadata=metadata or {},
            )
            self._tasks[task.id] = task
            self._next_id += 1
            return task

    def get(self, task_id: str) -> Optional[Task]:
        with self._lock:
            return self._tasks.get(task_id)

    def list_all(self) -> list[Task]:
        with self._lock:
            return [t for t in self._tasks.values() if t.status != "deleted"]

    _UPDATABLE_FIELDS = frozenset({"subject", "description", "status", "active_form", "owner", "metadata"})

    def update(self, task_id: str, **kwargs) -> Optional[Task]:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return None
            for key, value in kwargs.items():
                if key in self._UPDATABLE_FIELDS:
                    setattr(task, key, value)
            return task

    def delete(self, task_id: str) -> bool:
        with self._lock:
            task = self._tasks.get(task_id)
            if task:
                task.status = "deleted"
                return True
            return False


# Global task store
_task_store = TaskStore()


def task_create(params):
    task = _task_store.create(
        subject=params.get("subject", ""),
        description=params.get("description", ""),
        active_form=params.get("activeForm", ""),
        metadata=params.get("metadata"),
    )
    return json.dumps({"id": task.id, "subject": task.subject, "status": task.status})


def task_get(params):
    task = _task_store.get(params.get("taskId", ""))
    if not task:
        return json.dumps({"error": "Task not found"})
    return json.dumps({
        "id": task.id,
        "subject": task.subject,
        "description": task.description,
        "status": task.status,
        "activeForm": task.active_form,
        "blocks": task.blocks,
        "blockedBy": task.blocked_by,
    })


def task_list(params):
    tasks = _task_store.list_all()
    return json.dumps([
        {
            "id": t.id,
            "subject": t.subject,
            "status": t.status,
            "owner": t.owner,
            "blockedBy": t.blocked_by,
        }
        for t in tasks
    ])


def task_update(params):
    kwargs = {}
    if "status" in params:
        kwargs["status"] = params["status"]
    if "subject" in params:
        kwargs["subject"] = params["subject"]
    if "description" in params:
        kwargs["description"] = params["description"]
    if "activeForm" in params:
        kwargs["active_form"] = params["activeForm"]
    if "owner" in params:
        kwargs["owner"] = params["owner"]
    task = _task_store.update(params.get("taskId", ""), **kwargs)
    if not task:
        return json.dumps({"error": "Task not found"})
    return json.dumps({"id": task.id, "status": task.status})


def task_delete(params):
    if _task_store.delete(params.get("taskId", "")):
        return json.dumps({"status": "deleted"})
    return json.dumps({"error": "Task not found"})


def get_tools():
    return [
        ToolDef(
            name="task_create",
            description="Create a new task",
            parameters={
                "type": "object",
                "properties": {
                    "subject": {"type": "string"},
                    "description": {"type": "string"},
                    "activeForm": {"type": "string"},
                },
                "required": ["subject"],
            },
            handler=task_create,
            permission=Permission.WRITE,
            is_read_only=False,
            is_concurrency_safe=False,
        ),
        ToolDef(
            name="task_get",
            description="Get task details by ID",
            parameters={
                "type": "object",
                "properties": {"taskId": {"type": "string"}},
                "required": ["taskId"],
            },
            handler=task_get,
            permission=Permission.READ,
            is_read_only=True,
            is_concurrency_safe=True,
        ),
        ToolDef(
            name="task_list",
            description="List all tasks",
            parameters={"type": "object", "properties": {}},
            handler=task_list,
            permission=Permission.READ,
            is_read_only=True,
            is_concurrency_safe=True,
        ),
        ToolDef(
            name="task_update",
            description="Update a task",
            parameters={
                "type": "object",
                "properties": {
                    "taskId": {"type": "string"},
                    "status": {"type": "string"},
                    "subject": {"type": "string"},
                    "description": {"type": "string"},
                    "activeForm": {"type": "string"},
                    "owner": {"type": "string"},
                },
                "required": ["taskId"],
            },
            handler=task_update,
            permission=Permission.WRITE,
            is_read_only=False,
            is_concurrency_safe=False,
        ),
        ToolDef(
            name="task_delete",
            description="Delete a task",
            parameters={
                "type": "object",
                "properties": {"taskId": {"type": "string"}},
                "required": ["taskId"],
            },
            handler=task_delete,
            permission=Permission.WRITE,
            is_read_only=False,
            is_concurrency_safe=False,
        ),
    ]
