# TWV Tally Bridge — one-time bootstrap to v1.4.1
#
# After this runs successfully, every future update is remote:
#   1. Build a new zip on the CRM side
#   2. Upload it via /admin/tally-sync → "Publish Bridge Update"
#   3. The bridge self-updates on its next heartbeat (~60s)
#
# Usage (on the Tally machine, via AnyDesk/RDP, as Administrator):
#   1. Drop twv-tally-bridge-v1.4.1.zip in the SAME folder as this script.
#   2. Right-click this file → "Run with PowerShell" (Administrator).
#
# What it does (no surprises):
#   - Locates the bridge install dir from the running "TWV Tally Bridge" service.
#   - Stops the service.
#   - Renames dist/ → dist.prev/ (rollback path).
#   - Expands the new zip in place (dist/, node_modules/, *.bat).
#   - Starts the service.
#   - Prints the service status. You should see "Running".

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$zip  = Join-Path $here "twv-tally-bridge-v1.4.1.zip"

if (-not (Test-Path $zip)) {
    Write-Host "ERROR: $zip not found. Place the zip beside this script." -ForegroundColor Red
    exit 1
}

# Locate install dir from the service's binary path.
$svc = Get-CimInstance Win32_Service -Filter "DisplayName='TWV Tally Bridge'" -ErrorAction SilentlyContinue
if (-not $svc) {
    Write-Host "ERROR: Service 'TWV Tally Bridge' is not installed on this machine." -ForegroundColor Red
    Write-Host "If this is a fresh install, copy the zip contents into your chosen install dir,"
    Write-Host "then run install-service.bat from that dir instead."
    exit 1
}

# PathName is like '"C:\path\to\bridge\daemon\twvtallybridge.exe"'
$exePath    = $svc.PathName -replace '^"', '' -replace '" .*$', '' -replace '"$', ''
$daemonDir  = Split-Path $exePath -Parent
# node-windows puts the daemon exe inside <installDir>\daemon\
$installDir = Split-Path $daemonDir -Parent
Write-Host "Install dir detected: $installDir"

Set-Location $installDir

Write-Host "Stopping TWV Tally Bridge service…"
Stop-Service -DisplayName "TWV Tally Bridge" -Force
Start-Sleep -Seconds 3

if (Test-Path dist.prev) { Remove-Item dist.prev -Recurse -Force }
if (Test-Path dist)      { Rename-Item dist dist.prev }

Write-Host "Expanding $zip into $installDir…"
Expand-Archive -Path $zip -DestinationPath $installDir -Force

Write-Host "Starting service…"
Start-Service -DisplayName "TWV Tally Bridge"
Start-Sleep -Seconds 3

$status = (Get-Service -DisplayName "TWV Tally Bridge").Status
Write-Host ""
Write-Host "TWV Tally Bridge service status: $status"
Write-Host ""
if ($status -eq "Running") {
    Write-Host "✔ Bootstrap complete. Bridge is on v1.4.1." -ForegroundColor Green
    Write-Host "  From now on, publish updates via /admin/tally-sync — the bridge will self-update."
} else {
    Write-Host "⚠ Service did not reach Running. Check the bridge log at $installDir\logs\ for details." -ForegroundColor Yellow
    Write-Host "  To roll back: stop the service, delete dist/, rename dist.prev/ back to dist/, start the service."
}
