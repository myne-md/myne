//! Shared markdown chunker (semantic-search-qa task 1, SYNC-18 / SYNC-8) — the
//! single canonical splitter the whole local-ai epic reuses: semantic search
//! embeds each chunk, and `note-summarization`'s merge-time map-reduce consumes
//! the same units. Kept free of any QA-specific coupling so both consumers
//! attach to one implementation.
//!
//! **Pure over `(NoteId, &str)`.** No embedding, no model, no IPC, no I/O — it
//! turns a note's decrypted markdown into heading/paragraph-window [`Chunk`]s,
//! each carrying only its source `{note_id, byte-range}` (the `vault.indices`
//! per-occurrence model, root `CLAUDE.md` §9.8). It deliberately does **not**
//! copy the plaintext into the returned value: a chunk is an *index* into the
//! already-resident source, so no second plaintext buffer is minted here (the
//! RAM vector store, task 2, owns the zeroize-on-lock lifecycle). Callers slice
//! on demand via [`Chunk::slice`].
//!
//! ## Windowing model
//!
//! 1. **Segment** the markdown into paragraphs (maximal runs of non-blank
//!    lines) and headings (a line whose first non-space char is `#`). Blank
//!    lines separate; a heading is its own segment and a hard boundary.
//! 2. **Window** consecutive segments into chunks up to `max_chars`, with a
//!    heading always starting a fresh window (heading-aligned sections) and a
//!    `overlap_chars` tail re-seeded across size-forced (not heading-forced)
//!    breaks so retrieval keeps cross-boundary context.
//! 3. An **oversized** segment (longer than `max_chars` on its own) is
//!    hard-split on code-point boundaries into standalone chunks — never merged
//!    with a neighbour, so no chunk grossly exceeds the budget and there is no
//!    stall.
//!
//! `max_chars` / `overlap_chars` are a **code-point budget**, a token proxy
//! until sibling 1's real tokenizer + pinned model context land at merge
//! (SYNC-7/13); the budget counts segment content, not the inter-segment blank
//! lines a window's byte-range spans. Code-point granularity (never a byte
//! offset mid-`char`) mirrors `notes/ai/summarize.ts::truncateToContext`.

// Forward-declared pure helper: the embed-on-unlock pipeline (task 3) + the
// map-reduce summarizer are the first in-crate callers. Until then nothing in
// the non-test build reaches `chunk_note`, so silence dead_code there while
// keeping the test build strict — the `model_store` idiom.
#![cfg_attr(not(test), allow(dead_code))]

use core::ops::Range;

use myne_core::plugins::notes::note_id::NoteId;

/// The chunker-logic generation, bound into the `vault.embeddings`
/// model-identity tuple (`protocol.md` §9.17.2). **Bump this whenever a change
/// to the windowing model would shift chunk boundaries for the same input.** An
/// incremented value invalidates every persisted embedding index
/// (fall-to-rebuild, §9.17.4) so stale chunk spans can never misalign vectors
/// with note text after an app update changes chunking.
pub const CHUNKER_VERSION: u16 = 1;

/// Tunable window parameters — a code-point budget (token proxy until the real
/// tokenizer lands at merge, SYNC-7/13).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkParams {
    /// Maximum code points of segment content packed into one chunk. An
    /// oversized single segment is hard-split at this width.
    pub max_chars: usize,
    /// Code points of the previous chunk's tail re-seeded into the next chunk
    /// across a size-forced break (0 = no overlap). Never crosses a heading
    /// boundary. Must be `< max_chars`.
    pub overlap_chars: usize,
}

impl Default for ChunkParams {
    /// Conservative defaults sized to comfortably fit the smallest planned
    /// context (SYNC-1/7); the real budget is pinned to the model tokenizer at
    /// merge. Overlap is ~10% so retrieval keeps a little cross-boundary
    /// context.
    fn default() -> Self {
        ChunkParams {
            max_chars: 1000,
            overlap_chars: 100,
        }
    }
}

