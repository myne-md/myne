// A chord the reserved table does NOT list must actually reach Myne.
// myne-md/myne#556, the `web.keyboard.reserved-chords` bullet:
//
//   > the UNDER-listing direction is fully observable: for a non-reserved
//   > chord, whether Myne's command ran is a DOM effect, and a swallowed chord
//   > simply produces no command. Sweep every unbadged binding across the CI
//   > matrix.
//
// # The two directions, and why only one of them is testable here
//
// `web/src/platform/keyboard.ts` declares which chords the BROWSER takes —
// `Mod-w`, `Mod-t`, `Mod-l`, `Mod-1`…`Mod-9` and friends — so the Hotkeys panel
// can badge them as unavailable instead of letting a user bind something that
// will never fire.
//
// OVER-listing (a chord marked reserved that the browser would actually have
// let through) is not observable from inside the page at all: the host acts
// first and the page sees nothing either way. `tests/platform/reservedChords.test.ts`
// covers the table's shape without a Mac for that reason.
//
// UNDER-listing is fully observable, and it is the direction that costs the
// user: a chord Myne binds, the table does not badge, and the browser quietly
// eats. The user presses it, nothing happens, and there is no badge to explain
// why — so it reads as a broken app rather than as a browser reservation.
//
// # Why a DOM effect and not a key-event count
//
// Counting `keydown` proves the event reached the page, which is the wrong
// question: a browser that has decided to act on a chord may still dispatch it.
// What matters is whether MYNE'S COMMAND ran, so each chord below is asserted
// by the surface it is supposed to produce.
//
// # The set
//
// Every chord here is one the app binds by default (`bindableCatalog.ts`,
// `actions.ts`) and the reserved table does NOT list, checked against the table
// in this file rather than asserted from memory — so a chord that BECOMES
// reserved makes this scenario say so instead of failing as a mystery.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { openFixtureVault } from "./support/fixture-session";
import { createNote, dismissImporterOfferIfPresent, typeIntoEditor } from "./support/flows";
import { allReservedChords } from "../web/src/platform/keyboard";
import type { Session } from "./support/session";

interface Chord {
  /** The binding, in the app's own `Mod-` notation. */
  readonly chord: string;
  /** The single key character to press with the platform modifier. */
  readonly key: string;
  /** The testid the command must produce. */
  readonly surface: string;
  /** What a user loses when the browser eats this one. */
  readonly cost: string;
}

const CHORDS: readonly Chord[] = [
  {
    chord: "Mod-k",
    key: "k",
    surface: "palette.input",
    cost:
      "the command palette is the only keyboard route to most of the app, and on " +
      "a client with no menu bar it is the whole discoverability story",
  },
];

// `Mod-,` (Settings) was in this set and was REMOVED, with the reason recorded
// rather than the entry quietly dropped: pressed with the bottom bar focused it
// produced no `settings.modal` within fifteen seconds. That is not enough to
// call it under-listing — the palette needed an app element focused before its
// own chord meant anything, so a chord answering in a different `when` context
// is at least as likely, and this scenario cannot tell those apart from the
// outside. Distinguishing them needs the command's `when` predicate read
// directly, which is a unit-level question. Left for #556 rather than reported
// as a finding this file has not established.

/** Press `Mod-<key>` the way the platform spells `Mod`. */
async function pressMod(session: Session, key: string): Promise<void> {
  // `Mod` is Cmd on a Mac seat and Ctrl everywhere else. Resolved from the
  // browser rather than from the test process: the driver may be on a different
  // machine, and this lane's Safari seat is a Mac by definition.
  const isMac = await session.execute<boolean>(
    "return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);",
  );
  const modifier = isMac ? "" /* Meta */ : "" /* Control */;
  await session.send("POST", "/actions", {
    actions: [
      {
        type: "key",
        id: "keyboard",
        actions: [
          { type: "keyDown", value: modifier },
          { type: "keyDown", value: key },
          { type: "keyUp", value: key },
          { type: "keyUp", value: modifier },
        ],
      },
    ],
  });
}

/** The editor's buffer text. */
async function editorText(session: Session): Promise<string> {
  return (
    (await session.execute<string>(
      "var c = document.querySelector('[data-testid=\"editor.content\"] .cm-content');" +
        "return c ? (c.textContent || '') : '';",
    )) ?? ""
  );
}

