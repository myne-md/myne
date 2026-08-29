// Unit tests for `scripts/check-manual-test-roster.mjs` (myne-md/myne#548).
//
// The repo rule is that verifying a guard means BREAKING it, not running it, and
// that both directions have to be injected: prove the guard still catches what it
// caught before, not only what it used to miss. So every rule below appears twice,
// once as a defect the guard must name and once inside `healthy()`, which must
// stay green.
//
// `analyse(io)` takes its whole world as an argument, so each defect is a
// synthetic roster rather than a mutation of the real one: no `git restore`, no
// half-restored working copy, and every case runs on every commit.

import { describe, expect, it } from "vitest";

import {
  CLIENTS,
  MIN_REASON_CHARS,
  VAGUE_REASONS,
  analyse,
  coverageGaps,
  RATCHET_BASELINE,
  gates,
  hours,
  projectionBody,
  totalMinutes,
} from "../../scripts/check-manual-test-roster.mjs";

const SCREEN = "src/screens/Unlock.tsx";
const SETTING = "src/components/settings/AiPanel.tsx";
const SCENARIO = "e2e/notes.e2e.ts";
const REAL = [SCREEN, SETTING, SCENARIO];

/** A reason long enough to clear the length rule and specific enough to clear the vagueness rule. */
const REAL_REASON =
  "safaridriver takes neither a profile nor a headless flag, so the Linux CI runner cannot drive Safari at all.";
const REAL_SEE =
  "Open the vault in Safari on macOS, edit a note, and confirm the change is on disk after a reload.";

type Io = Parameters<typeof analyse>[0];
type Ratchet = NonNullable<Io["ratchet"]>;

/** A world where every rule is satisfied, as the baseline each defect mutates. */
function healthy(): Io {
  return {
    roster: [
      {
        id: "notes.editor",
        title: "Note editor",
        paths: [SCREEN],
        clients: ["desktop-macos", "desktop-linux", "web"],
        automatedBy: [SCENARIO],
        manual: [
          {
            see: REAL_SEE,
            whyNotAutomated: REAL_REASON,
            clients: ["desktop-macos"],
            estimateMin: 3,
            tier: "core",
          },
        ],
        exemptionReason: "",
      },
      {
        id: "settings.ai",
        title: "AI settings panel",
        paths: [SETTING],
        clients: ["desktop-linux"],
        automatedBy: [],
        manual: [],
        exemptionReason:
          "Every control in this panel is asserted by the AI E2E family, which runs in CI with MYNE_E2E_AI=1.",
      },
    ],
    files: [SCREEN, SETTING],
    e2eFiles: [SCENARIO],
    pathExists: (p: string) => REAL.includes(p),
    verified: {},
    // One core item, one gated client, 3 minutes: gated 3, total 3.
    ratchet: {
      gatedTiers: ["core"],
      gatedClients: ["desktop-macos"],
      totalMinutesCeiling: 3,
      gatedMinutes: 3,
    },
    // The synthetic world gets a synthetic baseline. Injecting it is the point:
    // the real `RATCHET_BASELINE` describes the shipped gate, and a fixture bound
    // to that would fail on every future widening of the real one.
    baseline: { gatedTiers: ["core"], gatedClients: ["desktop-macos"] },
    notASurface: { [SCREEN]: "Not really exempt, but the map needs an entry whose file exists to be non-vacuous." },
  };
}

const messages = (io: Io) => analyse(io).failures.join("\n");
const ratchetOf = (io: Io) => io.ratchet as Ratchet;

