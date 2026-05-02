// Vault unlock screen — task 7 of `app-state-machine`.
//
// Mounts when Stage = `unlock`. Two rendering modes driven by
// `initialStatus`:
//   - `Exists`               → normal mode: password form
//   - `Corrupted` / `IoError` → corrupted mode: <FailClosedError />
//
// Normal-mode reducer state machine: `idle` (with optional banner from
// the prior failed attempt — password retained across the
// decrypting → idle bounce) | `decrypting` (input + submit disabled).
// `InvalidVaultMeta` mid-attempt switches the component into the same
// fail-closed surface as a boot-time corrupted vault — one-way, no
// return to the form within the session.

import { invoke } from "@tauri-apps/api/core";
import { useReducer, type CSSProperties, type FormEvent } from "react";
import { FailClosedError } from "../components/FailClosedError";
import {
  CARD_BODY_STYLE,
  CARD_TITLE_STYLE,
  CenteredCard,
} from "../components/primitives/CenteredCard";
import { Spinner } from "../components/Spinner";
import { closeApp } from "../lib/app-window";
import type { IoFailureKind, StageVaultStatus } from "../lib/stage";
import type { VaultUnlockError } from "../types/vault-unlock-error";

interface UnlockProps {
  initialStatus: StageVaultStatus;
  onUnlocked: () => void;
}

type UnlockState =
  | { kind: "idle"; password: string; error: string | null }
  | { kind: "decrypting"; password: string }
  | { kind: "corrupted-after-unlock" };

type UnlockAction =
  | { type: "set-password"; value: string }
  | { type: "submit" }
  | { type: "fail"; error: string }
  | { type: "fail-corrupted" }
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

type BannerOutcome = { kind: "banner"; text: string } | { kind: "corrupted" };

function ioBanner(kind: IoFailureKind): string {
  switch (kind) {
    case "PermissionDenied":
      return "Vault dosyasına erişim izni yok. Dosya izinlerini kontrol et.";
    case "NotFound":
      // Defensive — `vault_unlock` special-cases NotFound to
      // `VaultNotFound`; this branch is unreachable in practice.
      return "Vault dosyası bulunamadı. Uygulamayı yeniden başlat.";
    case "NoSpace":
    case "Other":
      return "Vault dosyası okunamıyor.";
  }
}

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
      // unlock attempt. Reaching this banner means the route guards
      // failed; the user-actionable repair is to navigate back into
      // the recovery flow.
      return {
        kind: "banner",
        text: "Kurtarma akışı yarıda kaldı. Önce yeni parolayı belirle.",
      };
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

const BANNER_STYLE: CSSProperties = {
  background: "var(--bg-3)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-3) var(--space-4)",
  fontSize: "var(--text-base)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-2)",
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

export function Unlock({ initialStatus, onUnlocked }: UnlockProps) {
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
        } else {
          dispatch({ type: "fail", error: outcome.text });
        }
      }
    })();
  };

  return (
    <CenteredCard>
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
        {error != null && (
          <div role="alert" style={BANNER_STYLE}>
            {error}
          </div>
        )}
        <button type="submit" disabled={submitDisabled} style={ctaStyle(submitDisabled)}>
          {decrypting && <Spinner size={14} style={{ borderWidth: 2 }} />}
          <span>{decrypting ? "Decrypting…" : "Aç"}</span>
        </button>
      </form>
    </CenteredCard>
  );
}
