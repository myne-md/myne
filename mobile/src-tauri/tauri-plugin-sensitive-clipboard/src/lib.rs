// SPDX-License-Identifier: AGPL-3.0-only
//! Clipboard transport for the mobile client, with OS-enforced sensitivity for
//! secrets (myne-md/myne#390 + myne-md/myne#455).
//!
//! # Why this exists instead of `tauri-plugin-clipboard-manager`
//!
//! That plugin was declared in `mobile/package.json` and registered nowhere: no
//! Cargo dependency, no `.plugin()` call, no capability grant. Every call through
//! it was dispatched to a plugin that does not exist and rejected at runtime,
//! which is why the account-number Copy on the vault-creation screen has never
//! worked on any device. Wiring it up would have fixed the dispatch and left the
//! interesting half undone.
//!
//! # The interesting half: a write can be SENSITIVE
//!
//! A generic clipboard plugin has one write. This one has two, and the second
//! asks the OS for guarantees a JavaScript timer cannot provide:
//!
//! - **iOS**: `UIPasteboard.setItems` with `.localOnly` and `.expirationDate`.
//!   `localOnly` keeps the item off Universal Clipboard, so twenty-four recovery
//!   words do not appear on the user's Mac and iPad. `expirationDate` has the OS
//!   remove the item, which survives the app being killed — and expires THAT
//!   item, so it can never destroy something the user copied afterwards, which a
//!   read-compare-clear can only approximate.
//!
//!   **The two options are not independent, and this is the load-bearing part.**
//!   With `localOnly` false, the expiry applies to the local pasteboard but not
//!   reliably to Universal Clipboard: the data stays pasteable on nearby devices
//!   well after it expires. Setting the expiry alone is insufficient. Every
//!   secret write therefore sets BOTH, always, and the Swift side has no path
//!   that sets one without the other.
//!
//! - **Android**: `ClipDescription`'s sensitivity extra where the OS has one.
//!   **This is a RENDERING hint, not an access control.** It suppresses the paste
//!   preview and defends against shoulder-surfing and background screen capture;
//!   it does NOT stop another app or a clipboard manager from reading the
//!   clipboard programmatically. The first pass at this design treated it as the
//!   Android counterpart of `localOnly`. It is not, and the recovery-phrase Copy
//!   is withheld on Android entirely because of it.
//!
//! # Tiers
//!
//! [`Sensitivity::Plain`] is an ordinary content copy: a note, a wikilink. It
//! sets neither option, because a user copying a note may legitimately want it on
//! their Mac.
//!
//! [`Sensitivity::Secret`] is a credential. Both options, always.
//!
//! The tier is the CALLER's statement about the value, and the plugin's job is to
//! honour it rather than to guess. Guessing from content is exactly the kind of
//! heuristic that fails open on the one value it did not recognise.
//!
//! # What is NOT here
//!
//! No clear command. On iOS the expiry is the clear and the OS owns it; on
//! Android the clear is scheduled Kotlin-side inside the write. A WebView-facing
//! clear would be a command whose only honest use is undoing a write the same
//! WebView just made, and it would need a read to be safe, which is the grant
//! this whole design withholds.

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginApi, TauriPlugin},
    AppHandle, Manager, Runtime,
};
use zeroize::Zeroizing;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_sensitive_clipboard);

/// How the OS should treat the written value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Sensitivity {
    /// Ordinary content. No confinement, no expiry: a user copying a note may
    /// want it on their other devices, and expiring it under them would be a
    /// surprise rather than a protection.
    Plain,
    /// A credential. Device-confined and expiring on iOS; flagged and cleared on
    /// Android where the OS version allows.
    Secret,
}

/// Arguments for the Swift / Kotlin `writeText` invocation.
#[cfg(any(target_os = "ios", target_os = "android"))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteArgs<'a> {
    value: &'a str,
    /// Serialized as `"plain"` / `"secret"`; the native sides branch on it.
    sensitivity: Sensitivity,
    /// Seconds until the OS should drop the item. Ignored for `Plain`.
    expire_after_secs: u32,
}

/// Arguments for the native `readText` invocation (none).
#[cfg(any(target_os = "ios", target_os = "android"))]
#[derive(Serialize)]
struct ReadArgs {}

/// The result of a read: the clipboard's text, or `None` when it holds no text.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ReadResponse {
    /// The clipboard text, or `null`/absent when the clipboard holds something
    /// that is not text (an image, a file) or is empty. Absent rather than empty
    /// string on purpose: "the user has an image on the clipboard" and "the user
    /// has an empty string on the clipboard" are different, and a paste button
    /// should not act on the first.
    #[serde(default)]
    pub value: Option<String>,
}

