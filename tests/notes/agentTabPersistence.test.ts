// The agent-tab view persistence (myne-md/myne#771 task 2).
//
// The agent tab's view (Hub or Focus, and which note/conversation Focus shows)
// rides the **workspace descriptor**, per tab, the way the task tab's view does.
// Not a preference: "which view am I in" is where the user is.
//
// The descriptor is opaque to the storage codec, so none of this is a protocol
// change. What the tests pin is the two properties that make that safe:
// **omit-when-default**, so an untouched Hub tab serializes byte-identical to a
// descriptor from before the kind existed, and **degrade-don't-error**, so junk
// or a future build's value cannot reject the whole blob and lose every open tab.
//
// And the third, which is the whole point of the kind being a singleton: a
// second "open the agent" is a REVEAL, not a second tab.

import { describe, expect, it } from "vitest";
import {
  AGENT_TAB_ID,
  agentItem,
  emptyWorkspace,
  itemKey,
  openInFocusedTab,
  parseItemKey,
  setAgentViewState,
  type WorkspaceItem,
  type WorkspaceState,
} from "../../src/notes/workspaceState";
import {
  deserializeWorkspace,
  serializeWorkspace,
} from "../../src/lib/workspace-persist";

function withAgentTab(): WorkspaceState {
  return openInFocusedTab(emptyWorkspace("p1"), agentItem());
}

/** The agent tab as it stands in `state`'s focused pane. */
function tab(state: WorkspaceState): Record<string, unknown> {
  const leaf = state.root as { tabs: Array<Record<string, unknown>> };
  return leaf.tabs.find((t) => t.kind === "agent")!;
}

function roundTrip(state: WorkspaceState): WorkspaceState {
  const parsed = deserializeWorkspace(serializeWorkspace(state));
  if (parsed === null) throw new Error("workspace failed to round-trip");
  return parsed;
}

describe("the tab kind itself", () => {
  it("is a singleton, like the graph and the task list", () => {
    // The reveal-not-duplicate property the whole kind rests on.
    const twice = openInFocusedTab(withAgentTab(), agentItem());
    const leaf = twice.root as { tabs: unknown[] };
    expect(leaf.tabs.filter((t) => (t as { kind: string }).kind === "agent")).toHaveLength(1);
  });

  it("round-trips through its item key", () => {
    expect(parseItemKey(itemKey(agentItem()))).toEqual({
      kind: "agent",
      id: AGENT_TAB_ID,
    });
  });

  it("normalizes a stored id to its sentinel", () => {
    // A key written by a build that used a different id still resolves to the
    // one canonical tab.
    expect(parseItemKey("agent:something-else")).toEqual({
      kind: "agent",
      id: AGENT_TAB_ID,
    });
  });
});

describe("omit-when-default", () => {
  it("a fresh agent tab carries no view key", () => {
    expect(tab(withAgentTab()).agentView).toBeUndefined();
  });

  it("a Hub view drops the key, so the tab stays byte-identical to pre-kind", () => {
    const s = roundTrip(
      setAgentViewState(withAgentTab(), "p1", { view: "hub" }),
    );
    expect(tab(s).agentView).toBeUndefined();
  });

  it("a Focus with no note is incoherent, so it drops too", () => {
    const s = roundTrip(
      setAgentViewState(withAgentTab(), "p1", { view: "focus" }),
    );
    expect(tab(s).agentView).toBeUndefined();
  });

  it("a Focus view round-trips its note and conversation", () => {
    const item: WorkspaceItem = {
      kind: "agent",
      id: AGENT_TAB_ID,
      agentView: { view: "focus", noteId: "n-42", conversationId: "c-7" },
    };
    const s = roundTrip(openInFocusedTab(emptyWorkspace("p1"), item));
    expect(tab(s).agentView).toEqual({
      view: "focus",
      noteId: "n-42",
      conversationId: "c-7",
    });
  });

  it("a Focus view with no conversation omits the field", () => {
    const item: WorkspaceItem = {
      kind: "agent",
      id: AGENT_TAB_ID,
      agentView: { view: "focus", noteId: "n-42" },
    };
    const s = roundTrip(openInFocusedTab(emptyWorkspace("p1"), item));
    expect(tab(s).agentView).toEqual({ view: "focus", noteId: "n-42" });
  });
});

describe("degrade-don't-error", () => {
  it("an unknown view name degrades to the Hub rather than rejecting the blob", () => {
    const descriptor = JSON.stringify({
      root: {
        kind: "leaf",
        id: "p1",
        tabs: [
          { kind: "agent", id: AGENT_TAB_ID, agentView: { view: "future-view" } },
          { kind: "note", id: "n1" },
        ],
        activeTab: { kind: "agent", id: AGENT_TAB_ID },
      },
      focusedPaneId: "p1",
    });
    const parsed = deserializeWorkspace(descriptor);
    expect(parsed).not.toBeNull();
    // The agent tab is still there, on the Hub, and the sibling note survived.
    const leaf = parsed!.root as { tabs: WorkspaceItem[] };
    expect(leaf.tabs.find((t) => t.kind === "agent")).toEqual({
      kind: "agent",
      id: AGENT_TAB_ID,
    });
    expect(leaf.tabs.some((t) => t.kind === "note")).toBe(true);
  });

  it("a Focus with no note id is incoherent and degrades to the Hub", () => {
    const descriptor = JSON.stringify({
      root: {
        kind: "leaf",
        id: "p1",
        tabs: [{ kind: "agent", id: AGENT_TAB_ID, agentView: { view: "focus" } }],
        activeTab: { kind: "agent", id: AGENT_TAB_ID },
      },
      focusedPaneId: "p1",
    });
    const parsed = deserializeWorkspace(descriptor);
    expect(parsed).not.toBeNull();
    const leaf = parsed!.root as { tabs: Array<Record<string, unknown>> };
    expect(leaf.tabs[0]).toEqual({ kind: "agent", id: AGENT_TAB_ID });
  });

  it("junk in agentView does not lose the other tabs", () => {
    const descriptor = JSON.stringify({
      root: {
        kind: "leaf",
        id: "p1",
        tabs: [
          { kind: "agent", id: AGENT_TAB_ID, agentView: "not-an-object" },
          { kind: "note", id: "n1" },
        ],
        activeTab: { kind: "agent", id: AGENT_TAB_ID },
      },
      focusedPaneId: "p1",
    });
    const parsed = deserializeWorkspace(descriptor);
    expect(parsed).not.toBeNull();
    const leaf = parsed!.root as { tabs: WorkspaceItem[] };
    expect(leaf.tabs.some((t) => t.kind === "note")).toBe(true);
  });
});
