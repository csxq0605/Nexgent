"""Pytest configuration - set env vars for testing.

E2E tests (test_e2e.py) use the real API from .env — skip mock overrides.
"""

import os
import atexit
import shutil
import tempfile
from pathlib import Path

import pytest
from dotenv import load_dotenv

# Load .env BEFORE checking for real API key
_env_path = Path.cwd() / ".env"
if not _env_path.exists():
    _env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(_env_path, override=False)

_real_api_key = os.environ.get("MIMO_API_KEY", "")

# Only set mock defaults when no real API key is configured
if not _real_api_key or _real_api_key == "test-key-for-testing":
    os.environ["MIMO_API_KEY"] = "test-key-for-testing"
    os.environ["MIMO_BASE_URL"] = "http://localhost:8080/v1"
    os.environ["MIMO_MODEL"] = "test-model"

# Redirect spill files to a temp directory during tests to prevent
# test artifacts from accumulating in .mimo/outputs/
_test_spill_dir = tempfile.mkdtemp(prefix="mimo_test_spill_")
os.environ.setdefault("MIMO_SPILL_DIR", _test_spill_dir)


@atexit.register
def _cleanup_spill_dir():
    """Remove the temp spill directory when the test process exits."""
    shutil.rmtree(_test_spill_dir, ignore_errors=True)


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


@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_runtest_call(item):
    """Retry flaky E2E tests up to E2E_MAX_RETRIES times on network errors."""
    # Only retry E2E tests (in test_e2e.py)
    is_e2e = "test_e2e" in str(item.fspath)

    if not is_e2e:
        # Non-E2E tests: run normally
        yield
        return

    # E2E tests: retry only on retryable (network/API) failures
    last_exc = None
    for attempt in range(E2E_MAX_RETRIES):
        try:
            outcome = yield
            # If we get here without exception, test passed
            return
        except Exception as e:
            last_exc = e
            if not _is_retryable(e):
                # Non-retryable error (e.g. AssertionError) — fail immediately
                raise
            if attempt < E2E_MAX_RETRIES - 1:
                print(f"\n  [RETRY] {item.nodeid} failed (attempt {attempt + 1}/{E2E_MAX_RETRIES}), retrying...")
                continue
            else:
                raise last_exc
