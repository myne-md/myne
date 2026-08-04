//! On-device attachment text extraction for search (MYND-328; `protocol.md`
//! § 9.15). Pulls searchable text out of an attachment's decrypted plaintext so
//! a note becomes findable by the contents of the files embedded in it.
//!
//! v0.1 scope — the **text layer only**:
//! - **PDF** via the `lopdf` already shipped for export footer-stamping
//!   (`Document::extract_text`); zero new dependencies. A scanned/image-only
//!   PDF has no text layer and yields `Empty` until the OCR layer (MYND-441).
//! - **DOCX** (`.docx` OOXML) via `zip` + `quick-xml`: unpack `word/document.xml`
//!   and stream the `<w:t>` runs, inserting a separator at each `</w:p>`.
//! - **text-like** (`.txt` / `.md` / `.csv`, `text/*`) via std UTF-8 (lossy).
//!
//! Output is NFC-normalized and capped at [`MAX_EXTRACTED_TEXT_LEN`]. The result
//! is an [`ExtractedText`] that the desktop layer serializes (postcard) into the
//! `MYE1` blob plaintext (`protocol::attachment_text_blob`). The crypto framing
//! lives in the protocol crate; this module owns extraction + the payload shape.
//!
//! Extraction is **best-effort and never panics**: a corrupt / password-protected
//! / unsupported input yields a `Failed` / `Unsupported` result, cached so the
//! search index does not retry it every rebuild (§ 9.15.4).

// The pure extracted-text payload types (`ExtractStatus`, `SourceFormat`,
// `ExtractedText`, `MAX_EXTRACTED_TEXT_LEN` + their postcard round-trip) moved
// to `myne_core::plugins::attachments::extract_types` (shared desktop↔mobile) so
// the `MYE1` cache codec can round-trip them without pulling this module's
// desktop-only `lopdf`/`zip`/`quick-xml` deps. Re-exported here so existing
// `crate::plugins::attachments::extract::{ExtractStatus, …}` paths keep
// resolving. This module keeps ONLY the desktop extraction *producer* below.
pub use myne_core::plugins::attachments::extract_types::{
    ExtractStatus, ExtractedText, SourceFormat,
};

// Only the truncation tests reference the cap directly; `ExtractedText::finalize`
// in core is what applies it at runtime.
#[cfg(test)]
use myne_core::plugins::attachments::extract_types::MAX_EXTRACTED_TEXT_LEN;

/// Extract searchable text from an attachment's decrypted `bytes`, dispatching
/// on `content_type` first and the `filename` extension as a fallback (an
/// attachment stored as `application/octet-stream` — the MYND-173 default for
/// unsniffed types — still extracts when its name ends in a known extension).
pub fn extract(content_type: &str, filename: &str, bytes: &[u8]) -> ExtractedText {
    match detect_format(content_type, filename) {
        Some(SourceFormat::Pdf) => guard(SourceFormat::Pdf, || extract_pdf(bytes)),
        Some(SourceFormat::Docx) => guard(SourceFormat::Docx, || extract_docx(bytes)),
        Some(SourceFormat::Text) => guard(SourceFormat::Text, || extract_text_like(bytes)),
        // Image OCR (MYND-441) lives in `myne-core` so mobile runs the same
        // extractor. It contains its own panic guard and never returns an
        // error — an unavailable engine or an undersized image comes back as
        // `Unsupported`, undecodable bytes as `Failed`, and a confident-word
        // drought as `Empty`.
        Some(SourceFormat::Image) => myne_core::plugins::attachments::ocr::extract_image(bytes),
        _ => ExtractedText::negative(ExtractStatus::Unsupported, SourceFormat::Other),
    }
}

/// Run a format extractor, converting any panic (defensive — third-party
/// parsers on hostile input) into a `Failed` result so a single bad attachment
/// never aborts an index build (§ 9.15.4 "never panics").
fn guard(
    fmt: SourceFormat,
    f: impl FnOnce() -> ExtractedText + std::panic::UnwindSafe,
) -> ExtractedText {
    guard_or(ExtractedText::negative(ExtractStatus::Failed, fmt), f)
}

/// The [`guard`] pattern for parsers with a non-[`ExtractedText`] result
/// (the Tier-2 structured extractors): a panic yields `fallback`.
fn guard_or<T>(fallback: T, f: impl FnOnce() -> T + std::panic::UnwindSafe) -> T {
    std::panic::catch_unwind(f).unwrap_or(fallback)
}

/// Per-XML-part inflate ceiling for the zip-backed extractors. Deflate reaches
/// ~1030:1, so a cap-compliant attachment can hold a member that inflates to
/// GiB inside one `String` before any row/block/text cap applies. 8 MiB
/// comfortably covers real `document.xml` / `sheet1.xml` parts at preview and
/// search scale (output is further capped by `MAX_EXTRACTED_TEXT_LEN` and the
/// row/block limits) while bounding RAM to single-digit MiB.
const MAX_XML_PART_LEN: usize = 8 * 1024 * 1024;

/// Read a zip member into a `String`, inflating at most [`MAX_XML_PART_LEN`]
/// bytes. Hitting the cap is truncation, not failure — the streaming parsers
/// are best-effort and keep whatever parsed cleanly (a cap-split multi-byte
/// char degrades to U+FFFD via the lossy decode). `None` only on a real
/// inflate/IO error.
fn read_xml_part_capped(reader: impl std::io::Read) -> Option<String> {
    use std::io::Read;
    let mut buf = Vec::new();
    match reader.take(MAX_XML_PART_LEN as u64).read_to_end(&mut buf) {
        Ok(_) => Some(String::from_utf8_lossy(&buf).into_owned()),
        Err(_) => None,
    }
}

pub(crate) fn detect_format(content_type: &str, filename: &str) -> Option<SourceFormat> {
    let ct = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match ct.as_str() {
        "application/pdf" => return Some(SourceFormat::Pdf),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => {
            return Some(SourceFormat::Docx)
        }
        "text/plain" | "text/markdown" | "text/csv" => return Some(SourceFormat::Text),
        _ if ct.starts_with("text/") => return Some(SourceFormat::Text),
        _ => {}
    }
    // Extension fallback (octet-stream-stored attachments).
    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "pdf" => Some(SourceFormat::Pdf),
        "docx" => Some(SourceFormat::Docx),
        "txt" | "text" | "md" | "markdown" | "csv" | "tsv" | "log" => Some(SourceFormat::Text),
        // Raster formats the OCR generation handles (MYND-441). The predicate
        // lives in `myne-core` because mobile dispatches on the SAME definition
        // — the two platforms must not disagree about which files get read.
        _ if myne_core::plugins::attachments::ocr::is_ocr_image(content_type, filename) => {
            Some(SourceFormat::Image)
        }
        _ => None,
    }
}

/// The extractor the **on-unlock index rebuild** injects: everything the
/// deterministic parsers can do, with OCR deferred to the background worker
/// ([`super::ocr_queue`]).
///
/// OCR candidates come back `Unsupported`, which the backfill deliberately does
/// **not** cache (a pre-existing rule, not one invented here). They therefore
/// end the rebuild with no cache entry — which is precisely the worker's work
/// list. The rebuild stays milliseconds-per-note, and the first search after
/// unlock is not held hostage to reading every scanned document in the vault.
///
/// A PDF is only deferred once its text layer has been tried and produced
/// nothing: a PDF that *has* selectable text is fully extracted here and never
/// reaches the worker.
pub fn extract_deferring_ocr(content_type: &str, filename: &str, bytes: &[u8]) -> ExtractedText {
    match detect_format(content_type, filename) {
        // Images defer unconditionally — the worker owns every model pass.
        Some(SourceFormat::Image) => {
            ExtractedText::negative(ExtractStatus::Unsupported, SourceFormat::Image)
        }
        Some(SourceFormat::Pdf) => {
            // Try the (cheap) text layer. Only a PDF that yields nothing is a
            // scan candidate worth handing to the worker; one with selectable
            // text is fully extracted here and never queued.
            //
            // The `Document` is built INSIDE the guard: `&[u8]` is unwind-safe
            // while `&lopdf::Document` is not, and this path must keep the same
            // never-panics containment `extract` gives every other parser.
            let layer = guard(SourceFormat::Pdf, || {
                match lopdf::Document::load_mem(bytes) {
                    Ok(doc) => extract_pdf_text_layer(&doc),
                    Err(_) => ExtractedText::negative(ExtractStatus::Failed, SourceFormat::Pdf),
                }
            });
            if layer.status == ExtractStatus::Empty {
                ExtractedText::negative(ExtractStatus::Unsupported, SourceFormat::Pdf)
            } else {
                layer
            }
        }
        _ => extract(content_type, filename, bytes),
    }
}

