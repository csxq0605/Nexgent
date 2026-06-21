"""Fix import paths so `from src.auth.models import ...` works."""

import sys
from pathlib import Path

# Add demo-project root to sys.path so `import src` resolves
_demo_root = str(Path(__file__).resolve().parent.parent)
if _demo_root not in sys.path:
    sys.path.insert(0, _demo_root)
