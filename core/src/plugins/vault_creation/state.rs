// SPDX-License-Identifier: AGPL-3.0-only
//! State for the in-flight vault-creation flow.
//!
//! Holds [`VaultCreationSession`] entries keyed by an opaque session
//! token (UUID), plus a parallel `tombstones` map recording recently
//! evicted tokens so `commit` can distinguish "session expired" from
//! "session never existed" (Task 15 TTL).

use super::error::AppError;
use crate::vault_id::VaultId;
use protocol::{AccountNumber, KdfParams, RecoveryPhrase, AEAD_KEY_LEN, ARGON2_SALT_LEN};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use uuid::Uuid;
use zeroize::Zeroizing;

/// Hard cap on concurrent in-flight vault-creation sessions.
///
/// Argon2id at the v0.1 baseline (256 MiB) × this cap = ~1 GiB worst-
/// case temporary heap. Comfortable on a 2024-class developer laptop;
/// the cap exists to protect lower-end hardware from unintended
/// concurrency (e.g. a misbehaving frontend that fires `begin`
/// repeatedly).
pub const MAX_CONCURRENT_SESSIONS: usize = 4;

/// Session time-to-live: 10 minutes.
///
/// Wired into a background `tokio::time::interval` evictor in Task 15.
/// Rationale: 5 min is too short for a user typing back a 24-word
/// phrase; 30 min would keep too-large a RAM-resident plaintext window.
pub const SESSION_TTL_SECS: u64 = 600;

/// How long an evicted token's tombstone is retained so `commit` can
/// return [`AppError::SessionExpired`] cleanly. After this window the
/// tombstone is dropped and a `commit` for that token returns the
/// generic [`AppError::SessionNotFound`] instead.
pub const TOMBSTONE_RETENTION_SECS: u64 = 3600;

/// Tauri-managed state for the vault-creation plugin.
///
/// Two synchronous mutex-guarded maps: live `sessions` keyed by token
/// and `tombstones` recording recently-evicted tokens. Critical
/// sections are short (insert / remove / scan); no `await` while
/// holding either lock.
///
/// `in_flight` is an atomic counter that includes both materialized
/// sessions and outstanding [`SlotReservation`]s — a session that is
/// in the middle of its Argon2id derivation has reserved its slot but
/// has not yet been inserted into `sessions`. The counter is the
/// authoritative cap for `MAX_CONCURRENT_SESSIONS`; the older
/// `count() < MAX` fast-path was racy under burst-`begin` traffic
/// (multiple callers could each see "below cap" and all start
/// 256 MiB Argon2id work, blowing past the cap).
#[derive(Default)]
pub struct VaultCreationState {
    sessions: Mutex<HashMap<Uuid, VaultCreationSession>>,
    /// Tokens recently evicted by the TTL background task. Maps to the
    /// MONOTONIC MILLISECOND reading at eviction; entries older than
    /// `TOMBSTONE_RETENTION_SECS` are pruned by every `evict_*` call.
    ///
    /// Milliseconds from [`crate::host::HostCtx::monotonic_millis`] rather than
    /// `std::time::Instant`, because `Instant::now()` is not merely unavailable
    /// on `wasm32-unknown-unknown` — it **panics at runtime** while compiling
    /// cleanly, so the web client's first `begin` would have trapped the wasm
    /// instance permanently (`decisions.md` 2026-08-15 ships creation there).
    /// The clock is still monotonic and still never leaves the device; what
    /// changed is that its reading is supplied by the host seam instead of
    /// taken from `std`.
    tombstones: Mutex<HashMap<Uuid, u64>>,
    /// Reserved + materialized session slots. Bumped by [`Self::try_reserve`]
    /// before `spawn_blocking` Argon2id work starts; decremented by the
    /// reservation's `Drop` (early-exit) or by [`Self::take`] /
    /// [`Self::take_ignore_status`] / [`Self::evict_older_than`] when a
    /// materialized session leaves the map.
    in_flight: AtomicUsize,
}

/// RAII handle to a reserved session slot.
///
/// Returned by [`VaultCreationState::try_reserve`]. While alive the
/// reservation occupies one slot of [`MAX_CONCURRENT_SESSIONS`].
///
/// - If dropped without [`VaultCreationState::commit_reservation`],
///   the slot is released (counter decremented). This covers every
///   early-exit path in `begin` (Argon2id error, JoinFailure, panic
///   inside `spawn_blocking`).
/// - If consumed by `commit_reservation`, the slot is materialized as
///   a session entry in the map and Drop becomes a no-op.
#[must_use = "dropping releases the reservation; pass to commit_reservation to materialize a session"]
pub struct SlotReservation<'a> {
    state: &'a VaultCreationState,
    consumed: bool,
}