/// Maximum pages OCR'd for one scanned PDF.
///
/// A time budget, not a size one: at roughly 0.4 s/page the queue is sequential,
/// so a 500-page scan would monopolize it for minutes while every other
/// attachment waits. 50 pages ≈ 20 s, which is a tolerable share of one
/// attachment's turn. Pages beyond the cap are not read — a documented
/// limitation, revisitable without a format change (the result is re-derivable
/// at any later `extractor_version`).
const MAX_OCR_PDF_PAGES: usize = 50;

/// The PDF text layer alone — no OCR fallback. Shared by [`extract_pdf`] and
/// [`extract_deferring_ocr`], which needs to know whether a text layer exists
/// without paying for the scan path.
fn extract_pdf_text_layer(doc: &lopdf::Document) -> ExtractedText {
    let pages: Vec<u32> = doc.get_pages().keys().copied().collect();
    match doc.extract_text(&pages) {
        Ok(text) => finalize(text, SourceFormat::Pdf),
        Err(_) => ExtractedText::negative(ExtractStatus::Failed, SourceFormat::Pdf),
    }
}

fn extract_pdf(bytes: &[u8]) -> ExtractedText {
    let doc = match lopdf::Document::load_mem(bytes) {
        Ok(d) => d,
        Err(_) => return ExtractedText::negative(ExtractStatus::Failed, SourceFormat::Pdf),
    };
    let layer = extract_pdf_text_layer(&doc);
    // A PDF that HAS selectable text keeps using it: faster, and exact. OCR is
    // only for the text-layer-less case (MYND-441).
    if layer.status != ExtractStatus::Empty {
        return layer;
    }
    ocr_scanned_pdf(&doc)
}

/// OCR a text-layer-less PDF by pulling the page images it already contains.
///
/// **No rasterizer.** A scanned PDF is, in practice, one embedded image per
/// page — the shape every scanner and phone produces — so the pixels are already
/// in the file and `lopdf` (in-tree since MYND-255) can hand them over. Adding a
/// real renderer would mean a prebuilt C++ binary per platform, giving back the
/// pure-Rust / single-`Cargo.lock` / mobile-portable properties the rest of this
/// feature was built to protect.
///
/// Codec coverage is deliberately partial. `DCTDecode` (JPEG) and `FlateDecode`
/// (raw deflated samples) are the overwhelming majority of modern output.
/// `CCITTFaxDecode` (fax/legacy office scans), `JBIG2` (archive scans) and `JPX`
/// (JPEG 2000) are **not** decoded: those pages contribute nothing and the
/// attachment ends up `Empty`, cached, costing CPU exactly once and revisitable
/// under a later generation with no data loss.
///
/// Known limitation: a page composed of several image tiles yields fragmentary
/// text ordered by XObject iteration rather than true layout.
fn ocr_scanned_pdf(doc: &lopdf::Document) -> ExtractedText {
    use myne_core::plugins::attachments::ocr;

    let Some(models) = ocr::models() else {
        // No weights in this build/checkout: report honestly rather than
        // caching a false "nothing here".
        return ExtractedText::negative(ExtractStatus::Unsupported, SourceFormat::Pdf);
    };

    let mut out = String::new();
    for (_, page_id) in doc.get_pages().into_iter().take(MAX_OCR_PDF_PAGES) {
        let Ok(images) = doc.get_page_images(page_id) else {
            continue;
        };
        for img in images {
            let Some(decoded) = decode_pdf_image(doc, &img) else {
                continue;
            };
            let text = ocr::recognize(models, &decoded).text();
            if !text.trim().is_empty() {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(&text);
            }
        }
        // Stop early once the text cap is already exceeded — further pages
        // would be truncated away anyway.
        if out.len() > myne_core::plugins::attachments::extract_types::MAX_EXTRACTED_TEXT_LEN {
            break;
        }
    }
    finalize(out, SourceFormat::Pdf)
}

/// Most bytes one embedded PDF image stream may inflate to (myne#309).
///
/// A sibling of [`MAX_XML_PART_LEN`] — the same class of guard, for the same
/// reason (deflate reaches ~1030:1, so a cap-compliant attachment can hold a
/// member that inflates to GiB), applied to the other decompression this crate
/// performs on untrusted bytes.
///
/// Derived from the DECLARED geometry rather than fixed, because here the
/// legitimate size is known exactly: at `bits_per_component == 8` a raw sample
/// stream is `width * height * components`, and the widest colour space this
/// function then accepts is `DeviceRGB` (3). The `+ 1` component of slack
/// covers an alpha/soft-mask channel; the absolute floor keeps a tiny image
/// from producing a ceiling so small that a legal stream trips it.
///
/// Anything past this is unusable regardless of intent — `RgbImage::from_raw` /
/// `GrayImage::from_raw` below want the exact length — so refusing early costs
/// nothing a caller wanted.
fn plausible_samples_ceiling(w: u32, h: u32) -> u64 {
    const MAX_COMPONENTS: u64 = 4; // RGB + one channel of slack
    const FLOOR: u64 = 1024 * 1024;
    // Saturating: `w` and `h` are attacker-declared dictionary values, and
    // `u32::MAX * u32::MAX * 4` overflows `u64`. A wrap would hand back a tiny
    // ceiling — fail-closed, but by accident; saturating says so on purpose.
    u64::from(w)
        .saturating_mul(u64::from(h))
        .saturating_mul(MAX_COMPONENTS)
        .max(FLOOR)
}

/// Does `compressed` inflate to at most `ceiling` bytes?
///
/// Reads through `Read::take(ceiling + 1)`, so resident memory is bounded by the
/// ceiling whatever the input claims — the property `decompressed_content()`
/// does not have. A truncated or corrupt stream answers `false`: this is a
/// pre-flight for a decode that would fail anyway, so degrading to "skip this
/// image" is the same outcome by a cheaper route.
fn flate_inflates_within(compressed: &[u8], ceiling: u64) -> bool {
    use std::io::Read;
    let mut sink = std::io::sink();
    let mut probe = flate2::read::ZlibDecoder::new(compressed).take(ceiling + 1);
    match std::io::copy(&mut probe, &mut sink) {
        Ok(n) => n <= ceiling,
        Err(_) => false,
    }
}

