// SPDX-License-Identifier: AGPL-3.0
//! In-memory full-text search index core (`search-index` feature, MYND-29,
//! Task 1).
//!
//! Engine-agnostic [`SearchIndex`] trait + the v0.1 custom inverted-index
//! implementation ([`InvertedIndex`]). BM25 ranking, AND-of-terms with a
//! prefix match on the FINAL query term (type-ahead), and a title-boost so
//! title matches rank above body-only matches.
//!
//! Tokenization is NFC + Unicode lowercasing + split on non-alphanumeric —
//! **RAW tokens only**; per-language stemming + Turkish-aware lowercasing
//! land in Task 2/3. No persistence here: [`SearchIndex::to_bytes`] /
//! [`SearchIndex::from_bytes`] are the plain in-memory form; Task 7 wraps
//! them in the dedicated encrypted blob.
//!
//! The custom-vs-tantivy choice is a PRE-SHIP decision (the Task-9
//! benchmark); this trait is what keeps the engine swappable. See
//! `agent-tooling/features/search-index/prd.md`.
//!
//! The engine is intentionally decoupled from the notes plugin — documents
//! carry their id as a plain `String` (the note's UUID). The Tauri search
//! command (Task 5) maps `NoteId` ↔ `String` at the boundary.

#![allow(dead_code)] // public surface is consumed by the Tauri search command (Task 5)

use crate::text::{default_lower, split_nfc, turkish_lower};
use rust_stemmers::{Algorithm, Stemmer};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use whatlang::Lang;

/// Encrypted persistence + load/reconcile/rebuild for the search index
/// (MYND-29 Task 7) — see `persist.rs`.
pub mod doc_id;
pub mod persist;

/// Budget-gated benchmark harness (MYND-29 Task 9) — test-only; see `bench.rs`.
#[cfg(test)]
mod bench;

/// BM25 term-frequency saturation parameter (Lucene-standard default).
const BM25_K1: f32 = 1.2;
/// BM25 document-length normalization parameter (Lucene-standard default).
const BM25_B: f32 = 0.75;
/// Title-field boost: a term occurrence in the title counts this many times
/// a body occurrence, so a title match outranks a body-only match of similar
/// frequency (satisfies the "title ranks above body" acceptance criterion).
const TITLE_BOOST: f32 = 3.0;

/// A document to index: a note's id plus its title and body text.
#[derive(Debug, Clone)]
pub struct Document {
    pub id: String,
    pub title: String,
    pub body: String,
}

/// Which field(s) a query matched in for a given hit (MYND-40). Drives the
/// UI's "matched in body" badge: a body-only hit (`{title:false, body:true}`)
/// is a note whose title does NOT contain the query, so the palette marks it
/// — the match is never a mystery. Computed from the per-field term
/// frequencies the index already stores while scoring, so it is precise
/// (uses the engine's own stemming) and carries no plaintext, no extra pass,
/// and no on-disk-format change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct MatchedIn {
    pub title: bool,
    pub body: bool,
}

/// A ranked search result: the document id, its display title, the BM25 score,
/// and which field(s) the query matched in.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub id: String,
    pub title: String,
    pub score: f32,
    /// Which field(s) the query matched in — drives the UI body-match badge.
    pub matched_in: MatchedIn,
}

/// Engine-agnostic search-index surface. The v0.1 implementation is
/// [`InvertedIndex`]; tantivy is the documented pre-ship fallback behind
/// this same trait (PRD engine decision).
pub trait SearchIndex {
    /// Build an index from a set of documents.
    fn build(docs: Vec<Document>) -> Self
    where
        Self: Sized;
    /// Add a document, replacing any existing document with the same id.
    fn add(&mut self, doc: Document);
    /// Remove a document by id (no-op if absent).
    fn remove(&mut self, id: &str);
    /// Query the index: AND of all terms, with a prefix match on the final
    /// term (type-ahead). Returns BM25-ranked hits, best score first; ties
    /// broken by ascending id for determinism.
    fn query(&self, query: &str) -> Vec<SearchHit>;
    /// Serialize the in-memory index to bytes (plain form — Task 7 wraps
    /// this in the encrypted blob). Named `to_bytes`/`from_bytes` to avoid a
    /// name clash with serde's `Serialize::serialize`/`Deserialize::deserialize`.
    fn to_bytes(&self) -> Vec<u8>;
    /// Deserialize from [`SearchIndex::to_bytes`] bytes; `None` on malformed
    /// input.
    fn from_bytes(bytes: &[u8]) -> Option<Self>
    where
        Self: Sized;
}

// Tokenization + casefolding primitives (`split_nfc`, `default_lower`,
// `turkish_lower`) moved to the shared `crate::text` module (SYNC-2) so the
// search index and the spell engine (MYND-262) agree on word boundaries +
// casefold. Imported at the top of this module.

/// Tokenize free text into RAW index terms: NFC + default lowercase + split.
/// The language-agnostic raw layer used by BOTH indexing and the query's raw
/// form. Per-note index-side stemming lands in Task 3; index stays raw today.
fn tokenize(text: &str) -> Vec<String> {
    split_nfc(text).iter().map(|t| default_lower(t)).collect()
}

