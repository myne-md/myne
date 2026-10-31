// SPDX-License-Identifier: AGPL-3.0
//! One live co-editing session over an `NC05` note (epic live-collab,
//! `collab-editor-bridge` task 2).
//!
//! A [`LiveSession`] is the Rust-core meeting point between the CodeMirror
//! buffer and the authoritative Automerge document. It owns one [`AutoCommit`]
//! loaded from the durable `NC05` blob, seeded with this device's actor
//! (`SYNC-42`), and is the **single durable writer** for its note while open
//! (`SYNC-33`): the caller persists the session's own `save()` bytes re-sealed
//! as an `NC05` blob, and `note_update` for the note is refused.
//!
//! # What this type deliberately does NOT do
//!
//! No splicing from a CodeMirror transaction (the UTF-16 → Unicode-scalar
//! translation is `collab-editor-bridge` task 4), no remote-change application or
//! diff emission (task 5), no frontmatter clamp (task 6), and no live-channel
//! socket (owned by `collab-client-transport`). It holds the document, an
//! in-RAM copy of the note plaintext, and nothing else; the frame crypto and the
//! transport are other layers.
//!
//! # Zeroization, stated honestly
//!
//! The session holds decrypted note plaintext (the whole note is the `Text`).
//! Teardown DROPS it on every vault-leaving hook so it cannot survive a lock or
//! leak into the next vault, the `myne-md/myne#454` class. Automerge's
//! `AutoCommit` exposes no in-place zeroizing drop, so the bytes are freed, not
//! overwritten; that matches the pre-existing note-command behaviour (decrypted
//! plaintext is an ordinary `String`/`Vec<u8>` there too). What the teardown
//! guarantees is that nothing stays RESIDENT, which is the property that matters.

use std::path::Path;

use automerge::transaction::Transactable;
use automerge::{ActorId, AutoCommit, ReadDoc};

use crate::plugins::notes::crdt::CrdtNoteOpError;
use crate::plugins::sync::crdt_doc::{commit_at_millis, doc_heads_hex};
use crate::vault_io::{VaultIo, WriteOpts};
use protocol::{
    decode_crdt_note_blob, encode_crdt_note_blob, CannotDecryptCrdtNote, ProtocolError,
};

/// A sealed-but-unwritten durable blob, the heads it carries, and the body text
/// it was sealed from: `(blob, heads, markdown)`.
///
/// **The text travels WITH the blob, and that is the point of the third field.**
/// The flush feeds the live indexes the body it just wrote, and reading that body
/// in a second lock acquisition (which is what the flush used to do, after the
/// disk write) let another thread merge a change in between, so the indexed body
/// need not be the body that reached disk. Captured here, under the same
/// acquisition as the seal, the two cannot disagree.
///
/// The text is `None` when the document's body could not be read. The blob is
/// still written in that case, because refusing the flush would make the user's
/// edits impossible to persist, and the caller removes the note's search doc
/// rather than leaving the index describing an older body.
pub type SealedFlush = (Vec<u8>, Vec<String>, Option<String>);

/// The `(vault_id, note_id)` a session is keyed by (`SYNC-34`). A session belongs
/// to one note in one vault; opening the same pair again attaches rather than
/// opening a second (`LiveSessionRegistry`).
pub type LiveSessionKey = (String, String);

/// A failure opening, editing, or persisting a live session. A closed enum with
/// no `String` field, mirroring the notes-plugin error discipline; the IPC mirror
/// is `collab-editor-bridge` task 3.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LiveSessionError {
    /// The durable blob is not a decodable `NC05` note. Non-distinguishing per
    /// `protocol.md` §6.4.
    #[error("live session note cannot be decrypted")]
    CannotDecrypt,
    /// The decoded document is not a well-formed Automerge document with the
    /// single-`Text` shape.
    #[error("live session document is malformed")]
    Malformed,
    /// The re-sealed blob would exceed the plaintext cap
    /// (`protocol::MAX_PLAINTEXT_LEN`).
    #[error("live session plaintext too large")]
    TooLarge,
    /// Entropy failure re-sealing the `NC05` blob.
    #[error("live session csprng unavailable")]
    Csprng,
    /// The durable write failed.
    #[error("live session io failure")]
    Io,
}

