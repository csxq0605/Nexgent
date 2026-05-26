"""Scheduler tools - session-scoped cron-like task scheduling.

Implements Claude Code's scheduling pattern:
- CronCreate: Schedule a prompt to fire at intervals
- CronDelete: Cancel a scheduled task
- CronList: List all scheduled tasks

Jobs live only in the current session — they are in-memory and
do not persist to disk. They fire while the REPL is idle.
"""

import json
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Optional, Callable

from .registry import ToolDef
from ..permissions import Permission


@dataclass
class CronJob:
    """A single scheduled job."""
    job_id: str
    cron_expr: str
    prompt: str
    recurring: bool = True
    created_at: float = field(default_factory=time.time)
    last_fired: float = 0.0
    fire_count: int = 0
    max_fires: int = 0  # 0 = unlimited


def _parse_cron_field(field_val: str, min_val: int, max_val: int) -> set[int]:
    """Parse a single cron field into a set of valid values."""
    values = set()
    for part in field_val.split(","):
        part = part.strip()
        if part == "*":
            values.update(range(min_val, max_val + 1))
        elif part.startswith("*/"):
            step = int(part[2:])
            values.update(range(min_val, max_val + 1, step))
        elif "-" in part:
            start, end = part.split("-", 1)
            values.update(range(int(start), int(end) + 1))
        else:
            values.add(int(part))
    return values


def _match_cron(cron_expr: str, now: time.struct_time) -> bool:
    """Check if a cron expression matches the current time.

    Supports standard 5-field cron: minute hour day-of-month month day-of-week
    """
    fields = cron_expr.split()
    if len(fields) != 5:
        return False

    minute, hour, dom, month, dow = fields
    checks = [
        (minute, now.tm_min, 0, 59),
        (hour, now.tm_hour, 0, 23),
        (dom, now.tm_mday, 1, 31),
        (month, now.tm_mon, 1, 12),
        (dow, now.tm_wday, 0, 6),  # 0=Monday in Python
    ]

    for field_val, current, min_val, max_val in checks:
        valid = _parse_cron_field(field_val, min_val, max_val)
        if current not in valid:
            return False
    return True


class Scheduler:
    """Session-scoped task scheduler.

    Jobs are in-memory only and do not survive session restarts.
    The scheduler checks for due jobs at regular intervals and
    calls the provided callback with the job's prompt.
    """

    def __init__(self, callback: Optional[Callable[[str], None]] = None):
        self._jobs: dict[str, CronJob] = {}
        self._next_id = 1
        self._callback = callback
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._checker_thread: Optional[threading.Thread] = None

    def set_callback(self, callback: Callable[[str], None]):
        """Set the callback function to invoke when a job fires."""
        self._callback = callback

    def create_job(
        self,
        cron_expr: str,
        prompt: str,
        recurring: bool = True,
    ) -> str:
        """Create a new scheduled job.

        Args:
            cron_expr: 5-field cron expression (minute hour dom month dow)
            prompt: The prompt to enqueue when the job fires
            recurring: If True, fires repeatedly; if False, fires once then deletes

        Returns:
            The job ID.
        """
        with self._lock:
            job_id = f"cron-{self._next_id}"
            self._next_id += 1
            self._jobs[job_id] = CronJob(
                job_id=job_id,
                cron_expr=cron_expr,
                prompt=prompt,
                recurring=recurring,
            )
        return job_id

    def delete_job(self, job_id: str) -> bool:
        """Delete a scheduled job. Returns True if found and deleted."""
        with self._lock:
            if job_id in self._jobs:
                del self._jobs[job_id]
                return True
            return False

    def list_jobs(self) -> list[dict]:
        """List all scheduled jobs."""
        with self._lock:
            return [
                {
                    "job_id": j.job_id,
                    "cron": j.cron_expr,
                    "prompt": j.prompt[:80] + ("..." if len(j.prompt) > 80 else ""),
                    "recurring": j.recurring,
                    "fire_count": j.fire_count,
                }
                for j in self._jobs.values()
            ]

    def check_and_fire(self):
        """Check for due jobs and fire them. Call this from the REPL loop."""
        now = time.time()
        now_struct = time.localtime(now)
        fired = []

        with self._lock:
            for job in list(self._jobs.values()):
                # Don't fire if fired in the last 30 seconds
                if now - job.last_fired < 30:
                    continue
                if _match_cron(job.cron_expr, now_struct):
                    job.last_fired = now
                    job.fire_count += 1
                    fired.append(job)
                    # Remove non-recurring jobs after firing
                    if not job.recurring:
                        del self._jobs[job.job_id]

        # Fire callbacks outside the lock
        for job in fired:
            if self._callback:
                try:
                    self._callback(job.prompt)
                except Exception:
                    pass

    def start_background_checker(self, interval: float = 30.0):
        """Start a background thread that checks for due jobs."""
        def _checker():
            while not self._stop_event.is_set():
                self.check_and_fire()
                self._stop_event.wait(interval)

        self._stop_event.clear()
        self._checker_thread = threading.Thread(target=_checker, daemon=True)
        self._checker_thread.start()

    def stop(self):
        """Stop the background checker."""
        self._stop_event.set()
        if self._checker_thread:
            self._checker_thread.join(timeout=5)


