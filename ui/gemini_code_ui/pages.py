"""Everything beside the chat: settings, API server, plan, memory and logs."""
from __future__ import annotations

import json
from html import escape
from pathlib import Path

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QGuiApplication
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPlainTextEdit,
    QPushButton,
    QScrollArea,
    QSpinBox,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
)

from . import theme
from .chat import open_link
from .settings import API, BROWSER, GENERAL, LIMITS, SETTINGS, TIMEOUTS, WORKERS, Setting, Settings

MAX_LOG_LINES = 5000


def page_layout(page: QWidget, title: str) -> QVBoxLayout:
    page.setObjectName("page")
    layout = QVBoxLayout(page)
    layout.setContentsMargins(24, 20, 24, 16)
    layout.setSpacing(10)
    heading = QLabel(title)
    heading.setObjectName("heading")
    layout.addWidget(heading)
    return layout


class FieldEditor(QWidget):
    """The right input for one Setting."""

    def __init__(self, setting: Setting, parent: QWidget | None = None):
        super().__init__(parent)
        self.setting = setting
        row = QHBoxLayout(self)
        row.setContentsMargins(0, 0, 0, 0)

        if setting.kind == "choice":
            self.input = QComboBox()
            for value, label in setting.choices:
                self.input.addItem(label, value)
        elif setting.kind == "bool":
            self.input = QCheckBox()
        elif setting.kind == "int":
            self.input = QSpinBox()
            self.input.setRange(setting.minimum, setting.maximum)
            self.input.setGroupSeparatorShown(True)
        else:
            self.input = QLineEdit()
            if setting.kind == "secret":
                self.input.setEchoMode(QLineEdit.EchoMode.Password)
        self.input.setAccessibleName(setting.label)
        row.addWidget(self.input, 1)

        if setting.kind == "path":
            browse = QPushButton("Browse")
            browse.clicked.connect(self._browse)
            row.addWidget(browse)

    def value(self):
        match self.setting.kind:
            case "choice":
                return self.input.currentData()
            case "bool":
                return self.input.isChecked()
            case "int":
                return self.input.value()
            case _:
                return self.input.text().strip()

    def set_value(self, value) -> None:
        match self.setting.kind:
            case "choice":
                self.input.setCurrentIndex(max(0, self.input.findData(value)))
            case "bool":
                self.input.setChecked(bool(value))
            case "int":
                self.input.setValue(int(value))
            case _:
                self.input.setText(str(value))

    def _browse(self) -> None:
        if self.setting.key == "chrome":
            path, _ = QFileDialog.getOpenFileName(self, self.setting.label)
        else:
            path = QFileDialog.getExistingDirectory(self, self.setting.label, self.value())
        if path:
            self.set_value(path)


class SettingsForm(QWidget):
    """A form for the settings in `groups`, generated from the SETTINGS table."""

    def __init__(self, settings: Settings, groups: tuple[str, ...], parent: QWidget | None = None):
        super().__init__(parent)
        self.settings = settings
        self.editors: dict[str, FieldEditor] = {}
        column = QVBoxLayout(self)
        column.setContentsMargins(0, 0, 8, 0)
        column.setSpacing(10)

        for group in groups:
            box = QGroupBox(group)
            form = QFormLayout(box)
            form.setLabelAlignment(Qt.AlignmentFlag.AlignLeft)
            form.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.ExpandingFieldsGrow)
            form.setVerticalSpacing(8)
            for setting in (s for s in SETTINGS if s.group == group):
                editor = FieldEditor(setting)
                self.editors[setting.key] = editor
                field = QVBoxLayout()
                field.setSpacing(2)
                field.addWidget(editor)
                if setting.help:
                    help_text = QLabel(setting.help)
                    help_text.setObjectName("help")
                    help_text.setWordWrap(True)
                    field.addWidget(help_text)
                form.addRow(setting.label, field)
            column.addWidget(box)
        column.addStretch()
        self.reload()

    def reload(self) -> None:
        for key, editor in self.editors.items():
            editor.set_value(self.settings[key])

    def store(self) -> None:
        for key, editor in self.editors.items():
            self.settings[key] = editor.value()

    def reset(self) -> None:
        for editor in self.editors.values():
            if editor.setting.key != "project":
                editor.set_value(editor.setting.default)


