// AppError → user-facing message mapping for the vault-creation flow.
//
// Implements the design session decisions in
// agent-tooling/sessions/design/2026-04-28-vault-creation-frontend.md (Q7).
//
// Display strategy is hibrit: SessionExpired and SessionNotFound route to
// <SessionLostStep> (dedicated screen, "Start over" → RESET); everything
// else renders as an inline banner on the source step (PasswordStep for
// BEGIN_ERR, AccountStep for COMMIT_ERR) with retry semantics.
//
// The exhaustive switch + assertNever default arm makes adding a new
// AppError or ProtocolError variant a compile error here — drift between
// backend Rust enums and this frontend mapping is structurally caught.
//
// No console.log of error contents anywhere in this module — `kind`
// discriminator is logged at the call site (orchestrator) only.

import type { AppError, ProtocolError, IoErrorKind } from "../types/protocol-error";
import type { ErrorState } from "../screens/vault-creation";

function assertNever(x: never): never {
  throw new Error(`Unhandled error variant: ${JSON.stringify(x)}`);
}

function mapProtocolError(error: ProtocolError): ErrorState {
  switch (error.kind) {
    case "InvalidPassword":
      // Not reached during creation (no verification step before commit);
      // defensive entry kept so the exhaustive switch covers the variant.
      return {
        title: "Invalid password",
        body: "Try again.",
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "PasswordTooShort":
      // Client-side validation gates the submit before this can fire.
      return {
        title: "Password too short",
        body: "Use at least 12 characters.",
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "KdfFailure":
      return {
        title: "Couldn't set up encryption",
        body: "Try again. If this keeps happening, your system may be low on memory.",
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "AeadFailure":
      // Defensive — should not fire during creation, only during unlock.
      return {
        title: "Encryption failed",
        body: "Try again.",
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "InvalidVaultMeta":
      // Defensive — backend just built the meta we'd be parsing.
      return {
        title: "Vault format error",
        body: "Try again.",
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "AccountNumberInvalid":
      // Not reached during creation (account number is generated, not parsed).
      return {
        title: "Account number invalid",
        body: "Try again.",
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "Csprng":
      return {
        title: "Couldn't generate secure random data",
        body: "Try again.",
        primaryAction: "retry",
        displayMode: "inline",
      };
    default:
      return assertNever(error);
  }
}

function mapIoError(error: IoErrorKind): ErrorState {
  switch (error.kind) {
    case "PermissionDenied":
      return {
        title: "Couldn't write to vault folder",
        body: "Make sure Myne has permission to write to your application data folder.",
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "NoSpace":
      return {
        title: "Not enough disk space",
        body: "Free up disk space and try again.",
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "NotFound":
      return {
        title: "Vault folder missing",
        body: "Try again.",
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "Other":
      return {
        title: "Couldn't save the vault",
        body: "Try again.",
        primaryAction: "retry",
        displayMode: "inline",
      };
    default:
      return assertNever(error);
  }
}

/**
 * Map a backend AppError to a UI-renderable message.
 *
 * The mapping is exhaustive over every AppError variant; adding a new
 * variant on the backend without updating this switch is a TypeScript
 * compile error here.
 *
 * SessionExpired + SessionNotFound get displayMode "dedicated" and
 * primaryAction "restart" — they route to <SessionLostStep>. All other
 * variants render as an inline banner on the source step with a retry
 * primary action.
 */
export function mapAppErrorToUserMessage(error: AppError): ErrorState {
  switch (error.kind) {
    case "Protocol":
      return mapProtocolError(error.detail);
    case "SessionNotFound":
      return {
        title: "Session not found",
        body: "Start over from the beginning.",
        primaryAction: "restart",
        displayMode: "dedicated",
      };
    case "SessionExpired":
      return {
        title: "Session expired",
        body: "For your security, vault creation times out after 10 minutes. Start over.",
        primaryAction: "restart",
        displayMode: "dedicated",
      };
    case "TooManyConcurrentSessions":
      return {
        title: "Too many vault creations at once",
        body: "Close other Myne windows and try again.",
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "JoinFailure":
      return {
        title: "Something went wrong",
        body: "Try again.",
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "Io":
      return mapIoError(error.detail);
    case "VaultArtifactsPresent":
      // Defensive: this path should never be reached in normal flow —
      // the `vault_status` startup probe + frontend state machine
      // route returning users straight to unlock when a vault is
      // present, keeping them out of the create flow entirely. If a
      // real user sees this, either (a) the frontend routing has
      // bypassed those guards (regression bug, not a user-facing
      // condition; the alternative — letting the backend silently
      // overwrite the prior vault.meta — would destroy the prior
      // root_key / recovery phrase / sealed `.myn` blobs
      // irrecoverably, which is why the backend rejects rather than
      // swallows), or (b) a prior `vault_delete` partial-fail left
      // orphan artefacts. UI copy intentionally does NOT reference
      // v0.2 `vault_repair` (no vaporware per PRODUCT.md design
      // principle 3); the "restart and unlock" path covers case (a)
      // which is by far the most likely if this ever surfaces in
      // production. See `app-state-machine` PRD + grill Q12
      // (original) + MYND-105 PRD + grill Q7 (semantic broadening).
      // Renamed from VaultAlreadyExists on 2026-05-26.
      return {
        title: "Vault already exists",
        body: "A new vault cannot be created because vault data already exists on this device. Close the app and restart — the startup screen will route you to the unlock flow.",
        primaryAction: "restart",
        displayMode: "dedicated",
      };
    default:
      return assertNever(error);
  }
}
