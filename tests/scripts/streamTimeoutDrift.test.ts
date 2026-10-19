// Injection tests for `scripts/check-stream-timeout-drift.mjs` (audit 2026-10-18,
// Aşama 6 B1+B2).
//
// The guard exists because two cross-repo numbers were written twice and compared
// by nothing: the server's SSE heartbeat cadence (`myne-server`, two constants)
// against the client's stream read timeout, and the server's blob-fetch caps
// against the client's mirrored window bounds. Both sides said so in prose.
//
// Two layers are asserted, and the second is the one that matters:
//   - the pure parse/compare functions, driven with injected inputs, so a renamed
//     constant returns `null` (the caller then fails by name) and a disagreement
//     names BOTH numbers;
//   - the whole guard, end-to-end against a fixture companion tree it builds, so
//     the "I could not find my input" arm is exercised as the guard would hit it.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareFetchCap,
  compareServerHeartbeats,
  compareStreamTimeout,
  evalProduct,
  parseAwarenessHeartbeat,
  parseClientFetchBlobs,
  parseClientFetchBytes,
  parsePokeHeartbeat,
  parseServerFetchBytes,
  parseServerFetchIds,
  parseSseReadTimeout,
} from "../../scripts/check-stream-timeout-drift.mjs";

// NOT import.meta.dirname: it is not on ImportMeta under this repo's tsconfig, and
// tests/ is excluded from tsconfig.json, so check-test-typecheck.mjs is the one
// thing that typechecks this file.
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GUARD = join(REPO_ROOT, "scripts", "check-stream-timeout-drift.mjs");

// --- pure parse functions ----------------------------------------------------

describe("parsePokeHeartbeat", () => {
  it("reads the poke cadence and scales seconds to milliseconds", () => {
    expect(parsePokeHeartbeat("const DefaultHeartbeatInterval = 30 * time.Second")).toBe(30_000);
  });

  it("returns null on a renamed constant, so the caller fails by name", () => {
    expect(parsePokeHeartbeat("const DefaultHeartbeatEvery = 30 * time.Second")).toBeNull();
  });

  it("does not match the awareness constant's shorter name", () => {
    // `DefaultHeartbeatInterval` and `DefaultHeartbeat` share a prefix; the poke
    // pattern is pinned to its own name so one file cannot satisfy the other's parse.
    expect(parsePokeHeartbeat("DefaultHeartbeat = 30 * time.Second")).toBeNull();
  });
});

describe("parseAwarenessHeartbeat", () => {
  it("reads the awareness cadence from inside the const block", () => {
    expect(parseAwarenessHeartbeat("DefaultHeartbeat      = 30 * time.Second")).toBe(30_000);
  });

  it("does not swallow the poke constant's longer name", () => {
    expect(parseAwarenessHeartbeat("const DefaultHeartbeatInterval = 30 * time.Second")).toBeNull();
  });

  it("returns null on a renamed constant", () => {
    expect(parseAwarenessHeartbeat("DefaultKeepAlive = 30 * time.Second")).toBeNull();
  });
});

describe("parseSseReadTimeout", () => {
  it("reads the `Duration::from_secs` form and scales it to milliseconds", () => {
    expect(
      parseSseReadTimeout(
        "pub(crate) const SSE_READ_TIMEOUT: Duration = Duration::from_secs(65);",
      ),
    ).toBe(65_000);
  });

  it("does not match a private or differently-typed declaration", () => {
    // `pub(crate)` and the `Duration` type are load-bearing: a different shape is a
    // different fact, and matching it loosely compares a value with not-the-value.
    expect(parseSseReadTimeout("const SSE_READ_TIMEOUT: u64 = 65;")).toBeNull();
  });

  it("returns null on a renamed constant", () => {
    expect(
      parseSseReadTimeout("pub(crate) const SSE_DEADLINE: Duration = Duration::from_secs(65);"),
    ).toBeNull();
  });
});

describe("evalProduct", () => {
  it("multiplies a product and strips numeric separators", () => {
    expect(evalProduct("8 * 1024 * 1024")).toBe(8_388_608);
    expect(evalProduct("1_000_000")).toBe(1_000_000);
  });

  it("reads a lone integer", () => {
    expect(evalProduct("256")).toBe(256);
  });
});

