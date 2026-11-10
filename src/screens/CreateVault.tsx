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
//   - Q8.2 onCloseRequested prompt for sensitive steps (kit / confirm);
//     membership decided via isSensitiveStep() in reducer.ts.
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
import { confirm as dialogConfirm } from "../platform/dialog";
import { registerCloseGuard } from "../lib/close-request";
import i18n from "../i18n";
import { HAS_TAURI } from "../lib/app-window";
import { has } from "../platform/capabilities";
import { deploymentSyncOrigin } from "../platform/deployment-config";
import {
  vaultCreationReducer,
  makeInitialState,
  isSensitiveStep,
  type Step,
} from "./vault-creation";
import { BriefingStep } from "./vault-creation/BriefingStep";
import { NameStep } from "./vault-creation/NameStep";
import { PasswordStep } from "./vault-creation/PasswordStep";
import { EncryptingStep } from "./vault-creation/EncryptingStep";
import { KitStep } from "./vault-creation/KitStep";
import { ConfirmStep } from "./vault-creation/ConfirmStep";
import { ReadyStep } from "./vault-creation/ReadyStep";
import { SessionLostStep } from "./vault-creation/SessionLostStep";
import { ProvisioningStep } from "./vault-creation/ProvisioningStep";
import { mapAppErrorToUserMessage } from "../lib/vault-creation-errors";
import { isAppError, logErrorKind } from "../lib/vault-creation-logging";
import { seedExampleVault } from "../notes/exampleVault";
import { setVaultLabel } from "../lib/prefs";
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

/**
 * Whether this client can create an account at all.
 *
 * Gated on the CAPABILITY rather than on the Tauri global, which is what
 * `decisions.md` 2026-08-15 changed. `HAS_TAURI` answers "am I inside a Tauri
 * WebView", and until creation shipped on web that happened to be the same
 * question. It is not any more: the web client dispatches the three creation
 * commands through the wasm router, so gating on the global here would have left
 * a working backend unreachable from the one screen that drives it.
 *
 * `HAS_TAURI` is still the right test for the window-close listener below, which
 * is genuinely a Tauri API rather than a feature.
 */
const CAN_CREATE = has("vaultCreation");

/**
 * Whether the local vault must be registered with a sync server as part of
 * creation, before the recovery phrase is shown.
 *
 * Derived from the ABSENCE of `localOnlyVault` rather than from a flag of its
 * own, because that capability already carries exactly this fact:
 * `decisions.md` 2026-07-26 makes sync required on the web client, so its OPFS
 * container is a cache of a server-held vault rather than the vault itself. A
 * client where a vault may be the only copy has nothing to register and no
 * server leg to fail.
 */
