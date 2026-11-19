"""Runs the Node agent as a child process. See src/bridge/bridge.ts for the protocol."""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path
from typing import Callable

from PySide6.QtCore import QObject, QProcess, QProcessEnvironment, QTimer, Signal

# The exe carries its own Node and agent, unpacked here when it starts.
BUNDLE = Path(sys._MEIPASS) / "agent" if getattr(sys, "frozen", False) else None
REPO_ROOT = Path(__file__).resolve().parents[2]
CLI = (BUNDLE or REPO_ROOT) / "dist" / "cli.js"

SHUTDOWN_GRACE_MS = 4000

Reply = Callable[[dict], None]


def node_command(*args: str) -> list[str]:
    """The agent's command line, or a clear error when it can't run yet."""
    bundled = BUNDLE / ("node.exe" if sys.platform == "win32" else "node") if BUNDLE else None
    node = str(bundled) if bundled else shutil.which("node")
    if not node:
        raise RuntimeError("Node.js wasn't found on PATH. Install Node 20 or newer.")
    if not CLI.exists():
        raise RuntimeError(f"{CLI} is missing. Run `npm install` and `npm run build` in {REPO_ROOT}.")
    return [node, str(CLI), *args]


def process_environment(env: dict[str, str | None]) -> QProcessEnvironment:
    out = QProcessEnvironment.systemEnvironment()
    if BUNDLE:
        # So an MCP server or a command that runs `node` finds the bundled one
        # on a machine that has no Node of its own.
        out.insert("PATH", os.pathsep.join([str(BUNDLE), out.value("PATH")]))
    for name, value in env.items():
        if value is None:
            out.remove(name)
        else:
            out.insert(name, value)
    return out


class AgentProcess(QObject):
    """One running agent, for one project folder."""

    event = Signal(dict)
    log = Signal(str)

    def __init__(self, command: list[str] | None = None, parent: QObject | None = None):
        super().__init__(parent)
        self._command = command
        self._proc: QProcess | None = None
        self._buffer = b""
        self._next_id = 1
        self._replies: dict[int, Reply] = {}
        self._on_stopped: Callable[[], None] | None = None

    def running(self) -> bool:
        return self._proc is not None

    def start(self, cwd: str, env: dict[str, str | None]) -> None:
        try:
            command = self._command or node_command("bridge")
        except RuntimeError as err:
            self.event.emit({"type": "fatal", "message": str(err)})
            return

        proc = QProcess(self)
        proc.setProgram(command[0])
        proc.setArguments(command[1:])
        proc.setWorkingDirectory(cwd)
        proc.setProcessEnvironment(process_environment(env))
        proc.readyReadStandardOutput.connect(self._read_stdout)
        proc.readyReadStandardError.connect(self._read_stderr)
        proc.errorOccurred.connect(self._on_error)
        proc.finished.connect(self._on_finished)
        self._proc = proc
        self._buffer = b""
        self._replies.clear()
        proc.start()

    def command(self, cmd: str, on_reply: Reply | None = None, **fields) -> None:
        if not self._proc:
            if on_reply:
                on_reply({"ok": False, "error": "the agent isn't running"})
            return
        message = {"id": self._next_id, "cmd": cmd, **fields}
        if on_reply:
            self._replies[self._next_id] = on_reply
        self._next_id += 1
        self._proc.write((json.dumps(message) + "\n").encode("utf-8"))

    def stop(self, on_stopped: Callable[[], None] | None = None) -> None:
        """Asks the agent to exit, so it can record an interrupted plan and
        stop background commands. Killing it straight away would skip both."""
        proc = self._proc
        if not proc:
            if on_stopped:
                on_stopped()
            return
        self._on_stopped = on_stopped
        self.command("shutdown")
        proc.closeWriteChannel()
        QTimer.singleShot(SHUTDOWN_GRACE_MS, proc, proc.kill)

    def stop_and_wait(self) -> None:
        """For closing the app, when there's no event loop left to wait in."""
        proc = self._proc
        if not proc:
            return
        self.stop()
        if not proc.waitForFinished(SHUTDOWN_GRACE_MS):
            proc.kill()
            proc.waitForFinished(1000)

    def _read_stdout(self) -> None:
        self._buffer += bytes(self._proc.readAllStandardOutput())
        *lines, self._buffer = self._buffer.split(b"\n")
        for raw in lines:
            line = raw.decode("utf-8", "replace").strip()
            if line:
                self._handle_line(line)

    def _handle_line(self, line: str) -> None:
        try:
            event = json.loads(line)
        except ValueError:
            # Something wrote to stdout around the protocol. Keep it visible.
            self.log.emit(line)
            return
        if event.get("type") != "reply":
            self.event.emit(event)
            return
        callback = self._replies.pop(event.get("id"), None)
        if callback:
            callback(event)
        elif not event.get("ok"):
            self.log.emit(f"agent: {event.get('error')}")

    def _read_stderr(self) -> None:
        text = bytes(self._proc.readAllStandardError()).decode("utf-8", "replace").strip()
        if text:
            self.log.emit(text)

    def _on_error(self, error: QProcess.ProcessError) -> None:
        if error == QProcess.ProcessError.FailedToStart:
            self.event.emit({"type": "fatal", "message": f"Couldn't start the agent: {self._proc.errorString()}"})
            self._reset()

    def _on_finished(self, code: int, _status: QProcess.ExitStatus) -> None:
        self._read_stdout()
        on_stopped = self._on_stopped
        self._reset()
        if on_stopped:
            on_stopped()
        else:
            self.event.emit({"type": "exited", "code": code})

    def _reset(self) -> None:
        proc, self._proc = self._proc, None
        self._on_stopped = None
        pending, self._replies = self._replies, {}
        if proc:
            proc.deleteLater()
        for callback in pending.values():
            callback({"ok": False, "error": "the agent stopped"})