describe("the blob-fetch cap parsers", () => {
  it("reads both server caps, evaluating the byte product", () => {
    const src = "const MaxBlobFetchIDs = 256\nconst MaxBlobFetchBytes = 8 * 1024 * 1024\n";
    expect(parseServerFetchIds(src)).toBe(256);
    expect(parseServerFetchBytes(src)).toBe(8_388_608);
  });

  it("does not confuse the byte cap with the request-body cap", () => {
    // `MaxBlobFetchRequestBytes` shares a prefix; the pattern is pinned to the name.
    expect(parseServerFetchBytes("const MaxBlobFetchRequestBytes = 64 * 1024")).toBeNull();
  });

  it("reads both client window bounds, evaluating the byte product", () => {
    const src =
      "const FETCH_WINDOW_MAX_BLOBS: usize = 256;\n" +
      "const FETCH_WINDOW_MAX_BYTES: usize = 8 * 1024 * 1024;\n";
    expect(parseClientFetchBlobs(src)).toBe(256);
    expect(parseClientFetchBytes(src)).toBe(8_388_608);
  });

  it("returns null on a renamed constant, so the caller fails by name", () => {
    expect(parseServerFetchIds("const MaxFetchIds = 256")).toBeNull();
    expect(parseClientFetchBytes("const FETCH_WINDOW_BYTES: usize = 8 * 1024 * 1024;")).toBeNull();
  });
});

// --- pure compare functions --------------------------------------------------

describe("compareStreamTimeout", () => {
  it("accepts the pair the guard exists for (65 s over two 30 s heartbeats)", () => {
    expect(compareStreamTimeout(65_000, 30_000, "the poke route")).toBeNull();
  });

  it("names both numbers when the heartbeat rises past the timeout's coverage", () => {
    const message = compareStreamTimeout(65_000, 40_000, "the poke route");
    expect(message).toContain("SSE_READ_TIMEOUT = 65 s");
    expect(message).toContain("one every 40 s");
    expect(message).toContain("the poke route");
  });

  it("requires a positive margin above two heartbeats, not just above one", () => {
    // 60 s covers exactly two 30 s heartbeats with no margin, which the client's own
    // doc explicitly does not allow.
    expect(compareStreamTimeout(60_000, 30_000, "the poke route")).not.toBeNull();
    expect(compareStreamTimeout(61_000, 30_000, "the poke route")).toBeNull();
  });

  it("defers to the missing-input failure rather than reporting a verdict", () => {
    expect(compareStreamTimeout(null, 30_000, "the poke route")).toBeNull();
    expect(compareStreamTimeout(65_000, null, "the poke route")).toBeNull();
  });
});

describe("compareServerHeartbeats", () => {
  it("accepts the two routes sharing one cadence", () => {
    expect(compareServerHeartbeats(30_000, 30_000)).toBeNull();
  });

  it("names both files when the routes diverge", () => {
    const message = compareServerHeartbeats(30_000, 45_000);
    expect(message).toContain("internal/poke/poke.go");
    expect(message).toContain("internal/awareness/handler.go");
    expect(message).toContain("30 s");
    expect(message).toContain("45 s");
  });

  it("defers to the missing-input failure", () => {
    expect(compareServerHeartbeats(null, 30_000)).toBeNull();
    expect(compareServerHeartbeats(30_000, null)).toBeNull();
  });
});

describe("compareFetchCap", () => {
  it("accepts the mirrored pair", () => {
    expect(compareFetchCap(256, 256, "the blob-fetch id cap")).toBeNull();
  });

  it("names both when the server cap drops below the client's window", () => {
    const message = compareFetchCap(128, 256, "the blob-fetch id cap");
    expect(message).toContain("the blob-fetch id cap");
    expect(message).toContain("caps it at 128");
    expect(message).toContain("windows for 256");
  });

  it("treats a server cap ABOVE the client's window as safe", () => {
    // The dangerous direction is a smaller server value; a larger one is headroom
    // the client never reaches, and gating it would teach people to route around it.
    expect(compareFetchCap(512, 256, "the blob-fetch id cap")).toBeNull();
  });

  it("defers to the missing-input failure", () => {
    expect(compareFetchCap(null, 256, "the blob-fetch id cap")).toBeNull();
    expect(compareFetchCap(256, null, "the blob-fetch id cap")).toBeNull();
  });
});

