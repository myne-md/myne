// Persisted-conversation wiring (myne-md/myne#675).
//
// What is under test is the contract between the store and the conversation
// store: serialization shape, the create-vs-append decision, the
// stop-then-finalize dedup, and the hydrate guards. The IPC boundary is
// mocked at the bindings module; the store side uses a fake persister only
// where the store itself is the subject (see chatStore.test.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __flushChatPersistForTest,
  __resetChatPersistForTest,
  clearChatPersistForLock,
  hydrateActiveConversation,
  installChatPersistence,
  isChatHydrateFailed,
  isChatPersistLagging,
  openConversation,
  parseTranscript,
  serializeTranscript,
  subscribeChatPersistHealth,
} from "../../src/notes/ai/chatPersist";
import {
  __resetChatForTest,
  appendChatToken,
  clearChat,
  finalizeChatTurn,
  getActiveConversationId,
  getChat,
  sendAgentTurn,
  sendChatMessage,
  setActiveConversationId,
  stopChatTurn,
  type ChatTurn,
} from "../../src/notes/ai/chatStore";

const {
  mockChatsCreate,
  mockChatsAppendTurn,
  mockChatsList,
  mockChatsRead,
} = vi.hoisted(() => ({
  mockChatsCreate: vi.fn(),
  mockChatsAppendTurn: vi.fn(),
  mockChatsList: vi.fn(),
  mockChatsRead: vi.fn(),
}));

vi.mock("../../src/lib/chats", () => ({
  // The roster notifier the wrappers fire (myne-md/myne#771). Mocked to a
  // no-op unsubscribe: what these files drive is the list, not the signal, and
  // a module mock that omits an export makes the importer throw at load.
  subscribeConversationRoster: () => () => {},
  chatsCreate: mockChatsCreate,
  chatsAppendTurn: mockChatsAppendTurn,
  chatsList: mockChatsList,
  chatsRead: mockChatsRead,
}));

function turn(over: Partial<ChatTurn>): ChatTurn {
  return {
    id: "x",
    kind: "text",
    role: "user",
    text: "",
    streaming: false,
    error: false,
    ...over,
  } as ChatTurn;
}

beforeEach(() => {
  __resetChatForTest();
  __resetChatPersistForTest();
  mockChatsCreate.mockReset().mockResolvedValue("c0ffee".padEnd(32, "0"));
  mockChatsAppendTurn.mockReset().mockResolvedValue(undefined);
  mockChatsList.mockReset().mockResolvedValue([]);
  mockChatsRead.mockReset().mockRejectedValue(new Error("no conversation"));
});

