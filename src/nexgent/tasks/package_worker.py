"""Disposable capability Python worker for modular AgentPackages.

This restricts the Python language and audits system capabilities; it does not
claim a filesystem container or support arbitrary untrusted Python extensions.
"""

from __future__ import annotations

import builtins
import json
import math
import os
import sys
import time
from types import SimpleNamespace

from ..kernel.programs import PURE_METHODS, canonical, validate_source
from ..kernel.worker import audit, memory_limit
from .packages import CAPABILITIES, LOCAL_METHODS, PackageError, resolve_entry, safe_path, split_ref, verify_package


class Context:
    def __init__(self, package, compiled, builtins_map, math_facade, max_rpc):
        self.package = package
        self.compiled = compiled
        self.builtins_map = builtins_map
        self.math_facade = math_facade
        self.max_rpc = max_rpc
        self.namespaces = {}
        self.loaded_modules = []
        self.local_calls = []
        self.read_artifact_ids = []
        self.rpc_count = 0

    def invoke(self, path, function, payload):
        if path not in self.namespaces:
            namespace = {"__builtins__": self.builtins_map, "math": self.math_facade}
            self.namespaces[path] = namespace
            if path not in self.loaded_modules:
                self.loaded_modules.append(path)
            exec(self.compiled[path], namespace, namespace)
        callback = self.namespaces[path].get(function)
        if not callable(callback):
            raise PackageError(f"Package entry is not callable: {path}:{function}")
        return callback(payload, self)

    def call(self, ref, payload):
        path, function = split_ref(ref, self.package["files"])
        canonical(payload)
        if len(self.local_calls) >= 10_000:
            raise PackageError("Local package-call budget exhausted")
        self.local_calls.append({"ref": ref})
        value = self.invoke(path, function, payload)
        canonical(value)
        return value

    def resource(self, path):
        safe_path(path)
        if path not in self.package["files"]:
            raise PackageError(f"Package resource is absent: {path}")
        if path not in self.loaded_modules:
            self.loaded_modules.append(path)
        return self.package["files"][path]

    def request(self, method, params):
        self.rpc_count += 1
        if self.rpc_count > self.max_rpc:
            raise PackageError("Package RPC budget exhausted")
        output = canonical({"rpc": {"id": self.rpc_count, "method": method, "params": params}})
        if len(output.encode("utf-8")) > 1_500_000:
            raise PackageError("Package capability request exceeded output budget")
        print(output, flush=True)
        line = sys.stdin.readline(1_500_001)
        if not line or len(line) > 1_500_000:
            raise PackageError("Invalid package capability response")
        response = json.loads(line)
        if "error" in response:
            raise RuntimeError(response["error"])
        return response["value"]

    def ask(self, role, prompt, payload=None, max_tokens=4000):
        return self.request("ask", {"role": role, "prompt": prompt, "payload": payload, "max_tokens": max_tokens})

    def tool(self, name, arguments=None):
        return self.request("tool", {"name": name, "arguments": arguments})

    def parallel(self, requests):
        return self.request("parallel", {"requests": requests})

    def skill(self, name, payload=None):
        return self.request("skill", {"name": name, "payload": payload})

    def delegate(self, task, package_id=None):
        return self.request("delegate", {"task": task, "package_id": package_id})

    def develop_skill(self, proposal, constraints):
        return self.request("develop_skill", {
            "proposal": proposal, "constraints": constraints})

    def read_artifact(self, artifact_id):
        artifact = self.request("read_artifact", {"artifact_id": artifact_id})
        if artifact_id not in self.read_artifact_ids:
            self.read_artifact_ids.append(artifact_id)
        return artifact

    def publish(self, content, schema="application/json", name=None):
        return self.request("publish", {"content": content, "schema": schema, "name": name,
                                        "input_refs": list(self.read_artifact_ids)})

    def memory_search(self, query, limit=5):
        return self.request("memory_search", {"query": query, "limit": limit})

    def remember(self, content, kind="experience", evidence=None):
        return self.request("remember", {"content": content, "kind": kind, "evidence": evidence})

    def plan(self, plan):
        return self.request("plan", {"plan": plan})

    def feedback(self, content):
        return self.request("feedback", {"content": content})


def main():
    started = time.monotonic()
    request = json.loads(sys.stdin.readline(1_500_001))
    package = verify_package(request["package"])
    path, function = resolve_entry(package, request["entry"])
    limit, job_handle = memory_limit()
    compiled = {name: compile(validate_source(text, name, CAPABILITIES | LOCAL_METHODS),
                              "agent-package:" + name, "exec")
                for name, text in package["files"].items() if name.endswith(".py")}
    names = ("abs all any bool dict enumerate filter float int isinstance len list map max min next "
             "pow range reversed round set sorted str sum tuple zip Exception ValueError RuntimeError "
             "ArithmeticError ZeroDivisionError KeyError IndexError TypeError OverflowError").split()
    builtins_map = {name: getattr(builtins, name) for name in names}
    math_facade = SimpleNamespace(**{name: getattr(math, name) for name in PURE_METHODS if hasattr(math, name)})
    context = Context(package, compiled, builtins_map, math_facade, request["max_rpc"])
    instructions = [0]

    def trace(frame, event, argument):
        if not frame.f_code.co_filename.startswith("agent-package:"):
            return None
        # Trace events are the portable instruction work unit, as in the
        # existing controlled worker. Some CPython 3.12 builds do not emit
        # opcode events when enabled on a newly traced frame.
        if event in {"call", "line", "return", "exception"}:
            instructions[0] += 1
            if instructions[0] > request["max_instructions"]:
                # A trace exception can be caught and disables tracing. A hard
                # process exit preserves the limit even inside try/except.
                sys.settrace(None)
                print(canonical({"error": "Package instruction budget exhausted"}), flush=True)
                os._exit(75)
        return trace

    sys.addaudithook(audit)
    sys.setrecursionlimit(350)
    sys.settrace(trace)
    value = context.invoke(path, function, request["payload"])
    sys.settrace(None)
    result = {"value": value, "execution": {"package_id": package["id"],
              "package_digest": package["digest"], "entry": request["entry"], "pid": os.getpid(),
              "rpc_count": context.rpc_count, "instructions": instructions[0],
              "loaded_modules": context.loaded_modules, "local_calls": context.local_calls,
              "elapsed_seconds": time.monotonic() - started,
              "isolation": {"language": "capability_python", "audit_hook": True,
                            "memory_limit": limit, "os_filesystem_container": False}}}
    output = canonical({"result": result})
    if len(output.encode("utf-8")) > 1_500_000:
        raise PackageError("Package result exceeded output budget")
    print(output, flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as failure:
        sys.settrace(None)
        print(canonical({"error": f"{type(failure).__name__}: {str(failure)[:1500]}"}), flush=True)
        raise SystemExit(1)
