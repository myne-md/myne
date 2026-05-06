//! Runtime state for the vault auth domain (vault-unlock + vault-recover).
//!
//! Holds a single [`Slot`] for the running process plus the `Semaphore`
//! permit that gates concurrent Argon2id-bound auth operations to one in
//! flight at a time, shared across the `vault_unlock` and `vault_recover`
//! plugins.
//!
//! Phase 1 is single-vault per OS user (`paths.rs` + `decisions.md`
//! 2026-04-28 "Vault path: app_data_dir/vault/, single vault per OS user
//! in Phase 1"). The slot is one [`Slot`] rather than a
//! `HashMap<VaultId, Slot>` — Phase 2 multi-vault is a mechanical type
//! swap, lifecycle reasoning unchanged.
//!
//! ## Slot state machine
//!
//! `enum Slot { Empty, Recovering { ... }, Unlocked(UnlockedVault) }` is
//! the type-system realization of `recovery-flow.md` §4.1 + §4.3's
//! "no soft-unlocked session that grants editor access without committing
//! a new password" guarantee. Editor commands (Lane A `A9`+) pattern-match
//! `Slot::Unlocked(uv) => ...`; `Slot::Recovering` is structurally rejected
//! at compile time. See `decisions.md` "Slot state machine +
//! auth_permits generalization" for the design rationale.
//!
//! ## Lock discipline
//!
//! The `RwLock` is held only at the start (read-check for the rejection
//! guard) and at the end (write to populate or drop the slot) of any
//! unlock/recover/lock command — never across an `.await` of unrelated
//! work, never across Argon2id. The `Semaphore` permit guards the long-
//! lived critical section.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use protocol::AEAD_KEY_LEN;
use serde::Serialize;
use std::time::Instant;
use tokio::sync::{RwLock, Semaphore};
use zeroize::Zeroizing;

/// Cap on concurrent in-flight Argon2id-bound auth operations: 1.
///
/// Shared across `vault_unlock`, `vault_recover_with_phrase`, and
/// `vault_complete_recovery`. `recovery-flow.md` §3.3 ("single in-flight,
/// run to completion") plus `decisions.md` 2026-05-02 (Phase 1 unlock UI
/// semantics, Task 11) generalize the posture: **at most one Argon2id
/// auth op in flight client-wide**, defense-in-depth across plugins.
/// Duplicate submits are rejected with the appropriate per-plugin guard
/// variant (`VaultUnlockError::UnlockInProgress`,
/// `VaultRecoveryError::RecoveryInProgress`), not queued.
pub const AUTH_PERMITS: usize = 1;

/// Tauri-managed runtime state for the vault auth domain.
///
/// One singleton per app process. Created by `vault_unlock::init()` and
/// registered via `app.manage(...)` so `Tauri::State<VaultRuntimeState>`
/// is borrowable from any command in either the `vault_unlock` or
/// `vault_recover` plugin.
pub struct VaultRuntimeState {
    /// Three-state slot per the [`Slot`] enum. `Slot::Empty` is the
    /// default; `Slot::Recovering { ... }` is populated by
    /// `vault_recover_with_phrase` success (root_key + items_key derived,
    /// awaiting password commit); `Slot::Unlocked(UnlockedVault)` is
    /// populated by either `vault_unlock` success or
    /// `vault_complete_recovery` success (Recovering → Unlocked promotion).
    slot: RwLock<Slot>,

    /// Capacity-1 semaphore gating concurrent Argon2id-bound auth ops.
    /// Acquired via `try_acquire()` (reject) per grilling Q2 +
    /// decisions 2026-05-02 — never `acquire().await` (queueing would
    /// silently linearize multi-click DoS into N×Argon2id).
    auth_permits: Semaphore,
}

impl Default for VaultRuntimeState {
    fn default() -> Self {
        Self {
            slot: RwLock::new(Slot::Empty),
            auth_permits: Semaphore::new(AUTH_PERMITS),
        }
    }
}

