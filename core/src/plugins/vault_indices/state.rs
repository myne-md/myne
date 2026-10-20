// SPDX-License-Identifier: AGPL-3.0
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
//! See: ../../AGENTS.md "Secret-handling logging discipline".

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

/// A coerced scalar property value (Task 7 / MYND-271) — the type tag + the
/// canonical normalized string, both produced TS-side per `markdown-dialect.md`
/// §3.6.4. The element shape of a `list` property. Rust stores these opaquely;
/// it never parses YAML nor interprets the type (Build-B, TB9). serde camelCase.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PropertyScalar {
    /// `"string"` | `"number"` | `"date"` | `"checkbox"` — a closed TS-side
    /// type tag (a structural literal, NOT plaintext, so not zeroized).
    pub r#type: String,
    /// The canonical normalized value (plaintext-derived → zeroized on clear).
    pub value: String,
}

impl PropertyScalar {
    fn zeroize_in_place(&mut self) {
        self.value.zeroize();
    }
}

/// One typed frontmatter property (Task 7 / MYND-271): an arbitrary `key` plus
/// either a scalar (`value` set, `elements` `None`) or a `list` (`elements`
/// set, `value` `None`). The opaque pre-typed shape TS sends on `apply`; Rust
/// stores + returns it verbatim, with **no evaluatable-expression hook ever**
/// (storage/accessor only — mirrors the closed-registry discipline of
/// `protocol::template`). All string content is plaintext-derived. serde
/// camelCase, mirroring the TS `PropertyEntry`.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PropertyEntry {
    /// The arbitrary frontmatter key (plaintext-derived → zeroized on clear).
    pub key: String,
    /// `"string"` | `"number"` | `"date"` | `"checkbox"` | `"list"`.
    pub r#type: String,
    /// The normalized scalar value — present for a scalar property, `None` for
    /// a `list`. `#[serde(default)]` (NOT `skip_serializing_if`): TS sends only
    /// the variant's field, so the absent one must default to `None` on
    /// deserialize; `skip_serializing_if` is deliberately omitted because the
    /// MYI1 snapshot serializes through **postcard** (a non-self-describing
    /// positional format — a conditionally-skipped field would shift every
    /// later field on decode). The cosmetic cost is a `value: null` in the
    /// JSON for a list entry (and vice-versa), which the TS consumer tolerates.
    #[serde(default)]
    pub value: Option<String>,
    /// The per-element coerced scalars — present for a `list`, `None` for a
    /// scalar. `#[serde(default)]` only (see `value` for the no-`skip` postcard
    /// rationale).
    #[serde(default)]
    pub elements: Option<Vec<PropertyScalar>>,
}

impl PropertyEntry {
    fn zeroize_in_place(&mut self) {
        // The key is a frontmatter key NAME — plaintext-derived (AS3/AS4).
        self.key.zeroize();
        if let Some(v) = self.value.as_mut() {
            v.zeroize();
        }
        if let Some(els) = self.elements.as_mut() {
            for e in els.iter_mut() {
                e.zeroize_in_place();
            }
            els.clear();
        }
    }
}

/// One imported `^block-id` anchor (MYND-382), surfaced for the `[[^^` picker.
/// **Enumerate-only**: Myne never MINTS block ids — this indexes markers that
/// ALREADY exist (e.g. imported from Obsidian). TS extracts them
/// (`extractBlockAnchors`, the single dialect source, Build-B); Rust stores +
/// serves them for the vault-wide picker. serde camelCase (TS sends camelCase).
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlockAnchor {
    /// The block id, verbatim, WITHOUT the leading `^` (matches the `[[A^id]]`
    /// deep-link form). Plaintext-derived.
    pub block_id: String,
    /// A short preview of the tagged block's text — the picker's secondary line
    /// — computed TS-side (the block's first line, truncated). Plaintext-derived.
    pub preview: String,
}

impl BlockAnchor {
    fn zeroize_in_place(&mut self) {
        self.block_id.zeroize();
        self.preview.zeroize();
    }
}

/// One line-task extracted from a note body (MYND-612).
///
/// **Every metadata field is an OPAQUE verbatim source substring.** Rust stores
/// them and returns them; it performs no date parsing, no comparison, and no
/// arithmetic on any of them. The dialect layer owns the typing (§3.8.3), TS
/// extracts (the single dialect source, exactly as `BlockAnchor` does), and a
/// second Rust-side interpretation would be a second type authority — the drift
/// `markdown-dialect.md` §3.6.4 exists to prevent. A field that does not parse
/// TS-side arrives here verbatim just the same, because this layer cannot tell
/// the difference and must not try.
///
/// The note id is deliberately **not** a field: records live under their note's
/// UUID in the index map, exactly as `BlockAnchor` does, so carrying it per row
/// would duplicate it into every task in the `MYI1` payload. The query layer
/// re-attaches it when it flattens records into result rows.
///
/// serde camelCase (TS sends camelCase).
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    /// Zero-based index of the task's line within the note body — the locator
    /// half of the record, with the note id supplied by the map key.
    pub line_index: u32,
    /// The task's source line, verbatim and unmodified. Uppercase `[X]` markers
    /// and non-canonical spacing survive here untouched (§6 C1).
    pub raw_line: String,
    /// Whether the checkbox is checked. Derived TS-side from the marker so the
    /// query layer never has to re-read `raw_line` — re-parsing it here would be
    /// the interpretation this struct exists to avoid.
    pub completed: bool,
    /// Set when the source line exceeded the raw-line cap and `raw_line` is
    /// therefore truncated (MYND-612 task 5). The record is still stored and
    /// still served — dropping it would make the task vanish from every surface
    /// — but the raw line is the authority for the pre-write verification, so a
    /// truncated one makes the task **unwritable**, and writers refuse on this
    /// flag rather than attempting a write they cannot verify.
    #[serde(default)]
    pub oversized: bool,
    /// `due`, verbatim. Opaque.
    pub due: Option<String>,
    /// `repeat`, verbatim. Opaque.
    pub repeat: Option<String>,
    /// `done`, verbatim. Opaque.
    pub done: Option<String>,
    /// `priority`, verbatim. Opaque.
    pub priority: Option<String>,
    /// `remind`, verbatim. Opaque.
    pub remind: Option<String>,
}

impl TaskRecord {
    fn zeroize_in_place(&mut self) {
        self.raw_line.zeroize();
        for field in [
            self.due.as_mut(),
            self.repeat.as_mut(),
            self.done.as_mut(),
            self.priority.as_mut(),
            self.remind.as_mut(),
        ]
        .into_iter()
        .flatten()
        {
            field.zeroize();
        }
    }
}

