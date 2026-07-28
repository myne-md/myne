// Unsupported-environment gate (phase3-web-client task 29).

import { describe, expect, it, vi } from "vitest";
import {
  explainMissing,
  gateEnvironment,
  NATIVE_HANDOFF,
  probeEnvironment,
  type EnvironmentProbes,
  type RequiredCapability,
} from "../../web/src/environment-gate";

const ALL_CAPABLE: EnvironmentProbes = {
  hasWebAssembly: () => true,
  canReserveWasmMemory: () => true,
  hasWorker: () => true,
  hasOpfs: () => true,
  hasWebLocks: () => true,
  hasCryptoRandom: () => true,
};

const without = (o: Partial<EnvironmentProbes>): EnvironmentProbes => ({ ...ALL_CAPABLE, ...o });

describe("environment gate", () => {
  it("admits a fully capable desktop browser", () => {
    expect(probeEnvironment(ALL_CAPABLE)).toEqual({ supported: true, missing: [] });
  });

  // The iOS-Safari case. This is the whole reason the gate exists: without it
  // the failure surfaces as a dead tab part-way into Argon2id, after the user
  // has already typed their password.
  it("refuses a browser that cannot reserve the KDF's memory", () => {
    const v = probeEnvironment(without({ canReserveWasmMemory: () => false }));
    expect(v.supported).toBe(false);
    expect(v.missing).toContain("wasm-memory-headroom");
  });

  it("asks for enough memory to cover the measured working set, not just the block", () => {
    // The Phase 0 spike measured wasm linear memory settling at 321 MiB — the
    // 256 MiB Argon2 block plus allocator overhead. A probe sized at 256 MiB
    // would admit a browser that then dies on the overhead.
    const seen: number[] = [];
    probeEnvironment(
      without({
        canReserveWasmMemory: (pages) => {
          seen.push(pages);
          return true;
        },
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0] * 65536).toBeGreaterThan(321 * 1024 * 1024);
  });

  it("does not pay for the memory probe when WebAssembly is absent entirely", () => {
    const reserve = vi.fn(() => true);
    const v = probeEnvironment(without({ hasWebAssembly: () => false, canReserveWasmMemory: reserve }));
    expect(v.missing).toContain("webassembly");
    expect(v.missing).not.toContain("wasm-memory-headroom");
    expect(reserve).not.toHaveBeenCalled();
  });

  it.each<[keyof EnvironmentProbes, RequiredCapability]>([
    ["hasWorker", "worker"],
    ["hasOpfs", "opfs"],
    ["hasWebLocks", "web-locks"],
    ["hasCryptoRandom", "crypto-getrandomvalues"],
  ])("refuses when %s is missing, naming %s", (probe, cap) => {
    const v = probeEnvironment(without({ [probe]: () => false } as Partial<EnvironmentProbes>));
    expect(v.supported).toBe(false);
    expect(v.missing).toContain(cap);
  });

  it("reports every missing capability, not just the first", () => {
    const v = probeEnvironment(
      without({ hasOpfs: () => false, hasWebLocks: () => false, hasWorker: () => false }),
    );
    expect(v.missing).toEqual(expect.arrayContaining(["worker", "opfs", "web-locks"]));
  });

});

describe("environment gate — the Worker-hosted sync-access-handle probe", () => {
  // The bug this pins: `createSyncAccessHandle` is absent from the MAIN-THREAD
  // `FileSystemFileHandle.prototype` and present inside a Worker. Verified in a
  // real browser — the main-thread prototype carried only
  // ["createWritable", "getFile", "move", "constructor"]. A main-thread detect
  // therefore refuses every capable browser, and a hand-written fake would
  // agree with it forever.
  it("admits a capable browser only after the Worker probe says yes", async () => {
    await expect(gateEnvironment(ALL_CAPABLE, async () => true)).resolves.toEqual({
      supported: true,
      missing: [],
    });
  });

  it("refuses when the Worker probe says the handle is absent", async () => {
    const v = await gateEnvironment(ALL_CAPABLE, async () => false);
    expect(v.supported).toBe(false);
    expect(v.missing).toEqual(["opfs-sync-access-handle"]);
  });

  // OPFS without the synchronous access handle is not a degraded mode — it is
  // no mode, because Safari implements no `createWritable` either.
  it("does not spawn the Worker probe when a synchronous probe already refused", async () => {
    let called = false;
    const v = await gateEnvironment(without({ hasOpfs: () => false }), async () => {
      called = true;
      return true;
    });
    expect(v.supported).toBe(false);
    expect(called).toBe(false);
  });
});

describe("environment gate — the refusal it produces", () => {
  const ALL: RequiredCapability[] = [
    "webassembly",
    "wasm-memory-headroom",
    "worker",
    "opfs",
    "opfs-sync-access-handle",
    "web-locks",
    "crypto-getrandomvalues",
  ];

  it("explains every capability it can report", () => {
    for (const cap of ALL) {
      const msg = explainMissing(cap);
      expect(msg.length).toBeGreaterThan(20);
      // No API names the reader has no reason to know.
      expect(msg).not.toMatch(/createSyncAccessHandle|navigator\.locks|getRandomValues/);
    }
  });

  it("says why the memory limit cannot simply be lowered for this device", () => {
    // Without this the honest answer looks like an arbitrary refusal.
    expect(explainMissing("wasm-memory-headroom")).toMatch(/unreadable|cannot be lowered/i);
  });

  it("points at named native clients, not a vague suggestion", () => {
    expect(NATIVE_HANDOFF).toMatch(/desktop/i);
    expect(NATIVE_HANDOFF).toMatch(/iOS|Android/);
  });

  // Consistency with threat-model.md A15 / TB11: a web page cannot verify its
  // own delivery, and the handoff copy is where a user first meets that.
  it("names the verification difference rather than implying the web client is merely slower", () => {
    expect(NATIVE_HANDOFF).toMatch(/signature/i);
  });
});
