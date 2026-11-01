import { describe, it, expect } from "vitest";
import { transition, initialStageFromProbe, type SlotMap } from "../src/lib/stage";
import type { VaultListResult, VaultSummary } from "../src/types/vault-summary";

const vault = (id: string, kind: "Exists" | "Corrupted" = "Exists"): VaultSummary => ({
  id,
  status: { kind },
  label: null,
  last_unlock: null,
});

describe("transition()", () => {
  it("advances welcome → create-vault (first-run briefing) on create-vault.start", () => {
    expect(transition({ name: "welcome" }, { type: "create-vault.start" })).toEqual({
      name: "create-vault",
      briefing: true,
    });
  });

  it("advances unlock → editor on unlock.success", () => {
    const next = transition(
      { name: "unlock", initialStatus: { kind: "Exists" } },
      { type: "unlock.success" },
    );
    expect(next.name).toBe("editor");
  });

  it("advances editor → unlock on editor.lock", () => {
    const next = transition({ name: "editor" }, { type: "editor.lock" });
    expect(next.name).toBe("unlock");
  });

  it("retains the previous stage on an illegal transition", () => {
    const prev = { name: "welcome" } as const;
    // editor.lock is not legal from welcome → unchanged
    expect(transition(prev, { type: "editor.lock" })).toBe(prev);
  });

  // myne-mobile#40 — the join door exists on three surfaces, so all three
  // `*.join-success` arms have to reach the joined vault's editor. Only
  // `welcome`'s did, which is what made joining unreachable once a vault existed.
  it("advances picker → editor on picker.join-success, carrying the joined vault id", () => {
    expect(transition({ name: "picker" }, { type: "picker.join-success", vaultId: "v-joined" })).toEqual({
      name: "editor",
      vaultId: "v-joined",
    });
  });

  it("re-addresses the editor at the joined vault on editor.join-success", () => {
    // The stage NAME is unchanged, so this is the one legal pair the dev-only
    // cross-product harness cannot distinguish from a rejected transition — the
    // swapped payload is the whole point and is asserted only here.
    const prev = { name: "editor", vaultId: "v-old" } as const;
    const next = transition(prev, { type: "editor.join-success", vaultId: "v-joined" });
    expect(next).toEqual({ name: "editor", vaultId: "v-joined" });
    expect(next).not.toBe(prev); // a new object → AppShell's `next === prev` guard lets it through
  });

  it("keeps each join-success action scoped to the stage that owns its door", () => {
    const prev = { name: "welcome" } as const;
    expect(transition(prev, { type: "picker.join-success", vaultId: "v-joined" })).toBe(prev);
    expect(transition(prev, { type: "editor.join-success", vaultId: "v-joined" })).toBe(prev);
  });

  // myne-md/myne#535, the mobile half. The wait is reached AFTER unlock, from a
  // verdict that cannot be taken before it, and it carries the editor's vault id
  // both ways so the approval lands on the vault it was about.
  describe("the awaiting-approval wait", () => {
    it("routes editor → pending-approval, carrying the vault id", () => {
      const prev = { name: "editor", vaultId: "v-pending" } as const;
      expect(transition(prev, { type: "editor.awaiting-approval" })).toEqual({
        name: "pending-approval",
        vaultId: "v-pending",
      });
    });

    it("leaves the wait for the editor it came from", () => {
      const prev = { name: "pending-approval", vaultId: "v-pending" } as const;
      // No payload: the stage's own id is the answer, which is the case a caller
      // reaches by clicking "They match".
      expect(transition(prev, { type: "pending-approval.approved" })).toEqual({
        name: "editor",
        vaultId: "v-pending",
      });
      // A payload still wins, for a caller that knows better than the stage did.
      expect(
        transition(prev, { type: "pending-approval.approved", vaultId: "v-other" }),
      ).toEqual({ name: "editor", vaultId: "v-other" });
    });

    it("is reachable from nothing but the editor, and exits nowhere but the editor", () => {
      // The verdict is the ONLY inbound edge (a boot-time inference is the
      // deadlock 0519 removed), and the wait has no lock or create arm: leaving it
      // any other way is the shell's lock-then-reprobe, not a transition.
      const fromUnlock = { name: "unlock", initialStatus: { kind: "Exists" } } as const;
      expect(transition(fromUnlock, { type: "editor.awaiting-approval" })).toBe(fromUnlock);
      const waiting = { name: "pending-approval" } as const;
      expect(transition(waiting, { type: "editor.lock" })).toBe(waiting);
      expect(transition(waiting, { type: "editor.create-vault" })).toBe(waiting);
    });
  });
});

