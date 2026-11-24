// SPDX-License-Identifier: AGPL-3.0-only
//! This device's 16-byte device id, read in exactly ONE place (myne-md/myne#958).
//!
//! ## Why this module exists
//!
//! A vault has two independent records of "which device is this", and before this
//! module four subsystems each read ONE of them:
//!
//! - `sync-state.json`'s `device_id_hex` is written by the account enrolment
//!   (`enroll.rs`) and by the person-identity adoption
//!   (`person_account.rs::adopt_person_device_identity_best_effort`).
//! - `person-auth.json`'s `device_id_hex` is written when a person identity is
//!   created or admitted on this device, and the sync cycle reads it for the
//!   version vector it signs (`cycle::person_device_id`).
//!
//! They can disagree, and on a person-born vault the disagreement was total: the
//! vault's `sync-state.json` carried no id at all while the person credential did,
//! so the sync protocol knew the device (its version vector named it) and every
//! authoring path did not (`myne-md/myne#958`). Note authoring fell back to a fresh
//! random actor per save, the live session opened with no actor, the presence frame
//! was sealed with sixteen zero bytes, and the receiving half rendered this device's
//! own caret back to it as "Device 000000".
//!
//! Two separate fixes had already been attempted on the READER side (the adoption
//! above exists to seed the vault field, and `devices::hex16` is the one parser), and
//! the divergence survived both because "read this field here, and that one there" is
//! a rule with no mechanism behind it. So the mechanism is the point: every read of
//! either field happens in this file, and `scripts/check-device-actor.mjs` fails a
//! commit that adds a second reader anywhere else in `core/src`.
//!
//! ## The order, and why it is that order
//!
//! 1. The vault's own enrolment record: an account-enrolled vault has exactly one
//!    device id, it is the one its blobs, heads and version vectors already carry,
//!    and it must never be replaced by a second value the same device also happens
//!    to hold.
//! 2. The person credential's device id: the only identity a person-born vault has
//!    (`decisions/protocol/0758`), and the one its version vector already signs under.
//!
//! There is deliberately no third source. `durable_device_id` answers `None` when
//! neither record carries a parseable id, and callers decide what an id-less device
//! means: authoring draws a fresh actor (it must attribute to SOMETHING), while a
//! binding claim refuses (`NoDeviceId`), because a row keyed by an invented id names a
//! device no other replica can resolve.
//!
//! ## Absent falls through; unreadable does not
//!
//! The fall-through from source 1 to source 2 is only licensed by ABSENCE: no record,
//! or a record that carries no id field. That is the person-born vault, and it is the
//! case this module exists for.
//!
//! A record that exists and says something unreadable is a different answer, and it
//! does NOT fall through. Promoting the person credential there would substitute a
//! DIFFERENT device id for the one this vault already uses, and the substituted value
//! reaches four writes with nothing in between asking whether the enrolment was
//! actually loaded: the person-signed `MYU5` binding row (keyed by that id), every
//! note revision (committed under that actor), and `signed_head_ctx` (which decides
//! whether a `0x03` head is authored, and under whose id). One transient read failure
//! would then permanently re-identify the device, with a wrong-keyed signed row in a
//! synced map and a mixed-actor revision history as the residue. So it answers `None`
//! and leaves the device id-less for that call, which degrades exactly the way an
//! unenrolled vault does: authoring draws, the binding claim refuses.

use std::path::Path;

use crate::host::HostCtx;
use crate::vault_io::VaultIo;

/// The all-zero actor, which is not an identity.
///
/// Sixteen zero bytes is what a client with no device id used to seal, so it reaches
/// this tree from older releases, from the web client and from mobile as well as from
/// local code. Every consumer treats it as "nobody": the presence router drops the
/// frame and the identity resolver answers `Unknown`. Nothing may ever cache, compare
/// or render it as a device.
pub const UNSET_ACTOR: [u8; 16] = [0u8; 16];

/// Whether `actor` is [`UNSET_ACTOR`], i.e. carries no identity at all.
///
/// A free function rather than a method so the two consumers that matter (the frame
/// router and the resolver) share one definition of "no identity" instead of each
/// spelling `== [0u8; 16]` their own way.
#[must_use]
pub fn actor_is_unset(actor: &[u8; 16]) -> bool {
    *actor == UNSET_ACTOR
}

/// This device's durable id, or `None` when it has none.
///
/// The ONLY reader of both records. See the module doc for the source order.
pub async fn durable_device_id(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    vault_root: &Path,
) -> Option<[u8; 16]> {
    match from_vault_enrolment(io, vault_root).await {
        Enrolment::Id(id) => Some(id),
        Enrolment::Absent => from_person_auth(host, io).await,
        // Not a fall-through: see the module doc's "Absent falls through; unreadable
        // does not". Answering the other record here would substitute a different
        // device id, and the substitution would be written down.
        Enrolment::Unreadable => None,
    }
}

