// SPDX-License-Identifier: AGPL-3.0
//! Per-page footer stamper for the exported PDF (MYND-255 hotfix,
//! owner-requested).
//!
//! Post-processes the captured `%PDF` bytes (lopdf full parse + full
//! rewrite save) to draw a Notion-like footer on every page: the
//! document title bottom-left, an `X / Y` page counter bottom-right,
//! both in 9 pt base-14 Helvetica, muted gray. The footer carries
//! **user content only** (the note's own title + page numbers) — it is
//! explicitly NOT branding; the no-watermark posture
//! (`design-notes.md` 2026-06-11 PDF-pipeline entry) is about
//! Myne-identifying marks, and none appear here (resource names are
//! neutral `FtrN`).
//!
//! # Mechanics
//!
//! - Each page's `Contents` becomes `[q-prefix, …original…, footer]`:
//!   a shared one-byte-op `q\n` stream is prepended and the footer
//!   stream (which opens with the balancing `Q`) appended, so the
//!   footer always draws in the page's **default coordinate space**
//!   even when the engine's own content leaves the CTM transformed.
//!   The footer's own ops are additionally wrapped `q … Q`.
//! - The footer streams are stored **uncompressed** (no `Filter`), so
//!   smoke checks and tests can grep the raw PDF bytes for the title
//!   and counters.
//! - The Helvetica font resource is **merged** into each page's
//!   effective `/Resources` (own or inherited via the `Pages` tree):
//!   the effective dict is cloned, the font added under a fresh
//!   probed name (`Ftr0`, `Ftr1`, …), and the merged clone set on the
//!   page itself — existing entries (and dicts shared via references)
//!   are never clobbered.
//! - Geometry comes from each page's effective `MediaBox` (own or
//!   inherited): title baseline at `lly + 28 pt`, left edge at
//!   `llx + 56.7 pt` (≈ 20 mm, matching the print CSS page margin);
//!   the counter right-aligned ending at `urx − 56.7 pt`.
//!
//! # Known edges (accepted)
//!
//! - **`/Rotate` pages are stamped in unrotated coordinates.** A page
//!   carrying `/Rotate 90/180/270` shows the footer along the
//!   pre-rotation bottom edge (i.e. a side or the top of the viewed
//!   page). The capture pipeline never emits rotated pages (the print
//!   engines write upright portrait/landscape media), so this is a
//!   theoretical edge documented rather than special-cased.
//! - **Encoding is WinAnsi (CP1252)** — the base-14 Helvetica limit.
//!   The title is folded to CP1252 with a dedicated Turkish fold table
//!   for the six letters CP1252 lacks (ş→s, Ş→S, ğ→g, Ğ→G, ı→i, İ→I);
//!   anything else unencodable becomes `?`. Titles in scripts outside
//!   Latin-1/CP1252 therefore degrade to `?` runs — accepted for a
//!   cosmetic footer (the document body renders the real glyphs).
//! - **Width metrics**: the counter uses the exact Helvetica widths
//!   (digits 556/1000 em uniformly, space 278, slash 278). Title
//!   truncation measures ASCII with the full Helvetica AFM table and
//!   approximates high-CP1252 bytes at 556 (em dash and ellipsis
//!   pinned at their real 1000) — measurement-only approximation; the
//!   drawn glyphs are always correct.
//!
//! Logging discipline: this module logs nothing itself (closed
//! [`FooterStampError`] kinds bubble to the caller, which emits the
//! stage-tagged warn). The title never reaches any log.

use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};

/// Left/right footer margin: 56.7 pt ≈ 20 mm, lockstep with the print
/// stylesheet's `@page { margin: 20mm }`.
const MARGIN_PT: f64 = 56.7;
/// Footer baseline, points above the page's bottom media edge.
const BASELINE_PT: f64 = 28.0;
/// Footer font size (pt).
const FONT_SIZE_PT: f64 = 9.0;
/// Minimum gap between the title and the page counter (pt).
const TITLE_COUNTER_GAP_PT: f64 = 18.0;
/// Muted gray fill — matches the print stylesheet's muted ink.
const FILL_GRAY: &str = "0.42 0.42 0.39 rg";
/// CP1252 horizontal ellipsis, used as the truncation mark.
const ELLIPSIS_BYTE: u8 = 0x85;

