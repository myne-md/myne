// SPDX-License-Identifier: AGPL-3.0
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
use super::scope::{folder_key_of, ConnectionScope, FolderCount};
use crate::folder_key::canonical_folder;
use crate::plugins::agent::frontmatter::folder_of;
use crate::plugins::agent::tools::SearchHit;
use crate::plugins::vault_indices::state::NoteRecord;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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
    /// How many folders the granted scope covers right now.
    pub folder_count: usize,
    /// How many live notes those folders hold right now.
    pub note_count: usize,
    /// How many folders exist that the scope does NOT cover. The count only:
    /// names of unreadable folders are not the caller's business.
    pub outside_folder_count: usize,
    /// How many granted folders no longer exist. A rename shows up here, because
    /// the grant stores paths.
    pub missing_folder_count: usize,
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
        // Fail closed on an id the snapshot does not carry: an id with no known
        // folder cannot be proven inside the scope, so it is dropped rather than
        // handed back with an unknown provenance.
        let Some(record) = records.get(&hit.note_id) else {
            continue;
        };
        let key = folder_key_of(record);
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
            title: record.title.clone(),
            folder: record.folder.clone(),
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
    let Some(record) = records.get(note_id) else {
        return Err(McpToolError::UnknownNote {
            note_id: note_id.to_string(),
        });
    };
    if !scope.covers_key(&folder_key_of(record)) {
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
    source: &dyn McpNoteSource,
) -> Result<VaultState, McpToolError> {
    scope.require_granted()?;
    let records = source.records().await?;
    Ok(VaultState {
        unlocked: true,
        external_access: true,
        folder_count: scope.folders().len(),
        note_count: scope.note_count(&records),
        outside_folder_count: scope.delta().len(),
        missing_folder_count: scope.missing().len(),
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
