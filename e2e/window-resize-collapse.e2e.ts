// wr1 — narrowing the window collapses the sidebars at the thresholds the
// layout says it should, and widening restores both at their original widths.
// myne-md/myne#555, the `editor.view-modes` bullet:
//
//   > collapse breakpoints, overlap/clipping and geometry restore after a
//   > restart are measurable: WebDriver Set Window Rect drives the toplevel,
//   > xvfb's screen size is a launch parameter, and `GDK_SCALE=2` gives a real
//   > HiDPI seat.
//
// # The walk this retires
//
// Drag the window narrow, watch the sidebars go, drag it wide, watch them come
// back. Three states and two boundaries, judged by eye, on a window somebody has
// to drag slowly enough to see where each one flips. The interesting half is the
// return trip: the override is TRANSIENT and must not have eaten the user's own
// layout on the way through.
//
// # `Set Window Rect` is a silent no-op on this driver
//
// The bullet names it and it does not work. WebKitWebDriver answers 200 with the
// window's UNCHANGED rect — measured: asked 800, granted 1100,
// `window.innerWidth` 1100, on a 1280x1024 screen, so neither stale geometry nor
// a ceiling. The window is driven with `xdotool windowsize` instead;
// `support/xwindow.ts` carries the full measurement and why the absence of a
// window manager makes X the right layer. `Session.setWindowRect` stays on the
// Session as correct W3C, but nothing in this suite may depend on it.
//
// # What this seat can reach that a user cannot
//
// `src-tauri/tauri.conf.json` sets `minWidth: 880`, and a real desktop is
// floored there by the window manager. Under xvfb there is no window manager to
// enforce a size hint, so `xdotool windowsize` goes straight through: 560px was
// granted and the page agreed. That is a harness capability, not a claim about
// the product, and it matters in both directions —
//
//   * the `forceLeftCollapsed` branch below 628px is UNREACHABLE for a desktop
//     user (880 > 628), so a tester handed "narrow until both sidebars collapse"
//     cannot do it, which is the kind of step that gets marked pass because the
//     first half happened;
//   * it is entirely reachable on the WEB client, which runs this exact
//     `src/screens/` code in a browser window with no floor. The branch is live
//     product behaviour, just not on this client.
//
// So the sweep covers all three states, and the header says which of them a
// desktop user can actually see.
//
// # The thresholds, and why they are BRACKETED
//
// `computeResponsiveCollapse(rowWidth, 260, 280)` with the shipped constants
// (`CENTER_MIN_WIDTH` 360, `RESIZE_HANDLE_HIT_ZONE` 8):
//
//   rowWidth >= 916  ->  neither collapsed   (260 + 280 + 2*8 + 360)
//   rowWidth >= 628  ->  right only          (260 + 8 + 360)
//   otherwise        ->  both
//
// Each boundary is asserted from BOTH sides — 920 against 900, and 640 against
// 620 — rather than by sampling one width per state. One point per state passes
// for any threshold anywhere in the gap, which is most of the useful range; a
// bracket pins the boundary to within 20px and fails on a drift that a
// per-state sample would not notice. Measured on this seat, and the numbers land
// exactly where the arithmetic says:
//
//   1100 1000 950 920 -> 260/280      900 880 800 700 640 -> 260/0
//   620 560 -> 0/0                    back to 1100 -> 260/280
//
// # Why this is not the unit test one layer up
//
// `computeResponsiveCollapse` is a pure function of three numbers and
// `tests/screens/responsiveCollapse.test.ts` pins it thoroughly. What no unit
// test can reach is whether that function is ever CALLED with a width the window
// actually has: the hook is `ResizeObserver` glue, the observer is attached in
// an effect keyed on a ref, and the panes are rendered elsewhere.
//
// That gap is not hypothetical. `src/components/settings/settingsCompact.ts` is
// the same shape — pure decision, tested; `ResizeObserver` glue, untested — and
// its observer was never attached at all, so the Settings responsive restack had
// never fired at any window size since it shipped (myne-md/myne#555, found by
// the browser-lane scenario that could resize a real window). Both modules
// carried a sentence explaining why a resize could not be driven from a test.
//
// # What is measured
//
// The WIDTH of each sidebar pane's box, settled — held still across consecutive
// polls, not merely past a threshold. `SidebarPane` transitions the width
// between 0 and its open value, and a first pass at this scenario read
// mid-animation and compared 211px against the 260px it had recorded. A
// coarser probe on the same run reported the right pane at 235px and then 138px
// as the window narrowed, which reads exactly like a flex-shrink defect and is
// nothing but the same transition sampled early. Every number here is stable
// across four consecutive reads.
//
// The panes are measured, not asked. Reading a `collapsed` attribute would let
// the app report on itself, and the failure class is precisely a decision that
// is computed correctly and never reaches the DOM.
//
// Not asserted: HiDPI (`GDK_SCALE=2`) and geometry-restore-after-restart, both
// named in the bullet. `GDK_SCALE` changes device-pixel ratio rather than CSS
// pixels, so it moves no threshold here and is a different claim. Window
// geometry across a restart is not persisted by this app at all, which is a
// product question rather than a regression.
//
// Vault-count precondition: 1 (weak KDF generator fixture).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { createNote, dismissImporterOffer, unlockToEditor } from "./support/flows";
import { type Session } from "./support/webdriver";
import { resizeAppWindow } from "./support/xwindow";

