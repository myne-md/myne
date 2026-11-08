// Atomic widgets for the editor attachment render path (epic MYND-164 + 147/149).
//
// Four widget families, all `Decoration.replace({ widget, atomic: true })`:
//   - `AttachmentImageWidget` — a resolved raster/SVG attachment, inline image
//     via `<img src="attachment://<id>">`. SVG renders ONLY through `<img>`
//     (secure static mode) — its markup is NEVER inlined into the DOM.
//   - `AttachmentPdfWidget` — a resolved PDF, rendered as a bounded scrollable
//     multi-page reader via pdf.js (lazy per-page render), with a MANDATORY
//     generic-PDF-icon fallback (SYNC-5). Clicking opens the bigger lightbox
//     reader (parallels the image click→lightbox).
//   - `AttachmentTombstoneWidget` — an unresolved `att:` id: "deleted" (was in
//     the catalog once → muted image-off) vs "broken" (never existed / malformed
//     → danger-tinted). Note bytes are NEVER rewritten.
//   - `UrlImageChipWidget` — a NON-FETCHING placeholder chip for `![](url)` /
//     `![][ref]`: icon + alt label, URL on hover-tooltip, click-through
//     suppressed. Never issues a network request, never an `<img>` for the URL.
//
// All visible text is set via `textContent` (never `innerHTML`) per TB2.

import {
  decodedAspectOf,
  rememberAspect,
} from "./decoded-aspect";
import {
  isCurrentGeneration,
  previewCache,
  previewInFlight,
  sessionGeneration,
} from "./session-caches";
import { type EditorView, WidgetType } from "@codemirror/view";
import i18n from "@myne/editor/i18n";
import { getHost } from "../host";
import { attachmentUrl } from "@myne/editor/host/notes/attachmentRef";
import { makeAttachmentIcon } from "./icons";
import type { CatalogRow } from "./catalog";
import { mountPdfScroller } from "./pdf-reader";
import { makeProgressChip } from "./progress";
import { showAttachmentLightbox } from "./lightbox";
import { fileTypeLabel } from "./fileKind";
import { formatBytes, formatClock } from "@myne/editor/host/components/attachments/format";
import { canExportAttachment } from "@myne/editor/host/lib/attachments";
import {
  exportAttachment,
  removeFileCard,
  renameFileCard,
  revealFileCard,
} from "./fileCardActions";
import { buildOverflowMenu, type OverflowAction, type OverflowRow } from "./actionMenu";
import {
  type DroppedEmbedSegment,
  type EmbedLayout,
  embedAccessibleName,
  embedWidthCss,
  emptyEmbedLayout,
  isAliasSafeText,
  MAX_EMBED_DIMENSION_PX,
  sameEmbedLayout,
} from "@myne/dialect/embedLayout";
import {
  hasWidth,
  parseWidthInput,
  readEmbedLayout,
  setAlt,
  toggleAlign,
  toggleWidthPercent,
  setWidthPx,
  toggleWidthPx,
  updateEmbedLayout,
} from "./embedLayoutActions";
import { promptForText } from "./renamePrompt";
import { showAttachmentToast } from "./toast";
import { decodePeaks } from "./waveform";
import { createTranscriptSection } from "./transcript";
import { transcriptionEnabledFacet } from "./transcription-gate";

/** Default width (CSS px) an inline image / PDF frame renders at when the
 *  embed carries no explicit `w=` segment. Mirrored by `.cm-attachment-frame`
 *  and `.cm-attachment-pdf-scroller` in `theme.ts`; change all three together. */
const FRAME_WIDTH = 320;

/**
 * Apply an embed's layout segments (myne#409) to its frame.
 *
 * **An explicit width is a maximum intent, not a guarantee.** The frame is
 * always paired with `max-width: 100%`, so it is bounded by the editor's
 * content column, which is itself a user preference
 * (`editor_content_width`: narrow 560 / normal 680 / wide 820 / full unbounded,
 * `editor/src/typography.ts`). Without the clamp a `w=800` embed would overflow
 * the 680px default column, and changing that preference would break the layout
 * of notes already written.
 *
 * **Typed CSSOM property setters and classes only.** Never `style.cssText`,
 * never `setAttribute("style", …)`, never a custom property. A typed setter
 * parses the value against that property's own grammar and rejects it wholesale
 * on failure, so a note-authored value cannot carry a second declaration
 * through it. That is what keeps this off the `style-src 'unsafe-inline'`
 * surface, and it is the reason this needs no validator crate of its own. The
 * closed grammar in `@myne/dialect/embedLayout` is still upstream of every
 * value that reaches here; this is defence in depth, not the only defence.
 */
function applyEmbedLayout(frame: HTMLElement, layout: EmbedLayout): void {
  const width = embedWidthCss(layout);
  if (width !== null) {
    frame.style.width = width;
    frame.style.maxWidth = "100%";
  }

  if (layout.align !== null) {
    // Alignment is a class, never an inline style string. The frame is
    // `inline-flex` by default, which no margin can centre; the aligned variant
    // makes it block-level and `fit-content` wide so the auto margins bite.
    frame.classList.add("cm-attachment-frame-align", `cm-attachment-frame-align-${layout.align}`);
  }
}

function sameDroppedSegments(
  a: readonly DroppedEmbedSegment[],
  b: readonly DroppedEmbedSegment[],
): boolean {
  return a.length === b.length && a.every((seg, i) => seg.source === b[i].source);
}

/**
 * The persistent unreadable-segment marker (myne#409 task 6).
 *
 * `markdown-dialect.md` §3.9.3 binds the shape, and every clause of it is
 * load-bearing here: the report must be persistent, IN the rendered block,
 * carry the source text verbatim, and never be a transient notification. The
 * block re-renders on every note open, so a notification would recur
 * indefinitely, and a shown-once notification goes silent, which is the exact
 * failure the visible-drop rule exists to prevent.
 *
 * It appears ONLY for a known key carrying an invalid value. An unrecognised
 * key is version skew across three independently-versioned clients reading one
 * synced vault: the note is right, the client is old, and there is nothing the
 * reader can act on. `parseEmbedAlias` makes that split, so anything reaching
 * here is author-fixable by construction.
 *
 * Quiet by design. The embed still renders correctly at its default size, so a
 * loud marker would read as damage.
 */

/**
 * Append the §3.9.3 marker to `host`, or nothing when there is nothing to
 * report.
 *
 * The emptiness test lives HERE rather than at each of the six call sites, and
 * that is the whole reason this takes a host instead of returning an element.
 * Reporting a dropped segment is two remembered halves per widget, taking the
 * list through the constructor and appending the marker in `toDOM`, and four of
 * the six widgets shipped having done the first and not the second. A call site
 * that forgets `if (dropped.length > 0)` renders an empty marker, which is a
 * visible defect; a call site that forgets the whole block renders nothing,
 * which is invisible. One call, one thing to remember.
 */
function appendDroppedSegmentMarker(
  host: HTMLElement,
  dropped: readonly DroppedEmbedSegment[],
  testidPrefix: string,
): void {
  if (dropped.length === 0) return;
  const mark = document.createElement("span");
  mark.className = "cm-attachment-embed-warning";
  mark.setAttribute("data-testid", `${testidPrefix}.unreadable`);
  // A Lucide glyph, not a unicode character: `myne-agents/docs/design/README.md`
  // Iconography forbids unicode symbols as icons, and Status already uses
  // `circle-alert` (the toast one directory over draws the same one).
  mark.appendChild(makeAttachmentIcon("circle-alert"));
  const detail = dropped.map((d) => d.source).join(", ");
  const label = i18n.t("editor.attachment.widget.unreadableSegment", { segments: detail });
  mark.setAttribute("role", "img");
  mark.setAttribute("aria-label", label);
  mark.title = label;
  host.appendChild(mark);
}

/**
 * The accessible name for an embed, and whether the media itself should be
 * announced at all.
 *
 * `alt === null` means the author wrote none, so the filename stands in.
 * `alt === ""` means the author deliberately marked the media decorative, which
 * is a different thing: it is hidden from assistive tech entirely.
 *
 * **The name goes on the MEDIA, never on the frame.** ARIA gives an element
 * with `role="img"` presentational children, so putting the role on the frame
 * removed every descendant from the accessibility tree, and the frame is where
 * the overflow menu and the unreadable-segment marker live. On the default path
 * (an embed with no authored alt, which is nearly all of them) that made the
 * whole feature invisible to a screen reader: those menu rows are the only
 * authoring path there is, and the marker is the §3.9.3 report. The frame stays
 * a plain container on every path.
 */
function applyEmbedAltText(
  frame: HTMLElement,
  media: HTMLElement,
  filename: string,
  layout: EmbedLayout,
): void {
  // Never on the frame. Cleared defensively so a caller that set one before
  // calling this cannot leave the frame's children presentational.
  frame.removeAttribute("role");
  frame.removeAttribute("aria-label");

  const { name, decorative } = embedAccessibleName(layout, filename);
  if (decorative) {
    // Decorative: hide the media, keep the frame and everything inside it.
    media.setAttribute("alt", "");
    media.setAttribute("role", "presentation");
    media.removeAttribute("aria-label");
    return;
  }
  media.setAttribute("alt", name);
  media.setAttribute("role", "img");
  media.setAttribute("aria-label", name);
}

/** Tombstone flavor: a deleted attachment (id was once in the catalog) vs a
 *  broken reference (malformed `att:` target — never a valid id). */
export type TombstoneKind = "deleted" | "broken";

// --- resolved raster / SVG -------------------------------------------------

/**
 * # The measurement the aspect cache exists for (myne-md/myne#604)
 *
 * Typing one character before a mid-line embed destroys and rebuilds the
 * widget's DOM. Measured in Chromium against this exact widget: the frame's
 * probe tag changes from one render to the next, while an embed alone on its
 * own line keeps its tag and its DOM. `eq()` is correct and does not prevent it;
 * CodeMirror rebuilds a line's content when that line's text changes.
 *
 * Each rebuild restarts `toDOM`, which used to hide the `<img>` until its `load`
 * fired, so the frame collapsed from 240px to 31px and sprang back a frame
 * later. That is the flash, and with the document scrolled it is also the jump:
 * the content height moves under the scroll position.
 *
 * The store itself lives in `./decoded-aspect`, a leaf with no imports, because
 * the vault-teardown paths have to clear it and importing THIS file to do that
 * dragged the whole attachment-widget subtree into the app's eager graph. That
 * file states the measurement.
 */

export class AttachmentImageWidget extends WidgetType {
  /** The object URL resolved at BUILD time. `eq()` is keyed on it so that when
   *  the host warms this id on web (pending placeholder → real blob URL, #211)
   *  the rebuilt widget is NOT eq() to the old one and CM re-renders the `<img>`
   *  against the warmed URL. Desktop's `attachment://` URL is a pure function of
   *  the id, so eq() is unchanged there. `attachmentUrl` is host-safe (falls back
   *  to the canonical literal when no host is installed — vitest/jsdom). */
  private readonly url: string;
  /** Tear-down for the body-mounted overflow menu: see the file card's. */
  private menuTeardown: (() => void) | null = null;
  /** Tear-down for the drag-resize handles' window-level pointer listeners. */
  private resizeTeardown: (() => void) | null = null;

