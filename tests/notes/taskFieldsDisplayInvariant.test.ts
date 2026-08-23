/**
 * What a task line STORES does not move when the display settings do —
 * myne-md/myne#557, the `editor.tasks-inline` bullet:
 *
 *   > there is no `weekInfo`/`firstDay` usage anywhere and date/time rendering
 *   > runs off a CLOSED in-app vocabulary (`src/lib/datetimeFormat.ts`), so the
 *   > first-day-of-week premise does not hold; picking a date under one format
 *   > and reading it back under another is a plain assertion.
 *
 * # The walk, and the premise it rested on
 *
 * The roster row asked someone to change the machine's regional settings — the
 * first day of the week, the short-date order — set a due date on a task, then
 * change them again and check the task still meant the same day. Behind it is
 * an assumption that the app consults the host's calendar conventions at all.
 *
 * It does not, and that is the first thing asserted here: nothing in any shared
 * tree reads `weekInfo`, `firstDay`, or a resolved `Intl.Locale`'s calendar
 * data. The bullet says the premise does not hold; a claim like that is worth
 * more as a check than as a sentence, because it is one convenience call away
 * from becoming false and the person making that call would have no idea a
 * roster row ever depended on it.
 *
 * # What replaces it
 *
 * The property that actually matters to a user is narrower and stronger: the
 * BYTES on the line are the same whatever the display settings are. Display is
 * a rendering of the stored value (`src/lib/datetimeFormat.ts`, a closed
 * vocabulary of presets), and `dialect/src/taskFields.ts` keeps stored times as
 * zone-free wall clock.
 *
 * If that ever stopped being true the damage would be quiet and cumulative:
 * a task written on a machine set to one convention and re-saved on another
 * would drift a day at a time, in a plain-text file the user can open, and
 * every device that syncs it would disagree. Nothing throws, and the round trip
 * looks right on whichever machine you check it on.
 *
 * So: parse a line, serialize it back, and require it byte-identical — under
 * every display format the app offers and several host zones. The serializer
 * takes no locale and no zone, which IS the property, and running it under
 * varied ambient settings is what would catch it starting to.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseTaskFields } from "../../src/dialect/taskFields";
import { serializeTaskFields } from "../../src/dialect/taskFieldWriter";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const REPO_ROOT = process.cwd();

/** The shared trees a display convention could leak into. */
const SHARED_TREES = ["src", "editor/src", "dialect/src", "web/src", "mobile/src"];

/** Lines a task line can be built from, covering every typed field plus the
 *  two verbatim classes the serializer must not touch. */
const LINES = [
  "- [ ] Kitap oku [due:: 2026-03-08]",
  "- [ ] Pay rent [due:: 2026-11-01] [priority:: high]",
  "- [ ] Standup [due:: 2026-03-29T09:30] [repeat:: every weekday]",
  "- [ ] Review [remind:: 2026-10-25T02:30] [due:: 2026-10-25]",
  "- [x] Shipped [done:: 2026-01-31T23:59] [due:: 2026-01-31]",
  // A field Myne recognizes and never interprets, and one that did not parse.
  // Both are emitted verbatim, so they are the sharpest test of "nothing was
  // reformatted on the way through".
  "- [ ] Carry me [due:: 2026-06-01] [onCompletion:: delete]",
  "- [ ] Broken [due:: not-a-date]",
] as const;

/** Every display setting the app offers, as the pref triples that drive
 *  `datetimeFormat`. The serializer takes none of them; the point is that
 *  varying them changes nothing. */
const DISPLAY_SETTINGS = [
  { dateFormat: "system", timeFormat: "system", timeZone: null },
  { dateFormat: "iso", timeFormat: "24h", timeZone: "UTC" },
  { dateFormat: "mdy", timeFormat: "12h", timeZone: "America/New_York" },
  { dateFormat: "dmy", timeFormat: "24h", timeZone: "Asia/Tokyo" },
  { dateFormat: "dmmmy", timeFormat: "12h", timeZone: "Pacific/Kiritimati" },
] as const;

/** Host zones with different offsets, DST behaviour and week conventions. */
const HOST_ZONES = ["UTC", "America/New_York", "Asia/Riyadh", "Pacific/Kiritimati"];