/// One heading from a note body (myne#216), for the vault-wide `[[##` picker.
///
/// **Costs no extra parse.** TS fills this from the SAME `parse()` an `apply`
/// already runs: `ParseResult.headings` carries level + text and has the
/// frontmatter guard applied. Unlike `block_anchors` and `tasks` — which each
/// re-parse — this field rides the existing tree.
///
/// **Text and level only.** The byte offsets `headingSections` also computes
/// (`from` / `sectionTo`) serve heading FOLDING, which runs against the open
/// note's own parse. A vault-wide picker needs neither, and storing them would
/// put a second, staler copy of the open note's offsets into the `MYI1` payload.
///
/// The note id is deliberately **not** a field, exactly as on [`BlockAnchor`]
/// and [`TaskRecord`]: records live under their note's UUID in the index map,
/// and the query layer re-attaches it when it flattens records into rows.
///
/// serde camelCase (TS sends camelCase).
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HeadingEntry {
    /// The heading's inline text, markers and links stripped (the dialect's
    /// `HeadingRef.text`). Plaintext-derived.
    pub text: String,
    /// The heading level, 1..=6 (ATX or Setext). Stored verbatim: an
    /// out-of-range value would be the extractor's bug to fix, not this
    /// layer's to clamp.
    pub level: u8,
}

impl HeadingEntry {
    fn zeroize_in_place(&mut self) {
        self.text.zeroize();
    }
}

/// One vault-wide line-task row (MYND-612): which note carries it (id + display
/// title + folder, so a surface can render provenance without a second lookup)
/// plus the record itself. The flat row shape [`VaultIndicesState::all_tasks`]
/// returns — the note id lives here rather than on `TaskRecord`, so it is stored
/// once per note and re-attached once per query, mirroring `VaultBlockAnchor`.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultTask {
    /// The note's UUID.
    pub note_id: String,
    /// The note's display title, if any.
    pub note_title: Option<String>,
    /// The note's `folder:` (trailing-slash form), or `None` at the root.
    pub note_folder: Option<String>,
    /// The stored record, verbatim. Rust interprets none of its fields.
    #[serde(flatten)]
    pub task: TaskRecord,
}

/// One resolved vault-wide block anchor for the `[[^^` picker (MYND-382): which
/// note carries it (id + display title) plus the block id + preview. The flat
/// row shape [`VaultIndicesState::all_block_anchors`] returns to the picker.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultBlockAnchor {
    /// The embedding note's UUID (the `[[…^id]]` target the picker inserts).
    pub note_id: String,
    /// The embedding note's display title, if any (untitled → `None`).
    pub note_title: Option<String>,
    /// The embedding note's `folder:` (trailing-slash form) or `None`/root —
    /// baked into the emitted path-form deep-link so it disambiguates same-title
    /// notes, exactly like the vault-heading picker.
    pub note_folder: Option<String>,
    /// The block id (no leading `^`).
    pub block_id: String,
    /// The block's preview line (picker secondary text).
    pub preview: String,
}

/// One vault-wide heading row (myne#216): the note that carries the heading plus
/// the heading itself. The flat row shape [`VaultIndicesState::all_headings`]
/// returns to the `[[##` picker.
///
/// **Carries no `note_title` / `note_folder`**, and that is the one deliberate
/// divergence from [`VaultBlockAnchor`] and [`VaultTask`]. This index is
/// trash-blind — exclusion is entirely TS-side via `resolverCache`
/// (`src/notes/resolverNotes.ts`) — so the consumer MUST join these rows against
/// the resident note-set regardless, to drop trashed and template notes. That
/// join already holds the note's title and folder, so a copy here would be a
/// value the consumer discards, and one that goes stale in the window between a
/// rename and the re-apply that follows it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultHeadingRow {
    /// The note carrying the heading (the join key into the resident note-set).
    pub note_id: String,
    /// The heading's inline text.
    pub text: String,
    /// The heading level, 1..=6.
    pub level: u8,
}