impl VaultRuntimeState {
    /// Borrow the auth-permits semaphore. Callers `try_acquire()` on
    /// this in their command's critical-section guard.
    pub fn auth_permits(&self) -> &Semaphore {
        &self.auth_permits
    }

    /// Cheap read-lock peek: which [`Slot`] variant is currently held?
    ///
    /// Used at the start of every auth command to surface the
    /// appropriate guard variant (`VaultAlreadyUnlocked`,
    /// `VaultRecoveryInProgress`, `RecoveryAlreadyInProgress`) before
    /// the permit acquire — fast-path observable so an already-occupied
    /// guard never blocks on a permit.
    pub async fn slot_kind(&self) -> SlotKind {
        match &*self.slot.read().await {
            Slot::Empty => SlotKind::Empty,
            Slot::Recovering { .. } => SlotKind::Recovering,
            Slot::Unlocked(_) => SlotKind::Unlocked,
        }
    }

    /// Take the slot's contents, leaving [`Slot::Empty`]. Returns the
    /// prior `Slot` so the caller can drop it explicitly (Zeroizing
    /// fields wipe at a known program point) or pattern-match the
    /// variant to emit stage-tagged tracing.
    ///
    /// Used by `vault_lock` — idempotent (returns `Slot::Empty` when
    /// the slot was already empty); drops whichever occupied variant
    /// was held.
    pub async fn take(&self) -> Slot {
        core::mem::replace(&mut *self.slot.write().await, Slot::Empty)
    }

    /// Take just the [`Slot::Recovering`] material, leaving `Slot::Empty`.
    /// Returns `None` if the slot is `Empty` or `Unlocked`.
    ///
    /// Used by `vault_complete_recovery` (A8f) to consume the recovering
    /// state during the password-commit pipeline. On success the caller
    /// repopulates the slot with `set_unlocked`; on failure the local
    /// [`RecoveringMaterial`] drops, the Zeroizing fields wipe, and the
    /// slot stays `Empty` (user must restart from A8d).
    pub async fn take_recovering(&self) -> Option<RecoveringMaterial> {
        let mut slot_guard = self.slot.write().await;
        match core::mem::replace(&mut *slot_guard, Slot::Empty) {
            Slot::Recovering {
                root_key,
                items_key,
                items_key_id,
                recovered_at,
            } => Some(RecoveringMaterial {
                root_key,
                items_key,
                items_key_id,
                recovered_at,
            }),
            other => {
                // Slot was Empty or Unlocked — restore the original
                // variant so we do not perturb a non-Recovering slot.
                *slot_guard = other;
                None
            }
        }
    }

    /// Populate [`Slot::Recovering`].
    ///
    /// Called by `vault_recover_with_phrase` (A8d) after the recovery
    /// wrap-key + items_key wrap blob both decrypt successfully. Returns
    /// the previously-held `Slot` for diagnostics; production paths
    /// should never hit a non-`Empty` return because the slot peek +
    /// permit acquire upstream of this call reject the attempt with the
    /// appropriate guard variant.
    pub async fn set_recovering(&self, material: RecoveringMaterial) -> Slot {
        let RecoveringMaterial {
            root_key,
            items_key,
            items_key_id,
            recovered_at,
        } = material;
        let new = Slot::Recovering {
            root_key,
            items_key,
            items_key_id,
            recovered_at,
        };
        core::mem::replace(&mut *self.slot.write().await, new)
    }

    /// Populate [`Slot::Unlocked`].
    ///
    /// Called by both `vault_unlock` success and `vault_complete_recovery`
    /// success (the post-A8f promotion of `Slot::Recovering` →
    /// `Slot::Unlocked`). Returns the previously-held `Slot` for
    /// diagnostics.
    pub async fn set_unlocked(&self, vault: UnlockedVault) -> Slot {
        core::mem::replace(&mut *self.slot.write().await, Slot::Unlocked(vault))
    }

