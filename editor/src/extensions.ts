// Myne editor's CodeMirror 6 extension array.
//
// Per `editor-mvp-baseline` PRD (agent-tooling/features/editor-mvp-baseline/prd.md)
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

// The package's only unconditional stylesheet — one `[hidden]` reset that the
// platform default cannot enforce on its own. Loaded here because this module is
// what every mounted editor pulls in; the package's other sheets arrive lazily.
// See the file's own header for why the rule exists.
import "./base.css";

import { EditorView, drawSelection, highlightActiveLine, keymap } from "@codemirror/view";
import {
  defaultKeymap,
  history,
  undoSelection,
} from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Subscript, Superscript, Emoji } from "@lezer/markdown";
import {
  Compartment,
  EditorState,
  type Extension,
  type StateEffect,
} from "@codemirror/state";
import { Wikilink } from "@myne/dialect/lezer/wikilink";
import { InlineTag } from "@myne/dialect/lezer/inline-tag";
import { DefinitionList } from "@myne/dialect/lezer/definition-list";
import { Footnote } from "@myne/dialect/lezer/footnote";
import { Highlight } from "@myne/dialect/lezer/highlight";
import { Math } from "@myne/dialect/lezer/math";
import { Comment } from "@myne/dialect/lezer/comment";
import { TaskField } from "@myne/dialect/lezer/task-field";
import { codeNestMarkdownExtension, codeSyntaxHighlighting } from "./code-highlight";
import { autoCloseFenceKeymap } from "./auto-close-fence";
import { lineBoundaryKeymap } from "./line-boundary";
import { viewModeExtension, type ViewMode } from "./view-mode";
import { textDirectionExtension } from "./direction";
import { tableKeymap } from "./decorations/table";
import { wikilinkChipExtensions } from "./wikilink";
import { noteSetExtension } from "./wikilink/note-set";
import { drawingEmbedIoExtension } from "./drawing/embed-io";
import { activeDrawingEmbedField } from "./decorations/drawing-embed";
import { lineNumbersExtension } from "./line-numbers";
import { wikilinkHoverExtension } from "./wikilink/hover";
import { wikilinkPickerExtension } from "./wikilink/picker";
import { activeViewExtension } from "./active-view";
import { attachmentCatalogExtension } from "./attachments/catalog";
import { coverBannerExtension } from "./decorations/cover-banner";
import { attachmentPasteDropExtension } from "./attachments/paste-drop";
import { attachmentInsertPlaceholderExtension } from "./attachments/insert-placeholder";
import { slashMenuExtension } from "./slash/plugin";
import { aiSlashEnabledFacet } from "./slash/aiSlash";
import { transcriptionEnabledFacet } from "./attachments/transcription-gate";
import { ghostTextExtension } from "./ai/ghostText";

// AI surface (slash AI commands + inline ghost-text) lives in a CM6 Compartment
// so `ai_enabled` — and the excluded-folder gate the host folds into it — can be
// toggled LIVE without a remount. Turning AI off (or opening a note in an
// excluded folder) mid-session must actually stop ghost-text from feeding note
// content to the model; seeding this at mount and never reconfiguring (the prior
// bug) left ghost-text running after the pref flipped.
const aiCompartment = new Compartment();

/** The AI surface for a given enabled state: the slash-menu AI facet + (only
 *  when on) the ghost-text extension. `enabled` is the `ai_enabled` pref AND the
 *  not-excluded-folder gate ANDed by the host. */
export function aiSurface(enabled: boolean): Extension {
  return [
    aiSlashEnabledFacet.of(enabled),
    ...(enabled ? ghostTextExtension() : []),
  ];
}

/** Reconfigure the live AI surface (host dispatches this on an `ai_enabled` /
 *  excluded-folder change) — re-mount-free, cursor/scroll/undo preserved. */
export function reconfigureAi(enabled: boolean): StateEffect<unknown> {
  return aiCompartment.reconfigure(aiSurface(enabled));
}

/** Compartment for the transcription gate — separate from the AI one because
 *  the two switches are independent (MYND-592) and flip on different events. */
const transcriptionCompartment = new Compartment();

/** The transcription surface for a given enabled state. Only the facet today;
 *  it exists as a function so a future transcription-only extension has an
 *  obvious home, mirroring `aiSurface`. */
export function transcriptionSurface(enabled: boolean): Extension {
  return [transcriptionEnabledFacet.of(enabled)];
}

/** Reconfigure the live transcription gate (host dispatches this on a
 *  `transcription_enabled` change) — re-mount-free, like `reconfigureAi`. */
export function reconfigureTranscription(enabled: boolean): StateEffect<unknown> {
  return transcriptionCompartment.reconfigure(transcriptionSurface(enabled));
}

