import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { CSSProperties, ReactNode } from "react";
import {
  Screen,
  Eyebrow,
  Button,
  Banner,
  BlockingOverlay,
  Sheet,
  Icon,
  MyneMark,
} from "../../components";
import { HAS_TAURI, closeApp } from "../../lib/app-window";
import { unlockWithPassword } from "../../lib/commands";
import { deleteVault } from "../../lib/vault-delete";
import { soleVaultId } from "../../lib/vault-list";
import {
  memberUnlockStatus,
  memberVaultStatus,
  personUnlockMemberVaultWithBiometric,
  personUnlockMemberVaultWithPassword,
  personUnlockMemberVaultWithPin,
  type MemberUnlockMethod,
} from "../../lib/personAccount";
import {
  quickUnlockStatus,
  quickUnlockWithPin,
  quickUnlockWithBiometric,
  type QuickUnlockStatus,
} from "../../lib/quick-unlock";
import { isQuickUnlockError } from "../../types/quick-unlock-error";
import { usePlatform } from "../../formfactor/PlatformContext";
import { ioBanner } from "../../lib/io-banner";
import {
  UNLOCK_NON_DISTINGUISHING_BANNER,
  LOST_BOTH_SECRETS_SENTENCE,
  MEMBER_VAULT_REMOVAL_DISCLOSURE,
} from "../../lib/load-bearing-copy";
import type { SuspicionReason } from "../../lib/stage";
import type { VaultUnlockError } from "../../types/vault-unlock-error";
import type { UnlockFlowProps } from "./types";

// ── The destructive-confirm sheet's text roles ────────────────────────────────
// Hoisted to one constant per role so the OWNER and MEMBER arms of the same
// sheet cannot drift apart — they render the same shapes with different copy —
// and bound to design tokens so a custom theme reaches them rather than being
// out-ranked by an inline literal (myne#394).

/** The uppercase eyebrow over the member heading. */
const CONFIRM_EYEBROW_STYLE: CSSProperties = {
  marginBottom: "var(--space-2)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase",
  color: "var(--danger)",
};

/** The sheet's heading — display ink. Shared by both arms. */
const CONFIRM_HEADING_STYLE: CSSProperties = {
  fontSize: "var(--text-lg)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "var(--tracking-tight)",
  color: "var(--fg-display)",
};

/** The body line under the heading. Shared by both arms. */
const CONFIRM_BODY_STYLE: CSSProperties = {
  margin: "var(--space-3) 0 0",
  fontSize: "var(--text-base)",
  lineHeight: 1.55,
  color: "var(--fg-2)",
};

/** Footnote weight for a claim that qualifies the arm above rather than being
 *  the one the user must act on (myne-md/myne#761). Token-bound and hoisted, so
 *  it matches the desktop form's secondary role instead of reading as a second
 *  body paragraph. */
const CONFIRM_NOTE_STYLE: CSSProperties = {
  margin: "var(--space-3) 0 0",
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-3)",
};

// ── On-design helpers (local, mirroring src/screens/unlock/index.tsx) ─────────

/** Wordmark: mark + "myne" (unlock screens use the 24/18 size). */
function Wordmark() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
      <MyneMark size={24} radius={6} />
      <span style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-1)" }}>
        myne
      </span>
    </div>
  );
}

/** The vault-name display title (display ink). Label is null pre-unlock, so a
 *  neutral fallback stands in for the design's "Personal" specimen. */
function VaultTitle({ size = 22, children }: { size?: number; children: ReactNode }) {
  return (
    <div style={{ marginTop: 8, fontSize: size, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-display)" }}>
      {children}
    </div>
  );
}

/** Tighter-tracked uppercase field label (0.06em) used over inputs. */
function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--fg-3)",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

