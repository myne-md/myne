import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  bootDecision,
  SHARED_LEGAL,
  POST_RECOVERY_CANCEL_STAGE,
  POST_RECOVERY_SUCCESS_STAGE,
  type BootDecision,
  type SlotMap,
} from "@myne/client-core/stage-decision";
import type { VaultListResult, VaultSummary } from "@myne/client-core/types/vault-summary";

// Drift lock for the shared boot / post-delete / post-recovery routing decision
// (myne-md/myne#477).
//
// **What this locks, and why a test rather than a guard.** The decision now has
// one implementation, in `@myne/client-core/stage-decision`. What a compiler
// cannot see is a client quietly stepping around it: re-implementing the slot
// scan next to the shared call, or spreading `SHARED_LEGAL` and then
// overriding one of its keys on the line below. Both type-check, both leave the
// import in place so a reachability guard stays green, and both put the
// decision back to two implementations while the file still looks shared.
//
// **The two halves are asserted differently on purpose.** The DECISION is
// imported and driven directly, because it is host-free and this lane can run
// it. The two clients' USE of it is asserted by parsing their source, because
// `mobile/src` is not resolvable from the desktop Vitest lane and a per-tree
// copy of this test is the second place it can drift. That parse is the same
// technique `tests/types/rustEnumParity.test.ts` uses, and it fails BY NAME on
// a missing file rather than reporting ok over an input it never read.

const at = (p: string): string => fileURLToPath(new URL(`../../${p}`, import.meta.url));

/** The two client stage machines this decision is shared between. */
const CLIENT_STAGES = [
  { tree: "desktop", path: "src/lib/stage.ts" },
  { tree: "mobile", path: "mobile/src/lib/stage.ts" },
];

/**
 * The floor under `SHARED_LEGAL`, measured rather than chosen: 20 was the exact
 * overlap of the two tables at extraction, and not one of the 20 routed
 * differently. Without a floor the table is trivially satisfiable by emptying
 * it, which would read in a diff as a table that got shorter.
 */
const SHARED_LEGAL_FLOOR = 20;

const VAULT_A = "00000000-0000-7000-8000-00000000000a";
const VAULT_B = "00000000-0000-7000-8000-00000000000b";

function summary(id: string, kind: "Exists" | "Corrupted"): VaultSummary {
  return {
    id,
    status: { kind } as VaultSummary["status"],
    label: null,
    icon: null,
    last_unlock: null,
    published: false,
  } as VaultSummary;
}

const okList = (...vaults: VaultSummary[]): VaultListResult => ({ ok: vaults });

describe("bootDecision (the one implementation, myne#477)", () => {
  const noSlots: SlotMap = {};

  it("lets a Recovering slot win over everything, including Unlocked", () => {
    // Slot priority is the first rule and it is not a tie-break: the chained
    // recovery step is not dismissible, so it outranks a live session and it
    // outranks whatever the disk says.
    const both: SlotMap = { [VAULT_A]: "Unlocked", [VAULT_B]: "Recovering" };
    expect(bootDecision(okList(), both)).toEqual({ kind: "resume-recovery" });
    expect(bootDecision({ ok: [summary(VAULT_A, "Exists")] }, both)).toEqual({
      kind: "resume-recovery",
    });
  });

  it("resumes the editor on an Unlocked slot regardless of vault count", () => {
    const unlocked: SlotMap = { [VAULT_A]: "Unlocked" };
    expect(bootDecision(okList(), unlocked)).toEqual({ kind: "resume-editor" });
    expect(
      bootDecision(okList(summary(VAULT_A, "Exists"), summary(VAULT_B, "Exists")), unlocked),
    ).toEqual({ kind: "resume-editor" });
  });

  it("is fail-closed on a list-level IO failure, whatever the slots say", () => {
    const err = {
      err: { detail: { io_error_kind: "PermissionDenied" } },
    } as unknown as VaultListResult;
    expect(bootDecision(err, noSlots)).toEqual({
      kind: "list-io-error",
      ioKind: "PermissionDenied",
    });
    // Empty slots only; a non-Empty slot legitimately outranks the list, which
    // the two cases above already assert.
    expect(bootDecision(err, { [VAULT_A]: "Empty" })).toEqual({
      kind: "list-io-error",
      ioKind: "PermissionDenied",
    });
  });

  it("splits on vault count: 0, exactly 1, and two or more", () => {
    expect(bootDecision(okList(), noSlots)).toEqual({ kind: "no-vaults" });
    expect(bootDecision(okList(summary(VAULT_A, "Exists")), noSlots)).toEqual({
      kind: "single-vault",
      vaultId: VAULT_A,
      status: { kind: "Exists" },
    });
    expect(
      bootDecision(okList(summary(VAULT_A, "Exists"), summary(VAULT_B, "Exists")), noSlots),
    ).toEqual({ kind: "multiple-vaults" });
  });

  it("carries the single vault's status through rather than flattening it", () => {
    // The status is what each client's screen mapping branches on, and it is the
    // one place a shared decision could quietly lose information: answering
    // `single-vault` without the status would force both clients to re-read the
    // list, which is the duplication this module removes.
    expect(bootDecision(okList(summary(VAULT_A, "Corrupted")), noSlots)).toEqual({
      kind: "single-vault",
      vaultId: VAULT_A,
      status: { kind: "Corrupted" },
    });
  });

  it("treats an Empty slot as no slot at all", () => {
    expect(bootDecision(okList(), { [VAULT_A]: "Empty", [VAULT_B]: "Empty" })).toEqual({
      kind: "no-vaults",
    });
  });
});

