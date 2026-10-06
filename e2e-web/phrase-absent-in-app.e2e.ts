// The 24 words never render anywhere in the served app — myne-md/myne#556, the
// `web.phrase.creation-and-recovery-in-a-page` / `sync.device-join` bullet:
//
//   > walk the live add-a-device flow and assert what is asked for, that no
//   > 24-cell grid renders anywhere in it, that no fingerprint step appears, and
//   > that the stated reason matches — strictly stronger than the bundle grep in
//   > `check-web-no-phrase.mjs`.
//
// # Why the existing grep is not enough, in its own terms
//
// `scripts/check-web-no-phrase.mjs` asserts the recovery phrase is ABSENT from
// the served bundle rather than merely hidden — a real property, and a static
// one. It reads bytes. It cannot see a phrase surface that is present in the
// bundle for a legitimate reason (the shared `src/` tree carries the desktop's
// creation and recovery flows) and reachable on web through a route nobody
// meant to leave open.
//
// This runs the app and asks the other question: with a vault open, is there
// any path from the surfaces a web user actually has to a screen that renders
// phrase cells? The answer must be no, and it must be no on the DOM rather than
// in the byte stream.
//
// # The claim under test, and why it is a commitment rather than a preference
//
// `docs/decisions.md` 2026-07-26 ("Web capability set") keeps the 24 words out
// of served code: a phrase typed into a page is a phrase typed into whatever
// the page's delivery channel has become (A15/TB11), and the web client's whole
// enrolment story is built to avoid needing one. A phrase surface appearing on
// web would not be a cosmetic slip — it would be the mitigation the threat
// model names for its own newest adversary, gone, with nothing reporting it.
//
// # What this scenario can and cannot reach, stated
//
// It drives an UNLOCKED vault from the checked-in fixture and sweeps every
// surface it can open from there. It does NOT walk account creation — that leg
// needs a live sync server the lane has no fixture for yet (the bullet for
// `first-sync.e2e.ts` says so), and creation is where a phrase would legitimately
// exist on desktop. So this covers the post-unlock half; the creation half stays
// with the bundle grep, which is the check that can see it.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { openFixtureVault, openSettingsTab } from "./support/fixture-session";

/**
 * Every testid that renders a piece of a recovery phrase, across all three
 * surfaces that own one in the shared tree.
 *
 * Listed by NAME rather than matched by pattern, because the point is to fail
 * when one of these becomes reachable — and a pattern like `*phrase*` would
 * also match copy that merely mentions the word, which is not a leak and would
 * make the check unusable.
 */
const PHRASE_SURFACES = [
  "create.phrase-grid", // vault creation, the recovery kit's phrase grid
  "create.phrase-word",
  "recover.phrase-cell", // recovery, PhraseEntryStep
  "sync.enroll.phrase-cell", // device enrolment by phrase
] as const;

/** Count elements carrying any of the phrase testids, right now. */
async function phraseCellsOnScreen(session: {
  execute: <T>(script: string, args?: unknown[]) => Promise<T>;
}): Promise<{ testId: string; count: number }[]> {
  return (
    (await session.execute<{ testId: string; count: number }[]>(
      "return arguments[0].map(function (id) {" +
        "  return { testId: id, count: document.querySelectorAll('[data-testid=\"' + id + '\"]').length };" +
        "});",
      [PHRASE_SURFACES],
    )) ?? []
  );
}

describeE2E("the served app never renders a recovery phrase", () => {
  it("has no phrase surface anywhere reachable from an unlocked vault", async () => {
    const ctx = await openFixtureVault();
    try {
      const { session } = ctx;

      // 1. The unlocked shell.
      let found = await phraseCellsOnScreen(session);
      expect(
        found.filter((f) => f.count > 0),
        "a recovery-phrase surface is rendered in the unlocked web app. The 24 " +
          "words are kept out of served code deliberately (decisions.md " +
          "2026-07-26): a phrase typed into a page is a phrase typed into whatever " +
          "the page's delivery channel has become, which is the adversary " +
          "threat-model A15/TB11 was added for.",
      ).toEqual([]);

      // 2. Settings, and every panel behind it.
      // EVERY tab, not the two that seemed likely. The first version of this
      // scenario opened Settings and the Sync panel and swept those; planting a
      // `create.phrase-grid` into the About panel did NOT fail it, because a
      // panel that is never opened is never mounted and a DOM sweep cannot see
      // it. "Anywhere reachable" has to mean anywhere the rail can reach.
      //
      // The rail is read from the app rather than hard-coded, so a panel added
      // later is swept without anyone remembering this file — and the count is
      // asserted, so a rail that silently rendered nothing cannot pass as a
      // clean sweep.
      await openSettingsTab(session, "settings.tab-privacy");
      const tabs =
        (await session.execute<string[]>(
          "return Array.prototype.slice.call(" +
            "  document.querySelectorAll('[data-testid^=\"settings.tab-\"]')" +
            ").map(function (el) { return el.getAttribute('data-testid'); });",
        )) ?? [];
      expect(
        tabs.length,
        "the Settings rail offered no tabs, so sweeping it proves nothing",
      ).toBeGreaterThan(3);

      for (const tab of tabs) {
        await session.execute(
          "document.querySelector('[data-testid=\"' + arguments[0] + '\"]').click();",
          [tab],
        );
        // Settle on the panel having actually changed rather than on a timer:
        // the rail sets `aria-selected`, so waiting for it is a real "the panel
        // mounted" wait.
        await session.waitUntil(
          async () =>
            (await session.execute<boolean>(
              "return document.querySelector('[data-testid=\"' + arguments[0] + '\"]')" +
                "?.getAttribute('aria-selected') === 'true';",
              [tab],
            ))
              ? true
              : null,
          { label: `the ${tab} panel became active`, timeoutMs: 15_000 },
        );

        found = await phraseCellsOnScreen(session);
        expect(
          found.filter((f) => f.count > 0),
          `the web Settings panel behind ${tab} renders a recovery-phrase surface. ` +
            `The 24 words are kept out of served code deliberately: a phrase typed ` +
            `into a page is a phrase typed into whatever the page's delivery ` +
            `channel has become, which is the adversary A15/TB11 was added for.`,
        ).toEqual([]);
      }

      // 3. Non-vacuity, and the assertion this whole file would be worthless
      //    without: the sweep must be able to SEE a phrase cell if one existed.
      //    A selector typo, a renamed testid, or an `execute` that silently
      //    returned an empty array would make every check above pass forever.
      const canSee = await session.execute<number>(
        "var probe = document.createElement('div');" +
          "probe.setAttribute('data-testid', arguments[0]);" +
          "document.body.appendChild(probe);" +
          "var n = document.querySelectorAll('[data-testid=\"' + arguments[0] + '\"]').length;" +
          "probe.remove();" +
          "return n;",
        [PHRASE_SURFACES[0]],
      );
      expect(
        canSee,
        `the sweep cannot detect a "${PHRASE_SURFACES[0]}" element even when one is ` +
          `planted in the page, so every absence it reported above proves nothing`,
      ).toBe(1);
    } finally {
      await ctx.browser.teardown().catch(() => {});
      await ctx.server.close();
    }
  });
});
