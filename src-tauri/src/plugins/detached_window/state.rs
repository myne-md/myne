//! Registry of open detached (pop-out) note windows (myne-md/myne#678, epic #173).
//!
//! One `manage()`-d state mapping a detached window's label (`note-<id>`, SYNC-1)
//! to the note id it holds. It is the single registry SYNC-4 calls for: creation
//! (#678) inserts on spawn, lock-teardown (#679) enumerates + clears it and earns
//! the `check-lock-teardown.mjs` PAIRS row against `DetachedWindowRegistry`, and
//! single-instance routing (#681) looks a note up to reveal its window instead of
//! duplicating it.
//!
//! A plain `std::sync::Mutex` (not `tokio::sync::Mutex`): every method locks,
//! mutates and drops the guard without an `.await` in between, so it never holds
//! the lock across a suspension point (`src-tauri/AGENTS.md` "Gotchas"). Poison is
//! recovered rather than propagated as a panic.
//!
//! Holds only labels and note ids (both already cross IPC in the shipped notes
//! commands), never plaintext or key material. See `src-tauri/AGENTS.md`
//! "Secret-handling logging discipline".

use std::collections::HashMap;
use std::sync::Mutex;

/// Label-to-note-id map of the currently open detached windows.
#[derive(Default)]
pub struct DetachedWindowRegistry {
    inner: Mutex<HashMap<String, String>>,
}

// Every method now has a live consumer: `register` on spawn; `label_for_note` in
// single-instance reveal (SYNC-6); `remove` on window close (#681 task 4);
// `all_labels` in the lock teardown (#679), the screen-capture fan-out (#680) and
// the geometry snapshot (#678 task 6); `clear` in the teardown. So the whole
// SYNC-4 registry surface is wired and no `#[allow(dead_code)]` is owed.
impl DetachedWindowRegistry {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        // Recover from poison: a poisoned lock only means a prior holder panicked,
        // and the map is still consistent for our insert/remove/read use.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Record that `label` now holds `note_id`.
    pub fn register(&self, label: String, note_id: String) {
        self.map().insert(label, note_id);
    }

    /// The label of the window currently holding `note_id`, if any. The basis of
    /// single-instance routing (#681): open an already-open note -> reveal this
    /// window rather than spawn a second.
    pub fn label_for_note(&self, note_id: &str) -> Option<String> {
        self.map()
            .iter()
            .find_map(|(label, id)| (id == note_id).then(|| label.clone()))
    }

    /// Drop one window's entry (its window was closed).
    pub fn remove(&self, label: &str) {
        self.map().remove(label);
    }

    /// Every open detached window label. Lock-teardown (#679) enumerates these to
    /// destroy the windows and then calls [`clear`](Self::clear).
    pub fn all_labels(&self) -> Vec<String> {
        self.map().keys().cloned().collect()
    }

    /// Forget every window. Called by lock-teardown (#679) after destroying them.
    pub fn clear(&self) {
        self.map().clear();
    }
}
