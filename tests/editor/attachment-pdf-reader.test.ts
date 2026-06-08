// @vitest-environment jsdom
//
// Scrollable multi-page PDF reader (epic MYND-164).
//
// jsdom can't run real pdf.js or a real canvas raster — so we mock
// `pdf-render`'s shared seams (`loadPdfJs` + `fetchPdfBytes`) the same way the
// existing pdf tests do, and exercise the observable wiring of the rewritten
// (truly windowed) reader:
//   - the container is NEVER hidden — a "Loading…" chip shows immediately,
//   - bytes fetched ONCE (not per page),
//   - one placeholder per page, min-height-sized from PAGE 1's aspect ratio up
//     front (a single getPage(1)→getViewport, not one per page before paint),
//   - the first page(s) render EAGERLY; the "Loading…" chip drops on first paint,
//   - the rest render lazily via IntersectionObserver (we stub a controllable
//     IO and assert a page only paints once it intersects); without IO (default
//     jsdom) every page renders eagerly so the reader still works,
//   - cleanup destroys the pdf.js task + clears the container,
//   - a load/parse failure rejects → onError fires + container is cleared so the
//     caller keeps the icon fallback.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/editor/attachments/pdf-render", () => ({
  loadPdfJs: vi.fn(),
  fetchPdfBytes: vi.fn(),
}));

import { mountPdfScroller } from "../../src/editor/attachments/pdf-reader";
import {
  loadPdfJs,
  fetchPdfBytes,
} from "../../src/editor/attachments/pdf-render";

const URL = "attachment://" + "c".repeat(64);

const mockedLoad = vi.mocked(loadPdfJs);
const mockedFetch = vi.mocked(fetchPdfBytes);

/** A fake pdf.js document + task. `getViewport` respects `scale` (like the real
 *  pdf.js) so the rendered canvas height refines correctly; the base page is
 *  200×300, so the aspect ratio is 1.5. render() resolves immediately. */
function fakePdf(numPages: number) {
  const destroy = vi.fn(async () => {});
  const getPage = vi.fn(async (_n: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({
      width: 200 * scale,
      height: 300 * scale,
    }),
    render: (_a: unknown) => ({ promise: Promise.resolve() }),
  }));
  const task = { promise: Promise.resolve({ numPages, getPage }), destroy };
  const getDocument = vi.fn(() => task);
  return { task, getDocument, destroy, getPage };
}

function mockOk(fake: ReturnType<typeof fakePdf>): void {
  mockedFetch.mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  mockedLoad.mockResolvedValue({
    GlobalWorkerOptions: { workerSrc: "" },
    getDocument: fake.getDocument,
  });
}

