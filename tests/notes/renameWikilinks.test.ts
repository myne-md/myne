// Form-preserving inbound rewrite on rename (MYND-85, §8.2).

import { describe, it, expect } from "vitest";
import {
  planInboundFolderRewrites,
  planInboundRewrites,
  type InboundRewrite,
} from "../../src/notes/renameWikilinks";

const afters = (rows: InboundRewrite[]) => rows.map((r) => r.after);
const t = { oldTitle: "Old Title", newTitle: "New Title" };
const ft = { oldFolder: "Projects/", newFolder: "Work/" };

describe("planInboundRewrites (§8.2 form preservation)", () => {
  it("title-only → swaps the title text", () => {
    expect(afters(planInboundRewrites("see [[Old Title]] here", t))).toEqual(["[[New Title]]"]);
  });

  it("preserves alias / heading / block", () => {
    expect(afters(planInboundRewrites("[[Old Title|A]]", t))).toEqual(["[[New Title|A]]"]);
    expect(afters(planInboundRewrites("[[Old Title#H]]", t))).toEqual(["[[New Title#H]]"]);
    expect(afters(planInboundRewrites("[[Old Title^b1]]", t))).toEqual(["[[New Title^b1]]"]);
  });

  it("preserves the embed prefix", () => {
    expect(afters(planInboundRewrites("![[Old Title]]", t))).toEqual(["![[New Title]]"]);
  });

  it("path-form swaps only the filename segment (folder + alias kept)", () => {
    expect(afters(planInboundRewrites("[[notes/2025/Old Title.md|A]]", t))).toEqual([
      "[[notes/2025/New Title.md|A]]",
    ]);
  });

  it("matches fold-insensitively", () => {
    expect(afters(planInboundRewrites("[[old title]]", t))).toEqual(["[[New Title]]"]);
  });

  it("never promotes a title-only link to path-form", () => {
    const rows = planInboundRewrites("[[Old Title]]", t);
    expect(rows[0]?.after).toBe("[[New Title]]");
    expect(rows[0]?.after.includes("/")).toBe(false);
    expect(rows[0]?.after.includes(".md")).toBe(false);
  });

  it("leaves non-matching links untouched (no row)", () => {
    expect(planInboundRewrites("[[Other Note]] and [[Unrelated|x]]", t)).toHaveLength(0);
  });

  it("rewrites every matching occurrence in document order", () => {
    const rows = planInboundRewrites("[[Old Title]] mid [[Old Title|A]]", t);
    expect(afters(rows)).toEqual(["[[New Title]]", "[[New Title|A]]"]);
  });

  // §8.2 alias-mirror refinement (MYND-85 follow-up): an alias that equals the
  // OLD title is an auto-emitted display (Myne emits `[[path.md|Title]]`) and
  // tracks the new title; a genuinely-custom alias is preserved. Without this,
  // every Myne-authored inbound chip froze at the old name on rename.
  describe("alias that mirrors the old title tracks the new title", () => {
    it("Myne-authored path-form `[[path.md|Old Title]]` → `[[path.md|New Title]]`", () => {
      expect(afters(planInboundRewrites("[[notes/Old Title.md|Old Title]]", t))).toEqual([
        "[[notes/New Title.md|New Title]]",
      ]);
    });

    it("title-only `[[Old Title|Old Title]]` → `[[New Title|New Title]]`", () => {
      expect(afters(planInboundRewrites("[[Old Title|Old Title]]", t))).toEqual([
        "[[New Title|New Title]]",
      ]);
    });

    it("alias match is fold-insensitive (`|old title` mirrors `Old Title`)", () => {
      expect(afters(planInboundRewrites("[[notes/Old Title.md|old title]]", t))).toEqual([
        "[[notes/New Title.md|New Title]]",
      ]);
    });

    it("a genuinely-custom alias (≠ old title) is still preserved", () => {
      expect(afters(planInboundRewrites("[[notes/Old Title.md|My Label]]", t))).toEqual([
        "[[notes/New Title.md|My Label]]",
      ]);
      expect(afters(planInboundRewrites("[[Old Title|My Label]]", t))).toEqual([
        "[[New Title|My Label]]",
      ]);
    });

    it("the alias-mirror still preserves a heading/block anchor", () => {
      expect(afters(planInboundRewrites("[[Old Title#H|Old Title]]", t))).toEqual([
        "[[New Title#H|New Title]]",
      ]);
    });
  });
});

describe("planInboundFolderRewrites (MYND-370 folder-target links)", () => {
  it("rewrites `[[Projects/]]` → `[[Work/]]`", () => {
    expect(afters(planInboundFolderRewrites("go [[Projects/]] now", ft))).toEqual([
      "[[Work/]]",
    ]);
  });

  it("re-roots a descendant folder target `[[Projects/Myne/]]` → `[[Work/Myne/]]`", () => {
    expect(afters(planInboundFolderRewrites("[[Projects/Myne/]]", ft))).toEqual([
      "[[Work/Myne/]]",
    ]);
  });

  it("preserves alias + embed form on a folder target", () => {
    expect(afters(planInboundFolderRewrites("![[Projects/|Label]]", ft))).toEqual([
      "![[Work/|Label]]",
    ]);
  });

  it("leaves a note path-form link `[[Projects/Note]]` untouched (no trailing slash)", () => {
    expect(planInboundFolderRewrites("[[Projects/Note]]", ft)).toEqual([]);
  });

  it("leaves a title-only link `[[Projects]]` untouched", () => {
    expect(planInboundFolderRewrites("[[Projects]]", ft)).toEqual([]);
  });

  it("does not false-match a name-prefix sibling `[[Projectsx/]]`", () => {
    expect(planInboundFolderRewrites("[[Projectsx/]]", ft)).toEqual([]);
  });

  it("is empty for a no-op rename (source === target)", () => {
    expect(
      planInboundFolderRewrites("[[Projects/]]", {
        oldFolder: "Projects/",
        newFolder: "Projects/",
      }),
    ).toEqual([]);
  });
});