/// What source 1 (`sync-state.json`) answered. Three cases, not an `Option`, because the
/// difference between the last two is exactly the difference the module doc draws.
enum Enrolment {
    /// The record carries a usable id.
    Id([u8; 16]),
    /// No record, or a record with no id field: the person credential is next.
    Absent,
    /// A record that exists and says something unreadable. Never replaced by the other
    /// record's id.
    Unreadable,
}

/// Source 1: the vault's own enrolment record (`sync-state.json`).
async fn from_vault_enrolment(io: &dyn VaultIo, vault_root: &Path) -> Enrolment {
    use crate::io_failure_kind::IoFailureKind;
    use crate::plugins::sync::config::SyncConfigError;

    match super::state::read_sync_state(io, vault_root).await {
        // `read_sync_state` answers the default state for an ABSENT file, so this arm
        // covers both "no file" and "file with no device id", the person-born case.
        Ok(st) => match st.device_id_hex.as_deref() {
            None => Enrolment::Absent,
            Some(hex) => super::devices::hex16(hex).map_or(Enrolment::Unreadable, Enrolment::Id),
        },
        // A single-copy native read reports a missing file this way rather than as
        // `Absent`, and a missing file carries no id, so it is the same answer.
        Err(SyncConfigError::Io {
            io_error_kind: IoFailureKind::NotFound,
        }) => Enrolment::Absent,
        // Present but undecodable, or the store could not be consulted at all.
        Err(_) => Enrolment::Unreadable,
    }
}

/// Source 2: the person credential (`person-auth.json`).
///
/// Read per call rather than cached, for the same reason the cycle reads the token per
/// cycle: re-enrolment rotates it, and a cached copy would outlive the credential it
/// names. An absent file, an unreadable one and an unparseable id all answer `None`:
/// an identity that cannot be read is the same shape as one that is not there, and no
/// caller may turn a read failure into a REFUSAL of the device (that would be a
/// keychain hiccup locking a device out of its own notes).
pub async fn from_person_auth(host: &dyn HostCtx, io: &dyn VaultIo) -> Option<[u8; 16]> {
    let path = super::person_auth::person_auth_path_for_read(host).ok()?;
    let auth = super::person_auth::read_person_auth(io, &path)
        .await
        .ok()??;
    super::devices::hex16(&auth.device_id_hex)
}

