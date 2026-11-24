// SPDX-License-Identifier: AGPL-3.0-only
//! Client-side awareness frame routing (epic live-collab, `collab-editor-bridge`
//! task 7 and the base of `collab-presence-ui`).
//!
//! The transport (`collab-client-transport`) moves opaque sealed frames between a
//! note room's subscribers; this module is the CLIENT half: it opens a sealed frame
//! with the room key and routes what it carries. A frame that carries an Automerge
//! change (`AwarenessPayload.change`) is applied to the live session for its note
//! and the resulting body diff is queued for the pane
//! (`LiveSessionRegistry::pending_splices`); a presence-only frame is handed back so
//! the presence store can consume the cursor/selection.
//!
//! The caller derives the room key and id (`protocol::awareness_frame`): the owner
//! from `root_key` (`SubkeyRole::AwarenessKey` / `AwarenessRoomId`), a member from
//! the shared `group_key` (`GroupRole::…`). This module never derives them, so the
//! two client shapes share one routing path.

use super::state::LiveSessionRegistry;
// The ONE definition of "this actor names no device" (myne-md/myne#958), shared with
// `sync::identity_resolver` so the frame router and the version history cannot drift
// into two spellings of the same check.
use crate::plugins::sync::device_actor::actor_is_unset;
use protocol::awareness_frame::{
    awareness_room_id, awareness_room_id_group, open_awareness_frame, seal_awareness_frame,
    AwarenessFrameError, AwarenessPayload, FrameType, AWARENESS_ROOM_ID_LEN,
};
use protocol::{derive_group_subkey_v0_2, derive_subkey_v0_2, GroupKey, GroupRole, SubkeyRole};
use zeroize::Zeroizing;

/// What routing one inbound frame did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AwarenessRoute {
    /// The frame carried a content change that moved the open session's text for
    /// its note (the carried id); the body diff, if any survived the frontmatter
    /// clamp, is queued in the registry for the pane to dispatch. A
    /// frontmatter-only change lands here with nothing queued, so the pane still
    /// learns the note moved (myne-md/myne#849).
    ChangeApplied([u8; 16]),
    /// The frame carried presence only (cursor / selection / label), for the
    /// presence store. Returned whole so the caller keeps the payload.
    Presence(AwarenessPayload),
    /// The frame matched no open note's room (`collab-verification` task 3
    /// diagnostics): the peer is in a room this device is not editing.
    NoRoom,
    /// The frame is this device's OWN, fanned back by the relay (the self-echo
    /// guard), or it names no device at all (sixteen zero bytes, which cannot be a
    /// peer). Distinguished from [`Self::NoRoom`] so a peer leg that delivers
    /// nothing is not confused with one that delivers and is dropped.
    SelfEcho,
    /// The frame carried a change for a note with no open session, or one that
    /// did not move the session's text (a self-echo), a no-op (the durable blob
    /// plane reconciles it).
    NoSession,
    /// The frame arrived while NO note had an open session at all, so there was no
    /// room to match even in principle. Split from [`Self::NoRoom`] so a session that
    /// CLOSED around the frame is distinguishable from a derivation mismatch.
    NoOpenNote,
}

/// The vault-wide awareness material for a live-collab session. The SEAL KEY is one
/// per vault (owner- or group-derived); the ROOM ID is per note. Owner and member
/// derive the same room id for the same note, so they address one room.
pub enum AwarenessKeypair {
    /// Owner: derived from the vault `root_key`.
    Owner(Zeroizing<[u8; 32]>),
    /// Member: derived from the shared `group_key` of a B2B `NTV6` vault.
    Group(GroupKey),
}

impl AwarenessKeypair {
    /// The per-note room id both peers address.
    #[must_use]
    pub fn room_id(&self, note_uuid: &[u8; 16]) -> [u8; AWARENESS_ROOM_ID_LEN] {
        match self {
            Self::Owner(root) => awareness_room_id(root, note_uuid),
            Self::Group(group) => awareness_room_id_group(group, note_uuid),
        }
    }

