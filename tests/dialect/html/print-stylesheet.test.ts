// Print stylesheet coverage guard (MYND-255 task 3).
//
// The class vocabulary below is PINNED — it is the emitter's complete emitted
// class set as documented in myne-agents/features/note-export-pdf/progress.md
// (task 2 handoff). If the emitter grows a class, add it BOTH there and here,
// and style it in print-stylesheet.ts — this test failing loudly on drift is
// the point. Also pins the pagination rules, the embedded light token values,
// and the zero-branding posture (PRD story 5).

import { describe, expect, it } from "vitest";
import { PRINT_CSS } from "../../../src/dialect/html/print-stylesheet";

/** Every class the emitter puts on an element (progress.md task-2 handoff).
 *  The 22 `callout-<type>` classes are intentionally absent: the tone classes
 *  are the visual contract (types map N:1 onto tones). */
const EMITTER_CLASS_VOCABULARY = [
  // frontmatter projection
  "note-title",
  // task lists
  "task-list-item",
  "task-checkbox",
  // callouts
  "callout",
  "callout-tone-info",
  "callout-tone-success",
  "callout-tone-warning",
  "callout-tone-danger",
  "callout-tone-accent",
  "callout-title",
  // code
  "code-card",
  "mermaid-fallback",
  // mermaid
  "mermaid-diagram",
  // math
  "math",
  "math-inline",
  "math-block",
  "math-error",
  // footnotes
  "footnote-ref",
  "footnotes",
  "footnote-list",
  "footnote-item",
  // wikilinks / embeds / raw html
  "wikilink",
  "embed-placeholder",
  "embedded-html",
  "embedded-html-block",
  "raw-html",
  // attachments
  "att-image",
  "att-excluded",
  "att-placeholder",
  // inline
  "highlight",
] as const;

/** classHighlighter token classes the highlighted code cards emit
 *  (renderers.ts; set documented in progress.md). */
const TOK_CLASS_VOCABULARY = [
  "tok-keyword",
  "tok-string",
  "tok-comment",
  "tok-number",
  "tok-variableName",
  "tok-propertyName",
  "tok-typeName",
  "tok-operator",
  "tok-punctuation",
  "tok-meta",
  "tok-inserted",
  "tok-deleted",
  "tok-invalid",
] as const;

/** Plain elements the emitter uses (progress.md): styled by tag. */
const ELEMENT_VOCABULARY = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "ul", "ol", "li",
  "blockquote",
  "table", "thead", "th", "td", "tr",
  "hr",
  "dl", "dt", "dd",
  "code",
  "a",
  "em", "strong", "del",
  "img",
] as const;

/** `.cls` present as a selector token (not merely a prefix of a longer class). */
function classSelector(cls: string): RegExp {
  return new RegExp(`\\.${cls}(?![\\w-])`);
}

/** Element selector token at a rule position (start of line, or after a
 *  comma/combinator/brace), not inside a word. */
function elementSelector(el: string): RegExp {
  return new RegExp(`(?:^|[\\s,}>+~])${el}(?=[\\s,{:.\\[])`, "m");
}

describe("emitter class vocabulary coverage", () => {
  it.each(EMITTER_CLASS_VOCABULARY)("styles .%s", (cls) => {
    expect(PRINT_CSS).toMatch(classSelector(cls));
  });

  it.each(TOK_CLASS_VOCABULARY)("styles syntax class .%s", (cls) => {
    expect(PRINT_CSS).toMatch(classSelector(cls));
  });

  it.each(ELEMENT_VOCABULARY)("styles element %s", (el) => {
    expect(PRINT_CSS).toMatch(elementSelector(el));
  });

  it("targets highlighted cards via the data-lang attribute", () => {
    expect(PRINT_CSS).toContain(".code-card[data-lang]");
  });

  it("targets the checked task state via data-checked", () => {
    expect(PRINT_CSS).toContain('[data-checked="true"]');
  });
});

