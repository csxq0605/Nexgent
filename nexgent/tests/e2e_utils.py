"""Shared E2E test utilities — retry logic for flaky network/API errors."""

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
