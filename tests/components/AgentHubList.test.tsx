// The agent Hub conversation list (myne-md/myne#771 task 3).
//
// The list/open/rename/delete surface over the persisted conversations, rendered
// in a tab rather than a modal. The IPC boundary is mocked at the bindings
// module; the store side is real, so these tests prove which row action reaches
// which command with which id.

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { mockChatsList, mockChatsRename, mockChatsDelete, mockOpenConversation } =
  vi.hoisted(() => ({
    mockChatsList: vi.fn(),
    mockChatsRename: vi.fn(),
    mockChatsDelete: vi.fn(),
    mockOpenConversation: vi.fn(),
  }));

/**
 * The roster notifier the chats wrappers fire (myne-md/myne#771).
 *
 * A real registry rather than a no-op: the rail's whole subscription is under
 * test here, and a stub returning nothing would let it pass with no listener
 * at all. `announceRoster()` is what a create, a rename or a delete does from
 * inside `src/lib/chats.ts`.
 */
const rosterListeners = new Set<() => void>();
function announceRoster(): void {
  for (const listener of [...rosterListeners]) listener();
}

vi.mock("../../src/lib/chats", () => ({
  subscribeConversationRoster: (listener: () => void) => {
    rosterListeners.add(listener);
    return () => rosterListeners.delete(listener);
  },
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
  rosterListeners.clear();
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

  it("opens a conversation and shows it, carrying its anchor", async () => {
    // **With the note it is anchored to.** It opened by id alone, so the
    // anchor was dropped on the way in: a conversation whose every turn said
    // "Working on: This note" came back with no scope, and the composer asked
    // the user to choose a folder for a conversation that had been about a
    // note the whole time. The row already knows — `note_id` is on the catalog
    // row and is why the anchor chip renders beside it.
    mockChatsList.mockResolvedValue([{ ...row("c1", "One", 1), note_id: "n-9" }]);
    const onOpenFocus = vi.fn();
    render(<AgentHubList onOpenFocus={onOpenFocus} />);
    fireEvent.click((await screen.findAllByTestId("agent.hub-open"))[0]!);
    await waitFor(() =>
      expect(onOpenFocus).toHaveBeenCalledWith({
        conversationId: "c1",
        noteId: "n-9",
      }),
    );
    expect(mockOpenConversation).toHaveBeenCalledWith("c1");
  });

  it("says so plainly when a conversation has no anchor", async () => {
    // `null`, not absent: the pane writes the whole view from this call, so an
    // omitted key and an explicit "about no note" have to be the same thing or
    // a vault-general conversation would inherit the previous one's note.
    mockChatsList.mockResolvedValue([row("c1", "One", 1)]);
    const onOpenFocus = vi.fn();
    render(<AgentHubList onOpenFocus={onOpenFocus} />);
    fireEvent.click((await screen.findAllByTestId("agent.hub-open"))[0]!);
    await waitFor(() =>
      expect(onOpenFocus).toHaveBeenCalledWith({ conversationId: "c1", noteId: null }),
    );
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

describe("AgentHubList: the rail starts conversations", () => {
  // The defect this was written against SHIPPED: the list's first-run state
  // explained what conversations are and offered nothing to press, because
  // `<PanelEmptyState>` is hardwired to `firstRun` and cannot carry an action
  // at all. The surface whose whole job is to offer the thing that creates the
  // first thing had no way to create one.
  //
  // The control was then gated on a note being open, which was right while
  // opening a conversation meant opening a view that needed a scope. It is not
  // right now: a conversation is its own subject
  // (`docs/decisions/ai/0623`), and what still needs a note is SENDING, which
  // the composer refuses on its own. Gating the button refused the screen one
  // layer too early.

  it("offers the first action in the empty state", async () => {
    mockChatsList.mockResolvedValue([]);
    render(<AgentHubList onOpenFocus={vi.fn()} onNewConversation={vi.fn()} />);
    await screen.findByTestId("agent.hub-empty");
    expect(screen.getByTestId("agent.hub-new")).toBeTruthy();
  });

  it("offers it above a NON-empty list too", async () => {
    // Otherwise the rail is a surface you can only ever CONTINUE from: the
    // empty state's action disappears the moment there is one conversation,
    // and a user with a single old chat would have no way to begin a second.
    mockChatsList.mockResolvedValue([
      { id: "c1", title: "An old chat", updated_at: 2, created_at: 1, version: 1 },
    ]);
    render(<AgentHubList onOpenFocus={vi.fn()} onNewConversation={vi.fn()} />);
    await screen.findByTestId("agent.hub-row");
    expect(screen.getByTestId("agent.hub-new")).toBeTruthy();
  });

  it("CREATES rather than opening", async () => {
    // Two different acts down two different props. Collapsing them into "open
    // with no id" is exactly how a New-chat button ends up reopening the last
    // conversation, which is the shape this file's first version had.
    const onOpenFocus = vi.fn();
    const onNewConversation = vi.fn();
    mockChatsList.mockResolvedValue([]);
    render(
      <AgentHubList onOpenFocus={onOpenFocus} onNewConversation={onNewConversation} />,
    );
    await screen.findByTestId("agent.hub-empty");
    fireEvent.click(screen.getByTestId("agent.hub-new"));
    expect(onNewConversation).toHaveBeenCalledTimes(1);
    expect(onOpenFocus, "New chat must not reopen a conversation").not.toHaveBeenCalled();
  });

  it("CREATES from the list header too, not only from the empty state", async () => {
    // The two buttons are two call sites of one act, and only the empty one was
    // covered: injecting `onOpenFocus({})` into the header passed every test
    // here. A user with one old conversation uses the header button and nothing
    // else, so it is the one that matters most.
    const onOpenFocus = vi.fn();
    const onNewConversation = vi.fn();
    mockChatsList.mockResolvedValue([
      { id: "c1", title: "An old chat", updated_at: 2, created_at: 1, version: 1 },
    ]);
    render(
      <AgentHubList onOpenFocus={onOpenFocus} onNewConversation={onNewConversation} />,
    );
    await screen.findByTestId("agent.hub-row");
    fireEvent.click(screen.getByTestId("agent.hub-new"));
    expect(onNewConversation).toHaveBeenCalledTimes(1);
    expect(onOpenFocus, "New chat must not reopen a conversation").not.toHaveBeenCalled();
  });

  it("offers nothing to press where nothing can create one", async () => {
    // The light panel mounts this list with no `onNewConversation`: there is
    // one conversation there and the composer is the way to start it. An
    // always-rendered button would be one that does nothing.
    mockChatsList.mockResolvedValue([]);
    render(<AgentHubList onOpenFocus={vi.fn()} />);
    await screen.findByTestId("agent.hub-empty");
    expect(screen.queryByTestId("agent.hub-new")).toBeNull();
  });

  it("marks the row the pane is showing, not the one the store last loaded", async () => {
    // The chat store's active id is the LIVE transcript, which lags a
    // selection by a round trip — so a rail keyed off it highlights the
    // previous row for as long as the open takes.
    mockChatsList.mockResolvedValue([
      { id: "c1", title: "One", updated_at: 2, created_at: 1, version: 1 },
      { id: "c2", title: "Two", updated_at: 1, created_at: 1, version: 1 },
    ]);
    render(<AgentHubList onOpenFocus={vi.fn()} activeConversationId="c2" />);
    await screen.findAllByTestId("agent.hub-row");
    const rows = screen.getAllByTestId("agent.hub-row");
    expect((rows[1]!.firstElementChild as HTMLElement).getAttribute("aria-current")).toBe("true");
    expect((rows[0]!.firstElementChild as HTMLElement).getAttribute("aria-current")).toBeNull();
  });
});

describe("AgentHubList: a 248px rail is what the row has to fit in", () => {
  // The row held a title, an anchor pill, a date and two TEXT buttons
  // ("Rename", "Delete") on one line. That is far more than 248px, and because
  // the list sets `overflow-y: auto` — which per spec computes `overflow-x` to
  // `auto` rather than leaving it `visible` — the whole history scrolled
  // SIDEWAYS. Rows shifted half out of view with a scrollbar under them.

  async function rows() {
    mockChatsList.mockResolvedValue([
      {
        id: "c1",
        title: "a conversation with a title long enough to need ellipsizing",
        updated_at: 2,
        created_at: 1,
        version: 1,
        note_id: "n1",
      },
    ]);
    render(<AgentHubList onOpenFocus={vi.fn()} onOpenNote={vi.fn()} />);
    return await screen.findByTestId("agent.hub-row");
  }

  it("stacks the title over its meta rather than running them along one line", async () => {
    const row = await rows();
    const box = row.firstElementChild as HTMLElement;
    expect(box.style.flexDirection, "the row is still one line").toBe("column");
  });

  it("ellipsizes the title instead of widening the row", async () => {
    await rows();
    const title = screen.getByTestId("agent.hub-open");
    expect(title.style.textOverflow).toBe("ellipsis");
    expect(title.style.whiteSpace).toBe("nowrap");
    expect(title.style.minWidth, "a flex item floors at its content width").toBe("0px");
  });

  it("makes the two row actions icon-only", async () => {
    // As words they are most of the rail on their own. They keep their labels
    // as tooltips and as accessible names, per the epic's tooltip convention —
    // so what is lost is width, not meaning.
    await rows();
    for (const id of ["agent.hub-rename", "agent.hub-delete"]) {
      const button = screen.getByTestId(id);
      expect(button.querySelector("svg"), `${id} has no glyph`).not.toBeNull();
      expect(button.textContent?.trim(), `${id} still carries its word`).toBe("");
      expect(
        (button.getAttribute("aria-label") ?? "").length,
        `${id} is an unnamed glyph`,
      ).toBeGreaterThan(0);
    }
  });

  it("pins the list's horizontal overflow shut", async () => {
    // `overflow-y: auto` alone computes `overflow-x: auto`, so this is not
    // redundant with the default — it is the whole fix. A future row that
    // outgrows the rail truncates rather than bringing the sideways scroll
    // back.
    await rows();
    const list = screen.getByTestId("agent.hub-list");
    expect(list.style.overflowX).toBe("hidden");
    expect(list.style.minWidth).toBe("0px");
  });
});

describe("AgentHubList: the rail follows the roster", () => {
  // It loaded on mount and nothing told it anything afterwards, so a
  // conversation created by SENDING a message did not appear in the list
  // beside the reply that created it. It came back on the next mount, which is
  // what made it read as a refresh quirk rather than a missing subscription.

  it("re-reads when the roster changes", async () => {
    mockChatsList.mockResolvedValue([row("c1", "One", 1)]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    await screen.findByTestId("agent.hub-list");
    expect(mockChatsList).toHaveBeenCalledTimes(1);

    mockChatsList.mockResolvedValue([row("c2", "Two", 2), row("c1", "One", 1)]);
    await act(async () => {
      announceRoster();
    });
    await waitFor(() => expect(screen.getAllByTestId("agent.hub-row")).toHaveLength(2));
  });

  it("stops listening when it unmounts", async () => {
    // A rail that keeps its listener is a `setState` after unmount on every
    // later write, for the life of the session.
    mockChatsList.mockResolvedValue([row("c1", "One", 1)]);
    const { unmount } = render(<AgentHubList onOpenFocus={() => {}} />);
    await screen.findByTestId("agent.hub-list");
    unmount();
    const before = mockChatsList.mock.calls.length;
    announceRoster();
    expect(mockChatsList.mock.calls.length).toBe(before);
  });
});
