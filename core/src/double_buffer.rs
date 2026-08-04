// SPDX-License-Identifier: AGPL-3.0
//! The double-buffered OPFS container (phase3-web-client task 18).
//!
//! # The problem this exists for
//!
//! The desktop's durability contract — `core/src/atomic_write.rs`: "either the
//! previous file or no file, never a half-written one" — is built on temp file +
//! `fsync` + platform rename + parent-directory sync. **OPFS offers `flush()`
//! and no crash-atomicity guarantee at all**, and the Phase 0 spike measured
//! that Safari does not implement `FileSystemFileHandle.move()`: a `TypeError`,
//! reproduced at 400 and at 3 000 files. So a rename-based port is not slower or
//! less elegant on a browser we ship to — it has no correct implementation.
//!
//! `decisions.md` 2026-07-26 "OPFS container layout diverges from the desktop
//! vault directory" settles the alternative: each singleton lives as **two files
//! written alternately**, never both at once, each carrying a sequence number.
//! On open, the newest copy that passes AEAD verification wins. A crash can
//! therefore destroy at most the copy being written, and the other one is a
//! complete, verifiable, slightly older vault file.
//!
//! # What is and is not in the bytes
//!
//! An OPFS file here is
//!
//! ```text
//!     u64 generation (big-endian)  ‖  <blob bytes, verbatim>
//! ```
//!
//! The generation is an **8-byte prefix outside the blob**. That placement is
//! the whole reason this needs no format change, no new magic, and no version
//! bump: strip 8 bytes and what remains is byte-identical to what desktop
//! writes. Putting the ordinal *inside* the blob would have been a
//! forward-incompatible v0.1 format change — a major-version event — for an
//! ordinal.
//!
//! The generation is **not authenticated**, deliberately. An attacker who can
//! write OPFS is code running on the origin and therefore already holds
//! `root_key`; authenticating an ordinal against them buys nothing. Integrity
//! stays AEAD's job. The generation decides only *recency*, and its worst case
//! is losing the last write — which is exactly what the crash cost anyway.
//!
//! # Why this lives in `myne-core` and not in the web entry crate
//!
//! It started in `web/wasm/src/container.rs`, which was the obvious home: only
//! the OPFS arm uses it. Task 19 moved it, and the reason is the one that
//! matters more than tidiness — **the wasm crate has no test runtime and no
//! filesystem to fault-inject.** Here the algorithm runs against any
//! [`VaultIo`], so the crash-recovery stop points are exercised over an
//! in-memory store by `cargo test --workspace`, which every contributor runs at
//! `pre-push`, rather than only in a browser nobody's pre-push has.
//!
//! Nothing about it is web-specific except who calls it: no OPFS, no JS, no
//! `wasm-bindgen`. Native builds never reach it — `atomic_write` is their
//! durability contract — exactly as the wasm build never reaches
//! `atomic_write`.

/// The generation prefix width. Eight bytes, big-endian, unauthenticated.
pub const GENERATION_PREFIX_LEN: usize = 8;

/// The two buffer suffixes. A singleton at `vault.prefs` occupies
/// `vault.prefs.a` and `vault.prefs.b`.
///
/// Suffixes rather than a subdirectory because OPFS is a handle tree and every
/// directory level is another async `getDirectoryHandle` round trip on the read
/// path — which `progress.md`'s task-17 measurement (1.088 ms/file write,
/// 0.395 ms/file read) makes a real cost rather than a theoretical one.
pub const SLOT_SUFFIXES: [&str; 2] = [".a", ".b"];

/// One buffer's file path for `base`.
pub fn slot_path(base: &str, slot: usize) -> String {
    format!("{base}{}", SLOT_SUFFIXES[slot % SLOT_SUFFIXES.len()])
}

/// The files that live as two alternating copies on OPFS.
///
/// **An allowlist, not a denylist, and the direction is the safety property.**
/// The excluded files are the per-item ones — `notes/<uuid>.myn`,
/// `attachments/<id>`, `attachments-text/<id>`, `captures/<id>`,
/// `pending-shares/sealed/<id>` — and they are excluded for a concrete reason
/// rather than because they are small: **their directories are enumerated**. A
/// `.a` / `.b` sibling inside `notes/` is a filename `read_dir` hands to a caller
/// that parses it as a note id, so double-buffering there does not merely waste
/// space, it manufactures phantom notes. Per-note durability is task 20's
/// write-new-then-remove-old instead, which needs no suffix.
///
/// With a denylist, a new per-item family added later would be double-buffered
/// silently and break enumeration. With this allowlist, a new *singleton* family
/// added later silently loses crash protection — a worse outcome to miss but a
/// visible one to prevent, which `every_known_singleton_is_double_buffered`
/// below does by naming the §10.3 families explicitly.
///
/// Both tiers of task 18 are here: the encrypted singletons and the device-local
/// sync bookkeeping (`sync-state.json`, `sync-config.json`, `pending-tombstones`,
/// `vault.meta-dirty`), which today go through `core/src/atomic_write.rs` — the
/// rename-based helper that has no correct OPFS implementation on Safari.
pub const DOUBLE_BUFFERED: &[&str] = &[
    // Encrypted singletons (`protocol.md` §10.3 blob families).
    "vault.meta",
    "vault.prefs",
    "vault.search",
    "vault.workspace",
    "vault.indices",
    "vault.attachments",
    "vault.dictionary",
    "vault.themes",
    "vault.graph",
    "vault.embeddings",
    "vault.quickunlock",
    "vault.head-state",
    // Device-local sync bookkeeping.
    "vault.meta-dirty",
    "sync-state.json",
    "sync-config.json",
    "pending-tombstones",
    // The attachment half of the deletion queue (`sync-protocol.md` §11.4).
    // Added by task 86 — it was the only member of this family left out, and
    // there is no reason for the asymmetry: it is read-modify-written on exactly
    // the same schedule as `pending-tombstones`, and a torn one loses the
    // deletion INTENT, so the server never reclaims the body.
    "pending-attachment-tombstones",
];

/// How a path is stored on a container-backed store.
///
/// Three modes rather than a boolean, because per-note blobs need the *crash
/// property* of the container without its *storage cost* (task 20).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// One file at the path given. Everything the container does not cover.
    Plain,
    /// Two slots kept permanently, alternating. The singletons: small, rewritten
    /// constantly, and the previous copy is worth keeping because it is the
    /// whole recovery.
    Doubled,
    /// Two slot NAMES, but only one file at rest: the write goes to the slot
    /// that is not live, and the previous one is removed once it lands.
    ///
    /// For per-note blobs, where the crash property is identical (the old copy
    /// is untouched while the new one is written) but keeping both would double
    /// a vault's whole storage footprint — a `.myn` can be 16 MiB, and there is
    /// one per note, so this is the difference between a constant overhead and a
    /// doubling.
    SingleLive,
}

