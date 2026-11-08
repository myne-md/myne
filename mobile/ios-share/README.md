# `ios-share/` — Myne iOS Share Extension ("Save to Myne")

> Native iOS Share Extension that lets a file shared from any app's share sheet be
> saved into Myne's encrypted attachment library. Committed here, **outside** the
> git-ignored `src-tauri/gen/apple/` tree, so the sources survive `tauri ios init`
> (same discipline as `ios-widgets/` and `ios-watch/`). Feature: SF2 / MYND-510.
> Spec: `agent-tooling/docs/spec/protocol.md` §9.20 (`MYF1`).

## Design: PLAINTEXT-STAGING (not in-extension seal)

**The extension is pure Swift — no Rust, no crypto, no keychain.** It writes each
shared file's bytes (plus a `.meta` sidecar) as plaintext into the shared
App-Group container's `pending-shares/staging/` dir, and the **app** seals it into
the `MYF1` queue and imports it into the vault on next open.

This reverses the original ledger **SYNC-2** decision (in-extension seal) — a
user-approved change (2026-07-16) after the in-extension approach proved
unworkable: linking the Rust crypto dragged the whole tauri/wry runtime into a
**~105 MB extension binary** that the iOS app-extension sandbox **kills on launch**
(the "tap Myne → brief flash → vanishes, no logs" symptom). Plaintext-staging is
the exact pattern the **Apple Watch capture receiver already uses** (§9.18.4): the
native side stages plaintext, the app seals. It removes two hard, device-only
unknowns at once — the 105 MB binary AND the cross-process keychain handoff.

**Security posture.** The staged file is written with `.completeFileProtection`,
so iOS encrypts it at rest while the device is locked. It is device-local, lives
only in the app-group container, and is **never synced**. The window between
"shared" and "app seals it into MYF1" is a transient carve-out exactly analogous
to the §9.18.4 watch-staging plaintext window. The **server never sees plaintext**
(unchanged). Once the app seals it, the plaintext is deleted.

**Headless (SYNC-13):** no compose sheet, no rich UI — the principal class stages
and calls `completeRequest` immediately. The only UI it can show is the "file too
large" alert (SYNC-15).

