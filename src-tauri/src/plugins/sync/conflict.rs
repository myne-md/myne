//! Conflict resolution (SYNC-11 + `protocol.md` §9.5.2), MYND-424 task 7.
//!
//! When two devices change the same logical thing concurrently (the engine saw
//! `Dominance::Incomparable`), the resolution is **type-specific**:
//!
//! - **Note bodies → keep-both** (SYNC-11). Both revisions survive: the remote
//!   revision is materialized as an ordinary `.myn` note carrying the managed
//!   frontmatter [`FM_CONFLICT`]`: true` + [`FM_CONFLICT_OF`]`: <original-uuid>`
//!   (the inverse-visibility twin of `trashed:`). This Rust-core layer produces
//!   the **plan** ([`ConflictCopyPlan`]); the TS notes layer materializes it via
//!   the same `note_update`/`note_create` orchestration that writes `trashed:`
//!   (`src/dialect/surgery.ts`), and MYND-427 presents the grouped copies. No
//!   edit is ever silently dropped.
//! - **Singletons → field/set merge** (§9.5.2): the three merge primitives
//!   [`merge_set_union`] / [`merge_scalar_lww`] / [`merge_sequence_lww`] are the
//!   toolkit prefs/dictionary/catalog fields reconcile with (set-union for
//!   tag/word/folder sets, scalar-LWW for single values, sequence-LWW for
//!   ordered lists). Pure, deterministic, tie-broken without a clock dependency.
//! - **`vault.meta` → bespoke** ([`merge_vault_meta`]): the recovery-side wrap is
//!   **phrase-invariant** (it never changes after vault creation), so a
//!   concurrent password change rewrites only the password-side. The merge keeps
//!   the winner's password-side and a **valid recovery-side**, so a password
//!   change on one device can never strand the recovery path (story 4).

use protocol::VaultMeta;

/// Managed-frontmatter key marking a note a conflict copy (value-strict
/// canonical `true`, mirroring `template:`). New dialect field (§3.6.1) — staged
/// for `markdown-dialect.md` + glossary in task 12.
pub const FM_CONFLICT: &str = "conflict";
/// Managed-frontmatter key naming the original note a conflict copy forked from
/// (the 16-byte note UUID, hex). MYND-426/427 group copies by this.
pub const FM_CONFLICT_OF: &str = "conflict_of";

/// The keep-both plan for a note conflict: the TS notes layer creates a new
/// `.myn` note carrying the *remote* body plus the conflict frontmatter, leaving
/// the local note untouched. Both survive (SYNC-11).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictCopyPlan {
    /// The original note's UUID (the value written to `conflict_of:`), hex.
    pub conflict_of_hex: String,
    /// The remote revision's `content_nonce` (the body to materialize).
    pub remote_content_nonce: [u8; 24],
}

/// Decide the keep-both plan for a concurrently-edited note. The engine has
/// already established the two revisions are concurrent (incomparable); this
/// records which original the copy forks from + which remote body to write.
pub fn plan_note_keep_both(
    original_id: &[u8; 16],
    remote_content_nonce: [u8; 24],
) -> ConflictCopyPlan {
    let mut hex = String::with_capacity(32);
    for b in original_id {
        hex.push_str(&format!("{b:02x}"));
    }
    ConflictCopyPlan {
        conflict_of_hex: hex,
        remote_content_nonce,
    }
}

/// §9.5.2 **set-union** merge: the union of two sets, sorted + de-duplicated.
/// Used for unordered sets (tags, personal-dictionary words, deliberate
/// folders) where membership is the only semantics — additions from both
/// devices all survive; an item removed on one device but kept on the other
/// re-appears (membership union is the conservative, no-data-loss choice).
pub fn merge_set_union<T: Ord + Clone>(a: &[T], b: &[T]) -> Vec<T> {
    let mut out: Vec<T> = a.iter().chain(b.iter()).cloned().collect();
    out.sort();
    out.dedup();
    out
}

