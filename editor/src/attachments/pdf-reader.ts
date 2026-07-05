// Scrollable multi-page PDF reader (epic MYND-164).
//
// `mountPdfScroller(container, opts)` renders a decrypted PDF as pages stacked
// vertically inside a caller-owned (scrollable) container, and returns a cleanup
// function. It powers both the editor's inline bounded reader and the lightbox's
// bigger reader off the SAME render path.
//
// Discipline carried over from `renderPdfFirstPage`:
//   - bytes fetched ONCE via `fetchPdfBytes` (the `attachment://` → Uint8Array
//     path), reused across every page — never re-fetched per page,
//   - `getDocument` called ONCE; PDF scripting disabled (`isEvalSupported:
//     false`) — anti-scripting,
//   - the v6 cleanup is `task.destroy()` (frees doc + worker), NOT `doc.destroy`,
//   - REJECTS / cleans up gracefully so callers keep the generic-PDF-icon
//     fallback when pdf.js fails to load, parse, or render.
//
// DESIGN (robust + truly windowed):
//
//   1. The scroll container is NEVER hidden — it is laid out immediately. This
//      is the fix for the inline deadlock: a `display:none` container has no
//      layout, so an IntersectionObserver rooted at it never fires, so no page
//      ever renders, so the old "hidden until first paint" gate never lifts. We
//      keep the container visible and show a small "Loading…" chip INSIDE it,
//      removed once the document loads + the first page paints.
//
//   2. Placeholders are built cheaply: a single `getPage(1)` → `getViewport`
//      gives page 1's aspect ratio, and EVERY placeholder is min-height-sized
//      from that estimate, so the scrollbar reflects the whole document
//      immediately WITHOUT serially loading all N pages. A placeholder's exact
//      height is refined when its real page renders.
//
//   3. Page 1 (and page 2, if present) render EAGERLY so the reader shows real
//      content within ~1s — they do not wait for an intersection.
//
//   4. The rest render lazily via an IntersectionObserver rooted at the
//      container with a generous `rootMargin` so the visible pages + a few ahead
//      paint as you scroll. Each page renders at most once *while on screen*
//      (tracked in a `Set`).
//
//   5. TRUE WINDOWING (WKWebView canvas-memory budget). Each canvas's
//      backing-store resolution is CLAMPED (`MAX_CANVAS_DIM` / `MAX_CANVAS_AREA`)
//      so a tall page at the lightbox's large `pageWidth` can't allocate an
//      enormous back-buffer, and a page that scrolls far past the `rootMargin`
//      has its canvas DROPPED (reverts to the muted placeholder, back-buffer
//      freed). At any moment only the visible pages + the margin buffer hold
//      canvases, so total canvas memory stays bounded regardless of page count.
//      Without this, the lightbox reader (≈1800×2540 canvases × ~17 live)
//      overran WKWebView's total canvas-backing-store budget and pages rendered
//      as blank white stripes with NO console error. A dropped page re-renders
//      (slightly softer, never blank) when it re-intersects.

import i18n from "@myne/editor/i18n";
import {
  fetchPdfBytes,
  loadPdfJs,
  type PdfDocument,
  type PdfPage,
} from "./pdf-render";

/** Options for {@link mountPdfScroller}. */
export interface PdfScrollerOptions {
  /** The `attachment://<id>` (or any same-origin) URL of the PDF bytes. */
  readonly url: string;
  /** Target CSS width (px) each page renders at; pages scale to fit this. */
  readonly pageWidth: number;
  /** Optional AbortSignal — tears the reader down if the host unmounts. */
  readonly signal?: AbortSignal;
}

/** Class on each per-page placeholder/canvas wrapper (styled in styles.ts). */
const PAGE_CLASS = "cm-attachment-pdf-page";
/** Class on the small "Loading…" chip shown until the doc loads + page 1 paints. */
const LOADING_CLASS = "cm-attachment-pdf-loading";
/** Marker class on a placeholder whose real page has rendered (so the muted
 *  "pending page" treatment drops). */