class SettingsPage(QWidget):
    applied = Signal()

    def __init__(self, settings: Settings, parent: QWidget | None = None):
        super().__init__(parent)
        layout = page_layout(self, "Settings")
        self.form = SettingsForm(settings, (GENERAL, LIMITS, WORKERS, TIMEOUTS, BROWSER))
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(self.form)
        layout.addWidget(scroll, 1)

        self.save = QPushButton("Save and restart agent")
        self.save.setObjectName("primary")
        self.save.clicked.connect(self._apply)
        reset = QPushButton("Reset to defaults")
        reset.clicked.connect(self.form.reset)
        note = QLabel("Restarting starts a new Gemini thread.")
        note.setObjectName("help")
        row = QHBoxLayout()
        row.addWidget(note)
        row.addStretch()
        row.addWidget(reset)
        row.addWidget(self.save)
        layout.addLayout(row)

    def _apply(self) -> None:
        self.form.store()
        self.form.settings.save()
        self.applied.emit()


class ApiPage(QWidget):
    """Runs `gemini-code serve`, for other programs to use the signed-in session."""

    toggled = Signal()

    def __init__(self, settings: Settings, parent: QWidget | None = None):
        super().__init__(parent)
        self.settings = settings
        layout = page_layout(self, "API server")
        intro = QLabel("An OpenAI-compatible API on your signed-in Gemini session, for your own scripts and tools.")
        intro.setObjectName("muted")
        intro.setWordWrap(True)
        layout.addWidget(intro)

        self.form = SettingsForm(settings, (API,))
        layout.addWidget(self.form)

        self.status = QLabel("Stopped")
        self.status.setObjectName("muted")
        self.status.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.copy = QPushButton("Copy base URL")
        self.copy.clicked.connect(lambda: QGuiApplication.clipboard().setText(self.base_url()))
        self.toggle = QPushButton("Start server")
        self.toggle.setObjectName("primary")
        self.toggle.clicked.connect(self.toggled)
        row = QHBoxLayout()
        row.addWidget(self.status)
        row.addStretch()
        row.addWidget(self.copy)
        row.addWidget(self.toggle)
        layout.addLayout(row)

        self.log = QPlainTextEdit()
        self.log.setObjectName("log")
        self.log.setReadOnly(True)
        self.log.setMaximumBlockCount(MAX_LOG_LINES)
        layout.addWidget(self.log, 1)

    def base_url(self) -> str:
        return f"http://{self.settings['api_host']}:{self.settings['api_port']}/v1"

    def set_running(self, running: bool) -> None:
        self.status.setText(f"Running at {self.base_url()}" if running else "Stopped")
        self.toggle.setText("Stop server" if running else "Start server")
        self.toggle.setObjectName("danger" if running else "primary")
        self.toggle.style().unpolish(self.toggle)
        self.toggle.style().polish(self.toggle)
        for editor in self.form.editors.values():
            editor.setEnabled(not running)


class DocumentPage(QWidget):
    """A project file shown as rendered markdown: the plan, or the memory."""

    refresh = Signal()

    def __init__(self, title: str, intro: str, empty: str, parent: QWidget | None = None):
        super().__init__(parent)
        self._empty = empty
        layout = page_layout(self, title)
        blurb = QLabel(intro)
        blurb.setObjectName("muted")
        blurb.setWordWrap(True)
        layout.addWidget(blurb)

        self.view = QTextBrowser()
        self.view.setObjectName("document")
        self.view.setOpenLinks(False)
        self.view.anchorClicked.connect(open_link)
        layout.addWidget(self.view, 1)

        self.actions = QHBoxLayout()
        self.actions.addStretch()
        reload_button = QPushButton("Refresh")
        reload_button.clicked.connect(self.refresh)
        self.actions.addWidget(reload_button)
        layout.addLayout(self.actions)

    def show_text(self, text: str | None) -> None:
        self.view.setMarkdown(text or self._empty)


class MemoryPage(DocumentPage):
    remember = Signal(str)

    def __init__(self, parent: QWidget | None = None):
        super().__init__(
            "Project memory",
            "GEMINI.md is replayed at the start of every session. The agent adds to it too.",
            "Nothing remembered yet.",
            parent,
        )
        self.note = QLineEdit()
        self.note.setPlaceholderText("Add a note, e.g. this project uses pnpm")
        self.note.returnPressed.connect(self._add)
        add = QPushButton("Remember")
        add.clicked.connect(self._add)
        self.actions.insertWidget(0, self.note, 1)
        self.actions.insertWidget(1, add)
        self.actions.takeAt(2)  # the note takes the room the stretch had

    def _add(self) -> None:
        text = self.note.text().strip()
        if text:
            self.note.clear()
            self.remember.emit(text)


class PlanPage(DocumentPage):
    clear = Signal()

    def __init__(self, parent: QWidget | None = None):
        super().__init__(
            "Plan",
            "GEMINI-PLAN.md is the journal of the current task. An unfinished plan continues in the next task.",
            "No plan yet. It's written as tasks run.",
            parent,
        )
        clear = QPushButton("Delete plan")
        clear.setObjectName("danger")
        clear.clicked.connect(self.clear)
        self.actions.insertWidget(1, clear)


