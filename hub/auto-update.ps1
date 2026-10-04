<#
  GNSS Log hub - automatic update. setup-windows.ps1 registers it as the "GNSS Log Hub Updater"
  scheduled task (every 5 minutes, as SYSTEM) when the hub runs from a git checkout (-AppDir).

  Each run: git fetch; when the branch has new commits and the checkout has no local changes,
  fast-forward to them, restart the "GNSS Log Hub" task and wait for /api/health. If the hub does
  not come back, it returns to the previous commit, restarts again and skips the bad commit until a
  newer one arrives. Everything is logged to <data>\update.log.

  This file is part of the checkout, so it updates itself along with everything else.
#>
param(
  [Parameter(Mandatory = $true)][string]$AppDir,
  [Parameter(Mandatory = $true)][string]$DataDir,
  [string]$Branch = "claude/vessel-tracking-pwa-w2jav3",
  [string]$Git = "git",
  [int]$Port = 8787,
  [string]$TaskName = "GNSS Log Hub"
)

$ErrorActionPreference = "Continue"   # git writes progress to stderr; check $LASTEXITCODE instead
$log = Join-Path $DataDir "update.log"
$badFile = Join-Path $DataDir "update-bad-commit.txt"

function Log($msg) {
  $line = "{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
}
# The checkout belongs to the user who cloned it; SYSTEM would hit git's "dubious ownership" check.
function G { & $Git -c safe.directory=* -C $AppDir @args 2>&1 }
function Healthy {
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
      $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
      if ($h.ok) { return $true }
    } catch {}
  }
  return $false
}
function Restart-Hub {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName $TaskName
}

# Keep the log short: the last 500 lines.
if ((Test-Path $log) -and (Get-Item $log).Length -gt 200KB) {
  $tail = Get-Content $log -Tail 500
  Set-Content -Path $log -Value $tail -Encoding UTF8
}

$out = G fetch -q origin $Branch
if ($LASTEXITCODE -ne 0) { Log "fetch failed: $out"; exit 1 }

$head = (G rev-parse HEAD | Out-String).Trim()
$remote = (G rev-parse "origin/$Branch" | Out-String).Trim()
if ($head -eq $remote) { exit 0 }

$bad = if (Test-Path $badFile) { (Get-Content $badFile -Raw).Trim() } else { "" }
if ($remote -eq $bad) { exit 0 }   # already tried and rolled back; wait for a newer commit

$dirty = G status --porcelain --untracked-files=no
if ($dirty) { Log "local changes in $AppDir; not updating ($($remote.Substring(0, 7)) waiting)"; exit 0 }

$branchNow = (G rev-parse --abbrev-ref HEAD | Out-String).Trim()
if ($branchNow -ne $Branch) { Log "checkout is on '$branchNow', not $Branch; not updating"; exit 0 }

$out = G merge -q --ff-only "origin/$Branch"
if ($LASTEXITCODE -ne 0) { Log "fast-forward to $($remote.Substring(0, 7)) failed: $out"; exit 1 }
$subject = (G log -1 --format=%s | Out-String).Trim()
Log "updated $($head.Substring(0, 7)) -> $($remote.Substring(0, 7)): $subject"

Restart-Hub
if (Healthy) {
  Log "hub restarted and healthy"
  if (Test-Path $badFile) { Remove-Item $badFile -Force }
  exit 0
}

Log "hub did not answer after the update; rolling back to $($head.Substring(0, 7))"
Set-Content -Path $badFile -Value $remote -Encoding ASCII
$out = G reset -q --hard $head
if ($LASTEXITCODE -ne 0) { Log "rollback failed: $out" }
Restart-Hub
if (Healthy) { Log "rolled back; hub healthy" } else { Log "hub still not answering after the rollback; see hub.log" }
exit 1
