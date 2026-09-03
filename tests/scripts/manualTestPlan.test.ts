// Unit tests for `scripts/manual-test-plan.mjs` (myne-md/myne#548).
//
// This script decides whether a release stops, so it gets the same treatment as
// the guard beside it: every rule is broken on purpose and the break is asserted.
//
// Two of the cases below are REGRESSIONS FOUND BY RUNNING IT, not hypotheticals,
// and they are the reason this file exists rather than a shell transcript:
//
//   1. A row key is `entry.id#index@client`. The first parser's character class
//      stopped before the `@`, which still MATCHED (on the prefix), so every
//      client's verdict collapsed into the first one silently.
//   2. `OVERRIDE:` was read from the row's three joined lines so an annotation
//      could sit anywhere in the block. On the first real round trip it ran past
//      its own line and swallowed the item's `see` text into the recorded reason,
//      so the record said the release was overridden for a paragraph that was the
//      test instruction.

import { describe, expect, it } from "vitest";

import {
  BUDGET_MIN,
  blockingRows,
  buildPlan,
  changedSince,
  entryTouched,
  malformedRowLines,
  parseRows,
  planGatingCount,
  planRowCount,
  planVersion,
  rollUp,
} from "../../scripts/manual-test-plan.mjs";

/** What `parseTicked` used to be. Composed here rather than exported, because
 * `main()` needs the rows as well as the roll-up, so the alias had no production
 * caller and was kept alive by these tests alone. */
const parseTicked = (text: string) => rollUp(parseRows(text));

/** Gates the core tier on macOS only, so the linux and ios rows are the recorded-not-blocking half. */
const RATCHET = { gatedTiers: ["core"], gatedClients: ["desktop-macos"], totalMinutesCeiling: 15 };

const entry = (over = {}) => ({
  id: "notes.editor",
  title: "Note editor",
  paths: ["src/notes/", "src-tauri/src/plugins/notes/"],
  clients: ["desktop-macos", "desktop-linux", "ios"],
  automatedBy: [],
  manual: [
    {
      see: "Type a paragraph, close the window without saving, reopen. The paragraph is still there.",
      whyNotAutomated: "tauri-driver cannot kill the process the way the OS does on a force quit.",
      clients: ["desktop-macos", "desktop-linux", "ios"],
      estimateMin: 5,
      tier: "core",
    },
  ],
  exemptionReason: "",
  ...over,
});

const plan = (over: Record<string, unknown> = {}) =>
  buildPlan({ roster: [entry()], changed: null, verified: {}, version: "v0.6.0", since: null, ratchet: null, ...over });

