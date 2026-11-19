"""The main window: wires the agent's events to the pages."""
from __future__ import annotations

import os
import time
from pathlib import Path

from PySide6.QtCore import QEvent, QProcess, Qt, QTimer
from PySide6.QtGui import QAction
from PySide6.QtWidgets import (
    QApplication,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QMainWindow,
    QMenu,
    QMessageBox,
    QPushButton,
    QStackedWidget,
    QVBoxLayout,
    QWidget,
)

from . import theme
from .agent import AgentProcess, ApiServerProcess, node_command, process_environment
from .chat import ChatPage
from .frame import FrameWidget, TitleBar
from .pages import ApiPage, LogsPage, McpPage, MemoryPage, PlanPage, SettingsPage, SkillsPage
from .picker import ModelPopup, picker_label
from .settings import Settings

HELP = """Commands:
/clear or /new — start a fresh Gemini thread
/model <name> — switch to a model Gemini lists for you
/thinking low|medium|high — thinking level
/undo — revert the file changes from the last task
/plan — open the plan
/memory — open the project memory
/skills — open skills, to see them or install more
/remember <note> — add to the project memory
/gems — refresh the list of Gems
/gem <name> or /gem off — consult a Gem, or stop
/help — this message"""

# A task that used no tools gets nudged once, and the reply to that nudge is
# usually a line saying the answer stands. Beyond this length it's a real reply.
MAX_NUDGE_ACK_CHARS = 200

THINKING_WORDS = {"on": "High", "off": "Low"}
MAX_RECENT_FOLDERS = 8

STATE_LABELS = {
    "offline": ("Not started", theme.MUTED),
    "starting": ("Starting…", theme.WARN),
    "ready": ("Ready", theme.GOOD),
    "busy": ("Working…", theme.ACCENT),
    "failed": ("Stopped", theme.BAD),
}


