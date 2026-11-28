// @vitest-environment jsdom
//
// The run belongs to its conversation, not to the view that started it
// (myne-md/myne#848).
//
// Four properties, three of which fail silently in production if they break:
//
//   1. the conversation exists from the first USER message, not from the first
//      reply, on a remote provider "not answered yet" is minutes, and a hub
//      that does not list what the user just asked reads as a lost message;
//   2. the run records which conversation it belongs to, while it is still
//      running, because the result has to land somewhere specific;
//   3. a run that settles after the user has navigated to ANOTHER conversation
//      writes into its own file rather than onto whatever is on screen;
//   4. and the ordinary case still goes to the live transcript, so (3) cannot
//      pass by breaking the path everyone uses.
//
// The store side is driven through the real modules with the IPC boundary
// mocked, which is the contract under test: `settleRunIntoChat` chooses between
// two writers, and the choice is about conversation ids.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentStart = vi.fn();

vi.mock("../../src/lib/agent-run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/agent-run")>()),
  agentStart: (...a: unknown[]) => agentStart(...a),
}));

const { mockChatsCreate, mockChatsAppendTurn, mockChatsRead } = vi.hoisted(() => ({
  mockChatsCreate: vi.fn(),
  mockChatsAppendTurn: vi.fn(),
  mockChatsRead: vi.fn(),
}));

vi.mock("../../src/lib/chats", () => ({
  subscribeConversationRoster: () => () => {},
  chatsCreate: mockChatsCreate,
  chatsAppendTurn: mockChatsAppendTurn,
  chatsList: vi.fn().mockResolvedValue([]),
  chatsRead: mockChatsRead,
}));

import {
  legFailureSentence,
  settleRunIntoChat,
  startAgentRun,
} from "../../src/notes/ai/agentToChat";
import {
  clearAgent,
  clearAgentForLock,
  currentRunEpoch,
  getAgent,
  markConversationUnread,
} from "../../src/notes/agent/agentStore";
import {
  __resetChatForTest,
  getActiveConversationId,
  setActiveConversationId,
} from "../../src/notes/ai/chatStore";
import { __resetChatPersistForTest, parseTranscript } from "../../src/notes/ai/chatPersist";

const COPY = {
  scopeLabel: "This note",
  startFailed: "start failed",
  modelCannotEdit: "model cannot edit",
  stillWorking: "still working",
  autoApplyFailed: "auto apply failed",
  providerRejected: "provider rejected",
  scopeExcluded: "scope excluded",
  // The two sentences a leg that RAN can owe (myne-md/myne#848).
  legFailed: "the run stopped",
  rootGrant: "the scope could not be widened",
  byCause: (cause: string) => `cause:${cause}`,
};

const STEP = {
  view: { runId: "r1", scopeTotal: 3, userGrants: 1, modelGrants: 0, cancelled: false },
  proposal: { edits: [], newNotes: [], summary: "nothing to change" },
  end: { kind: "finished" as const },
  iterations: 1,
  notesRead: 1,
  charsOffDevice: null,
  excludedCount: 0,
  memoryUpdated: 0,
};

/** A fake conversation store: the three IPC calls behind one Map, so a patch
 *  written by the settle can be read back the way the real file would be. */
let files: Map<string, string>;

