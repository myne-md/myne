// Vault unlock screen — task 7 of `app-state-machine`, extended with
// recovery-flow entry affordances per `recovery-from-phrase-ui` Task 8
// and the MYND-108-bis lost-credentials cul-de-sac escape.
//
// Mounts when Stage = `unlock`. Two rendering modes driven by
// `initialStatus`:
//   - `Exists`               → normal mode: password form
//   - `Corrupted` / `IoError` → corrupted mode: <FailClosedError />
//
// Normal-mode reducer state machine: `idle` (with optional banner from
// the prior failed attempt — password retained across the
// decrypting → idle bounce) | `decrypting` (input + submit disabled) |
// `recovery-in-progress` (Rust slot is `Recovering`; password form is
// suppressed in favor of an info banner + "Continue" resume CTA;
// CTA dispatches `unlock.resume-recovery` to App.tsx, routing the
// user into recover(password-reset)) | `delete-vault` (MYND-108-bis:
// user clicked the tertiary "Lost both password and recovery phrase?
// Delete vault and start over" link; the password form is replaced
// by `<DeleteVaultConfirmForm>` for the typed-DELETE gate).
//
// `InvalidVaultMeta` mid-attempt switches the component into the same
// fail-closed surface as a boot-time corrupted vault — one-way, no
// return to the form within the session.
//
// **Cold-start recovery link.** In `idle` mode (Exists), a ghost-style
// "Forgot your password? Unlock with recovery phrase" link below the
// primary CTA dispatches `unlock.start-recovery` → App routes Stage
// to `recover(phrase-entry)`. The link is suppressed during
// `decrypting`, `recovery-in-progress`, fail-closed, and delete-vault
// states.
//
// **Lost-credentials delete link (MYND-108-bis).** Below the recovery
// link, a danger-tinted "Lost both password and recovery phrase?
// Delete vault and start over" link switches the component to the
// `delete-vault` sub-view. On Submit the IPC accepts via
// `Slot::Empty + vault.meta-exists` (backend `delete_vault_files_no_zeroize`
// no-keys arm); on Ok or PartialDelete-Continue the parent dispatches
// `unlock.delete-vault-success` → Stage transitions to `welcome`.
// See `decisions.md` 2026-05-26 entry "MYND-108-bis vault_delete
// extended to accept Slot::Empty + vault.meta-exists".

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useReducer, useRef, type CSSProperties, type FormEvent } from "react";
import { appDataDir, join } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DestructiveBanner } from "../components/DestructiveBanner";
import { DeleteVaultConfirmForm } from "../components/DeleteVaultConfirmForm";
import { FailClosedError } from "../components/FailClosedError";
import { QuickUnlockEntry } from "../components/QuickUnlockEntry";
import {
  CARD_BODY_STYLE,
  CARD_TITLE_STYLE,
  CenteredCard,
} from "../components/primitives/CenteredCard";
import { Spinner } from "../components/Spinner";
import { SuspicionBanner } from "../components/SuspicionBanner";
import { closeApp } from "../lib/app-window";
import { ioBanner } from "../lib/io-banner";
import { UNLOCK_NON_DISTINGUISHING_BANNER } from "../lib/load-bearing-copy";
import type { StageVaultStatus, SuspicionReason, VaultId } from "../lib/stage";
import {
  deleteVault,
  mapDeleteVaultError,
  type DeleteVaultPartialFailContext,
  type VaultDeleteError,
} from "../lib/vault-delete";
import type { VaultUnlockError } from "../types/vault-unlock-error";

