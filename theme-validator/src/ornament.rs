// SPDX-License-Identifier: AGPL-3.0
//! Ornament + measure token **vocabulary** — which keys a theme may meaningfully
//! supply, and which enumerated values each ornament primitive accepts
//! (deep-customization, myne#394 task 2).
//!
//! **This module is a vocabulary, NOT a security control, and the distinction is
//! the whole reason it can exist.** The security control is
//! [`super::value::is_allowed_value`]: a value reaches the DOM and therefore
//! executes (`threat-model.md` "Custom-theme CSS-value surface"), so what a value
//! may *look like* is fenced by an allowlist that this module does not touch and
//! must never widen. What this module adds is *meaning* — that `--box-frame` is
//! the box role's frame primitive and that `thick` is one of its five values —
//! which costs no new value shape because a primitive selection is a bare keyword
//! and a parameter is `<number><unit>`, both already admissible. Widening the
//! vocabulary is free; widening the allowlist is a security decision. They have
//! never been coupled and must not become so (`decisions.md` 2026-08-06).
//!
//! **Unknown values are dropped, not rejected.** A key on the vocabulary whose
//! value is off its enumerated set is removed from the parsed theme, so the
//! primitive renders plain. That is the forward-compatibility contract: a newer
//! theme meeting an older client degrades to what that client understands rather
//! than failing to load. A *malformed* value (off the allowlist entirely) is a
//! different case and is still rejected outright by the value pass — degrading is
//! for values we merely do not know, never for values we have deemed unsafe.
//!
//! **Why the enumerated values carry no hyphens.** `is_allowed_value`'s bare-keyword
//! arm is ASCII **letters only** — deliberately, because a token with no digits,
//! punctuation or parens cannot form a functional value, a `url()`, a scheme or a
//! comment escape. So `corner-tape` is not expressible as a value and the ribbon
//! primitive says `corner` instead. Key *names* may hyphenate (the key grammar
//! allows `-`); values may not. Adding a value with a hyphen would require
//! widening the allowlist, which is exactly the trade this design refuses.

use crate::schema::ParsedTheme;

/// The three ornament roles a component may declare. Ornament is scoped here
/// rather than per element: twenty-three callout types alone would put several
/// hundred keys in a theme file (`decisions.md` 2026-08-06 clause (c)).
pub const ROLES: &[&str] = &["surface", "box", "chrome"];

/// Which primitives each role actually accepts.
///
/// **Not every role × primitive cell is meaningful, and offering the full matrix
/// was a mistake worth undoing.** A button with a dog-eared corner, a tab with a
/// punched margin, a toolbar with notebook rules — these are not restrained
/// choices a theme might make, they are settings that describe nothing. They
/// still cost: twenty-four keys in the vocabulary, twenty-four controls in the
/// builder, and twenty-four things a theme author has to read past.
///
/// Scoped as follows, by what the role IS:
///   - `surface` — a page or panel: paper treatments, and the sheet's own edges.
///     No ribbon; a page does not wear a label.
///   - `box` — a callout, card, code block or quote. The full set: this is the
///     stationery role, and every primitive was designed with it in mind.
///   - `chrome` — a tab, button or bar. Frame, shadow and texture only. Chrome is
///     small, dense and repeated; a torn edge or a fold on it reads as damage.
///
/// A key outside this table classifies as [`KeyClass::Other`] — stored and
/// ignored, exactly like any unknown key, so an older theme that carries one
/// still loads and no format event is involved.
pub const ROLE_PRIMITIVES: &[(&str, &[&str])] = &[
    (
        "surface",
        &[
            "frame",
            "shadow",
            "texture",
            "ruled",
            "edge",
            "fold",
            "perforation",
        ],
    ),
    (
        "box",
        &[
            "frame",
            "shadow",
            "texture",
            "ruled",
            "edge",
            "fold",
            "ribbon",
            "perforation",
        ],
    ),
    ("chrome", &["frame", "shadow", "texture"]),
];

/// `true` when `role` accepts `primitive` (see [`ROLE_PRIMITIVES`]).
pub fn role_accepts(role: &str, primitive: &str) -> bool {
    ROLE_PRIMITIVES
        .iter()
        .find(|(r, _)| *r == role)
        .is_some_and(|(_, prims)| prims.contains(&primitive))
}

