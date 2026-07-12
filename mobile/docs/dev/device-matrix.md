# Manual device-matrix protocol (mobile-sync)

> Per-**release** manual protocol for the sync flows the desktop `tauri-driver` E2E harness
> cannot reach (no iOS/Android WebDriver). This is the compensating coverage named in the
> `docs/decisions.md` 2026-07-07 "Mobile-sync device-level UI E2E exemption (SYNC-44)" entry.
> **iOS-only (v1)** — Android rows are out of scope (SYNC-46; Android enablement = MYND-465).
> Automated device drivers are MYND-467, not this doc.

## 0. Scope + bans

- **Physical iPhone required** — the sync lifecycle (suspend/resume, background grace-lock) and
  the SAS eye-compare cannot be validated on the host or in CI.
- **No cloud device farms.** BrowserStack / Firebase Test Lab / any third-party service touching a
  debug build is **banned** — a debug build carries the plaintext trust boundary; it never leaves a
  device you control.

## 1. Sideload path (proven)

```bash
# From myne-mobile/:
pnpm tauri ios build --export-method debugging      # unsigned debug .ipa/.app for a real device
xcrun devicectl device install app --device <UDID> <path-to.app>   # install onto the iPhone
```

Two known traps (both cost an hour if you hit them cold):

1. **A locked iPhone will not mount the Developer Disk Image (DDI).** `devicectl` install fails until
   the device is **unlocked and trusts the Mac**. Unlock first, then install.
2. **The iOS platform stub needs `downloadPlatform`.** A fresh Xcode / a new iOS version may report a
   missing platform — run the Xcode platform download (`xcodebuild -downloadPlatform iOS` or the
   Settings → Components pane) before `tauri ios build`.

See `mobile-iphone-sideload` (internal note) for the full first-run walkthrough.

## 2. WKWebView version-matrix axis

The rendering engine is **WKWebView ≠ Android WebView ≠ desktop Chromium** (`myne-mobile/CLAUDE.md`):
CSS, font rendering, storage quotas, and gesture handling differ. **Per release, pick the iOS OS /
WKWebView versions to cover** — at minimum the **oldest supported iOS** and the **current iOS** on a
real device. Note the device model + iOS build in the run log so a render regression is bisectable.

## 3. Sync scenarios (aligned to the ratified decisions)

Walk each on a physical iPhone, against a real (or LAN self-host) server:

| # | Scenario | Expected (ratified decision) |
|---|---|---|
| 3.1 | **Foreground poll** — edit a note on device A, watch device B (both foregrounded) | B pulls the change at poll cadence (foreground-only; SYNC-37) |
| 3.2 | **Flush-on-suspend** — edit on A, immediately background A | the pending push flushes within the OS grace window before suspend (SYNC-37/38) |
| 3.3 | **Resume-immediate-poll** — background A past a poll interval, foreground it | A pulls immediately on resume (does not wait a full interval; SYNC-38) |
| 3.4 | **Grace-lock** — unlock, background past `auto_lock_seconds`, reopen | the vault is **locked** before any note renders (quick-unlock/PIN appears); a sub-timeout background stays unlocked |
| 3.5 | **Enroll + SAS** — join a new device by password; approve from an existing device | **approve-then-verify** (SYNC-40): approve first, then eye-compare the Crockford `XXXX-XXXX` fingerprint on both screens; a **mismatch → Remove device** (never "accept anyway") |
| 3.6 | **Recovery join** — join with the 24-word phrase only | self-approves (no pending), mints + unlocks the vault (SYNC-9) |
| 3.7 | **Conflict-copy** — concurrently edit the same note on A + B | the loser lands as a `conflict:`/`conflict_of:` managed-frontmatter note (SYNC-11), never a silent overwrite |
| 3.8 | **Convergence / no-false-conflict spot-check** — a few rounds of alternating edits across A + B | both devices converge; no spurious conflict copies |
| 3.9 | **Remove device** — revoke a device's token from another device | the removed device stops syncing; the honest-disclosure copy is shown (not a "remote wipe" claim) |

## 4. Biometric handling

- **Default: `xcrun simctl` simulator enrollment** for Face ID / Touch ID during scenario walks
  (`xcrun simctl ui <sim> …` / the simulator's Features → Face ID menu on the simulator; on a real
  device use the actual biometric).
- A **test-only build-flag that bypasses the biometric prompt is NOT used** and MUST NOT be added
  here. Introducing one is a **threat-model-reviewed `decisions.md` event** (M-R7), not a test
  convenience — a bypass flag that leaks into a release build is a security regression.

## 5. Cadence

**Per release.** Log device model + iOS build + server (hosted / self-host) + pass/fail per scenario
row. A failed row is stop-the-world for the release, same discipline as a failed vector.