  constructor(
    private readonly id: string,
    private readonly filename: string,
    private readonly layout: EmbedLayout,
    private readonly dropped: readonly DroppedEmbedSegment[],
    /** Whether this embed is drawn as a whole-line block. Only the block form
     *  carries resize handles: an inline embed has no stable edge to grab (the
     *  line reflows around it as it grows) and dragging inside a line box is
     *  indistinguishable from a text selection. Part of `eq()` because a source
     *  edit can move an embed between the two forms, and the handles have to
     *  follow it. */
    /*
     * REQUIRED, deliberately. A default here is the shape the root AGENTS.md
     * records as an opt-in guard: a call site that forgets the argument gets
     * `false`, which is a valid inline embed with no resize handles, and `eq()`
     * then compares `false === false`, so nothing rebuilds to tell anyone.
     * Making it required is what lets the compiler name every site instead.
     */
    private readonly block: boolean,
  ) {
    super();
    this.url = attachmentUrl(id);
  }

  /**
   * Height before the first draw, so CM's height map does not discover the real
   * one as a surprise mutation mid-scroll. Same job as the text preview's
   * further down this file, which this widget had no counterpart to: a block
   * embed scrolled out and back was estimated at a line's height and corrected
   * on measure, which is the jump the aspect reservation removes for a REBUILD
   * and did nothing for a re-entry.
   *
   * Answered only when it can be answered exactly. An explicit `h=` is the
   * height. Otherwise a known decoded ratio plus a known width gives it, and
   * `decodedAspectOf` is undefined until this vault has drawn this image once,
   * which is the same condition the box reservation keys off. A percentage
   * width depends on the content column, which is not readable from here, so
   * that case returns -1 and lets CM guess rather than inventing a number: a
   * wrong estimate is worse than none, since CM trusts it until it measures.
   */
  get estimatedHeight(): number {
    if (this.layout.heightPx !== null) return this.layout.heightPx;
    const aspect = decodedAspectOf(this.id);
    if (aspect === undefined || aspect <= 0) return -1;
    if (this.layout.widthPercent !== null) return -1;
    return Math.round((this.layout.widthPx ?? FRAME_WIDTH) / aspect);
  }

  eq(other: AttachmentImageWidget): boolean {
    return (
      other.id === this.id &&
      other.filename === this.filename &&
      other.url === this.url &&
      other.block === this.block &&
      // Without this the widget survives a layout edit unchanged: CM6 keeps the
      // old DOM whenever eq() says the rebuild matches.
      sameEmbedLayout(other.layout, this.layout) &&
      sameDroppedSegments(other.dropped, this.dropped)
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const frame = document.createElement("span");
    frame.className = "cm-attachment-frame";
    // role + aria-label are owned by `applyEmbedAltText` below, which writes
    // them on every path and removes them for a decorative image.
    applyEmbedLayout(frame, this.layout);

    const url = this.url;

    // Clean progress chip ("Loading…") until the first decrypt+decode paints —
    // NOT the struck/tombstone style. Removed once the <img> fires `load`.
    //
    // Only on a FIRST paint (myne-md/myne#604). Once this id's shape is known
    // the box is reserved below and the image arrives into it, so a chip would
    // be a second thing flashing in a space that is no longer empty. The whole
    // point of the reservation is that a rebuild looks like nothing happened.
    const knownAspect = decodedAspectOf(this.id);
    const loading = knownAspect === undefined ? makeProgressChip("loading") : null;
    if (loading !== null) frame.appendChild(loading);

    const img = document.createElement("img");
    img.className = "cm-attachment-img";
    img.setAttribute("data-testid", "attachment-image");
    // attachment://<id> — the Rust handler decrypts in-memory + re-sniffs +
    // allowlists. SVG is served as image/svg+xml and rendered here ONLY through
    // the `<img>` element (secure static mode); its markup never enters the DOM.
    img.src = url;
    applyEmbedAltText(frame, img, this.filename, this.layout);
    // The frame carries the width (applyEmbedLayout); the image fills it and is
    // bounded by it, so an explicit width never overflows the content column.
    // With no explicit width this reproduces the historical 320px cap.
    if (this.layout.widthPx === null && this.layout.widthPercent === null) {
      img.style.maxWidth = `${FRAME_WIDTH}px`;
    } else {
      img.style.width = "100%";
      img.style.maxWidth = "100%";
    }
    // An explicit height means the author asked for exactly that box, which is
    // what Obsidian's `300x200` means too. Aspect distortion is the request.
    if (this.layout.heightPx !== null) {
      img.style.height = `${this.layout.heightPx}px`;
    }
    // The box is reserved from the remembered ratio, so the image occupies its
    // final height from the first frame and a rebuild is invisible
    // (myne-md/myne#604). `aspect-ratio` rather than a pixel height because the
    // width is the layout's to decide: `w=`, the 320px default cap, or the
    // aligned `fit-content` form. Only the height follows from the image.
    //
    // On a FIRST paint the ratio is unknown, so the old behaviour stands: hide
    // the `<img>` and show the chip, because an unhidden zero-size image next to
    // a chip is two placeholders for one thing. That first settle is the one
    // jump left, and it is unavoidable while `CatalogRow` carries no dimensions
    // (`editor/src/host.ts`).
    if (knownAspect !== undefined && this.layout.heightPx === null) {
      img.style.aspectRatio = String(knownAspect);
    } else if (knownAspect === undefined) {
      img.style.display = "none";
    }
    img.addEventListener("load", () => {
      rememberAspect(this.id, img);
      img.style.display = "";
      loading?.remove();
      // The box changed size AFTER CodeMirror measured this widget, and nothing
      // watches a block widget's own geometry: without this the height map keeps
      // the placeholder's height (0 on a first paint), so every coordinate past
      // this embed resolves that far off and a click lands rows low.
      // `decorations/cover-banner.ts` and `decorations/mermaid.ts` carry the same
      // call for the same reason (myne-md/myne#990).
      view.requestMeasure();
    });
    img.addEventListener("error", () => {
      loading?.remove();
      // A failed decode used to leave NOTHING behind. The chip was removed, the
      // `<img>` stayed `display: none`, and the frame collapsed to 0x0, so the
      // only thing still painted was the "⋯" overlay hanging ~34px to the LEFT
      // of the content column. A stray box between the rows, in a note that
      // looks like it never finished loading (myne-md/myne#990). Say what broke,
      // where the image would have been, so the box is real and its chrome lands
      // inside it.
      const broken = buildTombstoneDom("broken", this.filename);
      broken.setAttribute("data-testid", "attachment-image.failed");
      frame.replaceChild(broken, img);
      // The resize handles were bound to the `<img>` that just left the document:
      // left in place they drag a detached element and write a width for an image
      // nobody can see. The drag affordance goes with the media.
      this.resizeTeardown?.();
      this.resizeTeardown = null;
      view.requestMeasure();
    });
    // Click the rendered image → full-size lightbox preview (same decrypted
    // source). Cursor + title hint the affordance.
    img.style.cursor = "zoom-in";
    img.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showAttachmentLightbox({ url, alt: this.filename, id: this.id });
    });
    frame.appendChild(img);

    appendDroppedSegmentMarker(frame, this.dropped, "attachment-image");

    const menu = buildEmbedOverflowMenu(view, frame, this.id, this.filename, this.dropped, "attachment-image");
    this.menuTeardown = menu.teardown;
    frame.appendChild(menu.wrap);

    // Drag-to-resize, on the block form only (myne-md/myne#604). See
    // `appendResizeHandles` for why the inline form gets none.
    this.resizeTeardown = appendResizeHandles(view, frame, img, this.id, this.block);

    return frame;
  }

  // If CM6 discards the widget while its menu is open, tear the menu down so its
  // document `mousedown` listener cannot outlive the DOM. Same for a resize
  // drag: it holds window-level `pointermove`/`pointerup` listeners, and a
  // keystroke elsewhere rebuilds this widget mid-drag (measured, myne#604).
  destroy(): void {
    this.menuTeardown?.();
    this.menuTeardown = null;
    this.resizeTeardown?.();
    this.resizeTeardown = null;
  }

  // Let the click reach the <img> handler (lightbox) rather than being
  // swallowed as a CM event; the widget stays atomic (no source-lift) because
  // it never mutates the document or selection.
  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * The size presets offered in the embed menu, chosen against the editor's own
 * content-column widths (narrow 560 / normal 680 / wide 820,
 * `editor/src/typography.ts`) so all four read as distinct in the default
 * column rather than collapsing into each other under the clamp.
 *
 * There is deliberately no "Original" preset. The grammar has no way to say
 * "the image's natural size" (`w=` takes a length, not a keyword), and a row
 * labelled Original that actually meant "back to the 320px default cap" would
 * be a lie. Selecting the already-active preset clears the width instead, which
 * is the real undo, and a natural-size keyword is a grammar question for later.
 */
const SIZE_PRESETS: ReadonlyArray<{
  name: string;
  labelKey: string;
  px: number | null;
  percent: number | null;
}> = [
  { name: "small", labelKey: "editor.attachment.widget.menu.size.small", px: 240, percent: null },
  { name: "medium", labelKey: "editor.attachment.widget.menu.size.medium", px: 400, percent: null },
  { name: "large", labelKey: "editor.attachment.widget.menu.size.large", px: 640, percent: null },
  { name: "full", labelKey: "editor.attachment.widget.menu.size.full", px: null, percent: 100 },
];

const EMBED_ALIGNMENTS = ["left", "center", "right"] as const;

/** Custom size: prompt, validate through the SAME closed grammar the parser
 *  enforces, and refuse visibly rather than writing a value the parser would
 *  then drop and report back at the author. */
async function promptCustomSize(
  view: EditorView,
  host: HTMLElement,
  id: string,
  current: EmbedLayout,
): Promise<void> {
  const shown =
    current.widthPx !== null
      ? String(current.widthPx)
      : current.widthPercent !== null
        ? `${current.widthPercent}%`
        : "";
  const raw = await promptForText(shown, {
    titleKey: "editor.attachment.customSizePrompt.title",
    confirmKey: "editor.attachment.customSizePrompt.confirm",
    testidPrefix: "attachment-custom-size",
  });
  if (raw === null) return; // cancelled
  const parsed = parseWidthInput(raw);
  if (parsed === null) {
    showAttachmentToast(i18n.t("editor.attachment.widget.menu.customSizeInvalid"), "error");
    return;
  }
  updateEmbedLayout(view, host, id, (current) => ({
    ...current,
    widthPx: parsed.px,
    widthPercent: parsed.percent,
  }));
}

