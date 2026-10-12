// SPDX-License-Identifier: AGPL-3.0
//! Tests for client awareness frame routing (`collab-editor-bridge` task 7).

use super::awareness::{route_awareness_frame, AwarenessRoute};
use super::state::LiveSessionRegistry;
use protocol::awareness_frame::{seal_awareness_frame_raw, AwarenessPayload, FrameType};

const NOTE: [u8; 16] = [0x11u8; 16];

fn payload(change: Option<Vec<u8>>) -> AwarenessPayload {
    AwarenessPayload {
        frame_type: FrameType::Presence,
        note_id: NOTE,
        actor_id: [0x22u8; 16],
        seq: 1,
        cursor: Some(3),
        selection: None,
        label: Some("Peer".into()),
        change,
        ts: None,
    }
}

fn seal(key: &[u8; 32], room: &[u8; 16], acct: &[u8; 16], change: Option<Vec<u8>>) -> Vec<u8> {
    seal_awareness_frame_raw(key, room, &[0x01u8; 24], acct, None, &payload(change)).expect("seal")
}

/// A presence-only frame (no change) is returned WHOLE for the presence store.
#[test]
fn a_presence_frame_is_returned_for_the_store() {
    let reg = LiveSessionRegistry::new();
    let (key, room, acct) = ([0x33u8; 32], [0x44u8; 16], [0x55u8; 16]);
    let frame = seal(&key, &room, &acct, None);
    match route_awareness_frame(&reg, &key, &room, &NOTE, &acct, None, &frame).expect("route") {
        AwarenessRoute::Presence(p) => {
            assert_eq!(p.note_id, NOTE);
            assert_eq!(p.cursor, Some(3));
        }
        other => panic!("expected Presence, got {other:?}"),
    }
}

/// A change-bearing frame for a note with NO open session is a no-op, a peer in a
/// room this client is not editing. The durable blob plane reconciles it.
#[test]
fn a_change_frame_with_no_open_session_is_ignored() {
    let reg = LiveSessionRegistry::new();
    let (key, room, acct) = ([0x33u8; 32], [0x44u8; 16], [0x55u8; 16]);
    let frame = seal(&key, &room, &acct, Some(vec![0xDE, 0xAD, 0xBE, 0xEF]));
    assert_eq!(
        route_awareness_frame(&reg, &key, &room, &NOTE, &acct, None, &frame).expect("route"),
        AwarenessRoute::NoSession
    );
}

/// A tampered frame is refused as one non-distinguishing error, never a partial route.
#[test]
fn a_tampered_frame_is_refused() {
    let reg = LiveSessionRegistry::new();
    let (key, room, acct) = ([0x33u8; 32], [0x44u8; 16], [0x55u8; 16]);
    let mut frame = seal(&key, &room, &acct, Some(vec![0x01, 0x02]));
    let last = frame.len() - 1;
    frame[last] ^= 0xff;
    assert!(
        route_awareness_frame(&reg, &key, &room, &NOTE, &acct, None, &frame).is_err(),
        "a flipped ciphertext byte must refuse the frame"
    );
}

/// A frame sealed for a DIFFERENT room is refused (the cleartext header's room id
/// must match the subscriber's).
#[test]
fn a_frame_for_another_room_is_refused() {
    let reg = LiveSessionRegistry::new();
    let (key, room, acct) = ([0x33u8; 32], [0x44u8; 16], [0x55u8; 16]);
    let frame = seal(&key, &room, &acct, None);
    let other_room = [0x99u8; 16];
    assert!(route_awareness_frame(&reg, &key, &other_room, &NOTE, &acct, None, &frame).is_err());
}

/// `collab-verification` D4: the room id is a cleartext header equality check and is
/// NOT in the AAD, so the sealed payload's own `note_id` is reconciled against the
/// note whose room matched (the way every per-entry family reconciles an id it can
/// also derive). A frame sealed for room A carrying `note_id` B is refused rather
/// than routed as A. The second half proves the check is the discriminator: the same
/// frame routes once the caller's expected note matches the payload.
#[test]
fn a_frame_whose_payload_names_another_note_is_refused() {
    let reg = LiveSessionRegistry::new();
    let (key, room, acct) = ([0x33u8; 32], [0x44u8; 16], [0x55u8; 16]);
    let other_note = [0x77u8; 16];
    let mut p = payload(None);
    p.note_id = other_note;
    let frame =
        seal_awareness_frame_raw(&key, &room, &[0x01u8; 24], &acct, None, &p).expect("seal");
    assert!(
        route_awareness_frame(&reg, &key, &room, &NOTE, &acct, None, &frame).is_err(),
        "a payload naming a different note than its room must be refused"
    );
    assert!(matches!(
        route_awareness_frame(&reg, &key, &room, &other_note, &acct, None, &frame).expect("route"),
        AwarenessRoute::Presence(_)
    ));
}

