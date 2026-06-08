//! Attachment reference-graph reconcile (MYND-169, SYNC-6) — in-RAM,
//! rebuildable, zeroized-on-lock.
//!
//! ## What this is
//!
//! A derived map `attachment-id → {referencing note-ids}` reconstructed
//! from note bodies (NOT an on-disk edge list). The library renders
//! "used in N notes" + a clickable referencing-notes list, and the
//! delete-warning names the exact notes (SYNC-6 amended — exposes
//! **ids**, not just a count). UX-only correctness: "approximately
//! right, recomputed on demand"; a full rebuild from the notes is always
//! available as the fallback.
//!
//! References are form-C embeds `![[att:<id>|filename]]` in note
//! markdown (`wikilink.md` §78). The shared [`extract_att_ids`]
//! tokenizer pulls the `att:<id>` targets from a note body; it is the
//! single tokenizer the editor resolver (sub-feature 4) and this
//! reconcile pass share (SYNC-6).
//!
//! ## Structural twin of `vault_indices` / `search`
//!
//! This is the same shape as [`crate::plugins::vault_indices::state`]:
//! a plaintext-derived in-RAM index that lives only while
//! `Slot::Unlocked` and is wiped on lock / auto-lock / delete. The
//! note-ids it holds are per-note correlation tags (DENY-listed for
//! logging, AS3 Sensitive), so [`AttachmentRefsState::clear`] is wired
//! into every slot-drop site alongside the other index wipes.
//!
//! ## Scope of THIS task (SYNC-6, "do LAST, scope-bounded")
//!
//! Implemented here, fully and tested:
//! - the shared `att:<id>` tokenizer ([`extract_att_ids`]);
//! - the in-RAM bidirectional graph ([`AttachmentRefsState`]) with the
//!   per-note replace-on-apply semantics that mirror `vault_indices`;
//! - the "used in N notes" + referencing-note-ids query
//!   ([`AttachmentRefsState::referencing_notes`]);
//! - the zeroize-on-lock wipe.
//!
//! TODO(attachments reconcile): the *wiring* that drives `apply` from the
//! live note lifecycle + the unlock-time full rebuild is NOT wired here.
//! Per the `vault_indices` Build-B design (TS owns dialect extraction and
//! pushes parsed records to the host via an `apply` IPC command), the
//! intended production path is:
//!   (a) extend the TS note-parse pass to also emit `att:<id>` targets
//!   alongside wikilinks/tags; (b) add a thin
//!   `attachment_refs_apply(note_id, ids)` /
//!   `attachment_refs_remove(note_id)` IPC pair plus an
//!   `attachment_refs_referencing(id)` query command that delegate to
//!   this state; (c) drive a rebuild-on-unlock from the TS-orchestrated
//!   note sweep (the same sweep that rebuilds `vault_indices`).
//!
//! Those steps are frontend-coupled (the dialect parser is the single TS
//! source of truth, TB9 minimal-Rust-surface) and are deferred to the
//! consumer sub-features (3 library / 4 editor) that actually need the
//! query surface. The host-side primitive (tokenizer + graph + query +
//! wipe) is complete and unit-tested so those sub-features wire to a
//! finished core rather than a stub.

// The tokenizer + the graph's apply/remove/query surface have NO
// production caller yet — task 6 (SYNC-6) is scaffolded here, but the
// IPC wiring (an `attachment_refs_apply/remove/referencing` command set
// driven by the TS note-parse pass + an unlock-time rebuild) is deferred
// to the consumer sub-features per the module-level
// `TODO(attachments reconcile)`. The host-side primitive is complete and
// unit-tested so those sub-features wire to a finished core. Until then,
// the public items are dead-code-allowed (same posture as
// `vault_indices`'s not-yet-read query helpers). `AttachmentRefsState`
// itself IS live (managed in `lib.rs` + cleared on every lock path).
#![allow(dead_code)]

use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;
use zeroize::Zeroize;

/// The form-C embed target prefix: `![[att:<id>|filename]]` →
/// `att:<id>`. The tokenizer keys off this exact prefix.
const ATT_PREFIX: &str = "att:";

