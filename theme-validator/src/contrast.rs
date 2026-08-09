// SPDX-License-Identifier: AGPL-3.0
//! WCAG contrast gate — the readability check the value allowlist **cannot** do
//! (deep-customization, myne#394 task 4).
//!
//! The allowlist accepts any well-formed colour, including `--ink-1` equal to
//! `--paper`. That palette is perfectly safe and completely unreadable, which is
//! a different failure needing a different control. This module is that control.
//!
//! **One implementation, two consumers.** These five rules previously lived in
//! `myne-themes/tools/lint-theme.mjs` and gated only *published* themes, while a
//! self-authored one was unchecked. The design session (`decisions.md`
//! 2026-08-06 clause (e)) made the gate universal and moved it here, because a
//! lint that disagrees with the app produces the worst possible outcome — a
//! theme that passes CI and is then refused on install. Both sides now run this
//! code: the app through the themes plugin's import path, the marketplace
//! through the `validate` binary.
//!
//! **Refuse, do not repair.** An earlier design accepted any palette and
//! guaranteed an escape hatch. Refusing at the moment of import is simpler and
//! strictly stronger: nothing can brick, so nothing needs escaping, and the
//! author is standing right there to be told which pair failed and by how much.
//!
//! **What this gate cannot see: the ornament layer.** A ratio is computed over a
//! colour pair. A texture or ruled ground rendered behind text can bury it while
//! every pair still passes. That gap is NARROWED structurally elsewhere: the
//! primitives that render as a FIELD under the writing — `texture`, `ruled`, and
//! the tint wash — carry an opacity ceiling in Myne's own stylesheet which a
//! theme cannot exceed. The EDGE decorations (`ribbon`, `perforation`, `edge`,
//! `fold`) are deliberately opaque and are bounded by geometry instead: they sit
//! at the box's edge rather than as a field beneath its text. So the gap is
//! narrowed rather than eliminated, and it is narrowed in one specific way. Do
//! not read a passing contrast check as "this theme is readable"; read it as
//! "its colours are".

use std::collections::BTreeMap;

use crate::error::ThemeError;

/// The semantic aliases `tokens.css` defines over the raw ramp.
///
/// **Why the gate has to know about these.** `tokens.css` writes
/// `--fg-1: var(--ink-1)`, and most of the app reads the alias rather than the
/// ramp. A palette is applied with `setProperty`, an inline declaration that
/// outranks the stylesheet — so a theme that sets `--fg-1` directly changes what
/// the user actually sees while leaving `--ink-1` untouched. Measuring only the
/// ramp let a palette with a perfectly passing black-on-white ramp plus
/// `--fg-1: #ffffff` clear the gate. The alias wins where present, exactly as it
/// does in the browser.
const ALIASES: &[(&str, &str)] = &[
    ("--bg-1", "--paper"),
    ("--bg-2", "--paper-2"),
    ("--bg-3", "--paper-3"),
    ("--fg-1", "--ink-1"),
    ("--fg-2", "--ink-2"),
    ("--fg-3", "--ink-3"),
    ("--fg-display", "--ink-0"),
];

/// Every value this palette can make a token render as — **all of them**.
///
/// An earlier version returned the alias *instead of* the raw token when both
/// were set, on the theory that the alias is what the UI reads. Half true, and
/// the wrong half: the browser applies both, each wherever it is read, and
/// `var(--ink-1)`, `var(--ink-0)`, `var(--paper-2)` are read directly at a dozen
/// post-unlock sites. So a palette setting `--ink-1: #ffffff` beside
/// `--fg-1: #000000` was measured on the black one and passed, while every
/// surface reading the raw token rendered white on white — the gate reporting
/// "readable" about a palette it had not looked at.
///
/// Returning both and failing on the worst pair is the only answer that does not
/// require knowing which spelling each call site chose.
fn spellings<'a>(vars: &'a BTreeMap<String, String>, token: &str) -> Vec<&'a String> {
    let mut out = Vec::new();
    if let Some(v) = vars.get(token) {
        out.push(v);
    }
    for (alias, raw) in ALIASES {
        if *raw == token {
            if let Some(v) = vars.get(*alias) {
                out.push(v);
            }
        }
    }
    out
}

