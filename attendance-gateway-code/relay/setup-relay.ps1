<#
.SYNOPSIS
  Installs/updates the ADMS device relay as a Windows service on the office machine.

.DESCRIPTION
  Automates the manual steps in relay/README.md: checks for Node.js and NSSM,
  copies the relay/ folder to an install directory, and installs it as an
  auto-starting NSSM service ("AttendanceRelay") pointed at the cloud app.

  By default this only INSTALLS the service — it does not stop the existing
  local "AttendanceGateway" service or start the relay, because doing so cuts
  the office's live attendance capture over from the local app to the cloud.
  Pass -Cutover only when you are actually ready to switch over.

.PARAMETER CloudUrl
  Cloud app base URL the relay forwards to. Defaults to the plain Vercel URL
  rather than the attendance.theworkvilla.com custom domain, since that domain
  is currently still pointed at an unrelated deployment under a different
  Vercel account — see docs/data-migration.md and ask before changing this
  back to the custom domain once that's sorted out.

.PARAMETER RelayPort
  Local port the relay listens on. Must match the K40 Pro's configured ADMS
  port (Menu -> Comm -> ADMS on the device) — default 3001, same port the
  existing local app already uses.

.PARAMETER NssmPath
  Full path to nssm.exe if it's not already on PATH. Download it yourself from
  https://nssm.cc/download and extract it first — this script does not
  download anything.

.PARAMETER NoSleep
  Turn off sleep and hibernate on this PC (while plugged in), so the relay keeps
  running when nobody is using the machine. Recommended unless the PC is already
  set never to sleep. Changes Windows power settings, so it's opt-in.

.PARAMETER Cutover
  Actually stop the old "AttendanceGateway" service and start the relay. Only
  pass this when you intend to switch the device over to the cloud right now.

.EXAMPLE
  # Stage the relay service without touching the live local app yet:
  .\setup-relay.ps1 -NssmPath "C:\nssm-2.24\win64\nssm.exe"

.EXAMPLE
  # Actually cut over once you're ready:
  .\setup-relay.ps1 -NssmPath "C:\nssm-2.24\win64\nssm.exe" -Cutover
#>

param(
  [string]$RelaySourceDir = $PSScriptRoot,
  [string]$InstallDir = "C:\AttendanceRelay",
  [string]$CloudUrl = "https://twv-attendance.vercel.app",
  [int]$RelayPort = 3001,
  [string]$NssmPath = "",
  [switch]$NoSleep,
  [switch]$Cutover
)

$ErrorActionPreference = "Stop"

function Fail([string]$msg) {
  Write-Host "ERROR: $msg" -ForegroundColor Red
  exit 1
}

# --- 1. Must run elevated: NSSM service install/removal requires admin rights ---
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail "Run this from an Administrator PowerShell window (right-click PowerShell -> Run as administrator)."
}

# --- 2. Node.js ---
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
  Fail "Node.js not found on PATH. Install Node 18+ from https://nodejs.org, then re-run this script."
}
Write-Host "Found Node: $($node.Source)"

# --- 3. NSSM (never auto-downloaded — must already be on disk) ---
if (-not $NssmPath) {
  $found = Get-Command nssm.exe -ErrorAction SilentlyContinue
  if ($found) { $NssmPath = $found.Source }
}
if (-not $NssmPath -or -not (Test-Path $NssmPath)) {
  Fail "NSSM not found. Download it from https://nssm.cc/download, extract nssm.exe somewhere, and re-run with -NssmPath 'C:\path\to\nssm.exe'."
}
Write-Host "Using NSSM: $NssmPath"

# --- 4. Copy relay files into the install directory ---
$relayJs = Join-Path $RelaySourceDir "relay.js"
if (-not (Test-Path $relayJs)) {
  Fail "relay.js not found in '$RelaySourceDir'. Run this script from inside the relay/ folder, or pass -RelaySourceDir."
}
$sourceFull = (Resolve-Path $RelaySourceDir).Path
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$installFull = (Resolve-Path $InstallDir).Path
if ($sourceFull -ieq $installFull) {
  Write-Host "Source and install directory are the same ($installFull) — skipping copy."
} else {
  Copy-Item -Path (Join-Path $RelaySourceDir "*") -Destination $InstallDir -Recurse -Force
  Write-Host "Copied relay files to $InstallDir"
}

