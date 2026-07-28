// SPDX-License-Identifier: AGPL-3.0
//! Opening a singleton vault file with crash recovery (phase3-web-client task 18).
//!
//! # One rule, one place
//!
//! `decisions.md` 2026-07-26 states the web client's durability rule as: two
//! alternating copies, and **on open, the newest copy that passes AEAD
//! verification wins**. The second half of that sentence is the part that can go
//! wrong quietly. A reader that takes the newest copy and stops reports a corrupt
//! vault whenever a crash left a torn newest file — with an intact previous copy
//! sitting beside it, unread.
//!
//! There are about ten singleton readers (`vault.meta`, `vault.prefs`,
//! `vault.search`, `vault.indices`, `vault.themes`, `vault.workspace`,
//! `vault.attachments`, `vault.dictionary`, `vault.graph`, `vault.head-state`).
//! Ten copies of a fallback loop is ten chances to write it as "take the first".
//! So the loop lives here, and each reader passes its own decode.
//!
//! # Native is unchanged, and that is the design rather than a coincidence
//!
//! [`VaultIo::read_candidates`] defaults to a one-element list, because on
//! desktop and mobile `atomic_write` already guarantees a torn file cannot
//! exist. Running this helper there does exactly what the old code did: read
//! once, decode once, propagate the decode error. The recovery arm is dead code
//! on a target that cannot produce the situation — which is the honest shape,
//! rather than teaching every platform a browser's failure mode.

use crate::io_failure_kind::IoFailureKind;
use crate::vault_io::VaultIo;
use std::path::Path;

/// What [`open_newest`] can return instead of a decoded value.
#[derive(Debug, PartialEq, Eq)]
pub enum OpenOutcome<E> {
    /// No copy exists. Distinct from a decode failure: a vault that has never
    /// written this file is not a damaged one, and most callers treat it as
    /// "use the default" rather than as an error.
    Absent,
    /// The store could not be consulted at all.
    Io(IoFailureKind),
    /// Every copy was read and none decoded. Carries the **newest** copy's
    /// error, because that is the one describing the vault the user last had —
    /// an older copy's error would describe a state they already moved past.
    Undecodable(E),
}

