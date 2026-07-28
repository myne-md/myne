// Click-to-preview lightbox for inline attachment images (epic MYND-164,
// editor-side dogfooding polish).
//
// Clicking an inline rendered image opens a centered, size-capped preview shown
// directly on a dimmed backdrop (no white frame). Same vanilla-DOM posture as
// `diff-preview.ts` / `toast.ts`: a surface appended to `document.body`
// (escaping CM6's `.cm-editor`-scoped theme), dismissed by Esc, a backdrop
// click, or the top-right × button. The image source is the same `attachmentUrl(id)` the inline
// chip uses — the Rust `attachment://` handler decrypts in-memory + allowlists,
// so no plaintext ever touches disk and no extra trust surface is opened.
//
// `showAttachmentLightbox({ url, alt, kind })` is the single entry point. With
// `kind:"pdf"` it mounts the scrollable multi-page reader (`pdf-reader.ts`) at a
// bigger size instead of an `<img>`; `kind` defaults to "image" so existing
// callers are unchanged. Only one lightbox is ever open; opening a second
// replaces the first (and tears down any open PDF reader first).

import i18n from "@myne/editor/i18n";
import { openModal } from "@myne/editor/host/lib/imperative-modal";
import { ensureAttachmentInsertStyles, hasDom } from "./styles";
import { mountPdfScroller } from "./pdf-reader";
import { canExportAttachment } from "@myne/editor/host/lib/attachments";
import { exportAttachment } from "./fileCardActions";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Width (CSS px) each PDF page renders at inside the lightbox reader. Matches
 *  the surface cap (`min(80vw, 1100px)`) modulo a little gutter. */
const LIGHTBOX_PDF_PAGE_WIDTH = 900;

/**
 * Build a Lucide-style `x` glyph via DOM (never `innerHTML`, never emoji — TB2).
 * 1.5px stroke, 24×24 viewBox, `stroke: currentColor` so it inherits the close
 * button's token color.
 */
function makeCloseIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const a = document.createElementNS(SVG_NS, "path");
  a.setAttribute("d", "M18 6 6 18");
  const b = document.createElementNS(SVG_NS, "path");
  b.setAttribute("d", "m6 6 12 12");
  svg.append(a, b);
  return svg;
}

/** What to show: the decrypted-bytes URL + an accessible label. */
export interface LightboxOptions {
  /** The `attachment://<id>` URL of the full-size image / PDF bytes. */
  readonly url: string;
  /** Accessible label / alt for the previewed attachment. */
  readonly alt: string;
  /** Content kind. "image" (default — existing callers) shows an `<img>`;
   *  "pdf" mounts the scrollable multi-page reader. */
  readonly kind?: "image" | "pdf";
  /** The attachment-id. When present, an Export (Save As) button appears in the
   *  lightbox chrome (the vault-wide export affordance, MYND-173). */
  readonly id?: string;
}

// The shared-skeleton teardown (release trap + remove keydown + remove backdrop)
// for the currently-open lightbox. Null when nothing is open.
let activeClose: (() => void) | null = null;
// Cleanup for an open PDF reader (task.destroy + observer disconnect). Null for
// image mode / when nothing is open.
let activePdfCleanup: (() => void) | null = null;

/** Tear down any open lightbox (Esc / backdrop click / replace / test cleanup). */
export function dismissAttachmentLightbox(): void {
  if (activePdfCleanup !== null) {
    // Destroy the pdf.js task + disconnect the observer BEFORE the surface goes
    // (activeClose removes the backdrop).
    activePdfCleanup();
    activePdfCleanup = null;
  }
  activeClose?.();
  activeClose = null;
}

/**
 * Open a centered, dimmed-backdrop preview of the image at `url`. Replaces any
 * currently-open lightbox. No-op without a DOM (node test env). Returns nothing
 * — dismissal is by Esc or a backdrop click.
 */
