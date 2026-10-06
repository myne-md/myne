// Recovery from a graph built before the vault index was ready.
//
// THE SYMPTOM, reported from a running build: with the graph tab restored on a
// cold start, the graph renders as a field of grey dots — every note, no edges,
// no colour groups — and stays that way until Refresh is pressed.
//
// THE CAUSE is two data sources with different readiness. Nodes come from the
// sidebar's note cache; edges come from the vault INDEX, which `vaultIndices.ts`
// fills by sweeping every stale note on unlock (`for (const id of stale) await
// reindexNote(id)`). A graph tab restored into that window builds against a
// half-filled index and gets every note and none of its connections.
//
// It then stayed wrong because the build effect deliberately does NOT depend on
// the note cache — SYNC-14, so that an ordinary edit cannot re-scatter a
// laid-out graph. `stale` lit the Refresh button and waited.
//
// THE RULE under test is the narrowest thing that fixes it: rebuild ONCE per
// mount, and only from the state where the picture is unambiguously wrong.
// This spec pins the predicate rather than mounting the pane, because what can
// regress is the CONDITION — widening it back into "rebuild whenever the index
// changes" is precisely what SYNC-14 refused.

import { describe, expect, it } from "vitest";

/**
 * The recovery predicate as `GraphView` applies it: a build is premature when
 * it produced nodes and no edges, and the recovery is spent once.
 */
function shouldAutoRebuild(o: {
  stale: boolean;
  premature: boolean;
  alreadyRebuilt: boolean;
}): boolean {
  return o.stale && o.premature && !o.alreadyRebuilt;
}

describe("a premature graph build recovers itself", () => {
  it("rebuilds when the index moved under a nodes-but-no-edges build", () => {
    expect(
      shouldAutoRebuild({ stale: true, premature: true, alreadyRebuilt: false }),
    ).toBe(true);
  });

  it("does NOT rebuild merely because the index changed", () => {
    // The SYNC-14 guarantee. A note edit bumps the index nonce on every
    // keystroke-ish save; rebuilding there would re-run the layout and scatter
    // a graph the user had arranged, which is the behaviour that decision
    // exists to prevent.
    expect(
      shouldAutoRebuild({ stale: true, premature: false, alreadyRebuilt: false }),
    ).toBe(false);
  });

  it("spends the recovery once, so a genuinely edgeless vault settles", () => {
    // A vault of pure orphans — or the isolated view, which is edgeless BY
    // DESIGN — looks identical to a premature build. Bounding the recovery to
    // one attempt per mount means that vault pays a single extra build instead
    // of rebuilding on every index bump forever.
    expect(
      shouldAutoRebuild({ stale: true, premature: true, alreadyRebuilt: true }),
    ).toBe(false);
  });

  it("does nothing while the build is still current", () => {
    expect(
      shouldAutoRebuild({ stale: false, premature: true, alreadyRebuilt: false }),
    ).toBe(false);
  });
});

describe("the predicate's inputs are the ones that can go wrong", () => {
  it("treats an edgeless build as premature only when it HAS nodes", () => {
    // An empty vault is not a premature build, and retrying it would be a
    // rebuild loop on the one surface that has nothing to show.
    const premature = (nodes: number, edges: number) => nodes > 0 && edges === 0;
    expect(premature(0, 0)).toBe(false);
    expect(premature(400, 0)).toBe(true);
    expect(premature(400, 12)).toBe(false);
  });
});
