"""AutoReport-inspired Nexgent visual tokens and Qt stylesheet."""

from dataclasses import dataclass


@dataclass(frozen=True)
class ThemeColors:
    ink: str = "#171D3B"
    night: str = "#080B1D"
    background: str = "#F5F7FB"
    surface: str = "#FFFFFF"
    panel: str = "#F9FAFC"
    border: str = "#DDE2EC"
    foreground: str = "#273044"
    muted: str = "#6F7890"
    brand: str = "#4B63FF"
    violet: str = "#8D43FF"
    accent: str = "#22D3EE"
    danger: str = "#D92D20"
    warning: str = "#B54708"
    success: str = "#087A55"


def theme_stylesheet(colors: ThemeColors = ThemeColors()) -> str:
    return f"""
    * {{ font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", sans-serif; }}
    QMainWindow, QDialog {{ background: {colors.background}; color: {colors.foreground}; }}
    QWidget {{ color: {colors.foreground}; font-size: 13px; }}
    QFrame#Panel, QFrame#Card {{ background: {colors.surface}; border: 1px solid {colors.border}; border-radius: 10px; }}
    QFrame#Composer {{ background: {colors.surface}; border: 1px solid {colors.border}; border-radius: 10px; }}
    QFrame#Composer:focus-within {{ border-color: {colors.brand}; }}
    QLabel#Brand {{ color: {colors.ink}; font-size: 18px; font-weight: 700; }}
    QLabel#Muted {{ color: {colors.muted}; }}
    QLabel#Section {{ color: {colors.ink}; font-size: 12px; font-weight: 700; letter-spacing: 1px; }}
    QPushButton {{ background: {colors.surface}; border: 1px solid {colors.border}; border-radius: 7px; padding: 6px 11px; }}
    QPushButton:hover {{ border-color: {colors.brand}; background: #F2F4FF; }}
    QPushButton#Primary {{ color: white; background: {colors.brand}; border-color: {colors.brand}; font-weight: 600; }}
    QPushButton#Primary:hover {{ background: #3B50E6; }}
    QPushButton#Danger {{ color: {colors.danger}; }}
    QLineEdit, QPlainTextEdit, QTextBrowser, QComboBox {{ background: {colors.surface}; border: 1px solid {colors.border}; border-radius: 8px; padding: 6px; selection-background-color: {colors.brand}; }}
    QTextBrowser#Conversation {{ border: 0; padding: 8px; }}
    QFrame#Composer QPlainTextEdit {{ border: 0; padding: 2px; }}
    QLineEdit:focus, QPlainTextEdit:focus, QTextBrowser:focus, QComboBox:focus {{ border-color: {colors.brand}; }}
    QTreeView, QListWidget, QTableWidget {{ background: {colors.surface}; border: 0; outline: 0; alternate-background-color: {colors.panel}; }}
    QTreeView::item, QListWidget::item {{ padding: 4px; border-radius: 5px; }}
    QTreeView::item:selected, QListWidget::item:selected {{ background: #E9ECFF; color: {colors.ink}; }}
    QHeaderView::section {{ background: {colors.panel}; border: 0; border-bottom: 1px solid {colors.border}; padding: 6px; color: {colors.muted}; }}
    QTabWidget::pane {{ border: 1px solid {colors.border}; background: {colors.surface}; border-radius: 8px; }}
    QTabBar::tab {{ padding: 7px 14px; color: {colors.muted}; border-bottom: 2px solid transparent; }}
    QTabBar::tab:selected {{ color: {colors.brand}; border-bottom-color: {colors.brand}; font-weight: 600; }}
    QAbstractItemView#qt_completer_popup {{ background: {colors.surface}; border: 1px solid {colors.border}; border-radius: 8px; padding: 4px; selection-background-color: #E9ECFF; selection-color: {colors.ink}; }}
    QSplitter::handle {{ background: {colors.border}; width: 1px; height: 1px; }}
    QScrollBar:vertical {{ background: transparent; width: 9px; margin: 2px; }}
    QScrollBar::handle:vertical {{ background: #BEC5D4; border-radius: 4px; min-height: 28px; }}
    QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
    QToolTip {{ color: white; background: {colors.ink}; border: 0; padding: 5px; }}
    """
