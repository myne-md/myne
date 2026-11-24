// SPDX-License-Identifier: AGPL-3.0-only
//! The one frontmatter single-key splice: read a field's value, replace it with
//! a string scalar, and leave every other byte alone.
//!
//! **A callable function, not the inside of a command.** Two features need this
//! splice: `note_set_field` (view-scoped, `view-manifests`) and the
//! connection-scoped writer of `external-mcp-connection`. If it lived inside
//! either command, the second would copy it, and two opinions about quoting,
//! multi-line values and inline comments would appear exactly where both design
//! docs say they must not. So it is a `pub fn` in a `pub mod`, reachable from
//! any client and any plugin core without going through a command.
//!
//! # The rules, and where they come from
//!
//! This is a port of the TypeScript byte surgery in `dialect/src/surgery.ts`
//! (`applyStateCImpl` + `formatYamlStringScalar` + `logicalValueEnd`), which is
//! the app's established frontmatter writer and carries three hard-won rules:
//!
//! - **The whole LOGICAL value is replaced, not just the key line.** A value may
//!   continue onto indented lines (a block scalar, a block sequence, a
//!   multi-line quoted or plain scalar), and a splice that rewrites only the key
//!   line welds those leftovers onto the new value. Where the result still
//!   parses it is a mangled value; where it does not, the reader throws and the
//!   note loses its whole frontmatter record at once (myne#324).
//! - **A trailing `# comment` survives**, and the existing quote style is
//!   preserved when the value was already quoted.
//! - **A later duplicate of the same key is dropped.** A frontmatter block
//!   carrying a key twice is rejected wholesale by the app's YAML reader, so the
//!   duplicate is what turns a property write into "Untitled and unfiled". Only
//!   the first occurrence is replaced, so without this the duplicate would
//!   survive every write and no in-app action could repair it.
//!
//! # Two deliberate divergences from `patchFrontmatterField`, both reasoned
//!
//! 1. **Column zero only.** The TS generic patcher matches a key at any indent
//!    (unless it is one of its managed fields). A view declares a top-level
//!    PROPERTY, and a nested `seo.status:` is a different property, so both the
//!    read and the write here are anchored. This also keeps one reader and one
//!    writer rather than the TS pair's managed-vs-generic split, which exists to
//!    serve a hundred-year list of managed keys; there is one caller here.
//! 2. **The value is written as a STRING** (`formatYamlStringScalar` semantics),
//!    so a value shaped like a number, a bool or a date comes back quoted and
//!    reads back as the exact text a view declared. The TS generic patcher's
//!    `formatYamlScalar` would emit it bare, and the property index would then
//!    type it as a number or a date: a view promising to write the string `3`
//!    would have written the number 3. A view's declared value is text, so text
//!    is what is written.
//!
//! The note's ciphertext is untouched by all of this: frontmatter is plaintext
//! INSIDE the note blob, so no magic, AAD role, subkey or KDF parameter is
//! involved anywhere in this module.

use crate::plugins::notes::title_extract::extract_title_slices;
use unicode_normalization::UnicodeNormalization;

/// Why a field could not be read or written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrontmatterPatchError {
    /// The field name is not a plain YAML key (`[A-Za-z0-9_-]+`). Writing one
    /// would emit a line no reader would find again, so it is refused rather
    /// than escaped or quoted: a key this module cannot write is a key it does
    /// not write.
    InvalidFieldName,
    /// The frontmatter block is not valid UTF-8. Refused rather than patched
    /// lossily: `from_utf8_lossy` would rewrite bytes the user never touched.
    NotUtf8,
}