describe("the healthy baseline", () => {
  it("reports no failure", () => {
    expect(analyse(healthy()).failures).toEqual([]);
  });

  it("is not vacuous: it exercises a manual item, an exemption, a claimed scenario and the exemption map", () => {
    const io = healthy();
    const stats = analyse(io).stats as Record<string, number>;
    expect(stats.manualItems).toBeGreaterThan(0);
    expect(stats.coreItems).toBeGreaterThan(0);
    expect(stats.automatedScenarios).toBeGreaterThan(0);
    expect(io.roster.some((e) => (e.manual ?? []).length === 0)).toBe(true);
    expect(Object.keys(io.notASurface ?? {}).length).toBeGreaterThan(0);
  });

  it("warns about entries with manual items that have never been verified", () => {
    expect(analyse(healthy()).warnings.join("\n")).toMatch(/never been verified/);
  });

  it("refuses to run at all when the ratchet key is missing, rather than skipping Rule 5", () => {
    // The parameter-with-a-default trap CLAUDE.md records from myne#533: the
    // default would be the arm that never fires, excusing a future caller from
    // the whole ratchet rule without anyone choosing it.
    const io = healthy() as Record<string, unknown>;
    delete io.ratchet;
    expect(() => analyse(io as Io)).toThrow(/`ratchet` is required/);
  });
});

describe("coverage, forward: a surface no entry claims", () => {
  it("names an unclaimed file", () => {
    const io = healthy();
    io.files = [SCREEN, SETTING, "src/screens/BrandNewScreen.tsx"];
    expect(messages(io)).toMatch(/no roster entry claims src\/screens\/BrandNewScreen\.tsx/);
  });

  it("names an e2e scenario no entry lists in automatedBy", () => {
    const io = healthy();
    io.e2eFiles = [SCENARIO, "e2e/brand-new.e2e.ts"];
    expect(messages(io)).toMatch(/no roster entry names e2e\/brand-new\.e2e\.ts in automatedBy/);
  });

  it("accepts a directory claim OUTSIDE a denominator, which is the common and correct case", () => {
    // `src-tauri/src/plugins/notes/` is how an entry says it tests that plugin's
    // behaviour, and no file under it is a surface anybody walks individually.
    const io = healthy();
    io.roster[0].paths = [SCREEN, "src-tauri/src/plugins/notes/"];
    io.pathExists = (p: string) => [...REAL, "src-tauri/src/plugins/notes/"].includes(p);
    expect(analyse(io).failures).toEqual([]);
  });

  it("REFUSES a directory claim inside a denominator, because it pre-claims files nobody has written", () => {
    // Measured on the real tree before this rule existed: injecting
    // `src/screens/vault-creation/ZZ.tsx` produced `ok` at exit 0 while the
    // denominator count silently rose, because an entry claimed the directory.
    const io = healthy();
    io.roster[0].paths = ["src/screens/"];
    io.pathExists = (p: string) => ["src/screens/", SETTING, SCENARIO].includes(p);
    expect(messages(io)).toMatch(
      /notes\.editor: src\/screens\/ is a directory claim inside the src\/screens denominator/,
    );
  });

  it("REFUSES a directory claim that CONTAINS a denominator, which is the worse half", () => {
    // The first version of this loop tested only `p.startsWith(denominator)`, so
    // a claim ON `src/` reported zero failures while pre-claiming every file in
    // every denominator beneath it. Half a derived coverage claim reads exactly
    // like a whole one in the success line.
    const io = healthy();
    io.roster[0].paths = ["src/"];
    io.pathExists = (p: string) => ["src/", SETTING, SCENARIO].includes(p);
    expect(messages(io)).toMatch(/notes\.editor: src\/ is a directory claim covering the src\/screens denominator/);
  });

  it("scopes that refusal to the injected denominators, not to a hardcoded list", () => {
    const io = healthy();
    io.roster[0].paths = ["src/screens/"];
    io.pathExists = (p: string) => ["src/screens/", SETTING, SCENARIO].includes(p);
    io.denominators = [{ dir: "e2e", extensions: /\.e2e\.ts$/ }];
    expect(messages(io)).not.toMatch(/directory claim inside/);
  });

  it("names a client tree that grew a surface directory and joined no denominator", () => {
    const io = healthy();
    io.coverage = { unwalked: ["mobile/src/components/settings"], stale: [] };
    expect(messages(io)).toMatch(/mobile\/src\/components\/settings exists and is on no denominator/);
  });

  it("names an exemption that outlived its directory", () => {
    const io = healthy();
    io.coverage = { unwalked: [], stale: ["mobile/src/screens"] };
    expect(messages(io)).toMatch(/NOT_A_SURFACE_ROSTER exempts mobile\/src\/screens/);
  });
});