/**
 * Edit alt text.
 *
 * Two edges, both of which silently destroyed something before:
 *
 * 1. **`]]` terminates the embed.** `wikilink.md` §2.1 forbids it inside a
 *    wikilink and v0.1 has no escape for it, so `alt=see [[Note]]` emitted a
 *    wikilink that ends at the first `]]`: the alt was truncated and the rest
 *    landed in the note as literal text. Alt is the only free-text write this
 *    feature makes into the note (rename writes the catalog, custom size is
 *    grammar-validated), so it is the one place that needs the guard.
 * 2. **An empty submission is not "no alt".** An image with no alt opens an
 *    empty box, and pressing Enter used to write `alt=""`, which marks it
 *    DECORATIVE and hides it from assistive tech. Nothing in the UI passed
 *    `null`, and a form-C embed is atomic with no source-lift, so it could not
 *    be undone once the session's undo stack was gone. An empty submission on
 *    an embed that had no alt now CLEARS the key instead.
 */
async function promptAltText(
  view: EditorView,
  host: HTMLElement,
  id: string,
  current: EmbedLayout,
): Promise<void> {
  const raw = await promptForText(current.alt ?? "", {
    titleKey: "editor.attachment.altPrompt.title",
    confirmKey: "editor.attachment.altPrompt.confirm",
    testidPrefix: "attachment-alt-text",
  });
  if (raw === null) return; // cancelled
  // `]`, not `]]`. A single one is the worse of the two: the tree parser scans
  // for the first `]]` PAIR and renders the embed normally, while the three
  // regex extractors bound the alias with `[^\]]` and match NOTHING, so the note
  // silently leaves the attachment's referencing set and the delete
  // confirmation stops warning about it. `isAliasSafeText` owns the rule so a
  // second writer cannot re-open the gap.
  if (!isAliasSafeText(raw)) {
    showAttachmentToast(i18n.t("editor.attachment.widget.menu.altInvalid"), "error");
    return;
  }
  // Empty box + no alt to begin with = "I did not want one", so clear the key
  // rather than writing the decorative marker. Deliberately marking an image
  // decorative is still reachable: clear an EXISTING alt down to empty.
  const next = raw === "" && current.alt === null ? null : raw;
  updateEmbedLayout(view, host, id, setAlt(next));
}

/**
 * The file-actions and layout rows every inline EMBED (image / PDF) offers.
 * Extracted so the two embed widgets share one definition instead of a second
 * copy of the card's.
 *
 * Export is **absent, not disabled**, when the platform has no export
 * destination: the same rule (and the same reason) the file card applies: the
 * web client has no API granting a page a write path, so offering a row that
 * cannot work is worse than omitting it.
 *
 * The `⋯` sits over the media rather than beside it (an embed has no metadata
 * row to host it), and it is rendered unconditionally rather than revealed on
 * hover: `editor/` is shared with the mobile WebView, where there is no hover
 * and a hover-gated control is simply unreachable.
 */
function buildEmbedOverflowMenu(
  view: EditorView,
  host: HTMLElement,
  id: string,
  filename: string,
  dropped: readonly DroppedEmbedSegment[],
  testidPrefix: string,
): { wrap: HTMLElement; teardown: () => void } {
  // Resolved PER OPEN, not frozen at toDOM time: the checked state has to
  // reflect the layout as it is now. The widget is not rebuilt for every
  // reason the document changes, so a frozen row set would show a stale tick.
  const rows = (): OverflowRow[] => {
    const current = readEmbedLayout(view, host, id)?.layout ?? emptyEmbedLayout();
    return [
      ...(canExportAttachment()
        ? [
            {
              label: i18n.t("editor.attachment.widget.menu.export"),
              testid: `${testidPrefix}.export`,
              run: () => void exportAttachment(id, filename),
            },
          ]
        : []),
      {
        label: i18n.t("editor.attachment.widget.menu.rename"),
        testid: `${testidPrefix}.rename`,
        run: () => void renameFileCard(view, id, filename),
      },
      {
        label: i18n.t("editor.attachment.widget.menu.remove"),
        testid: `${testidPrefix}.remove`,
        run: () => removeFileCard(view, host, id),
      },
      {
        label: i18n.t("editor.attachment.widget.menu.reveal"),
        testid: `${testidPrefix}.reveal`,
        run: () => revealFileCard(view, id),
      },
      { separator: true },
      ...SIZE_PRESETS.map((preset) => ({
        label: i18n.t(preset.labelKey),
        testid: `${testidPrefix}.size-${preset.name}`,
        checked: hasWidth(current, preset.px, preset.percent),
        run: () =>
          updateEmbedLayout(
            view,
            host,
            id,
            preset.px !== null ? toggleWidthPx(preset.px) : toggleWidthPercent(preset.percent!),
          ),
      })),
      {
        label: i18n.t("editor.attachment.widget.menu.customSize"),
        testid: `${testidPrefix}.size-custom`,
        run: () => void promptCustomSize(view, host, id, current),
      },
      { separator: true },
      ...EMBED_ALIGNMENTS.map((align) => ({
        label: i18n.t(`editor.attachment.widget.menu.align.${align}`),
        testid: `${testidPrefix}.align-${align}`,
        checked: current.align === align,
        run: () => updateEmbedLayout(view, host, id, toggleAlign(align)),
      })),
      { separator: true },
      {
        label: i18n.t("editor.attachment.widget.menu.editAlt"),
        testid: `${testidPrefix}.edit-alt`,
        run: () => void promptAltText(view, host, id, current),
      },
      // The verbatim source text §3.9.3 requires. Disabled-not-hidden: it is a
      // report, not an action, and there is nothing sensible to run.
      ...(dropped.length > 0
        ? [
            { separator: true } as OverflowRow,
            {
              label: i18n.t("editor.attachment.widget.unreadableSegment", {
                segments: dropped.map((d) => d.source).join(", "),
              }),
              testid: `${testidPrefix}.unreadable-detail`,
              disabled: true,
              run: () => {},
            } as OverflowRow,
          ]
        : []),
    ];
  };

  const menu = buildOverflowMenu(rows, {
    buttonTestId: `${testidPrefix}.menu-button`,
    menuTestId: `${testidPrefix}.menu`,
  });
  // Overlay positioning; the shared wrap keeps its own class for the button
  // styles, this one only places it.
  menu.wrap.classList.add("cm-attachment-embed-menu");
  return menu;
}

// --- resolved PDF (pdf.js first page, icon fallback) -----------------------

export class AttachmentPdfWidget extends WidgetType {
  /** Build-time object URL — see AttachmentImageWidget.url (#211): keys eq() so a
   *  post-warm rebuild re-renders against the resolved URL on web; no-op on
   *  desktop. */
  private readonly url: string;
  /** Tear-down for the body-mounted overflow menu: see the file card's. */
  private menuTeardown: (() => void) | null = null;

  constructor(
    private readonly id: string,
    private readonly filename: string,
    private readonly layout: EmbedLayout,
    private readonly dropped: readonly DroppedEmbedSegment[],
  ) {
    super();
    this.url = attachmentUrl(id);
  }

  eq(other: AttachmentPdfWidget): boolean {
    return (
      other.id === this.id &&
      other.filename === this.filename &&
      other.url === this.url &&
      sameEmbedLayout(other.layout, this.layout) &&
      sameDroppedSegments(other.dropped, this.dropped)
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const frame = document.createElement("span");
    frame.className = "cm-attachment-frame cm-attachment-pdf";
    applyEmbedLayout(frame, this.layout);

    // The bounded, scrollable reader: the visible scroll container the pages
    // stack in + the IntersectionObserver roots against. It is NEVER hidden —
    // a `display:none` container has no layout, so the observer rooted at it
    // would never fire (the old hidden-until-first-paint deadlock). The reader
    // shows its own small "Loading…" chip inside until the first page paints.
    const scroller = document.createElement("div");
    scroller.className = "cm-attachment-pdf-scroller";
    // Same accessible-name rule as the image widget: the name goes on the media
    // (the reader), never on the frame, so the overflow menu and the marker
    // beside it stay in the accessibility tree. This also fixes an authored
    // EMPTY alt, which the hand-rolled `?? ` here used to turn into a
    // `role="img"` with an empty name (an unnamed graphic a screen reader
    // announces) instead of a decorative element it skips.
    applyEmbedAltText(frame, scroller, this.filename, this.layout);
    // The scroller's stylesheet width is the 320px default. When the embed
    // carries an explicit width the FRAME owns it (and is clamped to the
    // content column), so the scroller fills the frame instead of re-capping it.
    if (this.layout.widthPx !== null || this.layout.widthPercent !== null) {
      scroller.style.width = "100%";
      scroller.style.maxWidth = "100%";
    }
    if (this.layout.heightPx !== null) {
      scroller.style.maxHeight = `${this.layout.heightPx}px`;
    }
    // Clicking the inline reader opens the BIGGER lightbox reader (parallels the
    // image click→lightbox). zoom-in cursor hints the affordance.
    scroller.style.cursor = "zoom-in";
    scroller.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showAttachmentLightbox({
        url: attachmentUrl(this.id),
        alt: this.filename,
        kind: "pdf",
        id: this.id,
      });
    });
    frame.appendChild(scroller);

    const readerCleanup = mountPdfScroller(scroller, {
      url: attachmentUrl(this.id),
      // Render the pages at the width the author asked for, so an enlarged PDF
      // is genuinely re-rendered rather than a 320px raster scaled up. A
      // percentage width has no px value at build time, so it keeps the default.
      pageWidth: this.layout.widthPx ?? FRAME_WIDTH,
      onError: () => {
        // MANDATORY generic-PDF-icon fallback (SYNC-5): pdf.js absent / failed.
        // Already warned (DENY-list-safe) inside the scroller, which has cleared
        // the scroll container. Swap the whole reader for the generic PDF icon.
        const fallback = document.createElement("span");
        fallback.className = "cm-attachment-pdf-fallback";
        fallback.appendChild(makeAttachmentIcon("file"));
        const label = document.createElement("span");
        label.className = "cm-attachment-pdf-fallback-label";
        label.textContent = i18n.t("editor.attachment.widget.pdfFallback");
        fallback.appendChild(label);
        scroller.replaceChildren(fallback);
        scroller.style.cursor = "default";
      },
    });

    appendDroppedSegmentMarker(frame, this.dropped, "attachment-pdf");

    // The reader fills in asynchronously, page by page, so the scroller's height
    // at measure time is not its final height and the height map holds the stale
    // one. The same defect as the image widget's `load` handler, and the reason
    // a click below a PDF lands rows low (myne-md/myne#990). Observing the box
    // rather than hooking pdf.js's render callback keeps this independent of its
    // internals, which the plugin seam is allowed to swap.
    let readerObserver: ResizeObserver | null = null;
    let readerGone = false;
    if (typeof ResizeObserver !== "undefined") {
      readerObserver = new ResizeObserver(() => {
        // A queued delivery can land after the widget is discarded, and
        // `requestMeasure` on a destroyed view is not a no-op.
        if (!readerGone) view.requestMeasure();
      });
      readerObserver.observe(scroller);
    }
    this.cleanup = () => {
      readerGone = true;
      readerObserver?.disconnect();
      readerObserver = null;
      readerCleanup();
    };

