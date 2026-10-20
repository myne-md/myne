// @vitest-environment jsdom
//
// The mobile awareness consumer (`mobile/src/lib/awareness.ts`, myne-md/myne#849
// task 5). This is the mobile twin of the desktop pane's awareness effect
// (`src/notes/components/PaneView.tsx`), and what it covers is the wiring the two
// clients must agree on and that nothing else in this suite reaches:
//
//   1. the supervisor's presence frames land in the SHARED store (not a copy);
//   2. the editor's push is bound to the note on screen, so a peer on another note
//      renders nothing rather than a caret on this one;
//   3. a stream drop clears only after the grace window, so a reconnect does not
//      flicker every caret away;
//   4. the client fabricates no peer of its own. The self-echo filter is in Rust
//      (`AwarenessRoute::SelfEcho`, pinned by
//      `core/src/plugins/live/awareness_test.rs::a_devices_own_presence_frame_is_dropped_as_self_echo`),
//      so what is asserted here is the client-side half of the same claim: the push
//      contains exactly what the store holds for that note and nothing more.
//
// What this file CANNOT reach, stated rather than implied: no simulator and no
// second device, so "a real peer's caret renders on the phone" is a manual item and
// not a claim of this suite.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real module is spread rather than replaced: `@myne/i18n` initializes i18next
// with `initReactI18next` at import time, and a wholesale mock leaves that undefined
// so the suite fails to load. `i18n` is provided because the hook reads
// `i18n.language` as a dependency (a language switch must re-render an already
// listed peer).
vi.mock("react-i18next", async (importOriginal) => {
  const real = await importOriginal<typeof import("react-i18next")>();
  return {
    ...real,
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  };
});

// The event seam, replaced by a registry so a test fires a frame itself. The
// handlers live in a `vi.hoisted` block because `vi.mock` is hoisted above the
// imports: a plain module-scope map would be in its temporal dead zone when the
// factory runs.
const seam = vi.hoisted(() => {
  type Payload = unknown;
  type Handler = (event: { payload: Payload }) => void;
  const handlers = new Map<string, Set<Handler>>();
  return {
    handlers,
    fire(event: string, payload: Payload) {
      for (const handler of handlers.get(event) ?? []) {
        handler({ payload });
      }
    },
    handlerCount(event: string) {
      return handlers.get(event)?.size ?? 0;
    },
  };
});

vi.mock("../src/platform/event", () => ({
  listen: (event: string, handler: (e: { payload: unknown }) => void) => {
    const set = seam.handlers.get(event) ?? new Set();
    set.add(handler);
    seam.handlers.set(event, set);
    return Promise.resolve(() => {
      set.delete(handler);
    });
  },
}));

import {
  AWARENESS_GRACE_MS,
  awarenessNotePeers,
  clearAwareness,
  getAwarenessSnapshot,
} from "@myne/awareness-store";
import { installAwarenessChannel, useAwarenessChannel, useAwarenessForNote } from "../src/lib/awareness";

/** One presence frame as the supervisor emits it. */
function frame(noteId: string, actorId: string, cursor: number) {
  return {
    noteId,
    actorId,
    label: null,
    cursor,
    selection: null,
    frameType: "presence" as const,
  };
}

