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

import i18n from "../i18n";
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
        title: i18n.t("vaultCreation.errors.invalidPassword.title"),
        body: i18n.t("vaultCreation.errors.invalidPassword.body"),
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "PasswordTooShort":
      // Client-side validation gates the submit before this can fire.
      return {
        title: i18n.t("vaultCreation.errors.passwordTooShort.title"),
        body: i18n.t("vaultCreation.errors.passwordTooShort.body"),
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "KdfFailure":
      return {
        title: i18n.t("vaultCreation.errors.kdfFailure.title"),
        body: i18n.t("vaultCreation.errors.kdfFailure.body"),
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "AeadFailure":
      // Defensive — should not fire during creation, only during unlock.
      return {
        title: i18n.t("vaultCreation.errors.aeadFailure.title"),
        body: i18n.t("vaultCreation.errors.aeadFailure.body"),
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "InvalidVaultMeta":
      // Defensive — backend just built the meta we'd be parsing.
      return {
        title: i18n.t("vaultCreation.errors.invalidVaultMeta.title"),
        body: i18n.t("vaultCreation.errors.invalidVaultMeta.body"),
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "AccountNumberInvalid":
      // Not reached during creation (account number is generated, not parsed).
      return {
        title: i18n.t("vaultCreation.errors.accountNumberInvalid.title"),
        body: i18n.t("vaultCreation.errors.accountNumberInvalid.body"),
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "Csprng":
      return {
        title: i18n.t("vaultCreation.errors.csprng.title"),
        body: i18n.t("vaultCreation.errors.csprng.body"),
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "PlaintextTooLarge":
      // Not reachable from creation (nothing large is encoded here), but an
      // UNMAPPED variant does not degrade — `assertNever` throws, inside this
      // flow's own catch, and the user is stranded on the exit-less
      // "Encrypting…" screen. Every variant gets an arm for that reason
      // alone (myne#289).
      return {
        title: i18n.t("vaultCreation.errors.plaintextTooLarge.title"),
        body: i18n.t("vaultCreation.errors.plaintextTooLarge.body"),
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
        title: i18n.t("vaultCreation.errors.permissionDenied.title"),
        body: i18n.t("vaultCreation.errors.permissionDenied.body"),
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "NoSpace":
      return {
        title: i18n.t("vaultCreation.errors.noSpace.title"),
        body: i18n.t("vaultCreation.errors.noSpace.body"),
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "NotFound":
      return {
        title: i18n.t("vaultCreation.errors.notFound.title"),
        body: i18n.t("vaultCreation.errors.notFound.body"),
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "Other":
      return {
        title: i18n.t("vaultCreation.errors.ioOther.title"),
        body: i18n.t("vaultCreation.errors.ioOther.body"),
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
        title: i18n.t("vaultCreation.errors.sessionNotFound.title"),
        body: i18n.t("vaultCreation.errors.sessionNotFound.body"),
        primaryAction: "restart",
        displayMode: "dedicated",
      };
    case "SessionExpired":
      return {
        title: i18n.t("vaultCreation.errors.sessionExpired.title"),
        body: i18n.t("vaultCreation.errors.sessionExpired.body"),
        primaryAction: "restart",
        displayMode: "dedicated",
      };
    case "TooManyConcurrentSessions":
      return {
        title: i18n.t("vaultCreation.errors.tooManyConcurrentSessions.title"),
        body: i18n.t("vaultCreation.errors.tooManyConcurrentSessions.body"),
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "JoinFailure":
      return {
        title: i18n.t("vaultCreation.errors.joinFailure.title"),
        body: i18n.t("vaultCreation.errors.joinFailure.body"),
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
        title: i18n.t("vaultCreation.errors.vaultArtifactsPresent.title"),
        body: i18n.t("vaultCreation.errors.vaultArtifactsPresent.body"),
        primaryAction: "restart",
        displayMode: "dedicated",
      };
    case "VaultBusyAuth":
      // MYND-159: `commit` now shares the `auth_permits` mutex with the
      // other vault.meta-lifecycle commands. Normally unreachable in the
      // create flow (no concurrent peer at creation time); only fires
      // against a racing `vault_repair` sweep. A plain retry clears it —
      // the racing op finishes in milliseconds and releases the permit.
      return {
        title: i18n.t("vaultCreation.errors.vaultBusyAuth.title"),
        body: i18n.t("vaultCreation.errors.vaultBusyAuth.body"),
        primaryAction: "retry",
        displayMode: "inline",
      };
    case "WeakNewPassword":
      // myne#289 — the variant the mirror had drifted past. `assertNever`
      // THROWS, and it throws inside the creation flow's own catch, so the
      // absence was not "an unhelpful message" but a hard hang on a screen with
      // no Cancel, no Back and no retry.
      //
      // The backend counts Unicode SCALARS while the form counted UTF-16 code
      // units, so any password of >= 12 units but < 12 scalars — one emoji
      // appended to a ten-character password is enough — passed the form and was
      // refused by the host. The form counts scalars now too, so this is
      // unreachable from the UI; it stays mapped because a direct-IPC caller can
      // still produce it, and because an unmapped variant is a hang.
      return {
        title: i18n.t("vaultCreation.errors.passwordTooShort.title"),
        body: i18n.t("vaultCreation.errors.passwordTooShort.body"),
        primaryAction: "retry",
        displayMode: "inline",
      };
    default:
      return assertNever(error);
  }
}
