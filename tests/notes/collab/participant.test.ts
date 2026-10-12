// The shared live-collaboration participant model (`collab-presence-ui` task 1).

import { describe, expect, it } from "vitest";
import {
  colorForParticipant,
  colorVarForIndex,
  colorVarForParticipant,
  GROUP_COLORS,
  participantWithColor,
  type Participant,
} from "../../../src/notes/collab/participant";

describe("colorForParticipant", () => {
  it("is deterministic for one id and stays in the palette", () => {
    const a = colorForParticipant("person:ab12");
    expect(colorForParticipant("person:ab12")).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(GROUP_COLORS.length);
  });

  it("wraps: many distinct ids all land in 0..7 (the palette is eight)", () => {
    expect(GROUP_COLORS).toHaveLength(8);
    for (let i = 0; i < 500; i += 1) {
      const c = colorForParticipant(`device:${i.toString(16)}`);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(8);
    }
  });

  it("actually spreads ids across more than one colour", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i += 1) seen.add(colorForParticipant(`id-${i}`));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("colour variables bind a token, never a literal", () => {
  it("colorVarForParticipant returns var(--group-<name>)", () => {
    const v = colorVarForParticipant("person:xyz");
    expect(v).toMatch(/^var\(--group-(olive|fern|teal|denim|indigo|violet|orchid|rose)\)$/);
  });

  it("colorVarForIndex wraps and binds a token", () => {
    expect(colorVarForIndex(0)).toBe("var(--group-olive)");
    expect(colorVarForIndex(7)).toBe("var(--group-rose)");
    expect(colorVarForIndex(8)).toBe("var(--group-olive)");
  });
});

describe("participantWithColor", () => {
  it("derives the colour index from the id and carries the un-attributed branch", () => {
    const p: Participant = participantWithColor({
      id: "person:abc",
      noteId: "note-1",
      label: "Ada's Laptop",
      unAttributed: true,
      caret: 12,
      selection: { anchor: 4, head: 12 },
    });
    expect(p.color).toBe(colorForParticipant("person:abc"));
    expect(p.unAttributed).toBe(true);
    expect(p.label).toBe("Ada's Laptop");
  });
});
