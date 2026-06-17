// Pure chip-resolution helpers (MYND-37/83): broken-state (§5.3) + hover text
// (§6.2) without mounting a CodeMirror view. Embeds are excluded from both.

import { describe, it, expect } from "vitest";
import {
  isWikilinkBroken,
  chipHoverText,
  chipKeySets,
  isChipBroken,
  resolveChipParts,
} from "../../src/editor/wikilink/resolve-chip";
import type { WikilinkParts } from "../../src/editor/wikilink/chip-widget";
import type { ResolverNote } from "../../src/notes/resolveWikilink";

const note = (
  noteUuid: string,
  title: string | null,
  folder: string | null,
): ResolverNote => ({ noteUuid, title, folder });

const idxNote = (
  noteUuid: string,
  title: string | null,
  folder: string | null,
): ResolverNote => ({ noteUuid, title, folder, folderIndex: true });

const parts = (over: Partial<WikilinkParts>): WikilinkParts => ({
  isEmbed: false,
  target: null,
  alias: null,
  heading: null,
  ...over,
});

describe("isWikilinkBroken (§5.3)", () => {
  it("non-embed with no matching title → broken", () => {
    expect(isWikilinkBroken(parts({ target: "Nope" }), [note("a", "Other", null)])).toBe(true);
  });
  it("non-embed with a matching title → not broken", () => {
    expect(isWikilinkBroken(parts({ target: "Wednesday" }), [note("a", "Wednesday", null)])).toBe(false);
  });
  it("MEDIA embed is never broken-styled (deferred to attachments)", () => {
    expect(isWikilinkBroken(parts({ isEmbed: true, target: "image.png" }), [])).toBe(false);
  });
  it("NOTE embed IS broken when its target note is missing (MYND-44)", () => {
    expect(isWikilinkBroken(parts({ isEmbed: true, target: "Ghost" }), [note("a", "Other", null)])).toBe(true);
  });
  it("NOTE embed is not broken when the note exists", () => {
    expect(isWikilinkBroken(parts({ isEmbed: true, target: "Daily" }), [note("a", "Daily", null)])).toBe(false);
  });
  it("empty target is not broken-styled", () => {
    expect(isWikilinkBroken(parts({ target: "" }), [])).toBe(false);
  });
});

describe("isChipBroken — folder-target chips (MYND-370)", () => {
  const broken = (p: WikilinkParts, notes: ResolverNote[]) => {
    const { titles, folderIndex } = chipKeySets(notes);
    return isChipBroken(p, titles, folderIndex);
  };

  it("`[[Projects/]]` is NOT broken when the folder has an index note", () => {
    expect(
      broken(parts({ target: "Projects/" }), [idxNote("i", "Index", "Projects/")]),
    ).toBe(false);
  });

  it("`[[Projects/]]` IS broken when the folder has no index note", () => {
    // The folder exists (a note lives in it) but carries no index note.
    expect(
      broken(parts({ target: "Projects/" }), [note("a", "Note", "Projects/")]),
    ).toBe(true);
  });

  it("`[[Ghost/]]` IS broken when the folder does not exist", () => {
    expect(broken(parts({ target: "Ghost/" }), [idxNote("i", "I", "Projects/")])).toBe(
      true,
    );
  });

  it("a non-folder chip still uses the title path (no slash)", () => {
    // `[[Projects]]` resolves on title, unaffected by the folder-index set.
    expect(broken(parts({ target: "Projects" }), [idxNote("i", "I", "Projects/")])).toBe(
      true,
    );
    expect(broken(parts({ target: "Index" }), [idxNote("i", "Index", "Projects/")])).toBe(
      false,
    );
  });
});

describe("resolveChipParts", () => {
  it("returns null for MEDIA embeds", () => {
    expect(resolveChipParts(parts({ isEmbed: true, target: "image.png" }), [])).toBeNull();
  });
  it("resolves a non-embed link", () => {
    const r = resolveChipParts(parts({ target: "Wednesday" }), [note("a", "Wednesday", null)]);
    expect(r?.status).toBe("resolved");
  });
  it("resolves a NOTE embed (MYND-44 click-through/broken target)", () => {
    const r = resolveChipParts(parts({ isEmbed: true, target: "Daily" }), [note("a", "Daily", null)]);
    expect(r?.status).toBe("resolved");
    expect(r?.status === "resolved" && r.noteUuid).toBe("a");
  });
});

describe("chipHoverText (§6.2)", () => {
  it("resolved → 'Display → path'", () => {
    const ns = [note("a", "01-10", "notes/2025/")];
    const p = parts({ target: "notes/2025/01-10.md", alias: "Wednesday" });
    expect(chipHoverText("Wednesday", p, ns)).toBe("Wednesday → notes/2025/01-10.md");
  });
  it("root note → '<title>.md'", () => {
    const ns = [note("a", "Wednesday", null)];
    expect(chipHoverText("Wednesday", parts({ target: "Wednesday" }), ns)).toBe(
      "Wednesday → Wednesday.md",
    );
  });
  it("ambiguous → 'Display → <first path> (N matches)'", () => {
    const ns = [note("a", "Foo", "Projects/"), note("b", "Foo", "Archive/")];
    // shortest-path lexicographic tiebreak at equal depth → "archive/" < "projects/" → b.
    expect(chipHoverText("Foo", parts({ target: "Foo" }), ns)).toBe(
      "Foo → Archive/Foo.md (2 matches)",
    );
  });
  it("broken → '(no match)'", () => {
    expect(chipHoverText("Nope", parts({ target: "Nope" }), [note("a", "Other", null)])).toBe(
      "(no match)",
    );
  });
  it("MEDIA embed → null (no tooltip)", () => {
    expect(chipHoverText("Embed: image.png", parts({ isEmbed: true, target: "image.png" }), [])).toBeNull();
  });
  it("NOTE embed → resolves with hover (MYND-44)", () => {
    const ns = [note("a", "Daily", null)];
    expect(chipHoverText("Embed: Daily", parts({ isEmbed: true, target: "Daily" }), ns)).toBe(
      "Embed: Daily → Daily.md",
    );
  });
});
