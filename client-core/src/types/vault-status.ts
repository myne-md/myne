// TypeScript mirror of the Rust vault_status IPC contract.
//
// Source-of-truth Rust definitions:
//   - src-tauri/src/plugins/vault_unlock/commands.rs (VaultStatus enum)
//   - src-tauri/src/plugins/vault_unlock/error.rs   (VaultStatusError enum)
//
// Wire shape: `#[serde(tag = "kind", content = "detail")]` on the error
// type, plain `#[serde(tag = "kind")]` on the OK enum (no payload variants).
//
// TODO(Phase-1-end): Replace this hand-written file with `ts-rs` codegen
// + CI drift check, same as the eventual replacement plan for
// `protocol-error.ts`.

// `IoFailureKind` from its ONE declaration (myne-md/myne#475). It used to come
// from `lib/stage`, which carried a second, separately-worded copy of the same
// four-member union, so this file and its eleven siblings resolved the same
// name to two different declarations, and a variant added to one was invisible
// to the other. The stage module now re-exports this one.
import type { IoFailureKind } from "./vault-unlock-error";

/**
 * Result of `vault_status` Tauri command, boot-time probe of
 * `<app_data_dir>/vault/vault.meta`. Mirrors the Rust enum 1:1.
 *
 * - `Exists`: file parsed cleanly via `protocol::parse_vault_meta`.
 * - `Missing`: file does not exist (`std::io::ErrorKind::NotFound`).
 * - `Corrupted`: file exists but parse_vault_meta rejected it.
 *
 * IO failures (PermissionDenied, NoSpace, Other) surface as
 * `Err(VaultStatusError::IoError { ... })`, NOT `Corrupted`,
 * see `app-state-machine` grilling Q9 β=i.
 */
export type VaultStatus = { kind: "Exists" } | { kind: "Missing" } | { kind: "Corrupted" };

/**
 * Error variant returned by `vault_status` on filesystem failure.
 * `NotFound` is special-cased upstream as `Ok(Missing)`; only
 * PermissionDenied / NoSpace / Other surface here.
 */
export type VaultStatusError = {
  kind: "IoError";
  detail: { io_error_kind: IoFailureKind };
};

/**
 * Discriminated-union result type that the lib wrapper returns.
 * The Tauri `invoke` shim throws on Err; the wrapper catches and
 * normalizes both arms into this single shape so callers can handle
 * both paths via a single discriminated switch.
 */
export type VaultStatusResult =
  | { ok: VaultStatus }
  | { err: VaultStatusError };
