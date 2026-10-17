# gemini-code installer — Windows.
#
#   irm https://raw.githubusercontent.com/aayxshkumar/gemini-code/main/install.ps1 | iex
#
# Installs to %USERPROFILE%\.gemini-code\app and adds it to your user PATH.
# No admin rights needed.

$ErrorActionPreference = "Stop"

$Repo    = if ($env:GEMINI_CODE_REPO) { $env:GEMINI_CODE_REPO } else { "aayxshkumar/gemini-code" }
$Ref     = if ($env:GEMINI_CODE_REF) { $env:GEMINI_CODE_REF } else { "main" }
$Home_   = if ($env:GEMINI_CODE_HOME) { $env:GEMINI_CODE_HOME } else { Join-Path $env:USERPROFILE ".gemini-code" }
$AppDir  = Join-Path $Home_ "app"
$BinDir  = Join-Path $Home_ "bin"

function Write-Ok   ($m) { Write-Host "  [ok] $m" -ForegroundColor Green }
function Write-Warn ($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Write-Die  ($m) { Write-Host "  [x]  $m" -ForegroundColor Red; exit 1 }

Write-Host "gemini-code installer" -ForegroundColor Cyan
Write-Host ""

# ------------------------------------------------------------------- node
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Die "Node.js 20+ is required but not installed.`n       Install it from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS)"
}
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) {
  Write-Die "Node.js 20+ is required (found $(node -v)). Install a newer version from https://nodejs.org"
}
Write-Ok "Node.js $(node -v)"

# ----------------------------------------------------------------- chrome
# Not fatal — it can be installed later; the first run says what's missing.
$chromePaths = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$edgePaths = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)
if ($chromePaths | Where-Object { Test-Path $_ }) {
  Write-Ok "Google Chrome"
} elseif ($edgePaths | Where-Object { Test-Path $_ }) {
  Write-Ok "Microsoft Edge (used in place of Chrome - same engine)"
} else {
  Write-Warn "Neither Google Chrome nor Microsoft Edge found - install one before running"
}

# ---------------------------------------------------------------- install
Write-Host ""
Write-Host "  Installing to $AppDir"
if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null

$tarUrl = $null
try {
  $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "gemini-code-installer" }
  $tarUrl = ($release.assets | Where-Object { $_.name -like "*.tar.gz" } | Select-Object -First 1).browser_download_url
} catch {
  $tarUrl = $null
}

if ($tarUrl) {
  Write-Host "  Downloading the latest release..."
  $tmpFile = Join-Path $env:TEMP "gemini-code.tar.gz"
  Invoke-WebRequest $tarUrl -OutFile $tmpFile -UseBasicParsing
  # tar ships with Windows 10 1803+ .
  tar -xzf $tmpFile -C $AppDir --strip-components=1
  Remove-Item $tmpFile -Force
  Write-Ok "Downloaded and extracted"
} else {
  # No published release: build from source so this still works on a fresh repo.
  Write-Warn "No published release found - building from source"
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Die "git is required to build from source" }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Write-Die "npm is required to build from source" }
  $tmp = Join-Path $env:TEMP ("gc-" + [guid]::NewGuid().ToString("N"))
  git clone --depth 1 -q --branch $Ref "https://github.com/$Repo.git" $tmp
  Push-Location $tmp
  npm install --silent --no-audit --no-fund | Out-Null
  npm run build | Out-Null
  Pop-Location
  Copy-Item (Join-Path $tmp "dist") $AppDir -Recurse
  Copy-Item (Join-Path $tmp "package.json") $AppDir
  New-Item -ItemType Directory -Force -Path (Join-Path $AppDir "scripts") | Out-Null
  Copy-Item (Join-Path $tmp "scripts\prepare.mjs") (Join-Path $AppDir "scripts")
  if (Test-Path (Join-Path $tmp "README.md")) { Copy-Item (Join-Path $tmp "README.md") $AppDir }
  Push-Location $AppDir
  npm install --omit=dev --silent --no-audit --no-fund | Out-Null
  Pop-Location
  Remove-Item -Recurse -Force $tmp
  Write-Ok "Built from source"
}

# ------------------------------------------------------------------ shim
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$cmd = Join-Path $BinDir "gemini-code.cmd"
"@echo off`r`nnode `"$AppDir\dist\cli.js`" %*" | Set-Content -Path $cmd -Encoding ASCII
Write-Ok "Created $cmd"

# ------------------------------------------------------------------- PATH
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$BinDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$BinDir", "User")
  Write-Ok "Added $BinDir to your PATH (restart your terminal to pick it up)"
} else {
  Write-Ok "$BinDir is already on your PATH"
}

Write-Host ""
node "$AppDir\dist\cli.js" doctor
Write-Host ""
Write-Host "Next steps" -ForegroundColor Cyan
Write-Host "  1. Open a NEW terminal (so the PATH change applies)"
Write-Host "  2. cd into any project"
Write-Host "  3. run: gemini-code"
Write-Host "  4. Your browser (Chrome or Edge) opens - sign in to Gemini by hand the first time (just once)"
Write-Host "     defaults: gemini-code config set model pro   (3.8 Thinking is the default)"
Write-Host ""
Write-Host "  Docs: https://github.com/$Repo"
