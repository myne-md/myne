// tw1 — focus mode's typewriter scroll keeps the caret line pinned to the
// middle of the pane while the text scrolls under it. myne-md/myne#555, the
// `editor.view-modes` + `settings.block.focus-mode` bullets:
//
//   > the caret line stays anchored while text scrolls under it is a px
//   > assertion (caret viewport Y stays inside a band across a long typing
//   > burst), the shape `editor-scroll-slack.e2e.ts` already uses.
//
//   > after each of 30 typed lines assert the caret line's rect stays within a
//   > band around the pane centre (no drift), and that a wheel scroll
//   > mid-typing re-establishes the pin.
//
// # The walk this retires
//
// Turn on focus mode, turn on typewriter scroll, and type for a while watching
// whether the line you are writing stays where it was. That is a judgement made
// by eye about a number the DOM reports exactly, and it is the kind of thing
// that degrades gradually: a pin that drifts two pixels per line is invisible
// for the first ten and unmistakable at thirty, which is precisely the regime a
// human tester will not sit through.
//
// # Why it is worth a scenario at all
//
// `editor/src/focus-mode.ts` is fourteen lines of behaviour with four failure
// modes and a long comment explaining each. It writes `scrollDOM.scrollTop`
// directly inside CodeMirror's measure phase rather than dispatching a
// `scrollIntoView` transaction, and its own header records why: a per-keystroke
// transaction "redraws the selection (the brief flash) and races CM's own
// post-edit scroll (the 'doesn't always center / gets stuck')". Both of those
// are histories, not hypotheticals. The thing that keeps them fixed is the
// measure-phase write, and nothing outside a real editor exercises a measure
// phase.
//
// The gate is also a DOM attribute read off an ancestor
// (`data-focus-typewriter="true"`, set by EditorChrome), so it can be broken
// from a component that has nothing to do with this file.
//
// # The measurement, and the one place it does not apply
//
// Steady state: the centre of `.cm-activeLine` against the centre of the pane's
// real scroll host — the nearest ancestor of the editor with a scrolling
// `overflow-y`, resolved here exactly as `editor/src/scroll-slack.ts` resolves
// it. NOT `.cm-scroller`: in every Myne client the editor grows to fit its
// content inside an outer bounded scroller, so `.cm-scroller` has nothing to
// scroll and its `scrollTop` is permanently 0. Writing this scenario against
// `.cm-scroller` is what found the defect below, and measuring against it would
// have hidden it.
//
// A working pin puts the two centres on top of each other; the residual is
// rounding.
//
// The exception is deliberate and is in the source: the write is
// `Math.max(0, target)`. Near the TOP of a document the ideal scrollTop is
// negative, the clamp takes over, and the caret legitimately sits above centre
// — there is nothing above it to scroll. The mirror holds at the BOTTOM:
// past the last scrollable position the caret legitimately sits below centre.
// So the band is asserted only from the point where `scrollTop > 0` up to the
// point where it reaches its max, and the scenario asserts separately that
// those points were both reached and that at least one line was asserted,
// because "the clamp was active the whole time" would otherwise make every
// band assertion vacuous.
//
// BAND_FRACTION is 0.15 of the pane height rather than a pixel count. The
// failure it separates is large: with no pin, CodeMirror's default behaviour
// keeps the caret just inside the viewport, i.e. near the BOTTOM, which is
// ~0.5 of the pane away from where this asserts it. A tighter band would be
// measuring line-height rounding and window size, neither of which is the
// claim.
//
// # What writing it found: typewriter scroll had never worked
//
// The first run failed with the caret 184px BELOW the centre of a 654px pane —
// the position CodeMirror's ordinary scroll-into-view leaves it in, i.e. no pin
// at all. The probe that came with it said why in one line:
//
//     {"offset":184,"paneHeight":654,"scrollTop":358,
//      "cmScrollTop":0,"cmScrolls":false,"hostIsCm":false}
//
// The outer host had scrolled to 358. `.cm-scroller` was at 0 and had nothing
// to scroll (`scrollHeight === clientHeight`) — and `.cm-scroller` is what
// `focus-mode.ts` wrote. Assigning `scrollTop` to an element that cannot scroll
// is a silent no-op, so the feature moved nothing, on any client, ever.
//
// Two files in this repo already said the thing that makes it a no-op.
// `scroll-slack.ts` opens by explaining that CodeMirror's own `scrollPastEnd()`
// is the wrong extension here because "in Myne `.cm-scroller` never scrolls —
// the editor grows to fit its content inside an OUTER host scroller on every
// client", and it exports `resolveScrollHost` for precisely this. `PaneView.tsx`
// says it again in its own words. Neither was reachable from focus-mode.ts,
// which shipped before the first of them.
//
// Fixed here rather than filed: same branch, coupled work, and the fix is to
// call the resolver that already exists. The measurement now goes through the
// same resolver, which is why the scenario had to be written against the host
// scroller — measuring `.cm-scroller` would have reported 0 for both the
// broken and the fixed build.
//
// # Verified as a discriminator
//
// With `resolveScrollHost(view)` put back to `view.scrollDOM` — the pre-fix
// line, nothing else changed — tw1 fails at "after 21 typed lines the caret
// line sat 314px from the centre of a 654px pane" and tw2 fails on its
// precondition at 184px. Restored, both pass. MYNE_E2E_RETRIES=0.
//
// tw2's precondition is there because of that run. Its FIRST version asserted
// only that a keystroke lands the caret inside the band, and it PASSED against
// the broken binary: the caret was already outside the band before the wheel
// fired, so the "scrolled away" wait was satisfied by the pre-existing offset,
// and CodeMirror's scroll-into-view happened to land inside the band
// afterwards. A re-pin test that never establishes the pin tests nothing.
//
// # Fix round: three reds, three separate causes (myne-md/myne#555)
//
// One full-suite run plus 4 isolated repeats at MYNE_E2E_RETRIES=0: tw1 failed
// once in-suite on a single 314px read (the pre-fix signature, on a build whose
// pin holds — a sample racing the measure-phase re-centre, stretched by load),
// tw2 failed 4/4 isolated with the scroller never moving, wr1 failed 3/3
// in-suite on "matched 2 windows" and passed 3/3 isolated.
//
//   * tw2 aimed its wheel at viewport (0, 0): the window's top-left corner,
//     whatever happens to sit there. The gesture now targets the host
//     scroller's own centre, and a miss names what it hit (elementFromPoint)
//     instead of blaming the pin.
//   * tw1 sampled one frame per line. Each line now waits for the SETTLED pin
//     (5 s a line, free when healthy); a broken pin never settles and still
//     fails by name, which the revert check below re-proves after the change.
//   * wr1's window lookup assumed one display per shard; the suite shares one
//     display across all shards. Lookup is now scoped to the session's process
//     group (`support/xwindow.ts`); siblings are ignored by construction.
//
// Vault-count precondition: 1 (weak KDF generator fixture).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  notifyNoteWritten,
  dismissImporterOffer,
  runPaletteAction,
  selectedNoteId,
  unlockToEditor,
  writeNoteBody,
} from "./support/flows";
import { KEY } from "./support/keyboard";
import { type Session } from "./support/webdriver";
import { testIdSelector } from "./support/webdriver";