/// Expand each query term into the set of index forms it could match: the
/// raw (default-lowercased) token plus its English, German, and Turkish
/// stems (Snowball via `rust-stemmers`). The query is too short to detect a
/// language, so it is multi-stemmed across all supported languages and
/// OR-matched — no query-language guessing. (PRD asymmetry: the index detects
/// then single-stems; the query always multi-stems.) Returns one deduped
/// form-set per query term, in order. The index is raw-only until Task 3, so
/// today the raw form does the matching and the stem forms light up once
/// notes carry stems.
fn query_expansions(query: &str) -> Vec<Vec<String>> {
    let english = Stemmer::create(Algorithm::English);
    let german = Stemmer::create(Algorithm::German);
    let turkish = Stemmer::create(Algorithm::Turkish);
    split_nfc(query)
        .iter()
        .map(|token| {
            let raw = default_lower(token);
            let mut forms = vec![raw.clone()];
            let candidates = [
                english.stem(&raw).into_owned(),
                german.stem(&raw).into_owned(),
                turkish.stem(&turkish_lower(token)).into_owned(),
            ];
            for c in candidates {
                if !c.is_empty() && !forms.contains(&c) {
                    forms.push(c);
                }
            }
            forms
        })
        .collect()
}

/// Minimum token count before attempting language detection. whatlang is
/// unreliable on a few words, so below this the document is indexed raw-only.
const MIN_DETECT_TOKENS: usize = 5;

/// Detect the document's language from `text` and map it to a supported
/// Snowball algorithm — or `None` when the text is too short, detection is
/// not reliable, or the language isn't EN/TR/DE. INDEX-side only; the query
/// never detects (too short — see [`query_expansions`]).
fn detect_supported_lang(text: &str, token_count: usize) -> Option<Algorithm> {
    if token_count < MIN_DETECT_TOKENS {
        return None;
    }
    // No `is_reliable()` gate: it is too conservative on single-sentence notes
    // (rejects correctly-detected text), and a mis-detection is SAFE here — the
    // raw token is always indexed, so a wrong language only loses that note's
    // stemmed recall, never its findability. The token-count floor above is the
    // guard against detecting on too little text.
    let info = whatlang::detect(text)?;
    match info.lang() {
        Lang::Eng => Some(Algorithm::English),
        Lang::Tur => Some(Algorithm::Turkish),
        Lang::Deu => Some(Algorithm::German),
        _ => None,
    }
}

/// Short language code stored per document for the detected stemming language.
fn lang_code(algo: Algorithm) -> &'static str {
    match algo {
        Algorithm::Turkish => "tr",
        Algorithm::German => "de",
        _ => "en",
    }
}

/// Stem `token` in `algo`, casefolding first (Turkish-aware for Turkish,
/// default otherwise — the original-case token is required so Turkish İ/I are
/// handled correctly before stemming).
fn stem_in(stemmer: &Stemmer, algo: Algorithm, token: &str) -> String {
    let cased = if matches!(algo, Algorithm::Turkish) {
        turkish_lower(token)
    } else {
        default_lower(token)
    };
    stemmer.stem(&cased).into_owned()
}

/// Bump a term's frequency in one field.
fn bump(freqs: &mut HashMap<String, FieldFreq>, term: String, is_title: bool) {
    let ff = freqs.entry(term).or_default();
    if is_title {
        ff.tf_title += 1;
    } else {
        ff.tf_body += 1;
    }
}

/// Accumulate a field's tokens into `freqs`: always the raw (default-lowercased)
/// form, plus — when `stem_ctx` is set (a note whose language was detected) —
/// the detected-language stem, so the index carries both the raw token and its
/// stem. The raw form guarantees a mis-detected note stays findable; the stem
/// gives recall for the detected language. A token counts ONCE toward document
/// length regardless of how many forms it produces (length is the caller's).
fn index_field(
    freqs: &mut HashMap<String, FieldFreq>,
    tokens: &[String],
    is_title: bool,
    stem_ctx: Option<(&Stemmer, Algorithm)>,
) {
    for tok in tokens {
        let raw = default_lower(tok);
        if let Some((stemmer, algo)) = stem_ctx {
            let stem = stem_in(stemmer, algo, tok);
            if !stem.is_empty() && stem != raw {
                bump(freqs, stem, is_title);
            }
        }
        bump(freqs, raw, is_title);
    }
}

/// Per-(term, document) frequencies, split by field so the title can be
/// boosted independently of the body.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
struct FieldFreq {
    tf_title: u32,
    tf_body: u32,
}