// --- the whole guard, against a fixture companion tree -----------------------

/** A companion `myne-server` tree carrying the three files the guard reads. */
function makeServer(heartbeat = 30, ids = 256, bytes = "8 * 1024 * 1024"): string {
  const dir = mkdtempSync(join(tmpdir(), "stream-drift-"));
  const poke = join(dir, "internal", "poke");
  const awareness = join(dir, "internal", "awareness");
  const syncapi = join(dir, "internal", "syncapi");
  mkdirSync(poke, { recursive: true });
  mkdirSync(awareness, { recursive: true });
  mkdirSync(syncapi, { recursive: true });
  writeFileSync(
    join(poke, "poke.go"),
    `package poke\n\nimport "time"\n\nconst DefaultHeartbeatInterval = ${heartbeat} * time.Second\n`,
  );
  writeFileSync(
    join(awareness, "handler.go"),
    `package awareness\n\nimport "time"\n\nconst (\n\tDefaultHeartbeat = ${heartbeat} * time.Second\n)\n`,
  );
  writeFileSync(
    join(syncapi, "syncapi.go"),
    `package syncapi\n\nconst MaxBlobFetchIDs = ${ids}\nconst MaxBlobFetchBytes = ${bytes}\n`,
  );
  return dir;
}

function runGuard(server: string, args: string[] = []) {
  try {
    const out = execFileSync("node", [GUARD, ...args], {
      env: { ...process.env, MYNE_SERVER_DIR: server },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

describe("check-stream-timeout-drift (end-to-end)", () => {
  it("passes when the companion's values agree with the client's mirror", () => {
    const r = runGuard(makeServer());
    expect(r.code).toBe(0);
    expect(r.out).toContain("agree with the client's mirror");
  });

  it("names both numbers when the server heartbeat outruns the client timeout", () => {
    const r = runGuard(makeServer(40));
    expect(r.code).toBe(1);
    expect(r.out).toContain("SSE_READ_TIMEOUT = 65 s");
    expect(r.out).toContain("one every 40 s");
  });

  it("names the smaller server id cap", () => {
    const r = runGuard(makeServer(30, 128));
    expect(r.code).toBe(1);
    expect(r.out).toContain("the blob-fetch id cap is SMALLER on the server");
    expect(r.out).toContain("caps it at 128");
  });

  it("names the smaller server byte cap", () => {
    const r = runGuard(makeServer(30, 256, "4 * 1024 * 1024"));
    expect(r.code).toBe(1);
    expect(r.out).toContain("the blob-fetch byte cap is SMALLER on the server");
    expect(r.out).toContain("caps it at 4194304");
  });

  it("records a larger server cap as a note rather than a failure", () => {
    const r = runGuard(makeServer(30, 512, "16 * 1024 * 1024"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("is above the client's window");
  });

  it("fails BY NAME when a constant was renamed, instead of printing ok over nothing", () => {
    const dir = makeServer();
    writeFileSync(
      join(dir, "internal", "poke", "poke.go"),
      `package poke\n\nimport "time"\n\nconst DefaultHeartbeatEvery = 30 * time.Second\n`,
    );
    const r = runGuard(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no `const DefaultHeartbeatInterval = <n> * time.Second` declaration");
    expect(r.out).toContain("teach this guard the new shape");
  });

  it("reports NOTHING COMPARED when the companion is absent, and fails under --require-companion", () => {
    const absent = join(mkdtempSync(join(tmpdir(), "stream-drift-absent-")), "no-server");
    const skip = runGuard(absent);
    expect(skip.code).toBe(0);
    expect(skip.out).toContain("NOTHING COMPARED");
    expect(skip.out).toContain("not a verdict");
    const strict = runGuard(absent, ["--require-companion"]);
    expect(strict.code).toBe(1);
    expect(strict.out).toContain("--require-companion was passed");
  });
});
