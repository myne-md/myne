// Nothing leaves the device, observed at the PROCESS rather than at one port
// (test-audit #21).
//
// ne1 — drive an ordinary offline session and, while it runs, ask the KERNEL
//       which remote endpoints the running app actually holds. Every one must
//       be loopback.
//
// WHY THIS EXISTS. "No byte leaves the device unless the user asked" is the
// product's central claim, and every existing proof of it is narrow in a
// different way. `ai-no-network-check.sh` reads `cargo tree` for crate NAMES —
// its own header says so, and says plainly that it does not prove the binary
// has no network path, because `std::net` needs no crate. Its check 4 is a
// source-level allowlist of call sites: a grep, and one that can only see the
// call sites someone wrote down. `aob1` counts accepts on ONE fake server, so
// it proves nothing about a socket opened to a different address. None of them
// observes the process.
//
// This one does, and it is deliberately not a source check: it reads
// `/proc/<pid>/fd` for the app's socket inodes and joins them against
// `/proc/net/{tcp,tcp6,udp,udp6}`, which is the kernel's own answer to "what is
// this process connected to". A build that grew an outbound connection through
// a crate nobody listed, a `std::net` call nobody grepped, or a dependency's
// background thread would show up here and nowhere else.
//
// HONEST LIMITS, because a test claiming this much must state them:
//   - It SAMPLES. A connection opened and closed entirely between two samples
//     is missed. Sampling runs throughout the session rather than once at the
//     end, which is the difference between "we looked" and "we looked while
//     things were happening", but it is not continuous capture. A packet-level
//     assertion needs NET_ADMIN in the container and is a separate piece of
//     infrastructure.
//   - It observes THIS build under THIS scenario: offline, no sync endpoint, no
//     AI provider. That is the configuration the claim is strongest about and
//     the one a fresh install is in.
//   - Loopback is allowed, and must be: the CLI command socket, the clipper
//     relay and a local model runtime all live there by design (TB12), and the
//     WebDriver session driving this test is itself a loopback client.
//
// Vault-count precondition: 1 (weak KDF generator fixture — legal: unlock reads
// params from vault.meta). SYNC-13: no credential reaches an assertion here.

import { expect, it } from "vitest";
import { readFileSync, readlinkSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";

/** One observed remote endpoint: the process that held it and where it points. */
interface Endpoint {
  pid: number;
  proto: string;
  remote: string;
}

/** Pids of the app under test. Matched on the binary name rather than tracked
 *  from the spawn, because tauri-driver launches it and the harness never sees
 *  the child's pid — and because a SECOND myne-desktop process (a helper, a
 *  respawn) is exactly the thing a per-pid handle would miss. */
function appPids(): number[] {
  try {
    const out: string = execFileSync("pgrep", ["-f", "myne-desktop"], {
      encoding: "utf8",
    });
    return out
      .split("\n")
      .map((line: string) => Number(line.trim()))
      .filter((n: number) => Number.isFinite(n) && n > 0);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

/** `/proc/net/*`'s hex address column -> a readable address. */
function decodeHexAddr(hex: string): string {
  const [addrHex, portHex] = hex.split(":");
  const port = parseInt(portHex ?? "0", 16);
  if ((addrHex ?? "").length === 8) {
    // IPv4, little-endian per byte pair.
    const b = (addrHex ?? "").match(/../g) ?? [];
    const dotted = b
      .reverse()
      .map((x) => parseInt(x, 16))
      .join(".");
    return `${dotted}:${port}`;
  }
  // IPv6 — only the loopback/unspecified cases need naming precisely; anything
  // else is reported verbatim, which is enough to fail a test by.
  const zeros = /^0{32}$/.test(addrHex ?? "");
  const v6Loopback = /^0{24}0{7}1$/i.test(addrHex ?? "") || /^0{31}1$/i.test(addrHex ?? "");
  if (zeros) return `[::]:${port}`;
  if (v6Loopback) return `[::1]:${port}`;
  return `[${addrHex}]:${port}`;
}

/** Is this remote endpoint on the machine itself? */
function isLocal(remote: string): boolean {
  return (
    remote.startsWith("127.") ||
    remote.startsWith("0.0.0.0:") ||
    remote.startsWith("[::1]:") ||
    remote.startsWith("[::]:")
  );
}

/** Every remote endpoint the app's processes hold, right now. */
function sampleEndpoints(): Endpoint[] {
  const pids = appPids();
  /** socket inode -> pid */
  const owned = new Map<string, number>();
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue; // raced the process exiting, or not ours to read
    }
    for (const fd of fds) {
      try {
        const link = readlinkSync(`/proc/${pid}/fd/${fd}`);
        const m = /^socket:\[(\d+)\]$/.exec(link);
        if (m) owned.set(m[1]!, pid);
      } catch {
        /* fd closed under us */
      }
    }
  }
  if (owned.size === 0) return [];

  const found: Endpoint[] = [];
  for (const proto of ["tcp", "tcp6", "udp", "udp6"]) {
    let text: string;
    try {
      text = readFileSync(`/proc/net/${proto}`, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      const remoteHex = cols[2] ?? "";
      const inode = cols[9] ?? "";
      const pid = owned.get(inode);
      if (pid === undefined) continue;
      found.push({ pid, proto, remote: decodeHexAddr(remoteHex) });
    }
  }
  return found;
}

describeE2E("ne1 an ordinary session opens no connection off this machine (test-audit #21)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("holds only loopback endpoints while unlocking, writing and saving", async () => {
    let password = "";
    const offMachine: Endpoint[] = [];
    /** Take a reading and keep anything that points off the machine. */
    const sample = (): void => {
      for (const e of sampleEndpoints()) {
        if (!isLocal(e.remote)) offMachine.push(e);
      }
    };

    await scenario(
      "ne1-no-egress",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        // Sample AROUND each step, not once at the end: a connection opened for
        // one operation and closed before the next would otherwise be invisible.
        sample();
        await unlockToEditor(s, password);
        sample();
        await dismissImporterOffer(s);
        sample();
        await createNote(s, "ne1noteoffline7k2m9qx4w5");
        sample();
        await typeIntoEditor(s, "nothing here should leave the device");
        sample();
        await waitForSaved(s);
        sample();

        // The measurement must be shown to work, or a run where `pgrep` found
        // nothing and every sample came back empty would "pass" while observing
        // NOTHING. That is the vacuous-pass this whole file exists to avoid.
        expect(
          appPids().length,
          "no myne-desktop process was found — this test observed nothing at all",
        ).toBeGreaterThan(0);
        expect(
          sampleEndpoints().length,
          "the app holds no sockets at all, which means the reader is broken: " +
            "the WebView and the driver session alone guarantee loopback ones",
        ).toBeGreaterThan(0);
      },
    );

    expect(
      offMachine,
      "an offline session must hold no endpoint off this machine — " +
        `saw ${JSON.stringify(offMachine)}`,
    ).toEqual([]);
  });
});
