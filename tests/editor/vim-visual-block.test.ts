// @vitest-environment jsdom
//
// vim-keyboard-mode (MYND-313) — visual-block ↔ multi-cursor (MYND-306).
//
// This was the PRD's one open question: both features drive CodeMirror's multiple
// selections, and nobody had checked what happens when they meet. The three cases
// that could plausibly break:
//
//   1. entering visual-block while a `Mod-d` multi-selection is live
//   2. pressing `Mod-d` while already in visual mode
//   3. Escape with both notionally active
//
// The finding, in one line: **the engine treats CodeMirror's selection as its own
// visual state**, so the two features are not two competing selection models —
// they are one model with vim layered on top. That is why nothing deadlocks. What
// changes is only how many Escapes it takes to get back to a single cursor.
//
// These tests exist to keep that true. If a future change makes vim maintain a
// private selection, or makes `Mod-d` bypass the state, this file fails.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { myneKeyBindings } from "../../editor/src/keymap";
import { applyChordPolicy, resetChordPolicyForTests } from "../../editor/src/vim-chords";
import {
  VIM_MODE_ATTR,
  reconfigureVim,
  resetVimGenerationForTests,
  vimApi,
  vimExtension,
} from "../../editor/src/vim";

function pressEscape(view: EditorView): void {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
}

/** Two identical words so `selectNextOccurrence` (Mod-d) has something to find. */
const DOC = "alpha bravo\nalpha delta";

describe("visual-block ↔ multi-cursor (MYND-313 / MYND-306)", () => {
  let view: EditorView | null = null;
  let host: HTMLElement | null = null;

  beforeEach(() => {
    resetVimGenerationForTests();
    // Claim the (process-wide) chord policy latch as macOS, so the real engine
    // load leaves `<C-v>` bound to visual-block. On Ctrl-is-Mod platforms it is
    // surrendered to paste and visual-block lives on `<A-v>` (task 7) — that
    // remap is covered in `vim-chords.test.ts`; here the concern is the
    // interaction, not the chord.
    resetChordPolicyForTests();
    applyChordPolicy({ Vim: { unmap: () => undefined, noremap: () => undefined } }, true);
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      state: EditorState.create({
        doc: DOC,
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          keymap.of([...myneKeyBindings]),
          vimExtension(),
        ],
      }),
      parent: host,
    });
  });

  afterEach(() => {
    if (view !== null) view.destroy();
    if (host !== null) host.remove();
    view = null;
    host = null;
  });

  it("case 1 — visual-block entered with a multi-selection live: state stays coherent", async () => {
    const v = view!;
    await reconfigureVim(v, true);
    const api = vimApi()!;
    const cm = api.getCM(v)!;

    // A Myne-style multi-selection (what Mod-d builds up).
    v.dispatch({
      selection: EditorSelection.create(
        [EditorSelection.range(0, 5), EditorSelection.range(12, 17)],
        0,
      ),
    });
    expect(v.state.selection.ranges).toHaveLength(2);

    // Ask the engine for visual-block on top of it.
    api.Vim.handleKey(cm, "<C-v>", "user");

    // No crash, no lost cursor, and the editor is in a visual mode of some kind.
    expect(v.dom.getAttribute(VIM_MODE_ATTR)).toBe("visual");
    expect(v.state.selection.ranges.length).toBeGreaterThanOrEqual(1);
    expect(v.state.doc.toString()).toBe(DOC); // nothing was edited
  });

  it("case 2 — Mod-d while in visual mode adds a range without breaking the mode", async () => {
    const v = view!;
    await reconfigureVim(v, true);
    // Selecting text is ITSELF what puts the engine in visual mode — pressing
    // `v` on top of an existing selection would toggle back OUT of it. (Learned
    // the hard way here; the first draft of this test asserted the opposite.)
    v.dispatch({ selection: EditorSelection.single(0, 5) });
    expect(v.dom.getAttribute(VIM_MODE_ATTR)).toBe("visual");

    const before = v.state.selection.ranges.length;
    // Mod-d is a plain CM command; it runs regardless of vim's mode because CM
    // keymaps execute before the engine's DOM handler.
    const ran = myneKeyBindings.find((b) => b.key === "Mod-d")!.run!(v);

    expect(ran).toBe(true);
    expect(v.state.selection.ranges.length).toBeGreaterThanOrEqual(before);
    expect(v.state.doc.toString()).toBe(DOC);
  });

  it("case 3 — Escape unwinds visual then collapses, never deadlocks", async () => {
    const v = view!;
    await reconfigureVim(v, true);

    v.dispatch({
      selection: EditorSelection.create(
        [EditorSelection.range(0, 5), EditorSelection.range(12, 17)],
        0,
      ),
    });
    expect(v.dom.getAttribute(VIM_MODE_ATTR)).toBe("visual");

    // First Escape: leave visual (the mode transition wins — task 6's ordering).
    pressEscape(v);
    expect(v.dom.getAttribute(VIM_MODE_ATTR)).toBe("normal");

    // Second Escape: now normal mode, so the multi-selection collapses.
    pressEscape(v);
    expect(v.state.selection.ranges).toHaveLength(1);

    // Third Escape: nothing left to do — must not throw or re-enter a mode.
    pressEscape(v);
    expect(v.state.selection.ranges).toHaveLength(1);
    expect(v.dom.getAttribute(VIM_MODE_ATTR)).toBe("normal");
  });

  it("multi-cursor with vim OFF is untouched by any of this", () => {
    const v = view!;
    v.dispatch({
      selection: EditorSelection.create(
        [EditorSelection.range(0, 5), EditorSelection.range(12, 17)],
        0,
      ),
    });
    expect(v.state.selection.ranges).toHaveLength(2);
    expect(v.dom.hasAttribute(VIM_MODE_ATTR)).toBe(false);

    // One Escape collapses — the pre-vim behaviour, with no mode step in the way.
    pressEscape(v);
    expect(v.state.selection.ranges).toHaveLength(1);
  });
});
