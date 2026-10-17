// Injection tests for `check-private-path-refs.mjs`.
//
// Root `AGENTS.md`: verifying a guard means BREAKING it, and the half that needs
// the most scepticism is the one that WRITES. This guard's `--record` refuses a
// grown set, and that refusal is the only thing standing between "a published
// tree points at a file nobody outside the org can open" and a one-line edit that
// makes the failure go away. So it is driven end to end, against a probe file
// written into the real tree, rather than asserted by prose.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  SCANNED_ROOTS,
  classOf,
  refsInText,
  walkRoot,
} from "../../scripts/check-private-path-refs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARD = "scripts/check-private-path-refs.mjs";
const RECORD = join(ROOT, "scripts", "private-path-refs.json");
const PROBE = join(ROOT, "docs", "__private_path_probe.md");

function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("node", [GUARD, ...args], { cwd: ROOT, encoding: "utf8" });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

afterAll(() => {
  // A probe left behind would be a docs file that fails the guard for the next
  // person, so the cleanup runs even when an assertion above threw.
  if (existsSync(PROBE)) rmSync(PROBE);
});

describe("refsInText", () => {
  it("finds a path into each private repository", () => {
    expect(refsInText("see `myne-ops/runbooks/release-checklist.md` phase 1")).toEqual([
      "myne-ops/runbooks/release-checklist.md",
    ]);
    expect(refsInText("myne-agents/skills/do-work/SKILL.md")).toEqual([
      "myne-agents/skills/do-work/SKILL.md",
    ]);
    expect(refsInText("myne-range/tests/fetch-release.test.sh")).toEqual([
      "myne-range/tests/fetch-release.test.sh",
    ]);
  });

  it("finds the GitHub URL form too", () => {
    expect(refsInText("https://github.com/myne-md/myne-agents/blob/develop/x.md")).toEqual([
      "myne-agents/blob/develop/x.md",
    ]);
  });

  it("does NOT match an issue reference, which is a different object", () => {
    // The rule the plan states: `myne-md/<repo>#<n>` is free. The pattern requires
    // the slash, so the `#` form cannot match, and a guard that flagged it would
    // fail on every correctly-referenced issue in the tree.
    expect(refsInText("myne-md/myne-agents#123")).toEqual([]);
    expect(refsInText("(myne-md/myne-ops#7)")).toEqual([]);
    expect(refsInText("myne-md/myne-range#45")).toEqual([]);
  });

  it("does NOT match a bare repository name", () => {
    // "the ops repository", "myne-agents is private": naming a repository is not
    // a reference to a file in it, and a guard that conflated the two would flag
    // every sentence that explains the split.
    expect(refsInText("the myne-ops repository is private")).toEqual([]);
    expect(refsInText("`myne-agents` holds the skills")).toEqual([]);
  });

  it("deduplicates and sorts, so one file's refs are stable", () => {
    const text = "myne-ops/b.md then myne-ops/a.md then myne-ops/b.md";
    expect(refsInText(text)).toEqual(["myne-ops/a.md", "myne-ops/b.md"]);
  });
});

describe("classOf", () => {
  it("routes the append-only log to its own class", () => {
    expect(classOf("docs/decisions/ui/0331-x.md")).toBe("append-only-record");
    expect(classOf("docs/glossary.md")).toBe("living-document");
    expect(classOf("src/screens/Editor.tsx")).toBe("living-document");
  });
});

describe("walkRoot", () => {
  it("scans text, ignores images, and fails by name on an unclassified extension", () => {
    const dir = mkdtempSync(join(tmpdir(), "private-refs-"));
    try {
      writeFileSync(join(dir, "a.md"), "myne-ops/x.md\n");
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
    // A floor, so a scan that silently stopped reading reports itself. The
    // recorded set is in the hundreds and may only shrink.
    const n = Number(out.match(/ok \((\d+) recorded file/)?.[1] ?? "0");
    expect(n).toBeGreaterThan(200);
  });

  it("scans three roots that all exist in this checkout", () => {
    // A root on the roster but absent is a failure in the guard; this asserts the
    // roster is not describing directories that are gone.
    for (const root of SCANNED_ROOTS) {
      expect(existsSync(join(ROOT, root)), `${root} is missing`).toBe(true);
    }
  });

  it("FAILS on a new private path, and REFUSES to record it", () => {
    const before = readFileSync(RECORD, "utf8");
    writeFileSync(PROBE, "# probe\n\nSee `myne-ops/runbooks/release-checklist.md`.\n");
    try {
      const check = run([]);
      expect(check.code).toBe(1);
      expect(check.out).toContain("docs/__private_path_probe.md");
      expect(check.out).toContain("myne-ops/runbooks/release-checklist.md");

      const record = run(["--record"]);
      expect(record.code).toBe(1);
      expect(record.out).toContain("REFUSING to record 1 new file(s)");

      // The half that matters: the refusal wrote nothing. A `--record` that
      // silently accepted the growth would make every later green run evidence of
      // nothing, which is the failure root AGENTS.md records about seeding paths.
      expect(readFileSync(RECORD, "utf8")).toBe(before);
    } finally {
      rmSync(PROBE, { force: true });
    }

    // And once the probe is gone the tree is green again, so the failure above was
    // the probe and not a coincidence.
    expect(run([]).code).toBe(0);
  });
});
