// @vitest-environment jsdom
//
// The phone's conversation-history sheet (myne-md/myne#675, task 13).
//
// What is under test is the LIST's contract, not its look: rows render from
// the roster newest-first, opening reports the row's id, renaming writes
// through the binding and refreshes, and deleting takes the two-tap confirm
// path (the archive.folder-delete-confirm pattern) before anything is
// removed. The bindings are mocked at the module; the flow-logic tier drives
// the same surface against mock IPC.

import i18n from "@myne/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AiHistorySheet } from "../../src/app/flows/AiHistorySheet";
import type { ConversationListRow } from "../../src/lib/chats";

const {
  mockChatsList,
  mockChatsRename,
  mockChatsDelete,
} = vi.hoisted(() => ({
  mockChatsList: vi.fn(),
  mockChatsRename: vi.fn(),
  mockChatsDelete: vi.fn(),
}));

vi.mock("../../src/lib/chats", () => ({
  chatsList: mockChatsList,
  chatsRename: mockChatsRename,
  chatsDelete: mockChatsDelete,
}));

function row(over: Partial<ConversationListRow>): ConversationListRow {
  return {
    id: "a",
    created_at: 100,
    title: "A",
    updated_at: 100,
    version: 1,
    ...over,
  } as ConversationListRow;
}

const ROWS = [
  row({ id: "a", title: "Older", updated_at: 100 }),
  row({ id: "b", title: "Newer", updated_at: 300 }),
];

/** A row anchored to a note, which is the shape the truncation was reported
 *  on: the anchor chip has to share the line with the title and the time. */
const ANCHORED = [row({ id: "a", title: "Older", updated_at: 100, note_id: "n1" })];

function sheet(props: Partial<Parameters<typeof AiHistorySheet>[0]> = {}) {
  const onOpen = vi.fn();
  const onNew = vi.fn();
  const onDeleted = vi.fn();
  const onClose = vi.fn();
  render(
    <AiHistorySheet
      activeId={null}
      onOpen={onOpen}
      onNew={onNew}
      onDeleted={onDeleted}
      onClose={onClose}
      {...props}
    />,
  );
  return { onOpen, onNew, onDeleted, onClose };
}

