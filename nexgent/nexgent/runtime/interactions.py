"""Thread-safe frontend interaction requests with fail-closed defaults."""

from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, Optional


class InteractionKind(str, Enum):
    PERMISSION = "permission"
    USER_INPUT = "user_input"


@dataclass(frozen=True)
class InteractionResponse:
    accepted: bool
    value: Any = None


@dataclass
class InteractionRequest:
    kind: InteractionKind
    prompt: str
    metadata: Dict[str, Any] = field(default_factory=dict)
    request_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    _event: threading.Event = field(default_factory=threading.Event, init=False, repr=False)
    _response: Optional[InteractionResponse] = field(default=None, init=False, repr=False)

    def resolve(self, accepted: bool, value: Any = None) -> None:
        if not self._event.is_set():
            self._response = InteractionResponse(bool(accepted), value)
            self._event.set()

    def wait(self, timeout: Optional[float]) -> InteractionResponse:
        if not self._event.wait(timeout):
            self.resolve(False)
        return self._response or InteractionResponse(False)


class InteractionBroker:
    def __init__(
        self,
        handler: Optional[Callable[[InteractionRequest], Any]] = None,
        timeout: float = 300.0,
    ) -> None:
        self._handler = handler
        self.timeout = timeout

    def set_handler(self, handler: Optional[Callable[[InteractionRequest], Any]]) -> None:
        self._handler = handler

    def request(self, request: InteractionRequest) -> InteractionResponse:
        if self._handler is None:
            request.resolve(False)
        else:
            try:
                result = self._handler(request)
                if isinstance(result, InteractionResponse):
                    request.resolve(result.accepted, result.value)
                elif isinstance(result, bool):
                    request.resolve(result)
            except Exception:
                request.resolve(False)
        return request.wait(self.timeout)
