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
  openInNewTab,
  openToSide,
  type WorkspaceState,
} from "../../src/notes/workspaceState";

function sampleSplit(): WorkspaceState {
  let ws = emptyWorkspace("p-root");
  ws = openInNewTab(ws, "a");
  ws = openInNewTab(ws, "b");
  ws = openToSide(ws, "c", (() => {
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
});