const RENDERED_CLASS = "cm-attachment-pdf-page-rendered";
/** Fallback A4-ish ratio when page 1's dimensions can't be read. */
const DEFAULT_RATIO = 1.414;
/** Eagerly render this many leading pages at mount (don't wait for intersection). */
const EAGER_PAGES = 2;
/** Max backing-store dimension (px) for any single page canvas. Caps memory so
 *  WKWebView's total canvas-backing-store budget can't be overrun by tall pages
 *  at the lightbox's large `pageWidth` (which would silently blank the canvas).
 *  The CSS display width still tracks `pageWidth`; a clamped page just renders at
 *  a marginally lower internal resolution (softer, never blank). */
const MAX_CANVAS_DIM = 1600;
/** Max backing-store area (px²) for any single page canvas — a second guard for
 *  pages that are within `MAX_CANVAS_DIM` on each axis but still large. */
const MAX_CANVAS_AREA = 4_000_000;

/**
 * Rasterise a rendered page canvas to a PNG `Blob`, resolving `null` if the
 * platform's `toBlob` produces nothing (or throws). Wraps the callback-style
 * `canvas.toBlob` so the async `renderSlot` can `await` it cleanly.
 */
function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), "image/png");
    } catch {
      resolve(null);
    }
  });
}

/**
 * Mount a lazy, windowed, scrollable multi-page render of the PDF at `opts.url`
 * into `container`. Returns a synchronous, idempotent cleanup function that
 * destroys the pdf.js task, disconnects the observer, and clears the container.
 *
 * The container is shown immediately (never hidden) with a small "Loading…"
 * chip until the document loads and the first page paints. Per-page render
 * failures are isolated (the page keeps its placeholder); a document
 * load/fetch failure calls `onError` once so the caller drops in the icon
 * fallback. Cleanup is safe to call before the first page resolves.
 */
export function mountPdfScroller(
  container: HTMLElement,
  opts: PdfScrollerOptions & { onError?: (err: unknown) => void },
): () => void {
  let task: { destroy(): Promise<void> } | null = null;
  let observer: IntersectionObserver | null = null;
  let disposed = false;

  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    observer = null;
    if (task !== null) {
      // v6: destroy the loading task (frees document + worker port), NOT the doc
      // proxy — `doc.destroy` is undefined in v6.
      void task.destroy();
      task = null;
    }
    container.replaceChildren();
  };

  if (opts.signal?.aborted) {
    cleanup();
    return cleanup;
  }
  opts.signal?.addEventListener("abort", cleanup, { once: true });

  // Show the "Loading…" chip immediately — the container stays laid out.
  const loading = document.createElement("div");
  loading.className = LOADING_CLASS;
  loading.textContent = i18n.t("editor.attachment.pdf.loading");
  container.replaceChildren(loading);

  void (async () => {
    try {
      // Independent work — fetch bytes and load the pdf.js module/worker
      // concurrently so first-PDF latency is max(...), not the sum.
      const [bytes, pdfjs] = await Promise.all([
        fetchPdfBytes(opts.url, opts.signal),
        loadPdfJs(),
      ]);
      if (disposed) return;

      const t = pdfjs.getDocument({
        data: bytes,
        isEvalSupported: false, // anti-scripting: no PDF JS evaluation
        disableAutoFetch: true,
      });
      task = t;
      const doc = await t.promise;
      if (disposed) {
        cleanup();
        return;
      }
      await layoutPages(
        container,
        doc,
        opts.pageWidth,
        loading,
        () => disposed,
        (obs) => {
          observer = obs;
        },
      );
    } catch (err) {
      if (disposed) return;
      // DENY-list-safe: pdf.js / fetch errors are API/parse/worker/status
      // messages — no decrypted bytes, no ids, no paths.
      const detail =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.warn(
        "[attachments] pdf scroller render failed → icon fallback —",
        detail,
      );
      cleanup();
      opts.onError?.(err);
    }
  })();

  return cleanup;
}

/**
 * Build the per-page placeholders (sized from page 1's aspect ratio), eagerly
 * render the first page(s), and wire an IntersectionObserver against `container`
 * that renders each remaining page's canvas the first time it nears the
 * viewport. Removes the `loading` chip once page 1 has painted. Pure DOM; no
 * return value.
 */
