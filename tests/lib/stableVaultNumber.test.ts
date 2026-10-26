// `stableVaultNumber`: the N behind the "Vault N" fallback (myne-md/myne#411).
//
// The defect it removes is pre-existing and predates the sealed label store:
// every "Vault N" surface numbered rows by their POSITION in a list ordered by
// last unlock, so the identifier a user was asked to remember moved as they
// used the app. Unlock the third vault and it becomes Vault 1, and the one that
// was Vault 1 becomes Vault 2. It is in scope for this feature because the
// hide-vault-names option makes every row fall back at once, which turns a slow
// annoyance into the primary way the picker reads.
//
// The property under test is therefore stability, and it has two halves that
// have to be asserted separately: the number may not follow the render order
// (that is the bug), and two vaults may not land on the same number (that is
// what any hash-into-a-small-range rule would have risked).

import { describe, expect, it } from "vitest";
import { orderByLastUnlock, stableVaultNumber } from "../../src/lib/vault-list";
import type { VaultSummary } from "../../src/types/vault-summary";

function vault(id: string, last_unlock: number | null): VaultSummary {
  return {
    id,
    status: { kind: "Exists" },
    label: null,
    icon: null,
    last_unlock,
    published: false,
  };
}

// Three real UUIDv7-shaped ids whose ASCII order is a, b, c and whose unlock
// times deliberately run the other way, so a positional rule and a rank rule
// disagree on every row.
const A = "0197c0de-0000-7000-8000-00000000000a";
const B = "0197c0de-0000-7000-8000-00000000000b";
const C = "0197c0de-0000-7000-8000-00000000000c";

describe("stableVaultNumber", () => {
  it("does not change when the unlock order changes", () => {
    // The acceptance criterion, written as the two runs it describes: same
    // device, same three vaults, a different vault unlocked in between.
    const run1 = [vault(A, 300), vault(B, 200), vault(C, 100)];
    const run2 = [vault(C, 900), vault(A, 300), vault(B, 200)];

    for (const id of [A, B, C]) {
      expect(stableVaultNumber(run2, id)).toBe(stableVaultNumber(run1, id));
    }
  });

  it("ignores the order of the array it is handed", () => {
    // Stronger than the above: the answer is a function of the SET, so the
    // caller may pass the list in whatever order it renders.
    const set = [vault(A, 300), vault(B, 200), vault(C, 100)];
    const shuffled = [set[2], set[0], set[1]];
    const reversed = [...set].reverse();
    for (const id of [A, B, C]) {
      expect(stableVaultNumber(shuffled, id)).toBe(stableVaultNumber(set, id));
      expect(stableVaultNumber(reversed, id)).toBe(stableVaultNumber(set, id));
    }
  });

  it("never gives two vaults the same number", () => {
    // Not "collisions are unlikely": a rank over a set of distinct ids is an
    // injection, so two rows cannot be named the same thing. This is the
    // property a hash-into-1..99 rule would have had to defend with a
    // tie-break, and the reason the rank rule was chosen over it.
    const set = [vault(A, 300), vault(B, null), vault(C, 100)];
    const numbers = set.map((v) => stableVaultNumber(set, v.id));
    expect(new Set(numbers).size).toBe(set.length);
  });

  it("numbers 1..n with no gaps, so the fallback stays a name a person can hold", () => {
    const set = [vault(C, 100), vault(A, 300), vault(B, 200)];
    const numbers = set.map((v) => stableVaultNumber(set, v.id)).sort();
    expect(numbers).toEqual([1, 2, 3]);
  });

  it("numbers by id order, not by recency", () => {
    // The concrete claim, spelled out so a future rule change has to argue with
    // a value rather than with a property: A sorts first and unlocked last.
    const set = [vault(A, 300), vault(B, 200), vault(C, 100)];
    expect(stableVaultNumber(set, A)).toBe(1);
    expect(stableVaultNumber(set, B)).toBe(2);
    expect(stableVaultNumber(set, C)).toBe(3);
    // And the rendered order really is the other way round, so the two rules
    // genuinely disagree here.
    expect(orderByLastUnlock(set).map((v) => v.id)).toEqual([A, B, C]);
  });

  it("leaves the existing vaults alone when another is created", () => {
    // A minted `VaultId` is a UUIDv7, so a new vault sorts AFTER every vault
    // that already exists and takes the next number. Creating one is the
    // common set change and it renumbers nobody.
    const before = [vault(A, 300), vault(B, 200)];
    const after = [...before, vault(C, null)];
    expect(stableVaultNumber(after, A)).toBe(stableVaultNumber(before, A));
    expect(stableVaultNumber(after, B)).toBe(stableVaultNumber(before, B));
    expect(stableVaultNumber(after, C)).toBe(3);
  });

  it("shifts the vaults after a deleted one down, which is the recorded limit", () => {
    // Pinned rather than hidden. N is stable against USE, which is the defect
    // being fixed; it is not stable against a change to the SET. Deleting a
    // vault is rare, deliberate and irreversible, and the alternative rule that
    // would survive it collides instead.
    const before = [vault(A, 300), vault(B, 200), vault(C, 100)];
    const after = [vault(A, 300), vault(C, 100)];
    expect(stableVaultNumber(after, A)).toBe(1);
    expect(stableVaultNumber(after, C)).toBe(2);
    expect(stableVaultNumber(before, C)).toBe(3);
  });

  it("answers for an id that is not in the list", () => {
    // Total by construction: the callers derive the id from a row of the same
    // list, but a rule with a hole in it is one `!` away from a crash on a
    // screen that renders while data is in flight.
    expect(stableVaultNumber([], A)).toBe(1);
    expect(stableVaultNumber([vault(A, 1)], C)).toBe(2);
  });
});
