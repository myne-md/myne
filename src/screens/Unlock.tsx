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
// **One credential at a time (MYND-558).** Orthogonal to the reducer
// above, `idle`/`decrypting` render exactly one credential surface,
// picked by the derived `surface` union: `"pending"` while the
// `quick_unlock_status` probe is in flight (NEITHER field is rendered —
// the probe is a local IPC that settles in milliseconds, and showing the
// password form first would flash exactly the double-prompt this fixes);
// `"quick"` when quick-unlock is redeemable and the user has not opted
// out, which gives the PIN / Touch ID surface the screen; `"password"`
// otherwise, unchanged from before. `passwordRevealed` is the user's own
// override — the "Use password instead" link swaps a redeemable
// quick-unlock for the password form, and a matching "Unlock with PIN
// instead" link swaps back, so neither side is a cul-de-sac.
//
// This screen owns the probe rather than `<QuickUnlockEntry>`, because
// the answer decides the layout: a child that probed for itself would
// have to report upward and would re-probe (rendering an empty card in
// the gap) every time the user toggled back to it. The child's one
// upward signal is `onUnavailable` — the credential just proved dead
// mid-session (attempts exhausted), which drops to the password form
// permanently, with no way back.
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
// no-keys arm); on Ok or PartialDelete-Continue the parent reprobes and
// boot routing picks the return surface by remaining vault count.
// See `decisions.md` 2026-05-26 entry "MYND-108-bis vault_delete
// extended to accept Slot::Empty + vault.meta-exists".

