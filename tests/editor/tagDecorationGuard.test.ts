// SYNC-17 structural guard (MYND-200 / knowledge-graph-ux + tag-system / MYND-46).
// `decisions.md` 2026-06-08 "Interactive tags ship as ONE unit": the editor
// `#tag` decoration and the tag-browse surface ship as ONE unit — the decoration
// must NEVER exist without the browse target (a decorated-but-dead `#tag` is a
// manufactured affordance).
//
// Originally a DENY-list grep asserting "no tag decoration in v1". FLIPPED here
// when the interactive-tag unit landed (tag-system #2 `TagBrowser` + #3
// `tag-chip`) to assert the live invariant: "tag decoration ⟹ browse surface
// present". If a future change removes the browser but leaves the chip, this fails.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoPath = (p: string): string =>
  fileURLToPath(new URL(`../../${p}`, import.meta.url));

describe("SYNC-17 interactive-tag unit guard (MYND-46)", () => {
  it("registers the inline-#tag chip decoration in the editor aggregator", () => {
    const src = readFileSync(
      repoPath("src/editor/decorations/index.ts"),
      "utf8",
    );
    // Strip `//` line comments so the guard's own explanatory text can't trip
    // the grep — only a real registration counts.
    const code = src.replace(/\/\/.*$/gm, "");
    expect(/tagChipDecorations/.test(code)).toBe(true);
  });

  it("decoration ⟹ browse surface present (SYNC-17 invariant)", () => {
    const decorationPresent = existsSync(
      repoPath("src/editor/decorations/tag-chip.ts"),
    );
    const browsePresent = existsSync(
      repoPath("src/notes/components/TagBrowser.tsx"),
    );
    // The chip decoration exists now — and because it does, the browse surface
    // MUST also exist (never ship the decoration alone).
    expect(decorationPresent).toBe(true);
    expect(browsePresent).toBe(true);
    // Implication form: if a refactor ever drops the browser, the chip must go
    // with it.
    if (decorationPresent) expect(browsePresent).toBe(true);
  });
});
