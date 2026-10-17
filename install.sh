#!/usr/bin/env bash
# gemini-code installer — macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/aayxshkumar/gemini-code/main/install.sh | bash
#
# Installs to ~/.gemini-code/app and links the launcher onto your PATH.
# Nothing here needs sudo unless you point PREFIX at a system directory.
set -euo pipefail

REPO="${GEMINI_CODE_REPO:-aayxshkumar/gemini-code}"
REF="${GEMINI_CODE_REF:-main}"
APP_DIR="${GEMINI_CODE_HOME:-$HOME/.gemini-code}/app"
PREFIX="${PREFIX:-$HOME/.local/bin}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

bold "gemini-code installer"
echo

# ---------------------------------------------------------------- platform
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="macOS" ;;
  Linux)  PLATFORM="Linux" ;;
  *)      die "Unsupported OS: $OS. Windows users: use install.ps1 (see the README)." ;;
esac
ok "Platform: $PLATFORM"

# ------------------------------------------------------------------- node
if ! command -v node >/dev/null 2>&1; then
  die "Node.js 20+ is required but not installed.
     macOS:  brew install node
     Linux:  https://nodejs.org/en/download/package-manager
     Or use nvm: https://github.com/nvm-sh/nvm"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node.js 20+ is required (found $(node -v)). Try: nvm install 20 && nvm use 20"
fi
ok "Node.js $(node -v)"

# ----------------------------------------------------------------- chrome
# Not fatal: it can be installed later, and the first run explains what's missing.
CHROME_FOUND=""
if [ "$PLATFORM" = "macOS" ]; then
  [ -d "/Applications/Google Chrome.app" ] && CHROME_FOUND="yes"
else
  for c in google-chrome google-chrome-stable chromium-browser chromium; do
    command -v "$c" >/dev/null 2>&1 && CHROME_FOUND="yes" && break
  done
fi
if [ -n "$CHROME_FOUND" ]; then
  ok "Google Chrome"
else
  warn "Google Chrome not found — install it before running: https://google.com/chrome"
fi

# ---------------------------------------------------------------- install
echo
info "Installing to $APP_DIR"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"

TARBALL_URL="$(
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | grep -o '"browser_download_url": *"[^"]*\.tar\.gz"' \
    | head -1 | cut -d'"' -f4 || true
)"

if [ -n "$TARBALL_URL" ]; then
  info "Downloading the latest release..."
  curl -fsSL "$TARBALL_URL" | tar -xz -C "$APP_DIR" --strip-components=1
  ok "Downloaded and extracted"
else
  # No published release (or no network to the API): build from source instead,
  # so this script still works on a fresh repo.
  warn "No published release found — building from source"
  command -v git >/dev/null 2>&1 || die "git is required to build from source"
  command -v npm >/dev/null 2>&1 || die "npm is required to build from source"
  TMP="$(mktemp -d)"
  git clone --depth 1 -q --branch "$REF" "https://github.com/$REPO.git" "$TMP"
  ( cd "$TMP" && npm install --silent --no-audit --no-fund >/dev/null && npm run build >/dev/null )
  # Ship only what's needed to run.
  cp -R "$TMP/dist" "$TMP/package.json" "$TMP/package-lock.json" "$APP_DIR/"
  mkdir -p "$APP_DIR/scripts" && cp "$TMP/scripts/prepare.mjs" "$APP_DIR/scripts/"
  [ -f "$TMP/README.md" ] && cp "$TMP/README.md" "$APP_DIR/"
  ( cd "$APP_DIR" && npm install --omit=dev --silent --no-audit --no-fund >/dev/null )
  rm -rf "$TMP"
  ok "Built from source"
fi

# A launcher, in case the release didn't carry one.
if [ ! -x "$APP_DIR/gemini-code" ]; then
  cat > "$APP_DIR/gemini-code" <<'LAUNCHER'
#!/usr/bin/env bash
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
HERE="$(cd -P "$(dirname "$SOURCE")" && pwd)"
exec node "$HERE/dist/cli.js" "$@"
LAUNCHER
  chmod +x "$APP_DIR/gemini-code"
fi

# ------------------------------------------------------------------- PATH
mkdir -p "$PREFIX"
ln -sf "$APP_DIR/gemini-code" "$PREFIX/gemini-code"
ok "Linked $PREFIX/gemini-code"

echo
if command -v gemini-code >/dev/null 2>&1; then
  bold "Installed: $(gemini-code --version 2>/dev/null || echo 'gemini-code')"
else
  bold "Installed — but $PREFIX isn't on your PATH yet."
  case "${SHELL:-}" in
    *zsh)  RC="$HOME/.zshrc" ;;
    *bash) RC="$HOME/.bashrc" ;;
    *)     RC="your shell profile" ;;
  esac
  info "Add this line to $RC, then open a new terminal:"
  echo
  info "    export PATH=\"$PREFIX:\$PATH\""
fi

echo
node "$APP_DIR/dist/cli.js" doctor 2>/dev/null || true
bold "Next steps"
info "1. cd into any project"
info "2. run: gemini-code"
info "3. Chrome opens — sign in to Gemini by hand the first time (just once)"
info "   defaults: gemini-code config set model pro   (3.8 Thinking is the default)"
echo
info "Docs: https://github.com/$REPO"
