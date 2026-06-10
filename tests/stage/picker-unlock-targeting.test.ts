// Per-vault `unlock` targeting (MYND-204, multi-vault sub-feature 3, task 8).
//
// The picker carries the chosen `vaultId` from `picker.select-vault` onto the
// resulting `unlock` Stage so `<Unlock>` can thread it into the vault-addressed
// `unlock` IPC (SYNC-6 targeting). Every OTHER path to `unlock` (boot
// single-vault, editor lock, recovery cancel, create-vault commit fallback,
// change-password force-relock) leaves `vaultId` undefined → the param-less /
// None sole-vault unlock path, unchanged.
//
// These are pure-`transition` assertions on the new payload field — the same
// `Stage["name"]`-level legality the in-tree `verifyTransitionTable` harness
// already covers, plus the payload-threading this task adds.

import { describe, expect, it } from "vitest";
import {
  initialStageFromProbe,
  transition,
  type SlotMap,
  type Stage,
} from "../../src/lib/stage";
import type { VaultListResult, VaultSummary } from "../../src/types/vault-summary";

const VID_A = "00000000-0000-7000-8000-00000000000a";
const VID_B = "00000000-0000-7000-8000-00000000000b";

function existsVault(id: string): VaultSummary {
  return { id, status: { kind: "Exists" }, label: null, last_unlock: null };
}

describe("picker.select-vault carries the chosen vaultId onto the unlock Stage", () => {
  it("threads the action's vaultId onto unlock", () => {
    const next = transition(
      { name: "picker" },
      { type: "picker.select-vault", vaultId: VID_A },
    );
    expect(next.name).toBe("unlock");
    if (next.name !== "unlock") throw new Error("unreachable");
    expect(next.initialStatus).toEqual({ kind: "Exists" });
    expect(next.vaultId).toBe(VID_A);
  });

  it("threads whichever vaultId the row supplied (different ids → different targets)", () => {
    const next = transition(
      { name: "picker" },
      { type: "picker.select-vault", vaultId: VID_B },
    );
    if (next.name !== "unlock") throw new Error("unreachable");
    expect(next.vaultId).toBe(VID_B);
  });
});

describe("vault-addressed exits (MYND-219 / SYNC-17: lock/cancel/relock thread the active id)", () => {
  it("editor.lock → unlock carries the editor stage's vaultId", () => {
    const next = transition({ name: "editor", vaultId: VID_A }, { type: "editor.lock" });
    if (next.name !== "unlock") throw new Error("unreachable");
    expect(next.vaultId).toBe(VID_A);
  });

  it("editor.lock from an id-less editor (boot slot-priority entry) leaves vaultId undefined", () => {
    const next = transition({ name: "editor" }, { type: "editor.lock" });
    if (next.name !== "unlock") throw new Error("unreachable");
    expect(next.vaultId).toBeUndefined();
  });

  it("unlock.success threads the unlock's targeting id onto the editor stage", () => {
    const next = transition(
      { name: "unlock", initialStatus: { kind: "Exists" }, vaultId: VID_B },
      { type: "unlock.success" },
    );
    if (next.name !== "editor") throw new Error("unreachable");
    expect(next.vaultId).toBe(VID_B);
  });

  it("recover.cancel → unlock carries the action's vaultId (the recovery's selected target)", () => {
    const next = transition(
      { name: "recover", subStep: "phrase-entry" },
      { type: "recover.cancel", vaultId: VID_A },
    );
    if (next.name !== "unlock") throw new Error("unreachable");
    expect(next.vaultId).toBe(VID_A);
  });

  it("recover.complete-success → editor carries the recovered vault's id", () => {
    const next = transition(
      { name: "recover", subStep: "password-reset" },
      { type: "recover.complete-success", vaultId: VID_B },
    );
    if (next.name !== "editor") throw new Error("unreachable");
    expect(next.vaultId).toBe(VID_B);
  });

  it("create-vault.auto-unlock-success → editor carries the created vault's id", () => {
    const next = transition(
      { name: "create-vault" },
      { type: "create-vault.auto-unlock-success", vaultId: VID_A },
    );
    if (next.name !== "editor") throw new Error("unreachable");
    expect(next.vaultId).toBe(VID_A);
  });

  it("create-vault.commit-success without an id (legacy sole-vault path) leaves vaultId undefined", () => {
    const next = transition(
      { name: "create-vault" },
      { type: "create-vault.commit-success" },
    );
    if (next.name !== "unlock") throw new Error("unreachable");
    expect(next.vaultId).toBeUndefined();
  });
});

describe("boot single-vault routing targets that vault explicitly", () => {
  const allEmpty: SlotMap = {};
  const okList = (...vaults: VaultSummary[]): VaultListResult => ({ ok: vaults });

  it("exactly one vault → unlock carries that vault's id", () => {
    const stage: Stage = initialStageFromProbe(okList(existsVault(VID_A)), allEmpty);
    expect(stage.name).toBe("unlock");
    if (stage.name !== "unlock") throw new Error("unreachable");
    expect(stage.initialStatus).toEqual({ kind: "Exists" });
    expect(stage.vaultId).toBe(VID_A);
  });

  it("zero vaults → welcome (no unlock, no vaultId)", () => {
    const stage = initialStageFromProbe(okList(), allEmpty);
    expect(stage.name).toBe("welcome");
  });
});
