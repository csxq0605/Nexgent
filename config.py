"""Shared config — loads .env from repo root."""
import os
from pathlib import Path
from dotenv import load_dotenv

_env_path = Path(__file__).resolve().parent / ".env"
load_dotenv(_env_path)


def _get(key: str, default: str = "") -> str:
    val = os.environ.get(key, default)
    if not val:
        raise EnvironmentError(
            f"Missing {key}. Create a .env file with {key}=... (see .env.example)"
        )
    return val


MIMO_BASE_URL = _get("MIMO_BASE_URL", "https://token-plan-cn.xiaomimimo.com/v1")
MIMO_API_KEY = _get("MIMO_API_KEY")
MIMO_MODEL = _get("MIMO_MODEL", "mimo-v2.5-pro")
