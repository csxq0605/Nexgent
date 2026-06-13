"""Pytest configuration - set env vars for testing.

E2E tests (test_e2e.py) use the real API from .env — skip mock overrides.
"""

import os
import time
import shutil
import tempfile
from pathlib import Path

import pytest
from dotenv import load_dotenv

from tests.e2e_utils import E2E_MAX_RETRIES, _is_retryable


def pytest_addoption(parser):
    parser.addoption("--run-slow", action="store_true", default=False,
                     help="Run slow tests (real API, multi-step, >30s)")


def pytest_configure(config):
    """Register custom markers."""
    config.addinivalue_line("markers", "fast: Fast tests — single API call or pure state, <5s each")
    config.addinivalue_line("markers", "slow: Slow tests — multi-step, heavy API, >30s each")
    config.addinivalue_line("markers", "e2e: End-to-end tests — real API + real tools")

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
        from agent_hub.config import MIMO_BASE_URL, MIMO_MODEL
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


# Clean up any leftover spill directories from previous test runs
def _cleanup_old_spill_dirs():
    """Remove old mimo_test_spill_* directories from temp."""
    temp_dir = tempfile.gettempdir()
    for item in os.listdir(temp_dir):
        if item.startswith("mimo_test_spill_"):
            item_path = os.path.join(temp_dir, item)
            if os.path.isdir(item_path):
                shutil.rmtree(item_path, ignore_errors=True)

# Clean up old spill dirs before creating new one
_cleanup_old_spill_dirs()

# Clean up stale .e2e_work from previous crashed runs
_e2e_work = os.path.join(os.getcwd(), ".e2e_work")
if os.path.isdir(_e2e_work):
    shutil.rmtree(_e2e_work, ignore_errors=True)

# Redirect spill files to a temp directory during tests to prevent
# test artifacts from accumulating in .mimo/outputs/
_test_spill_dir = tempfile.mkdtemp(prefix="mimo_test_spill_")
os.environ.setdefault("MIMO_SPILL_DIR", _test_spill_dir)


@pytest.fixture(autouse=True, scope="session")
def _cleanup_spill_dir():
    """Remove the temp spill directory when the test session ends."""
    yield
    shutil.rmtree(_test_spill_dir, ignore_errors=True)
    # Also clean up .e2e_work if it still exists
    e2e_work = os.path.join(os.getcwd(), ".e2e_work")
    if os.path.isdir(e2e_work):
        shutil.rmtree(e2e_work, ignore_errors=True)


def pytest_collection_modifyitems(config, items):
    """Skip slow tests unless --run-slow is passed."""
    if config.getoption("--run-slow"):
        return
    skip_slow = pytest.mark.skip(reason="Slow test — pass --run-slow to enable")
    for item in items:
        if "slow" in item.keywords:
            item.add_marker(skip_slow)


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_protocol(item, nextitem):
    """Retry flaky E2E tests up to E2E_MAX_RETRIES on retryable errors."""
    is_e2e = "test_e2e" in str(item.fspath)
    if not is_e2e:
        return None  # use default protocol

    from _pytest.runner import runtestprotocol

    for attempt in range(E2E_MAX_RETRIES):
        reports = runtestprotocol(item, nextitem=nextitem, log=False)
        failed = any(r.failed and r.when == "call" for r in reports)
        if not failed:
            for rep in reports:
                item.ihook.pytest_runtest_logreport(report=rep)
            return True

        call_report = next((r for r in reports if r.when == "call" and r.failed), None)
        if call_report is None:
            for rep in reports:
                item.ihook.pytest_runtest_logreport(report=rep)
            return True

        exc = call_report.excinfo[1] if hasattr(call_report, 'excinfo') and call_report.excinfo else None
        if exc is None or not _is_retryable(exc):
            for rep in reports:
                item.ihook.pytest_runtest_logreport(report=rep)
            return True

        if attempt < E2E_MAX_RETRIES - 1:
            backoff = 10 * (2 ** attempt)  # 10s, 20s
            print(f"\n  [RETRY] {item.nodeid} ({type(exc).__name__}), "
                  f"attempt {attempt + 1}/{E2E_MAX_RETRIES}, backoff {backoff}s...")
            time.sleep(backoff)
        else:
            print(f"\n  [RETRY] {item.nodeid} exhausted {E2E_MAX_RETRIES} attempts")
            for rep in reports:
                item.ihook.pytest_runtest_logreport(report=rep)
            return True

    return True
