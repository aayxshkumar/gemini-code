"""The app's look: glassy black, after Gemini's own. Colours live here and nowhere else.

Panels are translucent white over the window's dark background and its glows,
which frame.py paints. Qt can't blur what's behind a window without fragile
per-OS hooks, so the glass is layered translucency rather than real blur.
"""
from PySide6.QtGui import QColor, QFont, QPalette
from PySide6.QtWidgets import QApplication

BG = "#0b0b0d"
# Solid, for what floats above the window (menus, popups), which has nothing
# of the window behind it to show through.
POPUP = "#1b1c1f"
GLASS = "rgba(255, 255, 255, 10)"
GLASS_HOVER = "rgba(255, 255, 255, 20)"
GLASS_STRONG = "rgba(255, 255, 255, 30)"
GLASS_BORDER = "rgba(255, 255, 255, 24)"
INSET = "rgba(0, 0, 0, 110)"
TEXT = "#e8eaed"
MUTED = "#9aa0a6"
FAINT = "#5f6368"
ACCENT = "#8ab4f8"
ON_ACCENT = "#0b0b0d"
LINK = "#8ab4f8"
GOOD = "#81c995"
WARN = "#fdd663"
BAD = "#f28b82"
# Gemini's sparkle, blue to purple to rose.
GRADIENT = "qlineargradient(x1:0, y1:0, x2:1, y2:1, stop:0 #4f8df5, stop:0.55 #9b72cb, stop:1 #d96570)"
GRADIENT_HOVER = "qlineargradient(x1:0, y1:0, x2:1, y2:1, stop:0 #6aa0f7, stop:0.55 #ad88d6, stop:1 #e07d86)"

UI_FONT = "Segoe UI Variable Text"
MONO_FONT = "Cascadia Mono"
# Each system's own font, so no platform falls back to a generic one.
UI_STACK = f'"{UI_FONT}", "Segoe UI", "SF Pro Text", "Helvetica Neue", sans-serif'
MONO_STACK = f'"{MONO_FONT}", Consolas, Menlo, monospace'

