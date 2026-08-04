// @vitest-environment jsdom
//
// Every thumbnail surface warms the ids it renders (#263) — and only the ids it
// SHOWS (myne#388).
//
// On the web client an `AttachmentThumbnail` renders from a blob URL the host
// has already minted — it does not fetch. Only `AttachmentsLibrary` warmed, so
// the other two surfaces painted blank boxes: the cover picker, where the
// filename is a `title` tooltip and nothing else, so the user picked blind; and
// the clean-unused dialog, where the thumbnails exist SO THE USER SEES what is
// about to be irreversibly erased.
//
// The second half is the bound. All three callers derived their ids from a
// catalog query — `AttachmentsLibrary`'s `visible` is a filter plus a sort over
// the whole catalog with both filters inert at their defaults — so opening the
// library decrypted every attachment in the vault and pinned each as a `blob:`
// URL, a GC root, for the rest of the unlocked session. The invariant was
// asserted at three call sites and enforced at none, which is why the cap and
// the window now live in the hook: a fourth caller is safe by construction.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const warmAttachmentUrls = vi.fn(async (_ids: readonly string[]) => [] as readonly string[]);
let needsWarming = true;

vi.mock("../../src/platform/attachments", () => ({
  get ATTACHMENT_REFS_NEED_WARMING() {
    return needsWarming;
  },
  warmAttachmentUrls: (ids: readonly string[]) => warmAttachmentUrls(ids),
}));

import {
  MAX_WARMED_IDS,
  useWarmAttachmentRefs,
} from "../../src/components/attachments/useWarmAttachmentRefs";

/** A controllable `IntersectionObserver`, since jsdom has none. */
interface Stub {
  fire(entries: { target: Element; isIntersecting: boolean }[]): void;
  observed: Element[];
}
function installObserver(): Stub {
  const observed: Element[] = [];
  let cb: (entries: { target: Element; isIntersecting: boolean }[]) => void = () => {};
  class Fake {
    constructor(callback: typeof cb) {
      cb = callback;
    }
    observe(el: Element): void {
      observed.push(el);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Fake;
  return {
    observed,
    fire: (entries) => {
      act(() => cb(entries));
    },
  };
}

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `id${i}`);
}

beforeEach(() => {
  cleanup();
  warmAttachmentUrls.mockClear();
  warmAttachmentUrls.mockImplementation(async () => []);
  needsWarming = true;
  delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
});

describe("the warm set is bounded", () => {
  it("never asks for more than MAX_WARMED_IDS, however many it is given", async () => {
    // The cap lives in the hook, so no caller — present or future — can widen
    // it. Against the old hook the seam received all of them: the effect key was
    // the caller's array, verbatim.
    renderHook(() => useWarmAttachmentRefs(ids(MAX_WARMED_IDS + 50)));
    await waitFor(() => expect(warmAttachmentUrls).toHaveBeenCalled());
    expect(warmAttachmentUrls.mock.calls[0][0]).toHaveLength(MAX_WARMED_IDS);
  });

  it("windowed: warms only what the observer reports on screen", async () => {
    // The property all three call-site comments claimed and none held.
    const observer = installObserver();
    const { result } = renderHook(() => useWarmAttachmentRefs(ids(40), { windowed: true }));

    const elements = ids(40).map((id) => {
      const el = document.createElement("div");
      result.current.observeItem(id)(el);
      return el;
    });
    expect(observer.observed).toHaveLength(40);

    observer.fire(elements.slice(0, 6).map((target) => ({ target, isIntersecting: true })));
    await waitFor(() => expect(warmAttachmentUrls).toHaveBeenCalled());
    const asked = warmAttachmentUrls.mock.calls.at(-1)?.[0] ?? [];
    expect([...asked].sort()).toEqual(ids(6).sort());
  });

  it("windowed: falls back to the capped prefix where IntersectionObserver is absent", async () => {
    // Load-bearing, not defensive padding: without this branch the hook warms
    // nothing in jsdom AND in any browser lacking the API — blank thumbnails
    // everywhere, which is a worse failure than the one being fixed.
    renderHook(() => useWarmAttachmentRefs(ids(MAX_WARMED_IDS + 10), { windowed: true }));
    await waitFor(() => expect(warmAttachmentUrls).toHaveBeenCalled());
    expect(warmAttachmentUrls.mock.calls[0][0]).toEqual(ids(MAX_WARMED_IDS));
  });
});

describe("remounting is per id", () => {
  it("warmKey changes for the id that became warm and for no other", async () => {
    // A moving window plus a global nonce would remount the whole grid on every
    // scroll step — aborting every PDF thumbnail's render, stopping any playing
    // audio tile, and throwing away text typed into an inline rename.
    warmAttachmentUrls.mockImplementation(async () => ["a"]);
    const { result } = renderHook(() => useWarmAttachmentRefs(["a", "b"]));
    const before = { a: result.current.warmKey("a"), b: result.current.warmKey("b") };
    await waitFor(() => expect(result.current.warmKey("a")).not.toBe(before.a));
    expect(result.current.warmKey("b")).toBe(before.b);
  });

  it("an id that never warms keeps its key, so the placeholder stays put", async () => {
    warmAttachmentUrls.mockImplementation(async () => []);
    const { result } = renderHook(() => useWarmAttachmentRefs(["a"]));
    await waitFor(() => expect(warmAttachmentUrls).toHaveBeenCalled());
    expect(result.current.warmKey("a")).toBe("a");
  });
});

describe("the desktop arm", () => {
  it("warms nothing and observes nothing", async () => {
    // The old guard for this was `warmRefs === undefined` on the editor host —
    // which never fired, because `src/editor-host.ts` installs a real
    // `warmAttachmentUrls` unconditionally. The no-op was held by the seam
    // being empty, not by the guard. Now the seam says so out loud.
    needsWarming = false;
    installObserver();
    const { result } = renderHook(() => useWarmAttachmentRefs(ids(10), { windowed: true }));
    const el = document.createElement("div");
    result.current.observeItem("id0")(el);
    await new Promise((r) => setTimeout(r, 0));
    expect(warmAttachmentUrls).not.toHaveBeenCalled();
    expect(result.current.warmKey("id0")).toBe("id0");
  });
});
