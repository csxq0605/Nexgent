"""Disposable source processes with synchronous, capability-scoped RPC."""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from .programs import ProgramError, canonical, verify_bundle


class ProgramRunner:
    def run(self, bundle, entry, argument, *, handler=None, timeout=90, stop_event=None,
            max_work_units=20_000_000):
        verify_bundle(bundle)
        stop_event = stop_event or threading.Event()
        if timeout <= 0 or timeout > 900:
            raise ValueError("Source process deadline must be in (0, 900] seconds")
        environment = {k: v for k, v in os.environ.items() if k.upper() in {
            "SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP", "USERPROFILE", "LANG", "LC_ALL"}}
        environment.update(PYTHONPATH=str(Path(__file__).resolve().parents[2]),
                           PYTHONIOENCODING="utf-8", OPENBLAS_NUM_THREADS="1",
                           OMP_NUM_THREADS="1", MKL_NUM_THREADS="1")
        options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
        request = canonical({"bundle": bundle, "entry": entry, "argument": argument,
                             "max_work_units": max_work_units})
        if len(request) > 1_500_000:
            raise ProgramError("Source input exceeded budget")
        with tempfile.TemporaryDirectory(prefix="nexgent-source-") as directory:
            process = subprocess.Popen([sys.executable, "-m", "nexgent.kernel.worker"],
                        cwd=directory, env=environment, stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        text=True, encoding="utf-8", bufsize=1, **options)
            messages = queue.Queue()
            errors = []

            def read_output():
                while True:
                    line = process.stdout.readline(2_000_001)
                    if not line:
                        break
                    messages.put(line)
                messages.put(None)

            def read_error():
                while True:
                    line = process.stderr.readline(8001)
                    if not line:
                        break
                    if sum(map(len, errors)) < 12000:
                        errors.append(line)

            readers = [threading.Thread(target=read_output, daemon=True), threading.Thread(target=read_error, daemon=True)]
            for reader in readers:
                reader.start()
            deadline = time.monotonic() + timeout
            rpc_count = 0
            dispatch_threads = []

            def check_cancel():
                if stop_event.is_set():
                    raise InterruptedError("Research stopped; source worker terminated")
                if time.monotonic() >= deadline:
                    stop_event.set()  # Propagate cancellation into trusted capability workers.
                    raise TimeoutError(f"Source {entry} exceeded {timeout}s")

            def dispatch(method, params):
                completed = queue.Queue(maxsize=1)
                def invoke():
                    try:
                        completed.put({"value": handler(method, params)})
                    except Exception as exc:
                        completed.put({"error": f"{type(exc).__name__}: {str(exc)[:1200]}"})
                thread = threading.Thread(target=invoke, daemon=True)
                dispatch_threads.append(thread)
                thread.start()
                while True:
                    check_cancel()
                    try:
                        return completed.get(timeout=0.1)
                    except queue.Empty:
                        pass
            try:
                process.stdin.write(request + "\n"); process.stdin.flush()
                while True:
                    check_cancel()
                    try:
                        line = messages.get(timeout=0.1)
                    except queue.Empty:
                        continue
                    if line is None:
                        raise ProgramError("Source worker exited without a result: " + "".join(errors)[-1800:])
                    if len(line) > 1_500_000:
                        raise ProgramError("Source worker output exceeded budget")
                    message = json.loads(line)
                    if "error" in message:
                        raise ProgramError(message["error"])
                    if "result" in message:
                        return message["result"]
                    rpc = message.get("rpc")
                    if not rpc or rpc["method"] not in {"ask", "parallel", "experiment", "search", "log"}:
                        raise ProgramError("Unknown source capability request")
                    if handler is None:
                        raise ProgramError("This source entry has no external capabilities")
                    rpc_count += 1
                    if rpc_count > 128:
                        raise ProgramError("Host capability-call budget exhausted")
                    response = dispatch(rpc["method"], rpc["params"])
                    process.stdin.write(canonical(response) + "\n"); process.stdin.flush()
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=5)
                for reader in readers:
                    reader.join(timeout=1)
                for dispatch_thread in dispatch_threads:
                    dispatch_thread.join(timeout=0.2)
                for stream in (process.stdin, process.stdout, process.stderr):
                    stream.close()
