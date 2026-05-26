"""Pytest configuration - set env vars for testing."""

import os
import tempfile

# Set test environment variables before any imports
os.environ.setdefault("MIMO_API_KEY", "test-key-for-testing")
os.environ.setdefault("MIMO_BASE_URL", "http://localhost:8080/v1")
os.environ.setdefault("MIMO_MODEL", "test-model")

# Redirect spill files to a temp directory during tests to prevent
# test artifacts from accumulating in .mimo/outputs/
_test_spill_dir = tempfile.mkdtemp(prefix="mimo_test_spill_")
os.environ.setdefault("MIMO_SPILL_DIR", _test_spill_dir)
