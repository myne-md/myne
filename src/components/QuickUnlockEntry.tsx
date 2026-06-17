// Quick-unlock affordance on the Unlock screen (MYND-329).
//
// Rendered ABOVE the password form when quick-unlock is configured for the
// vault. A PIN field or a Touch ID button lets the user re-enter after an
// auto-lock without the full master password. The password form below is
// always present as the escape hatch — this component never replaces it, so
// the (security-critical) password path is untouched.
//
// Spring-loaded gate: on a fresh process (app restart) the backend returns
// `RequiresFullPassword` until one full-password unlock has happened this
// session. This component self-hides on that (and on `AttemptsExhausted` /
// `NotConfigured`) so the user simply uses the password form below.
//
// ⚠️ Touch ID is HARDWARE-UNVERIFIED (see `quick_unlock/macos.rs`).

import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import {
  quickUnlockStatus,
  quickUnlockWithBiometric,
  quickUnlockWithPin,
} from "../lib/quick-unlock";
import { isQuickUnlockError } from "../types/quick-unlock-error";

interface QuickUnlockEntryProps {
  /** Called on a successful quick-unlock — same effect as a password unlock. */
  onUnlocked: () => void;
}

type Method = "pin" | "biometric";

const WRAP_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  marginTop: "var(--space-2)",
  paddingBottom: "var(--space-3)",
  borderBottom: "1px solid var(--line-1)",
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

const BTN_STYLE: CSSProperties = {
  background: "var(--accent)",
  color: "var(--accent-on)",
  border: "none",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-3) var(--space-5)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-base)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  cursor: "pointer",
};

const HINT_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  textAlign: "center",
};

export function QuickUnlockEntry({ onUnlocked }: QuickUnlockEntryProps) {
  const [method, setMethod] = useState<Method | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let alive = true;
    quickUnlockStatus()
      .then((s) => {
        if (!alive) return;
        if (s.configured && (s.method === "pin" || s.method === "biometric")) {
          setMethod(s.method);
        } else {
          setHidden(true);
        }
      })
      .catch(() => {
        if (alive) setHidden(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  function handleError(e: unknown) {
    if (isQuickUnlockError(e)) {
      switch (e.kind) {
        // After a restart / a wipe, quick-unlock is unavailable — fold away and
        // let the user type their password below.
        case "RequiresFullPassword":
        case "AttemptsExhausted":
        case "NotConfigured":
          setHidden(true);
          return;
        case "WrongCredential":
          setNote(`Incorrect. ${e.detail.remaining} attempt(s) left.`);
          return;
        case "Cancelled":
          setNote(null);
          return;
        default:
          setNote("Quick unlock failed. Use your password.");
          return;
      }
    }
    setNote("Quick unlock failed. Use your password.");
  }

  async function attemptPin(ev: FormEvent) {
    ev.preventDefault();
    if (busy || pin.length === 0) return;
    setBusy(true);
    setNote(null);
    try {
      await quickUnlockWithPin(pin);
      onUnlocked();
    } catch (e) {
      setPin("");
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  async function attemptBiometric() {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      await quickUnlockWithBiometric();
      onUnlocked();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  if (hidden || method === null) return null;

  return (
    <div style={WRAP_STYLE} data-testid="unlock.quick-unlock" data-method={method}>
      {method === "biometric" ? (
        <button
          type="button"
          onClick={() => void attemptBiometric()}
          disabled={busy}
          style={BTN_STYLE}
          data-testid="unlock.quick-touchid"
        >
          Unlock with Touch ID
        </button>
      ) : (
        <form
          onSubmit={attemptPin}
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
        >
          <input
            type="password"
            inputMode="numeric"
            placeholder="PIN"
            value={pin}
            onChange={(e) => setPin(e.currentTarget.value)}
            disabled={busy}
            autoComplete="off"
            aria-label="Quick-unlock PIN"
            style={INPUT_STYLE}
            data-testid="unlock.quick-pin-input"
          />
          <button
            type="submit"
            disabled={busy || pin.length === 0}
            style={BTN_STYLE}
            data-testid="unlock.quick-pin-submit"
          >
            Unlock with PIN
          </button>
        </form>
      )}
      {note != null && (
        <p style={HINT_STYLE} role="alert" data-testid="unlock.quick-note">
          {note}
        </p>
      )}
      <p style={HINT_STYLE}>or use your password below</p>
    </div>
  );
}
