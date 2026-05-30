"""Pytest configuration - set env vars for testing.

E2E tests (test_e2e.py) use the real API from .env — skip mock overrides.
"""

import os
import atexit
import shutil
import tempfile
from pathlib import Path
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
