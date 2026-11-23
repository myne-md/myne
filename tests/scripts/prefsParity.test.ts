// Injection suite for `scripts/check-prefs-parity.mjs` (myne-md/myne#880).
//
// Per AGENTS.md, verifying a guard means BREAKING it, and the half that gets
// skipped is the WRITER. `check-ipc-binding-callers.mjs` seeded every entry with
// a placeholder its own reason check accepted, so `--record` produced a file
// that went green while every entry in it said its reason was missing. The
// question that finds that class is the other one: run `--record` on a dirty
// tree and check the guard then FAILS. The last two cases here are that.
//
// Two layers, deliberately. The pure functions take their whole world as an
// argument, so every rule is driven with synthetic input and none of them can
// leave a half-restored checkout behind. And the guard's own READING is
// exercised separately, because a scan that silently narrows still prints ok
// over the rows it can no longer see.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  COMMAND_FLOOR,
  MIN_REASON,
  PLACEHOLDER,
  applyDeliberate,
  badReasonText,
  bindingsByCommand,
  classifyRows,
  clientState,
  floorProblem,
  mappingProblems,
  parseClassification,
  parseCommands,
  parityVerdict,
  reasonsCheck,
  recordDecision,
  renderProjection,
} from "../../scripts/check-prefs-parity.mjs";

const ROOT: string = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT: string = join(ROOT, "scripts/check-prefs-parity.mjs");
const RECORD: string = join(ROOT, "scripts/prefs-parity.json");

const reason = "A written reason long enough to pass the guard's own length check.";

/**
 * One row of the parity projection, as `classifyRows` returns it.
 *
 * The guard is a `.mjs`, so its exports are untyped and TypeScript infers `any`
 * for anything they return. Annotating the ROW here, rather than the binding
 * that holds it, keeps the four callbacks below out of `check-test-typecheck`'s
 * debt: that guard counts real errors per file and the count may only fall, and
 * a fresh file starts at zero.
 */
type ParityRow = {
  command: string;
  verdict: string;
  class: string;
  desktop: string;
  mobile: string;
};

/** Two clients, each with an injected binding map and dead set. */
function clients(desktop: [string, string][], mobile: [string, string][], dead: string[]) {
  return {
    desktop: { path: "src/lib/prefs.ts", bound: new Map(desktop) },
    mobile: { path: "mobile/src/lib/prefs.ts", bound: new Map(mobile) },
    dead: new Set(dead),
  };
}

/** One synthetic roster of three commands with a fixed classification. */
function roster(desktop: [string, string][], mobile: [string, string][], dead: string[]) {
  const c = clients(desktop, mobile, dead);
  return classifyRows({
    commands: ["set_foo", "set_bar", "set_baz"],
    classification: new Map([
      ["foo", "shared"],
      ["bar", "device-local"],
      ["baz", "shared"],
    ]),
    desktop: c.desktop,
    mobile: c.mobile,
    dead: c.dead,
  });
}

describe("check-prefs-parity, the reading half", () => {
  it("reads the #[tauri::command] roster and nothing else", () => {
    const rust = `pub async fn helper() {}
#[tauri::command]
pub async fn set_alpha<R: Runtime>() {}
#[tauri::command]
pub fn set_beta<R: Runtime>() {}
fn not_a_command() {}
`;
    expect(parseCommands(rust)).toEqual(["set_alpha", "set_beta"]);
  });

  it("reads a multi-line classification row and is not fooled by a comment", () => {
    // The table's Shared rows are written across four lines with a comment
    // between the field name and the class, and the comment itself contains
    // quoted prose. A parser that reads the raw text would attribute a class to
    // a string inside a comment, which is the "scan silently narrows" failure.
    const rust = `pub const CLASSIFICATION: &[(&str, PrefClass)] = &[
    ("alpha", PrefClass::DeviceLocal),
    (
        "beta",
        // The old reasoning read "beta", PrefClass::Shared(ScalarLww) and expired.
        PrefClass::Shared(SharedDiscipline::ScalarLww),
    ),
    ("gamma", PrefClass::MergeMetadata),
];
`;
    const got = parseClassification(rust);
    expect([...got.entries()]).toEqual([
      ["alpha", "device-local"],
      ["beta", "shared"],
      ["gamma", "metadata"],
    ]);
  });

  it("sees a plain, a GENERIC and a direct-invoke prefs binding", () => {
    const ts = `export async function setAlpha(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_alpha", { enabled });
}
export async function setBeta(mutation: SetMutation): Promise<number> {
  return await writePref<number>("plugin:prefs|set_beta", { mutation });
}
export async function setGamma(v: string): Promise<void> {
  await invoke("plugin:prefs|set_gamma", { v });
}
`;
    expect([...bindingsByCommand(ts).entries()]).toEqual([
      ["set_alpha", "setAlpha"],
      ["set_beta", "setBeta"],
      ["set_gamma", "setGamma"],
    ]);
  });

  it("does not let a doc-comment mention stand in for a binding", () => {
    // The literal must sit in a CALL position. A comment naming it is prose,
    // and counting one would invent a row for a command the file does not bind.
    const ts = `/** Reads plugin:prefs|set_delta for the delta surface. */
export async function somethingElse(): Promise<void> {}
`;
    expect(bindingsByCommand(ts).size).toBe(0);
  });
});

