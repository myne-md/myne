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
import { Subscript, Superscript, Emoji } from "@lezer/markdown";
import { type Extension } from "@codemirror/state";
import { Wikilink } from "../dialect/lezer/wikilink";
import { InlineTag } from "../dialect/lezer/inline-tag";
import { DefinitionList } from "../dialect/lezer/definition-list";
import { Footnote } from "../dialect/lezer/footnote";
import { Highlight } from "../dialect/lezer/highlight";
import { Math } from "../dialect/lezer/math";
import { codeNestMarkdownExtension, codeSyntaxHighlighting } from "./code-highlight";
import { autoCloseFenceKeymap } from "./auto-close-fence";
import { myneDecorations } from "./decorations";
import { tableKeymap } from "./decorations/table";
import { wikilinkChipExtensions } from "./wikilink";
import { attachmentCatalogExtension } from "./attachments/catalog";
import { attachmentPasteDropExtension } from "./attachments/paste-drop";
import { attachmentInsertPlaceholderExtension } from "./attachments/insert-placeholder";
import { slashMenuExtension } from "./slash/plugin";
import { templateTokenMenuExtension } from "./template-tokens/plugin";
import { selectionToolbarExtension } from "./toolbar/plugin";
import { emojiCompletionExtension } from "./emoji-complete";
import { clickCollapseExtension } from "./click-collapse";
import { findExtension } from "./find/find-extension";
import { myneKeyBindings } from "./keymap";
import { myneTheme } from "./theme";

export function myneExtensions(): readonly Extension[] {
  return [
    history(),
    closeBrackets(),
    markdown({
      base: markdownLanguage,
      // codeNestMarkdownExtension nests per-language Lezer parsers into closed
      // fenced blocks (MYND-154). NOT the stock `codeLanguages` option — see
      // code-highlight.ts. Do not also pass `codeLanguages` (would double-nest).
      extensions: [
        Wikilink,
        InlineTag,
        DefinitionList,
        Footnote,
        // Inline typography (MYND-156): `==highlight==`, `~sub~`, `^sup^`,
        // emoji `:shortcode:`. Sub/Super/Emoji are pre-built @lezer/markdown
        // configs; Highlight is hand-rolled. Must match parser.ts registration.
        Subscript,
        Superscript,
        Emoji,
        Highlight,
        Math,
        codeNestMarkdownExtension,
      ],
    }),
    codeSyntaxHighlighting,
    // Attachment catalog (MYND-164): loads `catalog_list` once on mount into a
    // StateField the form-C embed decorator resolves ids against. Composed
    // before the decorations so the field exists when they first build.
    ...attachmentCatalogExtension(),
    // Attachment INSERT (MYND-164): paste an image / drop image-SVG-PDF files
    // into the editor → bytes → `attachment_import` → form-C embed at the
    // cursor. WebView HTML5 DnD only (`dragDropEnabled` stays false, SYNC-10);
    // returns un-consumed for plain text paste/drop so they keep working.
    attachmentPasteDropExtension(),
    // Optimistic in-editor "Importing…" progress chip at the cursor while an
    // import is in flight (MYND-164 polish). Decoration-only — never writes to
    // the doc, so the placeholder can't be persisted.
    attachmentInsertPlaceholderExtension(),
    ...myneDecorations(),
    ...wikilinkChipExtensions(),
    slashMenuExtension(),
    // `{{` token autocomplete — active only inside a `template: true` note
    // (MYND-189). Sits alongside the slash menu; both are floating menus.
    templateTokenMenuExtension(),
    selectionToolbarExtension(),
    // Emoji `:` autocomplete (MYND-156) — inserts the unicode glyph. Built on
    // @codemirror/autocomplete; the source awaits the lazy emoji map.
    emojiCompletionExtension(),
    // Collapse the spurious tiny selection a plain click makes when the
    // cursor-aware reveal reflows the clicked line (e.g. an H1 re-showing `# `).
    clickCollapseExtension(),
    // In-note find (MYND-175): keeps the @codemirror/search engine, swaps the
    // stock panel for the Myne-styled docked bar. Cmd/Ctrl+F is owned by the
    // window-level listener in App.tsx, NOT bound in the keymap below.
    ...findExtension(),
    keymap.of([
      ...myneKeyBindings,
      // Before defaultKeymap so Arrow Up/Down can enter a table block (which
      // CM would otherwise skip over) instead of the default vertical move.
      ...tableKeymap,
      // Before defaultKeymap so Enter on an opening fence completes the block
      // (inserts the closing ```) instead of a plain newline (MYND-154).
      ...autoCloseFenceKeymap,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    myneTheme,
    EditorView.lineWrapping,
  ];
}
