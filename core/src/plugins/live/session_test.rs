// SPDX-License-Identifier: AGPL-3.0
//! Integration tests for the live-session core (`collab-editor-bridge` task 2).

use super::session::LiveSession;
use super::state::LiveSessionRegistry;
use crate::host::test_host::TestHost;
use crate::plugins::notes::crdt::{decode_note_blob, encode_note_blob};
use crate::test_support::{block_on, ScopedTempDir};
use crate::vault_io::{StdVaultIo, VaultIo as _};

const IO: StdVaultIo = StdVaultIo;

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `collab-verification` D7: the single-writer refusal covers the OTHER two write
/// paths, not only `note_update`. A note a live session owns is refused by the
/// rename/move BATCH writer and by the snapshot RESTORE, so neither writes behind
/// the session. Both guards run before any vault work, so a default (locked) state
/// is enough to reach them.
#[test]
fn a_live_note_is_refused_by_the_batch_writer_and_the_restore() {
    block_on(async {
        use zeroize::Zeroizing;
        let host = TestHost::new("/base");
        let (ik, ikid) = ([0x11u8; 32], [0x22u8; 16]);
        // A real UUIDv7: `NoteId::parse` is version-strict, so a repeated-nibble
        // fixture is refused as `InvalidNoteId` before the guard is reached.
        let uuid = *crate::plugins::notes::note_id::NoteId::new_v7()
            .as_uuid()
            .as_bytes();
        let base = encode_note_blob(
            "---\nupdated: 2026-08-11T09:00:00Z\n---\nbody\n",
            &ik,
            &ikid,
            &uuid,
            &[0xAAu8; 16],
            &host,
        )
        .expect("seal");
        let tmp = ScopedTempDir::new("live-refusal-paths").unwrap();
        let notes_dir = tmp.path().join("notes");
        IO.create_dir_all(&notes_dir).await.expect("mkdir");
        let note_id = uuid::Uuid::from_bytes(uuid).to_string();
        let session =
            LiveSession::open_from_blob(&base, "v".into(), note_id.clone(), uuid, None, &ik, &ikid)
                .expect("open");
        let reg = LiveSessionRegistry::new();
        assert!(reg.insert(session), "the session is now open for the note");
        let state = crate::plugins::vault_unlock::state::VaultRuntimeState::default();

        let items: Vec<(String, Zeroizing<String>)> = vec![(
            note_id.clone(),
            Zeroizing::new("---\nupdated: 2026-08-11T09:00:00Z\n---\nRENAMED\n".into()),
        )];
        let batch = crate::plugins::notes::commands::note_write_batch_with_dir(
            &IO,
            notes_dir.clone(),
            &state,
            &items,
            0,
            &reg,
        )
        .await;
        assert!(
            matches!(
                batch,
                Err(crate::plugins::notes::error::NoteBatchError::LiveSessionOpen)
            ),
            "the batch writer must refuse a live note, got {batch:?}"
        );

        let hooks: crate::hooks::Hooks = std::sync::Arc::new(crate::hooks::NoopHooks);
        let restored = crate::plugins::snapshots::commands::snapshot_restore_in(
            notes_dir.clone(),
            &state,
            &hooks,
            note_id.clone(),
            "bogus-snapshot".into(),
            &IO,
            &host,
            Some(&reg),
        )
        .await;
        assert!(
            matches!(
                restored,
                Err(crate::plugins::snapshots::error::SnapshotError::LiveSessionOpen)
            ),
            "the snapshot restore must refuse a live note, got {restored:?}"
        );
    });
}

