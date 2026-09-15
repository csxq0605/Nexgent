"""Capability Python worker. No credentials or hidden evaluator data enter it."""

from __future__ import annotations

import builtins
import ctypes
import json
import math
import os
import sys
import time
from types import SimpleNamespace

from .programs import PURE_METHODS, ProgramError, validate_source, verify_bundle


def memory_limit(megabytes=512):
    """Enforce a process memory ceiling; this is not filesystem/OS isolation."""
    amount = megabytes * 1024 * 1024
    if os.name != "nt":
        import resource
        # Native numerical libraries can reserve address space above resident RAM.
        resource.setrlimit(resource.RLIMIT_AS, (amount * 4, amount * 4))
        return {"kind": "address_space", "bytes": amount * 4}, None
    from ctypes import wintypes
    class Basic(ctypes.Structure):
        _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                    ("flags", wintypes.DWORD), ("min_working", ctypes.c_size_t),
                    ("max_working", ctypes.c_size_t), ("active", wintypes.DWORD),
                    ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
                    ("scheduling", wintypes.DWORD)]
    class IO(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]
    class Extended(ctypes.Structure):
        _fields_ = [("basic", Basic), ("io", IO), ("process_memory", ctypes.c_size_t),
                    ("job_memory", ctypes.c_size_t), ("peak_process", ctypes.c_size_t), ("peak_job", ctypes.c_size_t)]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    handle = kernel.CreateJobObjectW(None, None)
    limits = Extended(); limits.basic.flags = 0x100; limits.process_memory = amount
    if not handle or not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        raise RuntimeError("Cannot establish source-worker memory limit")
    if not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
        raise RuntimeError("Cannot attach source worker to its memory-limited job")
    return {"kind": "process_commit", "bytes": amount}, handle


def audit(event, args):
    denied = ("open", "import", "os.system", "os.exec", "os.spawn", "os.fork",
              "os.posix_spawn", "subprocess", "socket", "ctypes", "winreg",
              "os.listdir", "os.scandir", "os.remove", "os.rename", "os.mkdir",
              "os.rmdir", "os.chdir", "os.chmod", "os.link", "os.symlink")
    if any(event == prefix or event.startswith(prefix + ".") for prefix in denied):
        raise PermissionError("Source code requested an ungranted system capability")


class Broker:
    def __init__(self):
        self.count = 0

    def request(self, method, params):
        self.count += 1
        if self.count > 128:
            raise RuntimeError("Source RPC budget exhausted")
        print(json.dumps({"rpc": {"id": self.count, "method": method, "params": params}}, ensure_ascii=False, allow_nan=False), flush=True)
        line = sys.stdin.readline(2_000_001)
        if not line or len(line) > 2_000_000:
            raise RuntimeError("Invalid capability response")
        response = json.loads(line)
        if response.get("error"):
            raise RuntimeError(response["error"])
        return response["value"]

    def ask(self, role, prompt, payload=None, max_tokens=6000):
        return self.request("ask", {"role": role, "prompt": prompt, "payload": payload or {}, "max_tokens": max_tokens})

    def parallel(self, requests):
        return self.request("parallel", {"requests": requests})

    def experiment(self, files, label="development experiment"):
        return self.request("experiment", {"files": files, "label": label})

    def search(self, query):
        return self.request("search", {"query": query})

    def log(self, kind, content):
        return self.request("log", {"kind": kind, "content": content})


def main():
    started = time.monotonic()
    request = json.loads(sys.stdin.readline(2_000_001))
    bundle, entry = request["bundle"], request["entry"]
    verify_bundle(bundle)
    limit, job_handle = memory_limit()
    from ..science.toolbox import Toolbox
    tools = Toolbox(max_work_units=request.get("max_work_units", 20_000_000))
    tool_methods = [n for n in dir(Toolbox) if not n.startswith("_") and callable(getattr(Toolbox, n))]
    compiled = []
    for name in ("workflow.py", "task.py", "meta.py"):
        if name in bundle["files"]:
            tree = validate_source(bundle["files"][name], name, tool_methods)
            compiled.append(compile(tree, "agent:" + name, "exec"))
    names = ("abs all any bool dict enumerate filter float int isinstance len list map max min next "
             "pow range reversed round set sorted str sum tuple zip Exception ValueError RuntimeError "
             "ArithmeticError ZeroDivisionError KeyError IndexError TypeError OverflowError").split()
    safe_builtins = {n: getattr(builtins, n) for n in names}
    math_facade = SimpleNamespace(**{n: getattr(math, n) for n in PURE_METHODS if hasattr(math, n)})
    namespace = {"__builtins__": safe_builtins, "math": math_facade}
    broker = Broker()
    instructions = [0]

    def trace(frame, event, arg):
        if not frame.f_code.co_filename.startswith("agent:"):
            return None
        instructions[0] += 1
        if instructions[0] > 2_000_000:
            # Exceptions from a trace hook are catchable by generated code
            # and disable tracing. Terminate instead of granting a bypass.
            sys.settrace(None)
            print(json.dumps({"error": "Source instruction budget exhausted"}), flush=True)
            os._exit(75)
        return trace

    # All trusted imports/preparation are complete. The hook is irreversible in
    # this disposable process; generated Python has no handle to these globals.
    sys.addaudithook(audit)
    sys.setrecursionlimit(350)
    sys.settrace(trace)
    for code in compiled:
        exec(code, namespace, namespace)
    argument = request["argument"]
    if entry == "solve_batch":
        value = []
        for index, observed_problem in enumerate(argument["problems"]):
            problem = dict(observed_problem)
            remaining_tasks = len(argument["problems"]) - index
            remaining_work = max(0, request.get("max_work_units", 20_000_000) - tools.work_units)
            problem["numerical_budget"] = {"batch_limit": request.get("max_work_units", 20_000_000),
                "work_at_start": tools.work_units, "batch_remaining": remaining_work,
                "remaining_tasks": remaining_tasks, "recommended_limit": remaining_work // remaining_tasks}
            try:
                submission = namespace["solve"](problem, tools)
                json.dumps(submission, allow_nan=False)
                value.append({"ok": True, "submission": submission})
            except Exception as exc:
                value.append({"ok": False, "error_type": type(exc).__name__, "error": f"{type(exc).__name__}: {str(exc)[:1000]}"})
    elif entry == "improve":
        value = namespace["improve"](argument, broker)
    elif entry == "select_parent":
        if "select_parent" not in namespace:
            value = None
        else:
            value = namespace["select_parent"](argument)
    else:
        raise ValueError("Unknown source entry")
    sys.settrace(None)
    result = {"value": value, "execution": {"bundle_id": bundle["id"], "entry": entry,
              "pid": os.getpid(), "source_digest": bundle["digest"],
              "elapsed_seconds": time.monotonic() - started, "rpc_count": broker.count,
              "work_units": getattr(tools, "work_units", 0), "instructions": instructions[0],
              "science_receipts": tools.receipts(),
              "isolation": {"language": "capability_python", "audit_hook": True, "memory_limit": limit,
                            "os_filesystem_container": False}}}
    output = json.dumps({"result": result}, ensure_ascii=False, allow_nan=False)
    if len(output) > 1_500_000:
        raise ValueError("Source result exceeded output budget")
    print(output, flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as failure:
        sys.settrace(None)
        print(json.dumps({"error": f"{type(failure).__name__}: {str(failure)[:1500]}"}), flush=True)
        raise SystemExit(1)
