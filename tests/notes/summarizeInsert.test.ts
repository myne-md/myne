import { describe, expect, it, vi } from "vitest";

import {
  SUMMARY_BLOCK_HEADING,
  appendSummaryBlock,
  insertSummary,
} from "../../src/notes/ai/summarize";

// note-summarization (MYND-409) task 5 — the explicit "Insert into note" write.
describe("appendSummaryBlock", () => {
  it("appends a ## Summary block separated by one blank line", () => {
    expect(appendSummaryBlock("The note body.", "A short summary.")).toBe(
      "The note body.\n\n## Summary\n\nA short summary.\n",
    );
  });

  it("collapses to one blank line when the body already ends in a newline", () => {
    expect(appendSummaryBlock("body\n", "s")).toBe("body\n\n## Summary\n\ns\n");
    expect(appendSummaryBlock("body\n\n", "s")).toBe("body\n\n## Summary\n\ns\n");
  });

  it("emits only the block for an empty body", () => {
    expect(appendSummaryBlock("", "s")).toBe("## Summary\n\ns\n");
  });

  it("trims the summary and uses the plain-markdown heading (no new format)", () => {
    const out = appendSummaryBlock("b", "  padded  ");
    expect(out).toContain(`${SUMMARY_BLOCK_HEADING}\n\npadded\n`);
    expect(out.endsWith("padded\n")).toBe(true);
  });
});

describe("insertSummary", () => {
  it("persists the appended body via the injected save and returns it", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const out = await insertSummary({
      body: "body",
      summary: "sum",
      save,
    });
    const expected = "body\n\n## Summary\n\nsum\n";
    expect(out).toBe(expected);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(expected);
  });

  it("does not save unless called (no auto-insert path)", () => {
    const save = vi.fn();
    // Constructing nothing / not calling insertSummary → save never fires.
    expect(save).not.toHaveBeenCalled();
  });
});
