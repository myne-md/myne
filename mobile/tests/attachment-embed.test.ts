import { describe, it, expect } from "vitest";
import { emitAttachmentEmbed, parseAttachmentTarget, isAttachmentId, extractAttachmentIds } from "../src/lib/attachmentRef";
import { parseBlocks } from "../src/lib/markdown";

const ID = "a".repeat(64);
const ID2 = "b".repeat(64);

describe("attachmentRef", () => {
  it("emits canonical form-C with the filename alias", () => {
    expect(emitAttachmentEmbed(ID, "cat.png")).toBe(`![[att:${ID}|cat.png]]`);
  });

  it("parses a valid att: target, rejects note links + bad ids", () => {
    expect(parseAttachmentTarget(`att:${ID}`)).toBe(ID);
    expect(parseAttachmentTarget("att:not-hex")).toBeNull();
    expect(parseAttachmentTarget("Some Note")).toBeNull();
  });

  it("validates ids (64 lowercase hex)", () => {
    expect(isAttachmentId(ID)).toBe(true);
    expect(isAttachmentId("A".repeat(64))).toBe(false); // uppercase
    expect(isAttachmentId("a".repeat(63))).toBe(false);
  });

  it("extracts embedded ids deduped in first-seen order", () => {
    const body = `intro ![[att:${ID}|a.png]] mid ![[att:${ID2}|b.pdf]] again ![[att:${ID}|a.png]]`;
    expect(extractAttachmentIds(body)).toEqual([ID, ID2]);
  });
});

describe("markdown attachment token", () => {
  it("parses ![[att:id|name]] as an attachment inline (not text + wikilink)", () => {
    const blocks = parseBlocks(`![[att:${ID}|cat.png]]`);
    const para = blocks.find((b) => b.kind === "paragraph");
    expect(para?.kind).toBe("paragraph");
    const inline = para && para.kind === "paragraph" ? para.content : [];
    expect(inline).toEqual([{ kind: "attachment", id: ID, label: "cat.png" }]);
  });

  it("leaves an ordinary [[wikilink]] as a wikilink", () => {
    const blocks = parseBlocks(`see [[Other Note]]`);
    const para = blocks.find((b) => b.kind === "paragraph");
    const inline = para && para.kind === "paragraph" ? para.content : [];
    expect(inline.some((t) => t.kind === "wikilink" && t.target === "Other Note")).toBe(true);
  });
});
