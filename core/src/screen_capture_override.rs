//! The device-local **screen-capture protection override** (myne-md/myne#482).
//!
//! One boolean, persisted at `<app_config_dir>/screen-capture.json`. With it on,
//! native screen-capture protection is off on this device, before unlock and
//! after it, and the per-vault `vault.prefs` toggle is superseded rather than
//! merely ignored.
//!
//! ## The lockout it exists to open
//!
//! Three shipped decisions compose into a trap nobody designed. Protection is
//! always ON before unlock (`decisions.md` 0131, 0135, and the `threat-model.md`
//! § 6 pre-unlock-always-ON property). The toggle that could turn it off lives in
//! `vault.prefs` (`MYP1`), which is AEAD-sealed under a `root_key`-derived KEK and
//! so is readable only *after* an unlock. And the control that writes it is in the
//! post-unlock Privacy panel. On Windows the protection genuinely works, so a user
//! on remote-control software or a screen magnifier sees a black window at the
//! unlock screen and has no path to the control that would clear it.
//!
//! What is behind that black window is not a pairing QR. It is the account number,
//! the 24-word recovery-phrase ceremony and the device-join QR, so a user who
//! cannot read the phrase cannot finish onboarding and cannot recover later. That
//! makes this a data-loss path, not only an accessibility one.
//!
//! ## Why it is not a `vault.prefs` field
//!
//! The same structural disqualification [`crate::vault_label::hide_flag`] records
//! for its own flag: at the one moment this has to be read there is no key with
//! which to read it. No arrangement of `PrefClass` makes a sealed field readable
//! with no key.
//!
//! ## Why it is not a sealed device-local blob
//!
//! Because it would ship nothing on the platform that has the bug. The sealed
//! stores whose `wrap_key` is available with **no user input** (`MYL1`, `MYK1`,
//! and `MYF1`'s working arm) all rest on a keychain, and that is the property
//! this read needs: it happens before the user has done anything.
//! [`crate::vault_label::key::platform_keychain`] is Apple-only, every other target
//! gets `UnavailableKeychain`, and wiring the Windows credential store is a
//! dependency decision in its own right (root `CLAUDE.md`). `MYQ1` is not a
//! counter-example and is stated apart rather than listed above, because it is
//! **provider-agnostic** (`protocol.md` § 9.14.2): its PIN provider derives a
//! `wrap_key` through Argon2id with no keychain, so it does ship on Windows and
//! Linux. It cannot serve this read for the other reason, which is that a
//! PIN-derived key needs the user to type the PIN. Meanwhile
//! `threat-model.md` § 6 claims screen-capture protection **only** on Windows 10
//! build 19041+. A sealed override would therefore exist on macOS alone, the
//! platform where nothing is claimed, and be absent on BOTH Linux and Windows.
//! Not "the two platforms where there is nothing to escape from", which an
//! earlier revision of this paragraph said in three files: Linux has no
//! keychain arm either, so it gets nothing, and the sentence contradicted its
//! own premise two lines above.
//!
//! So it is a plaintext device-local file, one more of a family already under
//! `<app_config_dir>`: `sync-config.json`, `tor-routing.json`,
//! `legal-consent.json`, `vault-names.json`, `backup-schedule.json`,
//! `clipper-install.json` and `ai-endpoint.json`. **Do not write a count here.**
//! The first version of this paragraph said "the fourth of its kind" and named
//! three, having missed `legal_consent.rs`, which is the same module shape
//! under the same directory, and the same wrong number reached the decision
//! entry and `threat-model.md`. Nobody can enumerate that family from memory
//! because no seam holds the roster, which is the finding rather than the typo.
//! `decisions.md` 0131 rejected a plaintext file for the
//! *per-vault preference*, where `vault.prefs` was available and free; that
//! reasoning does not reach a setting `vault.prefs` structurally cannot hold. The
//! leak it does create is one bit to an at-rest observer: "this device's window is
//! capturable", which is a targeting signal they cannot act on without the local
//! code execution that § 6 already records as able to reset the affinity itself.
//! Stated in `threat-model.md` § 7 rather than argued away.
//!
//! ## Which way absent fails, and which way corrupt fails
//!
//! They differ, and **both differ from
//! [`crate::vault_label::hide_flag::names_hidden_at_rest`]**, whose file fails ON
//! because ON is its privacy-preserving direction. Here the privacy-preserving
//! direction is the other one.
//!
//! **Absent means protection ON.** Nobody has touched the override, which is the
//! overwhelmingly common case and the shipped default.
//!
//! **Present-but-unreadable also means protection ON**
//! ([`protection_disabled_at_rest`]). A damaged file resolving to "disabled" would
//! switch a security control off for a user who may never have asked for that, on
//! the strength of bytes nobody can read. Resolving it the other way costs that user
//! the black window again, which is the exact lockout this module exists to open,
//! so it is not a cost to wave past. The `--disable-screen-capture-protection`
//! process flag is the recovery path for precisely that case, and it is why the flag
//! ships alongside the file rather than instead of it.
//!
//! ## Why it is not gated out of the wasm build
//!
//! `captures`, `export` and `share_import` ARE module-gated for `wasm32`, on the
//! rule `core/CLAUDE.md` states: a ported command that always answers
//! "unsupported" is dead code pretending to be a feature. This module is
//! deliberately not, and the difference is that it exposes no command. It is a
//! file reader and a reducer, with no `#[tauri::command]`, no host-only call and
//! nothing that compiles-but-panics on `wasm32` (every IO hop is on the
//! `VaultIo` seam). Gating it would buy a smaller wasm artefact by an amount too
//! small to measure and cost the reader of the browser arm a `#[cfg]` to reason
//! past. The absence users can observe is enforced one layer up, where it
//! belongs: `web/wasm/src/capability.rs` classifies the whole `screen-capture`
//! plugin `Class::Unsupported`, and the web capability descriptor omits
//! `screenCaptureProtection`, so no browser surface renders a control over this.
//!
//! Note what the `Err` arm never sees: an absent file reduces through the `Ok` arm
//! ([`read_screen_capture_override`] answers `Ok(default)`), so a fresh install
//! cannot land in the fail-on branch.

