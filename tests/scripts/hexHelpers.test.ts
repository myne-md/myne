import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { decoderFunctions, isLocalDecoder } from "../../scripts/check-hex-helpers.mjs";

// Injection suite for `scripts/check-hex-helpers.mjs`.
//
// Per `AGENTS.md`, verifying a guard means BREAKING it, and each verdict is
// driven against a synthetic tree rather than the real one: the guard reads
// `MYNE_HEX_HELPERS_ROOT`, so nothing here writes into `src/` (a spec that does
// races the other pre-commit guards; `prefsParity.test.ts` recorded that flake).
//
// The writing half is covered too: `--record` must REFUSE a grown set, because a
// `--record` that comes back green has licensed everything it found.
//
// The decoder half (R1.2) is driven the same way, plus two direct arms on the
// exported detector so the exemption rule (a delegate that already routes
// through `protocol::hex`) is asserted rather than assumed.

const ROOT: string = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT: string = join(ROOT, "scripts/check-hex-helpers.mjs");

interface Scratch {
  dir: string;
  rosterPath: string;
  decoderRosterPath: string;
}

const scratches: string[] = [];

function makeTree(): Scratch {
  const dir: string = mkdtempSync(join(tmpdir(), "hex-helpers-"));
  scratches.push(dir);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "a"), { recursive: true });
  const rosterPath = join(dir, "scripts", "hex-helpers.json");
  const decoderRosterPath = join(dir, "scripts", "hex-helpers-decoders.json");
  // Both rosters exist from the start: a missing decoder roster is its own
  // failure, and every case below is about a verdict rather than that one.
  writeFileSync(decoderRosterPath, "{}\n");
  writeFileSync(rosterPath, "{}\n");
  return { dir, rosterPath, decoderRosterPath };
}

function writeHelper(dir: string, rel: string, symbol: string): void {
  const body = `pub fn ${symbol}(bytes: &[u8]) -> String {\n    format!("{bytes:?}")\n}\n`;
  writeFileSync(join(dir, rel), body);
}

/** A hand-rolled hex decoder: a body that re-derives the nibble walk. */
function writeDecoder(dir: string, rel: string, symbol: string): void {
  const body =
    `fn ${symbol}(s: &str) -> Option<[u8; 16]> {\n` +
    `    let mut out = [0u8; 16];\n` +
    `    for (i, b) in out.iter_mut().enumerate() {\n` +
    `        *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;\n` +
    `    }\n` +
    `    Some(out)\n` +
    `}\n`;
  writeFileSync(join(dir, rel), body);
}

