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

use protocol::{AttachmentMeta, AttachmentsCatalog, VaultMeta};

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

/// `vault.attachments` catalog merge — per-entry union by attachment-id with
/// the `sync-protocol.md` §11.4 rule-4 reconciliations (MYND-468). Pure,
/// deterministic, **commutative** (`merge(a,b) == merge(b,a)`) and idempotent,
/// so any two devices converge on the same catalog bytes regardless of merge
/// order:
///
/// - **only one side has the id** → keep it (union; entries are
///   content-addressed and the core fields immutable).
/// - **tombstone vs live** → the live entry survives iff its `created_at`
///   strictly postdates the tombstone's `deleted_at` (a deliberate re-add of
///   the same file — content-addressing keeps the id identical); otherwise —
///   equality included — the **tombstone wins** (the stale-catalog
///   resurrection guard).
/// - **tombstone vs tombstone** → keep the greater `deleted_at`.
/// - **live vs live** → `filename` merges scalar-LWW on `updated_at` (absent
///   = `created_at`), ties broken toward the lexicographically **greater**
///   filename so both sides pick the same winner without a local/remote
///   asymmetry (the plain [`merge_scalar_lww`] tie-to-`a` rule would not be
///   commutative here). The winner's whole entry is kept — core fields agree
///   by construction on a shared id.
///
/// Clock honesty (per §11.4): `created_at`/`deleted_at`/`updated_at` are
/// client wall-clocks from different devices; skew can make the "wrong" side
/// win a revival or rename race. Deterministic convergence is the contract,
/// not clock truth.
pub fn merge_attachments_catalog(
    local: &AttachmentsCatalog,
    remote: &AttachmentsCatalog,
) -> AttachmentsCatalog {
    let mut merged = AttachmentsCatalog::empty();
    let ids = merge_set_union(
        &local.entries.keys().cloned().collect::<Vec<_>>(),
        &remote.entries.keys().cloned().collect::<Vec<_>>(),
    );
    for id in ids {
        let entry = match (local.entries.get(&id), remote.entries.get(&id)) {
            (Some(l), None) => l.clone(),
            (None, Some(r)) => r.clone(),
            (Some(l), Some(r)) => merge_attachment_entry(l, r),
            (None, None) => unreachable!("id came from the key union"),
        };
        merged.entries.insert(id, entry);
    }
    merged
}

