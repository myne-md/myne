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

import { WidgetType } from "@codemirror/view";
import { attachmentUrl } from "../../notes/attachmentRef";
import { makeAttachmentIcon } from "./icons";
import type { CatalogRow } from "./catalog";
import { mountPdfScroller } from "./pdf-reader";
import { makeProgressChip } from "./progress";
import { showAttachmentLightbox } from "./lightbox";

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
      showAttachmentLightbox({ url, alt: this.filename });
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

/** Build the appropriate resolved-attachment widget for a content-type. SVG +
 *  raster share the `<img>` path; PDF takes the pdf.js path. Anything else
 *  (defensive — the handler allowlist should preclude it) falls back to the
 *  `<img>` path, which the handler's allowlist still gates. */
export function makeResolvedWidget(row: CatalogRow): WidgetType {
  if (row.contentType === "application/pdf") {
    return new AttachmentPdfWidget(row.id, row.filename);
  }
  return new AttachmentImageWidget(row.id, row.filename);
}