/// §9.5.2 **scalar-LWW** merge: a single value where the later writer wins.
/// `ts` is the per-field logical timestamp (e.g. the head seq / VV component
/// that authored it). A tie is broken deterministically toward `a` (the caller
/// orders its args so "local" is `a`) — never clock-dependent.
pub fn merge_scalar_lww<T: Clone>(a: (&T, u64), b: (&T, u64)) -> T {
    if b.1 > a.1 {
        b.0.clone()
    } else {
        a.0.clone()
    }
}

/// §9.5.2 **sequence-LWW** merge: an ordered list reconciled whole (the later
/// writer's ordering wins). Used for ordered fields (e.g. `item_order`) where a
/// per-element merge would scramble intent; the whole sequence is LWW.
pub fn merge_sequence_lww<T: Clone>(a: (&[T], u64), b: (&[T], u64)) -> Vec<T> {
    if b.1 > a.1 {
        b.0.to_vec()
    } else {
        a.0.to_vec()
    }
}

/// Which side's password-side wrap wins the `vault.meta` merge (the sync layer
/// decides via the head VV / blob version; this type just names the choice).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetaWinner {
    /// Keep the local meta's password-side.
    Local,
    /// Keep the remote meta's password-side.
    Remote,
}

/// Bespoke `vault.meta` merge errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConflictError {
    /// The two metas' recovery-side wraps diverge — recovery-side is supposed to
    /// be phrase-invariant, so a divergence is an anomaly the merge refuses to
    /// paper over (it would risk stranding one device's recovery path).
    RecoverySideDivergence,
    /// The two metas describe different vaults (account_number_hash mismatch).
    VaultMismatch,
}

