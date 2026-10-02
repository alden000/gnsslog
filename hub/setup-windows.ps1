<#
  GNSS Log hub — install or update on Windows (the mini PC).

  Run in an *administrator* PowerShell:
    Set-ExecutionPolicy -Scope Process Bypass
    .\setup-windows.ps1 -TunnelToken <tunnel token> -AccessTeam <team name> -AccessAud <AUD tag>

  Run it again at any time to update to the latest code; settings, the ingest token and all
  data are kept. What it does:
    1. installs Node.js LTS (winget) if Node 22.13+ is missing
    2. downloads the app from GitHub into  <InstallDir>\app   (data lives in <InstallDir>\data)
    3. creates <InstallDir>\data\hub-config.json with a random ingest token (first run only)
    4. registers the "GNSS Log Hub" scheduled task: starts at boot as SYSTEM, restarts on failure
    5. installs cloudflared and, with -TunnelToken, runs the tunnel as a Windows service
    6. checks http://127.0.0.1:<port>/api/health

  Remove the service (data is kept):  .\setup-windows.ps1 -Uninstall
#>
#Requires -RunAsAdministrator
param(
  [string]$InstallDir = "C:\GNSSLog",
  [int]$Port = 8787,
  [string]$Repo = "alden000/gnsslog",
  [string]$Branch = "claude/vessel-tracking-pwa-w2jav3",
  [string]$TunnelToken = "",
  [string]$BackupDir = "",
  [string]$AccessTeam = "",
  [string]$AccessAud = "",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is much faster without the progress bar
$TaskName = "GNSS Log Hub"

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}
function Node-Version {
  try { return [version]((& node -v) -replace '^v', '') } catch { return $null }
}

if ($Uninstall) {
  Step "Removing the scheduled task (data in $InstallDir\data is kept)"
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Done. To remove the tunnel service as well: cloudflared service uninstall"
  exit 0
}

# ---------------------------------------------------------------- 1. Node.js
Step "Node.js"
$need = [version]"22.13.0"
$v = Node-Version
if (-not $v -or $v -lt $need) {
  Write-Host "Installing Node.js LTS with winget..."
  winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements
  Refresh-Path
  $v = Node-Version
  if (-not $v -or $v -lt $need) { throw "Node.js $need or newer is required (found '$v'). Install it from https://nodejs.org and run this script again." }
}
$node = (Get-Command node).Source
Write-Host "Node $v at $node"

# ---------------------------------------------------------------- 2. code
$app = Join-Path $InstallDir "app"
$data = Join-Path $InstallDir "data"
New-Item -ItemType Directory -Force -Path $InstallDir, $data | Out-Null

Step "Downloading $Repo ($Branch)"
$zip = Join-Path $env:TEMP "gnsslog-hub.zip"
$tmp = Join-Path $env:TEMP ("gnsslog-hub-" + [guid]::NewGuid())
Invoke-WebRequest -Uri "https://codeload.github.com/$Repo/zip/refs/heads/$Branch" -OutFile $zip -UseBasicParsing
Expand-Archive -Path $zip -DestinationPath $tmp
$src = Get-ChildItem $tmp | Select-Object -First 1
if (-not (Test-Path (Join-Path $src.FullName "hub\server.mjs"))) { throw "The download does not contain hub\server.mjs (wrong branch?)" }

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
if (Test-Path $app) { Remove-Item $app -Recurse -Force }
Move-Item $src.FullName $app
Remove-Item $tmp, $zip -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Installed to $app"

# ---------------------------------------------------------------- 3. config
Step "Configuration"
$cfgPath = Join-Path $data "hub-config.json"
if (Test-Path $cfgPath) {
  $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
  Write-Host "Keeping $cfgPath"
} else {
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = -join ($bytes | ForEach-Object { $_.ToString("x2") })
  $cfg = [ordered]@{ port = $Port; host = "127.0.0.1"; dataDir = $data; ingestToken = $token; backupKeep = 14 }
  # UTF-8 without BOM
  [IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json))
  $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
  Write-Host "Created $cfgPath"
}
# Cloudflare Access (team + application audience) can be set or changed on any run.
$changed = $false
foreach ($pair in @(@("accessTeam", $AccessTeam), @("accessAud", $AccessAud), @("backupDir", $BackupDir))) {
  if ($pair[1]) { $cfg | Add-Member -NotePropertyName $pair[0] -NotePropertyValue $pair[1] -Force; $changed = $true }
}
if ($changed) { [IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json)) }
if (-not $cfg.accessTeam -or -not $cfg.accessAud) {
  Write-Warning "Cloudflare Access is not configured (-AccessTeam / -AccessAud): the analyser will refuse requests through the tunnel until it is. Uploads work."
}
# Only SYSTEM and administrators may read the data folder (it holds the token and the logs).
icacls $data /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null

# ---------------------------------------------------------------- 4. service (scheduled task)
Step "Background service"
$nodeArgs = "--disable-warning=ExperimentalWarning `"$app\hub\server.mjs`" --config `"$cfgPath`""
$action = New-ScheduledTaskAction -Execute $node -Argument $nodeArgs -WorkingDirectory $app
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.port)/api/health" -TimeoutSec 2
    if ($h.ok) { $ok = $true; break }
  } catch {}
}
if ($ok) { Write-Host "Hub is running: http://127.0.0.1:$($cfg.port)/" -ForegroundColor Green }
else { Write-Warning "The hub did not answer. See $data\hub.log, or run it by hand: `"$node`" $nodeArgs" }

# ---------------------------------------------------------------- 5. Cloudflare Tunnel
Step "Cloudflare Tunnel"
$cf = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cf) {
  Write-Host "Installing cloudflared with winget..."
  winget install --id Cloudflare.cloudflared -e --silent --accept-source-agreements --accept-package-agreements
  Refresh-Path
  $cf = Get-Command cloudflared -ErrorAction SilentlyContinue
}
$cfExe = if ($cf) { $cf.Source } else { "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe" }
if ($TunnelToken) {
  if (Get-Service cloudflared -ErrorAction SilentlyContinue) {
    & $cfExe service uninstall | Out-Null
    Start-Sleep -Seconds 2
  }
  & $cfExe service install $TunnelToken
  Write-Host "Tunnel service installed." -ForegroundColor Green
} elseif (Get-Service cloudflared -ErrorAction SilentlyContinue) {
  Write-Host "Tunnel service already installed (pass -TunnelToken to replace it)."
} else {
  Write-Warning "No -TunnelToken given: the hub is only reachable on this PC. See hub\README.md, step 2."
}

# ---------------------------------------------------------------- summary
Write-Host ""
Write-Host "--------------------------------------------------------------------" -ForegroundColor Cyan
Write-Host " GNSS Log hub"
Write-Host "   Analyzer (this PC):  http://127.0.0.1:$($cfg.port)/"
Write-Host "   Data + logs:         $data"
Write-Host ""
Write-Host " Phone app -> Settings -> Cloud upload"
Write-Host "   Endpoint URL:  https://<your ingest hostname>/ingest"
Write-Host "   Auth header:   Authorization"
Write-Host "   Value:         Bearer $($cfg.ingestToken)"
Write-Host "--------------------------------------------------------------------" -ForegroundColor Cyan
