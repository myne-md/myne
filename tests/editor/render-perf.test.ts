// @vitest-environment jsdom
//
// Render-performance regression canaries (MYND-210, render-performance tasks
// 2+3). The vitest *bench* (`render-perf.bench.ts`) reports raw timings; these
// are the asserting *tests* that fail the suite on a regression.
//
// One contract is guarded here, and one used to be:
//
//   Task 2 — frame budget. NO LONGER ASSERTED HERE. Both of its assertions
//   were wall-clock, and it is not only the absolute one that flakes in the
//   parallel suite: the ratio does too, for a reason a ratio is normally
//   immune to. The block below the imports carries the measurements, why a
//   wider bound does not rescue it either, and what should replace them, which
//   is a COUNT of what one rebuild visits rather than a third clock. Raw
//   timings on known hardware stay in `render-perf.bench.ts`.
//
//   Task 3 — heavy-widget mount contract. KaTeX/Mermaid/embedded-HTML widgets
//   memoize by a source-derived `key` in `eq()`. CodeMirror reuses the existing
//   DOM node when `eq()` is true, so an unrelated edit elsewhere must NOT tear
//   down an unchanged heavy widget. We assert DOM-node identity survives a
//   far-away edit — if `eq()` regressed, CodeMirror would rebuild the node and
//   the identity check would fail.

import { afterEach, describe, expect, it } from "vitest";
import katex from "katex";
import {
  type MathRenderer,
  setMathRenderer,
} from "../../src/editor/decorations/math";
import { type Mounted, mount, query, teardown } from "./_conformance";

// ── THE `frame budget (task 2)` BLOCK WAS REMOVED FROM THE CI SUITE ─────────
//
// It held two assertions. Both were wall-clock, both flake in the parallel
// vitest suite, and the measurements are recorded here rather than the block
// being deleted with a one-line excuse.
//
// 1. `cursor-move rebuild stays under 16 ms (median) at the 2000-line ceiling`.
//    The comment justifying it claimed the median here is "~1–2 ms — ~8×
//    headroom", so it "never flakes on a throttled shared runner". Measured:
//
//      idle dev machine (10-core Apple Silicon, nothing else running)   5.7 ms
//      the CI runner, contended                                        19.6 ms
//      threshold                                                         16 ms
//
//    Real headroom 2.8×, not 8×. On 2026-08-30 this single assertion was the
//    ONLY failure in four separate pipelines, `develop` among them (1 failed
//    against 681 passing). Woodpecker runs two workflows per host, so a queue
//    is the normal condition, not the exceptional one.
//
// 2. `rebuild cost stays ~linear (not quadratic) as the doc grows 4×`, a RATIO
//    of the 4 000-line median over the 1 000-line one, bounded at 6. A ratio
//    cancels machine speed, so this one looked safe, and the first draft of
//    this removal kept it on exactly that reasoning. Measuring refuted it:
//
//      idle, file run alone                          2.6 – 2.9
//      isolated file, concurrent cargo build         2.7 – 3.9
//      FULL suite + concurrent cargo build      2.31, 5.59, 8.37
//
//    Contention is not uniform. The 4 000-line measurement holds the CPU for
//    longer, so it absorbs more descheduling than the 1 000-line one, and the
//    ratio inflates rather than cancelling. In the full suite it ranged over
//    3.6× on noise alone and crossed the bound of 6 once in three runs. The
//    bound sits inside the noise band.
//
//    Widening the bound does not rescue it. Injecting a true O(n²) cost into
//    the timed path — iterations scaling with the square of document length,
//    so 4× the lines is 16× the work — measured 9.98 on an idle machine, and
//    the observed noise already reaches 8.37. Any bound clear of the noise is
//    close enough to the signal that the gate stops meaning anything.
//
// WHAT REPLACES THEM. Not a third clock. The property both were proxying —
// no full-document rescan per keystroke — is a COUNT, so it should be counted:
// instrument the decoration pipeline to report how many lines or nodes one
// rebuild visits, and assert that scales with the edited range rather than
// with the document. A counter is identical on an idle laptop and a saturated
// runner, which is the whole problem here. That needs production-side
// instrumentation and is deliberately not bundled into this removal.
//
// UNTIL THEN there is no automated performance gate on this path, which is
// stated plainly because a quiet gap is worse than a known one. The absolute
// numbers stay readable where a human reads them on known hardware:
// `render-perf.bench.ts` already benches this exact hot path ("cursor-move
// rebuild — 10k-line synthetic doc"). A gate that fires on noise is not a
// weaker gate than none; it is worse, because it teaches people that red means
// "run it again".

describe("heavy-widget mount contract (task 3)", () => {
  const renderer: MathRenderer = (latex, display) => {
    try {
      return {
        html: katex.renderToString(latex, {
          displayMode: display,
          throwOnError: true,
          output: "html",
        }),
        error: null,
      };
    } catch (e) {
      return { html: "", error: e instanceof Error ? e.message : String(e) };
    }
  };

  let m: Mounted | null = null;
  afterEach(() => {
    if (m !== null) teardown(m);
    m = null;
  });

  it("an unchanged math widget's DOM node survives an unrelated far-away edit", () => {
    // A math widget near the top, a long run of plain paragraphs, then an edit
    // point far below. If `eq()` holds (same source key), CodeMirror reuses the
    // node; if it regressed, the node would be rebuilt and identity would break.
    const tail = Array.from({ length: 200 }, (_, i) => `paragraph ${i}`).join("\n");
    m = mount(`intro $E = mc^2$ line\n\n${tail}\nEDIT HERE\n`, 0);
    m.view.dispatch({ effects: setMathRenderer.of(renderer) });
    m.view.requestMeasure();

    const before = query(m, ".cm-math-inline");
    expect(before).not.toBeNull();
    expect(before!.querySelector(".katex")).not.toBeNull();

    // Edit far away from the widget (append at end) — unrelated to the math.
    const end = m.view.state.doc.length;
    m.view.dispatch({ changes: { from: end, insert: " appended" } });
    m.view.requestMeasure();

    const after = query(m, ".cm-math-inline");
    expect(after).not.toBeNull();
    // Same DOM node object — proof the widget was NOT torn down + rebuilt.
    expect(after).toBe(before);
    // And its rendered KaTeX child is still intact (not re-rendered from scratch).
    expect(after!.querySelector(".katex")).not.toBeNull();
  });

  it("a math widget IS rebuilt when its own source changes (eq() returns false)", () => {
    m = mount(`a $x^2$ b\n`, 0);
    m.view.dispatch({ effects: setMathRenderer.of(renderer) });
    m.view.requestMeasure();
    const before = query(m, ".cm-math-inline");
    expect(before).not.toBeNull();

    // Change the math source itself: $x^2$ → $x^3$. New key ⇒ eq() false ⇒
    // CodeMirror replaces the node. (Cursor stays at 0, off the widget.)
    const at = m.view.state.doc.toString().indexOf("x^2") + 2; // the "2"
    m.view.dispatch({ changes: { from: at, to: at + 1, insert: "3" } });
    m.view.requestMeasure();

    const after = query(m, ".cm-math-inline");
    expect(after).not.toBeNull();
    expect(after).not.toBe(before); // rebuilt — different source key
  });
});
