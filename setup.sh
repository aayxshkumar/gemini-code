#!/usr/bin/env bash
# One-shot setup for a CLONED checkout, macOS / Linux:
#
#   git clone https://github.com/aayxshkumar/gemini-code.git
#   cd gemini-code
#   ./setup.sh
#
# Installs dependencies, builds, puts `gemini-code` on your PATH (pointing at
# THIS checkout, so `git pull && npm run build` updates it in place), and runs
# the doctor so you know what, if anything, is still missing. No sudo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${PREFIX:-$HOME/.local/bin}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

bold "gemini-code setup (from this checkout)"
echo

command -v node >/dev/null 2>&1 || die "Node.js 20+ is required. macOS: brew install node · Linux: https://nodejs.org · or nvm install 20"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20+ is required (found $(node -v)). Try: nvm install 20 && nvm use 20"
ok "Node.js $(node -v)"
command -v npm >/dev/null 2>&1 || die "npm is required (it ships with Node)"

cd "$HERE"
echo "  installing dependencies..."
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund --silent 2>/dev/null || npm install --no-audit --no-fund --silent
else
  npm install --no-audit --no-fund --silent
fi
ok "dependencies installed"

# `npm ci`/`install` already ran the prepare hook (= build); build again only
# if dist is missing, e.g. because scripts were skipped.
[ -f dist/cli.js ] || npm run build --silent
ok "built dist/"

# Launcher that resolves symlinks, so it works from anywhere on PATH.
LAUNCHER="$HERE/bin/gemini-code"
mkdir -p "$HERE/bin"
cat > "$LAUNCHER" <<'L'
#!/usr/bin/env bash
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
HERE="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"
exec node "$HERE/dist/cli.js" "$@"
L
chmod +x "$LAUNCHER"
mkdir -p "$PREFIX"
ln -sf "$LAUNCHER" "$PREFIX/gemini-code"
ok "linked $PREFIX/gemini-code -> this checkout"

echo
if ! command -v gemini-code >/dev/null 2>&1; then
  case "${SHELL:-}" in
    *zsh)  RC="$HOME/.zshrc" ;;
    *bash) RC="$HOME/.bashrc" ;;
    *)     RC="your shell profile" ;;
  esac
  warn "$PREFIX isn't on your PATH. Add this line to $RC, then open a new terminal:"
  echo
  echo "      export PATH=\"$PREFIX:\$PATH\""
  echo
fi

node "$HERE/dist/cli.js" doctor || true

bold "Next"
echo "  cd into any project and run:  gemini-code"
echo "  The first run opens Chrome — sign in to Gemini by hand once; the session is kept."
echo "  Defaults live in ~/.gemini-code/config.json:  gemini-code config set model pro"
