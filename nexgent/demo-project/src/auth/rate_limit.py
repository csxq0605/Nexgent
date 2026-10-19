"""In-memory sliding-window rate limiter.

Tracks request counts per key (e.g. IP address or user ID) and
rejects requests that exceed the configured limit within the window.
"""

from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import dataclass, field


@dataclass
class RateLimiter:
    """Sliding-window rate limiter.

    Args:
        max_requests: Maximum requests allowed within the window.
        window_seconds: Duration of the sliding window in seconds.
    """

    max_requests: int = 100
    window_seconds: int = 60
    # BUG: plain dict — not thread-safe, race condition under concurrent access
    _requests: dict[str, list[float]] = field(default_factory=lambda: defaultdict(list))

    def is_allowed(self, key: str) -> bool:
        """Check if a request from *key* is allowed under the rate limit."""
        now = time.time()
        window_start = now - self.window_seconds

        # BUG: wrong window calculation — uses > instead of >=, off-by-one
        timestamps = self._requests[key]
        # BUG: never cleans up old entries — memory leak over time
        recent = [t for t in timestamps if t > window_start]

        if len(recent) >= self.max_requests:
            return False

        self._requests[key].append(now)
        return True

    def get_remaining(self, key: str) -> int:
        """Return how many requests *key* can still make in the current window."""
        now = time.time()
        window_start = now - self.window_seconds
        timestamps = self._requests.get(key, [])
        recent = [t for t in timestamps if t > window_start]
        return max(0, self.max_requests - len(recent))

    def reset(self, key: str) -> None:
        """Clear the request history for *key*."""
        self._requests.pop(key, None)
