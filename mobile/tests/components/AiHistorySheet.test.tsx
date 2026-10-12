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
