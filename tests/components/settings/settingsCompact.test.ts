// #391 — pure Settings-dialog compact (restack) decision.
//
// The trigger is a window/dialog resize, which the tauri-driver E2E harness has
// no primitive to drive (e2e/CLAUDE.md "states unreachable through real UI"), so
// the load-bearing decision is covered here as a Vitest unit; the hook in
// `settingsCompact.ts` is thin ResizeObserver glue over this function.

import { describe, it, expect } from "vitest";
import {
  isSettingsCompact,
  SETTINGS_COMPACT_WIDTH,
} from "../../../src/components/settings/settingsCompact";

describe("isSettingsCompact (#391)", () => {
  it("is not compact at the default dialog's content width (~832px)", () => {
    expect(isSettingsCompact(832)).toBe(false);
  });

  it("is compact once the content area is narrow enough to overlap", () => {
    // ~667px content is the Editor panel's overlap onset (a ~935px window).
    expect(isSettingsCompact(667)).toBe(true);
  });

  it("treats the threshold as inclusive", () => {
    expect(isSettingsCompact(SETTINGS_COMPACT_WIDTH)).toBe(true);
    expect(isSettingsCompact(SETTINGS_COMPACT_WIDTH + 1)).toBe(false);
  });

  it("does not force compact before the first real measurement", () => {
    for (const pre of [0, -1, NaN, Infinity, -Infinity]) {
      expect(isSettingsCompact(pre)).toBe(false);
    }
  });
});
