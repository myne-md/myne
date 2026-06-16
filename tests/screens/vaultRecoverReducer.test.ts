// Vault-recover sub-step reducer (MYND-206 / MYND-108-bis). Pure state machine.
// Covers every action → transition, the fail-closed terminal latch, the cell /
// password wipe rules (spec §3.4), the Q4 silent-recovery swaps, and the
// sub-step guards that make stale dispatches no-ops.

import { describe, expect, it } from "vitest";

import {
  EMPTY_CELLS,
  PHRASE_CELL_COUNT,
  initialState,
  vaultRecoverReducer,
  type VaultRecoverState,
} from "../../src/screens/vault-recover/reducer";
import { RECOVERY_NON_DISTINGUISHING_BANNER } from "../../src/lib/load-bearing-copy";

const filled = (): string[] =>
  Array.from({ length: PHRASE_CELL_COUNT }, (_, i) => `w${i}`);

function phraseEntry(over: Partial<VaultRecoverState> = {}): VaultRecoverState {
  return { ...initialState("phrase-entry"), ...over };
}

function decrypting(over: Partial<VaultRecoverState> = {}): VaultRecoverState {
  return { ...initialState("phrase-entry"), subStep: "decrypting", ...over };
}

function passwordReset(over: Partial<VaultRecoverState> = {}): VaultRecoverState {
  return {
    ...initialState("phrase-entry"),
    subStep: "password-reset",
    ...over,
  };
}

describe("initialState", () => {
  it("builds a fresh state with empty cells and the given sub-step", () => {
    const s = initialState("phrase-entry");
    expect(s.subStep).toBe("phrase-entry");
    expect(s.vaultId).toBeNull();
    expect(s.cells).toBe(EMPTY_CELLS);
    expect(s.cells).toHaveLength(PHRASE_CELL_COUNT);
    expect(s.password).toBe("");
    expect(s.banner).toBeNull();
    expect(s.failClosed).toBeNull();
    expect(s.deleteInFlight).toBe(false);
    expect(s.deletePartialFail).toBeNull();
  });
});

describe("fail-closed is terminal", () => {
  it("ignores every action once failClosed is set", () => {
    const dead: VaultRecoverState = phraseEntry({ failClosed: "corrupted-vault" });
    expect(vaultRecoverReducer(dead, { type: "set-cell", index: 0, value: "x" })).toBe(
      dead,
    );
    expect(vaultRecoverReducer(dead, { type: "enter-select" })).toBe(dead);
    expect(vaultRecoverReducer(dead, { type: "submit-phrase" })).toBe(dead);
  });
});

describe("enter-select / vault-selected (MYND-206)", () => {
  it("moves phrase-entry → select and resets cells + banner", () => {
    const s = vaultRecoverReducer(
      phraseEntry({ cells: filled(), banner: "stale" }),
      { type: "enter-select" },
    );
    expect(s.subStep).toBe("select");
    expect(s.cells).toBe(EMPTY_CELLS);
    expect(s.banner).toBeNull();
  });

  it("enter-select is a no-op outside phrase-entry", () => {
    const s = passwordReset();
    expect(vaultRecoverReducer(s, { type: "enter-select" })).toBe(s);
  });

  it("vault-selected stores the id and advances select → phrase-entry", () => {
    const sel: VaultRecoverState = { ...initialState("phrase-entry"), subStep: "select" };
    const s = vaultRecoverReducer(sel, { type: "vault-selected", vaultId: "v-7" });
    expect(s.subStep).toBe("phrase-entry");
    expect(s.vaultId).toBe("v-7");
  });

  it("vault-selected is a no-op outside select", () => {
    const s = phraseEntry();
    expect(vaultRecoverReducer(s, { type: "vault-selected", vaultId: "v-7" })).toBe(s);
  });
});

describe("set-cell", () => {
  it("writes a sanitized value into the target cell and clears the banner", () => {
    const s = vaultRecoverReducer(phraseEntry({ banner: "x" }), {
      type: "set-cell",
      index: 2,
      value: "  ho rse  ",
    });
    expect(s.cells[2]).toBe("horse"); // whitespace filtered (Q5 P5)
    expect(s.banner).toBeNull();
    expect(s.cells).not.toBe(EMPTY_CELLS); // fresh array
  });

  it("rejects out-of-range indices and a non-phrase-entry sub-step", () => {
    const s = phraseEntry();
    expect(vaultRecoverReducer(s, { type: "set-cell", index: -1, value: "a" })).toBe(s);
    expect(
      vaultRecoverReducer(s, { type: "set-cell", index: PHRASE_CELL_COUNT, value: "a" }),
    ).toBe(s);
    expect(
      vaultRecoverReducer(decrypting(), { type: "set-cell", index: 0, value: "a" }),
    ).toEqual(decrypting());
  });
});