    /// Whether this keypair derives through the `NTV6` GROUP tier rather than the
    /// owner root tier. Reported as a boolean in `sync_awareness_stats` (never key
    /// material) so a room that two devices derive differently can be traced to the
    /// tier rather than guessed at.
    #[must_use]
    pub fn is_group(&self) -> bool {
        matches!(self, Self::Group(_))
    }

    /// The frame seal key (one per vault).
    #[must_use]
    pub fn seal_key(&self) -> Zeroizing<[u8; 32]> {
        match self {
            Self::Owner(root) => derive_subkey_v0_2(root, SubkeyRole::AwarenessKey),
            Self::Group(group) => derive_group_subkey_v0_2(group, GroupRole::AwarenessKey),
        }
    }
}

/// The room ids a client must be subscribed to for its currently OPEN sessions.
/// The transport's `set_rooms` is driven from this on every open/close.
#[must_use]
pub fn subscribed_rooms(
    registry: &LiveSessionRegistry,
    keys: &AwarenessKeypair,
) -> Vec<[u8; AWARENESS_ROOM_ID_LEN]> {
    // SORTED, because the caller fingerprints this list to decide whether the SSE
    // stream must respawn (`stream_supervisor::rooms_fingerprint`). `live_note_blob_ids`
    // returns a `HashSet`, so an unsorted map reorders the rooms on every tick even
    // when the open-note set is unchanged: the fingerprint then changes, `decide`
    // returns `Teardown`, and the stream respawns roughly every tick once two or more
    // notes are open.
    let mut rooms: Vec<[u8; AWARENESS_ROOM_ID_LEN]> = registry
        .live_note_blob_ids()
        .into_iter()
        .map(|n| keys.room_id(&n))
        .collect();
    rooms.sort_unstable();
    rooms
}

/// Route one inbound frame by matching its cleartext room id to an OPEN session's
/// note. The frame carries the room id in its first 16 bytes, so the caller (the
/// transport consumer) does not need to know which note a frame is for.
pub fn route_incoming_frame(
    registry: &LiveSessionRegistry,
    keys: &AwarenessKeypair,
    account_number_hash: &[u8; 16],
    epoch: Option<u64>,
    frame: &[u8],
) -> Result<AwarenessRoute, AwarenessFrameError> {
    if frame.len() < AWARENESS_ROOM_ID_LEN {
        return Err(AwarenessFrameError::CannotDecrypt);
    }
    let header_room = &frame[..AWARENESS_ROOM_ID_LEN];
    let seal_key = keys.seal_key();
    let notes = registry.live_note_blob_ids();
    // No open session at all: there is no room to match even in principle. Distinct
    // from `NoRoom`, which means sessions existed and none of their rooms matched.
    if notes.is_empty() {
        return Ok(AwarenessRoute::NoOpenNote);
    }
    for note_uuid in notes {
        let room_id = keys.room_id(&note_uuid);
        if room_id.as_slice() == header_room {
            return route_awareness_frame(
                registry,
                &seal_key,
                &room_id,
                &note_uuid,
                account_number_hash,
                epoch,
                frame,
            );
        }
    }
    Ok(AwarenessRoute::NoRoom)
}

/// Seal one LOCAL frame for `note_uuid`'s room, the caller's cursor/selection/label
/// and/or an opaque Automerge `change`. Returns the bytes the transport POSTs.
/// `FrameType::Join` is used only when `join` is true (a room entry, which triggers
/// peers to re-announce); otherwise it is a routine presence frame.
#[allow(clippy::too_many_arguments)]
pub fn seal_local_frame(
    keys: &AwarenessKeypair,
    note_uuid: &[u8; 16],
    actor_id: [u8; 16],
    account_number_hash: &[u8; 16],
    epoch: Option<u64>,
    join: bool,
    seq: u64,
    cursor: Option<u32>,
    selection: Option<(u32, u32)>,
    label: Option<String>,
    change: Option<Vec<u8>>,
) -> Result<Vec<u8>, AwarenessFrameError> {
    let payload = AwarenessPayload {
        frame_type: if join {
            FrameType::Join
        } else {
            FrameType::Presence
        },
        note_id: *note_uuid,
        actor_id,
        seq,
        cursor,
        selection,
        label,
        change,
        ts: None,
    };
    let room_id = keys.room_id(note_uuid);
    let seal_key = keys.seal_key();
    seal_awareness_frame(&seal_key, &room_id, account_number_hash, epoch, &payload)
}

