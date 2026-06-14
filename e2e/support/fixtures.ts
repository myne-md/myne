// Fixture layer — vault seeding + at-rest fault injection (task 5; SYNC-2).
//
// `seedVaults` runs the `e2e-fixture-gen` workspace crate
// (`e2e/fixture-gen/`), which composes the SAME protocol public API the
// production creation path uses; the generated `vaults/<id>/vault.meta`
// unlocks through the untouched production unlock path. Weak KDF by
// default (params are vault.meta-resident — SYNC-9); production KDF on
// request (the VR-1 drill).
//
// The generator binary is built ONCE per process (memoized `cargo
// build`), then invoked directly — per-seed `cargo run` would re-pay
// cargo startup + the target-dir lock inside test budgets.
//
// Byte-surgery offsets mirror `e2e/fixture-gen/src/lib.rs::offsets`,
// whose tests pin each offset SEMANTICALLY (tampering a field breaks
// exactly that field's unwrap). The generator additionally EMITS its
// offset table in the seed JSON and `seedVaults` verifies this mirror
// against it on every call — a desynced mirror throws instead of
// silently tampering the wrong field.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { REPO_ROOT } from "./session";

export interface SeededVault {
  vaultId: string;
  password: string;
  /** 24 space-joined lowercase BIP-39 words. */
  phrase: string;
  /** 27-char display account number. */
  account: string;
  /** Present only when seeded with `exportSuite: true`. */
  exportSuite?: ExportSuite;
}

/** One attachment of the MYND-116 note-export suite. */
export interface ExportSuiteAttachment {
  /** 64-char lowercase-hex attachment-id (blob filename + embed target). */
  idHex: string;
  /** Catalog display filename — BOTH suite attachments share it, so the
   *  export dedups the second to `"evidence (1).png"`. */
  filename: string;
  /** Exact plaintext file bytes (ASCII by construction). */
  contents: string;
  contentType: string;
}

/** Pre-baked note-export content (`--export-suite`): a note WITHOUT
 *  attachment refs (byte-verbatim export oracle), a note WITH two
 *  colliding-filename form-C embeds, and a note WITH one `.pdf` embed
 *  (the MYND-255 PDF-export exclusion-notice bait) + MYA1 blobs + MYC1
 *  catalog. The plaintexts are the generator's exact written bytes —
 *  in-source scenario content, not credentials. */
export interface ExportSuite {
  plainNoteId: string;
  plainNotePlaintext: string;
  attachmentsNoteId: string;
  attachmentsNotePlaintext: string;
  /** The two image attachments, in first-appearance (= export-naming)
   *  order — the `.pdf` bait rides `pdfAttachment` separately. */
  attachments: ExportSuiteAttachment[];
  /** Note WITH one form-C `.pdf` embed (MYND-255). */
  pdfNoteId: string;
  pdfNotePlaintext: string;
  pdfAttachment: ExportSuiteAttachment;
}

export interface SeedOptions {
  kdf?: "weak" | "production";
  count?: number;
  password?: string;
  /** Lay the MYND-116 note-export suite into every seeded vault. */
  exportSuite?: boolean;
}

/** § 9.3 field offsets in vault.meta — lockstep mirror of
 *  `e2e-fixture-gen::offsets` (Rust tests pin the semantics; the
 *  generator's emitted table is runtime-verified in `seedVaults`). */
export const VAULT_META_OFFSETS = {
  MAGIC: 0,
  ACCOUNT_HASH: 6,
  KDF_PARAMS: 22,
  SALT_PASSWORD: 33,
  SALT_RECOVERY: 49,
  NONCE_PASSWORD_WRAP: 65,
  ENC_ROOT_KEY_PASSWORD: 89,
  NONCE_RECOVERY_WRAP: 153,
  ENC_ROOT_KEY_RECOVERY: 177,
  ITEMS_KEY_ID: 241,
  ITEMS_KEY_NONCE: 257,
  ENC_ITEMS_KEY: 281,
  END: 345,
} as const;

const GENERATOR_BIN = join(REPO_ROOT, "target", "release", "e2e-fixture-gen");
let generatorBuilt = false;

/** Build the generator once per process; later seeds exec the binary
 *  directly (no cargo startup / target-lock cost inside test budgets). */
function ensureGeneratorBuilt(): string {
  if (!generatorBuilt) {
    execFileSync("cargo", ["build", "--quiet", "--release", "-p", "e2e-fixture-gen"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 300_000,
    });
    generatorBuilt = true;
  }
  return GENERATOR_BIN;
}

function verifyOffsetsMirror(emitted: Record<string, number>): void {
  for (const [key, value] of Object.entries(VAULT_META_OFFSETS)) {
    if (emitted[key] !== value) {
      throw new Error(
        `VAULT_META_OFFSETS mirror desync at ${key}: TS=${value}, generator=${emitted[key]}. ` +
          "Update e2e/support/fixtures.ts to match e2e/fixture-gen/src/lib.rs::offsets.",
      );
    }
  }
}

