// SPDX-License-Identifier: AGPL-3.0
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
//!   ordered lists). Pure and deterministic.
//!
//!   `merge_set_union` is tie-broken without a clock dependency, and is the only
//!   set primitive left here: the FOLDED variant the four `vault.prefs` folder
//!   sets used moved to `prefs_merge::merge_set_with_removals` in
//!   myne-md/myne#613, because those sets stopped being clockless. A folded
//!   union with no removal clock cannot express a deletion, which is what that
//!   issue fixed; leaving a primitive here that still could would have left two
//!   meanings of "set-union" in this crate, with the stale one looking
//!   canonical.
//! - **Map singletons → per-key union** ([`merge_attachments_catalog`] by
//!   attachment-id, [`merge_custom_themes`] by theme name): both reconcile per
//!   entry via the shared [`join_by_version`] — greater causal `version` wins,
//!   ties fall to a remove-wins total order — which makes the merge associative
//!   (myne-md/myne#405).
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
use std::cmp::Ordering;
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
/// the `sync-protocol.md` §11.4 rule-4 reconciliation (MYND-468 + causal
/// `version`, myne-md/myne#405). Pure, deterministic, **commutative**,
/// **idempotent** AND **associative**, so a FLEET converges on the same catalog
/// bytes whichever way round it reconciles.
///
/// - **only one side has the id** → keep it (union; entries are
///   content-addressed and the core fields immutable).
/// - **both sides have the id** → [`merge_attachment_entry`]: a join over the
///   per-entry causal `version` (greater wins), with [`attachment_tie_break`]
///   (remove-wins tombstone-ness, then a total field order) deciding an
///   equal-`version` tie. A delete bumps `version` so a tombstone outranks the
///   live entry it replaces; a deliberate re-add observes the delete and
///   outranks the tombstone. The winner's whole entry is kept — core fields
///   agree by construction on a shared id.
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
/// [`merge_attachments_catalog`] for the full rule table) — a join over the
/// causal `version` (myne-md/myne#405): greater `version` wins; an
/// equal-`version` tie is broken by [`attachment_tie_break`] (a total order,
/// remove-wins). Structurally the themes twin ([`merge_theme_entry`]).
fn merge_attachment_entry(a: &AttachmentMeta, b: &AttachmentMeta) -> AttachmentMeta {
    join_by_version(a, b, |e| e.version, attachment_tie_break)
}

/// Total-order tie-break for two same-id catalog entries at an equal `version`
/// (a true concurrent re-add-vs-delete). **Remove-wins**: a tombstone outranks
/// a live entry. Within a class it compares every retained field so the order
/// is total (`Equal` only when byte-identical): tombstones on
/// `(deleted_at, created_at, updated_at, filename, content_type, size)`, live
/// on `(ts, filename, created_at, updated_at, content_type, size)` with
/// `ts = updated_at.unwrap_or(created_at)`.
fn attachment_tie_break(a: &AttachmentMeta, b: &AttachmentMeta) -> Ordering {
    match (a.is_tombstone(), b.is_tombstone()) {
        (true, false) => Ordering::Greater, // remove-wins
        (false, true) => Ordering::Less,
        (true, true) => (
            a.deleted_at,
            a.created_at,
            a.updated_at,
            &a.filename,
            &a.content_type,
            a.size,
        )
            .cmp(&(
                b.deleted_at,
                b.created_at,
                b.updated_at,
                &b.filename,
                &b.content_type,
                b.size,
            )),
        (false, false) => {
            let ts_a = a.updated_at.unwrap_or(a.created_at);
            let ts_b = b.updated_at.unwrap_or(b.created_at);
            (
                ts_a,
                &a.filename,
                a.created_at,
                a.updated_at,
                &a.content_type,
                a.size,
            )
                .cmp(&(
                    ts_b,
                    &b.filename,
                    b.created_at,
                    b.updated_at,
                    &b.content_type,
                    b.size,
                ))
        }
    }
}

/// `vault.themes` custom-theme merge — per-entry union by theme **name**
/// (MYND-486 + causal `version`, myne-md/myne#405). The
/// `merge_attachments_catalog` twin: pure, deterministic, **commutative**,
/// **idempotent** AND **associative**, so a FLEET converges whichever way round
/// it reconciles.
///
/// It is **associative** too (myne-md/myne#405): the per-name reconcile is a
/// join over a causal `version` (see [`merge_theme_entry`]), and "pick the
/// maximum under a total order" is associative — so a three-device fleet
/// reaches a fixed point instead of the CAS-ping-pong the earlier
/// `created_at`-vs-`deleted_at` filter admitted.
///
/// - **only one side has the name** → keep it (union). A concurrent add of
///   "Nord" on A and "Solarized" on B leaves BOTH — the reason `vault.themes`
///   is a per-name map merge and not whole-value LWW (a theme is dozens of
///   tokens of hand authoring; silently losing one to a concurrent add is real
///   data loss).
/// - **both sides have the name** → [`merge_theme_entry`]: greater `version`
///   wins; an equal-`version` tie falls to [`theme_tie_break`] (remove-wins
///   tombstone-ness, then a total field order). A delete bumps `version` so a
///   tombstone outranks the live copy it replaces; a re-add that observed the
///   delete outranks the tombstone. A live palette is LWW **within** a name —
///   ONE coherent design, never merged token-by-token into a Frankenstein.
///
/// **Why the total order matters:** the join is "pick the maximum under
/// `(version, tie_break)`", and the tie-break compares every retained field so
/// it is a total order (`Equal` only for byte-identical entries). Leaving any
/// field out would make the ARGUMENT ORDER the tie-breaker — not cosmetic:
/// `sync_themes_phase` gates its push on `merged == remote_map`, so two devices
/// that merged to different bytes would re-push forever. Proven by the
/// `themes_entry_merge_is_associative_commutative_idempotent` property test and
/// the `themes_three_device_counterexample_converges_no_ping_pong` sim.
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

