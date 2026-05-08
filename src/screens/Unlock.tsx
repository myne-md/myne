// Vault unlock screen — task 7 of `app-state-machine`, extended with
// recovery-flow entry affordances per `recovery-from-phrase-ui` Task 8.
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
// suppressed in favor of an info banner + "Devam et" resume CTA;
// CTA dispatches `unlock.resume-recovery` to App.tsx, routing the
// user into recover(password-reset)).
//
// `InvalidVaultMeta` mid-attempt switches the component into the same
// fail-closed surface as a boot-time corrupted vault — one-way, no
// return to the form within the session.
//
// **Cold-start recovery link.** In `idle` mode (Exists), a ghost-style
// "Parolanı mı unuttun? Recovery phrase ile aç" link below the
// primary CTA dispatches `unlock.start-recovery` → App routes Stage
// to `recover(phrase-entry)`. The link is suppressed during
// `decrypting`, `recovery-in-progress`, and fail-closed states.

import { invoke } from "@tauri-apps/api/core";
import { useReducer, type CSSProperties, type FormEvent } from "react";
import { DestructiveBanner } from "../components/DestructiveBanner";
import { FailClosedError } from "../components/FailClosedError";
import {
  CARD_BODY_STYLE,
  CARD_TITLE_STYLE,
  CenteredCard,
} from "../components/primitives/CenteredCard";
import { Spinner } from "../components/Spinner";
import { SuspicionBanner } from "../components/SuspicionBanner";
import { closeApp } from "../lib/app-window";
import { ioBanner } from "../lib/io-banner";
import type { StageVaultStatus, SuspicionReason } from "../lib/stage";
import type { VaultUnlockError } from "../types/vault-unlock-error";

interface UnlockProps {
  initialStatus: StageVaultStatus;
  onUnlocked: () => void;
  /** Cold-start recovery entry. Dispatched by the "Recovery phrase ile
   *  aç" link in idle mode. App.tsx sends `unlock.start-recovery` →
   *  Stage transitions to `recover(phrase-entry)`. */
  onStartRecovery: () => void;
  /** Resume recovery entry. Dispatched by the "Devam et" CTA on the
   *  `VaultRecoveryInProgress` info banner. App.tsx sends
   *  `unlock.resume-recovery` → Stage transitions to
   *  `recover(password-reset)`. */
  onResumeRecovery: () => void;
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
  | { kind: "recovery-in-progress" };

type UnlockAction =
  | { type: "set-password"; value: string }
  | { type: "submit" }
  | { type: "fail"; error: string }
  | { type: "fail-corrupted" }
  | { type: "fail-recovery-in-progress" }
  | { type: "success" };

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
      // component to a banner + "Devam et" surface; the password form
      // is suppressed (typing a password while the slot is recovering
      // is meaningless — the user must complete A8f first).
      return { kind: "recovery-in-progress" };
    case "success":
      // Stay in `decrypting` until parent transitions Stage → editor
      // and this component unmounts. Switching to a `success` variant
      // would briefly render an idle-empty state before unmount.
      return state;
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
      // §7.3 LITERAL compound — UI does NOT collapse to "Yanlış parola"
      // alone (would silently weaken the non-distinguishing posture).
      return {
        kind: "banner",
        text: "Yanlış parola veya vault dosyası bozuk.",
      };
    case "InvalidVaultMeta":
      return { kind: "corrupted" };
    case "IoError":
      return { kind: "banner", text: ioBanner(e.detail.io_error_kind) };
    case "VaultNotFound":
      return {
        kind: "banner",
        text: "Vault dosyası bulunamadı. Uygulamayı yeniden başlat.",
      };
    case "VaultAlreadyUnlocked":
      return { kind: "banner", text: "Vault zaten açık." };
    case "UnlockInProgress":
      return { kind: "banner", text: "İşlem devam ediyor." };
    case "VaultRecoveryInProgress":
      // Slot is in Slot::Recovering — user must complete the
      // password-reset chained step (recovery-flow.md §4.1) before any
      // unlock attempt. Switch into the `recovery-in-progress` mode so
      // the user can dispatch `unlock.resume-recovery` via the Devam
      // et CTA.
      return { kind: "recovery-in-progress" };
    case "JoinFailure":
      return {
        kind: "banner",
        text: "Beklenmeyen hata. Lütfen tekrar dene.",
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
  onUnlocked,
  onStartRecovery,
  onResumeRecovery,
  suspicionReason,
}: UnlockProps) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  // Boot-time corrupted/IoError mode: render <FailClosedError /> from
  // the first frame; password form never mounts.
  if (initialStatus.kind === "Corrupted") {
    return (
      <FailClosedError reason={{ kind: "corrupted-vault" }} onCtaClick={() => void closeApp()} />
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
      <FailClosedError reason={{ kind: "corrupted-vault" }} onCtaClick={() => void closeApp()} />
    );
  }

  // Recovery-in-progress mode: an unlock attempt returned
  // `VaultRecoveryInProgress`. Render an info banner + Devam et CTA;
  // password form is suppressed.
  if (state.kind === "recovery-in-progress") {
    return (
      <CenteredCard>
        <h1 style={CARD_TITLE_STYLE}>Kurtarma akışı yarıda kaldı.</h1>
        <p style={CARD_BODY_STYLE}>
          Önce yeni parolanı belirle, vault'unu yeniden mühürle.
        </p>
        <div role="alert" style={INFO_BANNER_STYLE}>
          Kurtarma akışı yarıda kaldı. Önce yeni parolayı belirle.
        </div>
        <button type="button" onClick={onResumeRecovery} style={ctaStyle(false)}>
          <span>Devam et</span>
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
        await invoke<void>("plugin:vault-unlock|unlock", { password });
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
      <h1 style={CARD_TITLE_STYLE}>Vault'unu aç.</h1>
      <p style={CARD_BODY_STYLE}>Parolanı gir, devam et.</p>
      <form style={FORM_STYLE} onSubmit={onSubmit} noValidate>
        <input
          type="password"
          placeholder="Parolan"
          value={password}
          onChange={(e) => dispatch({ type: "set-password", value: e.currentTarget.value })}
          disabled={decrypting}
          autoFocus
          autoComplete="current-password"
          style={INPUT_STYLE}
          aria-label="Parolan"
          aria-invalid={error != null ? true : undefined}
        />
        {error != null && <DestructiveBanner>{error}</DestructiveBanner>}
        <button type="submit" disabled={submitDisabled} style={ctaStyle(submitDisabled)}>
          {decrypting && <Spinner size={14} style={{ borderWidth: 2 }} />}
          <span>{decrypting ? "Decrypting…" : "Aç"}</span>
        </button>
        {!decrypting && (
          <button type="button" onClick={onStartRecovery} style={RECOVER_LINK_STYLE}>
            Parolanı mı unuttun? Recovery phrase ile aç
          </button>
        )}
      </form>
    </CenteredCard>
  );
}