describe("initialStageFromProbe()", () => {
  const noSlots: SlotMap = {};

  it("0 vaults → welcome", () => {
    const list: VaultListResult = { ok: [] };
    expect(initialStageFromProbe(list, noSlots)).toEqual({ name: "welcome" });
  });

  it("1 Exists vault → unlock(Exists) carrying its id", () => {
    const list: VaultListResult = { ok: [vault("v1")] };
    expect(initialStageFromProbe(list, noSlots)).toEqual({
      name: "unlock",
      initialStatus: { kind: "Exists" },
      vaultId: "v1",
    });
  });

  it("1 Corrupted vault → unlock(Corrupted)", () => {
    const list: VaultListResult = { ok: [vault("v1", "Corrupted")] };
    const stage = initialStageFromProbe(list, noSlots);
    expect(stage.name).toBe("unlock");
    expect(stage.name === "unlock" && stage.initialStatus.kind).toBe("Corrupted");
  });

  it("≥2 vaults → picker", () => {
    const list: VaultListResult = { ok: [vault("v1"), vault("v2")] };
    expect(initialStageFromProbe(list, noSlots)).toEqual({ name: "picker" });
  });

  it("list-level IO error → unlock(IoError)", () => {
    const list: VaultListResult = { err: { kind: "IoError", detail: { io_error_kind: "Other" } } };
    expect(initialStageFromProbe(list, noSlots)).toEqual({
      name: "unlock",
      initialStatus: { kind: "IoError", ioKind: "Other" },
    });
  });

  it("a Recovering slot trumps disk → recover(password-reset)", () => {
    const list: VaultListResult = { ok: [vault("v1")] };
    expect(initialStageFromProbe(list, { active: "Recovering" })).toEqual({
      name: "recover",
      subStep: "password-reset",
    });
  });

  it("an Unlocked slot trumps disk → editor", () => {
    const list: VaultListResult = { ok: [] };
    expect(initialStageFromProbe(list, { active: "Unlocked" })).toEqual({ name: "editor" });
  });
});

describe("restore-backup doors (MYND-56 / audit T6.8)", () => {
  // The four restore-backup arms were absent from the action-verification walk,
  // so nothing exercised them. Each of the four doors must land on the
  // restore-backup stage with its OWN entry (the entry drives the back label).
  it("welcome → restore-backup (entry welcome)", () => {
    expect(transition({ name: "welcome" }, { type: "welcome.restore-backup" })).toEqual({
      name: "restore-backup",
      entry: "welcome",
    });
  });

  it("picker → restore-backup (entry picker)", () => {
    expect(transition({ name: "picker" }, { type: "picker.restore-backup" })).toEqual({
      name: "restore-backup",
      entry: "picker",
    });
  });

  it("unlock(corrupted) → restore-backup (entry corrupted)", () => {
    expect(
      transition(
        { name: "unlock", initialStatus: { kind: "Corrupted" } },
        { type: "unlock.restore-backup" },
      ),
    ).toEqual({ name: "restore-backup", entry: "corrupted" });
  });

  it("editor → restore-backup (entry settings)", () => {
    expect(transition({ name: "editor" }, { type: "editor.restore-backup" })).toEqual({
      name: "restore-backup",
      entry: "settings",
    });
  });
});