describe("coverageGaps compares both ways", () => {
  const exists = (d: string) => ["src/screens", "web/src/screens", "mobile/src/screens"].includes(d);

  it("reports a surface directory on no denominator", () => {
    // `mobile/src` is a shared root; `mobile/src/screens` exists and is exempt,
    // so with the exemption removed it must surface.
    expect(coverageGaps(["mobile/src"], exists, {}).unwalked).toContain("mobile/src/screens");
  });

  it("stays silent when the directory carries a stated exemption", () => {
    const exempt = { "mobile/src/screens": "The mobile design gallery, not the app." };
    expect(coverageGaps(["mobile/src"], exists, exempt).unwalked).toEqual([]);
  });

  it("reports an exemption whose directory is gone", () => {
    const exempt = { "editor/src/screens": "A directory that no longer exists." };
    expect(coverageGaps(["editor/src"], exists, exempt).stale).toContain("editor/src/screens");
  });

  it("reports an exemption that now names a walked denominator", () => {
    const exempt = { "src/screens": "Exempt, but src/screens is on DENOMINATORS." };
    expect(coverageGaps(["src"], exists, exempt).stale).toContain("src/screens");
  });
});

describe("coverage, backward: a verdict that outlived its files", () => {
  it("fails on a path that no longer exists", () => {
    const io = healthy();
    io.roster[0].paths = ["src/screens/Deleted.tsx"];
    expect(messages(io)).toMatch(/path no longer exists: src\/screens\/Deleted\.tsx/);
  });

  it("fails on an automatedBy scenario that no longer exists", () => {
    const io = healthy();
    io.roster[0].automatedBy = ["e2e/deleted.e2e.ts"];
    io.e2eFiles = [];
    expect(messages(io)).toMatch(/automatedBy names a scenario file that does not exist/);
  });

  it("fails on a NOT_A_SURFACE entry whose file is gone", () => {
    const io = healthy();
    io.notASurface = { "src/screens/Deleted.tsx": "A file that is not there any more, exempted anyway." };
    expect(messages(io)).toMatch(/NOT_A_SURFACE names src\/screens\/Deleted\.tsx, which no longer exists/);
  });
});

describe("reasons have to name a mechanism", () => {
  for (const phrase of VAGUE_REASONS) {
    it(`rejects a whyNotAutomated built on "${phrase}"`, () => {
      const io = healthy();
      // Long enough to clear the length rule, so only the vagueness rule can fire.
      io.roster[0].manual[0].whyNotAutomated = `This one is ${phrase} and there is nothing more to say about it here.`;
      expect(messages(io)).toMatch(/describes the difficulty rather than the mechanism/);
    });
  }

  it("rejects a whyNotAutomated shorter than the floor", () => {
    const io = healthy();
    io.roster[0].manual[0].whyNotAutomated = "no driver";
    expect(messages(io)).toMatch(new RegExp(`whyNotAutomated is shorter than ${MIN_REASON_CHARS}`));
  });

  it("rejects a see a tester could not act on", () => {
    const io = healthy();
    io.roster[0].manual[0].see = "check it works";
    expect(messages(io)).toMatch(/see is shorter than/);
  });

  it("rejects an entry with no manual items and no exemption reason", () => {
    const io = healthy();
    io.roster[1].exemptionReason = "";
    expect(messages(io)).toMatch(/no manual items and no exemptionReason/);
  });

  it("rejects a vague exemption reason even when it is long enough", () => {
    const io = healthy();
    io.roster[1].exemptionReason =
      "There is nothing here that is worth the trouble, it is hard to automate and nobody looks at it.";
    expect(messages(io)).toMatch(/exemptionReason is vague/);
  });

  it("holds the exemption map to the same bar: a short reason fails", () => {
    // Removing a file from the denominator outright is the strongest claim in the
    // file, and it was the one reason field nothing checked.
    const io = healthy();
    io.notASurface = { [SCREEN]: "n/a" };
    expect(messages(io)).toMatch(/NOT_A_SURFACE\[src\/screens\/Unlock\.tsx\]: reason is shorter than/);
  });

  it("holds the exemption map to the same bar: a vague reason fails", () => {
    const io = healthy();
    io.notASurface = { [SCREEN]: "Nobody walks this one, it is hard to automate and never really mattered anyway." };
    expect(messages(io)).toMatch(/NOT_A_SURFACE\[src\/screens\/Unlock\.tsx\]: reason is vague/);
  });
});

