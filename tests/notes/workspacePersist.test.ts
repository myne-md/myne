// Serialize/deserialize + validation tests for the workspace descriptor
// (MYND-166, Task 13). The deserializer is the trust boundary for a
// tampered-but-AEAD-OK or schema-drifted blob — it must reject anything
// malformed so the editor falls back to a clean single empty pane.

import { describe, expect, it } from "vitest";
import {
  deserializeWorkspace,
  deserializeWorkspaces,
  serializeWorkspace,
  serializeWorkspaces,
} from "../../src/lib/workspace-persist";
import {
  createSlot,
  emptyNamedWorkspaces,
  emptyWorkspace,
  graphItem,
  noteItem,
  openInNewTab,
  openToSide,
  setActiveSlotState,
  setItemViewMode,
  setPinned,
  setStacked,
  viewItem,
  type WorkspaceState,
} from "../../src/notes/workspaceState";

function sampleSplit(): WorkspaceState {
  let ws = emptyWorkspace("p-root");
  ws = openInNewTab(ws, noteItem("a"));
  ws = openInNewTab(ws, noteItem("b"));
  ws = openToSide(ws, noteItem("c"), (() => {
    let n = 0;
    return () => `p-side-${++n}`;
  })());
  return ws;
}

describe("workspace descriptor (de)serialization", () => {
  it("round-trips a split workspace", () => {
    const ws = sampleSplit();
    const restored = deserializeWorkspace(serializeWorkspace(ws));
    expect(restored).toEqual(ws);
  });

  it("round-trips a single empty pane", () => {
    const ws = emptyWorkspace("only");
    expect(deserializeWorkspace(serializeWorkspace(ws))).toEqual(ws);
  });

  it("rejects non-JSON", () => {
    expect(deserializeWorkspace("not json{")).toBeNull();
  });

  it("rejects a missing focusedPaneId", () => {
    expect(
      deserializeWorkspace(
        JSON.stringify({ root: { kind: "leaf", id: "p", tabs: [], activeTab: null } }),
      ),
    ).toBeNull();
  });

  it("rejects a focusedPaneId that isn't a leaf in the tree", () => {
    expect(
      deserializeWorkspace(
        JSON.stringify({
          root: { kind: "leaf", id: "p", tabs: [], activeTab: null },
          focusedPaneId: "ghost",
        }),
      ),
    ).toBeNull();
  });

  it("rejects a duplicate note across panes", () => {
    const bad = JSON.stringify({
      root: {
        kind: "split",
        id: "s",
        direction: "row",
        children: [
          { kind: "leaf", id: "p1", tabs: ["dup"], activeTab: "dup" },
          { kind: "leaf", id: "p2", tabs: ["dup"], activeTab: "dup" },
        ],
      },
      focusedPaneId: "p1",
    });
    expect(deserializeWorkspace(bad)).toBeNull();
  });

  it("rejects an activeTab not present in the leaf's tabs", () => {
    expect(
      deserializeWorkspace(
        JSON.stringify({
          root: { kind: "leaf", id: "p", tabs: ["a"], activeTab: "b" },
          focusedPaneId: "p",
        }),
      ),
    ).toBeNull();
  });

  it("rejects an unknown node kind", () => {
    expect(
      deserializeWorkspace(
        JSON.stringify({
          root: { kind: "frame", id: "p" },
          focusedPaneId: "p",
        }),
      ),
    ).toBeNull();
  });

  it("rejects a split with fewer than two children", () => {
    expect(
      deserializeWorkspace(
        JSON.stringify({
          root: {
            kind: "split",
            id: "s",
            direction: "row",
            children: [{ kind: "leaf", id: "p1", tabs: [], activeTab: null }],
          },
          focusedPaneId: "p1",
        }),
      ),
    ).toBeNull();
  });

  // ── MYND-274: heterogeneous note|view tabs + forward-compat tolerance ──

  it("round-trips a mixed note + view workspace", () => {
    let ws = emptyWorkspace("p");
    ws = openInNewTab(ws, noteItem("a"));
    ws = openInNewTab(ws, viewItem("books"));
    const restored = deserializeWorkspace(serializeWorkspace(ws));
    expect(restored).toEqual(ws);
  });

  it("migrates a legacy bare-string tab to a note item", () => {
    // Pre-MYND-274 descriptors stored tabs as bare note-id strings.
    const restored = deserializeWorkspace(
      JSON.stringify({
        root: { kind: "leaf", id: "p", tabs: ["a", "b"], activeTab: "a" },
        focusedPaneId: "p",
      }),
    );
    expect(restored).not.toBeNull();
    const leaf = restored!.root;
    if (leaf.kind === "leaf") {
      expect(leaf.tabs).toEqual([noteItem("a"), noteItem("b")]);
      expect(leaf.activeTab).toEqual(noteItem("a"));
    } else {
      throw new Error("expected a leaf root");
    }
  });

  it("drops a well-formed unknown-kind tab (forward-compat), keeping the rest", () => {
    const restored = deserializeWorkspace(
      JSON.stringify({
        root: {
          kind: "leaf",
          id: "p",
          tabs: [
            { kind: "note", id: "a" },
            { kind: "kanban", id: "future" }, // a future kind this client can't show
            { kind: "view", id: "v1" },
          ],
          activeTab: { kind: "note", id: "a" },
        },
        focusedPaneId: "p",
      }),
    );
    expect(restored).not.toBeNull();
    if (restored!.root.kind === "leaf") {
      expect(restored!.root.tabs).toEqual([noteItem("a"), viewItem("v1")]);
    } else {
      throw new Error("expected a leaf root");
    }
  });

  it("falls back to the first tab when the active tab was a dropped unknown kind", () => {
    const restored = deserializeWorkspace(
      JSON.stringify({
        root: {
          kind: "leaf",
          id: "p",
          tabs: [
            { kind: "kanban", id: "future" },
            { kind: "note", id: "a" },
          ],
          activeTab: { kind: "kanban", id: "future" }, // dropped
        },
        focusedPaneId: "p",
      }),
    );
    expect(restored).not.toBeNull();
    if (restored!.root.kind === "leaf") {
      expect(restored!.root.tabs).toEqual([noteItem("a")]);
      expect(restored!.root.activeTab).toEqual(noteItem("a"));
    } else {
      throw new Error("expected a leaf root");
    }
  });

  it("round-trips a graph tab (MYND-198 — a known kind, not dropped)", () => {
    let ws = emptyWorkspace("p");
    ws = openInNewTab(ws, noteItem("a"));
    ws = openInNewTab(ws, graphItem());
    const restored = deserializeWorkspace(serializeWorkspace(ws));
    expect(restored).toEqual(ws);
    if (restored!.root.kind === "leaf") {
      expect(restored!.root.tabs).toEqual([noteItem("a"), graphItem()]);
    } else {
      throw new Error("expected a leaf root");
    }
  });

  it("rejects a structurally-malformed tab (not a string or {kind,id})", () => {
    expect(
      deserializeWorkspace(
        JSON.stringify({
          root: { kind: "leaf", id: "p", tabs: [42], activeTab: null },
          focusedPaneId: "p",
        }),
      ),
    ).toBeNull();
  });

  // ── tab-modes (MYND-319/320): pinned (per-tab) + stacked (per-leaf) ──────

  it("round-trips pinned tabs + a stacked pane identically", () => {
    let ws = emptyWorkspace("p");
    ws = openInNewTab(ws, noteItem("a"));
    ws = openInNewTab(ws, noteItem("b"));
    ws = setPinned(ws, "p", noteItem("a"), true);
    ws = setStacked(ws, "p", true);
    const restored = deserializeWorkspace(serializeWorkspace(ws));
    expect(restored).toEqual(ws);
    if (restored!.root.kind === "leaf") {
      expect(restored!.root.tabs[0]).toEqual({ kind: "note", id: "a", pinned: true });
      expect(restored!.root.tabs[1]).toEqual(noteItem("b")); // unpinned: no key
      expect(restored!.root.stacked).toBe(true);
    } else {
      throw new Error("expected a leaf root");
    }
  });

  it("a pinned VIEW + GRAPH tab round-trips (any tab kind is pinnable)", () => {
    let ws = emptyWorkspace("p");
    ws = openInNewTab(ws, viewItem("books"));
    ws = openInNewTab(ws, graphItem());
    ws = setPinned(ws, "p", viewItem("books"), true);
    ws = setPinned(ws, "p", graphItem(), true);
    const restored = deserializeWorkspace(serializeWorkspace(ws));
    expect(restored).toEqual(ws);
  });

  it("a workspace with NO pins/stacked serializes BYTE-IDENTICAL to pre-feature (omit-when-default)", () => {
    // The pre-feature descriptor shape is exactly {root,focusedPaneId} with
    // tabs carrying ONLY {kind,id} and a leaf carrying ONLY {kind,id,tabs,
    // activeTab}. A workspace that never pins/stacks must emit that byte-for-
    // byte — no `pinned`/`stacked` keys leak in.
    let ws = emptyWorkspace("p");
    ws = openInNewTab(ws, noteItem("a"));
    ws = openInNewTab(ws, noteItem("b"));
    const expectedPreFeature = JSON.stringify({
      root: {
        kind: "leaf",
        id: "p",
        tabs: [
          { kind: "note", id: "a" },
          { kind: "note", id: "b" },
        ],
        activeTab: { kind: "note", id: "b" },
      },
      focusedPaneId: "p",
    });
    expect(serializeWorkspace(ws)).toBe(expectedPreFeature);
    // And a transient pin/unpin (or stack/unstack) round leaves it byte-stable.
    let toggled = setPinned(ws, "p", noteItem("a"), true);
    toggled = setPinned(toggled, "p", noteItem("a"), false);
    toggled = setStacked(toggled, "p", true);
    toggled = setStacked(toggled, "p", false);
    expect(serializeWorkspace(toggled)).toBe(expectedPreFeature);
  });

  it("ignores a non-true `pinned`/`stacked` value (no `false` round-trips in)", () => {
    const restored = deserializeWorkspace(
      JSON.stringify({
        root: {
          kind: "leaf",
          id: "p",
          tabs: [{ kind: "note", id: "a", pinned: false }],
          activeTab: { kind: "note", id: "a" },
          stacked: false,
        },
        focusedPaneId: "p",
      }),
    );
    expect(restored).not.toBeNull();
    if (restored!.root.kind === "leaf") {
      // `pinned: false` is normalized away (absent key = unpinned default).
      expect(restored!.root.tabs[0]).toEqual(noteItem("a"));
      expect("pinned" in restored!.root.tabs[0]!).toBe(false);
      expect(restored!.root.stacked).toBeUndefined();
    } else {
      throw new Error("expected a leaf root");
    }
  });

  // ── reading-source-modes (MYND-299): per-tab viewMode omit-when-default ─────

  it("round-trips a non-default viewMode tab", () => {
    let ws = emptyWorkspace("p");
    ws = openInNewTab(ws, noteItem("a"));
    ws = openInNewTab(ws, noteItem("b"));
    ws = setItemViewMode(ws, "p", noteItem("a"), "reading");
    ws = setItemViewMode(ws, "p", noteItem("b"), "source");
    const restored = deserializeWorkspace(serializeWorkspace(ws));
    expect(restored).toEqual(ws);
    if (restored!.root.kind === "leaf") {
      expect(restored!.root.tabs[0]).toEqual({ kind: "note", id: "a", viewMode: "reading" });
      expect(restored!.root.tabs[1]).toEqual({ kind: "note", id: "b", viewMode: "source" });
    } else {
      throw new Error("expected a leaf root");
    }
  });

  it("a default (live) viewMode serializes BYTE-IDENTICAL to pre-feature (no key leaks)", () => {
    let ws = emptyWorkspace("p");
    ws = openInNewTab(ws, noteItem("a"));
    const expectedPreFeature = JSON.stringify({
      root: {
        kind: "leaf",
        id: "p",
        tabs: [{ kind: "note", id: "a" }],
        activeTab: { kind: "note", id: "a" },
      },
      focusedPaneId: "p",
    });
    expect(serializeWorkspace(ws)).toBe(expectedPreFeature);
    // A transient set-then-reset-to-live leaves it byte-stable.
    let toggled = setItemViewMode(ws, "p", noteItem("a"), "source");
    toggled = setItemViewMode(toggled, "p", noteItem("a"), "live");
    expect(serializeWorkspace(toggled)).toBe(expectedPreFeature);
  });

  it("ignores a non-enum `viewMode` value (junk/`live` ⇒ default, no key round-trips in)", () => {
    const restored = deserializeWorkspace(
      JSON.stringify({
        root: {
          kind: "leaf",
          id: "p",
          tabs: [
            { kind: "note", id: "a", viewMode: "live" },
            { kind: "note", id: "b", viewMode: "wat" },
          ],
          activeTab: { kind: "note", id: "a" },
        },
        focusedPaneId: "p",
      }),
    );
    expect(restored).not.toBeNull();
    if (restored!.root.kind === "leaf") {
      expect(restored!.root.tabs[0]).toEqual(noteItem("a"));
      expect("viewMode" in restored!.root.tabs[0]!).toBe(false);
      expect(restored!.root.tabs[1]).toEqual(noteItem("b"));
    } else {
      throw new Error("expected a leaf root");
    }
  });
});