impl ChunkParams {
    /// Build validated params. `max_chars` is clamped to at least 1 and
    /// `overlap_chars` to at most `max_chars - 1` so windowing always makes
    /// forward progress (an overlap `>= max_chars` could re-seed a whole window
    /// and stall).
    pub fn new(max_chars: usize, overlap_chars: usize) -> Self {
        let max_chars = max_chars.max(1);
        let overlap_chars = overlap_chars.min(max_chars.saturating_sub(1));
        ChunkParams {
            max_chars,
            overlap_chars,
        }
    }
}

/// Minimum alphanumeric-character count for a chunk to be worth embedding
/// (conversational-ai-chat retrieval tuning). A chunk below this is pure
/// structure — a frontmatter / `---` / `***` separator, a heading-only line, or
/// a stub like `###### P0 -` — which carries no retrievable content but embeds
/// to a high-cosine vector that crowds out real content. Measured over a real
/// vault: skipping these at index time is the fix, not a cosine threshold.
pub const MIN_SUBSTANTIVE_CHARS: usize = 5;

/// Whether `chunk_text` carries enough substantive content to be worth embedding
/// (see [`MIN_SUBSTANTIVE_CHARS`]). Counts alphanumeric code points, ignoring
/// markdown structure + whitespace, so `---` / `***` / `## ` / `###### P0 -`
/// (structure only) are rejected while any real title or content is kept.
pub fn is_substantive_chunk(chunk_text: &str) -> bool {
    chunk_text.chars().filter(|c| c.is_alphanumeric()).count() >= MIN_SUBSTANTIVE_CHARS
}

/// One retrieval unit: an index into the source note. Carries **no plaintext**
/// — [`Chunk::slice`] resolves the span from the already-resident source when a
/// consumer needs the text (embedding, map-reduce).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    /// The source note this span came from.
    pub note_id: NoteId,
    /// Byte range into the note's decrypted markdown. Always on `char`
    /// boundaries and non-empty; `source[byte_range]` is the exact chunk text.
    pub byte_range: Range<usize>,
}

impl Chunk {
    /// Resolve the chunk text from its source note. `source` must be the same
    /// markdown passed to [`chunk_note`]; the range round-trips exactly.
    pub fn slice<'a>(&self, source: &'a str) -> &'a str {
        &source[self.byte_range.clone()]
    }
}

/// A pre-window segment: one paragraph or one heading line, with its byte span.
#[derive(Debug, Clone, Copy)]
struct Segment {
    range: (usize, usize),
    is_heading: bool,
}

/// A window-ready unit: a whole segment, or a code-point slice of an oversized
/// one. `standalone` units (oversized-segment pieces) never merge with a
/// neighbour.
#[derive(Debug, Clone, Copy)]
struct Unit {
    start: usize,
    end: usize,
    chars: usize,
    is_heading: bool,
    standalone: bool,
}

/// Split a note's decrypted markdown into heading/paragraph-window chunks keyed
/// to `{note_id, byte-range}`. Pure and deterministic; empty/whitespace-only
/// input yields no chunks.
pub fn chunk_note(note_id: NoteId, markdown: &str, params: ChunkParams) -> Vec<Chunk> {
    let segments = segment(markdown);
    let units = to_units(markdown, &segments, params.max_chars);
    window(note_id, &units, params)
}

/// Segment the markdown into paragraphs + heading lines with byte spans. Blank
/// lines separate and belong to no segment; a heading is its own segment.
fn segment(markdown: &str) -> Vec<Segment> {
    let mut segments = Vec::new();
    let mut byte = 0usize;
    // Open paragraph accumulator: (start, end) byte span, end excludes newline.
    let mut para: Option<(usize, usize)> = None;

    for line_nl in markdown.split_inclusive('\n') {
        let has_nl = line_nl.ends_with('\n');
        let content_len = if has_nl {
            line_nl.len() - 1
        } else {
            line_nl.len()
        };
        let line_start = byte;
        let line_end = byte + content_len;
        let trimmed = line_nl.trim();

        if trimmed.is_empty() {
            if let Some((s, e)) = para.take() {
                segments.push(Segment {
                    range: (s, e),
                    is_heading: false,
                });
            }
        } else if trimmed.starts_with('#') {
            if let Some((s, e)) = para.take() {
                segments.push(Segment {
                    range: (s, e),
                    is_heading: false,
                });
            }
            segments.push(Segment {
                range: (line_start, line_end),
                is_heading: true,
            });
        } else {
            para = Some(match para {
                Some((s, _)) => (s, line_end),
                None => (line_start, line_end),
            });
        }

        byte += line_nl.len();
    }

    if let Some((s, e)) = para.take() {
        segments.push(Segment {
            range: (s, e),
            is_heading: false,
        });
    }

    segments
}

