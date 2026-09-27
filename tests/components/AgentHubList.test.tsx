// The agent Hub conversation list (myne-md/myne#771 task 3).
//
// The list/open/rename/delete surface over the persisted conversations, rendered
// in a tab rather than a modal. The IPC boundary is mocked at the bindings
// module; the store side is real, so these tests prove which row action reaches
// which command with which id.

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { mockChatsList, mockChatsRename, mockChatsDelete, mockOpenConversation } =
  vi.hoisted(() => ({
    mockChatsList: vi.fn(),
    mockChatsRename: vi.fn(),
    mockChatsDelete: vi.fn(),
    mockOpenConversation: vi.fn(),
  }));

vi.mock("../../src/lib/chats", () => ({
  chatsList: mockChatsList,
  chatsRename: mockChatsRename,
  chatsDelete: mockChatsDelete,
}));

vi.mock("../../src/notes/ai/chatPersist", () => ({
  openConversation: mockOpenConversation,
  clearChatPersistForLock: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../src/lib/useDateTimeDisplay", () => ({
  useDateTimeDisplay: () => ({ locale: "en", timeZone: null }),
}));

import { AgentHubList } from "../../src/notes/agent/AgentHubList";

function row(id: string, title: string, updatedAt: number) {
  return { id, title, created_at: 1, updated_at: updatedAt, version: 1 };
}

beforeEach(() => {
  mockChatsList.mockReset();
  mockChatsRename.mockReset();
  mockChatsDelete.mockReset();
  mockOpenConversation.mockReset();
  mockOpenConversation.mockResolvedValue("opened");
});

afterEach(() => cleanup());

