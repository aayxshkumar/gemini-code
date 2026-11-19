# Engineering notes

The non-obvious failures found while building this, and why the code is shaped
the way it is. Kept because every one of them cost real debugging time, and
several are traps anyone automating a chat web UI will hit.

A Claude-Code-style coding agent that drives the **Gemini web UI** through Playwright,
for orgs that have a Gemini Pro web subscription but no Gemini API/CLI access.

## How it works

- One Playwright-controlled Chrome tab = one Gemini web conversation thread.
  Gemini's own UI keeps the conversation history; this tool never re-sends it.
- Gemini's web UI has no native function-calling, so tool use is faked with a
  ReAct-style prompt loop: Gemini is told about `read_file` / `write_file` /
  `run_bash`, and asked to emit a fenced ` ```tool ` JSON block when it wants
  to use one. This program parses that block, runs the tool **locally**, and
  feeds the result back as the next message in the same thread.
- See [`src/agent/promptTemplate.ts`](src/agent/promptTemplate.ts) for the
  exact contract, and [`src/agent/loop.ts`](src/agent/loop.ts) for the loop.

## Install as a command

```bash
npm install && npm run build && npm link
```

That puts a `gemini-code` binary on your PATH, runnable from any project
directory (it operates on whatever directory you run it in):

```bash
gemini-code open-chrome   # once: opens Chrome for you to sign into by hand
gemini-code login         # verify it's reachable
gemini-code               # start the agent, in any project
gemini-code --help
```

The Chrome profile lives at `~/.gemini-code/profile` so one login serves
every project (an existing `./.gemini-code-profile` still wins, so upgrading
doesn't orphan a session you already signed into; `GEMINI_CODE_PROFILE`
overrides both).

**On a true single-file binary:** not worth it here. Playwright is ~18 MB of
dynamically-required code, which `node --experimental-sea-config`, `pkg` and
friends all choke on, and it would still need a real Chrome on the machine
anyway. A linked npm CLI gives the same ergonomics without the fragility —
it's how Claude Code itself ships.

## Development setup

```bash
npm install
```

### 1. Open Chrome and log in by hand — Playwright never touches this step

Google's sign-in flow detects browsers driven over the DevTools protocol
(which is what Playwright always is, on any Chrome binary) and can refuse
to complete login on them ("this browser or app may not be secure"). That's
a real, intentional Google security control against automated sign-in —
not a bug, and this project does not try to spoof or evade it.

The sanctioned way around this: don't automate the login step at all.

```bash
npm run open-chrome
```

This opens a completely normal, unmodified Google Chrome window (just with
a debug port enabled) using a dedicated profile directory
(`.gemini-code-profile/`, gitignored — separate from your everyday Chrome
profile). Sign in to Gemini by hand in that window, exactly like you always
do. Nothing is automated yet, so Google sees an ordinary human sign-in.

Leave that window open. In another terminal, verify it worked:

```bash
npm run login
```

This attaches to the Chrome window above (via CDP) and just checks you're
signed in — it never launches or drives the login itself.

### 2. Calibrate the selectors

The DOM selectors this driver depends on
([`src/driver/selectors.ts`](src/driver/selectors.ts)) are best-effort
placeholders — Google's markup will differ from what's guessed here, and
will drift over time regardless. Calibrate them with Playwright's own
recorder, reusing the now-authenticated profile:

```bash
# First, quit the Chrome window from `npm run open-chrome` — codegen needs
# exclusive access to the profile directory, and since your session cookie
# is already saved to disk, the browser it opens will already be signed in
# (this is just loading a valid session, not a fresh interactive sign-in,
# so Google's automation check on sign-in doesn't come into play here).
npx playwright codegen --user-data-dir ./.gemini-code-profile https://gemini.google.com/app
```

Click the prompt box, send a message, click the button that appears while
it's generating, and click a finished response bubble. Codegen prints the
selector for each click — copy the right ones into `selectors.ts`. Close
codegen's browser when done.

This is the one step you'll come back to whenever the agent stops working;
everything else in the codebase is selector-agnostic.

### 3. (optional) Run the test suites

```bash
npm test            # parser + tools + full agent loop against a fake driver, no browser needed
npm run test:browser # real headless Chromium hitting gemini.google.com — checks the driver's
                      # app-shell/login detection, but doesn't log in or exercise selectors.ts
