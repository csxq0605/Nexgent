from nexgent.commands import SLASH_COMMANDS
from nexgent.gui.widgets.agent_panel import Composer


def test_every_command_is_discoverable_from_gui_composer(qtbot, tmp_path):
    composer = Composer(tmp_path)
    qtbot.addWidget(composer)
    composer.show()
    composer.setFocus()

    for command in SLASH_COMMANDS:
        composer.setPlainText(command)
        cursor = composer.textCursor()
        cursor.movePosition(cursor.MoveOperation.End)
        composer.setTextCursor(cursor)
        composer._update_completions()
        assert command in composer.completion_candidates
