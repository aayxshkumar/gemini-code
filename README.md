# gemini-code

A Claude-Code-style terminal coding agent that runs on the **Gemini web UI**
(**3.8 Thinking** by default), for people who have a Gemini web subscription but
no Gemini API or CLI access.

It drives a real, logged-in Chrome tab with Playwright: your prompt goes into the
composer, Gemini's reply is parsed back out, and any tools it asks for run
**locally on your machine**.

```
✻ gemini-code — Claude-Code-style agent on the Gemini web UI

  cwd     my-project
  model   Thinking (picker: 3.8 Thinking)
  context project tree (41 lines), GEMINI.md, 1 doc (README.md)
  tools   read_file, write_file, edit_file, search_code, git_status, git_diff, run_bash, check_output, kill_process, list_files, remember, fetch_url, web_search, delegate_tasks, update_plan, screenshot_page, read_page, browser_open, browser_do
  workers up to 3 parallel Gemini tabs
  mode    orchestrator — main tab plans & validates, workers implement

› read package.json and tell me the version
⏺ read_file(package.json)
  ⎿ 26 lines (738 B)

The version is 0.1.0.
```

---

## Read this first

- **This automates a consumer web UI, not a sanctioned API.** Google's terms don't
  cover scripted use of the Gemini web app the way they cover the API/CLI. Keep it
  to low-volume personal use on your own logged-in session.
