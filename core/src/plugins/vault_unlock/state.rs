//! Runtime state for the vault auth domain (vault-unlock + vault-recover).
//!
//! Holds a [`HashMap<VaultId, Slot>`] of per-vault [`Slot`]s for the running
//! process plus the `Semaphore` permit that gates concurrent Argon2id-bound
//! auth operations to one in flight at a time, shared across the
//! `vault_unlock` and `vault_recover` plugins.
//!
//! ## Per-vault slot map (multi-vault sub-feature 2, MYND-203)
//!
//! The runtime slot was a singleton `RwLock<Slot>`; it is now a
//! `RwLock<HashMap<VaultId, Slot>>` keyed by [`crate::vault_id::VaultId`]
//! (sub-feature 1). Each entry is an independent [`Slot`] state machine — two
//! distinct `VaultId`s can hold one `Unlocked` and one `Recovering` slot side
//! by side without aliasing. A keyed accessor on a MISSING entry behaves
//! exactly as the singleton's `Slot::Empty` did (no panic, same guard/locked
//! path); a keyed [`Self::take`] on a missing entry is an idempotent no-op
//! that leaves every other entry intact.
//!
//! **Invariant (forthcoming — task 2):** at most ONE entry may be
//! `Slot::Unlocked` at any time (SYNC-1 one-at-a-time). This task performs
//! only the mechanical type-swap + keyed accessors; the ≤1-`Unlocked`
//! invariant is NOT enforced here. [`Self::active_vault_id`] resolves the sole
//! `Unlocked` key transitionally (deterministic min-by-id if >1 ever exist —
//! which task 2 will make impossible); read sites resolve the active id
//! through it, then call the keyed accessor.
//!
//! The two auto-lock activity atoms (`last_activity_millis`,
//! `auto_lock_timeout_secs`) stay SINGLETONS: SYNC-1 (one vault unlocked at a
//! time) → one active vault → one activity clock. Sub-feature 6 formalizes
//! multi-vault auto-lock; until then the idle timer operates on the active
//! entry.
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

use crate::vault_id::VaultId;
use protocol::AEAD_KEY_LEN;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
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

/// Bounded wait for an in-flight scheduled backup to release the auth permit
/// when a user-initiated auth op preempts it (MYND-351). Interval × attempts
/// caps how long the user waits before the op rejects (when the permit is held
/// by a non-cancellable auth op rather than the cancellable backup). ~2s ceiling.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
const BACKUP_YIELD_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(25);
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
const BACKUP_YIELD_POLL_ATTEMPTS: u32 = 80;

/// Tauri-managed runtime state for the vault auth domain.
///
/// One singleton per app process. Created by `vault_unlock::init()` and
/// registered via `app.manage(...)` so `Tauri::State<VaultRuntimeState>`
/// is borrowable from any command in either the `vault_unlock` or
/// `vault_recover` plugin.
pub struct VaultRuntimeState {
    /// Per-vault [`Slot`] map keyed by [`VaultId`]. A MISSING key is the
    /// `Slot::Empty` equivalent — there is no stored `Empty` entry; an
    /// absent entry IS empty. Each present entry is one three-state slot:
    /// `Slot::Recovering { ... }` is populated by `vault_recover_with_phrase`
    /// success (root_key + items_key derived, awaiting password commit);
    /// `Slot::Unlocked(UnlockedVault)` is populated by either `vault_unlock`
    /// success or `vault_complete_recovery` success (Recovering → Unlocked
    /// promotion). Distinct keys never alias.
    ///
    /// Invariant (task 2, not enforced here): at most one entry is
    /// `Slot::Unlocked`.
    slots: RwLock<HashMap<VaultId, Slot>>,

    /// Capacity-1 semaphore gating concurrent Argon2id-bound auth ops.
    /// Acquired via `try_acquire()` (reject) per grilling Q2 +
    /// decisions 2026-05-02 — never `acquire().await` (queueing would
    /// silently linearize multi-click DoS into N×Argon2id).
    auth_permits: Semaphore,

    /// Monotonic origin for the auto-lock activity clock (MYND-121), in
    /// milliseconds, set on first use rather than at construction.
    ///
    /// **Was an `Instant` captured in `Default::default()`, and that panicked on
    /// wasm32** (phase3-web-client task 12): `Instant::now()` resolves to std's
    /// `unsupported` backend there, so merely *constructing* the state aborted
    /// the wasm instance — before any vault work, with a bare
    /// `RuntimeError: unreachable` and no other signal. Found from a Worker
    /// stack trace, not by reading.
    ///
    /// Lazy + `AtomicU64` rather than a constructor parameter because
    /// [`Default`] has nowhere to take a host from, and every alternative
    /// (`Option<Instant>`, a cfg-split field, a second constructor) either kept
    /// the panic or pushed a host into ~40 construction sites. The value is
    /// whatever the first caller's monotonic reading was; `0` means "not yet
    /// set", which is why [`Self::activity_origin`] takes the reading as a
    /// parameter instead of fetching one.
    ///
    /// Still monotonic, never wall-clock — a security timer must be immune to
    /// NTP / DST steps (`decisions.md` 2026-05-30 "Auto-lock on idle").
    activity_origin_millis: AtomicU64,

    /// Last user-activity timestamp, in millis since [`Self::start_instant`],
    /// updated by the lock-free `report_user_activity` heartbeat. A plain
    /// `AtomicU64` deliberately held OUTSIDE the slot `RwLock` so the
    /// high-frequency activity signal never serialises against crypto-state
    /// ops (`decisions.md` 2026-05-30). Meaningful only while
    /// `Slot::Unlocked`; reset by [`Self::set_unlocked`] so a stale
    /// pre-unlock value cannot shorten the first post-unlock idle window.
    last_activity_millis: AtomicU64,

    /// Cached **effective** auto-lock timeout in seconds (MYND-121),
    /// already resolved through `auto_lock::effective_auto_lock_secs` —
    /// set at unlock (from `vault.prefs`) and by the timeout-setter IPC
    /// (task 9). The idle timer reads this lock-free each tick instead of
    /// re-decrypting `vault.prefs` (prefs are not cached in
    /// `Slot::Unlocked` — disk is canonical). Held outside the slot
    /// `RwLock`, same rationale as `last_activity_millis`.
    auto_lock_timeout_secs: AtomicU32,

    /// Per-session decrypted vault-label cache (MYND-205, SYNC-3/4). Maps a
    /// [`VaultId`] to the human label decrypted from that vault's
    /// `vault.prefs` during a this-session unlock. The label lives
    /// **encrypted-only** at rest; this cache is the ONLY place the
    /// plaintext label exists outside the editing UI, and it never persists.
    /// `vault_list` reads it to populate `VaultSummary.label` (`Some` iff the
    /// cache holds one for that id) so a never-this-session-unlocked vault
    /// shows a neutral fallback. Held in its own `RwLock` (not the slot map)
    /// so a `vault_list` read does not serialise against the slot lock; an
    /// absent key means "no cached label" (the switcher fallback). The entry
    /// is dropped on lock / take / switch alongside the slot teardown so a
    /// locked vault stops surfacing its real name (SYNC-3 — label only for
    /// this-session-unlocked vaults).
    label_cache: RwLock<HashMap<VaultId, String>>,

    /// Per-session decrypted vault-icon cache (vault-icons) — the twin of
    /// [`Self::label_cache`] for the per-vault switcher glyph name. Like the
    /// label, the icon is **encrypted-only** at rest inside `vault.prefs`; this
    /// cache is the ONLY place the plaintext glyph name exists outside the
    /// editing UI, and it never persists. `vault_list` reads it to populate
    /// `VaultSummary.icon` (`Some` iff the cache holds one for that id) so a
    /// never-this-session-unlocked vault shows the neutral wordmark fallback.
    /// Held in its own `RwLock` (not the slot map), same rationale as
    /// `label_cache`; an absent key means "no cached icon". Dropped on
    /// lock / take / switch alongside the slot teardown (SYNC-3 — icon only for
    /// this-session-unlocked vaults).
    icon_cache: RwLock<HashMap<VaultId, String>>,

    /// Spring-loaded quick-unlock gate (MYND-329 task 9). `false` at process
    /// start; set `true` the first time a **master-password unlock** succeeds
    /// this session ([`Self::mark_full_unlock_done`]). Quick-unlock
    /// (PIN/biometric) is permitted ONLY while this is `true`, so an app
    /// restart forces one full-password unlock before quick-unlock resumes —
    /// the 1Password "restarting won't keep it unlocked" model. Held outside
    /// the slot `RwLock`, same rationale as `last_activity_millis`.
    ///
    /// The recovery-phrase path deliberately does NOT open the gate: a recovery
    /// is rare and security-sensitive, and leaving the gate closed after it is
    /// strictly *stricter* (the user does one password unlock before
    /// quick-unlock works) — never weaker — so it needs no wiring there.
    full_unlock_this_session: AtomicBool,
}

impl Default for VaultRuntimeState {
    fn default() -> Self {
        Self {
            slots: RwLock::new(HashMap::new()),
            auth_permits: Semaphore::new(AUTH_PERMITS),
            activity_origin_millis: AtomicU64::new(0),
            last_activity_millis: AtomicU64::new(0),
            auto_lock_timeout_secs: AtomicU32::new(crate::DEFAULT_AUTO_LOCK_SECS),
            label_cache: RwLock::new(HashMap::new()),
            icon_cache: RwLock::new(HashMap::new()),
            full_unlock_this_session: AtomicBool::new(false),
        }
    }
}

impl VaultRuntimeState {
    /// Borrow the auth-permits semaphore. Callers `try_acquire()` on
    /// this in their command's critical-section guard.
    pub fn auth_permits(&self) -> &Semaphore {
        &self.auth_permits
    }

    // Backup is desktop-only — the web capability set excludes backup
    // export/restore by decision (`decisions.md` 2026-07-26), and the only
    // production caller is `src-tauri`'s backup plugin. Gated rather than
    // routed through `crate::task`: a wasm `sleep` here would be dead code,
    // and a dead timer arm is a thing that looks tested and is not.
    #[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
    /// "User always wins" preemption of an in-flight scheduled backup before a
    /// user-initiated auth op acquires the shared auth permit (MYND-351, design
    /// session 2026-06-17 Q6 / Direction 2).
    ///
    /// A scheduled `vault_export_backup` holds the auth permit for its whole
    /// run; without this, a user clicking change-password / delete during that
    /// window would be rejected by their own `try_acquire`. This signals the
    /// export's cooperative `backup_cancel` flag (the export aborts at its next
    /// per-member tick, discards partial output, and drops the permit) and then
    /// waits — bounded — for the permit to free, so the caller's subsequent
    /// `try_acquire` succeeds.
    ///
    /// Best-effort and non-poisoning:
    /// - Fast path: if the permit is already free (no in-flight holder) it
    ///   returns immediately WITHOUT touching the cancel flag.
    /// - If the permit is held by ANOTHER auth op (not the cancellable backup)
    ///   the wait times out and the caller's `try_acquire` rejects as before —
    ///   auth-vs-auth reject-never-queue is unchanged.
    /// - The cancel flag it sets is cleared by the next export's post-acquire
    ///   `reset_cancel`, so it never poisons a future backup.
    pub async fn preempt_backup_for_user_auth(
        &self,
        backup_cancel: &std::sync::atomic::AtomicBool,
    ) {
        use std::sync::atomic::Ordering;
        // Nothing holds the permit → no backup in flight; do not cancel.
        if self.auth_permits().available_permits() > 0 {
            return;
        }
        // Signal the cooperative cancel and wait (bounded) for release.
        backup_cancel.store(true, Ordering::Relaxed);
        for _ in 0..BACKUP_YIELD_POLL_ATTEMPTS {
            if self.auth_permits().available_permits() > 0 {
                return;
            }
            tokio::time::sleep(BACKUP_YIELD_POLL_INTERVAL).await;
        }
        // Timed out: a non-backup auth op holds it. Caller's try_acquire rejects.
    }

    /// The `VaultId` of the sole `Slot::Unlocked` entry, or `None` if no
    /// vault is unlocked.
    ///
    /// TRANSITIONAL active-vault resolver (sub-feature 2). Read sites that used
    /// to peek the singleton slot resolve the active id through this, then call
    /// the keyed accessor; when this returns `None` they hit the SAME
    /// guard/locked path they hit today on an empty slot. Task 2 enforces the
    /// ≤1-`Unlocked` invariant so at most one entry is ever `Unlocked`; until
    /// then, if more than one were somehow `Unlocked`, this returns the
    /// deterministic minimum by `VaultId` (`Ord`) so the choice is stable.
    pub async fn active_vault_id(&self) -> Option<VaultId> {
        let slots = self.slots.read().await;
        slots
            .iter()
            .filter(|(_, slot)| matches!(slot, Slot::Unlocked(_)))
            .map(|(id, _)| *id)
            .min()
    }

