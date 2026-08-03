// myne#277 — the unlock sweep is a bulk mutation of the index slice, so it owes
// the SYNC-5 chokepoint bump like every other mutation path.
//
// It was the one path that never announced itself. The per-note bumps inside it
// fire only for ids the persisted `MYI1` blob reports STALE, and after a graceful
// lock the blob was persisted moments earlier — so nothing is stale, nothing
// bumps, and the nonce does not advance across the whole lock→unlock cycle even
// though the Rust index was wiped and refilled underneath it.
//
// Two symptoms fell out of that, and this file pins both ends: a reader keyed on
// the nonce answered from a cache describing the previous session (STALE), and a
// reader that raced the fire-and-forget hydrate cached `[]` from the cleared
// index and never refetched (EMPTY).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const { hydrateVaultIndicesOnUnlock } = await import("../../src/notes/vaultIndices");
const { getIndexNonce, __resetIndexNonceForTest } = await import(
  "../../src/notes/indexNonce"
);

beforeEach(() => {
  invokeMock.mockReset();
  __resetIndexNonceForTest();
});
afterEach(() => invokeMock.mockReset());

/** Hydrate reporting `stale` ids; everything else answers benignly. */
function hostReports(stale: readonly string[]): void {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "plugin:vault-indices|vault_indices_hydrate") return stale;
    return undefined;
  });
}

describe("hydrateVaultIndicesOnUnlock bumps the index nonce", () => {
  it("bumps even when the blob reports NOTHING stale — the graceful-lock case", async () => {
    hostReports([]);
    const before = getIndexNonce();
    await hydrateVaultIndicesOnUnlock([]);
    expect(getIndexNonce()).toBeGreaterThan(before);
  });

  it("bumps after a hydrate that reports stale ids too", async () => {
    hostReports([]);
    const before = getIndexNonce();
    await hydrateVaultIndicesOnUnlock(["n1"]);
    expect(getIndexNonce()).toBeGreaterThan(before);
  });

  it("bumps on the full-rebuild fallback, when hydrate itself fails", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:vault-indices|vault_indices_hydrate") throw new Error("no blob");
      return undefined;
    });
    const before = getIndexNonce();
    await hydrateVaultIndicesOnUnlock([]);
    expect(getIndexNonce()).toBeGreaterThan(before);
  });

  it("notifies subscribers, so a reader that cached an empty list re-queries", async () => {
    hostReports([]);
    const { subscribeIndexNonce } = await import("../../src/notes/indexNonce");
    let notified = 0;
    const unsubscribe = subscribeIndexNonce(() => {
      notified += 1;
    });
    try {
      await hydrateVaultIndicesOnUnlock([]);
      // The nonce advances synchronously; the notify is throttled onto a
      // microtask, so drain it.
      await Promise.resolve();
      await Promise.resolve();
      expect(notified).toBeGreaterThan(0);
    } finally {
      unsubscribe();
    }
  });
});