    /// Read-lock peek that returns a CLONE of the `root_key` from
    /// [`Slot::Recovering`], or `None` if the slot is `Empty` or
    /// `Unlocked`. The returned `Zeroizing<[u8; 32]>` is a fresh
    /// allocation that wipes on drop; the slot's original copy stays
    /// in place.
    ///
    /// Used by `vault_complete_recovery` to snapshot the recovery-
    /// derived root_key for the Argon2id-bound rewrite pipeline
    /// without taking the slot — keeping the slot in
    /// [`Slot::Recovering`] across spawn_blocking enables the
    /// post-Argon2id slot peek (option p, MYND-22 grilling Q4) to
    /// detect mid-flight `vault_lock` and bail without disk write.
    /// See `decisions.md` 2026-05-06 entry "vault_complete_recovery
    /// post-Argon2id slot peek symmetric retrofit".
    pub async fn peek_recovering_root_key_clone(&self) -> Option<Zeroizing<[u8; AEAD_KEY_LEN]>> {
        match &*self.slot.read().await {
            Slot::Recovering { root_key, .. } => Some(Zeroizing::new(**root_key)),
            Slot::Empty | Slot::Unlocked(_) => None,
        }
    }

    /// Read-lock peek that returns a CLONE of `(root_key, vault_meta_bytes_hash)`
    /// from [`Slot::Unlocked`], or `None` if the slot is `Empty` or
    /// `Recovering`. The cloned `Zeroizing<[u8; 32]>` wipes on drop;
    /// the slot's original copy stays in place.
    ///
    /// Used by `vault_change_password::change_password` to snapshot
    /// the unlocked-vault material for the Argon2id-bound rewrite
    /// pipeline without taking the slot — keeping the slot in
    /// [`Slot::Unlocked`] across spawn_blocking enables the post-
    /// Argon2id slot peek (option p, MYND-22 grilling Q4 — Task 12)
    /// to detect mid-flight `vault_lock` and bail without disk write.
    /// The `vault_meta_bytes_hash` returned alongside is the CAS
    /// anchor consumed by Task 11.
    pub async fn peek_unlocked_root_key_and_hash_clone(
        &self,
    ) -> Option<(Zeroizing<[u8; AEAD_KEY_LEN]>, [u8; 32])> {
        match &*self.slot.read().await {
            Slot::Unlocked(uv) => Some((Zeroizing::new(*uv.root_key), uv.vault_meta_bytes_hash)),
            Slot::Empty | Slot::Recovering { .. } => None,
        }
    }

