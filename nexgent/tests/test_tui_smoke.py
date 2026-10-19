import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import MagicMock

from nexgent.context import Session
from nexgent.tui import MiMoTUI


def test_textual_tui_mounts_and_exits(tmp_path):
    harness = MagicMock()
    harness.model = "test-model"
    harness.plan_mode = False
    harness.perms.auto_approve = False
    harness.perms.dry_run = False
    harness.perms.mode = SimpleNamespace(value="default")
    harness.get_subagent_summary.return_value = {}
    app = MiMoTUI(
        harness=harness,
        session=Session("tui-smoke", auto_save_dir=str(tmp_path)),
        memory_store=MagicMock(),
        checkpoint_manager=MagicMock(),
        session_dir=str(tmp_path),
        config_watcher=MagicMock(),
        scheduler=None,
        scheduled_prompts=[],
        scheduled_lock=threading.Lock(),
    )

    async def run():
        async with app.run_test(size=(100, 30)) as pilot:
            await pilot.pause()
            assert app.query_one("#input-area") is not None

    asyncio.run(run())
