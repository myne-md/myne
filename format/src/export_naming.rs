// SPDX-License-Identifier: AGPL-3.0
//! Shared export-naming vocabulary for the export suite (MYND-115 /
//! MYND-211): filename sanitization, deterministic `" (1)"` suffix
//! dedup, and the §6 sanctioned embed rewrite. One rule on every
//! export surface by design — the per-note attachments export
//! (`plugins::notes`), the whole-vault tree export (`plugins::export`),
//! and any future exporter sanitize and dedup identically.
//!
//! The two dedup *loops* deliberately stay with their owners (the
//! notes export dedups against the real filesystem via
//! `atomic_write(replace=false)`; the tree export dedups against an
//! in-run assigned-name set because staging starts empty) — only the
//! shared vocabulary lives here.

use std::collections::HashMap;

use unicode_normalization::UnicodeNormalization;

use crate::embed_span::AttEmbedSpan;

/// Suffix-dedup retry cap shared by both export dedup loops — a
/// pathological collision flood bails closed instead of spinning.
pub const DEDUP_RETRY_CAP: u32 = 9_999;

/// The collision oracle two export names are compared under — NFC, then ASCII
/// case-folded.
///
/// # Why folding at all
///
/// A destination volume decides whether two names are the same file, and the
/// two volumes Myne exports onto most do not decide it byte-wise. NTFS and a
/// default APFS volume are case-insensitive, and APFS (10.13+) compares
/// normalization-insensitively as well while preserving the bytes it was given.
/// So `Cafe\u{0301}.md` (NFD) and `Caf\u{e9}.md` (NFC) are ONE file there, and an
/// exporter whose in-run oracle compares bytes writes the second over the first.
/// That is silent data loss inside an export: the run reports success, the tree
/// has one file where the vault had two notes, and the note that lost is
/// whichever came second in an ordering nobody chose.
///
/// # Why NFC and not full case folding
///
/// `to_ascii_lowercase`, not `to_lowercase`: it matches what the platforms
/// actually do closely enough for a collision oracle and cannot change a
/// string's length, so the suffix arithmetic is unaffected. A pair differing
/// only in NON-ASCII case still collides on the volume and is a narrower
/// residue than the one this closes — and full Unicode case folding is not what
/// either filesystem implements either.
///
/// NFC is a different axis and does not share that caveat: it is exactly what
/// APFS compares under, so folding it here matches the volume rather than
/// approximating it.
///
/// # Direction
///
/// Folding can only make the oracle see MORE collisions, never fewer, so the
/// worst case of an over-eager fold is a `" (1)"` suffix on a name that would
/// have been fine. The worst case of an under-eager one is a lost note. Prefer
/// the suffix.
pub fn export_dedup_key(name: &str) -> String {
    name.nfc().collect::<String>().to_ascii_lowercase()
}

/// Make one export name component (catalog display filename, FM
/// `title:`, or tree folder segment) safe as a filesystem name and as
/// a `![[…]]` wikilink target: path separators, embed-grammar breakers
/// (`|`, `[`, `]`), Windows-reserved punctuation (`: * ? " < >` —
/// 115-F4/211-L2: one such char used to hard-fail the whole export on
/// Windows with an opaque `Io`), and control chars become `_`;
/// trailing dots AND spaces drop (Windows footgun,
/// `markdown-dialect.md` §3.6.2); Windows-reserved device basenames
/// (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`,
/// case-insensitive, with or without extension) get a `_` prefix; an
/// empty residue falls back to `fallback` (`"attachment"` for
/// attachment/title surfaces, `"_"` for tree directory segments — so a
/// pathological segment like `".."` can never traverse or vanish).
/// Deterministic — the same input always sanitizes identically.
pub fn sanitize_export_component(name: &str, fallback: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| match c {
            '/' | '\\' | '|' | '[' | ']' => '_',
            ':' | '*' | '?' | '"' | '<' | '>' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    // Trailing dots and spaces in ONE matcher — the sequential
    // dots-then-spaces trim missed mixed tails like `"x. "`.
    let cleaned = cleaned.trim_end_matches(['.', ' ']);
    if cleaned.is_empty() {
        fallback.to_string()
    } else if is_windows_reserved_basename(cleaned) {
        format!("_{cleaned}")
    } else {
        cleaned.to_string()
    }
}

/// `true` when `name`'s basename (the part before the FIRST dot — the
/// rule Windows applies, so `NUL.txt` and `COM7.tar.gz` are both
/// reserved) is one of the legacy DOS device names, case-insensitive:
/// `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`. `COM0` /
/// `LPT0` and longer names (`CONSOLE`) are NOT reserved.
fn is_windows_reserved_basename(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name);
    let up = stem.to_ascii_uppercase();
    match up.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" => true,
        _ => {
            up.len() == 4
                && (up.starts_with("COM") || up.starts_with("LPT"))
                && up.as_bytes()[3].is_ascii_digit()
                && up.as_bytes()[3] != b'0'
        }
    }
}

