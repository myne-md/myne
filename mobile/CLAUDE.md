# myne-mobile — Tauri 2 Mobile client

> Companion repository to [`myne`](https://github.com/myne-md/myne). License: AGPL-3.0.

## Status

**In active build — NOT an empty scaffold** (this section drifts; re-verified against code 2026-07-07). The real state:

- **Backend**: `src-tauri/src/lib.rs` wires **15 shared `myne-core` plugins** — `vault_creation`, `vault_unlock`, `vault_recover`, `vault_change_password`, `vault_delete`, `vault_repair`, `prefs`, `notes`, `quick_unlock` (PIN **and** iOS Face ID / Touch ID biometric via the shared `myne-core` Apple-Keychain provider — main repo `design-notes.md` 2026-07-12; Android returns `HardwareUnavailable`), `vault_indices` (MYI1), `search` (MYS1), `snapshots`, `attachments` (MYA1, plus the `attachment://` async URI-scheme handler), `export` (whole-vault markdown tree), `secret_export` (recovery-kit `.txt` save) — plus the two external Tauri plugins (`opener`, `deep-link`). It installs **`hooks::MobileHooks`** (`myne_core::hooks::VaultLifecycleHooks`), a no-op for every desktop-only side-effect **except** the two snapshot hooks (`capture_snapshot` / `purge_note_snapshots`), which drive the shared `myne-core` snapshot store — a note overwrite/delete on mobile captures/purges `.myn` snapshots just like desktop. `quick-unlock` is registered **with** its own capability grant (`quick-unlock:default` in `capabilities/default.json`). MYS1 **search runs Rust-side** (`myne_core::search` BM25 engine, frontend-fed — the WebView already holds every note's plaintext, so it pushes the corpus down rather than the Rust core decrypting). Command *bodies* live in the repo-root `core/` crate (shared desktop↔mobile); the mobile `plugins/` are thin re-export wrappers. The `protocol/` crate is a direct path-dependency — zero crypto reimplementation, so `protocol/tests/vectors.rs` (the `myne-test-vectors` runner) validates mobile's blob/crypto path for free.
- **Wired app** (`src/app/`): the `AppShell` Stage machine (`src/lib/stage.ts`) drives functional flows — Welcome, Create-vault (5-step), Unlock (+ fail-closed / lost-both-secrets delete), Recover (24-word phrase), Editor (note CRUD + plain-`<textarea>`), Picker, and a comprehensive **Settings sheet** wired to the `prefs` plugin (Appearance / Editor / Privacy — theme, editor typography, spell, screen-capture, auto-lock, vault rename). `RestoreBackupFlow` is an honest "not available yet" stub.
- **Gallery** (`src/screens/`, `?gallery`): ~111 static design mocks — the desktop feature-parity *design target*, not backed.

### Desktop parity — what's still missing (the build-out map)

Reusable-for-free and **already landed** (link `core`/`protocol`): vault lifecycle, note CRUD, prefs, quick-unlock (PIN), snapshots, full-text **search** (MYS1, Rust-side), **vault-indices**/backlinks/graph (MYI1), **attachments** (MYA1), whole-vault markdown **export**, all crypto/blob codecs, vector conformance. **Still absent** (desktop-only subsystems needing a mobile equivalent via the hooks seam or a new plugin): **spell**+dictionary (MYD1), **workspace** (MYW1), **backup/restore** (MYB1; `RestoreBackupFlow` is an honest stub), **import** (Obsidian) + **PDF export**, **custom themes**, **AI embeddings** (MYR1). Biometric quick-unlock landed 2026-07-12 (iOS; Android awaits a Keystore provider + packaging). **Voice notes** landed 2026-07-12 — NOT via the desktop `cpal`/`voice_record_*` path (a hard mobile blocker) but WebView-side: the app records with the Web Audio API (`getUserMedia`), wraps PCM as `audio/wav` in TS (`src/lib/{wav,voiceRecord}.ts`), and stores it through the existing `attachment_import` (zero backend/ACL change); iOS mic permission is in `Info.ios.plist`; the Android `RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS` declarations are injected by the committed `src-tauri/build.rs` manifest partial (wry batch-requests BOTH for getUserMedia audio — see the tablet/Android enablement note below). In **active build — sync** (MYND-458): the ~20-file desktop sync engine was extracted into `myne_core::plugins::sync` (shared, cross-compiles for iOS), and the mobile thin-wrapper + per-platform capability ACL is the current in-flight work (the 🔴 capability-ACL step awaits sign-off, so sync is **not yet registered** in `lib.rs`/`capabilities/`). `protocol::{vault_head,manifest,scram}` primitives are already shared. The `VaultLifecycleHooks` seam lets each remaining subsystem land without forking the shared cores.

**Tablet-adaptive layout + Android enablement (MYND-465) landed 2026-07-12.** The wired app is size-class driven (`src/platform/SizeClassContext.tsx`, width-based via `window.innerWidth` + a `window.screen` phone guard — deliberately NOT a Tauri device API, so iPad Split View falls back to the phone layout and the Playwright flow tier drives it purely by viewport): **compact** (<700px or a phone-sized screen) = the phone's full-screen list ⇄ editor swap, unchanged; **medium** (≥700px) = list (340) + detail two-pane with the phone AppHeader/TabBar scoped to the list column; **expanded** (≥1000px) = the WS-01 three-pane (sidebar 248 `src/app/flows/editor/SidebarPane.tsx` + list 316 + editor with the 620px prose measure). `EditorFlow` stays the single state owner — the panes are in-scope render helpers (`renderNotesPane`/`renderEditorPane`), NOT prop-threaded components; `editing` drives the detail pane, `view` remains compact-only navigation intent. Pre-unlock flows stay a centered `PhoneColumn` (480) on tablets. Playwright: the phone project is viewport-PINNED (390×844 — Desktop Chrome's 1280×720 default would silently flip specs into the tablet layout) and three `tablet-*` projects run `tests/flow-logic/tablet/`. **Android is initialized** (`tauri android init`; `gen/android` gitignored as before): regeneration-surviving config = committed `build.rs` `update_android_manifest` mic block + `tauri.conf.json` `plugins.deep-link.mobile` (intent-filter) — the `Info.ios.plist` pattern's Android mirrors. Dev loop + per-release Android-tablet checklist: `docs/dev/device-matrix.md` §6. Known Android gaps stay honest: biometric = `HardwareUnavailable`, FLAG_SECURE no-op (screenshots NOT blocked), hardware back backgrounds the app (wry default).

## Stack — Tauri 2 Mobile

- **Tauri 2 Mobile** for both iOS and Android (shared shell, native packaging per platform)
- **Reuses `protocol/` Rust crate directly** from the main repo — no port, no separate libsodium binding to audit, no second crypto codebase
- **Reuses React UI** from main repo `src/` — no second UI codebase to maintain
- pnpm + pinned Node (`.nvmrc`); same toolchain as main repo

> Pending: this stack choice supersedes the "React Native mobile" portion of `decisions.md` 2026-04-26 (which was SUPERSEDED for desktop only). A new `decisions.md` entry should land before Phase 3 work begins — something like *"2026-MM-DD — Phase 3 mobile stack: Tauri 2 Mobile (supersedes React Native portion of 2026-04-26 tech stack)"*.

### Why Tauri Mobile (not React Native, Flutter, Expo, or native split)

Per project's reproducible-build + minimal-trust-surface discipline:
- **One Rust crypto crate, three platforms** — `protocol/` is `#![no_std] + extern crate alloc;` specifically so it compiles for desktop + mobile + (future) wasm-web. No second implementation to audit.
- **One React UI codebase** — desktop screens (`src/screens/`) reuse straight to mobile; per-platform layout tweaks are CSS, not separate codebases.
- **Single trust boundary surface** — Tauri's permission ACL (`capabilities/default.json`) extends to mobile capabilities; same scoping discipline.
- **Cross-platform frameworks add a third runtime + their own crypto wrappers** — RN/Flutter/Expo each introduce a JS bridge (or Dart VM) layer that must be audited as a trust boundary on top of native crypto. Tauri Mobile is closer to "Rust binary + WebView", which is the existing trust model.
- **Native iOS Swift + Android Kotlin** would mean three crypto codebases (Rust desktop + Swift iOS + Kotlin Android), each requiring its own libsodium binding, each a separate audit surface. The "no custom primitive implementations" rule survives but the "single auditable codebase" advantage evaporates.

### Trade-offs to surface (pre-Phase-3 design pass)

- **Tauri Mobile is newer** (Tauri 2.x feature, GA in 2024) than the desktop track. Phase 3 start should re-verify maturity, App Store / Play Store distribution story, and known issues vs. the ~year-of-experience desktop track.
- **WKWebView (iOS) ≠ WebView (Android) ≠ Chromium (desktop)** — feature parity gaps exist (CSS, fonts, storage quotas, gesture handling). Test all three.
- **Mobile-specific UX** (offline-first sync indicators, biometric vault unlock, file-picker for Obsidian import, share-extension for "Save to Myne") is real product work that doesn't reuse from desktop.

## Cross-implementation discipline

- Same `protocol/` Rust crate as Phase 1 desktop — primitives are bit-identical by construction, not by parallel implementation
- `myne-test-vectors/` companion still validates the underlying primitives as regression coverage; new vector failures stop-the-world for ALL clients (since they share the crate)
- Phase 2 Go server's primitives (separate codebase, validated via vectors) are the only client-vs-server vector gate

## Phase parity (NOT a goal at start)

Phase 3 mobile is the **minimum viable** read+write client. Feature parity with desktop is not a goal at launch — establish core flow first (vault unlock, note read, note edit, sync). The codebase reuse means parity creeps closer naturally over time.

## Hard architectural commitments (apply to all clients)

- No email at signup, no email recovery
- No plaintext mode, no encryption opt-in
- No telemetry / analytics — App Store + Play Store will push toward analytics SDKs; **resist them** or document the explicit exemption in main repo `design-notes.md`
- Reproducible builds — mobile build determinism is harder (Xcode/Gradle environment variability) but still a goal; document the recipe in `operations/`

## Gotchas

- **Biometric vault unlock shipped with its mandated threat-model entry** (main repo `design-notes.md` 2026-07-12 — `provider_kind 0x01` = Apple-Keychain, shared `myne-core` provider). Still open: the **biometric-hardware verification checklist** (a real device must confirm the Keychain read actually prompts and a non-authenticated read fails — the Bitwarden CVE-2023-27706 class) before the gate is presented as trusted. The OS Face ID sheet is unreachable from the flow-logic tier; the manual device checklist owns it.
- **iOS background-execution limits** — Argon2id at `m=256 MiB, t=3, p=2` may exceed mobile background-task budgets. Calibrated lower-cost params for unlock are documented in `decisions.md` 2026-04-26 ("middle-ground between SN004 64 MiB and research recommendation 1 GiB; works on mid-tier mobile ≈2-3s"); verify on real devices early.
- **Tauri Mobile capability ACL is per-platform** — iOS and Android entitlements differ; the desktop `capabilities/default.json` may not be a 1:1 fit. Audit the mobile-specific permission model when Phase 3 begins.
