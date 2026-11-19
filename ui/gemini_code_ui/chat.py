"""The conversation: messages, tool activity, approvals and the composer."""
from __future__ import annotations

import re
from html import escape
from pathlib import Path
from typing import Callable

from PySide6.QtCore import QSize, Qt, QTimer, QUrl, Signal
from PySide6.QtGui import QColor, QDesktopServices, QGuiApplication, QTextFrameFormat, QTextOption, QTextTable
from PySide6.QtWidgets import (
    QFileDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPlainTextEdit,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
)

from . import theme
from .theme import mono_font

CHAT_WIDTH = 780
MAX_CODE_LINES = 24
WIDE_CODE_CHARS = 90
MAX_COMPOSER_LINES = 8
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
OPENABLE_LINKS = {"http", "https", "mailto"}

FENCE = re.compile(r"^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$")


def split_markdown(text: str) -> list[tuple[str, str, str]]:
    """Splits a reply into ("text", body, "") and ("code", body, language).

    Code gets its own widget, for a copy button and no line wrapping. A fence
    left open runs to the end, which is how markdown treats it too.
    """
    parts: list[tuple[str, str, str]] = []
    prose: list[str] = []
    code: list[str] = []
    fence = ""
    language = ""

    def flush_prose() -> None:
        if "".join(prose).strip():
            parts.append(("text", "\n".join(prose).strip(), ""))
        prose.clear()

    for line in text.split("\n"):
        match = FENCE.match(line)
        if fence:
            if match and match.group(1).startswith(fence) and not match.group(2):
                parts.append(("code", "\n".join(code), language))
                code.clear()
                fence = ""
            else:
                code.append(line)
        elif match:
            flush_prose()
            fence, language = match.group(1), match.group(2)
        else:
            prose.append(line)

    if fence:
        parts.append(("code", "\n".join(code), language))
    flush_prose()
    return parts


def open_link(url: QUrl | str) -> None:
    # A reply is untrusted text, and a file: link to a program would run it.
    url = QUrl(url) if isinstance(url, str) else url
    if url.scheme().lower() in OPENABLE_LINKS:
        QDesktopServices.openUrl(url)


URL = re.compile(r"(?:https?://|www\.)[^\s<>\"'`]+", re.IGNORECASE)
CLOSERS = {")": "(", "]": "[", "}": "{"}


def _trim_url(url: str) -> str:
    """Drops what follows a URL in prose rather than belonging to it: a full
    stop, a comma, or a bracket that closes something opened before the URL."""
    while url:
        last = url[-1]
        if last in ".,;:!?'\"":
            url = url[:-1]
        elif last in CLOSERS and url.count(last) > url.count(CLOSERS[last]):
            url = url[:-1]
        else:
            break
    return url


def linkify(text: str) -> str:
    """Plain text as rich text, with every web address a link and the rest escaped."""
    out: list[str] = []
    last = 0
    for match in URL.finditer(text):
        url = _trim_url(match.group())
        if not url:
            continue
        href = url if url.lower().startswith("http") else f"https://{url}"
        out.append(escape(text[last:match.start()]))
        out.append(f'<a href="{escape(href, quote=True)}" style="color:{theme.LINK};">{escape(url)}</a>')
        last = match.start() + len(url)
    out.append(escape(text[last:]))
    # pre-wrap keeps the line breaks and spacing the text came with.
    return f'<span style="white-space: pre-wrap;">{"".join(out)}</span>'


BARE_URL = re.compile(r"(?<![(<\[\w/=\"'])(https?://[^\s<>()\[\]`]*[^\s<>()\[\]`.,;:!?'\"])", re.IGNORECASE)


def autolink_markdown(text: str) -> str:
    """Wraps bare URLs in <> so markdown makes them links. Not inside `code`,
    where a URL is meant to be read as it is, and not ones already in a link."""
    parts = re.split(r"(`+[^`]*`+)", text)
    for i in range(0, len(parts), 2):
        parts[i] = BARE_URL.sub(r"<\1>", parts[i])
    return "".join(parts)