impl From<CannotDecryptCrdtNote> for LiveSessionError {
    fn from(_: CannotDecryptCrdtNote) -> Self {
        LiveSessionError::CannotDecrypt
    }
}

impl From<CrdtNoteOpError> for LiveSessionError {
    fn from(e: CrdtNoteOpError) -> Self {
        match e {
            CrdtNoteOpError::TooLarge => LiveSessionError::TooLarge,
            CrdtNoteOpError::Csprng => LiveSessionError::Csprng,
            CrdtNoteOpError::CannotDecrypt => LiveSessionError::CannotDecrypt,
            CrdtNoteOpError::Malformed | CrdtNoteOpError::RevisionNotFound => {
                LiveSessionError::Malformed
            }
        }
    }
}

impl From<ProtocolError> for LiveSessionError {
    fn from(e: ProtocolError) -> Self {
        match e {
            ProtocolError::PlaintextTooLarge => LiveSessionError::TooLarge,
            ProtocolError::Csprng => LiveSessionError::Csprng,
            // AEAD/format failures re-sealing our own just-loaded document are
            // structural, not a decrypt of foreign bytes.
            _ => LiveSessionError::Malformed,
        }
    }
}

/// One note's live session.
pub struct LiveSession {
    key: LiveSessionKey,
    note_uuid: [u8; 16],
    doc: AutoCommit,
    /// The heads last written to disk, so a flush can tell whether there is
    /// anything new to persist.
    last_durable_heads: Vec<String>,
    /// The running maximum of every `updated:` stamp this session has observed
    /// (its own device clock and any peer's). The durable boundary writes this
    /// value (`collab-editor-bridge` task 7), so two devices converge and no
    /// interleave can fabricate a stamp neither wrote.
    max_updated: Option<String>,
    /// This device's Automerge actor (`SYNC-42`), re-applied after a pulled merge
    /// reloads the document so subsequent edits stay attributable to this device.
    ///
    /// NOT optional (myne-md/myne#958). An `Option` here is what let the send half
    /// seal `actor.unwrap_or([0u8; 16])` when the vault's identity record was empty,
    /// and a frame carrying sixteen zero bytes is a frame the receiving half cannot
    /// recognise as its own, so this device rendered its own caret as a peer named
    /// `Device 000000`. The caller resolves the actor before opening the session
    /// (`sync::device_actor::actor_for_authoring`), which draws one when the device has
    /// no durable id, so there is no "no actor" state left to spell.
    actor: [u8; 16],
    /// The last LOCAL change not yet announced on the live channel
    /// (`collab-editor-bridge` task 7, the send half). Captured after a local apply;
    /// the transport seals it into an awareness frame and POSTs it. A peer change
    /// (`apply_remote_change`) is NOT captured, announcing it would echo the peer.
    outgoing_change: Option<Vec<u8>>,
    /// This device's LOCAL cursor/selection for this note, not yet announced
    /// (`collab-presence-ui`): set by the editor on a selection change and drained
    /// by the transport into a presence frame, so peers see this device's caret.
    /// `None` between announcements.
    pending_presence: Option<LocalPresence>,
    /// Set when this session has just opened/attached, so the next announcement is
    /// a `FrameType::Join` (which makes peers re-announce their presence, `SYNC-29`).
    join_pending: bool,
}

/// One device's local caret state for a note, pending announcement on the live
/// channel. `selection` is `Some((anchor, head))` when a range is selected, `None`
/// for a bare caret. Positions are UTF-16 code units from the document start, the
/// same unit the awareness codec and the CodeMirror bridge use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalPresence {
    pub cursor: Option<u32>,
    pub selection: Option<(u32, u32)>,
}

/// A presence announcement ready to seal (`collab-presence-ui`): whether it is the
/// session's first announcement (a `FrameType::Join`, which makes peers re-announce)
/// and the caret/selection positions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingPresence {
    pub join: bool,
    pub cursor: Option<u32>,
    pub selection: Option<(u32, u32)>,
}

