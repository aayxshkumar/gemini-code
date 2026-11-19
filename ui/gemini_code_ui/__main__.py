import subprocess
import sys
from pathlib import Path

from PySide6.QtGui import QIcon
from PySide6.QtWidgets import QApplication

from .agent import node_command
from .settings import Settings
from .theme import apply_theme
from .window import MainWindow

LOGO = Path(__file__).resolve().parent / "assets" / "logo.png"


def self_check() -> int:
    """Proves a built exe can run its bundled agent: the release build calls this."""
    return subprocess.run(node_command("--version"), capture_output=True).returncode


def main() -> int:
    if "--self-check" in sys.argv:
        return self_check()

    if sys.platform == "win32":
        # Without its own id, the taskbar groups the app under Python's icon.
        import ctypes

        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("gemini-code.desktop")

    app = QApplication(sys.argv)
    app.setApplicationName("gemini-code")
    app.setWindowIcon(QIcon(str(LOGO)))
    apply_theme(app)
    window = MainWindow(Settings.load())
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