describe("items are schedulable", () => {
  it("rejects a manual item naming a client the entry does not list", () => {
    const io = healthy();
    io.roster[0].manual[0].clients = ["android"];
    expect(messages(io)).toMatch(/names client android, which the entry itself does not list/);
  });

  it("rejects a client outside the known surfaces", () => {
    const io = healthy();
    io.roster[0].clients = [...io.roster[0].clients, "smartwatch"];
    expect(messages(io)).toMatch(/unknown client "smartwatch"/);
    expect(CLIENTS).not.toContain("smartwatch");
  });

  it("rejects a tier outside core and standard", () => {
    const io = healthy();
    io.roster[0].manual[0].tier = "nice-to-have";
    expect(messages(io)).toMatch(/tier must be one of core, standard/);
  });

  it("rejects a zero-minute estimate", () => {
    const io = healthy();
    io.roster[0].manual[0].estimateMin = 0;
    expect(messages(io)).toMatch(/estimateMin must be a positive number/);
  });

  it("rejects an entry with no clients", () => {
    const io = healthy();
    io.roster[1].clients = [];
    expect(messages(io)).toMatch(/no clients, so no plan can ever schedule it/);
  });

  it("rejects a duplicate id", () => {
    const io = healthy();
    io.roster.push({ ...io.roster[0] });
    expect(messages(io)).toMatch(/duplicate entry id: notes\.editor/);
  });

  it("rejects an id that is not a dotted lowercase slug", () => {
    const io = healthy();
    io.roster[0].id = "Notes Editor";
    expect(messages(io)).toMatch(/entry id is not a dotted lowercase slug/);
  });
});

describe("verification stamps", () => {
  it("accepts a pass stamp on a known entry", () => {
    const io = healthy();
    io.verified = { "notes.editor": { version: "v0.6.0", date: "2026-08-21", verdict: "pass" } };
    expect(analyse(io).failures).toEqual([]);
  });

  it("fails on a stamp for an entry the roster no longer has", () => {
    const io = healthy();
    io.verified = { "notes.deleted": { version: "v0.6.0", date: "2026-08-21", verdict: "pass" } };
    expect(messages(io)).toMatch(/verification stamp for unknown entry notes\.deleted/);
  });

  it("fails on a verdict outside pass, fail and override", () => {
    const io = healthy();
    io.verified = { "notes.editor": { version: "v0.6.0", date: "2026-08-21", verdict: "probably" } };
    expect(messages(io)).toMatch(/verdict must be pass, fail or override/);
  });

  it("fails on an override with no written reason, because that is how a ship gate gets passed anyway", () => {
    const io = healthy();
    io.verified = { "notes.editor": { version: "v0.6.0", date: "2026-08-21", verdict: "override" } };
    expect(messages(io)).toMatch(/an override is how a failed ship gate is passed anyway/);
  });

  it("accepts an override that argues for itself", () => {
    const io = healthy();
    io.verified = {
      "notes.editor": {
        version: "v0.6.0",
        date: "2026-08-21",
        verdict: "override",
        reason: "The only macOS host was unavailable this cycle; the item is scheduled first at v0.7.0.",
      },
    };
    expect(analyse(io).failures).toEqual([]);
  });
});