use super::awareness::{
    route_incoming_frame, seal_local_frame, subscribed_rooms, AwarenessKeypair,
};
use super::session::LiveSession;
use crate::host::test_host::TestHost;
use crate::plugins::notes::crdt::encode_note_blob;
use zeroize::Zeroizing;

fn owner_keys() -> AwarenessKeypair {
    AwarenessKeypair::Owner(Zeroizing::new([0x77u8; 32]))
}

fn open_session(reg: &LiveSessionRegistry, uuid: [u8; 16]) {
    let host = TestHost::new("/base");
    let (ik, ikid) = ([0x11u8; 32], [0x22u8; 16]);
    let blob = encode_note_blob("body\n", &ik, &ikid, &uuid, &[0xAAu8; 16], &host).expect("seal");
    let note_id = uuid::Uuid::from_bytes(uuid).to_string();
    assert!(reg.insert(
        LiveSession::open_from_blob(&blob, "v".into(), note_id, uuid, None, &ik, &ikid)
            .expect("open")
    ));
}

/// Open a session under a KNOWN device actor, so the self-echo guard has something
/// to compare against (production always passes `note_actor_bytes`).
fn open_session_with_actor(reg: &LiveSessionRegistry, uuid: [u8; 16], actor: [u8; 16]) {
    let host = TestHost::new("/base");
    let (ik, ikid) = ([0x11u8; 32], [0x22u8; 16]);
    let blob = encode_note_blob("body\n", &ik, &ikid, &uuid, &[0xAAu8; 16], &host).expect("seal");
    let note_id = uuid::Uuid::from_bytes(uuid).to_string();
    assert!(reg.insert(
        LiveSession::open_from_blob(&blob, "v".into(), note_id, uuid, Some(actor), &ik, &ikid)
            .expect("open")
    ));
}

/// The header's room id is matched to the OPEN session's note, then the frame is
/// opened + routed (a presence frame comes back whole).
#[test]
fn route_incoming_frame_matches_the_open_notes_room() {
    let reg = LiveSessionRegistry::new();
    let uuid = [0xAAu8; 16];
    open_session(&reg, uuid);
    let keys = owner_keys();
    let acct = [0x55u8; 16];
    let frame = seal_local_frame(
        &keys,
        &uuid,
        [0xBBu8; 16],
        &acct,
        None,
        false,
        1,
        Some(5),
        None,
        None,
        None,
    )
    .expect("seal");
    match route_incoming_frame(&reg, &keys, &acct, None, &frame).expect("route") {
        AwarenessRoute::Presence(p) => {
            assert_eq!(p.note_id, uuid);
            assert_eq!(p.cursor, Some(5));
        }
        other => panic!("expected Presence, got {other:?}"),
    }
}

/// A frame for a room this client does not hold an open session for is ignored.
#[test]
fn route_incoming_frame_ignores_an_unopen_rooms_frame() {
    let reg = LiveSessionRegistry::new();
    open_session(&reg, [0xAAu8; 16]);
    let keys = owner_keys();
    let acct = [0x55u8; 16];
    let frame = seal_local_frame(
        &keys,
        &[0xCCu8; 16],
        [0xBBu8; 16],
        &acct,
        None,
        false,
        1,
        None,
        None,
        None,
        None,
    )
    .expect("seal");
    assert_eq!(
        route_incoming_frame(&reg, &keys, &acct, None, &frame).expect("route"),
        AwarenessRoute::NoRoom
    );
}

/// The subscription set covers every open session's room.
#[test]
fn subscribed_rooms_covers_every_open_session() {
    let reg = LiveSessionRegistry::new();
    let uuid = [0xAAu8; 16];
    open_session(&reg, uuid);
    let keys = owner_keys();
    assert_eq!(subscribed_rooms(&reg, &keys), vec![keys.room_id(&uuid)]);
}

