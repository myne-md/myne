// Named, composable fixtures for the story catalogue (myne-md/myne#832).
//
// A fixture is the canned `invoke` data that makes a state reachable. Situations
// that recur (no vault, locked, unlocked, sync paused) live here once and are
// referenced by name from a story descriptor, so two stories in the same
// situation share one handler table rather than duplicating it.
//
// Everything here is SYNTHETIC. No fixture may carry a recovery phrase or a real
// account number; `tests/stories/fixtures.test.ts` rejects both, and
// `scripts/check-stories-bundle.mjs` re-checks the built bundle for the same pair
// (a hand-authored fixture is exactly how a secret would reach a served page).

import type { Fixture } from "../src/types";
import type { VaultSummary } from "@app/types/vault-summary";

/** A vault id that is obviously a fixture, never a real one. */
export const FIXTURE_VAULT_ID = "00000000-0000-7000-8000-000000000001";

function vault(overrides: Partial<VaultSummary> = {}): VaultSummary {
  return {
    id: FIXTURE_VAULT_ID,
    status: { kind: "Exists" },
    label: null,
    icon: null,
    last_unlock: null,
    ...overrides,
  };
}

/** Builds a fixture whose `vault_list` / `vault_slot_kind` answer with one vault. */
function withVault(slot: string, prefs: Record<string, unknown> = {}): Fixture {
  return {
    description: `one vault on disk, runtime slot "${slot}"`,
    handlers: {
      "plugin:vault-unlock|vault_list": () => [vault()],
      "plugin:vault-unlock|vault_slot_kind": () => slot,
      "plugin:prefs|prefs_read": () => prefs,
    },
  };
}

/** No vault on disk at all: the first-run / welcome situation. */
export const NO_VAULT: Fixture = {
  description: "no vault on disk",
  handlers: {
    "plugin:vault-unlock|vault_list": () => [],
    "plugin:vault-unlock|vault_slot_kind": () => "Empty",
    "plugin:prefs|prefs_read": () => ({}),
  },
};

/** One vault on disk, locked: the unlock situation. */
export const LOCKED: Fixture = withVault("Empty");

/** One vault, unlocked, default prefs: the editor situation. */
export const UNLOCKED: Fixture = withVault("Unlocked");

/** One vault on disk whose `vault.meta` does not parse. */
export const CORRUPT_META: Fixture = {
  description: "one vault on disk whose vault.meta is unreadable",
  handlers: {
    "plugin:vault-unlock|vault_list": () => [vault({ status: { kind: "Corrupted" } })],
    "plugin:vault-unlock|vault_slot_kind": () => "Empty",
    "plugin:prefs|prefs_read": () => ({}),
  },
};

/** Every named fixture, keyed by the name a story references. */
export const FIXTURES: Record<string, Fixture> = {
  "no-vault": NO_VAULT,
  locked: LOCKED,
  unlocked: UNLOCKED,
  "corrupt-meta": CORRUPT_META,
};

/** Resolve a story's `fixture` field (a name or an inline fixture) to a fixture. */
export function resolveFixture(
  fixture: string | Fixture | undefined,
): Fixture | undefined {
  if (fixture === undefined) return undefined;
  if (typeof fixture === "string") {
    const named = FIXTURES[fixture];
    if (!named) {
      throw new Error(
        `Unknown fixture "${fixture}". Known fixtures: ${Object.keys(FIXTURES).join(", ")}.`,
      );
    }
    return named;
  }
  return fixture;
}