use crate::io_failure_kind::IoFailureKind;
use crate::singleton::{open_newest, OpenOutcome};
use crate::vault_io::{VaultIo, WriteOpts};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;

/// The file name under `<app_config_dir>`. Sibling of `tor-routing.json`,
/// `vault-names.json` and `ai-endpoint.json`.
///
/// **Its own file**, not a field on one of those, for the reason
/// [`crate::plugins::sync::tor_config`] records about its own: their write paths
/// construct a fresh value and persist it, so a field with a different lifetime
/// living there is one forgotten read-modify-write away from silently resetting.
/// Resetting THIS one to `false` puts the black window back in front of the user
/// who turned it off because they could not see through it.
pub const SCREEN_CAPTURE_FILE_NAME: &str = "screen-capture.json";

/// The device-local screen-capture override as persisted.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScreenCaptureOverride {
    /// `true` when this device may not apply native screen-capture protection at
    /// all. `false`, the default, is the client as it ships.
    #[serde(default)]
    pub disabled: bool,
}

/// Failure surface for reading or writing the override file.
///
/// Two variants and no `String`: this reaches the UI, and a path in an error
/// message is a disclosure (`src-tauri/CLAUDE.md` DENY list). Mirrors
/// [`crate::vault_label::hide_flag::HideFlagError`] and
/// [`crate::plugins::sync::tor_config::TorConfigError`] exactly, because it is the
/// same kind of file with the same two ways of going wrong.
#[derive(Debug, Clone, Copy, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail")]
pub enum ScreenCaptureOverrideError {
    /// Filesystem error reading or writing `screen-capture.json`.
    #[error("filesystem error on screen-capture.json")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },
    /// The file is present but did not parse as JSON.
    #[error("screen-capture.json parse failed")]
    Parse,
}

impl From<IoFailureKind> for ScreenCaptureOverrideError {
    fn from(io_error_kind: IoFailureKind) -> Self {
        ScreenCaptureOverrideError::Io { io_error_kind }
    }
}

/// `<app_config_dir>/screen-capture.json`, creating the directory if needed. The
/// same resolution [`crate::vault_label::hide_flag::hide_flag_path_from_host`]
/// does for its sibling, through the same seam.
pub async fn screen_capture_override_path_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
) -> Result<PathBuf, ScreenCaptureOverrideError> {
    let dir = host
        .app_config_dir()
        .map_err(|_| ScreenCaptureOverrideError::Io {
            io_error_kind: IoFailureKind::Other,
        })?;
    io.create_dir_all(&dir).await?;
    Ok(dir.join(SCREEN_CAPTURE_FILE_NAME))
}

/// Read the override from `path`. Absent means the default (protection applied);
/// present but unparseable is [`ScreenCaptureOverrideError::Parse`]. See the module
/// header for why those two answers are deliberately different.
pub async fn read_screen_capture_override(
    io: &dyn VaultIo,
    path: &Path,
) -> Result<ScreenCaptureOverride, ScreenCaptureOverrideError> {
    match open_newest(io, path, |bytes| {
        serde_json::from_slice::<ScreenCaptureOverride>(bytes)
    })
    .await
    {
        Ok(cfg) => Ok(cfg),
        Err(OpenOutcome::Absent) => Ok(ScreenCaptureOverride::default()),
        Err(OpenOutcome::Undecodable(_)) => Err(ScreenCaptureOverrideError::Parse),
        Err(OpenOutcome::Io(kind)) => Err(kind.into()),
    }
}

