// SYNC-8 att-ref superset generation (drawing-notes SF3, MYND-500). The GC-safety
// mechanism: the block written here is exactly what the fail-closed ref_scan
// counts, so a live drawing's images are never cryptographically erased.
import { describe, it, expect } from "vitest";
import { buildAttRefBlock, upsertAttRefs } from "../../src/drawing/attRefs";
import { buildDrawingNoteBytes } from "../../src/notes/createDrawing";

const dec = new TextDecoder();
const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);

describe("buildAttRefBlock", () => {
  it("emits canonical ![[att:<id>]] lines, sorted + de-duplicated", () => {
    expect(buildAttRefBlock([ID_B, ID_A, ID_A])).toBe(
      `![[att:${ID_A}]]\n![[att:${ID_B}]]`,
    );
  });
  it("is empty for no attachments", () => {
    expect(buildAttRefBlock([])).toBe("");
  });
});

describe("upsertAttRefs", () => {
  const base = dec.decode(buildDrawingNoteBytes("Sketch"));

  it("appends the ref block after the fence, preserving frontmatter + scene", () => {
    const out = upsertAttRefs(base, [ID_A]);
    expect(out).toContain("kind: drawing");
    expect(out).toContain("```excalidraw");
    expect(out).toContain(`![[att:${ID_A}]]`);
    // The GC scanner (canonical form-C) would now count ID_A as referenced.
    expect(/!\[\[att:[0-9a-f]{64}\]\]/.test(out)).toBe(true);
  });

  it("replaces the prior block with the current superset (stale ref dropped)", () => {
    const withA = upsertAttRefs(base, [ID_A]);
    const withB = upsertAttRefs(withA, [ID_B]);
    expect(withB).toContain(`![[att:${ID_B}]]`);
    expect(withB).not.toContain(`![[att:${ID_A}]]`);
  });

  it("clears the block when the scene references no attachments", () => {
    const withA = upsertAttRefs(base, [ID_A]);
    const cleared = upsertAttRefs(withA, []);
    expect(cleared).not.toContain("![[att:");
    expect(cleared).toContain("```excalidraw");
  });

  it("is idempotent for the same set", () => {
    const once = upsertAttRefs(base, [ID_A, ID_B]);
    expect(upsertAttRefs(once, [ID_A, ID_B])).toBe(once);
  });

  it("is a no-op on a body with no excalidraw fence", () => {
    const plain = "---\ntitle: Note\n---\n\nbody\n";
    expect(upsertAttRefs(plain, [ID_A])).toBe(plain);
  });
});