/// The window a secret is allowed to sit on the clipboard.
///
/// Matches the desktop client's `CLIPBOARD_AUTO_CLEAR_MS` and the window
/// `recovery-flow.md` §2.2 describes. It lives here rather than being passed from
/// the WebView because a caller that could shorten it could also lengthen it.
/// `pub` because it is a contract, not an implementation detail, and because on
/// a non-mobile build (the macOS dev host) nothing else references it and a
/// private one would be dead code under `clippy -D warnings`. Suppressing that
/// with an `allow` would have hidden the more useful fact: this number is one of
/// three copies of the same window — here, the desktop client's
/// `CLIPBOARD_AUTO_CLEAR_MS`, and `recovery-flow.md` §2.2 — and it is worth being
/// reachable so a future drift check can compare them.
pub const SECRET_EXPIRY_SECS: u32 = 30;

/// Failure surface, serialized to the WebView.
#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum Error {
    /// This build has no clipboard backing (the macOS dev host, or a desktop
    /// target that reached this crate by accident). A modelled refusal rather
    /// than a panic, so the crate still `cargo check`s everywhere.
    #[error("the clipboard is not available on this platform")]
    Unsupported,
    /// The native side refused or failed.
    #[error("clipboard operation failed: {0}")]
    Plugin(String),
}

/// The managed plugin state. On a mobile target it holds the native plugin
/// handle; elsewhere it is a zero-sized marker so the commands can answer
/// [`Error::Unsupported`].
pub struct SensitiveClipboard<R: Runtime> {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    handle: tauri::plugin::PluginHandle<R>,
    // `fn() -> R` keeps this `Send + Sync` regardless of R's own auto-traits (a
    // bare `PhantomData<R>` would demand `R: Send + Sync` at `app.manage`).
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    _marker: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> SensitiveClipboard<R> {
    /// Write `value` to the clipboard at the given tier.
    pub fn write(&self, value: &str, sensitivity: Sensitivity) -> Result<(), Error> {
        #[cfg(any(target_os = "ios", target_os = "android"))]
        {
            self.handle
                .run_mobile_plugin::<()>(
                    "writeText",
                    WriteArgs {
                        value,
                        sensitivity,
                        expire_after_secs: SECRET_EXPIRY_SECS,
                    },
                )
                .map_err(|e| Error::Plugin(e.to_string()))
        }
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        {
            let _ = (value, sensitivity);
            Err(Error::Unsupported)
        }
    }

    /// Read the clipboard's text, if it holds any.
    pub fn read(&self) -> Result<ReadResponse, Error> {
        #[cfg(any(target_os = "ios", target_os = "android"))]
        {
            self.handle
                .run_mobile_plugin("readText", ReadArgs {})
                .map_err(|e| Error::Plugin(e.to_string()))
        }
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        {
            Err(Error::Unsupported)
        }
    }
}

/// Extension trait so callers reach the plugin as `app.sensitive_clipboard()`.
pub trait SensitiveClipboardExt<R: Runtime> {
    fn sensitive_clipboard(&self) -> &SensitiveClipboard<R>;
}

impl<R: Runtime, T: Manager<R>> SensitiveClipboardExt<R> for T {
    fn sensitive_clipboard(&self) -> &SensitiveClipboard<R> {
        self.state::<SensitiveClipboard<R>>().inner()
    }
}

// ── All three commands are `async`, and that is load-bearing ─────────────────
//
// A sync command runs on the Android main thread, and `run_mobile_plugin` parks
// on a `recv` waiting for the Kotlin side to answer, which it can only do from
// the main thread it is now blocking. That is a deadlock. This crate is more
// exposed to it than the siblings carrying the same warning: BOTH native halves
// resolve from inside a `runOnUiThread` / `DispatchQueue.main.async` block, so
// there is no arrangement in which a sync command works here.
//
// Do NOT "simplify" these to sync because they appear to await nothing.
// `tauri-plugin-reminders` carries the same note for the same reason.

/// Write ordinary, non-secret text (a note body, a wikilink).
#[tauri::command]
async fn write_text<R: Runtime>(app: AppHandle<R>, value: String) -> Result<(), Error> {
    app.sensitive_clipboard().write(&value, Sensitivity::Plain)
}

/// Write a credential: device-confined and expiring where the OS supports it.
#[tauri::command]
async fn write_secret<R: Runtime>(app: AppHandle<R>, value: String) -> Result<(), Error> {
    // First non-doc statement, per `src-tauri/AGENTS.md`'s secret-handling
    // discipline and `recovery-flow.md` §3.5's MUST: once Rust holds a recovery
    // phrase, it holds it in a `Zeroizing<String>`. The desktop command for the
    // identical operation does this on its own first line.
    let value = Zeroizing::new(value);
    app.sensitive_clipboard().write(&value, Sensitivity::Secret)
}

/// Read the clipboard's text.
///
/// GRANTED to the main window, mobile-only, for one caller: the recovery
/// screen's Paste. This is the direction myne#379 removed from the desktop seam,
/// so the grant carries its argument and its cost next to it in
/// `permissions/default.toml` rather than being implied by its presence here.
#[tauri::command]
async fn read_text<R: Runtime>(app: AppHandle<R>) -> Result<ReadResponse, Error> {
    // What this can and cannot do about zeroization, stated rather than implied.
    //
    // The value is, on the one screen that calls this, a recovery phrase the user
    // just pasted, and `recovery-flow.md` §3.5 makes zeroization a MUST once Rust
    // holds it. It CANNOT be zeroized end to end: the whole purpose of the command
    // is to hand the value to the WebView, so a copy leaves this process by
    // design and serde owns that copy.
    //
    // What is achievable is that the intermediate Rust allocation does not
    // outlive the call. Wrapping it means the buffer the native side handed us is
    // zeroed when this function returns, instead of being freed with the phrase
    // still in it.
    let held = app.sensitive_clipboard().read()?.value.map(Zeroizing::new);
    Ok(ReadResponse {
        value: held.as_ref().map(|v| v.to_string()),
    })
}

/// Register the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("sensitive-clipboard")
        .invoke_handler(tauri::generate_handler![
            write_text,
            write_secret,
            read_text
        ])
        .setup(|app, api| {
            let state = build_state(&api)?;
            app.manage(state);
            Ok(())
        })
        .build()
}

