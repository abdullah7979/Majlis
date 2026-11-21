# Majlis one-line installer for Windows.
#   irm https://raw.githubusercontent.com/abdullah7979/majlis/main/install.ps1 | iex
# Installs (only what's missing): Node.js LTS, Claude Code, Codex CLI, Google Antigravity CLI (Gemini),
# then the latest Majlis release, and launches it.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Magenta }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  $npmBin = Join-Path $env:APPDATA 'npm'
  if ($env:Path -notlike "*$npmBin*") { $env:Path += ";$npmBin" }
}

Write-Host ''
Write-Host '  Majlis  -  every AI you pay for, in one app' -ForegroundColor Cyan
Write-Host '  ------------------------------------------' -ForegroundColor DarkGray

# 1) Node.js -----------------------------------------------------------------
Step 'Checking Node.js'
Refresh-Path
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host 'Installing Node.js LTS...'
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements | Out-Null
    Refresh-Path
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'Could not install Node.js automatically. Install it from https://nodejs.org then run this command again.' -ForegroundColor Yellow
    Start-Process 'https://nodejs.org/en/download'
    return
  }
}
Write-Host "Node.js $(node --version)" -ForegroundColor Green

# 2) Official AI CLIs ----------------------------------------------------------
Step 'Installing the official AI tools (Claude Code, Codex, Google Antigravity)'
$clis = @(
  @{ bin = 'claude'; pkg = '@anthropic-ai/claude-code' },
  @{ bin = 'codex';  pkg = '@openai/codex' }
)
foreach ($c in $clis) {
  if (Get-Command $c.bin -ErrorAction SilentlyContinue) {
    Write-Host "$($c.bin): already installed" -ForegroundColor Green
  } else {
    Write-Host "Installing $($c.pkg)..."
    try { & npm install -g $c.pkg --no-fund --no-audit --loglevel=error | Out-Null; Write-Host "$($c.bin): installed" -ForegroundColor Green }
    catch { Write-Host "$($c.bin): failed (you can install it later from Majlis > Settings)" -ForegroundColor Yellow }
  }
}
# Gemini: Google replaced Gemini CLI with Antigravity CLI (agy) for personal accounts in June 2026.
$agyBin = Join-Path $env:LOCALAPPDATA 'agy\bin'
if ((Get-Command agy -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $agyBin 'agy.exe'))) {
  Write-Host 'agy (Gemini): already installed' -ForegroundColor Green
} else {
  Write-Host 'Installing Google Antigravity CLI (Gemini)...'
  try { irm https://antigravity.google/cli/install.ps1 | iex; Write-Host 'agy (Gemini): installed' -ForegroundColor Green }
  catch { Write-Host 'agy: failed (you can install it later from Majlis > Settings)' -ForegroundColor Yellow }
}
Refresh-Path

# 3) Majlis ------------------------------------------------------------------
Step 'Downloading Majlis'
$base = 'https://github.com/abdullah7979/majlis/releases/latest/download'
# latest.yml (published with every release) names the current installer; no API call, no rate limit.
$name = $null; $version = $null
try {
  $yml = (Invoke-WebRequest "$base/latest.yml" -UseBasicParsing).Content
  if ($yml -is [byte[]]) { $yml = [Text.Encoding]::UTF8.GetString($yml) }
  $name = ([regex]::Match($yml, '(?m)^path:\s*(.+)$')).Groups[1].Value.Trim()
  $version = ([regex]::Match($yml, '(?m)^version:\s*(.+)$')).Groups[1].Value.Trim()
} catch { }
if (-not $name) {
  # Fallback: ask the GitHub API which installer is the newest.
  $rel = Invoke-RestMethod 'https://api.github.com/repos/abdullah7979/majlis/releases/latest' -Headers @{ 'User-Agent' = 'majlis-installer' }
  $asset = $rel.assets | Where-Object { $_.name -like 'Majlis-Setup-*.exe' } | Select-Object -First 1
  if ($asset) { $name = $asset.name; $version = $rel.tag_name; $base = $asset.browser_download_url.Substring(0, $asset.browser_download_url.LastIndexOf('/')) }
}
if (-not $name) { throw 'Could not find the latest Majlis installer.' }
$setup = Join-Path $env:TEMP $name
Invoke-WebRequest "$base/$name" -OutFile $setup -UseBasicParsing
Write-Host "Majlis $version downloaded"

Step 'Installing Majlis'
Get-Process Majlis -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Process $setup -ArgumentList '/S' -Wait
Remove-Item $setup -ErrorAction SilentlyContinue

$exe = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\majlis\Majlis.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Majlis\Majlis.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1

Write-Host ''
Write-Host '  Done! Majlis is in your Start menu and on your desktop.' -ForegroundColor Green
Write-Host '  First launch walks you through signing in to Claude, ChatGPT and Gemini.' -ForegroundColor Gray
Write-Host ''
if ($exe) { Start-Process $exe }
