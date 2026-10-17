import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

// Injection suite for `scripts/check-hex-helpers.mjs`.
//
// Per `AGENTS.md`, verifying a guard means BREAKING it, and each verdict is
// driven against a synthetic tree rather than the real one: the guard reads
// `MYNE_HEX_HELPERS_ROOT`, so nothing here writes into `src/` (a spec that does
// races the other pre-commit guards; `prefsParity.test.ts` recorded that flake).
//
// The writing half is covered too: `--record` must REFUSE a grown set, because a
// `--record` that comes back green has licensed everything it found.

const ROOT: string = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT: string = join(ROOT, "scripts/check-hex-helpers.mjs");

interface Scratch {
  dir: string;
  rosterPath: string;
}

const scratches: string[] = [];

function makeTree(): Scratch {
  const dir: string = mkdtempSync(join(tmpdir(), "hex-helpers-"));
  scratches.push(dir);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "a"), { recursive: true });
  return { dir, rosterPath: join(dir, "scripts", "hex-helpers.json") };
}

function writeHelper(dir: string, rel: string, symbol: string): void {
  const body = `pub fn ${symbol}(bytes: &[u8]) -> String {\n    format!("{bytes:?}")\n}\n`;
  writeFileSync(join(dir, rel), body);
}

function writeRoster(path: string, entries: Record<string, string>): void {
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`);
}

function run(root: string, args: string[] = []): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync("node", [SCRIPT, ...args], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, MYNE_HEX_HELPERS_ROOT: root },
      }),
    };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

const RECORDED = { "a/one.rs::hex_lower": "a recorded encoder debt entry, with a reason" };

afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("check-hex-helpers", () => {
  it("passes when every found helper is recorded", () => {
    const { dir, rosterPath } = makeTree();
    writeHelper(dir, "a/one.rs", "hex_lower");
    writeRoster(rosterPath, RECORDED);
    expect(run(dir).code).toBe(0);
  });

  it("fails, naming it, on a NEW local helper", () => {
    const { dir, rosterPath } = makeTree();
    writeHelper(dir, "a/one.rs", "hex_lower");
    writeHelper(dir, "a/two.rs", "is_lower_hex");
    writeRoster(rosterPath, RECORDED);
    const { code, out } = run(dir);
    expect(code).toBe(1);
    expect(out).toContain("a/two.rs::is_lower_hex");
  });

  it("fails on a recorded helper that no longer exists (stale)", () => {
    const { dir, rosterPath } = makeTree();
    // The file exists but the recorded symbol is gone.
    writeFileSync(join(dir, "a", "one.rs"), "pub fn something_else() {}\n");
    writeRoster(rosterPath, RECORDED);
    const { code, out } = run(dir);
    expect(code).toBe(1);
    expect(out).toContain("a/one.rs::hex_lower");
    expect(out).toContain("no longer defined");
  });

  it("rejects a placeholder reason", () => {
    const { dir, rosterPath } = makeTree();
    writeHelper(dir, "a/one.rs", "hex_lower");
    writeRoster(rosterPath, { "a/one.rs::hex_lower": "TODO" });
    const { code, out } = run(dir);
    expect(code).toBe(1);
    expect(out).toContain("reason");
  });

  it("--record REFUSES a grown set rather than locking it in", () => {
    const { dir, rosterPath } = makeTree();
    writeHelper(dir, "a/one.rs", "hex_lower");
    writeHelper(dir, "a/two.rs", "hex_lower");
    writeRoster(rosterPath, RECORDED);
    const { code, out } = run(dir, ["--record"]);
    expect(code).toBe(1);
    expect(out).toContain("refusing to --record a GROWN");
    expect(out).toContain("a/two.rs::hex_lower");
  });
});
