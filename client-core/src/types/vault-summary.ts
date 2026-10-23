// TypeScript mirror of the Rust vault_list IPC contract (SYNC-4).
//
// Source-of-truth Rust definitions:
//   - src-tauri/src/plugins/vault_unlock/commands.rs
//       (VaultSummary struct + VaultSummaryStatus enum + vault_list command)
//   - src-tauri/src/plugins/vault_unlock/error.rs   (VaultStatusError enum)
//
// `vault_list` is the multi-vault generalization of `vault_status`: where
// `vault_status` probes the single legacy vault.meta, `vault_list` enumerates
// every `vaults/<id>/` directory the disk-scan finds and returns one
// VaultSummary per vault.
//
// TODO(Phase-1-end): Replace this hand-written file with `ts-rs` codegen
// + CI drift check, same as the eventual replacement plan for
// `protocol-error.ts` / `vault-status.ts`.

// One declaration, not two, see the sibling note in `vault-status.ts`.
import type { IoFailureKind } from "./vault-unlock-error";

/**
 * Coarse on-disk health of a discovered vault, the IPC-facing twin of the
 * Rust `DiscoveredVault.well_formed` flag. Mirrors the Rust enum 1:1.
 *
 * - `Exists`: the `vaults/<id>/` directory carries a readable `vault.meta`.
 * - `Corrupted`: the directory parses as a VaultId but its `vault.meta` is
 *   missing or unreadable. Surfaced (so a picker can show it distinctly),
 *   never dropped.
 *
 * No `Missing` arm (unlike `VaultStatus`): a vault absent from disk is simply
 * not in the returned list.
 *
 * Wire shape: `#[serde(tag = "kind")]`, so an object with a `kind` field.
 */
export type VaultSummaryStatus = { kind: "Exists" } | { kind: "Corrupted" };

/**
 * One entry in the `vault_list` result, the DENY-list-clean projection of a
 * discovered vault. Mirrors the Rust `VaultSummary` struct 1:1.
 *
 * - `id`: the VaultId rendered as its canonical 36-char lowercase-hyphenated
 *   string (a random UUIDv7, decoupled from `account_number_hash`).
 * - `status`: `Exists | Corrupted`.
 * - `label`: `Some` ONLY for a this-session-unlocked vault (its label
 *   decrypted from `vault.prefs` into a RAM cache). Until the RAM label cache
 *   lands (sub-feature 4) this is **always `null`**, the picker shows a
 *   neutral fallback ("Vault N") for never-unlocked-this-session vaults.
 * - `icon`: the curated switcher glyph name (vault-icons), `Some` ONLY for a
 *   this-session-unlocked vault whose `vault.prefs` carries one (RAM icon
 *   cache); `null` otherwise, the switcher renders the neutral "M" wordmark.
 *   Twin of `label`.
 * - `last_unlock`: epoch-ms of the last successful unlock from the registry
 *   cache, or `null` for a vault never unlocked.
 * - `published`: whether the vault is reachable on a sync server
 *   (myne-md/myne#911 task 8). `false` is "device only", which is how a vault is
 *   born. Derived from device-local state plus the `vault.meta` generation byte,
 *   so it is answered while the vault is locked; the namespace it derives from is
 *   deliberately NOT projected (DENY-list), only the boolean.
 *
 * Never carries `account_number_hash` bytes or a filesystem path (DENY-list).
 */
export type VaultSummary = {
  id: string;
  status: VaultSummaryStatus;
  label: string | null;
  icon: string | null;
  last_unlock: number | null;
  published: boolean;
};

/**
 * Error variant returned by `vault_list` on `app_data_dir` resolution
 * failure. Shares the `VaultStatusError` shape (the only failure surface is
 * IO-class). `vault_list` is otherwise infallible, a missing `vaults/` dir
 * yields an empty list, not an error.
 */
export type VaultListError = {
  kind: "IoError";
  detail: { io_error_kind: IoFailureKind };
};

/**
 * Discriminated-union result the lib wrapper returns. The Tauri `invoke` shim
 * throws on Err; the wrapper catches and normalizes both arms so callers can
 * handle both via a single discriminated switch.
 */
export type VaultListResult =
  | { ok: VaultSummary[] }
  | { err: VaultListError };
