// ios1 — no bottom-bar control is clipped or overlapping, in any language.
// myne-md/myne#555, the `app.language-and-i18n` bullet:
//
//   > clipping and overlap are measurable: per screen, assert no control has
//   > `scrollWidth > clientWidth` on its label and no two interactive boxes
//   > intersect, swept per language, with a named debt baseline as
//   > `a11y-axe.e2e.ts` does.
//
// # The walk this retires, and why it is never actually walked
//
// Switch the UI to each language in turn and look for text running out of its
// button. Thirty-two languages, one screen at a time, by eye. Nobody does this
// per release, and the one time somebody does they check three languages they
// can read.
//
// # Why the BOTTOM BAR and not "per screen"
//
// The bullet says per screen; this scenario takes one surface and takes it
// seriously, because a sweep that covers everything shallowly reports overlap
// between a container and its own child and is then quietly weakened until it
// reports nothing.
//
// The bottom bar is the right first surface: it is a single horizontal row of
// text-labelled controls with no wrapping, on every screen after unlock, and it
// is where a language with long compounds actually runs out of room. German
// `Arbeitsbereich` against English `Workspace` is the shape of it.
//
// # The two measurements
//
// **Clipping** is `scrollWidth > clientWidth` on the control itself: the text
// is wider than the box that shows it, so the user reads a truncated label with
// no ellipsis to tell them so.
//
// **Overlap** is a rect intersection between two SIBLING bar items. Restricted
// to siblings on purpose — a parent and its child overlap by definition, and a
// pairwise sweep over every element on screen reports that as a violation and
// teaches the reader to ignore the output.
//
// # The languages
//
// Four, not thirty-two: English as the baseline plus the three that push widest
// in this UI's vocabulary (German compounds, Finnish agglutination, Russian's
// longer words for the same concepts). A full sweep is a switch and a settle
// per language, and thirty-two of those buys very little over the widest four —
// what it would buy is a slower gate, which is how a gate stops being run.
//
// The set is a constant, so adding a language that turns out to overflow is one
// line rather than a new scenario.
//
// # Debt baseline
//
// Empty today, and it is a `Set` rather than a boolean so a real pre-existing
// overflow can be recorded by NAME and shrink, the way `a11y-axe.e2e.ts` does.
// A baseline that starts empty is the honest starting point: it says the sweep
// found nothing rather than that nothing was looked for.
//
// Vault-count precondition: 1 (weak KDF generator fixture).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import { createNote, dismissImporterOffer, openSettings, unlockToEditor } from "./support/flows";
import { type Session } from "./support/webdriver";

/** Language codes to sweep. English first, as the baseline the rest are
 *  compared against for "did the switch actually take". */
const LANGUAGES = ["en", "de", "fi", "ru"] as const;

/**
 * Controls allowed to be clipped or to overlap, as `"<lang>:<testid>"`.
 *
 * EMPTY, and a `Set` rather than a boolean so a real pre-existing overflow can
 * be recorded by name and shrink — the `a11y-axe.e2e.ts` shape. Adding an entry
 * is a decision with a reason next to it, not a way to make the gate quiet.
 */
const KNOWN_OVERFLOW_DEBT = new Set<string>([]);

interface BarItem {
  /** The inner control's testid, which is what a failure names. */
  readonly id: string;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  /** How much wider the content is than the box showing it. */
  readonly clipped: number;
  /** The rendered label. Captured so the sweep can PROVE the language changed
   *  — see the non-vacuity assertion at the end. */
  readonly text: string;
}

/** Measure every bottom-bar control. */
async function readBar(s: Session): Promise<BarItem[]> {
  const raw = await s.execute<string>(
    "var out = [];" +
      "document.querySelectorAll('[data-testid=\"editor.bar-item\"]').forEach(function (item) {" +
      "  var inner = item.querySelector('[data-testid]');" +
      "  var r = item.getBoundingClientRect();" +
      "  if (r.width <= 0 || r.height <= 0) return;" +
      // The clipping probe reads the deepest element that actually holds the
      // text, not the wrapper: a flex wrapper's scrollWidth tracks its child's
      // layout width, so it reports zero overflow for a child that is itself
      // clipping.
      "  var target = inner || item;" +
      "  out.push({" +
      "    id: inner ? inner.getAttribute('data-testid') : 'editor.bar-item'," +
      "    left: r.left, right: r.right, top: r.top, bottom: r.bottom," +
      "    clipped: Math.max(0, target.scrollWidth - target.clientWidth)," +
      "    text: (item.textContent || '').trim()" +
      "  });" +
      "});" +
      "return JSON.stringify(out);",
  );
  return JSON.parse(raw) as BarItem[];
}

