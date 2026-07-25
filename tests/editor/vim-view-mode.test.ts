// vim-keyboard-mode (MYND-313) — source view as the default while vim is on.
//
// Live preview hides markdown markers; vim's motions still count them, so `dw`
// operates over characters the user cannot see. Source view removes the mismatch
// (design session Q6). The rule is a DEFAULT, never an override: an explicit
// stored preference wins in either direction, and a per-tab choice — applied by
// `PaneView` above this function — wins over both.

import { describe, expect, it } from "vitest";
import { resolveDefaultViewMode } from "../../editor/src/view-mode";

describe("default view mode with vim (MYND-313)", () => {
  it("vim off, no stored pref → live (today's behaviour, unchanged)", () => {
    expect(resolveDefaultViewMode(null, false)).toBe("live");
    expect(resolveDefaultViewMode(undefined, false)).toBe("live");
  });

  it("vim on, no stored pref → source", () => {
    expect(resolveDefaultViewMode(null, true)).toBe("source");
    expect(resolveDefaultViewMode(undefined, true)).toBe("source");
  });

  it("an explicit stored preference wins over the vim default", () => {
    // The user went to Settings and chose live on purpose. Turning vim on must
    // not silently discard that.
    expect(resolveDefaultViewMode("live", true)).toBe("live");
    expect(resolveDefaultViewMode("reading", true)).toBe("reading");
    expect(resolveDefaultViewMode("source", true)).toBe("source");
  });

  it("an explicit preference is equally respected with vim off", () => {
    expect(resolveDefaultViewMode("source", false)).toBe("source");
    expect(resolveDefaultViewMode("reading", false)).toBe("reading");
  });

  it("an unknown stored value still coerces to live, vim or not", () => {
    // Same "unknown → live" rule `asViewMode` owns; a garbage pref must not
    // become a source-view surprise just because vim happens to be on.
    expect(resolveDefaultViewMode("nonsense", false)).toBe("live");
    expect(resolveDefaultViewMode("nonsense", true)).toBe("live");
  });
});
