"""Monitor tool - background process watching.

Inspired by Claude Code's Monitor tool.
Allows watching long-running processes and filtering output.

Ch3 markers:
- monitor_start: write (spawns background process), not concurrency-safe
- monitor_stop: write (terminates process), not concurrency-safe
- monitor_list: read-only, concurrency-safe
"""

import json
import re
import subprocess
import threading
import platform
import uuid
from collections import deque
from .registry import ToolDef
from ..permissions import Permission

# Module-level state for active monitors
_monitors: dict = {}
_monitors_lock = threading.Lock()
MAX_MONITORS = 10


class MonitorJob:
    """Represents a background monitor watching a command's output."""

    def __init__(self, job_id: str, command: str, description: str,
                 filter_pattern: str = ""):
        self.job_id = job_id
        self.command = command
        self.description = description
        self.filter_pattern = filter_pattern
        self.process = None
        self.thread = None
        self.lines = deque(maxlen=1000)  # Keep last 1000 lines
        self.status = "starting"
        self._stop_event = threading.Event()
        self._filter_re = None
        if filter_pattern:
            try:
                self._filter_re = re.compile(filter_pattern)
            except re.error:
                self._filter_re = None

    def start(self):
        """Start the background process and monitoring thread."""
        try:
            # Scrub credential environment variables
            from .shell import _scrub_env
            env = _scrub_env()
            if platform.system() == "Windows":
                self.process = subprocess.Popen(
                    self.command,
                    shell=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    creationflags=subprocess.CREATE_NO_WINDOW,
                    env=env,
                )
            else:
                self.process = subprocess.Popen(
                    self.command,
                    shell=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    env=env,
                )
            self.status = "running"
            self.thread = threading.Thread(
                target=self._read_output, daemon=True
            )
            self.thread.start()
        except Exception as e:
            self.status = f"error: {e}"
            raise

    def _read_output(self):
        """Read process output in background thread."""
        try:
            for line in iter(self.process.stdout.readline, ""):
                if self._stop_event.is_set():
                    break
                line = line.rstrip("\n\r")
                if self._filter_re:
                    if self._filter_re.search(line):
                        self.lines.append(line)
                else:
                    self.lines.append(line)
            self.process.wait()
            if not self._stop_event.is_set():
                self.status = f"exited (code {self.process.returncode})"
        except Exception as e:
            if not self._stop_event.is_set():
                self.status = f"error: {e}"
        finally:
            # Close stdout pipe to prevent FD leak
            if self.process and self.process.stdout:
                try:
                    self.process.stdout.close()
                except Exception:
                    pass

    def stop(self):
        """Stop the monitor and terminate the process."""
        self._stop_event.set()
        if self.process and self.process.poll() is None:
            try:
                self.process.terminate()
                self.process.wait(timeout=5)
            except Exception:
                try:
                    self.process.kill()
                except Exception:
                    pass
        self.status = "stopped"

    def get_lines(self, count: int = 20) -> list[str]:
        """Get the last N lines of output."""
        return list(self.lines)[-count:]


def monitor_start(params: dict) -> str:
    """Start a background monitor that watches command output."""
    command = params.get("command", "")
    description = params.get("description", "Monitoring: " + command[:50])
    filter_pattern = params.get("filter_pattern", "")

    if not command:
        return json.dumps({"error": "No command provided"})

    with _monitors_lock:
        # Clean up dead monitors before checking the cap
        dead = [jid for jid, m in _monitors.items() if not m.process or m.process.poll() is not None]
        for jid in dead:
            _monitors.pop(jid, None)
        if len(_monitors) >= MAX_MONITORS:
            return json.dumps({
                "error": f"Maximum number of monitors ({MAX_MONITORS}) reached. Stop an existing monitor first.",
                "active_monitors": len(_monitors),
            })

    job_id = f"mon-{uuid.uuid4().hex[:8]}"

    try:
        monitor = MonitorJob(job_id, command, description, filter_pattern)
        monitor.start()
        with _monitors_lock:
            _monitors[job_id] = monitor

        return json.dumps({
            "job_id": job_id,
            "status": monitor.status,
            "description": description,
            "command": command,
            "filter_pattern": filter_pattern or "(none)",
        })
    except Exception as e:
        return json.dumps({"error": f"Failed to start monitor: {e}"})


def monitor_stop(params: dict) -> str:
    """Stop a running monitor."""
    job_id = params.get("job_id", "")
    if not job_id:
        return json.dumps({"error": "No job_id provided"})

    with _monitors_lock:
        monitor = _monitors.get(job_id)
        if not monitor:
            return json.dumps({
                "error": f"Monitor not found: {job_id}",
                "active_monitors": list(_monitors.keys()),
            })
        # Stop and remove atomically to prevent race with monitor_list/monitor_stop
        monitor.stop()
        recent_lines = monitor.get_lines(10)
        _monitors.pop(job_id, None)

    return json.dumps({
        "job_id": job_id,
        "status": "stopped",
        "lines_captured": len(monitor.lines),
        "recent_output": recent_lines,
    })


def monitor_list(params: dict) -> str:
    """List all active monitors."""
    with _monitors_lock:
        monitors_info = []
        for job_id, monitor in _monitors.items():
            monitors_info.append({
                "job_id": job_id,
                "command": monitor.command,
                "description": monitor.description,
                "status": monitor.status,
                "lines_captured": len(monitor.lines),
            })

    return json.dumps({
        "active_monitors": len(monitors_info),
        "monitors": monitors_info,
    })


def get_tools() -> list[ToolDef]:
    return [
        ToolDef(
            name="monitor_start",
            description="Start a background monitor that watches command output. Useful for watching logs, long-running processes, or periodic checks. Max 10 monitors.",
            parameters={
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "Shell command to run (e.g., 'tail -f app.log', 'ping localhost')",
                    },
                    "description": {
                        "type": "string",
                        "description": "Human-readable description of what is being monitored",
                    },
                    "filter_pattern": {
                        "type": "string",
                        "description": "Optional regex pattern to filter output lines (only matching lines are captured)",
                    },
                },
                "required": ["command", "description"],
            },
            handler=monitor_start,
            permission=Permission.WRITE,
            is_read_only=False,
            is_concurrency_safe=False,
        ),
        ToolDef(
            name="monitor_stop",
            description="Stop a running monitor by its job ID.",
            parameters={
                "type": "object",
                "properties": {
                    "job_id": {
                        "type": "string",
                        "description": "The monitor job ID returned by monitor_start",
                    },
                },
                "required": ["job_id"],
            },
            handler=monitor_stop,
            permission=Permission.WRITE,
            is_read_only=False,
            is_concurrency_safe=False,
        ),
        ToolDef(
            name="monitor_list",
            description="List all active background monitors with their status.",
            parameters={
                "type": "object",
                "properties": {},
            },
            handler=monitor_list,
            permission=Permission.READ,
            is_read_only=True,
            is_concurrency_safe=True,
        ),
    ]