// ── named-workspaces (MYND-308): container (de)serialization + migration ─────

describe("named-workspaces container (de)serialization", () => {
  it("round-trips a multi-slot container with per-tab viewMode preserved per slot", () => {
    let c = emptyNamedWorkspaces("p1", "s1");
    c = setActiveSlotState(
      c,
      setItemViewMode(
        openInNewTab(emptyWorkspace("p1"), noteItem("a")),
        "p1",
        noteItem("a"),
        "reading",
      ),
    );
    c = createSlot(c, "Second", openInNewTab(emptyWorkspace("p2"), noteItem("b")), () => "s2");
    const restored = deserializeWorkspaces(serializeWorkspaces(c));
    expect(restored).toEqual(c);
    // viewMode survived inside slot s1.
    const s1 = restored!.slots.find((s) => s.id === "s1")!;
    if (s1.state.root.kind === "leaf") {
      expect(s1.state.root.tabs[0]).toEqual({ kind: "note", id: "a", viewMode: "reading" });
    } else {
      throw new Error("expected a leaf root");
    }
  });

  it("migrates a LEGACY single-descriptor payload to a single Default slot", () => {
    const legacy = serializeWorkspace(openInNewTab(emptyWorkspace("p"), noteItem("a")));
    const restored = deserializeWorkspaces(legacy, () => "migrated-id");
    expect(restored).not.toBeNull();
    expect(restored!.slots).toHaveLength(1);
    expect(restored!.slots[0]!.id).toBe("migrated-id");
    expect(restored!.slots[0]!.name).toBe("Default");
    expect(restored!.activeId).toBe("migrated-id");
    expect(restored!.slots[0]!.state).toEqual(
      openInNewTab(emptyWorkspace("p"), noteItem("a")),
    );
  });

  it("rejects non-JSON / empty-slots / dangling activeId / duplicate slot ids", () => {
    expect(deserializeWorkspaces("not json{")).toBeNull();
    expect(deserializeWorkspaces(JSON.stringify({ slots: [], activeId: "x" }))).toBeNull();
    const oneSlot = {
      id: "s1",
      name: "A",
      state: { root: { kind: "leaf", id: "p", tabs: [], activeTab: null }, focusedPaneId: "p" },
    };
    // Dangling activeId.
    expect(
      deserializeWorkspaces(JSON.stringify({ slots: [oneSlot], activeId: "ghost" })),
    ).toBeNull();
    // Duplicate slot ids.
    expect(
      deserializeWorkspaces(JSON.stringify({ slots: [oneSlot, oneSlot], activeId: "s1" })),
    ).toBeNull();
    // A slot whose descriptor is corrupt rejects the whole blob.
    expect(
      deserializeWorkspaces(
        JSON.stringify({
          slots: [{ id: "s1", name: "A", state: { focusedPaneId: "p" } }],
          activeId: "s1",
        }),
      ),
    ).toBeNull();
  });
});