# Global scheduler instance
_scheduler: Optional[Scheduler] = None


def get_scheduler() -> Optional[Scheduler]:
    """Get the global scheduler instance."""
    return _scheduler


def set_scheduler(scheduler: Scheduler):
    """Set the global scheduler instance."""
    global _scheduler
    _scheduler = scheduler


def cron_create(params: dict) -> str:
    """Schedule a prompt to be enqueued at a future time.

    Supports both recurring schedules and one-shot reminders.
    Uses standard 5-field cron: minute hour day-of-month month day-of-week.

    Examples:
        "*/5 * * * *"  = every 5 minutes
        "0 9 * * 1-5"  = weekdays at 9am
        "30 14 28 2 *" = Feb 28 at 2:30pm

    Args:
        params: dict with keys:
            - cron (str): 5-field cron expression
            - prompt (str): The prompt to enqueue at each fire time
            - recurring (bool, optional): True (default) = repeated, False = one-shot

    Returns:
        Job ID for later deletion.
    """
    cron_expr = params.get("cron", "")
    prompt = params.get("prompt", "")
    recurring = params.get("recurring", True)

    if not cron_expr:
        return json.dumps({"error": "No cron expression provided"})
    if not prompt:
        return json.dumps({"error": "No prompt provided"})

    # Validate cron expression
    fields = cron_expr.split()
    if len(fields) != 5:
        return json.dumps({
            "error": "Cron expression must have 5 fields: minute hour day-of-month month day-of-week",
            "example": "*/5 * * * * (every 5 minutes)",
        })

    scheduler = get_scheduler()
    if not scheduler:
        return json.dumps({"error": "Scheduler not initialized"})

    job_id = scheduler.create_job(cron_expr, prompt, recurring)
    return json.dumps({
        "job_id": job_id,
        "cron": cron_expr,
        "prompt": prompt,
        "recurring": recurring,
        "message": f"Scheduled job {job_id} with cron '{cron_expr}'",
    })


def cron_delete(params: dict) -> str:
    """Cancel a cron job previously scheduled with CronCreate.

    Args:
        params: dict with key:
            - job_id (str): Job ID returned by CronCreate

    Returns:
        Success or error message.
    """
    job_id = params.get("job_id", "")
    if not job_id:
        return json.dumps({"error": "No job_id provided"})

    scheduler = get_scheduler()
    if not scheduler:
        return json.dumps({"error": "Scheduler not initialized"})

    if scheduler.delete_job(job_id):
        return json.dumps({"message": f"Job {job_id} deleted"})
    return json.dumps({"error": f"Job {job_id} not found"})


def cron_list(params: dict) -> str:
    """List all cron jobs scheduled via CronCreate in this session.

    Returns:
        List of scheduled jobs.
    """
    scheduler = get_scheduler()
    if not scheduler:
        return json.dumps({"error": "Scheduler not initialized"})

    jobs = scheduler.list_jobs()
    if not jobs:
        return json.dumps({"jobs": [], "message": "No scheduled jobs"})
    return json.dumps({"jobs": jobs, "count": len(jobs)})


def get_tools() -> list[ToolDef]:
    return [
        ToolDef(
            name="cron_create",
            description=(
                "Schedule a prompt to be enqueued at a future time. "
                "Supports both recurring schedules and one-shot reminders. "
                "Uses standard 5-field cron: minute hour day-of-month month day-of-week. "
                "Jobs live only in this session — nothing is written to disk."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "cron": {
                        "type": "string",
                        "description": "5-field cron expression (e.g. '*/5 * * * *' for every 5 min)",
                    },
                    "prompt": {
                        "type": "string",
                        "description": "The prompt to enqueue at each fire time",
                    },
                    "recurring": {
                        "type": "boolean",
                        "description": "True = repeated, False = one-shot (default: true)",
                    },
                },
                "required": ["cron", "prompt"],
            },
            handler=cron_create,
            permission=Permission.READ,
            is_read_only=True,
            is_concurrency_safe=False,
        ),
        ToolDef(
            name="cron_delete",
            description="Cancel a cron job previously scheduled with cron_create.",
            parameters={
                "type": "object",
                "properties": {
                    "job_id": {
                        "type": "string",
                        "description": "Job ID returned by cron_create",
                    },
                },
                "required": ["job_id"],
            },
            handler=cron_delete,
            permission=Permission.READ,
            is_read_only=True,
            is_concurrency_safe=False,
        ),
        ToolDef(
            name="cron_list",
            description="List all cron jobs scheduled via cron_create in this session.",
            parameters={
                "type": "object",
                "properties": {},
                "required": [],
            },
            handler=cron_list,
            permission=Permission.READ,
            is_read_only=True,
            is_concurrency_safe=True,
        ),
    ]
