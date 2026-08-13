// Tauri IPC wrapper for the `vault-migrate` plugin's `vault_migrate` command
// (automerge-sync-migration #420) — the whole-vault v0.1 → v0.2 (MYV1 → NTV5)
// migration (`protocol.md` §10.4.1).
//
// Desktop-only: the web client joins an already-current account over sync and
// never migrates a vault (the command is `Class::Unsupported` in the web
// capability table, the same posture as `vault-creation`/`vault-recover`).
//
// The **recovery phrase is required and verified backend-side** — a wrong or
// missing phrase rejects with `RecoveryPhraseRequired` and writes nothing, so a
// UI bug cannot strand recovery. The command re-keys the whole vault, and the
// pre-migration vault survives in a device-local `legacy/` snapshot until the
// user settles it: `abortMigration` puts the v0.1 vault back byte-for-byte
// (pre-sync only), `confirmMigration` crypto-erases the old `root_key`
// (`protocol.md` §10.4.1 point 5, myne-md/myne#430). Until one of those runs,
// rotating the master password does NOT revoke access to the staged notes —
// `vault_change_password` rewrites `<vault>/vault.meta` only — and the recovery
// phrase can never be rotated at all.

import { invoke } from "../platform/core";

/** What the migration re-encrypted (mirrors the Rust `OnDiskMigrationSummary`). */
export interface VaultMigrateSummary {
  /** Notes re-encrypted `MY01` → `NC05`. */
  notes_migrated: number;
  /** KEK-envelope singletons (themes/dictionary) re-sealed to their `MY?5` family. */
  singletons_migrated: number;
}

/** Closed error union mirroring the Rust `VaultMigrateError` (`#[serde(tag="kind")]`). */
export type VaultMigrateError = {
  kind:
    | "Io"
    | "InvalidVaultMeta"
    | "InvalidCredentialOrVault"
    | "RecoveryPhraseRequired"
    | "AlreadyMigrated"
    | "Csprng"
    | "Crypto"
    // Another auth-pipeline operation is in flight (myne-md/myne#434). Reject,
    // never queue — the same posture change-password, backup and quick-unlock
    // enrolment already take.
    | "AuthOperationInProgress";
};

/** Type guard for the `RecoveryPhraseRequired` gate (the load-bearing refusal). */
export function isRecoveryPhraseRequired(e: unknown): e is VaultMigrateError {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { kind?: unknown }).kind === "RecoveryPhraseRequired"
  );
}

/** True if the vault is already migrated (`vault.meta` is `NTV5`). */
export function isAlreadyMigrated(e: unknown): e is VaultMigrateError {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { kind?: unknown }).kind === "AlreadyMigrated"
  );
}

/**
 * Migrate the active vault from v0.1 to v0.2.
 *
 * Verifies `password` AND requires a valid `recoveryPhrase` (the backend gate),
 * then mints a new v0.2 `root_key`, re-encrypts every note `MY01` → `NC05` and
 * the KEK singletons under the new keys, stages a device-local `legacy/`
 * snapshot, and writes `NTV5` `vault.meta` LAST as the atomic commit point.
 * Rejects with a {@link VaultMigrateError} (`RecoveryPhraseRequired` for a
 * missing/wrong phrase; `InvalidCredentialOrVault` for a wrong password;
 * `AlreadyMigrated` if the vault is already `NTV5`).
 */
export async function migrateVault(
  password: string,
  recoveryPhrase: string,
): Promise<VaultMigrateSummary> {
  return invoke<VaultMigrateSummary>("plugin:vault-migrate|vault_migrate", {
    password,
    phrase: recoveryPhrase,
  });
}

/** Closed error union mirroring the Rust `MigrationSettleError`. */
export type MigrationSettleError = {
  kind: "Io" | "NothingToSettle" | "AlreadySynced" | "AuthOperationInProgress";
};

/** Mirrors the Rust `MigrationSettleStatus`. */
export interface MigrationSettleStatus {
  /** A `legacy/` snapshot is present and the migration is not settled. */
  pending: boolean;
  /** Abort is still available (pre-sync). */
  can_abort: boolean;
  /**
   * This vault is still v0.1, so the upgrade is offerable. False for a vault
   * that is already v0.2 — migrated or born that way (`decisions.md`
   * 2026-08-13), which is every vault created today.
   */
  offerable: boolean;
}

/**
 * Is there an unsettled migration on this vault?
 *
 * Read-only. Probing by calling {@link confirmMigration} and reading its
 * `NothingToSettle` would erase the very thing being probed for.
 */
export async function migrationSettleStatus(): Promise<MigrationSettleStatus> {
  return invoke<MigrationSettleStatus>("plugin:vault-migrate|vault_migrate_settle_status");
}

/**
 * Restore the byte-identical pre-migration v0.1 vault from `legacy/`.
 *
 * Rejects with `AlreadySynced` once the re-based vault head has landed on the
 * server: the peers have adopted the v0.2 generation by then, and rolling back
 * locally would fork this device away from them. Locks the vault on success —
 * a re-key in either direction is a re-unlock event.
 */
export async function abortMigration(): Promise<void> {
  return invoke<void>("plugin:vault-migrate|vault_migrate_abort");
}

/**
 * Crypto-erase the pre-migration vault: `legacy/` holds the ONLY remaining copy
 * of the old `root_key`. Irreversible — after it the migration is settled.
 */
export async function confirmMigration(): Promise<void> {
  return invoke<void>("plugin:vault-migrate|vault_migrate_confirm");
}

/** Mirrors the Rust `MigrationProgress` (counts only — no percentage, no ETA). */
export interface MigrationProgress {
  done: number;
  total: number;
  generation: number;
  active: boolean;
}

/**
 * Read the running migration's per-blob progress (`protocol.md` §10.4.1 point 2).
 *
 * Counts, deliberately. The migration's cost is dominated by four Argon2id
 * derivations at `m=256 MiB, t=3` that run BEFORE the counted loop and vary by
 * an order of magnitude across machines, so any ETA derived from note throughput
 * would be wrong by that whole prefix.
 */
export async function migrationProgress(): Promise<MigrationProgress> {
  return invoke<MigrationProgress>("plugin:vault-migrate|vault_migrate_progress");
}