/// Seal every pending LOCAL change into an awareness frame, keyed by room id, for the
/// transport to POST (`collab-editor-bridge` task 7, the send half). Drains each open
/// session's pending local change; a session with none is skipped. The frame's
/// `actor_id` is the device actor (`SYNC-42`).
pub fn seal_local_changes(
    registry: &LiveSessionRegistry,
    keys: &AwarenessKeypair,
    account_number_hash: &[u8; 16],
    epoch: Option<u64>,
) -> Vec<([u8; AWARENESS_ROOM_ID_LEN], Vec<u8>)> {
    let mut out = Vec::new();
    for note_uuid in registry.live_note_blob_ids() {
        let note_id = uuid::Uuid::from_bytes(note_uuid).to_string();
        let taken = registry.with_note_mut(&note_id, |s| (s.take_outgoing_change(), s.actor_id()));
        let Some((Some(change), actor)) = taken else {
            continue;
        };
        let room_id = keys.room_id(&note_uuid);
        if let Ok(frame) = seal_local_frame(
            keys,
            &note_uuid,
            actor,
            account_number_hash,
            epoch,
            false,
            0,
            None,
            None,
            None,
            Some(change),
        ) {
            out.push((room_id, frame));
        }
    }
    out
}

/// Seal every pending LOCAL presence into an awareness frame, keyed by room id, for
/// the transport to POST (`collab-presence-ui`). Drains each open session's pending
/// caret/selection and its one-shot join flag; a session with neither is skipped.
/// The frame's `actor_id` is the device actor (`SYNC-42`).
///
/// `label` rides the wire and NO receiver acts on it: the receiving store discards a
/// frame-supplied name and resolves the peer's label from its own device-binding
/// store instead, so one device is named identically by the presence roster and the
/// version history (`member-devices` task 5). It is still sealed and serialized
/// because the field is in the frame's format; the only caller passes `None`.
/// Mirrors [`seal_local_changes`], which handles the content half.
pub fn seal_local_presence(
    registry: &LiveSessionRegistry,
    keys: &AwarenessKeypair,
    account_number_hash: &[u8; 16],
    epoch: Option<u64>,
    label: Option<&str>,
) -> Vec<([u8; AWARENESS_ROOM_ID_LEN], Vec<u8>)> {
    let mut out = Vec::new();
    for note_uuid in registry.live_note_blob_ids() {
        let note_id = uuid::Uuid::from_bytes(note_uuid).to_string();
        let taken = registry.with_note_mut(&note_id, |s| (s.take_local_presence(), s.actor_id()));
        let Some((Some(pending), actor)) = taken else {
            continue;
        };
        let room_id = keys.room_id(&note_uuid);
        if let Ok(frame) = seal_local_frame(
            keys,
            &note_uuid,
            actor,
            account_number_hash,
            epoch,
            pending.join,
            0,
            pending.cursor,
            pending.selection,
            label.map(str::to_string),
            None,
        ) {
            out.push((room_id, frame));
        }
    }
    out
}

/// A presence frame surfaced to the UI (`collab-presence-ui`): the fields the
/// awareness store needs, the note as a dashed UUID (the app's `NoteId` form) and the
/// actor as hex (the stable identity key). Serialized across the event seam.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwarenessPresence {
    pub note_id: String,
    pub actor_id: String,
    pub label: Option<String>,
    pub cursor: Option<u32>,
    pub selection: Option<AwarenessSelection>,
    pub frame_type: String,
}

/// A peer's selection span, as the presence store expects it: `{anchor, head}`.
///
/// NOT a positional tuple. A Rust `(u32, u32)` serializes to a JSON **array**
/// (`[a, b]`), while every consumer on the other side reads `.anchor` / `.head`:
/// the decoration builder took `undefined` for both, `Math.min` produced `NaN`, and
/// `Decoration.range(NaN, NaN)` threw inside the dispatch, so ONE peer reporting a
/// selection took down the WHOLE awareness decoration set (no caret, no roster
/// cursor) with no error surfacing anywhere.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AwarenessSelection {
    pub anchor: u32,
    pub head: u32,
}

