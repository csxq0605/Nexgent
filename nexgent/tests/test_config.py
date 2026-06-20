"""Tests for configuration module."""

import os
import pytest
import importlib
import nexgent.config


@pytest.fixture(autouse=True)
def _restore_config():
    """Reload config after each test to restore original module-level values."""
    yield
    importlib.reload(nexgent.config)


class TestConfigEnvVars:
    def test_config_env_vars(self, monkeypatch):
        # Hide models.json so env vars are actually tested
        _real_exists = os.path.exists
        monkeypatch.setattr(os.path, "exists", lambda p: False if "models.json" in str(p) else _real_exists(p))
        monkeypatch.setenv("NEXGENT_BASE_URL", "http://custom.api.com/v1")
        monkeypatch.setenv("NEXGENT_API_KEY", "my-secret-key")
        monkeypatch.setenv("NEXGENT_MODEL", "my-custom-model")
        importlib.reload(nexgent.config)
        assert nexgent.config.NEXGENT_BASE_URL == "http://custom.api.com/v1"
        assert nexgent.config.NEXGENT_API_KEY == "my-secret-key"
        assert nexgent.config.NEXGENT_MODEL == "my-custom-model"

    def test_config_defaults(self):
        assert nexgent.config.NEXGENT_MODEL  # not empty
        assert nexgent.config.NEXGENT_BASE_URL  # not empty


class TestRequireApiKey:
    def test_require_api_key_present(self, monkeypatch):
        _real_exists = os.path.exists
        monkeypatch.setattr(os.path, "exists", lambda p: False if "models.json" in str(p) else _real_exists(p))
        monkeypatch.setenv("NEXGENT_API_KEY", "test-key-123")
        importlib.reload(nexgent.config)
        key = nexgent.config.require_api_key()
        assert key == "test-key-123"

    def test_require_api_key_missing(self, monkeypatch):
        monkeypatch.setattr(nexgent.config, "NEXGENT_API_KEY", "")
        with pytest.raises(EnvironmentError, match="Missing NEXGENT_API_KEY"):
            nexgent.config.require_api_key()


class TestConfigDefaults:
    """Test config default values."""

    def test_default_base_url(self, monkeypatch):
        monkeypatch.delenv("NEXGENT_BASE_URL", raising=False)
        importlib.reload(nexgent.config)
        assert "mimo" in nexgent.config.NEXGENT_BASE_URL.lower() or "api" in nexgent.config.NEXGENT_BASE_URL.lower()

    def test_default_model(self, monkeypatch):
        monkeypatch.delenv("NEXGENT_MODEL", raising=False)
        importlib.reload(nexgent.config)
        assert "mimo" in nexgent.config.NEXGENT_MODEL.lower()

    def test_env_override(self, monkeypatch):
        _real_exists = os.path.exists
        monkeypatch.setattr(os.path, "exists", lambda p: False if "models.json" in str(p) else _real_exists(p))
        monkeypatch.setenv("NEXGENT_MODEL", "custom-model-v1")
        importlib.reload(nexgent.config)
        assert nexgent.config.NEXGENT_MODEL == "custom-model-v1"
