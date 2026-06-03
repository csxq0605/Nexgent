"""Shared E2E test utilities — retry logic for flaky network/API errors."""

import pytest

# E2E retry configuration
E2E_MAX_RETRIES = 3

# Only retry on network/API errors, not assertion failures
RETRYABLE_EXCEPTIONS = (
    ConnectionError,
    TimeoutError,
    OSError,
)


def _is_retryable(exc: Exception) -> bool:
    """Check if an exception is retryable (network/API error)."""
    if isinstance(exc, RETRYABLE_EXCEPTIONS):
        return True
    # openai library errors
    exc_name = type(exc).__name__
    if exc_name in ("APIError", "APITimeoutError", "APIConnectionError", "RateLimitError"):
        return True
    # Check status_code attribute (openai errors set this)
    status_code = getattr(exc, "status_code", None)
    if status_code in (429, 500, 502, 503, 504):
        return True
    return False


def pytest_runtest_call_impl(item, E2E_MAX_RETRIES=E2E_MAX_RETRIES):
    """Retry flaky E2E tests up to E2E_MAX_RETRIES times on network errors.

    Yields control for the actual test execution, catching retryable errors.
    """
    last_exc = None
    for attempt in range(E2E_MAX_RETRIES):
        try:
            yield
            return
        except Exception as e:
            last_exc = e
            if not _is_retryable(e):
                raise
            if attempt < E2E_MAX_RETRIES - 1:
                print(f"\n  [RETRY] {item.nodeid} failed (attempt {attempt + 1}/{E2E_MAX_RETRIES}), retrying...")
                continue
            else:
                raise last_exc