interface UnlockProps {
  initialStatus: StageVaultStatus;
  /**
   * Optional vault-targeting id (MYND-204, multi-vault sub-feature 3, task 8).
   * Carried on the `unlock` Stage when the screen was reached by an explicit
   * vault choice (`picker.select-vault`, or the single-vault boot arm). Threaded
   * into the vault-addressed `unlock` IPC (SYNC-6): `Some(id)` opens exactly
   * `vaults/<id>/vault.meta`; `undefined` falls through to the param-less /
   * `None` sole-vault unlock (unchanged single-vault behavior). The backend
   * evicts any prior `Unlocked` vault on a switch (SYNC-1 lock-then-unlock), so
   * picking a vault opens THAT vault with no other vault concurrently unlocked.
   */
  vaultId?: VaultId;
  onUnlocked: () => void;
  /** Cold-start recovery entry. Dispatched by the "Recovery phrase ile
   *  aç" link in idle mode. App.tsx sends `unlock.start-recovery` →
   *  Stage transitions to `recover(phrase-entry)`. */
  onStartRecovery: () => void;
  /** Resume recovery entry. Dispatched by the "Continue" CTA on the
   *  `VaultRecoveryInProgress` info banner. App.tsx sends
   *  `unlock.resume-recovery` → Stage transitions to
   *  `recover(password-reset)`. */
  onResumeRecovery: () => void;
  /**
   * Terminal-destructive transition (MYND-108-bis lost-credentials
   * cul-de-sac escape). Fired on `vault_delete` IPC Ok from the
   * `delete-vault` sub-view OR on the user's Continue click after a
   * PartialDelete/Io banner. App.tsx sends
   * `unlock.delete-vault-success` → Stage transitions to `welcome`.
   * Backend accepts via `Slot::Empty + vault.meta-exists` no-keys
   * arm per `decisions.md` 2026-05-26 entry "MYND-108-bis
   * vault_delete extended to accept Slot::Empty + vault.meta-exists".
   */
  onDeleteVaultSuccess: () => void;
  /** Corrupted-state repair door → `unlock.restore-backup` (MYND-56). */
  onRestoreBackup: () => void;
  /**
   * Optional one-shot signal carried via `Stage.unlock.suspicionReason`
   * — set only by the change-password modal's force-relock callback
   * (Task 13's plumbing). Renders `<SuspicionBanner>` above the
   * password form. Two values: `"vault-meta-changed-externally"` (red
   * severity, CAS mismatch) and `"vault-locked-during-change"`
   * (informational gray, user-initiated lock during Argon2id). The
   * banner has no dismiss affordance — it informs, doesn't gate.
   * App.tsx implicitly clears the field on stage exit (next mount of
   * Unlock from boot probe or from a different transition won't carry
   * it). See `decisions.md` 2026-05-08 "`Stage.unlock.suspicionReason?`"
   * entry.
   */
  suspicionReason?: SuspicionReason;
}

type UnlockState =
  | { kind: "idle"; password: string; error: string | null }
  | { kind: "decrypting"; password: string }
  | { kind: "corrupted-after-unlock" }
  | { kind: "recovery-in-progress" }
  | {
      kind: "delete-vault";
      inFlight: boolean;
      partialFail: DeleteVaultPartialFailContext | null;
    };

type UnlockAction =
  | { type: "set-password"; value: string }
  | { type: "submit" }
  | { type: "fail"; error: string }
  | { type: "fail-corrupted" }
  | { type: "fail-recovery-in-progress" }
  | { type: "success" }
  | { type: "request-delete-vault" }
  | { type: "cancel-delete-vault" }
  | { type: "delete-vault-in-flight" }
  | { type: "delete-vault-partial-fail"; context: DeleteVaultPartialFailContext }
  | { type: "delete-vault-bug-canary" };

function reducer(state: UnlockState, action: UnlockAction): UnlockState {
  switch (action.type) {
    case "set-password":
      if (state.kind !== "idle") return state;
      return { ...state, password: action.value, error: null };
    case "submit":
      if (state.kind !== "idle" || state.password.length === 0) return state;
      return { kind: "decrypting", password: state.password };
    case "fail":
      if (state.kind !== "decrypting") return state;
      return { kind: "idle", password: state.password, error: action.error };
    case "fail-corrupted":
      return { kind: "corrupted-after-unlock" };
    case "fail-recovery-in-progress":
      // Slot was `Recovering` at unlock-attempt time. Switch the
      // component to a banner + "Continue" surface; the password form
      // is suppressed (typing a password while the slot is recovering
      // is meaningless — the user must complete A8f first).
      return { kind: "recovery-in-progress" };
    case "success":
      // Stay in `decrypting` until parent transitions Stage → editor
      // and this component unmounts. Switching to a `success` variant
      // would briefly render an idle-empty state before unmount.
      return state;
    case "request-delete-vault":
      // Permitted only from idle mode (no in-flight password attempt,
      // no recovery-in-progress). Resets any pending partial-fail
      // context from a stale prior attempt.
      if (state.kind !== "idle") return state;
      return { kind: "delete-vault", inFlight: false, partialFail: null };
    case "cancel-delete-vault":
      // Cancel back to idle. Permitted only when NOT inFlight
      // (the form's Cancel button is hidden during the IPC window).
      if (state.kind !== "delete-vault" || state.inFlight) return state;
      return { kind: "idle", password: "", error: null };
    case "delete-vault-in-flight":
      if (state.kind !== "delete-vault") return state;
      return { ...state, inFlight: true };
    case "delete-vault-partial-fail":
      if (state.kind !== "delete-vault") return state;
      return { ...state, inFlight: false, partialFail: action.context };
    case "delete-vault-bug-canary":
      // Bug-canary error (VaultBusyAuth / VaultNotUnlocked /
      // VaultNotFound). Clear inFlight, stay in the form so the
      // user can retry or cancel. No user-visible banner.
      if (state.kind !== "delete-vault") return state;
      return { ...state, inFlight: false };
    default:
      return state;
  }
}

