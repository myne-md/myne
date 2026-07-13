#!/usr/bin/env bash
# Re-applies the committed Android widget wiring that a fresh
# `tauri android init` clobbers (src-tauri/gen/android is git-ignored).
# Idempotent — safe to run repeatedly. The manifest-level wiring (mic
# permissions, shortcuts <meta-data>) needs no step here: src-tauri/build.rs
# re-injects it on every `tauri android dev/build`. See
# android-widgets/README.md for the full wiring story.
set -euo pipefail
cd "$(dirname "$0")/.."

SETTINGS=src-tauri/gen/android/settings.gradle
APP_GRADLE=src-tauri/gen/android/app/build.gradle.kts

if [ ! -f "$SETTINGS" ]; then
  echo "error: $SETTINGS not found — run 'pnpm tauri android init' first" >&2
  exit 1
fi

if grep -q "myne-widgets" "$SETTINGS"; then
  echo "settings.gradle: myne-widgets already included"
else
  cat >>"$SETTINGS" <<'EOF'

// MYNE WIDGETS — committed module outside the regenerated tree; this block is
// re-applied by scripts/android-postinit.sh (see android-widgets/README.md).
include ':myne-widgets'
project(':myne-widgets').projectDir = new File(rootDir, '../../../android-widgets')
EOF
  echo "settings.gradle: myne-widgets include added"
fi

if grep -q "myne-widgets" "$APP_GRADLE"; then
  echo "app/build.gradle.kts: myne-widgets already wired"
else
  cat >>"$APP_GRADLE" <<'EOF'

// MYNE WIDGETS — re-applied by scripts/android-postinit.sh (android-widgets/README.md).
dependencies {
    implementation(project(":myne-widgets"))
}
EOF
  echo "app/build.gradle.kts: myne-widgets dependency added"
fi

# App icons: init stamps stock Tauri icons into gen/; restore the Myne set.
# (Also runs on every dev/build via the tauri.conf.json hooks — this call
# just makes a fresh init correct immediately.)
bash scripts/sync-icons.sh