/// The value of one top-level frontmatter field, NFC-folded, quotes unwrapped
/// and any trailing `# comment` removed.
///
/// `None` means "no value", and it covers more than absence, deliberately: an
/// absent key, an empty value, a block scalar (`|` / `>`) and a structurally
/// damaged value all read as `None`. A caller comparing against an expected
/// value therefore treats every one of them as a mismatch rather than as a
/// match, which is the fail-closed direction for a precondition.
pub fn read_string_field(plaintext: &[u8], field: &str) -> Option<String> {
    if !is_plain_key(field) {
        return None;
    }
    let frontmatter = extract_title_slices(plaintext).frontmatter_bytes?;
    let text = core::str::from_utf8(frontmatter).ok()?;
    let (_, value_portion) = find_key_line(text, field)?;
    parse_scalar(value_portion).map(|v| v.nfc().collect())
}

/// Replace one top-level frontmatter field with `value`, read back as exactly
/// that string.
///
/// Every byte outside the field's own logical value is preserved: the body, the
/// other keys, their order, indentation of everything else, and a trailing
/// comment on the patched line. A note without a frontmatter block gains one at
/// the top; a note whose block lacks this key gains the key as its last line.
pub fn set_string_field(
    plaintext: &[u8],
    field: &str,
    value: &str,
) -> Result<Vec<u8>, FrontmatterPatchError> {
    if !is_plain_key(field) {
        return Err(FrontmatterPatchError::InvalidFieldName);
    }
    let rendered = format_string_scalar(value);
    let Some(frontmatter) = extract_title_slices(plaintext).frontmatter_bytes else {
        // State A: no block at all. Same shape the TS writer and the agent's
        // folder rewrite both emit, so a note gained by this path is shaped
        // like every other note.
        let mut out = Vec::with_capacity(plaintext.len() + field.len() + rendered.len() + 16);
        out.extend_from_slice(b"---\n");
        out.extend_from_slice(field.as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(rendered.as_bytes());
        out.extend_from_slice(b"\n---\n\n");
        out.extend_from_slice(plaintext);
        return Ok(out);
    };
    let base = plaintext.as_ptr() as usize;
    let start = frontmatter.as_ptr() as usize - base;
    let end = start + frontmatter.len();
    let inner = core::str::from_utf8(frontmatter).map_err(|_| FrontmatterPatchError::NotUtf8)?;
    let patched = patch_block(inner, field, &rendered);

    let mut out = Vec::with_capacity(plaintext.len() + patched.len() + rendered.len() + 8);
    out.extend_from_slice(&plaintext[..start]);
    out.extend_from_slice(patched.as_bytes());
    out.extend_from_slice(&plaintext[end..]);
    Ok(out)
}

/// Render `value` the way a string-typed frontmatter value must be written:
/// plain when a YAML reader gives back exactly these characters, double-quoted
/// with `\\` and `\"` escapes when it would not.
///
/// `pub` because the second caller (the connection-scoped writer) needs the same
/// rendering for a field it creates rather than replaces, and because the tests
/// assert the rules against one implementation instead of a copy.
pub fn format_string_scalar(value: &str) -> String {
    if needs_quotes(value) || yaml_would_retype(value) {
        let mut out = String::with_capacity(value.len() + 2);
        out.push('"');
        for ch in value.chars() {
            if ch == '\\' || ch == '"' {
                out.push('\\');
            }
            out.push(ch);
        }
        out.push('"');
        out
    } else {
        value.to_string()
    }
}

/// NFC fold, for comparing two scalars the way a reader sees them. A decomposed
/// and a precomposed form of the same text are the same value, so a
/// value-anchored precondition must not refuse a write over the encoding.
pub fn compare_key(value: &str) -> String {
    value.nfc().collect()
}

// ---- block splicing --------------------------------------------------------

/// Patch one key inside a frontmatter block (the bytes BETWEEN the fences,
/// without the closing newline handling: `split('\n')` + `join("\n")` round
/// trips the input exactly, so untouched lines are byte-identical).
fn patch_block(inner: &str, field: &str, rendered: &str) -> String {
    let mut lines: Vec<String> = inner.split('\n').map(str::to_string).collect();
    let new_line = format!("{field}: {rendered}");

    if let Some(i) = lines
        .iter()
        .position(|line| match_key_line(line, field).is_some())
    {
        let value_portion = match_key_line(&lines[i], field).unwrap_or("");
        let value_end = logical_value_end(&lines, i, value_portion.trim().is_empty());
        lines[i] = render_line(&lines[i], rendered, value_portion);
        // The logical value's continuation lines go with the old value.
        let drop_to = value_end.min(lines.len());
        if drop_to > i + 1 {
            lines.drain(i + 1..drop_to);
        }
        // Later duplicates of the same key are stale by construction; leaving
        // one in place makes the app's YAML reader reject the whole block.
        let mut k = i + 1;
        while k < lines.len() {
            match match_key_line(&lines[k], field) {
                Some(dup_value) => {
                    let dup_end = logical_value_end(&lines, k, dup_value.trim().is_empty());
                    let end = dup_end.max(k + 1).min(lines.len());
                    lines.drain(k..end);
                }
                None => k += 1,
            }
        }
        return lines.join("\n");
    }

    // State B: the block exists and this key does not. The key becomes its last
    // logical line, which is where a reader looking for it would find it. A
    // trailing empty element is the block's final newline, so the key goes
    // BEFORE it and the block keeps its exact shape.
    match lines.last() {
        Some(last) if last.is_empty() => lines.insert(lines.len() - 1, new_line),
        _ => lines.push(new_line),
    }
    lines.join("\n")
}

/// Rebuild the key line, preserving the indent it already had and, in this
/// order, a trailing comment (which outranks the quote style: the comment is the
/// author's text and a new value does not make it wrong).
fn render_line(line: &str, rendered: &str, value_portion: &str) -> String {
    let key_end = line.len() - value_portion.len();
    let prefix = &line[..key_end];

    // A `key:` with nothing after it leaves the prefix without its separator.
    let sep = if prefix.ends_with(' ') || prefix.ends_with('\t') {
        ""
    } else {
        " "
    };

    // Preserve a trailing comment, whether the old value was quoted or not.
    if let Some(comment) = trailing_comment(value_portion) {
        return format!("{prefix}{sep}{rendered}{comment}");
    }
    format!("{prefix}{sep}{rendered}")
}

/// The `[ \t]+#...` tail of a value portion, or `None`. The same rule
/// `daily_match::strip_inline_comment` applies on the read side, so a comment
/// this module preserves is a comment that reader still strips.
fn trailing_comment(value_portion: &str) -> Option<&str> {
    let b = value_portion.as_bytes();
    for i in 0..b.len().saturating_sub(1) {
        if (b[i] == b' ' || b[i] == b'\t') && b[i + 1] == b'#' {
            // Walk back over the whole whitespace RUN, so the comment keeps the
            // column it was written in rather than collapsing to one space.
            // The TS `[ \t]+#` capture does the same.
            let mut start = i;
            while start > 0 && (b[start - 1] == b' ' || b[start - 1] == b'\t') {
                start -= 1;
            }
            return Some(&value_portion[start..]);
        }
    }
    None
}

/// One past the last line of the LOGICAL value whose key line is `lines[i]`.
///
/// A continuation line is any line that is indented, plus a column-zero block
/// sequence item under a key whose own value portion is empty, plus blank lines
/// that are themselves followed by a continuation (a block scalar may contain
/// them). The blank-line lookahead is what keeps a separator line BETWEEN two
/// keys from being absorbed.
fn logical_value_end(lines: &[String], i: usize, value_is_empty: bool) -> usize {
    let is_continuation = |line: &str| {
        line.starts_with(' ')
            || line.starts_with('\t')
            || (value_is_empty
                && (line == "-" || line.starts_with("- ") || line.starts_with("-\t")))
    };

    let mut j = i + 1;
    while j < lines.len() {
        let line = &lines[j];
        if line.trim().is_empty() {
            let mut k = j;
            while k < lines.len() && lines[k].trim().is_empty() {
                k += 1;
            }
            if k < lines.len() && is_continuation(&lines[k]) {
                j = k;
                continue;
            }
            return j;
        }
        if !is_continuation(line) {
            return j;
        }
        j += 1;
    }
    j
}

// ---- reading ---------------------------------------------------------------

/// Find the first column-zero `<field>:` line, returning `(prefix, value)` where
/// `prefix` includes the key and its colon.
fn find_key_line<'a>(block: &'a str, field: &str) -> Option<(&'a str, &'a str)> {
    for line in block.split('\n') {
        if let Some(value) = match_key_line(line, field) {
            return Some((&line[..line.len() - value.len()], value));
        }
    }
    None
}