const INITIAL_STATE: UnlockState = { kind: "idle", password: "", error: null };

type BannerOutcome =
  | { kind: "banner"; text: string }
  | { kind: "corrupted" }
  | { kind: "recovery-in-progress" };

function unlockErrorOutcome(e: VaultUnlockError): BannerOutcome {
  switch (e.kind) {
    case "InvalidCredentialOrVault":
      // §7.3 LITERAL compound — UI does NOT collapse to "Wrong password"
      // alone (would silently weaken the non-distinguishing posture).
      // Canonical literal lives in `lib/load-bearing-copy.ts` (E2E
      // asserts it by full-string equality).
      return {
        kind: "banner",
        text: UNLOCK_NON_DISTINGUISHING_BANNER,
      };
    case "InvalidVaultMeta":
      return { kind: "corrupted" };
    case "IoError":
      return { kind: "banner", text: ioBanner(e.detail.io_error_kind) };
    case "VaultNotFound":
      return {
        kind: "banner",
        text: "Vault file not found. Please restart the app.",
      };
    case "VaultAlreadyUnlocked":
      return { kind: "banner", text: "Vault is already unlocked." };
    case "UnlockInProgress":
      return { kind: "banner", text: "Operation in progress." };
    case "VaultRecoveryInProgress":
      // Slot is in Slot::Recovering — user must complete the
      // password-reset chained step (recovery-flow.md §4.1) before any
      // unlock attempt. Switch into the `recovery-in-progress` mode so
      // the user can dispatch `unlock.resume-recovery` via the
      // "Continue" CTA.
      return { kind: "recovery-in-progress" };
    case "JoinFailure":
      return {
        kind: "banner",
        text: "Unexpected error. Please try again.",
      };
  }
}

const FORM_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  marginTop: "var(--space-2)",
};

const INPUT_STYLE: CSSProperties = {
  background: "var(--bg-1)",
  color: "var(--fg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-3) var(--space-4)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-base)",
  outline: "none",
};

// Info-style banner used for `recovery-in-progress` mode — distinct
// from the destructive `<DestructiveBanner>` used for idle-error.
// The user has not made a mistake; the flow was simply paused.
const INFO_BANNER_STYLE: CSSProperties = {
  background: "var(--info-soft)",
  border: "1px solid var(--info)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-3) var(--space-4)",
  fontSize: "var(--text-base)",
  lineHeight: "var(--leading-normal)",
  color: "var(--info)",
};

// Danger-tinted clone of RECOVER_LINK_STYLE — same shape (link-style
// transparent button) but rendered in `--danger` to telegraph the
// terminal-destructive nature of the affordance without escalating to
// the full Button danger variant (which would compete visually with
// the primary Unlock CTA).
const DELETE_VAULT_LINK_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  padding: 0,
  marginTop: "var(--space-1)",
  alignSelf: "center",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--danger)",
  cursor: "pointer",
  textAlign: "center",
};

const RECOVER_LINK_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  padding: 0,
  marginTop: "var(--space-2)",
  alignSelf: "center",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--accent)",
  cursor: "pointer",
};

function ctaStyle(disabled: boolean): CSSProperties {
  return {
    background: disabled ? "var(--bg-3)" : "var(--accent)",
    color: disabled ? "var(--fg-3)" : "var(--accent-on)",
    border: disabled ? "1px solid var(--line-1)" : "none",
    borderRadius: "var(--radius-2)",
    padding: "var(--space-3) var(--space-5)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-base)",
    fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
    cursor: disabled ? "not-allowed" : "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--space-2)",
  };
}