/// Per-note record in the index.
///
/// Holds the note's `title` + `folder` (the inputs the TS resolver —
/// `resolveWikilink.ts`, §5.3 — needs as the resident note-set, and the
/// reverse `uuid → title-key` lookup the backlink candidate query uses in
/// Task 3), its per-occurrence outbound wikilink `edges` (Task 2), and its
/// `tags` (Task 4). All string content is plaintext-derived.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteRecord {
    /// The note's `title:` (frontmatter or first-H1 derived), if any.
    pub title: Option<String>,
    /// The note's virtual `folder:` (frontmatter), if any.
    pub folder: Option<String>,
    /// The note's own folded title-key (`§3.7.8` fold, computed TS-side like
    /// the edge title-keys), or `None` when untitled. The in-degree half of
    /// the orphan query (MYND-197): a note is "referenced" iff some edge's
    /// folded target title-key equals this. Folding stays TS-side (no Turkish
    /// divergence), so Rust receives it pre-folded.
    pub title_key: Option<String>,
    /// Per-occurrence outbound wikilink edges (Task 2).
    pub edges: Vec<WikilinkEdge>,
    /// The note's tags — inline `#tags` ∪ frontmatter `tags:`, deduped by
    /// `folded` TS-side before apply (Task 4).
    pub tags: Vec<TagEntry>,
    /// The note's typed frontmatter properties (Task 7 / MYND-271) — every
    /// arbitrary key coerced TS-side per §3.6.4. Opaque pre-typed values; Rust
    /// stores + returns them without interpretation. Plaintext-derived.
    pub properties: Vec<PropertyEntry>,
    /// Imported `^block-id` anchors in this note (MYND-382, the `[[^^` picker).
    /// `#[serde(default)]` so a note that sends none — or a pre-382 TS `apply`
    /// (mobile, or an older desktop build) — deserializes to empty. The postcard
    /// SNAPSHOT still forces a rebuild of a pre-382 `vault.indices` blob: a
    /// missing trailing field is a postcard decode error (non-self-describing),
    /// which the load path maps to a full TS rebuild (§9.8.4) — the intended
    /// rebuild-on-format-change.
    #[serde(default)]
    pub block_anchors: Vec<BlockAnchor>,
    /// Line-tasks in this note (MYND-612). Trailing + `#[serde(default)]` for the
    /// same reason `block_anchors` is: a client that sends none — mobile, which
    /// has its own extractor, or an older desktop build — deserializes to empty
    /// and the invoke argument stays wire-compatible in both directions. The
    /// postcard SNAPSHOT is non-self-describing, so a pre-612 `vault.indices`
    /// blob fails to decode and the load path falls to a full TS rebuild
    /// (§9.8.4) — the intended rebuild-on-format-change.
    #[serde(default)]
    pub tasks: Vec<TaskRecord>,
    /// Headings in this note (myne#216, the vault-wide `[[##` picker). Trailing +
    /// `#[serde(default)]` for the same reason `block_anchors` and `tasks` are:
    /// a client that sends none — mobile, or an older desktop build —
    /// deserializes to empty and the invoke argument stays wire-compatible in
    /// both directions. The postcard SNAPSHOT is non-self-describing, so a
    /// pre-#216 `vault.indices` blob fails to decode and the load path falls to a
    /// full TS rebuild (§9.8.4) — the intended rebuild-on-format-change, paid
    /// once.
    #[serde(default)]
    pub headings: Vec<HeadingEntry>,
    /// Whether the note is part of the user's WORKING SET as the sidebar tree
    /// defines it (`isLiveNote`: not trashed, not tombstoned, not archived, not
    /// a template, not a conflict copy).
    ///
    /// Computed **TS-side by that same predicate**: the producer calls
    /// `isLiveNote` and ships the answer, so a change to the sidebar's rule
    /// moves this field with it. The agent's scope resolves against `live`
    /// rather than re-deriving liveness from the markers, because a second
    /// reader of the marker set is a second opinion about what "live" means,
    /// which is exactly what this index's accessors refuse to be.
    ///
    /// Trailing, and **deliberately with no serde default** (review finding):
    /// a default answers `true`, which is the fail-OPEN direction for a
    /// permission input, and the sibling wire parameter says so out loud
    /// (`commands.rs`: "A default would fail OPEN (every note in the agent's
    /// scope)"). An omission is therefore a deserialization failure, which is
    /// the answer a permission field owes. It does not serve a pre-change
    /// at-rest snapshot either way:
    ///
    /// **A snapshot taken before this field existed does not load as a complete
    /// index.** The postcard blob is non-self-describing, so the read runs out of
    /// record: at end of input for a one-record snapshot, and inside the next
    /// record's bytes for a many-record one. `docs/spec/protocol.md` §9.8.2 names
    /// the residual that makes the second case worth pinning rather than
    /// assuming: `from_bytes` performs no trailing-byte check, so a read whose
    /// remaining bytes happen to satisfy the UTF-8 and discriminant checks could
    /// terminate SUCCESSFULLY with a wrong map. It does not here, and
    /// `persist.rs::a_snapshot_written_before_the_live_field_does_not_load_as_a_complete_index`
    /// holds both record counts to that, because this field is a PERMISSION input
    /// rather than display data: a wrong map's `live` values are a wrong agent
    /// scope, not a wrong heading list. The load path falls to a full TS rebuild
    /// (§9.8.4), the intended rebuild-on-format-change, paid once.
    pub live: bool,
}

/// `live: true` by hand rather than by derive, and the difference is the whole
/// reason this impl exists: `#[derive(Default)]` would make a bare
/// `NoteRecord::default()` NON-live, so every test and fixture that builds one
/// with `..Default::default()` would quietly drop out of the agent's working
/// set. A record with nothing in it is not a hidden one.
impl Default for NoteRecord {
    fn default() -> Self {
        Self {
            title: None,
            folder: None,
            title_key: None,
            edges: Vec::new(),
            tags: Vec::new(),
            properties: Vec::new(),
            block_anchors: Vec::new(),
            tasks: Vec::new(),
            headings: Vec::new(),
            live: true,
        }
    }
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
        if let Some(k) = self.title_key.as_mut() {
            k.zeroize();
        }
        for edge in self.edges.iter_mut() {
            edge.zeroize_in_place();
        }
        self.edges.clear();
        for tag in self.tags.iter_mut() {
            tag.zeroize_in_place();
        }
        self.tags.clear();
        for property in self.properties.iter_mut() {
            property.zeroize_in_place();
        }
        self.properties.clear();
        for anchor in self.block_anchors.iter_mut() {
            anchor.zeroize_in_place();
        }
        self.block_anchors.clear();
        for task in self.tasks.iter_mut() {
            task.zeroize_in_place();
        }
        self.tasks.clear();
        for heading in self.headings.iter_mut() {
            heading.zeroize_in_place();
        }
        self.headings.clear();
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