/// Stored per-document metadata: the public id, the total token length (for
/// BM25 document-length normalization), and the detected language.
///
/// MYND-29 Task 9 dropped the per-doc `terms: Vec<String>` field — it
/// duplicated every postings key (the dominant index-RAM cost: ~48 MB at 10k
/// notes in the benchmark) purely to make `remove` O(terms-in-doc). `remove`
/// now scans the postings once (O(distinct-terms)); `build`/`add` of a NEW id
/// short-circuit before that scan, so bulk rebuild is unaffected and only an
/// edit/delete of an EXISTING note pays the (microsecond-scale, debounced)
/// scan. The drop also shrinks the at-rest blob. See the feature
/// `progress.md` Task 9 entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct DocEntry {
    id: String,
    /// Original-case display title, returned with search hits (so the UI need
    /// not re-resolve titles for results). NOT lowercased/stemmed — display only.
    title: String,
    len: u32,
    /// Detected stemming language code (`"en"`/`"tr"`/`"de"`), or `None` when
    /// the note was indexed raw-only (too short / unsupported / unreliable).
    lang: Option<String>,
}

/// The v0.1 custom in-memory inverted index.
///
/// Internal documents are keyed by a monotonic `u32` so removal never has to
/// shift other documents' ids. `postings` is a `BTreeMap` so the final
/// query term's prefix match is a contiguous range scan.
///
/// `Clone` is for the persist path ([`SearchIndexState::snapshot`]): the
/// CPU-bound serialize + AEAD runs off the state lock on a cloned index.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct InvertedIndex {
    next_doc: u32,
    docs: HashMap<u32, DocEntry>,
    id_to_doc: HashMap<String, u32>,
    postings: BTreeMap<String, HashMap<u32, FieldFreq>>,
    total_len: u64,
}

impl InvertedIndex {
    /// BM25 contribution of a single `term` to `docid`'s score, AND — in the
    /// same lookup — OR-accumulate which field(s) `term` occurs in for `docid`
    /// into `matched_in`. Folding field-presence into the scoring lookup means a
    /// single `postings`/`docid` probe per (term, doc) feeds BOTH the score and
    /// [`SearchHit::matched_in`] (no second pass). Returns 0 — and leaves
    /// `matched_in` untouched — when the term/doc pair is absent. Uses the
    /// title-boosted effective term frequency.
    fn score_term(
        &self,
        term: &str,
        docid: u32,
        dl: f32,
        avgdl: f32,
        n: f32,
        matched_in: &mut MatchedIn,
    ) -> f32 {
        let Some(plist) = self.postings.get(term) else {
            return 0.0;
        };
        let df = plist.len() as f32;
        let Some(ff) = plist.get(&docid) else {
            return 0.0;
        };
        matched_in.title |= ff.tf_title > 0;
        matched_in.body |= ff.tf_body > 0;
        let etf = ff.tf_body as f32 + TITLE_BOOST * ff.tf_title as f32;
        if etf <= 0.0 {
            return 0.0;
        }
        // Lucene-style IDF: ln(1 + (N - df + 0.5) / (df + 0.5)) — always >= 0.
        let idf = (1.0 + (n - df + 0.5) / (df + 0.5)).ln();
        idf * (etf * (BM25_K1 + 1.0)) / (etf + BM25_K1 * (1.0 - BM25_B + BM25_B * dl / avgdl))
    }

    /// Internal doc ids of every term that begins with `prefix`, as a union
    /// set, plus the matching terms themselves (a contiguous `BTreeMap` range
    /// scan since the keys are sorted).
    fn prefix_match(&self, prefix: &str) -> (Vec<&str>, HashSet<u32>) {
        let mut terms = Vec::new();
        let mut docs = HashSet::new();
        for (term, plist) in self.postings.range(prefix.to_string()..) {
            if !term.starts_with(prefix) {
                break;
            }
            terms.push(term.as_str());
            docs.extend(plist.keys().copied());
        }
        (terms, docs)
    }

    /// Zeroize the plaintext-derived contents in place, then reset to empty
    /// (MYND-29 Task 8). The index is plaintext-derived RAM — as sensitive as
    /// the `Slot::Unlocked` keys it is torn down beside — so the lock path
    /// overwrites the term/title/note-id bytes BEFORE the backing allocations
    /// free, mirroring the keys' `Zeroizing` discipline (A6 defense-in-depth,
    /// `threat-model.md` A6 / `decisions.md` 2026-05-30 auto-lock teardown).
    ///
    /// Sensitive (zeroized): `postings` keys (plaintext-derived terms),
    /// `id_to_doc` keys + `DocEntry.id` (note ids — DENY-list correlation
    /// tags), `DocEntry.title` (plaintext-derived). Non-sensitive (dropped
    /// only): term/doc frequencies, lengths, the monotonic `u32` doc ids,
    /// the 2-char `lang` code.
    fn zeroize_in_place(&mut self) {
        use zeroize::Zeroize;
        // Drain each map by value so the owned `String` keys/fields can be
        // overwritten before they drop (a `HashMap`/`BTreeMap` key cannot be
        // mutated in place behind its hash/order).
        for (mut term, _postings) in core::mem::take(&mut self.postings) {
            term.zeroize();
        }
        for (mut id, _docid) in core::mem::take(&mut self.id_to_doc) {
            id.zeroize();
        }
        for (_docid, mut entry) in core::mem::take(&mut self.docs) {
            entry.id.zeroize();
            entry.title.zeroize();
        }
        self.next_doc = 0;
        self.total_len = 0;
    }
}

