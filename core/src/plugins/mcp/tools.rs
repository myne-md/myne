// SPDX-License-Identifier: AGPL-3.0-only
//! The four read tools, each clamped to a connection's resolved scope.
//!
//! ## The clamp is inseparable from the operation
//!
//! None of these functions is a check a caller performs before doing the real
//! thing; each one *is* the real thing, and takes the resolved
//! [`ConnectionScope`] plus a [`McpNoteSource`] seam. The same reasoning as
//! `super::super::agent::tools`: a shape where the clamp is its own
//! `check_scope(..)` function is a shape where one call site forgets it, and no
//! compiler says so.
//!
//! **No tool takes a scope from the request.** Every request type is
//! `deny_unknown_fields`, so a payload that tries to carry a folder list or a
//! note list is refused as malformed rather than parsed and ignored: there is no
//! field for it, and inventing one is not silently tolerated. The scope comes
//! from the stored grant, resolved by [`super::scope::resolve_scope`].
//!
//! ## Refuse versus exclude, per tool
//!
//! A NOTE-addressed tool refuses with a named cause (`out_of_scope`), because
//! the caller asked for one specific note and "here is nothing" would be a lie.
//! A SET-addressed tool excludes: `note_search` and `vault_list` omit what is
//! outside the scope rather than refusing the whole call, because one
//! out-of-scope note in the vault would otherwise make search and listing
//! unusable, and a refusal that names the note would leak its existence to a
//! caller that could not read it. `vault_state` reports the COUNT of folders
//! outside the scope, which is the only fact about them the caller is given.
//!
//! ## Search is the one tool a caller can loop
//!
//! A loop of searches is how a caller approximates reading the whole vault, so
//! search is the tool with a byte bound as well as a result bound: the excerpt
//! is capped at [`MAX_EXCERPT_BYTES`], flattened to one line, and never the
//! note. A note shorter than the cap comes back whole, which is a fact about the
//! note rather than a clamp failure; what the cap guarantees is that a vault of
//! long notes costs the caller a bounded number of bytes per call.

use super::error::McpToolError;
use super::scope::{
    existing_folders, folder_key_of, resolve_scope_with_quiet, ConnectionScope, FolderCount,
};
use crate::folder_key::canonical_folder;
use crate::plugins::agent::frontmatter::folder_of;
use crate::plugins::agent::tools::SearchHit;
use crate::plugins::vault_indices::calendar::CalendarRow;
use crate::plugins::vault_indices::state::NoteRecord;
use protocol::McpConnectionGrant;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

/// Search results per call when the caller does not ask for a number.
pub const DEFAULT_SEARCH_LIMIT: usize = 20;

/// The most results one search may ask for.
///
/// A ceiling rather than a default: `limit` is clamped INTO this range, so a
/// caller that asks for 10 000 gets 50 rather than a refusal, and the loop cost
/// of a search stays bounded by something the host chose.
pub const MAX_SEARCH_LIMIT: usize = 50;

/// Byte cap on one search excerpt.
///
/// Counted in BYTES, not characters, so the bound holds for a note written in a
/// four-byte script as well as for ASCII. 320 bytes is roughly two short
/// sentences: enough to recognise a hit, not enough to be a free read.
pub const MAX_EXCERPT_BYTES: usize = 320;

/// How much of the matching line to keep before the match itself, so the excerpt
/// reads as context rather than starting mid-word.
const EXCERPT_LEAD_BYTES: usize = 80;

/// The marker put where the excerpt was cut, so a truncated one never reads as a
/// note that simply ends.
const ELLIPSIS: &str = "\u{2026}";

/// Reading the vault for one tool call. The host supplies it.
///
/// Three questions in one seam because they must be answered about the SAME
/// vault: an index snapshot, a note body, a ranked search. A host that could
/// answer them from unrelated sources would be a host whose scope check and body
/// read disagree about which vault is open.
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait McpNoteSource: Send + Sync {
    /// The vault index as it is now: note id to the record the sidebar sees.
    async fn records(&self) -> Result<BTreeMap<String, NoteRecord>, McpToolError>;
    /// One note's plaintext (frontmatter and body), or
    /// [`McpToolError::UnknownNote`] when it is gone.
    async fn read_body(&self, note_id: &str) -> Result<String, McpToolError>;
    /// Rank the vault against a query, scope-blind.
    ///
    /// Scope filtering is this module's job, not the index's: the index does not
    /// know about connections, and teaching it would be a second place for the
    /// clamp to be wrong.
    async fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, McpToolError>;
    /// Every file in the vault's catalog, with the folder it is filed in.
    /// Scope-blind for the same reason [`Self::search`] is.
    async fn files(&self) -> Result<Vec<FileRow>, McpToolError>;
    /// One file's extracted text. `None` when nothing was ever extracted from it,
    /// which the caller must be able to tell apart from an empty file.
    async fn file_text(&self, attachment_id: &str) -> Result<Option<String>, McpToolError>;
    /// The calendar between two days, bounded by the same rule the pane and the
    /// phone use. Unfiltered: the caller clamps it to the scope.
    async fn calendar(&self, from: &str, to: &str) -> Result<Vec<CalendarRow>, McpToolError>;
    /// The vault's saved views, as stored.
    async fn views(&self) -> Result<Vec<ViewRow>, McpToolError>;
    /// The facts about ONE note read from the note itself, for the window in which
    /// the index does not carry it.
    ///
    /// [`Self::records`] is the sidebar's index (`MYI1`) and the WebView is its
    /// only writer, so a note created outside the editor — by this door, by `myne
    /// new`, by a sync pull — is on disk while the record map has never heard of
    /// it. Every by-id verb answered [`McpToolError::UnknownNote`] about a note the
    /// agent had just written, and only a lock-and-unlock reindex repaired it
    /// (myne-md/myne#1230).
    ///
    /// Three facts and not a [`NoteRecord`]: a record carries folded title keys,
    /// edges, tags and typed properties, all computed TypeScript-side, so building
    /// one here would be a second indexer that disagrees with the real one.
    ///
    /// `None` when there is no such note, which is also what the default answers —
    /// the honest one for a source that cannot look at a note.
    async fn derived_note(&self, _note_id: &str) -> Result<Option<NoteFacts>, McpToolError> {
        Ok(None)
    }
}

/// One note's scope-relevant facts: existence is the `Option`, and these three are
/// the only things a clamp reads. Deliberately not a [`NoteRecord`] — see
/// [`McpNoteSource::derived_note`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteFacts {
    /// The note's title (frontmatter `title:`, else first H1), or `None`.
    pub title: Option<String>,
    /// The folder the note resolves to, in the same shape a
    /// [`NoteRecord`] carries it: raw as written, `None` for the vault root.
    /// [`Self::folder_key`] is the canonical form the clamps read.
    pub folder: Option<String>,
    /// Whether it is in the person's working set — no `trashed:`, `deleted:`,
    /// `archived:`, `template:` or `conflict:` marker.
    pub live: bool,
}

