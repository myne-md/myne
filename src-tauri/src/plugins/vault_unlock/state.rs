//! Runtime state for the vault-unlock plugin.
//!
//! Holds the single `UnlockedVault` slot for the running process,
//! plus the `Semaphore` permit that gates concurrent unlock attempts
//! to one in-flight at a time.
//!
//! Phase 1 is single-vault per OS user (`paths.rs` + `decisions.md`
//! 2026-04-28 "Vault path: app_data_dir/vault/, single vault per OS
//! user in Phase 1"). The slot is `Option<UnlockedVault>` rather than
//! a `HashMap<VaultId, ...>` — Phase 2 multi-vault is a mechanical
//! type swap, lifecycle reasoning unchanged. See grilling session
//! `myne-agents/sessions/grill/2026-05-02-vault-unlock-password.md`
//! Q1 for the full rationale.
//!
//! Lock discipline: the `RwLock` is held only at the start (read-check
//! for `VaultAlreadyUnlocked`) and at the end (write to populate or
//! drop the slot) of any unlock/lock command — never across an
//! `.await` of unrelated work, never across Argon2id. The `Semaphore`
//! permit guards the long-lived critical section.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use protocol::AEAD_KEY_LEN;
use std::time::Instant;
use tokio::sync::{RwLock, Semaphore};
use zeroize::Zeroizing;

/// Cap on concurrent in-flight unlock attempts: 1.
///
/// `recovery-flow.md` §3.3 ("single in-flight, run to completion")
/// extends to unlock per `decisions.md` 2026-05-02 (Phase 1 unlock
/// UI semantics, Task 11). Duplicate submits are rejected with
/// `VaultUnlockError::UnlockInProgress`, not queued.
pub const UNLOCK_PERMITS: usize = 1;

/// Tauri-managed runtime state for the vault-unlock plugin.
///
/// One singleton per app process. Created by `init()` and registered
/// via `app.manage(...)` so `Tauri::State<VaultRuntimeState>` is
/// borrowable from any command.
pub struct VaultRuntimeState {
    /// Single-slot for the currently-unlocked vault. `None` when the
    /// vault is locked or has never been unlocked this process.
    /// `Some(UnlockedVault)` between `vault_unlock` success and
    /// `vault_lock` (or process exit).
    unlocked: RwLock<Option<UnlockedVault>>,

    /// Capacity-1 semaphore gating concurrent unlock attempts.
    /// Acquired via `try_acquire()` (reject) per grilling Q2 — never
    /// `acquire().await` (queueing would silently linearize multi-
    /// click DoS into N×Argon2id).
    unlock_permits: Semaphore,
}

impl Default for VaultRuntimeState {
    fn default() -> Self {
        Self {
            unlocked: RwLock::new(None),
            unlock_permits: Semaphore::new(UNLOCK_PERMITS),
        }
    }
}

impl VaultRuntimeState {
    /// Borrow the unlock-permits semaphore. Callers `try_acquire()`
    /// on this in the unlock command's critical-section guard.
    pub fn unlock_permits(&self) -> &Semaphore {
        &self.unlock_permits
    }

    /// Cheap read-lock peek: does the slot currently hold an
    /// `UnlockedVault`?
    ///
    /// Used at the start of `vault_unlock` to surface
    /// `VaultAlreadyUnlocked` before the permit acquire — fast-path
    /// observable so an already-unlocked guard never blocks on a
    /// permit.
    pub async fn peek_is_some(&self) -> bool {
        self.unlocked.read().await.is_some()
    }

    /// Take the unlocked vault out of the slot, if present.
    ///
    /// Used by `vault_lock` (idempotent: `None` on already-locked).
    /// Returning `Option<UnlockedVault>` lets the caller drop it
    /// explicitly so the Zeroizing fields wipe at a known program
    /// point, rather than at end-of-scope.
    pub async fn take(&self) -> Option<UnlockedVault> {
        self.unlocked.write().await.take()
    }

    /// Insert an `UnlockedVault` into the slot.
    ///
    /// Returns the previously-present vault (if any) so the caller
    /// can decide what to do — production paths should never hit a
    /// non-`None` return because the slot peek + permit acquire
    /// upstream of this call (Task 5) reject the attempt with
    /// `VaultAlreadyUnlocked` before any work is done.
    pub async fn set(&self, vault: UnlockedVault) -> Option<UnlockedVault> {
        self.unlocked.write().await.replace(vault)
    }
}

