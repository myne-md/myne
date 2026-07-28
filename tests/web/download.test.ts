// @vitest-environment jsdom
//
// The browser download seam (phase3-web-client task 48).
//
// `threat-model.md` TB3 makes export the deliberate plaintext-egress exception,
// and names two properties: USER-INITIATED and ONE-SHOT. This file pins the
// second one, because it is the one a mechanism can get wrong silently.
//
// An object URL is a GC ROOT for its `Blob` — the lesson task 44 paid for. So an
// export that forgot to revoke would leave the decrypted note body resident for
// the life of the page, and the only visible symptom would be memory. The test
// that matters here is therefore "revoked", not "downloaded".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverFile } from "../../web/src/platform/download";

const created: string[] = [];
const revoked: string[] = [];
let clicked: Array<{ href: string; download: string }> = [];

beforeEach(() => {
  created.length = 0;
  revoked.length = 0;
  clicked = [];
  let n = 0;
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: (_b: Blob) => {
      const u = `blob:test/${n++}`;
      created.push(u);
      return u;
    },
    revokeObjectURL: (u: string) => {
      revoked.push(u);
    },
  });
  // Capture the synthetic anchor's click rather than letting jsdom navigate.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push({ href: this.href, download: this.download });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("deliverFile", () => {
  it("delivers the bytes under the suggested name", async () => {
    await deliverFile("My Note.md", new TextEncoder().encode("# hi"), "text/markdown");
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe("My Note.md");
    expect(clicked[0].href).toBe(created[0]);
  });

  it("revokes the object URL — the TB3 one-shot property", async () => {
    await deliverFile("a.md", new Uint8Array([1, 2, 3]), "text/markdown");
    // Revoked in the SAME turn, not on a timer: the browser has taken its own
    // reference by the time `click()` returns, so the download still completes.
    // What revoking ends is this page's handle on the decrypted bytes.
    expect(revoked).toEqual(created);
  });

  it("revokes even when the click throws, so a failure cannot pin plaintext", async () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      throw new Error("blocked");
    });
    await expect(
      deliverFile("a.md", new Uint8Array([1]), "text/markdown"),
    ).rejects.toThrow("blocked");
    expect(revoked).toEqual(created);
  });

  it("leaves nothing in the document", async () => {
    await deliverFile("a.md", new Uint8Array([1]), "text/markdown");
    // The anchor is deliberately never appended: a detached one's `click()`
    // starts the download in every target browser, and appending would leave a
    // hidden element a later render could trip over.
    expect(document.querySelectorAll("a")).toHaveLength(0);
  });

  it("mints one URL per call and never reuses one", async () => {
    await deliverFile("a.md", new Uint8Array([1]), "text/markdown");
    await deliverFile("b.md", new Uint8Array([2]), "text/markdown");
    expect(new Set(created).size).toBe(2);
    expect(revoked).toEqual(created);
  });
});
