// Aggregator: composes the foundational decoration extensions for the
// Phase 1 editor. Each decoration lives in its own file under
// `src/editor/decorations/` and is exported as an `Extension` so the editor
// surface (`src/editor/extensions.ts`) can compose them in a single array.
//
// PRD `editor-mvp-baseline` Implementation Decisions § "Modules to build or
// modify".

import type { Extension } from "@codemirror/state";
import { headingDecorations } from "./heading";
import { setextHeadingDecorations } from "./setext-heading";
import { emphasisDecorations } from "./emphasis";
import { inlineTypographyDecorations } from "./inline-typography";
import { emojiDecorations } from "./emoji";
import { embeddedHtmlDecorations } from "./embedded-html";
import { mathDecorations } from "./math";
import { linkDecorations } from "./link";
import { referenceLinkDecorations } from "./reference-link";
import { imageUrlDecorations } from "./image-url";
import { attachmentEmbedDecorations } from "./attachment-embed";
import { autolinkDecorations } from "./autolink";
import { inlineCodeDecorations } from "./inline-code";
import { escapeDecorations } from "./escape";
import { hardBreakDecorations } from "./hard-break";
import { listDecorations } from "./list";
import { taskListDecorations } from "./task-list";
import { blockquoteDecorations } from "./blockquote";
import { calloutDecorations } from "./callout";
import { horizontalRuleDecorations } from "./horizontal-rule";
import { frontmatterDecorations } from "./frontmatter";
import { tableDecorations } from "./table";
import { definitionListDecorations } from "./definition-list";
import { fencedCodeDecorations } from "./fenced-code";
import { mermaidDecorations } from "./mermaid";
import { footnoteDecorations } from "./footnote";

// SYNC-17 GUARD (MYND-200 / knowledge-graph-ux; `decisions.md` 2026-06-08
// "Interactive tags ship as ONE unit"): there is intentionally NO inline-`#tag`
// decoration here. Tags are recognized + indexed (`markdown-dialect.md` §3.7;
// `tagTree()`/`byTag()`) but rendered as PLAIN TEXT — the coherent invisible-
// but-indexed state. Decorating `#tag` makes it LOOK clickable; doing that
// without a browse/click target manufactures a dead affordance. So tag
// decoration may ONLY land together with the tag-browse surface (the interactive
// -tag unit). Do NOT add a `tagDecorations()` entry in an editor-polish PR — it
// must arrive in the same change as the browse surface. `tests/editor/
// tagDecorationGuard.test.ts` fails if a tag decoration is registered here.
export function myneDecorations(): readonly Extension[] {
  return [
    headingDecorations(),
    setextHeadingDecorations(),
    emphasisDecorations(),
    // Highlight / subscript / superscript inline marks (MYND-156). Same
    // cursor-aware mark+marker-hide family as emphasis.
    inlineTypographyDecorations(),
    // Emoji `:shortcode:` → glyph (MYND-156). Lazy-loaded map; unmapped stays
    // literal. Returns [field, loader, decoration].
    ...emojiDecorations(),
    // Embedded inline HTML (MYND-209): sanitized `<kbd>/<mark>/<sub>/<sup>/<abbr>`
    // off-cursor (DOMPurify, lazy). Returns [field, loader, decoration].
    ...embeddedHtmlDecorations(),
    // Math `$…$` / `$$…$$` rendering via KaTeX (MYND-48, lazy). Returns
    // [field, loader, inline, focus-field/tracker, block].
    ...mathDecorations(),
    linkDecorations(),
    referenceLinkDecorations(),
    // Non-fetching `![](url)` / `![][ref]` chips (MYND-147/149). After
    // referenceLinkDecorations so the shared `linkReferencesField` is installed.
    imageUrlDecorations(),
    // Form-C attachment embeds `![[att:<id>|filename]]` → atomic inline image /
    // PDF / tombstone (MYND-164). Needs the catalog extension (added in
    // extensions.ts) for id resolution.
    ...attachmentEmbedDecorations(),
    ...autolinkDecorations(),
    inlineCodeDecorations(),
    // Backslash-escape: hide the `\` of an `Escape` node off-cursor (MYND-208).
    escapeDecorations(),
    // Hard line break: hide trailing 2-spaces / `\` of a `HardBreak` (MYND-208).
    hardBreakDecorations(),
    // Plain bullet / ordered list glyphs + hanging indent (MYND-208). Before
    // taskListDecorations: task items are skipped by list.ts (task-list owns
    // their marker), so order is non-conflicting but keeps list rendering grouped.
    listDecorations(),
    taskListDecorations(),
    blockquoteDecorations(),
    // Callouts (MYND-47): promote `> [!TYPE]` blockquotes to styled containers.
    // Separate layer — reads the same Blockquote nodes, composes with blockquote.
    calloutDecorations(),
    horizontalRuleDecorations(),
    frontmatterDecorations(),
    tableDecorations(),
    definitionListDecorations(),
    fencedCodeDecorations(),
    // Mermaid diagrams (MYND-49): a ```mermaid fence → rendered SVG block widget
    // (lazy, async; fenced-code skips mermaid info-strings). Returns
    // [field, loader, focus-field/tracker, block].
    ...mermaidDecorations(),
    ...footnoteDecorations(),
  ];
}