class MarkdownView(QTextBrowser):
    """Selectable markdown that is exactly as tall as its text."""

    def __init__(self, text: str, parent: QWidget | None = None):
        super().__init__(parent)
        self.setOpenLinks(False)
        self.anchorClicked.connect(open_link)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.setWordWrapMode(QTextOption.WrapMode.WrapAtWordBoundaryOrAnywhere)
        self.document().setDocumentMargin(0)
        self.setMarkdown(autolink_markdown(text))
        self._soften_tables()
        self.document().contentsChanged.connect(self._fit)
        self._fit()

    def _soften_tables(self) -> None:
        """Markdown tables come with thick white borders, which glare on glass.
        A stylesheet can't reach them through setMarkdown, so set them directly."""
        for frame in self.document().rootFrame().childFrames():
            if isinstance(frame, QTextTable):
                table_format = frame.format()
                table_format.setBorder(1)
                table_format.setBorderStyle(QTextFrameFormat.BorderStyle.BorderStyle_Solid)
                table_format.setBorderBrush(QColor(255, 255, 255, 40))
                table_format.setBorderCollapse(True)
                table_format.setCellPadding(6)
                table_format.setCellSpacing(0)
                frame.setFormat(table_format)

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        self._fit()

    def _fit(self) -> None:
        self.document().setTextWidth(self.viewport().width())
        self.setFixedHeight(int(self.document().size().height()) + 2)


class CodeBlock(QFrame):
    def __init__(self, code: str, language: str, parent: QWidget | None = None):
        super().__init__(parent)
        self.setObjectName("codeBlock")
        self.code = code

        name = QLabel(language or "code")
        name.setObjectName("help")
        self.copy = QPushButton("Copy")
        self.copy.setObjectName("small")
        self.copy.clicked.connect(self._copy)
        header = QHBoxLayout()
        header.setContentsMargins(4, 6, 6, 0)
        header.addWidget(name)
        header.addStretch()
        header.addWidget(self.copy)

        view = QPlainTextEdit(code)
        view.setObjectName("code")
        view.setFont(mono_font())
        view.setReadOnly(True)
        view.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        view.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        rows = code.split("\n")
        if len(rows) <= MAX_CODE_LINES:
            view.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        # Room for a horizontal scrollbar on code wide enough to need one, or
        # it would cover the last line.
        chrome = 12
        if max(map(len, rows)) > WIDE_CODE_CHARS:
            chrome += view.horizontalScrollBar().sizeHint().height()
        view.setFixedHeight(min(len(rows), MAX_CODE_LINES) * view.fontMetrics().lineSpacing() + chrome)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(6, 0, 0, 2)
        layout.setSpacing(0)
        layout.addLayout(header)
        layout.addWidget(view)

    def _copy(self) -> None:
        QGuiApplication.clipboard().setText(self.code)
        self.copy.setText("Copied")
        # Tied to the button: the chat can be cleared before this fires.
        QTimer.singleShot(1500, self.copy, lambda: self.copy.setText("Copy"))


class AssistantMessage(QWidget):
    def __init__(self, text: str, parent: QWidget | None = None):
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8)
        for kind, body, language in split_markdown(text):
            layout.addWidget(MarkdownView(body) if kind == "text" else CodeBlock(body, language))


class UserMessage(QWidget):
    def __init__(self, text: str, images: list[str], parent: QWidget | None = None):
        super().__init__(parent)
        bubble = QFrame()
        bubble.setObjectName("userBubble")
        bubble.setMaximumWidth(640)
        inner = QVBoxLayout(bubble)
        inner.setContentsMargins(16, 10, 16, 10)
        label = wrapped_label(text, "message", links=True)
        inner.addWidget(label)
        self.label = label
        for image in images:
            chip = QLabel(f"Attached: {Path(image).name}")
            chip.setObjectName("help")
            inner.addWidget(chip)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(40, 0, 0, 0)
        layout.addStretch()
        layout.addWidget(bubble)


