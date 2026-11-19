"""Everything the app can configure, and where it's kept.

The agent is configured through GEMINI_CODE_* environment variables, most of
them read once at startup. So a setting here is just a variable with a label:
the forms are generated from SETTINGS, and saving restarts the agent with the
new environment. The defaults mirror the agent's own, and a value left at its
default isn't passed at all, so the agent stays the authority on what it means.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SETTINGS_FILE = Path.home() / ".gemini-code" / "ui-settings.json"


@dataclass(frozen=True)
class Setting:
    key: str
    label: str
    group: str
    kind: str  # choice | bool | int | text | path | secret
    default: Any
    env: str | None = None
    help: str = ""
    choices: tuple[tuple[str, str], ...] = ()
    minimum: int = 0
    maximum: int = 100_000_000
    # What a bool becomes in the environment; None leaves the variable unset.
    on: str | None = "1"
    off: str | None = "0"


GENERAL = "General"
LIMITS = "Agent limits"
WORKERS = "Worker tabs"
TIMEOUTS = "Timeouts"
BROWSER = "Browser and shell"
API = "API server"
PICKER = "Composer picker"  # not on any form

SETTINGS: tuple[Setting, ...] = (
    Setting("project", "Project folder", GENERAL, "path", "",
            help="The agent reads and edits files here, and refuses paths outside it."),
    # Set from the composer's picker, which lists what Gemini offers this
    # account. Empty leaves Gemini on whatever it has selected.
    Setting("model", "Model", PICKER, "text", "", "GEMINI_CODE_MODEL"),
    Setting("thinking_level", "Thinking level", PICKER, "text", "", "GEMINI_CODE_THINKING_LEVEL"),
    # The terminal's Extended thinking toggle (on | off), where the picker has one.
    Setting("extended_thinking", "Extended thinking", PICKER, "text", "", "GEMINI_CODE_THINKING"),
    # Most recent first, for the composer's folder picker.
    Setting("recent_projects", "Recent folders", PICKER, "list", ()),
    Setting("enterprise_url", "Gemini Enterprise link", GENERAL, "text", "", "GEMINI_CODE_ENTERPRISE_URL",
            help="Where you sign in, e.g. https://vertexaisearch.cloud.google.com/home/cid/<id>. "
                 "Empty uses gemini.google.com (or the link saved by the terminal app)."),
    Setting("add_dirs", "Extra workspace folders", GENERAL, "text", "", "GEMINI_CODE_ADD_DIRS",
            help="Other repositories the agent may read and edit, separated by ; on Windows (: elsewhere)."),
    Setting("temporary_chat", "Use Temporary chats", GENERAL, "bool", True, "GEMINI_CODE_TEMPORARY_CHAT",
            help="The agent's threads stay out of your Gemini history. Not available on Gemini Enterprise."),
    Setting("gem", "Gem", GENERAL, "text", "", "GEMINI_CODE_GEM",
            help="Name or id of a Gem to use. Leave empty for none."),
    Setting("gem_mode", "Gem mode", GENERAL, "choice", "reference", "GEMINI_CODE_GEM_MODE",
            choices=(("reference", "Reference (ask_gem consults it)"), ("inside", "Inside (whole session runs in it)"))),
    Setting("orchestrator", "Orchestrator mode", GENERAL, "bool", True, "GEMINI_CODE_ORCHESTRATOR",
            help="Main tab plans and validates while worker tabs implement. Off: one tab does everything."),
    Setting("claude_skills", "Use skills from ~/.claude/skills", GENERAL, "bool", True, "GEMINI_CODE_CLAUDE_SKILLS",
            help="Their names and descriptions are sent to Gemini at the start of each thread."),
    Setting("auto_approve", "Auto-approve everything", GENERAL, "bool", False, "GEMINI_CODE_AUTO_APPROVE",
            help="Writes, shell commands and network requests run WITHOUT asking. Leave off until you trust it.",
            off=None),

    Setting("max_turns", "Max turns per task", LIMITS, "int", 60, "GEMINI_CODE_MAX_TURNS", minimum=1),
    Setting("stall_turns", "Failing turns before changing approach", LIMITS, "int", 8, "GEMINI_CODE_STALL_TURNS", minimum=2),
    Setting("repeat_failures", "Identical failures before changing approach", LIMITS, "int", 3,
            "GEMINI_CODE_REPEAT_FAILURES", minimum=2),
    Setting("idle_nudges", "Nudges when a task ends with no tool call", LIMITS, "int", 1, "GEMINI_CODE_IDLE_NUDGES",
            help="Set to 0 if you mostly ask questions rather than give tasks."),
    Setting("continue_nudges", "Nudges when a reply is only a progress report", LIMITS, "int", 3,
            "GEMINI_CODE_CONTINUE_NUDGES"),
    Setting("drift_nudges", "Nudges when a reply abandons the tool protocol", LIMITS, "int", 3, "GEMINI_CODE_DRIFT_NUDGES"),
    Setting("reminder_turns", "Restate the tool protocol every N turns", LIMITS, "int", 5, "GEMINI_CODE_REMINDER_TURNS"),
    Setting("turn_retries", "Re-sends before a turn fails", LIMITS, "int", 2, "GEMINI_CODE_TURN_RETRIES"),
    Setting("explore_nudge_turns", "Read-only calls before asking it to act", LIMITS, "int", 20,
            "GEMINI_CODE_EXPLORE_NUDGE_TURNS", help="0 turns the nudge off."),
    Setting("compact_turns", "Exchanges per thread before a handoff reset", LIMITS, "int", 40, "GEMINI_CODE_COMPACT_TURNS",
            help="0 never resets the thread."),
    Setting("task_timeout_min", "Stop a task after (minutes)", LIMITS, "int", 0, "GEMINI_CODE_TASK_TIMEOUT_MIN",
            help="0 means no limit; the turn limit still applies."),

    Setting("max_workers", "Parallel worker tabs", WORKERS, "int", 3, "GEMINI_CODE_MAX_WORKERS", minimum=1, maximum=16),
    Setting("worker_retries", "Retries for a failed worker", WORKERS, "int", 1, "GEMINI_CODE_WORKER_RETRIES"),
    Setting("max_report_chars", "Cap on a worker's report (characters)", WORKERS, "int", 2000,
            "GEMINI_CODE_MAX_REPORT_CHARS", minimum=200),
    Setting("worker_stagger", "Gap between opening tabs (ms)", WORKERS, "int", 750, "GEMINI_CODE_WORKER_STAGGER_MS"),

    Setting("response_timeout", "Wait for a reply (ms)", TIMEOUTS, "int", 300_000, "GEMINI_CODE_RESPONSE_TIMEOUT_MS", minimum=1000),
    Setting("upload_timeout", "Wait for an upload (ms)", TIMEOUTS, "int", 120_000, "GEMINI_CODE_UPLOAD_TIMEOUT_MS", minimum=1000),
    Setting("shell_timeout", "Wait for Gemini to load (ms)", TIMEOUTS, "int", 60_000, "GEMINI_CODE_SHELL_TIMEOUT_MS", minimum=1000),
    Setting("bash_timeout", "Foreground command timeout (ms)", TIMEOUTS, "int", 60_000, "GEMINI_CODE_BASH_TIMEOUT_MS", minimum=1000),
    Setting("mcp_timeout", "MCP tool call timeout (ms)", TIMEOUTS, "int", 60_000, "GEMINI_CODE_MCP_TIMEOUT_MS", minimum=1000),
    Setting("tool_timeout", "Abandon a tool after (ms)", TIMEOUTS, "int", 600_000, "GEMINI_CODE_TOOL_TIMEOUT_MS", minimum=1000),
    Setting("offline_wait", "Wait for the network to return (ms)", TIMEOUTS, "int", 300_000, "GEMINI_CODE_OFFLINE_WAIT_MS"),

    Setting("profile", "Chrome profile folder", BROWSER, "path", "", "GEMINI_CODE_PROFILE",
            help="Holds a live Google session. Empty uses ~/.gemini-code/profile. Never share or commit it."),
    Setting("chrome", "Chrome executable", BROWSER, "path", "", "GEMINI_CODE_CHROME",
            help="Only needed if Chrome isn't in its usual place."),
    Setting("shell", "Shell for commands", BROWSER, "text", "", "GEMINI_CODE_SHELL",
            help="Empty uses Git Bash on Windows, otherwise sh. Example: powershell.exe"),
    Setting("home", "gemini-code folder", BROWSER, "path", "", "GEMINI_CODE_HOME",
            help="Moves the config, profile and logs together. Empty uses ~/.gemini-code."),
    Setting("ascii", "Plain ASCII output", BROWSER, "bool", False, "GEMINI_CODE_ASCII",
            help="For consoles that can't show the agent's symbols.", off=None),
    Setting("prompt_unattended", "Ask even without a terminal", BROWSER, "bool", False, "GEMINI_CODE_PROMPT_UNATTENDED",
            help="Diagnostics: keeps y/N questions on when input is piped.", off=None),
    Setting("debug_input", "Trace terminal input", BROWSER, "bool", False, "GEMINI_CODE_DEBUG_INPUT",
            help="Diagnostics for the terminal REPL.", off=None),
    Setting("search_debug", "Trace code search", BROWSER, "bool", False, "GEMINI_CODE_SEARCH_DEBUG",
            help="Diagnostics: logs which search engine ran.", off=None),

    Setting("api_host", "Address", API, "text", "127.0.0.1", "GEMINI_CODE_API_HOST",
            help="Anything other than localhost also needs an API key, because it exposes your Gemini account."),
    Setting("api_port", "Port", API, "int", 8787, "GEMINI_CODE_API_PORT", minimum=1, maximum=65535),
    Setting("api_tabs", "Parallel tabs", API, "int", 2, "GEMINI_CODE_API_TABS", minimum=1, maximum=8),
    Setting("api_key", "API key", API, "secret", "", "GEMINI_CODE_API_KEY",
            help="Stored unencrypted in ~/.gemini-code/ui-settings.json."),
    Setting("api_queue", "Requests that may wait for a tab", API, "int", 8, "GEMINI_CODE_API_QUEUE", maximum=1000,
            help="More than this get 429 at once."),
    Setting("api_queue_timeout", "Longest wait for a tab (s)", API, "int", 120, "GEMINI_CODE_API_QUEUE_TIMEOUT",
            minimum=1, maximum=3600, help="After this a waiting request gets 503 with Retry-After."),
    Setting("api_remote_images", "Fetch image URLs", API, "bool", True, "GEMINI_CODE_API_REMOTE_IMAGES",
            help="Off: only data: image URLs are accepted.", on="on", off="off"),
    Setting("api_private_images", "Allow images from private addresses", API, "bool", False, "GEMINI_CODE_API_PRIVATE_IMAGES",
            help="Lets callers make this machine fetch from 10.x, localhost and the like. Leave off.", on="on", off=None),
    Setting("api_cors", "Allowed web origins", API, "text", "", "GEMINI_CODE_API_CORS",
            help="Comma-separated. Web pages are refused unless listed here."),
)

BY_KEY = {s.key: s for s in SETTINGS}


class Settings:
    def __init__(self, values: dict[str, Any] | None = None, path: Path = SETTINGS_FILE):
        self.path = path
        self.values = {s.key: s.default for s in SETTINGS}
        # Unknown keys are dropped, so a stale file can't feed in a variable
        # the app no longer knows about.
        self.values.update({k: v for k, v in (values or {}).items() if k in BY_KEY})

    @classmethod
    def load(cls, path: Path = SETTINGS_FILE) -> "Settings":
        try:
            # utf-8-sig: Windows tools save with a BOM, and plain utf-8 reads
            # that as a stray character that json rejects, losing every setting.
            return cls(json.loads(path.read_text(encoding="utf-8-sig")), path)
        except (OSError, ValueError):
            return cls(path=path)

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Replaced in one step, so a crash mid-save can't lose the settings.
        scratch = self.path.with_suffix(".tmp")
        scratch.write_text(json.dumps(self.values, indent=2), encoding="utf-8")
        os.replace(scratch, self.path)

    def __getitem__(self, key: str) -> Any:
        return self.values[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.values[key] = value

    def env(self) -> dict[str, str | None]:
        """Each variable's value for a child process; None means unset it."""
        out: dict[str, str | None] = {}
        for s in SETTINGS:
            if not s.env:
                continue
            value = self.values[s.key]
            if s.kind == "bool":
                value = s.on if value else s.off
            at_default = self.values[s.key] == s.default
            out[s.env] = None if at_default or value in (None, "") else str(value).strip()
        return out
