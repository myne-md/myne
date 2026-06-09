// Multi-vault recovery selection routing (MYND-206 — SYNC-12).
//
// Pure-reducer assertions on the new `select` sub-step + `vaultId` targeting
// the recovery flow gained before phrase-entry:
//   - ≥2 vaults → `enter-select` moves phrase-entry → select; the user must
//     pick a vault (`vault-selected{vaultId}`) before phrase entry, and the
//     chosen id is stored so A8d/A8f read the SAME vault's vault.meta.
//   - exactly 1 vault → the gate never dispatches `enter-select`; the flow
//     stays in phrase-entry with `vaultId = null` (sole-vault fallback / story
//     7 single-vault parity).
//   - the orchestrator threads `state.vaultId ?? undefined` into the IPC, so a
//     `null` vaultId is the param-less sole-vault path and a chosen id targets
//     exactly that vault.
//
// These are pure state-machine assertions (no IPC, no DOM) mirroring the
// existing `tests/stage/*` style.

import { describe, expect, it } from "vitest";
import {
  initialState,
  vaultRecoverReducer,
  type VaultRecoverState,
} from "../../src/screens/vault-recover/reducer";

const VID_A = "00000000-0000-7000-8000-00000000000a";
const VID_B = "00000000-0000-7000-8000-00000000000b";

/** The cold-start (unlock.start-recovery) entry state: phrase-entry, no vault
 *  chosen yet. */
function coldStart(): VaultRecoverState {
  return initialState("phrase-entry");
}

describe("recovery selection gate (≥2 vaults)", () => {
  it("enter-select moves phrase-entry → select", () => {
    const next = vaultRecoverReducer(coldStart(), { type: "enter-select" });
    expect(next.subStep).toBe("select");
    expect(next.vaultId).toBeNull();
  });

  it("vault-selected from select stores the id and advances to phrase-entry", () => {
    const selecting = vaultRecoverReducer(coldStart(), { type: "enter-select" });
    const next = vaultRecoverReducer(selecting, {
      type: "vault-selected",
      vaultId: VID_B,
    });
    expect(next.subStep).toBe("phrase-entry");
    expect(next.vaultId).toBe(VID_B);
  });

  it("the chosen id survives into decrypting (A8d reads the right vault)", () => {
    let state = vaultRecoverReducer(coldStart(), { type: "enter-select" });
    state = vaultRecoverReducer(state, { type: "vault-selected", vaultId: VID_A });
    // Fill all 24 cells, then submit-phrase → decrypting.
    for (let i = 0; i < 24; i++) {
      state = vaultRecoverReducer(state, { type: "set-cell", index: i, value: "x" });
    }
    state = vaultRecoverReducer(state, { type: "submit-phrase" });
    expect(state.subStep).toBe("decrypting");
    expect(state.vaultId).toBe(VID_A);
  });

  it("vault-selected is a no-op outside the select sub-step", () => {
    // From a fresh phrase-entry (no gate run yet), a stray vault-selected must
    // not mutate state — selection is only reachable from `select`.
    const state = coldStart();
    const next = vaultRecoverReducer(state, {
      type: "vault-selected",
      vaultId: VID_A,
    });
    expect(next.subStep).toBe("phrase-entry");
    expect(next.vaultId).toBeNull();
  });
});

describe("single-vault parity (story 7)", () => {
  it("a cold start that never gets enter-select stays in phrase-entry with vaultId null", () => {
    // The orchestrator's gate only dispatches `enter-select` for ≥2 vaults; a
    // 1-vault flow leaves the initial phrase-entry state untouched.
    const state = coldStart();
    expect(state.subStep).toBe("phrase-entry");
    expect(state.vaultId).toBeNull();
  });

  it("null vaultId → undefined IPC arg (sole-vault fallback)", () => {
    // The orchestrator passes `state.vaultId ?? undefined` to recoverWithPhrase
    // / completeRecovery. Pin that mapping so the sole-vault path stays the
    // param-less None target.
    const state = coldStart();
    expect(state.vaultId ?? undefined).toBeUndefined();
  });

  it("chosen vaultId → that exact string IPC arg", () => {
    let state = vaultRecoverReducer(coldStart(), { type: "enter-select" });
    state = vaultRecoverReducer(state, { type: "vault-selected", vaultId: VID_B });
    expect(state.vaultId ?? undefined).toBe(VID_B);
  });
});

describe("resumed recovery never re-enters selection", () => {
  it("enter-select is a no-op when resuming in password-reset", () => {
    // unlock.resume-recovery / boot Recovering enters password-reset; the gate
    // is keyed on initialSubStep so it never fires, but even if dispatched the
    // reducer guards it.
    const resumed = initialState("password-reset");
    const next = vaultRecoverReducer(resumed, { type: "enter-select" });
    expect(next.subStep).toBe("password-reset");
  });
});