/// `photo.png` + 1 → `photo (1).png`; extensionless / dot-leading names
/// suffix at the end (`notes` + 2 → `notes (2)`, `.env` + 1 →
/// `.env (1)`).
pub fn suffixed_filename(name: &str, n: u32) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 => format!("{} ({}){}", &name[..dot], n, &name[dot..]),
        _ => format!("{name} ({n})"),
    }
}

/// Translate a form-C alias's layout segments (myne#409) into the alias slot of
/// the exported plain wikilink embed, returning `""` when there is nothing to
/// carry.
///
/// Deliberately NARROW. The canonical grammar lives in TypeScript
/// (`@myne/dialect/embedLayout`), consumed from source by all three clients;
/// this side learns exactly two things: that a pixel `w=` (optionally with
/// `h=`) becomes Obsidian's own `|300` / `|300x200` spelling, and that `alt=`
/// is terminal. Everything else, including a percentage width Obsidian has no
/// slot for, travels through unchanged in its original order. The two
/// implementations are held together by the published `embed-layout` vectors
/// rather than by two parallel parsers, which is the only arrangement in which
/// "narrow" stays true.
///
/// A value the canonical grammar would reject is passed through as an opaque
/// `w=…` segment rather than dropped: refusing to export bytes this side merely
/// failed to understand is how an export loses data. That is why
/// [`is_export_dimension`] exists and why it is not merely "a run of digits":
/// emitting a BARE Obsidian dimension for a rejected value would export `w=0`
/// as `|0`, rendering a zero-width image in Obsidian where Myne renders the
/// default.
fn obsidian_layout_suffix(alias: &str) -> String {
    if alias.is_empty() {
        return String::new();
    }
    // A line break anywhere in the alias makes the whole suffix unusable, so
    // emit none and let the embed export as the bare `![[final name]]` this
    // transform produced before layout existed.
    //
    // `parse_canonical_embed_at` ends an alias at the first `]` and accepts a
    // newline on the way, and `alt=` is terminal, so a note written by a
    // non-Myne tool can carry `alt=a\n\n# Heading` inside a form-C embed.
    // Splicing that through produces an exported wikilink whose closing `]]`
    // is on a later line, which `wikilink.md` §2.1 makes unparseable (a
    // wikilink terminates at the first line break), and turns `# Heading` into
    // a real ATX heading in the exported file. The authoring path cannot
    // produce it (the alt prompt is a single-line input), so the reachable case
    // is a synced or imported note, which is exactly the attacker-influenceable
    // one. Dropping the suffix loses a rendering hint; splicing it corrupts the
    // document.
    if alias.contains('\n') || alias.contains('\r') {
        return String::new();
    }
    let mut width: Option<&str> = None;
    let mut height: Option<&str> = None;
    // Where a lone `h=` belongs in `passthrough` if no pixel width arrives.
    let mut height_at: Option<(usize, &str)> = None;
    let mut passthrough: Vec<&str> = Vec::new();

    // Segment 1 is always the filename and is replaced by the final export
    // name, so it is skipped here. From segment 2 on, an unkeyed segment is
    // part of the filename (a filename may contain a `|`) and is likewise
    // dropped, because the final name already stands in for all of it.
    //
    // `alt=` is TERMINAL: it swallows the remainder of the alias, pipes
    // included. Splitting naively on `|` truncates a pipe-bearing alt at its
    // first pipe, which silently rewrites the author's words on export. The
    // published vectors caught exactly that.
    let mut alt_tail: Option<&str> = None;
    // Byte offset of the segment currently being examined. Accumulated in this
    // one pass so the `alt=` tail can be sliced straight out of `alias`.
    let mut offset = alias.split('|').next().map_or(0, |first| first.len() + 1);
    for segment in alias.split('|').skip(1) {
        if segment.starts_with("alt=") {
            alt_tail = Some(&alias[offset..]);
            break;
        }
        match segment.split_once('=') {
            // First occurrence wins, matching the canonical parser: a repeated
            // key is hand-authored (the emitter never produces one) and the
            // repeat is reported rather than applied.
            Some(("w", v)) if width.is_none() && is_export_dimension(v) => width = Some(v),
            Some(("h", v)) if height.is_none() && is_export_dimension(v) => {
                // Remember where it sat, so that if no pixel width turns up it
                // can be re-inserted in its ORIGINAL position rather than
                // hoisted to the front. Obsidian has no height-only spelling.
                height = Some(v);
                height_at = Some((passthrough.len(), segment));
            }
            Some((key, _)) if is_canonical_key(key) => passthrough.push(segment),
            // Unkeyed by the canonical rule: part of the filename, already
            // covered by `final_name`.
            _ => {}
        }
        offset += segment.len() + 1;
    }

    let mut out = String::new();
    match (width, height) {
        // Obsidian's own two spellings.
        (Some(w), Some(h)) => {
            out.push('|');
            out.push_str(w);
            out.push('x');
            out.push_str(h);
        }
        (Some(w), None) => {
            out.push('|');
            out.push_str(w);
        }
        // Obsidian has no height-only spelling, so a lone height travels
        // through as an opaque segment IN ITS ORIGINAL POSITION rather than
        // being dropped or hoisted. It used to be consumed into `height` and
        // then emitted only inside the width arm, so a standalone `h=` vanished
        // from the export entirely. That is reachable in two clicks: import an
        // Obsidian `300x200`, then pick Full width, which replaces the pixel
        // width with a percentage.
        (None, Some(_)) => {
            if let Some((at, seg)) = height_at {
                passthrough.insert(at.min(passthrough.len()), seg);
            }
        }
        (None, None) => {}
    }
    for segment in passthrough {
        out.push('|');
        out.push_str(segment);
    }
    if let Some(tail) = alt_tail {
        out.push('|');
        out.push_str(tail);
    }
    out
}

