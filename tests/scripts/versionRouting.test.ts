// The debt figure of `check-version-routing.mjs`, and the two directions its
// ratchet has to hold.
//
// The guard's printed figure was wrong from the day the DEBT section was added,
// and wrong in the way this repository's AGENTS.md calls out as the expensive
// one — it was GREEN. The filter was
//
//     ALLOWED.filter(([, [, why]]) => why.startsWith("debt"))
//
// while no reason string in the file has ever begun with that word: the group
// was marked by a COMMENT BANNER over its entries. So the run printed
// "0 still debt" beside a section that carried a live entry, and every reader
// who took the number at its word concluded the routing debt was cleared.
//
// The fix moved membership into a structure (`DEBT`), which is what makes the
// figure checkable at all. These cases are the check: the tables are the
// denominator and the number must not be derivable from prose again.
//
// Both directions, per the repo rule: the debt figure must be non-zero while
// DEBT has entries AND must not depend on a reason prefix; and the matcher that
// names a real offender must still fire, because a guard that has quietly
// stopped checking is green by definition.

import { describe, expect, it } from "vitest";
import {
  ALLOWED,
  DEBT,
  debtTotal,
  overlappingKeys,
  protocolImports,
  callsProtocolName,
} from "../../scripts/check-version-routing.mjs";

describe("the debt figure is a property of the table, not of a reason string", () => {
  it("is non-zero while DEBT carries entries", () => {
    expect(DEBT.size).toBeGreaterThan(0);
    expect(debtTotal()).toBeGreaterThan(0);
  });

  it("does not depend on any reason beginning with `debt`", () => {
    // The defect, restated as an assertion. If this ever becomes false the
    // original bug would be invisible again, because a prefix filter would
    // start working for a reason nobody wrote the rule for.
    for (const [, entry] of DEBT as Map<string, [number, string]>) {
      const [count, reason] = entry;
      expect(reason.startsWith("debt")).toBe(false);
      expect(count).toBeGreaterThan(0);
    }
    expect(debtTotal()).toBeGreaterThan(0);
  });

  it("reads 4 today, and a change to that number is a deliberate act", () => {
    // The ratchet's own rule (one-directional: the debt may only shrink) is what
    // makes pinning the figure correct rather than brittle — raising it means
    // editing this line too, which is the reviewable act.
    //
    // 3 → 4 in view-manifests: `note_set_field` adds a FOURTH note-write path.
    // It dispatches on `is_nc05_blob` exactly as `note_update` does, and its
    // `MY01` arm calls `protocol::decode_note` because the re-encode needs that
    // function's typestate (`encode_update_blob_raw` takes the handle, not the
    // bytes), so it carries the same debt the other three do. `decode_note_any`
    // cannot replace it here without dropping back to bytes this module has no
    // way to re-seal.
    expect(debtTotal()).toBe(4);
    expect(DEBT.get("core/src/plugins/notes/commands.rs#note")?.[0]).toBe(4);
  });

  it("keeps the two tables disjoint, so the lookup cannot resolve by spread order", () => {
    expect(overlappingKeys()).toEqual([]);
  });

  it("names a key that appears in both tables", () => {
    // The detector, driven directly. An entry in both tables means the budget
    // lookup silently takes whichever object spread last — the same shape of
    // silent resolution the reason-prefix filter had.
    const a = new Map([["f.rs#kek", [1, "legitimately v0.1: the migration's OLD keys"]]]);
    const b = new Map([["f.rs#kek", [2, "not yet routed"]]]);
    expect(overlappingKeys(a, b)).toEqual(["f.rs#kek"]);
    expect(overlappingKeys(ALLOWED, DEBT)).toEqual([]);
  });
});

describe("every offender it named before, it still names", () => {
  it("reads both import shapes a file can use", () => {
    expect([...protocolImports("use protocol::{derive_subkey, parse_vault_meta};")]).toEqual([
      "derive_subkey",
      "parse_vault_meta",
    ]);
    expect([...protocolImports("use protocol::decode_note;")]).toEqual(["decode_note"]);
    expect([...protocolImports("use protocol::{derive_subkey as ds};")]).toEqual(["derive_subkey"]);
  });

  it("names a qualified call with no import in sight", () => {
    const imports = protocolImports("fn f() {}");
    expect(
      callsProtocolName("    let k = protocol::derive_subkey(root, role)?;", "derive_subkey", imports),
    ).toBe(true);
  });

  it("names a bare call only where the file imported the name", () => {
    const withImport = protocolImports("use protocol::derive_subkey;");
    const without = protocolImports("use protocol::derive_items_key;");
    expect(callsProtocolName("    let k = derive_subkey(root, role)?;", "derive_subkey", withImport)).toBe(
      true,
    );
    expect(callsProtocolName("    let k = derive_subkey(root, role)?;", "derive_subkey", without)).toBe(
      false,
    );
  });

  it("does not confuse a definition with a call site", () => {
    // `vault_recover::derive_items_key` IS the version-aware replacement, and a
    // file that defines it is not a file that reached for the v0.1-only helper.
    const imports = protocolImports("use protocol::derive_items_key;");
    expect(
      callsProtocolName("pub fn derive_items_key(version: MetaVersion) -> Zeroizing<[u8; 32]> {", "derive_items_key", imports),
    ).toBe(false);
    expect(callsProtocolName("fn derive_items_key(", "derive_items_key", imports)).toBe(false);
  });
});
