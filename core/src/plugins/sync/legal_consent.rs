//! The device-local record of which beta terms this device accepted
//! (operations#15).
//!
//! One string, persisted at `<app_config_dir>/legal-consent.json`: the version
//! of the beta terms the person at this device read and accepted. Sync is not
//! offered until it matches the version the client ships.
//!
//! ## Why it is device-local, and why not `vault.prefs`
//!
//! The obvious home is a `PrefsView` field, and it is the wrong one for two
//! separate reasons — either alone would be enough.
//!
//! **Enrolment seeds a new device wholesale.** `sync-protocol.md` §10.2.1: a
//! device joining an account adopts the server's prefs blob as its initial
//! `vault.prefs`, *device-local-classified fields included, as starting
//! defaults*. So even `PrefClass::DeviceLocal` would not help: the new phone
//! would come up with the acceptance already recorded and would never show the
//! terms. What this file records is "the person holding THIS device read the
//! text", and a value that arrives by sync cannot mean that.
//!
//! **And writing prefs at enrolment time breaks the seed itself.** That
//! adoption is gated on `vault.prefs` being absent locally, so creating one
//! before the first authed cycle permanently disables it (`useEnroll.ts`
//! documents the trap on the client side). Acceptance is recorded *at* the
//! moment of enrolment, which is precisely the wrong moment to touch prefs.
//!
//! So this is not a `PrefsView` field excluded from sync — it is not a
//! `PrefsView` field at all. Same conclusion, and the same shape, as
//! [`super::tor_config`], which took its own file next to `sync-config.json`
//! rather than a field on it.
//!
//! ## A version, not a boolean
//!
//! The stored value is the accepted version string. `protocol.md` §9.5.2 makes
//! the argument for the AI provider consent and it is the same one here: as a
//! boolean, "re-ask when the text changes" depends on every future editor
//! remembering to clear a flag; as a version it is a comparison, and an
//! acceptance of superseded terms is *unusable* rather than merely stale.
//!
//! ## Absent, corrupt, and which way each fails
//!
//! Every failure resolves to **not accepted**, and unlike [`super::tor_config`]
//! there is nothing subtle about it: the cost of being wrong is showing someone
//! a screen they have already seen, which is an annoyance. The cost of the
//! opposite — treating an unreadable file as consent — is recording agreement
//! nobody gave. Those are not comparable, so the reduction does not try to be
//! clever.

use crate::io_failure_kind::IoFailureKind;
use serde::{Deserialize, Serialize};
use std::path::Path;
use thiserror::Error;

/// The file name under `<app_config_dir>`. Sibling of `sync-config.json` and
/// `tor-routing.json`.
const FILE_NAME: &str = "legal-consent.json";

/// The device-local acceptance record as persisted.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegalConsent {
    /// The beta-terms version accepted on this device, or `None` if none was.
    #[serde(default)]
    pub beta_terms_version: Option<String>,
}

/// Failure surface for reading/writing the record.
///
/// Two variants and no `String`: this reaches the UI, and a path in an error
/// message is a disclosure (`src-tauri/CLAUDE.md` DENY list).
#[derive(Debug, Clone, Copy, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail")]
pub enum LegalConsentError {
    /// Filesystem error reading or writing `legal-consent.json`.
    #[error("filesystem error on legal-consent.json")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },
    /// The on-disk file failed to parse as JSON.
    #[error("legal-consent.json parse failed")]
    Parse,
}

impl From<IoFailureKind> for LegalConsentError {
    fn from(io_error_kind: IoFailureKind) -> Self {
        LegalConsentError::Io { io_error_kind }
    }
}

/// `<app_config_dir>/legal-consent.json`, creating the directory if needed —
/// the same resolution its two siblings in this directory do, through the same
/// seam.
pub async fn legal_consent_path_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<std::path::PathBuf, LegalConsentError> {
    let dir = host.app_config_dir().map_err(|_| LegalConsentError::Io {
        io_error_kind: IoFailureKind::Other,
    })?;
    io.create_dir_all(&dir).await?;
    Ok(dir.join(FILE_NAME))
}

/// Read the record from `path`. Absent ⇒ nothing accepted.
pub async fn read_legal_consent(
    io: &dyn crate::vault_io::VaultIo,
    path: &Path,
) -> Result<LegalConsent, LegalConsentError> {
    match crate::singleton::open_newest(io, path, |bytes| {
        serde_json::from_slice::<LegalConsent>(bytes)
    })
    .await
    {
        Ok(cfg) => Ok(cfg),
        Err(crate::singleton::OpenOutcome::Absent) => Ok(LegalConsent::default()),
        Err(crate::singleton::OpenOutcome::Undecodable(_)) => Err(LegalConsentError::Parse),
        Err(crate::singleton::OpenOutcome::Io(kind)) => Err(kind.into()),
    }
}

