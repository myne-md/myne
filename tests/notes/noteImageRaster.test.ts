// @vitest-environment jsdom
//
// The note→image raster step — myne-md/myne#557, the two `export.note-image`
// bullets.
//
// Both were roster rows asking a person to export a selection once a release and
// look at the result. Neither needs eyes:
//
// 1. **PREMISE CORRECTED by the derivation pass.** The roster row assumed the
//    output dimensions tracked `devicePixelRatio`, which would make them a
//    property of the reviewer's monitor and genuinely unverifiable in CI.
//    `RASTER_SCALE` is a hardcoded `2` (`src/lib/noteImageExport.ts`), so the
//    output is display-independent and `canvas.width === round(cardWidth * 2)`
//    is a plain assertion. That correction is the reason this bullet is here at
//    all.
// 2. **The tainted-canvas branch.** WKWebView renders `<foreignObject>`-in-SVG
//    to canvas less reliably than Chromium; when it taints, `toBlob` yields
//    `null`. The code already throws "canvas.toBlob returned null" and the
//    caller maps it to an `ImageExportOutcome`. What the roster row was really
//    asking is whether the user is TOLD and whether a zero-byte file is left
//    behind — and both are assertable by stubbing the canvas.
//
// jsdom gives no canvas at all, so `HTMLCanvasElement.prototype` members are
// stubbed per test. That is honest for what is under test: the arithmetic and
// the branch on `toBlob`'s answer are the app's, not the engine's. Whether a
// given engine taints is the engine's business and stays out of scope.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── seam stubs ──────────────────────────────────────────────────────────────

const invokeMock = vi.fn();
const saveMock = vi.fn();
const deliverFileMock = vi.fn();
let nativeSaveAs = true;

vi.mock("../../src/platform/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...(a as [])),
}));
vi.mock("../../src/platform/dialog", () => ({
  save: (...a: unknown[]) => saveMock(...(a as [])),
}));
vi.mock("../../src/platform/download", () => ({
  deliverFile: (...a: unknown[]) => deliverFileMock(...(a as [])),
}));
vi.mock("../../src/platform/capabilities", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/platform/capabilities")>();
  return { ...real, has: (cap: string) => (cap === "nativeSaveAs" ? nativeSaveAs : true) };
});
// No CodeMirror in this file: the selection is supplied directly below.
vi.mock("../../src/editor/active-view", () => ({ getActiveEditorView: () => null }));

const { rasterizeCardToPng, exportSelectionAsImage, SELECTION_CARD_PADDING } =
  await import("../../src/lib/noteImageExport");

// ── canvas / image doubles ──────────────────────────────────────────────────

interface CanvasProbe {
  /** Every canvas the code created, in order. */
  created: HTMLCanvasElement[];
  /** `ctx.scale(sx, sy)` calls. */
  scales: Array<[number, number]>;
}

/**
 * Install a canvas whose `toBlob` answers `blob`.
 *
 * `null` is the tainted-canvas case the whole second bullet is about.
 */
function stubCanvas(blob: Blob | null): CanvasProbe {
  const probe: CanvasProbe = { created: [], scales: [] };
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    const el = realCreate(tag) as HTMLElement;
    if (tag === "canvas") probe.created.push(el as HTMLCanvasElement);
    return el;
  }) as typeof document.createElement);

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    // `as unknown as` through the whole function type: `getContext` is
    // overloaded per context id, and a stub that answers one of them does not
    // structurally satisfy the union.
    (() =>
      ({
        scale: (sx: number, sy: number) => probe.scales.push([sx, sy]),
        drawImage: () => {},
      }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    cb: BlobCallback,
  ) {
    cb(blob);
  } as typeof HTMLCanvasElement.prototype.toBlob);
  return probe;
}

/**
 * Put a real, non-empty DOM selection on the page.
 *
 * The selection path is exercised for real (`window.getSelection()`, a real
 * `Range`, a real `XMLSerializer` round-trip) rather than stubbed, so the
 * outcomes below are the ones the production function computes. Only the RECT
 * is supplied: jsdom lays nothing out, so every rect is 0x0 and the code's own
 * zero-area guard would answer `no-selection` for every case in this file.
 */
function selectRealRange(html = "<p>alpha</p>"): void {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue({
    width: 184,
    height: 84,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 184,
    bottom: 84,
    toJSON: () => ({}),
  } as DOMRect);
  const range = document.createRange();
  range.selectNodeContents(host);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Make `new Image()` resolve its `onload` as soon as `src` is assigned. */
function stubImageDecode(succeed = true) {
  Object.defineProperty(window.Image.prototype, "src", {
    configurable: true,
    set(this: HTMLImageElement) {
      queueMicrotask(() => {
        if (succeed) this.onload?.(new Event("load"));
        else this.onerror?.(new Event("error"));
      });
    },
  });
}

beforeEach(() => {
  nativeSaveAs = true;
  URL.createObjectURL = vi.fn(() => "blob:stub");
  URL.revokeObjectURL = vi.fn();
  stubImageDecode(true);
});

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  invokeMock.mockReset();
  saveMock.mockReset();
  deliverFileMock.mockReset();
});

