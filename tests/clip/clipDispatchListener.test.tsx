// @vitest-environment jsdom
//
// The clip dispatch listener's TWO capture kinds, end to end through the real
// assembly routine (myne-md/myne#936).
//
// WHAT THIS PINS. The listener is the only place a capture kind chooses a
// composer, and the only place the wire payload becomes a sealed note. That is
// exactly where the defect lived: the bookmark branch supplied the page title and
// the content-clip branch did not, so every article clip landed as "Untitled"
// while bookmarks were fine, and NOTHING covered the branch, in any lane. Both
// composers had passing unit tests; the gap was the wiring between them and the
// event.
//
// The mocked seams are the two platform ones (`listen`, `invoke`) plus the IPC
// answers the routine reads; `assembleClip` itself runs for real, so the chain
// asserted here (payload → title extraction → composer → the bytes handed to
// `note_create`) is the production chain.
//
// The second property matters as much as the first: the bookmark shape must NOT
// start emitting a `url:` key. It is a different note shape on purpose (SYNC-16),
// and a fix that made both kinds identical would be a spec change wearing a bug
// fix's clothes.

import { describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach } from "vitest";

/** Captured `listen(event, handler)` subscriptions, keyed by event name. */
const handlers = new Map<string, Array<(event: { payload: unknown }) => void>>();

vi.mock("../../src/platform/event", () => ({
  listen: async (event: string, fn: (e: { payload: unknown }) => void) => {
    const list = handlers.get(event) ?? [];
    list.push(fn);
    handlers.set(event, list);
    return () => {
      const cur = handlers.get(event) ?? [];
      handlers.set(
        event,
        cur.filter((f) => f !== fn),
      );
    };
  },
}));

/** Sealed plaintexts, in call order, and the outcome strings posted back. */
const sealed: string[] = [];
const replies: string[] = [];

vi.mock("../../src/platform/core", () => ({
  invoke: async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "plugin:vault-unlock|vault_is_unlocked":
        return true;
      case "plugin:notes|note_list":
        return [];
      case "plugin:notes|note_titles_batch":
        return [];
      case "plugin:notes|note_create":
        sealed.push(String(args?.["plaintext"] ?? ""));
        return "01910000-0000-7000-8000-000000000001";
      case "plugin:clipper-pairing|clip_dispatch_complete":
        replies.push(String(args?.["outcome"] ?? ""));
        return undefined;
      default:
        throw new Error(`unexpected invoke: ${command}`);
    }
  },
}));

import { ClipDispatchListener } from "../../src/clip/ClipDispatchListener";

/** Emit a `clipper://dispatch` payload and wait for it to be handled. */
async function dispatch(payload: Record<string, unknown>): Promise<void> {
  let listeners: Array<(event: { payload: unknown }) => void> = [];
  await waitFor(() => {
    listeners = handlers.get("clipper://dispatch") ?? [];
    expect(listeners.length).toBeGreaterThan(0);
  });
  const before = replies.length;
  for (const listener of listeners) listener({ payload });
  await waitFor(() => expect(replies.length).toBe(before + 1));
}

function renderListener(): void {
  render(<ClipDispatchListener />);
}

afterEach(() => {
  cleanup();
  handlers.clear();
  sealed.length = 0;
  replies.length = 0;
});

describe("ClipDispatchListener: a clip is NAMED (myne-md/myne#936)", () => {
  it("gives a full-article clip the page title as its managed `title:`", async () => {
    renderListener();
    await dispatch({
      requestId: "r-1",
      captureKind: "full-article",
      // The extension's body shape: the page title as the leading heading, then
      // the captured article.
      markdownBody: "# A Real Page Title\n\nThe article body.\n",
      sourceUrl: "https://example.com/article",
      clipDate: "2026-06-18T12:00:00Z",
      imageBytes: [],
    });

    expect(sealed).toHaveLength(1);
    expect(sealed[0]).toMatch(/^title: A Real Page Title$/m);
    // The clip shape still carries BOTH provenance URL keys (SYNC-14).
    expect(sealed[0]).toMatch(/^source: https:\/\/example\.com\/article$/m);
    expect(sealed[0]).toMatch(/^url: https:\/\/example\.com\/article$/m);
    expect(replies).toEqual(["accepted"]);
  });

  it("gives a selection clip the page title too", async () => {
    renderListener();
    await dispatch({
      requestId: "r-2",
      captureKind: "selection",
      markdownBody: "# Quoted Page\n\nThe selected passage.\n",
      sourceUrl: "https://example.com/quoted",
      clipDate: "2026-06-18T12:00:00Z",
      imageBytes: [],
    });

    expect(sealed[0]).toMatch(/^title: Quoted Page$/m);
    expect(sealed[0]).toContain("# Quoted Page"); // body untouched
    expect(sealed[0]).toContain("The selected passage.");
  });

  it("keeps the bookmark shape byte-identical: named, no `url:` key", async () => {
    // The bookmark is a DIFFERENT note shape (SYNC-16). The fix must not collapse
    // the two: a bookmark carries `title:` + `source:` + `clipped:` and never
    // `url:`, and its body is the bare-autolink URL with no heading of its own.
    renderListener();
    await dispatch({
      requestId: "r-3",
      captureKind: "bookmark",
      markdownBody: "# Example Page\n\nhttps://example.com/page\n",
      sourceUrl: "https://example.com/page",
      clipDate: "2026-06-18T12:00:00Z",
      imageBytes: [],
    });

    expect(sealed).toHaveLength(1);
    expect(sealed[0]).toMatch(/^title: Example Page$/m);
    expect(sealed[0]).toMatch(/^source: https:\/\/example\.com\/page$/m);
    expect(sealed[0]).not.toMatch(/^url\s*:/m);
    const afterFm = sealed[0].replace(/^---\n[\s\S]*?\n---\n\n?/, "");
    expect(afterFm.trim()).toBe("https://example.com/page");
  });

  it("leaves a clip with no page title on the untitled placeholder", async () => {
    renderListener();
    await dispatch({
      requestId: "r-4",
      captureKind: "full-article",
      markdownBody: "Just the captured text, no heading.\n",
      sourceUrl: "https://example.com/untitled",
      clipDate: "2026-06-18T12:00:00Z",
      imageBytes: [],
    });

    // `title: ""` is what every new note carries (myne#653) and it reads as
    // untitled at the read boundary. Not a borrowed heading, not a page URL.
    expect(sealed[0]).toMatch(/^title: ""$/m);
    expect(sealed[0]).not.toMatch(/^title: https?:/m);
  });
});