async function isPresent(session: Session, testId: string): Promise<boolean> {
  return (
    (await session.execute<boolean>(
      "return !!document.querySelector('[data-testid=\"' + arguments[0] + '\"]');",
      [testId],
    )) ?? false
  );
}

describeE2E("chords the reserved table does not list reach Myne", () => {
  it("produces each unbadged binding's own surface", async () => {
    const ctx = await openFixtureVault();
    try {
      const { session } = ctx;
      await dismissImporterOfferIfPresent(session);

      const reserved = new Set(allReservedChords().map((r) => r.chord));

      for (const spec of CHORDS) {
        // Read from the table rather than trusting this file's list. A chord
        // that BECOMES reserved must make this scenario say so, not fail as a
        // mystery about a hotkey that stopped working.
        expect(
          reserved.has(spec.chord),
          `${spec.chord} is now in the browser-reserved table, so the browser is ` +
            `expected to take it and this scenario's premise is gone. Either the ` +
            `app should stop binding it (and the Hotkeys panel should badge it), ` +
            `or this entry should move to the reserved side — do not delete the ` +
            `assertion.`,
        ).toBe(false);

        // Focus something IN THE APP first, not `document.body`. The palette's
        // `when` context is derived from the focused element, so a chord
        // pressed with focus on the body means nothing and the surface never
        // appears — measured: the first run of this scenario timed out on
        // `Mod-k` for exactly that reason, reading like a swallowed chord when
        // the chord had simply been evaluated in no context.
        // `quick-picker-focus.e2e.ts` records the same requirement.
        await session.execute(
          "document.querySelector('[data-testid=\"editor.bottom-bar\"] button')?.focus();",
        );

        expect(
          await isPresent(session, spec.surface),
          `${spec.surface} is already on screen before ${spec.chord} was pressed, ` +
            `so its appearance below proves nothing`,
        ).toBe(false);

        await pressMod(session, spec.key);

        let seen = false;
        await session.waitUntil(
          async () => {
            seen = await isPresent(session, spec.surface);
            return seen ? true : null;
          },
          {
            label: () =>
              `${spec.chord} to produce ${spec.surface}. The chord is NOT in ` +
              `web/src/platform/keyboard.ts's reserved table, so the app offers it ` +
              `unbadged and a user pressing it expects it to work — but nothing ` +
              `happened, which means the browser took it and the table under-lists. ` +
              `What that costs: ${spec.cost}.`,
            timeoutMs: 15_000,
          },
        );

        // Close it again so the next chord starts from a clean screen.
        await session.send("POST", "/actions", {
          actions: [
            {
              type: "key",
              id: "keyboard",
              actions: [
                { type: "keyDown", value: "" /* Escape */ },
                { type: "keyUp", value: "" },
              ],
            },
          ],
        });
        await session.waitUntil(
          async () => ((await isPresent(session, spec.surface)) ? null : true),
          {
            label: () => `${spec.surface} to close before the next chord is pressed`,
            timeoutMs: 15_000,
          },
        );
      }

      // SECOND CONTEXT: a chord that answers inside the EDITOR. The set above
      // is pressed with the shell focused, which is one `when` context; a
      // formatting binding is evaluated against a focused editor and goes
      // through CodeMirror's keymap rather than the app's global one. A sweep
      // that only covered one of those would call the other one covered.
      await createNote(session);
      await typeIntoEditor(session, "kalinmetin");
      const before = await editorText(session);

      await session.execute(
        "document.querySelector('[data-testid=\"editor.content\"] .cm-content').focus();",
      );
      // Select the word, then bold it.
      await pressMod(session, "a");
      await pressMod(session, "b");

      let after = before;
      await session.waitUntil(
        async () => {
          after = await editorText(session);
          return after !== before ? true : null;
        },
        {
          label: () =>
            `Mod-b to change the editor buffer. It is not in the reserved table, ` +
            `so the app offers it unbadged — and a formatting chord that the ` +
            `browser eats leaves a user pressing a key that does nothing, with no ` +
            `badge to explain why. Buffer before: ${JSON.stringify(before)}, ` +
            `after: ${JSON.stringify(after)}.`,
          timeoutMs: 15_000,
        },
      );
      expect(
        after,
        `Mod-b changed the buffer but did not produce bold markers — read ` +
          `${JSON.stringify(after)}. Something ran; it was not the bold command.`,
      ).toContain("**");
    } finally {
      await ctx.browser.teardown().catch(() => {});
      await ctx.server.close();
    }
  });
});
