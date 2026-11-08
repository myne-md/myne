// The agent Hub conversation list (myne-md/myne#771 task 3).
//
// The list/open/rename/delete surface over the persisted conversations, rendered
// in a tab rather than a modal. The IPC boundary is mocked at the bindings
// module; the store side is real, so these tests prove which row action reaches
// which command with which id.

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const {
  mockChatsList,
  mockChatsRename,
  mockChatsDelete,
  mockChatsRead,
  mockParseTranscript,
  mockOpenConversation,
} = vi.hoisted(() => ({
  mockChatsList: vi.fn(),
  mockChatsRename: vi.fn(),
  mockChatsDelete: vi.fn(),
  // The hover preview reads ONE conversation back (myne-md/myne#848), so the
  // bindings module needs both halves of that path.
  mockChatsRead: vi.fn(),
  mockParseTranscript: vi.fn(),
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

const noteTitles = vi.hoisted(
  () => new Map<string, { title: string | null }>(),
);
const {
  mockCommitNoteRename,
  mockGenerateNoteTitle,
  mockLoadModelPath,
  mockNoteRead,
  mockFlushBeforeFrontmatterWrite,
} = vi.hoisted(() => ({
  mockCommitNoteRename: vi.fn(),
  mockGenerateNoteTitle: vi.fn(),
  mockLoadModelPath: vi.fn(),
  mockNoteRead: vi.fn(),
  mockFlushBeforeFrontmatterWrite: vi.fn(),
}));
vi.mock("../../src/notes/sidebarState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/notes/sidebarState")>()),
  // The anchor pill reads a note's NAME from the sidebar's cache
  // (myne-md/myne#848), and the title action renames through the sidebar's
  // transactional path. The provider is not mounted here, and mounting the whole
  // sidebar to render a rail would be a different test.
  useSelectedNote: () => ({
    cache: noteTitles,
    commitRename: (...a: unknown[]) => mockCommitNoteRename(...a),
  }),
}));
vi.mock("../../src/notes/ai/noteTitle", () => ({
  generateNoteTitle: (...a: unknown[]) => mockGenerateNoteTitle(...a),
}));
// The title write's own two halves (review finding): the flush that must come
// first, and the body read at commit time.
vi.mock("../../src/notes/flushBeforeFrontmatterWrite", () => ({
  flushBeforeFrontmatterWrite: (...a: unknown[]) =>
    mockFlushBeforeFrontmatterWrite(...a),
}));
vi.mock("../../src/notes/readNote", () => ({
  noteRead: (...a: unknown[]) => mockNoteRead(...a),
}));
vi.mock("../../src/lib/ai-model-store", () => ({
  loadModelPath: (...a: unknown[]) => mockLoadModelPath(...a),
}));

vi.mock("../../src/lib/chats", () => ({
  subscribeConversationRoster: (listener: () => void) => {
    rosterListeners.add(listener);
    return () => rosterListeners.delete(listener);
  },
  chatsList: mockChatsList,
  chatsRename: mockChatsRename,
  chatsDelete: mockChatsDelete,
  chatsRead: mockChatsRead,
}));

vi.mock("../../src/notes/ai/chatPersist", () => ({
  openConversation: mockOpenConversation,
  clearChatPersistForLock: vi.fn(),
  parseTranscript: mockParseTranscript,
}));

vi.mock("react-i18next", () => ({
  // `name` is interpolated so the anchor pill's accessible name can be asserted
  // WITH the note in it (myne-md/myne#848) rather than merely that a key
  // rendered, which is the whole claim the pill makes.
  useTranslation: () => ({
    t: (key: string, opts?: { name?: string }) =>
      opts?.name !== undefined ? `${key}:${opts.name}` : key,
  }),
}));

vi.mock("../../src/lib/useDateTimeDisplay", () => ({
  useDateTimeDisplay: () => ({ locale: "en", timeZone: null }),
}));

import { AgentHubList } from "../../src/notes/agent/AgentHubList";
import {
  beginRun,
  clearAgentForLock,
  currentRunEpoch,
  markConversationRead,
  markConversationUnread,
  openRun,
  settleStep,
} from "../../src/notes/agent/agentStore";

function row(id: string, title: string, updatedAt: number) {
  return { id, title, created_at: 1, updated_at: updatedAt, version: 1 };
}

beforeEach(() => {
  rosterListeners.clear();
  mockCommitNoteRename.mockReset().mockResolvedValue(undefined);
  mockGenerateNoteTitle.mockReset();
  mockLoadModelPath.mockReset().mockResolvedValue("/models/qwen.gguf");
  mockChatsList.mockReset();
  mockChatsRename.mockReset();
  mockChatsDelete.mockReset();
  mockChatsRead.mockReset();
  mockChatsRead.mockResolvedValue("{}");
  mockParseTranscript.mockReset();
  mockParseTranscript.mockReturnValue(null);
  mockOpenConversation.mockReset();
  mockOpenConversation.mockResolvedValue("opened");
});

afterEach(() => {
  cleanup();
  clearAgentForLock();
});

/** **The row actions live behind a menu now** (myne-md/myne#848), so every test
 *  that presses one opens the row's menu first. One helper, because the five
 *  call sites otherwise each carry the same two lines and one of them would
 *  eventually forget. */
