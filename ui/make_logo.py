"""Renders assets/logo.svg to the PNG and multi-size ICO the app and exe use.

Only needed after changing the SVG. The results are committed.

    python ui/make_logo.py
"""
import os
import struct
import sys
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QBuffer, QIODevice, Qt
from PySide6.QtGui import QGuiApplication, QImage, QPainter
from PySide6.QtSvg import QSvgRenderer

ASSETS = Path(__file__).resolve().parent / "gemini_code_ui" / "assets"
ICON_SIZES = (16, 24, 32, 48, 64, 128, 256)


def render(renderer: QSvgRenderer, size: int) -> bytes:
    image = QImage(size, size, QImage.Format.Format_ARGB32)
    image.fill(Qt.GlobalColor.transparent)
    painter = QPainter(image)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    renderer.render(painter)
    painter.end()
    buffer = QBuffer()
    buffer.open(QIODevice.OpenModeFlag.WriteOnly)
    image.save(buffer, "PNG")
    return bytes(buffer.data())


def write_ico(path: Path, images: dict[int, bytes]) -> None:
    """An ICO is a directory of entries, each here a whole PNG file."""
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = len(header) + 16 * len(images)
    entries = b""
    for size, data in images.items():
        # A byte each for width and height, where 0 means 256.
        side = 0 if size == 256 else size
        entries += struct.pack("<BBBBHHII", side, side, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    path.write_bytes(header + entries + b"".join(images.values()))


def main() -> int:
    app = QGuiApplication(sys.argv[:1])
    renderer = QSvgRenderer(str(ASSETS / "logo.svg"))
    if not renderer.isValid():
        print("logo.svg didn't parse")
        return 1
    (ASSETS / "logo.png").write_bytes(render(renderer, 512))
    write_ico(ASSETS / "logo.ico", {size: render(renderer, size) for size in ICON_SIZES})
    del app
    return 0


if __name__ == "__main__":
    sys.exit(main())
