# `ios-watch/` — Myne Apple Watch companion (voice quick-capture + meeting recording)

> Native SwiftUI watchOS app + complication + the iPhone-side WatchConnectivity
> receiver. Committed here, **outside** the git-ignored `src-tauri/gen/apple/`
> tree, so the sources survive `tauri ios init` (same discipline as
> `ios-widgets/`). Spec: `docs/spec/protocol.md` §9.18. Scope decision:
> main-repo `docs/decisions.md` 2026-07-12. Meeting lane: myne-md/myne#812.

## What this is (and is not)

**Two features, one trust boundary.** (1) **Voice quick-capture**: dictate text
through the system input and ship it to the paired iPhone, where it becomes a new
vault note. (2) **Meeting recording** (myne-md/myne#812): hold the watch
microphone open for a meeting, spool it into numbered audio chunks, and ship each
chunk to the phone, which seals it on arrival. Either way the watch app holds **no
vault key and runs no crypto** — the phone seals everything into device-local
encrypted queues (`MYK1` for captures, the share-import wrap key for meeting
chunks) and, on the next unlock, drains them into the vault as ordinary notes
(the audited `plugin:notes|note_create` path). The watch is **outside the
plaintext trust boundary**, exactly like the home-screen widget.

Deliberately **out of scope:** reading / editing existing notes on the watch,
search, and any vault key material on the watch. The meeting recorder is
deliberately **foreground-only** — no `HKWorkoutSession`, no background recording,
and the screen stays on for the meeting's duration (see `MeetingRecorder.swift`
for the trade).

## Tree

