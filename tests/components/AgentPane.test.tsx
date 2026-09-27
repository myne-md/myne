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
