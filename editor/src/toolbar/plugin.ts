// Selection toolbar + inline URL overlay CM6 ViewPlugin.
//
// PRD `editor-mvp-baseline` stories 35-40, 42. The toolbar mounts above an
// active text selection with B / I / S / `<>` / 🔗 / H▾ buttons. The 🔗
// button (and Cmd+K — wired by keymap.ts) opens an inline URL overlay
// adjacent to the selection; Enter wraps as `[selection](url)`, Esc
// dismisses.

import { type Extension } from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  type PluginValue,
  type ViewUpdate,
} from "@codemirror/view";
import { computePosition } from "../positioning";
import { ensureFloatingStyles } from "../floating-styles";
import {
  applyHeadingLevel,
  currentBlockType,
  editorCommands,
  toggleListPrefix,
  wrapCommand,
  type BlockTypeKind,
  type ToolbarCommand,
} from "./commands";
import { makeToolbarIcon, type ToolbarIconName } from "./icons";
import {
  detectEnclosingHighlight,
  applyHighlightEdit,
  highlightMarkers,
} from "./highlight-edit";
import { isSelectionInCode } from "../code-context";
import { rangeOverlapsAttachmentEmbed } from "../decorations/attachment-embed";
import i18n from "@myne/editor/i18n";

type Mode = "toolbar" | "url-overlay";

/**
 * One formatting control: its glyph, the catalog key that names it (used as the
 * tooltip AND the accessible name), the command it runs, and the group it sits
 * in.
 *
 * ── Why glyphs replaced the text labels (issue #970, item 2) ───────────────
 * The toolbar used to render `B`, `I`, `S`, `<>` and `↗` in the app's own font,
 * faking italic and strikethrough with `font-style`/`text-decoration`. Beside a
 * real editor that reads as prose on a bar, and the italic `I` and the struck
 * `S` were the same shape as a letter the user may have just selected. Real
 * icons plus a tooltip carry both halves of what the button does: the shape says
 * what it is, the name says it in words.
 *
 * ── Why the labels come from `editor.toolbar.customize.*` ────────────────
 * Those are the strings Settings already shows for the very same commands. A
 * second set of names for one set of buttons is two names to keep in step, and
 * the settings list is where a user goes to find out what a button is called.
 *
 * ── Groups ──────────────────────────────────────────────────────────────
 * A divider is drawn wherever two ADJACENT controls disagree, so the default
 * layout reads `block type | inline marks | colour, link | lists | note links`
 * and a user's custom order still gets dividers in the same spirit rather than
 * a group outline that fights the order they chose.
 */
interface ToolbarControl {
  readonly id: string;
  readonly icon: ToolbarIconName;
  readonly labelKey: string;
  readonly group: "inline" | "color" | "link" | "list" | "note";
  readonly action: ToolbarCommand;
}

/** The whole reorderable vocabulary, in the editor's own order. Every id here is
 *  also a `src/notes/toolbarItems.ts` id: that file owns persistence, this one
 *  owns rendering, and they are checked against each other by
 *  `tests/notes/toolbarItems.test.ts`.
 *
 *  The commands come from `editorCommands` rather than being spelled here: that
 *  object is the single source the keymap and the mobile keyboard bar also read,
 *  so a fix to `toggleListPrefix` reaches all three surfaces at once. */
const TOOLBAR_CONTROLS: readonly ToolbarControl[] = [
  {
    id: "bold",
    icon: "bold",
    labelKey: "editor.toolbar.customize.bold",
    group: "inline",
    action: editorCommands.bold,
  },
  {
    id: "italic",
    icon: "italic",
    labelKey: "editor.toolbar.customize.italic",
    group: "inline",
    action: editorCommands.italic,
  },
  {
    id: "strike",
    icon: "strike",
    labelKey: "editor.toolbar.customize.strike",
    group: "inline",
    action: editorCommands.strike,
  },
  {
    id: "code",
    icon: "code",
    labelKey: "editor.toolbar.customize.code",
    group: "inline",
    action: editorCommands.code,
  },
  {
    id: "highlight",
    icon: "highlight",
    labelKey: "editor.toolbar.customize.highlight",
    group: "color",
    // The control renders its own swatch compound below; this action is what a
    // plain press means and is only reached through `renderHighlightControl`.
    action: editorCommands.highlight,
  },
  {
    id: "link",
    icon: "link",
    labelKey: "editor.toolbar.customize.link",
    group: "link",
    action: editorCommands.link,
  },
  {
    id: "bulletList",
    icon: "bullet-list",
    labelKey: "editor.toolbar.customize.bulletList",
    group: "list",
    action: editorCommands.bulletList,
  },
  {
    id: "numberedList",
    icon: "numbered-list",
    labelKey: "editor.toolbar.customize.numberedList",
    group: "list",
    action: editorCommands.numberedList,
  },
  {
    id: "checklist",
    icon: "checklist",
    labelKey: "editor.toolbar.customize.checklist",
    group: "list",
    action: editorCommands.checklist,
  },
  {
    id: "quote",
    icon: "quote",
    labelKey: "editor.toolbar.customize.quote",
    group: "list",
    action: editorCommands.quote,
  },
  {
    id: "wikilink",
    icon: "wikilink",
    labelKey: "editor.toolbar.customize.wikilink",
    group: "note",
    action: editorCommands.wikilink,
  },
];

