// SPDX-License-Identifier: AGPL-3.0-only
//! The device-local **hide vault names** flag (myne-md/myne#411).
//!
//! One boolean, persisted at `<app_config_dir>/vault-names.json`. With it on,
//! no vault's name is cached and none of the names already cached is readable;
//! with it off (the default, and the state of every existing install) the
//! picker shows the name of every vault this device has unlocked.
//!
//! ## Why it is not a `vault.prefs` field
//!
//! `vault.prefs` (`MYP1`) is AEAD-sealed under a `root_key`-derived KEK, so it
//! is readable only after that vault is unlocked. This flag governs what the
//! picker draws, and the picker runs **before** any unlock, so at the one moment
//! the flag has to be read there is no key with which to read it. That is a
//! structural disqualification rather than a preference: no arrangement of
//! `PrefClass` makes a sealed field readable with no key.
//!
//! It would be wrong even if it were readable. `vault.prefs` is per vault while
//! the picker is device-wide, so a per-vault field would need a rule about which
//! vault's setting governs a screen that lists all of them, and it syncs, so the
//! choice would follow the account onto machines that never made it.
//!
//! ## Why it is not `localStorage`
//!
//! `src/lib/accentColor.ts` and its siblings keep device-local UI preferences in
//! `localStorage`, and this is not one of them. Two reasons, and the second is
//! the load-bearing one. It has a **host-side consequence** (a key destruction),
//! which page-context code cannot perform. And it is a **security control**:
//! `localStorage` is writable by anything running in the WebView (TB2), so a
//! flag stored there could be flipped back on by page-context code and the
//! suppression it drives would be an honour system. The backend holds it, the
//! backend enforces it.
//!
//! ## Which way absent fails, and which way corrupt fails
//!
//! They differ, deliberately, following the [`crate::plugins::sync::tor_config`]
//! precedent that established the shape of a device-local boolean in this crate.
//!
//! **Absent means off.** Nobody has touched the option, which is the
//! overwhelmingly common case and the shipped default.
//!
//! **Present-but-unreadable means ON** ([`names_hidden_at_rest`]). A file that
//! exists is one somebody wrote, which means the option was used; resolving a
//! damaged one to `false` would quietly resume caching names for a person who
//! asked that they not be. Resolving it to `true` costs that person a picker of
//! neutral fallbacks, which is visible on the first launch and undone by one
//! toggle. Loud and recoverable beats quiet and leaking.
//!
//! Note what the `Err` arm never sees: an absent file reduces through the `Ok`
//! arm ([`read_hide_vault_names`] answers `Ok(default)`), so a fresh install
//! cannot land in the fail-on branch.

use crate::io_failure_kind::IoFailureKind;
use crate::singleton::{open_newest, OpenOutcome};
use crate::vault_io::{VaultIo, WriteOpts};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;

/// The file name under `<app_config_dir>`. Sibling of `tor-routing.json` and
/// `sync-config.json`.
///
/// **Its own file**, not a field on one of those, for the reason
/// `tor_config.rs` records about its own: their write paths construct a fresh
/// value and persist it, so a field with a different lifetime living there is
/// one forgotten read-modify-write away from silently resetting. Resetting THIS
/// one to `false` means the next unlock writes a name the user asked never to be
/// written.
pub const HIDE_FLAG_FILE_NAME: &str = "vault-names.json";

/// The device-local hide-vault-names preference as persisted.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HideVaultNamesConfig {
    /// `true` when no vault name may be cached and none already cached is
    /// readable. `false`, the default, is the picker as it ships.
    #[serde(default)]
    pub hidden: bool,
}

/// Failure surface for reading or writing the flag file.
///
/// Two variants and no `String`: this reaches the UI, and a path in an error
/// message is a disclosure (`src-tauri/AGENTS.md` DENY list). Mirrors
/// [`crate::plugins::sync::tor_config::TorConfigError`] exactly, because it is
/// the same kind of file with the same two ways of going wrong.
#[derive(Debug, Clone, Copy, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail")]
pub enum HideFlagError {
    /// Filesystem error reading or writing `vault-names.json`.
    #[error("filesystem error on vault-names.json")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },
    /// The file is present but did not parse as JSON.
    #[error("vault-names.json parse failed")]
    Parse,
}

