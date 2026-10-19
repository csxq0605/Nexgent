from nexgent.runtime.contracts import FaultCategory
from nexgent.runtime.strategy import build_strategy_signature


def test_strategy_signature_transfers_across_repository_paths():
    left = build_strategy_signature(
        category=FaultCategory.CODE,
        signal="AssertionError: expected normalized vector",
        target_path="/workspace/repo-a/src/model.py",
        validator="python -m pytest -q",
    )
    right = build_strategy_signature(
        category=FaultCategory.CODE,
        signal="AssertionError: expected normalized vector",
        target_path="/different/repo-b/lib/solver.py",
        validator="python -m unittest -q",
    )
    timeout = build_strategy_signature(
        category=FaultCategory.TIMEOUT,
        signal="AssertionError: expected normalized vector",
        target_path="/different/repo-b/lib/solver.py",
        validator="python -m unittest -q",
    )

    assert left == right
    assert left != timeout
    assert "/workspace" not in left
