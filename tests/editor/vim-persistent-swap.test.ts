// @vitest-environment jsdom
//
// vim-keyboard-mode × persistent-EditorView (MYND-313 × MYND-534).
//
// These two features interact through CM6 compartments, and the interaction is
// invisible in either feature's own tests. `applyState` — the persistent-view
// swap the desktop pane performs on every note switch — calls
// `view.setState(...)`, which resets EVERY compartment to the seed the incoming
// state was built with, and vim is seeded OFF (`vimExtension()` →
// `vimCompartment.of([])`). React cannot save it either: `vimMode` did not
// change across a note switch, so the `[vimMode]` effect never re-runs.
//
// Left unhandled that means: enable vim → switch notes → back in plain insert
// mode. `CMEditor.reapplyCompartments` therefore re-applies vim alongside the
// other compartments after every swap.
//
// OBSERVABLE: the engine's own `getCM(view)` adapter lookup, which reads a
// StateField and is therefore gone the moment the compartment resets.
// Deliberately NOT the `data-vim-mode` attribute — that is written straight to
// `view.dom` and SURVIVES a `setState`, so after an unguarded swap the badge
// would still read "normal" while modal editing was already dead. Asserting on
// it would have made this test pass against the bug.
//
// The view is mounted into a REAL attached node: `reconfigureVim` guards on
// `view.dom.isConnected`, so a detached host makes every enable a silent no-op
// and the assertions vacuous.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  VIM_MODE_ATTR,
  reconfigureVim,
  resetVimGenerationForTests,
  vimApi,
  vimExtension,
} from "../../editor/src/vim";

/** Build a per-note state the way `CMEditor.makeState` does — vim seeded OFF. */
function noteState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [vimExtension()] });
}

/** Is the vim layer actually live on this view? */
function vimIsLive(view: EditorView): boolean {
  return (vimApi()?.getCM(view) ?? null) !== null;
}

describe("vim survives a persistent-view state swap (MYND-313 × MYND-534)", () => {
  let view: EditorView | null = null;
  let host: HTMLElement | null = null;

  beforeEach(() => {
    resetVimGenerationForTests();
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({ state: noteState("note A body"), parent: host });
  });

  afterEach(() => {
    if (view !== null) view.destroy();
    if (host !== null) host.remove();
    view = null;
    host = null;
  });

  it("a bare setState drops the layer — the hazard the re-apply exists for", async () => {
    const v = view!;
    await reconfigureVim(v, true);
    expect(vimIsLive(v)).toBe(true);

    // Exactly what `applyState` does, with nothing re-applied after it.
    v.setState(noteState("note B body"));

    expect(v.state.doc.toString()).toBe("note B body");
    expect(vimIsLive(v)).toBe(false);
    // …and the badge still lies, which is why it is not the observable above.
    expect(v.dom.hasAttribute(VIM_MODE_ATTR)).toBe(true);
  });

  it("re-applying after the swap keeps modal editing on the incoming note", async () => {
    const v = view!;
    await reconfigureVim(v, true);

    // `applyState` order: swap the incoming note's state in, then re-apply the
    // live compartment config — what `reapplyCompartments` does.
    v.setState(noteState("note B body"));
    await reconfigureVim(v, true);

    expect(v.state.doc.toString()).toBe("note B body");
    expect(vimIsLive(v)).toBe(true);
    expect(v.dom.getAttribute(VIM_MODE_ATTR)).toBe("normal");
  });

  it("a swap with vim OFF leaves the incoming note plain", async () => {
    const v = view!;
    v.setState(noteState("note B body"));
    await reconfigureVim(v, false);

    expect(vimIsLive(v)).toBe(false);
    expect(v.dom.hasAttribute(VIM_MODE_ATTR)).toBe(false);
  });

  it("switching notes repeatedly keeps vim live on every one", async () => {
    const v = view!;
    await reconfigureVim(v, true);

    for (const body of ["note B body", "note C body", "note A body"]) {
      v.setState(noteState(body));
      await reconfigureVim(v, true);
      expect(v.state.doc.toString()).toBe(body);
      expect(vimIsLive(v)).toBe(true);
    }
  });
});