impl NoteFacts {
    /// The canonical folder key, `""` for the vault root: what every clamp
    /// compares, and the same value [`folder_key_of`] answers for a record.
    pub fn folder_key(&self) -> String {
        canonical_folder(self.folder.as_deref().unwrap_or(""))
    }
}

/// The facts a note's own bytes carry: one function rather than one per call site,
/// so the adapter and the test doubles cannot pick different helpers and stop
/// testing the same thing.
///
/// `host_adapters`, its only non-test caller, is `not(wasm32)`: the door is a
/// desktop socket. Compiling this there is dead code, which `-D warnings` refuses.
#[cfg(any(not(target_arch = "wasm32"), test))]
pub(super) fn note_facts_from_body(body: &str) -> Option<NoteFacts> {
    use crate::plugins::notes::frontmatter_patch::read_string_field;
    use crate::plugins::notes::title_extract::{extract_title_slices, fm_folder};
    // The RAW value, not `folder_of`'s canonical one: a row's `folder` is what the
    // person sees, and a derived row that spelled it differently from an indexed
    // one would be two shapes for one field.
    let folder = extract_title_slices(body.as_bytes())
        .frontmatter_bytes
        .and_then(fm_folder);
    // The folder decides the grant, so a second reader checks it: the parser the
    // field write uses. Where they disagree — a trailing `# comment` is the live
    // shape, `Private` against `Private #x` — this surface declines rather than
    // placing a note the app hides outside the exclusion. `None` answers
    // `unknown_note` on every verb.
    if folder != read_string_field(body.as_bytes(), "folder") {
        return None;
    }
    // Both readers declining is not agreement: a `folder:` written as a block
    // scalar reads as `None` to each of them while the app's YAML reader resolves it
    // to a real folder, and a `None` folder is the vault ROOT — the most permissive
    // answer this surface has. A key that is there and unresolvable derives nothing.
    if folder.is_none()
        && crate::plugins::notes::frontmatter_patch::has_field(body.as_bytes(), "folder")
    {
        return None;
    }
    Some(NoteFacts {
        title: crate::plugins::notes::title_extract::resolve_note_title(body.as_bytes()),
        folder,
        live: crate::plugins::agent::hide::body_is_live(body),
    })
}

/// From the index when it carries the note, from the note itself when it does not,
/// and `None` when neither knows it. The single seam for "does this note exist and
/// where is it", so the read verbs and the write gate cannot drift apart on the
/// fallback.
pub(super) async fn facts_for(
    records: &BTreeMap<String, NoteRecord>,
    source: &dyn McpNoteSource,
    note_id: &str,
) -> Result<Option<NoteFacts>, McpToolError> {
    if let Some(record) = records.get(note_id) {
        return Ok(Some(NoteFacts {
            title: record.title.clone(),
            folder: record.folder.clone(),
            live: record.live,
        }));
    }
    source.derived_note(note_id).await
}

/// One file as `attachment_list` hands it over.
///
/// The id is the only handle: there is deliberately no path, because a path is
/// the one argument shape that can name something outside the vault, and this
/// surface has no verb that accepts one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRow {
    /// The attachment-id, lowercase hex, as `attachment://` spells it.
    pub attachment_id: String,
    /// The display filename, or `None` when the catalog has none.
    pub filename: Option<String>,
    /// The folder it is filed in, raw (what the user sees), or `None` for the
    /// vault root.
    pub folder: Option<String>,
}

/// One saved view as `view_list` hands it over.
///
/// The last two fields exist because `note_set_field`'s refusals send the caller
/// here: a client told "not approved" or "field not declared" has to be able to
/// answer those two questions from this list, or it retries the same ids.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewRow {
    /// The view's id, opaque.
    pub view_id: String,
    /// Its display name.
    pub name: String,
    /// `table` / `cards` / `list`.
    pub view_type: String,
    /// Whether this device has approved the view's CURRENT definition, which is the
    /// precondition a field write needs.
    pub approved: bool,
    /// The frontmatter fields the view declares writable, in the order it declares
    /// them. Empty means the view writes nothing.
    pub write_fields: Vec<String>,
}

/// `attachment_list`'s arguments.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentListRequest {
    /// Narrow the listing to one folder. Must be inside the resolved scope.
    #[serde(default)]
    pub folder: Option<String>,
}

/// `attachment_read`'s arguments.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentReadRequest {
    /// The id `attachment_list` returned.
    pub attachment_id: String,
}

/// `calendar_read`'s arguments.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CalendarReadRequest {
    /// First day of the window, `YYYY-MM-DD`.
    pub from: String,
    /// Last day of the window, inclusive.
    pub to: String,
}

/// `note_search`'s arguments.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteSearchRequest {
    /// Text to look for.
    pub query: String,
    /// Narrow the search to one folder. Must be inside the resolved scope.
    #[serde(default)]
    pub folder: Option<String>,
    /// Maximum matches to return, clamped to `1..=`[`MAX_SEARCH_LIMIT`].
    #[serde(default)]
    pub limit: Option<usize>,
}

/// `note_read`'s arguments.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteReadRequest {
    /// The id of the note to read.
    pub note_id: String,
}

/// One search hit as the caller sees it: where to look, and a bounded taste.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRow {
    /// The note's id, to hand to `note_read`.
    pub note_id: String,
    /// The note's title, or `None` when it has none.
    pub title: Option<String>,
    /// The note's `folder:` as the note itself carries it, or `None` for a root
    /// note. The RAW value rather than a canonical key, because it is what the
    /// user sees and what a later `folder` argument would be written as.
    pub folder: Option<String>,
    /// A bounded, single-line window of the note's text. Never the whole note
    /// when the note is longer than [`MAX_EXCERPT_BYTES`].
    pub excerpt: String,
}

/// One note, in full.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadNote {
    /// The note's id.
    pub note_id: String,
    /// The note's plaintext: frontmatter and markdown body, exactly as stored
    /// (decrypted).
    pub body: String,
}

