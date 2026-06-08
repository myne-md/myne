// Obsidian importer — conflict / idempotent-re-import (MYND-50, tasks 1–4).
// Drives off the shared daily-resolver folding (folderKey + foldSegment), not a
// re-implemented key. The import-twice idempotency is also asserted end-to-end
// in MYND-90's fixture; here we own the unit-level assertions.

import { describe, it, expect } from "vitest";
import {
  buildExistingIdentitySet,
  noteIdentityExists,
  decideImport,
  tallyDecisions,
  DEFAULT_DUPLICATE_POLICY,
  type ExistingNote,
  type ImportDecision,
} from "../../src/notes/import/conflict";
import { folderKey } from "../../src/dialect/folderPath";

const note = (
  folder: string | null,
  title: string | null,
  extra: Partial<ExistingNote> = {},
): ExistingNote => ({ folder, title, trashed: null, template: false, ...extra });

describe("identity predicate — folds identically to the daily resolver", () => {
  it("matches case-only-distinct (folder, title) (Projects/Daily ≡ projects/daily)", () => {
    const set = buildExistingIdentitySet([note("Projects/", "Daily")]);
    expect(noteIdentityExists(set, "projects/", "daily")).toBe(true);
  });

  it("matches NFC ≡ NFD title variants to one identity", () => {
    const nfd = "Cafe" + String.fromCharCode(0x0301); // decomposed (e + U+0301)
    const nfc = nfd.normalize("NFC"); // precomposed (U+00E9)
    expect(nfc).not.toBe(nfd); // genuinely distinct code-point sequences
    const set = buildExistingIdentitySet([note("Notes/", nfc)]);
    expect(noteIdentityExists(set, "Notes/", nfd)).toBe(true);
  });

  it("normalizes root folder identity", () => {
    const set = buildExistingIdentitySet([note(null, "Inbox")]);
    expect(noteIdentityExists(set, "", "inbox")).toBe(true);
    expect(folderKey(null)).toBe(""); // shared folderKey root convention
  });

  it("does not false-match a distinct folder or title", () => {
    const set = buildExistingIdentitySet([note("A/", "X")]);
    expect(noteIdentityExists(set, "B/", "X")).toBe(false);
    expect(noteIdentityExists(set, "A/", "Y")).toBe(false);
  });

  it("excludes trashed + template + untitled notes from the live set", () => {
    const set = buildExistingIdentitySet([
      note("A/", "Trashed", { trashed: "2026-01-01T00:00:00Z" }),
      note("A/", "Template", { template: true }),
      note("A/", null), // untitled — no matchable identity
    ]);
    expect(noteIdentityExists(set, "A/", "Trashed")).toBe(false);
    expect(noteIdentityExists(set, "A/", "Template")).toBe(false);
    expect(set.size).toBe(0);
  });
});

describe("decideImport — toggle branch (no overwrite/update path)", () => {
  const set = buildExistingIdentitySet([note("A/", "Dup")]);

  it("default (skip): a match is skipped, existing note untouched", () => {
    expect(DEFAULT_DUPLICATE_POLICY).toBe("skip");
    expect(decideImport(set, "A/", "Dup", "skip")).toBe("skip");
  });

  it("default: no-match always creates", () => {
    expect(decideImport(set, "A/", "Fresh", "skip")).toBe("create");
  });

  it("import-as-copy: a match still creates a second legal pair", () => {
    expect(decideImport(set, "A/", "Dup", "import-as-copy")).toBe("create");
  });

  it("import-as-copy: no-match creates", () => {
    expect(decideImport(set, "A/", "Fresh", "import-as-copy")).toBe("create");
  });
});

describe("import-twice idempotency (FM-titled notes)", () => {
  it("second run skips all; count unchanged; no duplicate pair", () => {
    const vault = [
      note("Projects/", "Plan"),
      note("Daily/", "2026-06-08"),
      note(null, "Inbox"),
    ];
    const set = buildExistingIdentitySet(vault);
    const decisions: ImportDecision[] = vault.map((n) =>
      decideImport(set, n.folder, n.title as string, "skip"),
    );
    expect(decisions.every((d) => d === "skip")).toBe(true);
    expect(tallyDecisions(decisions)).toEqual({ created: 0, skippedExisting: 3 });
  });
});

describe("documented residual — untitled imports cannot be deduped", () => {
  it("an untitled existing note does not match a filename-derived candidate", () => {
    // First import created an untitled note (no FM title:) in Daily/. Re-import
    // of "Daily.md" derives read-time title "Daily" — no persisted identity to
    // match, so it is (correctly, per the frontmatter-only-title model) created.
    const set = buildExistingIdentitySet([note("Daily/", null)]);
    expect(decideImport(set, "Daily/", "Daily", "skip")).toBe("create");
  });
});

describe("tallyDecisions", () => {
  it("counts skips vs creates", () => {
    expect(
      tallyDecisions(["skip", "create", "skip", "create", "create"]),
    ).toEqual({ created: 3, skippedExisting: 2 });
  });
});
