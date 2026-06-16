// `duplicateNote` — clone-in-place orchestration (MYND-332).
//
// We mock the IPC boundary only (`readNote`, `createNote`); the dialect
// surgery (`locateFrontmatter`, `readTitleFromFmBody`, `renamedTitleBody`)
// stays real so the title-derivation + frontmatter-preservation wiring is
// exercised end-to-end. The copy's plaintext is captured off the mocked
// `noteCreate` and re-parsed with the real dialect helpers to assert it.

import { afterEach, describe, expect, it, vi } from "vitest";

const noteRead = vi.fn<(id: string) => Promise<string>>();
const noteCreate = vi.fn<(plaintext: string) => Promise<string>>();
vi.mock("../../src/notes/readNote", () => ({
  noteRead: (...a: [string]) => noteRead(...a),
}));
vi.mock("../../src/notes/createNote", () => ({
  noteCreate: (...a: [string]) => noteCreate(...a),
}));

import { duplicateNote, duplicatedTitle } from "../../src/notes/duplicateNote";
import { locateFrontmatter } from "../../src/dialect/lezer/frontmatter";
import { readTitleFromFmBody } from "../../src/dialect";

/** Re-parse the FM `title:` from a full note plaintext (mirrors the helper). */
function titleOf(bytes: string): string | null {
  const fm = locateFrontmatter(bytes);
  return fm ? readTitleFromFmBody(bytes.slice(fm.bodyStart, fm.bodyEnd)) : null;
}

/** Resolve `duplicateNote` and return the plaintext handed to `noteCreate`. */
async function captureCopy(source: string): Promise<string> {
  noteRead.mockResolvedValueOnce(source);
  noteCreate.mockResolvedValueOnce("new-id");
  await duplicateNote("source-id");
  expect(noteCreate).toHaveBeenCalledTimes(1);
  return noteCreate.mock.calls[0]![0];
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("duplicatedTitle", () => {
  it("appends the copy suffix to a titled note", () => {
    expect(duplicatedTitle("Notlarım")).toBe("Notlarım (kopya)");
  });

  it("falls back to a bare suffix for an untitled / blank source", () => {
    expect(duplicatedTitle(null)).toBe("(kopya)");
    expect(duplicatedTitle("")).toBe("(kopya)");
    expect(duplicatedTitle("   ")).toBe("(kopya)");
  });
});

describe("duplicateNote", () => {
  it("reads the source then creates a copy (one read, one create)", async () => {
    noteRead.mockResolvedValueOnce("---\ntitle: A\n---\nbody");
    noteCreate.mockResolvedValueOnce("copy-id");
    const id = await duplicateNote("source-id");
    expect(id).toBe("copy-id");
    expect(noteRead).toHaveBeenCalledWith("source-id");
    expect(noteCreate).toHaveBeenCalledTimes(1);
  });

  it("writes a '(kopya)'-suffixed title for a titled source", async () => {
    const copy = await captureCopy("---\ntitle: Project Plan\n---\nhello");
    expect(titleOf(copy)).toBe("Project Plan (kopya)");
    expect(copy).toContain("hello"); // body preserved
  });

  it("injects a bare '(kopya)' title for a source with no frontmatter", async () => {
    const copy = await captureCopy("just a body, no frontmatter\n");
    expect(titleOf(copy)).toBe("(kopya)");
    expect(copy).toContain("just a body, no frontmatter");
  });

  it("preserves the folder: and template: flags on the copy", async () => {
    const copy = await captureCopy(
      "---\ntitle: T\nfolder: work/\ntemplate: true\n---\nx",
    );
    expect(titleOf(copy)).toBe("T (kopya)");
    expect(copy).toContain("folder: work/");
    expect(copy).toContain("template: true");
  });

  it("advances the updated: timestamp (duplicate is a fresh write)", async () => {
    const copy = await captureCopy(
      "---\ntitle: T\nupdated: 2020-01-01T00:00:00.000Z\n---\nx",
    );
    expect(copy).toMatch(/updated: .+/);
    expect(copy).not.toContain("2020-01-01T00:00:00.000Z");
  });

  it("does not create when the source read fails", async () => {
    noteRead.mockRejectedValueOnce(new Error("CannotDecrypt"));
    await expect(duplicateNote("source-id")).rejects.toThrow("CannotDecrypt");
    expect(noteCreate).not.toHaveBeenCalled();
  });
});
