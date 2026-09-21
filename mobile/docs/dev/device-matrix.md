# Manual device-matrix protocol (mobile-sync)

> Per-**release** manual protocol for the sync flows the desktop `tauri-driver` E2E harness
> cannot reach (no iOS/Android WebDriver). This is the compensating coverage named in the
> `design-notes.md` 2026-07-07 "Mobile-sync device-level UI E2E exemption (SYNC-44)" entry.
> Sync scenario rows (§3) remain **iOS-first** (SYNC-46 shipped iOS-only v1); the **Android
> tablet section (§6) supersedes the former "Android rows are out of scope" line** — Android
> enablement (MYND-465) landed with the tablet-adaptive layout work, and §6 is its per-release
> device protocol. Automated device drivers are MYND-467, not this doc.

## 0. Scope + bans

- **Physical iPhone required** — the sync lifecycle (suspend/resume, background grace-lock) and
  the SAS eye-compare cannot be validated on the host or in CI.
- **No cloud device farms.** BrowserStack / Firebase Test Lab / any third-party service touching a
  debug build is **banned** — a debug build carries the plaintext trust boundary; it never leaves a
  device you control.

## 1. Sideload path (proven)

```bash
# From mobile/:
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

The rendering engine is **WKWebView ≠ Android WebView ≠ desktop Chromium** (`mobile/AGENTS.md`):
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

### 4.1 Biometric quick-unlock verification checklist (MYND-329; decisions.md 2026-07-12)

The Apple-Keychain provider is **UNVERIFIED until this passes on a real device** (the Bitwarden
CVE-2023-27706 failure class — a mis-built access control stores the wrap key WITHOUT an effective
biometric gate, which no compile or simulator run catches). Walk on a physical iPhone:

| # | Scenario | Expected |
|---|---|---|
| 4.1.1 | **Setup** — Settings → Privacy & security → Quick unlock → Face ID toggle on | toggle flips on, toast confirms; NO biometric prompt at setup (the gate fires on redeem) |
| 4.1.2 | **Redeem prompts** — auto-lock, reopen the unlock screen | the Face ID sheet appears **immediately** (auto-prompt); success lands in the editor |
| 4.1.3 | **Cancel is free** — cancel the prompt repeatedly | retry surface shows; attempts counter does NOT burn (no wipe after >5 cancels) |
| 4.1.4 | **Cold start forces password** — kill the app, relaunch | password form only; no biometric affordance (spring-loaded gate) |
| 4.1.5 | **Enrollment change invalidates** — add/remove a face/finger in iOS Settings, then redeem | the OS invalidates the Keychain secret; the app drops to password (credential re-setup required) |
| 4.1.6 | **Password change invalidates** — change the master password, auto-lock, reopen | no biometric affordance; the credential (blob + Keychain item) was wiped |
| 4.1.7 | **Non-authenticated read fails** — attempt the Keychain read without biometric auth (e.g. cancel and inspect via a debugger that the wrap key was NOT returned) | the read errors; no wrap-key bytes reach the app without a passed prompt |

### 4.2 Apple Watch capture drain (§9.18 MYK1; E2E-gap #37)

The watch → WatchConnectivity → device-keychain-sealed MYK1 queue → drain-into-vault path
crosses a transport + a device-keychain seam that no automated tier exercises (the flow-logic
`captures/drain.flow.ts` drives only the JS `take_pending → note_create → ack` against a canned
mock; the Rust seal/queue/decode is cargo-covered; the MYK1 byte layout is vector-covered). This
row is the only coverage of the join between those proven ends. Requires a paired Watch + iPhone.

| # | Scenario | Expected |
|---|---|---|
| 4.2.1 | **Dictate while phone locked** — record a note on the Watch with the iPhone locked | the capture is queued (WatchConnectivity delivered), NOT dropped; nothing decrypts on the Watch |
| 4.2.2 | **Drain on unlock** — unlock the phone, land in the editor | each queued capture becomes a real note and is acked; the MYK1 queue empties (device-keychain `wrap_key` seal, NOT `root_key`-derived) |
| 4.2.3 | **Multi-capture ordering** — dictate several before unlocking | all drain, none lost or duplicated (each `capture_id` acked once) |

## 5. Cadence

**Per release.** Log device model + iOS build + server (hosted / self-host) + pass/fail per scenario
row. A failed row is stop-the-world for the release, same discipline as a failed vector.

## 6. Android tablet (MYND-465)

### 6.1 Sideload / dev-loop path

```bash
# One-time host setup (JDK 21 keg-only + SDK under ~/Library/Android/sdk):
export JAVA_HOME="$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/29.0.13846066"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

