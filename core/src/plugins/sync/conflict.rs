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
//! - **Map singletons → per-key union** ([`merge_attachments_catalog`] by
//!   attachment-id, [`merge_custom_themes`] by theme name): both reconcile per
//!   entry and share the §11.4 tombstone rule — a live entry beats a tombstone
//!   only on a strict re-add; ties keep the tombstone (the resurrection guard).
//! - **`vault.meta` → bespoke** ([`merge_vault_meta`]): the recovery-side wrap is
//!   **phrase-invariant** (it never changes after vault creation), so a
//!   concurrent password change rewrites only the password-side. The merge keeps
//!   the winner's password-side and a **valid recovery-side**, so a password
//!   change on one device can never strand the recovery path (story 4).

use super::devices::SyncDeviceError;
use crate::plugins::themes::commands::{ThemeEntry, ThemesMap};
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use protocol::{AttachmentMeta, AttachmentsCatalog, VaultMeta};
use serde::Serialize;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

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

/// Case-fold identity of a folder path — NFC then default (language-agnostic)
/// Unicode lowercase — matching the TS `folderPath.ts::foldSegment`
/// (`markdown-dialect.md` §3.6.2). The one fold the display layer
/// (`deriveFolderTree`) and this merge plane must agree on so `Projects/` ≡
/// `projects/`. Deliberately NOT the Turkish casefold (`text::turkish_lower`) —
/// folder identity uses the same locale-independent `toLowerCase()` the dialect
/// does, or the two planes would disagree.
fn fold_folder_key(path: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    crate::text::default_lower(&path.nfc().collect::<String>())
}

