// The agent pane's two views (myne-md/myne#771 task 6).
//
// One tab kind, two views. What this pins is the property the whole design rests
// on: the view is chosen by the workspace item's `agentView`, a Hub row that
// opens a conversation writes `focus` through the one writer, and a Hub tab with
// no `agentView` renders the Hub.

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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
import { getChat, sendChatMessage } from "../../src/notes/ai/chatStore";
import { AGENT_TAB_ID } from "../../src/notes/workspaceState";

beforeEach(() => {
  mockSetAgentViewState.mockReset();
  mockOpenInFocused.mockReset();
  mockChatsList.mockReset();
  mockChatsList.mockResolvedValue([]);
});

afterEach(() => cleanup());

describe("AgentPane: one screen, both columns", () => {
  // It was two views with a back control between them, and the tests below
  // used to assert which one was showing. There is one screen now
  // (`docs/decisions/ai/0623`): the history rail beside the open conversation,
  // both mounted, at every width. The narrow arm hides one of them in CSS,
  // which is a fallback rather than a mode — so there is no `data-agent-view`
  // to assert on and nothing that "renders the Hub" as opposed to Focus.

  function paneAt(view?: { conversationId?: string; noteId?: string }) {
    return render(
      <AgentPane
        paneId="p1"
        item={{
          kind: "agent",
          id: AGENT_TAB_ID,
          ...(view === undefined ? {} : { agentView: view }),
        }}
      />,
    );
  }

  it("mounts the rail and the conversation together, both showing", () => {
    // `getByTestId` alone is not enough and an injection proved it: an element
    // that is `hidden`, or `display: none`, satisfies a presence query while
    // being exactly the one-column shape this screen replaced. What is asserted
    // is that neither column is suppressed — at wide widths the container query
    // does not fire, so anything hiding one is the component doing it.
    paneAt();
    for (const id of ["agent.rail", "agent.focus"]) {
      const el = screen.getByTestId(id);
      expect(el, `${id} is gone`).toBeTruthy();
      expect(el.hasAttribute("hidden"), `${id} is hidden`).toBe(false);
      expect(el.style.display, `${id} is display:none`).not.toBe("none");
    }
    // And the rail is the rail rather than an empty box: the class is what the
    // container query keys the narrow fallback off.
    expect(screen.getByTestId("agent.rail").className).toContain("myne-agent__rail");
  });

  it("does the same for a tab with nothing selected", () => {
    // A fresh conversation is a normal state, not an empty one: the old shape
    // refused to open Focus without a note, so "no selection" meant a list with
    // no way onward.
    paneAt();
    expect(screen.getByTestId("agent.pane").getAttribute("data-agent-conversation")).toBe("");
    expect(screen.getByTestId("agent.focus")).toBeTruthy();
  });

  it("carries the anchored note's link when the conversation has one", () => {
    paneAt({ noteId: "n-9" });
    expect(screen.getByTestId("agent.focus-open-note").getAttribute("data-note-id")).toBe("n-9");
  });

  it("exposes the open conversation to a scenario", () => {
    paneAt({ conversationId: "c-7" });
    expect(screen.getByTestId("agent.pane").getAttribute("data-agent-conversation")).toBe("c-7");
  });

  it("has no back control, because there is nowhere to go back to", () => {
    // The rail is beside the conversation. A back control here would return
    // the user to something already on screen.
    paneAt({ conversationId: "c-7" });
    expect(screen.queryByTestId("agent.focus-back")).toBeNull();
  });

  it("offers a rail toggle for the narrow arm, always mounted", () => {
    // The CSS decides whether it is VISIBLE — a container query on the pane,
    // not a viewport query, because a pane can be half a window. It is rendered
    // unconditionally so the header does not reflow when a pane is dragged
    // across the threshold.
    paneAt();
    const toggle = screen.getByTestId("agent.rail-toggle");
    expect(toggle.className).toContain("myne-agent__rail-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // `fireEvent`, not `.click()`: a bare DOM click outside React's event
    // system leaves the state update unbatched and this assertion reads the
    // pre-render attribute.
    fireEvent.click(toggle);
    expect(screen.getByTestId("agent.rail-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("agent.pane").getAttribute("data-rail")).toBe("open");
  });
});

describe("AgentPane: focus follows the conversation, not a view", () => {
  // Task 13 of myne-md/myne#771, re-aimed. Switching conversations replaces
  // the transcript subtree, so whatever the keyboard user was standing on is
  // unmounted and React hands focus back to `<body>` — outside the pane, with
  // the whole app behind them, their next Tab starting from the top of the
  // document. The same defect myne-md/myne#775 fixed on the ribbon's Escape
  // path; only the trigger changed when the two views became one screen.

  function paneAt(view?: { conversationId?: string; noteId?: string }) {
    return render(
      <AgentPane
        paneId="p1"
        item={{
          kind: "agent",
          id: AGENT_TAB_ID,
          ...(view === undefined ? {} : { agentView: view }),
        }}
      />,
    );
  }

  it("does not take focus on first mount", () => {
    // Opening the tab must not steal the caret from whatever opened it — the
    // palette, the ribbon, a rail row. This is the half a naive "focus on
    // render" gets wrong, and the half a user would actually notice.
    paneAt();
    expect(document.activeElement).toBe(document.body);
  });

  it("takes focus when the open conversation changes under it", () => {
    const { rerender } = paneAt({ conversationId: "c-1" });
    rerender(
      <AgentPane
        paneId="p1"
        item={{ kind: "agent", id: AGENT_TAB_ID, agentView: { conversationId: "c-2" } }}
      />,
    );
    expect(document.activeElement, "the keyboard user was dropped on <body>").toBe(
      screen.getByTestId("agent.pane"),
    );
  });

  it("is focusable but not a Tab stop", () => {
    // A container in the tab order is a stop that does nothing, paid on every
    // pass through the pane.
    paneAt();
    expect(screen.getByTestId("agent.pane").getAttribute("tabindex")).toBe("-1");
  });

  it("names itself, since it is somewhere focus can land", () => {
    paneAt();
    expect(
      (screen.getByTestId("agent.pane").getAttribute("aria-label") ?? "").length,
    ).toBeGreaterThan(0);
  });
});

describe("AgentPane: New conversation clears the transcript, not just the state", () => {
  // The defect: it wrote the workspace state and nothing else. The tab forgot
  // which conversation it was showing while the CHAT STORE went on holding the
  // previous transcript — so the screen did not change and the button read as
  // broken, because it very nearly was.
  //
  // `tsc` is content, the state write happens, and a test that only checked
  // `setAgentViewState` would have passed against exactly this.

  it("clears the open transcript", async () => {
    sendChatMessage("an earlier question");
    expect(getChat().turns.length).toBeGreaterThan(0);

    render(
      <AgentPane paneId="p1" item={{ kind: "agent", id: AGENT_TAB_ID }} />,
    );
    // The rail loads its roster asynchronously, so the control is not there on
    // the first frame — it renders the loading line instead.
    fireEvent.click(await screen.findByTestId("agent.hub-new"));

    expect(getChat().turns, "the previous conversation is still on screen").toHaveLength(
      0,
    );
  });

  it("writes the workspace state too, so the tab forgets its selection", async () => {
    // Both halves. Clearing the store without dropping the selection would
    // leave the tab pointing at a conversation whose transcript is gone, and
    // the reopen effect would pull it straight back.
    render(
      <AgentPane
        paneId="p1"
        item={{ kind: "agent", id: AGENT_TAB_ID, agentView: { conversationId: "c-7" } }}
      />,
    );
    fireEvent.click(await screen.findByTestId("agent.hub-new"));
    expect(mockSetAgentViewState).toHaveBeenCalledWith("p1", {});
  });
});