/// Bespoke `vault.meta` merge (story 4). The recovery-side (the recovery salt,
/// recovery wrap-nonce, and recovery-wrapped `root_key`) is phrase-invariant —
/// it never changes after vault creation — so both inputs MUST carry an
/// identical recovery-side; the merge keeps the winner's password-side and that
/// shared, valid recovery-side. This guarantees a concurrent password change can
/// never produce a meta lacking a working recovery path.
pub fn merge_vault_meta(
    local: &VaultMeta,
    remote: &VaultMeta,
    winner: MetaWinner,
) -> Result<VaultMeta, ConflictError> {
    if local.account_number_hash != remote.account_number_hash {
        return Err(ConflictError::VaultMismatch);
    }
    // Recovery-side must be identical across both (phrase-invariant).
    if local.random_salt_recovery != remote.random_salt_recovery
        || local.nonce_recovery_wrap != remote.nonce_recovery_wrap
        || local.enc_root_key_recovery != remote.enc_root_key_recovery
    {
        return Err(ConflictError::RecoverySideDivergence);
    }
    // Take the winner's password-side; recovery-side (shared) rides along.
    let mut merged = match winner {
        MetaWinner::Local => local.clone(),
        MetaWinner::Remote => remote.clone(),
    };
    // The recovery-side is identical in both, but assert it explicitly so a
    // future field addition can't silently drop it.
    merged.random_salt_recovery = local.random_salt_recovery;
    merged.nonce_recovery_wrap = local.nonce_recovery_wrap;
    merged.enc_root_key_recovery = local.enc_root_key_recovery;
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{
        VAULT_META_ITEMS_KEY_ID_LEN, VAULT_META_NONCE_LEN, VAULT_META_SALT_RANDOM_LEN,
        VAULT_META_WRAPPED_ITEMS_KEY_LEN, VAULT_META_WRAPPED_ROOT_KEY_LEN,
    };

    #[test]
    fn keep_both_plan_records_original_and_remote_body() {
        let plan = plan_note_keep_both(&[0x01; 16], [0xbb; 24]);
        assert_eq!(plan.conflict_of_hex, "01".repeat(16));
        assert_eq!(plan.remote_content_nonce, [0xbb; 24]);
    }

    #[test]
    fn set_union_keeps_all_members_sorted_dedup() {
        let a = vec!["alpha", "beta"];
        let b = vec!["beta", "gamma"];
        assert_eq!(merge_set_union(&a, &b), vec!["alpha", "beta", "gamma"]);
    }

    #[test]
    fn scalar_lww_later_wins_tie_to_local() {
        assert_eq!(merge_scalar_lww((&"old", 1), (&"new", 2)), "new");
        assert_eq!(merge_scalar_lww((&"local", 5), (&"remote", 5)), "local"); // tie → local
        assert_eq!(merge_scalar_lww((&"local", 9), (&"remote", 3)), "local");
    }

    #[test]
    fn sequence_lww_takes_whole_winner_sequence() {
        let a = vec![1, 2, 3];
        let b = vec![3, 1];
        assert_eq!(merge_sequence_lww((&a, 1), (&b, 2)), vec![3, 1]);
        assert_eq!(merge_sequence_lww((&a, 2), (&b, 1)), vec![1, 2, 3]);
    }

    fn meta(password_marker: u8, recovery_marker: u8) -> VaultMeta {
        VaultMeta {
            account_number_hash: [0x33; 16],
            kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
            random_salt_password: [0x01; VAULT_META_SALT_RANDOM_LEN],
            random_salt_recovery: [recovery_marker; VAULT_META_SALT_RANDOM_LEN],
            nonce_password_wrap: [password_marker; VAULT_META_NONCE_LEN],
            enc_root_key_password: [password_marker; VAULT_META_WRAPPED_ROOT_KEY_LEN],
            nonce_recovery_wrap: [recovery_marker; VAULT_META_NONCE_LEN],
            enc_root_key_recovery: [recovery_marker; VAULT_META_WRAPPED_ROOT_KEY_LEN],
            items_key_id: [0x07; VAULT_META_ITEMS_KEY_ID_LEN],
            items_key_nonce: [0x08; VAULT_META_NONCE_LEN],
            enc_items_key: [0x09; VAULT_META_WRAPPED_ITEMS_KEY_LEN],
        }
    }

    #[test]
    fn vault_meta_merge_keeps_winner_password_and_shared_recovery() {
        // Same vault, same (invariant) recovery side, different password sides.
        let local = meta(0xAA, 0x55);
        let remote = meta(0xBB, 0x55);

        let merged = merge_vault_meta(&local, &remote, MetaWinner::Remote).unwrap();
        assert_eq!(merged.nonce_password_wrap, [0xBB; VAULT_META_NONCE_LEN]); // remote password won
        assert_eq!(
            merged.enc_root_key_recovery,
            [0x55; VAULT_META_WRAPPED_ROOT_KEY_LEN]
        ); // recovery preserved

        let merged_local = merge_vault_meta(&local, &remote, MetaWinner::Local).unwrap();
        assert_eq!(
            merged_local.nonce_password_wrap,
            [0xAA; VAULT_META_NONCE_LEN]
        );
        assert_eq!(
            merged_local.enc_root_key_recovery,
            [0x55; VAULT_META_WRAPPED_ROOT_KEY_LEN]
        );
    }

    #[test]
    fn vault_meta_merge_rejects_recovery_divergence() {
        let local = meta(0xAA, 0x55);
        let remote = meta(0xBB, 0x66); // recovery side differs → anomaly
        assert_eq!(
            merge_vault_meta(&local, &remote, MetaWinner::Remote),
            Err(ConflictError::RecoverySideDivergence)
        );
    }

    #[test]
    fn vault_meta_merge_rejects_cross_vault() {
        let local = meta(0xAA, 0x55);
        let mut remote = meta(0xBB, 0x55);
        remote.account_number_hash = [0x99; 16];
        assert_eq!(
            merge_vault_meta(&local, &remote, MetaWinner::Local),
            Err(ConflictError::VaultMismatch)
        );
    }
}
