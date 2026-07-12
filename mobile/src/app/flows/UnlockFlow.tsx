import { useCallback, useEffect, useRef, useState } from "react";
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
import {
  quickUnlockStatus,
  quickUnlockWithPin,
  quickUnlockWithBiometric,
  type QuickUnlockStatus,
} from "../../lib/quick-unlock";
import { isQuickUnlockError } from "../../types/quick-unlock-error";
import { usePlatform } from "../../platform/PlatformContext";
import { ioBanner } from "../../lib/io-banner";
import {
  UNLOCK_NON_DISTINGUISHING_BANNER,
  LOST_BOTH_SECRETS_SENTENCE,
} from "../../lib/load-bearing-copy";
import type { SuspicionReason } from "../../lib/stage";
import type { VaultUnlockError } from "../../types/vault-unlock-error";
import type { UnlockFlowProps } from "./types";

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
  return (
    <button
      onClick={onClick}
      aria-label="Choose a different vault"
      data-testid="unlock-back-to-picker"
      style={{
        position: "absolute",
        top: "max(52px, calc(env(safe-area-inset-top) + 8px))",
        left: 12,
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
      <Icon name="chevron-left" size={20} color="var(--accent)" strokeWidth={2} />
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
  ariaLabel = "Password",
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
        aria-label={ariaLabel}
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
        aria-label={revealed ? "Hide password" : "Show password"}
        style={{ border: "none", background: "transparent", padding: 0, marginLeft: 8, cursor: "pointer", display: "flex" }}
      >
        <Icon name={revealed ? "eye-off" : "eye"} size={20} color="var(--fg-3)" strokeWidth={1.6} />
      </button>
    </div>
  );
}

// ── Copy maps ─────────────────────────────────────────────────────────────────

/** Suspicion-banner copy is LITERAL per stage.ts SuspicionReason docs. */
const SUSPICION_COPY: Record<SuspicionReason, { text: string; kind: "danger" | "info" }> = {
  "vault-meta-changed-externally": {
    text: "Vault was modified in another session — please unlock again.",
    kind: "danger",
  },
  "vault-locked-during-change": {
    text: "Password change cancelled: vault was locked.",
    kind: "info",
  },
};

/** Map an unlock rejection to its banner string. The `InvalidCredentialOrVault`
 *  leg is the load-bearing non-distinguishing constant (rendered verbatim). */
function messageForUnlockError(e: unknown): string {
  const err = e as VaultUnlockError;
  switch (err?.kind) {
    case "InvalidCredentialOrVault":
      return UNLOCK_NON_DISTINGUISHING_BANNER;
    case "IoError":
      return ioBanner(err.detail.io_error_kind);
    case "InvalidVaultMeta":
      return "Vault file is unreadable. Restore from a backup.";
    default:
      return "Couldn't unlock. Please try again.";
  }
}

// ── Flow ──────────────────────────────────────────────────────────────────────

/**
 * UN-05 · Password unlock — wired. Mirrors src/screens/unlock/index.tsx's
 * PasswordUnlock. Renders the password form for an `Exists` vault, or a
 * fail-closed surface for `Corrupted` / `IoError`. The typed password is held
 * in component-local state + a ref and wiped on every exit path / unmount.
 */
export function UnlockFlow(props: UnlockFlowProps) {
  const { initialStatus, vaultId, suspicionReason, fromPicker, onBackToPicker } = props;
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
      setErrorBanner(messageForUnlockError(e));
      setSubmitting(false);
    }
  }, [submitting, vaultId, wipePassword, props]);

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
              ? `Too many ${biometric} attempts. Use your password.`
              : null,
          );
          return;
        }
      }
      setBioFailed(true);
    }
  }, [bioSubmitting, vaultId, wipePassword, props, biometric]);

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
          setPinErr(`Incorrect PIN. ${n} ${n === 1 ? "try" : "tries"} left.`);
          return;
        }
        if (e.kind === "AttemptsExhausted" || e.kind === "RequiresFullPassword" || e.kind === "NotConfigured") {
          // Credential wiped / cold session / never set — drop to the password.
          setPinMode(false);
          setQu((s) => (s ? { ...s, available: false } : s));
          setErrorBanner(
            e.kind === "AttemptsExhausted"
              ? "Too many PIN attempts. Use your password."
              : null,
          );
          return;
        }
      }
      setPinErr("Couldn't unlock with PIN. Use your password.");
    }
  }, [pinSubmitting, vaultId, wipePassword, props]);

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
      if (HAS_TAURI) {
        await deleteVault(vaultId);
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
        heading="Vault file is unreadable"
        message="Vault file is unreadable. Restore from a backup."
        fromPicker={fromPicker}
        onBackToPicker={onBackToPicker ? handleBackToPicker : undefined}
      />
    );
  }

  // ── Fail-closed: list/read IO error ────────────────────────────────────────
  if (initialStatus.kind === "IoError") {
    return (
      <FailClosed
        heading="Can't read this vault"
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
        <BlockingOverlay title="Unlocking" subtitle="Decrypting your keys on this device." />
      )}

      {fromPicker && onBackToPicker && <BackToPickerButton onClick={handleBackToPicker} />}

      <div style={{ paddingTop: 84 }}>
        <Wordmark />
      </div>

      <div style={{ marginTop: 36, textAlign: "center" }}>
        <Eyebrow>Unlock vault</Eyebrow>
        <VaultTitle>Your vault</VaultTitle>
      </div>

      {showSuspicion && suspicion && (
        <div data-testid="unlock-suspicion" style={{ width: "100%", marginTop: 22 }}>
          <Banner kind={suspicion.kind}>{suspicion.text}</Banner>
        </div>
      )}

      {bioMode && qu?.available ? (
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
              aria-label={`Unlock with ${biometric}`}
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
                ? `${biometric} couldn't confirm it's you`
                : isAndroid
                  ? "Touch to unlock"
                  : "Look to unlock"}
            </div>
            <div style={{ marginTop: 4, fontSize: 13, color: "var(--fg-3)", textAlign: "center", maxWidth: 260 }}>
              {bioFailed ? "Try again, or unlock with your password." : biometric}
            </div>
          </div>
          {bioFailed && (
            <Button
              style={{ marginTop: 24 }}
              disabled={bioSubmitting}
              onClick={() => void handleBioUnlock()}
              data-testid="unlock-biometric-retry"
            >
              Try {biometric} again
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
            Use password instead
          </TextButton>
        </>
      ) : pinMode && qu?.available ? (
        <>
          <div style={{ marginTop: showSuspicion && suspicion ? 18 : 30, width: "100%" }}>
            <FieldLabel>PIN</FieldLabel>
            <PasswordInput value={pin} onChange={setPinValue} onSubmit={handlePinUnlock} error={!!pinErr} numeric ariaLabel="PIN" testId="unlock-pin" />
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
            Unlock with PIN
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
            Use password instead
          </TextButton>
        </>
      ) : (
        <>
          <div style={{ marginTop: showSuspicion && suspicion ? 18 : 30, width: "100%" }}>
            <FieldLabel>Password</FieldLabel>
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
            Unlock
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
                Use {biometric} instead
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
                Unlock with PIN instead
              </TextButton>
            ))}
        </>
      )}

      <div style={{ flex: 1 }} />

      <div style={{ paddingBottom: 18, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
        <TextButton height={40} onClick={handleStartRecovery} testId="unlock-recovery-link">
          Use your recovery phrase
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
          Delete vault and start over
        </TextButton>
      </div>

      {confirmingDelete && (
        <Sheet onClose={deleteFailed ? undefined : () => setConfirmingDelete(false)}>
          <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-0.01em", color: "var(--fg-display)" }}>
            Delete this vault?
          </div>
          <p style={{ margin: "10px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-2)" }}>
            {LOST_BOTH_SECRETS_SENTENCE}
          </p>
          {deleteFailed && (
            <div data-testid="unlock-delete-error" style={{ marginTop: 14 }}>
              <Banner kind="danger">
                Some files couldn't be removed. The vault is no longer usable — continue to start over.
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
                Continue
              </Button>
            ) : (
              <Button
                variant="danger"
                disabled={deleting}
                onClick={() => void handleDelete()}
                data-testid="unlock-delete-confirm"
              >
                {deleting ? "Deleting…" : "Delete vault"}
              </Button>
            )}
            {!deleteFailed && (
              <Button variant="ghost" disabled={deleting} onClick={() => setConfirmingDelete(false)}>
                Cancel
              </Button>
            )}
          </div>
        </Sheet>
      )}
    </Screen>
  );
}