describe("serializeTranscript", () => {
  it("round-trips the rendering state as a turns array", () => {
    const turns = [
      turn({ id: "a", role: "user", text: "hi" }),
      turn({
        id: "b",
        kind: "agent",
        role: "assistant",
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
        scopeLabel: "This note",
      }),
    ];
    const parsed = parseTranscript(serializeTranscript(turns));
    expect(parsed).toHaveLength(2);
    expect(parsed![0]).toMatchObject({ id: "a", role: "user", text: "hi" });
    expect(parsed![1]).toMatchObject({
      kind: "agent",
      scopeLabel: "This note",
    });
  });

  it("forces streaming false: only settled turns persist", () => {
    const parsed = parseTranscript(
      serializeTranscript([turn({ id: "a", streaming: true, text: "half" })]),
    );
    expect(parsed![0]!.streaming).toBe(false);
  });

  it("round-trips every optional field the serializer persists (review D11)", () => {
    // answeredBy, errorCause, insertable used to be written by the
    // serializer and dropped by the parser: a re-hydrated transcript lost
    // the provenance label, the actionable error cause and the insert
    // affordance while looking exactly like the saved conversation.
    const turns = [
      turn({
        id: "a",
        role: "assistant",
        text: "here",
        error: true,
        errorCause: "unauthorized",
        insertable: true,
        answeredBy: { kind: "remote", provider: "ollama" },
      }),
    ];
    const parsed = parseTranscript(serializeTranscript(turns));
    expect(parsed![0]!.insertable).toBe(true);
    expect(parsed![0]!.errorCause).toBe("unauthorized");
    expect(parsed![0]!.answeredBy).toEqual({ kind: "remote", provider: "ollama" });
    // Absent optional fields stay absent (no `insertable: undefined` keys
    // materializing as present).
    const bare = parseTranscript(serializeTranscript([turn({ id: "b", text: "x" })]));
    expect(bare![0]!.insertable).toBeUndefined();
    expect(bare![0]!.errorCause).toBeUndefined();
    expect(bare![0]!.answeredBy).toBeUndefined();
  });

  it("carries a settled turn's frozen proposal through the round trip", () => {
    // myne-md/myne#675: the proposal rides inside agentSummary wholesale:
    // the serializer carries it, the parser returns it, neither interprets it.
    const turns = [
      turn({
        id: "b",
        kind: "agent",
        role: "assistant",
        agentSummary: {
          runId: "r1",
          summary: "done",
          edits: 1,
          newNotes: 1,
          notesRead: 0,
          iterations: 1,
          charsOffDevice: null,
          end: "finished",
          proposal: {
            edits: [{ noteId: "n1", anchor: "old words", replacement: "new words" }],
            newNotes: [{ title: "Scratch", body: "fresh text", folder: null }],
          },
        },
        scopeLabel: "This note",
      }),
    ];
    const parsed = parseTranscript(serializeTranscript(turns));
    expect(parsed![0]!.agentSummary!.proposal).toEqual({
      edits: [{ noteId: "n1", anchor: "old words", replacement: "new words" }],
      newNotes: [{ title: "Scratch", body: "fresh text", folder: null }],
    });
  });

  it("carries the title-derivation snapshot from the first turn", () => {
    const raw = serializeTranscript([
      turn({ id: "a", role: "user", text: "help me with taxes please" }),
      turn({ id: "b", role: "assistant", text: "sure" }),
    ]);
    expect(JSON.parse(raw).title_derived_from).toBe("help me with taxes please");
  });

  it("derives the snapshot deterministically: 48 scalar values, newlines stripped", () => {
    const raw = serializeTranscript([
      turn({ id: "a", role: "user", text: "ab\ncd\ref" + "x".repeat(80) }),
    ]);
    const snapshot = JSON.parse(raw).title_derived_from as string;
    expect(snapshot).toBe("abcdef" + "x".repeat(42));
    expect([...snapshot].length).toBe(48);
    // The snapshot is informational: parsing ignores it either way.
    expect(parseTranscript(raw)![0]!.text).toContain("\n");
  });

  it("carries unknown turn fields through opaquely (forward tolerance)", () => {
    // A newer writer's field survives this frontend's hydrate plus
    // re-persist instead of being stripped cluster-wide on merge. A stored
    // `streaming` flag is the one exception: only settled turns persist.
    const raw = JSON.stringify({
      turns: [
        {
          id: "a",
          kind: "text",
          role: "user",
          text: "hi",
          futureField: { nested: [1, 2] },
          streaming: true,
        },
      ],
    });
    const parsed = parseTranscript(raw);
    expect(parsed![0]).toMatchObject({ rest: { futureField: { nested: [1, 2] } } });
    expect(parsed![0]!.streaming).toBe(false);
    expect("streaming" in (parsed![0]!.rest ?? {})).toBe(false);
    const repersisted = JSON.parse(serializeTranscript(parsed!)).turns[0];
    expect(repersisted.futureField).toEqual({ nested: [1, 2] });
    expect(repersisted.streaming).toBeUndefined();
  });

  it("returns null when the payload is not a conversation at all", () => {
    expect(parseTranscript("not json")).toBeNull();
    expect(parseTranscript(JSON.stringify({ nope: [] }))).toBeNull();
    expect(parseTranscript(JSON.stringify({ turns: "nope" }))).toBeNull();
  });

  it("drops malformed turns individually instead of losing the transcript", () => {
    const parsed = parseTranscript(
      JSON.stringify({
        turns: [
          { id: "good", kind: "text", role: "user", text: "kept" },
          { id: 42, kind: "text", role: "user", text: "bad id" },
          { id: "badkind", kind: "telepathy", role: "user", text: "x" },
          "not an object",
          { id: "badrole", kind: "text", role: "owner", text: "x" },
        ],
      }),
    );
    expect(parsed!.map((t) => t.id)).toEqual(["good"]);
  });

  it("defaults a missing error flag to false", () => {
    const parsed = parseTranscript(
      JSON.stringify({ turns: [{ id: "a", kind: "text", role: "user", text: "x" }] }),
    );
    expect(parsed![0]!.error).toBe(false);
  });
});

