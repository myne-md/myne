// Vault-export modal logic (MYND-211 tasks 3+4) — the pure module the
// modal renders from: phase state machine (setup → running → summary,
// cancel paths, error → setup with message), destination composition,
// scope handling, summary/exclusion formatting, and the closed-enum →
// copy mapping table. No Tauri, no DOM.

import { describe, expect, it } from "vitest";
import {
  canStart,
  collectFolderOptions,
  composeDestination,
  composedDestination,
  defaultExportTreeName,
  formatExclusionsLine,
  formatRunningCounts,
  formatSummaryCounts,
  initialVaultExportState,
  progressFraction,
  scopeArg,
  vaultExportReducer,
  type VaultExportModalState,
} from "../../src/components/export/vaultExportFlow";
import { vaultExportErrorMessage } from "../../src/lib/vault-export-errors";
import type {
  VaultExportError,
  VaultExportSummary,
} from "../../src/types/vault-export-error";

const SUMMARY: VaultExportSummary = {
  notes: 128,
  attachments: 14,
  folders: 9,
  excluded_trashed: 3,
  excluded_snapshots: 7,
};

function setupWithDir(dir = "/Users/u/Documents") {
  const s = vaultExportReducer(initialVaultExportState("Myne export T"), {
    type: "pick-dir",
    dir,
  });
  if (s.phase !== "setup") throw new Error("expected setup");
  return s;
}

/** The component computes the destination once (`composedDestination`)
 *  and carries it in the start event — mirrored here. */
function startEvent(state: ReturnType<typeof setupWithDir>) {
  return {
    type: "start",
    destination: composedDestination(state) ?? "/unpicked",
  } as const;
}

function runningState(): VaultExportModalState {
  const setup = setupWithDir();
  return vaultExportReducer(setup, startEvent(setup));
}

describe("destination composition", () => {
  it("default tree name mirrors the backup naming rule (product + local datestamp, never the vault label)", () => {
    const name = defaultExportTreeName(new Date(2026, 5, 11, 9, 5));
    expect(name).toBe("Myne export 2026-06-11 0905");
  });

  it("composes <picked>/<tree name> with the picked path's own separator", () => {
    expect(composeDestination("/Users/u/Documents", "Myne export T")).toBe(
      "/Users/u/Documents/Myne export T",
    );
    expect(composeDestination("/Users/u/Documents/", "T")).toBe(
      "/Users/u/Documents/T",
    );
    expect(composeDestination("C:\\Users\\u", "T")).toBe("C:\\Users\\u\\T");
    expect(composeDestination("/", "T")).toBe("/T");
  });

  it("composedDestination is null until a parent dir is picked", () => {
    expect(composedDestination(initialVaultExportState("T"))).toBeNull();
    expect(composedDestination(setupWithDir("/d"))).toBe("/d/Myne export T");
  });
});

