// @vitest-environment jsdom
//
// myne-md/myne#908 — when automatic tagging may write.
//
// The once-per-session rule is the convergence guard: the pass re-fires on every
// content change, so "write on every pass" lets a model that emits a variant
// each time add tags forever, and nothing reports it. The rule is a pure
// function so it can be held to that claim; the pane only fills it in.

import { describe, expect, it, beforeEach } from "vitest";
import { shouldAutoApply } from "../../src/notes/ai/autoApply";
import {
  __resetAutoApplyTagsForTest,
  readAutoApplyTags,
  subscribeAutoApplyTags,
  writeAutoApplyTags,
} from "../../src/lib/autoApplyTags";

const base = {
  enabled: true,
  passEnabled: true,
  hasSuggestions: true,
  editedThisSession: true,
  alreadyApplied: false,
  readOnly: false,
};

describe("shouldAutoApply", () => {
  it("writes for an edited note with suggestions", () => {
    expect(shouldAutoApply(base)).toBe(true);
  });

  it("never writes for a note that was only opened", () => {
    expect(shouldAutoApply({ ...base, editedThisSession: false })).toBe(false);
  });

  it("writes once per note per session", () => {
    expect(shouldAutoApply({ ...base, alreadyApplied: true })).toBe(false);
  });

  it("never writes in a read-only view", () => {
    expect(shouldAutoApply({ ...base, readOnly: true })).toBe(false);
  });

  it("stays off when either switch is off or there is nothing to write", () => {
    expect(shouldAutoApply({ ...base, enabled: false })).toBe(false);
    expect(shouldAutoApply({ ...base, passEnabled: false })).toBe(false);
    expect(shouldAutoApply({ ...base, hasSuggestions: false })).toBe(false);
  });
});

describe("the device-local flag", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetAutoApplyTagsForTest();
  });

  it("defaults to off, which is the safe direction", () => {
    localStorage.clear();
    expect(readAutoApplyTags()).toBe(false);
  });

  it("round-trips and notifies the same window", () => {
    const seen: boolean[] = [];
    const off = subscribeAutoApplyTags((v) => seen.push(v));
    writeAutoApplyTags(true);
    expect(readAutoApplyTags()).toBe(true);
    writeAutoApplyTags(false);
    off();
    writeAutoApplyTags(true);
    // `storage` does not fire in the writing window, so the module owns this.
    expect(seen).toEqual([true, false]);
  });
});