describe("check-prefs-parity, the client states and verdicts", () => {
  it("distinguishes never-bound from bound-but-uncalled", () => {
    const dead = ["mobile/src/lib/prefs.ts:setBar"];
    expect(clientState(new Map([["set_foo", "setFoo"]]), "src/lib/prefs.ts", "set_foo", new Set())).toBe(
      "called",
    );
    expect(
      clientState(new Map([["set_bar", "setBar"]]), "mobile/src/lib/prefs.ts", "set_bar", new Set(dead)),
    ).toBe("bound-no-caller");
    expect(clientState(new Map(), "mobile/src/lib/prefs.ts", "set_baz", new Set())).toBe("never-bound");
  });

  it("derives the four verdicts", () => {
    expect(parityVerdict("called", "called")).toBe("both");
    expect(parityVerdict("called", "bound-no-caller")).toBe("desktop-only");
    expect(parityVerdict("called", "never-bound")).toBe("desktop-only");
    expect(parityVerdict("called", "deliberately-absent")).toBe("desktop-only");
    expect(parityVerdict("bound-no-caller", "never-bound")).toBe("no-ui");
    expect(parityVerdict("bound-no-caller", "called")).toBe("mobile-only");
  });

  it("names a command the desktop surfaces and mobile does not", () => {
    // The finding this projection exists for: a setting desktop has and mobile
    // lacks. Its §10.2 class rides along, read from the classification table.
    const rows = roster(
      [
        ["set_foo", "setFoo"],
        ["set_bar", "setBar"],
        ["set_baz", "setBaz"],
      ],
      [["set_baz", "setBaz"]],
      [],
    );
    expect(rows.map((r: ParityRow) => [r.command, r.verdict, r.class])).toEqual([
      ["set_foo", "desktop-only", "shared"],
      ["set_bar", "desktop-only", "device-local"],
      ["set_baz", "both", "shared"],
    ]);
  });

  it("reports no-ui when neither client reaches the command", () => {
    const rows = roster([["set_foo", "setFoo"]], [], ["src/lib/prefs.ts:setFoo"]);
    expect(rows.find((r: ParityRow) => r.command === "set_foo")!.verdict).toBe("no-ui");
  });
});

describe("check-prefs-parity, the command to field mapping", () => {
  const classification = new Map([["foo", "shared"]]);

  it("names a command that maps to no field and is not in NO_FIELD", () => {
    const problems = mappingProblems({ commands: ["mystery_command"], classification });
    expect(problems.some((p) => p.includes("mystery_command"))).toBe(true);
  });

  it("names a mapped field the §10.2 table does not classify", () => {
    // A `set_*` whose field nobody classified: the class column would be empty
    // and the guard would say nothing, which is the silent version of the same
    // failure the §10.2 conformance test catches on the Rust side.
    const problems = mappingProblems({ commands: ["set_unclassified"], classification });
    expect(problems.some((p) => p.includes("set_unclassified"))).toBe(true);
    expect(problems.some((p) => p.includes("unclassified"))).toBe(true);
  });

  it("names a stale FIELD_OVERRIDES entry", () => {
    const problems = mappingProblems({ commands: ["set_foo"], classification });
    expect(problems.some((p) => p.includes("vault_set_label"))).toBe(true);
  });

  it("accepts the real roster with no problems", () => {
    // The tree as it stands: the mapping is complete, so the guard's own
    // measurement of the real files is not merely assumed.
    expect(mappingProblems({ commands: parseCommands(realCommandsRs()), classification: realClassification() })).toEqual([]);
  });
});

