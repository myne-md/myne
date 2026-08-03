// Vault-recover orchestrator. Mounts when App.tsx Stage transitions
// to `recover`; owns the entire recover sub-step state machine via
// `useReducer`; mounts the active sub-step component based on
// `state.subStep`.
//
// Mirrors `src/screens/CreateVault.tsx`'s shape:
//   - Reducer (`vaultRecoverReducer`) lives in `vault-recover/`.
//   - Sub-step components are siblings under `vault-recover/`.
//   - FailClosed escape hatch routes through the shared
//     `<FailClosedError>` component (`recovery-flow.md` §3.4 +
//     §4.x mappings → corrupted-vault / invalid-state).
//
// **A8d (recover_with_phrase) lifecycle.** PhraseEntryStep submits
// the joined NFKD-normalized phrase via `onSubmitNormalizedPhrase`;
// the orchestrator stashes it in a ref and dispatches `submit-phrase`
// to transition the sub-step to `decrypting`. A `useEffect` keyed on
// `subStep === "decrypting"` reads the ref and fires the IPC; on
// resolve/reject it wipes the ref (best-effort JS hygiene per § 3.5)
// and dispatches `phrase-result` with the mapped `PhraseOutcome`.
// Mirrors vault-creation's `begin` IPC firing pattern in CreateVault.
//
// Entry sub-step is provided by App.tsx via `initialSubStep`:
//   - `phrase-entry` on `unlock.start-recovery` (cold start; A8d
//     not yet attempted).
//   - `password-reset` on `unlock.resume-recovery` or boot probe
//     `vault_slot_kind === "Recovering"` (slot already populated by
//     a prior session's A8d).
//
// Task 7 wires A8f firing for the password-reset sub-step.
//
// **No `vault_lock` invocation anywhere in this module.** Q8 policy:
// process-exit RAII is the sole bail mechanism for `Slot::Recovering`
// material. The orchestrator dispatches `onCancel` (Stage-only
// transition; slot is `Empty` since A8d hasn't fired) on phrase-entry
// cancel, and `onCompleteSuccess` (App transitions to `editor`) on
// A8f success. No defensive cleanup, no `beforeunload` listener.

import { useEffect, useReducer, useRef } from "react";
import { appDataDir, join } from "../platform/path";
import i18n from "../i18n";
import { DeleteVaultConfirmForm } from "../components/DeleteVaultConfirmForm";
import { FailClosedError } from "../components/FailClosedError";
import { failClosedExit, FAIL_CLOSED_EXIT_LABEL_KEY } from "../platform/app-exit";
import { ioBanner } from "../lib/io-banner";
import type { RecoverSubStep } from "../lib/stage";
import { listVaults, soleVaultId } from "../lib/vault-list";
import { recoverWithPhrase } from "../lib/vault-recover";
import {
  deleteVault,
  mapDeleteVaultError,
  type VaultDeleteError,
} from "../lib/vault-delete";
import type { VaultRecoveryError } from "../types/vault-recovery-error";
import {
  vaultRecoverReducer,
  initialState,
  RecoverySelectStep,
  PhraseEntryStep,
  DecryptingStep,
  PasswordResetStep,
  type PhraseOutcome,
} from "./vault-recover";

interface VaultRecoverProps {
  initialSubStep: RecoverSubStep;
  /** Dispatched when the user clicks Cancel on phrase-entry. Routes
   *  Stage `recover → unlock(Exists)` via `recover.cancel`. Decrypting
   *  and password-reset sub-steps do NOT render Cancel affordances
   *  (spec §3.3 + §4.1). Carries the recovery's selected target
   *  vault id (MYND-219 / SYNC-17 — keeps the post-cancel unlock
   *  vault-addressed at ≥2 vaults; `undefined` on the sole-vault path). */
  onCancel: (vaultId?: string) => void;
  /** Dispatched when A8f returns Ok. Routes Stage
   *  `recover(password-reset) → editor` via
   *  `recover.complete-success`. Carries the recovered vault's id
   *  (MYND-219 / SYNC-17) for the editor stage's vault-addressed
   *  lock/relock exits. */
  onCompleteSuccess: (vaultId?: string) => void;
  /**
   * MYND-108-bis: fired from the lost-credentials cul-de-sac when the
   * user submits the delete-confirm sub-step's typed-DELETE form
   * (vault_delete IPC Ok) OR clicks Continue after a PartialDelete/Io
   * banner. App.tsx reprobes; boot routing picks the return surface by
   * remaining vault count (picker at ≥2, unlock at 1, welcome at 0).
   * Backend accepts via `Slot::Empty + vault.meta-exists` no-keys arm
   * (`decisions.md` 2026-05-26 entry "MYND-108-bis vault_delete
   * extended to accept Slot::Empty + vault.meta-exists"). The
   * `recovery-flow.md` §4.1 / §4.3 invariants are preserved — the
   * delete affordance lives ONLY in the phrase-entry footer; the
   * `PasswordResetStep` chained password reset stays non-dismissible.
   */
  onDeleteVaultSuccess: () => void;
}

