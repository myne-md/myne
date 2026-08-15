// The provider failure taxonomy on the TS side (ai-remote-providers task 7).
//
// Two things are checked here that nothing else can:
//
//   1. **Each cause resolves to a DIFFERENT message.** The issue asks for
//      "three distinct states, not one", and a per-cause assertion would pass
//      even if two of them rendered the same sentence. Distinctness is asserted
//      pairwise, over the catalog's real values.
//   2. **Every key `providerErrorKey` can return actually exists.**
//      `scripts/check-i18n.mjs` only sees static `t("…")` call sites, and these
//      keys are *returned as strings* for a caller to translate — so the guard
//      is blind to them by construction. This spec is the binding.
//
// The taxonomy binding in the other direction — "no Rust cause is silently
// collapsed into the catch-all" — lives in `engineErrorTaxonomy.test.ts`, which
// parses the variants out of the Rust source.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  normalizeProviderError,
  providerErrorKey,
  type ProviderErrorCause,
} from "../../src/lib/engine-error";

const CATALOG = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../locales/en/common.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, unknown>;

/** Resolve a dotted key against the catalog, or `undefined`. */
function lookup(key: string): string | undefined {
  let node: unknown = CATALOG;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

const ALL: ProviderErrorCause[] = [
  "no_credential",
  "unauthorized",
  "quota_exhausted",
  "policy_refused",
  "unreachable",
  "refused",
  "timeout",
  "barred",
  "empty_completion",
  "local_model_missing",
  "not_ready",
  "failed",
];

describe("provider failure causes", () => {
  it("maps both wire spellings of every variant", () => {
    // Tauri serializes a unit variant as its identifier; `kind()` emits
    // snake_case. A seam that maps only one silently reports the catch-all for
    // the other — the bug this pairing exists to prevent.
    const pairs: [string, string, ProviderErrorCause][] = [
      ["NoCredential", "no_credential", "no_credential"],
      ["Unauthorized", "unauthorized", "unauthorized"],
      ["QuotaExhausted", "quota_exhausted", "quota_exhausted"],
      ["Unreachable", "unreachable", "unreachable"],
      ["Refused", "refused", "refused"],
      ["Timeout", "timeout", "timeout"],
      ["RemoteBarred", "remote_barred", "barred"],
      // myne#466 — four causes that had no entry at all and therefore reached
      // the user as the same sentence, one of which ("nothing was sent again")
      // was untrue for the first of them.
      ["PolicyRefused", "policy_refused", "policy_refused"],
      ["EmptyCompletion", "empty_completion", "empty_completion"],
      ["LocalModelMissing", "local_model_missing", "local_model_missing"],
      ["NotReady", "not_ready", "not_ready"],
    ];
    for (const [variant, tag, expected] of pairs) {
      expect(normalizeProviderError(variant)).toBe(expected);
      expect(normalizeProviderError(tag)).toBe(expected);
      // …and the `{ kind }` object shape the IPC layer also produces.
      expect(normalizeProviderError({ kind: tag })).toBe(expected);
    }
  });

  it("falls back rather than throwing on anything unrecognized", () => {
    // Including a variant a NEWER host knows and this build does not — a
    // surface that crashes on an unknown error is strictly worse than one that
    // says "it did not work".
    for (const junk of [
      "SomeFutureVariant",
      "",
      null,
      undefined,
      42,
      {},
      { kind: 7 },
      [],
    ]) {
      expect(normalizeProviderError(junk)).toBe("failed");
    }
  });

  it("gives every cause a key that exists in the catalog", () => {
    for (const cause of ALL) {
      const key = providerErrorKey(cause);
      expect(lookup(key), `missing catalog entry for ${key}`).toBeTruthy();
    }
  });

  it("renders a DIFFERENT message for every cause", () => {
    const messages = ALL.map((c) => lookup(providerErrorKey(c)));
    expect(new Set(messages).size).toBe(ALL.length);
  });

  it("tells 'no key' and 'wrong key' apart in the words the user reads", () => {
    // The distinction the whole variant split exists for: someone who has
    // never entered a key must not be told to check the one they do not have.
    const none = lookup(providerErrorKey("no_credential"))!;
    const bad = lookup(providerErrorKey("unauthorized"))!;
    expect(none).not.toBe(bad);
    expect(none.toLowerCase()).toContain("add");
    expect(bad.toLowerCase()).toContain("replace");
  });

  it("does not tell the user to retry a quota failure", () => {
    // The fix is on the provider's side. "Try again" is the wrong instruction
    // and, on a metered API, an expensive one.
    const quota = lookup(providerErrorKey("quota_exhausted"))!.toLowerCase();
    expect(quota).not.toContain("try again");
    expect(quota).toContain("provider");
  });

  it("carries no provider content in any message", () => {
    // Every string is fixed human-written copy — no interpolation site exists,
    // so a provider's response body cannot reach the UI through this path.
    for (const cause of ALL) {
      const msg = lookup(providerErrorKey(cause))!;
      expect(msg).not.toContain("{{");
    }
  });
});