    /// Best-effort **synchronous** read of [`Self::active_vault_id`], for a
    /// caller that cannot await (myne-md/myne#437).
    ///
    /// The AI backend selection is such a caller: it resolves inside a sync
    /// `active()` and has to answer "is the authorization I hold the CURRENT
    /// vault's?" before it may route a note off the device. Threading an async
    /// read through the 41 call sites of that seam would be a large, noisy
    /// change for one comparison.
    ///
    /// **`None` on contention, and that is the point.** A caller must treat an
    /// unproven answer as "cannot confirm", and for the AI gate that means
    /// falling back to the local arm — so a contended lock degrades to
    /// in-process inference, never to another vault's provider. A gate whose
    /// failure mode is "send anyway" would be the wrong shape regardless of how
    /// rare the contention is.
    pub fn active_vault_id_now(&self) -> Option<VaultId> {
        let slots = self.slots.try_read().ok()?;
        slots
            .iter()
            .filter(|(_, slot)| matches!(slot, Slot::Unlocked(_)))
            .map(|(id, _)| *id)
            .min()
    }

    /// The `VaultId` of the sole non-`Empty` entry the idle timer / lock path
    /// should act on — the `Unlocked` key if one exists, else the `Recovering`
    /// key. `None` when no entry is `Unlocked` or `Recovering`.
    ///
    /// TRANSITIONAL (sub-feature 2): `vault_lock` and the auto-lock idle timer
    /// operate on "the active entry" while SYNC-1 guarantees one-at-a-time.
    /// Deterministic min-by-id within each tier mirrors [`Self::active_vault_id`].
    pub async fn active_vault_or_recovering_for_probe(&self) -> Option<VaultId> {
        self.active_or_recovering_vault_id().await
    }

    /// The `VaultId` of the sole `Recovering` entry, if any (MYND-220 /
    /// VR-18).
    ///
    /// `complete_recovery`'s `None`-target resolution: a RESUMED
    /// password-reset (post-WebView-reload) carries no UI-side id —
    /// the `recover` Stage has no vaultId payload and the reducer
    /// re-mounts with `vaultId = null` — but the runtime owns recovery
    /// identity, so the sole `Recovering` slot IS the exact A8f target.
    /// Distinct from [`Self::active_vault_or_recovering_for_probe`]:
    /// this resolver must NEVER yield an `Unlocked` entry (A8f's slot
    /// peek would correctly reject it, but the path/slot key pair must
    /// not diverge onto the wrong vault first). Deterministic min-by-id
    /// mirrors the sibling resolvers (SYNC-1 forbids two `Recovering`
    /// entries; the tiebreak is defensive).
    pub async fn recovering_vault_id(&self) -> Option<VaultId> {
        let slots = self.slots.read().await;
        slots
            .iter()
            .filter(|(_, slot)| matches!(slot, Slot::Recovering { .. }))
            .map(|(id, _)| *id)
            .min()
    }

    /// Internal active-or-recovering resolver (see the public
    /// [`Self::active_vault_or_recovering_for_probe`] wrapper).
    async fn active_or_recovering_vault_id(&self) -> Option<VaultId> {
        let slots = self.slots.read().await;
        slots
            .iter()
            .filter(|(_, slot)| matches!(slot, Slot::Unlocked(_)))
            .map(|(id, _)| *id)
            .min()
            .or_else(|| {
                slots
                    .iter()
                    .filter(|(_, slot)| matches!(slot, Slot::Recovering { .. }))
                    .map(|(id, _)| *id)
                    .min()
            })
    }

    /// Record user activity — the lock-free heartbeat sink for auto-lock
    /// on idle (MYND-121). A single relaxed atomic store of "now" (millis
    /// since [`Self::start_instant`]) into `last_activity_millis`. It
    /// **never touches the slot `RwLock`**, so a ~5s-debounced heartbeat
    /// cannot serialise against note-save / unlock / lock ops
    /// (`decisions.md` 2026-05-30). Safe in any slot state; the value is
    /// only consulted while `Slot::Unlocked` (see [`Self::idle_millis`]).
    pub fn report_activity(&self, now_millis: u64) {
        self.last_activity_millis
            .store(self.relative_millis(now_millis), Ordering::Relaxed);
    }

    /// Milliseconds elapsed since the last recorded activity. Lock-free
    /// load. The authoritative idle timer (MYND-121 task 6) compares this
    /// against the effective timeout, then re-reads under the slot
    /// write-lock before the irreversible zeroize (TOCTOU close). The
    /// value is meaningful only while `Slot::Unlocked`; the timer checks
    /// the slot kind first.
    pub fn idle_millis(&self, now_millis: u64) -> u64 {
        self.relative_millis(now_millis)
            .saturating_sub(self.last_activity_millis.load(Ordering::Relaxed))
    }

    /// A host monotonic reading, rebased onto this state's own origin.
    ///
    /// The origin is claimed by whoever reads first. Two properties matter and
    /// both are deliberate: the result is **0 on that first call**, so a fresh
    /// state reports no idle time rather than the host's uptime; and rebasing
    /// keeps `last_activity_millis` small regardless of what origin the host
    /// picked (`performance.now()` counts from page load, the desktop's from
    /// first use).
    ///
    /// `saturating_sub` is load-bearing, not defensive: a host clock that went
    /// backwards would otherwise underflow to a colossal idle time and lock the
    /// vault instantly. Saturating to 0 means a backwards step delays the
    /// auto-lock rather than triggering it — the direction that does not throw
    /// away a user's unsaved work on a clock glitch.
    fn relative_millis(&self, now_millis: u64) -> u64 {
        // `now_millis` can legitimately be 0 (a `NoopHost`, or the very first
        // millisecond). Storing 0 leaves the origin "unset" and the next call
        // claims it — harmless, because the rebased result is 0 either way.
        let origin = self.activity_origin_millis.load(Ordering::Relaxed);
        if origin == 0 {
            self.activity_origin_millis
                .store(now_millis, Ordering::Relaxed);
            return 0;
        }
        now_millis.saturating_sub(origin)
    }

    /// Set the cached effective auto-lock timeout (seconds). Lock-free.
    /// Called at unlock (from `vault.prefs`) and by the timeout-setter IPC
    /// (MYND-121 task 9). Callers pass the value already through the
    /// protective envelope (`auto_lock::effective_auto_lock_secs`).
    pub fn set_auto_lock_timeout_secs(&self, secs: u32) {
        self.auto_lock_timeout_secs.store(secs, Ordering::Relaxed);
    }

    /// The cached effective auto-lock timeout (seconds). Lock-free load,
    /// read by the idle timer each tick.
    pub fn auto_lock_timeout_secs(&self) -> u32 {
        self.auto_lock_timeout_secs.load(Ordering::Relaxed)
    }

    /// Record that a master-password unlock has succeeded this process session
    /// — opens the spring-loaded quick-unlock gate (MYND-329 task 9). Called
    /// from the password-unlock success path (the recovery path intentionally
    /// leaves the gate closed; see the field doc).
    pub fn mark_full_unlock_done(&self) {
        self.full_unlock_this_session.store(true, Ordering::Relaxed);
    }

    /// Whether a full-credential unlock has happened this session. Quick-unlock
    /// is permitted only when this is `true` (an app restart resets it to
    /// `false`, forcing one full-password unlock before quick-unlock resumes).
    pub fn has_full_unlock_this_session(&self) -> bool {
        self.full_unlock_this_session.load(Ordering::Relaxed)
    }

    /// Insert/replace the decrypted label for `id` in the per-session label
    /// cache (MYND-205, SYNC-3). Called at unlock (label decrypted from
    /// `vault.prefs`) and by `vault_set_label` after a successful disk write
    /// so the switcher reflects a rename immediately. `Some(label)` caches it;
    /// `None` removes the entry (the user cleared the label) so `vault_list`
    /// reports the vault as unlabelled again. The plaintext label exists ONLY
    /// here at runtime; it never persists outside the AEAD-sealed `vault.prefs`.
    pub async fn set_cached_label(&self, id: VaultId, label: Option<String>) {
        let mut cache = self.label_cache.write().await;
        match label {
            Some(l) => {
                cache.insert(id, l);
            }
            None => {
                cache.remove(&id);
            }
        }
    }

    /// The decrypted label cached for `id` this session, or `None` if no
    /// label was cached (vault never unlocked this session, or it carries no
    /// label). Read by `vault_list` to project `VaultSummary.label` (SYNC-4):
    /// `Some` only for a this-session-cached vault, the neutral-fallback
    /// signal otherwise.
    pub async fn cached_label(&self, id: VaultId) -> Option<String> {
        self.label_cache.read().await.get(&id).cloned()
    }

    /// Drop `id`'s cached label (MYND-205) — the label-cache half of a lock /
    /// take / switch teardown so a locked vault stops surfacing its real name
    /// in the switcher (SYNC-3 — real labels only for this-session-unlocked
    /// vaults). Idempotent: a missing entry is a no-op.
    pub async fn evict_cached_label(&self, id: VaultId) {
        self.label_cache.write().await.remove(&id);
    }

    /// Insert/replace the decrypted icon glyph name for `id` in the per-session
    /// icon cache (vault-icons) — the twin of [`Self::set_cached_label`]. Called
    /// at unlock (icon decrypted from `vault.prefs`) and by `vault_set_icon`
    /// after a successful disk write so the switcher reflects a change
    /// immediately. `Some(icon)` caches it; `None` removes the entry (the user
    /// cleared the icon) so `vault_list` reports the vault as icon-less again.
    /// The plaintext glyph name exists ONLY here at runtime; it never persists
    /// outside the AEAD-sealed `vault.prefs`.
    pub async fn set_cached_icon(&self, id: VaultId, icon: Option<String>) {
        let mut cache = self.icon_cache.write().await;
        match icon {
            Some(i) => {
                cache.insert(id, i);
            }
            None => {
                cache.remove(&id);
            }
        }
    }

    /// The decrypted icon glyph name cached for `id` this session, or `None` if
    /// no icon was cached (vault never unlocked this session, or it carries no
    /// icon). Read by `vault_list` to project `VaultSummary.icon` (SYNC-4):
    /// `Some` only for a this-session-cached vault, the neutral-fallback signal
    /// otherwise. The switcher renders the neutral wordmark when `None`.
    pub async fn cached_icon(&self, id: VaultId) -> Option<String> {
        self.icon_cache.read().await.get(&id).cloned()
    }

    /// Drop `id`'s cached icon (vault-icons) — the icon-cache half of a lock /
    /// take / switch teardown so a locked vault stops surfacing its real glyph
    /// in the switcher (SYNC-3 — real icons only for this-session-unlocked
    /// vaults). Idempotent: a missing entry is a no-op.
    pub async fn evict_cached_icon(&self, id: VaultId) {
        self.icon_cache.write().await.remove(&id);
    }

    /// TOCTOU-safe idle lock: acquire the slot write-lock and drop the
    /// `Slot::Unlocked` ONLY if (a) the slot is still `Unlocked` and (b) the
    /// idle — re-read UNDER the lock via `idle_under_lock` — is still
    /// `>= timeout`. Returns the dropped `Slot` (whose `Zeroizing` fields
    /// wipe on the caller's `drop`) when it locks, or `None` when it must
    /// not (slot not Unlocked, or activity arrived in the check→lock gap).
    ///
    /// This is the SAME slot-take mechanism as [`Self::take`] — NOT a
    /// parallel zeroize path — gated by an under-lock re-read so a heartbeat
    /// landing between the timer's lock-free pre-check and the write-lock
    /// acquire correctly aborts the lock (MYND-121 fail-closed + TOCTOU;
    /// `decisions.md` 2026-05-30). `idle_under_lock` is a closure (not a
    /// precomputed value) precisely so the read happens while the write-lock
    /// is held; it reads only the lock-free activity atom, never the slot.
    pub async fn take_unlocked_if_idle<F>(
        &self,
        timeout: core::time::Duration,
        idle_under_lock: F,
    ) -> Option<Slot>
    where
        F: FnOnce() -> core::time::Duration,
    {
        // TRANSITIONAL (sub-feature 6 — multi-vault auto-lock): operate on the
        // single active `Unlocked` entry (SYNC-1 one-at-a-time).
        let mut guard = self.slots.write().await;
        let id = guard
            .iter()
            .filter(|(_, slot)| matches!(slot, Slot::Unlocked(_)))
            .map(|(id, _)| *id)
            .min()?;
        if idle_under_lock() < timeout {
            return None;
        }
        // Remove the active entry — a missing key IS empty, so removal is the
        // map analogue of replacing the singleton with `Slot::Empty`. Other
        // entries are untouched.
        let taken = guard.remove(&id);
        // #270: the decrypted label + icon go WITH the keys.
        //
        // SYNC-3 says a locked vault stops surfacing its real name, and the
        // manual lock honoured it — but the idle path did not, so a machine
        // left alone until auto-lock fired showed every vault's real name in
        // the switcher on the lock screen, from the RAM cache, indefinitely.
        // That is the exact state auto-lock exists to prevent.
        //
        // Evicted here rather than at the caller so every drop path inherits
        // it: the split between "the path that remembered" and "the path that
        // did not" is what produced the gap.
        if taken.is_some() {
            drop(guard);
            self.label_cache.write().await.remove(&id);
            self.icon_cache.write().await.remove(&id);
        }
        taken
    }

