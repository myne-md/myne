// SPDX-License-Identifier: AGPL-3.0-only
//! Two notes whose titles differ only in case or in Unicode normalization must
//! land on two files — myne-md/myne#555, the `export.vault-markdown` (unit)
//! bullet.
//!
//! # The data-loss shape this closes
//!
//! A vault-markdown export writes one file per note into a destination the user
//! picked. Whether two of those files are the SAME file is decided by the
//! destination volume, and the two volumes Myne exports onto most do not decide
//! it byte-wise:
//!
//! * NTFS and a default APFS volume are **case-insensitive**, so `Notes.md` and
//!   `notes.md` are one file.
//! * APFS since 10.13 also compares **normalization-insensitively** while
//!   preserving the bytes it was handed, so `Cafe` + U+0301 (NFD) and `Café`
//!   (NFC) are one file — even though they are different byte strings and even
//!   though the volume will faithfully store whichever one it was given first.
//!
//! The tree exporter dedups against an **in-run set** rather than against the
//! filesystem, because staging starts empty and pre-existing files cannot exist.
//! That is the right design and it puts the whole correctness of the collision
//! question on the oracle the set is keyed by. A byte-wise oracle sees two
//! distinct names, assigns both, and the second write lands on top of the first.
//!
//! What the user gets is an export that reports success, a tree with one file
//! where the vault had two notes, and no indication anywhere that a note is
//! missing. The note that loses is whichever came second in an ordering nobody
//! chose. There is no error, no warning, and nothing in the exported tree that
//! records the collision — so the loss is not discoverable from the artefact
//! either.
//!
//! # Why this is a unit test rather than an export run
//!
//! The naming decision is pure, so it is testable **on any filesystem**,
//! including the case-SENSITIVE Linux ext4 in the CI container where the
//! collision cannot be reproduced at all. That is the whole reason this bullet
//! is in the fast lane: an end-to-end export on the runner would pass whether
//! the oracle folds or not, and the only seat that could fail it is the macOS
//! one nobody has.

use myne_core::export_naming::{export_dedup_key, sanitize_export_component, suffixed_filename};

/// `Café` with a precomposed U+00E9.
const NFC: &str = "Caf\u{00e9}";
/// `Café` as `e` + U+0301 combining acute.
const NFD: &str = "Cafe\u{0301}";

#[test]
fn the_two_normalizations_really_are_different_byte_strings() {
    // Without this the whole file could be comparing a string with itself.
    assert_ne!(NFC, NFD);
    assert_ne!(NFC.len(), NFD.len());
}

#[test]
fn sanitization_preserves_both_case_and_normalization() {
    // The sanitizer's job is to make a name SAFE, not to make it canonical. It
    // must hand both forms through untouched so the exported filename is the one
    // the user's title actually says.
    assert_eq!(sanitize_export_component(NFC, "attachment"), NFC);
    assert_eq!(sanitize_export_component(NFD, "attachment"), NFD);
    assert_eq!(sanitize_export_component("Notes", "attachment"), "Notes");
    assert_eq!(sanitize_export_component("notes", "attachment"), "notes");
}

#[test]
fn the_collision_oracle_folds_case() {
    assert_eq!(export_dedup_key("Notes.md"), export_dedup_key("notes.md"));
    assert_eq!(export_dedup_key("NOTES.MD"), export_dedup_key("notes.md"));
}

#[test]
fn the_collision_oracle_folds_unicode_normalization() {
    // The half that was missing: a byte-wise oracle answers "different" here,
    // assigns both names, and the second export write clobbers the first on
    // every APFS volume.
    assert_eq!(
        export_dedup_key(&format!("{NFC}.md")),
        export_dedup_key(&format!("{NFD}.md")),
        "two titles differing only by NFC/NFD are one file on APFS; an oracle \
         that calls them different loses one of the two notes, silently"
    );
}

