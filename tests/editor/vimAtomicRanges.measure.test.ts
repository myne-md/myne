// @vitest-environment jsdom
// MEASUREMENT: do atomic ranges govern vim motions? (MYND-614, task 2)
//
// Not a regression test — a measurement, written as a test so the finding is
// reproducible and so a future `@replit/codemirror-vim` upgrade reports it if the
// answer changes.
//
// The question: `EditorView.atomicRanges` makes ordinary cursor motion treat a
// replaced range as one unit. Does the vim engine honour that, or does it move by
// raw document offsets straight through the replacement? It matters for a narrow
// but real cell of users — someone with vim enabled who ALSO overrode the
// source-mode default, so they see chips *and* navigate with `h`/`l`.
//
// Measured against the same `EditorView.atomicRanges` facet the shipped tag chip
// registers (`editor/src/decorations/tag-chip.ts:127`), which is exactly the
// mechanism MYND-614's chips will use.
//
// The vim package is a dependency of the `editor` workspace package, not of the
// root, and it is lazy-loaded there on purpose (a user with vim off never
// downloads it). This test resolves it through the same dynamic import the
// editor uses, and SKIPS rather than fails if it cannot be resolved from the
// root test context — a measurement that cannot run must not look like a
// regression.

import { describe, expect, it } from "vitest";
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import { EditorView, Decoration } from "@codemirror/view";
// Routed through the editor package's own lazy loader: `@replit/codemirror-vim`
// is a dependency of `editor/`, not of the root, and the editor deliberately
// loads it on demand (a user with vim off never downloads it). Importing it
// directly from a root-level test cannot resolve.
import { reconfigureVim, vimApi, vimExtension } from "@myne/editor/vim";

const DOC = "ab #tag cd";
const ATOMIC_FROM = DOC.indexOf("#tag");
const ATOMIC_TO = ATOMIC_FROM + "#tag".length;

/** The atomic-range facet value, built the way `tag-chip.ts` builds it. */
function atomicExtension() {
  const builder = new RangeSetBuilder<Decoration>();
  builder.add(ATOMIC_FROM, ATOMIC_TO, Decoration.mark({}));
  const set = builder.finish();
  return EditorView.atomicRanges.of(() => set);
}



describe("control: atomic ranges under plain (non-vim) motion", () => {
  it("plain motion treats the atomic span as one unit", () => {
    const view = new EditorView({
      state: EditorState.create({ doc: DOC, extensions: [atomicExtension()] }),
    });
    view.dispatch({ selection: { anchor: ATOMIC_FROM - 1 } });
    const moved = view.moveByChar(view.state.selection.main, true);
    // The whole point of the facet: one step from just-before does not land
    // strictly inside the span.
    expect(moved.head > ATOMIC_FROM && moved.head < ATOMIC_TO).toBe(false);
    view.destroy();
  });
});

describe("MEASUREMENT: atomic ranges under vim motion", () => {
  it("records where a vim `l` lands relative to the atomic span", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: DOC,
        extensions: [vimExtension(), atomicExtension()],
      }),
    });

    await reconfigureVim(view, true);
    const api = vimApi();
    if (api === null) {
      // eslint-disable-next-line no-console
      console.log("[MYND-614 task 2] SKIPPED — vim engine did not load in this environment");
      view.destroy();
      host.remove();
      return;
    }

    view.dispatch({ selection: { anchor: ATOMIC_FROM - 1 } });
    const cm = api.getCM(view);
    if (cm === null) {
      // eslint-disable-next-line no-console
      console.log("[MYND-614 task 2] SKIPPED — vim handle unavailable");
      view.destroy();
      host.remove();
      return;
    }

    // Step 1: from just before the span.
    api.Vim.handleKey(cm, "l", "test");
    const afterFirst = view.state.selection.main.head;

    // Step 2 is the decisive one: from the span's own start, does `l` step INTO
    // the atomic range (offset arithmetic, facet ignored) or jump past it?
    api.Vim.handleKey(cm, "l", "test");
    const afterSecond = view.state.selection.main.head;

    const head = afterSecond;
    const landedInside = afterSecond > ATOMIC_FROM && afterSecond < ATOMIC_TO;

    // eslint-disable-next-line no-console
    console.log(
      `[MYND-614 task 2] step1 head=${afterFirst}, step2 head=${afterSecond}, ` +
        `atomic=[${ATOMIC_FROM},${ATOMIC_TO})`,
    );

    // eslint-disable-next-line no-console
    console.log(
      `[MYND-614 task 2] FINDING: vim 'l' from ${ATOMIC_FROM - 1} → head=${head}; ` +
        `atomic=[${ATOMIC_FROM},${ATOMIC_TO}); landedInside=${landedInside}`,
    );

    // FINDING (2026-07-28, @replit/codemirror-vim 6.3.0): the vim engine moves by
    // raw document offsets and does NOT honour `EditorView.atomicRanges` — `l`
    // steps straight into the replaced span. Pinned so an engine upgrade that
    // starts honouring the facet fails this test and reports the change.
    expect(landedInside).toBe(true);
    expect(head).toBe(ATOMIC_FROM + 1);
    view.destroy();
    host.remove();
  });
});