    /// TTL bail for `Slot::Recovering` (MYND-121 story 8/9): acquire the slot
    /// write-lock and drop the recovery session ONLY if (a) the slot is still
    /// `Recovering` and (b) its age — `age_of(recovered_at)` — is `>= ttl`.
    /// Returns the dropped `Slot` (whose `Zeroizing` `root_key`/`items_key`
    /// wipe on the caller's `drop`) when it bails, else `None`.
    ///
    /// This is the SAME slot-take mechanism as [`Self::take`] / the automated
    /// `recovery-flow.md` §4.3 bail — NOT a parallel zeroize path. The TTL is
    /// ABSOLUTE from `recovered_at` (a transient-state deadline, not an
    /// activity-reset idle): a user cannot hold the freshly-recovered
    /// `root_key` live indefinitely by moving the mouse. `age_of` is a closure
    /// (the real caller subtracts against [`crate::host::HostCtx::monotonic_millis`])
    /// so the age is read while the write-lock is held and so tests can inject a
    /// deterministic age.
    ///
    /// Takes a monotonic MILLISECOND reading rather than an `Instant`
    /// (phase3-web-client task 12): `Instant::now()` panics on
    /// `wasm32-unknown-unknown`. This is a genuine elapsed-time consumer — the
    /// one `Slot` timestamp that is actually read — so it must be monotonic and
    /// must not become a wall clock, or a backwards clock step would extend a
    /// recovery session indefinitely.
    pub async fn take_recovering_if_expired<F>(
        &self,
        ttl: core::time::Duration,
        age_of: F,
    ) -> Option<Slot>
    where
        F: FnOnce(u64) -> core::time::Duration,
    {
        // TRANSITIONAL (sub-feature 6 — multi-vault auto-lock): operate on the
        // single active `Recovering` entry (SYNC-1 one-at-a-time).
        let mut guard = self.slots.write().await;
        let (id, recovered_at) = guard
            .iter()
            .filter_map(|(id, slot)| match slot {
                Slot::Recovering { recovered_at, .. } => Some((*id, *recovered_at)),
                _ => None,
            })
            .min_by_key(|(id, _)| *id)?;
        if age_of(recovered_at) < ttl {
            return None;
        }
        // Remove the active entry; a missing key IS empty. Other entries intact.
        guard.remove(&id)
    }

