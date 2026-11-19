"""The composer's model picker. It only ever shows what Gemini offered this account."""
from __future__ import annotations

from PySide6.QtCore import QPoint, Qt, Signal
from PySide6.QtWidgets import QFrame, QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget

WIDTH = 300


class PickerRow(QFrame):
    """A model: name and description, with a tick or a note on the right."""

    chosen = Signal(str)

    def __init__(self, model: dict, parent: QWidget | None = None):
        super().__init__(parent)
        self.setObjectName("pickerRow")
        self.name = model["name"]
        self.locked = bool(model.get("locked"))
        self.setProperty("locked", self.locked)
        self.setAttribute(Qt.WidgetAttribute.WA_Hover)
        self.setAccessibleName(self.name)

        name = QLabel(self.name)
        text = QVBoxLayout()
        text.setSpacing(0)
        text.addWidget(name)
        if model.get("description"):
            description = QLabel(model["description"])
            description.setObjectName("help")
            text.addWidget(description)

        row = QHBoxLayout(self)
        row.setContentsMargins(10, 6, 10, 6)
        row.addLayout(text, 1)
        if self.locked:
            # Gemini answers these with a paid upgrade dialog, so they aren't
            # offered as choices at all.
            tag = QLabel("Upgrade")
            tag.setObjectName("locked")
            row.addWidget(tag)
            name.setObjectName("muted")
            self.setToolTip("Not included in your Gemini plan")
        else:
            self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
            self.setCursor(Qt.CursorShape.PointingHandCursor)
            if model.get("selected"):
                row.addWidget(QLabel("✓"))

    def mouseReleaseEvent(self, event) -> None:
        if not self.locked and self.rect().contains(event.position().toPoint()):
            self.chosen.emit(self.name)

    def keyPressEvent(self, event) -> None:
        if event.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter, Qt.Key.Key_Space) and not self.locked:
            self.chosen.emit(self.name)
        else:
            super().keyPressEvent(event)


class ModelPopup(QWidget):
    modelChosen = Signal(str)
    thinkingChosen = Signal(str)

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent, Qt.WindowType.Popup | Qt.WindowType.FramelessWindowHint)
        # The window is see-through and the frame inside it paints the panel:
        # a translucent window doesn't paint its own stylesheet background,
        # and an opaque one would show square corners around the rounded panel.
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setFixedWidth(WIDTH)
        panel = QFrame()
        panel.setObjectName("picker")
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(panel)
        self._column = QVBoxLayout(panel)
        self._column.setContentsMargins(6, 6, 6, 8)
        self._column.setSpacing(2)
        self.rows: list[PickerRow] = []
        self.levels: dict[str, QPushButton] = {}

    def set_menu(self, menu: dict | None) -> None:
        while self._column.count():
            item = self._column.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
            elif item.layout():
                while item.layout().count():
                    child = item.layout().takeAt(0)
                    if child.widget():
                        child.widget().deleteLater()
        self.rows = []
        self.levels = {}

        models = (menu or {}).get("models") or []
        if not models:
            note = QLabel("Couldn't read the model list from Gemini.")
            note.setObjectName("help")
            note.setContentsMargins(10, 6, 10, 6)
            self._column.addWidget(note)
        for model in models:
            row = PickerRow(model)
            row.chosen.connect(self.modelChosen)
            self.rows.append(row)
            self._column.addWidget(row)

        thinking = (menu or {}).get("thinking") or []
        if thinking:
            rule = QFrame()
            rule.setObjectName("pickerRule")
            self._column.addSpacing(4)
            self._column.addWidget(rule)
            self._column.addSpacing(4)
            title = QLabel("Thinking")
            title.setObjectName("help")
            title.setContentsMargins(10, 0, 10, 2)
            self._column.addWidget(title)

            segments = QHBoxLayout()
            segments.setContentsMargins(10, 0, 10, 0)
            segments.setSpacing(4)
            for level in thinking:
                button = QPushButton(level["name"])
                button.setObjectName("segment")
                button.setCheckable(True)
                button.setChecked(bool(level.get("selected")))
                button.setToolTip(level.get("description", ""))
                button.clicked.connect(lambda _=False, name=level["name"]: self.thinkingChosen.emit(name))
                self.levels[level["name"]] = button
                segments.addWidget(button)
            self._column.addLayout(segments)
        self.adjustSize()

    def show_above(self, anchor: QWidget) -> None:
        self.adjustSize()
        corner = anchor.mapToGlobal(QPoint(anchor.width(), 0))
        self.move(corner.x() - self.width(), corner.y() - self.height() - 6)
        self.show()


def picker_label(menu: dict | None) -> str:
    """The pill's text: what's selected, in Gemini's own words."""
    menu = menu or {}
    model = next((m["name"] for m in menu.get("models") or [] if m.get("selected")), None)
    level = next((t["name"] for t in menu.get("thinking") or [] if t.get("selected")), None)
    name = model or menu.get("current") or "Model"
    return f"{name} · {level}" if level else name