STYLE = f"""
* {{ font-family: {UI_STACK}; font-size: 10pt; color: {TEXT}; }}
QMainWindow, QDialog {{ background: transparent; }}
QWidget#page, QWidget#titleBar, QStackedWidget {{ background: transparent; }}
QWidget#sidebar {{ background: {GLASS}; border: 1px solid {GLASS_BORDER}; border-radius: 16px; }}
QLabel {{ background: transparent; }}
QLabel#windowTitle {{ color: {MUTED}; font-size: 9pt; font-weight: 600; letter-spacing: 0.3px; }}
QLabel#heading {{ font-size: 16pt; font-weight: 600; }}
QLabel#muted, QLabel#help {{ color: {MUTED}; }}
QLabel#help {{ font-size: 9pt; }}

QPushButton#titleButton, QPushButton#closeButton {{
    background: transparent; border: none; border-radius: 8px; color: {MUTED}; padding: 0;
    font-family: "Segoe Fluent Icons", "Segoe MDL2 Assets", {UI_STACK}; font-size: 7pt;
}}
QPushButton#titleButton:hover {{ background: {GLASS_HOVER}; color: {TEXT}; }}
QPushButton#closeButton:hover {{ background: #c42b1c; color: white; }}

QListWidget#nav {{ background: transparent; border: none; outline: none; }}
QListWidget#nav::item {{ padding: 7px 12px; border-radius: 10px; color: {MUTED}; }}
QListWidget#nav::item:hover {{ background: {GLASS_HOVER}; color: {TEXT}; }}
QListWidget#nav::item:selected {{ background: {GLASS_STRONG}; color: {TEXT}; }}

QPushButton {{
    background: {GLASS}; border: 1px solid {GLASS_BORDER}; border-radius: 10px; padding: 7px 14px;
}}
QPushButton:hover {{ background: {GLASS_HOVER}; }}
QPushButton:pressed {{ background: {GLASS_STRONG}; }}
QPushButton:disabled {{ color: {FAINT}; background: transparent; border-color: {GLASS}; }}
QPushButton:focus {{ border-color: {ACCENT}; }}
QPushButton#primary {{ background: {GRADIENT}; color: white; border: none; font-weight: 600; }}
QPushButton#primary:hover {{ background: {GRADIENT_HOVER}; }}
QPushButton#primary:disabled {{ background: {GLASS}; color: {FAINT}; }}
QPushButton#danger {{ color: {BAD}; }}
QPushButton#small {{ padding: 3px 10px; font-size: 9pt; }}
QPushButton#chip {{ padding: 3px 10px; font-size: 9pt; border-radius: 12px; }}
QPushButton#ghost {{
    background: transparent; border: none; border-radius: 10px; padding: 8px 12px; text-align: left;
}}
QPushButton#ghost:hover, QPushButton#ghost:focus {{ background: {GLASS_HOVER}; }}
QPushButton#ghost:disabled {{ color: {FAINT}; background: transparent; }}
QPushButton#newChat {{
    background: {GLASS}; border: 1px solid {GLASS_BORDER}; border-radius: 12px; padding: 9px 12px;
    text-align: left; font-weight: 600;
}}
QPushButton#newChat:hover {{ background: {GLASS_HOVER}; }}
QPushButton#newChat:disabled {{ color: {FAINT}; }}
QPushButton#pill {{
    background: transparent; border: none; border-radius: 14px; padding: 5px 10px; color: {MUTED};
}}
QPushButton#pill:hover, QPushButton#pill:focus {{ background: {GLASS_HOVER}; color: {TEXT}; }}
QPushButton#pill:disabled {{ color: {FAINT}; background: transparent; }}
QPushButton#pill::menu-indicator {{ image: none; width: 0; }}
QPushButton#pill:checked {{ color: {ACCENT}; background: rgba(138, 180, 248, 28); }}
QPushButton#icon {{
    background: transparent; border: 1px solid {GLASS_BORDER}; border-radius: 15px; padding: 0;
    color: {MUTED}; font-size: 13pt;
}}
QPushButton#icon:hover, QPushButton#icon:focus {{ background: {GLASS_HOVER}; color: {TEXT}; }}
QPushButton#icon:disabled {{ color: {FAINT}; }}
QPushButton#send, QPushButton#stop {{
    border: none; border-radius: 15px; padding: 0; font-size: 12pt; font-weight: 700;
}}
QPushButton#send {{ background: {GRADIENT}; color: white; }}
QPushButton#send:hover, QPushButton#send:focus {{ background: {GRADIENT_HOVER}; }}
QPushButton#send:disabled {{ background: {GLASS}; color: {FAINT}; }}
QPushButton#stop {{ background: {TEXT}; color: {BG}; font-size: 9pt; }}
QPushButton#stop:hover, QPushButton#stop:focus {{ background: {MUTED}; }}
QPushButton#chevron {{ background: transparent; border: none; padding: 0; color: {MUTED}; font-size: 9pt; }}
QPushButton#chevron:hover, QPushButton#chevron:focus {{ color: {TEXT}; }}
QPushButton#segment {{
    background: transparent; border: 1px solid {GLASS_BORDER}; border-radius: 8px; padding: 4px 10px; color: {MUTED};
}}
QPushButton#segment:hover, QPushButton#segment:focus {{ color: {TEXT}; }}
QPushButton#segment:checked {{ background: rgba(138, 180, 248, 34); color: {TEXT}; border-color: {ACCENT}; }}

QComboBox, QLineEdit, QSpinBox {{
    background: {INSET}; border: 1px solid {GLASS_BORDER}; border-radius: 10px; padding: 6px 10px;
    selection-background-color: {ACCENT}; selection-color: {ON_ACCENT};
}}
QComboBox:focus, QLineEdit:focus, QSpinBox:focus {{ border-color: {ACCENT}; }}
QComboBox:disabled, QLineEdit:disabled, QSpinBox:disabled {{ color: {FAINT}; }}
QComboBox::drop-down {{ border: none; width: 18px; }}
QComboBox QAbstractItemView {{
    background: {POPUP}; border: 1px solid {GLASS_BORDER}; outline: none;
    selection-background-color: {GLASS_STRONG}; selection-color: {TEXT};
}}
QSpinBox::up-button, QSpinBox::down-button {{ width: 0; border: none; }}
QCheckBox::indicator {{
    width: 16px; height: 16px; border: 1px solid {MUTED}; border-radius: 5px; background: {INSET};
}}
QCheckBox::indicator:checked {{ background: {ACCENT}; border-color: {ACCENT}; }}
QCheckBox::indicator:focus {{ border-color: {TEXT}; }}

QGroupBox {{
    background: {GLASS}; border: 1px solid {GLASS_BORDER}; border-radius: 14px; margin-top: 14px; padding: 12px;
    font-weight: 600;
}}
QGroupBox::title {{ subcontrol-origin: margin; left: 12px; padding: 0 4px; color: {MUTED}; }}
QGroupBox QLabel {{ font-weight: 400; }}

QMenu {{ background: {POPUP}; border: 1px solid {GLASS_BORDER}; border-radius: 12px; padding: 6px; }}
QMenu::item {{ padding: 7px 24px 7px 12px; border-radius: 8px; }}
QMenu::item:selected {{ background: {GLASS_STRONG}; }}
QMenu::item:disabled {{ color: {FAINT}; }}
QMenu::separator {{ height: 1px; background: {GLASS_BORDER}; margin: 6px 8px; }}

QScrollArea {{ background: transparent; border: none; }}
QScrollArea > QWidget > QWidget {{ background: transparent; }}
QScrollBar:vertical {{ background: transparent; width: 10px; margin: 2px; }}
QScrollBar:horizontal {{ background: transparent; height: 10px; margin: 2px; }}
QScrollBar::handle {{ background: {GLASS_STRONG}; border-radius: 3px; min-height: 24px; min-width: 24px; }}
QScrollBar::handle:hover {{ background: {MUTED}; }}
QScrollBar::add-line, QScrollBar::sub-line, QScrollBar::add-page, QScrollBar::sub-page {{
    background: none; border: none; width: 0; height: 0;
}}

QFrame#userBubble {{ background: {GLASS_STRONG}; border: 1px solid {GLASS_BORDER}; border-radius: 18px; }}
QFrame#codeBlock {{ background: {INSET}; border: 1px solid {GLASS_BORDER}; border-radius: 12px; }}
QFrame#confirm {{ background: {GLASS}; border: 1px solid rgba(138, 180, 248, 110); border-radius: 16px; }}
QFrame#composerBox {{ background: {GLASS}; border: 1px solid {GLASS_BORDER}; border-radius: 24px; }}
QFrame#picker {{ background: {POPUP}; border: 1px solid {GLASS_BORDER}; border-radius: 14px; }}
QFrame#pickerRow {{ background: transparent; border-radius: 10px; }}
QFrame#pickerRow:hover, QFrame#pickerRow:focus {{ background: {GLASS_STRONG}; }}
QFrame#pickerRow[locked="true"]:hover {{ background: transparent; }}
QFrame#pickerRule {{ background: {GLASS_BORDER}; max-height: 1px; min-height: 1px; border: none; }}
QPlainTextEdit#composer {{ background: transparent; border: none; padding: 2px; }}
QPlainTextEdit#code, QPlainTextEdit#log {{
    background: transparent; border: none; font-family: {MONO_STACK}; font-size: 9pt;
}}
QPlainTextEdit#log {{ background: {INSET}; border: 1px solid {GLASS_BORDER}; border-radius: 12px; padding: 8px; }}
QTextBrowser {{ background: transparent; border: none; }}
QTextBrowser#document {{ background: {INSET}; border: 1px solid {GLASS_BORDER}; border-radius: 12px; padding: 12px; }}
QLabel#tool {{ font-family: {MONO_STACK}; font-size: 9pt; }}
QLabel#detail {{ font-family: {MONO_STACK}; font-size: 9pt; color: {MUTED}; }}
QLabel#detailBad {{ font-family: {MONO_STACK}; font-size: 9pt; color: {BAD}; }}
QLabel#note {{ color: {MUTED}; font-size: 9pt; }}
QLabel#noteWarn {{ color: {WARN}; font-size: 9pt; }}
QLabel#noteBad {{ color: {BAD}; font-size: 9pt; }}
QLabel#noteGood {{ color: {GOOD}; font-size: 9pt; }}
QLabel#locked {{ color: {ACCENT}; font-size: 9pt; }}
QToolTip {{ background: {POPUP}; color: {TEXT}; border: 1px solid {GLASS_BORDER}; padding: 4px 6px; }}
"""


