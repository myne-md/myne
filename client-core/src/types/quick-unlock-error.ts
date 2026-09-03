// Manual TS mirror of the Rust `QuickUnlockError` enum
// (`core/src/plugins/quick_unlock/error.rs`, MYND-329, the enum moved to
// `myne-core`; the desktop path is now only a `pub use` re-export).
//
// Same hand-mirror discipline as `vault-unlock-error.ts` (a `ts-rs`
// codegen + CI drift check is the Phase-1-end follow-up). Every variant
// change in the Rust enum must be reflected here in the same change.
//
// Wire shape: the Rust enum derives `#[serde(tag = "kind", content =
// "detail")]`, so each variant serializes as `{ "kind": "<Variant>" }`,
// or `{ "kind": "<Variant>", "detail": <payload> }` for the data-carrying
// ones (`WrongCredential` → `{ remaining }`, `Io` → an `IoFailureKind`
// string).

import type { IoFailureKind } from "./vault-unlock-error";

/** Discriminated union mirroring `QuickUnlockError`. */
export type QuickUnlockError =
  /** Another auth-pipeline op holds the capacity-1 `auth_permits` semaphore
   *  (myne#378). NOT a credential failure: no attempt was burned and the
   *  credential is intact, so the copy is "operation in progress" and the
   *  affordance stays. */
  | { kind: "VaultBusyAuth" }
  | { kind: "NotUnlocked" }
  | { kind: "NotConfigured" }
  | { kind: "RequiresFullPassword" }
  | { kind: "Cancelled" }
  | { kind: "HardwareUnavailable" }
  | { kind: "WrongCredential"; detail: { remaining: number } }
  | { kind: "AttemptsExhausted" }
  | { kind: "PinTooShort" }
  | { kind: "PinNotDigits" }
  | { kind: "InvalidVaultMeta" }
  | { kind: "Io"; detail: IoFailureKind }
  | { kind: "Backend" };

/** Narrowing helper: is this a `QuickUnlockError`-shaped value? */
export function isQuickUnlockError(e: unknown): e is QuickUnlockError {
  return (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    typeof (e as { kind: unknown }).kind === "string"
  );
}