const REQUIRES_PROVISIONING = !has("localOnlyVault");

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
  // The shared invite code for a gated sync server (myne-md/myne#800).
  //
  // The field that collected it lived on the account step, which this branch
  // folded into `KitStep`. The provisioning leg runs immediately after `begin`
  // (before `kit`), so a field on any later step could never reach
  // `sync_set_endpoint`; the code is entered on the sync-connection surface
  // instead (`IdentitySetupDialog` → `EndpointConfig`). Kept as an empty
  // literal rather than deleted so the provisioning call below keeps its shape.
  const inviteCode = "";

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
    const MOCK_VAULT_NAME = "Personal";
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
    // `name` when there is no briefing). `name` itself needs no further
    // dispatch — the ladder below matches nothing and the effect ends there.
    if (target === "briefing") return;
    dispatch({ type: "BRIEFING_ACKED" });
    if (target === "name") return;
    // Every target past the name step walks through it, with a name, so the
    // captured kit screen shows the header a real run would show.
    dispatch({ type: "NAME_CHANGED", value: MOCK_VAULT_NAME });
    dispatch({ type: "NAME_SUBMITTED" });
    if (target === "encrypting") {
      dispatch({ type: "BEGIN_REQUESTED" });
    } else if (target === "kit") {
      beginOk();
    } else if (target === "confirm") {
      beginOk();
      dispatch({ type: "PHRASE_REVEALED" });
      dispatch({ type: "PHRASE_ACKED" });
    } else if (target === "committing") {
      beginOk();
      dispatch({ type: "PHRASE_REVEALED" });
      dispatch({ type: "PHRASE_ACKED" });
      dispatch({ type: "COMMIT_REQUESTED" });
    } else if (target === "ready") {
      beginOk();
      dispatch({ type: "PHRASE_REVEALED" });
      dispatch({ type: "PHRASE_ACKED" });
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
      if (!CAN_CREATE) return;
      const token = sessionTokenRef.current;
      if (token) {
        invoke("plugin:vault-creation|cancel", { sessionToken: token }).catch(
          (e: unknown) => logErrorKind(e, "cancel-failed"),
        );
      }
    };
  }, []);

  // The creation ceremony's contribution to the close intercept, as a GUARD
  // (myne-md/myne#945 item 05): the one `tauri://close-requested` listener lives
  // in `src/lib/close-request.ts` for the life of the process, and this surface
  // answers what it owns - the plan is sensitive until it stops being.
  //
  // The plan's answer is a confirmation prompt on every SENSITIVE step (kit and
  // confirm): leaving there destroys the only copy of a recovery phrase, and the
  // step is read LIVE from `stepRef` because the guard is registered once and the
  // step changes underneath it.
  useEffect(() => {
    if (!HAS_TAURI) return;
    return registerCloseGuard({
      id: "create-vault",
      onCloseRequest: async () => {
        if (!isSensitiveStep(stepRef.current)) return true;
        try {
          return await dialogConfirm(
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
          return false; // keep the window open if the confirm prompt failed
        }
      },
    });
  }, []);

  // Lifetime: PasswordStep submit → auto-unlock resolve. Wiped on every
  // exit path (BEGIN_ERR / COMMIT_ERR / SESSION_LOST / RESET_TO_PASSWORD /
  // auto-unlock resolve / unmount). TS-side wipe is best-effort; the
  // load-bearing zeroize is Rust-side inside `Zeroizing<String>`.
  const passwordRef = useRef<string | null>(null);

  const handlePasswordSubmit = (password: string) => {
    passwordRef.current = password;
    // A live token here means the previous attempt left a session behind, which
    // is exactly what a person-born vault's failed commit does: it has no kit
    // and no confirm step to retry from, so the reducer sends the user back to
    // this screen. Dropping the session keeps the four-slot cap from being spent
    // on attempts nobody will finish (myne-md/myne#911 task 5).
    const stale = sessionTokenRef.current;
    if (stale) {
      sessionTokenRef.current = null;
      invoke("plugin:vault-creation|cancel", { sessionToken: stale }).catch(
        (e: unknown) => logErrorKind(e, "cancel-failed"),
      );
    }
    dispatch({ type: "BEGIN_REQUESTED" });
  };

  /**
   * Apply the name from the `name` step as the new vault's label.
   *
   * It has to happen HERE, after the chained `vault_unlock`, and not at commit
   * time: `prefs|vault_set_label` writes into `vault.prefs` under the active
   * vault's `prefs_key`, so it is unlock-gated and there is no unlocked slot
   * until the line above it resolves. Empty means the user left the step blank,
   * which is allowed — the picker's neutral fallback is the right answer then,
   * and writing `null` would be indistinguishable from it while costing a write.
   *
   * Best-effort, like `seedExampleVault` beside it and for the same reason: the
   * vault exists and is open, so a failed rename must not bounce a successfully
   * unlocked user back to the manual-unlock fallback. The name is one Settings
   * field away; the vault is not.
   */
  const applyVaultLabel = async (name: string) => {
    if (name.length === 0) return;
    try {
      await setVaultLabel(name);
    } catch (e) {
      logErrorKind(e, "vault-label-failed");
    }
  };

  const handlePhraseBack = () => {
    if (CAN_CREATE) {
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
    if (!password || !CAN_CREATE) {
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
      await applyVaultLabel(state.vaultName);
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
    if (!CAN_CREATE) return;
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
          // Where sync is required this does NOT show the phrase yet. See
          // `ProvisioningStep` for why the ordering is load-bearing.
          requiresProvisioning: REQUIRES_PROVISIONING,
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

  /**
   * The provisioning leg: write the vault, then make the account real on the
   * server, and only then let the phrase reach the screen.
   *
   * Order and rationale are normative (`decisions.md` 2026-08-15). What runs
   * here is `commit` -> `sync_set_endpoint` -> `sync_enroll`, and the enrolment
   * is what registers the SCRAM verifier (`POST /auth/register`, idempotent
   * core-side: a `409 already_registered` is treated as success, so a lost
   * response needs no handling on this side), enrols this browser, and seeds
   * `vault.meta` to the server so a second device can fetch it.
   *
   * **The failure path erases.** Anything that goes wrong before the phrase is
   * shown leaves nothing behind: the container is deleted and the session is
   * cancelled, so the user is told plainly that no account was created rather
   * than being left with a browser vault this client's own rules
   * (`decisions.md` 2026-07-26, sync required) say cannot exist. The phrase was
   * never displayed, so there is nothing they wrote down that a retry would
   * invalidate.
   */
  useEffect(() => {
    if (!CAN_CREATE) return;
    if (state.step !== "provisioning") return;
    const token = sessionTokenRef.current;
    const password = passwordRef.current;
    const accountNumber = state.accountNumber;
    if (!token || !password || !accountNumber) return;
    let cancelled = false;
    (async () => {
      let vaultId: string | null = null;
      try {
        vaultId = await invoke<string | null>("plugin:vault-creation|commit", {
          sessionToken: token,
        });
        if (cancelled) return;
        committedVaultIdRef.current = vaultId;
        sessionTokenRef.current = null;

        // The origin comes from the deployment, not from a field the user
        // fills in: the same resolution the browser's entry path performs, and
        // for the same reason (task 50 fixes the origin at container start, so
        // there is no endpoint stored before the first call that would need
        // one).
        const cfg = await invoke<{ endpoint_url: string | null } | null>(
          "plugin:sync|sync_get_endpoint",
        );
        const serverUrl = cfg?.endpoint_url ?? (await deploymentSyncOrigin());
        if (serverUrl === null) throw new Error("no sync endpoint configured");
        if (cfg?.endpoint_url == null || inviteCode.trim().length > 0) {
          await invoke("plugin:sync|sync_set_endpoint", {
            endpointUrl: serverUrl,
            inviteCode: inviteCode.trim(),
          });
        }

        // `credentialKind: "password"` is the only kind this client may send.
        // The recovery kind is refused structurally in the wasm router
        // (`decisions.md` 2026-08-15 keeps phrase-credential enrolment off web),
        // and this call has no reason to reach for it: the password was typed
        // one step ago.
        await invoke("plugin:sync|sync_enroll", {
          accountNumber,
          credential: password,
          credentialKind: "password",
        });
        if (cancelled) return;
        dispatch({ type: "PROVISION_OK" });
      } catch (e) {
        if (cancelled) return;
        logErrorKind(e, "provision");
        // Erase what was written. Best-effort by necessity — if this fails the
        // user is left with a container the entry screen will treat as an
        // un-joined browser, which is recoverable — but it is attempted before
        // the error is shown, so the common case leaves nothing behind.
        if (vaultId) {
          await invoke("plugin:vault-delete|vault_delete", { vaultId }).catch(
            (err: unknown) => logErrorKind(err, "provision-rollback-failed"),
          );
        }
        const stale = sessionTokenRef.current;
        if (stale) {
          await invoke("plugin:vault-creation|cancel", {
            sessionToken: stale,
          }).catch((err: unknown) => logErrorKind(err, "cancel-failed"));
          sessionTokenRef.current = null;
        }
        passwordRef.current = null;
        committedVaultIdRef.current = null;
        dispatch({
          type: "PROVISION_ERR",
          error: isAppError(e)
            ? mapAppErrorToUserMessage(e)
            : provisionFailedError(),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.step, state.accountNumber]);

  useEffect(() => {
    if (!CAN_CREATE) return;
    if (state.step !== "committing") return;
    // Already written, and written BEFORE the phrase was shown. The step still
    // exists on this client because the flow's shape is shared; what it must not
    // do is commit a second time, which the session token no longer permits
    // anyway (it was consumed) and which would surface as a confusing
    // SessionNotFound at the very end of a successful creation.
    if (REQUIRES_PROVISIONING) {
      dispatch({ type: "COMMIT_OK" });
      return;
    }
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
    case "name":
      return (
        <NameStep
          value={state.vaultName}
          onChange={(value) => dispatch({ type: "NAME_CHANGED", value })}
          onSubmit={() => dispatch({ type: "NAME_SUBMITTED" })}
          onBack={onBack}
        />
      );
    case "password":
      return (
        <PasswordStep
          error={state.error}
          onBack={() => dispatch({ type: "PASSWORD_BACK" })}
          onSubmit={handlePasswordSubmit}
        />
      );
    case "encrypting":
      return <EncryptingStep />;
    // Deliberately NOT next to `committing`: that label shares a fall-through
    // with `confirm`, so a case inserted between them silently steals the
    // confirm step's return. This one stands alone.
    case "provisioning":
      return <ProvisioningStep expectsPhrase={state.phrase !== null} />;
    case "kit":
      return (
        <KitStep
          phrase={state.phrase ?? []}
          accountNumber={state.accountNumber ?? ""}
          vaultName={state.vaultName}
          revealed={state.phraseRevealed}
          dispatch={dispatch}
          // Omitted where provisioning ran, so the Back control is not drawn.
          //
          // On that ordering `commit` has already written the vault and
          // `sync_enroll` has already registered the account by the time this
          // screen exists, and the effect nulls `sessionTokenRef` right after
          // `commit`. So `handlePhraseBack` would find no token, cancel
          // nothing, delete nothing, and dispatch `RESET_TO_PASSWORD`, which
          // clears `state.phrase`. The account survives; the twenty-four words
          // that are its only other credential do not, and they are never
          // re-displayed (`recovery-flow.md` §2.4).
          //
          // Rolling back instead of refusing would not be better: the local
          // erase is the only half a client can perform, and the registration
          // it cannot reach is exactly what makes the phrase still matter.
          onCancelSession={
            REQUIRES_PROVISIONING ? undefined : handlePhraseBack
          }
        />
      );
    case "confirm":
    case "committing":
      // A person-born vault has no phrase, so there is nothing to type back and
      // no challenge screen to render: `committing` arrived straight from
      // `BEGIN_OK` and the wait surface is the honest one (myne-md/myne#911
      // task 5). The `confirm` arm is unchanged for every phased flow.
      if (state.step === "committing" && state.phrase === null) {
        return <EncryptingStep />;
      }
      return (
        <ConfirmStep
          phrase={state.phrase ?? []}
          positions={state.confirmPositions ?? [1, 1, 1, 1]}
          inputs={state.confirmInputs}
          committing={state.step === "committing"}
          error={state.error}
          dispatch={dispatch}
        />
      );
    case "ready":
      return (
        <ReadyStep onDone={handleAutoUnlock} pending={autoUnlocking} />
      );
    case "session-lost":
      // SESSION_LOST and PROVISION_ERR are the two paths into this step, and
      // both carry an error, so the non-null assertion is type-safe per the
      // reducer. The assertion held before PROVISION_ERR existed and still
      // holds, but the comment is the stated justification for it, and the
      // next person to add a third path will read this rather than the reducer.
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
/**
 * The provisioning failure, and it is deliberately `dedicated` rather than
 * `inline`.
 *
 * An inline banner offers a retry, and there is nothing here to retry: the
 * container has been erased and the creation session cancelled, so the flow has
 * to start over from the password step with a fresh account number and a fresh
 * phrase. Saying so on its own screen is the honest shape, and it is also the
 * safe one — the phrase was never displayed, so nothing the user wrote down is
 * about to become silently wrong.
 */
function provisionFailedError() {
  return {
    title: i18n.t("vaultCreation.orchestrator.provisionFailed.title"),
    body: i18n.t("vaultCreation.orchestrator.provisionFailed.body"),
    primaryAction: "restart",
    displayMode: "dedicated",
  } as const;
}

function genericError() {
  return {
    title: i18n.t("vaultCreation.orchestrator.genericError.title"),
    body: i18n.t("common.tryagain"),
    primaryAction: "retry",
    displayMode: "inline",
  } as const;
}
