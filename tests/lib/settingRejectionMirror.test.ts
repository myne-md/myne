// `SettingRejection` is mirrored by hand into TypeScript and into the catalog, and
// nothing checked either half (myne-md/myne#850, from the 2026-10-13 review, which
// is also where the settings refusal keys moved into their OWN namespace).
//
// The sibling of `editRejectionMirror.test.ts`, and the reason it exists as a
// second file rather than as four more cases in that one: the two enums are
// different Rust types with different reasons, and the settings were first given
// keys inside `agent.review.refused.*`, which is the namespace that test holds
// equal to `EditRejection` in both directions. Sharing it made the edits' mirror
// fail on the settings' new keys, which is the correct outcome for a check of that
// shape and the wrong shape for the settings.
//
// Same failure mode as the edit half, and it is the one no guard sees: `AgentReview`
// builds the key DYNAMICALLY (`agent.review.refusedSetting.${r.reason}`), and
// `check-i18n.mjs` scans static literals by design, so a missing key is not a build
// error, not a lint and not a failing i18n check. It is a user staring at
// `agent.review.refusedSetting.writeFailed` where a sentence should be, on the row
// whose whole purpose is to say why an approved change did not land.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The `SettingRejection` variants, read out of the Rust source and camelCased the
 *  way `#[serde(rename_all = "camelCase")]` does. */
function rustVariants(): string[] {
  const src = readFileSync(
    join(REPO, "core/src/plugins/agent/apply.rs"),
    "utf8",
  );
  const body = /pub enum SettingRejection \{([\s\S]*?)\n\}/.exec(src);
  if (body === null) {
    throw new Error(
      "SettingRejection not found in core/src/plugins/agent/apply.rs. If it moved, " +
        "this test has to follow it rather than be deleted",
    );
  }
  // Variant lines only: four-space indent, an identifier, a comma. Doc comments and
  // attributes are skipped by the shape rather than by stripping, so a
  // `#[serde(rename = …)]` on a variant breaks this loudly instead of silently
  // producing the wrong name.
  return [...body[1].matchAll(/^ {4}([A-Z][A-Za-z0-9]*),$/gm)].map((m) =>
    m[1].replace(/^([A-Z])/, (c) => c.toLowerCase()),
  );
}

const TS_MIRROR = "src/lib/agent-protocol.ts";

function tsUnion(): string[] {
  const src = readFileSync(join(REPO, TS_MIRROR), "utf8");
  // **A lookahead, not a consumed delimiter.** `([\s\S]*?)";\n` leaves the last
  // member's closing quote in the delimiter, so the member scan below never sees it
  // and silently drops one member; and a `;` at the end of a doc-comment line
  // terminates the capture early. `(?=";\n)` fixes the first, and this file's own
  // `SettingRejection` entry has the second, so both unions use this shape.
  // **The capture ENDS WITH the closing quote** and a lookahead takes the semicolon.
  // Both halves are load-bearing: `([\s\S]*?)";\n` consumes that quote and drops the
  // last member, and `([\s\S]*?);\n` terminates early on any doc-comment line that
  // ends with a semicolon, which this file's own `SettingRejection` entry has.
  const body = /export type SettingRejection =([\s\S]*?")(?=;\n)/.exec(src);
  if (body === null) throw new Error(`SettingRejection union not found in ${TS_MIRROR}`);
  return [...body[1].matchAll(/"([a-zA-Z0-9]+)"/g)].map((m) => m[1]);
}

/** The catalog keys the review screen can resolve for a refused setting. */
function catalogKeys(): string[] {
  const cat = JSON.parse(
    readFileSync(join(REPO, "locales/en/common.json"), "utf8"),
  ) as { agent: { review: { refusedSetting: Record<string, string> } } };
  return Object.keys(cat.agent.review.refusedSetting);
}

describe("the SettingRejection mirror", () => {
  it("finds variants at all, so a rename cannot make this test vacuous", () => {
    expect(rustVariants().length).toBeGreaterThanOrEqual(7);
    expect(tsUnion().length).toBeGreaterThanOrEqual(7);
    expect(catalogKeys().length).toBeGreaterThanOrEqual(7);
  });

  it("has the same members in Rust and in the TypeScript union", () => {
    expect([...tsUnion()].sort()).toEqual([...rustVariants()].sort());
  });

  it("has a catalog sentence for every variant", () => {
    expect([...catalogKeys()].sort()).toEqual([...rustVariants()].sort());
  });

  it("has no catalog entry for a variant that no longer exists", () => {
    const rust = new Set(rustVariants());
    expect(catalogKeys().filter((k) => !rust.has(k))).toEqual([]);
  });
});
