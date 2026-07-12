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
    ExtractStatus, ExtractedText, SourceFormat, MAX_EXTRACTED_TEXT_LEN,
};
use unicode_normalization::UnicodeNormalization;

/// Extract searchable text from an attachment's decrypted `bytes`, dispatching
/// on `content_type` first and the `filename` extension as a fallback (an
/// attachment stored as `application/octet-stream` — the MYND-173 default for
/// unsniffed types — still extracts when its name ends in a known extension).
pub fn extract(content_type: &str, filename: &str, bytes: &[u8]) -> ExtractedText {
    match detect_format(content_type, filename) {
        Some(SourceFormat::Pdf) => guard(SourceFormat::Pdf, || extract_pdf(bytes)),
        Some(SourceFormat::Docx) => guard(SourceFormat::Docx, || extract_docx(bytes)),
        Some(SourceFormat::Text) => guard(SourceFormat::Text, || extract_text_like(bytes)),
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
    std::panic::catch_unwind(f)
        .unwrap_or_else(|_| ExtractedText::negative(ExtractStatus::Failed, fmt))
}

fn detect_format(content_type: &str, filename: &str) -> Option<SourceFormat> {
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
        _ => None,
    }
}

fn extract_pdf(bytes: &[u8]) -> ExtractedText {
    let doc = match lopdf::Document::load_mem(bytes) {
        Ok(d) => d,
        Err(_) => return ExtractedText::negative(ExtractStatus::Failed, SourceFormat::Pdf),
    };
    let pages: Vec<u32> = doc.get_pages().keys().copied().collect();
    match doc.extract_text(&pages) {
        Ok(text) => finalize(text, SourceFormat::Pdf),
        Err(_) => ExtractedText::negative(ExtractStatus::Failed, SourceFormat::Pdf),
    }
}

fn extract_docx(bytes: &[u8]) -> ExtractedText {
    use std::io::Read;
    let mut archive = match zip::ZipArchive::new(std::io::Cursor::new(bytes)) {
        Ok(a) => a,
        Err(_) => return ExtractedText::negative(ExtractStatus::Failed, SourceFormat::Docx),
    };
    let mut xml = String::new();
    match archive.by_name("word/document.xml") {
        Ok(mut f) => {
            if f.read_to_string(&mut xml).is_err() {
                return ExtractedText::negative(ExtractStatus::Failed, SourceFormat::Docx);
            }
        }
        Err(_) => return ExtractedText::negative(ExtractStatus::Failed, SourceFormat::Docx),
    }
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
/// corrupt / absent sheet yields an empty grid.
pub fn extract_xlsx_grid(bytes: &[u8], max_rows: usize) -> Vec<Vec<String>> {
    use std::io::Read;
    let mut archive = match zip::ZipArchive::new(std::io::Cursor::new(bytes)) {
        Ok(a) => a,
        Err(_) => return Vec::new(),
    };
    // Shared-strings table (optional — numeric-only sheets omit it).
    let shared = {
        let mut xml = String::new();
        if let Ok(mut f) = archive.by_name("xl/sharedStrings.xml") {
            let _ = f.read_to_string(&mut xml);
        }
        parse_shared_strings(&xml)
    };
    let mut sheet_xml = String::new();
    match archive.by_name("xl/worksheets/sheet1.xml") {
        Ok(mut f) => {
            if f.read_to_string(&mut sheet_xml).is_err() {
                return Vec::new();
            }
        }
        Err(_) => return Vec::new(),
    }
    parse_sheet_grid(&sheet_xml, &shared, max_rows)
}

/// Zero-based column index of an A1-style cell ref (`"B3"` → 1). Non-alphabetic
/// suffix (the row number) ends the run.
fn col_index(cell_ref: &str) -> usize {
    let mut idx = 0usize;
    for c in cell_ref.chars() {
        if c.is_ascii_alphabetic() {
            idx = idx * 26 + (c.to_ascii_uppercase() as usize - 'A' as usize + 1);
        } else {
            break;
        }
    }
    idx.saturating_sub(1)
}

/// Parse `xl/sharedStrings.xml` into the ordered string table (`<si><t>…</t></si>`).
fn parse_shared_strings(xml: &str) -> Vec<String> {
    use quick_xml::events::Event;
    use quick_xml::reader::Reader;
    let mut reader = Reader::from_str(xml);
    let mut strings: Vec<String> = Vec::new();
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
                    strings.push(std::mem::take(&mut cur));
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
    let mut cur_col = 0usize;
    let mut cur_is_shared = false;
    let mut cur_value = String::new();
    let mut in_value = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.local_name().as_ref() == b"c" => {
                cur_col = 0;
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
                    if current.len() <= cur_col {
                        current.resize(cur_col + 1, String::new());
                    }
                    current[cur_col] = resolved;
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

/// NFC-normalize, apply the size cap, and classify (`Ok` vs `Empty`).
fn finalize(raw: String, fmt: SourceFormat) -> ExtractedText {
    let normalized: String = raw.nfc().collect();
    let char_count = normalized.chars().count() as u32;

    let (mut text, truncated) = if normalized.len() > MAX_EXTRACTED_TEXT_LEN {
        let mut end = MAX_EXTRACTED_TEXT_LEN;
        while end > 0 && !normalized.is_char_boundary(end) {
            end -= 1;
        }
        (normalized[..end].to_string(), true)
    } else {
        (normalized, false)
    };

    if text.trim().is_empty() {
        text.clear();
        return ExtractedText {
            status: ExtractStatus::Empty,
            source_format: fmt,
            text,
            char_count,
            truncated,
        };
    }
    ExtractedText {
        status: ExtractStatus::Ok,
        source_format: fmt,
        text,
        char_count,
        truncated,
    }
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
        assert_eq!(grid, vec![vec!["x".to_string(), String::new(), "z".to_string()]]);
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
        let r = extract("image/png", "pic.png", b"\x89PNG\r\n");
        assert_eq!(r.status, ExtractStatus::Unsupported);
        assert_eq!(r.source_format, SourceFormat::Other);
        assert!(r.text.is_empty());
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

    // The postcard payload round-trip tests moved with the types to
    // `myne_core::plugins::attachments::extract_types`.
}