const CONTROL_BY_ID = new Map(TOOLBAR_CONTROLS.map((c) => [c.id, c]));

/** The mark each control's ACTIVE state is read from. `block` is handled by the
 *  leading control instead, since it names the whole line. */
interface MarkState {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly strike: boolean;
  readonly code: boolean;
  readonly link: boolean;
  readonly block: BlockTypeKind;
}

/**
 * Which marks the current selection already sits inside, so a pressed-looking
 * button means "this text already IS bold" rather than "this button was clicked
 * once".
 *
 * Read from the delimiter characters immediately outside the range rather than by
 * walking a syntax tree: the marks this toolbar writes are inline delimiters, so
 * `**` before and after IS the fact, and the alternative is a parser round trip
 * per selection change. The nesting order matters: `*` is a prefix of `**` and
 * of `~~`'s neighbour, so the two-character tests run first and a shorter test
 * only counts when it is not the tail of a longer one.
 */
function markStateOf(view: EditorView): MarkState {
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;
  const before = (n: number): string => (from >= n ? doc.sliceString(from - n, from) : "");
  const after = (n: number): string => (to + n <= doc.length ? doc.sliceString(to, to + n) : "");
  const bold = before(2) === "**" && after(2) === "**";
  const strike = before(2) === "~~" && after(2) === "~~";
  const code = before(1) === "`" && after(1) === "`" && before(2) !== "``";
  const italic =
    !bold && before(1) === "*" && after(1) === "*" && before(2) !== "**" && after(2) !== "**";
  const link = before(1) === "[" && after(2) === "](";
  return { bold, italic, strike, code, link, block: currentBlockType(view).kind };
}

/** Does this control's active state apply to the given marks? */
function isActive(control: ToolbarControl, marks: MarkState): boolean {
  switch (control.id) {
    case "bold":
      return marks.bold;
    case "italic":
      return marks.italic;
    case "strike":
      return marks.strike;
    case "code":
      return marks.code;
    case "link":
      return marks.link;
    case "highlight":
      // The enclosing-highlight detection lives in the swatch control, which
      // needs the same answer to decide between creating and editing.
      return false;
    case "bulletList":
      return marks.block === "bullet" || marks.block === "checklist";
    case "numberedList":
      return marks.block === "numbered";
    case "checklist":
      return marks.block === "checklist";
    case "quote":
      return marks.block === "quote";
    default:
      return false;
  }
}

/** The block-type control's word for the line the caret is on.
 *
 *  A heading reads `H1`..`H6` rather than "Heading 1": the control sits at the
 *  start of a 36px bar, and `#`-count is the same fact the source shows one line
 *  above. Every other block names itself in full, because "List" alone would not
 *  say which of the three lists the line already is. */
function blockTypeLabel(kind: BlockTypeKind, level: number): string {
  switch (kind) {
    case "heading":
      return `H${level}`;
    case "bullet":
      return i18n.t("editor.toolbar.customize.bulletList");
    case "numbered":
      return i18n.t("editor.toolbar.customize.numberedList");
    case "checklist":
      return i18n.t("editor.toolbar.customize.checklist");
    case "quote":
      return i18n.t("editor.toolbar.customize.quote");
    default:
      return i18n.t("editor.toolbar.heading.paragraph");
  }
}

/** The list and quote blocks the block-type dropdown offers below the headings.
 *  `prefixId` doubles as the testid suffix and as the vocabulary id; `prefix` is
 *  the exact marker `toggleListPrefix` writes, which must stay the same string
 *  the toolbar button and the keymap write or the three surfaces would disagree
 *  about what a bullet is. */
const BLOCK_MENU_ITEMS: ReadonlyArray<{
  prefixId: string;
  labelKey: string;
  prefix: string;
}> = [
  {
    prefixId: "bulletList",
    labelKey: "editor.toolbar.customize.bulletList",
    prefix: "- ",
  },
  {
    prefixId: "numberedList",
    labelKey: "editor.toolbar.customize.numberedList",
    prefix: "1. ",
  },
  {
    prefixId: "checklist",
    labelKey: "editor.toolbar.customize.checklist",
    prefix: "- [ ] ",
  },
  {
    prefixId: "quote",
    labelKey: "editor.toolbar.customize.quote",
    prefix: "> ",
  },
];

/** The default floating-toolbar layout — control ids in render order — used when
 *  no user customization has been fed via {@link setToolbarLayout} (MYND-336).
 *  Matches the pre-customization order exactly. */
const DEFAULT_TOOLBAR_LAYOUT: readonly string[] = [
  "bold",
  "italic",
  "strike",
  "code",
  "highlight",
  "link",
  "heading",
];