describe("phase state machine", () => {
  it("starts in setup: no destination, whole-vault scope, no error", () => {
    const s = initialVaultExportState("T");
    expect(s).toEqual({
      phase: "setup",
      pickedDir: null,
      treeName: "T",
      scope: { kind: "whole" },
      error: null,
    });
    expect(canStart(s)).toBe(false);
  });

  it("setup → running on start carries the composed destination", () => {
    const s = runningState();
    expect(s.phase).toBe("running");
    if (s.phase !== "running") return;
    expect(s.destination).toBe("/Users/u/Documents/Myne export T");
    expect(s.progress).toBeNull();
    expect(s.cancelling).toBe(false);
  });

  it("start is inert without a destination, or with a folder scope that names no folder", () => {
    const noDir = initialVaultExportState("T");
    expect(
      vaultExportReducer(noDir, { type: "start", destination: "/d/T" }),
    ).toBe(noDir);

    const folderUnpicked = vaultExportReducer(setupWithDir(), {
      type: "scope-folder",
    });
    expect(canStart(folderUnpicked)).toBe(false);
    expect(
      vaultExportReducer(folderUnpicked, { type: "start", destination: "/d/T" }),
    ).toBe(folderUnpicked);

    const folderPicked = vaultExportReducer(folderUnpicked, {
      type: "scope-folder-path",
      folder: "Projects/",
    });
    expect(canStart(folderPicked)).toBe(true);
    if (folderPicked.phase === "setup") {
      expect(scopeArg(folderPicked.scope)).toBe("Projects/");
    }
  });

  it("scope-whole resets the engine scope arg to null", () => {
    const s = vaultExportReducer(
      vaultExportReducer(setupWithDir(), {
        type: "scope-folder-path",
        folder: "Projects/",
      }),
      { type: "scope-whole" },
    );
    if (s.phase !== "setup") throw new Error("expected setup");
    expect(scopeArg(s.scope)).toBeNull();
  });

  it("running → summary on success", () => {
    const s = vaultExportReducer(runningState(), {
      type: "succeeded",
      summary: SUMMARY,
    });
    expect(s).toEqual({
      phase: "summary",
      destination: "/Users/u/Documents/Myne export T",
      summary: SUMMARY,
    });
  });

  it("progress updates only the running phase; late events after settlement are inert", () => {
    const running = vaultExportReducer(runningState(), {
      type: "progress",
      progress: { done: 42, total: 128, phase: "notes" },
    });
    if (running.phase !== "running") throw new Error("expected running");
    expect(running.progress).toEqual({ done: 42, total: 128, phase: "notes" });

    const summary = vaultExportReducer(running, {
      type: "succeeded",
      summary: SUMMARY,
    });
    const late = vaultExportReducer(summary, {
      type: "progress",
      progress: { done: 99, total: 128, phase: "notes" },
    });
    expect(late).toBe(summary);
  });

  it("cancel path: cancel-requested flags, Cancelled settles back to setup QUIETLY (destination + scope preserved, no error)", () => {
    const cancelling = vaultExportReducer(runningState(), {
      type: "cancel-requested",
    });
    if (cancelling.phase !== "running") throw new Error("expected running");
    expect(cancelling.cancelling).toBe(true);

    const back = vaultExportReducer(cancelling, {
      type: "failed",
      error: { kind: "Cancelled" },
    });
    expect(back).toEqual({
      phase: "setup",
      pickedDir: "/Users/u/Documents",
      treeName: "Myne export T",
      scope: { kind: "whole" },
      error: null,
    });
  });

  it("failure path: error → setup with the mapped message, settings preserved", () => {
    const s = vaultExportReducer(runningState(), {
      type: "failed",
      error: { kind: "DestinationAlreadyExists" },
    });
    if (s.phase !== "setup") throw new Error("expected setup");
    expect(s.pickedDir).toBe("/Users/u/Documents");
    expect(s.error).toBe(
      vaultExportErrorMessage({ kind: "DestinationAlreadyExists" }),
    );
  });

  it("null out-of-contract rejection → setup with the generic fallback line, never a throw", () => {
    // A null/undefined IPC rejection reaches the reducer via the modal's
    // `raw as VaultExportError` cast — member access must not throw
    // (never-throws contract; the same guard as note-export-errors.ts).
    const s = vaultExportReducer(runningState(), {
      type: "failed",
      error: null as unknown as VaultExportError,
    });
    if (s.phase !== "setup") throw new Error("expected setup");
    expect(s.error).toBe("Export failed unexpectedly. Try again.");
  });

  it("picking a new destination clears the previous error line", () => {
    const failed = vaultExportReducer(runningState(), {
      type: "failed",
      error: { kind: "DestinationNotAllowed" },
    });
    const repicked = vaultExportReducer(failed, {
      type: "pick-dir",
      dir: "/elsewhere",
    });
    if (repicked.phase !== "setup") throw new Error("expected setup");
    expect(repicked.error).toBeNull();
    expect(repicked.pickedDir).toBe("/elsewhere");
  });

  it("setup-only events are inert outside setup; running-only events are inert in setup", () => {
    const running = runningState();
    expect(vaultExportReducer(running, { type: "pick-dir", dir: "/x" })).toBe(
      running,
    );
    expect(vaultExportReducer(running, { type: "scope-whole" })).toBe(running);

    const setup = setupWithDir();
    expect(vaultExportReducer(setup, { type: "cancel-requested" })).toBe(setup);
    expect(
      vaultExportReducer(setup, { type: "succeeded", summary: SUMMARY }),
    ).toBe(setup);
    expect(
      vaultExportReducer(setup, {
        type: "failed",
        error: { kind: "JoinFailure" },
      }),
    ).toBe(setup);
  });

  it("reset returns a fresh setup state with the new tree name", () => {
    const summary = vaultExportReducer(runningState(), {
      type: "succeeded",
      summary: SUMMARY,
    });
    expect(vaultExportReducer(summary, { type: "reset", treeName: "T2" })).toEqual(
      initialVaultExportState("T2"),
    );
  });
});