class ToolRow(QWidget):
    """One tool call on one line. What it reported stays folded unless it failed."""

    def __init__(self, text: str, worker: str | None, parent: QWidget | None = None):
        super().__init__(parent)
        match = re.fullmatch(r"([\w.]+)\((.*)\)", text, re.DOTALL)
        name, args = match.groups() if match else (text, "")
        tag = f"[{worker}] " if worker else ""
        title = QLabel(
            f'<span style="color:{theme.MUTED}">{escape(tag)}</span><b>{escape(name)}</b> '
            f'<span style="color:{theme.MUTED}">{escape(args)}</span>'
        )
        title.setObjectName("tool")
        title.setTextFormat(Qt.TextFormat.RichText)
        title.setWordWrap(True)
        title.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)

        self.dot = QLabel("●")
        self.dot.setFixedWidth(14)
        self._set_dot(theme.MUTED)
        self.chevron = QPushButton("›")
        self.chevron.setObjectName("chevron")
        self.chevron.setFixedSize(16, 16)
        self.chevron.setToolTip("Show what it reported")
        self.chevron.clicked.connect(self.toggle)
        self.chevron.hide()

        row = QHBoxLayout()
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(4)
        row.addWidget(self.dot, 0, Qt.AlignmentFlag.AlignTop)
        row.addWidget(title, 1)
        row.addWidget(self.chevron, 0, Qt.AlignmentFlag.AlignTop)

        self.details = QWidget()
        self._details = QVBoxLayout(self.details)
        self._details.setContentsMargins(18, 2, 0, 0)
        self._details.setSpacing(1)
        self.details.hide()

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        layout.addLayout(row)
        layout.addWidget(self.details)

    def _set_dot(self, colour: str) -> None:
        self.dot.setStyleSheet(f"color: {colour}; font-size: 7pt;")

    def toggle(self) -> None:
        self.details.setVisible(self.details.isHidden())
        self.chevron.setText("⌄" if not self.details.isHidden() else "›")

    def add_detail(self, text: str, failed: bool) -> None:
        self._details.addWidget(wrapped_label(text, "detailBad" if failed else "detail", links=True))
        self._set_dot(theme.BAD if failed else theme.GOOD)
        self.chevron.show()
        if failed and self.details.isHidden():
            self.toggle()


class ConfirmCard(QFrame):
    """An approval the agent is waiting on, in the conversation it belongs to."""

    def __init__(self, label: str, detail: str, answer: Callable[[bool], None], parent: QWidget | None = None):
        super().__init__(parent)
        self.setObjectName("confirm")
        self.label_text = label
        self._answer = answer

        title = QLabel(label)
        title.setWordWrap(True)
        title.setStyleSheet("font-weight: 600;")

        body = QPlainTextEdit(detail)
        body.setObjectName("code")
        body.setFont(mono_font())
        body.setReadOnly(True)
        lines = min(detail.count("\n") + 1, 12)
        body.setFixedHeight(lines * body.fontMetrics().lineSpacing() + 14)

        self.allow = QPushButton("Allow")
        self.allow.setObjectName("primary")
        self.allow.clicked.connect(lambda: self._choose(True))
        self.deny = QPushButton("Deny")
        self.deny.clicked.connect(lambda: self._choose(False))
        self.buttons = QWidget()
        row = QHBoxLayout(self.buttons)
        row.setContentsMargins(0, 0, 0, 0)
        row.addStretch()
        row.addWidget(self.deny)
        row.addWidget(self.allow)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 10, 14, 10)
        layout.addWidget(title)
        layout.addWidget(body)
        layout.addWidget(self.buttons)
        self.body = body
        self.title = title

    def _choose(self, approve: bool) -> None:
        self._answer(approve)
        self.close_card("Allowed" if approve else "Denied")

    def close_card(self, outcome: str = "Closed") -> None:
        self.buttons.hide()
        self.body.hide()
        self.title.setText(f"{self.label_text} — {outcome}")
        self.title.setStyleSheet("font-weight: 400;")


