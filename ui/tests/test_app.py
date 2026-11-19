"""UI tests, no framework, in the style of src/tests/smoke.ts.

Runs the real window against tests/fake_bridge.py, with no browser or Gemini:

    python ui/tests/test_app.py [folder-for-screenshots]
"""
import json
import os
import re
import sys
import tempfile
import time
import traceback
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
UI_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(UI_ROOT))

from PySide6.QtCore import QPoint, Qt, QUrl
from PySide6.QtGui import QFontDatabase
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QLabel, QMessageBox

from gemini_code_ui import chat
from gemini_code_ui import window as window_module
from gemini_code_ui.chat import ConfirmCard, CodeBlock, MarkdownView, split_markdown
from gemini_code_ui.settings import SETTINGS, Settings
from gemini_code_ui.theme import apply_theme
from gemini_code_ui.window import MainWindow

BACKEND = [sys.executable, str(UI_ROOT / "tests" / "fake_bridge.py")]

app = QApplication([])
apply_theme(app)
shots = Path(sys.argv[1]) if len(sys.argv) > 1 else None
scratch = Path(tempfile.mkdtemp())
# The offscreen platform has no fonts of its own, so screenshots need some.
for font in ("segoeui", "seguisb", "segoeuib", "seguisym", "CascadiaMono", "consola"):
    QFontDatabase.addApplicationFont(f"C:/Windows/Fonts/{font}.ttf")
passed = failed = 0


def test(fn):
    global passed, failed
    try:
        fn()
        passed += 1
        print(f"  ok - {fn.__name__.replace('_', ' ')}")
    except Exception:
        failed += 1
        print(f"  FAIL - {fn.__name__}\n{traceback.format_exc()}")
    return fn


