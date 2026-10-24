// SPDX-License-Identifier: AGPL-3.0

//! Canonical `SavedView` schema + recursive filter AST — the single
//! contract the Saved Views epic binds to (sub-feature #3,
//! view-model-and-storage, MYND-273). See `docs/spec/protocol.md` § 9.5.2.
//!
//! A saved view is **authored content** (a hand-built filter / sort /
//! group projection over plain-markdown notes), persisted inside the
//! existing `vault.prefs` (`MYP1`) blob as a `saved_views` field — no new
//! magic, no new KEK role, no new load-bearing crypto (SYNC-6). This module
//! defines the in-memory schema and its canonical-JSON codec; the
//! `PrefsView` wiring + CRUD live in sibling slices (tasks 2–4).
//!
//! ## Lean schema (SYNC-5)
//!
//! Only the fields the query engine (#2) and the renderer (#5) actually
//! consume are persisted: `view_type` (`table`/`cards`/`list` — `map` is
//! deliberately NOT a variant; it needs a Maps plugin), `name`, a recursive
//! `filters` AST, optional `sort`, `group_by`, `columns`, `card_size`,
//! `image`, and `image_aspect_ratio`, plus a stable `id`. Obsidian-Bases
//! `formulas` / `summaries` / `properties-display` blocks are **dropped
//! entirely** — they are not representable here (no field carries them), so
//! the schema can never imply an evaluator Myne does not ship
//! (`vision.md` no-code-eval). `.base` import is therefore accepted-lossy
//! (#6's concern).
//!
//! ## Filter AST (SYNC-7 / SYNC-8 / SYNC-9)
//!
//! The `filters` AST is a CLOSED allow-list mirroring the query engine's
//! `FilterNode`: `and` / `or` / `not` combinators over the leaves `hasTag`,
//! `inFolder`, `search`, a typed `property` comparison
//! (`== != > < >= <= contains`), and the degenerate `all`. There is no
//! arithmetic / `map` / formula node — the type cannot express one, so the
//! storage layer can never round-trip an evaluatable expression. The serde
//! representation (`#[serde(tag = "kind")]`, camelCase kinds) is byte-for-byte
//! the shape the TS engine reads on the IPC path, so the renderer hands a
//! decoded `filters` straight to the engine with no AST translation.
//!
//! ## Canonical JSON (§ 9.5.2)
//!
//! The on-disk encoding is hand-rolled canonical JSON — object keys
//! lexicographically sorted, no insignificant whitespace, NFC strings,
//! integers as bare decimals, **floats FORBIDDEN**. Because Obsidian's
//! `imageAspectRatio` is a float (e.g. `1.65`), Myne carries it as a STRING
//! (`image_aspect_ratio`) so the value round-trips from `.base` without ever
//! introducing a float into the canonical form. Schema evolution within v0.1
//! is additive optional fields; an unknown future key is ignored on decode
//! (forward-compat), never a parse failure. The serde derives drive the IPC
//! (Tauri) path; this hand-rolled codec drives the byte-stable disk path —
//! the same dual-surface discipline as [`crate::prefs::PrefsView`].

use crate::canonical_json::{push_json_string as push_string, push_json_uint as push_uint};
use alloc::boxed::Box;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;

/// Maximum `filters` AST / JSON nesting depth accepted on decode. The input
/// is AEAD-authenticated and bounded by the 64 KiB `MYP1` cap, but a depth
/// guard is cheap defense-in-depth against a pathologically-nested blob
/// exhausting the recursive parser's stack. No real view nests this deep.
pub(crate) const MAX_JSON_DEPTH: usize = 64;

/// View render type. `Map` is deliberately absent — a map view needs a Maps
/// plugin and is not representable in v1 (SYNC-5). Serialized lowercase
/// (`"table"` / `"cards"` / `"list"`) on both the IPC and canonical paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ViewType {
    /// Read-only tabular grid.
    Table,
    /// Card grid (optional cover image + groupBy headers).
    Cards,
    /// Note-list rows.
    List,
}

/// Sort direction. Serialized lowercase (`"asc"` / `"desc"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    /// Ascending.
    Asc,
    /// Descending.
    Desc,
}

/// A within-group sort: a property `key` + a `direction`. Date sort operates
/// on frontmatter date properties only (SYNC-9); the engine (#2) enforces
/// that — this layer only carries the key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewSort {
    /// The property key to sort by.
    pub key: String,
    /// Ascending or descending.
    pub direction: SortDirection,
}

/// A typed property-comparison operator — the closed allow-list (no
/// arithmetic, no function calls). Serialized as its operator literal
/// (`"=="`, `">"`, …) to match the query engine's `PropertyOp` on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PropertyOp {
    /// `==`
    #[serde(rename = "==")]
    Eq,
    /// `!=`
    #[serde(rename = "!=")]
    Ne,
    /// `>`
    #[serde(rename = ">")]
    Gt,
    /// `<`
    #[serde(rename = "<")]
    Lt,
    /// `>=`
    #[serde(rename = ">=")]
    Ge,
    /// `<=`
    #[serde(rename = "<=")]
    Le,
    /// `contains` (list membership / string substring).
    #[serde(rename = "contains")]
    Contains,
}

/// The recursive filter AST — boolean combinators over a closed leaf set.
/// Mirrors the query engine's `FilterNode`. There is deliberately no
/// arithmetic / computed / `list.map` node: the type cannot express one
/// (SYNC-7 anti-eval). `#[serde(tag = "kind")]` + camelCase kinds make the
/// IPC wire shape identical to the TS union.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FilterNode {
    /// Intersection of the children's id-sets.
    And {
        /// Child nodes (AND).
        children: Vec<FilterNode>,
    },
    /// Union of the children's id-sets.
    Or {
        /// Child nodes (OR).
        children: Vec<FilterNode>,
    },
    /// Complement of the child against the live set.
    Not {
        /// The negated child.
        child: Box<FilterNode>,
    },
    /// Notes carrying tag `tag` (subtree-inclusive, SYNC-8).
    HasTag {
        /// The tag.
        tag: String,
    },
    /// Notes in folder `path` and all descendant folders (SYNC-8).
    InFolder {
        /// The folder path.
        path: String,
    },
    /// Full-text search hits for `query`.
    Search {
        /// The query string.
        query: String,
    },
    /// A typed comparison of frontmatter property `key` against `value`.
    Property {
        /// The property key.
        key: String,
        /// The comparison operator.
        op: PropertyOp,
        /// The query operand (typed against the stored value, SYNC-2).
        value: String,
    },
    /// The degenerate all-live leaf.
    All,
}

/// The canonical, persisted definition of one saved view. The single shape
/// #2 (query engine), #5 (render), and #6 (`.base` import) bind to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedView {
    /// Stable unique id (a UUIDv7 in practice; opaque to this codec).
    pub id: String,
    /// User-visible view name.
    pub name: String,
    /// Render type (`table` / `cards` / `list`).
    pub view_type: ViewType,
    /// The filter AST (an `all` leaf for an unfiltered view).
    pub filters: FilterNode,
    /// Optional within-group sort. Omitted when `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort: Option<ViewSort>,
    /// Optional groupBy property key. Omitted when `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_by: Option<String>,
    /// Ordered display columns (the `.base` `order` list). A SEQUENCE —
    /// element order is the payload (preserved verbatim, not sorted/deduped).
    /// Omitted when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub columns: Vec<String>,
    /// Optional card width in integer pixels (cards view). Omitted when `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_size: Option<u32>,
    /// Optional cover-image property name (resolved later via `attachment://`
    /// by #5, SYNC-11). Omitted when `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// Optional image aspect ratio, carried as a STRING (e.g. `"1.65"`) so
    /// the `.base` float value round-trips without a canonical-JSON float.
    /// Omitted when `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_aspect_ratio: Option<String>,

    /// Definition version: a non-negative integer, omitted when absent
    /// (`view-manifests`; `docs/spec/protocol.md` §9.5.2).
    ///
    /// The app maintains it, not the user: any local edit that changes the
    /// canonical bytes increments it. It exists so an imported manifest can be
    /// ordered against the definition this vault already holds (higher replaces,
    /// identical is a no-op, same-version-different-bytes is a refusal naming
    /// both, lower is refused), and so this device's APPROVAL can name exactly
    /// the bytes it approved. Approval is an equality against this value, which
    /// is what makes a version bump revoke it with no clear step.
    ///
    /// `None` is STORAGE compatibility and nothing else: a view authored before
    /// this field existed has no version, and §9.5.2's additive discipline says
    /// it must still decode. The import path does not tolerate it; see
    /// [`crate::view_manifest`], which refuses a manifest with no `version`,
    /// because a file whose version cannot be read cannot be ordered at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,

    /// The property keys this view's write intent covers: a sequence of
    /// frontmatter keys, omitted when empty (`view-manifests`; §9.5.2).
    ///
    /// This is the ENTIRE write authority a shared view carries. A field absent
    /// from the list may not be written through the view, and the host is what
    /// checks the list (task 5's `note_set_field`), because write authority
    /// resting on a renderer conditional is not authority at all.
    ///
    /// Two properties are load-bearing rather than incidental:
    ///
    /// - **Sequence semantics, preserved verbatim** (NFC per element, not sorted,
    ///   not deduped), the `columns` discipline. The list is a declaration and
    ///   its order carries no meaning, but keeping the author's bytes keeps the
    ///   encoding a pure function of the value handed in, which is what makes an
    ///   export then re-import byte-identical.
    /// - **The host-owned markers are not writable.** `archived`, `trashed` and
    ///   `deleted` are the frontmatter the app manages, and a view that could
    ///   write them could hide notes from its own vault. They are refused by
    ///   [`crate::view_manifest`] on the import path; this codec stores what it
    ///   is given, because the stored blob is this same array and refusing there
    ///   would fail a whole prefs parse over one view's declaration.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub write_fields: Vec<String>,
}

