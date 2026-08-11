// SPDX-License-Identifier: AGPL-3.0
//! Automerge document construction + commit seam for the `NC05` CRDT note-type
//! (`automerge-sync-migration` epic, myne-md/myne#417 task 2; ASM-3).
//!
//! Two thin helpers keep automerge's two host-touching defaults off Myne's
//! runtime, so the note format (#418) and the merge engine (#419) both inherit
//! one wiring pattern instead of each reaching for automerge's defaults:
//!
//! * **Actor identity is injected, never drawn from automerge's runtime RNG.**
//!   `AutoCommit::new()` seeds a *random* `ActorId` from automerge's own draw;
//!   [`new_note_doc`] overrides it with bytes the caller supplies from Myne's
//!   audited CSPRNG ([`fresh_actor_bytes`], the same `getrandom` source the AEAD
//!   nonces use). Taking the bytes as a parameter — rather than drawing them
//!   inside the helper — is what makes actor identity deterministically
//!   testable.
//!
//! * **Change timestamps come from the injected [`HostCtx`] clock, never the
//!   default `commit()`.** Routing the change time through
//!   [`HostCtx::now_unix_millis`] keeps the wall clock on the one seam the crate
//!   already uses for time (and off the `wasm32` `SystemTime` path the seam
//!   exists to avoid), and keeps that timestamp inside the note's AEAD by
//!   construction — it is committed into the CRDT document, which #418 seals
//!   whole. (automerge 0.10's production code never calls `SystemTime::now`, so
//!   this is provenance good-practice, not a panic fix — ASM-3, downgraded.)
//!
//! No document schema, note text, or persisted bytes are defined here: the
//! note↔`Text` mapping is #418 and the merge/CAS loop is #419. This is only the
//! construction/commit wiring both of them build on.

use crate::host::HostCtx;
use automerge::transaction::CommitOptions;
use automerge::{ActorId, AutoCommit, ChangeHash};

/// Actor-id width Myne draws for a fresh CRDT note document. 16 bytes matches
/// the `uuid`/`device_id` families the rest of the crate already mints and is
/// well within automerge's `ActorId` capacity.
pub const ACTOR_ID_LEN: usize = 16;

/// Build a fresh, empty Automerge document for a note, seeded with the
/// caller-supplied actor bytes — never automerge's runtime-random default.
///
/// Production callers pass bytes from [`fresh_actor_bytes`]; tests inject known
/// bytes and assert the resulting `ActorId` is exactly those bytes.
pub fn new_note_doc(actor: &[u8]) -> AutoCommit {
    AutoCommit::new().with_actor(ActorId::from(actor))
}

/// Draw a fresh actor id from Myne's audited CSPRNG (`getrandom`) — the same
/// entropy source the AEAD nonces use (`protocol::attachment_blob`,
/// `plugins::captures`, `plugins::quick_unlock`). Errors only if the OS/Worker
/// entropy source is unavailable, which every keyed operation already depends
/// on.
pub fn fresh_actor_bytes() -> Result<[u8; ACTOR_ID_LEN], getrandom::Error> {
    let mut bytes = [0u8; ACTOR_ID_LEN];
    getrandom::getrandom(&mut bytes)?;
    Ok(bytes)
}

/// Commit the document's open changes with an explicit timestamp taken from the
/// injected host clock, never automerge's default `commit()`.
///
/// `&dyn HostCtx` per the seam rule (never a generic parameter), so the helper
/// stays non-generic and portable. Returns the new change hash, or `None` if
/// there was nothing to commit.
pub fn commit_with_host_time(doc: &mut AutoCommit, host: &dyn HostCtx) -> Option<ChangeHash> {
    commit_at_millis(doc, host.now_unix_millis())
}

/// Commit with an explicit unix-millis timestamp the caller already read from the
/// host — the host-free entry [`commit_with_host_time`] delegates to.
///
/// It exists because two call paths cannot hold `&dyn HostCtx` at the commit
/// point: the note-update edit runs the automerge mutation inside
/// [`crate::task::run_blocking`] (a `'static` closure that cannot borrow the
/// host), and the whole-vault migration (#420) re-encodes a batch under one
/// clock read. Both pre-read `now_unix_millis()` and pass it here, keeping the
/// wall clock on the one seam without threading the borrow into a blocking body.
pub fn commit_at_millis(doc: &mut AutoCommit, now_millis: u64) -> Option<ChangeHash> {
    doc.commit_with(CommitOptions::default().with_time(now_millis as i64))
}

