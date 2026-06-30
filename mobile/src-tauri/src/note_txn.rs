//! Transactional multi-note write — the §8.3 rollback primitive for wikilink
//! auto-update on rename (MYND-85 / WL-7).
//!
//! A title rename rewrites the renamed note's own blob PLUS every inbound
//! `[[…]]`-bearing note, and §8.3 requires this to be **all-or-nothing**: any
//! write failure leaves the vault in its pre-rename state. A partial commit
//! genuinely breaks links (an un-rewritten `[[Old Title]]` resolves to no note),
//! so per-blob [`crate::atomic_write::atomic_write`] is insufficient.
//!
//! ## Two-phase journal + roll-forward WAL
//!
//! 1. **Stage** every blob to `<uuid>.myn.tmp` (write + `sync_all`). Any stage
//!    failure (disk-full / permission / encryption — the failures §8.3 lists)
//!    deletes all staged `.tmp` and aborts; the live `.myn` files are untouched.
//! 2. **Commit.** Once all stages are durable, write an **empty** marker
//!    (`.rename-journal`, fsync'd) → atomically rename every `.tmp`→`.myn`
//!    (each via [`finalize_atomic`]) → delete the marker.
//!
//! ## Crash recovery ([`recover_pending_rename`], run on vault-open)
//!
//! - **Marker present** → a commit was in progress and every staged blob is
//!   durable → **roll forward**: rename every orphan `<uuid>.myn.tmp`→`.myn`.
//! - **Marker absent** → a stage crashed (or a single-note `atomic_write`
//!   crashed before its rename) → **roll back**: delete orphan `*.myn.tmp`.
//!
//! Safe under v0.1's single-writer-per-vault invariant: no `*.myn.tmp` exists
//! except as transaction residue. The marker carries NO data (no UUIDs/titles),
//! so it adds no metadata surface; rolled-forward blobs are still AEAD/CTX
//! verified on read, so a disk-write attacker cannot inject content.
//!
//! Secret-handling: callers pass ALREADY-ENCODED (encrypted) ciphertext blobs;
//! this module never sees plaintext and logs nothing (no paths, no ids).

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::atomic_write::{finalize_atomic, tmp_path};

/// The empty roll-forward marker, written in the notes directory between the
/// stage and commit phases. Content-free — its mere existence is the signal.
const RENAME_JOURNAL: &str = ".rename-journal";

/// One blob in a transaction: its final `<uuid>.myn` path + the encoded
/// (encrypted) bytes to write there.
///
/// Built by the `note_write_batch_transactional` command (MYND-85 task
/// 3b) — one per rewritten note (the renamed note's own body + each
/// inbound `[[…]]`-bearing note).
pub struct TxnBlob {
    pub path: PathBuf,
    pub bytes: Vec<u8>,
}

/// Test-only fault-injection points for the crash-safety contract. In non-test
/// builds the enum has only [`TxnFault::None`], so the matches compile out and
/// the production path is byte-identical to a seam-free implementation.
#[derive(Clone, Copy)]
enum TxnFault {
    None,
    /// Fail during the stage of blob index `usize` (disk-full / encryption).
    #[cfg(test)]
    FailStage(usize),
    /// All staged, before the marker — a crash where the batch never reached
    /// commit. Recovery must ROLL BACK.
    #[cfg(test)]
    StopAfterStage,
    /// Marker written, before any rename — recovery must ROLL FORWARD all.
    #[cfg(test)]
    StopAfterMarker,
    /// Marker + the first rename committed, before the rest — recovery must
    /// ROLL FORWARD the remaining `.tmp`.
    #[cfg(test)]
    StopMidCommit,
}

/// Write all blobs in one all-or-nothing transaction (§8.3). Stages every blob,
/// then commits the renames; roll-forward-recoverable via the marker. Returns an
/// error (vault untouched) if any stage fails.
pub fn write_batch_transactional(notes_dir: &Path, blobs: &[TxnBlob]) -> std::io::Result<()> {
    write_batch_inner(notes_dir, blobs, TxnFault::None)
}

