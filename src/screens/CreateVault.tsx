// Vault-creation orchestrator. Mounts when App.tsx stage transitions to
// "create-vault"; owns the entire vault-creation state machine via
// useReducer; mounts the active step component based on state.step.
//
// Implements design session 2026-04-28-vault-creation-frontend.md:
//   - Q2 state machine + secret-material scope encapsulation (phrase /
//     accountNumber / sessionToken live in this component's reducer
//     state and never leak to App.tsx).
//   - Q6 begin invocation as a useEffect on `state.step === "encrypting"`
//     (Argon2id × 2 inside spawn_blocking on the Rust side).
//   - Q7 error routing: AppError → mapAppErrorToUserMessage → BEGIN_ERR
//     (inline banner) or SESSION_LOST (dedicated screen).
//   - Q8.2 onCloseRequested prompt for sensitive steps (phrase / confirm /
//     account); membership decided via isSensitiveStep() in reducer.ts.
//   - Q8.3 useRef + empty-deps cleanup pattern (cancel(token) only on
//     real unmount; React 18 StrictMode dev double-invoke is a no-op
//     because the ref only carries a token after BEGIN_OK).
//
// Backend dependencies (per backend-vault-creation/rfc.md):
//   - vault-creation:begin   — wired below.
//   - vault-creation:commit  — wired below.
//   - vault-creation:cancel  — wired here (cleanup + PhraseStep Back).

import { useEffect, useReducer, useRef, useState } from "react";
import { invoke } from "../platform/core";
import { getCurrentWindow } from "../platform/window";
import { confirm as dialogConfirm } from "../platform/dialog";
import i18n from "../i18n";
import { HAS_TAURI } from "../lib/app-window";
import {
  vaultCreationReducer,
  makeInitialState,
  isSensitiveStep,
  type Step,
} from "./vault-creation";
import { BriefingStep } from "./vault-creation/BriefingStep";
import { PasswordStep } from "./vault-creation/PasswordStep";
import { EncryptingStep } from "./vault-creation/EncryptingStep";
import { PhraseStep } from "./vault-creation/PhraseStep";
import { ConfirmStep } from "./vault-creation/ConfirmStep";
import { AccountStep } from "./vault-creation/AccountStep";
import { ReadyStep } from "./vault-creation/ReadyStep";
import { SessionLostStep } from "./vault-creation/SessionLostStep";
import { mapAppErrorToUserMessage } from "../lib/vault-creation-errors";
import { isAppError, logErrorKind } from "../lib/vault-creation-logging";
import { seedExampleVault } from "../notes/exampleVault";
import type { BeginResult } from "../types/protocol-error";

interface CreateVaultProps {
  /**
   * First-run safety briefing (MYND-114). When true, the flow opens on
   * `<BriefingStep>` before password setup; App.tsx sets it ONLY for the
   * `welcome → create-vault.start` entry (`stage.briefing`). Picker /
   * switcher "create another" entries omit it (default false) — the user
   * has already acknowledged the recovery model once. Optional + default
   * false so component tests that mount the flow directly land on
   * PasswordStep, as before.
   */
  withBriefing?: boolean;
  onBack: () => void;
  /**
   * Auto-unlock success — `vault_unlock(password)` resolved after
   * `commit`, slot is populated, route directly to editor. PRD Q4(a).
   * `vaultId` is the just-created vault's id (from `commit`) so the
   * editor stage's lock/relock exits stay vault-addressed (MYND-219 /
   * SYNC-17). `null` only on the legacy sole-vault path.
   */
  onAutoUnlockSuccess: (vaultId: string | null) => void;
  /**
   * Auto-unlock failure (defansif) — `commit` succeeded but the
   * chained `vault_unlock` call rejected (rare, almost certainly a
   * transient backend failure since the same password just succeeded
   * inside `commit`). Route to `unlock(Exists)` so the user can
   * retype manually. `vaultId` is the just-created vault's id (from
   * `commit`) so the manual unlock targets it explicitly — without it
   * the retry hits the sole-vault fallback, which resolves to a
   * non-existent legacy path once a second vault exists (`VaultNotFound`).
   */
  onAutoUnlockFailed: (vaultId: string | null) => void;
}

