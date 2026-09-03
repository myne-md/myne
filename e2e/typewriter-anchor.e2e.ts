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
// — there is nothing above it to scroll. So the band is asserted only from the
// point where `scrollTop > 0`, and the scenario asserts separately that that
// point was reached, because "the clamp was active the whole time" would
// otherwise make every band assertion vacuous.
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
// Vault-count precondition: 1 (weak KDF generator fixture).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  runPaletteAction,
  typeIntoEditor,
  unlockToEditor,
} from "./support/flows";
import { KEY } from "./support/keyboard";
import { type Session } from "./support/webdriver";

/** How far off the pane's vertical centre the caret line may sit, as a fraction
 *  of the pane height. See the header: the no-pin failure is ~0.5 away. */
const BAND_FRACTION = 0.15;

/** Lines typed in the burst. Enough that a per-line drift accumulates into
 *  something the band can see, and enough to push the caret well past the
 *  scrollTop clamp. */
const BURST_LINES = 30;

interface Anchor {
  /** Signed px from the pane's vertical centre to the caret line's centre. */
  readonly offset: number;
  /** The pane's own height, which is what `BAND_FRACTION` is a fraction of. */
  readonly paneHeight: number;
  /** The host scroller's current scrollTop — 0 means the clamp is holding. */
  readonly scrollTop: number;
  /** `.cm-scroller`'s scrollTop — the element `focus-mode.ts` writes. */
  readonly cmScrollTop: number;
  /** Whether `.cm-scroller` has anything to scroll at all. */
  readonly cmScrolls: boolean;
  /** Whether the resolved host scroller IS `.cm-scroller`. */
  readonly hostIsCm: boolean;
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
      "  cmScrollTop: cm.scrollTop," +
      "  cmScrolls: cm.scrollHeight > cm.clientHeight + 1," +
      "  hostIsCm: host === cm" +
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

describeE2E("tw1 the typewriter pin holds across a typing burst (myne-md/myne#555)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("keeps the caret line at the pane centre for 30 typed lines", async () => {
    let password = "";
    await scenario(
      "tw1-typewriter-anchor",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Typewriter");

        await typeIntoEditor(s, " first line");
        await enterTypewriterFocus(s);

        const first = await waitForAnchor(s, "before the burst");
        const band = first.paneHeight * BAND_FRACTION;

        // The burst. Each line is typed as its own `sendKeys` so the plugin sees
        // one update per line rather than one for the whole paste — a paste is a
        // single transaction and would prove nothing about holding the pin
        // ACROSS updates, which is the claim.
        const content = await s.findElement('[data-testid="editor.content"] .cm-content');

        let clampReleased = false;
        let worst: Anchor | null = null;
        let worstLine = -1;

        for (let i = 0; i < BURST_LINES; i += 1) {
          await content.sendKeys(`${KEY.ENTER}line ${i} of the burst`);
          const a = await waitForAnchor(s, `after line ${i}`);

          // Below the clamp the caret cannot be centred and must not be
          // asserted on — see the header. Track that the clamp DID release, or
          // the loop below would be measuring nothing.
          if (a.scrollTop <= 0) continue;
          clampReleased = true;

          if (worst === null || Math.abs(a.offset) > Math.abs(worst.offset)) {
            worst = a;
            worstLine = i;
          }
        }

        expect(
          clampReleased,
          `the editor never scrolled during ${BURST_LINES} typed lines (scrollTop ` +
            `stayed at 0), so the pin was never under test: near the top of a ` +
            `document focus-mode.ts clamps at Math.max(0, target) and the caret ` +
            `legitimately sits above centre. Either the pane is tall enough to hold ` +
            `the whole burst — make it longer — or the editor is not scrolling at all.`,
        ).toBe(true);

        expect(
          Math.abs(worst!.offset),
          `after ${worstLine + 1} typed lines the caret line sat ${Math.round(worst!.offset)}px ` +
            `from the centre of a ${Math.round(worst!.paneHeight)}px pane, outside the ` +
            `${Math.round(band)}px band. That is the drift focus mode's typewriter scroll ` +
            `exists to prevent: the line being written walks down the viewport until it ` +
            `is at the bottom edge, which is exactly where CodeMirror leaves it with no ` +
            `pin at all.`,
        ).toBeLessThanOrEqual(band);
      },
    );
  });
});


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

        const content = await s.findElement('[data-testid="editor.content"] .cm-content');
        await typeIntoEditor(s, " first line");
        await enterTypewriterFocus(s);

        // Get well past the clamp so "scrolled away" and "at the top" are
        // distinguishable.
        for (let i = 0; i < BURST_LINES; i += 1) {
          await content.sendKeys(`${KEY.ENTER}line ${i} before the scroll`);
        }
        const pinned = await waitForAnchor(s, "before scrolling away");
        const band = pinned.paneHeight * BAND_FRACTION;
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
        expect(
          Math.abs(pinned.offset),
          `the caret line sat ${Math.round(pinned.offset)}px from the centre of a ` +
            `${Math.round(pinned.paneHeight)}px pane at the END of the burst, outside ` +
            `the ${Math.round(band)}px band. The pin is not holding, so there is no ` +
            `pin for the wheel below to disturb and nothing for the keystroke to ` +
            `restore.`,
        ).toBeLessThanOrEqual(band);

        // Scroll the pane away from the caret. Driven as a real wheel gesture
        // through the W3C Actions API rather than by writing `scrollTop`: the
        // claim is about what happens after a USER scroll, and a scripted
        // scrollTop write skips the browser's own scroll handling, which is the
        // half most likely to fight the plugin.
        await s.send("POST", "/actions", {
          actions: [
            {
              type: "wheel",
              id: "wheel",
              actions: [
                {
                  type: "scroll",
                  x: 0,
                  y: 0,
                  deltaX: 0,
                  deltaY: -Math.round(pinned.paneHeight),
                  duration: 100,
                  origin: "viewport",
                },
              ],
            },
          ],
        });

        const scrolledAway = await s.waitUntil(
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
