// SPDX-License-Identifier: AGPL-3.0
//! The anchored edit format: exact match, exactly once, or refused.
//!
//! An edit is a pair of (exact existing text, replacement text) against one
//! note. The host requires the anchor to occur **exactly once** in the note.
//! Zero occurrences and more than one are separate named refusals, and neither
//! is ever resolved by placing the replacement somewhere plausible.
//!
//! **"Occurs" counts OVERLAPPING occurrences.** `str::match_indices` does not:
//! it resumes the search after each match, so `"aa"` occurs once in `"aaa"` by
//! its count and twice by the rule this module states. That gap is a silent
//! placement of an edit the format promises to refuse, which is the one failure
//! class the anchored format exists to prevent, so the count is done by hand.
//! Rare in practice (anchors are long spans copied out of a body) and the point
//! is not the frequency: a rule with an exception nobody stated is not the rule.
//! Found in review round five of myne-md/myne#531.
//!
//! **There is no fuzzy matching here and there must never be one.** Not a
//! nearest-match fallback, not a whitespace-tolerant retry, not a "try again
//! without the trailing newline". Every one of those looks like an ergonomics
//! improvement and every one of them converts a visible refusal into a silent
//! misapplication, which is the single failure class this format exists to
//! prevent. A model that copies anchors badly is a model that shows agent mode
//! as unavailable ([`super::probe`]), not a model this module accommodates.
//!
//! **[`place`] is the whole rule and the only entry point.** There is no
//! sequential multi-edit helper here: the apply path owns that loop, because it
//! is the one that also has to report a per-edit outcome with the index the user
//! looked at. A second implementation living here would be a second place the
//! overlap semantics could be right, tested in the place production does not
//! call.
//!
//! **The sync race is answered here rather than by a lock.** Anchors are
//! content-addressed, so an edit whose note changed between the model reading it
//! and the user approving simply does not match, and is refused by the ordinary
//! rule with no special-case code path. An offset-based or line-based encoding
//! would instead apply to whatever now sits at that position.

use super::error::EditRejection;
use super::frontmatter::folder_of;
use crate::folder_key::canonical_folder;
use crate::plugins::notes::title_extract::{body_after_frontmatter, extract_title_slices};
use serde::{Deserialize, Serialize};

/// Which shape of write this edit is.
///
/// **A discriminator on the existing type rather than a second list on the
/// proposal, and that placement is the design.** The removal carve-out, the
/// bulk-approval split, the not-proposed check, the undo restore point and the
/// review screen are all keyed on `Proposal::edits`; a parallel `appends` list
/// would mean re-deriving five checks by hand, and `hide.rs` exists because one
/// of those checks was once incomplete. Here, an append inherits every one of
/// them by construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum EditKind {
    /// Replace [`ProposedEdit::anchor`] with [`ProposedEdit::replacement`].
    #[default]
    Replace,
    /// Append [`ProposedEdit::replacement`] to the end of the note's body.
    /// [`ProposedEdit::anchor`] is unused and must be empty.
    Append,
    /// Move the note to another folder.
    ///
    /// **A verb rather than a relaxation of the edit rule.** [`place`] still
    /// cannot move a note, and the apply path still refuses an anchored edit
    /// that rewrites `folder:` ([`EditRejection::NoteMoved`]) under every
    /// approval label: that route hides the destination inside replacement text,
    /// which is exactly how a note could cross the `ai_excluded_folders`
    /// boundary with nothing reading where it landed.
    ///
    /// Here the destination IS the edit's field, so there is something for the
    /// clamp to read and for the review screen to show. The placement on this
    /// enum is the argument [`EditKind::Append`] already makes: the scope check,
    /// the restore point, the arity bound, the not-proposed check and the review
    /// list are all keyed on `Proposal::edits`, so a move inherits every one of
    /// them by construction instead of re-deriving five checks in a second list.
    ///
    /// [`ProposedEdit::replacement`] carries the DESTINATION FOLDER and
    /// [`ProposedEdit::anchor`] is unused and must be empty, exactly as the
    /// append arm reuses the field for its text.
    Move,
}

/// One proposed edit against one note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedEdit {
    /// The note this edit applies to.
    pub note_id: String,
    /// Replace or append. `#[serde(default)]` so a payload written before the
    /// append verb existed still deserializes as the replace it was.
    #[serde(default)]
    pub kind: EditKind,
    /// The exact existing text the model copied out of the note. Empty for an
    /// append, where there is nothing to anchor to.
    pub anchor: String,
    /// What replaces it. An empty replacement is a deletion of the anchor, which
    /// is ordinary and allowed; it is the review surface's job to flag a large
    /// net deletion, not this module's to refuse one.
    pub replacement: String,
}

