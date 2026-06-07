//! In-RAM `VaultIndices` state (MYND-31 / A11, Task 1 — foundation).
//!
//! The structural twin of [`crate::search::SearchIndexState`]: a live,
//! plaintext-derived index that exists ONLY while a vault is
//! `Slot::Unlocked` and is **wiped on lock / auto-lock / delete**. It is
//! rebuilt on unlock (TS-orchestrated sweep → `vault_indices_apply` per
//! note) and updated incrementally by the note lifecycle.
//!
//! ## Build-B (MYND-31 design session, 2026-06-07)
//!
//! Dialect extraction (`[[wikilink]]` / `#tag` parsing) stays TS-side —
//! the single dialect source of truth (MYND-82 / `title_extract.rs`,
//! TB9 minimal-Rust-surface). Rust owns the index struct, the query
//! surface, and (a benchmark-gated follow-up) persistence. So this state
//! never parses markdown; it only stores what TS sends via `apply`.
//!
//! ## Foundation scope (Task 1)
//!
//! Holds the per-note `title` + `folder` map (`NoteRecord`). Wikilink
//! edges (Task 2) and the tag index (Task 4) extend this struct. The map
//! is keyed by note UUID; `title`/`folder` are plaintext-derived → as
//! sensitive as the open notes (AS3/AS4), so they are zeroized on the
//! lock path alongside the keys (see [`VaultIndicesState::clear`]).
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use zeroize::Zeroize;

/// One per-occurrence outbound wikilink edge (Task 2).
///
/// Title-keyed (Model-2): no resolved UUID is stored — resolution runs
/// TS-side (`resolveWikilink.ts`, plain-B) at query time. The raw target
/// fields are exactly what the TS resolver needs to reconstruct a
/// `WikilinkRef` and resolve it. Per-occurrence: a note linking another
/// three times yields three edges, each with its own `byte_start/end` for
/// navigation. `target`/`alias` are plaintext-derived → zeroized on clear.
///
/// Serde is camelCase both ways (TS sends camelCase on `apply`; TS reads
/// camelCase from `forward`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WikilinkEdge {
    /// Raw wikilink target (`"Foo"` for a title form, `"notes/foo.md"`
    /// for a path form). Fed to the TS resolver verbatim.
    pub target: String,
    /// `"title"` | `"vault-path"` — the resolver's `targetKind`.
    pub target_kind: String,
    /// Folded title-key of the target (`foldSegment(parsedTitle)`),
    /// computed TS-side (§3.7.8 fold — never Rust `to_lowercase`, which
    /// diverges in Turkish). The bucket key for the backlink-candidate
    /// lookup; matched against a note's own folded title-key.
    pub title_key: String,
    /// Heading anchor (`[[A#Heading]]`), if any — display metadata; the
    /// edge target is the note, not the heading (§5.1 collapse).
    pub anchor: Option<String>,
    /// Block id (`[[A^block]]`), preserved verbatim, ignored at resolution.
    pub block_id: Option<String>,
    /// Display alias (`[[A|Display]]`), if any.
    pub alias: Option<String>,
    /// `![[...]]` embed form (counts as a backlink; UI may distinguish).
    pub embed: bool,
    /// Source byte offset of the `[[...]]` occurrence (for navigation).
    pub byte_start: u32,
    /// End byte offset of the `[[...]]` occurrence.
    pub byte_end: u32,
}

impl WikilinkEdge {
    fn zeroize_in_place(&mut self) {
        // All plaintext-derived String fields are wiped. `target_kind` is a
        // non-secret structural literal ("title"/"vault-path") and the byte
        // offsets / `embed` flag are non-sensitive positional metadata.
        self.target.zeroize();
        self.title_key.zeroize();
        if let Some(a) = self.anchor.as_mut() {
            a.zeroize();
        }
        if let Some(b) = self.block_id.as_mut() {
            b.zeroize();
        }
        if let Some(a) = self.alias.as_mut() {
            a.zeroize();
        }
    }
}

/// A candidate backlink: one source note's edge that names a given
/// title-key. Returned by [`VaultIndicesState::backlink_candidates`]; the
/// TS `backlinks()` wrapper resolves each candidate via the single
/// resolver and keeps those that resolve to the queried note. Serde
/// camelCase → `{source, edge}`.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CandidateEdge {
    /// The source note's UUID (the note that contains the link).
    pub source: String,
    /// The outbound edge from `source` whose `title_key` matched.
    pub edge: WikilinkEdge,
}

