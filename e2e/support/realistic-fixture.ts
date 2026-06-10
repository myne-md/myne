// The epic's realistic production-KDF fixture (SYNC-2; MYND-124 VC-1).
//
// VC-1's one full-production-KDF creation run captures the minted
// credentials + the vault.meta bytes so the unlock/recovery suites can
// exercise a REAL created-by-the-app vault without re-paying creation.
// Lives under the gitignored `e2e/artifacts/` (per-run throwaway
// credentials — same caveat as failure artifacts, docs/dev/e2e.md).
//
// Consumers must stay runnable standalone: `loadRealisticFixture()`
// returns null when VC-1 hasn't run in this checkout, and callers fall
// back to generator-seeded vaults.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seedVault } from "./fixtures";
import { REPO_ROOT } from "./session";

export interface RealisticFixture {
  vaultId: string;
  password: string;
  /** 24 space-joined lowercase BIP-39 words (DOM-scraped at reveal). */
  phrase: string;
  /** 27-char display account number. */
  account: string;
}

const FIXTURE_DIR = join(REPO_ROOT, "e2e", "artifacts", "realistic-fixture");
const FIXTURE_JSON = join(FIXTURE_DIR, "fixture.json");
const FIXTURE_META = join(FIXTURE_DIR, "vault.meta");

/** Persist the captured credentials + the created vault.meta bytes. */
export function saveRealisticFixture(fixture: RealisticFixture, vaultMetaBytes: Buffer): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(FIXTURE_JSON, JSON.stringify(fixture, null, 2));
  writeFileSync(FIXTURE_META, vaultMetaBytes);
}

/** Load the fixture, or null when VC-1 hasn't produced one. */
export function loadRealisticFixture(): (RealisticFixture & { vaultMeta: Buffer }) | null {
  if (!existsSync(FIXTURE_JSON) || !existsSync(FIXTURE_META)) return null;
  const fixture = JSON.parse(readFileSync(FIXTURE_JSON, "utf8")) as RealisticFixture;
  return { ...fixture, vaultMeta: readFileSync(FIXTURE_META) };
}

/** Seed a fixture-captured vault into a session's appDataDir (the
 *  standard `vaults/<id>/` layout) for unlock/recovery scenarios. */
export function seedRealisticVault(
  appDataDir: string,
  fixture: RealisticFixture & { vaultMeta: Buffer },
): void {
  const dir = join(appDataDir, "vaults", fixture.vaultId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "vault.meta"), fixture.vaultMeta);
}

/** The production-KDF seed every unlock/recovery suite wants: the VC-1
 *  realistic fixture when captured, else a generator-seeded
 *  production-KDF vault (standalone runs). Returns the credentials. */
export function seedProductionVault(appDataDir: string): RealisticFixture {
  const realistic = loadRealisticFixture();
  if (realistic) {
    seedRealisticVault(appDataDir, realistic);
    return realistic;
  }
  return seedVault(appDataDir, { kdf: "production" });
}