/// What `vault_state` answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultState {
    /// True by construction: this call reached the host, and the host answers
    /// only while the vault is unlocked. Reported because a caller that asks
    /// "what state is the vault in" needs an answer rather than an inference.
    pub unlocked: bool,
    /// True by construction too: the local door exists only while external
    /// access is enabled, so a call that arrives proves the switch is on.
    pub external_access: bool,
    /// How many folders of the vault this connection may read right now.
    pub folder_count: usize,
    /// How many live notes those folders hold right now.
    pub note_count: usize,
    /// How many of the connection's stored exclusions name a folder that exists
    /// right now. The count only: the names are the user's own text and not the
    /// caller's business.
    pub excluded_folder_count: usize,
    /// How many stored exclusions name nothing any more (a renamed or deleted
    /// folder). They exclude nothing and are reported so a caller can tell a
    /// vault that grew from a grant that went stale.
    pub stale_exclusion_count: usize,
}

/// Tool 1: search inside the scope.
///
/// Filtering happens AFTER ranking, so the index stays scope-blind and there is
/// exactly one place the clamp lives. `limit` is applied to the clamped result,
/// so the caller gets what it asked for rather than a silently short list.
pub async fn note_search(
    scope: &ConnectionScope,
    request: NoteSearchRequest,
    source: &dyn McpNoteSource,
) -> Result<Vec<SearchRow>, McpToolError> {
    scope.require_granted()?;
    let query = request.query.trim();
    if query.is_empty() {
        return Err(McpToolError::EmptyQuery);
    }
    // A folder argument NARROWS the scope and can never widen it: asking for a
    // folder outside the grant is refused rather than silently answered as an
    // empty result, because "no matches" and "you may not look there" are
    // different answers.
    if let Some(folder) = request.folder.as_ref() {
        if !scope.covers_folder(folder) {
            return Err(McpToolError::OutOfScopeFolder {
                folder: folder.clone(),
            });
        }
    }
    let narrow = request.folder.as_deref().map(canonical_folder);
    let limit = request
        .limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .clamp(1, MAX_SEARCH_LIMIT);

    let records = source.records().await?;
    // Over-fetch so the clamp does not turn `limit` into a ceiling nobody
    // reaches. The factor is a recall convenience with no security meaning: the
    // clamp below is what bounds the result, not this number.
    let ranked = source.search(query, limit.saturating_mul(4)).await?;

    let mut out = Vec::new();
    for hit in ranked {
        // Fail closed on an id neither the snapshot nor the note itself can
        // place: an id with no known folder cannot be proven inside the scope, so
        // it is dropped rather than handed back with an unknown provenance. The
        // note itself is asked for the ids the snapshot has not caught up with,
        // which is how a note this door created is findable by the next search.
        // Dropped rather than propagated, like a note deleted mid-search: a note whose
        // own bytes cannot be read is not a row. A lock cannot hide here — `records()`
        // above has already failed the call if the vault is shut.
        let Some(facts) = facts_for(&records, source, &hit.note_id)
            .await
            .unwrap_or(None)
        else {
            continue;
        };
        // The liveness rule every note surface in the app applies, at the one
        // place a ranked hit becomes a row. A trashed, tombstoned, archived,
        // template or conflict note is not part of the working set, so it is
        // EXCLUDED here rather than refused — the set-addressed half of the same
        // rule `note_read` applies to the one note it was asked for. The index
        // carries these notes (its producer indexes every `.myn`), so without
        // this a caller could search a note the sidebar would not show.
        if !facts.live {
            continue;
        }
        let key = facts.folder_key();
        if !scope.covers_key(&key) {
            continue;
        }
        if let Some(narrow) = narrow.as_ref() {
            if &key != narrow {
                continue;
            }
        }
        let body = match source.read_body(&hit.note_id).await {
            Ok(body) => body,
            // Deleted between the snapshot and the read: drop the hit rather
            // than fail the whole search.
            Err(McpToolError::UnknownNote { .. }) => continue,
            Err(other) => return Err(other),
        };
        out.push(SearchRow {
            note_id: hit.note_id,
            title: facts.title.clone(),
            folder: facts.folder.clone(),
            excerpt: excerpt(&body, query),
        });
        if out.len() == limit {
            break;
        }
    }
    Ok(out)
}

/// Tool 2: read one note in full, if it is in scope.
///
/// The folder is checked TWICE, and the second check is the one that matters:
/// once against the index snapshot (which refuses an out-of-scope id without
/// touching a byte), and once against the body's own frontmatter after the read.
/// The second catches a note MOVED into an out-of-scope folder since the
/// snapshot, which the index cannot see yet, and this is the one tool that hands
/// a caller a whole note, so it is worth the extra parse.
pub async fn note_read(
    scope: &ConnectionScope,
    request: NoteReadRequest,
    source: &dyn McpNoteSource,
) -> Result<ReadNote, McpToolError> {
    scope.require_granted()?;
    let note_id = request.note_id.trim();
    if note_id.is_empty() {
        return Err(McpToolError::UnknownNote {
            note_id: String::new(),
        });
    }
    let records = source.records().await?;
    // The index first, the note itself second: a note written outside the editor
    // (by this door, by `myne new`, by a sync pull) is on disk before the
    // WebView has indexed it, and answering `unknown_note` about a note the
    // caller just created made the write verbs useless in sequence.
    let Some(facts) = facts_for(&records, source, note_id).await? else {
        return Err(McpToolError::UnknownNote {
            note_id: note_id.to_string(),
        });
    };
    // Liveness BEFORE scope, and answered as [`McpToolError::UnknownNote`]
    // rather than as `out_of_scope`: a trashed, tombstoned or template note is
    // not a note the user is working with, so it must be indistinguishable from
    // one that does not exist. That is the exact pair the CLI door collapses for
    // the same case (`ShowOutcome::NotFound`), and naming it here instead would
    // tell a caller that a note it may not read nevertheless exists.
    if !facts.live {
        return Err(McpToolError::UnknownNote {
            note_id: note_id.to_string(),
        });
    }
    if !scope.covers_key(&facts.folder_key()) {
        return Err(McpToolError::OutOfScopeNote {
            note_id: note_id.to_string(),
        });
    }
    let body = source.read_body(note_id).await?;
    if !scope.covers_key(&folder_of(&body)) {
        return Err(McpToolError::OutOfScopeNote {
            note_id: note_id.to_string(),
        });
    }
    Ok(ReadNote {
        note_id: note_id.to_string(),
        body,
    })
}