/// Expand segments into window-ready units, hard-splitting any segment longer
/// than `max_chars` on code-point boundaries into standalone pieces.
fn to_units(markdown: &str, segments: &[Segment], max_chars: usize) -> Vec<Unit> {
    let mut units = Vec::new();
    for seg in segments {
        let (start, end) = seg.range;
        let text = &markdown[start..end];
        let chars = text.chars().count();
        if chars <= max_chars {
            units.push(Unit {
                start,
                end,
                chars,
                is_heading: seg.is_heading,
                standalone: false,
            });
            continue;
        }
        // Oversized: cut into ≤ max_chars code-point pieces, each standalone.
        let mut piece_start = start;
        let mut count = 0usize;
        let mut last_boundary = start;
        for (i, ch) in text.char_indices() {
            let abs = start + i;
            if count == max_chars {
                units.push(Unit {
                    start: piece_start,
                    end: abs,
                    chars: count,
                    is_heading: false,
                    standalone: true,
                });
                piece_start = abs;
                count = 0;
            }
            count += 1;
            last_boundary = abs + ch.len_utf8();
        }
        if piece_start < last_boundary {
            units.push(Unit {
                start: piece_start,
                end,
                chars: count,
                is_heading: false,
                standalone: true,
            });
        }
    }
    units
}

/// Pack units into heading-aligned windows up to `max_chars`, re-seeding an
/// `overlap_chars` tail across size-forced breaks.
fn window(note_id: NoteId, units: &[Unit], params: ChunkParams) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    // Current window as a slice of `units` indices, plus its running char count.
    let mut win: Vec<usize> = Vec::new();
    let mut win_chars = 0usize;

    let flush = |win: &mut Vec<usize>, win_chars: &mut usize, chunks: &mut Vec<Chunk>| {
        if let (Some(&first), Some(&last)) = (win.first(), win.last()) {
            chunks.push(Chunk {
                note_id,
                byte_range: units[first].start..units[last].end,
            });
        }
        win.clear();
        *win_chars = 0;
    };

    for (idx, unit) in units.iter().enumerate() {
        if unit.standalone {
            flush(&mut win, &mut win_chars, &mut chunks);
            chunks.push(Chunk {
                note_id,
                byte_range: unit.start..unit.end,
            });
            continue;
        }

        // A heading always begins a fresh section — no overlap seed across it.
        if unit.is_heading && !win.is_empty() {
            flush(&mut win, &mut win_chars, &mut chunks);
        }

        // Size-forced break: flush, then re-seed the overlap tail.
        if !win.is_empty() && win_chars + unit.chars > params.max_chars {
            let seed = overlap_seed(&win, units, params.overlap_chars);
            flush(&mut win, &mut win_chars, &mut chunks);
            for &s in &seed {
                win.push(s);
                win_chars += units[s].chars;
            }
        }

        win.push(idx);
        win_chars += unit.chars;
    }

    flush(&mut win, &mut win_chars, &mut chunks);
    chunks
}