/// How `path` is stored.
///
/// Matched on the **final path segment** plus, for notes, the directory it sits
/// in — so it is independent of how deep the vault directory sits under the OPFS
/// root: the same file name is the same decision in
/// `/myne/vaults/<id>/vault.prefs` and in a test's bare `vault.prefs`.
///
/// `vault.lock` is deliberately absent: on the web the single-tab guarantee is
/// the Web Locks API (task 21), not a file, so there is nothing to buffer.
pub fn mode_for(path: &str) -> Mode {
    let name = path.rsplit('/').next().unwrap_or(path);
    if DOUBLE_BUFFERED.contains(&name) {
        return Mode::Doubled;
    }
    // Write-once whole-blob entries, all `SingleLive` for the same reason: the
    // crash property matters and the storage cost of keeping both copies does
    // not buy anything, because nothing rewrites them in place.
    //
    // `notes/<uuid>.myn` — the per-note blob (task 20). Both halves of the check
    // are needed: the extension alone would catch a `.myn` a user exported next
    // to their attachments, and the directory alone would catch a stray file.
    //
    // `conflicts/<id>.myn` + `.meta` and `quarantine/<uuid>[-n].myn` — the two
    // staging trees (task 86). They used to fall through to `Plain`, and the
    // comment here said they "must not be rewritten under a caller's feet by a
    // container write". That reasoning was about the DOUBLED mode, which
    // rewrites a live slot; `SingleLive` does not — it writes the slot that is
    // not live and retires the old name afterwards, which is exactly the
    // write-once discipline these two already follow at the application level
    // (`stage_conflict` writes then the notes layer resolves;
    // `quarantine_note` writes then removes the source).
    //
    // What it buys is the difference between ABSENT and CORRUPT. OPFS has no
    // crash atomicity, so a torn `Plain` write leaves bytes that fail AEAD and
    // read as a damaged blob; a torn container write leaves an unframed slot
    // that `candidates` skips, so the file reads as not-there. For a staged
    // conflict that means the next cycle re-stages it (the CAS baseline never
    // advanced); for a quarantined note it means the reconcile re-quarantines
    // rather than surfacing corruption where §11.3 promised evidence.
    let parent = path.rsplit('/').nth(1).unwrap_or("");
    let staged = matches!(parent, "conflicts" | "quarantine")
        && (name.ends_with(".myn") || name.ends_with(".meta"));
    if (parent == "notes" && name.ends_with(".myn")) || staged {
        return Mode::SingleLive;
    }
    Mode::Plain
}

/// Whether `path` is stored as a container at all (either mode).
pub fn is_container(path: &str) -> bool {
    mode_for(path) != Mode::Plain
}

/// The base name a slot file belongs to, or `None` when `name` is not one.
///
/// What `read_dir` needs: a container-backed directory listing contains
/// `019f-….myn.a`, and a caller that parses entries as note ids would read that
/// as a note whose id ends in `.myn.a`. Mapping back — and de-duplicating, since
/// an interrupted save leaves both slots for a moment — is what keeps the
/// container invisible above the seam.
pub fn strip_slot_suffix(name: &str) -> Option<&str> {
    SLOT_SUFFIXES
        .iter()
        .find_map(|suffix| name.strip_suffix(suffix))
}

// A buffer's on-disk state is `Option<u64>` — its generation, or `None` when the
// file is absent, too short to carry a prefix, or carries the reserved zero.
// Those three must be indistinguishable to a reader, which is why they collapse
// into one `None` here rather than into a struct with a reason field nobody can
// act on differently.

/// Split a container into its generation and its payload.
///
/// `None` when the bytes are shorter than the prefix: a file that does not even
/// carry a complete ordinal cannot be ranked, so it is not a candidate. This is
/// the "torn prefix falls back to the other buffer" case, and it resolves here
/// rather than at a call site that would have to know the framing.
pub fn split(bytes: &[u8]) -> Option<(u64, &[u8])> {
    if bytes.len() < GENERATION_PREFIX_LEN {
        return None;
    }
    let (head, payload) = bytes.split_at(GENERATION_PREFIX_LEN);
    let generation = u64::from_be_bytes(head.try_into().expect("8 bytes by construction"));
    // Generation 0 is reserved as "never written". A zero-filled file — which is
    // what a sparse or truncated OPFS write can leave — must not outrank a real
    // buffer, and must not be indistinguishable from generation 1.
    if generation == 0 {
        return None;
    }
    Some((generation, payload))
}