/// Join two versions of the same key held by a tombstone-guarded singleton
/// (`vault.themes` / `vault.attachments`): pick the maximum under the TOTAL
/// order (`version`, then `tie_break`). "Max under a total order" is
/// commutative, idempotent AND associative — which is exactly what closes the
/// three-device CAS ping-pong the old `created_at`-vs-`deleted_at` guard
/// admitted (`sync-protocol.md` §10.2.2 / §11.4, myne-md/myne#405). `tie_break`
/// is consulted ONLY on an equal `version` and MUST be a total order (returning
/// `Equal` only for byte-identical entries) with remove-wins tombstone-ness
/// folded in.
pub(crate) fn join_by_version<T: Clone>(
    a: &T,
    b: &T,
    version: impl Fn(&T) -> u64,
    tie_break: impl Fn(&T, &T) -> Ordering,
) -> T {
    // One lexicographic order: `version` primary, `tie_break` only on an equal
    // version (`then_with` is lazy). Keep `a` unless the combined order puts it
    // strictly below `b` — which makes the join commutative, because a total
    // `tie_break` gives `cmp(a,b) == Less ⟺ cmp(b,a) == Greater`.
    if version(a).cmp(&version(b)).then_with(|| tie_break(a, b)) == Ordering::Less {
        b.clone()
    } else {
        a.clone()
    }
}

/// The per-name reconciliation (see [`merge_custom_themes`] for the full rule
/// table) — structurally the catalog's [`merge_attachment_entry`]. A join over
/// the causal `version` (myne-md/myne#405): greater `version` wins; an
/// equal-`version` tie is broken by [`theme_tie_break`] (a total order,
/// remove-wins).
fn merge_theme_entry(a: &ThemeEntry, b: &ThemeEntry) -> ThemeEntry {
    join_by_version(a, b, |e| e.version, theme_tie_break)
}

/// Total-order tie-break for two same-name theme entries at an equal `version`
/// (a true concurrent add-vs-delete). **Remove-wins**: a tombstone outranks a
/// live entry. Within a class it compares every retained field so the order is
/// total (`Equal` only when the entries are byte-identical): tombstones on
/// `(deleted_at, created_at, updated_at, palette)`, live on
/// `(updated_at, palette, created_at)`.
fn theme_tie_break(a: &ThemeEntry, b: &ThemeEntry) -> Ordering {
    match (a.is_tombstone(), b.is_tombstone()) {
        (true, false) => Ordering::Greater, // remove-wins
        (false, true) => Ordering::Less,
        (true, true) => (a.deleted_at, a.created_at, a.updated_at, &a.palette).cmp(&(
            b.deleted_at,
            b.created_at,
            b.updated_at,
            &b.palette,
        )),
        (false, false) => {
            (a.updated_at, &a.palette, a.created_at).cmp(&(b.updated_at, &b.palette, b.created_at))
        }
    }
}

// ---- AI conversations (myne-md/myne#675) ----
//
// Two merges, one per half of the storage pair:
//
// 1. `merge_chats_catalog`: the `MYM1` roster, structurally the themes merge:
//    a per-key join over the causal `version` with a remove-wins total-order
//    tie-break. A conversation deleted on one device while appended-to on
//    another resolves remove-wins (the appended turns are discarded at merge,
//    `decisions/ai/0575` records the cost and the confirm modal as the
//    user-facing guard).
//
// 2. `merge_chats_turns`: the `MYJ1` turn list, the one NEW shape: an
//    append-ordered transcript where turns are immutable and ids are unique
//    per client. The common prefix is kept verbatim; both divergent suffixes
//    are kept, ordered by the turn-id total order (lexicographic on the id
//    string: the id scheme embeds a client discriminator, so cross-client
//    collisions cannot arise and the byte order is argument-independent).
//    "Keep both suffixes in a deterministic order" is commutative,
//    idempotent and associative, which is what closes the CAS ping-pong.

use crate::plugins::chats::commands::{ChatsCatalogMap, ConversationEntry};

/// Merge two `vault.chats` catalog maps: the per-key causal join with
/// remove-wins tombstone ties (the `merge_custom_themes` discipline applied to
/// the conversation roster, § 9.23 + `sync-protocol.md` § 11.4).
pub fn merge_chats_catalog(local: &ChatsCatalogMap, remote: &ChatsCatalogMap) -> ChatsCatalogMap {
    let mut merged = ChatsCatalogMap::new();
    let ids = merge_set_union(
        &local.keys().cloned().collect::<Vec<_>>(),
        &remote.keys().cloned().collect::<Vec<_>>(),
    );
    for id in ids {
        let entry = match (local.get(&id), remote.get(&id)) {
            (Some(l), None) => l.clone(),
            (None, Some(r)) => r.clone(),
            (Some(l), Some(r)) => join_by_version(l, r, |e| e.version, chats_entry_tie_break),
            (None, None) => unreachable!("id came from the key union"),
        };
        merged.insert(id, entry);
    }
    merged
}

/// Total-order tie-break for two catalog rows at an equal `version`
/// (a true concurrent mutation pair). **Remove-wins**: a tombstone outranks a
/// live row. Within a class it compares every retained field so the order is
/// total (`Equal` only when the rows are byte-identical).
fn chats_entry_tie_break(a: &ConversationEntry, b: &ConversationEntry) -> Ordering {
    match (a.deleted_at.is_some(), b.deleted_at.is_some()) {
        (true, false) => Ordering::Greater, // remove-wins
        (false, true) => Ordering::Less,
        (true, true) => (
            a.deleted_at,
            a.created_at,
            a.updated_at,
            &a.title,
            &a.note_id,
            &a.folder,
        )
            .cmp(&(
                b.deleted_at,
                b.created_at,
                b.updated_at,
                &b.title,
                &b.note_id,
                &b.folder,
            )),
        (false, false) => (a.updated_at, &a.title, a.created_at, &a.note_id, &a.folder).cmp(&(
            b.updated_at,
            &b.title,
            b.created_at,
            &b.note_id,
            &b.folder,
        )),
    }
}