class MainWindow(QMainWindow):
    def __init__(self, settings: Settings, backend: list[str] | None = None):
        super().__init__()
        self.settings = settings
        self.state = "offline"
        self.task_started = 0.0
        self.interim_only = False  # an interim reply, and no tool since
        self.menu: dict | None = None  # the model list, as Gemini last gave it
        self.gems: list[str] | None = None

        self.setWindowTitle("gemini-code")
        self.resize(1180, 780)
        self.setMinimumSize(760, 520)

        self.agent = AgentProcess(backend, self)
        self.agent.event.connect(self.on_event)
        self.agent.log.connect(self.log)
        self.api = ApiServerProcess(self)

        self._build()
        self.api.output.connect(self.api_page.log.appendPlainText)
        self.api.runningChanged.connect(self.api_page.set_running)

        self.ticker = QTimer(self)
        self.ticker.setInterval(1000)
        self.ticker.timeout.connect(self._tick)

        self._load_controls()
        self._set_state("offline")
        # After the event loop starts, so the window is up first.
        QTimer.singleShot(0, self.start_agent)

    # --- layout ---------------------------------------------------------
    def _build(self) -> None:
        self.chat = ChatPage()
        self.plan_page = PlanPage()
        self.memory_page = MemoryPage()
        self.skills_page = SkillsPage()
        self.settings_page = SettingsPage(self.settings)
        self.mcp_page = McpPage()
        self.api_page = ApiPage(self.settings)
        self.logs_page = LogsPage()

        self.pages = QStackedWidget()
        pages = [
            ("Chat", self.chat),
            ("Plan", self.plan_page),
            ("Memory", self.memory_page),
            ("Skills", self.skills_page),
            ("Settings", self.settings_page),
            ("MCP servers", self.mcp_page),
            ("API server", self.api_page),
            ("Logs", self.logs_page),
        ]
        self.nav = QListWidget()
        self.nav.setObjectName("nav")
        self.nav.setFixedHeight(len(pages) * 33 + 4)
        for name, page in pages:
            self.nav.addItem(name)
            self.pages.addWidget(page)
        self.nav.currentRowChanged.connect(self._show_page)

        # Borderless: the window draws its own frame, title bar and edges.
        self.setWindowFlag(Qt.WindowType.FramelessWindowHint)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.frame = FrameWidget()
        self.title_bar = TitleBar(self)
        body = QHBoxLayout()
        body.setContentsMargins(8, 0, 0, 8)
        body.setSpacing(0)
        body.addWidget(self._build_sidebar())
        body.addWidget(self.pages, 1)
        self.frame.column.addWidget(self.title_bar)
        self.frame.column.addLayout(body, 1)
        self.setCentralWidget(self.frame)
        self.nav.setCurrentRow(0)

        composer = self.chat.composer
        composer.send.connect(self.submit)
        composer.stop.connect(self.stop_task)
        composer.pasteImage.connect(self.paste_image)

        self.model_popup = ModelPopup(self)
        self.model_popup.modelChosen.connect(self.choose_model)
        self.model_popup.thinkingChosen.connect(self.choose_thinking)
        composer.model_button.clicked.connect(self.open_model_picker)
        composer.plan_button.clicked.connect(self.toggle_plan_mode)

        self.gem_menu = QMenu(self)
        composer.gem_button.setMenu(self.gem_menu)
        self.gem_menu.aboutToShow.connect(self._fill_gem_menu)

        self.folder_menu = QMenu(self)
        self.folder_menu.setToolTipsVisible(True)
        composer.folder_button.setMenu(self.folder_menu)
        self.folder_menu.aboutToShow.connect(self._fill_folder_menu)

        self.plan_page.refresh.connect(self.refresh_plan)
        self.plan_page.clear.connect(self.clear_plan)
        self.memory_page.refresh.connect(self.refresh_memory)
        self.memory_page.remember.connect(self.remember)
        self.skills_page.find.connect(self.find_skills)
        self.skills_page.install.connect(self.install_skills)
        self.skills_page.remove.connect(self.remove_skill)
        self.settings_page.applied.connect(self.apply_settings)
        self.mcp_page.saved.connect(self.apply_settings)
        self.api_page.toggled.connect(self.toggle_api)

    def _build_sidebar(self) -> QWidget:
        side = QWidget()
        side.setObjectName("sidebar")
        side.setFixedWidth(220)
        column = QVBoxLayout(side)
        column.setContentsMargins(10, 12, 10, 10)
        column.setSpacing(4)

        self.new_chat_button = QPushButton("+   New chat")
        self.new_chat_button.setObjectName("newChat")
        self.new_chat_button.clicked.connect(self.new_chat)
        column.addWidget(self.new_chat_button)
        column.addSpacing(6)
        column.addWidget(self.nav)
        column.addStretch()

        self.state_label = QLabel()
        self.state_label.setObjectName("help")
        self.state_label.setContentsMargins(10, 0, 0, 2)
        column.addWidget(self.state_label)

        self.project_button = QPushButton()
        self.project_button.setObjectName("ghost")
        self.project_button.setToolTip("Change the project folder")
        self.project_button.clicked.connect(self.choose_project)
        self.more_button = QPushButton("···")
        self.more_button.setObjectName("pill")
        self.more_button.setFixedWidth(32)
        self.more_button.setToolTip("More actions")
        self.more_button.setAccessibleName("More actions")
        more = QMenu(self)
        self.undo_action = QAction("Undo last task", self)
        self.undo_action.triggered.connect(self.undo)
        self.chrome_action = QAction("Open Chrome to sign in", self)
        self.chrome_action.triggered.connect(self.open_chrome)
        self.restart_action = QAction("Restart agent", self)
        self.restart_action.triggered.connect(self.restart_agent)
        more.addActions([self.undo_action, self.chrome_action, self.restart_action])
        self.more_button.setMenu(more)

        footer = QHBoxLayout()
        footer.setSpacing(2)
        footer.addWidget(self.project_button, 1)
        footer.addWidget(self.more_button)
        column.addLayout(footer)
        return side

    def _load_controls(self) -> None:
        project = self.settings["project"]
        self.project_button.setText(Path(project).name if project else "Choose a folder…")
        self.chat.composer.folder_button.setText(f"{Path(project).name if project else 'Choose a folder'}  ▾")
        self.chat.composer.folder_button.setToolTip(project or "Choose the folder this chat works in")
        self._show_gem()
        self._show_menu()

    def _show_gem(self) -> None:
        gem = self.settings["gem"]
        self.chat.composer.gem_button.setText(f"{gem or 'No Gem'}  ▾")

    def _show_menu(self) -> None:
        label = picker_label(self.menu)
        self.chat.composer.model_button.setText(f"{label}  ▾")
        if self.model_popup.isVisible():
            self.model_popup.set_menu(self.menu)

    def _show_page(self, row: int) -> None:
        self.pages.setCurrentIndex(row)
        page = self.pages.widget(row)
        if page is self.plan_page:
            self.refresh_plan()
        elif page is self.memory_page:
            self.refresh_memory()
        elif page is self.settings_page:
            self.settings_page.form.reload()
        elif page is self.skills_page:
            self.refresh_skills()
        elif page is self.mcp_page:
            self.mcp_page.load(self.settings["project"])
            self.agent.command("mcp", self._on_mcp_reply)

    # --- state ----------------------------------------------------------
    def _set_state(self, state: str) -> None:
        self.state = state
        text, colour = STATE_LABELS[state]
        self.state_label.setText(f'<span style="color:{colour}">●</span> {text}')

        ready = state == "ready"
        self.new_chat_button.setEnabled(ready)
        self.undo_action.setEnabled(ready)
        self.chat.composer.set_mode({"ready": "idle", "busy": "busy"}.get(state, "offline"))
        if not ready:
            self.model_popup.hide()

        if state == "busy":
            self.task_started = time.monotonic()
            self.ticker.start()
            self._tick()
        else:
            self.ticker.stop()
            self.chat.status.setText("")

    def _tick(self) -> None:
        elapsed = int(time.monotonic() - self.task_started)
        self.chat.status.setText(f"Working… {elapsed}s")

    def log(self, text: str) -> None:
        self.logs_page.append(text)

    # --- agent lifecycle ------------------------------------------------
    def start_agent(self) -> None:
        project = self.settings["project"]
        if not project:
            self.chat.view.add_note("Choose a project folder to start. The agent works on the files in that folder.")
            return
        if not Path(project).is_dir():
            self.chat.view.add_note(f"The project folder no longer exists: {project}", "bad")
            return
        self.chat.view.add_note(f"Starting the agent in {project}")
        self._set_state("starting")
        self.agent.start(project, self.settings.env())

    def restart_agent(self) -> None:
        if not self.agent.running():
            self.chat.view.clear()
            self.start_agent()
            return
        if self.state == "busy" and not self._ask("Stop the running task and restart the agent?"):
            return
        self._set_state("offline")
        self.chat.view.add_note("Restarting the agent…")
        self.agent.stop(self._restarted)

    def _restarted(self) -> None:
        self.chat.view.clear()
        self.start_agent()

    def apply_settings(self) -> None:
        self._load_controls()
        self.nav.setCurrentRow(0)
        self.restart_agent()

    def choose_project(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "Choose a project folder", self.settings["project"])
        if folder:
            self.set_project(folder)

    def recent_folders(self) -> list[str]:
        """Recent folders that still exist, the current one included and first."""
        current = self.settings["project"]
        folders = ([current] if current else []) + list(self.settings["recent_projects"] or [])
        seen: set[str] = set()
        recent = []
        for folder in folders:
            key = os.path.normcase(os.path.normpath(folder))
            if key not in seen and Path(folder).is_dir():
                seen.add(key)
                recent.append(folder)
        return recent[:MAX_RECENT_FOLDERS]

    def _fill_folder_menu(self) -> None:
        menu = self.folder_menu
        menu.clear()
        folders = self.recent_folders()
        names = [Path(folder).name for folder in folders]
        current = self.settings["project"]
        for folder, name in zip(folders, names):
            # Two folders of the same name are told apart by where they are.
            label = f"{name} ({Path(folder).parent.name})" if names.count(name) > 1 else name
            mark = "✓  " if folder == current else "     "
            action = menu.addAction(mark + label)
            action.setToolTip(folder)
            action.triggered.connect(lambda _=False, chosen=folder: self.set_project(chosen))
        if folders:
            menu.addSeparator()
        menu.addAction("Choose another folder…").triggered.connect(self.choose_project)

    def set_project(self, folder: str) -> None:
        """A chat works in one folder, so another folder means a new chat there."""
        if os.path.normcase(os.path.normpath(folder)) == os.path.normcase(os.path.normpath(self.settings["project"] or "")):
            return
        if self.state == "busy" and not self._ask("Stop the running task and start a new chat in another folder?"):
            return
        # Read before switching, or the folder being left drops out of the list.
        self.settings["recent_projects"] = self.recent_folders()
        self.settings["project"] = folder
        self.settings["recent_projects"] = self.recent_folders()
        self.settings.save()
        self.settings_page.form.reload()
        self._load_controls()
        self.restart_agent()

    def open_chrome(self) -> None:
        project = self.settings["project"] or str(Path.home())
        try:
            program, *args = node_command("open-chrome")
        except RuntimeError as err:
            self.chat.view.add_note(str(err), "bad")
            return
        process = QProcess(self)
        process.setProgram(program)
        process.setArguments(args)
        process.setWorkingDirectory(project)
        process.setProcessEnvironment(process_environment(self.settings.env()))
        process.startDetached()

    def toggle_api(self) -> None:
        if self.api.running():
            self.api.stop()
            return
        project = self.settings["project"]
        if not project:
            self.api_page.log.appendPlainText("Choose a project folder first.")
            return
        self.api_page.form.store()
        self.settings.save()
        self.api.start(project, self.settings.env())

    # --- events from the agent ------------------------------------------
    def on_event(self, event: dict) -> None:
        handler = getattr(self, f"_on_{event.get('type')}", None)
        if handler:
            handler(event)
        else:
            self.log(f"unhandled event: {event}")

    def _on_log(self, event: dict) -> None:
        text = str(event.get("text", "")).strip()
        self.log(text)
        # After startup the same lines are worker activity, on the Logs page.
        if text and self.state == "starting":
            self.chat.view.add_note(text)

    def _on_ready(self, event: dict) -> None:
        # What it took to start has served its purpose; Logs keeps it all.
        self.chat.view.clear()
        self._set_state("ready")
        self.chat.composer.plan_button.setChecked(False)
        self.menu = event.get("menu")
        self._show_menu()
        context = event.get("context") or {}
        docs = len(context.get("docs") or [])
        self.chat.view.add_note(
            f"Ready in {event.get('project')} · {event.get('mode')} mode · "
            f"{context.get('treeLines')} tree lines, {docs} doc{'' if docs == 1 else 's'}",
            "good",
        )
        if event.get("gem"):
            self.chat.view.add_note(f"Using Gem: {event['gem']}")
        if event.get("createdMemory"):
            self.chat.view.add_note("Created GEMINI.md for project memory.")
        if event.get("resumablePlan"):
            self.chat.view.add_note("An unfinished plan was found. Your next task will continue it.", "warn")
        self.log(f"tools: {', '.join(event.get('tools') or [])}")

    def _on_mcp(self, event: dict) -> None:
        servers = event.get("servers") or []
        self.mcp_page.show_servers(servers)
        for server in servers:
            count = len(server.get("tools") or [])
            if server.get("state") == "connected":
                self.chat.view.add_note(f"MCP server {server['name']} connected: {count} tool{'' if count == 1 else 's'}.")
            elif server.get("state") == "failed":
                self.chat.view.add_note(f"MCP server {server['name']} failed: {server.get('error')}", "bad")

    def _on_mcp_reply(self, reply: dict) -> None:
        if reply.get("ok"):
            self.mcp_page.show_servers(reply["data"]["servers"])

    def _on_fatal(self, event: dict) -> None:
        message = str(event.get("message", "")).strip()
        self.log(message)
        self.chat.view.add_note(message, "bad")
        self._set_state("failed")

    def _on_exited(self, event: dict) -> None:
        if self.state != "failed":
            self.chat.view.add_note(f"The agent stopped (exit code {event.get('code')}). Use Restart agent.", "bad")
        self._set_state("failed")

    def _on_task_start(self, _event: dict) -> None:
        self.interim_only = False
        self._set_state("busy")

    def _on_activity(self, event: dict) -> None:
        kind, text = event.get("kind"), str(event.get("text", ""))
        self.log(f"[{event.get('worker')}] {text}" if event.get("worker") else text)
        if kind == "tool":
            self.interim_only = False
            self.chat.view.add_tool(text, event.get("worker"))
        elif kind == "detail":
            self.chat.view.add_detail(text, bool(event.get("failed")))
        elif text:
            self.chat.view.add_note(f"[{event['worker']}] {text}" if event.get("worker") else text)

    def _on_answer(self, event: dict) -> None:
        text = str(event.get("text", ""))
        if self.interim_only and not event.get("interim") and len(text) <= MAX_NUDGE_ACK_CHARS:
            self.chat.view.add_note(text)
        else:
            self.chat.view.add_answer(text)
        self.interim_only = bool(event.get("interim"))

    def _on_task_end(self, event: dict) -> None:
        status = event.get("status")
        self._set_state("ready")
        # The model enters and leaves plan mode too, so follow the agent.
        self.chat.composer.plan_button.setChecked(bool(event.get("planMode")))
        if status == "stopped":
            self.chat.view.add_note("Stopped. The plan is kept, so you can ask it to continue.", "warn")
        elif status == "error":
            error = str(event.get("error", ""))
            self.log(error)
            self.chat.view.add_note(error, "bad")
        if self.pages.currentWidget() is self.plan_page:
            self.refresh_plan()

    def _on_confirm(self, event: dict) -> None:
        confirm_id = event.get("id")
        answer = lambda approve: self.agent.command("confirm", confirm_id=confirm_id, approve=approve)
        self.chat.view.add_confirm(confirm_id, str(event.get("label")), str(event.get("detail")), answer)
        self.nav.setCurrentRow(0)
        QApplication.alert(self)

    def _on_confirm_closed(self, event: dict) -> None:
        self.chat.view.close_confirm(event.get("id"))

    def _on_question(self, event: dict) -> None:
        question_id = event.get("id")
        answer = lambda text: self.agent.command("answer", question_id=question_id, text=text)
        self.chat.view.add_question(question_id, str(event.get("question")), event.get("options") or [], answer)
        self.nav.setCurrentRow(0)
        QApplication.alert(self)

    def _on_question_closed(self, event: dict) -> None:
        self.chat.view.close_question(event.get("id"), str(event.get("answer", "")))

    # --- user actions ---------------------------------------------------
    def submit(self, text: str) -> None:
        if text.startswith("/") and self._slash_command(text):
            return
        if self.state == "busy":
            self.chat.view.add_note(f"Steering: {text}")
            self.agent.command("steer", self._report_failure, text=text)
            return
        images = self.chat.composer.take_images()
        self.chat.view.add_user(text, images)
        self.agent.command("task", self._report_failure, text=text, images=images)

    def _slash_command(self, text: str) -> bool:
        """Runs a command, as in the terminal. False for anything else, which is a task."""
        name, _, arg = text[1:].partition(" ")
        name, arg = name.lower(), arg.strip()
        if name == "help":
            self.chat.view.add_note(HELP)
        elif name in ("plan", "memory", "skills"):
            page = {"plan": self.plan_page, "memory": self.memory_page, "skills": self.skills_page}[name]
            self.nav.setCurrentRow(self.pages.indexOf(page))
        elif name in ("clear", "new", "undo", "gems", "gem", "model", "thinking", "remember"):
            if self.state != "ready":
                self.chat.view.add_note(f"/{name} has to wait until the task ends.", "warn")
            elif name in ("clear", "new"):
                self.new_chat()
            elif name == "undo":
                self.undo()
            elif name == "gems":
                self.load_gems()
            elif name == "gem":
                self._apply_gem("" if arg.lower() in ("off", "none", "clear") else arg)
            elif name == "model":
                self.choose_model(arg)
            elif name == "thinking":
                self.choose_thinking(THINKING_WORDS.get(arg.lower(), arg))
            else:
                self.remember(arg)
        else:
            self.chat.view.add_note(f"Unknown command /{name}. Try /help.", "warn")
        return True

    def _report_failure(self, reply: dict) -> None:
        if not reply.get("ok"):
            self.chat.view.add_note(str(reply.get("error")), "bad")

    def stop_task(self) -> None:
        self.chat.status.setText("Stopping before the next turn…")
        self.ticker.stop()
        self.agent.command("stop", self._report_failure)

    def paste_image(self) -> None:
        def attached(reply: dict) -> None:
            if reply.get("ok"):
                self.chat.composer.add_image(reply["data"]["path"])
            else:
                self.chat.view.add_note(str(reply.get("error")), "warn")

        self.agent.command("paste_image", attached)

    def new_chat(self) -> None:
        def done(reply: dict) -> None:
            self._report_failure(reply)
            if reply.get("ok"):
                self.chat.view.clear()
                self.chat.view.add_note("New Gemini thread.")

        self.agent.command("new_chat", done)

    def undo(self) -> None:
        if not self._ask("Revert all file changes from the last task?"):
            return

        def done(reply: dict) -> None:
            self._report_failure(reply)
            data = reply.get("data") or {}
            if reply.get("ok"):
                self.chat.view.add_note(str(data.get("message")), "good" if data.get("ok") else "warn")

        self.agent.command("undo", done)

    def toggle_plan_mode(self, on: bool) -> None:
        def done(reply: dict) -> None:
            self._report_failure(reply)
            if not reply.get("ok"):
                self.chat.composer.plan_button.setChecked(not on)

        self.agent.command("plan_mode", done, on=on)

    def open_model_picker(self) -> None:
        self.model_popup.set_menu(self.menu)
        self.model_popup.show_above(self.chat.composer.model_button)
        # Shown at once from the last read, then corrected from the browser,
        # so a plan change or a new model appears without restarting.
        self.agent.command("models", self._on_menu_reply)

    def _on_menu_reply(self, reply: dict) -> None:
        if reply.get("ok"):
            self.menu = reply["data"]["menu"]
            self._show_menu()
        else:
            self.log(f"couldn't read the model list: {reply.get('error')}")

    def choose_model(self, name: str) -> None:
        if not name:
            self.chat.view.add_note("Try /model followed by a name from the model picker.", "warn")
            return
        self.model_popup.hide()
        self.chat.composer.model_button.setText("Switching…")

        def done(reply: dict) -> None:
            self._report_failure(reply)
            self._on_menu_reply(reply)
            self._show_menu()
            if reply.get("ok"):
                self.settings["model"] = name
                self.settings.save()

        self.agent.command("model", done, text=name)

    def choose_thinking(self, level: str) -> None:
        if not level:
            self.chat.view.add_note("Try /thinking followed by a level from the model picker.", "warn")
            return
        self.model_popup.hide()
        self.chat.composer.model_button.setText("Switching…")

        def done(reply: dict) -> None:
            self._report_failure(reply)
            self._on_menu_reply(reply)
            self._show_menu()
            if reply.get("ok"):
                self.settings["thinking_level"] = level
                self.settings.save()

        self.agent.command("thinking", done, text=level)

    def _fill_gem_menu(self) -> None:
        menu = self.gem_menu
        menu.clear()
        current = self.settings["gem"]
        none = menu.addAction(("✓  " if not current else "") + "No Gem")
        none.triggered.connect(lambda: self._apply_gem(""))
        if self.gems is None:
            self.load_gems()
            loading = menu.addAction("Loading your Gems…")
            loading.setEnabled(False)
            return
        for gem in self.gems:
            action = menu.addAction(("✓  " if gem == current else "") + gem)
            action.triggered.connect(lambda _=False, name=gem: self._apply_gem(name))
        menu.addSeparator()
        menu.addAction("Reload from Gemini").triggered.connect(self.load_gems)

    def load_gems(self) -> None:
        def done(reply: dict) -> None:
            if reply.get("ok"):
                self.gems = [gem["name"] for gem in reply["data"]["gems"]]
                if self.gem_menu.isVisible():
                    self._fill_gem_menu()
            else:
                self._report_failure(reply)

        self.agent.command("gems", done)

    def _apply_gem(self, name: str) -> None:
        def done(reply: dict) -> None:
            if reply.get("ok"):
                gem = reply["data"]["gem"]
                self.settings["gem"] = gem or ""
                self.settings.save()
                self.chat.view.add_note(f"Using Gem: {gem}. Fresh thread." if gem else "No Gem. Fresh thread.")
            else:
                self._report_failure(reply)
            self._show_gem()

        self.agent.command("gem", done, text=name)

    def refresh_skills(self) -> None:
        def done(reply: dict) -> None:
            if reply.get("ok"):
                self.skills_page.show_skills(reply["data"])
            else:
                self.skills_page.say(str(reply.get("error")))

        self.agent.command("skills", done)

    def find_skills(self, source: str) -> None:
        def done(reply: dict) -> None:
            if reply.get("ok"):
                self.skills_page.show_found(reply["data"]["found"])
            else:
                self.skills_page.show_found(None, str(reply.get("error")))

        self.agent.command("skill_find", done, text=source)

    def install_skills(self, source: str, names: list) -> None:
        def done(reply: dict) -> None:
            if reply.get("ok"):
                self.skills_page.installed([skill["name"] for skill in reply["data"]["installed"]])
                self.refresh_skills()
            else:
                self.skills_page.installed(None, str(reply.get("error")))

        self.agent.command("skill_install", done, text=source, names=names)

    def remove_skill(self, name: str) -> None:
        if not self._ask(f"Remove the skill {name}?"):
            return

        def done(reply: dict) -> None:
            if not reply.get("ok"):
                self.skills_page.say(str(reply.get("error")))
            self.refresh_skills()

        self.agent.command("skill_remove", done, text=name)

    def refresh_plan(self) -> None:
        def done(reply: dict) -> None:
            self.plan_page.show_text((reply.get("data") or {}).get("plan"))

        self.agent.command("plan", done)

    def clear_plan(self) -> None:
        if self._ask("Delete GEMINI-PLAN.md?"):
            self.agent.command("plan_clear", lambda reply: (self._report_failure(reply), self.refresh_plan()))

    def refresh_memory(self) -> None:
        def done(reply: dict) -> None:
            self.memory_page.show_text((reply.get("data") or {}).get("memory"))

        self.agent.command("memory", done)

    def remember(self, text: str) -> None:
        def done(reply: dict) -> None:
            self._report_failure(reply)
            if reply.get("ok"):
                self.memory_page.show_text(reply["data"]["memory"])

        self.agent.command("remember", done, text=text)

    def _ask(self, question: str) -> bool:
        answer = QMessageBox.question(self, "gemini-code", question)
        return answer == QMessageBox.StandardButton.Yes

    def changeEvent(self, event) -> None:
        # Maximized fills the screen, so no rounded corners, shadow or edges.
        if event.type() == QEvent.Type.WindowStateChange:
            maximized = self.isMaximized() or self.isFullScreen()
            self.frame.set_maximized(maximized)
            self.title_bar.show_state(maximized)
        super().changeEvent(event)

    def closeEvent(self, event) -> None:
        if self.state == "busy" and not self._ask("A task is running. Quit anyway?"):
            event.ignore()
            return
        self.agent.stop_and_wait()
        self.api.stop_and_wait()
        event.accept()