describe("a row is one (item, client) pair", () => {
  it("emits one row per client, not one per item", () => {
    const body = plan();
    expect(body).toContain("notes.editor#0@desktop-macos");
    expect(body).toContain("notes.editor#0@desktop-linux");
    expect(body).toContain("notes.editor#0@ios");
    expect(body).toMatch(/\*\*3 rows across 3 client surfaces/);
  });

  it("counts minutes per client, so a three-client item is three sittings", () => {
    // 5 minutes on each of three clients is 15, not 5. Counting once per item is
    // how a roster reads as affordable when it is not.
    expect(plan()).toMatch(/0\.3 h estimated/);
    expect(plan({ roster: [entry({ clients: ["ios"], manual: [{ ...entry().manual[0], clients: ["ios"] }] })] })).toMatch(
      /\*\*1 rows across 1 client surfaces/,
    );
  });

  it("groups by client, because that is the order the work happens in", () => {
    const body = plan();
    const heads = [...body.matchAll(/^## (\S+) \(/gm)].map((m) => m[1]);
    expect(heads).toEqual(expect.arrayContaining(["desktop-macos", "desktop-linux", "ios"]));
  });
});

describe("the budget is reported, never enforced by trimming", () => {
  it("schedules everything and says so when the plan is over budget", () => {
    const heavy = entry({
      manual: [{ ...entry().manual[0], estimateMin: BUDGET_MIN }],
    });
    const body = plan({ roster: [heavy] });
    expect(body).toMatch(/over the .* budget, and nothing has been dropped to fit/);
    // Still all three rows: a shorter plan would report coverage the release did not have.
    expect(body).toContain("notes.editor#0@ios");
  });

  it("says nothing about the budget when the plan fits", () => {
    expect(plan()).not.toMatch(/over the .* budget/);
  });
});

describe("the ratchet decides which rows actually block", () => {
  it("marks a gated row as stopping the tag and an ungated one as recorded only", () => {
    const body = plan({ ratchet: RATCHET });
    expect(body).toMatch(/`notes\.editor#0@desktop-macos` \*\*\[core, 5 min, STOPS THE TAG\]/);
    expect(body).toMatch(/`notes\.editor#0@ios` \*\*\[core, 5 min, recorded, does not block yet\]/);
  });

  it("reports the two halves separately and does not hide the ungated one", () => {
    const body = plan({ ratchet: RATCHET });
    expect(body).toMatch(/\*\*1 of these rows \(0\.1 h\) STOP THE TAG\.\*\*/);
    expect(body).toMatch(/The other 2 rows \(0\.2 h\) are walked and recorded and do not block yet/);
  });

  it("measures the budget against the GATING half, not the whole plan", () => {
    // Whole plan is over budget, the gating half is not, so no warning fires.
    const heavy = entry({ manual: [{ ...entry().manual[0], estimateMin: BUDGET_MIN / 2 }] });
    expect(plan({ roster: [heavy], ratchet: RATCHET })).not.toMatch(/over the .* budget/);
  });

  it("treats every row as gating when no ratchet is given, so a caller cannot lose the gate by omission", () => {
    expect(plan()).toMatch(/\*\*3 of these rows/);
  });
});

describe("diff promotion", () => {
  it("promotes an entry whose directory path contains a changed file", () => {
    expect(entryTouched(entry(), ["src/notes/editor/Body.tsx"])).toBe(true);
  });

  it("promotes on a BACKEND path, which is the half the first roster was missing", () => {
    expect(entryTouched(entry(), ["src-tauri/src/plugins/notes/commands.rs"])).toBe(true);
  });

  it("does not promote on an unrelated file", () => {
    expect(entryTouched(entry(), ["web/src/main.tsx"])).toBe(false);
  });

  it("does not promote when there is no diff to read", () => {
    expect(entryTouched(entry(), null)).toBe(false);
  });

  it("labels promoted rows separately from standing ones", () => {
    const body = plan({ changed: ["src/notes/editor/Body.tsx"], since: "v0.5.0" });
    expect(body).toMatch(/diffed against `v0\.5\.0`/);
  });
});

describe("reading a ticked plan back", () => {
  const row = (key: string, state = " ", suffix = "") =>
    [
      `- [${state}] \`${key}\` **[core, 5 min]** Note editor (never verified)${suffix}`,
      "      Type a paragraph, close the window without saving, reopen.",
      "      *No machine can judge it:* tauri-driver cannot kill the process.",
    ].join("\n");

  it("records a ticked row as pass", () => {
    expect(parseTicked(row("notes.editor#0@ios", "x"))).toEqual({ "notes.editor": { verdict: "pass", reason: undefined } });
  });

  it("reads the whole key including the @client suffix", () => {
    // The regression: a character class that stopped at the `#` still matched the
    // prefix, so every client collapsed into one verdict with nothing reporting it.
    const text = [row("notes.editor#0@desktop-macos", "x"), row("notes.editor#0@ios", " ", "  FAIL:")].join("\n");
    expect(parseTicked(text)).toEqual({ "notes.editor": { verdict: "fail", reason: undefined } });
  });

  it("takes the WORST verdict across an entry's rows", () => {
    const text = [row("notes.editor#0@desktop-macos", "x"), row("notes.editor#0@ios", " ", "  FAIL:")].join("\n");
    const verdicts = parseTicked(text) as Record<string, { verdict: string }>;
    expect(verdicts["notes.editor"].verdict).toBe("fail");
  });

  it("rollUp orders pass below override below fail, whatever order the rows arrive in", () => {
    // Storing the best verdict, or the last one written, would let the record say
    // an entry passed at v0.6 when a client it names failed.
    const rows = [
      { entryId: "a", verdict: "fail", reason: undefined },
      { entryId: "a", verdict: "pass", reason: undefined },
      { entryId: "b", verdict: "pass", reason: undefined },
      { entryId: "b", verdict: "override", reason: "the host was down" },
    ] as never[];
    expect(rollUp(rows)).toEqual({
      a: { verdict: "fail", reason: undefined },
      b: { verdict: "override", reason: "the host was down" },
    });
  });

  it("records an override and keeps its reason to the row line", () => {
    // The regression: reading three joined lines let the reason swallow the see text.
    const text = row("notes.editor#0@ios", " ", "  OVERRIDE: the only macOS host was down this cycle");
    expect(parseTicked(text)).toEqual({
      "notes.editor": { verdict: "override", reason: "the only macOS host was down this cycle" },
    });
  });

  it("ignores an untouched row rather than inventing a verdict for it", () => {
    expect(parseTicked(row("notes.editor#0@ios"))).toEqual({});
  });

  it("ignores prose that merely looks like a row", () => {
    expect(parseTicked("Tick a row, then run: `- [x] example`")).toEqual({});
  });

  it("keeps the client and the item index on each row, which is what decides whether it blocks", () => {
    // The entry roll-up cannot answer "did a GATING row fail", because it has
    // thrown away which client. That is why `--record` reads rows, not entries.
    const text = [row("notes.editor#1@desktop-macos", "x"), row("notes.editor#0@ios", " ", "  FAIL:")].join("\n");
    expect(parseRows(text)).toEqual([
      { key: "notes.editor#1@desktop-macos", entryId: "notes.editor", itemIndex: 1, client: "desktop-macos", verdict: "pass", reason: undefined },
      { key: "notes.editor#0@ios", entryId: "notes.editor", itemIndex: 0, client: "ios", verdict: "fail", reason: undefined },
    ]);
  });
});

describe("blockingRows decides whether the tag stops, so it is tested on its own", () => {
  // This is the one function in the file with the authority to stop a release,
  // and it was exported and never called by a test. The plan's own `--record`
  // path is the only caller, so a defect here would have surfaced on a release
  // day rather than in CI.
  const roster = [entry()];
  const r = (key: string, itemIndex: number, client: string, verdict: string) => ({
    key,
    entryId: "notes.editor",
    itemIndex,
    client,
    verdict,
    reason: undefined,
  });

  it("returns a failed row on a GATED client", () => {
    const rows = [r("notes.editor#0@desktop-macos", 0, "desktop-macos", "fail")];
    expect(blockingRows(rows, roster, RATCHET).map((x: { key: string }) => x.key)).toEqual(["notes.editor#0@desktop-macos"]);
  });

  it("does NOT return a failed row on a client the policy does not gate", () => {
    // desktop-linux is on the roster and off the gate, which is the whole point
    // of the ratchet: the row is walked and recorded and does not block yet.
    const rows = [r("notes.editor#0@desktop-linux", 0, "desktop-linux", "fail")];
    expect(blockingRows(rows, roster, RATCHET)).toEqual([]);
  });

  it("does NOT return a passed or overridden row on a gated client", () => {
    const rows = [
      r("notes.editor#0@desktop-macos", 0, "desktop-macos", "pass"),
      r("notes.editor#0@desktop-macos", 0, "desktop-macos", "override"),
    ];
    expect(blockingRows(rows, roster, RATCHET)).toEqual([]);
  });

  it("does NOT return a failed row whose tier the policy does not gate", () => {
    const standard = [entry({ manual: [{ ...entry().manual[0], tier: "standard" }] })];
    const rows = [r("notes.editor#0@desktop-macos", 0, "desktop-macos", "fail")];
    expect(blockingRows(rows, standard, RATCHET)).toEqual([]);
  });

  it("THROWS on an item index the roster no longer has, rather than passing the release", () => {
    // A stale plan fails CLOSED. The first version returned false here, so a
    // recorded failure whose item had shifted was written into the record and
    // then did not stop the tag, at exit 0 - while an unknown ENTRY id one
    // branch up already exited 1. Same staleness, two directions, and the open
    // one is what this whole file argues against.
    const rows = [r("notes.editor#7@desktop-macos", 7, "desktop-macos", "fail")];
    expect(() => blockingRows(rows, roster, RATCHET)).toThrow(/notes\.editor#7@desktop-macos names item 7/);
  });
});

describe("planVersion parses back the heading buildPlan writes", () => {
  // The round trip had no test, and the two halves are coupled only by a comment
  // ("This heading is that format, and `planVersion` below parses it back, so the
  // two move together"). A heading-format change would break the parse and leave
  // every test green, which matters because this is the only thing stopping last
  // release's ticked plan being recorded under this release's tag.

  it("reads the version out of a plan it generated", () => {
    expect(planVersion(plan({ version: "v0.6.0" }))).toBe("v0.6.0");
  });

  it("returns null for a plan generated without one, so nothing is inferred", () => {
    expect(planVersion(plan({ version: null }))).toBeNull();
  });

  it("rejects prose that merely looks like the heading", () => {
    expect(planVersion("Some text\n# Manual test plan for two clients and a laptop\nmore")).toBe(null);
  });
});
describe("the three headers that make a ticked plan checkable", () => {
  // None of these was imported by any test. Emptying `malformedRowLines` to
  // return [] or `planRowCount` to return null left the suite green while both
  // under-report guards on the record path disappeared, and both carry doc
  // comments explaining that a dropped row and an unparseable row are the two
  // ways a ticked plan lies about what was walked. A fail-closed check no test
  // can reach is inert, and these sit on the path that decides whether a tag is
  // cut. Found by the myne-bot review of PR #576.

  it("reads back the row count buildPlan wrote", () => {
    expect(planRowCount(plan())).toBe(3);
  });

  it("reads back the gating count buildPlan wrote", () => {
    expect(planGatingCount(plan({ ratchet: RATCHET }))).toBe(1);
  });

  it("returns null when either header is gone, which the record path treats as unverifiable", () => {
    // Not as permission to skip: deleting rows together with the header that
    // counts them is how a check turns itself off from inside its own input.
    expect(planRowCount("# Manual test plan for v0.6.0\n\nno header here\n")).toBeNull();
    expect(planGatingCount("# Manual test plan for v0.6.0\n\nno header here\n")).toBeNull();
  });

  it("names a row line whose key cannot be read, rather than dropping it", () => {
    const good = "- [ ] `notes.editor#0@ios` **[core, 5 min]** Note editor";
    const bad = "- [x] notes.editor#0@ios missing its backticks";
    expect(malformedRowLines(`${good}\n${bad}\n`)).toEqual([bad]);
  });

  it("does not call an untouched or a prose line malformed", () => {
    // `parseRows` returns only rows carrying a verdict, by design, so the test is
    // whether the KEY is readable and never whether the box is ticked.
    const untouched = "- [ ] `notes.editor#0@ios` **[core, 5 min]** Note editor";
    const prose = "Tick a row, then run: `- [x] example`";
    expect(malformedRowLines(`${untouched}\n${prose}\n`)).toEqual([]);
  });

  it("changedSince answers null on a ref git cannot resolve, rather than throwing", () => {
    // The plan degrades to "everything is standing work" when it cannot diff,
    // which is the safe direction: an unusable ref must not silently mark every
    // area as untouched by this release.
    expect(changedSince("definitely-not-a-ref-9c1f2a")).toBeNull();
  });
});