/// A session opens from an existing `NC05` blob, its edit persists through
/// `flush` as a valid `NC05` blob carrying the edit, and the revision is authored
/// under THIS device's actor (`SYNC-42`), not the creating device's.
#[test]
fn a_session_opens_edits_and_flushes_under_the_device_actor() {
    block_on(async {
        let host = TestHost::new("/base");
        let (ik, ikid, uuid) = ([0x11u8; 32], [0x22u8; 16], [0x33u8; 16]);
        const DEVICE_A: [u8; 16] = [0xAAu8; 16];
        const DEVICE_B: [u8; 16] = [0xBBu8; 16];
        let base = encode_note_blob("# Title\n\nfirst.\n", &ik, &ikid, &uuid, &DEVICE_A, &host)
            .expect("seal base");

        let tmp = ScopedTempDir::new("live-session").unwrap();
        let notes_dir = tmp.path().join("notes");
        IO.create_dir_all(&notes_dir).await.expect("mkdir");

        let mut session = LiveSession::open_from_blob(
            &base,
            "vault-1".into(),
            "note-1".into(),
            uuid,
            Some(DEVICE_B),
            &ik,
            &ikid,
        )
        .expect("open");
        assert!(!session.is_dirty(), "a freshly opened session matches disk");

        session
            .apply_body_markdown("# Title\n\nfirst.\nsecond.\n", 5_000)
            .expect("edit");
        assert!(session.is_dirty(), "an edit is dirty");

        session
            .flush(&IO, &notes_dir, &ik, &ikid)
            .await
            .expect("flush");
        assert!(!session.is_dirty(), "flush records the heads durable");

        // The durable file is a valid NC05 blob carrying the edit.
        let on_disk = IO.read(&notes_dir.join("note-1.myn")).await.expect("read");
        assert_eq!(on_disk[0..4], *protocol::NC05_MAGIC);
        assert_eq!(
            decode_note_blob(&on_disk, &uuid, &ik, &ikid).expect("decode"),
            "# Title\n\nfirst.\nsecond.\n"
        );

        // The edit is authored under device B, not A.
        let hist = crate::plugins::notes::crdt::crdt_note_history(&on_disk, &uuid, &ik, &ikid)
            .expect("history");
        assert_eq!(hist[0].actor_hex, hex_lower(&DEVICE_A));
        assert_eq!(
            hist.last().unwrap().actor_hex,
            hex_lower(&DEVICE_B),
            "the session edit is authored under the session device"
        );
    });
}

/// The registry attaches rather than duplicating: a second open for the same
/// `(vault, note)` is refused and the existing session is reused (`SYNC-34`).
#[test]
fn the_registry_attaches_instead_of_opening_a_second_session() {
    block_on(async {
        let host = TestHost::new("/base");
        let (ik, ikid, uuid) = ([0x11u8; 32], [0x22u8; 16], [0x33u8; 16]);
        let base = encode_note_blob("body", &ik, &ikid, &uuid, &[0xAAu8; 16], &host).expect("seal");
        let reg = LiveSessionRegistry::new();

        let mk = || {
            LiveSession::open_from_blob(
                &base,
                "vault-1".into(),
                "note-1".into(),
                uuid,
                None,
                &ik,
                &ikid,
            )
            .expect("open")
        };
        assert!(reg.insert(mk()), "first open inserts");
        assert!(!reg.insert(mk()), "second open for the same key is refused");
        assert_eq!(reg.len(), 1, "exactly one session for the key");
        assert!(reg.is_open("vault-1", "note-1"));

        // The one session is reachable by its key and takes an edit.
        reg.with_session_mut("vault-1", "note-1", |s| {
            s.apply_body_markdown("body edited", 1).expect("edit")
        })
        .expect("session present");
        assert!(reg
            .with_session_mut("vault-1", "note-1", |s| s.is_dirty())
            .expect("present"));

        assert!(reg.remove("vault-1", "note-1").is_some());
        assert!(reg.is_empty(), "remove leaves nothing");
    });
}

/// The command inners return their typed errors before any vault work: apply and
/// close on a note with no session are `NotOpen`; a malformed note id is
/// `InvalidNoteId`. This is the IPC-round-trip's error half without a Tauri
/// runtime (the success half is [`a_session_opens_edits_and_flushes_under_the_device_actor`]).
#[test]
fn live_command_inners_return_typed_errors() {
    use crate::plugins::live::commands::{
        live_session_close_from_host, live_session_open_from_host,
        live_session_patch_frontmatter_from_host, LiveSessionCommandError,
    };
    block_on(async {
        let host = TestHost::new("/base");
        let state = crate::plugins::vault_unlock::state::VaultRuntimeState::default();
        let reg = LiveSessionRegistry::new();
        let id = crate::plugins::notes::note_id::NoteId::new_v7().to_string();

        assert!(matches!(
            live_session_patch_frontmatter_from_host(
                &host,
                &state,
                &reg,
                &IO,
                id.clone(),
                String::new()
            )
            .await,
            Err(LiveSessionCommandError::NotOpen)
        ));
        assert!(matches!(
            live_session_close_from_host(&host, &state, &reg, &IO, id).await,
            Err(LiveSessionCommandError::NotOpen)
        ));
        assert!(matches!(
            live_session_open_from_host(&host, &state, &reg, &IO, "not-a-uuid".into()).await,
            Err(LiveSessionCommandError::InvalidNoteId)
        ));
    });
}

