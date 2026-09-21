// SPDX-License-Identifier: AGPL-3.0
//! Adversarial corpus for the custom-theme value allowlist — myne-md/myne#557,
//! the `settings.block.custom-themes` bullet.
//!
//! # Why this replaces four hand walks with one file
//!
//! The refusal decision is made by ONE crate. The desktop themes plugin, the
//! mobile client and the `myne-themes` marketplace CI all compile this exact
//! code, so what it refuses is what every surface refuses — by construction, not
//! by four people each trying a hostile theme once a release and reporting that
//! nothing looked wrong. And "nothing looked wrong" is the weakest possible
//! observation on this surface: the production WebView CSP carries
//! `style-src 'self' 'unsafe-inline'`, so a value that reaches the DOM
//! **executes**, and a successful injection is not something a reviewer sees.
//! This scanner is the PRIMARY security control (`docs/threat-model.md`
//! "Custom-theme CSS-value surface"), not CSP.
//!
//! # What an adversarial corpus adds over the module's own tests
//!
//! `src/value.rs` already carries an accept list and a reject list, and they are
//! good. This file is deliberately BROADER along the axes an allowlist is
//! attacked on rather than the ones it was written against:
//!
//! * **every escape alphabet**, not one example each — CSS `\` escapes in hex
//!   and identifier form, HTML entities, percent-encoding, unicode escapes;
//! * **the `$` family**, which `AGENTS.md` records as a live foot-gun: a
//!   `String.replace` replacement STRING expands `$1`, `$&`, `` $` `` and `$$`,
//!   so a value filtered clean of quotes can still expand to a captured group
//!   whose own quote closes the attribute it is interpolated into. That is not
//!   hypothetical — `myne-themes/tools/render-preview.mjs` carries the worked
//!   example. The allowlist must reject `$` outright, and this pins it.
//! * **whitespace and separator smuggling** — NBSP, U+2028/U+2029, tab,
//!   form-feed, vertical tab, and a NUL byte;
//! * **structural break-out** — every combination of `;`, `}`, `{`, `:`, `/*`,
//!   `*/`, and a newline placed before, inside and after an otherwise-valid
//!   value;
//! * **the accept side**, swept over every grammar the module documents, so a
//!   tightening that broke real themes fails here rather than in the
//!   marketplace.
//!
//! # One measured behaviour recorded rather than changed
//!
//! `is_number_unit` and `is_color_function` place NO upper bound on length,
//! while `is_bare_keyword` caps at 24 and `is_allowed_key` at 64 — both with an
//! explicit "narrow enough to admit every real theme, nothing wider" rationale.
//! So a value of one million digits validates, is sealed into the `MYT1` blob,
//! syncs to every device and is written into the DOM. That is a resource
//! question rather than an injection one, and tightening it would REJECT values
//! that already validate — which can reject an already-published marketplace
//! theme. So the behaviour is recorded here with the argument attached, and the
//! grammar is left alone: changing it is a decision with a compatibility cost,
//! not a test edit.

use theme_validator::{is_allowed_value, validate_theme, ThemeErrorKind, REQUIRED_KEYS};

/// A complete minimal-core theme whose every required token is `value`.
fn core_with(value: &str) -> String {
    let mut s = String::from("{\n");
    for (i, key) in REQUIRED_KEYS.iter().enumerate() {
        let comma = if i + 1 < REQUIRED_KEYS.len() { "," } else { "" };
        // The value is embedded raw: the point is to hand the validator the
        // bytes an attacker would, so anything needing JSON escaping is built
        // through `serde_json` by the caller instead.
        s.push_str(&format!("  \"{key}\": \"{value}\"{comma}\n"));
    }
    s.push('}');
    s
}

// ── 1. Everything the allowlist must refuse ─────────────────────────────────

