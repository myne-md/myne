// Conflict-copy materialization (MYND-424 task 7 / MYND-427): build a keep-both
// copy carrying `conflict: true` + `conflict_of: <uuid>`, and round-trip the
// read helpers the Conflicts view groups by.

import { describe, it, expect } from "vitest";
import { buildConflictCopyContent, clearConflictMarkers } from "../../src/notes/conflictCopy";
import {
  readConflictFromFmBody,
  readConflictOfFromFmBody,
} from "../../src/dialect";

const UUID = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";

/** Extract the FM body (between the --- fences) from full note content. */
function fmBody(content: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(content);
  return m ? (m[1] ?? "") : "";
}

describe("buildConflictCopyContent", () => {
  it("adds conflict:true + conflict_of on a body with no frontmatter", () => {
    const out = buildConflictCopyContent("# Remote edit\n", UUID);
    const body = fmBody(out);
    expect(readConflictFromFmBody(body)).toBe(true);
    expect(readConflictOfFromFmBody(body)).toBe(UUID);
    expect(out).toContain("# Remote edit");
  });

  it("composes onto an existing frontmatter without clobbering", () => {
    const remote = `---\ntitle: Notes\nfolder: Projects/\n---\n\nbody\n`;
    const out = buildConflictCopyContent(remote, UUID);
    const body = fmBody(out);
    expect(readConflictFromFmBody(body)).toBe(true);
    expect(readConflictOfFromFmBody(body)).toBe(UUID);
    expect(out).toContain("title: Notes");
    expect(out).toContain("folder: Projects/");
  });
});

describe("read helpers — value-strict", () => {
  it("conflict: is value-strict (only canonical true)", () => {
    expect(readConflictFromFmBody("conflict: true\n")).toBe(true);
    expect(readConflictFromFmBody("conflict: 1\n")).toBe(false);
    expect(readConflictFromFmBody('conflict: "true"\n')).toBe(false);
    expect(readConflictFromFmBody("title: x\n")).toBe(false);
  });

  it("conflict_of returns the uuid or null", () => {
    expect(readConflictOfFromFmBody(`conflict_of: ${UUID}\n`)).toBe(UUID);
    expect(readConflictOfFromFmBody("title: x\n")).toBeNull();
  });
});

describe("clearConflictMarkers", () => {
  it("removes both markers (keep-both-as-separate)", () => {
    const c = buildConflictCopyContent("body\n", UUID);
    const cleared = clearConflictMarkers(c);
    const body = fmBody(cleared);
    expect(readConflictFromFmBody(body)).toBe(false);
    expect(readConflictOfFromFmBody(body)).toBeNull();
  });
});
