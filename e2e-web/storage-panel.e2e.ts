// The web Storage panel offers none of the four controls a page cannot honour —
// myne-md/myne#556, the `settings.panel.storage` bullet:
//
//   > the copy and the ABSENCE of a path, "Open in Files", Back up and Restore
//   > are testid assertions
//
// # What the substitution promises, in the roster's own words
//
// `scripts/check-web-surfaces.mjs` marks `src/components/settings/StoragePanel.tsx`
// as `excluded` on web, with the reason written out:
//
//   > Four wrong controls: a filesystem path OPFS does not have, an OS
//   > file-manager call, the backup pair, and a directory import task 71 owns.
//
// and an absence marker (`settings.storage.openInFiles`) the guard greps
// `web/dist` for.
//
// # Why the marker grep is not the same check
//
// The grep proves one STRING is not in the served bytes. It cannot prove the
// substituted panel renders nothing equivalent — a web panel that grew its own
// "open folder" affordance, or that rendered an empty path row because a
// resolver returned `""` instead of refusing, passes the grep and shows the
// user a control that does nothing. And it says nothing about the other three
// of the four.
//
// So this asks the rendered panel: are the four wrong controls absent, and is
// the panel there at all rather than blank? Both halves matter — an excluded
// panel that renders NOTHING would satisfy every absence assertion and leave a
// rail entry pointing at emptiness, which is its own defect.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { openFixtureVault, openSettingsTab } from "./support/fixture-session";

/**
 * The controls the desktop Storage panel owns and a page cannot.
 *
 * Two of them are testids this branch added for the desktop scenario
 * (`e2e/storage-panel.e2e.ts`), which is what makes their absence assertable
 * here rather than a claim about copy.
 */
const DESKTOP_ONLY_CONTROLS = [
  "storage.vault-path", // a filesystem path OPFS does not have
  "storage.open-in-files", // an OS file-manager call
  "settings.backup-vault", // the backup pair …
  "settings.restore-backup", // … both halves of it
  "storage.import", // the directory import
] as const;

describeE2E("the web Storage panel", () => {
  it("renders, and offers none of the controls a page cannot honour", async () => {
    const ctx = await openFixtureVault();
    try {
      const { session } = ctx;
      await openSettingsTab(session, "settings.tab-storage");

      // It is THERE. An excluded panel that rendered nothing would satisfy
      // every absence below while leaving a rail entry pointing at a blank
      // pane — a different defect with the same test result.
      const panel = await session.findElements('[data-testid="settings.storage-panel"]');
      expect(
        panel.length,
        "the web Storage panel did not render. Its rail entry is offered, so a " +
          "blank pane is what a user gets — the absences asserted below would all " +
          "hold trivially.",
      ).toBe(1);

      const present =
        (await session.execute<string[]>(
          "return arguments[0].filter(function (id) {" +
            "  return document.querySelectorAll('[data-testid=\"' + id + '\"]').length > 0;" +
            "});",
          [DESKTOP_ONLY_CONTROLS],
        )) ?? [];

      expect(
        present,
        `the web Storage panel renders ${present.join(", ")}. The web surfaces ` +
          `roster marks this panel \`excluded\` precisely because these four are ` +
          `wrong here — a filesystem path OPFS does not have, an OS file-manager ` +
          `call, the backup pair, and a directory import. A control that cannot ` +
          `work is an offer the platform cannot honour, which decisions.md ` +
          `2026-07-26 makes omission-not-greying normative about.`,
      ).toEqual([]);

      // Non-vacuity: the sweep must be able to see one of these ids when it is
      // actually present. Without this a renamed testid would make the panel
      // look clean forever.
      const canSee = await session.execute<number>(
        "var probe = document.createElement('div');" +
          "probe.setAttribute('data-testid', arguments[0]);" +
          "document.body.appendChild(probe);" +
          "var n = document.querySelectorAll('[data-testid=\"' + arguments[0] + '\"]').length;" +
          "probe.remove();" +
          "return n;",
        [DESKTOP_ONLY_CONTROLS[0]],
      );
      expect(
        canSee,
        `the sweep cannot see a "${DESKTOP_ONLY_CONTROLS[0]}" element even when one ` +
          `is planted, so every absence it reported proves nothing`,
      ).toBe(1);
    } finally {
      await ctx.browser.teardown().catch(() => {});
      await ctx.server.close();
    }
  });
});
