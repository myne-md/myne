<p align="center"><img src=".github/banner.png" alt="Myne mobile" width="100%"></p>

# Myne mobile

> The same notes, in your pocket. Nothing leaves unencrypted.

The Android and iOS client for [Myne](https://myne.md): an open-source,
end-to-end-encrypted, local-first markdown notes app with optional zero-knowledge
sync. No email at signup, an account number identifies your vault, and a BIP-39
24-word phrase is the only recovery path. Keys are derived with Argon2id; notes
are sealed with XChaCha20-Poly1305.

This client is **in this repository**, at `mobile/`, since 2026-08-13. The pnpm
package is still named `myne-mobile`; the directory is not. All three clients live
here now: the desktop client and the canonical specifications at the repository
root, the browser client at `web/`, and this one. The server, website, ops,
clipper, themes, branding and the adversarial test range remain companion
repositories under [`myne-md`](https://github.com/myne-md), each with its own
`AGENTS.md`.

The protocol, threat model and on-disk format are defined once in
[`docs/`](../docs) and shared by every client. Read those before touching
anything cryptographic here.

## Status

**In active build, pre-alpha.** This is not a design mock and not an empty
scaffold: the app runs a real vault against the same `protocol/` and `core/`
crates the desktop client ships, which is the whole reason a repository boundary
here was never real.

`AGENTS.md` beside this file is the roster of record and it is kept closer to the
code than anything written here. In outline, what is wired:

- **Vault lifecycle**: create, unlock, recover from the phrase, change password,
  repair, delete, multi-vault.
- **Notes**: markdown editing, note CRUD, snapshots and trash, attachments,
  full-text search (BM25, run in the shared core), backlinks, vault indices and
  the knowledge-graph layout cache.
- **Settings**: the prefs plugin, appearance and editor typography, custom themes
  (read-only: palettes are authored on a computer and arrive by sync), privacy
  controls.
- **Sync**: the shared sync engine under a deny-by-default capability, foreground
  loop and poke listener.
- **Native surfaces**: quick unlock, screen-capture protection, voice notes,
  on-device transcription, OS share target, home-screen widgets and app
  shortcuts, deep links.
- **Gallery** (`?gallery`): the desktop feature-parity *design target*, not
  backed by the app. It is where the parity map is drawn, not a claim that those
  screens work.

### Known gaps, stated rather than discovered

Biometric unlock returns `HardwareUnavailable` on Android (there is no Keystore
provider yet) while working on iOS. Background sync is deferred, so the loop is
foreground-only. The iOS share extension exists but is not wired, because it
needs an App Group on the App ID first. QR device-join is iOS-only. Spell check
and dictionaries, backup and restore, Obsidian import, PDF export and AI
embeddings have no mobile implementation yet, and the reminder pass has a
`remindersReachTheOs()` gate so the settings screen cannot promise a delivery
that is not running.

Per-release device coverage is `dev-notes/device-matrix.md`, and it records
honest-gap rows rather than papering over them.

## Layout

```
mobile/
├── src/                  own React tree, source-consuming ~25 @myne/* aliases
│   ├── app/              the wired flows (AppShell, unlock, editor, settings)
│   ├── screens/          the design gallery
│   ├── platform/         the host seam: the ONLY place importing @tauri-apps/*
│   └── formfactor/       iOS-vs-Android and phone-vs-tablet presentation split
├── src-tauri/            Tauri 2 host
│   ├── src/              plugin wiring + the mobile-local plugins
│   ├── ios/project.yml   the committed XcodeGen spec (gen/ is regenerated)
│   ├── build.rs          the regeneration-surviving Android manifest injection
│   └── tauri-plugin-*/   five in-repo native plugins, each carrying its own
│                         Kotlin and/or Swift
├── android-widgets/      RemoteViews widgets, a gradle module outside gen/
├── ios-widgets/          WidgetKit sources
├── ios-watch/            watchOS app + complications
├── ios-share/            Share Extension sources (not yet wired)
├── fdroid/               F-Droid packaging: recipe draft + procedure
├── dev-notes/             device matrix, e2e options, per-feature checklists
├── scripts/              platform post-init, icon sync, the Tauri wrapper
└── tests/                Vitest specs
```

`gen/` is git-ignored on both platforms and regenerated whole by `tauri ios
init` / `tauri android init`, which is why every durable native fact lives in a
committed file outside it: `ios/project.yml`, `build.rs`, `ios-widgets/`,
`android-widgets/`, and the post-init scripts.

## Development

```bash
pnpm install            # repository root: one lockfile for every workspace member

pnpm mobile:dev         # Vite on :1422 (the desktop client holds :1420, web :1421)
pnpm mobile:build       # typecheck + production bundle
pnpm mobile:test        # Vitest
pnpm mobile:test:flow   # Playwright flow-logic tier (mock IPC, no device)

pnpm mobile:ios         # tauri ios dev     (needs Xcode)
pnpm mobile:android     # tauri android dev (needs the Android SDK and NDK)
```

Android and iOS native builds need their SDKs and are not runnable on the Linux
CI runner, so they live in the release matrix rather than in a push pipeline.
`mobile/docs/dev/device-matrix.md` has the dev loop for both, including the
`adb reverse` recipe, and `mobile/fdroid/` carries the F-Droid packaging.

## Hard commitments

These hold for every Myne client and are not negotiable here:

- No email at signup, no email recovery.
- No plaintext mode, no encryption opt-in. Privacy is the default.
- **No telemetry or analytics.** The app stores are built to push analytics SDKs
  at you; the answer is to refuse them, not to document an exemption.
- Reproducible builds are the goal. They are harder on mobile because Xcode and
  Gradle vary by environment, which is why the F-Droid recipe and the
  reproducible-build question are written down in `mobile/fdroid/README.md`
  rather than assumed.

## Distribution

Today the Android client ships as a universal `.apk` published by hand, signed
with Myne's own release key. Preparation for the F-Droid main repository is
complete and staged in `mobile/fdroid/`; submission waits on the source
repository becoming publicly readable, which F-Droid requires because it builds
the app itself.

If you are moving from the published `.apk` to the F-Droid build, read the
signing note in `mobile/fdroid/README.md` first: the two are signed by different
keys, so the switch needs an uninstall, and an uninstall removes the on-device
vault.

## License

This client is **AGPL-3.0** (see [`LICENSE`](../LICENSE) and
[`LICENSING.md`](../LICENSING.md), which also carries this bundle's third-party
asset attributions). The specifications in [`docs/`](../docs) are CC-BY-4.0 so
the protocol stays reusable by independent implementations.
