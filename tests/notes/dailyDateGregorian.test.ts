/**
 * A daily note's title is the Gregorian date the format asked for, on every
 * machine — myne-md/myne#557, the `notes.daily-notes` / `settings.block.daily-notes`
 * bullet:
 *
 *   > the locale is settable in-process (`th-TH` resolves to the Buddhist
 *   > calendar in ICU), so "the title is still the Gregorian date the format
 *   > asked for" runs without touching any OS setting.
 *
 * # The walk this retires, and why it was worth walking
 *
 * The roster row asked someone to set the machine's language to Thai (or
 * Arabic, or Persian) and check that a daily note was still called
 * `2026-08-22`. That sounds like paranoia until you see what ICU actually does
 * with those locales — measured here on this machine's Node, for the instant
 * these tests use:
 *
 *     th-TH → 22/8/2569        (Buddhist era: the year is 543 higher)
 *     ar-EG → ٢٢‏/٨‏/٢٠٢٦       (Arabic-Indic digits, plus RTL marks)
 *
 * A daily note is found again by matching its TITLE against the format
 * (`resolveTodayNote` in the same module). So a title formatted through the
 * host locale does not merely look unusual: `2569-08-22` and `2026-08-22` are
 * different titles, a Thai user's notes would not be findable by any other
 * client, and a locale change would orphan every note written before it — the
 * vault silently splits in two and "open today's note" starts creating a second
 * one every day.
 *
 * # What actually protects it, and what this pins
 *
 * `formatDailyDate` builds the string from `getFullYear()` / `getMonth()` /
 * `getDate()`, which are defined on the proleptic Gregorian calendar and take
 * no locale — the same property `core/tests/search_casefold_locale.rs` relies on
 * for `str::to_lowercase`. It is true because of which primitive was chosen,
 * and one `toLocaleDateString()` would end it. Both halves are asserted: the
 * output, and the absence of any locale-aware formatter on the path.
 *
 * The Thai and Arabic figures above are recomputed in the test rather than
 * hard-coded, so this file cannot quietly stop demonstrating a real divergence
 * on a Node build with a different ICU.
 *
 * # Which half caught the injection, and why that settles the design
 *
 * Verified by replacing the year with
 * `new Intl.DateTimeFormat(undefined, { year: "numeric" }).format(now)` — the
 * one-line change somebody makes to "respect the user's locale". Only the
 * last test failed. Every assertion about the OUTPUT stayed green, because the
 * machine this ran on resolves to `tr_TR`, which is Gregorian with ASCII
 * digits, so the broken implementation and the correct one are indistinguishable
 * from here.
 *
 * That is the whole argument for keeping the source check: an output test can
 * only ever see the runner's own locale, and the users this breaks are on the
 * locales no CI machine is ever set to.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatDailyDate, DEFAULT_DAILY_DATE_FORMAT } from "../../src/notes/dailyNote";

// A midday UTC instant, so no plausible test-runner timezone moves the local
// calendar date off 2026-08-22.
const NOON = new Date("2026-08-22T12:00:00Z");

// `process.cwd()` rather than `import.meta.url`: under jsdom the module URL is
// served as `/@fs/…`, which `fileURLToPath` turns into a path that does not
// exist. Vitest runs from the repo root.
const SOURCE = readFileSync(join(process.cwd(), "src/notes/dailyNote.ts"), "utf8");

describe("the daily-note title is Gregorian and ASCII whatever the host locale is", () => {
  it("formats the default pattern as the Gregorian date", () => {
    expect(formatDailyDate(NOON, DEFAULT_DAILY_DATE_FORMAT)).toBe("2026-08-22");
  });

  it("the locales that would break it really do disagree", () => {
    // Non-vacuity, and the whole reason the row existed. If ICU ever stopped
    // diverging here, the assertions below would still pass and would be
    // proving nothing — so the divergence is measured, not assumed.
    const thai = new Intl.DateTimeFormat("th-TH", { timeZone: "UTC" }).format(NOON);
    const arabic = new Intl.DateTimeFormat("ar-EG", { timeZone: "UTC" }).format(NOON);

    expect(
      thai,
      "th-TH no longer resolves to the Buddhist calendar in this Node's ICU, so " +
        "this file is no longer demonstrating the failure it exists for",
    ).toContain("2569");
    expect(
      /[٠-٩]/.test(arabic),
      "ar-EG no longer renders Arabic-Indic digits in this Node's ICU, same problem",
    ).toBe(true);

    // …and the implementation agrees with neither.
    const ours = formatDailyDate(NOON, DEFAULT_DAILY_DATE_FORMAT);
    expect(ours).not.toContain("2569");
    expect(/^[0-9-]+$/.test(ours), "the title carries a non-ASCII digit").toBe(true);
  });

  it("keeps every separator variant Gregorian too", () => {
    // The format is user-editable, so the token substitution is what has to be
    // locale-free, not one particular pattern.
    expect(formatDailyDate(NOON, "YYYY/MM/DD")).toBe("2026/08/22");
    expect(formatDailyDate(NOON, "DD.MM.YYYY")).toBe("22.08.2026");
    expect(formatDailyDate(NOON, "Günlük YYYY-MM-DD")).toBe("Günlük 2026-08-22");
  });

  it("crosses a year boundary on the Gregorian calendar, not a shifted one", () => {
    // A Buddhist-era formatter would answer 2569/2570 here; the point is that
    // the boundary is in the same place for every user.
    expect(formatDailyDate(new Date("2026-12-31T12:00:00Z"), "YYYY-MM-DD")).toBe("2026-12-31");
    expect(formatDailyDate(new Date("2027-01-01T12:00:00Z"), "YYYY-MM-DD")).toBe("2027-01-01");
  });

  it("consults no locale-aware date formatter anywhere on the path", () => {
    // The mechanism, not the output. A `toLocaleDateString()` that happened to
    // agree with Gregorian on the runner's own locale would pass every
    // assertion above and fail on a Thai user's machine — which is precisely
    // the bug nobody catches, because the developer's machine is not Thai.
    for (const forbidden of ["Intl.", "toLocaleDateString", "toLocaleString", "toLocaleTimeString"]) {
      expect(
        SOURCE.includes(forbidden),
        `src/notes/dailyNote.ts reaches for \`${forbidden}\`. A daily note is found ` +
          `again by matching its TITLE, so a locale-formatted one is a different ` +
          `note: a Thai user's titles land in the Buddhist era, nothing else in ` +
          `the vault matches them, and changing the machine's language orphans ` +
          `every daily note written before the change.`,
      ).toBe(false);
    }
  });
});
