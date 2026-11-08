// check-ignored-tests — every failure direction, driven through the guard itself.
//
// The guard's own header makes a promise a reader is entitled to hold it to: the fixture problem
// this repository has shipped twice is caught by INJECTION, not by a scan, so the guard's test
// injects rather than asserts. Each case below writes a defect and asserts the guard names THAT
// defect, then restores and asserts the tree is clean again, so a case cannot pass because the
// guard is broken for an unrelated reason.
//
// Two of these cases exist because the guard itself got them wrong on the first run, which is
// the shape the repo's own rulebook warns about:
//
//   - the first version stripped string literals before matching, so the `= "…"` reason it went
//     on to look for had already been deleted, and it reported an EMPTY roster over a tree
//     carrying two deferred tests;
//   - the first version treated `known-bug` as a signal for "this is a deferral", and a SOAK
//     opt-out in `core/src/plugins/sync/sim.rs` says "(not a known-bug RED)", so a negated
//     mention read as a claim and the guard demanded an issue of an opt-out that makes none.
//
// The roster is `--record`ed and restored around each case, because the roster rule fires on a
// changed reason before the semantic rules can, and a case meant to isolate rule 1 has to let the
// roster match first.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const GUARD = join(ROOT, "scripts/check-ignored-tests.mjs");
// The tracked roster is only read by the guard itself; the test drives it through --roster.
const CHATML = join(ROOT, "core/src/inference/chatml.rs");

/** Run the guard. Never throws on a non-zero exit. */
function runGuard(args: string[] = []): { code: number; out: string } {
  try {
    const out = execFileSync("node", [GUARD, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const CHATML_IGNORE = '#[ignore = "unfixed: the ChatML filter is family-scoped; see myne-md/myne#760"]';

let chatml: string;
let scratch: string;
let rosterPath: string;

beforeEach(() => {
  chatml = readFileSync(CHATML, "utf8");
  // A roster in a temp dir, never the tracked one. The first version re-recorded
  // `scripts/ignored-tests.json` in place and restored it afterwards, so a killed
  // run left a rewritten tracked file behind and nothing reported it.
  scratch = mkdtempSync(join(tmpdir(), "ignored-tests-"));
  rosterPath = join(scratch, "roster.json");
  // Start every case from a roster that matches the tree, so a case aimed at one
  // rule is not satisfied by another.
  runGuard(["--record", "--roster", rosterPath]);
});

afterEach(() => {
  writeFileSync(CHATML, chatml, "utf8");
  rmSync(scratch, { recursive: true, force: true });
});

/** Run the guard against the scratch roster. */
function guard(): { code: number; out: string } {
  return runGuard(["--roster", rosterPath]);
}

function setIgnore(next: string): void {
  if (!chatml.includes(CHATML_IGNORE)) throw new Error("chatml anchor moved; update this test");
  writeFileSync(CHATML, chatml.replace(CHATML_IGNORE, next), "utf8");
}

describe("check-ignored-tests", () => {
  it("passes on the tree as committed, and says what it counted", () => {
    const { code, out } = guard();
    expect(code, out).toBe(0);
    const deferred = JSON.parse(readFileSync(rosterPath, "utf8")).ignored.length;
    expect(out).toMatch(new RegExp(`${deferred} deferred #\\[ignore]`));
    // The opt-outs are named in the count's absence: three reasoned #[ignore]s in
    // core/ are NOT deferrals, and the guard must not claim them. So the count below is
    // the roster's size and never the tree's: a reasoned ignore that claims no defect is
    // simply not in `scripts/ignored-tests.json`.
    expect(out).not.toMatch(new RegExp(`${deferred + 1} deferred`));
  });

  it("names a tracking issue in the roster for every real deferral", () => {
    const r = JSON.parse(readFileSync(rosterPath, "utf8"));
    const issues = r.ignored.map((e: { issue: string | null }) => e.issue).sort();
    // Written out in full rather than counted: a deferral nobody reviewed is exactly a new
    // issue number appearing here, and adding one is supposed to make somebody read this.
    // #759 left with the v0.1 generation cut, which deleted the code its #[ignore] guarded,
    // and #964 left with the locked writer that landed beside it: the deferral was the
    // unlocked read-modify-write, and there is no longer one to defer.
    expect(issues).toEqual(["760"]);
  });

  it("rule 1: a deferral that names no issue fails", () => {
    setIgnore('#[ignore = "unfixed: the ChatML filter is family-scoped"]');
    runGuard(["--record", "--roster", rosterPath]); // roster matches, so rule 1 fires
    const { code, out } = guard();
    expect(code).toBe(1);
    expect(out).toContain("names no tracking issue");
  });

  it("rule 2: a reason that names an issue but not what is missing fails", () => {
    setIgnore('#[ignore = "flaky on this machine; see myne-md/myne#760"]');
    runGuard(["--record", "--roster", rosterPath]);
    const { code, out } = guard();
    expect(code).toBe(1);
    expect(out).toContain("does not say the test is unfixed");
  });

  it("roster, tree to roster: a deferral the roster has never heard of fails", () => {
    setIgnore(
      CHATML_IGNORE +
        '\n    #[ignore = "unfixed: a second deferred thing nobody recorded; see myne-md/myne#998"]',
    );
    const { code, out } = guard();
    expect(code).toBe(1);
    expect(out).toContain("is not in");
    expect(out).toContain("myne-md/myne#998");
  });

  it("roster, roster to tree: an entry whose test is gone fails", () => {
    const r = JSON.parse(readFileSync(rosterPath, "utf8"));
    r.ignored.push({
      path: "core/src/inference/gone.rs",
      reason: "unfixed: x; see myne-md/myne#1",
      issue: "1",
    });
    writeFileSync(rosterPath, JSON.stringify(r, null, 2) + "\n", "utf8");
    const { code, out } = guard();
    expect(code).toBe(1);
    expect(out).toContain("no such #[ignore] exists");
  });

  it("does not govern a reasoned #[ignore] that claims no defect", () => {
    // The tree carries a few (a case-table generator, a SOAK, an env-dependent timing
    // report): the count is read from the roster below, never written here. Demanding an issue of each would demand three fake issues
    // on the first run, and the rule would be relaxed right after. So the guard's count
    // is the ROSTER's, never the tree's, and the two are deliberately different numbers.
    const { code, out } = guard();
    expect(code, out).toBe(0);
    const deferred = JSON.parse(readFileSync(rosterPath, "utf8")).ignored.length;
    expect(out).toMatch(new RegExp(`${deferred} deferred`));
  });

  it("does not read a NEGATED 'not a known-bug RED' as a claim", () => {
    // core/src/plugins/sync/sim.rs carries exactly that string. The first version
    // matched `known-bug` as a signal and classified the opt-out as a deferral.
    const sim = readFileSync(join(ROOT, "core/src/plugins/sync/sim.rs"), "utf8");
    expect(sim).toMatch(/\(not a known-bug RED\)/);
    expect(guard().code).toBe(0);
  });

  it("fails by name when a governed root is missing, rather than reporting ok", () => {
    // A check that skips on a missing input reads as a pass.
    const { code, out } = runGuard(["--root", "core/src/definitely-not-here", "--roster", rosterPath]);
    expect(code).toBe(1);
    expect(out).toContain("governed root is missing");
  });
});