    const menu = buildEmbedOverflowMenu(view, frame, this.id, this.filename, this.dropped, "attachment-pdf");
    this.menuTeardown = menu.teardown;
    frame.appendChild(menu.wrap);

    return frame;
  }

  // Tear the reader down (pdf.js task.destroy + observer disconnect) and close
  // any open overflow menu if CM discards this widget's DOM.
  private cleanup: (() => void) | null = null;
  destroy(): void {
    this.cleanup?.();
    this.cleanup = null;
    this.menuTeardown?.();
    this.menuTeardown = null;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// --- tombstone (deleted / broken) ------------------------------------------

/**
 * The deleted/broken chip.
 *
 * Shared with the image widget's decode-failure path (myne-md/myne#990): an
 * embed whose bytes never arrive has to LOOK like the broken reference it is,
 * in place, at its own size, rather than vanish and leave its chrome behind.
 */
function buildTombstoneDom(kind: TombstoneKind, filename: string): HTMLElement {
  const chip = document.createElement("span");
  chip.className =
    kind === "deleted"
      ? "cm-attachment-tombstone cm-attachment-tombstone-deleted"
      : "cm-attachment-tombstone cm-attachment-tombstone-broken";
  chip.setAttribute("role", "img");
  chip.setAttribute(
    "aria-label",
    kind === "deleted"
      ? i18n.t("editor.attachment.widget.tombstone.deletedAria", { filename })
      : i18n.t("editor.attachment.widget.tombstone.brokenAria", { filename }),
  );

  chip.appendChild(makeAttachmentIcon(kind === "deleted" ? "image-off" : "file-warning"));

  const label = document.createElement("span");
  label.className = "cm-attachment-tombstone-label";
  label.textContent =
    filename ||
    (kind === "deleted"
      ? i18n.t("editor.attachment.widget.tombstone.deletedLabel")
      : i18n.t("editor.attachment.widget.tombstone.brokenLabel"));
  chip.appendChild(label);

  return chip;
}

export class AttachmentTombstoneWidget extends WidgetType {
  constructor(
    private readonly kind: TombstoneKind,
    private readonly filename: string,
  ) {
    super();
  }

  eq(other: AttachmentTombstoneWidget): boolean {
    return other.kind === this.kind && other.filename === this.filename;
  }

  toDOM(): HTMLElement {
    return buildTombstoneDom(this.kind, this.filename);
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// --- non-fetching `![](url)` / `![][ref]` chip -----------------------------

export class UrlImageChipWidget extends WidgetType {
  constructor(
    private readonly alt: string,
    private readonly url: string,
  ) {
    super();
  }

  eq(other: UrlImageChipWidget): boolean {
    return other.alt === this.alt && other.url === this.url;
  }

  toDOM(): HTMLElement {
    const chip = document.createElement("span");
    // NEUTRAL chip family (not accent) per the design pass.
    chip.className = "cm-attachment-url-chip";
    chip.setAttribute("role", "img");
    // The raw URL is exposed only as a non-navigating hover tooltip; the chip
    // never fetches it and never offers an "open in browser" affordance.
    chip.title = this.url;

    chip.appendChild(makeAttachmentIcon("image"));

    const label = document.createElement("span");
    label.className = "cm-attachment-url-chip-label";
    // "image (not loaded)" reads at a glance; the alt (if any) names it.
    label.textContent = this.alt !== "" ? this.alt : i18n.t("editor.attachment.widget.urlImageFallback");
    chip.appendChild(label);

    return chip;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// --- resolved generic file (export-only file-card, MYND-173) ---------------

/**
 * A resolved NON-renderable attachment (a generic file — `.docx`, `.zip`,
 * etc., stored as `application/octet-stream`). Renders as a compact card:
 * a file-type icon, the filename, a "type · size" line, and a "⋯" overflow
 * menu (Export / Rename / Remove / Reveal in library). The file content is
 * never rendered inline — "using" the file means Export (MYND-173). The widget
 * is self-contained: CM6 hands it the `EditorView` in `toDOM`, so its menu
 * actions resolve the live document position themselves.
 */
export class AttachmentFileCardWidget extends WidgetType {
  /** Tear-down for the body-mounted overflow menu, so `destroy()` can close it
   *  (and remove its document listener) if CM6 discards the widget while it's
   *  open. */
  private menuTeardown: (() => void) | null = null;

  constructor(
    private readonly id: string,
    private readonly filename: string,
    private readonly size: number,
    /** Segments the author wrote that this version could not read
     *  (`markdown-dialect.md` §3.9.3). Reported on every resolved embed, not
     *  just the media ones (myne-md/myne#518). */
    private readonly dropped: readonly DroppedEmbedSegment[],
  ) {
    super();
  }

  eq(other: AttachmentFileCardWidget): boolean {
    return (
      other.id === this.id &&
      other.filename === this.filename &&
      other.size === this.size &&
      sameDroppedSegments(other.dropped, this.dropped)
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const card = document.createElement("span");
    card.className = "cm-attachment-file-card";
    card.setAttribute("data-testid", "attachment-card");
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", this.filename);

    const icon = makeAttachmentIcon("file");
    icon.classList.add("cm-attachment-file-card-icon");
    card.appendChild(icon);

    const text = document.createElement("span");
    text.className = "cm-attachment-file-card-text";

    const name = document.createElement("span");
    name.className = "cm-attachment-file-card-name";
    name.textContent = this.filename;
    text.appendChild(name);

    const meta = document.createElement("span");
    meta.className = "cm-attachment-file-card-meta";
    // textContent (never innerHTML) per TB2. The type label is resolved here
    // (at render) rather than cached in the constructor, so it tracks a
    // language switch.
    meta.textContent = `${fileTypeLabel(this.filename)} · ${formatBytes(this.size)}`;
    text.appendChild(meta);

    card.appendChild(text);

    const menu = buildOverflowMenu(
      [
        // Absent, not disabled: a platform with no export destination
        // (the web client — no API grants a page a write path) omits the
        // item entirely rather than offering one that cannot work.
        ...(canExportAttachment()
          ? [
              {
                label: i18n.t("editor.attachment.widget.menu.export"),
                testid: "attachment-card.export",
                run: () => void exportAttachment(this.id, this.filename),
              },
            ]
          : []),
        { label: i18n.t("editor.attachment.widget.menu.rename"), testid: "attachment-card.rename", run: () => void renameFileCard(view, this.id, this.filename) },
        { label: i18n.t("editor.attachment.widget.menu.remove"), testid: "attachment-card.remove", run: () => removeFileCard(view, card, this.id) },
        { label: i18n.t("editor.attachment.widget.menu.reveal"), testid: "attachment-card.reveal", run: () => revealFileCard(view, this.id) },
      ],
      { buttonTestId: "attachment-card.menu-button", menuTestId: "attachment-card.menu" },
    );
    this.menuTeardown = menu.teardown;
    card.appendChild(menu.wrap);
    appendDroppedSegmentMarker(card, this.dropped, "attachment-file");
    return card;
  }

  // If CM6 discards the widget while its menu is open, tear the menu down so its
  // document `mousedown` listener cannot outlive the DOM.
  destroy(): void {
    this.menuTeardown?.();
    this.menuTeardown = null;
  }

  // Let clicks reach the menu button / items rather than being swallowed as a
  // CM event; the widget stays atomic (it never mutates doc/selection itself —
  // the actions do, through their own dispatches).
  ignoreEvent(): boolean {
    return false;
  }
}

// --- resolved audio (inline voice-note / audio-file player, MYND-259) ------

/**
 * A resolved audio attachment (a recorded voice note or an imported audio
 * file, served as `audio/wav`). Renders as an inline player: a circular
 * play/pause button, a seek track (the waveform overlays this in a later
 * slice), a `0:00 / 0:00` mono time readout, and the shared "⋯" overflow menu
 * (Export / Rename / Remove / Reveal). Playback runs a hidden `<audio>`
 * element fed from `attachment://<id>` (decrypted in-memory + re-sniffed +
 * allowlisted Rust-side). All visible text is set via `textContent` per TB2.
 */
export class AttachmentAudioWidget extends WidgetType {
  private teardown: (() => void) | null = null;
  /** Build-time object URL — see AttachmentImageWidget.url (#211): keys eq() so a
   *  post-warm rebuild re-renders against the resolved URL on web; no-op on
   *  desktop. */
  private readonly url: string;

  constructor(
    private readonly id: string,
    private readonly filename: string,
    /** Segments the author wrote that this version could not read
     *  (`markdown-dialect.md` §3.9.3). Reported on every resolved embed, not
     *  just the media ones (myne-md/myne#518). */
    private readonly dropped: readonly DroppedEmbedSegment[],
  ) {
    super();
    this.url = attachmentUrl(id);
  }

  eq(other: AttachmentAudioWidget): boolean {
    return (
      other.id === this.id &&
      other.filename === this.filename &&
      other.url === this.url &&
      sameDroppedSegments(other.dropped, this.dropped)
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("span");
    root.className = "cm-attachment-audio";
    root.setAttribute("data-testid", "attachment-audio");
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", this.filename);

    // The playback engine: a hidden media element. `attachment://<id>` is
    // decrypted in-memory, re-sniffed, and allowlist-fenced (audio/wav) by the
    // Rust handler — no plaintext on disk, no network.
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.src = attachmentUrl(this.id);
    audio.style.display = "none";
    root.appendChild(audio);

    // Filename — top-left of the card.
    const name = document.createElement("span");
    name.className = "cm-attachment-audio-name";
    name.setAttribute("data-testid", "attachment-audio.name");
    // Display the name without its extension — the name is enough on the card
    // (rename/export still use the full filename).
    name.textContent = stripFileExtension(this.filename);
    root.appendChild(name);
    appendDroppedSegmentMarker(root, this.dropped, "attachment-audio");

    // Middle row: play button + waveform track + overflow menu, vertically
    // centered together (the play button aligns with the waveform line).
    const row = document.createElement("span");
    row.className = "cm-attachment-audio-row";

    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "cm-attachment-audio-play";
    playBtn.setAttribute("data-testid", "attachment-audio.play");
    playBtn.setAttribute("aria-label", i18n.t("editor.attachment.widget.audio.play"));
    playBtn.appendChild(makeAttachmentIcon("play"));
    row.appendChild(playBtn);

    const track = document.createElement("span");
    track.className = "cm-attachment-audio-track";
    track.setAttribute("data-testid", "attachment-audio.track");
    track.setAttribute("role", "slider");
    track.setAttribute("aria-label", i18n.t("editor.attachment.widget.audio.seek"));
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "0");
    track.setAttribute("aria-valuenow", "0");
    track.tabIndex = 0;
    const fill = document.createElement("span");
    fill.className = "cm-attachment-audio-fill";
    track.appendChild(fill);
    const thumb = document.createElement("span");
    thumb.className = "cm-attachment-audio-thumb";
    track.appendChild(thumb);
    // Waveform bars are rendered into this container once peaks decode; until
    // then the plain fill/thumb above act as the seek bar.
    const wave = document.createElement("span");
    wave.className = "cm-attachment-audio-wave";
    track.appendChild(wave);
    row.appendChild(track);

    // Transcript section (voice-to-text MYND-552): progress + read-only expander
    // + insert action, mounted under the time row. Calls only the host slot.
    const transcript = createTranscriptSection({ view, id: this.id });

    // Built PER menu-open (a provider fn, not a frozen array): the widget is not
    // re-created when the transcription compartment reconfigures (CMEditor
    // dispatches `reconfigureTranscription` on the `transcriptionEnabled` prop
    // flip, MYND-592), so a list frozen at `toDOM` time would keep offering
    // Transcribe after the user turned transcription off. Reading the facet here
    // means each open reflects the live state (tr2).
    const buildActions = (): OverflowAction[] => {
      const actions: OverflowAction[] = [
        // Absent, not disabled: a platform with no export destination
        // (the web client — no API grants a page a write path) omits the
        // item entirely rather than offering one that cannot work.
        ...(canExportAttachment()
          ? [
              {
                label: i18n.t("editor.attachment.widget.menu.export"),
                testid: "attachment-audio.export",
                run: () => void exportAttachment(this.id, this.filename),
              },
            ]
          : []),
        { label: i18n.t("editor.attachment.widget.menu.rename"), testid: "attachment-audio.rename", run: () => void renameFileCard(view, this.id, this.filename) },
        { label: i18n.t("editor.attachment.widget.menu.remove"), testid: "attachment-audio.remove", run: () => removeFileCard(view, root, this.id) },
        { label: i18n.t("editor.attachment.widget.menu.reveal"), testid: "attachment-audio.reveal", run: () => revealFileCard(view, this.id) },
      ];
      // "Transcribe" (SYNC-V7) — only when the host backs speech-to-text (desktop;
      // mobile leaves the slot unset → row omitted) AND transcription is enabled.
      // When it is off the row is HIDDEN, not shown-disabled (MYND-270 product
      // tweak: no dangling affordance when the whole subsystem is off), and the
      // Attachments Library now hides it the same way rather than greying it.
      // When a model is not ready the run surfaces a hint instead (inside the
      // transcript section).
      //
      // MYND-592: this gate was `aiSlashEnabledFacet` — the AI beta opt-in with
      // the AI-excluded-folder rule folded in. Both were wrong here. The opt-in
      // is for the embedding store, and a folder excluded from ambient AI
      // *reading* says nothing about whether the user may transcribe a file they
      // explicitly picked.
      if (getHost().transcribe !== undefined && view.state.facet(transcriptionEnabledFacet)) {
        actions.push({
          label: i18n.t("editor.attachment.widget.menu.transcribe"),
          testid: "attachment-audio.transcribe",
          run: () => transcript.start(),
        });
      }
      return actions;
    };

    const menu = buildOverflowMenu(buildActions, {
      buttonTestId: "attachment-audio.menu-button",
      menuTestId: "attachment-audio.menu",
    });
    row.appendChild(menu.wrap);

    root.appendChild(row);

    // Time — bottom row, left-most.
    const time = document.createElement("span");
    time.className = "cm-attachment-audio-time";
    time.setAttribute("data-testid", "attachment-audio.time");
    time.textContent = "0:00 / 0:00";
    root.appendChild(time);

    // Transcript surface sits below the time row (progress / expander render
    // here on demand; a cached transcript re-renders synchronously).
    root.appendChild(transcript.container);

    // --- playback wiring ---
    let duration = 0;
    let bars: HTMLElement[] = [];
    const setPaused = (paused: boolean) => {
      playBtn.replaceChildren(makeAttachmentIcon(paused ? "play" : "pause"));
      playBtn.setAttribute(
        "aria-label",
        paused
          ? i18n.t("editor.attachment.widget.audio.play")
          : i18n.t("editor.attachment.widget.audio.pause"),
      );
    };
    const render = () => {
      const cur = audio.currentTime || 0;
      const ratio = duration > 0 ? Math.min(1, cur / duration) : 0;
      if (bars.length > 0) {
        // Waveform mode: color the played-through bars accent, the rest muted.
        const played = Math.round(ratio * bars.length);
        for (let i = 0; i < bars.length; i++) {
          bars[i].classList.toggle("cm-attachment-audio-bar-played", i < played);
        }
      } else {
        // Plain-fill fallback (pre-decode / decode failed).
        fill.style.width = `${ratio * 100}%`;
        thumb.style.left = `${ratio * 100}%`;
      }
      time.textContent = `${formatClock(cur)} / ${formatClock(duration)}`;
      track.setAttribute("aria-valuenow", String(Math.floor(cur)));
    };
    const toggle = () => {
      if (audio.paused) {
        void audio.play();
        setPaused(false);
      } else {
        audio.pause();
        setPaused(true);
      }
    };

    audio.addEventListener("loadedmetadata", () => {
      duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      track.setAttribute("aria-valuemax", String(Math.floor(duration)));
      render();
    });
    audio.addEventListener("timeupdate", render);
    audio.addEventListener("ended", () => setPaused(true));

    playBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    });

    track.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (duration <= 0) return;
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      audio.currentTime = ratio * duration;
      render();
    });
    track.addEventListener("keydown", (e) => {
      let handled = true;
      switch (e.key) {
        case "ArrowRight":
          if (duration > 0) audio.currentTime = Math.min(duration, audio.currentTime + 5);
          break;
        case "ArrowLeft":
          if (duration > 0) audio.currentTime = Math.max(0, audio.currentTime - 5);
          break;
        case "Home":
          audio.currentTime = 0;
          break;
        case "End":
          if (duration > 0) audio.currentTime = duration;
          break;
        case " ":
        case "Enter":
          toggle();
          break;
        default:
          handled = false;
      }
      if (handled) {
        e.preventDefault();
        render();
      }
    });

    // Lazy waveform: decode peaks only once the player scrolls into view, then
    // render bars onto the track (replacing the plain progress fill). decodePeaks
    // caches by id, so a re-render or a second embed of the same clip never
    // re-decodes. A decode failure leaves the plain fill in place.
    let observer: IntersectionObserver | null = null;
    const renderWaveform = async () => {
      try {
        const peaks = await decodePeaks(attachmentUrl(this.id), WAVEFORM_BUCKETS);
        if (peaks.length === 0) return;
        bars = peaks.map((p) => {
          const bar = document.createElement("span");
          bar.className = "cm-attachment-audio-bar";
          bar.style.height = `${Math.max(MIN_BAR_PCT, p * 100)}%`;
          return bar;
        });
        wave.replaceChildren(...bars);
        track.classList.add("cm-attachment-audio-track-wave");
        render();
      } catch {
        // Decode unavailable / failed → keep the plain progress fill (graceful).
      }
    };
    if (typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            observer?.disconnect();
            observer = null;
            void renderWaveform();
            break;
          }
        }
      });
      observer.observe(root);
    } else {
      void renderWaveform();
    }

    this.teardown = () => {
      observer?.disconnect();
      observer = null;
      menu.teardown();
      transcript.teardown();
      audio.pause();
      audio.removeAttribute("src");
      audio.load(); // release the decoded buffer
    };
    return root;
  }

  // Stop playback + tear the menu down if CM6 discards the widget's DOM.
  destroy(): void {
    this.teardown?.();
    this.teardown = null;
  }

  // Let clicks reach the play button / track / menu rather than being swallowed
  // as a CM event; the widget stays atomic (it never mutates doc/selection).
  ignoreEvent(): boolean {
    return false;
  }
}