```

### 4. Run it

```bash
npm run open-chrome   # if that Chrome window isn't already open/running
npm run dev           # in another terminal — attaches to it
```

You'll get a Claude-Code-style REPL: type a task, watch tool calls stream in
the terminal, get Gemini's final answer. `run_bash` and `write_file` both ask
for a y/N confirmation before acting — set `GEMINI_CODE_AUTO_APPROVE=1` to
skip both (not recommended until you trust the loop).

### Slash commands

```
/model            show the current model
/model <name>     fastest | fast | pro
/thinking on|off  extended thinking (slower, deeper)
/clear            start a fresh conversation thread
/memory           show GEMINI.md
/remember <note>  append a note to GEMINI.md
/tools            list tools available to Gemini
/help             command list
/exit             quit
```

**Model defaults to `fast` (Flash) with extended thinking off.** Override per
session with `GEMINI_CODE_MODEL=pro npm run dev`.

A note on how the picker actually works, since it isn't obvious: the menu
lists `3.5 Flash-Lite`, `3.6 Flash`, `3.1 Pro` and `Extended thinking`, but
that last one is a **toggle** stacked on the base model, not a fourth model —
the picker reads e.g. "Flash Extended" with it on. So it gets its own
`/thinking` command, and `setExtendedThinking()` only clicks when the state
actually needs to change (clicking blindly would flip it the wrong way half
the time). Model matching is keyword-based rather than exact-label, because
Google bumps those version numbers regularly and an exact table would break
on every release.

## Known limitations / things to expect

- **This automates a consumer web UI, not a sanctioned API.** Google's ToS
  generally don't cover scripted use of the Gemini web app the way they
  cover the Gemini API/CLI. Keep this to low-volume internal use on your
  own logged-in session, non-headless, without any stealth/anti-detection
  layer — that's the difference between "automating my own browser" and
  something that looks adversarial to Google.
- **Selector drift.** Any Gemini UI redesign breaks `selectors.ts` first.
  That file is intentionally the only place selectors live.
- **No true context-window control.** The web UI manages history for you,
  but very long threads may get silently summarized/truncated with no
  explicit signal — there's no token-count API to check against.
- **Tool-call reliability.** Prompted tool-calling (no native function
  calling) occasionally produces malformed JSON, prose mixed into the tool
  block, or multiple calls at once. The loop retries once on malformed
  JSON; if Gemini keeps misbehaving, tighten the wording in
  `promptTemplate.ts`.
- **Six tools exist** (`read_file`, `write_file`, `run_bash`, `list_files`,
  `remember`, `fetch_url`). Add more in `src/tools/`, export them from
  `src/tools/index.ts`, and they're automatically documented to Gemini via
  the primer. `run_bash`, `write_file` and `fetch_url` each ask for
  confirmation before acting — `fetch_url` shows the full URL, since an
  outbound request can carry local data off the machine.

## Master / worker architecture

By default the main tab is an **orchestrator**, not a coder:

```
  mode    orchestrator — main tab plans & validates, workers implement
```

- **Main tab**: plans (`update_plan`), splits the job, delegates, then
  **validates** the result — reading a key file, running the build/tests —
  and delegates a **correction round** if something's wrong.
- **Worker tabs**: do the actual implementation, each in its own thread.
- **Workers report summaries, not code.** Their final answer is a short
  report (files changed, decisions, problems), and it's hard-truncated to
  2,000 chars (`GEMINI_CODE_MAX_REPORT_CHARS`) on the way back regardless of
  what the worker does.

Why it's built this way: Gemini's web UI gives no context-window control and
silently truncates long threads. If the main tab writes the code itself, its
thread fills with file contents and diffs and it loses the plot on the actual
product. Pushing implementation into worker threads means the bulk lands in
*their* throwaway context, and the main thread keeps its attention on the
build. The truncation is deliberate belt-and-braces: a worker that ignores
its brief and pastes a whole file still can't flood the orchestrator.

Set `GEMINI_CODE_ORCHESTRATOR=0` for the old single-tab behaviour (better for
small one-off tasks, where delegation is just overhead).

## Parallel workers

The main tab can hand independent subtasks to worker tabs that run at the
same time — the same shape as Claude Code's subagents.

```
› review the three largest source files and summarise each