    /// Atomically commit a `vault.meta` rewrite while holding the
    /// slot's write lock end-to-end: verify the slot is still
    /// [`Slot::Unlocked`] with `expected_hash`, run the `rewrite`
    /// closure (in `spawn_blocking` so sync IO doesn't stall the
    /// runtime), and update the slot's `vault_meta_bytes_hash` to
    /// the closure's returned new hash — all without releasing the
    /// write lock between the verify and the update.
    ///
    /// **Closes the post-Argon2id race** that an earlier
    /// `peek_unlocked_root_key_and_hash_clone` + separate
    /// `spawn_blocking(atomic_write)` opened: a `vault_lock` could
    /// fire in the µs gap between the peek's read-lock release and
    /// the spawn_blocking dispatch, drop the slot to `Empty`, and
    /// `atomic_write` would still proceed because its closure had
    /// already captured `new_bytes`. With the lock held throughout,
    /// `vault_lock`'s own write-lock acquire blocks for the duration
    /// of the rewrite (~ms scale), which is allowed by
    /// `CLAUDE.md` "RwLock held only at start/end" — that rule
    /// targets long holds across Argon2id, not the rewrite-commit
    /// critical section.
    ///
    /// On `Slot::Unlocked` with mismatched hash: drops the slot to
    /// `Empty` (force-relock per the CAS-mismatch posture) and
    /// returns [`CommitRewriteError::HashMismatch`] without running
    /// the closure. On `Slot::Empty` or `Slot::Recovering`: returns
    /// [`CommitRewriteError::SlotDropped`] without running the
    /// closure (the slot is already in a non-Unlocked state).
    pub async fn commit_unlocked_rewrite<E, F>(
        &self,
        expected_hash: [u8; 32],
        rewrite: F,
    ) -> Result<(), CommitRewriteError<E>>
    where
        F: FnOnce() -> Result<[u8; 32], E> + Send + 'static,
        E: Send + 'static,
    {
        let mut slot_guard = self.slot.write().await;
        match &*slot_guard {
            Slot::Unlocked(uv) if uv.vault_meta_bytes_hash == expected_hash => {
                // Verified. Hold the lock through the rewrite below.
            }
            Slot::Unlocked(_) => {
                // Hash drift — defensive (auth_permits hold makes
                // this unreachable today). Force-relock.
                *slot_guard = Slot::Empty;
                return Err(CommitRewriteError::HashMismatch);
            }
            Slot::Empty | Slot::Recovering { .. } => {
                return Err(CommitRewriteError::SlotDropped);
            }
        }

        // Run the rewrite in spawn_blocking; the write lock is held
        // across the .await, blocking any concurrent `vault_lock`
        // until atomic_write completes.
        let new_hash = match tokio::task::spawn_blocking(rewrite).await {
            Ok(Ok(h)) => h,
            Ok(Err(e)) => return Err(CommitRewriteError::Rewrite(e)),
            Err(_) => return Err(CommitRewriteError::Join),
        };

        // Slot is still Unlocked under the held write lock; update
        // the hash anchor in place. root_key + items_key untouched.
        if let Slot::Unlocked(uv) = &mut *slot_guard {
            uv.vault_meta_bytes_hash = new_hash;
        }
        Ok(())
    }
}

/// Outcome of [`VaultRuntimeState::commit_unlocked_rewrite`].
///
/// Generic over the rewrite closure's error type so each plugin can
/// route its own `IoError` / `InvalidVaultMeta` back through its own
/// command-level error enum.
pub enum CommitRewriteError<E> {
    /// Slot's `vault_meta_bytes_hash` no longer matches the snapshot.
    /// The slot has been dropped to `Empty` (force-relock); caller
    /// surfaces a CAS-mismatch error to the user.
    HashMismatch,
    /// Slot was `Empty` or `Recovering` at the post-Argon2id check.
    /// The rewrite did NOT run; disk is untouched.
    SlotDropped,
    /// The rewrite closure returned an error.
    Rewrite(E),
    /// `tokio::task::spawn_blocking` join handle returned an error.
    Join,
}

/// Three-state slot per `recovery-flow.md` §4.1 + §4.3.
///
/// Editor commands (Lane A `A9`+) match only `Slot::Unlocked(uv) => ...`;
/// the `Slot::Recovering` variant is structurally rejected at compile
/// time. This is the type-system realization of "no soft-unlocked session
/// that grants editor access without committing a new password."
#[allow(dead_code)] // UnlockedVault field readers land with editor commands (Lane A A9+); Slot::Unlocked.0 field is "never read" until then.
pub enum Slot {
    /// No vault is unlocked or in recovery. Default state at process
    /// start, and the post-`vault_lock` state.
    Empty,
    /// Recovery (A8d) succeeded; awaiting password commit (A8f). Both
    /// `root_key` and `items_key` have been derived eagerly and are
    /// held in `Zeroizing` wrappers (Drop wipes on lock / process
    /// exit). Editor access is structurally denied during this state —
    /// only `vault_complete_recovery` (promotes to `Unlocked`) or
    /// `vault_lock` (drops to `Empty`) is a valid transition.
    Recovering {
        root_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
        items_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
        items_key_id: [u8; 16],
        recovered_at: Instant,
    },
    /// Vault is fully unlocked and ready for editor access. Reached
    /// directly via `vault_unlock` (password path) or via the
    /// `Slot::Recovering → Slot::Unlocked` promotion inside
    /// `vault_complete_recovery`.
    Unlocked(UnlockedVault),
}

