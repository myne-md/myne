// `prefers-reduced-motion` stops the decoration and keeps the spinner alive.
// myne-md/myne#556, the `appearance.themes` bullet:
//
//   > `prefers-reduced-motion` and `forced-colors` are emulable the same way,
//   > and the response is mechanical: computed `transition-duration: 0s` on the
//   > named surfaces, plus an axe run under forced-colors.
//
// # The walk this retires, and why the interesting half is the EXEMPTION
//
// Turn on Reduce Motion in the OS and look at whether things stopped moving.
// That check is easy to pass and easy to pass WRONGLY, because the failure that
// matters is the opposite direction and `tokens.css` says so in its own words:
//
//   > A spinner frozen mid-arc does not read as "reduced motion", it reads as
//   > "hung": the one moment a user most needs to know the app is alive is the
//   > one where we stopped telling them.
//
// So the blanket rule zeroes `animation-duration` and `transition-duration` on
// everything, and a named exemption (`.myne-spinner`, `[data-motion="essential"]`
// and its pseudo-elements) keeps essential motion running at 1600ms — half
// speed, deliberately, rather than restored.
//
// Both halves are asserted. Only asserting the blanket rule would pass against
// a stylesheet that froze the spinner too, which is the regression the exemption
// exists to prevent — and a tester watching a headless CI browser would never
// see it either way.
//
// # Emulated live, not launched with a flag
//
// Same reason as `system-theme-live.e2e.ts`: the media query re-evaluates on its
// own, so what is under test is that nothing has pinned a duration the query can
// no longer reach. Chromium only (`Emulation.setEmulatedMedia` is CDP); the
// scenario self-skips on Firefox naming why, per `support/cdp.ts`.
//
// # The file name carries a `-web` suffix on purpose
//
// `e2e/reduced-motion.e2e.ts` already exists in the DESKTOP lane and covers the
// same preference against WebKitGTK. Both runners take a bare spec name, so two
// files sharing one would make `reduced-motion` ambiguous at the command line —
// `plaintext-residue-web.e2e.ts` is the same convention for the same reason. The
// two are not duplicates: the desktop one asserts WebKitGTK's response, this one
// Chromium's, and a media query honoured by one engine is not thereby honoured
// by the other.
//
// # What is NOT asserted here
//
// `forced-colors`, the other half of the bullet. Chromium's
// `Emulation.setEmulatedMedia` accepts it, but the app ships no `forced-colors`
// rules at all — so a scenario would be asserting the absence of a feature
// rather than the behaviour of one, and an axe run under it measures axe. That
// belongs with a decision about whether to support Windows High Contrast, and is
// recorded on the issue rather than faked here.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { openFixtureVault } from "./support/fixture-session";
import { setEmulatedMedia, supportsCdp } from "./support/cdp";
import { harnessEnv, type SupportedBrowser } from "./support/harness";
import type { Session } from "./support/session";

/** Surfaces whose decoration must stop. Present in the unlocked shell with no
 *  note open, which is the state the fixture vault reaches. */
const DECORATED = ["editor.sidebar-left", "editor.sidebar-right", "editor.bottom-bar"] as const;

/** What the exemption promises, in ms. `tokens.css` sets 1600 explicitly. */
const ESSENTIAL_DURATION_MS = 1600;

interface Motion {
  /** Longest `transition-duration` in seconds, per decorated surface. */
  readonly transitions: Record<string, number>;
  /** `animation-duration` of a probe element carrying the essential marker. */
  readonly essential: number;
}

/**
 * Read the durations the page currently resolves.
 *
 * The essential probe is a NODE THIS SCENARIO CREATES, and that is deliberate:
 * the app's own spinner is only on screen while something is loading, so a
 * scenario that waited for one would be racing a fixture that unlocks fast. The
 * exemption is a CSS selector — `[data-motion="essential"]` — so any element
 * carrying the marker is subject to exactly the rule under test. It is removed
 * again before the read returns, so nothing this leaves behind can affect a
 * later assertion.
 */
async function readMotion(session: Session): Promise<Motion> {
  const raw = await session.execute<string>(
    "var ids = arguments[0];" +
      "var out = {};" +
      "function longest(v) {" +
      "  return Math.max.apply(null, String(v).split(',').map(function (p) {" +
      "    p = p.trim();" +
      "    return p.endsWith('ms') ? parseFloat(p) / 1000 : parseFloat(p) || 0;" +
      "  }));" +
      "}" +
      "for (var i = 0; i < ids.length; i++) {" +
      "  var el = document.querySelector('[data-testid=\"' + ids[i] + '\"]');" +
      "  if (el) out[ids[i]] = longest(getComputedStyle(el).transitionDuration);" +
      "}" +
      "var probe = document.createElement('div');" +
      "probe.setAttribute('data-motion', 'essential');" +
      "probe.style.animationName = 'myne-spinner-rotate';" +
      "probe.style.animationDuration = '900ms';" +
      "probe.style.animationIterationCount = 'infinite';" +
      "document.body.appendChild(probe);" +
      "var essential = longest(getComputedStyle(probe).animationDuration);" +
      "probe.remove();" +
      "return JSON.stringify({ transitions: out, essential: essential });",
    [DECORATED as unknown as string[]],
  );
  return JSON.parse(raw) as Motion;
}