/// Tool 3: the scope by folder, with counts.
///
/// Folders and numbers only. No note id and no title: a listing that answered
/// with either would hand the caller a handle on notes it cannot open, or their
/// content (a title is note text). The shape of the vault is what the caller
/// needs to choose a query, and that is what this answers.
/// `attachment_list`: the files whose folder this connection may read.
///
/// **The clamp is the same one `note_search` applies, one population over.** A
/// file's scope is the folder it is FILED IN, not the folders of the notes that
/// embed it: the library files a file once, and a note that links it from
/// somewhere else is a reference rather than a second home. That is why the clamp
/// needs no note bodies and costs one catalog read.
pub async fn attachment_list(
    scope: &ConnectionScope,
    request: AttachmentListRequest,
    source: &dyn McpNoteSource,
) -> Result<Vec<FileRow>, McpToolError> {
    scope.require_granted()?;
    let narrow = match request.folder.as_deref() {
        None => None,
        Some(folder) => {
            let key = canonical_folder(folder);
            if !scope.covers_key(&key) {
                return Err(McpToolError::OutOfScopeFolder {
                    folder: folder.to_string(),
                });
            }
            Some(key)
        }
    };
    Ok(source
        .files()
        .await?
        .into_iter()
        .filter(|file| {
            let key = canonical_folder(file.folder.as_deref().unwrap_or(""));
            scope.covers_key(&key) && narrow.as_ref().is_none_or(|want| &key == want)
        })
        .collect())
}

/// `attachment_read`: one file's extracted text, clamped before the read.
///
/// The clamp runs BEFORE `file_text`, not after: an excluded file must not be
/// decrypted at all, and its text must not exist in this process even briefly.
pub async fn attachment_read(
    scope: &ConnectionScope,
    request: AttachmentReadRequest,
    source: &dyn McpNoteSource,
) -> Result<Option<String>, McpToolError> {
    scope.require_granted()?;
    let entry = source
        .files()
        .await?
        .into_iter()
        .find(|file| file.attachment_id == request.attachment_id)
        .ok_or_else(|| McpToolError::UnknownFile {
            attachment_id: request.attachment_id.clone(),
        })?;
    let key = canonical_folder(entry.folder.as_deref().unwrap_or(""));
    if !scope.covers_key(&key) {
        return Err(McpToolError::OutOfScopeFile {
            attachment_id: request.attachment_id,
        });
    }
    source.file_text(&request.attachment_id).await
}

/// `calendar_read`: the rows inside the window, clamped to readable folders.
///
/// The window bound is the calendar's own (`MAX_WINDOW_DAYS`), not a second
/// number here: the pane, the phone and this door all refuse the same width, and
/// a private bound would be the second opinion that drifts.
pub async fn calendar_read(
    scope: &ConnectionScope,
    request: CalendarReadRequest,
    source: &dyn McpNoteSource,
) -> Result<Vec<CalendarRow>, McpToolError> {
    scope.require_granted()?;
    let rows = source.calendar(&request.from, &request.to).await?;
    let records = source.records().await?;
    Ok(rows
        .into_iter()
        .filter(|row| {
            records
                .get(&row.note_id)
                .is_some_and(|record| scope.covers_key(&folder_key_of(record)))
        })
        .collect())
}

/// `view_list`: the vault's saved views, as stored.
///
/// **No filter runs here, and that is the point.** Evaluating a view is the front
/// end's job, and a second evaluator in Rust would be a second answer to "which
/// notes does this view match". So this verb lists, and `view_read` is refused by
/// name rather than approximated (`decisions/mcp/0802`).
pub async fn view_list(
    scope: &ConnectionScope,
    source: &dyn McpNoteSource,
) -> Result<Vec<ViewRow>, McpToolError> {
    scope.require_granted()?;
    source.views().await
}

pub async fn vault_list(
    scope: &ConnectionScope,
    source: &dyn McpNoteSource,
) -> Result<Vec<FolderCount>, McpToolError> {
    scope.require_granted()?;
    let records = source.records().await?;
    Ok(scope.folder_counts(&records))
}

/// Tool 4: what the scope covers, and the state the call itself proves.
///
/// Safe to call before anything else: it reads the index and the snapshot of the
/// grant, never a note body, so it costs one pass and no decryption of content.
pub async fn vault_state(
    scope: &ConnectionScope,
    existing: &BTreeSet<String>,
    source: &dyn McpNoteSource,
) -> Result<VaultState, McpToolError> {
    scope.require_granted()?;
    let records = source.records().await?;
    let live_exclusions = scope.live_exclusion_count(existing);
    Ok(VaultState {
        unlocked: true,
        external_access: true,
        folder_count: scope.readable_folder_count(existing),
        note_count: scope.note_count(&records),
        excluded_folder_count: live_exclusions,
        stale_exclusion_count: scope.excluded().len().saturating_sub(live_exclusions),
    })
}

/// The verbs this build implements, as a closed set.
///
/// Declared here rather than imported from the shim's compiled catalog, because
/// the two crates share no type by design (`mcp/` depends on neither
/// `myne-core` nor `myne-desktop`), so a tool name is a wire contract with
/// THREE holders: this enum, `mcp/src/tool_list.rs`, and the callers that read
/// one and call the other. A verb the catalog offers and this build does not
/// implement answers [`McpCallOutcome::UnknownTool`], which the door reports as
/// version skew rather than silently accepting or inventing a scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolName {
    NoteSearch,
    NoteRead,
    VaultList,
    VaultState,
    NoteCreate,
    NoteAppend,
    NoteSetField,
    NoteEdit,
    NoteMove,
    /// The four reads that joined in myne-md/myne#1077. Every one of them is a
    /// read: the surface still has no delete, no path argument and no fetch.
    AttachmentList,
    AttachmentRead,
    CalendarRead,
    ViewList,
}

impl ToolName {
    /// The verb a caller named, or `None` if this build does not implement it.
    ///
    /// `None` is the honest answer for a name the compiled catalog does not
    /// carry: a shim newer than its host is version skew, not a scope decision,
    /// and `invalid_request` is the kind this door already uses for version skew.
    /// A verb the catalog DOES carry and this match does not is not version skew
    /// but a broken surface, and `mcp/src/surface_test.rs` fails on it from inside
    /// the build — before that check existed, `note_set_field` sat in the catalog
    /// and every call to it answered as skew.
    pub fn from_wire(name: &str) -> Option<Self> {
        match name {
            "note_search" => Some(Self::NoteSearch),
            "note_read" => Some(Self::NoteRead),
            "vault_list" => Some(Self::VaultList),
            "vault_state" => Some(Self::VaultState),
            "note_create" => Some(Self::NoteCreate),
            "note_append" => Some(Self::NoteAppend),
            "note_set_field" => Some(Self::NoteSetField),
            "note_edit" => Some(Self::NoteEdit),
            "note_move" => Some(Self::NoteMove),
            "attachment_list" => Some(Self::AttachmentList),
            "attachment_read" => Some(Self::AttachmentRead),
            "calendar_read" => Some(Self::CalendarRead),
            "view_list" => Some(Self::ViewList),
            _ => None,
        }
    }