impl AwarenessPresence {
    fn from_payload(p: &AwarenessPayload) -> Self {
        let actor_id = p.actor_id.iter().map(|x| format!("{x:02x}")).collect();
        Self {
            note_id: uuid::Uuid::from_bytes(p.note_id).to_string(),
            actor_id,
            label: p.label.clone(),
            cursor: p.cursor,
            selection: p
                .selection
                .map(|(anchor, head)| AwarenessSelection { anchor, head }),
            frame_type: match &p.frame_type {
                FrameType::Join => "join".to_string(),
                FrameType::Presence => "presence".to_string(),
            },
        }
    }
}

/// What one drain of inbound frames produced: the notes whose sessions took a
/// content change, and the presence frames for the awareness store.
#[derive(Debug, Default)]
pub struct AwarenessDrain {
    /// Notes (dashed UUIDs) whose session applied a carried change; the pane drains
    /// the merged splices for each.
    pub changed: Vec<String>,
    /// Presence frames for the store (`collab-presence-ui`).
    pub presence: Vec<AwarenessPresence>,
    /// Inbound frames whose ROOM matched no open note (`collab-verification` task 3
    /// diagnostics).
    pub no_room: u64,
    /// Inbound frames dropped as this device's own echo (the relay fans a frame out
    /// to its publisher too).
    pub self_echo: u64,
    /// Inbound frames carrying a change for a note with no open session.
    pub no_session: u64,
    /// Inbound frames that arrived while NO note had an open session at all.
    pub no_open_note: u64,
    /// Inbound frames whose header room equals THIS device's own last outgoing room but
    /// which matched no open session's derived room: the send path and the route path
    /// derived different rooms on the same device.
    pub out_room_missed: u64,
    /// Inbound frames that failed to OPEN (wrong key, wrong vault/epoch AAD, or
    /// tamper). The discriminator against the three above.
    pub open_failed: u64,
}

/// Route every buffered inbound frame (`collab-editor-bridge` task 7). The transport
/// consumer passes the frames it drained from `AwarenessSignal::take_incoming()`; each
/// is opened, a carried change is applied to its open session, and a presence-only
/// frame is handed back for the store. A frame that does not open is silently skipped
/// (a wrong-key / stale-epoch / tampered frame is a non-event for the consumer).
pub fn drain_and_route(
    registry: &LiveSessionRegistry,
    keys: &AwarenessKeypair,
    account_number_hash: &[u8; 16],
    epoch: Option<u64>,
    frames: &[Vec<u8>],
    own_last_out_room: Option<&[u8; AWARENESS_ROOM_ID_LEN]>,
) -> AwarenessDrain {
    let mut out = AwarenessDrain::default();
    for frame in frames {
        let routed = route_incoming_frame(registry, keys, account_number_hash, epoch, frame);
        if matches!(
            routed,
            Ok(AwarenessRoute::NoRoom) | Ok(AwarenessRoute::NoOpenNote)
        ) && frame.len() >= AWARENESS_ROOM_ID_LEN
            && own_last_out_room.is_some_and(|r| r.as_slice() == &frame[..AWARENESS_ROOM_ID_LEN])
        {
            out.out_room_missed += 1;
        }
        match routed {
            Ok(AwarenessRoute::ChangeApplied(id)) => {
                out.changed.push(uuid::Uuid::from_bytes(id).to_string());
            }
            Ok(AwarenessRoute::Presence(p)) => {
                out.presence.push(AwarenessPresence::from_payload(&p));
            }
            Ok(AwarenessRoute::NoRoom) => out.no_room += 1,
            Ok(AwarenessRoute::NoOpenNote) => out.no_open_note += 1,
            Ok(AwarenessRoute::SelfEcho) => out.self_echo += 1,
            Ok(AwarenessRoute::NoSession) => out.no_session += 1,
            Err(_) => out.open_failed += 1,
        }
    }
    out
}

