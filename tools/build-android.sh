#!/usr/bin/env bash
# Builds the GNSS Log Android APK on Linux/macOS. Needs Node 20+, JDK 21 and ANDROID_HOME.
#
# Release signing (recommended): set
#   GNSSLOG_KEYSTORE=/path/to/gnsslog-release.p12
#   GNSSLOG_KEYSTORE_PASSWORD=...        (or GNSSLOG_KEYSTORE_PASSWORD_FILE=/path/to/password.txt)
#   GNSSLOG_KEY_ALIAS=gnsslog            (optional, default gnsslog)
# The APK is then signed with the release key plus android/app/signing-lineage.bin, which proves
# the earlier debug key handed over to it, so it installs over debug-signed builds without
# losing data (Android 9+). Without these variables a debug-signed APK is built.
#
# Private build with the upload settings preset: GNSSLOG_PRESET_FILE=/path/to/preset.json with
#   { "endpoint": "https://…/ingest", "authHeader": "Authorization", "authValue": "Bearer …" }
# Keep that file out of the repository; anyone with the APK can read the token from it.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ANDROID_HOME:?Set ANDROID_HOME to your Android SDK}"
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
npm ci --no-audit --no-fund
node tools/build-www.mjs
npx cap sync android
ver=$(node -p "require('./package.json').version")
out="GNSS-Log-$ver.apk"

if [ -n "${GNSSLOG_KEYSTORE:-}" ]; then
  if [ -z "${GNSSLOG_KEYSTORE_PASSWORD:-}" ] && [ -n "${GNSSLOG_KEYSTORE_PASSWORD_FILE:-}" ]; then
    GNSSLOG_KEYSTORE_PASSWORD=$(cat "$GNSSLOG_KEYSTORE_PASSWORD_FILE")
  fi
  : "${GNSSLOG_KEYSTORE_PASSWORD:?Set GNSSLOG_KEYSTORE_PASSWORD or GNSSLOG_KEYSTORE_PASSWORD_FILE}"
  export GNSSLOG_KEYSTORE_PASSWORD
  (cd android && ./gradlew assembleRelease)
  bt=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)
  "$bt/apksigner" sign \
    --lineage android/app/signing-lineage.bin --rotation-min-sdk-version 28 --v4-signing-enabled false \
    --ks android/app/gnsslog-debug.keystore --ks-pass pass:android --ks-key-alias androiddebugkey \
    --next-signer --ks "$GNSSLOG_KEYSTORE" --ks-pass env:GNSSLOG_KEYSTORE_PASSWORD --ks-key-alias "${GNSSLOG_KEY_ALIAS:-gnsslog}" \
    --out "$out" android/app/build/outputs/apk/release/app-release-unsigned.apk
  "$bt/apksigner" verify --print-certs "$out" | grep -E "Signer|DN" || true
  echo "Done (release-signed): $out"
else
  (cd android && ./gradlew assembleDebug)
  cp android/app/build/outputs/apk/debug/app-debug.apk "$out"
  echo "Done (debug-signed; set GNSSLOG_KEYSTORE for a release build): $out"
fi