describe("SHARED_LEGAL", () => {
  it("keeps at least as many rows as the two tables were measured to share", () => {
    expect(
      Object.keys(SHARED_LEGAL).length,
      "the shared table shrank; a row moved back to a client rather than being fixed",
    ).toBeGreaterThanOrEqual(SHARED_LEGAL_FLOOR);
  });

  it("routes recovery through the named constants rather than a repeated literal", () => {
    expect(SHARED_LEGAL["recover|recover.complete-success"]).toBe(POST_RECOVERY_SUCCESS_STAGE);
    expect(SHARED_LEGAL["recover|recover.cancel"]).toBe(POST_RECOVERY_CANCEL_STAGE);
  });

  it("is frozen, so a client cannot mutate the shared table at import time", () => {
    // A spread override is visible in the source and the parse below catches it.
    // A `SHARED_LEGAL[k] = v` at module scope is not visible in either client's
    // table literal, and would change the decision for BOTH clients from inside
    // one of them.
    expect(Object.isFrozen(SHARED_LEGAL)).toBe(true);
  });
});

describe.each(CLIENT_STAGES)("$tree stage machine uses the shared decision", ({ path }) => {
  const src = readFileSync(at(path), "utf8");

  it("calls bootDecision instead of re-implementing the probe", () => {
    expect(src, `${path} does not import the shared decision`).toContain(
      'from "@myne/client-core/stage-decision"',
    );
    expect(src, `${path} does not call bootDecision`).toContain("bootDecision(vaultList, slotMap)");
  });

  it("no longer carries its own copy of the slot scan", () => {
    // The exact expression both files used to hold. Its reappearance beside the
    // shared call is the shape this test exists for: the import stays, the
    // decision goes back to two implementations, and nothing else notices.
    expect(src, `${path} re-implements the slot-priority scan`).not.toContain(
      'slots.includes("Recovering")',
    );
    expect(src, `${path} re-implements the vault-count split`).not.toContain(
      "vaults.length === 0",
    );
  });

  it("composes its LEGAL table from SHARED_LEGAL", () => {
    expect(src, `${path} does not spread the shared table`).toContain("...(SHARED_LEGAL");
  });

  it("overrides no shared transition", () => {
    // Parse the client's own rows out of its LEGAL literal and check none of
    // them names a key `SHARED_LEGAL` already answers. A spread followed by an
    // override type-checks, keeps the import, and silently retargets a
    // transition both clients are supposed to agree on.
    const start = src.indexOf('const LEGAL: Record<string, Stage["name"]> = {');
    expect(start, `${path} has no LEGAL table to read`).toBeGreaterThan(-1);
    const end = src.indexOf("\n};", start);
    expect(end, `${path}'s LEGAL table is unterminated`).toBeGreaterThan(start);
    const body = src.slice(start, end);

    const ownRows = [...body.matchAll(/^\s+"([a-z-]+\|[a-z.-]+)":\s*"([a-z-]+)"/gm)].map((m) => ({
      key: m[1],
      target: m[2],
    }));
    const overrides = ownRows.filter((r) => r.key in SHARED_LEGAL);
    expect(
      overrides.map((r) => `${r.key} -> ${r.target} (shared says ${SHARED_LEGAL[r.key]})`),
      `${path} overrides a shared transition`,
    ).toEqual([]);
  });
});

describe("the client screen mappings stay exhaustive", () => {
  it("names every BootDecision variant in both clients", () => {
    // A `switch` over `BootDecision` with a missing arm is caught by
    // `assertNever` at compile time, so this asserts the weaker thing the
    // compiler cannot: that neither client answered a variant by falling through
    // to a default. Keyed on the variant list rather than a count, so a new
    // variant fails here by name in both trees.
    const variants: BootDecision["kind"][] = [
      "resume-recovery",
      "resume-editor",
      "list-io-error",
      "no-vaults",
      "single-vault",
      "multiple-vaults",
    ];
    for (const { tree, path } of CLIENT_STAGES) {
      const src = readFileSync(at(path), "utf8");
      const missing = variants.filter((v) => !src.includes(`case "${v}":`));
      expect(missing, `${tree} (${path}) has no arm for these decisions`).toEqual([]);
    }
  });
});