/// One `saved_views` array element this build cannot REPRESENT, carried
/// verbatim so a re-encode re-emits it instead of dropping it.
///
/// The motivating case is a newer client's `view_type` (`"board"`, …): the
/// array decoder cannot build a [`SavedView`] for it, and §9.5.5's
/// whole-blob fall-back-to-defaults would then treat the entire `vault.prefs`
/// as unreadable — resetting the theme, keymap and favorites alongside the one
/// view this build does not know. Worse, a prefs write is a whole-blob rewrite,
/// so that older client's next save would push the defaults back to every
/// device. Keeping the element's raw bytes turns "one unknown view type resets
/// all preferences" into "one view this build does not render".
///
/// The same carrier covers every `Unrepresentable` arm (an unknown filter
/// `kind`, an unknown comparison operator, an unknown sort direction), because
/// the failure is the same one: well-formed content from a newer client that
/// this schema cannot express. Structural damage is NOT retained — see
/// [`parse_saved_views_array_with_opaque`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OpaqueSavedView {
    /// The element's `id` when that value is a string, empty otherwise. Used
    /// only to sort the re-emitted array; §9.5.2's order is a byte sort on id.
    id: Vec<u8>,
    /// The element's exact input bytes (no surrounding whitespace), re-emitted
    /// unchanged.
    raw: Vec<u8>,
}

impl OpaqueSavedView {
    /// The id bytes this entry sorts under. Empty for an entry whose `id` is
    /// absent or not a string — such an entry is still retained (see
    /// [`parse_saved_views_array_with_opaque`]), it just sorts first.
    pub fn id_bytes(&self) -> &[u8] {
        &self.id
    }

    /// The entry's raw JSON bytes, exactly as they appeared in the input.
    pub fn raw(&self) -> &[u8] {
        &self.raw
    }
}

/// Closed failure surface for [`canonical_decode_saved_view`]. The bytes are
/// decoded only AFTER the surrounding `vault.prefs` AEAD verified, so a
/// failure here is structural (the `prefs_key` holder wrote malformed JSON),
/// not adversarial — the caller collapses it to fall-back-to-defaults
/// (§ 9.5.5).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum SavedViewParseError {
    /// The bytes are not well-formed canonical JSON (bad structure, a
    /// forbidden float, trailing junk, or over-deep nesting).
    #[error("saved view JSON is malformed")]
    Malformed,
    /// A required field (`id` / `name` / `view_type` / `filters`, or a
    /// leaf's mandatory key) is absent.
    #[error("saved view is missing a required field")]
    MissingField,
    /// A field is present but the wrong JSON type.
    #[error("saved view field has the wrong JSON type")]
    WrongType,
    /// A value outside the closed allow-list — a `map` view type, an unknown
    /// filter `kind` (e.g. a formula/arithmetic node), or an unknown
    /// comparison operator. The schema cannot represent it.
    #[error(
        "saved view carries an unrepresentable value (map / unknown filter kind / unknown op)"
    )]
    Unrepresentable,
}

// ---- canonical JSON encoder -------------------------------------------------

/// Encode one [`SavedView`] to canonical JSON bytes (§ 9.5.2): keys
/// lexicographically sorted, no insignificant whitespace, NFC strings,
/// integers bare-decimal, no floats. Deterministic for a given logical value.
pub fn canonical_encode_saved_view(view: &SavedView) -> Vec<u8> {
    let mut out = Vec::with_capacity(128);
    encode_view_into(&mut out, view);
    out
}

fn encode_view_into(out: &mut Vec<u8>, view: &SavedView) {
    // Canonical key order: card_size, columns, filters, group_by, id, image,
    // image_aspect_ratio, name, sort, version, view_type, write_fields.
    // (`version` < `view_type` on the third byte, `view_type` < `write_fields`
    // on the second.)
    out.push(b'{');
    let mut first = true;
    if let Some(cs) = view.card_size {
        sep(out, &mut first);
        out.extend_from_slice(b"\"card_size\":");
        push_uint(out, cs);
    }
    if !view.columns.is_empty() {
        sep(out, &mut first);
        out.extend_from_slice(b"\"columns\":");
        push_string_array(out, &view.columns);
    }
    sep(out, &mut first);
    out.extend_from_slice(b"\"filters\":");
    encode_filter_into(out, &view.filters);
    if let Some(ref g) = view.group_by {
        sep(out, &mut first);
        out.extend_from_slice(b"\"group_by\":");
        push_string(out, &nfc(g));
    }
    sep(out, &mut first);
    out.extend_from_slice(b"\"id\":");
    push_string(out, &nfc(&view.id));
    if let Some(ref img) = view.image {
        sep(out, &mut first);
        out.extend_from_slice(b"\"image\":");
        push_string(out, &nfc(img));
    }
    if let Some(ref ar) = view.image_aspect_ratio {
        sep(out, &mut first);
        out.extend_from_slice(b"\"image_aspect_ratio\":");
        push_string(out, &nfc(ar));
    }
    sep(out, &mut first);
    out.extend_from_slice(b"\"name\":");
    push_string(out, &nfc(&view.name));
    if let Some(ref s) = view.sort {
        sep(out, &mut first);
        out.extend_from_slice(b"\"sort\":");
        encode_sort_into(out, s);
    }
    if let Some(v) = view.version {
        sep(out, &mut first);
        out.extend_from_slice(b"\"version\":");
        push_uint(out, v);
    }
    sep(out, &mut first);
    out.extend_from_slice(b"\"view_type\":");
    push_string(out, view_type_str(view.view_type));
    if !view.write_fields.is_empty() {
        sep(out, &mut first);
        out.extend_from_slice(b"\"write_fields\":");
        push_string_array(out, &view.write_fields);
    }
    out.push(b'}');
}

/// Encode a slice of [`SavedView`] to a canonical JSON ARRAY (`[…]`), the
/// form the `saved_views` field carries inside `vault.prefs`. Elements are
/// emitted sorted by `id` so the encoding is byte-stable regardless of caller
/// order (the *display* order lives in the separate `view_order` sequence, so
/// the set's array order is free to be canonical). Ids are opaque UUIDs
/// (ASCII), so a raw byte sort is canonical. The caller omits the field
/// entirely when the slice is empty, so this never emits `[]`.
pub fn canonical_encode_saved_views(views: &[SavedView]) -> Vec<u8> {
    canonical_encode_saved_views_with_opaque(views, &[])
}

