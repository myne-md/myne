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
// UI bug cannot strand recovery. The command is one-way and re-keys the whole
// vault; the pre-migration vault survives in a device-local `legacy/` snapshot
// until the user confirms (a later step).

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
    | "Crypto";
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