/// §6 C1: a local splice through the session round-trips byte-exact, apply,
/// flush, decode the durable `NC05` blob, and the markdown equals the expected
/// text (the bridge forwards text verbatim; it never normalizes or reconstructs).
#[test]
fn a_local_splice_round_trips_the_markdown_byte_exact() {
    use crate::plugins::live::apply_local::LocalSplice;
    block_on(async {
        let host = TestHost::new("/base");
        let (ik, ikid, uuid) = ([0x11u8; 32], [0x22u8; 16], [0x33u8; 16]);
        let base =
            encode_note_blob("body line\n", &ik, &ikid, &uuid, &[0xAAu8; 16], &host).expect("seal");
        let tmp = ScopedTempDir::new("live-c1").unwrap();
        let notes_dir = tmp.path().join("notes");
        IO.create_dir_all(&notes_dir).await.expect("mkdir");

        let mut session =
            LiveSession::open_from_blob(&base, "v".into(), "n".into(), uuid, None, &ik, &ikid)
                .expect("open");
        // Insert "more " before "body" (UTF-16 offset 0..0) and change "line"->"lines".
        session
            .apply_splices(
                &[
                    LocalSplice {
                        from: 0,
                        to: 0,
                        insert: "more ".into(),
                    },
                    LocalSplice {
                        from: 5,
                        to: 9,
                        insert: "lines".into(),
                    },
                ],
                1,
            )
            .expect("splice");
        session
            .flush(&IO, &notes_dir, &ik, &ikid)
            .await
            .expect("flush");

        let on_disk = IO.read(&notes_dir.join("n.myn")).await.expect("read");
        assert_eq!(
            decode_note_blob(&on_disk, &uuid, &ik, &ikid).expect("decode"),
            "more body lines\n"
        );
    });
}

/// While a live session owns a note, a stateless `note_update` is refused with
/// the typed `LiveSessionOpen` before any work, the single-writer invariant
/// (`SYNC-33`). The refusal fires before `notes_dir` resolution, so it needs no
/// vault; only the registry matters.
#[test]
fn note_update_is_refused_while_a_live_session_owns_the_note() {
    block_on(async {
        let host = TestHost::new("/base");
        let (ik, ikid, uuid) = ([0x11u8; 32], [0x22u8; 16], [0x33u8; 16]);
        let base = encode_note_blob("body", &ik, &ikid, &uuid, &[0xAAu8; 16], &host).expect("seal");
        let reg = LiveSessionRegistry::new();
        assert!(reg.insert(
            LiveSession::open_from_blob(
                &base,
                "vault-1".into(),
                "note-1".into(),
                uuid,
                None,
                &ik,
                &ikid,
            )
            .expect("open")
        ));

        let state = crate::plugins::vault_unlock::state::VaultRuntimeState::default();
        let hooks = std::sync::Arc::new(crate::hooks::NoopHooks) as crate::hooks::Hooks;
        let result = crate::plugins::notes::commands::note_update_from_host(
            &host,
            &state,
            &hooks,
            "note-1".to_string(),
            "new body".to_string(),
            None,
            &IO,
            &reg,
        )
        .await;
        assert!(
            matches!(
                result,
                Err(crate::plugins::notes::error::NoteUpdateError::LiveSessionOpen)
            ),
            "a live-owned note must refuse note_update, got {result:?}"
        );

        // A note with no session is not refused by this check (it falls through to
        // the ordinary path, which here fails earlier on the absent vault).
        let free = crate::plugins::notes::commands::note_update_from_host(
            &host,
            &state,
            &hooks,
            "note-2".to_string(),
            "new body".to_string(),
            None,
            &IO,
            &reg,
        )
        .await;
        assert!(
            !matches!(
                free,
                Err(crate::plugins::notes::error::NoteUpdateError::LiveSessionOpen)
            ),
            "a note with no live session must not be refused as live-open"
        );
    });
}