impl From<IoFailureKind> for HideFlagError {
    fn from(io_error_kind: IoFailureKind) -> Self {
        HideFlagError::Io { io_error_kind }
    }
}

/// `<app_config_dir>/vault-names.json`, creating the directory if needed. The
/// same resolution [`crate::plugins::sync::tor_config::tor_config_path_from_host`]
/// does for its sibling, through the same seam.
pub async fn hide_flag_path_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
) -> Result<PathBuf, HideFlagError> {
    let dir = host.app_config_dir().map_err(|_| HideFlagError::Io {
        io_error_kind: IoFailureKind::Other,
    })?;
    io.create_dir_all(&dir).await?;
    Ok(dir.join(HIDE_FLAG_FILE_NAME))
}

/// Read the flag from `path`. Absent means the default (names shown); present
/// but unparseable is [`HideFlagError::Parse`]. See the module header for why
/// those two answers are deliberately different.
pub async fn read_hide_vault_names(
    io: &dyn VaultIo,
    path: &Path,
) -> Result<HideVaultNamesConfig, HideFlagError> {
    match open_newest(io, path, |bytes| {
        serde_json::from_slice::<HideVaultNamesConfig>(bytes)
    })
    .await
    {
        Ok(cfg) => Ok(cfg),
        Err(OpenOutcome::Absent) => Ok(HideVaultNamesConfig::default()),
        Err(OpenOutcome::Undecodable(_)) => Err(HideFlagError::Parse),
        Err(OpenOutcome::Io(kind)) => Err(kind.into()),
    }
}

/// Persist the flag to `path` (atomic replace, owner-only, like its siblings).
pub async fn write_hide_vault_names(
    io: &dyn VaultIo,
    path: &Path,
    cfg: HideVaultNamesConfig,
) -> Result<(), HideFlagError> {
    let bytes = serde_json::to_vec_pretty(&cfg).map_err(|_| HideFlagError::Parse)?;
    io.write(path, &bytes, WriteOpts::default()).await?;
    Ok(())
}