/// Persist the override to `path` (atomic replace, like its siblings).
pub async fn write_screen_capture_override(
    io: &dyn VaultIo,
    path: &Path,
    cfg: ScreenCaptureOverride,
) -> Result<(), ScreenCaptureOverrideError> {
    let bytes = serde_json::to_vec_pretty(&cfg).map_err(|_| ScreenCaptureOverrideError::Parse)?;
    io.write(path, &bytes, WriteOpts::default()).await?;
    Ok(())
}

/// Whether this device refuses screen-capture protection, given whatever
/// [`read_screen_capture_override`] answered.
///
/// The one place the "a damaged file keeps protection ON" rule is written down, so
/// it is a function with a test rather than a `match` arm somewhere in app setup.
/// **Every** reader goes through it. The startup resolution and the command the
/// Settings row reads. Because two readers with two reductions is exactly how a
/// switch comes to say one thing while the window does another.
///
/// **Every** `Err` resolves to `false`, [`ScreenCaptureOverrideError::Io`]
/// included, and that is narrower than it looks:
/// [`read_screen_capture_override`] answers an *absent* file with `Ok(default)`, so
/// an `Io` here is a file that exists and could not be read (permissions, a bad
/// sector, a directory in its place). That is the same situation `Parse` describes
/// and takes the same answer, for the same reason.
pub fn protection_disabled_at_rest(
    read: Result<ScreenCaptureOverride, ScreenCaptureOverrideError>,
) -> bool {
    match read {
        Ok(cfg) => cfg.disabled,
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{block_on, ScopedTempDir};
    use crate::vault_io::StdVaultIo;

    fn scratch(name: &str) -> (ScopedTempDir, PathBuf) {
        let dir = ScopedTempDir::new(&format!("screen-capture-override-{name}")).expect("scratch");
        let path = dir.path().join(SCREEN_CAPTURE_FILE_NAME);
        (dir, path)
    }

    #[test]
    fn absent_reads_as_the_shipped_default() {
        let (_dir, path) = scratch("absent");
        let read = block_on(read_screen_capture_override(&StdVaultIo, &path));
        assert_eq!(read, Ok(ScreenCaptureOverride { disabled: false }));
    }

    #[test]
    fn a_written_override_round_trips_both_ways() {
        let (_dir, path) = scratch("roundtrip");
        for disabled in [true, false] {
            block_on(write_screen_capture_override(
                &StdVaultIo,
                &path,
                ScreenCaptureOverride { disabled },
            ))
            .expect("write");
            let read = block_on(read_screen_capture_override(&StdVaultIo, &path));
            assert_eq!(read, Ok(ScreenCaptureOverride { disabled }));
        }
    }

    #[test]
    fn a_present_but_unparseable_file_is_parse_not_the_default() {
        let (_dir, path) = scratch("corrupt");
        std::fs::write(&path, b"{ not json").expect("seed");
        assert_eq!(
            block_on(read_screen_capture_override(&StdVaultIo, &path)),
            Err(ScreenCaptureOverrideError::Parse)
        );
    }

    // The reducer's two directions, injected separately. Asserting only that a
    // corrupt file keeps protection on would pass for a function that ignored its
    // input entirely, so the honest-`true` case is half the test.
    #[test]
    fn the_reducer_answers_disabled_only_for_a_file_that_says_so() {
        assert!(protection_disabled_at_rest(Ok(ScreenCaptureOverride {
            disabled: true
        })));
        assert!(!protection_disabled_at_rest(Ok(ScreenCaptureOverride {
            disabled: false
        })));
    }

    #[test]
    fn every_error_keeps_protection_on() {
        assert!(!protection_disabled_at_rest(Err(
            ScreenCaptureOverrideError::Parse
        )));
        assert!(!protection_disabled_at_rest(Err(
            ScreenCaptureOverrideError::Io {
                io_error_kind: IoFailureKind::PermissionDenied,
            }
        )));
    }

    // The rule this file inverts. If `hide_flag`'s reducer and this one ever agree
    // on a damaged file, one of the two has silently adopted the other's direction,
    // and each is the privacy-preserving answer for its own subject.
    #[test]
    fn a_damaged_file_fails_the_opposite_way_from_the_hide_names_flag() {
        let ours = protection_disabled_at_rest(Err(ScreenCaptureOverrideError::Parse));
        let theirs = crate::vault_label::hide_flag::names_hidden_at_rest(Err(
            crate::vault_label::hide_flag::HideFlagError::Parse,
        ));
        assert!(!ours, "a damaged override must keep protection applied");
        assert!(theirs, "a damaged hide-names flag must keep names hidden");
    }
}