/** Height held constant across the sweep: only width drives the decision, and a
 *  changing height would put a second variable into every measurement. */
const WINDOW_HEIGHT_PX = 720;
/** How far the achieved width may sit from the requested one. */
const WIDTH_TOLERANCE_PX = 8;

/** A pane counts as collapsed when its box has no width. */
const COLLAPSED_MAX_PX = 4;
/** An open sidebar is at least this wide (`LEFT_BOUNDS.min` is 200 and
 *  `RIGHT_BOUNDS.min` is 240). Deliberately not the assertion on its own — see
 *  `settle`. */
const OPEN_MIN_PX = 120;

type PaneState = "open" | "collapsed";

/** One step of the sweep. `why` is quoted verbatim in the failure message, so it
 *  says which threshold the step is standing on rather than restating the
 *  measurement the message already carries. */
interface Step {
  readonly width: number;
  readonly left: PaneState;
  readonly right: PaneState;
  readonly why: string;
}

const SWEEP: readonly Step[] = [
  {
    width: 1100,
    left: "open",
    right: "open",
    why: "the shipped default window width, well above the 916px both-fit threshold",
  },
  {
    width: 920,
    left: "open",
    right: "open",
    why: "4px ABOVE the 916px both-fit threshold — the last width at which the backlinks panel survives",
  },
  {
    width: 900,
    left: "open",
    right: "collapsed",
    why:
      "16px BELOW the 916px threshold. The right side goes and the left stays, which is the " +
      "product decision the two-stage threshold exists to express: when room runs out the notes " +
      "list outranks the backlinks panel",
  },
  {
    width: 640,
    left: "open",
    right: "collapsed",
    why: "12px ABOVE the 628px left-collapse threshold — the notes list is still there",
  },
  {
    width: 620,
    left: "collapsed",
    right: "collapsed",
    why:
      "8px BELOW the 628px threshold, so both go and the editor takes the whole row. A desktop " +
      "user cannot reach this (tauri.conf.json minWidth is 880); a web user can, on this same code",
  },
  {
    width: 1100,
    left: "open",
    right: "open",
    why:
      "back where the sweep started. responsiveCollapse.ts says the override 'never persists and " +
      "never touches the user's manual collapse preference', so both sides must come back — and " +
      "at the widths they had, which the assertion after the sweep checks",
  },
];

interface Widths {
  readonly left: number;
  readonly right: number;
}

async function paneWidths(s: Session): Promise<Widths | null> {
  const raw = await s.execute<string>(
    "var l = document.querySelector('[data-testid=\"editor.sidebar-left\"]');" +
      "var r = document.querySelector('[data-testid=\"editor.sidebar-right\"]');" +
      "if (!l || !r) return '';" +
      "return JSON.stringify({" +
      "  left: l.getBoundingClientRect().width," +
      "  right: r.getBoundingClientRect().width" +
      "});",
  );
  return raw ? (JSON.parse(raw) as Widths) : null;
}

/**
 * Resize the toplevel window and wait for both panes to reach the wanted states
 * AND hold still.
 *
 * Two things are checked separately and fail with different messages, because
 * "the window did not resize" and "the layout ignored the resize" are different
 * defects that a single timeout would merge. The window width is read from the
 * PAGE rather than from the resize call: xdotool exits 0 whether or not the
 * server's configure was honoured, and the whole reason this file uses xdotool
 * is that the WebDriver primitive reported success while doing nothing.
 *
 * The pane stability requirement is the other half. `SidebarPane` transitions
 * the width between 0 and its open value, so "wider than OPEN_MIN_PX" is true
 * partway through an expand; requiring the same pair twice in a row costs one
 * poll and removes that whole class of false reading.
 */