/** How far off the pane's vertical centre the caret line may sit, as a fraction
 *  of the pane height. See the header: the no-pin failure is ~0.5 away. */
const BAND_FRACTION = 0.15;

/** Lines typed in the burst. Enough that a per-line drift accumulates into
 *  something the band can see, and enough to push the caret well past the
 *  scrollTop clamp. */
const BURST_LINES = 80;

/** Lines pre-seeded before the burst so the document is already taller than a
 *  tall harness pane. 30 typed lines alone leave scrollTop at 0 on a large
 *  window (the A7 clamp): focus-mode's pin cannot engage while the whole
 *  document fits, so the pin is never under test. */
const PRESEED_LINES = 120;

interface Anchor {
  /** Signed px from the pane's vertical centre to the caret line's centre. */
  readonly offset: number;
  /** The pane's own height, which is what `BAND_FRACTION` is a fraction of. */
  readonly paneHeight: number;
  /** The host scroller's current scrollTop — 0 means the clamp is holding. */
  readonly scrollTop: number;
  /** Max scrollTop (scrollHeight - clientHeight) — at it the BOTTOM clamp is
   *  holding, the mirror of the top clamp: the ideal target exceeds what the
   *  host can scroll, so the caret legitimately sits below centre. */
  readonly scrollMax: number;
  /** `.cm-scroller`'s scrollTop — the element `focus-mode.ts` writes. */
  readonly cmScrollTop: number;
  /** Whether `.cm-scroller` has anything to scroll at all. */
  readonly cmScrolls: boolean;
  /** Whether the resolved host scroller IS `.cm-scroller`. */
  readonly hostIsCm: boolean;
  /** Viewport coords of the host scroller's centre — where a user scroll aimed
   *  at this pane actually lands. The wheel gesture drives these, never (0,0). */
  readonly hostCx: number;
  readonly hostCy: number;
}

