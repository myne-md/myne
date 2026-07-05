import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";

import { runSummarizeToChat, runTagSuggestToChat } from "../../src/notes/ai/aiToChat";
import { getChat, __resetChatForTest } from "../../src/notes/ai/chatStore";

// conversational-ai-chat tasks 10/11 — summarize + tag-suggest folded into the
// chat transcript (reusing the pure runSummarize / runTagSuggestionPass cores).

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

describe("runTagSuggestToChat (task 11)", () => {
  it("appends a 'Suggest tags' user turn + an assistant turn", async () => {
    await runTagSuggestToChat({
      noteBody: "rust ownership and borrowing",
      noteFolder: "",
      existingTags: [],
      excludedFolders: [],
      infer: async () => "rust, ownership",
    });
    const chat = getChat();
    expect(chat.turns).toHaveLength(2);
    expect(chat.turns[0].text).toBe("Suggest tags for this note");
    expect(chat.turns[1].role).toBe("assistant");
    expect(chat.turns[1].error).toBe(false);
    expect(chat.streaming).toBe(false);
  });

  it("an excluded-folder note yields an empty (chip-less) turn, not an error", async () => {
    await runTagSuggestToChat({
      noteBody: "secret",
      noteFolder: "Private",
      // Excluded-folder entries carry a trailing slash (Rust `canonical_folder`
      // twin — see `isNoteAiExcluded`).
      excludedFolders: ["Private/"],
      existingTags: [],
      infer: async () => {
        throw new Error("infer must not run for an excluded folder");
      },
    });
    const chat = getChat();
    expect(chat.turns).toHaveLength(2);
    expect(chat.turns[1].tagSuggestions).toHaveLength(0);
    expect(chat.turns[1].error).toBe(false);
  });
});