async function step(s: Session, spec: Step, driverPid: number | undefined): Promise<Widths> {
  let innerWidth = -1;
  let attempts = 0;
  await s.waitUntil(
    async () => {
      // RE-ISSUED each poll, not sent once. GTK re-asserts its own minimum-size
      // hint (`tauri.conf.json` minWidth: 880) against the first configure that
      // crosses it, so a single jump from 900px to 640px lands at 880px; the
      // request goes through on a subsequent attempt. Measured both ways on this
      // seat: a sweep descending in small steps reached 560px, and the identical
      // target requested in one jump reported 880px.
      attempts += 1;
      resizeAppWindow(spec.width, WINDOW_HEIGHT_PX, driverPid);
      const next = (await s.execute<number>("return window.innerWidth;")) ?? -1;
      innerWidth = next;
      return Math.abs(next - spec.width) <= WIDTH_TOLERANCE_PX ? true : null;
    },
    {
      label: () =>
        `the window to reach ${spec.width}px after ${attempts} configure(s) — ` +
        `window.innerWidth is ${innerWidth}. Under xvfb there is no window manager, ` +
        `so a width that never arrives is GTK holding its own geometry hint against ` +
        `the X server, not an arbitration. Nothing about the layout is under test ` +
        `until this holds.`,
      timeoutMs: 15_000,
    },
  );

  const ok = (w: number, state: PaneState): boolean =>
    state === "collapsed" ? w <= COLLAPSED_MAX_PX : w >= OPEN_MIN_PX;

  let seen: Widths | null = null;
  let prev: Widths | null = null;
  return await s.waitUntil(
    async () => {
      prev = seen;
      seen = await paneWidths(s);
      if (seen === null || !ok(seen.left, spec.left) || !ok(seen.right, spec.right)) {
        return null;
      }
      return prev !== null &&
        Math.round(prev.left) === Math.round(seen.left) &&
        Math.round(prev.right) === Math.round(seen.right)
        ? seen
        : null;
    },
    {
      label: () =>
        `at ${spec.width}px: left=${spec.left} right=${spec.right}, because ${spec.why}. ` +
        `Measured left=${seen === null ? "no pane" : Math.round(seen.left)}px ` +
        `right=${seen === null ? "no pane" : Math.round(seen.right)}px. The window ` +
        `width was confirmed from the page first, so this is the layout not ` +
        `responding to the resize: the responsive-collapse ResizeObserver never ` +
        `attached, or the decision it computes never reaches the panes.`,
      timeoutMs: 15_000,
    },
  );
}

describeE2E("wr1 window width collapses the sidebars at the layout's thresholds (myne-md/myne#555)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("brackets both breakpoints and restores the original widths on the way out", async () => {
    let password = "";
    await scenario(
      "wr1-window-resize-collapse",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        // Both panes are measured; `editor.sidebar-right` mounts only while a
        // NOTE tab is focused (`Editor.tsx`). A vault with no notes leaves the
        // right side absent, and `paneWidths` then reports "no pane" forever.
        await createNote(s, "wr1-note");

        const measured: Widths[] = [];
        for (const spec of SWEEP) {
          measured.push(await step(s, spec, app.driverPid));
        }

        // The first and last steps are the same window width, so the widths have
        // to match EXACTLY — not merely both be non-zero. A sidebar that comes
        // back at a different width has written through to the persisted layout
        // on its way past, which is the one thing `responsiveCollapse.ts`
        // promises the transient override never does.
        const before = measured[0]!;
        const after = measured[measured.length - 1]!;
        expect(
          Math.round(after.left),
          `the left sidebar came back at ${Math.round(after.left)}px having been ` +
            `${Math.round(before.left)}px at the same window width before the sweep. ` +
            `The forced collapse is documented as transient and as never touching the ` +
            `user's own width.`,
        ).toBe(Math.round(before.left));
        expect(
          Math.round(after.right),
          `the right sidebar came back at ${Math.round(after.right)}px having been ` +
            `${Math.round(before.right)}px before. Same reason as the left, and this ` +
            `is the side that spent the most of the sweep collapsed, so it is the one ` +
            `most likely to have lost its width.`,
        ).toBe(Math.round(before.right));
      },
    );
  });
});
