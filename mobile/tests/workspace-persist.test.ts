// @vitest-environment jsdom
//
// The `vault.workspace` descriptor codec + the session/flush plumbing that
// carries mobile's sidebar folder-expand set (MYND-561).
//
// jsdom + a stubbed `__TAURI_INTERNALS__` so `HAS_TAURI` is true (the module
// short-circuits every IPC path without it, which would make the flush assertions
// vacuously pass).
//
// The codec half is where the compatibility risk sits, and it is asymmetric: a
// malformed descriptor must degrade to "restore nothing" (never throw into the
// list render), while a WRITE must never destroy container keys mobile does not
// author — desktop's pane tree lives in the same JSON object.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// `app-window` computes `HAS_TAURI` at module-eval time. A plain assignment here
// would be too late — ES imports are hoisted above it, so `app-window` would
// already have evaluated to `false` and every IPC path under test would
// short-circuit and pass vacuously. Plant the marker inside `vi.hoisted`, which
// runs before the import graph.
vi.hoisted(() => {
  (globalThis as unknown as { window?: Record<string, unknown> }).window ??= {};
  (globalThis as unknown as { window: Record<string, unknown> }).window.__TAURI_INTERNALS__ = {};
});

import {
  __resetWorkspacePersistForTest,
  ensureWorkspaceHydrated,
  flushWorkspaceNow,
  parseExpandedFolders,
  resetWorkspaceOnLock,
  withExpandedFolders,
} from "../src/lib/workspace-persist";
import {
  hydrateExpandedFolders,
  isExpandDirty,
  peekExpandedFolders,
  resetExpandedFoldersOnLock,
  toggleFolderExpanded,
} from "../src/lib/folder-expand-store";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
});

afterEach(() => {
  __resetWorkspacePersistForTest();
  resetExpandedFoldersOnLock();
});

/** The descriptor string handed to the last `workspace_write`. */
function lastWrittenDescriptor(): string {
  const calls = invokeMock.mock.calls.filter((c) => c[0] === "plugin:workspace|workspace_write");
  return String((calls[calls.length - 1]?.[1] as { descriptor?: string })?.descriptor ?? "");
}

describe("parseExpandedFolders", () => {
  it("reads the field", () => {
    expect(parseExpandedFolders(JSON.stringify({ expandedFolders: ["a/", "a/b/"] }))).toEqual([
      "a/",
      "a/b/",
    ]);
  });

  it("treats every unusable input as 'restore nothing'", () => {
    // Each of these is reachable: a cold vault, a pre-455 blob, a truncated or
    // foreign payload, a field of the wrong shape. None may throw — this runs
    // inside the note-list render path.
    for (const input of [
      null,
      "",
      "not json",
      "[1,2,3]", // top-level array
      '"a string"',
      "null",
      JSON.stringify({}), // pre-455: field absent
      JSON.stringify({ slots: [], activeId: "x" }), // desktop blob, no expand set
      JSON.stringify({ expandedFolders: "a/" }), // not an array
      JSON.stringify({ expandedFolders: ["a/", 7] }), // not all strings
      JSON.stringify({ expandedFolders: null }),
    ]) {
      expect(parseExpandedFolders(input)).toEqual([]);
    }
  });
});

describe("withExpandedFolders", () => {
  it("omits the field when the set is empty (byte-compat with pre-455 blobs)", () => {
    expect(withExpandedFolders(null, [])).toBe("{}");
    expect(JSON.parse(withExpandedFolders(JSON.stringify({ expandedFolders: ["a/"] }), []))).toEqual(
      {},
    );
  });

  it("preserves container keys mobile does not author", () => {
    // The load-bearing one: desktop's pane tree shares this JSON object, and a
    // mobile write that replaced the object would delete a desktop user's open
    // tabs. Splice, never replace.
    const desktopBlob = JSON.stringify({
      slots: [{ id: "s1", name: "Default", root: { kind: "leaf" } }],
      activeId: "s1",
    });
    const next = JSON.parse(withExpandedFolders(desktopBlob, ["a/"]));
    expect(next.slots).toEqual([{ id: "s1", name: "Default", root: { kind: "leaf" } }]);
    expect(next.activeId).toBe("s1");
    expect(next.expandedFolders).toEqual(["a/"]);
  });

  it("replaces an unparseable base rather than refusing to write", () => {
    // A blob corrupted once must not strand the user's set forever.
    expect(JSON.parse(withExpandedFolders("not json", ["a/"]))).toEqual({
      expandedFolders: ["a/"],
    });
  });

  it("round-trips through parse", () => {
    const keys = ["projects/", "projects/spikes/"];
    expect(parseExpandedFolders(withExpandedFolders(null, keys))).toEqual(keys);
  });
});

