// @vitest-environment jsdom
//
// Conversation titles: derived synchronously, improved locally and never by a
// provider (myne-md/myne#848).
//
// Six properties, and the last two are the ones a reviewer should check the
// mocking for:
//
//   1. no local generation model means no model call AT ALL, not a call that
//      fails, `inferAmbient` is asserted uncalled, so a future "just try it"
//      refactor is caught here;
//   2. the generated title is capped to the same 48 scalar values the derived
//      one uses, so a catalog row's width never depends on which path produced
//      it;
//   3. a refused generation leaves the derived title and says nothing;
//   4. a client without the local-inference command (the web bundle, mobile) is
//      not an error: the gate read is guarded;
//   5. **the title is asked for on the AMBIENT class**: the host refuses a
//      remote backend for ambient (`EngineError::RemoteBarred`,
//      `core/src/inference/state.rs::ambient_requests_are_refused_a_remote_backend`),
//      and `infer`, the class that CAN be remote, is asserted never called;
//   6. the `title_derived_from` snapshot is untouched by generation, which is
//      what keeps a later manual rename detectable.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockLoadModelPath,
  mockInferAmbient,
  mockInfer,
  mockChatsRename,
  mockChatsCreate,
  mockChatsAppendTurn,
  mockChatsRead,
  mockChatsList,
} = vi.hoisted(() => ({
  mockLoadModelPath: vi.fn(),
  mockInferAmbient: vi.fn(),
  mockInfer: vi.fn(),
  mockChatsRename: vi.fn(),
  mockChatsCreate: vi.fn(),
  mockChatsAppendTurn: vi.fn(),
  mockChatsRead: vi.fn(),
  mockChatsList: vi.fn(),
}));

vi.mock("../../src/lib/ai-model-store", () => ({
  loadModelPath: (...a: unknown[]) => mockLoadModelPath(...a),
}));

vi.mock("../../src/lib/writing-assistant", () => ({
  infer: (...a: unknown[]) => mockInfer(...a),
  inferAmbient: (...a: unknown[]) => mockInferAmbient(...a),
}));

vi.mock("../../src/lib/chats", () => ({
  subscribeConversationRoster: () => () => {},
  chatsCreate: (...a: unknown[]) => mockChatsCreate(...a),
  chatsAppendTurn: (...a: unknown[]) => mockChatsAppendTurn(...a),
  chatsRead: (...a: unknown[]) => mockChatsRead(...a),
  chatsRename: (...a: unknown[]) => mockChatsRename(...a),
  chatsList: (...a: unknown[]) => mockChatsList(...a),
}));

const agentStart = vi.fn();
vi.mock("../../src/lib/agent-run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/agent-run")>()),
  agentStart: (...a: unknown[]) => agentStart(...a),
}));

import {
  TITLE_MAX_NEW_TOKENS,
  TITLE_PROMPT_INPUT_MAX_USVS,
  buildTitlePrompt,
  capGeneratedTitle,
  capUsvs,
  generateConversationTitle,
  maybeGenerateConversationTitle,
} from "../../src/notes/ai/conversationTitle";
import { TITLE_DERIVATION_MAX_USVS } from "../../src/notes/ai/chatPersist";
import { startAgentRun } from "../../src/notes/ai/agentToChat";
import { clearAgentForLock } from "../../src/notes/agent/agentStore";
import { __resetChatForTest } from "../../src/notes/ai/chatStore";

const LONG_TURN = "a".repeat(200);
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
  view: { runId: "r1", scopeTotal: 1, userGrants: 1, modelGrants: 0, cancelled: false },
  proposal: { edits: [], newNotes: [], summary: "" },
  end: { kind: "finished" as const },
  iterations: 1,
  notesRead: 0,
  charsOffDevice: null,
  excludedCount: 0,
  memoryUpdated: 0,
};

beforeEach(() => {
  __resetChatForTest();
  clearAgentForLock();
  mockLoadModelPath.mockReset().mockResolvedValue("/models/qwen.gguf");
  mockInferAmbient.mockReset().mockResolvedValue("Kira raporu");
  mockInfer.mockReset();
  mockChatsRename.mockReset().mockResolvedValue(undefined);
  mockChatsCreate.mockReset().mockResolvedValue("c1");
  mockChatsAppendTurn.mockReset().mockResolvedValue(undefined);
  mockChatsRead.mockReset().mockResolvedValue(JSON.stringify({ turns: [] }));
  mockChatsList.mockReset().mockResolvedValue([]);
  agentStart.mockReset().mockResolvedValue(STEP);
});

afterEach(() => {
  __resetChatForTest();
  clearAgentForLock();
});

describe("the pure shaping", () => {
  it("caps by Unicode scalar values, not by UTF-16 units", () => {
    // An emoji outside the BMP is TWO UTF-16 units and ONE scalar value, so a
    // `.slice(0, 48)` would produce 24 of them and a `.length` check would pass.
    const emoji = "😀".repeat(60);
    expect(capUsvs(emoji, TITLE_DERIVATION_MAX_USVS)).toBe("😀".repeat(48));
    expect([...capUsvs(emoji, TITLE_DERIVATION_MAX_USVS)].length).toBe(48);
  });

  it("takes the first non-empty line, strips quotes, collapses whitespace", () => {
    expect(capGeneratedTitle('"Kira raporu"\nextra commentary here')).toBe("Kira raporu");
    expect(capGeneratedTitle("\n\n  Kira   raporu  \n")).toBe("Kira raporu");
    expect(capGeneratedTitle("“Kira raporu”")).toBe("Kira raporu");
    expect(capGeneratedTitle("   \n  ")).toBe("");
  });

  it("caps a generated title at the derivation budget", () => {
    const title = capGeneratedTitle("word ".repeat(40));
    expect([...title].length).toBeLessThanOrEqual(TITLE_DERIVATION_MAX_USVS);
  });

  it("carries the user's words as data, capped, in the prompt", () => {
    const prompt = buildTitlePrompt(LONG_TURN);
    expect(prompt).toContain(capUsvs(LONG_TURN, TITLE_PROMPT_INPUT_MAX_USVS));
    // The prompt is bounded by its own input cap and by the model's output
    // ceiling, which are the only two cost bounds this feature has.
    expect(prompt.length).toBeLessThan(TITLE_PROMPT_INPUT_MAX_USVS + 400);
    expect(TITLE_MAX_NEW_TOKENS).toBeGreaterThan(0);
  });
});

