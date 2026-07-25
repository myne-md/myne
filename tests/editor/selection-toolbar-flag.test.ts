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

// The show path is rAF-deferred and re-tries across frames until `coordsAtPos`
// resolves, so neither polarity can be asserted after a fixed tick count. The two
// directions need different treatment, because only one of them can be waited out:

/** Wait for the toolbar to appear. Deliberately NOT a hand-rolled `Date.now()`
 *  deadline: a private wall-clock budget makes a real pass look like a flake the
 *  moment the machine is busy (this file runs in the lefthook pre-push gate and in
 *  CI alongside other steps, and a 600ms budget measurably failed ~1-in-3 under a
 *  parallel vitest process). `expect.poll` retries until VITEST's own test timeout,
 *  so a loaded box gets slower, not red — and a genuine regression still fails,
 *  just later. This assertion guards the DEFAULT, which is the half desktop
 *  depends on, so it must never cry wolf. */
async function expectToolbarShown(): Promise<void> {
  await expect.poll(() => toolbarEl() !== null, { interval: 16 }).toBe(true);
}

/** Negative-case budget. Absence cannot be polled for — there is no event to wait
 *  on — so this burns a fixed budget and then asserts. It is safe to keep tight,
 *  and safe against a slow machine, for a structural reason rather than a timing
 *  one: with the flag off the plugin is never constructed (pinned by the
 *  extension-count case below), so no amount of extra waiting could produce a
 *  toolbar. The budget only has to outlast the plugin's own retry ceiling — 4
 *  attempts one rAF apart (`toolbar/plugin.ts` `coordsRetries`) — which 200ms
 *  clears many times over. */
const ABSENT_SETTLE_MS = 200;

async function settle(): Promise<void> {
  const deadline = Date.now() + ABSENT_SETTLE_MS;
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
    await expectToolbarShown();
  });

  it("explicit true behaves like the default", async () => {
    mounted = mount(true);
    selectWord(mounted.view);
    await expectToolbarShown();
  });

  it("false mounts no toolbar at all — a selection surfaces nothing (mobile)", async () => {
    mounted = mount(false);
    selectWord(mounted.view);
    await settle();
    expect(toolbarEl()).toBeNull();
  });

  it("false drops exactly the toolbar — the rest of the stack is untouched", () => {
    // Guards against the flag becoming a BROADER kill-switch — if it ever removed
    // more than one entry, this fails. It deliberately does not claim more than
    // that: it cannot tell WHICH entry went (the DOM cases above do) and it cannot
    // see a reorder. Relative between two calls, so future extensions don't break it.
    expect(myneExtensions({ selectionToolbar: false })).toHaveLength(
      myneExtensions({ selectionToolbar: true }).length - 1,
    );
  });
});