/// The document's current heads (change-hash frontier) as **sorted** lowercase
/// hex — the client-side convergence marker for an `NC05` note (ASM-5).
///
/// Sorted so the marker is canonical (head order is not significant). Unlike a
/// `content_nonce` (fresh-random per save) or the raw `save()` bytes
/// (non-deterministic re-serialization), heads are content-hashes of the change
/// set and are **stable** across save/load. That stability is exactly what makes
/// "current heads ≠ last-synced heads" a *terminating* dirty/converged test —
/// where `content_nonce` byte-equality would read perpetually-dirty and re-run
/// the §10.2.2 CAS ping-pong one layer down.
pub fn doc_heads_hex(doc: &mut AutoCommit) -> Vec<String> {
    let mut heads: Vec<String> = doc.get_heads().iter().map(|h| h.to_string()).collect();
    heads.sort();
    heads
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::test_host::TestHost;
    use automerge::transaction::Transactable;
    use automerge::{ObjType, ReadDoc, ROOT};

    #[test]
    fn actor_id_is_the_injected_bytes_not_random() {
        let actor = [0xABu8; ACTOR_ID_LEN];
        let doc = new_note_doc(&actor);
        // The doc's actor is exactly the injected bytes, not a random draw.
        assert_eq!(doc.get_actor().to_bytes(), &actor[..]);
        // Two docs built from the same bytes share an actor — proof it is the
        // injected value, not fresh randomness each time.
        let doc2 = new_note_doc(&actor);
        assert_eq!(doc.get_actor(), doc2.get_actor());
    }

    #[test]
    fn commit_carries_the_injected_host_clock_not_wall_time() {
        let host = TestHost::new("/base");
        host.set_now(1_234_567); // seconds; `now_unix_millis` scales ×1000
        let mut doc = new_note_doc(&[7u8; ACTOR_ID_LEN]);
        doc.put(ROOT, "k", "v").expect("put");
        let hash = commit_with_host_time(&mut doc, &host).expect("a change to commit");
        let change = doc.get_change_by_hash(&hash).expect("change present");
        // The change carries the injected clock (secs×1000), not a wall-clock now.
        assert_eq!(change.timestamp(), 1_234_567 * 1_000);
    }

    #[test]
    fn commit_with_nothing_to_commit_is_none() {
        let host = TestHost::new("/base");
        let mut doc = new_note_doc(&[1u8; ACTOR_ID_LEN]);
        assert!(commit_with_host_time(&mut doc, &host).is_none());
    }

    #[test]
    fn fresh_actor_bytes_are_the_right_width() {
        let bytes = fresh_actor_bytes().expect("csprng available");
        assert_eq!(bytes.len(), ACTOR_ID_LEN);
    }

    #[test]
    fn heads_are_a_stable_terminating_convergence_marker() {
        // The ASM-5 property: heads survive save/load unchanged (so a re-serialize
        // does NOT read dirty — the fix for the note-level §10.2.2 ping-pong),
        // while a genuine new edit advances them (so a real change DOES read dirty).
        let host = TestHost::new("/base");
        let mut a = new_note_doc(&[1u8; ACTOR_ID_LEN]);
        let t = a
            .put_object(ROOT, "body", ObjType::Text)
            .expect("put_object");
        a.splice_text(&t, 0, 0, "hello").expect("splice");
        commit_with_host_time(&mut a, &host);
        let heads = doc_heads_hex(&mut a);
        assert!(!heads.is_empty());

        // Stable across save/load — unlike a fresh content_nonce or the raw bytes.
        let mut reloaded = AutoCommit::load(&a.save()).expect("load");
        assert_eq!(
            doc_heads_hex(&mut reloaded),
            heads,
            "heads survive save/load"
        );

        // A genuine new edit advances the heads → the note reads dirty vs the marker.
        a.splice_text(&t, 5, 0, " world").expect("edit");
        commit_with_host_time(&mut a, &host);
        assert_ne!(
            doc_heads_hex(&mut a),
            heads,
            "a new edit advances the heads"
        );
    }

    /// Smoke-test the actual Automerge merge through the helper: two devices make
    /// concurrent edits to one `Text`, the merge converges (commutative +
    /// associative) and drops NEITHER edit (the §10.1 no-silent-loss property,
    /// delivered here by character interleave, not keep-both), and `save()` /
    /// `load()` round-trips the merged document.
    ///
    /// NOTE: this is a *host* `cargo test`. The `wasm32`-runtime variant that
    /// flushes the compile-green-then-panic dependency class (a dep-internal
    /// `std::fs`/`SystemTime::now`/`spawn_blocking`) must run under a real
    /// browser wasm engine via the `browser-vectors.sh` harness (chromedriver +
    /// `wasm-bindgen-test-runner`) — a CI step, exactly like `protocol`'s vector
    /// suite; it is not runnable in a bare dev shell. automerge 0.10 has zero
    /// production `SystemTime::now` (verified in the crate source), which already
    /// removes the primary panic in that class.
    #[test]
    fn concurrent_text_edits_merge_and_converge_without_dropping_either() {
        let host = TestHost::new("/base");

        // A note is created once and forked to a second device — `merge()` unions
        // shared-origin change-sets; two independently-created docs would not merge.
        let mut a = new_note_doc(&[0xA1u8; ACTOR_ID_LEN]);
        let body = a
            .put_object(ROOT, "body", ObjType::Text)
            .expect("put_object");
        a.splice_text(&body, 0, 0, "shared").expect("seed");
        commit_with_host_time(&mut a, &host);
        let mut b = a
            .fork()
            .with_actor(ActorId::from(&[0xB2u8; ACTOR_ID_LEN][..]));

        // Concurrent edits at the same position on both devices.
        a.splice_text(&body, 6, 0, "-A").expect("edit a");
        b.splice_text(&body, 6, 0, "-B").expect("edit b");
        commit_with_host_time(&mut a, &host);
        commit_with_host_time(&mut b, &host);

        // Commutative + associative: pulling each into the other converges.
        a.merge(&mut b).expect("merge b→a");
        b.merge(&mut a).expect("merge a→b");
        let ta = a.text(&body).expect("text a");
        let tb = b.text(&body).expect("text b");
        assert_eq!(ta, tb, "both devices converge to one value");

        // Neither edit is silently dropped (both survive the interleave).
        assert!(
            ta.contains("-A") && ta.contains("-B"),
            "both edits present: {ta}"
        );

        // `save()` / `load()` round-trips the merged document byte-faithfully.
        let bytes = a.save();
        let reloaded = AutoCommit::load(&bytes).expect("load");
        assert_eq!(reloaded.text(&body).expect("text reload"), ta);
    }
}