    /// Whether this verb changes the vault.
    ///
    /// Read rather than inferred from a match arm at each of the three places
    /// that care (the grant check, the write scope, the outcome), because the
    /// failure of getting it wrong is a write served under a read-only path.
    pub fn is_write(self) -> bool {
        matches!(
            self,
            Self::NoteCreate
                | Self::NoteAppend
                | Self::NoteSetField
                | Self::NoteEdit
                | Self::NoteMove
        )
    }

    /// Whether this verb's answer carries note text, which is what the read
    /// budget counts.
    ///
    /// Search and read, and nothing else: `vault_list` returns folder keys with
    /// counts and `vault_state` returns sizes and a version, so neither hands over
    /// a word of a note. Charging them would spend the budget on structure, and
    /// not charging the two that do return text would make the budget a count of
    /// calls wearing a count of notes as a name.
    pub fn produces_notes(self) -> bool {
        matches!(
            self,
            Self::NoteSearch | Self::NoteRead | Self::AttachmentRead | Self::CalendarRead
        )
    }

    /// The wire spelling of this verb.
    pub fn wire(self) -> &'static str {
        match self {
            Self::NoteSearch => "note_search",
            Self::NoteRead => "note_read",
            Self::VaultList => "vault_list",
            Self::VaultState => "vault_state",
            Self::NoteCreate => "note_create",
            Self::NoteAppend => "note_append",
            Self::NoteSetField => "note_set_field",
            Self::NoteEdit => "note_edit",
            Self::NoteMove => "note_move",
            Self::AttachmentList => "attachment_list",
            Self::AttachmentRead => "attachment_read",
            Self::CalendarRead => "calendar_read",
            Self::ViewList => "view_list",
        }
    }
}

/// What one `tools/call` decided, before the door puts it on the wire.
///
/// The door's reply envelope is a separate thing on purpose (`{"ok":true,
/// "result":<CallToolResult>}` / `{"ok":false,"error":{kind,message}}`): this
/// enum is what the HOST decided, and the two producers are [`call_tool`] (the
/// tool surface) and `host_adapters::door_call` (the vault and prefs plumbing
/// around it), which is why `VaultLocked` and `Io` exist here at all.
#[derive(Debug, Clone, PartialEq)]
pub enum McpCallOutcome {
    /// A complete MCP `CallToolResult`, ready to relay verbatim.
    Result(Value),
    /// A host decision with a closed reason and one actionable sentence. The
    /// door relays `reason` as the wire `kind`, so the shim's
    /// `structuredContent.reason` and the door's error envelope cannot disagree
    /// about what happened.
    Refused(McpToolError),
    /// This build does not implement that verb (version skew).
    UnknownTool,
    /// A write landed in a folder the connection may READ but not write, so
    /// nothing was applied and the door must record it as a proposal.
    ///
    /// Carried out of [`call_tool`] rather than written there because the queue
    /// is a `vault.prefs` field and this function holds no host: the door owns the
    /// write, and answering the caller
    /// [`McpToolError::WriteQueuedForReview`] is the door's job so that a row is
    /// never reported as queued and then lost.
    QueueProposal {
        /// The verb that was attempted, as the card names it.
        verb: &'static str,
        /// The folder it named, canonical.
        folder: String,
        /// One line of what it wanted to write. USER TEXT: never logged.
        summary: String,
    },
    /// The arguments do not decode against the verb's schema.
    Malformed,
    /// The vault locked between the request arriving and the call running. The
    /// narrow race only: while the vault is locked the socket does not exist, so
    /// a client cannot ordinarily produce this.
    VaultLocked,
    /// The host could not read its own state (prefs, index) for this call.
    Io,
}

/// The three fields a `tools/call` carries over the wire.
///
/// The connection name comes from the shim (`MYNE_MCP_CONNECTION`, else the
/// handshake's `clientInfo.name`, else the shim's own `unnamed-client`), never
/// from the arguments: a caller that could name its grant inside the payload
/// would be resolving its own scope.
#[derive(Debug, Clone, Copy)]
pub struct WireCall<'a> {
    /// The declared connection name. Trimmed by the caller; NOT normalized,
    /// because normalization happens when a grant is WRITTEN (`scope.rs`).
    pub connection: &'a str,
    /// The verb, as the shim spelled it.
    pub tool: &'a str,
    /// The caller's arguments, verbatim.
    pub arguments: &'a Value,
}

/// Everything [`call_tool`] resolves against: the call, plus the stored grants
/// and the folder set it is clamped to.
#[derive(Clone, Copy)]
pub struct CallInputs<'a> {
    /// The call itself.
    pub call: WireCall<'a>,
    /// The stored grants by name, read from `vault.prefs`. Never from the call.
    pub grants: &'a BTreeMap<String, McpConnectionGrant>,
    /// `deliberate_folders`, for "which folders exist now".
    pub deliberate_folders: &'a [String],
    /// `archived_folders`, subtracted by prefix like the sidebar does.
    pub archived_folders: &'a [String],
    /// `ai_excluded_folders` plus `cli_excluded_folders`: the folders the user has
    /// already excluded from every OTHER AI surface in this vault, subtracted from
    /// this connection's reach as well (`decisions/security/0753`). Never from the
    /// call, and only ever narrowing.
    pub quiet_folders: &'a [String],
    /// The host's write surface, or `None` on a caller that can only read.
    ///
    /// `None` refuses a WRITE verb as [`McpCallOutcome::Io`] and leaves every read
    /// verb untouched: the one live caller always supplies it, so absent means a
    /// host composed without a writer, which is a wiring bug rather than something
    /// a client can act on.
    pub writer: Option<&'a dyn super::intent::McpNoteWriter>,
    /// The process-wide read budget (mcp external access rework, myne-md/myne#1052).
    ///
    /// Supplied rather than reached for inside, so a test can drive its own ledger
    /// instead of sharing the process's spending with every other test in this file.
    /// Production passes [`super::budget::process_ledger`].
    pub budget: &'a std::sync::Mutex<super::budget::BudgetLedger>,
    /// The host's monotonic clock in milliseconds, read once per call by the
    /// caller. `core/` may not touch a clock directly: the task/clock seam guard
    /// holds that, and an `Instant` compiles for wasm32 and panics there.
    pub now_ms: u64,
}

/// One decoded call, kept typed so the dispatch below cannot re-parse.
enum Parsed {
    Search(NoteSearchRequest),
    Read(NoteReadRequest),
    List,
    State,
    Create(super::intent::NoteCreateRequest),
    Append(super::intent::NoteAppendRequest),
    SetField(super::intent::NoteSetFieldRequest),
    Edit(super::anchor::NoteEditRequest),
    Move(super::anchor::NoteMoveRequest),
    Files(AttachmentListRequest),
    FileText(AttachmentReadRequest),
    Calendar(CalendarReadRequest),
    Views,
}