/// One node of the tag tree (Task 4). Derived (N2) from the stored exact
/// folded tags by splitting on `/`. `key` is the folded path of this node
/// (`"area"`, `"area/project"`); `display` is a deterministic original-
/// casing representative; counts are de-duplicated by note.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TagTreeNode {
    /// Folded path of this node (the canonical key).
    pub key: String,
    /// Deterministic display representative (a function of the note-set,
    /// NOT of apply/reconcile order — Q6.2 pins determinism, defers the
    /// exact rule; this uses lexicographically-min original casing).
    pub display: String,
    /// Depth (number of `/`-separated segments), 1-based.
    pub depth: u32,
    /// Notes tagged with EXACTLY this path.
    pub direct_count: u32,
    /// Notes tagged with this path or any descendant (subtree-inclusive,
    /// the Obsidian parent-includes-descendants default).
    pub subtree_count: u32,
}

/// One of a note's tags (Task 4). N2: the **exact** folded tag is the
/// stored canonical key (`folded`), with the note's original casing kept
/// for display (`display`). Nested tags keep their `/` (e.g.
/// `folded = "area/project"`); the tree is derived by splitting on `/`.
/// Folding happens TS-side (§3.7.8) — Rust never folds (Turkish).
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct TagEntry {
    /// Folded canonical tag (`foldSegment` of the full nested tag).
    pub folded: String,
    /// Original-casing form as written in this note (for display).
    pub display: String,
}

impl TagEntry {
    fn zeroize_in_place(&mut self) {
        self.folded.zeroize();
        self.display.zeroize();
    }
}

/// Per-note record in the index.
///
/// Holds the note's `title` + `folder` (the inputs the TS resolver —
/// `resolveWikilink.ts`, §5.3 — needs as the resident note-set, and the
/// reverse `uuid → title-key` lookup the backlink candidate query uses in
/// Task 3), its per-occurrence outbound wikilink `edges` (Task 2), and its
/// `tags` (Task 4). All string content is plaintext-derived.
#[derive(Default, Clone)]
pub struct NoteRecord {
    /// The note's `title:` (frontmatter or first-H1 derived), if any.
    pub title: Option<String>,
    /// The note's virtual `folder:` (frontmatter), if any.
    pub folder: Option<String>,
    /// Per-occurrence outbound wikilink edges (Task 2).
    pub edges: Vec<WikilinkEdge>,
    /// The note's tags — inline `#tags` ∪ frontmatter `tags:`, deduped by
    /// `folded` TS-side before apply (Task 4).
    pub tags: Vec<TagEntry>,
}

impl NoteRecord {
    /// Zeroize the plaintext-derived string fields in place.
    fn zeroize_in_place(&mut self) {
        if let Some(t) = self.title.as_mut() {
            t.zeroize();
        }
        if let Some(f) = self.folder.as_mut() {
            f.zeroize();
        }
        for edge in self.edges.iter_mut() {
            edge.zeroize_in_place();
        }
        self.edges.clear();
        for tag in self.tags.iter_mut() {
            tag.zeroize_in_place();
        }
        self.tags.clear();
    }
}

/// The in-RAM index payload. Lives only while `Slot::Unlocked`.
#[derive(Default)]
struct VaultIndices {
    /// note UUID → its record. Replace-on-`apply` (an edit fully
    /// overwrites the note's prior record).
    notes: HashMap<String, NoteRecord>,
}

impl VaultIndices {
    /// Zeroize every record's plaintext-derived strings, then drop the map.
    fn zeroize_in_place(&mut self) {
        for record in self.notes.values_mut() {
            record.zeroize_in_place();
        }
        self.notes.clear();
    }
}

/// Tauri-managed handle to the live in-RAM `VaultIndices` (MYND-31 Task 1).
///
/// Registered via `app.manage(...)` in `lib.rs` setup so
/// `tauri::State<VaultIndicesState>` is borrowable from the
/// `vault_indices` plugin commands. The `std::sync::Mutex` is only ever
/// locked WITHOUT an `.await` held; a poisoned lock degrades to a no-op /
/// empty result rather than panicking — an index hiccup must never take
/// down a note write. Same posture as [`crate::search::SearchIndexState`].
#[derive(Default)]
pub struct VaultIndicesState {
    inner: Mutex<VaultIndices>,
}