async function openRowMenu(index = 0): Promise<void> {
  fireEvent.click((await screen.findAllByTestId("agent.hub-menu"))[index]!);
}

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
    await openRowMenu();
    fireEvent.click(screen.getByTestId("agent.hub-rename"));
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

  it("names the note on the anchor chip, not just the kind of anchor", async () => {
    // **"On a note" told a reader the KIND of anchor and nothing else**
    // (myne-md/myne#848, on the user's ask), on the one line where "which note?"
    // was answerable all along: the sidebar's cache holds every title and the
    // row carries the id.
    noteTitles.set("n-7", { title: "Weekly review" });
    mockChatsList.mockResolvedValue([{ ...row("c1", "On a note", 1), note_id: "n-7" }]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    const anchor = await screen.findByTestId("agent.hub-anchor");
    expect(anchor.textContent).toContain("Weekly review");
    // The FULL name is what a screen reader gets and what the tooltip shows;
    // the visible text ellipsizes, because the pill sits in a 248px row beside
    // the date.
    expect(anchor.getAttribute("aria-label")).toBe("agent.hub.anchorOpen:Weekly review");
    // **A `<Tooltip>`, not the native attribute** (review finding): focus shows
    // the bubble immediately, so it is assertable, and the native `title` is
    // asserted ABSENT so the convention cannot quietly come back.
    expect(anchor.getAttribute("title")).toBeNull();
    fireEvent.focus(anchor);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Weekly review");
    // It can shrink, so the date beside it never moves: `.myne-pill` ships
    // `flex-shrink: 0`, which is right for a fixed label and wrong for a name.
    expect(anchor.style.flexShrink).toBe("1");
    // The date is still beside it, and it is the pill that gives way. The pill
    // sits inside the Tooltip's wrapper now (review finding), so the date is one
    // level out rather than the immediate sibling.
    expect(anchor.parentElement?.nextElementSibling?.textContent ?? "").not.toBe("");
    noteTitles.clear();
  });

  it("falls back to the KIND when the note is not in the cache", async () => {
    // A deleted note, or a vault whose sidebar has not filled yet. Inventing a
    // name would be worse than saying what kind of anchor it is.
    mockChatsList.mockResolvedValue([{ ...row("c1", "On a note", 1), note_id: "gone" }]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    const anchor = await screen.findByTestId("agent.hub-anchor");
    expect(anchor.textContent).toContain("agent.hub.anchorLabel");
    expect(anchor.getAttribute("aria-label")).toBe("agent.hub.targetNote");
    expect(anchor.getAttribute("title")).toBeNull();
  });

  it("deletes through the command after an inline confirm", async () => {
    mockChatsList.mockResolvedValue([row("c1", "One", 1)]);
    mockChatsDelete.mockResolvedValue(undefined);
    render(<AgentHubList onOpenFocus={() => {}} />);
    await openRowMenu();
    fireEvent.click(screen.getByTestId("agent.hub-delete"));
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
  // (`agent-tooling/design-notes/ai/0637`), and what still needs a note is SENDING, which
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
    // Found by testid, not by `firstElementChild`: the card sits inside its
    // tooltip's wrapper now (myne-md/myne#848), so position stopped meaning
    // anything.
    const cards = screen.getAllByTestId("agent.hub-card");
    expect(cards[1]!.getAttribute("aria-current")).toBe("true");
    expect(cards[0]!.getAttribute("aria-current")).toBeNull();
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
    await rows();
    const card = screen.getAllByTestId("agent.hub-card")[0]!;
    expect(card.style.flexDirection, "the row is still one line").toBe("column");
  });

  it("ellipsizes the title instead of widening the row", async () => {
    await rows();
    const title = screen.getByTestId("agent.hub-open");
    expect(title.style.textOverflow).toBe("ellipsis");
    expect(title.style.whiteSpace).toBe("nowrap");
    expect(title.style.minWidth, "a flex item floors at its content width").toBe("0px");
  });

  it("keeps the row's ONE control icon-only, and the menu items worded", async () => {
    // **The two actions moved behind a menu** (myne-md/myne#848). What the row
    // spends width on is now a single glyph; what the user reads when they open
    // it are words, which a panel has room for. So this asserts BOTH halves,
    // because either one alone would pass with the other broken: an icon-only
    // trigger with no accessible name is a mystery button, and a menu that
    // reopened as two more glyphs would have moved the problem rather than
    // solved it.
    await rows();
    const trigger = screen.getByTestId("agent.hub-menu");
    expect(trigger.querySelector("svg"), "the trigger has no glyph").not.toBeNull();
    expect(trigger.textContent?.trim(), "the trigger carries a word").toBe("");
    expect(
      (trigger.getAttribute("aria-label") ?? "").length,
      "the trigger is an unnamed glyph",
    ).toBeGreaterThan(0);

    await openRowMenu();
    for (const id of ["agent.hub-rename", "agent.hub-delete"]) {
      const item = screen.getByTestId(id);
      expect(item.textContent?.trim(), `${id} lost its word`).not.toBe("");
    }
  });

  it("pins the list's horizontal overflow shut", async () => {
    // `overflow-y: auto` alone computes `overflow-x: auto`, so this is not
    // redundant with the default — it is the whole fix. A future row that
    // outgrows the rail truncates rather than bringing the sideways scroll
    // back.
    await rows();
    // The testid is on the ScrollArea's wrapper; the scroller is its first
    // child, and it is the box that scrolls.
    const list = screen.getByTestId("agent.hub-list");
    const scroller = list.firstElementChild as HTMLElement;
    expect(scroller.className).toContain("myne-scrollarea");
    expect(scroller.style.overflowX).toBe("hidden");
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

describe("AgentHubList: the row's actions sit at the far edge", () => {
  it("pushes them there with a rule the title's wrapper cannot swallow", async () => {
    // `TITLE_STYLE` carries `flex: 1` and it was not enough: the title button
    // is inside a `<Tooltip>`, so the row's flex item is the TOOLTIP's wrapper
    // and the grow sits on a child of it, where the free space never reaches.
    // The actions ended up hugging the end of each title, landing in a
    // different place on every row.
    //
    // Asserted on the ACTIONS' own container rather than on the title's flex,
    // because that is the property: wherever the title's markup goes next, the
    // pair stays at the edge.
    mockChatsList.mockResolvedValue([row("c-1", "hi", 100)]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    const actions = await screen.findByTestId("agent.hub-row-actions");
    expect(actions.style.marginInlineStart, "not pushed to the edge").toBe("auto");
    // Both controls, or aligning it moves one and leaves the other behind.
    // `contains` rather than `parentElement`, because each IconButton is
    // itself inside a tooltip wrapper — which is the very indirection that
    // broke the title's `flex: 1` in the first place.
    // The cluster's contents, opened: the trigger is always in it, and the menu
    // items render inside it too (myne-md/myne#848).
    expect(actions.contains(screen.getByTestId("agent.hub-menu"))).toBe(true);
    await openRowMenu();
    // The menu is a PORTAL now, and that is the fix: inside the cluster the
    // scrolling rail clipped it (myne-md/myne#848). Asserted the other way
    // round, so a future move back inside the row fails here.
    const menu = screen.getByTestId("agent.hub-menu-list");
    expect(actions.contains(menu), "the menu is back inside the row").toBe(false);
    expect(document.body.contains(menu)).toBe(true);
    expect(actions.contains(screen.getByTestId("agent.hub-rename"))).toBe(false);
    expect(menu.contains(screen.getByTestId("agent.hub-rename"))).toBe(true);
    expect(menu.contains(screen.getByTestId("agent.hub-delete"))).toBe(true);
    // It must not itself grow, or the pair absorbs the row's slack and ends up
    // back beside the title.
    // `flexGrow` rather than the `flex` shorthand: the DOM normalises
    // `flex: none` to `0 0 auto`, and the assertion that matters is the grow
    // term — a pair that grows absorbs the row's slack and lands back beside
    // the title, which is the defect, not the spelling.
    expect(actions.style.flexGrow, "the actions grow").toBe("0");
  });
});

describe("AgentHubList, the card (myne-md/myne#848)", () => {
  async function cards() {
    return await screen.findAllByTestId("agent.hub-card");
  }

  it("opens the conversation from ANYWHERE on the card, not only the title", async () => {
    // The title was the only target, so the obvious gesture, click the thing
    // you are looking at, did nothing on the 90% of the card that is not the
    // title. The card's own handler is what this asserts.
    mockChatsList.mockResolvedValue([row("c1", "One", 1)]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    fireEvent.click((await cards())[0]!);
    await waitFor(() => expect(mockOpenConversation).toHaveBeenCalledWith("c1"));
  });

  it("states all THREE target kinds, each with its own icon", async () => {
    // A folder scope, a note anchor, or neither, the three things a
    // conversation can be about (myne-md/myne#848). `folder` is the additive
    // catalog field that made the third expressible; before it, a folder-scoped
    // conversation and a vault-general one were the same row.
    mockChatsList.mockResolvedValue([
      { ...row("c1", "One", 1), note_id: "n1" },
      { ...row("c2", "Two", 2), folder: "Projects" },
      row("c3", "Three", 3),
    ]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    const targets = (await screen.findAllByTestId("agent.hub-target"))
      .map((el) => el.getAttribute("data-target"))
      .sort();
    // Order-insensitive: the list is newest-first, so this asserts the SET of
    // icons rather than the sort.
    expect(targets).toEqual(["folder", "note", "vault"]);
    // Every one carries an accessible name and a glyph, so the fact is not in
    // the icon alone.
    for (const el of screen.getAllByTestId("agent.hub-target")) {
      expect((el.getAttribute("aria-label") ?? "").length).toBeGreaterThan(0);
      expect(el.querySelector("svg")).not.toBeNull();
    }
  });

  it("shows the actions only on hover OR on focus, and reveals them on focus", async () => {
    mockChatsList.mockResolvedValue([row("c1", "One", 1)]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    const actions = await screen.findByTestId("agent.hub-row-actions");
    expect(actions.style.opacity).toBe("0");

    fireEvent.mouseEnter((await cards())[0]!);
    expect(actions.style.opacity).toBe("1");

    // **Keyboard reachability is the half that has no mouse.** The menu is
    // invisible at rest, so a focus event on the trigger has to reveal it, which
    // is why the reveal is `opacity` and not `display`, and why the focus
    // listener sits on the container (focus events bubble) rather than on the
    // button, whose props cannot carry one.
    fireEvent.mouseLeave((await cards())[0]!);
    expect(actions.style.opacity).toBe("0");
    fireEvent.focus(screen.getByTestId("agent.hub-menu"));
    expect(actions.style.opacity).toBe("1");
  });

  it("marks the open conversation as different AT REST", async () => {
    mockChatsList.mockResolvedValue([row("c1", "One", 1), row("c2", "Two", 2)]);
    render(<AgentHubList onOpenFocus={() => {}} activeConversationId="c2" />);
    // The list is newest-first, so the open row is not necessarily the first:
    // find it by id rather than by position, or this test would pass on the
    // wrong row the moment the order changed.
    const all = await cards();
    const open = all.find((c) => c.getAttribute("data-conversation-id") === "c2")!;
    const other = all.find((c) => c.getAttribute("data-conversation-id") === "c1")!;
    expect(open.getAttribute("data-active")).toBe("true");
    expect(open.style.background).not.toBe(other.style.background);
    expect(open.getAttribute("aria-current")).toBe("true");
  });

  it("shows the user's opening words on hover, from the conversation itself", async () => {
    mockChatsList.mockResolvedValue([row("c1", "One", 1)]);
    mockParseTranscript.mockReturnValue([
      { id: "t1", kind: "text", role: "user", text: "kirayı öde", error: false },
      { id: "t2", kind: "text", role: "assistant", text: "tamam", error: false },
    ]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    expect(screen.queryByTestId("agent.hub-preview")).toBeNull();

    fireEvent.mouseEnter((await cards())[0]!);
    // The words arrive from a read, so wait for the card to report them before
    // asking the tooltip: the label falls back to the title until then, which is
    // the honest state of a row whose conversation has not been read back yet.
    await waitFor(() =>
      expect(screen.getAllByTestId("agent.hub-card")[0]!.getAttribute("data-hover-preview")).toBe(
        "true",
      ),
    );
    // **In a TOOLTIP, not in the card** (myne-md/myne#848): rendering it as a
    // line inside the card grew the row and pushed the list under the pointer.
    // Focus shows the bubble immediately, which is what makes it assertable.
    fireEvent.focus(screen.getAllByTestId("agent.hub-open")[0]!);
    const bubble = document.querySelector('[role="tooltip"]');
    // The USER's words, not the model's.
    expect(bubble?.textContent).toBe("kirayı öde");
    // Read once for the hovered row, and never the whole list.
    expect(mockChatsRead).toHaveBeenCalledTimes(1);
    expect(mockChatsRead).toHaveBeenCalledWith("c1");
  });

  it("does not put one conversation's words on another's card", async () => {
    // The reply is in flight while the pointer moves, which is the ordinary case
    // and the one a bare `text` state would get wrong.
    mockChatsList.mockResolvedValue([row("c1", "One", 1), row("c2", "Two", 2)]);
    mockParseTranscript.mockReturnValue([
      { id: "t1", kind: "text", role: "user", text: "c1'in sözleri", error: false },
    ]);
    let release: ((v: string) => void) | null = null;
    mockChatsRead.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    );
    render(<AgentHubList onOpenFocus={() => {}} />);
    const [first, second] = await cards();
    fireEvent.mouseEnter(first!);
    fireEvent.mouseEnter(second!);
    // First row's read lands late, while the pointer is on the second row.
    await act(async () => {
      release?.("{}");
    });
    expect(screen.queryByTestId("agent.hub-preview")).toBeNull();
    expect(first!.getAttribute("data-hover-preview")).toBe("false");
  });
});

// myne-md/myne#848. A row has to keep its date and its controls in every state a
// row can be in, the task's own words. Two states were producing a wrong answer
// and are named here rather than guessed at:
//
//   1. a row whose `updated_at` is zero or absent, which rendered 1970 or the
//      string "Invalid Date", both of which read as a fact about the
//      conversation rather than as a missing timestamp;
//   2. a RUNNING row, whose action cluster is revealed by pointing at it, while
//      a run in flight is exactly the case where the user is looking elsewhere.
describe("AgentHubList, a model-written title for the note (myne-md/myne#848)", () => {
  async function openMenu(): Promise<void> {
    await openRowMenu();
  }

  it("offers the action only for a conversation that IS about a note", async () => {
    mockChatsList.mockResolvedValue([
      { ...row("c-note", "One", 2), note_id: "n-1" },
      row("c-vault", "Two", 1),
    ]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    await screen.findByTestId("agent.hub-list");
    // Two cards, two menus, and only the note-anchored one carries the item.
    const triggers = screen.getAllByTestId("agent.hub-menu");
    fireEvent.click(triggers[1]!); // the vault-general row, newest first
    expect(screen.queryByTestId("agent.hub-generate-title")).toBeNull();
    fireEvent.click(triggers[0]!);
    expect(screen.getByTestId("agent.hub-generate-title")).toBeTruthy();
  });

  it("is disabled, with the reason in its name, when no local model is installed", async () => {
    // The request class bars a provider, so the action cannot run anywhere else.
    // Disabled rather than hidden: a control that disappears teaches nothing.
    mockLoadModelPath.mockResolvedValue(null);
    mockChatsList.mockResolvedValue([{ ...row("c-note", "One", 1), note_id: "n-1" }]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    await screen.findByTestId("agent.hub-list");
    await openMenu();
    await waitFor(() =>
      expect(
        screen.getByTestId("agent.hub-generate-title").hasAttribute("disabled"),
      ).toBe(true),
    );
    expect(
      screen.getByTestId("agent.hub-generate-title").getAttribute("aria-label"),
    ).toBe("agent.hub.generateTitleNeedsModel");
  });

  it("renames the NOTE through the sidebar's transactional path", async () => {
    mockGenerateNoteTitle.mockResolvedValue({
      kind: "ready",
      title: "Cell biology",
    });
    mockNoteRead.mockResolvedValue("---\ntitle: Old\n---\n\nbody");
    mockChatsList.mockResolvedValue([{ ...row("c-note", "One", 1), note_id: "n-1" }]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    await screen.findByTestId("agent.hub-list");
    await openMenu();
    fireEvent.click(screen.getByTestId("agent.hub-generate-title"));
    await waitFor(() =>
      expect(mockCommitNoteRename).toHaveBeenCalledWith(
        "n-1",
        "---\ntitle: Old\n---\n\nbody",
        "Cell biology",
      ),
    );
    // **The FLUSH comes first, and the read after it** (review finding): the
    // body used to be the one the model was asked about, seconds earlier, so
    // anything that landed in between was overwritten by the rename. Asserting
    // the ORDER is the whole point: both calls happen either way.
    expect(
      mockFlushBeforeFrontmatterWrite.mock.invocationCallOrder[0]!,
    ).toBeLessThan(mockNoteRead.mock.invocationCallOrder[0]!);
    // And the model was asked with the note's folder verdict, not blind.
    expect(mockGenerateNoteTitle).toHaveBeenCalledWith("n-1", true);
    // And it is ANNOUNCED: the pill beside it renames itself, which a screen
    // reader cannot see happen.
    expect(screen.getByTestId("agent.hub-announcer").textContent).toBe(
      "agent.hub.titleGenerated:Cell biology",
    );
  });

  it("says so when the model answered with nothing usable", async () => {
    mockGenerateNoteTitle.mockResolvedValue({ kind: "no-title" });
    mockChatsList.mockResolvedValue([{ ...row("c-note", "One", 1), note_id: "n-1" }]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    await screen.findByTestId("agent.hub-list");
    await openMenu();
    fireEvent.click(screen.getByTestId("agent.hub-generate-title"));
    await waitFor(() =>
      expect(screen.getByTestId("agent.hub-title-notice").textContent).toBe(
        "agent.hub.titleFailed",
      ),
    );
    expect(mockCommitNoteRename).not.toHaveBeenCalled();
  });

  it("reports a failed write rather than claiming the note was renamed", async () => {
    mockGenerateNoteTitle.mockResolvedValue({
      kind: "ready",
      title: "Cell biology",
      bytes: "b",
    });
    mockCommitNoteRename.mockRejectedValue(new Error("disk"));
    mockChatsList.mockResolvedValue([{ ...row("c-note", "One", 1), note_id: "n-1" }]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    await screen.findByTestId("agent.hub-list");
    await openMenu();
    fireEvent.click(screen.getByTestId("agent.hub-generate-title"));
    await waitFor(() =>
      expect(screen.getByTestId("agent.hub-title-notice").textContent).toBe(
        "agent.hub.titleSaveFailed",
      ),
    );
    expect(screen.getByTestId("agent.hub-announcer").textContent).not.toContain(
      "titleGenerated",
    );
  });

  it("takes the reason from the outcome when the model vanished mid-flight", async () => {
    // The gate is read on mount and the model can be removed before the press.
    mockGenerateNoteTitle.mockResolvedValue({ kind: "unavailable" });
    mockChatsList.mockResolvedValue([{ ...row("c-note", "One", 1), note_id: "n-1" }]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    await screen.findByTestId("agent.hub-list");
    await openMenu();
    fireEvent.click(screen.getByTestId("agent.hub-generate-title"));
    await waitFor(() =>
      expect(screen.getByTestId("agent.hub-title-notice").textContent).toBe(
        "agent.hub.generateTitleNeedsModel",
      ),
    );
    // And the item now says so itself.
    await openMenu();
    await waitFor(() =>
      expect(
        screen.getByTestId("agent.hub-generate-title").hasAttribute("disabled"),
      ).toBe(true),
    );
  });
});

describe("AgentHubList, a finished run is a thing to read (myne-md/myne#848)", () => {
  /** The store as a run leaves it: an id, a view, a settled end, a proposal. */
  function settleWith(conversationId: string, edits: number): void {
    beginRun(conversationId);
    openRun(
      { runId: "r1", scopeTotal: 7, userGrants: 1, modelGrants: 0, cancelled: false },
      currentRunEpoch(),
    );
    settleStep(
      {
        view: {
          runId: "r1",
          scopeTotal: 7,
          userGrants: 1,
          modelGrants: 0,
          cancelled: false,
        },
        proposal: {
          edits: Array.from({ length: edits }, () => ({
            anchor: "a",
            replacement: "b",
          })) as never,
          newNotes: [],
          summary: "done",
        },
        end: { kind: "finished" },
        iterations: 1,
        notesRead: 1,
        charsOffDevice: null,
        excludedCount: 0,
        memoryUpdated: 0,
      },
      currentRunEpoch(),
    );
  }

  it("marks the card, and says what finished, while it is unread", async () => {
    mockChatsList.mockResolvedValue([row("c-run", "One", 100)]);
    settleWith("c-run", 3);
    markConversationUnread("c-run");
    render(<AgentHubList onOpenFocus={() => {}} />);
    // The dot: drawn at rest, so a scan finds it without pointing at the card.
    expect(await screen.findByTestId("agent.hub-unread")).toBeTruthy();
    // And the line says what is waiting, in the same words the transcript uses.
    // This file's i18n stub echoes the key, so the assertion is on the key.
    const done = screen.getByTestId("agent.hub-done");
    expect(done.textContent).toContain("agent.progress.done");
    expect(done.textContent).toContain("agent.review.noteHeading");
    // The running line is NOT beside it: the run has settled.
    expect(screen.queryByTestId("agent.hub-state")).toBeNull();
  });

  it("says 'waiting for you' for a run parked on a scope question", async () => {
    mockChatsList.mockResolvedValue([row("c-run", "One", 100)]);
    beginRun("c-run");
    settleStep(
      {
        view: {
          runId: "r1",
          scopeTotal: 1,
          userGrants: 1,
          modelGrants: 0,
          cancelled: false,
        },
        proposal: { edits: [], newNotes: [], summary: "" },
        end: { kind: "awaitingScope", folder: "Projects", reason: "to find the notes" },
        iterations: 1,
        notesRead: 1,
        charsOffDevice: null,
        excludedCount: 0,
        memoryUpdated: 0,
      },
      currentRunEpoch(),
    );
    markConversationUnread("c-run");
    render(<AgentHubList onOpenFocus={() => {}} />);
    // A run BLOCKED on the user is the case with the most reason to be marked,
    // and the label is the one the transcript already uses.
    expect((await screen.findByTestId("agent.hub-done")).textContent).toContain(
      "agent.progress.awaitingScope",
    );
  });

  it("keeps the dot, and claims nothing, for a run the store no longer holds", async () => {
    // Two conversations, and the live run belongs to the second: the count for
    // the first would be a claim about a run this store does not have.
    mockChatsList.mockResolvedValue([
      row("c-old", "Older", 300),
      row("c-live", "Newer", 100),
    ]);
    settleWith("c-live", 2);
    markConversationUnread("c-old");
    markConversationUnread("c-live");
    render(<AgentHubList onOpenFocus={() => {}} />);
    const cards = await screen.findAllByTestId("agent.hub-card");
    const old = cards.find((c) => c.getAttribute("data-conversation-id") === "c-old")!;
    expect(old.contains(screen.getAllByTestId("agent.hub-unread")[0]!)).toBe(true);
    // One dot per unread card, and exactly one line, the live run's.
    expect(screen.getAllByTestId("agent.hub-unread").length).toBe(2);
    expect(screen.getAllByTestId("agent.hub-done").length).toBe(1);
  });

  it("takes the mark off a card the user has opened", async () => {
    mockChatsList.mockResolvedValue([row("c-run", "One", 100)]);
    settleWith("c-run", 1);
    markConversationUnread("c-run");
    render(<AgentHubList onOpenFocus={() => {}} />);
    expect(await screen.findByTestId("agent.hub-unread")).toBeTruthy();
    // What `ConversationSurface` does while it displays the conversation. The
    // rail's own job is only to show what the store says.
    act(() => markConversationRead("c-run"));
    await waitFor(() =>
      expect(screen.queryByTestId("agent.hub-unread")).toBeNull(),
    );
  });
});

describe("AgentHubList, every state a row can be in", () => {
  it("shows the created date when updated_at is zero", async () => {
    // Zero is what a row written before the catalog carried an update time reads
    // back as, and `new Date(0)` rendered as "Jan 20, 1970" beside a
    // conversation created five minutes ago.
    mockChatsList.mockResolvedValue([
      { ...row("c1", "One", 0), created_at: Date.UTC(2026, 0, 20) },
    ]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    const rowEl = (await screen.findAllByTestId("agent.hub-card"))[0]!;
    const meta = rowEl.lastElementChild!.textContent ?? "";
    expect(meta).not.toBe("");
    expect(meta).not.toContain("Invalid Date");
    expect(meta).not.toContain("1970");
    // The created date, not the zero. The YEAR is omitted for the current year
    // by `relativeDay`'s own rule, so the month is the assertion.
    expect(meta).toContain("Jan");
  });

  it("shows a date for a row that carries no updated_at at all", async () => {
    mockChatsList.mockResolvedValue([
      {
        ...row("c1", "One", 0),
        updated_at: undefined as unknown as number,
        created_at: Date.UTC(2026, 4, 2),
      },
    ]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    const meta = (await screen.findAllByTestId("agent.hub-card"))[0]!.lastElementChild!
      .textContent ?? "";
    expect(meta).toContain("May");
    expect(meta).not.toContain("Invalid Date");
  });

  it("marks the card you PRESSED before the surface reports one", async () => {
    // myne-md/myne#848. The active id arrives a round trip late (read the
    // conversation, bind the transcript), so a rail keyed only off it marked the
    // previous row while the open was in flight. Invisible while the mark was a
    // tint; with the accent border it read as "every card I press highlights the
    // wrong one".
    mockChatsList.mockResolvedValue([row("c1", "One", 2), row("c2", "Two", 1)]);
    render(<AgentHubList onOpenFocus={vi.fn()} activeConversationId="c2" />);
    const cards = await screen.findAllByTestId("agent.hub-card");
    const one = cards.find((c) => c.getAttribute("data-conversation-id") === "c1")!;
    expect(one.getAttribute("data-active")).toBe("false");
    fireEvent.click(one);
    // Immediately, with no prop change: the press is the user's intent.
    expect(one.getAttribute("data-active")).toBe("true");
    expect(one.style.boxShadow).toContain("accent");
  });

  it("never makes a paragraph out of the hover tooltip", async () => {
    // The bubble is ONE line (`white-space: nowrap`), so a full first message
    // rendered as a 900px ribbon across the window (myne-md/myne#848).
    const long =
      "inbox folder'ımdaki dosyaları vaultta gerekli yerlere taşımam lazım nelerelere taşımamı önerirsin";
    mockChatsList.mockResolvedValue([row("c1", "One", 1)]);
    mockParseTranscript.mockReturnValue([
      { id: "t1", kind: "text", role: "user", text: long, error: false },
    ]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    const card = (await screen.findAllByTestId("agent.hub-card"))[0]!;
    fireEvent.mouseEnter(card);
    await waitFor(() =>
      expect(card.getAttribute("data-hover-preview")).toBe("true"),
    );
    fireEvent.focus(screen.getAllByTestId("agent.hub-open")[0]!);
    const bubble = document.querySelector('[role="tooltip"]');
    const shown = bubble?.textContent ?? "";
    expect(shown.length).toBeLessThanOrEqual(61);
    expect(shown.endsWith("\u2026")).toBe(true);
    // The opening words, still recognizable.
    expect(shown.startsWith("inbox folder")).toBe(true);
  });

  it("does not clip what hangs off the card", async () => {
    // `overflow: hidden` was added for the title and cropped both the three-dot
    // menu (absolutely positioned past the card's edge) and the rename field
    // (rendered below it) (myne-md/myne#848).
    mockChatsList.mockResolvedValue([row("c1", "One", 1)]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    const card = (await screen.findAllByTestId("agent.hub-card"))[0]!;
    expect(card.style.overflow).not.toBe("hidden");
    expect(card.style.minWidth).toBe("0px");
  });

  it("shows the running conversation's STATE on its own card", async () => {
    // myne-md/myne#848. A spinner alone says "something is happening
    // somewhere"; what a user scanning the rail needs is the state, because the
    // run belongs to the conversation rather than to the pane that started it.
    mockChatsList.mockResolvedValue([row("c-run", "One", Date.UTC(2026, 4, 2))]);
    beginRun("c-run");
    openRun(
      { runId: "r1", scopeTotal: 7, userGrants: 1, modelGrants: 0, cancelled: false },
      currentRunEpoch(),
    );
    render(<AgentHubList onOpenFocus={() => {}} />);
    const state = await screen.findByTestId("agent.hub-state");
    expect(state.textContent).toContain("agent.progress.working");
    // **And NOT the scope figure** (myne-md/myne#848, on the user's read): "can
    // change 431 notes" is the same sentence on every card, because the scope is
    // what the composer was set to rather than anything about the conversation,
    // and the composer states it with the count the decision rests on.
    expect(state.textContent).not.toContain("agent.progress.scopeTotal");
    // It breathes, like the transcript's line does, so the two surfaces cannot
    // report the same run as one alive and one hung.
    expect(state.className).toContain("myne-working-wave");
    expect(state.getAttribute("data-motion")).toBe("essential");
  });

  it("marks the open card with the ACCENT border, not only a tint", async () => {
    mockChatsList.mockResolvedValue([row("c1", "One", 1), row("c2", "Two", 2)]);
    render(<AgentHubList onOpenFocus={() => {}} activeConversationId="c2" />);
    const cards = await screen.findAllByTestId("agent.hub-card");
    const open = cards.find((c) => c.getAttribute("data-conversation-id") === "c2")!;
    const other = cards.find((c) => c.getAttribute("data-conversation-id") === "c1")!;
    // An INSET ring, not a border: a border on every card read as "every card is
    // highlighted", and a real border would reflow the list by a pixel when the
    // mark moved (myne-md/myne#848).
    expect(open.style.boxShadow).toContain("accent");
    expect(other.style.boxShadow).toBe("");
  });

  it("keeps the whole truncation chain able to give way", async () => {
    // **jsdom has no layout, so what is asserted is the chain that decides it.**
    // A title longer than the card is truncated by the BUTTON's own
    // `overflow`/`text-overflow`, and every box between the row and that button
    // has to be able to shrink, a flex item's automatic minimum size is its
    // min-content, and a `nowrap` string reports the WHOLE string as its
    // min-content. The link that was missing was the tooltip's wrapper: it held
    // the full width, the slot around it could not shrink, and the text ran past
    // the card with no ellipsis at all (myne-md/myne#848, on the user's
    // screenshot).
    mockChatsList.mockResolvedValue([
      row("c-1", "a very long conversation title that cannot possibly fit", 1),
    ]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    const title = await screen.findByTestId("agent.hub-open");
    // The truncating box: it clips AND says so.
    expect(title.style.overflow).toBe("hidden");
    expect(title.style.textOverflow).toBe("ellipsis");
    expect(title.style.minWidth).toBe("0px");
    // …and the two wrappers between it and the row can give way, or the button
    // is never asked to be narrower than its text.
    const tooltipWrapper = title.parentElement as HTMLElement;
    expect(tooltipWrapper.style.minWidth, "the tooltip wrapper holds the full text width").toBe(
      "0px",
    );
    const slot = tooltipWrapper.parentElement as HTMLElement;
    expect(slot.style.flexShrink).toBe("1");
    expect(slot.style.minWidth).toBe("0px");
    // And the row it lives in can shrink with the card.
    expect((slot.parentElement as HTMLElement).style.minWidth).toBe("0px");
  });

  it("puts the title's tooltip on the title's own box, not the row's slack", async () => {
    // **The trigger must not be the row's flexible cell** (myne-md/myne#848).
    // It was `flex: 1`, so the tooltip's hover area was the empty band between
    // the title and the `...`, the bubble appeared while the pointer was
    // nowhere near the text. jsdom cannot hit-test, so the assertion is on the
    // layout property that decides the hit area, plus the element the tooltip
    // actually wraps.
    mockChatsList.mockResolvedValue([row("c-1", "One", 100)]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    const slot = await screen.findByTestId("agent.hub-title-slot");
    expect(slot.style.flexGrow, "the tooltip's trigger grows into the row").toBe("0");
    expect(slot.style.flexShrink).toBe("1");
    // The trigger is the button INSIDE the slot, so its box is the text's.
    const title = screen.getByTestId("agent.hub-open");
    expect(slot.contains(title)).toBe(true);
    // And the right edge is held by the actions' own auto margin, which is what
    // makes the title not needing to grow.
    expect(screen.getByTestId("agent.hub-row-actions").style.marginInlineStart).toBe(
      "auto",
    );
  });

  it("anchors the menu to the row it was opened ON, not to another row", async () => {
    // **One ref across every row is one ref pointing at whichever row rendered
    // last** (myne-md/myne#848). The menu was placed against that row, a row
    // with nothing to do with the press, which is exactly what "the menu opens
    // in a totally unrelated place" was.
    //
    // jsdom has no geometry, so each row's cluster REPORTS its own position:
    // the assertion is on where the panel landed, which is the thing the user
    // saw, rather than on which element a ref happens to hold.
    mockChatsList.mockResolvedValue([
      row("c-1", "One", 300),
      row("c-2", "Two", 200),
      row("c-3", "Three", 100),
    ]);
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const id = this.closest("[data-conversation-id]")?.getAttribute(
        "data-conversation-id",
      );
      const top = id === "c-1" ? 100 : id === "c-2" ? 200 : 300;
      return {
        top,
        bottom: top + 20,
        left: 0,
        right: 200,
        width: 200,
        height: 20,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    };
    try {
      render(<AgentHubList onOpenFocus={() => {}} />);
      await openRowMenu(1);
      const menu = screen.getByTestId("agent.hub-menu-list");
      // c-2's cluster ends at 220 and `placeMenu` leaves a 4px gap, so the
      // panel opens at 224. The shared-ref defect put it at 324 (the last row's
      // cluster) or 124 (the first): either way, not here.
      expect(menu.style.top).toBe("224px");
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  });

  it("closes the row menu on an outside press, on Escape, and on scroll", async () => {
    // **The menu is a fixed panel in the body now** (myne-md/myne#848), so it
    // has no ancestor to clip it and no ancestor to dismiss it either: the three
    // ways out are the component's own. Each is driven separately, because a
    // single "it closes" test would pass on whichever arm happened to fire.
    mockChatsList.mockResolvedValue([row("c-1", "One", 100)]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    await openRowMenu();
    expect(screen.getByTestId("agent.hub-menu-list")).toBeTruthy();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("agent.hub-menu-list")).toBeNull();

    await openRowMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("agent.hub-menu-list")).toBeNull();

    await openRowMenu();
    fireEvent.scroll(window);
    expect(screen.queryByTestId("agent.hub-menu-list")).toBeNull();
  });

  it("does not close the menu when the press lands on the menu itself", async () => {
    // The dismissal is a capture-phase listener on the document, so a press on
    // the panel's own padding would close it before the item saw the click,
    // and the item is the whole point of opening the menu.
    mockChatsList.mockResolvedValue([row("c-1", "One", 100)]);
    render(<AgentHubList onOpenFocus={() => {}} />);
    await openRowMenu();
    const menu = screen.getByTestId("agent.hub-menu-list");
    fireEvent.mouseDown(menu);
    expect(screen.getByTestId("agent.hub-menu-list")).toBeTruthy();
  });

  it("keeps a RUNNING row's rename and delete visible without hovering", async () => {
    mockChatsList.mockResolvedValue([row("c-run", "One", Date.UTC(2026, 4, 2))]);
    // The run store is the real one: `running` + `runConversationId` IS the mark
    // the list reads, so driving it through the store is driving the contract.
    beginRun("c-run");
    render(<AgentHubList onOpenFocus={() => {}} />);
    const actions = await screen.findByTestId("agent.hub-row-actions");
    expect(actions.style.opacity).toBe("1");
    // And they are the real controls, not merely a visible container.
    await openRowMenu();
    expect(screen.getByTestId("agent.hub-rename")).toBeTruthy();
    expect(screen.getByTestId("agent.hub-delete")).toBeTruthy();
  });
});
