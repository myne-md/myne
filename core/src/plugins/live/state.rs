// SPDX-License-Identifier: AGPL-3.0
//! The live-session registry (epic live-collab, `collab-editor-bridge` task 2).
//!
//! One [`LiveSession`] per `(vault_id, note_id)` **per device** (`SYNC-34`).
//! Opening the same note in a second pane ATTACHES to the existing session rather
//! than opening a second `AutoCommit`, so the workspace's
//! single-editable-buffer-per-note invariant holds and two panes never fork the
//! note by racing two documents.
//!
//! The registry is a client-managed state (desktop/mobile `app.manage`, web a
//! `OnceLock`), which is what makes its teardown a `lock-teardown` obligation:
//! `scripts/check-lock-teardown.mjs` keys a `<hook, holder>` row on
//! `LiveSessionRegistry` so an empty `live_session_teardown_on_lock` body cannot
//! ship. See [`super::session`] for the zeroization statement.

use std::collections::HashMap;
use std::sync::Mutex;

use super::apply_local::LocalSplice;
use super::compose::compose_splices;
use super::session::{LiveSession, LiveSessionKey};

/// The process's live sessions, keyed by `(vault_id, note_id)`.
#[derive(Default)]
pub struct LiveSessionRegistry {
    sessions: Mutex<HashMap<LiveSessionKey, LiveSession>>,
    /// Merged-in body splices awaiting delivery to a note's open pane
    /// (`collab-editor-bridge` task 7). The sync cycle merges a pulled live revision
    /// into the session (`merge_pulled`, remove-wins) and queues the resulting diff
    /// here; the pane drains it and dispatches it as ONE CodeMirror `ChangeSet`, so
    /// its buffer catches up WITHOUT the reload a dirty pane skips, and the pane's
    /// next whole-markdown save therefore cannot delete the merged-in text.
    pending_splices: Mutex<HashMap<String, Vec<LocalSplice>>>,
}