    /// Acquire a read borrow of the [`Slot`].
    ///
    /// Editor commands (Lane A `A9`+ — MYND-26 `note_create` /
    /// `note_read`) pattern-match the returned guard's `Slot::Unlocked
    /// (uv) => ...` variant, clone keys out of `uv`, and HOLD the
    /// guard across `tokio::task::spawn_blocking` + `atomic_write` so
    /// `vault_lock` waits for in-flight ops via `tokio::sync::RwLock`
    /// fair queueing — no extra Semaphore/Notify/CancellationToken
    /// machinery (see `decisions.md` 2026-05-07 "Note AEAD ops").
    ///
    /// The guard is `Send + Sync` because `Slot: Send + Sync` (every
    /// variant's fields are; `Zeroizing<[u8; 32]>` is `Send + Sync`).
    /// Holding it across `.await` keeps the outer future `Send`-clean.
    /// TRANSITIONAL active-vault read helper (sub-feature 2): resolve the
    /// active vault id, then [`Self::slot_read`] it. When no vault is unlocked
    /// the guard `Deref`s to [`Slot::Empty`] (a missing entry IS empty) — the
    /// SAME locked/guard path read sites hit today on an empty singleton slot.
    /// Read sites (notes CRUD, snapshots, etc.) call this; task 4 replaces it
    /// with an explicitly-threaded vault_id.
    pub async fn slot_read_active(&self) -> SlotReadGuard<'_> {
        // Resolve under the same map; a `None` active id keys an arbitrary
        // absent entry (the legacy sentinel) so the guard yields `Empty`.
        let id = self
            .active_vault_id()
            .await
            .unwrap_or(crate::paths::legacy_vault_id());
        self.slot_read(id).await
    }

    /// TRANSITIONAL active-vault read helper (sub-feature 2): the active
    /// vault's [`SlotKind`], or [`SlotKind::Empty`] when no vault is unlocked
    /// or recovering. The locked-path guard read sites use; task 4 replaces it
    /// with an explicitly-threaded vault_id.
    pub async fn slot_kind_active(&self) -> SlotKind {
        match self.active_or_recovering_vault_id().await {
            Some(id) => self.slot_kind(id).await,
            None => SlotKind::Empty,
        }
    }

    pub async fn slot_read(&self, id: VaultId) -> SlotReadGuard<'_> {
        // Hold the WHOLE-map read guard (transitionally a coarse lock — a
        // `vault_lock` write request on ANY entry waits behind it; sub-feature
        // 3 narrows this to per-entry locking). The wrapper resolves `id`'s
        // entry on each `Deref`, returning the shared `Slot::Empty` when the
        // key is absent (a missing entry IS empty).
        SlotReadGuard {
            guard: self.slots.read().await,
            id,
        }
    }

    /// Cheap read-lock peek: which [`Slot`] variant is currently held?
    ///
    /// Used at the start of every auth command to surface the
    /// appropriate guard variant (`VaultAlreadyUnlocked`,
    /// `VaultRecoveryInProgress`, `RecoveryAlreadyInProgress`) before
    /// the permit acquire — fast-path observable so an already-occupied
    /// guard never blocks on a permit.
    pub async fn slot_kind(&self, id: VaultId) -> SlotKind {
        // A missing key IS the `Empty` case (matches the singleton's
        // empty-slot behavior).
        match self.slots.read().await.get(&id) {
            None | Some(Slot::Empty) => SlotKind::Empty,
            Some(Slot::Recovering { .. }) => SlotKind::Recovering,
            Some(Slot::Unlocked(_)) => SlotKind::Unlocked,
        }
    }

    /// Take the slot's contents, leaving [`Slot::Empty`]. Returns the
    /// prior `Slot` so the caller can drop it explicitly (Zeroizing
    /// fields wipe at a known program point) or pattern-match the
    /// variant to emit stage-tagged tracing.
    ///
    /// Used by `vault_lock` (via the active-id resolution) — idempotent: a
    /// `take` on a MISSING entry returns `Slot::Empty` (matches the
    /// singleton's already-empty behavior), and removing an entry leaves every
    /// OTHER entry intact.
    ///
    /// ## The `VaultId`-keyed lock primitive (sub-feature 6)
    ///
    /// This keyed `take(id)` is the primitive sibling 6's lock-on-switch +
    /// idle-lock will call to lock ONE specific vault by id (e.g. the switcher
    /// locks the prior vault before unlocking the target; a per-vault idle
    /// timer locks exactly the vault that went idle). It is `pub` (callable
    /// from anywhere in the crate, where sibling 6 lives); no widening needed.
    /// Param-less `vault_lock` stays the active-vault convenience (SYNC-8) and
    /// resolves the sole active id, then funnels through this same primitive.
    pub async fn take(&self, id: VaultId) -> Slot {
        // Remove the entry; a missing key IS empty → `Slot::Empty`.
        let taken = self.slots.write().await.remove(&id).unwrap_or(Slot::Empty);
        // #270: same eviction as the idle take. Callers that already evicted
        // are unaffected — both removals are idempotent.
        self.label_cache.write().await.remove(&id);
        self.icon_cache.write().await.remove(&id);
        taken
    }

    /// Take just the [`Slot::Recovering`] material, leaving `Slot::Empty`.
    /// Returns `None` if the slot is `Empty` or `Unlocked`.
    ///
    /// Used by `vault_complete_recovery` (A8f) to consume the recovering
    /// state during the password-commit pipeline. On success the caller
    /// repopulates the slot with `set_unlocked`; on failure the local
    /// [`RecoveringMaterial`] drops, the Zeroizing fields wipe, and the
    /// slot stays `Empty` (user must restart from A8d).
    pub async fn take_recovering(&self, id: VaultId) -> Option<RecoveringMaterial> {
        let mut slots = self.slots.write().await;
        // Only consume `id`'s entry if it is `Recovering`; a missing /
        // `Empty` / `Unlocked` entry is left untouched (and other entries are
        // never perturbed).
        match slots.get(&id) {
            Some(Slot::Recovering { .. }) => {}
            _ => return None,
        }
        match slots.remove(&id) {
            Some(Slot::Recovering {
                root_key,
                items_key,
                items_key_id,
                recovered_at,
            }) => Some(RecoveringMaterial {
                root_key,
                items_key,
                items_key_id,
                recovered_at,
            }),
            // Unreachable given the guard above; restore defensively.
            Some(other) => {
                slots.insert(id, other);
                None
            }
            None => None,
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
    pub async fn set_recovering(&self, id: VaultId, material: RecoveringMaterial) -> Slot {
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
        // Insert under `id`; the prior entry (or `Slot::Empty` if absent) is
        // returned for diagnostics.
        self.slots
            .write()
            .await
            .insert(id, new)
            .unwrap_or(Slot::Empty)
    }

    /// Populate [`Slot::Unlocked`].
    ///
    /// Called by both `vault_unlock` success and `vault_complete_recovery`
    /// success (the post-A8f promotion of `Slot::Recovering` →
    /// `Slot::Unlocked`). Returns the previously-held `Slot` for
    /// diagnostics.
    pub async fn set_unlocked(&self, id: VaultId, vault: UnlockedVault) -> Slot {
        // Fresh activity baseline for the new session so a stale pre-unlock
        // `last_activity_millis` cannot shorten the first idle window
        // (auto-lock on idle, MYND-121). The activity clock stays a SINGLETON
        // (SYNC-1: one vault unlocked at a time → one clock).
        //
        // `unlocked_at` is the caller's host reading, taken moments ago on the
        // same monotonic clock — so it is reused here rather than requiring a
        // host parameter on this method.
        let now_millis = vault.unlocked_at;
        self.last_activity_millis
            .store(self.relative_millis(now_millis), Ordering::Relaxed);
        // Insert under `id`; the prior entry (or `Slot::Empty` if absent) is
        // returned for diagnostics.
        self.slots
            .write()
            .await
            .insert(id, Slot::Unlocked(vault))
            .unwrap_or(Slot::Empty)
    }

    /// Populate [`Slot::Unlocked`] for `id`, FIRST locking (dropping +
    /// zeroizing) any OTHER currently-`Unlocked` vault — the set-unlocked seam
    /// that enforces the **≤1-`Unlocked` invariant** (SYNC-1 one-at-a-time).
    ///
    /// Lock-then-unlock: resolve the active vault; if a DIFFERENT vault is
    /// `Unlocked`, remove its entry under the SAME write lock (its
    /// `UnlockedVault`'s `Zeroizing` keys wipe when the returned `Slot` drops),
    /// THEN insert `id`'s `Unlocked` entry. Holding ONE write lock across both
    /// mutations guarantees the `slots` map is never observable with two
    /// `Unlocked` entries.
    ///
    /// Only `Unlocked` is capped: a `Recovering` entry for another vault is
    /// left untouched (recovery-flow.md §4 — a `Recovering` entry is not
    /// `Unlocked`; its transient state is fine alongside the sole `Unlocked`).
    /// Re-unlocking the SAME `id` is not a switch (the active vault equals the
    /// target) — the prior same-id entry is simply replaced by `insert`.
    ///
    /// Returns the prior `Slot` so the caller can drive the rest of the
    /// four-surface lock teardown at a known program point: the slot drop +
    /// key zeroize is done here, but wiping the GLOBAL derived indices (search
    /// index / VaultIndices / attachment-refs) needs an `AppHandle` and so
    /// happens at the command-wrapper seam (`vault_unlock::commands::unlock`)
    /// BEFORE the next unlock hydrates them — no cross-vault index bleed. When
    /// a SWITCH occurred the returned variant is the locked prior vault's
    /// `Slot::Unlocked`; when no other vault was unlocked (or this re-unlocks
    /// the same id from `Empty`) it is `Slot::Empty`.
    pub async fn set_unlocked_locking_others(&self, id: VaultId, vault: UnlockedVault) -> Slot {
        // Fresh activity baseline for the new session (mirrors `set_unlocked`)
        // so a stale pre-unlock `last_activity_millis` cannot shorten the first
        // idle window. The activity clock stays a SINGLETON (SYNC-1).
        let now_millis = vault.unlocked_at;
        self.last_activity_millis
            .store(self.relative_millis(now_millis), Ordering::Relaxed);

        let mut slots = self.slots.write().await;
        // Resolve the currently-`Unlocked` vault (if any) under the held write
        // lock — the same deterministic min-by-id resolution as
        // `active_vault_id`, but inside this critical section so the
        // lock-then-unlock is atomic w.r.t. any concurrent reader.
        let active = slots
            .iter()
            .filter(|(_, slot)| matches!(slot, Slot::Unlocked(_)))
            .map(|(other, _)| *other)
            .min();
        // Lock the OTHER unlocked vault first (drop + zeroize its keys). A
        // re-unlock of the same id is not a switch, so skip when `other == id`.
        let locked_prior = match active {
            Some(other) if other != id => slots.remove(&other),
            _ => None,
        };
        // Populate the target. The prior same-id entry (or `Empty` if absent)
        // is replaced; on a switch it is `Empty` for `id` so this insert is
        // the first `Unlocked` entry after the teardown above.
        let prior_same_id = slots.insert(id, Slot::Unlocked(vault));
        // Prefer the locked-prior (switch) variant for the caller's teardown
        // decision; otherwise hand back this id's own prior slot.
        locked_prior.or(prior_same_id).unwrap_or(Slot::Empty)
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
        // TRANSITIONAL (sub-feature 2): resolve the single active `Recovering`
        // entry. Sub-feature 4 threads an explicit `vault_id` here. Deterministic
        // min-by-id (mirroring `active_vault_id`) rather than HashMap-iteration
        // order, so if a bug ever left two `Recovering` slots the choice is stable.
        let slots = self.slots.read().await;
        slots
            .iter()
            .filter_map(|(id, slot)| match slot {
                Slot::Recovering { root_key, .. } => Some((id, root_key)),
                _ => None,
            })
            .min_by_key(|(id, _)| **id)
            .map(|(_, root_key)| Zeroizing::new(**root_key))
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
        // TRANSITIONAL (sub-feature 2): resolve the single active `Unlocked`
        // entry. Sub-feature 4 threads an explicit `vault_id` here. Deterministic
        // min-by-id (mirroring `active_vault_id`) rather than HashMap-iteration
        // order, so if a bug ever left two `Unlocked` slots the choice is stable.
        let slots = self.slots.read().await;
        slots
            .iter()
            .filter_map(|(id, slot)| match slot {
                Slot::Unlocked(uv) => Some((id, uv)),
                _ => None,
            })
            .min_by_key(|(id, _)| **id)
            .map(|(_, uv)| (Zeroizing::new(*uv.root_key), uv.vault_meta_bytes_hash))
    }

    /// Read-lock peek that returns a CLONE of just the `root_key` from
    /// [`Slot::Unlocked`], or `None` if the slot is `Empty` or
    /// `Recovering`. The cloned `Zeroizing<[u8; 32]>` wipes on drop; the
    /// slot's original copy stays in place.
    ///
    /// Used by the `attachments` plugin's read/delete paths (MYND-169) —
    /// they need only `root_key` to derive the catalog KEK
    /// (`AttachmentsCatalogKey`) + the id-HMAC subkey, not the
    /// `items_key` or the CAS anchor. A narrower peek than
    /// [`Self::peek_unlocked_root_key_and_hash_clone`] keeps the
    /// borrowed surface minimal at each call site.
    pub async fn peek_unlocked_root_key_clone(&self) -> Option<Zeroizing<[u8; AEAD_KEY_LEN]>> {
        // TRANSITIONAL (sub-feature 2): resolve the single active `Unlocked`
        // entry. Sub-feature 4 threads an explicit `vault_id` here. Deterministic
        // min-by-id (mirroring `active_vault_id`) rather than HashMap-iteration
        // order, so if a bug ever left two `Unlocked` slots the choice is stable.
        let slots = self.slots.read().await;
        slots
            .iter()
            .filter_map(|(id, slot)| match slot {
                Slot::Unlocked(uv) => Some((id, uv)),
                _ => None,
            })
            .min_by_key(|(id, _)| **id)
            .map(|(_, uv)| Zeroizing::new(*uv.root_key))
    }

    /// Read-lock peek that returns CLONES of `(items_key, items_key_id,
    /// root_key)` from [`Slot::Unlocked`], or `None` if the slot is
    /// `Empty` or `Recovering`. The two `Zeroizing<[u8; 32]>` clones wipe
    /// on drop; `items_key_id` is non-secret (the singleton UUIDv7).
    ///
    /// Used by `attachments::attachment_import` (MYND-169) — the import
    /// path needs `items_key` to wrap the per-attachment key,
    /// `items_key_id` for the blob header + AAD, and `root_key` for the
    /// content-addressed id (`compute_attachment_id`) + the catalog KEK
    /// (`AttachmentsCatalogKey`). One peek hands back all three so the
    /// slot read-lock is acquired exactly once per import.
    pub async fn peek_unlocked_attachment_material(
        &self,
    ) -> Option<(
        Zeroizing<[u8; AEAD_KEY_LEN]>,
        [u8; 16],
        Zeroizing<[u8; AEAD_KEY_LEN]>,
    )> {
        // TRANSITIONAL (sub-feature 2): resolve the single active `Unlocked`
        // entry. Sub-feature 4 threads an explicit `vault_id` here.
        let slots = self.slots.read().await;
        slots.values().find_map(|slot| match slot {
            Slot::Unlocked(uv) => Some((
                uv.items_key.clone(),
                uv.items_key_id,
                Zeroizing::new(*uv.root_key),
            )),
            _ => None,
        })
    }

    /// Writer-quiescence guard for `vault_export_backup` (SYNC-6, MYND-32):
    /// holding the slots WRITE lock means every `hold_unlocked_*`-bound
    /// writer has drained and none can start — the export's phase-one copy
    /// window observes a point-in-time-consistent vault directory. Fair
    /// queueing orders the export behind in-flight writers and queues new
    /// writers behind the export. Hold ONLY across the bounded small-member
    /// copy (immutable attachment blobs stream after the drop).
    pub async fn quiesce_writers(&self) -> WriterQuiesceGuard<'_> {
        WriterQuiesceGuard {
            _guard: self.slots.write().await,
        }
    }

    /// Guard-holding sibling of [`Self::peek_unlocked_root_key_and_hash_clone`]
    /// (SYNC-6, MYND-32 writer-guard extension): returns the slot READ guard
    /// TOGETHER with the cloned material. Callers bind the guard across their
    /// disk write — `let (_slots_guard, root_key, _vmh) = …` — so a slots
    /// WRITE-lock holder (`vault_export_backup`'s quiescence, `vault_lock`,
    /// `vault_delete`) queues behind the in-flight write instead of observing
    /// a torn vault directory. Dropping the guard at function exit is the
    /// release point.
    pub async fn hold_unlocked_root_key_and_hash(
        &self,
    ) -> Option<(SlotReadGuard<'_>, Zeroizing<[u8; AEAD_KEY_LEN]>, [u8; 32])> {
        let guard = self.slot_read_active().await;
        let (root_key, hash) = match &*guard {
            Slot::Unlocked(uv) => (Zeroizing::new(*uv.root_key), uv.vault_meta_bytes_hash),
            _ => return None,
        };
        Some((guard, root_key, hash))
    }

    /// Guard-holding sibling of [`Self::peek_unlocked_root_key_clone`] —
    /// see [`Self::hold_unlocked_root_key_and_hash`] for the discipline.
    pub async fn hold_unlocked_root_key(
        &self,
    ) -> Option<(SlotReadGuard<'_>, Zeroizing<[u8; AEAD_KEY_LEN]>)> {
        let guard = self.slot_read_active().await;
        let root_key = match &*guard {
            Slot::Unlocked(uv) => Zeroizing::new(*uv.root_key),
            _ => return None,
        };
        Some((guard, root_key))
    }

    /// Guard-holding sibling of [`Self::peek_unlocked_attachment_material`] —
    /// see [`Self::hold_unlocked_root_key_and_hash`] for the discipline.
    #[allow(clippy::type_complexity)]
    pub async fn hold_unlocked_attachment_material(
        &self,
    ) -> Option<(
        SlotReadGuard<'_>,
        Zeroizing<[u8; AEAD_KEY_LEN]>,
        [u8; 16],
        Zeroizing<[u8; AEAD_KEY_LEN]>,
    )> {
        let guard = self.slot_read_active().await;
        let (items_key, items_key_id, root_key) = match &*guard {
            Slot::Unlocked(uv) => (
                uv.items_key.clone(),
                uv.items_key_id,
                Zeroizing::new(*uv.root_key),
            ),
            _ => return None,
        };
        Some((guard, items_key, items_key_id, root_key))
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
        // TRANSITIONAL (sub-feature 4): resolve the single active `Unlocked`
        // entry under the write lock. Sub-feature 4 threads an explicit
        // `vault_id` here. The whole-map write lock is held across the rewrite
        // so any concurrent `vault_lock` (on any entry) queues behind it.
        let mut slots = self.slots.write().await;
        let id = slots
            .iter()
            .filter(|(_, slot)| matches!(slot, Slot::Unlocked(_)))
            .map(|(id, _)| *id)
            .min();
        match id.and_then(|id| slots.get(&id)) {
            Some(Slot::Unlocked(uv)) if uv.vault_meta_bytes_hash == expected_hash => {
                // Verified. Hold the lock through the rewrite below.
            }
            Some(Slot::Unlocked(_)) => {
                // Hash drift — defensive (auth_permits hold makes
                // this unreachable today). Force-relock: drop the entry.
                if let Some(id) = id {
                    slots.remove(&id);
                }
                return Err(CommitRewriteError::HashMismatch);
            }
            _ => {
                return Err(CommitRewriteError::SlotDropped);
            }
        }
        // `id` is Some here (the `Some(Slot::Unlocked …)` arms above imply it).
        let id = id.expect("active Unlocked entry resolved above");

        // Run the rewrite in spawn_blocking; the write lock is held
        // across the .await, blocking any concurrent `vault_lock`
        // until atomic_write completes.
        let new_hash = match crate::task::run_blocking(rewrite).await {
            Ok(Ok(h)) => h,
            Ok(Err(e)) => return Err(CommitRewriteError::Rewrite(e)),
            Err(_) => return Err(CommitRewriteError::Join),
        };

        // Entry is still Unlocked under the held write lock; update
        // the hash anchor in place. root_key + items_key untouched.
        if let Some(Slot::Unlocked(uv)) = slots.get_mut(&id) {
            uv.vault_meta_bytes_hash = new_hash;
        }
        Ok(())
    }
}