/** Let the settle's `void settleTurnInConversation(...)` reach its awaits. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

beforeEach(() => {
  __resetChatForTest();
  __resetChatPersistForTest();
  clearAgentForLock();
  files = new Map();
  mockChatsCreate.mockReset().mockImplementation(async (payload: string) => {
    files.set("c1", payload);
    return "c1";
  });
  mockChatsAppendTurn.mockReset().mockImplementation(async (id: string, payload: string) => {
    files.set(id, payload);
  });
  mockChatsRead.mockReset().mockImplementation(async (id: string) => {
    const payload = files.get(id);
    if (payload === undefined) throw new Error("no such conversation");
    return payload;
  });
  agentStart.mockReset().mockResolvedValue(STEP);
});

afterEach(() => {
  __resetChatForTest();
  __resetChatPersistForTest();
  clearAgentForLock();
});

describe("the conversation exists from the first user message", () => {
  it("creates it on send, with the task already in it", async () => {
    await startAgentRun("özetle", { kind: "vault" }, COPY, "tr");

    expect(mockChatsCreate).toHaveBeenCalledTimes(1);
    const [payload] = mockChatsCreate.mock.calls[0] as [string];
    const turns = parseTranscript(payload);
    expect(turns, "the created payload is a transcript").not.toBeNull();
    // The user's turn AND the agent turn `sendAgentTurn` appends, so the
    // conversation is a real one before a reply exists, which is the whole
    // reason it is created here rather than on settle.
    expect(turns!.length).toBe(2);
    expect(JSON.stringify(turns)).toContain("özetle");
    expect(getActiveConversationId()).toBe("c1");
  });

  it("binds the run to it while the run is still in flight", async () => {
    // Read INSIDE `agentStart`, which is the only window in which the run is
    // `running`: that pair is exactly what `AgentHubList` computes its mark
    // from, so it is pinned rather than inferred from the settled state.
    let seen: { running: boolean; id: string | null } | null = null;
    agentStart.mockImplementationOnce(async () => {
      const agent = getAgent();
      seen = { running: agent.running, id: agent.runConversationId };
      return STEP;
    });

    await startAgentRun("özetle", { kind: "vault" }, COPY, "tr");

    expect(seen).toEqual({ running: true, id: "c1" });
  });
});

describe("a failed leg reports its OWN cause (myne-md/myne#848)", () => {
  // The scope-approval resume reported every failure of the approved leg as
  // "The scope could not be widened", so a user who had just pressed Allow was
  // told their permission had not been taken. The host already tags the
  // failure; this is the one mapping from tag to sentence.
  const copy = {
    providerRejected: "PROVIDER",
    scopeExcluded: "EXCLUDED",
    rootGrant: "ROOT",
    modelCannotEdit: "MODEL",
    stillWorking: "WORKING",
    generic: "GENERIC",
    byCause: (cause: string) => `CAUSE:${cause}`,
  };

  it("names the scope only for the tag that IS about the scope", () => {
    expect(legFailureSentence({ kind: "RootGrant" }, copy)).toBe("ROOT");
  });

  it("names the excluded-folders control for an emptied grant", () => {
    expect(legFailureSentence({ kind: "EmptyGrant" }, copy)).toBe("EXCLUDED");
  });

  it("names the provider when the provider refused the request", () => {
    expect(legFailureSentence({ kind: "ProviderRejected" }, copy)).toBe("PROVIDER");
  });

  it("names the GATE a refusal came from, through the shared taxonomy", () => {
    // **The failure that said nothing** (myne-md/myne#848). A gate refusal is a
    // cause, not a tag: "no credential", "consent missing" and "not ready" all
    // arrive as `AgentError::GateRefused { cause }`, and each of those sentences
    // names the control that fixes it. Without this arm the run reported "The
    // agent could not start." for a reason the host had already told the
    // WebView.
    expect(
      legFailureSentence(
        { kind: "GateRefused", detail: { cause: "ConsentMissing" } },
        copy,
      ),
    ).toBe("CAUSE:consent_missing");
    expect(
      legFailureSentence({ kind: "GateRefused", detail: { cause: "Timeout" } }, copy),
    ).toBe("CAUSE:timeout");
    // A gate cause this build does not know still resolves to `failed`, which
    // is the generic arm rather than a guess at a sentence.
    expect(
      legFailureSentence(
        { kind: "GateRefused", detail: { cause: "SomethingNew" } },
        copy,
      ),
    ).toBe("GENERIC");
  });

  it("names the model when the backend cannot make agent edits", () => {
    // `NoModel` and `LocalModelMissing` both map to this tag host-side, and both
    // used to reach the user as "The agent could not start." — a sentence with no
    // cause and no next step (2026-11-27, reported as that sentence repeating).
    expect(legFailureSentence({ kind: "EditFormatUnsupported" }, copy)).toBe("MODEL");
  });

  it("says to wait when a step arrives while the run is still working", () => {
    expect(legFailureSentence({ kind: "StepAlreadyRunning" }, copy)).toBe("WORKING");
  });

  it("falls back for a tag it cannot name, rather than guessing", () => {
    // A NEW host variant lands here rather than being reported as whatever the
    // last author happened to be looking at, which is the shape of the defect.
    expect(legFailureSentence({ kind: "SomeFutureVariant" }, copy)).toBe("GENERIC");
    expect(legFailureSentence(new Error("no tag at all"), copy)).toBe("GENERIC");
    expect(legFailureSentence(null, copy)).toBe("GENERIC");
  });
});

describe("the unread mark's lifetime", () => {
  // The mark is a claim about what the user has SEEN, so its two edges are the
  // two ways that claim can go wrong: it must not outlive the vault whose
  // conversations it names, and it must not be dropped because the user read
  // something ELSE (myne-md/myne#848).
  it("does not survive a vault lock", () => {
    markConversationUnread("c1");
    expect(getAgent().unreadConversations).toContain("c1");
    // The ids name conversations of the vault being left; the next vault's are
    // different ones, so a surviving mark could never be cleared by reading it.
    clearAgentForLock();
    expect(getAgent().unreadConversations).toEqual([]);
  });

  it("survives letting go of a run, because reading something else is not reading this", () => {
    markConversationUnread("c1");
    // `clearAgent` is what closing the review screen and starting a new
    // conversation call. Neither means c1's result has been read.
    clearAgent();
    expect(getAgent().unreadConversations).toContain("c1");
  });
});

describe("a run that outlives navigation", () => {
  it("settles into its own conversation, not the one on screen", async () => {
    await startAgentRun("özetle", { kind: "vault" }, COPY, "tr");
    // The user reads another conversation while the run is still working.
    setActiveConversationId("somewhere-else");
    mockChatsAppendTurn.mockClear();

    settleRunIntoChat(STEP, currentRunEpoch());
    await flush();

    expect(mockChatsAppendTurn).toHaveBeenCalledTimes(1);
    expect(mockChatsAppendTurn.mock.calls[0]![0], "written to the run's own conversation").toBe(
      "c1",
    );
    // And it really landed: the file it wrote carries the summary.
    const patched = parseTranscript(files.get("c1")!);
    expect(JSON.stringify(patched)).toContain("nothing to change");
  });

  it("marks the conversation unread when the result lands", async () => {
    // **A result that lands is a thing to read** (myne-md/myne#848), and this is
    // the half the rail cannot compute: `end` alone would make a conversation
    // unread again the moment the user switched away, so the mark is written
    // where the settle happens and cleared by the surface that displays it.
    await startAgentRun("özetle", { kind: "vault" }, COPY, "tr");
    setActiveConversationId("somewhere-else");

    settleRunIntoChat(STEP, currentRunEpoch());
    await flush();

    expect(getAgent().unreadConversations).toContain("c1");
  });

  it("marks it even when it IS the open one, because only the surface knows", async () => {
    // The closed-surface case: the conversation is still the active one but
    // nothing is displaying it, so an id comparison here would answer "the user
    // is looking at it" and be wrong. `ConversationSurface` clears the mark
    // while it displays the conversation, which is the answer that cannot be
    // guessed from an id.
    await startAgentRun("özetle", { kind: "vault" }, COPY, "tr");
    expect(getActiveConversationId()).toBe("c1");

    settleRunIntoChat(STEP, currentRunEpoch());
    await flush();

    expect(getAgent().unreadConversations).toContain("c1");
  });

  it("still settles into the live transcript when it IS the open one", async () => {
    await startAgentRun("özetle", { kind: "vault" }, COPY, "tr");
    expect(getActiveConversationId()).toBe("c1");
    mockChatsRead.mockClear();

    settleRunIntoChat(STEP, currentRunEpoch());
    await flush();

    // The patch path reads the conversation back first; not reading it is the
    // evidence that the ordinary path was taken.
    expect(mockChatsRead).not.toHaveBeenCalled();
  });
});