/// Turn one embedded PDF image into decoded pixels, or `None` for a codec this
/// generation does not handle.
fn decode_pdf_image(
    doc: &lopdf::Document,
    img: &lopdf::xobject::PdfImage<'_>,
) -> Option<image::DynamicImage> {
    let (w, h) = (
        u32::try_from(img.width).ok()?,
        u32::try_from(img.height).ok()?,
    );
    // Same icon-scale skip as direct image attachments: a small logo embedded in
    // an otherwise-blank page is not worth three model passes.
    if w.min(h) < myne_core::plugins::attachments::ocr::MIN_OCR_IMAGE_SIDE {
        return None;
    }

    let filters = img.filters.clone().unwrap_or_default();
    let has = |f: &str| filters.iter().any(|x| x == f);

    if has("DCTDecode") {
        // The stream content IS a JPEG file. Through the SHARED bounded-decode
        // rail (myne#309) — this used to call `image::load_from_memory`, which
        // runs under `image::Limits::default()`: no width/height caps and a
        // ~512 MiB allocation ceiling that moves on a dependency bump with no
        // line of this repo's diff to review. That inherited default is exactly
        // what `attachments::decode` was written to replace, and a PDF-embedded
        // JPEG is no less untrusted than an attached one.
        return myne_core::plugins::attachments::decode::decode_bounded(img.content);
    }

    if has("FlateDecode") && filters.len() == 1 {
        // Raw samples behind zlib. Bound the inflate BEFORE letting lopdf do it
        // for real (myne#309): `Stream::decompressed_content()` is
        // `ZlibDecoder::read_to_end` with no ceiling, and deflate reaches
        // ~1030:1 — so a PDF well under the 64 MiB import cap could carry one
        // page image that inflated toward tens of GB. The process is OOM-killed
        // long before the allocator refuses, which neither `guard`'s
        // `catch_unwind` nor a join-error arm can turn into `Failed`; and the
        // OCR queue re-runs the same attachment at every unlock, so one hostile
        // file took the app down again and again.
        //
        // The ceiling is not a guess: at `bpc == 8` a legitimate stream inflates
        // to exactly `w * h * components`, and nothing larger is usable —
        // `from_raw` below wants that exact length. Anything beyond it is either
        // a bomb or bytes we would discard.
        if !flate_inflates_within(img.content, plausible_samples_ceiling(w, h)) {
            return None;
        }
        // Within bounds: re-fetch through lopdf so `/DecodeParms` predictors are
        // applied as before. Predictors never grow the output past the raw
        // inflate, so this call is bounded by the probe above.
        let stream = doc.get_object(img.id).ok()?.as_stream().ok()?;
        let raw = stream.decompressed_content().ok()?;
        let bpc = img.bits_per_component.unwrap_or(8);
        if bpc != 8 {
            return None; // 1-bit/4-bit packed samples are a later improvement
        }
        return match img.color_space.as_deref() {
            Some("DeviceRGB") => {
                image::RgbImage::from_raw(w, h, raw).map(image::DynamicImage::ImageRgb8)
            }
            Some("DeviceGray") => {
                image::GrayImage::from_raw(w, h, raw).map(image::DynamicImage::ImageLuma8)
            }
            // Indexed / CMYK / ICC-based need palette or profile handling.
            _ => None,
        };
    }

    // CCITTFaxDecode, JBIG2Decode, JPXDecode, or a filter chain we do not
    // interpret. Deliberately unhandled — see `ocr_scanned_pdf`.
    None
}

fn extract_docx(bytes: &[u8]) -> ExtractedText {
    let mut archive = match zip::ZipArchive::new(std::io::Cursor::new(bytes)) {
        Ok(a) => a,
        Err(_) => return ExtractedText::negative(ExtractStatus::Failed, SourceFormat::Docx),
    };
    let xml = match archive.by_name("word/document.xml") {
        Ok(f) => match read_xml_part_capped(f) {
            Some(xml) => xml,
            None => return ExtractedText::negative(ExtractStatus::Failed, SourceFormat::Docx),
        },
        Err(_) => return ExtractedText::negative(ExtractStatus::Failed, SourceFormat::Docx),
    };
    finalize(parse_docx_runs(&xml), SourceFormat::Docx)
}

/// Pull the text of every `<w:t>` run out of a `word/document.xml`, inserting a
/// newline at each `</w:p>` paragraph boundary so adjacent paragraphs do not
/// run together (matched on the local name, so namespace prefixes are
/// irrelevant).
fn parse_docx_runs(xml: &str) -> String {
    use quick_xml::events::Event;
    use quick_xml::reader::Reader;
    let mut reader = Reader::from_str(xml);
    let mut out = String::new();
    let mut in_text_run = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) if e.local_name().as_ref() == b"t" => in_text_run = true,
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"t" => in_text_run = false,
                b"p" => out.push('\n'),
                _ => {}
            },
            Ok(Event::Text(e)) if in_text_run => {
                if let Ok(unescaped) = e.unescape() {
                    out.push_str(&unescaped);
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break, // best-effort: keep whatever ran out cleanly
            _ => {}
        }
    }
    out
}

fn extract_text_like(bytes: &[u8]) -> ExtractedText {
    finalize(
        String::from_utf8_lossy(bytes).into_owned(),
        SourceFormat::Text,
    )
}

// ---- structured xlsx grid (MYND-268 Tier-2 preview) -----------------------
//
// Unlike `extract()` (which flattens to searchable text), the Tier-2 inline
// preview needs the sheet as a GRID. This reuses the SAME `zip` + `quick-xml`
// deps (no new dependency) and stays a pure function over the decrypted bytes,
// so it is unit-testable and never touches crypto/format. Preview-grade: cached
// cell values only (no formula engine), first worksheet, bounded rows.

/// Extract a `.xlsx` first sheet as a grid of cell strings (row-major). Shared-
/// string refs are resolved; empty/sparse cells fill as `""`. Best-effort — a
/// corrupt / absent sheet yields an empty grid, and (same never-panics posture
/// as [`extract`], § 9.15.4) so does a file that panics a third-party parser.
pub fn extract_xlsx_grid(bytes: &[u8], max_rows: usize) -> Vec<Vec<String>> {
    guard_or(Vec::new(), || extract_xlsx_grid_inner(bytes, max_rows))
}

fn extract_xlsx_grid_inner(bytes: &[u8], max_rows: usize) -> Vec<Vec<String>> {
    let mut archive = match zip::ZipArchive::new(std::io::Cursor::new(bytes)) {
        Ok(a) => a,
        Err(_) => return Vec::new(),
    };
    // Shared-strings table (optional — numeric-only sheets omit it).
    let shared = {
        let xml = match archive.by_name("xl/sharedStrings.xml") {
            Ok(f) => read_xml_part_capped(f).unwrap_or_default(),
            Err(_) => String::new(),
        };
        parse_shared_strings(&xml)
    };
    let sheet_xml = match archive.by_name("xl/worksheets/sheet1.xml") {
        Ok(f) => match read_xml_part_capped(f) {
            Some(xml) => xml,
            None => return Vec::new(),
        },
        Err(_) => return Vec::new(),
    };
    parse_sheet_grid(&sheet_xml, &shared, max_rows)
}

/// Excel's real column ceiling (`XFD` = 16,384 columns). A cell ref past it is
/// crafted/corrupt input — honoring it would drive an unbounded `Vec` resize
/// (a `<c r="ZZZZZZZZ1">` names a ~2e11 column), so such cells are skipped.
const XLSX_MAX_COLS: usize = 16_384;

/// Columns the PREVIEW grid materializes, which is a different question from
/// Excel's ceiling (myne#310).
///
/// [`XLSX_MAX_COLS`] bounds a single cell REFERENCE; it does nothing about the
/// aggregate, and the row is padded out to the referenced index. So a ~1 KB
/// crafted sheet whose every row carries one cell at `XFD` produced 16,384
/// `String`s per row — 384 KiB for one value — and 1,000 of those rows are
/// retained at once: ~375 MiB in the worker, then ~50 MB of JSON across IPC
/// (16.4 M `""` entries the WebView must parse), then ~8.2 M synchronous `<td>`
/// nodes, because the renderer clamps rows and not columns.
///
/// A 320 px-tall inline preview shows tens of columns. 256 is far past what any
/// reader can see and four orders below the ceiling that was being honoured;
/// beyond it the cells are dropped rather than the file rejected, matching the
/// row cap's truncate-don't-fail posture.
pub const XLSX_PREVIEW_MAX_COLS: usize = 256;