/** Map a `VaultRecoveryError` from A8d to a `PhraseOutcome` per the
 *  Q7 A8d matrix. Banner copy is Turkish; `corrupted-vault` and
 *  `invalid-state` route through the fail-closed surface. */
function mapPhraseError(e: VaultRecoveryError): PhraseOutcome {
  switch (e.kind) {
    case "InvalidCredentialOrVault":
      // Spec §3.4: single non-distinguishing wipe + retry. Reducer
      // hardcodes the banner string.
      return { kind: "non-distinguishing" };
    case "InvalidVaultMeta":
      // Structural failure (parse / items_key tampering) — recovery
      // cannot recover.
      return { kind: "fail-closed", reason: "corrupted-vault" };
    case "IoError":
      return { kind: "banner-retry", banner: ioBanner(e.detail.io_error_kind) };
    case "VaultNotFound":
      return {
        kind: "banner-retry",
        banner: i18n.t("recover.errors.vaultNotFound"),
      };
    case "VaultAlreadyUnlocked":
      // Stage-transition bug-canary: user shouldn't reach phrase-entry
      // when slot is already Unlocked. Fail-closed surfaces the
      // regression.
      return { kind: "fail-closed", reason: "invalid-state" };
    case "RecoveryAlreadyInProgress":
      // Q4 silent recovery: slot is actually Recovering already; jump
      // to password-reset.
      return { kind: "already-recovering" };
    case "RecoveryInProgress":
      return {
        kind: "banner-retry",
        banner: i18n.t("recover.errors.operationInProgress"),
      };
    case "VaultRecoveryRequiresActiveSession":
      // Defensive — A8d cannot produce this variant in practice
      // (it's an A8f precondition). Treat as generic banner.
      return {
        kind: "banner-retry",
        banner: i18n.t("recover.errors.unexpected"),
      };
    case "JoinFailure":
      return {
        kind: "banner-retry",
        banner: i18n.t("recover.errors.unexpected"),
      };
    case "RecoveryAbortedByLock":
      // Defensive — an A8f-side variant (lock raced complete_recovery);
      // A8d cannot produce it. Informational copy mirrors the
      // change-password lock-race banner class.
      return {
        kind: "banner-retry",
        banner: i18n.t("recover.errors.cancelledVaultLocked"),
      };
    case "WeakNewPassword":
      // Defensive — A8f-side floor; A8d takes no password. Generic.
      return {
        kind: "banner-retry",
        banner: i18n.t("recover.errors.unexpected"),
      };
  }
}

