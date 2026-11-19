"""Speaks the bridge protocol with no browser, so the UI can be tested alone.

Started by test_app.py in place of `gemini-code bridge`. What a task does
depends on a word in its text, so each test can pick its own path.
"""
import json
import sys

ANSWER = """Here's the **result**.

| File | Lines |
| --- | --- |
| a.py | 10 |

```python
def hello():
    return "hi"
```

And [a link](https://example.com)."""

plan = None
memory = "# Project memory\n\n- uses pnpm"

# Deliberately not the models of any real account: the app must show whatever
# it's told. "Test Lite" also proves the list can change between reads.
models = [
    {"name": "Auto", "description": "Gemini 3 models", "selected": True, "locked": False},
    {"name": "Test Fast", "description": "A model only this test has", "selected": False, "locked": False},
    {"name": "4 Argon", "description": "Complex tasks", "selected": False, "locked": True},
]
thinking = [
    {"name": "Low", "description": "Quick and efficient", "selected": True},
    {"name": "Medium", "description": "Balanced depth", "selected": False},
    {"name": "High", "description": "Extra thorough", "selected": False},
]
reads = 0
installed_skills = []
mcp_servers = [
    {"name": "files", "source": "project", "state": "connected", "tools": ["mcp__files__read", "mcp__files__write"]},
    {"name": "broken", "source": "project", "state": "failed", "tools": [], "error": "command not found <b>"},
]


def menu():
    global reads
    reads += 1
    extra = []
    if reads > 1:
        extra = [{"name": "Test Lite", "description": "Appeared later", "selected": False, "locked": False}]
    return {"models": models + extra, "thinking": thinking, "current": "Gemini Auto"}


def select(rows, name):
    match = next((row for row in rows if row["name"].lower() == name.lower()), None)
    if match:
        for row in rows:
            row["selected"] = row is match
    return match


def emit(**event):
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def activity(kind, text, **extra):
    emit(type="activity", kind=kind, text=text, **extra)


def finish(status="done", answer=ANSWER, **extra):
    if answer:
        emit(type="answer", text=answer)
    emit(type="task_end", status=status, **extra)


def start_task(text):
    emit(type="task_start", text=text)
    if "write" in text:
        activity("tool", "write_file(notes.txt)")
        emit(type="confirm", id=1, label="Allow write_file?", detail="notes.txt\nhello")
        return "confirm"
    if "choose" in text:
        activity("tool", "ask_user(question: Which database?)")
        emit(type="question", id=1, question="Which database?", options=["Postgres", "SQLite"])
        return "question"
    if "plan it" in text:
        finish(planMode=False)
        return None
    if "hang" in text:
        activity("tool", "run_bash(sleep 100)")
        return "hang"
    if "fail" in text:
        finish("error", answer=None, error="Gemini never replied.")
        return None
    if "question" in text:
        emit(type="answer", text="Paris is the capital of France.", interim=True)
        activity("detail", "answered without using any tool")
        finish(answer="That answer is complete.")
        return None
    activity("tool", "read_file(a.py)")
    activity("detail", "10 lines (120 B)")
    activity("tool", "run_bash(false)", worker="api")
    activity("detail", "Exit code 1", worker="api", failed=True)
    finish()
    return None


def main():
    global plan, memory
    if "--no-models" in sys.argv:
        models.clear()
        thinking.clear()
    emit(type="log", text="Starting Chrome...")
    emit(type="ready", project="demo", cwd=".", menu=menu(), gem=None, gemMode="reference",
         mode="orchestrator", workers=3, tools=["read_file"],
         context={"treeLines": 12, "memory": "GEMINI.md", "docs": ["README.md"]},
         createdMemory=True, resumablePlan="interrupted")
    emit(type="mcp", servers=mcp_servers)

    waiting = None
    for line in sys.stdin:
        command = json.loads(line)
        cmd, cid = command["cmd"], command.get("id")
        data = None

        if cmd == "task":
            emit(type="reply", id=cid, ok=True)
            waiting = start_task(command["text"])
            continue
        if cmd == "confirm":
            approve = command["approve"]
            emit(type="confirm_closed", id=command["confirm_id"])
            activity("detail", "wrote 5 bytes" if approve else "declined by the user", failed=not approve)
            waiting = None
            finish(answer="Wrote it." if approve else "Skipped that.")
        elif cmd == "answer":
            emit(type="question_closed", id=command["question_id"], answer=command["text"])
            waiting = None
            finish(answer=f"Using {command['text']}.")
        elif cmd == "plan_mode":
            data = {"on": command["on"]}
        elif cmd == "mcp":
            data = {"servers": mcp_servers}
        elif cmd == "skills":
            data = {"installed": installed_skills, "others": [{"name": "synced", "description": "From Claude", "source": "claude"}]}
        elif cmd == "skill_find":
            if "missing" in command["text"]:
                emit(type="reply", id=cid, ok=False, error="Not found. Check the name, and that the repository is public.")
                continue
            data = {"found": [
                {"name": "pdf", "description": "Reads PDFs.", "path": "skills/pdf", "files": ["fill.py"], "scripts": ["fill.py"]},
                {"name": "docx", "description": "Reads Word files.", "path": "skills/docx", "files": [], "scripts": []},
            ]}
        elif cmd == "skill_install":
            for name in command["names"]:
                installed_skills.append({"name": name, "description": "Installed.", "source": command["text"]})
            data = {"installed": [{"name": name} for name in command["names"]]}
        elif cmd == "skill_remove":
            installed_skills[:] = [s for s in installed_skills if s["name"] != command["text"]]
        elif cmd == "stop":
            if waiting == "confirm":
                emit(type="confirm_closed", id=1)
            if waiting == "question":
                emit(type="question_closed", id=1, answer="")
            waiting = None
            emit(type="task_end", status="stopped")
        elif cmd == "models":
            data = {"menu": menu()}
        elif cmd == "model":
            wanted = command.get("text", "")
            row = next((m for m in models if m["name"].lower() == wanted.lower()), None)
            if row is None or row["locked"]:
                reason = f'"{wanted}" isn\'t included in your Gemini plan.' if row else f'Couldn\'t find "{wanted}".'
                emit(type="reply", id=cid, ok=False, error=reason)
                continue
            select(models, wanted)
            data = {"menu": menu()}
        elif cmd == "thinking":
            if not select(thinking, command.get("text", "")):
                emit(type="reply", id=cid, ok=False, error="Couldn't find that thinking level.")
                continue
            data = {"menu": menu()}
        elif cmd == "gems":
            data = {"gems": [{"id": "1", "name": "Kite 2"}, {"id": "2", "name": "Storybook"}]}
        elif cmd == "gem":
            data = {"gem": command.get("text") or None}
        elif cmd == "undo":
            data = {"ok": True, "message": "Reverted 2 files."}
        elif cmd == "plan":
            data = {"plan": plan}
        elif cmd == "plan_clear":
            plan = None
        elif cmd == "memory":
            data = {"memory": memory}
        elif cmd == "remember":
            memory += f"\n- {command['text']}"
            data = {"memory": memory}
        elif cmd == "paste_image":
            emit(type="reply", id=cid, ok=False, error="no image on the clipboard")
            continue
        elif cmd == "shutdown":
            emit(type="reply", id=cid, ok=True)
            return
        emit(type="reply", id=cid, ok=True, data=data)


main()