describe("ensureWorkspaceHydrated", () => {
  it("restores the set once per session; later calls are store-served", async () => {
    invokeMock.mockResolvedValue(JSON.stringify({ expandedFolders: ["projects/"] }));

    await ensureWorkspaceHydrated();
    expect([...peekExpandedFolders()]).toEqual(["projects/"]);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await ensureWorkspaceHydrated();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("a restore does not mark the set dirty (nothing to write back)", async () => {
    invokeMock.mockResolvedValue(JSON.stringify({ expandedFolders: ["projects/"] }));
    await ensureWorkspaceHydrated();
    expect(isExpandDirty()).toBe(false);

    await flushWorkspaceNow();
    expect(lastWrittenDescriptor()).toBe("");
  });

  it("a read failure leaves the sidebar collapsed instead of throwing", async () => {
    invokeMock.mockRejectedValue({ kind: "SlotNotUnlocked" });
    await expect(ensureWorkspaceHydrated()).resolves.toBeUndefined();
    expect([...peekExpandedFolders()]).toEqual([]);
  });
});

describe("flushWorkspaceNow", () => {
  it("writes the toggled set, merged onto the descriptor last seen on disk", async () => {
    invokeMock.mockResolvedValue(JSON.stringify({ slots: ["keep-me"], expandedFolders: ["a/"] }));
    await ensureWorkspaceHydrated();

    invokeMock.mockResolvedValue(null);
    toggleFolderExpanded("b/");
    await flushWorkspaceNow();

    const written = JSON.parse(lastWrittenDescriptor());
    expect(written.expandedFolders.sort()).toEqual(["a/", "b/"]);
    expect(written.slots).toEqual(["keep-me"]);
  });

  it("is a no-op when nothing was toggled — the mtime never churns", async () => {
    await ensureWorkspaceHydrated();
    await flushWorkspaceNow();
    await flushWorkspaceNow();
    expect(lastWrittenDescriptor()).toBe("");
  });

  it("clears dirty on success so a second flush does not rewrite", async () => {
    toggleFolderExpanded("a/");
    await flushWorkspaceNow();
    expect(isExpandDirty()).toBe(false);

    const writes = () =>
      invokeMock.mock.calls.filter((c) => c[0] === "plugin:workspace|workspace_write").length;
    const before = writes();
    await flushWorkspaceNow();
    expect(writes()).toBe(before);
  });

  it("keeps the set dirty when the write fails, so the next seam retries", async () => {
    toggleFolderExpanded("a/");
    invokeMock.mockRejectedValue({ kind: "Io", detail: { io_error_kind: "PermissionDenied" } });

    await expect(flushWorkspaceNow()).resolves.toBeUndefined();
    expect(isExpandDirty()).toBe(true);
  });

  it("collapsing everything persists as an omitted field, not a lost set", async () => {
    // The polarity trap that drove the reconcile to desktop's `expandedFolders`:
    // with mobile's old `collapsedFolders` model, "user collapsed everything"
    // serialized to the same omit-when-empty bytes as "nothing persisted yet", so
    // the next launch re-expanded everything. Under desktop's polarity the empty
    // set IS the collapsed state, so the omission restores faithfully.
    invokeMock.mockResolvedValue(JSON.stringify({ expandedFolders: ["a/"] }));
    await ensureWorkspaceHydrated();

    invokeMock.mockResolvedValue(null);
    toggleFolderExpanded("a/"); // collapse the only open folder
    await flushWorkspaceNow();

    const written = lastWrittenDescriptor();
    expect(JSON.parse(written).expandedFolders).toBeUndefined();
    expect(parseExpandedFolders(written)).toEqual([]);
  });
});

describe("resetWorkspaceOnLock", () => {
  it("drops the set and re-arms the session latch — vault A cannot seed vault B", async () => {
    invokeMock.mockResolvedValue(JSON.stringify({ expandedFolders: ["vault-a-folder/"] }));
    await ensureWorkspaceHydrated();
    expect([...peekExpandedFolders()]).toEqual(["vault-a-folder/"]);

    resetWorkspaceOnLock();
    expect([...peekExpandedFolders()]).toEqual([]);

    // Vault B's own read happens because the latch re-armed.
    invokeMock.mockResolvedValue(JSON.stringify({ expandedFolders: ["vault-b-folder/"] }));
    await ensureWorkspaceHydrated();
    expect([...peekExpandedFolders()]).toEqual(["vault-b-folder/"]);
  });

  it("a flush after lock cannot write the previous vault's set", async () => {
    toggleFolderExpanded("vault-a-folder/");
    resetWorkspaceOnLock();

    await flushWorkspaceNow();
    expect(lastWrittenDescriptor()).toBe("");
  });
});

describe("folder-expand store", () => {
  it("toggles membership and marks dirty", () => {
    expect(isExpandDirty()).toBe(false);
    toggleFolderExpanded("a/");
    expect(peekExpandedFolders().has("a/")).toBe(true);
    expect(isExpandDirty()).toBe(true);
    toggleFolderExpanded("a/");
    expect(peekExpandedFolders().has("a/")).toBe(false);
  });

  it("replaces the set reference rather than mutating in place", () => {
    // `useSyncExternalStore` compares snapshots by identity — an in-place mutation
    // would leave the tree stale after a toggle.
    const before = peekExpandedFolders();
    toggleFolderExpanded("a/");
    expect(peekExpandedFolders()).not.toBe(before);
  });

  it("hydration clears dirty", () => {
    toggleFolderExpanded("a/");
    hydrateExpandedFolders(["b/"]);
    expect(isExpandDirty()).toBe(false);
    expect([...peekExpandedFolders()]).toEqual(["b/"]);
  });
});
