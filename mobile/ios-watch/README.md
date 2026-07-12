# `ios-watch/` — Myne Apple Watch companion (voice quick-capture)

> Native SwiftUI watchOS app + complication + the iPhone-side WatchConnectivity
> receiver. Committed here, **outside** the git-ignored `src-tauri/gen/apple/`
> tree, so the sources survive `tauri ios init` (same discipline as
> `ios-widgets/`). Spec: `docs/spec/protocol.md` §9.18. Scope decision:
> main-repo `docs/decisions.md` 2026-07-12.

## What this is (and is not)

**One feature: voice → on-watch dictation → plain text → a new vault note.** The
watch app holds **no vault key and runs no crypto** — it dictates text and ships
it to the paired iPhone over WatchConnectivity. The phone seals it into a
device-local encrypted `MYK1` queue (`myne_core::plugins::captures`) and, on the
next unlock, drains it into the vault as an ordinary note (the audited
`plugin:notes|note_create` path). The watch is **outside the plaintext trust
boundary**, exactly like the home-screen widget.

Deliberately **out of scope (V1):** reading / editing existing notes on the
watch, search, audio-file capture, a Siri App Intent, and any vault key material
on the watch.

## Tree

```
ios-watch/
├── Shared/MyneWatchTheme.swift        ← Myne tokens + the "M" mark (both watch targets)
├── MyneWatch/                          ← the watchOS app (target: MyneWatch)
│   ├── MyneWatchApp.swift              ← @main, activates WCSession
│   ├── CaptureView.swift               ← dictation UI + Send + "Sent" confirmation
│   ├── WatchConnectivityClient.swift   ← WCSession.transferUserInfo(text) → phone
│   └── Info.plist                      ← WKApplication + WKCompanionAppBundleIdentifier
├── MyneWatchComplications/             ← watchOS WidgetKit complication (launcher)
│   ├── MyneWatchComplications.swift
│   └── Info.plist
└── Receiver/                           ← iPhone-side (compiled INTO the iOS app)
    ├── WCCaptureReceiver.swift         ← WCSessionDelegate → stages plaintext
    └── WCCaptureReceiverBootstrap.m    ← ObjC +load launch-hook (no AppDelegate)
```

Data flow: `CaptureView → WatchConnectivityClient.transferUserInfo` → (WC transport)
→ `WCCaptureReceiver.didReceiveUserInfo` writes `<app_data_dir>/pending-captures/
staging/<uuid>` → Rust `captures|seal_staged` → `<…>/sealed/<capture-id>` (`MYK1`)
→ on unlock, JS `drainPendingCaptures` → `note_create` + `captures|ack`.

## Wiring into the Tauri iOS project (`src-tauri/gen/apple/project.yml`)

`gen/apple/` is git-ignored and rebuilt by `tauri ios init`, so these edits are
**re-applied after every init** (then `cd src-tauri/gen/apple && xcodegen generate`;
`tauri ios build` also runs xcodegen). The edits (all present in the committed
working tree; mirror them after an init):

1. **`MyneWatch` target** — `type: application, platform: watchOS`,
   sources `../../../ios-watch/MyneWatch` + `../../../ios-watch/Shared`, Info.plist
   `WKApplication` + `WKCompanionAppBundleIdentifier: md.myne.mobile`, bundle id
   `md.myne.mobile.watchkitapp`, `DEVELOPMENT_TEAM`/`CODE_SIGN_STYLE`,
   `TARGETED_DEVICE_FAMILY: "4"`, deps `SwiftUI` + `WatchConnectivity`.
2. **`MyneWatchComplications` target** — watchOS `app-extension`,
   `com.apple.widgetkit-extension`, embedded into `MyneWatch` via a
   `- target: MyneWatchComplications` dependency, bundle id
   `md.myne.mobile.watchkitapp.complication`.
3. **On the iOS app target (`myne-mobile_iOS`):** `- target: MyneWatch` (embeds the
   watch app into `Watch/`), `- sdk: WatchConnectivity.framework`, the
   `- path: ../../../ios-watch/Receiver` source, `SWIFT_VERSION: "5.0"` in
   `settings.base` (the app compiles Swift only because of the receiver), and
   `OTHER_LDFLAGS: ["-Wl,-u,_OBJC_CLASS_$_WCCaptureReceiver"]` in `settings.base` —
   force-retains the receiver class, which is reached only via `NSClassFromString`
   from the `+load` bootstrap and would otherwise be at risk of a silent dead-code
   strip (apple/swift SR-3333).

## Build / CI reality

- **macOS + Xcode only.** watchOS + iOS native + WatchConnectivity + the keychain
  device key cannot build on the self-hosted Linux CI (which does a Rust
  cross-compile *check* only). The `.app` archive/sign/upload runs on a macOS host,
  the same split the iOS archive already lives with. Build locally with
  `pnpm tauri ios build` (which drives xcodegen + xcodebuild) on a Mac.
- Dictation uses the **system text input's mic** (tap the field → dictate), so
  there is **no `SFSpeechRecognizer` and no microphone / speech entitlement** on
  either target (the OS owns the mic).

## Pre-device static verification (done) + on-device checklist

**Static-verified before any device run:** the whole native surface compiles on the
real SDKs — `xcodebuild -target MyneWatch -sdk watchosNN` (watch app + complication)
BUILD SUCCEEDED, `swiftc -typecheck -sdk iphoneos` on the receiver + `clang
-fsyntax-only` on the `+load` bootstrap are clean, and `xcodegen generate` emits all
4 targets with the Embed-Watch-Content / Embed-Foundation-Extensions phases. The
runtime assumptions a compiler can't see were verified against authoritative sources
and two were fixed before device test:

- **Staging-dir path parity — RESOLVED (was a 100% break).** Tauri v2's iOS
  `app_data_dir()` = `dirs::data_dir()/<bundle id>` (verified in tauri 2.11.2
  `path/desktop.rs`, which iOS uses), i.e. `…/Library/Application Support/md.myne.mobile/…`.
  iOS `FileManager.applicationSupportDirectory` has NO bundle-id nesting, so
  `WCCaptureReceiver.stagingDir()` now appends `Bundle.main.bundleIdentifier` to
  match the Rust queue exactly.
- **Receiver-class dead-strip — HARDENED.** `WCCaptureReceiver` is reached only via
  `NSClassFromString`, so `OTHER_LDFLAGS: -Wl,-u,_OBJC_CLASS_$_WCCaptureReceiver`
  force-retains it (SR-3333 class of silent failure).
- **`transferUserInfo` on non-activated session — FIXED.** `WatchConnectivityClient`
  now buffers captures until `activationDidCompleteWith(.activated)` and flushes there.

**On-device checklist (needs the paired iPhone + Apple Watch; device-E2E exemption
MYND-467):**
1. **The `+load` launch-hook fires.** `WCCaptureReceiverBootstrap.m`'s `+load` must
   run in the wry launch sequence and activate a `WCSession`. If it proves
   unreliable, promote the receiver into a proper `tauri-plugin` iOS Swift package
   whose `load()` owns activation.
2. **`transferUserInfo` delivery is device-only** — the watchOS **simulator does not
   support it**; and iOS background-launch delivery only works for an app the user
   has manually launched at least once since install/reboot.
3. Extend the biometric-quick-unlock hardware checklist with: capture on the watch
   while the phone vault is locked → the note appears after unlocking the phone; the
   `captures/sealed/` queue drains; the device wrap key is created without a
   biometric prompt.