/// Every hostile value, grouped by the class it belongs to so a failure names
/// the class rather than only the string.
fn hostile_corpus() -> Vec<(&'static str, &'static str)> {
    vec![
        // ── functional values and schemes ──
        ("url", "url(evil.png)"),
        ("url quoted", "url('evil.png')"),
        ("url double-quoted", "url(\"evil.png\")"),
        ("url spaced", "url ( evil.png )"),
        ("url uppercase", "URL(evil.png)"),
        ("url mixed case", "UrL(evil.png)"),
        ("image-set", "image-set('a.png' 1x)"),
        ("cross-fade", "cross-fade(url(a), url(b))"),
        ("element", "element(#x)"),
        ("expression", "expression(alert(1))"),
        ("expression uppercase", "EXPRESSION(alert(1))"),
        ("javascript scheme", "javascript:alert(1)"),
        ("data scheme", "data:text/html,<script>"),
        ("vbscript scheme", "vbscript:msgbox(1)"),
        ("import", "@import url(x)"),
        ("import bare", "@import \"x\""),
        ("attr", "attr(data-x)"),
        ("var", "var(--x)"),
        ("var with fallback", "var(--x, red)"),
        ("env", "env(safe-area-inset-top)"),
        ("calc", "calc(1px + 2px)"),
        ("min", "min(1px, 2px)"),
        ("clamp", "clamp(1px, 2px, 3px)"),
        ("gradient", "linear-gradient(red, blue)"),
        ("counter", "counter(x)"),
        // ── the `$` family (AGENTS.md's replacement-string foot-gun) ──
        ("dollar group", "$1"),
        ("dollar group with payload", "$1 onload=alert(1)"),
        ("dollar ampersand", "$&"),
        ("dollar backtick", "$`"),
        ("dollar apostrophe", "$'"),
        ("dollar dollar", "$$"),
        ("dollar named group", "$<name>"),
        ("dollar inside a colour", "rgb($1,0,0)"),
        ("dollar after a hex", "#fff$1"),
        // ── structural break-out ──
        ("semicolon", "red; color: blue"),
        ("semicolon then import", "red; @import \"x\""),
        ("close brace", "#fff;}"),
        ("close brace bare", "red}"),
        ("open brace", "red{"),
        ("brace pair", "red}body{background:red"),
        ("colon", "red: blue"),
        ("trailing injection after a colour function", "rgb(0,0,0);x"),
        ("unclosed colour function", "rgb(0,0,0"),
        ("nested function in a colour body", "rgb(0,0,url(x))"),
        ("double close", "rgb(0,0,0))"),
        ("leading paren", "(red)"),
        ("angle bracket", "red<script>"),
        ("html comment open", "red<!--"),
        // ── comment escapes ──
        ("comment before", "/* */red"),
        ("comment after", "red/**/"),
        ("comment inside", "re/**/d"),
        ("comment unterminated", "red/*"),
        ("comment close only", "red*/"),
        // ── escape alphabets ──
        ("css hex escape for u", "\\75rl(x)"),
        ("css hex escape padded", "\\000075rl(x)"),
        ("css ident escape", "\\u\\r\\l(x)"),
        ("css escape of a quote", "red\\\""),
        ("css escape of a semicolon", "red\\;"),
        ("backslash alone", "\\"),
        ("percent encoding", "%75rl(x)"),
        ("html entity", "&#117;rl(x)"),
        ("html entity named", "&lt;script&gt;"),
        ("unicode escape", "\\u0075rl(x)"),
        // ── quotes ──
        ("double quote", "\"red\""),
        ("single quote", "'red'"),
        ("stray double quote", "red\""),
        ("stray single quote", "red'"),
        ("attribute break-out", "red\" onload=\"alert(1)"),
        // ── whitespace and separator smuggling ──
        ("newline", "red\ncolor:blue"),
        ("carriage return", "red\rcolor:blue"),
        ("form feed", "red\u{000c}color:blue"),
        ("vertical tab", "red\u{000b}color:blue"),
        ("nul byte", "red\u{0000}"),
        ("nbsp inside", "re\u{00a0}d"),
        ("line separator inside", "re\u{2028}d"),
        ("paragraph separator inside", "re\u{2029}d"),
        ("zero width space inside", "re\u{200b}d"),
        ("rtl override", "red\u{202e}"),
        // ── near-miss shapes the grammar must still refuse ──
        ("hex with non-hex digits", "#ffggff"),
        ("hex wrong length 5", "#12345"),
        ("hex wrong length 7", "#1234567"),
        ("hex wrong length 9", "#123456789"),
        ("hex empty", "#"),
        ("hash only twice", "##fff"),
        ("colour function with letters in the body", "rgb(red,0,0)"),
        ("colour function empty body", "rgb()"),
        ("keyword too long", "abcdefghijklmnopqrstuvwxyz"),
        ("keyword with a digit", "red1"),
        ("keyword with a hyphen", "current-color"),
        ("keyword with an underscore", "current_color"),
        ("number with two dots", "1.2.3"),
        // Five letters. `12pxxx` is FOUR and is accepted, which is correct: the
        // unit bound is 1..=4 and `pxxx` renders as nothing rather than as
        // anything. Writing the near-miss at five is what makes this case test
        // the bound instead of restating it.
        ("number with an over-long unit", "12pxxxx"),
        ("number with a unit and a paren", "12px)"),
        ("bare sign", "-"),
        ("empty", ""),
        ("whitespace only", "   "),
        ("tab only", "\t"),
    ]
}

