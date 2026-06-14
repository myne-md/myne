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

import { type EditorView, WidgetType } from "@codemirror/view";
import { attachmentUrl } from "../../notes/attachmentRef";
import { makeAttachmentIcon } from "./icons";
import type { CatalogRow } from "./catalog";
import { mountPdfScroller } from "./pdf-reader";
import { makeProgressChip } from "./progress";
import { showAttachmentLightbox } from "./lightbox";
import { ensureAttachmentInsertStyles } from "./styles";
import { fileTypeLabel } from "./fileKind";
import { formatBytes } from "../../components/attachments/format";
import {
  exportAttachment,
  removeFileCard,
  renameFileCard,
  revealFileCard,
} from "./fileCardActions";

/** Width (CSS px) the inline image / PDF frame renders at. */
const FRAME_WIDTH = 320;

/** Tombstone flavor: a deleted attachment (id was once in the catalog) vs a
 *  broken reference (malformed `att:` target — never a valid id). */
export type TombstoneKind = "deleted" | "broken";

// --- resolved raster / SVG -------------------------------------------------

export class AttachmentImageWidget extends WidgetType {
  constructor(
    private readonly id: string,
    private readonly filename: string,
  ) {
    super();
  }

  eq(other: AttachmentImageWidget): boolean {
    return other.id === this.id && other.filename === this.filename;
  }

  toDOM(): HTMLElement {
    const frame = document.createElement("span");
    frame.className = "cm-attachment-frame";
    frame.setAttribute("role", "img");
    frame.setAttribute("aria-label", this.filename);

    const url = attachmentUrl(this.id);

    // Clean progress chip ("Loading…") until the first decrypt+decode paints —
    // NOT the struck/tombstone style. Removed once the <img> fires `load`.
    const loading = makeProgressChip("loading");
    frame.appendChild(loading);

    const img = document.createElement("img");
    img.className = "cm-attachment-img";
    // attachment://<id> — the Rust handler decrypts in-memory + re-sniffs +
    // allowlists. SVG is served as image/svg+xml and rendered here ONLY through
    // the `<img>` element (secure static mode); its markup never enters the DOM.
    img.src = url;
    img.alt = this.filename;
    img.style.maxWidth = `${FRAME_WIDTH}px`;
    // Hidden until decoded so the progress chip is the only thing visible while
    // the bytes decrypt; swap on load (or drop the chip on error so a genuine
    // broken-image affordance still surfaces).
    img.style.display = "none";
    img.addEventListener("load", () => {
      img.style.display = "";
      loading.remove();
    });
    img.addEventListener("error", () => {
      loading.remove();
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

    return frame;
  }

  // Let the click reach the <img> handler (lightbox) rather than being
  // swallowed as a CM event; the widget stays atomic (no source-lift) because
  // it never mutates the document or selection.
  ignoreEvent(): boolean {
    return false;
  }
}

// --- resolved PDF (pdf.js first page, icon fallback) -----------------------

export class AttachmentPdfWidget extends WidgetType {
  constructor(
    private readonly id: string,
    private readonly filename: string,
  ) {
    super();
  }

  eq(other: AttachmentPdfWidget): boolean {
    return other.id === this.id && other.filename === this.filename;
  }

  toDOM(): HTMLElement {
    const frame = document.createElement("span");
    frame.className = "cm-attachment-frame cm-attachment-pdf";
    frame.setAttribute("role", "img");
    frame.setAttribute("aria-label", this.filename);

    // The bounded, scrollable reader: the visible scroll container the pages
    // stack in + the IntersectionObserver roots against. It is NEVER hidden —
    // a `display:none` container has no layout, so the observer rooted at it
    // would never fire (the old hidden-until-first-paint deadlock). The reader
    // shows its own small "Loading…" chip inside until the first page paints.
    const scroller = document.createElement("div");
    scroller.className = "cm-attachment-pdf-scroller";
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

    this.cleanup = mountPdfScroller(scroller, {
      url: attachmentUrl(this.id),
      pageWidth: FRAME_WIDTH,
      onError: () => {
        // MANDATORY generic-PDF-icon fallback (SYNC-5): pdf.js absent / failed.
        // Already warned (DENY-list-safe) inside the scroller, which has cleared
        // the scroll container. Swap the whole reader for the generic PDF icon.
        const fallback = document.createElement("span");
        fallback.className = "cm-attachment-pdf-fallback";
        fallback.appendChild(makeAttachmentIcon("file"));
        const label = document.createElement("span");
        label.className = "cm-attachment-pdf-fallback-label";
        label.textContent = "PDF";
        fallback.appendChild(label);
        scroller.replaceChildren(fallback);
        scroller.style.cursor = "default";
      },
    });

    return frame;
  }

  // Tear the reader down (pdf.js task.destroy + observer disconnect) if CM
  // discards this widget's DOM.
  private cleanup: (() => void) | null = null;
  destroy(): void {
    this.cleanup?.();
    this.cleanup = null;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// --- tombstone (deleted / broken) ------------------------------------------

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
    const chip = document.createElement("span");
    chip.className =
      this.kind === "deleted"
        ? "cm-attachment-tombstone cm-attachment-tombstone-deleted"
        : "cm-attachment-tombstone cm-attachment-tombstone-broken";
    chip.setAttribute("role", "img");
    chip.setAttribute(
      "aria-label",
      this.kind === "deleted"
        ? `Deleted attachment: ${this.filename}`
        : `Broken attachment reference: ${this.filename}`,
    );

    chip.appendChild(
      makeAttachmentIcon(this.kind === "deleted" ? "image-off" : "file-warning"),
    );

    const label = document.createElement("span");
    label.className = "cm-attachment-tombstone-label";
    label.textContent = this.filename || (this.kind === "deleted" ? "deleted" : "broken");
    chip.appendChild(label);

    return chip;
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
    label.textContent = this.alt !== "" ? this.alt : "image";
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
  /** Set while the overflow menu is open, so `destroy()` can tear it down (and
   *  remove its document listener) if CM6 discards the widget while it's open. */
  private closeActiveMenu: (() => void) | null = null;

  constructor(
    private readonly id: string,
    private readonly filename: string,
    private readonly size: number,
    private readonly label: string = fileTypeLabel(filename),
  ) {
    super();
  }

  eq(other: AttachmentFileCardWidget): boolean {
    return (
      other.id === this.id &&
      other.filename === this.filename &&
      other.size === this.size
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
    // textContent (never innerHTML) per TB2.
    meta.textContent = `${this.label} · ${formatBytes(this.size)}`;
    text.appendChild(meta);

    card.appendChild(text);

    card.appendChild(this.buildMenu(view, card));
    return card;
  }

  /** The "⋯" overflow button + its toggle-on-click action menu. */
  private buildMenu(view: EditorView, card: HTMLElement): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-attachment-file-card-menuwrap";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-attachment-file-card-menubtn";
    button.setAttribute("data-testid", "attachment-card.menu-button");
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", "Attachment actions");
    button.textContent = "⋯";
    wrap.appendChild(button);

    let menu: HTMLElement | null = null;
    const onDocPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menu !== null && !menu.contains(t) && !wrap.contains(t)) closeMenu();
    };
    // The body-mounted menu does not track the editor on scroll; close it on
    // scroll / resize (the library AttachmentActionMenu discipline).
    const onReflow = () => closeMenu();
    const closeMenu = () => {
      menu?.remove();
      menu = null;
      button.setAttribute("aria-expanded", "false");
      document.removeEventListener("mousedown", onDocPointerDown, true);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
      this.closeActiveMenu = null;
    };
    const openMenu = () => {
      ensureAttachmentInsertStyles(); // body-mounted → global styles, not the theme
      menu = document.createElement("div");
      menu.className = "cm-attachment-file-card-menu";
      menu.setAttribute("role", "menu");
      menu.setAttribute("data-testid", "attachment-card.menu");

      const items: ReadonlyArray<readonly [string, string, () => void]> = [
        ["Export", "attachment-card.export", () => void exportAttachment(this.id, this.filename)],
        ["Rename", "attachment-card.rename", () => void renameFileCard(view, this.id, this.filename)],
        ["Remove", "attachment-card.remove", () => removeFileCard(view, card, this.id)],
        ["Reveal in library", "attachment-card.reveal", () => revealFileCard(view, this.id)],
      ];
      for (const [label, testid, run] of items) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "cm-attachment-file-card-menuitem";
        item.setAttribute("role", "menuitem");
        item.setAttribute("data-testid", testid);
        item.textContent = label;
        item.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          closeMenu();
          run();
        });
        menu.appendChild(item);
      }

