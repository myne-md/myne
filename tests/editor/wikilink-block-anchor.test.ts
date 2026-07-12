// `[[^^` enumerate-only imported-block-anchor picker (MYND-382).
// Pure surface only (classify + rank + emit + the index extraction) — no view.

import { describe, expect, it } from "vitest";
import {
  classifyPickerFilter,
} from "../../src/editor/wikilink/picker";
import { rankVaultBlockAnchors } from "../../src/editor/wikilink/picker-heading-rank";
import { emitVaultBlockAnchorWikilink } from "../../src/editor/wikilink/emit";
import type { VaultBlockAnchor } from "../../src/editor/wikilink/vault-block-anchors";
import { extractBlockAnchorEntries } from "../../src/notes/vaultIndices";

describe("classifyPickerFilter — `[[^^` block-anchor mode (MYND-382)", () => {
  it("`^^query` → vault-block-anchor mode, prefix stripped", () => {
    expect(classifyPickerFilter("^^revenue")).toEqual({
      kind: "vault-block-anchor",
      query: "revenue",
    });
  });
  it("`^^` alone → block-anchor mode with an empty query (browse all)", () => {
    expect(classifyPickerFilter("^^")).toEqual({
      kind: "vault-block-anchor",
      query: "",
    });
  });
  it("a single leading `^` is NOT block-anchor mode (falls to note)", () => {
    // Only the double caret is the enumerate trigger.
    expect(classifyPickerFilter("^foo").kind).toBe("note");
  });
  it("`##` still wins for headings (no collision with `^^`)", () => {
    expect(classifyPickerFilter("##goals").kind).toBe("vault-heading");
  });
});

const ANCHORS: VaultBlockAnchor[] = [
  {
    noteUuid: "n1",
    title: "Q3 Report",
    folder: "Finance/",
    blockId: "revenue",
    preview: "Total revenue grew 12% quarter over quarter.",
  },
  {
    noteUuid: "n2",
    title: "Roadmap",
    folder: null,
    blockId: "milestone",
    preview: "Ship the sync layer by June.",
  },
];

describe("rankVaultBlockAnchors (MYND-382)", () => {
  it("matches the block id", () => {
    const rows = rankVaultBlockAnchors("revenue", ANCHORS);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entry.blockId).toBe("revenue");
  });
  it("matches the preview text", () => {
    const rows = rankVaultBlockAnchors("sync", ANCHORS);
    expect(rows.map((r) => r.entry.blockId)).toEqual(["milestone"]);
  });
  it("matches the owning note title", () => {
    const rows = rankVaultBlockAnchors("roadmap", ANCHORS);
    expect(rows.map((r) => r.entry.blockId)).toEqual(["milestone"]);
  });
  it("empty query browses everything", () => {
    expect(rankVaultBlockAnchors("", ANCHORS)).toHaveLength(2);
  });
});

describe("emitVaultBlockAnchorWikilink (MYND-382)", () => {
  it("emits the path-form `^blockId` deep-link with a default alias", () => {
    expect(emitVaultBlockAnchorWikilink("Finance/", "Q3 Report", "revenue")).toBe(
      "[[Finance/Q3 Report.md^revenue|Q3 Report › ^revenue]]",
    );
  });
  it("null folder → root path", () => {
    expect(emitVaultBlockAnchorWikilink(null, "Roadmap", "milestone")).toBe(
      "[[Roadmap.md^milestone|Roadmap › ^milestone]]",
    );
  });
});

describe("extractBlockAnchorEntries — index feed (MYND-382)", () => {
  it("enumerates `^id` markers with a marker-stripped preview", () => {
    const body = "# Title\n\nThe intro paragraph. ^intro\n\nMore text ^end";
    const got = extractBlockAnchorEntries(body);
    expect(got).toEqual([
      { blockId: "intro", preview: "The intro paragraph." },
      { blockId: "end", preview: "More text" },
    ]);
  });
  it("mints nothing when there are no markers", () => {
    expect(extractBlockAnchorEntries("just prose, no anchors")).toEqual([]);
  });

  it("own-line marker (Obsidian non-paragraph block) previews the preceding block", () => {
    // `^tbl` on its own line refers to the table above it — the marker line
    // strips to empty, so the preview falls back to the preceding non-empty line.
    const body = "| a | b |\n| 1 | 2 |\n^tbl";
    expect(extractBlockAnchorEntries(body)).toEqual([
      { blockId: "tbl", preview: "| 1 | 2 |" },
    ]);
  });

  it("own-line marker skips blank lines back to real content", () => {
    const body = "The callout body.\n\n\n^cb";
    expect(extractBlockAnchorEntries(body)).toEqual([
      { blockId: "cb", preview: "The callout body." },
    ]);
  });
});