#[test]
fn every_hostile_value_is_refused() {
    for (class, value) in hostile_corpus() {
        assert!(
            !is_allowed_value(value),
            "the allowlist ACCEPTED a {class} value: {value:?}. \
             The production CSP carries `style-src 'unsafe-inline'`, so a value \
             that reaches the DOM executes and this scanner is the primary \
             control (threat-model, \"Custom-theme CSS-value surface\")."
        );
    }
}

#[test]
fn the_corpus_is_not_empty_and_covers_every_class_it_claims() {
    // A corpus that silently shrank to nothing would pass the test above
    // forever. Both the count and the class coverage are pinned.
    let corpus = hostile_corpus();
    assert!(corpus.len() >= 80, "the corpus shrank to {}", corpus.len());
    for needle in [
        "url",
        "expression",
        "javascript",
        "dollar",
        "semicolon",
        "comment",
        "escape",
        "quote",
        "newline",
        "hex",
    ] {
        assert!(
            corpus.iter().any(|(class, _)| class.contains(needle)),
            "the corpus no longer covers the {needle:?} class"
        );
    }
}

#[test]
fn a_hostile_value_is_refused_through_the_whole_document_path_too() {
    // `is_allowed_value` is the unit; `validate_theme` is what the callers
    // actually run. A grammar that refuses a token in isolation and a document
    // pass that never reaches it would be the worst of both.
    for (class, value) in hostile_corpus() {
        // Values JSON itself cannot carry raw — a quote, a backslash, or any
        // control character — are refused one layer earlier, by the parser.
        // That is an equally good refusal and it is asserted separately below;
        // what this test is about is the GRAMMAR's refusal, so those cases are
        // routed there rather than skipped silently.
        if value.contains('"') || value.contains('\\') || value.chars().any(|c| c.is_control()) {
            let err = validate_theme(&core_with(value)).unwrap_err_or_else_msg(class, value);
            assert!(
                matches!(
                    err.kind,
                    ThemeErrorKind::ParseError | ThemeErrorKind::InvalidValue
                ),
                "a {class} value ({value:?}) was refused as {:?}, which is \
                 neither a parse refusal nor a value refusal",
                err.kind
            );
            continue;
        }
        let err = validate_theme(&core_with(value)).unwrap_err_or_else_msg(class, value);
        assert!(
            matches!(err.kind, ThemeErrorKind::InvalidValue),
            "a {class} value ({value:?}) was refused as {:?} rather than as an invalid value",
            err.kind
        );
    }
}

/// `expect_err` with the corpus class in the message.
trait ExpectErrNamed<T, E> {
    fn unwrap_err_or_else_msg(self, class: &str, value: &str) -> E;
}

impl<T, E> ExpectErrNamed<T, E> for Result<T, E> {
    fn unwrap_err_or_else_msg(self, class: &str, value: &str) -> E {
        match self {
            Ok(_) => panic!("a {class} value validated as a whole theme: {value:?}"),
            Err(e) => e,
        }
    }
}

#[test]
fn an_interior_control_character_is_refused_by_the_grammar() {
    // A control character with content on BOTH sides cannot be trimmed away, so
    // it reaches the grammar and is refused there. That is the case that
    // matters, because it is the shape a break-out attempt has.
    for raw in [
        "\u{0000}", "\u{000b}", "\u{000c}", "\n", "\r", "\t", "\u{0085}",
    ] {
        let escaped = serde_json::to_string(&format!("red{raw}blue")).expect("json-encodes");
        let json = core_with("#101010").replace(
            "\"--accent\": \"#101010\"",
            &format!("\"--accent\": {escaped}"),
        );
        let err = validate_theme(&json).expect_err("an interior control char must be refused");
        assert!(
            matches!(err.kind, ThemeErrorKind::InvalidValue),
            "an interior control character ({raw:?}) was refused as {:?}",
            err.kind
        );
    }
}