describe("persist on settle", () => {
  it("creates the conversation on the first settled turn", async () => {
    installChatPersistence();
    sendChatMessage("hello");
    // Settle it the way the summarize flow does: token then finalize.
    appendChatToken(1, "world");
    finalizeChatTurn(1);
    await __flushChatPersistForTest();
    expect(mockChatsCreate).toHaveBeenCalledTimes(1);
    const payload = mockChatsCreate.mock.calls[0]![0] as string;
    expect(JSON.parse(payload).turns).toHaveLength(2);
    expect(getActiveConversationId()).toBe("c0ffee".padEnd(32, "0"));
    expect(mockChatsAppendTurn).not.toHaveBeenCalled();
  });

  it("appends once bound, and skips an identical payload (stop-then-finalize)", async () => {
    installChatPersistence();
    setActiveConversationId("deadbeef".padEnd(32, "0"));
    sendChatMessage("hello");
    appendChatToken(1, "partial");
    stopChatTurn();
    await __flushChatPersistForTest();
    expect(mockChatsAppendTurn).toHaveBeenCalledTimes(1);
    // The late FINALIZE changes nothing, so the second notify dedupes.
    finalizeChatTurn(1);
    await __flushChatPersistForTest();
    expect(mockChatsAppendTurn).toHaveBeenCalledTimes(1);
  });

  it("a persist failure leaves the chat exactly as it was", async () => {
    installChatPersistence();
    mockChatsCreate.mockRejectedValueOnce(new Error("disk"));
    sendChatMessage("hello");
    appendChatToken(1, "world");
    finalizeChatTurn(1);
    await __flushChatPersistForTest();
    // The transcript on screen is unaffected, and nothing is bound: the next
    // settle retries as a create.
    expect(getChat().turns).toHaveLength(2);
    expect(getActiveConversationId()).toBeNull();
  });
});