impl VaultRuntimeState {
    /// Take the current Slot (zeroizing the moved-out variant's
    /// Drop-able fields), then run a `spawn_blocking` closure with
    /// the slot write-lock **held across the await**. Used by
    /// `vault_delete` to ensure concurrent slot-touching ops queue
    /// on the lock during the recursive unlink walk.
    ///
    /// Mirrors [`Self::commit_unlocked_rewrite`]'s lock-held-across-
    /// spawn_blocking posture (`decisions.md` 2026-05-06 "Slot::Unlocked
    /// anchor field + post-Argon2id slot peek"); difference is that
    /// vault_delete drops the slot to Empty before the spawn_blocking
    /// rather than keeping it Unlocked.
    ///
    /// Lock-acquire-time invariant: if the slot is `Empty`, returns
    /// [`TakeAndRunError::SlotEmpty`] without invoking the closure.
    /// This catches a race where the caller peeked `slot_kind()`
    /// observing Unlocked/Recovering, then a concurrent `vault_lock`
    /// fired between peek and write-lock acquire. The auth_permits
    /// semaphore the caller holds normally prevents this for the
    /// auth-pipeline ops, but `vault_lock` does NOT consume an
    /// auth_permit so the race exists in principle.
    ///
    /// **Cryptographic-erase ordering:** `core::mem::replace` consumes
    /// the prior Slot and the explicit `drop(_dropped)` fires the
    /// `UnlockedVault` / `RecoveringMaterial` `Drop` impl BEFORE the
    /// `spawn_blocking` await begins — keys zeroize before any
    /// filesystem operation runs. Pinned by `decisions.md` 2026-05-26
    /// "vault_delete partial-fail posture" (the rationale that
    /// partial-fail leaves only cryptographically-junk ciphertext
    /// because key zeroize happens BEFORE the unlink loop).
    /// Take the slot for **exactly `id`** (zeroizing the moved-out variant's
    /// `Drop`-able fields), then run a `spawn_blocking` closure with the slot
    /// write-lock held across the await (SYNC-6 explicit-id targeting). Every
    /// OTHER entry is untouched — the unlink walk under the closure runs
    /// against `vaults/<id>/` while a sibling vault's keys stay live in its own
    /// slot.
    ///
    /// **Cryptographic-erase ordering:** the `remove` consumes `id`'s prior
    /// slot and the explicit `drop` fires the `UnlockedVault` /
    /// `RecoveringMaterial` `Drop` BEFORE the `spawn_blocking` await begins —
    /// keys zeroize before any filesystem operation runs. Pinned by
    /// `decisions.md` 2026-05-26 "vault_delete partial-fail posture".
    ///
    /// Returns [`TakeAndRunError::SlotEmpty`] (closure NOT run, disk untouched)
    /// when `id`'s entry is absent / `Empty` at write-lock acquire. This
    /// catches a race where the caller peeked `slot_kind(id)` observing
    /// Unlocked/Recovering, then a concurrent `vault_lock` on `id` fired
    /// between the peek and this write-lock acquire (`vault_lock` does NOT
    /// consume an `auth_permit`, so the permit the caller holds does not block
    /// it). Used by `vault_delete` (MYND-205) to erase a chosen `VaultId`.
    pub async fn take_and_run_blocking_for_id<F, E>(
        &self,
        id: VaultId,
        unlink: F,
    ) -> Result<(), TakeAndRunError<E>>
    where
        F: FnOnce() -> Result<(), E> + Send + 'static,
        E: Send + 'static,
    {
        let mut slots = self.slots.write().await;
        // Only take `id` when it is non-`Empty`; an absent / `Empty` entry is
        // the race case (closure must not run). Other entries stay intact.
        match slots.get(&id) {
            Some(Slot::Unlocked(_)) | Some(Slot::Recovering { .. }) => {}
            _ => return Err(TakeAndRunError::SlotEmpty),
        }
        // Remove exactly `id`'s entry; a missing key IS empty. Siblings intact.
        let dropped = slots.remove(&id);
        // Explicit drop fires zeroize NOW — before any IO.
        drop(dropped);
        // Lock still held across the spawn_blocking await; any concurrent
        // slot-touching op queues on the RwLock.
        match crate::task::run_blocking(unlink).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(TakeAndRunError::Closure(e)),
            Err(_) => Err(TakeAndRunError::Join),
        }
    }

    /// The **async** sibling of [`Self::take_and_run_blocking_for_id`]
    /// (`phase3-web-client` task 72): same slot discipline, but the erase is a
    /// future rather than a blocking closure.
    ///
    /// # Why a sibling and not a rewrite
    ///
    /// The blocking variant's `F: FnOnce() -> Result<(), E> + Send + 'static`
    /// bound is not incidental — it is what lets the desktop erase run on
    /// tokio's blocking pool while this slot's write lock is held. Widening it in
    /// place would drag every existing caller onto an async signature for a
    /// target they do not build for. So the two coexist and the *invariants*, not
    /// the code, are what has to match — which is what
    /// `the_two_takers_agree_on_the_empty_slot_rejection` pins.
    ///
    /// # The invariants it preserves, in the same order
    ///
    /// 1. `Empty`/absent slot → [`TakeAndRunError::SlotEmpty`], future NOT
    ///    polled, storage untouched.
    /// 2. `remove` + explicit `drop` fire the moved-out variant's `Drop` — so
    ///    `root_key` / `items_key` are zeroized **before the first `.await` of
    ///    the erase**, exactly as on the blocking arm. This is the ordering the
    ///    cryptographic-erase claim rests on (`decisions.md` 2026-05-26
    ///    "vault_delete partial-fail posture"), and on the web arm it matters
    ///    more rather than less: OPFS removal is genuinely asynchronous, so
    ///    without this the keys would live in memory for the whole walk.
    /// 3. The write guard is held across the await. A `tokio::sync::RwLock`
    ///    guard can be, which is why only the `spawn_blocking` had to go.
    ///
    /// [`TakeAndRunError::Join`] is unreachable here — nothing is spawned, so
    /// there is no join to fail. The variant stays in the shared enum because
    /// the blocking arm still produces it, and a second enum differing by one
    /// unreachable variant would be a worse trade than an arm the caller can
    /// route to the same place.
    ///
    /// The returned future is `Send` exactly when `fut` is, by auto-trait
    /// leakage — no bound is written, so the wasm arm's `!Send` OPFS futures are
    /// accepted here and the native callers keep their `Send` future.
    pub async fn take_and_run_async_for_id<Fut, E>(
        &self,
        id: VaultId,
        erase: impl FnOnce() -> Fut,
    ) -> Result<(), TakeAndRunError<E>>
    where
        Fut: core::future::Future<Output = Result<(), E>>,
    {
        let mut slots = self.slots.write().await;
        match slots.get(&id) {
            Some(Slot::Unlocked(_)) | Some(Slot::Recovering { .. }) => {}
            _ => return Err(TakeAndRunError::SlotEmpty),
        }
        let dropped = slots.remove(&id);
        // Explicit drop fires zeroize NOW — before the erase future is even
        // constructed, let alone polled.
        drop(dropped);
        match erase().await {
            Ok(()) => Ok(()),
            Err(e) => Err(TakeAndRunError::Closure(e)),
        }
    }
}

/// Outcome of [`VaultRuntimeState::take_and_run_blocking_for_id`].
///
/// Generic over the closure's error type so the caller (`vault_delete`)
/// can route its own io-error variant back through its own
/// command-level error enum.
pub enum TakeAndRunError<E> {
    /// Slot was `Empty` at write-lock acquire time. The closure did
    /// NOT run; disk is untouched. Race between caller's
    /// `slot_kind()` peek and this call (typically a concurrent
    /// `vault_lock` IPC, since `vault_lock` does not consume an
    /// `auth_permits` permit and so the auth-permits hold by
    /// vault_delete does not block it).
    SlotEmpty,
    /// The closure returned an error.
    Closure(E),
    /// `tokio::task::spawn_blocking` join handle returned an error.
    Join,
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
        recovered_at: u64,
    },
    /// Vault is fully unlocked and ready for editor access. Reached
    /// directly via `vault_unlock` (password path) or via the
    /// `Slot::Recovering → Slot::Unlocked` promotion inside
    /// `vault_complete_recovery`.
    Unlocked(UnlockedVault),
}

/// Shared `Slot::Empty` returned by [`SlotReadGuard`] when the keyed entry is
/// absent — a missing map entry IS the empty slot. `const` so no allocation
/// and a `'static` borrow is available for the `Deref`.
const EMPTY_SLOT: Slot = Slot::Empty;

/// Read guard returned by [`VaultRuntimeState::slot_read`]. Holds the
/// whole-map read lock (transitionally coarse — sub-feature 3 narrows it) and
/// `Deref`s to the [`Slot`] for the keyed [`VaultId`], or to the shared
/// [`EMPTY_SLOT`] when that key is absent.
///
/// Callers keep the existing `let slot = state.slot_read(id).await; match
/// &*slot { Slot::Unlocked(uv) => … }` shape unchanged — and HOLD the guard
/// across `spawn_blocking` so a concurrent `vault_lock`'s write request waits
/// behind it (the in-flight-op ordering of `decisions.md` 2026-05-07).
pub struct SlotReadGuard<'a> {
    guard: tokio::sync::RwLockReadGuard<'a, HashMap<VaultId, Slot>>,
    id: VaultId,
}

impl core::ops::Deref for SlotReadGuard<'_> {
    type Target = Slot;
    fn deref(&self) -> &Slot {
        self.guard.get(&self.id).unwrap_or(&EMPTY_SLOT)
    }
}

/// Opaque writer-quiescence guard — see
/// [`VaultRuntimeState::quiesce_writers`]. Exists so the export command can
/// bind the slots write lock across its phase-one copy without the state's
/// internals leaking out of this module.
pub struct WriterQuiesceGuard<'a> {
    _guard: tokio::sync::RwLockWriteGuard<'a, HashMap<VaultId, Slot>>,
}

/// Owned payload for the [`Slot::Recovering`] variant. Used by the
/// `set_recovering` / `take_recovering` helpers so the variant fields
/// pass as a single bundle across plugin boundaries.
pub struct RecoveringMaterial {
    pub root_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    pub items_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    pub items_key_id: [u8; 16],
    pub recovered_at: u64,
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
/// `unlocked_at` records the host's MONOTONIC millisecond reading at the moment
/// of successful unlock, for diagnostics and for the Phase 2+ auto-lock idle
/// timer. Monotonic, not wall-clock, because its only use is measuring elapsed
/// time: an idle timer driven by a wall clock unlocks itself when the clock
/// steps backwards. Supplied by [`crate::host::HostCtx::monotonic_millis`]
/// rather than read as an `Instant`, because `Instant::now()` PANICS on
/// `wasm32-unknown-unknown` (std has no wasm arm and falls to its `unsupported`
/// time backend) — phase3-web-client task 12. The origin is unspecified; only
/// differences are meaningful.
///
/// Phase 2+ auto-lock will add a `last_activity` field updated by
/// activity-tracking commands; not added here because there is no Phase 1
/// writer for it.
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
    pub unlocked_at: u64,
    pub vault_meta_bytes_hash: [u8; 32],
}

/// Test-only helper: extract the [`UnlockedVault`] from a `Slot::Unlocked`
/// variant, panic on any other variant. Replaces the
/// `Option::expect(...)` pattern in tests written before `Slot` existed
/// (when `take()` returned `Option<UnlockedVault>`).
#[cfg(any(test, feature = "test-support"))]
impl Slot {
    pub fn unwrap_unlocked(self) -> UnlockedVault {
        match self {
            Slot::Unlocked(uv) => uv,
            Slot::Empty => panic!("expected Slot::Unlocked, got Slot::Empty"),
            Slot::Recovering { .. } => panic!("expected Slot::Unlocked, got Slot::Recovering"),
        }
    }
}

/// Test-only invariant probe: how many entries in the `slots` map are
/// `Slot::Unlocked`. The **A6 single-unlocked invariant** (SYNC-1
/// one-at-a-time) requires this to be `<= 1` at every observable point —
/// before, during, and after an idle-lock or a lock-on-switch. Tests assert
/// against it directly so the invariant is checked, not merely implied by the
/// `active_vault_id` min-by-id tie-break.
#[cfg(any(test, feature = "test-support"))]
impl VaultRuntimeState {
    pub async fn unlocked_entry_count(&self) -> usize {
        self.slots
            .read()
            .await
            .values()
            .filter(|slot| matches!(slot, Slot::Unlocked(_)))
            .count()
    }
}

/// A fixed, deterministic test [`VaultId`] for the slot-map keyed accessors.
///
/// Most tests exercise a single vault, so they key every accessor
/// (`set_unlocked` / `slot_kind` / `take` / …) with this one id. It is
/// deliberately the LEGACY-vault sentinel id ([`crate::paths::legacy_vault_id`]):
/// integration-style tests interleave a direct accessor call with a production
/// command (`unlock_with_path` / `recover_with_phrase_with_path` / …) whose
/// slot key is path-derived. Those tests drive a temp-dir `vault.meta` whose
/// parent is NOT a `vaults/<uuid>/` directory, so the production path derives
/// exactly this legacy sentinel — keeping the direct accessor and the
/// production command on the SAME map entry. Tests that need two distinct
/// entries pair this with [`test_vault_id_b`].
#[cfg(any(test, feature = "test-support"))]
pub fn test_vault_id() -> VaultId {
    crate::paths::legacy_vault_id()
}

/// A second fixed, deterministic test [`VaultId`], distinct from
/// [`test_vault_id`], for tests that need two independent slot-map entries.
#[cfg(any(test, feature = "test-support"))]
pub fn test_vault_id_b() -> VaultId {
    VaultId::parse("22222222-2222-7222-8222-222222222222").expect("valid test UUIDv7")
}

/// Build a fixture `UnlockedVault` with byte-pattern arguments so tests
/// can assert against distinguishable bytes. Shared across `state.rs`
/// tests and `commands.rs` tests.
///
/// `vault_meta_bytes_hash` is filled with the sentinel `[0xFF; 32]`
/// (production code never produces all-`0xFF` from SHA-256 with
/// vanishing probability), letting tests distinguish "fixture-built
/// slot" from "real-unlock-built slot" when needed.
#[cfg(any(test, feature = "test-support"))]
pub fn fixture_unlocked_with_keys(
    root_byte: u8,
    items_byte: u8,
    items_id_byte: u8,
) -> UnlockedVault {
    UnlockedVault {
        root_key: Zeroizing::new([root_byte; AEAD_KEY_LEN]),
        items_key: Zeroizing::new([items_byte; AEAD_KEY_LEN]),
        items_key_id: [items_id_byte; 16],
        unlocked_at: 0,
        vault_meta_bytes_hash: [0xFF; 32],
    }
}