/**
 * Measure the caret line against the pane it is scrolling inside.
 *
 * `null` while the editor has not rendered an active line yet, which happens
 * for a frame after a note opens and after every reflow. The caller polls, so a
 * null is "not yet" rather than a failure — but it is NOT allowed to persist:
 * `waitForAnchor` fails by name if the active line never appears, because a
 * missing `.cm-activeLine` would otherwise make the whole burst silently
 * measure nothing.
 */
async function readAnchor(s: Session): Promise<Anchor | null> {
  const raw = await s.execute<string>(
    "var root = document.querySelector('[data-testid=\"editor.content\"]');" +
      "if (!root) return '';" +
      "var cm = root.querySelector('.cm-scroller');" +
      "var line = root.querySelector('.cm-line.cm-activeLine');" +
      "if (!cm || !line) return '';" +
      // The element that actually scrolls, resolved the way `scroll-slack.ts`
      // resolves it (`resolveScrollHost`) — the nearest ancestor of the editor
      // with a scrolling overflow-y. See the header: `.cm-scroller` is NOT it in
      // any Myne client.
      "var OK = { auto: 1, scroll: 1, overlay: 1 };" +
      "var host = null;" +
      "for (var el = cm.parentElement; el && el !== document.documentElement; el = el.parentElement) {" +
      "  if (OK[getComputedStyle(el).overflowY]) { host = el; break; }" +
      "}" +
      "if (!host) host = cm;" +
      "var sr = host.getBoundingClientRect();" +
      "var lr = line.getBoundingClientRect();" +
      "return JSON.stringify({" +
      "  offset: (lr.top + lr.bottom) / 2 - (sr.top + sr.bottom) / 2," +
      "  paneHeight: sr.height," +
      "  scrollTop: host.scrollTop," +
      "  scrollMax: host.scrollHeight - host.clientHeight," +
      "  cmScrollTop: cm.scrollTop," +
      "  cmScrolls: cm.scrollHeight > cm.clientHeight + 1," +
      "  hostIsCm: host === cm," +
      "  hostCx: sr.left + sr.width / 2," +
      "  hostCy: sr.top + sr.height / 2" +
      "});",
  );
  return raw ? (JSON.parse(raw) as Anchor) : null;
}

/** `readAnchor`, polled until the editor has an active line to measure. */
async function waitForAnchor(s: Session, what: string): Promise<Anchor> {
  return await s.waitUntil(async () => await readAnchor(s), {
    label: () =>
      `${what}: the editor to render a .cm-line.cm-activeLine. Without one there ` +
      `is nothing to measure, and every band assertion in this scenario would ` +
      `pass by never running.`,
    timeoutMs: 20_000,
  });
}

/** `readAnchor`, polled until the caret line has SETTLED inside the band.
 *
 * A single read straight after a keystroke can sample the frame between
 * CodeMirror applying the edit and the typewriter measure-phase write that
 * re-centres it — under full-suite load that window is wide enough to fail a
 * strict band (measured: one 314px read on a build whose pin holds). Polling
 * for the settled state keeps the claim (the pin HOLDS, i.e. every line comes
 * to rest at the centre) while a single-frame sample tests only the scheduler.
 * A genuinely broken pin never settles and fails here by name instead. */