/// Closed failure taxonomy for the stamp pass. Variant names are the
/// only thing that may reach logs (DENY-list discipline — lopdf's own
/// error payloads can embed document content and are never surfaced).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FooterStampError {
    /// The bytes did not parse as a PDF document.
    Parse,
    /// The document parsed but exposes no pages.
    NoPages,
    /// A page's effective `MediaBox` is missing or malformed.
    PageGeometry,
    /// A page object is structurally not a dictionary (or the
    /// catalog tree is malformed mid-walk).
    Malformed,
    /// Serializing the stamped document failed.
    Save,
}

impl FooterStampError {
    /// Static-string label for logging (the `pdf_export_error_kind`
    /// discipline — a new variant compile-fails this match).
    pub(crate) fn kind(self) -> &'static str {
        match self {
            FooterStampError::Parse => "Parse",
            FooterStampError::NoPages => "NoPages",
            FooterStampError::PageGeometry => "PageGeometry",
            FooterStampError::Malformed => "Malformed",
            FooterStampError::Save => "Save",
        }
    }
}

/// Stamp the Notion-like footer (title bottom-left, `X / Y` counter
/// bottom-right) onto every page of `pdf_bytes` and return the
/// re-serialized document (full rewrite, classic xref).
///
/// See the module docs for encoding (CP1252 + Turkish fold), geometry,
/// truncation, and the `/Rotate` edge. Errors are the closed
/// [`FooterStampError`] kinds; the caller is expected to **fail open**
/// (publish the unstamped capture) — the footer is cosmetic.
pub(crate) fn stamp_footer(pdf_bytes: &[u8], title: &str) -> Result<Vec<u8>, FooterStampError> {
    let mut doc = Document::load_mem(pdf_bytes).map_err(|_| FooterStampError::Parse)?;

    let pages = doc.get_pages();
    let total = pages.len() as u32;
    if total == 0 {
        return Err(FooterStampError::NoPages);
    }

    // One shared font object + one shared `q` prefix stream for the
    // whole document; per-page footer streams reference them.
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
        // WinAnsi = CP1252: makes the encoded title bytes mean what
        // the fold table produced (StandardEncoding diverges ≥ 0x80).
        "Encoding" => "WinAnsiEncoding",
    });
    let prefix_id = doc.add_object(Stream::new(Dictionary::new(), b"q\n".to_vec()));

    let title = {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            "Untitled"
        } else {
            trimmed
        }
    };
    let title_bytes = encode_cp1252(title);

    for (page_no, page_id) in pages {
        // Immutable reads first (media box + resources walk + existing
        // contents), then the mutation phase on the page dict.
        let media = resolve_media_box(&doc, page_id)?;
        let (merged_resources, font_name) = merge_font_resources(&doc, page_id, font_id)?;
        let contents_items = existing_contents_items(&mut doc, page_id)?;

        let content = footer_content(&font_name, &title_bytes, page_no, total, media);
        let footer_id = doc.add_object(Stream::new(Dictionary::new(), content));

        let mut items: Vec<Object> = Vec::with_capacity(contents_items.len() + 2);
        items.push(prefix_id.into());
        items.extend(contents_items);
        items.push(footer_id.into());

        let page_dict = doc
            .get_object_mut(page_id)
            .ok()
            .and_then(|o| o.as_dict_mut().ok())
            .ok_or(FooterStampError::Malformed)?;
        page_dict.set("Resources", Object::Dictionary(merged_resources));
        page_dict.set("Contents", Object::Array(items));
    }

    let mut out = Vec::with_capacity(pdf_bytes.len() + 1024);
    doc.save_to(&mut out).map_err(|_| FooterStampError::Save)?;
    Ok(out)
}

// ---- geometry --------------------------------------------------------------

/// Effective media box `[llx, lly, urx, ury]` in points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct MediaBox {
    pub llx: f64,
    pub lly: f64,
    pub urx: f64,
    pub ury: f64,
}

