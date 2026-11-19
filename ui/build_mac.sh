#!/usr/bin/env bash
# Builds .release/mac/gemini-code-macos-<arch>.zip: gemini-code.app with Node.js
# and the agent inside, so a Mac needs nothing installed but Chrome.
#
# Zipped with ditto, not zip: an .app holds symlinks and executable bits that
# a plain zip loses, which leaves a bundle that won't open.
set -euo pipefail

UI="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$UI")"
OUT="$REPO/.release/mac"
AGENT="$OUT/stage/agent"
PYTHON="${PYTHON:-python3}"
ARCH="$(uname -m)"

rm -rf "$OUT"
mkdir -p "$AGENT"

(cd "$REPO" && npm run build)
cp -R "$REPO/dist" "$AGENT/dist"
cp "$REPO/package.json" "$REPO/package-lock.json" "$AGENT/"
# Production dependencies only, in their own folder.
(cd "$AGENT" && npm ci --omit=dev --no-audit --no-fund)
rm -rf "$AGENT/node_modules/.bin"
cp "$(command -v node)" "$AGENT/node"

"$PYTHON" -m pip install --quiet --disable-pip-version-check -r "$UI/requirements-build.txt" pillow

"$PYTHON" -m PyInstaller --noconfirm --clean --windowed \
  --name gemini-code \
  --osx-bundle-identifier com.muruganandham18.gemini-code \
  --icon "$UI/gemini_code_ui/assets/logo.png" \
  --add-data "$AGENT:agent" \
  --add-data "$UI/gemini_code_ui/assets:gemini_code_ui/assets" \
  --paths "$UI" \
  --distpath "$OUT" \
  --workpath "$OUT/work" \
  --specpath "$OUT/work" \
  "$UI/run_app.py"

APP="$OUT/gemini-code.app"
"$APP/Contents/MacOS/gemini-code" --self-check || { echo "the app couldn't run its bundled agent" >&2; exit 1; }

ZIP="$OUT/gemini-code-macos-$ARCH.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
echo "Built $ZIP ($(du -h "$ZIP" | cut -f1))"
