// SPDX-License-Identifier: AGPL-3.0
//! Magic-byte content-type sniffer for the attachment allowlist
//! (MYND-169, sub-feature 2 — `attachments-crypto-pipeline`).
//!
//! A tiny, dependency-free sniffer. The v0.1 allowlist is the raster
//! image set (PNG / JPEG / GIF / WebP), SVG, PDF, WAV audio (MYND-259),
//! and MP4 / WebM video (myne#168) — the union of what the editor renders
//! inline and the library can preview. This set governs what the
//! `attachment://` handler is permitted to SERVE; it is never emitted for
//! anything outside the set.
//!
//! Since MYND-173 the allowlist no longer gates IMPORT. `attachment_import`
//! accepts arbitrary bytes; a type the sniffer does not recognize is
//! stored as an opaque `application/octet-stream` attachment that renders
//! in the editor as an export-only file-card and is never served inline.
//! The render allowlist is therefore a *serve-time* authority, not an
//! import gate — the XSS-defense invariant lives entirely on the serve
//! path (re-sniff + octet-stream fallback), where a `.png`-renamed binary
//! still cannot become a scriptable served resource.
//!
//! ## Why a hand-rolled sniffer (no `infer` / `tree_magic` dep)
//!
//! Adding a crate is a security decision (`AGENTS.md` "minimal
//! direct-dependency surface"). The allowlist is nine formats with
//! short, well-known magic prefixes (video adds a bounded major-brand /
//! DocType check on top of the prefix); a compact hand-rolled match beats
//! a general-purpose MIME-detection crate's transitive surface. The
//! sniffer is deliberately strict — it recognizes ONLY the allowlisted
//! formats, returning [`None`] for everything else (no "best guess"
//! fall-through that a general crate would offer).
//!
//! ## Two call sites, one authority
//!
//! - **Import** ([`super::commands::attachment_import`]): sniff the
//!   bytes the user pasted / dropped / picked to classify renderables;
//!   a [`None`] sniff is stored as `application/octet-stream` (an
//!   export-only file-card), not rejected (MYND-173).
//! - **Serve** (`attachment://` handler in `lib.rs`): re-sniff the
//!   DECRYPTED bytes and emit ONLY the sniffed allowlisted type — never
//!   the catalog's stored `content_type` hint, and never `text/html`
//!   (the XSS-defense invariant, `sync-ledger.md` SYNC-4). If the
//!   re-sniff returns [`None`], the handler serves
//!   `application/octet-stream` so the WebView cannot script-execute it.
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline" — the raw
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
    "audio/wav",
    "video/mp4",
    "video/webm",
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
/// The content type an attachment's decrypted bytes are SERVED as.
///
/// # This function is the XSS defence, and it is why it is not two functions
///
/// The rule is: the served type is derived from the BYTES, allowlist-fenced, and
/// is never the catalog's `content_type` hint and never `text/html`. An
/// unrecognized sniff falls back to `application/octet-stream`, which no browser
/// executes — so a blob that was tampered with but still decrypts (an attacker
/// who can write the vault already holds the keys) cannot become script.
///
/// It exists as a named function, rather than as
/// `sniff_content_type(b).unwrap_or("application/octet-stream")` written at each
/// serve site, because there are now **two** serve sites and they run on
/// different targets: the desktop `attachment://` protocol handler
/// (`scheme_core::build_response`, which is `tauri::http`-typed and synchronous)
/// and the browser's object-URL mint (phase3-web-client task 44, which is
/// async and has no HTTP layer at all). Two copies of a three-line security
/// decision is exactly the shape that drifts, and the one that drifts is the one
/// nobody is watching.
///
/// The `debug_assert` is a canary rather than a check: it fires in tests if a
/// future sniffer ever returns something outside the allowlist, which would mean
/// the fence had been widened somewhere other than
/// [`ALLOWLISTED_CONTENT_TYPES`].
pub fn served_content_type(plaintext: &[u8]) -> &'static str {
    let served = sniff_content_type(plaintext).unwrap_or(OCTET_STREAM);
    debug_assert!(
        served == OCTET_STREAM || ALLOWLISTED_CONTENT_TYPES.contains(&served),
        "served type must be allowlisted or the octet-stream fallback"
    );
    served
}

