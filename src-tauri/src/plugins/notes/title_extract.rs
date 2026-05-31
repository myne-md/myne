//! Hybrid byte-range slice extractor for `note_titles_batch`.
//!
//! Per the 2026-05-15 MYND-82 grill Q3 (hybrid byte-range parse), this
//! module performs the **minimum** structural scan on decrypted note
//! plaintext: locate the YAML frontmatter block (if present) and the
//! first ATX-H1 line in the body region. Both are returned as borrowed
//! byte slices into the input — the TS dialect module
//! (`src/dialect/parse.ts` + visitors) does the actual YAML / markdown
//! parsing on the WebView side.
//!
//! Rationale: keeping markdown / YAML parsing TS-side preserves a
//! single dialect source-of-truth and avoids expanding the Rust audit
//! surface (TB9). The scanner here is ~30 LOC of byte-level line walks
//! — no regex, no markdown parser, no YAML parser.
//!
//! Spec touchpoints:
//!
//! - `docs/decisions.md` 2026-05-15 "Note title write target" (the
//!   read-precedence chain whose source slices this function returns).
//! - `myne-agents/sessions/grill/2026-05-15-mynd-82-sidebar-autosave.md`
//!   Q3 (hybrid byte-range design rationale).

const FM_OPENER: &[u8] = b"---\n";
const FM_DELIMITER: &[u8] = b"---";
const H1_PREFIX: &[u8] = b"# ";

/// Byte slices extracted from a single note's decrypted plaintext.
///
/// Both slices borrow into the input buffer; no allocation. `None`
/// means the corresponding region was not found (no FM opener / no
/// matching closer / no ATX-H1 in the body).
pub struct TitleSlices<'a> {
    pub frontmatter_bytes: Option<&'a [u8]>,
    pub first_h1_line: Option<&'a [u8]>,
}

/// Locate the FM block boundary and the first H1 line.
///
/// FM detection follows `docs/spec/markdown-dialect.md` §3.6
/// "line-1-anchored detection": the source must begin with `"---\n"`,
/// and the closer is the next line that consists exactly of `"---"`.
/// An opener without a matching closer is treated as **no
/// frontmatter** (body starts at offset 0).
///
/// H1 detection follows CommonMark ATX-H1 strict shape: a line
/// beginning with literal `"# "` (hash + space). `"#hashtag"` is NOT
/// a heading. Leading-indent ATX (`"   # text"`) is not supported in
/// v0.1 — the sidebar's mirror-existing-source-of-truth read precedence
/// (Q2) is "frontmatter `title:` ↳ first `# H1` ↳ None", and indented
/// headings are deliberately routed through the FM `title:` slot
/// instead (negligible Phase 1 dogfood prevalence).
pub fn extract_title_slices(plaintext: &[u8]) -> TitleSlices<'_> {
    // --- FM boundary scan -------------------------------------------
    let mut frontmatter_bytes: Option<&[u8]> = None;
    let mut body_offset: usize = 0;

    if plaintext.starts_with(FM_OPENER) {
        let body_start = FM_OPENER.len();
        let mut cursor = body_start;
        loop {
            let rel_nl = plaintext[cursor..].iter().position(|b| *b == b'\n');
            match rel_nl {
                Some(rel) => {
                    let line_end = cursor + rel;
                    let line = &plaintext[cursor..line_end];
                    if line == FM_DELIMITER {
                        frontmatter_bytes = Some(&plaintext[body_start..cursor]);
                        body_offset = line_end + 1;
                        break;
                    }
                    cursor = line_end + 1;
                }
                None => {
                    // Trailing line without newline — accept it as the
                    // closer if its content equals "---".
                    let line = &plaintext[cursor..];
                    if line == FM_DELIMITER {
                        frontmatter_bytes = Some(&plaintext[body_start..cursor]);
                        body_offset = plaintext.len();
                    }
                    break;
                }
            }
        }
    }

    // --- First-H1 line scan -----------------------------------------
    let body = &plaintext[body_offset..];
    let first_h1_line = body
        .split(|b| *b == b'\n')
        .find(|line| line.starts_with(H1_PREFIX));

    TitleSlices {
        frontmatter_bytes,
        first_h1_line,
    }
}

