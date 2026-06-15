// Serialize/deserialize + validation tests for the workspace descriptor
// (MYND-166, Task 13). The deserializer is the trust boundary for a
// tampered-but-AEAD-OK or schema-drifted blob — it must reject anything
// malformed so the editor falls back to a clean single empty pane.

import { describe, expect, it } from "vitest";
import {
  deserializeWorkspace,
  serializeWorkspace,
} from "../../src/lib/workspace-persist";
import {
  emptyWorkspace,
  graphItem,
  noteItem,
  openInNewTab,
  openToSide,
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
});
