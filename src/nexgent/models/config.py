"""Read this project's model settings without mutating the process environment."""

from dataclasses import dataclass, field
import json
import os
from pathlib import Path


class ModelConfigurationError(RuntimeError):
    pass


@dataclass(frozen=True)
class Profile:
    id: str
    model: str
    base_url: str
    api_key: str = field(repr=False)


def load_profiles(project_root):
    root = Path(project_root).resolve()
    env = {}
    dotenv = root / ".env"
    if dotenv.is_file():
        for line in dotenv.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.removeprefix("export ").split("=", 1)
            value = value.strip()
            if len(value) > 1 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            env[key.strip()] = value
    env.update(os.environ)
    path = next((p for p in (root / "models.json", root / ".nexgent" / "models.json") if p.is_file()), None)
    if path is None:
        model = env.get("NEXGENT_MODEL", "mimo-v2.5")
        profile = Profile("configured/" + model, model,
                          env.get("NEXGENT_BASE_URL", "https://token-plan-cn.xiaomimimo.com/v1"),
                          env.get("NEXGENT_API_KEY", ""))
        return {profile.id: profile}, {"main": profile.id, "subagent": profile.id}
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        profiles = {}
        for provider, settings in data["providers"].items():
            key = settings.get("api_key", "")
            if isinstance(key, str) and key.startswith("${") and key.endswith("}"):
                key = env.get(key[2:-1], "")
            for model in settings["models"]:
                identity = provider + "/" + model
                profiles[identity] = Profile(identity, model, settings.get("base_url", ""), key)
        defaults = data.get("defaults", {})
        if not profiles or not isinstance(defaults, dict):
            raise ValueError("No profiles")
        return profiles, defaults
    except (ValueError, KeyError, TypeError, AttributeError):
        raise ModelConfigurationError("Project models.json has an invalid provider configuration") from None
