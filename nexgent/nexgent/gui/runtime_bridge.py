"""The only Qt-to-runtime boundary."""

from __future__ import annotations

import threading
import time
from collections import deque

from PyQt6.QtCore import QObject, pyqtSignal

from ..runtime.events import RuntimeEvent


class RuntimeBridge(QObject):
    event_received = pyqtSignal(object)
    interaction_requested = pyqtSignal(object)
    run_started = pyqtSignal(str)
    run_finished = pyqtSignal(str)
    run_failed = pyqtSignal(str)
    busy_changed = pyqtSignal(bool)
    input_queued = pyqtSignal(str, int)
    guidance_injected = pyqtSignal(str)
    input_rejected = pyqtSignal(str, str)
    queue_cleared = pyqtSignal(int)
    input_finished = pyqtSignal(str, str)
    exit_requested = pyqtSignal()
    _worker_drained = pyqtSignal(object)

    def __init__(self, runtime, parent=None):
        super().__init__(parent)
        self.runtime = runtime
        self._busy = False
        self._closing = False
        self._state_lock = threading.RLock()
        self._pending = deque(maxlen=20)
        self._threads: set[threading.Thread] = set()
        runtime.set_event_sink(self._on_event)
        runtime.interaction_broker.set_handler(self._on_interaction)
        self._worker_drained.connect(self._finish_worker)

    @property
    def busy(self):
        return self._busy

    def submit(self, text: str) -> bool:
        value = text.strip()
        if not value:
            return False
        with self._state_lock:
            if self._closing:
                return False
            if self._busy:
                if value == "/btw" or value.startswith("/btw "):
                    guidance = value[4:].strip()
                    if not guidance:
                        return False
                    self.runtime.inject_guidance(guidance)
                    self._emit_signal(self.guidance_injected, guidance)
                    return True
                if len(self._pending) >= self._pending.maxlen:
                    self._emit_signal(
                        self.input_rejected, value, "Input queue is full"
                    )
                    return False
                self._pending.append(value)
                self._emit_signal(self.input_queued, value, len(self._pending))
                return True
            self._busy = True
        self._emit_signal(self.busy_changed, True)
        self._emit_signal(self.run_started, value)
        self._start_thread(value)
        return True

    def _emit_signal(self, signal, *args) -> None:
        with self._state_lock:
            if self._closing:
                return
        try:
            signal.emit(*args)
        except RuntimeError:
            # A late worker result must not target an already-destroyed Qt object.
            return

    def _start_thread(self, text: str) -> None:
        thread = threading.Thread(target=self._run, args=(text,), daemon=True)
        with self._state_lock:
            if self._closing:
                self._busy = False
                return
            self._threads.add(thread)
        thread.start()

    def _run(self, text: str) -> None:
        try:
            result = self.runtime.handle_input(text)
            self._emit_signal(self.run_finished, result)
            self._emit_signal(self.input_finished, text, result)
            if getattr(self.runtime, "last_command_action", "continue") == "quit":
                self._emit_signal(self.exit_requested)
        except Exception as exc:
            self._emit_signal(self.run_failed, str(exc))
        finally:
            with self._state_lock:
                if self._closing:
                    self._threads.discard(threading.current_thread())
                    self._busy = False
                    return
            self._emit_signal(self._worker_drained, threading.current_thread())

    def _finish_worker(self, worker: threading.Thread) -> None:
        """Advance the queue only after prior runtime events reach the Qt thread."""

        with self._state_lock:
            self._threads.discard(worker)
            next_input = (
                self._pending.popleft()
                if self._pending and not self._closing
                else None
            )
            self._busy = bool(next_input)
        if next_input:
            self._emit_signal(self.run_started, next_input)
            self._start_thread(next_input)
        else:
            self._emit_signal(self.busy_changed, False)

    def _on_event(self, event: RuntimeEvent) -> None:
        self._emit_signal(self.event_received, event)

    def _on_interaction(self, request):
        self._emit_signal(self.interaction_requested, request)
        return None

    def abort(self) -> None:
        with self._state_lock:
            cleared = len(self._pending)
            self._pending.clear()
        if cleared:
            self._emit_signal(self.queue_cleared, cleared)
        self.runtime.abort()

    def close(self, timeout: float = 5.0) -> bool:
        with self._state_lock:
            if self._closing:
                threads = list(self._threads)
            else:
                self._closing = True
                self._pending.clear()
                threads = list(self._threads)
        self.runtime.set_event_sink(None)
        self.runtime.interaction_broker.set_handler(None)
        self.runtime.abort()
        deadline = time.monotonic() + max(0.0, timeout)
        current = threading.current_thread()
        for thread in threads:
            if thread is current:
                continue
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            thread.join(remaining)
        self.runtime.close()
        return not any(thread.is_alive() for thread in threads)