beforeEach(() => {
  mockChatsList.mockReset().mockResolvedValue(ROWS);
  mockChatsRename.mockReset().mockResolvedValue(undefined);
  mockChatsDelete.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

/** **Rename and delete live behind the row's three-dot menu now**
 *  (myne-md/myne#848), so every test that presses one opens that row's menu
 *  first. One helper, because the alternative is the same two lines at each
 *  call site and one of them eventually forgetting. */
async function openRowMenu(index = 0): Promise<void> {
  fireEvent.click((await screen.findAllByTestId("ai.conversation-menu"))[index]!);
}

describe("AiHistorySheet", () => {
  it("lists the roster newest-first", async () => {
    sheet();
    const rows = await screen.findAllByTestId("ai.conversation-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Newer");
    expect(rows[1]!.textContent).toContain("Older");
  });

  it("reports the opened row's id and marks the active row", async () => {
    const { onOpen } = sheet({ activeId: "b" });
    const rows = await screen.findAllByTestId("ai.conversation-row");
    expect(rows[0]!.getAttribute("data-active")).toBe("true");
    fireEvent.click(screen.getAllByTestId("ai.conversation-open")[1]!);
    expect(onOpen).toHaveBeenCalledWith("a");
  });

  it("renames through the binding and refreshes the list", async () => {
    sheet();
    await screen.findAllByTestId("ai.conversation-row");
    await openRowMenu();
    fireEvent.click(screen.getByTestId("ai.conversation-rename"));
    const input = screen.getByTestId("ai.conversation-rename-input");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByTestId("ai.conversation-rename-confirm"));
    await waitFor(() => expect(mockChatsRename).toHaveBeenCalledWith("b", "Renamed"));
    // Refresh re-reads the roster rather than patching the row.
    expect(mockChatsList.mock.calls.length).toBeGreaterThan(1);
  });

  it("deletes only after the confirm tap, then reports the id", async () => {
    const { onDeleted } = sheet();
    await screen.findAllByTestId("ai.conversation-row");
    await openRowMenu();
    fireEvent.click(screen.getByTestId("ai.conversation-delete"));
    // Armed, not deleted: the confirm is a second tap.
    expect(mockChatsDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("ai.conversation-delete-confirm"));
    await waitFor(() => expect(mockChatsDelete).toHaveBeenCalledWith("b"));
    expect(onDeleted).toHaveBeenCalledWith("b");
  });

  it("opens the conversation from ANYWHERE on the row, not only the title", async () => {
    // The row was four controls on one line and the title was the only target,
    // so the obvious gesture (tap the thing you are looking at) did nothing on
    // most of it (myne-md/myne#848).
    const { onOpen } = sheet();
    const rows = await screen.findAllByTestId("ai.conversation-row");
    fireEvent.click(rows[0]!);
    expect(onOpen).toHaveBeenCalledWith("b");
  });

  it("does not open the conversation when the MENU is used", async () => {
    // Rename sits inside the row, and the row opens on click. Without the menu
    // stopping the event, choosing Rename would also open the conversation.
    const { onOpen } = sheet();
    await screen.findAllByTestId("ai.conversation-row");
    await openRowMenu();
    fireEvent.click(screen.getByTestId("ai.conversation-rename"));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("states what each row is about with a glyph and a name", async () => {
    mockChatsList.mockResolvedValue([
      { ...ROWS[0]!, note_id: "n1" },
      { ...ROWS[1]!, folder: "Projects/" },
    ]);
    sheet();
    const targets = (await screen.findAllByTestId("ai.conversation-target"))
      .map((el) => el.getAttribute("data-target"))
      .sort();
    // Order-insensitive: the list is newest-first, so asserting a sequence would
    // be asserting the sort rather than the glyphs.
    expect(targets).toEqual(["folder", "note"]);
    for (const el of screen.getAllByTestId("ai.conversation-target")) {
      expect((el.getAttribute("aria-label") ?? "").length).toBeGreaterThan(0);
      expect(el.querySelector("svg")).not.toBeNull();
    }
  });

  it("renders the empty state when the roster is empty", async () => {
    mockChatsList.mockResolvedValue([]);
    sheet();
    expect(await screen.findByTestId("ai.history-empty")).toBeTruthy();
  });

  it("starts a new chat through onNew", async () => {
    const { onNew } = sheet();
    await screen.findAllByTestId("ai.conversation-row");
    fireEvent.click(screen.getByTestId("ai.history-new-chat"));
    expect(onNew).toHaveBeenCalled();
  });
});


describe("the anchor chip is text, not a swatch (myne-md/myne#867)", () => {
  it("uses the pill, so the label is not cut off at 40px", async () => {
    // The row read "On a" where it meant "On a note": `myne-chiplet` is the
    // fixed 40x28 COLOUR SWATCH with `overflow: hidden`, so a text label inside
    // it is clipped. `myne-pill` is sized by its text; the desktop hub was moved
    // to it when this was first found, and the phone kept the swatch.
    mockChatsList.mockResolvedValue(ANCHORED);
    sheet();
    const anchor = await screen.findByTestId("ai.conversation-anchor");
    expect(anchor.className).toContain("myne-pill");
    expect(anchor.className).not.toContain("myne-chiplet");
    // …and it is the label the copy says it is, not a fragment.
    expect(anchor.textContent).toBe(await i18n.t("agent.hub.anchorLabel"));
  });
});

describe("the sheet's three states use the hub's copy (myne-md/myne#867)", () => {
  it("echoes the query and offers the way out when a search matches nothing", async () => {
    mockChatsList.mockResolvedValue(ANCHORED);
    sheet();
    const search = await screen.findByTestId("ai.history-search");
    fireEvent.change(search, { target: { value: "zzz-no-such-conversation" } });
    const noMatch = await screen.findByTestId("ai.history-no-match");
    // The BODY, which this sheet used to drop: it is the sentence that names the
    // fix, and it takes the query.
    expect(noMatch.textContent).toContain("zzz-no-such-conversation");
    fireEvent.click(screen.getByTestId("ai.history-clear-search"));
    expect(await screen.findByTestId("ai.conversation-row")).toBeTruthy();
  });

  it("says what the hub says when there is nothing persisted", async () => {
    mockChatsList.mockResolvedValue([]);
    sheet();
    const empty = await screen.findByTestId("ai.history-empty");
    // The root of the shared zero state, so it carries the title AND the body.
    expect(empty.textContent).toContain(await i18n.t("agent.hub.emptyTitle"));
    expect(empty.textContent).toContain(await i18n.t("agent.hub.emptyBody"));
    expect(empty.className).toContain("myne-empty");
  });
});