/// `vault_list` and `vault_state` take no arguments; an object with anything in
/// it is malformed rather than silently ignored, which is the same
/// `deny_unknown_fields` rule the two argument-taking tools already carry.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NoArguments {}

fn parse_arguments(tool: ToolName, arguments: &Value) -> Option<Parsed> {
    match tool {
        ToolName::NoteSearch => serde_json::from_value(arguments.clone())
            .ok()
            .map(Parsed::Search),
        ToolName::NoteRead => serde_json::from_value(arguments.clone())
            .ok()
            .map(Parsed::Read),
        ToolName::VaultList => serde_json::from_value::<NoArguments>(arguments.clone())
            .ok()
            .map(|_| Parsed::List),
        ToolName::VaultState => serde_json::from_value::<NoArguments>(arguments.clone())
            .ok()
            .map(|_| Parsed::State),
        ToolName::NoteCreate => serde_json::from_value(arguments.clone())
            .ok()
            .map(Parsed::Create),
        ToolName::NoteAppend => serde_json::from_value(arguments.clone())
            .ok()
            .map(Parsed::Append),
        ToolName::NoteSetField => serde_json::from_value(arguments.clone())
            .ok()
            .map(Parsed::SetField),
        ToolName::NoteEdit => serde_json::from_value(arguments.clone())
            .ok()
            .map(Parsed::Edit),
        ToolName::NoteMove => serde_json::from_value(arguments.clone())
            .ok()
            .map(Parsed::Move),
        ToolName::AttachmentList => serde_json::from_value(arguments.clone())
            .ok()
            .map(Parsed::Files),
        ToolName::AttachmentRead => serde_json::from_value(arguments.clone())
            .ok()
            .map(Parsed::FileText),
        ToolName::CalendarRead => serde_json::from_value(arguments.clone())
            .ok()
            .map(Parsed::Calendar),
        ToolName::ViewList => serde_json::from_value::<NoArguments>(arguments.clone())
            .ok()
            .map(|_| Parsed::Views),
    }
}

