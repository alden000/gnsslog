<#
  GNSS Log hub — install or update on Windows (the mini PC).

  Run in an *administrator* PowerShell:
    Set-ExecutionPolicy -Scope Process Bypass
    .\setup-windows.ps1 -TunnelToken <tunnel token> -AccessTeam <team name> -AccessAud <AUD tag>

  Run it again at any time to update to the latest code; settings, the ingest token and all
  data are kept. What it does:
    1. installs Node.js LTS (winget) if Node 22.13+ is missing
    2. gets the code: with -AppDir, a git checkout there (cloned, or updated with git pull);
       otherwise a download from GitHub into <InstallDir>\app
    3. creates <data>\hub-config.json with a random ingest token (first run only). Data lives in
       -DataDir, default <AppDir>-data (e.g. D:\GIT\gnsslog-data) or <InstallDir>\data
    4. registers the "GNSS Log Hub" scheduled task: starts at boot as SYSTEM, restarts on failure
    5. installs cloudflared and, with -TunnelToken, runs the tunnel as a Windows service
    6. checks http://127.0.0.1:<port>/api/health
    7. with -AppDir: registers "GNSS Log Hub Updater", which checks GitHub every 5 minutes and
       updates + restarts the hub by itself (hub\auto-update.ps1; off with -NoAutoUpdate)

  From a git checkout:  .\setup-windows.ps1 -AppDir D:\GIT\gnsslog -TunnelToken ...
  An existing cloudflared service for another tunnel is never replaced unless -ReplaceTunnel is given.
  Remove the services (data is kept):  .\setup-windows.ps1 -Uninstall
#>
#Requires -RunAsAdministrator
param(
  [string]$InstallDir = "C:\GNSSLog",
  [string]$AppDir = "",
  [string]$DataDir = "",
  [int]$Port = 8787,
  [string]$Repo = "alden000/gnsslog",
  [string]$Branch = "claude/vessel-tracking-pwa-w2jav3",
  [string]$TunnelToken = "",
  [string]$BackupDir = "",
  [string]$AccessTeam = "",
  [string]$AccessAud = "",
  [switch]$ReplaceTunnel,
  [switch]$NoAutoUpdate,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is much faster without the progress bar
$TaskName = "GNSS Log Hub"
$UpdaterTask = "GNSS Log Hub Updater"

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}
function Node-Version {
  try { return [version]((& node -v) -replace '^v', '') } catch { return $null }
}