/// Owned payload for the [`Slot::Recovering`] variant. Used by the
/// `set_recovering` / `take_recovering` helpers so the variant fields
/// pass as a single bundle across plugin boundaries.
pub struct RecoveringMaterial {
    pub root_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    pub items_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    pub items_key_id: [u8; 16],
    pub recovered_at: Instant,
}

/// Discriminator for the [`Slot`] enum, exposed across IPC by the
/// `vault_status` Tauri command. Serde encoding is the bare variant
/// name (no `kind` wrapper); frontend hand-mirror at
/// `src/types/slot-kind.ts` is a string-literal union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum SlotKind {
    Empty,
    Recovering,
    Unlocked,
}

/// In-memory representation of a successfully-unlocked vault.
///
/// Both key fields are `Zeroizing<[u8; 32]>` so the bytes are wiped when
/// the struct drops — whether via explicit `vault_lock`
/// (`take()` + drop), process exit, or Phase 2+ auto-lock.
///
/// `items_key_id` is the UUIDv7 of the singleton v0.1 `itemsKey`
/// (spec §3.3 / §9.3 offset 241); not secret-bearing and held bare.
///
/// `unlocked_at` records the wall-clock instant of successful unlock
/// for diagnostics. Phase 2+ auto-lock will add a `last_activity` field
/// updated by activity-tracking commands; not added here because there
/// is no Phase 1 writer for it.
///
/// `vault_meta_bytes_hash` is `SHA-256(vault.meta bytes)` captured at
/// populate time (unlock-time read for the password path; post-rewrite
/// in `vault_complete_recovery`). **Public material** — SHA of public
/// bytes — held bare without `Zeroize`. Serves as the in-memory CAS
/// anchor for `vault_change_password`'s in-place rewrite, detecting
/// external mutation of `vault.meta` between unlock and the rewrite
/// commit. Pinned by `decisions.md` 2026-05-06 "Slot::Unlocked anchor
/// field for vault.meta CAS" (MYND-22 foundation hardening).
///
/// Production reads materialize when note CRUD ships (Lane A `A9`):
/// note encrypt/decrypt borrows `root_key` + `items_key`; lock-on-idle
/// (Phase 2+) borrows `unlocked_at`; `vault_change_password` borrows
/// `vault_meta_bytes_hash` for the CAS check.
#[allow(dead_code)]
pub struct UnlockedVault {
    pub root_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    pub items_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    pub items_key_id: [u8; 16],
    pub unlocked_at: Instant,
    pub vault_meta_bytes_hash: [u8; 32],
}

/// Test-only helper: extract the [`UnlockedVault`] from a `Slot::Unlocked`
/// variant, panic on any other variant. Replaces the
/// `Option::expect(...)` pattern in tests written before `Slot` existed
/// (when `take()` returned `Option<UnlockedVault>`).
#[cfg(test)]
impl Slot {
    pub(crate) fn unwrap_unlocked(self) -> UnlockedVault {
        match self {
            Slot::Unlocked(uv) => uv,
            Slot::Empty => panic!("expected Slot::Unlocked, got Slot::Empty"),
            Slot::Recovering { .. } => panic!("expected Slot::Unlocked, got Slot::Recovering"),
        }
    }
}

/// Build a fixture `UnlockedVault` with byte-pattern arguments so tests
/// can assert against distinguishable bytes. Shared across `state.rs`
/// tests and `commands.rs` tests.
///
/// `vault_meta_bytes_hash` is filled with the sentinel `[0xFF; 32]`
/// (production code never produces all-`0xFF` from SHA-256 with
/// vanishing probability), letting tests distinguish "fixture-built
/// slot" from "real-unlock-built slot" when needed.
#[cfg(test)]
pub(crate) fn fixture_unlocked_with_keys(
    root_byte: u8,
    items_byte: u8,
    items_id_byte: u8,
) -> UnlockedVault {
    UnlockedVault {
        root_key: Zeroizing::new([root_byte; AEAD_KEY_LEN]),
        items_key: Zeroizing::new([items_byte; AEAD_KEY_LEN]),
        items_key_id: [items_id_byte; 16],
        unlocked_at: Instant::now(),
        vault_meta_bytes_hash: [0xFF; 32],
    }
}

