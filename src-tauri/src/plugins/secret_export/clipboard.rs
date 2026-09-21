//! Host-side clipboard auto-clear for the vault-creation secret handoff
//! (myne#379).
//!
//! **Why this command exists at all.** `docs/spec/recovery-flow.md` §2.2 makes
//! the 30 s clipboard auto-clear a MUST, *gated on a read precondition*: the
//! clear must verify the clipboard still holds the phrase, so that unrelated
//! contents the user copied since are never destroyed. That MUST is a
//! **comparison** requirement — it says nothing about which process performs
//! it, and the flow needs no part of the clipboard's *value*, only the boolean
//! `current == value`.
//!
//! Performing the comparison in the WebView cost a standing
//! `clipboard-manager:allow-read-text` grant on the main window. That
//! permission has no scope object, the ACL has no gesture-scoped or time-boxed
//! form, and nothing revokes a granted permission at runtime — so it was
//! effectively process-lifetime, for one `setTimeout` body. Read is also the
//! more dangerous direction than write: a write destroys the user's clipboard,
//! a read *harvests* it, and what the user last copied — a password-manager
//! entry, a TOTP seed — never belonged to Myne.
//!
//! The asymmetry this closes lived inside a single file. `PhraseStep`'s **Save
//! as file** half routes through `save_secret_text` precisely so the WebView
//! holds no filesystem scope (that is the whole reason this plugin exists);
//! its **Copy** half, two functions up in `src/lib/secret-export.ts`, held an
//! OS-clipboard read scope for the process lifetime. Filesystem reach was
//! refused on this reasoning; clipboard reach was not.
//!
//! **What it does not buy.** It removes the ACL-granted, prompt-free
//! OS-clipboard *read* primitive from page context. It does not contain a
//! script that has achieved execution otherwise — every vault command the
//! capability grants stays reachable — and whether the desktop WebView
//! independently exposes `navigator.clipboard.readText()` to the `tauri://`
//! origin is a separate, unverified question per platform.
//
// see: src-tauri/AGENTS.md "Secret-handling logging discipline"

use tauri::{AppHandle, Runtime};
use tauri_plugin_clipboard_manager::ClipboardExt;
use zeroize::Zeroizing;

/// The §2.2 read precondition, as a pure predicate.
///
/// `Err` means the clipboard holds non-text content (an image, a file, or
/// nothing) — which already means our value is gone, so there is nothing to
/// clear. That is the branch `src/lib/secret-export.ts` took by swallowing the
/// `readText` rejection; preserving it exactly is the point of splitting the
/// decision out from the IO.
fn should_clear(read: Result<&str, ()>, value: &str) -> bool {
    matches!(read, Ok(current) if current == value)
}

/// Clear the clipboard iff it still holds exactly `value`.
///
/// Infallible by contract, which mirrors the JS this replaces: every failure
/// path there was swallowed, and a clipboard that has moved on is the expected
/// case rather than an error worth surfacing. The caller keeps its `try`/`catch`
/// for the one failure that is *not* about the clipboard — an ACL refusal.
///
/// **`spawn_blocking` is load-bearing for the read, not only for the secret.**
/// The plugin's own doc comment on `read_text` warns: "This method should not
/// be used on the main thread! Otherwise the underlying libraries may deadlock
/// on Linux, freezing the whole app, when trying to copy data copied from this
/// app" — which is exactly this call, on exactly this app's own copy. Moving a
/// read the WebView used to do onto the host introduces a thread-placement
/// requirement that did not exist before, and getting it wrong on Linux is a
/// whole-app freeze rather than a wrong answer.
#[tauri::command]
pub async fn clipboard_clear_if_matches<R: Runtime>(app: AppHandle<R>, value: String) {
    // First non-doc statement: bound the secret's lifetime to a Zeroizing
    // wrapper, which then moves into the closure and drops on its exit.
    let value = Zeroizing::new(value);

    let joined = tokio::task::spawn_blocking(move || {
        let clipboard = app.clipboard();
        // The clipboard's current contents are the same secret whenever the
        // comparison is going to succeed, so they get the same wrapper.
        let current = clipboard.read_text().map(Zeroizing::new);
        let matched = should_clear(current.as_ref().map(|c| c.as_str()).map_err(|_| ()), &value);
        if matched {
            clipboard.clear().is_ok()
        } else {
            // Nothing to do: either the clipboard moved on, or it holds
            // non-text content, which already means the value is gone.
            true
        }
    })
    .await;

    // A static stage tag only — `value`, the clipboard's contents and any
    // clipboard-error Display are all DENY-listed.
    match joined {
        Ok(true) => {}
        Ok(false) => tracing::warn!(
            stage = "clipboard_auto_clear",
            outcome = "clear_failed",
            "clipboard still held the secret but could not be cleared"
        ),
        Err(_) => tracing::warn!(
            stage = "clipboard_auto_clear",
            outcome = "join_failed",
            "clipboard auto-clear task did not complete"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::should_clear;

    #[test]
    fn clears_only_on_an_exact_match() {
        let phrase = "abandon ability able about above absent absorb abstract";
        assert!(should_clear(Ok(phrase), phrase));
    }

    #[test]
    fn leaves_a_clipboard_that_moved_on_alone() {
        // The §2.2 requirement in its own words: "so that later unrelated
        // clipboard contents are never destroyed."
        assert!(!should_clear(Ok("hunter2"), "the phrase"));
        assert!(!should_clear(Ok(""), "the phrase"));
        // A prefix is not a match — the compare is equality, not containment.
        assert!(!should_clear(Ok("the phras"), "the phrase"));
        assert!(!should_clear(Ok("the phrase "), "the phrase"));
    }

    #[test]
    fn a_read_failure_skips_the_clear_rather_than_forcing_it() {
        // Non-text content (image, file, empty) rejects the read. Our value is
        // already gone, so clearing would only destroy someone else's data —
        // the same branch the JS took by swallowing the rejection.
        assert!(!should_clear(Err(()), "the phrase"));
    }
}