/// **RECORDED BEHAVIOUR, not an assertion that it is right.**
///
/// `is_allowed_value` validates `value.trim()`, and Rust's `str::trim` strips
/// the whole Unicode `White_Space` property: U+0009..U+000D, U+0085, U+00A0,
/// U+1680, U+2000..U+200A, U+2028, U+2029, U+202F, U+205F, U+3000. The value
/// that is STORED, synced and handed to the sink is the untrimmed original. So
/// the crate validates one string and stores a different one, and the
/// difference is leading or trailing whitespace from a much wider set than
/// CSS's own.
///
/// **This is not an injection on any current sink, and that is why it is
/// recorded rather than changed.** The desktop and mobile sink is
/// `root.style.setProperty(key, value)` — the CSSOM parses the value itself and
/// cannot be made to accept a second declaration, so a value it cannot parse is
/// simply dropped. Of the stripped set, `;` and `}` are not members, so nothing
/// that terminates a declaration can ride in this way. The marketplace preview
/// renderer is the other sink and interpolates textually; `AGENTS.md` records
/// that it was already moved to a replacer function for the related `$1`
/// foot-gun.
///
/// It is still worth pinning, for one reason: **validate what you store.** The
/// day a sink changes — a `style` attribute, a `<style>` block built from a
/// template literal — the gap between the validated string and the stored one
/// is where an injection appears, and nothing else in the tree would notice.
/// Closing it means storing the trimmed value, which rejects nothing that
/// validates today; that is a change to a crate whose grammar is normative for
/// the `myne-themes` marketplace CI, so it is a decision rather than a test
/// edit.
#[test]
fn trailing_unicode_whitespace_is_trimmed_for_validation_and_kept_in_the_store() {
    for ws in [
        "\u{0009}", "\u{000a}", "\u{000b}", "\u{000c}", "\u{000d}", "\u{0020}", "\u{0085}",
        "\u{00a0}", "\u{2028}", "\u{2029}", "\u{3000}",
    ] {
        let padded = format!("red{ws}");
        assert!(
            is_allowed_value(&padded),
            "the trim narrowed: {ws:?} is no longer stripped before validation. \
             That is a legitimate tightening — update this test and say so."
        );

        let escaped = serde_json::to_string(&padded).expect("json-encodes");
        let json = core_with("#101010").replace(
            "\"--accent\": \"#101010\"",
            &format!("\"--accent\": {escaped}"),
        );
        let parsed = validate_theme(&json).expect("a padded keyword validates");
        assert_eq!(
            parsed.vars.get("--accent").map(String::as_str),
            Some(padded.as_str()),
            "the stored value is now the trimmed one, which closes the \
             validate-vs-store gap this test records. Delete the test and note \
             the change."
        );
    }

    // The characters that could actually terminate a declaration are NOT in the
    // trimmed set, which is the reason the gap is not exploitable today.
    for terminator in [";", "}", "{", ":", ")"] {
        assert!(
            !is_allowed_value(&format!("red{terminator}")),
            "a declaration terminator ({terminator:?}) became trimmable, which \
             turns the recorded gap above into a live injection"
        );
    }
}

#[test]
fn one_hostile_token_poisons_the_whole_theme() {
    // The realistic shape: twenty-one honest tokens and one hostile one. A
    // validator that stopped at the first token, or that reported the first
    // token's name, would let this through or misname it.
    let mut s = core_with("#101010");
    s = s.replace(
        "\"--warning-soft\": \"#101010\"",
        "\"--warning-soft\": \"$1 onload=alert(1)\"",
    );
    let err = validate_theme(&s).expect_err("one poisoned token must reject the theme");
    assert_eq!(err.kind, ThemeErrorKind::InvalidValue);
    assert_eq!(
        err.key.as_deref(),
        Some("--warning-soft"),
        "the error must name the offending token, not the first one"
    );
}

// ── 2. Everything the allowlist must keep accepting ─────────────────────────

