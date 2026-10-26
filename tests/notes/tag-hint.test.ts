// myne-md/myne#908 item 8 — the tag pass must know WHERE the note lives.
//
// The prompt used to carry one flat list of every tag in the vault, so a note
// about one project could be offered another project's tag: the wrong tag was
// simply present in the prompt, and a 0.5B model reaches for the adjacent word.
// Two things changed, and they are deliberately separate:
//
//   1. the PROMPT's vocabulary is scoped to the note's folder, capped and
//      ranked by how many notes in that folder carry the tag;
//   2. the RANKER still folds against the WHOLE vault, so a tag that exists
//      somewhere else keeps rendering as "existing" rather than being
//      reclassified as "new" just because the hint is narrow.
//
// A folder with no tagged siblings sends NO hint. Falling back to the vault is
// the exact behaviour this exists to remove.

import { describe, expect, it } from "vitest";
import {
  buildTagPrompt,
  runTagSuggestionPass,
  TAG_HINT_MAX,
} from "../../src/notes/ai/suggestTags";
import { createTagSuggestionTrigger } from "../../src/notes/ai/tagSuggestionTrigger";

function tags(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `tag-${i}`);
}

describe("buildTagPrompt", () => {
  it("caps the reusable-vocabulary hint", () => {
    const prompt = buildTagPrompt("body", tags(TAG_HINT_MAX + 20));
    expect(prompt).toContain("tag-0");
    expect(prompt).toContain(`tag-${TAG_HINT_MAX - 1}`);
    expect(prompt).not.toContain(`tag-${TAG_HINT_MAX},`);
  });

  it("omits the hint entirely when the folder has no vocabulary", () => {
    const prompt = buildTagPrompt("body", []);
    expect(prompt).not.toContain("Prefer reusing");
  });
});

describe("runTagSuggestionPass", () => {
  const base = {
    noteId: "n1",
    noteBody: "A note about the myne vault.",
    noteFolder: "Projects/Myne/",
    excludedFolders: [],
  };

  it("prompts with the folder hint but ranks against the whole vault", async () => {
    let seenPrompt = "";
    const pass = await runTagSuggestionPass({
      ...base,
      existingTags: ["gathin"],
      hintTags: ["myne", "rust"],
      suggest: async ({ prompt }) => {
        seenPrompt = prompt;
        return "myne, gathin";
      },
    });
    expect(seenPrompt).toContain("myne");
    expect(seenPrompt).not.toContain("gathin");
    // Ranking saw the vault, so `gathin` is an EXISTING tag even though the
    // prompt never offered it. Narrowing the hint must not relabel the band.
    const gathin = pass.suggestions.find((s) => s.tag === "gathin");
    expect(gathin?.isNew).toBe(false);
  });

  it("sends no hint when the folder scope is empty", async () => {
    let seenPrompt = "";
    await runTagSuggestionPass({
      ...base,
      existingTags: ["gathin"],
      hintTags: [],
      suggest: async ({ prompt }) => {
        seenPrompt = prompt;
        return "myne";
      },
    });
    expect(seenPrompt).not.toContain("Prefer reusing");
    expect(seenPrompt).not.toContain("gathin");
  });

  it("still short-circuits an excluded folder before the model is called", async () => {
    let called = false;
    const pass = await runTagSuggestionPass({
      ...base,
      noteFolder: "Private/",
      excludedFolders: ["Private/"],
      existingTags: [],
      hintTags: [],
      suggest: async () => {
        called = true;
        return "x";
      },
    });
    expect(called).toBe(false);
    expect(pass.skipped).toBe(true);
  });
});

describe("the trigger asks for the note's folder vocabulary", () => {
  it("passes the note's folder and omits the hint when it comes back empty", async () => {
    const folders: string[] = [];
    let seenPrompt = "";
    const trigger = createTagSuggestionTrigger({
      existingTags: async () => ["gathin"],
      folderTags: async (folder) => {
        folders.push(folder);
        return [];
      },
      excludedFolders: () => [],
      debounceMs: 0,
      suggest: async ({ prompt }) => {
        seenPrompt = prompt;
        return "myne";
      },
      onResult: () => {},
    });

    trigger.schedule({
      noteId: "n1",
      noteBody: "myne vault design",
      noteFolder: "Projects/Myne/",
    });
    await new Promise((r) => setTimeout(r, 10));
    trigger.cancel();

    expect(folders).toEqual(["Projects/Myne/"]);
    expect(seenPrompt).not.toContain("Prefer reusing");
    expect(seenPrompt).not.toContain("gathin");
  });
});