/// One contrast requirement: a foreground token over a background token, with
/// the floor its role demands.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ContrastRule {
    /// Foreground (text or UI) token name.
    pub fg: &'static str,
    /// Background token name.
    pub bg: &'static str,
    /// Minimum acceptable ratio.
    pub min: f64,
    /// Human-readable role, for the failure message.
    pub label: &'static str,
}

/// The gated pairs, moved verbatim from `myne-themes/tools/lint-theme.mjs`.
///
/// Thresholds follow WCAG: display and primary text take the AA body floor
/// (4.5); secondary text and the accent — a UI component rather than body copy —
/// take the 3.0 large-text / non-text floor.
///
/// **`--ink-3` is deliberately absent.** It is the hint colour and is *allowed*
/// to be low-contrast by design; gating it would reject the tertiary ramp of
/// every legible theme, including Myne's own.
pub const CONTRAST_RULES: &[ContrastRule] = &[
    ContrastRule {
        fg: "--ink-0",
        bg: "--paper",
        min: 4.5,
        label: "display text on page",
    },
    ContrastRule {
        fg: "--ink-1",
        bg: "--paper",
        min: 4.5,
        label: "primary text on page",
    },
    ContrastRule {
        fg: "--ink-1",
        bg: "--paper-2",
        min: 4.5,
        label: "primary text on surface",
    },
    ContrastRule {
        fg: "--ink-2",
        bg: "--paper",
        min: 3.0,
        label: "secondary text on page",
    },
    ContrastRule {
        fg: "--accent",
        bg: "--paper",
        min: 3.0,
        label: "accent on page",
    },
];

/// A pair that failed its floor.
#[derive(Debug, Clone, PartialEq)]
pub struct ContrastFailure {
    /// Foreground token name.
    pub fg: &'static str,
    /// Background token name.
    pub bg: &'static str,
    /// The measured ratio.
    pub ratio: f64,
    /// The floor it had to clear.
    pub min: f64,
    /// The rule's human-readable role.
    pub label: &'static str,
}

/// Parse an `rgb()` / `rgba()` body — the allowlist admits these, so the gate
/// must too. Legacy comma form and modern space form both, alpha ignored for the
/// same reason hex alpha is.
fn rgb_fn_to_rgb(v: &str) -> Option<[u8; 3]> {
    let body = v
        .trim()
        .strip_prefix("rgb(")
        .or_else(|| v.trim().strip_prefix("rgba("))?
        .strip_suffix(')')?;
    let nums: Vec<f64> = body
        .replace([',', '/'], " ")
        .split_whitespace()
        .filter_map(|t| {
            t.strip_suffix('%')
                .map(|p| p.parse::<f64>().ok().map(|n| n * 255.0 / 100.0))
                .unwrap_or_else(|| t.parse::<f64>().ok())
        })
        .collect();
    if nums.len() < 3 {
        return None;
    }
    Some([
        nums[0].clamp(0.0, 255.0) as u8,
        nums[1].clamp(0.0, 255.0) as u8,
        nums[2].clamp(0.0, 255.0) as u8,
    ])
}

/// Parse an `hsl()` / `hsla()` body to RGB. Same reasoning as `rgb_fn_to_rgb`.
fn hsl_fn_to_rgb(v: &str) -> Option<[u8; 3]> {
    let body = v
        .trim()
        .strip_prefix("hsl(")
        .or_else(|| v.trim().strip_prefix("hsla("))?
        .strip_suffix(')')?;
    let nums: Vec<f64> = body
        .replace([',', '/'], " ")
        .split_whitespace()
        .filter_map(|t| t.trim_end_matches('%').parse::<f64>().ok())
        .collect();
    if nums.len() < 3 {
        return None;
    }
    let (h, sat, l) = (
        nums[0].rem_euclid(360.0) / 60.0,
        nums[1] / 100.0,
        nums[2] / 100.0,
    );
    let c = (1.0 - (2.0 * l - 1.0).abs()) * sat;
    let x = c * (1.0 - (h % 2.0 - 1.0).abs());
    let (r, g, b) = match h as u8 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    Some([
        ((r + m) * 255.0).round().clamp(0.0, 255.0) as u8,
        ((g + m) * 255.0).round().clamp(0.0, 255.0) as u8,
        ((b + m) * 255.0).round().clamp(0.0, 255.0) as u8,
    ])
}

