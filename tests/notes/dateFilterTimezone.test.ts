// A saved view's result set does not move with the machine's timezone —
// myne-md/myne#557, the `views.saved-views` bullet.
//
// The roster row asked a person to set the machine to a far-away timezone,
// re-run a saved view with a date-ish filter and check that no note entered or
// left the set. That is a reboot, a per-release walk, and a judgement about a
// list — and it is answerable two ways at once, both of which are cheap:
//
// **By construction.** The filter AST is a CLOSED leaf set with no time-relative
// member: no `today`, no `withinDays`, no `since`. A date filter is a `property`
// leaf comparing a frontmatter string against a literal string, and string
// comparison has no calendar in it. The engine that evaluates it
// (`editor/src/host/notes/queryEngine.ts`, 641 lines shared by desktop and
// mobile) reads no clock at all — no `new Date`, no `Date.now`, no `Intl`, no
// timezone. There is nothing for a timezone to perturb.
//
// **By observation.** The set comparison the roster row wanted, run for real:
// the same view over the same notes under several `TZ` settings, asserted
// byte-identical. That half is what keeps the construction argument honest — the
// day somebody adds a clock read to the engine, the sets diverge and this fails,
// rather than the closed-leaf-set assertion quietly continuing to be true about
// a leaf set that grew a `today`.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runView,
  type FilterNode,
  type RunViewContext,
  type StoredProperty,
  type ViewDefinition,
  type ViewResult,
} from "../../src/notes/queryEngine";

const REPO_ROOT = process.cwd();

// ── the corpus ──────────────────────────────────────────────────────────────

/** Notes whose `due` property straddles a day boundary in both directions. */
const NOTES: ReadonlyArray<{
  id: string;
  title: string;
  folder: string | null;
  due: string;
}> = [
  { id: "n1", title: "Yesterday", folder: "Work/", due: "2026-03-09" },
  { id: "n2", title: "Today", folder: "Work/", due: "2026-03-10" },
  { id: "n3", title: "Tomorrow", folder: "Work/", due: "2026-03-11" },
  // The two that would move first if a comparison ever formed a local instant:
  // a date whose UTC midnight is the previous day west of Greenwich, and one
  // whose UTC midnight is the next day east of it.
  { id: "n4", title: "Edge west", folder: null, due: "2026-01-01" },
  { id: "n5", title: "Edge east", folder: null, due: "2026-12-31" },
];

function ctx(): RunViewContext {
  const props = new Map<string, StoredProperty>(
    NOTES.map((n) => [
      n.id,
      // `as unknown as` because `StoredProperty` is a discriminated union whose
      // text arm carries more than these two members; the evaluator reads only
      // these, and widening the fixture would put this file in the way of every
      // future member.
      { type: "text", value: n.due } as unknown as StoredProperty,
    ]),
  );
  return {
    liveIds: new Set(NOTES.map((n) => n.id)),
    resolvers: {
      hasTag: async () => [],
      inFolder: async (path: string) =>
        NOTES.filter((n) => n.folder === path).map((n) => n.id),
      search: async () => [],
      propertyValues: async (key: string) =>
        key === "due" ? [...props.entries()] : [],
    } as unknown as RunViewContext["resolvers"],
    rowFor: (id: string) => {
      const n = NOTES.find((x) => x.id === id)!;
      return { title: n.title, folder: n.folder };
    },
    recencyFallback: (ids) => [...ids].sort(),
  };
}

/** A date filter written the only way the AST allows: a string comparison. */
const dateFilter = (op: "==" | ">" | "<" | ">=" | "<=", value: string): FilterNode => ({
  kind: "property",
  key: "due",
  op,
  value,
});

const VIEWS: ReadonlyArray<[label: string, def: ViewDefinition]> = [
  ["due == 2026-03-10", { filter: dateFilter("==", "2026-03-10") }],
  ["due >= 2026-03-10", { filter: dateFilter(">=", "2026-03-10") }],
  ["due < 2026-03-10", { filter: dateFilter("<", "2026-03-10") }],
  [
    "due in a range",
    {
      filter: {
        kind: "and",
        children: [dateFilter(">=", "2026-03-09"), dateFilter("<=", "2026-03-11")],
      },
      sort: { key: "due", direction: "asc" },
      columns: ["due"],
    },
  ],
  [
    "grouped by due",
    { filter: { kind: "all" }, groupBy: "due", sort: { key: "due", direction: "asc" } },
  ],
];

/** The note ids a view yields, in render order. */
function idsOf(result: ViewResult): string[] {
  return result.groups.flatMap((g) => g.rows.map((r) => r.noteId));
}

// ── 1. By observation: the set does not move with TZ ────────────────────────

/**
 * Zones chosen to span every axis a date comparison could accidentally pick up:
 * a whole-day-ahead offset, a whole-day-behind one, a half-hour offset, a
 * 45-minute one, a southern-hemisphere DST schedule, and UTC as the control.
 */
const ZONES = [
  "UTC",
  "Pacific/Kiritimati", // UTC+14 — the furthest ahead there is
  "Pacific/Midway", // UTC-11
  "Asia/Kolkata", // UTC+05:30
  "Asia/Kathmandu", // UTC+05:45
  "Australia/Sydney", // southern DST
  "America/Los_Angeles", // northern DST
];