/// Encode the rendered set TOGETHER WITH the entries this build cannot
/// represent, as one canonical JSON array — the form a `vault.prefs` re-write
/// must emit, because dropping the opaque entries would delete a newer client's
/// views from the shared blob.
///
/// Ordering is §9.5.2's byte sort on `id` across BOTH kinds, so the emitted
/// array reads as one id-ordered set. An id tie between a represented and an
/// opaque entry puts the represented one first (a stable sort, so equal ids
/// within one kind keep their caller / input order), which keeps the ordering
/// total and deterministic without letting an unrepresentable entry shadow a
/// view this build does render.
pub fn canonical_encode_saved_views_with_opaque(
    views: &[SavedView],
    opaque: &[OpaqueSavedView],
) -> Vec<u8> {
    enum Entry<'a> {
        Represented(&'a SavedView),
        Opaque(&'a OpaqueSavedView),
    }
    // `rank` is the tie position, not a property of the value: 0 wins over 1.
    let mut entries: Vec<(u8, &[u8], Entry<'_>)> = Vec::with_capacity(views.len() + opaque.len());
    entries.extend(
        views
            .iter()
            .map(|v| (0u8, v.id.as_bytes(), Entry::Represented(v))),
    );
    entries.extend(
        opaque
            .iter()
            .map(|o| (1u8, o.id.as_slice(), Entry::Opaque(o))),
    );
    // Stable: equal (rank, id) pairs keep their input order, which is what the
    // rendered-only encoder did before this carrier existed.
    entries.sort_by(|a, b| a.1.cmp(b.1).then(a.0.cmp(&b.0)));

    let mut out = Vec::with_capacity(128 * entries.len().max(1));
    out.push(b'[');
    for (i, (_, _, entry)) in entries.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        match entry {
            Entry::Represented(v) => encode_view_into(&mut out, v),
            // Raw bytes, deliberately: a canonical re-serialisation would
            // require a generic encoder this codec does not have, and would
            // rewrite the very fields it cannot represent.
            Entry::Opaque(o) => out.extend_from_slice(&o.raw),
        }
    }
    out.push(b']');
    out
}

/// Parse a canonical JSON ARRAY of saved views starting at `bytes[0] == '['`,
/// returning the decoded views + the number of bytes consumed (so an embedding
/// codec — `vault.prefs` — can advance its cursor past the array). Reuses the
/// recursive [`JsonParser`] so brace/bracket balancing + string-escaping are
/// single-homed here, not re-implemented in the prefs substring decoder.
pub fn parse_saved_views_array(
    bytes: &[u8],
) -> Result<(Vec<SavedView>, usize), SavedViewParseError> {
    let mut p = JsonParser::new(bytes);
    let v = p.parse_value()?;
    let arr = match v {
        JsonValue::Array(a) => a,
        _ => return Err(SavedViewParseError::WrongType),
    };
    let mut views = Vec::with_capacity(arr.len());
    for e in &arr {
        views.push(saved_view_from_json(e)?);
    }
    Ok((views, p.i))
}

/// Parse a `saved_views` array keeping the elements this build cannot
/// represent: returns the decoded views, those elements as opaque raw entries,
/// and the bytes consumed. The `vault.prefs` codec uses THIS entry point, so a
/// single unknown `view_type` no longer drives the §9.5.5 whole-blob fall-back
/// (see [`OpaqueSavedView`]).
///
/// Only [`SavedViewParseError::Unrepresentable`] becomes an opaque entry. Every
/// other arm stays fatal: a `Malformed` element is damaged bytes rather than a
/// newer client's content, and silently retaining garbage under the banner of
/// forward-compatibility would be a weaker promise than retaining a
/// well-formed entry this schema happens not to express. An element carrying no
/// usable `id` (absent, or not a string) is still retained — it just sorts
/// first, and it is dropped only by a client that could never have shown it.
pub fn parse_saved_views_array_with_opaque(
    bytes: &[u8],
) -> Result<(Vec<SavedView>, Vec<OpaqueSavedView>, usize), SavedViewParseError> {
    let mut p = JsonParser::new(bytes);
    let elements = p.parse_top_level_array_spanned()?;
    let mut views = Vec::with_capacity(elements.len());
    let mut opaque = Vec::new();
    for (value, start, end) in &elements {
        match saved_view_from_json(value) {
            Ok(view) => views.push(view),
            Err(SavedViewParseError::Unrepresentable) => opaque.push(OpaqueSavedView {
                id: opaque_id(value),
                raw: bytes[*start..*end].to_vec(),
            }),
            Err(other) => return Err(other),
        }
    }
    Ok((views, opaque, p.consumed()))
}

/// The sort id of an element this build cannot represent: its `id` bytes when
/// that value is a string, empty otherwise. Deliberately lenient — the element
/// is already unknown, so a malformed `id` is a reason to give it an empty sort
/// key, never a reason to drop an entry we were asked to preserve verbatim.
fn opaque_id(value: &JsonValue) -> Vec<u8> {
    match value {
        JsonValue::Object(obj) => match find(obj, "id") {
            Some(JsonValue::Str(s)) => s.as_bytes().to_vec(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

fn encode_sort_into(out: &mut Vec<u8>, sort: &ViewSort) {
    // Canonical key order: direction < key.
    out.extend_from_slice(b"{\"direction\":");
    push_string(
        out,
        match sort.direction {
            SortDirection::Asc => "asc",
            SortDirection::Desc => "desc",
        },
    );
    out.extend_from_slice(b",\"key\":");
    push_string(out, &nfc(&sort.key));
    out.push(b'}');
}

pub(crate) fn encode_filter_into(out: &mut Vec<u8>, node: &FilterNode) {
    // Each variant emits its keys in lexicographic order.
    out.push(b'{');
    match node {
        FilterNode::And { children } => {
            out.extend_from_slice(b"\"children\":");
            encode_filter_array(out, children);
            out.extend_from_slice(b",\"kind\":\"and\"");
        }
        FilterNode::Or { children } => {
            out.extend_from_slice(b"\"children\":");
            encode_filter_array(out, children);
            out.extend_from_slice(b",\"kind\":\"or\"");
        }
        FilterNode::Not { child } => {
            out.extend_from_slice(b"\"child\":");
            encode_filter_into(out, child);
            out.extend_from_slice(b",\"kind\":\"not\"");
        }
        FilterNode::HasTag { tag } => {
            out.extend_from_slice(b"\"kind\":\"hasTag\",\"tag\":");
            push_string(out, &nfc(tag));
        }
        FilterNode::InFolder { path } => {
            out.extend_from_slice(b"\"kind\":\"inFolder\",\"path\":");
            push_string(out, &nfc(path));
        }
        FilterNode::Search { query } => {
            out.extend_from_slice(b"\"kind\":\"search\",\"query\":");
            push_string(out, &nfc(query));
        }
        FilterNode::Property { key, op, value } => {
            out.extend_from_slice(b"\"key\":");
            push_string(out, &nfc(key));
            out.extend_from_slice(b",\"kind\":\"property\",\"op\":");
            push_string(out, property_op_str(*op));
            out.extend_from_slice(b",\"value\":");
            push_string(out, &nfc(value));
        }
        FilterNode::All => {
            out.extend_from_slice(b"\"kind\":\"all\"");
        }
    }
    out.push(b'}');
}

fn encode_filter_array(out: &mut Vec<u8>, children: &[FilterNode]) {
    out.push(b'[');
    for (i, c) in children.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        encode_filter_into(out, c);
    }
    out.push(b']');
}

fn push_string_array(out: &mut Vec<u8>, items: &[String]) {
    out.push(b'[');
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        push_string(out, &nfc(item));
    }
    out.push(b']');
}

fn view_type_str(v: ViewType) -> &'static str {
    match v {
        ViewType::Table => "table",
        ViewType::Cards => "cards",
        ViewType::List => "list",
    }
}

fn property_op_str(op: PropertyOp) -> &'static str {
    match op {
        PropertyOp::Eq => "==",
        PropertyOp::Ne => "!=",
        PropertyOp::Gt => ">",
        PropertyOp::Lt => "<",
        PropertyOp::Ge => ">=",
        PropertyOp::Le => "<=",
        PropertyOp::Contains => "contains",
    }
}

pub(crate) fn nfc(s: &str) -> String {
    s.nfc().collect::<String>()
}

fn sep(out: &mut Vec<u8>, first: &mut bool) {
    if *first {
        *first = false;
    } else {
        out.push(b',');
    }
}

// ---- canonical JSON decoder -------------------------------------------------

/// Decode canonical-JSON bytes (the output of [`canonical_encode_saved_view`],
/// or a future-additive superset) into a [`SavedView`]. Unknown keys are
/// ignored (forward-compat); a `map` view type, an unknown filter `kind`, an
/// unknown operator, or any float is rejected. Strict on trailing bytes.
pub fn canonical_decode_saved_view(bytes: &[u8]) -> Result<SavedView, SavedViewParseError> {
    let mut p = JsonParser::new(bytes);
    let v = p.parse_value()?;
    p.skip_ws();
    if p.i != bytes.len() {
        return Err(SavedViewParseError::Malformed);
    }
    saved_view_from_json(&v)
}

/// Decode exactly one JSON value from `bytes`, refusing any non-whitespace after
/// it. The strict-entry-point counterpart of [`canonical_decode_saved_view`],
/// shared with [`crate::view_manifest`] so both "decode one object" readers
/// enforce the same trailing rule rather than each re-deriving it.
pub(crate) fn parse_exactly_one(bytes: &[u8]) -> Result<JsonValue, SavedViewParseError> {
    let mut p = JsonParser::new(bytes);
    let v = p.parse_value()?;
    p.skip_ws();
    if p.i != bytes.len() {
        return Err(SavedViewParseError::Malformed);
    }
    Ok(v)
}

/// A minimal, dependency-free JSON value tree — only what the `SavedView`
/// schema needs. Keeps the recursive AST decode out of the substring-scanning
/// idiom (infeasible for a recursive structure) without pulling `serde_json`
/// into the main dependency surface.
pub(crate) enum JsonValue {
    /// A boolean literal. `SavedView` itself has no bare-bool field (this
    /// variant existed payload-less until `color_group.rs`'s `enabled` field
    /// needed one — see [`as_bool`]).
    Bool(bool),
    Int(i64),
    Str(String),
    Array(Vec<JsonValue>),
    Object(Vec<(String, JsonValue)>),
    Null,
}

pub(crate) struct JsonParser<'a> {
    b: &'a [u8],
    i: usize,
    depth: usize,
}

impl<'a> JsonParser<'a> {
    pub(crate) fn new(b: &'a [u8]) -> Self {
        Self { b, i: 0, depth: 0 }
    }

    /// Bytes consumed so far — the cursor position an embedding codec (a
    /// sibling `vault.prefs`-embedded array family) advances past.
    pub(crate) fn consumed(&self) -> usize {
        self.i
    }

    /// Parse a top-level JSON array, returning each element's value AND its
    /// byte span in the INPUT — what a caller needs to keep an element it
    /// cannot decode verbatim, without a generic canonical serialiser (which
    /// this codec does not have, and inventing one would re-write exactly the
    /// fields the caller could not represent).
    ///
    /// A non-array top level reports [`SavedViewParseError::WrongType`] once the
    /// value parses, matching [`parse_saved_views_array`]'s pinned contract
    /// (the `saved-view` vector family pins `non-array-top-level` as
    /// `wrong_type`), while damaged bytes still report `Malformed`.
    pub(crate) fn parse_top_level_array_spanned(
        &mut self,
    ) -> Result<Vec<(JsonValue, usize, usize)>, SavedViewParseError> {
        self.skip_ws();
        if self.b.get(self.i) != Some(&b'[') {
            self.parse_value()?;
            return Err(SavedViewParseError::WrongType);
        }
        self.parse_array_spanned()
    }

    fn parse_array_spanned(
        &mut self,
    ) -> Result<Vec<(JsonValue, usize, usize)>, SavedViewParseError> {
        self.enter()?;
        self.i += 1; // consume '['
        let mut out: Vec<(JsonValue, usize, usize)> = Vec::new();
        self.skip_ws();
        if self.b.get(self.i) == Some(&b']') {
            self.i += 1;
            self.depth -= 1;
            return Ok(out);
        }
        loop {
            // The span brackets the VALUE, not the separator whitespace, so a
            // retained element re-emits without the padding a pretty-printed
            // input carried.
            self.skip_ws();
            let start = self.i;
            let val = self.parse_value()?;
            let end = self.i;
            out.push((val, start, end));
            self.skip_ws();
            match self.b.get(self.i) {
                Some(&b',') => self.i += 1,
                Some(&b']') => {
                    self.i += 1;
                    break;
                }
                _ => return Err(SavedViewParseError::Malformed),
            }
        }
        self.depth -= 1;
        Ok(out)
    }

