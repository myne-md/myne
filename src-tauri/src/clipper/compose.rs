//! Host-side note composition for a keyless clip (TB10, task 6).
//!
//! On a valid-token `create-clip` handoff with the vault unlocked, the
//! **app process** (the key-holder) composes the note that the existing
//! `note_create` pipeline will encrypt + write. Composition is **host-side**
//! (SYNC-10: NO new `clip_ingest` command — `note_create`'s signature stays
//! `plaintext: String`), and the composed note lands at the **vault root**
//! (`folder: null`, SYNC-15).
//!
//! ## What this delivers
//!
//! [`compose_clip_note`] takes the decoded [`super::envelope::HandoffEnvelope`]
//! and returns the **plaintext markdown string** to hand to `note_create`:
//!
//! - a provenance frontmatter block carrying `source:` (the source URL) and
//!   `clipped:` (the capture date) as **ordinary user-authored fields**
//!   (SYNC-14, unmanaged — NOT part of the closed Myne-managed canonical set),
//!   present only when the extension supplied the corresponding value;
//! - the markdown body the extension captured in-page.
//!
//! ## No vault structure, no folder, no tags (SYNC-15)
//!
//! The foundation NEVER sources vault structure: `destination_folder` is always
//! `None` (root) and `tags` is always empty, so the composer emits **no**
//! `folder:` line and **no** `tags:` — the note saves to the vault root exactly
//! like an ordinary new note. No folder or tag name ever transits the browser
//! or is sourced from the vault for the clip (story 23).
//!
//! ## No network fetch (SYNC-12)
//!
//! Composition is **pure string assembly** over the in-page-captured fields.
//! There is deliberately NO URL-fetch path here (or anywhere on the ingest
//! relay) — `source_url` is written verbatim as a frontmatter value, never
//! dereferenced. Every byte in the composed note originated from the
//! extension's in-page capture (zero SSRF surface, zero read-receipt leak,
//! story 25).
//!
//! ## Image bytes are sub-feature 3's seam (not the foundation's)
//!
//! [`super::envelope::HandoffEnvelope::image_bytes`] is decoded but NOT
//! ingested here — rich per-image `attachment_import { Bytes }` reconciliation
//! is owned by desktop-ingest (sub-feature 3). The foundation wires only the
//! TEXT path to a real `note_create`; the composer ignores `image_bytes`.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline" — the composed
//! plaintext is the same secret class as `password` (note plaintext); this
//! module never logs a body, frontmatter value, or URL.

use super::envelope::HandoffEnvelope;

/// The YAML frontmatter delimiter line.
const FM_DELIM: &str = "---";
/// Newline used throughout composition (LF, matching the dialect's `NEWLINE`).
const NEWLINE: &str = "\n";

/// Compose the plaintext markdown for a keyless clip note.
///
/// Returns the full note plaintext: an optional provenance frontmatter block
/// (`source:` / `clipped:`, SYNC-14 unmanaged fields) followed by the captured
/// markdown body. Pure string assembly — no I/O, no network, no vault-structure
/// read (SYNC-12/15).
///
/// Frontmatter is emitted ONLY when the extension supplied at least one
/// provenance value; a clip with no `source_url` and no `clip_date` composes to
/// the body verbatim (no empty `---\n---` block). The caller (the ingest
/// handler) has already applied the note-body cap to `markdown_body`; the
/// composer does not re-cap, but the cap is re-checked on the COMPOSED string
/// before `note_create` (see [`super::ingest`]).
pub fn compose_clip_note(envelope: &HandoffEnvelope) -> String {
    let source = envelope.source_url.as_deref().filter(|s| !s.is_empty());
    let clipped = envelope.clip_date.as_deref().filter(|s| !s.is_empty());

    // No provenance → the body is the whole note (no empty frontmatter block).
    if source.is_none() && clipped.is_none() {
        return envelope.markdown_body.clone();
    }

    let mut out = String::new();
    out.push_str(FM_DELIM);
    out.push_str(NEWLINE);
    if let Some(s) = source {
        out.push_str("source: ");
        out.push_str(&yaml_scalar(s));
        out.push_str(NEWLINE);
    }
    if let Some(c) = clipped {
        out.push_str("clipped: ");
        out.push_str(&yaml_scalar(c));
        out.push_str(NEWLINE);
    }
    out.push_str(FM_DELIM);
    out.push_str(NEWLINE);
    out.push_str(NEWLINE);
    out.push_str(&envelope.markdown_body);
    out
}