/// `clear` (the teardown) drops every session, so no decrypted session survives
/// a vault-leaving hook.
#[test]
fn clear_drops_every_open_session() {
    block_on(async {
        let host = TestHost::new("/base");
        let (ik, ikid, uuid) = ([0x11u8; 32], [0x22u8; 16], [0x33u8; 16]);
        let base = encode_note_blob("body", &ik, &ikid, &uuid, &[0xAAu8; 16], &host).expect("seal");
        let reg = LiveSessionRegistry::new();
        for note in ["note-1", "note-2"] {
            assert!(reg.insert(
                LiveSession::open_from_blob(
                    &base,
                    "vault-1".into(),
                    note.into(),
                    uuid,
                    None,
                    &ik,
                    &ikid,
                )
                .expect("open")
            ));
        }
        assert_eq!(reg.len(), 2);
        reg.clear();
        assert!(reg.is_empty(), "teardown drops every session");
    });
}

/// Task 7: a session opening on a note that carries an `updated:` stamp records it
/// as the running maximum, and a body edit keeps it, the value the durable
/// boundary will write so both devices converge.
#[test]
fn the_session_observes_the_updated_stamp() {
    let host = TestHost::new("/base");
    let (ik, ikid, uuid) = ([0x11u8; 32], [0x22u8; 16], [0x33u8; 16]);
    const NOTE: &str = "---\nupdated: 2026-08-11T09:00:00Z\n---\nX\n";
    let base = encode_note_blob(NOTE, &ik, &ikid, &uuid, &[0xAAu8; 16], &host).expect("seal");
    let mut session =
        LiveSession::open_from_blob(&base, "v".into(), "n".into(), uuid, None, &ik, &ikid)
            .expect("open");

    assert_eq!(session.durable_updated(), Some("2026-08-11T09:00:00Z"));
    // Body starts at 38; a body-only edit must not lower the observed stamp.
    session
        .apply_splices(
            &[crate::plugins::live::apply_local::LocalSplice {
                from: 38,
                to: 38,
                insert: "Y".into(),
            }],
            1,
        )
        .expect("apply");
    assert_eq!(session.durable_updated(), Some("2026-08-11T09:00:00Z"));
}

/// Task 7: the durable boundary stamps the MAX-OBSERVED `updated:`, not whatever
/// the incoming markdown carried, an earlier incoming stamp does not lower it.
#[test]
fn the_durable_boundary_stamps_the_max_observed_updated() {
    block_on(async {
        let host = TestHost::new("/base");
        let (ik, ikid, uuid) = ([0x11u8; 32], [0x22u8; 16], [0x33u8; 16]);
        let base = encode_note_blob(
            "---\nupdated: 2026-08-11T09:00:00Z\n---\nbody\n",
            &ik,
            &ikid,
            &uuid,
            &[0xAAu8; 16],
            &host,
        )
        .expect("seal");
        let tmp = ScopedTempDir::new("live-max-updated").unwrap();
        let notes_dir = tmp.path().join("notes");
        IO.create_dir_all(&notes_dir).await.expect("mkdir");
        let mut session =
            LiveSession::open_from_blob(&base, "v".into(), "n".into(), uuid, None, &ik, &ikid)
                .expect("open");

        // An incoming patch carrying an EARLIER stamp must not lower the max.
        session
            .apply_body_markdown("---\nupdated: 2026-08-11T08:00:00Z\n---\nbody edited\n", 1)
            .expect("patch");
        session
            .flush(&IO, &notes_dir, &ik, &ikid)
            .await
            .expect("flush");
        let on_disk = IO.read(&notes_dir.join("n.myn")).await.expect("read");
        assert_eq!(
            decode_note_blob(&on_disk, &uuid, &ik, &ikid).expect("decode"),
            "---\nupdated: 2026-08-11T09:00:00Z\n---\nbody edited\n"
        );
        assert_eq!(session.durable_updated(), Some("2026-08-11T09:00:00Z"));
    });
}