def mono_font() -> QFont:
    font = QFont(MONO_FONT)
    font.setStyleHint(QFont.StyleHint.Monospace)
    font.setPointSize(9)
    return font


def apply_theme(app: QApplication) -> None:
    app.setStyle("Fusion")
    palette = app.palette()
    palette.setColor(QPalette.ColorRole.Window, QColor(BG))
    palette.setColor(QPalette.ColorRole.WindowText, QColor(TEXT))
    palette.setColor(QPalette.ColorRole.Base, QColor(BG))
    palette.setColor(QPalette.ColorRole.Text, QColor(TEXT))
    palette.setColor(QPalette.ColorRole.Button, QColor(POPUP))
    palette.setColor(QPalette.ColorRole.ButtonText, QColor(TEXT))
    palette.setColor(QPalette.ColorRole.Link, QColor(LINK))
    palette.setColor(QPalette.ColorRole.LinkVisited, QColor(LINK))
    palette.setColor(QPalette.ColorRole.PlaceholderText, QColor(MUTED))
    palette.setColor(QPalette.ColorRole.Highlight, QColor(ACCENT))
    palette.setColor(QPalette.ColorRole.HighlightedText, QColor(ON_ACCENT))
    app.setPalette(palette)
    app.setStyleSheet(STYLE)
