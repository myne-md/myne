// Hand-mirrored from the Rust enum. Keep in sync in the same change:
//   - src-tauri/src/io_failure_kind.rs                   (IoFailureKind)
//   - src-tauri/src/plugins/vault_repair/error.rs        (VaultRepairError)

import type { IoFailureKind } from "./vault-unlock-error";

/**
 * Single error type returned across the IPC boundary by the `vault-repair`
 * plugin's `vault_residue_scan` / `vault_repair` commands (MYND-159).
 *
 * Wire shape: `#[serde(tag = "kind", content = "detail")]` — payload-carrying
 * variants nest as `{"kind": "<Outer>", "detail": <inner>}`; unit variants
 * serialize as `{"kind": "<VariantName>"}` only.
 */
export type VaultRepairError =
  /** Another vault.meta-lifecycle op holds the capacity-1 `auth_permits`
   *  semaphore (try_acquire, never queued). UI/router bug indicator. */
  | { kind: "VaultBusyAuth" }
  /** A live vault is present (`vault.meta` byte-present, or a non-Empty slot).
   *  vault_delete's typed-DELETE-gated territory — the load-bearing safety
   *  property that keeps repair from ever nuking a real vault. */
  | { kind: "VaultPresent" }
  /** Slot Empty + no vault.meta + no residue — nothing to repair (returned, not
   *  silent-success, so a stray invoke surfaces loudly). */
  | { kind: "NothingToRepair" }
  /** One or more residue entries could not be removed (file lock, permission).
   *  `remaining_count` is the failure count only — never per-file paths. */
  | { kind: "PartialDelete"; detail: { remaining_count: number } }
  /** Filesystem / path-resolution failure outside the per-file sweep loop. */
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } };
