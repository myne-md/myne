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
import { linkDecorations } from "./link";
import { referenceLinkDecorations } from "./reference-link";
import { autolinkDecorations } from "./autolink";
import { inlineCodeDecorations } from "./inline-code";
import { taskListDecorations } from "./task-list";
import { blockquoteDecorations } from "./blockquote";
import { horizontalRuleDecorations } from "./horizontal-rule";
import { frontmatterDecorations } from "./frontmatter";
import { tableDecorations } from "./table";
import { definitionListDecorations } from "./definition-list";
import { fencedCodeDecorations } from "./fenced-code";
import { footnoteDecorations } from "./footnote";

export function myneDecorations(): readonly Extension[] {
  return [
    headingDecorations(),
    setextHeadingDecorations(),
    emphasisDecorations(),
    linkDecorations(),
    referenceLinkDecorations(),
    ...autolinkDecorations(),
    inlineCodeDecorations(),
    taskListDecorations(),
    blockquoteDecorations(),
    horizontalRuleDecorations(),
    frontmatterDecorations(),
    tableDecorations(),
    definitionListDecorations(),
    fencedCodeDecorations(),
    ...footnoteDecorations(),
  ];
}