async function waitForPinned(s: Session, band: number, what: string): Promise<Anchor> {
  let last: Anchor | null = null;
  try {
    return await s.waitUntil(
      async () => {
        const a = await readAnchor(s);
        last = a;
        return a !== null && Math.abs(a.offset) <= band ? a : null;
      },
      {
        label: () =>
          `${what}: the caret line to settle inside the ${Math.round(band)}px centre ` +
          `band. Last settled reading: ` +
          (last === null
            ? "no active line yet"
            : `offset ${Math.round(last.offset)}px on a ${Math.round(last.paneHeight)}px ` +
              `pane at scrollTop ${Math.round(last.scrollTop)}`) +
          `. A pin that never settles is the defect; a single unsettled frame is the ` +
          `scheduler.`,
        timeoutMs: 5_000,
      },
    );
  } catch (e) {
    // Name the plugin's inputs before rethrowing: the pin needs DOM focus in
    // the editor AND the typewriter gate, and a bare timeout cannot tell "the
    // plugin is broken" from "focus left" or "the gate dropped".
    //
    // The SCROLL HOST is the third input and the one that decided
    // myne-md/myne#555, so the probe names it too: `resolveScrollHost`'s rule is
    // the nearest ancestor whose `overflow-y` scrolls, and the plugin's write is
    // a silent no-op on any element that cannot scroll. Reported BOTH ways
    // around, because the two answers are different diagnoses: the host is
    // correct and the pin did not move it, or the resolver picked an element
    // with nothing to scroll (then `.cm-scroller` and the host are the same
    // node). The rule is re-stated here rather than imported because the probe
    // runs in the PAGE, where no module of ours is loaded — and the duplication
    // is bounded to a diagnostic string.
    const diag = await s
      .execute<string>(
        "var inEd = false;" +
          "for (var el = document.activeElement; el; el = el.parentElement) {" +
          "  if (el.getAttribute && el.getAttribute('data-testid') === 'editor.content') { inEd = true; break; }" +
          "}" +
          "var gate = !!document.querySelector('[data-focus-typewriter]');" +
          "var scroller = document.querySelector('.cm-scroller');" +
          "function metrics(el) {" +
          "  if (!el) return 'absent';" +
          "  var cs = getComputedStyle(el);" +
          "  return cs.overflowY + ' scrollable=' + (el.scrollHeight > el.clientHeight) +" +
          "    ' scrollTop=' + Math.round(el.scrollTop) + ' clientH=' + Math.round(el.clientHeight) +" +
          "    ' scrollH=' + Math.round(el.scrollHeight);" +
          "}" +
          "var host = 'none';" +
          "for (var p = scroller ? scroller.parentElement : null; p && p !== document.documentElement; p = p.parentElement) {" +
          "  var oy = getComputedStyle(p).overflowY;" +
          "  if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {" +
          "    host = (p.getAttribute('data-testid') || p.className || p.tagName) + ' [' + metrics(p) + ']';" +
          "    break;" +
          "  }" +
          "}" +
          "return 'focusInEd=' + inEd + ' typewriterGate=' + gate +" +
          "  ' cm-scroller=[' + metrics(scroller) + ']' +" +
          "  ' resolvedHost=' + host;",
      )
      .catch(() => "probe failed");
    throw new Error(`${(e as Error).message}\n  pin-state: ${diag}`);
  }
}

/** What sits under viewport point (x, y): tag, id, testid and class, for the
 *  failure message when a driven gesture moves nothing. A wheel that lands on
 *  the sidebar scrolls the sidebar, and without this probe the timeout blames
 *  the pin for a gesture that never reached the pane. */
async function elementAt(s: Session, x: number, y: number): Promise<string> {
  const raw = await s.execute<string>(
    "var el = document.elementFromPoint(" +
      Math.round(x) +
      "," +
      Math.round(y) +
      ");" +
      "if (!el) return 'nothing';" +
      "var t = el.getAttribute('data-testid') || '-';" +
      "var c = (el.className && el.className.baseVal !== undefined ? '' : String(el.className || ''));" +
      "return el.tagName + '#' + (el.id || '-') + ' testid=' + t + ' class=' + c.slice(0, 120);",
  );
  return raw ?? "probe failed";
}

