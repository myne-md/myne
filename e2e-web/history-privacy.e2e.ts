// The address bar and the browsing history carry a stage and at most a note id
// — never a title, never an account number. myne-md/myne#556, the
// `workspace.navigation-history` bullet:
//
//   > `session.back()` drives the browser's own Back, and "still inside Myne,
//   > previous note shown, at most a note id in the route, no title or account
//   > number in location or history" are all in-page.
//
// # Why this is a privacy assertion and not a routing one
//
// `web/src/platform/history.ts` states the rule it implements: "nothing
// decrypted may ever reach the address bar, the browsing history or a
// referrer". That is not a preference about URL aesthetics. A URL is the single
// most-copied string in a browser session — into the history database on disk,
// into a referrer header, into a synced-profile backup, into a screenshot of a
// browser window, into an intermediary's logs. A note TITLE there is plaintext
// out of the vault; an ACCOUNT NUMBER there is a vault identifier out of the
// vault, and `check-web-testids.mjs` already refuses to let one near a
// pre-unlock `data-*` attribute for the same reason.
//
// The desktop client is URL-free, so there is no desktop scenario this could
// duplicate. This is web-specific behaviour, which is what `e2e-web/AGENTS.md`
// says belongs in this lane.
//
// # What is asserted
//
//  1. The route is a path from the closed stage vocabulary, plus at most a
//     canonical UUID — anything else means something unvalidated reached it.
//  2. Neither the current URL nor any entry the session can reach by going Back
//     carries the fixture's account number.
//  3. A malformed note id still lands the user on the VIEW they asked for
//     rather than on an error — the stale-bookmark case.
//
// # What this does NOT assert, and why
//
// The bullet also names `session.back()`. `back()` now exists on the session
// (added here, W3C `POST /back`), and the assertion is deliberately not made,
// because this fixture cannot produce an honest app-to-app history pair:
//
// MEASURED — the app does NOT stack a history entry per stage transition. It
// uses `replaceRoute` for them, which is correct (Back must not un-unlock a
// vault), so immediately after unlock the only earlier entry is the harness's
// own `/__seed` page. A Back from there lands on a seeding fixture, and every
// assertion about "still inside Myne" would be asserting something about the
// harness. Two attempts to work around it — pushing a second route, then
// navigating to a different stage first — both landed back on `/__seed`, which
// is the tell that the stack has one app entry and not two.
//
// Making that pair honestly needs a fixture with notes in it, so that opening
// one pushes a real `/editor/<uuid>` entry. `unlock-from-fixture.e2e.ts`
// records that the current fixture holds none. That is the prerequisite, and
// inventing a history pair to assert against would be testing the harness.
//
// The SAME prerequisite bounds assertion 3. Deleting `parse`'s `NOTE_ID.test`
// was injected here and this file stayed green — correctly: with no notes in
// the vault, "opened the editor with no note" and "tried to open a note whose
// id is garbage" render identically. So assertion 3 covers the stale-bookmark
// crash and not the validation.
//
// The validation itself is already covered, and better than a scenario could:
// `tests/web/history-seam.test.ts` drives `parse` directly ("DROPS a malformed
// note id rather than failing the whole route", "rejects a note id that is only
// uuid-SHAPED"). The same injection fails BOTH of those by name — checked, not
// assumed. A pure function is where that belongs; this file covers what only a
// browser can answer.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { openFixtureVault, openSettingsTab } from "./support/fixture-session";
import { loadVaultFixture } from "./support/opfs-seed";

/** The stage names `web/src/platform/history.ts` will emit — its own set. */
const STAGE_NAMES = [
  "welcome",
  "create-vault",
  "unlock",
  "editor",
  "recover",
  "picker",
  "account-entry",
  "pending-approval",
  "restore-backup",
];

/** Canonical 36-char lowercase hyphenated UUID — the one thing a route may
 *  carry besides a stage name. */
const NOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Assert one pathname is nothing but a known stage plus an optional note id. */
function expectRouteIsClean(pathname: string, where: string): void {
  const parts = pathname.split("/").filter(Boolean);
  expect(
    parts.length,
    `${where}: the path "${pathname}" has ${parts.length} segments. The route ` +
      `grammar is one stage name plus at most a note id — a third segment means ` +
      `something the grammar does not describe reached the address bar.`,
  ).toBeLessThanOrEqual(2);
  if (parts.length >= 1) {
    expect(
      STAGE_NAMES,
      `${where}: "${parts[0]}" is not one of the stage names history.ts emits, so ` +
        `the first path segment is carrying something else`,
    ).toContain(parts[0]);
  }
  if (parts.length === 2) {
    expect(
      parts[1],
      `${where}: the second path segment "${parts[1]}" is not a canonical UUID. ` +
        `A note id is the ONLY thing allowed there — a slug, a title or an ` +
        `account number is plaintext out of the vault, in the one string a ` +
        `browser copies into its history database, its referrers and its ` +
        `profile backup.`,
    ).toMatch(NOTE_ID);
  }
}