/// Extract the set of attachment-ids referenced by `note_body` via the
/// form-C embed `![[att:<id>|...]]` (`wikilink.md` §78). Returns the
/// lowercase-hex id strings (deduplicated, order-independent).
///
/// The shared tokenizer (SYNC-6): the editor resolver (sub-feature 4)
/// and this reconcile pass use this one function so the embed grammar
/// has a single host-side parser. It recognizes the embed form `![[`
/// `att:` `<id>` (`|alias`)? `]]`, tolerating an optional `|filename`
/// alias and surrounding whitespace inside the brackets. An id is the
/// run of `[0-9a-f]` immediately after `att:`; a malformed / non-hex run
/// is skipped (it is not a valid attachment reference).
///
/// NOTE: this is a deliberately small, allocation-light scanner — NOT a
/// full markdown parser. Code-fence / inline-code exclusion (a `![[...]]`
/// inside a fenced block is not a live embed) is the dialect parser's job
/// TS-side; this host tokenizer is the lower bound used by the reconcile
/// pass, and over-counting a fenced example is acceptable under the
/// "approximately right" UX-correctness posture (SYNC-6).
pub fn extract_att_ids(note_body: &str) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    let bytes = note_body.as_bytes();
    let mut i = 0;
    // Scan for the embed opener `![[`.
    while let Some(rel) = find_subslice(&bytes[i..], b"![[") {
        let start = i + rel + 3; // just past "![["
                                 // Find the closing "]]".
        let Some(close_rel) = find_subslice(&bytes[start..], b"]]") else {
            break;
        };
        let inner = &note_body[start..start + close_rel];
        if let Some(id) = parse_att_target(inner) {
            ids.insert(id);
        }
        i = start + close_rel + 2;
    }
    ids
}

/// Parse the inside of an `![[ ... ]]` embed into an attachment-id, if it
/// is an `att:` target. `inner` is the text between `![[` and `]]`
/// (e.g. `att:deadbeef|photo.png`). Returns the lowercase-hex id when the
/// trimmed inner starts with `att:` and the following run is non-empty
/// lowercase hex; else `None`.
fn parse_att_target(inner: &str) -> Option<String> {
    let trimmed = inner.trim_start();
    let rest = trimmed.strip_prefix(ATT_PREFIX)?;
    // The id is the run up to the first `|` (alias separator) or `]`/
    // whitespace; take the leading hex run.
    let id_run: String = rest.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
    if id_run.is_empty() {
        return None;
    }
    // Canonical attachment-ids are lowercase hex; reject any uppercase so
    // the id matches the catalog key exactly.
    if id_run.chars().any(|c| c.is_ascii_uppercase()) {
        return None;
    }
    Some(id_run)
}

/// Return the byte offset of the first occurrence of `needle` in
/// `haystack`, or `None`.
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// In-RAM bidirectional attachment reference graph. Lives only while
/// `Slot::Unlocked`; wiped on lock. The forward map (`note → ids`) makes
/// per-note replace-on-apply cheap; the reverse query
/// ([`Self::referencing_notes`]) scans it (Phase-1-scale appropriate,
/// like `vault_indices::backlink_candidates`).
#[derive(Default)]
struct AttachmentRefs {
    /// note-id → the set of attachment-ids that note references.
    by_note: HashMap<String, BTreeSet<String>>,
}

impl AttachmentRefs {
    fn zeroize_in_place(&mut self) {
        // note-ids + attachment-ids are plaintext-derived correlation
        // tags (AS3) — overwrite the key/value strings before dropping.
        let mut notes: Vec<String> = self.by_note.keys().cloned().collect();
        for (_note, ids) in self.by_note.iter_mut() {
            let mut id_vec: Vec<String> = ids.iter().cloned().collect();
            for s in id_vec.iter_mut() {
                s.zeroize();
            }
            ids.clear();
        }
        for s in notes.iter_mut() {
            s.zeroize();
        }
        self.by_note.clear();
    }
}

