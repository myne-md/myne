import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";

import { runSummarizeToChat } from "../../src/notes/ai/aiToChat";
import { getChat, __resetChatForTest } from "../../src/notes/ai/chatStore";

// conversational-ai-chat task 10 — summarize folded into the chat transcript
// (reusing the pure runSummarize core). The tag-suggest turn that lived here too
// is gone with the chat-tab tag surface (MYND-651).

afterEach(() => __resetChatForTest());

describe("runSummarizeToChat (task 10)", () => {
  it("appends a 'Summarize this note' user turn + an insertable assistant summary", async () => {
    const state = EditorState.create({
      doc: "The mitochondria is the powerhouse of the cell.",
    });
    await runSummarizeToChat({
      state,
      budget: 4000,
      infer: async () => "A short summary.",
    });
    const chat = getChat();
    expect(chat.streaming).toBe(false);
    expect(chat.turns).toHaveLength(2);
    expect(chat.turns[0]).toMatchObject({ role: "user", text: "Summarize this note" });
    expect(chat.turns[1].role).toBe("assistant");
    expect(chat.turns[1].text).toBe("A short summary.");
    // Insertable → the per-turn "Insert into note" action appears (SYNC-17).
    expect(chat.turns[1].insertable).toBe(true);
  });

  it("marks the assistant turn errored when the engine throws", async () => {
    const state = EditorState.create({ doc: "some note body" });
    await runSummarizeToChat({
      state,
      budget: 4000,
      infer: async () => {
        throw new Error("engine down");
      },
    });
    const chat = getChat();
    expect(chat.turns[1].error).toBe(true);
    expect(chat.streaming).toBe(false);
  });
});
