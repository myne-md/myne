//! State for the in-flight vault-creation flow.
//!
//! Holds [`VaultCreationSession`] entries keyed by an opaque session
//! token (UUID), plus a parallel `tombstones` map recording recently
//! evicted tokens so `commit` can distinguish "session expired" from
//! "session never existed" (Task 15 TTL).

use super::error::AppError;
use protocol::{AccountNumber, KdfParams, RecoveryPhrase, AEAD_KEY_LEN, ARGON2_SALT_LEN};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
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
#[derive(Default)]
pub struct VaultCreationState {
    sessions: Mutex<HashMap<Uuid, VaultCreationSession>>,
    /// Tokens recently evicted by the TTL background task. Maps to the
    /// instant of eviction; entries older than `TOMBSTONE_RETENTION_SECS`
    /// are pruned by every `evict_*` call.
    tombstones: Mutex<HashMap<Uuid, Instant>>,
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
    /// Number of in-flight (non-tombstoned) sessions.
    pub fn count(&self) -> usize {
        self.sessions.lock().expect("session map poisoned").len()
    }

    /// Insert `session` under `token` if and only if the cap allows.
    ///
    /// The check + insert run under a single lock acquire, eliminating
    /// the TOCTOU race that a separate `count()` then `insert()` would
    /// have.
    pub fn try_insert(&self, token: Uuid, session: VaultCreationSession) -> Result<(), AppError> {
        let mut map = self.sessions.lock().expect("session map poisoned");
        if map.len() >= MAX_CONCURRENT_SESSIONS {
            return Err(AppError::TooManyConcurrentSessions);
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

    /// Same as [`Self::take`] but treats `Expired` and `NotFound`
    /// identically — both yield `None`. Used by `cancel` (idempotent).
    pub fn take_ignore_status(&self, token: Uuid) -> Option<VaultCreationSession> {
        self.sessions
            .lock()
            .expect("session map poisoned")
            .remove(&token)
    }

    /// Evict all sessions with `created_at < cutoff`. Returns the
    /// number of sessions evicted. Each evicted session's `Drop` runs
    /// (Zeroizing fields wipe), and the token is recorded in
    /// `tombstones` so a subsequent `take()` returns `Expired`.
    /// Old tombstones (older than `TOMBSTONE_RETENTION_SECS`) are
    /// pruned in the same call to bound memory.
    pub fn evict_older_than(&self, cutoff: Instant) -> usize {
        let now = Instant::now();
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

        // Prune ancient tombstones.
        let tombstone_cutoff = now - Duration::from_secs(TOMBSTONE_RETENTION_SECS);
        tombstones.retain(|_, ts| *ts >= tombstone_cutoff);

        evicted
    }

    /// Convenience: evict sessions older than `SESSION_TTL_SECS`.
    pub fn evict_expired(&self) -> usize {
        self.evict_older_than(Instant::now() - Duration::from_secs(SESSION_TTL_SECS))
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
pub struct VaultCreationSession {
    /// User identifier; not secret-bearing in the cryptographic sense
    /// (bearer-token semantics) so no `Zeroizing`.
    pub account: AccountNumber,
    /// 24-word BIP-39 phrase (Zeroizing inside `RecoveryPhrase`).
    pub phrase: RecoveryPhrase,
    /// Argon2id parameter set used to derive `password_wrap_key` and
    /// `recovery_wrap_key`. Stored on the session so `commit` builds
    /// the AADs and `vault.meta` under exactly the same params —
    /// otherwise an AEAD-tag mismatch would surface only at unlock
    /// time.
    pub kdf_params: KdfParams,
    /// 32-byte root key — NEVER crosses the IPC boundary; lives only
    /// here until `commit` AEAD-wraps it into `vault.meta`.
    pub root_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    /// Per-vault Argon2id salt for the password path (spec § 3.1).
    pub salt_password: [u8; ARGON2_SALT_LEN],
    /// Per-vault Argon2id salt for the recovery path (spec § 3.1).
    pub salt_recovery: [u8; ARGON2_SALT_LEN],
    /// Cached password-derived wrap key — Argon2id is expensive;
    /// derived once at `begin` time and reused at `commit` time.
    pub password_wrap_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    /// Cached recovery-phrase-derived wrap key.
    pub recovery_wrap_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    /// Wall-clock instant the session entered the state map.
    /// Used by the TTL evictor.
    pub created_at: Instant,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_session() -> VaultCreationSession {
        let account = protocol::generate_account_number().expect("getrandom works");
        let phrase = protocol::generate_recovery_phrase().expect("getrandom works");
        VaultCreationSession {
            account,
            phrase,
            kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
            root_key: Zeroizing::new([0u8; AEAD_KEY_LEN]),
            salt_password: [0u8; ARGON2_SALT_LEN],
            salt_recovery: [0u8; ARGON2_SALT_LEN],
            password_wrap_key: Zeroizing::new([0u8; AEAD_KEY_LEN]),
            recovery_wrap_key: Zeroizing::new([0u8; AEAD_KEY_LEN]),
            created_at: Instant::now(),
        }
    }

    fn fixture_session_at(created_at: Instant) -> VaultCreationSession {
        let mut s = fixture_session();
        s.created_at = created_at;
        s
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
    fn cap_constant_is_four() {
        // Locked by the design session.
        assert_eq!(MAX_CONCURRENT_SESSIONS, 4);
    }

    #[test]
    fn ttl_constant_is_ten_minutes() {
        // Spec/design lock; documented in design session Q8 ek-soru.
        assert_eq!(SESSION_TTL_SECS, 600);
    }

    #[test]
    fn evict_older_than_removes_old_sessions_only() {
        let state = VaultCreationState::default();
        let now = Instant::now();
        // Old session — created 1 hour ago.
        let old = Uuid::new_v4();
        state
            .try_insert(old, fixture_session_at(now - Duration::from_secs(3600)))
            .unwrap();
        // Fresh session — created right now.
        let fresh = Uuid::new_v4();
        state.try_insert(fresh, fixture_session_at(now)).unwrap();

        // Cutoff at 10 minutes ago: only `old` evicts.
        let evicted = state.evict_older_than(now - Duration::from_secs(600));
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
        let evicted = state
            .evict_older_than(Instant::now() - Duration::from_secs(TOMBSTONE_RETENTION_SECS * 100));
        assert_eq!(evicted, 0);
        assert_eq!(state.count(), 1);
    }

    #[test]
    fn tombstone_distinguishes_expired_from_not_found() {
        let state = VaultCreationState::default();
        let evicted_token = Uuid::new_v4();
        state
            .try_insert(
                evicted_token,
                fixture_session_at(Instant::now() - Duration::from_secs(3600)),
            )
            .unwrap();
        let unknown_token = Uuid::new_v4();

        // Force eviction.
        state.evict_older_than(Instant::now() - Duration::from_secs(600));

        assert!(matches!(state.take(evicted_token), SessionLookup::Expired));
        assert!(matches!(state.take(unknown_token), SessionLookup::NotFound));
    }
}
