// Storage-quota precheck (phase3-web-client task 24).

import { describe, expect, it } from "vitest";
import {
  describeShortfall,
  formatBytes,
  precheckQuota,
  type StorageEstimator,
} from "../../web/src/quota-precheck";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function estimator(quota?: number, usage?: number): StorageEstimator {
  return { estimate: async () => ({ quota, usage }) };
}

describe("quota precheck", () => {
  it("passes a vault that fits inside the headroom", async () => {
    // Chrome's measured 10 GB, nothing used, a 1 GB vault.
    const v = await precheckQuota(1 * GB, estimator(10 * GB, 0));
    expect(v.ok).toBe(true);
  });

  it("subtracts existing usage, not just the raw quota", async () => {
    // 10 GB quota, 9.8 GB already used → a 1 GB vault must not pass.
    const v = await precheckQuota(1 * GB, estimator(10 * GB, 9.8 * GB));
    expect(v.ok).toBe(false);
    if (v.ok || v.reason !== "insufficient") throw new Error("expected insufficient");
    expect(v.shortfallBytes).toBeGreaterThan(0);
  });

  it("keeps headroom rather than filling the quota to the last byte", async () => {
    // Exactly the remainder must NOT pass: post-materialisation writes (index
    // rebuild, prefs, sync baseline) still need room, and a browser at 100%
    // quota is a browser about to evict.
    const v = await precheckQuota(1 * GB, estimator(1 * GB, 0));
    expect(v.ok).toBe(false);
  });

  it("names the shortfall, because 'not enough space' is not an action", async () => {
    const v = await precheckQuota(5 * GB, estimator(2 * GB, 0));
    if (v.ok || v.reason !== "insufficient") throw new Error("expected insufficient");
    expect(v.requiredBytes).toBe(5 * GB);
    expect(v.shortfallBytes).toBe(5 * GB - v.availableBytes);

    const sentence = describeShortfall(v);
    expect(sentence).toContain("5.0 GB");
    expect(sentence).toContain("short");
  });

  it("returns 'unknown' — never a silent pass — when the browser reports no quota", async () => {
    // Folding this into `ok` would reintroduce exactly the partial-vault
    // failure the precheck exists to prevent.
    expect(await precheckQuota(1 * GB, estimator(undefined, 0))).toEqual({ ok: false, reason: "unknown" });
    expect(await precheckQuota(1 * GB, estimator(0, 0))).toEqual({ ok: false, reason: "unknown" });
    expect(await precheckQuota(1 * GB, null)).toEqual({ ok: false, reason: "unknown" });
  });

  it("returns 'unknown' when estimate() throws, rather than propagating", async () => {
    const throwing: StorageEstimator = {
      estimate: async () => {
        throw new Error("nope");
      },
    };
    expect(await precheckQuota(1 * GB, throwing)).toEqual({ ok: false, reason: "unknown" });
  });

  it("treats a missing usage figure as zero used", async () => {
    const v = await precheckQuota(1 * GB, { estimate: async () => ({ quota: 10 * GB }) });
    expect(v.ok).toBe(true);
  });
});

describe("formatBytes", () => {
  it("is coarse and readable", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(5 * MB)).toBe("5.0 MB");
    expect(formatBytes(10 * GB)).toBe("10 GB");
  });

  it("never renders a negative size", () => {
    expect(formatBytes(-1)).toBe("0 B");
  });
});