beforeEach(() => {
  // jsdom canvas has no 2d context; stub getContext so render() proceeds.
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => ({}) as unknown as CanvasRenderingContext2D,
  ) as unknown as typeof HTMLCanvasElement.prototype.getContext;

  // jsdom doesn't implement canvas.toBlob — stub it to synchronously hand back a
  // tiny PNG-ish Blob so the reader's canvas→img rasterise path runs. The reader
  // converts each rendered canvas to a <img> (WKWebView canvas-compositing fix)
  // and frees the canvas, so the slots end up holding <img> elements.
  HTMLCanvasElement.prototype.toBlob = vi.fn(function (
    this: HTMLCanvasElement,
    cb: (blob: Blob | null) => void,
  ) {
    cb(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }));
  }) as unknown as typeof HTMLCanvasElement.prototype.toBlob;

  // objectURL plumbing isn't in jsdom; stub create/revoke on the global URL the
  // source module sees. (The local `URL` const below shadows the global only
  // within this test file, not inside the reader, which uses the global.)
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:fake"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("mountPdfScroller", () => {
  it("shows a Loading… chip immediately, before any async work resolves", () => {
    const fake = fakePdf(3);
    mockOk(fake);
    const container = document.createElement("div");
    mountPdfScroller(container, { url: URL, pageWidth: 320 });
    // Synchronously (before the fetch promise resolves) the container is laid
    // out with the loading chip — never display:none.
    const chip = container.querySelector(".cm-attachment-pdf-loading");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe("Loading…");
  });

  it("fetches the bytes ONCE and lays out a min-height placeholder per page from page 1's ratio", async () => {
    const fake = fakePdf(3);
    mockOk(fake);

    const container = document.createElement("div");
    document.body.appendChild(container);
    mountPdfScroller(container, { url: URL, pageWidth: 320 });

    await vi.waitFor(() => {
      expect(container.querySelectorAll(".cm-attachment-pdf-page").length).toBe(
        3,
      );
    });

    // Bytes fetched exactly once, against the attachment URL.
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedFetch.mock.calls[0]![0]).toBe(URL);

    // Placeholders were sized from page 1's ratio (1.5) only — getPage(1) is the
    // single dimension probe (called once for sizing; render also calls getPage
    // per page, but the placeholder loop itself does not probe each page).
    const slots = container.querySelectorAll<HTMLElement>(
      ".cm-attachment-pdf-page",
    );
    // Width = pageWidth; min-height (the up-front estimate) = round(320 * 1.5).
    expect(slots[0]!.style.width).toBe("320px");
    // After eager render the first pages refine to their exact height (480) and
    // gain the rendered marker; their min-height is cleared.
    expect(slots[0]!.classList.contains("cm-attachment-pdf-page-rendered")).toBe(
      true,
    );
    expect(slots[0]!.style.height).toBe("480px");
  });

  it("renders every page eagerly when IntersectionObserver is absent (jsdom default), dropping the Loading chip", async () => {
    const fake = fakePdf(2);
    mockOk(fake);

    const container = document.createElement("div");
    document.body.appendChild(container);
    mountPdfScroller(container, { url: URL, pageWidth: 320 });

    await vi.waitFor(() => {
      expect(
        container.querySelectorAll(".cm-attachment-pdf-page-canvas").length,
      ).toBe(2);
    });
    // First paint dropped the Loading… chip.
    expect(container.querySelector(".cm-attachment-pdf-loading")).toBeNull();
  });

  it("rasterises each rendered page to an <img> (WKWebView canvas-compositing fix), not a live canvas, freeing the canvas", async () => {
    // Capture the canvas the reader rasterises so we can assert it was freed.
    let lastCanvas: HTMLCanvasElement | null = null;
    HTMLCanvasElement.prototype.toBlob = vi.fn(function (
      this: HTMLCanvasElement,
      cb: (blob: Blob | null) => void,
    ) {
      lastCanvas = this;
      cb(new Blob([new Uint8Array([0x89])], { type: "image/png" }));
    }) as unknown as typeof HTMLCanvasElement.prototype.toBlob;

    const fake = fakePdf(1);
    mockOk(fake);

    const container = document.createElement("div");
    document.body.appendChild(container);
    mountPdfScroller(container, { url: URL, pageWidth: 320 });

    await vi.waitFor(() => {
      expect(
        container.querySelectorAll("img.cm-attachment-pdf-page-canvas").length,
      ).toBe(1);
    });

    // The slot holds an <img> with the shared page-canvas class and the right
    // display dimensions — NOT a live <canvas>.
    const img = container.querySelector<HTMLImageElement>(
      "img.cm-attachment-pdf-page-canvas",
    )!;
    expect(img.tagName).toBe("IMG");
    expect(img.style.width).toBe("320px");
    expect(img.style.height).toBe("480px"); // 320 * (300/200)
    expect(img.getAttribute("src")).toBe("blob:fake");
    expect(container.querySelector("canvas.cm-attachment-pdf-page-canvas")).toBeNull();

    // The intermediate canvas had its backing store freed after rasterising.
    expect(lastCanvas).not.toBeNull();
    expect(lastCanvas!.width).toBe(0);
    expect(lastCanvas!.height).toBe(0);

    // The objectURL was created (the local `URL` const shadows the global, so
    // reach the stubbed global directly).
    expect(globalThis.URL.createObjectURL).toHaveBeenCalled();
  });

  it("falls back to a live canvas when toBlob yields null", async () => {
    HTMLCanvasElement.prototype.toBlob = vi.fn(function (
      this: HTMLCanvasElement,
      cb: (blob: Blob | null) => void,
    ) {
      cb(null);
    }) as unknown as typeof HTMLCanvasElement.prototype.toBlob;

    const fake = fakePdf(1);
    mockOk(fake);

    const container = document.createElement("div");
    document.body.appendChild(container);
    mountPdfScroller(container, { url: URL, pageWidth: 320 });

    await vi.waitFor(() => {
      expect(
        container.querySelectorAll("canvas.cm-attachment-pdf-page-canvas").length,
      ).toBe(1);
    });
    // Fallback path keeps the live canvas; no <img> produced.
    expect(container.querySelector("img.cm-attachment-pdf-page-canvas")).toBeNull();
  });

  it("windows the lazy pages via IntersectionObserver: eager first pages paint, later pages only on intersection", async () => {
    // Controllable IO stub: capture observed targets + the callback so we can
    // drive an intersection manually (jsdom has no real IO).
    let ioCallback: (entries: { target: Element; isIntersecting: boolean }[]) => void =
      () => {};
    const observed: Element[] = [];
    const disconnect = vi.fn();
    class FakeIO {
      constructor(cb: typeof ioCallback) {
        ioCallback = cb;
      }
      observe(el: Element): void {
        observed.push(el);
      }
      unobserve(): void {}
      disconnect = disconnect;
    }
    vi.stubGlobal("IntersectionObserver", FakeIO as unknown);

    const fake = fakePdf(5);
    mockOk(fake);

    const container = document.createElement("div");
    document.body.appendChild(container);
    mountPdfScroller(container, { url: URL, pageWidth: 320 });

    // The two eager leading pages paint without any intersection.
    await vi.waitFor(() => {
      expect(
        container.querySelectorAll(".cm-attachment-pdf-page-canvas").length,
      ).toBe(2);
    });
    // The remaining 3 pages are observed, not yet painted.
    expect(observed.length).toBe(3);
    expect(
      container.querySelectorAll(".cm-attachment-pdf-page-canvas").length,
    ).toBe(2);

    // Intersect page 3 → it paints (now 3 canvases). Page 4/5 stay pending.
    ioCallback([{ target: observed[0]!, isIntersecting: true }]);
    await vi.waitFor(() => {
      expect(
        container.querySelectorAll(".cm-attachment-pdf-page-canvas").length,
      ).toBe(3);
    });
  });

  it("clamps the canvas backing store to MAX_CANVAS_DIM for a tall page at a large pageWidth", async () => {
    // Tall page (612×1584 ≈ a long receipt) at the lightbox pageWidth (900).
    // Unclamped, the backing store would be ~900×2329 × dpr — well past the cap.
    // The canvas is freed (zeroed) after rasterising to <img>, so we capture its
    // backing-store dims inside toBlob (before the reader zeroes them).
    let captured: { w: number; h: number } | null = null;
    HTMLCanvasElement.prototype.toBlob = vi.fn(function (
      this: HTMLCanvasElement,
      cb: (blob: Blob | null) => void,
    ) {
      captured = { w: this.width, h: this.height };
      cb(new Blob([new Uint8Array([0x89])], { type: "image/png" }));
    }) as unknown as typeof HTMLCanvasElement.prototype.toBlob;

    const destroy = vi.fn(async () => {});
    const getPage = vi.fn(async (_n: number) => ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 612 * scale,
        height: 1584 * scale,
      }),
      render: (_a: unknown) => ({ promise: Promise.resolve() }),
    }));
    mockedFetch.mockResolvedValue(new Uint8Array([1]));
    mockedLoad.mockResolvedValue({
      GlobalWorkerOptions: { workerSrc: "" },
      getDocument: vi.fn(() => ({
        promise: Promise.resolve({ numPages: 1, getPage }),
        destroy,
      })),
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    mountPdfScroller(container, { url: URL, pageWidth: 900 });

    await vi.waitFor(() => {
      expect(
        container.querySelectorAll("img.cm-attachment-pdf-page-canvas").length,
      ).toBe(1);
    });

    // Both backing-store axes are clamped to MAX_CANVAS_DIM (1600).
    expect(captured).not.toBeNull();
    expect(captured!.w).toBeLessThanOrEqual(1600);
    expect(captured!.h).toBeLessThanOrEqual(1600);
    // The tall axis is the one that hits the cap.
    expect(captured!.h).toBe(1600);

    const img = container.querySelector<HTMLImageElement>(
      "img.cm-attachment-pdf-page-canvas",
    )!;
    // The CSS display width still tracks pageWidth (clamp only softens, never
    // shrinks the rendered page).
    expect(img.style.width).toBe("900px");
  });

  it("recycles an off-screen page: drops its canvas back to a placeholder + frees the back-buffer, then re-renders on re-intersect", async () => {
    let ioCallback: (
      entries: { target: Element; isIntersecting: boolean }[],
    ) => void = () => {};
    const observed: Element[] = [];
    const disconnect = vi.fn();
    class FakeIO {
      constructor(cb: typeof ioCallback) {
        ioCallback = cb;
      }
      observe(el: Element): void {
        observed.push(el);
      }
      unobserve(): void {}
      disconnect = disconnect;
    }
    vi.stubGlobal("IntersectionObserver", FakeIO as unknown);

    const fake = fakePdf(5);
    mockOk(fake);

    const container = document.createElement("div");
    document.body.appendChild(container);
    mountPdfScroller(container, { url: URL, pageWidth: 320 });

    // Eager pages 1-2 paint; pages 3-5 observed (not painted).
    await vi.waitFor(() => {
      expect(
        container.querySelectorAll(".cm-attachment-pdf-page-canvas").length,
      ).toBe(2);
    });
    expect(observed.length).toBe(3);

    // Intersect page 3 → it paints (3 canvases now).
    ioCallback([{ target: observed[0]!, isIntersecting: true }]);
    await vi.waitFor(() => {
      expect(
        container.querySelectorAll(".cm-attachment-pdf-page-canvas").length,
      ).toBe(3);
    });

    const page3Slot = observed[0]! as HTMLElement;
    // The rendered slot holds an <img> (the rasterised page), not a live canvas.
    const renderedImg = page3Slot.querySelector<HTMLImageElement>(
      "img.cm-attachment-pdf-page-canvas",
    );
    expect(renderedImg).not.toBeNull();
    expect(
      page3Slot.querySelector("canvas.cm-attachment-pdf-page-canvas"),
    ).toBeNull();
    expect(page3Slot.classList.contains("cm-attachment-pdf-page-rendered")).toBe(
      true,
    );

    // Scroll page 3 far away → un-intersect. Its <img> is removed (freeing the
    // decoded bitmap); the slot reverts to the muted "pending" placeholder.
    ioCallback([{ target: page3Slot, isIntersecting: false }]);
    await vi.waitFor(() => {
      expect(
        container.querySelectorAll(".cm-attachment-pdf-page-canvas").length,
      ).toBe(2);
    });
    expect(page3Slot.querySelector(".cm-attachment-pdf-page-canvas")).toBeNull();
    expect(page3Slot.classList.contains("cm-attachment-pdf-page-rendered")).toBe(
      false,
    );
    // The slot reverted to a bare placeholder (restored min-height estimate).
    expect(page3Slot.childElementCount).toBe(0);
    expect(page3Slot.style.minHeight).not.toBe("");

    // Re-intersect → it re-renders (back to 3 imgs).
    ioCallback([{ target: page3Slot, isIntersecting: true }]);
    await vi.waitFor(() => {
      expect(
        container.querySelectorAll(".cm-attachment-pdf-page-canvas").length,
      ).toBe(3);
    });
    expect(page3Slot.classList.contains("cm-attachment-pdf-page-rendered")).toBe(
      true,
    );
  });

  it("does NOT recycle the eager leading pages when they report un-intersecting", async () => {
    let ioCallback: (
      entries: { target: Element; isIntersecting: boolean }[],
    ) => void = () => {};
    const observed: Element[] = [];
    class FakeIO {
      constructor(cb: typeof ioCallback) {
        ioCallback = cb;
      }
      observe(el: Element): void {
        observed.push(el);
      }
      unobserve(): void {}
      disconnect = vi.fn();
    }
    vi.stubGlobal("IntersectionObserver", FakeIO as unknown);

    const fake = fakePdf(4);
    mockOk(fake);

    const container = document.createElement("div");
    document.body.appendChild(container);
    mountPdfScroller(container, { url: URL, pageWidth: 320 });

    await vi.waitFor(() => {
      expect(
        container.querySelectorAll(".cm-attachment-pdf-page-canvas").length,
      ).toBe(2);
    });

    // The eager pages aren't observed (so this can't even fire via IO), but guard
    // the invariant: the leading canvases stay resident regardless.
    const slots = container.querySelectorAll<HTMLElement>(
      ".cm-attachment-pdf-page",
    );
    ioCallback([{ target: slots[0]!, isIntersecting: false }]);
    expect(
      container.querySelectorAll(".cm-attachment-pdf-page-canvas").length,
    ).toBe(2);
  });

  it("isolates a single page render failure: the page keeps its placeholder, the reader survives", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakePdf(2);
    mockedFetch.mockResolvedValue(new Uint8Array([1]));
    let call = 0;
    const getPage = vi.fn(async (_n: number) => {
      call += 1;
      // page 1 sizing probe + render fine; page 2 render throws.
      if (call >= 3) throw new Error("RenderingCancelledException: page 2");
      return {
        getViewport: ({ scale }: { scale: number }) => ({
          width: 200 * scale,
          height: 300 * scale,
        }),
        render: () => ({ promise: Promise.resolve() }),
      };
    });
    mockedLoad.mockResolvedValue({
      GlobalWorkerOptions: { workerSrc: "" },
      getDocument: vi.fn(() => ({
        promise: Promise.resolve({ numPages: 2, getPage }),
        destroy: vi.fn(async () => {}),
      })),
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    mountPdfScroller(container, { url: URL, pageWidth: 320 });

    await vi.waitFor(() => {
      // Both placeholders exist; page 1 painted a canvas, page 2 did not.
      expect(container.querySelectorAll(".cm-attachment-pdf-page").length).toBe(
        2,
      );
      expect(
        container.querySelectorAll(".cm-attachment-pdf-page-canvas").length,
      ).toBe(1);
    });
  });

  it("cleanup destroys the pdf.js task and clears the container", async () => {
    const fake = fakePdf(2);
    mockOk(fake);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const cleanup = mountPdfScroller(container, { url: URL, pageWidth: 320 });

    await vi.waitFor(() => {
      expect(container.querySelectorAll(".cm-attachment-pdf-page").length).toBe(
        2,
      );
    });

    cleanup();
    expect(fake.destroy).toHaveBeenCalledTimes(1);
    expect(container.childElementCount).toBe(0);
  });

  it("fires onError and clears the container when the load fails (icon fallback)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockedFetch.mockRejectedValue(new Error("blocked by CSP"));
    const onError = vi.fn();

    const container = document.createElement("div");
    document.body.appendChild(container);
    mountPdfScroller(container, { url: URL, pageWidth: 320, onError });

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });
    expect(container.childElementCount).toBe(0);
  });

  it("aborts before fetch when the signal is already aborted", () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const container = document.createElement("div");
    mountPdfScroller(container, {
      url: URL,
      pageWidth: 320,
      signal: ctrl.signal,
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