/** The user's resolved toolbar layout (shown control ids, in order), or null for
 *  {@link DEFAULT_TOOLBAR_LAYOUT}. Fed from `vault.prefs` by the host (MYND-336)
 *  and read at each render. The floating toolbar is transient (re-renders on
 *  selection), so a config change takes effect on the next selection — no live
 *  reconfigure needed. */
let toolbarLayout: readonly string[] | null = null;

/** Set the resolved floating-toolbar layout (shown ids in order), or `null` to
 *  restore the default. Called by the desktop from its `vault.prefs` sync. */
export function setToolbarLayout(ids: readonly string[] | null): void {
  toolbarLayout = ids;
}

function getToolbarLayout(): readonly string[] | null {
  return toolbarLayout;
}

/** Handler the host wires to run the selection→image export (MYND-361). Crosses
 *  the editor→app seam like {@link setToolbarLayout}; `null` when unset (mobile,
 *  or before the host mounts) — the toolbar then omits the export button. */
let selectionExportHandler: (() => void) | null = null;
export function setSelectionExportHandler(fn: (() => void) | null): void {
  selectionExportHandler = fn;
}

/** The export button's glyph. Kept as a named wrapper so the call site does not
 *  reach into the toolbar icon table for a control that is NOT part of the
 *  reorderable vocabulary. */
function makeExportImageIcon(): SVGElement {
  return makeToolbarIcon("export-image");
}

// Multi-color highlight palette (decisions.md 2026-06-15). Yellow is the
// DEFAULT: a plain click on the "H" button applies it. Each swatch's markers
// (`==…==` for yellow, `<mark class="hl-…">…</mark>` otherwise — portable embedded
// HTML constrained to the closed `hl-*` set at the sanitizer) come from the shared
// `highlightMarkers` (highlight-edit.ts), NOT stored here, so the create and edit
// paths cannot drift. The `cssVar` paints each swatch's preview square.
const HIGHLIGHT_SWATCHES = [
  { id: "hl-yellow", labelKey: "editor.toolbar.highlight.yellow", cssVar: "--highlight" },
  { id: "hl-green", labelKey: "editor.toolbar.highlight.green", cssVar: "--highlight-green" },
  { id: "hl-blue", labelKey: "editor.toolbar.highlight.blue", cssVar: "--highlight-blue" },
  { id: "hl-pink", labelKey: "editor.toolbar.highlight.pink", cssVar: "--highlight-pink" },
  { id: "hl-purple", labelKey: "editor.toolbar.highlight.purple", cssVar: "--highlight-purple" },
  { id: "hl-orange", labelKey: "editor.toolbar.highlight.orange", cssVar: "--highlight-orange" },
  { id: "hl-red", labelKey: "editor.toolbar.highlight.red", cssVar: "--highlight-red" },
  { id: "hl-teal", labelKey: "editor.toolbar.highlight.teal", cssVar: "--highlight-teal" },
  { id: "hl-cyan", labelKey: "editor.toolbar.highlight.cyan", cssVar: "--highlight-cyan" },
  { id: "hl-lime", labelKey: "editor.toolbar.highlight.lime", cssVar: "--highlight-lime" },
  { id: "hl-brown", labelKey: "editor.toolbar.highlight.brown", cssVar: "--highlight-brown" },
  { id: "hl-grey", labelKey: "editor.toolbar.highlight.grey", cssVar: "--highlight-grey" },
  { id: "hl-indigo", labelKey: "editor.toolbar.highlight.indigo", cssVar: "--highlight-indigo" },
] as const;



/**
 * Run `action` on a pointer press or on a keyboard activation.
 *
 * `mousedown` rather than `click` is what this bar has always used, and the
 * reason holds: the press has to `preventDefault()` to keep the editor
 * selection alive, and a `click` arrives after focus has moved, by which time
 * the selection the control is about to act on is gone.
 *
 * What that left behind is the defect this function exists for: every control
 * was pointer-only. Enter and Space on a focused button fire `click` and
 * nothing else, so no formatting control could be reached from the keyboard
 * even though the stylesheet gives each one a `:focus-visible` ring
 * (myne-md/myne#970 review, D6). The `click` listener below closes that, gated
 * on `detail === 0` (a synthetic, keyboard-generated click) so a real pointer
 * press does not run the action twice: once from `mousedown`, once from the
 * `click` that follows it.
 *
 * The block-type dropdown's entries are `role="menuitem"` divs, which no
 * browser focuses or activates on its own, so they get the tab stop and the
 * keys explicitly.
 */
function bindPress(el: HTMLElement, action: () => void): void {
  el.addEventListener("mousedown", (e) => {
    e.preventDefault();
    action();
  });
  el.addEventListener("click", (e) => {
    if (e.detail !== 0) return;
    action();
  });
  if (el.getAttribute("role") === "menuitem") {
    el.tabIndex = 0;
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      action();
    });
  }
}

