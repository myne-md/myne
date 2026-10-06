// Conversation history modal (myne-md/myne#675).
//
// The list/open/rename/delete surface over the persisted conversations. The
// IPC boundary is mocked at the bindings module; the store side is real, so
// these tests prove the wiring (which row action reaches which command with
// which id) rather than the backend those commands hit.

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const {
  mockChatsCreate,
  mockChatsAppendTurn,
  mockChatsRead,
  mockChatsList,
  mockChatsRename,
  mockChatsDelete,
} = vi.hoisted(() => ({
  mockChatsCreate: vi.fn(),
  mockChatsAppendTurn: vi.fn(),
  mockChatsRead: vi.fn(),
  mockChatsList: vi.fn(),
  mockChatsRename: vi.fn(),
  mockChatsDelete: vi.fn(),
}));

vi.mock("../../src/lib/chats", () => ({
  // The roster notifier the wrappers fire (myne-md/myne#771). Mocked to a
  // no-op unsubscribe: what these files drive is the list, not the signal, and
  // a module mock that omits an export makes the importer throw at load.
  subscribeConversationRoster: () => () => {},
  chatsCreate: mockChatsCreate,
  chatsAppendTurn: mockChatsAppendTurn,
  chatsRead: mockChatsRead,
  chatsList: mockChatsList,
  chatsRename: mockChatsRename,
  chatsDelete: mockChatsDelete,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ChatHistoryModal } from "../../src/notes/components/ChatHistoryModal";
import {
  __flushChatPersistForTest,
  __resetChatPersistForTest,
  installChatPersistence,
  isChatPersistLagging,
} from "../../src/notes/ai/chatPersist";
import {
  __resetChatForTest,
  getActiveConversationId,
  getChat,
  sendChatMessage,
  setActiveConversationId,
} from "../../src/notes/ai/chatStore";

function row(id: string, title: string, updatedAt: number) {
  return { id, title, created_at: 1, updated_at: updatedAt, version: 1 };
}

const ID_A = "aa".padEnd(32, "0");
const ID_B = "bb".padEnd(32, "0");

beforeEach(() => {
  __resetChatForTest();
  __resetChatPersistForTest();
  mockChatsCreate.mockReset();
  mockChatsAppendTurn.mockReset();
  mockChatsRead.mockReset();
  mockChatsList.mockReset().mockResolvedValue([]);
  mockChatsRename.mockReset().mockResolvedValue(undefined);
  mockChatsDelete.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

function renderOpen(onClose: () => void = () => {}) {
  return render(<ChatHistoryModal open onClose={onClose} />);
}

describe("conversation list", () => {
  it("renders rows newest-first with their titles", async () => {
    mockChatsList.mockResolvedValue([
      row(ID_A, "older", 100),
      row(ID_B, "newer", 200),
    ]);
    renderOpen();
    const rows = await screen.findAllByTestId("ai.conversation-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("newer");
    expect(rows[1]!.textContent).toContain("older");
  });

  it("shows the empty state when there is nothing persisted", async () => {
    renderOpen();
    expect(await screen.findByTestId("ai.history-empty")).toBeDefined();
    expect(screen.queryByTestId("ai.conversation-list")).toBeNull();
  });

  it("shows an error instead of a list when the fetch fails", async () => {
    mockChatsList.mockRejectedValue(new Error("torn"));
    renderOpen();
    expect(await screen.findByTestId("ai.history-error")).toBeDefined();
    expect(screen.queryByTestId("ai.conversation-list")).toBeNull();
  });
});

describe("open a conversation", () => {
  it("reads, binds and hydrates, then closes", async () => {
    mockChatsList.mockResolvedValue([row(ID_A, "taxes", 100)]);
    mockChatsRead.mockResolvedValue(
      JSON.stringify({
        turns: [{ id: "x1", kind: "text", role: "user", text: "restored" }],
      }),
    );
    const onClose = vi.fn();
    renderOpen(onClose);
    fireEvent.click(await screen.findByTestId("ai.conversation-open"));
    await vi.waitFor(() => expect(mockChatsRead).toHaveBeenCalledWith(ID_A));
    expect(getActiveConversationId()).toBe(ID_A);
    expect(getChat().turns.map((t) => t.text)).toEqual(["restored"]);
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("closes without fetching when the row is already the open conversation", async () => {
    mockChatsList.mockResolvedValue([row(ID_A, "taxes", 100)]);
    setActiveConversationId(ID_A);
    const onClose = vi.fn();
    renderOpen(onClose);
    fireEvent.click(await screen.findByTestId("ai.conversation-open"));
    expect(mockChatsRead).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open with an error when the read fails", async () => {
    mockChatsList.mockResolvedValue([row(ID_A, "taxes", 100)]);
    mockChatsRead.mockRejectedValue(new Error("torn"));
    const onClose = vi.fn();
    renderOpen(onClose);
    fireEvent.click(await screen.findByTestId("ai.conversation-open"));
    expect(await screen.findByTestId("ai.history-error")).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
    expect(getActiveConversationId()).toBeNull();
  });
});

describe("rename a conversation", () => {
  it("renames through the binding and refreshes the list", async () => {
    mockChatsList
      .mockResolvedValueOnce([row(ID_A, "old", 100)])
      .mockResolvedValueOnce([row(ID_A, "new", 200)]);
    renderOpen();
    fireEvent.click(await screen.findByTestId("ai.conversation-rename"));
    const input = (await screen.findByTestId(
      "ai.conversation-rename-input",
    )) as HTMLInputElement;
    expect(input.value).toBe("old");
    fireEvent.change(input, { target: { value: "new" } });
    fireEvent.click(screen.getByTestId("ai.conversation-rename-confirm"));
    await screen.findByText(/new/);
    expect(mockChatsRename).toHaveBeenCalledWith(ID_A, "new");
    expect(mockChatsList).toHaveBeenCalledTimes(2);
  });

  it("Escape abandons the rename without calling", async () => {
    mockChatsList.mockResolvedValue([row(ID_A, "old", 100)]);
    renderOpen();
    fireEvent.click(await screen.findByTestId("ai.conversation-rename"));
    const input = await screen.findByTestId("ai.conversation-rename-input");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(mockChatsRename).not.toHaveBeenCalled();
    expect(screen.queryByTestId("ai.conversation-rename-input")).toBeNull();
  });
});

describe("delete a conversation", () => {
  it("asks inline, and cancel keeps everything", async () => {
    mockChatsList.mockResolvedValue([row(ID_A, "taxes", 100)]);
    renderOpen();
    fireEvent.click(await screen.findByTestId("ai.conversation-delete"));
    // The inline confirm names the everywhere-consequence.
    expect(screen.getByTestId("ai.conversation-delete-confirm")).toBeDefined();
    fireEvent.click(screen.getByTestId("ai.conversation-delete-cancel"));
    expect(mockChatsDelete).not.toHaveBeenCalled();
    expect(screen.queryByTestId("ai.conversation-delete-confirm")).toBeNull();
  });

  it("deletes a listed conversation the transcript is not showing", async () => {
    mockChatsList
      .mockResolvedValueOnce([
        row(ID_A, "open", 100),
        row(ID_B, "other", 200),
      ])
      .mockResolvedValueOnce([row(ID_A, "open", 100)]);
    setActiveConversationId(ID_A);
    sendChatMessage("still here");
    renderOpen();
    const rows = await screen.findAllByTestId("ai.conversation-row");
    expect(rows).toHaveLength(2);
    const otherRow = rows.find((r) => r.textContent!.includes("other"))!;
    expect(otherRow).toBeDefined();
    fireEvent.click(within(otherRow).getByTestId("ai.conversation-delete"));
    fireEvent.click(screen.getByTestId("ai.conversation-delete-confirm"));
    await screen.findByText(/open/);
    expect(mockChatsDelete).toHaveBeenCalledWith(ID_B);
    // The open transcript is none of the deleted row's business.
    expect(getActiveConversationId()).toBe(ID_A);
    expect(getChat().turns.map((t) => t.text)).toContain("still here");
  });

  it("deleting the open conversation persists nothing and raises no warning", async () => {
    // The turns are deleted by intent: the wipe notifies no persist (which
    // would fail against the fresh tombstone and stash stale state), and any
    // earlier stash for the deleted conversation is dropped with it.
    installChatPersistence();
    mockChatsList
      .mockResolvedValueOnce([row(ID_A, "open", 100)])
      .mockResolvedValueOnce([]);
    setActiveConversationId(ID_A);
    sendChatMessage("shown");
    renderOpen();
    fireEvent.click(await screen.findByTestId("ai.conversation-delete"));
    fireEvent.click(screen.getByTestId("ai.conversation-delete-confirm"));
    await screen.findByTestId("ai.history-empty");
    await __flushChatPersistForTest();
    expect(mockChatsDelete).toHaveBeenCalledWith(ID_A);
    expect(mockChatsCreate).not.toHaveBeenCalled();
    expect(mockChatsAppendTurn).not.toHaveBeenCalled();
    expect(isChatPersistLagging()).toBe(false);
  });

  it("deleting the open conversation wipes the transcript with it", async () => {
    mockChatsList
      .mockResolvedValueOnce([row(ID_A, "open", 100)])
      .mockResolvedValueOnce([]);
    setActiveConversationId(ID_A);
    sendChatMessage("shown");
    renderOpen();
    fireEvent.click(await screen.findByTestId("ai.conversation-delete"));
    fireEvent.click(screen.getByTestId("ai.conversation-delete-confirm"));
    await screen.findByTestId("ai.history-empty");
    expect(mockChatsDelete).toHaveBeenCalledWith(ID_A);
    expect(getChat().turns).toHaveLength(0);
    expect(getActiveConversationId()).toBeNull();
  });
});
