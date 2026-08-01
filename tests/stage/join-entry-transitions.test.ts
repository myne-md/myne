// The device-join door's landing, per entry (myne#221).
//
// `sync_join_account` bootstraps AND unlocks a fresh local vault, so every join
// lands directly in the editor, vault-addressed — there is no unlock hop. What
// this file pins is that all THREE doors land there, because until myne#221
// only one of them existed: `welcome.join-success`. Boot routing produces
// `welcome` solely at zero vaults, so the first vault a user created made the
// join unreachable, with deleting every vault as the only way back.
//
// One action per source stage, matching how this table already models a shared
// destination (`picker.create-vault` / `editor.create-vault`; four separate
// `*.restore-backup`). The switcher's is keyed on `unlock` rather than `editor`
// and that is load-bearing, not incidental: the switcher entry tears the active
// vault down first (`leaveActiveVault` → `editor.lock`) and opens the modal over
// the resulting unlock screen, because the join unlocks a DIFFERENT vault and
// SYNC-1 zeroizes the active one on the way. A modal left over a mounted editor
// would sit on plaintext whose keys are already gone, for the whole
// `join.pending` wait.
//
// Pure-`transition` assertions: the same `Stage["name"]`-level legality the
// in-tree `verifyTransitionTable` harness walks, plus the `vaultId` threading it
// does not inspect.

import { describe, expect, it, vi } from "vitest";
import { transition, type Action, type Stage } from "../../src/lib/stage";

const VID = "00000000-0000-7000-8000-00000000000a";

/** Run a deliberately illegal pair without the dev-only `rejectIllegal` warn. */
function transitionQuietly(prev: Stage, action: Action): Stage {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    return transition(prev, action);
  } finally {
    warn.mockRestore();
  }
}

describe("every join door lands in the joined vault's editor", () => {
  const doors: Array<{ label: string; prev: Stage; action: Action }> = [
    { label: "welcome", prev: { name: "welcome" }, action: { type: "welcome.join-success", vaultId: VID } },
    { label: "picker", prev: { name: "picker" }, action: { type: "picker.join-success", vaultId: VID } },
    {
      label: "switcher (via the unlock screen it locks through)",
      prev: { name: "unlock", initialStatus: { kind: "Exists" } },
      action: { type: "unlock.join-success", vaultId: VID },
    },
  ];

  for (const { label, prev, action } of doors) {
    it(`${label} → editor, carrying the joined vaultId`, () => {
      const next = transition(prev, action);
      expect(next.name).toBe("editor");
      if (next.name !== "editor") throw new Error("unreachable");
      expect(next.vaultId).toBe(VID);
    });
  }
});

describe("each join action is legal only from the stage that offers its door", () => {
  it("picker.join-success is rejected from editor — stays on editor", () => {
    const next = transitionQuietly({ name: "editor" }, { type: "picker.join-success", vaultId: VID });
    expect(next).toEqual({ name: "editor" });
  });

  it("unlock.join-success is rejected from picker — stays on picker", () => {
    const next = transitionQuietly({ name: "picker" }, { type: "unlock.join-success", vaultId: VID });
    expect(next).toEqual({ name: "picker" });
  });

  it("welcome.join-success is rejected from unlock — stays on unlock", () => {
    const prev: Stage = { name: "unlock", initialStatus: { kind: "Exists" } };
    expect(transitionQuietly(prev, { type: "welcome.join-success", vaultId: VID })).toEqual(prev);
  });
});

describe("the joined vaultId is optional payload, not a precondition", () => {
  it("a join with no id still reaches the editor (the boot-probe entry shape)", () => {
    const next = transition({ name: "picker" }, { type: "picker.join-success" });
    expect(next.name).toBe("editor");
    if (next.name !== "editor") throw new Error("unreachable");
    expect(next.vaultId).toBeUndefined();
  });
});
