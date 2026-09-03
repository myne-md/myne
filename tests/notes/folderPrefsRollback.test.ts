// Every optimistic folder-prefs write reverts when the disk write fails (#259).
//
// `useFolderManagement` shows a folder change as applied before it is
// persisted, which is right — the alternative is a sidebar that lags a disk
// write. What is not right is a `.catch(() => {})` on the persist: the UI then
// shows the change for the rest of the session while `vault.prefs` still holds
// the old value, and the next unlock resolves the disagreement in disk's
// favour. For `archived_folders` that meant renaming a folder with an archived
// subtree appeared to work and silently UN-ARCHIVED the whole subtree later;
// one sibling call site (`performFolderArchive`) had the revert and the other
// four did not.
//
// This is asserted over the source because the hook needs a full sidebar
// context to render and the property is syntactic: a persist whose catch does
// nothing is the defect, wherever it appears. Anything genuinely fire-and-forget
// belongs on the exempt list below with its reason.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = "src/notes/components/useFolderManagement.ts";

/**
 * The orchestrator behind the hook, added to the scan because the class moved
 * there and the guard stayed here.
 *
 * `renameFolder` awaits `mutateDeliberateFolders` PAST its transactional batch, so
 * it can fail with the rename already on disk, and myne-md/myne#520's review put
 * the handling for that in `folderActions.ts` as a `try`/`catch`. This file read
 * one source and one literal shape (`.catch(() => {})`), so a swallow in its own
 * class landed in a file it does not open. Widened rather than exempted: a guard
 * whose scope stops where the code went is a guard that reports ok about nothing.
 */
const ORCHESTRATOR = "src/notes/folderActions.ts";

/**
 * Persist calls that legitimately swallow their failure. Each one must say why
 * — an entry here is a claim that losing this write costs the user nothing.
 */
const EXEMPT: readonly { call: string; why: string }[] = [
  {
    call: "ctx.createAndStartRename",
    why: "not a prefs write — it creates a note and focuses its row; a failure leaves no stale UI claim",
  },
  {
    call: "ctx.createDrawingAndStartRename",
    why: "same as createAndStartRename",
  },
  {
    call: "performFolderDelete",
    why: "not a prefs write — the delete reports its own failure through the notes layer",
  },
];

describe("folder prefs writes", () => {
  it("never swallow a persist failure without reverting the optimistic state", () => {
    const src = readFileSync(SOURCE, "utf8");
    const offenders: string[] = [];

    src.split("\n").forEach((line, i) => {
      // An empty catch on a `void`-ed promise: the shape that hides a failed
      // write behind a UI that already moved on.
      if (!/\.catch\(\(\)\s*=>\s*\{\}\)/.test(line)) return;
      if (EXEMPT.some((e) => line.includes(e.call))) return;
      offenders.push(`${SOURCE}:${i + 1} ${line.trim()}`);
    });

    expect(
      offenders,
      "an optimistic prefs write must restore the previous state in its catch, " +
        "or be recorded in EXEMPT with the reason losing it is harmless",
    ).toEqual([]);
  });

  it("each archived_folders write captures the previous value first", () => {
    // The revert needs something to revert TO. A `mutateArchivedFolders(...)` whose
    // catch does not restore a captured value is the same bug wearing a catch.
    const src = readFileSync(SOURCE, "utf8");
    const persists = [...src.matchAll(/void mutateArchivedFolders\((?:[^()]|\([^()]*\))*\)\.catch\(\(\) => \{([^}]*)\}\)/g)];
    expect(
      persists.length,
      "the archived-folder persist sites must still be recognisable here",
    ).toBeGreaterThanOrEqual(4);
    for (const [, body] of persists) {
      expect(
        body.includes("setArchivedFoldersState("),
        "every archived_folders persist must revert its optimistic state on failure",
      ).toBe(true);
    }
  });
});

describe("the orchestrator's post-commit prefs write", () => {
  it("does not swallow the failure, it reports it", () => {
    // `renameFolder` cannot throw here (the rename is already on disk and the
    // caller still owes the decoration and archived-folder re-rooting), so the
    // only two honest shapes are "retry" and "report". A bare `catch {}` with
    // neither is the defect this file exists for, one file over from where it
    // used to look.
    const src = readFileSync(ORCHESTRATOR, "utf8");
    // myne#613: the write states the mutation the planner computed rather than
    // handing over a whole set for the backend to diff.
    const block = /await mutateDeliberateFolders\(plan\.deliberateMutation\);/g;
    const writes = [...src.matchAll(block)];
    expect(
      writes.length,
      "the post-commit deliberate write must still be recognisable here",
    ).toBeGreaterThanOrEqual(2); // the attempt and its one retry
    expect(
      src.includes("deliberateWriteFailed = true;"),
      "the failure must reach the caller as a value rather than being swallowed",
    ).toBe(true);
  });

  it("keeps the field on the result type, so a caller cannot miss it", () => {
    const src = readFileSync(ORCHESTRATOR, "utf8");
    expect(src).toContain("deliberateWriteFailed?: boolean;");
  });
});
