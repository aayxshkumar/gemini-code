# Builds .release\exe\gemini-code.exe: the desktop app, the agent and Node.js in
# one file, so a user needs nothing installed but Chrome.
#
# Playwright reads its own files at runtime, so the agent can't be bundled into
# a single script (see README). The exe doesn't try: it carries real node_modules
# and unpacks them to a temp folder when it starts.
param([string]$Python = "")
$ErrorActionPreference = "Stop"
$ui = $PSScriptRoot
$repo = Split-Path $ui -Parent
$out = Join-Path $repo ".release\exe"
$agent = Join-Path $out "stage\agent"

if (-not $Python) {
    $venv = Join-Path $env:USERPROFILE ".gemini-code\ui-venv\Scripts\python.exe"
    $Python = if (Test-Path $venv) { $venv } else { "python" }
}

if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force -Path $agent | Out-Null

Push-Location $repo
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
    Copy-Item -Recurse dist (Join-Path $agent "dist")
    Copy-Item package.json, package-lock.json $agent
} finally {
    Pop-Location
}

# Production dependencies only, in their own folder: dev tooling has no place in the exe.
Push-Location $agent
try {
    npm ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
} finally {
    Pop-Location
}
Copy-Item (Get-Command node).Source (Join-Path $agent "node.exe")

& $Python -m pip install --quiet --disable-pip-version-check -r (Join-Path $ui "requirements-build.txt")
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

& $Python -m PyInstaller --noconfirm --clean --onefile --windowed `
    --name gemini-code `
    --icon (Join-Path $ui "gemini_code_ui\assets\logo.ico") `
    --add-data "$agent;agent" `
    --add-data "$(Join-Path $ui 'gemini_code_ui\assets');gemini_code_ui\assets" `
    --paths $ui `
    --distpath $out `
    --workpath (Join-Path $out "work") `
    --specpath (Join-Path $out "work") `
    (Join-Path $ui "run_app.py")
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

$exe = Join-Path $out "gemini-code.exe"
# A windowed exe has no console, so Start-Process is what can read its exit code.
$check = Start-Process $exe -ArgumentList "--self-check" -Wait -PassThru
if ($check.ExitCode -ne 0) { throw "the exe couldn't run its bundled agent" }

$size = [math]::Round((Get-Item $exe).Length / 1MB)
Write-Host "Built $exe ($size MB)"