/// What applying a received live change did to the session
/// ([`LiveSession::apply_remote_change`]). No `Debug`: the splices carry note
/// plaintext.
pub struct RemoteChangeOutcome {
    /// The body splices for the pane, clamped to the body span.
    pub splices: Vec<crate::plugins::live::apply_local::LocalSplice>,
    /// Whether the note's raw text moved at all, frontmatter included. `false` is
    /// a true no-op (this device's own change echoed back by the relay).
    pub text_moved: bool,
}

impl std::fmt::Debug for LiveSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print the document (it is plaintext).
        f.debug_struct("LiveSession")
            .field("key", &self.key)
            .finish_non_exhaustive()
    }
}

impl LiveSession {
    /// Open a session by loading the durable `NC05` blob under this device's
    /// actor (`SYNC-42`). `actor` is the device's 16-byte actor
    /// (`sync::device_actor::actor_for_authoring`: the durable id, or a fresh draw when
    /// the device has none), always applied so a peer-created note's next edit is
    /// authored by THIS device.
    pub fn open_from_blob(
        blob: &[u8],
        vault_id: String,
        note_id: String,
        note_uuid: [u8; 16],
        actor: [u8; 16],
        items_key: &[u8; 32],
        items_key_id: &[u8; 16],
    ) -> Result<Self, LiveSessionError> {
        let save = decode_crdt_note_blob(blob, &note_uuid, items_key, items_key_id)?;
        let mut doc = AutoCommit::load(&save).map_err(|_| LiveSessionError::Malformed)?;
        doc.set_actor(ActorId::from(&actor[..]));
        let last_durable_heads = doc_heads_hex(&mut doc);
        let max_updated = crate::plugins::notes::crdt::note_text_id(&doc)
            .ok()
            .and_then(|t| doc.text(&t).ok())
            .and_then(|text| crate::plugins::live::frontmatter::observed_updated(&text));
        Ok(Self {
            key: (vault_id, note_id),
            note_uuid,
            doc,
            last_durable_heads,
            max_updated,
            actor,
            outgoing_change: None,
            pending_presence: None,
            // A freshly opened session owes a join announcement, so peers
            // re-announce their presence for this note (`SYNC-29`).
            join_pending: true,
        })
    }

    #[must_use]
    pub fn key(&self) -> &LiveSessionKey {
        &self.key
    }

    #[must_use]
    pub fn note_uuid(&self) -> [u8; 16] {
        self.note_uuid
    }

    /// Overwrite the document's body text with `markdown` and commit under the
    /// host clock. `update_text` records only the minimal splices, so this is
    /// merge-safe (`myne-md/myne#428`); task 4 replaces the API with a
    /// per-transaction splice entry point.
    pub fn apply_body_markdown(
        &mut self,
        markdown: &str,
        now_millis: u64,
    ) -> Result<(), LiveSessionError> {
        // The durable boundary stamps the MAX-OBSERVED `updated:` (task 7): fold the
        // incoming field into the running maximum FIRST, then stamp that, so a later
        // local or peer stamp ADVANCES the maximum. Re-stamping the old maximum would
        // freeze `updated:` at the value the blob carried when the pane opened, on
        // every save, which is a persisted user-visible field (recency ordering).
        let incoming = crate::plugins::live::frontmatter::observed_updated(markdown);
        self.max_updated = crate::plugins::live::frontmatter::max_updated(
            self.max_updated.as_deref(),
            incoming.as_deref(),
        );
        let stamped = match self.max_updated.as_deref() {
            Some(v) => crate::plugins::live::frontmatter::set_updated(markdown, v),
            None => markdown.to_string(),
        };
        let text = crate::plugins::notes::crdt::note_text_id(&self.doc)?;
        self.doc
            .update_text(&text, &stamped)
            .map_err(|_| LiveSessionError::Malformed)?;
        commit_at_millis(&mut self.doc, now_millis);
        self.capture_local_change();
        self.observe_updated();
        Ok(())
    }

