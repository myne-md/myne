// @vitest-environment jsdom
//
// PDF first-page render data-acquisition (MYND-164 dogfooding fix #5).
//
// ROOT CAUSE the fix addresses: pdf.js's `getDocument({ url })` path routes
// through `isValidFetchUrl`, which accepts only `http(s):`. The `attachment://`
// custom scheme falls through to an XHR the WebView CSP `connect-src` did not
// allow — so the inline render silently fell back to the icon. The fix fetches
// the decrypted bytes here (the same `attachment://` source the inline <img>
// uses, now allowed by `connect-src attachment:`) and feeds pdf.js a
// `Uint8Array` via `data`, sidestepping pdf.js's http-only stream selection.
//
// These tests pin the OBSERVABLE contract without driving real pdf.js (which
// can't run in jsdom): the renderer fetches the attachment URL first, and
// REJECTS (never throws) on a fetch failure so the caller's icon fallback runs.

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPdfFirstPage } from "../../src/editor/attachments/pdf-render";

const URL = "attachment://" + "b".repeat(64);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("renderPdfFirstPage data acquisition", () => {
  it("fetches the attachment URL itself (not pdf.js's http-only url path)", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer, // "%PDF"
    }));
    vi.stubGlobal("fetch", fetchSpy);

    // pdf.js can't load in jsdom → it will reject after the fetch. We only need
    // to observe that the fetch happened against the attachment URL.
    await renderPdfFirstPage({ url: URL, width: 320 }).catch(() => {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toBe(URL);
  });

  it("REJECTS (does not throw) when the bytes fetch fails — caller falls back", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("blocked by CSP");
      }),
    );
    await expect(renderPdfFirstPage({ url: URL, width: 320 })).rejects.toBeTruthy();
    // A diagnosable, DENY-list-safe warning (no bytes / id / path).
    expect(warn).toHaveBeenCalled();
    const msg = String(warn.mock.calls[0]?.[0] ?? "");
    expect(msg).not.toContain("b".repeat(64));
  });

  it("REJECTS on a non-ok HTTP-style response", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })),
    );
    await expect(renderPdfFirstPage({ url: URL, width: 320 })).rejects.toBeTruthy();
  });

  it("rejects early when the signal is already aborted (no fetch)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      renderPdfFirstPage({ url: URL, width: 320, signal: ctrl.signal }),
    ).rejects.toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
