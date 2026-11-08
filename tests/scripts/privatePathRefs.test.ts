// Injection tests for `check-private-path-refs.mjs`.
//
// Root `AGENTS.md`: verifying a guard means BREAKING it, and the half that needs
// the most scepticism is the one that WRITES. This guard's `--record` refuses a
// grown set, and that refusal is the only thing standing between "a published
// tree points at a file nobody outside the org can open" and a one-line edit that
// makes the failure go away. So it is driven end to end.
//
// It used to drive that end to end against a probe written into the REAL `agent-tooling/docs/`
// tree, deleted in a `finally`. That window was a race rather than a tidiness
// problem: vitest runs files in parallel workers, so a sibling test asserting the
// real tree is clean read the probe and failed on a pairing nobody chose. Measured
// by creating the probe by hand and watching this file and
// `tests/scripts/webScreens.test.ts` go red with each other's messages, which is
// the failure `check-e2e-menu-testids.mjs` records as myne-md/myne#242 and fixes
// the same way. `--sandbox <dir>` is the seam: the same walk and the same two
// refusals, over a tree only this file can see.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SCANNED_ROOTS,
  classOf,
  refsInText,
  walkRoot,
} from "../../scripts/check-private-path-refs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARD = "scripts/check-private-path-refs.mjs";
const RECORD = join(ROOT, "scripts", "private-path-refs.json");
const PROBE_REL = "agent-tooling/docs/__private_path_probe.md";

function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("node", [GUARD, ...args], { cwd: ROOT, encoding: "utf8" });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/** The sandbox record, byte-stable so the refusal's no-write half can be compared. */
const SANDBOX_RECORD = `{
  "$comment": "Sandbox roster: empty, so the only file a scan can find is the probe.",
  "append-only-record": [],
  "living-document": []
}
`;

/**
 * A tree only this file can see: the three scanned roots, empty, plus a record.
 *
 * The empty record is load-bearing rather than convenient. Pointing the walk at an
 * empty tree while keeping the real record would report every recorded file as
 * stale, so the run would exit 1 for that reason and this test would stop
 * measuring the arm it is named for.
 */
function sandbox(withProbe: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "private-refs-sandbox-"));
  for (const root of SCANNED_ROOTS) mkdirSync(join(dir, root), { recursive: true });
  writeFileSync(join(dir, "private-path-refs.json"), SANDBOX_RECORD);
  if (withProbe) {
    writeFileSync(
      join(dir, PROBE_REL),
      "# probe\n\nSee `operations/runbooks/release-checklist.md`.\n",
    );
  }
  return dir;
}

describe("refsInText", () => {
  it("finds a path into each private repository", () => {
    expect(refsInText("see `operations/runbooks/release-checklist.md` phase 1")).toEqual([
      "operations/runbooks/release-checklist.md",
    ]);
    expect(refsInText("agent-tooling/skills/do-work/SKILL.md")).toEqual([
      "agent-tooling/skills/do-work/SKILL.md",
    ]);
    expect(refsInText("internal-service/tests/fetch-release.test.sh")).toEqual([
      "internal-service/tests/fetch-release.test.sh",
    ]);
  });

  it("finds the GitHub URL form too", () => {
    expect(refsInText("https://github.com/example-org/agent-tooling/blob/develop/x.md")).toEqual([
      "agent-tooling/blob/develop/x.md",
    ]);
  });

  it("does NOT match an issue reference, which is a different object", () => {
    // The rule the plan states: `myne-md/<repo>#<n>` is free. The pattern requires
    // the slash, so the `#` form cannot match, and a guard that flagged it would
    // fail on every correctly-referenced issue in the tree.
    expect(refsInText("example-org/agent-tooling#123")).toEqual([]);
    expect(refsInText("(example-org/operations#7)")).toEqual([]);
    expect(refsInText("example-org/internal-service#45")).toEqual([]);
  });

  it("does NOT match a bare repository name", () => {
    // "the ops repository", "agent-tooling is private": naming a repository is not
    // a reference to a file in it, and a guard that conflated the two would flag
    // every sentence that explains the split.
    expect(refsInText("the operations repository is private")).toEqual([]);
    expect(refsInText("`agent-tooling` holds the skills")).toEqual([]);
  });

  it("deduplicates and sorts, so one file's refs are stable", () => {
    const text = "operations/b.md then operations/a.md then operations/b.md";
    expect(refsInText(text)).toEqual(["operations/a.md", "operations/b.md"]);
  });
});