    /// Snapshot the whole index as a sorted `note_id → NoteRecord` map (Task 8
    /// / MYND-271 — the MYI1 persistence projection). `BTreeMap` for a
    /// deterministic serialization order. Empty on a poisoned lock. The caller
    /// pairs this with a freshly-scanned `content_nonce` manifest and encrypts
    /// it into the `vault.indices` blob.
    pub fn snapshot(&self) -> std::collections::BTreeMap<String, NoteRecord> {
        self.inner
            .lock()
            .map(|idx| {
                idx.notes
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Replace the entire in-RAM index with `records` (Task 8 — the unlock
    /// fast-path load from `vault.indices`). Zeroizes the prior contents first
    /// (this only runs at unlock when the index is freshly empty, but the wipe
    /// keeps the invariant that no stale plaintext-derived bytes linger).
    /// No-op on a poisoned lock.
    pub fn bulk_replace(&self, records: std::collections::BTreeMap<String, NoteRecord>) {
        if let Ok(mut idx) = self.inner.lock() {
            idx.zeroize_in_place();
            idx.notes = records.into_iter().collect();
        }
    }

    /// Clone a note's typed frontmatter properties out (Task 7 / MYND-271).
    /// Empty when the note is absent / propertyless / on a poisoned lock. The
    /// query-engine sub-feature consumes these for filter/sort; **all type-aware
    /// comparison happens TS-side** — this is a pure accessor with no
    /// evaluatable-expression hook.
    pub fn note_properties(&self, note_id: &str) -> Vec<PropertyEntry> {
        self.inner
            .lock()
            .ok()
            .and_then(|idx| idx.notes.get(note_id).map(|r| r.properties.clone()))
            .unwrap_or_default()
    }

    /// Vault-wide by-key accessor (Task 7 / MYND-271): `(note_id, entry)` for
    /// every note carrying a property named `key`. The query engine's primitive
    /// — it compares/filters the returned values TS-side (no comparison logic,
    /// and NO expression evaluation, lives here). Empty on a poisoned lock.
    pub fn property_values(&self, key: &str) -> Vec<(String, PropertyEntry)> {
        let Ok(idx) = self.inner.lock() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for (id, record) in idx.notes.iter() {
            for entry in &record.properties {
                if entry.key == key {
                    out.push((id.clone(), entry.clone()));
                }
            }
        }
        out
    }

    /// Vault-wide DISTINCT frontmatter property-key list — every key present
    /// across the vault's typed properties, sorted + deduped (`BTreeSet`). The
    /// key-universe companion to `property_values`: it surfaces WHICH properties
    /// exist so the saved-view authoring UI can offer groupBy / sort / column
    /// pickers over real keys. No values, no comparison, no expression eval.
    /// Empty on a poisoned lock.
    pub fn property_keys(&self) -> Vec<String> {
        let Ok(idx) = self.inner.lock() else {
            return Vec::new();
        };
        let mut keys = std::collections::BTreeSet::new();
        for record in idx.notes.values() {
            for entry in &record.properties {
                // Clone only the first time a key is seen — a key shared across
                // many notes (the common case) then costs a `&str` lookup, not a
                // heap allocation discarded by the set.
                if !keys.contains(entry.key.as_str()) {
                    keys.insert(entry.key.clone());
                }
            }
        }
        keys.into_iter().collect()
    }

    /// Every imported block anchor across the vault (MYND-382, the `[[^^`
    /// picker), each tagged with its embedding note's id + display title, in a
    /// deterministic order (notes by UUID, anchors in document order as applied).
    /// `max` is a DEFENSIVE ceiling against a pathological payload — accumulation
    /// stops once the cap is reached (truncated). Empty on a poisoned lock. The
    /// picker inserts `[[<note>^block_id]]`; resolution + display stay TS-side.
    pub fn all_block_anchors(&self, max: usize) -> Vec<VaultBlockAnchor> {
        let Ok(idx) = self.inner.lock() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        // BTreeMap-free HashMap iteration is order-unstable, but the picker sorts
        // TS-side by title; the cap makes the traversal bound explicit regardless.
        for (id, record) in idx.notes.iter() {
            for anchor in &record.block_anchors {
                if out.len() >= max {
                    return out;
                }
                out.push(VaultBlockAnchor {
                    note_id: id.clone(),
                    note_title: record.title.clone(),
                    note_folder: record.folder.clone(),
                    block_id: anchor.block_id.clone(),
                    preview: anchor.preview.clone(),
                });
            }
        }
        out
    }

    /// Every line-task in the vault, each tagged with its note (MYND-612).
    ///
    /// Deliberately **unparameterized**: it returns the whole list and does no
    /// filtering, sorting, or date comparison. A parameterized accessor would
    /// require Rust to compare dates, and once that door opens the next request
    /// is sorting and the one after is tag filtering — at which point the type
    /// authority has quietly moved out of the dialect layer. Filtering belongs
    /// to the surfaces; this is a dump.
    ///
    /// Iteration stops once `max` is reached, exactly as the block-anchor dump
    /// does, so the traversal bound is explicit.
    pub fn all_tasks(&self, max: usize) -> Vec<VaultTask> {
        let Ok(idx) = self.inner.lock() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for (id, record) in idx.notes.iter() {
            for task in &record.tasks {
                if out.len() >= max {
                    return out;
                }
                out.push(VaultTask {
                    note_id: id.clone(),
                    note_title: record.title.clone(),
                    note_folder: record.folder.clone(),
                    task: task.clone(),
                });
            }
        }
        out
    }

    /// Every heading in the vault, tagged with the note carrying it (myne#216).
    ///
    /// This replaces a full-vault read: the `[[##` picker used to be fed by
    /// re-reading and re-parsing every note body on each index change, which is
    /// work proportional to the vault on every keystroke-triggered autosave.
    ///
    /// **Trash-blind, like every other accessor here.** Rows for trashed and
    /// template notes ARE returned; the caller joins against the resident
    /// note-set and drops them, which is where that exclusion lives for every
    /// surface (`resolverNotes.ts`). An accessor that filtered here would be a
    /// second opinion about what "live" means.
    ///
    /// Iteration stops once `max` is reached, exactly as the block-anchor and
    /// task dumps do, so the traversal bound is explicit.
    pub fn all_headings(&self, max: usize) -> Vec<VaultHeadingRow> {
        let Ok(idx) = self.inner.lock() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        // HashMap iteration is order-unstable; the picker sorts TS-side, exactly
        // as it does for the block-anchor dump.
        for (id, record) in idx.notes.iter() {
            for heading in &record.headings {
                if out.len() >= max {
                    return out;
                }
                out.push(VaultHeadingRow {
                    note_id: id.clone(),
                    text: heading.text.clone(),
                    level: heading.level,
                });
            }
        }
        out
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

    /// Bulk dump of every note's raw outbound edges — `(note_id, edges)` per
    /// note (MYND-197). One IPC call replaces N per-note `forward()` round
    /// trips for the whole-vault graph build; resolution stays TS-side. The
    /// caller routes by `note_count()` BEFORE calling this (a `> cap` vault
    /// takes the per-note BFS subgraph path instead), so the whole-vault dump
    /// only runs at ≤ cap. `max_edges` is a DEFENSIVE ceiling against a
    /// pathological payload — accumulation stops once the total edge count
    /// would exceed it (truncated; the normal route-by-count path never trips
    /// it). Empty on a poisoned lock.
    pub fn all_edges(&self, max_edges: usize) -> Vec<(String, Vec<WikilinkEdge>)> {
        let Ok(idx) = self.inner.lock() else {
            return Vec::new();
        };
        let mut out = Vec::with_capacity(idx.notes.len());
        let mut total = 0usize;
        for (id, record) in idx.notes.iter() {
            if total >= max_edges {
                break; // defensive ceiling — never serialize an unbounded payload
            }
            let take = record.edges.len().min(max_edges - total);
            total += take;
            out.push((id.clone(), record.edges[..take].to_vec()));
        }
        out
    }

    /// Structurally-isolated ("orphan") note ids — zero outbound edges AND not
    /// referenced as the folded title-key target of any edge (MYND-197 /
    /// SYNC-13). A degree-0 INDEX query: needs no edge dump and works at any
    /// vault size, so the orphans-only graph view bypasses the `> cap`
    /// route-by-count tension. Untitled notes (no `title_key`) can't be
    /// referenced by title, so they are orphans iff they have no outbound
    /// edges. Raw structural definition: a note whose only edges are BROKEN is
    /// NOT flagged here — that resolved-orphan refinement needs TS resolution
    /// and is deferred. Empty on a poisoned lock.
    pub fn orphans(&self) -> Vec<String> {
        let Ok(idx) = self.inner.lock() else {
            return Vec::new();
        };
        // Every folded target title-key any edge points at (the in-degree side).
        let mut referenced: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for record in idx.notes.values() {
            for edge in &record.edges {
                referenced.insert(edge.title_key.as_str());
            }
        }
        idx.notes
            .iter()
            .filter(|(_, record)| {
                record.edges.is_empty()
                    && match record.title_key.as_deref() {
                        Some(key) => !referenced.contains(key),
                        None => true, // untitled → unreferenceable by title
                    }
            })
            .map(|(id, _)| id.clone())
            .collect()
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
    ///
    /// `folder_prefix` scopes the whole tree to notes under one folder
    /// (myne-md/myne#908 item 8). It exists so the auto-tag prompt can carry the
    /// vocabulary of the note's OWN project instead of every tag in the vault,
    /// which is what let a note about one project be offered another project's
    /// tag. `None` is the pre-existing whole-vault answer byte for byte, so every
    /// caller that does not pass one keeps today's behaviour. An empty string
    /// means the vault ROOT, not "everything": the root is a real folder a note
    /// can live in.
    pub fn tag_tree(&self, folder_prefix: Option<&str>) -> Vec<TagTreeNode> {
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
            if let Some(prefix) = folder_prefix {
                if !note_is_under_folder(record.folder.as_deref(), prefix) {
                    continue;
                }
            }
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

/// Is `note_folder` (a trailing-slash canonical folder, or `None` at the root)
/// the same folder as `prefix`, or somewhere beneath it?
///
/// The comparison is on the SLASH-BOUNDARY, never on a raw `starts_with`: a
/// prefix of `Projects` must not match `Projects-old`, which is the whole
/// difference between a folder-scoped hint and a substring one.
fn note_is_under_folder(note_folder: Option<&str>, prefix: &str) -> bool {
    let p = prefix.trim_matches('/');
    let f = note_folder.unwrap_or("").trim_matches('/');
    if p.is_empty() {
        return f.is_empty();
    }
    if f == p {
        return true;
    }
    f.len() > p.len() && f.starts_with(p) && f.as_bytes()[p.len()] == b'/'
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
    fn all_edges_dumps_every_note_with_its_edges() {
        let state = VaultIndicesState::default();
        let mut a = rec("Alpha", None);
        a.edges = vec![edge("Beta", false)];
        let mut b = rec("Beta", None);
        b.edges = vec![edge("Alpha", false), edge("Gamma", false)];
        state.apply("a", a);
        state.apply("b", b);
        state.apply("c", rec("Gamma", None)); // linkless note still appears
        let dump = state.all_edges(1_000);
        assert_eq!(dump.len(), 3);
        let total: usize = dump.iter().map(|(_, e)| e.len()).sum();
        assert_eq!(total, 3); // 1 + 2 + 0
    }

    #[test]
    fn all_edges_truncates_at_the_defensive_ceiling() {
        let state = VaultIndicesState::default();
        let mut a = rec("Alpha", None);
        a.edges = vec![edge("X", false), edge("Y", false), edge("Z", false)];
        state.apply("a", a);
        let dump = state.all_edges(2); // ceiling below the 3 edges
        let total: usize = dump.iter().map(|(_, e)| e.len()).sum();
        assert!(total <= 2, "the ceiling caps the total edge count");
    }

    #[test]
    fn orphans_are_notes_with_zero_in_and_out_edges() {
        let state = VaultIndicesState::default();
        // hub: titled, referenced by `linker`, no out-edges → NOT orphan (in-edge).
        let mut hub = rec("Hub", None);
        hub.title_key = Some("hub".to_string());
        // linker: has an out-edge → NOT orphan.
        let mut linker = rec("Linker", None);
        linker.title_key = Some("linker".to_string());
        linker.edges = vec![edge("Hub", false)]; // edge.title_key == "hub"
                                                 // lonely: titled, unreferenced, no out-edges → ORPHAN.
        let mut lonely = rec("Lonely", None);
        lonely.title_key = Some("lonely".to_string());
        // untitled: no title_key, no out-edges → ORPHAN (unreferenceable by title).
        let untitled = NoteRecord::default();
        state.apply("hub", hub);
        state.apply("linker", linker);
        state.apply("lonely", lonely);
        state.apply("untitled", untitled);
        let mut orphans = state.orphans();
        orphans.sort();
        assert_eq!(orphans, vec!["lonely".to_string(), "untitled".to_string()]);
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

        let tree = state.tag_tree(None);
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

        let tree = state.tag_tree(None);
        let node = tree.iter().find(|n| n.key == "kitap").expect("kitap node");
        // lexicographically-min of {"Kitap","kitap"} → "Kitap" (ASCII upper < lower).
        assert_eq!(node.display, "Kitap");
        assert_eq!(node.subtree_count, 2);
    }

    /// The tag browser's ordering is a property of the DATA, not of the host —
    /// myne-md/myne#555, the `tags.browser` bullet ("stable ordering, no tag
    /// twice").
    ///
    /// The roster row asked a person to open the tag browser on a vault with
    /// nested tags and check that the order looked right and nothing appeared
    /// twice. Both are decided here, by the `BTreeMap` this function
    /// accumulates into, and neither is checked anywhere: the two tests above
    /// assert counts and the display choice, and would pass on a tree that
    /// emitted its nodes in note-insertion order with duplicates in it.
    ///
    /// Insertion order is the lever, because it is the one thing that differs
    /// between two users looking at the same vault: notes arrive from the index
    /// rebuild in whatever order the `HashMap` iterates, which Rust
    /// deliberately does not fix. If the output were assembled from that
    /// iteration rather than through the `BTreeMap`, two clients would draw the
    /// same tag tree in two different orders and each would be stable on its own
    /// machine — the shape a hand-walk cannot see, because a hand-walk is one
    /// machine.
    #[test]
    fn tag_tree_order_does_not_depend_on_the_order_notes_arrived() {
        // Deliberately not alphabetical, and deliberately overlapping: several
        // notes contribute the SAME intermediate nodes, which is where a
        // duplicate would come from.
        let tags = [
            ("zeta", "Zeta"),
            ("area/project/alpha", "Area/Project/Alpha"),
            ("area", "Area"),
            ("area/project", "Area/Project"),
            ("beta/one", "Beta/One"),
            ("area/notes", "Area/Notes"),
            ("beta", "Beta"),
        ];

        let forwards = VaultIndicesState::default();
        for (i, (folded, display)) in tags.iter().enumerate() {
            let mut r = rec(&format!("N{i}"), None);
            r.tags = vec![tag(folded, display)];
            forwards.apply(&format!("n{i}"), r);
        }

        let backwards = VaultIndicesState::default();
        for (i, (folded, display)) in tags.iter().enumerate().rev() {
            let mut r = rec(&format!("N{i}"), None);
            r.tags = vec![tag(folded, display)];
            backwards.apply(&format!("n{i}"), r);
        }

        let a = forwards.tag_tree(None);
        let b = backwards.tag_tree(None);
        let keys = |t: &Vec<TagTreeNode>| t.iter().map(|n| n.key.clone()).collect::<Vec<_>>();
        assert_eq!(
            keys(&a),
            keys(&b),
            "the tag tree came out in a different order depending on which order \
             the notes were applied, so two clients with the same vault would \
             draw two different trees"
        );

        // Sorted by folded key, which is what makes the order reproducible
        // rather than merely repeatable.
        let mut sorted = keys(&a);
        sorted.sort();
        assert_eq!(keys(&a), sorted, "the tag tree is not in folded-key order");

        // No tag twice — the other half of the row's own acceptance. Overlapping
        // ancestors are the case that produces one.
        let mut seen = std::collections::BTreeSet::new();
        for n in &a {
            assert!(
                seen.insert(n.key.clone()),
                "the tag `{}` appears more than once in the tree",
                n.key
            );
        }

        // Non-vacuity: the ancestors really were contributed by more than one
        // note, so the dedup above had something to do.
        let area = a.iter().find(|n| n.key == "area").expect("area node");
        assert_eq!(
            area.subtree_count, 4,
            "four notes sit under #area (area, area/project, area/project/alpha, \
             area/notes), so the ancestor node is genuinely shared"
        );
    }

    /// Ordering is byte order over the folded key, and no locale can move it.
    ///
    /// The other half of the same bullet: the tag path consults no host
    /// collation. In Rust that is true by construction — `BTreeMap<String, _>`
    /// orders by `Ord for str`, which is UTF-8 byte order and takes no locale —
    /// and this pins it against a change to a locale-aware collator, which is
    /// exactly the kind of change somebody makes to "sort Turkish tags
    /// properly".
    ///
    /// `ç`/`i`/`ı`/`ş` are the interesting inputs: a `tr_TR` collation orders
    /// `ı` before `i` and puts `ç` immediately after `c`, while byte order puts
    /// every non-ASCII letter after every ASCII one. The two disagree, so an
    /// implementation that started asking the host would fail here rather than
    /// silently giving two users different trees.
    #[test]
    fn tag_tree_order_is_byte_order_and_not_a_locale_collation() {
        let state = VaultIndicesState::default();
        for (i, folded) in ["zebra", "çay", "ısı", "index", "cay"].iter().enumerate() {
            let mut r = rec(&format!("N{i}"), None);
            r.tags = vec![tag(folded, folded)];
            state.apply(&format!("n{i}"), r);
        }
        let keys = state
            .tag_tree(None)
            .iter()
            .map(|n| n.key.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            keys,
            vec!["cay", "index", "zebra", "çay", "ısı"],
            "the tag tree is no longer in UTF-8 byte order. A locale-aware \
             collation here would order these by the machine's language settings, \
             so the same vault would draw a different tag browser on a Turkish \
             desktop than on an English one."
        );
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

    // ---- Task 7: typed properties --------------------------------------

    fn scalar(ty: &str, value: &str) -> PropertyScalar {
        PropertyScalar {
            r#type: ty.to_string(),
            value: value.to_string(),
        }
    }

    fn prop(key: &str, ty: &str, value: &str) -> PropertyEntry {
        PropertyEntry {
            key: key.to_string(),
            r#type: ty.to_string(),
            value: Some(value.to_string()),
            elements: None,
        }
    }

    #[test]
    fn note_properties_round_trip_scalar_and_list() {
        let state = VaultIndicesState::default();
        let mut r = rec("Alpha", None);
        r.properties = vec![
            prop("status", "string", "in-progress"),
            prop("rating", "number", "4"),
            PropertyEntry {
                key: "tags".to_string(),
                r#type: "list".to_string(),
                value: None,
                elements: Some(vec![scalar("string", "a"), scalar("number", "1")]),
            },
        ];
        state.apply("a", r);

        let props = state.note_properties("a");
        assert_eq!(props.len(), 3);
        assert_eq!(props[0], prop("status", "string", "in-progress"));
        assert_eq!(props[1], prop("rating", "number", "4"));
        assert_eq!(props[2].r#type, "list");
        let els = props[2].elements.as_ref().expect("list elements");
        assert_eq!(els.len(), 2);
        assert_eq!(els[0], scalar("string", "a"));
        assert_eq!(els[1], scalar("number", "1"));
    }

    #[test]
    fn note_properties_empty_when_absent_or_propertyless() {
        let state = VaultIndicesState::default();
        state.apply("a", rec("Alpha", None)); // no properties
        assert!(state.note_properties("a").is_empty());
        assert!(state.note_properties("missing").is_empty());
    }

    #[test]
    fn property_values_collects_the_key_across_notes() {
        let state = VaultIndicesState::default();
        let mut a = rec("Alpha", None);
        a.properties = vec![
            prop("status", "string", "todo"),
            prop("rating", "number", "5"),
        ];
        let mut b = rec("Beta", None);
        b.properties = vec![prop("status", "string", "done")];
        let c = rec("Gamma", None); // no status
        state.apply("a", a);
        state.apply("b", b);
        state.apply("c", c);

        let mut got: Vec<(String, String)> = state
            .property_values("status")
            .into_iter()
            .map(|(id, e)| (id, e.value.unwrap_or_default()))
            .collect();
        got.sort();
        assert_eq!(
            got,
            vec![
                ("a".to_string(), "todo".to_string()),
                ("b".to_string(), "done".to_string()),
            ]
        );
        assert!(state.property_values("nonexistent").is_empty());
    }

    #[test]
    fn property_keys_lists_distinct_keys_sorted() {
        let state = VaultIndicesState::default();
        let mut a = rec("Alpha", None);
        a.properties = vec![
            prop("status", "string", "todo"),
            prop("rating", "number", "5"),
        ];
        let mut b = rec("Beta", None);
        b.properties = vec![prop("status", "string", "done")]; // key repeats across notes
        state.apply("a", a);
        state.apply("b", b);
        state.apply("c", rec("Gamma", None)); // no properties

        // distinct + sorted; "status" spans two notes but appears once.
        assert_eq!(
            state.property_keys(),
            vec!["rating".to_string(), "status".to_string()]
        );
    }

    #[test]
    fn property_keys_empty_when_no_properties() {
        let state = VaultIndicesState::default();
        state.apply("a", rec("Alpha", None));
        assert!(state.property_keys().is_empty());
    }

    #[test]
    fn apply_replace_overwrites_stale_properties() {
        let state = VaultIndicesState::default();
        let mut v1 = rec("Alpha", None);
        v1.properties = vec![prop("status", "string", "todo")];
        state.apply("a", v1);
        // Re-apply with a different property set — the prior one must not linger.
        let mut v2 = rec("Alpha", None);
        v2.properties = vec![
            prop("status", "string", "done"),
            prop("due", "date", "2026-06-14"),
        ];
        state.apply("a", v2);

        let props = state.note_properties("a");
        assert_eq!(props.len(), 2);
        assert_eq!(props[0], prop("status", "string", "done"));
        assert_eq!(props[1], prop("due", "date", "2026-06-14"));
    }

    #[test]
    fn clear_wipes_properties() {
        let state = VaultIndicesState::default();
        let mut r = rec("Alpha", None);
        r.properties = vec![prop("status", "string", "secret-value")];
        state.apply("a", r);
        state.clear();
        assert!(state.note_properties("a").is_empty());
        assert!(state.property_values("status").is_empty());
    }

    // ---- MYND-382: vault-wide block anchors --------------------------

    #[test]
    fn all_block_anchors_flattens_with_note_provenance() {
        let state = VaultIndicesState::default();
        let mut a = rec("Alpha", None);
        a.block_anchors = vec![
            BlockAnchor {
                block_id: "intro".to_string(),
                preview: "The intro.".to_string(),
            },
            BlockAnchor {
                block_id: "concl".to_string(),
                preview: "The conclusion.".to_string(),
            },
        ];
        state.apply("note-a", a);
        // A note without anchors contributes none.
        state.apply("note-b", rec("Beta", None));

        let mut got = state.all_block_anchors(1000);
        got.sort_by(|x, y| x.block_id.cmp(&y.block_id));
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].block_id, "concl");
        assert_eq!(got[0].note_id, "note-a");
        assert_eq!(got[0].note_title.as_deref(), Some("Alpha"));
        assert_eq!(got[1].block_id, "intro");
        assert_eq!(got[1].preview, "The intro.");
    }

    #[test]
    fn all_block_anchors_respects_the_cap_and_clear_wipes_them() {
        let state = VaultIndicesState::default();
        let mut a = rec("Alpha", None);
        a.block_anchors = (0..5)
            .map(|i| BlockAnchor {
                block_id: format!("b{i}"),
                preview: format!("preview {i}"),
            })
            .collect();
        state.apply("note-a", a);
        assert_eq!(
            state.all_block_anchors(3).len(),
            3,
            "defensive cap truncates"
        );
        assert_eq!(state.all_block_anchors(1000).len(), 5);
        state.clear();
        assert!(state.all_block_anchors(1000).is_empty());
    }

    // ---- myne#216: vault-wide headings --------------------------------

    fn heading(text: &str, level: u8) -> HeadingEntry {
        HeadingEntry {
            text: text.to_string(),
            level,
        }
    }

    #[test]
    fn all_headings_flattens_every_note_in_document_order() {
        let state = VaultIndicesState::default();
        let mut a = rec("Alpha", None);
        a.headings = vec![heading("Goals", 1), heading("Risks", 2)];
        state.apply("note-a", a);
        let mut b = rec("Beta", None);
        b.headings = vec![heading("Notes", 3)];
        state.apply("note-b", b);
        // A note without headings contributes none.
        state.apply("note-c", rec("Gamma", None));

        let got = state.all_headings(1000);
        assert_eq!(got.len(), 3);

        // Notes come back in hash order, but a note's own headings keep the
        // order they were applied in — that is what lets the TS join produce a
        // deterministic list without sorting the text.
        let a_rows: Vec<_> = got.iter().filter(|r| r.note_id == "note-a").collect();
        assert_eq!(a_rows.len(), 2);
        assert_eq!(a_rows[0].text, "Goals");
        assert_eq!(a_rows[0].level, 1);
        assert_eq!(a_rows[1].text, "Risks");
    }

    #[test]
    fn all_headings_are_returned_for_every_note_the_index_holds() {
        // The accessor is trash-blind by design: exclusion lives in the TS join
        // against the resident note-set, the single place every reader surface
        // excludes trashed and template notes. An accessor that filtered here
        // would be a second opinion about what "live" means.
        let state = VaultIndicesState::default();
        let mut trashed = rec("A trashed note", None);
        trashed.headings = vec![heading("Still indexed", 1)];
        state.apply("note-trashed", trashed);

        assert_eq!(state.all_headings(1000).len(), 1);
    }

    #[test]
    fn all_headings_respects_the_cap_and_clear_wipes_them() {
        let state = VaultIndicesState::default();
        let mut a = rec("Alpha", None);
        a.headings = (0..5).map(|i| heading(&format!("h{i}"), 2)).collect();
        state.apply("note-a", a);
        assert_eq!(state.all_headings(3).len(), 3, "defensive cap truncates");
        assert_eq!(state.all_headings(1000).len(), 5);
        state.clear();
        assert!(state.all_headings(1000).is_empty());
    }

    #[test]
    fn apply_replace_overwrites_stale_headings() {
        // Replace semantics: a note whose headings changed must not keep the old
        // ones, which is why the TS wrapper sends `headings` unconditionally.
        let state = VaultIndicesState::default();
        let mut first = rec("Alpha", None);
        first.headings = vec![heading("Old", 1)];
        state.apply("note-a", first);
        let mut second = rec("Alpha", None);
        second.headings = vec![heading("New", 2)];
        state.apply("note-a", second);

        let got = state.all_headings(1000);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].text, "New");
    }

    // --- MYND-612: line-task records -------------------------------------

    fn task(line_index: u32, due: Option<&str>) -> TaskRecord {
        TaskRecord {
            line_index,
            raw_line: format!("- [ ] task on line {line_index}"),
            completed: false,
            oversized: false,
            due: due.map(str::to_string),
            repeat: None,
            done: None,
            priority: None,
            remind: None,
        }
    }

    #[test]
    fn task_fields_are_stored_verbatim_including_values_rust_cannot_parse() {
        // The contract is that Rust interprets NOTHING. Values that are not
        // valid dates at all — a half-written one, an offset-bearing one, a
        // recurrence phrase, an emoji-form leftover — must survive byte-identical,
        // because this layer cannot tell a typed value from an untyped one and
        // must not try. If anything here ever starts parsing, this test breaks.
        let state = VaultIndicesState::default();
        let mut a = rec("Alpha", None);
        a.tasks = vec![TaskRecord {
            line_index: 3,
            raw_line: "- [X] ship it ✅ 2026-07-27 🔁 every 3 days".to_string(),
            completed: true,
            oversized: false,
            due: Some("2026-02-31".to_string()),
            repeat: Some("every 3 days".to_string()),
            done: Some("2026-07-27".to_string()),
            priority: Some("not-a-real-priority".to_string()),
            remind: Some("2026-08-01T10:00:00+03:00".to_string()),
        }];
        state.apply("note-a", a.clone());

        let stored = state.note_record("note-a").expect("record present");
        assert_eq!(stored.tasks, a.tasks, "every field round-trips verbatim");
        assert_eq!(stored.tasks[0].due.as_deref(), Some("2026-02-31"));
        assert_eq!(
            stored.tasks[0].remind.as_deref(),
            Some("2026-08-01T10:00:00+03:00"),
            "an offset is neither stripped nor normalized here"
        );
        assert_eq!(
            stored.tasks[0].raw_line,
            "- [X] ship it ✅ 2026-07-27 🔁 every 3 days"
        );
    }

    #[test]
    fn a_record_from_a_client_that_sends_no_tasks_is_empty_not_an_error() {
        // Mobile has its own extractor and an older desktop build has none; both
        // must keep working against this command. `#[serde(default)]` plus the
        // `Option` invoke argument is what makes the wire compatible both ways.
        let json = r#"{"title":"Alpha","folder":null,"title_key":null,"edges":[],"tags":[],"properties":[],"live":true}"#;
        let parsed: NoteRecord = serde_json::from_str(json).expect("deserializes without tasks");
        assert!(parsed.tasks.is_empty());
        assert!(parsed.block_anchors.is_empty());
        // **`live` is the one field an omission must NOT be forgiven on**
        // (review finding): it is the agent's read/write scope, so a default
        // here fails OPEN. The wire parameter is required for the same reason
        // (`commands.rs`), and this pins the state-side posture.
        let no_live = r#"{"title":"Alpha","folder":null,"title_key":null,"edges":[],"tags":[],"properties":[]}"#;
        assert!(
            serde_json::from_str::<NoteRecord>(no_live).is_err(),
            "a record with no `live` deserialized; a permission field must refuse rather than default"
        );
    }

    #[test]
    fn tasks_are_wiped_on_every_clear_path() {
        let state = VaultIndicesState::default();
        let mut a = rec("Alpha", None);
        a.tasks = vec![task(1, Some("2026-08-01")), task(2, None)];
        state.apply("note-a", a);
        assert_eq!(state.note_record("note-a").expect("present").tasks.len(), 2);

        state.clear();
        assert!(
            state.note_record("note-a").is_none(),
            "lock clears the record carrying the tasks"
        );
    }

    #[test]
    fn re_applying_a_note_replaces_its_tasks_rather_than_appending() {
        let state = VaultIndicesState::default();
        let mut first = rec("Alpha", None);
        first.tasks = vec![task(1, Some("2026-08-01")), task(2, None)];
        state.apply("note-a", first);

        let mut second = rec("Alpha", None);
        second.tasks = vec![task(9, Some("2026-09-09"))];
        state.apply("note-a", second);

        let stored = state.note_record("note-a").expect("present");
        assert_eq!(stored.tasks.len(), 1, "replace semantics, not append");
        assert_eq!(stored.tasks[0].line_index, 9);
    }

    // myne-md/myne#908 item 8 — the tag tree can be read for ONE folder, which
    // is what the auto-tag prompt uses instead of the whole vault's vocabulary.

    #[test]
    fn tag_tree_scopes_to_a_folder_and_its_descendants() {
        let state = VaultIndicesState::default();
        let mut myne = rec("M", Some("Projects/Myne/"));
        myne.tags = vec![tag("rust", "rust")];
        state.apply("m", myne);

        let mut gathin = rec("G", Some("Projects/Gathin/"));
        gathin.tags = vec![tag("sales", "sales")];
        state.apply("g", gathin);

        let mut deep = rec("D", Some("Projects/Myne/Design/"));
        deep.tags = vec![tag("figma", "figma")];
        state.apply("d", deep);

        let mut root = rec("R", None);
        root.tags = vec![tag("inbox", "inbox")];
        state.apply("r", root);

        let scoped = state.tag_tree(Some("Projects/Myne"));
        let keys: Vec<String> = scoped.iter().map(|n| n.key.clone()).collect();
        assert_eq!(
            keys,
            vec!["figma", "rust"],
            "own folder plus descendants, sorted"
        );

        let all = state.tag_tree(None);
        assert_eq!(all.len(), 4, "no prefix keeps the whole-vault answer");

        let root_only = state.tag_tree(Some(""));
        assert_eq!(
            root_only.iter().map(|n| n.key.clone()).collect::<Vec<_>>(),
            vec!["inbox"],
            "an empty prefix is the ROOT folder, not everything"
        );
    }

    #[test]
    fn tag_tree_folder_match_is_boundary_aware() {
        let state = VaultIndicesState::default();
        let mut sibling = rec("S", Some("Projects-old/"));
        sibling.tags = vec![tag("stale", "stale")];
        state.apply("s", sibling);

        assert!(
            state.tag_tree(Some("Projects")).is_empty(),
            "`Projects` must not match `Projects-old`; a raw starts_with would"
        );
    }

    #[test]
    fn tag_tree_folder_scope_keeps_counts_within_the_scope() {
        let state = VaultIndicesState::default();
        let mut a = rec("A", Some("Work/"));
        a.tags = vec![tag("plan", "plan")];
        state.apply("a", a);
        let mut b = rec("B", Some("Home/"));
        b.tags = vec![tag("plan", "plan")];
        state.apply("b", b);

        let work = state.tag_tree(Some("Work"));
        let plan = work.iter().find(|n| n.key == "plan").expect("plan");
        assert_eq!(plan.subtree_count, 1, "one note in Work, not both");
    }
}