/// The canonical key shape, mirroring `KEYED_RE` in `@myne/dialect/embedLayout`:
/// a leading ASCII letter, then letters, digits, `_` or `-`.
///
/// A looser test here (originally "anything before the first `=`") made the two
/// implementations disagree about what a segment IS, not merely about its
/// value: `1=x`, `a.b=2` and `my key=1` are filename bytes canonically and were
/// re-emitted here as alias segments, so the exported wikilink carried filename
/// fragments in Obsidian's display-alias slot next to a `final_name` that
/// already stood in for them.
fn is_canonical_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// A value the canonical grammar accepts as a pixel dimension: a positive
/// integer, no leading zero, no greater than the ceiling.
///
/// This is the ONE piece of the grammar this side reproduces, and it is
/// deliberately just the number: the segment rules (unkeyed rejoin, `alt=`
/// terminality, the key vocabulary) stay canonical in TypeScript. Recognising
/// the number is unavoidable, because the alternative is emitting a BARE
/// Obsidian dimension for a value the canonical parser rejected, so `w=0` would
/// export as `|0` and Obsidian would render a zero-width image where Myne
/// renders the default. Anything this does not accept travels through as an
/// opaque `w=…` segment, which is the same treatment `w=abc` and `w=100%` get.
fn is_export_dimension(s: &str) -> bool {
    if s.is_empty() || s.starts_with('0') || !s.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    s.parse::<u32>().is_ok_and(|n| n <= MAX_EMBED_DIMENSION_PX)
}