describe("AgentHubList", () => {
  it("lists every conversation, newest first", async () => {
    mockChatsList.mockResolvedValue([
      row("c-old", "Older", 100),
      row("c-new", "Newer", 300),
      row("c-mid", "Middle", 200),
    ]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    await screen.findByTestId("agent.hub-list");
    const rows = screen.getAllByTestId("agent.hub-row");
    expect(rows.map((r) => r.getAttribute("data-conversation-id"))).toEqual([
      "c-new",
      "c-mid",
      "c-old",
    ]);
  });

  it("shows the first-run empty state when there are none", async () => {
    mockChatsList.mockResolvedValue([]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    await screen.findByTestId("agent.hub-empty");
    // The first-run state is NOT the error state: different screen, different fix.
    expect(screen.queryByTestId("agent.hub-error")).toBeNull();
  });

  it("shows the error state, not the empty state, when the list fails", async () => {
    mockChatsList.mockRejectedValue(new Error("io"));
    render(<AgentHubList onOpenFocus={() => {}} />);
    await screen.findByTestId("agent.hub-error");
    expect(screen.queryByTestId("agent.hub-empty")).toBeNull();
  });

  it("opens a conversation and moves the tab to Focus on it", async () => {
    mockChatsList.mockResolvedValue([row("c1", "One", 1)]);
    const onOpenFocus = vi.fn();
    render(<AgentHubList onOpenFocus={onOpenFocus} />);
    fireEvent.click((await screen.findAllByTestId("agent.hub-open"))[0]!);
    await waitFor(() => expect(onOpenFocus).toHaveBeenCalledWith({ conversationId: "c1" }));
    expect(mockOpenConversation).toHaveBeenCalledWith("c1");
  });

  it("renames through the command and re-fetches", async () => {
    mockChatsList.mockResolvedValue([row("c1", "One", 1)]);
    mockChatsRename.mockResolvedValue(undefined);
    render(<AgentHubList onOpenFocus={() => {}} />);
    fireEvent.click((await screen.findAllByTestId("agent.hub-rename"))[0]!);
    const input = screen.getByTestId("agent.hub-rename-input");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByTestId("agent.hub-rename-confirm"));
    await waitFor(() => expect(mockChatsRename).toHaveBeenCalledWith("c1", "Renamed"));
    // Re-fetched, not patched locally.
    expect(mockChatsList).toHaveBeenCalledTimes(2);
  });

  it("filters by title and shows a distinct filtered-empty state", async () => {
    mockChatsList.mockResolvedValue([
      row("c1", "Tax folder", 3),
      row("c2", "Meeting notes", 2),
    ]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    await screen.findByTestId("agent.hub-list");
    fireEvent.change(screen.getByTestId("agent.hub-search"), {
      target: { value: "tax" },
    });
    expect(screen.getAllByTestId("agent.hub-row")).toHaveLength(1);
    // A query matching nothing is the FILTERED-empty state, not the first-run
    // empty vault: different screen, different fix.
    fireEvent.change(screen.getByTestId("agent.hub-search"), {
      target: { value: "zzz" },
    });
    await screen.findByTestId("agent.hub-no-match");
    expect(screen.queryByTestId("agent.hub-empty")).toBeNull();
  });

  it("shows the anchor chip when a conversation carries a note", async () => {
    mockChatsList.mockResolvedValue([
      { ...row("c1", "On a note", 1), note_id: "n-7" },
      row("c2", "Vault general", 2),
    ]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    await screen.findByTestId("agent.hub-list");
    const anchors = screen.getAllByTestId("agent.hub-anchor");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.getAttribute("data-note-id")).toBe("n-7");
  });

  it("deletes through the command after an inline confirm", async () => {
    mockChatsList.mockResolvedValue([row("c1", "One", 1)]);
    mockChatsDelete.mockResolvedValue(undefined);
    render(<AgentHubList onOpenFocus={() => {}} />);
    fireEvent.click((await screen.findAllByTestId("agent.hub-delete"))[0]!);
    fireEvent.click(screen.getByTestId("agent.hub-delete-confirm"));
    await waitFor(() => expect(mockChatsDelete).toHaveBeenCalledWith("c1"));
    expect(mockChatsList).toHaveBeenCalledTimes(2);
  });
});

describe("AgentHubList: the Hub can start a conversation", () => {
  // The defect this is written against SHIPPED, and it was invisible to every
  // gate: the Hub's first-run state explained what conversations are and gave
  // the user no way to have one. `<PanelEmptyState>` cannot carry an action at
  // all, so the surface whose entire job is "offer the thing that creates the
  // first thing" had nothing to press.
  //
  // Behind it was a second one. `openFocus` returns silently when no note is
  // focused — correctly, because a run needs a scope and the host refuses a
  // vault-wide grant — so a start control that ignored that would land there
  // and do nothing. A button that silently fails is worse than an absent one:
  // the user concludes the feature is broken rather than that they have a step
  // to do first.

  it("offers the first action when a note is open", async () => {
    mockChatsList.mockResolvedValue([]);
    render(<AgentHubList onOpenFocus={vi.fn()} focusedNoteId="n-1" />);
    await screen.findByTestId("agent.hub-empty");
    expect(screen.getByTestId("agent.hub-new")).toBeTruthy();
  });

  it("starts a NEW conversation, not an existing one", async () => {
    const onOpenFocus = vi.fn();
    mockChatsList.mockResolvedValue([]);
    render(<AgentHubList onOpenFocus={onOpenFocus} focusedNoteId="n-1" />);
    await screen.findByTestId("agent.hub-empty");
    screen.getByTestId("agent.hub-new").click();
    // No `conversationId`: the pane reads that as "open Focus on the note" and
    // the composer's first send creates the conversation. Passing one here
    // would reopen whichever chat happened to be last.
    expect(onOpenFocus).toHaveBeenCalledWith({});
  });

  it("withholds the control, and says why, when no note is open", async () => {
    mockChatsList.mockResolvedValue([]);
    render(<AgentHubList onOpenFocus={vi.fn()} focusedNoteId={null} />);
    const empty = await screen.findByTestId("agent.hub-empty");
    expect(screen.queryByTestId("agent.hub-new")).toBeNull();
    // And the body is the OTHER sentence — the one naming the step to do
    // first. Offering no control and no explanation is the dead end again.
    // This file stubs i18n to echo keys, so the assertion is on WHICH key: the
    // needs-a-note sentence, not the general "here is what conversations are"
    // one that reads as an invitation with nothing to accept.
    expect(empty.textContent).toContain("agent.hub.emptyNeedsNote");
    expect(empty.textContent).not.toContain("agent.hub.emptyBody");
  });

  it("offers it above a NON-empty list too", async () => {
    // Otherwise the Hub is a surface you can only ever CONTINUE from: the empty
    // state's action disappears the moment there is one conversation, and a
    // user with a single old chat would have no way to begin a second.
    mockChatsList.mockResolvedValue([
      { id: "c1", title: "An old chat", updated_at: 2, created_at: 1, version: 1 },
    ]);
    render(<AgentHubList onOpenFocus={vi.fn()} focusedNoteId="n-1" />);
    await screen.findByTestId("agent.hub-row");
    expect(screen.getByTestId("agent.hub-new")).toBeTruthy();
  });
});
