# Builds the GNSS Log Android app (APK) on Windows.
#   powershell -ExecutionPolicy Bypass -File tools\build-android.ps1           # build
#   powershell -ExecutionPolicy Bypass -File tools\build-android.ps1 -Install  # build + install over USB (adb)
# Release signing (recommended): set these first, e.g. in the same PowerShell window
#   $env:GNSSLOG_KEYSTORE = 'C:\keys\gnsslog-release.p12'
#   $env:GNSSLOG_KEYSTORE_PASSWORD_FILE = 'C:\keys\password.txt'   # or $env:GNSSLOG_KEYSTORE_PASSWORD
# The APK is then signed with the release key plus android\app\signing-lineage.bin (proof that the
# earlier debug key handed over to it), so it installs over older builds without losing data.
# Needs: Node.js 20+, and Android Studio (provides the JDK 21 and the Android SDK), or a JDK 21
# plus Android SDK with JAVA_HOME / ANDROID_HOME set.
param([switch]$Install)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Need($ok, $msg) { if (-not $ok) { Write-Host "MISSING: $msg" -ForegroundColor Red; exit 1 } }

# --- JDK (Android Studio bundles one under jbr)
if (-not $env:JAVA_HOME) {
  foreach ($p in @("$env:ProgramFiles\Android\Android Studio\jbr", "$env:LOCALAPPDATA\Programs\Android Studio\jbr")) {
    if (Test-Path "$p\bin\java.exe") { $env:JAVA_HOME = $p; break }
  }
}
Need ($env:JAVA_HOME -and (Test-Path "$env:JAVA_HOME\bin\java.exe")) 'JDK 21. Install Android Studio (https://developer.android.com/studio) or Temurin JDK 21 and set JAVA_HOME.'
$env:Path = "$env:JAVA_HOME\bin;$env:Path"

# --- Android SDK
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = $env:ANDROID_SDK_ROOT }
if (-not $env:ANDROID_HOME -and (Test-Path "$env:LOCALAPPDATA\Android\Sdk")) { $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk" }
Need ($env:ANDROID_HOME -and (Test-Path $env:ANDROID_HOME)) 'Android SDK. Open Android Studio once (it installs the SDK) or set ANDROID_HOME.'
"sdk.dir=$($env:ANDROID_HOME -replace '\\', '/')" | Set-Content -Encoding ascii android\local.properties
Need (Get-Command node -ErrorAction SilentlyContinue) 'Node.js 20+ (https://nodejs.org).'

Write-Host '== Installing JS dependencies' -ForegroundColor Cyan
npm ci --no-audit --no-fund
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Write-Host '== Copying web app into the Android project' -ForegroundColor Cyan
node tools/build-www.mjs
npx cap sync android
if ($LASTEXITCODE) { exit $LASTEXITCODE }

$ver = (Get-Content package.json | ConvertFrom-Json).version
$out = "GNSS-Log-$ver.apk"
$release = [bool]$env:GNSSLOG_KEYSTORE
if ($release) {
  Need (Test-Path $env:GNSSLOG_KEYSTORE) "release keystore at $env:GNSSLOG_KEYSTORE"
  if (-not $env:GNSSLOG_KEYSTORE_PASSWORD -and $env:GNSSLOG_KEYSTORE_PASSWORD_FILE) {
    $env:GNSSLOG_KEYSTORE_PASSWORD = (Get-Content -Raw $env:GNSSLOG_KEYSTORE_PASSWORD_FILE).Trim()
  }
  Need $env:GNSSLOG_KEYSTORE_PASSWORD 'GNSSLOG_KEYSTORE_PASSWORD or GNSSLOG_KEYSTORE_PASSWORD_FILE'
}

Write-Host '== Building APK (first build downloads Gradle and libraries, ~5-10 min)' -ForegroundColor Cyan
Push-Location android
if ($release) { .\gradlew.bat assembleRelease } else { .\gradlew.bat assembleDebug }
$code = $LASTEXITCODE
Pop-Location
if ($code) { exit $code }

if ($release) {
  $bt = Get-ChildItem "$env:ANDROID_HOME\build-tools" -Directory | Sort-Object { [version]($_.Name -replace '[^0-9.]', '') } | Select-Object -Last 1
  $alias = if ($env:GNSSLOG_KEY_ALIAS) { $env:GNSSLOG_KEY_ALIAS } else { 'gnsslog' }
  & "$($bt.FullName)\apksigner.bat" sign `
    --lineage android\app\signing-lineage.bin --rotation-min-sdk-version 28 `
    --ks android\app\gnsslog-debug.keystore --ks-pass pass:android --ks-key-alias androiddebugkey `
    --next-signer --ks $env:GNSSLOG_KEYSTORE --ks-pass env:GNSSLOG_KEYSTORE_PASSWORD --ks-key-alias $alias `
    --out $out android\app\build\outputs\apk\release\app-release-unsigned.apk
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
  Write-Host "== Done (release-signed): $(Resolve-Path $out)" -ForegroundColor Green
} else {
  Copy-Item android\app\build\outputs\apk\debug\app-debug.apk $out -Force
  Write-Host "== Done (debug-signed; set GNSSLOG_KEYSTORE for a release build): $(Resolve-Path $out)" -ForegroundColor Green
}

if ($Install) {
  $adb = "$env:ANDROID_HOME\platform-tools\adb.exe"
  Need (Test-Path $adb) 'adb (Android SDK platform-tools).'
  & $adb install -r $out
}