/// The MAX-OBSERVED rule's OTHER direction (`collab-verification` D8): a LATER
/// incoming stamp must ADVANCE the maximum. The test above pins only the "an
/// earlier stamp does not lower it" half, and re-stamping the old maximum satisfies
/// that; this shape is what froze `updated:` at the blob's opening value on every
/// save, a persisted user-visible field.
#[test]
fn a_later_updated_stamp_advances_the_maximum() {
    block_on(async {
        let host = TestHost::new("/base");
        let (ik, ikid, uuid) = ([0x11u8; 32], [0x22u8; 16], [0x44u8; 16]);
        let base = encode_note_blob(
            "---\nupdated: 2026-08-11T09:00:00Z\n---\nbody\n",
            &ik,
            &ikid,
            &uuid,
            &[0xAAu8; 16],
            &host,
        )
        .expect("seal");
        let tmp = ScopedTempDir::new("live-max-updated-later").unwrap();
        let notes_dir = tmp.path().join("notes");
        IO.create_dir_all(&notes_dir).await.expect("mkdir");
        let mut session =
            LiveSession::open_from_blob(&base, "v".into(), "n".into(), uuid, None, &ik, &ikid)
                .expect("open");

        session
            .apply_body_markdown("---\nupdated: 2026-08-11T10:00:00Z\n---\nbody edited\n", 1)
            .expect("patch");
        session
            .flush(&IO, &notes_dir, &ik, &ikid)
            .await
            .expect("flush");
        let on_disk = IO.read(&notes_dir.join("n.myn")).await.expect("read");
        assert_eq!(
            decode_note_blob(&on_disk, &uuid, &ik, &ikid).expect("decode"),
            "---\nupdated: 2026-08-11T10:00:00Z\n---\nbody edited\n",
            "a later stamp must be persisted, not the frozen earlier maximum"
        );
        assert_eq!(session.durable_updated(), Some("2026-08-11T10:00:00Z"));
    });
}

/// `collab-editor-bridge` task 4, on the SHIPPED path: a local edit reaches the
/// session as the whole re-derived markdown (`apply_body_markdown`), and the CRDT
/// layer records the minimal change, not a whole-body replace. This is why the
/// client-side splice converter was removed: the property is enforced here, so it
/// is pinned here. A one-word edit's change must be far smaller than a
/// whole-body rewrite's.
#[test]
fn a_small_local_edit_records_a_minimal_change_not_a_whole_body_replace() {
    block_on(async {
        let host = TestHost::new("/base");
        let (ik, ikid, uuid) = ([0x11u8; 32], [0x22u8; 16], [0x77u8; 16]);
        let body: String = (0..40).map(|i| format!("line {i} of the body\n")).collect();
        let original = format!("---\nupdated: 2026-08-11T09:00:00Z\n---\n{body}");
        let base =
            encode_note_blob(&original, &ik, &ikid, &uuid, &[0xAAu8; 16], &host).expect("seal");
        let mut session =
            LiveSession::open_from_blob(&base, "v".into(), "n".into(), uuid, None, &ik, &ikid)
                .expect("open");
        // Drop anything the open itself captured, so the next change is the edit.
        let _ = session.take_outgoing_change();

        let edited = original.replacen("line 0", "LINE 0", 1);
        session.apply_body_markdown(&edited, 1).expect("edit");
        let small = session
            .take_outgoing_change()
            .expect("a local change is captured")
            .len();

        let replaced: String = (0..40)
            .map(|i| format!("ROW {i} replaced the body\n"))
            .collect();
        let whole = format!("---\nupdated: 2026-08-11T09:00:01Z\n---\n{replaced}");
        session.apply_body_markdown(&whole, 2).expect("rewrite");
        let big = session
            .take_outgoing_change()
            .expect("the rewrite change is captured")
            .len();

        assert!(
            small * 4 < big,
            "a one-word edit ({small} bytes) must be far smaller than a whole-body \
             rewrite ({big} bytes); a whole-body replace for a local edit would carry \
             the body again and be comparable"
        );
    });
}

/// Apply UTF-16-offset splices to a string (ASCII fixture: offsets == char
/// indices). Descending by `from` keeps earlier offsets valid.
fn apply_utf16(doc: &str, splices: &[crate::plugins::live::apply_local::LocalSplice]) -> String {
    let mut chars: Vec<char> = doc.chars().collect();
    let mut ordered = splices.to_vec();
    ordered.sort_by_key(|s| std::cmp::Reverse(s.from));
    for s in ordered {
        chars.splice(s.from..s.to, s.insert.chars());
    }
    chars.into_iter().collect()
}