/// Resolve a page's effective `MediaBox` — own entry first, then the
/// inheritable `Pages`-tree walk via `Parent` (bounded against cycles).
fn resolve_media_box(doc: &Document, page_id: ObjectId) -> Result<MediaBox, FooterStampError> {
    let obj = find_inherited(doc, page_id, b"MediaBox")?.ok_or(FooterStampError::PageGeometry)?;
    let arr = match deref(doc, obj) {
        Some(Object::Array(arr)) if arr.len() == 4 => arr,
        _ => return Err(FooterStampError::PageGeometry),
    };
    let mut n = [0f64; 4];
    for (slot, item) in n.iter_mut().zip(arr.iter()) {
        *slot = as_number(doc, item).ok_or(FooterStampError::PageGeometry)?;
    }
    let media = MediaBox {
        llx: n[0].min(n[2]),
        lly: n[1].min(n[3]),
        urx: n[0].max(n[2]),
        ury: n[1].max(n[3]),
    };
    if media.urx - media.llx <= 0.0 || media.ury - media.lly <= 0.0 {
        return Err(FooterStampError::PageGeometry);
    }
    Ok(media)
}

/// Walk `key` up the page → `Pages` parent chain (inheritable page
/// attributes). Depth-bounded so a cyclic `Parent` graph terminates.
fn find_inherited<'a>(
    doc: &'a Document,
    page_id: ObjectId,
    key: &[u8],
) -> Result<Option<&'a Object>, FooterStampError> {
    let mut current = page_id;
    for _ in 0..64 {
        let dict = doc
            .get_object(current)
            .ok()
            .and_then(|o| o.as_dict().ok())
            .ok_or(FooterStampError::Malformed)?;
        if let Ok(obj) = dict.get(key) {
            return Ok(Some(obj));
        }
        match dict.get(b"Parent").ok().and_then(|p| p.as_reference().ok()) {
            Some(parent) => current = parent,
            None => return Ok(None),
        }
    }
    Ok(None)
}

/// One level of indirection: a `Reference` resolves to its target,
/// anything else passes through.
fn deref<'a>(doc: &'a Document, obj: &'a Object) -> Option<&'a Object> {
    match obj {
        Object::Reference(id) => doc.get_object(*id).ok(),
        other => Some(other),
    }
}

fn as_number(doc: &Document, obj: &Object) -> Option<f64> {
    match deref(doc, obj)? {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(f64::from(*r)),
        _ => None,
    }
}

// ---- resources -------------------------------------------------------------

/// Build the page's merged `/Resources`: a clone of the effective dict
/// (own or inherited, references resolved) with the footer font added
/// to a cloned `/Font` sub-dict under a fresh probed name. The clone
/// is what gets set on the page — shared/inherited dicts are never
/// mutated, existing entries never clobbered.
fn merge_font_resources(
    doc: &Document,
    page_id: ObjectId,
    font_id: ObjectId,
) -> Result<(Dictionary, String), FooterStampError> {
    let mut resources = match find_inherited(doc, page_id, b"Resources")? {
        Some(obj) => match deref(doc, obj) {
            Some(Object::Dictionary(dict)) => dict.clone(),
            // A Resources entry that is not a dictionary is malformed,
            // but a missing one is legal — treat non-dict as empty
            // rather than failing the whole stamp.
            _ => Dictionary::new(),
        },
        None => Dictionary::new(),
    };

    let mut fonts = match resources.get(b"Font").ok().and_then(|f| deref(doc, f)) {
        Some(Object::Dictionary(dict)) => dict.clone(),
        _ => Dictionary::new(),
    };

    // Probe a name the page does not already use (never clobber).
    let mut idx = 0u32;
    let font_name = loop {
        let candidate = format!("Ftr{idx}");
        if !fonts.has(candidate.as_bytes()) {
            break candidate;
        }
        idx += 1;
    };
    fonts.set(font_name.as_bytes(), Object::Reference(font_id));
    resources.set("Font", Object::Dictionary(fonts));
    Ok((resources, font_name))
}

// ---- contents --------------------------------------------------------------