// `idx` in the commit loop is read only under the `#[cfg(test)]` crash hook.
#[cfg_attr(not(test), allow(unused_variables))]
fn write_batch_inner(notes_dir: &Path, blobs: &[TxnBlob], fault: TxnFault) -> std::io::Result<()> {
    if blobs.is_empty() {
        return Ok(());
    }

    // Phase 1 — stage all to `.tmp`. On ANY failure, delete every staged temp
    // (including the one that failed) and abort with the vault untouched.
    let mut staged: Vec<(PathBuf, PathBuf)> = Vec::with_capacity(blobs.len()); // (tmp, dst)
    for (i, b) in blobs.iter().enumerate() {
        let tmp = tmp_path(&b.path);
        let stage_result = stage_write(&tmp, &b.bytes, fault, i);
        if let Err(e) = stage_result {
            let _ = std::fs::remove_file(&tmp);
            for (t, _) in &staged {
                let _ = std::fs::remove_file(t);
            }
            return Err(e);
        }
        staged.push((tmp, b.path.clone()));
    }

    #[cfg(test)]
    if let TxnFault::StopAfterStage = fault {
        // Crash after staging, before the marker. Leaves `.tmp` + NO marker.
        return Err(std::io::ErrorKind::Interrupted.into());
    }

    // Phase 2 — write the empty commit marker (durable).
    let marker = notes_dir.join(RENAME_JOURNAL);
    write_marker(&marker)?;

    #[cfg(test)]
    if let TxnFault::StopAfterMarker = fault {
        // Crash after the marker, before any rename. Marker + all `.tmp` present.
        return Err(std::io::ErrorKind::Interrupted.into());
    }

    // Phase 3 — commit every rename atomically.
    for (idx, (tmp, dst)) in staged.iter().enumerate() {
        finalize_atomic(tmp, dst, /* replace = */ true)?;
        #[cfg(test)]
        if let TxnFault::StopMidCommit = fault {
            if idx == 0 {
                // One renamed, the rest still `.tmp`, marker present.
                return Err(std::io::ErrorKind::Interrupted.into());
            }
        }
    }

    // Phase 4 — clear the marker (the transaction is fully committed).
    let _ = std::fs::remove_file(&marker);
    if let Some(parent) = marker.parent() {
        let _ = std::fs::File::open(parent).and_then(|f| f.sync_all());
    }
    Ok(())
}

/// Stage one blob: write `<uuid>.myn.tmp` + `sync_all` so it is durable before
/// the commit phase. `fault`/`index` are read only under `#[cfg(test)]`.
#[cfg_attr(not(test), allow(unused_variables))]
fn stage_write(tmp: &Path, bytes: &[u8], fault: TxnFault, index: usize) -> std::io::Result<()> {
    #[cfg(test)]
    if let TxnFault::FailStage(fail_at) = fault {
        if fail_at == index {
            return Err(std::io::ErrorKind::Other.into());
        }
    }
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(tmp)?;
    f.write_all(bytes)?;
    f.sync_all()
}