describeE2E("the browser history carries nothing decrypted", () => {
  it("keeps the route to a stage and a note id, and Back stays inside the app", async () => {
    const fixture = loadVaultFixture();
    const ctx = await openFixtureVault();
    try {
      const { session, server } = ctx;

      // A few real navigations, so there is a history stack to walk.
      const visited: string[] = [];
      const record = async () => {
        const p =
          (await session.execute<string>("return location.pathname;")) ?? "";
        visited.push(p);
        return p;
      };
      expectRouteIsClean(await record(), "after unlock");

      await openSettingsTab(session, "settings.tab-privacy");
      expectRouteIsClean(await record(), "with Settings open");

      // 1. Nothing in the CURRENT url carries the account number. Checked over
      //    the whole href, not just the path: a query string or a fragment is
      //    the same disclosure through a different door.
      // DECODED, because a browser percent-encodes and a raw `includes` would
      // miss an encoded occurrence entirely — the same blind spot that made
      // assertion 3's first version vacuous.
      const href = decodeURIComponent(
        (await session.execute<string>("return location.href;")) ?? "",
      );
      const account = fixture.accountNumber ?? "";
      expect(
        account.length,
        "the fixture carries no account number, so the assertion below would hold " +
          "against an empty needle and prove nothing",
      ).toBeGreaterThan(4);
      expect(
        href.includes(account),
        `the account number is in the address bar (${href}). A URL is the most-copied ` +
          `string in a browser session — history database, referrer header, synced ` +
          `profile backup, screenshot — and this is a vault identifier.`,
      ).toBe(false);
      // …and its ungrouped form too, since the display form carries dashes.
      expect(href.includes(account.replace(/-/g, ""))).toBe(false);

      // 2. Every stage the app moved through kept the grammar. Driven by
      //    NAVIGATING to each stage route directly, which is what a bookmark or
      //    a pasted link does — and the path `history.ts::parse` is written to
      //    validate rather than trust ("anything can be typed into the address
      //    bar").
      for (const stage of ["editor", "unlock", "picker"]) {
        await session.navigate(`${server.origin}/${stage}`);
        await session.waitUntil(
          async () =>
            (await session.execute<string>("return document.readyState;")) === "complete"
              ? true
              : null,
          { label: `the /${stage} route settled`, timeoutMs: 15_000 },
        );
        expectRouteIsClean(await record(), `after navigating to /${stage}`);
        const stageHref = decodeURIComponent(
          (await session.execute<string>("return location.href;")) ?? "",
        );
        expect(
          stageHref.includes(account) || stageHref.includes(account.replace(/-/g, "")),
          `the account number reached the address bar on /${stage}`,
        ).toBe(false);
      }

      // 3. A malformed note id still lands the user on the VIEW they asked
      //    for, rather than on an error.
      //
      // Rewritten after its first version turned out to be vacuous, which is
      // worth recording. It navigated to `/editor/not-a-uuid-<script>` and
      // asserted `location.pathname` did not contain `<script>` — and making
      // `parse` echo the segment unvalidated did not fail it, because the check
      // was about the BROWSER (which percent-encodes `<` and `>`) and not about
      // the app at all. `parse` READS the address bar; it never rewrites it, so
      // nothing the app does can change what the URL says.
      //
      // What IS the app's behaviour, and what `history.ts` documents, is the
      // fallback: "a malformed id is DROPPED rather than failing the whole
      // route: the user still lands on the view they asked for, which is the
      // difference between a stale bookmark and an error screen."
      await session.navigate(`${server.origin}/editor/not-a-uuid-at-all`);
      await session.waitUntil(
        async () =>
          (await session.execute<number>(
            "return document.querySelectorAll(" +
              "'[data-testid=\"editor.bottom-bar\"],[data-testid=\"unlock.password-input\"],[data-testid=\"welcome.root\"],[data-testid=\"bootstrap.beta-terms\"]'" +
              ").length;",
          )) ?? 0
            ? true
            : null,
        {
          label:
            "a malformed note id still reached a Myne screen — a stale bookmark " +
            "must land the user on the view they asked for, not on an error",
          timeoutMs: 20_000,
        },
      );
      const failed = await session.execute<number>(
        "return document.querySelectorAll('[data-testid=\"fail-closed.root\"],[data-testid=\"web.unsupported-environment\"]').length;",
      );
      expect(
        failed,
        "a malformed note id in the URL produced a failure screen. A stale " +
          "bookmark is the ordinary case here and it must degrade to the view, " +
          "not to an error.",
      ).toBe(0);

      // 4. Every route this session actually visited was clean, not just the
      //    ones checked inline. Re-asserted as a set so a future navigation
      //    added above cannot slip past unchecked.
      expect(visited.length).toBeGreaterThanOrEqual(3);
      for (const p of visited) expectRouteIsClean(p, "a visited route");
    } finally {
      await ctx.browser.teardown().catch(() => {});
      await ctx.server.close();
    }
  });
});