import { invoke } from "../platform/core";
import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { appDataDir, join } from "../platform/path";
import { useRevealAfterIdleLock } from "../hooks/useRevealAfterIdleLock";
import i18n from "../i18n";
import { DestructiveBanner } from "../components/DestructiveBanner";
import { DeleteVaultConfirmForm } from "../components/DeleteVaultConfirmForm";
import { FailClosedError } from "../components/FailClosedError";
import { QuickUnlockEntry } from "../components/QuickUnlockEntry";
import {
  CARD_BODY_STYLE,
  CARD_TITLE_STYLE,
  CenteredCard,
  ctaStyle,
} from "../components/primitives/CenteredCard";
import { Spinner } from "../components/Spinner";
import { SuspicionBanner } from "../components/SuspicionBanner";
import { failClosedExit, FAIL_CLOSED_EXIT_LABEL_KEY } from "../platform/app-exit";
import { ioBanner } from "../lib/io-banner";
import { quickUnlockStatus, type QuickUnlockMethod } from "../lib/quick-unlock";
import { listVaults, soleVaultId } from "../lib/vault-list";
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
  /**
   * Back-to-picker affordance. App.tsx always wires this (the
   * `unlock.back-to-picker` transition is unconditional); the link itself
   * renders in idle mode only when ≥2 vaults exist (probed here), so it also
   * reaches the vault selector after a MANUAL lock or auto-lock — not just a
   * picker-reached unlock. Dispatches `unlock.back-to-picker` → `picker`.
   */
  onBack?: () => void;
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
   * Fired on `vault_delete` IPC Ok from the `delete-vault` sub-view
   * (MYND-108-bis lost-credentials cul-de-sac escape) OR on the user's
   * Continue click after a PartialDelete/Io banner. App.tsx reprobes;
   * boot routing picks the return surface by remaining vault count
   * (picker at ≥2, unlock at 1, welcome at 0). Backend accepts via
   * `Slot::Empty + vault.meta-exists` no-keys arm per `decisions.md`
   * 2026-05-26 entry "MYND-108-bis vault_delete extended to accept
   * Slot::Empty + vault.meta-exists".
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
        text: i18n.t("unlock.errors.vaultNotFound"),
      };
    case "VaultAlreadyUnlocked":
      return { kind: "banner", text: i18n.t("unlock.errors.alreadyUnlocked") };
    case "UnlockInProgress":
      return { kind: "banner", text: i18n.t("unlock.errors.inProgress") };
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
        text: i18n.t("unlock.errors.unexpected"),
      };
    case "KdfMemoryExceedsHostCapability":
      // A plain banner, deliberately NOT the `corrupted` mode. The vault is
      // intact and opens on desktop — routing to "restore from a backup" would
      // send the user to destroy a working vault over a client limitation.
      // The copy names desktop as the way in, which is the only action that
      // resolves this (phase3-web-client task 31).
      return {
        kind: "banner",
        text: i18n.t("unlock.errors.kdfMemoryExceedsHost", {
          required: e.detail.required_mib,
          available: e.detail.available_mib,
        }),
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

// Neutral ghost back link to the vault picker. Placed at the top of the
// card, left-aligned with a leading chevron — a navigational affordance
// distinct from the accent recovery link and the danger delete link below
// the form, so it doesn't compete with the primary Unlock CTA.
const BACK_LINK_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  padding: 0,
  alignSelf: "flex-start",
  display: "flex",
  alignItems: "center",
  gap: "var(--space-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-2)",
  cursor: "pointer",
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

export function Unlock({
  initialStatus,
  vaultId,
  onUnlocked,
  onBack,
  onStartRecovery,
  onResumeRecovery,
  onDeleteVaultSuccess,
  onRestoreBackup,
  suspicionReason,
}: UnlockProps) {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  /**
   * The redeemable quick-unlock method (MYND-558). `undefined` = the status
   * probe below is still in flight; a method = quick-unlock owns the screen;
   * `null` = it is offering nothing, so the password form does.
   */
  const [quickMethod, setQuickMethod] = useState<QuickUnlockMethod | null | undefined>(
    undefined,
  );
  /** User traded a redeemable quick-unlock for the password form. */
  const [passwordRevealed, setPasswordRevealed] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Show the back-to-picker link whenever ≥2 vaults exist — so a manual lock or
  // auto-lock reaches the vault selector too, not only a picker-reached unlock.
  // Probed on mount (fresh after any lock; the picker is a meaningful
  // destination only with another vault to switch to).
  const [otherVaultsExist, setOtherVaultsExist] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void listVaults().then(
      (res) => {
        if (!cancelled) setOtherVaultsExist("ok" in res && res.ok.length >= 2);
      },
      () => {
        if (!cancelled) setOtherVaultsExist(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // MYND-558 — which credential surface owns the screen. `available` (not
  // `configured`) is the gate: on a cold start the credential exists but the
  // spring-loaded session gate is closed, so redeeming would fail
  // `RequiresFullPassword`. Resolving to `null` there is what makes a fresh
  // launch show only the password form; the PIN field returns after the first
  // full unlock + an auto-lock in the same session.
  //
  // A rejected or garbled probe is a "no quick-unlock" answer, not a dead end —
  // settling in BOTH arms is what keeps the card from sitting in `"pending"`
  // with no credential field at all.
  useEffect(() => {
    let alive = true;
    // Re-probing means the target vault changed, so the previous vault's answer
    // is stale: drop back to `pending` rather than offering its surface for the
    // length of the new probe. Unreachable today (`stage.ts` has no
    // unlock → unlock transition, so a vault switch remounts this screen), and
    // cheap insurance for whoever adds one.
    setQuickMethod(undefined);
    setPasswordRevealed(false);
    quickUnlockStatus(vaultId)
      .then((s) => {
        if (alive) setQuickMethod(s.available && s.method != null ? s.method : null);
      })
      .catch(() => {
        if (alive) setQuickMethod(null);
      });
    return () => {
      alive = false;
    };
  }, [vaultId]);

  // MYND-121 — re-show the window after an idle-lock hid it. Gating the show on
  // REACHING this screen is the safety property: a hung renderer never reloads
  // to here, so it never re-exposes plaintext. Shared with `VaultPicker`, the
  // other locked boot surface (MYND-628) — see the hook for why both need it.
  useRevealAfterIdleLock();

  // MYND-108-bis delete-vault sub-view. Mounts when the user clicks
  // the tertiary "Lost both password and recovery phrase? Delete vault
  // and start over" link below the recovery link. The IPC accepts via
  // `Slot::Empty + vault.meta-exists` (backend's no-keys arm).
  if (state.kind === "delete-vault") {
    const handleDeleteSubmit = () => {
      dispatch({ type: "delete-vault-in-flight" });
      void (async () => {
        try {
          // Required target since #250. The screen already holds the chosen
          // vault's id; the single-vault entry that carries none resolves the
          // sole vault from disk. At ≥2 vaults with no id there is no
          // unambiguous answer — refuse rather than erase a guess.
          const target = vaultId ?? (await soleVaultId());
          if (!mountedRef.current) return;
          if (target == null) {
            if (import.meta.env.DEV) {
              // eslint-disable-next-line no-console
              console.warn("[Unlock] vault_delete refused: ambiguous target");
            }
            dispatch({ type: "delete-vault-bug-canary" });
            return;
          }
          await deleteVault(target);
          if (!mountedRef.current) return;
          // Resolve = full success. Slot stayed Empty (no state change);
          // vault directory recursively removed. Parent reprobes; boot
          // routing picks the return surface by remaining vault count,
          // this component unmounts.
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
        onCtaClick={() => void failClosedExit()}
        ctaLabelKey={FAIL_CLOSED_EXIT_LABEL_KEY}
        onRestoreBackup={onRestoreBackup}
      />
    );
  }
  if (initialStatus.kind === "IoError") {
    return (
      <FailClosedError
        reason={{ kind: "io-error", ioKind: initialStatus.ioKind }}
        onCtaClick={() => void failClosedExit()}
        ctaLabelKey={FAIL_CLOSED_EXIT_LABEL_KEY}
      />
    );
  }

  // Post-attempt corrupted mode: an `InvalidVaultMeta` mid-flight
  // switches the component to the same fail-closed surface as boot.
  if (state.kind === "corrupted-after-unlock") {
    return (
      <FailClosedError
        reason={{ kind: "corrupted-vault" }}
        onCtaClick={() => void failClosedExit()}
        ctaLabelKey={FAIL_CLOSED_EXIT_LABEL_KEY}
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
        <h1 style={CARD_TITLE_STYLE}>{t("unlock.recoveryInterruptedTitle")}</h1>
        <p style={CARD_BODY_STYLE}>{t("unlock.recoveryInterruptedBody")}</p>
        <div
          role="alert"
          data-testid="unlock.recovery-in-progress-banner"
          style={INFO_BANNER_STYLE}
        >
          {t("unlock.recoveryInterruptedBanner")}
        </div>
        <button
          type="button"
          onClick={onResumeRecovery}
          style={ctaStyle(false)}
          data-testid="unlock.resume-cta"
        >
          <span>{t("unlock.continue")}</span>
        </button>
      </CenteredCard>
    );
  }

  const decrypting = state.kind === "decrypting";
  const password = state.password;
  const error = state.kind === "idle" ? state.error : null;
  const submitDisabled = decrypting || password.length === 0;

  // MYND-558 one-credential-at-a-time split. `"pending"` renders NEITHER field:
  // for the few milliseconds the probe is in flight the card shows its heading
  // alone rather than flashing a password form it is about to replace.
  const surface: "pending" | "quick" | "password" =
    quickMethod === undefined
      ? "pending"
      : quickMethod !== null && !passwordRevealed
        ? "quick"
        : "password";

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
      {/* Back to the vault picker — shown whenever ≥2 vaults exist (App always
          wires `onBack`), so a manual lock / auto-lock can reach the vault
          selector too, not just a picker-reached unlock. Suppressed during
          `decrypting` so an in-flight unlock isn't abandoned mid-IPC. */}
      {onBack && otherVaultsExist && !decrypting && (
        <button
          type="button"
          onClick={onBack}
          style={BACK_LINK_STYLE}
          data-testid="unlock.back-to-picker"
        >
          <span aria-hidden="true">←</span>
          <span>{t("unlock.backToPicker")}</span>
        </button>
      )}
      {suspicionReason && <SuspicionBanner reason={suspicionReason} />}
      <h1 style={CARD_TITLE_STYLE}>{t("unlock.title")}</h1>
      {/* Method-aware subtitle: the PIN / Touch ID surface must not tell the user
          to "enter your password" (MYND — the primary surface is not a password
          when quick-unlock owns the screen). */}
      <p style={CARD_BODY_STYLE}>
        {t(
          surface === "quick"
            ? quickMethod === "biometric"
              ? "unlock.subtitleBiometric"
              : "unlock.subtitlePin"
            : "unlock.subtitle",
        )}
      </p>
      {/* Quick-unlock (PIN / Touch ID) — the primary surface when the probe
          above says it is redeemable and the user hasn't opted out (MYND-329,
          MYND-558). The password escape hatch sits one click below it:
          quick-unlock is a convenience gate, not a replacement, so a user who
          has forgotten the PIN reaches the master password without restarting
          the app. */}
      {surface === "quick" && quickMethod != null && (
        <>
          <QuickUnlockEntry
            vaultId={vaultId}
            method={quickMethod}
            onUnlocked={onUnlocked}
            onUnavailable={() => setQuickMethod(null)}
          />
          <button
            type="button"
            onClick={() => setPasswordRevealed(true)}
            style={RECOVER_LINK_STYLE}
            data-testid="unlock.use-password-link"
          >
            {t("unlock.usePasswordInstead")}
          </button>
        </>
      )}
      {/* `data-vault-id` mirrors the picker-row idiom (SYNC-8): the
          vault-addressed unlock target threaded from the Stage payload,
          observable to the E2E suite (MYND-127 story 2). Absent when the
          backend's sole-vault `None` path applies. */}
      {surface === "password" && (
        <form
          style={FORM_STYLE}
          onSubmit={onSubmit}
          noValidate
          data-testid="unlock.form"
          data-vault-id={vaultId}
        >
          <input
            type="password"
            placeholder={t("unlock.passwordPlaceholder")}
            value={password}
            onChange={(e) => dispatch({ type: "set-password", value: e.currentTarget.value })}
            disabled={decrypting}
            autoFocus
            autoComplete="current-password"
            style={INPUT_STYLE}
            aria-label={t("unlock.passwordLabel")}
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
            <span>{decrypting ? t("unlock.decrypting") : t("unlock.submit")}</span>
          </button>
          {/* Way back to the quick surface the user traded away — rendered only
              when quick-unlock is still redeemable, so an exhausted or
              unconfigured credential is never re-offered. */}
          {quickMethod != null && !decrypting && (
            <button
              type="button"
              onClick={() => setPasswordRevealed(false)}
              style={RECOVER_LINK_STYLE}
              data-testid="unlock.use-quick-unlock-link"
            >
              {quickMethod === "biometric"
                ? t("unlock.useBiometricInstead", {
                    biometric: t("settings.quickUnlock.methodTouchId"),
                  })
                : t("unlock.unlockWithPinInstead")}
            </button>
          )}
          {!decrypting && (
            <button
              type="button"
              onClick={onStartRecovery}
              style={RECOVER_LINK_STYLE}
              data-testid="unlock.recovery-link"
            >
              {t("unlock.recoveryLink")}
            </button>
          )}
          {!decrypting && (
            <button
              type="button"
              onClick={() => dispatch({ type: "request-delete-vault" })}
              style={DELETE_VAULT_LINK_STYLE}
              data-testid="unlock.delete-link"
            >
              {t("unlock.deleteLink")}
            </button>
          )}
        </form>
      )}
    </CenteredCard>
  );
}