/// `drain_and_route` applies only content changes; a presence frame counts zero.
#[test]
fn drain_and_route_skips_non_change_frames() {
    let reg = LiveSessionRegistry::new();
    let uuid = [0xAAu8; 16];
    open_session(&reg, uuid);
    let keys = owner_keys();
    let acct = [0x55u8; 16];
    let presence = seal_local_frame(
        &keys,
        &uuid,
        [0xBBu8; 16],
        &acct,
        None,
        false,
        1,
        Some(1),
        None,
        None,
        None,
    )
    .expect("seal");
    let drain = super::awareness::drain_and_route(&reg, &keys, &acct, None, &[presence], None);
    assert!(
        drain.changed.is_empty(),
        "a presence frame applies no content change"
    );
    assert_eq!(
        drain.presence.len(),
        1,
        "a presence frame is handed to the store"
    );
    assert_eq!(drain.presence[0].cursor, Some(1));
}

/// Task 7 (send half): a local edit on an open session is captured and sealed into
/// an awareness frame for the transport to POST, then drained (a second seal is a
/// no-op). The frame opens with the same key and carries the change.
#[test]
fn a_local_change_is_sealed_for_the_send_half() {
    let reg = LiveSessionRegistry::new();
    let uuid = [0xAAu8; 16];
    open_session(&reg, uuid);
    let keys = owner_keys();
    let acct = [0x55u8; 16];
    let note_id = uuid::Uuid::from_bytes(uuid).to_string();

    reg.with_note_mut(&note_id, |s| {
        s.apply_splices(
            &[crate::plugins::live::apply_local::LocalSplice {
                from: 0,
                to: 0,
                insert: "X".into(),
            }],
            1,
        )
    })
    .expect("session")
    .expect("apply");

    let sealed = super::awareness::seal_local_changes(&reg, &keys, &acct, None);
    assert_eq!(sealed.len(), 1, "one frame for the one pending change");
    let (room, frame) = &sealed[0];
    assert_eq!(*room, keys.room_id(&uuid));
    let opened = protocol::awareness_frame::open_awareness_frame(
        &keys.seal_key(),
        &keys.room_id(&uuid),
        &acct,
        None,
        frame,
    )
    .expect("open");
    assert!(
        opened.change.is_some(),
        "the sealed frame carries the local change"
    );
    assert!(
        super::awareness::seal_local_changes(&reg, &keys, &acct, None).is_empty(),
        "the change is taken, so a second seal is a no-op"
    );
}

/// `collab-presence-ui`: a local caret/selection on an open session is sealed into a
/// presence frame for the transport to POST, then drained. The freshly opened
/// session's first announcement is a Join (so peers re-announce, `SYNC-29`); a later
/// caret change announces again as a routine presence frame. The frame opens with the
/// same key and carries the positions and the label.
#[test]
fn a_local_presence_is_sealed_for_the_send_half() {
    let reg = LiveSessionRegistry::new();
    let uuid = [0xAAu8; 16];
    open_session(&reg, uuid);
    let keys = owner_keys();
    let acct = [0x55u8; 16];
    let note_id = uuid::Uuid::from_bytes(uuid).to_string();

    reg.with_note_mut(&note_id, |s| s.set_local_presence(Some(7), Some((7, 12))))
        .expect("session");

    let sealed = super::awareness::seal_local_presence(&reg, &keys, &acct, None, Some("Laptop"));
    assert_eq!(sealed.len(), 1, "one frame for the pending presence");
    let (room, frame) = &sealed[0];
    assert_eq!(*room, keys.room_id(&uuid));
    let opened = protocol::awareness_frame::open_awareness_frame(
        &keys.seal_key(),
        &keys.room_id(&uuid),
        &acct,
        None,
        frame,
    )
    .expect("open");
    assert_eq!(opened.cursor, Some(7));
    assert_eq!(opened.selection, Some((7, 12)));
    assert_eq!(opened.label.as_deref(), Some("Laptop"));

    // The join and the caret are both taken, so a second seal is a no-op.
    assert!(super::awareness::seal_local_presence(&reg, &keys, &acct, None, None).is_empty());

    // A later caret change announces again, now with no join and no selection.
    reg.with_note_mut(&note_id, |s| s.set_local_presence(Some(3), None))
        .expect("session");
    let again = super::awareness::seal_local_presence(&reg, &keys, &acct, None, None);
    assert_eq!(again.len(), 1);
    let opened = protocol::awareness_frame::open_awareness_frame(
        &keys.seal_key(),
        &keys.room_id(&uuid),
        &acct,
        None,
        &again[0].1,
    )
    .expect("open");
    assert_eq!(opened.cursor, Some(3));
    assert_eq!(opened.selection, None);
}