/// §10.2 **fold-aware set-union** for folder-path sets (`deliberate_folders`,
/// `archived_folders`, `ai_excluded_folders`; MYND-562): the union of both
/// sides, then entries sharing a folded folder identity collapse to a single
/// canonical representative — the byte-lexicographically smallest raw display
/// form — so `personal/` and `PERSONAL/` never coexist. Sorted + deduplicated
/// like [`merge_set_union`]; clockless. NOT used for `spell_languages` (language
/// codes, not a folder set — those stay case-sensitive).
pub fn merge_set_union_folded(a: &[String], b: &[String]) -> Vec<String> {
    use std::collections::BTreeMap;
    // folded key → lexicographic-min raw display form seen for that identity.
    let mut winners: BTreeMap<String, String> = BTreeMap::new();
    for raw in a.iter().chain(b.iter()) {
        winners
            .entry(fold_folder_key(raw))
            .and_modify(|w| {
                if raw < w {
                    *w = raw.clone();
                }
            })
            .or_insert_with(|| raw.clone());
    }
    // Each folded key holds one lexicographic-min raw form; distinct folded keys
    // can never share a raw form, so the collected values are already unique —
    // only a sort (they emerge in folded-key order) is needed, no dedup.
    let mut out: Vec<String> = winners.into_values().collect();
    out.sort();
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
/// deterministic, **commutative** (`merge(a,b) == merge(b,a)`) and
/// **idempotent** (`merge(a,a) == a`), so a PAIR of devices converges on the
/// same catalog bytes whichever way round it reconciles. It is **not
/// associative** — see [`merge_custom_themes`] for the counterexample and why
/// that limit belongs to the §11.4 resurrection guard rather than to either
/// merge function.
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
        // tombstone vs tombstone → greater deleted_at, then EVERY remaining
        // field. §11.4 scrubs filename/content_type/size, but `created_at`
        // survives the scrub and DOES diverge: the id is content-addressed, so
        // two devices that imported the same bytes at different times hold the
        // same key with different `created_at`. Delete on both in the same
        // second and `deleted_at` alone would let the argument order pick.
        (Some(da), Some(db)) => {
            if (
                db,
                b.created_at,
                b.updated_at,
                &b.filename,
                &b.content_type,
                b.size,
            ) > (
                da,
                a.created_at,
                a.updated_at,
                &a.filename,
                &a.content_type,
                a.size,
            ) {
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
        // live vs live → filename-LWW on updated_at (default created_at), tie →
        // lexicographically greater filename, then EVERY remaining field. The
        // trailing fields are what make this a TOTAL order: `ts` collapses
        // `updated_at`/`created_at` into one value, so two entries can tie on
        // (ts, filename) while still differing — and then the argument order,
        // not the data, would decide.
        (None, None) => {
            let ts_a = a.updated_at.unwrap_or(a.created_at);
            let ts_b = b.updated_at.unwrap_or(b.created_at);
            if (
                ts_b,
                &b.filename,
                b.created_at,
                b.updated_at,
                &b.content_type,
                b.size,
            ) > (
                ts_a,
                &a.filename,
                a.created_at,
                a.updated_at,
                &a.content_type,
                a.size,
            ) {
                b.clone()
            } else {
                a.clone()
            }
        }
    }
}

/// `vault.themes` custom-theme merge — per-entry union by theme **name**
/// (MYND-486). The `merge_attachments_catalog` twin: pure, deterministic,
/// **commutative** (`merge(a,b) == merge(b,a)`) and **idempotent**
/// (`merge(a,a) == a`), so a PAIR of devices converges whichever way round it
/// reconciles.
///
/// It is **not associative**, and that limit is inherited from the
/// resurrection guard (`sync-protocol.md` §11.4), not from this function — the
/// catalog twin below has the identical property. A tombstone filters a live
/// entry by `created_at` vs `deleted_at`, so a three-way reconcile can depend
/// on the pairing order:
///
/// ```text
/// L1{created:10, updated:10}  T{deleted:5}  L2{created:1, updated:100}
/// (L1 ∨ T) ∨ L2 = L1 ∨ L2 = L2      // L1 survives the guard, then loses LWW
/// L1 ∨ (T ∨ L2) = L1 ∨ T  = L1      // L2 fails the guard, then T loses to L1
/// ```
///
/// A three-device fleet in that shape can therefore CAS-ping-pong. It needs a
/// spec-level answer (a richer tombstone or a different structure), not a local
/// tie-break tweak — see the open risk noted against MYND-486.
///
/// - **only one side has the name** → keep it (union). A concurrent add of
///   "Nord" on A and "Solarized" on B leaves BOTH — the reason `vault.themes`
///   is a per-name map merge and not whole-value LWW (a theme is dozens of
///   tokens of hand authoring; silently losing one to a concurrent add is real
///   data loss).
/// - **tombstone vs live** → the live entry survives iff its `created_at`
///   strictly postdates the tombstone's `deleted_at` (a deliberate re-add of
///   the name); otherwise — equality included — the **tombstone wins** (the
///   stale-store resurrection guard: without it, deleting a theme on A would
///   have B's still-live copy resurrect it).
/// - **tombstone vs tombstone** → keep the greater `deleted_at`.
/// - **live vs live** → content-LWW on `updated_at`, ties broken toward the
///   **greater palette** (`BTreeMap` `Ord`). The winner's whole palette is kept:
///   a palette is ONE coherent design, so it is LWW **within** a name and never
///   merged token-by-token (a per-token merge of two edits would produce an
///   incoherent Frankenstein palette).
///
/// **How commutativity is actually delivered:** both same-state arms compare a
/// TOTAL order over every retained field (tombstones: `deleted_at`, then
/// `created_at`/`updated_at`/palette; live: `updated_at`, then palette, then
/// `created_at`). "Pick the max under a total order" is commutative by
/// construction. Leaving any field out — as a plain [`merge_scalar_lww`]
/// tie-to-`a` rule does — makes the ARGUMENT ORDER the tie-breaker, and that is
/// not cosmetic: `sync_themes_phase` gates its push on `merged == remote_map`,
/// so two devices that merge to different bytes would each see a mismatch and
/// re-push forever, churning a fresh nonce and upload every cycle instead of
/// converging.
///
/// There is no tombstone GC: a themes tombstone is a name plus a timestamp and
/// themes number in the single digits, so the map stays trivially small.
///
/// Clock honesty (per §11.4, inherited from the catalog): `created_at` /
/// `updated_at` / `deleted_at` are client wall-clocks from different devices;
/// skew can make the "wrong" side win a revival or edit race. Deterministic
/// convergence is the contract, not clock truth.
pub fn merge_custom_themes(local: &ThemesMap, remote: &ThemesMap) -> ThemesMap {
    let mut merged = ThemesMap::new();
    let names = merge_set_union(
        &local.keys().cloned().collect::<Vec<_>>(),
        &remote.keys().cloned().collect::<Vec<_>>(),
    );
    for name in names {
        let entry = match (local.get(&name), remote.get(&name)) {
            (Some(l), None) => l.clone(),
            (None, Some(r)) => r.clone(),
            (Some(l), Some(r)) => merge_theme_entry(l, r),
            (None, None) => unreachable!("name came from the key union"),
        };
        merged.insert(name, entry);
    }
    merged
}

/// The per-name reconciliation (see [`merge_custom_themes`] for the full rule
/// table) — structurally the catalog's [`merge_attachment_entry`].
fn merge_theme_entry(a: &ThemeEntry, b: &ThemeEntry) -> ThemeEntry {
    match (a.deleted_at, b.deleted_at) {
        // tombstone vs tombstone → greater deleted_at, then EVERY remaining
        // field. Scrubbing the palette does NOT make two tombstones of the same
        // name byte-identical — `updated_at` survives the scrub and diverges
        // whenever one device had an unsynced edit — so `deleted_at` alone is a
        // PARTIAL order and the argument order would pick the winner.
        (Some(da), Some(db)) => {
            if (db, b.created_at, b.updated_at, &b.palette)
                > (da, a.created_at, a.updated_at, &a.palette)
            {
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
        // live vs live → palette-LWW on updated_at, tie → the greater palette,
        // then the greater created_at. `created_at` has to be in the key: two
        // devices can import the same name at different times and later hold an
        // identical palette at an identical `updated_at`, and without it the
        // argument order decides.
        (None, None) => {
            if (b.updated_at, &b.palette, b.created_at) > (a.updated_at, &a.palette, a.created_at) {
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
    fn folded_set_union_collapses_case_variants_to_min() {
        // MYND-562: "personal/" and "PERSONAL/" are one folder identity — the
        // fold-aware union keeps a single lexicographic-min representative
        // ("PERSONAL/" < "personal/" byte-wise) while leaving distinct folders
        // intact. Symmetric across argument order.
        let a: Vec<String> = vec!["personal/".into(), "Work/".into()];
        let b: Vec<String> = vec!["PERSONAL/".into(), "Ideas/".into()];
        let expected: Vec<String> = vec!["Ideas/".into(), "PERSONAL/".into(), "Work/".into()];
        assert_eq!(merge_set_union_folded(&a, &b), expected);
        assert_eq!(merge_set_union_folded(&b, &a), expected);
    }

    #[test]
    fn folded_set_union_nfc_folds_decomposed_and_precomposed() {
        // Decomposed "café/" (e + U+0301) and precomposed "Café/" share a
        // folded identity (NFC + lowercase); one canonical survivor.
        let a: Vec<String> = vec!["cafe\u{0301}/".into()];
        let b: Vec<String> = vec!["Caf\u{00e9}/".into()];
        let merged = merge_set_union_folded(&a, &b);
        assert_eq!(merged.len(), 1);
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
    fn catalog_merge_tombstone_tie_is_commutative_despite_divergent_created_at() {
        // The id is content-addressed, so two devices that imported the SAME
        // bytes at different times hold the same key with a DIFFERENT
        // `created_at` — and §11.4's scrub (filename/content_type/size) does not
        // touch it. Delete on both in the same second and `deleted_at` alone
        // leaves the winner to the argument order.
        let a = catalog(vec![("aa", live(1, "doc.pdf").into_tombstone(100))]);
        let b = catalog(vec![("aa", live(50, "doc.pdf").into_tombstone(100))]);
        assert_eq!(
            merge_attachments_catalog(&a, &b),
            merge_attachments_catalog(&b, &a)
        );
    }

    #[test]
    fn catalog_merge_live_tie_is_commutative_despite_divergent_created_at() {
        // Equal `updated_at` AND equal filename, different `created_at`: the
        // (ts, filename) key ties, so everything else has to be in the order.
        let mut n1 = live(1, "doc.pdf");
        n1.updated_at = Some(100);
        let mut n2 = live(50, "doc.pdf");
        n2.updated_at = Some(100);
        let a = catalog(vec![("aa", n1)]);
        let b = catalog(vec![("aa", n2)]);
        assert_eq!(
            merge_attachments_catalog(&a, &b),
            merge_attachments_catalog(&b, &a)
        );
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

    // ---- merge_custom_themes (MYND-486, per-theme-name map merge) ----

    fn palette(accent: &str) -> crate::plugins::themes::commands::ThemePalette {
        crate::plugins::themes::commands::ThemePalette::from([("--accent".into(), accent.into())])
    }

    /// A live entry: imported at `created_at`, last edited at `updated_at`.
    fn theme(created_at: u64, updated_at: u64, accent: &str) -> ThemeEntry {
        ThemeEntry {
            created_at,
            deleted_at: None,
            palette: palette(accent),
            updated_at,
        }
    }

    fn themes(entries: Vec<(&str, ThemeEntry)>) -> ThemesMap {
        entries
            .into_iter()
            .map(|(n, e)| (n.to_string(), e))
            .collect()
    }

    #[test]
    fn themes_merge_keeps_both_concurrent_adds_of_different_names() {
        // THE reason vault.themes is a per-name map merge and not whole-map
        // LWW: A's "nord" and B's "solarized" were authored concurrently and
        // BOTH must survive — a whole-map LWW would silently drop one.
        let a = themes(vec![("nord", theme(10, 10, "#88c0d0"))]);
        let b = themes(vec![("solarized", theme(11, 11, "#268bd2"))]);
        let merged = merge_custom_themes(&a, &b);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged["nord"], theme(10, 10, "#88c0d0"));
        assert_eq!(merged["solarized"], theme(11, 11, "#268bd2"));
    }

    #[test]
    fn themes_merge_same_name_concurrent_edit_is_lww() {
        // A same-name concurrent edit falls to content-LWW: the greater
        // updated_at wins, whole palette intact (never merged token-by-token —
        // a palette is one coherent design).
        let older = theme(1, 50, "#111111");
        let newer = theme(1, 60, "#222222");
        let a = themes(vec![("nord", older.clone())]);
        let b = themes(vec![("nord", newer.clone())]);
        assert_eq!(merge_custom_themes(&a, &b)["nord"], newer);
        assert_eq!(merge_custom_themes(&b, &a)["nord"], newer);
        // The winner's palette rides along whole — no per-token mixing.
        assert_eq!(
            merge_custom_themes(&a, &b)["nord"].palette,
            palette("#222222")
        );
    }

    #[test]
    fn themes_merge_tombstone_beats_stale_live_no_resurrection() {
        // Delete on A vs a still-live copy on B: the live entry predates the
        // deletion (created_at <= deleted_at) → the tombstone wins. Without
        // this guard, deleting a theme on A would resurrect it from B.
        let tomb = theme(100, 100, "#abcabc").into_tombstone(200);
        let a = themes(vec![("nord", tomb.clone())]);
        let b = themes(vec![("nord", theme(150, 150, "#abcabc"))]);
        assert_eq!(merge_custom_themes(&a, &b)["nord"], tomb);
        assert_eq!(merge_custom_themes(&b, &a)["nord"], tomb);
        // Equality: created_at == deleted_at → still the tombstone.
        let b_eq = themes(vec![("nord", theme(200, 200, "#abcabc"))]);
        assert_eq!(merge_custom_themes(&a, &b_eq)["nord"], tomb);
    }

    #[test]
    fn themes_merge_deliberate_readd_beats_tombstone() {
        // A live entry whose created_at STRICTLY postdates deleted_at is a
        // deliberate re-add of the name — it wins and the theme is live again.
        let tomb = theme(100, 100, "#old").into_tombstone(200);
        let readd = theme(201, 201, "#new");
        let a = themes(vec![("nord", tomb)]);
        let b = themes(vec![("nord", readd.clone())]);
        assert_eq!(merge_custom_themes(&a, &b)["nord"], readd);
        assert_eq!(merge_custom_themes(&b, &a)["nord"], readd);
        assert!(!merge_custom_themes(&a, &b)["nord"].is_tombstone());
    }

    #[test]
    fn themes_merge_tombstone_pair_keeps_greater_deleted_at() {
        let t1 = theme(1, 1, "#x").into_tombstone(10);
        let t2 = theme(1, 1, "#x").into_tombstone(20);
        let a = themes(vec![("nord", t1)]);
        let b = themes(vec![("nord", t2.clone())]);
        assert_eq!(merge_custom_themes(&a, &b)["nord"], t2);
        assert_eq!(merge_custom_themes(&b, &a)["nord"], t2);
    }

    #[test]
    fn themes_merge_lww_tie_breaks_commutatively_on_palette() {
        // Equal updated_at → the greater palette wins on BOTH sides (a
        // tie-to-local rule would not be commutative and the fleet would not
        // converge).
        let n1 = theme(5, 50, "#aaaaaa");
        let n2 = theme(5, 50, "#bbbbbb");
        let a = themes(vec![("nord", n1)]);
        let b = themes(vec![("nord", n2.clone())]);
        assert_eq!(merge_custom_themes(&a, &b)["nord"], n2);
        assert_eq!(merge_custom_themes(&b, &a)["nord"], n2);
    }

    #[test]
    fn themes_merge_tombstone_tie_is_commutative_despite_divergent_updated_at() {
        // Both devices delete "nord" in the same wall-clock second, but A had an
        // unsynced palette edit at t=50 while B still carried t=40. Scrubbing the
        // palette does NOT make the two tombstones byte-identical — `updated_at`
        // still diverges — so the tie-break must be a total order over every
        // retained field. Otherwise each device keeps its own entry, the
        // orchestrator's `merged == remote_map` gate fails on both, and they
        // CAS-ping-pong forever instead of converging.
        let a = themes(vec![("nord", theme(1, 50, "#aaaaaa").into_tombstone(100))]);
        let b = themes(vec![("nord", theme(1, 40, "#bbbbbb").into_tombstone(100))]);
        assert_eq!(merge_custom_themes(&a, &b), merge_custom_themes(&b, &a));
    }

    #[test]
    fn themes_merge_live_tie_is_commutative_despite_divergent_created_at() {
        // Equal `updated_at` AND equal palette, different `created_at` — two
        // devices independently imported the same name. `created_at` must sit in
        // the tie-break key too, or the winner depends on argument order.
        let a = themes(vec![("nord", theme(5, 50, "#aaaaaa"))]);
        let b = themes(vec![("nord", theme(6, 50, "#aaaaaa"))]);
        assert_eq!(merge_custom_themes(&a, &b), merge_custom_themes(&b, &a));
    }

    #[test]
    fn themes_merge_is_commutative_and_idempotent() {
        let a = themes(vec![
            ("nord", theme(1, 1, "#88c0d0")),
            ("gruvbox", theme(100, 100, "#fabd2f").into_tombstone(200)),
            ("dracula", theme(5, 7, "#bd93f9")),
        ]);
        let b = themes(vec![
            ("nord", theme(1, 1, "#88c0d0")),
            ("gruvbox", theme(300, 300, "#d79921")), // re-add: 300 > 200
            ("solarized", theme(4, 4, "#268bd2").into_tombstone(9)),
        ]);
        let ab = merge_custom_themes(&a, &b);
        let ba = merge_custom_themes(&b, &a);
        assert_eq!(ab, ba, "merge must be commutative");
        assert_eq!(
            merge_custom_themes(&ab, &b),
            ab,
            "merge must be idempotent once converged"
        );
        assert_eq!(
            merge_custom_themes(&ab, &ThemesMap::new()),
            ab,
            "merging with empty is identity"
        );
        // The re-add won over the tombstone.
        assert!(!ab["gruvbox"].is_tombstone());
        assert_eq!(ab["gruvbox"].palette, palette("#d79921"));
        // The unilateral tombstone survives the union.
        assert!(ab["solarized"].is_tombstone());
        // The unilateral live entry survives the union.
        assert_eq!(ab["dracula"], theme(5, 7, "#bd93f9"));
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

// ── the quarantine surface, lifted out of the host-gated `commands.rs` ──────
//
// phase3-web-client task 87. `quarantine/` is where `sync-protocol.md` §11.3's
// "moved aside, never destroyed" rule lands on disk, and these four are the only
// way a user gets a note back out of it — so a browser that could not reach them
// would drop notes into a directory with no door.
//
// Nothing here was host-shaped; it merely lived behind an `AppHandle`. The one
// real addition the port needed was `VaultIo::stat`: the listing shows each
// entry's size and age, which `std::fs::DirEntry::metadata` gave for free and
// the seam's `DirEntry` deliberately does not carry (a listing is cheap on both
// arms, a stat is not — OPFS needs a handle acquisition per entry).

/// One quarantined note blob, as listed to the "Recovered notes" UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct QuarantineEntry {
    /// Exact file name under `quarantine/` — the read/restore/delete key.
    /// Duplicates of a re-created id carry a `-<n>` suffix (`quarantine_note`).
    pub file_name: String,
    /// The suffix-stripped base note uuid (36-char lowercase hyphenated) —
    /// display only; a `-<n>` duplicate shares its base id.
    pub note_id_hex: String,
    /// Encrypted blob size in bytes.
    pub size: u64,
    /// Device-local mtime (ms since epoch) — display only, never synced
    /// (AS6 untouched). `None` when the filesystem yields no mtime.
    pub modified_epoch_ms: Option<u64>,
}

/// Validate + parse a UI-supplied quarantine file name. Accepts ONLY the
/// exact shape `quarantine_note` writes — `<uuid>[-<n>].myn`, where `<uuid>`
/// is the 36-char lowercase hyphenated form and `<n>` a decimal duplicate
/// suffix. Anything else (path separators, `..`, absolute paths, other
/// extensions, uppercase) is rejected: this is the path-traversal guard for
/// the read/restore/delete commands. Returns the SUFFIX-STRIPPED base uuid's
/// 16 bytes — the decode AAD (`protocol.md` §9.1: the `.myn` filename is the
/// canonical uuid, so a `-<n>` duplicate still decodes under its base id).
pub(crate) fn parse_quarantine_file_name(name: &str) -> Option<[u8; 16]> {
    let stem = name.strip_suffix(".myn")?;
    let base = stem.get(..36)?;
    let rest = stem.get(36..)?;
    if !rest.is_empty() {
        let digits = rest.strip_prefix('-')?;
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
    }
    let mut hex = String::with_capacity(32);
    for (i, b) in base.bytes().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if b != b'-' {
                    return None;
                }
            }
            _ => {
                if !matches!(b, b'0'..=b'9' | b'a'..=b'f') {
                    return None;
                }
                hex.push(b as char);
            }
        }
    }
    super::devices::hex16(&hex)
}

/// Enumerate `<vault>/quarantine/`, sorted by file name (deterministic
/// across calls and platforms). Non-conforming names are skipped — the dir
/// is engine-written, so anything else is stray (e.g. `.DS_Store`).
pub async fn list_quarantine_entries(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
) -> Vec<QuarantineEntry> {
    let mut out = Vec::new();
    let dir = super::orchestrator::quarantine_dir(vault_root);
    if let Ok(entries) = io.read_dir(&dir).await {
        for e in entries {
            let name = e.name;
            if parse_quarantine_file_name(&name).is_none() {
                continue;
            }
            // One `stat` per surviving entry, and only after the name filter —
            // so a directory full of strays costs nothing extra. Size and age
            // are what let the user tell two recovered copies of the same note
            // apart; `None` degrades the row, never the listing (task 87).
            let meta = io.stat(&dir.join(&name)).await.ok().flatten();
            let size = meta.map(|m| m.size).unwrap_or(0);
            let modified_epoch_ms = meta.and_then(|m| m.modified_epoch_ms);
            out.push(QuarantineEntry {
                note_id_hex: name[..36].to_string(),
                file_name: name,
                size,
                modified_epoch_ms,
            });
        }
    }
    out.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    out
}

/// Read + decrypt one quarantined blob to its plaintext body. The decode AAD
/// is the suffix-stripped base uuid (see [`parse_quarantine_file_name`]).
/// The body is the user's note plaintext (same secret class as `note_read`)
/// — never logged. See the repo `src-tauri/CLAUDE.md` "Secret-handling
/// logging discipline".
pub async fn read_quarantine_with_dir(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
    state: &VaultRuntimeState,
    file_name: &str,
) -> Result<String, SyncDeviceError> {
    let id = parse_quarantine_file_name(file_name).ok_or(SyncDeviceError::BadRequest)?;
    let blob = io
        .read(&super::orchestrator::quarantine_dir(vault_root).join(file_name))
        .await
        .map_err(|_| SyncDeviceError::BadRequest)?;
    let (items_key, items_key_id, _root) = state
        .peek_unlocked_attachment_material()
        .await
        .ok_or(SyncDeviceError::Internal)?;
    // `crate::task::run_blocking`, not `spawn_blocking` (task 87). This call
    // moved out of the host-gated `commands.rs`, where the task-seam guard
    // exempted it automatically; the guard caught it the moment it landed
    // somewhere a browser compiles — which is the exemption-by-inheritance the
    // guard's own comment warns about, happening for real. Left as it was, an
    // AEAD decrypt on a quarantined note would have killed the Worker.
    crate::task::run_blocking(move || {
        let decrypted = protocol::decode_note(&blob, &id, &items_key, &items_key_id)
            .map_err(|_| SyncDeviceError::Internal)?;
        let body = String::from_utf8(decrypted.plaintext().to_vec())
            .map_err(|_| SyncDeviceError::Internal)?;
        drop(decrypted);
        Ok::<String, SyncDeviceError>(body)
    })
    .await
    .map_err(|_| SyncDeviceError::Internal)?
}

/// Restore core: decode the quarantined blob, create a NEW note from its
/// body via the shared `note_create_with_dir` pipeline (fresh backend-minted
/// UUIDv7; slot guard → AEAD → create-only atomic_write), then remove the
/// quarantine source. The source is removed ONLY after the create succeeded
/// — a failed create leaves the evidence intact. Returns the new note's
/// 36-char id plus the body (the Tauri wrapper feeds it to the note-create
/// hooks). No frontmatter marker is added — this is the user's deliberate
/// recovery, not a conflict copy.
pub async fn restore_quarantine_with_dirs(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
    notes_dir: PathBuf,
    state: &VaultRuntimeState,
    file_name: &str,
    // Threaded in with MYND-574 task 13: `note_create_with_dir` takes the host
    // for its duration metric. A `NoopHost` here would compile and silently log
    // every quarantine restore as 0 ms — the production caller has an
    // `AppHandle`, so it passes the real one.
    host: &dyn crate::host::HostCtx,
) -> Result<(String, Zeroizing<String>), SyncDeviceError> {
    let body = Zeroizing::new(read_quarantine_with_dir(io, vault_root, state, file_name).await?);
    let new_id = crate::plugins::notes::commands::note_create_with_dir(
        notes_dir,
        state,
        (*body).clone(),
        io,
        host,
    )
    .await
    .map_err(|_| SyncDeviceError::Internal)?;
    io.remove_file(&super::orchestrator::quarantine_dir(vault_root).join(file_name))
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    Ok((new_id, body))
}

/// Validate the name, then remove one quarantined blob. See the section
/// comment: this command is the only destroyer of `quarantine/` content.
pub async fn delete_quarantine_in(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
    file_name: &str,
) -> Result<(), SyncDeviceError> {
    parse_quarantine_file_name(file_name).ok_or(SyncDeviceError::BadRequest)?;
    io.remove_file(&super::orchestrator::quarantine_dir(vault_root).join(file_name))
        .await
        .map_err(|_| SyncDeviceError::Internal)
}

// ── the keep-both staging surface, lifted out of `commands.rs` (task 87) ────
//
// `conflicts/<id>.myn` is where §10.1's keep-both puts the REMOTE revision when
// two devices edited one note: the local edit is never touched, and these four
// are how the notes layer finishes the resolution. A browser without them would
// stage conflicts it could not resolve — the same shape of dead end quarantine
// had before the pass above.

/// Note ids (36-char uuid strings) with a staged remote revision awaiting
/// resolution.
pub async fn pending_conflicts(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
) -> Vec<String> {
    super::orchestrator::list_pending_conflicts(io, vault_root).await
}

/// Decrypt a staged conflicting remote revision to its plaintext body, so the
/// notes layer can materialize it as a keep-both copy.
///
/// The body is the user's note plaintext (same secret class as `note_read`) —
/// never logged. See `src-tauri/CLAUDE.md` "Secret-handling logging discipline".
pub async fn take_conflict(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
    state: &VaultRuntimeState,
    original_id_hex: &str,
) -> Result<String, SyncDeviceError> {
    let id = super::devices::hex16(original_id_hex).ok_or(SyncDeviceError::BadRequest)?;
    let blob = super::orchestrator::read_staged_conflict_blob(io, vault_root, original_id_hex)
        .await
        .ok_or(SyncDeviceError::BadRequest)?;
    let (items_key, items_key_id, _root) = state
        .peek_unlocked_attachment_material()
        .await
        .ok_or(SyncDeviceError::Internal)?;
    // `crate::task::run_blocking`, not `spawn_blocking` — the same correction the
    // quarantine read needed when it left the host-gated module. An AEAD decrypt
    // on the blocking pool is right natively and fatal in a Worker.
    crate::task::run_blocking(move || {
        let decrypted = protocol::decode_note(&blob, &id, &items_key, &items_key_id)
            .map_err(|_| SyncDeviceError::Internal)?;
        let body = String::from_utf8(decrypted.plaintext().to_vec())
            .map_err(|_| SyncDeviceError::Internal)?;
        drop(decrypted);
        Ok::<String, SyncDeviceError>(body)
    })
    .await
    .map_err(|_| SyncDeviceError::Internal)?
}

/// Finish a keep-both resolution: adopt the staged remote revision as the synced
/// baseline (the untouched local edit then pushes as a linear advance) + clear
/// the staging. Idempotent.
pub async fn resolve_conflict(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
    original_id_hex: &str,
) -> Result<(), SyncDeviceError> {
    super::orchestrator::resolve_conflict(io, vault_root, original_id_hex)
        .await
        .map_err(|_| SyncDeviceError::Internal)
}

/// Queue a deletion so the next push sets its server-side tombstone flag
/// (horizon-GC).
///
/// The id is validated FIRST, before the vault root is resolved: a malformed id
/// is a caller bug and must read as `BadRequest` rather than as whatever the
/// path layer happens to say. No vault-blob access — only the device-local
/// pending-tombstone queue is touched.
pub async fn mark_tombstone(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
    note_id_hex: &str,
) -> Result<(), SyncDeviceError> {
    let _ = super::devices::hex16(note_id_hex).ok_or(SyncDeviceError::BadRequest)?;
    super::orchestrator::add_pending_tombstone(io, vault_root, note_id_hex)
        .await
        .map_err(|_| SyncDeviceError::Internal)
}

// ── quarantine file-name validation (phase3-web-client task 87) ─────────────
//
// `parse_quarantine_file_name` is the PATH-TRAVERSAL GUARD for the quarantine
// read / restore / delete commands: they take a file name from the UI, and this
// is the only thing between that string and a `vault_root.join(...)`. It had no
// test.
//
// The threat is concrete rather than theoretical on this client. The commands
// are reachable from the page, so a name is one `invoke` from a devtools console
// away — and the seam's `read` will happily open whatever path it is handed.
#[cfg(test)]
mod quarantine_name_tests {
    use super::parse_quarantine_file_name as parse;

    const OK: &str = "0193e8d3-1234-7890-abcd-ef0123456789.myn";

    #[test]
    fn accepts_exactly_what_quarantine_note_writes() {
        assert!(parse(OK).is_some());
        // …and the duplicate suffix, which decodes under its BASE uuid because
        // `protocol.md` §9.1 makes the filename the canonical id.
        let with_suffix = parse("0193e8d3-1234-7890-abcd-ef0123456789-2.myn");
        assert_eq!(with_suffix, parse(OK), "a -<n> duplicate keeps the base id");
    }

    #[test]
    fn rejects_every_traversal_shape() {
        for name in [
            "../vault.meta",
            "../../etc/passwd",
            "..%2fvault.meta",
            "/absolute/path.myn",
            "sub/dir/0193e8d3-1234-7890-abcd-ef0123456789.myn",
            "sub\\dir\\0193e8d3-1234-7890-abcd-ef0123456789.myn",
            "0193e8d3-1234-7890-abcd-ef0123456789/../../vault.meta.myn",
        ] {
            assert!(parse(name).is_none(), "{name} must be rejected");
        }
    }

    #[test]
    fn rejects_a_name_that_is_a_valid_uuid_wearing_the_wrong_extension() {
        // The extension is not decoration: a `.myn` is a note blob, and the
        // read/restore paths decode what they open under the uuid as AAD.
        for name in [
            "0193e8d3-1234-7890-abcd-ef0123456789",
            "0193e8d3-1234-7890-abcd-ef0123456789.MYN",
            "0193e8d3-1234-7890-abcd-ef0123456789.myn.bak",
            "0193e8d3-1234-7890-abcd-ef0123456789.json",
        ] {
            assert!(parse(name).is_none(), "{name} must be rejected");
        }
    }

    #[test]
    fn rejects_uppercase_and_non_hex() {
        // Uppercase is rejected rather than normalised: two names that differ
        // only in case would otherwise map to one id, and on a case-insensitive
        // filesystem that is two files claiming one identity.
        assert!(parse("0193E8D3-1234-7890-ABCD-EF0123456789.myn").is_none());
        assert!(parse("0193e8g3-1234-7890-abcd-ef0123456789.myn").is_none());
    }

    #[test]
    fn rejects_a_malformed_duplicate_suffix() {
        for name in [
            "0193e8d3-1234-7890-abcd-ef0123456789-.myn",  // empty
            "0193e8d3-1234-7890-abcd-ef0123456789-a.myn", // not digits
            "0193e8d3-1234-7890-abcd-ef0123456789_2.myn", // wrong separator
            "0193e8d3-1234-7890-abcd-ef01234567892.myn",  // no separator at all
        ] {
            assert!(parse(name).is_none(), "{name} must be rejected");
        }
    }

    #[test]
    fn rejects_the_empty_and_the_short() {
        // `get(..36)` returns `None` rather than panicking on a short name — and
        // a slice index would have panicked, which on this client means a wasm
        // trap that kills the Worker. Asserted so a future rewrite keeps it.
        for name in ["", ".myn", "a.myn", "0193e8d3.myn"] {
            assert!(
                parse(name).is_none(),
                "{name:?} must be rejected, not panic"
            );
        }
    }

    #[test]
    fn rejects_a_multibyte_boundary_without_panicking() {
        // `get(..36)` on a string whose 36th byte is mid-character returns
        // `None`; `&s[..36]` would panic. The distinction matters here more than
        // usual: a panic in wasm aborts the instance permanently.
        let name = format!("{}é-1234-7890-abcd-ef0123456789.myn", "0193e8d3".repeat(4));
        assert!(parse(&name).is_none());
    }
}

// ── quarantine restore: the id it must NOT reuse (task 87) ──────────────────

#[cfg(test)]
mod quarantine_restore_tests {
    use super::*;
    use crate::plugins::vault_creation::commands::{build_and_serialize_vault_meta, build_session};
    use crate::plugins::vault_unlock::commands::unlock_with_path;
    use crate::test_support::{ScratchVault, FAST_TEST_KDF};
    use crate::vault_io::VaultIo as _;

    const IO: crate::vault_io::StdVaultIo = crate::vault_io::StdVaultIo;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    /// An unlocked vault with a `notes/` directory, ready to mint notes.
    async fn unlocked() -> (VaultRuntimeState, ScratchVault) {
        let scratch = ScratchVault::new("quarantine-restore");
        let session = build_session(
            crate::vault_id::VaultId::mint(),
            "pw-restore-1",
            FAST_TEST_KDF,
        )
        .expect("build_session");
        scratch.write_meta(&build_and_serialize_vault_meta(&session).expect("serialize"));
        let state = VaultRuntimeState::default();
        unlock_with_path(
            "pw-restore-1".to_string(),
            None,
            scratch.path(),
            &state,
            &IO,
            &crate::host::NoopHost,
        )
        .await
        .expect("unlock");
        std::fs::create_dir_all(scratch.path().parent().unwrap().join("notes")).ok();
        (state, scratch)
    }

    /// Write a real encrypted note under `id`, then move it into `quarantine/`
    /// exactly as the reconcile path does. Returns the quarantine file name.
    async fn quarantined_note(
        state: &VaultRuntimeState,
        vault_root: &Path,
        body: &str,
    ) -> (String, uuid::Uuid) {
        let notes_dir = vault_root.join("notes");
        let id_str = crate::plugins::notes::commands::note_create_with_dir(
            notes_dir.clone(),
            state,
            body.to_string(),
            &IO,
            &crate::host::NoopHost,
        )
        .await
        .expect("mint the note that will be quarantined");
        let id = uuid::Uuid::parse_str(&id_str).expect("canonical uuid");

        // The reconcile path's write-then-remove, reproduced rather than called
        // (`quarantine_note` is private to `orchestrator`). The property under
        // test is what RESTORE does with the file, not how it got there.
        let qdir = super::super::orchestrator::quarantine_dir(vault_root);
        IO.create_dir_all(&qdir).await.expect("quarantine dir");
        let src = notes_dir.join(format!("{id}.myn"));
        let bytes = IO.read(&src).await.expect("read the minted blob");
        let name = format!("{id}.myn");
        IO.write(
            &qdir.join(&name),
            &bytes,
            crate::vault_io::WriteOpts::default(),
        )
        .await
        .expect("stage into quarantine");
        IO.remove_file(&src).await.expect("drop the original");
        (name, id)
    }

    /// The criterion, and the reason it is one.
    ///
    /// A quarantined note is one this device could not reconcile — the server
    /// holds a blob under that id which this client failed to apply. If restore
    /// re-used the id, the vault would hold a note whose local bytes differ from
    /// the server's under the SAME id, and the next push would send it: this
    /// device would overwrite the server's copy with content derived from a blob
    /// it could not even decrypt, using an id it does not own the history of.
    ///
    /// Minting a fresh id makes the restored note an ordinary new note — pushed
    /// as an addition, colliding with nothing.
    #[test]
    fn restore_mints_a_fresh_id_and_leaves_the_original_unclaimed() {
        rt().block_on(async {
            let (state, scratch) = unlocked().await;
            let vault_root = scratch.path().parent().unwrap().to_path_buf();
            let notes_dir = vault_root.join("notes");
            let (file_name, original_id) =
                quarantined_note(&state, &vault_root, "the quarantined body").await;

            let (new_id, body) = restore_quarantine_with_dirs(
                &IO,
                &vault_root,
                notes_dir.clone(),
                &state,
                &file_name,
                &crate::host::NoopHost,
            )
            .await
            .expect("restore");

            assert_ne!(
                new_id,
                original_id.to_string(),
                "restore MUST mint a fresh id — reusing the quarantined one would \
                 push local bytes over the server's copy under an id this device \
                 could not reconcile"
            );
            assert_eq!(&*body, "the quarantined body", "the plaintext round-trips");

            // The fresh note exists on disk…
            assert!(
                notes_dir.join(format!("{new_id}.myn")).exists(),
                "the restored note must be an ordinary note in notes/"
            );
            // …and NOTHING claims the original id. This is the half that makes
            // "never re-pushed" true rather than merely intended: the push loop
            // scans `notes/`, so an absent file is an id it cannot send.
            assert!(
                !notes_dir.join(format!("{original_id}.myn")).exists(),
                "the original id must have no local note to push"
            );
        });
    }

    /// The source is dropped, so a second restore cannot mint a second copy.
    ///
    /// Without this, a user who clicked twice would get two notes from one
    /// quarantined blob and no way to tell which was which — and the staging
    /// area would still show the entry, inviting a third.
    #[test]
    fn restore_drops_the_source_so_it_cannot_be_restored_twice() {
        rt().block_on(async {
            let (state, scratch) = unlocked().await;
            let vault_root = scratch.path().parent().unwrap().to_path_buf();
            let notes_dir = vault_root.join("notes");
            let (file_name, _) = quarantined_note(&state, &vault_root, "restore me once").await;

            restore_quarantine_with_dirs(
                &IO,
                &vault_root,
                notes_dir.clone(),
                &state,
                &file_name,
                &crate::host::NoopHost,
            )
            .await
            .expect("first restore");

            assert!(
                !super::super::orchestrator::quarantine_dir(&vault_root)
                    .join(&file_name)
                    .exists(),
                "the quarantined blob must be gone after a successful restore"
            );
            assert!(
                restore_quarantine_with_dirs(
                    &IO,
                    &vault_root,
                    notes_dir,
                    &state,
                    &file_name,
                    &crate::host::NoopHost,
                )
                .await
                .is_err(),
                "a second restore of the same name must fail rather than mint a duplicate"
            );
        });
    }

    /// Two quarantined copies of one id — the `-<n>` duplicate shape — restore
    /// to two DISTINCT fresh ids. They decode under the same base uuid, so a
    /// restore that derived the new id from the AAD id rather than minting one
    /// would collapse them into a single note and silently lose a revision.
    #[test]
    fn duplicate_quarantine_entries_restore_to_distinct_notes() {
        rt().block_on(async {
            let (state, scratch) = unlocked().await;
            let vault_root = scratch.path().parent().unwrap().to_path_buf();
            let notes_dir = vault_root.join("notes");
            let qdir = super::super::orchestrator::quarantine_dir(&vault_root);

            let (first_name, id) = quarantined_note(&state, &vault_root, "revision one").await;
            // The `-1` sibling the writer produces when the target is occupied.
            let dup_name = format!("{id}-1.myn");
            let bytes = IO.read(&qdir.join(&first_name)).await.expect("read staged");
            IO.write(
                &qdir.join(&dup_name),
                &bytes,
                crate::vault_io::WriteOpts::default(),
            )
            .await
            .expect("stage the duplicate");

            let (a, _) = restore_quarantine_with_dirs(
                &IO,
                &vault_root,
                notes_dir.clone(),
                &state,
                &first_name,
                &crate::host::NoopHost,
            )
            .await
            .expect("restore base");
            let (b, _) = restore_quarantine_with_dirs(
                &IO,
                &vault_root,
                notes_dir,
                &state,
                &dup_name,
                &crate::host::NoopHost,
            )
            .await
            .expect("restore duplicate");

            assert_ne!(a, b, "two staged copies must become two notes");
            assert_ne!(a, id.to_string());
            assert_ne!(b, id.to_string());
        });
    }
}