/// Persist the record to `path` (atomic replace, like its siblings).
pub async fn write_legal_consent(
    io: &dyn crate::vault_io::VaultIo,
    path: &Path,
    record: &LegalConsent,
) -> Result<(), LegalConsentError> {
    let bytes = serde_json::to_vec_pretty(record).map_err(|_| LegalConsentError::Parse)?;
    io.write(path, &bytes, crate::vault_io::WriteOpts::default())
        .await?;
    Ok(())
}

/// Whether the terms this build ships have been accepted on this device.
///
/// The one place the reduction is written down, so it is a function with a test
/// rather than a comparison repeated at each caller — the shape that lets one
/// caller decide "close enough" and another disagree.
///
/// **Every** `Err` resolves to `false`, and so does a version that does not
/// match exactly. There is no ordering here on purpose: versions are compared,
/// not ranked, so a downgrade re-asks just as an upgrade does. Ranking would
/// require the string to be parseable as a version forever, and the only thing
/// gained is skipping a screen for someone running an older build.
pub fn terms_accepted(read: &Result<LegalConsent, LegalConsentError>, shipped: &str) -> bool {
    match read {
        Ok(record) => record.beta_terms_version.as_deref() == Some(shipped),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("myne-legal-consent-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(FILE_NAME)
    }

    /// Absent is "nothing accepted", a write round-trips, and a corrupt file is
    /// a `Parse` error rather than a silent default.
    #[test]
    fn absent_is_unaccepted_and_a_write_round_trips() {
        crate::test_support::block_on(async {
            let io = crate::vault_io::StdVaultIo;
            let path = scratch("roundtrip");
            std::fs::remove_file(&path).ok();

            assert_eq!(
                read_legal_consent(&io, &path).await.unwrap(),
                LegalConsent {
                    beta_terms_version: None
                },
                "no file means nobody has accepted anything on this device"
            );

            write_legal_consent(
                &io,
                &path,
                &LegalConsent {
                    beta_terms_version: Some("1".into()),
                },
            )
            .await
            .unwrap();
            assert_eq!(
                read_legal_consent(&io, &path)
                    .await
                    .unwrap()
                    .beta_terms_version,
                Some("1".to_string())
            );

            std::fs::write(&path, b"{not json").unwrap();
            assert_eq!(
                read_legal_consent(&io, &path).await,
                Err(LegalConsentError::Parse)
            );

            std::fs::remove_file(&path).ok();
        });
    }

    /// The acceptance survives a restart — for a plain file that means a second
    /// reader sees what the first writer wrote.
    #[test]
    fn the_acceptance_survives_a_restart() {
        crate::test_support::block_on(async {
            let io = crate::vault_io::StdVaultIo;
            let path = scratch("restart");
            std::fs::remove_file(&path).ok();

            write_legal_consent(
                &io,
                &path,
                &LegalConsent {
                    beta_terms_version: Some("1".into()),
                },
            )
            .await
            .unwrap();

            let reread = read_legal_consent(&crate::vault_io::StdVaultIo, &path)
                .await
                .unwrap();
            assert_eq!(reread.beta_terms_version.as_deref(), Some("1"));

            std::fs::remove_file(&path).ok();
        });
    }

    /// An unknown field must not make an existing record unreadable — a forward
    /// field added by a later version reads back as the acceptance it still
    /// carries, rather than as `Parse` (which would re-ask for no reason).
    #[test]
    fn an_unknown_field_is_tolerated() {
        crate::test_support::block_on(async {
            let io = crate::vault_io::StdVaultIo;
            let path = scratch("forward");
            std::fs::write(
                &path,
                br#"{"beta_terms_version":"1","privacy_notice_version":"3"}"#,
            )
            .unwrap();
            assert_eq!(
                read_legal_consent(&io, &path)
                    .await
                    .unwrap()
                    .beta_terms_version
                    .as_deref(),
                Some("1")
            );
            std::fs::remove_file(&path).ok();
        });
    }

    /// The reduction: only an exact match counts, and every failure re-asks.
    #[test]
    fn only_an_exact_match_counts_as_accepted() {
        let accepted = |v: Option<&str>| {
            Ok(LegalConsent {
                beta_terms_version: v.map(str::to_string),
            })
        };

        assert!(terms_accepted(&accepted(Some("1")), "1"));
        assert!(
            !terms_accepted(&accepted(Some("1")), "2"),
            "superseded terms are unusable, not merely stale — this is the whole \
             reason the record is a version rather than a boolean"
        );
        assert!(
            !terms_accepted(&accepted(Some("2")), "1"),
            "versions are compared, never ranked: a downgrade re-asks too"
        );
        assert!(!terms_accepted(&accepted(None), "1"));
        assert!(!terms_accepted(&Err(LegalConsentError::Parse), "1"));
        assert!(
            !terms_accepted(
                &Err(LegalConsentError::Io {
                    io_error_kind: IoFailureKind::PermissionDenied
                }),
                "1"
            ),
            "an unreadable record must never be read as agreement nobody gave"
        );
    }
}