/// Story 18 self-echo guard (`collab-verification` task 1): the relay fans a frame
/// out to its publisher too, so a device receives its OWN presence frame back. It
/// must be dropped, so an editing device never renders a participant row for itself;
/// a frame from another actor is still a peer presence.
#[test]
fn a_devices_own_presence_frame_is_dropped_as_self_echo() {
    const LOCAL: [u8; 16] = [0xDDu8; 16];
    let reg = LiveSessionRegistry::new();
    let uuid = [0xAAu8; 16];
    open_session_with_actor(&reg, uuid, LOCAL);
    let keys = owner_keys();
    let acct = [0x55u8; 16];

    // A peer's frame (another actor) is a presence.
    let peer = seal_local_frame(
        &keys,
        &uuid,
        [0xBBu8; 16],
        &acct,
        None,
        false,
        0,
        Some(3),
        None,
        Some("Peer".into()),
        None,
    )
    .expect("seal peer");
    assert!(matches!(
        route_incoming_frame(&reg, &keys, &acct, None, &peer),
        Ok(AwarenessRoute::Presence(_))
    ));

    // Our OWN actor's frame is dropped as self-echo.
    let echo = seal_local_frame(
        &keys,
        &uuid,
        LOCAL,
        &acct,
        None,
        false,
        0,
        Some(3),
        None,
        None,
        None,
    )
    .expect("seal echo");
    assert!(matches!(
        route_incoming_frame(&reg, &keys, &acct, None, &echo),
        Ok(AwarenessRoute::SelfEcho)
    ));
}

/// `collab-b2b-sessions` task 2: the awareness room/tier selection. Both the OWNER
/// and a MEMBER of one `NTV6` vault hold the SAME `group_key`, so `AwarenessKeypair`
/// built from that key derives an identical room id and seal key for the same note;
/// a single-user (`NTV5`) session keeps a ROOT-derived room, distinct from the group
/// tier. The ROOM ID is a 16-byte identifier derivation, never a truncated key.
#[test]
fn the_awareness_room_is_group_within_one_tier_and_root_for_a_single_user() {
    use protocol::GroupKey;
    let note = [0xAAu8; 16];

    // Two sides of one NTV6 vault build the keypair from the same shared key.
    let owner = AwarenessKeypair::Group(GroupKey::new([0x5Au8; 32]));
    let member = AwarenessKeypair::Group(GroupKey::new([0x5Au8; 32]));
    assert_eq!(owner.room_id(&note), member.room_id(&note));
    assert_eq!(*owner.seal_key(), *member.seal_key());

    // The room id is an identifier (16 bytes) and is DISTINCT from the 32-byte key.
    assert_eq!(owner.room_id(&note).len(), 16);
    assert_ne!(
        owner.room_id(&note).as_slice(),
        owner.seal_key().as_slice(),
        "the room id must be a derivation, not a truncation of the key"
    );

    // A single-user (`NTV5`) session derives from its `root_key`, and a different
    // key derives a different room. The SLOT picks the tier (`shared_singleton_key`):
    // an `NTV6` owner and a member both hold the group key there.
    let root = AwarenessKeypair::Owner(Zeroizing::new([0x11u8; 32]));
    assert_ne!(root.room_id(&note), owner.room_id(&note));
}

/// `collab-b2b-sessions` task 4: a frame sealed under a DIFFERENT (retired or newer)
/// epoch is refused, because the epoch is part of the frame AAD (`SYNC-21`). The
/// strictly-greater rotation rule therefore fails closed on the awareness path too.
#[test]
fn a_frame_sealed_under_a_different_epoch_is_refused() {
    use protocol::awareness_frame::seal_awareness_frame_raw;
    let reg = LiveSessionRegistry::new();
    let (key, room, acct) = ([0x33u8; 32], [0x44u8; 16], [0x55u8; 16]);
    let frame =
        seal_awareness_frame_raw(&key, &room, &[0x01u8; 24], &acct, Some(1), &payload(None))
            .expect("seal");
    // Same epoch opens.
    assert!(route_awareness_frame(&reg, &key, &room, &NOTE, &acct, Some(1), &frame).is_ok());
    // A retired (lower) or a newer epoch does not, and neither does a missing epoch.
    assert!(route_awareness_frame(&reg, &key, &room, &NOTE, &acct, Some(2), &frame).is_err());
    assert!(route_awareness_frame(&reg, &key, &room, &NOTE, &acct, None, &frame).is_err());
}