/// `^<field>[ \t]*:[ \t]*(.*)$` at column zero, returning the value portion.
fn match_key_line<'a>(line: &'a str, field: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(field)?;
    let rest = rest.trim_start_matches([' ', '\t']);
    let rest = rest.strip_prefix(':')?;
    Some(rest.trim_start_matches([' ', '\t']))
}

/// The plain scalar a value portion encodes, or `None` when it does not encode
/// one this module is willing to call a value.
fn parse_scalar(value_portion: &str) -> Option<String> {
    let trimmed = value_portion.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Block scalars carry their value in the lines below the key. Reading them
    // is a multi-line question this module does not answer, and a caller that
    // needs the value must look at the note (the write side collapses the block
    // to one line, so the two agree after one write).
    if trimmed.starts_with('|') || trimmed.starts_with('>') {
        return None;
    }
    if let Some(rest) = trimmed.strip_prefix('"') {
        return match parse_double_quoted(rest) {
            Some((inner, tail)) if tail_is_comment_or_empty(tail) => Some(inner),
            _ => None,
        };
    }
    if let Some(rest) = trimmed.strip_prefix('\'') {
        return match rest.find('\'') {
            Some(close) if tail_is_comment_or_empty(&rest[close + 1..]) => {
                Some(rest[..close].to_string())
            }
            _ => None,
        };
    }
    let raw = strip_inline_comment(value_portion).trim();
    if raw.is_empty() {
        None
    } else {
        Some(raw.to_string())
    }
}

