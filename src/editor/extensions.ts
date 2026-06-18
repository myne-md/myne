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

import { EditorView, drawSelection, highlightActiveLine, keymap } from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Subscript, Superscript, Emoji } from "@lezer/markdown";
import { EditorState, type Extension } from "@codemirror/state";
import { Wikilink } from "../dialect/lezer/wikilink";
import { InlineTag } from "../dialect/lezer/inline-tag";
import { DefinitionList } from "../dialect/lezer/definition-list";
import { Footnote } from "../dialect/lezer/footnote";
import { Highlight } from "../dialect/lezer/highlight";
import { Math } from "../dialect/lezer/math";
import { Comment } from "../dialect/lezer/comment";
import { codeNestMarkdownExtension, codeSyntaxHighlighting } from "./code-highlight";
import { autoCloseFenceKeymap } from "./auto-close-fence";
import { viewModeExtension, type ViewMode } from "./view-mode";
import { tableKeymap } from "./decorations/table";
import { wikilinkChipExtensions } from "./wikilink";
import { noteSetExtension } from "./wikilink/note-set";
import { lineNumbersExtension } from "./line-numbers";
import { wikilinkHoverExtension } from "./wikilink/hover";
import { wikilinkPickerExtension } from "./wikilink/picker";
import { activeViewExtension } from "./active-view";
import { attachmentCatalogExtension } from "./attachments/catalog";
import { attachmentPasteDropExtension } from "./attachments/paste-drop";
import { attachmentInsertPlaceholderExtension } from "./attachments/insert-placeholder";
import { slashMenuExtension } from "./slash/plugin";
import { templateTokenMenuExtension } from "./template-tokens/plugin";
import { selectionToolbarExtension } from "./toolbar/plugin";
import { completionExtension } from "./completion";
import { clickCollapseExtension } from "./click-collapse";
import { myneFolding } from "./folding";
import { findExtension } from "./find/find-extension";
import { spellDecorations } from "./decorations/spell";
import { spellCorrectionMenu } from "./spell/correction-menu";
import { myneKeyBindings } from "./keymap";
import { selectionCountObserver } from "./selection-count";
import { focusModeExtension } from "./focus-mode";
import { myneTheme } from "./theme";

