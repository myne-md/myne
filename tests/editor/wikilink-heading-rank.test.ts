// Pure heading ranking for the `[[#` / `[[##` autocomplete (MYND-305).
// Mirrors `wikilink-picker-rank.test.ts` (the note-picker rank) — no view.

import { describe, expect, it } from "vitest";
import {
  rankCurrentHeadings,
  rankVaultHeadings,
} from "../../src/editor/wikilink/picker-heading-rank";
import { classifyPickerFilter } from "../../src/editor/wikilink/picker";
import { headingSections } from "../../src/dialect";
import type { VaultHeading } from "../../src/editor/wikilink/vault-headings";

describe("classifyPickerFilter — `[[#` / `[[##` mode discriminator (MYND-305)", () => {
  it("`##query` → vault-heading mode, prefix stripped", () => {
    expect(classifyPickerFilter("##goals")).toEqual({
      kind: "vault-heading",
      query: "goals",
    });
  });
  it("`#query` → current-heading mode, prefix stripped", () => {
    expect(classifyPickerFilter("#setup")).toEqual({
      kind: "current-heading",
      query: "setup",
    });
  });
  it("a bare filter → note mode (the default note picker)", () => {
    expect(classifyPickerFilter("wednesday")).toEqual({ kind: "note", query: "wednesday" });
    expect(classifyPickerFilter("")).toEqual({ kind: "note", query: "" });
  });
  it("`##` alone (empty query) is still vault-heading mode", () => {
    expect(classifyPickerFilter("##")).toEqual({ kind: "vault-heading", query: "" });
  });
});

describe("rankCurrentHeadings (`[[#`)", () => {
  const sections = headingSections("# Intro\n## Setup steps\n## Deploy\n## Setup steps\n");

  it("lists the current note's headings on an empty query", () => {
    const rows = rankCurrentHeadings("", sections);
    expect(rows.map((r) => r.heading)).toEqual(["Intro", "Setup steps", "Deploy"]);
  });

  it("de-duplicates identical heading text (first wins, §5.6)", () => {
    // Two "## Setup steps" → one row.
    const rows = rankCurrentHeadings("", sections);
    expect(rows.filter((r) => r.heading === "Setup steps")).toHaveLength(1);
  });

  it("fuzzy-filters by heading text", () => {
    const rows = rankCurrentHeadings("setup", sections);
    expect(rows.map((r) => r.heading)).toContain("Setup steps");
    expect(rows.map((r) => r.heading)).not.toContain("Deploy");
  });

  it("carries the heading level", () => {
    const rows = rankCurrentHeadings("intro", sections);
    expect(rows[0]?.level).toBe(1);
  });

  it("returns [] for a no-match query (picker closes upstream)", () => {
    expect(rankCurrentHeadings("zzzqqq", sections)).toEqual([]);
  });
});

describe("rankVaultHeadings (`[[##`)", () => {
  const headings: VaultHeading[] = [
    { noteUuid: "a", title: "Spec", folder: "Projects/", heading: "Goals", level: 2 },
    { noteUuid: "b", title: "Spec", folder: "Projects/", heading: "Setup", level: 2 },
    { noteUuid: "c", title: "Diary", folder: null, heading: "Setup", level: 1 },
  ];

  it("lists vault-wide headings on an empty query (no cross-note de-dupe)", () => {
    const rows = rankVaultHeadings("", headings);
    // Both `Setup` headings survive — distinct notes, distinct targets.
    expect(rows.filter((r) => r.entry.heading === "Setup")).toHaveLength(2);
  });

  it("matches on the owning note title too (title is a haystack)", () => {
    // Querying the note title surfaces THAT note's headings (both "Spec"
    // headings rank in), since the title is one of the candidate's haystacks.
    const rows = rankVaultHeadings("spec", headings);
    const fromSpec = rows.filter((r) => r.entry.title === "Spec");
    expect(fromSpec.map((r) => r.entry.heading).sort()).toEqual(["Goals", "Setup"]);
  });

  it("filters by heading text", () => {
    const rows = rankVaultHeadings("goals", headings);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entry.heading).toBe("Goals");
    expect(rows[0]?.entry.title).toBe("Spec");
  });

  it("returns [] for a no-match query", () => {
    expect(rankVaultHeadings("zzzqqq", headings)).toEqual([]);
  });
});