/// Undo the escapes `format_string_scalar` emits, up to the closing quote.
/// Returns the logical value and everything after the closing quote.
fn parse_double_quoted(s: &str) -> Option<(String, &str)> {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.char_indices();
    while let Some((i, ch)) = chars.next() {
        match ch {
            '\\' => {
                let (_, next) = chars.next()?;
                // `format_string_scalar` only emits `\\` and `\"`; anything else
                // is a value we did not write, and passing the escaped char
                // through verbatim is the conservative read.
                out.push(next);
            }
            '"' => return Some((out, &s[i + 1..])),
            other => out.push(other),
        }
    }
    None
}

fn tail_is_comment_or_empty(tail: &str) -> bool {
    let t = tail.trim_start_matches([' ', '\t']);
    t.is_empty() || t.starts_with('#')
}

fn strip_inline_comment(value: &str) -> &str {
    match trailing_comment(value) {
        Some(at) => &value[..value.len() - at.len()],
        None => value,
    }
}

// ---- scalar shaping --------------------------------------------------------

/// A key this module can write and find again: the same `[A-Za-z0-9_-]+` shape
/// the TS matchers use. The reserved markers (`archived`, `trashed`, `deleted`)
/// are NOT excluded here: refusing them is the command's rule, because the
/// splice itself has no opinion about which keys a caller is allowed to touch.
pub fn is_plain_key(field: &str) -> bool {
    !field.is_empty()
        && field
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Whether YAML would read this plain scalar as something other than itself, or
/// would not read it back exactly.
///
/// Mirrors `dialect/src/surgery.ts::needsYamlQuoting`: an empty value, a leading
/// indicator character, leading or trailing whitespace, `: ` (opens a mapping),
/// ` #` (opens a comment), or a newline all need quoting.
fn needs_quotes(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    if value.starts_with([
        ' ', '\t', '\n', '\r', '-', '?', ':', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>',
        '\'', '"', '%', '@', '`',
    ]) {
        return true;
    }
    if value.ends_with([' ', '\t']) {
        return true;
    }
    if value.contains(": ") || value.contains('\n') || value.contains('\r') {
        return true;
    }
    if value
        .as_bytes()
        .windows(2)
        .any(|w| (w[0] == b' ' || w[0] == b'\t') && w[1] == b'#')
    {
        return true;
    }
    false
}

/// Whether a plain scalar of this shape parses back as a non-string (or a
/// different string): a bool, a null, a number, a date.
///
/// A static approximation of the TS `yamlReTypesPlainScalar`, which asks
/// js-yaml itself. Deliberately conservative in the QUOTING direction: quoting a
/// value that did not need it costs a pair of quotes, while missing one makes a
/// property read back as a different type than the view declared.
fn yaml_would_retype(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "true" | "false" | "null" | "~" | "yes" | "no" | "on" | "off" | ".inf" | "-.inf" | ".nan"
    ) {
        return true;
    }
    // A bare number: optional sign, digits with an optional fraction/exponent,
    // and the `0x` / `0o` forms YAML also resolves.
    let n = value.strip_prefix(['+', '-']).unwrap_or(value);
    if n.is_empty() {
        return false;
    }
    let radix_prefixed = n.starts_with("0x") || n.starts_with("0X") || n.starts_with("0o");
    let all_numeric = n.bytes().all(|b| {
        b.is_ascii_digit()
            || b == b'.'
            || b == b'_'
            || b == b'e'
            || b == b'E'
            || b == b'+'
            || b == b'-'
    });
    if (all_numeric && n.bytes().any(|b| b.is_ascii_digit())) || (radix_prefixed && n.len() > 2) {
        return true;
    }
    // A date or timestamp shape: `YYYY-MM-DD`, optionally with a time.
    looks_like_date(value)
}