/// Decode the newest copy that decodes.
///
/// `decode` is the caller's existing parse-and-AEAD-verify function. It is the
/// verifier: this helper has no keys and no format knowledge, and must not
/// acquire either.
///
/// Candidates are tried in the order [`VaultIo::read_candidates`] returns them,
/// which is newest first. The first success wins; a failure moves on. When every
/// candidate fails, the first (newest) error is the one reported.
pub async fn open_newest<T, E>(
    io: &dyn VaultIo,
    path: &Path,
    decode: impl Fn(&[u8]) -> Result<T, E>,
) -> Result<T, OpenOutcome<E>> {
    let candidates = io.read_candidates(path).await.map_err(OpenOutcome::Io)?;
    if candidates.is_empty() {
        return Err(OpenOutcome::Absent);
    }

    let mut newest_error: Option<E> = None;
    for bytes in &candidates {
        match decode(bytes) {
            Ok(value) => return Ok(value),
            Err(e) => {
                // Only the first (newest) failure is kept. Keeping the last would
                // report the older copy's error, which describes a vault state
                // the user has already moved past — misleading in exactly the
                // situation where the message matters most.
                if newest_error.is_none() {
                    newest_error = Some(e);
                }
            }
        }
    }
    Err(OpenOutcome::Undecodable(newest_error.expect(
        "non-empty candidates with no success has an error",
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault_io::{DirEntry, IoResult, WriteOpts};

    /// An IO stub that hands back a scripted candidate list.
    struct Candidates(Vec<Vec<u8>>);

    #[async_trait::async_trait]
    impl VaultIo for Candidates {
        async fn read(&self, _path: &Path) -> IoResult<Vec<u8>> {
            self.0.first().cloned().ok_or(IoFailureKind::NotFound)
        }
        async fn read_candidates(&self, _path: &Path) -> IoResult<Vec<Vec<u8>>> {
            Ok(self.0.clone())
        }
        async fn read_prefix(&self, _path: &Path, _len: usize) -> IoResult<Vec<u8>> {
            unreachable!("not exercised")
        }
        async fn write(&self, _p: &Path, _b: &[u8], _o: WriteOpts) -> IoResult<()> {
            unreachable!("not exercised")
        }
        async fn remove_file(&self, _path: &Path) -> IoResult<()> {
            unreachable!("not exercised")
        }
        async fn remove_dir_all(&self, _path: &Path) -> IoResult<()> {
            unreachable!("not exercised")
        }
        async fn create_dir_all(&self, _path: &Path) -> IoResult<()> {
            unreachable!("not exercised")
        }
        async fn read_dir(&self, _path: &Path) -> IoResult<Vec<DirEntry>> {
            unreachable!("not exercised")
        }
        async fn exists(&self, _path: &Path) -> IoResult<bool> {
            unreachable!("not exercised")
        }
        async fn is_dir(&self, _path: &Path) -> IoResult<bool> {
            unreachable!("not exercised")
        }
        async fn rename(&self, _from: &Path, _to: &Path) -> IoResult<()> {
            unreachable!("not exercised")
        }
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
    }

    /// The decode every test uses: `b"ok:"`-prefixed bytes decode to their tail.
    fn decode(bytes: &[u8]) -> Result<String, &'static str> {
        match bytes.strip_prefix(b"ok:") {
            Some(rest) => Ok(String::from_utf8_lossy(rest).into_owned()),
            None => Err("aead"),
        }
    }

    #[test]
    fn the_newest_copy_wins_when_it_decodes() {
        rt().block_on(async {
            let io = Candidates(vec![b"ok:new".to_vec(), b"ok:old".to_vec()]);
            let got = open_newest(&io, Path::new("vault.prefs"), decode).await;
            assert_eq!(got.unwrap(), "new");
        });
    }

    /// The property the whole task exists for: a torn newest copy must not be
    /// reported as a corrupt vault while an intact older one is right there.
    #[test]
    fn a_torn_newest_falls_back_to_the_older_copy() {
        rt().block_on(async {
            let io = Candidates(vec![b"TORN".to_vec(), b"ok:old".to_vec()]);
            let got = open_newest(&io, Path::new("vault.prefs"), decode).await;
            assert_eq!(
                got.unwrap(),
                "old",
                "a reader that stopped at the newest copy would have reported \
                 corruption with an intact vault beside it"
            );
        });
    }

    #[test]
    fn both_undecodable_reports_the_newest_copys_error() {
        rt().block_on(async {
            let io = Candidates(vec![b"TORN-new".to_vec(), b"TORN-old".to_vec()]);
            let got: Result<String, _> = open_newest(&io, Path::new("vault.prefs"), |b| match b {
                b"TORN-new" => Err("newest"),
                _ => Err("older"),
            })
            .await;
            assert_eq!(got.unwrap_err(), OpenOutcome::Undecodable("newest"));
        });
    }

    #[test]
    fn no_copies_is_absent_not_a_decode_failure() {
        rt().block_on(async {
            let io = Candidates(vec![]);
            let got: Result<String, _> = open_newest(&io, Path::new("vault.prefs"), decode).await;
            assert_eq!(got.unwrap_err(), OpenOutcome::Absent);
        });
    }

    /// The default trait implementation — i.e. the native arm — must behave
    /// exactly like the read-once code it replaces: one candidate, and a missing
    /// file surfacing as `Absent` rather than as an IO error.
    #[test]
    fn the_default_candidate_list_is_the_native_behaviour() {
        rt().block_on(async {
            let dir =
                crate::test_support::ScopedTempDir::new("singleton_default").expect("scratch dir");
            let path = dir.path().join("vault.prefs");
            let io = crate::vault_io::StdVaultIo;

            let missing: Result<String, _> = open_newest(&io, &path, decode).await;
            assert_eq!(missing.unwrap_err(), OpenOutcome::Absent);

            io.write(&path, b"ok:only", WriteOpts::default())
                .await
                .expect("write");
            let got = open_newest(&io, &path, decode).await;
            assert_eq!(got.unwrap(), "only");
        });
    }
}