/** Switch the UI language through the real Settings picker. */
async function pickLanguage(s: Session, code: string): Promise<void> {
  await openSettings(s, "appearance");
  await (await s.byTestId("settings.language-select")).click();
  await s.byTestId("settings.language-select-menu", { timeoutMs: 10_000 });
  // By `data-value`, not by endonym text. `rtl1` matches "العربية" because it
  // wants the Arabic entry specifically; a sweep matching four endonyms would
  // be four more strings to keep true, and the option already carries its code.
  await s.execute(
    "var o = document.querySelector(" +
      "  '[data-testid=\"settings.language-select-option\"][data-value=\"' + arguments[0] + '\"]'" +
      ");" +
      "if (!o) throw new Error('no language option for ' + arguments[0]);" +
      "o.click();",
    [code],
  );
  await s.waitUntil(
    async () =>
      (await s.execute<string>(
        "return document.documentElement.getAttribute('lang') || '';",
      )) === code
        ? true
        : null,
    {
      label: `<html lang> to become ${code} — without it the measurements below ` +
        `are all of the previous language`,
      timeoutMs: 15_000,
    },
  );
  await (await s.byTestId("settings.close")).click();
  await s.waitForGone('[data-testid="settings.modal"]');
}

describeE2E("ios1 no bottom-bar control clips or overlaps in any language (myne-md/myne#555)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("sweeps the widest four languages for clipped labels and intersecting boxes", async () => {
    let seeded: SeededVault;
    await scenario(
      "ios1-i18n-overflow",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);
        // A note, so the bar carries its full set — several items only render
        // with something open, and a sweep of the empty shell would miss them.
        await createNote(s, "ios1note");

        const seenLabels = new Map<string, string>();

        for (const code of LANGUAGES) {
          await pickLanguage(s, code);

          // Settle: the bar reflows on a language change and a single read can
          // land mid-layout.
          let items: BarItem[] = [];
          let prev = "";
          await s.waitUntil(
            async () => {
              const next = await readBar(s);
              const key = next.map((i) => `${i.id}@${Math.round(i.left)}`).join("|");
              const same = key === prev && next.length > 0;
              prev = key;
              items = next;
              return same ? true : null;
            },
            { label: `the bottom bar to settle in ${code}`, timeoutMs: 20_000 },
          );

          // NON-VACUITY. An empty bar passes every assertion below.
          expect(
            items.length,
            `the bottom bar rendered no measurable items in ${code}, so this ` +
              `language's pass says nothing`,
          ).toBeGreaterThan(2);

          // …and the switch actually changed the rendered text. A picker that
          // sets `<html lang>` without loading the catalog would leave English
          // labels in place, and every language would then "pass" by being
          // English.
          seenLabels.set(code, items.map((i) => i.text).join("|"));

          for (const item of items) {
            if (KNOWN_OVERFLOW_DEBT.has(`${code}:${item.id}`)) continue;
            expect(
              item.clipped,
              `${item.id} is clipped by ${Math.round(item.clipped)}px in "${code}": ` +
                `its content is wider than the box showing it, so the user reads a ` +
                `truncated label with nothing to say it was truncated. This is the ` +
                `failure a language with long compounds produces on a row that does ` +
                `not wrap.`,
            ).toBe(0);
          }

          // Pairwise, siblings only.
          for (let i = 0; i < items.length; i += 1) {
            for (let j = i + 1; j < items.length; j += 1) {
              const a = items[i]!;
              const b = items[j]!;
              if (KNOWN_OVERFLOW_DEBT.has(`${code}:${a.id}`)) continue;
              if (KNOWN_OVERFLOW_DEBT.has(`${code}:${b.id}`)) continue;
              const overlaps =
                a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
              expect(
                overlaps,
                `${a.id} and ${b.id} overlap in "${code}". Both are controls: ` +
                  `whichever is on top takes the click, so one of them is ` +
                  `unreachable and the user cannot tell which.`,
              ).toBe(false);
            }
          }
        }

        // NON-VACUITY FOR THE WHOLE SWEEP, and it is the assertion this
        // scenario rests on. If the picker sets `<html lang>` without the
        // catalog actually loading, every language renders ENGLISH — and then
        // four passes are one pass repeated, with the three that matter never
        // measured. The wait inside `pickLanguage` cannot see that: it watches
        // the attribute, which is exactly what would still be right.
        //
        // So the rendered TEXT of the bar is compared. The item ids are the same
        // in every language (it is the same UI), which is why the ids are not
        // what is compared.
        const english = seenLabels.get("en");
        expect(english, "the English pass did not run, so there is no baseline").toBeDefined();
        for (const code of LANGUAGES) {
          if (code === "en") continue;
          expect(
            seenLabels.get(code),
            `the bottom bar renders the SAME text in "${code}" as in English, so the ` +
              `catalog did not load and this language was never really swept. ` +
              `<html lang> was ${code} (waited for), which is what makes this ` +
              `failure invisible to the switch itself.`,
          ).not.toBe(english);
        }
      },
    );
  });
});