class ToolbarView implements PluginValue {
  private container: HTMLDivElement | null = null;
  private mode: Mode = "toolbar";
  // Which toolbar dropdown is open, if any. Only one at a time — heading and
  // highlight share this single-slot discriminator so opening one closes the other.
  private openDropdown: "heading" | "highlight" | null = null;
  private urlOverlayOpen = false;
  private savedSelection: { from: number; to: number } | null = null;
  private rafHandle: number | null = null;
  // How many frames the current show attempt has re-tried because the selection's
  // screen coords weren't ready yet (transient `coordsAtPos` null right after a
  // re-focus / measure). Bounded so a genuinely off-screen selection can't spin.
  private coordsRetries = 0;

  // Belt-and-suspenders show trigger: after a mouse selection gesture ends,
  // re-evaluate on the next frame. The transaction-based `update()` path can
  // miss a double-click/drag select (e.g. a re-focus racing the selectionSet),
  // which left the toolbar sporadically unshown after a select/deselect. A
  // mouseup is the unambiguous "selection gesture finished" signal.
  private readonly onMouseUp = (): void => {
    requestAnimationFrame(() => this.refresh());
  };

  constructor(private readonly view: EditorView) {
    ensureFloatingStyles();
    this.view.dom.addEventListener("mouseup", this.onMouseUp);
  }

  update(update: ViewUpdate): void {
    // Map the frozen selection through any document change (myne#327).
    //
    // The URL overlay holds `savedSelection` across an untimed user-interaction
    // window — the user is typing a URL, and may be pasting it from elsewhere —
    // and `commit()` then sliced and replaced those raw offsets in the CURRENT
    // document. So the link brackets landed on a shifted run of characters,
    // typically mid-word and sometimes swallowing punctuation, while the word
    // the user actually selected kept no link. Silent: no error, no visual cue.
    //
    // Worse at the other end: if the document SHRANK past the frozen `to`,
    // `ChangeSet.of` threw a `RangeError` out of the Enter keydown listener and
    // escaped uncaught — so `dismiss()` and `view.focus()` never ran, and the
    // overlay was left wedged on `document.body` with the editor unfocused.
    //
    // `changes.mapPos` is what CodeMirror hands out for exactly this. A
    // selection whose two ends map to the same position has been deleted out
    // from under the overlay, and `commit()` declines rather than wrapping
    // nothing.
    if (update.docChanged && this.savedSelection !== null) {
      const from = update.changes.mapPos(this.savedSelection.from, 1);
      const to = update.changes.mapPos(this.savedSelection.to, -1);
      this.savedSelection = to > from ? { from, to } : null;
    }
    // Dismiss when the editor loses focus (e.g. the Settings modal opens over
    // it) — the body-mounted toolbar would otherwise linger on top of other UI.
    // Only a real blur dismisses; showing is NOT gated on focus (a selection set
    // programmatically, or before focus lands, must still surface the toolbar).
    // The URL-overlay input legitimately holds focus, so keep it up then.
    if (update.focusChanged && !update.view.hasFocus && !this.urlOverlayOpen) {
      this.dismiss();
      return;
    }
    if (
      update.selectionSet ||
      update.docChanged ||
      update.viewportChanged ||
      update.focusChanged ||
      // Re-attempt positioning once the geometry settles — a double-click right
      // after a re-focus can fire selectionSet before the layout is measured, so
      // the first `coordsAtPos` is null; the following geometry update recovers it.
      update.geometryChanged
    ) {
      this.refresh();
    }
  }

  destroy(): void {
    this.view.dom.removeEventListener("mouseup", this.onMouseUp);
    this.dismiss();
  }

  /** Public: open URL overlay programmatically (Cmd+K). */
  openUrlOverlay(): void {
    if (!this.view.state.facet(EditorView.editable)) return; // read-only view
    const range = this.view.state.selection.main;
    if (range.empty) return;
    if (isSelectionInCode(this.view.state)) return; // no link wrapping inside code
    this.savedSelection = { from: range.from, to: range.to };
    this.urlOverlayOpen = true;
    this.mode = "url-overlay";
    this.scheduleRender();
  }

  private refresh(): void {
    const range = this.view.state.selection.main;
    // Never show the formatting toolbar in a non-editable view — reading mode (or
    // the read-only companion mirror) still allows a selection (for copy), but
    // has nothing to format, and the buttons would dispatch changes the editor
    // rejects. `EditorView.editable` is false there (view-mode.ts).
    if (!this.view.state.facet(EditorView.editable)) {
      this.dismiss();
      return;
    }
    // Suppress inside code (MYND-154): formatting a code selection would inject
    // literal markdown markers into the source. Also suppress when the
    // selection touches an attachment embed — an image/PDF atom is not
    // text-formattable, so the inline-mark toolbar must not appear over it.
    const formattingNotApplicable =
      isSelectionInCode(this.view.state) ||
      rangeOverlapsAttachmentEmbed(this.view.state, range.from, range.to);
    if ((range.empty || formattingNotApplicable) && !this.urlOverlayOpen) {
      this.dismiss();
      return;
    }
    if (!this.urlOverlayOpen) {
      this.mode = "toolbar";
      this.scheduleRender();
    }
  }

