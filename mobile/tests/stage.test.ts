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