/// The §11.4 rule-4 per-entry reconciliation (see
/// [`merge_attachments_catalog`] for the full rule table).
fn merge_attachment_entry(a: &AttachmentMeta, b: &AttachmentMeta) -> AttachmentMeta {
    match (a.deleted_at, b.deleted_at) {
        // tombstone vs tombstone → greater deleted_at.
        (Some(da), Some(db)) => {
            if db > da {
                b.clone()
            } else {
                a.clone()
            }
        }
        // tombstone vs live → live survives only on a strict re-add.
        (Some(da), None) => {
            if b.created_at > da {
                b.clone()
            } else {
                a.clone()
            }
        }
        (None, Some(db)) => {
            if a.created_at > db {
                a.clone()
            } else {
                b.clone()
            }
        }
        // live vs live → filename-LWW on updated_at (default created_at),
        // tie → lexicographically greater filename (commutative tie-break).
        (None, None) => {
            let ts_a = a.updated_at.unwrap_or(a.created_at);
            let ts_b = b.updated_at.unwrap_or(b.created_at);
            if (ts_b, &b.filename) > (ts_a, &a.filename) {
                b.clone()
            } else {
                a.clone()
            }
        }
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
    /// The vault-shared invariants (KDF params or the itemsKey wrap) diverge.
    /// Every device unwraps the SAME `root_key` and the SAME `itemsKey`, so these
    /// must be byte-identical across devices; a divergence means the two metas are
    /// for different credential/items epochs and merging would strand the vault.
    InvariantDivergence,
}

/// Deterministic, commutative winner for a CONCURRENT `vault.meta` password-side
/// change (F1 Faz B). When two devices each rotated their password before either
/// synced, both must independently pick the SAME winner so the fleet converges
/// with no server-side version counter and no ping-pong. The rule: the greater
/// `enc_root_key_password` (lexicographic byte compare) wins — a total order over
/// the only field that legitimately differs (recovery-side + itemsKey + KDF are
/// invariant, enforced by [`merge_vault_meta`]). Ties (byte-identical wraps) are
/// the same password anyway, so `Local` is a harmless default. NOTE: this is only
/// the tiebreak for a genuine concurrent change; a device with no local change
/// adopts the remote outright (it never reaches this function).
pub fn meta_password_side_winner(local: &VaultMeta, remote: &VaultMeta) -> MetaWinner {
    if remote.enc_root_key_password > local.enc_root_key_password {
        MetaWinner::Remote
    } else {
        MetaWinner::Local
    }
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
    // Vault-shared invariants (KDF params + the itemsKey wrap) MUST agree across
    // devices — every device unwraps the SAME root_key and the SAME itemsKey. A
    // password change rewraps ONLY the password-side, so these are byte-identical
    // on both inputs; a divergence means one meta is for a different
    // credential/items epoch, and picking a winner could hand back a clone whose
    // itemsKey no longer opens the notes. Refuse rather than paper over
    // (defense-in-depth; the old merge validated only account_hash + recovery).
    if local.kdf_params != remote.kdf_params
        || local.items_key_id != remote.items_key_id
        || local.items_key_nonce != remote.items_key_nonce
        || local.enc_items_key != remote.enc_items_key
    {
        return Err(ConflictError::InvariantDivergence);
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

    // ---- merge_attachments_catalog (§11.4 rule 4, MYND-468) ----

    fn live(created_at: u64, filename: &str) -> AttachmentMeta {
        AttachmentMeta::live("t".to_string(), created_at, filename.to_string(), 9)
    }

    fn catalog(entries: Vec<(&str, AttachmentMeta)>) -> AttachmentsCatalog {
        let mut c = AttachmentsCatalog::empty();
        for (id, m) in entries {
            c.entries.insert(id.to_string(), m);
        }
        c
    }

    #[test]
    fn catalog_merge_unions_disjoint_entries() {
        let a = catalog(vec![("aa", live(1, "a.png"))]);
        let b = catalog(vec![("bb", live(2, "b.png"))]);
        let merged = merge_attachments_catalog(&a, &b);
        assert_eq!(merged.entries.len(), 2);
        assert_eq!(merged.entries["aa"], live(1, "a.png"));
        assert_eq!(merged.entries["bb"], live(2, "b.png"));
    }

    #[test]
    fn catalog_merge_tombstone_beats_stale_live() {
        // The live entry predates the deletion (created_at <= deleted_at) —
        // the resurrection guard: tombstone wins, equality included.
        let tomb = live(100, "x").into_tombstone(200);
        let a = catalog(vec![("aa", tomb.clone())]);
        let b = catalog(vec![("aa", live(150, "x"))]);
        assert_eq!(merge_attachments_catalog(&a, &b).entries["aa"], tomb);
        // Equality: created_at == deleted_at → still tombstone.
        let b_eq = catalog(vec![("aa", live(200, "x"))]);
        assert_eq!(merge_attachments_catalog(&a, &b_eq).entries["aa"], tomb);
    }

    #[test]
    fn catalog_merge_readd_beats_tombstone() {
        // A live entry whose created_at strictly postdates deleted_at is a
        // deliberate re-add of the same (content-addressed) file — it wins.
        let tomb = live(100, "x").into_tombstone(200);
        let readd = live(201, "x-again");
        let a = catalog(vec![("aa", tomb)]);
        let b = catalog(vec![("aa", readd.clone())]);
        assert_eq!(merge_attachments_catalog(&a, &b).entries["aa"], readd);
    }

    #[test]
    fn catalog_merge_tombstone_pair_keeps_greater_deleted_at() {
        let t1 = live(1, "x").into_tombstone(10);
        let t2 = live(1, "x").into_tombstone(20);
        let a = catalog(vec![("aa", t1)]);
        let b = catalog(vec![("aa", t2.clone())]);
        assert_eq!(merge_attachments_catalog(&a, &b).entries["aa"], t2);
    }

    #[test]
    fn catalog_merge_filename_lww_with_commutative_tie_break() {
        // Later updated_at wins.
        let mut old_name = live(10, "old.pdf");
        old_name.updated_at = Some(50);
        let mut new_name = live(10, "new.pdf");
        new_name.updated_at = Some(60);
        let a = catalog(vec![("aa", old_name.clone())]);
        let b = catalog(vec![("aa", new_name.clone())]);
        assert_eq!(merge_attachments_catalog(&a, &b).entries["aa"], new_name);
        // Tie → lexicographically greater filename (NOT tie-to-local, which
        // would break commutativity).
        let mut n1 = live(10, "alpha.pdf");
        n1.updated_at = Some(50);
        let mut n2 = live(10, "beta.pdf");
        n2.updated_at = Some(50);
        let a = catalog(vec![("aa", n1)]);
        let b = catalog(vec![("aa", n2.clone())]);
        assert_eq!(merge_attachments_catalog(&a, &b).entries["aa"], n2.clone());
        assert_eq!(merge_attachments_catalog(&b, &a).entries["aa"], n2);
        // Absent updated_at falls back to created_at.
        let unrenamed = live(10, "orig.pdf"); // ts = 10
        let mut renamed = live(10, "renamed.pdf");
        renamed.updated_at = Some(11);
        let a = catalog(vec![("aa", unrenamed)]);
        let b = catalog(vec![("aa", renamed.clone())]);
        assert_eq!(merge_attachments_catalog(&a, &b).entries["aa"], renamed);
    }

    #[test]
    fn catalog_merge_is_commutative_and_idempotent() {
        let mut renamed = live(5, "r.txt");
        renamed.updated_at = Some(7);
        let a = catalog(vec![
            ("aa", live(1, "a.png")),
            ("bb", live(100, "b.png").into_tombstone(200)),
            ("cc", renamed),
        ]);
        let b = catalog(vec![
            ("aa", live(1, "a.png")),
            ("bb", live(300, "b2.png")), // re-add: 300 > 200
            ("dd", live(4, "d.zip").into_tombstone(9)),
        ]);
        let ab = merge_attachments_catalog(&a, &b);
        let ba = merge_attachments_catalog(&b, &a);
        assert_eq!(ab, ba, "merge must be commutative");
        assert_eq!(
            merge_attachments_catalog(&ab, &b),
            ab,
            "merge must be idempotent once converged"
        );
        assert_eq!(
            merge_attachments_catalog(&ab, &AttachmentsCatalog::empty()),
            ab,
            "merging with empty is identity"
        );
        // The re-add won over the tombstone.
        assert_eq!(ab.entries["bb"].filename, "b2.png");
        // The unilateral tombstone survives union.
        assert!(ab.entries["dd"].is_tombstone());
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

    #[test]
    fn vault_meta_merge_rejects_items_key_divergence() {
        // The itemsKey wrap must be identical across devices (same shared
        // itemsKey). A divergent enc_items_key would strand notes on the loser.
        let local = meta(0xAA, 0x55);
        let mut remote = meta(0xBB, 0x55);
        remote.enc_items_key = [0xEE; VAULT_META_WRAPPED_ITEMS_KEY_LEN];
        assert_eq!(
            merge_vault_meta(&local, &remote, MetaWinner::Remote),
            Err(ConflictError::InvariantDivergence)
        );
        // items_key_id and items_key_nonce are equally load-bearing.
        let mut remote_id = meta(0xBB, 0x55);
        remote_id.items_key_id = [0xEE; VAULT_META_ITEMS_KEY_ID_LEN];
        assert_eq!(
            merge_vault_meta(&local, &remote_id, MetaWinner::Remote),
            Err(ConflictError::InvariantDivergence)
        );
        let mut remote_nonce = meta(0xBB, 0x55);
        remote_nonce.items_key_nonce = [0xEE; VAULT_META_NONCE_LEN];
        assert_eq!(
            merge_vault_meta(&local, &remote_nonce, MetaWinner::Remote),
            Err(ConflictError::InvariantDivergence)
        );
    }

    #[test]
    fn meta_tiebreak_is_symmetric_and_deterministic() {
        // The concurrent-change tiebreak must pick the SAME winner regardless of
        // which side is "local" (commutative) — the property that lets two devices
        // converge with no server version counter.
        let a = meta(0xAA, 0x55);
        let b = meta(0xBB, 0x55);
        // From A's view (local=a, remote=b) and B's view (local=b, remote=a), the
        // WINNING bytes must be identical (0xBB, the greater password-side).
        let win_from_a = match meta_password_side_winner(&a, &b) {
            MetaWinner::Local => &a,
            MetaWinner::Remote => &b,
        };
        let win_from_b = match meta_password_side_winner(&b, &a) {
            MetaWinner::Local => &b,
            MetaWinner::Remote => &a,
        };
        assert_eq!(
            win_from_a.enc_root_key_password,
            win_from_b.enc_root_key_password
        );
        assert_eq!(
            win_from_a.enc_root_key_password,
            [0xBB; VAULT_META_WRAPPED_ROOT_KEY_LEN]
        );
    }

    #[test]
    fn vault_meta_merge_rejects_kdf_params_divergence() {
        // KDF params must agree — a mismatch means a different credential epoch.
        let local = meta(0xAA, 0x55);
        let mut remote = meta(0xBB, 0x55);
        remote.kdf_params = protocol::KdfParams {
            m_kib: local.kdf_params.m_kib + 1024,
            ..local.kdf_params
        };
        assert_eq!(
            merge_vault_meta(&local, &remote, MetaWinner::Remote),
            Err(ConflictError::InvariantDivergence)
        );
    }
}
