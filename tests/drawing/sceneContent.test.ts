// Scene ⇄ note-body transforms (drawing-notes SF2, MYND-499). Pure; the load-
// bearing data path for canvas load + autosave — must preserve frontmatter and
// the trailing SF3 att-ref block byte-for-byte.
import { describe, it, expect } from "vitest";
import { extractSceneJson, writeSceneJson } from "../../src/drawing/sceneContent";
import { buildDrawingNoteBytes } from "../../src/notes/createDrawing";

const dec = new TextDecoder();

describe("extractSceneJson", () => {
  it("pulls the scene JSON out of a freshly-built drawing body", () => {
    const content = dec.decode(buildDrawingNoteBytes("Sketch"));
    const scene = extractSceneJson(content);
    expect(scene).not.toBeNull();
    expect((JSON.parse(scene as string) as { type: string }).type).toBe("excalidraw");
  });
  it("returns null when there is no excalidraw fence", () => {
    expect(extractSceneJson("---\ntitle: Note\n---\n\nplain body\n")).toBeNull();
  });
});

describe("writeSceneJson", () => {
  it("replaces the scene, preserving frontmatter byte-for-byte", () => {
    const content = dec.decode(buildDrawingNoteBytes("Sketch"));
    const next = writeSceneJson(content, '{"type":"excalidraw","elements":[1]}');
    expect(next).toContain("kind: drawing");
    expect(next).toContain("title: Sketch");
    expect(extractSceneJson(next)).toBe('{"type":"excalidraw","elements":[1]}');
  });
  it("preserves a trailing att-ref block (SF3) after the fence", () => {
    const content =
      "---\nkind: drawing\n---\n\n```excalidraw\n{\"old\":1}\n```\n![[att:abc]]\n";
    const next = writeSceneJson(content, '{"new":2}');
    expect(next).toContain("![[att:abc]]");
    expect(extractSceneJson(next)).toBe('{"new":2}');
  });
  it("round-trips extract→write→extract", () => {
    const content = dec.decode(buildDrawingNoteBytes());
    const scene = extractSceneJson(content) as string;
    expect(extractSceneJson(writeSceneJson(content, scene))).toBe(scene);
  });
  it("does not misinterpret $ sequences in the scene JSON", () => {
    const content = dec.decode(buildDrawingNoteBytes());
    const tricky = '{"text":"$1 $& $`"}';
    expect(extractSceneJson(writeSceneJson(content, tricky))).toBe(tricky);
  });
});