    fn skip_ws(&mut self) {
        while matches!(self.b.get(self.i), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    pub(crate) fn parse_value(&mut self) -> Result<JsonValue, SavedViewParseError> {
        self.skip_ws();
        match self.b.get(self.i) {
            Some(b'{') => self.parse_object(),
            Some(b'[') => self.parse_array(),
            Some(b'"') => Ok(JsonValue::Str(self.parse_string()?)),
            Some(b't') | Some(b'f') => self.parse_bool(),
            Some(b'n') => self.parse_null(),
            Some(b'-') | Some(b'0'..=b'9') => self.parse_number(),
            _ => Err(SavedViewParseError::Malformed),
        }
    }

    fn enter(&mut self) -> Result<(), SavedViewParseError> {
        self.depth += 1;
        if self.depth > MAX_JSON_DEPTH {
            return Err(SavedViewParseError::Malformed);
        }
        Ok(())
    }

    fn parse_object(&mut self) -> Result<JsonValue, SavedViewParseError> {
        self.enter()?;
        self.i += 1; // consume '{'
        let mut out: Vec<(String, JsonValue)> = Vec::new();
        self.skip_ws();
        if self.b.get(self.i) == Some(&b'}') {
            self.i += 1;
            self.depth -= 1;
            return Ok(JsonValue::Object(out));
        }
        loop {
            self.skip_ws();
            if self.b.get(self.i) != Some(&b'"') {
                return Err(SavedViewParseError::Malformed);
            }
            let key = self.parse_string()?;
            self.skip_ws();
            if self.b.get(self.i) != Some(&b':') {
                return Err(SavedViewParseError::Malformed);
            }
            self.i += 1;
            let val = self.parse_value()?;
            out.push((key, val));
            self.skip_ws();
            match self.b.get(self.i) {
                Some(&b',') => self.i += 1,
                Some(&b'}') => {
                    self.i += 1;
                    break;
                }
                _ => return Err(SavedViewParseError::Malformed),
            }
        }
        self.depth -= 1;
        Ok(JsonValue::Object(out))
    }

    fn parse_array(&mut self) -> Result<JsonValue, SavedViewParseError> {
        self.enter()?;
        self.i += 1; // consume '['
        let mut out: Vec<JsonValue> = Vec::new();
        self.skip_ws();
        if self.b.get(self.i) == Some(&b']') {
            self.i += 1;
            self.depth -= 1;
            return Ok(JsonValue::Array(out));
        }
        loop {
            let val = self.parse_value()?;
            out.push(val);
            self.skip_ws();
            match self.b.get(self.i) {
                Some(&b',') => self.i += 1,
                Some(&b']') => {
                    self.i += 1;
                    break;
                }
                _ => return Err(SavedViewParseError::Malformed),
            }
        }
        self.depth -= 1;
        Ok(JsonValue::Array(out))
    }

    fn parse_string(&mut self) -> Result<String, SavedViewParseError> {
        self.i += 1; // consume opening '"'
        let mut buf: Vec<u8> = Vec::new();
        loop {
            let c = *self.b.get(self.i).ok_or(SavedViewParseError::Malformed)?;
            self.i += 1;
            match c {
                b'"' => break,
                b'\\' => {
                    let e = *self.b.get(self.i).ok_or(SavedViewParseError::Malformed)?;
                    self.i += 1;
                    match e {
                        b'"' => buf.push(b'"'),
                        b'\\' => buf.push(b'\\'),
                        b'/' => buf.push(b'/'),
                        b'b' => buf.push(0x08),
                        b'f' => buf.push(0x0c),
                        b'n' => buf.push(b'\n'),
                        b'r' => buf.push(b'\r'),
                        b't' => buf.push(b'\t'),
                        b'u' => {
                            let cp = self.parse_hex4()?;
                            let ch =
                                char::from_u32(cp as u32).ok_or(SavedViewParseError::Malformed)?;
                            let mut tmp = [0u8; 4];
                            buf.extend_from_slice(ch.encode_utf8(&mut tmp).as_bytes());
                        }
                        _ => return Err(SavedViewParseError::Malformed),
                    }
                }
                _ => buf.push(c),
            }
        }
        String::from_utf8(buf).map_err(|_| SavedViewParseError::Malformed)
    }

    fn parse_hex4(&mut self) -> Result<u16, SavedViewParseError> {
        let mut v: u16 = 0;
        for _ in 0..4 {
            let c = *self.b.get(self.i).ok_or(SavedViewParseError::Malformed)?;
            self.i += 1;
            let d = match c {
                b'0'..=b'9' => c - b'0',
                b'a'..=b'f' => c - b'a' + 10,
                b'A'..=b'F' => c - b'A' + 10,
                _ => return Err(SavedViewParseError::Malformed),
            };
            v = v * 16 + d as u16;
        }
        Ok(v)
    }

    fn parse_number(&mut self) -> Result<JsonValue, SavedViewParseError> {
        let start = self.i;
        if self.b.get(self.i) == Some(&b'-') {
            self.i += 1;
        }
        let digit_start = self.i;
        while matches!(self.b.get(self.i), Some(b'0'..=b'9')) {
            self.i += 1;
        }
        if self.i == digit_start {
            return Err(SavedViewParseError::Malformed);
        }
        // Float ban (§ 9.5.2): a fractional / exponent marker rejects.
        if matches!(self.b.get(self.i), Some(b'.') | Some(b'e') | Some(b'E')) {
            return Err(SavedViewParseError::Malformed);
        }
        let s = core::str::from_utf8(&self.b[start..self.i])
            .map_err(|_| SavedViewParseError::Malformed)?;
        let n: i64 = s.parse().map_err(|_| SavedViewParseError::Malformed)?;
        Ok(JsonValue::Int(n))
    }

    fn parse_bool(&mut self) -> Result<JsonValue, SavedViewParseError> {
        if self.b[self.i..].starts_with(b"true") {
            self.i += 4;
            Ok(JsonValue::Bool(true))
        } else if self.b[self.i..].starts_with(b"false") {
            self.i += 5;
            Ok(JsonValue::Bool(false))
        } else {
            Err(SavedViewParseError::Malformed)
        }
    }

    fn parse_null(&mut self) -> Result<JsonValue, SavedViewParseError> {
        if self.b[self.i..].starts_with(b"null") {
            self.i += 4;
            Ok(JsonValue::Null)
        } else {
            Err(SavedViewParseError::Malformed)
        }
    }
}

pub(crate) fn find<'a>(obj: &'a [(String, JsonValue)], key: &str) -> Option<&'a JsonValue> {
    obj.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

pub(crate) fn as_object(v: &JsonValue) -> Result<&[(String, JsonValue)], SavedViewParseError> {
    match v {
        JsonValue::Object(o) => Ok(o),
        _ => Err(SavedViewParseError::WrongType),
    }
}

pub(crate) fn as_str(v: &JsonValue) -> Result<&str, SavedViewParseError> {
    match v {
        JsonValue::Str(s) => Ok(s),
        _ => Err(SavedViewParseError::WrongType),
    }
}

pub(crate) fn as_bool(v: &JsonValue) -> Result<bool, SavedViewParseError> {
    match v {
        JsonValue::Bool(b) => Ok(*b),
        _ => Err(SavedViewParseError::WrongType),
    }
}

pub(crate) fn req<'a>(
    obj: &'a [(String, JsonValue)],
    key: &str,
) -> Result<&'a JsonValue, SavedViewParseError> {
    find(obj, key).ok_or(SavedViewParseError::MissingField)
}

pub(crate) fn req_string(
    obj: &[(String, JsonValue)],
    key: &str,
) -> Result<String, SavedViewParseError> {
    Ok(as_str(req(obj, key)?)?.to_string())
}

pub(crate) fn opt_string(
    obj: &[(String, JsonValue)],
    key: &str,
) -> Result<Option<String>, SavedViewParseError> {
    match find(obj, key) {
        Some(v) => Ok(Some(as_str(v)?.to_string())),
        None => Ok(None),
    }
}

pub(crate) fn saved_view_from_json(v: &JsonValue) -> Result<SavedView, SavedViewParseError> {
    let obj = as_object(v)?;

    let view_type = match as_str(req(obj, "view_type")?)? {
        "table" => ViewType::Table,
        "cards" => ViewType::Cards,
        "list" => ViewType::List,
        _ => return Err(SavedViewParseError::Unrepresentable), // `map` et al.
    };

    let card_size = match find(obj, "card_size") {
        Some(JsonValue::Int(n)) if *n >= 0 && *n <= i64::from(u32::MAX) => Some(*n as u32),
        Some(_) => return Err(SavedViewParseError::WrongType),
        None => None,
    };

    // `version` (view-manifests): a non-negative integer bounded by `u32`, and
    // OPTIONAL here on purpose: a view authored before the field existed must
    // still decode (§9.5.2 additive discipline). The import path's stricter
    // "version required" rule lives in `crate::view_manifest`, because a stored
    // view without one is readable while a FILE without one cannot be ordered
    // against anything.
    let version = match find(obj, "version") {
        Some(JsonValue::Int(n)) if *n >= 0 && *n <= i64::from(u32::MAX) => Some(*n as u32),
        Some(_) => return Err(SavedViewParseError::WrongType),
        None => None,
    };

    let columns = match find(obj, "columns") {
        Some(JsonValue::Array(a)) => a
            .iter()
            .map(|e| as_str(e).map(String::from))
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err(SavedViewParseError::WrongType),
        None => Vec::new(),
    };

    // `write_fields`: sequence semantics, stored verbatim. The reserved-marker
    // refusal is the strict reader's job (see the field's doc): the stored blob
    // is a peer's bytes and must not fail a whole parse over a declaration this
    // build would not honour.
    let write_fields = match find(obj, "write_fields") {
        Some(JsonValue::Array(a)) => a
            .iter()
            .map(|e| as_str(e).map(String::from))
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err(SavedViewParseError::WrongType),
        None => Vec::new(),
    };

    let sort = match find(obj, "sort") {
        Some(v) => Some(sort_from_json(v)?),
        None => None,
    };

    Ok(SavedView {
        id: req_string(obj, "id")?,
        name: req_string(obj, "name")?,
        view_type,
        filters: filter_from_json(req(obj, "filters")?, 0)?,
        sort,
        group_by: opt_string(obj, "group_by")?,
        columns,
        card_size,
        image: opt_string(obj, "image")?,
        image_aspect_ratio: opt_string(obj, "image_aspect_ratio")?,
        version,
        write_fields,
    })
}

fn sort_from_json(v: &JsonValue) -> Result<ViewSort, SavedViewParseError> {
    let obj = as_object(v)?;
    let direction = match as_str(req(obj, "direction")?)? {
        "asc" => SortDirection::Asc,
        "desc" => SortDirection::Desc,
        _ => return Err(SavedViewParseError::Unrepresentable),
    };
    Ok(ViewSort {
        key: req_string(obj, "key")?,
        direction,
    })
}

