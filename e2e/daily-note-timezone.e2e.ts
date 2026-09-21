// dnz1 — "today" is the user's local calendar day, on a machine far from UTC.
// myne-md/myne#555, the `notes.daily-notes` bullet:
//
//   > a midnight rollover is reachable with `libfaketime` in the e2e image (pin
//   > 23:58, cross midnight in ~2 real minutes, assert a new note and the
//   > previous day untouched).
//
// # The zone half needs no fake clock, and that is worth saying
//
// The bullet reaches for `libfaketime` because the ROLLOVER needs a clock that
// moves. The other half of the same failure — which calendar day "today" IS —
// needs only a machine in a different zone, and `e2e/support/session.ts` now
// takes an `env` map, so `TZ` is a scenario parameter. Nothing is faked: the
// app reads the host zone through ICU exactly as it would on a user's laptop.
//
// That matters because the two halves fail differently and only one of them is
// rare. A rollover bug bites once a day for a moment; a ZONE bug bites every
// user east of UTC+12 or west of UTC-11 all day, every day, and the developer
// machine never reproduces it.
//
// # The failure
//
// `formatDailyDate` builds the title from `getFullYear()` / `getMonth()` /
// `getDate()` — LOCAL clock. Anything that reached for UTC instead would give a
// user in Kiritimati (UTC+14) yesterday's note for most of their day and today's
// note only after 10:00 local, and a user in Niue (UTC-11) tomorrow's note from
// 13:00 onward. Both silently: the note opens, it just has the wrong name, and
// the next day the "wrong" one is the one that already has their writing in it.
//
// # Two zones, 25 hours apart, in one run
//
// The scenario computes what the local calendar date IS in the launch zone and
// asserts the created note's title matches. Running it in a zone deliberately
// far from UTC is what makes a UTC-reading implementation fail: on a runner
// already at UTC, `TZ=UTC` and a UTC bug agree.
//
// Vault-count precondition: 1 (weak KDF generator fixture).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { dismissImporterOffer, ipcOk, runPaletteAction, unlockToEditor } from "./support/flows";
import type { Session } from "./support/webdriver";

/**
 * The civil date `zone` is having right now, computed HERE rather than in the
 * app.
 *
 * An independent measurement is the whole point: asking the app what day it
 * thinks it is and then asserting the note matches would be comparing the app
 * against itself. `Intl` in the test process, with an explicit `timeZone`, is a
 * second opinion.
 */
function civilDateIn(zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * How many notes in the vault carry `title` in their frontmatter.
 *
 * Read through the real `note_read` IPC rather than off a rendered surface, and
 * both surfaces this replaced are worth recording:
 *
 *  * the SIDEBAR was wrong because a daily note is created inside `Daily/`, so
 *    it is not a top-level `notes.row` at all — the first version waited 30 s
 *    for a row that was correctly nested one level down;
 *  * the active TAB's label was wrong because it is not settled when the action
 *    returns: one run in three reported `"Untitled"` for the whole 30 s. A tab
 *    label is a rendering of a title that is parsed out of the note body after
 *    it loads, so it is a race by construction, and the failure is permanent
 *    rather than slow — exactly the class `e2e/AGENTS.md` says a bigger budget
 *    cannot reach.
 *
 * What the claim is actually about is which note EXISTS, so that is what is
 * counted.
 */
async function notesTitled(s: Session, title: string): Promise<number> {
  const ids = (await ipcOk(s, "plugin:notes|note_list")) as string[];
  let n = 0;
  for (const id of ids) {
    const body = (await ipcOk(s, "plugin:notes|note_read", { noteId: id })) as unknown;
    if (typeof body === "string" && body.includes(title)) n += 1;
  }
  return n;
}

/** One scenario body, parameterised by the zone the app is launched in. */
async function dailyNoteTitleIn(zone: string): Promise<void> {
  let password = "";
  await scenario(
    `dnz1-daily-${zone.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
    {
      seed: (dir) => void (password = seedVault(dir).password),
      // The lever. Spread above the harness's own `XDG_*` values, so a scenario
      // can set the clock's zone and cannot reach the isolation the suite rests
      // on — see `LaunchOptions.env`.
      env: { TZ: zone },
    },
    async (app) => {
      const s = app.session;
      await unlockToEditor(s, password);
      await dismissImporterOffer(s);

      // The app must actually BE in that zone. Without this the assertion below
      // would pass on a build that ignored `TZ` entirely, by comparing the
      // runner's own date against a note named with the runner's own date.
      const appZone = await s.execute<string>(
        "return Intl.DateTimeFormat().resolvedOptions().timeZone;",
      );
      expect(
        appZone,
        `the app reports timeZone "${appZone}" after being launched with TZ=${zone}. ` +
          `The env did not reach the process, so nothing below is measuring what it ` +
          `claims to.`,
      ).toBe(zone);

      const expected = civilDateIn(zone);
      await runPaletteAction(s, "daily.open-today", "daily");

      // The daily note is created and opened; its title is the local date in
      // the default `YYYY-MM-DD` format.
      let seen = 0;
      await s.waitUntil(
        async () => {
          seen = await notesTitled(s, expected);
          return seen > 0 ? true : null;
        },
        {
          label: () =>
            `a note titled ${expected} (today in ${zone}) to exist — found ${seen}. ` +
            `A daily note is found again by matching its TITLE, so a title built ` +
            `from the wrong calendar day means the user gets yesterday's note for ` +
            `most of their day, and the next day the "wrong" one is the one that ` +
            `already has their writing in it.`,
          timeoutMs: 30_000,
        },
      );

      // …and exactly one. A second open must reuse it rather than making
      // another, which is the idempotence half of the same resolver.
      await runPaletteAction(s, "daily.open-today", "daily");
      await s.byTestId("editor.content");
      const again = await notesTitled(s, expected);
      expect(
        again,
        `after opening today's note twice there are ${again} notes titled ${expected}. ` +
          `The resolver is open-or-CREATE and the second call must find the note the ` +
          `first one made — otherwise a day's writing splits across two.`,
      ).toBe(1);
    },
  );
}

describeE2E("dnz1 the daily note is named for the LOCAL day (myne-md/myne#555)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("names it for today in Pacific/Kiritimati (UTC+14)", async () => {
    // The far eastern edge. For ten hours of every UTC day this zone is already
    // on the NEXT calendar date, so a UTC-reading implementation hands the user
    // yesterday's note.
    await dailyNoteTitleIn("Pacific/Kiritimati");
  });

  // Vault-count precondition: 1 (weak KDF).
  it("names it for today in Pacific/Niue (UTC-11)", async () => {
    // The far western edge, and the opposite error: for eleven hours of every
    // UTC day this zone is still on the PREVIOUS date. Both zones are needed —
    // an implementation that shifted one way would pass the other test.
    await dailyNoteTitleIn("Pacific/Niue");
  });
});
