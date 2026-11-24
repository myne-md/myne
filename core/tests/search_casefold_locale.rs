// SPDX-License-Identifier: AGPL-3.0-only
//! Search casefolding does not move with the machine's locale — myne-md/myne#555,
//! the `search.command-palette` bullet.
//!
//! # The walk this retires
//!
//! The roster row asked a person to set the machine's locale to Turkish, search
//! for a word containing `I` or `i`, and check that the result set was the same
//! as on an English machine. That is a reboot, once a release, on a machine
//! somebody has to reconfigure — and the answer is decided by three pure
//! functions that take no locale at all.
//!
//! # Why "the language guarantees it" is not enough on its own
//!
//! Rust's `str::to_lowercase` is defined by Unicode's `Lowercase_Mapping`, with
//! no locale input, which is exactly the property C's `tolower`, C++'s
//! `std::tolower`, JavaScript's `toLocaleLowerCase` and every ICU collator do
//! NOT have. So the claim is true today because of which primitive was chosen,
//! not because of anything the search module asserts.
//!
//! That makes it worth a test rather than a comment: a future change to a
//! locale-aware primitive — an ICU collator for better sorting, a
//! `to_lowercase` swapped for something "more correct for Turkish" — compiles
//! cleanly, passes every existing test, and silently makes a user's result set a
//! function of their OS settings. Every other test of these functions runs under
//! one locale and cannot see it.
//!
//! # What is asserted
//!
//! The environment is mutated in-process (`LANG`, `LC_ALL`, `LC_CTYPE`) and each
//! function is re-run. That is the same lever a reboot into a Turkish locale
//! pulls, minus the reboot, and it fails the moment anything on this path starts
//! reading it.
//!
//! The Turkish locale is the interesting one and not an arbitrary choice: it is
//! the only widely-used locale whose case mapping DISAGREES with the default
//! one, on the letter `i`. Under a Turkish tailoring `"I".to_lowercase()` is
//! `"ı"` (dotless) rather than `"i"`, so a locale-sensitive implementation would
//! give a Turkish user a different index and a different result set for the same
//! query. `turkish_lower` exists to do that DELIBERATELY, per token, on the
//! Turkish stemming path — chosen by the detected language of the text, never by
//! the host.
//!
//! # How this was verified, and what verifying it turned up
//!
//! `default_lower` was temporarily made to consult `LANG` and switch to the
//! Turkish mapping when it said `tr`. `default_lower_is_the_same_under_every_locale`
//! failed by name, reporting `"ı"` under `tr_TR.UTF-8` against `"i"` under `C`.
//!
//! `the_two_mappings_genuinely_disagree_…` failed as well, which was worth
//! chasing rather than waving off: the machine this was written on runs
//! `LANG=tr_TR.UTF-8` for real, so under the injected implementation the two
//! mappings genuinely stopped disagreeing there, ambient environment and all.
//! That is the roster row's own scenario — a Turkish-locale machine — arriving
//! without anyone configuring it, and the suite passing on it unmodified is a
//! second piece of evidence the walk was asking for.

use myne_core::text::{default_lower, fold_diacritics, turkish_lower};

/// Every locale that could plausibly change a case mapping, plus the empty
/// case. `tr_TR` is the one that matters; the rest are controls.
const LOCALES: &[&str] = &[
    "C",
    "en_US.UTF-8",
    "tr_TR.UTF-8",
    "az_AZ.UTF-8", // the other dotted/dotless-i locale
    "lt_LT.UTF-8", // Lithuanian tailors `i` too, in the other direction
    "de_DE.UTF-8",
];

