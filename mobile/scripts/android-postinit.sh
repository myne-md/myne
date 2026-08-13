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

# RELEASE SIGNING — a release APK/AAB signed with a DIFFERENT key than the one
# already installed cannot be updated over it; Android refuses with
# INSTALL_FAILED_UPDATE_INCOMPATIBLE and the only way through is an uninstall,
# which deletes app-private storage — i.e. the on-device vault. v0.1.0 shipped
# signed by a keystore that lived only in the regenerated tree and was lost with
# it, which is exactly why this wiring belongs in the committed script and the
# keystore belongs outside the repo.
#
# The key itself is NOT here and never will be: `keystore.properties` (git-ignored,
# mode 600) names the store path, the alias and the password, and the store lives
# at ~/.myne-release/android/myne-release.keystore with its password in the macOS
# keychain (service `myne-android-keystore`, account `myne`). Without that file the
# block below is inert and the release build is simply unsigned — it never fails
# the build for a developer who has no key.
if grep -q "MYNE RELEASE SIGNING" "$APP_GRADLE"; then
  echo "app/build.gradle.kts: release signing already wired"
else
  cat >>"$APP_GRADLE" <<'EOF'

// MYNE RELEASE SIGNING — re-applied by scripts/android-postinit.sh.
// Inert unless src-tauri/gen/android/keystore.properties exists (git-ignored).
val myneKeystoreProperties = Properties().apply {
    val propFile = rootProject.file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    signingConfigs {
        create("myneRelease") {
            myneKeystoreProperties.getProperty("storeFile")?.let {
                storeFile = file(it)
                storePassword = myneKeystoreProperties.getProperty("password")
                keyAlias = myneKeystoreProperties.getProperty("keyAlias")
                keyPassword = myneKeystoreProperties.getProperty("password")
            }
        }
    }
    buildTypes {
        getByName("release") {
            if (myneKeystoreProperties.getProperty("storeFile") != null) {
                signingConfig = signingConfigs.getByName("myneRelease")
            }
        }
    }
}
EOF
  echo "app/build.gradle.kts: release signing wired"
fi

# App icons: init stamps stock Tauri icons into gen/; restore the Myne set.
# (Also runs on every dev/build via the tauri.conf.json hooks — this call
# just makes a fresh init correct immediately.)
bash scripts/sync-icons.sh