describe("the ratchet: the gate policy may only grow, the roster may only shrink", () => {
  it("passes when the record describes the roster and the baseline", () => {
    expect(analyse(healthy()).failures).toEqual([]);
  });

  it("FAILS when a client is dropped from the gate, and says a decision entry is the only route", () => {
    const io = healthy();
    ratchetOf(io).gatedClients = [];
    expect(messages(io)).toMatch(/the gate NARROWED: gatedClients no longer covers desktop-macos/);
    expect(messages(io)).toMatch(/that is a decision entry, not a JSON edit/);
  });

  it("FAILS when a tier is dropped from the gate", () => {
    const io = healthy();
    ratchetOf(io).gatedTiers = ["standard"];
    expect(messages(io)).toMatch(/the gate NARROWED: gatedTiers no longer covers core/);
  });

  it("does NOT fail when the gate widens: that is a note plus a baseline nudge", () => {
    const io = healthy();
    io.roster[0].manual[0].clients = ["desktop-macos", "desktop-linux"];
    ratchetOf(io).gatedClients = ["desktop-macos", "desktop-linux"];
    ratchetOf(io).totalMinutesCeiling = 6;
    const r = analyse(io);
    expect(r.failures).toEqual([]);
    expect(r.notes.join("\n")).toMatch(/the gate widened: gatedClients now covers desktop-linux/);
  });

  it("does NOT punish automating a core item, which the minute floor it replaced did", () => {
    // The defect that produced this shape: an author writes a scenario covering a
    // `core` item and deletes the item, so gating MINUTES fall. Under a minute
    // floor the guard called that "the gate NARROWED" and told them the fix was
    // the edit it calls never legitimate. The policy is what must not narrow; how
    // many minutes happen to sit inside it is not the invariant.
    const io = healthy();
    io.roster[0].manual = [];
    io.roster[0].exemptionReason =
      "Every observation this entry carried is now asserted by e2e/notes.e2e.ts, which runs on every commit.";
    // The ratchet is NOT re-recorded here, and that is the scenario: the author
    // automates, runs the guard, and the recorded pair still describes the world
    // before the automation. Gating fell by 3 and the total fell by 3, so the
    // rule's own table reads this as "ok" rather than as a narrowing. Setting
    // `totalMinutesCeiling = 0` here instead would model a HALF re-recorded
    // ratchet, where the ceiling moved and `gatedMinutes` did not, and the rule
    // would fire for the right reason on the wrong scenario.
    expect(analyse(io).failures).toEqual([]);
  });

  // The other half of that rule, which had no test at all: gating falls FURTHER
  // than the total, which is what an item retiered out of `core` looks like. The
  // work stays in the roster and leaves the gate, and `gatedTiers`/`gatedClients`
  // cannot see it because neither list changed.
  it("FAILS when gating minutes fall further than total minutes, which is a retier out of the gate", () => {
    const io = healthy();
    io.roster[0].manual[0].tier = "standard";
    expect(messages(io)).toMatch(/the gate narrowed WITHOUT the roster shrinking/);
  });

  it("FAILS when manual work grows, which is a manual item added instead of automation", () => {
    const io = healthy();
    io.roster[0].manual.push({ ...io.roster[0].manual[0], tier: "standard", estimateMin: 5 });
    expect(messages(io)).toMatch(/manual work GREW: 8 minutes against a ceiling of 3/);
  });

  it("does NOT fail when manual work shrinks: that is the point of the whole system", () => {
    const io = healthy();
    io.roster[0].manual[0].estimateMin = 1;
    const r = analyse(io);
    expect(r.failures).toEqual([]);
    expect(r.notes.join("\n")).toMatch(/manual work shrank: 1 minutes against a recorded ceiling of 3/);
  });

  it("counts gated minutes per client, so a second gated client widens the gate", () => {
    const io = healthy();
    io.roster[0].manual[0].clients = ["desktop-macos", "desktop-linux"];
    ratchetOf(io).gatedClients = ["desktop-macos", "desktop-linux"];
    ratchetOf(io).totalMinutesCeiling = 6;
    expect((analyse(io).stats as Record<string, number>).gatedMinutes).toBe(6);
  });

  it("leaves an ungated client out of the gated total but not out of the roster total", () => {
    const io = healthy();
    io.roster[0].manual[0].clients = ["desktop-macos", "desktop-linux"];
    ratchetOf(io).totalMinutesCeiling = 6;
    const stats = analyse(io).stats as Record<string, number>;
    expect(analyse(io).failures).toEqual([]);
    expect(stats.gatedMinutes).toBe(3);
    expect(stats.totalMinutes).toBe(6);
  });

  it("rejects a gatedTiers naming a tier that does not exist", () => {
    const io = healthy();
    ratchetOf(io).gatedTiers = ["core", "critical"];
    expect(messages(io)).toMatch(/gatedTiers names unknown tier "critical"/);
  });

  it("rejects a gatedClients naming a client that does not exist", () => {
    const io = healthy();
    ratchetOf(io).gatedClients = ["desktop-macos", "smartwatch"];
    expect(messages(io)).toMatch(/gatedClients names unknown client "smartwatch"/);
  });

  it("skips the ratchet rules on an explicit null, so the other rules stay testable alone", () => {
    const io = healthy();
    io.ratchet = null;
    expect(analyse(io).failures).toEqual([]);
    expect(analyse(io).notes).toEqual([]);
  });

  it("gatedTiers being a LIST is what makes the tier half of the gate expressible", () => {
    const item = { tier: "standard", clients: ["web"] } as never;
    expect(gates(item, "web", { gatedTiers: ["core"], gatedClients: ["web"] } as never)).toBe(false);
    expect(gates(item, "web", { gatedTiers: ["core", "standard"], gatedClients: ["web"] } as never)).toBe(true);
  });

  it("ships a baseline that matches the recorded gate, so the real pair is not vacuous", () => {
    // Both directions on the shipped values, not the fixture's: a baseline that
    // drifted below the record would make the narrowing rule unable to fire.
    expect(RATCHET_BASELINE.gatedTiers).toEqual(["core"]);
    expect(RATCHET_BASELINE.gatedClients).toContain("clipper");
    expect(RATCHET_BASELINE.gatedClients).not.toContain("desktop-windows");
  });
});