describe("classOf", () => {
  it("routes the append-only log to its own class", () => {
    expect(classOf("agent-tooling/design-notes/ui/0331-x.md")).toBe("append-only-record");
    expect(classOf("agent-tooling/docs/glossary.md")).toBe("living-document");
    expect(classOf("src/screens/Editor.tsx")).toBe("living-document");
  });
});

describe("walkRoot", () => {
  it("scans text, ignores images, and fails by name on an unclassified extension", () => {
    const dir = mkdtempSync(join(tmpdir(), "private-refs-"));
    try {
      writeFileSync(join(dir, "a.md"), "operations/x.md\n");
      writeFileSync(join(dir, "b.png"), "");
      writeFileSync(join(dir, "LICENSE"), "no extension is treated as prose\n");
      writeFileSync(join(dir, "c.rs"), "");
      const { files, unclassified } = walkRoot("probe", dir);
      expect(files.map((f) => f.split("/").pop()).sort()).toEqual(["LICENSE", "a.md"]);
      expect(unclassified.map((f) => f.split("/").pop())).toEqual(["c.rs"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the wired guard", () => {
  it("passes over the tree and reports the recorded set", () => {
    const { code, out } = run([]);
    expect(out).toContain("private-path-refs: ok");
    expect(code).toBe(0);
    // The floor is the roster's own size, not a number written here, so a scan that
    // silently stopped reading still reports itself (it would say 0). The set may only
    // shrink: it was 266 files until the decision log moved to the private companion,
    // which is why a literal floor outlived its subject and had to be re-recorded twice.
    const roster = JSON.parse(readFileSync(join(ROOT, "scripts/private-path-refs.json"), "utf8"));
    const recorded = roster["living-document"].length + roster["append-only-record"].length;
    const n = Number(out.match(/ok \((\d+) recorded file/)?.[1] ?? "0");
    expect(n).toBe(recorded);
  });

  it("scans three roots that all exist in this checkout", () => {
    // A root on the roster but absent is a failure in the guard; this asserts the
    // roster is not describing directories that are gone.
    for (const root of SCANNED_ROOTS) {
      expect(existsSync(join(ROOT, root)), `${root} is missing`).toBe(true);
    }
  });

  it("FAILS on a new private path, and REFUSES to record it", () => {
    const dir = sandbox(true);
    const realRecordBefore = readFileSync(RECORD, "utf8");
    try {
      const check = run(["--sandbox", dir]);
      expect(check.code).toBe(1);
      expect(check.out).toContain(PROBE_REL);
      expect(check.out).toContain("operations/runbooks/release-checklist.md");
      // And it failed for the probe, not because the empty sandbox record made
      // every recorded file stale: that arm is silent here.
      expect(check.out).not.toContain("no longer point at a private");

      const record = run(["--sandbox", dir, "--record"]);
      expect(record.code).toBe(1);
      expect(record.out).toContain("REFUSING to record 1 new file(s)");

      // The half that matters: the refusal wrote nothing, in the sandbox and in the
      // real record. A `--record` that silently accepted the growth would make every
      // later green run evidence of nothing, which is the failure root AGENTS.md
      // records about seeding paths.
      expect(readFileSync(join(dir, "private-path-refs.json"), "utf8")).toBe(SANDBOX_RECORD);
      expect(readFileSync(RECORD, "utf8")).toBe(realRecordBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // And once the probe is gone the same tree is green again, so the failure above
    // was the probe and not a coincidence.
    const clean = sandbox(false);
    try {
      expect(run(["--sandbox", clean]).code).toBe(0);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });
});