⏺ delegate_tasks(3 tasks: driver, loop, cli)
  ⎿ delegating 3 tasks across 3 parallel tabs
[driver] opening tab…
[loop]   opening tab…
[cli]    opening tab…
[loop]   ⏺ read_file(src/agent/loop.ts)
[driver] ⏺ read_file(src/driver/GeminiDriver.ts)
...
```

How it works, and why it's built this way:

- **One worker = one tab = one Gemini thread.** Threads are the unit of
  isolation: the web UI keeps history per thread, so workers can't
  contaminate each other's context the way they would sharing a tab.
- **Workers get the same context and tools, minus `delegate_tasks`.** They
  can't spawn their own workers, so delegation can't nest and run away.
  Give each worker a complete, self-contained prompt.
- **Failed workers retry automatically** in a fresh tab
  (`GEMINI_CODE_WORKER_RETRIES`, default 1), and a worker that still fails
  reports that as its result so the orchestrator gets a partial answer
  rather than nothing.
- **Tab creation is staggered** (`GEMINI_CODE_WORKER_STAGGER_MS`, default
  750ms) — opening several at once races Gemini's app shell.
- **Concurrency is capped** (default 3, `GEMINI_CODE_MAX_WORKERS` to change).
  Every worker is a real tab driving a real session on one account, so this
  is the knob that decides how hard you lean on it.
- **A failing worker doesn't sink the others** — its error comes back as that
  subtask's result and the rest finish.
- **Tabs are always closed**, including when a task throws.
- **Confirmation prompts are serialized.** Parallel workers can each want a
  y/N at once; without queueing they'd interleave questions and steal each
  other's keystrokes.

Measured live: 3 trivial subtasks completed in 8.3s total, finishing out of
order — real concurrency, not interleaved sequential work.

## Tab marking

Worker tabs are branded so you can tell at a glance that the agent owns them
and don't close one mid-task:

- **Pinned title** — `🤖 gemini-code · <worker name>` (and `· main` for the
  main tab), re-applied on an interval because Gemini is an SPA that rewrites
  `document.title` as the conversation changes.
- **Distinct favicon** — a purple marker, so agent tabs stand out in a
  crowded tab strip.
- **Close guard on worker tabs** — a `beforeunload` handler, so Chrome asks
  "Leave site?" if you close one by hand. The agent's own `page.close()`
  doesn't run `beforeunload`, so cleanup is unaffected. The main tab
  deliberately has no guard: it's yours, and it navigates.

Chrome tab *groups* would be the natural fit, but they're only reachable
through the `chrome.tabGroups` **extension** API — the DevTools Protocol
exposes nothing for them (verified against Chrome's own `/json/protocol`),
so Playwright cannot create one. The above is the closest equivalent.

## Crash-resumable plan journal

Every task writes a live journal to `GEMINI-PLAN.md` — the task, the model's
checklist (via the `update_plan` tool), and a timestamped log of every tool
call, flushed after each step:

```md
- **Status:** in_progress
- **Task:** create three files: a.txt ... 

## Plan
- [x] Create a.txt containing 'A'
- [ ] Create b.txt containing 'B'

## Progress
- 15:40:01 write_file(a.txt) -> ok: Wrote 1 bytes to a.txt
```

Because it's written as work happens rather than at the end, a file left at
`in_progress` (or `interrupted`, which a Ctrl+C sets) is itself the signal
that work was cut short. The next run detects it, says so in the banner, and
feeds it back as **UNFINISHED WORK** with instructions to check what already
exists and continue from the first incomplete step rather than start over.

`/plan` shows it, `/plan clear` deletes it. It's separate from `GEMINI.md`
on purpose: that file is durable knowledge, this one is state for the task
in flight.

## Steering a running task

Type while a task is running and it's folded into the next turn as a
`USER UPDATE`, ahead of the tool result, so Gemini adjusts its plan instead
of finishing the wrong thing first:

```
› build a REST API
⏺ write_file(src/app.py)
actually make it FastAPI, not Flask          ← typed mid-task
  ⎿ steering: actually make it FastAPI, not Flask