/// The actor to AUTHOR under: the durable id when there is one, else a fresh draw.
///
/// Authoring is the one path that cannot answer "no identity": an Automerge document
/// commits under whatever actor it holds, so the alternative to a fresh draw is not
/// "unattributed" but "attributed to a random actor the automerge layer picked", one
/// per document load. A single explicit draw per operation is strictly better: it is
/// the pre-`SYNC-42` behaviour, made visible (resolves to `Unknown` downstream) rather
/// than accidental.
///
/// Deliberately NOT used by the binding claim, which must refuse instead of inventing
/// an id (see [`super::device_binding`]'s `session_device_id`).
pub async fn actor_for_authoring(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    vault_root: &Path,
) -> Result<[u8; super::crdt_doc::ACTOR_ID_LEN], getrandom::Error> {
    super::crdt_doc::note_actor_bytes(durable_device_id(host, io, vault_root).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::test_host::TestHost;
    use crate::plugins::sync::person_auth::{write_person_auth, PersonAuth};
    use crate::plugins::sync::state::{write_sync_state, SyncState};
    use crate::test_support::ScopedTempDir;
    use crate::vault_io::StdVaultIo;

    const VAULT_ID: [u8; 16] = [0xA1; 16];
    const PERSON_ID: [u8; 16] = [0xB2; 16];

    /// Build a host whose config dir is the temp dir's `config/`, plus the vault root
    /// the enrolment record lives in. This is the whole shape the reader needs, and the
    /// reason it takes a host at all: `app_config_dir` is NOT derivable from the vault
    /// path (on Linux they are different roots), so a reader that guessed it would be
    /// the same class of bug it exists to remove.
    struct Fixture {
        tmp: ScopedTempDir,
        host: TestHost,
        io: StdVaultIo,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let tmp = ScopedTempDir::new(name).expect("temp dir");
            let host = TestHost::new(tmp.path().to_str().expect("utf8 temp path"));
            let fixture = Self {
                tmp,
                host,
                io: StdVaultIo,
            };
            // The vault directory itself, because `write_sync_state` writes INTO it:
            // without it the enrolment fixture fails with `NotFound` and every case
            // below would be asserting against a record it never managed to write.
            std::fs::create_dir_all(fixture.vault_root()).expect("vault dir");
            fixture
        }

        fn vault_root(&self) -> std::path::PathBuf {
            self.tmp.path().join("vault")
        }

        async fn write_vault_id(&self, id: Option<&str>) {
            let st = SyncState {
                device_id_hex: id.map(ToOwned::to_owned),
                ..Default::default()
            };
            write_sync_state(&self.io, &self.vault_root(), &st)
                .await
                .expect("write sync-state");
        }

        async fn write_person_id(&self, id: &str) {
            let path = crate::plugins::sync::person_auth::person_auth_path(&self.host, &self.io)
                .await
                .expect("person-auth path");
            let auth = PersonAuth {
                person_id_hex: "11".repeat(16),
                device_id_hex: id.to_owned(),
                token_hex: "33".repeat(32),
                ..Default::default()
            };
            write_person_auth(&self.io, &path, &auth)
                .await
                .expect("write person-auth");
        }
    }

    async fn durable(f: &Fixture) -> Option<[u8; 16]> {
        durable_device_id(&f.host, &f.io, &f.vault_root()).await
    }

    /// THE regression test for myne-md/myne#958's root cause: the vault enrolment and
    /// the person credential are two records of one fact, and this is the one place that
    /// decides which wins. Three of the four cases below were previously answered by the
    /// caller (some callers read record 1 only, one read record 2 only).
    #[test]
    fn the_enrolment_wins_then_the_person_credential() {
        crate::test_support::block_on(async {
            // Neither record: no identity at all. This is the state the reported vault
            // was in for the ENROLMENT record, and the state the presence path then
            // turned into sixteen zero bytes.
            let f = Fixture::new("device-actor-none");
            assert_eq!(durable(&f).await, None);

            // Person credential only: a person-born vault, which is what the reported
            // device is. Before this reader existed this answered None and every
            // authoring path drew a fresh random actor per save.
            let f = Fixture::new("device-actor-person");
            f.write_person_id(&"b2".repeat(16)).await;
            assert_eq!(
                durable(&f).await,
                Some(PERSON_ID),
                "the person credential's device id is this device's id"
            );

            // Both, disagreeing: the vault's own enrolment is the id its blobs and
            // heads already carry, so it must win. Answering the person id here would
            // silently re-attribute every existing note.
            let f = Fixture::new("device-actor-both");
            f.write_vault_id(Some(&"a1".repeat(16))).await;
            f.write_person_id(&"b2".repeat(16)).await;
            assert_eq!(durable(&f).await, Some(VAULT_ID), "enrolment wins");

            // A record that exists and says something UNREADABLE does not fall through:
            // answering the person credential here would hand back a different device id
            // than the one this vault already uses, and the substituted value is what the
            // binding row, the note revisions and the signed head would then be written
            // under. The device stays id-less for this call instead.
            let f = Fixture::new("device-actor-malformed-id");
            f.write_vault_id(Some("zz")).await;
            f.write_person_id(&"b2".repeat(16)).await;
            assert_eq!(
                durable(&f).await,
                None,
                "an unparseable enrolment id is not replaced by the person credential's"
            );

            // The same rule one layer down: a file that cannot be DECODED at all.
            let f = Fixture::new("device-actor-undecodable");
            std::fs::write(f.vault_root().join("sync-state.json"), b"{not json")
                .expect("write a torn record");
            f.write_person_id(&"b2".repeat(16)).await;
            assert_eq!(
                durable(&f).await,
                None,
                "an undecodable enrolment is not replaced by the person credential's"
            );

            // And the boundary that keeps the person-born vault working: a record that
            // decodes and simply carries no id is ABSENT, not unreadable.
            let f = Fixture::new("device-actor-no-field");
            f.write_vault_id(None).await;
            f.write_person_id(&"b2".repeat(16)).await;
            assert_eq!(
                durable(&f).await,
                Some(PERSON_ID),
                "an absent id falls through; only an unreadable one does not"
            );
        });
    }

    /// Authoring is the one path that may not answer "nobody": the draw must be a real
    /// actor, it must not be the zero the presence path used to seal, and an id-less
    /// device must not get the SAME draw twice (which would make two devices look like
    /// one actor, the failure a zero actor had).
    #[test]
    fn authoring_draws_only_when_there_is_no_id() {
        crate::test_support::block_on(async {
            let f = Fixture::new("device-actor-authoring");
            let first = actor_for_authoring(&f.host, &f.io, &f.vault_root())
                .await
                .expect("csprng");
            let second = actor_for_authoring(&f.host, &f.io, &f.vault_root())
                .await
                .expect("csprng");
            assert!(!actor_is_unset(&first), "a drawn actor is never all-zero");
            assert_ne!(first, second, "two draws are two actors");

            f.write_vault_id(Some(&"a1".repeat(16))).await;
            let with_id = actor_for_authoring(&f.host, &f.io, &f.vault_root())
                .await
                .expect("csprng");
            assert_eq!(with_id, VAULT_ID, "with an id there is no draw");
        });
    }

    #[test]
    fn the_all_zero_actor_is_not_an_identity() {
        assert!(actor_is_unset(&UNSET_ACTOR));
        assert!(!actor_is_unset(&[0u8; 16].map(|_| 1)));
        // One non-zero byte anywhere is enough to be a different value: this is what
        // stops a `starts_with`-style check from misreading a real actor as unset.
        let mut almost = UNSET_ACTOR;
        almost[15] = 1;
        assert!(!actor_is_unset(&almost));
    }
}
