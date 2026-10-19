// The MYI1 fast path is an ORDERING contract, and this is where it is pinned.
//
// `EditorFlow`'s delta sweep assumes it starts from an empty tracker and sends
// the whole corpus. Hydration exists to stop that: the host loads the persisted
// unchanged records, this module seeds the tracker with exactly those, and the
// sweep is left holding only the stale ids. Two failures are easy to write and
// invisible in a running app: seeding nothing (the fast path costs a full
// rebuild, which is the bug the blob exists to avoid) and seeding everything
// including the stale ids (those notes never get re-applied, so the index stays
// stale for the session). Both directions are asserted below, plus the
// negative: a hydrate that reports nothing stale must not make a later edit
// unreachable.
//
// The write half is tested for the cadence the spec pins (`protocol.md`
// §9.8.5: the exit seams, never the edit) and for the property a caller-side
// flush alone does not give: two writes never overlap, because persist
// snapshots the store at call time and overlapping calls can land out of order
// and leave the older snapshot on disk.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { createIndexDeltaTracker, type DeltaItem } from "../src/lib/index-delta";
import {
  __resetVaultIndicesLifecycleForTest,
  flushVaultIndicesPersistNow,
  hydrateVaultIndicesOnce,
  noteVaultIndicesChanged,
  resetVaultIndicesLifecycle,
  seedIndexTrackerFromHydration,
  setVaultIndicesExitSeamLeveller,
} from "../src/lib/vault-indices-lifecycle";

const HYDRATE = "plugin:vault-indices|vault_indices_hydrate";
const PERSIST = "plugin:vault-indices|vault_indices_persist";

function item(id: string, body: string): DeltaItem {
  return { id, title: `Title ${id}`, folder: null, body };
}

function callsTo(command: string): number {
  return invokeMock.mock.calls.filter((c) => c[0] === command).length;
}

beforeEach(() => {
  invokeMock.mockReset();
  __resetVaultIndicesLifecycleForTest();
});

afterEach(() => {
  __resetVaultIndicesLifecycleForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("hydrate → seed → sweep ordering", () => {
  it("leaves exactly the stale ids for the sweep to re-apply", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === HYDRATE ? ["n2"] : undefined,
    );
    const corpus = [item("n1", "a"), item("n2", "b"), item("n3", "c")];
    const tracker = createIndexDeltaTracker();

    const stale = await hydrateVaultIndicesOnce();
    expect(invokeMock).toHaveBeenCalledWith(HYDRATE);
    expect(stale).toEqual(["n2"]);

    seedIndexTrackerFromHydration(tracker, corpus, stale ?? []);
    const diff = tracker.diff(corpus);
    expect(diff.changed.map((n) => n.id)).toEqual(["n2"]);
    expect(diff.removed).toEqual([]);
  });

  it("reports every note when hydrate fails, so the sweep rebuilds in full", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === HYDRATE) throw new Error("slot locked");
      return undefined;
    });
    const corpus = [item("n1", "a"), item("n2", "b")];
    const tracker = createIndexDeltaTracker();

    // `null` is the command-level failure signal: do not seed at all.
    expect(await hydrateVaultIndicesOnce()).toBeNull();
    expect(tracker.diff(corpus).changed.map((n) => n.id)).toEqual(["n1", "n2"]);
  });

  it("shares one hydrate between concurrent callers (StrictMode double-invoke)", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === HYDRATE ? [] : undefined,
    );
    const [a, b] = await Promise.all([
      hydrateVaultIndicesOnce(),
      hydrateVaultIndicesOnce(),
    ]);
    expect(a).toEqual([]);
    expect(b).toEqual([]);
    expect(callsTo(HYDRATE)).toBe(1);
  });

  it("a hydrate reporting NOTHING stale still lets the sweep apply a changed note", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === HYDRATE ? [] : undefined,
    );
    const corpus = [item("n1", "a"), item("n2", "b")];
    const tracker = createIndexDeltaTracker();

    const stale = await hydrateVaultIndicesOnce();
    seedIndexTrackerFromHydration(tracker, corpus, stale ?? []);
    // Nothing stale → nothing to send on the first pass.
    expect(tracker.diff(corpus).changed).toEqual([]);

    // ...but an edit after hydration is still reported. A seed that marked
    // everything unconditionally would make the note unreachable forever.
    const edited = [corpus[0], item("n2", "b edited")];
    expect(tracker.diff(edited).changed.map((n) => n.id)).toEqual(["n2"]);
  });

  it("re-arms the hydrate latch after a lock reset", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === HYDRATE ? ["n1"] : undefined,
    );
    await hydrateVaultIndicesOnce();
    resetVaultIndicesLifecycle();
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === HYDRATE ? [] : undefined,
    );
    expect(await hydrateVaultIndicesOnce()).toEqual([]);
    expect(callsTo(HYDRATE)).toBe(2);
  });
});

