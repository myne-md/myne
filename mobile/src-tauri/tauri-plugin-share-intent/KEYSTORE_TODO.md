# Android Keystore device-key for share-import — status & wiring TODO

**Feature:** share-import staging queue (`MYF1`, `spec/protocol.md` §9.19), SF3 / SYNC-3.
**Status of the Android device key:** **seam implemented (Kotlin + plugin-side Rust), NOT wired into `myne-core`** — the last hop needs a shared-core signature change (an `AppHandle` threaded into `core`'s `device_key::get_or_create`), which is out of scope for this change per the task's "STOP and document" gate.

## Why a native provider is needed at all

The share-import queue seals a file the user shared into Myne while the vault may be
**locked**, so it cannot use a `root_key`-derived KEK. It needs a **device-global,
non-biometric, device-only** 32-byte symmetric key held by the OS
(`core/src/plugins/share_import/device_key.rs`). Apple targets already have this
(Keychain, service string `md.myne.shareimport`,
`AccessibleAfterFirstUnlockThisDeviceOnly`, no `SecAccessControl` flags). The Android
arm currently returns `HardwareUnavailable`, so the locked-vault staging path no-ops on
Android (the unlocked direct-ingest SF3 path still works).

## What is implemented here (compiles, device-verify-pending)

1. **Kotlin `ShareIntentPlugin.getOrCreateDeviceKey`** (`android/.../ShareIntentPlugin.kt`).
   Envelope pattern, because **Android Keystore AES keys are non-exportable**:
   - A hardware-held AES/GCM **wrapping key** (alias `md.myne.shareimport.wrap`,
     `setUserAuthenticationRequired(false)` → non-biometric, Keystore-bound → device-only,
     non-syncing) encrypts a locally-minted random 32-byte **data key**.
   - The wrapped data key (IV ‖ ciphertext, base64) is persisted in a private
     `SharedPreferences` (`md.myne.shareimport` / `device-wrap-key`).
   - On read it is unwrapped and returned as a JSON int array; on first use it is
     minted + wrapped. The wrapping key never leaves the Keystore; the raw data key is
     what Rust's XChaCha20-Poly1305 needs.
2. **Plugin-side Rust seam** `ShareIntent::get_or_create_device_key()`
   (`src/lib.rs`). Calls the Kotlin `@Command` via `run_mobile_plugin` (off the main
   thread — same deadlock contract as `screen_guard::ScreenGuard::set_secure`), validates
   the 32-byte length, and returns a `Zeroizing<[u8; 32]>`. Reachable via
   `app.try_state::<ShareIntent<R>>()` (the `screen_guard::ScreenGuard` precedent). This
   compiles for `aarch64-linux-android` with **no new Rust crate**.

## What is NOT done (the documented gap)

The seam is **not connected** to `myne-core`'s
`plugins::share_import::device_key::get_or_create()`, which is where `seal_share` /
`drain_pending_shares` actually fetch the key:

```rust
// core/src/plugins/share_import/device_key.rs
#[cfg(target_os = "android")]
pub fn get_or_create() -> Result<Zeroizing<[u8; SHARE_WRAP_KEY_LEN]>, ShareImportError> {
    Err(ShareImportError::HardwareUnavailable)   // <-- still a stub
}
```

This function takes **no arguments**. Reaching the Kotlin plugin needs a
`PluginHandle`, which is only obtainable from an `AppHandle` (via managed state —
`app.try_state::<ShareIntent<R>>()`). `get_or_create()` has neither, and it is a
**shared-core** function whose Apple and desktop arms have the same no-arg signature and
must keep compiling. Changing it is an architecture change touching `core`, not a
local edit, so it is deliberately deferred.

### Recommended wiring (one focused core change, done deliberately later)

Thread the vault-runtime's `AppHandle` to the Android device-key arm without disturbing
the Apple/desktop arms:

1. In `core/src/plugins/share_import/device_key.rs`, give the **Android** arm an
   `AppHandle`-taking form, e.g. `get_or_create_android(app: &AppHandle<R>)`, that does:
   ```rust
   let si = app.try_state::<tauri_plugin_share_intent::ShareIntent<R>>()
       .ok_or(ShareImportError::HardwareUnavailable)?;
   si.get_or_create_device_key().map_err(|_| ShareImportError::Backend)
   ```
   (or keep `get_or_create()` no-arg on Apple/desktop and add the `AppHandle` variant only
   under `#[cfg(target_os = "android")]`, dispatched from `commands.rs`).
2. In `core/src/plugins/share_import/commands.rs`, `seal_share` and
   `drain_pending_shares` already hold `app: AppHandle<R>` — pass it to the Android
   device-key call. On Apple/desktop keep the current no-arg call. Both `seal_share_in_dir`
   / `drain_in_dir` cores already take the key as an explicit argument, so only the
   command-level `let key = device_key::get_or_create()?;` line changes.
3. `core` must then depend on `tauri-plugin-share-intent` **only** under
   `#[cfg(target_os = "android")]` (or behind a mobile feature) — confirm this does not
   pull the plugin into desktop/iOS builds and keeps the single shared `Cargo.lock`
   intact. Alternatively, define a small `AndroidShareDeviceKey` trait in `core`,
   implement it on `ShareIntent` in this plugin, and register it as managed `dyn` state
   — that keeps `core` from taking a direct build dependency on the plugin (cleaner layering).
4. Must be **off the main thread** — `run_mobile_plugin` deadlocks on the main thread
   (`myne-mobile/CLAUDE.md`). The `seal_share` / `drain_pending_shares` commands run in
   Tauri's async command context (not the main thread), so this is already satisfied.
5. Off-target arms (`#[cfg(not(target_os = "android"))]` / desktop) keep returning
   `HardwareUnavailable` unchanged.

### Device verification (owed before the gate is trusted)

Once wired, verify on a **real Android device** (`docs/dev/device-matrix.md`), mirroring
the Apple keychain checklist:
- share a file into Myne while the vault is **locked** → a `MYF1` blob appears under
  `sealed/`, no biometric prompt;
- unlock → the drain imports it into the attachment library (SF4/SF5 toast);
- confirm the key is **device-only** (does not restore onto a different device / after a
  Keystore reset the old blobs fail closed, not silently).
