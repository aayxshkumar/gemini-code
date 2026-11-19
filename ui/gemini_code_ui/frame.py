"""The borderless window's own frame: its glassy background, title bar and resize edges."""
from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QIcon, QPainter, QPainterPath, QRadialGradient
from PySide6.QtWidgets import QHBoxLayout, QLabel, QPushButton, QSizePolicy, QVBoxLayout, QWidget

from . import theme

LOGO = Path(__file__).resolve().parent / "assets" / "logo.png"
IS_WINDOWS = sys.platform == "win32"
# Windows' own caption icons, from the font its native title bars use, so the
# buttons match every other window. Elsewhere, ordinary characters.
GLYPHS = (
    {"minimize": "", "maximize": "", "restore": "", "close": ""}
    if IS_WINDOWS
    else {"minimize": "–", "maximize": "▢", "restore": "❐", "close": "✕"}
)
RADIUS = 14
# A band around the edge that takes resize drags. It's painted nearly clear
# rather than fully: a fully clear pixel lets the click through to whatever
# is behind the window, on Windows.
EDGE = 6
SHADOW_STEPS = 6
IS_MAC = sys.platform == "darwin"

# The glows behind the glass, as (x, y) of the window's size, radius and colour.
GLOWS = (
    (0.12, 0.0, 0.75, QColor(66, 133, 244, 46)),
    (0.95, 1.0, 0.85, QColor(155, 114, 203, 40)),
    (0.55, 0.55, 0.6, QColor(217, 101, 112, 14)),
)


