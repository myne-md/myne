// The extractor's scan roster and the shared-tree roster are one list
// (audit 2026-10-18 R0.4, fixed 2026-10-19).
//
// `i18next.config.js` kept its `input` globs by hand, under a comment saying so,
// and had already drifted: `scripts/lib/shared-roots.mjs` holds nine trees and
// the config listed six, so `client-core/src`, `ornaments/src` and `stories/src`
// were never scanned. The cost is silent in both directions and neither is an
// error: a `t()` key added to an unscanned tree is invisible to the documented
// add-a-string procedure (`myne-agents/docs/dev/i18n.md`), and a stale path in a glob matches
// nothing rather than failing.
//
// The config now imports the roster, which is the construction. This test is
// what holds the construction in place: a future author who replaces the import
// with a literal list — the way the file was written for its first two years —
// fails here rather than drifting again.

import { describe, expect, it } from "vitest";
import { presentSharedRoots } from "../../scripts/lib/shared-roots.mjs";
import config from "../../i18next.config.js";

const globs = config.extract.input;

describe("the extractor scans every shared tree", () => {
  it("covers each present shared root", () => {
    const { present, missing } = presentSharedRoots();
    expect(missing, "a missing root is a broken checkout, not a narrower scan").toEqual([]);
    for (const root of present) {
      expect(globs, `${root} has no glob in i18next.config.js`).toContain(
        `${root}/**/*.{ts,tsx}`,
      );
    }
  });

  it("covers nothing else, so the roster is the whole answer", () => {
    // A glob outside the roster is a second, hand-kept scope — the shape this
    // change removed. `preview/src` is the one tree that is deliberately absent
    // from `SHARED_ROOTS` (it is a captured artefact, not source), and this
    // asserts it stays that way by accident of the derivation rather than by
    // anyone remembering.
    const { present } = presentSharedRoots();
    const expected = present.map((root) => `${root}/**/*.{ts,tsx}`);
    expect([...globs].sort()).toEqual(expected.sort());
  });
});
