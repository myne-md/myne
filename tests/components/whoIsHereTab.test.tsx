// @vitest-environment jsdom
// The "Who's here" roster (`collab-presence-ui` task 4).

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhoIsHereTab } from "../../src/notes/components/WhoIsHereTab";
import { EMPTY_SIDEBAR_STATE, SidebarStateProvider } from "../../src/notes/sidebarState";
import { awarenessClear, setAwareness } from "../../src/notes/collab/awarenessStore";
import type { IdentityLabel } from "../../src/notes/collab/identityLabel";
import type { Participant } from "../../src/notes/collab/participant";

/** A user-authored name, the arm that carries no copy of ours. */
const text = (text: string): IdentityLabel => ({ kind: "text", text });

const { requestPresenceJump } = vi.hoisted(() => ({ requestPresenceJump: vi.fn() }));
vi.mock("../../src/notes/collab/presenceJump", () => ({
  PRESENCE_JUMP_EVENT: "myne-presence-jump",
  requestPresenceJump,
}));

function peer(over: Partial<Participant>): [string, Participant] {
  const p: Participant = {
    id: "a",
    noteId: "n",
    label: { kind: "text", text: "Ada" },
    unAttributed: false,
    caret: 1,
    selection: null,
    color: 0,
    ...over,
  };
  return [p.id, p];
}

function seed(peers: Participant[]) {
  // Peers are keyed by note now, so seed them under the note the tab selects.
  setAwareness({
    peersByNote: new Map([["n", new Map(peers.map(peer))]]),
    droppedAt: null,
  });
}

function renderTab() {
  return render(
    <SidebarStateProvider initialState={{ ...EMPTY_SIDEBAR_STATE, selectedId: "n" }}>
      <WhoIsHereTab />
    </SidebarStateProvider>,
  );
}

afterEach(() => {
  cleanup();
  awarenessClear();
  requestPresenceJump.mockClear();
});

describe("WhoIsHereTab", () => {
  it("shows the empty state when you are alone", () => {
    renderTab();
    expect(screen.getByTestId("editor.presence-empty")).toBeTruthy();
    expect(screen.queryAllByTestId("editor.presence-row")).toHaveLength(0);
  });

  it("renders a row per participant with its name and a colour dot", () => {
    seed([
      { id: "a", noteId: "n", label: text("Ada"), unAttributed: false, caret: 1, selection: null, color: 0 },
      { id: "b", noteId: "n", label: text("Bob"), unAttributed: false, caret: 2, selection: null, color: 1 },
    ]);
    renderTab();
    expect(screen.getAllByTestId("editor.presence-row")).toHaveLength(2);
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(screen.getAllByTestId("editor.presence-dot")).toHaveLength(2);
  });

  it("renders an un-attributed peer with the degraded label", () => {
    seed([
      { id: "a", noteId: "n", label: null, unAttributed: true, caret: 1, selection: null, color: 3 },
    ]);
    renderTab();
    expect(screen.getByText("Someone")).toBeTruthy();
  });

  it("resolves a device descriptor itself, rather than passing it through", () => {
    // The store holds a DESCRIPTOR, so the row's text can only appear if the ROSTER
    // runs the rule. An un-resolved descriptor reaching the DOM would render
    // `[object Object]`, which is what this row would show if the surface were
    // changed back to reading a stored string.
    seed([
      {
        id: "a",
        noteId: "n",
        label: { kind: "device", code: "bbbbbb" },
        unAttributed: false,
        caret: 1,
        selection: null,
        color: 2,
      },
    ]);
    renderTab();
    expect(screen.getByText("Device bbbbbb")).toBeTruthy();
    expect(screen.queryByText(/object Object/)).toBeNull();
  });

  it("the row is a button that jumps on click (no follow mode)", () => {
    seed([{ id: "a", noteId: "n", label: text("Ada"), unAttributed: false, caret: 9, selection: null, color: 0 }]);
    renderTab();
    const row = screen.getByTestId("editor.presence-row");
    expect(row.tagName).toBe("BUTTON");
    fireEvent.click(row);
    expect(requestPresenceJump).toHaveBeenCalledTimes(1);
    expect(requestPresenceJump.mock.calls[0]?.[1]).toMatchObject({ id: "a", caret: 9 });
  });
});