pub(crate) fn filter_from_json(
    v: &JsonValue,
    depth: usize,
) -> Result<FilterNode, SavedViewParseError> {
    if depth > MAX_JSON_DEPTH {
        return Err(SavedViewParseError::Malformed);
    }
    let obj = as_object(v)?;
    match as_str(req(obj, "kind")?)? {
        "all" => Ok(FilterNode::All),
        "hasTag" => Ok(FilterNode::HasTag {
            tag: req_string(obj, "tag")?,
        }),
        "inFolder" => Ok(FilterNode::InFolder {
            path: req_string(obj, "path")?,
        }),
        "search" => Ok(FilterNode::Search {
            query: req_string(obj, "query")?,
        }),
        "property" => Ok(FilterNode::Property {
            key: req_string(obj, "key")?,
            op: property_op_from_str(as_str(req(obj, "op")?)?)?,
            value: req_string(obj, "value")?,
        }),
        "and" => Ok(FilterNode::And {
            children: filter_children(obj, depth)?,
        }),
        "or" => Ok(FilterNode::Or {
            children: filter_children(obj, depth)?,
        }),
        "not" => Ok(FilterNode::Not {
            child: Box::new(filter_from_json(req(obj, "child")?, depth + 1)?),
        }),
        _ => Err(SavedViewParseError::Unrepresentable), // arithmetic / formula / map node
    }
}

fn filter_children(
    obj: &[(String, JsonValue)],
    depth: usize,
) -> Result<Vec<FilterNode>, SavedViewParseError> {
    match req(obj, "children")? {
        JsonValue::Array(a) => a
            .iter()
            .map(|c| filter_from_json(c, depth + 1))
            .collect::<Result<Vec<_>, _>>(),
        _ => Err(SavedViewParseError::WrongType),
    }
}

