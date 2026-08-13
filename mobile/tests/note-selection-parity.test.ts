// Mobile's note-selection predicates are the SHARED ones (#46 / #260).
//
// They used to be re-implemented here and as `useMemo`s in `EditorFlow`, and
// the two clients' answers to "is this note in the working set" drifted
// independently. `98acbcc9` added the tombstone filter to desktop's Trash list;
// mobile's never got it, so "Delete permanently" was a visible no-op (the
// tombstone it writes left the row rendered) and "Discard" never cleared a
// conflict (same shape, in the Conflicts sheet).
//
// These assert the axes mobile was missing, through the module mobile imports.

import { describe, expect, it } from "vitest";
import {
  isArchivedNote,
  isListedTemplate,
  isLiveNote,
  isResolverCandidate,
  isTrashedNote,
} from "../src/lib/note-organize";

const T = "2026-08-03T10:00:00Z";

describe("mobile note selection", () => {
  it("keeps a tombstone out of the Trash list", () => {
    // The defect: "Delete permanently" writes `deleted:` and leaves `trashed:`,
    // so a list filtering on `trashed != null` alone re-renders the row.
    expect(isTrashedNote({ trashed: T, deleted: null })).toBe(true);
    expect(isTrashedNote({ trashed: T, deleted: T })).toBe(false);
  });

  it("keeps a tombstone out of the Archive list", () => {
    expect(isArchivedNote({ archived: T, trashed: null, deleted: null })).toBe(true);
    expect(isArchivedNote({ archived: T, deleted: T })).toBe(false);
  });

  it("keeps a tombstoned template out of the Templates sheet", () => {
    expect(isListedTemplate({ template: true })).toBe(true);
    expect(isListedTemplate({ template: true, deleted: T })).toBe(false);
    expect(isListedTemplate({ template: true, trashed: T })).toBe(false);
  });

  it("still separates the working set from the resolver set", () => {
    // The one axis that must NOT be collapsed: an archived note is out of the
    // list but remains a valid wikilink target.
    expect(isLiveNote({ archived: T })).toBe(false);
    expect(isResolverCandidate({ archived: T })).toBe(true);
  });
});

// #45: deleting one vault must not hide the others.
//
// The stage machine mapped all three `*.delete-vault-success` actions straight
// to `welcome`, so a user with three vaults who deleted one landed on the
// first-run screen with the other two invisible — they were still on disk, and
// the only way back was to force-quit the app. Desktop replaced the same three
// arms with a reprobe (`03170d21`); this client kept them for seven months.
//
// The actions are gone entirely rather than re-pointed: routing after a delete
// is a question about REMAINING vault count, which only the boot probe can
// answer, and an action that encodes an answer is an answer that can go stale.
describe("post-delete routing (#45)", () => {
  it("has no hardcoded delete → welcome transition left", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/lib/stage.ts", "utf8"),
    );
    expect(
      /case "(?:editor|unlock|recover)\.delete-vault-success"/.test(src),
      "a delete must reprobe, not transition to a hardcoded stage",
    ).toBe(false);
    expect(src).not.toContain('.delete-vault-success": "welcome"');
  });

  it("routes both delete surfaces through the shell's reprobe", async () => {
    const shell = await import("node:fs").then((fs) =>
      fs.readFileSync("src/app/AppShell.tsx", "utf8"),
    );
    // The unlock surface passes it directly; the editor surface wraps it to
    // revert the custom palette first (the one exit that does not lock).
    expect(shell).toContain("onDeleteVaultSuccess={reprobe}");
    expect(shell).toContain("reprobe(); // #45");
  });
});
