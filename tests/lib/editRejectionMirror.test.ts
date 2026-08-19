// `EditRejection` is mirrored by hand into TypeScript and into the catalog, and
// nothing checked either half (myne-md/myne#531 review round four).
//
// The Rust enum is `#[serde(rename_all = "camelCase")]`, so a variant crosses
// IPC as a camelCase string. Two hand-written copies consume it:
//
//   1. the `EditRejection` union in `src/lib/agent-run.ts`, and
//   2. an `agent.review.refused.<reason>` entry in `locales/en/common.json`.
//
// **The catalog half is invisible to every existing guard.** `AgentReview`
// builds the key DYNAMICALLY — `t(`agent.review.refused.${r.reason}`)` — and
// `check-i18n.mjs` scans static `t("…")` literals, by design: a comment-aware or
// expression-aware scanner is a scanner with a bypass. So a missing key is not a
// build error, not a lint, and not a failing i18n check. It is a user staring at
// the string `agent.review.refused.excludedNow` where a sentence should be.
//
// That is not hypothetical: `ExcludedNow` was added to the Rust enum in
// `4f0d9675` and reached neither copy, and the review is what found it rather
// than any check in this repository.
//
// Same shape as `passwordFloorMirror.test.ts`, and for the same reason: the
// duplication is legitimate (an enum cannot be shared across the language
// boundary), so what has to be pinned is that the copies agree.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The `EditRejection` variants, read out of the Rust source and camelCased the
 *  way `#[serde(rename_all = "camelCase")]` does. */
function rustVariants(): string[] {
  const src = readFileSync(
    join(REPO, "core/src/plugins/agent/error.rs"),
    "utf8",
  );
  const body = /pub enum EditRejection \{([\s\S]*?)\n\}/.exec(src);
  if (body === null) {
    throw new Error(
      "EditRejection not found in core/src/plugins/agent/error.rs — if it moved, " +
        "this test has to follow it rather than be deleted",
    );
  }
  // Variant lines only: four-space indent, an identifier, a comma. Doc comments
  // and attributes are skipped by the shape rather than by stripping, so a
  // `#[serde(rename = …)]` on a variant would break this loudly instead of
  // silently producing the wrong name.
  return [...body[1].matchAll(/^ {4}([A-Z][A-Za-z0-9]*),$/gm)].map((m) =>
    m[1].replace(/^([A-Z])/, (c) => c.toLowerCase()),
  );
}

/** The members of the `EditRejection` union in the TS mirror. */
function tsUnion(): string[] {
  const src = readFileSync(join(REPO, "src/lib/agent-run.ts"), "utf8");
  const body = /export type EditRejection =([\s\S]*?);\n/.exec(src);
  if (body === null) throw new Error("EditRejection union not found in src/lib/agent-run.ts");
  return [...body[1].matchAll(/"([a-zA-Z0-9]+)"/g)].map((m) => m[1]);
}

/** The catalog keys the review screen can resolve. */
function catalogKeys(): string[] {
  const cat = JSON.parse(
    readFileSync(join(REPO, "locales/en/common.json"), "utf8"),
  ) as { agent: { review: { refused: Record<string, string> } } };
  return Object.keys(cat.agent.review.refused);
}

describe("the EditRejection mirror", () => {
  it("finds variants at all, so a rename cannot make this test vacuous", () => {
    // Every assertion below compares sets. Two empty sets are equal, so a regex
    // that stopped matching would turn this whole file green while checking
    // nothing. The floor is the guard against that.
    expect(rustVariants().length).toBeGreaterThanOrEqual(10);
    expect(tsUnion().length).toBeGreaterThanOrEqual(10);
    expect(catalogKeys().length).toBeGreaterThanOrEqual(10);
  });

  it("has the same members in Rust and in the TypeScript union", () => {
    expect([...tsUnion()].sort()).toEqual([...rustVariants()].sort());
  });

  it("has a catalog sentence for every variant", () => {
    // The half no guard sees. A missing key renders as the raw key string on
    // the review screen, in the one place the user is being asked to trust what
    // the host refused and why.
    expect([...catalogKeys()].sort()).toEqual([...rustVariants()].sort());
  });

  it("has no catalog entry for a variant that no longer exists", () => {
    // The other direction. A stale sentence is not user-visible, so nothing
    // would ever report it, and it reads as coverage for a refusal the host can
    // no longer produce.
    const rust = new Set(rustVariants());
    expect(catalogKeys().filter((k) => !rust.has(k))).toEqual([]);
  });
});