- **It does not bypass anything.** Google blocks sign-in from automated browsers on
  purpose. Rather than defeat that, this tool never automates the login: *you* open
  a normal Chrome window and sign in by hand, and it attaches afterwards (see
  [Why login is manual](#why-login-is-manual)). There is deliberately no stealth,
  fingerprint-spoofing or detection-evasion code here, and please don't add any.
- **It runs shell commands and writes files on your machine.** Every write, shell
  command and network request asks for a y/N first. Read them.
- **Expect selector drift.** It depends on Gemini's DOM. When Google redesigns,
  [`src/driver/selectors.ts`](src/driver/selectors.ts) is the one file to fix.

## Install

Two ways, both ending with a `gemini-code` command on your PATH. Pick the first
unless you want to hack on the source.

**1. One command, nothing to clone** — macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/aayxshkumar/gemini-code/main/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/aayxshkumar/gemini-code/main/install.ps1 | iex
```

The installer checks Node and Chrome, fetches the latest release (or builds from
source if none is published yet), installs to `~/.gemini-code/app`, puts
`gemini-code` on your PATH and runs `gemini-code doctor`. No sudo, no admin rights.

**2. Clone and run the setup script** — for hacking on it, or when you want
`git pull` to update it in place:

```bash
git clone https://github.com/aayxshkumar/gemini-code.git
cd gemini-code
./setup.sh          # Windows: .\setup.ps1
```

`setup.sh` installs dependencies, builds, links `gemini-code` onto your PATH
pointing at the checkout, and runs the doctor. After that, `git pull && npm run build`
updates it.

Then, in any project:

```bash
cd ~/code/my-project
gemini-code
```

The first run opens Chrome and asks you to sign in to Gemini by hand, once. After
that the session is kept in `~/.gemini-code/profile`.

### New machine checklist

1. Install [Node.js 20+](https://nodejs.org) and [Google Chrome](https://google.com/chrome).
2. Run one of the install commands above.
3. `gemini-code doctor` — it tells you exactly what's still missing, if anything.
4. `cd` into a project and run `gemini-code`; sign in when Chrome opens.
5. **Pick your model.** With nothing configured yet, the first start lists what
   *this account's* picker actually offers — e.g. `3.8 Thinking`, `Auto`, `3.1 Pro`
   (locked entries marked) — and asks you to choose by number or name. The choice is
   saved to `~/.gemini-code/config.json`, so it isn't asked again. Any time later:
   `gemini-code --model "3.8 Thinking"`, `gemini-code --choose-model`, `/models` and
   `/model <name>` inside a session, or `gemini-code config set model thinking`.
6. Optional: other defaults with `gemini-code config set <key> <value>` (see [Settings](#settings)).

> Two installer files rather than one because `curl | bash` and `irm | iex` are
> different shells that can't read the same script — Claude Code splits them the
> same way. `irm` fetches a *URL*, so for a script already on disk just run it:
> `bash install.sh` or `.\install.ps1`.

### Requirements

| Requirement | Why | Check |
| --- | --- | --- |
| **macOS, Linux or Windows** | Chrome launching and clipboard paste are implemented per platform | — |
| **Node.js 20+** | ES modules, built-in `fetch` | `node -v` |
| **Google Chrome** | the agent drives a real Chrome | — |
| **A Gemini account** | you sign in once, by hand | — |

On an older Node, [nvm](https://github.com/nvm-sh/nvm) is the quickest fix:
`nvm install 20 && nvm use 20`.

> **No browser download.** Unlike most Playwright projects, this needs no
> `npx playwright install` — it drives the Chrome you already have, and the test
> suites do too. A clean install is ~55 MB.

### Updating

Re-run the installer (it replaces the installed copy), or in a clone:
`git pull && npm run build`.

### Uninstalling

```bash
rm -f ~/.local/bin/gemini-code   # the launcher (installer route)
npm unlink -g gemini-code        # if you installed from source
rm -rf ~/.gemini-code            # app + Chrome profile (this signs you out)
```

On Windows: delete `%USERPROFILE%\.gemini-code` and remove its `bin` folder from
your PATH.

### Where things live

| Path | What | Commit it? |
| --- | --- | --- |
| `~/.gemini-code/app` | the installed program | n/a |
| `~/.gemini-code/profile` | Chrome profile — **holds a live Google session** | **never** |
| `~/.gemini-code/config.json` | your saved defaults (`gemini-code config`) | n/a |
| `<project>/.gemini-code.json` | per-project overrides of the same keys | yes, if useful |
| `<project>/GEMINI.md` | durable project memory | yes, if useful |
| `<project>/GEMINI-PLAN.md` | in-flight task journal | usually not |
| `<project>/.gemini-code-tmp/` | attachments, screenshots, undo snapshots | no |

Add to the `.gitignore` of any project you run it in:

```gitignore
.gemini-code-tmp/
GEMINI-PLAN.md
```

### Using your Gems

If you keep a Gem for a project — its conventions, its architecture, the decisions
you'd otherwise re-explain every session — point gemini-code at it:

```bash
gemini-code --gem "Kite 2"          # by name (a unique part of the name is enough)
gemini-code --gem coding-partner    # or by the id in the Gem's URL
GEMINI_CODE_GEM="Kite 2" gemini-code
```

The Gem is a **reference, not the driver**. The coding conversation stays an ordinary
Gemini thread, and the agent gets one extra tool:

```
ask_gem(question) -> what the Gem says
```

It uses that when it needs background the files can't tell it — how something is
normally done here, why a thing is the way it is, which approach fits. The Gem answers
in its own tab, keeps its history across questions, and never sees your working tree or
runs anything. The tool's description says so plainly, so the agent reads the code for
facts about the code and asks the Gem for the reasoning around it.

That separation is deliberate. A Gem's instructions shape every reply, so running the
whole loop inside one means the Gem is also responsible for following the tool protocol
— and a conversational Gem answers with prose where a tool call was asked for, costing
nudge turns. Consulting it keeps each side doing what it's good at.

If you do want the old behaviour, ask for it:

```bash
gemini-code --gem "Kite 2" --gem-mode inside
```

Mid-session, `/gems` lists the account's Gems, `/gem <name>` points `ask_gem` at one and
`/gem off` stops using it. Both start a fresh thread, since the tool list changes.

Worth knowing:

- **Workers share the one Gem tab.** Questions are queued, so parallel workers can't
  interleave two prompts in the same thread.
- **The tab opens on first use** and closes with the session, so a Gem you never ask
  anything costs nothing.
- **A failed consult isn't fatal** — the agent is told to carry on from the files.
- **An ambiguous name is refused, not guessed.** "Kite" with both "Kite 2 Backend" and
  "Kite 2 Frontend" on the account lists both instead of picking one.
- **In `inside` mode a new thread stays in the Gem.** Gems live in the URL, so the UI's
  own "New chat" would quietly drop out of one; `/clear` re-enters it.

### Troubleshooting

Start with `gemini-code doctor`: it checks Node, Chrome, the profile, your PATH,
the debug port and whether the Gemini session is signed in, and prints the fix
next to anything wrong.

| Symptom | Cause / fix |
| --- | --- |
| `Thinking isn't in this account's model picker — using Auto instead` | Google shows different pickers to different accounts: some have a `3.8 Thinking` model, others `Auto` / `3.1 Pro` / `4 Argon` plus a Thinking level submenu. `thinking` means the Thinking model where there is one, else Auto with Thinking level High. `/models` shows your picker; `/model <label>` selects anything in it, no code change needed |
| `"3.1 Pro" is locked on this account` | That entry needs a paid Gemini plan. Locked entries are never clicked (clicking only opens an upgrade prompt) |
| `command not found: gemini-code` | `~/.local/bin` isn't on your PATH — the installer prints the line to add |
| `Couldn't attach to Chrome on port 9222` | Chrome isn't up: `gemini-code open-chrome`, sign in, retry |
| `Your Gemini session is signed out` | Session expired: `gemini-code login` and sign in |
| "this browser or app may not be secure" | You tried signing in inside an automated browser — use `gemini-code open-chrome`, which opens a normal one |
| Nothing sends / `no new response ever appeared` | Gemini's markup changed; recalibrate [`src/driver/selectors.ts`](src/driver/selectors.ts) |
| Replies but takes no action | Protocol drift in a long thread — `/clear` starts a fresh one |
| Windows: commands fail on `ls`, `rm -rf`, `grep` | No Git Bash found, so they ran in cmd.exe. Install [Git for Windows](https://git-scm.com/download/win) or set `GEMINI_CODE_SHELL` |
| `Couldn't use Gem "..."` | Check the exact name with `/gems` — the id from the Gem's URL works too |
| `edit_file`: "that text isn't in ..." repeatedly | Fixed in 0.6.2 — CRLF files could never match. The error now shows the nearest real lines |
| Replies look like normal chat, no tools used | Usually the primer never sent. Update to 0.6.1+; if it persists, `/clear` and retry — the agent now also nudges itself when a task ends with no tool call |
| `serve`: "Refusing to listen on ... without an API key" | You set `--host` to a network address. Add `--api-key`, or keep the default `127.0.0.1` |
| API returns 403 "Origin ... is not allowed" | A browser app is calling it. Start with `--cors-origin <that app's URL>` |
| `Ctrl+V` does nothing | Your terminal keeps Ctrl+V for its own paste (usual on Windows Terminal and some Linux setups). Type `/paste` instead — same thing |

### Why there's no single-file binary

Tried it; it doesn't hold up. Playwright reads its own files at runtime — its
`package.json`, the browser registry, `launchApp` — so bundling it into one
executable fails with a different `MODULE_NOT_FOUND` each time you patch the last
one. A binary built that way would break in ways users couldn't diagnose, and again
on every Playwright upgrade.

The installer and the release tarball (`npm run package`, ~4 MB) are the honest
version of the same idea: one command, no build. They need Node on the machine,
which is a small ask next to Chrome, which is needed anyway.

## Versioning

Semantic versioning, reported by `gemini-code --version`.

| Version | Highlights |
| --- | --- |
| **0.9.0** | **Built for big, multi-repo codebases.** `--add-dir` workspace roots (read, search, edit and run commands in dependency repos); read-before-edit and changed-on-disk gates; edits echo the changed region; `find_files`; ripgrep/git-grep search with a `path` scope; "did you mean" on wrong paths; answers are checked for paths that don't exist; Gemini's own error replies are retried; AGENTS.md / CLAUDE.md honoured as instructions; auto-compaction with a handoff note (`/compact`); `autoApprove=edits` |
| **0.8.0** | **Model choice is yours at startup**: a live chooser on first run, `--model`, `/models`, picker labels like `3.8 Thinking` work directly; `thinking` is the default (the Thinking model where offered, else Auto with Thinking level High); locked models are skipped; several tool calls per reply; lenient tool-call JSON; `gemini-code doctor`, `gemini-code config` and a persistent config file; `setup.sh`/`setup.ps1` for clones; CI and tagged releases |
| **0.4.1** | Windows: commands run in the same console with output captured, Git Bash preferred over cmd, process trees killed properly |
| **0.4.0** | command output saved to searchable logs; errors surfaced from anywhere in a long build |
| **0.3.1** | stops the loop ending on a progress report; continuation nudging from the plan |
| **0.3.0** | `web_search`, verified interactive browsing (click / back / type+submit / JS buttons) |
| **0.2.1** | fixes confirmation prompts double-echoing and leaking answers into the task queue; cross-platform build fix |
| **0.2.0** | interactive browsing, image input, file-editing tools, parallel workers, orchestrator mode, plan journal, `/undo`, cross-platform installers |
| **0.1.0** | first working agent loop: prompted tool calls, read/write/bash, context and memory |

Because this drives a UI nobody versions for us, **patch releases are mostly
selector repairs**. If it suddenly stops sending or reading replies, update before
debugging.

## Use

Just run it:

```bash
cd ~/code/my-project
gemini-code
```

It starts Chrome itself if one isn't already running (a dedicated profile at
`~/.gemini-code/profile`, separate from your everyday browsing), attaches, and goes.

**The one manual step is signing in** — and only when you're actually signed out.
The profile keeps the session, so that's typically once, not once per run. When it
happens, the agent detects it, brings the Chrome window to the front, and waits
while you sign in, then carries on by itself. In a non-interactive shell it fails
immediately with instructions instead of blocking, since there's nobody there to
sign in.

Why signing in stays manual: Google deliberately blocks sign-in from
automation-driven browsers, and this project doesn't try to defeat that (see
[Why login is manual](#why-login-is-manual)). Nothing here ever touches your
credentials.

`gemini-code open-chrome` and `gemini-code login` still exist if you'd rather do
those steps explicitly.

Type a task. `/help` lists commands. `exit` quits.

### Commands

| Command | What it does |
| --- | --- |
| `/model` | show current model |
| `/models` | list the models in this account's picker, live, with locked ones marked |
| `/model <name>` | switch model: an alias (`thinking`, `auto`, `fast`, `fastest`, `pro`, `argon`), a number from `/models`, or a picker label such as `3.8 Thinking` |
| `/level low\|medium\|high` | the picker's Thinking level (default `high`; the account default is Low) |
| `/thinking on\|off` | the Extended thinking toggle, on pickers that have one |
| `/undo` | revert all file changes from the last task |
| `/plan`, `/plan clear` | show / delete the progress journal |
| `/memory`, `/remember <note>` | show / append durable project memory |
| `/roots`, `/add-dir <path>` | show the workspace roots / add another repository mid-session |
| `/compact` | close the thread and continue in a fresh one from a handoff note the model writes for itself |
| `/clear` | start a fresh Gemini thread |
| `/gems` | list the Gems on your account |
| `/gem <name>`, `/gem off` | consult a Gem for project knowledge, or stop using one |
| `Ctrl+V` or `/paste` | attach an image from the clipboard (macOS, Windows, Linux) |
| `/image <path>` | attach an image file — or just drag one into the terminal |
| `/tools` | list tools available to Gemini |
| `/exit` | quit |

Typing **while a task runs** steers it — your text is folded into the next turn as a
`USER UPDATE`, so you can redirect mid-flight instead of waiting.

### Settings

Every setting can be an environment variable, a key in `~/.gemini-code/config.json`
(managed by `gemini-code config set <key> <value>`), or a key in a project's
`.gemini-code.json`. Environment wins over project file, which wins over the user file.

```bash
gemini-code config                     # what's in effect, and where each value comes from
gemini-code config set model pro       # saved to ~/.gemini-code/config.json
gemini-code config set workers 2
gemini-code config set autoApprove true
gemini-code config unset model
```

Friendly keys: `model`, `thinkingLevel`, `thinking`, `addDirs`, `compactTurns`, `workers`, `orchestrator`, `autoApprove`, `maxTurns`,
`shell`, `chrome`, `profile`, `gem`, `responseTimeoutMs`, `apiPort`, `apiKey` — or any
raw `GEMINI_CODE_*` name from the table.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GEMINI_CODE_MODEL` | `thinking` | an alias (`thinking` \| `auto` \| `fast` \| `fastest` \| `pro` \| `argon`) or a picker label (`"3.8 Thinking"`). Unset on an interactive first start → the chooser asks |
| `GEMINI_CODE_THINKING_LEVEL` | `high` | `low` \| `medium` \| `high` — the picker's Thinking level submenu |
| `GEMINI_CODE_THINKING` | `off` | `on` turns on the Extended thinking toggle, on pickers that have one |
| `GEMINI_CODE_CHROME` | auto-detected | path to the Chrome executable |
| `GEMINI_CODE_GEM` | unset | Gem to consult, by name or id (same as `--gem`) |
| `GEMINI_CODE_GEM_MODE` | `reference` | `inside` runs the whole session in the Gem |
| `GEMINI_CODE_ORCHESTRATOR` | `1` | `0` = one tab does everything |
| `GEMINI_CODE_MAX_WORKERS` | `3` | parallel worker tabs |
| `GEMINI_CODE_ADD_DIRS` | unset | extra workspace roots, PATH-style separated (same as `--add-dir`; config key `addDirs` takes a list) |
| `GEMINI_CODE_AUTO_APPROVE` | unset | `edits` runs file writes/edits without asking (commands and requests still ask); `edits,commands` also runs commands; `1`/`all` skips everything |
| `GEMINI_CODE_COMPACT_TURNS` | `40` | exchanges per thread before the thread is closed and continued fresh from a handoff note; `0` disables |
| `GEMINI_CODE_IDLE_NUDGES` | `1` | times to push back on a task that ends with no tool call |
| `GEMINI_CODE_MAX_TURNS` | `60` | tool-call turns one task may take |
| `GEMINI_CODE_STALL_TURNS` | `8` | failing turns before it's told to change approach |
| `GEMINI_CODE_REPEAT_FAILURES` | `3` | identical failures before the same |
| `GEMINI_CODE_PROFILE` | `~/.gemini-code/profile` | Chrome profile dir |
| `GEMINI_CODE_RESPONSE_TIMEOUT_MS` | `300000` | how long to wait for a reply |
| `GEMINI_CODE_TURN_RETRIES` | `2` | re-sends before a turn fails |
| `GEMINI_CODE_WORKER_RETRIES` | `1` | worker retries in a fresh tab |
| `GEMINI_CODE_MAX_REPORT_CHARS` | `2000` | cap on what a worker reports back |
| `GEMINI_CODE_REMINDER_TURNS` | `5` | how often the tool-call contract is restated |
| `GEMINI_CODE_DRIFT_NUDGES` | `2` | nudges when a reply abandons the protocol |
| `GEMINI_CODE_BASH_TIMEOUT_MS` | `60000` | foreground command timeout |
| `GEMINI_CODE_SHELL` | Git Bash on Windows, else `sh` | shell commands run in (e.g. `powershell.exe`) |

## Use it as an OpenAI-compatible API

`gemini-code serve` puts an OpenAI-style HTTP API in front of your signed-in Gemini
session, so any app, script or SDK that lets you set a base URL can use it — no code
changes beyond that:

```bash
gemini-code serve                 # http://127.0.0.1:8787/v1
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="anything")
r = client.chat.completions.create(
    model="gemini-web-thinking",
    messages=[{"role": "user", "content": "Explain CORS in two sentences."}],
)
print(r.choices[0].message.content)
```

```ts
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://127.0.0.1:8787/v1", apiKey: "anything" });
```

```bash
curl http://127.0.0.1:8787/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"gemini-web-thinking","messages":[{"role":"user","content":"Hello"}]}'
```

**What's supported** (all tested with the official OpenAI Python SDK against a live
session):

| Feature | Notes |
| --- | --- |
| `GET /v1/models` | `gemini-web-thinking` (default), `gemini-web-flash`, `gemini-web-pro`, `gemini-web-flash-lite` |
| `POST /v1/chat/completions` | system, user, assistant and tool messages |
| Streaming (`stream: true`) | server-sent events ending in `[DONE]`; `stream_options.include_usage` works |
| Function calling (`tools`) | returns real `tool_calls` with `finish_reason: "tool_calls"`; `tool_choice` `auto` / `required` / a named function / `none` |
| Images | `image_url` parts, as `data:` URLs or `http(s)` URLs |
| Markdown output | code fences with their language, headings, lists and tables, rebuilt from the rendered reply |

Model names are lenient: `gemini-2.5-pro` picks Pro, anything with `thinking` picks
3.8 Thinking, anything with `lite` picks Flash-Lite, and names it doesn't know (a
hard-coded `gpt-4o`, say) get the default rather than an error.

**How a stateless API maps onto a stateful chat.** Every API request carries the whole
conversation; a Gemini tab remembers its own thread. When a request is exactly an
earlier one plus new turns — how chat clients and agent loops normally work — it
**continues that tab's thread** and sends only the new turn, which is faster and keeps
Gemini's own context. Anything else starts a fresh thread with the conversation folded
into one prompt.

**Concurrency.** Each request gets its own tab (`--tabs`, default 2, max 8); requests
beyond that wait in line. Tabs open on demand.

| Flag | Env | Default |
| --- | --- | --- |
| `--port` | `GEMINI_CODE_API_PORT` | `8787` |
| `--host` | `GEMINI_CODE_API_HOST` | `127.0.0.1` |
| `--tabs` | `GEMINI_CODE_API_TABS` | `2` |
| `--api-key` | `GEMINI_CODE_API_KEY` | none |
| `--cors-origin` (repeatable) | `GEMINI_CODE_API_CORS` (comma-separated) | none |

**Security** — this exposes your Gemini account, so the defaults are strict:

- It listens on **localhost only**. Binding to any other address is refused unless an
  API key is set, since otherwise anyone who could reach the port could use your account.
- With `--api-key`, every request needs `Authorization: Bearer <key>`.
- **Requests from web pages are refused** unless you allow that page's origin with
  `--cors-origin`. A site you happen to visit could otherwise send requests to
  localhost and use the account. Requests must also be `application/json`, which makes
  browsers ask permission (a preflight) first.

**Limits worth knowing:** `usage` token counts are estimates (the web UI reports none);
streaming arrives in bursts rather than token by token, because it's read off the page
as Gemini renders it; and latency is that of the web UI — a few seconds for a short
answer. It's your personal Gemini session, so keep it for your own tools rather than
putting it behind a public service.

## How it works

### Tool use without function-calling

The web UI has no function-calling API, so tool use is prompted: Gemini is told to
emit a JSON code block, and this program parses it, runs the tool locally, and sends
the result back as the next message in the same thread. Gemini's own UI keeps the
conversation history — this tool never replays it.

A reply may carry **several independent tool calls** — one code block each, or a
JSON array in one block. They run in order and every result comes back in one
message, headed `[i/N]`, so reading three files costs one trip through the web UI
instead of three. The primer tells Gemini to batch reads and searches that don't
depend on each other, and never a call whose arguments depend on an earlier result.
The parser also repairs the JSON models most often get slightly wrong (a trailing
comma, a `//` comment, `tool`/`function` instead of `name`), instead of bouncing
the turn back for a retry.

One subtlety worth knowing: the UI renders markdown to HTML before we can read it,
so a ` ``` ` fence never survives as literal backticks — only the *content* of the
rendered code block does. Tool-call detection therefore looks for `{name, args}`
JSON inside rendered code blocks, not for fence characters.

### Master / worker

By default the main tab is an **orchestrator**, not a coder. It plans
(`update_plan`), delegates implementation to parallel worker tabs
(`delegate_tasks`), then **validates** the result — reading a key file, running the
build — and delegates a correction round if something's wrong.

This exists to protect the main thread's context. The web UI gives no
context-window control and silently truncates long threads, so if the main tab
writes the code itself its thread fills with file contents and it loses the plot on
the actual product. Workers return **short reports**, hard-truncated on the way back
so a worker that ignores its brief still can't flood the orchestrator. Workers can't
delegate further, so it can't nest.

Set `GEMINI_CODE_ORCHESTRATOR=0` for small one-off tasks where delegation is just
overhead.

### Images and screenshots

Gemini can see things, two ways:

- **You give it an image** — press **Ctrl+V** (not Cmd+V) to attach whatever
  screenshot is on your clipboard; `/paste` does the same, `/image <path>` takes a
  file, and dragging a file into the terminal works too.

  It has to be **Ctrl+V**: macOS terminals handle Cmd+V themselves and deliver only
  clipboard *text* to the process, so an image paste arrives as nothing at all and
  there's no keystroke to hook. Ctrl+V does reach the program, so that's the
  binding — same reason Claude Code uses it.

  If your terminal claims Ctrl+V for its own paste (Windows Terminal does, and so do
  some Linux setups), `/paste` does exactly the same thing.
- **It searches** — `web_search` returns titles, URLs and snippets (DuckDuckGo's
  HTML endpoint: no API key, and not Google, which blocks automated requests).
  For a package's current version, fetching the registry directly is more
  reliable, and the tool description says so.
- **It browses interactively** — `browser_open` opens a live tab and returns the
  page text *plus a numbered list of its buttons, links and inputs*;
  `browser_do` clicks them, types into them, submits, scrolls, goes back or
  screenshots. The page stays open between calls, so it can click → look → type →
  click again, the way a person does. Refs are numbered rather than CSS selectors
  because asking a model to invent `div.css-1x7f2 > button:nth-child(3)` from a
  text dump is guesswork that silently clicks the wrong thing.

  Approval is **per origin**: this tab shares the browser's signed-in session, so
  approving `example.com` must not silently authorise a hop to `mail.google.com`.
  Each new origin is confirmed on arrival, and an action that navigates somewhere
  unapproved is reversed.
- **It takes its own** — the `screenshot_page` tool opens a URL in a throwaway tab
  of the same browser, captures it (optionally `fullPage`, or one `selector`), and
  attaches the image to its next message. It works against localhost dev servers,
  so the agent can look at the page it just built instead of reasoning about the
  HTML blind. Confirmed per-URL, because the page loads with your session cookies.

Files you supply are never deleted after sending; only images the agent generated
in its own temp directory are cleaned up.

### Big codebases and cross-repo work

A real codebase is rarely one directory. Point the agent at every repository
the task touches:

```bash
cd ~/src/checkout-service
gemini-code --add-dir ../shared-lib --add-dir ../platform-sdk
```

or commit it per project in `.gemini-code.json`:

```json
{ "addDirs": ["../shared-lib", "../platform-sdk"] }
```

Every root is a place the agent can read, search, edit and run commands —
`read_file("../shared-lib/src/money.js")`, `search_code` with `path: "../shared-lib"`,
`run_bash` with `cwd: "../shared-lib"`, `git_diff` with `cwd` — and nowhere else
is reachable, same as before. The primer carries a shallow tree of each extra
root plus its README and `AGENTS.md`, and tells the model to read a
dependency's real code rather than assume its API. In a live run against an
app whose test failed because of a rounding bug in a sibling library, the
agent found the cause in the library, fixed it there (as the app's `AGENTS.md`
required), added a regression test beside it, and verified both repos' suites.

What keeps it honest at scale, borrowed from Claude Code, OpenCode and Codex:

- **Read before you edit.** `edit_file` and `write_file` refuse a file the model
  hasn't read in this thread, and refuse one that changed on disk since (another
  worker, a build step, you). The model is told exactly what to do instead. This
  is the single biggest defence against "old_text from memory" and files silently
  rewritten from a stale picture.
- **Edits echo the result.** Every successful edit returns the changed region with
  a few lines of context, so a misplaced edit is visible immediately.
- **Find, don't guess.** `find_files` (glob) and `search_code` run on ripgrep or
  `git grep` where available, honour `.gitignore`, and take a `path` scope — a
  subdirectory, another root, or a vendored tree such as `node_modules/some-dep`
  (ignore rules are dropped when the scope itself is ignored). A `read_file` on a
  path that doesn't exist answers with the closest real paths.
- **Answers are checked.** A final answer that cites a file which doesn't exist
  anywhere in the workspace is sent back once with the list of missing paths, and
  the model is told to locate the real ones or say it couldn't. Hedged answers
  ("probably in config.ts", "let's look at…") count as unfinished and are pushed
  to go and look. Verified live on the Vite monorepo: the first reply hedged, was
  pushed back, and the final one cited the right default and enforcement lines.
- **Gemini's own errors are retried.** "I encountered an error doing what you
  asked" is the web UI failing, not an answer; the turn is re-sent.
- **Project instructions are rules.** `AGENTS.md`, `CLAUDE.md`, `.cursorrules`,
  `.github/copilot-instructions.md` and `CONTRIBUTING.md` are sent first, marked as
  instructions that take precedence, and never cut by the context budget. Other
  docs are capped and ranked (README and architecture notes before changelogs
  and blog posts).
- **Long tasks don't rot.** After `GEMINI_CODE_COMPACT_TURNS` exchanges (default
  40) the model writes a handoff note — task, done, remaining, facts learned,
  open problems — and the work continues in a fresh thread with that note and
  the open plan steps. `/compact` does it on demand. The new thread has read
  nothing, so the edit gate makes it re-read before it changes anything.
- **Approve by kind.** `autoApprove=edits` is the practical setting on a real
  project: edits run (reviewable with `git_diff`, reversible with `/undo`) while
  shell commands and network requests still ask.

### Protocol drift in long threads

Prompted tool-calling degrades as a thread grows: the primer falls out of a context
the web UI truncates without telling anyone, and Gemini reverts to chatting —
"Sure, I'll create that file:" followed by the contents in a code block, with no
tool call. To a parser that's indistinguishable from a finished answer, so the task
would end having done nothing, which looks like the app ignoring the reply.

A second failure looks similar but isn't drift: the model follows the protocol
correctly and simply **stops early**, answering with a progress report — *"the
migration is underway…"* — which has no tool call, so the loop treats it as
finished and the work ends half-done. Two signals catch it: **plan steps it
recorded but never ticked off** (the strongest evidence), and language describing
work still in flight. Either pushes it to carry on
(`GEMINI_CODE_CONTINUE_NUDGES`, default 3). Completion wording still ends the
task normally.

For drift proper, the tool-call contract is **restated every few turns**
(`GEMINI_CODE_REMINDER_TURNS`), and a reply that pasted code while *announcing* an
action gets **nudged back** to the protocol (`GEMINI_CODE_DRIFT_NUDGES`, default 2)
rather than accepted. The nudges are capped so a genuine answer that happens to
quote code can't cause a loop.

If a session has gone very long and quality is dropping, `/clear` starts a fresh
thread — the plan journal carries the work forward.

### Long-running commands

`npm run dev` and friends never exit, so running one in the foreground would block
the agent until a timeout, then kill the server anyway. Those are detected and
**started in the background** instead, returning a handle immediately:

```
⏺ run_bash(npm run dev)
  ⎿ Started in the background as "bg_mu1kcjgg"
⏺ check_output(id: bg_mu1kcjgg)
⏺ kill_process(id: bg_mu1kcjgg)
  ⎿ Stopped "bg_mu1kcjgg" and its children.
```

**Every command's output is saved to a log**, foreground ones included, and the
result reports its id. That matters for builds: a failing `npm run build` can emit
thousands of lines with the error in the *middle*, so returning a tail throws away
the part that explains the failure. On a non-zero exit the error lines are pulled
out and shown wherever they appear:

```
Exit code 1
Error lines found in the output:
  line 1501: ERROR in src/components/Customer.vue:42  Cannot find name 'defineProps'

[3003 lines total, saved as "fg_mu2y6diu" — search it with
 check_output {"id": "fg_mu2y6diu", "grep": "error"} rather than re-running]
```

`check_output` then greps that log with surrounding context, so the agent finds
the cause without paging through the whole thing or re-running the build.

Set `background: true` explicitly for anything else that doesn't return.
Everything is spawned in its own **process group**, so killing takes the whole tree
down — otherwise `npm run dev` orphans the node server, which keeps holding its
port after the agent is gone. Anything still running is stopped when the CLI exits.

### Working in real code

The composer budget is the binding constraint, so the file tools are built to move
as little text through the thread as possible:

- **`edit_file`** replaces an exact piece of text, leaving the rest alone. Changing
  a constant in a 600-line file costs a few hundred bytes instead of regenerating
  6 KB — and regeneration silently loses anything the model doesn't reproduce
  exactly. An ambiguous match is **refused**, never guessed, so it can't quietly
  edit the wrong line.
- **`search_code`** finds things by regex (`file:line`) without reading files.
- **`read_file`** takes `offset`/`limit` and windows large files rather than
  dumping them. It returns text **verbatim, without line numbers** — deliberately,
  because the model copies from it straight into `edit_file`, and a `42 ` prefix
  would make every edit fail to match.
- **`git_status` / `git_diff`** let it review what it actually changed before
  calling a task done. Read-only, so no confirmation.
- **`/undo`** reverts every file change from the last task — restoring what was
  overwritten and deleting what was created. Snapshots are taken before each
  write, grouped per task, which matters most with `GEMINI_CODE_AUTO_APPROVE=1`
  where nobody is eyeballing each edit. Repeated edits to one file in a task
  still restore the *pre-task* version, not an intermediate one.

A real run against a 600-line file: `search_code` → `read_file` (9 lines) →
`edit_file` (1 replacement), with all 199 functions intact.

### Context

- **Project tree** — built at startup so Gemini knows the layout without spending
  tool calls on `ls`.
- **Project docs** — every `.md` in the project (README, `docs/`) as initial
  knowledge about intent and conventions.
- **`GEMINI.md`** — durable memory replayed every session; Gemini appends to it via
  the `remember` tool.
- The tool-call rules always go **inline** (Gemini can't emit a valid call without
  them). Bulky knowledge is **uploaded as a file** when it outgrows the composer, as
  is any tool output over ~4,000 chars.

### Crash-resumable plan journal

Every task writes `GEMINI-PLAN.md` as it goes — the task, the model's checklist, and
a timestamped log of every tool call, flushed after each step:

```md
- **Status:** in_progress
## Plan
- [x] Create src/add.py
- [ ] Create src/sub.py
## Progress
- 15:40:01 write_file(src/add.py) -> ok
```

Because it's written during the work rather than at the end, a file left
`in_progress` (or `interrupted`, which Ctrl+C sets) is itself the signal that work
was cut short. The next run detects it and continues from the first incomplete step
instead of starting over.

### Why login is manual

Google's sign-in flow detects browsers driven over the DevTools protocol — which is
what Playwright always is, on any Chrome binary — and refuses to complete login on
them. That's an intentional anti-automation control, and this project does not try
to defeat it.

Instead `open-chrome` launches an ordinary Chrome window that you sign into by hand,
and the agent **attaches** to it afterwards over CDP. Verified: `navigator.webdriver`
is `false` on the attached page, because nothing automated it at launch time. Only
the security-sensitive step stays human.

### Tab marking

Worker tabs get a pinned title (`🤖 gemini-code · <name>`), a distinct favicon, and a
`beforeunload` guard so Chrome asks before you close one mid-task. Chrome tab
*groups* would be ideal but are only reachable from the `chrome.tabGroups`
**extension** API — the DevTools Protocol exposes nothing for them.

## Safety model

`write_file`, `run_bash`, `fetch_url` and `screenshot_page` each require a y/N confirmation showing
exactly what will happen (`fetch_url` shows the full URL, since a request can carry
local data off the machine). Prompts are serialized so parallel workers can't
interleave them. File tools refuse paths outside the project root.
`GEMINI_CODE_AUTO_APPROVE=1` disables all of this — don't, until you trust it.

Your Chrome profile (`~/.gemini-code/profile`) holds a live Google session. Treat it
like a password: never commit it, never copy it around. It's gitignored here.

## Development

```bash
./setup.sh           # clone -> on your PATH, pointing at this checkout
npm test             # 106 tests: parser, tools, loop, workers, plan, context, API
npm run test:browser # headless Chromium: launch, logged-out detection, interactive browsing
npm run test:e2e     # REAL Gemini round trip (needs open-chrome + sign-in)
npm run dev          # run from source without building
```

```
src/
  driver/     Playwright automation (selectors.ts is the DOM-coupled file)
  agent/      prompt contract, tool-call parsing, the agent loop, worker pool
  tools/      read/edit/write/find/search/git/bash/fetch/browse/remember/update_plan (+ fileState: read-before-edit)
  workspace.ts  the roots the agent may touch (project + --add-dir)
  agent/citations.ts  checks the paths a final answer cites
  context/    project tree, docs, GEMINI.md memory, plan journal
  server/     the OpenAI-compatible API
  scripts/    open-chrome, login, doctor, config subcommands
  ui/         terminal formatting
  config.ts   ~/.gemini-code/config.json and <project>/.gemini-code.json -> env
  cli.ts      REPL, slash commands, orchestrator wiring
```

The non-obvious failures found while building this — the ones that cost real
debugging time, several of them traps anyone automating a chat web UI will hit — are
written up in [`docs/engineering-notes.md`](docs/engineering-notes.md).

## Licence

MIT