// ── 1. Output dimensions are display-independent ────────────────────────────

describe("the raster is scaled by a constant, not by the display", () => {
  it.each([
    [248, 148],
    [600, 400],
    [101, 33],
  ])("a %ix%i card rasterizes to exactly twice that", async (w, h) => {
    const probe = stubCanvas(new Blob([new Uint8Array([1, 2, 3])]));
    await rasterizeCardToPng("<svg/>", w, h);
    expect(probe.created.length).toBe(1);
    expect(probe.created[0].width).toBe(Math.round(w * 2));
    expect(probe.created[0].height).toBe(Math.round(h * 2));
    // …and the context is scaled to match, so the drawn card fills the buffer
    // rather than occupying its top-left quarter.
    expect(probe.scales).toEqual([[2, 2]]);
  });

  it("ignores devicePixelRatio entirely", async () => {
    // The corrected premise, asserted rather than assumed. A reviewer's monitor
    // must not be able to change the exported file.
    const dims: Array<[number, number]> = [];
    for (const dpr of [1, 2, 3.5]) {
      Object.defineProperty(window, "devicePixelRatio", {
        value: dpr,
        configurable: true,
      });
      const probe = stubCanvas(new Blob([new Uint8Array([1])]));
      await rasterizeCardToPng("<svg/>", 300, 200);
      dims.push([probe.created[0].width, probe.created[0].height]);
      vi.restoreAllMocks();
      stubImageDecode(true);
    }
    expect(new Set(dims.map((d) => d.join("x"))).size, `saw ${JSON.stringify(dims)}`).toBe(
      1,
    );
    expect(dims[0]).toEqual([600, 400]);
  });

  it("honours an explicit scale, so the constant is a default and not a hardcode", async () => {
    const probe = stubCanvas(new Blob([new Uint8Array([1])]));
    await rasterizeCardToPng("<svg/>", 100, 50, 3);
    expect(probe.created[0].width).toBe(300);
    expect(probe.created[0].height).toBe(150);
  });
});

// ── 2. The tainted-canvas branch ────────────────────────────────────────────

