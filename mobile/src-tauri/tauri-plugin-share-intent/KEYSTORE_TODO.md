# Android Keystore device-key for share-import — status & verification TODO

**Feature:** share-import staging queue (`MYF1`, `spec/protocol.md` §9.20), SF3 / SYNC-3.
**Status of the Android device key:** **implemented AND wired.** The Kotlin `@Command`, the
plugin-side Rust seam, the `core` provider trait, the host implementation and the managed-state
registration all exist, and `share_import`'s own seal/drain commands reach the Keystore through
them. What is still owed is **device verification**, not wiring.

**What this file used to say, and why it changed.** Until this status was corrected, the "what is
NOT done" half of this file described the seam as unconnected and carried a recommended
`AppHandle`-threading change as future work. That change landed, in the shape the recommendation
described (see "How it is wired" below), so a reader following this file would have re-implemented
something already in the tree. The file is the manual-test roster's reference for this surface, so
a stale status here is a tester being told to expect the wrong result.

## Why a native provider is needed at all

The share-import queue seals a file the user shared into Myne while the vault may be
**locked**, so it cannot use a `root_key`-derived KEK. It needs a **device-global,
non-biometric, device-only** 32-byte symmetric key held by the OS
(`core/src/plugins/share_import/device_key.rs`). Apple targets have this via the Keychain
(service string `md.myne.shareimport`, `AccessibleAfterFirstUnlockThisDeviceOnly`, no
`SecAccessControl` flags).

## What is implemented (compiles; device verification pending)

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
   the 32-byte length, and returns a `Zeroizing<[u8; 32]>`.

## How it is wired (the change this file used to call future work)

`myne-core` must not depend on this plugin (the desktop client compiles the same crate), so
the dependency is inverted with a trait, exactly as recommended:

1. `core/src/plugins/share_import/device_key.rs` declares
   `AndroidShareDeviceKeyProvider` and a managed-state wrapper `AndroidShareDeviceKey`.
2. `core/src/plugins/share_import/commands.rs`'s `seal_share` and `drain_pending_shares` call
   `device_key::resolve(&app)`, which on Android reads the managed provider and on Apple/desktop
   falls through to the no-arg `get_or_create()`.
3. `mobile/src-tauri/src/lib.rs` implements that trait for a `KeystoreProvider` holding the
   `AppHandle`, calls `tauri_plugin_share_intent::ShareIntent::get_or_create_device_key()`, and
   registers the managed state.
4. Off-target arms are unchanged: the no-arg `get_or_create()` still returns
   `ShareImportError::HardwareUnavailable` on Android and on desktop, so a caller that calls it
   DIRECTLY, rather than through `resolve(&app)`, no-ops cleanly instead of failing. **`captures` is
   such a caller today**: its three meeting-capture commands hold an `AppHandle` yet seal `MYF1` blobs
   under this same device key through the no-arg call, so a meeting chunk still no-ops on Android.
   Routing them through `resolve(&app)` is a behaviour change that needs the device verification
   below first.

## Device verification (owed before the gate is trusted)

Verify on a **real Android device** (`docs/dev/device-matrix.md`), mirroring the Apple keychain
checklist:

- share a file into Myne while the vault is **locked** → a `MYF1` blob appears under `sealed/`, no
  biometric prompt;
- unlock → the drain imports it into the attachment library (SF4/SF5 toast);
- confirm the key is **device-only** (does not restore onto a different device, and after a Keystore
  reset the old blobs fail closed rather than silently reading as empty).
