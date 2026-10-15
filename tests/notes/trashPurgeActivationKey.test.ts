// @vitest-environment jsdom
//
// `viaKey` for a trash purge must mean "the activating key may still be DOWN",
// not "the activation was not a mouse" (myne-md/myne#683's follow-up, found by
// the review of the branch that replaced the arming window).
//
// The defect this pins: a `<button>` activates on Enter's KEYDOWN and on
// Space's KEYUP, so `e.detail === 0` is true for both. Claiming a key could
// still be held after a SPACE press shut `DeleteConfirmModal`'s guard 4 with
// nothing left to release it: Enter refused until an Enter keyup, and the
// user's first Enter cannot produce one, because the keyup follows the keydown
// the guard just refused. The symptom is exactly `nc7`'s (a first press eaten on
// a dialog whose ring names the action), on the other irreversible dialog.
//
// What is asserted here is the decision, in both directions, because only the
// browser's keyup-vs-keydown split sits above it and jsdom does not implement
// activation behaviour at all: dispatching Space at a `<button>` in jsdom fires
// no click. That half is the container E2E's (`e2e/palette-empty-trash.e2e.ts`
// drives the real WebView). Stated rather than left implied, since a unit test
// that looks like it covers the browser sequence would be the worse artefact.
import { describe, expect, it } from "vitest";
import { purgeOpenedByHeldEnter } from "../../src/notes/components/TrashPanel";

describe("purge activation key", () => {
  it("counts an Enter activation as a key that may still be held", () => {
    expect(purgeOpenedByHeldEnter(0, "Enter")).toBe(true);
  });

  it("does NOT count a Space activation, whose click fires on the keyup", () => {
    // The browser order is keydown(" ") -> keyup(" ") -> click(detail 0), so by
    // the time the dialog mounts the key is already up.
    expect(purgeOpenedByHeldEnter(0, " ")).toBe(false);
  });

  it("does NOT count a pointer activation, whatever key was pressed last", () => {
    expect(purgeOpenedByHeldEnter(1, "Enter")).toBe(false);
    expect(purgeOpenedByHeldEnter(1, "a")).toBe(false);
    expect(purgeOpenedByHeldEnter(1, null)).toBe(false);
  });

  it("does not count a keyboard activation with no recorded keydown", () => {
    // Defensive: an activation that arrives with no keydown before it (a
    // synthetic click, an assistive tool) leaves nothing to release, so the
    // guard must stay off rather than shut with no way to open it.
    expect(purgeOpenedByHeldEnter(0, null)).toBe(false);
  });
});