Out of scope (V1): editing the shared file before import, a destination-note
picker, share-*out* of Myne (that's the separate outbound `share_file` module),
and any vault key material or crypto in the extension.

## Tree

```
ios-share/
└── ShareExtension/
    ├── ShareViewController.swift   ← headless pure-Swift; stages bytes + .meta into the App-Group container
    ├── Info.plist                  ← NSExtension: com.apple.share-services + activation rule
    └── ShareExtension.entitlements ← App-Group ONLY (no keychain — the extension does no crypto)
```

The app-side halves live in the app crate (not here):

- `src-tauri/src/share_import_ffi.rs` — iOS-only. Resolves the App-Group
  container (objc2 `NSFileManager`) and injects it into the shared-core queue seam
  (`init_app_group_queue`). No C-ABI, no seal — the extension calls no Rust.
- `core/src/plugins/share_import/queue.rs` — the shared-core queue; its `base()`
  gained a `#[cfg(target_os = "ios")]` App-Group seam
  (`set_ios_app_group_container_root`) so the extension (writer) and the app
  (reader/sealer) resolve the SAME `pending-shares/` subtree.
- `core/src/plugins/share_import/commands.rs` — `seal_staged_in_dir` reads the
  extension's staged files, seals each into `MYF1`, deletes the plaintext; the
  drain command calls it before draining.

Data flow:
`share sheet → ShareViewController.stage` → `<app-group>/pending-shares/staging/<uuid>`
(+ `<uuid>.meta` = `"<mime>\n<filename>"`, `.completeFileProtection`) → on open,
JS `drainPendingShares` → `drain_pending_shares` → `seal_staged_in_dir` (frame +
`MYF1` seal under the app's own device key, delete plaintext) → `drain_in_dir` →
`attachment_import` + `share_ack`.

## Wiring into the Tauri iOS project

> **STATUS: NOT WIRED — deliberately, and this is the one extension still absent
> from the shipped app.** The widget (`ios-widgets/`) and Apple Watch
> (`ios-watch/`) targets are committed and re-applied by
> `mobile/scripts/ios-postinit.sh` (myne-md/myne#803); this share extension is
> not yet in `mobile/src-tauri/ios/project.yml`. The reason is external, not code:
> the App Group capability must be enabled on the App ID (and the profile
> regenerated) before the app-group entitlement will sign. The Ad Hoc profile on
> the v0.8.2 archive carried no `com.apple.security.application-groups`, so
> adding this target today would fail signing, not ship the feature. Wire it —
> and the app-target `entitlements.properties` below — once the capability is on
> the App ID, then add it to the committed spec and to
> `scripts/check-ios-extensions.mjs`'s target list.

`gen/apple/` is git-ignored and rebuilt by `tauri ios init`, so these edits are
**re-applied after every init** (then `cd src-tauri/gen/apple && xcodegen generate`;
`tauri ios build` also runs xcodegen). The edits (present in the committed
working tree; mirror them after an init):

1. **`MyneShareExtension` target** — `type: app-extension, platform: iOS`,
   `deploymentTarget: "14.0"` (UTType is iOS 14+), sources
   `../../../ios-share/ShareExtension` (excluding `Info.plist` + `*.entitlements`),
   `INFOPLIST_FILE` + `CODE_SIGN_ENTITLEMENTS` at the committed files,
   `DEVELOPMENT_TEAM` / `CODE_SIGN_STYLE`, `TARGETED_DEVICE_FAMILY: "1,2"`. It is
   **pure Swift**: NO `libapp.a`, NO `Build Rust Code` phase, NO bridging header,
   NO `-Wl,-u`, NO `LIBRARY_SEARCH_PATHS`. Keep **`ENABLE_DEBUG_DYLIB: "NO"`** so
   the tiny Swift extension is a single self-contained binary (belt-and-suspenders
   against the debug-dylib rpath-load failure that a static extension avoids).
2. **`- target: MyneShareExtension`** in the **app target's** `dependencies` so
   xcodegen adds the Embed-App-Extensions phase and the `.appex` ships in
   `Myne.app/PlugIns/`.
3. **App entitlements — set them in the app target's `entitlements.properties`,
   NOT the `.entitlements` file.** xcodegen GENERATES
   `myne-mobile_iOS/myne-mobile_iOS.entitlements` from `project.yml`; a `path`-only
   block (no `properties`) overwrites it with an empty `<dict/>`, and the app
   silently loses the App-Group — then the drain reads the app's private container
   instead of the extension's, and the shared file just vanishes. Under the app
   target's `entitlements:` add:
   ```yaml
       properties:
         com.apple.security.application-groups:
           - group.md.myne.mobile
   ```
   (The app keeps its own keychain group by default; no shared keychain group is
   needed anymore — the extension does no crypto.)

> Note: `tauri ios init` regenerates `project.yml`; the app entitlements file is
> regenerated from it on every `xcodegen`. Re-apply the extension target, the
> app-target dependency, AND the app-target `entitlements.properties` together,
> alongside the widget + watch additions.

## Entitlements (both targets)

| Entitlement | App target | Extension target |
|---|---|---|
| `com.apple.security.application-groups` | `group.md.myne.mobile` | `group.md.myne.mobile` |
| `keychain-access-groups` | app's own default group (unchanged) | — none — |

**App-Group** is the sole sharing mechanism and is robust: both processes resolve
the same container via
`FileManager.containerURL(forSecurityApplicationGroupIdentifier: "group.md.myne.mobile")`.
The extension writes `<container>/pending-shares/staging/`; the app resolves the
same path through the core seam. The group id is load-bearing — keep
`share_import_ffi::APP_GROUP_ID`, both `.entitlements`, and
`ShareViewController.appGroupID` in lockstep.

There is **no cross-process keychain sharing**: the device wrap key that seals the
`MYF1` blob lives entirely app-side (the app's own keychain, service
`md.myne.shareimport`), because only the app seals now.

## App-Group queue seam (`core/src/plugins/share_import/queue.rs`)

`base()` used `app_data_dir` (the app's private container), which the extension
cannot see. The iOS seam:

- `share_import_ffi::init_app_group_queue()` runs once in `lib.rs` `setup()`:
  resolves the App-Group container (objc2 `NSFileManager`) and injects it via
  `queue::set_ios_app_group_container_root(path)`.
- `queue::base()` on iOS returns `<app-group>/pending-shares` when the root is set,
  else falls back to `app_data_dir` (an unprovisioned build where the extension is
  inert too — writer + reader stay consistent, just disabled).

The **vault** paths are unchanged (they stay in the app's private container); only
the **share queue** (`staging/` + `sealed/`) moves to the App-Group.

## Oversize cap (SYNC-15)

`ShareViewController.maxShareBytes = 48 MiB`, below the 64 MiB `MYF1` codec cap so
the app's later seal never rejects a staged file. A larger file is rejected with a
"File too large to share" alert. The extension now only *copies* bytes (no seal),
so its memory pressure is one file — the ~120 MB extension ceiling is no longer a
concern for the crypto buffer, only for the copy.

## Unlock-on-share (SYNC-12)

After staging, the extension best-effort calls
`extensionContext.open(URL("myne://open"))` to foreground Myne. This is
**historically fragile** for share extensions and frequently no-ops; it is a pure
nicety. If it does nothing, the staged file is picked up on the next ordinary app
open (the queue is durable) — **graceful degrade, zero data loss**.

## Build / CI reality

- **macOS + Xcode only.** iOS native + the App-Group cannot build/sign on the
  self-hosted Linux CI (Rust cross-compile *check* only). Build with
  `pnpm tauri ios dev` / `pnpm tauri ios build` on a macOS host.
- The extension is pure Swift, so it has none of the `libapp.a` / `Externals`
  collision concerns the app target has.

## Verification

**Verified locally (2026-07-16, macOS + Xcode 26.6):**

- `cargo test -p protocol share_import` + `-p myne-core share_import` — green
  (codec, AAD pin, vectors runner, seal/drain/frame, and `seal_staged_in_dir`
  which simulates the extension's staged files → seal → drain).
- `cargo check --lib` (host) + `--target aarch64-apple-ios` — clean.
- `xcodegen generate` + `xcodebuild -destination generic/platform=iOS … build` →
  **BUILD SUCCEEDED**; the extension binary is **~178 KB** (pure Swift, no dylib),
  code-signed with the App-Group entitlement; both bundle ids correct
  (`md.myne.mobile.furkan` + `…furkan.share`).

**On-device checklist (needs a signed build; device-E2E exemption class of
`ios-watch`):**

1. **Share sheet:** Myne appears for an image, a PDF, an arbitrary file, and a
   multi-item selection (SYNC-14).
2. **Stage-while-locked:** share with the vault locked → the extension completes
   (brief flash is normal) → a plaintext file + `.meta` appear in
   `<app-group>/pending-shares/staging/`. Extension NSLog lines (`MYNE-SHARE …`)
   show in `idevicesyslog` / `tauri ios dev`.
3. **Seal + import on open:** open the app + unlock → the app's drain logs
   (`drain: scanning queue staging_files=N`, `sealed staged`, `imported`) show,
   the plaintext is deleted, and the file appears in the attachment library with
   the "N files added" toast.
4. **App-Group path parity:** confirm the app's `staging_files=N` matches what the
   extension wrote (both processes resolve the same container).
5. **Oversize:** share a file above 48 MiB → the "File too large" alert; nothing
   staged.
6. **Bundle-id prefix:** the extension bundle id must be a dot-child of the app's
   (`md.myne.mobile.furkan.share` when the dev `.furkan` suffix is on).
7. **Unlock-on-share:** note whether `myne://open` foregrounds the app; if not,
   confirm the next ordinary open drains the queue (graceful degrade).
