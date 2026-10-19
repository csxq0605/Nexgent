from nexgent.gui.theme import ThemeColors, theme_stylesheet


def test_theme_uses_agent_relay_palette():
    colors = ThemeColors()
    assert colors.brand == "#4B63FF"
    assert colors.violet == "#8D43FF"
    assert colors.accent == "#22D3EE"
    assert "QScrollBar" in theme_stylesheet(colors)


def test_gui_package_import_does_not_create_application():
    import subprocess
    import sys
    code = "from PyQt6.QtWidgets import QApplication; import nexgent.gui; print(QApplication.instance())"
    completed = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert completed.stdout.strip() == "None"