/// One ornament primitive: its name as it appears after the role in a key
/// (`--box-frame` → `frame`) and the values it accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Primitive {
    /// Name as spelled in the key, after `--<role>-`.
    pub name: &'static str,
    /// The enumerated values this primitive accepts.
    pub values: &'static [&'static str],
}

/// The role-scoped primitives (`decisions.md` 2026-08-06 clause (b)). All are
/// enumerated; the tint wash is the one non-enumerated primitive and is not
/// role-scoped — see [`TINT_KEYS`].
pub const PRIMITIVES: &[Primitive] = &[
    Primitive {
        name: "frame",
        values: &["none", "hairline", "thick", "double", "inset"],
    },
    Primitive {
        name: "shadow",
        values: &["none", "soft", "hard", "offset"],
    },
    Primitive {
        name: "texture",
        values: &["none", "paper", "grain", "scanline", "grid"],
    },
    Primitive {
        name: "ruled",
        values: &["none", "lines", "grid", "dotted"],
    },
    Primitive {
        name: "edge",
        values: &["plain", "torn", "serrated", "cut"],
    },
    Primitive {
        name: "fold",
        values: &["none", "folded", "dogear"],
    },
    Primitive {
        name: "ribbon",
        values: &["none", "corner", "band", "label"],
    },
    Primitive {
        name: "perforation",
        values: &["none", "left", "top", "both"],
    },
];

/// The tint wash — a colour and a 0..1 strength — is **not role-scoped**.
///
/// It is one pair of tokens (`--tint`, `--tint-strength`) rather than one per
/// role, because that is what the ornament stylesheet implements: the wash is
/// composed on the role-agnostic layer. Declaring it per role would validate and
/// store `--surface-tint` and `--chrome-tint`, which nothing would ever draw —
/// vocabulary promising more than the renderer delivers, which is the failure
/// this whole design is built to avoid.
pub const TINT_KEYS: &[&str] = &["--tint", "--tint-strength"];

/// The measure tokens a theme may supply — spacing, radius, type scale, weight
/// and tracking, mirroring `src/styles/tokens.css`.
///
/// Recognizing them here is what makes them part of the vocabulary; the
/// **clamp** that keeps a hostile or careless value from producing an unusable
/// window lives on the application side, where each token's built-in default is
/// known (`decisions.md` 2026-08-06 clause (d)). This crate deliberately does
/// not clamp: it has no access to the defaults, and a clamp computed against a
/// guessed default would be worse than none.
pub const MEASURE_KEYS: &[&str] = &[
    // Spacing scale
    "--space-0",
    "--space-1",
    "--space-2",
    "--space-3",
    "--space-4",
    "--space-5",
    "--space-6",
    "--space-7",
    "--space-8",
    "--space-9",
    // Corner radius
    "--radius-1",
    "--radius-2",
    "--radius-3",
    "--radius-pill",
    // Type scale
    "--text-xs",
    "--text-sm",
    "--text-base",
    "--text-md",
    "--text-lg",
    "--text-xl",
    "--text-2xl",
    "--text-3xl",
    "--text-4xl",
    // Weight
    "--weight-regular",
    "--weight-medium",
    "--weight-semibold",
    "--weight-bold",
    // Tracking
    "--tracking-tight",
    "--tracking-normal",
    "--tracking-wide",
    "--tracking-caps",
];

/// What a key means in the vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyClass {
    /// `--<role>-<primitive>`, e.g. `--box-frame`.
    Ornament {
        /// The declaring role — one of [`ROLES`].
        role: &'static str,
        /// The primitive this key selects.
        primitive: &'static Primitive,
    },
    /// One of [`MEASURE_KEYS`].
    Measure,
    /// Anything else — colors, syntax roles, and any key this build has never
    /// heard of. Not an error: the vocabulary is open (`protocol.md` §9.21.2).
    Other,
}

/// Classify a token name against the vocabulary.
pub fn classify_key(key: &str) -> KeyClass {
    if MEASURE_KEYS.contains(&key) || TINT_KEYS.contains(&key) {
        return KeyClass::Measure;
    }
    let Some(rest) = key.strip_prefix("--") else {
        return KeyClass::Other;
    };
    for role in ROLES {
        let Some(after_role) = rest.strip_prefix(role).and_then(|r| r.strip_prefix('-')) else {
            continue;
        };
        if let Some(primitive) = PRIMITIVES.iter().find(|p| p.name == after_role) {
            // A primitive this role does not accept is `Other`, not `Ornament`:
            // `--chrome-fold` is a well-formed key naming a real primitive, and
            // it still means nothing, so it is stored and ignored like any other
            // key the build does not recognize (`ROLE_PRIMITIVES`).
            if !role_accepts(role, primitive.name) {
                return KeyClass::Other;
            }
            return KeyClass::Ornament { role, primitive };
        }
    }
    KeyClass::Other
}