    /// Apply a CodeMirror transaction's change ranges as minimal splices. The
    /// ranges are UTF-16 over the whole note; the translation and the minimal
    /// `splice_text` live in [`crate::plugins::live::apply_local`]. The splices are
    /// clamped to the body span here (`SYNC-14`, task 6), so a frontmatter-touching
    /// range never becomes a live edit even if a caller sent one unclamped.
    ///
    /// NOTE: the SHIPPED local path is `apply_body_markdown` (a whole re-derived
    /// note, whose CRDT `update_text` records the minimal splices itself), so this
    /// entry point has no command caller. It is kept as the crate-side splice
    /// applier for tests + the transport contract.
    pub fn apply_splices(
        &mut self,
        splices: &[crate::plugins::live::apply_local::LocalSplice],
        now_millis: u64,
    ) -> Result<(), crate::plugins::live::apply_local::ApplyLocalError> {
        let current = self.current_text()?;
        let clamped = crate::plugins::live::body_guard::clamp_to_body(&current, splices);
        crate::plugins::live::apply_local::apply_local_splices(
            &mut self.doc,
            now_millis,
            &clamped,
        )?;
        self.capture_local_change();
        self.observe_updated();
        Ok(())
    }

    /// Apply a received opaque Automerge change and return the body splices the
    /// editor must dispatch as one `ChangeSet`, plus whether the note's text moved
    /// at all. The splices are empty for a self-echo / no-op, and they are clamped
    /// to the body span, so a peer's change that reached the reserved frontmatter
    /// region is never carried into the editor as a splice.
    ///
    /// [`RemoteChangeOutcome::text_moved`] is the raw-text comparison, taken BEFORE
    /// the clamp, so a frontmatter-only change (a peer's rename, retag, move or
    /// trash) reports `true` with no splices. The caller must still signal it: the
    /// pane holds the old frontmatter, and its next whole-markdown save would
    /// write that back over the peer's change (myne-md/myne#849).
    ///
    /// The LIVE CHANNEL content path: `AwarenessRoute` routes a frame's opaque
    /// change into the open session through this, then queues the returned splices
    /// for the pane (`collab-editor-bridge` task 7).
    pub fn apply_remote_change(
        &mut self,
        change_bytes: &[u8],
    ) -> Result<RemoteChangeOutcome, crate::plugins::live::apply_remote::ApplyRemoteError> {
        // Clamp against the pre-change text: the boundary is a property of the
        // frontmatter block, which a body-only live change does not move.
        let current = self
            .current_text()
            .map_err(|_| crate::plugins::live::apply_remote::ApplyRemoteError::Malformed)?;
        let splices =
            crate::plugins::live::apply_remote::apply_remote_change(&mut self.doc, change_bytes)?;
        // `apply_remote_change` answers an empty list exactly when the raw text did
        // not move, so this is the before/after comparison without a second read.
        let text_moved = !splices.is_empty();
        self.observe_updated();
        Ok(RemoteChangeOutcome {
            splices: crate::plugins::live::body_guard::clamp_to_body(&current, &splices),
            text_moved,
        })
    }

    /// Merge a pulled durable `NC05` blob into the open session (`collab-editor-bridge`
    /// task 7, the pull-on-poke reconcile). The §11.1 **remove-wins** gate decides
    /// first: a tombstone on either side wins verbatim. Otherwise the two Automerge
    /// documents interleave-merge. Returns the body splices the editor must dispatch
    /// as ONE `ChangeSet` (empty when the pulled revision is an ancestor / equal).
    ///
    /// The session stays the durable writer, so the caller must NOT also write the
    /// pulled bytes to disk, the session flushes the merged document instead.
    pub fn merge_pulled(
        &mut self,
        blob: &[u8],
        items_key: &[u8; 32],
        items_key_id: &[u8; 16],
    ) -> Result<Vec<crate::plugins::live::apply_local::LocalSplice>, LiveSessionError> {
        let before = self
            .current_text()
            .map_err(|_| LiveSessionError::Malformed)?;
        let local_blob = self.seal(items_key, items_key_id)?;
        let merge = crate::plugins::notes::crdt::merge_crdt_note_blobs(
            &local_blob,
            blob,
            items_key,
            items_key_id,
            &self.note_uuid,
        )
        .map_err(|_| LiveSessionError::Malformed)?;
        let save = decode_crdt_note_blob(&merge.blob, &self.note_uuid, items_key, items_key_id)?;
        let mut merged = AutoCommit::load(&save).map_err(|_| LiveSessionError::Malformed)?;
        merged.set_actor(ActorId::from(&self.actor[..]));
        self.doc = merged;
        let after = self
            .current_text()
            .map_err(|_| LiveSessionError::Malformed)?;
        self.observe_updated();
        Ok(crate::plugins::live::apply_remote::diff_splices(
            &before, &after,
        ))
    }