impl SearchIndex for InvertedIndex {
    fn build(docs: Vec<Document>) -> Self {
        let mut index = Self::default();
        for doc in docs {
            index.add(doc);
        }
        index
    }

    fn add(&mut self, doc: Document) {
        // Replace semantics: drop any prior document with this id first.
        self.remove(&doc.id);

        // Original-case tokens (so Turkish casefolding before stemming is
        // correct); the raw index form is the default-lowercased token.
        let title_split = split_nfc(&doc.title);
        let body_split = split_nfc(&doc.body);
        let len = (title_split.len() + body_split.len()) as u32;

        // Detect the note's language (enough-text gated) and single-stem the
        // index in that one language; ALWAYS also index the raw token. The
        // query (Task 2) stays multi-stemmed — this is the deliberate asymmetry.
        // Detect on the body alone: it dominates the text, so this avoids
        // allocating a full title+body copy per note just to sample whatlang
        // (the gate still counts all tokens via `len`).
        let algo = detect_supported_lang(&doc.body, len as usize);
        let stemmer = algo.map(Stemmer::create);
        let stem_ctx = stemmer.as_ref().zip(algo);

        let mut freqs: HashMap<String, FieldFreq> = HashMap::new();
        index_field(&mut freqs, &title_split, true, stem_ctx);
        index_field(&mut freqs, &body_split, false, stem_ctx);

        let docid = self.next_doc;
        self.next_doc += 1;
        for (term, ff) in freqs {
            self.postings.entry(term).or_default().insert(docid, ff);
        }
        self.docs.insert(
            docid,
            DocEntry {
                id: doc.id.clone(),
                title: doc.title.clone(),
                len,
                lang: algo.map(|a| lang_code(a).to_string()),
            },
        );
        self.id_to_doc.insert(doc.id, docid);
        self.total_len += u64::from(len);
    }

    fn remove(&mut self, id: &str) {
        let Some(docid) = self.id_to_doc.remove(id) else {
            return; // NEW id (the common `build`/`add` case) → O(1), no scan
        };
        if let Some(entry) = self.docs.remove(&docid) {
            self.total_len -= u64::from(entry.len);
        }
        // Drop `docid` from every posting list it appears in, pruning lists
        // that become empty. O(distinct-terms) — paid only when an EXISTING
        // note is re-indexed or deleted (interactive rate); bulk rebuild never
        // reaches here (its ids are new → early return above). Replaces the
        // former per-doc `terms` vector (dropped in Task 9 to slim index RAM).
        self.postings.retain(|_term, plist| {
            plist.remove(&docid);
            !plist.is_empty()
        });
    }

    fn query(&self, query: &str) -> Vec<SearchHit> {
        let expansions = query_expansions(query);
        if expansions.is_empty() || self.docs.is_empty() {
            return Vec::new();
        }
        let n = self.docs.len() as f32;
        let avgdl = if self.total_len == 0 {
            1.0
        } else {
            self.total_len as f32 / n
        };

        // Each query term carries an expansion set {raw, en/de/tr stems}; a
        // doc satisfies the term if it contains ANY form (OR within the set).
        // All terms but the last require an exact form match; the last term
        // matches any form as a PREFIX (type-ahead). A candidate must satisfy
        // EVERY term (AND across terms).
        let (exact_terms, last) = expansions.split_at(expansions.len() - 1);
        let last = &last[0];

        let mut required: Vec<HashSet<u32>> = Vec::with_capacity(expansions.len());
        for forms in exact_terms {
            let mut docs: HashSet<u32> = HashSet::new();
            for form in forms {
                if let Some(plist) = self.postings.get(form) {
                    docs.extend(plist.keys().copied());
                }
            }
            if docs.is_empty() {
                return Vec::new(); // no form of this term is present → AND fails
            }
            required.push(docs);
        }

        // Last term: union of prefix matches over each expansion form. Keep the
        // matched index terms (deduped) for scoring. A `HashSet` dedups in O(1)
        // per term — a broad prefix can match many postings, so the prior
        // `Vec::contains` guard was O(n²); scoring iterates the set order-free.
        let mut last_docs: HashSet<u32> = HashSet::new();
        let mut last_terms: HashSet<String> = HashSet::new();
        for form in last {
            let (terms, docs) = self.prefix_match(form);
            last_terms.extend(terms.into_iter().map(str::to_string));
            last_docs.extend(docs);
        }
        if last_docs.is_empty() {
            return Vec::new();
        }
        required.push(last_docs);

        // Intersect from the smallest set outward.
        required.sort_by_key(HashSet::len);
        let mut candidates = required[0].clone();
        for set in &required[1..] {
            candidates.retain(|d| set.contains(d));
            if candidates.is_empty() {
                return Vec::new();
            }
        }

        let mut hits: Vec<SearchHit> = candidates
            .into_iter()
            .map(|docid| {
                let entry = &self.docs[&docid];
                let dl = entry.len as f32;
                // One lookup per (term, doc) feeds BOTH the score and matched_in
                // (see `score_term`). Each exact term contributes its best-
                // matching form's BM25 (max over forms); the last term is the
                // best over its prefix-matched index keys. Exact terms match by
                // FORM (forms are posting keys); the last term matched by PREFIX,
                // so it iterates the already-resolved `last_terms` index keys (a
                // form like "prog" is not a posting key — "programming" is).
                let mut matched_in = MatchedIn::default();
                let mut score = 0.0_f32;
                for forms in exact_terms {
                    let mut best = 0.0_f32;
                    for f in forms {
                        best = best.max(self.score_term(f, docid, dl, avgdl, n, &mut matched_in));
                    }
                    score += best;
                }
                let mut last_best = 0.0_f32;
                for t in &last_terms {
                    last_best =
                        last_best.max(self.score_term(t, docid, dl, avgdl, n, &mut matched_in));
                }
                score += last_best;

                SearchHit {
                    id: entry.id.clone(),
                    title: entry.title.clone(),
                    score,
                    matched_in,
                }
            })
            .collect();

        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.id.cmp(&b.id))
        });
        hits
    }

    fn to_bytes(&self) -> Vec<u8> {
        // In-memory → compact postcard bytes (varint, no field names). Task 9
        // switched this off serde_json — the benchmark showed JSON blew the
        // at-rest blob-size + warm-unlock budgets. `encode_snapshot` (persist)
        // is the production blob path; this trait method mirrors it.
        postcard::to_allocvec(self).unwrap_or_default()
    }

    fn from_bytes(bytes: &[u8]) -> Option<Self> {
        postcard::from_bytes(bytes).ok()
    }
}