impl LiveSessionRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert `session`, or report that the key is already open. Returns `true`
    /// when inserted, `false` when a session for the key already exists, the
    /// caller then ATTACHES to the existing one instead of opening a second
    /// (`SYNC-34`).
    pub fn insert(&self, session: LiveSession) -> bool {
        let key = session.key().clone();
        let mut guard = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if guard.contains_key(&key) {
            return false;
        }
        // A batch queued for an EARLIER session of this note describes that
        // session's merges, not this one's: composed onto this session's first
        // batch it would replay a merge the freshly loaded document already holds
        // (myne-md/myne#849). Dropped under the `sessions` guard, the same lock
        // order as `apply_and_queue`.
        self.drop_pending_splices(&key.1);
        guard.insert(key, session);
        true
    }

    /// Whether a session for this note is already open.
    #[must_use]
    pub fn is_open(&self, vault_id: &str, note_id: &str) -> bool {
        let key = (vault_id.to_string(), note_id.to_string());
        self.sessions
            .lock()
            .map(|g| g.contains_key(&key))
            .unwrap_or(false)
    }

    /// Whether a session for this note id is open in ANY vault. One vault is
    /// active per process, so the note id alone is the discriminator the
    /// `note_update` single-writer refusal (`SYNC-33`) needs, and it spares the
    /// caller from having to agree on a vault-id spelling with the opener.
    #[must_use]
    pub fn is_note_open(&self, note_id: &str) -> bool {
        self.sessions
            .lock()
            .map(|g| g.keys().any(|(_, n)| n == note_id))
            .unwrap_or(false)
    }

    /// Run `f` against the session for this note, if open.
    pub fn with_session_mut<R>(
        &self,
        vault_id: &str,
        note_id: &str,
        f: impl FnOnce(&mut LiveSession) -> R,
    ) -> Option<R> {
        let key = (vault_id.to_string(), note_id.to_string());
        let mut guard = self.sessions.lock().ok()?;
        guard.get_mut(&key).map(f)
    }

    /// Run `f` against the session for this note id in ANY vault (one vault is
    /// active per process). The apply/close commands use this so they need not
    /// agree on a vault-id spelling with the opener.
    pub fn with_note_mut<R>(
        &self,
        note_id: &str,
        f: impl FnOnce(&mut LiveSession) -> R,
    ) -> Option<R> {
        let mut guard = self.sessions.lock().ok()?;
        guard.values_mut().find(|s| s.key().1 == note_id).map(f)
    }

    /// Remove and return the session for this note (caller then flushes/closes).
    ///
    /// The note's queued splices go with it: they are in the coordinates of a
    /// pane over THIS session, and left behind they would compose onto the next
    /// session's first batch and replay a merge twice (myne-md/myne#849).
    pub fn remove(&self, vault_id: &str, note_id: &str) -> Option<LiveSession> {
        let key = (vault_id.to_string(), note_id.to_string());
        let mut guard = self.sessions.lock().ok()?;
        let removed = guard.remove(&key)?;
        self.drop_pending_splices(note_id);
        Some(removed)
    }

    /// Remove and return the session for this note id in any vault, dropping its
    /// queued splices like [`remove`](Self::remove).
    pub fn remove_note(&self, note_id: &str) -> Option<LiveSession> {
        let mut guard = self.sessions.lock().ok()?;
        let k = guard.keys().find(|(_, n)| n == note_id).cloned()?;
        let removed = guard.remove(&k)?;
        self.drop_pending_splices(note_id);
        Some(removed)
    }

    /// Forget whatever is queued for `note_id`. Takes only the `pending_splices`
    /// lock, so a caller may hold the `sessions` guard (the one lock order).
    fn drop_pending_splices(&self, note_id: &str) {
        self.pending_splices
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(note_id);
    }

    /// Ask every open session to re-announce itself on the next drain (`SYNC-29`).
    /// Called on an awareness-stream (re)connect: the relay's fan-out is
    /// connection-scoped, so a session that announced before the drop must announce
    /// again or its peers never learn it is back.
    pub fn mark_all_join_pending(&self) {
        let mut guard = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        for s in guard.values_mut() {
            s.request_join();
        }
    }

    /// Queue the body splices a merge moved into `note_id`'s session, for the pane
    /// to drain and dispatch (`collab-editor-bridge` task 7).
    ///
    /// A list already queued is COMPOSED with the new one, never replaced
    /// (myne-md/myne#849). The queued list maps the pane's document to the
    /// session's state after the first merge, and the new list is in THAT state's
    /// coordinates, so replacing it would drop the first merge's text from the
    /// pane, and the pane's next whole-markdown save would then delete that peer
    /// text from the note. [`compose_splices`] keeps one list over the pane's
    /// document, so it still dispatches as one `ChangeSet`. An empty list is the
    /// identity and leaves the queue as it is; a composition that cancels out
    /// (a second merge undoing the first) empties the slot.
    pub fn set_pending_splices(&self, note_id: &str, splices: Vec<LocalSplice>) {
        self.queue_splices(note_id, splices);
    }

    /// Mutate `note_id`'s open session with `f` and queue the body splices it
    /// returns, ATOMICALLY with respect to every other producer (myne-md/myne#849).
    ///
    /// Two producers merge into a session: the awareness supervisor (a live peer
    /// change) and the sync cycle (a durable pull). Each list is in the coordinates
    /// of the session state its OWN apply started from, so the queue is only right
    /// if lists are queued in the order the applies ran. Applying under the
    /// `sessions` guard, releasing it, and then queueing under `pending_splices`
    /// let the two interleave as apply A, apply B, queue B, queue A, and
    /// [`compose_splices`] then composed B's list as if it came first, placing
    /// text at the wrong offsets in the pane, whose next whole-markdown save would
    /// write that misplacement back. Here the queue happens while the `sessions`
    /// guard is still held, so the order of applies IS the order of queueing.
    ///
    /// Lock order is `sessions` then `pending_splices`, the order
    /// [`insert`](Self::insert), [`remove`](Self::remove) and
    /// [`remove_note`](Self::remove_note) nest them in too. No path takes them the
    /// other way round: [`take_pending_splices`](Self::take_pending_splices) and
    /// [`set_pending_splices`](Self::set_pending_splices) take only the inner lock,
    /// and [`clear`](Self::clear) takes them one after the other, never nested.
    ///
    /// `f` returns the splices to queue (empty leaves the queue as it is) plus any
    /// extra result for the caller. `None` when no session is open for the note;
    /// on `Err` nothing is queued.
    pub fn apply_and_queue<R, E>(
        &self,
        note_id: &str,
        f: impl FnOnce(&mut LiveSession) -> Result<(Vec<LocalSplice>, R), E>,
    ) -> Option<Result<R, E>> {
        let mut guard = self.sessions.lock().ok()?;
        let session = guard.values_mut().find(|s| s.key().1 == note_id)?;
        Some(f(session).map(|(splices, extra)| {
            self.queue_splices(note_id, splices);
            extra
        }))
    }

    /// The queueing half of [`set_pending_splices`](Self::set_pending_splices),
    /// taking only the `pending_splices` lock, so
    /// [`apply_and_queue`](Self::apply_and_queue) may call it with the `sessions`
    /// guard held.
    fn queue_splices(&self, note_id: &str, splices: Vec<LocalSplice>) {
        if splices.is_empty() {
            return;
        }
        if let Ok(mut g) = self.pending_splices.lock() {
            let composed = match g.remove(note_id) {
                Some(queued) => compose_splices(&queued, &splices),
                None => splices,
            };
            if !composed.is_empty() {
                g.insert(note_id.to_string(), composed);
            }
        }
    }

    /// Drain the queued merge splices for `note_id` (empty when none).
    #[must_use]
    pub fn take_pending_splices(&self, note_id: &str) -> Vec<LocalSplice> {
        self.pending_splices
            .lock()
            .map(|mut g| g.remove(note_id))
            .ok()
            .flatten()
            .unwrap_or_default()
    }

    /// Drop every session. Called on each vault-leaving hook so no decrypted
    /// session survives a lock, a vault switch, a delete or a change-password
    /// force-relock (the `myne-md/myne#454` class).
    ///
    /// Poison recovery, like [`insert`](Self::insert): this is a TEARDOWN path, so
    /// `if let Ok(..)` would leave every decrypted session resident after a panic
    /// that poisoned the lock, which is the exact state `clear` exists to prevent.
    /// The map is a plain `clear()`, which cannot observe a half-updated value.
    pub fn clear(&self) {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.pending_splices
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    /// The 16-byte blob ids of every note with an open session (`collab-editor-bridge`
    /// task 7). The sync pull uses this to merge a pulled remote revision INTO the
    /// session (remove-wins) rather than writing it to disk, because the session is the
    /// single durable writer for an open note (`SYNC-33`). A note id that is not a UUID
    /// (never produced by the app) is skipped rather than aborting the set.
    #[must_use]
    pub fn live_note_blob_ids(&self) -> std::collections::HashSet<[u8; 16]> {
        self.sessions
            .lock()
            .map(|g| {
                g.keys()
                    .filter_map(|(_, note_id)| {
                        uuid::Uuid::parse_str(note_id).ok().map(|u| *u.as_bytes())
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.sessions.lock().map(|g| g.len()).unwrap_or(0)
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// The whole live-collab teardown a client's `live_session_teardown_on_lock` owes:
/// drop every session (and its queued splices) AND forget the participant label
/// `live_session_set_presence` stored on the awareness signal. The label is the
/// user's chosen display name for the vault being left, so it may not survive a
/// lock or a vault switch into the next vault's presence frames. Both arguments
/// are optional because a client reaches each through `try_state`, and an
/// unmanaged one is simply nothing to clear.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
pub fn teardown_on_lock(
    registry: Option<&LiveSessionRegistry>,
    signal: Option<&crate::plugins::sync::awareness_listener::AwarenessSignal>,
) {
    if let Some(reg) = registry {
        reg.clear();
    }
    if let Some(sig) = signal {
        sig.set_local_label(None);
        // And the record of what this session posted (myne-md/myne#958): a nonce
        // names a frame rather than carrying one, and it is cleared on the same rule
        // the label is, so a locked vault keeps nothing that describes the vault it
        // left.
        sig.forget_posted_frames();
    }
}

impl std::fmt::Debug for LiveSessionRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveSessionRegistry")
            .field("open", &self.len())
            .finish()
    }
}
