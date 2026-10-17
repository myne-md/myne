// SPDX-License-Identifier: AGPL-3.0
//! Drawing-note text projection for the search index (drawing-notes SF5, MYND-502).
//!
//! A `kind: drawing` note body is a ```excalidraw fenced Excalidraw scene (JSON),
//! not markdown; feeding the raw JSON to the BM25 index would pollute it with
//! coordinates and JSON keys. This module projects the scene's text-element
//! strings to plain text so a drawing's text is searchable and the JSON noise is
//! excluded (SYNC-4 body-only guard). Pure; the search-body fold calls it before
//! `search_upsert`. Tolerant of a malformed/truncated scene (→ `None` → the caller
//! indexes the note title only — graceful degradation).

use super::title_extract::extract_title_slices;

/// Value-strict `kind: drawing` check — the Rust half of the TS↔Rust drift lock.
/// Matches the TS `readKindFromFmBody` exactly: `KIND_KEY_RE` is
/// `/^[ \t]*kind[ \t]*:[ \t]*(.*)$/` (leading indent + optional space-before-colon
/// allowed), the first matching line decides, and the value is stripped of a
/// trailing `[ \t]+#` comment then required to equal the literal unquoted
/// `drawing`. Agreement matters because `kind` drives BOTH the render surface (TS)
/// and the search fold (Rust) of the same note — a disagreement would render a
/// canvas while indexing raw JSON. Quoted `"drawing"`, other values, and `kindly:`
/// all read as not-a-drawing.
pub fn is_drawing(plaintext: &[u8]) -> bool {
    let Some(fm) = extract_title_slices(plaintext).frontmatter_bytes else {
        return false;
    };
    let text = String::from_utf8_lossy(fm);
    for line in text.lines() {
        let after_key = match line.trim_start().strip_prefix("kind") {
            Some(a) => a.trim_start(), // allow `kind :` (space before colon)
            None => continue,
        };
        let value = match after_key.strip_prefix(':') {
            Some(v) => v,
            None => continue, // `kindly:` etc. — not the `kind` field
        };
        return strip_inline_comment(value).trim() == "drawing";
    }
    false
}

/// Strip a trailing `[ \t]+#…` YAML comment (space/tab before `#`), mirroring the
/// TS `/^([^#]*?)([ \t]+#.*)$/` value-strict comment strip.
fn strip_inline_comment(value: &str) -> &str {
    let b = value.as_bytes();
    for i in 0..b.len().saturating_sub(1) {
        if (b[i] == b' ' || b[i] == b'\t') && b[i + 1] == b'#' {
            return &value[..i];
        }
    }
    value
}

/// The ```excalidraw fenced scene JSON in a note body, if present. The fence
/// marker never appears in frontmatter, so scanning the whole plaintext is safe.
fn fenced_scene(plaintext: &str) -> Option<&str> {
    let start = plaintext.find("```excalidraw")?;
    let after_open = &plaintext[start + "```excalidraw".len()..];
    let nl = after_open.find('\n')?;
    let scene = &after_open[nl + 1..];
    let close = scene.find("\n```")?;
    Some(&scene[..close])
}

/// Project a drawing note's plaintext to its searchable text — the newline-joined
/// text-element strings of the scene (skipping `isDeleted`). `None` when the note
/// is not a drawing, the scene is missing/malformed, or it carries no text; the
/// caller then indexes only the title.
pub fn project_drawing_text(plaintext: &[u8]) -> Option<String> {
    if !is_drawing(plaintext) {
        return None;
    }
    let text = std::str::from_utf8(plaintext).ok()?;
    let scene_json = fenced_scene(text)?;
    let value: serde_json::Value = serde_json::from_str(scene_json).ok()?;
    let elements = value.get("elements")?.as_array()?;
    let mut out: Vec<String> = Vec::new();
    for el in elements {
        if el.get("isDeleted").and_then(serde_json::Value::as_bool) == Some(true) {
            continue;
        }
        if el.get("type").and_then(serde_json::Value::as_str) != Some("text") {
            continue;
        }
        let t = el
            .get("originalText")
            .or_else(|| el.get("text"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if !t.is_empty() {
            out.push(t.to_string());
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drawing(scene: &str) -> Vec<u8> {
        format!("---\nkind: drawing\ntitle: S\n---\n\n```excalidraw\n{scene}\n```\n").into_bytes()
    }

    #[test]
    fn is_drawing_is_value_strict() {
        assert!(is_drawing(b"---\nkind: drawing\n---\n\nbody"));
        assert!(is_drawing(b"---\nkind: drawing # note\n---\n\nbody"));
        assert!(!is_drawing(b"---\nkind: \"drawing\"\n---\n\nbody"));
        assert!(!is_drawing(b"---\nkind: Drawing\n---\n\nbody"));
        assert!(!is_drawing(b"---\nkind: task\n---\n\nbody"));
        assert!(!is_drawing(b"---\ntitle: N\n---\n\nbody"));
        assert!(!is_drawing(b"plain note, no frontmatter"));
    }

    #[test]
    fn is_drawing_agrees_with_ts_reader_on_indent_and_spacing() {
        // Shapes the TS `readKindFromFmBody` (KIND_KEY_RE) accepts — the Rust
        // reader must agree (drift-lock; PR-review finding 2).
        assert!(is_drawing(b"---\n  kind: drawing\n---\n\nb")); // indented
        assert!(is_drawing(b"---\nkind : drawing\n---\n\nb")); // space before colon
        assert!(is_drawing(b"---\nkind:drawing\n---\n\nb")); // no space after colon
        assert!(is_drawing(b"---\nkind: drawing\t# c\n---\n\nb")); // TAB before comment
        assert!(is_drawing(b"---\nkind: drawing  # c\n---\n\nb")); // 2 spaces + comment
        assert!(!is_drawing(b"---\nkindly: drawing\n---\n\nb")); // not the kind field
    }

    #[test]
    fn projects_text_elements_only_skipping_deleted() {
        let scene = r#"{"type":"excalidraw","elements":[
            {"type":"text","text":"hi","originalText":"hello world"},
            {"type":"rectangle","x":1},
            {"type":"text","text":"gone","isDeleted":true},
            {"type":"text","originalText":"second line"}
        ]}"#;
        let got = project_drawing_text(&drawing(scene)).unwrap();
        assert!(got.contains("hello world")); // originalText preferred
        assert!(got.contains("second line"));
        assert!(!got.contains("gone")); // deleted skipped
        assert!(!got.contains("rectangle")); // non-text skipped
    }

    #[test]
    fn non_drawing_returns_none() {
        assert_eq!(
            project_drawing_text(b"---\ntitle: N\n---\n\n# Real markdown"),
            None
        );
    }

    #[test]
    fn malformed_scene_returns_none() {
        assert_eq!(project_drawing_text(&drawing("{not valid json")), None);
    }

    #[test]
    fn no_text_elements_returns_none() {
        let scene = r#"{"type":"excalidraw","elements":[{"type":"rectangle"}]}"#;
        assert_eq!(project_drawing_text(&drawing(scene)), None);
    }
}
