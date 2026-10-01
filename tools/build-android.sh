#!/usr/bin/env bash
# Builds the GNSS Log Android APK on Linux/macOS. Needs Node 20+, JDK 21 and ANDROID_HOME.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ANDROID_HOME:?Set ANDROID_HOME to your Android SDK}"
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
npm ci --no-audit --no-fund
node tools/build-www.mjs
npx cap sync android
(cd android && ./gradlew assembleDebug)
ver=$(node -p "require('./package.json').version")
cp android/app/build/outputs/apk/debug/app-debug.apk "GNSS-Log-$ver.apk"
echo "Done: GNSS-Log-$ver.apk"