describe("persist cadence and ordering", () => {
  it("an edit alone writes nothing: the cadence is the exit seam", async () => {
    vi.useFakeTimers();
    invokeMock.mockResolvedValue(undefined);
    noteVaultIndicesChanged();
    // Long enough for any plausible settle timer: a write that merely needs a
    // tick would still be pending at 0 ms, so the wait has to outrun a timer
    // the module must not have (protocol.md §9.8.5).
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callsTo(PERSIST)).toBe(0);

    await flushVaultIndicesPersistNow();
    expect(callsTo(PERSIST)).toBe(1);
  });

  it("levels the store before writing, and writes nothing when the pass fails", async () => {
    invokeMock.mockResolvedValue(undefined);
    const order: string[] = [];
    setVaultIndicesExitSeamLeveller(async () => {
      order.push("level");
      noteVaultIndicesChanged();
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === PERSIST) order.push("persist");
      return undefined;
    });
    try {
      await flushVaultIndicesPersistNow();
      expect(order).toEqual(["level", "persist"]);

      // The pass that could not level the store must not write it: a lagging
      // record under a fresh nonce is invisible to the next hydrate.
      order.length = 0;
      noteVaultIndicesChanged();
      setVaultIndicesExitSeamLeveller(async () => {
        throw new Error("apply failed");
      });
      await flushVaultIndicesPersistNow();
      expect(order).toEqual([]);
    } finally {
      setVaultIndicesExitSeamLeveller(null);
    }
  });

  it("flush with nothing dirty writes nothing (an idle backgrounding)", async () => {
    invokeMock.mockResolvedValue(undefined);
    await flushVaultIndicesPersistNow();
    expect(callsTo(PERSIST)).toBe(0);
  });

  it("serializes a write that races a newer apply, and writes again", async () => {
    let release: (() => void) | null = null;
    let concurrent = 0;
    let maxConcurrent = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd !== PERSIST) return Promise.resolve(undefined);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return new Promise<void>((resolve) => {
        release = () => {
          concurrent -= 1;
          resolve();
        };
      });
    });

    noteVaultIndicesChanged();
    const first = flushVaultIndicesPersistNow();
    expect(callsTo(PERSIST)).toBe(1);

    // A newer apply lands while the first snapshot is being written, and the
    // flush that carries it waits for the one in flight.
    noteVaultIndicesChanged();
    const second = flushVaultIndicesPersistNow();
    expect(callsTo(PERSIST)).toBe(1); // still one: the first has not settled

    release!();
    await first;
    // Let the queued flush observe the settled write and issue its own.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(callsTo(PERSIST)).toBe(2);
    expect(maxConcurrent).toBe(1);

    release!();
    await second;
    expect(concurrent).toBe(0);
  });

  it("reset drops the dirty flag (the idle auto-lock path)", async () => {
    invokeMock.mockResolvedValue(undefined);
    noteVaultIndicesChanged();
    resetVaultIndicesLifecycle();
    await flushVaultIndicesPersistNow();
    expect(callsTo(PERSIST)).toBe(0);
  });

  it("a failed write warns once and never rejects (best-effort cache)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeMock.mockRejectedValue(new Error("PersistIo"));

    noteVaultIndicesChanged();
    await flushVaultIndicesPersistNow();
    noteVaultIndicesChanged();
    await flushVaultIndicesPersistNow();

    expect(callsTo(PERSIST)).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    // The background seam awaits the flush; a refusal must not surface as an
    // unhandled rejection there.
    await expect(flushVaultIndicesPersistNow()).resolves.toBeUndefined();
  });
});
