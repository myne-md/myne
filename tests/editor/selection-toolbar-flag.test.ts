// @vitest-environment jsdom
//
// `selectionToolbar` opt-out (MYND-559). The shared engine mounts a floating
// toolbar over a text selection — desktop's formatting surface. Mobile drives
// formatting from its own above-keyboard FormatBar (via `onReady`), so it needs
// the floating one GONE rather than CSS-hidden: a hidden plugin still mounts,
// still listens on `mouseup`, and still does measure work every selection.
//
// Two things are pinned here, and the DEFAULT is the load-bearing half — the
// shared engine is consumed by desktop, so a regression that flips the default
// silently removes desktop's formatting surface:
//   1. default / explicit-true  → a selection surfaces `.cm-toolbar`
//   2. explicit false           → no toolbar node ever appears
//
// The extension stack is mounted through the real `myneExtensions` (not a
// hand-picked subset), so the assertions run against the same composition the
// clients get. jsdom has no layout, so `coordsAtPos` is stubbed exactly as the
// spell-menu DOM spec does; the toolbar's show path is rAF-deferred, so each
// case flushes timers + frames before asserting.

import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { myneExtensions } from "@myne/editor/extensions";

const DOC = "The quick brown fox.";

type Mounted = { view: EditorView; host: HTMLElement };

let mounted: Mounted | null = null;

function mount(selectionToolbar?: boolean): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      // `selectionToolbar` omitted entirely when undefined — that case must
      // exercise the DEFAULT, not `selectionToolbar: undefined` normalizing to
      // something else.
      extensions: [
        ...(selectionToolbar === undefined
          ? myneExtensions()
          : myneExtensions({ selectionToolbar })),
      ],
    }),
    parent: host,
  });
  // jsdom has no layout — the toolbar positions via coordsAtPos and bails (with
  // a bounded retry) while it returns null. Stub it so the show path completes.
  view.coordsAtPos = () => ({ left: 5, right: 60, top: 5, bottom: 20 });
  return { view, host };
}

const toolbarEl = () => document.body.querySelector(".cm-toolbar");

/** Select "quick" — the gesture that asks the toolbar to show. */
function selectWord(view: EditorView): void {
  const from = DOC.indexOf("quick");
  view.dispatch({ selection: { anchor: from, head: from + "quick".length } });
}

/** The show path is rAF-deferred and re-tries across frames until `coordsAtPos`
 *  resolves, so neither polarity can be asserted after a fixed tick count — that
 *  reads as a flake. Poll to a deadline for the positive case; burn the whole
 *  budget for the negative one, so "absent" means absent-after-settling. */
const SETTLE_MS = 600;

async function waitForToolbar(): Promise<Element | null> {
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    const el = toolbarEl();
    if (el !== null) return el;
    await new Promise((r) => setTimeout(r, 16));
  }
  return null;
}

async function settle(): Promise<void> {
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) await new Promise((r) => setTimeout(r, 16));
}

afterEach(() => {
  if (mounted !== null) {
    mounted.view.destroy();
    mounted.host.remove();
    mounted = null;
  }
  // The toolbar is body-mounted, outside the view's own DOM — clear any leak so
  // one case can't satisfy the next case's assertion.
  document.body.querySelector(".cm-toolbar")?.remove();
  vi.restoreAllMocks();
});

describe("myneExtensions selectionToolbar flag", () => {
  it("defaults ON — a selection surfaces the floating toolbar (desktop)", async () => {
    mounted = mount();
    selectWord(mounted.view);
    expect(await waitForToolbar()).not.toBeNull();
  });

  it("explicit true behaves like the default", async () => {
    mounted = mount(true);
    selectWord(mounted.view);
    expect(await waitForToolbar()).not.toBeNull();
  });

  it("false mounts no toolbar at all — a selection surfaces nothing (mobile)", async () => {
    mounted = mount(false);
    selectWord(mounted.view);
    await settle();
    expect(toolbarEl()).toBeNull();
  });

  it("false drops exactly the toolbar — the rest of the stack is untouched", () => {
    // Guards the flag against becoming a broader kill-switch: turning it off may
    // remove ONE top-level entry (the toolbar ViewPlugin) and nothing else.
    expect(myneExtensions({ selectionToolbar: false })).toHaveLength(
      myneExtensions({ selectionToolbar: true }).length - 1,
    );
  });
});