/// Tauri-managed handle to the live in-RAM search index (MYND-29 Task 4).
///
/// Updated incrementally by the notes lifecycle — `upsert` on create/update,
/// `remove` on delete — so the current session's search never sees stale
/// content without a rebuild. Queried by the search command (Task 5) and
/// cleared on lock (Task 8). The index is plaintext-derived RAM (as sensitive
/// as the open notes); its teardown is the lock path's job.
///
/// The `std::sync::Mutex` is only ever locked WITHOUT an `.await` held (the
/// notes wrappers lock after their async core returns), so it need not be
/// async. A poisoned lock degrades to a no-op / empty result rather than
/// panicking — a search hiccup must never take down a note write.
#[derive(Default)]
pub struct SearchIndexState {
    index: std::sync::Mutex<InvertedIndex>,
}

impl SearchIndexState {
    /// Index (or re-index) a note by id with its title + body. Replace
    /// semantics — an existing doc with the same id is fully overwritten, so
    /// an edit drops the note's stale terms and adds the new ones.
    pub fn upsert(&self, id: &str, title: &str, body: &str) {
        if let Ok(mut index) = self.index.lock() {
            index.add(Document {
                id: id.to_string(),
                title: title.to_string(),
                body: body.to_string(),
            });
        }
    }

    /// Drop a note from the index by id (no-op if absent).
    pub fn remove(&self, id: &str) {
        if let Ok(mut index) = self.index.lock() {
            index.remove(id);
        }
    }

    /// Query the live index (BM25-ranked). Empty on a poisoned lock.
    pub fn query(&self, query: &str) -> Vec<SearchHit> {
        self.index
            .lock()
            .map(|index| index.query(query))
            .unwrap_or_default()
    }

    /// Zeroize + reset the index — the lock path uses this to wipe the
    /// plaintext-derived index alongside the keys (MYND-29 Task 8). Wired
    /// into every slot-drop site (manual `vault_lock`, idle auto-lock
    /// teardown, `vault_delete`) so no plaintext-derived terms survive a
    /// lock. No-op on a poisoned lock. See [`InvertedIndex::zeroize_in_place`].
    pub fn clear(&self) {
        if let Ok(mut index) = self.index.lock() {
            index.zeroize_in_place();
        }
    }

    /// Swap in a freshly-built index — the load/reconcile path
    /// (`persist::hydrate_*`, Task 7) uses this on unlock to replace the
    /// empty session index with the one reconstructed from `vault.search` +
    /// the notes dir. No-op on a poisoned lock (the index stays empty;
    /// incremental updates still populate it in-session).
    pub fn replace(&self, index: InvertedIndex) {
        if let Ok(mut guard) = self.index.lock() {
            *guard = index;
        }
    }