# --- 5. Warn loudly if this would collide with the live local app ---
$oldServiceName = "AttendanceGateway"
$oldService = Get-Service -Name $oldServiceName -ErrorAction SilentlyContinue
$oldServiceIsLive = $oldService -and $oldService.Status -eq "Running"

if ($oldServiceIsLive -and -not $Cutover) {
  Write-Host ""
  Write-Host "The existing local app service ('$oldServiceName') is still running and holds port $RelayPort." -ForegroundColor Yellow
  Write-Host "This script will install the relay service below but will NOT start it or touch" -ForegroundColor Yellow
  Write-Host "'$oldServiceName', since starting the relay needs that port and would cut the office" -ForegroundColor Yellow
  Write-Host "over from the local app to the cloud app immediately." -ForegroundColor Yellow
  Write-Host "Re-run this script with -Cutover only when you're actually ready to switch over." -ForegroundColor Yellow
  Write-Host ""
}

# --- 6. Install (or reinstall) the AttendanceRelay service, stopped by default ---
$existing = Get-Service -Name "AttendanceRelay" -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Removing existing AttendanceRelay service to reconfigure it..."
  & $NssmPath stop AttendanceRelay confirm | Out-Null
  & $NssmPath remove AttendanceRelay confirm | Out-Null
}

& $NssmPath install AttendanceRelay $node.Source (Join-Path $InstallDir "relay.js")
& $NssmPath set AttendanceRelay AppEnvironmentExtra "CLOUD_URL=$CloudUrl" "RELAY_PORT=$RelayPort"
& $NssmPath set AttendanceRelay AppDirectory $InstallDir
& $NssmPath set AttendanceRelay AppStdout (Join-Path $InstallDir "relay.log")
& $NssmPath set AttendanceRelay AppStderr (Join-Path $InstallDir "relay.log")
# Start with Windows, before anyone logs in: after a power cut the PC restarts on its
# own and nobody may be there to log in. And restart the relay within 5 seconds if it
# ever crashes. Punches made while it's down wait on the device and are sent afterwards.
& $NssmPath set AttendanceRelay Start SERVICE_AUTO_START
& $NssmPath set AttendanceRelay AppExit Default Restart
& $NssmPath set AttendanceRelay AppRestartDelay 5000
Write-Host "Installed 'AttendanceRelay' service: CLOUD_URL=$CloudUrl, port $RelayPort, starts with Windows, restarts on crash."

if ($NoSleep) {
  powercfg /change standby-timeout-ac 0
  powercfg /change hibernate-timeout-ac 0
  Write-Host "Sleep and hibernate turned off on this PC (while plugged in)."
} else {
  Write-Host "Tip: if this PC goes to sleep when idle, re-run with -NoSleep so the relay keeps running." -ForegroundColor Yellow
}

# --- 7. Only actually flip traffic over when explicitly asked ---
if ($Cutover) {
  if ($oldServiceIsLive) {
    Write-Host "Stopping '$oldServiceName' to free port $RelayPort..."
    Stop-Service -Name $oldServiceName -Force
  }
  # Disabled, not just stopped: otherwise it starts again at the next boot (e.g. after
  # a power cut) and can grab port $RelayPort before the relay does.
  if ($oldService) {
    Set-Service -Name $oldServiceName -StartupType Disabled
    Write-Host "Disabled '$oldServiceName' so it can't start again at boot."
  }
  & $NssmPath start AttendanceRelay
  Start-Sleep -Seconds 2
  try {
    $health = Invoke-RestMethod -Uri "http://localhost:$RelayPort/health" -TimeoutSec 5
    Write-Host "Relay is up. /health responded: $($health | ConvertTo-Json -Compress)" -ForegroundColor Green
  } catch {
    Write-Host "Relay service started, but /health did not respond yet: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "Check $InstallDir\relay.log for details."
  }
} else {
  Write-Host ""
  Write-Host "Relay service is installed but NOT started (pass -Cutover when you're ready to switch the device over)."
}

Write-Host ""
Write-Host "Device setting (unchanged either way): Menu -> Comm -> ADMS on the K40 Pro should already"
Write-Host "point at this machine's LAN IP and port $RelayPort — same as it does for the local app today."