/// Answer one `tools/call`: the whole host-side decision, in one function.
///
/// The order of the four steps is load-bearing and each was chosen against a
/// specific failure.
///
/// 1. **No grant, no vault work.** A name with no grant learns nothing at all:
///    not whether its arguments would have parsed, not how big the vault is, not
///    that the index was touched. This is also what makes `no_grant` cheap to
///    produce for a client nobody approved, which is the common case for a
///    hand-configured connection (it arrives as the shim's `unnamed-client`).
/// 2. **An unimplemented verb is version skew**, refused before the argument
///    decode because there is no schema to decode against.
/// 3. **Arguments decode before the vault is read.** A malformed call is a
///    caller bug, and answering it from the schema is both cheaper and narrower
///    than doing so after a snapshot.
/// 4. **Scope resolves from the stored grant and the folders that exist NOW**,
///    then the tool clamps to it. The folder set comes from the same source the
///    tool reads, which is why this takes a source rather than a pre-resolved
///    scope: the caller cannot hand one in, and there is no parameter through
///    which it could name a folder it wants.
pub async fn call_tool(inputs: CallInputs<'_>, source: &dyn McpNoteSource) -> McpCallOutcome {
    let call = inputs.call;
    let connection = call.connection.trim();
    if !inputs.grants.contains_key(connection) {
        return McpCallOutcome::Refused(McpToolError::NoGrant);
    }
    let Some(tool) = ToolName::from_wire(call.tool) else {
        return McpCallOutcome::UnknownTool;
    };
    let Some(parsed) = parse_arguments(tool, call.arguments) else {
        return McpCallOutcome::Malformed;
    };

    // Snapshot #1: the folder set the grant is resolved against. The tool takes
    // its own snapshot below through the same source; both are reads of one
    // in-RAM index, and the tool's is the one every clamp is applied to.
    let records = match source.records().await {
        Ok(records) => records,
        Err(error) => return McpCallOutcome::Refused(error),
    };
    let existing = existing_folders(&records, inputs.deliberate_folders, inputs.archived_folders);
    drop(records);
    let scope = resolve_scope_with_quiet(connection, inputs.grants, inputs.quiet_folders);
    // `resolve_scope` answered `granted` from the map checked above, so this
    // cannot fail here; the tools call it again per verb, which is the one home
    // of the rule and the reason it is not re-derived.
    if let Err(error) = scope.require_granted() {
        return McpCallOutcome::Refused(error);
    }

    // **A verb the user switched off is refused here, before any argument is
    // acted on.** It is checked after the grant and before the snapshots below, so
    // a disabled verb costs no vault read, and it is checked against the WIRE name
    // because that is what the stored set holds. Disabling a write verb is not a
    // substitute for the write scope: it is refused rather than queued, since a
    // queued proposal asks the person to grant something they just refused
    // (myne-md/myne#1052).
    if scope.is_verb_disabled(tool.wire()) {
        return McpCallOutcome::Refused(McpToolError::VerbDisabled {
            verb: tool.wire().to_string(),
        });
    }

    // **The read budget is checked before anything is served and charged after**
    // (mcp external access rework, myne-md/myne#1052). The cost of a call is only
    // known once it has run, so this asks "is anything left" and the charge below
    // records what was actually returned. A single call can therefore overshoot by
    // at most one call's worth (fifty notes for a search, one for a read), and a
    // caller that is already over is refused rather than served a partial answer.
    let now_ms = inputs.now_ms;
    if tool.produces_notes() {
        let left = inputs
            .budget
            .lock()
            .map(|mut ledger| ledger.remaining(connection, now_ms))
            // A poisoned lock answers "nothing left", the direction the door's own
            // rate limiter chooses: a refusal is recoverable, a drain is not.
            .unwrap_or(0);
        if left == 0 {
            return McpCallOutcome::Refused(McpToolError::BudgetExhausted {
                retry_after_seconds: super::budget::WINDOW_MS / 1000,
            });
        }
    }

    // **A write verb resolves a SECOND scope before it touches anything.** The
    // read scope above bounds what a connection can see; the write grant beside it
    // bounds what it can change, and the two are resolved from the same stored
    // record through opposite models. Resolving it here rather than inside the verb
    // keeps `resolve_write_scope` off the read path entirely: a read call never
    // constructs the object that decides where a write may land.
    let write = if tool.is_write() {
        Some(super::write_scope::resolve_write_scope(
            connection,
            inputs.grants,
        ))
    } else {
        None
    };
    let writer: Option<&dyn super::intent::McpNoteWriter> = if tool.is_write() {
        match inputs.writer {
            Some(writer) => Some(writer),
            // A host composed without a write surface. `Io` rather than a refusal:
            // nothing about the caller's request is wrong, and no verb it could
            // have called differently would be served either.
            None => return McpCallOutcome::Io,
        }
    } else {
        None
    };

    // How many notes this call actually handed over, charged to the budget once
    // the call has answered (see the check above for why the charge is late).
    let mut notes_taken: u32 = 0;
    let result = match parsed {
        Parsed::Search(request) => note_search(&scope, request, source).await.map(|rows| {
            notes_taken = rows.len() as u32;
            to_value(&rows)
        }),
        Parsed::Read(request) => note_read(&scope, request, source).await.map(|note| {
            notes_taken = 1;
            to_value(&note)
        }),
        Parsed::List => vault_list(&scope, source)
            .await
            .map(|folders| to_value(&folders)),
        Parsed::State => vault_state(&scope, &existing, source)
            .await
            .map(|state| to_value(&state)),
        Parsed::Create(request) => {
            let summary = one_line_summary(&request.title);
            match super::intent::note_create(
                &scope,
                write.as_ref().expect("resolved for a write verb"),
                request,
                writer.expect("checked above for a write verb"),
            )
            .await
            {
                Ok(super::intent::WriteAnswer::Applied(created)) => Ok(to_value(&created)),
                Ok(super::intent::WriteAnswer::Queued { folder }) => {
                    return McpCallOutcome::QueueProposal {
                        verb: tool.wire(),
                        folder,
                        summary,
                    }
                }
                Err(error) => Err(error),
            }
        }
        Parsed::Append(request) => {
            let summary = one_line_summary(&request.markdown);
            match super::intent::note_append(
                &scope,
                write.as_ref().expect("resolved for a write verb"),
                request,
                source,
                writer.expect("checked above for a write verb"),
            )
            .await
            {
                Ok(super::intent::WriteAnswer::Applied(appended)) => Ok(to_value(&appended)),
                Ok(super::intent::WriteAnswer::Queued { folder }) => {
                    return McpCallOutcome::QueueProposal {
                        verb: tool.wire(),
                        folder,
                        summary,
                    }
                }
                Err(error) => Err(error),
            }
        }
        Parsed::SetField(request) => {
            // The review card's one line: the field and the value, because a
            // proposal a person reads has to say what would be set.
            let summary = one_line_summary(&format!("{}: {}", request.field, request.value));
            match super::intent::note_set_field(
                &scope,
                write.as_ref().expect("resolved for a write verb"),
                request,
                source,
                writer.expect("checked above for a write verb"),
            )
            .await
            {
                Ok(super::intent::WriteAnswer::Applied(set)) => Ok(to_value(&set)),
                Ok(super::intent::WriteAnswer::Queued { folder }) => {
                    return McpCallOutcome::QueueProposal {
                        verb: tool.wire(),
                        folder,
                        summary,
                    }
                }
                Err(error) => Err(error),
            }
        }
        Parsed::Edit(request) => {
            let summary = one_line_summary(&request.replacement);
            match super::anchor::note_edit(
                &scope,
                write.as_ref().expect("resolved for a write verb"),
                request,
                source,
                writer.expect("checked above for a write verb"),
            )
            .await
            {
                Ok(super::intent::WriteAnswer::Applied(edited)) => Ok(to_value(&edited)),
                Ok(super::intent::WriteAnswer::Queued { folder }) => {
                    return McpCallOutcome::QueueProposal {
                        verb: tool.wire(),
                        folder,
                        summary,
                    }
                }
                Err(error) => Err(error),
            }
        }
        Parsed::Move(request) => {
            let folder_named = request.folder.clone();
            let summary = one_line_summary(&format!("move to {folder_named}"));
            match super::anchor::note_move(
                &scope,
                write.as_ref().expect("resolved for a write verb"),
                request,
                source,
                writer.expect("checked above for a write verb"),
            )
            .await
            {
                Ok(super::intent::WriteAnswer::Applied(moved)) => Ok(to_value(&moved)),
                // A move's proposal names the DESTINATION, which is the folder the
                // client asked for: the source is already inside the grant, so the
                // decision a person makes is about where the note is going.
                Ok(super::intent::WriteAnswer::Queued { folder }) => {
                    return McpCallOutcome::QueueProposal {
                        verb: tool.wire(),
                        folder,
                        summary,
                    }
                }
                Err(error) => Err(error),
            }
        }
        // The four reads that joined in myne-md/myne#1077. Each charges the budget
        // for what it actually hands over: a file's text is one note's worth, and a
        // calendar or a view list is one row per note named, because a row names a
        // note and a caller can walk the ids from there.
        Parsed::Files(request) => attachment_list(&scope, request, source)
            .await
            .map(|rows| to_value(&rows)),
        Parsed::FileText(request) => attachment_read(&scope, request, source).await.map(|text| {
            notes_taken = 1;
            to_value(&text)
        }),
        Parsed::Calendar(request) => calendar_read(&scope, request, source).await.map(|rows| {
            notes_taken = rows.len() as u32;
            to_value(&rows)
        }),
        Parsed::Views => view_list(&scope, source).await.map(|rows| to_value(&rows)),
    };
    // The budget is charged only for an answer that carried note text. A refusal
    // costs nothing, which is what keeps a client retrying a refused call from
    // spending the budget of the connection that shares its window.
    if notes_taken > 0 {
        match inputs.budget.lock() {
            Ok(mut ledger) => ledger.charge(connection, now_ms, notes_taken),
            // A poisoned lock is a previous panic, not a licence to serve the rest
            // of the window uncharged: the charge is skipped AND the skip is said
            // out loud, so a poisoned ledger is visible rather than silent.
            Err(_) => tracing::warn!(
                target: "myne::mcp",
                "budget ledger poisoned; charge skipped"
            ),
        }
    }
    match result {
        Ok(Ok(structured)) => McpCallOutcome::Result(call_tool_result(tool, structured)),
        // Unreachable for these types (no map with non-string keys, no NaN), and
        // answered rather than panicked because a serializer change must not
        // become a crash in the process that holds the vault keys.
        Ok(Err(())) => McpCallOutcome::Io,
        Err(error) => McpCallOutcome::Refused(error),
    }
}

/// The longest one-line summary a queued proposal carries into the review card.
///
/// Bounded because the card is a row in a `vault.prefs` blob with its own
/// plaintext budget, and a client can send a 16 MiB body: the summary is what the
/// person reads to decide, and 240 bytes is the whole of a title plus the first
/// clause of a sentence.
pub const MAX_SUMMARY_BYTES: usize = 240;

