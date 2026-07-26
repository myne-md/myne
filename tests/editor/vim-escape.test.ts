// @vitest-environment jsdom
//
// vim-keyboard-mode (MYND-313) — Escape ordering.
//
// The design (session Q2) is "one Escape, one job", resolved in this order:
//
//   open overlay closes (mode untouched)
//     → insert/visual returns to normal
//       → multi-selection collapses
//         → falls through to the window-level handlers
//
// The mechanism that makes this work is a CodeMirror fact worth stating, because
// the whole layer depends on it and it is NOT obvious: **every CM keymap handler
// runs before the vim engine's DOM-level keydown handler.** The engine binds
// `eventHandlers.keydown` on a ViewPlugin and calls `stopPropagation()` only once
// it has consumed a key — so a Myne binding that returns `true` silently takes
// the key away from vim, and one that returns `false` hands it over.
//
// That inverts the naive expectation (vim "grabs everything first") and it is the
// reason `collapseMultiSelection` has to actively decline while vim is mid-mode.
// These tests pin the consequence, so a future refactor that reorders keymaps or
// makes a handler unconditionally `true` fails here rather than in a user's hands.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { myneKeyBindings } from "../../editor/src/keymap";
import {
  VIM_MODE_ATTR,
  reconfigureVim,
  resetVimGenerationForTests,
  vimApi,
  vimExtension,
} from "../../editor/src/vim";

/** Dispatch a real Escape keydown at the editor's content DOM, the way the
 *  browser would, so both the keymap layer and the engine's DOM handler see it. */
function pressEscape(view: EditorView): void {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
}

describe("vim Escape ordering (MYND-313)", () => {
  let view: EditorView | null = null;
  let host: HTMLElement | null = null;
  /** Set by the stand-in overlay handler when it consumes an Escape. */
  let overlayClosed = false;
  /** Toggles the stand-in overlay's "am I open" state. */
  let overlayOpen = false;

  beforeEach(() => {
    resetVimGenerationForTests();
    overlayClosed = false;
    overlayOpen = false;
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      state: EditorState.create({
        doc: "alpha bravo charlie\nalpha delta echo",
        extensions: [
          // `myneExtensions()` enables this (multi-cursor, MYND-306); without it
          // CodeMirror collapses every multi-range dispatch to the primary range
          // and the collapse assertions below would be vacuous.
          EditorState.allowMultipleSelections.of(true),
          // Stand-in for the real overlays (slash menu, `[[` picker, `{{` tokens,
          // spell menu, find bar). They all share one shape: a `Prec.highest`
          // Escape binding that consumes the key ONLY while open. Modelling that
          // shape keeps this test about the ordering contract rather than about
          // any single menu's internals.
          Prec.highest(
            keymap.of([
              {
                key: "Escape",
                run: () => {
                  if (!overlayOpen) return false;
                  overlayOpen = false;
                  overlayClosed = true;
                  return true;
                },
              },
            ]),
          ),
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

  async function enterInsertMode(v: EditorView): Promise<void> {
    await reconfigureVim(v, true);
    const api = vimApi()!;
    api.Vim.handleKey(api.getCM(v)!, "i", "user");
    expect(v.dom.getAttribute(VIM_MODE_ATTR)).toBe("insert");
  }

  it("an open overlay consumes Escape and leaves the mode untouched", async () => {
    const v = view!;
    await enterInsertMode(v);
    overlayOpen = true;

    pressEscape(v);

    expect(overlayClosed).toBe(true);
    // Still typing — the user dismissed a menu, they did not ask to leave insert.
    expect(v.dom.getAttribute(VIM_MODE_ATTR)).toBe("insert");
  });

  it("with nothing open, Escape returns insert → normal", async () => {
    const v = view!;
    await enterInsertMode(v);

    pressEscape(v);

    expect(overlayClosed).toBe(false);
    expect(v.dom.getAttribute(VIM_MODE_ATTR)).toBe("normal");
  });

  it("in normal mode, Escape collapses multiple CURSORS", async () => {
    // Multiple empty cursors keep vim in normal mode; a multi-range SELECTION
    // does not (see the visual-mode test below). This is the case where Myne's
    // collapse is the only thing Escape has to do.
    const v = view!;
    await reconfigureVim(v, true);
    expect(v.dom.getAttribute(VIM_MODE_ATTR)).toBe("normal");

    v.dispatch({
      selection: EditorSelection.create(
        [EditorSelection.cursor(3), EditorSelection.cursor(22)],
        0,
      ),
    });
    expect(v.state.selection.ranges).toHaveLength(2);
    expect(v.dom.getAttribute(VIM_MODE_ATTR)).toBe("normal");

    pressEscape(v);

    expect(v.state.selection.ranges).toHaveLength(1);
  });

  it("a multi-range SELECTION puts vim in visual mode, so Escape leaves visual first", async () => {
    // Discovered while building this layer, and directly relevant to task 8
    // (visual-block ↔ multi-cursor): the engine treats any non-empty selection as
    // visual mode, including one Myne created via `Mod-d`. So Escape's first job
    // there is leaving visual — the collapse is the SECOND press. Pinned because
    // it is surprising and a future change to `vimWantsEscape` would silently
    // alter it.
    const v = view!;
    await reconfigureVim(v, true);

    v.dispatch({
      selection: EditorSelection.create(
        [EditorSelection.range(0, 5), EditorSelection.range(20, 25)],
        0,
      ),
    });
    expect(v.dom.getAttribute(VIM_MODE_ATTR)).toBe("visual");

    pressEscape(v);
    expect(v.dom.getAttribute(VIM_MODE_ATTR)).toBe("normal");

    pressEscape(v);
    expect(v.state.selection.ranges).toHaveLength(1);
  });

  it("in insert mode with a multi-selection, the FIRST Escape only leaves insert", async () => {
    // The ordering bug this guards against: `collapseMultiSelection` would
    // otherwise return `true`, consume the key, and strand the user in insert
    // mode with the selection collapsed — the mode transition they actually
    // asked for silently lost.
    const v = view!;
    await enterInsertMode(v);
    v.dispatch({
      selection: EditorSelection.create(
        [EditorSelection.cursor(3), EditorSelection.cursor(22)],
        0,
      ),
    });
    expect(v.state.selection.ranges).toHaveLength(2);

    pressEscape(v);
    expect(v.dom.getAttribute(VIM_MODE_ATTR)).toBe("normal");

    // Second Escape, now in normal mode, does the collapse.
    pressEscape(v);
    expect(v.state.selection.ranges).toHaveLength(1);
  });

  it("with vim off, Escape behaves exactly as before (regression)", () => {
    const v = view!;
    // No `reconfigureVim` call at all — this is the path every existing user is
    // on, and it must be byte-for-byte the old behaviour.
    v.dispatch({
      selection: EditorSelection.create(
        [EditorSelection.range(0, 5), EditorSelection.range(20, 25)],
        0,
      ),
    });

    pressEscape(v);

    expect(v.state.selection.ranges).toHaveLength(1);
    expect(v.dom.hasAttribute(VIM_MODE_ATTR)).toBe(false);
  });

  it("with vim off and a single cursor, Escape is declined so overlays still get it", () => {
    const v = view!;
    overlayOpen = true;

    pressEscape(v);

    expect(overlayClosed).toBe(true);
  });
});