describe("shared arithmetic", () => {
  it("counts minutes once per client, not once per item", () => {
    const io = healthy();
    io.roster[0].manual[0].clients = ["desktop-macos", "desktop-linux", "web"];
    expect(totalMinutes(io.roster)).toBe(9);
  });

  it("renders hours the same way everywhere, because six renderings disagreed", () => {
    expect(hours(0)).toBe(0);
    expect(hours(15)).toBe(0.3);
    expect(hours(480)).toBe(8);
  });
});

describe("the projection", () => {
  it("carries the roster and its four counts", () => {
    const io = healthy();
    const body = projectionBody(io.roster, ratchetOf(io));
    expect(body).toMatch(/^<!-- GENERATED by scripts\/check-manual-test-roster\.mjs --emit/);
    expect(body).toContain("notes.editor");
    expect(body).toContain(REAL_REASON);
    expect(body).toMatch(/\*\*2 entries, 1 manual items \(1 core tier\)/);
  });

  it("says which part of the roster gates today", () => {
    const io = healthy();
    expect(projectionBody(io.roster, ratchetOf(io))).toMatch(/the gate covers the \*\*core\*\* tier on/);
  });

  it("does NOT carry verification stamps, which move every release without the roster changing", () => {
    const io = healthy();
    expect(projectionBody(io.roster, ratchetOf(io))).not.toMatch(/last-verified|last verified|v0\.6\.0/);
  });

  it("is deterministic, so --check only fires on a real roster change", () => {
    const a = healthy();
    const b = healthy();
    expect(projectionBody(a.roster, ratchetOf(a))).toBe(projectionBody(b.roster, ratchetOf(b)));
  });
});