describe("formatting", () => {
  it("running counts: Preparing… before the first event, then `done / total phase`", () => {
    expect(formatRunningCounts(null)).toBe("Preparing…");
    expect(formatRunningCounts({ done: 0, total: 0, phase: "notes" })).toBe(
      "Preparing…",
    );
    expect(formatRunningCounts({ done: 42, total: 128, phase: "notes" })).toBe(
      "42 / 128 notes",
    );
    expect(
      formatRunningCounts({ done: 3, total: 14, phase: "attachments" }),
    ).toBe("3 / 14 attachments");
  });

  it("progress fraction clamps to 0..1", () => {
    expect(progressFraction(null)).toBe(0);
    expect(progressFraction({ done: 0, total: 0, phase: "notes" })).toBe(0);
    expect(progressFraction({ done: 64, total: 128, phase: "notes" })).toBe(0.5);
    expect(progressFraction({ done: 200, total: 128, phase: "notes" })).toBe(1);
  });

  it("summary counts line pluralizes per unit", () => {
    expect(formatSummaryCounts(SUMMARY)).toBe(
      "128 notes · 14 attachments · 9 folders",
    );
    expect(
      formatSummaryCounts({ ...SUMMARY, notes: 1, attachments: 0, folders: 1 }),
    ).toBe("1 note · 0 attachments · 1 folder");
  });

  it("exclusions line: full matrix — each clause appears only when its count is non-zero", () => {
    // both excluded → combined line
    expect(formatExclusionsLine(SUMMARY)).toBe(
      "3 trashed notes and version history not included.",
    );
    expect(
      formatExclusionsLine({ ...SUMMARY, excluded_trashed: 1 }),
    ).toBe("1 trashed note and version history not included.");
    // trashed only → NO "version history" clause (zero snapshots existed —
    // the line must not over-claim)
    expect(
      formatExclusionsLine({ ...SUMMARY, excluded_snapshots: 0 }),
    ).toBe("3 trashed notes not included.");
    expect(
      formatExclusionsLine({
        ...SUMMARY,
        excluded_trashed: 1,
        excluded_snapshots: 0,
      }),
    ).toBe("1 trashed note not included.");
    // snapshots only → version-history line
    expect(
      formatExclusionsLine({ ...SUMMARY, excluded_trashed: 0 }),
    ).toBe("Version history not included.");
    // nothing excluded → line disappears
    expect(
      formatExclusionsLine({
        ...SUMMARY,
        excluded_trashed: 0,
        excluded_snapshots: 0,
      }),
    ).toBeNull();
  });
});

describe("scope folder options", () => {
  it("derives canonical trailing-slash paths (ancestors included) from live records only", () => {
    const options = collectFolderOptions([
      { noteUuid: "1", folder: "Projects/Myne/", trashed: null },
      { noteUuid: "2", folder: "Daily/", trashed: null },
      { noteUuid: "3", folder: null, trashed: null },
      { noteUuid: "4", folder: "Gone/", trashed: "2026-06-11T00:00:00Z" },
    ]);
    expect(options).toEqual(["Daily/", "Projects/", "Projects/Myne/"]);
  });

  it("returns an empty list for a folderless vault", () => {
    expect(
      collectFolderOptions([{ noteUuid: "1", folder: null, trashed: null }]),
    ).toEqual([]);
  });
});

describe("closed-enum error copy map", () => {
  it("covers every VaultExportError variant with non-empty copy; destination variants are pairwise distinct", () => {
    const variants: VaultExportError[] = [
      { kind: "VaultNotUnlocked" },
      { kind: "AuthOperationInProgress" },
      { kind: "VaultNotFound" },
      { kind: "InvalidDestination" },
      { kind: "DestinationNotAllowed" },
      { kind: "DestinationAlreadyExists" },
      { kind: "CannotDecrypt" },
      { kind: "InvalidPlaintextEncoding" },
      { kind: "InvalidVaultMeta" },
      { kind: "AttachmentMissing" },
      { kind: "AttachmentCorrupt" },
      { kind: "Cancelled" },
      { kind: "Io", detail: { io_error_kind: "NoSpace" } },
      { kind: "Io", detail: { io_error_kind: "PermissionDenied" } },
      { kind: "Io", detail: { io_error_kind: "NotFound" } },
      { kind: "Io", detail: { io_error_kind: "Other" } },
      { kind: "JoinFailure" },
    ];
    for (const v of variants) {
      expect(vaultExportErrorMessage(v).length).toBeGreaterThan(0);
    }
    // The three destination rejections answer different user questions
    // ("unusable", "inside Myne's storage", "already taken") — pin them
    // pairwise distinct so a copy collapse fails loudly.
    const destinationCopy = [
      vaultExportErrorMessage({ kind: "InvalidDestination" }),
      vaultExportErrorMessage({ kind: "DestinationNotAllowed" }),
      vaultExportErrorMessage({ kind: "DestinationAlreadyExists" }),
    ];
    expect(new Set(destinationCopy).size).toBe(3);
  });
});
