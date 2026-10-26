// The updating stage's place in the state machine (myne-md/myne#870).
//
// The desktop self-update flow added one stage and one action, and both halves of
// the pair are worth pinning here rather than leaving to the in-tree
// `verifyTransitionTable` harness:
//
//   - `editor` is the ONLY stage that accepts `editor.update-start`, which is
//     what keeps the flow from being reachable from a locked or pre-unlock
//     screen that has no vault to flush and no keys to drop.
//   - `updating` has no transition exits at all. A successful install replaces
//     the process, and the failure path leaves through `reprobe()` once the vault
//     is locked, so an action that moved this stage would mean the flow had grown
//     a second exit nobody designed.
//   - the boot probe never produces it, so a relaunch can never land there.

import { describe, expect, it } from "vitest";
import {
  initialStageFromProbe,
  transition,
  type SlotMap,
  type Stage,
} from "../../src/lib/stage";
import type { VaultListResult, VaultSummary } from "../../src/types/vault-summary";

const VID = "00000000-0000-7000-8000-00000000000a";

function existsVault(): VaultSummary {
  return {
    id: VID,
    status: { kind: "Exists" },
    label: null,
    icon: null,
    last_unlock: null,
    published: false,
  };
}

/** The probe's shapes, spelled the way the boot probe receives them. */
const okList = (...vaults: VaultSummary[]): VaultListResult => ({ ok: vaults });
const unlocked: SlotMap = { [VID]: "Unlocked" };

describe("editor.update-start", () => {
  it("is legal from the editor and lands on `updating`", () => {
    const next = transition({ name: "editor", vaultId: VID }, { type: "editor.update-start" });
    expect(next.name).toBe("updating");
  });

  it("is rejected by every other stage, `updating` included", () => {
    const stages: Stage[] = [
      { name: "welcome" },
      { name: "picker" },
      { name: "unlock", initialStatus: { kind: "Exists" } },
      { name: "create-vault" },
      { name: "recover", subStep: "phrase-entry" },
      { name: "account-entry" },
      { name: "pending-approval" },
      { name: "restore-backup", entry: "welcome" },
      { name: "updating" },
    ];
    for (const stage of stages) {
      const next = transition(stage, { type: "editor.update-start" });
      expect(next.name, `${stage.name} accepted editor.update-start`).toBe(stage.name);
    }
  });

  it("cannot be reached by a relaunch, because the boot probe never answers it", () => {
    // An unlocked vault on disk: the ordinary post-crash boot. The probe has no
    // arm that yields `updating`, which is what makes the stage an
    // install-in-flight marker rather than a state a boot could restore.
    const stage = initialStageFromProbe(okList(existsVault()), unlocked);
    expect(stage.name).toBe("editor");
  });
});
