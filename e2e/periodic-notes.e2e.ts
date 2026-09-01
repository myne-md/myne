// Periodic-notes suite (myne-md/myne#177, e2e).
//
// Stories:
//   pn1: each of the three periods opens through the palette, creates its note
//         on first run and OPENS THE SAME NOTE on the second, and the three are
//         three distinct notes rather than one.
//
// What this suite settles that the unit lanes structurally cannot. The
// resolvers are pure and heavily unit-tested in all three implementations
// (`tests/notes/dailyNote.test.ts`, `mobile/tests/daily.test.ts`,
// `daily_match::tests`), so what is NOT covered there is the wiring: that the
// palette action reaches the resolver, that the create path writes a note the
// next resolve can find, and that "the same note" survives a real round trip
// through disk and the note list rather than through an array literal. Every
// one of those steps is between the tested function and the user.
//
// It also closes a measured pre-existing gap. Before this file, NO scenario in
// this suite drove daily notes at all, and daily is the thing this feature
// refactored: the daily path now runs through `resolvePeriodNote` like the
// other two. A regression there would have had no lane below the manual pass.
//
// Deliberately NOT covered here, and stated rather than left absent:
//   * the Settings surface (folder / format / template per period). Its
//     persistence wiring is a component test with the prefs layer mocked at the
//     lib boundary (`tests/components/periodicNotesSettings.test.tsx`), and
//     driving three text fields through this lane would re-test the same
//     `writePref` chokepoint every other settings row already goes through.
//   * the template path. It needs a template note in the seed, and the
//     instantiation itself is `createNoteFromTemplate`, which
//     `note-template.e2e.ts` already drives.
//   * the timezone override, which is device-local and has no desktop control
//     to set from a scenario.

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  pageSeatInvoke,
  runPaletteAction,
  unlockToEditor,
} from "./support/flows";
import type { Session } from "./support/webdriver";

/** The three palette actions, in the order the scenario drives them. */
const PERIOD_ACTIONS: ReadonlyArray<readonly [label: string, actionId: string, query: string]> = [
  ["daily", "daily.open-today", "today"],
  ["weekly", "periodic.open-this-week", "week"],
  ["monthly", "periodic.open-this-month", "month"],
];

/**
 * The vault's note ids, over production IPC from the page seat.
 *
 * The sidebar cannot answer this scenario. A period note is created inside
 * `Daily/` / `Weekly/` / `Monthly/`, which are collapsed in a fresh vault, so
 * the selected note has no `notes.row` at all and `selectedNoteId` can only
 * time out, which is a real property of the app rather than a bug, and the first
 * version of this file spent 45 s per run discovering it.
 */
async function noteIds(s: Session): Promise<string[]> {
  const reply = await pageSeatInvoke(s, "plugin:notes|note_list", {}, 15_000);
  if (!Array.isArray(reply.ok)) {
    throw new Error(`note_list did not answer with a list: ${JSON.stringify(reply)}`);
  }
  return (reply.ok as string[]).slice().sort();
}

/** Run one period's palette action and wait until the vault has settled. */
async function openPeriod(
  s: Session,
  actionId: string,
  query: string,
  expectedCount: number,
): Promise<string[]> {
  await runPaletteAction(s, actionId, query);
  // WAIT for the count rather than reading once: the action lists every note,
  // may create one, and only then opens it, so a single read races the create.
  return await s.waitUntil(
    async () => {
      const ids = await noteIds(s);
      return ids.length === expectedCount ? ids : null;
    },
    { label: `${actionId} settled at ${expectedCount} notes` },
  );
}

describeE2E("pn1 each period opens its own note, idempotently (myne-md/myne#177)", () => {
  // Vault-count precondition: 1 (weak KDF). No `exportSuite`: this feature
  // touches no attachment surface, and a period note is an ordinary note.
  it("creates on first run, opens the same note on the second, and keeps the three apart", async () => {
    let password = "";
    await scenario(
      "pn1-periodic-open-idempotent",
      {
        seed: (dir) => void (password = seedVault(dir).password),
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        // One ordinary note first, so the counts below start from a vault that
        // is not empty and a period note cannot be confused with the seed.
        await createNote(s, "Sıradan Not");
        const before = await noteIds(s);

        // First run: each period CREATES, and the three create three distinct
        // notes. The defaults do not collide (`Daily/` + `YYYY-MM-DD`,
        // `Weekly/` + `gggg-[W]ww`, `Monthly/` + `YYYY-MM`), so a period whose
        // resolver ignored its period would land on another's note and the
        // count would stop growing.
        let expected = before.length;
        for (const [label, actionId, query] of PERIOD_ACTIONS) {
          expected += 1;
          const ids = await openPeriod(s, actionId, query, expected);
          if (ids.length !== expected) {
            throw new Error(`${label}: expected ${expected} notes, got ${ids.length}`);
          }
        }
        const afterFirstRun = await noteIds(s);
        if (afterFirstRun.length !== before.length + 3) {
          throw new Error(
            `three periods must create three notes, went from ${before.length} to ${afterFirstRun.length}`,
          );
        }

        // Second run: each period OPENS, creating nothing. This is the whole
        // idempotence claim, and it goes through disk and the real note list
        // rather than through an array literal. The id SET must be unchanged,
        // not merely the count: a run that created one note and trashed another
        // would keep the count and is not what this asserts.
        for (const [label, actionId, query] of PERIOD_ACTIONS) {
          const ids = await openPeriod(s, actionId, query, afterFirstRun.length);
          if (ids.join(",") !== afterFirstRun.join(",")) {
            throw new Error(`${label}: the second run changed the note set`);
          }
        }
      },
    );
  });
});