/// Tauri-managed handle to the live in-RAM attachment reference graph
/// (MYND-169, SYNC-6). Registered via `app.manage(...)` in `lib.rs`
/// setup (like `SearchIndexState` / `VaultIndicesState`) so the lock
/// paths can borrow it to clear on lock. The `std::sync::Mutex` is only
/// ever locked WITHOUT an `.await` held; a poisoned lock degrades to a
/// no-op / empty result rather than panicking.
#[derive(Default)]
pub struct AttachmentRefsState {
    inner: Mutex<AttachmentRefs>,
}

impl AttachmentRefsState {
    /// Set (replace) the attachment-ids a note references. Replace
    /// semantics — re-applying a note fully overwrites its prior id set,
    /// so an edit that removes an embed drops the stale reference. The
    /// `ids` are typically [`extract_att_ids`] of the note body.
    pub fn apply<I: IntoIterator<Item = String>>(&self, note_id: &str, ids: I) {
        let set: BTreeSet<String> = ids.into_iter().collect();
        if let Ok(mut g) = self.inner.lock() {
            if set.is_empty() {
                // A note with no references holds no entry (keeps the map
                // sparse; absence ≡ no references).
                g.by_note.remove(note_id);
            } else {
                g.by_note.insert(note_id.to_string(), set);
            }
        }
    }

    /// Drop a note from the graph (e.g. on note delete). No-op if absent.
    pub fn remove(&self, note_id: &str) {
        if let Ok(mut g) = self.inner.lock() {
            g.by_note.remove(note_id);
        }
    }

    /// The note-ids that reference `attachment_id`, sorted for
    /// determinism. The library renders this as the "used in N notes"
    /// count (`.len()`) plus the clickable list; the delete-warning names
    /// them. Empty when unreferenced / on a poisoned lock.
    pub fn referencing_notes(&self, attachment_id: &str) -> Vec<String> {
        let Ok(g) = self.inner.lock() else {
            return Vec::new();
        };
        let mut out: Vec<String> = g
            .by_note
            .iter()
            .filter(|(_, ids)| ids.contains(attachment_id))
            .map(|(note, _)| note.clone())
            .collect();
        out.sort();
        out
    }

    /// Zeroize + reset the whole graph — the lock path uses this to wipe
    /// the plaintext-derived reference graph alongside the keys (manual
    /// `vault_lock`, idle auto-lock teardown, `vault_delete`). No-op on a
    /// poisoned lock. Twin of `vault_indices::clear` /
    /// `search_sync::zeroize_search_index`.
    pub fn clear(&self) {
        if let Ok(mut g) = self.inner.lock() {
            g.zeroize_in_place();
        }
    }