/** Let the two `listen(...).then(...)` registrations in the channel land. */
async function settleChannel(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Mount the channel plus a push for `noteId`, with the channel registered. */
async function mountFor(noteId: string | null) {
  const rendered = renderHook(() => {
    useAwarenessChannel();
    return useAwarenessForNote(noteId);
  });
  await settleChannel();
  return rendered;
}

beforeEach(() => {
  seam.handlers.clear();
  clearAwareness();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the store is fed from the supervisor's frames", () => {
  it("writes a frame into the SHARED store, not a private copy", async () => {
    await mountFor("note-a");
    act(() => seam.fire("sync://awareness", frame("note-a", "actor-1", 4)));

    // The shared store, read through its own accessor: a consumer holding a copy
    // would leave this empty while its own push looked right.
    const peers = awarenessNotePeers(getAwarenessSnapshot(), "note-a");
    expect([...peers.keys()]).toEqual(["actor-1"]);
  });

  it("projects the peers of the OPEN note into the editor's push", async () => {
    const { result } = await mountFor("note-a");
    act(() => seam.fire("sync://awareness", frame("note-a", "actor-1", 4)));

    expect(result.current?.noteId).toBe("note-a");
    expect(result.current?.peers).toHaveLength(1);
    expect(result.current?.peers[0].caret).toBe(4);
  });

  it("carries no peer of its own for a frame it never received", async () => {
    const { result } = await mountFor("note-a");
    // A frame from the frame codec always names an actor. Asserting the push is
    // empty before one arrives is the client-side half of "no cursor for our own
    // echoed frame": nothing here invents a local participant, so the only way one
    // can appear is a frame that passed the Rust self-echo filter.
    expect(result.current?.peers).toEqual([]);
    act(() => seam.fire("sync://awareness", frame("note-a", "actor-1", 4)));
    expect(result.current?.peers.map((p) => p.id)).toEqual(["actor-1"]);
  });
});

describe("a peer on another note renders nothing", () => {
  it("omits a peer whose frame named a different note", async () => {
    const { result } = await mountFor("note-a");
    act(() => seam.fire("sync://awareness", frame("note-b", "actor-1", 4)));

    expect(result.current?.peers).toEqual([]);
    // ...and the store still holds it for the note that OWNS it, which is what
    // makes this per-note keying rather than a dropped frame.
    expect([...awarenessNotePeers(getAwarenessSnapshot(), "note-b").keys()]).toEqual(["actor-1"]);
  });

  it("returns undefined with no note on screen, which the editor reads as 'push nothing'", async () => {
    const { result } = await mountFor(null);
    act(() => seam.fire("sync://awareness", frame("note-a", "actor-1", 4)));
    expect(result.current).toBeUndefined();
  });
});

describe("the stream drop holds for the grace window", () => {
  it("keeps the peers inside the window and clears them after it", async () => {
    vi.useFakeTimers();
    const { result } = await mountFor("note-a");
    act(() => seam.fire("sync://awareness", frame("note-a", "actor-1", 4)));
    expect(result.current?.peers).toHaveLength(1);

    act(() => seam.fire("sync://awareness-dropped", undefined));
    // Inside the window: a reconnect must not flicker every caret away.
    expect(result.current?.peers).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(AWARENESS_GRACE_MS);
    });
    expect(result.current?.peers).toHaveLength(0);
  });

  it("cancels the window when a frame arrives during it", async () => {
    vi.useFakeTimers();
    const { result } = await mountFor("note-a");
    act(() => seam.fire("sync://awareness-dropped", undefined));
    act(() => seam.fire("sync://awareness", frame("note-a", "actor-1", 4)));
    act(() => {
      vi.advanceTimersByTime(AWARENESS_GRACE_MS);
    });
    // The store cleared `droppedAt` on the upsert, so the sweep has nothing to act
    // on and the peer survives.
    expect(result.current?.peers).toHaveLength(1);
  });
});

describe("the channel's lifetime", () => {
  it("unlistens both events when the installer's disposer runs", async () => {
    const dispose = installAwarenessChannel();
    await settleChannel();
    expect(seam.handlerCount("sync://awareness")).toBe(1);
    expect(seam.handlerCount("sync://awareness-dropped")).toBe(1);

    dispose();
    expect(seam.handlerCount("sync://awareness")).toBe(0);
    expect(seam.handlerCount("sync://awareness-dropped")).toBe(0);
  });

  it("stops writing into the store once disposed, which unmount alone does not do", async () => {
    const dispose = installAwarenessChannel();
    await settleChannel();
    dispose();
    act(() => seam.fire("sync://awareness", frame("note-a", "actor-1", 4)));
    expect(awarenessNotePeers(getAwarenessSnapshot(), "note-a").size).toBe(0);
  });
});