/// Task 7 pull-on-poke: a pulled durable revision merges into the open session and
/// the returned body diff reconstructs the merged text.
#[test]
fn merge_pulled_merges_a_peer_revision_into_the_session() {
    block_on(async {
        let host = TestHost::new("/base");
        let (ik, ikid, uuid) = ([0x11u8; 32], [0x22u8; 16], [0x33u8; 16]);
        const BASE: &str = "---\ntitle: T\n---\nbase\n";
        const PEER: &str = "---\ntitle: T\n---\nbase\npeer\n";
        let base = encode_note_blob(BASE, &ik, &ikid, &uuid, &[0xAAu8; 16], &host).expect("seal");
        let mut session =
            LiveSession::open_from_blob(&base, "v".into(), "n".into(), uuid, None, &ik, &ikid)
                .expect("open");
        let peer = crate::plugins::notes::crdt::encode_note_edit(
            &base, PEER, None, &ik, &ikid, &uuid, &host,
        )
        .expect("peer edit");

        let splices = session.merge_pulled(&peer.blob, &ik, &ikid).expect("merge");
        assert_eq!(
            apply_utf16(BASE, &splices),
            PEER,
            "the diff reconstructs the merge"
        );

        let tmp = ScopedTempDir::new("live-merge-pulled").unwrap();
        let notes_dir = tmp.path().join("notes");
        IO.create_dir_all(&notes_dir).await.expect("mkdir");
        session
            .flush(&IO, &notes_dir, &ik, &ikid)
            .await
            .expect("flush");
        let on_disk = IO.read(&notes_dir.join("n.myn")).await.expect("read");
        assert_eq!(
            decode_note_blob(&on_disk, &uuid, &ik, &ikid).expect("decode"),
            PEER
        );
    });
}

/// Task 7, remove-wins: a pulled revision carrying the `deleted:` tombstone is
/// adopted VERBATIM, the live session does not resurrect the note by merging.
#[test]
fn merge_pulled_adopts_a_remote_tombstone_verbatim() {
    block_on(async {
        let host = TestHost::new("/base");
        let (ik, ikid, uuid) = ([0x11u8; 32], [0x22u8; 16], [0x33u8; 16]);
        const BASE: &str = "---\ntitle: T\n---\nbase\n";
        const DELETED: &str = "---\ntitle: T\ndeleted: 2026-08-11T09:00:00Z\n---\nbase\n";
        let base = encode_note_blob(BASE, &ik, &ikid, &uuid, &[0xAAu8; 16], &host).expect("seal");
        let mut session =
            LiveSession::open_from_blob(&base, "v".into(), "n".into(), uuid, None, &ik, &ikid)
                .expect("open");
        let peer = crate::plugins::notes::crdt::encode_note_edit(
            &base, DELETED, None, &ik, &ikid, &uuid, &host,
        )
        .expect("peer delete");

        let _ = session.merge_pulled(&peer.blob, &ik, &ikid).expect("merge");

        let tmp = ScopedTempDir::new("live-merge-tomb").unwrap();
        let notes_dir = tmp.path().join("notes");
        IO.create_dir_all(&notes_dir).await.expect("mkdir");
        session
            .flush(&IO, &notes_dir, &ik, &ikid)
            .await
            .expect("flush");
        let on_disk = IO.read(&notes_dir.join("n.myn")).await.expect("read");
        assert_eq!(
            decode_note_blob(&on_disk, &uuid, &ik, &ikid).expect("decode"),
            DELETED,
            "a tombstone is adopted verbatim"
        );
    });
}

/// Task 7: the pending-merge splice queue drains once and is dropped by teardown.
#[test]
fn pending_remote_splices_round_trip_and_clear() {
    let reg = LiveSessionRegistry::new();
    let s = || crate::plugins::live::apply_local::LocalSplice {
        from: 0,
        to: 0,
        insert: "x".into(),
    };
    reg.set_pending_splices("n1", vec![s()]);
    assert_eq!(reg.take_pending_splices("n1").len(), 1, "queued once");
    assert!(
        reg.take_pending_splices("n1").is_empty(),
        "draining empties the slot"
    );
    reg.set_pending_splices("n2", vec![s()]);
    reg.clear();
    assert!(
        reg.take_pending_splices("n2").is_empty(),
        "the vault-leaving teardown drops pending splices too"
    );
}