/// `true` when `value` is one this primitive understands.
pub fn is_known_ornament_value(primitive: &Primitive, value: &str) -> bool {
    primitive.values.contains(&value.trim())
}

/// `true` unless `key` is an ornament key carrying a value this build does not
/// know.
///
/// The one definition of "do I know what this means", so the read-side filter in
/// `myne-core` and the dropper below cannot answer it differently. Non-ornament
/// keys are always `true` — this judges meaning, never safety, and safety is
/// [`super::is_allowed_value`]'s to judge.
pub fn is_known(key: &str, value: &str) -> bool {
    match classify_key(key) {
        KeyClass::Ornament { primitive, .. } => is_known_ornament_value(primitive, value),
        _ => true,
    }
}

/// Ornament-shaped keys this vocabulary REFUSES, in deterministic order.
///
/// `--chrome-fold` names a real role and a real primitive and still means
/// nothing, because the matrix is sparse (`ROLE_PRIMITIVES`). `classify_key`
/// answers `Other` for it — the right *behaviour*, since it is indistinguishable
/// from a key belonging to a vocabulary that does not exist yet, and dropping it
/// would make an export round-trip lose a newer peer's ornament.
///
/// But `Other` also discards the one thing an AUTHOR needs: nothing anywhere
/// told them their key does nothing. It validated, it merged, it synced, it drew
/// nothing, silently. This recovers that signal for the tools whose job is to
/// tell a human — without changing what any of them store.
pub fn refused_ornament_keys(theme: &ParsedTheme) -> Vec<String> {
    let mut out: Vec<String> = theme
        .vars
        .keys()
        .filter(|key| {
            let Some(rest) = key.strip_prefix("--") else {
                return false;
            };
            ROLES.iter().any(|role| {
                rest.strip_prefix(role)
                    .and_then(|r| r.strip_prefix('-'))
                    .is_some_and(|after| {
                        PRIMITIVES.iter().any(|p| p.name == after) && !role_accepts(role, after)
                    })
            })
        })
        .cloned()
        .collect();
    out.sort();
    out
}