describe("maybeGenerateConversationTitle", () => {
  it("makes no model call when no local generation model is configured", async () => {
    mockLoadModelPath.mockResolvedValue(null);
    await maybeGenerateConversationTitle("c1", "özetle");
    expect(mockInferAmbient).not.toHaveBeenCalled();
    expect(mockInfer).not.toHaveBeenCalled();
    expect(mockChatsRename).not.toHaveBeenCalled();
  });

  it("asks the AMBIENT class, and never the class that can be remote", async () => {
    await maybeGenerateConversationTitle("c1", "özetle");
    expect(mockInferAmbient).toHaveBeenCalledTimes(1);
    // The frontend half of "a provider is never consulted for a title": `infer`
    // is the user-initiated class, which the host WILL serve from a provider.
    expect(mockInfer).not.toHaveBeenCalled();
    expect(mockChatsRename).toHaveBeenCalledWith("c1", "Kira raporu");
  });

  it("caps what it renames to", async () => {
    mockInferAmbient.mockResolvedValue("word ".repeat(40));
    await maybeGenerateConversationTitle("c1", "özetle");
    const [, title] = mockChatsRename.mock.calls[0] as [string, string];
    expect([...title].length).toBeLessThanOrEqual(TITLE_DERIVATION_MAX_USVS);
  });

  it("leaves the derived title and stays quiet when generation is refused", async () => {
    mockInferAmbient.mockRejectedValue({ kind: "RemoteBarred" });
    await expect(maybeGenerateConversationTitle("c1", "özetle")).resolves.toBeUndefined();
    expect(mockChatsRename).not.toHaveBeenCalled();
  });

  it("is not an error on a client with no local-inference command", async () => {
    // The web bundle and mobile have no local engine, so the gate read rejects
    // rather than answering null. That must not surface anywhere.
    mockLoadModelPath.mockRejectedValue({ kind: "Unsupported" });
    await expect(maybeGenerateConversationTitle("c1", "özetle")).resolves.toBeUndefined();
    expect(mockInferAmbient).not.toHaveBeenCalled();
  });

  it("never overwrites a title a human wrote", async () => {
    // **The row still holds the DERIVED title when nobody has renamed it**, so a
    // row that says something else is a rename, and this runs on every message:
    // without the guard, sending a second message replaced the user's title.
    mockChatsList.mockResolvedValue([
      { id: "c1", title: "Kira raporu", created_at: 1, updated_at: 1, version: 1 },
    ]);
    await maybeGenerateConversationTitle("c1", "özetle");
    expect(mockInferAmbient).not.toHaveBeenCalled();
    expect(mockChatsRename).not.toHaveBeenCalled();
  });

  it("does rename while the row still carries the derived title", async () => {
    // The other direction, so the guard cannot pass by never renaming.
    mockChatsList.mockResolvedValue([
      { id: "c1", title: "özetle", created_at: 1, updated_at: 1, version: 1 },
    ]);
    await maybeGenerateConversationTitle("c1", "özetle");
    expect(mockChatsRename).toHaveBeenCalledWith("c1", "Kira raporu");
  });

  it("does not rename blind when the roster cannot be read", async () => {
    mockChatsList.mockRejectedValue(new Error("store"));
    await maybeGenerateConversationTitle("c1", "özetle");
    expect(mockInferAmbient).not.toHaveBeenCalled();
    expect(mockChatsRename).not.toHaveBeenCalled();
  });

  it("does nothing without a conversation to rename", async () => {
    await maybeGenerateConversationTitle(null, "özetle");
    expect(mockLoadModelPath).not.toHaveBeenCalled();
    expect(mockChatsRename).not.toHaveBeenCalled();
  });

  it("a rename that fails leaves the derived title and does not throw", async () => {
    mockChatsRename.mockRejectedValue(new Error("store"));
    await expect(maybeGenerateConversationTitle("c1", "özetle")).resolves.toBeUndefined();
    expect(mockInferAmbient).toHaveBeenCalled();
  });

  it("generateConversationTitle answers null on an unusable reply", async () => {
    mockInferAmbient.mockResolvedValue("   \n ");
    expect(await generateConversationTitle("özetle")).toBeNull();
  });
});

describe("through a run: the snapshot is the input, not a re-derivation key", () => {
  it("generates a title without touching title_derived_from", async () => {
    const task = "kirayı öde";
    await startAgentRun(task, { kind: "vault" }, COPY, "tr");
    // The rename is `void`ed inside the run, so let its microtasks land.
    for (let i = 0; i < 4; i += 1) await Promise.resolve();

    expect(mockChatsRename).toHaveBeenCalledWith("c1", "Kira raporu");
    // And the snapshot is still the derivation INPUT: the first 48 scalar
    // values of the first user turn, produced by `serializeTranscript` and
    // ignored by everything this feature does.
    const [payload] = mockChatsCreate.mock.calls[0] as [string];
    expect(JSON.parse(payload).title_derived_from).toBe(capUsvs(task, TITLE_DERIVATION_MAX_USVS));
  });
});