/// Parse `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` into 8-bit RGB.
///
/// Alpha is **dropped**, exactly as the JS implementation did: a ratio against a
/// translucent colour depends on what is behind it, which a static check cannot
/// know. Any non-hex value yields `None` and its rule is skipped — the allowlist
/// has already fenced such values for safety, and contrast is only defined here
/// on an opaque colour.
fn hex_to_rgb(hex: &str) -> Option<[u8; 3]> {
    let h = hex.trim().strip_prefix('#')?;
    let expanded: String = match h.len() {
        3 | 4 => h.chars().take(3).flat_map(|c| [c, c]).collect(),
        6 | 8 => h.chars().take(6).collect(),
        _ => return None,
    };
    if !expanded.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 3];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&expanded[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// sRGB channel linearization (WCAG 2.x).
fn linearize(c: u8) -> f64 {
    let s = f64::from(c) / 255.0;
    if s <= 0.03928 {
        s / 12.92
    } else {
        ((s + 0.055) / 1.055).powf(2.4)
    }
}

/// WCAG relative luminance of a hex colour, or `None` if it is not hex.
pub fn relative_luminance(hex: &str) -> Option<f64> {
    let [r, g, b] = hex_to_rgb(hex)
        .or_else(|| rgb_fn_to_rgb(hex))
        .or_else(|| hsl_fn_to_rgb(hex))?;
    Some(0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b))
}

/// WCAG contrast ratio (1.0..=21.0) between two hex colours, or `None` when
/// either is not hex.
pub fn contrast_ratio(a: &str, b: &str) -> Option<f64> {
    let (la, lb) = (relative_luminance(a)?, relative_luminance(b)?);
    let (hi, lo) = if la > lb { (la, lb) } else { (lb, la) };
    Some((hi + 0.05) / (lo + 0.05))
}

/// Every rule this palette fails, in [`CONTRAST_RULES`] order.
///
/// A rule whose tokens are absent, or whose values are not hex, is **skipped**
/// rather than failed: a missing required token is the parse pass's error to
/// report, and a non-hex value has no computable ratio.
pub fn contrast_failures(vars: &BTreeMap<String, String>) -> Vec<ContrastFailure> {
    let mut out = Vec::new();
    for rule in CONTRAST_RULES {
        // The WORST pair over every spelling of each token, because the palette
        // makes all of them renderable and the gate cannot know which one a
        // given call site read.
        let (fgs, bgs) = (spellings(vars, rule.fg), spellings(vars, rule.bg));
        if fgs.is_empty() || bgs.is_empty() {
            continue;
        }
        let Some(ratio) = fgs
            .iter()
            .flat_map(|fg| bgs.iter().filter_map(move |bg| contrast_ratio(fg, bg)))
            .min_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal))
        else {
            continue;
        };
        if ratio < rule.min {
            out.push(ContrastFailure {
                fg: rule.fg,
                bg: rule.bg,
                ratio,
                min: rule.min,
                label: rule.label,
            });
        }
    }
    out
}