const REAL_TZ = process.env.TZ;
afterAll(() => {
  if (REAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = REAL_TZ;
});

describe("the stored bytes of a task line take no display setting", () => {
  it.each(LINES)("round-trips %s unchanged under every display setting", (line) => {
    const parsed = parseTaskFields(line);
    const baseline = serializeTaskFields(parsed);

    for (const settings of DISPLAY_SETTINGS) {
      for (const zone of HOST_ZONES) {
        process.env.TZ = zone;
        const again = serializeTaskFields(parseTaskFields(line));
        expect(
          again,
          `re-serialising under ${JSON.stringify(settings)} on a host in ${zone} ` +
            `produced "${again}" where the first pass produced "${baseline}". ` +
            `Stored task times are zone-free wall clock — a value that moves ` +
            `with the machine drifts a day at a time across a user's devices, ` +
            `in a plain-text file, with nothing reporting it.`,
        ).toBe(baseline);
      }
    }
  });

  it("keeps the day itself, not merely the byte string", () => {
    // Non-vacuity for the round trip: if `parseTaskFields` dropped every field
    // it would round-trip perfectly to an empty string. The dates have to still
    // be there, and be the ones that were written.
    const parsed = parseTaskFields("- [ ] Pay rent [due:: 2026-11-01] [priority:: high]");
    const out = serializeTaskFields(parsed);
    expect(out).toContain("2026-11-01");
    expect(out).toContain("high");
  });

  it("carries an uninterpreted field through verbatim", () => {
    // `onCompletion` is recognized and never acted on. A serializer that
    // normalized what it did not understand would silently rewrite a user's
    // data — and would still round-trip, on the second pass.
    const out = serializeTaskFields(
      parseTaskFields("- [ ] Carry me [due:: 2026-06-01] [onCompletion:: delete]"),
    );
    expect(out).toContain("[onCompletion:: delete]");
  });
});

describe("no shared tree consults the host's calendar conventions", () => {
  it("reads no weekInfo, firstDay, or resolved calendar data", () => {
    // The bullet's own correction, mechanised. Each of these is the API
    // somebody reaches for to "respect the user's regional settings", and each
    // one would make a stored value depend on the machine that wrote it.
    const forbidden = ["weekInfo", "firstDay", "getWeekInfo", "minimalDays"];
    const hits: string[] = [];
    for (const tree of SHARED_TREES) {
      for (const pattern of forbidden) {
        // `git grep` rather than a hand-rolled walk: it honours .gitignore, so
        // a stale build artefact under one of these roots cannot produce a
        // finding nobody can act on.
        let out = "";
        try {
          out = execFileSync(
            "git",
            ["grep", "-n", "--fixed-strings", pattern, "--", tree],
            { cwd: REPO_ROOT, encoding: "utf8" },
          );
        } catch {
          // `git grep` exits non-zero when there are no matches, which is the
          // expected case here.
          continue;
        }
        for (const l of out.split("\n").filter(Boolean)) hits.push(l);
      }
    }
    expect(
      hits,
      `a shared tree now reads the host's week conventions:\n${hits.join("\n")}\n` +
        `Date and time rendering runs off the closed preset vocabulary in ` +
        `src/lib/datetimeFormat.ts precisely so that what a user sees is a ` +
        `function of their Myne settings and what is STORED is a function of ` +
        `neither. A host-derived convention breaks the second half.`,
    ).toEqual([]);
  });

  it("the search would have found something if there were something", () => {
    // Verifies the search itself rather than trusting an empty result — an
    // empty answer from a broken query is indistinguishable from an empty
    // answer from a clean tree. `datetimeFormat` is a string that certainly IS
    // in `src`.
    const out = execFileSync(
      "git",
      ["grep", "-l", "--fixed-strings", "datetimeFormat", "--", "src"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    expect(out.split("\n").filter(Boolean).length).toBeGreaterThan(0);
  });

  it("the display vocabulary really is closed", () => {
    // The other half of the premise: presets, not a free-form pattern the host
    // could supply. A free-form format string would put the host's conventions
    // back in through a different door.
    //
    // Read at `editor/src/host/lib/`, which is where the module lives —
    // `src/lib/datetimeFormat.ts` is a one-line re-export shim, and a first
    // draft that read the shim was matching a file with no vocabulary in it.
    const source = readFileSync(`${REPO_ROOT}/editor/src/host/lib/datetimeFormat.ts`, "utf8");
    expect(source, "the date-format vocabulary is no longer a closed literal").toMatch(
      /export const DATE_FORMATS = \[[^\]]*\] as const;/,
    );
    expect(source, "the time-format vocabulary is no longer a closed literal").toMatch(
      /export const TIME_FORMATS = \[[^\]]*\] as const;/,
    );
    // The presets a regional setting would otherwise have supplied exist as
    // Myne's own choices, which is the substitution the bullet describes.
    for (const preset of ['"dmy"', '"mdy"', '"24h"', '"12h"']) {
      expect(source, `the ${preset} preset is gone`).toContain(preset);
    }
  });
});

beforeAll(() => {
  // Restored per-assertion above; set once here so a failure before the loop
  // still leaves a known value.
  process.env.TZ = REAL_TZ ?? "UTC";
});