/** Number of waveform bars rendered across the seek track. */
const WAVEFORM_BUCKETS = 48;
/** Minimum bar height (% of track) so a near-silent bucket still reads. */
const MIN_BAR_PCT = 8;

/** Drop a trailing file extension for the card label ("…29.wav" → "…29"). */
function stripFileExtension(filename: string): string {
  return filename.replace(/\.[A-Za-z0-9]{1,8}$/, "");
}

// --- resolved video (inline native player, MP4/WebM, myne#168) -------------

/**
 * A resolved video attachment (MP4/WebM, served as `video/mp4` / `video/webm`).
 * Renders inline as a native `<video controls>` player fed from
 * `attachment://<id>` (decrypted in-memory + re-sniffed + allowlist-fenced
 * Rust-side, myne#168 / SYNC-1). Deliberately native chrome — no autoplay, loop
 * or mute; the browser's own controls give seek + volume + fullscreen +
 * accessibility for free, and `preload="metadata"` paints the first frame as
 * the poster (no separate poster artefact). Sized within the image frame's edge
 * so a portrait clip doesn't dominate the note. The `<video error>` → file-card
 * fallback for an undecodable file is task 3 (a separate slice); this widget is
 * the happy path. Structurally modelled on the file-card / audio widgets: the
 * shared "⋯" overflow menu (Export / Rename / Remove / Reveal) and a teardown
 * that releases the media buffer if CM6 discards the DOM.
 */
export class AttachmentVideoWidget extends WidgetType {
  private teardown: (() => void) | null = null;
  /** Build-time object URL — see AttachmentImageWidget.url (#211): keys eq() so a
   *  post-warm rebuild re-renders against the resolved URL on web; no-op on
   *  desktop. */
  private readonly url: string;

  constructor(
    private readonly id: string,
    private readonly filename: string,
    private readonly size: number,
    /** Segments the author wrote that this version could not read
     *  (`markdown-dialect.md` §3.9.3). Reported on every resolved embed, not
     *  just the media ones (myne-md/myne#518). */
    private readonly dropped: readonly DroppedEmbedSegment[],
  ) {
    super();
    this.url = attachmentUrl(id);
  }

