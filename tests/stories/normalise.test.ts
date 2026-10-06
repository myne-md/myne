// The default DOM normaliser for the drift baseline (myne-md/myne#832).
//
// The PRD's Testing Decisions promise "volatile values stripped, stable output
// for a fixed input". Each class the normaliser claims to strip is asserted here
// by injecting it, and stability is asserted by normalising twice.

import { describe, expect, it } from "vitest";
import { normalise } from "../../stories/src/host/normalise";

describe("story drift normaliser", () => {
  it("strips React 19 generated ids", () => {
    const html = '<div id="_r_1a_" aria-describedby="_r_2b_">x</div>';
    const out = normalise(html);
    expect(out).not.toContain("_r_1a_");
    expect(out).not.toContain("_r_2b_");
  });

  it("strips React 18 generated ids", () => {
    expect(normalise('<label for=":r7:">x</label>')).not.toContain(":r7:");
  });

  it("strips an ISO timestamp", () => {
    const out = normalise("<span>2026-10-05T12:34:56.789Z</span>");
    expect(out).not.toContain("2026-10-05");
    expect(out).toContain("<ts>");
  });

  it("strips a bare epoch number", () => {
    expect(normalise("<time>1759664096789</time>")).toContain("<epoch>");
  });

  it("strips an aria-live announcement's contents", () => {
    const out = normalise('<div aria-live="polite">Saved 3 notes</div>');
    expect(out).not.toContain("Saved 3 notes");
  });

  it("is stable for a fixed input (idempotent)", () => {
    const html = '<div style="color:var(--fg-1)">Hello</div>';
    expect(normalise(html)).toBe(normalise(html));
    expect(normalise(normalise(html))).toBe(normalise(html));
  });

  it("keeps style attributes (they carry the tokens)", () => {
    expect(normalise('<i style="gap:var(--space-3)"></i>')).toContain(
      "gap:var(--space-3)",
    );
  });
});