export function showAttachmentLightbox(opts: LightboxOptions): void {
  if (!hasDom()) return;
  ensureAttachmentInsertStyles();
  dismissAttachmentLightbox();

  const kind = opts.kind ?? "image";
  // Shared modal skeleton: fixed backdrop + Esc / backdrop-click dismissal + focus
  // trap + idempotent teardown. The lightbox traps on the backdrop itself (no
  // inner dialog card) and has no Enter-commit, so `onEnter` is omitted.
  const host = openModal({
    backdropClass:
      kind === "pdf"
        ? "cm-attach-lightbox-backdrop cm-attach-lightbox-backdrop-pdf"
        : "cm-attach-lightbox-backdrop",
    onDismiss: () => dismissAttachmentLightbox(),
  });
  const backdrop = host.backdrop;
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute(
    "aria-label",
    opts.alt ||
      (kind === "pdf"
        ? i18n.t("editor.attachment.lightbox.pdfPreview")
        : i18n.t("editor.attachment.lightbox.imagePreview")),
  );

  // The PDF reader is mounted AFTER the backdrop is attached to the document
  // (below). The IntersectionObserver roots against this surface and needs it in
  // the live layout tree; mounting while detached can leave pages unrendered.
  let pdfSurface: HTMLDivElement | null = null;
  if (kind === "pdf") {
    // Bigger scrollable multi-page reader. The surface is the scroll container
    // the IntersectionObserver roots against; pages stack vertically inside it.
    const surface = document.createElement("div");
    surface.className = "cm-attach-lightbox-pdf";
    backdrop.appendChild(surface);
    pdfSurface = surface;
  } else {
    const img = document.createElement("img");
    img.className = "cm-attach-lightbox-img";
    // Same decrypted-bytes source as the inline chip; never a remote fetch.
    img.src = opts.url;
    img.alt = opts.alt;
    backdrop.appendChild(img);
  }

  // Vault-wide Export (Save As) affordance (MYND-173): present whenever the
  // caller supplies the attachment-id AND the platform can pick a destination.
  // Pinned next to the close button. Clicking opens the native save dialog
  // (host-side decrypt + write); the lightbox stays open behind it.
  //
  // The second condition is phase3-web-client task 26: a browser grants a page
  // no arbitrary write path, so the button is **omitted** there rather than
  // rendered and failing on click (`decisions.md` 2026-07-26, absent-not-
  // disabled). Task 48's download flow is a different affordance, not this one.
  if (opts.id !== undefined && canExportAttachment()) {
    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "cm-attach-lightbox-export";
    exportBtn.setAttribute("data-testid", "attachment-lightbox.export");
    exportBtn.setAttribute("aria-label", i18n.t("editor.attachment.lightbox.exportAria"));
    exportBtn.title = i18n.t("editor.attachment.lightbox.export");
    exportBtn.textContent = i18n.t("editor.attachment.lightbox.export");
    const exportId = opts.id;
    exportBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void exportAttachment(exportId, opts.alt);
    });
    backdrop.appendChild(exportBtn);
  }

  // Explicit close affordance, in addition to Esc / backdrop-click. Pinned to
  // the top-right of the viewport, readable on the dark backdrop.
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "cm-attach-lightbox-close";
  closeBtn.setAttribute("aria-label", i18n.t("editor.attachment.lightbox.close"));
  closeBtn.title = i18n.t("editor.attachment.lightbox.close");
  closeBtn.appendChild(makeCloseIcon());
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dismissAttachmentLightbox();
  });
  backdrop.appendChild(closeBtn);

  // `openModal` already appended the backdrop; record its teardown so
  // `dismissAttachmentLightbox` (external callers, replace-on-open) can close it.
  activeClose = host.close;

  // Surface is now in the live DOM — mount the scrollable reader so its
  // IntersectionObserver has a connected, laid-out root.
  if (pdfSurface !== null) {
    const surface = pdfSurface;
    // Fit each page to the ACTUAL reader surface instead of a fixed 900px — on a
    // phone the surface is only ~300–360px wide, so 900 overflowed/clipped
    // horizontally (MYND-477). The surface is already in the live layout; read
    // its content box (clientWidth includes padding, so subtract it). Desktop
    // surfaces stay wide, so this still resolves to the 900 cap there.
    const padX = parseFloat(getComputedStyle(surface).paddingLeft) || 0;
    const avail = surface.clientWidth - padX * 2;
    const pageWidth = avail > 0 ? Math.max(240, Math.min(LIGHTBOX_PDF_PAGE_WIDTH, Math.floor(avail))) : LIGHTBOX_PDF_PAGE_WIDTH;
    activePdfCleanup = mountPdfScroller(surface, {
      url: opts.url,
      pageWidth,
      onError: () => {
        // Reader failed to load/parse → swap in the generic-PDF-icon fallback so
        // the lightbox isn't an empty box. DENY-list-safe; already warned.
        const fb = document.createElement("div");
        fb.className = "cm-attach-lightbox-pdf-fallback";
        fb.textContent = i18n.t("editor.attachment.lightbox.pdfFallback");
        surface.replaceChildren(fb);
      },
    });
  }

  // Trap + restore focus (MYND-93). Esc + backdrop-click dismissal are already
  // wired by `openModal` (→ `onDismiss` → `dismissAttachmentLightbox`).
  host.installTrap(backdrop, closeBtn);
}