/// Place one anchored replacement into a body.
///
/// The whole rule, in one function, so there is one place to read and one place
/// to break when verifying it.
pub fn place(body: &str, anchor: &str, replacement: &str) -> Result<String, EditRejection> {
    if anchor.is_empty() {
        // An empty anchor matches at every position, so "exactly once" would be
        // vacuously false for any non-empty body and vacuously true for an empty
        // one. Naming it is better than letting the count rule decide.
        return Err(EditRejection::AnchorEmpty);
    }
    // Overlapping, by stepping one CHARACTER at a time rather than one match:
    // see the module doc. `char_indices` rather than a byte walk so a resume
    // point is always a char boundary and `find` cannot panic on a slice.
    let mut found: Option<usize> = None;
    for (at, _) in body.char_indices() {
        if !body[at..].starts_with(anchor) {
            continue;
        }
        if found.is_some() {
            return Err(EditRejection::AnchorAmbiguous);
        }
        found = Some(at);
    }
    let Some(first) = found else {
        return Err(EditRejection::AnchorNotFound);
    };
    let mut out = String::with_capacity(body.len() - anchor.len() + replacement.len());
    out.push_str(&body[..first]);
    out.push_str(replacement);
    out.push_str(&body[first + anchor.len()..]);
    Ok(out)
}

/// Append `text` to a note's body.
///
/// **The verb that makes "write this into the note" possible at all.** An
/// anchored edit needs text copied out of the note, occurring exactly once, and
/// an empty anchor is refused by [`place`], so before this existed there was no
/// way to write into an empty note: the request failed for a structural reason
/// no message explained. Appending to a long note was possible but expensive
/// and brittle, since the model had to anchor on the whole tail and reproduce
/// it verbatim.
///
/// ## The append lands after the frontmatter, always
///
/// This is what stops an append from authoring frontmatter. The body region is
/// located with [`body_after_frontmatter`], the same scan the folder clamp uses,
/// and the text goes at the end of THAT rather than at the end of the file. In
/// a note that has a frontmatter block, appended text therefore cannot be the
/// first line, whatever it starts with.
///
/// Positioning alone does not close it, though, and the precondition this doc
/// used to state ("a note with NO frontmatter block and no body") was the wrong
/// one. A note with no frontmatter whose body merely BEGINS with `---` has an
/// opener nothing has closed, so appended text containing an ordinary `---`
/// separator closes it and the user's own first lines become a frontmatter
/// block. So the check is on the RESULT rather than on the shape of the input:
/// an append that gives the note a frontmatter block it did not have is
/// refused. That is the rule [`crate::plugins::agent::apply`] already applies
/// twice, in `edit_moves_note` and `edit_hides_note`, both of which compare
/// before against after rather than inspecting the replacement. Refused rather
/// than mangled, because silently rewriting the model's text would leave the
/// user approving something nobody wrote.
///
/// ## Separation
///
/// Trailing newlines on the existing body are normalised away and exactly one
/// blank line is inserted, so an append reads as a new block rather than
/// running into the last paragraph. In markdown a missing blank line is not
/// cosmetic: it makes the appended text part of the preceding paragraph.
///
/// The empty-body case needs the same care on the HEAD side, and that is not
/// symmetry for its own sake. [`crate::plugins::notes::title_extract`] accepts
/// a closing `---` that ends the file with no newline after it, so a note can
/// legitimately arrive whose head does not end in `\n` and whose body region is
/// empty. Pushing the text straight after that head glues it onto the closer
/// line, the closer stops closing, and the whole block ceases to be
/// frontmatter: `title:`, `folder:`, tags and task fields all become one
/// malformed body line. Normalising here is what makes the two spellings of
/// the same note append identically.
pub fn append(body: &str, text: &str) -> Result<String, EditRejection> {
    if text.trim().is_empty() {
        return Err(EditRejection::AppendEmpty);
    }
    // `body_after_frontmatter` returns the body SLICE; the difference in length
    // is where it begins, and that boundary is always just past a `\n`, so the
    // split cannot land inside a character.
    let rest = body_after_frontmatter(body.as_bytes());
    let head_len = body.len() - rest.len();
    let (head, tail) = body.split_at(head_len);
    let tail = tail.trim_end_matches('\n');
    let text = text.trim_end_matches('\n');

    let mut out = String::with_capacity(body.len() + text.len() + 2);
    out.push_str(head);
    if !head.is_empty() && !head.ends_with('\n') {
        // A frontmatter closer that ends the file with no newline after it.
        // Without this the text lands ON the closer line and unmakes the block.
        out.push('\n');
    }
    if !tail.is_empty() {
        out.push_str(tail);
        out.push_str("\n\n");
    }
    out.push_str(text);
    out.push('\n');

    // The result check. An append writes BODY text, so whether the note has a
    // frontmatter block is not its to change. The gaining direction is the one
    // an untrusted replacement can force, and it is refused here; the losing
    // direction is our own head handling and is pinned by test instead, since a
    // refusal named `AppendWouldWriteFrontmatter` would be the wrong sentence to
    // show a user whose frontmatter we had just destroyed.
    let had_frontmatter = extract_title_slices(body.as_bytes())
        .frontmatter_bytes
        .is_some();
    let has_frontmatter = extract_title_slices(out.as_bytes())
        .frontmatter_bytes
        .is_some();
    if has_frontmatter && !had_frontmatter {
        return Err(EditRejection::AppendWouldWriteFrontmatter);
    }

    Ok(out)
}

