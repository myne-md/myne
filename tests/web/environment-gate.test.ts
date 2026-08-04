// Unsupported-environment gate (phase3-web-client task 29).

import { describe, expect, it, vi } from "vitest";
import {
  explainMissing,
  gateEnvironment,
  isMobileFormFactor,
  MOBILE_REFUSAL_TITLE,
  NATIVE_HANDOFF,
  probeEnvironment,
  type EnvironmentProbes,
  type FormFactorSignals,
  type RequiredCapability,
} from "../../web/src/environment-gate";

const ALL_CAPABLE: EnvironmentProbes = {
  isMobileFormFactor: () => false,
  hasWebAssembly: () => true,
  canReserveWasmMemory: () => true,
  hasWorker: () => true,
  hasOpfs: () => true,
  hasWebLocks: () => true,
  hasCryptoRandom: () => true,
  hasCrossOriginIsolation: () => true,
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
    ["hasCrossOriginIsolation", "cross-origin-isolation"],
  ])("refuses when %s is missing, naming %s", (probe, cap) => {
    const v = probeEnvironment(without({ [probe]: () => false } as Partial<EnvironmentProbes>));
    expect(v.supported).toBe(false);
    expect(v.missing).toContain(cap);
  });

  // ── myne#320: the deployment probe ────────────────────────────────────
  //
  // Every probe above is about the BROWSER. This one is about the server, and
  // its absence is why a bundle served without COOP/COEP — a generic
  // nginx/Caddy/S3 host, or an intermediary that strips them — passed the gate,
  // unlocked normally, and then died at the first HTTP 429 from the sync
  // server: the rate-limit backoff sleeps on `Atomics.wait` over a
  // `SharedArrayBuffer`, which needs isolation, and the Rust side treats its
  // absence as fatal on purpose (a backoff that does not wait is a hot retry
  // loop against a server already rate-limiting). The wasm instance aborts and
  // the page rejects every later call for the rest of its life.
  it("refuses a page that is not cross-origin isolated, whatever the browser can do", () => {
    const v = probeEnvironment(without({ hasCrossOriginIsolation: () => false }));
    expect(v.supported).toBe(false);
    expect(v.missing).toEqual(["cross-origin-isolation"]);
  });

  it("explains the isolation refusal in terms the operator can act on", () => {
    // Naming the two headers, because the person who can fix this is serving
    // the page — "contact the administrator" would be useless here.
    const text = explainMissing("cross-origin-isolation");
    expect(text).toContain("Cross-Origin-Opener-Policy: same-origin");
    expect(text).toContain("Cross-Origin-Embedder-Policy: require-corp");
  });

  it("reports every missing capability, not just the first", () => {
    const v = probeEnvironment(
      without({ hasOpfs: () => false, hasWebLocks: () => false, hasWorker: () => false }),
    );
    expect(v.missing).toEqual(expect.arrayContaining(["worker", "opfs", "web-locks"]));
  });

});

// ── device class ─────────────────────────────────────────────────────────────
//
// The case capability probing alone cannot reach: a 64-bit Android Chrome
// answers every probe above with a yes, because a `WebAssembly.Memory`
// reservation is virtual. Each row below is a real device, named so a future
// edit that breaks one can see which.

