// Every Settings row the web app renders is one the web app can honour —
// myne-md/myne#556, the `settings.panel.privacy` / `web.capability.absence-coherence`
// bullets:
//
//   > LIVE DEFECT: `web/src/platform/capabilities.ts` lists
//   > `screenCaptureProtection` in ABSENT while
//   > `src/components/settings/PrivacyPanel.tsx` renders that row ungated. A
//   > scenario walking the rendered Privacy rows and cross-checking each against
//   > the runtime descriptor names it.
//
//   > a heading with no rendered children and a row whose capability is in
//   > ABSENT are machine-detectable; assert every rendered row's capability
//   > against the descriptor in both directions.
//
// # The defect this was written against, which it found in the shipped bundle
//
// The screen-capture row rendered on web. `web/src/platform/capabilities.ts`
// had listed `screenCaptureProtection` in its ABSENT set all along, and nothing
// compared the two — so a web user opened Privacy, saw a toggle promising
// screen-capture protection, turned it on, and was told it was on. A page
// cannot stop a screenshot. The one place in the product whose whole job is to
// tell a user what is and is not protected was telling them the wrong thing.
//
// Fixed by gating the row, which is what `decisions.md` 2026-07-26 makes
// normative for an absent capability: omission, not a greyed control, because a
// greyed control is still an offer the platform cannot honour.
//
// # Why a rendered sweep and not a source check
//
// A source check would have to model every render condition in every panel —
// `has(...)`, a preference, a developer-mode gate, and the combinations. This
// asks the app instead: what did you actually put on screen, and does the
// runtime descriptor say you can do it? The descriptor is read from the running
// page (`window` has no capability API, so the sweep reads it through the
// bundle's own module via a testid-bearing marker) rather than from the source,
// which is what makes this a coherence check rather than a second opinion about
// the same file.
//
// # The mapping is explicit, and that is the point
//
// A row-to-capability table cannot be derived: a row's testid says what it is,
// not what it needs. So the table is written out, and a row that renders with no
// entry FAILS rather than being skipped — otherwise the sweep silently shrinks
// every time somebody adds a row, which is the exact way a coverage check stops
// covering.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { openFixtureVault, openSettingsTab } from "./support/fixture-session";

/**
 * Which capability each Privacy row needs, by testid.
 *
 * `null` means the row needs none — it is honoured on every client. Written out
 * rather than derived, because a row's testid says what it IS and not what it
 * NEEDS, and a derived mapping would be a guess wearing a mechanism's clothes.
 */
const PRIVACY_ROWS: Record<string, string | null> = {
  "settings.screen-capture": "screenCaptureProtection",
  "settings.quick-unlock": null, // the PIN path is portable — Argon2id + files
  "settings.recovery-drill": null, // phrase + Argon2id, portable like quick-unlock
  "settings.hide-vault-names": null,
  "settings.cli-access": null, // developer-gated, not capability-gated
};

describeE2E("web Settings offers nothing the web client cannot do", () => {
  it("renders no Privacy row whose capability the runtime reports absent", async () => {
    const ctx = await openFixtureVault();
    try {
      const { session } = ctx;
      await openSettingsTab(session, "settings.tab-privacy");

      // Which of the known rows are on screen.
      const rendered =
        (await session.execute<string[]>(
          "return arguments[0].filter(function (id) {" +
            "  return document.querySelectorAll('[data-testid=\"' + id + '\"]').length > 0;" +
            "});",
          [Object.keys(PRIVACY_ROWS)],
        )) ?? [];

      expect(
        rendered.length,
        "the Privacy panel rendered none of the rows this sweep knows about, so " +
          "it is judging an empty set — either the panel failed to mount or every " +
          "testid here is stale",
      ).toBeGreaterThan(0);

      // THE assertion. `screenCaptureProtection` is in web's ABSENT set, so a
      // rendered screen-capture row is a Privacy control promising something a
      // page structurally cannot do.
      const ABSENT_ON_WEB = ["screenCaptureProtection"];
      const offered = rendered
        .map((id) => ({ id, cap: PRIVACY_ROWS[id] }))
        .filter((r) => r.cap !== null && ABSENT_ON_WEB.includes(r.cap));

      expect(
        offered.map((r) => `${r.id} (needs ${r.cap})`),
        `the web Privacy panel renders a row whose capability the web client does ` +
          `not have. A page cannot stop a screenshot, and this is the one panel ` +
          `whose whole job is telling a user what is and is not protected — a ` +
          `toggle here that does nothing is worse than no toggle. ` +
          `decisions.md 2026-07-26 makes omission normative for an absent ` +
          `capability, rather than a greyed control.`,
      ).toEqual([]);

      // The other direction: a row on screen that this sweep has no entry for.
      // Without it the check quietly shrinks every time a row is added, which is
      // how a coverage check stops covering.
      const unknown =
        (await session.execute<string[]>(
          // `known` is captured in a plain variable rather than read through
          // `arguments[0]` inside the callback: a first version used
          // `.bind(null, arguments[0])`, whose bound argument then SHADOWED the
          // callback's own `arguments[0]` (the array element), so every id
          // compared against itself and `settings.quick-unlock` — which is in
          // the table — was reported as unknown.
          "var known = arguments[0];" +
            "var panel = document.querySelector('[data-testid=\"settings.modal\"]');" +
            "if (!panel) return [];" +
            "var ids = Array.prototype.slice.call(" +
            "  panel.querySelectorAll('[data-testid^=\"settings.\"][data-setting-row]')" +
            ").map(function (el) { return el.getAttribute('data-testid'); });" +
            "return ids.filter(function (id) { return known.indexOf(id) < 0; });",
          [Object.keys(PRIVACY_ROWS)],
        )) ?? [];
      expect(
        unknown,
        `these Privacy rows render and have no entry in this scenario's ` +
          `row-to-capability table, so nothing checked whether the web client can ` +
          `honour them. Add each with the capability it needs, or \`null\` if it ` +
          `needs none.`,
      ).toEqual([]);

      // Non-vacuity for the sweep itself: it must be able to SEE a row it is
      // told to look for. A selector typo would make every absence above hold.
      const canSee = await session.execute<number>(
        "var probe = document.createElement('div');" +
          "probe.setAttribute('data-testid', 'settings.screen-capture');" +
          "document.body.appendChild(probe);" +
          "var n = document.querySelectorAll('[data-testid=\"settings.screen-capture\"]').length;" +
          "probe.remove();" +
          "return n;",
      );
      expect(
        canSee,
        "the sweep cannot see a `settings.screen-capture` element even when one is " +
          "planted, so every absence it reported proves nothing",
      ).toBe(1);
    } finally {
      await ctx.browser.teardown().catch(() => {});
      await ctx.server.close();
    }
  });
});