/**
 * Seed `count` unlockable vaults into `appDataDir` (the session's
 * isolated `<XDG_DATA_HOME>/md.myne.desktop`). Call from `launchApp`'s
 * `seed` callback so the layout exists before the app boots.
 */
export function seedVaults(appDataDir: string, opts: SeedOptions = {}): SeededVault[] {
  const bin = ensureGeneratorBuilt();
  const args = [
    "--base",
    appDataDir,
    "--count",
    String(opts.count ?? 1),
    "--kdf",
    opts.kdf ?? "weak",
  ];
  if (opts.password) args.push("--password", opts.password);
  if (opts.exportSuite) args.push("--export-suite");
  let stdout: string;
  try {
    stdout = execFileSync(bin, args, {
      encoding: "utf8",
      // Production-KDF generation runs Argon2id at m=256 MiB ×2 per vault.
      timeout: 300_000,
    });
  } catch (e) {
    // Sanitized rethrow (SYNC-13): the raw error embeds the argv (a
    // caller-supplied --password would land in CI logs) and captured
    // stdout (credential JSON on a timeout-kill window).
    const status = (e as { status?: number | null }).status ?? "signal/timeout";
    throw new Error(`e2e-fixture-gen failed (exit: ${status}); argv/stdout suppressed`);
  }
  const parsed = JSON.parse(stdout) as {
    vaults: SeededVault[];
    offsets: Record<string, number>;
  };
  verifyOffsetsMirror(parsed.offsets);
  return parsed.vaults;
}

/** Single-vault convenience. */
export function seedVault(appDataDir: string, opts: Omit<SeedOptions, "count"> = {}): SeededVault {
  return seedVaults(appDataDir, { ...opts, count: 1 })[0];
}

export function vaultMetaPath(appDataDir: string, vaultId: string): string {
  return join(appDataDir, "vaults", vaultId, "vault.meta");
}

/** XOR one byte at `offset` — the canonical at-rest tamper primitive.
 *  Pick offsets from `VAULT_META_OFFSETS` (e.g. ENC_ROOT_KEY_RECOVERY
 *  for the VR-2 tampered-twin, MAGIC for structural corruption). */
export function tamperVaultMeta(appDataDir: string, vaultId: string, offset: number): void {
  const path = vaultMetaPath(appDataDir, vaultId);
  const bytes = readFileSync(path);
  if (offset < 0 || offset >= bytes.length) {
    throw new Error(`tamper offset ${offset} out of range (len ${bytes.length})`);
  }
  bytes[offset] ^= 0xff;
  writeFileSync(path, bytes);
}

/** Replace vault.meta with random bytes (the "garbage file" class —
 *  lists as Exists, fails closed at submit). */
export function corruptVaultMetaWholesale(appDataDir: string, vaultId: string): void {
  const path = vaultMetaPath(appDataDir, vaultId);
  writeFileSync(path, randomBytes(statSync(path).size));
}

/** Delete vault.meta but leave the dir recognizably a vault (an orphan
 *  `notes/*.myn` blob) — `discover_vaults` then lists it with
 *  `well_formed = false` → `VaultSummaryStatus::Corrupted` → the boot
 *  probe routes to the fail-closed corrupted-vault surface
 *  (`vault_registry.rs::is_well_formed`). */
export function deleteVaultMetaKeepArtifacts(appDataDir: string, vaultId: string): void {
  rmSync(vaultMetaPath(appDataDir, vaultId));
  const notesDir = join(appDataDir, "vaults", vaultId, "notes");
  mkdirSync(notesDir, { recursive: true });
  // Content is irrelevant to discovery — presence of a `.myn` is the
  // artifact signal (`vault_artifacts_present`).
  writeFileSync(join(notesDir, "orphan.myn"), randomBytes(64));
}

/** chmod-based permission fault (Linux-canonical, SYNC-1). Returns an
 *  undo function. Meaningless under root — the harness runs
 *  unprivileged by design. */
export function denyRead(path: string): () => void {
  chmodSync(path, 0o000);
  return () => chmodSync(path, 0o600);
}

/** Lay down a LEGACY single-vault layout (`<appDataDir>/vault/vault.meta`)
 *  for the eager-boot-migration scenario (MYND-127). Seeds via the
 *  generator into a scratch area, then moves the meta into the legacy
 *  location. */
export function seedLegacyVault(
  appDataDir: string,
  opts: Omit<SeedOptions, "count"> = {},
): SeededVault {
  const seeded = seedVault(appDataDir, opts);
  const modern = vaultMetaPath(appDataDir, seeded.vaultId);
  const legacyDir = join(appDataDir, "vault");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, "vault.meta"), readFileSync(modern));
  // Remove the modern layout so ONLY the legacy dir exists pre-boot.
  rmSync(join(appDataDir, "vaults"), { recursive: true, force: true });
  return seeded;
}
