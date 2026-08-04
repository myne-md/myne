// @vitest-environment jsdom
//
// myne#330 — one view's `reconfigureVim` must not cancel another's.
//
// The generation counter was module-global, so any second call from a DIFFERENT
// view superseded a pending enable. The losing view's compartment was never
// reconfigured: no modal editing, no `data-vim-mode` attribute, and therefore no
// bottom-bar mode indicator — silently, because the guard returns rather than
// throwing and the `[vimMode]` effect never re-fires (the prop does not change
// again). The user types into what looks like a vim editor and is not one, with
// `dd`/`x` inserted as literal text.
//
// The deterministic path needs no import-timing luck: a pane in source mode with
// its read-only preview companion mounts BOTH editors in one commit — the
// primary awaits the dynamic import while the companion, which has no `vimMode`
// prop, runs the synchronous OFF branch and bumps the counter. The primary was
// therefore always dropped.

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

function noteState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [vimExtension()] });
}

function vimIsLive(view: EditorView): boolean {
  return (vimApi()?.getCM(view) ?? null) !== null;
}

describe("two views reconfiguring vim", () => {
  let primary: EditorView | null = null;
  let companion: EditorView | null = null;
  let host: HTMLElement | null = null;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    primary = new EditorView({ state: noteState("primary"), parent: host });
    companion = new EditorView({ state: noteState("companion"), parent: host });
  });

  afterEach(() => {
    for (const v of [primary, companion]) {
      if (v !== null) {
        resetVimGenerationForTests(v);
        v.destroy();
      }
    }
    primary = null;
    companion = null;
    host?.remove();
    host = null;
  });

  it("the companion's synchronous OFF does not cancel the primary's enable", async () => {
    // The exact mount order of a source-mode pane with its preview companion:
    // the primary starts its enable, the companion immediately turns vim off.
    const enabling = reconfigureVim(primary!, true);
    await reconfigureVim(companion!, false);
    await enabling;

    expect(vimIsLive(primary!)).toBe(true);
    expect(primary!.dom.getAttribute(VIM_MODE_ATTR)).toBe("normal");
    // …and the companion really is off.
    expect(vimIsLive(companion!)).toBe(false);
  });

  it("two panes enabling concurrently both end up modal", async () => {
    await Promise.all([reconfigureVim(primary!, true), reconfigureVim(companion!, true)]);
    expect(vimIsLive(primary!)).toBe(true);
    expect(vimIsLive(companion!)).toBe(true);
  });

  it("a view's OWN later call still supersedes its earlier one", async () => {
    // The property the counter exists for, which must survive being per view:
    // an interleaved on→off on the SAME view settles as off.
    const enabling = reconfigureVim(primary!, true);
    await reconfigureVim(primary!, false);
    await enabling;
    expect(vimIsLive(primary!)).toBe(false);
    expect(primary!.dom.getAttribute(VIM_MODE_ATTR)).toBeNull();
  });
});
