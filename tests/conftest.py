"""Pytest configuration for root-level tests."""
import sys
import time
import importlib
import importlib.util
import functools
from pathlib import Path

import pytest
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
load_dotenv(REPO_ROOT / ".env")


def load_module(name: str, path: Path):
    """Import a module from a file path (handles hyphenated dirs)."""
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def repo_root():
    return REPO_ROOT


@pytest.fixture
def stage_module():
    """Factory fixture: call with (name, path) to load a stage module."""
    def _load(name: str, path: Path):
        return load_module(name, path)
    return _load


# Import shared E2E retry logic from mimo-harness tests
_e2e_utils_path = REPO_ROOT / "mimo-harness" / "tests" / "e2e_utils.py"
_e2e_utils = load_module("e2e_utils", _e2e_utils_path)
E2E_MAX_RETRIES = _e2e_utils.E2E_MAX_RETRIES
_is_retryable = _e2e_utils._is_retryable


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_protocol(item, nextitem):
    """Retry flaky E2E tests up to E2E_MAX_RETRIES on retryable errors."""
    is_e2e = "test_e2e" in str(item.fspath)
    if not is_e2e:
        return None  # use default protocol

    for attempt in range(E2E_MAX_RETRIES):
        # Run the test using the default protocol
        reports = pytest.runner.runtestprotocol(item, nextitem=nextitem, log=False)
        failed = any(r.failed and r.when == "call" for r in reports)
        if not failed:
            # Test passed — emit reports normally
            for rep in reports:
                item.ihook.pytest_runtest_logreport(report=rep)
            return True

        # Check if the failure is retryable
        call_report = next((r for r in reports if r.when == "call" and r.failed), None)
        if call_report is None:
            for rep in reports:
                item.ihook.pytest_runtest_logreport(report=rep)
            return True

        exc = call_report.excinfo[1] if call_report.excinfo else None
        if exc is None or not _is_retryable(exc):
            # Non-retryable — emit as-is
            for rep in reports:
                item.ihook.pytest_runtest_logreport(report=rep)
            return True

        # Retryable — backoff and retry
        if attempt < E2E_MAX_RETRIES - 1:
            backoff = 10 * (2 ** attempt)  # 10s, 20s
            print(f"\n  [RETRY] {item.nodeid} ({type(exc).__name__}), "
                  f"attempt {attempt + 1}/{E2E_MAX_RETRIES}, backoff {backoff}s...")
            time.sleep(backoff)
            # Discard these reports; we'll re-run
        else:
            # Final attempt — emit the failure reports
            print(f"\n  [RETRY] {item.nodeid} exhausted {E2E_MAX_RETRIES} attempts")
            for rep in reports:
                item.ihook.pytest_runtest_logreport(report=rep)
            return True

    return True