#[cfg(target_os = "ios")]
fn build_state<R: Runtime>(
    api: &PluginApi<R, ()>,
) -> Result<SensitiveClipboard<R>, Box<dyn std::error::Error>> {
    let handle = api.register_ios_plugin(init_plugin_sensitive_clipboard)?;
    Ok(SensitiveClipboard { handle })
}

#[cfg(target_os = "android")]
fn build_state<R: Runtime>(
    api: &PluginApi<R, ()>,
) -> Result<SensitiveClipboard<R>, Box<dyn std::error::Error>> {
    let handle = api.register_android_plugin(
        "md.myne.mobile.sensitiveclipboard",
        "SensitiveClipboardPlugin",
    )?;
    Ok(SensitiveClipboard { handle })
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn build_state<R: Runtime>(
    _api: &PluginApi<R, ()>,
) -> Result<SensitiveClipboard<R>, Box<dyn std::error::Error>> {
    Ok(SensitiveClipboard {
        _marker: std::marker::PhantomData,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // The tier is a wire value the Swift and Kotlin sides branch on by STRING, so
    // its serialization is part of the contract rather than an implementation
    // detail. A rename here compiles clean on both sides and silently downgrades
    // every secret write to a plain one, which is the exact failure this crate
    // exists to prevent: the value would land on the pasteboard with no
    // confinement and no expiry, and nothing would report it.
    #[test]
    fn sensitivity_serializes_to_the_strings_the_native_sides_match_on() {
        assert_eq!(
            serde_json::to_string(&Sensitivity::Plain).unwrap(),
            "\"plain\"",
        );
        assert_eq!(
            serde_json::to_string(&Sensitivity::Secret).unwrap(),
            "\"secret\"",
        );
    }

    // The window is a protective envelope, not a preference, so it is pinned
    // rather than left to whatever the last edit made it. It matches the desktop
    // client's own auto-clear window and `recovery-flow.md` §2.2.
    #[test]
    fn secret_expiry_matches_the_desktop_window() {
        assert_eq!(SECRET_EXPIRY_SECS, 30);
    }

    // A read that finds no text must be `None`, never `Some("")`. A paste button
    // acting on an empty string would clear the field the user was trying to
    // fill, which on the recovery screen means deleting words they already typed.
    #[test]
    fn read_response_absent_value_deserializes_to_none() {
        let empty: ReadResponse = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.value, None);
        let null: ReadResponse = serde_json::from_str("{\"value\":null}").unwrap();
        assert_eq!(null.value, None);
        let text: ReadResponse = serde_json::from_str("{\"value\":\"hello\"}").unwrap();
        assert_eq!(text.value.as_deref(), Some("hello"));
    }
}