const ORIGINAL_TZ = process.env.TZ;

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("no note enters or leaves a saved view because of the timezone", () => {
  it("the TZ override actually takes effect in this process", () => {
    // Without this the sweep below would compare seven identical runs under one
    // zone and report agreement — the shape of a check that measures nothing.
    process.env.TZ = "UTC";
    const utc = new Date(Date.UTC(2026, 2, 10, 12)).getHours();
    process.env.TZ = "Asia/Kolkata";
    const kolkata = new Date(Date.UTC(2026, 2, 10, 12)).getHours();
    expect(
      utc === kolkata,
      "process.env.TZ did not change local-time resolution on this runtime, " +
        "so the sweep below proves nothing",
    ).toBe(false);
  });

  it.each(VIEWS)("%s yields the same rows under every zone", async (_label, def) => {
    const seen = new Map<string, string[]>();
    for (const zone of ZONES) {
      process.env.TZ = zone;
      seen.set(zone, idsOf(await runView(def, ctx())));
    }
    const [first, ...rest] = [...seen.entries()];
    for (const [zone, ids] of rest) {
      expect(ids, `${zone} disagrees with ${first[0]}`).toEqual(first[1]);
    }
    // …and the view actually selected something, so seven empty sets cannot
    // agree their way to a pass.
    expect(first[1].length, `${_label} selected nothing under any zone`).toBeGreaterThan(
      0,
    );
  });

  it("the grouped shape is identical too, not just the flattened ids", async () => {
    // Grouping keys are the values themselves; a zone-sensitive formatter
    // anywhere in the group path would split one group into two without
    // changing which notes are in the result.
    const def = VIEWS.find(([l]) => l === "grouped by due")![1];
    const shapes: string[] = [];
    for (const zone of ZONES) {
      process.env.TZ = zone;
      const r = await runView(def, ctx());
      shapes.push(JSON.stringify(r.groups.map((g) => [g.key, g.type, g.rows.length])));
    }
    expect(new Set(shapes).size, `saw ${shapes.length} shapes: ${shapes.join(" | ")}`).toBe(
      1,
    );
  });
});

// ── 2. By construction: there is nothing for a zone to perturb ──────────────

describe("the filter AST has no time-relative leaf", () => {
  const ENGINE = readFileSync(
    join(REPO_ROOT, "editor/src/host/notes/queryEngine.ts"),
    "utf8",
  );

  it("reads the engine it claims to check", () => {
    expect(ENGINE.length).toBeGreaterThan(5_000);
    expect(ENGINE).toContain("export async function runView");
  });

  it("the closed leaf set contains no clock-reading kind", () => {
    // The AST is an allow-list — "deliberately no arithmetic / map / computed
    // node". A `today` or `withinDays` leaf would be the one way a saved view
    // could legitimately depend on when it is run, and there is none.
    const leafBlock = ENGINE.slice(
      ENGINE.indexOf("export type FilterLeaf"),
      ENGINE.indexOf("export type FilterNode"),
    );
    const kinds = [...leafBlock.matchAll(/kind:\s*"([a-zA-Z]+)"/g)].map((m) => m[1]);
    expect(kinds.length, "no leaf kinds parsed — the scan is stale").toBeGreaterThan(5);
    for (const forbidden of ["today", "now", "withinDays", "since", "relativeDate", "age"]) {
      expect(
        kinds.includes(forbidden),
        `the filter AST grew a "${forbidden}" leaf. A view that depends on when ` +
          `it is run depends on the machine's calendar, and this file's whole ` +
          `argument stops holding — re-derive the roster row rather than ` +
          `deleting this assertion.`,
      ).toBe(false);
    }
  });

  it("the engine reads no clock at all", () => {
    // Comments stripped first: the module's header discusses dates in prose.
    const code = ENGINE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const token of ["new Date", "Date.now", "Intl.", "timeZone", "getTimezoneOffset"]) {
      expect(
        code.includes(token),
        `the shared query engine reads \`${token}\`. Once it does, a saved ` +
          `view's result set can move with the machine's clock or zone, which ` +
          `is exactly the manual check this file retired.`,
      ).toBe(false);
    }
  });

  it("a date comparison is a STRING comparison, so it has no calendar in it", async () => {
    // The positive statement behind the negatives above: `>=` over
    // `2026-03-10` sorts lexicographically, and ISO-8601 dates sort
    // lexicographically in calendar order. That is why no zone is consulted.
    process.env.TZ = "Pacific/Kiritimati";
    const r = await runView({ filter: dateFilter(">=", "2026-03-10") }, ctx());
    expect(idsOf(r).sort()).toEqual(["n2", "n3", "n5"]);
    process.env.TZ = "Pacific/Midway";
    const r2 = await runView({ filter: dateFilter(">=", "2026-03-10") }, ctx());
    expect(idsOf(r2).sort()).toEqual(["n2", "n3", "n5"]);
  });
});

beforeEach(() => {
  process.env.TZ = "UTC";
});
