// Obsidian importer — pure production-port helpers (MYND-53, tasks 6–9).
//
// Only the PURE helpers in `ports.ts` are covered here (no Tauri `invoke`, no
// real fs): media-path candidate resolution, the deliberate-folders union, and
// the TitleRecord→ExistingNote projection that feeds the SYNC-5 identity set.
// The IPC-bound pieces (createImportPorts / runVaultImport) need a Tauri runtime
// and are exercised by manual smoke + the MYND-90 fixture against the real seam.

import { describe, it, expect } from "vitest";
import {
  mediaCandidatePaths,
  mergeDeliberateFolders,
  titleRecordsToExistingNotes,
} from "../../src/notes/import/ports";
import {
  buildExistingIdentitySet,
  noteIdentityKey,
} from "../../src/notes/import/conflict";
import type { TitleRecord } from "../../src/notes/loadNoteBatch";

describe("mediaCandidatePaths", () => {
  it("joins a relative source to the vault root", () => {
    expect(mediaCandidatePaths("/v", new Map(), "images/a.png")).toEqual([
      "/v/images/a.png",
    ]);
  });

  it("adds the basename-index hit after the root-join (Obsidian shortest-path)", () => {
    const idx = new Map([["a.png", "/v/attach/a.png"]]);
    expect(mediaCandidatePaths("/v", idx, "a.png")).toEqual([
      "/v/a.png",
      "/v/attach/a.png",
    ]);
  });

  it("drops an absolute source that escapes the root (TB6 — no out-of-root read)", () => {
    expect(mediaCandidatePaths("/v", new Map(), "/etc/passwd.png")).toEqual([]);
  });

  it("drops a `..`-traversal source that escapes the root", () => {
    expect(mediaCandidatePaths("/v", new Map(), "../../secret.png")).toEqual([]);
  });

  it("still resolves a `..` ref via the within-root basename index", () => {
    const idx = new Map([["x.png", "/v/assets/x.png"]]);
    expect(mediaCandidatePaths("/v", idx, "../assets/x.png")).toEqual([
      "/v/assets/x.png",
    ]);
  });

  it("normalizes backslashes + a leading ./", () => {
    expect(mediaCandidatePaths("/v", new Map(), "./sub\\b.png")).toEqual([
      "/v/sub/b.png",
    ]);
  });

  it("handles a vault root with a trailing slash", () => {
    expect(mediaCandidatePaths("/v/", new Map(), "a.png")).toEqual(["/v/a.png"]);
  });

  it("matches the basename case-insensitively", () => {
    const idx = new Map([["a.png", "/v/attach/A.PNG"]]);
    expect(mediaCandidatePaths("/v", idx, "A.PNG")).toEqual([
      "/v/A.PNG",
      "/v/attach/A.PNG",
    ]);
  });
});

describe("mergeDeliberateFolders", () => {
  it("unions + dedups existing with the importer's set", () => {
    expect([...mergeDeliberateFolders(["A/", "B/"], ["B/", "C/"])].sort()).toEqual([
      "A/",
      "B/",
      "C/",
    ]);
  });

  it("preserves the existing set when nothing is added", () => {
    expect(mergeDeliberateFolders(["A/"], [])).toEqual(["A/"]);
  });

  it("returns the added set when there is no existing", () => {
    expect(mergeDeliberateFolders([], ["X/"])).toEqual(["X/"]);
  });
});

describe("titleRecordsToExistingNotes → identity set", () => {
  const rec = (over: Partial<TitleRecord>): TitleRecord => ({
    noteUuid: "u",
    title: "T",
    folder: null,
    updatedAt: null,
    trashed: null,
    template: false,
    ...over,
  });

  it("projects folder/title/trashed/template and feeds the SYNC-5 identity builder", () => {
    const records: TitleRecord[] = [
      rec({ title: "Alpha", folder: "Work/" }),
      rec({ title: "Beta", trashed: "2026-01-01T00:00:00Z" }), // excluded: trashed
      rec({ title: null }), // excluded: untitled (no matchable identity)
      rec({ title: "Tmpl", template: true }), // excluded: template
    ];
    const set = buildExistingIdentitySet(titleRecordsToExistingNotes(records));
    expect(set.has(noteIdentityKey("Work/", "Alpha"))).toBe(true);
    expect(set.size).toBe(1);
  });
});