export function VaultRecover({
  initialSubStep,
  onCancel,
  onCompleteSuccess,
  onDeleteVaultSuccess,
}: VaultRecoverProps) {
  const [state, dispatch] = useReducer(
    vaultRecoverReducer,
    initialSubStep,
    initialState,
  );

  // Phrase plaintext lifetime: PhraseEntryStep submit → A8d resolve.
  // Wiped on every exit path (success / failure / unmount). JS-side
  // wipe is best-effort per `recovery-flow.md` § 3.5; the load-bearing
  // zeroize is Rust-side via `Zeroizing<String>`.
  const phraseRef = useRef<string | null>(null);

  // Best-effort wipe on unmount — covers any path that didn't already
  // null the ref (success / error already wipe inline).
  useEffect(() => {
    return () => {
      phraseRef.current = null;
    };
  }, []);

  // Live-after-await guard for the async delete handler below (mirrors the
  // `cancelled` bail in the `gatedRef` probe). Reset true on mount so the
  // StrictMode dev remount doesn't leave it stuck false.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // MYND-206 multi-vault recovery gate. On a COLD-START mount (the orchestrator
  // entered via `unlock.start-recovery` → `initialSubStep === "phrase-entry"`),
  // probe how many vaults exist on disk. ≥2 → require a selection first
  // (dispatch `enter-select` → the `select` sub-step renders the picker +
  // optional account-number). ≤1 → stay in phrase-entry with `vaultId = null`
  // (single-vault parity, story 7: no picker, no account-number step; the IPC
  // layer falls back to the sole vault). Runs once; gated on `initialSubStep`
  // so a RESUMED recovery (`password-reset` entry from `unlock.resume-recovery`
  // / boot probe) never re-enters selection — that flow already has a
  // server-side `Slot::Recovering` for a specific vault.
  const gatedRef = useRef(false);
  useEffect(() => {
    if (gatedRef.current) return;
    if (initialSubStep !== "phrase-entry") {
      gatedRef.current = true;
      return;
    }
    let cancelled = false;
    void (async () => {
      const result = await listVaults();
      if (cancelled) return;
      gatedRef.current = true;
      // Only ≥2 well-formed-or-not vaults trigger the selection stage. A
      // failed list read (exotic — recovery is reached with a vault on disk)
      // leaves the single-vault phrase-entry path, the safe default.
      if ("ok" in result && result.ok.length >= 2) {
        dispatch({ type: "enter-select" });
      }
    })();
    return () => {
      cancelled = true;
    };
    // `initialSubStep` is the mount-time hint; `dispatch` is stable.
  }, [initialSubStep]);

  // A8d firing effect: when the sub-step transitions to `decrypting`,
  // read the stashed phrase and invoke the IPC. Resolves/rejects map
  // to `phrase-result` outcomes; ref is wiped on either path.
  useEffect(() => {
    if (state.subStep !== "decrypting") return;
    const phrase = phraseRef.current;
    if (!phrase) return; // defansif (subStep should never reach decrypting without a stashed phrase)
    let cancelled = false;
    void (async () => {
      try {
        // MYND-206: thread the chosen VaultId (null → sole-vault fallback) so
        // A8d reads exactly the selected vault's vault.meta (SYNC-6 targeting).
        await recoverWithPhrase(phrase, state.vaultId ?? undefined);
        if (cancelled) return;
        phraseRef.current = null;
        dispatch({ type: "phrase-result", outcome: { kind: "success" } });
      } catch (raw) {
        if (cancelled) return;
        phraseRef.current = null;
        const outcome = mapPhraseError(raw as VaultRecoveryError);
        dispatch({ type: "phrase-result", outcome });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.subStep]);

  if (state.failClosed) {
    return (
      <FailClosedError
        reason={{ kind: state.failClosed }}
        onCtaClick={() => void failClosedExit()}
        ctaLabelKey={FAIL_CLOSED_EXIT_LABEL_KEY}
      />
    );
  }

  switch (state.subStep) {
    case "select":
      // MYND-206 multi-vault recovery selection (≥2 vaults). Picker rows +
      // optional account-number affordance; either resolves a VaultId which
      // advances to phrase-entry against that vault. Cancel routes the whole
      // recovery flow back to unlock (same `recover.cancel` route as
      // phrase-entry's Cancel; slot is Empty — no `vault_lock` needed).
      return (
        <RecoverySelectStep
          onVaultSelected={(vaultId) =>
            dispatch({ type: "vault-selected", vaultId })
          }
          // No vault chosen yet on the select step — the post-cancel
          // unlock falls to the boot-shaped sole/None path.
          onCancel={() => onCancel(undefined)}
        />
      );
    case "phrase-entry":
      return (
        <PhraseEntryStep
          state={state}
          dispatch={dispatch}
          // Thread the recovery's selected target (MYND-219 / SYNC-17)
          // so the post-cancel unlock stays vault-addressed.
          onCancel={() => onCancel(state.vaultId ?? undefined)}
          onSubmitNormalizedPhrase={(normalized) => {
            phraseRef.current = normalized;
          }}
        />
      );
    case "decrypting":
      return <DecryptingStep />;
    case "password-reset":
      return (
        <PasswordResetStep
          state={state}
          dispatch={dispatch}
          onCompleteSuccess={() => onCompleteSuccess(state.vaultId ?? undefined)}
        />
      );
    case "delete-confirm": {
      // MYND-108-bis: typed-DELETE confirmation form. IPC accepts
      // via `Slot::Empty + vault.meta-exists` no-keys arm. On Ok or
      // PartialDelete-Continue, notifies the parent, which reprobes to
      // route by remaining vault count.
      const handleDeleteSubmit = () => {
        dispatch({ type: "delete-in-flight" });
        void (async () => {
          try {
            // Required target since #250 — the flow already resolved which
            // vault it is recovering; the single-vault entry that carries none
            // falls back to the sole vault on disk. Ambiguous → refuse.
            const target = state.vaultId ?? (await soleVaultId());
            if (!mountedRef.current) return;
            if (target == null) {
              if (import.meta.env.DEV) {
                // eslint-disable-next-line no-console
                console.warn(
                  "[VaultRecover] vault_delete refused: ambiguous target",
                );
              }
              return;
            }
            await deleteVault(target);
            if (!mountedRef.current) return;
            onDeleteVaultSuccess();
          } catch (raw) {
            const e = raw as VaultDeleteError;
            const base = await appDataDir();
            const vaultDirPath = await join(base, "vault");
            if (!mountedRef.current) return;
            const mapping = mapDeleteVaultError(e, vaultDirPath);
            if (mapping.kind === "partial-fail") {
              dispatch({
                type: "delete-partial-fail",
                context: mapping.context,
              });
              return;
            }
            if (import.meta.env.DEV) {
              // eslint-disable-next-line no-console
              console.warn(
                "[VaultRecover] vault_delete rejected (UI/router bug indicator):",
                e,
              );
            }
            dispatch({ type: "delete-bug-canary" });
          }
        })();
      };
      return (
        <DeleteVaultConfirmForm
          onSubmit={handleDeleteSubmit}
          onCancel={() => dispatch({ type: "cancel-delete" })}
          onContinueAfterPartial={() => {
            // Same terminal effect as happy-path Submit.
            onDeleteVaultSuccess();
          }}
          inFlight={state.deleteInFlight}
          partialFailContext={state.deletePartialFail}
        />
      );
    }
  }
}