/// Merge two versions of one conversation's turn list (the `MYJ1` payload's
/// `turns` array): keep the common prefix verbatim, keep BOTH divergent
/// suffixes, order the suffix turns by the turn-id total order (lexicographic
/// on the id string: the ids embed a client discriminator, so the order is
/// deterministic and argument-independent). Commutative, idempotent and
/// associative by construction; no turn is ever dropped.
///
/// The input lists are each assumed internally sorted by the same id order
/// (the write path appends under the id scheme's monotonic counter). An
/// id present on both sides contributes ONE turn (the ids are unique per
/// client; an equal id on both sides is the same settled turn).
pub fn merge_chats_turns(local: &[String], remote: &[String]) -> Vec<String> {
    // Longest common prefix.
    let mut prefix_len = 0;
    while prefix_len < local.len()
        && prefix_len < remote.len()
        && local[prefix_len] == remote[prefix_len]
    {
        prefix_len += 1;
    }
    let mut out = Vec::with_capacity(local.len() + remote.len() - prefix_len);
    out.extend_from_slice(&local[..prefix_len]);
    // Both divergent suffixes, merged by the id total order.
    let mut i = prefix_len;
    let mut j = prefix_len;
    while i < local.len() && j < remote.len() {
        match local[i].cmp(&remote[j]) {
            Ordering::Equal => {
                // The same id on both sides: one turn.
                out.push(local[i].clone());
                i += 1;
                j += 1;
            }
            Ordering::Less => {
                out.push(local[i].clone());
                i += 1;
            }
            Ordering::Greater => {
                out.push(remote[j].clone());
                j += 1;
            }
        }
    }
    out.extend_from_slice(&local[i..]);
    out.extend_from_slice(&remote[j..]);
    out
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
    // The membership field is device-local: the LOCAL value always survives,
    // regardless of which side won the password-side. Grouping is a per-device
    // organisational choice, so a divergent grouping across devices must never
    // converge and never produce a conflict surface (`sync-protocol.md` §10.3).
    //
    // The B2B **roster extension** is the one deliberate reversal
    // (b2b-identity-substrate task 4, myne-md/myne#698): the member list is a
    // SHARED fact. Its merge lives in `super::roster` (`merge_rosters`, the
    // attachments-catalog §11.4 pattern) and runs at the CALLER, which
    // holds the unlocked `root_key` the roster envelopes need to be opened
    // with: this function sees only opaque ciphertext and merges nothing
    // behind it. The single-account half stays device-local exactly as 0580
    // classified it, so the LOCAL envelope (single-account + whatever roster
    // the caller re-sealed into it) always wins here.
    merged.membership = local.membership.clone();
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{
        VAULT_META_ITEMS_KEY_ID_LEN, VAULT_META_NONCE_LEN, VAULT_META_SALT_RANDOM_LEN,
        VAULT_META_WRAPPED_ITEMS_KEY_LEN, VAULT_META_WRAPPED_ROOT_KEY_LEN,
    };

    /// Cross-implementation vector runner for the chats merges
    /// (myne-md/myne#675). Reads
    /// `../myne-test-vectors/vectors/chats-merge/v0.1/cases.json` and drives
    /// [`merge_chats_catalog`] + [`merge_chats_turns`] over the fixture maps
    /// and id lists.
    ///
    /// Skips when the companion is not cloned, matching the `tls-exporter`
    /// precedent: a contributor not touching sync should not see a red test
    /// about their checkout layout. `MYNE_VECTORS_REQUIRED=1` inverts the
    /// skip, and an empty case set fails rather than passing vacuously.
    /// Every two-sided case runs in BOTH argument orders, so commutativity is
    /// structural rather than restated in the expected value.
    #[test]
    fn chats_merge_matches_every_published_vector() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../myne-test-vectors/vectors/chats-merge/v0.1/cases.json");
        let Ok(raw) = std::fs::read_to_string(&path) else {
            assert!(
                std::env::var_os("MYNE_VECTORS_REQUIRED").is_none(),
                "MYNE_VECTORS_REQUIRED is set but the chats-merge vectors are absent at {}",
                path.display(),
            );
            eprintln!("[skip] chats-merge vectors absent at {}", path.display());
            return;
        };
        let doc: serde_json::Value = serde_json::from_str(&raw).expect("vectors parse as JSON");
        assert_eq!(doc["schema"], "chats-merge");
        assert_eq!(doc["protocol_version"], "v0.1");
        let cases = doc["cases"]
            .as_array()
            .expect("vectors carry a cases array");
        assert!(!cases.is_empty(), "chats-merge vectors must not be empty");

        fn catalog_map(case: &serde_json::Value, id: &str, field: &str) -> ChatsCatalogMap {
            serde_json::from_value(case[field].clone())
                .unwrap_or_else(|e| panic!("[{id}] {field} parses as a chats catalog map: {e}"))
        }
        fn id_list(case: &serde_json::Value, id: &str, field: &str) -> Vec<String> {
            serde_json::from_value(case[field].clone())
                .unwrap_or_else(|e| panic!("[{id}] {field} parses as a turn-id list: {e}"))
        }

        for case in cases {
            let id = case["vector_id"]
                .as_str()
                .expect("case carries a vector_id");
            let kind = case["case_kind"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
            match kind {
                "catalog_merge" => {
                    let local = catalog_map(case, id, "input_local");
                    let remote = catalog_map(case, id, "input_remote");
                    let expected = catalog_map(case, id, "expected_merged");
                    assert_eq!(
                        merge_chats_catalog(&local, &remote),
                        expected,
                        "[{id}] catalog merge"
                    );
                    assert_eq!(
                        merge_chats_catalog(&remote, &local),
                        expected,
                        "[{id}] catalog merge, swapped (commutativity)"
                    );
                }
                "catalog_merge_assoc" => {
                    let a = catalog_map(case, id, "input_a");
                    let b = catalog_map(case, id, "input_b");
                    let c = catalog_map(case, id, "input_c");
                    let expected = catalog_map(case, id, "expected_merged");
                    let left = merge_chats_catalog(&merge_chats_catalog(&a, &b), &c);
                    let right = merge_chats_catalog(&a, &merge_chats_catalog(&b, &c));
                    assert_eq!(left, expected, "[{id}] (A+B)+C");
                    assert_eq!(right, expected, "[{id}] A+(B+C)");
                }
                "turns_merge" => {
                    let local = id_list(case, id, "input_local");
                    let remote = id_list(case, id, "input_remote");
                    let expected = id_list(case, id, "expected_merged");
                    assert_eq!(
                        merge_chats_turns(&local, &remote),
                        expected,
                        "[{id}] turns merge"
                    );
                    assert_eq!(
                        merge_chats_turns(&remote, &local),
                        expected,
                        "[{id}] turns merge, swapped (commutativity)"
                    );
                }
                other => panic!("[{id}] unknown case_kind '{other}'"),
            }
        }
    }

    /// Cross-implementation vector runner for the memory-catalog merges
    /// (myne-md/myne#697), the `chats-merge` twin: it reads
    /// `../myne-test-vectors/vectors/agent-memory-merge/v0.1/cases.json` and
    /// drives the SAME published cases every other implementation reads, so a
    /// port that disagrees is caught here rather than by a user losing an
    /// entry on a sync round.
    #[test]
    fn memory_merge_matches_every_published_vector() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../myne-test-vectors/vectors/agent-memory-merge/v0.1/cases.json");
        let Ok(raw) = std::fs::read_to_string(&path) else {
            assert!(
                std::env::var_os("MYNE_VECTORS_REQUIRED").is_none(),
                "MYNE_VECTORS_REQUIRED is set but the agent-memory-merge vectors are absent at {}",
                path.display(),
            );
            eprintln!(
                "[skip] agent-memory-merge vectors absent at {}",
                path.display()
            );
            return;
        };
        let doc: serde_json::Value = serde_json::from_str(&raw).expect("vectors parse as JSON");
        assert_eq!(doc["schema"], "agent-memory-merge");
        assert_eq!(doc["protocol_version"], "v0.1");
        let cases = doc["cases"]
            .as_array()
            .expect("vectors carry a cases array");
        assert!(
            cases.len() >= 3,
            "agent-memory-merge must carry at least 3 vectors (2 catalog_merge + 1 catalog_merge_assoc); found {}",
            cases.len()
        );
        assert!(
            !cases.is_empty(),
            "agent-memory-merge vectors must not be empty"
        );

        fn catalog_map(case: &serde_json::Value, id: &str, field: &str) -> MemoryCatalogMap {
            serde_json::from_value(case[field].clone())
                .unwrap_or_else(|e| panic!("[{id}] {field} parses as a memory catalog map: {e}"))
        }

        let mut seen = std::collections::HashSet::new();
        for case in cases {
            let id = case["vector_id"]
                .as_str()
                .expect("case carries a vector_id");
            let kind = case["case_kind"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
            seen.insert(kind.to_string());
            match kind {
                "catalog_merge" => {
                    let local = catalog_map(case, id, "input_local");
                    let remote = catalog_map(case, id, "input_remote");
                    let expected = catalog_map(case, id, "expected_merged");
                    assert_eq!(
                        merge_memory_catalog(&local, &remote),
                        expected,
                        "[{id}] memory catalog merge"
                    );
                    // Commutativity is a published property, so a port that
                    // gets one direction right and the other wrong is caught.
                    assert_eq!(
                        merge_memory_catalog(&remote, &local),
                        expected,
                        "[{id}] memory catalog merge, swapped (commutativity)"
                    );
                    // Idempotence: a re-merge of the winner is a no-op, which
                    // is what stops a device pushing forever.
                    assert_eq!(
                        merge_memory_catalog(&expected, &expected),
                        expected,
                        "[{id}] memory catalog merge is idempotent"
                    );
                }
                "catalog_merge_assoc" => {
                    let a = catalog_map(case, id, "input_a");
                    let b = catalog_map(case, id, "input_b");
                    let c = catalog_map(case, id, "input_c");
                    let expected = catalog_map(case, id, "expected_merged");
                    let left = merge_memory_catalog(&merge_memory_catalog(&a, &b), &c);
                    let right = merge_memory_catalog(&a, &merge_memory_catalog(&b, &c));
                    assert_eq!(left, expected, "[{id}] (A+B)+C");
                    assert_eq!(right, expected, "[{id}] A+(B+C)");
                }
                other => panic!("[{id}] unknown case_kind '{other}'"),
            }
        }
        for required in ["catalog_merge", "catalog_merge_assoc"] {
            assert!(
                seen.contains(required),
                "agent-memory-merge missing every case of case_kind '{required}': coverage regression"
            );
        }
    }

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

    /// A live entry at an explicit causal `version` — for the tombstone/re-add
    /// tests, where the winner is decided by `version` (a re-add that observed
    /// the delete carries a higher one).
    fn live_v(version: u64, created_at: u64, filename: &str) -> AttachmentMeta {
        let mut m = live(created_at, filename);
        m.version = version;
        m
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
        // Delete (tombstone, version 1) vs a still-live copy that never observed
        // the delete (version 0) → the tombstone wins on the greater `version`.
        let tomb = live(100, "x").into_tombstone(200); // version 1
        let a = catalog(vec![("aa", tomb.clone())]);
        let b = catalog(vec![("aa", live(150, "x"))]); // version 0
        assert_eq!(merge_attachments_catalog(&a, &b).entries["aa"], tomb);
        // A concurrent re-add at the SAME version is remove-wins → still tombstone.
        let b_eq = catalog(vec![("aa", live_v(1, 200, "x"))]);
        assert_eq!(merge_attachments_catalog(&a, &b_eq).entries["aa"], tomb);
    }

    #[test]
    fn catalog_merge_readd_beats_tombstone() {
        // A re-add that OBSERVED the delete carries a higher `version` than the
        // tombstone (the import path bumps `max(observed) + 1`), so the deliberate
        // re-add of the same content-addressed file wins (myne-md/myne#405).
        let tomb = live(100, "x").into_tombstone(200); // version 1
        let readd = live_v(2, 201, "x-again"); // observed the delete → version 2
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
            ("bb", live_v(2, 300, "b2.png")), // re-add observed the delete → version 2 > 1
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

    /// A tombstone at an explicit `version` (metadata scrubbed), for the
    /// property checks below.
    fn catalog_tomb(version: u64, created_at: u64, deleted_at: u64) -> AttachmentMeta {
        let mut t = live(created_at, "x").into_tombstone(deleted_at);
        t.version = version;
        t
    }

    /// The three join laws (idempotence, commutativity, associativity) over a
    /// representative state space — shared by the themes + catalog property
    /// tests. Associativity is the property that closes the three-device CAS
    /// ping-pong (myne-md/myne#405).
    fn assert_join_laws<T: Clone + PartialEq + std::fmt::Debug>(
        states: &[T],
        merge: impl Fn(&T, &T) -> T,
    ) {
        for a in states {
            assert_eq!(&merge(a, a), a, "idempotent: merge(a,a) == a");
        }
        for a in states {
            for b in states {
                assert_eq!(merge(a, b), merge(b, a), "commutative");
            }
        }
        for a in states {
            for b in states {
                for c in states {
                    assert_eq!(
                        merge(&merge(a, b), c),
                        merge(a, &merge(b, c)),
                        "associative: (a∨b)∨c == a∨(b∨c)"
                    );
                }
            }
        }
    }

    #[test]
    fn catalog_entry_merge_is_associative_commutative_idempotent() {
        // EXHAUSTIVE property check — the catalog twin of the themes property
        // test. `merge_attachment_entry` is a join over the total order
        // (`version`, then the tie-break), so it MUST be commutative, idempotent
        // AND associative — the property that closes the three-device CAS
        // ping-pong (myne-md/myne#405).
        let mut states = Vec::new();
        for &version in &[0u64, 1, 2, 3] {
            for &ts in &[1u64, 2] {
                for name in &["a.png", "b.png"] {
                    states.push(live_v(version, ts, name)); // live
                    states.push(catalog_tomb(version, ts, ts + 5)); // tombstone
                }
            }
        }
        assert_join_laws(&states, merge_attachment_entry);
    }

    #[test]
    fn catalog_merge_l1_t_l2_counterexample_now_converges() {
        // The §11.4 twin of the themes counterexample: three concurrent states at
        // the SAME version. The old created_at-vs-deleted_at guard diverged by
        // pairing order; the version-primary join's tie-break is a total order, so
        // both pairings agree (remove-wins makes the tombstone the fixed point).
        let l1 = live_v(1, 10, "l1.png");
        let t = catalog_tomb(1, 100, 5);
        let l2 = live_v(1, 1, "l2.png");
        let left = merge_attachment_entry(&merge_attachment_entry(&l1, &t), &l2);
        let right = merge_attachment_entry(&l1, &merge_attachment_entry(&t, &l2));
        assert_eq!(left, right, "converges under any pairing");
        assert!(
            left.is_tombstone(),
            "remove-wins: the tombstone is the fixed point"
        );
    }

    #[test]
    fn catalog_merge_absent_version_zero_loses_to_stamped() {
        // A legacy entry decodes with version 0; the first stamped (>= 1) write
        // outranks it — the absent=0 migration.
        let legacy = live_v(0, 5, "legacy.png");
        let stamped = live_v(1, 5, "stamped.png");
        assert_eq!(merge_attachment_entry(&legacy, &stamped), stamped);
        assert_eq!(merge_attachment_entry(&stamped, &legacy), stamped);
    }

    // ---- merge_custom_themes (MYND-486, per-theme-name map merge) ----

    fn palette(accent: &str) -> crate::plugins::themes::commands::ThemePalette {
        crate::plugins::themes::commands::ThemePalette::from([("--accent".into(), accent.into())])
    }

    /// A live entry: imported at `created_at`, last edited at `updated_at`, at
    /// causal `version` 1 (a fresh entry). Use [`theme_v`] when a test needs an
    /// explicit `version`.
    fn theme(created_at: u64, updated_at: u64, accent: &str) -> ThemeEntry {
        theme_v(1, created_at, updated_at, accent)
    }

    /// A live entry at an explicit causal `version` — for the tombstone/re-add
    /// tests, where the winner is decided by `version` (a re-add that observed
    /// the delete carries a higher one).
    fn theme_v(version: u64, created_at: u64, updated_at: u64, accent: &str) -> ThemeEntry {
        ThemeEntry {
            created_at,
            deleted_at: None,
            palette: palette(accent),
            updated_at,
            version,
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
        // A re-add that OBSERVED the delete carries a higher `version` than the
        // tombstone (apply_import bumps `max(observed) + 1`), so it wins and the
        // theme is live again (myne-md/myne#405).
        let tomb = theme(100, 100, "#old").into_tombstone(200); // version 2
        let readd = theme_v(3, 201, 201, "#new"); // observed the delete → version 3
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
            ("gruvbox", theme_v(3, 300, 300, "#d79921")), // re-add observed the delete → version 3 > 2
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

    /// A tombstone at an explicit `version` (palette scrubbed), for the property
    /// checks below.
    fn theme_tomb(version: u64, created_at: u64, updated_at: u64, deleted_at: u64) -> ThemeEntry {
        ThemeEntry {
            created_at,
            deleted_at: Some(deleted_at),
            palette: crate::plugins::themes::commands::ThemePalette::new(),
            updated_at,
            version,
        }
    }

    #[test]
    fn themes_entry_merge_is_associative_commutative_idempotent() {
        // EXHAUSTIVE property check over a representative entry-state space.
        // (proptest is deliberately NOT a myne-core dependency — adding one is a
        // security decision; an exhaustive enumeration is a stronger guarantee
        // for this finite space anyway.) `merge_theme_entry` is a join over the
        // total order (`version`, then the tie-break), so it MUST be commutative,
        // idempotent AND associative — the property that closes the three-device
        // CAS ping-pong (myne-md/myne#405).
        let mut states = Vec::new();
        for &version in &[0u64, 1, 2, 3] {
            for &ts in &[1u64, 2] {
                for accent in &["#aaaaaa", "#bbbbbb"] {
                    states.push(theme_v(version, ts, ts, accent)); // live
                    states.push(theme_tomb(version, ts, ts, ts + 5)); // tombstone
                }
            }
        }
        assert_join_laws(&states, merge_theme_entry);
    }

    #[test]
    fn themes_merge_l1_t_l2_counterexample_now_converges() {
        // The exact §10.2.2 counterexample, three CONCURRENT states at the SAME
        // version: L1{created:10,updated:10}, T{deleted:5}, L2{created:1,updated:100}.
        // Under the old created_at-vs-deleted_at guard, (L1∨T)∨L2 = L2 but
        // L1∨(T∨L2) = L1 → the fleet ping-ponged. The version-primary join's
        // tie-break is a total order, so both pairings now agree (and remove-wins
        // makes the tombstone the fixed point at equal version).
        let l1 = theme_v(1, 10, 10, "#l1");
        let t = theme_tomb(1, 100, 100, 5);
        let l2 = theme_v(1, 1, 100, "#l2");
        let left = merge_theme_entry(&merge_theme_entry(&l1, &t), &l2);
        let right = merge_theme_entry(&l1, &merge_theme_entry(&t, &l2));
        assert_eq!(left, right, "converges under any pairing (was L2 vs L1)");
        assert!(
            left.is_tombstone(),
            "remove-wins: the tombstone is the fixed point"
        );
    }

    // ---- AI conversations (myne-md/myne#675) ----

    /// A live row carrying anchors, which `conv_live` leaves `None`.
    ///
    /// **The two fields the tie-break gained must be varied** (review finding):
    /// the property test below builds its state space from `conv_live`/`conv_tomb`,
    /// which hard-code `folder: None, note_id: None`, so the new arms contribute a
    /// constant and a bug in them (a swapped field, a dropped one) is invisible to
    /// a test whose own doc calls the space representative.
    fn conv_anchored(
        version: u64,
        created_at: u64,
        updated_at: u64,
        title: &str,
        folder: Option<&str>,
        note_id: Option<&str>,
    ) -> ConversationEntry {
        ConversationEntry {
            folder: folder.map(str::to_string),
            note_id: note_id.map(str::to_string),
            ..conv_live(version, created_at, updated_at, title)
        }
    }

    fn conv_live(version: u64, created_at: u64, updated_at: u64, title: &str) -> ConversationEntry {
        ConversationEntry {
            created_at,
            deleted_at: None,
            folder: None,
            title: title.to_string(),
            updated_at,
            version,
            note_id: None,
        }
    }

    fn conv_tomb(
        version: u64,
        created_at: u64,
        updated_at: u64,
        deleted_at: u64,
    ) -> ConversationEntry {
        ConversationEntry {
            created_at,
            deleted_at: Some(deleted_at),
            folder: None,
            title: String::new(),
            updated_at,
            version,
            note_id: None,
        }
    }

    #[test]
    fn chats_catalog_entry_merge_is_associative_commutative_idempotent() {
        // EXHAUSTIVE property check over a representative row-state space (the
        // themes discipline; proptest is deliberately not a dependency). The
        // per-row join is `join_by_version` under the total order
        // (`version`, then `chats_entry_tie_break`), so it MUST be commutative,
        // idempotent AND associative.
        use crate::plugins::chats::commands::ConversationEntry;
        fn join(a: &ConversationEntry, b: &ConversationEntry) -> ConversationEntry {
            join_by_version(a, b, |e| e.version, chats_entry_tie_break)
        }
        let mut states: Vec<ConversationEntry> = Vec::new();
        for &version in &[0u64, 1, 2, 3] {
            for &ts in &[1u64, 2] {
                for title in &["alpha", "beta"] {
                    states.push(conv_live(version, ts, ts, title));
                    states.push(conv_tomb(version, ts, ts, ts + 5));
                    // **Rows differing ONLY in an anchor**, which is the shape
                    // the tie-break's `folder`/`note_id` arms decide. Kept to one
                    // (version, ts, title) corner so the cubic loop below stays
                    // cheap: the point is that the arms are EXERCISED, not that
                    // every corner carries them.
                    if version == 1 && ts == 1 && *title == "alpha" {
                        states.push(conv_anchored(version, ts, ts, title, Some("F"), None));
                        states.push(conv_anchored(version, ts, ts, title, None, Some("n1")));
                        states.push(conv_anchored(version, ts, ts, title, Some("F"), Some("n1")));
                    }
                }
            }
        }
        for a in &states {
            assert_eq!(join(a, a), *a, "idempotent: {a:?}");
            for b in &states {
                assert_eq!(join(a, b), join(b, a), "commutative: {a:?} ∨ {b:?}");
                for c in &states {
                    assert_eq!(
                        join(&join(a, b), c),
                        join(a, &join(b, c)),
                        "associative: {a:?} ∨ {b:?} ∨ {c:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn chats_catalog_remove_wins_on_concurrent_delete_vs_append() {
        // A conversation deleted on device B (tombstone, version bumped) while
        // device A appended (live, same version, truly concurrent): the
        // tombstone wins, the appended turns are discarded at merge. Recorded
        // as an accepted cost in decisions/ai/0575 (the confirm modal is the
        // user-facing guard).
        let appended = conv_live(2, 1, 100, "appended");
        let deleted = conv_tomb(2, 1, 1, 100);
        let merged = join_by_version(&appended, &deleted, |e| e.version, chats_entry_tie_break);
        assert!(merged.deleted_at.is_some(), "remove-wins");
    }

    #[test]
    fn chats_catalog_merge_key_union_and_higher_version_wins() {
        let mut local = ChatsCatalogMap::new();
        local.insert("a1".to_string(), conv_live(1, 1, 1, "only local"));
        local.insert("b2".to_string(), conv_live(2, 1, 1, "local newer"));
        let mut remote = ChatsCatalogMap::new();
        remote.insert("b2".to_string(), conv_live(1, 1, 2, "remote older"));
        remote.insert("c3".to_string(), conv_live(1, 1, 3, "only remote"));
        let merged = merge_chats_catalog(&local, &remote);
        assert_eq!(merged.len(), 3, "key union");
        assert_eq!(
            merged.get("b2").map(|e| e.version),
            Some(2),
            "higher causal version wins regardless of arg order"
        );
        assert_eq!(
            merge_chats_catalog(&remote, &local)
                .get("b2")
                .map(|e| e.version),
            Some(2),
            "commutative at the map level"
        );
    }

    #[test]
    fn chats_turns_common_prefix_kept_both_suffixes_ordered() {
        // Two devices diverge after the common prefix [a1, a2]: A appended
        // [a3, a4], B appended [b3]. The merge keeps all five turns with the
        // suffixes interleaved in id order.
        let local = vec![
            "a1".to_string(),
            "a2".to_string(),
            "a3".to_string(),
            "a4".to_string(),
        ];
        let remote = vec!["a1".to_string(), "a2".to_string(), "b3".to_string()];
        let merged = merge_chats_turns(&local, &remote);
        assert_eq!(
            merged,
            vec![
                "a1".to_string(),
                "a2".to_string(),
                "a3".to_string(),
                "a4".to_string(),
                "b3".to_string(),
            ],
            "prefix verbatim, then both suffixes in id order"
        );
    }

    #[test]
    fn chats_turns_merge_is_commutative_idempotent_associative_exhaustive() {
        // EXHAUSTIVE over a space of id sequences built from three clients'
        // interleavings (the themes discipline). The merge keeps the common
        // prefix and both suffixes in a deterministic total order, so it MUST
        // be commutative, idempotent and associative.
        fn seq(ids: &[&str]) -> Vec<String> {
            ids.iter().map(|s| s.to_string()).collect()
        }
        let mut states: Vec<Vec<String>> = Vec::new();
        let samples: &[&[&str]] = &[
            &[],
            &["a1"],
            &["a1", "a2"],
            &["a1", "a3"],
            &["b1"],
            &["a1", "b1"],
            &["b1", "b2"],
            &["a1", "a2", "b1"],
            &["a1", "b1", "b2"],
            &["a1", "a2", "a3"],
            &["c1", "c2"],
        ];
        for s in samples {
            states.push(seq(s));
        }
        for a in &states {
            assert_eq!(merge_chats_turns(a, a), *a, "idempotent: {a:?}");
            for b in &states {
                assert_eq!(
                    merge_chats_turns(a, b),
                    merge_chats_turns(b, a),
                    "commutative: {a:?} ∨ {b:?}"
                );
                for c in &states {
                    assert_eq!(
                        merge_chats_turns(&merge_chats_turns(a, b), c),
                        merge_chats_turns(a, &merge_chats_turns(b, c)),
                        "associative: {a:?} ∨ {b:?} ∨ {c:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn chats_turns_no_turn_is_ever_dropped() {
        // The no-data-loss property: every id present on EITHER side is
        // present in the merge (possibly once when both sides hold it).
        let local = vec!["a1".to_string(), "a2".to_string(), "a9".to_string()];
        let remote = vec!["a1".to_string(), "b1".to_string(), "b2".to_string()];
        let merged = merge_chats_turns(&local, &remote);
        for id in local.iter().chain(remote.iter()) {
            assert!(merged.contains(id), "turn {id} survived the merge");
        }
        // The shared id appears exactly once.
        assert_eq!(
            merged.iter().filter(|t| t.as_str() == "a1").count(),
            1,
            "a shared settled turn is one turn"
        );
    }

    #[test]
    fn chats_turns_three_devices_converge_byte_identically() {
        // The fleet shape the associative law buys: three devices hold three
        // pairwise-divergent suffixes; every pairing order converges to the
        // same list.
        let a = vec!["a1".to_string(), "a2".to_string(), "a3".to_string()];
        let b = vec![
            "a1".to_string(),
            "a2".to_string(),
            "b3".to_string(),
            "b4".to_string(),
        ];
        let c = vec!["a1".to_string(), "c3".to_string()];
        let left = merge_chats_turns(&merge_chats_turns(&a, &b), &c);
        let right = merge_chats_turns(&a, &merge_chats_turns(&b, &c));
        let mid = merge_chats_turns(&merge_chats_turns(&a, &c), &b);
        assert_eq!(left, right);
        assert_eq!(left, mid);
        assert_eq!(
            left,
            vec![
                "a1".to_string(),
                "a2".to_string(),
                "a3".to_string(),
                "b3".to_string(),
                "b4".to_string(),
                "c3".to_string(),
            ]
        );
    }

    #[test]
    fn themes_merge_absent_version_zero_loses_to_stamped() {
        // A legacy entry decodes with version 0 (absent field); the first stamped
        // (version >= 1) write outranks it — the absent=0 migration.
        let legacy = theme_v(0, 5, 5, "#legacy");
        let stamped = theme_v(1, 5, 5, "#stamped");
        assert_eq!(merge_theme_entry(&legacy, &stamped), stamped);
        assert_eq!(merge_theme_entry(&stamped, &legacy), stamped);
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
            membership: None,
            person_binding: None,
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
    fn vault_meta_merge_keeps_local_membership_regardless_of_winner() {
        // The membership field is device-local: the LOCAL value always survives,
        // even when the remote side wins the password-side. Grouping must never
        // converge across devices (`sync-protocol.md` §10.3).
        let mut local = meta(0xAA, 0x55);
        local.membership = Some(protocol::Membership {
            nonce: [0x11; protocol::AEAD_NONCE_LEN],
            enc: [0x22; protocol::MEMBERSHIP_CIPHERTEXT_LEN],
            roster: None,
        });
        let mut remote = meta(0xBB, 0x55);
        remote.membership = Some(protocol::Membership {
            nonce: [0x33; protocol::AEAD_NONCE_LEN],
            enc: [0x44; protocol::MEMBERSHIP_CIPHERTEXT_LEN],
            roster: None,
        });

        // Remote wins the password-side, but the membership stays local.
        let merged = merge_vault_meta(&local, &remote, MetaWinner::Remote).unwrap();
        assert_eq!(merged.nonce_password_wrap, [0xBB; VAULT_META_NONCE_LEN]);
        assert_eq!(merged.membership, local.membership);

        // Local wins: membership is local's anyway.
        let merged_local = merge_vault_meta(&local, &remote, MetaWinner::Local).unwrap();
        assert_eq!(merged_local.membership, local.membership);
    }

    #[test]
    fn merged_meta_with_membership_parses_under_both_generation_codecs() {
        // The merged blob must stay well-formed for both generations: the
        // membership field is NTV5-only, so a v0.2 merge re-serializes with the
        // field, and a v0.1 merge (no field) re-serializes as MYV1.
        let mut local = meta(0xAA, 0x55);
        local.membership = Some(protocol::Membership {
            nonce: [0x11; protocol::AEAD_NONCE_LEN],
            enc: [0x22; protocol::MEMBERSHIP_CIPHERTEXT_LEN],
            roster: None,
        });
        let mut remote = meta(0xBB, 0x55);
        remote.membership = Some(protocol::Membership {
            nonce: [0x33; protocol::AEAD_NONCE_LEN],
            enc: [0x44; protocol::MEMBERSHIP_CIPHERTEXT_LEN],
            roster: None,
        });

        let merged = merge_vault_meta(&local, &remote, MetaWinner::Remote).unwrap();
        // v0.2: the field is present, so the NTV5 serializer emits 417 bytes.
        let ntv5 = protocol::serialize_vault_meta_v0_2(&merged);
        assert_eq!(ntv5.len(), protocol::VAULT_META_V0_2_WITH_MEMBERSHIP_LEN);
        let reparsed = protocol::parse_vault_meta_v0_2(&ntv5).expect("NTV5 parse");
        assert_eq!(reparsed.membership, local.membership);

        // v0.1: no field, so the MYV1 serializer emits 345 bytes and the field
        // is dropped (a MYV1 vault groups via the record alone).
        let myv1 = protocol::serialize_vault_meta(&merged);
        assert_eq!(myv1.len(), protocol::VAULT_META_LEN);
        let reparsed_v0_1 = protocol::parse_vault_meta(&myv1).expect("MYV1 parse");
        assert!(reparsed_v0_1.membership.is_none());
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
/// — never logged. See the repo `src-tauri/AGENTS.md` "Secret-handling
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
        let decrypted =
            crate::plugins::notes::decode::decode_note_any(&blob, &id, &items_key, &items_key_id)
                .map_err(|_| SyncDeviceError::Internal)?;
        let body = String::from_utf8(decrypted.to_vec()).map_err(|_| SyncDeviceError::Internal)?;
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
    state: &VaultRuntimeState,
    file_name: &str,
) -> Result<(), SyncDeviceError> {
    use crate::plugins::vault_unlock::state::SlotKind;
    // Gated on `Slot::Unlocked` FIRST, before the name is parsed (myne#382).
    //
    // Its siblings refuse when locked only as a side effect of needing
    // `items_key`. A command that only deletes needs no key, so without this it
    // answered with nothing unlocked — and §11.3 calls the quarantined
    // ciphertext the *recoverable* ceiling on a lying server, which it stops
    // being the moment something outside a session can destroy it. The only
    // other gate was a TypeScript confirm modal, on the far side of the IPC
    // boundary.
    //
    // Before the parse, so a locked caller gets no BadRequest-vs-Internal
    // oracle over file names — the same "(1) precondition, (2) validate"
    // ordering `vault_delete` labels explicitly.
    if !matches!(state.slot_kind_active().await, SlotKind::Unlocked) {
        return Err(SyncDeviceError::Internal);
    }
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
/// never logged. See `src-tauri/AGENTS.md` "Secret-handling logging discipline".
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
        let decrypted =
            crate::plugins::notes::decode::decode_note_any(&blob, &id, &items_key, &items_key_id)
                .map_err(|_| SyncDeviceError::Internal)?;
        let body = String::from_utf8(decrypted.to_vec()).map_err(|_| SyncDeviceError::Internal)?;
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

// ---------------------------------------------------------------------------
// agent-memory catalog merge (myne-md/myne#697, sync-protocol.md §10.2.6)
// ---------------------------------------------------------------------------

use crate::plugins::memory::commands::{MemoryCatalogMap, MemoryEntryRow};

/// Merge two `vault.agent-memory` catalog maps: the per-id causal join with
/// remove-wins tombstone ties (the `merge_chats_catalog` discipline applied to
/// the memory roster, § 9.25 + `sync-protocol.md` § 10.2.6). Commutative,
/// idempotent and associative by construction.
pub fn merge_memory_catalog(
    local: &MemoryCatalogMap,
    remote: &MemoryCatalogMap,
) -> MemoryCatalogMap {
    let mut merged = MemoryCatalogMap::new();
    let ids = merge_set_union(
        &local.keys().cloned().collect::<Vec<_>>(),
        &remote.keys().cloned().collect::<Vec<_>>(),
    );
    for id in ids {
        let entry = match (local.get(&id), remote.get(&id)) {
            (Some(l), None) => l.clone(),
            (None, Some(r)) => r.clone(),
            (Some(l), Some(r)) => join_by_version(l, r, |e| e.version, memory_entry_tie_break),
            (None, None) => unreachable!("id came from the key union"),
        };
        merged.insert(id, entry);
    }
    merged
}

/// Total-order tie-break for two memory roster rows at an equal `version`
/// (a true concurrent mutation pair). **Remove-wins**: a tombstone outranks a
/// live row. Within a class it compares every retained field so the order is
/// total (`Equal` only when the rows are byte-identical): `quarantined` rides
/// both tuples, so a hold-vs-release pair at one version still orders
/// deterministically (myne-md/myne#709).
fn memory_entry_tie_break(a: &MemoryEntryRow, b: &MemoryEntryRow) -> Ordering {
    match (a.deleted_at.is_some(), b.deleted_at.is_some()) {
        (true, false) => Ordering::Greater, // remove-wins
        (false, true) => Ordering::Less,
        (true, true) => (a.deleted_at, a.created_at, a.updated_at, a.quarantined).cmp(&(
            b.deleted_at,
            b.created_at,
            b.updated_at,
            b.quarantined,
        )),
        (false, false) => (a.updated_at, a.version, a.created_at, a.quarantined).cmp(&(
            b.updated_at,
            b.version,
            b.created_at,
            b.quarantined,
        )),
    }
}