#[test]
fn every_documented_shape_still_validates() {
    // The other direction. A tightening that made the corpus above pass by
    // refusing everything would be caught here rather than by a theme author.
    let ok = [
        // hex, all four lengths, both cases
        "#fff",
        "#FFF",
        "#ffff",
        "#a1b2c3",
        "#A1B2C3",
        "#a1b2c3d4",
        // colour functions, comma and space separated, both cases
        "rgb(12, 34, 56)",
        "rgb(12 34 56)",
        "RGB(12,34,56)",
        "rgba(0,0,0,0.5)",
        "rgba(0 0 0 / 50%)",
        "hsl(210, 50%, 40%)",
        "hsla(210 50% 40% / 0.5)",
        // bare keywords
        "red",
        "transparent",
        "currentColor",
        "inherit",
        "none",
        // numbers with and without units
        "0",
        "1",
        "12px",
        "0.5rem",
        "100%",
        "-2em",
        "+3",
        ".5",
        "1.5vh",
    ];
    for v in ok {
        assert!(
            is_allowed_value(v),
            "the allowlist REFUSED a valid value: {v:?}"
        );
    }
}

#[test]
fn surrounding_whitespace_is_tolerated_but_interior_whitespace_is_not() {
    // The trim is deliberate (a hand-written JSON file gets stray spaces) and
    // it must not become a smuggling channel: trimming the ENDS is safe, and
    // anything in the middle has to survive the grammar on its own.
    assert!(is_allowed_value("  #fff  "));
    assert!(is_allowed_value("\t#fff\n"));
    assert!(!is_allowed_value("#f ff"));
    assert!(!is_allowed_value("re d"));
}

// ── 3. The unbounded-length behaviour, recorded ─────────────────────────────

#[test]
fn a_very_long_numeric_value_is_currently_accepted() {
    // RECORDED, NOT ASSERTED-AS-CORRECT. See this file's header: the numeric and
    // colour-function grammars carry no length bound while the keyword grammar
    // caps at 24 and the key grammar at 64, both with an explicit "narrow enough
    // to admit every real theme" rationale. A million-digit value therefore
    // validates, seals into the MYT1 blob, syncs to every device and is written
    // into the DOM.
    //
    // It is not an injection: the value is all digits, so it can form no
    // functional value, no scheme and no break-out. It is a resource question,
    // and closing it would REJECT values that validate today — which can reject
    // an already-published marketplace theme, so it is a compatibility decision
    // rather than a test edit.
    //
    // This test exists so the behaviour is a recorded fact rather than an
    // assumption, and so that TIGHTENING it is a deliberate edit here.
    let long_number = "1".repeat(100_000);
    assert!(
        is_allowed_value(&long_number),
        "the numeric grammar grew a length bound. That is a legitimate change \
         and probably the right one — update this test and say so, and check \
         whether any published myne-themes palette carries a value past the new \
         bound before landing it."
    );

    let long_body = format!("rgb({})", "1".repeat(100_000));
    assert!(
        is_allowed_value(&long_body),
        "the colour-function grammar grew a length bound — same note as above."
    );

    // The two grammars that DO carry a bound still do, in both directions.
    assert!(is_allowed_value(&"a".repeat(24)));
    assert!(!is_allowed_value(&"a".repeat(25)));
}

// ── 4. The refusal is a value refusal, not a JSON accident ──────────────────

#[test]
fn a_non_string_value_is_refused_before_the_grammar_sees_it() {
    // A number, an object and an array are all valid JSON and none of them is a
    // theme value. Refusing them at the parse pass keeps the grammar's input
    // type honest — otherwise `is_allowed_value` would be reasoning about a
    // stringified something.
    for raw in ["123", "true", "null", "{}", "[]"] {
        let json = format!("{{ \"--paper\": {raw} }}");
        assert!(
            validate_theme(&json).is_err(),
            "a non-string value ({raw}) was not refused"
        );
    }
}

#[test]
fn a_hostile_token_name_is_refused_even_beside_an_honest_value() {
    // The key half is exactly as untrusted as the value half and gets its own
    // allowlist. A safe value must not launder an unsafe token name.
    for key in [
        "--accent;}",
        "--accent:red",
        "--accent/*",
        "--accent url(x)",
        "--accent\\;",
        "--acc€nt",
        "-accent",
        "accent",
        "--",
    ] {
        let mut s = core_with("#101010");
        s.pop();
        s.push_str(&format!(",\n  \"{key}\": \"#101010\"\n}}"));
        assert!(
            validate_theme(&s).is_err(),
            "a malformed token name was accepted: {key:?}"
        );
    }
}
