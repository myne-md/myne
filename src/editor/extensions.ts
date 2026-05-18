// Myne editor's CodeMirror 6 extension array.
//
// Per `editor-mvp-baseline` PRD (myne-agents/features/editor-mvp-baseline/prd.md)
// + grill 2026-05-16: the markdown parser reuses the lezer MarkdownConfig
// blobs from `src/dialect/lezer/` (Wikilink, InlineTag) that landed via
// MYND-42. Do NOT duplicate the parser inside `src/editor/` — the dialect
// module is the single parser surface.
//
// Note: `src/dialect/lezer/frontmatter.ts` is a runtime detection helper
// (`locateFrontmatter`), not a `MarkdownConfig`. Frontmatter decoration in
// T3 consumes that helper directly; the lezer parser does not need a
// frontmatter recognizer here because GFM treats the leading `---` as a
// thematic break, which T3's decoration overrides for line-1-anchored
// frontmatter blocks.
//
// T1 baseline composes the parser + history + minimal core. Decoration
// extensions (T2 inline marks, T3 block decorations, T4 wikilink chip,
// T5 slash/toolbar/keymap, T6 theme) land in subsequent tasks and append
// to this list.

import { EditorView, keymap } from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { type Extension } from "@codemirror/state";
import { Wikilink } from "../dialect/lezer/wikilink";
import { InlineTag } from "../dialect/lezer/inline-tag";
import { myneDecorations } from "./decorations";
import { wikilinkChipExtensions } from "./wikilink";
import { slashMenuExtension } from "./slash/plugin";
import { selectionToolbarExtension } from "./toolbar/plugin";
import { myneKeyBindings } from "./keymap";
import { myneTheme } from "./theme";

export function myneExtensions(): readonly Extension[] {
  return [
    history(),
    closeBrackets(),
    markdown({
      base: markdownLanguage,
      extensions: [Wikilink, InlineTag],
    }),
    ...myneDecorations(),
    ...wikilinkChipExtensions(),
    slashMenuExtension(),
    selectionToolbarExtension(),
    keymap.of([
      ...myneKeyBindings,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    myneTheme,
    EditorView.lineWrapping,
  ];
}
