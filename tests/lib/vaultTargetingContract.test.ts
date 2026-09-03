import { beforeEach, describe, expect, it, vi } from "vitest";

// The vault-TARGETING contract, asserted against BOTH clients' implementations
// from one file (myne-md/myne#476).
//
// **The defect.** myne-md/myne#250 deleted `resolveActiveVaultId()` from desktop
// because it answered "which vault is active" by ordering `listVaults()` on
// `last_unlock` and taking the head. That ordering reads the non-authoritative
// `registry.json` cache, and only the password-unlock path ever stamped it, so
// after a quick-unlock or a recovery it named a DIFFERENT vault than the one
// actually open, while three consumers treated its answer as fact. That is the
// root cause of myne-md/myne#241, the danger-zone delete erasing the wrong
// vault. Mobile kept exporting the deleted function verbatim, with zero callers,
// and could not have replaced it: the authoritative answer is the
// `vault_active_id` IPC command, which mobile registered nowhere.
//
// **Why the assertions are about the WIRE and not the return value.** A test
// that only checked `activeVaultId()` resolves to the right id would pass on the
// deleted implementation too, given a fixture where the cache happens to agree
// with the slot. The distinguishing question is which SOURCE was consulted, so
// each case asserts the command name that crossed IPC and, for the negative
// half, that `vault_list` was NOT called. That negative is the whole test: the
// bug was not a wrong answer from the right source, it was a plausible answer
// from the wrong one.
//
// **Both clients, one file**, because the property is that they agree. Two
// per-client tests would each pin a copy to itself, which is the shape this
// epic exists to remove.

const invoke = vi.hoisted(() => vi.fn());
vi.mock("../../src/platform/core", () => ({ invoke }));
vi.mock("../../mobile/src/platform/core", () => ({ invoke }));

const desktop = await import("../../src/lib/vault-list");
const mobile = await import("../../mobile/src/lib/vault-list");

/** The two implementations under test, named so a failure says which client. */
const CLIENTS = [
  { name: "desktop", mod: desktop },
  { name: "mobile", mod: mobile },
] as const;

const OPEN = "0197c0de-0000-7000-8000-00000000000a";
const STALE = "0197c0de-0000-7000-8000-00000000000b";

/**
 * What the `vault_list` COMMAND resolves with: the bare `VaultSummary[]`.
 *
 * Not the `{ ok }` wrapper, `listVaults()` builds that itself around the
 * invoke, and a fixture that pre-wrapped it produced `{ ok: { ok: [...] } }`,
 * so `res.ok.length !== 1` and `soleVaultId` answered null for the right reason
 * about the wrong input. The first version of this file did exactly that and
 * the assertion caught it, which is the only reason it is worth a comment: a
 * fixture that cannot hold the state under test passes for free.
 */
function listAnswering(ids: string[]): unknown {
  return ids.map((id, i) => ({
    id,
    status: { kind: "Exists" },
    label: null,
    icon: null,
    // Descending, so `orderByLastUnlock` puts ids[0] at the head, which is
    // exactly the answer the deleted function would have returned.
    last_unlock: 1_000 - i,
  }));
}

beforeEach(() => {
  invoke.mockReset();
});

describe.each(CLIENTS)("$name, active-vault resolution", ({ mod }) => {
  it("reads the runtime slot map, never the registry ordering", async () => {
    // The cache would name STALE; the slot map names OPEN. A caller that
    // consulted the cache would erase the wrong vault.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:vault-unlock|vault_active_id") return OPEN;
      if (cmd === "plugin:vault-unlock|vault_list") return listAnswering([STALE, OPEN]);
      throw new Error(`unexpected command ${cmd}`);
    });

    await expect(mod.activeVaultId()).resolves.toBe(OPEN);

    const commands = invoke.mock.calls.map((c: unknown[]) => c[0]);
    expect(commands).toEqual(["plugin:vault-unlock|vault_active_id"]);
    expect(commands).not.toContain("plugin:vault-unlock|vault_list");
  });

  it("answers null when no vault is unlocked", async () => {
    invoke.mockResolvedValue(null);
    await expect(mod.activeVaultId()).resolves.toBeNull();
  });

  it("answers null on a REFUSED probe rather than falling back", async () => {
    // "Unknown" and "no vault" are deliberately collapsed: both mean do not
    // act on a guess. A fallback to the disk list here would reintroduce the
    // exact ordering myne-md/myne#250 removed.
    invoke.mockRejectedValue(new Error("ACL denied"));
    await expect(mod.activeVaultId()).resolves.toBeNull();
    expect(invoke.mock.calls.map((c: unknown[]) => c[0])).not.toContain(
      "plugin:vault-unlock|vault_list",
    );
  });

  it("no longer exports the function myne-md/myne#250 deleted", () => {
    // A landmine rather than a live bug while it had no callers, and the first
    // caller reaching for the obvious-sounding name would have reproduced a
    // data-loss defect on a device whose vault is often the only copy.
    expect(mod).not.toHaveProperty("resolveActiveVaultId");
  });
});

describe.each(CLIENTS)("$name, sole-vault resolution", ({ mod }) => {
  it("answers the id when exactly one vault exists", async () => {
    invoke.mockResolvedValue(listAnswering([OPEN]));
    await expect(mod.soleVaultId()).resolves.toBe(OPEN);
  });

  it("answers NULL at two or more, which is the point", async () => {
    // "Delete the vault" is ambiguous here, and picking one silently is exactly
    // the class of guess myne-md/myne#250 removed. The pre-unlock delete
    // surfaces refuse on this null rather than erasing a guess.
    invoke.mockResolvedValue(listAnswering([STALE, OPEN]));
    await expect(mod.soleVaultId()).resolves.toBeNull();
  });

  it("answers null at zero", async () => {
    invoke.mockResolvedValue([]);
    await expect(mod.soleVaultId()).resolves.toBeNull();
  });

  it("answers null when the list itself failed", async () => {
    // `listVaults` catches the rejection into `{ err }`, so the failure arrives
    // as a REJECTED invoke rather than an error-shaped resolve.
    invoke.mockRejectedValue({ kind: "Io", detail: { io_error_kind: "Other" } });
    await expect(mod.soleVaultId()).resolves.toBeNull();
  });
});

describe("the two clients agree", () => {
  it("export the same targeting surface", () => {
    const surface = (m: object): string[] =>
      Object.keys(m)
        .filter((k) => k === "activeVaultId" || k === "soleVaultId" || k === "resolveActiveVaultId")
        .sort();
    // Not a blanket export comparison: these two modules legitimately differ
    // elsewhere (mobile has no `vaultDirDisplayPath` equivalent, and that is
    // recorded in the twin inventory). What may not differ is WHICH vault a
    // destructive action targets, which is these names and only these.
    expect(surface(mobile)).toEqual(surface(desktop));
    expect(surface(desktop)).toEqual(["activeVaultId", "soleVaultId"]);
  });
});