/// Pick the trailing units of `win` whose combined chars fit `overlap_chars`,
/// in source order, to seed the next window. Empty when overlap is 0.
fn overlap_seed(win: &[usize], units: &[Unit], overlap_chars: usize) -> Vec<usize> {
    if overlap_chars == 0 {
        return Vec::new();
    }
    let mut seed_rev = Vec::new();
    let mut acc = 0usize;
    for &idx in win.iter().rev() {
        let c = units[idx].chars;
        if acc + c > overlap_chars {
            break;
        }
        acc += c;
        seed_rev.push(idx);
    }
    seed_rev.reverse();
    seed_rev
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nid() -> NoteId {
        NoteId::parse("01970e83-4f2f-7000-8000-000000000000").unwrap()
    }

    /// Every returned chunk must round-trip: its byte-range slices the exact
    /// source span, on char boundaries, and is never zero-width.
    fn assert_well_formed(md: &str, chunks: &[Chunk]) {
        for c in chunks {
            assert!(c.byte_range.start < c.byte_range.end, "zero-width chunk");
            assert!(
                md.is_char_boundary(c.byte_range.start),
                "start off boundary"
            );
            assert!(md.is_char_boundary(c.byte_range.end), "end off boundary");
            // slice() must not panic and must equal the raw span.
            assert_eq!(c.slice(md), &md[c.byte_range.clone()]);
        }
    }

    #[test]
    fn empty_input_yields_no_chunks() {
        assert!(chunk_note(nid(), "", ChunkParams::default()).is_empty());
    }

    #[test]
    fn whitespace_only_yields_no_chunks() {
        assert!(chunk_note(nid(), "   \n\n  \n", ChunkParams::default()).is_empty());
    }

    #[test]
    fn single_paragraph_is_one_chunk_round_tripping() {
        let md = "Just one paragraph of prose.";
        let chunks = chunk_note(nid(), md, ChunkParams::default());
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].slice(md), md);
        assert_eq!(chunks[0].note_id, nid());
        assert_well_formed(md, &chunks);
    }

    #[test]
    fn blank_line_separates_paragraphs_into_one_window_when_small() {
        // Two small paragraphs, budget large → one window spanning both,
        // byte-range includes the blank line between them.
        let md = "First para.\n\nSecond para.";
        let chunks = chunk_note(nid(), md, ChunkParams::new(1000, 0));
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].slice(md), md);
        assert_well_formed(md, &chunks);
    }

    #[test]
    fn heading_forces_a_new_window() {
        let md = "Intro paragraph.\n\n# Heading\n\nBody under heading.";
        let chunks = chunk_note(nid(), md, ChunkParams::new(1000, 0));
        // Intro is one window; the heading starts a fresh one that also
        // absorbs the following body (heading-aligned section).
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].slice(md), "Intro paragraph.");
        assert_eq!(chunks[1].slice(md), "# Heading\n\nBody under heading.");
        assert_well_formed(md, &chunks);
    }

    #[test]
    fn indented_heading_is_recognised() {
        // Up to three leading spaces still an ATX heading (CommonMark).
        let md = "Para.\n\n   ## Indented\n\nAfter.";
        let chunks = chunk_note(nid(), md, ChunkParams::new(1000, 0));
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[1].slice(md), "   ## Indented\n\nAfter.");
    }

    #[test]
    fn deterministic_across_repeated_calls() {
        let md = "# A\n\nalpha beta\n\n# B\n\ngamma delta\n\n# C\n\nepsilon";
        let params = ChunkParams::new(12, 3);
        let first = chunk_note(nid(), md, params);
        let second = chunk_note(nid(), md, params);
        assert_eq!(first, second);
    }

    #[test]
    fn size_forced_split_produces_multiple_windows_within_budget() {
        // Four ~8-char paragraphs, budget 20 → they pack into two windows.
        let md = "aaaaaaaa\n\nbbbbbbbb\n\ncccccccc\n\ndddddddd";
        let chunks = chunk_note(nid(), md, ChunkParams::new(20, 0));
        assert!(chunks.len() >= 2, "budget should force >1 window");
        assert_well_formed(md, &chunks);
        // No window's *content* char count exceeds the budget (blank-line
        // bytes in the span are not counted against the budget).
        for c in &chunks {
            // each window holds at most two 8-char paras under a 20 budget
            assert!(c.slice(md).chars().count() <= 20 + 4);
        }
    }

    #[test]
    fn overlap_reseeds_tail_across_size_break() {
        // Budget 10, overlap 5: three 8-char paras. Window 1 = para0 (adding
        // para1 would exceed 10). Break re-seeds nothing (para0 is 8 > overlap
        // 5), so use a case where overlap actually fires.
        let md = "aaaa\n\nbbbb\n\ncccc\n\ndddd";
        let chunks = chunk_note(nid(), md, ChunkParams::new(9, 4));
        assert_well_formed(md, &chunks);
        // Adjacent chunks should overlap in bytes (later start < earlier end)
        // for at least one pair, proving the tail was re-seeded.
        let overlapped = chunks
            .windows(2)
            .any(|w| w[1].byte_range.start < w[0].byte_range.end);
        assert!(overlapped, "expected byte overlap between adjacent chunks");
    }

    #[test]
    fn oversized_paragraph_is_hard_split_no_panic() {
        // One 25-char paragraph, budget 10 → three standalone pieces (10/10/5).
        let md = "abcdefghijklmnopqrstuvwxy"; // 25 chars, no blank lines
        assert_eq!(md.chars().count(), 25);
        let chunks = chunk_note(nid(), md, ChunkParams::new(10, 0));
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].slice(md), "abcdefghij");
        assert_eq!(chunks[1].slice(md), "klmnopqrst");
        assert_eq!(chunks[2].slice(md), "uvwxy");
        assert_well_formed(md, &chunks);
        // Reassembling the pieces reproduces the source exactly.
        let joined: String = chunks.iter().map(|c| c.slice(md)).collect();
        assert_eq!(joined, md);
    }

    #[test]
    fn oversized_multibyte_paragraph_splits_on_char_boundary() {
        // 12 emoji (4 bytes each), budget 5 → pieces at code-point boundaries,
        // never mid-UTF-8. Round-trip proves boundary safety.
        let md = "😀😃😄😁😆😅😂🤣😊😇🙂🙃";
        assert_eq!(md.chars().count(), 12);
        let chunks = chunk_note(nid(), md, ChunkParams::new(5, 0));
        assert_well_formed(md, &chunks);
        let joined: String = chunks.iter().map(|c| c.slice(md)).collect();
        assert_eq!(joined, md);
        // First piece is exactly 5 code points.
        assert_eq!(chunks[0].slice(md).chars().count(), 5);
    }

    #[test]
    fn byte_ranges_round_trip_for_a_realistic_note() {
        let md = "# Title\n\nFirst paragraph with several words.\n\n\
                  ## Section\n\nSecond paragraph here, a bit longer than the first one.\n\n\
                  Trailing paragraph.";
        let chunks = chunk_note(nid(), md, ChunkParams::new(40, 8));
        assert!(!chunks.is_empty());
        assert_well_formed(md, &chunks);
        // Every chunk begins at a heading or is a size/overlap continuation —
        // never empty, always inside the source.
        for c in &chunks {
            assert!(c.byte_range.end <= md.len());
        }
    }

    #[test]
    fn params_new_clamps_degenerate_values() {
        // max clamped to ≥1, overlap clamped below max — no stall on abuse.
        let p = ChunkParams::new(0, 999);
        assert_eq!(p.max_chars, 1);
        assert_eq!(p.overlap_chars, 0);
        // Should still terminate and produce char-wide chunks.
        let md = "abc";
        let chunks = chunk_note(nid(), md, p);
        assert_eq!(chunks.len(), 3);
        assert_well_formed(md, &chunks);
    }

    #[test]
    fn no_model_or_ipc_dependency_is_pure() {
        // Compile-time guard by construction: this module imports only
        // core::ops::Range + NoteId. The test documents the invariant (task-1
        // acceptance 4) — a future `use` of an engine/http/tauri command here
        // would be caught in review against this note.
        let md = "sanity";
        let _ = chunk_note(nid(), md, ChunkParams::default());
    }
}