// The rebindable editor keymap lives in its own Compartment (#184 track B) so a
// Hotkeys-panel rebind of an editor command (bold, undo, indent, …) takes effect
// LIVE — the host dispatches `reconfigureEditorKeymap(prefs.keymap)` on a
// `vault.prefs.keymap` change, no remount, cursor/scroll/undo preserved. Seeded
// from the current overrides at mount (an already-customised keymap applies on
// first open).
const editorKeymapCompartment = new Compartment();

/** The rebindable editor keymap for a given override map (`vault.prefs.keymap`).
 *  `buildMyneKeymap` resolves `override ?? default` per command id. */
export function editorKeymapSurface(
  overrides: Readonly<Record<string, readonly string[]>>,
): Extension {
  return keymap.of(buildMyneKeymap(overrides));
}

/** Reconfigure the live rebindable editor keymap (host dispatches this on a
 *  `vault.prefs.keymap` change) — re-mount-free, like `reconfigureAi`. */
export function reconfigureEditorKeymap(
  overrides: Readonly<Record<string, readonly string[]>>,
): StateEffect<unknown> {
  return editorKeymapCompartment.reconfigure(editorKeymapSurface(overrides));
}
import { templateTokenMenuExtension } from "./template-tokens/plugin";
import { selectionToolbarExtension } from "./toolbar/plugin";
import { completionExtension } from "./completion";
import { clickCollapseExtension } from "./click-collapse";
import { myneFolding } from "./folding";
import { findExtension } from "./find/find-extension";
import { spellDecorations } from "./decorations/spell";
import { spellCorrectionMenu } from "./spell/correction-menu";
import { buildMyneKeymap, collapseMultiSelection } from "./keymap";
import { vimExtension } from "./vim";
import { selectionCountObserver } from "./selection-count";
import { focusModeExtension } from "./focus-mode";
import { scrollSlackExtension } from "./scroll-slack";
import { myneTheme } from "./theme";

