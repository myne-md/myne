// SPDX-License-Identifier: AGPL-3.0
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
//!
//! [`Channel`] carries the two manifest URLs on `downloads.myne.md`. That is a
//! first-party origin address and not a protocol identifier, but the sentence
//! above is worth being exact about rather than leaving a reader to trip over
//! it: the module holds the URLs as data and performs no request with them.

use serde::Serialize;

pub mod prefs;

/// The first-party origin every update manifest lives under.
///
/// One value, so the per-channel path is the only thing a channel adds. Both
/// manifests are signed with the same offline release key.
pub const MANIFEST_ORIGIN: &str = "https://downloads.myne.md/releases/";

/// A release line: the name it is spoken as, and the manifest it reads.
///
/// One compile-time value decides BOTH the manifest the client fetches and the
/// channel the About panel shows. It is resolved once, here, and every reader
/// asks this type rather than matching the environment variable again: the
/// readers used to keep private copies of the same `match`, so a channel added
/// to one of them and not the others was a silent disagreement between the log
/// header, the About label and the fetched manifest.
///
/// Which channel a build follows is NOT a runtime choice
/// (`decisions/clients/0651`): there is no switcher in the app and no downgrade
/// path, so a channel is a property of the binary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Channel {
    name: &'static str,
    manifest: &'static str,
}

/// The channels this repository ships, in order.
///
/// **The FIRST entry is what an unset `MYNE_UPDATE_CHANNEL` means**, and that
/// position is the whole reason the list is ordered. Adding a third channel
/// means adding a row here, a case to the publish procedure in the runbook, a
/// label in the About panel and a file name to `manifestFilename` in
/// `scripts/emit-update-manifest.mjs`; `scripts/check-update-channel.mjs`
/// compares this table against that emitter so a half-added channel fails the
/// commit rather than shipping a client that fetches a file nobody writes.
///
/// `decisions/clients/0651` names the pair; `decisions/clients/0701` is the
/// rule that the beta document is never older than the stable one, which is why
/// both are published for every release.
const CHANNELS: [Channel; 2] = [
    Channel {
        name: "stable",
        manifest: "latest.json",
    },
    Channel {
        name: "beta",
        manifest: "latest-beta.json",
    },
];

/// `true` when two strings are equal, as a `const fn`.
///
/// `str` equality is not available in a constant (it is not a const trait yet),
/// so the comparison is by bytes. This exists only so the channel can be
/// resolved at COMPILE time, which is what makes an unrecognized value fail the
/// build instead of a launch.
const fn str_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

/// Which row of [`CHANNELS`] this build uses, resolved at COMPILE time.
///
/// A `const` ITEM rather than the body of a `const fn`, and that is the whole
/// mechanism: a constant is evaluated during compilation, so the `panic!` below
/// is a build failure. Written inside the function instead, an unrecognized
/// value would only surface when the app happened to call it, and `_ =>` would
/// be a silent fallback to the wrong channel.
///
/// `compile_error!` is deliberately not used: it errors wherever it appears,
/// taken branch or not, so it cannot express "this value is wrong".
const CHANNEL_INDEX: usize = match option_env!("MYNE_UPDATE_CHANNEL") {
    None => 0,
    Some(value) => {
        let mut found = usize::MAX;
        let mut i = 0;
        while i < CHANNELS.len() {
            if found == usize::MAX && str_eq(value, CHANNELS[i].name) {
                found = i;
            }
            i += 1;
        }
        if found == usize::MAX {
            panic!("MYNE_UPDATE_CHANNEL must be `stable` or `beta` (or unset for stable)");
        }
        found
    }
};

impl Channel {
    /// The channel this build was COMPILED for.
    ///
    /// `MYNE_UPDATE_CHANNEL=beta` at build time (the release sets it for the
    /// beta flavour, together with the matching Vite define that drives the
    /// About panel's label) selects beta; unset selects the first row of
    /// [`CHANNELS`].
    ///
    /// **An unrecognized value is a compile error, deliberately.** The `_` arm
    /// this replaced fell back to stable, which meant `MYNE_UPDATE_CHANNEL=Beta`
    /// or any typo'd channel name produced a build the maintainer believed was
    /// beta and was not, with nothing anywhere saying so.
    pub const fn from_env() -> Self {
        CHANNELS[CHANNEL_INDEX]
    }

    /// The channel's name, as the user, the log header and the Vite define
    /// spell it.
    pub const fn as_str(self) -> &'static str {
        self.name
    }

    /// The file name of this channel's manifest, and the URL a client reads.
    ///
    /// This is the ONLY place the updater's endpoint is decided. There is no
    /// second one in `tauri.conf.json`: the plugin is built in
    /// `plugins::update` with `UpdaterBuilder::endpoints`, which REPLACES the
    /// config list rather than merging with it
    /// (`tauri-plugin-updater`'s `UpdaterBuilder::build` reads
    /// `self.endpoints.unwrap_or_else(|| config.endpoints.clone())`), so a list
    /// in the config would be a second source of truth that is silently
    /// overridden. `scripts/check-update-channel.mjs` fails if one reappears.
    ///
    /// The file name half is the same string
    /// `scripts/emit-update-manifest.mjs` writes, compared against it by that
    /// guard rather than trusted because this sentence says so. There is no
    /// accessor for the file name alone: nothing in production needs it split,
    /// and an unused one is dead code in this private module.
    pub fn endpoint(self) -> String {
        format!("{MANIFEST_ORIGIN}{}", self.manifest)
    }
}

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

