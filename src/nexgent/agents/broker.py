"""RPC capabilities; research order and roles belong to the source program."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
from threading import RLock
import time
import uuid

from ..research import LiteratureSearch


class ImprovementBroker:
    def __init__(self, gateway, *, parent_files, experiment, search=None, event=None,
                 stop_event=None, max_parallel=4, source_bundle=None, probe_improver=None):
        if type(max_parallel) is not int or not 1 <= max_parallel <= 8:
            raise ValueError("Parallel request cap must be within 1..8")
        self.gateway, self.parent_files = gateway, deepcopy(parent_files)
        self.experiment, self.search = experiment, search if search is not None else LiteratureSearch()
        self.event, self.stop_event = event, stop_event
        self.max_parallel, self._lock = max_parallel, RLock()
        self.source_bundle = source_bundle
        self.probe_improver = probe_improver

    def _stop(self):
        if self.stop_event is not None and self.stop_event.is_set():
            raise InterruptedError("Research capability was stopped")

    def _record(self, kind, content):
        if self.event is not None:
            with self._lock:
                self.event(kind, deepcopy(content))

    @staticmethod
    def _ask_args(params):
        if not isinstance(params, dict) or set(params) - {"role", "prompt", "payload", "max_tokens"}:
            raise ValueError("ask accepts role, prompt, payload and max_tokens")
        if not {"role", "prompt", "payload"}.issubset(params):
            raise ValueError("ask is missing role, prompt or payload")
        return params

    def handle(self, method, params):
        self._stop()
        if method not in {"ask", "parallel", "experiment", "probe_improver", "search", "log"}:
            raise ValueError("Unknown research capability")
        if not isinstance(params, dict) or len(json.dumps(params, allow_nan=False)) > 900000:
            raise ValueError("Capability parameters must be a bounded JSON object")
        identity, started = "rpc-" + uuid.uuid4().hex, time.monotonic()
        record = {"id": identity, "method": method, "status": "started", "request": deepcopy(params),
                  "producer": "host_broker", "request_source": "agent", "source_bundle": self.source_bundle}
        self._record("capability", record)
        try:
            if method == "ask":
                result = self.gateway.ask(**self._ask_args(params))
            elif method == "parallel":
                if set(params) != {"requests"} or not isinstance(params["requests"], list):
                    raise ValueError("parallel requires a requests list")
                requests = params["requests"]
                if not 1 <= len(requests) <= self.max_parallel:
                    raise ValueError("parallel exceeds the host request-count cap")
                for request in requests:
                    self._ask_args(request)
                # Join all requests even on error so their reservations receive
                # terminal usage receipts. Each real worker has its own bound.
                with ThreadPoolExecutor(max_workers=len(requests)) as pool:
                    futures = [pool.submit(self.gateway.ask, **request) for request in requests]
                    results, errors = [], []
                    for future in futures:
                        try:
                            results.append(future.result())
                        except BaseException as exc:
                            errors.append(exc)
                    if errors:
                        raise errors[0]
                result = results
            elif method in {"experiment", "probe_improver"}:
                if set(params) != {"files", "label"} or not isinstance(params["files"], dict):
                    raise ValueError("experiment requires file replacements and a label")
                if not isinstance(params["label"], str) or not params["label"].strip() or len(params["label"]) > 500:
                    raise ValueError("experiment label must be nonempty text up to 500 characters")
                if any(not isinstance(k, str) or not isinstance(v, str) for k, v in params["files"].items()):
                    raise ValueError("experiment source replacements must be text")
                files = {**deepcopy(self.parent_files), **deepcopy(params["files"])}
                if method == "probe_improver" and self.probe_improver is None:
                    raise ValueError("Improver probe is not available at this execution depth")
                callback = self.experiment if method == "experiment" else self.probe_improver
                result = callback(files, params["label"])
                if not isinstance(result, dict) or result.get("split") != "development":
                    raise ValueError("Experiment callback must return development-only evidence")
            elif method == "search":
                if set(params) != {"query"}:
                    raise ValueError("search requires only a query")
                result = self.search(params["query"])
            else:
                if set(params) != {"kind", "content"} or not isinstance(params["kind"], str):
                    raise ValueError("log requires kind and content")
                self._record("agent_log", {"claimed_kind": params["kind"][:100],
                    "content": params["content"], "source": "agent", "source_bundle": self.source_bundle})
                result = {"recorded": True}
            self._stop()
            record.update(status="completed", result=deepcopy(result))
            return result
        except BaseException as exc:
            record.update(status="interrupted" if isinstance(exc, InterruptedError) else "failed",
                          error_type=type(exc).__name__)
            raise
        finally:
            record["elapsed_seconds"] = time.monotonic() - started
            self._record("capability", record)
