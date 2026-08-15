// Importer managed-field reject list (MYND-613, task 1) — a data-loss fix.
//
// The importer's reject list named five of the eleven Myne-managed frontmatter
// fields inline, so an imported file could forge the other six. The failure is
// silent and specific: a note arriving with a property named like a managed
// state field, carrying a plausible value, is indistinguishable from Myne's own
// state. Value-strictness protects the flag-shaped fields (`template: true`)
// but NOT the timestamp-shaped ones — an imported ISO date *is* a valid value.

import { describe, expect, it } from "vitest";
import {
  MANAGED_FRONTMATTER_FIELDS,
  isManagedFrontmatterField,
} from "../../src/dialect/managedFields";
import { propertiesToFrontmatter } from "../../src/notes/import/notion/transform";

describe("the managed-field constant", () => {
  it("lists every field the specification's §3.6.1 table names", () => {
    expect([...MANAGED_FRONTMATTER_FIELDS]).toEqual([
      "updated",
      "title",
      "folder",
      "trashed",
      "template",
      "folder_index",
      "kind",
      "archived",
      "deleted",
      "conflict",
      "conflict_of",
      // MYND-613 task 3 — the twelfth, added with the field itself.
      "done",
      // myne-md/myne#410 — the thirteenth, added with the field itself.
      // `cover:` is a property Obsidian vaults already carry, so leaving it off
      // this list would let an imported file forge Myne's cover state.
      "cover",
    ]);
  });

  it("matches case-insensitively", () => {
    // A foreign tool's casing must not be a bypass: `Trashed:` forges state
    // exactly as well as `trashed:`.
    expect(isManagedFrontmatterField("Trashed")).toBe(true);
    expect(isManagedFrontmatterField("CONFLICT_OF")).toBe(true);
  });

  it("does not claim ordinary user keys", () => {
    for (const key of ["status", "priority", "author", "tags", "due", "source"]) {
      expect(isManagedFrontmatterField(key)).toBe(false);
    }
  });
});

describe("the importer rejects every managed key", () => {
  it("rejects all eleven, not just the five the inline list named", () => {
    const properties = Object.fromEntries(
      MANAGED_FRONTMATTER_FIELDS.map((key) => [key, "2026-07-28T00:00:00Z"]),
    );
    const { lines, rejected } = propertiesToFrontmatter(properties);
    expect(lines).toEqual([]);
    expect(rejected.sort()).toEqual([...MANAGED_FRONTMATTER_FIELDS].sort());
  });

  it("rejects the six that used to slip through", () => {
    // These are the ones the inline five-name list missed. Each is a real
    // forgery: an imported `deleted:` timestamp would hide the note.
    const previouslyForgeable = [
      "updated",
      "folder_index",
      "kind",
      "deleted",
      "conflict",
      "conflict_of",
    ];
    const { rejected } = propertiesToFrontmatter(
      Object.fromEntries(previouslyForgeable.map((k) => [k, "2026-07-28T00:00:00Z"])),
    );
    expect(rejected.sort()).toEqual([...previouslyForgeable].sort());
  });

  it("still carries ordinary user properties through", () => {
    const { lines, rejected } = propertiesToFrontmatter({
      status: "in-progress",
      priority: "high",
    });
    expect(rejected).toEqual([]);
    expect(lines).toEqual(["status: in-progress", "priority: high"]);
  });

  it("rejects a managed key regardless of the casing it arrived in", () => {
    const { lines, rejected } = propertiesToFrontmatter({ Trashed: "2026-07-28T00:00:00Z" });
    expect(lines).toEqual([]);
    expect(rejected).toEqual(["Trashed"]);
  });

  it("an imported note cannot forge a completion-shaped managed value", () => {
    // The specific scenario the task names: a valid ISO date under a managed
    // key. Value-strictness cannot help here, because the value is valid.
    const { lines } = propertiesToFrontmatter({ trashed: "2026-07-28T00:00:00Z" });
    expect(lines.join("")).not.toContain("trashed");
  });
});
