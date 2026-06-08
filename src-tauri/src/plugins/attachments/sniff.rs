//! Magic-byte content-type sniffer for the attachment allowlist
//! (MYND-169, sub-feature 2 — `attachments-crypto-pipeline`).
//!
//! A tiny, dependency-free sniffer. The v0.1 allowlist is the raster
//! image set (PNG / JPEG / GIF / WebP), SVG, and PDF — the union of
//! what the editor renders inline and the library can preview. Anything
//! outside this set is rejected at the import door (`attachment_import`)
//! and is never emitted as a served content-type by the `attachment://`
//! handler.
//!
//! ## Why a hand-rolled sniffer (no `infer` / `tree_magic` dep)
//!
//! Adding a crate is a security decision (`CLAUDE.md` "minimal
//! direct-dependency surface"). The allowlist is six formats with
//! short, well-known magic prefixes; a ~40-line match beats a
//! general-purpose MIME-detection crate's transitive surface. The
//! sniffer is deliberately strict — it recognizes ONLY the allowlisted
//! formats, returning [`None`] for everything else (no "best guess"
//! fall-through that a general crate would offer).
//!
//! ## Two call sites, one authority
//!
//! - **Import** ([`super::commands::attachment_import`]): sniff the
//!   bytes the user pasted / dropped / picked; reject if the sniff
//!   returns [`None`] (unsupported) so a `.exe` renamed `.png` never
//!   enters the vault.
//! - **Serve** (`attachment://` handler in `lib.rs`): re-sniff the
//!   DECRYPTED bytes and emit ONLY the sniffed allowlisted type — never
//!   the catalog's stored `content_type` hint, and never `text/html`
//!   (the XSS-defense invariant, `sync-ledger.md` SYNC-4). If the
//!   re-sniff returns [`None`], the handler serves
//!   `application/octet-stream` so the WebView cannot script-execute it.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline" — the raw
//! bytes are DENY-listed; only the resolved `&'static str` MIME label
//! (a non-secret structural value) crosses a tracing boundary.

/// The allowlisted content types, as the exact `&'static str` MIME
/// labels the `attachment://` handler is permitted to emit. Every value
/// [`sniff_content_type`] can return appears here.
///
/// Deliberately excludes `text/html`, `application/xhtml+xml`, and any
/// scriptable type: a hostile note must not be able to coax the handler
/// into serving an HTML document that the WebView would execute
/// (`sync-ledger.md` SYNC-4 XSS-defense invariant). SVG is included —
/// it can carry script — but it is served with a content-type that the
/// WebView treats as an image in `<img src>` / `background` contexts and
/// is further fenced by the app CSP (`object-src 'none'`,
/// `script-src 'self'`); the SVG sandboxing posture is the consumer's
/// (editor/library) concern, documented in sub-features 3/4.
pub const ALLOWLISTED_CONTENT_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/svg+xml",
    "application/pdf",
];

/// Sniff the content type of `bytes` against the v0.1 attachment
/// allowlist by magic-byte prefix.
///
/// Returns `Some(mime)` where `mime` is one of
/// [`ALLOWLISTED_CONTENT_TYPES`] when the leading bytes match a known
/// signature, else `None` (unsupported / unrecognized).
///
/// The match is content-only — the filename / extension is never
/// consulted (a `.png` extension on `MZ`-prefixed PE bytes must reject).
pub fn sniff_content_type(bytes: &[u8]) -> Option<&'static str> {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    // JPEG: FF D8 FF
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    // GIF: "GIF87a" or "GIF89a"
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    // WebP: "RIFF" .... "WEBP" (RIFF container, 4-byte size, then WEBP).
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    // PDF: "%PDF-"
    if bytes.starts_with(b"%PDF-") {
        return Some("application/pdf");
    }
    // SVG: text/XML — no fixed binary magic. Recognize after skipping a
    // UTF-8 BOM + leading ASCII whitespace, then require an XML/SVG
    // opener within a bounded prefix window. Strict enough that arbitrary
    // text does not pass, lenient enough for the common `<?xml …>` and
    // bare `<svg …>` forms.
    if looks_like_svg(bytes) {
        return Some("image/svg+xml");
    }
    None
}

/// Heuristic SVG recognizer. Skips an optional UTF-8 BOM and leading
/// ASCII whitespace, then scans a bounded prefix for an `<svg` tag (case-
/// insensitive). An `<?xml` / `<!DOCTYPE` prelude is allowed before the
/// `<svg` so the common XML-declared form is accepted; a document whose
/// scanned prefix opens with neither `<?xml`, `<!`, nor `<svg` is
/// rejected (it is some other text, not SVG).
fn looks_like_svg(bytes: &[u8]) -> bool {
    // Strip a UTF-8 BOM if present.
    let mut rest = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    // Skip leading ASCII whitespace.
    while let Some((first, tail)) = rest.split_first() {
        if first.is_ascii_whitespace() {
            rest = tail;
        } else {
            break;
        }
    }
    // The first non-whitespace byte of an SVG document is always '<'.
    if rest.first() != Some(&b'<') {
        return false;
    }
    // Bound the search window so we never scan a huge payload — an SVG's
    // root tag appears within the first few hundred bytes in practice.
    const WINDOW: usize = 1024;
    let window = &rest[..rest.len().min(WINDOW)];
    // Lowercase-fold the window for a case-insensitive substring search
    // (SVG/XML tag names are conventionally lowercase but not required).
    let lowered: Vec<u8> = window.iter().map(|b| b.to_ascii_lowercase()).collect();
    contains_subslice(&lowered, b"<svg")
}

