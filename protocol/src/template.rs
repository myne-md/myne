// SPDX-License-Identifier: AGPL-3.0

//! Deterministic note-template variable substitution.
//!
//! The variable engine for note templates (MYND-188): it scans a template body
//! for `{{token}}` placeholders and substitutes each known token against a
//! fixed built-in registry. It is **deterministic substitution only** — parse →
//! registry lookup → substitute — never an evaluator, expression language,
//! formula, callback, or format-argument mini-language. This is the anti-plugin
//! / no-scripting commitment (`vision.md`) expressed in code: there is no
//! behavior here to walk back into a scripting surface.
//!
//! ## Injected time, no ambient I/O
//!
//! This crate is `#![no_std]` and adds no clock or locale dependency. The engine
//! therefore reads no wall clock and computes no calendar arithmetic itself —
//! the host (the Tauri layer) formats the local date / time / weekday and passes
//! them in via [`RenderContext`]. A given `(template, context)` pair always
//! renders byte-identical output; there is no hidden time or locale input. This
//! mirrors the discipline elsewhere in the crate where randomness/clock is
//! caller-supplied (cf. the `_raw` convention in `protocol/CLAUDE.md`).
//!
//! ## Closed vocabulary
//!
//! Only the [registry](supported_tokens) tokens substitute. Token names are
//! matched **case-sensitively** against the lowercase registry keys, so `{{Date}}`
//! is not a token. Every other `{{...}}` — an unknown name, a format-arg-shaped
//! `{{title:foo}}`, an unbalanced brace run — is copied through **verbatim**.
//! The unknown-token passthrough doubles as the escape mechanism: a literal
//! `{{example}}` survives intact because `example` is not in the registry, so
//! there is no dedicated escape syntax (`\{{`, `{{{{`). Rendered output is plain
//! markdown — a substituted token emits only literal text, never a marker, HTML,
//! or any active content.

use alloc::string::String;
use alloc::vec::Vec;

/// Host-injected substitution inputs for [`render`].
///
/// Every field is a pre-formatted, owned string supplied by the host: the engine
/// reads no clock or locale of its own (the crate is `#![no_std]` and pulls in no
/// time/locale dependency). The time-derived fields (`date`, `time`, `datetime`,
/// `weekday`) are expected to already be in **local** time and the app language
/// — `{{date}}` = `YYYY-MM-DD` local, `{{time}}` = `HH:mm` local 24-hour,
/// `{{datetime}}` = the combined local form, `{{weekday}}` = the localized day
/// name. RFC-3339-UTC is reserved for frontmatter-bound tokens (none today), not
/// these body tokens (SYNC-4-R). `title` is whatever the caller supplies; the
/// engine has no empty-title policy of its own (SYNC-5-R — the empty-vs-prompt
/// decision lives in the new-note-from-template UX).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RenderContext {
    /// Value for `{{title}}` — substituted verbatim (may be empty).
    pub title: String,
    /// Value for `{{date}}` — local `YYYY-MM-DD`, host-formatted.
    pub date: String,
    /// Value for `{{time}}` — local `HH:mm` 24-hour, host-formatted.
    pub time: String,
    /// Value for `{{datetime}}` — local date+time combined, host-formatted.
    pub datetime: String,
    /// Value for `{{weekday}}` — localized day name (app language), host-formatted.
    pub weekday: String,
}

/// Selects a token's substitution value out of a [`RenderContext`].
type Selector = for<'a> fn(&'a RenderContext) -> &'a str;

/// The v1 token registry — the **single source of truth** consulted by both the
/// substitution loop ([`resolve`]) and the UI-facing list ([`supported_tokens`]),
/// so the two can never drift. Adding a token here surfaces it in both places
/// with no other edit. Names are lowercase by contract (case-sensitive matching).
const REGISTRY: &[(&str, Selector)] = &[
    ("date", |c| c.date.as_str()),
    ("time", |c| c.time.as_str()),
    ("title", |c| c.title.as_str()),
    ("datetime", |c| c.datetime.as_str()),
    ("weekday", |c| c.weekday.as_str()),
];

/// Resolve a token name to its substitution value, or `None` if `name` is not a
/// registry token. Case-sensitive against the lowercase registry keys.
fn resolve<'a>(name: &str, ctx: &'a RenderContext) -> Option<&'a str> {
    REGISTRY
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, sel)| sel(ctx))
}