    /// Clone the current index out for persistence (`persist::persist_*`,
    /// Task 7). Cloned under the lock, then released — the (CPU-bound)
    /// serialize + AEAD encrypt happens off the lock on the returned value.
    /// Returns an empty index on a poisoned lock (degrade-to-empty,
    /// consistent with [`Self::query`] / [`Self::clear`]).
    pub fn snapshot(&self) -> InvertedIndex {
        self.index
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(id: &str, title: &str, body: &str) -> Document {
        Document {
            id: id.to_string(),
            title: title.to_string(),
            body: body.to_string(),
        }
    }

    fn ids(hits: &[SearchHit]) -> Vec<&str> {
        hits.iter().map(|h| h.id.as_str()).collect()
    }

    // ---- tokenization -------------------------------------------------

    #[test]
    fn tokenize_lowercases_and_splits_on_punctuation() {
        assert_eq!(
            tokenize("Hello, World! rust-lang"),
            vec!["hello", "world", "rust", "lang"]
        );
    }

    #[test]
    fn tokenize_is_case_insensitive_for_matching() {
        let mut idx = InvertedIndex::default();
        idx.add(doc("a", "RUST", "Async Programming"));
        // Query in a different case still matches.
        assert_eq!(ids(&idx.query("rust")), vec!["a"]);
        assert_eq!(ids(&idx.query("ASYNC")), vec!["a"]);
    }

    #[test]
    fn tokenize_nfc_normalizes_so_decomposed_matches_precomposed() {
        // Body has decomposed "café" (e + U+0301); query uses precomposed é.
        let mut idx = InvertedIndex::default();
        idx.add(doc("a", "t", "cafe\u{0301} au lait"));
        assert_eq!(ids(&idx.query("caf\u{00e9}")), vec!["a"]);
    }

    // ---- ranking / title-boost ----------------------------------------

    #[test]
    fn title_match_ranks_above_body_only_match() {
        let mut idx = InvertedIndex::default();
        idx.add(doc("title_hit", "rust guide", "an introduction"));
        idx.add(doc("body_hit", "introduction", "a guide to rust"));
        let hits = idx.query("rust");
        assert_eq!(ids(&hits), vec!["title_hit", "body_hit"]);
        assert!(hits[0].score > hits[1].score);
    }

    #[test]
    fn bm25_ranks_higher_term_frequency_first_within_same_field() {
        let mut idx = InvertedIndex::default();
        idx.add(doc("many", "t", "rust rust rust everywhere"));
        idx.add(doc("few", "t", "a little rust here"));
        assert_eq!(ids(&idx.query("rust")), vec!["many", "few"]);
    }

    // ---- matched_in (MYND-40): which field a hit matched in --------------

    #[test]
    fn matched_in_title_only_when_term_is_in_title_not_body() {
        let mut idx = InvertedIndex::default();
        idx.add(doc("a", "rust guide", "lorem ipsum dolor"));
        let hits = idx.query("rust");
        assert_eq!(
            hits[0].matched_in,
            MatchedIn {
                title: true,
                body: false
            }
        );
    }

    #[test]
    fn matched_in_body_only_when_term_is_in_body_not_title() {
        let mut idx = InvertedIndex::default();
        idx.add(doc("a", "notes", "rust async runtime"));
        let hits = idx.query("rust");
        assert_eq!(
            hits[0].matched_in,
            MatchedIn {
                title: false,
                body: true
            }
        );
    }

    #[test]
    fn matched_in_both_when_term_is_in_title_and_body() {
        let mut idx = InvertedIndex::default();
        idx.add(doc("a", "rust notes", "rust async"));
        let hits = idx.query("rust");
        assert_eq!(
            hits[0].matched_in,
            MatchedIn {
                title: true,
                body: true
            }
        );
    }

    #[test]
    fn matched_in_title_true_via_stem_where_substring_check_would_fail() {
        // Title token "run" is matched by the query "running" through the
        // engine's English stemmer (running -> run) as a non-last EXACT term.
        // A frontend `title.includes("running")` would be false; matched_in
        // must still report title:true — proving it is computed with the
        // engine's stemmer, not a substring check (MYND-40 grill Q9).
        let mut idx = InvertedIndex::default();
        idx.add(doc("a", "run guide", "lorem ipsum dolor sit"));
        let hits = idx.query("running guide");
        assert_eq!(ids(&hits), vec!["a"]);
        assert!(
            hits[0].matched_in.title,
            "stemmed title match must set title:true"
        );
        assert!(!hits[0].matched_in.body, "term is not in the body");
    }

    // ---- AND semantics ------------------------------------------------

    #[test]
    fn multi_term_query_requires_all_terms() {
        let mut idx = InvertedIndex::default();
        idx.add(doc("both", "t", "rust and async together"));
        idx.add(doc("rust_only", "t", "rust alone"));
        idx.add(doc("async_only", "t", "async alone"));
        // "async" is exact (not last); "rust" is the last (prefix) term.
        assert_eq!(ids(&idx.query("async rust")), vec!["both"]);
    }

    #[test]
    fn absent_exact_term_yields_no_results() {
        let mut idx = InvertedIndex::default();
        idx.add(doc("a", "t", "rust async"));
        // "missing" is an exact (non-last) term with no postings → AND fails.
        assert!(idx.query("missing rust").is_empty());
    }

    // ---- prefix (type-ahead) on the last term -------------------------

    #[test]
    fn last_term_matches_as_prefix() {
        let mut idx = InvertedIndex::default();
        idx.add(doc("a", "t", "programming languages"));
        assert_eq!(ids(&idx.query("prog")), vec!["a"]);
        assert_eq!(ids(&idx.query("program")), vec!["a"]);
    }

    #[test]
    fn prefix_combines_with_and_on_earlier_terms() {
        let mut idx = InvertedIndex::default();
        idx.add(doc("match", "t", "rust programming"));
        idx.add(doc("no_prefix", "t", "rust cooking"));
        idx.add(doc("no_rust", "t", "python programming"));
        // exact "rust" AND prefix "prog"
        assert_eq!(ids(&idx.query("rust prog")), vec!["match"]);
    }

    #[test]
    fn unmatched_prefix_yields_no_results() {
        let mut idx = InvertedIndex::default();
        idx.add(doc("a", "t", "rust async"));
        assert!(idx.query("zzz").is_empty());
    }

    // ---- add / remove / build -----------------------------------------

    #[test]
    fn remove_drops_document_from_results() {
        let mut idx = InvertedIndex::default();
        idx.add(doc("a", "t", "rust async"));
        idx.add(doc("b", "t", "rust tokio"));
        assert_eq!(ids(&idx.query("rust")).len(), 2);
        idx.remove("a");
        assert_eq!(ids(&idx.query("rust")), vec!["b"]);
    }

    #[test]
    fn add_same_id_replaces_prior_document() {
        let mut idx = InvertedIndex::default();
        idx.add(doc("a", "t", "rust"));
        idx.add(doc("a", "t", "python")); // same id, new content
        assert!(idx.query("rust").is_empty());
        assert_eq!(ids(&idx.query("python")), vec!["a"]);
    }

    #[test]
    fn build_indexes_all_documents() {
        let idx = InvertedIndex::build(vec![doc("a", "rust", "x"), doc("b", "y", "rust")]);
        assert_eq!(idx.query("rust").len(), 2);
    }

    #[test]
    fn empty_query_returns_nothing() {
        let mut idx = InvertedIndex::default();
        idx.add(doc("a", "t", "rust"));
        assert!(idx.query("").is_empty());
        assert!(idx.query("   ").is_empty());
    }

    // ---- serialize round-trip -----------------------------------------

    #[test]
    fn to_bytes_round_trip_preserves_query_results() {
        let mut idx = InvertedIndex::default();
        idx.add(doc("a", "rust guide", "async tokio"));
        idx.add(doc("b", "intro", "a guide to rust"));
        let bytes = idx.to_bytes();
        let restored = InvertedIndex::from_bytes(&bytes).expect("round-trips");
        assert_eq!(idx.query("rust"), restored.query("rust"));
        assert_eq!(ids(&restored.query("rust")), vec!["a", "b"]);
    }

    #[test]
    fn from_bytes_rejects_garbage() {
        assert!(InvertedIndex::from_bytes(b"not json at all").is_none());
    }

    // ---- Task 2: stemming + query multi-stem -----
    // (`turkish_lower` now lives in `crate::text` and is tested there.)

    #[test]
    fn query_expansion_includes_raw_and_known_stems() {
        // English known pair: running → run; raw form always present.
        let en = query_expansions("running");
        assert!(en[0].contains(&"running".to_string()), "raw form present");
        assert!(en[0].contains(&"run".to_string()), "english stem present");
        // Turkish suffix stripping: kitaplar → kitap.
        let tr = query_expansions("kitaplar");
        assert!(tr[0].contains(&"kitap".to_string()), "turkish stem present");
    }

    #[test]
    fn query_matches_via_english_stem_against_raw_index() {
        // Index holds the raw token "run"; querying "running" matches via its
        // English stem "run", OR-matched against the raw index.
        let mut idx = InvertedIndex::default();
        idx.add(doc("a", "t", "i run daily"));
        assert_eq!(ids(&idx.query("running")), vec!["a"]);
    }

    #[test]
    fn query_matches_via_turkish_stem_against_raw_index() {
        // Index holds raw "kitap"; "kitaplar" matches via its Turkish stem.
        let mut idx = InvertedIndex::default();
        idx.add(doc("a", "t", "bir kitap"));
        assert_eq!(ids(&idx.query("kitaplar")), vec!["a"]);
    }

    #[test]
    fn raw_form_still_matches_after_stemming_plumbing() {
        // The raw form is always in the expansion → exact raw matching is
        // unaffected by the multi-stem machinery.
        let mut idx = InvertedIndex::default();
        idx.add(doc("a", "rust guide", "async tokio"));
        assert_eq!(ids(&idx.query("rust")), vec!["a"]);
        assert_eq!(ids(&idx.query("tokio")), vec!["a"]);
    }

    // ---- Task 3: per-note language detection + index-side stemming -----

    fn lang_of(idx: &InvertedIndex, id: &str) -> Option<String> {
        let docid = idx.id_to_doc[id];
        idx.docs[&docid].lang.clone()
    }

    #[test]
    fn english_note_detected_and_stemmed() {
        let mut idx = InvertedIndex::default();
        idx.add(doc(
            "a",
            "Daily journal",
            "I have been running every morning and the dog runs with me before work",
        ));
        assert_eq!(lang_of(&idx, "a").as_deref(), Some("en"));
        // "running" → index stem "run"; exact (non-last) "run" matches it.
        // Without index-side stemming, exact "run" would NOT match "running".
        assert_eq!(ids(&idx.query("run dog")), vec!["a"]);
    }

    #[test]
    fn turkish_note_detected_and_stemmed() {
        let mut idx = InvertedIndex::default();
        idx.add(doc(
            "a",
            "Başlık",
            "bugün kütüphaneden çok güzel kitaplar ödünç aldım",
        ));
        assert_eq!(lang_of(&idx, "a").as_deref(), Some("tr"));
        // "kitaplar" → Turkish stem "kitap"; exact "kitap" matches it.
        assert_eq!(ids(&idx.query("kitap aldım")), vec!["a"]);
    }

    #[test]
    fn short_note_falls_back_to_raw_only() {
        let mut idx = InvertedIndex::default();
        idx.add(doc("a", "t", "running today")); // < MIN_DETECT_TOKENS
        assert_eq!(lang_of(&idx, "a"), None);
        // No stem indexed → exact (non-last) "run" does not match "running".
        assert!(idx.query("run today").is_empty());
        // Raw form is still findable.
        assert_eq!(ids(&idx.query("running")), vec!["a"]);
    }

    #[test]
    fn raw_token_present_even_when_stemmed() {
        let mut idx = InvertedIndex::default();
        idx.add(doc(
            "a",
            "Daily journal",
            "I have been running every morning and the dog runs with me before work",
        ));
        assert_eq!(lang_of(&idx, "a").as_deref(), Some("en"));
        // A stemmed (detected) note is still found by its exact raw word.
        assert_eq!(ids(&idx.query("running dog")), vec!["a"]);
    }

    // ---- Task 4: SearchIndexState incremental update -------------------

    fn hit_ids(hits: &[SearchHit]) -> Vec<String> {
        hits.iter().map(|h| h.id.clone()).collect()
    }

    #[test]
    fn state_upsert_makes_note_searchable() {
        // Create → searchable in-session without a rebuild.
        let s = SearchIndexState::default();
        s.upsert("a", "Title", "rust async runtime");
        assert_eq!(hit_ids(&s.query("rust")), vec!["a".to_string()]);
    }

    #[test]
    fn state_upsert_replaces_on_edit() {
        // Edit → stale terms gone, new terms present (replace semantics).
        let s = SearchIndexState::default();
        s.upsert("a", "t", "rust");
        s.upsert("a", "t", "python"); // edited content for the same note
        assert!(s.query("rust").is_empty());
        assert_eq!(hit_ids(&s.query("python")), vec!["a".to_string()]);
    }

    #[test]
    fn state_remove_drops_note() {
        let s = SearchIndexState::default();
        s.upsert("a", "t", "rust");
        s.remove("a");
        assert!(s.query("rust").is_empty());
    }

    #[test]
    fn state_clear_empties_index() {
        let s = SearchIndexState::default();
        s.upsert("a", "t", "rust");
        s.clear();
        assert!(s.query("rust").is_empty());
    }

    // ---- Task 8: zeroize-on-lock teardown ------------------------------

    #[test]
    fn clear_wipes_every_term_and_index_is_reusable() {
        // The lock-path state transition (criterion 1): a populated index →
        // `clear()` → NO plaintext-derived term survives, across title +
        // body + multiple docs. (The byte-level overwrite is delegated to
        // the `zeroize` crate's `String`/`Vec` impls — same posture as
        // `vault_unlock::state`'s key-zeroize test.)
        let s = SearchIndexState::default();
        s.upsert("a", "Alpha Title", "rust async runtime");
        s.upsert("b", "Beta Title", "python data science");
        assert!(!s.query("rust").is_empty());
        assert!(!s.query("python").is_empty());
        assert!(!s.query("alpha").is_empty()); // title term

        s.clear();

        // No term — body or title — survives the wipe.
        assert!(s.query("rust").is_empty());
        assert!(s.query("python").is_empty());
        assert!(s.query("alpha").is_empty());
        assert!(s.query("beta").is_empty());

        // The state is reusable after a wipe — the next unlock repopulates it.
        s.upsert("c", "Fresh", "rust again");
        assert_eq!(hit_ids(&s.query("rust")), vec!["c".to_string()]);
    }

    #[test]
    fn zeroize_in_place_resets_all_internal_counters() {
        // After a wipe the index is byte-for-byte a fresh `default()` as far
        // as BM25 is concerned: avgdl normalization (total_len / doc count)
        // must not carry stale length, so a re-indexed corpus ranks exactly
        // as it would in a brand-new index.
        let mut fresh = InvertedIndex::default();
        fresh.add(doc("x", "Gamma", "rust tokio"));

        let mut wiped = InvertedIndex::default();
        wiped.add(doc("a", "Alpha", "rust async runtime here"));
        wiped.add(doc("b", "Beta", "python data science corpus"));
        wiped.zeroize_in_place();
        wiped.add(doc("x", "Gamma", "rust tokio"));

        // Identical post-wipe scoring → no stale total_len / doc residue.
        assert_eq!(fresh.query("rust"), wiped.query("rust"));
    }
}