/** Text-link button (accent by default; weight 600). */
function TextButton({
  children,
  onClick,
  color = "var(--accent)",
  height = 44,
  fontSize = 15,
  testId,
  style,
}: {
  children: ReactNode;
  onClick: () => void;
  color?: string;
  height?: number;
  fontSize?: number;
  testId?: string;
  style?: CSSProperties;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      style={{
        height,
        padding: 0,
        border: "none",
        background: "transparent",
        color,
        fontFamily: "var(--font-sans)",
        fontSize,
        fontWeight: 600,
        cursor: "pointer",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/**
 * Biometric scan glyph — bracket frame + either the Face ID face or a
 * fingerprint (local copy mirroring src/screens/unlock/index.tsx's
 * BiometricGlyph; `expression` swaps the smile for a frown on failure).
 */
function BiometricGlyph({
  mode = "face",
  color = "var(--accent)",
  expression = "neutral",
}: {
  mode?: "face" | "fingerprint";
  color?: string;
  expression?: "neutral" | "sad";
}) {
  return (
    <div style={{ width: 72, height: 72, position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <svg width="72" height="72" viewBox="0 0 72 72" fill="none" style={{ position: "absolute", inset: 0 }}>
        <path d="M4 22 V14 a10 10 0 0 1 10 -10 H22" stroke={color} strokeWidth="3" strokeLinecap="round" />
        <path d="M50 4 H58 a10 10 0 0 1 10 10 V22" stroke={color} strokeWidth="3" strokeLinecap="round" />
        <path d="M68 50 V58 a10 10 0 0 1 -10 10 H50" stroke={color} strokeWidth="3" strokeLinecap="round" />
        <path d="M22 68 H14 a10 10 0 0 1 -10 -10 V50" stroke={color} strokeWidth="3" strokeLinecap="round" />
        {mode === "face" && (
          <>
            <path d="M27 30 V34 M45 30 V34" stroke={color} strokeWidth="3" strokeLinecap="round" />
            <path d="M36 31 V40 M32 44 h8" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            <path
              d={expression === "sad" ? "M29 52 q7 -5 14 0" : "M29 50 q7 5 14 0"}
              stroke={color}
              strokeWidth="3"
              strokeLinecap="round"
              fill="none"
            />
          </>
        )}
      </svg>
      {mode === "fingerprint" && <Icon name="fingerprint" size={34} color={color} strokeWidth={2.2} />}
    </div>
  );
}

/** Top-left back affordance (accent chevron), shown only when the unlock screen
 *  was reached from the vault picker. Absolutely positioned so it clears the
 *  notch and doesn't disturb the centered column; mirrors FlowHeader's chevron
 *  (src/components/layout.tsx). Replaces the old bottom "Choose a different
 *  vault" text link — same destination, standard mobile placement. */
function BackToPickerButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onClick}
      aria-label={t("unlock.backToPicker")}
      data-testid="unlock-back-to-picker"
      style={{
        position: "absolute",
        top: "max(52px, calc(env(safe-area-inset-top) + 8px))",
        insetInlineStart: 12,
        zIndex: 3,
        width: 44,
        height: 44,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "none",
        background: "transparent",
        padding: 0,
        cursor: "pointer",
      }}
    >
      <Icon name="chevron-left" size={20} color="var(--accent)" strokeWidth={2} flip />
    </button>
  );
}

/** Functional masked password input, styled to the design's PasswordField
 *  geometry (h:52, accent focus ring, monospace, eye reveal toggle). */
function PasswordInput({
  value,
  onChange,
  onSubmit,
  error,
  numeric = false,
  ariaLabel,
  testId = "unlock-password",
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  error: boolean;
  numeric?: boolean;
  ariaLabel?: string;
  testId?: string;
}) {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(true);
  const [revealed, setRevealed] = useState(false);
  const active = focused || value.length > 0;
  const borderColor = error ? "var(--danger)" : active ? "var(--accent)" : "var(--line-2)";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 52,
        border: `${active || error ? 1.5 : 1}px solid ${borderColor}`,
        borderRadius: 6,
        background: "var(--bg-1)",
        padding: "0 14px",
        boxShadow: focused ? "0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent)" : "none",
      }}
    >
      <input
        type={revealed ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        autoFocus
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        inputMode={numeric ? "numeric" : undefined}
        aria-label={ariaLabel ?? t("unlock.passwordLabel")}
        data-testid={testId}
        style={{
          flex: 1,
          minWidth: 0,
          border: "none",
          outline: "none",
          background: "transparent",
          fontFamily: "var(--font-mono)",
          fontSize: revealed ? 16 : 14,
          letterSpacing: revealed ? "0" : "0.14em",
          color: "var(--fg-1)",
        }}
      />
      <button
        type="button"
        onClick={() => setRevealed((r) => !r)}
        aria-label={revealed ? t("password.input.hide") : t("password.input.show")}
        style={{ border: "none", background: "transparent", padding: 0, marginInlineStart: 8, cursor: "pointer", display: "flex" }}
      >
        <Icon name={revealed ? "eye-off" : "eye"} size={20} color="var(--fg-3)" strokeWidth={1.6} />
      </button>
    </div>
  );
}

// ── Copy maps ─────────────────────────────────────────────────────────────────

/** Suspicion-banner copy is LITERAL per stage.ts SuspicionReason docs. The map
 *  stores i18n KEYS (resolved with `t()` at the render site); the English values
 *  are byte-identical to the desktop `unlock.suspicion.*` catalog entries. */
const SUSPICION_COPY: Record<SuspicionReason, { textKey: string; kind: "danger" | "info" }> = {
  "vault-meta-changed-externally": {
    textKey: "unlock.suspicion.metaChangedExternally",
    kind: "danger",
  },
  "vault-locked-during-change": {
    textKey: "unlock.suspicion.lockedDuringChange",
    kind: "info",
  },
};

/** Map an unlock rejection to its banner string. The `InvalidCredentialOrVault`
 *  leg is the load-bearing non-distinguishing constant (rendered verbatim). */
function messageForUnlockError(e: unknown, t: TFunction): string {
  const err = e as VaultUnlockError;
  switch (err?.kind) {
    case "InvalidCredentialOrVault":
      return UNLOCK_NON_DISTINGUISHING_BANNER;
    case "IoError":
      return ioBanner(err.detail.io_error_kind);
    case "InvalidVaultMeta":
      return t("unlock.vaultUnreadable");
    default:
      return t("unlock.unlockFailedGeneric");
  }
}

// ── Flow ──────────────────────────────────────────────────────────────────────

/**
 * UN-05 · Password unlock — wired. Mirrors src/screens/unlock/index.tsx's
 * PasswordUnlock. Renders the password form for an `Exists` vault, or a
 * fail-closed surface for `Corrupted` / `IoError`. The typed password is held
 * in component-local state + a ref and wiped on every exit path / unmount.
 */
/** Which member credential the surface is offering (`"none"` when this device
 *  holds no credential at all, which needs a fresh invite rather than a phrase). */
type MemberUnlockMode = MemberUnlockMethod | "none";

export function UnlockFlow(props: UnlockFlowProps) {
  const { initialStatus, vaultId, suspicionReason, fromPicker, onBackToPicker } = props;
  const { t } = useTranslation();
  const { biometric, isAndroid } = usePlatform();

  const pwRef = useRef("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [showSuspicion, setShowSuspicion] = useState(!!suspicionReason);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);

  // Quick-unlock fast-path (PIN or Face ID / Touch ID). `qu.available` is true
  // only after a full master-password unlock happened THIS app session (the
  // spring-loaded gate), so it appears on an auto-lock re-entry — never on a
  // cold start. When available we default to the configured method's surface
  // with a "use password" escape hatch.
  const [qu, setQu] = useState<QuickUnlockStatus | null>(null);
  const [pinMode, setPinMode] = useState(false);
  const [pin, setPin] = useState("");
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [pinSubmitting, setPinSubmitting] = useState(false);
  const pinRef = useRef("");
  const setPinValue = useCallback((v: string) => {
    pinRef.current = v;
    setPin(v);
  }, []);

  // Biometric (Face ID / Touch ID) fast-path state. `failed` renders the
  // UN-02-style retry surface; the OS sheet itself is system UI we never draw.
  const [bioMode, setBioMode] = useState(false);
  const [bioFailed, setBioFailed] = useState(false);
  const [bioSubmitting, setBioSubmitting] = useState(false);
  const bioAutoTried = useRef(false);

  // B2B member vault: the boot surface offers the ONE device-local credential the
  // vault carries (`vault.member-unlock`, decisions/protocol/0653). There is no
  // recovery-phrase arm: `vault.member-key` is retired (myne-md/myne#938 task 12,
  // `0763`), so a device with no credential needs a fresh invite and not a phrase.
  // Detected once per mount.
  const [member, setMember] = useState(false);
  // `null` means NOT YET KNOWN, and it is a third state on purpose (myne-md/myne#938
  // review). It used to start at `"none"`, which is the answer for "this device
  // carries no member credential", so every member device rendered "ask the owner
  // for a fresh invite" for the length of the probe: a dead end painted over a
  // device that has a perfectly good password. The probe answers `"none"` on its
  // own; until it does, nothing is claimed.
  const [memberMode, setMemberMode] = useState<MemberUnlockMode | null>(null);
  const [memberPassword, setMemberPasswordInput] = useState("");
  const [memberPin, setMemberPinInput] = useState("");
  const [memberBusy, setMemberBusy] = useState(false);
  const [memberError, setMemberError] = useState(false);

  useEffect(() => {
    if (!HAS_TAURI || initialStatus.kind !== "Exists" || !vaultId) return;
    let cancelled = false;
    void memberVaultStatus(vaultId)
      .then((isMember) => {
        if (cancelled || isMember !== true) return;
        setMember(true);
        void memberUnlockStatus(vaultId)
          .then((m) => {
            if (cancelled) return;
            setMemberMode(m ?? "none");
          })
          // A failed probe leaves the answer UNKNOWN rather than claiming there is
          // no credential: the same collapse the desktop probe was fixed for, and
          // the failure mode is a user told to throw away a working device.
          .catch(() => {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [vaultId, initialStatus.kind]);

  const canMemberSubmit =
    memberMode === "pin"
      ? memberPin.length >= 6
      : memberMode === "biometric"
        ? true
        : memberMode === "password"
          ? memberPassword.length > 0
          : false;

  const handleMemberUnlock = useCallback(async () => {
    if (memberBusy || !vaultId || memberMode === null) return;
    setMemberError(false);
    setShowSuspicion(false);
    setMemberBusy(true);
    try {
      if (!HAS_TAURI) {
        await new Promise((r) => setTimeout(r, 350));
      } else if (memberMode === "password") {
        await personUnlockMemberVaultWithPassword(vaultId, memberPassword);
      } else if (memberMode === "pin") {
        await personUnlockMemberVaultWithPin(vaultId, memberPin);
      } else {
        await personUnlockMemberVaultWithBiometric(vaultId);
      }
      setMemberPasswordInput("");
      setMemberPinInput("");
      props.onUnlocked();
    } catch {
      setMemberError(true);
      setMemberBusy(false);
    }
  }, [
    memberBusy,
    memberMode,
    memberPassword,
    memberPin,
    vaultId,
    props,
  ]);

  useEffect(() => {
    if (!HAS_TAURI || initialStatus.kind !== "Exists") return;
    let cancelled = false;
    void quickUnlockStatus(vaultId)
      .then((s) => {
        if (cancelled) return;
        setQu(s);
        if (s.available) {
          if (s.method === "biometric") setBioMode(true);
          else setPinMode(true);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [vaultId, initialStatus.kind]);

  const wipePassword = useCallback(() => {
    pwRef.current = "";
    setPassword("");
    pinRef.current = "";
    setPin("");
  }, []);

  const setPw = useCallback((v: string) => {
    pwRef.current = v;
    setPassword(v);
  }, []);

  // Secret discipline: wipe the held password on unmount.
  useEffect(() => {
    return () => {
      pwRef.current = "";
    };
  }, []);

  const handleUnlock = useCallback(async () => {
    if (submitting || pwRef.current.length === 0) return;
    setShowSuspicion(false); // one-shot: cleared on first unlock attempt
    setErrorBanner(null);
    setSubmitting(true);
    try {
      if (HAS_TAURI) {
        await unlockWithPassword(pwRef.current, vaultId);
      } else {
        // Browser dev (no Tauri host): advance with a simulated success so the
        // flow is demoable under `pnpm dev`.
        await new Promise((r) => setTimeout(r, 350));
      }
      wipePassword();
      props.onUnlocked();
    } catch (e) {
      setErrorBanner(messageForUnlockError(e, t));
      setSubmitting(false);
    }
  }, [submitting, vaultId, wipePassword, props, t]);

  const handleBioUnlock = useCallback(async () => {
    if (bioSubmitting) return;
    setBioFailed(false);
    setErrorBanner(null);
    setBioSubmitting(true);
    try {
      if (HAS_TAURI) {
        await quickUnlockWithBiometric(vaultId);
      } else {
        await new Promise((r) => setTimeout(r, 350));
      }
      wipePassword();
      props.onUnlocked();
    } catch (e) {
      setBioSubmitting(false);
      if (isQuickUnlockError(e)) {
        // Cancelled never burns an attempt; WrongCredential (a keychain/blob
        // mismatch) does — both land on the retry surface (UN-02).
        if (e.kind === "Cancelled" || e.kind === "WrongCredential") {
          setBioFailed(true);
          return;
        }
        if (
          e.kind === "AttemptsExhausted" ||
          e.kind === "RequiresFullPassword" ||
          e.kind === "NotConfigured" ||
          e.kind === "HardwareUnavailable"
        ) {
          // Credential wiped / cold session / never set / no biometrics — drop
          // to the password form.
          setBioMode(false);
          setQu((s) => (s ? { ...s, available: false } : s));
          setErrorBanner(
            e.kind === "AttemptsExhausted"
              ? t("unlock.biometricTooManyAttempts", { biometric })
              : null,
          );
          return;
        }
      }
      setBioFailed(true);
    }
  }, [bioSubmitting, vaultId, wipePassword, props, biometric, t]);

  // Auto-prompt once per mount: entering the unlock screen with a redeemable
  // biometric credential fires the OS sheet immediately (the 1Password /
  // Bitwarden re-entry model). Cancel lands on the retry surface — the prompt
  // never re-fires on its own (no prompt loop).
  useEffect(() => {
    if (!bioMode || !qu?.available || bioAutoTried.current) return;
    bioAutoTried.current = true;
    void handleBioUnlock();
  }, [bioMode, qu, handleBioUnlock]);

  const handlePinUnlock = useCallback(async () => {
    if (pinSubmitting || pinRef.current.length < 6) return;
    setPinErr(null);
    setPinSubmitting(true);
    try {
      if (HAS_TAURI) {
        await quickUnlockWithPin(pinRef.current, vaultId);
      } else {
        await new Promise((r) => setTimeout(r, 350));
      }
      wipePassword();
      props.onUnlocked();
    } catch (e) {
      setPinSubmitting(false);
      pinRef.current = "";
      setPin("");
      if (isQuickUnlockError(e)) {
        if (e.kind === "WrongCredential") {
          const n = e.detail.remaining;
          setPinErr(t("unlock.pinIncorrect", { count: n }));
          return;
        }
        if (e.kind === "AttemptsExhausted" || e.kind === "RequiresFullPassword" || e.kind === "NotConfigured") {
          // Credential wiped / cold session / never set — drop to the password.
          setPinMode(false);
          setQu((s) => (s ? { ...s, available: false } : s));
          setErrorBanner(
            e.kind === "AttemptsExhausted"
              ? t("unlock.pinTooManyAttempts")
              : null,
          );
          return;
        }
      }
      setPinErr(t("unlock.pinFailedGeneric"));
    }
  }, [pinSubmitting, vaultId, wipePassword, props, t]);

  const handleStartRecovery = useCallback(() => {
    wipePassword();
    props.onStartRecovery();
  }, [wipePassword, props]);

  const handleBackToPicker = useCallback(() => {
    wipePassword();
    onBackToPicker?.();
  }, [wipePassword, onBackToPicker]);

  const handleDelete = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    setDeleteFailed(false);
    try {
      // Required target since myne-md/myne#476. The flow normally receives the
      // chosen vault's id from the stage; the single-vault entry that carries
      // none resolves the sole vault from disk. At ≥2 vaults with no id there
      // is no unambiguous answer, so refuse rather than erase a guess, the
      // same contract `src/screens/Unlock.tsx` has held since #250. The
      // parameter used to be optional and this call passed a possibly-undefined
      // prop straight through; the backend would have rejected it, but as a
      // deserialization error dressed as a delete failure.
      const target = vaultId ?? (await soleVaultId());
      if (target == null) {
        // Refuse, and refuse QUIETLY, which is the desktop shape
        // (`src/screens/Unlock.tsx` dispatches `delete-vault-bug-canary`: it
        // clears in-flight, shows no banner and leaves the form usable).
        //
        // The first version of this branch set `deleteFailed`, and that is the
        // TERMINAL partial-delete state: it makes the sheet undismissable,
        // unmounts Cancel, renders "Some files couldn't be removed. The vault is
        // no longer usable." and leaves one button that calls
        // `onDeleteVaultSuccess`. Nothing had been deleted. Telling a user their
        // vault is destroyed when it is intact, with no way back to the unlock
        // form, is a worse failure than the ambiguous target it was reporting.
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[UnlockFlow] vault_delete refused: ambiguous target");
        }
        setDeleting(false);
        setConfirmingDelete(false);
        return;
      }
      if (HAS_TAURI) {
        await deleteVault(target);
      } else {
        await new Promise((r) => setTimeout(r, 350));
      }
      wipePassword();
      props.onDeleteVaultSuccess();
    } catch {
      // PartialDelete / Io: the slot is already Empty and the editor cannot
      // resume — surface a banner and offer the terminal Continue exit.
      setDeleteFailed(true);
      setDeleting(false);
    }
  }, [deleting, vaultId, wipePassword, props]);

  // ── Fail-closed: corrupted vault.meta ──────────────────────────────────────
  if (initialStatus.kind === "Corrupted") {
    return (
      <FailClosed
        heading={t("unlock.corruptedHeading")}
        message={t("unlock.vaultUnreadable")}
        fromPicker={fromPicker}
        onBackToPicker={onBackToPicker ? handleBackToPicker : undefined}
        onRestore={props.onRestoreBackup}
      />
    );
  }

  // ── Fail-closed: list/read IO error ────────────────────────────────────────
  if (initialStatus.kind === "IoError") {
    return (
      <FailClosed
        heading={t("unlock.ioErrorHeading")}
        message={ioBanner(initialStatus.ioKind)}
        fromPicker={fromPicker}
        onBackToPicker={onBackToPicker ? handleBackToPicker : undefined}
      />
    );
  }

  // ── Exists: the password form ──────────────────────────────────────────────
  const suspicion = suspicionReason ? SUSPICION_COPY[suspicionReason] : null;

  return (
    <Screen style={{ alignItems: "center", padding: "0 32px" }}>
      {(submitting || pinSubmitting) && (
        <BlockingOverlay title={t("unlock.blockingTitle")} subtitle={t("unlock.blockingSubtitle")} />
      )}

      {fromPicker && onBackToPicker && <BackToPickerButton onClick={handleBackToPicker} />}

      <div style={{ paddingTop: 84 }}>
        <Wordmark />
      </div>

      <div style={{ marginTop: 36, textAlign: "center" }}>
        <Eyebrow>{t("unlock.eyebrow")}</Eyebrow>
        <VaultTitle>{t("unlock.vaultTitleFallback")}</VaultTitle>
      </div>

      {showSuspicion && suspicion && (
        <div data-testid="unlock-suspicion" style={{ width: "100%", marginTop: 22 }}>
          <Banner kind={suspicion.kind}>{t(suspicion.textKey)}</Banner>
        </div>
      )}

      {member ? (
        <>
          <div style={{ marginTop: showSuspicion && suspicion ? 18 : 30, width: "100%" }}>
            {memberMode === null || memberMode === "none" ? null : (
              <FieldLabel>
                {memberMode === "pin"
                  ? t("unlock.memberPinLabel")
                  : t("unlock.memberPasswordLabel")}
              </FieldLabel>
            )}
            {memberMode === null ? null : memberMode === "none" ? (
              // No credential on this device. The phrase does not open a shared
              // vault any more, so a form here would be a dead end and the copy
              // names the only remedy: a fresh invite from the owner.
              <div
                data-testid="unlock-member-no-credential"
                style={{ marginTop: "var(--space-2)", fontSize: "var(--text-base)", color: "var(--fg-2)" }}
              >
                {t("unlock.memberNoCredential")}
              </div>
            ) : memberMode === "biometric" ? (
              <div style={{ marginTop: "var(--space-2)", fontSize: "var(--text-base)", color: "var(--fg-2)" }}>
                {t("unlock.memberBiometricHint")}
              </div>
            ) : (
              <PasswordInput
                value={memberMode === "pin" ? memberPin : memberPassword}
                onChange={memberMode === "pin" ? setMemberPinInput : setMemberPasswordInput}
                onSubmit={handleMemberUnlock}
                error={memberError}
                numeric={memberMode === "pin"}
                ariaLabel={
                  memberMode === "pin" ? t("unlock.memberPinLabel") : t("unlock.memberPasswordLabel")
                }
                testId="unlock-member-input"
              />
            )}
            {memberError && (
              <div data-testid="unlock-member-error" style={{ marginTop: "var(--space-2)" }}>
                <Banner kind="danger">{t("unlock.memberPasswordError")}</Banner>
              </div>
            )}
          </div>
          {memberMode === null || memberMode === "none" ? null : (
            <Button
              style={{ marginTop: "var(--space-4)" }}
              disabled={memberBusy || !canMemberSubmit}
              onClick={() => void handleMemberUnlock()}
              data-testid="unlock-member-submit"
            >
              {memberMode === "biometric"
                ? t("unlock.memberBiometricSubmit")
                : t("unlock.memberSubmit")}
            </Button>
          )}
        </>
      ) : bioMode && qu?.available ? (
        <>
          <div
            style={{
              marginTop: showSuspicion && suspicion ? 24 : 44,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
            }}
            data-testid="unlock-biometric"
            data-state={bioFailed ? "failed" : "ready"}
          >
            <button
              onClick={() => void handleBioUnlock()}
              disabled={bioSubmitting}
              aria-label={t("unlock.unlockWithBiometric", { biometric })}
              data-testid="unlock-biometric-prompt"
              style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer" }}
            >
              <BiometricGlyph
                mode={isAndroid ? "fingerprint" : "face"}
                color={bioFailed ? "var(--line-3)" : "var(--accent)"}
                expression={bioFailed ? "sad" : "neutral"}
              />
            </button>
            <div style={{ marginTop: 22, fontSize: 17, fontWeight: 500, color: "var(--fg-1)", textAlign: "center" }}>
              {bioFailed
                ? t("unlock.biometricFailed", { biometric })
                : isAndroid
                  ? t("unlock.touchToUnlock")
                  : t("unlock.lookToUnlock")}
            </div>
            <div style={{ marginTop: 4, fontSize: 13, color: "var(--fg-3)", textAlign: "center", maxWidth: 260 }}>
              {bioFailed ? t("unlock.biometricRetryHint") : biometric}
            </div>
          </div>
          {bioFailed && (
            <Button
              style={{ marginTop: 24 }}
              disabled={bioSubmitting}
              onClick={() => void handleBioUnlock()}
              data-testid="unlock-biometric-retry"
            >
              {t("unlock.tryBiometricAgain", { biometric })}
            </Button>
          )}
          <TextButton
            height={40}
            style={{ marginTop: bioFailed ? 4 : 24 }}
            onClick={() => {
              setBioMode(false);
              setBioFailed(false);
            }}
            testId="unlock-use-password"
          >
            {t("unlock.usePasswordInstead")}
          </TextButton>
        </>
      ) : pinMode && qu?.available ? (
        <>
          <div style={{ marginTop: showSuspicion && suspicion ? 18 : 30, width: "100%" }}>
            <FieldLabel>{t("unlock.quickUnlock.pinPlaceholder")}</FieldLabel>
            <PasswordInput value={pin} onChange={setPinValue} onSubmit={handlePinUnlock} error={!!pinErr} numeric ariaLabel={t("unlock.quickUnlock.pinPlaceholder")} testId="unlock-pin" />
            {pinErr && (
              <div data-testid="unlock-pin-error" style={{ marginTop: 10 }}>
                <Banner kind="danger">{pinErr}</Banner>
              </div>
            )}
          </div>
          <Button
            style={{ marginTop: 16 }}
            disabled={pinSubmitting || pin.length < 6}
            onClick={() => void handlePinUnlock()}
            data-testid="unlock-pin-submit"
          >
            {t("unlock.quickUnlock.unlockWithPin")}
          </Button>
          <TextButton
            height={40}
            style={{ marginTop: 4 }}
            onClick={() => {
              setPinMode(false);
              setPinErr(null);
              pinRef.current = "";
              setPin("");
            }}
            testId="unlock-use-password"
          >
            {t("unlock.usePasswordInstead")}
          </TextButton>
        </>
      ) : (
        <>
          <div style={{ marginTop: showSuspicion && suspicion ? 18 : 30, width: "100%" }}>
            <FieldLabel>{t("unlock.passwordLabel")}</FieldLabel>
            <PasswordInput value={password} onChange={setPw} onSubmit={handleUnlock} error={!!errorBanner} />
            {errorBanner && (
              <div data-testid="unlock-error" style={{ marginTop: 10 }}>
                <Banner kind="danger">{errorBanner}</Banner>
              </div>
            )}
          </div>
          <Button
            style={{ marginTop: 16 }}
            disabled={submitting || password.length === 0}
            onClick={() => void handleUnlock()}
            data-testid="unlock-submit"
          >
            {t("unlock.submit")}
          </Button>
          {qu?.available &&
            (qu.method === "biometric" ? (
              <TextButton
                height={40}
                style={{ marginTop: 4 }}
                onClick={() => {
                  setBioMode(true);
                  setBioFailed(false);
                  setErrorBanner(null);
                }}
                testId="unlock-use-biometric"
              >
                {t("unlock.useBiometricInstead", { biometric })}
              </TextButton>
            ) : (
              <TextButton
                height={40}
                style={{ marginTop: 4 }}
                onClick={() => {
                  setPinMode(true);
                  setErrorBanner(null);
                }}
                testId="unlock-use-pin"
              >
                {t("unlock.unlockWithPinInstead")}
              </TextButton>
            ))}
        </>
      )}

      <div style={{ flex: 1 }} />

      <div style={{ paddingBottom: 18, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
        <TextButton height={40} onClick={handleStartRecovery} testId="unlock-recovery-link">
          {t("unlock.useRecoveryPhrase")}
        </TextButton>
        <TextButton
          height={40}
          fontSize={14}
          color="var(--danger)"
          onClick={() => {
            setDeleteFailed(false);
            setConfirmingDelete(true);
          }}
          testId="unlock-delete-link"
        >
          {member ? t("unlock.memberRemoveLink") : t("vaultRecover.phrase.deleteLink")}
        </TextButton>
      </div>

      {confirmingDelete && (
        <Sheet onClose={deleteFailed ? undefined : () => setConfirmingDelete(false)}>
          {/* What this action means, and it is not a styling switch (audit K2-i).
              A member vault is a SHARED vault: removing it from this device is
              reversible and it is not the member's to destroy. The owner copy
              below ("Delete this vault?" + the lost-both-secrets sentence) is
              false twice in the dangerous direction, so the member arm renders
              the member heading, its eyebrow, and the shared disclosure verbatim
              instead — the owner's sentences are absent, not corrected after the
              fact. `member` is resolved once per mount from the same
              `memberVaultStatus` probe the member unlock surface reads. */}
          {member ? (
            <>
              <div data-testid="unlock-member-remove-eyebrow" style={CONFIRM_EYEBROW_STYLE}>
                {t("settings.deleteVault.memberEyebrow")}
              </div>
              <div style={CONFIRM_HEADING_STYLE}>{t("settings.deleteVault.memberHeading")}</div>
              <p data-testid="unlock-member-removal-disclosure" style={CONFIRM_BODY_STYLE}>
                {MEMBER_VAULT_REMOVAL_DISCLOSURE}
              </p>
            </>
          ) : (
            <>
              <div style={CONFIRM_HEADING_STYLE}>{t("unlock.deleteConfirmTitle")}</div>
              <p style={CONFIRM_BODY_STYLE}>{LOST_BOTH_SECRETS_SENTENCE}</p>
            </>
          )}
          {/* myne-md/myne#761: iOS destroys the per-vault keychain item, Android
              keeps no such key, and the sentence names both halves, so it is
              rendered on both rather than gated into disagreement with the
              desktop twin. */}
          <p data-testid="unlock-delete-keychain-note" style={CONFIRM_NOTE_STYLE}>
            {t("settings.deleteVault.keychainNote")}
          </p>
          {deleteFailed && (
            <div data-testid="unlock-delete-error" style={{ marginTop: 14 }}>
              <Banner kind="danger">
                {t("unlock.deletePartialError")}
              </Banner>
            </div>
          )}
          <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 10 }}>
            {deleteFailed ? (
              <Button
                variant="danger"
                onClick={() => {
                  wipePassword();
                  props.onDeleteVaultSuccess();
                }}
                data-testid="unlock-delete-continue"
              >
                {t("common.continue")}
              </Button>
            ) : (
              <Button
                variant="danger"
                disabled={deleting}
                onClick={() => void handleDelete()}
                data-testid="unlock-delete-confirm"
              >
                {deleting
                  ? member
                    ? t("settings.deleteVault.memberSubmitInFlight")
                    : t("attachments.deleteDialog.deleting")
                  : member
                    ? t("settings.deleteVault.memberSubmit")
                    : t("settings.deleteVault.heading")}
              </Button>
            )}
            {!deleteFailed && (
              <Button variant="ghost" disabled={deleting} onClick={() => setConfirmingDelete(false)}>
                {t("common.prompt.cancel")}
              </Button>
            )}
          </div>
        </Sheet>
      )}
    </Screen>
  );
}

/** Fail-closed surface shared by the corrupted + IO-error initial states. No
 *  password form: the legitimate exits are a restore route (corrupted only —
 *  see `onRestore` below) and, when reached from the picker, choosing a
 *  different vault. */
function FailClosed({
  heading,
  message,
  fromPicker,
  onBackToPicker,
  onRestore,
}: {
  heading: string;
  message: string;
  fromPicker?: boolean;
  onBackToPicker?: () => void;
  /** When present, render the restore route. Only the corrupted case passes it:
   *  an IO error is a transient read failure, not a damaged vault. */
  onRestore?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Screen style={{ alignItems: "center", padding: "0 32px" }}>
      {fromPicker && onBackToPicker && <BackToPickerButton onClick={onBackToPicker} />}
      <div style={{ paddingTop: 84 }}>
        <Wordmark />
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", width: "100%" }}>
        <Eyebrow>{t("unlock.failClosedEyebrow")}</Eyebrow>
        <VaultTitle size={24}>{heading}</VaultTitle>
        <div data-testid="unlock-fail-closed" style={{ width: "100%", marginTop: 22 }}>
          <Banner kind="danger">{message}</Banner>
        </div>
        <p style={{ margin: "14px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-3)", textAlign: "center", maxWidth: 280 }}>
          {onRestore ? t("unlock.restoreHint") : t("unlock.ioErrorHint")}
        </p>
      </div>
      <div style={{ paddingBottom: 46, width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
        {onRestore && (
          <Button variant="secondary" data-testid="unlock-restore-backup" onClick={onRestore}>
            {t("unlock.restoreCta")}
          </Button>
        )}
        <Button onClick={() => void closeApp()}>{t("failClosed.corrupted.cta")}</Button>
      </div>
    </Screen>
  );
}