class ApiServerProcess(QObject):
    """`gemini-code serve`, started and stopped from the API page."""

    output = Signal(str)
    runningChanged = Signal(bool)

    def __init__(self, parent: QObject | None = None):
        super().__init__(parent)
        self._proc: QProcess | None = None

    def running(self) -> bool:
        return self._proc is not None

    def start(self, cwd: str, env: dict[str, str | None]) -> None:
        try:
            command = node_command("serve")
        except RuntimeError as err:
            self.output.emit(str(err))
            return
        proc = QProcess(self)
        proc.setProgram(command[0])
        proc.setArguments(command[1:])
        proc.setWorkingDirectory(cwd)
        proc.setProcessEnvironment(process_environment(env))
        proc.setProcessChannelMode(QProcess.ProcessChannelMode.MergedChannels)
        proc.readyReadStandardOutput.connect(self._read)
        proc.errorOccurred.connect(self._on_error)
        proc.finished.connect(self._on_finished)
        self._proc = proc
        proc.start()
        self.runningChanged.emit(True)

    def stop(self) -> None:
        if self._proc:
            self._proc.kill()

    def stop_and_wait(self) -> None:
        if self._proc:
            self._proc.kill()
            self._proc.waitForFinished(1000)

    def _read(self) -> None:
        text = bytes(self._proc.readAllStandardOutput()).decode("utf-8", "replace").rstrip()
        if text:
            self.output.emit(text)

    def _on_error(self, error: QProcess.ProcessError) -> None:
        if error == QProcess.ProcessError.FailedToStart:
            self.output.emit(f"Couldn't start the server: {self._proc.errorString()}")
            self._finish()

    def _on_finished(self, code: int, _status: QProcess.ExitStatus) -> None:
        self._read()
        self.output.emit(f"Server stopped (exit code {code}).")
        self._finish()

    def _finish(self) -> None:
        proc, self._proc = self._proc, None
        if proc:
            proc.deleteLater()
        self.runningChanged.emit(False)