  eq(other: AttachmentVideoWidget): boolean {
    return (
      other.id === this.id &&
      other.filename === this.filename &&
      other.size === this.size &&
      other.url === this.url &&
      sameDroppedSegments(other.dropped, this.dropped)
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const frame = document.createElement("span");
    frame.className = "cm-attachment-frame cm-attachment-video";
    frame.setAttribute("data-testid", "attachment-video");
    frame.setAttribute("role", "group");
    frame.setAttribute("aria-label", this.filename);

    // Clean progress chip until the first frame + metadata paint; removed on
    // `loadedmetadata` (or left in place under the still-hidden player if decode
    // never starts — the task-3 error path swaps to the file card there).
    const loading = makeProgressChip("loading");
    frame.appendChild(loading);

    // The player: a native `<video controls>`. `attachment://<id>` is decrypted
    // in-memory, re-sniffed and allowlist-fenced (video/mp4|video/webm) by the
    // Rust handler — no plaintext on disk, no network. `playsinline` keeps the
    // WebView from hijacking fullscreen on iOS.
    const video = document.createElement("video");
    video.setAttribute("data-testid", "attachment-video.player");
    video.controls = true;
    video.preload = "metadata";
    video.setAttribute("playsinline", "");
    video.src = this.url;
    // Bound any orientation to the image frame's edge so a tall/portrait clip
    // does not dominate the note (grill: "sized per image-widget constraints").
    video.style.maxWidth = `${FRAME_WIDTH}px`;
    video.style.maxHeight = `${FRAME_WIDTH}px`;
    video.style.display = "none";
    video.addEventListener("loadedmetadata", () => {
      video.style.display = "block";
      loading.remove();
      // Same defect as the image widget's `load` handler: the box appears after
      // the measure, so the height map is stale until something else updates
      // (myne-md/myne#990).
      view.requestMeasure();
    });
    frame.appendChild(video);

    const menu = buildOverflowMenu(
      [
        // Absent, not disabled: a platform with no export destination (the web
        // client) omits the item rather than offering one that cannot work.
        ...(canExportAttachment()
          ? [
              {
                label: i18n.t("editor.attachment.widget.menu.export"),
                testid: "attachment-video.export",
                run: () => void exportAttachment(this.id, this.filename),
              },
            ]
          : []),
        { label: i18n.t("editor.attachment.widget.menu.rename"), testid: "attachment-video.rename", run: () => void renameFileCard(view, this.id, this.filename) },
        { label: i18n.t("editor.attachment.widget.menu.remove"), testid: "attachment-video.remove", run: () => removeFileCard(view, frame, this.id) },
        { label: i18n.t("editor.attachment.widget.menu.reveal"), testid: "attachment-video.reveal", run: () => revealFileCard(view, this.id) },
      ],
      { buttonTestId: "attachment-video.menu-button", menuTestId: "attachment-video.menu" },
    );
    frame.appendChild(menu.wrap);

    this.teardown = () => {
      menu.teardown();
      video.pause();
      video.removeAttribute("src");
      video.load(); // release the decoded buffer
    };

    // Graceful fallback (task 3): a video the WebView cannot decode — WebM under
    // Linux WebKitGTK with no system codec, a MOV that reached here, a corrupt
    // file — fires `error`. Swap the whole widget to the export-only file card
    // (the same widget an unsupported/oversize file gets) so it degrades cleanly
    // instead of leaving a broken player. Idempotent via `swapped`; the fallback
    // is a real AttachmentFileCardWidget so its overflow menu tears down through
    // our destroy(). (A pre-this-feature octet-stream video never reaches this
    // widget at all — it routes straight to the file card — so that path needs
    // nothing here.)
    let swapped = false;
    video.addEventListener("error", () => {
      if (swapped) return;
      swapped = true;
      this.teardown?.(); // pause + release the buffer + tear the video menu down
      // `this.dropped` is threaded through rather than dropped: the swap does
      // `frame.replaceChildren(card)` below, which removes the marker this
      // widget appended, so a video that carries an unreadable segment AND
      // fails to decode would lose its §3.9.3 report entirely. The compiler
      // named this site the moment the parameter stopped having a default.
      const fallback = new AttachmentFileCardWidget(
        this.id,
        this.filename,
        this.size,
        this.dropped,
      );
      const card = fallback.toDOM(view);
      frame.classList.remove("cm-attachment-frame", "cm-attachment-video");
      frame.removeAttribute("role");
      frame.removeAttribute("aria-label");
      frame.replaceChildren(card);
      // Keep the fallback card's menu teardown reachable if CM6 later discards
      // the frame while that menu is open.
      this.teardown = () => fallback.destroy();
    });

    appendDroppedSegmentMarker(frame, this.dropped, "attachment-video");
    return frame;
  }

  // Stop playback + tear the menu down if CM6 discards the widget's DOM.
  destroy(): void {
    this.teardown?.();
    this.teardown = null;
  }

  // Let clicks reach the native controls / menu rather than being swallowed as a
  // CM event; the widget stays atomic (it never mutates doc/selection).
  ignoreEvent(): boolean {
    return false;
  }
}

// --- resolved text/code/csv (inline read-only preview, MYND-268 Tier-1) ----

/** Filename extensions that get a Tier-1 inline TEXT preview instead of the
 *  export-only file-card. Generic files are stored as `application/octet-stream`
 *  (MYND-173), so the extension — not the content-type — is the routing key.
 *  (`.svg` is absent: real SVGs import as `image/svg+xml` and take the image
 *  path before ever reaching the generic branch.) */
const PREVIEWABLE_TEXT_EXT = new Set<string>([
  "txt", "log", "md", "markdown", "csv", "tsv", "json", "jsonl",
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "css", "scss", "less", "html", "htm", "xml",
  "yml", "yaml", "toml", "ini", "env", "rs", "py", "go", "java", "kt", "c", "h",
  "cpp", "hpp", "cc", "rb", "php", "sh", "bash", "zsh", "sql", "lua", "swift", "dart",
]);

function fileExt(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

/** True when a generic attachment's filename is a Tier-1 previewable text type.
 *  Extension-only (no `getHost()` — this runs at decoration-compute time, where
 *  the host may not be installed yet, e.g. in tests). Whether the decrypt-to-text
 *  seam actually exists is checked in the widget's `toDOM`, which degrades to the
 *  file-card chrome when it's absent (mobile). */
export function isPreviewableTextFile(filename: string): boolean {
  return PREVIEWABLE_TEXT_EXT.has(fileExt(filename));
}

/** Extensions that get a Tier-2 STRUCTURED preview (parsed in Rust to a safe
 *  grid/block model), not a raw-text preview. */
const PREVIEWABLE_STRUCTURED_EXT = new Set<string>(["xlsx", "docx"]);

/** True when a generic attachment is a Tier-2 structured-preview type. */
export function isPreviewableStructuredFile(filename: string): boolean {
  return PREVIEWABLE_STRUCTURED_EXT.has(fileExt(filename));
}

/** The Rust structured model (mirror of the host's `readStructured` result). */
type StructuredPreview =
  | { kind: "grid"; rows: string[][] }
  | { kind: "blocks"; blocks: { heading_level: number | null; text: string }[] };

/** Minimal CSV/TSV split for a preview grid — splits rows on newlines and each
 *  row on the delimiter, unwrapping simple `"quoted"` fields. Preview-grade
 *  (not a spec-complete CSV parser); a malformed cell just reads as its raw
 *  text. Rows are capped so a huge sheet doesn't build thousands of DOM nodes. */
function parsePreviewGrid(text: string, delimiter: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === "" && rows.length > 0) continue; // skip blank trailing lines
    const cells: string[] = [];
    for (const raw of line.split(delimiter)) {
      const trimmed = raw.trim();
      cells.push(
        trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2
          ? trimmed.slice(1, -1).replace(/""/g, '"')
          : raw,
      );
    }
    rows.push(cells);
    if (rows.length >= maxRows) break;
  }
  return rows;
}

/** Max grid rows rendered inline (the rest is available via Export). */
const PREVIEW_GRID_MAX_ROWS = 500;

/**
 * Max grid COLUMNS rendered inline (myne#310).
 *
 * The row cap alone does not bound the DOM build: a crafted `.xlsx` whose rows
 * each name one cell at Excel's last column (`XFD`) arrives as 16,384 entries
 * per row, and 500 × 16,384 is ~8.2 M synchronous `<td>` appends — hundreds of
 * MB to GB of nodes, a frozen editor, and a plausible renderer kill.
 *
 * The host now clamps too, but this clamp is deliberately independent of it:
 * this function's own contract is that it must not trust any future host with
 * an unbounded synchronous node build, and it only implemented that for rows.
 * An inline preview a few hundred pixels tall shows tens of columns.
 */
const PREVIEW_GRID_MAX_COLS = 256;

// --- preview result cache ---------------------------------------------------
//
// The attachment-embed decoration set is rebuilt over `visibleRanges` on every
// viewport change, so without a cache each scroll-past re-issues the whole IPC
// + AEAD decrypt (+ Rust parse for docx/xlsx) AND swaps the loading chip for
// content AFTER CodeMirror measured the widget — a document-height mutation at
// the viewport edge (the long-doc scroll-destabilization class). Caching the
// RESULT (never DOM) lets a re-entering widget render synchronously in `toDOM`.

/** One decrypt round trip's outcome. An error is an outcome too: a failing
 *  read degrades to the file-card once instead of re-issuing an IPC every time
 *  the embed scrolls back into view. */
export type PreviewOutcome =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "structured"; content: StructuredPreview }
  | { kind: "error" };

export interface PreviewCacheEntry {
  outcome: PreviewOutcome;
  /** Last measured card height (px) — feeds `estimatedHeight` so a widget
   *  re-entering the viewport is laid out at its real height immediately. */
  height: number | null;
}

/** Bound for {@link previewCache}. Each entry is one ≤320px preview's source
 *  data, itself capped by the host's read cap (2 MiB on desktop —
 *  `ATTACHMENT_TEXT_PREVIEW_CAP`), so worst-case retention stays modest. */
const PREVIEW_CACHE_MAX = 24;

// The two maps live in `./session-caches`, a leaf with no imports, because the
// vault-leaving paths have to clear them and reaching into THIS file to do that
// puts the whole attachment-widget subtree into the app's eager bundle graph.
// The key derivation, the LRU eviction and the in-flight de-dup below are still
// this file's; only the containers moved. `session-caches.ts` states why.
//
// LRU-ish: `Map` iterates in insertion order, a hit re-inserts, overflow evicts
// the oldest. The in-flight map lets concurrent `toDOM` for the same attachment
// (the same file embedded twice, or a rebuild racing a slow read) share ONE IPC
// round trip.

/** Cache key: attachment id + preview tier (the structured kinds parse
 *  differently from the raw-text tier, so they cache separately). */
function previewCacheKey(id: string, filename: string): string {
  const ext = fileExt(filename);
  return `${id}:${PREVIEWABLE_STRUCTURED_EXT.has(ext) ? ext : "text"}`;
}

function previewCacheGet(key: string): PreviewCacheEntry | undefined {
  const entry = previewCache.get(key);
  if (entry !== undefined) {
    // LRU touch — re-insertion moves the key to the young end.
    previewCache.delete(key);
    previewCache.set(key, entry);
  }
  return entry;
}

function previewCachePut(key: string, outcome: PreviewOutcome): void {
  const height = previewCache.get(key)?.height ?? null;
  previewCache.delete(key);
  previewCache.set(key, { outcome, height });
  while (previewCache.size > PREVIEW_CACHE_MAX) {
    const oldest = previewCache.keys().next().value;
    if (oldest === undefined) break;
    previewCache.delete(oldest);
  }
}

/** Share (or start) the fetch for `key`. `read` must never reject — it maps
 *  failures to the error outcome — so the promise always settles into the
 *  cache and the in-flight entry can never leak. */