impl VaultIndicesState {
    /// Index (or re-index) a note by id with its title + folder. Replace
    /// semantics — an existing record with the same id is fully
    /// overwritten, so an edit drops the note's stale title/folder.
    pub fn apply(&self, note_id: &str, record: NoteRecord) {
        if let Ok(mut idx) = self.inner.lock() {
            // Overwrite zeroizes the prior record's strings via Drop only
            // if it were Zeroizing; HashMap::insert drops the old value
            // without zeroize, so wipe it explicitly first.
            if let Some(prior) = idx.notes.get_mut(note_id) {
                prior.zeroize_in_place();
            }
            idx.notes.insert(note_id.to_string(), record);
        }
    }

    /// Drop a note from the index by id (no-op if absent), zeroizing its
    /// plaintext-derived strings.
    pub fn remove(&self, note_id: &str) {
        if let Ok(mut idx) = self.inner.lock() {
            if let Some(mut record) = idx.notes.remove(note_id) {
                record.zeroize_in_place();
            }
        }
    }

    /// Zeroize + reset the whole index — the lock path uses this to wipe
    /// the plaintext-derived index alongside the keys (manual `vault_lock`,
    /// idle auto-lock teardown, `vault_delete`). No-op on a poisoned lock.
    pub fn clear(&self) {
        if let Ok(mut idx) = self.inner.lock() {
            idx.zeroize_in_place();
        }
    }

    /// Number of notes currently indexed. Used by the rebuild-on-unlock
    /// verification + tests. `0` on a poisoned lock.
    #[allow(dead_code)] // first non-test reader lands with the benchmark (Task 7) / a stats query
    pub fn note_count(&self) -> usize {
        self.inner.lock().map(|idx| idx.notes.len()).unwrap_or(0)
    }

    /// Clone a note's record out (title + folder + edges + tags). `None`
    /// if absent / poisoned lock. Test-exercised today; a production
    /// reader lands with a future stats / inspection query.
    #[allow(dead_code)] // exercised by tests; first non-test reader is a future stats query
    pub fn note_record(&self, note_id: &str) -> Option<NoteRecord> {
        self.inner
            .lock()
            .ok()
            .and_then(|idx| idx.notes.get(note_id).cloned())
    }

    /// Clone a note's raw outbound wikilink edges out (Task 2). Empty when
    /// the note is absent / has no links / on a poisoned lock. The TS
    /// `forward()` wrapper resolves these via the single resolver.
    pub fn forward(&self, note_id: &str) -> Vec<WikilinkEdge> {
        self.inner
            .lock()
            .ok()
            .and_then(|idx| idx.notes.get(note_id).map(|r| r.edges.clone()))
            .unwrap_or_default()
    }

    /// All candidate backlink edges naming `title_key` — every source
    /// note's edge whose folded target title-key equals `title_key`
    /// (Task 3). The TS `backlinks()` wrapper resolves each candidate via
    /// the single resolver and keeps those resolving to the queried note,
    /// then groups by source.
    ///
    /// Implemented as a scan over all notes' edges (Phase-1-scale
    /// appropriate, MVP-first per the design's "ship simplest correct,
    /// optimize when measured" discipline). A `title-key → [edges]` aux
    /// index is the obvious optimization if a benchmark ever shows this
    /// scan hot; deferred for now. Empty on a poisoned lock.
    pub fn backlink_candidates(&self, title_key: &str) -> Vec<CandidateEdge> {
        let Ok(idx) = self.inner.lock() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for (source, record) in idx.notes.iter() {
            for edge in &record.edges {
                if edge.title_key == title_key {
                    out.push(CandidateEdge {
                        source: source.clone(),
                        edge: edge.clone(),
                    });
                }
            }
        }
        out
    }

    /// Note ids tagged with `folded_tag` or any descendant tag (Task 4) —
    /// subtree-inclusive (`by_tag("area")` includes `#area/project`). The
    /// query key is folded TS-side before the call. Sorted for determinism.
    /// Empty on a poisoned lock.
    pub fn by_tag(&self, folded_tag: &str) -> Vec<String> {
        let Ok(idx) = self.inner.lock() else {
            return Vec::new();
        };
        let prefix = format!("{folded_tag}/");
        let mut out: Vec<String> = idx
            .notes
            .iter()
            .filter(|(_, record)| {
                record
                    .tags
                    .iter()
                    .any(|t| t.folded == folded_tag || t.folded.starts_with(&prefix))
            })
            .map(|(note_id, _)| note_id.clone())
            .collect();
        out.sort();
        out
    }

