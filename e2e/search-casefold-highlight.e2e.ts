// sch1 — the search result set does not depend on which `i` you typed, and the
// highlight marks what actually matched. myne-md/myne#555, the
// `search.command-palette` bullet:
//
//   > casefolding is Rust and host-locale-independent (`core/src/search/mod.rs`
//   > imports `default_lower`, `turkish_lower`, `fold_diacritics`), so the
//   > dotted/dotless-i result set is deterministic; the highlight half is
//   > assertable by reading the marked substring back.
//
// # The walk this retires
//
// Set the machine's language to Turkish, search for a word containing an `I`,
// and see whether you get the same notes. A reboot, once a release, on a
// machine somebody has to reconfigure — and the answer is decided by three pure
// Rust functions that take no locale at all.
//
// # What each half is for
//
// **The result set.** Turkish has four letters where English has two: `i`/`İ`
// and `ı`/`I`. A user who types `istanbul` must find a note titled `İSTANBUL`,
// and a user who types `ISPANAK` must find `ıspanak` — because they are the
// same word, and which of the four they reached for is a keyboard accident.
// `fold_diacritics` converges the family precisely so that search does not care.
//
// **The highlight.** A result row can be right and its `<mark>` wrong, and the
// wrong mark is worse than none: it tells the user the match is somewhere it is
// not, so they read the wrong sentence and conclude the search is broken. The
// marked substring is readable straight out of the DOM.
//
// # Why the Rust unit tests are not enough on their own
//
// `core/tests/search_casefold_locale.rs` (this branch) pins the three folding
// functions against a mutated `LANG`/`LC_ALL`, and `core/src/text.rs` pins the
// Turkish mappings. Both are about the FUNCTIONS. This is about the pipeline
// they sit in: a query is tokenized, folded, matched against a folded index, and
// rendered — and a fold applied on one side of that and not the other gives a
// perfect unit suite and an empty result list.
//
// # What it takes to make this fail, which is the interesting measurement
//
// Three injections into `core/src/search/mod.rs` did NOT fail it:
//
//   * deleting `fold_diacritics` from the INDEX side — because that fold is
//     attachment-only by design ("Note bodies are typed by the user and exact,
//     so they are not folded", `mod.rs`);
//   * deleting `fold_diacritics` from the query side — same reason;
//   * replacing `default_lower(token)` with the raw token.
//
// The third is the informative one. `query_expansions` builds FIVE candidate
// forms per token — raw, three stems, and the diacritic fold — and the Turkish
// stem is computed over `turkish_lower(token)`. So removing one fold leaves
// four other paths to the same posting: the expansion list is redundant on
// purpose, and single-fold removal is not a defect this scenario can see
// because it is not a defect the USER can see either.
//
// It fails when the expansion is removed WHOLESALE (verified), which is the
// level the claim is actually at: "the result set does not depend on which `i`
// you typed" is a property of the expansion, not of any one member of it.
//
// The consequence for reading this file: its value is the non-vacuity block
// below, not the equality assertions. Equality across four queries is
// satisfiable by a search that ignores the query, and the first version of this
// scenario was exactly that.
//
// Vault-count precondition: 1 (weak KDF generator fixture).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { KEY, pressChord } from "./support/keyboard";
import type { Session } from "./support/webdriver";

/** Open the palette from the keyboard and clear whatever is in it. */
async function openPalette(s: Session): Promise<void> {
  await pressChord(s, KEY.CONTROL, "k");
  await s.byTestId("palette.input", { timeoutMs: 15_000 });
}


/** The note ids the palette is currently offering, in order. */
async function noteHits(s: Session): Promise<string[]> {
  return (
    (await s.execute<string[]>(
      "return Array.prototype.slice.call(" +
        "  document.querySelectorAll('[data-testid=\"palette.option\"][data-note-id]')" +
        ").map(function (el) { return el.getAttribute('data-note-id'); });",
    )) ?? []
  );
}

/** Every `<mark>`ed substring inside the result snippets. */
async function markedText(s: Session): Promise<string[]> {
  return (
    (await s.execute<string[]>(
      "return Array.prototype.slice.call(" +
        "  document.querySelectorAll('[data-testid=\"palette.snippet\"] mark')" +
        ").map(function (el) { return el.textContent || ''; });",
    )) ?? []
  );
}

/** Type `query` into a freshly-opened palette and settle on a stable hit set. */
async function search(s: Session, query: string): Promise<string[]> {
  await openPalette(s);
  await (await s.byTestId("palette.input")).sendKeys(query);
  // Settle on the count holding still across two polls rather than on a fixed
  // number: the search is asynchronous and a scenario that asserted a count
  // immediately would be racing the query, not measuring it.
  let last = -1;
  let stable = 0;
  await s.waitUntil(
    async () => {
      const n = (await noteHits(s)).length;
      stable = n === last ? stable + 1 : 0;
      last = n;
      return stable >= 2 && n > 0 ? true : null;
    },
    { label: `the result set for ${JSON.stringify(query)} settled`, timeoutMs: 20_000 },
  );
  return await noteHits(s);
}

describeE2E("sch1 search folds the i-family and marks what matched (myne-md/myne#555)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("marks the substring that actually matched", async () => {
    let seeded: SeededVault;
    await scenario(
      "sch1-search-highlight",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // A body with the query word once, surrounded by text that must NOT be
        // marked. A highlight that marked the whole snippet, or the wrong span,
        // would still be a highlight.
        const NEEDLE = "kirlangic";
        await createNote(s, "Isaretleme");
        await typeIntoEditor(s, ` Bahcede bir ${NEEDLE} vardi ve ucup gitti.`);
        await waitForSaved(s);

        await search(s, NEEDLE);

        let marks: string[] = [];
        await s.waitUntil(
          async () => {
            marks = await markedText(s);
            return marks.length > 0 ? true : null;
          },
          {
            label: () =>
              `the result snippet to carry a <mark> — got ${JSON.stringify(marks)}. ` +
              `A row that is right with no highlight makes the user hunt for the ` +
              `match in a sentence the search already located.`,
            timeoutMs: 20_000,
          },
        );

        for (const mark of marks) {
          expect(
            mark.toLowerCase(),
            `the highlight marks ${JSON.stringify(mark)}, which is not the query. ` +
              `A wrong mark is worse than none: it points the reader at a span that ` +
              `did not match, so they read the wrong words and conclude the search ` +
              `is broken.`,
          ).toContain(NEEDLE);
          expect(
            mark.length,
            `the highlight spans ${mark.length} characters for a ${NEEDLE.length}-character ` +
              `query — the whole snippet is marked, which is the same as marking ` +
              `nothing`,
          ).toBeLessThan(NEEDLE.length + 8);
        }
      },
    );
  });
});