function fetchPreviewOutcome(
  key: string,
  read: () => Promise<PreviewOutcome>,
): Promise<PreviewOutcome> {
  let inflight = previewInFlight.get(key);
  if (inflight === undefined) {
    // Captured at ISSUE, compared before the write. A lock or a vault switch
    // between the two bumps the generation, and the outcome is then returned to
    // this caller (whose widget is about to be torn down anyway) without ever
    // reaching the module-scope cache. Clearing the map cannot do this: the
    // closure below already holds `key` and writes straight into `previewCache`.
    const issuedAt = sessionGeneration();
    inflight = read().then((outcome) => {
      previewInFlight.delete(key);
      if (isCurrentGeneration(issuedAt)) previewCachePut(key, outcome);
      return outcome;
    });
    previewInFlight.set(key, inflight);
  }
  return inflight;
}

/** `estimatedHeight` fallbacks (px) before the first real measure: the
 *  header-only card (error → body removed) vs a card whose body typically
 *  fills the 320px max-height. CM corrects on measure; the measured height is
 *  then remembered per attachment so re-entry estimates are exact. */
const PREVIEW_EST_HEADER_PX = 48;
const PREVIEW_EST_CARD_PX = 368;

/**
 * A resolved TEXT attachment (txt/code/csv/md, stored generic) rendered as an
 * inline READ-ONLY preview (MYND-268 Tier-1). Decrypts to text via the host
 * seam (`attachments.readText`, RAM-only), then renders it INERT — a monospace
 * `<pre>` for text/code, a `<table>` for csv/tsv — never as interpreted HTML.
 * All text is set via `textContent` (never `innerHTML`) per TB2. Falls back to
 * the file-card chrome (icon + name + Export/Rename/Remove/Reveal menu) while
 * loading, on read failure, or when the host omits the seam.
 */