/// The destination as a YAML scalar BOTH readers resolve identically.
///
/// **Quoted only when the value needs it, so an ordinary folder keeps the exact
/// shape the app's own writer produces** (`folder: Projects`). What needs quoting
/// is any value YAML would read as something other than itself: an inline `#`
/// starts a comment, a leading or trailing space is trimmed, `: ` opens a mapping
/// and an indicator character changes the scalar's kind. The Rust reader the clamp
/// uses (`fm_scalar`, behind `folder_of`) strips quotes but knows none of those
/// rules, so an unquoted special value made the clamp and the app disagree about
/// which folder the note is in.
///
/// A double quote or a backslash cannot be represented in a double-quoted scalar
/// without escaping, and no folder name needs either, so a destination carrying
/// one is refused rather than escaped: a destination this verb cannot write
/// faithfully is a destination it does not write.
pub(crate) fn yaml_folder_scalar(display: &str) -> Result<String, EditRejection> {
    if display.contains('"') || display.contains('\\') {
        return Err(EditRejection::UnsafeFrontmatter);
    }
    // **Refused rather than quoted, because no quoting makes the two readers
    // agree**: `fm_scalar` trims the value before comparing, so a folder whose
    // name begins or ends with a space reads with the space in the app and
    // without it in the clamp. The file's posture for a value it cannot write
    // faithfully is a refusal, and the review screen names it.
    if display.trim() != display || display.contains(['\n', '\r']) {
        return Err(EditRejection::UnsafeFrontmatter);
    }
    // **The rest mirrors `dialect/src/surgery.ts`'s `needsYamlQuoting` on
    // purpose** (review finding): the app writes `folder:` through that rule, so
    // a second, different notion of "needs quoting" made the agent's notes differ
    // from every other note's for values like `a#b`, which YAML reads as the plain
    // scalar it is. One addition to that rule, `yaml_would_retype`, because the
    // app's READER is js-yaml and resolves more than the writer escapes.
    let needs_quotes = display.is_empty()
        || yaml_would_retype(display)
        || display.starts_with([
            '-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '%', '@', '`',
            '\'',
        ])
        || display.contains(": ")
        || display
            .as_bytes()
            .windows(2)
            .any(|w| w[0].is_ascii_whitespace() && w[1] == b'#');
    Ok(if needs_quotes {
        format!("\"{display}\"")
    } else {
        display.to_string()
    })
}

/// Whether YAML would resolve this plain scalar as something other than the string
/// it looks like.
///
/// The two readers disagree exactly here. `format::fm_scalar`, behind the clamp's
/// `folder_of`, returns the text of the line; js-yaml, which the app parses with,
/// resolves a plain scalar through its schema, so an unquoted `2026` is a number
/// and an unquoted `2026-08-16` is a `Date`. A note the app then indexes under
/// `2026/` is clamped against the folder NAMED `2026`, and a folder named after a
/// year or a date is what an agent asked to file by date produces.
///
/// Deliberately conservative: quoting a value that did not need it costs nothing
/// but a pair of quotes, while missing one is the divergence this exists to stop.
fn yaml_would_retype(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "true"
            | "false"
            | "null"
            | "~"
            | "yes"
            | "no"
            | "on"
            | "off"
            | ".inf"
            | "-.inf"
            | "+.inf"
            | ".nan"
            | "nan"
            | "inf"
            | "-inf"
            | "+inf"
    ) {
        return true;
    }
    is_yaml_number(value) || is_yaml_timestamp(value)
}

/// Decimal, signed, exponent, hex, octal and binary spellings, with `_` as YAML
/// allows. No `core::str::parse` shortcut: `parse::<f64>` accepts `inf` and `NaN`
/// spellings YAML does not, and rejects `1_000` which YAML 1.1 accepts.
fn is_yaml_number(value: &str) -> bool {
    let v = value.strip_prefix(['+', '-']).unwrap_or(value);
    for (prefix, ok) in [
        (
            "0x",
            (|c: char| c.is_ascii_hexdigit() || c == '_') as fn(char) -> bool,
        ),
        ("0o", |c: char| matches!(c, '0'..='7' | '_')),
        ("0b", |c: char| matches!(c, '0' | '1' | '_')),
    ] {
        if let Some(rest) = v.strip_prefix(prefix) {
            return !rest.is_empty() && rest.chars().all(ok);
        }
    }
    let mut digits = false;
    let mut dot = false;
    let mut chars = v.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '0'..='9' => digits = true,
            '_' => {}
            '.' if !dot => dot = true,
            'e' | 'E' if digits => {
                let rest: String = chars.collect();
                let rest = rest.strip_prefix(['+', '-']).unwrap_or(rest.as_str());
                return !rest.is_empty() && rest.chars().all(|d| d.is_ascii_digit() || d == '_');
            }
            _ => return false,
        }
    }
    digits
}

/// `YYYY-M-D`, the bare shape js-yaml resolves to a `Date`, or the same date
/// followed by a time (`T` or a space). One or two digits for month and day, as
/// its regex accepts, and the date must be the whole scalar: `2026-08-16-notes`
/// is an ordinary name and stays one.
fn is_yaml_timestamp(value: &str) -> bool {
    fn digits(r: &[u8]) -> bool {
        !r.is_empty() && r.iter().all(u8::is_ascii_digit)
    }
    let b = value.as_bytes();
    // `YYYY-M-D` is 8 characters at its shortest, which is the bare date the
    // schema resolves.
    if b.len() < 8 || !digits(&b[0..4]) || b[4] != b'-' {
        return false;
    }
    let rest = &b[5..];
    let Some(dash) = rest.iter().position(|&c| c == b'-') else {
        return false;
    };
    if dash == 0 || dash > 2 || !digits(&rest[..dash]) {
        return false;
    }
    let rest = &rest[dash + 1..];
    let month = rest.iter().take_while(|c| c.is_ascii_digit()).count();
    if month == 0 || month > 2 || !digits(&rest[..month]) {
        return false;
    }
    rest.len() == month || matches!(rest[month], b'T' | b't' | b' ')
}

/// Move a note to a different folder.
///
/// **The only write in this feature that changes where a note lives**, and the
/// reason the folder lock in `apply.rs` is a two-way clamp rather than a blanket
/// refusal. [`place`] and [`append`] still cannot move a note: an anchored edit
/// that rewrites `folder:` is refused ([`EditRejection::NoteMoved`]) because it
/// hides its destination inside replacement text. Here the destination is the
/// edit's own field, which is what lets the review screen show it before the
/// user approves and lets the clamp read where the note lands.
///
/// ## What it refuses here
///
/// - A destination carrying a newline or a carriage return
///   ([`EditRejection::UnsafeFrontmatter`]): the value is interpolated into a
///   `folder:` line, so a newline in it would emit a second field nothing
///   validated. `apply::create_notes` validates a proposed new note's folder for
///   the same reason.
/// - A destination that resolves to the folder the note is already in
///   ([`EditRejection::MoveToSameFolder`]): a reformatting is not a move, and
///   letting it through would rewrite the note's bytes and bump its sync version
///   for no change.
///
/// **Not the folder's existence either, but only here.** In Myne a folder IS the
/// `folder:` field of some note, so naming a new one creates it by construction.
/// This function cannot tell an existing folder from an invented one and does
/// not try: the APPLY path refuses a destination the vault does not have
/// (`EditRejection::UnknownFolder`, myne-md/myne#913), because it is the layer
/// holding the folder roster. The split is deliberate: a pure string transform
/// stays pure, and the check that needs the vault lives where the vault is.
/// (That clause reverses the earlier "naming a new one creates it" reading, on
/// the report of a run that moved a note into a new top-level `Areas` beside the
/// user's `02 - AREAS`.)
///
/// ## The destination is compared canonically and written as given
///
/// [`canonical_folder`] lowercases and appends a slash, which is the right shape
/// for the comparison and the wrong shape to store: the user's `Work/Ideas` must
/// not come back as `work/ideas/`. So the value is written as it arrived with
/// empty segments dropped, and only the comparison is canonical.
///
/// ## A note with no frontmatter block gains one
///
/// The destination is necessarily the root here, because a root destination on a
/// note already at the root was refused as the same folder above. So the block
/// is authored, and it is authored CLOSED, which is what keeps a body merely
/// beginning with `---` as body: the append arm's frontmatter hazard is closed
/// here by construction rather than by a second check.
pub fn move_note(body: &str, folder: &str) -> Result<String, EditRejection> {
    if folder.contains('\n') || folder.contains('\r') {
        return Err(EditRejection::UnsafeFrontmatter);
    }
    let display = folder
        .split('/')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    // **The clamp and the app must read the same folder** (myne-md/myne#848).
    // The app parses frontmatter with js-yaml, which treats an unquoted `#` as the
    // start of a comment; the Rust reader (`fm_scalar`, behind `folder_of`) does
    // not. Written raw, a destination of `Private #x` made the clamp see
    // `Private #x` (not excluded) while the app saw `Private` (excluded): a
    // crafted value that walks a note INTO an excluded folder, and on the read
    // side lets the agent read a note the user excluded. Quoting closes it by
    // making the two readers agree on the whole value, whatever it contains.
    let scalar = yaml_folder_scalar(&display)?;
    if canonical_folder(&display) == folder_of(body) {
        return Err(EditRejection::MoveToSameFolder);
    }

    // `frontmatter_bytes` is the lines BETWEEN the fences, not the block: the
    // scanner hands back `plaintext[FM_OPENER.len()..closer_start]`. So the fence
    // that opened it is a fixed 4 bytes ahead of the slice and the closer begins
    // exactly where the slice ends, which is what makes the rebuild below a
    // prefix, the rewritten inner block, and the untouched remainder.
    let Some(inner_bytes) = extract_title_slices(body.as_bytes()).frontmatter_bytes else {
        let mut out = String::with_capacity(body.len() + display.len() + 16);
        out.push_str("---\nfolder: ");
        out.push_str(&scalar);
        out.push_str("\n---\n\n");
        out.push_str(body);
        return Ok(out);
    };
    let Ok(inner) = std::str::from_utf8(inner_bytes) else {
        return Err(EditRejection::UnsafeFrontmatter);
    };
    let rest = &body["---\n".len() + inner_bytes.len()..];

    let mut rewritten = String::with_capacity(inner.len() + display.len() + 8);
    let mut written = false;
    for line in inner.split_inclusive('\n') {
        // Top-level only, matching `fm_raw_value`'s rule: a `folder:` under a
        // nested mapping is not the field this verb edits, so it is left alone
        // and a new top-level line is authored below.
        if !written && line.trim_end_matches('\n').starts_with("folder:") {
            written = true;
            if !display.is_empty() {
                rewritten.push_str("folder: ");
                rewritten.push_str(&scalar);
                rewritten.push('\n');
            }
            continue;
        }
        rewritten.push_str(line);
    }
    // No `folder:` line: the destination becomes the last inner line, which is
    // the same position `fm_folder` would have found it in. A root destination
    // writes nothing here, and there was no line to remove.
    if !written && !display.is_empty() {
        if !rewritten.is_empty() && !rewritten.ends_with('\n') {
            rewritten.push('\n');
        }
        rewritten.push_str("folder: ");
        rewritten.push_str(&scalar);
        rewritten.push('\n');
    }

    let mut out = String::with_capacity(body.len() + display.len() + 8);
    out.push_str("---\n");
    out.push_str(&rewritten);
    out.push_str(rest);
    Ok(out)
}

/// Apply one proposed edit, whichever shape it is.
///
/// The single entry point the apply path calls, so a new edit kind is one arm
/// here rather than a second call site to keep in step.
pub fn apply_edit(body: &str, edit: &ProposedEdit) -> Result<String, EditRejection> {
    match edit.kind {
        EditKind::Replace => place(body, &edit.anchor, &edit.replacement),
        EditKind::Append => append(body, &edit.replacement),
        EditKind::Move => move_note(body, &edit.replacement),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- the two frontmatter hazards positioning alone does not close ----
    //
    // Both were found by the myne-md/myne#622 review and both are the same
    // question asked at the wrong end: `append` used to reason about its INPUT
    // (is the head empty, does the text open with `---`) when what matters is
    // the RESULT. `apply.rs` already learned this twice, in `edit_moves_note`
    // and `edit_hides_note`, which compare before against after rather than
    // inspecting the replacement.

    /// **The clamp and the app must read the same folder** (myne-md/myne#848).
    ///
    /// The destination is written as a QUOTED YAML scalar. Written raw, a
    /// destination of `Private #x` resolved to `Private #x` in the Rust reader the
    /// clamp uses and to `Private` in js-yaml (an unquoted `#` starts a comment),
    /// so a crafted value walked a note into a folder the user had excluded from
    /// AI, and on the read side let the agent read a note the user excluded.
    ///
    /// This half pins the WRITTEN SHAPE and what `folder_of` (the clamp's own
    /// reader) makes of it. That js-yaml resolves the quoted form to the same
    /// whole value is a guarantee of YAML itself for a double-quoted scalar, and
    /// the JS half of the pair is asserted in
    /// `tests/notes/agentMoveFolderScalar.test.ts`, against the real js-yaml the
    /// app parses with.
    #[test]
    fn a_destination_yaml_would_retype_is_written_quoted() {
        // The shapes an agent filing by date produces: js-yaml resolves these to a
        // number or a Date, `fm_scalar` returns the text, so an unquoted one is a
        // note the app indexes away from the folder the clamp compared.
        for value in [
            "2026",
            "2026-08-16",
            "2026-8-6",
            "1.5",
            ".5",
            "1e3",
            "0x1f",
            "true",
            "null",
            "~",
        ] {
            let out = move_note("body\n", value).expect("the move is legal");
            assert!(
                out.contains(&format!("folder: \"{value}\"")),
                "{value} was written plain: {out}"
            );
            assert_eq!(
                folder_of(&out),
                canonical_folder(value),
                "{value} read back differently"
            );
        }
    }

    #[test]
    fn a_destination_with_an_inner_hash_stays_the_plain_scalar_the_app_writes() {
        // `#` opens a comment only after a space, so quoting `a#b` would be a
        // second answer for the same value, different from the one
        // `dialect/src/surgery.ts::needsYamlQuoting` gives (`tests/notes/agentMoveFolderScalar.test.ts`
        // holds the js-yaml half).
        let out = move_note("body\n", "a#b").expect("the move is legal");
        assert!(out.contains("folder: a#b"), "written as {out}");
        assert_eq!(folder_of(&out), canonical_folder("a#b"));
    }

    #[test]
    fn a_destination_the_clamp_would_trim_is_refused() {
        // Nothing makes these agree: `fm_scalar` trims, js-yaml does not, so the
        // folder the clamp compares is not the folder the app resolves.
        for value in [" Work", "Work ", "  Work  "] {
            assert_eq!(
                move_note("body\n", value),
                Err(EditRejection::UnsafeFrontmatter),
                "{value} was written"
            );
        }
    }

    #[test]
    fn a_destination_with_a_hash_is_written_so_both_readers_agree() {
        let out = move_note("body\n", "Private #x").expect("the move is legal");
        assert!(
            out.contains("folder: \"Private #x\""),
            "the destination was written unquoted: {out}"
        );
        // What the clamp reads, which is now the whole value.
        assert_eq!(
            folder_of(&out),
            canonical_folder("Private #x"),
            "the clamp reads a different folder than the app does"
        );
    }

    #[test]
    fn a_destination_that_cannot_be_written_faithfully_is_refused() {
        // A double quote cannot go inside a double-quoted scalar without
        // escaping, and no folder name needs one.
        assert_eq!(
            move_note("body\n", "Bad \"Name\""),
            Err(EditRejection::UnsafeFrontmatter)
        );
    }

    #[test]
    fn append_to_a_closer_without_a_trailing_newline_keeps_the_frontmatter() {
        // `scan_frontmatter` accepts a closing `---` that ends the file with no
        // newline after it, so the body region is empty AND the head does not
        // end in `\n`. Pushing the text straight after the head glued it onto
        // the closer line, which stops being a closer: the whole block ceases
        // to be frontmatter and `title:`, `folder:`, tags and task fields all
        // become one malformed body line.
        let without_nl = append("---\ntitle: Real Title\n---", "the list").unwrap();
        let with_nl = append("---\ntitle: Real Title\n---\n", "the list").unwrap();
        // The two spellings of the same note are the same note, so they append
        // identically. Asserting convergence rather than a literal is what makes
        // this a property instead of a transcription of today's output.
        assert_eq!(without_nl, with_nl);
        assert!(
            extract_title_slices(without_nl.as_bytes())
                .frontmatter_bytes
                .is_some(),
            "append destroyed the frontmatter block: {without_nl:?}"
        );
    }

    #[test]
    fn append_may_not_turn_existing_body_text_into_frontmatter() {
        // A note with no frontmatter whose body merely BEGINS with `---\n`.
        // Nothing has closed that opener, so appending text containing a `---`
        // line closes it, and the user's own first lines become a frontmatter
        // block that stops rendering. A `---` separator is ordinary in
        // model-written markdown, so this is not an exotic input.
        let before = "---\nmy shopping list\nmilk\n";
        assert!(extract_title_slices(before.as_bytes())
            .frontmatter_bytes
            .is_none());
        assert_eq!(
            append(before, "## Summary\n\n---\n\ndone").unwrap_err(),
            EditRejection::AppendWouldWriteFrontmatter
        );
    }

    #[test]
    fn exactly_one_match_applies() {
        assert_eq!(place("a b c", "b", "B").unwrap(), "a B c");
    }

    #[test]
    fn zero_matches_is_its_own_named_cause() {
        assert_eq!(
            place("a b c", "zzz", "X").unwrap_err(),
            EditRejection::AnchorNotFound
        );
    }

    #[test]
    fn more_than_one_match_is_a_different_named_cause() {
        assert_eq!(
            place("a b a", "a", "X").unwrap_err(),
            EditRejection::AnchorAmbiguous
        );
    }

    /// The overlap case, which `str::match_indices` counts as one.
    ///
    /// `"aa"` occurs twice in `"aaa"` — at 0 and at 1 — so the exactly-once rule
    /// refuses it. The shipped version counted one and placed the replacement at
    /// the first position, which is the silent misapplication this format is the
    /// whole answer to.
    #[test]
    fn an_overlapping_anchor_is_ambiguous_rather_than_placed_at_the_first_one() {
        assert_eq!(
            place("aaa", "aa", "X").unwrap_err(),
            EditRejection::AnchorAmbiguous
        );
        assert_eq!(
            place("abababa", "abab", "X").unwrap_err(),
            EditRejection::AnchorAmbiguous
        );
        // And the non-overlapping neighbour still places, so the fix did not
        // simply make every repeated character ambiguous.
        assert_eq!(place("aa", "aa", "X").unwrap(), "X");
        assert_eq!(place("a-aa-a", "aa", "X").unwrap(), "a-X-a");
    }

    /// Multi-byte input, because the walk is over char boundaries now.
    #[test]
    fn overlap_counting_holds_across_a_multi_byte_body() {
        assert_eq!(place("üü", "üü", "X").unwrap(), "X");
        assert_eq!(
            place("üüü", "üü", "X").unwrap_err(),
            EditRejection::AnchorAmbiguous
        );
        assert_eq!(place("añb", "ñ", "X").unwrap(), "aXb");
    }

    #[test]
    fn an_empty_anchor_is_refused_rather_than_matching_everywhere() {
        assert_eq!(
            place("a b c", "", "X").unwrap_err(),
            EditRejection::AnchorEmpty
        );
        assert_eq!(place("", "", "X").unwrap_err(), EditRejection::AnchorEmpty);
    }

    // The near-miss case, which is the one that decides whether this format is
    // worth anything. One character off must REFUSE, not place.
    #[test]
    fn a_near_miss_anchor_is_refused_not_fuzzily_placed() {
        let body = "The quick brown fox";
        assert_eq!(
            place(body, "The quick browm fox", "X").unwrap_err(),
            EditRejection::AnchorNotFound
        );
        // Whitespace differences are also misses, deliberately.
        assert_eq!(
            place(body, "The  quick brown fox", "X").unwrap_err(),
            EditRejection::AnchorNotFound
        );
        assert_eq!(
            place(body, "the quick brown fox", "X").unwrap_err(),
            EditRejection::AnchorNotFound
        );
    }

    // The sync race, through the ordinary rule and no special path.
    #[test]
    fn an_edit_against_a_body_that_moved_is_refused_by_the_same_rule() {
        let read_by_the_model = "alpha beta gamma";
        let anchor = "beta";
        // Something else rewrote the note between the read and the approval.
        let now_on_disk = "alpha BETA gamma";
        assert!(place(read_by_the_model, anchor, "X").is_ok());
        assert_eq!(
            place(now_on_disk, anchor, "X").unwrap_err(),
            EditRejection::AnchorNotFound
        );
    }

    #[test]
    fn an_empty_replacement_is_a_deletion_and_is_allowed() {
        assert_eq!(place("a b c", " b", "").unwrap(), "a c");
    }

    #[test]
    fn multibyte_anchors_do_not_split_a_character() {
        // A byte-index slice through a multi-byte char would panic; the
        // match_indices boundaries are char-aligned, and this is the test that
        // says so rather than trusting it.
        assert_eq!(place("önce sonra", "önce", "ilk").unwrap(), "ilk sonra");
        assert_eq!(place("a 🙂 b", "🙂", "X").unwrap(), "a X b");
    }

    // ---- append ---------------------------------------------------------

    const FM: &str = "---\ntitle: A\nfolder: Work\n---\n";

    /// The case the whole verb exists for: before it, this was impossible, and
    /// the failure had no message that explained itself.
    #[test]
    fn an_append_into_an_empty_body_writes_the_text() {
        // `{FM}\n` is a frontmatter block followed by the blank line a note
        // carries between it and the body. `body_after_frontmatter` counts that
        // separator as part of the head, so it survives and the text lands
        // directly after it.
        let out = append(&format!("{FM}\n"), "hello").unwrap();
        assert_eq!(out, format!("{FM}\nhello\n"));
    }

    /// And with no separator line at all, which is the tighter shape.
    #[test]
    fn an_append_into_a_note_that_is_only_frontmatter_writes_the_text() {
        let out = append(FM, "hello").unwrap();
        assert_eq!(out, format!("{FM}hello\n"));
    }

    #[test]
    fn an_append_into_an_existing_body_leaves_it_byte_identical() {
        let before = format!("{FM}first paragraph\n");
        let out = append(&before, "second").unwrap();
        assert_eq!(out, format!("{FM}first paragraph\n\nsecond\n"));
        assert!(out.starts_with(&before[..before.len() - 1]));
    }

    /// A missing blank line is not cosmetic in markdown: it makes the appended
    /// text part of the preceding paragraph.
    #[test]
    fn exactly_one_blank_line_separates_the_append_however_the_body_ended() {
        for tail in ["body", "body\n", "body\n\n", "body\n\n\n"] {
            let out = append(&format!("{FM}{tail}"), "next").unwrap();
            assert_eq!(out, format!("{FM}body\n\nnext\n"), "{tail:?}");
        }
    }

    /// The structural half of the frontmatter protection: with a block in
    /// front, appended text cannot be line one whatever it starts with.
    #[test]
    fn an_append_lands_after_the_frontmatter_not_at_the_end_of_the_file() {
        let out = append(&format!("{FM}\n"), "---\nfolder: Secrets\n---").unwrap();
        assert!(
            out.starts_with(FM),
            "the note's own frontmatter must still be the first thing in the file"
        );
        assert!(
            out.contains("---\nfolder: Secrets\n---"),
            "and the model's text is preserved verbatim rather than mangled"
        );
    }

    /// The one case positioning cannot cover, refused rather than mangled.
    #[test]
    fn an_append_that_would_author_frontmatter_in_a_bare_note_is_refused() {
        assert_eq!(
            append("", "---\nfolder: Secrets\n---\n").unwrap_err(),
            EditRejection::AppendWouldWriteFrontmatter
        );
    }

    /// The same text into a bare note that already has a body is fine: it
    /// cannot be line one, so it cannot be frontmatter.
    #[test]
    fn the_same_text_into_a_bare_note_with_a_body_is_allowed() {
        let out = append("existing\n", "---\nnot: frontmatter\n---").unwrap();
        assert!(out.starts_with("existing\n\n---"));
    }

    #[test]
    fn an_empty_append_is_refused_by_its_own_name() {
        for text in ["", "   ", "\n\n"] {
            assert_eq!(
                append("body\n", text).unwrap_err(),
                EditRejection::AppendEmpty,
                "{text:?}"
            );
        }
    }

    #[test]
    fn append_does_not_split_a_multibyte_character() {
        let out = append("önce\n", "sonra 🙂").unwrap();
        assert_eq!(out, "önce\n\nsonra 🙂\n");
    }

    /// The dispatcher routes by kind and nothing else, so a `replace` carrying
    /// an anchor still goes through the anchored rule.
    #[test]
    fn apply_edit_routes_on_the_kind() {
        let replace = ProposedEdit {
            note_id: "n".into(),
            kind: EditKind::Replace,
            anchor: "a".into(),
            replacement: "b".into(),
        };
        assert_eq!(apply_edit("x a y", &replace).unwrap(), "x b y");

        let append_edit = ProposedEdit {
            note_id: "n".into(),
            kind: EditKind::Append,
            anchor: String::new(),
            replacement: "b".into(),
        };
        assert_eq!(apply_edit("x\n", &append_edit).unwrap(), "x\n\nb\n");
    }

    /// A payload written before the verb existed deserializes as the replace it
    /// was, which is what `#[serde(default)]` is there for.
    #[test]
    fn an_edit_without_a_kind_field_deserializes_as_a_replace() {
        let json = r#"{"noteId":"n","anchor":"a","replacement":"b"}"#;
        let edit: ProposedEdit = serde_json::from_str(json).unwrap();
        assert_eq!(edit.kind, EditKind::Replace);
    }

    // ---- move -------------------------------------------------------------
    //
    // The verb's own layer. The clamp that decides WHETHER a move may land lives
    // one layer up in `apply.rs`, because it needs the excluded set; what is
    // pinned here is that the rewrite is exact, that the destination is
    // validated, and that a no-op is refused rather than rewritten.

    const MOVE_FM: &str = "---\ntitle: A\nfolder: Work\n---\n";

    #[test]
    fn a_move_rewrites_the_folder_line_in_place() {
        let out = move_note(&format!("{MOVE_FM}alpha\n"), "Projects").unwrap();
        assert_eq!(out, "---\ntitle: A\nfolder: Projects\n---\nalpha\n");
        assert_eq!(folder_of(&out), canonical_folder("Projects"));
    }

    /// The note has no frontmatter block at all, so the destination has to
    /// author a closed one. Asserted on the folder the result resolves to rather
    /// than on the literal, so the shape is not the claim.
    #[test]
    fn a_move_of_a_bare_note_authors_a_closed_block() {
        let out = move_note("alpha\n", "Projects").unwrap();
        assert_eq!(out, "---\nfolder: Projects\n---\n\nalpha\n");
        assert_eq!(folder_of(&out), canonical_folder("Projects"));
    }

    /// Moving to the root removes the field rather than writing an empty one: an
    /// empty `folder:` line and no line are the same folder, and a second
    /// spelling of one state is a second thing to keep consistent.
    #[test]
    fn a_move_to_the_root_removes_the_field() {
        let out = move_note(&format!("{MOVE_FM}alpha\n"), "").unwrap();
        assert_eq!(out, "---\ntitle: A\n---\nalpha\n");
        assert_eq!(folder_of(&out), "");
    }

    /// Everything that is not the folder line survives byte for byte, including
    /// the rest of the frontmatter and the whole body.
    #[test]
    fn a_move_leaves_every_other_byte_of_the_note_alone() {
        let before = "---\ntitle: A\nfolder: Work\ntags: x\n---\nalpha\n\nbeta\n";
        let out = move_note(before, "Nested/Ideas").unwrap();
        assert_eq!(
            out,
            "---\ntitle: A\nfolder: Nested/Ideas\ntags: x\n---\nalpha\n\nbeta\n"
        );
    }

    /// A reformatting is not a move, in either direction. Refused rather than
    /// applied, because the note's bytes would otherwise change and its sync
    /// version would advance for nothing.
    #[test]
    fn a_move_to_the_folder_it_is_already_in_is_refused() {
        let before = format!("{MOVE_FM}alpha\n");
        for same in ["Work", "Work/", "work", "/Work/", "Work//"] {
            assert_eq!(
                move_note(&before, same).unwrap_err(),
                EditRejection::MoveToSameFolder,
                "{same:?}"
            );
        }
    }

    /// The destination is model-supplied text going into a frontmatter line, so
    /// a newline in it would emit a second field nothing checked.
    #[test]
    fn a_move_destination_carrying_a_newline_is_refused() {
        for hostile in [
            "Work\nfolder: Private",
            "Work\ntrashed: 2026-08-16T10:00:00Z",
            "Work\r\nfolder: Private",
        ] {
            assert_eq!(
                move_note("alpha\n", hostile).unwrap_err(),
                EditRejection::UnsafeFrontmatter,
                "{hostile:?}"
            );
        }
    }

    /// Empty segments are dropped and the case is kept: the canonical form is for
    /// comparison, and storing it would rewrite the user's own folder name.
    #[test]
    fn a_move_normalises_separators_without_lowercasing_the_destination() {
        let out = move_note(&format!("{MOVE_FM}alpha\n"), "/Work//Ideas/").unwrap();
        assert!(out.contains("folder: Work/Ideas\n"), "{out:?}");
        assert_eq!(folder_of(&out), canonical_folder("Work/Ideas"));
    }

    /// A body that merely BEGINS with `---` is not frontmatter, and the block
    /// the move authors is closed, so the user's own line stays body text. This
    /// is the append arm's hazard, closed here by construction.
    #[test]
    fn a_move_of_a_note_whose_body_starts_with_a_fence_keeps_it_as_body() {
        let out = move_note("---\nnot frontmatter\n", "Work").unwrap();
        assert_eq!(folder_of(&out), canonical_folder("Work"));
        assert!(
            out.ends_with("---\n\n---\nnot frontmatter\n"),
            "the original text is still there and still body: {out:?}"
        );
    }

    #[test]
    fn apply_edit_routes_a_move_to_the_move_verb() {
        let move_edit = ProposedEdit {
            note_id: "n".into(),
            kind: EditKind::Move,
            anchor: String::new(),
            replacement: "Elsewhere".into(),
        };
        let out = apply_edit(MOVE_FM, &move_edit).unwrap();
        assert!(out.contains("folder: Elsewhere\n"));
    }
}
