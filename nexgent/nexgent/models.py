"""Multi-model configuration — unified management of multiple LLM providers.

Supports:
- Multiple model providers with different base URLs and API keys
- Named model profiles (e.g. "fast", "smart", "code")
- Default model for main conversation vs subagents
- Runtime switching via /model command
- models.json configuration file

Example models.json:
{
  "providers": {
    "mimo": {
      "base_url": "https://token-plan-cn.xiaomimimo.com/v1",
      "api_key": "...",
      "models": {
        "mimo-v2.5-pro": {"description": "MiMo Pro", "tags": ["smart", "default"]},
        "mimo-v2.5-flash": {"description": "MiMo Flash", "tags": ["fast"]}
      }
    },
    "openai": {
      "base_url": "https://api.openai.com/v1",
      "api_key": "...",
      "models": {
        "gpt-4o": {"description": "GPT-4o", "tags": ["smart"]},
        "gpt-4o-mini": {"description": "GPT-4o Mini", "tags": ["fast"]}
      }
    },
    "deepseek": {
      "base_url": "https://api.deepseek.com/v1",
      "api_key": "...",
      "models": {
        "deepseek-chat": {"description": "DeepSeek V3", "tags": ["smart", "code"]},
        "deepseek-reasoner": {"description": "DeepSeek R1", "tags": ["reasoning"]}
      }
    }
  },
  "defaults": {
    "main": "mimo/mimo-v2.5-pro",
    "subagent": "mimo/mimo-v2.5-pro",
    "fast": "mimo/mimo-v2.5-flash"
  }
}
"""

import json
import os
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .config import NEXGENT_BASE_URL, NEXGENT_API_KEY, NEXGENT_MODEL

_logger = logging.getLogger("nexgent.models")


@dataclass
class ModelProfile:
    """A single model configuration."""
    provider: str          # e.g. "mimo", "openai"
    model_name: str        # e.g. "mimo-v2.5-pro"
    base_url: str          # e.g. "https://api.openai.com/v1"
    api_key: str           # API key
    description: str = ""  # Human-readable description
    tags: list[str] = field(default_factory=list)  # e.g. ["fast", "code"]

    @property
    def full_id(self) -> str:
        """Full model ID: provider/model_name"""
        return f"{self.provider}/{self.model_name}"

    @property
    def short_id(self) -> str:
        """Short model ID: model_name only"""
        return self.model_name

    def to_dict(self) -> dict:
        return {
            "provider": self.provider,
            "model_name": self.model_name,
            "base_url": self.base_url,
            "description": self.description,
            "tags": self.tags,
        }