/// The page's existing `Contents` flattened to an item list of
/// references (single ref, ref-to-array, direct array, or — tolerated
/// non-compliance — a direct stream, which gets promoted to its own
/// object). Missing `Contents` yields an empty list.
fn existing_contents_items(
    doc: &mut Document,
    page_id: ObjectId,
) -> Result<Vec<Object>, FooterStampError> {
    let existing = {
        let dict = doc
            .get_object(page_id)
            .ok()
            .and_then(|o| o.as_dict().ok())
            .ok_or(FooterStampError::Malformed)?;
        dict.get(b"Contents").ok().cloned()
    };
    Ok(match existing {
        None => Vec::new(),
        Some(Object::Array(items)) => items,
        Some(Object::Reference(id)) => match doc.get_object(id) {
            // A reference to an array of streams: splice the items so
            // the prefix/footer wrap the same flat list.
            Ok(Object::Array(items)) => items.clone(),
            _ => vec![id.into()],
        },
        Some(stream @ Object::Stream(_)) => vec![doc.add_object(stream).into()],
        // Anything else is malformed; drop it rather than reference a
        // non-stream from the rebuilt array.
        Some(_) => Vec::new(),
    })
}

// ---- footer content stream -------------------------------------------------

/// Build the footer content stream for one page. Opens with `Q`
/// (balancing the shared `q` prefix stream — restores the default
/// coordinate space) and wraps its own drawing in `q … Q`.
fn footer_content(
    font_name: &str,
    title_bytes: &[u8],
    page_no: u32,
    total: u32,
    media: MediaBox,
) -> Vec<u8> {
    let counter = format!("{page_no} / {total}");
    let counter_width_pt = text_width_milli(counter.as_bytes()) as f64 * FONT_SIZE_PT / 1000.0;

    let available_pt =
        (media.urx - media.llx) - 2.0 * MARGIN_PT - counter_width_pt - TITLE_COUNTER_GAP_PT;
    let title_fit = truncate_to_width(title_bytes, available_pt);

    let x_left = media.llx + MARGIN_PT;
    let x_right = media.urx - MARGIN_PT - counter_width_pt;
    let y = media.lly + BASELINE_PT;

    let mut out: Vec<u8> = Vec::with_capacity(196 + title_fit.len());
    out.extend_from_slice(b"Q\nq\n");
    out.extend_from_slice(FILL_GRAY.as_bytes());
    out.extend_from_slice(b"\n");
    if !title_fit.is_empty() {
        out.extend_from_slice(b"BT\n/");
        out.extend_from_slice(font_name.as_bytes());
        out.extend_from_slice(format!(" {} Tf\n", fmt_pt(FONT_SIZE_PT)).as_bytes());
        out.extend_from_slice(format!("{} {} Td\n", fmt_pt(x_left), fmt_pt(y)).as_bytes());
        out.extend_from_slice(b"(");
        out.extend_from_slice(&escape_pdf_string(&title_fit));
        out.extend_from_slice(b") Tj\nET\n");
    }
    out.extend_from_slice(b"BT\n/");
    out.extend_from_slice(font_name.as_bytes());
    out.extend_from_slice(format!(" {} Tf\n", fmt_pt(FONT_SIZE_PT)).as_bytes());
    out.extend_from_slice(format!("{} {} Td\n", fmt_pt(x_right), fmt_pt(y)).as_bytes());
    out.extend_from_slice(b"(");
    out.extend_from_slice(&escape_pdf_string(counter.as_bytes()));
    out.extend_from_slice(b") Tj\nET\nQ\n");
    out
}

