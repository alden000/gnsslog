# Builds the GNSS Log Android app (APK) on Windows.
#   powershell -ExecutionPolicy Bypass -File tools\build-android.ps1           # build
#   powershell -ExecutionPolicy Bypass -File tools\build-android.ps1 -Install  # build + install over USB (adb)
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

Write-Host '== Building APK (first build downloads Gradle and libraries, ~5-10 min)' -ForegroundColor Cyan
Push-Location android
.\gradlew.bat assembleDebug
$code = $LASTEXITCODE
Pop-Location
if ($code) { exit $code }

$ver = (Get-Content package.json | ConvertFrom-Json).version
$out = "GNSS-Log-$ver.apk"
Copy-Item android\app\build\outputs\apk\debug\app-debug.apk $out -Force
Write-Host "== Done: $(Resolve-Path $out)" -ForegroundColor Green

if ($Install) {
  $adb = "$env:ANDROID_HOME\platform-tools\adb.exe"
  Need (Test-Path $adb) 'adb (Android SDK platform-tools).'
  & $adb install -r $out
}
