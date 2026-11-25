// check-ignored-tests — every failure direction, driven through the guard itself.
//
// The guard's own header makes a promise a reader is entitled to hold it to: the fixture problem
// this repository has shipped twice is caught by INJECTION, not by a scan, so the guard's test
// injects rather than asserts. Each case below writes a defect and asserts the guard names THAT
// defect, then restores and asserts the tree is clean again, so a case cannot pass because the
// guard is broken for an unrelated reason.
//
// The fixture root is temporary: the real governed tree now has ZERO deferred `#[ignore]`s after
// the D-04 A decision removed the family-scoped ChatML test. A test that injected into the real
// tree would therefore depend on a deferral existing again, which is exactly backwards.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const GUARD = join(ROOT, "scripts/check-ignored-tests.mjs");
const REAL_ROSTER = join(ROOT, "scripts/ignored-tests.json");

/** Run the guard. Never throws on a non-zero exit. */
function runGuard(
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): { code: number; out: string } {
  try {
    const out = execFileSync("node", [GUARD, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe",
      env,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const BASE_IGNORE =
  '#[ignore = "unfixed: a deferred invariant; see myne-md/myne#760"]\nfn deferred() {}\n';

let scratch: string;
let fixtureRoot: string;
let fixture: string;
let rosterPath: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ignored-tests-"));
  fixtureRoot = join(scratch, "core");
  mkdirSync(fixtureRoot, { recursive: true });
  fixture = join(fixtureRoot, "fixture.rs");
  writeFileSync(fixture, BASE_IGNORE, "utf8");
  rosterPath = join(scratch, "roster.json");
  runGuard(["--record", "--root", fixtureRoot, "--roster", rosterPath]);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Run the guard against the scratch fixture and roster. */
function guard(args: string[] = []): { code: number; out: string } {
  return runGuard([...args, "--root", fixtureRoot, "--roster", rosterPath]);
}

function setFixture(next: string): void {
  writeFileSync(fixture, next, "utf8");
}

describe("check-ignored-tests", () => {
  it("passes on the real tree, where the roster is empty", () => {
    const { code, out } = runGuard();
    expect(code, out).toBe(0);
    const roster = JSON.parse(readFileSync(REAL_ROSTER, "utf8"));
    expect(roster.ignored).toEqual([]);
    expect(out).toContain("0 deferred");
  });

  it("records and checks the fixture as one deferred entry", () => {
    const roster = JSON.parse(readFileSync(rosterPath, "utf8"));
    expect(roster.ignored.map((e: { issue: string }) => e.issue)).toEqual(["760"]);
    const { code, out } = guard();
    expect(code, out).toBe(0);
    expect(out).toContain("1 deferred");
  });

  it("rule 1: a deferral that names no issue fails", () => {
    setFixture('#[ignore = "unfixed: a deferred invariant"]\nfn deferred() {}\n');
    runGuard(["--record", "--root", fixtureRoot, "--roster", rosterPath]);
    const { code, out } = guard();
    expect(code).toBe(1);
    expect(out).toContain("names no tracking issue");
  });

  it("rule 2: a reason that names an issue but not what is missing fails", () => {
    setFixture('#[ignore = "flaky on this machine; see myne-md/myne#760"]\nfn deferred() {}\n');
    runGuard(["--record", "--root", fixtureRoot, "--roster", rosterPath]);
    const { code, out } = guard();
    expect(code).toBe(1);
    expect(out).toContain("does not say the test is unfixed");
  });

  it("roster, tree to roster: a deferral the roster has never heard of fails", () => {
    setFixture(
      BASE_IGNORE +
        '#[ignore = "unfixed: a second deferred thing nobody recorded; see myne-md/myne#998"]\nfn second() {}\n',
    );
    const { code, out } = guard();
    expect(code).toBe(1);
    expect(out).toContain("is not in");
    expect(out).toContain("myne-md/myne#998");
  });

  it("roster, roster to tree: an entry whose test is gone fails", () => {
    const r = JSON.parse(readFileSync(rosterPath, "utf8"));
    r.ignored.push({
      path: "core/fixture.rs",
      reason: "unfixed: x; see myne-md/myne#1",
      issue: "1",
    });
    writeFileSync(rosterPath, JSON.stringify(r, null, 2) + "\n", "utf8");
    const { code, out } = guard();
    expect(code).toBe(1);
    expect(out).toContain("no such #[ignore] exists");
  });

  it("does not govern a reasoned #[ignore] that claims no defect", () => {
    setFixture('#[ignore = "slow soak; not a known-bug RED"]\nfn soak() {}\n');
    runGuard(["--record", "--root", fixtureRoot, "--roster", rosterPath]);
    const { code, out } = guard();
    expect(code, out).toBe(0);
    const roster = JSON.parse(readFileSync(rosterPath, "utf8"));
    expect(roster.ignored).toEqual([]);
  });

  it("fails by name when a governed root is missing, rather than reporting ok", () => {
    const { code, out } = runGuard([
      "--root",
      join(scratch, "definitely-not-here"),
      "--roster",
      rosterPath,
    ]);
    expect(code).toBe(1);
    expect(out).toContain("governed root is missing");
  });

  it("--check-issues fails when the named issue is closed", () => {
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    const fakeGh = join(bin, "gh");
    writeFileSync(
      fakeGh,
      '#!/bin/sh\necho \'{"state":"CLOSED","number":760,"url":"https://example.invalid/760"}\'\n',
      "utf8",
    );
    chmodSync(fakeGh, 0o755);
    const { code, out } = runGuard(
      ["--root", fixtureRoot, "--roster", rosterPath, "--check-issues"],
      { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    );
    expect(code).toBe(1);
    expect(out).toContain("not OPEN");
  });
});