  private scheduleRender(): void {
    if (this.rafHandle !== null) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      this.render();
    });
  }

  /** Re-attempt `render()` on a later frame when the selection's screen coords
   *  weren't ready (transient `coordsAtPos` null). Bounded so a genuinely
   *  off-screen selection can't spin every frame. */
  private retryRender(): void {
    if (this.coordsRetries >= 4) {
      this.coordsRetries = 0;
      return;
    }
    this.coordsRetries += 1;
    this.scheduleRender();
  }

  private dismiss(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.container !== null) {
      this.container.remove();
      this.container = null;
    }
    this.openDropdown = null;
    this.urlOverlayOpen = false;
    this.savedSelection = null;
    this.coordsRetries = 0;
  }

  private ensureContainer(): HTMLDivElement {
    if (this.container === null) {
      this.container = document.createElement("div");
      // Mount to document.body so position: fixed escapes ancestor
      // containing-block context.
      document.body.appendChild(this.container);
    }
    return this.container;
  }

  private render(): void {
    const range = this.view.state.selection.main;
    if (this.mode === "toolbar" && range.empty) {
      this.dismiss();
      return;
    }
    // Dismiss when the selection has scrolled out of the rendered viewport, so
    // the toolbar doesn't get clamped to and stuck at the viewport edge (QA).
    if (this.mode === "toolbar" && this.savedSelection === null) {
      const inView = this.view.visibleRanges.some(
        (r) => range.head >= r.from && range.head <= r.to,
      );
      if (!inView) {
        this.dismiss();
        return;
      }
    }
    let rect: { left: number; top: number; right: number; bottom: number };
    if (this.mode === "toolbar" && this.savedSelection === null) {
      // Anchor to the selection HEAD (where the drag ended / the caret is) so a
      // multi-line selection surfaces the toolbar near where the pointer last
      // was, not pinned to the very top of the whole selection (QA). A
      // zero-width point at the head; `computePosition` places the toolbar just
      // above that line. Fall back to the anchor/opposite end if the head's
      // coords aren't ready.
      const head =
        this.view.coordsAtPos(range.head) ??
        this.view.coordsAtPos(range.anchor) ??
        this.view.coordsAtPos(range.from);
      if (head === null) {
        this.retryRender();
        return;
      }
      // Also dismiss if the head resolved to a point outside the visible editor
      // band (partially-rendered margin above/below the viewport). Guarded on a
      // real scroller height so jsdom (no layout → a zero rect) doesn't false-dismiss.
      const sc = this.view.scrollDOM.getBoundingClientRect();
      if (sc.bottom > sc.top && (head.bottom < sc.top || head.top > sc.bottom)) {
        this.dismiss();
        return;
      }
      rect = { left: head.left, top: head.top, right: head.left, bottom: head.bottom };
    } else {
      const anchorFrom = this.savedSelection?.from ?? range.from;
      const anchorTo = this.savedSelection?.to ?? range.to;
      const startCoords = this.view.coordsAtPos(anchorFrom);
      const endCoords = this.view.coordsAtPos(anchorTo);
      if (startCoords === null || endCoords === null) {
        this.retryRender();
        return;
      }
      rect = {
        left: Math.min(startCoords.left, endCoords.left),
        top: Math.min(startCoords.top, endCoords.top),
        right: Math.max(startCoords.right, endCoords.right),
        bottom: Math.max(startCoords.bottom, endCoords.bottom),
      };
    }
    this.coordsRetries = 0; // coords resolved — clear the retry budget

    const container = this.ensureContainer();
    container.className = this.mode === "toolbar" ? "cm-toolbar" : "cm-url-overlay";
    container.replaceChildren();
    container.style.position = "fixed";
    container.style.zIndex = "1000";

    if (this.mode === "toolbar") {
      this.renderToolbar(container);
      // Measured, not assumed (issue #970, item 2). The width used to be a 280px
      // constant, which was close enough while the bar held seven controls and is
      // not now: with the lists, quote and wikilink addable the same bar can be
      // twice that, and `computePosition` centring a 380px bar as if it were 280
      // hangs it past the right edge of a narrow pane. `getBoundingClientRect`
      // forces the layout, which the placement needs anyway. jsdom reports 0, so
      // the constants stay as the fallback the placement tests rely on.
      const measured = container.getBoundingClientRect();
      const pos = computePosition({
        anchor: rect,
        surfaceWidth: measured.width > 0 ? measured.width : 280,
        surfaceHeight: measured.height > 0 ? measured.height : 36,
        preferredPlacement: "above",
        gap: 6,
      });
      container.style.left = `${pos.left}px`;
      container.style.top = `${pos.top}px`;
    } else {
      this.renderUrlOverlay(container);
      const pos = computePosition({
        anchor: rect,
        surfaceWidth: 320,
        surfaceHeight: 36,
        preferredPlacement: "below",
        gap: 6,
      });
      container.style.left = `${pos.left}px`;
      container.style.top = `${pos.top}px`;
      // Auto-focus the input.
      const input = container.querySelector<HTMLInputElement>(
        "input[type='url'], input[type='text']",
      );
      input?.focus();
    }
  }

  private renderToolbar(container: HTMLDivElement): void {
    // MYND-336: render the controls in the user's resolved layout order, hidden
    // ones already filtered out by the host. Falls back to the default layout.
    const layout = getToolbarLayout() ?? DEFAULT_TOOLBAR_LAYOUT;
    const marks = markStateOf(this.view);
    container.setAttribute("role", "toolbar");
    container.setAttribute("aria-label", i18n.t("editor.toolbar.label"));
    container.setAttribute("aria-orientation", "horizontal");
    // Obsidian-style leading block-type indicator: the heading control renders
    // FIRST (far left) and shows the CURRENT block type, not a generic "H▾" on
    // the right. It is skipped in the layout loop below so it isn't rendered twice.
    let previousGroup: string | null = null;
    if (layout.includes("heading")) {
      this.renderBlockTypeControl(container);
      previousGroup = "type";
    }
    for (const id of layout) {
      if (id === "heading") continue; // rendered as the leading control above
      const control = CONTROL_BY_ID.get(id);
      if (control === undefined) continue;
      if (previousGroup !== null && control.group !== previousGroup) {
        this.renderSeparator(container);
      }
      previousGroup = control.group;
      if (id === "highlight") {
        // "H" swatch: plain click = default yellow (==…==); caret opens the
        // 12-color swatch row (MYND-156 + multi-color, decisions.md 2026-06-15).
        this.renderHighlightControl(container);
        continue;
      }
      if (id === "link") {
        // The link control opens the URL overlay instead of wrapping in place.
        // a `[text](url)` with a placeholder `url` would be a broken link the
        // user then has to go and fix by hand.
        this.renderButton(container, control, marks, () => this.openUrlOverlay());
        continue;
      }
      this.renderButton(container, control, marks);
    }
    // Trailing export-selection-as-image button (MYND-361) — only when the host
    // wired the handler. A separate fixed control (not part of the reorderable
    // vocabulary) so it can't be lost from the layout.
    if (selectionExportHandler !== null) {
      if (previousGroup !== null) this.renderSeparator(container);
      this.renderExportButton(container);
    }
  }

  /** A hairline between two control groups, and the reason the bar reads as a
   *  toolbar rather than as a row of eleven identical squares. Decorative: roles
   *  and names carry the grouping for a screen reader. */
  private renderSeparator(container: HTMLDivElement): void {
    const sep = document.createElement("span");
    sep.className = "cm-toolbar-sep";
    sep.setAttribute("aria-hidden", "true");
    container.appendChild(sep);
  }

  /** One glyph button. `active` paints the pressed state and sets
   *  `aria-pressed`, so the state is not colour-only. */
  private renderButton(
    container: HTMLDivElement,
    control: ToolbarControl,
    marks: MarkState,
    action?: ToolbarCommand,
  ): void {
    const active = isActive(control, marks);
    const label = i18n.t(control.labelKey);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-toolbar-button";
    btn.dataset["control"] = control.id;
    btn.setAttribute("data-testid", `toolbar.${control.id}`);
    btn.title = label;
    btn.setAttribute("aria-label", label);
    // A formatting control is a toggle over the selection, so `aria-pressed` is
    // the honest role; `wikilink` is too (it wraps or unwraps `[[…]]`).
    btn.setAttribute("aria-pressed", active ? "true" : "false");
    if (active) btn.classList.add("cm-toolbar-button-active");
    btn.appendChild(makeToolbarIcon(control.icon));
    bindPress(btn, () => {
      this.openDropdown = null;
      (action ?? control.action)(this.view);
    });
    container.appendChild(btn);
  }

  /** The export-selection-as-image button (MYND-361). Delegates to the
   *  host-wired handler which reads the editor-state selection + saves a PNG. */
  private renderExportButton(container: HTMLDivElement): void {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-toolbar-button cm-toolbar-button-export";
    btn.title = i18n.t("editor.toolbar.exportImageTitle");
    btn.setAttribute("aria-label", i18n.t("editor.toolbar.exportImageTitle"));
    btn.appendChild(makeExportImageIcon());
    bindPress(btn, () => selectionExportHandler?.());
    container.appendChild(btn);
  }

  /** Leading block-type control: names the block the caret is IN (Paragraph /
   *  H1..H6 / Bullet list / Numbered list / Checklist / Quote) on the far left,
   *  and opens the dropdown that changes it. */
  private renderBlockTypeControl(container: HTMLDivElement): void {
    const { kind, level } = currentBlockType(this.view);
    const label = blockTypeLabel(kind, level);
    const headingWrap = document.createElement("div");
    headingWrap.className = "cm-toolbar-heading-wrap cm-toolbar-blocktype-wrap";
    headingWrap.style.position = "relative";
    const headingBtn = document.createElement("button");
    headingBtn.type = "button";
    headingBtn.className = "cm-toolbar-button cm-toolbar-blocktype";
    headingBtn.setAttribute("data-testid", "toolbar.blockType");
    headingBtn.title = label;
    headingBtn.setAttribute("aria-label", label);
    headingBtn.setAttribute("aria-haspopup", "menu");
    headingBtn.setAttribute("aria-expanded", this.openDropdown === "heading" ? "true" : "false");
    // Current type + a caret so it reads as an opener.
    const headingText = document.createElement("span");
    headingText.textContent = label;
    const caret = document.createElement("span");
    caret.className = "cm-toolbar-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.appendChild(makeToolbarIcon("chevron-down", 12));
    headingBtn.append(headingText, caret);
    bindPress(headingBtn, () => {
      this.openDropdown = this.openDropdown === "heading" ? null : "heading";
      this.scheduleRender();
    });
    headingWrap.appendChild(headingBtn);
    if (this.openDropdown === "heading") {
      const drop = document.createElement("div");
      drop.className = "cm-toolbar-heading-dropdown";
      drop.setAttribute("role", "menu");
      drop.style.position = "absolute";
      drop.style.top = "32px";
      drop.style.left = "0";
      const items: Array<{ label: string; level: number }> = [
        { label: i18n.t("editor.toolbar.heading.paragraph"), level: 0 },
        { label: i18n.t("editor.toolbar.heading.h1"), level: 1 },
        { label: i18n.t("editor.toolbar.heading.h2"), level: 2 },
        { label: i18n.t("editor.toolbar.heading.h3"), level: 3 },
        { label: i18n.t("editor.toolbar.heading.h4"), level: 4 },
        { label: i18n.t("editor.toolbar.heading.h5"), level: 5 },
        { label: i18n.t("editor.toolbar.heading.h6"), level: 6 },
      ];
      for (const item of items) {
        const el = document.createElement("div");
        el.className = "cm-toolbar-heading-item";
        el.setAttribute("role", "menuitem");
        el.textContent = item.label;
        bindPress(el, () => {
          this.openDropdown = null;
          applyHeadingLevel(this.view, item.level);
        });
        drop.appendChild(el);
      }
      // The list and quote blocks belong in the SAME dropdown: they are the rest
      // of the answer to "what kind of block is this line", which is exactly the
      // question this control asks. Before this they were reachable only from
      // their own toolbar buttons, and only after the user had found them in
      // Settings (issue #970, item 1).
      for (const block of BLOCK_MENU_ITEMS) {
        const el = document.createElement("div");
        el.className = "cm-toolbar-heading-item";
        el.setAttribute("role", "menuitem");
        el.setAttribute("data-testid", `toolbar.blockType.${block.prefixId}`);
        el.textContent = i18n.t(block.labelKey);
        bindPress(el, () => {
          this.openDropdown = null;
          toggleListPrefix(block.prefix)(this.view);
          this.view.focus();
        });
        drop.appendChild(el);
      }
      headingWrap.appendChild(drop);
    }
    container.appendChild(headingWrap);
  }

  /** Highlight control: an "H" swatch button plus a caret that opens the color
   *  swatch row. It is caret-aware (MYND-637): when the selection sits inside an
   *  existing highlight the swatch shows that colour and the control EDITS it in
   *  place — a swatch recolours, the active colour / main button removes — instead
   *  of wrapping. With no enclosing highlight it CREATES: plain click = yellow
   *  (`==…==`), a swatch wraps `<mark class="hl-…">…</mark>`. */
  private renderHighlightControl(container: HTMLDivElement): void {
    const wrap = document.createElement("div");
    wrap.className = "cm-toolbar-highlight-wrap";
    wrap.style.position = "relative";

    const range = this.view.state.selection.main;
    const enc = detectEnclosingHighlight(this.view.state, range.from, range.to);
    const activeCssVar = enc
      ? (HIGHLIGHT_SWATCHES.find((s) => s.id === enc.color)?.cssVar ?? "--highlight")
      : "--highlight";

    // Main button: create yellow, or — when editing an existing highlight — show
    // its colour and remove it on click (toggle-off, like an active Bold button).
    const mainBtn = document.createElement("button");
    mainBtn.type = "button";
    mainBtn.className = "cm-toolbar-button cm-toolbar-highlight-main";
    mainBtn.setAttribute("data-testid", "toolbar.highlight");
    if (enc !== null) mainBtn.classList.add("cm-toolbar-button-active");
    mainBtn.setAttribute("aria-pressed", enc !== null ? "true" : "false");
    // The glyph says WHAT the control does; the dot under it says WHICH colour it
    // will write. Spelling the colour as the letter "H" on a tinted square (the
    // old shape) made the button read as a text badge, and at 15px the tint was
    // the only cue that survived.
    mainBtn.appendChild(makeToolbarIcon("highlight"));
    const dot = document.createElement("span");
    dot.className = "cm-toolbar-hl-dot";
    dot.setAttribute("aria-hidden", "true");
    dot.style.backgroundColor = `var(${activeCssVar}, #f3e7c4)`;
    mainBtn.appendChild(dot);
    const hlLabel = enc
      ? i18n.t("editor.toolbar.highlight.remove")
      : i18n.t("editor.toolbar.customize.highlight");
    mainBtn.title = hlLabel;
    mainBtn.setAttribute("aria-label", hlLabel);
    bindPress(mainBtn, () => {
      this.openDropdown = null;
      if (enc) applyHighlightEdit(this.view, enc, enc.color); // toggle off
      else wrapCommand("==", "==")(this.view);
    });
    wrap.appendChild(mainBtn);

    // Caret: opens/closes the color swatch row.
    const caret = document.createElement("button");
    caret.type = "button";
    caret.className = "cm-toolbar-button cm-toolbar-highlight-caret";
    caret.setAttribute("data-testid", "toolbar.highlight-caret");
    caret.setAttribute("aria-haspopup", "menu");
    caret.setAttribute(
      "aria-expanded",
      this.openDropdown === "highlight" ? "true" : "false",
    );
    caret.title = i18n.t("editor.toolbar.highlight.colours");
    caret.setAttribute("aria-label", i18n.t("editor.toolbar.highlight.colours"));
    caret.appendChild(makeToolbarIcon("chevron-down", 12));
    bindPress(caret, () => {
      this.openDropdown = this.openDropdown === "highlight" ? null : "highlight";
      this.scheduleRender();
    });
    wrap.appendChild(caret);

    if (this.openDropdown === "highlight") {
      const drop = document.createElement("div");
      drop.className = "cm-toolbar-highlight-dropdown";
      drop.style.position = "absolute";
      drop.style.top = "32px";
      drop.style.left = "0";
      for (const sw of HIGHLIGHT_SWATCHES) {
        const square = document.createElement("button");
        square.type = "button";
        square.className = "cm-toolbar-highlight-swatch";
        square.title = i18n.t(sw.labelKey);
        square.setAttribute("data-testid", `toolbar.highlight-${sw.id}`);
        square.style.backgroundColor = `var(${sw.cssVar})`;
        // Ring the active colour when editing so the current highlight is legible.
        if (enc?.color === sw.id) {
          square.classList.add("cm-toolbar-highlight-swatch-active");
          square.style.outline = "2px solid var(--accent, #2c4a7a)";
          square.style.outlineOffset = "1px";
        }
        bindPress(square, () => {
          this.openDropdown = null;
          // Editing → recolour in place (choosing the active colour removes it);
          // creating → wrap the selection in this colour's markers.
          if (enc) applyHighlightEdit(this.view, enc, sw.id);
          else wrapCommand(...highlightMarkers(sw.id))(this.view);
        });
        drop.appendChild(square);
      }
      // Explicit Remove affordance, only while editing an existing highlight.
      if (enc) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "cm-toolbar-highlight-remove";
        remove.textContent = i18n.t("editor.toolbar.highlight.remove");
        remove.setAttribute("data-testid", "toolbar.highlight-remove");
        bindPress(remove, () => {
          this.openDropdown = null;
          applyHighlightEdit(this.view, enc, enc.color);
        });
        drop.appendChild(remove);
      }
      wrap.appendChild(drop);
    }
    container.appendChild(wrap);
  }

  private renderUrlOverlay(container: HTMLDivElement): void {
    const input = document.createElement("input");
    input.type = "url";
    input.placeholder = i18n.t("editor.toolbar.urlPlaceholder");
    input.className = "cm-url-overlay-input";
    const apply = document.createElement("button");
    apply.type = "button";
    apply.textContent = i18n.t("editor.toolbar.apply");
    apply.className = "cm-url-overlay-apply";

    const commit = (): void => {
      const url = input.value.trim();
      const sel = this.savedSelection;
      // The mapping above keeps `sel` valid, and a collapsed range is nulled
      // there — but the dispatch is the one place a bad range becomes an
      // uncaught throw, so it re-checks against the live document rather than
      // trusting an invariant maintained elsewhere.
      const len = this.view.state.doc.length;
      if (sel !== null && url !== "" && sel.from < sel.to && sel.to <= len) {
        const text = this.view.state.doc.sliceString(sel.from, sel.to);
        this.view.dispatch({
          changes: {
            from: sel.from,
            to: sel.to,
            insert: `[${text}](${url})`,
          },
          userEvent: "toolbar.link",
        });
      }
      this.dismiss();
      this.view.focus();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.dismiss();
        this.view.focus();
      }
    });
    bindPress(apply, commit);
    container.append(input, apply);
  }
}

export function selectionToolbarExtension(): Extension {
  return ViewPlugin.fromClass(ToolbarView);
}