⏺ write_file(src/app.py)
```

Slash commands typed mid-task stay queued and run as commands afterwards.

## Reliability

- **Turn retries** — a failed send/response is retried
  (`GEMINI_CODE_TURN_RETRIES`, default 2) with backoff before the task fails.
- **Generous, tunable timeouts** — responses 300s
  (`GEMINI_CODE_RESPONSE_TIMEOUT_MS`), uploads 120s
  (`GEMINI_CODE_UPLOAD_TIMEOUT_MS`), app shell 60s
  (`GEMINI_CODE_SHELL_TIMEOUT_MS`). A response still streaming is not a
  failure, and Pro / extended thinking can take a while.
- **Upload failures fall back** to pasting a truncated version inline.
- **A failed task doesn't kill the REPL** — the prompt stays alive.

## Context handling

Two things fight the web UI's limits:

Context is split deliberately: the **tool-call rules stay inline** in every
first message (Gemini can't emit a parseable tool call without them, so they
must never depend on it opening an attachment), while the **bulky knowledge
is uploaded as a file** once it outgrows the composer's practical budget.

- **Project docs as initial knowledge.** Every `.md`/`.mdx` in the project
  (README, `docs/`, architecture notes — shallowest first, budget-capped) is
  collected and handed over up front. These usually say more about intent and
  conventions than the source does. `GEMINI.md` is excluded here because it's
  carried separately as durable memory.
- **Project tree.** At session start the CLI builds an ASCII tree
  (`src/context/projectTree.ts`, noise dirs excluded) and puts it in the
  primer, so Gemini knows the layout without burning tool calls on `ls`.
  It can also request one on demand via `list_files`.
- **`GEMINI.md` durable memory.** The web UI's own thread memory dies with
  the conversation and gets silently truncated on long ones. `GEMINI.md`
  (created on first run, never clobbered) is replayed into the primer every
  session, and Gemini can append to it with the `remember` tool. It's a
  normal markdown file — edit it yourself freely.
- **Large outputs are uploaded, not pasted.** The composer has a practical
  text-length limit a real API wouldn't. Tool output over ~4,000 chars is
  written to a temp file and **attached** to the message instead of pasted
  inline (`src/agent/loop.ts`), with the original file extension preserved
  so Gemini parses it as code rather than opaque text.

## Ignore rules and walking the disk

Listing and search use ripgrep, then `git ls-files` / `git grep`, then a
JavaScript walk. The walk used to skip a hard-coded folder list (copied into
three files) and ignore `.gitignore`, so on a machine without rg or git —
a fresh Windows laptop — the agent saw build output and ignored notes.

Now `src/gitignore.ts` implements git's matching (nested files, negation,
the no-re-include-under-an-excluded-folder rule, anchoring, `**`, folder-only
patterns, classes, escapes, trailing spaces, BOM/CRLF, `.git/info/exclude`,
`.git` files), and `src/walk.ts` is the one policy every walk uses on top:
`.git`, `node_modules` and gemini-code's own folders are never entered,
`.env` / `.env.*` are never listed or searched (templates are), and the old
noise list applies only when no ignore rules do. A walk scoped into a folder
that is itself ignored drops the rules, decided by the module rather than
`git check-ignore -q .` (which misread CRLF files with blank lines). Outside
a repository, rules start at the workspace root, never above it. `git grep`
now searches untracked files too.

Tests: unit cases per rule, and a differential test against git — random
trees and .gitignore files from a pool aimed at the hard rules, compared with
`git ls-files --others --exclude-standard` (global and system config off).
150 seeded cases run in `npm test`; `npm run test:gitignore` runs 2,000.
Not read: the global `core.excludesFile` (the git engine still honours it).

## Project layout

```
src/
  driver/
    selectors.ts       <- all DOM selectors (recalibrate here)
    GeminiDriver.ts     <- Playwright automation: attach() (recommended) + launch() (fallback)
    IGeminiDriver.ts    <- the interface the agent loop depends on (fake-able in tests)
  agent/
    promptTemplate.ts   <- the tool-use contract taught to Gemini
    toolCallParser.ts   <- finds {name, args} JSON inside rendered code blocks
    loop.ts             <- the send -> parse -> execute -> repeat loop
  tools/
    readFile.ts / writeFile.ts / bash.ts / confirm.ts / index.ts
  tests/
    smoke.ts            <- parser + tools + agent loop, no browser (npm test)
    browser-smoke.ts    <- real headless Chromium, app-shell/login detection only
    models.ts           <- model aliases (fast/pro/…) + the extended-thinking toggle
  ui/
    format.ts           <- Claude-Code-style terminal output (⏺ / ⎿, colors)
  scripts/
    openChrome.ts        <- launches a normal Chrome window for you to sign into by hand
    login.ts              <- attaches + checks you're signed in
  cli.ts                <- REPL entrypoint: banner, slash commands, agent loop
