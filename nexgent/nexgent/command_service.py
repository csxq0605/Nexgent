"""UI-neutral wrapper around Nexgent's authoritative slash-command dispatcher."""

from __future__ import annotations

import contextlib
import io
import shlex
import sys
from dataclasses import dataclass
from typing import Any, Optional


@dataclass(frozen=True)
class CommandResult:
    action: str
    output: str
    session: Any


class _Tee(io.TextIOBase):
    """Mirror command output to the frontend stream while retaining a result."""

    def __init__(self, *streams: io.TextIOBase) -> None:
        self.streams = streams

    def write(self, text: str) -> int:
        for stream in self.streams:
            stream.write(text)
        return len(text)

    def flush(self) -> None:
        for stream in self.streams:
            stream.flush()


class CommandService:
    def __init__(
        self,
        harness: Any,
        session: Any,
        memory_store: Any,
        checkpoint_manager: Any = None,
        session_dir: Optional[str] = None,
    ) -> None:
        self.harness = harness
        self.session = session
        self.memory_store = memory_store
        self.checkpoint_manager = checkpoint_manager
        self.session_dir = session_dir

    def execute(self, command: str) -> CommandResult:
        from .cli import _handle_command

        parts = shlex.split(command.strip())
        if not parts:
            return CommandResult("continue", "", self.session)
        parts[0] = parts[0].lower()
        stream = io.StringIO()
        stdout = _Tee(sys.stdout, stream)
        stderr = _Tee(sys.stderr, stream)
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            action, session = _handle_command(
                parts,
                self.harness,
                self.session,
                self.memory_store,
                self.checkpoint_manager,
                self.session_dir,
            )
        self.session = session
        return CommandResult(action, stream.getvalue(), session)