describe("check-prefs-parity, the reasons record, both directions", () => {
  it("names a one-sided command with no reason", () => {
    const rows = roster([["set_foo", "setFoo"]], [], []);
    const v = reasonsCheck({ rows, reasons: {} });
    expect(v.oneSided).toEqual(["set_foo", "set_bar", "set_baz"]);
    expect(v.missing).toEqual(["set_foo", "set_bar", "set_baz"]);
  });

  it("names a stale reason whose command is gone", () => {
    const rows = roster([["set_foo", "setFoo"]], [["set_foo", "setFoo"]], []);
    const v = reasonsCheck({ rows, reasons: { set_ghost: reason } });
    expect(v.stale).toEqual(["set_ghost"]);
    expect(v.staleUnknown).toEqual(["set_ghost"]);
  });

  it("names a stale reason whose command has CONVERGED", () => {
    // The other direction, and the one a one-sided compare cannot see: the
    // command is real, it is simply no longer one-sided, so the reason has
    // outlived its subject. It is not `staleUnknown`, because the remedy is a
    // deletion rather than a re-point.
    const rows = roster([["set_foo", "setFoo"]], [["set_foo", "setFoo"]], []);
    const v = reasonsCheck({ rows, reasons: { set_foo: reason } });
    expect(v.stale).toEqual(["set_foo"]);
    expect(v.staleUnknown).toEqual([]);
  });

  it("rejects a reason that is empty, too short, or the --record placeholder", () => {
    const rows = roster([["set_foo", "setFoo"]], [], []);
    const v = reasonsCheck({
      rows,
      reasons: { set_foo: PLACEHOLDER, set_bar: "TODO", set_baz: "x".repeat(MIN_REASON - 1) },
    });
    expect(v.unreasoned).toEqual(["set_foo", "set_bar", "set_baz"]);
  });

  it("rejects a reason containing a newline, and escapes a pipe rather than rejecting it", () => {
    // `renderProjection` escapes pipes through `esc`, so only a newline can
    // break a table row. The check and the failure message both say exactly
    // that, rather than claiming the pipe half too.
    const rows = roster([["set_foo", "setFoo"]], [], []);
    const pipe = { set_foo: `${reason} a | b` };
    expect(reasonsCheck({ rows, reasons: pipe }).unreasoned).toEqual([]);
    expect(badReasonText(pipe)).toEqual([]);
    expect(badReasonText({ set_foo: `${reason} a\nb` })).toEqual(["set_foo"]);
  });

  it("names a row whose measured state moved while the verdict stayed one-sided", () => {
    // The finding this arm exists for. The baseline recorded desktop=called,
    // mobile=never-bound (desktop-only). The tree now measures
    // desktop=bound-no-caller, mobile=never-bound (no-ui): a live defect, since
    // the sheet can render a control whose write path nothing calls. The verdict
    // stayed on the one-sided side of `both`, so missing, stale and
    // redundantDeliberate all stay empty and the ratchet is unmoved; only the
    // recorded state catches it. A one-command roster keeps `missing` genuinely
    // empty rather than populated by the synthetic roster's other rows.
    const rows = classifyRows({
      commands: ["set_foo"],
      classification: new Map([["foo", "shared"]]),
      desktop: { path: "src/lib/prefs.ts", bound: new Map([["set_foo", "setFoo"]]) },
      mobile: { path: "mobile/src/lib/prefs.ts", bound: new Map() },
      dead: new Set(["src/lib/prefs.ts:setFoo"]),
    });
    const v = reasonsCheck({
      rows,
      reasons: { set_foo: reason },
      states: { set_foo: "called|never-bound" },
    });
    expect(v.missing).toEqual([]);
    expect(v.stale).toEqual([]);
    expect(v.redundantDeliberate).toEqual([]);
    expect(v.stateChanged).toHaveLength(1);
    expect(v.stateChanged[0]).toContain("set_foo");
    expect(v.stateChanged[0]).toContain("called|never-bound");
    expect(v.stateChanged[0]).toContain("bound-no-caller|never-bound");
  });

  it("names a one-sided row with no recorded state, and accepts a matching one", () => {
    const rows = roster([["set_foo", "setFoo"]], [], []);
    expect(reasonsCheck({ rows, reasons: { set_foo: reason } }).stateUnrecorded).toContain(
      "set_foo",
    );
    const recorded = reasonsCheck({
      rows,
      reasons: { set_foo: reason },
      states: {
        set_foo: "called|never-bound",
        set_bar: "never-bound|never-bound",
        set_baz: "never-bound|never-bound",
      },
    });
    expect(recorded.stateUnrecorded).toEqual([]);
    expect(recorded.stateChanged).toEqual([]);
  });

  it("turns a declared deliberate absence into a fourth client state", () => {
    // The row is `called` on both clients by measurement; the declaration says
    // the control is deliberately not usable on mobile, which makes the row
    // one-sided WITHOUT moving any measurement. The spell row is this shape.
    const rows = roster(
      [
        ["set_foo", "setFoo"],
        ["set_bar", "setBar"],
        ["set_baz", "setBaz"],
      ],
      [
        ["set_foo", "setFoo"],
        ["set_bar", "setBar"],
        ["set_baz", "setBaz"],
      ],
      [],
    );
    const marks = { set_foo: ["mobile"] };
    const applied = applyDeliberate(rows, marks);
    expect(applied.find((r: ParityRow) => r.command === "set_foo")).toMatchObject({
      desktop: "called",
      mobile: "deliberately-absent",
      verdict: "desktop-only",
    });
    expect(applied.find((r: ParityRow) => r.command === "set_bar")!.verdict).toBe("both");
    // And the record is checked against the row the declaration created rather
    // than against the raw measurement, so the entry is not reported stale.
    const v = reasonsCheck({ rows, reasons: { set_foo: reason }, marks });
    expect(v.oneSided).toEqual(["set_foo"]);
    expect(v.stale).toEqual([]);
    expect(v.redundantDeliberate).toEqual([]);
  });

  it("names a deliberate-absence declaration on a client that does not reach the command", () => {
    // The both-ways half of the fourth state: the declaration says a control
    // exists on a client and is deliberately unusable there, so where the client
    // does not reach the command at all the declaration describes nothing.
    const rows = roster([["set_foo", "setFoo"]], [], []);
    const v = reasonsCheck({
      rows,
      reasons: { set_foo: reason },
      marks: { set_foo: ["mobile"] },
    });
    expect(v.redundantDeliberate).toEqual(["mobile:set_foo"]);
  });

  it("names a deliberate-absence declaration on an unknown client", () => {
    const rows = roster([["set_foo", "setFoo"]], [["set_foo", "setFoo"]], []);
    const v = reasonsCheck({
      rows,
      reasons: { set_foo: reason },
      marks: { set_foo: ["tablet"] },
    });
    expect(v.unknownClient).toEqual(["set_foo (tablet)"]);
  });
});

