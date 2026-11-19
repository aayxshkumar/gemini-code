# Builds the agent and installs the desktop app's dependencies. Safe to re-run.
#
# The venv lives in ~/.gemini-code rather than beside this script: PySide6 is
# hundreds of MB, and a repo inside OneDrive would sync all of it.
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$venv = Join-Path $env:USERPROFILE ".gemini-code\ui-venv"

Push-Location $repo
try {
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
} finally {
    Pop-Location
}

if (-not (Test-Path "$venv\Scripts\python.exe")) {
    python -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw "couldn't create a venv: is Python 3.10+ installed?" }
}
& "$venv\Scripts\python.exe" -m pip install --quiet --disable-pip-version-check -r "$PSScriptRoot\requirements.txt"
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

Write-Host "Ready. Start the app with ui\gemini-code-ui.bat"
