#!/usr/bin/env bash
# Builds a self-contained release tarball: compiled code + production
# dependencies + a launcher, so a user downloads, extracts and runs.
#
# Not a single-file binary, deliberately. Playwright reads its own files at
# runtime (package.json, browser registry, launchApp), so bundling it into
# one executable fails with a different MODULE_NOT_FOUND each time you patch
# the last one — verified, not assumed. A tarball with real node_modules is
# boring and works.
set -euo pipefail

VERSION="$(node -p "require('./package.json').version")"
NAME="gemini-code-v${VERSION}"
STAGE=".release/${NAME}"

echo "Building ${NAME}..."
rm -rf .release
mkdir -p "${STAGE}"

npm run build >/dev/null

cp -R dist "${STAGE}/dist"
cp package.json README.md LICENSE "${STAGE}/"
mkdir -p "${STAGE}/scripts" && cp scripts/prepare.mjs "${STAGE}/scripts/"
[ -d docs ] && cp -R docs "${STAGE}/docs"

# Production deps only — dev tooling (typescript, tsx, esbuild) isn't needed
# to run, and roughly halves the download.
echo "Installing production dependencies..."
(cd "${STAGE}" && npm install --omit=dev --silent --no-audit --no-fund >/dev/null)

cat > "${STAGE}/gemini-code" <<'LAUNCHER'
#!/usr/bin/env bash
# Resolves symlinks so the launcher works from anywhere on your PATH.
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
HERE="$(cd -P "$(dirname "$SOURCE")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "gemini-code needs Node.js 20+ — https://nodejs.org" >&2
  exit 1
fi
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 20 ]; then
  echo "gemini-code needs Node.js 20+ (found $(node -v))" >&2
  exit 1
fi

exec node "$HERE/dist/cli.js" "$@"
LAUNCHER
chmod +x "${STAGE}/gemini-code"

cat > "${STAGE}/INSTALL.txt" <<EOF
gemini-code v${VERSION}

Requirements: macOS or Linux, Node.js 20+, Google Chrome.

  1. Put this folder wherever you like, e.g. ~/tools/${NAME}
  2. Link the launcher onto your PATH:
       ln -sf "\$PWD/gemini-code" /usr/local/bin/gemini-code
  3. Run it in any project:
       cd ~/code/my-project && gemini-code

The first run opens Chrome for you to sign in to Gemini by hand; the
session is kept afterwards. See README.md for everything else.
EOF

tar -czf ".release/${NAME}.tar.gz" -C .release "${NAME}"
SIZE="$(du -h ".release/${NAME}.tar.gz" | cut -f1)"
echo "Done: .release/${NAME}.tar.gz (${SIZE})"