describe("the rules that had a green path and no injection", () => {
  // Review found eight `analyse` rules asserted only by the healthy baseline
  // passing, which proves the rule does not fire, never that it can. Two of them
  // are the arms the guard's own header names as its whole reason for importing
  // `presentSharedRoots()`, so the coverage-blindness claim rested on code no
  // test could reach.

  it("names an entry with no title", () => {
    const io = healthy();
    io.roster[0].title = "";
    expect(messages(io)).toMatch(/notes\.editor: no title/);
  });

  it("names an entry with no paths, which ties it to nothing in the tree", () => {
    const io = healthy();
    io.roster[0].paths = [];
    expect(messages(io)).toMatch(/notes\.editor: no paths, so nothing ties this entry to the tree/);
  });

  it("names an entry with no clients, which no plan could schedule", () => {
    const io = healthy();
    io.roster[0].clients = [];
    expect(messages(io)).toMatch(/notes\.editor: no clients, so no plan can ever schedule it/);
  });

  it("names an ITEM with no clients, which is a separate arm from the entry's", () => {
    const io = healthy();
    io.roster[0].manual[0].clients = [];
    expect(messages(io)).toMatch(/notes\.editor\[0\]: no clients/);
  });

  it("names an item client outside CLIENTS, not merely one the entry omits", () => {
    // Two arms one line apart, and the existing coverage only reached the second.
    // The entry lists the bad client too, so the entry-level check fires as well;
    // what this asserts is that the ITEM-level unknown-client arm is reachable.
    const io = healthy();
    const bad = ["toaster"] as unknown as Io["roster"][0]["clients"];
    io.roster[0].clients = ["desktop-macos", "toaster"] as unknown as Io["roster"][0]["clients"];
    io.roster[0].manual[0].clients = bad;
    expect(messages(io)).toMatch(/notes\.editor\[0\]: unknown client "toaster"/);
  });

  it("names a NOT_A_SURFACE_ROSTER directory whose reason is missing or vague", () => {
    const io = healthy();
    io.coverage = { unwalked: [], stale: [], unreasoned: ["mobile/src/screens"] };
    expect(messages(io)).toMatch(/NOT_A_SURFACE_ROSTER\[mobile\/src\/screens\]: reason is missing, too short or vague/);
  });

  it("names a shared root that is on the roster and absent from the checkout", () => {
    // A broken checkout scans fewer trees and still reports ok, which is the
    // exact silent-green shape `check-prefs-nonce.mjs` records for its own roster.
    const io = healthy();
    io.missingRoots = ["mobile/src"];
    expect(messages(io)).toMatch(/shared root mobile\/src is on scripts\/lib\/shared-roots\.mjs and absent/);
  });

  it("names a verification stamp missing any of version, date and verdict", () => {
    const io = healthy();
    io.verified = { "notes.editor": { version: "v0.6.0", date: "2026-08-22" } } as unknown as Io["verified"];
    expect(messages(io)).toMatch(/notes\.editor: verification stamp needs version, date and verdict/);
  });

  it("names a NOT_A_SURFACE exemption for a file in no denominator", () => {
    // The other direction of the file-level exemption map, which had only the
    // does-it-exist half while its sibling roster was compared both ways. An
    // exemption for a file the walk never returns is an inert paragraph that
    // reads as a decision still in force.
    const io = healthy();
    io.notASurface = {
      ...io.notASurface,
      "src-tauri/src/main.rs":
        "A Rust entry point is not a UI surface and cannot carry a screen-level manual verdict at all.",
    };
    io.pathExists = (p: string) => [...REAL, "src-tauri/src/main.rs"].includes(p);
    expect(messages(io)).toMatch(/NOT_A_SURFACE names src-tauri\/src\/main\.rs, which is in no denominator/);
  });
});
