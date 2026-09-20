"""Host runner with synchronous RPC and a joined cancellation watchdog."""

from __future__ import annotations

import json
import math
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from tempfile import TemporaryDirectory

from ..kernel.programs import canonical
from .packages import CAPABILITIES, PackageError, resolve_entry, verify_package


class CapabilityAbort(BaseException):
    """Abort package execution while preserving a host-side exception.

    This control signal is intentionally outside ``Exception`` so controlled
    package code cannot turn an uncertain durable call, cancellation, or model
    provider failure into a repairable action observation.
    """

    def __init__(self, cause):
        if not isinstance(cause, Exception):
            raise TypeError("Capability aborts require an Exception cause")
        super().__init__(str(cause))
        self.cause = cause


def run_package(package, entry, payload, handle=None, *, stop_event=None,
                timeout=90, max_rpc=128, max_instructions=2_000_000):
    """Execute a package with no host authority except explicit RPC requests.

Handlers run synchronously in the calling thread. The watchdog terminates the
worker and signals stop_event during an active handler; trusted handlers must
observe that event for prompt interruption. No RPC work is abandoned in daemon
threads when the runner returns.
    """
    verify_package(package)
    resolve_entry(package, entry)
    if (isinstance(timeout, bool) or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout) or not 0 < timeout <= 1800):
        raise ValueError("Package deadline must be in (0, 1800] seconds")
    if type(max_rpc) is not int or not 0 <= max_rpc <= 100_000:
        raise ValueError("Invalid package RPC limit")
    if type(max_instructions) is not int or not 0 < max_instructions <= 100_000_000:
        raise ValueError("Invalid package instruction limit")
    stop_event = stop_event if stop_event is not None else threading.Event()
    if stop_event.is_set():
        raise InterruptedError("Package execution stopped")
    try:
        request = canonical({"package": package, "entry": entry, "payload": payload,
                             "max_rpc": max_rpc, "max_instructions": max_instructions})
    except (ValueError, TypeError, RecursionError) as exc:
        raise PackageError(f"Package input must be finite JSON: {exc}") from None
    if len(request.encode("utf-8")) > 1_500_000:
        raise PackageError("Package input exceeded budget")
    environment = {key: value for key, value in os.environ.items()
                   if key.upper() in {"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL"}}
    environment.update(PYTHONPATH=str(Path(__file__).resolve().parents[2]),
                       PYTHONIOENCODING="utf-8", OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1", MKL_NUM_THREADS="1")
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    with TemporaryDirectory(prefix="nexgent-package-") as directory:
        process = subprocess.Popen([sys.executable, "-m", "nexgent.tasks.package_worker"],
                                   cwd=directory, env=environment, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, encoding="utf-8", bufsize=1, **options)
        messages = queue.Queue()
        errors = []
        finished = threading.Event()
        interrupted = []
        deadline = time.monotonic() + timeout

        def read_output():
            try:
                for line in iter(lambda: process.stdout.readline(1_500_001), ""):
                    messages.put(line)
            finally:
                messages.put(None)

        def read_error():
            total = 0
            for line in iter(lambda: process.stderr.readline(8001), ""):
                if total < 12_000:
                    errors.append(line[:12_000 - total])
                    total += len(line)

        def watchdog():
            while not finished.wait(0.025):
                reason = "cancelled" if stop_event.is_set() else "timeout" if time.monotonic() >= deadline else None
                if reason:
                    interrupted.append(reason)
                    stop_event.set()
                    if process.poll() is None:
                        try:
                            process.kill()
                        except ProcessLookupError:
                            pass
                    return

        def check_stop():
            reason = interrupted[0] if interrupted else None
            if reason == "timeout" or reason is None and time.monotonic() >= deadline:
                stop_event.set()
                raise TimeoutError(f"Package {entry} exceeded {timeout}s")
            if reason == "cancelled" or stop_event.is_set():
                raise InterruptedError("Package execution stopped; worker terminated")

        readers = [threading.Thread(target=read_output, name="nexgent-package-stdout"),
                   threading.Thread(target=read_error, name="nexgent-package-stderr")]
        guard = threading.Thread(target=watchdog, name="nexgent-package-watchdog")
        for thread in [*readers, guard]:
            thread.start()
        rpc_count = 0
        try:
            process.stdin.write(request + "\n")
            process.stdin.flush()
            while True:
                check_stop()
                try:
                    line = messages.get(timeout=0.05)
                except queue.Empty:
                    continue
                check_stop()
                if line is None:
                    raise PackageError("Package worker exited without a result: " + "".join(errors)[-1800:])
                if len(line.encode("utf-8")) > 1_500_000:
                    raise PackageError("Package output exceeded budget")
                try:
                    message = json.loads(line)
                except ValueError:
                    raise PackageError("Invalid package worker protocol") from None
                if "error" in message:
                    raise PackageError(message["error"])
                if "result" in message:
                    result = message["result"]
                    if result["execution"]["rpc_count"] != rpc_count:
                        raise PackageError("Package RPC receipt count mismatch")
                    return result
                rpc = message.get("rpc")
                if not isinstance(rpc, dict) or rpc.get("method") not in CAPABILITIES or not isinstance(rpc.get("params"), dict):
                    raise PackageError("Unknown package capability request")
                rpc_count += 1
                if rpc_count > max_rpc or rpc.get("id") != rpc_count:
                    raise PackageError("Package RPC sequence or budget violation")
                if handle is None:
                    raise PackageError("This package execution has no external capabilities")
                try:
                    response = {"value": handle(rpc["method"], rpc["params"])}
                    response_text = canonical(response)
                except CapabilityAbort as abort:
                    raise abort.cause
                except Exception as exc:
                    response_text = canonical({"error": f"{type(exc).__name__}: {str(exc)[:1200]}"})
                check_stop()
                if len(response_text.encode("utf-8")) > 1_500_000:
                    raise PackageError("Package capability response exceeded budget")
                process.stdin.write(response_text + "\n")
                process.stdin.flush()
        except (BrokenPipeError, OSError):
            check_stop()
            raise PackageError("Package worker communication failed") from None
        finally:
            finished.set()
            guard.join()
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            for reader in readers:
                reader.join()
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()
