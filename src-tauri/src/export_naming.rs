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

use crate::plugins::attachments::reconcile::AttEmbedSpan;

/// Suffix-dedup retry cap shared by both export dedup loops — a
/// pathological collision flood bails closed instead of spinning.
pub(crate) const DEDUP_RETRY_CAP: u32 = 9_999;

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
pub(crate) fn sanitize_export_component(name: &str, fallback: &str) -> String {
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
pub(crate) fn suffixed_filename(name: &str, n: u32) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 => format!("{} ({}){}", &name[..dot], n, &name[dot..]),
        _ => format!("{name} ({n})"),
    }
}

/// Splice every located embed span to `![[<final-filename>]]`,
/// preserving each byte outside the spans (the `markdown-dialect.md`
/// §6 sanctioned export transform — the importer media-rewrite's exact
/// inverse). A span whose id somehow has no final name (structurally
/// impossible — the same scan fed both) keeps its original bytes,
/// never an empty splice.
pub(crate) fn rewrite_embeds_to_final_names(
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
pub(crate) fn rewrite_html_attachment_srcs(
    html: &str,
    final_names: &HashMap<String, String>,
) -> String {
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
        let spans = crate::plugins::attachments::reconcile::extract_att_embed_spans(&body);
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
