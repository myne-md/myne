// The server env roster guard, driven end-to-end against companion trees it BUILDS.
//
// It does not import the rule. The rule lives in a script that reads two other
// repositories, so the only way to test the drift classes is to give it a pair of
// trees and look at what it says. Injecting the defect and watching the guard name
// that defect is the verification; observing the real tree stay green proves nothing,
// which is the rule this repository applies to every guard it owns.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// NOT import.meta.dirname: it is not on ImportMeta under this repo's tsconfig, and
// tests/ is excluded from tsconfig.json, so check-test-typecheck.mjs is the only
// thing that typechecks this file and an untyped access here is a ratchet trip.
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GUARD = join(REPO_ROOT, "scripts", "check-server-env-roster.mjs");

/** A companion tree with the one knob the scan looks for, plus its go.mod and a minimal
 * pair of deployment artifacts.
 *
 * The charts are written because the guard walks them (rules 4a/4b) and gates each walk on
 * a measured floor: a fixture that grew no chart would trip the non-vacuity floor instead
 * of the rule the test is about, which reads as a passing test of the wrong thing.
 * `MYNE_ALPHA` is the documented fixture knob; the web chart names `MYNE_SYNC_ORIGIN`,
 * which the REAL `web/container/generate-headers.mjs` in this repository reads (the web
 * chart is checked against the container's own sources, not against the sync server's
 * roster). */
function makeServer(dir: string, configBody: string): string {
  mkdirSync(join(dir, "internal", "httpapi"), { recursive: true });
  mkdirSync(join(dir, "cmd", "myne-server"), { recursive: true });
  writeFileSync(join(dir, "go.mod"), "module github.com/myne-md/myne-server\n\ngo 1.26.4\n");
  writeFileSync(join(dir, "internal", "httpapi", "config.go"), configBody);
  writeFileSync(join(dir, "cmd", "myne-server", "main.go"), "package main\n");
  const serverChart = join(dir, "deploy", "helm", "myne-server");
  mkdirSync(join(serverChart, "templates"), { recursive: true });
  writeFileSync(join(serverChart, "values.yaml"), 'config:\n  MYNE_ALPHA: "1"\n');
  const webChart = join(dir, "deploy", "helm", "myne-web", "templates");
  mkdirSync(webChart, { recursive: true });
  writeFileSync(
    join(webChart, "deployment.yaml"),
    'env:\n  - name: MYNE_SYNC_ORIGIN\n    value: "https://sync.example.org"\n',
  );
  return dir;
}

function makeOps(dir: string, envExample: string): string {
  mkdirSync(join(dir, "bundle"), { recursive: true });
  writeFileSync(join(dir, "bundle", "bundle.env.example"), envExample);
  return dir;
}

/** A minimal config the scanner reads: one knob, via os.Getenv. */
const ONE_KNOB = `package httpapi

import "os"

func load() string {
	return os.Getenv("MYNE_ALPHA")
}
`;

/** A roster file that documents that one knob and classifies it. */
const MATCHING_ROSTER = `# --- knobs ---
# kind: server
MYNE_ALPHA=1
`;

/** Run the guard against a pair of trees. Returns the combined output and the code. */
/**
 * `minVars` is the measured floor the guard enforces. A two-file fixture has one
 * variable, so a test over a fixture asks for a floor of 1; the test that pins the floor
 * itself deliberately does NOT pass it, so it runs against the recorded default.
 *
 * The chart walks are floored the same way and the fixture carries one name in each, so
 * both are asked for 1 here for the same reason.
 */