    /// Number of notes currently holding at least one reference. Used by
    /// the rebuild verification + tests.
    #[allow(dead_code)] // first non-test reader lands with the query command wiring (TODO above)
    pub fn note_count(&self) -> usize {
        self.inner.lock().map(|g| g.by_note.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- tokenizer -----------------------------------------------------

    #[test]
    fn extracts_single_embed() {
        let body = "see ![[att:deadbeef|photo.png]] here";
        let ids = extract_att_ids(body);
        assert_eq!(ids.into_iter().collect::<Vec<_>>(), vec!["deadbeef"]);
    }

    #[test]
    fn extracts_embed_without_alias() {
        let ids = extract_att_ids("![[att:abc123]]");
        assert_eq!(ids.into_iter().collect::<Vec<_>>(), vec!["abc123"]);
    }

    #[test]
    fn extracts_multiple_distinct_embeds() {
        let body = "![[att:aaaa|a.png]] and ![[att:bbbb|b.pdf]]";
        let ids = extract_att_ids(body);
        assert_eq!(
            ids.into_iter().collect::<Vec<_>>(),
            vec!["aaaa".to_string(), "bbbb".to_string()]
        );
    }

    #[test]
    fn dedups_repeated_embed() {
        let body = "![[att:cafe|1.png]] ... ![[att:cafe|2.png]]";
        let ids = extract_att_ids(body);
        assert_eq!(ids.len(), 1);
        assert!(ids.contains("cafe"));
    }

    #[test]
    fn tolerates_inner_whitespace() {
        let ids = extract_att_ids("![[  att:beef|x]]");
        assert_eq!(ids.into_iter().collect::<Vec<_>>(), vec!["beef"]);
    }

    #[test]
    fn ignores_non_att_wikilinks() {
        // A plain wikilink / embed that is not an `att:` target.
        let body = "![[Some Note|alias]] and [[Another]]";
        assert!(extract_att_ids(body).is_empty());
    }

    #[test]
    fn ignores_uppercase_hex_id() {
        // Canonical ids are lowercase; an uppercase run does not match a
        // catalog key, so it is not a valid reference.
        assert!(extract_att_ids("![[att:DEADBEEF]]").is_empty());
    }

    #[test]
    fn ignores_unclosed_embed() {
        assert!(extract_att_ids("![[att:abcd").is_empty());
    }

    #[test]
    fn empty_body_yields_no_ids() {
        assert!(extract_att_ids("").is_empty());
    }

    #[test]
    fn stops_id_at_alias_separator() {
        // The id is only the hex run before `|`.
        let ids = extract_att_ids("![[att:1234|not-part-of-id.png]]");
        assert_eq!(ids.into_iter().collect::<Vec<_>>(), vec!["1234"]);
    }

    // ---- graph ---------------------------------------------------------

    #[test]
    fn apply_then_referencing_notes() {
        let state = AttachmentRefsState::default();
        state.apply("note-1", ["att-a".to_string(), "att-b".to_string()]);
        state.apply("note-2", ["att-a".to_string()]);

        let mut refs = state.referencing_notes("att-a");
        refs.sort();
        assert_eq!(refs, vec!["note-1".to_string(), "note-2".to_string()]);
        assert_eq!(state.referencing_notes("att-b"), vec!["note-1".to_string()]);
        assert!(state.referencing_notes("att-unreferenced").is_empty());
    }

    #[test]
    fn apply_is_replace_dropping_stale_refs() {
        let state = AttachmentRefsState::default();
        state.apply("note-1", ["att-a".to_string()]);
        assert_eq!(state.referencing_notes("att-a"), vec!["note-1".to_string()]);
        // Re-apply note-1 referencing a DIFFERENT attachment → att-a ref
        // dropped (the edit removed the old embed).
        state.apply("note-1", ["att-b".to_string()]);
        assert!(state.referencing_notes("att-a").is_empty());
        assert_eq!(state.referencing_notes("att-b"), vec!["note-1".to_string()]);
    }

    #[test]
    fn apply_empty_removes_the_note() {
        let state = AttachmentRefsState::default();
        state.apply("note-1", ["att-a".to_string()]);
        assert_eq!(state.note_count(), 1);
        // Re-apply with no references → note drops out of the map.
        state.apply("note-1", std::iter::empty());
        assert_eq!(state.note_count(), 0);
        assert!(state.referencing_notes("att-a").is_empty());
    }

    #[test]
    fn remove_drops_the_note() {
        let state = AttachmentRefsState::default();
        state.apply("note-1", ["att-a".to_string()]);
        state.apply("note-2", ["att-a".to_string()]);
        state.remove("note-1");
        assert_eq!(state.referencing_notes("att-a"), vec!["note-2".to_string()]);
    }

    #[test]
    fn clear_wipes_everything() {
        let state = AttachmentRefsState::default();
        state.apply("note-1", ["att-a".to_string()]);
        state.apply("note-2", ["att-b".to_string()]);
        state.clear();
        assert_eq!(state.note_count(), 0);
        assert!(state.referencing_notes("att-a").is_empty());
    }

    #[test]
    fn end_to_end_tokenize_then_index() {
        // The intended production flow (once wired): tokenize a note body,
        // apply, query.
        let state = AttachmentRefsState::default();
        let body = "intro ![[att:f00d|cover.png]] then ![[att:beef|doc.pdf]]";
        let ids = extract_att_ids(body);
        state.apply("note-x", ids);
        assert_eq!(state.referencing_notes("f00d"), vec!["note-x".to_string()]);
        assert_eq!(state.referencing_notes("beef"), vec!["note-x".to_string()]);
    }
}
