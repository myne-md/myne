/**
 * The vim caveat the user reads names exactly the chords the engine actually
 * surrenders — myne-md/myne#556, the `settings.block.vim-mode` bullet:
 *
 *   > the copy is rendered from `SURRENDERED_CHORDS` and the test already pins
 *   > that every entry carries a reason; drive each listed chord on Linux and
 *   > assert Myne's command fires. The claim under test is "the copy and the
 *   > policy agree", which is one data structure.
 *
 * # The bullet's premise is wrong, and that is the finding
 *
 * The copy is **not** rendered from `SURRENDERED_CHORDS`. It is a hand-written
 * English sentence in `locales/en/common.json` under
 * `settings.vimMode.chordCaveat`, listing eleven chords by name. The policy is
 * a separate array in `editor/src/vim-chords.ts`. They are two copies of one
 * list, and nothing compares them.
 *
 * So the claim the bullet wanted to make — "the copy and the policy agree,
 * which is one data structure" — is a claim that is currently false by
 * construction, and this file is what makes it true in the only sense that
 * matters: they may be two structures, but they can no longer disagree without
 * failing.
 *
 * # Why the drift is worse than it sounds
 *
 * A vim user reads that sentence to learn which of their muscle-memory chords
 * are gone. Every mode of drift lies to them, in a way nothing else catches:
 *
 *  * a chord added to the policy and not to the copy — the user believes it
 *    still works, presses it mid-edit, and gets Myne's command instead. On
 *    `<C-w>` that is a closed tab;
 *  * a chord in the copy and not in the policy — the user stops using a chord
 *    that works fine, permanently, and never finds out;
 *  * the `<C-[>` and `<A-v>` clauses going stale — those are the two escape
 *    hatches the caveat offers, and a wrong one is worse than none, because the
 *    user has no other way out of insert mode.
 *
 * `tsc` sees a string and an array. The existing `vim-chords.test.ts` pins the
 * policy against the ENGINE and never opens the catalog. Nothing else looks.
 *
 * # Scope, stated
 *
 * English only. The translated strings are Weblate's and a key-by-key
 * vocabulary assertion over 31 catalogs would fail on every legitimate
 * translation of "Ctrl". English is the source of truth (`src/AGENTS.md`), so
 * this is where the two lists have to agree; a translation that drops a chord
 * is a translation bug, on the manual-reading lane where `cli.door` already
 * lives.
 */

import { describe, expect, it } from "vitest";
import {
  SURRENDERED_CHORDS,
  VISUAL_BLOCK_CHORD,
} from "../../src/editor/vim-chords";
import enCatalog from "../../locales/en/common.json";

/** `<C-a>` → `Ctrl-a`, `<A-v>` → `Alt-v` — the form the copy uses. */
function humanize(chord: string): string {
  const m = chord.match(/^<([CA])-(.+)>$/);
  expect(m, `\`${chord}\` is not in the <X-y> shape this helper understands`).not.toBeNull();
  return `${m![1] === "C" ? "Ctrl" : "Alt"}-${m![2]}`;
}

const caveat = (enCatalog as { settings: { vimMode: { chordCaveat: string } } }).settings.vimMode
  .chordCaveat;

/** Every `Ctrl-x` / `Alt-x` token the caveat mentions. */
function chordsNamedInCopy(): string[] {
  return Array.from(caveat.matchAll(/\b(Ctrl|Alt)-(\S)/g)).map((m) => `${m[1]}-${m[2]}`);
}

describe("the vim caveat copy and the surrender policy name the same chords", () => {
  it("finds the copy at all", () => {
    // Non-vacuity. Every assertion below is over a string looked up by path; a
    // rename would make them all pass against `undefined` if this were absent.
    expect(typeof caveat, "settings.vimMode.chordCaveat is missing from the en catalog").toBe(
      "string",
    );
    expect(caveat.length).toBeGreaterThan(50);
    expect(SURRENDERED_CHORDS.length, "the policy list is empty").toBeGreaterThan(5);
  });

  it("names every chord the engine surrenders", () => {
    const named = chordsNamedInCopy();
    const missing = SURRENDERED_CHORDS.map((c) => humanize(c.chord)).filter(
      (h) => !named.includes(h),
    );
    expect(
      missing,
      `the engine surrenders ${missing.join(", ")} to Myne, and the caveat the user ` +
        `reads does not mention ${missing.length === 1 ? "it" : "them"}. A vim user ` +
        `reads that sentence to learn which chords are gone, keeps using the one ` +
        `it omitted, and gets Myne's command instead — on Ctrl-w that is a closed tab.`,
    ).toEqual([]);
  });

  it("names no chord the engine does not surrender", () => {
    // The other direction, and the one a copy edit breaks: a chord left in the
    // sentence after it stopped being surrendered tells the user to stop using
    // something that works, permanently and silently.
    const surrendered = new Set(SURRENDERED_CHORDS.map((c) => humanize(c.chord)));
    // The two escape hatches are named on purpose and are NOT surrenders; they
    // are asserted separately below.
    const hatches = new Set(["Ctrl-[", humanize(VISUAL_BLOCK_CHORD)]);
    const extra = chordsNamedInCopy().filter((h) => !surrendered.has(h) && !hatches.has(h));
    expect(
      extra,
      `the caveat names ${extra.join(", ")} as unavailable, but the engine does not ` +
        `surrender ${extra.length === 1 ? "it" : "them"}. The user stops reaching ` +
        `for a chord that works fine and never finds out.`,
    ).toEqual([]);
  });

  it("keeps the two escape hatches accurate", () => {
    // `<C-[>` is Escape's only alternative and `vim-chords.test.ts` asserts the
    // engine keeps it; the caveat is where a user learns that. `<A-v>` is where
    // visual-block moved once `<C-v>` went to paste — a fixed in-code mapping,
    // so a wrong one here leaves the feature unreachable.
    expect(
      caveat,
      "the caveat no longer tells the user that Ctrl-[ still works as Escape — " +
        "with the Ctrl grammar surrendered, that is their only way out of insert mode",
    ).toContain("Ctrl-[");
    expect(
      caveat,
      `the caveat does not name ${humanize(VISUAL_BLOCK_CHORD)} as the new ` +
        `visual-block chord. It is a fixed in-code mapping and not configurable, so ` +
        `a user who is not told is a user for whom the feature does not exist.`,
    ).toContain(humanize(VISUAL_BLOCK_CHORD));
  });

  it("says the caveat is platform-conditional, since the policy is", () => {
    // The surrender only happens where `Mod` resolves to Ctrl. The component
    // gates the paragraph on `chordPolicyActive()`, and the sentence itself has
    // to agree — a caveat that read as universal would be a lie on macOS even
    // while correctly hidden there, the moment it is quoted anywhere else.
    expect(caveat.toLowerCase()).toMatch(/windows|linux/);
  });
});