/// Format a point value: two decimals, trailing zeros (and a bare
/// trailing dot) trimmed — `56.70` → `56.7`, `28.00` → `28`.
fn fmt_pt(v: f64) -> String {
    let s = format!("{v:.2}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    s.to_string()
}

/// Escape the PDF literal-string specials `( ) \`.
fn escape_pdf_string(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    for &b in bytes {
        if matches!(b, b'(' | b')' | b'\\') {
            out.push(b'\\');
        }
        out.push(b);
    }
    out
}

/// Truncate CP1252-encoded `bytes` so the rendered width fits
/// `available_pt`, appending `…` (CP1252 `0x85`) when anything was
/// dropped. Degenerate widths (counter + gap already overflow the
/// page) yield an empty title.
fn truncate_to_width(bytes: &[u8], available_pt: f64) -> Vec<u8> {
    let fits = |b: &[u8]| text_width_milli(b) as f64 * FONT_SIZE_PT / 1000.0 <= available_pt;
    if fits(bytes) {
        return bytes.to_vec();
    }
    let mut kept = bytes.to_vec();
    loop {
        match kept.pop() {
            None => return Vec::new(),
            Some(_) => {
                kept.push(ELLIPSIS_BYTE);
                if fits(&kept) {
                    return kept;
                }
                kept.pop(); // remove the ellipsis, drop another char
            }
        }
    }
}

// ---- CP1252 encoding + Helvetica metrics ------------------------------------

/// Encode `title` to CP1252 (WinAnsi) bytes: ASCII passes through, the
/// Turkish set CP1252 lacks folds (ş→s, Ş→S, ğ→g, Ğ→G, ı→i, İ→I),
/// CP1252-representable Unicode maps to its byte, everything else
/// becomes `?`.
pub(crate) fn encode_cp1252(title: &str) -> Vec<u8> {
    title.chars().map(encode_cp1252_char).collect()
}

fn encode_cp1252_char(c: char) -> u8 {
    match c {
        // Turkish fold — the six letters missing from CP1252.
        'ş' => b's',
        'Ş' => b'S',
        'ğ' => b'g',
        'Ğ' => b'G',
        'ı' => b'i',
        'İ' => b'I',
        // Printable ASCII.
        '\u{20}'..='\u{7E}' => c as u8,
        // Latin-1 high range maps 1:1.
        '\u{A0}'..='\u{FF}' => c as u8,
        // CP1252 0x80–0x9F specials.
        '€' => 0x80,
        '‚' => 0x82,
        'ƒ' => 0x83,
        '„' => 0x84,
        '…' => 0x85,
        '†' => 0x86,
        '‡' => 0x87,
        'ˆ' => 0x88,
        '‰' => 0x89,
        'Š' => 0x8A,
        '‹' => 0x8B,
        'Œ' => 0x8C,
        'Ž' => 0x8E,
        '\u{2018}' => 0x91,
        '\u{2019}' => 0x92,
        '\u{201C}' => 0x93,
        '\u{201D}' => 0x94,
        '•' => 0x95,
        '–' => 0x96,
        '—' => 0x97,
        '˜' => 0x98,
        '™' => 0x99,
        'š' => 0x9A,
        '›' => 0x9B,
        'œ' => 0x9C,
        'ž' => 0x9E,
        'Ÿ' => 0x9F,
        _ => b'?',
    }
}

/// Helvetica advance widths in 1/1000 em for printable ASCII
/// (0x20–0x7E), straight from the Adobe core-14 AFM. Digits are
/// uniformly 556, space 278, slash 278 — the counter math relies on
/// exactly those three rows.
#[rustfmt::skip]
const HELVETICA_ASCII_MILLI: [u16; 95] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, // sp ! " # $ % & ' ( )
    389, 584, 278, 333, 278, 278,                     // * + , - . /
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, // 0-9
    278, 278, 584, 584, 584, 556, 1015,               // : ; < = > ? @
    667, 667, 722, 722, 667, 611, 778, 722, 278, 500, // A-J
    667, 556, 833, 722, 778, 667, 778, 722, 667, 611, // K-T
    722, 667, 944, 667, 667, 611,                     // U-Z
    278, 278, 278, 469, 556, 333,                     // [ \ ] ^ _ `
    556, 556, 500, 556, 556, 278, 556, 556, 222, 222, // a-j
    500, 222, 833, 556, 556, 556, 556, 333, 500, 278, // k-t
    556, 500, 722, 500, 500, 500,                     // u-z
    334, 260, 334, 584,                               // { | } ~
];

/// Advance width of one CP1252 byte in 1/1000 em. ASCII is exact
/// (AFM table above); high bytes approximate at 556 with the two
/// width-extreme footer-relevant glyphs pinned (em dash + ellipsis,
/// both 1000) — measurement-only, see the module docs.
fn byte_width_milli(b: u8) -> u16 {
    match b {
        0x20..=0x7E => HELVETICA_ASCII_MILLI[(b - 0x20) as usize],
        0x85 | 0x97 => 1000, // ellipsis, em dash
        _ => 556,
    }
}

/// Total advance width of a CP1252 byte string in 1/1000 em.
pub(crate) fn text_width_milli(bytes: &[u8]) -> u32 {
    bytes.iter().map(|&b| u32::from(byte_width_milli(b))).sum()
}

// ---- test support ------------------------------------------------------------