function runGuard(server: string, ops: string, args: string[] = [], minVars = 1) {
  try {
    const out = execFileSync(
      "node",
      [GUARD, ...args, `--min-vars=${minVars}`, "--min-deploy=1", "--min-deploy-web=1"],
      {
        env: { ...process.env, MYNE_SERVER_DIR: server, MYNE_OPS_DIR: ops },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

/** A fresh pair of trees per test, so nothing leaks between cases. */
function pair(configBody: string, roster: string) {
  const base = mkdtempSync(join(tmpdir(), "envroster-"));
  return {
    server: makeServer(join(base, "myne-server"), configBody),
    ops: makeOps(join(base, "myne-ops"), roster),
  };
}

describe("check-server-env-roster", () => {
  it("passes when the roster documents and classifies every knob the server reads", () => {
    const { server, ops } = pair(ONE_KNOB, MATCHING_ROSTER);
    const r = runGuard(server, ops);
    expect(r.code).toBe(0);
    expect(r.out).toContain("agrees in both directions");
  });

  // --- drift class 1: a knob the server reads, absent from the roster -------------

  it("names a knob the server reads but the roster never mentions", () => {
    const { server, ops } = pair(ONE_KNOB, "# nothing here\n");
    const r = runGuard(server, ops);
    expect(r.code).toBe(1);
    expect(r.out).toContain("MYNE_ALPHA is read by the server but does not appear");
    expect(r.out).toContain("deliberately NOT in this file");
  });

  it("accepts a knob listed as deliberately absent, which is how an omission is made expressible", () => {
    const roster = `# --- deliberately NOT in this file ---
#   MYNE_ALPHA   internal wiring, the container sets it
`;
    const { server, ops } = pair(ONE_KNOB, roster);
    expect(runGuard(server, ops).code).toBe(0);
  });

  it("rejects a name in the absent list that the server does not read either", () => {
    const roster = `# --- deliberately NOT in this file ---
#   MYNE_ALPHA        read by the server
#   MYNE_NOT_A_KNOB   invented
`;
    const { server, ops } = pair(ONE_KNOB, roster);
    const r = runGuard(server, ops);
    expect(r.code).toBe(1);
    expect(r.out).toContain("MYNE_NOT_A_KNOB");
    expect(r.out).toContain("never reads it either");
  });

  it("rejects a name that is both an entry and listed as absent", () => {
    const roster = `# --- knobs ---
# kind: server
MYNE_ALPHA=1

# --- deliberately NOT in this file ---
#   MYNE_ALPHA   duplicate
`;
    const { server, ops } = pair(ONE_KNOB, roster);
    const r = runGuard(server, ops);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Pick one");
  });

  // --- drift class 2: a dead entry -------------------------------------------------

  it("names an entry classified as a server knob that the server never reads", () => {
    const roster = `# --- knobs ---
# kind: server
MYNE_ALPHA=1
# kind: server
MYNE_ACME_EMAIL=a@b.example
`;
    const { server, ops } = pair(ONE_KNOB, roster);
    const r = runGuard(server, ops);
    expect(r.code).toBe(1);
    expect(r.out).toContain('MYNE_ACME_EMAIL is classified "kind: server"');
    expect(r.out).toContain("dead knob");
  });

  it("does not fire on a kind: bundle entry, which the compose file or Caddy reads", () => {
    const roster = `# --- knobs ---
# kind: server
MYNE_ALPHA=1
# kind: bundle
MYNE_SITE_ADDRESS=example.test
`;
    const { server, ops } = pair(ONE_KNOB, roster);
    expect(runGuard(server, ops).code).toBe(0);
  });

  it("resolves each entry's kind against its OWN marker, not the block's first", () => {
    // Two entries in ONE block with different kinds and no blank line between them. A
    // block-scoped lookup made the bundle entry inherit "server" and report it as a dead
    // knob; the per-assignment lookup is the fix, and this case is the regression pin.
    const roster = `# --- knobs ---
# kind: server
MYNE_ALPHA=1
# kind: bundle
MYNE_SITE_ADDRESS=example.test
`;
    const { server, ops } = pair(ONE_KNOB, roster);
    const r = runGuard(server, ops);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("dead knob");
  });

  // --- drift class 3: an unclassified entry -----------------------------------------

  it("names an entry with no kind marker", () => {
    const roster = `# --- knobs ---
MYNE_ALPHA=1
`;
    const { server, ops } = pair(ONE_KNOB, roster);
    const r = runGuard(server, ops);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no \"kind:\" marker");
  });

  it("accepts a commented example of a knob whose entry block carries the marker", () => {
    const roster = `# --- knobs ---
#   MYNE_ALPHA=99
# This is an EXAMPLE; the real value follows.
# kind: server
MYNE_ALPHA=1
`;
    const { server, ops } = pair(ONE_KNOB, roster);
    expect(runGuard(server, ops).code).toBe(0);
  });

  // --- the scan itself ---------------------------------------------------------------

  it("ignores a MYNE_ prefix that appears only in a comment", () => {
    // The real config.go carries a "MYNE_BACKUP_*" comment. Reading that in as a knob
    // would make this guard permanently red for a reason no author can act on, so the
    // comment sits beside a REAL read that must still be caught.
    const config = `package httpapi

import "os"

// Built-in backup (MYNE_BACKUP_*).
func load() string { return os.Getenv("MYNE_ALPHA") }
`;
    const { server, ops } = pair(config, MATCHING_ROSTER);
    expect(runGuard(server, ops).code).toBe(0);
  });

  it("reads every env read shape, not just os.Getenv", () => {
    const config = `package httpapi

import "os"

func load() (uint64, error) {
	os.Getenv("MYNE_ALPHA")
	uintEnv("MYNE_BETA", 1)
	envOr("MYNE_GAMMA", "x")
	return 0, boolEnv("MYNE_DELTA")
}
`;
    const roster = `# --- knobs ---
# kind: server
MYNE_ALPHA=1
# kind: server
MYNE_BETA=1
# kind: server
MYNE_GAMMA=x
# kind: server
MYNE_DELTA=true
`;
    const { server, ops } = pair(config, roster);
    expect(runGuard(server, ops).code).toBe(0);
  });

  it("does not treat a harness-only variable as an operator knob", () => {
    // The real harness-only reads (MYNE_TEST_VECTORS_DIR, MYNE_EMIT_VECTORS) live in
    // emit_test.go / vectors_test.go, and excluding _test.go is what removes the need for
    // a hardcoded exemption list in the guard. The fixture puts the read where the real
    // ones are: putting it in a production file would be a different claim, and would in
    // fact have to be documented.
    const { server, ops } = pair(ONE_KNOB, MATCHING_ROSTER);
    writeFileSync(
      join(server, "internal", "httpapi", "vectors_test.go"),
      'package httpapi\n\nimport "os"\n\nfunc t() { _ = os.Getenv("MYNE_TEST_VECTORS_DIR") }\n',
    );
    const r = runGuard(server, ops);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("MYNE_TEST_VECTORS_DIR");
  });

  // --- the companion-absent branch, which is the branch CI runs ----------------------

  it("says what it could not check when a companion is absent, and does not claim a pass", () => {
    const base = mkdtempSync(join(tmpdir(), "envroster-absent-"));
    const missingServer = join(base, "no-server");
    const missingOps = join(base, "no-ops");
    const r = runGuard(missingServer, missingOps);

    expect(r.code).toBe(0);
    expect(r.out).toContain("SKIPPED");
    expect(r.out).toContain("NOTHING COMPARED");
    // The failure this branch's own header describes: a closing line that reads as a
    // verdict while half the name went unchecked.
    expect(r.out).not.toContain("agrees in both directions");
  });

  it("fails on the absent branch when the caller passes --require-companion", () => {
    const base = mkdtempSync(join(tmpdir(), "envroster-absent2-"));
    const r = runGuard(join(base, "no-server"), join(base, "no-ops"), ["--require-companion"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("--require-companion was passed");
  });

  it("reports a partial comparison when only one companion is present", () => {
    const base = mkdtempSync(join(tmpdir(), "envroster-partial-"));
    const server = makeServer(join(base, "myne-server"), ONE_KNOB);
    const r = runGuard(server, join(base, "no-ops"));
    expect(r.out).toContain("PARTIAL");
    expect(r.out).not.toContain("agrees in both directions");
  });
});

// --- the injections the first version of this guard would have passed ---------------

// A knob the server reads, omitted from the roster, and excused by PROSE somewhere
// else. The first version identified the absent block by matching the phrase anywhere in
// a blank-line block, so any block that merely said "these are recorded in the server
// source" satisfied rule 1's escape and the omitted knob passed.
it("does not accept an unrelated block's prose as the absent list", () => {
  // MYNE_ALPHA is genuinely ABSENT as an entry. What must not excuse it is prose in an
  // unrelated block that happens to contain the phrase.
  const roster = `# --- notes ---
# These deliberately NOT in this file entries are recorded in the server source.
`;
  const { server, ops } = pair(ONE_KNOB, roster);
  const r = runGuard(server, ops);
  expect(r.code).toBe(1);
  expect(r.out).toContain("does not appear in bundle.env.example");
});

// os.LookupEnv is the idiomatic read for a knob whose semantics are "empty = disabled",
// which is exactly the panel address knob's. A scanner that misses it reports an empty
// roster and prints the success line.
it("sees a variable read with os.LookupEnv", () => {
  const config = `package httpapi

import "os"

func load() string {
	_, _ = os.LookupEnv("MYNE_ALPHA")
	return ""
}
`;
  const { server, ops } = pair(config, "# no operator knobs\n");
  const r = runGuard(server, ops);
  expect(r.code).toBe(1);
  expect(r.out).toContain("MYNE_ALPHA is read by the server but does not appear");
});

// A test-only read is not an operator knob, and requiring one in the bundle example is
// the wrong answer. Skipping _test.go removes the need for a hardcoded exemption list.
it("does not require a variable that only a test file reads", () => {
  const config = `package httpapi

import "os"

func load() string { return os.Getenv("MYNE_ALPHA") }
`;
  const { server, ops } = pair(config, "# no operator knobs\n");
  mkdirSync(join(ops, "..", "unused"), { recursive: true });
  const base = join(server, "internal", "httpapi", "only_test.go");
  writeFileSync(base, 'package httpapi\n\nimport "os"\n\nfunc t() { _ = os.Getenv("MYNE_TESTONLY") }\n');
  const r = runGuard(server, ops);
  expect(r.code).toBe(1);
  expect(r.out).toContain("MYNE_ALPHA is read by the server");
  expect(r.out).not.toContain("MYNE_TESTONLY");
});

// The vacuous pass: a layout change that empties the scan must not print a verdict.
it("fails when the scan finds fewer variables than the measured floor", () => {
  const { server, ops } = pair('package httpapi\n', "# no operator knobs\n");
  // No minVars: this one runs against the RECORDED default floor, which is the point.
  const r = execFileSyncSafe(server, ops);
  expect(r.code).toBe(1);
  expect(r.out).toMatch(/scan found \d+ server-read variables, below the measured floor/);
});

// A root that does not exist must fail BY NAME, the way check-platform-seam.mjs does on
// an input it cannot find, rather than quietly covering less than it claims.
it("fails by name when a scanned root is absent", () => {
  const base = mkdtempSync(join(tmpdir(), "envroster-noroot-"));
  const server = makeServer(join(base, "myne-server"), ONE_KNOB);
  rmSync(join(server, "cmd"), { recursive: true, force: true });
  const ops = makeOps(join(base, "myne-ops"), MATCHING_ROSTER);
  const r = runGuard(server, ops);
  expect(r.code).toBe(1);
  expect(r.out).toContain("the server root cmd does not exist");
});

/** Run the guard with no floor override at all, i.e. against the recorded default. */
function execFileSyncSafe(server: string, ops: string) {
  try {
    const out = execFileSync("node", [GUARD], {
      env: { ...process.env, MYNE_SERVER_DIR: server, MYNE_OPS_DIR: ops },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

// --- rule 4: the deployment artifacts may only name documented knobs -----------------

// The drift this closes: a Helm chart sets a variable as a YAML string, so a typo or a
// renamed knob compiles, starts, and is ignored by the server. Every other rule in this
// guard asks what the SERVER reads, and this file is not read by the server at all.
it("names a server-chart knob that is not on the roster", () => {
  const { server, ops } = pair(ONE_KNOB, MATCHING_ROSTER);
  writeFileSync(
    join(server, "deploy", "helm", "myne-server", "values.yaml"),
    'config:\n  MYNE_ALPHA: "1"\n  MYNE_TYPOED: "1"\n',
  );
  const r = runGuard(server, ops);
  expect(r.code).toBe(1);
  expect(r.out).toContain("MYNE_TYPOED is set by the server chart");
  expect(r.out).toContain("silently does nothing");
});

// The other half of the pair, and the reason the web chart is NOT held to the sync
// server's roster: `MYNE_SYNC_ORIGIN` is read by the web container and by no Go file, so
// checking it against the server's roster would demand the wrong edit. It is checked
// against the container's own sources instead, which is a different failure direction:
// a name the chart sets that the image never reads.
it("names a web-chart knob the web container never reads", () => {
  const { server, ops } = pair(ONE_KNOB, MATCHING_ROSTER);
  writeFileSync(
    join(server, "deploy", "helm", "myne-web", "templates", "deployment.yaml"),
    'env:\n  - name: MYNE_NOT_A_WEB_KNOB\n    value: "1"\n',
  );
  const r = runGuard(server, ops);
  expect(r.code).toBe(1);
  expect(r.out).toContain("MYNE_NOT_A_WEB_KNOB is set by the web chart");
  expect(r.out).toContain("the container would ignore it");
});

// A documented knob in a chart is the case that must stay green, or rule 4a would be a
// rule against charts existing.
it("accepts a chart knob the roster documents", () => {
  const { server, ops } = pair(ONE_KNOB, MATCHING_ROSTER);
  const r = runGuard(server, ops);
  expect(r.code).toBe(0);
  expect(r.out).toContain("agrees in both directions");
});

// The vacuous pass, one directory over: the charts are committed, so their absence is the
// drift, not a smaller check. Same reasoning as the scanned-root case above.
it("fails by name when the server chart is absent", () => {
  const { server, ops } = pair(ONE_KNOB, MATCHING_ROSTER);
  rmSync(join(server, "deploy", "helm", "myne-server"), { recursive: true, force: true });
  const r = runGuard(server, ops);
  expect(r.code).toBe(1);
  expect(r.out).toContain("no server chart at");
});

it("fails by name when the web chart is absent", () => {
  const { server, ops } = pair(ONE_KNOB, MATCHING_ROSTER);
  rmSync(join(server, "deploy", "helm", "myne-web"), { recursive: true, force: true });
  const r = runGuard(server, ops);
  expect(r.code).toBe(1);
  expect(r.out).toContain("no web chart at");
});

// The chart's own floor, driven with no override: an empty chart directory must not read
// as "no undocumented knobs".
it("fails when the chart walk finds nothing", () => {
  const { server, ops } = pair(ONE_KNOB, MATCHING_ROSTER);
  rmSync(join(server, "deploy", "helm", "myne-server", "values.yaml"), { force: true });
  const r = execFileSyncSafe(server, ops);
  expect(r.code).toBe(1);
  expect(r.out).toMatch(/server-chart scan found \d+ MYNE_\* names, below the measured/);
});
