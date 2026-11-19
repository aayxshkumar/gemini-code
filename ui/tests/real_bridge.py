"""Drives the real `gemini-code bridge` over its pipes, with no UI.

Starts the agent in a throwaway folder, exactly as the app does, and prints
what it reports. Chrome opens if it isn't running. If you're signed out the
agent waits for you, so this stops after the timeout and shuts it down cleanly.

    python ui/tests/real_bridge.py [seconds]
"""
import json
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
timeout = float(sys.argv[1]) if len(sys.argv) > 1 else 60

project = tempfile.mkdtemp(prefix="gemini-code-bridge-")
proc = subprocess.Popen(
    ["node", str(ROOT / "dist" / "cli.js"), "bridge"],
    cwd=project,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
)

ready = threading.Event()


def read_stdout():
    for raw in proc.stdout:
        line = raw.decode("utf-8", "replace").strip()
        try:
            event = json.loads(line)
        except ValueError:
            print(f"NOT JSON: {line}")
            continue
        print(json.dumps(event, ensure_ascii=False)[:300])
        if event.get("type") == "ready":
            ready.set()


threading.Thread(target=read_stdout, daemon=True).start()
ready.wait(timeout)
print("ready" if ready.is_set() else f"not ready after {timeout:.0f}s (signed out?)")

started = time.monotonic()
proc.stdin.write(b'{"cmd":"shutdown"}\n')
proc.stdin.flush()
try:
    code = proc.wait(10)
    print(f"exited {code} after {time.monotonic() - started:.1f}s")
except subprocess.TimeoutExpired:
    proc.kill()
    print("did not exit on shutdown: killed")
    sys.exit(1)
print(proc.stderr.read().decode("utf-8", "replace").strip() or "(stderr empty)")