/// Open one sealed `frame` under `room_key`/`room_id` and route it. A content change
/// is applied to the session for the frame's note and its body diff queued; a
/// presence frame is returned for the store. Every open failure is one
/// non-distinguishing [`AwarenessFrameError`].
///
/// `note_uuid` is the note whose room matched the frame's cleartext header. The
/// sealed payload's own `note_id` is reconciled against it after the open, the way
/// every per-entry family reconciles an id it can also derive: the room id is a
/// header-only equality check and is NOT in the AAD, so without this a frame sealed
/// for room A could carry `note_id` B and be routed as A. A mismatch is refused like
/// any other frame defect.
#[allow(clippy::too_many_arguments)]
pub fn route_awareness_frame(
    registry: &LiveSessionRegistry,
    room_key: &[u8; 32],
    room_id: &[u8; 16],
    note_uuid: &[u8; 16],
    account_number_hash: &[u8; 16],
    epoch: Option<u64>,
    frame: &[u8],
) -> Result<AwarenessRoute, AwarenessFrameError> {
    let payload = open_awareness_frame(room_key, room_id, account_number_hash, epoch, frame)?;
    if payload.note_id != *note_uuid {
        return Err(AwarenessFrameError::CannotDecrypt);
    }
    let Some(change) = payload.change else {
        // Self-echo guard (`collab-verification` story 18): the relay fans a frame
        // out to its publisher too, so this device receives its OWN presence frame
        // back. Two independent reasons drop it here, and neither may be removed in
        // favour of the other (myne-md/myne#958):
        //
        // 1. It names no device at all (sixteen zero bytes). That is what a client
        //    with no durable id used to seal, so it arrives from older releases, from
        //    the web client and from mobile as well as from here, and it cannot be
        //    compared against anything: a roster row keyed by it would be ONE row
        //    shared by every such device, and the resolver would render it as a
        //    device named `000000`.
        // 2. It names THIS device's actor, which is the ordinary echo.
        //
        // The identity-free half of the same problem (a frame this connection posted,
        // recognised by its own bytes rather than by an actor) lives in
        // `AwarenessSignal::push_incoming` and does not depend on either check.
        if actor_is_unset(&payload.actor_id) {
            return Ok(AwarenessRoute::SelfEcho);
        }
        let note_id = uuid::Uuid::from_bytes(payload.note_id).to_string();
        let is_echo = registry
            .with_note_mut(&note_id, |s| s.actor_id())
            .is_some_and(|local| local == payload.actor_id);
        if is_echo {
            return Ok(AwarenessRoute::SelfEcho);
        }
        return Ok(AwarenessRoute::Presence(payload));
    };
    // A frame carrying a change is a content delta. Route it into the open session
    // for the frame's note; a stale or unapplicable change is a no-op (the durable
    // blob plane reconciles it), never an error the caller must handle.
    let note_id = uuid::Uuid::from_bytes(payload.note_id).to_string();
    // The apply and the queue run under ONE hold of the registry's session lock
    // (`apply_and_queue`), so a sync-cycle merge into the same session cannot queue
    // its splices between this apply and this queue, which would compose the two
    // lists in the wrong coordinate order (myne-md/myne#849).
    let applied = registry.apply_and_queue(&note_id, |s| {
        s.apply_remote_change(&change)
            .map(|outcome| (outcome.splices, outcome.text_moved))
    });
    match applied {
        // The text moved, so the pane must hear of it even when no BODY splice
        // survived the clamp: a frontmatter-only change (a peer's rename, retag,
        // move or trash) has an empty splice list, and staying silent left the pane
        // holding the old frontmatter, which its next whole-markdown save wrote back
        // over the peer's change (myne-md/myne#849). An empty list leaves the queue
        // as it is, so the pane drains whatever body splices exist, possibly none.
        Some(Ok(true)) => Ok(AwarenessRoute::ChangeApplied(payload.note_id)),
        // The text did not move: most often THIS device's own change, echoed back
        // by the relay. That is not a remote edit the user must be told about, so
        // it is a no-op rather than `ChangeApplied`, which is what made an editing
        // device raise its own "updated from another device" notice
        // (`collab-verification`; myne-md/myne#857). No session, or a change the
        // document refuses, is a no-op too.
        Some(Ok(false)) | Some(Err(_)) | None => Ok(AwarenessRoute::NoSession),
    }
}
