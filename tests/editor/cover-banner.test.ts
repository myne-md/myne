// The note cover banner's three render states (myne-md/myne#410).
//
// The state resolution is the behaviour worth pinning, and each of the three
// outcomes fails differently if it collapses into another one:
//
//   loading -> none   the body text sits high and jumps down when the image
//                     lands, on every note open
//   deleted -> loading  an empty band sits above a note forever, for an image
//                     that no longer exists
//   deleted -> image  a broken-image bar across the top of the note, which is
//                     the tombstone the design explicitly refused
//
// `deleted` and `none` are the one pair that is SUPPOSED to collapse, and the
// test says so out loud so a future reader does not "fix" it.

import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { coverBannerState } from "../../src/editor/decorations/cover-banner";
import type { CatalogRow } from "../../src/editor/attachments/catalog";

const ID = "a".repeat(64);
const OTHER_ID = "b".repeat(64);

function row(id: string): CatalogRow {
  return {
    id,
    filename: "photo.png",
    contentType: "image/png",
    size: 1024,
  } as CatalogRow;
}

function doc(...lines: readonly string[]): Text {
  return Text.of(lines);
}

const WITH_COVER = doc(
  "---",
  "title: Roadmap",
  `cover: "![[att:${ID}|photo.png]]"`,
  "---",
  "",
  "body",
);

describe("coverBannerState", () => {
  it("is loading while the catalog has not resolved", () => {
    expect(coverBannerState(WITH_COVER, null)).toEqual({ kind: "loading" });
  });

  it("is an image once the catalog carries the id", () => {
    const catalog = new Map([[ID, row(ID)]]);
    expect(coverBannerState(WITH_COVER, catalog)).toEqual({
      kind: "image",
      id: ID,
      filename: "photo.png",
    });
  });

  it("is none when the catalog has loaded and the id is absent", () => {
    // A deleted attachment collapses into `none` ON PURPOSE: the note renders
    // exactly like a note that never had a cover. No tombstone, no empty band.
    // This is the deliberate divergence from a form-C embed in the body, which
    // DOES draw a tombstone.
    const catalog = new Map([[OTHER_ID, row(OTHER_ID)]]);
    expect(coverBannerState(WITH_COVER, catalog)).toEqual({ kind: "none" });
  });

  it("distinguishes a not-yet-loaded catalog from a loaded empty one", () => {
    // The pair that carries the whole feature: same document, same absence of
    // the id, two different answers.
    expect(coverBannerState(WITH_COVER, null)).toEqual({ kind: "loading" });
    expect(coverBannerState(WITH_COVER, new Map())).toEqual({ kind: "none" });
  });

  it("is none for a note with no frontmatter at all", () => {
    expect(coverBannerState(doc("# Just a body", "", "text"), new Map())).toEqual({
      kind: "none",
    });
  });

  it("is none for a note whose frontmatter carries no cover", () => {
    const d = doc("---", "title: Roadmap", "---", "", "body");
    expect(coverBannerState(d, new Map([[ID, row(ID)]]))).toEqual({ kind: "none" });
  });

  it("is none for an invalid cover value, even when the catalog could resolve it", () => {
    // The §3.6.1 grammar decides, not a second lenient check here. A hand-written
    // `cover: <bare id>` is not a cover, so the banner must not draw one, and the
    // line stays visible as an ordinary property row instead.
    const d = doc("---", `cover: ${ID}`, "---", "", "body");
    expect(coverBannerState(d, new Map([[ID, row(ID)]]))).toEqual({ kind: "none" });
  });

  it("is none for a cover value carrying two embeds", () => {
    // Regression guard for the greedy-alias defect: this matched as one embed
    // for the FIRST id, so the banner silently picked a winner the user never
    // chose.
    const d = doc(
      "---",
      `cover: "![[att:${ID}|a.png]] ![[att:${OTHER_ID}|b.png]]"`,
      "---",
      "",
      "body",
    );
    expect(coverBannerState(d, new Map([[ID, row(ID)]]))).toEqual({ kind: "none" });
  });

  it("reads a cover carrying a trailing YAML comment", () => {
    const d = doc(
      "---",
      `cover: "![[att:${ID}|photo.png]]" # chosen 2026-08`,
      "---",
      "",
      "body",
    );
    expect(coverBannerState(d, new Map([[ID, row(ID)]]))).toEqual({
      kind: "image",
      id: ID,
      filename: "photo.png",
    });
  });
});
