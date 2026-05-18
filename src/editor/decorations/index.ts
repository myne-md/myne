// Aggregator: composes the foundational decoration extensions for the
// Phase 1 editor. Each decoration lives in its own file under
// `src/editor/decorations/` and is exported as an `Extension` so the editor
// surface (`src/editor/extensions.ts`) can compose them in a single array.
//
// PRD `editor-mvp-baseline` Implementation Decisions § "Modules to build or
// modify".

import type { Extension } from "@codemirror/state";
import { headingDecorations } from "./heading";
import { emphasisDecorations } from "./emphasis";
import { linkDecorations } from "./link";
import { inlineCodeDecorations } from "./inline-code";
import { taskListDecorations } from "./task-list";
import { blockquoteDecorations } from "./blockquote";
import { horizontalRuleDecorations } from "./horizontal-rule";
import { frontmatterDecorations } from "./frontmatter";

export function myneDecorations(): readonly Extension[] {
  return [
    headingDecorations(),
    emphasisDecorations(),
    linkDecorations(),
    inlineCodeDecorations(),
    taskListDecorations(),
    blockquoteDecorations(),
    horizontalRuleDecorations(),
    frontmatterDecorations(),
  ];
}
