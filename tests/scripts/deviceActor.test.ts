// check-device-actor: every arm of the guard, driven by injection.
//
// The guard's header makes a claim a reader is entitled to hold it to: a second reader of "which
// device is this" fails the commit. A guard that has never failed is a guard nobody has tested, so
// each case below plants the defect and asserts the guard names THAT defect, then restores and
// asserts the tree is clean again. The reason is this repository's own history: myne-md/myne#958
// shipped because both wrong reads COMPILED, logged nothing and broke no test, and the sibling
// finding is that a guard's --record half is the half nobody verifies (`check-ipc-binding-callers`
// seeded every fresh entry with a placeholder that its own length check accepted).
//
// Four arms, and the last two are the ones that matter most:
//   1. an UNRECORDED read fails by file, line and source text;
//   2. a RECORDED line that has left the tree fails as stale, so the record cannot rot into a
//      statement about a tree that no longer exists;
//   3. `--record` on a tree carrying an unseen read writes it with an EMPTY reason, and an empty
//      reason is itself a failure, so the command the failure message recommends cannot be used
//      to make the failure go away;
//   4. a COPY of an already-licensed line is unrecorded too. This is the likeliest second reader
//      (copy-paste produces identical text) and it was silent while the record was keyed by text
//      alone: one reason licensed every copy forever.
//
// Every planting case runs under `MYNE_DEVICE_ACTOR_ROOT` against a temp root, so no probe is ever
// written into a real source tree: a killed run must not leave a stray `.rs` file behind that turns
// every later `pre-commit` red (AGENTS.md: any process interrupted mid-write leaves the tree as its
// last command left it).

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const GUARD = join(ROOT, "scripts/check-device-actor.mjs");
const PROBE = "core/src/plugins/sync/zz_device_actor_probe.rs";

/** Run the guard against `root`, which defaults to the real checkout. */
function runGuard(args: string[] = [], root = ROOT): { code: number; out: string } {
  try {
    const out = execFileSync("node", [GUARD, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, MYNE_DEVICE_ACTOR_ROOT: root },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/** A throwaway checkout root the guard can walk, with no source of ours in it. */
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "device-actor-guard-"));
  mkdirSync(join(dir, "core/src/plugins/sync"), { recursive: true });
  return dir;
}

function plant(root: string, source: string, file = PROBE): void {
  writeFileSync(join(root, file), source);
}

function recordOf(root: string): { readers: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(root, "scripts/device-actor-readers.json"), "utf8"));
}

/** A read of the raw field, in the shape the guard matches: `.device_id_hex`. */
const PROBE_SOURCE = `// SPDX-License-Identifier: AGPL-3.0-only
//! Injection probe: a second reader of this device's id, which must not compile into a commit.
pub fn second_reader(st: &super::state::SyncState) -> Option<String> {
    st.device_id_hex.clone()
}
`;

const PROBE_TEXT = "st.device_id_hex.clone()";

describe("check-device-actor", () => {
  it("passes on the tree as committed", () => {
    const { code, out } = runGuard();
    expect(code).toBe(0);
    expect(out).toContain("the only reader of the vault's identity");
  });

  it("names an unrecorded read by file, line and source text", () => {
    const root = tempRoot();
    plant(root, PROBE_SOURCE);
    const { code, out } = runGuard([], root);
    expect(code).toBe(1);
    expect(out).toContain(`unrecorded: ${PROBE}:4`);
    expect(out).toContain(PROBE_TEXT);
    // Not a bare count: the message has to say what to do instead.
    expect(out).toContain("durable_device_id");
  });

  it("fails a recorded line that has left the tree as stale", () => {
    const root = tempRoot();
    plant(root, PROBE_SOURCE);
    runGuard(["--record"], root);
    // The line is gone; the entry is not. A record that keeps describing a tree that no longer
    // exists is the same rot one step later.
    writeFileSync(join(root, PROBE), "// nothing to read here\n");
    const { code, out } = runGuard([], root);
    expect(code).toBe(1);
    expect(out).toContain(`stale: ${PROBE}`);
  });

  it("does not let --record license the read it found", () => {
    const root = tempRoot();
    plant(root, PROBE_SOURCE);
    // The command the failure message recommends.
    const recorded = runGuard(["--record"], root);
    expect(recorded.out).toContain("WITHOUT a reason");
    // …and the tree is STILL not acceptable: an empty reason is a failure, not a pass.
    const after = runGuard([], root);
    expect(after.code).toBe(1);
    expect(after.out).toContain(PROBE);
  });

  it("rejects a reason too short to say anything", () => {
    const root = tempRoot();
    plant(root, PROBE_SOURCE);
    runGuard(["--record"], root);
    // A human writes a placeholder instead of a reason: the same trap one field over.
    const record = recordOf(root);
    record.readers[PROBE] = { [PROBE_TEXT]: { count: 1, reason: "todo" } };
    writeFileSync(join(root, "scripts/device-actor-readers.json"), JSON.stringify(record, null, 2));
    const { code, out } = runGuard([], root);
    expect(code).toBe(1);
    expect(out).toContain("says nothing about why it may read the raw field");
  });

  it("fails a COPY of a line the record already licenses", () => {
    // The copy-paste arm. Two identical lines, one recorded reason covering both, then a third
    // copy appears: text-keyed, that third reader was licensed for free and the guard stayed
    // green while a second reader of the device id compiled into a commit.
    const root = tempRoot();
    plant(root, PROBE_SOURCE + PROBE_SOURCE);
    runGuard(["--record"], root);
    const record = recordOf(root);
    record.readers[PROBE] = {
      [PROBE_TEXT]: {
        count: 2,
        reason: "an injection fixture whose reason is long enough to pass the length check",
      },
    };
    writeFileSync(join(root, "scripts/device-actor-readers.json"), JSON.stringify(record, null, 2));
    // Recorded count and observed count agree: clean.
    expect(runGuard([], root).code).toBe(0);

    appendFileSync(join(root, PROBE), PROBE_SOURCE);
    const { code, out } = runGuard([], root);
    expect(code).toBe(1);
    expect(out).toContain("unrecorded copy");
    expect(out).toContain("licenses 2");
  });

  it("walks every Rust tree that can answer the question", () => {
    // A file in a tree OUTSIDE `core/src` is caught too: the mobile client and the wasm entry
    // consume `myne-core`, and a client that grows its own read is the same defect one crate
    // over. Asserted on the roots the guard really walks, not on a comment saying so.
    const root = tempRoot();
    mkdirSync(join(root, "web/wasm/src"), { recursive: true });
    plant(root, PROBE_SOURCE, "web/wasm/src/dispatch.rs");
    const { code, out } = runGuard([], root);
    expect(code).toBe(1);
    expect(out).toContain("unrecorded: web/wasm/src/dispatch.rs:4");

    // …and the committed record covers reads in more than one tree.
    const files = Object.keys(recordOf(ROOT).readers);
    expect(files.filter((f) => f.startsWith("core/src")).length).toBeGreaterThan(5);
    expect(files.some((f) => f.startsWith("web/wasm/src"))).toBe(true);
  });
});