/// Drop every ornament key whose value is off its primitive's enumerated set,
/// returning the dropped names in deterministic order.
///
/// This is the forward-compatibility step: the theme still loads, the primitive
/// renders plain, and nothing about the palette's colors is affected. It runs
/// **after** the value-shape pass, so anything reaching it is already known-safe
/// — this decides meaning, never safety.
pub fn drop_unknown_ornament_values(theme: &mut ParsedTheme) -> Vec<String> {
    let dropped: Vec<String> = theme
        .vars
        .iter()
        .filter(|(key, value)| !is_known(key, value))
        .map(|(key, _)| key.clone())
        .collect();
    for key in &dropped {
        theme.vars.remove(key);
    }
    dropped
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::validate_theme;
    use crate::{is_allowed_value, REQUIRED_KEYS};

    fn minimal_core_plus(extra: &[(&str, &str)]) -> String {
        let mut s = String::from("{\n");
        for key in REQUIRED_KEYS {
            s.push_str(&format!("  \"{key}\": \"#101010\",\n"));
        }
        for (i, (k, v)) in extra.iter().enumerate() {
            let comma = if i + 1 < extra.len() { "," } else { "" };
            s.push_str(&format!("  \"{k}\": \"{v}\"{comma}\n"));
        }
        if extra.is_empty() {
            s.truncate(s.trim_end().trim_end_matches(',').len());
            s.push('\n');
        }
        s.push('}');
        s
    }

    #[test]
    fn every_enumerated_value_passes_the_untouched_value_allowlist() {
        // The load-bearing claim of this design: the vocabulary costs no new
        // value shape. If a primitive ever gains a value the allowlist rejects,
        // this fails here rather than at import time in a user's vault.
        for p in PRIMITIVES {
            for v in p.values {
                assert!(
                    is_allowed_value(v),
                    "primitive {:?} value {v:?} is off the value allowlist",
                    p.name
                );
            }
        }
    }

    #[test]
    fn no_enumerated_value_contains_a_hyphen() {
        // The bare-keyword arm is letters-only; a hyphenated value would force a
        // grammar widening, which is the trade this design refuses.
        for p in PRIMITIVES {
            for v in p.values {
                assert!(
                    !v.contains('-'),
                    "primitive {:?} value {v:?} hyphenates",
                    p.name
                );
            }
        }
    }

    #[test]
    fn every_ornament_key_is_a_well_formed_token_name() {
        for role in ROLES {
            for p in PRIMITIVES {
                let key = format!("--{role}-{}", p.name);
                assert!(crate::is_allowed_key(&key), "{key} is off the key grammar");
            }
        }
    }

    #[test]
    fn classify_recognizes_every_role_primitive_pair_the_role_accepts() {
        // The matrix is SPARSE, not full: a role takes the primitives that mean
        // something for what it is (`ROLE_PRIMITIVES`). This walks the table
        // rather than the cartesian product, so adding a pair is one edit and
        // the test cannot fall behind it.
        for (role, prims) in ROLE_PRIMITIVES {
            for name in *prims {
                let key = format!("--{role}-{name}");
                match classify_key(&key) {
                    KeyClass::Ornament { role: r, primitive } => {
                        assert_eq!(r, *role);
                        assert_eq!(primitive.name, *name, "wrong primitive for {key}");
                    }
                    other => panic!("{key} classified as {other:?}"),
                }
            }
        }
    }

    #[test]
    fn a_primitive_the_role_does_not_accept_is_not_ornament() {
        // A button with a dog-eared corner, a tab with a punched margin: these
        // are well-formed keys naming real primitives that describe nothing.
        // They classify as `Other` — stored and ignored like any unknown key, so
        // an older theme carrying one still loads.
        for key in [
            "--chrome-fold",
            "--chrome-ruled",
            "--chrome-edge",
            "--chrome-ribbon",
            "--chrome-perforation",
            "--surface-ribbon",
        ] {
            assert_eq!(classify_key(key), KeyClass::Other, "{key}");
        }
    }

    #[test]
    fn every_role_primitive_entry_names_a_real_role_and_primitive() {
        // The table is hand-written; this is what stops a typo in it from
        // silently removing a primitive from a role.
        for (role, prims) in ROLE_PRIMITIVES {
            assert!(ROLES.contains(role), "unknown role {role}");
            for name in *prims {
                assert!(
                    PRIMITIVES.iter().any(|p| p.name == *name),
                    "unknown primitive {name}"
                );
            }
        }
        // Every role is covered, and `box` still takes the whole set — it is the
        // role every primitive was designed for.
        assert_eq!(ROLE_PRIMITIVES.len(), ROLES.len());
        let box_prims = ROLE_PRIMITIVES.iter().find(|(r, _)| *r == "box").unwrap().1;
        assert_eq!(box_prims.len(), PRIMITIVES.len());
    }

    #[test]
    fn the_tint_wash_is_not_role_scoped() {
        // The stylesheet composes the wash on the role-agnostic layer, so the
        // vocabulary must not promise `--surface-tint` / `--chrome-tint` — keys
        // that would validate, sync and then draw nothing.
        for key in TINT_KEYS {
            assert_eq!(classify_key(key), KeyClass::Measure, "{key}");
        }
        for role in ROLES {
            assert_eq!(classify_key(&format!("--{role}-tint")), KeyClass::Other);
        }
    }

    #[test]
    fn every_primitive_is_enumerated() {
        // The free-form branch existed only for tint. With tint out of the role
        // scope, a primitive with no values would be one nothing can ever match.
        for p in PRIMITIVES {
            assert!(!p.values.is_empty(), "{} has no values", p.name);
        }
    }

    #[test]
    fn measure_keys_classify_as_measure() {
        for key in MEASURE_KEYS {
            assert_eq!(classify_key(key), KeyClass::Measure, "{key}");
        }
    }

    #[test]
    fn colors_and_unknown_keys_classify_as_other() {
        for key in [
            "--paper",
            "--ink-1",
            "--syntax-keyword",
            "--label-red",
            "--box-notaprimitive",
        ] {
            assert_eq!(classify_key(key), KeyClass::Other, "{key}");
        }
    }

    #[test]
    fn known_values_are_kept_and_unknown_ones_dropped() {
        let json = minimal_core_plus(&[
            ("--box-frame", "thick"),
            ("--box-texture", "banana"),
            ("--surface-ruled", "lines"),
            ("--chrome-shadow", "elevated"),
        ]);
        let mut theme = validate_theme(&json).expect("valid theme");
        let dropped = drop_unknown_ornament_values(&mut theme);
        assert_eq!(
            dropped,
            vec!["--box-texture".to_string(), "--chrome-shadow".to_string()]
        );
        assert!(theme.vars.contains_key("--box-frame"));
        assert!(theme.vars.contains_key("--surface-ruled"));
        assert!(!theme.vars.contains_key("--box-texture"));
        assert!(!theme.vars.contains_key("--chrome-shadow"));
    }

    #[test]
    fn the_tint_pair_keeps_any_allowlisted_value() {
        // The tint wash is the one non-enumerated primitive: `--tint` takes a
        // colour and `--tint-strength` a number, so `is_known` must not drop
        // either. This test used to name `--box-tint` / `--box-tint-strength` —
        // the ROLE-SCOPED spelling that `decisions.md` 2026-08-07 records as
        // wrong on every author-facing surface. Those keys now classify as
        // `Other`, which made the assertion vacuous while the test went on
        // documenting the wrong spelling inside the crate that defines it.
        let json = minimal_core_plus(&[("--tint", "#ff0000"), ("--tint-strength", "0.4")]);
        let mut theme = validate_theme(&json).expect("valid");
        assert!(drop_unknown_ornament_values(&mut theme).is_empty());
        assert_eq!(
            theme.vars.get("--tint").map(String::as_str),
            Some("#ff0000")
        );
        assert_eq!(
            theme.vars.get("--tint-strength").map(String::as_str),
            Some("0.4")
        );
        // …and the role-scoped spelling really is not a tint key.
        assert_eq!(classify_key("--box-tint"), KeyClass::Other);
    }

    #[test]
    fn a_malformed_ornament_value_is_still_rejected_not_dropped() {
        // Degrading is for values we do not KNOW; never for values we have
        // deemed unsafe. An injection in ornament position must reject exactly
        // as it does in color position.
        let json = minimal_core_plus(&[("--box-frame", "url(evil.png)")]);
        let err = validate_theme(&json).expect_err("an injection must reject");
        assert_eq!(err.kind, crate::ThemeErrorKind::InvalidValue);
        assert_eq!(err.key.as_deref(), Some("--box-frame"));
    }

    #[test]
    fn dropping_never_touches_colors_or_measures() {
        let json = minimal_core_plus(&[("--space-4", "20px"), ("--box-frame", "banana")]);
        let mut theme = validate_theme(&json).expect("valid theme");
        let before = theme.vars.len();
        let dropped = drop_unknown_ornament_values(&mut theme);
        assert_eq!(dropped, vec!["--box-frame".to_string()]);
        assert_eq!(theme.vars.len(), before - 1);
        assert!(theme.vars.contains_key("--space-4"));
        for key in REQUIRED_KEYS {
            assert!(theme.vars.contains_key(*key), "{key} was dropped");
        }
    }

    #[test]
    fn required_keys_did_not_grow() {
        // A theme published against the pre-vocabulary crate must stay valid;
        // making any new key required would invalidate all ten of them.
        assert_eq!(REQUIRED_KEYS.len(), 21);
        for key in REQUIRED_KEYS {
            assert!(!matches!(classify_key(key), KeyClass::Ornament { .. }));
        }
    }

    #[test]
    fn a_refused_cell_is_reported_to_the_author_even_though_it_is_kept() {
        // The behaviour and the signal are separate decisions. `--chrome-fold`
        // must SURVIVE (it is indistinguishable from a future vocabulary, and
        // dropping it would lose a newer peer's ornament on an export round
        // trip) — and the author must still be TOLD, because nothing else was
        // going to: it validates, merges, syncs and draws nothing.
        let json = minimal_core_plus(&[
            ("--chrome-fold", "dogear"),
            ("--surface-ribbon", "corner"),
            ("--box-frame", "thick"),
        ]);
        let theme = validate_theme(&json).expect("valid");
        assert_eq!(
            refused_ornament_keys(&theme),
            vec!["--chrome-fold".to_string(), "--surface-ribbon".to_string()],
        );
        // …and they really are still in the palette.
        assert!(theme.vars.contains_key("--chrome-fold"));
        // An accepted cell is not reported.
        assert!(!refused_ornament_keys(&theme).contains(&"--box-frame".to_string()));
    }
}
