// The fail-closed exit label, per platform (phase3-web-client task 95).
//
// # Why this exists, in one sentence
//
// A previous pass changed the desktop label from "Close app" to "Close Myne" —
// a nicer sentence, a different one — and broke `state-machine.e2e.ts`'s
// full-literal assertion. The E2E caught it, which is the system working; it
// caught it two hours and one container rebuild later, which is the part worth
// fixing.
//
// # The property, and why "unchanged" is the right one
//
// Task 95's last criterion is that desktop fail-closed COPY be unchanged. The
// seam exists so the button's label cannot drift from what it DOES — and on
// desktop the action did not change (destroy the window), so the label must not
// either. It has to render the same words the three reasons' own `cta` keys
// already rendered, because those are what shipped and what E2E pins.
//
// The web arm is the mirror image and is asserted for the same reason: there the
// action DID change (a reload, since a tab cannot close itself), so the label
// must have changed too. A web build still saying "Close app" would be the
// original bug — a button lying about what it does — wearing the fix's clothes.

import { describe, expect, it } from "vitest";
import en from "../../locales/en/common.json";

type Catalog = Record<string, Record<string, unknown>>;
const catalog = en as unknown as Catalog;

function copy(path: string): string {
  const value = path
    .split(".")
    .reduce<unknown>((acc, key) => (acc as Record<string, unknown>)?.[key], catalog);
  expect(typeof value, `${path} must exist in the English catalog`).toBe("string");
  return value as string;
}

describe("fail-closed exit label", () => {
  it("the desktop exit label is the words the reasons already used", () => {
    // Not "some non-empty string" — the exact words, because `state-machine`
    // and `vault-recovery` assert them by full-literal equality and the whole
    // point of load-bearing copy is that a paraphrase is a regression.
    expect(copy("failClosed.exit.quit")).toBe("Close app");
    for (const reason of ["corrupted", "ioError", "permissionDenied"]) {
      expect(
        copy(`failClosed.${reason}.cta`),
        `${reason}'s own CTA and the seam's exit label must agree`,
      ).toBe(copy("failClosed.exit.quit"));
    }
  });

  it("the web exit label is NOT the desktop one", () => {
    // The action differs, so the words must. If these ever collapse to one
    // string, one of the two platforms has a button that lies.
    expect(copy("failClosed.exit.reload")).not.toBe(copy("failClosed.exit.quit"));
    expect(copy("failClosed.exit.reload")).toBe("Reload");
  });

  it("`invalid-state` keeps its own label, which is neither exit", () => {
    // The Editor mount guard's CTA is a LOCK. An earlier draft made the seam
    // label unconditional and turned that button into an exit label — a button
    // lying about what it does, on the screen where the user is most stuck.
    const lock = copy("failClosed.invalidState.cta");
    expect(lock).not.toBe(copy("failClosed.exit.quit"));
    expect(lock).not.toBe(copy("failClosed.exit.reload"));
  });
});