def wait_for(condition, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        app.processEvents()
        if condition():
            return
        QTest.qWait(10)
    raise AssertionError("timed out waiting for the UI")


def make_window(project=True) -> MainWindow:
    folder = scratch / "project"
    folder.mkdir(exist_ok=True)
    settings = Settings({"project": str(folder) if project else ""}, scratch / "settings.json")
    window = MainWindow(settings, BACKEND)
    window.show()
    if project:
        wait_for(lambda: window.state == "ready")
    return window


def transcript(window) -> str:
    """The chat as text, with each widget's kind, for asserting on."""
    out = []
    content = window.chat.view.widget()
    for label in content.findChildren(QLabel):
        out.append(label.text())
    for view in content.findChildren(MarkdownView):
        out.append(view.toPlainText())
    return "\n".join(out)


def send(window, text):
    window.chat.composer.edit.setPlainText(text)
    QTest.keyClick(window.chat.composer.edit, Qt.Key.Key_Return)


def shot(window, name):
    if shots:
        shots.mkdir(parents=True, exist_ok=True)
        app.processEvents()
        window.grab().save(str(shots / f"{name}.png"))


def close(window):
    window.state = "ready"  # skip the "task running" question
    window.close()


print("Markdown splitting:")


@test
def separates_code_from_prose():
    parts = split_markdown("before\n```python\nx = 1\n```\nafter")
    assert parts == [("text", "before", ""), ("code", "x = 1", "python"), ("text", "after", "")]


@test
def an_unclosed_fence_runs_to_the_end():
    assert split_markdown("```\nstill code") == [("code", "still code", "")]


@test
def a_fence_inside_a_longer_fence_is_code():
    body = "````md\n```\ninner\n```\n````"
    assert split_markdown(body) == [("code", "```\ninner\n```", "md")]


print("Links:")


@test
def web_addresses_in_text_become_links_and_the_rest_is_escaped():
    html = chat.linkify("see https://example.com/a?b=1&c=2. or www.python.org, <b>not bold</b>")
    assert 'href="https://example.com/a?b=1&amp;c=2"' in html, html
    assert ">https://example.com/a?b=1&amp;c=2</a>. or" in html, "the full stop isn't part of the link"
    assert 'href="https://www.python.org"' in html and "www.python.org</a>," in html
    assert "&lt;b&gt;not bold&lt;/b&gt;" in html, "text from a message is never markup"


@test
def a_bracket_around_a_link_stays_outside_it():
    assert 'href="https://a.dev/x"' in chat.linkify("(see https://a.dev/x)")
    assert 'href="https://en.wikipedia.org/wiki/Python_(language)"' in chat.linkify(
        "https://en.wikipedia.org/wiki/Python_(language)"
    ), "a bracket that belongs to the URL stays in it"


@test
def bare_urls_in_replies_become_links_but_not_inside_code():
    md = chat.autolink_markdown("Go to https://a.dev/docs. See [docs](https://b.dev) and `curl https://c.dev`")
    assert "<https://a.dev/docs>." in md
    assert "[docs](https://b.dev)" in md, "a link already written stays as it is"
    assert "`curl https://c.dev`" in md, "a URL in code stays literal"


@test
def clicking_a_link_opens_it_and_nothing_else():
    opened = []
    real = chat.QDesktopServices.openUrl
    chat.QDesktopServices.openUrl = staticmethod(lambda url: opened.append(url.toString()))
    try:
        label = chat.wrapped_label("read https://example.com/page now", "note", links=True)
        assert label.textFormat() == Qt.TextFormat.RichText
        label.linkActivated.emit("https://example.com/page")
        label.linkActivated.emit("file:///C:/Windows/System32/calc.exe")
        assert opened == ["https://example.com/page"], opened
        plain = chat.wrapped_label("no links <here>", "note", links=True)
        assert plain.textFormat() == Qt.TextFormat.PlainText and plain.text() == "no links <here>"
    finally:
        chat.QDesktopServices.openUrl = real


@test
def a_link_in_your_own_message_is_clickable():
    window = make_window()
    send(window, "check https://example.com/page please")
    wait_for(lambda: window.chat.view.widget().findChildren(chat.UserMessage))
    label = window.chat.view.widget().findChildren(chat.UserMessage)[0].label
    assert 'href="https://example.com/page"' in label.text()
    close(window)


print("Window frame:")


@test
def the_window_is_borderless_and_draws_its_own_title_bar():
    window = make_window()
    assert window.windowFlags() & Qt.WindowType.FramelessWindowHint
    assert window.title_bar.isVisible()
    window.title_bar.toggle_maximized()
    wait_for(lambda: window.isMaximized())
    assert window.frame.maximized and window.frame.column.contentsMargins().left() == 0
    window.title_bar.toggle_maximized()
    wait_for(lambda: not window.isMaximized())
    assert not window.frame.maximized and window.frame.column.contentsMargins().left() > 0
    close(window)


@test
def the_edges_resize_and_the_middle_does_not():
    window = make_window()
    frame = window.frame
    frame.resize(800, 600)
    edges = frame._edges
    assert edges(QPoint(1, 300)) == Qt.Edge.LeftEdge
    assert edges(QPoint(799, 599)) == Qt.Edge.RightEdge | Qt.Edge.BottomEdge
    assert edges(QPoint(400, 300)) == Qt.Edge(0)
    frame.set_maximized(True)
    assert edges(QPoint(1, 1)) == Qt.Edge(0), "nothing to resize when maximized"
    frame.set_maximized(False)
    close(window)


print("Settings:")


@test
def defaults_pass_nothing_to_the_agent():
    assert all(value is None for value in Settings().env().values())


@test
def changed_values_become_environment_variables():
    settings = Settings({"model": "pro", "orchestrator": False, "auto_approve": True, "max_turns": 80})
    env = settings.env()
    assert env["GEMINI_CODE_MODEL"] == "pro"
    assert env["GEMINI_CODE_ORCHESTRATOR"] == "0"
    assert env["GEMINI_CODE_AUTO_APPROVE"] == "1"
    assert env["GEMINI_CODE_MAX_TURNS"] == "80"


@test
def survives_a_round_trip_and_ignores_unknown_keys():
    path = scratch / "round-trip.json"
    Settings({"max_workers": 5}, path).save()
    assert Settings.load(path)["max_workers"] == 5
    path.write_text(json.dumps({"nonsense": 1, "model": "pro"}), encoding="utf-8")
    loaded = Settings.load(path)
    assert "nonsense" not in loaded.values and loaded["model"] == "pro"


@test
def settings_saved_with_a_bom_still_load():
    path = scratch / "bom.json"
    path.write_text(json.dumps({"model": "pro"}), encoding="utf-8-sig")
    assert Settings.load(path)["model"] == "pro"


@test
def a_corrupt_file_falls_back_to_defaults():
    path = scratch / "corrupt.json"
    path.write_text("{not json", encoding="utf-8")
    assert Settings.load(path)["gem_mode"] == "reference"


@test
def every_environment_variable_the_agent_reads_is_configurable():
    used = set()
    for file in (UI_ROOT.parent / "src").rglob("*.ts"):
        if "tests" not in file.parts:
            used |= set(re.findall(r"GEMINI_CODE_[A-Z_]+", file.read_text(encoding="utf-8")))
    missing = used - {s.env for s in SETTINGS}
    assert not missing, f"not in the UI: {sorted(missing)}"


print("Window, against a fake agent:")


@test
def first_run_waits_for_a_project_folder():
    window = make_window(project=False)
    QTest.qWait(50)
    assert window.state == "offline" and not window.agent.running()
    assert "Choose a project folder" in transcript(window)
    assert not window.chat.composer.send_button.isEnabled()
    shot(window, "first-run")
    close(window)


@test
def startup_shows_context_and_a_resumable_plan():
    window = make_window()
    text = transcript(window)
    assert "Ready in demo" in text and "unfinished plan" in text
    wait_for(lambda: "Starting" not in transcript(window))  # startup chatter is cleared once ready
    close(window)


@test
def a_task_shows_tools_then_a_rendered_answer():
    window = make_window()
    send(window, "look around")
    wait_for(lambda: window.chat.view.widget().findChildren(CodeBlock))
    wait_for(lambda: window.state == "ready")
    text = transcript(window)
    assert "look around" in text and "read_file" in text and "a.py" in text
    assert "[api]" in text and "run_bash" in text and "Exit code 1" in text
    block = window.chat.view.widget().findChildren(CodeBlock)[0]
    assert 'return "hi"' in block.code
    assert window.chat.composer.edit.toPlainText() == ""
    shot(window, "task")
    close(window)


@test
def code_is_copied_exactly():
    window = make_window()
    send(window, "look around")
    wait_for(lambda: window.chat.view.widget().findChildren(CodeBlock))
    block = window.chat.view.widget().findChildren(CodeBlock)[0]
    block.copy.click()
    assert QApplication.clipboard().text() == block.code
    close(window)


@test
def a_plain_question_shows_its_answer_and_quiets_the_nudge_reply():
    window = make_window()
    send(window, "a question")
    wait_for(lambda: "That answer is complete." in transcript(window))
    views = [v.toPlainText() for v in window.chat.view.widget().findChildren(MarkdownView)]
    assert views == ["Paris is the capital of France."], views
    close(window)


@test
def allow_approves_and_the_card_collapses():
    window = make_window()
    send(window, "write a file")
    wait_for(lambda: window.chat.view.widget().findChildren(ConfirmCard))
    card = window.chat.view.widget().findChildren(ConfirmCard)[0]
    assert window.state == "busy"
    shot(window, "confirm")
    card.allow.click()
    wait_for(lambda: "Wrote it." in transcript(window))
    assert "Allowed" in card.title.text() and not card.buttons.isVisible()
    close(window)


@test
def deny_refuses():
    window = make_window()
    send(window, "write a file")
    wait_for(lambda: window.chat.view.widget().findChildren(ConfirmCard))
    window.chat.view.widget().findChildren(ConfirmCard)[0].deny.click()
    wait_for(lambda: "Skipped that." in transcript(window))
    assert "declined by the user" in transcript(window)
    close(window)


def question_card(window):
    wait_for(lambda: window.chat.view.widget().findChildren(chat.QuestionCard))
    return window.chat.view.widget().findChildren(chat.QuestionCard)[0]


@test
def a_question_offers_its_choices_and_closes_when_answered():
    window = make_window()
    send(window, "choose one")
    card = question_card(window)
    assert [b.text() for b in card.choices] == ["Postgres", "SQLite"]
    shot(window, "question")
    card.choices[1].click()
    wait_for(lambda: "Using SQLite." in transcript(window))
    assert "SQLite" in card.title.text() and not card.body.isVisible()
    close(window)


@test
def a_question_also_takes_a_typed_answer():
    window = make_window()
    send(window, "choose one")
    card = question_card(window)
    card.field.setText("MySQL")
    card.field.returnPressed.emit()
    wait_for(lambda: "Using MySQL." in transcript(window))
    close(window)


@test
def stop_closes_a_pending_question():
    window = make_window()
    send(window, "choose one")
    card = question_card(window)
    window.chat.composer.stop_button.click()
    wait_for(lambda: window.state == "ready")
    assert "No answer" in card.title.text()
    close(window)


@test
def the_plan_mode_toggle_follows_the_agent():
    window = make_window()
    button = window.chat.composer.plan_button
    button.click()
    assert button.isChecked()
    send(window, "plan it")
    wait_for(lambda: window.state == "ready" and not button.isChecked())
    close(window)


def open_skills(window):
    window.nav.setCurrentRow(window.pages.indexOf(window.skills_page))
    return window.skills_page


def page_text(page):
    return "\n".join(label.text() for label in page.findChildren(QLabel))


@test
def the_skills_page_shows_claude_skills_and_installs_from_github():
    window = make_window()
    page = open_skills(window)
    wait_for(lambda: "synced" in page_text(page))

    page.field.setText("anthropics/skills")
    page.find_button.click()
    wait_for(lambda: list(page.choices) == ["pdf", "docx"])
    assert "Includes 1 script it may ask to run." in page_text(page)
    assert not page.choices["pdf"].isChecked(), "with several, nothing is chosen for you"
    shot(window, "skills")

    page.choices["pdf"].setChecked(True)
    page.install_button.click()
    wait_for(lambda: "Installed pdf." in page.message.text())
    wait_for(lambda: "anthropics/skills" in page_text(page))
    assert not page.choices and not page.field.text()
    close(window)


@test
def a_failed_lookup_says_why_and_can_be_retried():
    window = make_window()
    page = open_skills(window)
    page.field.setText("nobody/missing")
    page.field.returnPressed.emit()
    wait_for(lambda: "Not found" in page.message.text())
    assert page.find_button.isEnabled()
    close(window)


@test
def a_skill_can_be_removed_after_asking():
    window = make_window()
    page = open_skills(window)
    page.source = "a/b"
    window.install_skills("a/b", ["temp"])
    wait_for(lambda: "temp" in page_text(page))
    original = QMessageBox.question
    QMessageBox.question = staticmethod(lambda *a: QMessageBox.StandardButton.Yes)
    try:
        page.remove.emit("temp")
        wait_for(lambda: "<b>temp</b>" not in page_text(page))
    finally:
        QMessageBox.question = original
    close(window)


def folders(*names):
    paths = []
    for name in names:
        path = scratch / "folders" / name
        path.mkdir(parents=True, exist_ok=True)
        paths.append(str(path))
    return paths


def menu_labels(window):
    window._fill_folder_menu()
    return [action.text().strip() for action in window.folder_menu.actions() if action.text()]


@test
def the_folder_picker_lists_recent_folders_with_the_current_one_ticked():
    window = make_window()
    alpha, beta = folders("alpha", "beta")
    window.settings["recent_projects"] = [alpha, beta, str(scratch / "deleted-long-ago")]
    labels = menu_labels(window)
    assert labels[0].startswith("✓") and labels[0].endswith("project"), labels
    assert labels[1:] == ["alpha", "beta", "Choose another folder…"], "missing folders are left out"
    assert window.chat.composer.folder_button.text().startswith("project")
    close(window)


@test
def choosing_another_folder_starts_a_new_chat_there_and_remembers_it():
    window = make_window()
    (alpha,) = folders("alpha")
    send(window, "look around")
    wait_for(lambda: window.state == "ready" and "a.py" in transcript(window))

    window.set_project(alpha)
    wait_for(lambda: window.state == "ready" and "look around" not in transcript(window))
    assert window.settings["project"] == alpha
    assert window.chat.composer.folder_button.text().startswith("alpha")
    saved = Settings.load(window.settings.path)["recent_projects"]
    assert saved[0] == alpha and saved[1].endswith("project"), saved
    close(window)


@test
def choosing_the_same_folder_keeps_the_chat():
    window = make_window()
    send(window, "look around")
    wait_for(lambda: window.state == "ready" and "a.py" in transcript(window))
    window.set_project(window.settings["project"])
    QTest.qWait(200)
    assert "look around" in transcript(window), "nothing to restart for"
    close(window)


@test
def any_folder_can_be_chosen_and_the_list_stays_short():
    window = make_window()
    many = folders(*[f"f{i}" for i in range(12)])
    window.settings["recent_projects"] = many
    assert len(window.recent_folders()) == 8

    (picked,) = folders("picked")
    original = window_module.QFileDialog.getExistingDirectory
    window_module.QFileDialog.getExistingDirectory = staticmethod(lambda *a: picked)
    try:
        next(a for a in (window._fill_folder_menu() or window.folder_menu.actions()) if a.text().startswith("Choose")).trigger()
    finally:
        window_module.QFileDialog.getExistingDirectory = original
    wait_for(lambda: window.settings["project"] == picked and window.state == "ready")
    close(window)


@test
def the_folder_can_be_chosen_on_first_run_but_not_mid_task():
    window = make_window(project=False)
    QTest.qWait(50)
    assert window.chat.composer.folder_button.isEnabled()
    assert window.chat.composer.folder_button.text().startswith("Choose a folder")
    close(window)

    window = make_window()
    send(window, "hang around")
    wait_for(lambda: window.state == "busy")
    assert not window.chat.composer.folder_button.isEnabled()
    window.chat.composer.stop_button.click()
    wait_for(lambda: window.state == "ready")
    assert window.chat.composer.folder_button.isEnabled()
    close(window)


@test
def mcp_results_reach_the_chat_and_the_page():
    window = make_window()
    wait_for(lambda: "MCP server files connected: 2 tools." in transcript(window))
    assert "MCP server broken failed" in transcript(window)
    window.nav.setCurrentRow(window.pages.indexOf(window.mcp_page))
    wait_for(lambda: "Connected, 2 tools" in window.mcp_page.status.text())
    assert "&lt;b&gt;" in window.mcp_page.status.text(), "a server's error text must not be treated as markup"
    shot(window, "mcp")
    close(window)


@test
def the_mcp_page_saves_valid_config_and_refuses_the_rest():
    window = make_window()
    config = Path(window.settings["project"]) / ".mcp.json"
    config.unlink(missing_ok=True)
    window.nav.setCurrentRow(window.pages.indexOf(window.mcp_page))
    page = window.mcp_page

    page.editor.setPlainText("{not json")
    page.save.click()
    assert "isn't valid" in page.message.text() and not config.exists()

    page.editor.setPlainText('{"mcpServers": {"a": {"command": "node"}}}')
    page.save.click()
    assert json.loads(config.read_text(encoding="utf-8"))["mcpServers"]["a"]["command"] == "node"
    wait_for(lambda: window.pages.currentWidget() is window.chat)
    wait_for(lambda: window.state == "ready")

    window.nav.setCurrentRow(window.pages.indexOf(window.mcp_page))
    assert "node" in page.editor.toPlainText(), "it reads back what's on disk"
    page.editor.setPlainText("")
    page.save.click()
    assert not config.exists()
    wait_for(lambda: window.state == "ready")
    close(window)


@test
def stop_closes_the_pending_approval():
    window = make_window()
    send(window, "write a file")
    wait_for(lambda: window.chat.view.widget().findChildren(ConfirmCard))
    window.chat.composer.stop_button.click()
    wait_for(lambda: window.state == "ready")
    card = window.chat.view.widget().findChildren(ConfirmCard)[0]
    assert "Denied (task stopped)" in card.title.text()
    assert "Stopped." in transcript(window)
    close(window)


@test
def typing_during_a_task_steers_it_rather_than_starting_another():
    window = make_window()
    send(window, "hang around")
    wait_for(lambda: window.state == "busy")
    assert "Steer" in window.chat.composer.send_button.toolTip()
    composer = window.chat.composer
    assert not composer.model_button.isEnabled() and not composer.gem_button.isEnabled()
    assert not window.new_chat_button.isEnabled()
    send(window, "use tabs instead")
    wait_for(lambda: "Steering: use tabs instead" in transcript(window))
    window.chat.composer.stop_button.click()
    wait_for(lambda: window.state == "ready")
    assert window.chat.composer.send_button.toolTip() == "Send"
    close(window)


@test
def a_failed_task_says_why_and_the_chat_stays_usable():
    window = make_window()
    send(window, "fail please")
    wait_for(lambda: "Gemini never replied." in transcript(window))
    assert window.state == "ready" and window.chat.composer.send_button.isEnabled()
    close(window)


def pill(window):
    return window.chat.composer.model_button.text()


def open_picker(window):
    window.chat.composer.model_button.click()
    wait_for(window.model_popup.isVisible)
    return window.model_popup


@test
def the_picker_lists_what_gemini_offers_and_nothing_else():
    window = make_window()
    assert pill(window).startswith("Auto · Low"), pill(window)
    popup = open_picker(window)
    names = [row.name for row in popup.rows[:3]]
    assert names == ["Auto", "Test Fast", "4 Argon"], names
    assert "Flash" not in " ".join(row.name for row in popup.rows), "no model of our own may appear"
    assert list(popup.levels) == ["Low", "Medium", "High"]
    assert popup.levels["Low"].isChecked()
    if shots:
        wait_for(lambda: len(popup.rows) == 4)
        app.processEvents()
        popup.grab().save(str(shots / "picker.png"))
    popup.hide()
    close(window)


@test
def reopening_the_picker_refreshes_it_from_the_browser():
    window = make_window()
    popup = open_picker(window)
    wait_for(lambda: "Test Lite" in [row.name for row in popup.rows])
    close(window)


@test
def a_locked_model_cannot_be_chosen_from_the_picker():
    window = make_window()
    popup = open_picker(window)
    chosen = []
    popup.modelChosen.connect(chosen.append)
    row = next(r for r in popup.rows if r.name == "4 Argon")
    assert row.locked
    QTest.mouseClick(row, Qt.MouseButton.LeftButton)
    QTest.keyClick(row, Qt.Key.Key_Return)
    assert chosen == [] and popup.isVisible()
    close(window)


@test
def choosing_a_model_applies_it_and_remembers_it():
    window = make_window()
    popup = open_picker(window)
    QTest.mouseClick(next(r for r in popup.rows if r.name == "Test Fast"), Qt.MouseButton.LeftButton)
    wait_for(lambda: pill(window).startswith("Test Fast"))
    assert not popup.isVisible()
    assert Settings.load(window.settings.path)["model"] == "Test Fast"
    close(window)


@test
def a_refused_model_says_why_and_the_pill_stays_truthful():
    window = make_window()
    send(window, "/model 4 Argon")
    wait_for(lambda: "isn't included in your Gemini plan" in transcript(window))
    wait_for(lambda: pill(window).startswith("Auto"))
    assert window.settings["model"] == ""
    close(window)


@test
def thinking_level_is_applied_and_remembered():
    window = make_window()
    popup = open_picker(window)
    popup.levels["High"].click()
    wait_for(lambda: "High" in pill(window))
    assert Settings.load(window.settings.path)["thinking_level"] == "High"
    close(window)


@test
def no_readable_list_says_so_instead_of_inventing_one():
    folder = scratch / "project"
    settings = Settings({"project": str(folder)}, scratch / "settings.json")
    window = MainWindow(settings, [*BACKEND, "--no-models"])
    window.show()
    wait_for(lambda: window.state == "ready")
    popup = open_picker(window)
    assert not popup.rows
    assert "Couldn't read the model list" in " ".join(l.text() for l in popup.findChildren(QLabel))
    close(window)


@test
def tool_details_stay_folded_unless_the_tool_failed():
    window = make_window()
    send(window, "look around")
    wait_for(lambda: window.chat.view.widget().findChildren(CodeBlock))
    good, bad = window.chat.view.widget().findChildren(chat.ToolRow)
    assert good.details.isHidden() and not bad.details.isHidden()
    good.chevron.click()
    assert not good.details.isHidden()
    close(window)


@test
def gems_load_and_one_can_be_chosen():
    window = make_window()
    window.load_gems()
    wait_for(lambda: window.gems == ["Kite 2", "Storybook"])
    window._apply_gem("Kite 2")
    wait_for(lambda: "Using Gem: Kite 2" in transcript(window))
    assert window.settings["gem"] == "Kite 2"
    assert window.chat.composer.gem_button.text().startswith("Kite 2")
    close(window)


@test
def slash_commands_work_and_unknown_ones_are_not_sent_as_tasks():
    window = make_window()
    send(window, "/help")
    assert "/undo" in transcript(window)
    send(window, "/nonsense")
    assert "Unknown command /nonsense" in transcript(window)
    send(window, "/thinking on")
    wait_for(lambda: "High" in pill(window))
    assert window.settings["thinking_level"] == "High"
    close(window)


@test
def memory_page_shows_and_adds_notes():
    window = make_window()
    window.nav.setCurrentRow(2)
    wait_for(lambda: "uses pnpm" in window.memory_page.view.toPlainText())
    window.memory_page.note.setText("prefers tabs")
    window.memory_page.note.returnPressed.emit()
    wait_for(lambda: "prefers tabs" in window.memory_page.view.toPlainText())
    shot(window, "memory")
    close(window)


@test
def plan_page_explains_when_there_is_no_plan():
    window = make_window()
    window.nav.setCurrentRow(1)
    wait_for(lambda: "No plan yet" in window.plan_page.view.toPlainText())
    close(window)


@test
def saving_settings_restarts_the_agent_with_them():
    window = make_window()
    window.nav.setCurrentRow(3)
    shot(window, "settings")
    window.settings_page.form.editors["max_workers"].set_value(5)
    window.settings_page.save.click()
    assert Settings.load(window.settings.path)["max_workers"] == 5
    wait_for(lambda: window.state == "offline" or "Restarting" in transcript(window))
    wait_for(lambda: window.state == "ready")
    assert window.pages.currentWidget() is window.chat
    close(window)


@test
def undo_asks_first():
    window = make_window()
    asked = []
    original = QMessageBox.question
    QMessageBox.question = staticmethod(lambda *a: asked.append(a) or QMessageBox.StandardButton.No)
    try:
        window.undo()
        assert asked and "Reverted" not in transcript(window)
        QMessageBox.question = staticmethod(lambda *a: QMessageBox.StandardButton.Yes)
        window.undo()
        wait_for(lambda: "Reverted 2 files." in transcript(window))
    finally:
        QMessageBox.question = original
    close(window)


@test
def an_agent_that_dies_is_reported_and_restart_works():
    window = make_window()
    window.agent._proc.kill()
    wait_for(lambda: window.state == "failed")
    assert "The agent stopped" in transcript(window)
    window.restart_action.trigger()
    wait_for(lambda: window.state == "ready")
    close(window)


@test
def a_backend_that_cannot_start_is_reported():
    folder = scratch / "project"
    settings = Settings({"project": str(folder)}, scratch / "settings.json")
    window = MainWindow(settings, ["this-program-does-not-exist-anywhere"])
    window.show()
    wait_for(lambda: window.state == "failed")
    assert "Couldn't start the agent" in transcript(window)
    close(window)


@test
def closing_stops_the_agent():
    window = make_window()
    assert window.agent.running()
    window.close()
    assert not window.agent.running()


@test
def clearing_the_chat_right_after_copying_is_safe():
    window = make_window()
    send(window, "look around")
    wait_for(lambda: window.chat.view.widget().findChildren(CodeBlock))
    window.chat.view.widget().findChildren(CodeBlock)[0].copy.click()
    window.chat.view.clear()
    QTest.qWait(1700)  # past the button's "Copied" timer
    close(window)


@test
def links_only_open_for_web_addresses():
    opened = []
    real = chat.QDesktopServices.openUrl
    chat.QDesktopServices.openUrl = staticmethod(lambda url: opened.append(url.scheme()))
    try:
        chat.open_link(QUrl("https://example.com"))
        chat.open_link(QUrl("file:///C:/Windows/System32/calc.exe"))
        assert opened == ["https"]
    finally:
        chat.QDesktopServices.openUrl = real


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