/// The non-scriptable fallback for bytes the sniffer does not recognize.
///
/// Deliberately NOT a member of [`ALLOWLISTED_CONTENT_TYPES`]: an
/// octet-stream attachment is never rendered inline anywhere — it surfaces as an
/// export-only file card — so a `.png`-named binary cannot become a served,
/// scriptable resource.
pub const OCTET_STREAM: &str = "application/octet-stream";

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
    // WAV: "RIFF" .... "WAVE" (RIFF container, 4-byte size, then WAVE).
    // Same RIFF family as WebP, distinguished by the form-type at [8..12].
    // Voice notes (MYND-259) record/import as WAV; the recorder emits
    // canonical "WAVE" containers and imported audio is recognized here.
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WAVE" {
        return Some("audio/wav");
    }
    // PDF: "%PDF-"
    if bytes.starts_with(b"%PDF-") {
        return Some("application/pdf");
    }
    // MP4 (ISO-BMFF, H.264/AAC): an `ftyp` box at offset 4 whose major
    // brand is in the in-scope set. MOV/QuickTime shares the `ftyp` box
    // (major brand "qt  ") and is deliberately excluded (myne#168).
    if looks_like_mp4(bytes) {
        return Some("video/mp4");
    }
    // WebM (a Matroska subset): the EBML header magic followed by a "webm"
    // DocType within a bounded window. Generic Matroska/MKV (DocType
    // "matroska") shares the magic and is excluded (myne#168).
    if looks_like_webm(bytes) {
        return Some("video/webm");
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

/// The ISO-BMFF major brands recognized as in-scope MP4 video. MOV's
/// `qt  ` brand is absent by construction, so QuickTime rejects here and
/// degrades to the file card (myne#168 supported set: MP4 H.264/AAC). The
/// set can be widened as real-world brands demand; the `qt  ` exclusion is
/// fixed (`sync-ledger.md` SYNC-2 of the video-attachments epic).
const MP4_MAJOR_BRANDS: &[&[u8]] = &[
    b"isom", b"mp41", b"mp42", b"avc1", b"iso2", b"M4V ", b"dash",
];

/// Recognize an ISO-BMFF (MP4) stream by its `ftyp` box: a 4-byte box size
/// is followed by the ASCII tag `ftyp` at offset 4 and the major brand at
/// offset 8. Only the brands in [`MP4_MAJOR_BRANDS`] pass, so MOV (`qt  `)
/// and 3GP (`3gp4`) fall through — the brand gate is what keeps the
/// out-of-scope containers off the video path.
fn looks_like_mp4(bytes: &[u8]) -> bool {
    if bytes.len() < 12 || &bytes[4..8] != b"ftyp" {
        return false;
    }
    let major = &bytes[8..12];
    MP4_MAJOR_BRANDS.contains(&major)
}

/// Recognize a WebM stream: the EBML header magic `1A 45 DF A3` followed by a
/// `webm` DocType *element*. Matching the full DocType marker — element ID
/// `42 82`, a length-4 vint `84`, then the ASCII `webm` — rather than a bare
/// `webm` substring is what actually excludes a generic Matroska/MKV file:
/// MKV's DocType is `matroska`, and its writing-app / tag / title metadata may
/// itself contain the string `webm` (ffmpeg-muxed files often do), which a bare
/// substring scan would false-positive on. Scanned within a bounded window like
/// [`looks_like_svg`], since the DocType lives in the EBML header, never deep in
/// the stream. A non-canonical DocType size encoding (multi-byte vint) is not
/// matched and falls back to the file card — acceptable, since standard muxers
/// emit the 1-byte `84`.
fn looks_like_webm(bytes: &[u8]) -> bool {
    if !bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return false;
    }
    // DocType element (ID 0x4282) + length-4 vint (0x84) + the ASCII "webm".
    const WEBM_DOCTYPE: &[u8] = &[0x42, 0x82, 0x84, b'w', b'e', b'b', b'm'];
    const WINDOW: usize = 1024;
    let window = &bytes[..bytes.len().min(WINDOW)];
    contains_subslice(window, WEBM_DOCTYPE)
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
    fn sniffs_wav() {
        // RIFF <4-byte size> WAVE — a canonical WAV container (MYND-259).
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&[0x1A, 0x00, 0x00, 0x00]);
        wav.extend_from_slice(b"WAVEfmt ");
        assert_eq!(sniff_content_type(&wav), Some("audio/wav"));
    }

    #[test]
    fn riff_that_is_neither_webp_nor_wave_rejects() {
        // A RIFF container that is neither WebP nor WAV (e.g. AVI) must
        // reject — RIFF alone is not an allowlisted form-type.
        let mut avi = Vec::new();
        avi.extend_from_slice(b"RIFF");
        avi.extend_from_slice(&[0x1A, 0x00, 0x00, 0x00]);
        avi.extend_from_slice(b"AVI LIST");
        assert_eq!(sniff_content_type(&avi), None);
    }

    #[test]
    fn riff_wave_distinguished_from_webp() {
        // The two RIFF forms must not collide: WEBP→image, WAVE→audio.
        let mut webp = Vec::new();
        webp.extend_from_slice(b"RIFF\x1A\x00\x00\x00WEBP");
        assert_eq!(sniff_content_type(&webp), Some("image/webp"));
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF\x1A\x00\x00\x00WAVE");
        assert_eq!(sniff_content_type(&wav), Some("audio/wav"));
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
    fn sniffs_mp4_isom_brand() {
        // ISO-BMFF: 4-byte box size, "ftyp", in-scope major brand "isom".
        let mp4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00mp41";
        assert_eq!(sniff_content_type(mp4), Some("video/mp4"));
    }

    #[test]
    fn sniffs_mp4_mp42_and_avc1_brands() {
        assert_eq!(
            sniff_content_type(b"\x00\x00\x00\x18ftypmp42...."),
            Some("video/mp4")
        );
        assert_eq!(
            sniff_content_type(b"\x00\x00\x00\x18ftypavc1...."),
            Some("video/mp4")
        );
    }

    #[test]
    fn mov_quicktime_ftyp_rejects() {
        // MOV shares the `ftyp` box (major brand "qt  ") and is OUT of scope —
        // it must fall through to octet-stream / the file card, never video/mp4.
        let mov = b"\x00\x00\x00\x14ftypqt  \x00\x00\x02\x00qt  ";
        assert_eq!(sniff_content_type(mov), None);
    }

    #[test]
    fn ftyp_out_of_scope_brand_rejects() {
        // 3GP (major brand "3gp4") is not in the MP4 set.
        assert_eq!(sniff_content_type(b"\x00\x00\x00\x18ftyp3gp4...."), None);
    }

    #[test]
    fn too_short_ftyp_rejects() {
        // Fewer than 12 bytes cannot carry a major brand.
        assert_eq!(sniff_content_type(b"\x00\x00\x00\x18ftyp"), None);
    }

    #[test]
    fn sniffs_webm_with_doctype() {
        // EBML header (1A 45 DF A3) + a "webm" DocType within the header window.
        let webm = b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\x82\x84webm";
        assert_eq!(sniff_content_type(webm), Some("video/webm"));
    }

    #[test]
    fn matroska_without_webm_doctype_rejects() {
        // Generic Matroska/MKV (DocType "matroska") shares the EBML magic but
        // is OUT of scope — it must reject, not sniff as WebM.
        let mkv = b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\x82\x88matroska";
        assert_eq!(sniff_content_type(mkv), None);
    }

    #[test]
    fn matroska_with_webm_in_metadata_rejects() {
        // A generic Matroska (DocType "matroska") whose WritingApp/tag string
        // merely CONTAINS "webm" (ffmpeg-muxed files often carry "libwebm") must
        // NOT mis-classify as WebM — only the DocType element (42 82 84 "webm")
        // counts, never a bare "webm" substring.
        let mkv = b"\x1a\x45\xdf\xa3\x9f\x42\x82\x88matroska\x4d\x80\x87libwebm";
        assert_eq!(sniff_content_type(mkv), None);
    }

    #[test]
    fn ebml_magic_alone_is_not_webm() {
        // The bare EBML magic with no DocType must not classify as WebM.
        assert_eq!(sniff_content_type(&[0x1A, 0x45, 0xDF, 0xA3]), None);
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
            b"RIFF\x00\x00\x00\x00WAVE",
            b"\x00\x00\x00\x18ftypisom",
            b"\x1A\x45\xDF\xA3\x42\x82\x84webm",
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
