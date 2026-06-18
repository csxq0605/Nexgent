"""Settings hierarchy - 4-level configuration with deny-rule precedence.

Hierarchy (later levels override earlier, but deny rules always win):
  managed:  .mimo/managed.json          (enterprise, cannot be overridden)
  user:     ~/.mimo/settings.json       (user-level)
  project:  .mimo/settings.json         (project-level, committable)
  local:    .mimo/settings.local.json   (project-level, gitignored)
"""

import json
import os
from pathlib import Path
from typing import Any

SETTINGS_LEVELS = ["managed", "user", "project", "local"]


class SettingsManager:
    """Manages hierarchical settings with deny-rule precedence.

    Later levels override earlier ones, but deny rules at any level
    accumulate and cannot be overridden by subsequent levels.
    """

    def __init__(self, project_dir: str = "."):
        self._settings: dict = {}
        self._load_all(project_dir)

    def _load_all(self, project_dir: str):
        paths = {
            "managed": os.path.join(project_dir, ".mimo", "managed.json"),
            "user": os.path.join(str(Path.home()), ".mimo", "settings.json"),
            "project": os.path.join(project_dir, ".mimo", "settings.json"),
            "local": os.path.join(project_dir, ".mimo", "settings.local.json"),
        }
        for level in SETTINGS_LEVELS:
            self._merge_level(level, paths[level])

    def _merge_level(self, level: str, path: str):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            return

        for key, value in data.items():
            # Deny rules accumulate across all levels and cannot be overridden
            if key == "permissions" and isinstance(value, dict):
                # Save accumulated deny rules before overwriting
                existing_deny = (
                    self._settings.get("permissions", {}).get("deny", [])
                )
                new_deny = value.get("deny", [])
                merged_deny = list(dict.fromkeys(existing_deny + new_deny))
                # Merge: start with new value, then restore accumulated denies
                self._settings[key] = dict(value)
                if merged_deny:
                    self._settings[key]["deny"] = merged_deny
            else:
                self._settings[key] = value

    def get(self, key: str, default=None) -> Any:
        """Retrieve a top-level setting."""
        return self._settings.get(key, default)

    def get_nested(self, *keys, default=None) -> Any:
        """Retrieve a nested setting by a sequence of keys.

        Example: settings.get_nested("permissions", "allow")
        """
        current = self._settings
        for key in keys:
            if not isinstance(current, dict):
                return default
            current = current.get(key)
            if current is None:
                return default
        return current

    @property
    def raw(self) -> dict:
        """Return the merged settings dictionary (read-only view)."""
        return dict(self._settings)
