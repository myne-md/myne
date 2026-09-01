import { describe, expect, it } from "vitest";

import { assembleSummarizePrompt } from "../../src/notes/ai/summarize";
import { buildTagPrompt } from "../../src/notes/ai/suggestTags";

/**
 * myne-md/myne#618 fixed the agent's prompt so a Turkish note does not come back
 * summarized in English, and asked whether the same gap existed on the two
 * surfaces beside it. It did. These pin the answer, because a prompt sentence is
 * exactly the kind of claim that is true on the day it is written and unchecked
 * ever after: nothing else in the tree reads these strings.
 *
 * The anchor is the NOTE rather than the user's language, and that is the one
 * thing worth asserting about rather than the exact wording. The agent is told
 * the user's language explicitly, from prefs, because it has a user turn to
 * carry it. Neither of these has any user text at all, so "the user's language"
 * would be a phrase the model cannot resolve.
 */
describe("the note-derived language line", () => {
  it("is in the summarize prompt", () => {
    const prompt = assembleSummarizePrompt("Bir not gövdesi.");
    expect(prompt).toContain("same language as the note");
    expect(prompt).toContain("Bir not gövdesi.");
  });

  it("is in the tag prompt, with and without the existing-tag hint", () => {
    expect(buildTagPrompt("Bir not gövdesi.", [])).toContain(
      "same language as the note",
    );
    expect(buildTagPrompt("Bir not gövdesi.", ["iş", "proje"])).toContain(
      "same language as the note",
    );
  });

  it("names no specific language, so it cannot pin the answer to English", () => {
    // The failure this rules out is a well-meaning "answer in English" or a
    // hardcoded locale: the instruction has to defer to the input, whatever it
    // is, or it is the defect #618 fixed wearing a fix's clothes.
    const prompts = [
      assembleSummarizePrompt("x"),
      buildTagPrompt("x", []),
    ];
    for (const p of prompts) {
      expect(p).not.toMatch(/\bin English\b/i);
    }
  });
});