class QuestionCard(QFrame):
    """Something the agent asked, with its choices and room for any other answer."""

    def __init__(self, question: str, options: list[str], answer: Callable[[str], None], parent: QWidget | None = None):
        super().__init__(parent)
        self.setObjectName("confirm")
        self.question_text = question
        self._answer = answer

        self.title = QLabel(question)
        self.title.setTextFormat(Qt.TextFormat.PlainText)
        self.title.setWordWrap(True)
        self.title.setStyleSheet("font-weight: 600;")

        self.body = QWidget()
        column = QVBoxLayout(self.body)
        column.setContentsMargins(0, 0, 0, 0)
        column.setSpacing(4)
        self.choices: list[QPushButton] = []
        for option in options:
            button = QPushButton(option)
            button.clicked.connect(lambda _=False, text=option: self._answer_with(text))
            self.choices.append(button)
            column.addWidget(button)

        self.field = QLineEdit()
        self.field.setPlaceholderText("Or type an answer" if options else "Type your answer")
        self.field.returnPressed.connect(self._send_field)
        send = QPushButton("Answer")
        send.setObjectName("primary")
        send.clicked.connect(self._send_field)
        row = QHBoxLayout()
        row.setContentsMargins(0, 0, 0, 0)
        row.addWidget(self.field, 1)
        row.addWidget(send)
        column.addLayout(row)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 10, 14, 10)
        layout.addWidget(self.title)
        layout.addWidget(self.body)

    def _send_field(self) -> None:
        text = self.field.text().strip()
        if text:
            self._answer_with(text)

    def _answer_with(self, text: str) -> None:
        self._answer(text)
        self.close_card(text)

    def close_card(self, answer: str) -> None:
        self.body.hide()
        self.title.setText(f"{self.question_text} — {answer or 'No answer'}")
        self.title.setStyleSheet("font-weight: 400;")


def centered(widget: QWidget) -> QHBoxLayout:
    """Holds the conversation to a readable width, however wide the window is."""
    widget.setMaximumWidth(CHAT_WIDTH)
    row = QHBoxLayout()
    row.setContentsMargins(24, 0, 24, 0)
    row.addStretch(1)
    row.addWidget(widget, 1000)
    row.addStretch(1)
    return row


def wrapped_label(text: str, name: str, links: bool = False) -> QLabel:
    """Selectable text. With `links`, web addresses in it can be clicked."""
    label = QLabel()
    label.setObjectName(name)
    label.setWordWrap(True)
    if links and URL.search(text):
        label.setTextFormat(Qt.TextFormat.RichText)
        label.setText(linkify(text))
        label.setTextInteractionFlags(Qt.TextInteractionFlag.TextBrowserInteraction)
        label.linkActivated.connect(open_link)
    else:
        label.setTextFormat(Qt.TextFormat.PlainText)
        label.setText(text)
        label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
    return label


class ChatView(QScrollArea):
    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.setWidgetResizable(True)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        column = QWidget()
        self._column = QVBoxLayout(column)
        self._column.setContentsMargins(0, 24, 0, 24)
        self._column.setSpacing(14)
        # A stretch factor, or short messages share the empty space with it.
        self._column.addStretch(1)
        self._content = QWidget()
        self._content.setLayout(centered(column))
        self.setWidget(self._content)

        self._last_tool: ToolRow | None = None
        self._confirms: dict[int, ConfirmCard] = {}
        self._questions: dict[int, QuestionCard] = {}
        # Follow new output, unless the user has scrolled up to read.
        self._follow = True
        bar = self.verticalScrollBar()
        bar.valueChanged.connect(self._on_scroll)
        bar.rangeChanged.connect(self._on_range)

    def _on_scroll(self, value: int) -> None:
        self._follow = value >= self.verticalScrollBar().maximum() - 40

    def _on_range(self, _low: int, high: int) -> None:
        if self._follow:
            self.verticalScrollBar().setValue(high)

    def _add(self, widget: QWidget) -> QWidget:
        self._column.insertWidget(self._column.count() - 1, widget)
        return widget

    def clear(self) -> None:
        self._last_tool = None
        self._confirms.clear()
        self._questions.clear()
        self._follow = True
        while self._column.count() > 1:
            widget = self._column.takeAt(0).widget()
            if widget:
                widget.deleteLater()

    def add_user(self, text: str, images: list[str] | None = None) -> None:
        self._last_tool = None
        self._follow = True
        self._add(UserMessage(text, images or []))

    def add_answer(self, text: str) -> None:
        self._last_tool = None
        self._add(AssistantMessage(text))

    def add_tool(self, text: str, worker: str | None = None) -> None:
        self._last_tool = ToolRow(text, worker)
        self._add(self._last_tool)

    def add_detail(self, text: str, failed: bool = False) -> None:
        if self._last_tool:
            self._last_tool.add_detail(text, failed)
        else:
            self.add_note(text, "bad" if failed else "")

    def add_note(self, text: str, level: str = "") -> None:
        name = {"warn": "noteWarn", "bad": "noteBad", "good": "noteGood"}.get(level, "note")
        self._last_tool = None
        self._add(wrapped_label(text, name, links=True))

    def add_confirm(self, confirm_id: int, label: str, detail: str, answer: Callable[[bool], None]) -> ConfirmCard:
        self._last_tool = None
        self._follow = True
        card = ConfirmCard(label, detail, answer)
        self._confirms[confirm_id] = card
        self._add(card)
        return card

    def close_confirm(self, confirm_id: int) -> None:
        card = self._confirms.pop(confirm_id, None)
        if card and card.buttons.isVisible():
            card.close_card("Denied (task stopped)")

    def add_question(self, question_id: int, question: str, options: list[str], answer: Callable[[str], None]) -> QuestionCard:
        self._last_tool = None
        self._follow = True
        card = QuestionCard(question, options, answer)
        self._questions[question_id] = card
        self._add(card)
        return card

    def close_question(self, question_id: int, answer: str) -> None:
        card = self._questions.pop(question_id, None)
        if card and card.body.isVisible():
            card.close_card(answer)