if ($Uninstall) {
  Step "Removing the scheduled task (code and data are kept)"
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $UpdaterTask -Confirm:$false -ErrorAction SilentlyContinue
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
if ($AppDir) {
  $app = $AppDir.TrimEnd('\')
  $data = if ($DataDir) { $DataDir } else { "$app-data" }
} else {
  $app = Join-Path $InstallDir "app"
  $data = if ($DataDir) { $DataDir } else { Join-Path $InstallDir "data" }
}
New-Item -ItemType Directory -Force -Path $data | Out-Null
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($AppDir) {
  Step "Git checkout $app ($Branch)"
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "git is not installed (winget install Git.Git), or run without -AppDir to download a copy instead." }
  if (Test-Path (Join-Path $app ".git")) {
    $dirty = git -C $app status --porcelain --untracked-files=no
    if ($dirty) {
      Write-Warning "Local changes in $app; not updating it (commit or stash them, then run again)."
    } else {
      git -C $app fetch origin $Branch
      git -C $app checkout $Branch
      git -C $app pull --ff-only origin $Branch
    }
  } elseif (Test-Path $app) {
    if (-not (Test-Path (Join-Path $app "hub\server.mjs"))) { throw "$app exists but is neither a git checkout nor a copy of GNSS Log." }
    Write-Host "Using the files already in $app (not a git checkout, not updated)."
  } else {
    New-Item -ItemType Directory -Force -Path (Split-Path $app) | Out-Null
    git clone --branch $Branch "https://github.com/$Repo.git" $app
  }
  if (-not (Test-Path (Join-Path $app "hub\server.mjs"))) { throw "hub\server.mjs is missing in $app (wrong branch?)" }
} else {
  Step "Downloading $Repo ($Branch)"
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $zip = Join-Path $env:TEMP "gnsslog-hub.zip"
  $tmp = Join-Path $env:TEMP ("gnsslog-hub-" + [guid]::NewGuid())
  Invoke-WebRequest -Uri "https://codeload.github.com/$Repo/zip/refs/heads/$Branch" -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $tmp
  $src = Get-ChildItem $tmp | Select-Object -First 1
  if (-not (Test-Path (Join-Path $src.FullName "hub\server.mjs"))) { throw "The download does not contain hub\server.mjs (wrong branch?)" }
  Start-Sleep -Seconds 2
  if (Test-Path $app) { Remove-Item $app -Recurse -Force }
  Move-Item $src.FullName $app
  Remove-Item $tmp, $zip -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "Code: $app   Data: $data"

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
if ($PSBoundParameters.ContainsKey("Port") -and $cfg.port -ne $Port) { $cfg.port = $Port; $changed = $true }
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
# The hub was stopped above; anything still listening on the port is another program.
Start-Sleep -Seconds 1
$busy = Get-NetTCPConnection -LocalPort $cfg.port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($busy) {
  $proc = Get-Process -Id $busy.OwningProcess -ErrorAction SilentlyContinue
  throw ("Port $($cfg.port) is already used by '$($proc.ProcessName)' (PID $($busy.OwningProcess), $($proc.Path)). " +
    "Run again with -Port <free port> and point the tunnel's public hostname (logs.wwweeeiii.com) at http://localhost:<that port>.")
}
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

# ---------------------------------------------------------------- 4b. automatic updates
if ($AppDir -and -not $NoAutoUpdate) {
  Step "Automatic updates"
  $gitExe = (Get-Command git).Source
  $ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $upArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$app\hub\auto-update.ps1`" " +
    "-AppDir `"$app`" -DataDir `"$data`" -Branch `"$Branch`" -Git `"$gitExe`" -Port $($cfg.port) -TaskName `"$TaskName`""
  $upAction = New-ScheduledTaskAction -Execute $ps -Argument $upArgs -WorkingDirectory $app
  $upTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
  $upSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
  Register-ScheduledTask -TaskName $UpdaterTask -Action $upAction -Trigger $upTrigger -Settings $upSettings -Principal $principal -Force | Out-Null
  Write-Host "Checks GitHub every 5 minutes and updates + restarts the hub by itself. Log: $data\update.log" -ForegroundColor Green
} elseif (Get-ScheduledTask -TaskName $UpdaterTask -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $UpdaterTask -Confirm:$false
  Write-Host "Automatic updates turned off."
}

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
$svc = Get-Service cloudflared -ErrorAction SilentlyContinue
if ($TunnelToken) {
  $current = if ($svc) { (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\cloudflared" -ErrorAction SilentlyContinue).ImagePath } else { $null }
  if ($svc -and $current -and $current.Contains($TunnelToken)) {
    Write-Host "The cloudflared service already runs this tunnel; leaving it as it is." -ForegroundColor Green
  } elseif ($svc -and -not $ReplaceTunnel) {
    Write-Warning ("A cloudflared service for a DIFFERENT tunnel is already installed. It was left alone, because other sites may depend on it. " +
      "Either add the public hostname logs.wwweeeiii.com -> http://localhost:$($cfg.port) to that existing tunnel in the Cloudflare dashboard " +
      "(no -TunnelToken needed), or run again with -ReplaceTunnel to switch this PC to the new tunnel.")
  } else {
    if ($svc) {
      & $cfExe service uninstall | Out-Null
      Start-Sleep -Seconds 2
    }
    & $cfExe service install $TunnelToken
    Write-Host "Tunnel service installed." -ForegroundColor Green
  }
} elseif ($svc) {
  Write-Host "A cloudflared service is already installed and was left as it is. Make sure its tunnel routes logs.wwweeeiii.com to http://localhost:$($cfg.port)."
} else {
  Write-Warning "No -TunnelToken given: the hub is only reachable on this PC. See hub\README.md, step 1."
}

# ---------------------------------------------------------------- summary
Write-Host ""
Write-Host "--------------------------------------------------------------------" -ForegroundColor Cyan
Write-Host " GNSS Log hub"
Write-Host "   Analyzer (this PC):  http://127.0.0.1:$($cfg.port)/"
Write-Host "   Data + logs:         $data"
Write-Host ""
Write-Host " Phones: open the analyser through its internet address -> Phones -> Pair a phone,"
Write-Host "   then in the app: Settings -> Cloud upload -> Scan QR code (or Enter code)."
Write-Host "--------------------------------------------------------------------" -ForegroundColor Cyan