```

## Test coverage, honestly

Three suites:

```bash
npm test             # 14 tests: parser, tools, agent loop (fake driver), tree + memory. No browser.
npm run test:browser # real headless Chromium: launch/app-shell/logged-out detection.
npm run test:e2e     # REAL Gemini round trip — needs `npm run open-chrome` + you signed in.
```

`npm run test:e2e` is the one that matters most: it sends actual prompts to
your live session and asserts on what comes back — that a prompt round-trips,
that a *second* send in the same thread works, that real Gemini emits a
tool call this codebase can parse, and that prose answers aren't
misread as tool calls. All 4 pass as of the last run.

Running these while building actually caught several real bugs, now fixed:

1. `ensureLoggedIn()` checked for the sign-in button before the Angular app
   had rendered it, so it silently read "not there yet" as "already logged
   in." `launch()` now waits for the app shell (sign-in button or composer)
   to actually appear first.
2. The sign-in selector's `.first()` picked a hidden nav element ahead of
   the real, visible prompt. Fixed with a `>> visible=true` filter.
3. **(Found via a real run, not a test)** The tool-call parser regex-matched
   for a literal ` ```tool ` fence in the extracted response text — but
   Gemini's UI renders markdown to HTML before we read it, so a fence never
   survives as literal backtick characters; only the *content* of the
   resulting rendered code block does. Every tool call was silently being
   treated as a final answer. Fixed by having the driver extract code-block
   text separately (`getLastResponse()` returns `{text, codeBlocks}`) and
   having the parser look for `{name, args}`-shaped JSON inside
   `codeBlocks`, with brace-matched extraction so surrounding UI chrome
   (e.g. Gemini's own "Code snippet" label) doesn't break the parse. See
   `src/agent/toolCallParser.ts` and the regression test in
   `src/tests/smoke.ts`.
4. **(Also found via a real run)** Google's sign-in flow blocked login
   ("this browser or app may not be secure") on `launch()`-driven Chrome —
   this is Google detecting DevTools-protocol-controlled browsers attempting
   an interactive sign-in, a real anti-automation control, not a bug. It is
   *not* fixable by switching Chrome channels (verified: real installed
   Chrome hit it too) and this project will not add anything that spoofs or
   evades that detection. The fix instead avoids triggering it at all:
   `attach()` connects over CDP to a Chrome window you launch and sign into
   completely by hand (`npm run open-chrome`) — confirmed with a throwaway
   instance that `navigator.webdriver` is `false` on an attached page,
   because nothing automated it at launch time. `launch()` is kept only as
   a fallback for post-login use.
5. **Send button timed out on the 2nd message of a session.** Its
   `aria-label`/visibility changes between turns (absent when the composer
   is empty, swapped for stop mid-generation). `sendPrompt()` now types with
   `insertText` and submits with **Enter**, verifying the composer actually
   has text first, with the button click kept only as a fallback.
6. **Duplicate sends / repeated tool execution.** `waitForResponseComplete()`
   could "stabilize" instantly on the *previous* turn's text (already
   static), so the loop re-parsed the old reply and ran its tool call again.
   Fixed by snapshotting the response count at send time and waiting for a
   genuinely new response.
7. **Race after starting a new conversation.** The old thread's responses
   lingered in the DOM long enough to become a stale baseline for (6),
   making the next send appear to hang forever. `newConversation()` now
   waits for responses to actually clear. Caught by `npm run test:e2e`.
