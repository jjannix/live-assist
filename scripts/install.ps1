# jnk Live Assist -- one-line installer
# =======================================
# Run in PowerShell (Win+X, Terminal):
#   irm https://raw.githubusercontent.com/jjannix/live-assist-install/main/install.ps1 | iex
#
# This file is a convenience copy inside the main repo. It fetches and runs the
# latest canonical installer from the dedicated install repo.

$ErrorActionPreference = 'Stop'
$RemoteUrl = 'https://raw.githubusercontent.com/jjannix/live-assist-install/main/install.ps1'

Write-Host ''
Write-Host '  jnk Live Assist -- Installer' -ForegroundColor Cyan
Write-Host '  Fetching latest installer...' -ForegroundColor DarkGray
Write-Host ''

try {
    $script = Invoke-RestMethod -Uri $RemoteUrl -UseBasicParsing
    Invoke-Expression $script
} catch {
    Write-Host "  xx  Failed to download the installer: $_" -ForegroundColor Red
    Write-Host ''
    Write-Host '  You can clone manually:' -ForegroundColor Yellow
    Write-Host '    git clone https://github.com/jjannix/live-assist.git' -ForegroundColor White
    Write-Host '    cd live-assist' -ForegroundColor White
    Write-Host '    npm install' -ForegroundColor White
    Write-Host '    node server.js' -ForegroundColor White
    Write-Host ''
    exit 1
}