class ModelRegistry:
    """Registry of available models with provider configuration.

    Loads from models.json or falls back to env vars (NEXGENT_*).
    """

    def __init__(self):
        self._profiles: dict[str, ModelProfile] = {}  # full_id -> profile
        self._defaults: dict[str, str] = {}  # role -> full_id
        self._loaded = False

    @staticmethod
    def _candidate_paths(relative: str) -> list[str]:
        """Return search locations for a config file: CWD → ~/.nexgent/ → package root."""
        package_root = str(Path(__file__).resolve().parent.parent)
        home_nexgent = str(Path.home() / ".nexgent")
        return [
            os.path.join(os.getcwd(), relative),
            os.path.join(home_nexgent, relative),
            os.path.join(package_root, relative),
        ]

    def load(self, config_path: str = None):
        """Load model configurations.

        Priority:
        1. Explicit config_path argument
        2. MODELS_CONFIG env var (path to models.json)
        3. models.json searched in: CWD → ~/.nexgent/ → package root
        4. Fallback to NEXGENT_* env vars
        """
        if self._loaded:
            return
        self._loaded = True

        # Try loading from JSON config
        config_data = None
        search_paths = []
        if config_path:
            search_paths.append(config_path)
        env_config = os.environ.get("MODELS_CONFIG", "")
        if env_config:
            search_paths.append(env_config)
        search_paths.extend(self._candidate_paths("models.json"))
        search_paths.extend(self._candidate_paths(".nexgent/models.json"))

        for path in search_paths:
            if path and os.path.exists(path):
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        config_data = json.load(f)
                    _logger.info(f"Loaded model config from {path}")
                    break
                except Exception as e:
                    _logger.warning(f"Failed to load {path}: {e}")

        if config_data:
            self._load_from_dict(config_data)
        else:
            self._load_from_env()

    def reload(self, config_path: str = None):
        """Discard cached profiles and reload configuration from disk."""
        self._profiles.clear()
        self._defaults.clear()
        self._loaded = False
        self.load(config_path)

    def _load_from_dict(self, data: dict):
        """Load from parsed JSON config."""
        providers = data.get("providers", {})
        for provider_name, provider_cfg in providers.items():
            base_url = provider_cfg.get("base_url", "")
            api_key = provider_cfg.get("api_key", "")
            # Support env var expansion: ${VAR}
            if api_key.startswith("${") and api_key.endswith("}"):
                env_key = api_key[2:-1]
                api_key = os.environ.get(env_key, "")
            models = provider_cfg.get("models", {})
            for model_name, model_cfg in models.items():
                profile = ModelProfile(
                    provider=provider_name,
                    model_name=model_name,
                    base_url=base_url,
                    api_key=api_key,
                    description=model_cfg.get("description", ""),
                    tags=model_cfg.get("tags", []),
                )
                self._profiles[profile.full_id] = profile

        # Load defaults
        defaults = data.get("defaults", {})
        for role, model_id in defaults.items():
            self._defaults[role] = model_id

    def _load_from_env(self):
        """Fallback: create a single profile from NEXGENT_* env vars."""
        profile = ModelProfile(
            provider="mimo",
            model_name=NEXGENT_MODEL,
            base_url=NEXGENT_BASE_URL,
            api_key=NEXGENT_API_KEY,
            description=f"Default ({NEXGENT_MODEL})",
            tags=["default"],
        )
        self._profiles[profile.full_id] = profile
        self._defaults["main"] = profile.full_id
        self._defaults["subagent"] = profile.full_id
        self._defaults["fast"] = profile.full_id

    def get_profile(self, model_id: str) -> Optional[ModelProfile]:
        """Get a model profile by full_id (provider/model) or short_id (model)."""
        if model_id in self._profiles:
            return self._profiles[model_id]
        # Try short ID match
        for profile in self._profiles.values():
            if profile.short_id == model_id or profile.model_name == model_id:
                return profile
        # Try tag match
        for profile in self._profiles.values():
            if model_id in profile.tags:
                return profile
        return None

    def get_default(self, role: str = "main") -> ModelProfile:
        """Get default model for a role (main/subagent/fast)."""
        model_id = self._defaults.get(role, "")
        if model_id:
            profile = self.get_profile(model_id)
            if profile:
                return profile
        # Fallback to first available profile
        if self._profiles:
            return next(iter(self._profiles.values()))
        # Ultimate fallback: create from env
        return ModelProfile(
            provider="mimo",
            model_name=NEXGENT_MODEL,
            base_url=NEXGENT_BASE_URL,
            api_key=NEXGENT_API_KEY,
        )

    def list_profiles(self) -> list[ModelProfile]:
        """List all available model profiles."""
        return list(self._profiles.values())

    def set_default(self, role: str, model_id: str) -> bool:
        """Set default model for a role. Returns True if model exists."""
        profile = self.get_profile(model_id)
        if profile:
            self._defaults[role] = profile.full_id
            return True
        return False

    def get_defaults(self) -> dict[str, str]:
        """Get all defaults."""
        return dict(self._defaults)


# Global singleton
_registry = ModelRegistry()


def get_model_registry() -> ModelRegistry:
    """Get the global model registry (lazy-loaded)."""
    if not _registry._loaded:
        _registry.load()
    return _registry
