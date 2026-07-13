// Settings → Privacy → Quick unlock (MYND-329).
//
// Opt-in (default OFF) PIN / Touch ID fast re-entry over the auto-lock
// envelope. Quick-unlock is a CONVENIENCE gate (A6) layered over the
// already-encrypted store — it never weakens the zero-knowledge root; the
// master password stays the primary credential. This panel section configures
// it for the active (unlocked) vault.
//
// ⚠️ The Touch ID path is HARDWARE-UNVERIFIED pending a Touch ID device test +
// a primitive review (see `core/.../quick_unlock/apple.rs`). Its helper
// copy says so; do not present it as a trusted gate until verified.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import {
  quickUnlockDisable,
  quickUnlockSetupBiometric,
  quickUnlockSetupPin,
  quickUnlockStatus,
  type QuickUnlockStatus,
} from "../../lib/quick-unlock";
import { isQuickUnlockError } from "../../types/quick-unlock-error";
import { Button } from "../primitives/Button";
import { Input } from "../primitives/Input";
import { Switch } from "../primitives/Switch";
import { BLOCK_STYLE, HELPER_STYLE, LABEL_STYLE } from "./panel-styles";

/** Minimum PIN length — mirrors the Rust `pin::MIN_PIN_LEN`. */
const MIN_PIN_LEN = 6;

const ROW_STYLE = {
  display: "flex",
  flexDirection: "row" as const,
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
};

const SETUP_STYLE = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "var(--space-2)",
  marginTop: "var(--space-2)",
};

const ACTIONS_STYLE = {
  display: "flex",
  flexDirection: "row" as const,
  gap: "var(--space-2)",
};

/** Map a rejected IPC error to one line of user-facing copy. Resolves the
 *  message at call time (runtime) so a language switch is reflected, rather
 *  than freezing a module-scope map at the boot language. */
function errorMessage(e: unknown): string {
  if (isQuickUnlockError(e)) {
    switch (e.kind) {
      case "PinTooShort":
        return i18n.t("settings.quickUnlock.errorPinTooShort", {
          count: MIN_PIN_LEN,
        });
      case "PinNotDigits":
        return i18n.t("settings.quickUnlock.errorPinNotDigits");
      case "HardwareUnavailable":
        return i18n.t("settings.quickUnlock.errorHardwareUnavailable");
      case "Cancelled":
        return i18n.t("settings.quickUnlock.errorCancelled");
      case "NotUnlocked":
        return i18n.t("settings.quickUnlock.errorNotUnlocked");
      default:
        return i18n.t("settings.quickUnlock.errorGeneric");
    }
  }
  return i18n.t("settings.quickUnlock.errorGeneric");
}

export function QuickUnlockSettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<QuickUnlockStatus | null>(null);
  const [showPinSetup, setShowPinSetup] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch current status on mount. In a non-Tauri context (dev/tests) invoke
  // rejects — treat that as "not configured / unavailable", never throw.
  useEffect(() => {
    let alive = true;
    quickUnlockStatus()
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {
        if (alive) setStatus({ configured: false, method: null, available: false });
      });
    return () => {
      alive = false;
    };
  }, []);

  const configured = status?.configured ?? false;

  async function refresh() {
    try {
      setStatus(await quickUnlockStatus());
    } catch {
      setStatus({ configured: false, method: null, available: false });
    }
  }

  async function onSetupPin() {
    setBusy(true);
    setError(null);
    try {
      await quickUnlockSetupPin(pin);
      setPin("");
      setShowPinSetup(false);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function onSetupBiometric() {
    setBusy(true);
    setError(null);
    try {
      await quickUnlockSetupBiometric();
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDisable() {
    setBusy(true);
    setError(null);
    try {
      await quickUnlockDisable();
      setShowPinSetup(false);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const pinValid = /^\d+$/.test(pin) && pin.length >= MIN_PIN_LEN;

  return (
    <div style={BLOCK_STYLE} data-testid="settings.quick-unlock">
      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>{t("settings.quickUnlock.title")}</span>
        <Switch
          checked={configured || showPinSetup}
          onChange={(next) => {
            setError(null);
            if (next) {
              setShowPinSetup(true);
            } else {
              setShowPinSetup(false);
              if (configured) void onDisable();
            }
          }}
          ariaLabel={t("settings.quickUnlock.title")}
          ariaDescribedBy="quick-unlock-helper"
          testId="settings.quick-unlock-toggle"
        />
      </div>
      <p id="quick-unlock-helper" style={HELPER_STYLE} data-testid="settings.quick-unlock-status">
        {configured
          ? t("settings.quickUnlock.helperConfigured", {
              method:
                status?.method === "biometric"
                  ? t("settings.quickUnlock.methodTouchId")
                  : t("settings.quickUnlock.methodPin"),
            })
          : t("settings.quickUnlock.helperNotConfigured")}
      </p>

      {!configured && showPinSetup && (
        <div style={SETUP_STYLE}>
          <Input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder={t("settings.quickUnlock.pinPlaceholder", {
              count: MIN_PIN_LEN,
            })}
            aria-label={t("settings.quickUnlock.pinAriaLabel")}
            data-testid="settings.quick-unlock-pin-input"
          />
          <div style={ACTIONS_STYLE}>
            <Button
              variant="primary"
              disabled={busy || !pinValid}
              onClick={() => void onSetupPin()}
              data-testid="settings.quick-unlock-setup-pin"
            >
              {t("settings.quickUnlock.setPin")}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void onSetupBiometric()}
              data-testid="settings.quick-unlock-setup-biometric"
            >
              {t("settings.quickUnlock.useTouchId")}
            </Button>
          </div>
          <p style={HELPER_STYLE}>
            {t("settings.quickUnlock.setupHelper")}
          </p>
        </div>
      )}

      {error && (
        <p style={{ ...HELPER_STYLE, color: "var(--danger, #c0392b)" }} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
