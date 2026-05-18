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
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm as dialogConfirm } from "@tauri-apps/plugin-dialog";
import { HAS_TAURI } from "../lib/app-window";
import {
  vaultCreationReducer,
  initialState,
  isSensitiveStep,
  type Step,
} from "./vault-creation";
import { PasswordStep } from "./vault-creation/PasswordStep";
import { EncryptingStep } from "./vault-creation/EncryptingStep";
import { PhraseStep } from "./vault-creation/PhraseStep";
import { ConfirmStep } from "./vault-creation/ConfirmStep";
import { AccountStep } from "./vault-creation/AccountStep";
import { ReadyStep } from "./vault-creation/ReadyStep";
import { SessionLostStep } from "./vault-creation/SessionLostStep";
import { mapAppErrorToUserMessage } from "../lib/vault-creation-errors";
import { isAppError, logErrorKind } from "../lib/vault-creation-logging";
import type { BeginResult } from "../types/protocol-error";

interface CreateVaultProps {
  onBack: () => void;
  /**
   * Auto-unlock success — `vault_unlock(password)` resolved after
   * `commit`, slot is populated, route directly to editor. PRD Q4(a).
   */
  onAutoUnlockSuccess: () => void;
  /**
   * Auto-unlock failure (defansif) — `commit` succeeded but the
   * chained `vault_unlock` call rejected (rare, almost certainly a
   * transient backend failure since the same password just succeeded
   * inside `commit`). Route to `unlock(Exists)` so the user can
   * retype manually.
   */
  onAutoUnlockFailed: () => void;
}

export function CreateVault({
  onBack,
  onAutoUnlockSuccess,
  onAutoUnlockFailed,
}: CreateVaultProps) {
  const [state, dispatch] = useReducer(vaultCreationReducer, initialState);
  const [autoUnlocking, setAutoUnlocking] = useState(false);

  const sessionTokenRef = useRef<string | null>(null);
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
        if (!isSensitiveStep(stepRef.current)) return;
        let proceed: boolean;
        try {
          proceed = await dialogConfirm(
            "Closing will discard your recovery phrase. Continue closing?",
            {
              title: "Discard vault creation?",
              okLabel: "Close anyway",
              cancelLabel: "Cancel",
            },
          );
        } catch (e) {
          logErrorKind(e, "close-confirm-failed");
          event.preventDefault();
          return;
        }
        // Calling close() here would recursively re-fire onCloseRequested.
        if (!proceed) event.preventDefault();
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
      onAutoUnlockFailed();
      return;
    }
    setAutoUnlocking(true);
    try {
      await invoke("plugin:vault-unlock|unlock", { password });
      passwordRef.current = null;
      onAutoUnlockSuccess();
    } catch (e) {
      passwordRef.current = null;
      logErrorKind(e, "auto-unlock-failed");
      onAutoUnlockFailed();
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
          dispatch({ type: "BEGIN_ERR", error: GENERIC_ERROR });
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
        await invoke("plugin:vault-creation|commit", { sessionToken: token });
        if (cancelled) return;
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
          dispatch({ type: "COMMIT_ERR", error: GENERIC_ERROR });
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
      return <ReadyStep onDone={handleAutoUnlock} pending={autoUnlocking} />;
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

const GENERIC_ERROR = {
  title: "Something went wrong",
  body: "Try again.",
  primaryAction: "retry",
  displayMode: "inline",
} as const;
