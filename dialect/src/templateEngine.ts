// Note-template variable engine — Phase-1 desktop TypeScript implementation.
//
// This is the desktop client's runtime engine for `{{token}}` substitution in
// note templates (MYND-188). It is a **hand-mirror** of the canonical Rust
// engine in `protocol/src/template.rs`: the Rust crate is the spec-canonical
// engine and the future wasm-reuse path for the web/mobile clients; this TS
// module is what the desktop WebView calls so the new-note-from-template flow
// (MYND-190) and the `{{` autocomplete (MYND-189) reach the engine WITHOUT a new
// Tauri command crossing the WebView boundary. The same Rust↔TS hand-mirror
// discipline as `MIN_PASSWORD_LEN` (`protocol/src/password_policy.rs` + the TS
// constant) applies: both implementations must move together; a CI drift-check
// is the follow-up safety net. Behavior is pinned identically on both sides by
// equivalent unit tests (`protocol/src/template.rs` tests ↔
// `tests/dialect/templateEngine.test.ts`).
//
// Deterministic substitution only — parse → registry lookup → substitute —
// never an evaluator, expression, formula, callback, or format-argument
// mini-language (anti-plugin / no-scripting commitment, vision.md; SYNC-6-R).
// No clock or locale is read here: the host injects pre-formatted local
// date/time/datetime/weekday strings via RenderContext (SYNC-4-R).

/**
 * Host-injected substitution inputs for {@link renderTemplate}. Every field is a
 * pre-formatted string the host supplies; the engine reads no clock/locale. The
 * time-derived fields are expected to already be in **local** time and the app
 * language (`date` = `YYYY-MM-DD`, `time` = `HH:mm` 24h, `datetime` = combined,
 * `weekday` = localized day name). `title` is substituted verbatim (may be empty
 * — the empty-vs-prompt policy lives in the new-note UX, not here; SYNC-5-R).
 */
export type RenderContext = {
  title: string;
  date: string;
  time: string;
  datetime: string;
  weekday: string;
};

/**
 * The v1 token registry — the single TS source of truth consulted by both
 * {@link renderTemplate} and the `{{` autocomplete menu, so the two never drift.
 * Lowercase by contract (matching is case-sensitive). Mirrors the Rust
 * `REGISTRY` in `protocol/src/template.rs`.
 */
const REGISTRY: ReadonlyArray<[string, (ctx: RenderContext) => string]> = [
  ["date", (c) => c.date],
  ["time", (c) => c.time],
  ["title", (c) => c.title],
  ["datetime", (c) => c.datetime],
  ["weekday", (c) => c.weekday],
];

/**
 * The supported token names, sourced from the one {@link REGISTRY}. The
 * template-management UI reads its `{{` autocomplete vocabulary from here so the
 * menu can never drift from what {@link renderTemplate} actually substitutes.
 * v1: `["date", "time", "title", "datetime", "weekday"]`.
 */
export const SUPPORTED_TOKENS: readonly string[] = REGISTRY.map(([name]) => name);

function resolve(name: string, ctx: RenderContext): string | null {
  for (const [n, sel] of REGISTRY) {
    if (n === name) return sel(ctx);
  }
  return null;
}

/**
 * Render a template body by substituting each known `{{token}}` against `ctx`.
 *
 * Deterministic, eager, one-shot: every occurrence of a registry token is
 * replaced in a single left-to-right pass; unknown tokens (`{{foo}}`,
 * `{{Date}}`, `{{title:foo}}`) and stray/unbalanced braces are copied through
 * verbatim — the unknown-token passthrough doubles as the escape mechanism (no
 * `\{{`). Output is plain text — a substituted token emits only literal text.
 */
export function renderTemplate(template: string, ctx: RenderContext): string {
  let out = "";
  let rest = template;

  for (;;) {
    const open = rest.indexOf("{{");
    if (open === -1) {
      out += rest;
      break;
    }
    out += rest.slice(0, open);
    const afterOpen = rest.slice(open + 2);
    const close = afterOpen.indexOf("}}");
    const value = close === -1 ? null : resolve(afterOpen.slice(0, close), ctx);
    if (value !== null && close !== -1) {
      // Known token → substitute, advance past the `}}`.
      out += value;
      rest = afterOpen.slice(close + 2);
    } else {
      // No closer, or an unknown token / format-arg / `{{ }}` → the `{{` is
      // literal; emit it and rescan from just after it (inner braces verbatim).
      out += "{{";
      rest = afterOpen;
    }
  }

  return out;
}