/// Format a string as a YAML frontmatter scalar — plain when safe, otherwise
/// double-quoted with `\` and `"` escaped.
///
/// A faithful Rust mirror of the dialect's `formatYamlScalar`
/// (`src/dialect/surgery.ts`) so a provenance value composed here is read back
/// identically by the WebView dialect reader. Conservative: when in doubt it
/// quotes (a quoted scalar is always safe). Provenance values (a URL, an
/// ISO-8601 date) are usually plain-scalar-safe, but a URL can carry a YAML
/// special (`: `, a leading char) — quoting handles it without parsing.
fn yaml_scalar(value: &str) -> String {
    if needs_yaml_quoting(value) {
        let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
        format!("\"{escaped}\"")
    } else {
        value.to_string()
    }
}

/// Whether a YAML plain scalar must be double-quoted to round-trip. Mirrors
/// `needsYamlQuoting` in `src/dialect/surgery.ts`.
fn needs_yaml_quoting(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    let first = value.chars().next().unwrap();
    // Leading whitespace / control / YAML-reserved start char.
    if first.is_whitespace()
        || first.is_control()
        || matches!(
            first,
            '-' | '?'
                | ':'
                | '['
                | ']'
                | '{'
                | '}'
                | '#'
                | '&'
                | '*'
                | '!'
                | '|'
                | '>'
                | '\''
                | '"'
                | '%'
                | '@'
                | '`'
        )
    {
        return true;
    }
    // Trailing whitespace would round-trip-mangle.
    if value
        .chars()
        .last()
        .map(|c| c.is_whitespace())
        .unwrap_or(false)
    {
        return true;
    }
    // In-line specials: `: ` opens a mapping, ` #` opens a comment, any newline.
    if value.contains(": ") || value.contains(" #") || value.contains('\n') || value.contains('\r')
    {
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clipper::envelope::{CaptureKind, HandoffEnvelope, HandoffKind};

    /// A create-clip envelope with the given provenance + body (SYNC-15 shape:
    /// no folder, no tags).
    fn clip(body: &str, source_url: Option<&str>, clip_date: Option<&str>) -> HandoffEnvelope {
        HandoffEnvelope {
            version: 1,
            kind: HandoffKind::CreateClip,
            extension_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            token: "deadbeef".into(),
            markdown_body: body.into(),
            capture_kind: Some(CaptureKind::FullArticle),
            destination_folder: None,
            tags: Vec::new(),
            source_url: source_url.map(Into::into),
            clip_date: clip_date.map(Into::into),
            image_bytes: Vec::new(),
        }
    }

    #[test]
    fn composes_provenance_frontmatter_then_body() {
        let env = clip(
            "# Hello\n\nbody text",
            Some("https://example.com/a"),
            Some("2026-06-20T12:00:00Z"),
        );
        let note = compose_clip_note(&env);
        assert_eq!(
            note,
            "---\nsource: https://example.com/a\nclipped: 2026-06-20T12:00:00Z\n---\n\n# Hello\n\nbody text"
        );
    }

    #[test]
    fn provenance_fields_are_ordinary_user_authored_yaml() {
        // SYNC-14: `source:` / `clipped:` ride as ordinary frontmatter the
        // dialect reader parses. The block is a well-formed `---`-delimited
        // YAML map followed by a blank line, exactly like an imported note.
        let env = clip("body", Some("https://x.test"), Some("2026-06-20"));
        let note = compose_clip_note(&env);
        assert!(note.starts_with("---\n"), "opens with a FM delimiter");
        assert!(note.contains("\n---\n\n"), "closes FM then a blank line");
        assert!(note.contains("source: https://x.test"));
        assert!(note.contains("clipped: 2026-06-20"));
        assert!(note.ends_with("body"));
    }

    #[test]
    fn no_provenance_composes_body_verbatim_no_empty_frontmatter() {
        // A clip with no source/date → no `---\n---` block; the body is the
        // whole note (an empty frontmatter block would be noise).
        let env = clip("just the body", None, None);
        assert_eq!(compose_clip_note(&env), "just the body");
    }

    #[test]
    fn empty_string_provenance_is_treated_as_absent() {
        // An empty `source_url` / `clip_date` from the wire is treated as
        // absent — no empty `source:` line.
        let env = clip("body", Some(""), Some(""));
        assert_eq!(compose_clip_note(&env), "body");
    }

    #[test]
    fn only_source_url_present_emits_only_source_line() {
        let env = clip("body", Some("https://only.test"), None);
        let note = compose_clip_note(&env);
        assert_eq!(note, "---\nsource: https://only.test\n---\n\nbody");
        assert!(!note.contains("clipped:"));
    }

    #[test]
    fn only_clip_date_present_emits_only_clipped_line() {
        let env = clip("body", None, Some("2026-06-20"));
        let note = compose_clip_note(&env);
        assert_eq!(note, "---\nclipped: 2026-06-20\n---\n\nbody");
        assert!(!note.contains("source:"));
    }

    #[test]
    fn never_emits_folder_or_tags_lines_sync_15() {
        // Story 23 / SYNC-15: no folder or tag name ever appears in the
        // composed note — the foundation saves to root, never sources vault
        // structure. Even if a hostile envelope smuggled a folder/tags value
        // (it cannot post-decode under SYNC-15, but defense-in-depth), the
        // composer reads ONLY source_url + clip_date + body.
        let mut env = clip("body", Some("https://x.test"), Some("2026-06-20"));
        env.destination_folder = Some("Secret/Folder".into());
        env.tags = vec!["private-tag".into()];
        let note = compose_clip_note(&env);
        assert!(!note.contains("folder:"), "no folder line: {note}");
        assert!(!note.contains("tags:"), "no tags line: {note}");
        assert!(!note.contains("Secret/Folder"), "no folder value leaks");
        assert!(!note.contains("private-tag"), "no tag value leaks");
    }

    #[test]
    fn image_bytes_are_not_ingested_by_the_composer() {
        // Sub-feature 3 owns rich image ingest; the foundation's text composer
        // ignores image_bytes entirely (no base64, no placeholder here).
        let mut env = clip("body", Some("https://x.test"), None);
        env.image_bytes = vec![vec![0xDE, 0xAD, 0xBE, 0xEF]];
        let note = compose_clip_note(&env);
        assert_eq!(note, "---\nsource: https://x.test\n---\n\nbody");
    }

    #[test]
    fn yaml_unsafe_url_is_quoted_to_round_trip() {
        // A value that opens a YAML mapping (`: `) or starts with a reserved
        // char must be quoted so the dialect reader reads it back verbatim.
        let env = clip("body", Some("weird: value #frag"), None);
        let note = compose_clip_note(&env);
        assert!(
            note.contains("source: \"weird: value #frag\""),
            "unsafe scalar must be quoted: {note}"
        );
    }

    #[test]
    fn quotes_and_backslashes_in_value_are_escaped_when_quoting_is_forced() {
        // A mid-string `"` / `\` is plain-scalar-safe on its own (YAML treats
        // them literally), so it does NOT force quoting — matching the dialect's
        // `formatYamlScalar`. But once quoting IS forced (here by a leading
        // reserved char `#`), the `"` and `\` inside MUST be escaped so the
        // double-quoted form round-trips.
        let env = clip("body", Some("#a\"b\\c"), None);
        let note = compose_clip_note(&env);
        assert!(note.contains(r##"source: "#a\"b\\c""##), "escaped: {note}");
    }

    #[test]
    fn a_value_with_a_bare_quote_stays_plain_scalar() {
        // Defensive pin of the dialect-parity rule: a mid-string `"` does NOT
        // force quoting (it is literal in a plain scalar), so the composer
        // leaves the value bare — exactly as `formatYamlScalar` does.
        let env = clip("body", Some("a\"b"), None);
        let note = compose_clip_note(&env);
        assert!(note.contains("source: a\"b"), "stays plain: {note}");
    }

    #[test]
    fn composition_is_pure_no_url_dereference() {
        // SYNC-12 (structural): the URL is written verbatim as a value, never
        // fetched. This test pins that the output contains the URL bytes
        // unchanged — a fetch-and-inline path would alter the output.
        let url = "https://example.invalid/never-fetched";
        let env = clip("body", Some(url), None);
        let note = compose_clip_note(&env);
        assert!(note.contains(url), "URL written verbatim, not dereferenced");
    }
}