/// Whether names are hidden, given whatever [`read_hide_vault_names`] answered.
///
/// The one place the "a damaged file fails ON" rule is written down, so it is a
/// function with a test rather than a `match` arm somewhere. **Every** reader
/// goes through it (the command the Settings row reads, and the write-suppression
/// check on the unlock path) because two readers with two reductions is exactly
/// how a switch comes to say one thing while the writer does another.
///
/// **Every** `Err` resolves to `true`, [`HideFlagError::Io`] included, and that
/// is narrower than it looks: [`read_hide_vault_names`] answers an *absent* file
/// with `Ok(default)`, so an `Io` here is a file that exists and could not be
/// read (permissions, a bad sector, a directory in its place). That is the same
/// situation `Parse` describes and takes the same answer, for the same reason.
pub fn names_hidden_at_rest(read: Result<HideVaultNamesConfig, HideFlagError>) -> bool {
    match read {
        Ok(cfg) => cfg.hidden,
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{block_on, ScopedTempDir};
    use crate::vault_io::StdVaultIo;

    fn scratch(name: &str) -> (ScopedTempDir, PathBuf) {
        let dir = ScopedTempDir::new(&format!("vault-names-flag-{name}")).expect("scratch dir");
        let path = dir.path().join(HIDE_FLAG_FILE_NAME);
        (dir, path)
    }

    #[test]
    fn absent_is_shown_and_a_write_round_trips() {
        let (_dir, path) = scratch("roundtrip");
        block_on(async {
            assert_eq!(
                read_hide_vault_names(&StdVaultIo, &path).await.unwrap(),
                HideVaultNamesConfig { hidden: false },
                "no file means nobody ever touched the option"
            );

            write_hide_vault_names(&StdVaultIo, &path, HideVaultNamesConfig { hidden: true })
                .await
                .unwrap();
            assert_eq!(
                read_hide_vault_names(&StdVaultIo, &path).await.unwrap(),
                HideVaultNamesConfig { hidden: true }
            );

            write_hide_vault_names(&StdVaultIo, &path, HideVaultNamesConfig { hidden: false })
                .await
                .unwrap();
            assert_eq!(
                read_hide_vault_names(&StdVaultIo, &path).await.unwrap(),
                HideVaultNamesConfig { hidden: false }
            );
        });
    }

    #[test]
    fn the_flag_is_readable_with_no_vault_unlocked() {
        // The property that disqualified `vault.prefs`, asserted rather than
        // asserted about: this whole path takes no vault root, no `root_key`,
        // no runtime slot and no keychain. There is nothing here to unlock.
        let (_dir, path) = scratch("locked");
        block_on(async {
            write_hide_vault_names(&StdVaultIo, &path, HideVaultNamesConfig { hidden: true })
                .await
                .unwrap();
            assert!(
                read_hide_vault_names(&StdVaultIo, &path)
                    .await
                    .unwrap()
                    .hidden,
                "the picker reads this before any vault exists in the slot"
            );
        });
    }

    #[test]
    fn the_preference_survives_a_restart() {
        let (_dir, path) = scratch("restart");
        block_on(async {
            write_hide_vault_names(&StdVaultIo, &path, HideVaultNamesConfig { hidden: true })
                .await
                .unwrap();
            // A "restart" is a fresh reader over the same bytes.
            assert!(
                read_hide_vault_names(&StdVaultIo, &path)
                    .await
                    .unwrap()
                    .hidden
            );
        });
    }

    #[test]
    fn a_corrupt_file_is_a_parse_error_rather_than_a_silent_default() {
        let (_dir, path) = scratch("corrupt");
        std::fs::write(&path, b"{not json").unwrap();
        block_on(async {
            assert_eq!(
                read_hide_vault_names(&StdVaultIo, &path).await,
                Err(HideFlagError::Parse)
            );
        });
    }

    #[test]
    fn an_unknown_field_is_tolerated() {
        // A field added by a later version must not make an existing file
        // unreadable, which under the reduction below would flip a user who
        // chose "shown" to "hidden" for no reason.
        let (_dir, path) = scratch("forward");
        std::fs::write(&path, br#"{"hidden":true,"scope":"device"}"#).unwrap();
        block_on(async {
            assert!(
                read_hide_vault_names(&StdVaultIo, &path)
                    .await
                    .unwrap()
                    .hidden
            );
        });
    }

    #[test]
    fn a_damaged_flag_file_resolves_to_hidden() {
        // The reduction: absent/off is shown, on is hidden, and a file that
        // exists but cannot be read is HIDDEN, the direction that cannot leak
        // a name, and the one a single toggle undoes.
        assert!(!names_hidden_at_rest(Ok(HideVaultNamesConfig {
            hidden: false
        })));
        assert!(names_hidden_at_rest(Ok(HideVaultNamesConfig {
            hidden: true
        })));
        assert!(names_hidden_at_rest(Err(HideFlagError::Parse)));
        assert!(names_hidden_at_rest(Err(HideFlagError::Io {
            io_error_kind: IoFailureKind::PermissionDenied
        })));
    }

    #[test]
    fn an_absent_file_is_not_an_io_error() {
        // The premise the `Io => hidden` arm rests on. Without it every fresh
        // install would come up with its names hidden and nobody having asked.
        let (_dir, path) = scratch("absent-is-ok");
        block_on(async {
            assert_eq!(
                read_hide_vault_names(&StdVaultIo, &path).await,
                Ok(HideVaultNamesConfig { hidden: false }),
            );
        });
        assert!(!names_hidden_at_rest(Ok(HideVaultNamesConfig::default())));
    }

    #[test]
    fn the_persisted_file_carries_the_flag_and_nothing_else() {
        // A device-local file that governs a privacy option is exactly the file
        // that must not accumulate a vault name "for convenience".
        let (_dir, path) = scratch("shape");
        block_on(async {
            write_hide_vault_names(&StdVaultIo, &path, HideVaultNamesConfig { hidden: true })
                .await
                .unwrap();
        });
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"hidden\""));
        for forbidden in ["label", "name", "title", "vault_id", "account"] {
            assert!(
                !text.contains(forbidden),
                "the flag file must not serialize a `{forbidden}` field"
            );
        }
    }
}