describe("persist failure is surfaced, retried, and replayed (review I9)", () => {
  it("retries a failed persist and drops the lagging flag on success", async () => {
    vi.useFakeTimers();
    try {
      installChatPersistence();
      mockChatsCreate
        .mockRejectedValueOnce(new Error("disk"))
        .mockRejectedValueOnce(new Error("disk"))
        .mockResolvedValue("c0ffee".padEnd(32, "0"));
      sendChatMessage("hello");
      appendChatToken(1, "world");
      finalizeChatTurn(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(isChatPersistLagging()).toBe(true);
      // First retry at 1s: still failing.
      await vi.advanceTimersByTimeAsync(1000);
      expect(isChatPersistLagging()).toBe(true);
      // Second retry at 2s: succeeds, the flag clears.
      await vi.advanceTimersByTimeAsync(1000);
      expect(isChatPersistLagging()).toBe(false);
      expect(mockChatsCreate).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the lagging flag is observable through the health subscription", async () => {
    const seen: boolean[] = [];
    const unsub = subscribeChatPersistHealth(() => seen.push(isChatPersistLagging()));
    installChatPersistence();
    mockChatsCreate.mockRejectedValueOnce(new Error("disk"));
    sendChatMessage("hello");
    appendChatToken(1, "world");
    finalizeChatTurn(1);
    await __flushChatPersistForTest();
    expect(seen).toContain(true);
    unsub();
  });

  it("stashes a known-id append failure and replays it on the unlock hydrate", async () => {
    installChatPersistence();
    setActiveConversationId("deadbeef".padEnd(32, "0"));
    mockChatsAppendTurn.mockRejectedValueOnce(new Error("disk"));
    sendChatMessage("hello");
    appendChatToken(1, "world");
    finalizeChatTurn(1);
    await __flushChatPersistForTest();
    expect(isChatPersistLagging()).toBe(true);
    // The vault locks: the store wipes, the conversation binding dies.
    clearChat();
    expect(getChat().turns).toHaveLength(0);
    expect(getActiveConversationId()).toBeNull();
    // The unlock hydrate replays the stashed payload before reading the
    // roster, so the conversation file recovers the turns the wipe cost.
    const boundId = "deadbeef".padEnd(32, "0");
    mockChatsList.mockResolvedValue([
      { id: boundId, title: "t", created_at: 1, updated_at: 1, version: 1 },
    ]);
    mockChatsRead.mockResolvedValue(
      JSON.stringify({ turns: [], title_derived_from: "" }),
    );
    await hydrateActiveConversation();
    expect(mockChatsAppendTurn).toHaveBeenCalledWith(
      boundId,
      expect.stringContaining("hello"),
    );
    expect(isChatPersistLagging()).toBe(false);
  });

  it("a failed first-turn create replays as a create on the unlock hydrate", async () => {
    installChatPersistence();
    mockChatsCreate.mockRejectedValueOnce(new Error("disk"));
    sendChatMessage("hello");
    appendChatToken(1, "world");
    finalizeChatTurn(1);
    await __flushChatPersistForTest();
    expect(isChatPersistLagging()).toBe(true);
    expect(getActiveConversationId()).toBeNull();
    // Unlock: the stash replays as a create and binds the transcript to it
    // directly, so the first turn is not lost with the wipe.
    mockChatsList.mockResolvedValue([]);
    await hydrateActiveConversation();
    expect(mockChatsCreate).toHaveBeenCalledTimes(2);
    expect(getActiveConversationId()).toBe("c0ffee".padEnd(32, "0"));
    expect(getChat().turns.map((t) => t.text)).toEqual(["hello", "world"]);
    expect(isChatPersistLagging()).toBe(false);
  });

  it("the vault-leaving paths drop the stash: no cross-vault replay", async () => {
    installChatPersistence();
    setActiveConversationId("deadbeef".padEnd(32, "0"));
    mockChatsAppendTurn.mockRejectedValueOnce(new Error("disk"));
    sendChatMessage("hello");
    appendChatToken(1, "world");
    finalizeChatTurn(1);
    await __flushChatPersistForTest();
    expect(isChatPersistLagging()).toBe(true);
    // Lock (and switch): the choke point drops the persist module's
    // plaintext with the transcript. A stash that survived would keep vault
    // A's turns resident into vault B's session and replay them there.
    clearChatPersistForLock();
    expect(isChatPersistLagging()).toBe(false);
    mockChatsAppendTurn.mockClear();
    mockChatsList.mockResolvedValue([]);
    await hydrateActiveConversation();
    expect(mockChatsAppendTurn).not.toHaveBeenCalled();
  });

  it("clearChat persists the cut stream's partial text to the bound conversation", async () => {
    // The production half of the store test: the persister listener captures
    // its snapshot synchronously at notify time, so the queued IPC carries
    // the settled partial text, not the wiped state (which would take the
    // empty-turns create path).
    installChatPersistence();
    const boundId = "deadbeef".padEnd(32, "0");
    setActiveConversationId(boundId);
    sendChatMessage("question");
    appendChatToken(1, "partial answer");
    clearChat();
    await __flushChatPersistForTest();
    expect(mockChatsCreate).not.toHaveBeenCalled();
    expect(mockChatsAppendTurn).toHaveBeenCalledTimes(1);
    const [id, payload] = mockChatsAppendTurn.mock.calls[0] as [string, string];
    expect(id).toBe(boundId);
    const turns = JSON.parse(payload).turns as { text: string }[];
    expect(turns.map((t) => t.text)).toEqual(["question", "partial answer"]);
  });

  it("a retry that races a fresh settle cannot land an older payload", async () => {
    vi.useFakeTimers();
    try {
      installChatPersistence();
      setActiveConversationId("deadbeef".padEnd(32, "0"));
      mockChatsAppendTurn.mockRejectedValueOnce(new Error("disk"));
      sendChatMessage("hello");
      appendChatToken(1, "first");
      finalizeChatTurn(1);
      await vi.advanceTimersByTimeAsync(0);
      // A second, fuller settle lands before the retry fires.
      sendChatMessage("second");
      appendChatToken(2, "more");
      finalizeChatTurn(2);
      await vi.advanceTimersByTimeAsync(1000);
      await __flushChatPersistForTest();
      const payloads = mockChatsAppendTurn.mock.calls.map((c) => c[1] as string);
      const last = JSON.parse(payloads[payloads.length - 1]!);
      expect(last.turns.map((t: { text: string }) => t.text)).toContain("more");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("hydrateActiveConversation", () => {
  it("is a no-op when there is no conversation to restore", async () => {
    await hydrateActiveConversation();
    expect(mockChatsRead).not.toHaveBeenCalled();
    expect(getChat().turns).toHaveLength(0);
    expect(getActiveConversationId()).toBeNull();
  });

  it("restores the most recently updated conversation and binds it", async () => {
    const idOld = "aa".padEnd(32, "0");
    const idNew = "bb".padEnd(32, "0");
    mockChatsList.mockResolvedValue([
      { id: idOld, title: "old", created_at: 1, updated_at: 2, version: 1 },
      { id: idNew, title: "new", created_at: 1, updated_at: 9, version: 1 },
    ]);
    mockChatsRead.mockResolvedValue(
      JSON.stringify({
        turns: [{ id: "x1", kind: "text", role: "user", text: "restored" }],
      }),
    );
    await hydrateActiveConversation();
    expect(mockChatsRead).toHaveBeenCalledWith(idNew);
    expect(getActiveConversationId()).toBe(idNew);
    expect(getChat().turns.map((t) => t.text)).toEqual(["restored"]);
  });

  it("stays empty and unbound when the read fails", async () => {
    mockChatsList.mockResolvedValue([
      { id: "cc".padEnd(32, "0"), title: "t", created_at: 1, updated_at: 1, version: 1 },
    ]);
    mockChatsRead.mockRejectedValue(new Error("torn"));
    await hydrateActiveConversation();
    expect(getChat().turns).toHaveLength(0);
    expect(getActiveConversationId()).toBeNull();
  });

  it("never clobbers turns typed while the fetch was in flight", async () => {
    let resolveList: (v: never[]) => void = () => {};
    mockChatsList.mockImplementation(
      () => new Promise<never[]>((r) => (resolveList = r)),
    );
    const pending = hydrateActiveConversation();
    // The user types before the list lands.
    sendAgentTurn("typed meanwhile", "This note");
    resolveList([]);
    await pending;
    expect(getChat().turns.map((t) => t.text)).toContain("typed meanwhile");
    expect(getActiveConversationId()).toBeNull();
  });

  it("does not fetch when already bound", async () => {
    setActiveConversationId("dd".padEnd(32, "0"));
    await hydrateActiveConversation();
    expect(mockChatsList).not.toHaveBeenCalled();
  });

  it("raises the hydrate-failure flag on an unreadable store, not on a mere empty one", async () => {
    // CatalogUnreadable: the roster refused to open. Report, never pretend
    // empty (§ 9.23.3).
    mockChatsList.mockRejectedValue({ kind: "CatalogUnreadable" });
    await hydrateActiveConversation();
    expect(isChatHydrateFailed()).toBe(true);
    // A plain transport failure is NOT the unreadable store: no flag.
    __resetChatPersistForTest();
    mockChatsList.mockRejectedValue(new Error("offline"));
    await hydrateActiveConversation();
    expect(isChatHydrateFailed()).toBe(false);
    // An empty roster is the ordinary fresh tab: no flag either.
    mockChatsList.mockResolvedValue([]);
    await hydrateActiveConversation();
    expect(isChatHydrateFailed()).toBe(false);
  });

  it("a successful hydrate or open clears the hydrate-failure flag", async () => {
    mockChatsList.mockRejectedValue({ kind: "CatalogUnreadable" });
    await hydrateActiveConversation();
    expect(isChatHydrateFailed()).toBe(true);
    const boundId = "ee".padEnd(32, "0");
    mockChatsList.mockResolvedValue([
      { id: boundId, title: "t", created_at: 1, updated_at: 2, version: 1 },
    ]);
    mockChatsRead.mockResolvedValue(
      JSON.stringify({ turns: [{ id: "t1", kind: "text", role: "user", text: "hi" }], title_derived_from: "hi" }),
    );
    await hydrateActiveConversation();
    expect(isChatHydrateFailed()).toBe(false);
  });

  it("an explicit open to an unreadable store surfaces the flag too", async () => {
    mockChatsRead.mockRejectedValue({ kind: "CatalogUnreadable" });
    const verdict = await openConversation("ff".padEnd(32, "0"));
    expect(verdict).toBe("failed");
    expect(isChatHydrateFailed()).toBe(true);
  });
});