/// The supported token names, sourced from the one [`REGISTRY`] (no hard-coded
/// second list). The template-management UI reads the vocabulary from here so its
/// `{{` autocomplete can never drift from what [`render`] actually substitutes.
/// v1 returns `["date", "time", "title", "datetime", "weekday"]`.
pub fn supported_tokens() -> Vec<&'static str> {
    REGISTRY.iter().map(|(n, _)| *n).collect()
}

/// Render a template body by substituting each known `{{token}}` against `ctx`.
///
/// Deterministic, eager, one-shot: every occurrence of a registry token is
/// replaced in a single left-to-right pass; unknown tokens and stray braces are
/// copied through verbatim. No clock or locale is read — output is a pure
/// function of `(template, ctx)`. A template with no recognized token renders
/// byte-identical to its input.
pub fn render(template: &str, ctx: &RenderContext) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;

    loop {
        match rest.find("{{") {
            None => {
                out.push_str(rest);
                break;
            }
            Some(open) => {
                // Emit everything before the `{{`.
                out.push_str(&rest[..open]);
                let after_open = &rest[open + 2..];
                // A hit requires BOTH a closing `}}` and a known token between.
                let hit = after_open
                    .find("}}")
                    .and_then(|close| resolve(&after_open[..close], ctx).map(|v| (v, close)));
                match hit {
                    // Known token → substitute, advance past the `}}`.
                    Some((value, close)) => {
                        out.push_str(value);
                        rest = &after_open[close + 2..];
                    }
                    // No closer, or an unknown token / format-arg / `{{ }}` →
                    // the `{{` is literal; emit it and rescan from just after it,
                    // so the inner text (and its braces) pass through verbatim.
                    None => {
                        out.push_str("{{");
                        rest = after_open;
                    }
                }
            }
        }
    }

    out
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use alloc::string::ToString;
    use alloc::vec;

    // A fully-populated fixed context. Time-derived fields are deliberately a
    // local instant near a UTC day boundary (01:00 local in a positive offset)
    // so the "no off-by-one to UTC" property is demonstrable: the host injects
    // the LOCAL calendar day, never the previous UTC day.
    fn ctx() -> RenderContext {
        RenderContext {
            title: "My Note".to_string(),
            date: "2026-06-07".to_string(),
            time: "01:00".to_string(),
            datetime: "2026-06-07 01:00".to_string(),
            weekday: "Sunday".to_string(),
        }
    }

    // === T1 — module skeleton + identity render + determinism ===

    #[test]
    fn no_token_template_renders_identical() {
        let t = "# Heading\n\nA paragraph with { single } braces and a } stray.";
        assert_eq!(render(t, &ctx()), t);
    }

    #[test]
    fn empty_template_renders_empty() {
        assert_eq!(render("", &ctx()), "");
    }

    #[test]
    fn identical_inputs_render_identical_output_across_calls() {
        let t = "{{date}} {{title}} {{weekday}}";
        let c = ctx();
        assert_eq!(render(t, &c), render(t, &c));
    }

    // === T2 — {{title}} eager substitution + empty-title ===

    #[test]
    fn title_substituted_at_every_occurrence() {
        assert_eq!(render("{{title}} / {{title}}", &ctx()), "My Note / My Note");
    }

    #[test]
    fn empty_title_renders_as_empty_string() {
        let c = RenderContext {
            title: String::new(),
            ..ctx()
        };
        assert_eq!(render("[{{title}}]", &c), "[]");
    }

    #[test]
    fn title_with_markdownish_chars_substituted_verbatim() {
        let c = RenderContext {
            title: "**bold** {{date}} <x>".to_string(),
            ..ctx()
        };
        // Substituted verbatim — no escaping, and the literal `{{date}}` inside
        // the injected value is NOT re-scanned (single eager pass).
        assert_eq!(render("{{title}}", &c), "**bold** {{date}} <x>");
    }

    // === T3 — unknown-token-literal + lowercase-only + escape-via-literal ===

    #[test]
    fn unknown_tokens_pass_through_verbatim() {
        assert_eq!(
            render("{{foo}} and {{author}}", &ctx()),
            "{{foo}} and {{author}}"
        );
    }

    #[test]
    fn uppercase_token_names_are_not_tokens() {
        assert_eq!(render("{{Date}} {{DATE}}", &ctx()), "{{Date}} {{DATE}}");
    }

    #[test]
    fn literal_braces_survive_as_the_escape_mechanism() {
        assert_eq!(render("{{example}}", &ctx()), "{{example}}");
    }

    #[test]
    fn format_arg_shaped_token_is_left_literal() {
        // No mini-language: `{{title:foo}}` is not a registry key → verbatim.
        assert_eq!(render("{{title:foo}}", &ctx()), "{{title:foo}}");
    }

    #[test]
    fn stray_and_unbalanced_braces_pass_without_panic() {
        assert_eq!(render("{{", &ctx()), "{{");
        assert_eq!(render("}}", &ctx()), "}}");
        assert_eq!(render("{{ }}", &ctx()), "{{ }}");
        assert_eq!(render("a {{ b", &ctx()), "a {{ b");
        // A real token still fires after an earlier unbalanced `{{`.
        assert_eq!(render("{{ {{date}}", &ctx()), "{{ 2026-06-07");
    }

    // === T4 — local-time tokens: {{date}}, {{time}}, {{datetime}} ===

    #[test]
    fn date_time_datetime_render_from_injected_local_fields() {
        assert_eq!(render("{{date}}", &ctx()), "2026-06-07");
        assert_eq!(render("{{time}}", &ctx()), "01:00");
        assert_eq!(render("{{datetime}}", &ctx()), "2026-06-07 01:00");
    }

    #[test]
    fn local_instant_near_utc_boundary_keeps_the_local_day() {
        // Host injects the LOCAL day for a 01:00 local instant in a +03:00
        // offset (which is 22:00 the PREVIOUS day in UTC). The engine emits the
        // injected local day — no off-by-one to the UTC date.
        let c = RenderContext {
            date: "2026-06-07".to_string(),
            time: "01:00".to_string(),
            ..ctx()
        };
        assert_eq!(render("{{date}} {{time}}", &c), "2026-06-07 01:00");
    }

    #[test]
    fn time_fields_have_no_wall_clock_dependency() {
        let c = ctx();
        let t = "{{datetime}}";
        assert_eq!(render(t, &c), render(t, &c));
    }

    // === T5 — {{weekday}} localized day name from injected value ===

    #[test]
    fn weekday_renders_injected_value_verbatim() {
        assert_eq!(render("{{weekday}}", &ctx()), "Sunday");
    }

    #[test]
    fn non_english_weekday_is_substituted_unchanged() {
        // A Turkish day name proves the engine carries no locale logic — it
        // emits exactly what the host injected.
        let c = RenderContext {
            weekday: "Pazar".to_string(),
            ..ctx()
        };
        assert_eq!(render("{{weekday}}", &c), "Pazar");
    }

    // === T6 — token-list accessor sourced from the one registry ===

    #[test]
    fn supported_tokens_returns_exactly_the_five_v1_names() {
        assert_eq!(
            supported_tokens(),
            vec!["date", "time", "title", "datetime", "weekday"]
        );
    }

    #[test]
    fn accessor_set_equals_what_render_substitutes() {
        // Every advertised token actually substitutes (does not pass through
        // literal), and the wrapped form differs from the literal — proving the
        // accessor list and the substitution loop share one registry.
        let c = ctx();
        for name in supported_tokens() {
            let templ = alloc::format!("{{{{{name}}}}}"); // e.g. "{{date}}"
            let rendered = render(&templ, &c);
            assert_ne!(rendered, templ, "token {name} should substitute");
            assert!(resolve(name, &c).is_some(), "token {name} resolves");
        }
    }

    // === T7 — coverage hardening + plain-markdown-output assertions ===

    #[test]
    fn repeated_token_substituted_at_every_occurrence_multiline() {
        let t = "{{date}}\nmid\n{{date}} and {{date}}";
        assert_eq!(
            render(t, &ctx()),
            "2026-06-07\nmid\n2026-06-07 and 2026-06-07"
        );
    }

    #[test]
    fn mixed_known_and_unknown_substitutes_only_known() {
        assert_eq!(
            render("{{date}} {{project}} {{title}}", &ctx()),
            "2026-06-07 {{project}} My Note"
        );
    }

    #[test]
    fn all_five_tokens_against_one_fixed_context_match_exact_string() {
        let t = "# {{title}} — {{weekday}} {{date}} {{time}} ({{datetime}})";
        assert_eq!(
            render(t, &ctx()),
            "# My Note — Sunday 2026-06-07 01:00 (2026-06-07 01:00)"
        );
    }

    #[test]
    fn rendered_output_contains_only_literal_text_no_active_content() {
        // No token emits a marker / HTML / active content — output is plain text.
        let t = "{{title}} {{date}} {{time}} {{datetime}} {{weekday}}";
        let out = render(t, &ctx());
        assert!(!out.contains("<"), "no HTML emitted");
        assert!(!out.contains("{{"), "all known tokens consumed");
        assert_eq!(out, "My Note 2026-06-07 01:00 2026-06-07 01:00 Sunday");
    }

    // ---- KAT vector regenerator (companion repo) ----------------------

    /// Emits the full `cases.json` for
    /// `myne-test-vectors/vectors/note-template/v0.1/cases.json` as a
    /// pretty-printed JSON file at `/tmp/myne_note_template_vectors.json`,
    /// ready to copy verbatim into the companion repo.
    ///
    /// `#[ignore]` because regenerating vectors is a deliberate act, not a
    /// side effect of `cargo test`. Run with:
    /// `cargo test -p protocol --lib emit_note_template_vectors_for_paste -- --ignored`
    ///
    /// 12 cases pin the deterministic substitution contract (MYND-188):
    /// - 11 `render` — pure-function `(template, ctx) → output` pins, each
    ///   targeting one drift-prone scanner behavior: all-five-tokens,
    ///   repeated/multiline, unknown-token verbatim passthrough (the escape
    ///   mechanism), case-sensitive matching, format-arg-shaped rejection
    ///   (no mini-language — the anti-plugin commitment in bytes),
    ///   stray/unbalanced braces, rescan-after-literal-`{{`, empty
    ///   template, empty title, substituted-value-not-rescanned (the
    ///   single-pass pin — any re-scanning port fails it), and NFD unicode
    ///   byte-transparency (no normalization).
    /// - 1 `token_registry` — `supported_tokens()` returns exactly the five
    ///   v1 names in registry order.
    ///
    /// All strings are pinned as `*_utf8_hex` so the exact UTF-8 byte
    /// sequence (incl. NFD combining marks) is the contract, immune to
    /// editor/JSON-tooling normalization. `informational_*_utf8` mirrors
    /// exist for human review; the runner cross-checks them against the hex.
    #[test]
    #[ignore]
    fn emit_note_template_vectors_for_paste() {
        extern crate std;

        fn hex_lower(bytes: &[u8]) -> String {
            let mut s = String::with_capacity(bytes.len() * 2);
            for b in bytes {
                s.push_str(&alloc::format!("{:02x}", b));
            }
            s
        }

        fn json_escape(input: &str) -> String {
            let mut out = String::with_capacity(input.len() + 2);
            for c in input.chars() {
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    c if (c as u32) < 0x20 => {
                        out.push_str(&alloc::format!("\\u{:04x}", c as u32));
                    }
                    c => out.push(c),
                }
            }
            out
        }

        let mut dump = String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"note-template\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str(
            "  \"spec_section\": \"decisions.md 2026-06-07 (Note templates — deterministic {{token}} variable engine, MYND-188)\",\n",
        );
        dump.push_str("  \"description\": \"Pins protocol::template::render + protocol::template::supported_tokens — the deterministic note-template variable engine (MYND-188). render is a pure function of (template, ctx): one left-to-right pass over {{token}} placeholders against a closed, case-sensitive 5-token registry (date, time, title, datetime, weekday). Unknown tokens, format-arg shapes ({{title:foo}}) and stray/unbalanced braces pass through verbatim — that passthrough IS the escape mechanism (no \\\\{{ syntax). Substituted values are never re-scanned (single pass). The engine reads no clock and no locale: every ctx field arrives pre-formatted from the host, and the engine is byte-transparent including NFD combining sequences (no unicode normalization). 12 cases: 11 render + 1 token_registry (supported_tokens order pin). Cases generated by `cargo test -p protocol --lib emit_note_template_vectors_for_paste -- --ignored` (in protocol/src/template.rs).\",\n");
        dump.push_str("  \"cases\": [\n");

        // ---- render closure -----------------------------------------
        let emit_render = |dump: &mut String,
                           slug: &str,
                           description: &str,
                           template: &str,
                           case_ctx: &RenderContext,
                           expected: &str,
                           trailing_comma: bool| {
            // Self-validating at mint: the hand-written expectation must
            // match the engine before the vector is emitted.
            let actual = render(template, case_ctx);
            assert_eq!(
                actual, expected,
                "[{slug}] hand-written expectation disagrees with render()"
            );
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"note-template/v0.1/{}\",\n",
                slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str("      \"case_kind\": \"render\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_template_utf8_hex\": \"{}\",\n",
                hex_lower(template.as_bytes())
            ));
            dump.push_str(&alloc::format!(
                "      \"input_ctx_title_utf8_hex\": \"{}\",\n",
                hex_lower(case_ctx.title.as_bytes())
            ));
            dump.push_str(&alloc::format!(
                "      \"input_ctx_date_utf8_hex\": \"{}\",\n",
                hex_lower(case_ctx.date.as_bytes())
            ));
            dump.push_str(&alloc::format!(
                "      \"input_ctx_time_utf8_hex\": \"{}\",\n",
                hex_lower(case_ctx.time.as_bytes())
            ));
            dump.push_str(&alloc::format!(
                "      \"input_ctx_datetime_utf8_hex\": \"{}\",\n",
                hex_lower(case_ctx.datetime.as_bytes())
            ));
            dump.push_str(&alloc::format!(
                "      \"input_ctx_weekday_utf8_hex\": \"{}\",\n",
                hex_lower(case_ctx.weekday.as_bytes())
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_output_utf8_hex\": \"{}\",\n",
                hex_lower(expected.as_bytes())
            ));
            dump.push_str(&alloc::format!(
                "      \"informational_template_utf8\": \"{}\",\n",
                json_escape(template)
            ));
            dump.push_str(&alloc::format!(
                "      \"informational_output_utf8\": \"{}\"\n",
                json_escape(expected)
            ));
            if trailing_comma {
                dump.push_str("    },\n");
            } else {
                dump.push_str("    }\n");
            }
        };

        let base = ctx();

        emit_render(
            &mut dump,
            "render-all-five-tokens",
            "All five registry tokens in one template, one pass. The ctx is a local instant near a UTC day boundary (01:00 local in a +03:00 offset = 22:00 the PREVIOUS day in UTC) — the engine emits the host-injected LOCAL day, proving no engine-side UTC conversion.",
            "# {{title}} — {{weekday}} {{date}} {{time}} ({{datetime}})",
            &base,
            "# My Note — Sunday 2026-06-07 01:00 (2026-06-07 01:00)",
            true,
        );
        emit_render(
            &mut dump,
            "render-repeated-token-multiline",
            "The same token three times across newlines: every occurrence substitutes, and 0x0a bytes pass through untouched (byte-transparent scanner).",
            "{{date}}\nmid\n{{date}} and {{date}}",
            &base,
            "2026-06-07\nmid\n2026-06-07 and 2026-06-07",
            true,
        );
        emit_render(
            &mut dump,
            "render-unknown-token-verbatim",
            "An unknown token between two known ones: {{project}} is not in the registry so it passes through verbatim while its neighbors substitute. Verbatim passthrough is the escape mechanism — there is no dedicated escape syntax.",
            "{{date}} {{project}} {{title}}",
            &base,
            "2026-06-07 {{project}} My Note",
            true,
        );
        emit_render(
            &mut dump,
            "render-case-sensitive-uppercase-literal",
            "Token names match case-sensitively against the lowercase registry: {{Date}} and {{DATE}} are NOT tokens and stay literal; {{date}} substitutes.",
            "{{Date}} {{DATE}} {{date}}",
            &base,
            "{{Date}} {{DATE}} 2026-06-07",
            true,
        );
        emit_render(
            &mut dump,
            "render-format-arg-literal",
            "A format-arg-shaped placeholder: 'title:foo' is not a registry key, so the whole {{title:foo}} stays literal. There is no format/expression mini-language — the anti-plugin commitment (vision.md) expressed in bytes.",
            "{{title:foo}}",
            &base,
            "{{title:foo}}",
            true,
        );
        emit_render(
            &mut dump,
            "render-stray-unbalanced-braces",
            "Stray and unbalanced brace runs ({{ }}, lone }}, unclosed {{, single braces) all pass through verbatim without panicking — a template with no recognized token renders byte-identical to itself.",
            "{{ }} | }} | a {{ b | { single }",
            &base,
            "{{ }} | }} | a {{ b | { single }",
            true,
        );
        emit_render(
            &mut dump,
            "render-open-brace-before-token",
            "An unbalanced {{ followed by a real token: the scanner emits the literal {{ and rescans from just after it, so {{date}} still fires. Pins the rescan-after-literal-open behavior ({{ {{date}} → {{ 2026-06-07).",
            "{{ {{date}}",
            &base,
            "{{ 2026-06-07",
            true,
        );
        emit_render(
            &mut dump,
            "render-empty-template",
            "Empty template renders empty — degenerate-input pin.",
            "",
            &base,
            "",
            true,
        );
        emit_render(
            &mut dump,
            "render-empty-title",
            "An empty ctx value substitutes as the empty string: the engine has no empty-title policy of its own (SYNC-5-R — the empty-vs-prompt decision lives in the new-note UX, not here).",
            "[{{title}}]",
            &RenderContext {
                title: String::new(),
                ..ctx()
            },
            "[]",
            true,
        );
        emit_render(
            &mut dump,
            "render-title-not-rescanned",
            "THE single-pass pin: ctx.title itself contains '{{date}}'. The template's own {{date}} substitutes, but the {{date}} arriving inside the substituted title value stays literal — substituted values are never re-scanned. Any implementation that re-scans its output (or substitutes values before scanning) fails this vector. Also pins no-markdown-escaping on injected values.",
            "{{title}} / {{date}}",
            &RenderContext {
                title: "**bold** {{date}} <x>".to_string(),
                ..ctx()
            },
            "**bold** {{date}} <x> / 2026-06-07",
            true,
        );
        emit_render(
            &mut dump,
            "render-unicode-weekday-and-combining",
            "Multi-byte UTF-8 byte-transparency: a Turkish weekday (Çarşamba — the engine carries no locale logic) and a title containing an NFD combining sequence (Cafe + U+0301) plus dotless ı (U+0131). The output carries the exact input byte sequences — the engine performs NO unicode normalization (NFD stays NFD). The hex pins are the contract here; the informational mirrors may be silently NFC-normalized by JSON tooling.",
            "{{weekday}} — {{title}}",
            &RenderContext {
                title: "Cafe\u{0301} Notlar\u{0131}".to_string(),
                weekday: "Çarşamba".to_string(),
                ..ctx()
            },
            "Çarşamba — Cafe\u{0301} Notlar\u{0131}",
            true,
        );

        // ---- token_registry -----------------------------------------
        {
            let tokens = supported_tokens();
            assert_eq!(
                tokens,
                vec!["date", "time", "title", "datetime", "weekday"],
                "registry drifted — update this generator and the vector together"
            );
            dump.push_str("    {\n");
            dump.push_str("      \"vector_id\": \"note-template/v0.1/token-registry-order\",\n");
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(
                    "supported_tokens() returns exactly the five v1 token names in registry order. The order is load-bearing for UI parity (the {{ autocomplete lists tokens in this order); the SET is load-bearing for render parity — a port advertising a token it does not substitute (or vice versa) has split the single registry this category exists to pin."
                )
            ));
            dump.push_str("      \"case_kind\": \"token_registry\",\n");
            dump.push_str("      \"expected_tokens\": [");
            for (i, name) in tokens.iter().enumerate() {
                if i > 0 {
                    dump.push_str(", ");
                }
                dump.push_str(&alloc::format!("\"{}\"", name));
            }
            dump.push_str("]\n");
            dump.push_str("    }\n");
        }

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_note_template_vectors.json", dump.as_bytes())
            .expect("write note-template vectors dump");
    }
}
