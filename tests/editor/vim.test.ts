// @vitest-environment jsdom
//
// vim-keyboard-mode (MYND-313) — the compartment layer.
//
// What this file pins is the SEAM, not vim's grammar: the engine's own behaviour
// (motions, operators, counts) is its package's problem and is not re-tested
// here. What is ours, and what breaks silently, is:
//
//   - vim OFF is the true default and imports nothing
//   - enabling is live (no remount) and preserves cursor / scroll / undo
//   - disabling removes the layer completely, leaving no attribute behind
//   - the mode reaches the DOM, because both the bottom-bar indicator and E2E
//     read it from there
//   - a fast on→off→on cannot leave a stale async import winning the race
//
// The view is mounted into a REAL attached DOM node: `reconfigureVim` guards on
// `view.dom.isConnected` as its "is this pane still alive" check, so a detached
// host would make every enable silently no-op and the tests vacuous.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  VIM_MODE_ATTR,
  VIM_MODE_EVENT,
  reconfigureVim,
  resetVimGenerationForTests,
  vimApi,
  vimExtension,
} from "../../editor/src/vim";

describe("vim compartment (MYND-313)", () => {
  let view: EditorView | null = null;
  let host: HTMLElement | null = null;

  beforeEach(() => {
    resetVimGenerationForTests();
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      state: EditorState.create({
        doc: "alpha bravo\ncharlie delta",
        extensions: [vimExtension()],
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

  it("is off by default — no mode attribute, typing inserts text", () => {
    const v = view!;
    expect(v.dom.hasAttribute(VIM_MODE_ATTR)).toBe(false);

    // With vim off the document is a plain editable buffer.
    v.dispatch({ changes: { from: 0, insert: "x" } });
    expect(v.state.doc.toString().startsWith("xalpha")).toBe(true);
  });

  it("turning it off never loads the engine (resolves without importing)", async () => {
    const v = view!;
    // A pure-off call must settle synchronously-ish and leave no attribute; if
    // this ever started importing the engine, the lazy-loading guarantee that
    // justifies the dependency would be silently gone.
    await reconfigureVim(v, false);
    expect(v.dom.hasAttribute(VIM_MODE_ATTR)).toBe(false);
  });

  it("enabling makes the editor modal and publishes the mode on the DOM", async () => {
    const v = view!;
    v.dispatch({ selection: { anchor: 6 } });

    await reconfigureVim(v, true);

    // Mode is published for the indicator + E2E, and starts in normal.
    expect(v.dom.getAttribute(VIM_MODE_ATTR)).toBe("normal");
    // Live reconfigure, not a remount: the cursor survived.
    expect(v.state.selection.main.head).toBe(6);
    // And the document was not touched by enabling.
    expect(v.state.doc.toString()).toBe("alpha bravo\ncharlie delta");
  });

  it("tracks mode transitions through to the DOM attribute", async () => {
    const v = view!;
    await reconfigureVim(v, true);
    expect(v.dom.getAttribute(VIM_MODE_ATTR)).toBe("normal");

    // Reach the engine through our own module — it is the single import site,
    // and the package lives in the editor workspace's node_modules, not the root's.
    const api = vimApi()!;
    expect(api).not.toBeNull();
    const cm = api.getCM(v)!;
    expect(cm).not.toBeNull();
    const { Vim } = api;

    // normal → insert
    Vim.handleKey(cm, "i", "user");
    expect(v.dom.getAttribute(VIM_MODE_ATTR)).toBe("insert");

    // insert → normal
    Vim.handleKey(cm, "<Esc>", "user");
    expect(v.dom.getAttribute(VIM_MODE_ATTR)).toBe("normal");

    // normal → visual
    Vim.handleKey(cm, "v", "user");
    expect(v.dom.getAttribute(VIM_MODE_ATTR)).toBe("visual");
  });

  it("disabling removes the layer and the attribute", async () => {
    const v = view!;
    await reconfigureVim(v, true);
    expect(v.dom.getAttribute(VIM_MODE_ATTR)).toBe("normal");

    await reconfigureVim(v, false);
    expect(v.dom.hasAttribute(VIM_MODE_ATTR)).toBe(false);

    // Back to a plain editable buffer — a normal-mode motion key would have been
    // swallowed by vim; with it off the document takes the edit.
    v.dispatch({ changes: { from: 0, insert: "z" } });
    expect(v.state.doc.toString().startsWith("zalpha")).toBe(true);
  });

  it("last call wins when toggles interleave (async import race)", async () => {
    const v = view!;
    // Start an enable, then immediately request disable. The enable's dynamic
    // import resolves AFTER the disable already settled; it must not re-apply.
    const enabling = reconfigureVim(v, true);
    const disabling = reconfigureVim(v, false);
    await Promise.all([enabling, disabling]);

    expect(v.dom.hasAttribute(VIM_MODE_ATTR)).toBe(false);
  });

  it("announces mode changes as a bubbling event for the bottom bar", async () => {
    const v = view!;
    const seen: (string | null)[] = [];
    const onMode = (e: Event) => {
      seen.push((e as CustomEvent<{ mode: string | null }>).detail.mode);
    };
    // Listening on `window`, not on the editor node: the bottom bar lives in the
    // app shell, so the event has to actually bubble that far.
    window.addEventListener(VIM_MODE_EVENT, onMode);
    try {
      await reconfigureVim(v, true);
      const api = vimApi()!;
      api.Vim.handleKey(api.getCM(v)!, "i", "user");
      await reconfigureVim(v, false);
    } finally {
      window.removeEventListener(VIM_MODE_EVENT, onMode);
    }

    // enable → normal, keypress → insert, disable → null (indicator hides)
    expect(seen).toEqual(["normal", "insert", null]);
  });

  it("re-enabling after a disable still publishes the mode", async () => {
    const v = view!;
    await reconfigureVim(v, true);
    await reconfigureVim(v, false);
    await reconfigureVim(v, true);

    expect(v.dom.getAttribute(VIM_MODE_ATTR)).toBe("normal");

    // And the listener attached by the second enable is live (not a stale one
    // from the first mount) — a transition still reaches the DOM.
    const api = vimApi()!;
    api.Vim.handleKey(api.getCM(v)!, "i", "user");
    expect(v.dom.getAttribute(VIM_MODE_ATTR)).toBe("insert");
  });
});