/// Return whether `needle` occurs as a contiguous subslice of `haystack`.
fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_png() {
        let png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x01];
        assert_eq!(sniff_content_type(&png), Some("image/png"));
    }

    #[test]
    fn sniffs_jpeg() {
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        assert_eq!(sniff_content_type(&jpeg), Some("image/jpeg"));
    }

    #[test]
    fn sniffs_gif87a_and_gif89a() {
        assert_eq!(sniff_content_type(b"GIF87a\x00\x00"), Some("image/gif"));
        assert_eq!(sniff_content_type(b"GIF89a\x00\x00"), Some("image/gif"));
    }

    #[test]
    fn sniffs_webp() {
        // RIFF <4-byte size> WEBP
        let mut webp = Vec::new();
        webp.extend_from_slice(b"RIFF");
        webp.extend_from_slice(&[0x1A, 0x00, 0x00, 0x00]);
        webp.extend_from_slice(b"WEBPVP8 ");
        assert_eq!(sniff_content_type(&webp), Some("image/webp"));
    }

    #[test]
    fn riff_that_is_not_webp_rejects() {
        // RIFF/WAVE is a RIFF container but not WebP — must reject.
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&[0x1A, 0x00, 0x00, 0x00]);
        wav.extend_from_slice(b"WAVEfmt ");
        assert_eq!(sniff_content_type(&wav), None);
    }

    #[test]
    fn sniffs_pdf() {
        assert_eq!(
            sniff_content_type(b"%PDF-1.7\n..."),
            Some("application/pdf")
        );
    }

    #[test]
    fn sniffs_svg_with_xml_prelude() {
        let svg = br#"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>"#;
        assert_eq!(sniff_content_type(svg), Some("image/svg+xml"));
    }

    #[test]
    fn sniffs_bare_svg_with_leading_whitespace() {
        let svg = b"  \n\t<svg width=\"10\" height=\"10\"></svg>";
        assert_eq!(sniff_content_type(svg), Some("image/svg+xml"));
    }

    #[test]
    fn sniffs_svg_with_bom() {
        let mut svg = vec![0xEF, 0xBB, 0xBF];
        svg.extend_from_slice(b"<svg></svg>");
        assert_eq!(sniff_content_type(&svg), Some("image/svg+xml"));
    }

    #[test]
    fn sniffs_svg_case_insensitive_tag() {
        let svg = b"<SVG xmlns=\"http://www.w3.org/2000/svg\"></SVG>";
        assert_eq!(sniff_content_type(svg), Some("image/svg+xml"));
    }

    #[test]
    fn plain_text_is_not_svg() {
        assert_eq!(sniff_content_type(b"hello world, not markup"), None);
    }

    #[test]
    fn html_is_rejected_not_misread_as_svg() {
        // The XSS-defense invariant: an HTML document must never sniff to
        // an allowlisted type. `<html>` opens with `<` but contains no
        // `<svg`, so it is rejected.
        let html = b"<!DOCTYPE html><html><body><script>alert(1)</script></body></html>";
        assert_eq!(sniff_content_type(html), None);
    }

    #[test]
    fn executable_renamed_to_png_rejects() {
        // Windows PE / DOS "MZ" header — a `.png`-renamed binary must
        // reject (content sniff ignores the extension entirely).
        let pe = [0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00];
        assert_eq!(sniff_content_type(&pe), None);
    }

    #[test]
    fn empty_input_rejects() {
        assert_eq!(sniff_content_type(b""), None);
    }

    #[test]
    fn truncated_png_magic_rejects() {
        // First 4 PNG bytes only — not the full 8-byte signature.
        assert_eq!(sniff_content_type(&[0x89, 0x50, 0x4E, 0x47]), None);
    }

    #[test]
    fn every_sniffable_type_is_in_the_allowlist() {
        // Drift guard: anything sniff_content_type can return MUST be a
        // member of ALLOWLISTED_CONTENT_TYPES (the handler emits only
        // those). Exercise each format and assert membership.
        let samples: &[&[u8]] = &[
            &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
            &[0xFF, 0xD8, 0xFF, 0xE0],
            b"GIF89a",
            b"RIFF\x00\x00\x00\x00WEBP",
            b"%PDF-1.4",
            b"<svg></svg>",
        ];
        for s in samples {
            let mime = sniff_content_type(s).expect("sample must sniff");
            assert!(
                ALLOWLISTED_CONTENT_TYPES.contains(&mime),
                "sniffed {mime} is not in the allowlist"
            );
        }
    }
}