export function Unlock({
  initialStatus,
  vaultId,
  onUnlocked,
  onStartRecovery,
  onResumeRecovery,
  onDeleteVaultSuccess,
  onRestoreBackup,
  suspicionReason,
}: UnlockProps) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // MYND-121 — re-show the window after an idle-lock hid it. Auto-lock on idle
  // calls `window.hide()` (renderer-independent visual cover) before the
  // zeroize + WebView reload; the reloaded app boots straight here (slot Empty
  // → unlock). Re-reveal now that the safe unlock screen is mounted — gating
  // the show on REACHING this screen means a hung renderer (which never
  // reloads to here) never re-exposes plaintext. Idempotent on a normal boot
  // (the window is already shown by `screen_capture::init`). No-op outside
  // Tauri (browser dev shim).
  useEffect(() => {
    void (async () => {
      try {
        await getCurrentWindow().show();
      } catch {
        // Not inside Tauri, or no main window to reveal.
      }
    })();
  }, []);

  // MYND-108-bis delete-vault sub-view. Mounts when the user clicks
  // the tertiary "Lost both password and recovery phrase? Delete vault
  // and start over" link below the recovery link. The IPC accepts via
  // `Slot::Empty + vault.meta-exists` (backend's no-keys arm).
  if (state.kind === "delete-vault") {
    const handleDeleteSubmit = () => {
      dispatch({ type: "delete-vault-in-flight" });
      void (async () => {
        try {
          await deleteVault();
          if (!mountedRef.current) return;
          // Resolve = full success. Slot stayed Empty (no state change);
          // vault directory recursively removed. Parent dispatches
          // `unlock.delete-vault-success` → Stage transitions to
          // welcome, this component unmounts.
          onDeleteVaultSuccess();
        } catch (raw) {
          if (!mountedRef.current) return;
          const e = raw as VaultDeleteError;
          const base = await appDataDir();
          const vaultDirPath = await join(base, "vault");
          if (!mountedRef.current) return;
          const mapping = mapDeleteVaultError(e, vaultDirPath);
          if (mapping.kind === "partial-fail") {
            dispatch({
              type: "delete-vault-partial-fail",
              context: mapping.context,
            });
            return;
          }
          // Bug-canary: VaultBusyAuth / VaultNotUnlocked / VaultNotFound.
          // VaultNotUnlocked is unreachable from current backend paths
          // (MYND-108-bis lifted that arm) but we treat it as bug-canary
          // for defense-in-depth.
          if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.warn(
              "[Unlock] vault_delete rejected (UI/router bug indicator):",
              e,
            );
          }
          dispatch({ type: "delete-vault-bug-canary" });
        }
      })();
    };

    return (
      <CenteredCard>
        {suspicionReason && <SuspicionBanner reason={suspicionReason} />}
        <DeleteVaultConfirmForm
          onSubmit={handleDeleteSubmit}
          onCancel={() => dispatch({ type: "cancel-delete-vault" })}
          onContinueAfterPartial={() => {
            // Same terminal effect as the happy-path Submit.
            onDeleteVaultSuccess();
          }}
          inFlight={state.inFlight}
          partialFailContext={state.partialFail}
        />
      </CenteredCard>
    );
  }

  // Boot-time corrupted/IoError mode: render <FailClosedError /> from
  // the first frame; password form never mounts.
  if (initialStatus.kind === "Corrupted") {
    return (
      <FailClosedError
        reason={{ kind: "corrupted-vault" }}
        onCtaClick={() => void closeApp()}
        onRestoreBackup={onRestoreBackup}
      />
    );
  }
  if (initialStatus.kind === "IoError") {
    return (
      <FailClosedError
        reason={{ kind: "io-error", ioKind: initialStatus.ioKind }}
        onCtaClick={() => void closeApp()}
      />
    );
  }

  // Post-attempt corrupted mode: an `InvalidVaultMeta` mid-flight
  // switches the component to the same fail-closed surface as boot.
  if (state.kind === "corrupted-after-unlock") {
    return (
      <FailClosedError
        reason={{ kind: "corrupted-vault" }}
        onCtaClick={() => void closeApp()}
        onRestoreBackup={onRestoreBackup}
      />
    );
  }

  // Recovery-in-progress mode: an unlock attempt returned
  // `VaultRecoveryInProgress`. Render an info banner + "Continue" CTA;
  // password form is suppressed.
  if (state.kind === "recovery-in-progress") {
    return (
      <CenteredCard>
        <h1 style={CARD_TITLE_STYLE}>Recovery flow was interrupted.</h1>
        <p style={CARD_BODY_STYLE}>
          Set a new password first, then re-seal your vault.
        </p>
        <div
          role="alert"
          data-testid="unlock.recovery-in-progress-banner"
          style={INFO_BANNER_STYLE}
        >
          Recovery flow was interrupted. Set a new password first.
        </div>
        <button
          type="button"
          onClick={onResumeRecovery}
          style={ctaStyle(false)}
          data-testid="unlock.resume-cta"
        >
          <span>Continue</span>
        </button>
      </CenteredCard>
    );
  }

  const decrypting = state.kind === "decrypting";
  const password = state.password;
  const error = state.kind === "idle" ? state.error : null;
  const submitDisabled = decrypting || password.length === 0;

  const onSubmit = (ev: FormEvent) => {
    ev.preventDefault();
    if (submitDisabled) return;
    dispatch({ type: "submit" });
    void (async () => {
      try {
        // SYNC-6 vault-addressed unlock: `vaultId` opens exactly that vault's
        // `vaults/<id>/vault.meta`; `undefined` (the Tauri arg is then omitted)
        // falls through to the backend's sole-vault `None` path. Tauri maps the
        // `vaultId` camelCase key to the command's `vault_id: Option<String>`
        // param. On a switch the backend locks the prior `Unlocked` vault first
        // (SYNC-1), so no other vault stays unlocked.
        await invoke<void>("plugin:vault-unlock|unlock", { vaultId, password });
        dispatch({ type: "success" });
        onUnlocked();
      } catch (raw) {
        const outcome = unlockErrorOutcome(raw as VaultUnlockError);
        if (outcome.kind === "corrupted") {
          dispatch({ type: "fail-corrupted" });
        } else if (outcome.kind === "recovery-in-progress") {
          dispatch({ type: "fail-recovery-in-progress" });
        } else {
          dispatch({ type: "fail", error: outcome.text });
        }
      }
    })();
  };

  return (
    <CenteredCard>
      {suspicionReason && <SuspicionBanner reason={suspicionReason} />}
      <h1 style={CARD_TITLE_STYLE}>Unlock your vault.</h1>
      <p style={CARD_BODY_STYLE}>Enter your password to continue.</p>
      {/* Quick-unlock (PIN / Touch ID) affordance — rendered only when
          configured + usable this session; self-hides otherwise. The password
          form below stays the always-present escape hatch (MYND-329). */}
      <QuickUnlockEntry onUnlocked={onUnlocked} />
      {/* `data-vault-id` mirrors the picker-row idiom (SYNC-8): the
          vault-addressed unlock target threaded from the Stage payload,
          observable to the E2E suite (MYND-127 story 2). Absent when the
          backend's sole-vault `None` path applies. */}
      <form
        style={FORM_STYLE}
        onSubmit={onSubmit}
        noValidate
        data-testid="unlock.form"
        data-vault-id={vaultId}
      >
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => dispatch({ type: "set-password", value: e.currentTarget.value })}
          disabled={decrypting}
          autoFocus
          autoComplete="current-password"
          style={INPUT_STYLE}
          aria-label="Password"
          aria-invalid={error != null ? true : undefined}
          data-testid="unlock.password-input"
        />
        {error != null && (
          <DestructiveBanner testId="unlock.error-banner">{error}</DestructiveBanner>
        )}
        <button
          type="submit"
          disabled={submitDisabled}
          style={ctaStyle(submitDisabled)}
          data-testid="unlock.submit"
        >
          {decrypting && <Spinner size={14} style={{ borderWidth: 2 }} />}
          <span>{decrypting ? "Decrypting…" : "Unlock"}</span>
        </button>
        {!decrypting && (
          <button
            type="button"
            onClick={onStartRecovery}
            style={RECOVER_LINK_STYLE}
            data-testid="unlock.recovery-link"
          >
            Forgot your password? Unlock with recovery phrase
          </button>
        )}
        {!decrypting && (
          <button
            type="button"
            onClick={() => dispatch({ type: "request-delete-vault" })}
            style={DELETE_VAULT_LINK_STYLE}
            data-testid="unlock.delete-link"
          >
            Lost both password and recovery phrase? Delete vault and start over
          </button>
        )}
      </form>
    </CenteredCard>
  );
}
