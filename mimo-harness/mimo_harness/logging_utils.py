"""Structured logging with trace IDs."""

import os
import json
import time
import hashlib
import logging


class TraceLogger:
    def __init__(self, log_file: str = None, verbose: bool = False):
        self.session_id = hashlib.md5(str(time.time()).encode()).hexdigest()[:8]
        self.step = 0
        self.logger = logging.getLogger("mimo-harness")
        self.logger.setLevel(logging.DEBUG)
        if not self.logger.handlers:
            if log_file:
                log_dir = os.path.dirname(log_file)
                if log_dir:
                    os.makedirs(log_dir, exist_ok=True)
                fh = logging.FileHandler(log_file, encoding="utf-8")
                fh.setLevel(logging.DEBUG)
                fh.setFormatter(logging.Formatter("%(asctime)s | %(levelname)s | %(message)s"))
                self.logger.addHandler(fh)
            ch = logging.StreamHandler()
            ch.setLevel(logging.DEBUG if verbose else logging.INFO)
            ch.setFormatter(logging.Formatter("%(message)s"))
            self.logger.addHandler(ch)

    def trace(self, event: str, data: dict = None):
        self.step += 1
        msg = f"[TRACE] session={self.session_id} step={self.step} event={event}"
        if data:
            msg += f" data={json.dumps(data, ensure_ascii=False)}"
        self.logger.debug(msg)

    def info(self, msg: str):
        self.logger.info(msg)

    def error(self, msg: str, exc: Exception = None):
        self.logger.error(f"[ERROR] {msg}", exc_info=exc)

    def tool_call(self, name: str, args: dict, result: str = ""):
        self.trace("tool_call", {"name": name, "args": args, "result_len": len(result)})

    def session_summary(self, stats: dict):
        self.trace("session_complete", stats)