/// The event name the install streams its progress on.
///
/// A constant rather than a literal at the `emit` and at the listener, because a
/// typo on either side is a bar that never moves and reports nothing about why:
/// the WebView's `listen` on a name nothing emits simply never fires, so the
/// failure is a permanently indeterminate progress bar rather than an error.
/// `src/platform/update.ts` carries the same string; that duplication is the
/// seam's (the TypeScript side cannot import a Rust constant) and
/// `tests/screens/UpdatingScreen.test.tsx` drives the rendering against it.
pub const PROGRESS_EVENT: &str = "update:progress";

/// What the install is doing, as the WebView is told it.
///
/// Three phases, and the split is what the host can actually testify to rather
/// than a decoration of one "installing" state:
///
/// - `Downloading` is byte progress from the transport. `total` is `null` when
///   the origin sends no `Content-Length`, which is why the UI has an
///   indeterminate shape instead of inventing a percentage.
/// - `Verifying` is emitted after the last chunk and before the artifact is
///   touched, because that is exactly where `Update::download` verifies its
///   minisign signature. Naming it is worth the phase: it is the step where a
///   tampered artifact is caught, and it is invisible otherwise.
/// - `Installing` is everything after the verified bytes exist: unpacking the
///   `.dmg`, replacing the AppImage, running the Windows installer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum UpdateProgress {
    /// Bytes arriving. `downloaded` counts UP from zero for this attempt.
    Downloading {
        /// Bytes received so far in this attempt.
        downloaded: u64,
        /// The whole artifact's size, when the origin declared one.
        total: Option<u64>,
    },
    /// The download finished and its signature is being checked.
    Verifying,
    /// The verified artifact is being written into place.
    Installing,
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
    fn progress_serializes_with_its_phase_tag_and_a_nullable_total() {
        // The wire shape the TypeScript union is written against, so a renamed
        // tag or a field that stopped being nullable fails here rather than in a
        // bar that silently never moves.
        assert_eq!(
            serde_json::to_value(UpdateProgress::Downloading {
                downloaded: 1024,
                total: Some(4096),
            })
            .unwrap(),
            serde_json::json!({
                "phase": "downloading",
                "downloaded": 1024,
                "total": 4096,
            })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Downloading {
                downloaded: 1024,
                total: None,
            })
            .unwrap(),
            serde_json::json!({
                "phase": "downloading",
                "downloaded": 1024,
                "total": null,
            })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Verifying).unwrap(),
            serde_json::json!({ "phase": "verifying" })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Installing).unwrap(),
            serde_json::json!({ "phase": "installing" })
        );
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

    #[test]
    fn every_channel_names_its_own_manifest_under_the_origin() {
        // Both rows spelled out, so moving either file name fails here rather
        // than at the first client that cannot find its manifest.
        // `scripts/check-update-channel.mjs` holds the same pairs against the
        // emitter that writes the files; this one holds them against
        // themselves, with no network and no other language.
        assert_eq!(CHANNELS[0].as_str(), "stable");
        assert_eq!(CHANNELS[0].manifest, "latest.json");
        assert_eq!(
            CHANNELS[0].endpoint(),
            format!("{MANIFEST_ORIGIN}latest.json")
        );
        assert_eq!(CHANNELS[1].as_str(), "beta");
        assert_eq!(CHANNELS[1].manifest, "latest-beta.json");
        assert_eq!(
            CHANNELS[1].endpoint(),
            format!("{MANIFEST_ORIGIN}latest-beta.json")
        );
    }

    #[test]
    fn the_origin_is_https_and_the_channels_never_share_a_manifest() {
        // The failure this pins: pointing beta at the stable document, which
        // compiles, ships, and leaves every beta install reading the wrong
        // channel's version.
        assert!(MANIFEST_ORIGIN.starts_with("https://"));
        assert_ne!(CHANNELS[0].manifest, CHANNELS[1].manifest);
        assert_ne!(CHANNELS[0].as_str(), CHANNELS[1].as_str());
    }

    #[test]
    fn this_build_resolves_to_a_row_of_the_table() {
        // A test build has `MYNE_UPDATE_CHANNEL` unset on every lane that runs
        // it, so this is the first row in practice. The expectation is written
        // against the compile-time value, so a deliberate
        // `MYNE_UPDATE_CHANNEL=beta cargo test` checks the beta row instead of
        // failing.
        let expected = match option_env!("MYNE_UPDATE_CHANNEL") {
            Some("beta") => CHANNELS[1],
            _ => CHANNELS[0],
        };
        assert_eq!(Channel::from_env(), expected);
    }
}