/** Fail-closed surface shared by the corrupted + IO-error initial states. No
 *  password form: the only legitimate exits are restore-from-backup
 *  (out-of-band, via Close app) or — when reached from the picker — choosing a
 *  different vault. */
function FailClosed({
  heading,
  message,
  fromPicker,
  onBackToPicker,
}: {
  heading: string;
  message: string;
  fromPicker?: boolean;
  onBackToPicker?: () => void;
}) {
  return (
    <Screen style={{ alignItems: "center", padding: "0 32px" }}>
      {fromPicker && onBackToPicker && <BackToPickerButton onClick={onBackToPicker} />}
      <div style={{ paddingTop: 84 }}>
        <Wordmark />
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", width: "100%" }}>
        <Eyebrow>Can't open vault</Eyebrow>
        <VaultTitle size={24}>{heading}</VaultTitle>
        <div data-testid="unlock-fail-closed" style={{ width: "100%", marginTop: 22 }}>
          <Banner kind="danger">{message}</Banner>
        </div>
        <p style={{ margin: "14px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-3)", textAlign: "center", maxWidth: 280 }}>
          Restore from a backup to continue.
        </p>
      </div>
      <div style={{ paddingBottom: 46, width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
        <Button onClick={() => void closeApp()}>Close app</Button>
      </div>
    </Screen>
  );
}