/// Gate a palette on readability, reporting the **first** failing pair.
///
/// The error names the pair, the measured ratio and the floor, so the author is
/// told what to change rather than merely that something is wrong.
///
/// **A gated colour the gate cannot resolve is a refusal, not a skip.** The value
/// allowlist admits `red`, `currentColor` and every other bare keyword, and no
/// ratio can be computed against a name — so an unmeasurable value used to walk
/// straight past this check while looking like it had been examined. Clearing the
/// allowlist is not the same as clearing the floor, and only the tokens this gate
/// actually measures are held to it (the optional `--syntax-*` / `--label-*`
/// families are unaffected).
pub fn check_contrast(vars: &BTreeMap<String, String>) -> Result<(), ThemeError> {
    for rule in CONTRAST_RULES {
        for token in [rule.fg, rule.bg] {
            // Every spelling, for the same reason the ratio uses every spelling:
            // an unmeasurable value on the raw token is just as unmeasurable
            // when a call site reads the raw token.
            for v in spellings(vars, token) {
                if relative_luminance(v).is_none() {
                    return Err(ThemeError::invalid_value(token));
                }
            }
        }
    }
    match contrast_failures(vars).first() {
        None => Ok(()),
        Some(f) => Err(ThemeError::low_contrast(f.fg, f.bg, f.ratio, f.min)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ThemeErrorKind;

    fn palette(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn known_ratios_match_the_wcag_reference() {
        // Black on white is the canonical 21:1; a colour against itself is 1:1.
        let bw = contrast_ratio("#000000", "#ffffff").expect("hex");
        assert!((bw - 21.0).abs() < 0.01, "black/white was {bw}");
        let same = contrast_ratio("#3a3a3a", "#3a3a3a").expect("hex");
        assert!((same - 1.0).abs() < 0.001, "identical was {same}");
    }

    #[test]
    fn short_hex_expands_like_the_js_implementation() {
        let short = contrast_ratio("#fff", "#000").expect("hex");
        let long = contrast_ratio("#ffffff", "#000000").expect("hex");
        assert!((short - long).abs() < 1e-12);
    }

    #[test]
    fn alpha_is_dropped_rather_than_blended() {
        // A ratio against a translucent colour depends on what is behind it,
        // which a static check cannot know — so the alpha channel is ignored.
        let with_alpha = contrast_ratio("#ffffff80", "#000000").expect("hex");
        let without = contrast_ratio("#ffffff", "#000000").expect("hex");
        assert!((with_alpha - without).abs() < 1e-12);
    }

    #[test]
    fn rgb_and_hsl_are_measured_like_hex() {
        // Both are first-class allowlisted forms; treating them as unmeasurable
        // let an all-white palette written in `rgb()` clear the gate.
        let by_fn = contrast_ratio("rgb(0, 0, 0)", "rgb(255 255 255)").expect("rgb");
        let by_hex = contrast_ratio("#000000", "#ffffff").expect("hex");
        assert!((by_fn - by_hex).abs() < 0.01, "rgb() gave {by_fn}");
        let hsl = contrast_ratio("hsl(0, 0%, 0%)", "hsl(0 0% 100%)").expect("hsl");
        assert!((hsl - by_hex).abs() < 0.05, "hsl() gave {hsl}");
    }

    #[test]
    fn a_gated_colour_the_gate_cannot_resolve_is_refused() {
        // `red` is allowlisted and unmeasurable. Skipping it was a silent bypass.
        let named = palette(&[("--ink-1", "red"), ("--paper", "#ffffff")]);
        let err = check_contrast(&named).expect_err("an unmeasurable gated colour must refuse");
        assert_eq!(err.kind, ThemeErrorKind::InvalidValue);
        assert_eq!(err.key.as_deref(), Some("--ink-1"));
        assert!(
            contrast_ratio("#12345", "#fff").is_none(),
            "malformed hex stays unmeasurable"
        );
    }

    #[test]
    fn a_semantic_alias_is_measured_in_place_of_the_ramp() {
        // `tokens.css` writes `--fg-1: var(--ink-1)` and the app reads the alias.
        // A palette may set the alias directly — inline style outranks the sheet —
        // so gating only the ramp let a passing ramp hide an unreadable alias.
        let sneaky = palette(&[
            ("--ink-0", "#000000"),
            ("--ink-1", "#000000"),
            ("--ink-2", "#000000"),
            ("--accent", "#000000"),
            ("--paper", "#ffffff"),
            ("--paper-2", "#ffffff"),
            ("--fg-1", "#ffffff"), // what the user actually sees
        ]);
        let err = check_contrast(&sneaky).expect_err("the alias must be measured");
        assert_eq!(err.kind, ThemeErrorKind::LowContrast);
        assert_eq!(err.key.as_deref(), Some("--ink-1"));
    }

    #[test]
    fn each_rule_passes_just_above_and_fails_just_below_its_floor() {
        // Drive each rule independently: put a fg/bg pair in the map that lands
        // either side of that rule's own floor.
        for rule in CONTRAST_RULES {
            // #767676 on white ≈ 4.54 (just over 4.5); #949494 on white ≈ 3.03.
            let (pass_fg, fail_fg) = if rule.min > 4.0 {
                ("#767676", "#949494") // 4.54 passes 4.5; 3.03 fails it
            } else {
                ("#949494", "#c9c9c9") // 3.03 passes 3.0; ~1.9 fails it
            };
            let ok = palette(&[(rule.fg, pass_fg), (rule.bg, "#ffffff")]);
            assert!(
                contrast_failures(&ok).is_empty(),
                "{} on {} should pass at {}",
                rule.fg,
                rule.bg,
                rule.min
            );
            let bad = palette(&[(rule.fg, fail_fg), (rule.bg, "#ffffff")]);
            let failures = contrast_failures(&bad);
            assert_eq!(failures.len(), 1, "{} on {} should fail", rule.fg, rule.bg);
            assert_eq!(failures[0].fg, rule.fg);
            assert_eq!(failures[0].bg, rule.bg);
        }
    }

    #[test]
    fn ink_3_is_exempt() {
        // The hint colour is allowed to be low-contrast by design; gating it
        // would reject the tertiary ramp of every legible theme, Myne's own
        // included.
        assert!(!CONTRAST_RULES.iter().any(|r| r.fg == "--ink-3"));
        let barely_visible = palette(&[("--ink-3", "#f4f4f4"), ("--paper", "#ffffff")]);
        assert!(contrast_failures(&barely_visible).is_empty());
    }

    #[test]
    fn absent_tokens_skip_rather_than_fail() {
        // A missing required token is the parse pass's error to report, not a
        // contrast failure. (An unmeasurable PRESENT one refuses — see above.)
        assert!(contrast_failures(&palette(&[])).is_empty());
        assert!(check_contrast(&palette(&[])).is_ok());
    }

    #[test]
    fn check_contrast_reports_the_pair_and_the_numbers() {
        let bad = palette(&[("--ink-1", "#eeeeee"), ("--paper", "#ffffff")]);
        let err = check_contrast(&bad).expect_err("unreadable palette must reject");
        assert_eq!(err.kind, ThemeErrorKind::LowContrast);
        assert_eq!(err.key.as_deref(), Some("--ink-1"));
        assert_eq!(err.against.as_deref(), Some("--paper"));
        assert!(err.ratio.is_some(), "the measured ratio must be reported");
        assert_eq!(err.min.as_deref(), Some("4.5"));
    }

    #[test]
    fn a_readable_palette_passes() {
        let good = palette(&[
            ("--ink-0", "#1a1a17"),
            ("--ink-1", "#26261f"),
            ("--ink-2", "#5c5c50"),
            ("--accent", "#8a5a2b"),
            ("--paper", "#fbfbfa"),
            ("--paper-2", "#f4f3ef"),
        ]);
        assert_eq!(contrast_failures(&good), vec![]);
        assert!(check_contrast(&good).is_ok());
    }

    #[test]
    fn an_alias_cannot_hide_an_unreadable_ramp() {
        // The gate used to measure the alias INSTEAD of the raw token when both
        // were set. The browser applies both — `var(--ink-1)`, `var(--ink-0)`
        // and `var(--paper-2)` are read directly at a dozen post-unlock sites —
        // so this palette passed while every one of those surfaces rendered
        // white on white, with the gate reporting it readable.
        let hidden = palette(&[
            ("--ink-0", "#ffffff"),
            ("--ink-1", "#ffffff"),
            ("--ink-2", "#ffffff"),
            ("--accent", "#8a5a2b"),
            ("--paper", "#ffffff"),
            ("--paper-2", "#ffffff"),
            // …and the aliases the gate preferred, which are perfectly legible.
            ("--fg-display", "#000000"),
            ("--fg-1", "#000000"),
            ("--fg-2", "#000000"),
        ]);
        assert!(
            !contrast_failures(&hidden).is_empty(),
            "an all-white ramp behind legible aliases must still fail"
        );
        assert!(check_contrast(&hidden).is_err());
    }

    #[test]
    fn the_alias_is_still_measured_when_it_is_the_unreadable_one() {
        // The other direction, so the fix is "worst of both" rather than a swap
        // of which spelling wins.
        let hidden = palette(&[
            ("--ink-0", "#1a1a17"),
            ("--ink-1", "#26261f"),
            ("--ink-2", "#5c5c50"),
            ("--accent", "#8a5a2b"),
            ("--paper", "#fbfbfa"),
            ("--paper-2", "#f4f3ef"),
            ("--fg-1", "#fbfbfa"),
        ]);
        assert!(
            !contrast_failures(&hidden).is_empty(),
            "an unreadable alias over a legible ramp must fail"
        );
    }
}