describe("paste-into-cell", () => {
  it("fills forward from index, sanitizes tokens, preserves earlier cells", () => {
    const prior = phraseEntry({ cells: ["keep", ...EMPTY_CELLS.slice(1)] });
    const s = vaultRecoverReducer(prior, {
      type: "paste-into-cell",
      index: 1,
      tokens: ["al pha", "beta"],
    });
    expect(s.cells[0]).toBe("keep");
    expect(s.cells[1]).toBe("alpha");
    expect(s.cells[2]).toBe("beta");
    expect(s.banner).toBeNull();
  });

  it("truncates tokens past the 24-cell cap (Q5 P2)", () => {
    const s = vaultRecoverReducer(phraseEntry(), {
      type: "paste-into-cell",
      index: 22,
      tokens: ["a", "b", "c", "d"], // cap = 24 - 22 = 2
    });
    expect(s.cells[22]).toBe("a");
    expect(s.cells[23]).toBe("b");
    expect(s.cells).toHaveLength(PHRASE_CELL_COUNT); // never grows
  });

  it("is a no-op for an out-of-range index", () => {
    const s = phraseEntry();
    expect(
      vaultRecoverReducer(s, { type: "paste-into-cell", index: 99, tokens: ["a"] }),
    ).toBe(s);
  });
});

describe("submit-phrase", () => {
  it("advances to decrypting only when all 24 cells are filled", () => {
    const s = vaultRecoverReducer(phraseEntry({ cells: filled() }), {
      type: "submit-phrase",
    });
    expect(s.subStep).toBe("decrypting");
    expect(s.banner).toBeNull();
  });

  it("stays put when any cell is empty", () => {
    const partial = phraseEntry({ cells: ["only", ...EMPTY_CELLS.slice(1)] });
    expect(vaultRecoverReducer(partial, { type: "submit-phrase" })).toBe(partial);
  });

  it("is a no-op outside phrase-entry", () => {
    const s = decrypting();
    expect(vaultRecoverReducer(s, { type: "submit-phrase" })).toBe(s);
  });
});

describe("phrase-result (A8d outcomes)", () => {
  it("success → password-reset, cells wiped", () => {
    const s = vaultRecoverReducer(decrypting({ cells: filled() }), {
      type: "phrase-result",
      outcome: { kind: "success" },
    });
    expect(s.subStep).toBe("password-reset");
    expect(s.cells).toBe(EMPTY_CELLS);
    expect(s.banner).toBeNull();
  });

  it("non-distinguishing → phrase-entry, cells wiped, fixed §3.4 banner", () => {
    const s = vaultRecoverReducer(decrypting({ cells: filled() }), {
      type: "phrase-result",
      outcome: { kind: "non-distinguishing" },
    });
    expect(s.subStep).toBe("phrase-entry");
    expect(s.cells).toBe(EMPTY_CELLS);
    expect(s.banner).toBe(RECOVERY_NON_DISTINGUISHING_BANNER);
  });

  it("banner-retry → phrase-entry, cells PRESERVED, custom banner", () => {
    const cells = filled();
    const s = vaultRecoverReducer(decrypting({ cells }), {
      type: "phrase-result",
      outcome: { kind: "banner-retry", banner: "Disk busy" },
    });
    expect(s.subStep).toBe("phrase-entry");
    expect(s.cells).toBe(cells); // not wiped — user retries without retyping
    expect(s.banner).toBe("Disk busy");
  });

  it("already-recovering (Q4 silent) → password-reset, cells wiped", () => {
    const s = vaultRecoverReducer(decrypting({ cells: filled() }), {
      type: "phrase-result",
      outcome: { kind: "already-recovering" },
    });
    expect(s.subStep).toBe("password-reset");
    expect(s.cells).toBe(EMPTY_CELLS);
  });

  it("fail-closed latches the reason", () => {
    const s = vaultRecoverReducer(decrypting(), {
      type: "phrase-result",
      outcome: { kind: "fail-closed", reason: "invalid-state" },
    });
    expect(s.failClosed).toBe("invalid-state");
  });

  it("is a no-op when not in decrypting (stale dispatch guard)", () => {
    const s = phraseEntry();
    expect(
      vaultRecoverReducer(s, {
        type: "phrase-result",
        outcome: { kind: "success" },
      }),
    ).toBe(s);
  });
});

describe("set-password", () => {
  it("mirrors the password and clears the banner in password-reset", () => {
    const s = vaultRecoverReducer(passwordReset({ banner: "x" }), {
      type: "set-password",
      value: "hunter2hunter2",
    });
    expect(s.password).toBe("hunter2hunter2");
    expect(s.banner).toBeNull();
  });

  it("is a no-op outside password-reset", () => {
    const s = phraseEntry();
    expect(vaultRecoverReducer(s, { type: "set-password", value: "x" })).toBe(s);
  });
});