/// Write the empty marker durably (file fsync + parent-dir fsync) so its
/// existence survives a power loss into the recovery pass.
fn write_marker(marker: &Path) -> std::io::Result<()> {
    let f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(marker)?;
    f.sync_all()?;
    drop(f);
    if let Some(parent) = marker.parent() {
        std::fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

/// Recover a pending rename transaction on vault-open (call BEFORE the index
/// rebuild). Idempotent; a no-op when there is nothing to recover. Wired into
/// the unlock path via
/// `plugins::vault_unlock::commands::recover_pending_rename_on_unlock`
/// (MYND-85 task 3c).
pub fn recover_pending_rename(notes_dir: &Path) -> std::io::Result<()> {
    let marker = notes_dir.join(RENAME_JOURNAL);
    let roll_forward = marker.exists();

    let entries = match std::fs::read_dir(notes_dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let mut tmp_files: Vec<PathBuf> = Vec::new();
    for entry in entries {
        let path = entry?.path();
        if is_myn_tmp(&path) {
            tmp_files.push(path);
        }
    }

    for tmp in &tmp_files {
        if roll_forward {
            finalize_atomic(tmp, &myn_from_tmp(tmp), /* replace = */ true)?;
        } else {
            let _ = std::fs::remove_file(tmp);
        }
    }
    if roll_forward {
        let _ = std::fs::remove_file(&marker);
        if let Some(parent) = marker.parent() {
            let _ = std::fs::File::open(parent).and_then(|f| f.sync_all());
        }
    }
    Ok(())
}

fn is_myn_tmp(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.ends_with(".myn.tmp"))
        .unwrap_or(false)
}

/// `<uuid>.myn.tmp` → `<uuid>.myn` (strip exactly one trailing `.tmp`).
fn myn_from_tmp(tmp: &Path) -> PathBuf {
    let name = tmp.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let stripped = name.strip_suffix(".tmp").unwrap_or(name);
    tmp.with_file_name(stripped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;

    fn blob(dir: &Path, uuid: &str, body: &[u8]) -> TxnBlob {
        TxnBlob {
            path: dir.join(format!("{uuid}.myn")),
            bytes: body.to_vec(),
        }
    }

    fn read(p: &Path) -> Option<Vec<u8>> {
        std::fs::read(p).ok()
    }

    fn myn_tmp_count(dir: &Path) -> usize {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| is_myn_tmp(&e.path()))
            .count()
    }

    fn marker_exists(dir: &Path) -> bool {
        dir.join(RENAME_JOURNAL).exists()
    }

    #[test]
    fn happy_path_commits_all_and_leaves_no_residue() {
        let d = ScopedTempDir::new("txn-ok").unwrap();
        let dir = d.path();
        let blobs = vec![
            blob(dir, "a", b"AAA"),
            blob(dir, "b", b"BBB"),
            blob(dir, "c", b"CCC"),
        ];
        write_batch_transactional(dir, &blobs).unwrap();
        assert_eq!(read(&dir.join("a.myn")).as_deref(), Some(&b"AAA"[..]));
        assert_eq!(read(&dir.join("b.myn")).as_deref(), Some(&b"BBB"[..]));
        assert_eq!(read(&dir.join("c.myn")).as_deref(), Some(&b"CCC"[..]));
        assert_eq!(myn_tmp_count(dir), 0, "no leftover .tmp");
        assert!(!marker_exists(dir), "marker cleared");
    }

    #[test]
    fn stage_failure_aborts_with_vault_untouched() {
        let d = ScopedTempDir::new("txn-abort").unwrap();
        let dir = d.path();
        // Pre-existing committed content that MUST survive the aborted txn.
        std::fs::write(dir.join("a.myn"), b"OLD-A").unwrap();
        let blobs = vec![blob(dir, "a", b"NEW-A"), blob(dir, "b", b"NEW-B")];
        // Fail staging the 2nd blob.
        let err = write_batch_inner(dir, &blobs, TxnFault::FailStage(1)).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::Other);
        assert_eq!(
            read(&dir.join("a.myn")).as_deref(),
            Some(&b"OLD-A"[..]),
            "a unchanged"
        );
        assert!(read(&dir.join("b.myn")).is_none(), "b never created");
        assert_eq!(myn_tmp_count(dir), 0, "all staged .tmp cleaned up on abort");
        assert!(!marker_exists(dir));
    }

    #[test]
    fn crash_after_stage_rolls_back() {
        let d = ScopedTempDir::new("txn-stagecrash").unwrap();
        let dir = d.path();
        std::fs::write(dir.join("a.myn"), b"OLD-A").unwrap();
        let blobs = vec![blob(dir, "a", b"NEW-A"), blob(dir, "b", b"NEW-B")];
        // Crash after staging both, before the marker.
        write_batch_inner(dir, &blobs, TxnFault::StopAfterStage).unwrap_err();
        assert_eq!(myn_tmp_count(dir), 2, "both staged .tmp present");
        assert!(!marker_exists(dir), "no marker → roll back");
        // Recover.
        recover_pending_rename(dir).unwrap();
        assert_eq!(
            read(&dir.join("a.myn")).as_deref(),
            Some(&b"OLD-A"[..]),
            "a kept old"
        );
        assert!(read(&dir.join("b.myn")).is_none(), "b never committed");
        assert_eq!(myn_tmp_count(dir), 0, ".tmp swept");
    }

    #[test]
    fn crash_after_marker_rolls_forward_all() {
        let d = ScopedTempDir::new("txn-markercrash").unwrap();
        let dir = d.path();
        std::fs::write(dir.join("a.myn"), b"OLD-A").unwrap();
        let blobs = vec![blob(dir, "a", b"NEW-A"), blob(dir, "b", b"NEW-B")];
        write_batch_inner(dir, &blobs, TxnFault::StopAfterMarker).unwrap_err();
        assert!(marker_exists(dir), "marker present → roll forward");
        assert_eq!(myn_tmp_count(dir), 2);
        recover_pending_rename(dir).unwrap();
        assert_eq!(
            read(&dir.join("a.myn")).as_deref(),
            Some(&b"NEW-A"[..]),
            "a committed"
        );
        assert_eq!(
            read(&dir.join("b.myn")).as_deref(),
            Some(&b"NEW-B"[..]),
            "b committed"
        );
        assert_eq!(myn_tmp_count(dir), 0);
        assert!(!marker_exists(dir), "marker cleared after recovery");
    }

    #[test]
    fn crash_mid_commit_rolls_forward_remainder() {
        let d = ScopedTempDir::new("txn-midcommit").unwrap();
        let dir = d.path();
        let blobs = vec![
            blob(dir, "a", b"NEW-A"),
            blob(dir, "b", b"NEW-B"),
            blob(dir, "c", b"NEW-C"),
        ];
        write_batch_inner(dir, &blobs, TxnFault::StopMidCommit).unwrap_err();
        // First renamed; the rest are still .tmp; marker present.
        assert!(marker_exists(dir));
        assert_eq!(
            read(&dir.join("a.myn")).as_deref(),
            Some(&b"NEW-A"[..]),
            "first committed"
        );
        assert!(read(&dir.join("b.myn")).is_none());
        recover_pending_rename(dir).unwrap();
        assert_eq!(read(&dir.join("b.myn")).as_deref(), Some(&b"NEW-B"[..]));
        assert_eq!(read(&dir.join("c.myn")).as_deref(), Some(&b"NEW-C"[..]));
        assert_eq!(myn_tmp_count(dir), 0);
        assert!(!marker_exists(dir));
    }

    #[test]
    fn recovery_is_a_noop_on_a_clean_dir() {
        let d = ScopedTempDir::new("txn-clean").unwrap();
        std::fs::write(d.path().join("a.myn"), b"AAA").unwrap();
        recover_pending_rename(d.path()).unwrap();
        assert_eq!(read(&d.path().join("a.myn")).as_deref(), Some(&b"AAA"[..]));
    }

    // ---- cross-impl conformance vectors (companion repo) --------------

    /// One rename-journal recovery scenario: a directory snapshot
    /// (`files`) and the expected snapshot after `recover_pending_rename`.
    struct RjScenario {
        slug: &'static str,
        kind: &'static str,
        desc: &'static str,
        /// `(name, content)` — `.rename-journal` (empty) is the marker;
        /// `*.myn.tmp` are staged blobs; `*.myn` are committed blobs.
        files: &'static [(&'static str, &'static [u8])],
    }

    const RJ_SCENARIOS: &[RjScenario] = &[
        RjScenario {
            slug: "roll-forward-marker-present",
            kind: "roll_forward",
            desc: "The marker is durable, so every staged .myn.tmp is rolled FORWARD to .myn and the marker is cleared. A pre-existing committed .myn is untouched.",
            files: &[
                (".rename-journal", b""),
                ("a.myn.tmp", b"NEW-A"),
                ("b.myn.tmp", b"NEW-B"),
                ("c.myn", b"OLD-C"),
            ],
        },
        RjScenario {
            slug: "roll-forward-replaces-existing",
            kind: "roll_forward",
            desc: "Roll-forward replaces a pre-existing committed .myn with its staged .myn.tmp content (the in-place note-update path).",
            files: &[
                (".rename-journal", b""),
                ("a.myn.tmp", b"NEW-A"),
                ("a.myn", b"OLD-A"),
            ],
        },
        RjScenario {
            slug: "roll-back-no-marker",
            kind: "roll_back",
            desc: "Without the marker the crash happened before the durability fence, so every staged .myn.tmp is rolled BACK (deleted) and the pre-existing committed .myn survives.",
            files: &[
                ("a.myn.tmp", b"NEW-A"),
                ("b.myn.tmp", b"NEW-B"),
                ("c.myn", b"OLD-C"),
            ],
        },
        RjScenario {
            slug: "noop-clean-dir",
            kind: "noop",
            desc: "A clean directory (no marker, no .tmp) is unchanged by recovery.",
            files: &[("a.myn", b"AAA"), ("b.myn", b"BBB")],
        },
    ];

    fn hex_lower(bytes: &[u8]) -> String {
        let mut s = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            s.push_str(&format!("{b:02x}"));
        }
        s
    }

    /// Snapshot a directory as a name-sorted `[(name, bytes)]` list. The
    /// rename journal has no inherent file order (POSIX `readdir` is
    /// unordered), so the snapshot is a SET keyed by name.
    fn snapshot_dir(dir: &Path) -> Vec<(String, Vec<u8>)> {
        let mut out: Vec<(String, Vec<u8>)> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| {
                let p = e.unwrap().path();
                let name = p.file_name().unwrap().to_string_lossy().into_owned();
                (name, std::fs::read(&p).unwrap())
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    fn files_to_json(files: &[(String, Vec<u8>)]) -> serde_json::Value {
        serde_json::Value::Array(
            files
                .iter()
                .map(|(name, bytes)| {
                    serde_json::json!({ "name": name, "content_hex": hex_lower(bytes) })
                })
                .collect(),
        )
    }

    /// Emits `myne-test-vectors/vectors/rename-journal/v0.1/cases.json` to
    /// `/tmp/myne_rename_journal_vectors.json`. `#[ignore]` — regenerating
    /// vectors is a deliberate act. Run with:
    /// `cargo test -p myne-desktop --lib emit_rename_journal_vectors_for_paste -- --ignored`
    ///
    /// Pins `recover_pending_rename` (the §9.12 rename-journal crash-recovery
    /// state machine) as an fs-state conformance fixture: a directory snapshot
    /// → the snapshot after recovery. Self-validating at mint (each emitted
    /// expected snapshot is the live recovery output; recovery is re-run to
    /// confirm idempotency).
    #[test]
    #[ignore]
    fn emit_rename_journal_vectors_for_paste() {
        let mut cases = Vec::new();
        for sc in RJ_SCENARIOS {
            let d = ScopedTempDir::new("gen-rj").unwrap();
            let dir = d.path();
            for (name, content) in sc.files {
                std::fs::write(dir.join(name), content).unwrap();
            }
            recover_pending_rename(dir).unwrap();
            let recovered = snapshot_dir(dir);
            // Idempotency self-check: a second recovery is a fixed point.
            recover_pending_rename(dir).unwrap();
            assert_eq!(
                snapshot_dir(dir),
                recovered,
                "[{}] recovery is not idempotent",
                sc.slug
            );

            let input: Vec<(String, Vec<u8>)> = sc
                .files
                .iter()
                .map(|(n, b)| ((*n).to_string(), b.to_vec()))
                .collect();
            let mut input_sorted = input.clone();
            input_sorted.sort_by(|a, b| a.0.cmp(&b.0));

            cases.push(serde_json::json!({
                "vector_id": format!("rename-journal/v0.1/{}", sc.slug),
                "description": sc.desc,
                "case_kind": sc.kind,
                "input_dir_files": files_to_json(&input_sorted),
                "expected_dir_files": files_to_json(&recovered),
            }));
        }

        let doc = serde_json::json!({
            "schema": "rename-journal",
            "protocol_version": "v0.1",
            "spec_section": "protocol.md §9.12 (transactional multi-note rename — the rename journal)",
            "description": "Pins note_txn::recover_pending_rename — the §9.12 rename-journal crash-recovery state machine — as an fs-state conformance fixture. NOT a byte-output codec: the .rename-journal marker is content-free and POSIX readdir is unordered, so each case pins a directory SNAPSHOT (a name-sorted set of {name, content_hex}) before and after recovery. The marker's presence is the only durability signal: present → roll FORWARD (every *.myn.tmp renamed to *.myn, marker cleared); absent → roll BACK (every *.myn.tmp deleted). A port materializes input_dir_files in a fresh directory, runs its recovery, and asserts the resulting set equals expected_dir_files. Generator + runner live in src-tauri/src/note_txn.rs (the codec is std/fs-bound, like backup-container). Cases generated by `cargo test -p myne-desktop --lib emit_rename_journal_vectors_for_paste -- --ignored`.",
            "cases": cases,
        });
        std::fs::write(
            "/tmp/myne_rename_journal_vectors.json",
            serde_json::to_string_pretty(&doc).unwrap() + "\n",
        )
        .unwrap();
        eprintln!("[ok] wrote /tmp/myne_rename_journal_vectors.json");
    }

    #[test]
    fn rename_journal_vectors() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("myne-test-vectors")
            .join("vectors")
            .join("rename-journal")
            .join("v0.1")
            .join("cases.json");
        if !path.exists() {
            eprintln!(
                "[skip] rename-journal: companion repo fixture not present at {}",
                path.display()
            );
            return;
        }

        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let doc: serde_json::Value =
            serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
        assert_eq!(doc["schema"], "rename-journal");
        assert_eq!(doc["protocol_version"], "v0.1");

        let cases = doc["cases"].as_array().expect("cases must be a JSON array");
        assert!(
            !cases.is_empty(),
            "rename-journal must have at least one case"
        );

        let hex_decode = |s: &str| -> Vec<u8> {
            assert!(s.len().is_multiple_of(2), "hex length must be even");
            (0..s.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("ascii hex"))
                .collect()
        };
        let materialize = |dir: &Path, files: &serde_json::Value| {
            for f in files.as_array().expect("dir_files must be an array") {
                let name = f["name"].as_str().expect("file name string");
                let content = hex_decode(f["content_hex"].as_str().expect("content_hex string"));
                std::fs::write(dir.join(name), content).expect("materialize file");
            }
        };
        let expected_set = |files: &serde_json::Value| -> Vec<(String, Vec<u8>)> {
            let mut v: Vec<(String, Vec<u8>)> = files
                .as_array()
                .expect("dir_files must be an array")
                .iter()
                .map(|f| {
                    (
                        f["name"].as_str().expect("name").to_string(),
                        hex_decode(f["content_hex"].as_str().expect("content_hex")),
                    )
                })
                .collect();
            v.sort_by(|a, b| a.0.cmp(&b.0));
            v
        };

        let mut seen_kinds = std::collections::HashSet::new();
        for case in cases {
            let id = case["vector_id"].as_str().expect("vector_id string");
            seen_kinds.insert(
                case["case_kind"]
                    .as_str()
                    .expect("case_kind string")
                    .to_string(),
            );

            let d = ScopedTempDir::new("rj-vec").unwrap();
            let dir = d.path();
            materialize(dir, &case["input_dir_files"]);
            recover_pending_rename(dir).unwrap_or_else(|e| panic!("[{id}] recovery failed: {e}"));
            let got = snapshot_dir(dir);
            let want = expected_set(&case["expected_dir_files"]);
            assert_eq!(
                got, want,
                "[{id}] post-recovery directory snapshot mismatch"
            );

            // Idempotency: a second recovery leaves the snapshot unchanged.
            recover_pending_rename(dir).unwrap();
            assert_eq!(snapshot_dir(dir), want, "[{id}] recovery is not idempotent");
        }
        for kind in ["roll_forward", "roll_back", "noop"] {
            assert!(
                seen_kinds.contains(kind),
                "rename-journal missing every case of case_kind '{kind}' — coverage regression"
            );
        }
    }
}