/// Build a tiny n-page PDF entirely via lopdf: `MediaBox` + a seed
/// `/Resources` (with an existing `F1` font entry) inherited from the
/// `Pages` node, one marker content stream per page. Used by this
/// module's tests and the command-layer wiring tests.
#[cfg(test)]
pub(crate) fn tiny_test_pdf(page_count: usize) -> Vec<u8> {
    tiny_test_pdf_with(page_count, [0, 0, 595, 842], None)
}

#[cfg(test)]
pub(crate) fn tiny_test_pdf_with(
    page_count: usize,
    media_box: [i64; 4],
    rotate: Option<i64>,
) -> Vec<u8> {
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let seed_font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Courier",
    });
    let mut kids: Vec<Object> = Vec::new();
    for i in 0..page_count {
        let marker = format!("1 0 0 1 {} {} cm\n", 10 + i, 10 + i).into_bytes();
        let content_id = doc.add_object(Stream::new(Dictionary::new(), marker));
        let mut page = dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference(pages_id),
            "Contents" => Object::Reference(content_id),
        };
        if let Some(deg) = rotate {
            page.set("Rotate", deg);
        }
        kids.push(doc.add_object(page).into());
    }
    let count = page_count as i64;
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => kids,
            "Count" => count,
            // Inherited attributes: the stamper must walk Parent for
            // BOTH of these and must merge (not clobber) F1.
            "MediaBox" => media_box.iter().map(|&v| v.into()).collect::<Vec<Object>>(),
            "Resources" => dictionary! {
                "Font" => dictionary! { "F1" => Object::Reference(seed_font_id) },
            },
        }),
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_id),
    });
    doc.trailer.set("Root", catalog_id);
    let mut out = Vec::new();
    doc.save_to(&mut out).expect("tiny test pdf serializes");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Decoded, concatenated content of one page of a stamped doc.
    fn page_content(doc: &Document, page_no: u32) -> Vec<u8> {
        let pages = doc.get_pages();
        let &page_id = pages.get(&page_no).expect("page exists");
        doc.get_page_content(page_id)
            .expect("page content readable")
    }

    /// Page content as owned text (lossy — high CP1252 bytes are not
    /// what these call sites assert on).
    fn page_text(doc: &Document, page_no: u32) -> String {
        String::from_utf8_lossy(&page_content(doc, page_no)).into_owned()
    }

    fn stamped(page_count: usize, title: &str) -> (Vec<u8>, Document) {
        let original = tiny_test_pdf(page_count);
        let out = stamp_footer(&original, title).expect("stamp succeeds");
        let doc = Document::load_mem(&out).expect("stamped doc parses");
        (out, doc)
    }

    // ---- end-to-end stamping -------------------------------------------

    #[test]
    fn stamps_title_and_counter_on_every_page() {
        let (bytes, doc) = stamped(2, "Quarterly Report");
        assert_eq!(doc.get_pages().len(), 2, "page count preserved");

        let p1 = page_content(&doc, 1);
        let p2 = page_content(&doc, 2);
        for (content, counter, marker) in [
            (&p1, "(1 / 2) Tj", "1 0 0 1 10 10 cm"),
            (&p2, "(2 / 2) Tj", "1 0 0 1 11 11 cm"),
        ] {
            let text = String::from_utf8_lossy(content);
            assert!(text.contains("(Quarterly Report) Tj"), "title on page");
            assert!(text.contains(counter), "counter on page");
            assert!(text.contains(marker), "original content preserved");
            assert!(text.contains(FILL_GRAY), "muted gray fill");
            // The q-prefix precedes the original marker; the footer's
            // balancing Q comes after it (default-space sandwich).
            let q = text.find("q\n").expect("prefix q");
            let marker_at = text.find(marker).expect("marker");
            let balancing_q = text[marker_at..].find("Q\n").expect("balancing Q") + marker_at;
            assert!(q < marker_at && marker_at < balancing_q);
        }

        // Footer streams are uncompressed — the raw bytes are greppable.
        let raw = String::from_utf8_lossy(&bytes);
        assert!(raw.contains("(Quarterly Report) Tj"));
        assert!(raw.contains("(1 / 2) Tj"));
        assert!(raw.contains("(2 / 2) Tj"));
    }

    #[test]
    fn font_resource_merged_not_clobbered() {
        let (_, doc) = stamped(2, "T");
        for (_, page_id) in doc.get_pages() {
            let page = doc.get_dictionary(page_id).expect("page dict");
            // The merged Resources now live on the page itself.
            let resources = page
                .get(b"Resources")
                .and_then(|r| r.as_dict())
                .expect("page-level merged resources");
            let fonts = resources
                .get(b"Font")
                .and_then(|f| f.as_dict())
                .expect("font dict");
            assert!(fonts.has(b"F1"), "pre-existing font entry survives");
            let footer_font_id = fonts
                .get(b"Ftr0")
                .and_then(|f| f.as_reference())
                .expect("footer font under the probed name");
            let font = doc.get_dictionary(footer_font_id).expect("font object");
            assert_eq!(
                font.get(b"BaseFont").unwrap().as_name().unwrap(),
                b"Helvetica"
            );
            assert_eq!(
                font.get(b"Encoding").unwrap().as_name().unwrap(),
                b"WinAnsiEncoding"
            );
        }
    }

    #[test]
    fn empty_or_whitespace_title_falls_back_to_untitled() {
        let (_, doc) = stamped(1, "   ");
        let text = page_text(&doc, 1);
        assert!(text.contains("(Untitled) Tj"));
    }

    #[test]
    fn rotated_page_is_still_stamped_in_unrotated_coords() {
        let original = tiny_test_pdf_with(1, [0, 0, 595, 842], Some(90));
        let out = stamp_footer(&original, "Rotated").expect("stamp succeeds");
        let doc = Document::load_mem(&out).expect("parses");
        let text = page_text(&doc, 1);
        // Same coordinates as an unrotated page — the documented edge.
        assert!(text.contains("(Rotated) Tj"));
        assert!(text.contains("56.7 28 Td"));
    }

    #[test]
    fn nonzero_media_box_origin_offsets_the_footer() {
        let original = tiny_test_pdf_with(1, [20, 30, 615, 872], None);
        let out = stamp_footer(&original, "T").expect("stamp succeeds");
        let doc = Document::load_mem(&out).expect("parses");
        let text = page_text(&doc, 1);
        // llx + 56.7 = 76.7; lly + 28 = 58.
        assert!(text.contains("76.7 58 Td"), "title offset by origin");
    }

    // ---- right-align math -------------------------------------------------

    #[test]
    fn counter_is_right_aligned_from_exact_helvetica_widths() {
        // "1 / 2" = digit + space + slash + space + digit
        //         = 556 + 278 + 278 + 278 + 556 = 1946 milli-em
        // at 9 pt → 17.514 pt; x = 595 − 56.7 − 17.514 = 520.786 → 520.79.
        assert_eq!(text_width_milli(b"1 / 2"), 1946);
        let (_, doc) = stamped(2, "T");
        let text = page_text(&doc, 1);
        assert!(
            text.contains("520.79 28 Td"),
            "exact right-aligned x: {text}"
        );

        // Multi-digit: "12 / 34" = 4×556 + 2×278 + 278 = 3058 milli-em.
        assert_eq!(text_width_milli(b"12 / 34"), 3058);
    }

    #[test]
    fn title_baseline_and_left_margin_are_pinned() {
        let (_, doc) = stamped(1, "T");
        let text = page_text(&doc, 1);
        assert!(
            text.contains("56.7 28 Td"),
            "x = 56.7 pt, baseline y = 28 pt"
        );
        assert!(
            text.contains("/Ftr0 9 Tf"),
            "9 pt Helvetica under the probed name"
        );
    }

    // ---- encoding ---------------------------------------------------------

    #[test]
    fn turkish_fold_table_folds_the_six_missing_letters() {
        assert_eq!(encode_cp1252("şŞğĞıİ"), b"sSgGiI".to_vec());
        // Turkish letters CP1252 DOES have pass through as Latin-1.
        assert_eq!(
            encode_cp1252("çÇöÖüÜ"),
            vec![0xE7, 0xC7, 0xF6, 0xD6, 0xFC, 0xDC]
        );
    }

    #[test]
    fn unencodable_chars_become_question_marks() {
        assert_eq!(encode_cp1252("a😀b"), b"a?b".to_vec());
        assert_eq!(encode_cp1252("漢字"), b"??".to_vec());
        // CP1252 specials map to their high bytes, not '?'.
        assert_eq!(encode_cp1252("€…—"), vec![0x80, 0x85, 0x97]);
    }

    #[test]
    fn folded_title_lands_in_the_stamped_stream() {
        // Only the six CP1252-missing letters fold; ç/ö/ü etc. would
        // pass through as Latin-1 bytes (covered by the encode tests).
        let (bytes, _) = stamped(1, "Işık Şarkı Dağı");
        let raw = String::from_utf8_lossy(&bytes);
        assert!(raw.contains("(Isik Sarki Dagi) Tj"), "folded CP1252 title");
    }

    // ---- escaping ----------------------------------------------------------

    #[test]
    fn pdf_string_specials_are_escaped() {
        assert_eq!(escape_pdf_string(b"a(b)c\\d"), b"a\\(b\\)c\\\\d".to_vec());
        let (_, doc) = stamped(1, r"Plan (v2) \ final");
        let text = page_text(&doc, 1);
        assert!(text.contains(r"(Plan \(v2\) \\ final) Tj"));
    }

    // ---- truncation ---------------------------------------------------------

    #[test]
    fn long_title_truncates_with_ellipsis_and_fits() {
        let long = "An exceptionally long document title that cannot possibly fit \
                    within the footer area of a normal A4 page at nine points "
            .repeat(3);
        let (_, doc) = stamped(1, &long);
        let content = page_content(&doc, 1);
        // Find the title literal byte-exactly (the ellipsis byte 0x85
        // is not UTF-8 — no lossy detour): between "(" and ") Tj".
        fn find_sub(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
            haystack[from..]
                .windows(needle.len())
                .position(|w| w == needle)
                .map(|p| p + from)
        }
        let start = find_sub(&content, b"(An exceptionally", 0).expect("truncated title present");
        let end = find_sub(&content, b") Tj", start).expect("title literal closes");
        let drawn = &content[start + 1..end];
        assert_eq!(
            *drawn.last().expect("nonempty"),
            ELLIPSIS_BYTE,
            "ends with …"
        );
        assert!(drawn.len() < long.len(), "actually truncated");

        // And the drawn run measures within the available width.
        let counter_w = text_width_milli(b"1 / 1") as f64 * FONT_SIZE_PT / 1000.0;
        let available = (595.0 - 0.0) - 2.0 * MARGIN_PT - counter_w - TITLE_COUNTER_GAP_PT;
        let drawn_w = text_width_milli(drawn) as f64 * FONT_SIZE_PT / 1000.0;
        assert!(drawn_w <= available, "{drawn_w} <= {available}");
    }

    #[test]
    fn truncate_helper_is_exact_at_the_boundary() {
        // 10 × 'M' (833 each) = 8330 milli-em → 74.97 pt at 9 pt.
        let bytes = vec![b'M'; 10];
        assert_eq!(truncate_to_width(&bytes, 74.97), bytes, "fits untouched");
        let cut = truncate_to_width(&bytes, 70.0);
        assert_eq!(*cut.last().unwrap(), ELLIPSIS_BYTE);
        assert!(text_width_milli(&cut) as f64 * FONT_SIZE_PT / 1000.0 <= 70.0);
        // Degenerate: no room at all → empty, never panics.
        assert_eq!(truncate_to_width(&bytes, 0.5), Vec::<u8>::new());
    }

    // ---- failure taxonomy ----------------------------------------------------

    #[test]
    fn corrupt_input_is_a_parse_error() {
        let err = stamp_footer(b"%PDF-1.7 not actually a pdf", "T").expect_err("must reject");
        assert_eq!(err, FooterStampError::Parse);
        assert_eq!(err.kind(), "Parse");
    }

    #[test]
    fn truncated_real_pdf_is_a_parse_error() {
        let full = tiny_test_pdf(1);
        let err = stamp_footer(&full[..full.len() / 2], "T").expect_err("must reject");
        assert_eq!(err, FooterStampError::Parse);
    }

    #[test]
    fn stamped_output_remains_a_loadable_pdf_with_pdf_magic() {
        let (bytes, _) = stamped(2, "T");
        assert!(bytes.starts_with(b"%PDF"), "magic preserved");
    }
}