# Tablet: Settings → About → tap Build number ×7 → Developer options → USB debugging.
adb devices                          # accept the RSA prompt on the tablet ("always allow")

# Primary dev loop — HMR + getUserMedia both work over the USB cable: the CLI
# sets up `adb reverse tcp:1420`, so the WebView origin is http://localhost:1420
# (a SECURE context). Do NOT use --host/LAN-IP mode for voice testing: an
# insecure LAN origin leaves navigator.mediaDevices undefined (that's the mode,
# not an app bug). The desktop repo's dev server must be DOWN (1420 strictPort).
pnpm tauri android dev

# Install-loop alternative (no dev server; production-shaped origin):
pnpm tauri android build --debug --target aarch64 --apk
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

Debugging: desktop Chrome `chrome://inspect` attaches to the WebView (dev/debug builds) — the main
tool for tablet-layout iteration. Rust logs: `adb logcat -s RustStdoutStderr`.

Regeneration-surviving Android config (the `Info.ios.plist` mirrors — `gen/android` is gitignored):
mic permissions are injected by the committed `src-tauri/build.rs`
(`tauri_utils::build::update_android_manifest`, RECORD_AUDIO + MODIFY_AUDIO_SETTINGS — wry
batch-requests BOTH for getUserMedia audio); the `myne://` intent-filter comes from
`tauri.conf.json` `plugins.deep-link.mobile`. After a fresh `tauri android init`, one
`tauri android build/dev` re-applies both; icons regenerate with `pnpm tauri icon`.

### 6.2 Per-release scenario rows

Log **device model + Android version + System WebView version** per run
(`adb shell dumpsys package com.google.android.webview | grep versionName`) — the WebView
Play-updates independently of the OS and is the real rendering floor (Vite's build target
means a stale 2021-era WebView can fail to parse the bundle at all).

| # | Scenario | Expected |
|---|---|---|
| A.1 | **Cold start → create vault → unlock** | Argon2id (m=256 MiB) completes without an OOM kill; record unlock wall-time (calibration data for the mobile-KDF params decision) |
| A.2 | **PIN quick-unlock** — setup + redeem after auto-lock | works (shared `myne-core` path, same as iOS) |
| A.3 | **Biometric toggle** | absent/disabled — the backend returns `HardwareUnavailable` (no Keystore provider yet); no misleading affordance is shown |
| A.4 | **Note CRUD + attachments + search** | parity with the iOS rows |
| A.5 | **Voice note** | wry's runtime mic prompt appears on first record; grant → encrypted WAV attachment lands; deny → the "Microphone access is off" (SYS-02) state. Must be on the adb-reverse dev loop or an installed build (see §6.1) |
| A.6 | **Rotation mid-edit** | no activity recreation (template `configChanges` covers orientation) — editor content, unlock state, and size-class-appropriate layout all survive |
| A.7 | **Split-screen + freeform resize** | the layout reflows through compact ↔ medium ↔ expanded at each width; no clipped panes; the vault stays unlocked |
| A.8 | **Hardware/gesture back** | current truth: wry's default backgrounds the app from anywhere (SPA, no history entries). Documented v1 behavior; pane-aware back is a separate work item |
| A.9 | **IME / keyboard** | the soft keyboard does not cover the editor caret; external-keyboard basics work |
| A.10 | **Safe-area / cutout / edge-to-edge** | targetSdk 36 on Android 15+ enforces edge-to-edge — check for content under the status bar/cutout in both orientations (WebView safe-area insets are typically 0 on Android) |
| A.11 | **Screenshots / app-switcher preview** | **blocked** — FLAG_SECURE is live via the `tauri-plugin-screen-guard` Kotlin bridge (MYND-469); walk the full §7 checklist (rows 7.8–7.11) for the authoritative pass criteria |
| A.12 | **Background grace-lock** | background past `auto_lock_seconds` → locked before any note renders on resume (same as iOS 3.4) |

## 7. Screen-capture protection verification checklist (MYND-469)

The iOS secure-field layer splice is **UNVERIFIED until this passes on a real device** — the
pre-`b904b58` automatic-apply implementation crashed on-device, and the widely-deployed equivalent
(ScreenProtectorKit) has deprecated the identical technique "due to crashes on some devices". The
current implementation moves the one-time splice to app startup (the timing every deployed
implementation uses), wraps every ObjC call in `objc2::exception::catch`, and branches the
iOS-17 sublayer-order change — but an uncatchable CoreAnimation abort remains possible in theory,
so **a failed row 7.6 reverts the iOS `apply` call to a documented no-op (one line in
`screen_guard.rs::apply`), not a partial ship**. Android's FLAG_SECURE is the authoritative OS
primitive and carries no crash history; its rows run on the §6 tablet loop (`adb` criteria are
scriptable). Record device model + OS build per run — the iOS sublayer branch differs below/at
iOS 17, so the §2 version-matrix axis (oldest device + current iOS) applies here too.