describe("page geometry + pagination rules", () => {
  it("fixes the page margin at 20mm", () => {
    expect(PRINT_CSS).toMatch(/@page\s*\{\s*margin:\s*20mm;\s*\}/);
  });

  it("leaves the @page size to the geometry module", () => {
    expect(PRINT_CSS).not.toMatch(/size:\s*(A4|Letter)/);
  });

  it("keeps headings attached to their content and unbroken", () => {
    const headings = PRINT_CSS.match(/h1, h2, h3, h4, h5, h6 \{[^}]*\}/)?.[0];
    expect(headings).toBeDefined();
    expect(headings).toContain("break-after: avoid");
    expect(headings).toContain("break-inside: avoid");
    expect(headings).toContain("page-break-after: avoid");
  });

  it("controls paragraph widows/orphans", () => {
    const p = PRINT_CSS.match(/(?:^|\n)p \{[^}]*\}/)?.[0];
    expect(p).toBeDefined();
    expect(p).toContain("widows: 2");
    expect(p).toContain("orphans: 2");
  });

  it("avoids breaking inside code cards, with line-level orphan control", () => {
    const card = PRINT_CSS.match(/\.code-card \{[^}]*\}/)?.[0];
    expect(card).toBeDefined();
    expect(card).toContain("break-inside: avoid");
    expect(card).toContain("widows: 3");
    expect(card).toContain("orphans: 3");
  });

  it("avoids breaking inside table rows, images, diagrams, and callouts", () => {
    for (const sel of [
      /tr \{[^}]*break-inside: avoid/,
      /\.att-image \{[^}]*break-inside: avoid/,
      /\.mermaid-diagram \{[^}]*break-inside: avoid/,
      /\.callout \{[^}]*break-inside: avoid/,
    ]) {
      expect(PRINT_CSS).toMatch(sel);
    }
  });

  it("repeats table headers across page breaks", () => {
    expect(PRINT_CSS).toMatch(/thead\s*\{[^}]*table-header-group/);
  });
});

describe("design-token fidelity (light palette, embedded values)", () => {
  // Standalone document: the print CSS must EMBED the light token values
  // (myne-agents/docs/design/colors_and_type.css :root). Spot-pin the load-bearing ones.
  it.each([
    ["--fg-1", "#1a1a17"],
    ["--fg-2", "#3a3934"],
    ["--fg-3", "#6b6a64"],
    ["--paper-2", "#f4f4f2"],
    ["--line-1", "#e3e2dd"],
    ["--accent", "#2c4a7a"],
    ["--accent-soft", "#e8edf5"],
    ["--danger", "#8a2a23"],
    ["--danger-soft", "#f5e7e5"],
    ["--warning", "#8a6a1f"],
    ["--warning-soft", "#f5efde"],
    ["--success", "#2f6048"],
    ["--success-soft", "#e3eee8"],
    ["--highlight", "#f3e7c4"],
    ["--syntax-keyword", "#7a3b8c"],
    ["--syntax-string", "#3f6a4a"],
    ["--syntax-comment", "#706f66"],
    ["--syntax-number", "#9a5d2a"],
    ["--syntax-variable", "#1a1a17"],
    ["--syntax-property", "#2c4a7a"],
    ["--syntax-function", "#1f5c6e"],
    ["--syntax-type", "#8a5a1f"],
    ["--syntax-operator", "#5c5b54"],
    ["--syntax-tag", "#8a2a23"],
    ["--syntax-meta", "#5a5478"],
    ["--syntax-invalid", "#992018"],
  ])("embeds %s: %s", (token, value) => {
    // Tokens/values are [-\w#] only — no regex metacharacters to escape.
    expect(PRINT_CSS).toMatch(new RegExp(`${token}:\\s*${value}`));
  });

  it("names the bundled font families with system fallbacks", () => {
    expect(PRINT_CSS).toContain('"Inter Variable"');
    expect(PRINT_CSS).toContain('"JetBrains Mono"');
    expect(PRINT_CSS).toMatch(/sans-serif/);
    expect(PRINT_CSS).toMatch(/\bmonospace\b/);
    // Faces are served by the capture template — no @font-face/url() here.
    expect(PRINT_CSS).not.toContain("@font-face");
    expect(PRINT_CSS).not.toContain("url(");
  });

  it("sets the Penpot body type: 13px / 1.6 on --fg-2", () => {
    // Anchors on font-size so the `html, body` margin reset block is skipped.
    const body = PRINT_CSS.match(/\nbody \{[^}]*font-size[^}]*\}/)?.[0];
    expect(body).toBeDefined();
    expect(body).toContain("font-size: 13px");
    expect(body).toContain("line-height: 1.6");
    expect(body).toContain("color: var(--fg-2)");
  });

  it("sets the Penpot title + H2 scale", () => {
    const title = PRINT_CSS.match(/\.note-title \{[^}]*\}/)?.[0];
    expect(title).toBeDefined();
    expect(title).toContain("font-size: 26px");
    expect(title).toContain("font-weight: 600");
    expect(title).toContain("color: var(--fg-1)");
    expect(PRINT_CSS).toMatch(/h2 \{ font-size: 19px/);
  });

  it("keeps background colors printable", () => {
    expect(PRINT_CSS).toContain("print-color-adjust: exact");
  });
});

describe("zero branding (PRD story 5)", () => {
  it("contains no product or generator strings", () => {
    const lower = PRINT_CSS.toLowerCase();
    expect(lower).not.toContain("myne");
    expect(lower).not.toContain("made with");
    expect(lower).not.toContain("generated");
    expect(lower).not.toContain("watermark");
  });
});