    /// Fold the document's current `updated:` stamp into the running maximum
    /// (`collab-editor-bridge` task 7). A peer's stamp observed on the live channel
    /// raises the maximum, so the durable boundary converges both devices.
    fn observe_updated(&mut self) {
        if let Ok(text) = self.current_text() {
            if let Some(v) = crate::plugins::live::frontmatter::observed_updated(&text) {
                self.max_updated = crate::plugins::live::frontmatter::max_updated(
                    self.max_updated.as_deref(),
                    Some(&v),
                );
            }
        }
    }

    /// The MAX-OBSERVED `updated:` value the durable writer must stamp, if any has
    /// been observed (task 7).
    #[must_use]
    pub fn durable_updated(&self) -> Option<&str> {
        self.max_updated.as_deref()
    }

    /// Capture this device's last local change for the live channel's send half.
    fn capture_local_change(&mut self) {
        if let Some(c) = self.doc.get_last_local_change() {
            self.outgoing_change = Some(c.raw_bytes().to_vec());
        }
    }

    /// Take the pending local change to announce, if any (`collab-editor-bridge`
    /// task 7, the send half). `None` when nothing local has been applied since the
    /// last take.
    pub fn take_outgoing_change(&mut self) -> Option<Vec<u8>> {
        self.outgoing_change.take()
    }

    /// This device's Automerge actor (`SYNC-42`), the frame's `actor_id`.
    ///
    /// Never `None`: a session always has an actor, so the presence and content send
    /// halves cannot seal a frame without one (myne-md/myne#958).
    #[must_use]
    pub fn actor_id(&self) -> [u8; 16] {
        self.actor
    }

    /// Record this device's LOCAL caret/selection for this note, to be announced on
    /// the next drain (`collab-presence-ui`). The editor calls this on a selection
    /// change; the transport seals it into a presence frame so peers render this
    /// device's caret. Positions are UTF-16 code units from the document start.
    pub fn set_local_presence(&mut self, cursor: Option<u32>, selection: Option<(u32, u32)>) {
        self.pending_presence = Some(LocalPresence { cursor, selection });
    }

    /// Ask this session to re-announce itself on the next drain (`SYNC-29`). Called
    /// when the awareness stream (re)connects, so peers re-announce their presence
    /// for a room this device has just rejoined: the one-shot `join_pending` at open
    /// covers a fresh session, and this covers a reconnect of a session that had
    /// already announced.
    pub fn request_join(&mut self) {
        self.join_pending = true;
    }

    /// Take the pending local presence to announce, if any. Returns
    /// `(join, cursor, selection)`, where `join` is true when this session has not
    /// yet announced itself, so the frame is a `FrameType::Join` that makes peers
    /// re-announce (`SYNC-29`). A session that owes a join announces even with no
    /// caret change, so peers learn it is here; otherwise a session with nothing
    /// pending returns `None`.
    pub fn take_local_presence(&mut self) -> Option<PendingPresence> {
        let join = core::mem::take(&mut self.join_pending);
        match self.pending_presence.take() {
            Some(p) => Some(PendingPresence {
                join,
                cursor: p.cursor,
                selection: p.selection,
            }),
            None if join => Some(PendingPresence {
                join: true,
                cursor: None,
                selection: None,
            }),
            None => None,
        }
    }

    /// Whether this note is a `kind: drawing` note, for which the CodeMirror live
    /// bridge does not apply (`collab-editor-bridge` task 9). Reuses the one
    /// value-strict detection (`drawing_text::is_drawing`); the single-`Text`
    /// storage mapping of a drawing note is unchanged.
    #[must_use]
    pub fn is_drawing(&self) -> bool {
        self.current_text()
            .map(|t| crate::plugins::notes::drawing_text::is_drawing(t.as_bytes()))
            .unwrap_or(false)
    }

