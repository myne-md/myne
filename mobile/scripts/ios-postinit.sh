#!/usr/bin/env bash
# Re-applies the committed iOS project definition that a fresh `tauri ios init`
# clobbers (src-tauri/gen/apple is git-ignored and regenerated wholesale).
#
# This is the ONE true re-apply step for iOS, the sibling of
# `scripts/android-postinit.sh`. It copies the committed source of truth
# (`src-tauri/ios/project.yml`) onto `src-tauri/gen/apple/project.yml`,
# substitutes the __MYNE_*__ placeholders from the live build config, and runs
# `xcodegen generate`.
#
# Without it the Xcode project has NO MyneWidgets / MyneWatch /
# MyneWatchComplications targets and the released/TestFlight app silently ships
# WITHOUT the home/lock widgets, the Apple Watch app and its complication, and
# the WatchConnectivity receiver. Nothing fails; the targets are just absent.
# myne-md/myne#803. See ios-widgets/README.md and ios-watch/README.md.
#
# Idempotent — safe to run repeatedly. The output is deterministic: `gen/apple/
# project.yml` always equals the committed spec with the placeholders resolved,
# so a hand edit there is intentionally discarded.
set -euo pipefail
cd "$(dirname "$0")/.."

SPEC=src-tauri/ios/project.yml
GEN_DIR=src-tauri/gen/apple
DEST="$GEN_DIR/project.yml"

if [ ! -f "$SPEC" ]; then
  echo "error: $SPEC not found — the committed iOS project spec is missing" >&2
  exit 1
fi
if [ ! -f "$DEST" ]; then
  echo "error: $DEST not found — run 'pnpm tauri ios init' first" >&2
  exit 1
fi
if ! command -v xcodegen >/dev/null 2>&1; then
  echo "error: xcodegen not found — 'brew install xcodegen'" >&2
  exit 1
fi

# Version + build number — the SAME values `tauri ios build` derives, so the
# embedded widget/watch Info.plists (which read $(MARKETING_VERSION) /
# $(CURRENT_PROJECT_VERSION)) match the app exactly. App Store validation
# rejects an extension whose CFBundleShortVersionString/CFBundleVersion differs
# from its containing app.
#
#   CFBundleShortVersionString = tauri.conf.json `version` (first three parts)
#   CFBundleVersion            = bundle.iOS.bundleVersion ?? version
#                                [+ "." + <build number>]
#
# `--build-number N` is passed to `tauri ios build`; callers that need it must
# export the same N as MYNE_IOS_BUILD_NUMBER so the extension plists agree. The
# release runbook passes it through.
VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
BUNDLE_VERSION=$(node -p "const c=require('./src-tauri/tauri.conf.json'); (c.bundle && c.bundle.iOS && c.bundle.iOS.bundleVersion) || ''")
CURRENT="${BUNDLE_VERSION:-$VERSION}"
if [ -n "${MYNE_IOS_BUILD_NUMBER:-}" ]; then
  CURRENT="$CURRENT.${MYNE_IOS_BUILD_NUMBER}"
fi
MARKETING="$VERSION"

# Signing team. The embedded extension/watch targets are NOT touched by Tauri's
# pbxproj synchronization (it patches only the `<scheme>` config list), so each
# target needs its own DEVELOPMENT_TEAM or xcodebuild stops on "requires a
# development team". Read it from the same env var Tauri reads, then from
# tauri.conf.json, then leave it empty (an unsigned/simulator build still works).
TEAM="${APPLE_DEVELOPMENT_TEAM:-}"
if [ -z "$TEAM" ]; then
  TEAM=$(node -p "const c=require('./src-tauri/tauri.conf.json'); (c.bundle && c.bundle.iOS && c.bundle.iOS.developmentTeam) || ''")
fi

node -e '
  const fs = require("fs");
  const [src, dest, team, marketing, current] = process.argv.slice(1);
  let s = fs.readFileSync(src, "utf8");
  s = s
    .split("__MYNE_DEVELOPMENT_TEAM__").join(team)
    .split("__MYNE_MARKETING_VERSION__").join(marketing)
    .split("__MYNE_CURRENT_PROJECT_VERSION__").join(current);
  fs.writeFileSync(dest, s);
' "$SPEC" "$DEST" "$TEAM" "$MARKETING" "$CURRENT"

( cd "$GEN_DIR" && xcodegen generate )

echo "ios-postinit: project.yml wired (widgets + watch), version $MARKETING / $CURRENT, team ${TEAM:-<unset>}"

# App icons: init stamps stock Tauri icons into gen/; restore the Myne set.
# (Also runs on every dev/build via the tauri.conf.json hooks — this call just
# makes a fresh init correct immediately, exactly as android-postinit.sh does.)
bash scripts/sync-icons.sh