async function layoutPages(
  container: HTMLElement,
  doc: PdfDocument,
  pageWidth: number,
  loading: HTMLElement,
  isDisposed: () => boolean,
  setObserver: (obs: IntersectionObserver) => void,
): Promise<void> {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

  // One cheap getPage(1) → getViewport for the document-wide aspect-ratio
  // estimate. Every placeholder gets a min-height from this so the scrollbar
  // reflects the full document immediately, without serially loading all pages.
  let ratio = DEFAULT_RATIO; // height / width
  try {
    const first = await doc.getPage(1);
    if (isDisposed()) return;
    const base = first.getViewport({ scale: 1 });
    if (base.width > 0) ratio = base.height / base.width;
  } catch {
    // Keep the A4-ish default; placeholders are still usable.
  }
  if (isDisposed()) return;

  const estHeight = Math.max(1, Math.round(pageWidth * ratio));

  // Track which page numbers have rendered so a page paints at most once.
  const rendered = new Set<number>();
  const slots = new Map<HTMLElement, number>();

  let firstPainted = false;
  const dropLoading = (): void => {
    if (firstPainted) return;
    firstPainted = true;
    loading.remove();
  };

  const renderSlot = async (slot: HTMLElement, n: number): Promise<void> => {
    if (rendered.has(n) || isDisposed()) return;
    rendered.add(n);
    try {
      const page: PdfPage = await doc.getPage(n);
      if (isDisposed()) return;
      const base = page.getViewport({ scale: 1 });
      // Desired scale: width comes from `pageWidth` (the container's content
      // width) × dpr — never a measured 0-width before layout, so the back-buffer
      // is non-zero. Then CLAMP so neither backing-store axis exceeds
      // MAX_CANVAS_DIM and the total area stays under MAX_CANVAS_AREA — bounding
      // per-canvas memory so WKWebView's canvas budget can't be overrun (which
      // silently blanks the canvas). The CSS display size is unaffected.
      const renderScale = Math.min(
        (pageWidth / base.width) * dpr,
        MAX_CANVAS_DIM / base.width,
        MAX_CANVAS_DIM / base.height,
        Math.sqrt(MAX_CANVAS_AREA / (base.width * base.height)),
      );
      const viewport = page.getViewport({ scale: renderScale });
      const canvas = document.createElement("canvas");
      canvas.className = "cm-attachment-pdf-page-canvas";
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      // CSS height tracks the *display* aspect ratio (pageWidth), independent of
      // the clamped backing-store resolution — a clamped page is just softer.
      const cssHeight = Math.max(1, Math.round(pageWidth * (base.height / base.width)));
      canvas.style.width = `${pageWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("no 2d context");
      await page.render({ canvasContext: ctx, viewport }).promise;
      if (isDisposed()) return;

      // WKWebView canvas-compositing fix (MYND-164): a live <canvas> with a
      // correct CPU backing store can still composite to a SOLID WHITE rect once
      // the lightbox stacks many large canvases (a known WebKit bug — the pixels
      // are there in `getImageData`, but the screen shows blank). <img> elements
      // composite normally, so we rasterise the rendered canvas to a PNG blob,
      // display THAT, and free the canvas back-buffer immediately.
      const blob = await canvasToPngBlob(canvas);
      if (isDisposed()) return;

      // Refine the placeholder's exact height + drop the muted "pending"
      // treatment, then place the rasterised image (or fall back to the live
      // canvas if toBlob yielded nothing).
      slot.style.minHeight = "";
      slot.style.height = `${cssHeight}px`;
      slot.classList.add(RENDERED_CLASS);
      if (blob !== null) {
        const img = document.createElement("img");
        // SAME class the canvas had, so existing CSS (sizing/borders) applies.
        img.className = "cm-attachment-pdf-page-canvas";
        img.style.width = `${pageWidth}px`;
        img.style.height = `${cssHeight}px`;
        const objUrl = URL.createObjectURL(blob);
        // Revoke-on-load is safe: once decoded, the <img> retains the bitmap
        // independently of the object URL.
        img.addEventListener("load", () => URL.revokeObjectURL(objUrl), {
          once: true,
        });
        img.src = objUrl;
        slot.replaceChildren(img);
        // Free the canvas backing store now that the raster is captured.
        canvas.width = 0;
        canvas.height = 0;
      } else {
        // toBlob produced nothing — a live canvas is better than a blank slot.
        slot.replaceChildren(canvas);
      }
      if (n === 1) dropLoading();
    } catch (err) {
      // A single page failing must not nuke the whole reader — leave the
      // placeholder in place (it keeps its muted "pending" treatment).
      if (!isDisposed()) {
        const detail =
          err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        console.warn("[attachments] pdf page render failed", detail);
      }
      // Allow a retry on a later intersection.
      rendered.delete(n);
      // Even if page 1 failed, lift the loading chip so the reader isn't stuck.
      if (n === 1) dropLoading();
    }
  };

  // Recycle an off-screen page: revert to the muted "pending" placeholder and
  // drop it from the rendered Set so a later re-intersection re-renders it. The
  // slot normally holds an <img> (removing it from the DOM frees its decoded
  // bitmap; its object URL was already revoked on load — no bookkeeping needed).
  // In the toBlob-fell-back case the slot holds a live <canvas>, which we zero
  // to free its backing store. This is what keeps total raster memory bounded
  // (WKWebView budget) regardless of page count.
  const dropSlot = (slot: HTMLElement, n: number): void => {
    if (!rendered.has(n)) return;
    const fallbackCanvas = slot.querySelector<HTMLCanvasElement>(
      "canvas.cm-attachment-pdf-page-canvas",
    );
    if (fallbackCanvas !== null) {
      // Zeroing the dimensions frees the backing store synchronously.
      fallbackCanvas.width = 0;
      fallbackCanvas.height = 0;
    }
    rendered.delete(n);
    slot.classList.remove(RENDERED_CLASS);
    slot.replaceChildren();
    // Restore the up-front min-height estimate so the scroll position is stable.
    slot.style.height = "";
    slot.style.minHeight = `${estHeight}px`;
  };

  // IntersectionObserver may be absent (jsdom). When present we observe each
  // slot beyond the eager set; when absent (test env) we render every page
  // eagerly so the reader still works.
  const hasIO = typeof IntersectionObserver !== "undefined";
  const observer = hasIO
    ? new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const slot = e.target as HTMLElement;
            const n = slots.get(slot);
            if (n === undefined) continue;
            if (e.isIntersecting) {
              void renderSlot(slot, n);
            } else {
              // Scrolled beyond the rootMargin buffer → drop its canvas so the
              // live-canvas count (and total backing-store memory) stays bounded.
              // The eager leading pages are kept resident for fast scroll-to-top.
              if (n > EAGER_PAGES) dropSlot(slot, n);
            }
          }
        },
        // Generous margin: the visible pages + a few ahead render as you scroll.
        { root: container, rootMargin: "600px 0px" },
      )
    : null;
  if (observer !== null) setObserver(observer);

  // Build every placeholder up front (cheap — no per-page getPage), sized from
  // page 1's ratio so the scrollbar reflects the full document immediately.
  container.replaceChildren(loading);
  for (let n = 1; n <= doc.numPages; n += 1) {
    if (isDisposed()) return;
    const slot = document.createElement("div");
    slot.className = PAGE_CLASS;
    slot.style.width = `${pageWidth}px`;
    // A min-height (not a fixed height) from the estimate: an unrendered page
    // reads as a muted "pending" outline, and refines to its exact height when
    // it paints.
    slot.style.minHeight = `${estHeight}px`;
    slots.set(slot, n);
    container.appendChild(slot);
  }

  // Eagerly render the leading page(s) so content shows within ~1s — never wait
  // for an intersection for page 1.
  const slotList = Array.from(slots.entries());
  for (const [slot, n] of slotList) {
    if (n <= EAGER_PAGES) void renderSlot(slot, n);
  }

  // Window the rest lazily. Without IO (jsdom), render everything eagerly.
  for (const [slot, n] of slotList) {
    if (n <= EAGER_PAGES) continue;
    if (observer !== null) observer.observe(slot);
    else void renderSlot(slot, n);
  }
}
