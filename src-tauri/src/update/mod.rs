//! The desktop self-update domain model.
//!
//! This module holds the types the update check speaks in, and nothing that
//! does the checking. Signature verification, hash verification and the
//! anti-rollback version gate all belong to `tauri-plugin-updater`, whose
//! signature check cannot be disabled; reimplementing any of them here would
//! be a second crypto path beside the plugin's, which is exactly what this
//! module is shaped to avoid. What is here is the vocabulary: what a successful
//! check returns, and the closed set of reasons a check can fail.
//!
//! It lives in the desktop crate rather than `myne-core` on purpose. The
//! updater exists only on the three desktop targets (`tauri-plugin-updater`
//! supports Linux, Windows and macOS and not Android or iOS), while
//! `myne-core` compiles for wasm32 and for the mobile clients, where an
//! update type would be dead weight at best and a false affordance at worst.
//!
//! Nothing in this module's own types touches the network, the clock, key
//! material or a protocol identifier. `prefs` (declared below) is the one child
//! that touches the filesystem, and only to store this device's auto-check
//! toggle. The failure enum carries no `String`, so no OS message and no path
//! can ride out through it (see `src-tauri/AGENTS.md` "Secret-handling logging
//! discipline").

use serde::Serialize;

pub mod prefs;

/// The result of a check that did not fail.
///
/// A failed check is the `Err` arm of the command's `Result`, never a value
/// here, so there is no status variant that means "something went wrong" and
/// the UI never has to tell a failure apart from an update.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateStatus {
    /// The running version is current; nothing is offered.
    UpToDate,
    /// A newer version is available. The VERSION GATE and the version
    /// comparator ran, and the artifact this offer names is signature-verified
    /// when the install fetches it.
    ///
    /// What is deliberately NOT claimed: that the manifest this value came from
    /// is itself signature-verified here. `tauri-plugin-updater` verifies the
    /// artifact's minisign signature inside `download_and_install`, against the
    /// offline release key pinned in the build, and its `check()` reaches no
    /// signature path at all. So `version` and `notes` are transport-trusted
    /// (TLS to `downloads.myne.md`), which is why `notes` is displayed as plain
    /// text with no link and no input beside it. An earlier revision of this
    /// comment said the value "was verified by the updater (signature and
    /// version gate)", which was false for the check path and is why the
    /// sentence is spelled out here.
    Available {
        /// The offered version, as the manifest named it.
        version: String,
        /// Release notes, when the manifest carries them.
        notes: Option<String>,
    },
}

/// Why an update check failed, as a closed set the UI can render.
///
/// Coarse on purpose: this is a presentation vocabulary, not a mirror of the
/// updater's error type. A new failure the UI cannot yet distinguish maps to
/// [`UpdateCheckError::Other`] rather than widening this set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(rename_all = "snake_case")]
pub enum UpdateCheckError {
    /// The origin could not be reached: offline, a TLS failure, or a non-2xx
    /// response. The ordinary transient case, retried later and shown calmly.
    #[error("the update origin could not be reached")]
    Unreachable,
    /// The offered update failed verification: a bad signature, a hash
    /// mismatch, or an unparseable manifest. The install is left untouched.
    #[error("the offered update failed verification")]
    Verification,
    /// This build or platform cannot self-update.
    #[error("this build cannot self-update")]
    Unsupported,
    /// Any other failure. Deliberately opaque: the cause is discarded, never sent.
    #[error("the update check failed")]
    Other,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn up_to_date_serializes_with_its_kind_tag() {
        let v = serde_json::to_value(UpdateStatus::UpToDate).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "up_to_date" }));
    }

    #[test]
    fn available_carries_version_and_notes() {
        let v = serde_json::to_value(UpdateStatus::Available {
            version: "0.10.0".into(),
            notes: Some("Fixes a crash on launch.".into()),
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "kind": "available",
                "version": "0.10.0",
                "notes": "Fixes a crash on launch.",
            })
        );
    }

    #[test]
    fn available_serializes_absent_notes_as_null() {
        let v = serde_json::to_value(UpdateStatus::Available {
            version: "0.10.0".into(),
            notes: None,
        })
        .unwrap();
        assert_eq!(v.get("notes"), Some(&serde_json::Value::Null));
    }

    #[test]
    fn every_error_variant_has_a_stable_snake_case_wire_name() {
        // Constructs every variant, so a new one cannot be added without a
        // wire name, and the closed set stays exhaustive.
        assert_eq!(
            serde_json::to_value(UpdateCheckError::Unreachable).unwrap(),
            serde_json::json!("unreachable")
        );
        assert_eq!(
            serde_json::to_value(UpdateCheckError::Verification).unwrap(),
            serde_json::json!("verification")
        );
        assert_eq!(
            serde_json::to_value(UpdateCheckError::Unsupported).unwrap(),
            serde_json::json!("unsupported")
        );
        assert_eq!(
            serde_json::to_value(UpdateCheckError::Other).unwrap(),
            serde_json::json!("other")
        );
    }

    #[test]
    fn error_display_is_a_static_sentence() {
        assert_eq!(
            UpdateCheckError::Unreachable.to_string(),
            "the update origin could not be reached"
        );
    }
}