    /// The full tag tree (Task 4), derived (N2) from the stored exact
    /// folded tags. Each node carries direct + subtree counts (deduped by
    /// note) and a deterministic display. Sorted by folded key. Empty on a
    /// poisoned lock.
    pub fn tag_tree(&self) -> Vec<TagTreeNode> {
        use std::collections::{BTreeMap, BTreeSet};
        let Ok(idx) = self.inner.lock() else {
            return Vec::new();
        };
        struct Acc {
            direct: BTreeSet<String>,
            subtree: BTreeSet<String>,
            displays: BTreeSet<String>,
        }
        let mut acc: BTreeMap<String, Acc> = BTreeMap::new();
        for (note_id, record) in idx.notes.iter() {
            for tag in &record.tags {
                let fsegs: Vec<&str> = tag.folded.split('/').filter(|s| !s.is_empty()).collect();
                let dsegs: Vec<&str> = tag.display.split('/').collect();
                for k in 1..=fsegs.len() {
                    let key = fsegs[..k].join("/");
                    let entry = acc.entry(key).or_insert_with(|| Acc {
                        direct: BTreeSet::new(),
                        subtree: BTreeSet::new(),
                        displays: BTreeSet::new(),
                    });
                    entry.subtree.insert(note_id.clone());
                    if k == fsegs.len() {
                        entry.direct.insert(note_id.clone());
                    }
                    if let Some(seg) = dsegs.get(k - 1) {
                        entry.displays.insert((*seg).to_string());
                    }
                }
            }
        }
        acc.into_iter()
            .map(|(key, a)| {
                let depth = key.split('/').filter(|s| !s.is_empty()).count() as u32;
                let display = a
                    .displays
                    .into_iter()
                    .next()
                    .unwrap_or_else(|| key.rsplit('/').next().unwrap_or(&key).to_string());
                TagTreeNode {
                    key,
                    display,
                    depth,
                    direct_count: a.direct.len() as u32,
                    subtree_count: a.subtree.len() as u32,
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(title: &str, folder: Option<&str>) -> NoteRecord {
        NoteRecord {
            title: Some(title.to_string()),
            folder: folder.map(|f| f.to_string()),
            ..Default::default()
        }
    }

    fn edge(target: &str, embed: bool) -> WikilinkEdge {
        WikilinkEdge {
            target: target.to_string(),
            target_kind: "title".to_string(),
            // Tests stand in for the TS fold with a plain ASCII lowercase.
            title_key: target.to_lowercase(),
            embed,
            ..Default::default()
        }
    }

    #[test]
    fn apply_then_note_count_reflects_insert() {
        let state = VaultIndicesState::default();
        assert_eq!(state.note_count(), 0);
        state.apply("a", rec("Alpha", Some("Projects/")));
        state.apply("b", rec("Beta", None));
        assert_eq!(state.note_count(), 2);
    }

    #[test]
    fn apply_is_replace_not_duplicate() {
        let state = VaultIndicesState::default();
        state.apply("a", rec("Alpha", None));
        state.apply("a", rec("Alpha Renamed", Some("X/")));
        assert_eq!(state.note_count(), 1);
        let r = state.note_record("a").expect("present");
        assert_eq!(r.title.as_deref(), Some("Alpha Renamed"));
        assert_eq!(r.folder.as_deref(), Some("X/"));
    }

    #[test]
    fn remove_drops_the_note() {
        let state = VaultIndicesState::default();
        state.apply("a", rec("Alpha", None));
        state.apply("b", rec("Beta", None));
        state.remove("a");
        assert_eq!(state.note_count(), 1);
        assert!(state.note_record("a").is_none());
        assert!(state.note_record("b").is_some());
    }

    #[test]
    fn remove_absent_is_noop() {
        let state = VaultIndicesState::default();
        state.apply("a", rec("Alpha", None));
        state.remove("does-not-exist");
        assert_eq!(state.note_count(), 1);
    }

    #[test]
    fn forward_returns_the_notes_edges_in_order() {
        let state = VaultIndicesState::default();
        let mut r = rec("Alpha", None);
        r.edges = vec![edge("Beta", false), edge("Gamma", true)];
        state.apply("a", r);
        let edges = state.forward("a");
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[0].target, "Beta");
        assert!(!edges[0].embed);
        assert_eq!(edges[1].target, "Gamma");
        assert!(edges[1].embed);
    }

    #[test]
    fn forward_is_empty_for_absent_or_linkless_note() {
        let state = VaultIndicesState::default();
        state.apply("a", rec("Alpha", None)); // no edges
        assert!(state.forward("a").is_empty());
        assert!(state.forward("missing").is_empty());
    }

    #[test]
    fn backlink_candidates_collects_edges_naming_the_key() {
        let state = VaultIndicesState::default();
        let mut a = rec("Source A", None);
        a.edges = vec![edge("Target", false)];
        let mut b = rec("Source B", None);
        b.edges = vec![edge("Target", true), edge("Other", false)];
        state.apply("a", a);
        state.apply("b", b);

        let cands = state.backlink_candidates("target"); // folded key
        assert_eq!(cands.len(), 2, "both a and b link to Target");
        let sources: std::collections::HashSet<&str> =
            cands.iter().map(|c| c.source.as_str()).collect();
        assert!(sources.contains("a"));
        assert!(sources.contains("b"));
        assert!(state.backlink_candidates("nope").is_empty());
    }

    #[test]
    fn backlink_candidates_drop_when_source_note_re_applied_without_link() {
        let state = VaultIndicesState::default();
        let mut a = rec("Source A", None);
        a.edges = vec![edge("Target", false)];
        state.apply("a", a);
        assert_eq!(state.backlink_candidates("target").len(), 1);
        // Re-apply A with no edges (link removed) → candidate gone (replace).
        state.apply("a", rec("Source A", None));
        assert!(state.backlink_candidates("target").is_empty());
    }

    fn tag(folded: &str, display: &str) -> TagEntry {
        TagEntry {
            folded: folded.to_string(),
            display: display.to_string(),
        }
    }

    #[test]
    fn by_tag_is_subtree_inclusive() {
        let state = VaultIndicesState::default();
        let mut a = rec("A", None);
        a.tags = vec![tag("area", "Area")];
        let mut b = rec("B", None);
        b.tags = vec![tag("area/project", "Area/Project")];
        let mut c = rec("C", None);
        c.tags = vec![tag("other", "other")];
        state.apply("a", a);
        state.apply("b", b);
        state.apply("c", c);

        assert_eq!(
            state.by_tag("area"),
            vec!["a".to_string(), "b".to_string()],
            "parent includes descendant"
        );
        assert_eq!(state.by_tag("area/project"), vec!["b".to_string()]);
        assert!(state.by_tag("missing").is_empty());
    }

    #[test]
    fn tag_tree_has_direct_and_subtree_counts() {
        let state = VaultIndicesState::default();
        let mut a = rec("A", None);
        a.tags = vec![tag("area", "Area")];
        let mut b = rec("B", None);
        b.tags = vec![tag("area/project", "Area/Project")];
        state.apply("a", a);
        state.apply("b", b);

        let tree = state.tag_tree();
        let area = tree.iter().find(|n| n.key == "area").expect("area node");
        assert_eq!(area.direct_count, 1, "only A is tagged exactly #area");
        assert_eq!(area.subtree_count, 2, "A direct + B via descendant");
        assert_eq!(area.depth, 1);
        let proj = tree
            .iter()
            .find(|n| n.key == "area/project")
            .expect("project node");
        assert_eq!(proj.direct_count, 1);
        assert_eq!(proj.depth, 2);
    }

    #[test]
    fn tag_tree_display_is_deterministic() {
        let state = VaultIndicesState::default();
        let mut a = rec("A", None);
        a.tags = vec![tag("kitap", "Kitap")];
        let mut b = rec("B", None);
        b.tags = vec![tag("kitap", "kitap")];
        state.apply("a", a);
        state.apply("b", b);

        let tree = state.tag_tree();
        let node = tree.iter().find(|n| n.key == "kitap").expect("kitap node");
        // lexicographically-min of {"Kitap","kitap"} → "Kitap" (ASCII upper < lower).
        assert_eq!(node.display, "Kitap");
        assert_eq!(node.subtree_count, 2);
    }

    #[test]
    fn clear_wipes_the_whole_index() {
        let state = VaultIndicesState::default();
        state.apply("a", rec("Alpha", None));
        state.apply("b", rec("Beta", None));
        state.clear();
        assert_eq!(state.note_count(), 0);
        assert!(state.note_record("a").is_none());
    }
}
