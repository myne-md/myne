// Auto-name formatting for voice-note recordings (MYND-259).

import { describe, expect, it } from "vitest";
import { voiceNoteFilename } from "../../src/editor/attachments/voiceRecord";

describe("voiceNoteFilename", () => {
  it("formats a Voice note name from the date (month is 1-based in output)", () => {
    // JS Date month is 0-based: 5 → June.
    const d = new Date(2026, 5, 14, 9, 5, 3);
    expect(voiceNoteFilename(d)).toBe("Voice note 2026-06-14 09-05-03.wav");
  });

  it("zero-pads every two-digit component", () => {
    const d = new Date(2026, 11, 1, 23, 59, 9);
    expect(voiceNoteFilename(d)).toBe("Voice note 2026-12-01 23-59-09.wav");
  });
});