describe("check-prefs-parity, the ratchet", () => {
  it("separates a grown set from a shrunk one", () => {
    expect(recordDecision({ committed: ["a"], now: ["a", "b"] }).grew).toEqual(["b"]);
    expect(recordDecision({ committed: ["a", "b"], now: ["a"] }).shrank).toEqual(["b"]);
  });

  it("catches a swap a COUNT would miss", () => {
    // One command converges while another diverges: the number is unchanged,
    // which is the case a count-only ratchet is blind to and the reason the
    // record holds a set. `check-twin-drift-ratchet.mjs` records the same
    // reasoning for its own set.
    const { grew, shrank } = recordDecision({ committed: ["a", "b"], now: ["a", "c"] });
    expect(grew).toEqual(["c"]);
    expect(shrank).toEqual(["b"]);
  });
});

describe("check-prefs-parity, the denominator floor", () => {
  it("is satisfied at the floor and names the shortfall below it", () => {
    expect(floorProblem({ commands: new Array(76).fill("x"), floor: 76 })).toBeNull();
    const problem = floorProblem({ commands: ["a"], floor: 76 });
    expect(problem).toContain("floor is 76");
  });
});

describe("check-prefs-parity, the tree as it stands", () => {
  it("passes, with the measured roster and tally", () => {
    // The tally tracks the tree: it moves as rows converge, which is the record
    // doing its job. 51 `both` / 33 `desktop-only` is the state after the
    // home-layout batch added `set_home_cards` and `set_home_open_on_start` as
    // reasoned desktop-only rows: desktop calls both from the home surface's
    // arrange mode (myne-md/myne#1074), the card list because a phone's start
    // screen is its own design question and the open-on-start switch because it
    // is DEVICE-LOCAL, so a phone's answer is its own. (51 / 31 was
    // external-mcp-connection's queue and rename commands, `accept_mcp_write_request`
    // and `dismiss_mcp_write_request` deciding a proposal an external client
    // produced by calling a desktop sidecar, and `rewrite_mcp_folder_paths`
    // re-rooting a grant a phone never holds. 51 / 26 was the
    // deny-list shape, 51 / 24 after view-manifests' `set_view_approval`, 51 / 23
    // was myne-md/myne#880's phase 3 shape, and 42 / 32 when the projection was
    // first seeded.) The assertion is deliberately exact rather
    // than a regex: `expect(out.code).toBe(0)` alone would pass over a guard
    // that had stopped reading a whole client, which is the failure this suite
    // exists to catch. Update the two numbers in the same change as a
    // convergence.
    const out = run();
    expect(out.code).toBe(0);
    expect(out.out).toContain(
      "prefs-parity: ok (86 command(s): 51 both, 33 desktop-only, 0 mobile-only, 2 no-ui",
    );
    // A real guard run over the whole tree: ~3.5 s alone, past the 5 s default
    // under a full `pnpm test`, so it carries the same budget as the three
    // spawning cases below.
  }, 60_000);

  it("examines at least the floor", () => {
    const commands = parseCommands(realCommandsRs());
    expect(commands.length).toBeGreaterThanOrEqual(COMMAND_FLOOR);
  });

  it("FAILS after --record seeds a fresh baseline with the placeholder", () => {
    // The writer's half, arm one. A baseline written blind must not be a
    // licence: the seed fills every entry with the placeholder and the reason
    // check rejects that BY NAME, so the very next --check is red.
    //
    // The command asserted is read off the committed record rather than
    // hardcoded. It used to name `set_daily_folder`, which CONVERGED, so the
    // seed no longer writes an entry for it and the assertion passed over a
    // command that was no longer one-sided. Reading a key from the record keeps
    // the spot check pointed at a command that is one-sided right now.
    withTempRecord(null, (path) => {
      const seeded = run(["--record"], path);
      expect(seeded.code).toBe(0);
      expect(seeded.out).toContain("placeholder");
      const checked = run(["--check"], path);
      expect(checked.code).toBe(1);
      expect(checked.out).toContain("are not reasons");
      expect(checked.out).toContain(oneSidedCommand());
    });
  }, 60_000);

  it("seeds the deliberately-absent row a measured-only --record would drop", () => {
    // The seed path's one-sided set is taken with `DELIBERATELY_ABSENT_ON`
    // applied, so a row whose one-sidedness is a DECISION rather than a
    // measurement is seeded. `set_spell_enabled` is measured `called|called` on
    // both clients, so a seed that read only the measurement dropped it: the
    // record stopped carrying it, `applyDeliberate` then left it `both`,
    // `reasonsCheck` reported nothing missing or stale, and `--emit` rewrote the
    // projection to `both` while every check stayed green.
    withTempRecord(null, (path) => {
      const seeded = run(["--record"], path);
      expect(seeded.code).toBe(0);
      const rec = JSON.parse(readFileSync(path, "utf8")) as {
        oneSided: Record<string, unknown>;
        states: Record<string, string>;
      };
      expect(rec.oneSided).toHaveProperty("set_spell_enabled");
      expect(rec.states).toHaveProperty("set_spell_enabled", "called|called");
    });
  }, 60_000);

  it("counts the panel record as rail panels plus the block inside one", () => {
    // The projection used to read "Six desktop rail panels" over a record of
    // five rail panels plus a CLI block inside Privacy, which is six surfaces
    // but not six panels. The sentence is derived from which entries carry a
    // `home`, so a block cannot be counted as a panel and the numbers cannot
    // drift from the record.
    const doc = renderProjection(roster([["set_foo", "setFoo"]], [], []), {});
    expect(doc).toContain("6 desktop settings surfaces have no mobile counterpart: 5 rail panels and");
    expect(doc).toContain("1 block inside a panel");
  });

  it("REFUSES --record on a dirty tree, and --check stays red", () => {
    // The writer's half, arm two, and the one nobody tests. A command that
    // became one-sided since the baseline is a REGRESSION; a --record that
    // locked it in would turn the command the failure message suggests into the
    // way to make the failure go away. It must refuse, write nothing, and leave
    // the tree red.
    //
    // `dropped` is a real one-sided command read off the record, not a hardcoded
    // name: the version that named `set_daily_folder` stopped testing anything
    // when that row converged, because deleting a key the record no longer
    // carries changed nothing and `--record` then wrote instead of refusing.
    const committed = JSON.parse(readFileSync(RECORD, "utf8")) as {
      oneSided: Record<string, string>;
    };
    const dropped = oneSidedCommand();
    const dirty = { ...committed.oneSided };
    delete dirty[dropped];
    withTempRecord(JSON.stringify({ ...committed, oneSided: dirty }), (path) => {
      const recorded = run(["--record"], path);
      expect(recorded.code).toBe(1);
      expect(recorded.out).toContain("--record refused");
      // And it wrote nothing: the file still carries the dirty record.
      const after = JSON.parse(readFileSync(path, "utf8")) as {
        oneSided: Record<string, string>;
      };
      expect(after.oneSided).not.toHaveProperty(dropped);
      const checked = run(["--check"], path);
      expect(checked.code).toBe(1);
      expect(checked.out).toContain(dropped);
    });
  }, 60_000);

  it("FAILS when the generated projection is missing or stale", () => {
    // The `--check` staleness arm, and the ONE arm of this guard that had no
    // rejection case while every other arm did. `agent-tooling/docs/dev/settings-parity.md` is
    // GENERATED, so a hand edit to it is a docs-only commit, and CI runs this
    // step UNFILTERED for exactly that reason: the arm has to be shown to fire,
    // not assumed to.
    withTempProjection(null, (path) => {
      const missing = run(["--check"], undefined, path);
      expect(missing.code).toBe(1);
      expect(missing.out).toContain("agent-tooling/docs/dev/settings-parity.md");
      expect(missing.out).toContain("does not exist");
    });

    withTempProjection("hand edited\n", (path) => {
      const stale = run(["--check"], undefined, path);
      expect(stale.code).toBe(1);
      expect(stale.out).toContain("agent-tooling/docs/dev/settings-parity.md");
      expect(stale.out).toContain("stale");
    });

    // And the positive half: the COMMITTED projection is not stale, so the two
    // assertions above are about the doctored copies rather than about an arm
    // that fires on everything.
    const committed = run(["--check"]);
    expect(committed.code).toBe(0);
  }, 60_000);
});

