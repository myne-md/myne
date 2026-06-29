# myne-mobile — Phase 3 mobile clients (placeholder)

> Companion repository to [`myne`](https://github.com/myne-md/myne). License: AGPL-3.0.

## Status

**Phase 3 — not yet started.** Empty scaffold. Phase 1 (desktop) ships first; Phase 2 (sync server) follows; this mobile client is Phase 3 alongside `myne-web`.

## Stack target — Tauri 2 Mobile

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

- **Biometric vault unlock is a Phase 3+ design question.** It's a UX win but a threat-model hit (TouchID/FaceID secret extraction varies by device generation). Don't ship without a `decisions.md` entry analyzing the trade-off.
- **iOS background-execution limits** — Argon2id at `m=256 MiB, t=3, p=2` may exceed mobile background-task budgets. Calibrated lower-cost params for unlock are documented in `decisions.md` 2026-04-26 ("middle-ground between SN004 64 MiB and research recommendation 1 GiB; works on mid-tier mobile ≈2-3s"); verify on real devices early.
- **Tauri Mobile capability ACL is per-platform** — iOS and Android entitlements differ; the desktop `capabilities/default.json` may not be a 1:1 fit. Audit the mobile-specific permission model when Phase 3 begins.
