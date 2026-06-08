// Catalog resolution routing (MYND-164, task 1).
//
// `parseAttachmentTarget` is the SYNC-6 tokenizer that routes a wikilink embed
// target to the attachments catalog (vs the note index). `resolveCatalog` maps a
// parsed id to a loading / resolved / deleted outcome the renderer dispatches on.

import { describe, expect, it } from "vitest";
import {
  ATT_SCHEME,
  isAttachmentId,
  parseAttachmentTarget,
} from "../../src/notes/attachmentRef";
import {
  type CatalogRow,
  resolveCatalog,
} from "../../src/editor/attachments/catalog";

const ID = "a".repeat(64);

describe("parseAttachmentTarget routing", () => {
  it("routes a valid att:<id> target to the id", () => {
    expect(parseAttachmentTarget(`${ATT_SCHEME}${ID}`)).toBe(ID);
  });

  it("rejects a non-att target (ordinary note wikilink)", () => {
    expect(parseAttachmentTarget("Some Note")).toBeNull();
    expect(parseAttachmentTarget("folder/Note")).toBeNull();
  });

  it("rejects a malformed att: target (broken reference, not an embed)", () => {
    expect(parseAttachmentTarget("att:short")).toBeNull();
    expect(parseAttachmentTarget("att:" + "A".repeat(64))).toBeNull(); // uppercase
    expect(parseAttachmentTarget("att:" + "g".repeat(64))).toBeNull(); // non-hex
    expect(parseAttachmentTarget("att:")).toBeNull();
  });

  it("isAttachmentId agrees on the canonical 64-lowercase-hex shape", () => {
    expect(isAttachmentId(ID)).toBe(true);
    expect(isAttachmentId(ID.toUpperCase())).toBe(false);
    expect(isAttachmentId("a".repeat(63))).toBe(false);
  });
});

describe("resolveCatalog outcomes", () => {
  const row: CatalogRow = { id: ID, contentType: "image/png", filename: "p.png", size: 1 };

  it("loading while the catalog is null", () => {
    expect(resolveCatalog(null, ID)).toEqual({ kind: "loading" });
  });

  it("resolved when the id is present", () => {
    const map = new Map([[ID, row]]);
    expect(resolveCatalog(map, ID)).toEqual({ kind: "resolved", row });
  });

  it("deleted when the loaded catalog lacks the id", () => {
    expect(resolveCatalog(new Map(), ID)).toEqual({ kind: "deleted" });
  });
});
