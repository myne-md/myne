// TS mirror of the Rust `VaultRepairError` enum
// (`src-tauri/src/plugins/vault_repair/error.rs`, MYND-159).
//
// Wire shape: `#[serde(tag = "kind", content = "detail")]` — unit variants
// serialize as `{"kind": "<Variant>"}`; payload-carrying variants nest as
// `{"kind": "<Variant>", "detail": <inner>}`.
//
// Hand-mirrored (no codegen yet — see `src/AGENTS.md` "Tauri command
// bindings"). Adding a Rust variant without mirroring it here is a drift
// bug the `default: assertNever` in the consumer surfaces at compile time.

import type { IoErrorKind } from "./protocol-error";

/**
 * Single error type rejected across the IPC boundary by the `vault-repair`
 * plugin's `vault_repair` (sweep) command. `vault_residue_scan` (the
 * read-only probe) only ever rejects with the `Io` variant.
 */
export type VaultRepairError =
  /**
   * Another vault.meta-lifecycle op holds the `auth_permits` mutex
   * (MYND-159 pulled `vault_create::commit` into the same permit). A plain
   * retry clears it — the racing op releases in milliseconds. Normally
   * unreachable in the repair flow.
   */
  | { kind: "VaultBusyAuth" }
  /**
   * A live vault is present — `vault.meta` exists on disk (byte-presence,
   * even if corrupt) or the runtime slot is non-Empty. This is
   * `vault_delete`'s typed-DELETE-gated territory, never `vault_repair`'s.
   * The load-bearing safety property: repair structurally cannot touch a
   * vault that still has a `vault.meta`.
   */
  | { kind: "VaultPresent" }
  /**
   * Slot Empty + `vault.meta` absent + no residue — nothing to repair.
   * Surfaced (not silent-success) so a UI bug firing repair on a clean
   * device shows loudly (bug-canary).
   */
  | { kind: "NothingToRepair" }
  /**
   * One or more residue entries could not be removed (a file lock that has
   * not yet released). `remaining_count` is the failure count only — never
   * paths (DENY-list). The UI falls back to the manual-cleanup instruction.
   */
  | { kind: "PartialDelete"; detail: { remaining_count: number } }
  /**
   * File-system / path-resolution failure. `detail.io_error_kind`
   * discriminates the bounded kind.
   */
  | { kind: "Io"; detail: { io_error_kind: IoErrorKind["kind"] } };

/** Narrow to the partial-fail variant (carries `remaining_count`). */
export function isVaultRepairPartial(
  e: VaultRepairError,
): e is { kind: "PartialDelete"; detail: { remaining_count: number } } {
  return e.kind === "PartialDelete";
}