export class AttachmentTextPreviewWidget extends WidgetType {
  private menuTeardown: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    private readonly id: string,
    private readonly filename: string,
    private readonly size: number,
    /** Segments the author wrote that this version could not read
     *  (`markdown-dialect.md` §3.9.3). Reported on every resolved embed, not
     *  just the media ones (myne-md/myne#518). */
    private readonly dropped: readonly DroppedEmbedSegment[],
  ) {
    super();
  }

  eq(other: AttachmentTextPreviewWidget): boolean {
    return (
      other.id === this.id &&
      other.filename === this.filename &&
      other.size === this.size &&
      sameDroppedSegments(other.dropped, this.dropped)
    );
  }

  // Height estimate BEFORE the first draw, so CM's height map doesn't discover
  // the real height as a surprise mutation mid-scroll (see previewCache note).
  get estimatedHeight(): number {
    const entry = previewCache.get(previewCacheKey(this.id, this.filename));
    if (entry !== undefined) {
      if (entry.height !== null) return entry.height;
      if (entry.outcome.kind === "error") return PREVIEW_EST_HEADER_PX;
    }
    return PREVIEW_EST_CARD_PX;
  }

  toDOM(view: EditorView): HTMLElement {
    const card = document.createElement("span");
    card.className = "cm-attachment-file-card cm-attachment-text-preview";
    card.setAttribute("data-testid", "attachment-text-preview");
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", this.filename);

    // Header row: icon + name + type·size + overflow menu (same chrome + actions
    // as the file-card, so Export/Rename/Remove/Reveal stay available).
    const header = document.createElement("span");
    header.className = "cm-attachment-text-preview-header";

    const icon = makeAttachmentIcon("file");
    icon.classList.add("cm-attachment-file-card-icon");
    header.appendChild(icon);

    const text = document.createElement("span");
    text.className = "cm-attachment-file-card-text";
    const name = document.createElement("span");
    name.className = "cm-attachment-file-card-name";
    name.textContent = this.filename;
    text.appendChild(name);
    const meta = document.createElement("span");
    meta.className = "cm-attachment-file-card-meta";
    meta.textContent = `${fileTypeLabel(this.filename)} · ${formatBytes(this.size)}`;
    text.appendChild(meta);
    header.appendChild(text);

    const menu = buildOverflowMenu(
      [
        // Absent, not disabled: a platform with no export destination
        // (the web client — no API grants a page a write path) omits the
        // item entirely rather than offering one that cannot work.
        ...(canExportAttachment()
          ? [
              {
                label: i18n.t("editor.attachment.widget.menu.export"),
                testid: "attachment-text-preview.export",
                run: () => void exportAttachment(this.id, this.filename),
              },
            ]
          : []),
        { label: i18n.t("editor.attachment.widget.menu.rename"), testid: "attachment-text-preview.rename", run: () => void renameFileCard(view, this.id, this.filename) },
        { label: i18n.t("editor.attachment.widget.menu.remove"), testid: "attachment-text-preview.remove", run: () => removeFileCard(view, card, this.id) },
        { label: i18n.t("editor.attachment.widget.menu.reveal"), testid: "attachment-text-preview.reveal", run: () => revealFileCard(view, this.id) },
      ],
      { buttonTestId: "attachment-text-preview.menu-button", menuTestId: "attachment-text-preview.menu" },
    );
    this.menuTeardown = menu.teardown;
    header.appendChild(menu.wrap);
    card.appendChild(header);

    // Body: rendered SYNCHRONOUSLY from the cache when this attachment already
    // decrypted once (no loading chip, no async height swap); otherwise a
    // loading chip until the de-duped decrypt+decode resolves. A read failure /
    // absent seam just leaves the header (file-card).
    const body = document.createElement("span");
    body.className = "cm-attachment-text-preview-body";
    body.style.display = "block";
    body.style.maxHeight = "320px";
    body.style.overflow = "auto";
    card.appendChild(body);

    const ext = fileExt(this.filename);
    const structuredKind = ext === "xlsx" ? "xlsx" : ext === "docx" ? "docx" : null;
    const host = getHost().attachments;
    // DEV-only diagnostic: the inline preview silently degrades to the file-card
    // header on any failure, which makes a broken read indistinguishable from an
    // absent seam. Surface WHY in dev so a systematic preview failure is debuggable.
    const warnPreview = (stage: string, reason: unknown): void => {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn(`[attachment-preview] ${stage} failed for ${this.filename}:`, reason);
      }
    };
    const renderOutcome = (outcome: PreviewOutcome): void => {
      if (outcome.kind === "error") {
        body.remove(); // drop to the file-card
        return;
      }
      if (outcome.kind === "structured") {
        body.replaceChildren(this.renderStructured(outcome.content));
        return;
      }
      const rendered =
        ext === "csv" || ext === "tsv"
          ? this.renderGrid(outcome.text, ext === "tsv" ? "\t" : ",")
          : this.renderText(outcome.text);
      body.replaceChildren(rendered);
      if (outcome.truncated) {
        const notice = document.createElement("span");
        notice.className = "cm-attachment-text-preview-truncated";
        notice.textContent = i18n.t("editor.attachment.widget.textPreview.truncated");
        body.appendChild(notice);
      }
    };

    const key = previewCacheKey(this.id, this.filename);
    const cached = previewCacheGet(key);
    if (cached !== undefined) {
      renderOutcome(cached.outcome);
    } else if (structuredKind !== null) {
      // Tier-2: Rust parses the docx/xlsx into a safe structured model.
      const readStructured = host.readStructured;
      if (readStructured === undefined) {
        warnPreview("readStructured", "host seam undefined");
        body.remove();
      } else {
        body.appendChild(makeProgressChip("loading"));
        void fetchPreviewOutcome(key, () =>
          readStructured(this.id, structuredKind).then(
            (content): PreviewOutcome => ({ kind: "structured", content }),
            (err: unknown): PreviewOutcome => {
              warnPreview("readStructured", err);
              return { kind: "error" };
            },
          ),
        ).then(renderOutcome);
      }
    } else {
      // Tier-1: raw decrypted text (a <pre> for text/code, a <table> for csv/tsv).
      const readText = host.readText;
      if (readText === undefined) {
        warnPreview("readText", "host seam undefined");
        body.remove(); // no seam → behave as a plain file-card
      } else {
        body.appendChild(makeProgressChip("loading"));
        void fetchPreviewOutcome(key, () =>
          readText(this.id).then(
            ({ text, truncated }): PreviewOutcome => ({ kind: "text", text, truncated }),
            (err: unknown): PreviewOutcome => {
              // Read failed (locked / not-found / decode) — drop to the file-card.
              warnPreview("readText", err);
              return { kind: "error" };
            },
          ),
        ).then(renderOutcome);
      }
    }

    // Remember the measured card height so `estimatedHeight` is exact when the
    // embed re-enters the viewport. Recorded only once the outcome is cached —
    // the loading-chip height is not representative.
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        // The card grew or shrank after the measure: the height map is stale
        // until something re-measures (myne-md/myne#990).
        view.requestMeasure();
        const entry = previewCache.get(key);
        if (entry === undefined) return;
        const measured = card.getBoundingClientRect().height;
        if (measured > 0) entry.height = measured;
      });
      this.resizeObserver.observe(card);
    }

    appendDroppedSegmentMarker(card, this.dropped, "attachment-text");
    return card;
  }

  /** Inert monospace text render (text/code/md). `textContent` only (TB2). */
  private renderText(content: string): HTMLElement {
    const pre = document.createElement("pre");
    pre.className = "cm-attachment-text-preview-pre";
    pre.style.fontFamily = "var(--font-mono, monospace)";
    pre.style.fontSize = "12px";
    pre.style.whiteSpace = "pre";
    pre.style.margin = "0";
    pre.textContent = content;
    return pre;
  }

  /** Inert grid render (csv/tsv) — a bounded `<table>`, `textContent` cells. */
  private renderGrid(content: string, delimiter: string): HTMLElement {
    const rows = parsePreviewGrid(content, delimiter, PREVIEW_GRID_MAX_ROWS);
    const table = document.createElement("table");
    table.className = "cm-attachment-text-preview-table";
    for (const row of rows) {
      const tr = document.createElement("tr");
      // Columns bounded as well as rows (myne#310): a CSV line with a million
      // commas is one row and a million `<td>` appends.
      for (const cell of row.slice(0, PREVIEW_GRID_MAX_COLS)) {
        const td = document.createElement("td");
        td.textContent = cell;
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    return table;
  }

  /** Inert render of the Rust structured model (Tier-2): a `<table>` grid (xlsx)
   *  or a heading/paragraph block list (docx). `textContent` only (TB2). The
   *  desktop host caps rows Rust-side, but this layer bounds its own DOM build
   *  too — it must not trust any future host with an unbounded synchronous
   *  node build. */
  private renderStructured(content: StructuredPreview): HTMLElement {
    if (content.kind === "grid") {
      const table = document.createElement("table");
      table.className = "cm-attachment-text-preview-table";
      for (const row of content.rows.slice(0, PREVIEW_GRID_MAX_ROWS)) {
        const tr = document.createElement("tr");
        for (const cell of row.slice(0, PREVIEW_GRID_MAX_COLS)) {
          const td = document.createElement("td");
          td.textContent = cell;
          tr.appendChild(td);
        }
        table.appendChild(tr);
      }
      return table;
    }
    const wrap = document.createElement("div");
    wrap.className = "cm-attachment-text-preview-doc";
    for (const block of content.blocks.slice(0, PREVIEW_GRID_MAX_ROWS)) {
      // Round before clamping — a fractional level would make createElement
      // throw ("h2.5" is not a valid tag name), wedging the loading chip.
      const el =
        block.heading_level !== null
          ? document.createElement(`h${Math.min(6, Math.max(1, Math.round(block.heading_level)))}`)
          : document.createElement("p");
      el.textContent = block.text;
      wrap.appendChild(el);
    }
    return wrap;
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.menuTeardown?.();
    this.menuTeardown = null;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/** Build the appropriate resolved-attachment widget for a content-type. SVG +
 *  raster share the `<img>` path; PDF takes the pdf.js path; audio takes the
 *  inline player (MYND-259). A generic attachment with a previewable text
 *  extension (MYND-268 Tier-1) takes the inline read-only preview; every other
 *  generic (non-renderable) attachment — `application/octet-stream`, MYND-173 —
 *  takes the export-only file-card path. */
export function makeResolvedWidget(
  row: CatalogRow,
  layout: EmbedLayout,
  dropped: readonly DroppedEmbedSegment[],
  /** Whether the caller is drawing this embed as a whole-line block. Only the
   *  image widget reads it today, to decide whether to carry drag-resize handles
   *  (myne-md/myne#604); the other five ignore it. Threaded through here rather
   *  than read from the DOM because the widget is constructed before it has any.
   *
   *  Required, not defaulted to the inline arm. A default here would answer for
   *  every future caller in the direction that draws no handles, which is the
   *  shape `AGENTS.md` records under "a guard parameter with a default value is
   *  an opt-in guard": the arm that never fires is the one a new call site
   *  silently takes. Both builders state their form. */
  block: boolean,
): WidgetType {
  // `layout` is media-only and `dropped` is NOT, and the two used to travel
  // together as if they were one thing (myne-md/myne#518). A file card, an audio
  // player and a text preview have no meaningful width/alignment story yet, so
  // giving them a layout silently would be a feature nobody specified. A dropped
  // SEGMENT is a different fact: it says the author wrote a known key with a
  // value this version could not read, and that is worth telling them whatever
  // the attachment turns out to be. `markdown-dialect.md` §3.9.3 asks for the
  // marker without scoping it to a media type, and four of the six widgets took
  // the list and discarded it, so a bad segment on an audio embed was reported
  // nowhere at all.
  if (row.contentType === "application/pdf") {
    return new AttachmentPdfWidget(row.id, row.filename, layout, dropped);
  }
  if (isRenderableImageType(row.contentType)) {
    return new AttachmentImageWidget(row.id, row.filename, layout, dropped, block);
  }
  if (isPlayableAudioType(row.contentType)) {
    return new AttachmentAudioWidget(row.id, row.filename, dropped);
  }
  if (isPlayableVideoType(row.contentType)) {
    return new AttachmentVideoWidget(row.id, row.filename, row.size, dropped);
  }
  // Generic with a previewable extension → inline read-only preview (Tier-1
  // text/code/csv, or Tier-2 Rust-parsed docx/xlsx).
  if (isPreviewableTextFile(row.filename) || isPreviewableStructuredFile(row.filename)) {
    return new AttachmentTextPreviewWidget(row.id, row.filename, row.size, dropped);
  }
  // Otherwise generic / non-renderable → export-only file-card.
  return new AttachmentFileCardWidget(row.id, row.filename, row.size, dropped);
}

/** The raster/SVG content-types the `attachment://` handler serves inline. */
function isRenderableImageType(contentType: string): boolean {
  return contentType.startsWith("image/");
}

/** The audio content-types served inline as a player (v0.1: WAV only). */
function isPlayableAudioType(contentType: string): boolean {
  return contentType.startsWith("audio/");
}

/** The video content-types served inline as a native player (myne#168: MP4 +
 *  WebM). Exact-match rather than a `video/` prefix (unlike the audio/image
 *  predicates) is a deliberate per-format opt-in: a new served video container
 *  must be added BOTH to the serve allowlist and here, so inline rendering stays
 *  an explicit choice — a container the WebView may not decode is never
 *  auto-routed to a `<video>` on a prefix match. (A mismatched `video/*` hint
 *  would still degrade gracefully via the widget's error→file-card fallback.) */
function isPlayableVideoType(contentType: string): boolean {
  return contentType === "video/mp4" || contentType === "video/webm";
}

/** Narrowest a drag may leave an image. Below this the handles overlap each
 *  other and there is nothing left to grab to undo the drag. */
const MIN_RESIZE_PX = 80;

/**
 * Notion-style drag-to-resize: a bar on the right edge and a grip at the
 * bottom-right corner (myne-md/myne#604).
 *
 * # Block only
 *
 * An inline embed gets none, and that is not a shortcut. Its box sits in a line
 * box that reflows around it as it grows, so the edge you grabbed moves under
 * the pointer mid-drag; and a press-and-drag inside a line is how a text
 * selection starts, so the two gestures would compete on the same pixels. The
 * block form has a stable right edge and nothing else claims a horizontal drag
 * there.
 *
 * # What it writes
 *
 * `w=<px>`, through `updateEmbedLayout`, which `embedLayoutActions.ts` names as
 * the only authoring path for the layout segments. The drag itself only moves
 * CSS; the document is touched ONCE, on release, so a drag is one undo step
 * rather than one per frame.
 *
 * # Why the listeners are on the window
 *
 * A pointer leaves the handle almost immediately once a drag starts. The
 * teardown is handed back to the widget rather than left to a `pointerup` that
 * may never arrive at this element: a keystroke elsewhere in the document
 * rebuilds this widget's DOM mid-drag, which is measured behaviour, and a
 * listener whose element is gone is a leak that keeps resizing a detached node.
 */
function appendResizeHandles(
  view: EditorView,
  frame: HTMLElement,
  img: HTMLImageElement,
  id: string,
  block: boolean,
): (() => void) | null {
  if (!block) return null;
  let disposeDrag: (() => void) | null = null;

  const startDrag = (event: PointerEvent, axis: "x" | "both"): void => {
    // Dispose any drag still live before starting another. A second
    // `pointerdown` on the other handle used to overwrite `disposeDrag`
    // outright, orphaning the first drag's window listeners: the widget's
    // `destroy()` disposes only the last one, and this function's own
    // docstring names that exact leak as the reason the teardown is handed
    // back at all.
    disposeDrag?.();
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const box = img.getBoundingClientRect();
    const startWidth = box.width;
    const startHeight = box.height;
    // The content column is the ceiling: a width past it would be clipped by the
    // editor rather than honoured, so the handle would keep moving while nothing
    // changed on screen.
    const maxWidth = Math.max(
      MIN_RESIZE_PX,
      Math.min(view.contentDOM.getBoundingClientRect().width, MAX_EMBED_DIMENSION_PX),
    );
    let width = startWidth;
    // Only the corner grip writes a height. The edge bar leaves it alone, so a
    // width-only drag keeps the image's own proportions, which is what an edge
    // handle means everywhere else. `null` here is "unchanged", not "cleared".
    let height: number | null = null;
    frame.classList.add("cm-attachment-resizing");
    // Written once rather than on every move: it does not change during a drag,
    // and a pointer sending coalesced events writes style faster than the
    // browser paints.
    //
    // BOTH caps come off, not just the image's. The image is a flex child of
    // `.cm-attachment-frame`, and the theme caps that frame at 320px, so
    // lifting only the image left the frame holding the real ceiling. On an
    // embed with no `w=` segment, which is every image at its default size and
    // precisely what this gesture is for, the drag then showed no growth at
    // all: the width climbed toward the content column while nothing on screen
    // moved, the handle detached from the pointer, and the size jumped only
    // once `pointerup` wrote the layout and the rebuilt widget took
    // `applyEmbedLayout`'s path. That path lifts the frame too, but only when a
    // width is already set, which by definition it is not here.
    const framePreDragMaxWidth = frame.style.maxWidth;
    frame.style.maxWidth = "100%";
    img.style.maxWidth = "100%";
    // Style writes are coalesced into one per frame. A fast pointer delivers
    // more `pointermove` events than there are frames, and each one used to be
    // its own layout write.
    let frameRequest = 0;
    const paint = (): void => {
      frameRequest = 0;
      img.style.width = `${width}px`;
      if (height !== null) img.style.height = `${height}px`;
    };

    const onMove = (e: PointerEvent): void => {
      width = Math.round(
        Math.min(maxWidth, Math.max(MIN_RESIZE_PX, startWidth + (e.clientX - startX))),
      );
      if (axis === "both") {
        height = Math.round(
          Math.min(
            MAX_EMBED_DIMENSION_PX,
            Math.max(MIN_RESIZE_PX, startHeight + (e.clientY - startY)),
          ),
        );
      }
      if (frameRequest === 0) frameRequest = requestAnimationFrame(paint);
    };

    const onUp = (): void => {
      cleanup();
      const movedWidth = Math.round(width) !== Math.round(startWidth);
      const movedHeight = height !== null && Math.round(height) !== Math.round(startHeight);
      if (!movedWidth && !movedHeight) return; // a click, not a drag
      updateEmbedLayout(view, frame, id, (current) => ({
        ...current,
        ...setWidthPx(width),
        // An explicit height is aspect distortion on purpose, which is what the
        // widget's own comment says `h=` means and what dragging a corner asks
        // for. The edge bar never reaches here, so a width-only drag leaves
        // whatever height the author had (usually none).
        ...(height !== null ? { heightPx: height } : {}),
      }));
    };

    const cleanup = (): void => {
      if (frameRequest !== 0) cancelAnimationFrame(frameRequest);
      frameRequest = 0;
      frame.classList.remove("cm-attachment-resizing");
      // Put the frame's own cap back. On the commit path the rebuilt widget
      // sets it again from the layout; on an ABANDONED drag (pointercancel, or
      // a release that moved nothing) nothing rebuilds, so without this the
      // embed would silently keep an uncapped frame for the rest of the
      // session.
      frame.style.maxWidth = framePreDragMaxWidth;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", cleanup);
      disposeDrag = null;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cleanup);
    disposeDrag = cleanup;
  };

  for (const spec of [
    { cls: "cm-attachment-resize-e", axis: "x" as const, testid: "attachment-image.resize-e" },
    { cls: "cm-attachment-resize-se", axis: "both" as const, testid: "attachment-image.resize-se" },
  ]) {
    const handle = document.createElement("span");
    handle.className = `cm-attachment-resize ${spec.cls}`;
    handle.setAttribute("data-testid", spec.testid);
    handle.setAttribute("aria-hidden", "true");
    handle.addEventListener("pointerdown", (e) => startDrag(e, spec.axis));
    frame.appendChild(handle);
  }

  return () => disposeDrag?.();
}
