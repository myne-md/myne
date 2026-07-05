// PDF first-page → canvas renderer via pdf.js (epic MYND-164, SYNC-5).
//
// Renders the FIRST page of a decrypted PDF (served by the `attachment://`
// scheme) into a `<canvas>`, fully in-memory: PDF JavaScript is disabled
// (`isEvalSupported: false` + the build never enables scripting), no copy ever
// touches disk. The bytes are fetched through `attachment://<id>`, which the
// Rust handler decrypts + re-sniffs + allowlists (never `text/html`).
//
// MANDATORY icon fallback (SYNC-5): if pdf.js fails to load, fails to parse, or
// throws for any reason, the caller renders a generic PDF icon instead — this
// module signals that by REJECTING `renderPdfFirstPage`, never throwing
// uncaught. pdf.js (`pdfjs-dist`) is loaded via dynamic `import()` so it lands
// in its own lazy chunk and never bloats the main editor bundle.
//
// Reusable on purpose: the attachments library will call `renderPdfFirstPage`
// for its thumbnail grid (the PRD's "render path must be reusable" note).

/** Options for {@link renderPdfFirstPage}. */
export interface PdfRenderOptions {
  /** The `attachment://<id>` (or any same-origin) URL of the PDF bytes. */
  readonly url: string;
  /** Target CSS width in px; the canvas back-buffer scales by devicePixelRatio. */
  readonly width: number;
  /** Optional AbortSignal — reject early if the host widget unmounts. */
  readonly signal?: AbortSignal;
}

/** The pdf.js module shape we rely on, narrowed so we don't depend on the full
 *  generated typings (which require the DOM lib + a worker entry resolved).
 *
 *  We pass the PDF as in-memory `data` (a `Uint8Array`), NOT a `url`. pdf.js's
 *  url path routes through `isValidFetchUrl`, which only accepts `http(s):` —
 *  the `attachment://` custom scheme falls through to an `XMLHttpRequest` that
 *  the WebView CSP `connect-src` would have to allow. Fetching the bytes here
 *  ourselves (the same `attachment://` source the inline `<img>` uses) keeps
 *  the data-acquisition explicit + CSP-predictable and sidesteps pdf.js's
 *  http-only stream selection entirely. */
export interface PdfJsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(args: {
    data: Uint8Array;
    isEvalSupported: boolean;
    disableAutoFetch?: boolean;
    // The loading TASK (not the document proxy) owns `destroy()` in pdf.js v6 —
    // `PDFDocumentProxy.destroy()` was removed. Destroying the task frees the
    // document + worker port.
  }): { promise: Promise<PdfDocument>; destroy(): Promise<void> };
}
export interface PdfDocument {
  readonly numPages: number;
  getPage(n: number): Promise<PdfPage>;
}
export interface PdfPage {
  getViewport(args: { scale: number }): { width: number; height: number };
  render(args: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }): { promise: Promise<void> };
}

// Memoize the pdf.js module load (+ worker wiring) so the worker is configured
// exactly once across every chip in the document.
let pdfModulePromise: Promise<PdfJsModule> | null = null;

/** Load (once, memoized) the pdf.js module with its worker wired. Exported so
 *  the multi-page scroller (`pdf-reader.ts`) shares the exact same worker setup
 *  + lazy chunk as the thumbnail path. REJECTS on a load failure (caller falls
 *  back to the icon). */
export async function loadPdfJs(): Promise<PdfJsModule> {
  if (pdfModulePromise === null) {
    pdfModulePromise = (async () => {
      const mod = (await import("pdfjs-dist")) as unknown as PdfJsModule;
      // Wire the worker via a Vite `?url` import so it ships as a hashed asset
      // and runs off the main thread. The worker is sandboxed parsing only;
      // PDF scripting stays disabled at the document level.
      const workerUrl = (
        await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
      ).default;
      mod.GlobalWorkerOptions.workerSrc = workerUrl;
      return mod;
    })().catch((e) => {
      // Reset so a transient load failure can retry on the next attachment.
      pdfModulePromise = null;
      // DENY-list-safe: no bytes / ids / paths — just that the lib chunk failed.
      console.warn("[attachments] pdf.js module/worker failed to load");
      throw e;
    });
  }
  return pdfModulePromise;
}

/**
 * Render the first page of the PDF at `url` into a freshly-created `<canvas>`.
 * Resolves with the canvas (already sized + drawn); REJECTS on any failure so
 * the caller can fall back to the generic PDF icon. Never throws synchronously.
 */
/**
 * Fetch the decrypted PDF bytes from the `attachment://` source (gated by CSP
 * `connect-src`, which must allow `attachment:`) and return them as a
 * `Uint8Array` ready to feed pdf.js's `data` path — never its http-only
 * `isValidFetchUrl`/`url` path (see the {@link PdfJsModule} docstring). Exported
 * so the multi-page scroller fetches the bytes ONCE and reuses them across every
 * page. REJECTS (with a DENY-list-safe warn) on any failure.
 */
export async function fetchPdfBytes(
  url: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (signal?.aborted) throw new Error("aborted");
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`status ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    // DENY-list-safe: the id lives in `url` (not logged); only the coarse stage.
    console.warn("[attachments] pdf bytes fetch failed (attachment:// → fetch)");
    throw e;
  }
}

export async function renderPdfFirstPage(
  opts: PdfRenderOptions,
): Promise<HTMLCanvasElement> {
  const { url, width, signal } = opts;
  if (signal?.aborted) throw new Error("aborted");

  // The byte fetch and the pdf.js module/worker load are independent — run them
  // concurrently so first-PDF latency is max(fetch, module-load), not the sum
  // (the lazy `pdfjs-dist` chunk + worker is hundreds of ms on first use).
  const [bytes, pdfjs] = await Promise.all([
    fetchPdfBytes(url, signal),
    loadPdfJs(),
  ]);
  if (signal?.aborted) throw new Error("aborted");

  const task = pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false, // anti-scripting: no PDF JS evaluation
    disableAutoFetch: true,
  });
  const doc = await task.promise;
  try {
    if (signal?.aborted) throw new Error("aborted");
    const page = await doc.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = width / baseViewport.width;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const viewport = page.getViewport({ scale: scale * dpr });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${Math.round(viewport.height / dpr)}px`;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("no 2d context");

    await page.render({ canvasContext: ctx, viewport }).promise;
    if (signal?.aborted) throw new Error("aborted");
    return canvas;
  } finally {
    // v6: destroy the loading task (frees the document + worker), NOT the doc
    // proxy — `doc.destroy` is undefined in v6 and threw, discarding the
    // already-rendered canvas into the icon fallback.
    void task.destroy();
  }
}
