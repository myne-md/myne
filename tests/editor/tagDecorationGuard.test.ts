// SYNC-17 structural guard (MYND-200 / knowledge-graph-ux). `decisions.md`
// 2026-06-08 "Interactive tags ship as ONE unit": editor `#tag` decoration may
// land ONLY together with the tag-browse surface — never as a standalone
// editor-polish change (a decorated-but-dead `#tag` is a manufactured affordance).
//
// This DENY-list grep (the 2026-05-06 `tracing` discipline pattern, applied to
// UI affordances) fails if a tag decoration is wired into the editor aggregator
// or a tag-decoration module appears. When the interactive-tag unit lands,
// UPDATE this to assert "tag decoration ⟹ browse surface present" rather than
// "tag decoration absent".

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoPath = (p: string): string =>
  fileURLToPath(new URL(`../../${p}`, import.meta.url));

describe("SYNC-17 tag-decoration guard (MYND-200)", () => {
  it("registers NO inline-#tag decoration in the editor aggregator", () => {
    const src = readFileSync(
      repoPath("src/editor/decorations/index.ts"),
      "utf8",
    );
    // Strip `//` line comments so the guard's OWN explanatory comment (which
    // names `tagDecorations()` as the forbidden thing) can't trip the grep.
    const code = src.replace(/\/\/.*$/gm, "");
    expect(/tagDecorations|inlineTagDecorations/.test(code)).toBe(false);
    expect(/from\s+["']\.\/(inline-)?tag["']/.test(code)).toBe(false);
  });

  it("ships no tag-decoration module in v1", () => {
    expect(existsSync(repoPath("src/editor/decorations/tag.ts"))).toBe(false);
    expect(existsSync(repoPath("src/editor/decorations/inline-tag.ts"))).toBe(
      false,
    );
  });
});