fn looks_like_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 10 {
        return false;
    }
    let date_shape = bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(u8::is_ascii_digit);
    if !date_shape {
        return false;
    }
    bytes.len() == 10 || bytes[10] == b' ' || bytes[10] == b'T'
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf8(bytes: &[u8]) -> &str {
        core::str::from_utf8(bytes).expect("utf8")
    }

    // ---- read ---------------------------------------------------------

    #[test]
    fn reads_a_plain_scalar_and_strips_a_trailing_comment() {
        let note = b"---\nstatus: done  # finished on friday\n---\n\nbody\n";
        assert_eq!(read_string_field(note, "status").as_deref(), Some("done"));
    }

    #[test]
    fn reads_a_quoted_scalar_as_its_logical_text() {
        let note = b"---\nstatus: \"in progress\"\n---\n\nbody\n";
        assert_eq!(
            read_string_field(note, "status").as_deref(),
            Some("in progress")
        );
        let single = b"---\nstatus: 'in progress'\n---\n\nbody\n";
        assert_eq!(
            read_string_field(single, "status").as_deref(),
            Some("in progress")
        );
    }

    #[test]
    fn reads_an_escaped_double_quoted_scalar() {
        // `format_string_scalar` emits this shape for a value carrying a quote
        // and a backslash, and the reader must undo it.
        let note = b"---\nstatus: \"a \\\"quoted\\\" c\\\\d\"\n---\n\nbody\n";
        assert_eq!(
            read_string_field(note, "status").as_deref(),
            Some("a \"quoted\" c\\d")
        );
    }

    #[test]
    fn a_quoted_value_and_an_unquoted_value_of_the_same_text_compare_equal() {
        let quoted = b"---\npriority: \"3\"\n---\n\nbody\n";
        let bare = b"---\npriority: 3\n---\n\nbody\n";
        let a = read_string_field(quoted, "priority").expect("quoted value");
        let b = read_string_field(bare, "priority").expect("bare value");
        assert_eq!(compare_key(&a), compare_key(&b));
        assert_eq!(a, "3");
    }

    #[test]
    fn a_decomposed_and_a_precomposed_value_compare_equal() {
        // `e` + U+0308 versus U+00EB.
        let decomposed = "---\nstatus: cafe\u{308}\n---\n\nbody\n";
        // `e` + COMBINING DIAERESIS (U+0308) against the precomposed U+00EB below.
        let precomposed = "---\nstatus: caf\u{eb}\n---\n\nbody\n";
        let a = read_string_field(decomposed.as_bytes(), "status").expect("decomposed");
        let b = read_string_field(precomposed.as_bytes(), "status").expect("precomposed");
        assert_eq!(compare_key(&a), compare_key(&b));
    }

    #[test]
    fn an_absent_or_empty_or_block_scalar_field_reads_as_none() {
        let absent = b"---\nother: 1\n---\n\nbody\n";
        assert_eq!(read_string_field(absent, "status"), None);
        let empty = b"---\nstatus:\n---\n\nbody\n";
        assert_eq!(read_string_field(empty, "status"), None);
        let block = b"---\nstatus: |\n  two\n  lines\n---\n\nbody\n";
        assert_eq!(read_string_field(block, "status"), None);
        let no_frontmatter = b"just a body\n";
        assert_eq!(read_string_field(no_frontmatter, "status"), None);
    }

    #[test]
    fn a_nested_key_is_not_the_top_level_field() {
        let note = b"---\nseo:\n  status: hidden\n---\n\nbody\n";
        assert_eq!(read_string_field(note, "status"), None);
    }

    // ---- write: the acceptance criteria ---------------------------------

    #[test]
    fn the_patch_preserves_the_body_and_every_other_key_in_order() {
        let note =
            b"---\ntitle: Books\nstatus: reading\nrating: 4\n---\n\nThe body\nhas two lines.\n";
        let out = set_string_field(note, "status", "done").expect("patch");
        assert_eq!(
            utf8(&out),
            "---\ntitle: Books\nstatus: done\nrating: 4\n---\n\nThe body\nhas two lines.\n"
        );
    }

    #[test]
    fn the_patch_preserves_an_inline_trailing_comment_on_the_patched_line() {
        let note = b"---\nstatus: reading   # started in january\nrating: 4\n---\n\nbody\n";
        let out = set_string_field(note, "status", "done").expect("patch");
        assert_eq!(
            utf8(&out),
            "---\nstatus: done   # started in january\nrating: 4\n---\n\nbody\n"
        );
    }

    #[test]
    fn the_patch_collapses_a_block_scalar_to_one_line_and_keeps_what_follows() {
        let note = b"---\nstatus: |\n  two\n  lines\nrating: 4\n---\n\nbody\n";
        let out = set_string_field(note, "status", "done").expect("patch");
        assert_eq!(utf8(&out), "---\nstatus: done\nrating: 4\n---\n\nbody\n");
    }

    #[test]
    fn a_value_shaped_like_a_number_is_written_as_a_string() {
        // The property index types an unquoted `3` as a number, so a view that
        // declared the STRING has to get one back.
        let note = b"---\npriority: high\n---\n\nbody\n";
        let out = set_string_field(note, "priority", "3").expect("patch");
        assert_eq!(utf8(&out), "---\npriority: \"3\"\n---\n\nbody\n");
        assert_eq!(
            read_string_field(&out, "priority").as_deref(),
            Some("3"),
            "the written value reads back as the exact declared text",
        );
    }

    #[test]
    fn a_value_carrying_a_quote_or_a_comment_marker_round_trips() {
        let note = b"---\nstatus: old\n---\n\nbody\n";
        for value in ["a \"quoted\" value", "note # 4", "x: y", "- dash", "line"] {
            let out = set_string_field(note, "status", value).expect("patch");
            assert_eq!(
                read_string_field(&out, "status").as_deref(),
                Some(value),
                "value {value:?} must survive the write",
            );
            assert_eq!(
                read_string_field(&out, "title"),
                None,
                "and must not leak into another key",
            );
        }
    }

    #[test]
    fn a_note_without_frontmatter_gains_a_block_and_keeps_its_bytes() {
        let note = b"# Heading\n\nbody\n";
        let out = set_string_field(note, "status", "done").expect("patch");
        assert_eq!(utf8(&out), "---\nstatus: done\n---\n\n# Heading\n\nbody\n");
    }

    #[test]
    fn a_block_without_the_key_gains_it_as_the_last_line() {
        let note = b"---\ntitle: Books\n---\n\nbody\n";
        let out = set_string_field(note, "status", "done").expect("patch");
        assert_eq!(utf8(&out), "---\ntitle: Books\nstatus: done\n---\n\nbody\n");
    }

    #[test]
    fn a_later_duplicate_of_the_key_is_dropped() {
        // js-yaml rejects the whole block on a duplicated key, which is how a
        // property write turns into "Untitled and unfiled".
        let note = b"---\nstatus: a\nrating: 4\nstatus: b\n---\n\nbody\n";
        let out = set_string_field(note, "status", "done").expect("patch");
        assert_eq!(utf8(&out), "---\nstatus: done\nrating: 4\n---\n\nbody\n");
        assert_eq!(read_string_field(&out, "status").as_deref(), Some("done"));
    }

    #[test]
    fn the_patch_is_a_fixed_point_when_the_value_is_already_there() {
        let note = b"---\nstatus: done\nrating: 4\n---\n\nbody\n";
        let once = set_string_field(note, "status", "done").expect("patch");
        let twice = set_string_field(&once, "status", "done").expect("patch");
        assert_eq!(once, twice);
    }

    #[test]
    fn an_indented_key_is_untouched_because_a_view_field_is_top_level() {
        let note = b"---\nseo:\n  status: hidden\nstatus: shown\n---\n\nbody\n";
        let out = set_string_field(note, "status", "done").expect("patch");
        assert_eq!(
            utf8(&out),
            "---\nseo:\n  status: hidden\nstatus: done\n---\n\nbody\n"
        );
    }

    // ---- the function is callable on its own -----------------------------

    #[test]
    fn the_patch_and_the_read_are_both_reachable_without_a_command() {
        // The acceptance criterion this pins: a second feature can call the
        // splice directly, with no command, no prefs, no vault slot. The test
        // below IS such a caller.
        let note = b"---\nstatus: old\n---\n\nbody\n";
        let patched = set_string_field(note, "status", "new").expect("patch");
        assert_eq!(
            read_string_field(&patched, "status").as_deref(),
            Some("new")
        );
        assert_eq!(read_string_field(note, "status").as_deref(), Some("old"));
    }

    #[test]
    fn a_field_name_that_is_not_a_plain_key_is_refused() {
        let note = b"---\nstatus: old\n---\n\nbody\n";
        for bad in ["", "two words", "a:b", "a b", "st\ntus"] {
            assert_eq!(
                set_string_field(note, bad, "x"),
                Err(FrontmatterPatchError::InvalidFieldName),
                "field {bad:?} must be refused",
            );
            assert_eq!(read_string_field(note, bad), None);
        }
    }

    #[test]
    fn the_rendered_scalar_quotes_what_yaml_would_retype() {
        for (value, quoted) in [
            ("plain", false),
            ("3", true),
            ("2026-06-07", true),
            ("true", true),
            ("null", true),
            ("", true),
            (" padded", true),
            ("padded ", true),
            ("a: b", true),
            ("a #b", true),
            ("- x", true),
        ] {
            let rendered = format_string_scalar(value);
            assert_eq!(
                rendered.starts_with('"'),
                quoted,
                "value {value:?} rendered as {rendered:?}",
            );
        }
    }
}