describeE2E("prefers-reduced-motion stops decoration and keeps essential motion", () => {
  it("zeroes transitions on every surface while holding the essential exemption", async () => {
    const browser = harnessEnv().browser as SupportedBrowser;
    if (!supportsCdp(browser)) {
      expect(
        browser,
        "this scenario needs CDP media emulation and only Chromium has it — see " +
          "support/cdp.ts. Nothing is asserted on this engine.",
      ).not.toBe("chrome");
      return;
    }

    const ctx = await openFixtureVault();
    try {
      const { session } = ctx;

      // NO-PREFERENCE FIRST, and it is the non-vacuity half. "Every transition
      // is 0s under reduce" is also true of a page with no transitions at all,
      // so at least one surface has to be moving before the preference is set —
      // otherwise the assertion below holds on any stylesheet whatsoever.
      await setEmulatedMedia(session, browser, [
        { name: "prefers-reduced-motion", value: "no-preference" },
      ]);
      const normal = await readMotion(session);

      expect(
        Object.keys(normal.transitions).length,
        `none of ${JSON.stringify(DECORATED)} rendered, so every loop below is empty ` +
          `and this scenario passes without measuring anything`,
      ).toBe(DECORATED.length);
      const moving = Object.entries(normal.transitions).filter(([, d]) => d > 0);
      expect(
        moving.length,
        `no surface has a transition at all with reduced motion OFF ` +
          `(${JSON.stringify(normal.transitions)}), so "everything is 0s under reduce" ` +
          `would be true of this page regardless of the reduced-motion rule. There is ` +
          `nothing here for the preference to suppress.`,
      ).toBeGreaterThan(0);
      expect(
        normal.essential,
        `an element marked data-motion="essential" resolved a ${normal.essential}s ` +
          `animation with reduced motion OFF, but it was given 900ms. The exemption ` +
          `block is applying outside its media query, so the "half speed under ` +
          `reduce" assertion below cannot distinguish it from the default.`,
      ).toBeCloseTo(0.9, 2);

      // …and now the preference.
      await setEmulatedMedia(session, browser, [
        { name: "prefers-reduced-motion", value: "reduce" },
      ]);
      const reduced = await readMotion(session);

      for (const id of DECORATED) {
        expect(
          reduced.transitions[id],
          `${id} still transitions over ${reduced.transitions[id]}s under ` +
            `prefers-reduced-motion: reduce (it was ${normal.transitions[id]}s ` +
            `without it). tokens.css sets transition-duration: 0ms !important for ` +
            `every element under that query, so a surface that keeps moving is one ` +
            `whose duration is set somewhere the !important cannot reach — an inline ` +
            `style, or a rule with higher specificity declared later.`,
        ).toBe(0);
      }

      // The exemption, which is the half a "did everything stop?" check gets
      // backwards. tokens.css: a frozen spinner "does not read as reduced
      // motion, it reads as hung".
      expect(
        reduced.essential * 1000,
        `an element marked data-motion="essential" resolved ` +
          `${reduced.essential * 1000}ms under reduced motion, not the ` +
          `${ESSENTIAL_DURATION_MS}ms the exemption promises. At 0 it is frozen, ` +
          `which is exactly the failure the exemption exists to prevent: the one ` +
          `moment a user most needs to know the app is alive is the one where a ` +
          `blanket rule stopped telling them.`,
      ).toBe(ESSENTIAL_DURATION_MS);

      // Back to no-preference. A one-way check is satisfied by anything that
      // changes once; the preference is a function of the OS setting, so the
      // return has to be exact.
      await setEmulatedMedia(session, browser, [
        { name: "prefers-reduced-motion", value: "no-preference" },
      ]);
      const back = await readMotion(session);
      for (const id of DECORATED) {
        expect(
          back.transitions[id],
          `${id} is stuck at ${back.transitions[id]}s after the preference went back ` +
            `to no-preference, having been ${normal.transitions[id]}s before it`,
        ).toBeCloseTo(normal.transitions[id]!, 3);
      }
    } finally {
      await ctx.browser.teardown().catch(() => {});
      await ctx.server.close();
    }
  });
});
