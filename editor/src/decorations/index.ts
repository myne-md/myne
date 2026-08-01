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
import { coloredHighlightDecorations } from "./colored-highlight";
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
import { taskAddAffordanceDecorations } from "./task-add-affordance";
import { blockquoteDecorations } from "./blockquote";
import { calloutDecorations } from "./callout";
import { horizontalRuleDecorations } from "./horizontal-rule";
import { frontmatterDecorations } from "./frontmatter";
import { tableDecorations } from "./table";
import { definitionListDecorations } from "./definition-list";
import { fencedCodeDecorations } from "./fenced-code";
import { mermaidDecorations } from "./mermaid";
import { footnoteDecorations } from "./footnote";
import { tagChipDecorations } from "./tag-chip";
import { taskChipDecorations } from "./task-chip";
import { taskQueryBlockDecorations } from "./task-query-block";
import { tagSuggestionBandDecorations } from "./tag-suggestion-band";
import { commentDecorations } from "./comment";

// SYNC-17 (MYND-200 / knowledge-graph-ux; `decisions.md` 2026-06-08 "Interactive
// tags ship as ONE unit"): the inline-`#tag` chip decoration ships HERE ONLY
// because the tag-browse surface (#2 `TagBrowser`, tag-system / MYND-46) now
// exists — decoration + browse are one unit; tag-decoration must NEVER land
// alone (a chip without a browse target manufactures a dead affordance). The
// chip's click opens the browser filtered to that tag. `tests/editor/
// tagDecorationGuard.test.ts` enforces "decoration ⟹ browse surface present".
export function myneDecorations(): readonly Extension[] {
  return [
    headingDecorations(),
    setextHeadingDecorations(),
    emphasisDecorations(),
    // Highlight / subscript / superscript inline marks (MYND-156). Same
    // cursor-aware mark+marker-hide family as emphasis.
    inlineTypographyDecorations(),
    // Colored highlights `<mark class="hl-*">` (MYND-637). Same hide-off-cursor /
    // `==`-skin-on-cursor treatment as yellow `==`, so they never leak raw HTML.
    // Partitioned from embeddedHtmlDecorations() by the shared
    // isOwnedHighlightClass() (sanitize.ts): each owns a disjoint set of spans, so
    // the two never both decorate one span and their order is not load-bearing.
    coloredHighlightDecorations(),
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
    // Inline task-field chips (MYND-614) — kept adjacent to the task-list layer
    // they belong with, so a reader finds both halves of task rendering in one
    // place. They are inline replace decorations like the tag chip, but carry no
    // ordering dependency on the inline layers below: their spans come from
    // `TaskField` nodes, which no other decoration claims.
    ...taskChipDecorations(),
    // The `+` "add task field" affordance at the end of a task line, cursor-
    // gated. Sits with the task layers it belongs to; a point widget with no
    // atomic-range or ordering dependency (its span is `line.to`, which no other
    // decoration claims). Ships WITH the menu + slash entry points it drives.
    taskAddAffordanceDecorations(),
    // Task-query blocks (MYND-617) sit next to the chips: same feature
    // family, and the fenced-code card skips this info string for them.
    ...taskQueryBlockDecorations(),
    blockquoteDecorations(),
    // Callouts (MYND-47): promote `> [!TYPE]` blockquotes to styled containers.
    // Separate layer — reads the same Blockquote nodes, composes with blockquote.
    calloutDecorations(),
    horizontalRuleDecorations(),
    frontmatterDecorations(),
    // The inline tag-suggestion band (MYND-651) — a block widget on the
    // frontmatter/body boundary, so it belongs next to the frontmatter layer it
    // anchors against. Absent entirely when the host has pushed no suggestions,
    // which is the default state of every note. Inside this stack on purpose:
    // source mode empties it, and raw markdown is what source mode promises.
    ...tagSuggestionBandDecorations(),
    tableDecorations(),
    definitionListDecorations(),
    fencedCodeDecorations(),
    // Mermaid diagrams (MYND-49): a ```mermaid fence → rendered SVG block widget
    // (lazy, async; fenced-code skips mermaid info-strings). Returns
    // [field, loader, focus-field/tracker, block].
    ...mermaidDecorations(),
    ...footnoteDecorations(),
    // Inline #tag chips (tag-system #3 / MYND-45). Cursor-aware replace widget +
    // atomic ranges + click→`myne-open-tag`. Ships with the browse surface (#2),
    // SYNC-17. Last so it composes over the inline layers without ordering deps.
    ...tagChipDecorations(),
    // Dialect comments `%%…%%` (MYND-315): inline span hidden off-cursor +
    // multi-line block line-collapse, both revealed raw on-cursor. Render-only,
    // bytes preserved (§6 C1). Last — purely subtractive, no ordering deps.
    ...commentDecorations(),
  ];
}