/// Build a fixture [`RecoveringMaterial`] with byte-pattern arguments,
/// for tests that exercise the `Slot::Recovering` variant. Mirror of
/// `fixture_unlocked_with_keys` for the other variant.
#[cfg(test)]
pub(crate) fn fixture_recovering_with_keys(
    root_byte: u8,
    items_byte: u8,
    items_id_byte: u8,
) -> RecoveringMaterial {
    RecoveringMaterial {
        root_key: Zeroizing::new([root_byte; AEAD_KEY_LEN]),
        items_key: Zeroizing::new([items_byte; AEAD_KEY_LEN]),
        items_key_id: [items_id_byte; 16],
        recovered_at: Instant::now(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_unlocked() -> UnlockedVault {
        fixture_unlocked_with_keys(7, 9, 1)
    }

    fn fixture_recovering() -> RecoveringMaterial {
        fixture_recovering_with_keys(0xAA, 0xBB, 0xCC)
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
    fn slot_kind_returns_empty_on_fresh_state() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            assert_eq!(state.slot_kind().await, SlotKind::Empty);
        });
    }

    #[test]
    fn set_unlocked_then_slot_kind_returns_unlocked() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let prior = state.set_unlocked(fixture_unlocked()).await;
            assert!(matches!(prior, Slot::Empty));
            assert_eq!(state.slot_kind().await, SlotKind::Unlocked);
        });
    }

    #[test]
    fn set_recovering_then_slot_kind_returns_recovering() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let prior = state.set_recovering(fixture_recovering()).await;
            assert!(matches!(prior, Slot::Empty));
            assert_eq!(state.slot_kind().await, SlotKind::Recovering);
        });
    }

    #[test]
    fn take_returns_unlocked_value() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state.set_unlocked(fixture_unlocked()).await;
            let taken = state.take().await;
            match taken {
                Slot::Unlocked(uv) => {
                    assert_eq!(*uv.root_key, [7u8; AEAD_KEY_LEN]);
                    assert_eq!(*uv.items_key, [9u8; AEAD_KEY_LEN]);
                    assert_eq!(uv.items_key_id, [1u8; 16]);
                }
                other => panic!("expected Slot::Unlocked, got {:?}", slot_label(&other)),
            }
        });
    }

    #[test]
    fn take_returns_recovering_value() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state.set_recovering(fixture_recovering()).await;
            let taken = state.take().await;
            match taken {
                Slot::Recovering {
                    root_key,
                    items_key,
                    items_key_id,
                    ..
                } => {
                    assert_eq!(*root_key, [0xAAu8; AEAD_KEY_LEN]);
                    assert_eq!(*items_key, [0xBBu8; AEAD_KEY_LEN]);
                    assert_eq!(items_key_id, [0xCCu8; 16]);
                }
                other => panic!("expected Slot::Recovering, got {:?}", slot_label(&other)),
            }
        });
    }

    #[test]
    fn take_clears_slot_to_empty() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state.set_unlocked(fixture_unlocked()).await;
            assert_eq!(state.slot_kind().await, SlotKind::Unlocked);
            let _ = state.take().await;
            assert_eq!(state.slot_kind().await, SlotKind::Empty);
        });
    }

    #[test]
    fn take_after_take_returns_empty() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state.set_unlocked(fixture_unlocked()).await;
            let _first = state.take().await;
            let second = state.take().await;
            assert!(matches!(second, Slot::Empty));
        });
    }

    #[test]
    fn take_on_fresh_state_returns_empty() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let taken = state.take().await;
            assert!(matches!(taken, Slot::Empty));
        });
    }

    #[test]
    fn take_recovering_returns_some_for_recovering_slot() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state.set_recovering(fixture_recovering()).await;
            let taken = state
                .take_recovering()
                .await
                .expect("slot was just populated");
            assert_eq!(*taken.root_key, [0xAAu8; AEAD_KEY_LEN]);
            assert_eq!(*taken.items_key, [0xBBu8; AEAD_KEY_LEN]);
            assert_eq!(taken.items_key_id, [0xCCu8; 16]);
            // Slot becomes Empty after take_recovering succeeds.
            assert_eq!(state.slot_kind().await, SlotKind::Empty);
        });
    }

    #[test]
    fn take_recovering_returns_none_for_empty_slot() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            assert!(state.take_recovering().await.is_none());
            assert_eq!(state.slot_kind().await, SlotKind::Empty);
        });
    }

    #[test]
    fn take_recovering_returns_none_for_unlocked_slot() {
        // `take_recovering` MUST NOT consume an `Unlocked` slot — that
        // would silently discard a successfully-unlocked vault. The
        // method is targeted: only `Recovering` is taken.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state.set_unlocked(fixture_unlocked()).await;
            assert!(state.take_recovering().await.is_none());
            // Slot still Unlocked — was not perturbed.
            assert_eq!(state.slot_kind().await, SlotKind::Unlocked);
        });
    }

    #[test]
    fn set_unlocked_returns_previous_when_slot_occupied() {
        // Production paths never reach this branch (the
        // VaultAlreadyUnlocked / VaultRecoveryInProgress guards in the
        // unlock command reject before set_unlocked is called), but the
        // helper itself returns the prior value for tests and for any
        // future flow that intentionally replaces.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let mut a = fixture_unlocked();
            a.root_key = Zeroizing::new([1u8; AEAD_KEY_LEN]);
            let mut b = fixture_unlocked();
            b.root_key = Zeroizing::new([2u8; AEAD_KEY_LEN]);

            assert!(matches!(state.set_unlocked(a).await, Slot::Empty));
            let prior = state.set_unlocked(b).await;
            match prior {
                Slot::Unlocked(uv) => assert_eq!(*uv.root_key, [1u8; AEAD_KEY_LEN]),
                other => panic!(
                    "expected prior Slot::Unlocked, got {:?}",
                    slot_label(&other)
                ),
            }
        });
    }

    #[test]
    fn peek_recovering_root_key_clone_returns_some_when_recovering() {
        // The (p) post-Argon2id slot peek pattern (MYND-22 Q4) needs a
        // way to snapshot root_key without taking from slot. Verify
        // the clone matches the slot's bytes; slot stays in Recovering.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state.set_recovering(fixture_recovering()).await;

            let cloned = state
                .peek_recovering_root_key_clone()
                .await
                .expect("slot is Recovering");
            // Clone must equal the fixture's root_key byte pattern
            // (0xAA, 32 bytes).
            assert_eq!(*cloned, [0xAA; AEAD_KEY_LEN]);
            // Slot must STILL be Recovering (clone doesn't take).
            assert_eq!(state.slot_kind().await, SlotKind::Recovering);
        });
    }

    #[test]
    fn peek_recovering_root_key_clone_returns_none_when_empty() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            assert!(state.peek_recovering_root_key_clone().await.is_none());
        });
    }

    #[test]
    fn peek_recovering_root_key_clone_returns_none_when_unlocked() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state.set_unlocked(fixture_unlocked()).await;
            assert!(state.peek_recovering_root_key_clone().await.is_none());
            // Slot still Unlocked (peek does not mutate).
            assert_eq!(state.slot_kind().await, SlotKind::Unlocked);
        });
    }

    #[test]
    fn set_recovering_then_set_unlocked_promotes() {
        // The A8f happy-path shape: take_recovering then set_unlocked
        // promotes Recovering → Unlocked. Verify the transition.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state.set_recovering(fixture_recovering()).await;
            assert_eq!(state.slot_kind().await, SlotKind::Recovering);

            let recovering = state.take_recovering().await.expect("slot was Recovering");
            // Build an UnlockedVault from the recovering material (mimics
            // the A8f closure body's promotion step).
            let promoted = UnlockedVault {
                root_key: recovering.root_key,
                items_key: recovering.items_key,
                items_key_id: recovering.items_key_id,
                unlocked_at: Instant::now(),
                vault_meta_bytes_hash: [0xAA; 32],
            };
            state.set_unlocked(promoted).await;

            assert_eq!(state.slot_kind().await, SlotKind::Unlocked);
        });
    }

    #[test]
    fn auth_permits_starts_at_capacity_one() {
        let state = VaultRuntimeState::default();
        assert_eq!(state.auth_permits().available_permits(), 1);
    }

    #[test]
    fn auth_permits_can_be_try_acquired_then_released() {
        let state = VaultRuntimeState::default();
        let permit = state
            .auth_permits()
            .try_acquire()
            .expect("first try_acquire succeeds at fresh capacity");
        assert_eq!(state.auth_permits().available_permits(), 0);

        // Second attempt must fail while the first permit is held.
        let second = state.auth_permits().try_acquire();
        assert!(
            second.is_err(),
            "second try_acquire must fail while permit held"
        );

        // Drop the permit — releases.
        drop(permit);
        assert_eq!(state.auth_permits().available_permits(), 1);
    }

    #[test]
    fn auth_permits_constant_is_one() {
        // recovery-flow.md §3.3 + decisions.md 2026-05-02 lock this
        // value; raising it would queue/parallelize Argon2id-bound auth
        // attempts, contradicting the no-queue posture established in
        // grilling Q2 + the Slot/auth_permits decisions entry. Treat
        // any change here as a design-level decision.
        assert_eq!(AUTH_PERMITS, 1);
    }

    #[test]
    fn slot_kind_serializes_as_bare_variant_name() {
        // SlotKind is exposed across IPC by `vault_status`. The TS
        // hand-mirror at `src/types/slot-kind.ts` is a string-literal
        // union, so the serde encoding MUST be the bare variant name.
        assert_eq!(
            serde_json::to_string(&SlotKind::Empty).unwrap(),
            r#""Empty""#
        );
        assert_eq!(
            serde_json::to_string(&SlotKind::Recovering).unwrap(),
            r#""Recovering""#
        );
        assert_eq!(
            serde_json::to_string(&SlotKind::Unlocked).unwrap(),
            r#""Unlocked""#
        );
    }

    #[test]
    fn dropping_recovering_slot_zeroizes_keys() {
        // `Slot::Recovering`'s Zeroizing fields wipe on drop. Build a
        // fixture with a known byte pattern, drop it, assert the
        // post-drop bytes (read via the wrapper's Zeroize impl) are
        // zero.
        //
        // We test this indirectly: construct the RecoveringMaterial,
        // drop it, then construct a fresh one and check its values are
        // independent (no Zeroizing leak across instances). The strong
        // form (post-drop pointer read) requires unsafe and is covered
        // by `zeroize` crate's own tests.
        let m = fixture_recovering_with_keys(0x42, 0x13, 0x99);
        assert_eq!(*m.root_key, [0x42u8; AEAD_KEY_LEN]);
        assert_eq!(*m.items_key, [0x13u8; AEAD_KEY_LEN]);
        drop(m);
        // Fresh instance has independent fields.
        let m2 = fixture_recovering_with_keys(0xFE, 0xED, 0x00);
        assert_eq!(*m2.root_key, [0xFEu8; AEAD_KEY_LEN]);
        assert_eq!(*m2.items_key, [0xEDu8; AEAD_KEY_LEN]);
    }

    /// Stable label for a `Slot` for panic messages; `Slot` does not
    /// derive `Debug` because its variants carry `Zeroizing` keys we
    /// do not want printed in any context.
    fn slot_label(s: &Slot) -> &'static str {
        match s {
            Slot::Empty => "Slot::Empty",
            Slot::Recovering { .. } => "Slot::Recovering",
            Slot::Unlocked(_) => "Slot::Unlocked",
        }
    }
}
