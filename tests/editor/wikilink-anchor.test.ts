// Anchor resolution + parse for wikilink deep-links (MYND-305).
//
// Two surfaces under test:
//  1. `parseWikilinkParts` now carries the `^block-id` anchor (previously
//     DROPPED — the chip-widget never read `WikilinkBlockId`). Drives a real
//     CodeMirror state with the dialect's Wikilink parser.
//  2. The pure anchor-match function (`anchor.ts`): heading fold-identity match,
//     duplicate → first, not-found → null (caller scrolls to note top), and
//     imported `^block-id` marker resolve-on-click (reads only).

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import { parseWikilinkParts } from "../../src/editor/wikilink/chip-widget";
import {
  findBlockOffset,
  findHeadingOffset,
  hasAnchor,
  resolveAnchorOffset,
} from "../../src/editor/wikilink/anchor";

function stateOf(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [Wikilink] })],
  });
}

/** Parse the single wikilink in `doc` (the whole doc is one link). */
function partsOf(doc: string) {
  return parseWikilinkParts(stateOf(doc), 0, doc.length);
}

describe("parseWikilinkParts — anchors (MYND-305)", () => {
  it("carries the heading anchor", () => {
    const p = partsOf("[[Note#Heading]]");
    expect(p.target).toBe("Note");
    expect(p.heading).toBe("Heading");
    expect(p.blockId).toBeNull();
  });

  it("carries the `^block-id` anchor (previously dropped)", () => {
    const p = partsOf("[[Note^abc123]]");
    expect(p.target).toBe("Note");
    expect(p.blockId).toBe("abc123");
    expect(p.heading).toBeNull();
  });

  it("path-form link with a heading anchor", () => {
    const p = partsOf("[[notes/2025/01-10.md#Morning|Wednesday]]");
    expect(p.target).toBe("notes/2025/01-10.md");
    expect(p.heading).toBe("Morning");
    expect(p.alias).toBe("Wednesday");
    expect(p.blockId).toBeNull();
  });

  it("a plain link has neither anchor", () => {
    const p = partsOf("[[Note]]");
    expect(p.heading).toBeNull();
    expect(p.blockId).toBeNull();
  });
});

describe("hasAnchor", () => {
  it("true for a heading or block anchor, false otherwise", () => {
    expect(hasAnchor({ heading: "H" })).toBe(true);
    expect(hasAnchor({ blockId: "b1" })).toBe(true);
    expect(hasAnchor({ heading: null, blockId: null })).toBe(false);
    expect(hasAnchor({ heading: "" })).toBe(false);
    expect(hasAnchor(null)).toBe(false);
    expect(hasAnchor(undefined)).toBe(false);
  });
});

describe("findHeadingOffset — fold-identity match (§5.6 step 1)", () => {
  const body = "# Intro\nlead\n\n## Setup steps\nbody\n\n### Deploy\ntail\n";

  it("matches a heading by its exact text → its line start", () => {
    const off = findHeadingOffset(body, "Setup steps");
    expect(off).not.toBeNull();
    expect(body.slice(off!, off! + "## Setup steps".length)).toBe("## Setup steps");
  });

  it("matches case-insensitively (fold-identity, NOT a slug)", () => {
    expect(findHeadingOffset(body, "setup STEPS")).toBe(
      findHeadingOffset(body, "Setup steps"),
    );
    // A slug normaliser would turn "Setup steps" into "setup-steps" and fail to
    // match the spaced anchor; fold-identity matches the raw text.
    expect(findHeadingOffset(body, "Deploy")).not.toBeNull();
  });

  it("returns null for a heading that does not exist (caller → note top)", () => {
    expect(findHeadingOffset(body, "Nonexistent")).toBeNull();
  });

  it("an empty / whitespace anchor matches nothing", () => {
    expect(findHeadingOffset(body, "")).toBeNull();
    expect(findHeadingOffset(body, "   ")).toBeNull();
  });

  it("duplicate heading text → FIRST match wins (deterministic, §5.6)", () => {
    const dup = "# Notes\nfirst section\n# Notes\nsecond section\n";
    const off = findHeadingOffset(dup, "Notes");
    // The first "# Notes" starts at offset 0.
    expect(off).toBe(0);
  });
});

describe("findBlockOffset — imported `^block-id` marker (§5.6 step 2, reads only)", () => {
  it("scrolls to the line carrying a matching imported marker", () => {
    const body = "intro\n\nA tagged paragraph. ^abc123\n\nmore\n";
    const off = findBlockOffset(body, "abc123");
    expect(off).not.toBeNull();
    expect(body.slice(off!, off! + 1)).toBe("A");
  });

  it("accepts a leading `^` in the queried id", () => {
    const body = "para ^xy-9\n";
    expect(findBlockOffset(body, "^xy-9")).toBe(0);
  });

  it("returns null when no matching marker exists (caller → note top)", () => {
    expect(findBlockOffset("no markers here\n", "missing")).toBeNull();
  });

  it("rejects an id with illegal characters (mints nothing, matches nothing)", () => {
    expect(findBlockOffset("x ^a/b\n", "a/b")).toBeNull();
  });
});

describe("resolveAnchorOffset — generic dispatch (§5.6)", () => {
  const body = "# Top\n\n## Middle\nbody ^blk1\n";

  it("dispatches a heading anchor", () => {
    expect(resolveAnchorOffset(body, { heading: "Middle" })).toBe(
      findHeadingOffset(body, "Middle"),
    );
  });

  it("dispatches a block anchor", () => {
    expect(resolveAnchorOffset(body, { blockId: "blk1" })).toBe(
      findBlockOffset(body, "blk1"),
    );
  });

  it("null anchor → null (scroll to note top)", () => {
    expect(resolveAnchorOffset(body, null)).toBeNull();
    expect(resolveAnchorOffset(body, { heading: "" })).toBeNull();
  });

  it("a not-found heading → null (note-top fallback)", () => {
    expect(resolveAnchorOffset(body, { heading: "Ghost" })).toBeNull();
  });
});
