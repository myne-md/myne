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
import { FailClosedError } from "../components/FailClosedError";
import { closeApp } from "../lib/app-window";
import { ioBanner } from "../lib/io-banner";
import type { RecoverSubStep } from "../lib/stage";
import { recoverWithPhrase } from "../lib/vault-recover";
import type { VaultRecoveryError } from "../types/vault-recovery-error";
import {
  vaultRecoverReducer,
  initialState,
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
   *  (spec §3.3 + §4.1). */
  onCancel: () => void;
  /** Dispatched when A8f returns Ok. Routes Stage
   *  `recover(password-reset) → editor` via
   *  `recover.complete-success`. */
  onCompleteSuccess: () => void;
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
        banner: "Vault dosyası bulunamadı. Uygulamayı yeniden başlat.",
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
        banner: "İşlem devam ediyor. Lütfen biraz bekle.",
      };
    case "VaultRecoveryRequiresActiveSession":
      // Defansif — A8d cannot produce this variant in practice
      // (it's an A8f precondition). Treat as generic banner.
      return {
        kind: "banner-retry",
        banner: "Beklenmeyen hata. Lütfen tekrar dene.",
      };
    case "JoinFailure":
      return {
        kind: "banner-retry",
        banner: "Beklenmeyen hata. Lütfen tekrar dene.",
      };
  }
}

export function VaultRecover({
  initialSubStep,
  onCancel,
  onCompleteSuccess,
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
        await recoverWithPhrase(phrase);
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
        onCtaClick={() => void closeApp()}
      />
    );
  }

  switch (state.subStep) {
    case "phrase-entry":
      return (
        <PhraseEntryStep
          state={state}
          dispatch={dispatch}
          onCancel={onCancel}
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
          onCompleteSuccess={onCompleteSuccess}
        />
      );
  }
}