describe("device-class detection", () => {
  const DESKTOP: FormFactorSignals = {
    uaDataMobile: false,
    coarsePrimaryPointer: false,
    maxTouchPoints: 0,
    platform: "Win32",
  };
  const signals = (o: Partial<FormFactorSignals>): FormFactorSignals => ({ ...DESKTOP, ...o });

  it.each<[string, FormFactorSignals]>([
    ["a desktop browser on Windows or Linux", DESKTOP],
    [
      "a Mac — a Magic Trackpad is not a touchscreen, so maxTouchPoints stays 0",
      signals({ uaDataMobile: undefined, platform: "MacIntel" }),
    ],
    // The signal that would be wrong if this used `any-pointer: coarse`: a
    // 2-in-1 laptop has a touchscreen AND a mouse, and its PRIMARY pointer is
    // the mouse.
    ["a touch-screen Windows laptop", signals({ maxTouchPoints: 10 })],
  ])("admits %s", (_name, s) => {
    expect(isMobileFormFactor(s)).toBe(false);
  });

  it.each<[string, FormFactorSignals]>([
    [
      "Android Chrome",
      signals({ uaDataMobile: true, coarsePrimaryPointer: true, maxTouchPoints: 5, platform: "Linux armv8l" }),
    ],
    // "Request desktop site" flips Sec-CH-UA-Mobile to ?0. The media features
    // do not lie, which is why the boolean cannot be the only signal.
    [
      "Android Chrome with the desktop site requested",
      signals({ coarsePrimaryPointer: true, maxTouchPoints: 5, platform: "Linux armv8l" }),
    ],
    [
      "iPhone Safari",
      signals({ uaDataMobile: undefined, coarsePrimaryPointer: true, maxTouchPoints: 5, platform: "iPhone" }),
    ],
    [
      "iPadOS Safari, which presents itself as a Mac",
      signals({ uaDataMobile: undefined, coarsePrimaryPointer: true, maxTouchPoints: 5, platform: "MacIntel" }),
    ],
    // The one the media features miss: with a trackpad attached, an iPad
    // reports a fine pointer that hovers. Only the touch count gives it away.
    [
      "an iPad with a trackpad attached",
      signals({ uaDataMobile: undefined, maxTouchPoints: 5, platform: "MacIntel" }),
    ],
  ])("refuses %s", (_name, s) => {
    expect(isMobileFormFactor(s)).toBe(true);
  });

  // The regression this design exists to avoid. A desktop window snapped to a
  // quarter of the screen is ~400 px wide and is a SUPPORTED viewport
  // (`e2e-web/isolation-and-viewport.e2e.ts`); a width signal would refuse it,
  // silently, on something the user changes by dragging a window edge. The
  // check is structural because that is the only form that survives someone
  // deciding a width rule would be simpler.
  it("consults no viewport dimension at all", () => {
    for (const key of Object.keys(DESKTOP)) {
      expect(key).not.toMatch(/width|height|size|screen|viewport|innerWidth/i);
    }
  });
});

describe("device-class refusal — how it reaches the screen", () => {
  const MOBILE = without({ isMobileFormFactor: () => true });

  it("refuses a phone or tablet before anything else is asked", () => {
    expect(probeEnvironment(MOBILE)).toEqual({
      supported: false,
      missing: ["desktop-form-factor"],
    });
  });

  // A phone reader has a native app to open. A list that also mentions Web
  // Locks gives them a second sentence they can do nothing about.
  it("reports the device class ALONE, even when other probes would also fail", () => {
    const v = probeEnvironment(
      without({ isMobileFormFactor: () => true, hasOpfs: () => false, hasWebLocks: () => false }),
    );
    expect(v.missing).toEqual(["desktop-form-factor"]);
  });

  it("does not pay for the 336 MiB reservation on a device it has already refused", () => {
    const reserve = vi.fn(() => true);
    probeEnvironment(without({ isMobileFormFactor: () => true, canReserveWasmMemory: reserve }));
    expect(reserve).not.toHaveBeenCalled();
  });

  it("does not spawn the Worker probe for a refused device", async () => {
    let called = false;
    const v = await gateEnvironment(MOBILE, async () => {
      called = true;
      return true;
    });
    expect(v.supported).toBe(false);
    expect(called).toBe(false);
  });

  // The heading is the whole reason the mobile case is not just another row in
  // the reason list: "can't run in this browser" sends a phone user looking for
  // a different browser.
  it("has a heading that points at the app rather than blaming the browser", () => {
    expect(MOBILE_REFUSAL_TITLE).not.toMatch(/browser/i);
    expect(MOBILE_REFUSAL_TITLE).toMatch(/app/i);
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
    "desktop-form-factor",
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