/// Mirrors `MAX_EMBED_DIMENSION_PX` in `@myne/dialect/embedLayout`. Held in
/// lockstep by the published `embed-layout` vectors, not by convention.
const MAX_EMBED_DIMENSION_PX: u32 = 8192;

/// Splice every located embed span to `![[<final-filename><layout-suffix>]]`,
/// preserving each byte outside the spans (the `markdown-dialect.md`
/// §6 sanctioned export transform — the importer media-rewrite's exact
/// inverse). A span whose id somehow has no final name (structurally
/// impossible — the same scan fed both) keeps its original bytes,
/// never an empty splice.
pub fn rewrite_embeds_to_final_names(
    plaintext: &str,
    spans: &[AttEmbedSpan<'_>],
    final_names: &HashMap<String, String>,
) -> String {
    let mut out = String::with_capacity(plaintext.len());
    let mut cursor = 0;
    for span in spans {
        out.push_str(&plaintext[cursor..span.start]);
        match final_names.get(span.id) {
            Some(final_name) => {
                out.push_str("![[");
                out.push_str(final_name);
                out.push_str(&obsidian_layout_suffix(span.alias));
                out.push_str("]]");
            }
            None => out.push_str(&plaintext[span.start..span.end]),
        }
        cursor = span.end;
    }
    out.push_str(&plaintext[cursor..]);
    out
}

/// Rewrite every `attachment://<id>` reference in an emitted standalone
/// HTML document to the final relative sidecar filename actually written
/// beside it (the HTML projection's arm of the `markdown-dialect.md` §6
/// sanctioned export transform — the same id→final-name remap the
/// markdown export applies to form-C embeds, here applied to the HTML
/// body's `<img src>` rather than the markdown wikilink). The filename is
/// percent-encoded for the URL-shaped `src` attribute (a dedup-suffixed
/// name like `photo (1).png` carries spaces + parens). An id with no
/// final name (structurally impossible — the same scan fed both) is left
/// untouched. Every byte outside the rewritten `attachment://<id>` token
/// is preserved.
pub fn rewrite_html_attachment_srcs(html: &str, final_names: &HashMap<String, String>) -> String {
    const PREFIX: &str = "attachment://";
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(pos) = rest.find(PREFIX) {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + PREFIX.len()..];
        // The id is the 64-char lowercase-hex run (the emitter writes
        // exactly that — `attachmentUrl(id)`); read until the first
        // non-hex char (the closing quote in `src="attachment://<id>"`).
        let id_len = after.bytes().take_while(|b| b.is_ascii_hexdigit()).count();
        let id = &after[..id_len];
        match final_names.get(id) {
            Some(final_name) => out.push_str(&percent_encode_path(final_name)),
            // No mapping → keep the original token verbatim (id included).
            None => {
                out.push_str(PREFIX);
                out.push_str(id);
            }
        }
        rest = &after[id_len..];
    }
    out.push_str(rest);
    out
}

/// Percent-encode a relative filename for use as an HTML attribute URL
/// (`<img src="…">`). Only the characters that break an unquoted-shaped
/// path or the surrounding double-quoted attribute are escaped; the
/// common safe set (alphanumerics, `-._~`, plus `.`/`-` already covered)
/// passes through so a plain `photo.png` is emitted as-is. Zero new
/// dependency (the crate has no percent-encoding crate; adding one is a
/// TB9 decision — `src-tauri/CLAUDE.md`).
fn percent_encode_path(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for b in name.bytes() {
        let safe = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b'/');
        if safe {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(hex_upper(b >> 4));
            out.push(hex_upper(b & 0x0f));
        }
    }
    out
}

