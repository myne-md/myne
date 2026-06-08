// @vitest-environment jsdom
//
// Clean in-flight progress chip (MYND-164 dogfooding fix #4).
//
// The chip REPLACES the struck/tombstone-borrowing loading style. These tests
// pin the label selection per state + assert the chip carries none of the
// tombstone/struck/danger markers (so it can never read as "broken").

import { describe, expect, it } from "vitest";
import {
  makeProgressChip,
  progressLabel,
  type ProgressKind,
} from "../../src/editor/attachments/progress";

describe("progress label selection", () => {
  it("maps each in-flight state to its quiet label", () => {
    expect(progressLabel("importing")).toBe("Importing…");
    expect(progressLabel("encrypting")).toBe("Encrypting…");
    expect(progressLabel("loading")).toBe("Loading…");
  });
});

describe("progress chip DOM", () => {
  const kinds: ProgressKind[] = ["importing", "encrypting", "loading"];

  for (const kind of kinds) {
    it(`renders a clean ${kind} chip with label + indeterminate hairline`, () => {
      const chip = makeProgressChip(kind);
      expect(chip.classList.contains("cm-attachment-progress")).toBe(true);
      expect(chip.getAttribute("role")).toBe("status");
      // Quiet label text.
      const label = chip.querySelector(".cm-attachment-progress-label");
      expect(label?.textContent).toBe(progressLabel(kind));
      // Indeterminate hairline track (not a spinner glyph).
      expect(chip.querySelector(".cm-attachment-progress-bar")).not.toBeNull();
    });
  }

  it("is visually distinct from the tombstone — no struck/danger/tombstone class", () => {
    const chip = makeProgressChip("loading");
    const cls = chip.className;
    expect(cls).not.toMatch(/tombstone/);
    expect(cls).not.toMatch(/broken/);
    expect(cls).not.toMatch(/deleted/);
    // No line-through text and no svg spinner icon inside the chip.
    expect(chip.querySelector("svg")).toBeNull();
    const labelEl = chip.querySelector(".cm-attachment-progress-label") as HTMLElement;
    expect(labelEl.style.textDecoration).not.toMatch(/line-through/);
  });
});