export function myneExtensions(opts?: {
  viewMode?: ViewMode;
  readOnly?: boolean;
  aiEnabled?: boolean;
  /** Whether speech-to-text is offered on audio attachments (MYND-592).
   *  Default TRUE — an opt-OUT, the opposite polarity from `aiEnabled`, and
   *  independent of it: transcription is a product feature with a bundled
   *  model, not part of the AI beta. */
  transcriptionEnabled?: boolean;
  /** Mount the floating selection toolbar (MYND-559). Default TRUE — desktop's
   *  formatting surface. Mobile passes `false`: it drives formatting from the
   *  above-keyboard `FormatBar` (via `onReady`), so the floating toolbar would be
   *  a second surface offering the same commands. A host that turns this off gets
   *  no toolbar plugin at all — no listeners, no DOM node, no measure work —
   *  rather than a CSS-hidden one that still mounts. */
  selectionToolbar?: boolean;
  /** #184: the user keymap overrides (`vault.prefs.keymap`, id → chords) that
   *  seed the rebindable editor keymap Compartment. Pushed live on change via
   *  `reconfigureEditorKeymap`. Absent → in-code defaults. */
  keymapOverrides?: Readonly<Record<string, readonly string[]>>;
}): readonly Extension[] {
  const viewMode = opts?.viewMode ?? "live";
  const readOnly = opts?.readOnly ?? false;
  const selectionToolbar = opts?.selectionToolbar ?? true;
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
        // Inline task fields (MYND-611): `[due:: 2026-08-01]` and the Obsidian
        // emoji form. Must match parser.ts. Without it the editor's tree has no
        // `TaskField` node at all, and everything keyed on one silently does
        // nothing: the chips never render (`chipRangesIn` finds no nodes) and
        // spell-skip never skips a field's value.
        TaskField,
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
    // The note's cover banner (myne-md/myne#410): a block widget at position 0,
    // above the frontmatter Properties block. Composed AFTER the catalog
    // extension for the same reason the embed decorations are — it resolves the
    // cover id against `catalogField`, which must exist when it first builds.
    ...coverBannerExtension(),
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
    // Inline drawing embeds (MYND-634): the host-injected note-CRUD IO seam +
    // the transient edit-in-place state. Mounted mode-INDEPENDENTLY (unlike the
    // drawing-embed decoration, which is inside the view-mode stack) so the IO
    // seam can be reconfigured and the active state survives a live↔source switch.
    drawingEmbedIoExtension(),
    activeDrawingEmbedField,
    // RTL / bidi (myne#172): per-line `dir=auto` + `perLineTextDirection` so
    // mixed RTL+LTR notes edit and render correctly. Mounted here, OUTSIDE the
    // view-mode compartment, so raw-markdown RTL still resolves in source mode.
    textDirectionExtension(),
    ...wikilinkChipExtensions(),
    // Hover-tooltip R1 (§6.2): resolved path / "(N matches)" / "(no match)".
    wikilinkHoverExtension(),
    slashMenuExtension(),
    // AI surface (slash AI commands + ghost-text) in a live-reconfigurable
    // compartment so `ai_enabled` / excluded-folder changes take effect without
    // a remount (see `reconfigureAi`). Off = zero ghost field / trigger / keymap
    // and the base slash menu only.
    aiCompartment.of(aiSurface(opts?.aiEnabled ?? false)),
    transcriptionCompartment.of(transcriptionSurface(opts?.transcriptionEnabled ?? true)),
    // `[[` note picker (MYND-38) — fuzzy note search → canonical §3 emit. Reads
    // the WL-5 note-set facet; reuses the slash-menu surface + fuzzyFilter.
    wikilinkPickerExtension(),
    // `{{` token autocomplete — active only inside a `template: true` note
    // (MYND-189). Sits alongside the slash menu; both are floating menus.
    templateTokenMenuExtension(),
    // The floating selection toolbar — desktop's formatting surface, opt-OUT via
    // `selectionToolbar: false` (MYND-559) for hosts that own their own bar.
    ...(selectionToolbar ? [selectionToolbarExtension()] : []),
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
    // The rebindable editor commands (bold, undo, indent, fold, …) — in a
    // Compartment so a Hotkeys-panel rebind reconfigures them live (#184). FIRST,
    // so Mod-a's scoped select-all shadows defaultKeymap's selectAll (earlier
    // wins), exactly as the old inline `myneKeyBindings` did.
    editorKeymapCompartment.of(editorKeymapSurface(opts?.keymapOverrides ?? {})),
    keymap.of([
      // Fixed (never listed / rebindable): Escape collapses a multi-selection
      // (widget-nav, guarded so it falls through when not multi), and Mod-u is
      // the obscure undoSelection formerly in `historyKeymap`.
      { key: "Escape", run: collapseMultiSelection },
      // Before defaultKeymap so Arrow Up/Down can enter a table block (which
      // CM would otherwise skip over) instead of the default vertical move.
      ...tableKeymap,
      // Before defaultKeymap so Enter on an opening fence completes the block
      // (inserts the closing ```) instead of a plain newline (MYND-154).
      ...autoCloseFenceKeymap,
      ...closeBracketsKeymap,
      // Before defaultKeymap so Cmd+←/→ get a VERIFIED line boundary rather
      // than CodeMirror's raw coordinate probe against the editor's right edge,
      // which drops the caret a row in this app's centred column (myne#286).
      ...lineBoundaryKeymap,
      ...defaultKeymap,
      { key: "Mod-u", run: undoSelection, preventDefault: true },
    ]),
    myneTheme,
    // MYND-626: Tab indents by FOUR spaces, not CodeMirror's default two.
    // Two is too shallow to read as a level in a nested task list — the child
    // sits so close to its parent that the tree reads flat. Four is also the
    // width every CommonMark parser accepts unambiguously for a nested item
    // under any marker, so a Myne-indented list keeps its shape when it leaves
    // the app. This is the editor-wide indent unit, so it applies to plain
    // lists and indented code alike; the `editor.indent` chord (indentMore, in
    // the rebindable Compartment above) reads this facet.
    indentUnit.of("    "),
    EditorView.lineWrapping,
    // Scroll slack below the last line (#375) so the tail of a long note can be
    // lifted off the bottom edge of the viewport. NOT CodeMirror's
    // `scrollPastEnd()` — see the module header for why that one is wrong here.
    scrollSlackExtension(),
    // Optional line-number gutter (editor-line-numbers, MYND-314), seeded OFF
    // (prose-first default). Lives in a CM6 Compartment so the host can
    // reconfigure it live on the `editor_line_numbers` pref change (SYNC-3
    // addendum) without a remount. Stock `lineNumbers()` numbers logical lines.
    lineNumbersExtension(),
    // Optional modal (vim) editing layer (vim-keyboard-mode, MYND-313), seeded
    // OFF. Lives in a CM6 Compartment so the host can reconfigure it live on the
    // `editor_vim_mode` pref change without a remount — and so the engine itself
    // is only dynamically imported when the user actually turns vim on (see
    // `vim.ts`). Composed AFTER the keymap above deliberately: the vim engine
    // captures keys at the DOM level rather than through the keymap facet, so its
    // position in this array does not order it against Myne's chords — that
    // layering is done explicitly in `vim.ts` instead.
    vimExtension(),
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
