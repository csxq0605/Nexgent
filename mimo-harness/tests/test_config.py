"""Tests for configuration module."""

import os
import pytest
import importlib
import mimo_harness.config


@pytest.fixture(autouse=True)
def _restore_config():
    """Reload config after each test to restore original module-level values."""
    yield
    importlib.reload(mimo_harness.config)


class TestConfigEnvVars:
    def test_config_env_vars(self, monkeypatch):
        monkeypatch.setenv("MIMO_BASE_URL", "http://custom.api.com/v1")
        monkeypatch.setenv("MIMO_API_KEY", "my-secret-key")
        monkeypatch.setenv("MIMO_MODEL", "my-custom-model")
        importlib.reload(mimo_harness.config)
        assert mimo_harness.config.MIMO_BASE_URL == "http://custom.api.com/v1"
        assert mimo_harness.config.MIMO_API_KEY == "my-secret-key"
        assert mimo_harness.config.MIMO_MODEL == "my-custom-model"

    def test_config_defaults(self):
        assert mimo_harness.config.MIMO_MODEL  # not empty
        assert mimo_harness.config.MIMO_BASE_URL  # not empty


class TestRequireApiKey:
    def test_require_api_key_present(self, monkeypatch):
        monkeypatch.setenv("MIMO_API_KEY", "test-key-123")
        importlib.reload(mimo_harness.config)
        key = mimo_harness.config.require_api_key()
        assert key == "test-key-123"

    def test_require_api_key_missing(self, monkeypatch):
        monkeypatch.setattr(mimo_harness.config, "MIMO_API_KEY", "")
        with pytest.raises(EnvironmentError, match="Missing MIMO_API_KEY"):
            mimo_harness.config.require_api_key()


class TestConfigDefaults:
    """Test config default values."""

    def test_default_base_url(self, monkeypatch):
        monkeypatch.delenv("MIMO_BASE_URL", raising=False)
        importlib.reload(mimo_harness.config)
        assert "mimo" in mimo_harness.config.MIMO_BASE_URL.lower() or "api" in mimo_harness.config.MIMO_BASE_URL.lower()

    def test_default_model(self, monkeypatch):
        monkeypatch.delenv("MIMO_MODEL", raising=False)
        importlib.reload(mimo_harness.config)
        assert "mimo" in mimo_harness.config.MIMO_MODEL.lower()

    def test_env_override(self, monkeypatch):
        monkeypatch.setenv("MIMO_MODEL", "custom-model-v1")
        importlib.reload(mimo_harness.config)
        assert mimo_harness.config.MIMO_MODEL == "custom-model-v1"
