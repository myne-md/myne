// @vitest-environment jsdom
//
// Component tests for `src/notes/components/AiHydrationProbe.tsx`
// (myne-md/myne#529, on top of MYND-453): the probe has to survive the UNMOUNT a
// vault lock causes, because every hydrate it exists to report happens across
// one.
//
// **Both properties here were broken, and neither was visible to anything.** The
// probe held its subscription and its sequence counter in `useState` inside a
// component that only exists while a vault is unlocked, so:
//
//   1. an `ai://vectors-hydrated` emitted between the unlock resolving and the
//      remounted probe's async `listen()` landing was dropped (Tauri's `emit`
//      has no replay), and
//   2. the sequence counter restarted at zero on every remount, so the harness's
//      "wait for a seq strictly greater than the one I read before the lock"
//      could never be satisfied after the first observed event.
//
// `tsc`, `clippy` and every guard in `scripts/` are green either way; the only
// report was a 30 s E2E timeout that reads as a hung backend. So these two cases
// are written as the exact injected defect: unmount, emit, remount.
//
// The event seam is stubbed the way `syncBanners.test.tsx` does it — the point
// is the subscribe/unsubscribe LIFECYCLE, and a stub that keeps handlers in a
// map is what makes a leaked or missing subscription observable.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

/** Captured `listen(event, handler)` subscriptions, keyed by event name. */
const handlers = new Map<string, Array<(e: { payload: unknown }) => void>>();

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

import {
  AiHydrationProbe,
  __resetAiHydrationProbeForTests,
} from "../../src/notes/components/AiHydrationProbe";

const EVENT = "ai://vectors-hydrated";

/** Deliver one backend event to every live subscriber, and let React flush. */
async function emit(payload: {
  embedded: number;
  loaded_from_blob: boolean;
  reembedded: number;
}): Promise<void> {
  await act(async () => {
    for (const fn of handlers.get(EVENT) ?? []) fn({ payload });
  });
}

/** Render, then let the lazy `listen()` promise resolve before anything emits.
 *  Without this the first emit in a test would race the subscription for a
 *  reason that has nothing to do with the property under test. */
async function mountProbe() {
  const view = render(<AiHydrationProbe />);
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

function readProbe(): { seq: string | null; loadedFromBlob: string | null } {
  const el = screen.getByTestId("ai.hydration-probe");
  return {
    seq: el.getAttribute("data-seq"),
    loadedFromBlob: el.getAttribute("data-loaded-from-blob"),
  };
}

beforeEach(() => {
  handlers.clear();
  __resetAiHydrationProbeForTests();
});

afterEach(() => {
  cleanup();
});

describe("AiHydrationProbe", () => {
  it("renders nothing until a hydrate event arrives", async () => {
    await mountProbe();
    expect(screen.queryByTestId("ai.hydration-probe")).toBeNull();
  });

  it("reflects a hydrate event's counters", async () => {
    await mountProbe();
    await emit({ embedded: 3, loaded_from_blob: true, reembedded: 0 });
    const el = screen.getByTestId("ai.hydration-probe");
    expect(el.getAttribute("data-embedded")).toBe("3");
    expect(el.getAttribute("data-loaded-from-blob")).toBe("true");
    expect(el.getAttribute("data-reembedded")).toBe("0");
  });

  it("still hears an event emitted while the editor was unmounted", async () => {
    // Defect 1, injected exactly: lock (unmount) → the detached backend walk
    // finishes and emits → re-unlock (remount). Before the module-scope
    // subscription the handler was gone for the whole middle step, so the event
    // was lost and the remounted probe rendered nothing, forever.
    const first = await mountProbe();
    first.unmount();

    await emit({ embedded: 1, loaded_from_blob: false, reembedded: 1 });

    await mountProbe();
    expect(readProbe()).toEqual({ seq: "1", loadedFromBlob: "false" });
  });

  it("keeps the sequence monotonic across an unmount/remount cycle", async () => {
    // Defect 2, injected exactly. The harness reads `data-seq` BEFORE the lock
    // and waits for a strictly greater one after the re-unlock; a per-component
    // counter restarted at zero, so the second leg re-reported the same `1` and
    // could never satisfy `> 1`.
    const first = await mountProbe();
    await emit({ embedded: 1, loaded_from_blob: false, reembedded: 1 });
    const before = Number(readProbe().seq);
    expect(before).toBe(1);
    first.unmount();

    await mountProbe();
    await emit({ embedded: 1, loaded_from_blob: true, reembedded: 0 });
    const after = Number(readProbe().seq);

    expect(
      after,
      "data-seq must keep counting across the unmount a vault lock causes, or " +
        "the E2E wait for the NEXT hydrate can never be satisfied",
    ).toBeGreaterThan(before);
    expect(readProbe().loadedFromBlob).toBe("true");
  });

  it("subscribes once no matter how many times the editor remounts", async () => {
    // The flip side of never unsubscribing: a fresh `listen()` per mount would
    // leave one handler per lock cycle alive, and each would bump the counter,
    // so `seq` would jump by the number of past mounts per event. That breaks
    // nothing visibly and would make the monotonic assertion above pass for the
    // wrong reason.
    const a = await mountProbe();
    a.unmount();
    const b = await mountProbe();
    b.unmount();
    await mountProbe();

    expect(handlers.get(EVENT)?.length ?? 0).toBe(1);

    await emit({ embedded: 2, loaded_from_blob: true, reembedded: 0 });
    expect(readProbe().seq).toBe("1");
  });
});
