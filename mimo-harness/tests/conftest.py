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

from tests.e2e_utils import E2E_MAX_RETRIES, _is_retryable

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


def _validate_api_connection() -> bool:
    """Validate that the configured API is actually reachable.

    Cached: only calls the API once per test session.
    """
    api_key = os.environ.get("MIMO_API_KEY", "")
    if not api_key or api_key == "test-key-for-testing":
        return False
    try:
        from openai import OpenAI
        from mimo_harness.config import MIMO_BASE_URL, MIMO_MODEL
        client = OpenAI(api_key=api_key, base_url=MIMO_BASE_URL)
        client.chat.completions.create(
            model=MIMO_MODEL,
            messages=[{"role": "user", "content": "hi"}],
            max_completion_tokens=1,
        )
        return True
    except Exception:
        return False


# Cache the API validation result (run once per session)
_API_VALIDATED = None


def is_api_available() -> bool:
    """Check if the real API is available (cached)."""
    global _API_VALIDATED
    if _API_VALIDATED is None:
        _API_VALIDATED = _validate_api_connection()
    return _API_VALIDATED


# Redirect spill files to a temp directory during tests to prevent
# test artifacts from accumulating in .mimo/outputs/
_test_spill_dir = tempfile.mkdtemp(prefix="mimo_test_spill_")
os.environ.setdefault("MIMO_SPILL_DIR", _test_spill_dir)


@atexit.register
def _cleanup_spill_dir():
    """Remove the temp spill directory when the test process exits."""
    shutil.rmtree(_test_spill_dir, ignore_errors=True)


@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_runtest_call(item):
    """Retry flaky E2E tests up to E2E_MAX_RETRIES times on network errors."""
    # Only retry E2E tests (in test_e2e.py or test_cli_e2e.py)
    is_e2e = "test_e2e" in str(item.fspath)

    if not is_e2e:
        yield
        return

    last_exc = None
    for attempt in range(E2E_MAX_RETRIES):
        try:
            outcome = yield
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
