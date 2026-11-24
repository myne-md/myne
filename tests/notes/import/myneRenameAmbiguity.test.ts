// The one place the Myne-vault import can silently mis-link a note.
//
// A rename is applied by FOLDED LINK TARGET with no folder filter, while the
// collision that triggers it is decided per `(folder, title)`. Those coincide
// only while a folded title belongs to one source note. When two notes share
// it, renaming on behalf of one retargets the links that meant the other, and
// the link then resolves to a different note than the one it was written
// against. That is the mis-link the rename rule exists to prevent, inverted,
// and nothing reported it: `linksRetargeted` simply counted a rewrite.
//
// These drive the extracted decision directly, because in `plan()` it sits
// behind a live source vault, an IPC seam and an Argon2id.

import { describe, expect, it } from "vitest";
import { decideRenames } from "../../../src/notes/import/sources/myne";
import { noteIdentityKey } from "../../../src/notes/import/conflict";

const links = (m: Record<string, string[]>): Map<string, Set<string>> =>
  new Map(Object.entries(m).map(([k, v]) => [k, new Set(v)]));

describe("decideRenames", () => {
  it("renames an unambiguous colliding title and reports nothing unresolved", () => {
    const notes = [{ title: "Beta", folder: "A" }];
    const existing = new Set([noteIdentityKey("A", "Beta")]);
    const got = decideRenames(notes, existing, links({ beta: ["n1"] }), "Src");
    expect(got.renames.get("Beta")).toBeTruthy();
    expect(got.ambiguousLinks).toBe(0);
  });

  it("REFUSES to rename when another source note shares the folded title", () => {
    // `Beta` in A collides; `Beta` in B does not. A rewrite keyed on the folded
    // title would retarget every `[[Beta]]`, including the two that meant B.
    const notes = [
      { title: "Beta", folder: "A" },
      { title: "Beta", folder: "B" },
    ];
    const existing = new Set([noteIdentityKey("A", "Beta")]);
    const got = decideRenames(notes, existing, links({ beta: ["n1", "n2"] }), "Src");
    expect(got.renames.size).toBe(0);
    // And the links are REPORTED rather than dropped on the floor: a link
    // nobody rewrote is visible, a link rewritten to the wrong note is not.
    expect(got.ambiguousLinks).toBe(2);
  });

  it("counts a shared folded title's inbound links ONCE, however many notes collide", () => {
    // The inflation this pins. `inboundLinks` is keyed by FOLDED TITLE, so two
    // colliding notes that fold to the same string name the same inbound set;
    // adding its size once per note counted every link twice, and three
    // colliding notes counted them three times.
    //
    // It matters because `linksLeftUnresolved` is rendered as a summary row and
    // written into the durable import report note, which
    // `decisions/storage/0550` calls the residual that must not be silent.
    // The direction is fail-safe (over-reporting), which is exactly why nothing
    // else would ever have caught it: the number stays plausible.
    //
    // Two notes in DIFFERENT folders, both colliding with the target, so both
    // reach the ambiguous arm. The sibling case above has one collide and one
    // not, which is why it could not see this.
    const notes = [
      { title: "Beta", folder: "A" },
      { title: "beta", folder: "B" },
    ];
    const existing = new Set([noteIdentityKey("A", "Beta"), noteIdentityKey("B", "beta")]);
    const got = decideRenames(notes, existing, links({ beta: ["n1", "n2", "n3"] }), "Src");
    expect(got.renames.size).toBe(0);
    expect(got.ambiguousLinks).toBe(3);
  });

  it("treats a case-only difference as the same title, since the rewrite folds", () => {
    const notes = [
      { title: "Beta", folder: "A" },
      { title: "BETA", folder: "B" },
    ];
    const existing = new Set([noteIdentityKey("A", "Beta")]);
    const got = decideRenames(notes, existing, links({ beta: ["n1"] }), "Src");
    expect(got.renames.size).toBe(0);
    expect(got.ambiguousLinks).toBe(1);
  });

  it("refuses a rename the label cannot legally produce, and reports it", () => {
    // `renamedTitleFor` returns the title UNCHANGED when `<title> (<label>)`
    // would pass `MAX_SEGMENT_BYTES`. That is deliberate, a skipped note rather
    // than a corrupted one, and it used to be stored anyway: a title-to-itself
    // entry made `planInboundRewrites` count rewrites that retargeted nothing,
    // so `linksRetargeted` was inflated and the durable report note stated a
    // number describing nothing. The note took the skip arm regardless.
    //
    // The input gate cannot catch this: `MyneVaultSetup` runs before the source
    // vault is open, so it validates the label against a one-character sample
    // and knows nothing about real title lengths.
    const long = "L".repeat(250);
    const notes = [{ title: long, folder: "A" }];
    const existing = new Set([noteIdentityKey("A", long)]);
    const got = decideRenames(
      notes,
      existing,
      links({ [long.toLowerCase()]: ["n1"] }),
      "A very long import label that pushes it over",
    );
    expect(got.renames.size).toBe(0);
    expect(got.ambiguousLinks).toBe(1);
  });

  it("leaves a colliding title with no inbound links alone", () => {
    // Nothing points at it, so there is nothing to retarget and no rename is
    // owed. This is the arm that keeps `ambiguousLinks` from counting titles
    // rather than links.
    const notes = [
      { title: "Beta", folder: "A" },
      { title: "Beta", folder: "B" },
    ];
    const existing = new Set([noteIdentityKey("A", "Beta")]);
    const got = decideRenames(notes, existing, links({}), "Src");
    expect(got.renames.size).toBe(0);
    expect(got.ambiguousLinks).toBe(0);
  });
});