/** Turn focus mode on and wait for the typewriter gate the plugin reads. */
async function enterTypewriterFocus(s: Session): Promise<void> {
  await runPaletteAction(s, "view.toggle-focus", "focus");
  // The plugin's gate is `data-focus-typewriter="true"` on an editor ancestor
  // (EditorChrome = focusActive && editor_focus_typewriter, the latter
  // default-on). Waiting for the ATTRIBUTE rather than for focus mode means a
  // scenario cannot proceed against a build where the two came apart — which is
  // the coupling `focus-mode.ts` depends on and does not own.
  await s.waitUntil(
    async () => ((await s.findElements('[data-focus-typewriter="true"]')).length > 0 ? true : null),
    {
      label:
        "the editor to carry data-focus-typewriter=true — the DOM gate " +
        "focus-mode.ts reads on every update. Focus mode being on is not the " +
        "same fact, and the plugin is inert without this one.",
      timeoutMs: 15_000,
    },
  );
}


/** Pre-seed enough lines that the document is already taller than a tall
 *  harness pane, so the burst starts PAST the top clamp and the pin is under
 *  test from the first keystroke. IPC write + reload (page-seat discipline). */
async function preseedLines(s: Session, noteId: string, n: number): Promise<void> {
  const body = [
    "# Typewriter",
    ...Array.from({ length: n }, (_, i) => `preseed ${i}`),
    "first line",
  ].join("\n");
  const r = await writeNoteBody(s, noteId, body, 15_000);
  expect(r.err, "the preseed write should succeed").toBeUndefined();
  await notifyNoteWritten(s, noteId);
}