/// In-memory representation of a successfully-unlocked vault.
///
/// Both key fields are `Zeroizing<[u8; 32]>` so the bytes are wiped
/// when the struct drops — whether via explicit `vault_lock`
/// (`take()` + drop), process exit, or Phase 2+ auto-lock.
///
/// `items_key_id` is the UUIDv7 of the singleton v0.1 `itemsKey`
/// (spec §3.3 / §9.3 offset 241); not secret-bearing and held bare.
///
/// `unlocked_at` records the wall-clock instant of successful unlock
/// for diagnostics. Phase 2+ auto-lock will add a `last_activity`
/// field updated by activity-tracking commands; not added here
/// because there is no Phase 1 writer for it.
///
/// Production reads materialize when note CRUD ships (Lane A `A9`):
/// note encrypt/decrypt borrows `root_key` + `items_key`; lock-on-
/// idle (Phase 2+) borrows `unlocked_at`.
#[allow(dead_code)]
pub struct UnlockedVault {
    pub root_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    pub items_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    pub items_key_id: [u8; 16],
    pub unlocked_at: Instant,
}

/// Build a fixture `UnlockedVault` with byte-pattern arguments so
/// tests can assert against distinguishable bytes. Shared across
/// `state.rs::tests` and `commands.rs::tests`.
#[cfg(test)]
pub(super) fn fixture_unlocked_with_keys(
    root_byte: u8,
    items_byte: u8,
    items_id_byte: u8,
) -> UnlockedVault {
    UnlockedVault {
        root_key: Zeroizing::new([root_byte; AEAD_KEY_LEN]),
        items_key: Zeroizing::new([items_byte; AEAD_KEY_LEN]),
        items_key_id: [items_id_byte; 16],
        unlocked_at: Instant::now(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_unlocked() -> UnlockedVault {
        fixture_unlocked_with_keys(7, 9, 1)
    }

    /// Build a current-thread tokio runtime for a single test.
    ///
    /// The `tokio = ["macros"]` feature is intentionally NOT enabled
    /// (it requires `tokio-macros 2.7+` which is past the locked
    /// `tokio 1.52.1` registry availability and would force a
    /// lockfile bump — TB9 audit-anchor discipline). Tests build a
    /// runtime manually via `block_on`.
    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    #[test]
    fn peek_is_some_false_on_fresh_state() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            assert!(!state.peek_is_some().await);
        });
    }

    #[test]
    fn set_then_peek_is_some_true() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let prior = state.set(fixture_unlocked()).await;
            assert!(prior.is_none());
            assert!(state.peek_is_some().await);
        });
    }

    #[test]
    fn take_returns_set_value() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state.set(fixture_unlocked()).await;
            let taken = state.take().await.expect("slot was just populated");
            assert_eq!(*taken.root_key, [7u8; AEAD_KEY_LEN]);
            assert_eq!(*taken.items_key, [9u8; AEAD_KEY_LEN]);
            assert_eq!(taken.items_key_id, [1u8; 16]);
        });
    }

    #[test]
    fn take_clears_slot() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state.set(fixture_unlocked()).await;
            assert!(state.peek_is_some().await);
            let _ = state.take().await;
            assert!(!state.peek_is_some().await);
        });
    }

    #[test]
    fn take_after_take_returns_none() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state.set(fixture_unlocked()).await;
            let _first = state.take().await;
            let second = state.take().await;
            assert!(second.is_none());
        });
    }

    #[test]
    fn take_on_empty_returns_none() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            assert!(state.take().await.is_none());
        });
    }

    #[test]
    fn set_returns_previous_when_slot_occupied() {
        // Production paths never reach this branch (the
        // VaultAlreadyUnlocked guard in Task 5 rejects before set
        // is called), but the helper itself returns the prior value
        // for tests and for any future flow that intentionally
        // replaces.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let mut a = fixture_unlocked();
            a.root_key = Zeroizing::new([1u8; AEAD_KEY_LEN]);
            let mut b = fixture_unlocked();
            b.root_key = Zeroizing::new([2u8; AEAD_KEY_LEN]);

            assert!(state.set(a).await.is_none());
            let prior = state.set(b).await.expect("slot was occupied");
            assert_eq!(*prior.root_key, [1u8; AEAD_KEY_LEN]);
        });
    }

    #[test]
    fn unlock_permits_starts_at_capacity_one() {
        let state = VaultRuntimeState::default();
        assert_eq!(state.unlock_permits().available_permits(), 1);
    }

    #[test]
    fn unlock_permits_can_be_try_acquired_then_released() {
        let state = VaultRuntimeState::default();
        let permit = state
            .unlock_permits()
            .try_acquire()
            .expect("first try_acquire succeeds at fresh capacity");
        assert_eq!(state.unlock_permits().available_permits(), 0);

        // Second attempt must fail while the first permit is held.
        let second = state.unlock_permits().try_acquire();
        assert!(
            second.is_err(),
            "second try_acquire must fail while permit held"
        );

        // Drop the permit — releases.
        drop(permit);
        assert_eq!(state.unlock_permits().available_permits(), 1);
    }

    #[test]
    fn unlock_permits_constant_is_one() {
        // recovery-flow.md §3.3 + decisions.md 2026-05-02 lock this
        // value; raising it would queue/parallelize unlock attempts,
        // contradicting the no-queue posture established in grilling
        // Q2. Treat any change here as a design-level decision.
        assert_eq!(UNLOCK_PERMITS, 1);
    }
}