fn hex_upper(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        _ => (b'A' + (nibble - 10)) as char,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suffixed_filename_inserts_before_the_extension() {
        assert_eq!(suffixed_filename("photo.png", 1), "photo (1).png");
        assert_eq!(suffixed_filename("photo.png", 12), "photo (12).png");
        // Last-dot split: only the final extension moves.
        assert_eq!(suffixed_filename("archive.tar.gz", 1), "archive.tar (1).gz");
        // Extensionless and dot-leading names suffix at the end.
        assert_eq!(suffixed_filename("notes", 2), "notes (2)");
        assert_eq!(suffixed_filename(".env", 1), ".env (1)");
    }

    #[test]
    fn sanitize_export_component_neutralizes_unsafe_names() {
        assert_eq!(
            sanitize_export_component("photo.png", "attachment"),
            "photo.png"
        );
        assert_eq!(
            sanitize_export_component("../escape.png", "attachment"),
            ".._escape.png"
        );
        assert_eq!(
            sanitize_export_component("a\\b|c[d]e.png", "attachment"),
            "a_b_c_d_e.png"
        );
        assert_eq!(
            sanitize_export_component("ctrl\u{0007}.png", "attachment"),
            "ctrl_.png"
        );
        assert_eq!(sanitize_export_component("name...", "attachment"), "name");
        assert_eq!(sanitize_export_component("   ", "attachment"), "attachment");
        assert_eq!(sanitize_export_component("", "attachment"), "attachment");
        assert_eq!(sanitize_export_component("...", "attachment"), "attachment");
    }

    #[test]
    fn sanitize_export_component_neutralizes_windows_reserved_punctuation() {
        // 115-F4/211-L2: `: * ? " < >` are invalid in Windows filenames —
        // mapped to `_` instead of hard-failing the export.
        assert_eq!(
            sanitize_export_component("Q4: Report", "attachment"),
            "Q4_ Report"
        );
        assert_eq!(
            sanitize_export_component("a*b?c\"d<e>f.png", "attachment"),
            "a_b_c_d_e_f.png"
        );
        // Mixed dot/space tails trim fully (the old dots-then-spaces
        // sequential trim left `"x."` behind for `"x. "`).
        assert_eq!(sanitize_export_component("x. ", "attachment"), "x");
        assert_eq!(sanitize_export_component("name. .. ", "attachment"), "name");
    }

    #[test]
    fn sanitize_export_component_prefixes_windows_reserved_device_names() {
        // Reserved with and without extension, case-insensitive.
        assert_eq!(sanitize_export_component("CON", "attachment"), "_CON");
        assert_eq!(
            sanitize_export_component("con.txt", "attachment"),
            "_con.txt"
        );
        assert_eq!(sanitize_export_component("NUL", "_"), "_NUL");
        assert_eq!(
            sanitize_export_component("COM7.tar.gz", "attachment"),
            "_COM7.tar.gz"
        );
        assert_eq!(sanitize_export_component("lpt9", "attachment"), "_lpt9");
        assert_eq!(sanitize_export_component("Prn.md", "_"), "_Prn.md");
        // NOT reserved: longer names, COM0/LPT0, letter suffixes.
        assert_eq!(
            sanitize_export_component("CONSOLE", "attachment"),
            "CONSOLE"
        );
        assert_eq!(sanitize_export_component("COM0", "attachment"), "COM0");
        assert_eq!(
            sanitize_export_component("LPT0.txt", "attachment"),
            "LPT0.txt"
        );
        assert_eq!(sanitize_export_component("COMX", "attachment"), "COMX");
        assert_eq!(
            sanitize_export_component("connect.png", "attachment"),
            "connect.png"
        );
    }

    #[test]
    fn sanitize_export_component_is_traversal_proof_as_tree_segment() {
        // The tree-segment surface (`"_"` fallback): a pathological
        // folder segment can never traverse or vanish.
        assert_eq!(sanitize_export_component("Projects", "_"), "Projects");
        assert_eq!(sanitize_export_component("..", "_"), "_");
        assert_eq!(sanitize_export_component(".", "_"), "_");
        assert_eq!(sanitize_export_component("a\\b|c[d]", "_"), "a_b_c_d_");
        assert_eq!(sanitize_export_component("dots...", "_"), "dots");
        assert_eq!(sanitize_export_component("", "_"), "_");
    }

    #[test]
    fn rewrite_embeds_preserves_every_byte_outside_spans() {
        let id_a = "a".repeat(64);
        let id_b = "b".repeat(64);
        let body =
            format!("pre ![[att:{id_a}|x.png]] mid\twith \\*escapes\\*  \n![[att:{id_b}]]post");
        let spans = crate::embed_span::extract_att_embed_spans(&body);
        let mut names = HashMap::new();
        names.insert(id_a.clone(), "x (1).png".to_string());
        names.insert(id_b.clone(), "y.pdf".to_string());
        assert_eq!(
            rewrite_embeds_to_final_names(&body, &spans, &names),
            "pre ![[x (1).png]] mid\twith \\*escapes\\*  \n![[y.pdf]]post"
        );
        // No spans → identity.
        assert_eq!(
            rewrite_embeds_to_final_names("plain body", &[], &names),
            "plain body"
        );
    }

    #[test]
    fn rewrite_html_attachment_srcs_remaps_to_relative_filenames() {
        let id_a = "a".repeat(64);
        let id_b = "b".repeat(64);
        let mut names = HashMap::new();
        names.insert(id_a.clone(), "photo.png".to_string());
        names.insert(id_b.clone(), "scan (1).png".to_string());
        let html = format!(
            "<p>x</p><img class=\"att-image\" src=\"attachment://{id_a}\" alt=\"a\">\
             <img class=\"att-image\" src=\"attachment://{id_b}\" alt=\"b\">"
        );
        assert_eq!(
            rewrite_html_attachment_srcs(&html, &names),
            "<p>x</p><img class=\"att-image\" src=\"photo.png\" alt=\"a\">\
             <img class=\"att-image\" src=\"scan%20%281%29.png\" alt=\"b\">"
        );
    }

    #[test]
    fn rewrite_html_attachment_srcs_keeps_unmapped_token_verbatim() {
        let id_a = "a".repeat(64);
        let html = format!("<img src=\"attachment://{id_a}\">");
        // Empty map → no rewrite, token untouched (every byte preserved).
        assert_eq!(rewrite_html_attachment_srcs(&html, &HashMap::new()), html);
        // No attachment token at all → identity.
        assert_eq!(
            rewrite_html_attachment_srcs("<p>plain</p>", &HashMap::new()),
            "<p>plain</p>"
        );
    }

    #[test]
    fn percent_encode_path_escapes_only_unsafe_bytes() {
        assert_eq!(percent_encode_path("photo.png"), "photo.png");
        assert_eq!(percent_encode_path("a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(percent_encode_path("scan (1).png"), "scan%20%281%29.png");
        assert_eq!(percent_encode_path("a&b#c.png"), "a%26b%23c.png");
    }
}

#[cfg(test)]
mod embed_layout_export_tests {
    use super::*;

    /// The §6 export transform's layout arm (myne#409). The canonical grammar
    /// is TypeScript; this side learns one translation, and these pin exactly
    /// how narrow it is.
    #[test]
    fn pixel_width_becomes_obsidians_own_spelling() {
        assert_eq!(obsidian_layout_suffix("photo.png|w=300"), "|300");
    }

    #[test]
    fn width_and_height_become_the_x_form() {
        assert_eq!(obsidian_layout_suffix("photo.png|w=300|h=200"), "|300x200");
    }

    #[test]
    fn a_percentage_width_has_no_obsidian_slot_and_travels_unchanged() {
        assert_eq!(obsidian_layout_suffix("photo.png|w=100%"), "|w=100%");
    }

    #[test]
    fn other_keys_pass_through_in_order_after_the_dimension() {
        assert_eq!(
            obsidian_layout_suffix("photo.png|w=300|align=center|alt=A sunset"),
            "|300|align=center|alt=A sunset",
        );
    }

    #[test]
    fn keys_written_out_of_order_still_put_the_dimension_first() {
        assert_eq!(
            obsidian_layout_suffix("photo.png|align=center|w=300"),
            "|300|align=center",
        );
    }

    #[test]
    fn no_alias_and_a_bare_filename_carry_nothing() {
        assert_eq!(obsidian_layout_suffix(""), "");
        assert_eq!(obsidian_layout_suffix("photo.png"), "");
    }

    /// A filename may contain a `|` today, so an UNKEYED later segment is part
    /// of the filename. The final export name already stands in for all of it,
    /// so it must not be re-emitted as a layout segment.
    #[test]
    fn a_pipe_bearing_filename_contributes_no_segments() {
        assert_eq!(obsidian_layout_suffix("re|port.png"), "");
        assert_eq!(obsidian_layout_suffix("re|port.png|w=300"), "|300");
    }

    /// Passed through, not dropped. Refusing to export bytes this side merely
    /// failed to understand is how an export loses data.
    #[test]
    fn a_value_this_side_cannot_read_is_passed_through_not_dropped() {
        assert_eq!(obsidian_layout_suffix("photo.png|w=abc"), "|w=abc");
        assert_eq!(obsidian_layout_suffix("photo.png|z=9"), "|z=9");
    }

    /// The two drifts the published vectors caught on their first run, kept as
    /// named unit tests so the reason survives even if the companion is absent.
    #[test]
    fn alt_is_terminal_and_keeps_its_pipes() {
        assert_eq!(
            obsidian_layout_suffix("photo.png|alt=A sunset | 2026"),
            "|alt=A sunset | 2026",
        );
        assert_eq!(
            obsidian_layout_suffix("photo.png|alt=a|w=300"),
            "|alt=a|w=300"
        );
    }

    #[test]
    fn a_rejected_dimension_never_becomes_a_bare_obsidian_number() {
        // `|0` would render a zero-width image in Obsidian where Myne renders
        // the default, so a value the canonical grammar rejects passes through.
        assert_eq!(obsidian_layout_suffix("photo.png|w=0"), "|w=0");
        assert_eq!(obsidian_layout_suffix("photo.png|w=0300"), "|w=0300");
        assert_eq!(obsidian_layout_suffix("photo.png|w=8193"), "|w=8193");
        assert_eq!(obsidian_layout_suffix("photo.png|w=8192"), "|8192");
    }

    /// Pixel slot only, and the name says so now.
    ///
    /// The canonical parser's first-wins guard covers the whole WIDTH slot
    /// (`widthPx !== null || widthPercent !== null`); this one tracks the pixel
    /// slot alone, so `w=100%|w=300` and `w=300|w=100%` export identically
    /// while the parser renders them differently. Unreachable in-app
    /// (`emitEmbedAlias` never writes two `w=`, and the passthrough list can
    /// never hold one), so it takes a hand-edited file or a foreign writer.
    /// Pinned rather than fixed because widening the guard here would change
    /// which bytes reach an exported document, and the two directions of that
    /// belong to one change with the parser, not to this one.
    #[test]
    fn a_duplicate_pixel_width_keeps_the_first() {
        assert_eq!(
            obsidian_layout_suffix("photo.png|w=300|w=400"),
            "|300|w=400"
        );
    }

    /// Both orderings of a mixed duplicate, so the divergence above is on the
    /// record as a value rather than as a sentence.
    #[test]
    fn a_mixed_duplicate_width_exports_the_same_either_way() {
        assert_eq!(
            obsidian_layout_suffix("photo.png|w=100%|w=300"),
            obsidian_layout_suffix("photo.png|w=300|w=100%"),
        );
    }

    /// A newline in the alias drops the whole suffix.
    ///
    /// Splicing it produces an exported wikilink whose closing `]]` is on a
    /// later line, and `# Heading` becomes a real heading in the exported file.
    #[test]
    fn a_line_break_in_the_alias_drops_the_suffix_rather_than_corrupting_the_export() {
        assert_eq!(
            obsidian_layout_suffix("photo.png|w=300|alt=a\n\n# Heading"),
            ""
        );
        assert_eq!(
            obsidian_layout_suffix("photo.png|w=300|alt=a\r\n# Heading"),
            ""
        );
        // The control: the same alias without the break still carries.
        assert_eq!(
            obsidian_layout_suffix("photo.png|w=300|alt=a # Heading"),
            "|300|alt=a # Heading"
        );
    }

    #[test]
    fn the_full_rewrite_splices_the_layout_beside_the_final_name() {
        let body = "a ![[att:".to_string() + &"a".repeat(64) + "|photo.png|w=300|align=center]] b";
        let spans = crate::embed_span::extract_att_embed_spans(&body);
        assert_eq!(spans.len(), 1);
        let mut names = HashMap::new();
        names.insert("a".repeat(64), "photo (1).png".to_string());
        assert_eq!(
            rewrite_embeds_to_final_names(&body, &spans, &names),
            "a ![[photo (1).png|300|align=center]] b",
        );
    }
}

/// Cross-implementation vector runner for the form-C embed layout segments
/// (myne#409). The canonical grammar is TypeScript (`@myne/dialect/embedLayout`,
/// source-consumed by desktop, web and mobile); this side implements only the
/// export translation. Neither can detect drift from the other alone, so both
/// assert against the same published cases.
///
/// Skips when the `myne-test-vectors` companion is not cloned, matching the
/// `tls-exporter` precedent: a contributor not touching the dialect should not
/// see a red test about their checkout layout.
#[cfg(test)]
mod embed_layout_vectors {
    use super::obsidian_layout_suffix;

    #[test]
    fn export_suffix_matches_every_published_vector() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../myne-test-vectors/vectors/embed-layout/v0.1/cases.json");
        let Ok(raw) = std::fs::read_to_string(&path) else {
            // `MYNE_VECTORS_REQUIRED=1` turns a missing companion into a loud
            // failure instead of a green run that verified nothing. Without it
            // this skips, because the companion is optional for a contributor
            // not touching the dialect; with it, a lane that believes it is
            // gating on the vectors finds out when it is not.
            assert!(
                std::env::var_os("MYNE_VECTORS_REQUIRED").is_none(),
                "MYNE_VECTORS_REQUIRED is set but the embed-layout vectors are absent at {}",
                path.display(),
            );
            eprintln!("[skip] embed-layout vectors absent at {}", path.display());
            return;
        };
        let doc: serde_json::Value = serde_json::from_str(&raw).expect("vectors parse as JSON");
        let cases = doc["cases"]
            .as_array()
            .expect("vectors carry a cases array");

        // A silently-empty case set would make this test vacuously green, which
        // is the failure mode a vector runner is most prone to.
        assert!(!cases.is_empty(), "embed-layout vectors must not be empty");

        for case in cases {
            let id = case["vector_id"]
                .as_str()
                .expect("case carries a vector_id");
            let hex = case["input_alias_utf8_hex"]
                .as_str()
                .expect("case carries the alias as hex");
            let alias_bytes: Vec<u8> = (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("vector carries hex"))
                .collect();
            let alias = String::from_utf8(alias_bytes).expect("alias is UTF-8");

            // The hex is the contract; the readable mirror is informational and
            // is cross-checked so a hand-edited case cannot drift from its label.
            assert_eq!(
                alias,
                case["informational_alias"].as_str().unwrap_or_default(),
                "{id}: informational_alias must mirror the hex"
            );

            let want = case["expected_export_suffix"]
                .as_str()
                .expect("case carries the expected suffix");
            assert_eq!(
                obsidian_layout_suffix(&alias),
                want,
                "{id}: exported layout suffix has drifted from the published vector"
            );
        }
    }
}