describe("password-result (A8f outcomes)", () => {
  it("needs-active-session (Q4) → phrase-entry, password wiped", () => {
    const s = vaultRecoverReducer(passwordReset({ password: "secret" }), {
      type: "password-result",
      outcome: { kind: "needs-active-session" },
    });
    expect(s.subStep).toBe("phrase-entry");
    expect(s.password).toBe("");
    expect(s.banner).toBeNull();
  });

  it("banner-retry stays in password-reset (semaphore busy)", () => {
    const s = vaultRecoverReducer(passwordReset({ password: "secret" }), {
      type: "password-result",
      outcome: { kind: "banner-retry", banner: "Try again shortly" },
    });
    expect(s.subStep).toBe("password-reset");
    expect(s.password).toBe("secret"); // user retries the same submit
    expect(s.banner).toBe("Try again shortly");
  });

  it("io-failure → phrase-entry, password wiped, banner shown", () => {
    const s = vaultRecoverReducer(passwordReset({ password: "secret" }), {
      type: "password-result",
      outcome: { kind: "io-failure", banner: "Couldn't write" },
    });
    expect(s.subStep).toBe("phrase-entry");
    expect(s.password).toBe("");
    expect(s.banner).toBe("Couldn't write");
  });

  it("fail-closed latches the reason", () => {
    const s = vaultRecoverReducer(passwordReset(), {
      type: "password-result",
      outcome: { kind: "fail-closed", reason: "corrupted-vault" },
    });
    expect(s.failClosed).toBe("corrupted-vault");
  });

  it("is a no-op outside password-reset", () => {
    const s = phraseEntry();
    expect(
      vaultRecoverReducer(s, {
        type: "password-result",
        outcome: { kind: "needs-active-session" },
      }),
    ).toBe(s);
  });
});

describe("delete-confirm sub-flow (MYND-108-bis)", () => {
  it("request-delete moves phrase-entry → delete-confirm and resets delete state", () => {
    const s = vaultRecoverReducer(
      phraseEntry({ banner: "x", deleteInFlight: true }),
      { type: "request-delete" },
    );
    expect(s.subStep).toBe("delete-confirm");
    expect(s.banner).toBeNull();
    expect(s.deleteInFlight).toBe(false);
    expect(s.deletePartialFail).toBeNull();
  });

  it("request-delete is a no-op outside phrase-entry (PasswordResetStep non-dismissible)", () => {
    const s = passwordReset();
    expect(vaultRecoverReducer(s, { type: "request-delete" })).toBe(s);
  });

  it("cancel-delete returns to phrase-entry when not in-flight", () => {
    const dc: VaultRecoverState = {
      ...initialState("phrase-entry"),
      subStep: "delete-confirm",
    };
    const s = vaultRecoverReducer(dc, { type: "cancel-delete" });
    expect(s.subStep).toBe("phrase-entry");
  });

  it("cancel-delete is blocked while in-flight", () => {
    const dc: VaultRecoverState = {
      ...initialState("phrase-entry"),
      subStep: "delete-confirm",
      deleteInFlight: true,
    };
    expect(vaultRecoverReducer(dc, { type: "cancel-delete" })).toBe(dc);
  });

  it("delete-in-flight sets the flag (only in delete-confirm)", () => {
    const dc: VaultRecoverState = {
      ...initialState("phrase-entry"),
      subStep: "delete-confirm",
    };
    expect(vaultRecoverReducer(dc, { type: "delete-in-flight" }).deleteInFlight).toBe(
      true,
    );
    const pe = phraseEntry();
    expect(vaultRecoverReducer(pe, { type: "delete-in-flight" })).toBe(pe);
  });

  it("delete-partial-fail stores context and clears in-flight", () => {
    const dc: VaultRecoverState = {
      ...initialState("phrase-entry"),
      subStep: "delete-confirm",
      deleteInFlight: true,
    };
    const s = vaultRecoverReducer(dc, {
      type: "delete-partial-fail",
      context: { kind: "io", vaultDirPath: "/vault" },
    });
    expect(s.deleteInFlight).toBe(false);
    expect(s.deletePartialFail).toEqual({ kind: "io", vaultDirPath: "/vault" });
  });

  it("delete-bug-canary just clears in-flight, stays in delete-confirm", () => {
    const dc: VaultRecoverState = {
      ...initialState("phrase-entry"),
      subStep: "delete-confirm",
      deleteInFlight: true,
    };
    const s = vaultRecoverReducer(dc, { type: "delete-bug-canary" });
    expect(s.subStep).toBe("delete-confirm");
    expect(s.deleteInFlight).toBe(false);
    expect(s.deletePartialFail).toBeNull();
  });
});
