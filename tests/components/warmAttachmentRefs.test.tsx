// @vitest-environment jsdom
//
// Every thumbnail surface warms the ids it renders (#263).
//
// On the web client an `AttachmentThumbnail` renders from a blob URL the host
// has already minted — it does not fetch. Only `AttachmentsLibrary` warmed, so
// the other two surfaces painted blank boxes: the cover picker, where the
// filename is a `title` tooltip and nothing else, so the user picked blind; and
// the clean-unused dialog, where the thumbnails exist SO THE USER SEES what is
// about to be irreversibly erased.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

const warmRefs = vi.fn(async () => {});
let hasWarm = true;

vi.mock("@myne/editor/host", () => ({
  getHost: () => ({
    attachments: { warmRefs: hasWarm ? warmRefs : undefined },
  }),
}));

import { useWarmAttachmentRefs } from "../../src/components/attachments/useWarmAttachmentRefs";

beforeEach(() => {
  cleanup();
  warmRefs.mockClear();
  hasWarm = true;
});

describe("useWarmAttachmentRefs", () => {
  it("warms exactly the ids it was given", async () => {
    renderHook(() => useWarmAttachmentRefs(["a", "b"]));
    await waitFor(() => expect(warmRefs).toHaveBeenCalledWith(["a", "b"]));
  });

  it("bumps the nonce once the ids are ready", async () => {
    // The tiles rendered against the pre-warm answers, so they have to be told
    // to ask again — that is the whole reason the hook returns a value.
    const { result } = renderHook(() => useWarmAttachmentRefs(["a"]));
    const before = result.current;
    await waitFor(() => expect(result.current).not.toBe(before));
  });

  it("does nothing for an empty set", async () => {
    renderHook(() => useWarmAttachmentRefs([]));
    await waitFor(() => expect(warmRefs).not.toHaveBeenCalled());
  });

  it("is a no-op where the host has no warmRefs (desktop)", async () => {
    // Desktop thumbnails fetch their own bytes, so there is nothing to prepare
    // and the hook must not invent work.
    hasWarm = false;
    const { result } = renderHook(() => useWarmAttachmentRefs(["a"]));
    await waitFor(() => expect(warmRefs).not.toHaveBeenCalled());
    expect(result.current).toBe(0);
  });

  it("does not re-warm when the caller re-maps the same ids", async () => {
    // Every call site passes a freshly-mapped array each render; keying the
    // effect on the array identity would warm on every render forever.
    const { rerender } = renderHook(({ ids }) => useWarmAttachmentRefs(ids), {
      initialProps: { ids: ["a", "b"] },
    });
    await waitFor(() => expect(warmRefs).toHaveBeenCalledTimes(1));
    rerender({ ids: ["a", "b"] });
    await waitFor(() => expect(warmRefs).toHaveBeenCalledTimes(1));
  });
});
