// SPDX-License-Identifier: AGPL-3.0
//! Refusing an agent write that moves a note between folders.
//!
//! The third member of the write-refusal family, beside [`super::edit::place`]
//! (an anchor must match exactly once) and [`super::hide`] (a removal needs its
//! own act). This one covers the field neither of them does: `folder:`.
//!
//! ## What it closes
//!
//! `folder:` is what the `ai_excluded_folders` clamp reads. `apply.rs` slices
//! the frontmatter and calls `fm_folder` on the note as it stands BEFORE the
//! batch, refusing any note that now sits in an excluded folder, and `tools.rs`
//! does the same on the read side. Nothing looked at the folder AFTER an edit.
//!
//! So an anchored edit whose anchor spans the `folder:` line could move a note
//! into an excluded folder, and no control saw it: the clamp had
//! already run, and the removal roster carries five fields of which this is not
//! one. `myne-agents/docs/threat-model.md` TB13 names `ai_excluded_folders` as the
//! content-scoped control on a boundary that carries decrypted note plaintext
//! off the device, and a control a write can relocate its way around is not one.
//!
//! **The "or out of" half of that sentence was wrong, and review measured it.**
//! It read "into or out of an excluded folder". Out of was never reachable:
//! `apply_approved` computes `excluded_note` from each note's CURRENT folder,
//! drops its body, and refuses the edit `ExcludedNow` before `apply_edit` runs,
//! so an agent cannot edit a note that currently sits in an excluded folder and
//! therefore cannot move one out of it. What this lock newly closes is the INTO
//! direction, which lowers future exposure rather than raising it, plus the
//! plainer property that an agent write may not decide which folder a note
//! lives in. The narrower claim is the one this code can defend, and a claim a
//! reviewer can refute in one function is worse than a modest one.
//!
//! The append verb reaches the same hole a second way and more easily: an
//! append into an empty note IS the whole note, so text opening with `---` and
//! a `folder:` line becomes real frontmatter rather than body.
//!
//! ## Why only `folder:`, when frontmatter has other fields
//!
//! Because the others are not security-load-bearing, and refusing them would be
//! a product decision wearing a bug fix's clothes.
//!
//! `title:` is a field the agent legitimately edits: `apply::tests` already
//! pins that an edit rewriting it applies, under both approval labels, and a
//! user asking the agent to retitle a note is an ordinary request. Note
//! properties are user-authored and editable from the Properties block, so the
//! same holds. The five working-set markers have their own rule in
//! [`super::hide`] (refused inside a bulk approval, allowed on their own act),
//! and a blanket frontmatter lock would silently withdraw the agent's ability
//! to archive.
//!
//! A wider lock was written first and reverted for exactly that reason. What
//! survives is the narrow claim this module can actually defend: an agent edit
//! may not decide which folder a note lives in.
//!
//! ## The comparison is on the resolved value
//!
//! `fm_folder` on each side, not a line diff, because reformatting the line is
//! not a move and the question here is where the note ENDS UP. A note whose
//! frontmatter is absent resolves to the empty folder, which is the vault root,
//! so gaining or losing a `folder:` line is a move like any other.

use crate::folder_key::canonical_folder;
use crate::plugins::notes::title_extract::{extract_title_slices, fm_folder};

/// The folder a note body resolves to, canonicalised, empty for the vault root.
///
/// **The one place the agent path reads a note's folder.** The same four lines
/// were written out in `apply.rs` and `tools.rs`, and `apply.rs` carries a
/// comment recording what happened the time they were written wrong: the whole
/// body was passed where a frontmatter BLOCK was expected, `fm_folder` found
/// nothing, and the exclusion clamp silently allowed every edit. That is a
/// failure with no error and no test unless a test is aimed exactly at it, which
/// is the shape worth having one caller for.
///
/// Canonicalised on the way out. `folder_matches_excluded` canonicalises its
/// argument too and `canonical_folder` is idempotent, so the existing callers
/// are unaffected by receiving a canonical value.
pub fn folder_of(body: &str) -> String {
    let raw = extract_title_slices(body.as_bytes())
        .frontmatter_bytes
        .and_then(fm_folder)
        .unwrap_or_default();
    canonical_folder(&raw)
}

/// Whether applying this edit would move the note to a different folder.
///
/// `true` means refuse, under every approval label. See the module doc for why
/// the other frontmatter fields are deliberately not covered.
pub fn edit_moves_note(before: &str, after: &str) -> bool {
    folder_of(before) != folder_of(after)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FM: &str = "---\ntitle: A\nfolder: Work\n---\n";

    #[test]
    fn an_edit_that_only_changes_body_text_is_not_a_move() {
        let before = format!("{FM}alpha beta\n");
        let after = format!("{FM}alpha GAMMA\n");
        assert!(!edit_moves_note(&before, &after));
    }

    #[test]
    fn an_edit_that_rewrites_the_folder_line_is_a_move() {
        let before = format!("{FM}alpha\n");
        let after = "---\ntitle: A\nfolder: Secrets\n---\nalpha\n".to_string();
        assert!(
            edit_moves_note(&before, &after),
            "rewriting folder: relocates the note past the exclusion clamp"
        );
    }

    #[test]
    fn an_edit_that_retitles_the_note_is_not_a_move() {
        let before = format!("{FM}alpha\n");
        let after = "---\ntitle: A2\nfolder: Work\n---\nalpha\n".to_string();
        assert!(
            !edit_moves_note(&before, &after),
            "retitling is a legitimate agent edit and apply::tests already pins it"
        );
    }

    #[test]
    fn adding_a_hiding_marker_is_not_a_move() {
        let before = format!("{FM}alpha\n");
        let after =
            "---\ntitle: A\nfolder: Work\ntrashed: 2026-08-29T00:00:00Z\n---\nalpha\n".to_string();
        assert!(
            !edit_moves_note(&before, &after),
            "hide.rs governs the working-set markers under a different rule"
        );
    }

    #[test]
    fn a_note_that_gains_a_folder_is_a_move() {
        let before = "alpha\n";
        let after = "---\nfolder: Secrets\n---\nalpha\n";
        assert!(
            edit_moves_note(before, after),
            "an append into an empty note must not be able to place it in a folder"
        );
    }

    #[test]
    fn a_note_that_loses_its_folder_is_a_move() {
        let before = format!("{FM}alpha\n");
        let after = "---\ntitle: A\n---\nalpha\n";
        assert!(
            edit_moves_note(&before, after),
            "leaving a folder is a move too: it can take a note OUT of an excluded one"
        );
    }

    #[test]
    fn two_notes_with_no_frontmatter_are_not_a_move() {
        assert!(!edit_moves_note("alpha\n", "alpha beta\n"));
    }

    /// The comparison is on the resolved value, so a reformatting that lands on
    /// the same folder is not a move. This is the direction a line diff would
    /// get wrong, and it matters because a refusal the user cannot explain is
    /// worse than no refusal at all.
    #[test]
    fn reformatting_the_folder_line_onto_the_same_folder_is_not_a_move() {
        let before = format!("{FM}alpha\n");
        let after = "---\ntitle: A\nfolder:   Work\n---\nalpha\n".to_string();
        assert!(!edit_moves_note(&before, &after));
    }
}
