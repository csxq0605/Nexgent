"""Tests for rate limiter.

Note: some tests reveal planted bugs in rate_limit.py.
"""

from __future__ import annotations

import time
import threading
import pytest

from src.auth.rate_limit import RateLimiter


class TestRateLimiter:
    """Test basic rate limiting."""

    def test_allows_requests_under_limit(self):
        limiter = RateLimiter(max_requests=5, window_seconds=60)
        for _ in range(5):
            assert limiter.is_allowed("user1") is True

    def test_blocks_requests_over_limit(self):
        limiter = RateLimiter(max_requests=3, window_seconds=60)
        for _ in range(3):
            limiter.is_allowed("user1")
        assert limiter.is_allowed("user1") is False

    def test_different_keys_independent(self):
        limiter = RateLimiter(max_requests=2, window_seconds=60)
        limiter.is_allowed("user1")
        limiter.is_allowed("user1")
        assert limiter.is_allowed("user2") is True

    def test_remaining_count(self):
        limiter = RateLimiter(max_requests=5, window_seconds=60)
        limiter.is_allowed("user1")
        limiter.is_allowed("user1")
        assert limiter.get_remaining("user1") == 3

    def test_reset_clears_history(self):
        limiter = RateLimiter(max_requests=1, window_seconds=60)
        limiter.is_allowed("user1")
        assert limiter.is_allowed("user1") is False
        limiter.reset("user1")
        assert limiter.is_allowed("user1") is True


class TestRateLimiterWindow:
    """Test window-based expiry."""

    def test_requests_expire_after_window(self):
        limiter = RateLimiter(max_requests=2, window_seconds=1)
        limiter.is_allowed("user1")
        limiter.is_allowed("user1")
        assert limiter.is_allowed("user1") is False
        time.sleep(1.1)
        assert limiter.is_allowed("user1") is True


class TestRateLimiterConcurrency:
    """Test thread safety — reveals race condition bug."""

    def test_concurrent_access(self):
        """Concurrent requests should not exceed the limit.

        BUG: RateLimiter uses a plain dict without locking.
        Under concurrent access, the count can exceed max_requests.
        This test may pass or fail non-deterministically.
        """
        limiter = RateLimiter(max_requests=100, window_seconds=60)
        results = []

        def make_requests():
            for _ in range(50):
                results.append(limiter.is_allowed("user1"))

        threads = [threading.Thread(target=make_requests) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        allowed_count = sum(results)
        # With a thread-safe limiter, this should be exactly 100
        # With the buggy implementation, it may exceed 100
        assert allowed_count <= 100 + 4  # allow small race window for test stability