/// Frame `payload` as a container at `generation`.
///
/// Panics on generation 0, which is reserved. A caller reaching that value has a
/// counter bug, and writing it would produce a file every reader silently
/// ignores — a vault that quietly stops persisting.
pub fn frame(generation: u64, payload: &[u8]) -> Vec<u8> {
    assert!(
        generation > 0,
        "generation 0 is reserved for `never written`; framing it would write a \
         file every reader discards"
    );
    let mut out = Vec::with_capacity(GENERATION_PREFIX_LEN + payload.len());
    out.extend_from_slice(&generation.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// Which slot the next write goes to, and at which generation.
///
/// The rule is one sentence: **write the slot that is not the newest**. That is
/// what makes "never both at once" hold without a lock — the newest complete
/// copy is never the one being overwritten, so a crash mid-write leaves it
/// untouched.
///
/// With no readable slot at all (first write, or both torn) it writes slot 0 at
/// generation 1.
pub fn next_write(slots: [Option<u64>; 2]) -> (usize, u64) {
    match (slots[0], slots[1]) {
        (None, None) => (0, 1),
        // Exactly one readable: overwrite the other, one past the readable one.
        (Some(g), None) => (1, g + 1),
        (None, Some(g)) => (0, g + 1),
        // Both readable: overwrite the older. The tie — which only a bug or a
        // hand-edited container produces — resolves to slot 1, and it has to:
        // [`read_order`] breaks its own tie toward slot 0, so writing slot 0
        // here would overwrite the copy a reader would have preferred. The first
        // version of this arm did exactly that, and the "a write never targets
        // the newest slot" test below is what caught it.
        (Some(a), Some(b)) => {
            if a >= b {
                (1, a + 1)
            } else {
                (0, b + 1)
            }
        }
    }
}

/// The slots to try on open, newest first.
///
/// Returns indices rather than bytes because the caller decides how far to go:
/// it tries the first, and only reads the second if AEAD verification of the
/// first fails. **That ordering is the recovery**, and it is why the reader
/// cannot simply take the highest generation and stop — a torn write can leave a
/// complete prefix above a truncated payload, which ranks newest and does not
/// verify.
///
/// Unreadable slots are dropped, so the result may be empty (no vault file yet),
/// one long (first write, or one torn), or two long.
pub fn read_order(slots: [Option<u64>; 2]) -> Vec<usize> {
    let mut present: Vec<(usize, u64)> = slots
        .iter()
        .enumerate()
        .filter_map(|(i, g)| g.map(|g| (i, g)))
        .collect();
    // Descending by generation; ties broken by slot index so the order is total.
    present.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    present.into_iter().map(|(i, _)| i).collect()
}

// ── the write/open algorithm over the seam (task 18) + its fault seam (task 19) ─

use crate::io_failure_kind::IoFailureKind;
use crate::vault_io::{IoResult, VaultIo, WriteOpts};
use std::path::Path;

/// Where a simulated crash lands during [`write_next`].
///
/// Mirrors `atomic_write.rs`'s `Fault` in shape and in discipline: production
/// passes [`Fault::None`], so the seam collapses to the straight-line path with
/// byte-identical behaviour and no runtime cost. It exists because the property
/// under test — "a crash leaves either the previous state or the new one, never
/// a torn one" — cannot be observed by killing a process in a unit test.
///
/// The stop points are the ones a real crash can land on, in order:
///
/// | variant | crash lands | what must survive |
/// |---|---|---|
/// | [`Fault::StopBeforeWrite`] | after choosing the slot, before touching it | the previous copy, untouched |
/// | [`Fault::StopMidWrite`] | with a prefix of the container on disk | the previous copy — the half-written one must not outrank it |
/// | [`Fault::StopBeforeFlush`] | bytes written, not durable | either, and both must open |
/// | [`Fault::None`] | no crash | the new copy |
///
/// `StopBeforeFlush` is where OPFS differs from a filesystem and why this is not
/// over-modelling: `FileSystemSyncAccessHandle.flush()` is the only durability
/// primitive a browser offers, and what a crash before it leaves is
/// **unspecified**. The scheme has to be correct for either outcome, so the test
/// asserts the weaker property (the open succeeds and yields a *complete* copy)
/// rather than pinning which one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Fault {
    /// Production. No injection.
    #[default]
    None,
    /// Crash before the new copy is touched at all.
    #[cfg(any(test, feature = "test-support"))]
    StopBeforeWrite,
    /// Crash with only the first `n` bytes of the container written.
    #[cfg(any(test, feature = "test-support"))]
    StopMidWrite(usize),
    /// Crash after the bytes are written but before they are durable.
    #[cfg(any(test, feature = "test-support"))]
    StopBeforeFlush,
}

/// Write `bytes` as the next generation of the singleton at `base`.
///
/// Reads both slots' generations (8 bytes each — [`crate::vault_io::VaultIo::read_prefix`]
/// exists for exactly this), writes the one that is **not** the newest, and
/// stamps it one generation above the highest. The newest complete copy is
/// therefore never the file being written, which is the entire crash-safety
/// argument.
///
/// `io` must be a **raw** [`VaultIo`] — one whose `write` puts bytes at the path
/// it is given. Handing it an implementation that itself double-buffers would
/// produce `vault.prefs.a.a`.
pub async fn write_next(io: &dyn VaultIo, base: &Path, bytes: &[u8]) -> IoResult<()> {
    write_next_faulting(io, base, bytes, Fault::None).await
}

/// [`write_next`] with a simulated crash. Test-only entry point; production
/// calls the wrapper above with [`Fault::None`].
pub async fn write_next_faulting(
    io: &dyn VaultIo,
    base: &Path,
    bytes: &[u8],
    fault: Fault,
) -> IoResult<()> {
    let base_str = base.to_string_lossy().to_string();
    let slots = slot_generations(io, &base_str).await?;
    let (slot, generation) = next_write(slots);
    let path = slot_file(&base_str, slot);

    // The injected arms are `#[cfg(test)]` variants, so in a production build
    // this match has exactly one arm and compiles away entirely — the same
    // discipline `atomic_write.rs` applies to its own seam, and the reason a
    // fault-injection seam is allowed to exist on a durability path at all.
    match fault {
        // The crash landed before the target file was touched. Nothing to do —
        // and nothing to clean up, which is the difference from the temp-file
        // scheme: there is no stray sibling, only an older copy that is still
        // exactly what it was.
        #[cfg(any(test, feature = "test-support"))]
        Fault::StopBeforeWrite => return Ok(()),
        #[cfg(any(test, feature = "test-support"))]
        Fault::StopMidWrite(n) => {
            let framed = frame(generation, bytes);
            let cut = n.min(framed.len());
            io.write(Path::new(&path), &framed[..cut], WriteOpts::default())
                .await?;
            return Ok(());
        }
        // Bytes written, durability not established. Modelled as a completed
        // write because that is the outcome the caller cannot distinguish; what
        // the test asserts is that BOTH possible on-disk states open.
        #[cfg(any(test, feature = "test-support"))]
        Fault::StopBeforeFlush => {}
        Fault::None => {}
    }

    let framed = frame(generation, bytes);
    io.write(Path::new(&path), &framed, WriteOpts::default())
        .await
}

/// Write `bytes` as the next generation and then remove the previous copy
/// (task 20) — the per-note scheme.
///
/// Identical to [`write_next`] up to the point the new copy lands, which is what
/// gives it the same crash property: the previous copy is untouched for the whole
/// time the new one is being written, so an interrupted save leaves a complete
/// old note rather than a torn new one. The difference is what happens *after*:
/// the loser slot is removed, so a note occupies one file at rest.
///
/// Doing it in that order matters and is not interchangeable. Removing first
/// would open a window in which a crash leaves **no** copy at all — the one
/// outcome neither scheme is allowed to produce.
///
/// The removal is **best-effort**: a save that wrote its new copy successfully
/// has succeeded, and failing it over an orphan would turn a cosmetic leftover
/// into a lost edit. The orphan is cleaned by [`sweep_orphans`] on the next open
/// of that note, or by the next save, which overwrites that very slot.
pub async fn write_single_live(io: &dyn VaultIo, base: &Path, bytes: &[u8]) -> IoResult<()> {
    write_single_live_faulting(io, base, bytes, Fault::None).await
}

/// [`write_single_live`] with a simulated crash.
pub async fn write_single_live_faulting(
    io: &dyn VaultIo,
    base: &Path,
    bytes: &[u8],
    fault: Fault,
) -> IoResult<()> {
    let base_str = base.to_string_lossy().to_string();
    let before = slot_generations(io, &base_str).await?;
    let (written_slot, _) = next_write(before);
    write_next_faulting(io, base, bytes, fault).await?;

    // Only a write that actually landed retires the previous copy. Under an
    // injected fault — and under a real crash, which is what it models — the
    // process is gone before this line, so the old copy survives by construction
    // rather than by a check.
    if fault != Fault::None {
        return Ok(());
    }

    let loser = (written_slot + 1) % SLOT_SUFFIXES.len();
    let _ = io
        .remove_file(Path::new(&slot_file(&base_str, loser)))
        .await;
    Ok(())
}

/// Remove every copy of `base` except the newest that is readable.
///
/// The cleanup half of [`write_single_live`], for the window a crash can leave
/// behind: new copy written, old one not yet removed.
///
/// # It keeps the newest RANKABLE slot, not the newest VERIFIABLE one
///
/// This function holds no keys and no format knowledge, so "readable" here means
/// only "carries a rankable 8-byte generation stamp". A slot torn mid-write
/// whose stamp DID land ranks first and survives — while the intact older copy,
/// which is the one a reader would fall back to, is unlinked.
///
/// That is why it must be called only where the survivor has been VERIFIED
/// (myne#298). It used to sit on the unverified `read` arm of the web IO seam,
/// which made a torn newest slot an irreversible loss: the read returned the
/// torn bytes and the sweep deleted the only intact copy, so no later fix, no
/// repair tool and not `singleton::open_newest` itself could recover it. For a
/// note that had not yet been pushed, those bytes were the only copy anywhere.
///
/// Best-effort and idempotent: on a store with nothing to clean it performs no
/// writes at all.
pub async fn sweep_orphans(io: &dyn VaultIo, base: &Path) -> IoResult<()> {
    let base_str = base.to_string_lossy().to_string();
    let slots = slot_generations(io, &base_str).await?;
    let order = read_order(slots);
    // Nothing readable, or only one copy: nothing to sweep. The first case is an
    // absent item, and removing "everything but the newest" of nothing must not
    // become removing the torn slot — that is the copy a *doubled* item would
    // need, and this function has no way to know it is not being pointed at one.
    if order.len() < 2 {
        return Ok(());
    }
    for &slot in &order[1..] {
        let _ = io.remove_file(Path::new(&slot_file(&base_str, slot))).await;
    }
    Ok(())
}

/// Every stored copy of the singleton at `base`, newest first, prefixes stripped.
///
/// Slots that cannot be ranked (absent, shorter than the prefix, or carrying the
/// reserved generation 0) are dropped rather than returned, so the caller's list
/// contains only things worth attempting to decode. An empty list means no copy
/// exists.
pub async fn candidates(io: &dyn VaultIo, base: &Path) -> IoResult<Vec<Vec<u8>>> {
    let base_str = base.to_string_lossy().to_string();
    let slots = slot_generations(io, &base_str).await?;
    let mut out = Vec::new();
    for slot in read_order(slots) {
        let path = slot_file(&base_str, slot);
        match io.read(Path::new(&path)).await {
            Ok(bytes) => {
                if let Some((_, payload)) = split(&bytes) {
                    out.push(payload.to_vec());
                }
                // A slot that ranked readable a moment ago and no longer splits
                // was torn between the two reads. One fewer candidate, not a
                // failed open: the other slot is still in the list.
            }
            Err(IoFailureKind::NotFound) => {}
            // A real inability to read — permission, quota — is not "one fewer
            // candidate". Reporting it as an empty list would present a
            // temporarily unreadable vault as an absent one, and the recovery
            // for those two is opposite.
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}

/// Remove every copy of the singleton at `base`.
///
/// Both slots, or the delete is a lie: leaving one copy means the next open
/// resurrects the vault from it. Absent slots do not fail — the normal state of
/// a singleton written an odd number of times is exactly one slot — but a delete
/// that found nothing at all reports [`IoFailureKind::NotFound`], matching the
/// seam's "removing an absent file is an error" rule.
pub async fn remove_all(io: &dyn VaultIo, base: &Path) -> IoResult<()> {
    let base_str = base.to_string_lossy().to_string();
    let mut removed_any = false;
    let mut first_error = None;
    for slot in 0..SLOT_SUFFIXES.len() {
        match io.remove_file(Path::new(&slot_file(&base_str, slot))).await {
            Ok(()) => removed_any = true,
            Err(IoFailureKind::NotFound) => {}
            Err(e) => {
                if first_error.is_none() {
                    first_error = Some(e);
                }
            }
        }
    }
    match (first_error, removed_any) {
        (Some(e), _) => Err(e),
        (None, true) => Ok(()),
        (None, false) => Err(IoFailureKind::NotFound),
    }
}

/// The full path of one slot of the singleton at `base`.
fn slot_file(base: &str, slot: usize) -> String {
    format!("{base}{}", SLOT_SUFFIXES[slot % SLOT_SUFFIXES.len()])
}

/// Both slots' generations, read 8 bytes at a time.
///
/// `read_prefix`, not `read`: this runs before every singleton write and on every
/// open, and pulling a whole `vault.search` twice to compare two ordinals would
/// be the expensive way to ask a cheap question.
async fn slot_generations(io: &dyn VaultIo, base: &str) -> IoResult<[Option<u64>; 2]> {
    let mut out = [None, None];
    for (slot, entry) in out.iter_mut().enumerate() {
        let path = slot_file(base, slot);
        *entry = match io
            .read_prefix(Path::new(&path), GENERATION_PREFIX_LEN)
            .await
        {
            Ok(bytes) => split(&bytes).map(|(generation, _)| generation),
            // A missing slot is the normal state of a vault written an odd
            // number of times, and of every vault before its first write.
            Err(IoFailureKind::NotFound) => None,
            // Anything else is a real inability to consult the store, and must
            // not read as "no copy here" — that would send the caller on to
            // overwrite the copy it could not see.
            Err(e) => return Err(e),
        };
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── fault-injected crash recovery (task 19) ─────────────────────────────
    //
    // The claim under test is the one `atomic_write` makes on native and this
    // scheme has to make on a browser: **a crash leaves either the previous
    // state or the new one, never a torn one.** It is asserted by stopping the
    // write at each point a real crash can land on, then opening.

    use crate::vault_io::{DirEntry, IoResult, StdVaultIo, WriteOpts};
    use std::path::PathBuf;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
    }

    /// A vault directory on the real filesystem, driven through the real seam.
    ///
    /// Deliberately not an in-memory fake: the algorithm's contract is with
    /// [`VaultIo`], and a fake would let a wrong assumption about the seam
    /// (`read_prefix` at EOF, `NotFound` vs empty) pass here and fail in a
    /// browser. `StdVaultIo` is the arm both this and desktop share.
    struct Scratch {
        dir: crate::test_support::ScopedTempDir,
    }

    impl Scratch {
        fn new(label: &str) -> Self {
            Self {
                dir: crate::test_support::ScopedTempDir::new(label).expect("scratch dir"),
            }
        }
        fn base(&self) -> PathBuf {
            self.dir.path().join("vault.prefs")
        }
        fn slot_len(&self, slot: usize) -> Option<usize> {
            std::fs::metadata(slot_file(&self.base().to_string_lossy(), slot))
                .ok()
                .map(|m| m.len() as usize)
        }
    }

    /// Payloads name the write they came from, and are long enough that the
    /// mid-write sweep has real truncations to produce rather than three.
    fn payload(n: u8) -> Vec<u8> {
        format!("v{n}-").repeat(8).into_bytes()
    }

    #[test]
    fn a_clean_write_then_open_yields_what_was_written() {
        rt().block_on(async {
            let s = Scratch::new("db_clean");
            write_next(&StdVaultIo, &s.base(), &payload(1))
                .await
                .expect("first write");
            assert_eq!(
                candidates(&StdVaultIo, &s.base()).await.unwrap(),
                vec![payload(1)]
            );

            write_next(&StdVaultIo, &s.base(), &payload(2))
                .await
                .expect("second write");
            let got = candidates(&StdVaultIo, &s.base()).await.unwrap();
            assert_eq!(got[0], payload(2), "newest first");
            assert_eq!(got[1], payload(1), "and the previous copy is still there");
            // Both slots occupied, which is what makes the recovery possible at
            // all: a scheme that overwrote in place would have one file here.
            assert!(s.slot_len(0).is_some() && s.slot_len(1).is_some());
        });
    }

    /// Stop point 1: the crash lands before the target slot is touched.
    #[test]
    fn stop_before_write_leaves_the_previous_copy_untouched() {
        rt().block_on(async {
            let s = Scratch::new("db_before");
            write_next(&StdVaultIo, &s.base(), &payload(1))
                .await
                .unwrap();
            let before = s.slot_len(0);

            write_next_faulting(&StdVaultIo, &s.base(), &payload(2), Fault::StopBeforeWrite)
                .await
                .unwrap();

            assert_eq!(
                candidates(&StdVaultIo, &s.base()).await.unwrap(),
                vec![payload(1)],
                "the interrupted write must not have changed what opens"
            );
            assert_eq!(s.slot_len(0), before, "and must not have touched slot 0");
            assert_eq!(s.slot_len(1), None, "nor created slot 1");
        });
    }

    /// Stop point 2: the crash lands with part of the container on disk.
    ///
    /// Swept across every cut length rather than one arbitrary value, because
    /// the interesting ones are at the boundaries — 0 bytes, a partial prefix, a
    /// complete prefix with no payload, a partial payload — and an example-based
    /// test picks whichever the author happened to think of.
    #[test]
    fn stop_mid_write_never_costs_the_previous_copy() {
        rt().block_on(async {
            for cut in 0..=(GENERATION_PREFIX_LEN + payload(2).len()) {
                let s = Scratch::new(&format!("db_mid_{cut}"));
                write_next(&StdVaultIo, &s.base(), &payload(1))
                    .await
                    .unwrap();

                write_next_faulting(
                    &StdVaultIo,
                    &s.base(),
                    &payload(2),
                    Fault::StopMidWrite(cut),
                )
                .await
                .unwrap();

                let got = candidates(&StdVaultIo, &s.base()).await.unwrap();
                // The invariant, in the only form that is true at every cut:
                // the previous copy is still there, and it is the LAST thing
                // tried — so a caller that falls through decode failures always
                // reaches it.
                assert_eq!(
                    got.last(),
                    Some(&payload(1)),
                    "cut={cut}: the previous copy must still open, and be the fallback"
                );
                // Anything ahead of it is the interrupted write, which means a
                // PREFIX of what was being written — never a different value,
                // and never a complete one that was not committed.
                for partial in &got[..got.len() - 1] {
                    // A prefix, up to and including the whole thing: a cut at or
                    // past the container's length is not a torn write at all, it
                    // is a completed one, and it must open as the new copy.
                    assert!(
                        payload(2).starts_with(partial),
                        "cut={cut}: candidate {partial:?} is not a truncation of the \
                         write in progress"
                    );
                }
                // A slot whose GENERATION did not survive cannot rank at all —
                // an unranked torn slot is invisible rather than merely
                // out-of-order. At a cut of exactly the prefix length the
                // generation IS complete and the payload is empty, so the slot
                // ranks and hands back zero bytes: correct, and the caller's
                // decode rejects it on the way to the copy below.
                if cut < GENERATION_PREFIX_LEN {
                    assert_eq!(
                        got,
                        vec![payload(1)],
                        "cut={cut}: a slot with no complete prefix must not rank"
                    );
                } else {
                    assert_eq!(got.len(), 2, "cut={cut}: both slots rank");
                }
            }
        });
    }

    /// Stop point 3: written, not yet durable.
    ///
    /// A browser gives no answer about what survives here, so the assertion is
    /// the weaker, true one: whatever survived, the open succeeds and yields a
    /// COMPLETE copy — never a truncated one, and never nothing.
    #[test]
    fn stop_before_flush_yields_a_complete_copy_either_way() {
        rt().block_on(async {
            let s = Scratch::new("db_flush");
            write_next(&StdVaultIo, &s.base(), &payload(1))
                .await
                .unwrap();
            write_next_faulting(&StdVaultIo, &s.base(), &payload(2), Fault::StopBeforeFlush)
                .await
                .unwrap();

            let got = candidates(&StdVaultIo, &s.base()).await.unwrap();
            assert!(!got.is_empty(), "the vault must still open");
            for candidate in &got {
                assert!(
                    candidate == &payload(1) || candidate == &payload(2),
                    "a partial copy reached the caller: {candidate:?}"
                );
            }
            assert_eq!(
                got[0],
                payload(2),
                "the new copy, if it survived, is newest"
            );
        });
    }

    /// Stop point 4: no crash. The new copy is what opens.
    #[test]
    fn no_fault_is_byte_identical_to_the_production_path() {
        rt().block_on(async {
            let a = Scratch::new("db_none_a");
            let b = Scratch::new("db_none_b");
            for n in 1..=3 {
                write_next(&StdVaultIo, &a.base(), &payload(n))
                    .await
                    .unwrap();
                write_next_faulting(&StdVaultIo, &b.base(), &payload(n), Fault::None)
                    .await
                    .unwrap();
            }
            // Same bytes in the same slots: `Fault::None` is not a near-copy of
            // the production path, it IS it.
            for slot in 0..SLOT_SUFFIXES.len() {
                let pa = std::fs::read(slot_file(&a.base().to_string_lossy(), slot)).unwrap();
                let pb = std::fs::read(slot_file(&b.base().to_string_lossy(), slot)).unwrap();
                assert_eq!(pa, pb, "slot {slot}");
            }
            assert_eq!(
                candidates(&StdVaultIo, &a.base()).await.unwrap()[0],
                payload(3)
            );
        });
    }

    /// A crash on the FIRST-EVER write leaves no vault, not a broken one.
    #[test]
    fn a_torn_first_write_is_absent_rather_than_corrupt() {
        rt().block_on(async {
            let s = Scratch::new("db_first");
            write_next_faulting(
                &StdVaultIo,
                &s.base(),
                &payload(1),
                Fault::StopMidWrite(GENERATION_PREFIX_LEN + 1),
            )
            .await
            .unwrap();
            let got = candidates(&StdVaultIo, &s.base()).await.unwrap();
            // The torn slot ranks (its prefix is complete) and its payload is
            // partial — so the caller's decode fails and it reports a corrupt
            // vault. That is correct and unavoidable: there is no older copy,
            // because there was never a successful write. What matters is that
            // it is ONE candidate, not a phantom second one.
            assert_eq!(got.len(), 1);
            assert_ne!(got[0], payload(1), "a partial payload is not the payload");
        });
    }

    /// The criterion "a broken generation comparison fails the suite", made real.
    ///
    /// The recovery rests on one comparison — newest first — and a test suite
    /// that would still pass with it inverted is not testing it. Ordering is
    /// re-derived here the wrong way round and the result contradicts what
    /// `candidates` returns.
    #[test]
    fn an_inverted_generation_comparison_would_change_what_opens() {
        rt().block_on(async {
            let s = Scratch::new("db_order");
            write_next(&StdVaultIo, &s.base(), &payload(1))
                .await
                .unwrap();
            write_next(&StdVaultIo, &s.base(), &payload(2))
                .await
                .unwrap();

            let correct = candidates(&StdVaultIo, &s.base()).await.unwrap();
            assert_eq!(correct[0], payload(2));

            let slots = slot_generations(&StdVaultIo, &s.base().to_string_lossy())
                .await
                .unwrap();
            let mut inverted: Vec<(usize, u64)> = slots
                .iter()
                .enumerate()
                .filter_map(|(i, g)| g.map(|g| (i, g)))
                .collect();
            inverted.sort_by_key(|(_, generation)| *generation); // oldest first — the bug
            let would_open = {
                let path = slot_file(&s.base().to_string_lossy(), inverted[0].0);
                let bytes = std::fs::read(path).unwrap();
                split(&bytes).unwrap().1.to_vec()
            };
            assert_eq!(
                would_open,
                payload(1),
                "an inverted comparison opens the PREVIOUS write — which is the \
                 silent data-loss this ordering exists to prevent"
            );
            assert_ne!(would_open, correct[0]);
        });
    }

    // ── per-note single-live copy (task 20) ─────────────────────────────────

    /// The success path leaves exactly ONE file — the point of the mode.
    #[test]
    fn a_single_live_write_leaves_one_file_at_rest() {
        rt().block_on(async {
            let s = Scratch::new("sl_one");
            write_single_live(&StdVaultIo, &s.base(), &payload(1))
                .await
                .unwrap();
            let live = [s.slot_len(0), s.slot_len(1)];
            assert_eq!(
                live.iter().filter(|l| l.is_some()).count(),
                1,
                "one copy at rest, not two: {live:?}"
            );

            for n in 2..=5 {
                write_single_live(&StdVaultIo, &s.base(), &payload(n))
                    .await
                    .unwrap();
                let live = [s.slot_len(0), s.slot_len(1)];
                assert_eq!(
                    live.iter().filter(|l| l.is_some()).count(),
                    1,
                    "still one copy after write {n}: {live:?}"
                );
                assert_eq!(
                    candidates(&StdVaultIo, &s.base()).await.unwrap(),
                    vec![payload(n)],
                    "and it is the newest content"
                );
            }
        });
    }

    /// The property this mode exists to keep: an interrupted save leaves the
    /// PREVIOUS note completely readable, not a torn new one.
    ///
    /// Swept across every cut, like the singleton case, because the interesting
    /// cuts are at the boundaries and an example would pick one of them at best.
    #[test]
    fn an_interrupted_single_live_save_leaves_the_previous_note_readable() {
        rt().block_on(async {
            for cut in 0..=(GENERATION_PREFIX_LEN + payload(2).len()) {
                let s = Scratch::new(&format!("sl_cut_{cut}"));
                write_single_live(&StdVaultIo, &s.base(), &payload(1))
                    .await
                    .unwrap();

                write_single_live_faulting(
                    &StdVaultIo,
                    &s.base(),
                    &payload(2),
                    Fault::StopMidWrite(cut),
                )
                .await
                .unwrap();

                let got = candidates(&StdVaultIo, &s.base()).await.unwrap();
                assert_eq!(
                    got.last(),
                    Some(&payload(1)),
                    "cut={cut}: the previous note must still open"
                );
                for partial in &got[..got.len() - 1] {
                    assert!(
                        payload(2).starts_with(partial),
                        "cut={cut}: {partial:?} is not a truncation of the save in progress"
                    );
                }
            }
        });
    }

    /// A crash between the write and the removal leaves an orphan; the next open
    /// cleans it.
    #[test]
    fn an_orphan_from_an_interrupted_save_is_swept_on_next_open() {
        rt().block_on(async {
            let s = Scratch::new("sl_orphan");
            write_single_live(&StdVaultIo, &s.base(), &payload(1))
                .await
                .unwrap();
            // `StopBeforeFlush` models "the bytes landed, the process did not
            // survive to remove the old copy" — which is exactly the orphan
            // window, and the only fault that can produce one.
            write_single_live_faulting(&StdVaultIo, &s.base(), &payload(2), Fault::StopBeforeFlush)
                .await
                .unwrap();
            assert_eq!(
                [s.slot_len(0), s.slot_len(1)]
                    .iter()
                    .filter(|l| l.is_some())
                    .count(),
                2,
                "the orphan window really did leave two files"
            );

            // The newest content is what opens even before the sweep — the
            // orphan is a storage leak, never a correctness one.
            assert_eq!(
                candidates(&StdVaultIo, &s.base()).await.unwrap()[0],
                payload(2)
            );

            sweep_orphans(&StdVaultIo, &s.base()).await.unwrap();
            assert_eq!(
                [s.slot_len(0), s.slot_len(1)]
                    .iter()
                    .filter(|l| l.is_some())
                    .count(),
                1,
                "the sweep leaves one copy"
            );
            assert_eq!(
                candidates(&StdVaultIo, &s.base()).await.unwrap(),
                vec![payload(2)],
                "and it is the newest one — the sweep must not keep the loser"
            );
        });
    }

    /// The sweep is safe to call on anything: absent, single-copy, already clean.
    #[test]
    fn sweeping_is_idempotent_and_never_removes_the_only_copy() {
        rt().block_on(async {
            let s = Scratch::new("sl_sweep_safe");
            // Absent.
            sweep_orphans(&StdVaultIo, &s.base()).await.unwrap();
            assert!(candidates(&StdVaultIo, &s.base()).await.unwrap().is_empty());

            // One copy — the state every note is in at rest. A sweep that
            // removed "everything but the newest" without checking would delete
            // it here, which is the bug this asserts against.
            write_single_live(&StdVaultIo, &s.base(), &payload(1))
                .await
                .unwrap();
            for _ in 0..3 {
                sweep_orphans(&StdVaultIo, &s.base()).await.unwrap();
                assert_eq!(
                    candidates(&StdVaultIo, &s.base()).await.unwrap(),
                    vec![payload(1)]
                );
            }
        });
    }

    /// Deleting a singleton removes BOTH copies.
    #[test]
    fn remove_all_leaves_nothing_to_resurrect_the_vault_from() {
        rt().block_on(async {
            let s = Scratch::new("db_remove");
            write_next(&StdVaultIo, &s.base(), &payload(1))
                .await
                .unwrap();
            write_next(&StdVaultIo, &s.base(), &payload(2))
                .await
                .unwrap();
            remove_all(&StdVaultIo, &s.base()).await.expect("remove");

            assert!(candidates(&StdVaultIo, &s.base()).await.unwrap().is_empty());
            assert_eq!(s.slot_len(0), None);
            assert_eq!(s.slot_len(1), None);
            // Removing an already-absent singleton is `NotFound`, matching the
            // seam's rule for a single file.
            assert_eq!(
                remove_all(&StdVaultIo, &s.base()).await,
                Err(IoFailureKind::NotFound)
            );
        });
    }

    /// Unused-import guard: the algorithm tests above use these, and dropping a
    /// test would otherwise leave a stale `use` that clippy fails on.
    #[allow(dead_code)]
    fn _seam_types_are_used(_: DirEntry, _: WriteOpts, _: IoResult<()>) {}

    #[test]
    fn a_framed_payload_round_trips_and_the_blob_bytes_are_untouched() {
        // The load-bearing property of the whole scheme: strip 8 bytes and what
        // is left is byte-identical to what desktop wrote. If this ever fails,
        // the container has started editing blobs and the "no format change"
        // claim in `decisions.md` is false.
        let blob = b"MYP1\x01\x00\x00 ... arbitrary ciphertext ...";
        let framed = frame(7, blob);
        assert_eq!(&framed[GENERATION_PREFIX_LEN..], blob);
        let (generation, payload) = split(&framed).expect("round trip");
        assert_eq!(generation, 7);
        assert_eq!(payload, blob);
    }

    #[test]
    fn an_empty_payload_is_still_a_valid_container() {
        // A zero-length blob is not a thing any family writes today, but the
        // container must not invent a failure the caller cannot distinguish from
        // a torn write.
        let framed = frame(1, b"");
        assert_eq!(split(&framed), Some((1, &[][..])));
    }

    #[test]
    fn a_short_file_is_not_a_candidate() {
        for len in 0..GENERATION_PREFIX_LEN {
            assert_eq!(split(&vec![0xff; len]), None, "len {len}");
        }
    }

    #[test]
    fn a_zero_filled_file_is_not_a_candidate() {
        // The case that motivates reserving 0: a truncated or sparse OPFS write
        // can leave zeros. Ranked as generation 0 it would be a valid, oldest
        // buffer — and on a first write, the ONLY buffer, so `read_order` would
        // hand the caller a file of zeros to decode.
        assert_eq!(split(&[0u8; 64]), None);
    }

    #[test]
    fn the_first_write_takes_slot_zero_at_generation_one() {
        assert_eq!(next_write([None, None]), (0, 1));
    }

    #[test]
    fn a_write_never_targets_the_newest_slot() {
        // The property the crash-safety argument rests on, stated as a loop over
        // every shape rather than as three examples.
        let cases: [[Option<u64>; 2]; 6] = [
            [Some(1), None],
            [None, Some(1)],
            [Some(1), Some(2)],
            [Some(2), Some(1)],
            [Some(9), Some(9)],
            [Some(u64::MAX - 1), Some(3)],
        ];
        for slots in cases {
            let (target, generation) = next_write(slots);
            let newest = read_order(slots).first().copied();
            assert_ne!(
                Some(target),
                newest,
                "write to {target:?} would overwrite the newest copy for {slots:?}"
            );
            let highest = slots.iter().flatten().copied().max().unwrap_or(0);
            assert_eq!(
                generation,
                highest + 1,
                "the new copy must outrank every existing one for {slots:?}"
            );
        }
    }

    #[test]
    fn alternating_writes_ping_pong_forever() {
        // Simulate 20 successive writes and assert the slot alternates and the
        // generation climbs — the shape a long-lived vault actually produces.
        let mut slots: [Option<u64>; 2] = [None, None];
        let mut previous_target = None;
        for step in 0..20 {
            let (target, generation) = next_write(slots);
            if let Some(prev) = previous_target {
                assert_ne!(target, prev, "step {step} wrote the same slot twice");
            }
            slots[target] = Some(generation);
            previous_target = Some(target);
            assert_eq!(
                read_order(slots)[0],
                target,
                "the write just made is newest"
            );
        }
    }

    #[test]
    fn read_order_is_newest_first_and_drops_unreadable_slots() {
        assert_eq!(read_order([None, None]), Vec::<usize>::new());
        assert_eq!(read_order([Some(4), None]), vec![0]);
        assert_eq!(read_order([None, Some(4)]), vec![1]);
        assert_eq!(read_order([Some(4), Some(5)]), vec![1, 0]);
        assert_eq!(read_order([Some(5), Some(4)]), vec![0, 1]);
    }

    #[test]
    fn a_torn_newest_still_leaves_the_older_copy_reachable() {
        // The recovery path in miniature. Slot 1 is newer but its payload did not
        // survive; the caller's AEAD check rejects it and moves to the next
        // entry, which is the previous complete vault file.
        let order = read_order([Some(4), Some(5)]);
        assert_eq!(order, vec![1, 0]);
        assert_eq!(
            order.len(),
            2,
            "a reader that stopped at the newest would report a corrupt vault \
             while an intact copy sat beside it"
        );
    }

    #[test]
    fn slot_paths_are_distinct_and_suffix_the_base() {
        assert_eq!(slot_path("vault.prefs", 0), "vault.prefs.a");
        assert_eq!(slot_path("vault.prefs", 1), "vault.prefs.b");
        assert_ne!(slot_path("vault.meta", 0), slot_path("vault.meta", 1));
    }

    #[test]
    #[should_panic(expected = "generation 0 is reserved")]
    fn framing_generation_zero_panics_rather_than_writing_an_ignored_file() {
        frame(0, b"anything");
    }

    /// Every §10.3 singleton family the web client can write is double-buffered.
    ///
    /// The allowlist's failure mode is a *new* family silently losing crash
    /// protection, so the families are named here rather than derived from the
    /// list itself — a test that reads its subject from its subject asserts
    /// nothing.
    #[test]
    fn every_known_singleton_is_double_buffered() {
        for name in [
            "vault.meta",
            "vault.prefs",
            "vault.search",
            "vault.workspace",
            "vault.indices",
            "vault.attachments",
            "vault.dictionary",
            "vault.themes",
            "vault.graph",
            "vault.embeddings",
            "vault.quickunlock",
            "vault.head-state",
            "vault.meta-dirty",
            "sync-state.json",
            "sync-config.json",
            "pending-tombstones",
            // Task 86 found this one missing. It is the attachment twin of
            // `pending-tombstones` — read-modify-written on the same schedule —
            // and a torn one loses the deletion INTENT, so the server never
            // reclaims the body (`sync-protocol.md` §11.4).
            "pending-attachment-tombstones",
        ] {
            assert!(
                mode_for(&format!("/myne/vaults/019f/{name}")) == Mode::Doubled,
                "{name} is a singleton and would lose crash protection"
            );
        }
    }

    /// Per-item files must NOT be **doubled**: they can be arbitrarily large
    /// (a `.myn` caps at 16 MiB), so keeping both copies would double a vault's
    /// whole storage footprint. `SingleLive` gives them the crash property
    /// without the cost — and their directories being enumerated is fine,
    /// because the OPFS `read_dir` arm maps slot suffixes back to base names.
    #[test]
    fn per_item_files_are_never_doubled() {
        for (path, expected) in [
            // A note IS container-backed — it needs the same crash property —
            // but single-live, so a vault of 16 MiB notes does not double.
            ("/myne/vaults/019f/notes/019f-aaaa.myn", Mode::SingleLive),
            // Everything else is a plain file: attachments and the device-local
            // queues are written once and not rewritten in place.
            ("/myne/vaults/019f/attachments/deadbeef", Mode::Plain),
            ("/myne/vaults/019f/attachments-text/deadbeef", Mode::Plain),
            ("/myne/captures/019f", Mode::Plain),
            ("/myne/pending-shares/sealed/019f", Mode::Plain),
            // The two staging trees are SingleLive since task 86 — they are
            // exactly the "write-once directory entries" that task names, and
            // the earlier `Plain` reasoning ("a container write would rewrite a
            // file the conflict UI is holding") was about the DOUBLED mode's
            // live-slot rewrite. `SingleLive` writes the slot that is not live
            // and retires the old name afterwards, which is the discipline
            // `stage_conflict` and `quarantine_note` already follow themselves.
            //
            // Safe to enumerate, which is the property that makes this work at
            // all: the OPFS `read_dir` arm maps slot suffixes back to base names
            // and de-duplicates, so `list_pending_conflicts` and the quarantine
            // listing still see `<id>.myn`, not `<id>.myn.a`.
            (
                "/myne/vaults/019f/conflicts/019f-aaaa.myn",
                Mode::SingleLive,
            ),
            (
                "/myne/vaults/019f/conflicts/019f-aaaa.meta",
                Mode::SingleLive,
            ),
            (
                "/myne/vaults/019f/quarantine/019f-aaaa.myn",
                Mode::SingleLive,
            ),
            (
                "/myne/vaults/019f/quarantine/019f-aaaa-1.myn",
                Mode::SingleLive,
            ),
            // A non-blob dropped into a staging tree is still plain — the
            // extension check is what keeps this from claiming stray files.
            ("/myne/vaults/019f/conflicts/README.txt", Mode::Plain),
            // The tab lock is the Web Locks API on this client, not a file.
            ("/myne/vaults/019f/vault.lock", Mode::Plain),
        ] {
            assert_eq!(
                mode_for(path),
                expected,
                "{path} has the wrong storage mode"
            );
        }
    }

    #[test]
    fn slot_suffixes_map_back_to_their_base_name() {
        assert_eq!(strip_slot_suffix("019f-aaaa.myn.a"), Some("019f-aaaa.myn"));
        assert_eq!(strip_slot_suffix("019f-aaaa.myn.b"), Some("019f-aaaa.myn"));
        // Not a slot: a caller must be able to tell "already a base name" from
        // "a slot", because `read_dir` sees both during a save.
        assert_eq!(strip_slot_suffix("019f-aaaa.myn"), None);
        assert_eq!(strip_slot_suffix("vault.prefs"), None);
    }

    #[test]
    fn the_decision_is_made_on_the_file_name_not_the_directory_depth() {
        assert_eq!(mode_for("vault.prefs"), Mode::Doubled);
        assert_eq!(mode_for("/a/b/c/d/vault.prefs"), Mode::Doubled);
        // A directory *named* like a singleton is not one; only the last segment
        // is consulted, so a file inside it is judged on its own name.
        assert_eq!(mode_for("/myne/vault.prefs/inner"), Mode::Plain);
    }
}