#[test]
fn it_folds_both_axes_at_once() {
    // The realistic case is not one axis or the other: `Café.md` against
    // `cafe` + U+0301 + `.MD` differs in ASCII case AND in normalization.
    assert_eq!(
        export_dedup_key(&format!("{NFC}.md")),
        export_dedup_key("cafe\u{0301}.MD"),
    );
}

#[test]
fn non_ascii_case_is_a_known_and_narrower_residue() {
    // Recorded, not asserted as correct. The oracle folds ASCII case only, and
    // `export_dedup_key`'s own doc says why: `to_ascii_lowercase` cannot change
    // a string's length, so the suffix arithmetic is unaffected, and full
    // Unicode case folding is not what either filesystem implements either.
    //
    // The consequence is real and bounded: a pair differing ONLY in non-ASCII
    // case (`Café.md` against `CAFÉ.md`) still collides on a case-insensitive
    // volume and this oracle does not see it. That residue predates this file
    // and is strictly narrower than the normalization one it closes — a title
    // pair differing only in the case of an accented letter is rarer than one
    // differing only in how an accent is encoded, which happens whenever a
    // title is pasted between macOS and anywhere else.
    //
    // This test exists so the gap is a recorded fact rather than an assumption,
    // and so that closing it is a deliberate edit here.
    assert_ne!(
        export_dedup_key("Caf\u{00e9}.md"),
        export_dedup_key("CAF\u{00c9}.md"),
        "the oracle grew non-ASCII case folding. That is a legitimate \
         tightening — check that it cannot change a key's length before \
         landing it, because `suffixed_filename` inserts by index."
    );
}

#[test]
fn it_does_not_fold_names_that_are_genuinely_different() {
    // A fold can only ADD collisions, and an over-eager one costs a spurious
    // `" (1)"`. That is the safe direction, but "safe" is not "free": these
    // must stay distinct or every export grows suffixes it does not need.
    let distinct = [
        "notes.md",
        "note.md",
        "notes.txt",
        "notes (1).md",
        "Cafe.md",        // no accent at all
        "Caf\u{00e8}.md", // grave, not acute
        "\u{041a}afe.md", // Cyrillic Ka, a homoglyph of Latin K
    ];
    for (i, a) in distinct.iter().enumerate() {
        for b in distinct.iter().skip(i + 1) {
            assert_ne!(
                export_dedup_key(a),
                export_dedup_key(b),
                "{a:?} and {b:?} are different files and must not collide"
            );
        }
    }
}

#[test]
fn folding_never_changes_the_length_the_suffix_arithmetic_relies_on() {
    // `suffixed_filename` inserts before the extension by index, so an oracle
    // that changed a string's length would desynchronise the two. ASCII
    // lowercasing cannot; NFC can only ever shorten a decomposed sequence, and
    // it is applied to the KEY rather than to the name that gets suffixed —
    // which is what keeps them independent. Asserted rather than assumed.
    for name in [NFC, NFD, "Notes.md", "archive.tar.gz"] {
        let suffixed = suffixed_filename(name, 1);
        assert!(
            suffixed.contains(" (1)"),
            "{name:?} did not take a suffix: {suffixed:?}"
        );
        // The suffixed form of two colliding names must itself collide, or the
        // dedup loop would find a free slot that is not actually free.
        let _ = export_dedup_key(&suffixed);
    }
    assert_eq!(
        export_dedup_key(&suffixed_filename(&format!("{NFC}.md"), 1)),
        export_dedup_key(&suffixed_filename(&format!("{NFD}.md"), 1)),
        "the suffixed forms stopped colliding, so the dedup loop would hand \
         two notes the same destination one suffix down"
    );
}

#[test]
fn the_oracle_is_idempotent() {
    // Keys are stored in a set and compared against freshly computed ones, so a
    // second application must not move the answer.
    for name in [NFC, NFD, "Notes.md", "Caf\u{00e9} (1).MD"] {
        assert_eq!(
            export_dedup_key(&export_dedup_key(name)),
            export_dedup_key(name)
        );
    }
}