impl Drop for SlotReservation<'_> {
    fn drop(&mut self) {
        if !self.consumed {
            self.state.in_flight.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

/// Lookup outcome for a session token.
///
/// `Found` boxes the inner `VaultCreationSession` because the struct
/// is large (24 `String`s in the recovery phrase + 5 32-byte arrays +
/// timing/account fields) and would otherwise blow up every variant
/// of this enum to the same size. Callers unbox with `*found` to
/// move out the value.
pub enum SessionLookup {
    /// Session present and removed; returned for the caller to consume.
    Found(Box<VaultCreationSession>),
    /// Session was evicted by the TTL evictor recently. Distinguished
    /// from `NotFound` so `commit` can return [`AppError::SessionExpired`].
    Expired,
    /// Session never existed, was already committed/cancelled, or was
    /// evicted longer than `TOMBSTONE_RETENTION_SECS` ago.
    NotFound,
}

impl VaultCreationState {
    /// Number of materialized (inserted) sessions in the map. Does not
    /// include outstanding [`SlotReservation`]s; for the cap-relevant
    /// total use [`Self::in_flight_count`]. Diagnostic accessor used
    /// by the unit tests below; production paths reserve via
    /// [`Self::try_reserve`] and don't need to peek at the count.
    #[allow(dead_code)]
    pub fn count(&self) -> usize {
        self.sessions.lock().expect("session map poisoned").len()
    }

    /// Total reserved + materialized slots. This is the value bounded
    /// by [`MAX_CONCURRENT_SESSIONS`]. Diagnostic accessor used by the
    /// unit tests below; production paths rely on [`Self::try_reserve`]'s
    /// CAS arm to enforce the cap without ever reading the counter
    /// from outside.
    #[allow(dead_code)]
    pub fn in_flight_count(&self) -> usize {
        self.in_flight.load(Ordering::SeqCst)
    }

    /// Reserve one slot of [`MAX_CONCURRENT_SESSIONS`] before kicking
    /// off Argon2id work. The returned [`SlotReservation`] holds the
    /// slot until either dropped (releases) or passed to
    /// [`Self::commit_reservation`] (materialized as a session).
    ///
    /// CAS loop ensures multiple concurrent callers cannot all observe
    /// "below cap" and all reserve — exactly one caller wins each slot.
    pub fn try_reserve(&self) -> Result<SlotReservation<'_>, AppError> {
        let mut current = self.in_flight.load(Ordering::SeqCst);
        loop {
            if current >= MAX_CONCURRENT_SESSIONS {
                return Err(AppError::TooManyConcurrentSessions);
            }
            match self.in_flight.compare_exchange(
                current,
                current + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => {
                    return Ok(SlotReservation {
                        state: self,
                        consumed: false,
                    });
                }
                Err(actual) => current = actual,
            }
        }
    }

    /// Materialize a [`SlotReservation`] into a live session entry.
    /// The reservation is consumed (its `Drop` becomes a no-op) so the
    /// slot stays accounted for until `take` / `take_ignore_status` /
    /// `evict_older_than` removes the session.
    ///
    /// `now_millis` is the caller's monotonic reading
    /// ([`crate::host::HostCtx::monotonic_millis`]) and is stamped onto the
    /// session HERE rather than in `build_session`, which is where the TTL
    /// actually starts: the field measures how long an entry has been in the
    /// map, and `build_session` is a pure function with no clock of its own.
    /// The retry path (`take` -> `try_insert`) deliberately does not re-stamp,
    /// so a failed commit cannot silently extend a session's life.
    pub fn commit_reservation(
        &self,
        mut reservation: SlotReservation<'_>,
        token: Uuid,
        mut session: VaultCreationSession,
        now_millis: u64,
    ) {
        debug_assert!(std::ptr::eq(reservation.state, self));
        session.created_at = now_millis;
        self.sessions
            .lock()
            .expect("session map poisoned")
            .insert(token, session);
        reservation.consumed = true;
    }

    /// Insert `session` under `token` if and only if the cap allows.
    ///
    /// The check + insert run under a single lock acquire, plus the
    /// `in_flight` atomic is bumped so the slot is accounted for
    /// against [`MAX_CONCURRENT_SESSIONS`]. Production code paths
    /// prefer the [`Self::try_reserve`] + [`Self::commit_reservation`]
    /// pair which reserves the slot up-front; this method exists for
    /// commit retry-on-failure (which already holds an accounted slot
    /// indirectly via the take→re-insert path) and for tests.
    pub fn try_insert(&self, token: Uuid, session: VaultCreationSession) -> Result<(), AppError> {
        let mut map = self.sessions.lock().expect("session map poisoned");
        // CAS-style bump: only commit the increment if we actually
        // get to insert. This avoids leaking a slot when the cap arm
        // fires.
        let mut current = self.in_flight.load(Ordering::SeqCst);
        loop {
            if map.len() >= MAX_CONCURRENT_SESSIONS || current >= MAX_CONCURRENT_SESSIONS {
                return Err(AppError::TooManyConcurrentSessions);
            }
            match self.in_flight.compare_exchange(
                current,
                current + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break,
                Err(actual) => current = actual,
            }
        }
        map.insert(token, session);
        Ok(())
    }

    /// Lookup-and-remove for `token`, distinguishing live / expired /
    /// not-found.
    pub fn take(&self, token: Uuid) -> SessionLookup {
        if let Some(s) = self
            .sessions
            .lock()
            .expect("session map poisoned")
            .remove(&token)
        {
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            return SessionLookup::Found(Box::new(s));
        }
        if self
            .tombstones
            .lock()
            .expect("tombstones poisoned")
            .contains_key(&token)
        {
            SessionLookup::Expired
        } else {
            SessionLookup::NotFound
        }
    }

    /// Non-consuming peek of the membership-seal inputs (myne-md/myne#684).
    ///
    /// `commit` seals the membership field BEFORE consuming the session via
    /// [`Self::take`]. The seal inputs must be resolved while the session is
    /// still in the map so a resolution failure leaves it intact for a future
    /// retry (mirrors the `peek_vault_id` ordering). Returns `None` for an
    /// absent / TTL-evicted token (the subsequent `take` surfaces the precise
    /// `SessionNotFound` / `SessionExpired`, and the missing membership
    /// degrades to the lazy unlock stamp). Does NOT touch the `in_flight`
    /// counter. The clone is transient: it seals one field and drops
    /// (zeroized) without ever re-entering the map.
    pub fn peek_seal_inputs(
        &self,
        token: Uuid,
    ) -> Option<(Zeroizing<[u8; AEAD_KEY_LEN]>, [u8; 16])> {
        self.sessions
            .lock()
            .expect("session map poisoned")
            .get(&token)
            .map(|s| (s.root_key.clone(), s.account.hash))
    }

    /// Non-consuming peek of a live session's minted [`VaultId`].
    ///
    /// `commit` resolves the write destination to `vaults/<vault_id>/` from
    /// the session BEFORE it consumes the session via [`Self::take`] — the
    /// `app_data_dir`/`create_dir_all` step must run while the session is
    /// still in the map so a path-resolution failure leaves the session
    /// intact for a future retry (mirrors the existing "resolve before take"
    /// ordering). Returns `None` for an absent / TTL-evicted token (the
    /// subsequent `take` inside `commit_with_vault_path` then surfaces the
    /// precise `SessionNotFound` / `SessionExpired`). Does NOT touch the
    /// `in_flight` counter — it neither inserts nor removes.
    pub fn peek_vault_id(&self, token: Uuid) -> Option<VaultId> {
        self.sessions
            .lock()
            .expect("session map poisoned")
            .get(&token)
            .map(|s| s.vault_id)
    }

    /// Same as [`Self::take`] but treats `Expired` and `NotFound`
    /// identically — both yield `None`. Used by `cancel` (idempotent).
    pub fn take_ignore_status(&self, token: Uuid) -> Option<VaultCreationSession> {
        let removed = self
            .sessions
            .lock()
            .expect("session map poisoned")
            .remove(&token);
        if removed.is_some() {
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
        }
        removed
    }

    /// Evict all sessions with `created_at < cutoff`. Returns the
    /// number of sessions evicted. Each evicted session's `Drop` runs
    /// (Zeroizing fields wipe), and the token is recorded in
    /// `tombstones` so a subsequent `take()` returns `Expired`.
    /// Old tombstones (older than `TOMBSTONE_RETENTION_SECS`) are
    /// pruned in the same call to bound memory.
    pub fn evict_older_than(&self, now_millis: u64, max_age_millis: u64) -> usize {
        let now = now_millis;
        let cutoff = now_millis.saturating_sub(max_age_millis);
        let mut sessions = self.sessions.lock().expect("session map poisoned");
        let mut tombstones = self.tombstones.lock().expect("tombstones poisoned");

        let mut evicted = 0usize;
        sessions.retain(|token, session| {
            if session.created_at >= cutoff {
                true
            } else {
                tombstones.insert(*token, now);
                evicted += 1;
                false
            }
        });

        if evicted > 0 {
            self.in_flight.fetch_sub(evicted, Ordering::SeqCst);
        }

        // Prune ancient tombstones.
        let tombstone_cutoff = now.saturating_sub(TOMBSTONE_RETENTION_SECS * 1_000);
        tombstones.retain(|_, ts| *ts >= tombstone_cutoff);

        evicted
    }

    /// Convenience: evict sessions older than `SESSION_TTL_SECS`.
    pub fn evict_expired(&self, now_millis: u64) -> usize {
        self.evict_older_than(now_millis, SESSION_TTL_SECS * 1_000)
    }
}

/// In-flight vault-creation session.
///
/// Holds every secret-bearing value produced between `begin` and
/// `commit`. Each secret-bearing field is `Zeroizing<...>`
/// (`RecoveryPhrase` already wraps `Zeroizing<[String; 24]>`
/// internally; `AccountNumber` is not secret-bearing and stays bare).
///
/// On drop — whether via `commit` consuming the session, `cancel`
/// dropping it, or TTL eviction — every Zeroizing field's bytes are
/// wiped.
/// The person identity a creation session was opened under (myne-md/myne#911
/// task 5).
///
/// Present only for a **person-born** vault: the `NTV8` generation, whose
/// recovery phrase is retired and whose group tail is the one this person's
/// signed roster describes (myne-md/myne#938, `decisions/protocol/0758`). The
/// `root_key` is NOT sealed to this person's key: it is sealed under the vault
/// password and nothing else. A session without one is the pre-change path
/// (`NTV5`, a vault phrase and a recovery wrap), which is what every client that
/// has not yet shipped an identity-first first run still produces.
///
/// The keypair is held here because `commit` runs on the blocking pool with no
/// access to [`crate::plugins::vault_unlock::state::VaultRuntimeState`], and the
/// signed owner roster cannot be built without the private half. It is
/// `ZeroizeOnDrop`, so the session's own drop wipes it exactly like `root_key`
/// and the phrase.
#[derive(Clone)]
pub struct CreationPerson {
    /// The owner's person keypair: signs the roster the `NTV8` tail carries.
    /// It seals no `root_key` wrap any more (`decisions/protocol/0758`).
    pub pair: protocol::PersonKeyPair,
    /// The owner's `person_id_hash`, written onto the roster's owner row so the
    /// member list can resolve the owner's own display name.
    pub person_id: [u8; 16],
    /// The person's account number. The number is a property of the PERSON, so
    /// a vault created under an identity shows this one rather than minting a
    /// per-vault number of its own.
    pub number: AccountNumber,
}

/// What `begin` learned about the person plane before it minted a session.
///
/// Three cases, and the middle one is why this is an enum rather than an
/// `Option`: a device whose identity is sealed but locked must be REFUSED
/// rather than quietly handed the legacy flow, because the legacy flow mints a
/// second recovery phrase for a user who was promised one.
pub enum CreationPersonRequest {
    /// No identity on this device. The pre-change birth, unchanged.
    Absent,
    /// An identity exists but its session is not installed (the phrase has not
    /// been entered this launch). `begin` refuses with [`super::error::AppError::PersonLocked`].
    Locked,
    /// An unlocked identity. Boxed because the keypair is far larger than the
    /// two empty variants, and the enum is moved once per creation.
    Unlocked(Box<CreationPerson>),
}

pub struct VaultCreationSession {
    /// The fresh, collision-free [`VaultId`] minted at `begin` time
    /// (`vault_registry::mint_unique_vault_id`). `commit` resolves the
    /// write destination to `vaults/<vault_id>/` from this field by default
    /// (SYNC-6 create targeting), so BOTH the first vault (fresh install)
    /// and every "create another" vault land in a freshly-minted
    /// `vaults/<id>/` — eliminating the transitional "new vault falls back
    /// to legacy `vault/`" path. Not secret-bearing (an opaque random
    /// directory name, deliberately decoupled from `account_number_hash` —
    /// SYNC-2), so no `Zeroizing`.
    pub vault_id: VaultId,
    /// User identifier; not secret-bearing in the cryptographic sense
    /// (bearer-token semantics) so no `Zeroizing`.
    ///
    /// For a person-born session this is the PERSON's number
    /// ([`CreationPerson::number`]), and it never reaches vault cryptography:
    /// the vault's own random [`Self::vault_binding`] is what the salts and the
    /// AADs bind (myne-md/myne#911 task 5).
    pub account: AccountNumber,
    /// 24-word BIP-39 phrase (Zeroizing inside `RecoveryPhrase`).
    ///
    /// `None` for a person-born session: the vault phrase is retired, so there
    /// is nothing to show and nothing to wrap. `Some` on the legacy path, where
    /// it is both returned to the UI and wrapped into `enc_root_key_recovery`.
    pub phrase: Option<RecoveryPhrase>,
    /// Argon2id parameter set used to derive `password_wrap_key` and
    /// `recovery_wrap_key`. Stored on the session so `commit` builds
    /// the AADs and `vault.meta` under exactly the same params —
    /// otherwise an AEAD-tag mismatch would surface only at unlock
    /// time.
    pub kdf_params: KdfParams,
    /// 32-byte root key — NEVER crosses the IPC boundary; lives only
    /// here until `commit` AEAD-wraps it into `vault.meta`.
    pub root_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    /// The 16-byte value this vault's salts bind, and the value §9.3 offset 6
    /// carries.
    ///
    /// For a legacy session it IS `account.hash`, byte for byte, so the
    /// derivation is unchanged there. For a person-born session it is a random
    /// per-vault namespace id: the account number is a property of the person,
    /// so it can no longer separate one vault of that person from another, and
    /// the generation keeps it out of vault cryptography altogether
    /// (myne-md/myne#911 task 5).
    pub vault_binding: [u8; 16],
    /// Per-vault Argon2id salt for the password path (spec § 3.1).
    pub salt_password: [u8; ARGON2_SALT_LEN],
    /// Per-vault Argon2id salt for the recovery path (spec § 3.1). All zero on
    /// a person-born session, where the wrap it belonged to does not exist.
    pub salt_recovery: [u8; ARGON2_SALT_LEN],
    /// Cached password-derived wrap key — Argon2id is expensive;
    /// derived once at `begin` time and reused at `commit` time.
    pub password_wrap_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    /// Cached recovery-phrase-derived wrap key. `None` on a person-born
    /// session: the phrase is retired and no key is ever derived for it.
    pub recovery_wrap_key: Option<Zeroizing<[u8; AEAD_KEY_LEN]>>,
    /// The identity this vault is being born under, if any. See
    /// [`CreationPerson`].
    pub person: Option<CreationPerson>,
    /// Monotonic milliseconds at which the session entered the state map,
    /// stamped by [`VaultCreationState::commit_reservation`]. Used by the TTL
    /// evictor.
    ///
    /// `build_session` leaves this `0`, which is correct rather than a
    /// placeholder: a session that never reaches the map has no TTL to run, and
    /// the one path that inserts is the one that stamps.
    pub created_at: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_session() -> VaultCreationSession {
        let account = protocol::generate_account_number().expect("getrandom works");
        let phrase = protocol::generate_recovery_phrase().expect("getrandom works");
        VaultCreationSession {
            vault_id: VaultId::mint(),
            vault_binding: account.hash,
            account,
            phrase: Some(phrase),
            kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
            root_key: Zeroizing::new([0u8; AEAD_KEY_LEN]),
            salt_password: [0u8; ARGON2_SALT_LEN],
            salt_recovery: [0u8; ARGON2_SALT_LEN],
            password_wrap_key: Zeroizing::new([0u8; AEAD_KEY_LEN]),
            recovery_wrap_key: Some(Zeroizing::new([0u8; AEAD_KEY_LEN])),
            person: None,
            created_at: 0,
        }
    }

    fn fixture_session_at(created_at: u64) -> VaultCreationSession {
        let mut s = fixture_session();
        s.created_at = created_at;
        s
    }

    fn fixture_session_with_id(vault_id: VaultId) -> VaultCreationSession {
        let mut s = fixture_session();
        s.vault_id = vault_id;
        s
    }

    #[test]
    fn peek_vault_id_returns_the_minted_id_without_consuming_the_session() {
        // `commit` peeks the session's minted id to resolve `vaults/<id>/`
        // BEFORE consuming the session, so a path-resolution failure leaves
        // the session in the map for retry. Peek must NOT remove the session
        // and must NOT disturb the in-flight counter.
        let state = VaultCreationState::default();
        let token = Uuid::new_v4();
        let id = VaultId::mint();
        state
            .try_insert(token, fixture_session_with_id(id))
            .unwrap();
        assert_eq!(state.in_flight_count(), 1);

        assert_eq!(state.peek_vault_id(token), Some(id));
        // Idempotent + non-consuming: a second peek still returns the id and
        // the session is still takeable.
        assert_eq!(state.peek_vault_id(token), Some(id));
        assert_eq!(state.in_flight_count(), 1, "peek must not touch in_flight");
        assert!(matches!(state.take(token), SessionLookup::Found(_)));
    }

    #[test]
    fn peek_vault_id_returns_none_for_unknown_token() {
        let state = VaultCreationState::default();
        assert!(state.peek_vault_id(Uuid::new_v4()).is_none());
    }

    #[test]
    fn count_starts_at_zero() {
        let state = VaultCreationState::default();
        assert_eq!(state.count(), 0);
    }

    #[test]
    fn try_insert_succeeds_below_cap() {
        let state = VaultCreationState::default();
        for _ in 0..MAX_CONCURRENT_SESSIONS {
            state
                .try_insert(Uuid::new_v4(), fixture_session())
                .expect("under cap");
        }
        assert_eq!(state.count(), MAX_CONCURRENT_SESSIONS);
    }

    #[test]
    fn try_insert_rejects_at_cap() {
        let state = VaultCreationState::default();
        for _ in 0..MAX_CONCURRENT_SESSIONS {
            state.try_insert(Uuid::new_v4(), fixture_session()).unwrap();
        }
        let result = state.try_insert(Uuid::new_v4(), fixture_session());
        assert!(matches!(result, Err(AppError::TooManyConcurrentSessions)));
        assert_eq!(state.count(), MAX_CONCURRENT_SESSIONS);
    }

    #[test]
    fn take_returns_found_for_present_session() {
        let state = VaultCreationState::default();
        let token = Uuid::new_v4();
        state.try_insert(token, fixture_session()).unwrap();
        assert!(matches!(state.take(token), SessionLookup::Found(_)));
        assert_eq!(state.count(), 0);
    }

    #[test]
    fn take_returns_not_found_for_unknown_token() {
        let state = VaultCreationState::default();
        let unknown = Uuid::new_v4();
        assert!(matches!(state.take(unknown), SessionLookup::NotFound));
    }

    #[test]
    fn take_ignore_status_is_idempotent_for_unknown_token() {
        let state = VaultCreationState::default();
        let unknown = Uuid::new_v4();
        assert!(state.take_ignore_status(unknown).is_none());
    }

    #[test]
    fn ttl_constant_is_ten_minutes() {
        // Spec/design lock; documented in design session Q8 ek-soru.
        assert_eq!(SESSION_TTL_SECS, 600);
    }

    #[test]
    fn evict_older_than_removes_old_sessions_only() {
        let state = VaultCreationState::default();
        // A fixed monotonic reading, not a clock call: the whole point of the
        // millis refactor is that the caller supplies the reading, so a test
        // that read a clock would be exercising a path production no longer has.
        let now = 4_000_000u64;
        // Old session — created 1 hour ago.
        let old = Uuid::new_v4();
        state
            .try_insert(old, fixture_session_at(now - 3_600 * 1_000))
            .unwrap();
        // Fresh session — created right now.
        let fresh = Uuid::new_v4();
        state.try_insert(fresh, fixture_session_at(now)).unwrap();

        // Cutoff at 10 minutes ago: only `old` evicts.
        let evicted = state.evict_older_than(now, 600 * 1_000);
        assert_eq!(evicted, 1);
        assert_eq!(state.count(), 1);

        // The evicted token reads as Expired.
        assert!(matches!(state.take(old), SessionLookup::Expired));
        // The fresh token still reads as Found.
        assert!(matches!(state.take(fresh), SessionLookup::Found(_)));
    }

    #[test]
    fn evict_older_than_returns_zero_when_nothing_to_evict() {
        let state = VaultCreationState::default();
        state.try_insert(Uuid::new_v4(), fixture_session()).unwrap();
        // Cutoff in the distant past: nothing evicts.
        let evicted = state.evict_older_than(4_000_000, TOMBSTONE_RETENTION_SECS * 100 * 1_000);
        assert_eq!(evicted, 0);
        assert_eq!(state.count(), 1);
    }

    #[test]
    fn try_reserve_succeeds_below_cap() {
        let state = VaultCreationState::default();
        let mut held = Vec::new();
        for _ in 0..MAX_CONCURRENT_SESSIONS {
            held.push(state.try_reserve().expect("under cap"));
        }
        assert_eq!(state.in_flight_count(), MAX_CONCURRENT_SESSIONS);
        // Drop reservations explicitly so the next test asserts the
        // post-drop state when held goes out of scope.
        drop(held);
        assert_eq!(state.in_flight_count(), 0);
    }

    #[test]
    fn try_reserve_rejects_at_cap() {
        let state = VaultCreationState::default();
        let mut held = Vec::new();
        for _ in 0..MAX_CONCURRENT_SESSIONS {
            held.push(state.try_reserve().unwrap());
        }
        let result = state.try_reserve();
        assert!(matches!(result, Err(AppError::TooManyConcurrentSessions)));
        assert_eq!(state.in_flight_count(), MAX_CONCURRENT_SESSIONS);
        drop(held);
    }

    /// ADVERSARIAL (host-layer red-team): hammer the `try_reserve` CAS loop
    /// plus `SlotReservation` Drop from many threads at once. A non-atomic
    /// admission counter would either OVER-ADMIT (in_flight exceeds the cap
    /// — a memory-pressure DoS, more concurrent Argon2id sessions than the
    /// limit) or DRIFT (balanced reserve/drop leaves the counter ≠ 0 — a
    /// slow leak that permanently wedges vault creation at the cap). High
    /// iteration count surfaces a race the single-threaded tests cannot.
    #[test]
    fn adversarial_concurrent_reserve_churn_holds_cap_and_balances() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let state = VaultCreationState::default();
        let over_admitted = AtomicBool::new(false);
        let high_water = AtomicUsize::new(0);

        std::thread::scope(|s| {
            for _ in 0..16 {
                s.spawn(|| {
                    for _ in 0..20_000 {
                        if let Ok(_res) = state.try_reserve() {
                            // We are holding a reservation; the live count
                            // (reserved + materialized) must never exceed cap.
                            let n = state.in_flight_count();
                            if n > MAX_CONCURRENT_SESSIONS {
                                over_admitted.store(true, Ordering::SeqCst);
                            }
                            let mut hw = high_water.load(Ordering::Relaxed);
                            while n > hw {
                                match high_water.compare_exchange(
                                    hw,
                                    n,
                                    Ordering::Relaxed,
                                    Ordering::Relaxed,
                                ) {
                                    Ok(_) => break,
                                    Err(a) => hw = a,
                                }
                            }
                            // `_res` drops here → fetch_sub releases the slot.
                        }
                    }
                });
            }
        });

        assert!(
            !over_admitted.load(Ordering::SeqCst),
            "OVER-ADMISSION: in_flight exceeded MAX_CONCURRENT_SESSIONS={MAX_CONCURRENT_SESSIONS}"
        );
        assert!(high_water.load(Ordering::Relaxed) <= MAX_CONCURRENT_SESSIONS);
        assert_eq!(
            state.in_flight_count(),
            0,
            "COUNTER DRIFT: balanced reserve/drop left in_flight non-zero"
        );
    }

    /// ADVERSARIAL: releasing a slot at the cap must free exactly one slot —
    /// no off-by-one that leaves creation permanently wedged. (The flagged
    /// gap: existing tests prove reject-at-cap but not release→reacquire.)
    #[test]
    fn adversarial_release_at_cap_frees_exactly_one_slot() {
        let state = VaultCreationState::default();
        let mut held: Vec<_> = (0..MAX_CONCURRENT_SESSIONS)
            .map(|_| state.try_reserve().expect("reserve up to cap"))
            .collect();
        assert!(matches!(
            state.try_reserve(),
            Err(AppError::TooManyConcurrentSessions)
        ));

        // Release one — exactly one slot must open.
        held.pop();
        assert_eq!(state.in_flight_count(), MAX_CONCURRENT_SESSIONS - 1);
        let reacquired = state
            .try_reserve()
            .expect("one slot must be free after release");
        assert_eq!(state.in_flight_count(), MAX_CONCURRENT_SESSIONS);
        // ...and the cap is firm again.
        assert!(matches!(
            state.try_reserve(),
            Err(AppError::TooManyConcurrentSessions)
        ));

        drop(reacquired);
        drop(held);
        assert_eq!(state.in_flight_count(), 0);
    }

    #[test]
    fn dropping_unconsumed_reservation_releases_slot() {
        let state = VaultCreationState::default();
        {
            let _r = state.try_reserve().unwrap();
            assert_eq!(state.in_flight_count(), 1);
        }
        assert_eq!(state.in_flight_count(), 0);
    }

    #[test]
    fn commit_reservation_keeps_slot_until_take() {
        let state = VaultCreationState::default();
        let token = Uuid::new_v4();
        let reservation = state.try_reserve().unwrap();
        state.commit_reservation(reservation, token, fixture_session(), 4_000_000);
        // Materialized session: slot remains accounted for.
        assert_eq!(state.in_flight_count(), 1);
        assert_eq!(state.count(), 1);
        // Removing the session releases the slot.
        assert!(matches!(state.take(token), SessionLookup::Found(_)));
        assert_eq!(state.in_flight_count(), 0);
        assert_eq!(state.count(), 0);
    }

    #[test]
    fn take_decrements_in_flight() {
        let state = VaultCreationState::default();
        let token = Uuid::new_v4();
        state.try_insert(token, fixture_session()).unwrap();
        assert_eq!(state.in_flight_count(), 1);
        let _ = state.take(token);
        assert_eq!(state.in_flight_count(), 0);
    }

    #[test]
    fn take_ignore_status_decrements_in_flight_only_when_present() {
        let state = VaultCreationState::default();
        let token = Uuid::new_v4();
        state.try_insert(token, fixture_session()).unwrap();
        assert!(state.take_ignore_status(token).is_some());
        assert_eq!(state.in_flight_count(), 0);
        // Calling again on an unknown token must not under-flow.
        assert!(state.take_ignore_status(token).is_none());
        assert_eq!(state.in_flight_count(), 0);
    }

    #[test]
    fn evict_older_than_decrements_in_flight() {
        let state = VaultCreationState::default();
        let now = 4_000_000u64;
        for _ in 0..3 {
            state
                .try_insert(Uuid::new_v4(), fixture_session_at(now - 3_600 * 1_000))
                .unwrap();
        }
        assert_eq!(state.in_flight_count(), 3);
        let evicted = state.evict_older_than(now, 600 * 1_000);
        assert_eq!(evicted, 3);
        assert_eq!(state.in_flight_count(), 0);
    }

    #[test]
    fn try_insert_after_take_succeeds_at_cap_boundary() {
        // Models the commit-retry restoration path: take(), do work,
        // on failure try_insert() back. Ensures no slot leaks across
        // the take→re-insert cycle.
        let state = VaultCreationState::default();
        let token = Uuid::new_v4();
        state.try_insert(token, fixture_session()).unwrap();
        let session = match state.take(token) {
            SessionLookup::Found(b) => *b,
            _ => panic!("just inserted"),
        };
        assert_eq!(state.in_flight_count(), 0);
        // Re-insert under the same token must succeed.
        state.try_insert(token, session).unwrap();
        assert_eq!(state.in_flight_count(), 1);
    }

    #[test]
    fn tombstone_distinguishes_expired_from_not_found() {
        let state = VaultCreationState::default();
        let evicted_token = Uuid::new_v4();
        state
            .try_insert(evicted_token, fixture_session_at(4_000_000 - 3_600 * 1_000))
            .unwrap();
        let unknown_token = Uuid::new_v4();

        // Force eviction.
        state.evict_older_than(4_000_000, 600 * 1_000);

        assert!(matches!(state.take(evicted_token), SessionLookup::Expired));
        assert!(matches!(state.take(unknown_token), SessionLookup::NotFound));
    }
}