export function myneExtensions(opts?: { viewMode?: ViewMode; readOnly?: boolean }): readonly Extension[] {
  const viewMode = opts?.viewMode ?? "live";
  const readOnly = opts?.readOnly ?? false;
  return [
    history(),
    closeBrackets(),
    // Multi-cursor / multiple selections (MYND-306). Two pieces:
    //   1. Enable the facet — CM6 defaults `allowMultipleSelections` to false,
    //      so transactions collapse to the primary range. Flipping it on is the
    //      single required enablement; Alt-click add-cursor (CM6 native
    //      `mouseSelectionStyle`) and vertical add-cursor `Mod-Alt-↑/↓` (already
    //      in the installed `defaultKeymap`) then work, and `Mod-d` →
    //      `selectNextOccurrence` is bound in `keymap.ts`. Always-on (no pref).
    //   2. drawSelection() (SYNC-3): this feature OWNS the single drawSelection()
    //      insertion — heading-list-folding (MYND-300) deliberately did NOT add
    //      it and must NOT re-add it. Load-bearing: without it the browser paints
    //      only the primary cursor even when multiple selections exist in state.
    //      Mounted once, early, so it takes over cursor painting before the
    //      decoration / cursor-aware-reveal layers run.
    EditorState.allowMultipleSelections.of(true),
    drawSelection(),
    // focus-mode (MYND-348): mark the active line(s) so focus-mode line-dimming
    // (pure CSS, gated by the editor's `data-focus-dim` ancestor in tokens.css)
    // can keep them bright. The active-line BACKGROUND is neutralized in theme.ts
    // so this is invisible in normal mode — it only supplies the `.cm-activeLine`
    // class the dim rule un-dims.
    highlightActiveLine(),
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
        // Dialect comments `%%…%%` (MYND-315). Must match parser.ts. Hidden
        // off-cursor by commentDecorations(); never emitted/rewritten (§6 C1).
        Comment,
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
    // View-mode compartments (reading-source-modes, MYND-299): the live-preview
    // decoration stack + editability, seeded from the tab's mode. Source mode
    // empties the decorations (raw markdown, syntax highlight still on); reading
    // mode makes the view non-editable so cursor-aware reveal stays off and
    // everything renders. Reconfigured live by CMEditor via reconfigureViewMode().
    viewModeExtension(viewMode, readOnly),
    // WL-5: the live resolver note-set facet (seeded empty; the host
    // reconfigures it from `useResolverNotes()`). MUST precede the chip + hover
    // so the facet exists when they read it.
    noteSetExtension(),
    ...wikilinkChipExtensions(),
    // Hover-tooltip R1 (§6.2): resolved path / "(N matches)" / "(no match)".
    wikilinkHoverExtension(),
    slashMenuExtension(),
    // `[[` note picker (MYND-38) — fuzzy note search → canonical §3 emit. Reads
    // the WL-5 note-set facet; reuses the slash-menu surface + fuzzyFilter.
    wikilinkPickerExtension(),
    // `{{` token autocomplete — active only inside a `template: true` note
    // (MYND-189). Sits alongside the slash menu; both are floating menus.
    templateTokenMenuExtension(),
    selectionToolbarExtension(),
    // @codemirror/autocomplete — emoji `:` (inserts the glyph, MYND-156) + inline
    // `#tag` (suggests existing tags, MYND-45). Both override-sources in ONE
    // config (`completion.ts`) so they coexist.
    completionExtension(),
    // Heading-section + nested-list folding (MYND-300): mounts codeFolding() +
    // a hover-reveal foldGutter() + the custom list-fold service. Heading-section
    // fold ranges come free from lang-markdown's headerIndent foldService;
    // mounting the gutter surfaces them. Fold state is EPHEMERAL (no persistence)
    // — CM6 drops it on unmount, which is the note-switch / lock / quit reset.
    myneFolding(),
    // Collapse the spurious tiny selection a plain click makes when the
    // cursor-aware reveal reflows the clicked line (e.g. an H1 re-showing `# `).
    clickCollapseExtension(),
    // In-note find (MYND-175): keeps the @codemirror/search engine, swaps the
    // stock panel for the Myne-styled docked bar. Cmd/Ctrl+F is owned by the
    // window-level listener in App.tsx, NOT bound in the keymap below.
    ...findExtension(),
    // Spell-check squiggles (MYND-264): debounced viewport scan → Rust engine
    // IPC → wavy-underline marks on misspelled words, markdown-aware (SYNC-3),
    // cursor-aware (SYNC-9). Default-on (SYNC-15); the `spell_enabled` pref gate
    // (mount/unmount) lands with the MYND-267 settings wiring.
    ...spellDecorations(),
    // Right-click-on-squiggle correction menu (MYND-265): suggestions + add to
    // dictionary / ignore (vault / session). Surgical byte-stable corrections.
    ...spellCorrectionMenu(),
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
    // Optional line-number gutter (editor-line-numbers, MYND-314), seeded OFF
    // (prose-first default). Lives in a CM6 Compartment so the host can
    // reconfigure it live on the `editor_line_numbers` pref change (SYNC-3
    // addendum) without a remount. Stock `lineNumbers()` numbers logical lines.
    lineNumbersExtension(),
    // Disable the WebView's native OS spellchecker on the editor content
    // (SYNC-5, MYND-264). Myne ships its own fully-offline spell-check; leaving
    // the native speller on would double-underline against the custom squiggle
    // layer and, on some platforms, route note words to an OS/network spell
    // service — a privacy regression. The custom layer is the only spell UI.
    EditorView.contentAttributes.of({ spellcheck: "false" }),
    // Register the focused view so command-palette actions (R2 convert, MYND-84)
    // can reach the active pane's view + WL-5 note-set.
    activeViewExtension(),
    // Multi-cursor observability (MYND-306, SYNC-8): mirror the active
    // selection-range count onto the editor DOM as `data-selection-count` so
    // E2E can assert multi-cursor state. Observability-only — no chrome.
    ...selectionCountObserver(),
    // focus-mode (MYND-348): typewriter scroll — always mounted, inert unless the
    // editor's `data-focus-typewriter` ancestor gate is present (focusActive &&
    // pref). Keeps the active line vertically centered as the cursor moves.
    focusModeExtension(),
  ];
}
