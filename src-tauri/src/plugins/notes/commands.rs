//! Tauri commands for the `notes` plugin.
//!
//! Wired in across MYND-26 Tasks 8 / 9:
//!
//! - `note_create` (Task 8): mints a backend-side `NoteId::new_v7()`,
//!   AEAD-encrypts the plaintext via `protocol::encode_new_note` on a
//!   `tokio::task::spawn_blocking` thread, and atomically writes the
//!   `.myn` blob via `atomic_write::atomic_write(.., replace=false)`.
//! - `note_read` (Task 9): strict-parses the UI-supplied `note_id` via
//!   `NoteId::parse`, reads the blob, and AEAD-decrypts via
//!   `protocol::decode_note` on a `spawn_blocking` thread; UTF-8
//!   boundary at the command layer surfaces `InvalidPlaintextEncoding`
//!   as a structural-corruption distinct from `CannotDecrypt`.
//!
//! Both commands pattern-match `Slot::Unlocked(uv) => ...` only;
//! `Slot::Recovering` is structurally rejected at compile time per
//! `recovery-flow.md` §4.1. `items_key` is cloned out into a
//! `Zeroizing<[u8; 32]>` and moved into the blocking closure;
//! `vault_lock` waits for in-flight ops via `tokio::sync::RwLock` fair
//! queueing (no extra synchronization primitive needed).
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".
