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

import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";
import {
  ALLOWED,
  CLASSES,
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
    //
    // 4 → 8 when the `gen` class landed (myne-md/myne#984): the three quarters of
    // that class the tree already carries. `adopt.rs` is one, `orchestrator.rs` is
    // two (the `!= Legacy` pair in the meta-merge condition), and
    // `person_discovery.rs` is one (`is_person_born` spelled as a subset
    // `matches!`). Two sites are NOT here: `decrypt/src/unlock.rs` and
    // `person_vault_carrier.rs` both sit in ALLOWED, because in each the variant IS
    // the caller's question. The carrier one is the load-bearing case: routing it
    // through `carries_b2b_tail` would let a vault credential unwrap the person
    // keypair on a person-born generation, which is the escalation the predicate
    // exists to exclude.
    expect(debtTotal()).toBe(8);
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

// The generation-equality class (myne-md/myne#983).
//
// `person_vault_carrier::carrier_applies` asked "is this a B2B vault" as
// `vault_meta_generation(&b) == VaultMetaGeneration::B2b`. `NTV8` is
// `PersonNoWrap`, so the predicate answered false for every vault the product had
// started creating, the person-identity carrier stood down, and sync stopped after
// every lock with nothing failing.
//
// The class is worth a test of its own rather than only the injection that proved
// it, because the two shapes it must tell apart look almost identical: an equality
// test against ONE variant (the defect) and a `match` naming ALL of them (the shape
// that makes a fifth generation a compile error). A regex that swallowed both would
// pass the injection and then force the good shape out of the tree.
describe("the generation-equality class", () => {
  const re = CLASSES.gen.re;

  it("fires on an equality test against a single variant", () => {
    expect(
      re.test("if protocol::vault_meta_generation(&b) == protocol::VaultMetaGeneration::B2b {"),
    ).toBe(true);
    expect(re.test("if local_generation != protocol::VaultMetaGeneration::Legacy")).toBe(true);
    expect(re.test("if protocol::VaultMetaGeneration::PersonNoWrap == g {")).toBe(true);
    expect(re.test("matches!(g, VaultMetaGeneration::B2b)")).toBe(true);
  });

  it("does not fire on a match naming every variant, or on the classifier itself", () => {
    expect(re.test("match protocol::vault_meta_generation(&b) {")).toBe(false);
    expect(re.test("protocol::VaultMetaGeneration::Person => Some(Self::Ntv7),")).toBe(false);
    expect(re.test("protocol::VaultMetaGeneration::PersonNoWrap => Some(Self::Ntv8),")).toBe(false);
    expect(re.test("let generation = protocol::vault_meta_generation(&bytes);")).toBe(false);
  });

  it("is recorded in at least one table, so the count is not a silent zero", () => {
    const recorded = [...ALLOWED.keys(), ...DEBT.keys()].filter((k) => k.endsWith("#gen"));
    expect(recorded.length).toBeGreaterThan(0);
  });
});

// The class both directions, measured rather than asserted. The guard's own staleness
// half ties every recorded entry to a live site, so this run fails if the class is
// removed, if the regex stops matching a recorded site, or if a budget drifts. The
// injection was run by hand as well: a Rust file carrying
// `vault_meta_generation(&b) == protocol::VaultMetaGeneration::B2b` is reported by
// name, and the tree was restored afterwards.
describe("the guard still runs over the tree", () => {
  it("exits clean, which is also what proves the recorded budgets describe live sites", () => {
    const out = execFileSync(process.execPath, ["scripts/check-version-routing.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(out).toContain("version-routing: ok");
    expect(out).toContain("This number must only go down");
    // The claim is the guard's own verdict, not the machine's speed. This spawns
    // a node process that walks every Rust and TypeScript file in the checkout,
    // and on the loaded CI runner that crossed the suite's 5 s default three
    // pipelines in a row (v0.13.0) without the guard ever printing a failure.
  }, 30_000);
});