class SkillsPage(QWidget):
    """Claude-compatible skills: what's here, and installing more from GitHub."""

    find = Signal(str)
    install = Signal(str, list)
    remove = Signal(str)

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.source = ""
        self.choices: dict[str, QCheckBox] = {}
        layout = page_layout(self, "Skills")
        intro = QLabel(
            "Instructions for particular kinds of task, in the same SKILL.md format as Claude Code. Gemini sees each "
            "one's name and description, and loads the rest when it's useful."
        )
        intro.setObjectName("muted")
        intro.setWordWrap(True)
        layout.addWidget(intro)

        self.field = QLineEdit()
        self.field.setPlaceholderText("A GitHub repository: owner/repo, or paste its URL")
        self.field.setAccessibleName("GitHub repository")
        self.field.returnPressed.connect(self._find)
        self.find_button = QPushButton("Find skills")
        self.find_button.setObjectName("primary")
        self.find_button.clicked.connect(self._find)
        row = QHBoxLayout()
        row.addWidget(self.field, 1)
        row.addWidget(self.find_button)
        layout.addLayout(row)

        self.message = QLabel("")
        self.message.setObjectName("help")
        self.message.setWordWrap(True)
        layout.addWidget(self.message)

        self._content = QWidget()
        self._list = QVBoxLayout(self._content)
        self._list.setContentsMargins(0, 0, 8, 0)
        self._list.setSpacing(6)
        self._results = QVBoxLayout()
        self._results.setSpacing(4)
        self.install_button = QPushButton("Install selected")
        self.install_button.setObjectName("primary")
        self.install_button.clicked.connect(self._install)
        self.install_button.hide()
        self._list.addLayout(self._results)
        self._list.addWidget(self.install_button, 0, Qt.AlignmentFlag.AlignRight)
        self._installed = QVBoxLayout()
        self._installed.setSpacing(6)
        self._list.addLayout(self._installed)
        self._list.addStretch()

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(self._content)
        layout.addWidget(scroll, 1)

    @staticmethod
    def _clear(layout: QVBoxLayout) -> None:
        # Recursive: a row is a layout holding a layout, and anything missed
        # stays on screen under the new rows.
        while layout.count():
            item = layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
            elif item.layout():
                SkillsPage._clear(item.layout())

    def _find(self) -> None:
        source = self.field.text().strip()
        if source:
            self.source = source
            self.say("Looking on GitHub…")
            self.find_button.setEnabled(False)
            self.find.emit(source)

    def say(self, text: str) -> None:
        self.message.setText(text)

    def show_found(self, found: list[dict] | None, error: str = "") -> None:
        self.find_button.setEnabled(True)
        self.choices = {}
        self._clear(self._results)
        self.install_button.hide()
        if error:
            self.say(error)
            return
        if not found:
            self.say("No skills there. A skill is a folder with a SKILL.md.")
            return
        self.say(f"{len(found)} skill{'' if len(found) == 1 else 's'} found. Choose what to install.")
        for skill in found:
            box = QCheckBox(skill["name"])
            box.setChecked(len(found) == 1)
            scripts = len(skill.get("scripts") or [])
            detail = skill.get("description", "")
            if scripts:
                # Worth seeing before installing: these are programs the agent may run.
                detail += f" Includes {scripts} script{'' if scripts == 1 else 's'} it may ask to run."
            note = QLabel(detail)
            note.setObjectName("help")
            note.setWordWrap(True)
            note.setContentsMargins(23, 0, 0, 4)
            self.choices[skill["name"]] = box
            self._results.addWidget(box)
            self._results.addWidget(note)
        self.install_button.show()

    def _install(self) -> None:
        names = [name for name, box in self.choices.items() if box.isChecked()]
        if names:
            self.say("Installing…")
            self.install_button.setEnabled(False)
            self.install.emit(self.source, names)

    def installed(self, names: list[str] | None, error: str = "") -> None:
        self.install_button.setEnabled(True)
        if error:
            self.say(error)
            return
        self._clear(self._results)
        self.install_button.hide()
        self.choices = {}
        self.field.clear()
        self.say(f"Installed {', '.join(names or [])}. Gemini lists new skills from the next new chat.")

    def show_skills(self, data: dict) -> None:
        self._clear(self._installed)
        skills = data.get("installed") or []
        others = data.get("others") or []
        if not skills and not others:
            empty = QLabel("No skills yet.")
            empty.setObjectName("muted")
            self._installed.addWidget(empty)
            return
        for skill in skills:
            self._add_row(skill, skill.get("source") or "installed", removable=True)
        for skill in others:
            self._add_row(skill, {"project": "this project", "claude": "~/.claude/skills"}.get(skill.get("source"), ""), removable=False)

    def _add_row(self, skill: dict, origin: str, removable: bool) -> None:
        name = QLabel(f"<b>{escape(skill['name'])}</b> <span style='color:{theme.MUTED}'>{escape(origin)}</span>")
        name.setTextFormat(Qt.TextFormat.RichText)
        description = QLabel(skill.get("description", ""))
        description.setObjectName("help")
        description.setWordWrap(True)
        text = QVBoxLayout()
        text.setSpacing(0)
        text.addWidget(name)
        text.addWidget(description)
        row = QHBoxLayout()
        row.addLayout(text, 1)
        if removable:
            remove = QPushButton("Remove")
            remove.setObjectName("small")
            remove.clicked.connect(lambda: self.remove.emit(skill["name"]))
            row.addWidget(remove, 0, Qt.AlignmentFlag.AlignTop)
        self._installed.addLayout(row)


