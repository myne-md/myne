// The agent pane's two views (myne-md/myne#771 task 6).
//
// One tab kind, two views. What this pins is the property the whole design rests
// on: the view is chosen by the workspace item's `agentView`, a Hub row that
// opens a conversation writes `focus` through the one writer, and a Hub tab with
// no `agentView` renders the Hub.

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const { mockSetAgentViewState, mockOpenInFocused, mockChatsList } = vi.hoisted(() => ({
  mockSetAgentViewState: vi.fn(),
  mockOpenInFocused: vi.fn(),
  mockChatsList: vi.fn(),
}));

vi.mock("../../src/notes/workspaceContext", () => ({
  useWorkspace: () => ({
    setAgentViewState: mockSetAgentViewState,
    openInFocused: mockOpenInFocused,
  }),
}));

vi.mock("../../src/lib/chats", () => ({
  chatsList: mockChatsList,
  chatsRename: vi.fn(),
  chatsDelete: vi.fn(),
}));

vi.mock("../../src/notes/ai/chatPersist", () => ({
  openConversation: vi.fn().mockResolvedValue("opened"),
  clearChatPersistForLock: vi.fn(),
  installChatPersistence: vi.fn(),
  hydrateActiveConversation: vi.fn(),
  isChatHydrateFailed: () => false,
  isChatPersistLagging: () => false,
  subscribeChatPersistHealth: () => () => {},
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../src/lib/useDateTimeDisplay", () => ({
  useDateTimeDisplay: () => ({ locale: "en", timeZone: null }),
}));

import { AgentPane } from "../../src/notes/agent/AgentPane";
import { AGENT_TAB_ID } from "../../src/notes/workspaceState";

beforeEach(() => {
  mockSetAgentViewState.mockReset();
  mockOpenInFocused.mockReset();
  mockChatsList.mockReset();
  mockChatsList.mockResolvedValue([]);
});

afterEach(() => cleanup());

describe("AgentPane", () => {
  it("renders the Hub for an agent tab with no view", () => {
    render(
      <AgentPane
        paneId="p1"
        item={{ kind: "agent", id: AGENT_TAB_ID }}
      />,
    );
    expect(screen.getByTestId("agent.pane").getAttribute("data-agent-view")).toBe("hub");
  });

  it("renders Focus for an agent tab carrying a focus view", () => {
    render(
      <AgentPane
        paneId="p1"
        item={{
          kind: "agent",
          id: AGENT_TAB_ID,
          agentView: { view: "focus", noteId: "n-9" },
        }}
      />,
    );
    expect(screen.getByTestId("agent.pane").getAttribute("data-agent-view")).toBe("focus");
    expect(screen.getByTestId("agent.focus")).toBeTruthy();
    expect(screen.getByTestId("agent.focus-open-note").getAttribute("data-note-id")).toBe("n-9");
  });

  it("returns to the Hub through the one view writer", () => {
    render(
      <AgentPane
        paneId="p1"
        item={{
          kind: "agent",
          id: AGENT_TAB_ID,
          agentView: { view: "focus", noteId: "n-9" },
        }}
      />,
    );
    screen.getByTestId("agent.focus-back").click();
    expect(mockSetAgentViewState).toHaveBeenCalledWith("p1", { view: "hub" });
  });
});

describe("AgentPane: focus survives the view change", () => {
  // Task 13 of myne-md/myne#771. The hub and the focus view are different
  // subtrees, so switching unmounts whatever the keyboard user was standing on
  // and React hands focus back to `<body>` — outside the pane, with the whole
  // app behind them, and their next Tab starting from the top of the document.
  // Exactly the defect myne-md/myne#775 fixed on the ribbon's Escape path.
  //
  // Nothing else reports it: the click works, the view changes, the pane
  // renders. Only a keyboard user finds out.

  function renderAt(view: "hub" | "focus") {
    return render(
      <AgentPane
        paneId="p1"
        item={
          view === "hub"
            ? { kind: "agent", id: AGENT_TAB_ID }
            : {
                kind: "agent",
                id: AGENT_TAB_ID,
                agentView: { view: "focus", noteId: "n-9" },
              }
        }
      />,
    );
  }

  it("does not take focus on first mount", () => {
    // Opening the tab must not steal the caret from whatever opened it — the
    // palette, the ribbon, a hub row. This is the half that a naive "focus on
    // render" gets wrong, and it is the half the user would actually notice.
    renderAt("hub");
    expect(document.activeElement).toBe(document.body);
  });

  it("takes focus when the view changes under it", () => {
    const { rerender } = renderAt("hub");
    rerender(
      <AgentPane
        paneId="p1"
        item={{
          kind: "agent",
          id: AGENT_TAB_ID,
          agentView: { view: "focus", noteId: "n-9" },
        }}
      />,
    );
    const pane = screen.getByTestId("agent.pane");
    expect(document.activeElement, "the keyboard user was dropped on <body>").toBe(pane);
  });

  it("is focusable but not a Tab stop", () => {
    // A container in the tab order is a stop that does nothing, paid on every
    // pass through the pane.
    renderAt("hub");
    expect(screen.getByTestId("agent.pane").getAttribute("tabindex")).toBe("-1");
  });

  it("names itself, since it is now somewhere focus can land", () => {
    renderAt("hub");
    expect(
      (screen.getByTestId("agent.pane").getAttribute("aria-label") ?? "").length,
    ).toBeGreaterThan(0);
  });
});