/// One line of a caller's own text, for the review card.
///
/// **USER TEXT, never logged** (`src-tauri/AGENTS.md`, the DENY list). Newlines
/// and tabs become spaces because this string is rendered into a card that has one
/// line per request, and a newline in it would forge a second row. Truncation is on
/// a character boundary so a multi-byte character cannot be cut in half and
/// produce an invalid string.
pub fn one_line_summary(text: &str) -> String {
    let flattened: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let trimmed = flattened.trim();
    if trimmed.len() <= MAX_SUMMARY_BYTES {
        return trimmed.to_string();
    }
    let mut cut = MAX_SUMMARY_BYTES;
    while cut > 0 && !trimmed.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", trimmed[..cut].trim_end())
}

/// Serialize one tool's answer. Split out so the match above stays readable and
/// the failure is stated once.
fn to_value<T: Serialize>(value: &T) -> Result<Value, ()> {
    serde_json::to_value(value).map_err(|_| ())
}

/// The MCP `CallToolResult` for one successful call.
///
/// `content[0].text` is the human-readable half and `structuredContent` is the
/// machine half, both carrying the same answer: a text-only client reads the
/// block, a structured client reads the object, and neither has to parse the
/// other's rendering. `isError` is stated rather than omitted so a client that
/// only looks for it cannot read a success as a refusal.
///
/// Both halves are present for every read tool, including `note_read`, where
/// that doubles the note. Uniformity wins here because a client that branches on
/// `structuredContent` would otherwise have to special-case one verb; the cost
/// is bounded by the shim's own 16 MiB frame cap, which already sizes what a
/// single note can be.
fn call_tool_result(tool: ToolName, structured: Value) -> Value {
    let text = match tool {
        // A note is markdown, and the text block is the one place it can be
        // handed over as markdown rather than as JSON-escaped markdown.
        ToolName::NoteRead => structured
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        // A file's extracted text: the answer IS the text.
        ToolName::AttachmentRead => structured.as_str().unwrap_or_default().to_string(),
        _ => serde_json::to_string_pretty(&structured).unwrap_or_default(),
    };
    // `structuredContent` is a JSON OBJECT on the MCP wire, and the client SDKs
    // enforce it by refusing the call before reading it (myne-md/myne#1106). Two
    // verbs answer with a list and one with a bare string, so both shapes are given
    // a home HERE, in the one place a tool result is assembled.
    let structured = match structured {
        Value::Object(_) => structured,
        Value::Array(_) => json!({ "items": structured }),
        scalar => json!({ "text": scalar }),
    };
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": structured,
        "isError": false,
    })
}

/// A bounded, single-line window of `body` around the first occurrence of
/// `query`.
///
/// The window is anchored at the first LINE carrying the query, then moved
/// [`EXCERPT_LEAD_BYTES`] back so the match has context in front of it. When
/// nothing matches (a ranked hit whose term is not literal, which a semantic
/// ranker produces), the window is the start of the note: a caller who gets an
/// excerpt still learns what the note opens with, which is more useful than an
/// empty string and no less bounded.
///
/// Newlines and other control characters become spaces, because this string is
/// rendered into a client's transcript and a newline in it forges a line of
/// output. The cap is in bytes and includes the ellipsis.
///
/// **One stated imprecision:** the match is located on a lower-cased copy of the
/// line, so for a script whose lower-case form changes byte length the window
/// can begin a few characters before the match. The bound and the single-line
/// flattening hold either way, and the excerpt is decoration around an answer
/// the ranker already gave.
pub fn excerpt(body: &str, query: &str) -> String {
    let needle = query.trim().to_lowercase();
    let mut start = 0usize;
    if !needle.is_empty() {
        let mut offset = 0usize;
        for line in body.split_inclusive('\n') {
            if let Some(found) = line.to_lowercase().find(&needle) {
                start = offset + found.saturating_sub(EXCERPT_LEAD_BYTES);
                break;
            }
            offset += line.len();
        }
    }
    // Start on a character boundary: a byte slice panics otherwise, and the
    // subtraction above can land inside a multi-byte character.
    if start > body.len() {
        start = body.len();
    }
    while start > 0 && !body.is_char_boundary(start) {
        start -= 1;
    }

    let mut out = String::new();
    let mut cut = false;
    if start > 0 {
        out.push_str(ELLIPSIS);
    }
    let budget = MAX_EXCERPT_BYTES - ELLIPSIS.len();
    for ch in body[start..].chars() {
        let ch = if ch.is_control() { ' ' } else { ch };
        if ch == ' ' && out.ends_with(' ') {
            continue;
        }
        if out.len() + ch.len_utf8() > budget {
            cut = true;
            break;
        }
        out.push(ch);
    }
    if cut {
        out.push_str(ELLIPSIS);
    }
    out.trim_end().to_string()
}

/// The twelve verbs the compiled catalog advertises, in catalog order
/// (`mcp/src/tool_list.rs`), so Settings can render one switch per verb.
///
/// Duplicated here rather than imported because the catalog lives in the shim crate,
/// a separate binary by design: this process must not link it. Three holders of one
/// contract is why the copies are checked twice: `scripts/check-mcp-tool-surface.mjs`
/// holds this roster against the catalog and the capability rules, and
/// `mcp/src/surface_test.rs` holds all THREE (the catalog, this roster and the
/// dispatch table) against each other from inside the build, so a verb only one of
/// them names fails `cargo test -p myne-mcp`.
pub const CATALOG_VERBS: [&str; 13] = [
    "note_search",
    "note_read",
    "vault_list",
    "vault_state",
    "note_create",
    "note_append",
    "note_set_field",
    "note_move",
    "note_edit",
    "attachment_list",
    "attachment_read",
    "calendar_read",
    "view_list",
];

#[cfg(test)]
#[test]
fn catalog_verbs_agree_with_the_dispatch_table() {
    // Every name on screen is a name this build serves. The earlier version of this
    // test asserted the opposite — that exactly one catalog verb had no arm, and that
    // the UI rendered it as a switch that says why — so the suite stayed green while a
    // client was handed a tool that could only answer version skew. Neither a grep nor
    // a review could catch that drift, because the drift WAS the assertion.
    let unimplemented: Vec<&str> = CATALOG_VERBS
        .iter()
        .copied()
        .filter(|name| ToolName::from_wire(name).is_none())
        .collect();
    assert_eq!(
        unimplemented,
        Vec::<&str>::new(),
        "the catalog and the dispatch table disagree: {unimplemented:?} is advertised and \
         cannot be called, so every call to it answers as version skew"
    );
    for name in CATALOG_VERBS {
        if let Some(tool) = ToolName::from_wire(name) {
            assert_eq!(tool.wire(), name, "a verb answers a different wire name");
        }
    }
}