8. **Messages starting with a ` ``` ` fence silently never send.** This one
   took real experimentation to pin down. Measured against the live UI:

   | message | sends? |
   | --- | --- |
   | single-line | yes |
   | multi-line plain text | yes |
   | **starts with a ` ``` ` fence** | **no** |

   A leading fence flips the composer into code-block mode, where Enter
   inserts a newline instead of submitting — and clicking the send button
   doesn't rescue it either. `formatToolResult()` produced exactly that, so
   every tool result silently failed to send: the agent would run the tool
   correctly, then hang forever waiting for a reply that could never come.
   Fixed by switching tool results to plain `TOOL_RESULT >>> / <<<`
   delimiters, plus a guard in `sendPrompt()` for any message starting with
   a fence.
9. **The "did it send?" check was itself unreliable.** `sendPrompt()` decided
   whether to use its send-button fallback by sampling "is the composer
   empty?" once, right after Enter. The composer can read as *momentarily*
   empty even when the message did not send — so it skipped the fallback
   click, returned as if it had sent, and the loop then hung for the full
   120s waiting for a reply that could never arrive. Now it polls a visible-
   filtered locator (the page has a second, hidden `contenteditable` whose
   empty text was also being mistaken for "cleared"), re-checks after
   clicking the button, and throws a clear diagnostic instead of hanging.
10. **Processes never exited after `attach()`.** `close()` correctly refuses
    to close a browser the user launched — but it also never dropped the CDP
    connection, and that open websocket keeps Node's event loop alive
    forever. Scripts printed their results and then sat there as zombies
    (found one still running hours after its tests passed). `close()` now
    disconnects the CDP client, verified against a throwaway instance that
    it does *not* kill the browser itself. `npm run test:e2e` went from
    hanging indefinitely to exiting in ~54s.
11. **File uploads always timed out.** Gemini creates its
    `<input type="file">` only when the "Upload & tools" menu is opened —
    zero exist before that, so `setInputFiles()` waited for an element that
    could never appear. `attachFile()` now opens the menu first, then
    intercepts the file chooser.
12. **Long attachment filenames broke the upload check** (the chip
    ellipsizes them). Attachments now use short, stable names.
13. **The README broke the login check.** `signInButton` was a bare
    `text=Sign in`, matching that phrase ANYWHERE — including inside the
    conversation, once this project started sending its own README (which
    documents the sign-in step) as context.
14. **Sends failed partway through a session — the same trap, worse.**
    Gemini renders a `More options for <the entire message text>` button per
    message, putting the whole prompt inside that button's `aria-label`. Our
    primer says *"After you **send** a tool call"*, so
    `button[aria-label*="Send" i]` started matching those hidden buttons once
    a few turns were in the thread. They sort earlier in the DOM, `.first()`
    clicked one, nothing sent, and the composer never cleared — which is
    exactly why it looked intermittent and only after several turns.
    Measured live: 3 matches with `*=`, 1 with `^=`. **Every** aria-label
    selector is now anchored with `^=` and filtered to `visible=true`.
11. **File uploads always timed out.** Gemini creates its
    `<input type="file">` elements only when the "Upload & tools" menu is
    opened — there are literally zero in the DOM before that, so
    `setInputFiles()` waited for an element that could never appear.
    `attachFile()` now opens that menu first, then intercepts the file
    chooser (with the now-present input as fallback), and waits for the
    attachment chip before sending. Verified end to end: Gemini read a
    probe file and echoed back its codeword.
12. **Long attachment filenames broke the upload check.** The chip
    ellipsizes them, so matching on a 24-char slice of
    `project-context-<timestamp>.md` never found anything and every upload
    was reported as failed. Attachments now use short, stable names
    (`context.md`, or the source file's basename).
13. **The README broke the login check.** `selectors.signInButton` was a bare
    `text=Sign in`, which matches the phrase ANYWHERE on the page. Once this
    project started sending its own README as context, the README's
    "Sign in to Gemini by hand" instruction appeared in the conversation as a
    `<p>`, and the agent concluded it had been logged out mid-session. Now
    scoped to real controls (`button`/`a`), never conversation text.

Upload failures are also non-fatal now: if an attachment doesn't go through,
the loop pastes a truncated version inline rather than killing the task.

The selectors in `selectors.ts` turned out to work as-is against the live
UI (verified by `npm run test:e2e`), so the codegen calibration in step 2
is only needed if/when Google changes the markup.