MCP_STATES = {
    "connected": ("Connected", theme.GOOD),
    "failed": ("Failed", theme.BAD),
    "declined": ("Not approved", theme.WARN),
    "disconnected": ("Disconnected", theme.BAD),
}


class McpPage(QWidget):
    """The project's MCP servers: how each one is doing, and the file that lists them."""

    saved = Signal()

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.project = ""
        layout = page_layout(self, "MCP servers")
        intro = QLabel(
            "Tools from other programs. Gemini loads them on demand like any other tool, and each call asks first. "
            "Servers in a project's .mcp.json need your approval before they start. Yours for every project go in "
            "~/.gemini-code/mcp.json."
        )
        intro.setObjectName("muted")
        intro.setWordWrap(True)
        layout.addWidget(intro)

        self.status = QLabel("No servers yet.")
        self.status.setObjectName("muted")
        self.status.setTextFormat(Qt.TextFormat.RichText)
        self.status.setWordWrap(True)
        layout.addWidget(self.status)

        self.editor = QPlainTextEdit()
        self.editor.setObjectName("log")
        self.editor.setAccessibleName(".mcp.json")
        self.editor.setPlaceholderText(
            '{\n  "mcpServers": {\n    "files": {\n      "command": "npx",\n'
            '      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]\n    }\n  }\n}'
        )
        layout.addWidget(self.editor, 1)

        self.message = QLabel("")
        self.message.setObjectName("noteBad")
        self.message.setWordWrap(True)
        self.save = QPushButton("Save and restart agent")
        self.save.setObjectName("primary")
        self.save.clicked.connect(self._save)
        row = QHBoxLayout()
        row.addWidget(self.message, 1)
        row.addWidget(self.save)
        layout.addLayout(row)

    def _file(self) -> Path | None:
        return Path(self.project) / ".mcp.json" if self.project else None

    def load(self, project: str) -> None:
        self.project = project
        file = self._file()
        self.editor.setPlainText(file.read_text(encoding="utf-8-sig") if file and file.exists() else "")
        self.message.setText("")

    def show_servers(self, servers: list[dict]) -> None:
        if not servers:
            self.status.setText("No servers yet.")
            return
        lines = []
        for server in servers:
            label, colour = MCP_STATES.get(server.get("state"), ("Unknown", theme.MUTED))
            count = len(server.get("tools") or [])
            # A server's own error text, so it's escaped like anything else it says.
            error = f" — {escape(str(server['error']))}" if server.get("error") else ""
            lines.append(
                f'<span style="color:{colour}">●</span> <b>{escape(server.get("name", ""))}</b> '
                f"{label}, {count} tool{'' if count == 1 else 's'}{error}"
            )
        self.status.setText("<br>".join(lines))

    def _save(self) -> None:
        file = self._file()
        if not file:
            self.message.setText("Choose a project folder first.")
            return
        text = self.editor.toPlainText().strip()
        try:
            servers = json.loads(text or "{}").get("mcpServers", {})
            if not isinstance(servers, dict):
                raise ValueError('"mcpServers" must be an object')
        except (ValueError, AttributeError) as err:
            self.message.setText(f"That isn't valid: {err}")
            return
        # Empty means no servers: don't leave an empty file in the project.
        if text:
            file.write_text(text + "\n", encoding="utf-8")
        elif file.exists():
            file.unlink()
        self.message.setText("")
        self.saved.emit()


class LogsPage(QWidget):
    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        layout = page_layout(self, "Logs")
        self.view = QPlainTextEdit()
        self.view.setObjectName("log")
        self.view.setReadOnly(True)
        self.view.setMaximumBlockCount(MAX_LOG_LINES)
        layout.addWidget(self.view, 1)
        clear = QPushButton("Clear")
        clear.clicked.connect(self.view.clear)
        row = QHBoxLayout()
        row.addStretch()
        row.addWidget(clear)
        layout.addLayout(row)

    def append(self, text: str) -> None:
        self.view.appendPlainText(text)
