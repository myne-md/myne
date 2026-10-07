// Meeting AI task 3: the note writer (pure compose + injected IO).
//
// Two properties are asserted because they are the ones that lose data: the
// transcript is never touched, and a regenerate replaces the PREVIOUS AI block
// in place rather than appending a second one or cutting user text that was
// written after it.

import { describe, expect, it } from "vitest";

import {
  buildAiBlock,
  MEETING_AI_END,
  MEETING_AI_NOTICE,
  MEETING_AI_START,
  upsertAiBlock,
} from "../../src/notes/ai/meetingWrite";

describe("buildAiBlock", () => {
  it("emits only the present sections, in order, wrapped in markers", () => {
    const block = buildAiBlock(
      { actionItems: "- A", summary: "S" },
      MEETING_AI_NOTICE,
    );
    expect(block).toContain(MEETING_AI_START);
    expect(block).toContain(MEETING_AI_END);
    expect(block).toContain(MEETING_AI_NOTICE);
    expect(block).toContain("## Summary");
    expect(block).toContain("## Action items");
    expect(block.indexOf("## Summary")).toBeLessThan(
      block.indexOf("## Action items"),
    );
  });

  it("omits sections that are absent", () => {
    const block = buildAiBlock({ summary: "S" }, MEETING_AI_NOTICE);
    expect(block).not.toContain("## Action items");
    expect(block).not.toContain("## Decisions");
    expect(block).not.toContain("## Open questions");
  });
});

describe("upsertAiBlock", () => {
  it("appends the block when the body has none", () => {
    const block = buildAiBlock({ summary: "S" }, MEETING_AI_NOTICE);
    const out = upsertAiBlock("transcript", block);
    expect(out.startsWith("transcript")).toBe(true);
    expect(out).toContain(block);
  });

  it("replaces a previous block in place and preserves text on both sides", () => {
    const first = buildAiBlock({ summary: "old" }, MEETING_AI_NOTICE);
    const body = `transcript\n\n${first}\n\ntrailing user note`;
    const second = buildAiBlock({ summary: "new" }, MEETING_AI_NOTICE);
    const out = upsertAiBlock(body, second);
    expect(out).toContain("transcript");
    expect(out).toContain("trailing user note");
    expect(out).toContain("new");
    expect(out).not.toContain("old");
    expect(out.match(/myne:meeting-ai:start/g)).toHaveLength(1);
  });
});

describe("upsertAiBlock (broken marker pair)", () => {
  it("appends rather than truncating when the end marker is missing", () => {
    const body = `${MEETING_AI_START}\n\n## Summary\nold\n\ntrailing user text`;
    const block = buildAiBlock({ summary: "new" }, MEETING_AI_NOTICE);
    const out = upsertAiBlock(body, block);
    // The user text after the orphan start marker must survive.
    expect(out).toContain("trailing user text");
    expect(out).toContain("new");
  });
});