      // Body-mounted (portaled) so the editor's `.cm-scroller` overflow can't
      // clip it. `position: fixed` is set BEFORE measuring so the menu shrinks
      // to its content width — a block-flow `<div>` would otherwise measure as
      // the full body width and throw the right-alignment math off-screen.
      // Then: viewport-clamped FIXED coordinates — right-aligned to the button,
      // flipped above when there's no room below, clamped horizontally.
      document.body.appendChild(menu);
      menu.style.position = "fixed";
      menu.style.zIndex = "1200";
      const btn = button.getBoundingClientRect();
      const m = menu.getBoundingClientRect();
      const margin = 8;
      const left = Math.max(
        margin,
        Math.min(btn.right - m.width, window.innerWidth - m.width - margin),
      );
      const top =
        btn.bottom + m.height + margin > window.innerHeight
          ? Math.max(margin, btn.top - m.height - 4)
          : btn.bottom + 4;
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;

      button.setAttribute("aria-expanded", "true");
      // The dismiss listener is on `mousedown` while the toggle is on `click`,
      // so the opening interaction's mousedown has already passed — no deferral
      // needed. Tracked on the instance so `destroy()` can remove it.
      document.addEventListener("mousedown", onDocPointerDown, true);
      window.addEventListener("scroll", onReflow, true);
      window.addEventListener("resize", onReflow);
      this.closeActiveMenu = closeMenu;
    };

    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (menu !== null) closeMenu();
      else openMenu();
    });

    return wrap;
  }

  // If CM6 discards the widget while its menu is open, tear the menu down so its
  // document `mousedown` listener cannot outlive the DOM.
  destroy(): void {
    this.closeActiveMenu?.();
  }

  // Let clicks reach the menu button / items rather than being swallowed as a
  // CM event; the widget stays atomic (it never mutates doc/selection itself —
  // the actions do, through their own dispatches).
  ignoreEvent(): boolean {
    return false;
  }
}

/** Build the appropriate resolved-attachment widget for a content-type. SVG +
 *  raster share the `<img>` path; PDF takes the pdf.js path. A generic
 *  (non-renderable) attachment — `application/octet-stream`, MYND-173 — takes
 *  the export-only file-card path. */
export function makeResolvedWidget(row: CatalogRow): WidgetType {
  if (row.contentType === "application/pdf") {
    return new AttachmentPdfWidget(row.id, row.filename);
  }
  if (isRenderableImageType(row.contentType)) {
    return new AttachmentImageWidget(row.id, row.filename);
  }
  // Generic / non-renderable → export-only file-card.
  return new AttachmentFileCardWidget(row.id, row.filename, row.size);
}

/** The raster/SVG content-types the `attachment://` handler serves inline. */
function isRenderableImageType(contentType: string): boolean {
  return contentType.startsWith("image/");
}