```
ios-watch/
├── Shared/MyneWatchTheme.swift        ← Myne tokens + the "M" mark (both watch targets)
├── MyneWatch/                          ← the watchOS app (target: MyneWatch)
│   ├── MyneWatchApp.swift              ← @main, activates WCSession, TabView of the
│   │                                      two surfaces + the `myne-watch://meeting` route
│   ├── CaptureView.swift               ← dictation UI + Send + "Sent" confirmation
│   ├── MeetingRecorder.swift           ← mic → 15 s audio chunks + live elapsed (#812)
│   ├── MeetingTransfer.swift           ← WCSession.transferFile per chunk + delete-on-complete (#812)
│   ├── MeetingView.swift               ← recorder UI: start / live state / stop / discard (#812)
│   ├── WatchConnectivityClient.swift   ← WCSession.transferUserInfo(text) → phone; owns the
│   │                                      ONE delegate, incl. the meeting lane's
│   │                                      `didFinish fileTransfer:` forward
│   └── Info.plist                      ← WKApplication + WKCompanionAppBundleIdentifier +
│                                          NSMicrophoneUsageDescription + the myne-watch: scheme
├── MyneWatchComplications/             ← watchOS WidgetKit complication (launcher)
│   ├── MyneWatchComplications.swift
│   └── Info.plist
└── Receiver/                           ← iPhone-side (compiled INTO the iOS app)
    ├── WCCaptureReceiver.swift         ← the ONE WCSessionDelegate: stages dictated
    │                                      text; forwards file deliveries to the meeting handler
    ├── WCMeetingReceiver.swift         ← meeting audio chunks (myne-md/myne#812): seals on
    │                                      arrival, never stages plaintext
    └── WCCaptureReceiverBootstrap.m    ← ObjC +load launch-hook (no AppDelegate)
```

Data flow: `CaptureView → WatchConnectivityClient.transferUserInfo` → (WC transport)
→ `WCCaptureReceiver.didReceiveUserInfo` writes `<app_data_dir>/pending-captures/
staging/<uuid>` → Rust `captures|seal_staged` → `<…>/sealed/<capture-id>` (`MYK1`)
→ on unlock, JS `drainPendingCaptures` → `note_create` + `captures|ack`.

Watch meeting flow (myne-md/myne#812): `MeetingView → MeetingRecorder` writes a
**15 s chunk** to `tmp`, `MeetingTransfer.transferFile(_:metadata:)` ships it with
`session_id` / `chunk_index` (from 0) / `started_at`, and the local chunk is
deleted the moment `didFinish fileTransfer:` reports success. On the phone
`WCCaptureReceiver.session(_:didReceive:)` forwards the delivery to
`WCMeetingReceiver`, which dispatches a `myne-meeting-chunk` event into the
WebView; `mobile/src/lib/captures.ts` seals it on arrival via
`captures|seal_meeting_chunk` (device-key based — runs while the vault is LOCKED)
into `<…>/pending-captures/meetings/entries/`, recording it in the per-session
manifest. **No plaintext audio is staged by our code** — the WatchConnectivity
inbox file is handed straight to the seal, which deletes it. On unlock,
`drainPendingMeetings` imports each chunk into the vault, transcribes it, builds
the note with the shared `buildMeetingNote`, creates it, then acks the session.

## Wiring into the Tauri iOS project (committed spec + ios-postinit.sh)

The watch app is declared in the **committed**
`mobile/src-tauri/ios/project.yml`, NOT in the regenerated
`src-tauri/gen/apple/` tree. `tauri ios init` rebuilds that tree wholesale, so a
project.yml edit made there is transient — and on 2026-10-01 it dropped the watch
app silently and the v0.8.2 TestFlight build shipped phone-only
(myne-md/myne#803). The committed spec is copied onto `gen/apple/project.yml` and
`xcodegen generate` is run by `mobile/scripts/ios-postinit.sh`, which is wired
into the package's `tauri` command (`mobile/scripts/tauri.sh`) so every `pnpm
tauri ios dev|build|run` in `mobile/` re-applies it. Run it by hand with
`pnpm --filter myne-mobile ios:postinit`.

The committed spec declares:

1. **`MyneWatch` target** — `type: application, platform: watchOS`,
   sources `../../../ios-watch/MyneWatch` + `../../../ios-watch/Shared`, Info.plist
   `WKApplication` + `WKCompanionAppBundleIdentifier: md.myne.mobile`, bundle id
   `md.myne.mobile.watchkitapp`, `DEVELOPMENT_TEAM`/`CODE_SIGN_STYLE`,
   `TARGETED_DEVICE_FAMILY: "4"`, `ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon`,
   deps `SwiftUI` + `WatchConnectivity`. The app icon lives in the committed
   `MyneWatch/Assets.xcassets` (single-size 1024 watchOS `AppIcon` — the shared
   Myne "M"); it is picked up automatically because the `MyneWatch` folder is a
   source path, but the `ASSETCATALOG_COMPILER_APPICON_NAME` setting is required or
   the watch app grid shows a blank placeholder (the iOS app's Tauri-generated
   `gen/apple/Assets.xcassets` is not in this target's sources).
2. **`MyneWatchComplications` target** — watchOS `app-extension`,
   `com.apple.widgetkit-extension`, embedded into `MyneWatch` via a
   `- target: MyneWatchComplications` dependency, bundle id
   `md.myne.mobile.watchkitapp.ext`. (`.ext`, not `.complication`: Apple bundle IDs
   are globally unique and `…watchkitapp.complication` was already taken, so it
   could not be registered. The extension only has to be a dot-child of the watch
   app's id.) It also compiles `../../../ios-watch/Shared` — `MyneMark()` is used
   by the complication view, so that file is a source of BOTH watch targets
   (omitting it fails the compile).
3. **On the iOS app target (`myne-mobile_iOS`):** the watch is NOT a target
   dependency. `tauri ios build` archives the scheme under `-sdk iphoneos`, and
   that flag overrides a target's `SDKROOT`, so a linked watch target is compiled
   against the iOS SDK and every watchOS WidgetKit API in the complication fails
   as "only available in iOS 16+", killing the archive. Instead two script phases
   do the work: `mobile/scripts/ios-watch-build.sh` builds `MyneWatch` with an
   explicit `-sdk watchos` and stages it at `gen/apple/watch-build/`, and
   `mobile/scripts/ios-watch-embed.sh` copies it to `Myne.app/Watch/` (Apple
   requires exactly that path). The app still carries `- sdk:
   WatchConnectivity.framework`, the `- path: ../../../ios-watch/Receiver` source,
   `SWIFT_VERSION: "5.0"`, and `OTHER_LDFLAGS: ["$(inherited)",
   "-Wl,-u,_OBJC_CLASS_$_WCCaptureReceiver"]` — which force-retains the receiver
   class, reached only via `NSClassFromString` from the `+load` bootstrap and
   otherwise at risk of a silent dead-code strip (apple/swift SR-3333).

## Build / CI reality

- **macOS + Xcode only.** watchOS + iOS native + WatchConnectivity + the keychain
  device key cannot build on the self-hosted Linux CI (which does a Rust
  cross-compile *check* only). The `.app` archive/sign/upload runs on a macOS host,
  the same split the iOS archive already lives with. Build locally with
  `pnpm tauri ios build` (which drives xcodegen + xcodebuild) on a Mac.
- Dictation uses the **system text input's mic** (tap the field → dictate), so
  there is **no `SFSpeechRecognizer` and no speech entitlement** on either target.
  The meeting recorder is the first surface to hold the watch mic directly, so
  `MyneWatch/Info.plist` now carries `NSMicrophoneUsageDescription` (the literal
  plist, not `INFOPLIST_KEY_*` build settings — this target already uses a
  committed plist file, copied into `gen/` by `ios-postinit.sh`).

## Pre-device static verification (done) + on-device checklist

**Static-verified before any device run:** the whole native surface compiles on the
real SDKs — `xcodebuild -target MyneWatch -sdk watchosNN` (watch app + complication)
BUILD SUCCEEDED, `swiftc -typecheck -sdk iphoneos` on the receiver + `clang
-fsyntax-only` on the `+load` bootstrap are clean, and `xcodegen generate` emits all
4 targets with the Embed-Watch-Content / Embed-Foundation-Extensions phases. The
meeting recorder + transfer (`MeetingRecorder.swift`, `MeetingTransfer.swift`,
`MeetingView.swift`) were added to the same `swiftc -typecheck -sdk watchos`
invocation and compile clean. The runtime assumptions a compiler can't see were
verified against authoritative sources and two were fixed before device test:

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
4. **Watch meeting capture end-to-end (myne-md/myne#812).** Start a recording on
   the wrist, let it run long enough to produce several chunks, stop it, and
   confirm the note arrives on the phone after unlock with the audio embeds and the
   transcript. Cover: the phone staying LOCKED through the whole meeting (the seal
   is device-key based); a watch that loses contact mid-meeting and reconnects
   (the not-yet-transferred chunk stays on the watch); and a `seal_meeting_chunk`
   that runs on a cold background launch (the receiver queues the delivery until
   the WebView exists — see `WCMeetingReceiver`). The phone-side flow logic is
   covered by `tests/flow-logic/captures/meeting-drain.flow.ts`; this row is the
   device half.
5. **`transferFile` is device-only too.** The watchOS **simulator does not support
   `transferFile`** (the same limitation row 2 records for `transferUserInfo`), so
   neither the chunk delivery nor the `didFinish fileTransfer:` delete-on-complete
   can be exercised without a paired physical Watch. Confirm on device that a
   chunk file actually disappears from the watch's `tmp` once its transfer reports
   complete (`MeetingTransfer.didFinish`), and that a transfer attempted while out
   of range leaves the file in place.
6. **Microphone permission prompt.** The first `MeetingView` start must raise the
   watchOS mic prompt from `NSMicrophoneUsageDescription`; confirm the wording
   reads honestly and that denying it surfaces the view's error line rather than a
   silent dead "Recording" state.
7. **Foreground-only behaviour is the documented trade.** With a recording running,
   drop the wrist and confirm what the app actually does (watchOS dims and suspends
   a non-workout app; there is deliberately no `HKWorkoutSession` and no
   background mode). The recorded expectation is: the session stops, the elapsed
   counter freezes, and every chunk already transferred is safe on the phone. The
   screen stays on only while the app is foregrounded.
8. **Chunk boundaries and ordering under a real meeting.** Record past at least
   three 15 s boundaries and confirm the phone-side note carries every chunk in
   order with none missing or duplicated (this is the same claim as row 4, scoped
   to the watch's chunk duration).
9. **Discard a mistaken start.** Tap Discard on a just-started recording and
   confirm no session and no chunk reaches the phone (the local chunk files are
   removed and the session id is cleared).
10. **Complication meeting entry point.** Add the rectangular complication and
    confirm its recorder glyph opens the app straight on `MeetingView`
    (`myne-watch://meeting`), while the complication body still launches to the
    `CaptureView` dictation surface.
11. **Page swipe vs. scroll (the one layout risk).** Both surfaces put a
    `ScrollView` inside a `.verticalPage` `TabView`, so a vertical swipe is
    claimed by both the page turn and the scroll. Confirm on device that the
    capture surface still scrolls and still reaches the meeting page, and that
    `CaptureView`'s one-tap dictation is unchanged. If the two fight, the fix is
    a non-vertical TabView style rather than editing `CaptureView`.