/// Zero-based column index of an A1-style cell ref (`"B3"` → `Some(1)`), or
/// `None` when the ref names a column past [`XLSX_MAX_COLS`] (the caller skips
/// the cell). Non-alphabetic suffix (the row number) ends the run. The
/// per-char bail also keeps the accumulation far from `usize` overflow.
fn col_index(cell_ref: &str) -> Option<usize> {
    let mut idx = 0usize;
    for c in cell_ref.chars() {
        if c.is_ascii_alphabetic() {
            idx = idx * 26 + (c.to_ascii_uppercase() as usize - 'A' as usize + 1);
            if idx > XLSX_MAX_COLS {
                return None;
            }
        } else {
            break;
        }
    }
    Some(idx.saturating_sub(1))
}

/// Parse `xl/sharedStrings.xml` into the ordered string table (`<si><t>…</t></si>`).
/// Accumulation is bounded at [`MAX_XML_PART_LEN`] total string bytes — the
/// input is already read-capped at that size, but the parse must stay bounded
/// even if a future caller feeds it uncapped XML (entity expansion keeps the
/// unescaped output within the same order as the input, so the bound holds).
fn parse_shared_strings(xml: &str) -> Vec<String> {
    use quick_xml::events::Event;
    use quick_xml::reader::Reader;
    let mut reader = Reader::from_str(xml);
    let mut strings: Vec<String> = Vec::new();
    let mut total_len = 0usize;
    let mut cur = String::new();
    let mut in_si = false;
    let mut in_t = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                b"si" => {
                    in_si = true;
                    cur.clear();
                }
                b"t" => in_t = true,
                _ => {}
            },
            Ok(Event::Text(e)) if in_si && in_t => {
                if let Ok(t) = e.unescape() {
                    cur.push_str(&t);
                }
            }
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"t" => in_t = false,
                b"si" => {
                    in_si = false;
                    total_len = total_len.saturating_add(cur.len());
                    strings.push(std::mem::take(&mut cur));
                    if total_len > MAX_XML_PART_LEN {
                        break;
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    strings
}

/// Parse a worksheet's `<sheetData>` into a grid, resolving `t="s"` cells against
/// `shared`. Cells are placed by their A1 column ref (sparse gaps → `""`).
fn parse_sheet_grid(xml: &str, shared: &[String], max_rows: usize) -> Vec<Vec<String>> {
    use quick_xml::events::Event;
    use quick_xml::reader::Reader;
    let mut reader = Reader::from_str(xml);
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut current: Vec<String> = Vec::new();
    // `None` = the cell ref named a column past XLSX_MAX_COLS → skip the cell.
    let mut cur_col: Option<usize> = Some(0);
    let mut cur_is_shared = false;
    let mut cur_value = String::new();
    let mut in_value = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.local_name().as_ref() == b"c" => {
                cur_col = Some(0);
                cur_is_shared = false;
                cur_value.clear();
                for attr in e.attributes().flatten() {
                    match attr.key.as_ref() {
                        b"r" => {
                            if let Ok(v) = std::str::from_utf8(&attr.value) {
                                cur_col = col_index(v);
                            }
                        }
                        b"t" => cur_is_shared = attr.value.as_ref() == b"s",
                        _ => {}
                    }
                }
            }
            Ok(Event::Start(e)) if e.local_name().as_ref() == b"v" => in_value = true,
            Ok(Event::Text(e)) if in_value => {
                if let Ok(t) = e.unescape() {
                    cur_value.push_str(&t);
                }
            }
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"v" => in_value = false,
                b"c" => {
                    // Past the preview width → drop the cell (myne#310). The
                    // `Some(col)` from `col_index` only says the reference is a
                    // legal Excel column; it is this bound that decides how wide
                    // a row may actually be MATERIALIZED.
                    if let Some(col) = cur_col.filter(|c| *c < XLSX_PREVIEW_MAX_COLS) {
                        let resolved = if cur_is_shared {
                            cur_value
                                .trim()
                                .parse::<usize>()
                                .ok()
                                .and_then(|i| shared.get(i))
                                .cloned()
                                .unwrap_or_default()
                        } else {
                            cur_value.clone()
                        };
                        if current.len() <= col {
                            current.resize(col + 1, String::new());
                        }
                        current[col] = resolved;
                    }
                }
                b"row" => {
                    rows.push(std::mem::take(&mut current));
                    if rows.len() >= max_rows {
                        break;
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    if !current.is_empty() {
        rows.push(current);
    }
    rows
}

// ---- structured docx block model (MYND-268 Tier-2 preview) ----------------

/// One docx block for the Tier-2 preview render.
#[derive(Debug, PartialEq, Eq)]
pub enum DocxBlockKind {
    Paragraph,
    /// A heading at the given level (1..=6), from the paragraph's `w:pStyle`.
    Heading(u8),
}

/// A docx paragraph classified as a heading or body text (MYND-268 Tier-2).
#[derive(Debug, PartialEq, Eq)]
pub struct DocxBlock {
    pub kind: DocxBlockKind,
    pub text: String,
}

/// Extract a `.docx` as a structured block list (headings + paragraphs) for the
/// Tier-2 inline preview. Reuses the same `zip` + `quick-xml` path as the search
/// text extractor — pure over the decrypted bytes, no crypto/format change.
/// Best-effort: a corrupt / absent document yields an empty list, and (same
/// never-panics posture as [`extract`], § 9.15.4) so does a file that panics a
/// third-party parser. Bounded blocks.
pub fn extract_docx_blocks(bytes: &[u8], max_blocks: usize) -> Vec<DocxBlock> {
    guard_or(Vec::new(), || extract_docx_blocks_inner(bytes, max_blocks))
}

fn extract_docx_blocks_inner(bytes: &[u8], max_blocks: usize) -> Vec<DocxBlock> {
    let mut archive = match zip::ZipArchive::new(std::io::Cursor::new(bytes)) {
        Ok(a) => a,
        Err(_) => return Vec::new(),
    };
    let xml = match archive.by_name("word/document.xml") {
        Ok(f) => match read_xml_part_capped(f) {
            Some(xml) => xml,
            None => return Vec::new(),
        },
        Err(_) => return Vec::new(),
    };
    parse_docx_blocks(&xml, max_blocks)
}

/// Map a `w:pStyle` value to a heading level (`"Heading1"`/`"Heading 2"` → 1/2,
/// `"Title"` → 1); non-heading styles → `None`.
fn heading_level_from_style(style: &str) -> Option<u8> {
    let s = style.trim().to_ascii_lowercase();
    if s == "title" {
        return Some(1);
    }
    s.strip_prefix("heading")
        .and_then(|n| n.trim().parse::<u8>().ok())
        .map(|n| n.clamp(1, 6))
}

/// Stream `word/document.xml` into blocks: each `<w:p>` becomes one block, its
/// `<w:t>` runs concatenated, classified by an optional `<w:pStyle>` heading.
fn parse_docx_blocks(xml: &str, max_blocks: usize) -> Vec<DocxBlock> {
    use quick_xml::events::Event;
    use quick_xml::reader::Reader;
    let mut reader = Reader::from_str(xml);
    let mut blocks: Vec<DocxBlock> = Vec::new();
    let mut text = String::new();
    let mut heading: Option<u8> = None;
    let mut in_text = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.local_name().as_ref() == b"pStyle" => {
                for attr in e.attributes().flatten() {
                    if attr.key.local_name().as_ref() == b"val" {
                        if let Ok(v) = std::str::from_utf8(&attr.value) {
                            heading = heading_level_from_style(v);
                        }
                    }
                }
            }
            Ok(Event::Start(e)) if e.local_name().as_ref() == b"t" => in_text = true,
            Ok(Event::Text(e)) if in_text => {
                if let Ok(u) = e.unescape() {
                    text.push_str(&u);
                }
            }
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"t" => in_text = false,
                b"p" => {
                    let body = std::mem::take(&mut text);
                    let kind = match heading.take() {
                        Some(lvl) => DocxBlockKind::Heading(lvl),
                        None => DocxBlockKind::Paragraph,
                    };
                    if !body.trim().is_empty() {
                        blocks.push(DocxBlock { kind, text: body });
                        if blocks.len() >= max_blocks {
                            break;
                        }
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    blocks
}

/// NFC-normalize, apply the size cap, and classify (`Ok` vs `Empty`).
///
/// Delegates to the shared core implementation so desktop and mobile cannot
/// drift on normalization, the cap, the `char_count`-before-truncation rule, or
/// the whitespace-only → `Empty` rule (MYND-441).
fn finalize(raw: String, fmt: SourceFormat) -> ExtractedText {
    ExtractedText::finalize(raw, fmt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // --- fixtures -------------------------------------------------------

    /// Build a minimal one-page, text-layer PDF with correct xref offsets.
    /// `text` must not contain `(`, `)`, or `\` (unescaped PDF string literal).
    fn build_text_pdf(text: &str) -> Vec<u8> {
        let stream = format!("BT /F1 24 Tf 72 700 Td ({text}) Tj ET");
        let objs = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_string(),
            format!("<< /Length {} >>\nstream\n{}\nendstream", stream.len(), stream),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        ];
        let mut out = String::from("%PDF-1.4\n");
        let mut offsets = vec![0usize];
        for (i, o) in objs.iter().enumerate() {
            offsets.push(out.len());
            out.push_str(&format!("{} 0 obj\n{}\nendobj\n", i + 1, o));
        }
        let xref_pos = out.len();
        let n = objs.len() + 1;
        out.push_str(&format!("xref\n0 {n}\n"));
        out.push_str("0000000000 65535 f \n");
        for off in offsets.iter().skip(1) {
            out.push_str(&format!("{off:010} 00000 n \n"));
        }
        out.push_str(&format!(
            "trailer\n<< /Size {n} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n"
        ));
        out.into_bytes()
    }

    /// Build a minimal `.docx` (zip with just `word/document.xml`) whose body is
    /// the given paragraphs.
    fn build_docx(paragraphs: &[&str]) -> Vec<u8> {
        let mut body = String::new();
        for p in paragraphs {
            body.push_str(&format!(
                "<w:p><w:r><w:t xml:space=\"preserve\">{p}</w:t></w:r></w:p>"
            ));
        }
        let doc = format!(
            "<?xml version=\"1.0\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>{body}</w:body></w:document>"
        );
        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            zw.start_file("word/document.xml", opts).unwrap();
            zw.write_all(doc.as_bytes()).unwrap();
            zw.finish().unwrap();
        }
        buf
    }

    /// Build a minimal `.xlsx` (zip with `xl/sharedStrings.xml` + one worksheet)
    /// from raw inner-XML fragments.
    fn build_xlsx(shared_si: &str, sheet_rows: &str) -> Vec<u8> {
        let sst = format!("<?xml version=\"1.0\"?><sst>{shared_si}</sst>");
        let sheet = format!(
            "<?xml version=\"1.0\"?><worksheet><sheetData>{sheet_rows}</sheetData></worksheet>"
        );
        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            zw.start_file("xl/sharedStrings.xml", opts).unwrap();
            zw.write_all(sst.as_bytes()).unwrap();
            zw.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
            zw.write_all(sheet.as_bytes()).unwrap();
            zw.finish().unwrap();
        }
        buf
    }

    // --- XLSX grid (Tier-2 preview) -------------------------------------

    #[test]
    fn xlsx_grid_resolves_shared_strings_and_numbers() {
        let sst = "<si><t>Name</t></si><si><t>Age</t></si><si><t>Alice</t></si>";
        let rows = "<row><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"B1\" t=\"s\"><v>1</v></c></row>\
                    <row><c r=\"A2\" t=\"s\"><v>2</v></c><c r=\"B2\"><v>30</v></c></row>";
        let grid = extract_xlsx_grid(&build_xlsx(sst, rows), 100);
        assert_eq!(
            grid,
            vec![
                vec!["Name".to_string(), "Age".to_string()],
                vec!["Alice".to_string(), "30".to_string()],
            ]
        );
    }

    #[test]
    fn xlsx_grid_fills_sparse_cells() {
        // A row that skips column B: A1 then C1 (col index 0 then 2).
        let sst = "<si><t>x</t></si><si><t>z</t></si>";
        let rows = "<row><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"C1\" t=\"s\"><v>1</v></c></row>";
        let grid = extract_xlsx_grid(&build_xlsx(sst, rows), 100);
        assert_eq!(
            grid,
            vec![vec!["x".to_string(), String::new(), "z".to_string()]]
        );
    }

    #[test]
    fn xlsx_grid_caps_rows() {
        let sst = "<si><t>r</t></si>";
        let mut rows = String::new();
        for _ in 0..10 {
            rows.push_str("<row><c r=\"A1\" t=\"s\"><v>0</v></c></row>");
        }
        assert_eq!(extract_xlsx_grid(&build_xlsx(sst, &rows), 3).len(), 3);
    }

    #[test]
    fn corrupt_xlsx_is_empty_grid_not_panic() {
        assert!(extract_xlsx_grid(b"PK\x03\x04 not a real zip", 100).is_empty());
    }

    #[test]
    fn xlsx_grid_skips_absurd_column_refs() {
        // A crafted ref like ZZZZZZZZ1 names a ~2e11 column — honoring it
        // would attempt a huge Vec resize (allocation abort, not unwindable).
        // The cell must be skipped; well-formed siblings still parse.
        let sst = "<si><t>ok</t></si><si><t>evil</t></si>";
        let rows = "<row><c r=\"A1\" t=\"s\"><v>0</v></c>\
                    <c r=\"ZZZZZZZZ1\" t=\"s\"><v>1</v></c></row>";
        let grid = extract_xlsx_grid(&build_xlsx(sst, rows), 100);
        assert_eq!(grid, vec![vec!["ok".to_string()]]);
    }

    #[test]
    fn col_index_clamps_at_excel_max() {
        assert_eq!(col_index("XFD1"), Some(XLSX_MAX_COLS - 1)); // Excel's last column
        assert_eq!(col_index("XFE1"), None); // one past → skipped
        assert_eq!(col_index("ZZZZZZZZ1"), None); // absurd ref → skipped, no overflow
    }

    #[test]
    fn xlsx_inflate_bomb_sheet_is_capped_not_oom() {
        // A sheet1.xml member that inflates past MAX_XML_PART_LEN (deflate on
        // repetitive XML reaches ~1000:1, so the zip itself stays tiny). The
        // read must stop at the cap and keep whatever parsed cleanly.
        let row = "<row><c r=\"A1\" t=\"s\"><v>0</v></c></row>";
        let n = MAX_XML_PART_LEN / row.len() + 1000;
        let grid = extract_xlsx_grid(&build_xlsx("<si><t>r</t></si>", &row.repeat(n)), 5);
        assert_eq!(grid.len(), 5, "rows before the cap still parse");
        assert_eq!(grid[0], vec!["r".to_string()]);
    }

    // --- DOCX block model (Tier-2 preview) ------------------------------

    /// Build a `.docx` where each `(style, text)` paragraph carries an optional
    /// heading style (`""` = plain paragraph).
    fn build_docx_styled(items: &[(&str, &str)]) -> Vec<u8> {
        let mut body = String::new();
        for (style, txt) in items {
            let ppr = if style.is_empty() {
                String::new()
            } else {
                format!("<w:pPr><w:pStyle w:val=\"{style}\"/></w:pPr>")
            };
            body.push_str(&format!(
                "<w:p>{ppr}<w:r><w:t xml:space=\"preserve\">{txt}</w:t></w:r></w:p>"
            ));
        }
        let doc = format!(
            "<?xml version=\"1.0\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>{body}</w:body></w:document>"
        );
        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            zw.start_file("word/document.xml", opts).unwrap();
            zw.write_all(doc.as_bytes()).unwrap();
            zw.finish().unwrap();
        }
        buf
    }

    #[test]
    fn docx_blocks_classify_headings_and_paragraphs() {
        let docx = build_docx_styled(&[
            ("Heading1", "Title Here"),
            ("", "Body para"),
            ("Heading 2", "Sub"),
        ]);
        assert_eq!(
            extract_docx_blocks(&docx, 100),
            vec![
                DocxBlock {
                    kind: DocxBlockKind::Heading(1),
                    text: "Title Here".to_string()
                },
                DocxBlock {
                    kind: DocxBlockKind::Paragraph,
                    text: "Body para".to_string()
                },
                DocxBlock {
                    kind: DocxBlockKind::Heading(2),
                    text: "Sub".to_string()
                },
            ]
        );
    }

    #[test]
    fn docx_blocks_skip_empty_paragraphs() {
        let docx = build_docx_styled(&[("", "one"), ("", "   "), ("", "two")]);
        let blocks = extract_docx_blocks(&docx, 100);
        let texts: Vec<&str> = blocks.iter().map(|b| b.text.as_str()).collect();
        assert_eq!(texts, vec!["one", "two"]);
    }

    #[test]
    fn corrupt_docx_blocks_is_empty_not_panic() {
        assert!(extract_docx_blocks(b"PK not a zip", 100).is_empty());
    }

    // --- PDF ------------------------------------------------------------

    #[test]
    fn pdf_text_layer_extracts() {
        let pdf = build_text_pdf("Spike PDF text layer epsilon");
        let r = extract("application/pdf", "doc.pdf", &pdf);
        assert_eq!(r.status, ExtractStatus::Ok);
        assert_eq!(r.source_format, SourceFormat::Pdf);
        assert!(
            r.text.contains("Spike PDF text layer epsilon"),
            "got {:?}",
            r.text
        );
    }

    #[test]
    fn corrupt_pdf_is_failed_not_panic() {
        let r = extract("application/pdf", "doc.pdf", b"%PDF-1.4 not really a pdf");
        assert_eq!(r.status, ExtractStatus::Failed);
        assert!(r.text.is_empty());
    }

    // --- DOCX -----------------------------------------------------------

    #[test]
    fn docx_paragraphs_extract_with_separator() {
        let docx = build_docx(&["alpha beta", "second delta"]);
        let r = extract(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "doc.docx",
            &docx,
        );
        assert_eq!(r.status, ExtractStatus::Ok);
        assert_eq!(r.source_format, SourceFormat::Docx);
        assert!(r.text.contains("alpha beta"));
        assert!(r.text.contains("second delta"));
        // Paragraph boundary inserts a separator (the gammasecond bug fix).
        assert!(
            !r.text.contains("betasecond"),
            "paragraphs ran together: {:?}",
            r.text
        );
    }

    #[test]
    fn docx_via_extension_when_octet_stream() {
        // MYND-173 stores unsniffed types as octet-stream; the .docx extension
        // must still route to the docx extractor.
        let docx = build_docx(&["routed by extension"]);
        let r = extract("application/octet-stream", "report.docx", &docx);
        assert_eq!(r.status, ExtractStatus::Ok);
        assert!(r.text.contains("routed by extension"));
    }

    #[test]
    fn corrupt_docx_is_failed_not_panic() {
        let r = extract(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "doc.docx",
            b"PK\x03\x04 not a real zip",
        );
        assert_eq!(r.status, ExtractStatus::Failed);
    }

    // --- text-like ------------------------------------------------------

    #[test]
    fn text_like_extracts() {
        let r = extract("text/markdown", "n.md", b"# Heading\nsome csv,body text");
        assert_eq!(r.status, ExtractStatus::Ok);
        assert_eq!(r.source_format, SourceFormat::Text);
        assert!(r.text.contains("Heading"));
        assert!(r.text.contains("csv,body"));
    }

    #[test]
    fn empty_text_is_empty_status() {
        let r = extract("text/plain", "n.txt", b"   \n\t  ");
        assert_eq!(r.status, ExtractStatus::Empty);
        assert!(r.text.is_empty());
    }

    // --- dispatch / caps ------------------------------------------------

    #[test]
    fn unsupported_type_is_unsupported() {
        // NB: this used to use `image/png` as the archetypal unsupported type.
        // MYND-441 made PNG a first-class OCR format, so the example moved to a
        // type nothing dispatches on.
        let r = extract("application/zip", "bundle.zip", b"PK\x03\x04");
        assert_eq!(r.status, ExtractStatus::Unsupported);
        assert_eq!(r.source_format, SourceFormat::Other);
        assert!(r.text.is_empty());
    }

    /// Desktop and mobile must produce **byte-identical** cache payloads for the
    /// same attachment, or the two clients disagree about what a file contains
    /// and each re-extracts what the other already did.
    ///
    /// Both entry points are exercised here in one process: the desktop
    /// dispatcher (`extract`) and the extractor mobile injects
    /// (`ocr::extract_image_only`). The assertion is on the serialized MYE1
    /// inner plaintext, not the text — so the format tag, char count and
    /// truncation flag are all covered, not just the words.
    #[test]
    fn desktop_and_mobile_agree_byte_for_byte_on_an_image() {
        if !init_ocr_for_tests() {
            return; // no LFS blobs in this checkout
        }
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("core")
            .join("tests")
            .join("fixtures")
            .join("ocr-sample.png");
        let bytes = std::fs::read(path).expect("fixture readable");

        let desktop = extract("image/png", "sample.png", &bytes);
        let mobile = myne_core::plugins::attachments::ocr::extract_image_only(
            "image/png",
            "sample.png",
            &bytes,
        );

        assert_eq!(
            desktop.status,
            ExtractStatus::Ok,
            "precondition: text was read"
        );
        assert_eq!(
            desktop.to_blob_plaintext(),
            mobile.to_blob_plaintext(),
            "desktop and mobile must serialize identically"
        );
    }

    // --- OCR deferral for the index rebuild (MYND-441) -------------------

    /// The rebuild's extractor must NOT do OCR. An image comes back
    /// `Unsupported`, which the backfill deliberately does not cache — leaving
    /// no cache entry, which is exactly the background worker's work list.
    #[test]
    fn the_rebuild_extractor_defers_images() {
        if !init_ocr_for_tests() {
            return;
        }
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("core")
            .join("tests")
            .join("fixtures")
            .join("ocr-sample.png");
        let bytes = std::fs::read(path).expect("fixture readable");

        let deferred = extract_deferring_ocr("image/png", "sample.png", &bytes);
        assert_eq!(
            deferred.status,
            ExtractStatus::Unsupported,
            "the rebuild must defer, not extract"
        );
        assert!(deferred.text.is_empty());

        // ...while the full extractor, which the worker uses, does read it.
        let full = extract("image/png", "sample.png", &bytes);
        assert_eq!(full.status, ExtractStatus::Ok);
    }

    /// A scanned PDF is deferred too — its text layer is tried (cheap) and comes
    /// back empty, which is the signal that OCR is worth attempting later.
    #[test]
    fn the_rebuild_extractor_defers_a_scanned_pdf() {
        if !init_ocr_for_tests() {
            return;
        }
        let (jpeg, w, h) = fixture_jpeg();
        let pdf = scanned_pdf(&jpeg, w as i64, h as i64, "DCTDecode");
        let deferred = extract_deferring_ocr("application/pdf", "scan.pdf", &pdf);
        assert_eq!(deferred.status, ExtractStatus::Unsupported);
        assert_eq!(deferred.source_format, SourceFormat::Pdf);
    }

    /// A PDF that HAS a text layer is fully extracted in the rebuild and never
    /// reaches the worker — deferring it would delay text that is already
    /// available for free.
    #[test]
    fn the_rebuild_extractor_does_not_defer_a_text_layer_pdf() {
        let pdf = build_text_pdf("Rebuild path keeps the text layer");
        let r = extract_deferring_ocr("application/pdf", "doc.pdf", &pdf);
        assert_eq!(r.status, ExtractStatus::Ok, "text layer extracted inline");
        assert!(!r.text.is_empty());
    }

    /// Deterministic formats are unaffected by the deferral.
    #[test]
    fn the_rebuild_extractor_still_handles_text_inline() {
        let r = extract_deferring_ocr("text/plain", "notes.txt", b"hello world");
        assert_eq!(r.status, ExtractStatus::Ok);
        assert_eq!(r.source_format, SourceFormat::Text);
    }

    // --- scanned-PDF OCR (MYND-441) -------------------------------------

    /// Build a synthetic "scanned" PDF: one page whose only content is an
    /// embedded image, exactly the shape a scanner or phone produces. Built in
    /// memory with the `lopdf` already in-tree, so no binary fixture is
    /// committed and the test states its own premise.
    fn scanned_pdf(image_bytes: &[u8], w: i64, h: i64, filter: &str) -> Vec<u8> {
        use lopdf::{dictionary, Dictionary, Document, Object, Stream};

        let mut doc = Document::with_version("1.5");

        let mut img_dict = Dictionary::new();
        img_dict.set("Type", Object::Name(b"XObject".to_vec()));
        img_dict.set("Subtype", Object::Name(b"Image".to_vec()));
        img_dict.set("Width", Object::Integer(w));
        img_dict.set("Height", Object::Integer(h));
        img_dict.set("ColorSpace", Object::Name(b"DeviceRGB".to_vec()));
        img_dict.set("BitsPerComponent", Object::Integer(8));
        img_dict.set("Filter", Object::Name(filter.as_bytes().to_vec()));
        // `Stream::new` does not compress; the content stays exactly the bytes
        // the filter name advertises.
        let img_id = doc.add_object(Stream::new(img_dict, image_bytes.to_vec()));

        let content_id = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
        let pages_id = doc.new_object_id();
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Resources" => dictionary! {
                "XObject" => dictionary! { "Im0" => img_id },
            },
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog_id);

        let mut buf = Vec::new();
        doc.save_to(&mut buf).expect("save pdf");
        buf
    }

    fn fixture_jpeg() -> (Vec<u8>, u32, u32) {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("core")
            .join("tests")
            .join("fixtures")
            .join("ocr-sample.png");
        let img = image::open(path).expect("fixture decodes");
        let (w, h) = (img.width(), img.height());
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, image::ImageFormat::Jpeg)
            .expect("encode jpeg");
        (buf.into_inner(), w, h)
    }

    /// The headline case: a PDF with no text layer, whose page is a single
    /// embedded JPEG, becomes searchable — with no rasterizer anywhere.
    #[test]
    fn a_scanned_pdf_is_ocrd_through_its_embedded_page_image() {
        if !init_ocr_for_tests() {
            return; // no LFS blobs in this checkout
        }
        let (jpeg, w, h) = fixture_jpeg();
        let pdf = scanned_pdf(&jpeg, w as i64, h as i64, "DCTDecode");
        let r = extract("application/pdf", "scan.pdf", &pdf);
        assert_eq!(
            r.source_format,
            SourceFormat::Pdf,
            "still a PDF, not an image"
        );
        assert_eq!(
            r.status,
            ExtractStatus::Ok,
            "expected recognized text, got {r:?}"
        );
        assert!(
            r.text.to_lowercase().contains("invoice"),
            "got {:?}",
            r.text
        );
    }

    /// A page image in a codec this generation does not decode contributes
    /// nothing, and the attachment lands as `Empty` — cached, so it costs CPU
    /// exactly once and can be revisited under a later generation.
    #[test]
    fn an_unsupported_page_codec_yields_empty_not_failed() {
        if !init_ocr_for_tests() {
            return;
        }
        let (jpeg, w, h) = fixture_jpeg();
        // Same bytes, but the PDF advertises a fax codec we deliberately do not
        // implement.
        let pdf = scanned_pdf(&jpeg, w as i64, h as i64, "CCITTFaxDecode");
        let r = extract("application/pdf", "fax.pdf", &pdf);
        assert_eq!(r.source_format, SourceFormat::Pdf);
        assert_eq!(
            r.status,
            ExtractStatus::Empty,
            "an undecodable page codec must be Empty (cached), not Failed"
        );
    }

    /// An icon-scale embedded image is skipped, so a mostly-blank PDF carrying a
    /// small logo does not pay three model passes for nothing.
    #[test]
    fn a_tiny_embedded_image_is_skipped() {
        if !init_ocr_for_tests() {
            return;
        }
        let small = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            32,
            32,
            image::Rgb([10, 10, 10]),
        ));
        let mut buf = std::io::Cursor::new(Vec::new());
        small.write_to(&mut buf, image::ImageFormat::Jpeg).unwrap();
        let pdf = scanned_pdf(&buf.into_inner(), 32, 32, "DCTDecode");
        let r = extract("application/pdf", "logo.pdf", &pdf);
        assert_eq!(r.status, ExtractStatus::Empty);
    }

    // --- image OCR dispatch (MYND-441) ----------------------------------

    /// The three raster formats OCR handles are dispatched by content type.
    #[test]
    fn raster_images_dispatch_to_the_ocr_format() {
        for ct in ["image/png", "image/jpeg", "image/webp"] {
            assert_eq!(
                detect_format(ct, "whatever.bin"),
                Some(SourceFormat::Image),
                "{ct} should dispatch to OCR"
            );
        }
    }

    /// ...and by extension, for attachments stored as `application/octet-stream`
    /// (the MYND-173 default for unsniffed types).
    #[test]
    fn raster_images_dispatch_by_extension_fallback() {
        for name in ["scan.png", "photo.JPG", "shot.jpeg", "pic.webp"] {
            assert_eq!(
                detect_format("application/octet-stream", name),
                Some(SourceFormat::Image),
                "{name} should dispatch to OCR by extension"
            );
        }
    }

    /// GIF and SVG are accepted as attachments by `sniff.rs` but must NOT reach
    /// OCR: GIF is animation, SVG is already text. Asserting on `detect_format`
    /// proves the skip happens before any decode or model pass, not after.
    #[test]
    fn animated_and_vector_images_never_reach_ocr() {
        for (ct, name) in [("image/gif", "loop.gif"), ("image/svg+xml", "logo.svg")] {
            assert_eq!(
                detect_format(ct, name),
                None,
                "{ct} must not dispatch to OCR"
            );
            let r = extract(ct, name, b"\x00\x01\x02");
            assert_eq!(r.status, ExtractStatus::Unsupported);
            assert_eq!(r.source_format, SourceFormat::Other);
        }
    }

    /// Bytes that do not decode as an image are `Failed`, not `Empty` — the
    /// distinction matters because both are cached, and `Failed` is the honest
    /// record that we could not even look.
    #[test]
    fn undecodable_image_bytes_report_failed() {
        init_ocr_for_tests();
        let r = extract(
            "image/png",
            "broken.png",
            b"\x89PNG\r\n\x1a\nnot really a png",
        );
        assert_eq!(r.source_format, SourceFormat::Image);
        assert!(
            matches!(r.status, ExtractStatus::Failed | ExtractStatus::Unsupported),
            "undecodable bytes must not be reported as Ok/Empty, got {:?}",
            r.status
        );
        assert!(r.text.is_empty());
    }

    /// An icon-scale image is skipped before decode: nothing readable lives
    /// under the threshold, and a vault full of small images must cost the
    /// queue nothing.
    #[test]
    fn undersized_images_are_skipped_without_running_ocr() {
        init_ocr_for_tests();
        let tiny = tiny_png(32, 32);
        let r = extract("image/png", "icon.png", &tiny);
        assert_eq!(r.source_format, SourceFormat::Image);
        assert_eq!(
            r.status,
            ExtractStatus::Unsupported,
            "an undersized image is skipped, not attempted"
        );
    }

    /// End-to-end through the real dispatch: a fixture image comes back as
    /// `Ok` with its text and the OCR source format.
    #[test]
    fn a_real_image_extracts_through_the_dispatch() {
        if !init_ocr_for_tests() {
            return; // no LFS blobs in this checkout
        }
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("core")
            .join("tests")
            .join("fixtures")
            .join("ocr-sample.png");
        let bytes = std::fs::read(path).expect("fixture readable");
        let r = extract("image/png", "sample.png", &bytes);
        assert_eq!(r.source_format, SourceFormat::Image);
        assert_eq!(r.status, ExtractStatus::Ok, "expected text, got {r:?}");
        assert!(
            r.text.to_lowercase().contains("invoice"),
            "got {:?}",
            r.text
        );
        assert!(r.char_count > 0);
    }

    fn init_ocr_for_tests() -> bool {
        myne_core::plugins::attachments::ocr::init_from_base(
            &myne_core::plugins::attachments::ocr::bundled_models_dir_for_tests(),
        )
    }

    /// A valid but tiny PNG, encoded in-memory so the fixture stays out of git.
    fn tiny_png(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(w, h, image::Rgb([255, 255, 255]));
        let mut buf = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut buf, image::ImageFormat::Png)
            .expect("encode");
        buf.into_inner()
    }

    #[test]
    fn over_cap_text_is_truncated() {
        let big = "a".repeat(MAX_EXTRACTED_TEXT_LEN + 1000);
        let r = extract("text/plain", "big.txt", big.as_bytes());
        assert_eq!(r.status, ExtractStatus::Ok);
        assert!(r.truncated);
        assert!(r.text.len() <= MAX_EXTRACTED_TEXT_LEN);
        // char_count reflects pre-truncation length.
        assert_eq!(r.char_count as usize, MAX_EXTRACTED_TEXT_LEN + 1000);
    }

    // ── myne#310: the preview grid is bounded in BOTH dimensions ───────────
    //
    // `XLSX_MAX_COLS` bounds one cell REFERENCE and says nothing about the
    // aggregate: the row was padded out to whatever index the ref named, so a
    // ~1 KB sheet whose every row carried one cell at `XFD` produced 16,384
    // `String`s per row (384 KiB for one value), 1,000 rows retained at once
    // (~375 MiB in the worker), ~50 MB of JSON across IPC, and ~8.2 M `<td>`
    // appends in the WebView.
    #[test]
    fn a_single_far_column_cell_does_not_widen_the_row_to_the_excel_ceiling() {
        // One cell at XFD (the 16,384th column) per row — the crafted shape.
        let xml = "<worksheet><sheetData>\
                   <row><c r=\"XFD1\"><v>1</v></c></row>\
                   <row><c r=\"XFD2\"><v>2</v></c></row>\
                   </sheetData></worksheet>";
        let grid = parse_sheet_grid(xml, &[], 1000);
        assert_eq!(grid.len(), 2);
        for row in &grid {
            assert!(
                row.len() <= XLSX_PREVIEW_MAX_COLS,
                "row materialized {} cells; the preview cap is {}",
                row.len(),
                XLSX_PREVIEW_MAX_COLS
            );
        }
    }

    #[test]
    fn cells_inside_the_preview_width_are_kept_verbatim() {
        // The cap must truncate the unreachable tail, not disturb real data.
        let xml = "<worksheet><sheetData>\
                   <row><c r=\"A1\"><v>10</v></c><c r=\"C1\"><v>30</v></c>\
                   <c r=\"XFD1\"><v>lost</v></c></row>\
                   </sheetData></worksheet>";
        let grid = parse_sheet_grid(xml, &[], 1000);
        assert_eq!(grid.len(), 1);
        assert_eq!(grid[0][0], "10");
        assert_eq!(grid[0][1], ""); // sparse fill, unchanged
        assert_eq!(grid[0][2], "30");
        assert_eq!(grid[0].len(), 3, "no padding past the last kept cell");
    }

    #[test]
    fn the_last_column_inside_the_cap_is_still_materialized() {
        // Off-by-one at the boundary: index 255 is in, 256 is out.
        let inside = format!(
            "<worksheet><sheetData><row><c r=\"{}1\"><v>x</v></c></row></sheetData></worksheet>",
            col_name(XLSX_PREVIEW_MAX_COLS - 1)
        );
        let grid = parse_sheet_grid(&inside, &[], 10);
        assert_eq!(grid[0].len(), XLSX_PREVIEW_MAX_COLS);
        assert_eq!(grid[0][XLSX_PREVIEW_MAX_COLS - 1], "x");

        let outside = format!(
            "<worksheet><sheetData><row><c r=\"{}1\"><v>x</v></c></row></sheetData></worksheet>",
            col_name(XLSX_PREVIEW_MAX_COLS)
        );
        let grid = parse_sheet_grid(&outside, &[], 10);
        assert!(grid[0].is_empty());
    }

    /// Zero-based column index → its A1 letters (`0` → `A`, `26` → `AA`).
    fn col_name(mut idx: usize) -> String {
        let mut out = Vec::new();
        loop {
            out.push(b'A' + (idx % 26) as u8);
            if idx < 26 {
                break;
            }
            idx = idx / 26 - 1;
        }
        out.reverse();
        String::from_utf8(out).expect("ascii")
    }

    // ── myne#309: the embedded-PDF-image inflate is bounded ────────────────
    //
    // `lopdf`'s `Stream::decompressed_content()` is `ZlibDecoder::read_to_end`
    // with no ceiling. Deflate reaches ~1030:1, so a PDF well under the 64 MiB
    // import cap could carry one page image that inflated toward tens of GB —
    // and the process is OOM-killed long before the allocator refuses, which
    // neither `guard`'s `catch_unwind` nor a join-error arm can turn into
    // `Failed`. The OCR queue re-runs the same attachment on every unlock, so
    // one hostile file took the app down repeatedly.

    /// Zlib-compress `bytes` the way a PDF `/FlateDecode` stream carries them.
    fn deflate(bytes: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
        enc.write_all(bytes).expect("deflate");
        enc.finish().expect("deflate finish")
    }

    #[test]
    fn a_deflate_bomb_is_refused_without_inflating_it() {
        // 64 MiB of zeros compresses to a few tens of KiB — the shape of the
        // attack, at a size a test can hold. The probe must answer `false`
        // having buffered nothing proportional to the payload.
        let bomb = deflate(&vec![0u8; 64 * 1024 * 1024]);
        assert!(
            bomb.len() < 256 * 1024,
            "fixture is not compressed enough to be the case under test: {}",
            bomb.len()
        );
        // A 100x100 image can legitimately hold at most 100*100*4 bytes, but the
        // floor lifts the ceiling to 1 MiB — still four orders below the bomb.
        assert!(!flate_inflates_within(
            &bomb,
            plausible_samples_ceiling(100, 100)
        ));
    }

    #[test]
    fn a_real_sized_sample_stream_passes() {
        // Exactly what a DeviceRGB 200x150 page image inflates to. The guard
        // must not reject the thing it exists to admit.
        let samples = vec![0x7fu8; 200 * 150 * 3];
        let stream = deflate(&samples);
        assert!(flate_inflates_within(
            &stream,
            plausible_samples_ceiling(200, 150)
        ));
    }

    #[test]
    fn the_ceiling_tracks_the_declared_geometry_with_a_floor() {
        // Large enough to matter → geometry governs (w*h*4).
        assert_eq!(plausible_samples_ceiling(1000, 1000), 4_000_000);
        // Small → the floor governs, so a legal small stream is never squeezed.
        assert_eq!(plausible_samples_ceiling(96, 96), 1024 * 1024);
        // No overflow at absurd declared dimensions (the arithmetic is u64).
        assert!(plausible_samples_ceiling(u32::MAX, u32::MAX) > 0);
    }

    #[test]
    fn a_corrupt_stream_is_refused_rather_than_trusted() {
        // Not zlib at all: the decode that follows would fail anyway, so the
        // pre-flight reaching the same answer earlier costs nothing.
        assert!(!flate_inflates_within(b"not a zlib stream", 1024 * 1024));
    }

    // The postcard payload round-trip tests moved with the types to
    // `myne_core::plugins::attachments::extract_types`.
}
