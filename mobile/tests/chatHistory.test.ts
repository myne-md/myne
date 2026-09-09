// The phone's transcript layer (myne-md/myne#675, task 13).
//
// What is under test is the contract with the shared store: the payload shape
// desktop parses, the boot-scoped id scheme the merge orders by, the
// create-vs-append decision, and the stage-then-flush backstop that lets a
// backgrounding flush what a settle staged. The IPC boundary is mocked at the
// bindings module.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetChatHistoryForTest,
  clearChatHistoryPersistForLock,
  flushChatHistoryNow,
  flushPendingTranscript,
  isChatHistoryLagging,
  newestConversation,
  newTurnId,
  parseTranscript,
  serializeTranscript,
  stageTranscript,
  toHistorySeed,
  type ChatTurnJson,
} from "../src/lib/chatHistory";
import type { ConversationListRow } from "../src/lib/chats";

const {
  mockChatsCreate,
  mockChatsAppendTurn,
  mockChatsRead,
  mockChatsList,
} = vi.hoisted(() => ({
  mockChatsCreate: vi.fn(),
  mockChatsAppendTurn: vi.fn(),
  mockChatsRead: vi.fn(),
  mockChatsList: vi.fn(),
}));

vi.mock("../src/lib/chats", () => ({
  chatsCreate: mockChatsCreate,
  chatsAppendTurn: mockChatsAppendTurn,
  chatsRead: mockChatsRead,
  chatsList: mockChatsList,
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

function turn(over: Partial<ChatTurnJson>): ChatTurnJson {
  return { id: "x", kind: "text", role: "user", text: "", ...over };
}

beforeEach(() => {
  __resetChatHistoryForTest();
  mockChatsCreate.mockReset().mockResolvedValue("c0ffee".padEnd(32, "0"));
  mockChatsAppendTurn.mockReset().mockResolvedValue(undefined);
  mockChatsRead.mockReset().mockRejectedValue(new Error("no conversation"));
  mockChatsList.mockReset().mockResolvedValue([]);
});

describe("turn ids", () => {
  it("mints boot-scoped monotonic ids that sort in append order", () => {
    const a = newTurnId();
    const b = newTurnId();
    expect(a).toMatch(/^[0-9a-f]{16}-\d{10}$/);
    expect(b).toMatch(/^[0-9a-f]{16}-\d{10}$/);
    expect([a, b].sort()).toEqual([a, b]);
    // Same boot discriminator across the session, distinct sequences.
    expect(a.split("-")[0]).toBe(b.split("-")[0]);
    expect(a).not.toBe(b);
  });
});

describe("newestConversation", () => {
  it("picks the greatest updated_at, or null for an empty roster", () => {
    expect(newestConversation([])).toBeNull();
    const rows = [row({ id: "a", updated_at: 100 }), row({ id: "b", updated_at: 300 }), row({ id: "c", updated_at: 200 })];
    expect(newestConversation(rows)?.id).toBe("b");
  });
});

describe("serializeTranscript / parseTranscript", () => {
  it("round-trips turns plus the title snapshot", () => {
    const turns = [
      turn({ id: "a", text: "hi" }),
      turn({
        id: "b",
        kind: "agent",
        role: "assistant",
        text: "",
        agentSummary: {
          runId: "r1",
          summary: "done",
          edits: 0,
          newNotes: 0,
          notesRead: 0,
          iterations: 1,
          charsOffDevice: null,
          end: "finished",
        },
      }),
    ];
    const parsed = parseTranscript(serializeTranscript(turns, "hi"));
    expect(parsed).toHaveLength(2);
    expect(parsed![0]).toMatchObject({ id: "a", role: "user", text: "hi" });
    expect(parsed![1]!.agentSummary).toMatchObject({ runId: "r1", summary: "done" });
  });

  it("fails closed on anything malformed", () => {
    expect(parseTranscript("not json")).toBeNull();
    expect(parseTranscript("{}")).toBeNull();
    expect(parseTranscript('{"turns": "nope"}')).toBeNull();
  });

  it("skips unknown turns rather than failing the transcript", () => {
    const parsed = parseTranscript(
      JSON.stringify({ turns: [{ id: "a", kind: "text", role: "user", text: "kept" }, null, { nope: true }] }),
    );
    expect(parsed).toEqual([{ id: "a", kind: "text", role: "user", text: "kept" }]);
  });
});

describe("toHistorySeed", () => {
  it("carries user text and the assistant summary, skipping errors and empties", () => {
    const seed = toHistorySeed([
      turn({ id: "a", text: "  question  " }),
      turn({ id: "b", kind: "agent", role: "assistant", text: "", agentSummary: {
        runId: "r", summary: "answer", edits: 0, newNotes: 0, notesRead: 0,
        iterations: 0, charsOffDevice: null, end: "finished",
      } }),
      turn({ id: "c", kind: "agent", role: "assistant", text: "refused", error: true }),
      turn({ id: "d", text: "   " }),
    ]);
    expect(seed).toEqual([
      { role: "user", text: "question" },
      { role: "assistant", text: "answer" },
    ]);
  });
});

describe("stage + flush", () => {
  it("creates on first write and appends after, deduping identical payloads", async () => {
    const turns = [turn({ id: "a", text: "hi" })];
    stageTranscript(null, turns);
    const id = await flushPendingTranscript();
    expect(id).toBe("c0ffee".padEnd(32, "0"));
    expect(mockChatsCreate).toHaveBeenCalledTimes(1);
    expect(mockChatsAppendTurn).not.toHaveBeenCalled();

    // Same payload again: no second write (stop-then-finalize dedup).
    stageTranscript(id, turns);
    await flushPendingTranscript();
    expect(mockChatsCreate).toHaveBeenCalledTimes(1);
    expect(mockChatsAppendTurn).not.toHaveBeenCalled();

    // Changed payload appends under the bound id.
    const more = [...turns, turn({ id: "b", text: "again" })];
    stageTranscript(id, more);
    await flushPendingTranscript();
    expect(mockChatsAppendTurn).toHaveBeenCalledTimes(1);
    expect(mockChatsAppendTurn.mock.calls[0]![0]).toBe(id);
  });

  it("keeps a failed write staged so the next flush retries", async () => {
    mockChatsCreate.mockRejectedValueOnce(new Error("locked mid-write"));
    stageTranscript(null, [turn({ id: "a", text: "hi" })]);
    expect(await flushPendingTranscript()).toBeNull();
    // Still staged: the retry creates.
    const id = await flushPendingTranscript();
    expect(id).toBe("c0ffee".padEnd(32, "0"));
    expect(mockChatsCreate).toHaveBeenCalledTimes(2);
  });

  it("flushChatHistoryNow never throws: backgrounding must not break on IO", async () => {
    mockChatsCreate.mockRejectedValue(new Error("no vault"));
    stageTranscript(null, [turn({ id: "a", text: "hi" })]);
    await expect(flushChatHistoryNow()).resolves.toBeUndefined();
  });

  it("a failed flush raises lagging until a flush lands", async () => {
    expect(isChatHistoryLagging()).toBe(false);
    mockChatsCreate.mockRejectedValueOnce(new Error("locked mid-write"));
    stageTranscript(null, [turn({ id: "a", text: "hi" })]);
    await flushPendingTranscript();
    expect(isChatHistoryLagging()).toBe(true);
    await flushPendingTranscript();
    expect(isChatHistoryLagging()).toBe(false);
  });

  it("concurrent flushes land the newest staged payload, never an older one", async () => {
    // A background flush racing a settle's flush: without serialization the
    // two writes land in IPC-completion order and an older transcript can
    // overwrite a newer one (the desktop `seq`-rule twin of this test).
    const id = "c0ffee".padEnd(32, "0");
    const first = [turn({ id: "a", text: "first" })];
    const second = [...first, turn({ id: "b", text: "second" })];
    let release!: () => void;
    mockChatsAppendTurn.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    stageTranscript(id, first);
    const one = flushPendingTranscript();
    stageTranscript(id, second);
    const two = flushPendingTranscript();
    await vi.waitFor(() => expect(mockChatsAppendTurn).toHaveBeenCalled());
    release();
    await one;
    await two;
    const payloads = mockChatsAppendTurn.mock.calls.map((c) => c[1] as string);
    expect(payloads).toHaveLength(1);
    expect(JSON.parse(payloads[0]!).turns.map((t: { text: string }) => t.text)).toEqual([
      "first",
      "second",
    ]);
  });

  it("the lock path drops the staged write and the flag with it", async () => {
    mockChatsCreate.mockRejectedValue(new Error("no vault"));
    stageTranscript(null, [turn({ id: "a", text: "hi" })]);
    await flushPendingTranscript();
    expect(isChatHistoryLagging()).toBe(true);
    clearChatHistoryPersistForLock();
    expect(isChatHistoryLagging()).toBe(false);
  });
});
