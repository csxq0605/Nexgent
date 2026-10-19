"""Repository-independent recovery strategy feature signatures."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from .contracts import FaultCategory


_TOKEN = re.compile(r"[a-zA-Z][a-zA-Z0-9_.-]{2,}")
_NOISE = {
    "error",
    "failed",
    "failure",
    "line",
    "path",
    "test",
    "tests",
    "the",
    "with",
}


def build_strategy_signature(
    *,
    category: FaultCategory | str,
    signal: str,
    target_path: str = "",
    validator: str = "command",
) -> str:
    """Build a stable feature key without embedding repository identity.

    Absolute paths and full command strings would prevent transfer.  This key
    retains only the fault class, target file kind, validator family, and a
    bounded normalized signal fingerprint.
    """

    category_value = category.value if isinstance(category, FaultCategory) else str(category)
    suffix = Path(target_path).suffix.lower() or Path(target_path).name.lower() or "unknown"
    validator_family = Path(validator.strip().split()[0]).name.lower() if validator.strip() else "unknown"
    tokens = sorted(
        {
            token.lower()
            for token in _TOKEN.findall(signal)
            if token.lower() not in _NOISE and not token.isdigit()
        }
    )[:8]
    fingerprint = hashlib.sha256("|".join(tokens).encode("utf-8")).hexdigest()[:12]
    return f"strategy:v1:{category_value}:{suffix}:{validator_family}:{fingerprint}"