describe("a tainted canvas is reported, not written", () => {
  it("rasterizeCardToPng rejects by name when toBlob answers null", async () => {
    stubCanvas(null);
    await expect(rasterizeCardToPng("<svg/>", 100, 100)).rejects.toThrow(
      /toBlob returned null/,
    );
  });

  it("the export reports `error` and writes nothing at all", async () => {
    selectRealRange();
    stubCanvas(null);
    saveMock.mockResolvedValue("/tmp/card.png");

    const outcome = await exportSelectionAsImage();

    expect(outcome).toBe("failed");
    // The load-bearing half: no zero-byte file. The write is a separate IPC
    // AFTER the raster, so a failure that still reached it would leave a file
    // the user then opens and finds empty.
    expect(invokeMock).not.toHaveBeenCalled();
    // …and it never even got as far as asking for a destination, so no save
    // dialog flashed at somebody whose export had already failed.
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("reports `error` and delivers nothing on a client with no native Save As", async () => {
    // The browser arm. Same claim, different last step: the bytes are handed to
    // the browser's download instead of to Rust, and a tainted canvas must not
    // hand it an empty file either.
    nativeSaveAs = false;
    selectRealRange();
    stubCanvas(null);

    expect(await exportSelectionAsImage()).toBe("failed");
    expect(deliverFileMock).not.toHaveBeenCalled();
  });

  it("a failed image DECODE is the same outcome, and also writes nothing", async () => {
    // The other way step 3 fails. Grouped here because the user-visible
    // contract is identical and a branch tested on one side only is a branch
    // that can be deleted.
    selectRealRange();
    stubImageDecode(false);
    stubCanvas(new Blob([new Uint8Array([1])]));
    expect(await exportSelectionAsImage()).toBe("failed");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("the happy path still reaches the writer, so the negatives are not vacuous", () => {
  it("writes the PNG bytes to the chosen path", async () => {
    selectRealRange();
    stubCanvas(new Blob([new Uint8Array([137, 80, 78, 71])]));
    saveMock.mockResolvedValue("/tmp/card.png");
    invokeMock.mockResolvedValue(undefined);

    expect(await exportSelectionAsImage()).toBe("saved");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(cmd).toBe("plugin:notes|note_image_export");
    expect(args.targetPath).toBe("/tmp/card.png");
    expect(args.imageBytes).toEqual([137, 80, 78, 71]);
    // Not a zero-byte write: the bytes that reach the IPC are the encoded ones.
    expect((args.imageBytes as number[]).length).toBeGreaterThan(0);
  });

  it("a dismissed save dialog writes nothing and is not an error", async () => {
    selectRealRange();
    stubCanvas(new Blob([new Uint8Array([1])]));
    saveMock.mockResolvedValue(null);
    expect(await exportSelectionAsImage()).toBe("cancelled");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("the padding constant is the one the card is measured with", async () => {
    // Drive the real export rather than asserting the constant is positive:
    // noteImageExport.ts:182 builds the SVG at `selection + padding*2` and
    // :196-197 rasters exactly that size, so a card that stopped using the
    // constant changes both the SVG width and the canvas dimensions below.
    selectRealRange(); // rect is 184x84; see selectRealRange
    const probe = stubCanvas(new Blob([new Uint8Array([1])]));
    saveMock.mockResolvedValue("/tmp/card.png");
    expect(await exportSelectionAsImage()).toBe("saved");

    const cardSide = (content: number): number => content + SELECTION_CARD_PADDING * 2;
    const svgBlob = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0] as Blob;
    expect(await svgBlob.text()).toContain(`width="${cardSide(184)}"`);
    // Raster supersampling is RASTER_SCALE (2).
    expect(probe.created[0].width).toBe(cardSide(184) * 2);
    expect(probe.created[0].height).toBe(cardSide(84) * 2);
  });
});

// ── 2b. The card background really is the active theme's ────────────────────
//
// Found while writing the bullets above, and fixed in the same change because it
// is the same function: the card background was read from `--paper-1`, which
// **is not a token**. `src/styles/tokens.css` defines `--paper`, `--paper-2` and
// `--paper-3`, and `src/AGENTS.md` states outright that "`var(--paper-1)`
// resolves to nothing". So `cssVar` always fell through to its hardcoded cream
// literal and every exported card came out light — on dark and on AMOLED too —
// while this function's own doc comment promised the background "comes from the
// ACTIVE theme". A hand-walk on a light theme sees nothing wrong, which is
// exactly why it survived.
//
// The same dead token name is read from eight other call sites across the UI.
// Those are separate surfaces with their own fallbacks and they are NOT touched
// here.

describe("the exported card takes its background from the live theme", () => {
  /** Drive one export and return the SVG the card builder produced. */
  async function backgroundOf(paper: string): Promise<string> {
    document.documentElement.style.setProperty("--paper", paper);
    selectRealRange();
    stubCanvas(new Blob([new Uint8Array([1])]));
    saveMock.mockResolvedValue("/tmp/card.png");
    invokeMock.mockResolvedValue(undefined);
    const urlSpy = URL.createObjectURL as unknown as ReturnType<typeof vi.fn>;
    await exportSelectionAsImage();
    const blob = urlSpy.mock.calls[0]?.[0] as Blob | undefined;
    expect(blob, "the card was never turned into an object URL").toBeDefined();
    return await blob!.text();
  }

  afterEach(() => {
    document.documentElement.style.removeProperty("--paper");
  });

  it("uses the theme's paper colour, not a hardcoded literal", async () => {
    const svg = await backgroundOf("#121210");
    expect(
      svg,
      "the card background did not follow --paper. A dead token name here " +
        "means every export is light whatever theme is on screen.",
    ).toContain('fill="#121210"');
    expect(svg).not.toContain("#faf8f3");
  });

  it("follows the token when the theme changes", async () => {
    // Two different values through the same code path: a background that is
    // right once could still be a coincidence.
    expect(await backgroundOf("#fbfbfa")).toContain('fill="#fbfbfa"');
  });

  it("names a token the stylesheet actually defines", async () => {
    // The static half. `cssVar` falls back silently, so a second dead token
    // name would reintroduce the bug with every test above still green in a
    // browser that resolves nothing.
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/lib/noteImageExport.ts", "utf8");
    const tokens = [...src.matchAll(/cssVar\("(--[a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(tokens.length, "no cssVar call sites found — the scan is stale").toBeGreaterThan(
      0,
    );
    // Both sheets: myne-md/myne#478 moved the design tokens to
    // `client-core/src/tokens.css` and left the component layer behind.
    const sheet = [
      fs.readFileSync("client-core/src/tokens.css", "utf8"),
      fs.readFileSync("src/styles/tokens.css", "utf8"),
    ].join("\n");
    for (const token of tokens) {
      expect(
        sheet.includes(`${token}:`),
        `${token} is read by the export card and defined nowhere in ` +
          `src/styles/tokens.css, so cssVar silently returns its fallback`,
      ).toBe(true);
    }
  });
});

// ── 3. What each outcome tells the user ─────────────────────────────────────

describe("every outcome the export can return has a toast key", () => {
  it("maps ok / no-selection / error to copy, and cancelled to silence", async () => {
    // The second bullet's "assert the outcome reaches a toast" half. Reading the
    // caller's mapping rather than driving the palette keeps this in the fast
    // lane; the mapping IS the contract, and a fifth outcome added without a
    // key would fall through to silence — an export that failed and said
    // nothing, which is the failure the roster row was watching for.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/commands/actions.ts", "utf8"),
    );
    const fn = src.slice(src.indexOf("export function exportSelectionImageWithToast"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    for (const outcome of ["saved", "no-selection", "failed"]) {
      expect(
        body.includes(`"${outcome}"`),
        `exportSelectionImageWithToast does not mention the ${outcome} outcome`,
      ).toBe(true);
    }
    expect(body).toContain("exportSelectionImage.saved");
    expect(body).toContain("exportSelectionImage.noSelection");
    expect(body).toContain("exportSelectionImage.failed");
  });
});
