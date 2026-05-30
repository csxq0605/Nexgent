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


@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_runtest_call(item):
    """Retry flaky E2E tests up to E2E_MAX_RETRIES times."""
    # Only retry E2E tests (in test_e2e.py or test_real_world_functional.py)
    is_e2e = "test_e2e" in str(item.fspath) or "test_real_world_functional" in str(item.fspath)

    if not is_e2e:
        # Non-E2E tests: run normally
        yield
        return

    # E2E tests: retry on failure
    last_exc = None
    for attempt in range(E2E_MAX_RETRIES):
        try:
            outcome = yield
            # If we get here without exception, test passed
            return
        except Exception as e:
            last_exc = e
            if attempt < E2E_MAX_RETRIES - 1:
                # Print retry notice (visible with -v)
                print(f"\n  [RETRY] {item.nodeid} failed (attempt {attempt + 1}/{E2E_MAX_RETRIES}), retrying...")
                continue
            else:
                # Final attempt failed
                raise last_exc