describeE2E("tw2 scrolling away and typing re-establishes the pin (myne-md/myne#555)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("re-centres the caret line after the pane is scrolled away from it", async () => {
    let password = "";
    await scenario(
      "tw2-typewriter-repin",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Repin");
        const id2 = await selectedNoteId(s);
        await preseedLines(s, id2, PRESEED_LINES);
        await s.execute<void>(
          "var e = document.querySelector('[data-testid=\"notes.row\"][data-note-id=" +
            JSON.stringify(id2) +
            "]'); if (e) e.click();",
        );
        await enterTypewriterFocus(s);
        const content = await s.findElement(testIdSelector("editor.content") + " .cm-content");

        // Get well past the clamp so "scrolled away" and "at the top" are
        // distinguishable.
        for (let i = 0; i < BURST_LINES; i += 1) {
          await content.sendKeys(`${KEY.ENTER}line ${i} before the scroll`);
        }
        // Settled, not sampled: a single read here can catch the frame between
        // the last edit and its re-centre, which under full-suite load fails
        // the precondition on a working pin.
        const first = await waitForAnchor(s, "before scrolling away");
        const band = first.paneHeight * BAND_FRACTION;
        const pinned = await waitForPinned(s, band, "before scrolling away");
        expect(
          pinned.scrollTop,
          "the pane never scrolled, so scrolling it AWAY cannot be distinguished " +
            "from the top-of-document clamp",
        ).toBeGreaterThan(0);

        // PRECONDITION, and it is what makes the rest of this test mean
        // something. The first version of tw2 asserted only "after a keystroke
        // the caret is inside the band", and it PASSED against the pre-fix
        // binary — because the caret was already 184px outside the band before
        // the wheel ever fired, so the wait for "scrolled away" was satisfied by
        // that pre-existing offset rather than by the wheel, and CodeMirror's
        // own scroll-into-view happened to land inside the band afterwards. A
        // re-pin test that never establishes the pin is not testing a re-pin.
        // `pinned` above already IS that proof: `waitForPinned` resolves only
        // inside the band, so a second band assertion here would pass by
        // construction rather than by measurement.

        // Scroll the pane away from the caret. Driven as a real wheel gesture
        // through the W3C Actions API rather than by writing `scrollTop`: the
        // claim is about what happens after a USER scroll, and a scripted
        // scrollTop write skips the browser's own scroll handling, which is the
        // half most likely to fight the plugin.
        //
        // Aimed at the host scroller's own centre, never at the viewport origin:
        // a wheel lands on whatever is under its coordinates, and (0, 0) is the
        // top-left corner of the window — sidebar, titlebar, or nothing that
        // scrolls — so the gesture can be accepted and move nothing while the
        // timeout blames the pin (measured 4/4 isolated on myne-md/myne#555).
        // A user scrolls over the pane they are reading; so does this.
        //
        // Driven TWICE at most, and the second gesture goes out only when the
        // first demonstrably moved nothing: the driver also drops an
        // acknowledged wheel once in a while (measured: centred aim, scroller
        // unmoved for the full budget), and a single fire-and-hope has the
        // same shape as the (0, 0) defect above. The movement assertion is
        // what makes the retry safe rather than hopeful.
        const wheelX = Math.round(pinned.hostCx);
        const wheelY = Math.round(pinned.hostCy);
        async function driveWheel(): Promise<void> {
          await s.send("POST", "/actions", {
            actions: [
              {
                type: "wheel",
                id: "wheel",
                actions: [
                  {
                    type: "scroll",
                    x: wheelX,
                    y: wheelY,
                    deltaX: 0,
                    deltaY: -Math.round(pinned.paneHeight),
                    duration: 100,
                    origin: "viewport",
                  },
                ],
              },
            ],
          });
        }

        async function waitScrolledAway(): Promise<Anchor> {
          return await s.waitUntil(
            async () => {
              const a = await readAnchor(s);
              // BOTH conditions. The offset alone is the vacuous one — see the
              // precondition above. Requiring the scroller to have actually MOVED
              // is what proves the wheel gesture reached the pane at all, rather
              // than the driver silently accepting an input source it does not
              // implement.
              return a !== null && a.scrollTop !== pinned.scrollTop && Math.abs(a.offset) > band
                ? a
                : null;
            },
            {
              label: () =>
                `the wheel gesture to move the pane (scrollTop away from ` +
                `${Math.round(pinned.scrollTop)}) and carry the caret line out of the ` +
                `${Math.round(band)}px centre band. If the scroller does not move, the ` +
                `driver accepted a wheel action it did not perform; if it moves and the ` +
                `caret stays centred, the re-pin below proves nothing.`,
              timeoutMs: 15_000,
            },
          );
        }

        let scrolledAway: Anchor;
        await driveWheel();
        try {
          scrolledAway = await waitScrolledAway();
        } catch {
          // First gesture demonstrably moved nothing — drive once more before
          // calling it. Anything else (a move without the caret leaving, a
          // partial move) is a product observation, not a dropped gesture,
          // and goes straight to the diagnosis below.
          const still = await readAnchor(s).catch(() => null);
          if (still !== null && still.scrollTop !== pinned.scrollTop) throw new Error(
            `the pane moved without carrying the caret out of the band — not a ` +
              `dropped gesture, not the subject of a retry.`,
          );
          await driveWheel();
          try {
            scrolledAway = await waitScrolledAway();
          } catch (e) {
            // Name what the gesture hit before rethrowing: without this the
            // timeout reads as a broken pin when the wheel never reached the pane.
            const under = await elementAt(s, wheelX, wheelY).catch(() => "probe failed");
            const now = await readAnchor(s).catch(() => null);
            throw new Error(
              `${(e as Error).message}\n  wheel-target diagnosis: aimed at (${wheelX}, ${wheelY}), ` +
                `under it: ${under}; host scrollTop now ` +
                (now === null ? "unreadable" : String(Math.round(now.scrollTop))) +
                ` (was ${Math.round(pinned.scrollTop)}).`,
            );
          }
        }

        // One keystroke. The plugin re-pins on the next selection/doc change,
        // and this is the whole behaviour: the user scrolls back to read
        // something, types, and lands where they were writing.
        await content.sendKeys("x");

        const repinned = await s.waitUntil(
          async () => {
            const a = await readAnchor(s);
            return a !== null && Math.abs(a.offset) <= band ? a : null;
          },
          {
            label: () =>
              `one keystroke to pull the caret line back inside the ${Math.round(band)}px ` +
              `centre band after the pane was scrolled ${Math.round(scrolledAway.offset)}px ` +
              `away from it. Without the re-pin the user types into a line they cannot ` +
              `see, which is worse than no typewriter mode at all.`,
            timeoutMs: 15_000,
          },
        );

        expect(Math.abs(repinned.offset)).toBeLessThanOrEqual(band);
      },
    );
  });
});
