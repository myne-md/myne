// Multi-vault in-app switch route (MYND-205, multi-vault sub-feature 4, task 4).
//
// `switchVault` fires the param-less `vault_lock()` (four-surface teardown +
// `flushIfDirty`, SYNC-8) then dispatches `editor.switch-vault` so App.tsx
// routes from `editor` to the TARGET vault's unlock screen, carrying the
// target's `vaultId` onto the resulting `unlock` Stage so `<Unlock>` can thread
// it into the vault-addressed `unlock` IPC (SYNC-6). After the target's unlock
// it becomes the sole `Unlocked` slot (SYNC-1 — lock-then-unlock, no
// pointer-flip).
//
// These are pure-`transition` assertions on the new Action variant + its
// payload threading — the same `Stage["name"]`-level legality the in-tree
// `verifyTransitionTable` harness covers, plus the target-`vaultId` threading
// this task adds. They also pin the contrast with `editor.lock` (which routes
// to the sole-vault unlock with NO `vaultId`).

import { describe, expect, it, vi } from "vitest";
import { transition, type Action, type VaultId } from "../../src/lib/stage";

const VID_A = "00000000-0000-7000-8000-00000000000a";
const VID_B = "00000000-0000-7000-8000-00000000000b";

describe("editor.switch-vault carries the target vaultId onto the unlock Stage", () => {
  it("editor → unlock(Exists) threading the target vaultId", () => {
    const next = transition(
      { name: "editor" },
      { type: "editor.switch-vault", vaultId: VID_A },
    );
    expect(next.name).toBe("unlock");
    if (next.name !== "unlock") throw new Error("unreachable");
    expect(next.initialStatus).toEqual({ kind: "Exists" });
    expect(next.vaultId).toBe(VID_A);
  });

  it("threads whichever target id the switcher supplied", () => {
    const next = transition(
      { name: "editor" },
      { type: "editor.switch-vault", vaultId: VID_B },
    );
    if (next.name !== "unlock") throw new Error("unreachable");
    expect(next.vaultId).toBe(VID_B);
  });
});

describe("editor.lock vs editor.switch-vault — same target stage, different targeting", () => {
  it("editor.lock → unlock has NO vaultId (sole-vault None path)", () => {
    const next = transition({ name: "editor" }, { type: "editor.lock" });
    if (next.name !== "unlock") throw new Error("unreachable");
    expect(next.vaultId).toBeUndefined();
  });

  it("editor.switch-vault → unlock carries the vaultId (vault-addressed path)", () => {
    const next = transition(
      { name: "editor" },
      { type: "editor.switch-vault", vaultId: VID_A },
    );
    if (next.name !== "unlock") throw new Error("unreachable");
    expect(next.vaultId).toBe(VID_A);
  });
});

describe("editor.switch-vault is illegal from non-editor stages (returns prev unchanged)", () => {
  it("rejected from unlock — stays on unlock", () => {
    const prev: Action = { type: "editor.switch-vault", vaultId: VID_A };
    // Suppress the dev-only rejectIllegal console.warn for this deliberate
    // illegal-pair probe.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const next = transition(
      { name: "unlock", initialStatus: { kind: "Exists" } },
      prev,
    );
    expect(next.name).toBe("unlock");
    warn.mockRestore();
  });

  it("rejected from welcome — stays on welcome", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const next = transition(
      { name: "welcome" },
      { type: "editor.switch-vault", vaultId: VID_A },
    );
    expect(next.name).toBe("welcome");
    warn.mockRestore();
  });
});

describe("switchVault orchestration: lock-then-route (vault_lock then dispatch)", () => {
  it("fires the lock IPC, toggles saving true→false, then dispatches editor.switch-vault", async () => {
    // Stub the lock IPC wrapper so the orchestration runs without a backend.
    const order: string[] = [];
    vi.resetModules();
    vi.doMock("../../src/lib/vault-unlock", () => ({
      lockVault: vi.fn(async () => {
        order.push("lock");
      }),
    }));
    const { switchVault } = await import("../../src/lib/vault-switch");

    const savingStates: boolean[] = [];
    const dispatched: Action[] = [];
    const target: VaultId = VID_B;

    await switchVault(target, {
      onSavingChange: (s) => {
        savingStates.push(s);
        order.push(`saving:${s}`);
      },
      dispatch: (a) => {
        dispatched.push(a);
        order.push("dispatch");
      },
    });

    // saving toggled true (before lock) then false (after lock, before route).
    expect(savingStates).toEqual([true, false]);
    // Lock ran, THEN the route dispatched (lock-then-unlock, never reversed).
    expect(order).toEqual(["saving:true", "lock", "saving:false", "dispatch"]);
    // The dispatched action carries the target vaultId.
    expect(dispatched).toEqual([{ type: "editor.switch-vault", vaultId: target }]);

    vi.doUnmock("../../src/lib/vault-unlock");
    vi.resetModules();
  });

  it("routes to the target even if the lock IPC rejects (best-effort lock)", async () => {
    vi.resetModules();
    vi.doMock("../../src/lib/vault-unlock", () => ({
      lockVault: vi.fn(async () => {
        throw new Error("lock failed");
      }),
    }));
    const { switchVault } = await import("../../src/lib/vault-switch");

    const dispatched: Action[] = [];
    const savingStates: boolean[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await switchVault(VID_A, {
      onSavingChange: (s) => savingStates.push(s),
      dispatch: (a) => dispatched.push(a),
    });

    // saving still reset to false (finally), and the route still dispatched.
    expect(savingStates).toEqual([true, false]);
    expect(dispatched).toEqual([{ type: "editor.switch-vault", vaultId: VID_A }]);

    warn.mockRestore();
    vi.doUnmock("../../src/lib/vault-unlock");
    vi.resetModules();
  });
});