fn property_op_from_str(s: &str) -> Result<PropertyOp, SavedViewParseError> {
    Ok(match s {
        "==" => PropertyOp::Eq,
        "!=" => PropertyOp::Ne,
        ">" => PropertyOp::Gt,
        "<" => PropertyOp::Lt,
        ">=" => PropertyOp::Ge,
        "<=" => PropertyOp::Le,
        "contains" => PropertyOp::Contains,
        _ => return Err(SavedViewParseError::Unrepresentable),
    })
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::test_vector_fmt::{hex_lower, json_escape};
    use alloc::vec;

    fn sample() -> SavedView {
        SavedView {
            id: "v1".into(),
            name: "Books".into(),
            view_type: ViewType::Cards,
            filters: FilterNode::And {
                children: vec![
                    FilterNode::InFolder {
                        path: "Books/".into(),
                    },
                    FilterNode::Property {
                        key: "rating".into(),
                        op: PropertyOp::Gt,
                        value: "4".into(),
                    },
                ],
            },
            sort: Some(ViewSort {
                key: "finished".into(),
                direction: SortDirection::Desc,
            }),
            group_by: Some("status".into()),
            columns: vec!["author".into(), "rating".into()],
            card_size: Some(300),
            image: Some("image".into()),
            image_aspect_ratio: Some("1.65".into()),
            version: None,
            write_fields: Vec::new(),
        }
    }

    #[test]
    fn canonical_bytes_are_stable() {
        let bytes = canonical_encode_saved_view(&sample());
        let expected = concat!(
            "{\"card_size\":300,",
            "\"columns\":[\"author\",\"rating\"],",
            "\"filters\":{\"children\":[",
            "{\"kind\":\"inFolder\",\"path\":\"Books/\"},",
            "{\"key\":\"rating\",\"kind\":\"property\",\"op\":\">\",\"value\":\"4\"}",
            "],\"kind\":\"and\"},",
            "\"group_by\":\"status\",",
            "\"id\":\"v1\",",
            "\"image\":\"image\",",
            "\"image_aspect_ratio\":\"1.65\",",
            "\"name\":\"Books\",",
            "\"sort\":{\"direction\":\"desc\",\"key\":\"finished\"},",
            "\"view_type\":\"cards\"}"
        );
        assert_eq!(core::str::from_utf8(&bytes).unwrap(), expected);
    }

    #[test]
    fn round_trips_full_view() {
        let v = sample();
        let decoded = canonical_decode_saved_view(&canonical_encode_saved_view(&v)).unwrap();
        assert_eq!(decoded, v);
    }

    #[test]
    fn round_trips_minimal_view() {
        let v = SavedView {
            id: "x".into(),
            name: "All".into(),
            view_type: ViewType::Table,
            filters: FilterNode::All,
            sort: None,
            group_by: None,
            columns: Vec::new(),
            card_size: None,
            image: None,
            image_aspect_ratio: None,
            version: None,
            write_fields: Vec::new(),
        };
        let bytes = canonical_encode_saved_view(&v);
        assert_eq!(
            core::str::from_utf8(&bytes).unwrap(),
            "{\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"All\",\"view_type\":\"table\"}"
        );
        assert_eq!(canonical_decode_saved_view(&bytes).unwrap(), v);
    }

    #[test]
    fn nested_and_or_not_round_trip() {
        let v = SavedView {
            id: "n".into(),
            name: "Nested".into(),
            view_type: ViewType::List,
            filters: FilterNode::Or {
                children: vec![
                    FilterNode::Not {
                        child: Box::new(FilterNode::HasTag {
                            tag: "draft".into(),
                        }),
                    },
                    FilterNode::And {
                        children: vec![
                            FilterNode::Search {
                                query: "rust".into(),
                            },
                            FilterNode::Property {
                                key: "done".into(),
                                op: PropertyOp::Eq,
                                value: "true".into(),
                            },
                        ],
                    },
                ],
            },
            sort: None,
            group_by: None,
            columns: Vec::new(),
            card_size: None,
            image: None,
            image_aspect_ratio: None,
            version: None,
            write_fields: Vec::new(),
        };
        let decoded = canonical_decode_saved_view(&canonical_encode_saved_view(&v)).unwrap();
        assert_eq!(decoded, v);
    }

    #[test]
    fn all_property_ops_round_trip() {
        for op in [
            PropertyOp::Eq,
            PropertyOp::Ne,
            PropertyOp::Gt,
            PropertyOp::Lt,
            PropertyOp::Ge,
            PropertyOp::Le,
            PropertyOp::Contains,
        ] {
            let v = SavedView {
                id: "o".into(),
                name: "Op".into(),
                view_type: ViewType::Table,
                filters: FilterNode::Property {
                    key: "k".into(),
                    op,
                    value: "x".into(),
                },
                sort: None,
                group_by: None,
                columns: Vec::new(),
                card_size: None,
                image: None,
                image_aspect_ratio: None,
                version: None,
                write_fields: Vec::new(),
            };
            assert_eq!(
                canonical_decode_saved_view(&canonical_encode_saved_view(&v)).unwrap(),
                v
            );
        }
    }

    #[test]
    fn float_is_rejected() {
        // card_size with a fractional value — the canonical encoder never
        // emits this, but a tampered-but-AEAD-OK blob might.
        let bad = b"{\"card_size\":1.5,\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::Malformed)
        );
    }

    #[test]
    fn map_view_type_not_representable() {
        let bad =
            b"{\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"map\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::Unrepresentable)
        );
    }

    #[test]
    fn unknown_filter_kind_not_representable() {
        // A formula / arithmetic node is not in the allow-list.
        let bad = b"{\"filters\":{\"kind\":\"multiply\",\"left\":\"a\",\"right\":\"b\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::Unrepresentable)
        );
    }

    #[test]
    fn formulas_summaries_dropped_on_decode() {
        // A `.base`-style blob with formulas/summaries decodes (they are
        // unknown keys), and re-encoding omits them — the schema can't carry
        // them, so they are not round-trippable.
        let with_extras = b"{\"filters\":{\"kind\":\"all\"},\"formulas\":[\"a+b\"],\"id\":\"x\",\"name\":\"n\",\"summaries\":{\"x\":\"sum\"},\"view_type\":\"table\"}";
        let decoded = canonical_decode_saved_view(with_extras).unwrap();
        let reencoded = canonical_encode_saved_view(&decoded);
        let s = core::str::from_utf8(&reencoded).unwrap();
        assert!(!s.contains("formulas"));
        assert!(!s.contains("summaries"));
    }

    #[test]
    fn unknown_future_key_tolerated() {
        let with_future = b"{\"filters\":{\"kind\":\"all\"},\"future_key\":\"x\",\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        let decoded = canonical_decode_saved_view(with_future).unwrap();
        assert_eq!(decoded.id, "x");
        assert_eq!(decoded.view_type, ViewType::Table);
    }

    #[test]
    fn trailing_bytes_rejected() {
        let bad =
            b"{\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}X";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::Malformed)
        );
    }

    #[test]
    fn missing_required_field_rejected() {
        let bad = b"{\"filters\":{\"kind\":\"all\"},\"name\":\"n\",\"view_type\":\"table\"}"; // no id
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::MissingField)
        );
    }

    #[test]
    fn nfc_normalizes_strings_on_encode() {
        // "é" as U+0065 U+0301 (decomposed) normalizes to U+00E9 (composed).
        let v = SavedView {
            id: "x".into(),
            name: "e\u{0301}".into(),
            view_type: ViewType::Table,
            filters: FilterNode::All,
            sort: None,
            group_by: None,
            columns: Vec::new(),
            card_size: None,
            image: None,
            image_aspect_ratio: None,
            version: None,
            write_fields: Vec::new(),
        };
        let decoded = canonical_decode_saved_view(&canonical_encode_saved_view(&v)).unwrap();
        assert_eq!(decoded.name, "\u{00e9}");
    }

    #[test]
    fn ipc_serde_shape_matches_ts_filter_union() {
        // The serde (IPC) wire shape must equal the TS FilterNode the engine
        // reads: `{"kind":"property","key":..,"op":"==","value":..}`.
        let node = FilterNode::Property {
            key: "rating".into(),
            op: PropertyOp::Ge,
            value: "4".into(),
        };
        let json = serde_json::to_string(&node).unwrap();
        assert!(json.contains("\"kind\":\"property\""));
        assert!(json.contains("\"op\":\">=\""));
        let back: FilterNode = serde_json::from_str(&json).unwrap();
        assert_eq!(back, node);

        let tag = FilterNode::HasTag { tag: "x".into() };
        assert_eq!(
            serde_json::to_string(&tag).unwrap(),
            "{\"kind\":\"hasTag\",\"tag\":\"x\"}"
        );
    }

    // ---- parse_saved_views_array (the prefs-embedding entry point) ----

    #[test]
    fn parse_saved_views_array_round_trips_and_reports_consumed_len() {
        let a = sample();
        let b = SavedView {
            id: "v0".into(), // sorts before "v1"
            name: "Other".into(),
            view_type: ViewType::List,
            filters: FilterNode::All,
            sort: None,
            group_by: None,
            columns: Vec::new(),
            card_size: None,
            image: None,
            image_aspect_ratio: None,
            version: None,
            write_fields: Vec::new(),
        };
        let bytes = canonical_encode_saved_views(&[a.clone(), b.clone()]);
        let (views, consumed) = parse_saved_views_array(&bytes).unwrap();
        // Encoded sorted by id: v0 before v1.
        assert_eq!(views.len(), 2);
        assert_eq!(views[0].id, "v0");
        assert_eq!(views[1], a);
        // The cursor consumed exactly the array bytes (prefs decoder relies
        // on this to advance past the embedded array).
        assert_eq!(consumed, bytes.len());
    }

    #[test]
    fn parse_saved_views_array_rejects_non_array_top_level() {
        // A top-level object where an array is required → WrongType (line 340).
        let bad =
            b"{\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        assert_eq!(
            parse_saved_views_array(bad),
            Err(SavedViewParseError::WrongType)
        );
    }

    #[test]
    fn parse_saved_views_array_consumes_only_the_array_when_trailing_present() {
        // The array entry point is NOT strict-on-trailing (the prefs decoder
        // continues past it), so trailing bytes are left for the caller and
        // reflected in `consumed`.
        let bytes = canonical_encode_saved_views(&[sample()]);
        let mut with_trailing = bytes.clone();
        with_trailing.extend_from_slice(b",\"x\"");
        let (views, consumed) = parse_saved_views_array(&with_trailing).unwrap();
        assert_eq!(views.len(), 1);
        assert_eq!(consumed, bytes.len());
    }

    // ---- opaque (unrepresentable) entries retained verbatim --------------
    //
    // §9.5.2 / §9.5.5: an array element from a NEWER client (an unknown
    // `view_type`, an unknown filter kind, …) must not drive the whole-blob
    // fall-back-to-defaults, because a prefs write rewrites the whole blob and
    // would push those defaults to every device.

    fn opaque_aware_round_trip(input: &[u8]) -> Vec<u8> {
        let (views, opaque, _consumed) =
            parse_saved_views_array_with_opaque(input).expect("opaque-aware parse");
        canonical_encode_saved_views_with_opaque(&views, &opaque)
    }

    #[test]
    fn unknown_view_type_is_retained_verbatim() {
        // One `view_type: "board"` entry beside a represented one: the decode
        // succeeds (it used to be Unrepresentable → the prefs codec's
        // PlaintextParseFailed → every preference reset to its default), and
        // the re-encode reproduces the input bytes exactly.
        let input = concat!(
            "[{\"filters\":{\"kind\":\"all\"},\"id\":\"a\",\"name\":\"Cards\",",
            "\"view_type\":\"cards\"},",
            "{\"filters\":{\"kind\":\"all\"},\"id\":\"b\",\"name\":\"Board\",",
            "\"view_type\":\"board\"}]"
        )
        .as_bytes();
        let (views, opaque, consumed) = parse_saved_views_array_with_opaque(input).unwrap();
        assert_eq!(consumed, input.len());
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].id, "a");
        assert_eq!(opaque.len(), 1);
        assert_eq!(opaque[0].id_bytes(), b"b");
        let encoded = canonical_encode_saved_views_with_opaque(&views, &opaque);
        assert_eq!(encoded, input);
    }

    #[test]
    fn opaque_entry_sorts_by_id_among_the_represented_ones() {
        // Input order is NOT canonical (the board entry's id sorts after the
        // cards entry's). Both kinds share §9.5.2's byte sort on id, so the
        // re-encode interleaves them rather than appending the raw tail.
        let input = concat!(
            "[{\"filters\":{\"kind\":\"all\"},\"id\":\"b\",\"name\":\"Board\",",
            "\"view_type\":\"board\"},",
            "{\"filters\":{\"kind\":\"all\"},\"id\":\"a\",\"name\":\"Cards\",",
            "\"view_type\":\"cards\"}]"
        )
        .as_bytes();
        let encoded = opaque_aware_round_trip(input);
        let expected = concat!(
            "[{\"filters\":{\"kind\":\"all\"},\"id\":\"a\",\"name\":\"Cards\",",
            "\"view_type\":\"cards\"},",
            "{\"filters\":{\"kind\":\"all\"},\"id\":\"b\",\"name\":\"Board\",",
            "\"view_type\":\"board\"}]"
        );
        assert_eq!(core::str::from_utf8(&encoded).unwrap(), expected);
    }

    #[test]
    fn opaque_entry_with_malformed_id_is_retained() {
        // An unknown entry whose `id` is not a string is still retained: the
        // id is read leniently (empty sort key) rather than as a reason to drop
        // content this build cannot represent.
        let input = b"[{\"id\":7,\"name\":\"Board\",\"view_type\":\"board\"}]";
        let (views, opaque, _) = parse_saved_views_array_with_opaque(input).unwrap();
        assert!(views.is_empty());
        assert_eq!(opaque.len(), 1);
        assert_eq!(opaque[0].id_bytes(), b"");
        assert_eq!(opaque[0].raw(), &input[1..input.len() - 1]);
        assert_eq!(opaque_aware_round_trip(input), input);
    }

    #[test]
    fn unknown_filter_kind_is_retained_not_fatal() {
        // The fix is general, not board-specific: any Unrepresentable element
        // (here a formula node the anti-eval AST cannot express) is kept.
        let input = b"[{\"filters\":{\"kind\":\"formula\",\"expr\":\"x+1\"},\"id\":\"f\",\"name\":\"F\",\"view_type\":\"table\"}]";
        let (views, opaque, _) = parse_saved_views_array_with_opaque(input).unwrap();
        assert!(views.is_empty());
        assert_eq!(opaque.len(), 1);
        assert_eq!(opaque[0].id_bytes(), b"f");
        assert_eq!(opaque_aware_round_trip(input), input);
    }

    #[test]
    fn structurally_damaged_or_wrong_type_entry_stays_fatal() {
        // Retaining a well-formed entry from a newer client is a different
        // promise from retaining garbage: Malformed and WrongType stay fatal.
        assert_eq!(
            parse_saved_views_array_with_opaque(
                b"[{\"filters\":{\"kind\":\"all\"},\"id\":7,\"name\":\"n\",\"view_type\":\"table\"}]"
            ),
            Err(SavedViewParseError::WrongType)
        );
        assert_eq!(
            parse_saved_views_array_with_opaque(
                b"[{\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\""
            ),
            Err(SavedViewParseError::Malformed)
        );
        // A non-array top level keeps the strict entry point's WrongType,
        // which the `saved-view` vector family pins.
        assert_eq!(
            parse_saved_views_array_with_opaque(
                b"{\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}"
            ),
            Err(SavedViewParseError::WrongType)
        );
    }

    #[test]
    fn strict_entry_point_still_rejects_unknown_view_type() {
        // `parse_saved_views_array` is unchanged on purpose: the `saved-view`
        // vector family pins `map-view-type` as an `unrepresentable`
        // `parse_fail`, and a caller that only wants the rendered set must not
        // silently receive a shorter list.
        let input = b"[{\"filters\":{\"kind\":\"all\"},\"id\":\"b\",\"name\":\"B\",\"view_type\":\"board\"}]";
        assert_eq!(
            parse_saved_views_array(input),
            Err(SavedViewParseError::Unrepresentable)
        );
    }

    #[test]
    fn pre_feature_array_is_byte_identical_through_the_opaque_aware_codec() {
        // No opaque entry → the opaque-aware pair must emit exactly what the
        // rendered-only pair emits, so existing vault.prefs goldens do not move.
        let input = b"[{\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}]";
        let (views, opaque, _) = parse_saved_views_array_with_opaque(input).unwrap();
        assert!(opaque.is_empty());
        assert_eq!(
            canonical_encode_saved_views_with_opaque(&views, &opaque),
            input
        );
        assert_eq!(canonical_encode_saved_views(&views), input);
    }

    #[test]
    fn decode_tolerates_insignificant_whitespace() {
        // The decoder accepts pretty-printed JSON (skip_ws across object,
        // array, and value positions) even though the encoder never emits it.
        let pretty = b"  {\n  \"filters\" : { \"kind\" : \"all\" } ,\n  \"id\" : \"x\" ,\n  \"name\" : \"n\" ,\n  \"view_type\" : \"table\"\n}  ";
        let decoded = canonical_decode_saved_view(pretty).expect("decode with whitespace");
        assert_eq!(decoded.id, "x");
        assert_eq!(decoded.view_type, ViewType::Table);
    }

    #[test]
    fn decode_tolerates_whitespace_in_arrays() {
        // skip_ws inside parse_array's element/terminator scan.
        let pretty =
            b"{\"columns\":[ \"a\" , \"b\" ],\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        let decoded = canonical_decode_saved_view(pretty).expect("decode array ws");
        assert_eq!(decoded.columns, vec!["a".to_string(), "b".to_string()]);
    }

    // ---- string-escape decode branches (parse_string / parse_hex4) ----

    #[test]
    fn decode_parses_all_string_escapes() {
        // \" \\ \/ \b \f \n \r \t plus a \u escape — every parse_string arm.
        let bad = br#"{"filters":{"kind":"all"},"id":"x","name":"\"\\\/\b\f\n\r\tA","view_type":"table"}"#;
        let decoded = canonical_decode_saved_view(bad).expect("decode escapes");
        assert_eq!(decoded.name, "\"\\/\u{08}\u{0c}\n\r\tA");
    }

    #[test]
    fn decode_parses_uppercase_unicode_escape() {
        // parse_hex4 accepts A-F (line 642). é → 'é'.
        let pt = br#"{"filters":{"kind":"all"},"id":"x","name":"\u00E9","view_type":"table"}"#;
        let decoded = canonical_decode_saved_view(pt).expect("decode uppercase hex");
        assert_eq!(decoded.name, "\u{00e9}");
    }

    #[test]
    fn decode_rejects_unknown_string_escape() {
        let bad = br#"{"filters":{"kind":"all"},"id":"x","name":"\q","view_type":"table"}"#;
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::Malformed)
        );
    }

    #[test]
    fn decode_rejects_non_hex_unicode_escape() {
        // parse_hex4's non-hex arm (line 643).
        let bad = br#"{"filters":{"kind":"all"},"id":"x","name":"\uZZZZ","view_type":"table"}"#;
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::Malformed)
        );
    }

    #[test]
    fn decode_rejects_surrogate_unicode_escape() {
        // \ud800 is a lone surrogate → char::from_u32 None (line 621).
        let bad = br#"{"filters":{"kind":"all"},"id":"x","name":"\ud800","view_type":"table"}"#;
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::Malformed)
        );
    }

    #[test]
    fn decode_rejects_unterminated_string() {
        // EOF inside a string → parse_string's `ok_or` (line 602).
        let bad = br#"{"filters":{"kind":"all"},"id":"x","name":"unterminated"#;
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::Malformed)
        );
    }

    // ---- number-parse branches (parse_number) ----

    #[test]
    fn decode_rejects_lone_minus_sign() {
        // `-` with no digits → digit_start == i (line 659).
        let bad = b"{\"card_size\":-,\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::Malformed)
        );
    }

    #[test]
    fn decode_rejects_exponent_notation() {
        // `1e3` carries an exponent marker → float ban (line 663).
        let bad = b"{\"card_size\":1e3,\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::Malformed)
        );
    }

    #[test]
    fn decode_rejects_negative_card_size() {
        // A negative integer parses as JsonValue::Int(-1) but card_size's
        // range check (n >= 0) rejects it as WrongType (line 745).
        let bad = b"{\"card_size\":-1,\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::WrongType)
        );
    }

    #[test]
    fn decode_rejects_card_size_above_u32_max() {
        // i64 value above u32::MAX fails the upper range bound (line 744).
        let bad = b"{\"card_size\":4294967296,\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::WrongType)
        );
    }

    #[test]
    fn decode_accepts_negative_integer_in_unknown_field() {
        // A negative integer in an ignored future field parses (exercises the
        // `-` branch of parse_number) and is then dropped.
        let pt = b"{\"filters\":{\"kind\":\"all\"},\"future\":-42,\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        let decoded = canonical_decode_saved_view(pt).expect("decode negative unknown");
        assert_eq!(decoded.id, "x");
    }

    // ---- bool / null literal branches ----

    #[test]
    fn decode_tolerates_bool_and_null_in_unknown_fields() {
        // true / false / null all reach parse_bool / parse_null and are
        // accepted-but-dropped as unknown future keys.
        let pt = b"{\"a\":true,\"b\":false,\"c\":null,\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        let decoded = canonical_decode_saved_view(pt).expect("decode bool/null");
        assert_eq!(decoded.id, "x");
    }

    #[test]
    fn decode_rejects_malformed_bool_literal() {
        // `tru` is not `true` → parse_bool's else arm (line 680).
        let bad = b"{\"a\":tru,\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::Malformed)
        );
    }

    #[test]
    fn decode_rejects_malformed_null_literal() {
        // `nul` is not `null` → parse_null's else arm (line 689).
        let bad = b"{\"a\":nul,\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::Malformed)
        );
    }

    #[test]
    fn decode_rejects_bare_garbage_value() {
        // A value starting with an unrecognized byte → parse_value's catch-all
        // (line 522).
        let bad = b"{\"a\":@,\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::Malformed)
        );
    }

    // ---- structural-separator rejects ----

    #[test]
    fn decode_rejects_missing_colon_after_key() {
        let bad = b"{\"id\" \"x\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::Malformed)
        );
    }

    #[test]
    fn decode_rejects_non_string_object_key() {
        // An object key that isn't a string (line 547).
        let bad = b"{1:\"x\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::Malformed)
        );
    }

    #[test]
    fn decode_rejects_bad_object_terminator() {
        // After a member, neither `,` nor `}` (line 564).
        let bad = b"{\"id\":\"x\" \"name\":\"n\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::Malformed)
        );
    }

    #[test]
    fn decode_rejects_bad_array_terminator() {
        // Inside columns, elements not comma/bracket-separated (line 591).
        let bad =
            b"{\"columns\":[\"a\" \"b\"],\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::Malformed)
        );
    }

    #[test]
    fn decode_accepts_empty_array_columns() {
        // The `[]` fast path in parse_array (line 577) — an empty columns
        // array decodes to an empty Vec.
        let pt =
            b"{\"columns\":[],\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        let decoded = canonical_decode_saved_view(pt).expect("decode empty array");
        assert!(decoded.columns.is_empty());
    }

    #[test]
    fn decode_rejects_empty_input() {
        // No value at all → parse_value sees None (line 522).
        assert_eq!(
            canonical_decode_saved_view(b""),
            Err(SavedViewParseError::Malformed)
        );
    }

    // ---- typed-decode WrongType / Unrepresentable / MissingField paths ----

    #[test]
    fn decode_rejects_non_object_top_level() {
        // A top-level array where a view object is required → as_object
        // WrongType (line 701).
        assert_eq!(
            canonical_decode_saved_view(b"[]"),
            Err(SavedViewParseError::WrongType)
        );
    }

    #[test]
    fn decode_rejects_non_string_name() {
        // `name` present but an integer → as_str WrongType (line 708).
        let bad =
            b"{\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":5,\"view_type\":\"table\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::WrongType)
        );
    }

    #[test]
    fn decode_rejects_columns_not_array() {
        // `columns` present but a string → WrongType (line 754).
        let bad =
            b"{\"columns\":\"nope\",\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::WrongType)
        );
    }

    #[test]
    fn decode_rejects_columns_with_non_string_element() {
        // A non-string column element → as_str WrongType inside the map.
        let bad =
            b"{\"columns\":[1],\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::WrongType)
        );
    }

    #[test]
    fn decode_rejects_unknown_sort_direction() {
        // sort.direction outside {asc,desc} → Unrepresentable (line 782).
        let bad = b"{\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"sort\":{\"direction\":\"sideways\",\"key\":\"k\"},\"view_type\":\"table\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::Unrepresentable)
        );
    }

    #[test]
    fn decode_rejects_sort_missing_key() {
        // sort object without `key` → MissingField via req_string.
        let bad = b"{\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"sort\":{\"direction\":\"asc\"},\"view_type\":\"table\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::MissingField)
        );
    }

    #[test]
    fn sort_round_trips_through_encode_decode() {
        // Drive encode_sort_into (line 355) + sort_from_json together.
        let v = SavedView {
            id: "s".into(),
            name: "Sorted".into(),
            view_type: ViewType::Table,
            filters: FilterNode::All,
            sort: Some(ViewSort {
                key: "created".into(),
                direction: SortDirection::Asc,
            }),
            group_by: None,
            columns: Vec::new(),
            card_size: None,
            image: None,
            image_aspect_ratio: None,
            version: None,
            write_fields: Vec::new(),
        };
        let decoded = canonical_decode_saved_view(&canonical_encode_saved_view(&v)).unwrap();
        assert_eq!(decoded.sort, v.sort);
    }

    #[test]
    fn decode_rejects_unknown_property_op() {
        // A property leaf with an operator outside the allow-list →
        // Unrepresentable via property_op_from_str (line 846).
        let bad = b"{\"filters\":{\"key\":\"k\",\"kind\":\"property\",\"op\":\"~=\",\"value\":\"v\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::Unrepresentable)
        );
    }

    #[test]
    fn decode_rejects_filter_children_not_array() {
        // `and` whose `children` is not an array → filter_children WrongType
        // (line 833).
        let bad = b"{\"filters\":{\"children\":\"nope\",\"kind\":\"and\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::WrongType)
        );
    }

    #[test]
    fn decode_rejects_property_missing_op() {
        // property leaf missing `op` → MissingField.
        let bad = b"{\"filters\":{\"key\":\"k\",\"kind\":\"property\",\"value\":\"v\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::MissingField)
        );
    }

    #[test]
    fn decode_rejects_filter_node_not_object() {
        // A filter node that is a string, not an object → as_object WrongType.
        let bad = b"{\"filters\":\"all\",\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::WrongType)
        );
    }

    #[test]
    fn decode_rejects_filter_missing_kind() {
        // A filter object with no `kind` → MissingField via req.
        let bad =
            b"{\"filters\":{\"tag\":\"x\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}";
        assert_eq!(
            canonical_decode_saved_view(bad),
            Err(SavedViewParseError::MissingField)
        );
    }

    // ---- recursion-depth guard ----

    #[test]
    fn decode_rejects_overdeep_filter_nesting() {
        // Build a `not` chain deeper than MAX_JSON_DEPTH. The JSON-tree depth
        // guard (parse_object enter) fires first — either way the result is a
        // rejected, not a stack overflow.
        let mut inner = String::from("{\"kind\":\"all\"}");
        for _ in 0..(MAX_JSON_DEPTH + 5) {
            inner = alloc::format!("{{\"child\":{inner},\"kind\":\"not\"}}");
        }
        let blob = alloc::format!(
            "{{\"filters\":{inner},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}}"
        );
        assert!(canonical_decode_saved_view(blob.as_bytes()).is_err());
    }

    #[test]
    fn decode_accepts_moderately_nested_filter() {
        // A `not` nesting well under the depth cap must still decode — guards
        // against an off-by-one that would reject legal views.
        let mut node = FilterNode::All;
        for _ in 0..8 {
            node = FilterNode::Not {
                child: Box::new(node),
            };
        }
        let v = SavedView {
            id: "deep".into(),
            name: "Deep".into(),
            view_type: ViewType::Table,
            filters: node.clone(),
            sort: None,
            group_by: None,
            columns: Vec::new(),
            card_size: None,
            image: None,
            image_aspect_ratio: None,
            version: None,
            write_fields: Vec::new(),
        };
        let decoded = canonical_decode_saved_view(&canonical_encode_saved_view(&v)).unwrap();
        assert_eq!(decoded.filters, node);
    }

    // ---- multi-view array encode is sorted + byte-stable ----

    #[test]
    fn encode_saved_views_array_is_sorted_by_id() {
        let mk = |id: &str| SavedView {
            id: id.into(),
            name: "n".into(),
            view_type: ViewType::Table,
            filters: FilterNode::All,
            sort: None,
            group_by: None,
            columns: Vec::new(),
            card_size: None,
            image: None,
            image_aspect_ratio: None,
            version: None,
            write_fields: Vec::new(),
        };
        let forward = canonical_encode_saved_views(&[mk("a"), mk("b"), mk("c")]);
        let shuffled = canonical_encode_saved_views(&[mk("c"), mk("a"), mk("b")]);
        // Insertion order does not affect the canonical bytes.
        assert_eq!(forward, shuffled);
        // First id in the array is the lexicographically smallest.
        let s = core::str::from_utf8(&forward).unwrap();
        assert!(s.find("\"id\":\"a\"").unwrap() < s.find("\"id\":\"b\"").unwrap());
    }

    // ---- KAT vector regenerator (companion repo) ----------------------

    /// Maps a [`SavedViewParseError`] variant to its stable vector string
    /// (lowercase snake_case). The runner in `protocol/tests/vectors.rs` carries
    /// the same map; the two must move in lockstep.
    fn vector_error_str(e: &SavedViewParseError) -> &'static str {
        match e {
            SavedViewParseError::Malformed => "malformed",
            SavedViewParseError::MissingField => "missing_field",
            SavedViewParseError::WrongType => "wrong_type",
            SavedViewParseError::Unrepresentable => "unrepresentable",
            // No catch-all: `#[non_exhaustive]` does not apply within the
            // defining crate, so this match stays exhaustive. A new variant
            // breaks the build here — the deliberate reminder to extend the
            // schema enum + the runner map in lockstep.
        }
    }

    /// Emits the full `cases.json` for
    /// `myne-test-vectors/vectors/saved-view/v0.1/cases.json` to
    /// `/tmp/myne_saved_view_vectors.json`, ready to copy verbatim.
    ///
    /// `#[ignore]` because regenerating vectors is a deliberate act. Run with:
    /// `cargo test -p protocol --lib emit_saved_view_vectors_for_paste -- --ignored`
    ///
    /// Pins `parse_saved_views_array` — the prefs-embedding decoder for the
    /// `saved_views` field (§9.5.2). Each `parse_ok` case pins the decoded
    /// view-set as its canonical re-encoding (`canonical_encode_saved_views`,
    /// which captures NFC folding + canonical key order + id-sort) plus the
    /// exact `consumed` byte count (the cursor contract embedding codecs rely
    /// on). Each `parse_fail` case pins the closed error surface.
    #[test]
    #[ignore]
    fn emit_saved_view_vectors_for_paste() {
        extern crate std;

        let mut dump = String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"saved-view\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §9.5.2 (saved_views canonical JSON inside vault.prefs)\",\n");
        dump.push_str("  \"description\": \"Pins protocol::saved_view::parse_saved_views_array — the canonical-JSON decoder for the saved_views array embedded in vault.prefs (MYND-271, Saved Views). parse_ok cases pin the decoded view-set as its canonical re-encoding (NFC folding + lexicographic key order + id-sort) plus the exact consumed byte count (the cursor-advance contract the prefs decoder relies on); parse_fail cases pin the closed error surface (malformed / missing_field / wrong_type / unrepresentable — the last covers map view-type, unknown filter kind, unknown operator). Cases generated by `cargo test -p protocol --lib emit_saved_view_vectors_for_paste -- --ignored`.\",\n");
        dump.push_str("  \"cases\": [\n");

        let emit_ok = |dump: &mut String, slug: &str, desc: &str, input: &[u8], trailing: bool| {
            let (views, consumed) = parse_saved_views_array(input)
                .unwrap_or_else(|e| panic!("[{slug}] parse_ok input did not parse: {e:?}"));
            let canonical = canonical_encode_saved_views(&views);
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"saved-view/v0.1/{slug}\",\n"
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(desc)
            ));
            dump.push_str("      \"case_kind\": \"parse_ok\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_bytes_utf8_hex\": \"{}\",\n",
                hex_lower(input)
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_consumed_len\": {consumed},\n"
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_canonical_utf8_hex\": \"{}\"\n",
                hex_lower(&canonical)
            ));
            dump.push_str(if trailing { "    },\n" } else { "    }\n" });
        };
        let emit_fail = |dump: &mut String,
                         slug: &str,
                         desc: &str,
                         input: &[u8],
                         want: SavedViewParseError,
                         trailing: bool| {
            let got = parse_saved_views_array(input)
                .expect_err(&alloc::format!("[{slug}] parse_fail input parsed Ok"));
            assert_eq!(
                got, want,
                "[{slug}] parse_fail variant disagrees with hand-written expectation"
            );
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"saved-view/v0.1/{slug}\",\n"
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(desc)
            ));
            dump.push_str("      \"case_kind\": \"parse_fail\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_bytes_utf8_hex\": \"{}\",\n",
                hex_lower(input)
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_error\": \"{}\"\n",
                vector_error_str(&want)
            ));
            dump.push_str(if trailing { "    },\n" } else { "    }\n" });
        };

        // ---- parse_ok --------------------------------------------------
        let rich = canonical_encode_saved_views(&[sample()]);
        emit_ok(&mut dump, "roundtrip-rich", "A fully-populated view (every optional field set) round-trips: canonical input re-encodes to itself and consumed equals the whole array.", &rich, true);

        let two = canonical_encode_saved_views(&[
            sample(),
            SavedView {
                id: "v0".into(),
                name: "Other".into(),
                view_type: ViewType::List,
                filters: FilterNode::All,
                sort: None,
                group_by: None,
                columns: Vec::new(),
                card_size: None,
                image: None,
                image_aspect_ratio: None,
                version: None,
                write_fields: Vec::new(),
            },
        ]);
        emit_ok(&mut dump, "multi-sorted-by-id", "Two views: the array is emitted sorted by id (v0 before v1) regardless of caller order.", &two, true);

        emit_ok(
            &mut dump,
            "empty-array",
            "The empty array decodes to zero views and consumes exactly two bytes.",
            b"[]",
            true,
        );

        emit_ok(&mut dump, "normalize-whitespace-and-key-order", "Pretty-printed, reordered input decodes and re-encodes to canonical bytes (whitespace stripped, keys lexicographically sorted) — the input and the canonical projection differ.", b"[ {\n  \"view_type\" : \"table\" ,\n  \"name\" : \"n\" ,\n  \"id\" : \"x\" ,\n  \"filters\" : { \"kind\" : \"all\" }\n} ]", true);

        emit_ok(&mut dump, "nfc-fold-name", "A name carrying an NFD combining sequence (e + COMBINING ACUTE) folds to NFC in the canonical projection.", b"[{\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"e\xcc\x81\",\"view_type\":\"table\"}]", true);

        let mut trailing = canonical_encode_saved_views(&[sample()]);
        trailing.extend_from_slice(b",\"x\"");
        emit_ok(&mut dump, "consumes-only-the-array-trailing", "Trailing bytes after the array are left for the caller: consumed reports only the array length, not the full input.", &trailing, true);

        emit_ok(&mut dump, "unknown-field-tolerated", "An unknown future key on a view object is ignored (forward-compat) and dropped from the canonical projection.", b"[{\"filters\":{\"kind\":\"all\"},\"future\":42,\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}]", true);

        // ---- parse_fail ------------------------------------------------
        emit_fail(
            &mut dump,
            "non-array-top-level",
            "A top-level object where an array is required is rejected as wrong_type.",
            b"{\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}",
            SavedViewParseError::WrongType,
            true,
        );

        emit_fail(&mut dump, "map-view-type", "The map view type is outside the closed allow-list (no Maps plugin in v1) — unrepresentable.", b"[{\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"map\"}]", SavedViewParseError::Unrepresentable, true);

        emit_fail(&mut dump, "unknown-filter-kind", "An unknown filter kind (a formula/arithmetic node the anti-eval type cannot express) is unrepresentable.", b"[{\"filters\":{\"kind\":\"formula\",\"expr\":\"x+1\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}]", SavedViewParseError::Unrepresentable, true);

        emit_fail(&mut dump, "unknown-operator", "An unknown property comparison operator is outside the closed PropertyOp set — unrepresentable.", b"[{\"filters\":{\"kind\":\"property\",\"key\":\"r\",\"op\":\"~=\",\"value\":\"1\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}]", SavedViewParseError::Unrepresentable, true);

        emit_fail(
            &mut dump,
            "missing-required-name",
            "A view object missing the required name field is missing_field.",
            b"[{\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"view_type\":\"table\"}]",
            SavedViewParseError::MissingField,
            true,
        );

        emit_fail(
            &mut dump,
            "wrong-type-view-type",
            "view_type present as a number rather than a string is wrong_type.",
            b"[{\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":3}]",
            SavedViewParseError::WrongType,
            true,
        );

        emit_fail(&mut dump, "exponent-float-banned", "A number in exponent notation trips the canonical-JSON float ban — malformed.", b"[{\"card_size\":1e3,\"filters\":{\"kind\":\"all\"},\"id\":\"x\",\"name\":\"n\",\"view_type\":\"table\"}]", SavedViewParseError::Malformed, false);

        dump.push_str("  ]\n}\n");

        std::fs::write("/tmp/myne_saved_view_vectors.json", dump.as_bytes())
            .expect("write saved-view vectors dump");
        std::eprintln!("[ok] wrote /tmp/myne_saved_view_vectors.json");
    }
}
