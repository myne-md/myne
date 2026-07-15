// buildInitialDrawingBody / buildDrawingNoteBytes — the pure body-construction
// core of `createDrawing` (drawing-notes SF2, MYND-499). The `createDrawing`
// orchestrator itself calls `note_create` (IPC, integration-tested via E2E); the
// body-builder is pure and round-trips through the dialect surgery.

import { describe, it, expect } from "vitest";
import {
  buildInitialDrawingBody,
  buildDrawingNoteBytes,
} from "../../src/notes/createDrawing";
import { readKindFromFmBody, readTitleFromFmBody } from "../../src/dialect";

const dec = new TextDecoder();

function fmBodyOf(source: string): string {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(source);
  return m ? (m[1] ?? "") : "";
}
function fencedScene(source: string): unknown {
  const m = /```excalidraw\n([\s\S]*?)\n```/.exec(source);
  if (m === null) throw new Error("no excalidraw fence");
  return JSON.parse(m[1] ?? "");
}

describe("buildInitialDrawingBody", () => {
  it("is an ```excalidraw fenced block holding a valid empty Excalidraw scene", () => {
    const body = buildInitialDrawingBody();
    expect(body).toContain("```excalidraw");
    const scene = fencedScene(body) as { type: string; elements: unknown[] };
    expect(scene.type).toBe("excalidraw");
    expect(scene.elements).toEqual([]);
  });
});

describe("buildDrawingNoteBytes", () => {
  it("carries a value-strict kind: drawing marker over the fenced scene", () => {
    const source = dec.decode(buildDrawingNoteBytes());
    expect(readKindFromFmBody(fmBodyOf(source))).toBe("drawing");
    // The scene body survives the frontmatter patch intact.
    const scene = fencedScene(source) as { type: string };
    expect(scene.type).toBe("excalidraw");
  });

  it("writes the title when a name is given, still kind: drawing", () => {
    const source = dec.decode(buildDrawingNoteBytes("My Sketch"));
    expect(readTitleFromFmBody(fmBodyOf(source))).toBe("My Sketch");
    expect(readKindFromFmBody(fmBodyOf(source))).toBe("drawing");
  });

  it("omits the title for an unnamed drawing (empty-title → inline rename)", () => {
    const source = dec.decode(buildDrawingNoteBytes());
    expect(readTitleFromFmBody(fmBodyOf(source))).toBeNull();
    expect(readKindFromFmBody(fmBodyOf(source))).toBe("drawing");
  });

  it("writes the folder field for a foldered create, still kind: drawing", () => {
    const source = dec.decode(buildDrawingNoteBytes("Sketch", "Projects"));
    expect(readKindFromFmBody(fmBodyOf(source))).toBe("drawing");
    // normalizeFolderPath canonicalizes to a trailing-slash path.
    expect(fmBodyOf(source)).toMatch(/^folder:\s*Projects\/\s*$/m);
  });

  it("omits the folder field for a root drawing (omitted / null / empty)", () => {
    for (const f of [undefined, null, ""] as const) {
      expect(fmBodyOf(dec.decode(buildDrawingNoteBytes("X", f)))).not.toMatch(/^folder:/m);
    }
  });
});