class FrameWidget(QWidget):
    """Paints the window and turns drags on its edges into native resizes."""

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.setMouseTracking(True)
        self.maximized = False
        self.column = QVBoxLayout(self)
        self.column.setSpacing(0)
        self.set_maximized(False)

    def set_maximized(self, maximized: bool) -> None:
        self.maximized = maximized
        margin = 0 if maximized else EDGE
        self.column.setContentsMargins(margin, margin, margin, margin)
        self.update()

    def _panel(self) -> QRectF:
        margin = 0 if self.maximized else EDGE
        return QRectF(self.rect()).adjusted(margin, margin, -margin, -margin)

    def paintEvent(self, _event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        panel = self._panel()
        radius = 0 if self.maximized else RADIUS

        if not self.maximized:
            # A soft shadow in the resize band, which also keeps it clickable.
            for step in range(SHADOW_STEPS, 0, -1):
                ring = panel.adjusted(-step, -step, step, step)
                painter.setPen(Qt.PenStyle.NoPen)
                painter.setBrush(QColor(0, 0, 0, max(2, 34 - step * 5)))
                painter.drawRoundedRect(ring, radius + step, radius + step)

        shape = QPainterPath()
        shape.addRoundedRect(panel, radius, radius)
        painter.setClipPath(shape)
        painter.fillPath(shape, QColor(theme.BG))
        for x, y, size, colour in GLOWS:
            centre = QPointF(panel.left() + panel.width() * x, panel.top() + panel.height() * y)
            glow = QRadialGradient(centre, max(panel.width(), panel.height()) * size)
            glow.setColorAt(0, colour)
            glow.setColorAt(1, QColor(colour.red(), colour.green(), colour.blue(), 0))
            painter.fillRect(panel, glow)
        painter.setClipping(False)
        painter.setPen(QColor(255, 255, 255, 26))
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawRoundedRect(panel.adjusted(0.5, 0.5, -0.5, -0.5), radius, radius)

    def _edges(self, pos) -> Qt.Edge:
        if self.maximized:
            return Qt.Edge(0)
        edges = Qt.Edge(0)
        grab = EDGE + 2
        if pos.x() <= grab:
            edges |= Qt.Edge.LeftEdge
        if pos.x() >= self.width() - grab:
            edges |= Qt.Edge.RightEdge
        if pos.y() <= grab:
            edges |= Qt.Edge.TopEdge
        if pos.y() >= self.height() - grab:
            edges |= Qt.Edge.BottomEdge
        return edges

    def mouseMoveEvent(self, event) -> None:
        edges = self._edges(event.position().toPoint())
        horizontal = edges & (Qt.Edge.LeftEdge | Qt.Edge.RightEdge)
        vertical = edges & (Qt.Edge.TopEdge | Qt.Edge.BottomEdge)
        if horizontal and vertical:
            falling = edges in (Qt.Edge.LeftEdge | Qt.Edge.TopEdge, Qt.Edge.RightEdge | Qt.Edge.BottomEdge)
            self.setCursor(Qt.CursorShape.SizeFDiagCursor if falling else Qt.CursorShape.SizeBDiagCursor)
        elif horizontal:
            self.setCursor(Qt.CursorShape.SizeHorCursor)
        elif vertical:
            self.setCursor(Qt.CursorShape.SizeVerCursor)
        else:
            self.unsetCursor()
        super().mouseMoveEvent(event)

    def mousePressEvent(self, event) -> None:
        edges = self._edges(event.position().toPoint())
        if event.button() == Qt.MouseButton.LeftButton and edges and self.window().windowHandle():
            self.window().windowHandle().startSystemResize(edges)
            return
        super().mousePressEvent(event)


class TitleBar(QWidget):
    """Moves the window, maximizes on double-click, and holds its buttons."""

    def __init__(self, window: QWidget):
        super().__init__()
        self._window = window
        self.setObjectName("titleBar")
        self.setFixedHeight(40)

        mark = QLabel()
        mark.setPixmap(QIcon(str(LOGO)).pixmap(18, 18))
        title = QLabel("gemini-code")
        title.setObjectName("windowTitle")
        self.minimize = self._button(GLYPHS["minimize"], "Minimize", window.showMinimized)
        self.maximize = self._button(GLYPHS["maximize"], "Maximize", self.toggle_maximized)
        self.close_button = self._button(GLYPHS["close"], "Close", window.close)
        self.close_button.setObjectName("closeButton")

        row = QHBoxLayout(self)
        row.setContentsMargins(14, 0, 6, 0)
        row.setSpacing(8)
        buttons = [self.close_button, self.minimize, self.maximize] if IS_MAC else [self.minimize, self.maximize, self.close_button]
        if IS_MAC:
            # Where Mac windows keep them, as round lights.
            for button, colour in zip(buttons, ("#ff5f57", "#febc2e", "#28c840")):
                button.setObjectName("macLight")
                button.setText("")
                button.setFixedSize(12, 12)
                button.setStyleSheet(f"background: {colour}; border-radius: 6px; border: none;")
                row.addWidget(button)
            row.addSpacing(10)
        row.addWidget(mark)
        row.addWidget(title)
        row.addStretch()
        if not IS_MAC:
            row.setSpacing(2)
            for button in buttons:
                row.addWidget(button)

    def _button(self, glyph: str, tip: str, action) -> QPushButton:
        button = QPushButton(glyph)
        button.setObjectName("titleButton")
        button.setToolTip(tip)
        button.setAccessibleName(tip)
        button.setFixedSize(40, 28)
        button.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        button.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Fixed)
        button.clicked.connect(action)
        return button

    def toggle_maximized(self) -> None:
        if self._window.isMaximized():
            self._window.showNormal()
        else:
            self._window.showMaximized()

    def show_state(self, maximized: bool) -> None:
        if not IS_MAC:
            self.maximize.setText(GLYPHS["restore"] if maximized else GLYPHS["maximize"])
        self.maximize.setToolTip("Restore" if maximized else "Maximize")

    def mousePressEvent(self, event) -> None:
        handle = self._window.windowHandle()
        if event.button() == Qt.MouseButton.LeftButton and handle:
            # The system's own move, so Windows snapping and Mac spaces work.
            handle.startSystemMove()
            return
        super().mousePressEvent(event)

    def mouseDoubleClickEvent(self, event) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            self.toggle_maximized()