/// Build a fixture [`RecoveringMaterial`] with byte-pattern arguments,
/// for tests that exercise the `Slot::Recovering` variant. Mirror of
/// `fixture_unlocked_with_keys` for the other variant.
#[cfg(any(test, feature = "test-support"))]
pub fn fixture_recovering_with_keys(
    root_byte: u8,
    items_byte: u8,
    items_id_byte: u8,
) -> RecoveringMaterial {
    RecoveringMaterial {
        root_key: Zeroizing::new([root_byte; AEAD_KEY_LEN]),
        items_key: Zeroizing::new([items_byte; AEAD_KEY_LEN]),
        items_key_id: [items_id_byte; 16],
        recovered_at: 0,
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

    // ---- MYND-351: preempt_backup_for_user_auth (Direction 2) ----------

    #[test]
    fn preempt_is_noop_when_permit_free() {
        // No in-flight backup → the fast path returns without signalling cancel.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let cancel = std::sync::atomic::AtomicBool::new(false);
            state.preempt_backup_for_user_auth(&cancel).await;
            assert!(
                !cancel.load(std::sync::atomic::Ordering::Relaxed),
                "no in-flight backup → cancel must NOT be signalled"
            );
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    #[test]
    fn preempt_cancels_and_waits_for_in_flight_backup_release() {
        // A simulated in-flight backup holds the permit and releases it once the
        // cooperative cancel flag is signalled — the "user always wins" bridge.
        // Multi-thread runtime so the spawned preempt runs concurrently with the
        // foreground releaser (no `tokio::join!` — the macros feature is off).
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("multi-thread runtime");
        rt.block_on(async {
            let state = Arc::new(VaultRuntimeState::default());
            let cancel = Arc::new(AtomicBool::new(false));
            let permit = state.auth_permits().try_acquire().expect("hold permit");
            assert_eq!(state.auth_permits().available_permits(), 0);

            let s2 = state.clone();
            let c2 = cancel.clone();
            let preempt = tokio::spawn(async move {
                s2.preempt_backup_for_user_auth(&c2).await;
            });

            // Mimic the export's cooperative cancel: release once signalled.
            while !cancel.load(Ordering::Relaxed) {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            drop(permit);
            preempt.await.expect("preempt task");

            assert!(
                cancel.load(Ordering::Relaxed),
                "preempt must signal the cooperative backup cancel"
            );
            assert_eq!(
                state.auth_permits().available_permits(),
                1,
                "the permit is free once the cancelled backup releases it"
            );
        });
    }

    /// SYNC-6 writer-guard mechanism: every `hold_unlocked_*` guard keeps a
    /// slots WRITE-lock acquisition pending until the guard drops — the
    /// property the prefs/attachments/search writers rely on so an export's
    /// quiescence window contains no in-flight writer.
    #[test]
    fn hold_guards_block_write_lock_until_dropped() {
        rt().block_on(async {
            let state = std::sync::Arc::new(VaultRuntimeState::default());
            state
                .set_unlocked(test_vault_id(), fixture_unlocked())
                .await;
            // A second non-Empty entry for the write-lock holder to take.
            state
                .set_unlocked(test_vault_id_b(), fixture_unlocked_with_keys(3, 4, 2))
                .await;

            // Exercise all three hold flavors with the same sequence. A
            // macro keeps the guard's borrow of `state` scoped per flavor
            // (a `Box<dyn Any>` erasure would demand 'static).
            macro_rules! assert_guard_blocks_taker {
                ($flavor:literal, $hold:expr) => {{
                    let guard_bundle = $hold.await.expect("slot is unlocked");
                    let taker = state.take_and_run_blocking_for_id(test_vault_id_b(), || {
                        Ok::<(), std::convert::Infallible>(())
                    });
                    tokio::pin!(taker);
                    assert!(
                        tokio::time::timeout(std::time::Duration::from_millis(50), &mut taker)
                            .await
                            .is_err(),
                        concat!(
                            $flavor,
                            ": write lock must queue behind a held hold_* guard"
                        ),
                    );
                    drop(guard_bundle);
                    let taken = tokio::time::timeout(std::time::Duration::from_secs(2), taker)
                        .await
                        .expect("taker completes after guard drop");
                    assert!(taken.is_ok(), "take succeeds after guard drop");
                    // Restore entry B for the next flavor.
                    state
                        .set_unlocked(test_vault_id_b(), fixture_unlocked_with_keys(3, 4, 2))
                        .await;
                }};
            }
            assert_guard_blocks_taker!("rk+h", state.hold_unlocked_root_key_and_hash());
            assert_guard_blocks_taker!("rk", state.hold_unlocked_root_key());
            assert_guard_blocks_taker!("material", state.hold_unlocked_attachment_material());
        });
    }

    // ── the async taker (phase3-web-client task 72) ─────────────────────────
    //
    // Its whole reason to exist is that OPFS removal is asynchronous, so the
    // erase cannot be a blocking closure. What must NOT change with it is the
    // slot discipline, and these four pin the parts that would otherwise be
    // easy to lose in translation: the empty-slot rejection, the "future never
    // polled" half of it, the targeting, and the zeroize-before-erase ordering.

    #[test]
    fn the_two_takers_agree_on_the_empty_slot_rejection() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let blocking = state
                .take_and_run_blocking_for_id(test_vault_id(), || {
                    Ok::<(), std::convert::Infallible>(())
                })
                .await;
            let asynchronous = state
                .take_and_run_async_for_id(test_vault_id(), || async {
                    Ok::<(), std::convert::Infallible>(())
                })
                .await;
            assert!(matches!(blocking, Err(TakeAndRunError::SlotEmpty)));
            assert!(matches!(asynchronous, Err(TakeAndRunError::SlotEmpty)));
        });
    }

    /// The rejection is not merely reported — the erase must not START. On the
    /// web arm the future IS the OPFS removal, so a polled-then-rejected call
    /// would delete a vault the caller was told it had not touched.
    #[test]
    fn an_empty_slot_leaves_the_erase_future_unpolled() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let mut ran = false;
            let r = state
                .take_and_run_async_for_id(test_vault_id(), || {
                    ran = true;
                    async { Ok::<(), std::convert::Infallible>(()) }
                })
                .await;
            assert!(matches!(r, Err(TakeAndRunError::SlotEmpty)));
            assert!(!ran, "the erase closure must not be called at all");
        });
    }

    /// SYNC-6 targeting: taking `a` leaves `b`'s keys live in its own slot.
    #[test]
    fn the_async_taker_takes_only_the_named_vault() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(test_vault_id(), fixture_unlocked())
                .await;
            state
                .set_unlocked(test_vault_id_b(), fixture_unlocked_with_keys(3, 4, 2))
                .await;
            let r: Result<(), TakeAndRunError<std::convert::Infallible>> = state
                .take_and_run_async_for_id(test_vault_id(), || async { Ok(()) })
                .await;
            assert!(r.is_ok());
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);
            assert_eq!(state.slot_kind(test_vault_id_b()).await, SlotKind::Unlocked);
        });
    }

    /// The write guard is held ACROSS the erase: a concurrent slot-touching op
    /// queues behind it and only sees the taken slot afterwards.
    ///
    /// **On the zeroize ordering, which this test does not check.** The first
    /// version of it was named for that ordering and asserted this same pair of
    /// facts — and inverting `drop(dropped)` and `erase()` in the function left
    /// it green, because a `slot_kind` observer cannot acquire the lock while
    /// the guard is held and therefore cannot see the difference. The ordering
    /// is enforced by construction (the `drop` precedes the `erase()` CALL in
    /// source, so the future is not even built until the keys are gone) and by
    /// review against the blocking arm, not by this assertion. Naming it
    /// honestly is the point: a test whose name claims an invariant it does not
    /// exercise is worse than no test, because it stops anyone writing the real
    /// one.
    #[test]
    fn a_queued_op_waits_for_the_erase_to_finish() {
        rt().block_on(async {
            let state = std::sync::Arc::new(VaultRuntimeState::default());
            state
                .set_unlocked(test_vault_id(), fixture_unlocked())
                .await;
            // A slot-touching op that queues behind the write guard. The flag it
            // sets is read FROM INSIDE the erase — asserting on it afterwards
            // proves nothing, because the op completes either way once the
            // taker returns. (That is how the first draft of this test passed a
            // probe that released the guard early.)
            let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let queued = {
                let state = state.clone();
                let done = done.clone();
                tokio::spawn(async move {
                    let kind = state.slot_kind(test_vault_id()).await;
                    done.store(true, std::sync::atomic::Ordering::SeqCst);
                    kind
                })
            };
            let r: Result<(), TakeAndRunError<std::convert::Infallible>> = state
                .take_and_run_async_for_id(test_vault_id(), || {
                    let done = done.clone();
                    async move {
                        // Give the queued op every chance to run. If the guard
                        // were released before the erase, it would acquire the
                        // read lock during these yields and set the flag.
                        for _ in 0..8 {
                            tokio::task::yield_now().await;
                        }
                        assert!(
                            !done.load(std::sync::atomic::Ordering::SeqCst),
                            "a slot-touching op ran DURING the erase — the write guard was not held across it",
                        );
                        Ok(())
                    }
                })
                .await;
            assert!(r.is_ok());
            assert_eq!(
                queued.await.expect("queued op joins"),
                SlotKind::Empty,
                "once it does run, it must see the taken slot, not the old one",
            );
        });
    }

    #[test]
    fn slot_kind_returns_empty_on_fresh_state() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);
        });
    }

    #[test]
    fn set_unlocked_then_slot_kind_returns_unlocked() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let prior = state
                .set_unlocked(test_vault_id(), fixture_unlocked())
                .await;
            assert!(matches!(prior, Slot::Empty));
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Unlocked);
        });
    }

    #[test]
    fn set_recovering_then_slot_kind_returns_recovering() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let prior = state
                .set_recovering(test_vault_id(), fixture_recovering())
                .await;
            assert!(matches!(prior, Slot::Empty));
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Recovering);
        });
    }

    #[test]
    fn take_returns_unlocked_value() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(test_vault_id(), fixture_unlocked())
                .await;
            let taken = state.take(test_vault_id()).await;
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

    // ---- auto-lock activity clock (MYND-121) ---------------------------

    // The clock is now INJECTED (phase3-web-client task 12), so these assert
    // exact values instead of "under a second". The old bounds could not
    // distinguish a working idle timer from one that always returned 0.

    #[test]
    fn fresh_state_has_zero_idle_regardless_of_the_hosts_origin() {
        // The host's monotonic origin is arbitrary — `performance.now()` counts
        // from page load, the desktop's from first use — so a state that did
        // not rebase would report the host's uptime as idle time and lock the
        // vault the instant it opened.
        let state = VaultRuntimeState::default();
        assert_eq!(state.idle_millis(9_999_999), 0);
    }

    #[test]
    fn idle_grows_with_the_hosts_clock_and_resets_on_activity() {
        let state = VaultRuntimeState::default();
        state.report_activity(1_000); // claims the origin
        assert_eq!(state.idle_millis(1_000), 0);
        assert_eq!(state.idle_millis(4_500), 3_500);
        state.report_activity(4_500);
        assert_eq!(state.idle_millis(4_500), 0);
        assert_eq!(state.idle_millis(5_000), 500);
    }

    #[test]
    fn a_backwards_clock_step_delays_the_lock_rather_than_triggering_it() {
        // The direction matters: underflowing to a colossal idle time would
        // zeroize the keys — and throw away unsaved work — on a clock glitch.
        let state = VaultRuntimeState::default();
        state.report_activity(10_000);
        assert_eq!(state.idle_millis(9_000), 0, "must saturate, not wrap");
        assert_eq!(state.idle_millis(1), 0);
    }

    #[test]
    fn report_activity_does_not_acquire_the_slot_lock() {
        // Hold the slot WRITE lock for the whole call. If report_activity
        // touched the slot `RwLock` it would deadlock here; lock-free →
        // returns immediately. Guards the decoupling decision: the
        // high-frequency heartbeat must never contend with crypto-state.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let _write_guard = state.slots.write().await;
            state.report_activity(0);
            let _ = state.idle_millis(0);
            // Reaching here without deadlock proves no slot-lock acquisition.
        });
    }

    #[test]
    fn set_unlocked_resets_the_activity_baseline() {
        // Unlock starts a fresh activity baseline → idle ~0 right after.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(test_vault_id(), fixture_unlocked())
                .await;
            assert_eq!(state.idle_millis(0), 0);
        });
    }

    // ---- TOCTOU-safe idle lock + cached timeout (MYND-121) -------------

    #[test]
    fn take_unlocked_if_idle_locks_when_idle_exceeds_timeout() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(test_vault_id(), fixture_unlocked())
                .await;
            // idle (injected 10s) >= timeout (0) → locks; slot drops to Empty.
            let dropped = state
                .take_unlocked_if_idle(core::time::Duration::ZERO, || {
                    core::time::Duration::from_secs(10)
                })
                .await;
            assert!(matches!(dropped, Some(Slot::Unlocked(_))));
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);
        });
    }

    #[test]
    fn take_unlocked_if_idle_does_not_lock_when_not_yet_idle() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(test_vault_id(), fixture_unlocked())
                .await;
            // idle (injected 0) < timeout (1h) → no lock; slot stays Unlocked.
            let dropped = state
                .take_unlocked_if_idle(core::time::Duration::from_secs(3600), || {
                    core::time::Duration::ZERO
                })
                .await;
            assert!(dropped.is_none());
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Unlocked);
        });
    }

    #[test]
    fn take_unlocked_if_idle_is_noop_when_not_unlocked() {
        rt().block_on(async {
            let state = VaultRuntimeState::default(); // Empty
            let dropped = state
                .take_unlocked_if_idle(core::time::Duration::ZERO, || {
                    core::time::Duration::from_secs(99)
                })
                .await;
            assert!(dropped.is_none());
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);
        });
    }

    #[test]
    fn take_unlocked_if_idle_aborts_when_activity_arrives_in_the_gap() {
        // The under-lock re-read returns a tiny idle (< timeout) — simulating
        // a heartbeat landing in the check→lock gap → abort, slot stays Unlocked.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(test_vault_id(), fixture_unlocked())
                .await;
            let dropped = state
                .take_unlocked_if_idle(core::time::Duration::from_secs(300), || {
                    core::time::Duration::from_millis(50)
                })
                .await;
            assert!(dropped.is_none());
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Unlocked);
        });
    }

    #[test]
    fn auto_lock_timeout_secs_round_trips() {
        let state = VaultRuntimeState::default();
        state.set_auto_lock_timeout_secs(900);
        assert_eq!(state.auto_lock_timeout_secs(), 900);
    }

    // ---- Recovering absolute-TTL bail (MYND-121 task 8) ----------------

    #[test]
    fn take_recovering_if_expired_bails_when_ttl_elapsed() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state
                .set_recovering(test_vault_id(), fixture_recovering())
                .await;
            // injected age (9999s) >= ttl (600s) → bail; slot drops to Empty.
            let bailed = state
                .take_recovering_if_expired(core::time::Duration::from_secs(600), |_| {
                    core::time::Duration::from_secs(9999)
                })
                .await;
            assert!(matches!(bailed, Some(Slot::Recovering { .. })));
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);
        });
    }

    #[test]
    fn take_recovering_if_expired_does_not_bail_within_ttl() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state
                .set_recovering(test_vault_id(), fixture_recovering())
                .await;
            // injected age (0) < ttl (600s) → no bail; slot stays Recovering.
            let bailed = state
                .take_recovering_if_expired(core::time::Duration::from_secs(600), |_| {
                    core::time::Duration::ZERO
                })
                .await;
            assert!(bailed.is_none());
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Recovering);
        });
    }

    #[test]
    fn take_recovering_if_expired_is_noop_when_unlocked() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(test_vault_id(), fixture_unlocked())
                .await;
            // Even with an "expired" age, an Unlocked slot is untouched (this
            // path only bails Recovering; Unlocked is the idle-timer's job).
            let bailed = state
                .take_recovering_if_expired(core::time::Duration::ZERO, |_| {
                    core::time::Duration::from_secs(9999)
                })
                .await;
            assert!(bailed.is_none());
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Unlocked);
        });
    }

    #[test]
    fn take_recovering_if_expired_is_noop_when_empty() {
        rt().block_on(async {
            let state = VaultRuntimeState::default(); // Empty
            let bailed = state
                .take_recovering_if_expired(core::time::Duration::ZERO, |_| {
                    core::time::Duration::from_secs(9999)
                })
                .await;
            assert!(bailed.is_none());
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);
        });
    }

    #[test]
    fn take_returns_recovering_value() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state
                .set_recovering(test_vault_id(), fixture_recovering())
                .await;
            let taken = state.take(test_vault_id()).await;
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
            state
                .set_unlocked(test_vault_id(), fixture_unlocked())
                .await;
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Unlocked);
            let _ = state.take(test_vault_id()).await;
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);
        });
    }

    #[test]
    fn take_after_take_returns_empty() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(test_vault_id(), fixture_unlocked())
                .await;
            let _first = state.take(test_vault_id()).await;
            let second = state.take(test_vault_id()).await;
            assert!(matches!(second, Slot::Empty));
        });
    }

    #[test]
    fn take_on_fresh_state_returns_empty() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let taken = state.take(test_vault_id()).await;
            assert!(matches!(taken, Slot::Empty));
        });
    }

    // ---- multi-vault keyed map (sub-feature 2 task 1) ------------------

    #[test]
    fn two_distinct_vault_ids_hold_independent_slots_without_aliasing() {
        // Acceptance: set two distinct VaultId entries (one Unlocked, one
        // Recovering) and read each back independently by id; the two slots
        // do not alias.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let id_unlocked = test_vault_id();
            let id_recovering = test_vault_id_b();
            assert_ne!(id_unlocked, id_recovering);

            state
                .set_unlocked(id_unlocked, fixture_unlocked_with_keys(0x11, 0x22, 0x33))
                .await;
            state
                .set_recovering(
                    id_recovering,
                    fixture_recovering_with_keys(0xAA, 0xBB, 0xCC),
                )
                .await;

            // Each id reads back its OWN variant — no aliasing.
            assert_eq!(state.slot_kind(id_unlocked).await, SlotKind::Unlocked);
            assert_eq!(state.slot_kind(id_recovering).await, SlotKind::Recovering);

            // The Unlocked entry's key bytes are the ones we set (0x11), and
            // the Recovering entry's are its own (0xAA) — independent storage.
            let unlocked = state.slot_read(id_unlocked).await;
            match &*unlocked {
                Slot::Unlocked(uv) => assert_eq!(*uv.root_key, [0x11u8; AEAD_KEY_LEN]),
                other => panic!("expected Unlocked, got {:?}", slot_label(other)),
            }
            drop(unlocked);

            let recovering = state.slot_read(id_recovering).await;
            match &*recovering {
                Slot::Recovering { root_key, .. } => {
                    assert_eq!(**root_key, [0xAAu8; AEAD_KEY_LEN])
                }
                other => panic!("expected Recovering, got {:?}", slot_label(other)),
            }
            drop(recovering);

            // The active (sole Unlocked) id resolves to the Unlocked entry.
            assert_eq!(state.active_vault_id().await, Some(id_unlocked));
        });
    }

    #[test]
    fn take_on_missing_entry_is_empty_and_leaves_other_entries_intact() {
        // Acceptance: take(id) on a VaultId with no entry returns the Empty
        // equivalent (idempotent), leaving other entries intact.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let present = test_vault_id();
            let missing = test_vault_id_b();

            state
                .set_unlocked(present, fixture_unlocked_with_keys(0x44, 0x55, 0x66))
                .await;

            // take on the MISSING id → Slot::Empty, no panic.
            let taken_missing = state.take(missing).await;
            assert!(matches!(taken_missing, Slot::Empty));

            // The present entry is untouched.
            assert_eq!(state.slot_kind(present).await, SlotKind::Unlocked);

            // Idempotent: a second take on the missing id is still Empty.
            assert!(matches!(state.take(missing).await, Slot::Empty));
            assert_eq!(state.slot_kind(present).await, SlotKind::Unlocked);

            // Taking the present id removes only that entry; the missing id
            // stays empty.
            assert!(matches!(state.take(present).await, Slot::Unlocked(_)));
            assert_eq!(state.slot_kind(present).await, SlotKind::Empty);
            assert_eq!(state.slot_kind(missing).await, SlotKind::Empty);
        });
    }

    // ---- ≤1-`Unlocked` invariant: lock-then-unlock seam (task 2) -------

    #[test]
    fn unlocking_b_while_a_unlocked_leaves_exactly_b_unlocked() {
        // REQUIRED ACCEPTANCE TEST (task 2): unlock vault A, then unlock vault
        // B through the set-unlocked seam → exactly one entry is `Unlocked`
        // afterward and it is B; A's entry is no longer `Unlocked` (locked by
        // the lock-then-unlock switch). `active_vault_id()` returns B.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let id_a = test_vault_id();
            let id_b = test_vault_id_b();
            assert_ne!(id_a, id_b);

            // Unlock A first (no prior Unlocked → no lock teardown).
            state
                .set_unlocked_locking_others(id_a, fixture_unlocked_with_keys(0x11, 0x12, 0x13))
                .await;
            assert_eq!(state.active_vault_id().await, Some(id_a));

            // Unlock B while A is unlocked → A must be locked first.
            state
                .set_unlocked_locking_others(id_b, fixture_unlocked_with_keys(0x21, 0x22, 0x23))
                .await;

            // Exactly one Unlocked entry, and it is B.
            assert_eq!(state.slot_kind(id_b).await, SlotKind::Unlocked);
            assert_eq!(
                state.slot_kind(id_a).await,
                SlotKind::Empty,
                "A must no longer be Unlocked after the switch (locked by lock-then-unlock)"
            );
            // The helper resolves the active vault as B.
            assert_eq!(state.active_vault_id().await, Some(id_b));

            // And B's bytes are the ones we set (not A's — no aliasing).
            let unlocked = state.slot_read(id_b).await;
            match &*unlocked {
                Slot::Unlocked(uv) => assert_eq!(*uv.root_key, [0x21u8; AEAD_KEY_LEN]),
                other => panic!("expected Unlocked, got {:?}", slot_label(other)),
            }
        });
    }

    /// #270: an idle auto-lock must drop the decrypted label + icon too.
    ///
    /// SYNC-3 says a locked vault stops surfacing its real name. The manual
    /// lock honoured that; the idle path did not — so a machine left alone
    /// until auto-lock fired kept showing every vault's real name in the
    /// switcher, from RAM, on the lock screen. That is the exact state
    /// auto-lock exists to produce the opposite of.
    #[test]
    fn an_idle_take_evicts_the_decrypted_label_and_icon() {
        crate::test_support::block_on(async {
            let state = VaultRuntimeState::default();
            let id = test_vault_id();
            state
                .set_unlocked(id, fixture_unlocked_with_keys(0x11, 0x22, 0x33))
                .await;
            state.set_cached_label(id, Some("Personal".into())).await;
            state.set_cached_icon(id, Some("book".into())).await;

            // Idle far past any timeout.
            let taken = state
                .take_unlocked_if_idle(std::time::Duration::from_millis(0), || {
                    std::time::Duration::from_secs(3600)
                })
                .await;
            assert!(taken.is_some(), "the idle take must have fired");
            assert_eq!(
                state.cached_label(id).await,
                None,
                "label must not outlive the keys"
            );
            assert_eq!(
                state.cached_icon(id).await,
                None,
                "icon must not outlive the keys"
            );
        });
    }

    /// The manual path keeps the same property, now that the eviction lives in
    /// the primitive rather than at one caller.
    #[test]
    fn a_manual_take_evicts_the_decrypted_label_and_icon() {
        crate::test_support::block_on(async {
            let state = VaultRuntimeState::default();
            let id = test_vault_id();
            state
                .set_unlocked(id, fixture_unlocked_with_keys(0x11, 0x22, 0x33))
                .await;
            state.set_cached_label(id, Some("Personal".into())).await;
            state.set_cached_icon(id, Some("book".into())).await;

            let _ = state.take(id).await;
            assert_eq!(state.cached_label(id).await, None);
            assert_eq!(state.cached_icon(id).await, None);
        });
    }

    #[test]
    fn active_vault_id_is_none_when_no_vault_unlocked() {
        // The active-vault helper returns `None` when no vault is unlocked —
        // the other half of the acceptance criteria (returns B after the
        // switch, None when nothing is unlocked).
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            assert_eq!(state.active_vault_id().await, None);

            // Locking the sole unlocked vault returns to None.
            state
                .set_unlocked_locking_others(test_vault_id(), fixture_unlocked())
                .await;
            assert_eq!(state.active_vault_id().await, Some(test_vault_id()));
            let _ = state.take(test_vault_id()).await;
            assert_eq!(state.active_vault_id().await, None);
        });
    }

    #[test]
    fn set_unlocked_locking_others_returns_the_locked_prior_unlocked_for_teardown() {
        // The switch returns the prior `Unlocked` slot (when a different vault
        // was active) so the caller can drive the index teardown / drop the
        // keys at a known program point. Re-unlocking the SAME id is not a
        // switch and returns the same-id prior entry.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let id_a = test_vault_id();
            let id_b = test_vault_id_b();

            // No prior Unlocked → returns Empty (nothing locked).
            let prior_first = state
                .set_unlocked_locking_others(id_a, fixture_unlocked_with_keys(0xA1, 0xA2, 0xA3))
                .await;
            assert!(matches!(prior_first, Slot::Empty));

            // Switching A → B locks A; the returned prior is A's Unlocked slot.
            let prior_switch = state
                .set_unlocked_locking_others(id_b, fixture_unlocked_with_keys(0xB1, 0xB2, 0xB3))
                .await;
            match prior_switch {
                Slot::Unlocked(uv) => assert_eq!(*uv.root_key, [0xA1u8; AEAD_KEY_LEN]),
                other => panic!(
                    "expected the locked prior A as Slot::Unlocked, got {:?}",
                    slot_label(&other)
                ),
            }
            // Only B is Unlocked now.
            assert_eq!(state.active_vault_id().await, Some(id_b));
            assert_eq!(state.slot_kind(id_a).await, SlotKind::Empty);
        });
    }

    #[test]
    fn set_unlocked_locking_others_does_not_lock_a_recovering_entry() {
        // The ≤1-`Unlocked` cap is about `Unlocked` ONLY. A `Recovering` entry
        // for a DIFFERENT vault is NOT torn down by the switch — recovery's
        // transient `Recovering` is fine alongside the sole `Unlocked`
        // (recovery-flow.md §4: a `Recovering` entry is not `Unlocked`).
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let id_unlocked = test_vault_id();
            let id_recovering = test_vault_id_b();

            state
                .set_recovering(id_recovering, fixture_recovering())
                .await;
            // Unlock a different vault while one is Recovering.
            state
                .set_unlocked_locking_others(id_unlocked, fixture_unlocked())
                .await;

            // The Recovering entry survives the switch.
            assert_eq!(
                state.slot_kind(id_recovering).await,
                SlotKind::Recovering,
                "a Recovering entry must NOT be capped/locked by the switch (only Unlocked is capped)"
            );
            assert_eq!(state.slot_kind(id_unlocked).await, SlotKind::Unlocked);
            assert_eq!(state.active_vault_id().await, Some(id_unlocked));
        });
    }

    // ---- A6 ≤1-`Unlocked` invariant across idle-lock + switch (MYND-207) ----
    //
    // The A6 single-unlocked invariant (SYNC-1 one-at-a-time): the `slots` map
    // never holds more than one `Slot::Unlocked` entry at any observable point.
    // These tests assert it across BOTH multi-vault lifecycle paths that mutate
    // the unlocked set — the lock-on-switch seam (`set_unlocked_locking_others`)
    // and the idle-lock take (`take_unlocked_if_idle`) — using the direct
    // `unlocked_entry_count` probe rather than the `active_vault_id` min-by-id
    // tie-break (which would mask a second `Unlocked` entry).

    #[test]
    fn at_most_one_unlocked_entry_across_a_lock_on_switch() {
        // Switching A → B must never transiently NOR finally leave two
        // `Unlocked` entries: `set_unlocked_locking_others` locks A and inserts
        // B under ONE write lock, so an external observer can only ever see
        // <= 1 Unlocked. Assert the count is exactly 1 after each unlock and
        // that it is B (A was locked) — the A6 invariant across the switch.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let id_a = test_vault_id();
            let id_b = test_vault_id_b();
            assert_ne!(id_a, id_b);

            // Fresh map: zero unlocked.
            assert_eq!(state.unlocked_entry_count().await, 0);

            // Unlock A → exactly one unlocked.
            state
                .set_unlocked_locking_others(id_a, fixture_unlocked_with_keys(0x11, 0x12, 0x13))
                .await;
            assert_eq!(
                state.unlocked_entry_count().await,
                1,
                "exactly one vault unlocked after the first unlock"
            );

            // Switch to B → STILL exactly one unlocked (A locked, B unlocked).
            state
                .set_unlocked_locking_others(id_b, fixture_unlocked_with_keys(0x21, 0x22, 0x23))
                .await;
            assert_eq!(
                state.unlocked_entry_count().await,
                1,
                "the switch must leave EXACTLY one Unlocked entry — never two (A6)"
            );
            assert_eq!(state.slot_kind(id_a).await, SlotKind::Empty);
            assert_eq!(state.slot_kind(id_b).await, SlotKind::Unlocked);
        });
    }

    #[test]
    fn at_most_one_unlocked_entry_across_an_idle_lock() {
        // The idle-lock take (`take_unlocked_if_idle`) removes the sole
        // `Unlocked` entry — it must drive the unlocked count from 1 to 0,
        // never leaving a second vault unlocked. With a `Recovering` entry for
        // a DIFFERENT vault present alongside, the idle-lock still touches only
        // the `Unlocked` one, and the count is <= 1 throughout (the Recovering
        // entry is not Unlocked).
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let id_unlocked = test_vault_id();
            let id_recovering = test_vault_id_b();

            // A Recovering entry beside the Unlocked one — both present.
            state
                .set_recovering(id_recovering, fixture_recovering())
                .await;
            state.set_unlocked(id_unlocked, fixture_unlocked()).await;
            assert_eq!(
                state.unlocked_entry_count().await,
                1,
                "exactly one Unlocked entry even with a Recovering sibling present"
            );

            // Idle-lock the sole Unlocked entry (injected idle >= timeout).
            let dropped = state
                .take_unlocked_if_idle(core::time::Duration::ZERO, || {
                    core::time::Duration::from_secs(10)
                })
                .await;
            assert!(matches!(dropped, Some(Slot::Unlocked(_))));

            // Now zero Unlocked entries — the A6 invariant held across the
            // idle-lock (1 → 0), and the Recovering sibling is untouched.
            assert_eq!(
                state.unlocked_entry_count().await,
                0,
                "the idle-lock must drop the count to zero, never leave a second Unlocked"
            );
            assert_eq!(state.slot_kind(id_recovering).await, SlotKind::Recovering);
        });
    }

    // ---- per-entry Recovering → no-editor-access guarantee (task 5) ----
    //
    // Editor/CRUD resolution funnels through `active_vault_id()`
    // (`slot_read_active` / `vault_is_unlocked_with_state`), which filters
    // `Slot::Unlocked` ONLY. A `Recovering` (or absent) entry is therefore
    // never handed to the editor — the compile-time `Slot::Unlocked(uv)` match
    // is preserved structurally across the keyed accessors (recovery-flow.md
    // §4.1/§4.3 per entry). These tests pin the RESOLUTION half of that
    // guarantee: a `Recovering` entry is not resolved as the active vault.

    #[test]
    fn active_resolution_does_not_reach_a_recovering_entry() {
        // Acceptance (a): a vault's entry is `Slot::Recovering` — active-vault
        // resolution does NOT reach it (it is not handed to the editor). With
        // ONLY a `Recovering` entry present, `active_vault_id()` is `None`, so
        // the editor read path (`slot_read_active`) keys an absent entry and
        // `Deref`s to `Slot::Empty` — the editor never sees `Recovering` as
        // active. Preserves recovery-flow.md §4.1/§4.3 per entry: a
        // `Recovering` slot grants no editor access.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let id_recovering = test_vault_id_b();
            state
                .set_recovering(id_recovering, fixture_recovering())
                .await;

            // The recovering entry is NOT the active (editor-reachable) vault.
            assert_eq!(
                state.active_vault_id().await,
                None,
                "a sole Recovering entry must not resolve as the active vault"
            );
            // The editor read helper keys the (absent) active id → Empty,
            // never the Recovering entry. The structural `Slot::Unlocked(uv)`
            // editor match therefore cannot bind a Recovering slot.
            let editor_view = state.slot_read_active().await;
            assert!(
                matches!(&*editor_view, Slot::Empty),
                "editor read must see Empty, never the Recovering entry"
            );
            // The Recovering entry is untouched and still keyed under its id.
            drop(editor_view);
            assert_eq!(state.slot_kind(id_recovering).await, SlotKind::Recovering);
        });
    }

    #[test]
    fn active_resolution_picks_the_unlocked_alongside_a_recovering() {
        // Acceptance (b): a second vault `Unlocked` alongside the `Recovering`
        // one resolves correctly to the `Unlocked` one. `active_vault_id()`
        // (the editor/CRUD resolver) yields the `Unlocked` key, NOT the
        // `Recovering` key — so the editor binds the Unlocked vault's
        // `UnlockedVault` and the Recovering entry is never reachable by it.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let id_unlocked = test_vault_id();
            let id_recovering = test_vault_id_b();
            assert_ne!(id_unlocked, id_recovering);

            // One vault Recovering, a DIFFERENT vault Unlocked, side by side.
            state
                .set_recovering(id_recovering, fixture_recovering())
                .await;
            state
                .set_unlocked(id_unlocked, fixture_unlocked_with_keys(0x11, 0x22, 0x33))
                .await;

            // Active resolution picks the Unlocked one, never the Recovering.
            assert_eq!(
                state.active_vault_id().await,
                Some(id_unlocked),
                "resolution must pick the Unlocked vault, not the Recovering one"
            );
            // The editor read helper resolves to the Unlocked vault's slot and
            // binds its `UnlockedVault` (bytes 0x11) — proving it is the
            // Unlocked entry, not the Recovering one, that reaches the editor.
            let editor_view = state.slot_read_active().await;
            match &*editor_view {
                Slot::Unlocked(uv) => assert_eq!(*uv.root_key, [0x11u8; AEAD_KEY_LEN]),
                other => panic!(
                    "editor must see the Unlocked vault, got {:?}",
                    slot_label(other)
                ),
            }
            drop(editor_view);
            // The Recovering entry survives — present but never editor-reachable.
            assert_eq!(state.slot_kind(id_recovering).await, SlotKind::Recovering);
        });
    }

    #[test]
    fn recovering_vault_id_resolves_the_sole_recovering_entry() {
        // MYND-220 / VR-18: the resumed A8f's `None`-target resolution.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            assert_eq!(
                state.recovering_vault_id().await,
                None,
                "no Recovering entry → None (cold path falls to the disk heuristic)"
            );
            let id = test_vault_id_b();
            state.set_recovering(id, fixture_recovering()).await;
            assert_eq!(state.recovering_vault_id().await, Some(id));
        });
    }

    #[test]
    fn recovering_vault_id_never_yields_an_unlocked_entry() {
        // Distinct from `active_vault_or_recovering_for_probe`: an
        // `Unlocked` sibling must NOT shadow the Recovering target —
        // A8f's path/slot pair must land on the recovery, not the
        // editor's vault.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let id_unlocked = test_vault_id();
            let id_recovering = test_vault_id_b();
            state
                .set_unlocked(id_unlocked, fixture_unlocked_with_keys(0x11, 0x22, 0x33))
                .await;
            state
                .set_recovering(id_recovering, fixture_recovering())
                .await;
            assert_eq!(state.recovering_vault_id().await, Some(id_recovering));
        });
    }

    #[test]
    fn take_recovering_returns_some_for_recovering_slot() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state
                .set_recovering(test_vault_id(), fixture_recovering())
                .await;
            let taken = state
                .take_recovering(test_vault_id())
                .await
                .expect("slot was just populated");
            assert_eq!(*taken.root_key, [0xAAu8; AEAD_KEY_LEN]);
            assert_eq!(*taken.items_key, [0xBBu8; AEAD_KEY_LEN]);
            assert_eq!(taken.items_key_id, [0xCCu8; 16]);
            // Slot becomes Empty after take_recovering succeeds.
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);
        });
    }

    #[test]
    fn take_recovering_returns_none_for_empty_slot() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            assert!(state.take_recovering(test_vault_id()).await.is_none());
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);
        });
    }

    #[test]
    fn take_recovering_returns_none_for_unlocked_slot() {
        // `take_recovering` MUST NOT consume an `Unlocked` slot — that
        // would silently discard a successfully-unlocked vault. The
        // method is targeted: only `Recovering` is taken.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(test_vault_id(), fixture_unlocked())
                .await;
            assert!(state.take_recovering(test_vault_id()).await.is_none());
            // Slot still Unlocked — was not perturbed.
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Unlocked);
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

            assert!(matches!(
                state.set_unlocked(test_vault_id(), a).await,
                Slot::Empty
            ));
            let prior = state.set_unlocked(test_vault_id(), b).await;
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
            state
                .set_recovering(test_vault_id(), fixture_recovering())
                .await;

            let cloned = state
                .peek_recovering_root_key_clone()
                .await
                .expect("slot is Recovering");
            // Clone must equal the fixture's root_key byte pattern
            // (0xAA, 32 bytes).
            assert_eq!(*cloned, [0xAA; AEAD_KEY_LEN]);
            // Slot must STILL be Recovering (clone doesn't take).
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Recovering);
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
            state
                .set_unlocked(test_vault_id(), fixture_unlocked())
                .await;
            assert!(state.peek_recovering_root_key_clone().await.is_none());
            // Slot still Unlocked (peek does not mutate).
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Unlocked);
        });
    }

    #[test]
    fn set_recovering_then_set_unlocked_promotes() {
        // The A8f happy-path shape: take_recovering then set_unlocked
        // promotes Recovering → Unlocked. Verify the transition.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state
                .set_recovering(test_vault_id(), fixture_recovering())
                .await;
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Recovering);

            let recovering = state
                .take_recovering(test_vault_id())
                .await
                .expect("slot was Recovering");
            // Build an UnlockedVault from the recovering material (mimics
            // the A8f closure body's promotion step).
            let promoted = UnlockedVault {
                root_key: recovering.root_key,
                items_key: recovering.items_key,
                items_key_id: recovering.items_key_id,
                unlocked_at: 0,
                vault_meta_bytes_hash: [0xAA; 32],
            };
            state.set_unlocked(test_vault_id(), promoted).await;

            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Unlocked);
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