export function CreateVault({
  withBriefing = false,
  onBack,
  onAutoUnlockSuccess,
  onAutoUnlockFailed,
}: CreateVaultProps) {
  const [state, dispatch] = useReducer(
    vaultCreationReducer,
    withBriefing,
    makeInitialState,
  );
  const [autoUnlocking, setAutoUnlocking] = useState(false);

  const sessionTokenRef = useRef<string | null>(null);
  // The id of the vault `commit` just wrote to (`vaults/<id>/`), captured from
  // the commit IPC so the chained auto-unlock — and the manual-unlock fallback
  // — can target it explicitly. `null` only on the legacy sole-vault path.
  const committedVaultIdRef = useRef<string | null>(null);
  const stepRef = useRef<Step>(state.step);
  useEffect(() => {
    sessionTokenRef.current = state.sessionToken;
    stepRef.current = state.step;
  });

  // Dev-only: walk the reducer to a target step via ?test-step=<step> so
  // Playwright can capture every screen without going through real Tauri
  // invoke calls (which don't exist in a browser). Tree-shaken from prod
  // builds via the import.meta.env.DEV guard.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const target = new URLSearchParams(location.search).get("test-step");
    if (!target) return;
    const MOCK_PHRASE = [
      "abandon", "ability", "able", "about", "above", "absent",
      "absorb", "abstract", "absurd", "abuse", "access", "accident",
      "account", "accuse", "achieve", "acid", "acoustic", "acquire",
      "across", "act", "action", "actor", "actress", "actual",
    ];
    const MOCK_ACCOUNT = "MY-4K7P-N3RM-9QXC-VBHT-2";
    const MOCK_TOKEN = "test-session-token-uuid";
    const MOCK_SESSION_LOST = {
      title: "Session expired",
      body: "For your security, vault creation times out after 10 minutes. Start over.",
      primaryAction: "restart",
      displayMode: "dedicated",
    } as const;
    const beginOk = () =>
      dispatch({
        type: "BEGIN_OK",
        phrase: MOCK_PHRASE,
        accountNumber: MOCK_ACCOUNT,
        sessionToken: MOCK_TOKEN,
      });
    // The first-run briefing is the initial step when `withBriefing` (the
    // welcome entry); capturing it needs no dispatch. Every other target
    // sits past the briefing gate, so step over it first (idempotent from
    // `password` when there is no briefing). `password` itself needs no
    // further dispatch — the ladder below matches nothing and the effect
    // ends on the password step.
    if (target === "briefing") return;
    dispatch({ type: "BRIEFING_ACKED" });
    if (target === "encrypting") {
      dispatch({ type: "BEGIN_REQUESTED" });
    } else if (target === "phrase") {
      beginOk();
    } else if (target === "confirm") {
      beginOk();
      dispatch({ type: "PHRASE_REVEALED" });
      dispatch({ type: "PHRASE_ACKED" });
    } else if (target === "account") {
      beginOk();
      dispatch({ type: "PHRASE_REVEALED" });
      dispatch({ type: "PHRASE_ACKED" });
      dispatch({ type: "PHRASE_CONFIRMED" });
    } else if (target === "committing") {
      beginOk();
      dispatch({ type: "PHRASE_REVEALED" });
      dispatch({ type: "PHRASE_ACKED" });
      dispatch({ type: "PHRASE_CONFIRMED" });
      dispatch({ type: "ACCOUNT_ACK_TOGGLED", checked: true });
      dispatch({ type: "COMMIT_REQUESTED" });
    } else if (target === "ready") {
      beginOk();
      dispatch({ type: "PHRASE_REVEALED" });
      dispatch({ type: "PHRASE_ACKED" });
      dispatch({ type: "PHRASE_CONFIRMED" });
      dispatch({ type: "ACCOUNT_ACK_TOGGLED", checked: true });
      dispatch({ type: "COMMIT_REQUESTED" });
      dispatch({ type: "COMMIT_OK" });
    } else if (target === "session-lost") {
      dispatch({ type: "SESSION_LOST", error: MOCK_SESSION_LOST });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      // Best-effort password wipe on unmount — covers the auto-unlock
      // success path where the IPC has already nulled the ref + the
      // failure paths that wiped + the rare case where the component
      // unmounts mid-flow before any explicit wipe site fired.
      passwordRef.current = null;
      if (!HAS_TAURI) return;
      const token = sessionTokenRef.current;
      if (token) {
        invoke("plugin:vault-creation|cancel", { sessionToken: token }).catch(
          (e: unknown) => logErrorKind(e, "cancel-failed"),
        );
      }
    };
  }, []);

  useEffect(() => {
    if (!HAS_TAURI) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const win = getCurrentWindow();
    win
      .onCloseRequested(async (event) => {
        // Tauri `prevent_close()`s the native X the moment a listener exists
        // (manager/window.rs `has_js_listener`), so the window only closes if
        // WE call `destroy()` — never rely on the JS wrapper's version-dependent
        // "auto-destroy when preventDefault wasn't called". Take control up
        // front, then destroy() on the close-intended paths. `destroy()` force-
        // closes WITHOUT re-firing onCloseRequested (so no recursion).
        event.preventDefault();
        if (!isSensitiveStep(stepRef.current)) {
          await win.destroy();
          return;
        }
        let proceed: boolean;
        try {
          proceed = await dialogConfirm(
            i18n.t("vaultCreation.orchestrator.closePrompt.message"),
            {
              title: i18n.t("vaultCreation.orchestrator.closePrompt.title"),
              okLabel: i18n.t("vaultCreation.orchestrator.closePrompt.okLabel"),
              cancelLabel: i18n.t(
                "vaultCreation.orchestrator.closePrompt.cancelLabel",
              ),
            },
          );
        } catch (e) {
          logErrorKind(e, "close-confirm-failed");
          return; // keep the window open if the confirm prompt failed
        }
        if (proceed) await win.destroy();
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e: unknown) => logErrorKind(e, "close-listener-failed"));
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Lifetime: PasswordStep submit → auto-unlock resolve. Wiped on every
  // exit path (BEGIN_ERR / COMMIT_ERR / SESSION_LOST / RESET_TO_PASSWORD /
  // auto-unlock resolve / unmount). TS-side wipe is best-effort; the
  // load-bearing zeroize is Rust-side inside `Zeroizing<String>`.
  const passwordRef = useRef<string | null>(null);

  const handlePasswordSubmit = (password: string) => {
    passwordRef.current = password;
    dispatch({ type: "BEGIN_REQUESTED" });
  };

  const handlePhraseBack = () => {
    if (HAS_TAURI) {
      const token = sessionTokenRef.current;
      if (token) {
        invoke("plugin:vault-creation|cancel", { sessionToken: token }).catch(
          (e: unknown) => logErrorKind(e, "cancel-failed"),
        );
      }
    }
    passwordRef.current = null;
    dispatch({ type: "RESET_TO_PASSWORD" });
  };

  /**
   * Auto-unlock chain (PRD Q4(a)). Triggered by ReadyStep's "Done"
   * button. Re-feeds the just-typed password into `vault_unlock` so
   * the user lands directly in editor without retyping. Plugin
   * isolation preserved: `vault_creation::commit` did NOT populate
   * `VaultRuntimeState`; this second IPC does.
   *
   * On rejection (rare — same password just succeeded inside `commit`),
   * fall through to manual unlock. The user retypes; if the failure
   * was transient (JoinFailure, IO blip) the manual attempt
   * succeeds; if it was structural, the Unlock screen shows the
   * variant-mapped banner.
   */
  const handleAutoUnlock = async () => {
    const password = passwordRef.current;
    if (!password || !HAS_TAURI) {
      // Defensive (web dev or test-step path with no real password).
      passwordRef.current = null;
      onAutoUnlockFailed(committedVaultIdRef.current);
      return;
    }
    setAutoUnlocking(true);
    try {
      // Target the just-created vault explicitly (SYNC-6). Passing `null`
      // (legacy sole-vault path) reproduces the prior implicit behaviour.
      await invoke("plugin:vault-unlock|unlock", {
        password,
        vaultId: committedVaultIdRef.current,
      });
      passwordRef.current = null;
      // #393 — seed the first-run example vault now the new vault is unlocked
      // (note_create requires an unlocked slot). Supersedes the single MYND-118
      // Welcome note. Best-effort: seedExampleVault never throws, so a failure
      // here can't bounce a successfully-unlocked user back to the manual-unlock
      // fallback.
      await seedExampleVault();
      onAutoUnlockSuccess(committedVaultIdRef.current);
    } catch (e) {
      passwordRef.current = null;
      logErrorKind(e, "auto-unlock-failed");
      onAutoUnlockFailed(committedVaultIdRef.current);
    } finally {
      setAutoUnlocking(false);
    }
  };

  useEffect(() => {
    if (!HAS_TAURI) return;
    if (state.step !== "encrypting") return;
    const password = passwordRef.current;
    if (!password) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await invoke<BeginResult>(
          "plugin:vault-creation|begin",
          { password },
        );
        if (cancelled) return;
        // Password retained — auto-unlock re-feeds it into vault_unlock
        // after commit (see passwordRef comment above for wipe sites).
        dispatch({
          type: "BEGIN_OK",
          phrase: result.phrase,
          accountNumber: result.account_number,
          sessionToken: result.session_token,
        });
      } catch (e) {
        if (cancelled) return;
        passwordRef.current = null;
        if (!isAppError(e)) {
          logErrorKind(e, "begin-unknown-error");
          dispatch({ type: "BEGIN_ERR", error: genericError() });
          return;
        }
        logErrorKind(e, "begin");
        const message = mapAppErrorToUserMessage(e);
        if (message.displayMode === "dedicated") {
          dispatch({ type: "SESSION_LOST", error: message });
        } else {
          dispatch({ type: "BEGIN_ERR", error: message });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.step]);

  useEffect(() => {
    if (!HAS_TAURI) return;
    if (state.step !== "committing") return;
    const token = sessionTokenRef.current;
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const newVaultId = await invoke<string | null>(
          "plugin:vault-creation|commit",
          { sessionToken: token },
        );
        if (cancelled) return;
        // Capture the written-to vault id for the chained auto-unlock so it
        // targets `vaults/<newVaultId>/` rather than the sole-vault fallback.
        committedVaultIdRef.current = newVaultId;
        sessionTokenRef.current = null;
        dispatch({ type: "COMMIT_OK" });
      } catch (e) {
        if (cancelled) return;
        // Wipe password — commit failure is terminal for this flow;
        // the password should not survive into a retry without an
        // explicit re-entry through PasswordStep.
        passwordRef.current = null;
        if (!isAppError(e)) {
          logErrorKind(e, "commit-unknown-error");
          dispatch({ type: "COMMIT_ERR", error: genericError() });
          return;
        }
        logErrorKind(e, "commit");
        const message = mapAppErrorToUserMessage(e);
        if (message.displayMode === "dedicated") {
          sessionTokenRef.current = null;
          dispatch({ type: "SESSION_LOST", error: message });
        } else {
          dispatch({ type: "COMMIT_ERR", error: message });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.step]);

  switch (state.step) {
    case "briefing":
      return (
        <BriefingStep
          onBack={onBack}
          onContinue={() => dispatch({ type: "BRIEFING_ACKED" })}
        />
      );
    case "password":
      return (
        <PasswordStep
          error={state.error}
          onBack={onBack}
          onSubmit={handlePasswordSubmit}
        />
      );
    case "encrypting":
      return <EncryptingStep />;
    case "phrase":
      return (
        <PhraseStep
          phrase={state.phrase ?? []}
          revealed={state.phraseRevealed}
          dispatch={dispatch}
          onCancelSession={handlePhraseBack}
        />
      );
    case "confirm":
      return (
        <ConfirmStep
          phrase={state.phrase ?? []}
          positions={state.confirmPositions ?? [1, 1, 1, 1]}
          inputs={state.confirmInputs}
          dispatch={dispatch}
        />
      );
    case "account":
    case "committing":
      return (
        <AccountStep
          accountNumber={state.accountNumber ?? ""}
          acknowledged={state.accountAcknowledged}
          committing={state.step === "committing"}
          error={state.error}
          dispatch={dispatch}
        />
      );
    case "ready":
      return (
        <ReadyStep
          onDone={handleAutoUnlock}
          pending={autoUnlocking}
          vaultId={committedVaultIdRef.current}
        />
      );
    case "session-lost":
      // SESSION_LOST is the only path into this step and always carries
      // an error; the non-null assertion is type-safe per the reducer.
      return <SessionLostStep error={state.error!} dispatch={dispatch} />;
    default: {
      const _exhaustive: never = state.step;
      void _exhaustive;
      return null;
    }
  }
}

// Resolved per-call (never frozen at import) so a language switch is
// reflected — `i18n.t()` reads the active language at the moment the error
// is built, not at module load.
function genericError() {
  return {
    title: i18n.t("vaultCreation.orchestrator.genericError.title"),
    body: i18n.t("vaultCreation.orchestrator.genericError.body"),
    primaryAction: "retry",
    displayMode: "inline",
  } as const;
}
