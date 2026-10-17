# One-shot setup for a CLONED checkout, Windows (PowerShell):
#
#   git clone https://github.com/aayxshkumar/gemini-code.git
#   cd gemini-code
#   .\setup.ps1
#
# Installs dependencies, builds, puts `gemini-code` on your user PATH (pointing
# at THIS checkout), and runs the doctor. No admin rights needed.
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Ok   ($m) { Write-Host "  [ok] $m" -ForegroundColor Green }
function Write-Warn ($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Write-Die  ($m) { Write-Host "  [x]  $m" -ForegroundColor Red; exit 1 }

Write-Host "gemini-code setup (from this checkout)" -ForegroundColor Cyan
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Die "Node.js 20+ is required. Install it from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS)"
}
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) { Write-Die "Node.js 20+ is required (found $(node -v))" }
Write-Ok "Node.js $(node -v)"

Push-Location $Here
try {
  Write-Host "  installing dependencies..."
  if (Test-Path "package-lock.json") {
    npm ci --no-audit --no-fund --silent
    if ($LASTEXITCODE -ne 0) { npm install --no-audit --no-fund --silent }
  } else {
    npm install --no-audit --no-fund --silent
  }
  if ($LASTEXITCODE -ne 0) { Write-Die "npm install failed" }
  Write-Ok "dependencies installed"

  if (-not (Test-Path "dist\cli.js")) {
    npm run build --silent
    if ($LASTEXITCODE -ne 0) { Write-Die "build failed" }
  }
  Write-Ok "built dist\"

  $BinDir = Join-Path $Here "bin"
  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  $cmd = Join-Path $BinDir "gemini-code.cmd"
  "@echo off`r`nnode `"$Here\dist\cli.js`" %*" | Set-Content -Path $cmd -Encoding ASCII
  Write-Ok "created $cmd"

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($userPath -notlike "*$BinDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$BinDir", "User")
    $env:Path = "$env:Path;$BinDir"
    Write-Ok "added $BinDir to your user PATH (new terminals pick it up)"
  } else {
    Write-Ok "$BinDir is already on your PATH"
  }

  Write-Host ""
  node "$Here\dist\cli.js" doctor
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Next" -ForegroundColor Cyan
Write-Host "  Open a NEW terminal, cd into any project and run:  gemini-code"
Write-Host "  The first run opens Chrome - sign in to Gemini by hand once; the session is kept."
Write-Host "  Defaults live in %USERPROFILE%\.gemini-code\config.json:  gemini-code config set model pro"