    /// The document's current body text (the whole note, frontmatter included).
    ///
    /// `seal_for_flush` reads this under the SAME acquisition as the seal, so the
    /// body it hands the caller is the body the sealed blob holds. Reading it in a
    /// second acquisition after the disk write was the shape that let another
    /// thread merge a change in between, and it is why `SealedFlush` carries the
    /// text rather than the flush re-reading it (myne-md/myne#867 review).
    fn current_text(&self) -> Result<String, crate::plugins::live::apply_local::ApplyLocalError> {
        let text = crate::plugins::notes::crdt::note_text_id(&self.doc)
            .map_err(|_| crate::plugins::live::apply_local::ApplyLocalError::Malformed)?;
        self.doc
            .text(&text)
            .map_err(|_| crate::plugins::live::apply_local::ApplyLocalError::Malformed)
    }

    /// The session's whole current markdown (frontmatter included). This is the
    /// note as the live channel has it, which runs AHEAD of the disk: a live peer
    /// change lands here without a durable flush, so a client that must read a
    /// live note reads it through this rather than from the blob
    /// (`live_session_read`, myne-md/myne#849).
    pub fn markdown(&self) -> Result<String, LiveSessionError> {
        self.current_text().map_err(|_| LiveSessionError::Malformed)
    }

    /// The document's current heads (the `NC05` convergence marker).
    #[must_use]
    pub fn heads(&mut self) -> Vec<String> {
        doc_heads_hex(&mut self.doc)
    }

    /// Whether the in-RAM document has changes not yet on disk.
    #[must_use]
    pub fn is_dirty(&mut self) -> bool {
        doc_heads_hex(&mut self.doc) != self.last_durable_heads
    }

    /// Re-seal the document as an `NC05` blob (no write).
    pub fn seal(
        &mut self,
        items_key: &[u8; 32],
        items_key_id: &[u8; 16],
    ) -> Result<Vec<u8>, LiveSessionError> {
        let save = self.doc.save();
        let blob = encode_crdt_note_blob(items_key, items_key_id, &self.note_uuid, &save)?;
        Ok(blob)
    }

    /// Seal the current document for a durable write, or `None` when there is
    /// nothing new. Split out of [`flush`](Self::flush) so the IPC command bodies
    /// can seal under the registry lock (sync), then `io.write` OUTSIDE it (the
    /// async `VaultIo` write must not run while a `Mutex` guard is held).
    pub fn seal_for_flush(
        &mut self,
        items_key: &[u8; 32],
        items_key_id: &[u8; 16],
    ) -> Result<Option<SealedFlush>, LiveSessionError> {
        let heads = doc_heads_hex(&mut self.doc);
        if heads == self.last_durable_heads {
            return Ok(None);
        }
        // The body text is read in THIS acquisition, beside the seal, and travels
        // with it. A read that fails here does NOT fail the flush: the blob is the
        // user's edit and losing it is worse than an unindexed note. It travels as
        // `None` instead, and the caller drops the note's search doc so the index
        // never describes a different document than the one on disk.
        let markdown = self.current_text().ok();
        let save = self.doc.save();
        let blob = encode_crdt_note_blob(items_key, items_key_id, &self.note_uuid, &save)?;
        Ok(Some((blob, heads, markdown)))
    }

    /// Record `heads` as durable after a successful write.
    pub fn mark_flushed(&mut self, heads: Vec<String>) {
        self.last_durable_heads = heads;
    }

    /// The `.myn` path this session persists to, under `notes_dir`.
    #[must_use]
    pub fn note_path(&self, notes_dir: &Path) -> std::path::PathBuf {
        notes_dir.join(format!("{}.myn", self.key.1))
    }

    /// Persist the current document to `<notes_dir>/<note_id>.myn` and record the
    /// heads as durable. The single-writer invariant (`SYNC-33`) means this is
    /// the only writer for the note while the session is open.
    pub async fn flush(
        &mut self,
        io: &dyn VaultIo,
        notes_dir: &Path,
        items_key: &[u8; 32],
        items_key_id: &[u8; 16],
    ) -> Result<(), LiveSessionError> {
        if let Some((blob, heads, _markdown)) = self.seal_for_flush(items_key, items_key_id)? {
            io.write(&self.note_path(notes_dir), &blob, WriteOpts::default())
                .await
                .map_err(|_| LiveSessionError::Io)?;
            self.mark_flushed(heads);
        }
        Ok(())
    }
}
