// @vitest-environment jsdom
//
// Render-performance regression canaries (MYND-210, render-performance tasks
// 2+3). The vitest *bench* (`render-perf.bench.ts`) reports raw timings; these
// are the asserting *tests* that fail the suite on a regression.
//
// Two contracts are guarded here:
//
//   Task 2 — frame budget. The per-interaction hot path (a cursor-move
//   decoration rebuild) must stay within a ~16 ms frame budget (60 fps) up to a
//   documented doc-size ceiling. We assert the MEDIAN rebuild (not max/p99) so
//   the canary is robust to GC/JIT/CI-noise spikes; a true O(n²) regression
//   blows past the budget at the median, not just the tail. A second,
//   machine-speed-independent assertion checks the cost stays ~linear (not
//   quadratic) as the doc grows — that is the actual "no full-doc rescan per
//   keystroke" property, independent of how fast the runner is.
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
import { syntheticDoc } from "./_synthetic-doc";

// ── doc-size ceiling ────────────────────────────────────────────────────────
// CI-asserted ceiling for the hard 16 ms budget. Deliberately conservative so
// the absolute-wall-clock assertion never flakes on a throttled shared runner
// (median rebuild here is ~1–2 ms — ~8× headroom). The bench separately shows
// the cursor-move rebuild stays under budget at the TAIL out to 10k lines
// (p99 ≈ 11 ms), which is the real headroom; 2k is the figure we *guarantee*.
const CEILING_LINES = 2_000;
const FRAME_BUDGET_MS = 16;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** Time one cursor-move decoration rebuild (the per-interaction hot path). */
function timeCursorMove(m: Mounted, pos: number): number {
  const t0 = performance.now();
  m.view.dispatch({ selection: { anchor: pos, head: pos } });
  return performance.now() - t0;
}

/** Median cursor-move rebuild over `samples` moves scattered across `doc`,
 *  after a short warm-up to settle JIT/first-run allocation. */
function medianRebuildMs(doc: string, samples = 21): number {
  const m = mount(doc, 0);
  m.view.focus();
  try {
    for (let i = 0; i < 3; i++) timeCursorMove(m, Math.floor((doc.length * i) / 3));
    const ds: number[] = [];
    for (let i = 0; i < samples; i++) {
      ds.push(timeCursorMove(m, Math.floor((doc.length * (i + 1)) / (samples + 1))));
    }
    return median(ds);
  } finally {
    teardown(m);
  }
}

describe("frame budget (task 2)", () => {
  it(`cursor-move rebuild stays under ${FRAME_BUDGET_MS} ms (median) at the ${CEILING_LINES}-line ceiling`, () => {
    const ms = medianRebuildMs(syntheticDoc(CEILING_LINES));
    expect(ms).toBeLessThan(FRAME_BUDGET_MS);
  });

  it("rebuild cost stays ~linear (not quadratic) as the doc grows 4×", () => {
    // Machine-speed-independent: 4× the lines should be ~4× the time if the
    // pipeline is linear. A full-doc-per-keystroke O(n²) rescan would be ~16×.
    // Allow a generous 6× to absorb constant-factor + noise while still
    // catching any super-linear blow-up.
    const small = medianRebuildMs(syntheticDoc(1_000));
    const large = medianRebuildMs(syntheticDoc(4_000));
    // Guard against a near-zero `small` making the ratio explode on noise.
    const ratio = large / Math.max(small, 0.05);
    expect(ratio).toBeLessThan(6);
  });
});

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
