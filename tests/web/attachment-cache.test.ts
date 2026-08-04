// The page-side attachment-URL cache (phase3-web-client task 44).
//
// This is where the synchronous/asynchronous mismatch is resolved, so it is
// worth testing directly rather than only through a render: `attachmentUrl(id)`
// in `@myne/editor` returns a `string` used as an `<img src>` and interpolated
// into HTML strings, while minting a `blob:` URL means a Worker round trip and
// an AEAD open. The cache's whole job is to make `lookup` total and synchronous
// and to put the waiting in `warm`.
//
// The Worker is mocked at the seam (`../../web/src/platform/core`) because what
// is under test is the caching, coalescing and failure behaviour — not the IPC,
// which `tests/platform/web-seam.test.ts` covers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../../web/src/platform/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import {
  PENDING_ATTACHMENT_SRC,
  clear,
  isWarm,
  lookup,
  size,
  warm,
} from "../../web/src/platform/attachment-cache";

const A = "a".repeat(64);
const B = "b".repeat(64);

beforeEach(() => {
  clear();
  invoke.mockReset();
});

afterEach(() => {
  clear();
});

describe("lookup (synchronous, total)", () => {
  it("answers the placeholder for an id nobody warmed", () => {
    expect(lookup(A)).toBe(PENDING_ATTACHMENT_SRC);
  });

  it("answers a same-origin path, never an empty string or a data: URI", () => {
    // An empty `src` is resolved against the document URL, so a browser would
    // re-request the whole app shell to paint one image; a `data:` URI would
    // need the CSP grant this task's criterion forbids widening.
    expect(PENDING_ATTACHMENT_SRC).not.toBe("");
    expect(PENDING_ATTACHMENT_SRC.startsWith("data:")).toBe(false);
    expect(PENDING_ATTACHMENT_SRC.startsWith("/")).toBe(true);
  });

  it("starts no work of its own", async () => {
    lookup(A);
    lookup(A);
    // A lookup happens during render; kicking off IO from a render is how you
    // get a render loop.
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("warm", () => {
  it("makes lookup answer with the minted URL", async () => {
    invoke.mockResolvedValue({ url: "blob:http://localhost/one", evicted: [] });
    await warm([A]);
    expect(lookup(A)).toBe("blob:http://localhost/one");
    expect(isWarm(A)).toBe(true);
  });

  it("asks the Worker once per id, not once per warm", async () => {
    invoke.mockResolvedValue({ url: "blob:x", evicted: [] });
    await warm([A]);
    await warm([A, A]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent warms of the same id into one round trip", async () => {
    // Two components rendering the same image must not decrypt it twice — the
    // second copy of the plaintext in the Worker's heap is the cost that matters,
    // not the message.
    let release!: (v: { url: string; evicted: readonly string[] }) => void;
    invoke.mockImplementation(
      () =>
        new Promise<{ url: string; evicted: readonly string[] }>((res) => {
          release = res;
        }),
    );
    const first = warm([A]);
    const second = warm([A]);
    release({ url: "blob:shared", evicted: [] });
    await Promise.all([first, second]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(lookup(A)).toBe("blob:shared");
  });

  it("de-duplicates within one call", async () => {
    invoke.mockResolvedValue({ url: "blob:x", evicted: [] });
    await warm([A, A, A]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does nothing for an empty list", async () => {
    expect(await warm([])).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports which ids became warm", async () => {
    invoke.mockResolvedValue({ url: "blob:x", evicted: [] });
    expect(await warm([A])).toEqual([A]);
    // Already warm → nothing changed, so a caller can skip a re-render.
    expect(await warm([A])).toEqual([]);
  });
});

describe("one failure does not take the note's other images down", () => {
  it("keeps the good id warm and leaves the bad one a placeholder", async () => {
    invoke.mockImplementation((_cmd: string, args: { id: string }) =>
      args.id === A
        ? Promise.resolve({ url: "blob:good", evicted: [] })
        : Promise.reject({ kind: "NotFound" }),
    );
    await warm([A, B]);
    expect(lookup(A)).toBe("blob:good");
    expect(lookup(B)).toBe(PENDING_ATTACHMENT_SRC);
  });

  it("never rejects, whatever the Worker does", async () => {
    invoke.mockRejectedValue(new Error("worker died"));
    await expect(warm([A])).resolves.toEqual([]);
  });

  it("retries a failed id on a later warm", async () => {
    // A failure must not be cached as an answer: an attachment can arrive from
    // sync a moment after a render asked for it.
    invoke.mockRejectedValueOnce({ kind: "NotFound" });
    await warm([A]);
    expect(isWarm(A)).toBe(false);
    invoke.mockResolvedValueOnce({ url: "blob:arrived", evicted: [] });
    await warm([A]);
    expect(lookup(A)).toBe("blob:arrived");
  });
});

describe("clear (the lock path)", () => {
  it("drops every URL so a post-lock render cannot paint a revoked one", async () => {
    invoke.mockResolvedValue({ url: "blob:x", evicted: [] });
    await warm([A, B]);
    expect(size()).toBe(2);
    clear();
    expect(size()).toBe(0);
    // A revoked URL renders as a BROKEN image, which reads to a user as data
    // loss; the placeholder reads as "not ready".
    expect(lookup(A)).toBe(PENDING_ATTACHMENT_SRC);
  });

  it("lets a re-unlock warm the same ids again", async () => {
    invoke.mockResolvedValue({ url: "blob:first", evicted: [] });
    await warm([A]);
    clear();
    invoke.mockResolvedValue({ url: "blob:second", evicted: [] });
    await warm([A]);
    expect(lookup(A)).toBe("blob:second");
  });
});

// ── myne#388: eviction is two-sided ─────────────────────────────────────────
//
// The Worker's URL map is bounded by a byte budget and evicts
// least-recently-used. The page holds its OWN copy of the strings, so an id the
// Worker revoked has to leave this map too — otherwise `warm` skips it as
// already-warm forever and the tile paints a `blob:` handle whose `Blob` is
// gone. A broken image reads to a user as corruption; the placeholder reads as
// "not ready", which is the honest answer for something that will re-mint.
describe("eviction reported by the Worker", () => {
  it("forgets an evicted id, so a later warm re-mints instead of painting a dead handle", async () => {
    invoke.mockResolvedValueOnce({ url: "blob:a", evicted: [] });
    await warm([A]);
    expect(isWarm(A)).toBe(true);

    // Minting B pushed A out of the Worker's budget.
    invoke.mockResolvedValueOnce({ url: "blob:b", evicted: [A] });
    await warm([B]);
    expect(isWarm(A)).toBe(false);
    expect(lookup(A)).toBe(PENDING_ATTACHMENT_SRC);
    expect(lookup(B)).toBe("blob:b");

    // …and A is warmable again rather than stuck.
    invoke.mockResolvedValueOnce({ url: "blob:a2", evicted: [] });
    await warm([A]);
    expect(lookup(A)).toBe("blob:a2");
  });

  it("reports an evicted id as CHANGED, so its tile repaints", async () => {
    // The return is "ids whose resolved URL changed" — newly warm plus newly
    // gone. A caller that only repainted the newly-warm would leave the evicted
    // tile rendering a stale key against a dead URL.
    invoke.mockResolvedValueOnce({ url: "blob:a", evicted: [] });
    await warm([A]);
    invoke.mockResolvedValueOnce({ url: "blob:b", evicted: [A] });
    expect([...(await warm([B]))].sort()).toEqual([A, B].sort());
  });
});