/** A command the committed record carries as one-sided, so the writer tests
 *  below always point at something the guard still measures as one-sided. */
function oneSidedCommand(): string {
  const raw = JSON.parse(readFileSync(RECORD, "utf8")) as {
    oneSided: Record<string, string>;
  };
  const first = Object.keys(raw.oneSided)[0];
  if (!first) {
    throw new Error(
      "scripts/prefs-parity.json carries no one-sided command, so the writer " +
        "tests below would assert against nothing. Either the record was emptied " +
        "by hand or every row converged; both need a look before this is deleted.",
    );
  }
  return first;
}

function realCommandsRs(): string {
  return readFileSync(join(ROOT, "core/src/plugins/prefs/commands.rs"), "utf8");
}

function realClassification(): Map<string, string> {
  return parseClassification(
    readFileSync(join(ROOT, "core/src/plugins/sync/prefs_classification.rs"), "utf8"),
  );
}

function run(
  args: string[] = [],
  recordPath?: string,
  projectionPath?: string,
): { code: number; out: string } {
  const env = { ...process.env };
  if (recordPath) env.MYNE_PREFS_PARITY_RECORD = recordPath;
  if (projectionPath) env.MYNE_PREFS_PARITY_PROJECTION = projectionPath;
  try {
    return {
      code: 0,
      out: execFileSync("node", [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", env }),
    };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

/**
 * Run `body` with the guard pointed at a scratch record file.
 *
 * The guard reads its record path from `MYNE_PREFS_PARITY_RECORD` so this can
 * drive the seed path (no file at all) and the refusal without touching the
 * committed record, which is the failure mode a save-and-restore leaves behind
 * when the run is interrupted.
 */
function withTempRecord(contents: string | null, body: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "myne-prefs-parity-"));
  const path = join(dir, "prefs-parity.json");
  try {
    if (contents !== null) writeFileSync(path, contents);
    body(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run `body` with the guard pointed at a scratch PROJECTION file.
 *
 * The staleness arm's whole subject is the committed `agent-tooling/docs/dev/settings-parity.md`,
 * so exercising it against the real file means doctoring it and restoring it,
 * which leaves the tree wrong when the run is interrupted. The override exists
 * for the same reason `MYNE_PREFS_PARITY_RECORD` does; `null` means "no file at
 * all", which is the other half of the arm.
 */
function withTempProjection(contents: string | null, body: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "myne-prefs-parity-projection-"));
  const path = join(dir, "settings-parity.md");
  try {
    if (contents !== null) writeFileSync(path, contents);
    body(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