| # | Scenario | Expected |
|---|---|---|
| 7.1 | **iOS cold start, pre-unlock** — launch, screenshot the unlock screen | capture is blank/black (startup splice + always-ON before first frame) |
| 7.2 | **iOS unlocked, protection ON** — screenshot in the editor with a note open | blank; note plaintext never appears in the capture |
| 7.3 | **iOS recording + mirroring, ON** — screen-record and AirPlay-mirror while editing | recorded/mirrored frames blank while the app is frontmost |
| 7.4 | **iOS user opt-out honored** — Settings → Privacy → screen-capture toggle OFF → screenshot | content visible (the toggle is honest both ways) |
| 7.5 | **iOS lock resets to ON** — with the toggle OFF, lock the vault → screenshot the unlock screen | blank again (lock/unlock-fail always re-applies ON) |
| 7.6 | **iOS stability soak (the crash regression)** — toggle ON/OFF ×10, rotate, background/foreground ×5, open/close keyboard, then lock/unlock ×5 | no crash, no black-screen, no layout/rendering artifact (the WKWebView layer-reparenting risk); a failure here is the one-line revert |
| 7.7 | **iOS app-switcher card, ON** — background the app, inspect the switcher | best-effort: record the observed behavior per iOS version — the secure-field trick does not contractually blank the snapshot path (Android's FLAG_SECURE does) |
| 7.8 | **Android capture, ON** — `adb exec-out screencap -p > shot.png` + an on-device screenshot attempt | screencap yields a black frame; the device shows the "can't take screenshot" / blocked-by-policy toast |
| 7.9 | **Android recents, ON** — open the recents overview | the app card is blank |
| 7.10 | **Android opt-out** — toggle OFF → screencap; then lock the vault → screencap | content visible while OFF; black again after lock |
| 7.11 | **Android cold start** — fresh launch, screencap before unlock | black — the Kotlin `load()` applies FLAG_SECURE at plugin registration, before any Rust hook fires |

## 8. Attach-camera + export/share verification checklist (MYND-474 / MYND-475)

Two device-only surfaces with no automated coverage (the same posture as `pdf_export.rs`
— native present, device-verified here). Record device model + OS build per run.

**MYND-474** is a plist-only fix (`NSCameraUsageDescription` in `Info.ios.plist`); without it iOS
hard-crashes on first camera access from the WKWebView file picker. **MYND-475** adds the native
share sheet (`share_file.rs`, `UIActivityViewController`) on top of the guaranteed Documents write,
so every row must confirm BOTH that the file lands (no regression) AND that the destination chooser
appears. iOS-first: Android share is a documented no-op (file stays in Documents + a toast names
the location) — its rows confirm the non-silent fallback, not a SAF picker.

Rows **8.9 / 8.10** (myne-md/myne#491) belong here for a different reason: they check where the
exported file is allowed to come to rest. Every export above puts plaintext in `Documents`, and both
platforms back that directory up by default, so a saved recovery phrase was reaching iCloud / Google
Drive. The exclusion is native (an xattr on iOS, two manifest attributes on Android) and its *effect*
is unreachable from CI — a green build and a green guard say the four files agree, not that the
platform honoured them.

| # | Scenario | Expected |
|---|---|---|
| 8.1 | **iOS "Take Photo" attach (MYND-474)** — Files/attach → file picker → Take Photo, grant camera | camera opens, photo captures, lands as an encrypted image attachment; **no crash** (the pre-fix `NSInvalidArgumentException`) |
| 8.2 | **iOS camera permission prompt copy** — first camera use | the `NSCameraUsageDescription` string shows, honest + telemetry-free |
| 8.3 | **iOS Export Markdown (MYND-475)** — Settings → Export to Markdown | success toast names `Documents/…`; share sheet opens on the export folder; "Save to Files" writes it to the chosen location |
| 8.4 | **iOS Export PDF** — note → Export as PDF | the note renders to a legible A4 `.pdf` and the **share sheet** opens on it directly (NOT the print dialog); Save to Files writes it; multi-page notes paginate |
| 8.5 | **iOS Download recovery phrase** — vault creation → save recovery phrase | share sheet opens on the `.txt`; Save to Files writes the correct plaintext; the Documents copy also exists |
| 8.6 | **iOS Export attachment** — attachment → export | share sheet opens on the file with its correct extension; Save to Files writes the decrypted bytes |
| 8.7 | **iOS share cancel is non-silent** — open any export share sheet, cancel it | the file is still saved in Documents (the success toast already fired); no silent no-op |
| 8.8 | **Android export fallback (no SAF yet)** — run each export flow | file writes to Documents; a toast names the location; no crash, no silent no-op (SAF picker deferred, see `share_file.rs` module docs) |
| 8.9 | **iOS export directory is excluded from iCloud Backup (myne-md/myne#491)** — launch the app once (simulator is enough), then on the host: `ls -l@ ~/Library/Developer/CoreSimulator/Devices/<device-id>/data/Containers/Data/Application/<app-id>/Documents` | the directory carries the `com.apple.metadata:com_apple_backup_excludeItem` xattr. **This row is the only proof the iOS half works** — the Rust compiles and `scripts/check-mobile-export-backup.mjs` passes whether or not Foundation honoured the call, and a saved recovery phrase in an iCloud backup reconstructs the vault. Absent xattr ⇒ `backup_exclude.rs` shipped inert; do not report the issue fixed |
| 8.10 | **Android export directory is excluded from Auto Backup + device transfer (same issue)** — the manifest half is **done** (2026-08-15: `./gradlew :app:processUniversalDebugMainManifest` + `:app:processUniversalDebugResources`; merged `<application>` carries both attributes, the merger's blame report attributes both to `[:myne-widgets]`, aapt2 link resolves both resources, and no `android:allowBackup` appears anywhere, so Auto Backup defaults on and these are the operative control). `scripts/check-mobile-export-backup.mjs` re-checks the merged manifest whenever a build has left one behind. **What is still owed is the device half**: `adb shell bmgr backupnow md.myne.mobile`, then confirm the export directory is not in the transported set | the export directory is absent from the transported set. Manifest agreement is NOT this row's answer: it says Android was told, not that Android obeyed |

## 9. Folder-archive parity checklist (MYND-470)

The `archived_folders` set (folder-archive) rides in on `vault.prefs` sync. The pure fold/predicate
logic is unit-tested (`tests/archived-folders.test.ts`); the note-list UI is device-verified here
because the flow-logic mock harness does not seed note-list content (`note_list` returns `[]` — no
existing flow test exercises real notes). Needs a desktop + phone pair on the same account, synced.

| # | Scenario | Expected |
|---|---|---|
| 9.1 | **Sync-in** — on desktop, archive a folder with notes; wait for the phone to sync | the folder appears as a row in the phone's Archive view (`data-testid=archive.folder-row`) |
| 9.2 | **Decluttered from the tree** — after 9.1, open the phone's Notes tab | the archived folder + its notes are GONE from the working tree (hidden, not trashed) |
| 9.3 | **Still resolvable** — search / open a wikilink to a note inside the archived folder | the note still resolves + opens (archive ≠ trash — it stays live) |
| 9.4 | **Drill-in** — tap the archived folder row | navigates into it; its notes list; the back affordance returns to the archive root |
| 9.5 | **Restore** — tap Restore on a folder row | the folder + its notes return to the live tree; the row disappears; survives a round-trip sync back to desktop |
| 9.6 | **Delete → Trash** — tap Delete on a folder row → confirm ("Move N notes to Trash?") | every note in the subtree moves to Trash (recoverable there); the folder leaves the archive |
| 9.7 | **Nested fold** — archive `A/` and `A/B/` on desktop | only `A/` shows as a top-level row; restoring `A/` un-archives `A/B/` too |
| 9.8 | **Loose archived notes** — individually archive a note (not folder) outside any archived folder | it still shows as a note row (with Unarchive) alongside the folder rows |

## 10. RTL layout checklist (RTL epic — myne-md/myne-mobile#33)

Direction follows the active locale (not a separate setting): the shared `@myne/i18n`
runtime sets `document.documentElement.dir` from the language at boot and on every switch.
The direction WIRING is flow-logic-tested (`tests/flow-logic/rtl.flow.ts` — `<html dir>`
flips, the back chevron mirrors, the affordance lands inline-end); what stays a DEVICE
check is real bidi: WKWebView / Android WebView Arabic shaping + fonts, the mirrored
gesture feel, and per-block paragraph direction on real content. Switch via Settings →
Appearance → Language → **العربية** (`ar`); spot-check on both platforms.

| # | Scenario | Expected |
|---|---|---|
| 10.1 | **Locale flip** — switch the display language to Arabic | the whole UI mirrors to RTL with no reload; switching back to English restores LTR |
| 10.2 | **Mirrored nav** — inspect the editor top bar, list headers, settings panels | back/disclosure chevrons point toward the inline-end (their glyph flips); the back affordance sits on the RIGHT; the note-context drawer slides in from the LEFT |
| 10.3 | **Back-gesture edge** — in the compact editor, swipe to go back | the interactive-pop gesture arms from the RIGHT screen edge and drags LEFT (mirror of LTR); a left-edge swipe no longer engages |
| 10.4 | **MarkdownView paragraph direction** — open (Reading mode) a note mixing Arabic and Latin paragraphs, lists, and headings | each block resolves its OWN direction (`dir="auto"`): Arabic blocks right-align, Latin blocks left-align, in the same note |
| 10.5 | **Inline isolation** — a note with a code span, a link, and an account-number-shaped run inside an Arabic paragraph | the neutral LTR runs do NOT reorder the surrounding RTL line (they are `unicode-bidi: isolate`d) |
| 10.6 | **Editing surface bidi** — type Arabic then Latin on separate lines in the editor | per-line direction resolves correctly (shared `@myne/editor` bidi); caret + selection track the line's direction |
| 10.7 | **Logical layout spot-check** — list-row dividers, the settings toggle knobs, unread/count badges, the table view's pinned Name column | all mirror: dividers inset from the correct side, knob ON-side flips, badges on the inline-end, the Name column pins to the RIGHT |

## 11. Navigation-policy verification checklist (myne-md/myne#453)

`mobile/src-tauri/src/navigation.rs` refuses every WebView navigation outside an allowlist
of the app's own origins. On iOS **every** navigation action reaches that hook, the app's own
first load included, so a wrong allowlist does not degrade a feature, it boots a blank app. No
CI lane builds for iOS or Android, so this table is the only thing standing between the unit
tests and a device.

> **Not run as of 2026-08-15, on either platform.** Recorded here rather than implied by the
> table's existence: nothing schedules this checklist, no CI step names it and no release
> runbook references it, so it verifies nothing until somebody runs it and writes the result
> (device model and OS build) below. `docs/threat-model.md` says the same thing in the
> normative voice: the mobile allowlist's DEVICE behaviour is not verified. The matching
> logic and the config strings are unit-tested and CI-run; that the host hook fires on a
> device at all is not.

Run the whole table on **both** platforms. A failed 11.1 or 11.2 means the allowlist is
wrong and the fix is the arm, not widening `is_allowed_navigation` to `true`. "Must not
ship" was the original wording and it was not true of the change that wrote it, which shipped
with the table unrun, so the sentence now says what it is: a gate for whoever runs it, and an
open gap until then. Production rows want an INSTALLED build
(`--export-method debugging` per §1, or the Android install loop in §6.1), because dev
builds load from Vite and never exercise the production origin at all.

| # | Scenario | Expected |
|---|---|---|
| 11.1 | **Production cold start**, install and launch the built app | the vault picker renders; NOT a blank/white screen. A blank screen with `navigation_denied` in the log (`tauri` stdout / `adb logcat -s RustStdoutStderr`) is the app's own origin being refused |
| 11.2 | **Attachment preview**, open a note with an embedded image, then a PDF, then a voice note | all three render/play. On Android these load over `http://attachment.localhost`, on iOS over `attachment://`, the two arms the allowlist admits separately |
| 11.3 | **External link**, tap an `https://` autolink in a note | it opens in the OS browser (`src/lib/open-url.ts`), and the in-app WebView does NOT navigate. The refusal is not the mechanism here; nothing should even reach the hook |
| 11.4 | **Deep link, warm**, with the app open, trigger the home-screen widget / launcher shortcut (`myne://capture`) | the capture flow starts. Deep links arrive as OS events, not navigations, so a `navigation_denied` line naming scheme `myne` means something changed and the widget path is broken |
| 11.5 | **Deep link, cold**, force-quit, then trigger `myne://open` from the widget | the app launches and lands in the same place as before this change |
| 11.6 | **Dev loop, cabled**, `pnpm mobile:android` (or iOS on the simulator), i.e. the `adb reverse` / loopback origin | the app loads and HMR works |
| 11.7 | **Dev loop, `--host`**, `pnpm tauri ios dev --host` against a physical iPhone on the same LAN | the app loads from the LAN IP. This is the arm desktop's hardcoded loopback list would refuse, and the reason the dev arm reads `build.devUrl` at runtime |
| 11.8 | **Refusal is silent to the user**, nothing in the table above surfaced an error toast or a crash | the policy denies by returning `false`; a refusal logs a scheme LABEL only, never the URL (it is the value most likely to carry note plaintext) |