function writeRoster(path: string, entries: Record<string, string>): void {
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`);
}

function run(
  root: string,
  args: string[] = [],
  extraEnv: Record<string, string> = {},
): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync("node", [SCRIPT, ...args], {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          MYNE_HEX_HELPERS_ROOT: root,
          // Synthetic trees hold a function or two; the real floor is asserted
          // in its own case below.
          MYNE_HEX_HELPERS_DECODER_FLOOR: "0",
          ...extraEnv,
        },
      }),
    };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

const RECORDED = { "a/one.rs::hex_lower": "a recorded encoder debt entry, with a reason" };
const DECODER_RECORDED = {
  "a/one.rs::hex16": "a recorded decoder debt entry, with a reason",
};

afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("check-hex-helpers (encoder half)", () => {
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
    // And the encoder half still catches what it caught before the decoder
    // half landed: the roster is untouched by the refusal.
    expect(JSON.parse(readFileSync(rosterPath, "utf8"))).toEqual(RECORDED);
  });
});

describe("check-hex-helpers (decoder half)", () => {
  it("passes when every found decoder is recorded", () => {
    const { dir, decoderRosterPath } = makeTree();
    writeDecoder(dir, "a/one.rs", "hex16");
    writeRoster(decoderRosterPath, DECODER_RECORDED);
    expect(run(dir).code).toBe(0);
  });

  it("fails, naming it, on a NEW local decoder", () => {
    const { dir, decoderRosterPath } = makeTree();
    writeDecoder(dir, "a/one.rs", "hex16");
    writeDecoder(dir, "a/two.rs", "parse_hex_32");
    writeRoster(decoderRosterPath, DECODER_RECORDED);
    const { code, out } = run(dir);
    expect(code).toBe(1);
    expect(out).toContain("a/two.rs::parse_hex_32");
  });

  it("catches a decoder by BODY even when its name is not in the family", () => {
    const { dir, decoderRosterPath } = makeTree();
    // `decode_token_line`-shaped: the name says nothing, the nibble walk does.
    writeDecoder(dir, "a/one.rs", "split_line");
    writeRoster(decoderRosterPath, {
      "a/one.rs::split_line": "an anonymous-body decoder, recorded as debt",
    });
    expect(run(dir).code).toBe(0);
    writeRoster(decoderRosterPath, {});
    const { code, out } = run(dir);
    expect(code).toBe(1);
    expect(out).toContain("a/one.rs::split_line");
  });

  it("does NOT flag a delegate that already routes through protocol::hex", () => {
    const { dir, decoderRosterPath } = makeTree();
    writeFileSync(
      join(dir, "a", "one.rs"),
      "fn hex_decode_16(s: &str) -> Option<[u8; 16]> {\n    protocol::hex::decode_lower(s)\n}\n",
    );
    writeRoster(decoderRosterPath, {});
    const { code } = run(dir);
    expect(code).toBe(0);
  });

  it("does NOT flag a test function named after the decoder it exercises", () => {
    const { dir, decoderRosterPath } = makeTree();
    writeFileSync(
      join(dir, "a", "one.rs"),
      "#[test]\nfn hex16_rejects_short_length() {\n    assert!(super::hex16(\"ab\").is_none());\n}\n",
    );
    writeRoster(decoderRosterPath, {});
    expect(run(dir).code).toBe(0);
  });

  it("fails on a recorded decoder that no longer exists (stale)", () => {
    const { dir, decoderRosterPath } = makeTree();
    writeFileSync(join(dir, "a", "one.rs"), "fn something_else() {}\n");
    writeRoster(decoderRosterPath, DECODER_RECORDED);
    const { code, out } = run(dir);
    expect(code).toBe(1);
    expect(out).toContain("a/one.rs::hex16");
    expect(out).toContain("no longer defined");
  });

  it("rejects a placeholder reason", () => {
    const { dir, decoderRosterPath } = makeTree();
    writeDecoder(dir, "a/one.rs", "hex16");
    writeRoster(decoderRosterPath, { "a/one.rs::hex16": "TODO" });
    const { code, out } = run(dir);
    expect(code).toBe(1);
    expect(out).toContain("reason");
  });

  it("--record REFUSES a grown decoder set rather than locking it in", () => {
    const { dir, decoderRosterPath } = makeTree();
    writeDecoder(dir, "a/one.rs", "hex16");
    writeDecoder(dir, "a/two.rs", "hex16");
    writeRoster(decoderRosterPath, DECODER_RECORDED);
    const { code, out } = run(dir, ["--record"]);
    expect(code).toBe(1);
    expect(out).toContain("refusing to --record a GROWN");
    expect(out).toContain("a/two.rs::hex16");
  });

  it("fails BY NAME when the scan finds fewer sites than the floor", () => {
    const { dir } = makeTree();
    const { code, out } = run(dir, [], { MYNE_HEX_HELPERS_DECODER_FLOOR: "5" });
    expect(code).toBe(1);
    expect(out).toContain("below the floor");
  });

  it("fails BY NAME when the scan root cannot be read", () => {
    const missing = join(tmpdir(), "hex-helpers-does-not-exist");
    const { code, out } = run(missing);
    expect(code).toBe(1);
    expect(out).toContain("scan root does not exist");
  });
});

describe("check-hex-helpers (real tree)", () => {
  it("passes against the shipped rosters and reports both halves", () => {
    // No root override: the guard reads THIS checkout, so the recorded rosters
    // are asserted to describe the tree they ship with rather than a fixture.
    const out: string = execFileSync("node", [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, MYNE_HEX_HELPERS_DECODER_FLOOR: "0" },
    });
    expect(out).toContain("hex helpers: ok");
    expect(out).toContain("local decoder(s) recorded as debt");
  });
});

describe("decoder detector (direct arms)", () => {
  it("walks a body to its own closing brace across a nested block", () => {
    const fns = decoderFunctions(
      "fn a() {\n    if x {\n        let y = 1;\n    }\n}\nfn b() {}\n",
    );
    expect(fns.map((f) => f.name)).toEqual(["a", "b"]);
  });

  it("isLocalDecoder: name match, body marker, and the routing exemption", () => {
    const marker = { name: "split_line", body: "u8::from_str_radix(&s[..2], 16)" };
    expect(isLocalDecoder(marker)).toBe(true);
    expect(isLocalDecoder({ name: "hex_to_bytes", body: "Vec::new()" })).toBe(true);
    expect(
      isLocalDecoder({ name: "hex_decode_16", body: "protocol::hex::decode_lower(s)" }),
    ).toBe(false);
    expect(isLocalDecoder({ name: "unrelated", body: "Vec::new()" })).toBe(false);
  });
});
