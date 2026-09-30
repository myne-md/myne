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
  // The `view` discriminator is gone: the tab was a Hub-or-Focus mode and is
  // one screen now (`docs/decisions/ai/0627`), so what is persisted is WHICH
  // conversation is open rather than which of two views. The two keys are
  // independent, which the old shape could not express — it dropped both
  // unless a note was present, because "Focus with no note" was incoherent.

  it("a fresh agent tab carries no view key", () => {
    expect(tab(withAgentTab()).agentView).toBeUndefined();
  });

  it("an empty selection drops the key, so the tab stays byte-identical to pre-kind", () => {
    const s = roundTrip(setAgentViewState(withAgentTab(), "p1", {}));
    expect(tab(s).agentView).toBeUndefined();
  });

  // The three below drive `setAgentViewState` — the WRITER — where the round
  // trips further down drive the parser. They are different code paths and the
  // tests had only the second: injecting the old "drop unless a note is
  // present" rule back into `agentViewToPersisted` passed every test in this
  // file, because nothing here had ever called it with a conversation and no
  // note. The writer is the half a user's selection actually goes through.

  it("the WRITER keeps a conversation with no note", () => {
    const s = roundTrip(
      setAgentViewState(withAgentTab(), "p1", { conversationId: "c-7" }),
    );
    expect(tab(s).agentView).toEqual({ conversationId: "c-7" });
  });

  it("the WRITER keeps a note with no conversation", () => {
    const s = roundTrip(setAgentViewState(withAgentTab(), "p1", { noteId: "n-42" }));
    expect(tab(s).agentView).toEqual({ noteId: "n-42" });
  });

  it("the WRITER keeps both", () => {
    const s = roundTrip(
      setAgentViewState(withAgentTab(), "p1", { noteId: "n-42", conversationId: "c-7" }),
    );
    expect(tab(s).agentView).toEqual({ noteId: "n-42", conversationId: "c-7" });
  });

  it("round-trips a conversation and its note", () => {
    const item: WorkspaceItem = {
      kind: "agent",
      id: AGENT_TAB_ID,
      agentView: { noteId: "n-42", conversationId: "c-7" },
    };
    const s = roundTrip(openInFocusedTab(emptyWorkspace("p1"), item));
    expect(tab(s).agentView).toEqual({ noteId: "n-42", conversationId: "c-7" });
  });

  it("round-trips a VAULT-GENERAL conversation, which has no note at all", () => {
    // The state the old shape could not hold: a conversation about the vault
    // rather than one note. `agentViewToPersisted` dropped it entirely, so
    // reopening the tab landed on a list instead of the chat you were in.
    const item: WorkspaceItem = {
      kind: "agent",
      id: AGENT_TAB_ID,
      agentView: { conversationId: "c-7" },
    };
    const s = roundTrip(openInFocusedTab(emptyWorkspace("p1"), item));
    expect(tab(s).agentView).toEqual({ conversationId: "c-7" });
  });

  it("round-trips a fresh conversation that is ABOUT a note", () => {
    // The other half the old shape could not hold on its own: no conversation
    // id yet, but a subject. A reload lands on the same subject rather than on
    // nothing.
    const item: WorkspaceItem = {
      kind: "agent",
      id: AGENT_TAB_ID,
      agentView: { noteId: "n-42" },
    };
    const s = roundTrip(openInFocusedTab(emptyWorkspace("p1"), item));
    expect(tab(s).agentView).toEqual({ noteId: "n-42" });
  });
});

describe("degrade-don't-error", () => {
  it("an unknown view name is ignored rather than rejecting the blob", () => {
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
    // The agent tab is still there, on a fresh conversation, and the sibling
    // note survived.
    const leaf = parsed!.root as { tabs: WorkspaceItem[] };
    expect(leaf.tabs.find((t) => t.kind === "agent")).toEqual({
      kind: "agent",
      id: AGENT_TAB_ID,
    });
    expect(leaf.tabs.some((t) => t.kind === "note")).toBe(true);
  });

  it("an agentView carrying only the retired discriminator drops to nothing", () => {
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

  it("a descriptor from the two-view build keeps the conversation it had open", () => {
    // The migration that matters, and the one a reader can get wrong: the old
    // reader required `view === "focus"` before it would take the keys, so a
    // parser that kept that check would SILENTLY discard the conversation a
    // user had open across the change. The discriminator is ignored; the two
    // keys beside it mean here exactly what they meant there.
    const descriptor = JSON.stringify({
      root: {
        kind: "leaf",
        id: "p1",
        tabs: [
          {
            kind: "agent",
            id: AGENT_TAB_ID,
            agentView: { view: "focus", noteId: "n-42", conversationId: "c-7" },
          },
        ],
        activeTab: { kind: "agent", id: AGENT_TAB_ID },
      },
      focusedPaneId: "p1",
    });
    const parsed = deserializeWorkspace(descriptor);
    expect(parsed).not.toBeNull();
    const leaf = parsed!.root as { tabs: Array<Record<string, unknown>> };
    expect(leaf.tabs[0]).toEqual({
      kind: "agent",
      id: AGENT_TAB_ID,
      agentView: { conversationId: "c-7", noteId: "n-42" },
    });
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