/// Best-effort note title for the search index (MYND-29 Task 4): the first
/// `# H1` line's text (without the `"# "` prefix), trimmed; `None` when there
/// is no H1 or it is blank. NOTE: frontmatter `title:` resolution (the
/// sidebar's full FM↳H1↳None precedence) is intentionally NOT applied here —
/// search title-boost covers the common H1-titled note, and an FM-only-titled
/// note stays fully searchable via its body. Full title resolution can be
/// unified later if the benchmark shows title-boost recall matters.
pub fn extract_h1_title(plaintext: &[u8]) -> Option<String> {
    let line = extract_title_slices(plaintext).first_h1_line?;
    let text = line.strip_prefix(H1_PREFIX).unwrap_or(line);
    let title = String::from_utf8_lossy(text).trim().to_string();
    (!title.is_empty()).then_some(title)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_fm_no_h1_returns_both_none() {
        let result = extract_title_slices(b"plain body content\nno headings\n");
        assert!(result.frontmatter_bytes.is_none());
        assert!(result.first_h1_line.is_none());
    }

    #[test]
    fn fm_only_no_h1_returns_fm_some_h1_none() {
        let input = b"---\ntags: [a]\n---\n\nbody here\n";
        let result = extract_title_slices(input);
        assert_eq!(result.frontmatter_bytes, Some(b"tags: [a]\n".as_ref()));
        assert!(result.first_h1_line.is_none());
    }

    #[test]
    fn h1_only_no_fm_returns_h1_some_fm_none() {
        let input = b"# Heading\nbody\n";
        let result = extract_title_slices(input);
        assert!(result.frontmatter_bytes.is_none());
        assert_eq!(result.first_h1_line, Some(b"# Heading".as_ref()));
    }

    #[test]
    fn fm_and_h1_returns_both_some() {
        let input = b"---\ntitle: Foo\n---\n\n# Body Heading\nmore\n";
        let result = extract_title_slices(input);
        assert_eq!(result.frontmatter_bytes, Some(b"title: Foo\n".as_ref()));
        assert_eq!(result.first_h1_line, Some(b"# Body Heading".as_ref()));
    }

    #[test]
    fn malformed_fm_opener_only_no_closer_falls_back_to_no_fm() {
        // No closing `---` line → not a frontmatter block; entire input
        // is treated as body. The opening `---` itself is then a normal
        // body line; not an H1 (no `# ` prefix).
        let input = b"---\nfoo: bar\nbody but no closer\n";
        let result = extract_title_slices(input);
        assert!(result.frontmatter_bytes.is_none());
        assert!(result.first_h1_line.is_none());
    }

    #[test]
    fn fm_with_multi_line_yaml_value_preserves_full_block() {
        // The block-scalar value spans multiple lines; the closer is
        // still the literal `---` line that terminates the YAML block.
        let input = b"---\ntitle: |\n  Multi-line\n  value\nupdated: 2026-01-01\n---\n\nbody\n";
        let result = extract_title_slices(input);
        assert_eq!(
            result.frontmatter_bytes,
            Some(b"title: |\n  Multi-line\n  value\nupdated: 2026-01-01\n".as_ref())
        );
    }

    #[test]
    fn h2_first_then_h1_finds_h1_deeper_in_body() {
        let input = b"## H2 first\n### H3 next\n# Real H1\nbody\n";
        let result = extract_title_slices(input);
        assert_eq!(result.first_h1_line, Some(b"# Real H1".as_ref()));
    }

    #[test]
    fn hashtag_without_space_is_not_an_h1() {
        let input = b"#hashtag-like\n# Real H1\nbody\n";
        let result = extract_title_slices(input);
        assert_eq!(result.first_h1_line, Some(b"# Real H1".as_ref()));
    }

    #[test]
    fn indented_hash_is_not_an_h1() {
        let input = b"  # indented hash\n# Real H1\n";
        let result = extract_title_slices(input);
        assert_eq!(result.first_h1_line, Some(b"# Real H1".as_ref()));
    }

    #[test]
    fn fm_followed_by_h1_finds_h1_after_block() {
        let input = b"---\ntags: [a]\n---\n# Heading right after FM\nbody\n";
        let result = extract_title_slices(input);
        assert_eq!(result.frontmatter_bytes, Some(b"tags: [a]\n".as_ref()));
        assert_eq!(
            result.first_h1_line,
            Some(b"# Heading right after FM".as_ref())
        );
    }

    #[test]
    fn empty_input_returns_both_none() {
        let result = extract_title_slices(b"");
        assert!(result.frontmatter_bytes.is_none());
        assert!(result.first_h1_line.is_none());
    }

    #[test]
    fn fm_closer_without_trailing_newline_still_recognized() {
        // Last line is the closer with no trailing newline.
        let input = b"---\nfoo: bar\n---";
        let result = extract_title_slices(input);
        assert_eq!(result.frontmatter_bytes, Some(b"foo: bar\n".as_ref()));
        assert!(result.first_h1_line.is_none());
    }

    #[test]
    fn empty_fm_block_returns_empty_slice_not_none() {
        // `---\n---\n` — opener immediately followed by closer.
        let input = b"---\n---\n\nbody\n";
        let result = extract_title_slices(input);
        assert_eq!(result.frontmatter_bytes, Some(b"".as_ref()));
    }

    #[test]
    fn just_hash_space_is_an_empty_h1() {
        // Edge: `"# "` is a valid (empty-content) ATX-H1.
        let input = b"# \nbody\n";
        let result = extract_title_slices(input);
        assert_eq!(result.first_h1_line, Some(b"# ".as_ref()));
    }

    #[test]
    fn extract_h1_title_strips_prefix_and_trims() {
        assert_eq!(
            extract_h1_title(b"# My Note\nbody here"),
            Some("My Note".to_string())
        );
        // No H1 → None (search indexes body only, title empty).
        assert_eq!(extract_h1_title(b"plain body, no heading"), None);
        // Empty H1 → None.
        assert_eq!(extract_h1_title(b"# \nbody"), None);
        // FM present but H1 used (FM `title:` resolution is out of scope here).
        assert_eq!(
            extract_h1_title(b"---\ntitle: Foo\n---\n# Real Heading\nx"),
            Some("Real Heading".to_string())
        );
    }
}