class ComposerEdit(QPlainTextEdit):
    submitted = Signal()
    imagePasted = Signal()

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.setObjectName("composer")
        self.setTabChangesFocus(True)
        self.document().contentsChanged.connect(self._fit)
        self._fit()

    def keyPressEvent(self, event) -> None:
        enter = event.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter)
        if enter and not event.modifiers() & Qt.KeyboardModifier.ShiftModifier:
            self.submitted.emit()
            return
        super().keyPressEvent(event)

    def canInsertFromMimeData(self, source) -> bool:
        return source.hasImage() or super().canInsertFromMimeData(source)

    def insertFromMimeData(self, source) -> None:
        if source.hasImage() and not source.hasText():
            self.imagePasted.emit()
        else:
            super().insertFromMimeData(source)

    def _fit(self) -> None:
        lines = self.document().size().height()
        self.setVerticalScrollBarPolicy(
            Qt.ScrollBarPolicy.ScrollBarAsNeeded if lines > MAX_COMPOSER_LINES else Qt.ScrollBarPolicy.ScrollBarAlwaysOff
        )
        shown = max(1, min(lines, MAX_COMPOSER_LINES))
        self.setFixedHeight(int(shown * self.fontMetrics().lineSpacing()) + 14)


class Composer(QFrame):
    """Where tasks are typed. While a task runs, sending steers it instead."""

    send = Signal(str)
    stop = Signal()
    pasteImage = Signal()

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.setObjectName("composerBox")
        self.setAcceptDrops(True)
        self.images: list[str] = []

        self.edit = ComposerEdit()
        self.edit.submitted.connect(self._submit)
        self.edit.imagePasted.connect(self.pasteImage)

        self._chips = QHBoxLayout()
        self._chips.setContentsMargins(0, 0, 0, 0)
        self._chips.addStretch()

        self.attach = self._round_button("+", "icon", "Attach an image. You can also paste one or drop it here.")
        self.attach.clicked.connect(self._choose_images)
        self.folder_button = QPushButton()
        self.folder_button.setObjectName("pill")
        self.folder_button.setToolTip("The folder this chat works in")
        self.folder_button.setAccessibleName("Project folder")
        self.plan_button = QPushButton("Plan mode")
        self.plan_button.setObjectName("pill")
        self.plan_button.setCheckable(True)
        self.plan_button.setToolTip("Read-only until you approve a plan")
        self.plan_button.setAccessibleName("Plan mode")
        self.gem_button = QPushButton()
        self.gem_button.setObjectName("pill")
        self.gem_button.setToolTip("A Gem the agent can consult for project knowledge")
        self.gem_button.setAccessibleName("Gem")
        self.model_button = QPushButton()
        self.model_button.setObjectName("pill")
        self.model_button.setToolTip("Model and thinking level")
        self.model_button.setAccessibleName("Model")
        self.stop_button = self._round_button("■", "stop", "Stop before the next turn")
        self.stop_button.clicked.connect(self.stop)
        self.stop_button.hide()
        self.send_button = self._round_button("↑", "send", "Send")
        self.send_button.clicked.connect(self._submit)

        row = QHBoxLayout()
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(4)
        row.addWidget(self.attach)
        row.addWidget(self.folder_button)
        row.addWidget(self.plan_button)
        row.addStretch()
        row.addWidget(self.gem_button)
        row.addWidget(self.model_button)
        row.addSpacing(4)
        row.addWidget(self.stop_button)
        row.addWidget(self.send_button)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 12, 10, 10)
        layout.setSpacing(6)
        layout.addLayout(self._chips)
        layout.addWidget(self.edit)
        layout.addLayout(row)
        self.set_mode("offline")

    @staticmethod
    def _round_button(glyph: str, name: str, tip: str) -> QPushButton:
        button = QPushButton(glyph)
        button.setObjectName(name)
        button.setFixedSize(30, 30)
        button.setToolTip(tip)
        button.setAccessibleName(tip)
        return button

    def set_mode(self, mode: str) -> None:
        """"idle" sends tasks, "busy" steers, anything else is disabled."""
        live = mode in ("idle", "busy")
        self.edit.setEnabled(live)
        self.send_button.setEnabled(live)
        self.attach.setEnabled(live)
        # The tab belongs to a running task, so its menus do too.
        self.model_button.setEnabled(mode == "idle")
        self.gem_button.setEnabled(mode == "idle")
        self.plan_button.setEnabled(mode == "idle")
        # Open before the agent has started too: choosing a folder is how it starts.
        self.folder_button.setEnabled(mode != "busy")
        self.stop_button.setVisible(mode == "busy")
        self.send_button.setToolTip("Steer the running task" if mode == "busy" else "Send")
        self.edit.setPlaceholderText(
            {
                "idle": "Ask anything, or describe a task. /help lists commands.",
                "busy": "Steer the running task. It's folded into the next turn.",
            }.get(mode, "The agent isn't ready yet.")
        )

    def add_image(self, path: str) -> None:
        if path in self.images:
            return
        self.images.append(path)
        chip = QPushButton(f"{Path(path).name}  ×")
        chip.setObjectName("chip")
        chip.setToolTip("Remove this attachment")
        chip.clicked.connect(lambda: self._remove_image(path, chip))
        self._chips.insertWidget(self._chips.count() - 1, chip)

    def _remove_image(self, path: str, chip: QPushButton) -> None:
        self.images.remove(path)
        chip.deleteLater()

    def take_images(self) -> list[str]:
        images, self.images = self.images, []
        while self._chips.count() > 1:
            widget = self._chips.takeAt(0).widget()
            if widget:
                widget.deleteLater()
        return images

    def _choose_images(self) -> None:
        files, _ = QFileDialog.getOpenFileNames(
            self, "Attach images", "", "Images (*.png *.jpg *.jpeg *.gif *.webp *.bmp);;All files (*)"
        )
        for file in files:
            self.add_image(file)

    def _submit(self) -> None:
        text = self.edit.toPlainText().strip()
        if text and self.send_button.isEnabled():
            self.edit.clear()
            self.send.emit(text)

    def dragEnterEvent(self, event) -> None:
        if event.mimeData().hasUrls():
            event.acceptProposedAction()

    def dropEvent(self, event) -> None:
        for url in event.mimeData().urls():
            path = url.toLocalFile()
            if Path(path).suffix.lower() in IMAGE_SUFFIXES:
                self.add_image(path)

    def sizeHint(self) -> QSize:
        return QSize(600, super().sizeHint().height())


class ChatPage(QWidget):
    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.setObjectName("page")
        self.view = ChatView()
        self.status = QLabel("")
        self.status.setObjectName("note")
        self.composer = Composer()

        footer = QWidget()
        stack = QVBoxLayout(footer)
        stack.setContentsMargins(0, 0, 0, 16)
        stack.setSpacing(6)
        stack.addWidget(self.status)
        stack.addWidget(self.composer)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        layout.addWidget(self.view, 1)
        layout.addLayout(centered(footer))