/// The process environment is GLOBAL and these tests run on parallel threads,
/// so every function here that touches it takes this lock first. Otherwise one
/// test's `tr_TR` is visible inside another test's call for the length of the
/// walk below, and the failure that produces is a fact about this file rather
/// than about the implementation.
///
/// Poisoning is recovered from rather than propagated: the restore walk below
/// puts the environment back on every path, so a panicking test leaves nothing
/// for a poisoned flag to protect.
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn lock_env() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Run `f` under each locale and return the answers, one per locale.
fn under_each_locale(input: &str, f: fn(&str) -> String) -> Vec<(&'static str, String)> {
    let _guard = lock_env();
    let saved = ["LANG", "LC_ALL", "LC_CTYPE"].map(|k| (k, std::env::var(k).ok()));
    let mut out = Vec::new();
    for locale in LOCALES {
        // SAFETY-of-intent note rather than a compiler one: these tests run in
        // their own process and restore the environment below. The mutation is
        // the point — it is the lever a reboot into another locale pulls.
        for key in ["LANG", "LC_ALL", "LC_CTYPE"] {
            std::env::set_var(key, locale);
        }
        out.push((*locale, f(input)));
    }
    for (key, value) in saved {
        match value {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
    }
    out
}

/// Assert `f` gives the same answer under every locale, and say which two
/// disagreed when it does not.
fn assert_locale_invariant(input: &str, f: fn(&str) -> String, what: &str) {
    let answers = under_each_locale(input, f);
    let (first_locale, first) = &answers[0];
    for (locale, answer) in &answers[1..] {
        assert_eq!(
            answer, first,
            "{what}({input:?}) answered {answer:?} under {locale} and {first:?} \
             under {first_locale}. The search index and the query would then \
             disagree between two users of the same vault, and a user's result \
             set would be a function of their OS settings."
        );
    }
}

#[test]
fn default_lower_is_the_same_under_every_locale() {
    // `I` is the whole question: a Turkish tailoring lowercases it to `ı`.
    for input in ["I", "İ", "ISTANBUL", "Izmir", "IIII", "Ii", "RUST", "Açık"] {
        assert_locale_invariant(input, default_lower, "default_lower");
    }
}

#[test]
fn turkish_lower_is_the_same_under_every_locale_too() {
    // It applies a Turkish mapping BY CODE, on the Turkish stemming path, chosen
    // by the detected language of the text. That must not additionally depend on
    // the host: a Turkish note indexed on an English machine and searched on a
    // Turkish one has to match.
    for input in ["I", "İ", "KİTAP", "ISIRGAN", "Iğdır"] {
        assert_locale_invariant(input, turkish_lower, "turkish_lower");
    }
}

#[test]
fn fold_diacritics_is_the_same_under_every_locale() {
    for input in ["İSTANBUL", "ISTANBUL", "ıspanak", "şirket", "dağ", "Ürgüp"] {
        assert_locale_invariant(input, fold_diacritics, "fold_diacritics");
    }
}

#[test]
fn the_two_mappings_genuinely_disagree_so_the_invariance_above_is_not_vacuous() {
    // If `default_lower` and `turkish_lower` answered alike, every assertion
    // above would hold trivially and this file would be measuring nothing. They
    // differ on exactly the letter the locale question is about.
    //
    // Under the lock even though it sets nothing: it READS whatever these
    // functions make of the ambient locale, so it has to run while no sibling
    // test is holding the environment at `tr_TR`.
    let _guard = lock_env();
    assert_ne!(
        default_lower("I"),
        turkish_lower("I"),
        "the two case mappings no longer disagree on `I`, so nothing here \
         distinguishes a locale-sensitive implementation from a locale-free one"
    );
    assert_eq!(default_lower("I"), "i");
    assert_eq!(turkish_lower("I"), "ı");
}

#[test]
fn the_dotted_and_dotless_family_converges_under_folding_whatever_the_locale() {
    // The result-set claim the roster row was really making: a query typed with
    // any member of the `I` family reaches the same index entry, and it does so
    // identically on every machine.
    for locale_run in under_each_locale("İzmir", fold_diacritics) {
        assert_eq!(locale_run.1, "izmir", "under {}", locale_run.0);
    }
    for locale_run in under_each_locale("IZMIR", fold_diacritics) {
        assert_eq!(locale_run.1, "izmir", "under {}", locale_run.0);
    }
    for locale_run in under_each_locale("ızmır", fold_diacritics) {
        assert_eq!(locale_run.1, "izmir", "under {}", locale_run.0);
    }
}
